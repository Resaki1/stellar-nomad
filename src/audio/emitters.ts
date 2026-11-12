// ---------------------------------------------------------------------------
// EMITTER REGISTRY — invariant A11. docs/AUDIO_PLAN.md §4 / §5.3a.
//
// A LOOP IS NOT A LONG ONE-SHOT. `playAudio()` is fire-and-forget: it starts,
// it ends, nobody refers to it again. A drone's engine hum, a station vent, a
// mining beam need start / stop / move / change-parameter over a lifetime
// measured in minutes. This registry owns that.
//
// ⚠ WHAT THIS DELIBERATELY IS NOT: there is no virtual-voice tier, no cluster
// aggregation and no audio LOD here. The first pass of the audio plan specified
// all three, sized for a Satisfactory-scale base. The game's actual target is
// "a space station with a few drones flying in and out and maybe a handful of
// space ships" — roughly 10–30 emitters against 24 real voices, where triage
// almost never fires and clustering has nothing to cluster.
//
// §5.3a of the plan records the exact conditions that would bring each of them
// back. Read it before adding any of that machinery.
// ---------------------------------------------------------------------------

import { getAudioEvent, type AudioEventId } from "@/data/audioEvents";
import {
  playAudio,
  stopVoiceBySerial,
  setVoiceGain,
  setVoicePitch,
  updateVoicePosition,
  isVoiceActive,
} from "./voices";
import {
  CULL_ENTER_GAIN,
  CULL_EXIT_GAIN,
  distanceToListener,
  gainForDistance,
  type Vec3,
} from "./spatial";
import { dbToGain } from "./engine";
import { acousticsForBody, propagationFor } from "./acoustics";
import { getDominantAtmosphereBody } from "@/components/space/atmospherePass";
import { setVoicePropagation } from "./voices";

export type EmitterHandle = {
  readonly id: number;
  setPosition(p: Vec3): void;
  /** Named continuous parameter, 0..1. Phase 0 stores it; §5.8 gives it meaning. */
  setParam(name: string, value: number): void;
  /** Multiply the emitter's gain, e.g. for a machine idling at 40% load. */
  setIntensity(v: number): void;
  stop(fadeMs?: number): void
};

type Emitter = {
  fadeInMs?: number;
  pitchCents?: () => number;
  startAtS?: number;
  id: number;
  eventId: string;
  position: Vec3;
  intensity: number;
  /**
   * Live intensity source, evaluated on the tick.
   *
   * 🔑 Lets an emitter be driven by a per-frame buffer (audioShipBuffer) without
   * a second timer and without React ever seeing the value. Preferred over
   * calling `setIntensity` from a `useFrame`, which would write at 60-120 Hz
   * into a value only read at 15 Hz.
   */
  intensityFn: (() => number) | null;
  params: Map<string, number>;
  /** Serial of the real voice, or null while culled. */
  voice: number | null;
  spatial: boolean;
  /**
   * Read from the event def at registration, NOT from the live voice.
   *
   * 🔑 It has to be known BEFORE a voice exists, because atmospheric attenuation
   * belongs in the promote/cull decision — an emitter the atmosphere has silenced
   * must not take a real voice at all.
   */
  airCoupled: boolean;
  stopped: boolean;
};

const emitters = new Map<number, Emitter>();
let nextId = 1;

/**
 * Register a continuous sound. The returned handle is the only way to address
 * it afterwards.
 *
 * The emitter may not get a real voice immediately (or ever, if it is out of
 * range) — that is normal and is resolved by `updateEmitters()` on the A5 tick.
 */
export function registerEmitter(opts: {
  fadeInMs?: number;
  /** Polled at 15 Hz, with audio-thread smoothing. */
  pitchCents?: () => number;
  /** Earliest audio-clock start, e.g. the end of the cutter's ignition clip. */
  startAtS?: number;
  event: AudioEventId;
  positionM?: Vec3;
  /** A number for a fixed level, or a function polled on each audio tick. */
  intensity?: number | (() => number);
}): EmitterHandle {
  const def = getAudioEvent(opts.event);
  if (!def.loop && process.env.NODE_ENV === "development") {
    // Not fatal, but almost always a mistake: a one-shot registered as an
    // emitter will play once and then hold a slot doing nothing.
    console.warn(
      `[audio] registerEmitter("${opts.event}") on a non-looping event — did you mean playAudio()?`,
    );
  }

  const id = nextId++;
  const em: Emitter = {
    fadeInMs: opts.fadeInMs,
    pitchCents: opts.pitchCents,
    startAtS: opts.startAtS,
    id,
    eventId: def.id,
    position: { ...(opts.positionM ?? { x: 0, y: 0, z: 0 }) },
    intensity: typeof opts.intensity === "number" ? opts.intensity : 1,
    intensityFn: typeof opts.intensity === "function" ? opts.intensity : null,
    params: new Map(),
    voice: null,
    spatial: def.tier === "world",
    airCoupled: def.tier === "world" && def.coupling === "air",
    stopped: false,
  };
  emitters.set(id, em);

  return {
    id,
    setPosition(p) {
      em.position.x = p.x;
      em.position.y = p.y;
      em.position.z = p.z;
      // Position is pushed to the voice on the tick, not here — a caller
      // updating from useFrame would otherwise write at 60–120 Hz (A5, M1).
    },
    setParam(name, value) {
      em.params.set(name, value);
    },
    setIntensity(v) {
      // An explicit write wins and detaches the live source, so the two cannot
      // fight over the same field.
      em.intensityFn = null;
      em.intensity = Math.max(0, v);
    },
    stop(fadeMs = 60) {
      em.stopped = true;
      if (em.voice !== null) {
        stopVoiceBySerial(em.voice, fadeMs);
        em.voice = null;
      }
      emitters.delete(id);
    },
  };
}

