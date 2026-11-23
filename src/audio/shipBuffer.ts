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
  /**
   * Speed in m/s — the same quantity the HUD displays, transit velocity
   * included. Drives the `q = ½ρv²` wind bed (§12.3, src/audio/wind.ts).
   *
   * ⚠ Written in `Spaceship.tsx` OUTSIDE its `benchMode` guard, unlike the
   * `hudInfoAtom` write beside it: the guard is there to avoid React
   * re-renders, which a plain field assignment does not cause, and a bench run
   * that silenced the wind would measure the wrong scene.
   */
  speedMps: 0,
  /**
   * Speed relative to the co-rotating local air, m/s (VFX plan §6): what the wind
   * bed hears. Equals `speedMps` in vacuum; ~0 when hovering over a spinning planet.
   */
  airspeedMps: 0,
  /** Body whose atmosphere the SHIP is in (`src/sim/atmosphere.ts` ambientAt), or null. */
  atmoBodyId: null as string | null,
  /** Ship altitude above that body's reference surface, km. */
  altitudeKm: 0,
  /** Main-engine thrust command of the last physics step, 0..1, UNSMOOTHED (engine ignition/cutoff edges). */
  thrustCmd: 0,
  /** Thermal network (HEAT_SYSTEM_PLAN §3), from shipRes.thermal: bell temperature (K) and the
   *  bells'/loop's rates of change (K/s, signed), plus the heat store 0..1.3. */
  bellK: 0,
  bellRateKps: 0,
  loopK: 0,
  loopRateKps: 0,
  heat01: 0,
  /** Plume "breathing" gain (≈1 ± 0.05–0.15), the exhaust's slow OU mode; AUDIO_PLAN §6.10.2. */
  plumeBreath: 1,
  /** Salvage tractor beams currently holding a wreck. Written by WreckCollector. */
  tractorBeams: 0,
};
