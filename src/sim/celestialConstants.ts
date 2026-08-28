// Shared positional constants for celestial bodies in the Sol system.
// Derived from sol.json (single source of truth) to avoid circular imports
// between component modules.

import solSystem from "@/sim/systems/sol.json";
import type { CelestialBodyDef } from "@/sim/systemTypes";
import { DEFAULT_SIM_EPOCH_MS, jdFromUnixMs, solveSystem } from "@/sim/ephemeris";

const bodies = solSystem.celestialBodies as CelestialBodyDef[];

function findBody(id: string): CelestialBodyDef {
  const body = bodies.find((b) => b.id === id);
  if (!body) throw new Error(`[celestialConstants] body "${id}" not found in sol.json`);
  return body;
}

// ── ⚠⚠ THESE POSITION EXPORTS ARE LIVE, NOT CONSTANT (ephemeris, 2026-08-27) ──
//
// Every `*_POSITION_KM` below is a MUTABLE array that `updateEphemerisPositions()`
// rewrites IN PLACE from `sim/ephemeris.ts`. Body configs hold a reference to it
// (`positionKm: PLANET_POSITION_KM`), so they and every downstream consumer see
// the live value with no code change — which is the only reason adding real
// orbits did not have to touch ~70 read sites at once.
//
// ⚠⚠ THE HAZARD THIS CREATES, stated plainly: anything that COPIES one of these
// arrays, or memoises a value derived from one, freezes at whatever the value was
// at that moment. That is defect D17's exact failure mode (a static
// `sunIlluminance` baked into a shader literal). **Read them per frame; never
// spread, destructure or `useMemo` them.** A `useMemo` keyed on the array will
// also never re-run, because the reference is deliberately stable.
//
// 🔑 The names are kept SCREAMING_CASE despite being mutable because renaming
// them is the ~70-site migration this approach exists to defer. When that
// migration happens, replace them with `bodyPositionKm(id)`.

const sol = findBody("sol");
const mercury = findBody("mercury");
const venus = findBody("venus");
const earth = findBody("earth");
const luna = findBody("luna");
const mars = findBody("mars");
const uranus = findBody("uranus");
const neptune = findBody("neptune");
const saturn = findBody("saturn");
const jupiter = findBody("jupiter");
const europa = findBody("europa");
const io = findBody("io");
const callisto = findBody("callisto");
const ganymede = findBody("ganymede");

/** Sun position in km (system coordinates). */
export const STAR_POSITION_KM = sol.positionKm as [number, number, number];
/** Sun radius in km. */
export const STAR_RADIUS_KM = sol.radiusKm;
/**
 * Star luminosity in solar units. Drives every body's sun illuminance via
 * `sunIlluminanceAt()` — see docs/LIGHTING_PLAN.md §3.0.
 *
 * ⚠ This is the primary star of the CURRENTLY HARDCODED system. When procedural
 * systems land it must come from the active system's description, not a module
 * constant — that is the seam.
 */
export const STAR_LUMINOSITY_SUN = sol.luminositySun ?? 1;

/**
 * Effective temperature of the primary, K. Drives the star's blackbody COLOUR
 * (`blackbodyLinearSrgb`), replacing Star.tsx's hardcoded G2V `vec3(1,.95,.9)` —
 * without this a generated M-dwarf or B-star renders Sol-coloured (§3.0). Same
 * procedural-systems seam as STAR_LUMINOSITY_SUN. Default 5772 = Sol.
 */
export const STAR_TEMP_K: number =
  (sol as { tempK?: number }).tempK ?? 5772;

/** Mercury position in km. */
export const MERCURY_POSITION_KM = mercury.positionKm as [number, number, number];
/** Mercury radius in km. */
export const MERCURY_RADIUS_KM = mercury.radiusKm;

/** Venus position in km. */
export const VENUS_POSITION_KM = venus.positionKm as [number, number, number];
/** Venus radius in km. */
export const VENUS_RADIUS_KM = venus.radiusKm;

