/**
 * The authority's mine resolver: the rock a command addresses (headless generator, no render
 * state) and its yield from the PLAYER'S persisted loadout and the world's EXPLICIT difficulty.
 * Solo and host call the same function, so their grants agree by construction.
 */
import type { Difficulty, PlayerState } from "@/save/types";
import { resolveHeadlessRock } from "@/sim/asteroids/headlessChunks";
import { computeMiningDurationS, getAsteroidMiningReward, type ResourceRewardEntry } from "@/sim/asteroids/resources";
import { difficultyMults } from "@/sim/difficulty";
import { persistentShipConfig } from "@/sim/ship/loadout";
import type { SystemConfig } from "@/sim/systemTypes";

export interface ResolvedMine {
  yield: Record<string, number>;
  radiusM: number;
  /** Frame the position is relative to: the field's anchor body (or "system"). */
  frameId: string;
  positionKm: [number, number, number];
  /** Beam seconds this player needs (radius duration / their speed mult). */
  requiredBeamS: number;
}

export type MineResolver = (fieldId: string, chunkKey: string, instanceId: number, player: PlayerState) => ResolvedMine | null;

export function scaleRockYield(resources: readonly ResourceRewardEntry[], efficiencyMult: number, difficulty?: Difficulty): Record<string, number> {
  const mult = efficiencyMult * difficultyMults(difficulty).yield;
  const out: Record<string, number> = {};
  for (const r of resources) {
    out[r.resourceId] = (out[r.resourceId] ?? 0) + Math.max(1, Math.round(r.amount * mult));
  }
  return out;
}

/** Deterministic yield units, rounded exactly as the client's preview (`buildMineOperation`). */
export function mineYield(
  system: SystemConfig,
  fieldId: string,
  chunkKey: string,
  instanceId: number,
  radiusM: number,
  efficiencyMult: number,
  difficulty: Difficulty | undefined,
): Record<string, number> {
  const reward = getAsteroidMiningReward(system, fieldId, instanceId, radiusM, chunkKey);
  return scaleRockYield(reward?.resources ?? [], efficiencyMult, difficulty);
}

export function makeMineResolver(getSystem: () => SystemConfig, getDifficulty: () => Difficulty): MineResolver {
  return (fieldId, chunkKey, instanceId, player) => {
    const rock = resolveHeadlessRock(fieldId, chunkKey, instanceId);
    if (!rock) return null;
    const system = getSystem();
    const field = system.asteroidFields?.find((f) => f.id === fieldId);
    const cfg = persistentShipConfig(player);
    const off = field?.anchorBody ? (field.anchorOffsetKm ?? [0, 0, 0]) : (field?.anchorKm ?? [0, 0, 0]);
    return {
      yield: mineYield(system, fieldId, chunkKey, instanceId, rock.radiusM, cfg.miningEfficiencyMult, getDifficulty()),
      radiusM: rock.radiusM,
      frameId: field?.anchorBody ?? "system",
      positionKm: [off[0] + rock.localKm[0], off[1] + rock.localKm[1], off[2] + rock.localKm[2]],
      requiredBeamS: computeMiningDurationS(rock.radiusM) / Math.max(1e-6, cfg.miningSpeedMult),
    };
  };
}
