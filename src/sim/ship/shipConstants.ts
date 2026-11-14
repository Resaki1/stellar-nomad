/** Ship flight-model tuning. Pure data: no engine imports. */
export const SHIP_HANDLING = 1.5;
export const MAX_ROT_SPEED = SHIP_HANDLING / 2;
export const SHIP_MAX_SPEED_KMPS = 400 / 1000;

/** Fixed sim step; rendering interpolates between the two latest states. */
export const FIXED_DT = 1 / 120;
/** Frame-delta cap: prevents spiral-of-death after tab-away. */
export const MAX_FRAME_DT = 0.25;

/** Hull radius for swept celestial collision; tiny so surface-buzzing still works. */
export const SHIP_HULL_RADIUS_KM = 0.05;