/** Target gain for an emitter, before distance. */
function baseGain(em: Emitter): number {
  const def = getAudioEvent(em.eventId as AudioEventId);
  if (em.intensityFn) {
    const v = em.intensityFn();
    em.intensity = Number.isFinite(v) ? Math.max(0, v) : 0;
  }
  return dbToGain(def.gainDb ?? 0) * em.intensity;
}

/**
 * Promote / release / update every emitter. Called from the A5 tick at ~15 Hz.
 *
 * ⚠⚠ THE HYSTERESIS BELOW IS THE POINT OF THIS FUNCTION, not a nicety. A
 * single threshold makes a voice chatter on and off as an emitter's gain wobbles
 * across it — and "a few drones flying in and out" is precisely that
 * oscillating-distance case. Enter at CULL_ENTER_GAIN, leave only at the
 * strictly lower CULL_EXIT_GAIN.
 */
export function updateEmitters(): void {
  // Local atmosphere, resolved ONCE per tick rather than per emitter.
  //
  // ⚠ `null` means vacuum, not "unknown" (trap T7): a body drops out of this map
  // when its LOD hides it, and at that distance vacuum is the correct answer.
  const dom = getDominantAtmosphereBody();
  const atm = dom ? acousticsForBody(dom.id) : null;
  const altitudeKm = dom ? dom.distanceKm - dom.params.groundRadiusKm : 0;

  for (const em of Array.from(emitters.values())) {
    if (em.stopped) continue;

    const dist = em.spatial ? distanceToListener(em.position) : 0;
    const distGain = em.spatial ? gainForDistance(dist) : 1;

    // Atmospheric propagation (§12.3), folded in BEFORE the cull test so that a
    // sound the atmosphere has silenced never occupies a voice.
    //
    // ⚠ Air-coupled emitters only. A contact-coupled sound reached the listener
    // through the hull, so the surrounding gas is irrelevant to it — that split
    // is what keeps mining audible in vacuum while a detached source correctly
    // falls silent (§12.3c).
    let propGain = 1;
    let cutoffHz = 20000;
    if (em.airCoupled) {
      const prop = propagationFor(atm, altitudeKm, dist);
      propGain = prop.gain;
      cutoffHz = prop.cutoffHz;
    }
    const audible = baseGain(em) * distGain * propGain;
    const pitch = em.pitchCents?.() ?? 0;
    const cents = Number.isFinite(pitch) ? Math.max(-1200, Math.min(1200, pitch)) : 0;
    if (em.voice !== null && !isVoiceActive(em.voice)) em.voice = null;

    if (em.voice === null) {
      if (audible >= CULL_ENTER_GAIN) {
        const serial = playAudio(em.eventId, {
          positionM: em.position,
          emitterId: em.id,
          startAtS: em.startAtS,
          fadeInMs: em.fadeInMs,
          pitchCents: cents,
          initialGain: audible,
          initialCutoffHz: cutoffHz,
          // Randomised start offset: the coherence fix. Identical buffers
          // started together sum like voltage (+9.5 dB at N=3), not like
          // incoherent sources (+4.8 dB). See PlayOptions.offsetS.
          offsetS: Math.random() * 10,
        });
        em.voice = serial;
      }
      continue;
    }

    if (audible <= CULL_EXIT_GAIN) {
      stopVoiceBySerial(em.voice, 120);
      em.voice = null;
      continue;
    }

    if (em.spatial) updateVoicePosition(em.voice, em.position);
    if (em.airCoupled) setVoicePropagation(em.voice, cutoffHz);
    setVoiceGain(em.voice, audible);
    if (em.pitchCents) setVoicePitch(em.voice, cents);
  }
}

export function emitterCount(): number {
  return emitters.size;
}

export type EmitterSnapshot = {
  id: number;
  eventId: string;
  distanceM: number | null;
  intensity: number;
  voice: number | null;
  params: Record<string, number>;
};

export function emitterSnapshots(): EmitterSnapshot[] {
  return Array.from(emitters.values()).map((em) => ({
    id: em.id,
    eventId: em.eventId,
    distanceM: em.spatial
      ? Math.round(distanceToListener(em.position) * 10) / 10
      : null,
    intensity: em.intensity,
    voice: em.voice,
    params: Object.fromEntries(em.params),
  }));
}

/** Dev/bench only. */
export function stopAllEmitters(): void {
  for (const em of Array.from(emitters.values())) {
    if (em.voice !== null) stopVoiceBySerial(em.voice, 0);
    emitters.delete(em.id);
  }
}
