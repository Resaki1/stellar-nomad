import { mineYield } from "@/sim/asteroids/mineResolve";
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

/**
 * The miner's request plus its local yield PREVIEW (deterministic yield × efficiency × difficulty).
 * The authority re-derives the yield with `makeMineResolver`; `beamS` is the executed beam time.
 */
export function buildMineOperation(
  system: SystemConfig,
  t: MineTarget,
  stats: MinerStats,
  opId: string,
  beamS?: number,
): Extract<WorldOperation, { type: "asteroid.mine" }> {
  return {
    type: "asteroid.mine",
    opId,
    fieldId: t.fieldId,
    chunkKey: t.chunkKey,
    instanceId: t.instanceId,
    yield: mineYield(system, t.fieldId, t.chunkKey, t.instanceId, t.radiusM, stats.miningEfficiencyMult, undefined),
    ...(beamS !== undefined ? { beamS } : {}),
  };
}
