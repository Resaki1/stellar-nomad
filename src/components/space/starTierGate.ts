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

/**
 * Floor on the movement budget, as a fraction of the nearest candidate's distance.
 *
 * ⚠ A FLOOR, not the rule — `safeMoveDistance` below is the rule. This was the whole
 * budget in the first version, and it has a cliff: it shrinks LINEARLY with the
 * distance to the nearest star, so it stops helping exactly when the player is
 * manoeuvring close in. MEASURED on device near Gl 244B: nearest star 1.496e5 km ⇒
 * budget **1,496 km**. At 0.5 ly/s that is 2.6e7 frames' worth of budget consumed per
 * frame — i.e. an 8,848-candidate re-rank every frame. The reported skip rate of
 * 0.9983 was only high because the ship was parked.
 *
 * It survives as the floor because `safeMoveDistance` correctly returns ~0 for a near
 * tie (α Cen A/B), and a zero budget would thrash. Hysteresis stops a near tie from
 * actually flapping, so re-ranking it at this cadence is enough.
 */
export const RESELECT_FRACTION = 0.01;

/**
 * How far the ship can move before the pool's ORDERING could change — the real rule.
 *
 * 🔑 THE FIRST VERSION APPROXIMATED THE WRONG QUANTITY. The gate exists to skip work
 * when the answer cannot change, and the answer changes when the weakest pool member's
 * selector crosses the best challenger's. That is a question about the MARGIN between
 * them, not about how far away the nearest star happens to be.
 *
 * ⚠⚠ THE FIRST VERSION SCALED `u` BY `min(dW, dC)` AND THAT WAS **UNSOUND**, not
 * merely loose. It bounded only how fast the CURRENT best challenger can gain on the
 * weakest member — but *any* non-member can gain, and the one that constrains you is
 * the **nearest candidate of all**, because `δ/d_j` is largest for the smallest `d_j`.
 * MEASURED on device: the disc pool reported a budget of **164.7 ly**, i.e. it could
 * not re-rank across an entire interstellar journey. That is what made a marker appear
 * with no star under it and no collider — the marker tier had re-selected and the disc
 * tier had not.
 *
 * Derivation, for a selector `s ∝ d^−k` (k = 1 for the disc tier's `R/d`, k = 2 for
 * the light tier's `L/d²`). Let `u = δ / d_nearest`, where `d_nearest` is the nearest
 * candidate over the WHOLE list. Then for every candidate j, `δ/d_j ≤ u`, so `s_j`
 * grows by at most `(1/(1−u))^k` while the weakest member `sW` shrinks by at most
 * `(1/(1+u))^k`. With dominance `ρ = sW/sC` over the best current challenger:
 *
 *     ρ' ≥ ρ · ( (1−u)/(1+u) )^k        safe while ρ' ≥ margin
 *     q = (margin/ρ)^(1/k)              δ_safe = d_nearest · (1−q)/(1+q)
 *
 * 🔑 Using the GLOBAL nearest is what makes it sound: the same `u` then bounds every
 * non-member's gain, not just the current runner-up's, so the current best challenger
 * stays the binding one. Comparing only the weakest MEMBER is still sufficient,
 * because a stronger member would have to fall below it first.
 *
 * Properties:
 *  • **ρ ≫ 1 ⇒ δ → d_nearest** — you can move almost all the way to the nearest
 *    candidate, which is the intuitive ceiling: moving past a star changes everything.
 *    MEASURED at the Gl 244B pose (ρ ~3e4): 1e-3 AU against the floor's 1e-5, i.e.
 *    **100×**, not the 800,000× the unsound version claimed.
 *  • **ρ → margin ⇒ δ → 0**, correct for a near tie, and the floor catches it.
 *    MEASURED near Earth (Antares vs Betelgeuse vs Aldebaran, ρ = 1.11): 7,606 AU
 *    against the floor's 2,675 — a modest 2.8×, which is what a near-tie should give.
 *  • Still deliberately CONSERVATIVE: it assumes the worst geometry for every
 *    candidate at once. A tighter bound needs the actual directions and is not worth
 *    it — the failure mode of being too loose is invisible and severe, as this was.
 */
export function safeMoveDistance(
  dominance: number,
  nearestDistKm: number,
  exponent: number,
  margin: number,
): number {
  if (!(dominance > margin) || !(nearestDistKm > 0)) return 0;
  const q = Math.pow(margin / dominance, 1 / exponent);
  const u = (1 - q) / (1 + q);
  return nearestDistKm * u;
}

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
 * ranking flips first. Using the nearest bounds the floor's worst case.
 *
 * `safeDistKm` is `safeMoveDistance`'s answer, or 0 when the caller has no margin to
 * offer (an unfilled pool, or the very first selection). The larger of the two wins.
 */
export function tierSelected(
  g: TierGate,
  x: number,
  y: number,
  z: number,
  nearestDistKm: number,
  safeDistKm = 0,
): void {
  g.x = x;
  g.y = y;
  g.z = z;
  const budget = Math.max(
    RESELECT_FRACTION * Math.max(nearestDistKm, 1),
    safeDistKm,
  );
  g.budgetSq = budget * budget;
  g.runs++;
}
