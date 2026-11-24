/**
 * Gameplay content fingerprint: two builds may share a world only if they generate the same rocks
 * and apply the same rules. Hashes the canonical gameplay tables (fields, resources, items,
 * research, recipes, sites, trials), never render settings.
 */
import { ITEMS, PROCESSING_RECIPES, RESEARCH_NODES, SITES, TRIALS } from "@/data/content";
import { DEPOT_RECIPES, INDUSTRY_TUNING, POINT_TANK_CAPACITY_KG, POINT_TANK_RECIPE } from "@/sim/industry/catalog";
import { SCHEMA_VERSION } from "@/save/defaults";
import type { SystemConfig } from "@/sim/systemTypes";
import { PROTOCOL_VERSION } from "./protocol";

/** Bump when `generateAsteroidChunk` or the reward model changes output for the same inputs. */
export const GENERATOR_VERSION = 1;

/** Stable JSON: object keys sorted, so authoring order never changes the hash. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** Two independent 32-bit FNV-1a lanes → 16 hex chars. Not cryptographic; detects mismatched builds. */
function hash64(s: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

/** Field gameplay inputs only; `anchorKm` is ephemeris-derived at runtime and excluded. */
function fieldInputs(system: SystemConfig): unknown {
  return (system.asteroidFields ?? []).map((f) => {
    const rest: Record<string, unknown> = { ...f };
    delete rest.anchorKm;
    delete rest.render;
    delete rest.marker;
    return rest;
  });
}

export function contentFingerprint(system: SystemConfig): string {
  const s = system as unknown as Record<string, unknown>;
  return hash64(
    canonical({
      protocol: PROTOCOL_VERSION,
      schema: SCHEMA_VERSION,
      generator: GENERATOR_VERSION,
      system: s.systemId ?? null,
      defaults: s.defaults ?? null,
      fields: fieldInputs(system),
      resources: s.resources ?? null,
      items: ITEMS,
      research: RESEARCH_NODES,
      recipes: PROCESSING_RECIPES,
      sites: SITES,
      trials: TRIALS,
      industry: { recipes: DEPOT_RECIPES, tuning: INDUSTRY_TUNING, pointTank: { capacityKg: POINT_TANK_CAPACITY_KG, recipe: POINT_TANK_RECIPE } },
    }),
  );
}
