/**
 * Typed research requirements (M3.3), evaluated by pure functions over the world's durable
 * evidence, plus the content audit. No React, no store: the authority and the UI share it.
 */
import {
  FAMILY_MIN_SHARE,
  INDUSTRY_BLUEPRINTS,
  ITEMS,
  RESEARCH_NODES,
  SITES,
  SOURCE_CLASS_NAMES,
  TRIALS,
  getItemDef,
  getResearchNode,
  getSiteDef,
  getTrialDef,
  materialName,
  type Requirement,
  type ResearchNodeDef,
} from "@/data/content";
import type { DiscoveryState } from "@/save/types";

/** What requirements read: the world's discoveries and unlocked options. */
export interface EvidenceView {
  discoveries: Readonly<DiscoveryState>;
  completed: ReadonlySet<string>;
}

export function requirementKey(r: Requirement): string {
  switch (r.kind) {
    case "family":
      return `family:${r.material}${r.inspected ? ":inspected" : ""}`;
    case "sourceClass":
      return `sourceClass:${r.classId}`;
    case "trial":
      return `trial:${r.trialId}`;
    case "site":
      return `site:${r.siteId}`;
    case "research":
      return `research:${r.nodeId}`;
  }
}

export function isRequirementMet(r: Requirement, ev: EvidenceView): boolean {
  switch (r.kind) {
    case "family": {
      const f = ev.discoveries.families[r.material];
      return !!f && (!r.inspected || f.inspected);
    }
    case "sourceClass":
      return ev.discoveries.sources.some((s) => s.classId === r.classId);
    case "trial":
      return !!ev.discoveries.trials[r.trialId];
    case "site":
      return !!ev.discoveries.sites[r.siteId];
    case "research":
      return ev.completed.has(r.nodeId);
  }
}

/** Plain words: the evidence still to collect (or, when met, what was collected). */
export function describeRequirement(r: Requirement, met = false): string {
  switch (r.kind) {
    case "family": {
      const m = materialName(r.material);
      if (met) return r.inspected ? `${m} confirmed by inspection` : `${m} confirmed`;
      const pct = Math.round(FAMILY_MIN_SHARE * 100);
      return r.inspected ? `Inspect a rock that is at least ${pct} % ${m}` : `Confirm ${m}: inspect or mine a rock that is at least ${pct} % ${m}`;
    }
    case "sourceClass": {
      const c = SOURCE_CLASS_NAMES[r.classId] ?? r.classId;
      return met ? `${c} rock inspected` : `Inspect ${/^[AEFHILMNORSX]/.test(c) ? "an" : "a"} ${c} rock`;
    }
    case "trial": {
      const t = getTrialDef(r.trialId);
      return met ? `${t?.name ?? r.trialId} done` : (t?.howTo ?? r.trialId);
    }
    case "site": {
      const s = getSiteDef(r.siteId);
      return met ? `${s?.name ?? r.siteId} recovered` : `Recover the ${s?.name ?? r.siteId}`;
    }
    case "research": {
      const n = getResearchNode(r.nodeId);
      return met ? `${n?.name ?? r.nodeId} unlocked` : `Unlock ${n?.name ?? r.nodeId} first`;
    }
  }
}

/** Chip glyph for a requirement (the UI maps it to an icon). */
export type ReqChipIcon = "material" | "class" | "beam" | "batch" | "craft" | "transit" | "site" | "research";

/** Compact chip: icon + ≤ 3-word label; `tip` (≤ 8 words) carries the full requirement. */
export interface ReqChipSpec {
  icon: ReqChipIcon;
  label: string;
  tip: string;
  material?: string;
  scan?: boolean;
}

const CLASS_BADGE: Record<string, string> = { s_type: "S", c_type: "C", x_type: "X", l_regolith: "LR", l_metallic: "LM", l_volatile: "LV" };

/** Short trial names and tooltips (Discoveries and chips). */
export const TRIAL_CHIPS: Record<string, { icon: ReqChipIcon; label: string; tip: string }> = {
  sustained_beam: { icon: "beam", label: "Beam 8 s", tip: "Mine one rock 8 s without overheating" },
  first_batch: { icon: "batch", label: "First batch", tip: "Process hydrates into fuel once" },
  first_fabrication: { icon: "craft", label: "First craft", tip: "Craft any item" },
  transit_leg: { icon: "transit", label: "Transit leg", tip: "Finish one transit leg" },
};

