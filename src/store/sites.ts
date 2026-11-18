/**
 * Authored sites and regional opportunities (M3.7): POI markers, the glance read model
 * (nearest site, recovery destination, return fuel) sampled at 4 Hz, and the site actions.
 */
import { atom } from "jotai";
import { SITES, getSiteDef } from "@/data/content";
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
import { bodyTransitTarget, targetedPOIAtom, transitDriveOwnedAtom } from "@/store/transit";

/** Inside the 2 km action range, so the first [G] after a transit works (B10). */
const SITE_ARRIVAL_KM = 1.5;

/** Site signals as POI markers. Debris pockets have none (B1: a pocket re-classes chunks, it is not a place). */
export const sitePOIsAtom = atom((get): POIDef[] => {
  const disc = get(discoveriesMirrorAtom);
  const out: POIDef[] = [];
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

export type Destination = { siteId: string } | { bodyId: string } | { fieldId: string };

/** Tracker / records: make a site, a body or a field the transit destination. */
export const setDestinationAtom = atom(null, (get, set, dest: Destination): boolean => {
  if (!get(transitDriveOwnedAtom)) return false;
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
  set(targetedPOIAtom, bodyTransitTarget(body, get(systemConfigAtom).asteroidFields));
  poiBuffer.targetedId = id;
  poiBuffer.pinnedId = id;
  return true;
});
