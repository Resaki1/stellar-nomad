/** Near-field physics tuning (docs/PHYSICS_PLAN.md §7.2–7.3). Defaults plus a live copy the dev panel edits. */
export interface PhysicsTuning {
  /** Impact Δv along the normal below which a hit does no damage. */
  noDamageSpeedMps: number;
  /** Impact Δv that removes 100 % of max hull. */
  lethalSpeedMps: number;
  damageExponent: number;
  restitution: number;
  friction: number;
  /** Asteroid colliders exist within this distance of the ship (surface, not centre). */
  physicsRadiusKm: number;
  colliderCap: number;
  /** Collider creation budget per rendered frame; anything within `colliderMustCreateKm` ignores it. */
  colliderBudgetMs: number;
  colliderMustCreateKm: number;
  /** Over-budget creations allowed in one frame (nearest first). */
  colliderMustCreateMaxPerFrame: number;
  /** Contacts within this time of an impact's first step belong to that impact. */
  impactWindowS: number;
  /** A contact gap this long ends an episode; within one, a re-contact charges only what beats its peak. */
  impactEpisodeGapS: number;
  /** A contact episode below this Δv is resting or sliding: no impact, no feedback. */
  impactMinSpeedMps: number;
}

export const DEFAULT_PHYSICS_TUNING: Readonly<PhysicsTuning> = Object.freeze({
  noDamageSpeedMps: 8,
  lethalSpeedMps: 120,
  damageExponent: 2,
  restitution: 0.2,
  friction: 0.5,
  physicsRadiusKm: 3,
  colliderCap: 1500,
  colliderBudgetMs: 1.5,
  colliderMustCreateKm: 0.5,
  colliderMustCreateMaxPerFrame: 4,
  impactWindowS: 0.05,
  impactEpisodeGapS: 0.5,
  impactMinSpeedMps: 3,
});

const live: PhysicsTuning = { ...DEFAULT_PHYSICS_TUNING };

/** The live table. Read it where used; never cache fields across frames. */
export function getPhysicsTuning(): Readonly<PhysicsTuning> {
  return live;
}

const MIN: Partial<Record<keyof PhysicsTuning, number>> = {
  lethalSpeedMps: 1e-3,
  damageExponent: 1e-3,
  physicsRadiusKm: 0.05,
  colliderCap: 0,
  impactWindowS: 0,
};
const MAX: Partial<Record<keyof PhysicsTuning, number>> = { restitution: 1, physicsRadiusKm: 20 };

/** Patch the live table; non-finite values and unknown keys are ignored, values clamped to their range. */
export function setPhysicsTuning(patch: Partial<PhysicsTuning>): void {
  for (const key of Object.keys(patch) as (keyof PhysicsTuning)[]) {
    const v = patch[key];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_PHYSICS_TUNING, key)) continue;
    let x = Math.max(MIN[key] ?? 0, v);
    if (MAX[key] !== undefined) x = Math.min(MAX[key], x);
    live[key] = key === "colliderCap" || key === "colliderMustCreateMaxPerFrame" ? Math.round(x) : x;
  }
  // The curve divides by (lethal − noDamage).
  if (live.lethalSpeedMps <= live.noDamageSpeedMps) live.lethalSpeedMps = live.noDamageSpeedMps + 1e-3;
}

export function resetPhysicsTuning(): void {
  Object.assign(live, DEFAULT_PHYSICS_TUNING);
}
