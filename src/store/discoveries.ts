/**
 * Discoveries list and loadout preview read models (M3.3/M3.4): bookmarked sources as POIs,
 * picking a source as the transit destination, and the power/thermal preview of the loadout.
 */
import { atom } from "jotai";
import { SOURCE_CLASS_NAMES } from "@/data/content";
import { pilotTint } from "@/data/markerCategories";
import { getWorldState } from "@/save/activeSave";
import type { SourceFinding, WorldState } from "@/save/types";
import { isFrameId, type FrameId } from "@/sim/frames";
import { computeLoadoutPreview, type LoadoutPreview } from "@/sim/ship/loadoutPreview";
import { getEffectiveTuning } from "@/sim/ship/resourceTuning";
import { cargoAtom } from "@/store/cargo";
import { poiBuffer, type POIDef } from "@/store/poi";
import { bookmarksAtom, discoveriesMirrorAtom } from "@/store/research";
import { effectiveShipConfigAtom } from "@/store/shipConfig";
import { targetedPOIAtom, transitDriveOwnedAtom } from "@/store/transit";

export const sourceLabel = (s: SourceFinding, name?: string): string => name || `${SOURCE_CLASS_NAMES[s.classId] ?? s.classId} rock`;

export const rendezvousAtom = atom<WorldState["rendezvous"]>({});

/** Arrival stand-off: outside the rock with room to inspect or mine it. */
const standoffKm = (s: SourceFinding): number => Math.max(0.3, (s.radiusM / 1000) * 4);

/** Bookmarked sources the world still records, as POI markers (frame-relative, stable). */
export const bookmarkPOIsAtom = atom((get): POIDef[] => {
  const sources = get(discoveriesMirrorAtom).sources;
  const out: POIDef[] = [];
  for (const b of get(bookmarksAtom)) {
    const s = sources.find((x) => x.id === b.sourceId);
    if (!s || s.depleted) continue;
    out.push({
      id: `source:${s.id}`,
      category: "source",
      name: sourceLabel(s, b.name),
      positionKm: s.positionKm,
      frameId: s.frameId as FrameId,
      minDistanceKm: 0,
      maxDistanceKm: 1e6,
      arrivalOffsetKm: standoffKm(s),
    });
  }
  // One persistent ping per pilot (world.rendezvous), in that pilot's tint.
  const members = getWorldState().members;
  const memberIds = Object.keys(members);
  for (const [owner, fix] of Object.entries(get(rendezvousAtom))) {
    const source = fix.sourceId ? sources.find(s => s.id === fix.sourceId) : null;
    if (!isFrameId(fix.frameId) || (fix.sourceId && (!source || source.depleted))) continue;
    const ownerName = members[owner]?.name || "Replicant";
    out.push({ id: `rendezvous:${owner}`, category: "ping", name: fix.name, positionKm: fix.positionKm, frameId: fix.frameId,
      minDistanceKm: 0, maxDistanceKm: Infinity, arrivalOffsetKm: source ? standoffKm(source) : 0.1,
      tint: pilotTint(owner, memberIds), initial: ownerName.trim().charAt(0).toUpperCase() || "?", bearing: fix.bearing === true });
  }
  return out;
});

/** Discoveries list: make a source the transit destination (stays until another is chosen). */
export const setDestinationToSourceAtom = atom(null, (get, set, sourceId: string): boolean => {
  const s = get(discoveriesMirrorAtom).sources.find((x) => x.id === sourceId);
  if (!s || s.depleted || !get(transitDriveOwnedAtom)) return false;
  const name = get(bookmarksAtom).find((b) => b.sourceId === sourceId)?.name;
  const id = `source:${s.id}`;
  set(targetedPOIAtom, { id, name: sourceLabel(s, name), positionKm: s.positionKm, frameId: s.frameId as FrameId, arrivalOffsetKm: standoffKm(s) });
  poiBuffer.targetedId = id;
  poiBuffer.pinnedId = id;
  return true;
});

/** Power/thermal preview of the equipped loadout (recomputed when the config changes). */
const cargoBaseCapacityAtom = atom((get) => get(cargoAtom).capacityUnits);

export const loadoutPreviewAtom = atom((get): LoadoutPreview =>
  computeLoadoutPreview(get(effectiveShipConfigAtom), getEffectiveTuning(), get(cargoBaseCapacityAtom)),
);
