"use client";

/**
 * Marker keys (docs/MARKER_SYSTEM_PLAN.md §2.5, §2.8): density cycle, hold-to-reveal, and the ping.
 * Tap the ping key to ping what the nose points at (a marker, a rock, else a direction); hold it to
 * clear your ping. One persistent ping per pilot (`world.rendezvous`), solo or in co-op.
 */
import { useEffect } from "react";
import { useStore } from "jotai";
import { Vector3 } from "three";
import { shipView } from "@/components/Camera/shipView";
import { isTypingTarget, keyFromEvent } from "@/input/keyboard";
import { getLocalPlayerShip } from "@/sim/entities";
import { isFrameId, SYSTEM_FRAME_ID } from "@/sim/frames";
import type { WorldOperation } from "@/sim/world/commands";
import { isDeadAtom } from "@/store/death";
import { keybindsAtom } from "@/store/keybinds";
import { MARKER_DENSITIES, markerPrefsAtom, markerRevealAtom } from "@/store/markerPrefs";
import { miningStateAtom } from "@/store/mining";
import { describeRejection, newOpId, runOperation } from "@/store/operations";
import { pingProbe, poiBuffer } from "@/store/poi";
import { playPingCue } from "@/store/pingSound";
import { getAsteroidClass } from "@/sim/asteroids/resources";
import { settingsIsOpenAtom } from "@/store/store";
import { systemConfigAtom } from "@/store/system";
import { addToastAtom } from "@/store/toast";

/** Holding the ping key this long clears your ping instead of placing one. */
const PING_HOLD_MS = 450;
/** A ping that hits nothing sits this far along the nose: a direction, with no meaningful distance. */
const BEARING_KM = 1e9;
/** Rocks stream in out to tens of km; the ping looks this far. */
const PING_ROCK_RANGE_M = 200_000;
const DENSITY_LABEL = { full: "All markers", essential: "Essential markers", off: "Markers off" } as const;

const _rel = new Vector3();

type At = NonNullable<Extract<WorldOperation, { type: "expedition.mark" }>["at"]>;

/** What the ping lands on, frame-relative: the nose's marker, a rock along the nose, else a direction. */
function pingTarget(store: ReturnType<typeof useStore>): { at: At; name: string } | null {
  const ship = getLocalPlayerShip();
  if (!ship || !isFrameId(ship.frameId)) return null;
  // A rock along the nose, out to the edge of the streamed fields (the mining lock stops at 10 km).
  const hit = pingProbe.castRock?.(PING_ROCK_RANGE_M);
  const aimedRaw = poiBuffer.aimed;
  const aimedKm = aimedRaw ? poiBuffer.pois.find((p) => p.id === aimedRaw.id)?.distanceKm ?? Infinity : Infinity;
  // The nearer of the two: a rock in front of a distant marker gets the ping.
  const aimed = aimedRaw && !aimedRaw.id.startsWith("rendezvous:") && !(hit && hit.distM / 1000 < aimedKm) ? aimedRaw : null;
  if (aimed) {
    if (aimed.id.startsWith("body:")) {
      // A body: just above its surface on our side, in its own frame (its centre is inside it).
      const id = aimed.id.slice(5);
      const body = store.get(systemConfigAtom).celestialBodies?.find((b) => b.id === id);
      if (body && isFrameId(id)) {
        const p = body.positionKm;
        _rel.set(ship.absPosKm.x - p[0], ship.absPosKm.y - p[1], ship.absPosKm.z - p[2]).setLength(body.radiusKm * 1.02);
        return { at: { frameId: id, positionKm: [_rel.x, _rel.y, _rel.z] }, name: aimed.name };
      }
    }
    return { at: { frameId: aimed.frameId ?? SYSTEM_FRAME_ID, positionKm: [...aimed.positionKm] }, name: aimed.name };
  }
  const locked = store.get(miningStateAtom).targetedAsteroid;
  const rockLocal = hit?.localM ?? locked?.positionLocal;
  if (rockLocal) {
    const cls = hit ? getAsteroidClass(store.get(systemConfigAtom), hit.fieldId, hit.instanceId, hit.chunkKey) : null;
    _rel.fromArray(rockLocal).sub(shipView.position).multiplyScalar(0.001);
    return { at: { frameId: ship.frameId, positionKm: [ship.posKm.x + _rel.x, ship.posKm.y + _rel.y, ship.posKm.z + _rel.z] },
      name: cls ? `${cls.name} rock` : "Asteroid" };
  }
  // Nothing hit: a marker in that direction (no distance, and never a transit destination).
  const f = shipView.forward;
  return {
    at: { frameId: ship.frameId, positionKm: [ship.posKm.x + f.x * BEARING_KM, ship.posKm.y + f.y * BEARING_KM, ship.posKm.z + f.z * BEARING_KM], bearing: true },
    name: "Marker",
  };
}

