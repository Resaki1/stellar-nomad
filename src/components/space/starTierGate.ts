/**
 * WHEN A STAR TIER NEEDS RE-SELECTING — the movement gate.
 *
 * See [`docs/STAR_RENDERING_PLAN.md`](../../../docs/STAR_RENDERING_PLAN.md) §18.
 *
 * ── THE OBSERVATION THAT MOTIVATES THIS ─────────────────────────────────────
 * The author's, and it is correct: *"during normal gameplay everything will stay
 * pretty much the same for >99% of the gameplay — players start in our solar system
 * and will need many hours before they can leave."* Both star tiers were ranking all
 * 166 nearby stars every frame to answer a question whose answer changes on the scale
 * of hours.
 *
 * ── 🔑 THE GATE IS DERIVED, AND IT IS THE SAME IDEA AS THE SKY-CUBE THRESHOLD ─
 * Both tiers select on a quantity that depends on the ship's position only through
 * `d`, the distance to a star:
 *
 *     disc  ← R/d          changes by ~1 part in 100 when the ship moves d/100
 *     light ← L/d²         changes by ~2 parts in 100 for the same move
 *
 * So a re-selection can only change the answer once the ship has moved a fixed
 * FRACTION of the distance to the nearest candidate. Anchor the position at each
 * selection, store `RESELECT_FRACTION × d_nearest`, and skip the ranking until the
 * ship leaves that ball.
 *
 * MEASURED consequences, which is the whole point:
 *
 *     pose                       d_nearest    threshold      re-ranks after
 *     anywhere in the solar sys   4.23 ly      0.042 ly        2,673 AU of travel
 *     8,784 AU from α Cen A       0.139 ly     1.4e-3 ly         88 AU
 *     100 AU from α Cen A         100 AU       1 AU               1 AU
 *
 * ⇒ In the solar system the pools re-rank essentially never (a player would have to
 * cross 2,673 AU), and near a star they re-rank often — which is exactly when the
 * answer can actually change. One derivation covers both regimes with no mode switch.
 *
 * ⚠ 1% is SAFE AGAINST THE HYSTERESIS, and that is why it can be this loose: the disc
 * pool needs a 5% margin to swap (`SWAP_MARGIN = 1.05`) and the light pool a 4× band,
 * so a ≤2% drift in the selector cannot flip a decision either of them has already
 * made. The gate is strictly finer than the thing it gates.
 *
 * ⚠⚠ IT GATES SELECTION ONLY, NEVER THE PER-FRAME WRITES. A held star's direction and
 * illuminance change continuously as the ship moves, so `StarLights` must still write
 * its slots' direction and intensity every frame — that is O(slots), allocation-free,
 * and nothing like the O(166) ranking. Gating those too would be the bug this file
 * looks like it might introduce: a light frozen at the position it was selected from.
 */

/** Fraction of the nearest candidate's distance the ship may move before re-ranking. */
export const RESELECT_FRACTION = 0.01;

export type TierGate = {
  x: number;
  y: number;
  z: number;
  /** Squared movement budget, km². 0 = never selected, so the first call runs. */
  budgetSq: number;
  /** Selections actually run, for `__lum.starTiers()`. */
  runs: number;
  /** Frames the gate has skipped a ranking. */
  skipped: number;
};

export const makeTierGate = (): TierGate => ({
  x: 0,
  y: 0,
  z: 0,
  budgetSq: 0,
  runs: 0,
  skipped: 0,
});

/**
 * Has the ship left the ball this tier was last selected in? Increments the
 * bookkeeping either way, so the gate's own hit rate is measurable.
 */
export function tierNeedsReselect(
  g: TierGate,
  x: number,
  y: number,
  z: number,
): boolean {
  if (g.budgetSq <= 0) return true;
  const dx = x - g.x;
  const dy = y - g.y;
  const dz = z - g.z;
  if (dx * dx + dy * dy + dz * dz > g.budgetSq) return true;
  g.skipped++;
  return false;
}

/**
 * Record a selection at this position, with the budget derived from the nearest
 * candidate's distance.
 *
 * ⚠ `nearestDistKm` must be the NEAREST candidate, not the winner: the winner is
 * chosen on `R/d` or `L/d²`, so a nearer but smaller star can still be the one whose
 * ranking flips first. Using the nearest bounds the worst case.
 */
export function tierSelected(
  g: TierGate,
  x: number,
  y: number,
  z: number,
  nearestDistKm: number,
): void {
  g.x = x;
  g.y = y;
  g.z = z;
  const budget = RESELECT_FRACTION * Math.max(nearestDistKm, 1);
  g.budgetSq = budget * budget;
  g.runs++;
}
