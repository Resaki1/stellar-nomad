/** Tracked project (M3.7): player-owned selection plus its evaluated status for the tracker. */
import { atom } from "jotai";
import { getLocalPlayerId } from "@/save/playerId";
import { difficultyMults } from "@/sim/difficulty";
import { evaluateProject, type ProjectStatus, type ProjectView } from "@/sim/research/projects";
import { cargoAtom } from "@/store/cargo";
import { modulesAtom } from "@/store/modules";
import { replicationPointsAtom } from "@/store/replication";
import { evidenceViewAtom } from "@/store/research";
import { savedAtom } from "@/store/savedAtom";
import { shipResourcesHudAtom } from "@/store/shipResources";
import { glanceAtom } from "@/store/sites";

export const trackedProjectAtom = savedAtom("player", "trackedProject", null);

/** Rounded fuel so the 10 Hz resource mirror re-evaluates projects only per whole kg. */
const fuelKgAtom = atom((get) => Math.floor(get(shipResourcesHudAtom).ordinaryKg));

export const projectViewAtom = atom((get): ProjectView => {
  const ev = get(evidenceViewAtom);
  const m = get(modulesAtom);
  const me = getLocalPlayerId();
  return {
    ...ev,
    owned: new Set(m.ownedModules),
    consumables: m.consumables,
    cargo: get(cargoAtom).items,
    ordinaryKg: get(fuelKgAtom),
    shipFrameId: get(glanceAtom).frameId,
    myPointFrames: get(replicationPointsAtom).filter((p) => !p.starter && p.by === me).map((p) => p.frameId),
    fuelUse: difficultyMults().fuelUse,
  };
});

export const trackedStatusAtom = atom((get): ProjectStatus | null => {
  const id = get(trackedProjectAtom);
  return id ? evaluateProject(id, get(projectViewAtom)) : null;
});
