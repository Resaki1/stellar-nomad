import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { cargoAtom } from "@/store/cargo";

// ---------------------------------------------------------------------------
// Wreck — a persistent marker at the location where the ship was destroyed.
// Each wreck holds the cargo the player had at death.
// ---------------------------------------------------------------------------

export type Wreck = {
  id: string;
  /** Position in simulation km. */
  positionKm: [number, number, number];
  /** Cargo items at time of death (resourceId → amount). */
  items: Record<string, number>;
  /** Timestamp (ms) when the wreck was created. */
  createdAt: number;
};

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------

export type DeathPersisted = {
  /** True if the player is currently dead (survived a reload). */
  isDead: boolean;
  /** All wrecks in the world. */
  wrecks: Wreck[];
};

export const deathAtom = atomWithStorage<DeathPersisted>("death-v1", {
  isDead: false,
  wrecks: [],
});

// ---------------------------------------------------------------------------
// Derived / convenience
// ---------------------------------------------------------------------------

/** Whether the ship is currently destroyed. */
export const isDeadAtom = atom((get) => get(deathAtom).isDead);

/** All active wrecks. */
export const wrecksAtom = atom((get) => get(deathAtom).wrecks);

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

let nextWreckId = 1;

/** Trigger ship death: set isDead, create wreck with current cargo. */
export const dieAtom = atom(
  null,
  (
    get,
    set,
    payload: {
      positionKm: [number, number, number];
      cargoItems: Record<string, number>;
    },
  ) => {
    const prev = get(deathAtom);
    // Don't double-die
    if (prev.isDead) return;

    const wreck: Wreck = {
      id: `wreck-${Date.now()}-${nextWreckId++}`,
      positionKm: payload.positionKm,
      items: { ...payload.cargoItems },
      createdAt: Date.now(),
    };

    // Only add wreck if there was cargo to recover
    const hasItems = Object.values(payload.cargoItems).some((v) => v > 0);

    set(deathAtom, {
      isDead: true,
      wrecks: hasItems ? [...prev.wrecks, wreck] : prev.wrecks,
    });

    // Clear cargo immediately so a reload doesn't let the player keep items
    const cargoState = get(cargoAtom);
    set(cargoAtom, { ...cargoState, items: {} });
  },
);

/** Respawn the player: clear isDead (wrecks persist). */
export const respawnAtom = atom(null, (get, set) => {
  const prev = get(deathAtom);
  set(deathAtom, { ...prev, isDead: false });
});

/**
 * Collect resources from a wreck into cargo.
 * Returns the items that were actually picked up (for toast/feedback).
 * Partial collection is supported — remaining items stay in the wreck.
 */
export const collectWreckAtom = atom(
  null,
  (
    get,
    set,
    payload: { wreckId: string; cargoRemaining: number },
  ): Record<string, number> => {
    const prev = get(deathAtom);
    const wreckIdx = prev.wrecks.findIndex((w) => w.id === payload.wreckId);
    if (wreckIdx === -1) return {};

    const wreck = prev.wrecks[wreckIdx];
    const collected: Record<string, number> = {};
    const leftover: Record<string, number> = {};
    let budget = payload.cargoRemaining;

    for (const [resourceId, amount] of Object.entries(wreck.items)) {
      if (amount <= 0) continue;
      const take = Math.min(amount, budget);
      if (take > 0) {
        collected[resourceId] = take;
        budget -= take;
      }
      const remain = amount - take;
      if (remain > 0) {
        leftover[resourceId] = remain;
      }
    }

    const hasLeftover = Object.keys(leftover).length > 0;
    const newWrecks = hasLeftover
      ? prev.wrecks.map((w, i) =>
          i === wreckIdx ? { ...w, items: leftover } : w,
        )
      : prev.wrecks.filter((_, i) => i !== wreckIdx);

    set(deathAtom, { ...prev, wrecks: newWrecks });
    return collected;
  },
);
