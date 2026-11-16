/** Dev preference: live physics tuning edits and the collider-outline toggle persist in localStorage. */
import { DEFAULT_PHYSICS_TUNING, getPhysicsTuning, setPhysicsTuning, type PhysicsTuning } from "@/sim/physics/physicsTuning";
import { nearField } from "@/sim/physics/nearField";

const KEY = "dev-physics-tuning-v1";

/** Dev view switches (read per frame by PhysicsDebugView). */
export const physicsDebug = { outlines: false };

type Prefs = { tuning?: Partial<PhysicsTuning>; outlines?: boolean };

/** Push restitution/friction into the live engine world (new worlds read the table themselves). */
export function applyPhysicsMaterial(): void {
  const t = getPhysicsTuning();
  nearField.setMaterial(t.restitution, t.friction);
}

export function loadPhysicsPrefs(): void {
  if (process.env.NODE_ENV !== "development") return;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return;
    const p = JSON.parse(raw) as Prefs;
    if (p.tuning) setPhysicsTuning(p.tuning);
    physicsDebug.outlines = p.outlines === true;
    applyPhysicsMaterial();
  } catch {
    // Unreadable blob: defaults stay.
  }
}

export function savePhysicsPrefs(): void {
  try {
    const live = getPhysicsTuning();
    const tuning: Partial<PhysicsTuning> = {};
    for (const k of Object.keys(DEFAULT_PHYSICS_TUNING) as (keyof PhysicsTuning)[]) if (live[k] !== DEFAULT_PHYSICS_TUNING[k]) tuning[k] = live[k];
    if (Object.keys(tuning).length === 0 && !physicsDebug.outlines) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, JSON.stringify({ tuning, outlines: physicsDebug.outlines } satisfies Prefs));
  } catch {
    // Blocked storage: the live edit still applies for this session.
  }
}

export function physicsTuningJson(): string {
  return JSON.stringify(getPhysicsTuning(), null, 2);
}
