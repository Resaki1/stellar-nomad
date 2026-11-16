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
}

/** The miner's reward claim for one rock: deterministic yield × efficiency. The authority bounds it by cargo. */
export function buildMineOperation(
  system: SystemConfig,
  t: MineTarget,
  stats: MinerStats,
  opId: string,
): Extract<WorldOperation, { type: "asteroid.mine" }> {
  const reward = getAsteroidMiningReward(system, t.fieldId, t.instanceId, t.radiusM);
  const yieldUnits: Record<string, number> = {};
  for (const r of reward?.resources ?? []) {
    yieldUnits[r.resourceId] = (yieldUnits[r.resourceId] ?? 0) + Math.max(1, Math.round(r.amount * stats.miningEfficiencyMult));
  }
  return {
    type: "asteroid.mine",
    opId,
    fieldId: t.fieldId,
    chunkKey: t.chunkKey,
    instanceId: t.instanceId,
    yield: yieldUnits,
  };
}
