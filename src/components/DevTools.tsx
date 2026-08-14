"use client";

/**
 * Dev utilities — exposes debug helpers on `window.__dev` in development mode,
 * and the performance benchmark harness on `window.__bench`.
 *
 * Usage from browser console:
 *   __dev.grantAssay(100)          — grant 100 assay samples
 *   __dev.grantCargo("iron", 500)  — grant 500 iron
 *   __dev.unlockAll()              — complete all research nodes
 *   __dev.grantAllItems()          — add all craftable items to inventory
 *   __dev.resetProgress()          — reset research + modules to defaults
 *
 *   await __bench.sweep()          — measure every perf scenario (see
 *                                    docs/PERF_MEASUREMENT.md)
 *   await __bench.run("earth_650") — measure one scenario
 *   __bench.list()                 — available scenarios
 *   __bench.warp("earth_8")        — fly to a scenario and stay
 *   __bench.report()               — print live per-pass timings
 *   __bench.lastJson               — full result as JSON (copy this to share)
 */

import { useEffect } from "react";
import { useStore } from "jotai";

import { addAssaySamplesAtom, researchAtom } from "@/store/research";
import { addCargoAtom } from "@/store/cargo";
import { modulesAtom, addCraftedItemAtom } from "@/store/modules";
import { ITEMS, RESEARCH_NODES } from "@/data/content";
import { getBenchRunner, type BenchRunner } from "./space/perf/benchRunner";
import { getLumHarness, type LumHarness } from "./space/perf/lumHarness";

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
          equippedModules: {},
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

    // Shared with the Settings → Dev "run perf sweep" button.
    const bench = getBenchRunner(store);
    // Photometric counterpart to __bench — see docs/LIGHTING_PLAN.md §4.2.
    const lum = getLumHarness(store);

    type DevWindow = Window & {
      __dev?: typeof devApi;
      __bench?: BenchRunner;
      __lum?: LumHarness;
    };
    (window as DevWindow).__dev = devApi;
    (window as DevWindow).__bench = bench;
    (window as DevWindow).__lum = lum;
    console.log("[Dev] Debug utilities available via __dev. Try __dev.grantAssay(100)");
    console.log("[Dev] Perf harness via __bench. Try __bench.list() or await __bench.sweep()");
    console.log("[Dev] Photometry harness via __lum. Try __lum.units() or await __lum.probe()");

    return () => {
      delete (window as DevWindow).__dev;
      delete (window as DevWindow).__bench;
      delete (window as DevWindow).__lum;
    };
  }, [store]);

  return null;
}
