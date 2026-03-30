// Shared positional constants for celestial bodies in the Sol system.
// Derived from sol.json (single source of truth) to avoid circular imports
// between component modules.

import solSystem from "@/sim/systems/sol.json";
import type { CelestialBodyDef } from "@/sim/systemTypes";

const bodies = solSystem.celestialBodies as CelestialBodyDef[];

function findBody(id: string): CelestialBodyDef {
  const body = bodies.find((b) => b.id === id);
  if (!body) throw new Error(`[celestialConstants] body "${id}" not found in sol.json`);
  return body;
}

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
