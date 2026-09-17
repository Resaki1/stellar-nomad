// ---------------------------------------------------------------------------
// SPATIALISATION — invariants A2 (listener seam) and A3 (hand-rolled distance).
// docs/AUDIO_PLAN.md §4.
// ---------------------------------------------------------------------------

export type Vec3 = { x: number; y: number; z: number };

// ---------------------------------------------------------------------------
// A2 — the listener-mode seam
// ---------------------------------------------------------------------------

/**
 * `chase` is today's third-person camera. `cockpit` and `xr` do not exist yet.
 *
 * 🔑 THIS TYPE IS THE WHOLE POINT OF THE SEAM. Flat, unpanned ship audio is a
 * CHASE-MODE OPTIMISATION, not a law: A2's justification is "the camera is not
 * the pilot", which is precisely the condition that stops holding in a cockpit.
 * Adding a mode later means a branch in `getAudioListenerPose` and filling in
 * `localOffsetM` in the catalogue — not touching every call site.
 *
 * Three prospective consumers: an optional cockpit view, WebXR, and on-foot
 * inside a ship (all far future, and all the same problem).
 */
export type ListenerMode = "chase" | "cockpit" | "xr";

let listenerMode: ListenerMode = "chase";

export function setListenerMode(mode: ListenerMode): void {
  listenerMode = mode;
}

export function getListenerMode(): ListenerMode {
  return listenerMode;
}

const IDENTITY_POSE = {
  positionM: { x: 0, y: 0, z: 0 } as Vec3,
  /** Quaternion [x, y, z, w]. */
  quat: [0, 0, 0, 1] as readonly [number, number, number, number],
};

/**
 * The listener's pose in the frame that world-emitter positions are expressed
 * in.
 *
 * ⚠ RETURNS IDENTITY TODAY, AND THAT IS CORRECT, NOT A STUB. In chase mode the
 * ship is pinned to local (0,0,0) every frame (Spaceship.tsx:506) and the
 * floating origin re-anchors on the ship every frame
 * (Spaceship.tsx:503-505) — so emitter positions handed to this module are
 * already ship-relative metres and the listener genuinely sits at the origin.
 *
 * (The `RECENTER_THRESHOLD_KM = 10_000` / `maybeRecenter()` mechanism in
 * worldOrigin.tsx is DEAD CODE — never called anywhere in src/. Don't "fix" it
 * without re-checking audio.)
 *
 * When `xr` lands: write the listener every compositor frame with NO ramp,
 * bypassing the A5 tick — audio lagging head rotation is what makes VR audio
 * nauseating. Read the pose from `camera.matrixWorld` (three's WebXRManager
 * keeps it current); do not hand-roll `XRFrame.getViewerPose()`.
 */
export function getAudioListenerPose(): typeof IDENTITY_POSE {
  switch (listenerMode) {
    case "chase":
      return IDENTITY_POSE;
    case "cockpit":
    case "xr":
      // Unreachable: setListenerMode is not called with these yet.
      return IDENTITY_POSE;
  }
}

// ---------------------------------------------------------------------------
// A3 — distance attenuation
// ---------------------------------------------------------------------------

/**
 * Full volume within this radius, in metres.
 *
 * ⚠ WHY WE DO NOT USE PannerNode's OWN DISTANCE MODEL: `refDistance` and
 * `maxDistance` are single scalars, and no single inverse/exponential curve is
 * sane across a game whose distances span ~1 m to ~1e9 m. The panner does
 * PANNING here; gain is ours.
 */
const REF_M = 12;

/** Inaudible beyond this. */
const MAX_M = 2500;

const LOG_SPAN = Math.log10(MAX_M / REF_M);

/**
 * Gain for a world emitter at `distanceM`. 1 inside REF_M, 0 beyond MAX_M,
 * linear in log-distance between — which is what reads as natural falloff.
 */
export function gainForDistance(distanceM: number): number {
  if (!(distanceM > REF_M)) return 1;
  if (distanceM >= MAX_M) return 0;
  return 1 - Math.log10(distanceM / REF_M) / LOG_SPAN;
}

/**
 * Cull thresholds, deliberately ASYMMETRIC (§5.3 / A11).
 *
 * ⚠ A single threshold makes a voice chatter on and off as the emitter's gain
 * wobbles across it. That is not hypothetical here: "a few drones flying in and
 * out" is exactly the oscillating-distance case. Enter high, leave low.
 */
export const CULL_ENTER_GAIN = 0.02;
export const CULL_EXIT_GAIN = 0.008;

/** Squared distance from the listener, avoiding a sqrt in the common reject case. */
export function distanceSqToListener(p: Vec3): number {
  const l = getAudioListenerPose().positionM;
  const dx = p.x - l.x;
  const dy = p.y - l.y;
  const dz = p.z - l.z;
  return dx * dx + dy * dy + dz * dz;
}

export function distanceToListener(p: Vec3): number {
  return Math.sqrt(distanceSqToListener(p));
}

/**
 * Feed a panner from a world position.
 *
 * Uses the AudioParam form (`positionX.value`) rather than the deprecated
 * `setPosition()`. Direct assignment is intentional: these are per-emitter
 * position updates at the 15 Hz tick, where a ramp would smear fast flybys, and
 * the param has no pending event list to grow (M1).
 */
export function applyPannerPosition(panner: PannerNode, p: Vec3): void {
  if (panner.positionX) {
    panner.positionX.value = p.x;
    panner.positionY.value = p.y;
    panner.positionZ.value = p.z;
  } else {
    // Older Safari. Deprecated but still the only path there.
    (panner as unknown as { setPosition(x: number, y: number, z: number): void })
      .setPosition(p.x, p.y, p.z);
  }
}

/**
 * Configure a pooled panner once.
 *
 * `equalpower` by default (A4): MEASURED at 1/3.4 the cost of HRTF, and HRTF
 * buys imaging only for close sources. A future "Headphones" mode applies HRTF
 * to the nearest N voices only, never globally.
 *
 * `distanceModel` is set to `linear` with a huge `maxDistance` purely so the
 * node's own attenuation is a no-op — `gainForDistance` above owns gain.
 */
export function configurePanner(panner: PannerNode): void {
  panner.panningModel = "equalpower";
  panner.distanceModel = "linear";
  panner.refDistance = 1;
  panner.maxDistance = 1e6;
  panner.rolloffFactor = 0;
}
