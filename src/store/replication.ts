/**
 * Replication points (M3.6), store side: world mirror, the local player's selection, the
 * placement preview, the placement/activation actions and the recovery transaction.
 */
import { atom, type createStore } from "jotai";
import { Vector3 } from "three";
import type { ReplicationPoint, SourceFinding } from "@/save/types";
import { getWorldState } from "@/save/activeSave";
import { getLocalPlayerShip } from "@/sim/entities";
import { depotBlocksPose } from "@/sim/industry/placement";
import { isFrameId } from "@/sim/frames";
import { holdSavedPose } from "@/sim/shipPersistence";
import { absoluteKm } from "@/sim/replication/clearance";
import { checkPlacement, resolveRecovery, type PlacementCheck, type RecoveryDestination } from "@/sim/replication/placement";
import { REPLICATION_KIT_ID, REPLICATION_TUNING, STARTER_POINT_ID, emergencePose } from "@/sim/replication/points";
import { requestReposition } from "@/sim/ship/reposition";
import { worldAuthority } from "@/sim/world/worldAuthority";
import type { OperationOutcome } from "@/sim/world/commands";
import { describeRejection, newOpId, runOperation } from "@/store/operations";
import { savedAtom } from "@/store/savedAtom";
import { modulesAtom } from "@/store/modules";
import { addToastAtom } from "@/store/toast";
import { isDeadAtom } from "@/store/death";
import { replicationPointsAtom } from "@/store/replicationMirror";

type Store = ReturnType<typeof createStore>;

export { replicationPointsAtom };

/** The local player's recovery selection (player save, written only by operations). */
export const playerReplicationAtom = savedAtom("player", "replication", { activeId: STARTER_POINT_ID });

export const activePointAtom = atom((get): ReplicationPoint | null => {
  const id = get(playerReplicationAtom).activeId;
  return get(replicationPointsAtom).find((p) => p.id === id) ?? null;
});

export const kitCountAtom = atom((get) => get(modulesAtom).consumables[REPLICATION_KIT_ID] ?? 0);

// ── Placement preview ──

/** Preview on/off (B). The pose follows the nose; the check runs at HUD rate. */
export const placementModeAtom = atom(false);

export const REFUSAL_TEXT: Record<string, string> = {
  invalid: "Invalid position",
  no_kit: "No kit",
  too_far: "Too far",
  near_body: "Too close to a body",
  near_rock: "Too close to a rock",
  near_depot: "Too close to a depot",
  emergence_blocked: "Emergence blocked",
  no_capacity: "Point limit reached",
  dead: "Ship destroyed",
};

/** The name typed on the placement card (selected on entry, so typing replaces it). */
export const placementNameAtom = atom("Point 1");

/** Mutable preview pose (frame-relative), written at render rate by the preview visual. */
export const placementPreview = {
  frameId: "system",
  positionKm: [0, 0, 0] as [number, number, number],
  quaternion: [0, 0, 0, 1] as [number, number, number, number],
  emergenceKm: [0, 0, 0] as [number, number, number],
  valid: false,
  check: { refusal: null, bodyAltKm: 0, bodyId: null, rockClearM: 0 } as PlacementCheck,
};

export interface PlacementStatus {
  refusal: string | null;
  kits: number;
  bodyAltKm: number;
  rockClearM: number;
  /** Nearest known (not depleted) hydrate / Fe-Ni source from the preview, km; null if none known. */
  fuelSourceKm: number | null;
  metalSourceKm: number | null;
}

export const placementStatusAtom = atom<PlacementStatus | null>(null);

/** A placement this far from any known hydrate source gets the warning line. */
export const RESOURCE_WARN_KM = 50;

const _fwd = new Vector3();
const _a = new Vector3();
const _b = new Vector3();

function nearestSourceKm(sources: readonly SourceFinding[], material: string): number | null {
  const p = placementPreview;
  absoluteKm(p.frameId, p.positionKm, _a);
  let best: number | null = null;
  for (const s of sources) {
    if (s.depleted || !(s.composition[material] > 0)) continue;
    const d = _a.distanceTo(absoluteKm(s.frameId, s.positionKm, _b));
    if (best === null || d < best) best = d;
  }
  return best;
}

/** Recompute the preview pose and its check (HUD rate, preview mode only). */
export function updatePlacementPreview(store: Store): void {
  const ship = getLocalPlayerShip();
  if (!ship) return;
  const p = placementPreview;
  const d = REPLICATION_TUNING.placeDistanceKm;
  _fwd.set(0, 0, 1).applyQuaternion(ship.quat);
  p.frameId = ship.frameId;
  p.positionKm[0] = ship.posKm.x + _fwd.x * d;
  p.positionKm[1] = ship.posKm.y + _fwd.y * d;
  p.positionKm[2] = ship.posKm.z + _fwd.z * d;
  p.quaternion[0] = ship.quat.x;
  p.quaternion[1] = ship.quat.y;
  p.quaternion[2] = ship.quat.z;
  p.quaternion[3] = ship.quat.w;
  const e = emergencePose(p, 0).positionKm;
  p.emergenceKm[0] = e[0];
  p.emergenceKm[1] = e[1];
  p.emergenceKm[2] = e[2];
  worldAuthority.world();
  const kits = store.get(kitCountAtom);
  checkPlacement(p, { frameId: ship.frameId, positionKm: [ship.posKm.x, ship.posKm.y, ship.posKm.z] }, kits, worldAuthority.asteroids, p.check, pose => depotBlocksPose(getWorldState().industry.depots, pose));
  p.valid = p.check.refusal === null;
  const sources = getWorldState().discoveries.sources;
  store.set(placementStatusAtom, {
    refusal: p.check.refusal ? REFUSAL_TEXT[p.check.refusal] ?? p.check.refusal : null,
    kits,
    bodyAltKm: p.check.bodyAltKm,
    rockClearM: p.check.rockClearM,
    fuelSourceKm: nearestSourceKm(sources, "hydrates"),
    metalSourceKm: nearestSourceKm(sources, "fe_ni_metal"),
  });
}

