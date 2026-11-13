// ---------------------------------------------------------------------------
// AUDIO ENGINE — the A1 singleton. See docs/AUDIO_PLAN.md §4 / §5.2.
//
// Owns the AudioContext, the bus graph, the master limiter, and the unlock
// handshake. Nothing else may create an AudioContext.
//
// ⚠⚠ MODULE-SCOPE SINGLETON, NEVER TORN DOWN (invariant A1). Three verified
// reasons, all specific to this repo:
//
//  1. `frameloop="never"` (Scene.tsx:228) hard-stops every useFrame the moment
//     the settings menu opens. An engine owned by the render tree would stutter
//     or restart when the player opens settings.
//  2. React dev double-invocation is live here — two dev pages already carry
//     `startedRef` guards with "guard double-invoke in dev" comments. An
//     AudioContext in a mount effect would be created twice.
//  3. Web Audio does not exist during SSR, so module scope must not touch
//     `window`. Construction happens on first use, inside a browser-only path.
// ---------------------------------------------------------------------------

import type { BusId } from "@/data/audioEvents";

/** Bus ids in graph order. Mirrors the §5.2 diagram. */
export const BUS_IDS: readonly BusId[] = [
  "music",
  "ambience",
  "sfxShip",
  "sfxWorld",
  "ui",
];

/**
 * Soft-clip transfer curve for the output safety stage, tanh-shaped.
 *
 * ⚠⚠ THIS EXISTS BECAUSE THE TIER-2 SUITE CAUGHT A REAL DEFECT ON ITS FIRST RUN.
 * `DynamicsCompressorNode` was described in this file as a "soft brickwall", and
 * it is not one: it has **no lookahead**, so its 2 ms attack lets the leading
 * transient straight through. MEASURED — eight simultaneous full-scale sources
 * through the master limiter peaked at **1.3751**, i.e. +2.8 dB over full scale,
 * which clips at the output device.
 *
 * The compressor still does the useful work (it rides the sustained level down
 * gracefully); this stage only guarantees the ceiling. tanh is chosen over a hard
 * `min/max` clamp because hard clipping generates broadband harmonic distortion
 * on every transient, whereas tanh is gentle near unity and only bends hard
 * beyond it.
 */
