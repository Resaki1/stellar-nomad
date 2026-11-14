import { atom } from "jotai";
import { cargoAtom } from "@/store/cargo";
import { savedAtom } from "@/store/savedAtom";
import { getLocalPlayerId } from "@/save/playerId";
import type { WreckRecord } from "@/save/types";
import type { FrameId } from "@/sim/frames";
import { worldAuthority } from "@/sim/world/worldAuthority";

/** A persistent marker where a ship was destroyed, holding its cargo. World state. */
export type Wreck = WreckRecord;

/** Whether the local ship is currently destroyed (player save). */
export const isDeadAtom = savedAtom("player", "isDead", false);

/** Read-only mirror of the world's wrecks, kept in sync from authority events (worldBridge.ts). */
export const wrecksMirrorAtom = atom<Wreck[]>([]);
export const wrecksAtom = atom((get) => get(wrecksMirrorAtom));

/** Ship death: the player part here, the wreck through the authority. */
export const dieAtom = atom(
  null,
  (
    get,
    set,
    payload: {
      frameId: FrameId;
      /** Relative to `frameId`, km. */
      positionKm: [number, number, number];
      cargoItems: Record<string, number>;
    },
  ) => {
    if (get(isDeadAtom)) return;
    set(isDeadAtom, true);
    if (Object.values(payload.cargoItems).some((v) => v > 0)) {
      worldAuthority.submit(
        { type: "wreck.create", frameId: payload.frameId, positionKm: payload.positionKm, items: { ...payload.cargoItems } },
        getLocalPlayerId(),
      );
    }
    // Clear cargo immediately so a reload doesn't let the player keep items.
    set(cargoAtom, { ...get(cargoAtom), items: {} });
  },
);

/** Respawn the player: clear isDead (wrecks persist). */
export const respawnAtom = atom(null, (_get, set) => {
  set(isDeadAtom, false);
});

/**
 * Take up to `cargoRemaining` units from a wreck. Returns what was granted (only on acceptance);
 * partial collection leaves the rest in the wreck.
 */
export const collectWreckAtom = atom(
  null,
  (get, _set, payload: { wreckId: string; cargoRemaining: number }): Record<string, number> => {
    const wreck = get(wrecksMirrorAtom).find((w) => w.id === payload.wreckId);
    if (!wreck) return {};
    const take: Record<string, number> = {};
    let budget = payload.cargoRemaining;
    for (const [resourceId, amount] of Object.entries(wreck.items)) {
      const n = Math.min(amount, budget);
      if (n > 0) {
        take[resourceId] = n;
        budget -= n;
      }
    }
    if (Object.keys(take).length === 0) return {};
    const ok = worldAuthority.submit({ type: "wreck.take", wreckId: wreck.id, items: take }, getLocalPlayerId());
    return ok ? take : {};
  },
);
