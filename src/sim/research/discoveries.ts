/**
 * Durable findings (M3.3): pure planners the reducers call during validation. Each returns
 * the next DiscoveryState (copies) or null when nothing new would be recorded.
 */
import { FAMILY_MIN_SHARE } from "@/data/content";
import { MAX_SOURCES } from "@/save/defaults";
import type { DiscoveryState, FamilyFinding, PlayerId, SourceFinding } from "@/save/types";

export const sourceIdOf = (fieldId: string, chunkKey: string, asteroidId: number): string => `${fieldId}:${chunkKey}:${asteroidId >>> 0}`;

/** Materials making up at least FAMILY_MIN_SHARE of `units` (sorted by id for determinism). */
export function familiesIn(units: Readonly<Record<string, number>>): string[] {
  let total = 0;
  for (const k in units) total += Math.max(0, units[k]);
  if (total <= 0) return [];
  return Object.keys(units).filter((k) => units[k] > 0 && units[k] / total >= FAMILY_MIN_SHARE).sort();
}

export interface InspectionPlan {
  next: DiscoveryState;
  newSource: boolean;
  newFamilies: string[];
  /** Families already known that this inspection confirmed for the first time. */
  upgraded: string[];
  evicted: string | null;
}

/**
 * Record an inspected rock: one source record, and every family ≥ the share threshold.
 * null when the source is already recorded (a repeat records nothing).
 */
export function planInspection(
  d: Readonly<DiscoveryState>,
  src: Omit<SourceFinding, "depleted" | "foundAt" | "by" | "id">,
  depleted: boolean,
  by: PlayerId,
  now: number,
  protectedIds: ReadonlySet<string>,
): InspectionPlan | null {
  const id = sourceIdOf(src.fieldId, src.chunkKey, src.asteroidId);
  if (d.sources.some((s) => s.id === id)) return null;
  // Field order as the sanitiser writes it, so a reload is byte-identical.
  const record: SourceFinding = {
    id, fieldId: src.fieldId, chunkKey: src.chunkKey, asteroidId: src.asteroidId, classId: src.classId, frameId: src.frameId,
    positionKm: src.positionKm, radiusM: src.radiusM, composition: src.composition, depleted, foundAt: now, by,
  };
  let sources = [...d.sources, record];
  let evicted: string | null = null;
  if (sources.length > MAX_SOURCES) {
    // Oldest unbookmarked depleted, then oldest unbookmarked, then oldest depleted.
    let i = sources.findIndex((s) => s.depleted && !protectedIds.has(s.id) && s.id !== id);
    if (i < 0) i = sources.findIndex((s) => !protectedIds.has(s.id) && s.id !== id);
    if (i < 0) i = sources.findIndex((s) => s.depleted && s.id !== id);
    if (i < 0) i = 0;
    evicted = sources[i].id;
    sources = sources.filter((_, k) => k !== i);
  }
  const families: Record<string, FamilyFinding> = { ...d.families };
  const newFamilies: string[] = [];
  const upgraded: string[] = [];
  for (const m of familiesIn(src.composition)) {
    const f = families[m];
    if (!f) {
      families[m] = { firstAt: now, by, inspected: true, extracted: false, sourceId: id };
      newFamilies.push(m);
    } else if (!f.inspected) {
      families[m] = { ...f, inspected: true, sourceId: f.sourceId ?? id };
      upgraded.push(m);
    }
  }
  return { next: { ...d, families, sources }, newSource: true, newFamilies, upgraded, evicted };
}

export interface ExtractionPlan {
  next: DiscoveryState;
  newFamilies: string[];
  depletedSource: string | null;
}

/** A destroyed rock: mark its source depleted (finding kept); a mined yield confirms families. */
export function planExtraction(
  d: Readonly<DiscoveryState>,
  sourceId: string,
  yieldUnits: Readonly<Record<string, number>> | null,
  by: PlayerId,
  now: number,
): ExtractionPlan | null {
  let families = d.families;
  const newFamilies: string[] = [];
  if (yieldUnits) {
    for (const m of familiesIn(yieldUnits)) {
      const f = families[m];
      if (f && f.extracted) continue;
      if (families === d.families) families = { ...d.families };
      if (!f) {
        families[m] = { firstAt: now, by, inspected: false, extracted: true, sourceId: null };
        newFamilies.push(m);
      } else families[m] = { ...f, extracted: true };
    }
  }
  const i = d.sources.findIndex((s) => s.id === sourceId);
  const depletes = i >= 0 && !d.sources[i].depleted;
  if (families === d.families && !depletes) return null;
  const sources = depletes ? d.sources.map((s, k) => (k === i ? { ...s, depleted: true } : s)) : d.sources;
  return { next: { ...d, families, sources }, newFamilies, depletedSource: depletes ? sourceId : null };
}

export function planStamp(d: Readonly<DiscoveryState>, kind: "trials" | "sites" | "inspectedSites", id: string, by: PlayerId, now: number): DiscoveryState | null {
  if (d[kind][id]) return null;
  return { ...d, [kind]: { ...d[kind], [id]: { at: now, by } } };
}
