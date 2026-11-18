import { isFrameId, SYSTEM_FRAME_ID } from "@/sim/frames";
import type { Vec3Tuple } from "@/save/types";
import { getAsteroidMiningReward } from "@/sim/asteroids/resources";
import type { SystemConfig } from "@/sim/systemTypes";
import type { WorldOperation } from "@/sim/world/commands";

export interface InspectTarget {
  fieldId: string;
  chunkKey: string;
  instanceId: number;
  radiusM: number;
  /** Chunk origin (field-relative km) and the rock's position in the chunk, m. */
  chunkOriginKm: readonly number[];
  localM: readonly number[];
}

/**
 * The scanner's close-inspection claim: class and estimated yield from the same deterministic
 * generator mining uses, and the rock's pose in its field's anchor frame. null if not mineable.
 */
export function buildInspectOperation(system: SystemConfig, t: InspectTarget, opId: string): Extract<WorldOperation, { type: "survey.inspect" }> | null {
  const field = (system.asteroidFields ?? []).find((f) => f.id === t.fieldId);
  const reward = getAsteroidMiningReward(system, t.fieldId, t.instanceId, t.radiusM, t.chunkKey);
  if (!field || !reward) return null;
  const anchored = !!field.anchorBody && !!field.anchorOffsetKm && isFrameId(field.anchorBody);
  const base = anchored && field.anchorOffsetKm ? field.anchorOffsetKm : field.anchorKm;
  const positionKm: Vec3Tuple = [
    base[0] + t.chunkOriginKm[0] + t.localM[0] / 1000,
    base[1] + t.chunkOriginKm[1] + t.localM[1] / 1000,
    base[2] + t.chunkOriginKm[2] + t.localM[2] / 1000,
  ];
  const composition: Record<string, number> = {};
  for (const r of reward.resources) composition[r.resourceId] = (composition[r.resourceId] ?? 0) + r.amount;
  return {
    type: "survey.inspect",
    opId,
    fieldId: t.fieldId,
    chunkKey: t.chunkKey,
    instanceId: t.instanceId >>> 0,
    classId: reward.asteroidClass.id,
    radiusM: t.radiusM,
    frameId: anchored && field.anchorBody ? field.anchorBody : SYSTEM_FRAME_ID,
    positionKm,
    composition,
  };
}