// ── Actions ──

/** Place a point at the current preview pose. One operation: kit, record, activation. */
export const placePointAtom = atom(null, (_get, set, payload: { name: string; opId?: string }): OperationOutcome => {
  const p = placementPreview;
  return runOperation(
    { type: "replication.place", opId: payload.opId ?? newOpId(), frameId: p.frameId, positionKm: [...p.positionKm], quaternion: [...p.quaternion], name: payload.name },
    (o) => {
      if (o.status === "accepted" && o.result.type === "replication.place") {
        set(placementModeAtom, false);
        set(addToastAtom, { kind: "success", message: "Point placed", detail: o.result.point.name });
      } else if (o.status === "rejected") {
        set(addToastAtom, { audio: "reject", kind: "warn", message: "Cannot place point", detail: REFUSAL_TEXT[o.reason] ?? describeRejection(o) });
      }
    },
  );
});

export const activatePointAtom = atom(null, (_get, set, pointId: string): OperationOutcome =>
  runOperation({ type: "replication.activate", opId: newOpId(), pointId }, (o) => {
    if (o.status === "accepted") set(addToastAtom, { kind: "success", message: "Active point set" });
    else if (o.status === "rejected" && o.reason !== "already_done") set(addToastAtom, { audio: "reject", kind: "warn", message: "Cannot activate", detail: describeRejection(o) });
  }),
);

export const deactivatePointAtom = atom(null, (_get, set): OperationOutcome =>
  runOperation({ type: "replication.deactivate", opId: newOpId() }, (o) => {
    if (o.status === "accepted") set(addToastAtom, { audio: "silent", message: "Active point: Origin" });
  }),
);

export const renamePointAtom = atom(null, (_get, _set, payload: { pointId: string; name: string }): OperationOutcome =>
  runOperation({ type: "replication.rename", opId: newOpId(), pointId: payload.pointId, name: payload.name }),
);

/** Nearest point within activation range of the ship (HUD rate), or null. */
export const nearbyPointAtom = atom<{ id: string; name: string; distKm: number; active: boolean } | null>(null);

export function updateNearbyPoint(store: Store): void {
  const ship = getLocalPlayerShip();
  const dead = store.get(isDeadAtom);
  let best: { id: string; name: string; distKm: number; active: boolean } | null = null;
  if (ship && !dead) {
    const activeId = store.get(playerReplicationAtom).activeId;
    for (const pt of store.get(replicationPointsAtom)) {
      // D1: the origin point is not a place you act on (no card, no marker).
      if (pt.starter || !isFrameId(pt.frameId)) continue;
      const d = ship.absPosKm.distanceTo(absoluteKm(pt.frameId, pt.positionKm, _a));
      if (d <= REPLICATION_TUNING.activateRangeKm && (!best || d < best.distKm)) best = { id: pt.id, name: pt.name, distKm: d, active: pt.id === activeId };
    }
  }
  const prev = store.get(nearbyPointAtom);
  const changed = !prev !== !best || (prev && best && (prev.id !== best.id || prev.active !== best.active || Math.abs(prev.distKm - best.distKm) > 0.05));
  if (changed) store.set(nearbyPointAtom, best);
}

// ── Recovery ──

/** Where recovery would put the ship now (death screen preview; the authority decides). */
export function previewRecovery(store: Store, mode: "active" | "starter"): RecoveryDestination {
  worldAuthority.world();
  return resolveRecovery(store.get(replicationPointsAtom), store.get(playerReplicationAtom).activeId, mode, worldAuthority.asteroids, pose => depotBlocksPose(getWorldState().industry.depots, pose));
}

/** The last accepted recovery (toast and harness). */
export const lastRecoveryAtom = atom<RecoveryDestination | null>(null);

/** The recovery transaction; the accepted destination drives one runtime reposition. */
export const recoverAtom = atom(null, (_get, set, mode: "active" | "starter"): OperationOutcome =>
  runOperation({ type: "ship.respawn", opId: newOpId(), mode }, (o) => {
    if (o.status !== "accepted" || o.result.type !== "ship.respawn") return;
    const d = o.result.destination;
    // Spaceship releases the hold when it applies the reposition.
    holdSavedPose(true);
    requestReposition({ frameId: d.frameId, relKm: [...d.positionKm], quaternion: [...d.quaternion], holdUntilReady: true });
    set(lastRecoveryAtom, d);
    if (d.fallback && d.fallback !== "chosen") {
      set(addToastAtom, { audio: "reject", kind: "warn", message: "Active point unavailable", detail: d.pointName });
    }
  }),
);
