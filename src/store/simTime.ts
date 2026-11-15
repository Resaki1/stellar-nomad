// ─────────────────────────────────────────────────────────────────────
// SIM TIME — one scalar, so orbits can be frozen, real-time, or fast
// ─────────────────────────────────────────────────────────────────────
//
// Everything positional derives from a single instant, held here as UTC
// epoch milliseconds. `sim/ephemeris.ts` turns it into a Julian Date and
// then into positions and orientations.
//
// Default rate is 1 (real time, ROADMAP D6). Ships ride their body's frame
// (sim/frames.ts), so moving bodies do not leave them behind. `__test.isolate()`
// and `__bench` force 0 for reproducible captures.
//
// 🔑 Why a RATE rather than a boolean freeze: an eclipse is a moment, and the
// shadow racing across the surface is the part worth seeing. Because time is
// already one scalar, a multiplier costs nothing — and 1e4–1e5 is what makes
// an eclipse watchable rather than merely reachable.

import { atom } from "jotai";

import { updateEphemerisPositions } from "@/sim/celestialConstants";
import { DEFAULT_SIM_EPOCH_MS, jdFromUnixMs } from "@/sim/ephemeris";
import { isSimPaused } from "@/sim/simPause";

/**
 * The instant the simulation is currently at, UTC epoch milliseconds.
 *
 * Defaults to the **2024-04-08 total solar eclipse at greatest eclipse**, which
 * is not an arbitrary choice: it is the validation case `__lum.ephemeris()`
 * checks against published values (greatest eclipse 18:17 UTC, γ = 0.3435), so
 * a fresh session starts somewhere the system's correctness is verifiable.
 */
export const ECLIPSE_2024_04_08_MS = DEFAULT_SIM_EPOCH_MS;

const simEpochMsBaseAtom = atom<number>(ECLIPSE_2024_04_08_MS);

/**
 * ⚠⚠ WRITE-THROUGH: setting this SOLVES THE EPHEMERIS IMMEDIATELY, it does not
 * wait for the next frame.
 *
 * It has to. `settingsIsOpenAtom` sets `frameloop="never"`, so while the dev
 * menu is open **no frame runs** — and the only other caller of
 * `updateEphemerisPositions` is `CelestialBody`'s frame loop. Set a date in the
 * dev menu and then hit "warp to body" and, without this, the warp resolves
 * against the positions from whenever the last frame rendered: the ship lands
 * where the planet used to be. Same class as the four E0 staleness bugs, with
 * the paused frameloop standing in for a stale copy.
 *
 * 🔑 A write-through atom rather than a separate `setSimEpochAndSolveAtom`,
 * because a rule every caller must remember is a rule the next caller forgets.
 * `updateEphemerisPositions` is idempotent and cached on the JD, so the frame
 * loop's own call costs a float compare after this.
 */
export const simEpochMsAtom = atom(
  (get) => get(simEpochMsBaseAtom),
  (get, set, ms: number) => {
    set(simEpochMsBaseAtom, ms);
    updateEphemerisPositions(jdFromUnixMs(ms));
  },
);

/**
 * Simulated seconds per real second. 0 = frozen, 1 = real time (the default),
 * 1e5 ≈ a day per second.
 *
 * ⚠ Clamped by the UI rather than here — a dev tool wanting 1e9 to skip a year
 * should be able to, and the ephemeris is analytic so a huge step costs the same
 * as a small one. There is no integrator to destabilise.
 */
export const simRateAtom = atom<number>(1);

/** Advance sim time by one real frame. No-op while the rate is 0 or the sim is paused. Called once per frame (SpaceRenderer). */
export const advanceSimTimeAtom = atom(
  null,
  (get, set, realDeltaSeconds: number) => {
    const rate = get(simRateAtom);
    if (rate === 0 || isSimPaused()) return;
    set(simEpochMsAtom, get(simEpochMsAtom) + realDeltaSeconds * rate * 1000);
  },
);

/** ISO-ish display string for the HUD/dev tools. */
export function formatSimTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}
