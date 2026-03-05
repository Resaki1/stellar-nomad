"use client";

/**
 * Dev utilities — exposes debug helpers on `window.__dev` in development mode.
 *
 * Usage from browser console:
 *   __dev.grantAssay(100)          — grant 100 assay samples
 *   __dev.grantCargo("iron", 500)  — grant 500 iron
 *   __dev.unlockAll()              — complete all research nodes
 *   __dev.grantAllItems()          — add all craftable items to inventory
 *   __dev.resetProgress()          — reset research + modules to defaults
 */

import { useEffect } from "react";
import { useStore } from "jotai";

import { addAssaySamplesAtom, researchAtom } from "@/store/research";
import { addCargoAtom } from "@/store/cargo";
import { modulesAtom, addCraftedItemAtom } from "@/store/modules";
import { ITEMS, RESEARCH_NODES } from "@/data/content";

export default function DevTools() {
  const store = useStore();

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;

    const devApi = {
      /** Grant assay samples. */
      grantAssay(amount = 50) {
        store.set(addAssaySamplesAtom, amount);
        console.log(`[Dev] Granted ${amount} assay samples.`);
      },

      /** Grant cargo resource by ID. */
      grantCargo(resourceId: string, amount = 100) {
        store.set(addCargoAtom, { resourceId, amount });
        console.log(`[Dev] Granted ${amount} ${resourceId}.`);
      },

      /** Complete all research nodes instantly. */
      unlockAll() {
        const allIds = RESEARCH_NODES.map((n) => n.id);
        const state = store.get(researchAtom);
        store.set(researchAtom, {
          ...state,
          completedNodes: allIds,
          activeResearch: null,
          assaySamples: state.assaySamples + 9999,
        });
        console.log(`[Dev] All ${allIds.length} research nodes completed.`);
      },

      /** Add all craftable items to inventory (1 of each module, 5 of each consumable). */
      grantAllItems() {
        for (const item of ITEMS) {
          if (item.type === "consumable") {
            for (let i = 0; i < 5; i++) {
              store.set(addCraftedItemAtom, item.id);
            }
          } else {
            store.set(addCraftedItemAtom, item.id);
          }
        }
        console.log(`[Dev] All items granted.`);
      },

      /** Reset research + modules to defaults. */
      resetProgress() {
        store.set(researchAtom, {
          assaySamples: 0,
          completedNodes: [],
          activeResearch: null,
        });
        store.set(modulesAtom, {
          ownedModules: [],
          equipped: {},
          consumables: {},
          consumableCooldowns: {},
          hotbar: Array(10).fill(null),
        });
        console.log("[Dev] Progress reset.");
      },

      /** List all available resource IDs (for grantCargo). */
      listResources() {
        console.table(
          ITEMS.flatMap((i) =>
            Object.keys(i.recipe).map((r) => ({ resource: r }))
          ).filter(
            (v, i, a) => a.findIndex((x) => x.resource === v.resource) === i
          )
        );
      },
    };

    (window as any).__dev = devApi;
    console.log("[Dev] Debug utilities available via __dev. Try __dev.grantAssay(100)");

    return () => {
      delete (window as any).__dev;
    };
  }, [store]);

  return null;
}