export function requirementChip(r: Requirement): ReqChipSpec {
  const pct = Math.round(FAMILY_MIN_SHARE * 100);
  switch (r.kind) {
    case "family": {
      const m = materialName(r.material);
      return r.inspected
        ? { icon: "material", label: "", material: r.material, scan: true, tip: `Inspect a rock with ≥${pct} % ${m}` }
        : { icon: "material", label: "", material: r.material, tip: `Mine or inspect a rock with ≥${pct} % ${m}` };
    }
    case "sourceClass": {
      const c = SOURCE_CLASS_NAMES[r.classId] ?? r.classId;
      return { icon: "class", label: CLASS_BADGE[r.classId] ?? c, scan: true, tip: `Inspect ${/^[AEFHILMNORSX]/.test(c) ? "an" : "a"} ${c} rock` };
    }
    case "trial":
      return TRIAL_CHIPS[r.trialId] ?? { icon: "beam", label: r.trialId, tip: getTrialDef(r.trialId)?.howTo ?? r.trialId };
    case "site":
      return { icon: "site", label: "Canister", tip: `Recover the ${(getSiteDef(r.siteId)?.name ?? r.siteId).toLowerCase()}` };
    case "research": {
      const n = getResearchNode(r.nodeId)?.name ?? r.nodeId;
      return { icon: "research", label: n, tip: `Unlock ${n} first` };
    }
  }
}

export const sourceClassBadge = (classId: string): string => CLASS_BADGE[classId] ?? classId;

export interface RequirementStatus {
  req: Requirement;
  key: string;
  met: boolean;
  text: string;
}

export interface NodeEvaluation {
  met: boolean;
  all: RequirementStatus[];
  /** Empty when the node has no any-of group. */
  any: RequirementStatus[];
  anyMet: boolean;
  /** Keys of the evidence still missing (the any-group counts as one entry: `any:<keys>`). */
  missing: string[];
}

const status = (req: Requirement, ev: EvidenceView): RequirementStatus => {
  const met = isRequirementMet(req, ev);
  return { req, key: requirementKey(req), met, text: describeRequirement(req, met) };
};

export function evaluateNode(node: ResearchNodeDef, ev: EvidenceView): NodeEvaluation {
  const all = node.all.map((r) => status(r, ev));
  const any = (node.any ?? []).map((r) => status(r, ev));
  const anyMet = any.length === 0 || any.some((s) => s.met);
  const missing = all.filter((s) => !s.met).map((s) => s.key);
  if (!anyMet) missing.push(`any:${any.map((s) => s.key).join("|")}`);
  return { met: missing.length === 0, all, any, anyMet, missing };
}

/** Met / total pieces of an option, analysis materials included (the card's fraction ring). */
export function nodeProgress(node: ResearchNodeDef, ev: EvidenceView, cargo: Readonly<Record<string, number>>): { met: number; total: number } {
  const e = evaluateNode(node, ev);
  const analysis = Object.entries(node.analysis);
  const metAnalysis = analysis.filter(([k, n]) => Math.floor(cargo[k] ?? 0) >= n).length;
  return {
    met: e.all.filter((s) => s.met).length + (e.any.length > 0 && e.anyMet ? 1 : 0) + metAnalysis,
    total: e.all.length + (e.any.length > 0 ? 1 : 0) + analysis.length,
  };
}

/** Analysis material still missing from `cargo`, units. */
export function missingAnalysis(node: ResearchNodeDef, cargo: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, need] of Object.entries(node.analysis)) {
    const have = Math.floor(cargo[k] ?? 0);
    if (have < need) out[k] = need - have;
  }
  return out;
}

/** Plain words for a missing-evidence key list (rejections name the piece). */
export function describeMissingKeys(keys: readonly string[]): string[] {
  return keys.map((k) => {
    if (k.startsWith("any:")) {
      const parts = k.slice(4).split("|").map((x) => describeKey(x));
      return `One of: ${parts.join(" / ")}`;
    }
    return describeKey(k);
  });
}

