import { getAsteroidMiningReward } from "@/sim/asteroids/resources";
import type { SystemConfig } from "@/sim/systemTypes";
import type { WorldOperation } from "@/sim/world/commands";

export interface MineTarget {
  fieldId: string;
  chunkKey: string;
  instanceId: number;
  radiusM: number;
}

export interface MinerStats {
  miningEfficiencyMult: number;
  assaySampleBonusChance: number;
  minedLifetime: number;
}

/**
 * The miner's reward claim for one rock: deterministic yield × efficiency, plus assay samples
 * by size (first-ever rock: exactly 1). The authority bounds it by cargo capacity.
 */
export function buildMineOperation(
  system: SystemConfig,
  t: MineTarget,
  stats: MinerStats,
  opId: string,
  random: () => number = Math.random,
): Extract<WorldOperation, { type: "asteroid.mine" }> {
  const reward = getAsteroidMiningReward(system, t.fieldId, t.instanceId, t.radiusM);
  const yieldUnits: Record<string, number> = {};
  for (const r of reward?.resources ?? []) {
    yieldUnits[r.resourceId] = (yieldUnits[r.resourceId] ?? 0) + Math.max(1, Math.round(r.amount * stats.miningEfficiencyMult));
  }
  let assay = 1;
  if (stats.minedLifetime > 0) {
    const field = system.asteroidFields?.find((f) => f.id === t.fieldId);
    const minR = field?.size?.minRadiusM ?? 8;
    const maxR = field?.size?.maxRadiusM ?? 1024;
    const s = maxR > minR ? Math.max(0, Math.min(1, (t.radiusM - minR) / (maxR - minR))) : 0;
    // Piecewise-linear: 0→1, 0.35→2, 0.70→4, 1→6.
    const y = s <= 0.35 ? 1 + (s / 0.35) : s <= 0.7 ? 2 + ((s - 0.35) / 0.35) * 2 : 4 + ((s - 0.7) / 0.3) * 2;
    assay = Math.max(1, Math.round(y));
    if (stats.assaySampleBonusChance > 0 && random() < stats.assaySampleBonusChance) assay += 1;
  }
  return {
    type: "asteroid.mine",
    opId,
    fieldId: t.fieldId,
    chunkKey: t.chunkKey,
    instanceId: t.instanceId,
    yield: yieldUnits,
    assaySamples: assay,
  };
}
