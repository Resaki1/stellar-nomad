/**
 * Authored sites and regional opportunities (M3.7): POI markers, the glance read model
 * (nearest site, recovery destination, return fuel) sampled at 4 Hz, and the site actions.
 */
import { atom } from "jotai";
import { RESEARCH_NODES, SITES, getSiteDef, materialName, type SiteDef } from "@/data/content";
import type { FrameId } from "@/sim/frames";
import { getLocalPlayerShip } from "@/sim/entities";
import { poseDistanceKm } from "@/sim/replication/placement";
import { TRANSIT_ACCEL_KMPS2 } from "@/sim/ship/transitDrive";
import { getEffectiveTuning } from "@/sim/ship/resourceTuning";
import type { POIDef } from "@/store/poi";
import { poiBuffer } from "@/store/poi";
import { discoveriesMirrorAtom } from "@/store/research";
import { activePointAtom } from "@/store/replication";
import { systemConfigAtom } from "@/store/system";
import { targetedPOIAtom } from "@/store/transit";
import { addToastAtom } from "@/store/toast";
import { describeRejection, newOpId, runOperation } from "@/store/operations";
import type { OperationOutcome } from "@/sim/world/commands";

const POCKET_MARKER_MAX_KM = 2500;
const SITE_ARRIVAL_KM = 3;

/** Regional indications: authored debris pockets (Earth) and site signals (lunar). */
export const sitePOIsAtom = atom((get): POIDef[] => {
  const system = get(systemConfigAtom);
  const disc = get(discoveriesMirrorAtom);
  const chunkKm = system.defaults?.streaming?.chunkSizeKm ?? 20;
  const out: POIDef[] = [];
  for (const f of system.asteroidFields ?? []) {
    const anchored = !!f.anchorBody && !!f.anchorOffsetKm;
    for (const p of f.resources?.pockets ?? []) {
      // Marker at the centre of the pocket's chunks, in the field's anchor frame.
      const c = [0, 0, 0];
      for (const k of p.chunks) k.split(",").forEach((v, i) => (c[i] += (Number(v) + 0.5) * chunkKm / p.chunks.length));
      const base = anchored && f.anchorOffsetKm ? f.anchorOffsetKm : f.anchorKm;
      out.push({
        id: `pocket:${p.id}`,
        name: p.name,
        positionKm: [base[0] + c[0], base[1] + c[1], base[2] + c[2]],
        frameId: anchored ? (f.anchorBody as FrameId) : undefined,
        minDistanceKm: 1,
        maxDistanceKm: POCKET_MARKER_MAX_KM,
        arrivalOffsetKm: 2,
      });
    }
  }
  for (const s of SITES) {
    if (disc.sites[s.id]) continue;
    out.push({
      id: `site:${s.id}`,
      name: disc.inspectedSites[s.id] ? s.name : s.signalName,
      positionKm: s.positionKm,
      frameId: s.frameId as FrameId,
      minDistanceKm: 0,
      maxDistanceKm: s.signalRangeKm,
      arrivalOffsetKm: SITE_ARRIVAL_KM,
    });
  }
  return out;
});

export interface GlanceState {
  frameId: string | null;
  /** Nearest unrecovered site within its signal range. */
  site: { id: string; distKm: number; inspected: boolean } | null;
  recovery: { name: string; distKm: number; starter: boolean } | null;
  /** Ideal transit fuel back to the active point, kg (accelerate + brake). */
  returnKg: number;
}

const EMPTY: GlanceState = { frameId: null, site: null, recovery: null, returnKg: 0 };
export const glanceAtom = atom<GlanceState>(EMPTY);

const round = (km: number): number => (km < 10 ? Math.round(km * 100) / 100 : km < 1000 ? Math.round(km * 10) / 10 : Math.round(km));

/** Sampled at human rate by the HUD; writes only when a rounded value changes. */
export const sampleGlanceAtom = atom(null, (get, set): void => {
  const ship = getLocalPlayerShip();
  if (!ship) return;
  const pos = [ship.posKm.x, ship.posKm.y, ship.posKm.z];
  const disc = get(discoveriesMirrorAtom);
  let site: GlanceState["site"] = null;
  for (const s of SITES) {
    if (disc.sites[s.id]) continue;
    const d = poseDistanceKm(ship.frameId, pos, s.frameId, s.positionKm);
    if (d <= s.signalRangeKm && (!site || d < site.distKm)) site = { id: s.id, distKm: round(d), inspected: !!disc.inspectedSites[s.id] };
  }
  const pt = get(activePointAtom);
  const recDist = pt ? poseDistanceKm(ship.frameId, pos, pt.frameId, pt.positionKm) : 0;
  const recovery = pt && Number.isFinite(recDist) ? { name: pt.name, distKm: round(recDist), starter: pt.starter } : null;
  const t = getEffectiveTuning();
  const returnKg = recovery && recDist > 50 ? Math.round(2 * t.transitKgPerKmps * Math.sqrt(TRANSIT_ACCEL_KMPS2 * recDist) * (1 + t.transitReserveMargin)) : 0;
  const prev = get(glanceAtom);
  const same = prev.frameId === ship.frameId && prev.returnKg === returnKg &&
    JSON.stringify(prev.site) === JSON.stringify(site) && JSON.stringify(prev.recovery) === JSON.stringify(recovery);
  if (!same) set(glanceAtom, { frameId: ship.frameId, site, recovery, returnKg });
});

