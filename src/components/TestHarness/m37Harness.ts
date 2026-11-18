/**
 * `__test.gameplay.m37` — M3.7/M3.8 hooks for scripts/drive-examples/gameplay-m37.mjs:
 * regional opportunities, the lunar site, projects, hints, difficulty and end-to-end sessions.
 */
import type { createStore } from "jotai";
import { Vector3 } from "three";
import { COMMS_MESSAGES, RETIRED_COMMS_IDS, type CommsMessage } from "@/data/commsMessages";
import { ITEMS, RESEARCH_NODES, SITES, getSiteDef } from "@/data/content";
import { HINTS, HINT_IDS } from "@/data/guidance";
import { PROJECTS } from "@/data/projects";
import { getActiveSave, markDirty } from "@/save/activeSave";
import { DEFAULT_CARGO_CAPACITY_UNITS } from "@/save/defaults";
import type { Difficulty } from "@/save/types";
import { getActiveAsteroidRuntime } from "@/sim/asteroids/runtimeContext";
import { computeMiningDurationS, getAsteroidMiningReward, pocketOf } from "@/sim/asteroids/resources";
import { buildMineOperation } from "@/sim/asteroids/mineOperation";
import { DIFFICULTY_TABLE, difficultyMults, getDifficulty, setDifficulty } from "@/sim/difficulty";
import { frameOriginKm } from "@/sim/frames";
import { impactDamageHp } from "@/sim/physics/impactDamage";
import { getPhysicsTuning } from "@/sim/physics/physicsTuning";
import { probeClearance } from "@/sim/replication/clearance";
import type { Obstruction } from "@/sim/replication/placement";
import { starterPoint } from "@/sim/replication/points";
import { auditContent } from "@/sim/research/requirements";
import { evaluateProject } from "@/sim/research/projects";
import { getEffectiveTuning, getResourceTuning } from "@/sim/ship/resourceTuning";
import { activeCommsMessageAtom, activeHintAtom, commsQueueAtom, dismissCommsAtom, enqueueCommsAtom, nextHintAtom, playedMessageIdsAtom, resetCommsPlayedAtom, showHintAtom } from "@/store/comms";
import { aiNameAtom } from "@/store/aiName";
import { projectViewAtom, trackedProjectAtom, trackedStatusAtom } from "@/store/projects";
import { recoverSite, interactFocusAtom, interactControl } from "@/store/interact";
import { glanceAtom, sampleGlanceAtom, setDestinationAtom, sitePOIsAtom, type Destination } from "@/store/sites";
import { systemConfigAtom } from "@/store/system";
import { poiBuffer } from "@/store/poi";
import { targetedPOIAtom } from "@/store/transit";
import type { FrameId } from "@/sim/frames";
import type { OperationOutcome } from "@/sim/world/commands";
import { testProbe } from "./testProbe";
import { shipHealthAtom } from "@/store/store";

type Store = ReturnType<typeof createStore>;

/** Hop model from M3.2's measured gates: accelerate to v, coast, brake (0.008 kg per m/s). */
const HOP_MIN_MPS = 100;
const HOP_MAX_S = 120;