export default function MarkerControls(): null {
  const store = useStore();

  useEffect(() => {
    let pingDownAt = 0;
    let pingTimer = 0;
    const toast = (message: string, detail?: string, kind: "info" | "warn" = "info", silent = false): void =>
      store.set(addToastAtom, { kind, message, detail, ...(kind === "warn" ? { audio: "reject" as const } : silent ? { audio: "silent" as const } : {}) });
    const submit = (op: Extract<WorldOperation, { type: "expedition.mark" }>, done: string, detail?: string, silent = false): void => {
      runOperation(op, (o) => {
        if (o.status === "accepted") toast(done, detail, "info", silent);
        else if (o.status === "rejected") toast("Ping refused", describeRejection(o), "warn");
      });
    };
    const clearPing = (): void => {
      pingTimer = 0;
      pingDownAt = 0;
      submit({ type: "expedition.mark", sourceId: null, name: "", clear: true, opId: newOpId() }, "Ping cleared");
    };

    const blocked = (e: KeyboardEvent): boolean =>
      isTypingTarget(e.target) || e.metaKey || e.ctrlKey || store.get(settingsIsOpenAtom) || store.get(isDeadAtom);

    const onDown = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || blocked(e)) return;
      const key = keyFromEvent(e);
      const binds = store.get(keybindsAtom);
      if (binds.markerReveal.includes(key)) {
        if (!store.get(markerRevealAtom)) store.set(markerRevealAtom, true);
        return;
      }
      if (e.repeat) return;
      if (binds.markerDensity.includes(key)) {
        const prefs = store.get(markerPrefsAtom);
        const next = MARKER_DENSITIES[(MARKER_DENSITIES.indexOf(prefs.density) + 1) % MARKER_DENSITIES.length];
        store.set(markerPrefsAtom, { ...prefs, density: next });
        toast(DENSITY_LABEL[next]);
        return;
      }
      if (binds.ping.includes(key) && !pingDownAt) {
        pingDownAt = performance.now();
        pingTimer = window.setTimeout(clearPing, PING_HOLD_MS);
      }
    };
    const onUp = (e: KeyboardEvent): void => {
      const key = keyFromEvent(e);
      const binds = store.get(keybindsAtom);
      if (binds.markerReveal.includes(key)) store.set(markerRevealAtom, false);
      if (binds.ping.includes(key) && pingDownAt) {
        window.clearTimeout(pingTimer);
        pingDownAt = 0;
        if (!pingTimer) return; // the hold already cleared it
        pingTimer = 0;
        const target = pingTarget(store);
        if (!target) return;
        // The cue plays now, from the ping's direction (the notification stays silent).
        playPingCue(target.at.frameId, target.at.positionKm);
        submit({ type: "expedition.mark", sourceId: null, name: target.name.slice(0, 40), at: target.at, opId: newOpId() }, "Ping placed", target.name, true);
      }
    };
    const onBlur = (): void => {
      store.set(markerRevealAtom, false);
      window.clearTimeout(pingTimer);
      pingTimer = pingDownAt = 0;
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
      window.clearTimeout(pingTimer);
    };
  }, [store]);

  return null;
}
