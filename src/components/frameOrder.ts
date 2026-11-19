/**
 * useFrame priorities that fix the per-frame order (R3F runs ascending; > 0 takes over
 * rendering): sim clock + ephemeris, then the player ship, then everything at 0.
 * The ship converts frame-relative → absolute with THIS frame's body positions.
 */
export const FRAME_PRIORITY_SIM_CLOCK = -2;
export const FRAME_PRIORITY_PLAYER_SHIP = -1;
/** Remote pilots' ships (co-op): after the player ship moved the origin, before POIs project them. */
export const FRAME_PRIORITY_REMOTE_SHIPS = -0.5;
