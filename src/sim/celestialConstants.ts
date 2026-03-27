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
const earth = findBody("earth");
const luna = findBody("luna");
const mars = findBody("mars");
const jupiter = findBody("jupiter");
const io = findBody("io");
const ganymede = findBody("ganymede");

/** Sun position in km (system coordinates). */
export const STAR_POSITION_KM = sol.positionKm as [number, number, number];
/** Sun radius in km. */
export const STAR_RADIUS_KM = sol.radiusKm;

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

/** Jupiter position in km. */
export const JUPITER_POSITION_KM = jupiter.positionKm as [number, number, number];
/** Jupiter radius in km. */
export const JUPITER_RADIUS_KM = jupiter.radiusKm;

/** Io position in km. */
export const IO_POSITION_KM = io.positionKm as [number, number, number];
/** Io radius in km. */
export const IO_RADIUS_KM = io.radiusKm;

/** Ganymede position in km. */
export const GANYMEDE_POSITION_KM = ganymede.positionKm as [number, number, number];
/** Ganymede radius in km. */
export const GANYMEDE_RADIUS_KM = ganymede.radiusKm;
