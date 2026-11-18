/**
 * B5: one rule for "the hull can be repaired", shared by the dashboard, the Workshop, the hotbar,
 * the repair request and the `ship.repair` reducer. Hull goes fractional (curve damage, heat), so
 * exact `< max` gates and rounded displays disagreed: 99.7 HP read "100 %" yet stayed repairable.
 */
export const HULL_INTACT_TOLERANCE_HP = 0.5;

export function hullRepairable(health: number, maxHealth: number): boolean {
  return health <= maxHealth - HULL_INTACT_TOLERANCE_HP;
}

/** Hull percent as shown: 100 exactly when not repairable, else floored (never 100, never 0 while alive). */
export function hullDisplayPct(health: number, maxHealth: number): number {
  if (maxHealth <= 0 || health <= 0) return 0;
  if (!hullRepairable(health, maxHealth)) return 100;
  return Math.max(1, Math.min(99, Math.floor((health / maxHealth) * 100)));
}