export function softClipCurve(samples = 2048): Float32Array<ArrayBuffer> {
  // ⚠ Explicitly over an ArrayBuffer: TS 5.9 makes Float32Array generic in its
  // backing buffer, and `WaveShaperNode.curve` requires Float32Array<ArrayBuffer>
  // specifically (a SharedArrayBuffer-backed one is not assignable).
  const curve = new Float32Array(new ArrayBuffer(samples * 4));
  // Drive chosen so |x| <= 1 passes essentially untouched (tanh(1.0)/1.0 ≈ 0.96
  // at the knee) while |x| = 4 is folded to ~0.999.
  const k = 1.6;
  for (let i = 0; i < samples; i++) {
    // WaveShaper maps the curve across input [-1, 1], so probe a wider input
    // range and let the node's own clamping handle anything past it.
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return curve;
}

export type AudioEngine = {
  ctx: AudioContext;
  /** Everything terminates here. Volume sliders write this. */
  master: GainNode;
  /** Soft brickwall after master — insurance against a simultaneous-impact blowout. */
  limiter: DynamicsCompressorNode;
  /** Final ceiling guarantee. The compressor cannot provide one — see `softClipCurve`. */
  clipper: WaveShaperNode;
  buses: Record<BusId, GainNode>;
  /**
   * Sub-bus of `sfxShip` with its OWN ceiling, so a full-volume alarm can never
   * exceed a sane peak no matter where the master sits (§8.3). This is the fix
   * for the "the alarm is unbearable" complaint, which is about RELATIVE level.
   */
  alerts: GainNode;
  /** Optional capture tap for the §10.3 verification harness. Null until armed. */
  capture: MediaStreamAudioDestinationNode | null;
};

let engine: AudioEngine | null = null;
let unlocked = false;

/**
 * Pre-unlock trigger queue (T8). The first gesture is usually also the click
 * that wants a sound, so dropping it feels broken.
 *
 * ⚠ ENTRIES EXPIRE. A plain queue would fire a click from the title screen
 * ten seconds later, when the player has moved on. Same shape as comms.ts's
 * `pendingDelayedIds`, plus a TTL.
 */
const PENDING_TTL_MS = 500;
const pending: { id: string; at: number }[] = [];
let flushPending: ((id: string) => void) | null = null;

/** Registered by voices.ts to avoid a circular import. */
export function setPendingFlushHandler(fn: (id: string) => void): void {
  flushPending = fn;
}

export function isAudioUnlocked(): boolean {
  return unlocked;
}

export function getEngine(): AudioEngine | null {
  return engine;
}

/**
 * Create the graph. Safe to call repeatedly — returns the existing engine.
 *
 * Callable before a gesture (the context simply starts `suspended`), but
 * `unlockAudio()` must run from inside a real gesture handler before anything
 * is audible.
 */
export function ensureEngine(): AudioEngine | null {
  if (engine) return engine;
  if (typeof window === "undefined") return null;

  const Ctor: typeof AudioContext | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) {
    console.warn("[audio] Web Audio unavailable; audio disabled.");
    return null;
  }

  const ctx = new Ctor({ latencyHint: "interactive" });

  // ⚠ The limiter sits AFTER master, so the volume sliders operate on signal
  // going INTO it. Putting it before master would let a low master setting
  // sneak past the ceiling and a high one slam into it.
  //
  // master → compressor → soft clipper → destination. BOTH stages are needed:
  // the compressor rides sustained level down musically but has no lookahead, so
  // a transient passes through it (MEASURED at 1.3751 peak from an 8× overdrive);
  // the clipper guarantees the ceiling but would distort if asked to do the
  // level-riding. See `softClipCurve`.
  const clipper = ctx.createWaveShaper();
  clipper.curve = softClipCurve();
  clipper.oversample = "2x"; // suppresses the aliasing the shaper itself creates
  clipper.connect(ctx.destination);

  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.12;
  limiter.connect(clipper);

  const master = ctx.createGain();
  master.gain.value = 0; // raised by the settings sync; silence until then
  master.connect(limiter);

  const buses = {} as Record<BusId, GainNode>;
  for (const id of BUS_IDS) {
    const g = ctx.createGain();
    g.gain.value = 1;
    g.connect(master);
    buses[id] = g;
  }

  const alerts = ctx.createGain();
  // §8.3 ceiling. Alarms are authored loud; this is what stops them dominating.
  alerts.gain.value = 0.7;
  alerts.connect(buses.sfxShip);

  engine = { ctx, master, limiter, clipper, buses, alerts, capture: null };

  if (process.env.NODE_ENV === "development") {
    console.log(
      `[audio] graph built — ${ctx.sampleRate} Hz, baseLatency ${(
        (ctx.baseLatency ?? 0) * 1000
      ).toFixed(2)} ms, state "${ctx.state}"`,
    );
    // ⚠⚠ MEASURED ON THE DEV MACHINE: the SAME browser on the SAME machine
    // reported 44100, then 48000, then a persistent 16000 Hz across reloads.
    // 16 kHz is an 8 kHz Nyquist — every sound loses its entire top octave and
    // the game just sounds dull, with nothing in the UI to explain why.
    //
    // The cause is the output device: a headset in communications mode, or
    // anything holding the device at a comms rate, drags the context down with
    // it. We deliberately do NOT force `sampleRate` in the constructor — when
    // the device really is 16 kHz, forcing 48 k only adds a resample and buys
    // no quality. So this warning exists to make an invisible problem visible.
    if (ctx.sampleRate < 24000) {
      console.warn(
        `[audio] ⚠ context is running at ${ctx.sampleRate} Hz — everything will ` +
          `sound dull (Nyquist ${ctx.sampleRate / 2} Hz). This is the OUTPUT ` +
          `DEVICE's rate, not a bug in the engine: check for a headset in ` +
          `communications/handsfree mode, or another app holding the audio ` +
          `device. Switching output device and reloading fixes it.`,
      );
    }
  }

  return engine;
}

