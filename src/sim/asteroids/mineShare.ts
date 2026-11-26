/**
 * One finite rock yield split by contribution (FIRST_EXPEDITION_PLAN WP5 design §3). Pure:
 * the co-op host supplies the contributions from its beam ledger, the reducer applies the split.
 */
import type { PlayerId } from "@/save/types";

/** Contributors below this fraction of the rock earn nothing. */
export const MIN_SHARE_FRACTION = 0.05;

export interface MineContribution {
  playerId: PlayerId;
  /** Work done, as a fraction of the rock at this pilot's own mining speed. */
  fraction: number;
  efficiencyMult: number;
}

/** The whole yield and each pilot's exact share of it (shares sum to the whole per material). */
export interface MineSplit {
  whole: Record<string, number>;
  shares: Record<PlayerId, Record<string, number>>;
}

/** Contributors who earn a share, ordered by pilot id (the tie-break order). */
export function eligibleContributions(list: readonly MineContribution[]): MineContribution[] {
  return list.filter(c => Number.isFinite(c.fraction) && c.fraction >= MIN_SHARE_FRACTION)
    .sort((a, b) => (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0));
}

/** Mining efficiency weighted by contribution: the whole is the rock's yield at this multiplier. */
export function weightedEfficiency(list: readonly MineContribution[]): number {
  let w = 0, e = 0;
  for (const c of list) { w += c.fraction; e += c.fraction * c.efficiencyMult; }
  return w > 0 ? e / w : 1;
}

/** Largest remainder per material (ties by pilot id): integer shares that sum exactly to `whole`. */
export function splitYield(whole: Readonly<Record<string, number>>, list: readonly MineContribution[]): MineSplit["shares"] {
  const pilots = eligibleContributions(list);
  const shares: MineSplit["shares"] = {};
  for (const c of pilots) shares[c.playerId] = {};
  const total = pilots.reduce((a, c) => a + c.fraction, 0);
  if (!(total > 0)) return shares;
  for (const k of Object.keys(whole)) {
    const units = whole[k];
    if (!(units > 0)) continue;
    const parts = pilots.map((c, i) => {
      const exact = (units * c.fraction) / total;
      const base = Math.floor(exact);
      return { i, base, rest: exact - base };
    });
    let left = units - parts.reduce((a, p) => a + p.base, 0);
    // Stable sort keeps pilot-id order among equal remainders.
    for (const p of [...parts].sort((a, b) => b.rest - a.rest)) {
      if (left <= 0) break;
      p.base++;
      left--;
    }
    for (const p of parts) if (p.base > 0) shares[pilots[p.i].playerId][k] = p.base;
  }
  return shares;
}