function describeKey(k: string): string {
  const [kind, a, b] = k.split(":");
  switch (kind) {
    case "family":
      return describeRequirement({ kind: "family", material: a, inspected: b === "inspected" });
    case "sourceClass":
      return describeRequirement({ kind: "sourceClass", classId: a });
    case "trial":
      return describeRequirement({ kind: "trial", trialId: a });
    case "site":
      return describeRequirement({ kind: "site", siteId: a });
    case "research":
      return describeRequirement({ kind: "research", nodeId: a });
    default:
      return k;
  }
}

/** Items craftable for a world: starters plus every unlocked option's items. */
export function unlockedItemIds(completed: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const item of ITEMS) if (item.starter) out.add(item.id);
  for (const node of RESEARCH_NODES) {
    if (!completed.has(node.id)) continue;
    for (const id of node.unlocks.items) out.add(id);
  }
  return out;
}

// ── Content audit (gate b) ──────────────────────────────────────────────────

export interface ContentAudit {
  pass: boolean;
  cycles: string[];
  unreachable: string[];
  overCapacity: string[];
  helium3Gates: string[];
  lunarOnlyBasics: string[];
  unknownRefs: string[];
  orphanItems: string[];
  nodes: number;
  items: number;
}

/** Materials the starter region provides (origin_belt classes). */
export const STARTER_MATERIALS: readonly string[] = ["silicates", "fe_ni_metal", "sulfur", "carbon", "hydrates"];
const STARTER_CLASSES: readonly string[] = ["s_type", "c_type", "x_type"];
/** Options whose items are survival or travel equipment: no helium-3 anywhere on their path. */
const SURVIVAL_OR_TRAVEL: ReadonlySet<string> = new Set(["pr1_transit_calibration", "pr2_thruster_tuning", "hl1_hull_reinforcement", "lg1_bulk_handling", "th1_heat_rejection"]);

/**
 * No cycles; every option reachable from evidence some operation can record; no recipe or
 * analysis above the starter's cargo; no helium-3 on survival/travel paths; every option
 * outside the lunar branch reachable from starter-region materials and evidence alone.
 */
