// ---------------------------------------------------------------------------
// VOICE POOL — docs/AUDIO_PLAN.md §5.3.
//
// A bounded set of pooled {GainNode, PannerNode} chains. A fresh
// AudioBufferSourceNode is created per play because they are single-use; the
// rest is reused, MEASURED at 8.1 µs pooled versus 24.6 µs unpooled.
// ---------------------------------------------------------------------------

import {
  getAudioEvent,
  tryGetAudioEvent,
  type AudioEventDef,
  type AudioEventId,
} from "@/data/audioEvents";
import {
  dbToGain,
  ensureEngine,
  isAudioUnlocked,
  queueUntilUnlocked,
  setParamSmooth,
  setPendingFlushHandler,
  type AudioEngine,
} from "./engine";
import { getCachedBuffer, loadAudioFile } from "./loader";
import {
  applyPannerPosition,
  configurePanner,
  gainForDistance,
  distanceToListener,
  type Vec3,
} from "./spatial";

/**
 * Real-voice cap.
 *
 * ⚠ 24 IS THE LOW END OF EVERY ESTIMATE AND IT IS A GUESS UNTIL MEASURED.
 * Raising it requires `__audio.stress(n)` evidence under a genuinely GPU-busy
 * scenario — the discipline docs/PERF_MEASUREMENT.md imposes on GPU passes
 * applies here too. Do not raise it by feel.
 *
 * At the game's actual target density (a station, a few drones, a handful of
 * ships — call it 10–30 emitters) overflow should be rare, which is why the
 * virtual-voice tier is deliberately NOT built. See §5.3a.
 */
export const MAX_VOICES = 24;

type Voice = {
  /** Monotonic, for `__audio.voices()` and for age-based stealing. */
  serial: number;
  gain: GainNode;
  /**
   * Atmospheric absorption (§12.3). One biquad per voice, corner set on the
   * 15 Hz tick — NOT per sample. Bypassed (corner at 20 kHz) for everything
   * except air-coupled world emitters.
   */
  lowpass: BiquadFilterNode;
  panner: PannerNode;
  source: AudioBufferSourceNode | null;
  eventId: string;
  priority: number;
  startedAt: number;
  startsAtS: number;
  attackEndsAtS: number;
  endsAtS: number | null;
  loop: boolean;
  spatial: boolean;
  /** `true` only for world-tier events declared `coupling: "air"`. */
  airCoupled: boolean;
  position: Vec3;
  /** Set when the voice belongs to a registered emitter (A11). */
  emitterId: number | null;
  active: boolean;
};

const pool: Voice[] = [];
let serialCounter = 0;

/** Last-played timestamps, for `cooldownMs`. */
const lastPlayedAt = new Map<string, number>();
/** Recently used variant indices per event, for the "avoid last 2" rule. */
const recentVariants = new Map<string, number[]>();

function buildPool(e: AudioEngine): void {
  if (pool.length) return;
  for (let i = 0; i < MAX_VOICES; i++) {
    const gain = e.ctx.createGain();
    const lowpass = e.ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = 20000; // open = no absorption
    lowpass.Q.value = 0.0001; // gentlest possible slope; this models absorption, not a filter sweep
    const panner = e.ctx.createPanner();
    configurePanner(panner);
    gain.connect(lowpass);
    lowpass.connect(panner);
    pool.push({
      serial: 0,
      gain,
      lowpass,
      panner,
      source: null,
      eventId: "",
      priority: 0,
      startedAt: 0,
      startsAtS: 0,
      attackEndsAtS: 0,
      endsAtS: null,
      loop: false,
      spatial: false,
      airCoupled: false,
      position: { x: 0, y: 0, z: 0 },
      emitterId: null,
      active: false,
    });
  }
}

/**
 * Wire a pooled voice for this event's tier (A2).
 *
 * ⚠⚠ REBUILDS THE WHOLE CHAIN EVERY TIME, and it must. Voices are pooled and
 * reused across tiers, and the two tiers use DIFFERENT topologies:
 *
 *   world       gain → lowpass → panner → bus
 *   ship / ui   gain → bus
 *
 * A first attempt only re-pointed the panner and disconnected `gain` in the
 * ship branch. That silently broke the next world-tier sound to reuse the voice:
 * `gain` was still wired straight to the bus while nothing fed the panner, so the
 * sound played UNPANNED AND UNFILTERED and was double-summed into the bus. It
 * would have shown up as "spatial audio works, except sometimes", depending
 * purely on voice-reuse order — so disconnect all three nodes and rebuild.
 */
