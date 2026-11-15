/**
 * Store side of the world authority: hydrates the saved atoms and the world mirrors from the
 * active save, keeps the mirrors in sync from events, and samples the sim clock at flush.
 */
import type { createStore } from "jotai";
import { getWorldState, registerCollector } from "@/save/activeSave";
import { worldAuthority } from "@/sim/world/worldAuthority";
import { hydrateSavedAtoms } from "@/store/savedAtom";
import { wrecksMirrorAtom } from "@/store/death";
import { simEpochMsAtom, simRateAtom } from "@/store/simTime";

type Store = ReturnType<typeof createStore>;

let teardown: (() => void) | null = null;

export function installWorldBridge(store: Store): void {
  teardown?.();
  hydrateSavedAtoms(store);
  const world = getWorldState();
  store.set(simEpochMsAtom, world.simEpochMs);
  store.set(simRateAtom, world.simRate);
  store.set(wrecksMirrorAtom, world.wrecks);

  const unsubscribe = worldAuthority.subscribe((e) => {
    switch (e.type) {
      case "wreck.created":
      case "wreck.changed":
      case "wreck.removed":
        store.set(wrecksMirrorAtom, getWorldState().wrecks);
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
  };
}
