import type { SystemConfig, AsteroidResourcesDef, ResourceTypeDef } from "@/sim/systemTypes";
import { normalizeSeed } from "@/sim/asteroids/seeding";

const U32_FLOAT = 4294967296; // 2^32

function mix32(n: number): number {
  n |= 0;
  n ^= n >>> 16;
  n = Math.imul(n, 0x7feb352d);
  n ^= n >>> 15;
  n = Math.imul(n, 0x846ca68b);
  n ^= n >>> 16;
  return n | 0;
}

function hashToUnitFloat(n: number): number {
  return (mix32(n) >>> 0) / U32_FLOAT; // [0,1)
}

function pickWeightedResourceId(
  instanceId: number,
  fieldId: string,
  def: AsteroidResourcesDef
): string | null {
  const dist = def.distribution ?? [];
  if (dist.length === 0) return null;

  const salt = normalizeSeed(def.seedSalt ?? `${fieldId}:resources`);
  const r = hashToUnitFloat((instanceId >>> 0) ^ salt);

  let total = 0;
  for (const e of dist) if (e.weight > 0) total += e.weight;
  if (total <= 0) return dist[0].resourceId;

  let t = r * total;
  for (const e of dist) {
    if (e.weight <= 0) continue;
    t -= e.weight;
    if (t <= 0) return e.resourceId;
  }
  return dist[dist.length - 1].resourceId;
}

function computeYieldAmount(
  radiusM: number,
  instanceId: number,
  fieldId: string,
  def: AsteroidResourcesDef
): number {
  const y = def.yield;
  const ref = Math.max(1e-6, y.referenceRadiusM);
  const base = y.baseAmount * Math.pow(Math.max(0, radiusM) / ref, y.exponent);

  const variance = Math.max(0, Math.min(1, y.variance ?? 0));
  let amount = base;

  if (variance > 0) {
    const salt = normalizeSeed(def.seedSalt ?? `${fieldId}:yield`);
    const r = hashToUnitFloat((instanceId >>> 0) ^ salt ^ 0x9e3779b9);
    const jitter = 1 + (r * 2 - 1) * variance;
    amount *= jitter;
  }

  let out = Math.round(amount);
  if (typeof y.minAmount === "number") out = Math.max(y.minAmount, out);
  if (typeof y.maxAmount === "number") out = Math.min(y.maxAmount, out);
  return out;
}

export type AsteroidMiningReward = {
  resourceId: string;
  amount: number;
  resource?: ResourceTypeDef;
};

export function getAsteroidMiningReward(
  system: SystemConfig,
  fieldId: string,
  instanceId: number,
  radiusM: number
): AsteroidMiningReward | null {
  const field = system.asteroidFields.find((f) => f.id === fieldId);
  const def = field?.resources;
  if (!def) return null;

  const resourceId = pickWeightedResourceId(instanceId, fieldId, def);
  if (!resourceId) return null;

  const amount = computeYieldAmount(radiusM, instanceId, fieldId, def);
  const resource = system.resources?.types?.find((r) => r.id === resourceId);

  return { resourceId, amount, resource };
}

// ---------------------------------------------------------------------------
// Resource type lookups
// ---------------------------------------------------------------------------

/**
 * Return the resource type definitions for the system.
 * Falls back to an empty array when no resources are defined.
 */
export function getResourceTypes(system: SystemConfig): ResourceTypeDef[] {
  return system.resources?.types ?? [];
}

/**
 * Return a single resource type definition by id, or undefined.
 */
export function getResourceType(
  system: SystemConfig,
  resourceId: string
): ResourceTypeDef | undefined {
  return (system.resources?.types ?? []).find((t) => t.id === resourceId);
}

// ---------------------------------------------------------------------------
// Mining duration
// ---------------------------------------------------------------------------

/**
 * Mining duration scaling based on asteroid radius.
 *
 * Small rocks: ~3 s
 * Medium rocks: ~6–9 s
 * Large rocks: capped at ~18 s
 */
export function computeMiningDurationS(radiusM: number): number {
  const r = Math.max(0, radiusM);
  const duration = 2.5 + Math.pow(r / 50, 0.8) * 3.0;
  return Math.min(18, Math.max(2.5, duration));
}