export function createM37Harness(store: Store) {
  const _ob: Obstruction = { bodyAltKm: 0, bodyId: null, rockClearM: 0 };

  /** Hydrate rocks among loaded chunks: distance from `fromAbs`, mining time, pocket. */
  const hydrateRocks = (fromAbs: number[], minUnits: number) => {
    const system = store.get(systemConfigAtom);
    const out: { fieldId: string; chunkKey: string; instanceId: number; radiusM: number; hydrates: number; distKm: number; mineS: number; pocket: string | null; posKm: number[] }[] = [];
    for (const f of system.asteroidFields ?? []) {
      const fr = getActiveAsteroidRuntime()?.getFieldRuntime(f.id);
      if (!fr) continue;
      fr.chunks.forEach((chunk, key) => {
        for (const modelId in chunk.instancesByModel) {
          const inst = chunk.instancesByModel[modelId];
          for (let i = 0; i < inst.count; i++) {
            const id = inst.instanceIds[i] >>> 0;
            const r = getAsteroidMiningReward(system, f.id, id, inst.radiiM[i], key);
            const h = r?.resources.find((x) => x.resourceId === "hydrates")?.amount ?? 0;
            if (h < minUnits) continue;
            const p = [0, 1, 2].map((k) => f.anchorKm[k] + chunk.originKm[k] + inst.positionsM[i * 3 + k] / 1000);
            out.push({
              fieldId: f.id, chunkKey: key, instanceId: id, radiusM: inst.radiiM[i], hydrates: h,
              distKm: Math.hypot(p[0] - fromAbs[0], p[1] - fromAbs[1], p[2] - fromAbs[2]),
              mineS: computeMiningDurationS(inst.radiiM[i]), pocket: pocketOf(f.resources, f.id, key)?.id ?? null, posKm: p,
            });
          }
        }
      });
    }
    return out.sort((a, b) => a.distKm - b.distKm);
  };

  const hopKg = (distKm: number): { kg: number; vMps: number; s: number } => {
    const v = Math.max(HOP_MIN_MPS, (distKm * 1000) / HOP_MAX_S);
    const t = getEffectiveTuning();
    return { kg: 2 * v * t.propellantKgPerMps, vMps: v, s: (distKm * 1000) / v };
  };

  return {
    /** Loaded chunks of `fieldId` within `radiusKm` of the ship: counts, classes, hydrate units. */
    chunks(fieldId: string, radiusKm = 60) {
      const system = store.get(systemConfigAtom);
      const f = (system.asteroidFields ?? []).find((x) => x.id === fieldId);
      const fr = getActiveAsteroidRuntime()?.getFieldRuntime(fieldId);
      if (!f || !fr) return null;
      const ship = testProbe.ship.posKm;
      const out: { key: string; distKm: number; rocks: number; classes: Record<string, number>; hydrates: number; bestHydrate: number; bestMineS: number; pocket: string | null }[] = [];
      fr.chunks.forEach((chunk, key) => {
        const cx = f.anchorKm[0] + chunk.originKm[0] + 10, cy = f.anchorKm[1] + chunk.originKm[1] + 10, cz = f.anchorKm[2] + chunk.originKm[2] + 10;
        const distKm = Math.hypot(cx - ship[0], cy - ship[1], cz - ship[2]);
        if (distKm > radiusKm) return;
        const classes: Record<string, number> = {};
        let rocks = 0, hydrates = 0, bestHydrate = 0, bestMineS = 0;
        for (const modelId in chunk.instancesByModel) {
          const inst = chunk.instancesByModel[modelId];
          for (let i = 0; i < inst.count; i++) {
            rocks++;
            const r = getAsteroidMiningReward(system, fieldId, inst.instanceIds[i] >>> 0, inst.radiiM[i], key);
            if (!r) continue;
            classes[r.asteroidClass.id] = (classes[r.asteroidClass.id] ?? 0) + 1;
            const h = r.resources.find((x) => x.resourceId === "hydrates")?.amount ?? 0;
            hydrates += h;
            const s = computeMiningDurationS(inst.radiiM[i]);
            if (h > bestHydrate && s < 14) {
              bestHydrate = h;
              bestMineS = s;
            }
          }
        }
        out.push({ key, distKm, rocks, classes, hydrates, bestHydrate, bestMineS, pocket: pocketOf(f.resources, fieldId, key)?.id ?? null });
      });
      out.sort((a, b) => a.distKm - b.distKm);
      return { anchorKm: [...f.anchorKm], ship: [...ship], chunks: out };
    },

    /**
     * Gate (a): from the starter point's emergence, the nearest cold-mineable hydrate source
     * (≥ `minUnits`) and its hop fuel; the authored pockets' classes; the protected allowance.
     */
    reach(minUnits = 3) {
      const sp = starterPoint();
      const o = frameOriginKm(sp.frameId, new Vector3());
      const em = [o.x + sp.positionKm[0], o.y + sp.positionKm[1], o.z + sp.positionKm[2]];
      const rocks = hydrateRocks(em, minUnits).filter((r) => r.mineS < 14);
      const nearest = rocks[0] ?? null;
      const nearestPocket = rocks.find((r) => r.pocket === "origin_volatile") ?? null;
      const system = store.get(systemConfigAtom);
      const pockets: Record<string, Record<string, number>> = {};
      for (const f of system.asteroidFields ?? []) {
        getActiveAsteroidRuntime()?.getFieldRuntime(f.id)?.chunks.forEach((chunk, key) => {
          const p = pocketOf(f.resources, f.id, key);
          if (!p) return;
          const c = (pockets[p.id] ??= {});
          for (const m in chunk.instancesByModel) {
            const inst = chunk.instancesByModel[m];
            for (let i = 0; i < inst.count; i++) {
              const r = getAsteroidMiningReward(system, f.id, inst.instanceIds[i] >>> 0, inst.radiiM[i], key);
              if (r) c[r.asteroidClass.id] = (c[r.asteroidClass.id] ?? 0) + 1;
            }
          }
        });
      }
      const fmt = (r: (typeof rocks)[number] | null) =>
        r && { distKm: Math.round(r.distKm * 100) / 100, hydrates: r.hydrates, mineS: Math.round(r.mineS * 10) / 10, pocket: r.pocket, hop: hopKg(r.distKm), ref: { fieldId: r.fieldId, chunkKey: r.chunkKey, instanceId: r.instanceId, radiusM: r.radiusM } };
      return {
        seed: getActiveSave()?.meta.seed ?? null,
        allowanceKg: getEffectiveTuning().recoveryAllowanceKg,
        nearest: fmt(nearest),
        nearestPocket: fmt(nearestPocket),
        pocketHydrateUnits: rocks.filter((r) => r.pocket === "origin_volatile").reduce((a, r) => a + r.hydrates, 0),
        pockets,
      };
    },

    /** Region and content audit: no bulk helium-3, lunar self-sufficiency inputs, the lunar unlock optional. */
    audit() {
      const system = store.get(systemConfigAtom);
      const he3: string[] = [];
      const provides: Record<string, string[]> = {};
      for (const f of system.asteroidFields ?? []) {
        const mats = new Set<string>();
        const classes = [...(f.resources?.classes ?? []), ...(f.resources?.pockets ?? []).flatMap((p) => p.classes)];
        for (const c of classes) for (const r of c.resources) {
          if (r.max <= 0) continue;
          if (r.resourceId === "helium_3") he3.push(`${f.id}:${c.id}`);
          mats.add(r.resourceId);
        }
        provides[f.id] = Array.from(mats).sort();
      }
      const he3Recipes = ITEMS.filter((i) => (i.recipe.helium_3 ?? 0) > 0).map((i) => i.id);
      const he3Analysis = RESEARCH_NODES.filter((n) => (n.analysis.helium_3 ?? 0) > 0).map((n) => n.id);
      const luna = new Set(provides.luna_belt ?? []);
      const kit = ITEMS.find((i) => i.id === "consumable_replication_kit");
      const lunarSelf = {
        fuel: luna.has("hydrates"),
        repair: luna.has("fe_ni_metal"),
        kit: !!kit && Object.keys(kit.recipe).every((k) => luna.has(k)),
        starterRecipes: ITEMS.filter((i) => i.starter).every((i) => Object.keys(i.recipe).every((k) => luna.has(k))),
      };
      // The lunar option is optional: nothing else requires it, nothing essential needs titanium.
      const dependsOnLn1 = RESEARCH_NODES.filter((n) => [...n.all, ...(n.any ?? [])].some((r) => r.kind === "research" && r.nodeId === "ln1_survey_salvage")).map((n) => n.id);
      const titaniumEssentials = ITEMS.filter((i) => (i.starter || i.id === "special_transit_drive") && (i.recipe.titanium ?? 0) > 0).map((i) => i.id);
      const content = auditContent(DEFAULT_CARGO_CAPACITY_UNITS);
      return {
        he3Classes: he3, he3Recipes, he3Analysis, provides, lunarSelf, dependsOnLn1, titaniumEssentials, content,
        pass: he3.length === 0 && he3Recipes.length === 0 && he3Analysis.length === 0 && Object.values(lunarSelf).every(Boolean) &&
          dependsOnLn1.length === 0 && titaniumEssentials.length === 0 && content.pass,
      };
    },

    /** Mean material shares of the loaded rocks of a field (titanium concentration). */
    shares(fieldId: string) {
      const system = store.get(systemConfigAtom);
      const f = (system.asteroidFields ?? []).find((x) => x.id === fieldId);
      const fr = getActiveAsteroidRuntime()?.getFieldRuntime(fieldId);
      const sum: Record<string, number> = {};
      let n = 0;
      fr?.chunks.forEach((chunk, key) => {
        for (const m in chunk.instancesByModel) {
          const inst = chunk.instancesByModel[m];
          for (let i = 0; i < inst.count; i++) {
            const r = f && getAsteroidMiningReward(system, f.id, inst.instanceIds[i] >>> 0, inst.radiiM[i], key);
            if (!r || r.totalAmount <= 0) continue;
            n++;
            for (const x of r.resources) sum[x.resourceId] = (sum[x.resourceId] ?? 0) + x.amount / r.totalAmount;
          }
        }
      });
      const out: Record<string, number> = {};
      for (const k in sum) out[k] = Math.round((sum[k] / Math.max(1, n)) * 1000) / 1000;
      return { rocks: n, shares: out };
    },

    /** Dev: hull damage as a collision would apply it (damage is not an operation; repair is). */
    damage(hp: number): number {
      const h = Math.max(1, store.get(shipHealthAtom) - hp);
      store.set(shipHealthAtom, h);
      return h;
    },

    /** Nearest hydrate rocks to the ship (session helpers). */
    hydrateNear(minUnits = 2, n = 6) {
      return hydrateRocks(testProbe.ship.posKm, minUnits).filter((r) => r.mineS < 14).slice(0, n);
    },

    /** Rock and body clearance at a frame-relative point. */
    clearance(frameId: string, positionKm: number[], searchM = 3000) {
      const r = probeClearance(frameId, positionKm, searchM, null, _ob);
      // Infinity (no rock within the search) does not survive JSON: report the search radius.
      return { rockClearM: Number.isFinite(r.rockClearM) ? r.rockClearM : searchM, bodyAltKm: r.bodyAltKm, bodyId: r.bodyId };
    },

    site: {
      defs: () => SITES.map((s) => ({ ...s })),
      /** The G action without aiming (inspect + recover back to back); null when none is in range. */
      interact(opId?: string): OperationOutcome | null {
        store.set(sampleGlanceAtom);
        const g = store.get(glanceAtom).site;
        const def = g ? getSiteDef(g.id) : undefined;
        if (!def || !g || g.distKm > def.recoverRangeKm) return null;
        return recoverSite(store, def.id, opId);
      },
      /** The reticle focus on interactables (sites, wrecks, points) and the site scan. */
      focus: () => ({ ...structuredClone(store.get(interactFocusAtom)), lockS: interactControl.lockS, scanning: interactControl.scanning }),
      glance: () => {
        store.set(sampleGlanceAtom);
        return structuredClone(store.get(glanceAtom));
      },
      pois: () => store.get(sitePOIsAtom).map((p) => ({ id: p.id, name: p.name, frameId: p.frameId ?? null, positionKm: [...p.positionKm] })),
      projected: () => poiBuffer.pois.filter((p) => p.id.startsWith("site:") || p.id.startsWith("pocket:")).map((p) => ({ id: p.id, name: p.name, distanceKm: p.distanceKm })),
      /** Live absolute km of the site (rides its frame). */
      absKm(id: string): number[] | null {
        const s = getSiteDef(id);
        if (!s) return null;
        const o = frameOriginKm(s.frameId, new Vector3());
        return [o.x + s.positionKm[0], o.y + s.positionKm[1], o.z + s.positionKm[2]];
      },
      setDestination: (dest: Destination): boolean => store.set(setDestinationAtom, dest),
      /** Any frame-relative transit target (planner probes). */
      targetRel(frameId: string, positionKm: [number, number, number], arrivalOffsetKm = 3): void {
        store.set(targetedPOIAtom, { id: `probe:${frameId}`, name: "probe", positionKm, frameId: frameId as FrameId, arrivalOffsetKm });
      },
    },

    difficulty: {
      get: () => ({ current: getDifficulty(), mults: { ...difficultyMults() }, table: structuredClone(DIFFICULTY_TABLE) }),
      /** Runtime only (pure harness runs). */
      set: (d: Difficulty): void => setDifficulty(d),
      /** The active world's stored setting (persisted), applied now. */
      setWorld(d: Difficulty): boolean {
        const rec = getActiveSave();
        if (!rec) return false;
        rec.meta.difficulty = d;
        setDifficulty(d);
        markDirty(true);
        return true;
      },
      effective: () => ({ ...getEffectiveTuning() }),
      /** Hull points one head-on impact of `dvMps` removes at 100 max hull (the live applyImpact call). */
      impactHp: (dvMps: number): number => impactDamageHp({ dvMps, prevDvMps: 0 }, getPhysicsTuning(), 100, 1, difficultyMults().collisionDamage),
      base: () => ({ ...getResourceTuning() }),
      /** The miner's yield claim for one rock under the current setting. */
      mineClaim(t: { fieldId: string; chunkKey: string; instanceId: number; radiusM: number }) {
        return buildMineOperation(store.get(systemConfigAtom), t, { miningEfficiencyMult: 1 }, "probe").yield;
      },
    },

    project: {
      ids: () => PROJECTS.map((p) => p.id),
      track: (id: string | null): void => store.set(trackedProjectAtom, id),
      tracked: () => store.get(trackedProjectAtom),
      status: () => structuredClone(store.get(trackedStatusAtom)),
      evaluate: (id: string) => {
        store.set(sampleGlanceAtom);
        return structuredClone(evaluateProject(id, store.get(projectViewAtom)));
      },
    },

    comms: {
      active: () => store.get(activeCommsMessageAtom)?.messageId ?? null,
      queue: () => store.get(commsQueueAtom).map((m) => m.messageId),
      played: () => [...store.get(playedMessageIdsAtom)],
      hint: () => store.get(activeHintAtom)?.id ?? null,
      dismiss: (): void => store.set(dismissCommsAtom),
      nextHint: (): void => store.set(nextHintAtom),
      nameAi: (name: string | null): void => store.set(aiNameAtom, name),
      /** New-world state for the opening (the driver names the AI on every load). */
      reset(): void {
        store.set(resetCommsPlayedAtom);
        store.set(aiNameAtom, null);
      },
      /** Try to enqueue an id: catalogue entry if active, else a stand-in with that id (retired check). */
      enqueue(id: string): void {
        const msg: CommsMessage = COMMS_MESSAGES[id] ?? { messageId: id, speaker: "Ship AI", textContent: ["probe"], priority: 1 };
        store.set(enqueueCommsAtom, msg);
      },
      showHint(key: keyof typeof HINTS): void {
        store.set(showHintAtom, HINTS[key]);
      },
      retired: () => Array.from(RETIRED_COMMS_IDS),
      catalogue: () => Object.values(COMMS_MESSAGES).map((m) => ({ id: m.messageId, speaker: m.speaker, text: m.textContent.join(" ") })),
      hintIds: () => [...HINT_IDS],
    },
  };
}

export type M37Harness = ReturnType<typeof createM37Harness>;
