/**
 * Store side of the world authority: hydrates the saved atoms and the world mirrors from the
 * active save, keeps the mirrors in sync from events, and samples the sim clock at flush.
 */
import type { createStore } from "jotai";
import { getWorldState, registerCollector } from "@/save/activeSave";
import { getLocalPlayerId } from "@/save/playerId";
import { worldAuthority } from "@/sim/world/worldAuthority";
import { hydrateSavedAtoms, refreshPlayerAtoms } from "@/store/savedAtom";
import { wrecksMirrorAtom } from "@/store/death";
import { sharedResearchMirrorAtom } from "@/store/research";
import { simEpochMsAtom, simRateAtom } from "@/store/simTime";
import { adoptShipResources, installShipResources } from "@/store/shipResources";

type Store = ReturnType<typeof createStore>;

let teardown: (() => void) | null = null;

export function installWorldBridge(store: Store): void {
  teardown?.();
  hydrateSavedAtoms(store);
  const uninstallResources = installShipResources();
  const world = getWorldState();
  store.set(simEpochMsAtom, world.simEpochMs);
  store.set(simRateAtom, world.simRate);
  store.set(wrecksMirrorAtom, world.wrecks);
  store.set(sharedResearchMirrorAtom, world.research.completedNodes);
  const local = getLocalPlayerId();

  const unsubscribe = worldAuthority.subscribe((e) => {
    switch (e.type) {
      case "wreck.created":
      case "wreck.changed":
      case "wreck.removed":
        store.set(wrecksMirrorAtom, getWorldState().wrecks);
        break;
      case "research.changed":
        store.set(sharedResearchMirrorAtom, getWorldState().research.completedNodes);
        break;
      case "player.changed":
        if (e.playerId === local) {
          refreshPlayerAtoms(store, e.keys);
          adoptShipResources(e.keys);
        }
        break;
      case "time.changed":
        if (e.epochMs !== undefined) store.set(simEpochMsAtom, e.epochMs);
        if (e.rate !== undefined) store.set(simRateAtom, e.rate);
        break;
    }
  });
  // The clock advances every frame through the atom; persist it by sampling.
  const unregister = registerCollector(() => {
    const w = getWorldState();
    w.simEpochMs = store.get(simEpochMsAtom);
    w.simRate = store.get(simRateAtom);
  });
  teardown = () => {
    unsubscribe();
    unregister();
    uninstallResources();
  };
}
