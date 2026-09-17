// ---------------------------------------------------------------------------
// SHIP RTPC BUFFER — docs/AUDIO_PLAN.md §5.4 / A5.
//
// A plain mutable object written from `Spaceship.tsx`'s existing `useFrame` and
// read by the 15 Hz audio tick. Deliberately NOT an atom and NOT React state.
//
// 🔑 THIS IS THE `transitDriveBuffer` PATTERN, which the plan names as the
// sanctioned escape hatch (A5): anything that needs frame-rate values writes a
// buffer from a loop that already runs, and the audio tick consumes it at its
// own, much lower cadence. A jotai atom here would re-render React at frame
// rate, which CLAUDE.md forbids outright; reading the atom from the tick would
// be fine but there is no atom to read — normal-flight velocity does not exist
// as one (§5.4).
// ---------------------------------------------------------------------------

export const audioShipBuffer = {
  /**
   * Smoothed thrust demand, 0..1. Mirrors `exhaustIntensity` in Spaceship.tsx,
   * which is already smoothed and already drives the visual exhaust — so the
   * engine sound and the engine plume cannot disagree.
   */
  throttle: 0,
  /** Speed in m/s, for future aero noise. Written alongside throttle. */
  speedMps: 0,
};