/**
 * Resume the context. MUST be called synchronously inside a user-gesture
 * handler (T8) — every browser starts the context suspended, iOS Safari
 * strictest, and `resume()` outside a gesture can stay pending forever.
 */
export function unlockAudio(): void {
  const e = ensureEngine();
  if (!e) return;

  const finish = () => {
    if (unlocked) return;
    unlocked = true;

    // Drain the queue, dropping anything already stale.
    const now = performance.now();
    const fire = flushPending;
    while (pending.length) {
      const p = pending.shift()!;
      if (fire && now - p.at <= PENDING_TTL_MS) fire(p.id);
    }
    if (process.env.NODE_ENV === "development") {
      console.log('[audio] unlocked — context "running"');
    }
  };

  if (e.ctx.state === "running") {
    finish();
    return;
  }
  void e.ctx.resume().then(finish);
}

/** Queue a trigger that arrived before unlock. Returns true if it was queued. */
export function queueUntilUnlocked(id: string): boolean {
  if (unlocked) return false;
  // Bounded: a player hammering keys on the title screen must not grow this.
  if (pending.length < 8) pending.push({ id, at: performance.now() });
  return true;
}

// ---------------------------------------------------------------------------
// Parameter writes
// ---------------------------------------------------------------------------

/**
 * The ONLY way this codebase should write a smoothed AudioParam.
 *
 * ⚠⚠ THE `cancelScheduledValues` CALL IS NOT DEFENSIVE — IT IS A MEASURED
 * PERFORMANCE FIX (docs/AUDIO_PLAN.md M1). AudioParam write cost scales with
 * the param's pending event list: MEASURED 1.40 µs with an empty list versus
 * 17.60 µs at 20,000 queued events (12.6×), and cancel-then-schedule pins it at
 * 0.40 µs. A repeated writer that never cancels grows that list.
 *
 * `setTargetAtTime` also avoids the click that a bare `.value =` assignment
 * produces mid-drag ("zipper noise").
 */
export function setParamSmooth(
  param: AudioParam,
  value: number,
  timeConstant = 0.015,
): void {
  const e = engine;
  if (!e) return;
  const t = e.ctx.currentTime;
  param.cancelScheduledValues(t);
  param.setTargetAtTime(value, t, timeConstant);
}

/** Immediate, unsmoothed write. For per-play setup on a fresh node only. */
export function setParamNow(param: AudioParam, value: number): void {
  param.value = value;
}

// ---------------------------------------------------------------------------
// Volume / blur
// ---------------------------------------------------------------------------

/**
 * Perceptual slider → linear gain (§8.1).
 *
 * `gain = t²`, i.e. `dB = 40·log10(t)`: the midpoint reads as roughly half as
 * loud, and t = 0 is a hard zero rather than −∞ dB asymptote.
 *
 * ⚠ A LINEAR mapping (`gain = t`) is the single most-reported volume-slider
 * complaint — it concentrates nearly all audible change in the top 20–30% of
 * travel, so the slider "does nothing until 80%".
 */
