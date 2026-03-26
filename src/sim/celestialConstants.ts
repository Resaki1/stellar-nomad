// Shared positional constants for celestial bodies in the Sol system.
// Centralised here to avoid circular imports between component modules.

/** Sun position in km (system coordinates). */
export const STAR_POSITION_KM: [number, number, number] = [
  130_000_000, 0, 65_000_000,
];

/** Sun radius in km. */
export const STAR_RADIUS_KM = 696_340;

/** Earth position in km (system coordinates). */
export const PLANET_POSITION_KM: [number, number, number] = [
  5_000, 0, -15_000,
];

/** Earth radius in km. */
export const PLANET_RADIUS_KM = 6_371;

/** Luna radius in km (real: 1737). */
export const LUNA_RADIUS_KM = 1_737;

/** Luna position in km — 384,400 km from Earth along +X. */
export const LUNA_POSITION_KM: [number, number, number] = [
  PLANET_POSITION_KM[0] + -384_400,
  PLANET_POSITION_KM[1],
  PLANET_POSITION_KM[2],
];

/** Mars radius in km (real: 3390). */
export const MARS_RADIUS_KM = 3_390;

/** Mars position in km — ~228M km from the Sun, ~83M km from Earth. */
export const MARS_POSITION_KM: [number, number, number] = [
  -67_500_000, 0, -49_000_000,
];