function connectVoice(e: AudioEngine, v: Voice, def: AudioEventDef): void {
  for (const node of [v.gain, v.lowpass, v.panner]) {
    try {
      node.disconnect();
    } catch {
      /* not connected yet */
    }
  }
  const bus = e.buses[def.bus];
  if (def.tier === "world") {
    v.spatial = true;
    v.gain.connect(v.lowpass);
    v.lowpass.connect(v.panner);
    v.panner.connect(bus);
  } else {
    // ⚠ Ship- and UI-tier sounds bypass panning AND the absorption filter. This
    // looks like a bug and is not: in chase mode the engine must NOT get quieter
    // as the camera pulls back (A2), and ship sounds are structure-borne, so the
    // surrounding gas is irrelevant to them.
    v.spatial = false;
    v.gain.connect(bus);
  }
}

function pickVariant(def: AudioEventDef): string {
  const n = def.variants.length;
  if (n === 1) return def.variants[0];
  const recent = recentVariants.get(def.id) ?? [];
  // "Avoid last 2" (§6.4) — without it a 3-variant pool still audibly repeats.
  const allowed: number[] = [];
  for (let i = 0; i < n; i++) if (!recent.includes(i)) allowed.push(i);
  const from = allowed.length ? allowed : Array.from({ length: n }, (_, i) => i);
  const idx = from[Math.floor(Math.random() * from.length)];
  recent.push(idx);
  while (recent.length > Math.min(2, n - 1)) recent.shift();
  recentVariants.set(def.id, recent);
  return def.variants[idx];
}

function countInstances(eventId: string): number {
  let n = 0;
  for (const v of pool) if (v.active && v.eventId === eventId) n++;
  return n;
}

/**
 * Find a voice to use, stealing if necessary.
 *
 * Order (§5.3): lowest priority → farthest → oldest. Returns null when every
 * voice outranks the incoming sound, in which case the new sound is simply
 * dropped — correct behaviour, and audibly better than evicting an alarm.
 */
function acquireVoice(priority: number): Voice | null {
  for (const v of pool) if (!v.active) return v;

  let worst: Voice | null = null;
  let worstKey = Infinity;
  for (const v of pool) {
    // A loop owned by an emitter is not stealable here: the emitter layer owns
    // its lifecycle and would not know its voice had vanished.
    if (v.emitterId !== null) continue;
    const dist = v.spatial ? distanceToListener(v.position) : 0;
    // Composite sort key: priority dominates, then distance, then age.
    const key = v.priority * 1e9 - dist * 1e3 + v.startedAt * 1e-3;
    if (key < worstKey) {
      worstKey = key;
      worst = v;
    }
  }
  if (!worst) return null;
  if (worst.priority > priority) return null;
  stopVoice(worst);
  return worst;
}

function stopVoice(v: Voice): void {
  if (v.source) {
    try {
      v.source.onended = null;
      v.source.stop();
    } catch {
      /* already stopped */
    }
    try {
      v.source.disconnect();
    } catch {
      /* already disconnected */
    }
  }
  v.source = null;
  v.active = false;
  v.emitterId = null;
  v.eventId = "";
}

export type PlayOptions = {
  /** Optional handoff envelope, also available to one-shots. */
  fadeInMs?: number;
  pitchCents?: number;
  /** Absolute audio-clock time for a sequenced source. */
  startAtS?: number;
  /** Cancellable startup cues must not survive their owner in the unlock queue. */
  queueOnUnlock?: boolean;
  /** World position in local metres. Required for `world`-tier events. */
  positionM?: Vec3;
  /** Extra dB on top of the event's own `gainDb`. */
  gainDb?: number;
  /** Internal: set by the emitter layer so the voice is not stolen. */
  emitterId?: number;
  /** Internal: fully evaluated emitter gain, including distance and medium. */
  initialGain?: number;
  /** Internal: apply propagation before the first sample, not one tick later. */
  initialCutoffHz?: number;
  /**
   * Start offset into the buffer, seconds.
   *
   * ⚠⚠ THE COHERENCE FIX. N instances of the SAME buffer started at the SAME
   * time are identical and in phase, so they sum COHERENTLY like voltage:
   * N = 3 is +9.5 dB, not the +4.8 dB that incoherent summation (10·log10 N)
   * would give. Randomising the offset decorrelates them. The emitter layer
   * passes a random offset for every looping instance for exactly this reason.
   */
  offsetS?: number;
  /**
   * HARNESS ONLY — bypass `cooldownMs` and `maxInstances`.
   *
   * ⚠⚠ EXISTS BECAUSE GATE EA-2 WAS UNMEASURABLE WITHOUT IT. `__audio.stress(96)`
   * played exactly ONE voice: `world.impact` carries maxInstances 3 and a 40 ms
   * cooldown, so a synchronous burst is refused by its own per-event guards long
   * before the pool is touched. The harness was therefore measuring the T3 guard,
   * not the voice budget it claims to measure — a degenerate benchmark.
   *
   * Never set this from gameplay. The guards it skips are the ones that stop one
   * noisy event starving the mix.
   */
  ignoreLimits?: boolean;
};