/** Earth position in km (system coordinates). */
export const PLANET_POSITION_KM = earth.positionKm as [number, number, number];
/** Earth radius in km. */
export const PLANET_RADIUS_KM = earth.radiusKm;

/** Luna position in km. */
export const LUNA_POSITION_KM = luna.positionKm as [number, number, number];
/** Luna radius in km. */
export const LUNA_RADIUS_KM = luna.radiusKm;

/** Mars position in km. */
export const MARS_POSITION_KM = mars.positionKm as [number, number, number];
/** Mars radius in km. */
export const MARS_RADIUS_KM = mars.radiusKm;

/** Uranus position in km. */
export const URANUS_POSITION_KM = uranus.positionKm as [number, number, number];
/** Uranus radius in km. */
export const URANUS_RADIUS_KM = uranus.radiusKm;

/** Neptune position in km. */
export const NEPTUNE_POSITION_KM = neptune.positionKm as [number, number, number];
/** Neptune radius in km. */
export const NEPTUNE_RADIUS_KM = neptune.radiusKm;

/** Saturn position in km. */
export const SATURN_POSITION_KM = saturn.positionKm as [number, number, number];
/** Saturn radius in km. */
export const SATURN_RADIUS_KM = saturn.radiusKm;

/** Jupiter position in km. */
export const JUPITER_POSITION_KM = jupiter.positionKm as [number, number, number];
/** Jupiter radius in km. */
export const JUPITER_RADIUS_KM = jupiter.radiusKm;

/** Europa position in km. */
export const EUROPA_POSITION_KM = europa.positionKm as [number, number, number];
/** Europa radius in km. */
export const EUROPA_RADIUS_KM = europa.radiusKm;

/** Io position in km. */
export const IO_POSITION_KM = io.positionKm as [number, number, number];
/** Io radius in km. */
export const IO_RADIUS_KM = io.radiusKm;

/** Callisto position in km. */
export const CALLISTO_POSITION_KM = callisto.positionKm as [number, number, number];
/** Callisto radius in km. */
export const CALLISTO_RADIUS_KM = callisto.radiusKm;

/** Ganymede position in km. */
export const GANYMEDE_POSITION_KM = ganymede.positionKm as [number, number, number];
/** Ganymede radius in km. */
export const GANYMEDE_RADIUS_KM = ganymede.radiusKm;

// ── Starting position & rotation ─────────────────────────────────────
/** Default spawn / starting position in km (from sol.json). */
export const STARTING_POSITION_KM = solSystem.startingPositionKm as [number, number, number];

/** Default spawn rotation as quaternion [x, y, z, w] (from sol.json). */
export const STARTING_ROTATION_QUAT = solSystem.startingRotationQuat as [number, number, number, number];


// ── Live ephemeris wiring ────────────────────────────────────────────────────

let _solvedJD = Number.NaN;

/**
 * Rewrite every body's `positionKm` IN PLACE for Julian Date `jdUTC`.
 *
 * ⚠⚠ **MUTATES THE ARRAYS INSIDE `sol.json` ITSELF, and that is the point.**
 * The first version of this wrote into private copies, which silently created
 * TWO sets of positions: body render configs (which reference the
 * `*_POSITION_KM` exports) went live, while everything reading
 * `systemConfigAtom` — POI markers, the dev warp resolver, ship collision —
 * kept the static originals. Symptoms on device: markers in the wrong place,
 * the ship crashing into nothing, and warps landing where planets used to be.
 *
 * 🔑 **The fix is to have ONE set of arrays, not to add a second updater.**
 * `celestialConstants` and `store/system.ts` import the same JSON module, so ES
 * module caching means they hold the same objects — writing here reaches every
 * consumer that holds a REFERENCE.
 *
 * ⚠ It does NOT reach a consumer that copied the NUMBERS out (e.g. into a flat
 * collider struct). Those must re-read per frame; grep for `positionKm[0]`.
 *
 * ⚠ IDEMPOTENT AND CACHED ON `jdUTC`: every `CelestialBody` calls this from its
 * own frame loop, so the first one does the work and the rest are a float
 * compare. That removes R3F callback ORDERING as a concern entirely.
 */
