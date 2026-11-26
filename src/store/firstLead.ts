/**
 * The first-rock lead (FIRST_EXPEDITION_PLAN WP3): one personal marker on a real, nearby, hydrate-bearing
 * rock the starter laser can finish cold, so a new pilot has a workable target within the first minute.
 *
 * Derived per pilot, never written to the world: it lives while this pilot has mined nothing
 * (`asteroidsMinedLifetimeAtom` = 0) and has not dismissed it. Mining ANY rock ends it, and a rock a
 * crewmate depletes is replaced by the next candidate. Sharing is an ordinary crew ping (Z) at the rock.
 */
import { atom, type createStore } from "jotai";
import type { FrameId } from "@/sim/frames";
import { computeMiningDurationS, getAsteroidMiningReward } from "@/sim/asteroids/resources";
import { getActiveAsteroidRuntime } from "@/sim/asteroids/runtimeContext";
import { getLocalPlayerShip } from "@/sim/entities";
import { worldAuthority } from "@/sim/world/worldAuthority";
import { aiNameAtom } from "@/store/aiName";
import { playedMessageIdsAtom } from "@/store/comms";
import { isDeadAtom } from "@/store/death";
import { asteroidsMinedLifetimeAtom } from "@/store/mining";
import type { POIDef } from "@/store/poi";
import { effectiveShipConfigAtom } from "@/store/shipConfig";
import { systemConfigAtom } from "@/store/system";

type Store = ReturnType<typeof createStore>;

export interface FirstLead {
  fieldId: string;
  chunkKey: string;
  instanceId: number;
  frameId: FrameId;
  /** Relative to `frameId` (the field's anchor body), km. */
  positionKm: [number, number, number];
  radiusM: number;
  className: string;
  hydrates: number;
  mineS: number;
}

export const FIRST_LEAD_TUNING = {
  /** Only rocks this close are offered: about a minute of starter flight. MEASURED 2026-11-26: the
   *  nearest rock to the Earth start is 6.5 km out (299 m, too big for a cold pass); small ones sit at 10+ km. */
  maxKm: 30,
  /** The starter laser finishes this in one cold pass (the fuel-economics "cold" rock, 14 s). */
  maxMineS: 14,
  /** Pilot time per km of approach, s (≈ 200 m/s average with braking). */
  travelSPerKm: 5,
};

/** Recorded in the per-pilot comms/hints registry when dismissed: the lead never returns. */
export const FIRST_LEAD_DISMISSED_ID = "lead_first_rock_dismissed";

export const firstLeadAtom = atom<FirstLead | null>(null);

export const dismissFirstLeadAtom = atom(null, (get, set) => {
  const ids = get(playedMessageIdsAtom);
  if (!ids.includes(FIRST_LEAD_DISMISSED_ID)) set(playedMessageIdsAtom, [...ids, FIRST_LEAD_DISMISSED_ID]);
  set(firstLeadAtom, null);
});

/** The lead as a marker: the rock glyph, always shown with an edge arrow while it lasts. */
export const firstLeadPOIsAtom = atom((get): POIDef[] => {
  const lead = get(firstLeadAtom);
  if (!lead) return [];
  return [{
    id: `lead:${lead.fieldId}:${lead.chunkKey}:${lead.instanceId}`,
    category: "source",
    name: `${lead.className} rock`,
    positionKm: lead.positionKm,
    frameId: lead.frameId,
    minDistanceKm: 0,
    maxDistanceKm: 1e6,
    arrivalOffsetKm: lead.radiusM / 1000 + 0.15,
    objectRadiusKm: lead.radiusM / 1000,
    guide: true,
  }];
});

function eligible(store: Store): boolean {
  if (store.get(isDeadAtom) || store.get(asteroidsMinedLifetimeAtom) > 0) return false;
  const played = store.get(playedMessageIdsAtom);
  if (played.includes(FIRST_LEAD_DISMISSED_ID)) return false;
  // After the opening premise (or on a save named before it existed).
  return !!store.get(aiNameAtom) || played.includes("opening_001");
}

/**
 * Best loaded candidate: hydrate units per second of the pilot's time (approach + one cold pass).
 * Streamed chunks only: the lead must be a rock the pilot can see now.
 */
export function pickFirstLead(store: Store, t = FIRST_LEAD_TUNING): FirstLead | null {
  const ship = getLocalPlayerShip();
  const rt = getActiveAsteroidRuntime();
  if (!ship || !rt) return null;
  const system = store.get(systemConfigAtom);
  const speedMult = store.get(effectiveShipConfigAtom).miningSpeedMult || 1;
  const s = ship.absPosKm;
  let best: FirstLead | null = null;
  let bestValue = 0;
  for (const f of system.asteroidFields ?? []) {
    const fr = rt.getFieldRuntime(f.id);
    if (!fr || !f.anchorBody || !f.anchorOffsetKm) continue;
    const off = f.anchorOffsetKm;
    fr.chunks.forEach((chunk, chunkKey) => {
      for (const modelId in chunk.instancesByModel) {
        const inst = chunk.instancesByModel[modelId];
        for (let i = 0; i < inst.count; i++) {
          const radiusM = inst.radiiM[i];
          const mineS = computeMiningDurationS(radiusM) / speedMult;
          if (mineS > t.maxMineS) continue;
          const lx = chunk.originKm[0] + inst.positionsM[i * 3] / 1000;
          const ly = chunk.originKm[1] + inst.positionsM[i * 3 + 1] / 1000;
          const lz = chunk.originKm[2] + inst.positionsM[i * 3 + 2] / 1000;
          const distKm = Math.hypot(f.anchorKm[0] + lx - s.x, f.anchorKm[1] + ly - s.y, f.anchorKm[2] + lz - s.z);
          if (distKm > t.maxKm) continue;
          const id = inst.instanceIds[i] >>> 0;
          if (worldAuthority.asteroids.has(f.id, chunkKey, id)) continue;
          const reward = getAsteroidMiningReward(system, f.id, id, radiusM, chunkKey);
          const hydrates = reward?.resources.find((r) => r.resourceId === "hydrates")?.amount ?? 0;
          if (!reward || hydrates <= 0) continue;
          const value = hydrates / (distKm * t.travelSPerKm + mineS);
          if (value <= bestValue) continue;
          bestValue = value;
          best = {
            fieldId: f.id, chunkKey, instanceId: id, frameId: f.anchorBody as FrameId,
            positionKm: [off[0] + lx, off[1] + ly, off[2] + lz], radiusM,
            className: reward.asteroidClass.name, hydrates, mineS,
          };
        }
      }
    });
  }
  return best;
}

/** Keep the lead current at 1 Hz; returns the uninstaller. */
export function installFirstLead(store: Store): () => void {
  store.set(firstLeadAtom, null);
  const update = (): void => {
    const lead = store.get(firstLeadAtom);
    if (!eligible(store)) {
      if (lead) store.set(firstLeadAtom, null);
      return;
    }
    worldAuthority.world();
    // Kept while its rock stands (stable as the pilot flies); a depleted one is replaced.
    if (lead && !worldAuthority.asteroids.has(lead.fieldId, lead.chunkKey, lead.instanceId)) return;
    const next = pickFirstLead(store);
    if (next || lead) store.set(firstLeadAtom, next);
  };
  const id = window.setInterval(update, 1000);
  update();
  return () => window.clearInterval(id);
}
