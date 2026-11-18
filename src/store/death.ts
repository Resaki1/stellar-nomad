import { atom } from "jotai";
import { savedAtom } from "@/store/savedAtom";
import type { WreckRecord } from "@/save/types";
import type { FrameId } from "@/sim/frames";
import type { OperationOutcome, Transfer } from "@/sim/world/commands";
import { newOpId, runOperation } from "@/store/operations";
import { addToastAtom } from "@/store/toast";

/** A persistent marker where a ship was destroyed, holding its cargo. World state. */
export type Wreck = WreckRecord;

/** Whether the local ship is currently destroyed (player save). Written by operations. */
export const isDeadAtom = savedAtom("player", "isDead", false);

/** Read-only mirror of the world's wrecks, kept in sync from authority events (worldBridge.ts). */
export const wrecksMirrorAtom = atom<Wreck[]>([]);
export const wrecksAtom = atom((get) => get(wrecksMirrorAtom));

/** What the last death left at its wreck (death screen); persisted, cleared by recovery. */
export const lastLossAtom = savedAtom("player", "lastLoss", null);

/** Ship death: wreck + cargo clear + dead state as ONE operation. */
export const dieAtom = atom(
  null,
  (
    get,
    set,
    payload: {
      frameId: FrameId;
      /** Relative to `frameId`, km. */
      positionKm: [number, number, number];
      cause?: "impact" | "abandon";
    },
  ): OperationOutcome | null => {
    if (get(isDeadAtom)) return null;
    return runOperation({ type: "ship.destroy", opId: newOpId(), frameId: payload.frameId, positionKm: payload.positionKm, cause: payload.cause });
  },
);

/** Take what fits from a wreck. The returned transfer exists only on acceptance. */
export const collectWreckAtom = atom(null, (get, set, payload: { wreckId: string; quiet?: boolean }): Transfer | null => {
  const out: { taken: Transfer | null } = { taken: null };
  runOperation({ type: "wreck.collect", opId: newOpId(), wreckId: payload.wreckId }, (o) => {
    if (o.status === "accepted" && o.result.type === "wreck.collect") {
      out.taken = o.result.taken;
      if (!o.result.removed) {
        const left = get(wrecksMirrorAtom).find((w) => w.id === payload.wreckId);
        if (left) set(addToastAtom, { audio: "silent", kind: "warn", message: "Salvage partial", detail: `Left: ${describeStores(left)}` });
      }
    } else if (o.status === "rejected" && o.reason === "no_capacity" && !payload.quiet) {
      set(addToastAtom, { audio: "reject", kind: "warn", message: "No room to salvage" });
    }
  });
  return out.taken;
});

/** "12 units · 2 items · 40 kg propellant" for a wreck's remaining stores. */
export function describeStores(w: Pick<WreckRecord, "items" | "consumables" | "fuelKg">): string {
  const units = Object.values(w.items).reduce((a, v) => a + v, 0);
  const items = Object.values(w.consumables).reduce((a, v) => a + v, 0);
  const parts: string[] = [];
  if (units > 0) parts.push(`${units} cargo units`);
  if (items > 0) parts.push(`${items} consumables`);
  if (w.fuelKg > 0) parts.push(`${Math.round(w.fuelKg)} kg propellant`);
  return parts.join(" · ") || "nothing";
}