export function updateEphemerisPositions(jdUTC: number): void {
  if (jdUTC === _solvedJD) return;
  _solvedJD = jdUTC;
  const solved = solveSystem(bodies, jdUTC);
  for (const body of bodies) {
    const pos = solved.get(body.id);
    if (!pos || !body.positionKm) continue;
    body.positionKm[0] = pos[0];
    body.positionKm[1] = pos[1];
    body.positionKm[2] = pos[2];
  }
  updateAsteroidFieldAnchors();
  updateSpawnAnchor();
}

/**
 * Re-anchor every asteroid field to its `anchorBody`.
 *
 * ⚠ A field's `anchorKm` was an ABSOLUTE position, so the fields stayed put
 * while their planets moved — the belt near Earth ended up 380,000 km from it.
 * With `anchorBody` set, `anchorOffsetKm` is the (fixed) offset from that body
 * and `anchorKm` becomes the derived absolute position, rewritten in place here
 * so every existing `anchorKm` reader keeps working.
 */
function updateAsteroidFieldAnchors(): void {
  const fields = solSystem.asteroidFields as
    | { id: string; anchorKm: number[]; anchorBody?: string; anchorOffsetKm?: number[] }[]
    | undefined;
  if (!fields) return;
  for (const f of fields) {
    if (!f.anchorBody || !f.anchorOffsetKm) continue;
    const parent = bodies.find((b) => b.id === f.anchorBody);
    if (!parent) continue;
    f.anchorKm[0] = parent.positionKm[0] + f.anchorOffsetKm[0];
    f.anchorKm[1] = parent.positionKm[1] + f.anchorOffsetKm[1];
    f.anchorKm[2] = parent.positionKm[2] + f.anchorOffsetKm[2];
  }
}

/**
 * Re-anchor the spawn point to its `startingBody`.
 *
 * ⚠ Same defect the asteroid fields had: `startingPositionKm` was an ABSOLUTE
 * point authored next to Earth's static position, so once Earth started orbiting
 * the spawn (and the `belt` perf scenario, which uses this exact array) pointed
 * at empty space 1 AU from anything. `startingOffsetKm` is the fixed, authored
 * geometry — 16,746 km from Earth's centre, inside the origin belt — and the
 * absolute value is derived from it here, in place, so `STARTING_POSITION_KM`
 * and `solSystem.startingPositionKm` readers keep working.
 */
function updateSpawnAnchor(): void {
  const sys = solSystem as {
    startingPositionKm: number[];
    startingBody?: string;
    startingOffsetKm?: number[];
  };
  if (!sys.startingBody || !sys.startingOffsetKm) return;
  const parent = bodies.find((b) => b.id === sys.startingBody);
  if (!parent) return;
  sys.startingPositionKm[0] = parent.positionKm[0] + sys.startingOffsetKm[0];
  sys.startingPositionKm[1] = parent.positionKm[1] + sys.startingOffsetKm[1];
  sys.startingPositionKm[2] = parent.positionKm[2] + sys.startingOffsetKm[2];
}

/** The Julian Date the live positions currently represent. */
export const solvedEphemerisJD = (): number => _solvedJD;

/** Every body definition, for code that needs orbits or rotation. */
export const allBodyDefs = (): readonly CelestialBodyDef[] => bodies;

// ── Solve once at module load ────────────────────────────────────────────────
// ⚠⚠ WITHOUT THIS, EVERY POSITION IS THE AUTHORED STATIC ONE UNTIL THE FIRST
// `CelestialBody` FRAME LOOP RUNS. Anything that reads earlier — a `useMemo`
// building POI markers, the dev warp resolver, ship collider setup — captures
// launch-day coordinates and never recovers, which is exactly the class of bug
// this file's header warns about.
//
// 🔑 Not a violation of "nothing baked at module load": this establishes the
// INITIAL value of a live quantity, which `updateEphemerisPositions` then
// rewrites every frame. Baking would be computing it once and never again.
updateEphemerisPositions(jdFromUnixMs(DEFAULT_SIM_EPOCH_MS));
