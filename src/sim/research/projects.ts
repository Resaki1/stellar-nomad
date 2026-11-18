/**
 * Tracked-project evaluation (M3.7): pure, shared by the tracker UI and the gates.
 * A research step expands into the option's missing evidence and analysis material.
 */
import { RESEARCH_NODES, getItemDef, getResearchNode, getSiteDef, materialName, type Requirement } from "@/data/content";
import { getProjectDef, type ProjectStep } from "@/data/projects";
import { evaluateNode, missingAnalysis, type EvidenceView } from "./requirements";

export interface ProjectView extends EvidenceView {
  /** Owned modules and specials. */
  owned: ReadonlySet<string>;
  consumables: Readonly<Record<string, number>>;
  cargo: Readonly<Record<string, number>>;
  ordinaryKg: number;
  shipFrameId: string | null;
  /** Frames of the non-starter points this player placed. */
  myPointFrames: readonly string[];
  /** Effective tank capacity (loadout included), kg. */
  tankKg: number;
}

/** One piece of a research step: a requirement, an any-of group, or analysis material. */
export interface ProjectSub {
  text: string;
  met: boolean;
  req?: Requirement;
  any?: { req: Requirement; met: boolean }[];
  analysis?: { material: string; need: number; have: number };
}

export type ProjectLineIcon = "research" | "craft" | "fuel" | "field" | "site" | "point";

export interface ProjectLine {
  icon: ProjectLineIcon;
  text: string;
  /** Entity name inside `text` (UI renders it as a name, not prose). */
  name?: string;
  /** Hover text (the fuel step's purpose). */
  tip?: string;
  met: boolean;
  sub: ProjectSub[];
}

export interface ProjectStatus {
  id: string;
  name: string;
  lines: ProjectLine[];
  done: number;
  total: number;
  complete: boolean;
}

/** A prerequisite added after a world unlocked its dependant (playtest 1: th1/lg1 → pr1, sv2 → ln1) counts as met. */
function supersededByCompleted(nodeId: string, completed: ReadonlySet<string>): boolean {
  return RESEARCH_NODES.some((n) => completed.has(n.id) && n.all.some((r) => r.kind === "research" && r.nodeId === nodeId));
}

function stepLine(s: ProjectStep, v: ProjectView): ProjectLine {
  switch (s.kind) {
    case "research": {
      const node = getResearchNode(s.nodeId);
      if (!node) return { icon: "research", text: s.nodeId, met: false, sub: [] };
      const name = node.name;
      if (v.completed.has(node.id)) return { icon: "research", text: `${name} unlocked`, name, met: true, sub: [] };
      if (supersededByCompleted(node.id, v.completed)) return { icon: "research", text: `${name} not needed`, name, met: true, sub: [] };
      const ev = evaluateNode(node, v);
      const sub: ProjectSub[] = ev.all.map((r) => ({ text: r.text, met: r.met, req: r.req }));
      if (ev.any.length > 0) sub.push({ text: `One of: ${ev.any.map((r) => r.text).join(" / ")}`, met: ev.anyMet, any: ev.any.map((r) => ({ req: r.req, met: r.met })) });
      const short = missingAnalysis(node, v.cargo);
      for (const [k, need] of Object.entries(node.analysis)) {
        sub.push({ text: `Carry ${need} ${materialName(k)} for the analysis`, met: !short[k], analysis: { material: k, need, have: Math.floor(v.cargo[k] ?? 0) } });
      }
      return { icon: "research", text: `Research ${name}`, name, met: false, sub };
    }
    case "own": {
      const def = getItemDef(s.itemId);
      const name = def?.name ?? s.itemId;
      const have = def?.type === "consumable" ? (v.consumables[s.itemId] ?? 0) > 0 : v.owned.has(s.itemId);
      // A kit already placed counts: the step is "have built one".
      const met = have || (s.itemId === "consumable_replication_kit" && v.myPointFrames.length > 0);
      return { icon: "craft", text: met ? `${name} built` : `Craft ${name}`, name, met, sub: [] };
    }
    case "tank": {
      // Met once the tank holds the trip (or the ship is already in lunar space).
      const met = v.tankKg >= s.kg || v.shipFrameId === "luna";
      const def = getItemDef(s.itemId);
      const name = def?.name ?? s.itemId;
      if (met) return { icon: "fuel", text: `Tank ${v.tankKg} kg`, tip: s.label, met, sub: [] };
      return { icon: "craft", text: v.owned.has(s.itemId) ? `Equip ${name}` : `Craft ${name}`, name, tip: s.label, met, sub: [] };
    }
    case "fuel": {
      const kg = s.kg;
      // Spent on the way: once in lunar space the fuel step stays met.
      const met = v.ordinaryKg >= kg || v.shipFrameId === "luna";
      return { icon: "fuel", text: `${Math.floor(v.ordinaryKg)} / ${kg} kg`, tip: s.label, met, sub: [] };
    }
    case "inFrame":
      return { icon: "field", text: s.label, met: v.shipFrameId === s.frameId, sub: [] };
    case "siteInspected": {
      const site = getSiteDef(s.siteId);
      const met = !!v.discoveries.inspectedSites[s.siteId];
      return { icon: "site", text: met ? `${site?.name ?? s.siteId} inspected` : `Inspect the ${(site?.name ?? s.siteId).toLowerCase()}`, met, sub: [] };
    }
    case "siteRecovered": {
      const site = getSiteDef(s.siteId);
      const met = !!v.discoveries.sites[s.siteId];
      return { icon: "site", text: met ? `${site?.name ?? s.siteId} recovered` : `Recover the ${(site?.name ?? s.siteId).toLowerCase()}`, met, sub: [] };
    }
    case "point": {
      const met = s.frameId ? v.myPointFrames.includes(s.frameId) : v.myPointFrames.length > 0;
      return { icon: "point", text: s.label, met, sub: [] };
    }
  }
}

export function evaluateProject(id: string, v: ProjectView): ProjectStatus | null {
  const def = getProjectDef(id);
  if (!def) return null;
  const lines = def.steps.map((s) => stepLine(s, v));
  const done = lines.filter((l) => l.met).length;
  return { id, name: def.name, lines, done, total: lines.length, complete: done === lines.length };
}
