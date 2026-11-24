/** `__test.coop` — co-op session control and inspection for the headless two-browser gates. */
import { getActiveSave, inSession, saveInfo, sessionBlocked } from "@/save/activeSave";
import { getLocalPlayerId } from "@/save/playerId";
import { coopLog, coopSnapshot, remotePoses } from "@/net/coopState";
import { guestFaults, guestSentCount, guestState, leaveSession } from "@/net/guestController";
import { chosenPilotName, defaultPilotName, pilotName, setPilotName } from "@/net/pilotName";
import { remoteBurstLog, vfxEventsAtom } from "@/store/vfx";
import { poiBuffer } from "@/store/poi";
import type { CoopFault } from "@/net/devFault";
import { titleUrl } from "@/components/AppShell/appState";
import { holdHostIncoming, hostClient, inspectHost, startHosting, stopHosting } from "@/net/hostController";
import { worldAuthority } from "@/sim/world/worldAuthority";
import { getLocalPlayerShip } from "@/sim/entities";
import { frameOriginKm } from "@/sim/frames";
import { LOD, Quaternion, Vector3 } from "three";
import { testProbe } from "./testProbe";
import type { createStore } from "jotai";
import { devTeleportAtom } from "@/store/dev";
import { systemConfigAtom } from "@/store/system";
import { effectiveShipConfigAtom } from "@/store/shipConfig";
import { getActiveAsteroidRuntime } from "@/sim/asteroids/runtimeContext";
import { computeMiningDurationS } from "@/sim/asteroids/resources";
import { buildMineOperation } from "@/sim/asteroids/mineOperation";
import { makeMineResolver } from "@/sim/asteroids/mineResolve";
import { getDifficulty } from "@/sim/difficulty";
import { activeSystem } from "@/sim/systemRegistry";

type RockRef = { fieldId: string; chunkKey: string; instanceId: number };

/** System-frame km of a remote pilot's newest pose (first remote when no id). */
function remoteAbsKm(id?: string): Vector3 | null {
  const e = id ? remotePoses.get(id) : remotePoses.values().next().value;
  const s = e?.[e.length - 1];
  if (!s) return null;
  return frameOriginKm(s.f, new Vector3()).add(new Vector3(s.p[0], s.p[1], s.p[2]));
}

type Store = ReturnType<typeof createStore>;

/** Pilot markers drawn on screen (POIMarkers `.mk--pilot` in glyph or bracket mode), in the pilot's tint. */
function pilotMarkers() {
  return Array.from(document.querySelectorAll<HTMLElement>(".mk--pilot:not(.mk--edge)")).map((el) => {
    const name = el.querySelector<HTMLElement>(".mk__name");
    const r = el.querySelector(".mk__glyph")!.getBoundingClientRect();
    return {
      id: el.dataset.id ?? "",
      shown: !el.classList.contains("mk--hidden"),
      name: name && name.style.display !== "none" ? name.textContent ?? "" : "",
      distance: el.querySelector(".mk__dist")?.textContent ?? "",
      x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
      color: getComputedStyle(el).color,
    };
  });
}