export function sliderToGain(t: number): number {
  if (!Number.isFinite(t) || t <= 0) return 0;
  const c = Math.min(1, t);
  return c * c;
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export type BlurBehaviour = "mute" | "duck" | "play";

/** −25 dB. Quiet enough not to carry into a call, loud enough that an alarm still reads. */
const DUCK_GAIN = dbToGain(-25);

let masterTarget = 0;
let blurred = false;

/** Apply the master slider value. Re-applied automatically when focus returns. */
export function setMasterGain(gain: number): void {
  masterTarget = gain;
  const e = engine;
  if (!e) return;
  if (!blurred) setParamSmooth(e.master.gain, gain, 0.02);
}

const busTarget: Partial<Record<BusId, number>> = {};
let gamePaused = false;
/** Buses silenced by the pause menu. Music and UI stay: the menu has clicks, and music carries on (as in Minecraft since 1.21.6). */
const PAUSED_BUSES: readonly BusId[] = ["ambience", "sfxShip", "sfxWorld"];

export function setBusGain(bus: BusId, gain: number): void {
  busTarget[bus] = gain;
  const e = engine;
  if (!e) return;
  if (gamePaused && PAUSED_BUSES.includes(bus)) return;
  setParamSmooth(e.buses[bus].gain, gain, 0.02);
}

/** Pause menu open: fade the world (engine, wind, ambience) out, and back in on resume. */
export function setGamePaused(paused: boolean): void {
  if (gamePaused === paused) return;
  gamePaused = paused;
  const e = engine;
  if (!e) return;
  // τ 0.1 s: inaudible within ~0.5 s, quick enough to read as a response to the key.
  for (const bus of PAUSED_BUSES) setParamSmooth(e.buses[bus].gain, paused ? 0 : (busTarget[bus] ?? 0), 0.1);
}

/**
 * Tab focus changed (§8.2). Ramps rather than cutting — 150–300 ms, which also
 * satisfies the no-clicks rule.
 *
 * 🔑 `duck` is the DEFAULT, and the reason is specific to this game: it is
 * co-op, so you alt-tab to a wiki or a call while the world keeps running and
 * teammates keep playing. A hard mute means missing a hull-breach cue the game
 * is actively trying to deliver; full volume means blaring into the call.
 */
export function applyBlurState(hidden: boolean, behaviour: BlurBehaviour): void {
  const e = engine;
  if (!e) return;
  blurred = hidden && behaviour !== "play";
  const target = !blurred
    ? masterTarget
    : behaviour === "mute"
      ? 0
      : masterTarget * DUCK_GAIN;
  setParamSmooth(e.master.gain, target, 0.08);
}

// ---------------------------------------------------------------------------
// Streamed sources (A7) — music
// ---------------------------------------------------------------------------

export type StreamSource = {
  element: HTMLAudioElement;
  /** Per-source gain, after the element and before the bus. */
  gain: GainNode;
  /** Detach from the graph and release the media resource. */
  dispose(): void;
};

/**
 * A long file streamed through an `<audio>` element INTO the bus graph (A7).
 * A 3-minute track decoded with `decodeAudioData` is ~60 MB resident; a media
 * element buffers a few seconds.
 *
 * ⚠ The ONLY place an audio element may be created — `pnpm check:audio`
 * enforces it. Once wrapped in a `MediaElementAudioSourceNode` the element's
 * own output is silenced and it plays only through `bus`, so the volume
 * sliders, the limiter and blur ducking all apply to it.
 */
export function createStreamSource(url: string, bus: BusId): StreamSource | null {
  const e = ensureEngine();
  if (!e) return null;
  const element = document.createElement("audio");
  element.preload = "auto";
  element.src = url;
  const source = e.ctx.createMediaElementSource(element);
  const gain = e.ctx.createGain();
  gain.gain.value = 0;
  source.connect(gain);
  gain.connect(e.buses[bus]);
  return {
    element,
    gain,
    dispose() {
      element.pause();
      source.disconnect();
      gain.disconnect();
      element.removeAttribute("src");
      element.load(); // releases the network/decoder resources
    },
  };
}

// ---------------------------------------------------------------------------
// Capture tap (§10.3) — how an agent verifies the real mix without ears
// ---------------------------------------------------------------------------

/**
 * Route master through a `MediaStreamAudioDestinationNode` so `MediaRecorder`
 * can capture the actual output.
 *
 * MEASURED WORKING: a 600 ms capture produced an 8,024-byte
 * `audio/webm;codecs=opus` blob which decoded back at the expected peak
 * (0.307 against a 0.3-gain source). This is the backbone of Tier-3
 * verification; see docs/AUDIO_PLAN.md §2.5 / §10.3.
 */
export function armCapture(): MediaStream | null {
  const e = ensureEngine();
  if (!e) return null;
  if (!e.capture) {
    e.capture = e.ctx.createMediaStreamDestination();
    // Tap, not a re-route: normal output continues to `destination`.
    e.master.connect(e.capture);
  }
  return e.capture.stream;
}