/**
 * Start one voice. Returns its serial, or null if nothing played.
 *
 * ⚠ CALL THIS FROM THE EVENT THAT CAUSED THE SOUND, not from a useEffect
 * reacting to an atom (T4). MEASURED baseLatency is 5.80 ms and the perceptual
 * budget is ~20 ms; a React render hop can spend it.
 */
export function playAudio(
  id: AudioEventId | string,
  opts: PlayOptions = {},
): number | null {
  const def = tryGetAudioEvent(id);
  if (!def) {
    console.warn(`[audio] unknown event id "${id}"`);
    return null;
  }

  if (!isAudioUnlocked()) {
    // Queued and flushed on unlock, with a TTL so a stale click doesn't fire
    // ten seconds later (T8, engine.ts).
    if (!def.loop && opts.emitterId === undefined && opts.queueOnUnlock !== false) queueUntilUnlocked(id);
    return null;
  }

  const e = ensureEngine();
  if (!e) return null;
  buildPool(e);

  const now = performance.now();

  if (!opts.ignoreLimits) {
    if (def.cooldownMs > 0) {
      const last = lastPlayedAt.get(def.id) ?? -Infinity;
      if (now - last < def.cooldownMs) return null;
    }
    // Per-event cap, independent of the global budget: without it one noisy event
    // starves everything else (T3 — a single asteroid hit can fire 3× in a tick).
    if (countInstances(def.id) >= def.maxInstances) return null;
  }

  const url = pickVariant(def);
  const buffer = getCachedBuffer(url);
  if (!buffer) {
    // Not yet decoded. Kick the load so the NEXT trigger is instant, and drop
    // this one rather than playing late — a late sound reads worse than none.
    void loadAudioFile(url);
    return null;
  }

  const v = acquireVoice(def.priority);
  if (!v) return null;

  const spatial = def.tier === "world";
  const pos = opts.positionM ?? { x: 0, y: 0, z: 0 };

  let gain = dbToGain((def.gainDb ?? 0) + (opts.gainDb ?? 0));
  if (def.gainJitterDb) {
    gain *= dbToGain((Math.random() * 2 - 1) * def.gainJitterDb);
  }
  if (spatial) gain *= gainForDistance(distanceToListener(pos));
  if (opts.initialGain !== undefined) gain = opts.initialGain;

  const src = e.ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = def.loop ?? false;
  if (def.pitchJitterCents) {
    src.detune.value = (Math.random() * 2 - 1) * def.pitchJitterCents;
  }
  if (opts.pitchCents !== undefined) src.detune.value += opts.pitchCents;

  v.serial = ++serialCounter;
  v.source = src;
  v.eventId = def.id;
  v.priority = def.priority;
  v.startedAt = now;
  v.loop = def.loop ?? false;
  v.spatial = spatial;
  // Default `contact`: opting IN to attenuation is the safe default, because the
  // failure mode of the opposite is a silent core loop (see `coupling` in
  // audioEvents.ts).
  v.airCoupled = spatial && def.coupling === "air";
  v.position = { ...pos };
  v.emitterId = opts.emitterId ?? null;
  v.active = true;

  const startTime = Math.max(e.ctx.currentTime + (def.loop ? 0.012 : 0), opts.startAtS ?? 0);
  v.startsAtS = startTime;
  const attackS = Math.max(0, opts.fadeInMs ?? (def.loop ? 25 : 0)) / 1000;
  v.attackEndsAtS = startTime + attackS;
  v.endsAtS = def.loop ? null : startTime + buffer.duration / 2 ** (src.detune.value / 1200);
  v.gain.gain.cancelScheduledValues(e.ctx.currentTime);
  v.gain.gain.setValueAtTime(attackS > 0 ? 0 : gain, e.ctx.currentTime);
  if (attackS > 0) {
    v.gain.gain.setValueAtTime(0, startTime);
    v.gain.gain.linearRampToValueAtTime(gain, v.attackEndsAtS);
  }
  // Reset the absorption filter: a voice previously used for a distant, heavily
  // muffled sound would otherwise stay muffled for a near one.
  v.lowpass.frequency.cancelScheduledValues(e.ctx.currentTime);
  v.lowpass.frequency.value = opts.initialCutoffHz ?? 20000;
  connectVoice(e, v, def);
  if (spatial) applyPannerPosition(v.panner, pos);
  src.connect(v.gain);

  const mySerial = v.serial;
  src.onended = () => {
    // Guard against a stale callback from a voice that has been recycled.
    if (v.serial === mySerial) stopVoice(v);
  };

  // Engine layers share a period and phase even if one is promoted later.
  const offset = def.syncLoop ? startTime : opts.offsetS ?? 0;
  src.start(startTime, offset > 0 ? offset % buffer.duration : 0);

  lastPlayedAt.set(def.id, now);
  return mySerial;
}

