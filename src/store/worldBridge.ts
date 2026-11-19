/**
 * Store side of the world authority: hydrates the saved atoms and the world mirrors from the
 * active save, keeps the mirrors in sync from events, and samples the sim clock at flush.
 */
import type { createStore } from "jotai";
import { getWorldState, inSession, registerCollector } from "@/save/activeSave";
import { getLocalPlayerId } from "@/save/playerId";
import { worldAuthority } from "@/sim/world/worldAuthority";
import { hydrateSavedAtoms, refreshPlayerAtoms } from "@/store/savedAtom";
import { wrecksMirrorAtom } from "@/store/death";
import { discoveriesMirrorAtom, sharedResearchMirrorAtom } from "@/store/research";
import { simEpochMsAtom, simRateAtom } from "@/store/simTime";
import { adoptShipResources, installShipResources } from "@/store/shipResources";
import { replicationPointsAtom } from "@/store/replicationMirror";
import { resetReposition } from "@/sim/ship/reposition";
import { targetedPOIAtom } from "@/store/transit";

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
  store.set(discoveriesMirrorAtom, world.discoveries);
  store.set(replicationPointsAtom, world.replication.points);
  resetReposition();
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
      case "discoveries.changed": {
        const d = getWorldState().discoveries;
        store.set(discoveriesMirrorAtom, d);
        // A destination rock that was mined or destroyed (by anyone) is no place to go.
        const t = store.get(targetedPOIAtom);
        if (t?.id.startsWith("source:")) {
          const s = d.sources.find((x) => `source:${x.id}` === t.id);
          if (!s || s.depleted) store.set(targetedPOIAtom, null);
        }
        break;
      }
      case "replication.changed":
        store.set(replicationPointsAtom, getWorldState().replication.points);
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
  // In a session the host owns the clock (ClockFollower eases toward it): never write it back.
  const unregister = registerCollector(() => {
    if (inSession()) return;
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
