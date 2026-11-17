/**
 * Tracked-project evaluation (M3.7): pure, shared by the tracker UI and the gates.
 * A research step expands into the option's missing evidence and analysis material.
 */
import { getItemDef, getResearchNode, getSiteDef, materialName } from "@/data/content";
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
  /** Difficulty fuel-use multiplier (fuel steps scale with it). */
  fuelUse: number;
}

export interface ProjectLine {
  text: string;
  met: boolean;
  sub: { text: string; met: boolean }[];
}

export interface ProjectStatus {
  id: string;
  name: string;
  lines: ProjectLine[];
  done: number;
  total: number;
  complete: boolean;
}

function stepLine(s: ProjectStep, v: ProjectView): ProjectLine {
  switch (s.kind) {
    case "research": {
      const node = getResearchNode(s.nodeId);
      if (!node) return { text: s.nodeId, met: false, sub: [] };
      if (v.completed.has(node.id)) return { text: `${node.name} unlocked`, met: true, sub: [] };
      const ev = evaluateNode(node, v);
      const sub = [...ev.all.map((r) => ({ text: r.text, met: r.met }))];
      if (ev.any.length > 0) sub.push({ text: `One of: ${ev.any.map((r) => r.text).join(" / ")}`, met: ev.anyMet });
      const short = missingAnalysis(node, v.cargo);
      for (const [k, need] of Object.entries(node.analysis)) sub.push({ text: `Carry ${need} ${materialName(k)} for the analysis`, met: !short[k] });
      return { text: `Unlock ${node.name} (Research, R)`, met: false, sub };
    }
    case "own": {
      const def = getItemDef(s.itemId);
      const name = def?.name ?? s.itemId;
      const have = def?.type === "consumable" ? (v.consumables[s.itemId] ?? 0) > 0 : v.owned.has(s.itemId);
      // A kit already placed counts: the step is "have built one".
      const met = have || (s.itemId === "consumable_replication_kit" && v.myPointFrames.length > 0);
      return { text: met ? `${name} built` : `Fabricate the ${name} (Craft, F)`, met, sub: [] };
    }
    case "fuel": {
      const kg = Math.round(s.kg * v.fuelUse);
      // Spent on the way: once in lunar space the fuel step stays met.
      const met = v.ordinaryKg >= kg || v.shipFrameId === "luna";
      return { text: `Ordinary propellant ${Math.floor(v.ordinaryKg)} / ${kg} kg (${s.label})`, met, sub: [] };
    }
    case "inFrame":
      return { text: s.label, met: v.shipFrameId === s.frameId, sub: [] };
    case "siteInspected": {
      const site = getSiteDef(s.siteId);
      const met = !!v.discoveries.inspectedSites[s.siteId];
      return { text: met ? `${site?.name ?? s.siteId} inspected` : `Approach the ${site?.signalName ?? s.siteId} and inspect it (G)`, met, sub: [] };
    }
    case "siteRecovered": {
      const site = getSiteDef(s.siteId);
      const met = !!v.discoveries.sites[s.siteId];
      return { text: met ? `${site?.name ?? s.siteId} recovered` : `Recover the ${site?.name ?? s.siteId} (G, within ${site?.recoverRangeKm ?? 1} km)`, met, sub: [] };
    }
    case "point": {
      const met = s.frameId ? v.myPointFrames.includes(s.frameId) : v.myPointFrames.length > 0;
      return { text: s.label, met, sub: [] };
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