// Let engine.ts drain its pre-unlock queue without importing this module.
setPendingFlushHandler((id) => playAudio(id));

/** Stop a voice by serial. Used by the emitter layer and by mispredicted net sounds. */
export function stopVoiceBySerial(serial: number, fadeMs = 40): void {
  const v = pool.find((x) => x.active && x.serial === serial);
  if (!v) return;
  if (fadeMs <= 0) {
    stopVoice(v);
    return;
  }
  // Release-envelope out rather than hard-stopping, so a cancelled loop (or a
  // mispredicted networked sound, A13) does not click.
  setParamSmooth(v.gain.gain, 0, fadeMs / 3000);
  const target = v.serial;
  window.setTimeout(() => {
    if (v.serial === target) stopVoice(v);
  }, fadeMs);
}

/** Update a live voice's position and re-derive its distance gain. */
export function updateVoicePosition(serial: number, p: Vec3): void {
  const v = pool.find((x) => x.active && x.serial === serial);
  if (!v || !v.spatial) return;
  v.position.x = p.x;
  v.position.y = p.y;
  v.position.z = p.z;
  applyPannerPosition(v.panner, v.position);
}

/**
 * Apply atmospheric propagation to a live voice. Called from the audio tick for
 * air-coupled world voices only.
 */
export function setVoicePropagation(
  serial: number,
  cutoffHz: number,
): void {
  const v = pool.find((x) => x.active && x.serial === serial);
  if (!v || !v.airCoupled) return;
  // Smoothed: a jumping corner frequency is audible as a zip.
  setParamSmooth(v.lowpass.frequency, cutoffHz, 0.08);
}

/** Whether a live voice is subject to atmospheric propagation. */
export function isVoiceAirCoupled(serial: number): boolean {
  const v = pool.find((x) => x.active && x.serial === serial);
  return !!v && v.airCoupled;
}

export function setVoiceGain(serial: number, gain: number): void {
  const v = pool.find((x) => x.active && x.serial === serial);
  if (!v) return;
  // A future sustain's zero/attack envelope must survive the intervening ticks.
  if ((ensureEngine()?.ctx.currentTime ?? 0) < v.attackEndsAtS) return;
  setParamSmooth(v.gain.gain, gain, 0.05);
}

/** Continuous loop pitch, smoothed on the audio tick; never retimes one-shots. */
export function setVoicePitch(serial: number, cents: number): void {
  const v = pool.find((x) => x.active && x.serial === serial);
  if (v?.loop && v.source) setParamSmooth(v.source.detune, cents, 0.08);
}

/** Decoded, pitch-adjusted end time for sequencing a sustain after a one-shot. */
export function voiceEndTime(serial: number): number | null {
  return pool.find((v) => v.active && v.serial === serial)?.endsAtS ?? null;
}

export function activeVoiceCount(): number {
  let n = 0;
  for (const v of pool) if (v.active) n++;
  return n;
}

export function isVoiceActive(serial: number): boolean {
  return pool.some((v) => v.active && v.serial === serial);
}

export type VoiceSnapshot = {
  serial: number;
  eventId: string;
  priority: number;
  loop: boolean;
  spatial: boolean;
  distanceM: number | null;
  gain: number;
  airCoupled: boolean;
  cutoffHz: number | null;
  ageMs: number;
  emitterId: number | null;
};

export function voiceSnapshots(): VoiceSnapshot[] {
  const now = performance.now();
  return pool
    .filter((v) => v.active)
    .map((v) => ({
      serial: v.serial,
      eventId: v.eventId,
      priority: v.priority,
      loop: v.loop,
      spatial: v.spatial,
      distanceM: v.spatial
        ? Math.round(distanceToListener(v.position) * 10) / 10
        : null,
      gain: Math.round(v.gain.gain.value * 1000) / 1000,
      airCoupled: v.airCoupled,
      cutoffHz: v.airCoupled ? Math.round(v.lowpass.frequency.value) : null,
      ageMs: Math.round(now - v.startedAt),
      emitterId: v.emitterId,
    }))
    .sort((a, b) => b.priority - a.priority);
}

/** Dev/bench only: silence everything immediately. */
export function stopAllVoices(): void {
  for (const v of pool) if (v.active) stopVoice(v);
}

/** Exposed for the contract tests and `__audio.state()`. */
export function poolSize(): number {
  return pool.length;
}

export { getAudioEvent };