export function auditContent(starterCargoUnits: number): ContentAudit {
  const a: ContentAudit = { pass: false, cycles: [], unreachable: [], overCapacity: [], helium3Gates: [], lunarOnlyBasics: [], unknownRefs: [], orphanItems: [], nodes: RESEARCH_NODES.length, items: ITEMS.length };
  const reqsOf = (n: ResearchNodeDef): Requirement[] => [...n.all, ...(n.any ?? [])];

  // Cycles over research prerequisites (DFS).
  const state = new Map<string, number>();
  const visit = (id: string, path: string[]): void => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      a.cycles.push([...path, id].join(" → "));
      return;
    }
    state.set(id, 1);
    const n = getResearchNode(id);
    if (n) for (const r of reqsOf(n)) if (r.kind === "research") visit(r.nodeId, [...path, id]);
    state.set(id, 2);
  };
  for (const n of RESEARCH_NODES) visit(n.id, []);

  // References and reachability: fixed point over what operations can record.
  const trials = new Set(TRIALS.map((t) => t.id));
  const sites = new Set(SITES.map((s) => s.id));
  for (const n of RESEARCH_NODES) {
    for (const r of reqsOf(n)) {
      if (r.kind === "trial" && !trials.has(r.trialId)) a.unknownRefs.push(`${n.id}: trial ${r.trialId}`);
      if (r.kind === "site" && !sites.has(r.siteId)) a.unknownRefs.push(`${n.id}: site ${r.siteId}`);
      if (r.kind === "research" && !getResearchNode(r.nodeId)) a.unknownRefs.push(`${n.id}: research ${r.nodeId}`);
    }
    for (const id of n.unlocks.items) if (!getItemDef(id)) a.unknownRefs.push(`${n.id}: item ${id}`);
  }
  for (const blueprint of Object.keys(INDUSTRY_BLUEPRINTS)) {
    const owners = RESEARCH_NODES.filter(n => n.unlocks.industry?.some(id => id === blueprint));
    if (owners.length !== 1) a.unknownRefs.push(`Industry blueprint ${blueprint} has ${owners.length} research owners`);
  }
  const solve = (materials: readonly string[], classes: readonly string[], withSites: boolean): Set<string> => {
    const done = new Set<string>();
    const ok = (r: Requirement): boolean => {
      switch (r.kind) {
        case "family":
          return materials.includes(r.material);
        case "sourceClass":
          return classes.includes(r.classId);
        case "trial":
          return trials.has(r.trialId);
        case "site":
          return withSites && sites.has(r.siteId);
        case "research":
          return done.has(r.nodeId);
      }
    };
    for (let changed = true; changed; ) {
      changed = false;
      for (const n of RESEARCH_NODES) {
        if (done.has(n.id)) continue;
        const analysisOk = Object.keys(n.analysis).every((k) => materials.includes(k));
        if (analysisOk && n.all.every(ok) && (!n.any || n.any.length === 0 || n.any.some(ok))) {
          done.add(n.id);
          changed = true;
        }
      }
    }
    return done;
  };
  const everything = solve(Object.keys({ ...Object.fromEntries(STARTER_MATERIALS.map((m) => [m, 1])), titanium: 1, helium_3: 1 }), [...STARTER_CLASSES, "l_regolith", "l_metallic", "l_volatile"], true);
  for (const n of RESEARCH_NODES) if (!everything.has(n.id)) a.unreachable.push(n.id);
  const starter = solve(STARTER_MATERIALS, STARTER_CLASSES, false);
  for (const n of RESEARCH_NODES) {
    if (n.branch === "lunar") continue;
    if (!starter.has(n.id)) a.lunarOnlyBasics.push(n.id);
    for (const id of n.unlocks.items) {
      const item = getItemDef(id);
      if (item && Object.keys(item.recipe).some((k) => !STARTER_MATERIALS.includes(k))) a.lunarOnlyBasics.push(`${n.id}: ${id}`);
    }
  }
  for (const item of ITEMS) if (item.starter && Object.keys(item.recipe).some((k) => !STARTER_MATERIALS.includes(k))) a.lunarOnlyBasics.push(item.id);

  // Capacity: no single fabrication or analysis batch above the starter hold.
  for (const item of ITEMS) {
    const total = Object.values(item.recipe).reduce((s, v) => s + v, 0);
    if (total > starterCargoUnits) a.overCapacity.push(`${item.id}: ${total}`);
  }
  for (const n of RESEARCH_NODES) {
    const total = Object.values(n.analysis).reduce((s, v) => s + v, 0);
    if (total > starterCargoUnits) a.overCapacity.push(`${n.id}: ${total}`);
  }

  // Helium-3: never on a survival/travel option's requirements, analysis or recipes (transitively).
  const pathHas3 = (id: string, seen: Set<string>): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    const n = getResearchNode(id);
    if (!n) return false;
    if ((n.analysis.helium_3 ?? 0) > 0) return true;
    if (reqsOf(n).some((r) => r.kind === "family" && r.material === "helium_3")) return true;
    if (n.unlocks.items.some((i) => (getItemDef(i)?.recipe.helium_3 ?? 0) > 0)) return true;
    return reqsOf(n).some((r) => r.kind === "research" && pathHas3(r.nodeId, seen));
  };
  for (const id of Array.from(SURVIVAL_OR_TRAVEL)) if (pathHas3(id, new Set())) a.helium3Gates.push(id);
  for (const item of ITEMS) if (item.starter && (item.recipe.helium_3 ?? 0) > 0) a.helium3Gates.push(item.id);

  const reachableItems = unlockedItemIds(new Set(RESEARCH_NODES.map((n) => n.id)));
  for (const item of ITEMS) if (!reachableItems.has(item.id)) a.orphanItems.push(item.id);

  a.pass = a.cycles.length === 0 && a.unreachable.length === 0 && a.overCapacity.length === 0 && a.helium3Gates.length === 0 &&
    a.lunarOnlyBasics.length === 0 && a.unknownRefs.length === 0 && a.orphanItems.length === 0;
  return a;
}
