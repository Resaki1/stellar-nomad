import { atom } from "jotai";

/**
 * Dev-only overrides consumed by the Spaceship component.
 * These atoms are only written to from the Dev settings panel
 * (which is hidden in production builds).
 */

/**
 * One-shot teleport: when non-null, Spaceship will jump to this position (km)
 * and clear the atom.
 */
export const devTeleportAtom = atom<[number, number, number] | null>(null);

/**
 * Max speed override in m/s. When non-null, replaces SHIP_MAX_SPEED_KMPS.
 * null = use default (400 m/s).
 */
export const devMaxSpeedOverrideAtom = atom<number | null>(null);
