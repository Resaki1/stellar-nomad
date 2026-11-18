import { atom } from "jotai";
import { savedAtom } from "@/store/savedAtom";
import type { WreckRecord } from "@/save/types";
import type { FrameId } from "@/sim/frames";
import type { OperationOutcome, Transfer } from "@/sim/world/commands";
import { newOpId, runOperation } from "@/store/operations";
import { devTeleportAtom } from "@/store/dev";
import { holdSavedPose, relativePose } from "@/sim/shipPersistence";

/** A persistent marker where a ship was destroyed, holding its cargo. World state. */
export type Wreck = WreckRecord;

/** Whether the local ship is currently destroyed (player save). Written by operations. */
export const isDeadAtom = savedAtom("player", "isDead", false);

/** Read-only mirror of the world's wrecks, kept in sync from authority events (worldBridge.ts). */
export const wrecksMirrorAtom = atom<Wreck[]>([]);
export const wrecksAtom = atom((get) => get(wrecksMirrorAtom));

/** Ship death: wreck + cargo clear + dead state as ONE operation. */
export const dieAtom = atom(
  null,
  (
    get,
    _set,
    payload: {
      frameId: FrameId;
      /** Relative to `frameId`, km. */
      positionKm: [number, number, number];
    },
  ): OperationOutcome | null => {
    if (get(isDeadAtom)) return null;
    return runOperation({ type: "ship.destroy", opId: newOpId(), frameId: payload.frameId, positionKm: payload.positionKm });
  },
);

/** Clear the dead state, restore hull and commit the recovery pose (system frame, km) in one operation. */
export const respawnAtom = atom(null, (_get, set, positionKm: [number, number, number]): void => {
  const pose = relativePose(positionKm);
  runOperation({ type: "ship.respawn", opId: newOpId(), frameId: pose.frameId, positionKm: pose.positionKm }, (o) => {
    if (o.status !== "accepted") return;
    // Spaceship releases the hold when it applies the warp.
    holdSavedPose(true);
    set(devTeleportAtom, { positionKm });
  });
});

/** Take what fits from a wreck. The returned transfer exists only on acceptance. */
export const collectWreckAtom = atom(null, (_get, _set, wreckId: string): Transfer | null => {
  const out: { taken: Transfer | null } = { taken: null };
  runOperation({ type: "wreck.collect", opId: newOpId(), wreckId }, (o) => {
    if (o.status === "accepted" && o.result.type === "wreck.collect") out.taken = o.result.taken;
  });
  return out.taken;
});