function rejectionText(site: SiteDef, o: Extract<OperationOutcome, { status: "rejected" }>): string {
  if (o.reason === "too_far") return `Within ${site.inspectRangeKm} km to inspect, ${site.recoverRangeKm} km to recover`;
  if (o.reason === "not_inspected") return "Inspect it first (G)";
  if (o.reason === "no_capacity") return `Needs ${Object.values(site.reward).reduce((a, v) => a + v, 0)} units of free cargo`;
  return describeRejection(o);
}

/** Names of the research options a site's recovery opens (read from their requirements). */
function siteUnlockText(siteId: string): string {
  const names = RESEARCH_NODES.filter((n) => n.all.some((r) => r.kind === "site" && r.siteId === siteId)).map((n) => n.name);
  return names.length ? `. New research option: ${names.join(", ")}` : "";
}

/** G near a site: inspect it, or recover it once inspected. Returns the outcome (null if none in range). */
export const interactSiteAtom = atom(null, (get, set, opId?: string): OperationOutcome | null => {
  const g = get(glanceAtom).site;
  const site = g ? getSiteDef(g.id) : undefined;
  if (!site || !g || g.distKm > site.inspectRangeKm) return null;
  const inspected = !!get(discoveriesMirrorAtom).inspectedSites[site.id];
  const op = inspected ? { type: "site.recover" as const, opId: opId ?? newOpId(), siteId: site.id } : { type: "site.inspect" as const, opId: opId ?? newOpId(), siteId: site.id };
  return runOperation(op, (o) => {
    if (o.status === "accepted" && o.result.type === "site.inspect") {
      set(addToastAtom, { message: `Inspected: ${site.name}`, detail: site.inspectText, kind: "success", durationMs: 7000 });
    } else if (o.status === "accepted" && o.result.type === "site.recover") {
      const got = Object.entries(o.result.reward).map(([k, n]) => `${n} ${materialName(k)}`).join(", ");
      set(addToastAtom, { message: `Recovered: ${site.name}`, detail: `${got} aboard${siteUnlockText(site.id)}`, kind: "success", durationMs: 7000 });
    } else if (o.status === "rejected") {
      set(addToastAtom, { message: site.name, detail: rejectionText(site, o), kind: "warn", audio: "reject", durationMs: 3500 });
    }
  });
});

export type Destination = { siteId: string } | { bodyId: string } | { fieldId: string };

/** Tracker / records: make a site, a body or a field the transit destination. */
export const setDestinationAtom = atom(null, (get, set, dest: Destination): boolean => {
  if ("siteId" in dest) {
    const s = getSiteDef(dest.siteId);
    if (!s) return false;
    const id = `site:${s.id}`;
    set(targetedPOIAtom, { id, name: s.signalName, positionKm: s.positionKm, frameId: s.frameId as FrameId, arrivalOffsetKm: SITE_ARRIVAL_KM });
    poiBuffer.targetedId = id;
    poiBuffer.pinnedId = id;
    return true;
  }
  if ("fieldId" in dest) {
    const f = (get(systemConfigAtom).asteroidFields ?? []).find((x) => x.id === dest.fieldId);
    if (!f) return false;
    const id = `field:${f.id}`;
    set(targetedPOIAtom, { id, name: f.name, positionKm: f.anchorKm });
    poiBuffer.targetedId = id;
    poiBuffer.pinnedId = id;
    return true;
  }
  const body = (get(systemConfigAtom).celestialBodies ?? []).find((b) => b.id === dest.bodyId);
  if (!body) return false;
  const id = `body:${body.id}`;
  set(targetedPOIAtom, { id, name: body.name, positionKm: body.positionKm, arrivalOffsetKm: Math.max(100, body.radiusKm * 2) });
  poiBuffer.targetedId = id;
  poiBuffer.pinnedId = id;
  return true;
});
