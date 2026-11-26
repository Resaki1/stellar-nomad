/**
 * Durable ship-resource tuning defaults (M3.0). Stored now so PR 1 needs one migration;
 * the gameplay that consumes them (M3.2) owns the values.
 */

/** Ordinary propellant tank, kg. Migrated saves start full. */
export const PROPELLANT_TANK_KG = 600;
/**
 * A new world's ordinary propellant, kg: a full tank (FIRST_EXPEDITION_PLAN, playtest 2026-11). New pilots
 * ran dry while still learning the controls. The lunar trip is gated by the drive's research and cost, no
 * longer by a forced processing batch. Revisit (≈90%) once WP3's guided first rock shows the tank rising.
 */
export const START_PROPELLANT_KG = PROPELLANT_TANK_KG;
/** Protected recovery allowance, kg: never salvaged, transferred or dropped at a wreck. */
export const RECOVERY_ALLOWANCE_KG = 60;
/** Sanitiser bound for any stored fuel amount, kg. */
export const MAX_STORED_FUEL_KG = 1e6;

/** Default thermal shutdown limit, as a multiple of nominal heat capacity. */
export const MAX_HEAT_FRACTION = 1.3;
