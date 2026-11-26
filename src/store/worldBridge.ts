/**
 * Store side of the world authority: hydrates the saved atoms and the world mirrors from the
 * active save, keeps the mirrors in sync from events, and samples the sim clock at flush.
 */
import type { createStore } from "jotai";
import { getActiveSave, getWorldState, inSession, registerCollector } from "@/save/activeSave";
import { getLocalPlayerId } from "@/save/playerId";
import { worldAuthority } from "@/sim/world/worldAuthority";
import { hydrateSavedAtoms, refreshPlayerAtoms } from "@/store/savedAtom";
import { playPingCue } from "@/store/pingSound";
import { addToastAtom } from "@/store/toast";
import { wrecksMirrorAtom } from "@/store/death";
import { rendezvousAtom } from "@/store/discoveries";
import { announceResearchAtom, discoveriesMirrorAtom, sharedResearchMirrorAtom } from "@/store/research";
import { simEpochMsAtom, simRateAtom } from "@/store/simTime";
import { adoptShipResources, installShipResources, shipReq } from "@/store/shipResources";
import { installHullAlert } from "@/store/hullAlert";
import { installFirstLead } from "@/store/firstLead";
import { replicationPointsAtom } from "@/store/replicationMirror";
import { resetReposition } from "@/sim/ship/reposition";
import { targetedPOIAtom } from "@/store/transit";
import { industryAtom } from "@/store/industry";
import { settingsIsOpenAtom } from "@/store/store";
import { isSimPaused } from "@/sim/simPause";

type Store = ReturnType<typeof createStore>;

let teardown: (() => void) | null = null;

export function installWorldBridge(store: Store): void {
  teardown?.();
  hydrateSavedAtoms(store);
  const uninstallResources = installShipResources();
  const uninstallHullAlert = installHullAlert(store);
  const uninstallFirstLead = installFirstLead(store);
  const world = getWorldState();
  store.set(simEpochMsAtom, world.simEpochMs);
  store.set(simRateAtom, world.simRate);
  store.set(wrecksMirrorAtom, world.wrecks);
  store.set(rendezvousAtom, world.rendezvous);
  store.set(sharedResearchMirrorAtom, world.research.completedNodes);
  store.set(discoveriesMirrorAtom, world.discoveries);
  store.set(replicationPointsAtom, world.replication.points);
  store.set(industryAtom, world.industry);
  worldAuthority.localFuelReserveKg = () => shipReq.reservedKg;
  const active = getActiveSave();
  let last = performance.now();
  const pulse = setInterval(() => {
    const now = performance.now();
    const elapsedS = (now - last) / 1000;
    last = now;
    if (getActiveSave() === active && !inSession() && !worldAuthority.connected && !isSimPaused() && !store.get(settingsIsOpenAtom)) {
      worldAuthority.local.tickIndustry(elapsedS);
    }
  }, 1000);
  const offSettings = store.sub(settingsIsOpenAtom, () => { last = performance.now(); });
  resetReposition();
  const local = getLocalPlayerId();

  const refreshFixTarget = () => {
    const target = store.get(targetedPOIAtom);
    if (!target?.id.startsWith("rendezvous:")) return;
    const world = getWorldState();
    const fix = world.rendezvous[target.id.slice("rendezvous:".length)];
    if (!fix || (fix.sourceId && !world.discoveries.sources.some(s => s.id === fix.sourceId && !s.depleted)) ||
        fix.frameId !== target.frameId || fix.positionKm.some((x, i) => x !== target.positionKm[i])) {
      store.set(targetedPOIAtom, null);
    }
  };
  const unsubscribe = worldAuthority.subscribe((e) => {
    switch (e.type) {
      case "expedition.given":
        if (e.to === local) store.set(addToastAtom, { kind: "success", message: "Supplies received",
          detail: getWorldState().members[e.by]?.name, values: [{ id: e.itemId, amount: e.amount, unit: e.kind === "fuel" ? "kg" : undefined }] });
        break;
      case "mine.shared": {
        // WP5: a crewmate finished a rock this pilot helped mine (the finisher's own toast is the "Mined" one).
        const mine = e.shares[local];
        if (!mine || e.by === local) break;
        const values = Object.entries(mine.granted).sort((a, b) => b[1] - a[1]).map(([id, amount]) => ({ id, amount }));
        const lost = Object.values(mine.overflow).reduce((a, n) => a + n, 0);
        const by = getWorldState().members[e.by]?.name || "Replicant";
        store.set(addToastAtom, { kind: values.length ? "success" : "info", message: "Shared haul", values,
          detail: lost > 0 ? `with ${by} · hold full, ${lost} left behind` : `with ${by}` });
        break;
      }
      case "expedition.marked": {
        const fixes = getWorldState().rendezvous;
        // A crewmate's new ping announces itself (the sound comes from the notification).
        if (e.by && e.by !== local && fixes[e.by] && JSON.stringify(fixes[e.by]) !== JSON.stringify(store.get(rendezvousAtom)[e.by])) {
          store.set(addToastAtom, { kind: "info", audio: "silent", message: "Crew ping", detail: `${getWorldState().members[e.by]?.name || "Replicant"} · ${fixes[e.by].name}` });
          playPingCue(fixes[e.by].frameId, fixes[e.by].positionKm);
        }
        store.set(rendezvousAtom, fixes);
        refreshFixTarget();
        break;
      }
      case "wreck.created":
      case "wreck.changed":
      case "wreck.removed":
        store.set(wrecksMirrorAtom, getWorldState().wrecks);
        break;
      case "research.changed":
        if (e.unlockedNodeId) store.set(announceResearchAtom, e.unlockedNodeId);
        store.set(sharedResearchMirrorAtom, getWorldState().research.completedNodes);
        break;
      case "discoveries.changed": {
        const d = getWorldState().discoveries;
        store.set(discoveriesMirrorAtom, d);
        refreshFixTarget();
        // A destination rock that was mined or destroyed (by anyone) is no place to go.
        const t = store.get(targetedPOIAtom);
        if (t?.id.startsWith("source:")) {
          const s = d.sources.find((x) => `source:${x.id}` === t.id);
          if (!s || s.depleted) store.set(targetedPOIAtom, null);
        }
        break;
      }
      case "industry.changed":
        store.set(industryAtom, getWorldState().industry);
        break;
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
    clearInterval(pulse);
    offSettings();
    unsubscribe();
    unregister();
    uninstallResources();
    uninstallHullAlert();
    uninstallFirstLead();
  };
}
