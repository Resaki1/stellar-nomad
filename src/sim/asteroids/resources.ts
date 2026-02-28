import type {
  SystemConfig,
  AsteroidResourcesDef,
  AsteroidClassDef,
  ResourceTypeDef,
} from "@/sim/systemTypes";
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

// ---------------------------------------------------------------------------
// Asteroid class selection (deterministic)
// ---------------------------------------------------------------------------

/**
 * Deterministically pick an asteroid class for a given instance.
 */
function pickAsteroidClass(
  instanceId: number,
  fieldId: string,
  def: AsteroidResourcesDef
): AsteroidClassDef | null {
  const classes = def.classes ?? [];
  if (classes.length === 0) return null;

  const salt = normalizeSeed(def.seedSalt ?? `${fieldId}:class`);
  const r = hashToUnitFloat((instanceId >>> 0) ^ salt);

  let total = 0;
  for (const c of classes) if (c.weight > 0) total += c.weight;
  if (total <= 0) return classes[0];

  let t = r * total;
  for (const c of classes) {
    if (c.weight <= 0) continue;
    t -= c.weight;
    if (t <= 0) return c;
  }
  return classes[classes.length - 1];
}

// ---------------------------------------------------------------------------
// Per-instance resource composition
// ---------------------------------------------------------------------------

/**
 * Generate deterministic resource fractions for an asteroid instance.
 * Each resource in the class def gets a value rolled within [min, max],
 * then all values are normalised to sum to 1.
 * Returns array of { resourceId, fraction } with fraction > 0.
 */
function generateResourceFractions(
  instanceId: number,
  fieldId: string,
  classDef: AsteroidClassDef,
  seedSalt: number | string | undefined
): { resourceId: string; fraction: number }[] {
  const baseSalt = normalizeSeed(seedSalt ?? `${fieldId}:composition`);

  const raw: { resourceId: string; value: number }[] = [];
  let totalRaw = 0;

  for (let i = 0; i < classDef.resources.length; i++) {
    const range = classDef.resources[i];
    // Unique hash per resource slot
    const slotSalt = baseSalt ^ mix32(i * 0x45d9f3b + 0xa5a5a5a5);
    const r = hashToUnitFloat((instanceId >>> 0) ^ slotSalt);

    const value = range.min + r * (range.max - range.min);
    if (value > 1e-9) {
      raw.push({ resourceId: range.resourceId, value });
      totalRaw += value;
    }
  }

  if (raw.length === 0 || totalRaw <= 0) {
    // Fallback: first resource gets 100%
    if (classDef.resources.length > 0) {
      return [{ resourceId: classDef.resources[0].resourceId, fraction: 1 }];
    }
    return [];
  }

  // Normalise to sum = 1
  return raw.map(({ resourceId, value }) => ({
    resourceId,
    fraction: value / totalRaw,
  }));
}

// ---------------------------------------------------------------------------
// Total yield amount (same as before, radius-based)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ResourceRewardEntry = {
  resourceId: string;
  amount: number;
  resource?: ResourceTypeDef;
};

export type AsteroidMiningReward = {
  /** The spectral class that was assigned to this asteroid. */
  asteroidClass: AsteroidClassDef;
  /** Individual resource yields (only entries with amount > 0). */
  resources: ResourceRewardEntry[];
  /** Sum of all resource amounts. */
  totalAmount: number;
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

  const classDef = pickAsteroidClass(instanceId, fieldId, def);
  if (!classDef) return null;

  const totalAmount = computeYieldAmount(radiusM, instanceId, fieldId, def);
  if (totalAmount <= 0) return null;

  const fractions = generateResourceFractions(
    instanceId,
    fieldId,
    classDef,
    def.seedSalt
  );

  // Distribute total amount proportionally, rounding carefully
  const resources: ResourceRewardEntry[] = [];
  let distributed = 0;

  for (let i = 0; i < fractions.length; i++) {
    const { resourceId, fraction } = fractions[i];
    let amt: number;

    if (i === fractions.length - 1) {
      // Last entry gets the remainder to avoid rounding drift
      amt = totalAmount - distributed;
    } else {
      amt = Math.round(totalAmount * fraction);
    }

    if (amt <= 0) continue;
    distributed += amt;

    resources.push({
      resourceId,
      amount: amt,
      resource: system.resources?.types?.find((r) => r.id === resourceId),
    });
  }

  if (resources.length === 0) return null;

  return {
    asteroidClass: classDef,
    resources,
    totalAmount: resources.reduce((s, r) => s + r.amount, 0),
  };
}

/**
 * Return just the asteroid class for an instance (for HUD display).
 * Cheaper than computing the full reward.
 */
export function getAsteroidClass(
  system: SystemConfig,
  fieldId: string,
  instanceId: number
): AsteroidClassDef | null {
  const field = system.asteroidFields.find((f) => f.id === fieldId);
  const def = field?.resources;
  if (!def) return null;
  return pickAsteroidClass(instanceId, fieldId, def);
}

// ---------------------------------------------------------------------------
// Resource type lookups
// ---------------------------------------------------------------------------

export function getResourceTypes(system: SystemConfig): ResourceTypeDef[] {
  return system.resources?.types ?? [];
}

export function getResourceType(
  system: SystemConfig,
  resourceId: string
): ResourceTypeDef | undefined {
  return (system.resources?.types ?? []).find((t) => t.id === resourceId);
}

// ---------------------------------------------------------------------------
// Mining duration
// ---------------------------------------------------------------------------

export function computeMiningDurationS(radiusM: number): number {
  const r = Math.max(0, radiusM);
  const duration = 2.5 + Math.pow(r / 50, 0.8) * 3.0;
  return Math.min(18, Math.max(2.5, duration));
}