export function createCoopHarness(store: Store) {
  return {
    /** Open the active world to friends; resolves with the room code. */
    host: (): Promise<string> => startHosting(),
    /** Host: close the session (no reload unless asked). */
    close: (reload = false): Promise<void> => stopHosting(undefined, reload),
    /** Guest: reload into `?join=CODE` (the driver then waits for the harness). */
    join(code: string): true {
      const u = new URL(window.location.href);
      u.searchParams.delete("autostart");
      u.searchParams.set("join", code);
      window.location.replace(u.toString());
      return true;
    },
    status() {
      const c = coopSnapshot();
      const client = c.role === "host" ? hostClient() : guestState()?.client ?? null;
      const now = performance.now();
      return {
        ...c,
        playerId: getLocalPlayerId(),
        connected: worldAuthority.connected,
        session: client ? { state: client.status, gen: client.generation, revision: client.revision, waiting: client.waiting(), storageFailed: client.storageFailed } : null,
        remotes: Array.from(remotePoses.entries()).map(([id, b]) => {
          const s = b[b.length - 1];
          return { id, ageMs: s ? Math.round(now - s.at) : null, frameId: s?.f ?? null, p: s?.p ?? null };
        }),
      };
    },
    log: (): string[] => coopLog.slice(),
    /** The outstanding intent, if any. */
    pending() {
      const client = coopSnapshot().role === "host" ? hostClient() : guestState()?.client ?? null;
      return client?.pending ?? null;
    },
    /** Host only: the worker's authoritative record of a player (or session info). */
    hostRecord: (playerId?: string): Promise<unknown> => inspectHost(playerId),
    /** This tab's mirror of the local player. */
    mirror() {
      const p = getActiveSave()?.data.players[getLocalPlayerId()];
      return p ? { cargo: structuredClone(p.cargo), minedLifetime: p.minedLifetime, stream: p.stream } : null;
    },
    shipLods(): number[] {
      const levels: number[] = [];
      testProbe.scene?.traverseVisible((object) => {
        if (object instanceof LOD && object.name === "starterSurveyLOD") levels.push(object.getCurrentLevel());
      });
      return levels;
    },
    /** Distance (km) from our ship to a remote pilot. */
    remoteDistanceKm(id?: string): number | null {
      const r = remoteAbsKm(id);
      const ship = getLocalPlayerShip();
      return r && ship ? r.distanceTo(ship.absPosKm) : null;
    },
    /** Distance (km), our speed and closing speed (m/s) toward a remote pilot. */
    remoteNav(id?: string) {
      const r = remoteAbsKm(id);
      const ship = getLocalPlayerShip();
      if (!r || !ship) return null;
      const d = r.sub(ship.absPosKm);
      const dist = d.length();
      const v = ship.velKmps;
      return { distKm: dist, speedMps: v.length() * 1000, closingMps: dist > 0 ? (v.dot(d) / dist) * 1000 : 0 };
    },
    /** Dev warp: park `offsetKm` behind (and a little above) a remote pilot, facing them. */
    meetRemote(offsetKm = 0.06, id?: string): boolean {
      const e = id ? remotePoses.get(id) : remotePoses.values().next().value;
      const s = e?.[e.length - 1];
      const r = remoteAbsKm(id);
      if (!s || !r) return false;
      const q = new Quaternion(s.q[0], s.q[1], s.q[2], s.q[3]);
      const pos = new Vector3(0, 0.25, -1).normalize().applyQuaternion(q).multiplyScalar(offsetKm).add(r);
      const face = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), r.clone().sub(pos).normalize());
      store.set(devTeleportAtom, { positionKm: [pos.x, pos.y, pos.z], quaternion: [face.x, face.y, face.z, face.w] });
      return true;
    },
    /** Dev aim: point our nose at a system-km point (no rotation charge). */
    faceKm(p: [number, number, number]): boolean {
      const ship = getLocalPlayerShip();
      if (!ship) return false;
      const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), new Vector3(...p).sub(ship.absPosKm).normalize());
      ship.quat.copy(q);
      ship.prevQuat.copy(q);
      ship.angVel.set(0, 0, 0);
      return true;
    },
    /** Dev aim: point our nose at a remote pilot, or straight away from it (no rotation charge). */
    faceRemote(id?: string, away = false): boolean {
      const r = remoteAbsKm(id);
      const ship = getLocalPlayerShip();
      if (!r || !ship) return false;
      const dir = r.sub(ship.absPosKm).normalize();
      if (away) dir.negate();
      const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), dir);
      ship.quat.copy(q);
      ship.prevQuat.copy(q);
      ship.angVel.set(0, 0, 0);
      return true;
    },
    /** Per-frame rendered remote-ship rows for `ms` (see remoteShipProbe for the columns). */
    async probe(ms = 3000): Promise<number[][]> {
      const { remoteShipProbe } = await import("@/components/Coop/CoopLayer");
      remoteShipProbe.rows = [];
      remoteShipProbe.on = true;
      await new Promise((r) => setTimeout(r, ms));
      remoteShipProbe.on = false;
      return remoteShipProbe.rows;
    },
    /** Active world id (fixture cleanup). */
    worldId: (): string | null => getActiveSave()?.meta.id ?? null,
    worldName: (): string | null => getActiveSave()?.meta.name ?? null,
    /** Loaded rocks nearest our ship (optionally one field), with this player's beam time. */
    rocks(fieldId?: string, n = 10) {
      const rt = getActiveAsteroidRuntime();
      const ship = getLocalPlayerShip();
      const system = store.get(systemConfigAtom);
      const speed = store.get(effectiveShipConfigAtom).miningSpeedMult;
      const out: { fieldId: string; chunkKey: string; instanceId: number; radiusM: number; distKm: number; mineS: number }[] = [];
      if (!rt || !ship) return out;
      for (const f of system.asteroidFields ?? []) {
        if (fieldId && f.id !== fieldId) continue;
        rt.getFieldRuntime(f.id)?.chunks.forEach((chunk, chunkKey) => {
          for (const m in chunk.instancesByModel) {
            const inst = chunk.instancesByModel[m];
            for (let i = 0; i < inst.count; i++) {
              const p = [0, 1, 2].map((k) => f.anchorKm[k] + chunk.originKm[k] + inst.positionsM[i * 3 + k] / 1000);
              out.push({
                fieldId: f.id, chunkKey, instanceId: inst.instanceIds[i] >>> 0, radiusM: inst.radiiM[i],
                distKm: Math.hypot(p[0] - ship.absPosKm.x, p[1] - ship.absPosKm.y, p[2] - ship.absPosKm.z),
                mineS: computeMiningDurationS(inst.radiiM[i]) / speed,
              });
            }
          }
        });
      }
      return out.sort((a, b) => a.distKm - b.distKm).slice(0, n);
    },
    /** Chunks of a field this page streams. */
    loadedChunks: (fieldId: string): number => getActiveAsteroidRuntime()?.getFieldRuntime(fieldId)?.chunks.size ?? 0,
    /** Is a rock still rendered here, and is it depleted in this page's world view? */
    rockState(r: RockRef) {
      let loaded = false;
      const chunk = getActiveAsteroidRuntime()?.getFieldRuntime(r.fieldId)?.getChunk(r.chunkKey);
      for (const m in chunk?.instancesByModel ?? {}) {
        const inst = chunk!.instancesByModel[m];
        for (let i = 0; i < inst.count && !loaded; i++) loaded = inst.instanceIds[i] >>> 0 === r.instanceId >>> 0;
      }
      return { chunkLoaded: !!chunk, loaded, destroyed: worldAuthority.destroyedAsteroids.chunk(r.fieldId, r.chunkKey).has(r.instanceId >>> 0) };
    },
    /** Depleted rocks in this page's world view. */
    destroyedCount(): number {
      const d = getActiveSave()?.data.world.asteroidDeltas ?? {};
      return Object.values(d).reduce((n, chunks) => n + Object.values(chunks).reduce((m, ids) => m + ids.length, 0), 0);
    },
    /** The client's yield preview (as MiningSystem builds it) and the solo authority's resolved yield. */
    predict(r: RockRef & { radiusM: number }) {
      const system = store.get(systemConfigAtom);
      const preview = buildMineOperation(system, r, { miningEfficiencyMult: store.get(effectiveShipConfigAtom).miningEfficiencyMult }, "preview").yield;
      const me = getActiveSave()?.data.players[getLocalPlayerId()];
      const solo = me ? makeMineResolver(activeSystem, getDifficulty)(r.fieldId, r.chunkKey, r.instanceId, me) : null;
      return { preview, solo: solo?.yield ?? null, frameId: solo?.frameId ?? null, positionKm: solo?.positionKm ?? null, radiusM: solo?.radiusM ?? null };
    },
    cutAfterCommit: (): boolean => guestFaults.cutAfterCommit(),
    /** Latency spike: hold this tab's incoming session messages for `ms` (delivered in order). */
    holdIncoming: (ms: number): boolean => (coopSnapshot().role === "host" ? holdHostIncoming(ms) : guestFaults.holdIncoming(ms)),
    forceReconnect: (): boolean => guestFaults.forceReconnect(),
    /** Dev fault switch (window.__coopFault), also readable at the title. */
    fault(k: CoopFault, on = true): boolean {
      const w = window as { __coopFault?: Partial<Record<CoopFault, boolean>> };
      w.__coopFault = { ...w.__coopFault, [k]: on };
      return on;
    },
    /** The name other pilots see (device-wide; a live session relabels us at once). */
    name: (n?: string): string => {
      if (n !== undefined) setPilotName(n);
      return pilotName();
    },
    /** Save-write state: solo writes live, or a session holding the mirror. */
    writes() {
      const i = saveInfo();
      return { suspended: i.suspended, inSession: inSession(), blocked: { ...sessionBlocked } };
    },
    /** Pilot names on screen right now (green POI markers, what a player reads). */
    labels: (): string[] => pilotMarkers().filter((m) => m.shown).map((m) => m.name),
    /** Pilot POI markers and edge triangles as drawn: name, distance text, box, shown. */
    markers: () => ({
      targetedId: poiBuffer.targetedId,
      markers: pilotMarkers(),
      arrows: Array.from(document.querySelectorAll<HTMLElement>(".mk--pilot.mk--edge")).map((el) => {
        const r = el.querySelector(".mk__glyph")!.getBoundingClientRect();
        return { id: el.dataset.id ?? "", shown: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), color: getComputedStyle(el).color };
      }),
    }),
    /** Remote slots' drawn plume/beam over `ms` (CoopLayer remoteFxProbe). */
    async fx(ms = 1000) {
      const { remoteFxProbe } = await import("@/components/Coop/CoopLayer");
      remoteFxProbe.reset();
      await new Promise((r) => setTimeout(r, ms));
      return remoteFxProbe.slots.filter((x) => x.id).map((x) => ({ ...x }));
    },
    /** Remote slots' drawn plume/beam right now (no reset). */
    async fxNow() {
      const { remoteFxProbe } = await import("@/components/Coop/CoopLayer");
      return remoteFxProbe.slots.filter((x) => x.id).map((x) => ({ ...x }));
    },
    /** Destruction bursts shown here for other pilots' mined rocks. */
    collisions: () => store.get(vfxEventsAtom).filter((e) => e.type === "collision"),
    route: () => guestState()?.link?.route() ?? null,
    bursts: () => remoteBurstLog.map((b) => ({ ...b, ageMs: Math.round(performance.now() - b.at) })),
    /** The chosen name ("" = default) and the default. */
    nameInfo: () => ({ chosen: chosenPilotName(), fallback: defaultPilotName(), effective: pilotName() }),
    /** Messages handed to the guest link so far. */
    sent: (): number => guestSentCount(),
    /**
     * Guest: leave as the Settings button does, but watch `observeMs` before going to the title:
     * nothing may be sent once left. Returns the counters (the page then navigates).
     */
    async leave(observeMs = 3000) {
      const before = guestSentCount();
      leaveSession();
      const at = guestSentCount();
      await new Promise((r) => setTimeout(r, observeMs));
      const after = guestSentCount();
      const res = { before, at, after, connected: worldAuthority.connected, role: coopSnapshot().role, remotes: remotePoses.size, playerId: getLocalPlayerId() };
      setTimeout(() => window.location.assign(titleUrl()), 50);
      return res;
    },
  };
}
