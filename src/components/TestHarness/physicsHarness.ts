/** `__phys` (dev): near-field stats and synthetic colliders around the live ship. */
import { Quaternion, Vector3 } from "three";
import { getLocalPlayerShip } from "@/sim/entities";
import { PHYSICS_MAX_SPEED_KMPS, nearField, nearFieldLoadInfo, type NearFieldContact } from "@/sim/physics/nearField";
import { lumpyHullPoints, simulatePhysics } from "@/sim/physics/physicsSim";
import { shipBodyAxes } from "@/sim/ship/stepShip";
import { SYSTEM_FRAME_ID, frameOriginKm } from "@/sim/frames";
import { CPU_PASS_PHYSICS, perf } from "@/components/space/perf/perfProfiler";
import type { ColliderShape } from "@/sim/physics/types";
import type { createStore } from "jotai";
import { getActiveAsteroidRuntime } from "@/sim/asteroids/runtimeContext";
import { systemConfigAtom } from "@/store/system";
import { devTeleportAtom } from "@/store/dev";
import { newOpId, worldAuthority } from "@/sim/world/worldAuthority";
import { getLocalPlayerId } from "@/save/playerId";
import {
  asteroidFieldColliders, ensureModelHull, getAsteroidColliderModel, listAsteroidColliderModels, renderDebug,
  type InstanceTransform,
} from "@/sim/physics/asteroidColliders";
import { impactLog, liveImpactCounters } from "@/sim/physics/impactDamage";
import { getPhysicsTuning, setPhysicsTuning, type PhysicsTuning } from "@/sim/physics/physicsTuning";
import type { NearFieldColliderId } from "@/sim/physics/nearField";

import { shipHealthAtom } from "@/store/store";
import { isDeadAtom, respawnAtom, wrecksAtom } from "@/store/death";
import { effectiveShipConfigAtom } from "@/store/shipConfig";
import { cargoAtom } from "@/store/cargo";
import { STARTING_POSITION_KM } from "@/sim/celestialConstants";
import { physicsDebug } from "@/store/physicsTuningPrefs";
import { playerInput } from "@/input/playerInput";

type Store = ReturnType<typeof createStore>;

/** The 26 directions of gate 8: every non-zero {-1,0,1}³, normalised. */
const DIRS26: [number, number, number][] = [];
for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
  if (x || y || z) { const l = Math.hypot(x, y, z); DIRS26.push([x / l, y / l, z / l]); }
}

type Q4 = [number, number, number, number];
function rot(q: Q4, v: [number, number, number]): [number, number, number] {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * v[2] - qz * v[1]), ty = 2 * (qz * v[0] - qx * v[2]), tz = 2 * (qx * v[1] - qy * v[0]);
  return [v[0] + qw * tx + (qy * tz - qz * ty), v[1] + qw * ty + (qz * tx - qx * tz), v[2] + qw * tz + (qx * ty - qy * tx)];
}
function norm(q: Q4): Q4 {
  const l = Math.hypot(...q);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
function angleDeg(a: Q4, b: Q4): number {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI;
}
/** Max over points (local, scaled by s, rotated by q) of p·d. */
function support(points: ArrayLike<number>, s: number, q: Q4, d: [number, number, number]): number {
  const dl = rot([-q[0], -q[1], -q[2], q[3]], d);
  let best = -Infinity;
  for (let i = 0; i < points.length; i += 3) best = Math.max(best, (points[i] * dl[0] + points[i + 1] * dl[1] + points[i + 2] * dl[2]) * s);
  return best;
}
function maxRadius(points: ArrayLike<number>): number {
  let r2 = 0;
  for (let i = 0; i < points.length; i += 3) r2 = Math.max(r2, points[i] ** 2 + points[i + 1] ** 2 + points[i + 2] ** 2);
  return Math.sqrt(r2);
}

interface RockRef {
  fieldId: string;
  chunkKey: string;
  modelId: string;
  localIndex: number;
  instanceId: number;
  radiusM: number;
  /** Absolute system km. */
  absKm: [number, number, number];
  /** f64 field-local metres (chunk origin + instance offset). */
  fieldLocalM: [number, number, number];
  centreDistM: number;
  surfaceDistM: number;
}

/** Synthetic colliders the debug view draws; bulk ones (cost tests) are not drawn. */
export const DEV_COLLIDER_TAG = "dev";
export const DEV_BULK_TAG = "dev-bulk";

const _f = new Vector3(), _r = new Vector3(), _u = new Vector3(), _a = new Vector3(), _b = new Vector3();

function ship() {
  const s = getLocalPlayerShip();
  if (!s) throw new Error("[phys] no local ship");
  return s;
}

export interface DevColliderSpec {
  kind?: "ball" | "hull";
  radiusM?: number;
  /** Offset in the ship's body axes, m. */
  aheadM?: number;
  rightM?: number;
  upM?: number;
  /** Register in the system frame instead of the ship's (same absolute position). */
  systemFrame?: boolean;
}

function shapeOf(kind: "ball" | "hull", radiusM: number, seed: number): ColliderShape {
  return kind === "ball" ? { kind: "ball", radiusM } : { kind: "hull", points: lumpyHullPoints(radiusM, 0.25, seed) };
}

export function createPhysicsHarness(store: Store) {
  const contactLog: (NearFieldContact & { t: number })[] = [];

  const fieldDef = (fieldId: string) => (store.get(systemConfigAtom).asteroidFields ?? []).find((f) => f.id === fieldId);

  /** Every loaded real asteroid instance (optionally only within `maxM` of the ship's surface). */
  const rocks = (maxM = Infinity): RockRef[] => {
    const s = ship();
    const shipAbs = frameOriginKm(s.frameId, new Vector3()).add(s.posKm);
    const out: RockRef[] = [];
    getActiveAsteroidRuntime()?.forEachField((rt, fieldId) => {
      const f = fieldDef(fieldId);
      if (!f) return;
      rt.chunks.forEach((chunk, chunkKey) => {
        for (const modelId in chunk.instancesByModel) {
          const inst = chunk.instancesByModel[modelId];
          for (let i = 0; i < inst.count; i++) {
            const abs: [number, number, number] = [0, 1, 2].map((k) => f.anchorKm[k] + chunk.originKm[k] + inst.positionsM[i * 3 + k] / 1000) as [number, number, number];
            const centreDistM = Math.hypot(abs[0] - shipAbs.x, abs[1] - shipAbs.y, abs[2] - shipAbs.z) * 1000;
            const surfaceDistM = centreDistM - inst.radiiM[i];
            if (surfaceDistM > maxM) continue;
            const fieldLocalM: [number, number, number] = [0, 1, 2].map((k) => chunk.originKm[k] * 1000 + inst.positionsM[i * 3 + k]) as [number, number, number];
            out.push({ fieldId, chunkKey, modelId, localIndex: i, instanceId: inst.instanceIds[i] >>> 0, radiusM: inst.radiiM[i], absKm: abs, fieldLocalM, centreDistM, surfaceDistM });
          }
        }
      });
    });
    return out.sort((a, b) => a.surfaceDistM - b.surfaceDistM);
  };

  const findRock = (instanceId: number): RockRef | null => rocks().find((r) => r.instanceId === instanceId >>> 0) ?? null;

  const colliderState = (r: RockRef) => {
    const set = asteroidFieldColliders.get(r.fieldId);
    const info = set?.list().find((e) => e.instanceId === r.instanceId);
    return info
      ? { kind: info.kind, registered: info.colliderId !== null && nearField.hasCollider(info.colliderId as NearFieldColliderId), inEngine: info.inEngine, dropped: info.dropped, colliderId: info.colliderId }
      : null;
  };

  /** The near-tier GPU transform of an instance: its slot data + the model's cull uniforms. */
  const gpuTransform = (r: RockRef): (InstanceTransform & { slot: number[] }) | null => {
    const slot = renderDebug.allocators.get(r.fieldId)?.current.get(r.modelId)?.readInstance(r.chunkKey, r.localIndex);
    const u = renderDebug.nearUniforms.get(`${r.fieldId}:${r.modelId}`);
    if (!slot || !u) return null;
    const f = Math.fround;
    const [ax, ay, az, aw] = [slot[8], slot[9], slot[10], slot[11]];
    const b = u.uBaseQuat.value;
    const [bx, by, bz, bw] = [f(b.x), f(b.y), f(b.z), f(b.w)];
    return {
      slot,
      x: slot[0] + slot[4], y: slot[1] + slot[5], z: slot[2] + slot[6],
      qx: aw * bx + ax * bw + ay * bz - az * by,
      qy: aw * by - ax * bz + ay * bw + az * bx,
      qz: aw * bz + ax * by - ay * bx + az * bw,
      qw: aw * bw - ax * bx - ay * by - az * bz,
      radiusM: slot[3],
      scale: slot[3] * f(u.uInvBaseRadius.value) * f(u.uBaseScale.value),
    };
  };

  /**
   * A rock's near-tier instance translation (world-origin-relative) with every f32 rounding the cull
   * shader does, (hi - originHi) + (lo - originLo), and the f64 truth in the same space.
   */
  const instanceTranslation = (r: RockRef): { gpu: number[]; truth: number[]; mw: ArrayLike<number> } | null => {
    const slot = renderDebug.allocators.get(r.fieldId)?.current.get(r.modelId)?.readInstance(r.chunkKey, r.localIndex);
    const b = renderDebug.batches.get(`near:${r.fieldId}:${r.modelId}`);
    const u = renderDebug.nearUniforms.get(`${r.fieldId}:${r.modelId}`);
    if (!slot || !b || !u) return null;
    const f = Math.fround;
    const oh = u.uOriginHigh.value, ol = u.uOriginLow.value;
    const hi = [f(oh.x), f(oh.y), f(oh.z)], lo = [f(ol.x), f(ol.y), f(ol.z)];
    return {
      gpu: [0, 1, 2].map((k) => f(f(slot[k] - hi[k]) + f(slot[4 + k] - lo[k]))),
      truth: [0, 1, 2].map((k) => r.fieldLocalM[k] - u.originM[k]),
      mw: b.mesh.matrixWorld.elements,
    };
  };

  /** World-origin-relative centre as drawn: instance translation + the mesh's f32 world translation. */
  const renderedCentre = (r: RockRef): { gpu: number[]; truth: number[] } | null => {
    const t = instanceTranslation(r);
    if (!t) return null;
    const f = Math.fround;
    return { gpu: [0, 1, 2].map((k) => f(t.gpu[k] + f(t.mw[12 + k]))), truth: [0, 1, 2].map((k) => t.truth[k] + t.mw[12 + k]) };
  };

  let driftPrevDecoupled: boolean | null = null;
  const drift = (speedMps: number, rock: RockRef | undefined): void => {
    const s = ship();
    if (speedMps <= 0) {
      s.velKmps.set(0, 0, 0);
      if (driftPrevDecoupled !== null) playerInput.decoupled = driftPrevDecoupled;
      driftPrevDecoupled = null;
      return;
    }
    const shipAbs = frameOriginKm(s.frameId, new Vector3()).add(s.posKm);
    const to = rock ? new Vector3(...rock.absKm).sub(shipAbs).normalize() : new Vector3(0, 0, 1);
    const side = new Vector3(0, 1, 0).cross(to);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0).cross(to);
    driftPrevDecoupled ??= playerInput.decoupled;
    playerInput.decoupled = true;
    playerInput.throttle = 0;
    s.velKmps.copy(side.normalize()).multiplyScalar(speedMps / 1000);
  };

  const afterFrame = (): Promise<void> => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));

  return {
    stats() {
      const s = ship();
      const o = nearField.origin();
      let contacts = 0;
      nearField.lastStepContacts(() => contacts++);
      return {
        load: nearFieldLoadInfo(),
        ready: nearField.ready,
        suspended: nearField.suspended,
        colliders: nearField.colliderCount(),
        collidersByTag: nearField.colliderCountsByTag(),
        engineColliders: nearField.engineColliderCount(),
        contactsThisStep: contacts,
        lastOwner: nearField.lastOwner,
        stepMs: { last: nearField.lastStepMs, perFrame: nearField.recentStepMs() },
        origin: o,
        shipOffsetFromOriginM: o.frameId === s.frameId ? s.posKm.distanceTo(new Vector3(...o.anchorKm)) * 1000 : null,
        ship: nearField.shipInfo(),
        counters: { ...nearField.counters },
        maxSpeedMps: nearField.maxSpeedKmps * 1000,
        rebaseKm: nearField.rebaseKm,
      };
    },
    /** Flat local hull points of the ship collider (m), for analytic ground truth. */
    shipHull(): number[] {
      const sh = nearField.shipShapeDesc();
      if (sh.kind === "hull") return Array.from(sh.points);
      if (sh.kind === "box") {
        const out: number[] = [];
        for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) out.push(x * sh.halfX, y * sh.halfY, z * sh.halfZ);
        return out;
      }
      return [];
    },
    /** Drain the live contact queue (and keep a copy in `contactLog`). */
    drainContacts() {
      const out: (NearFieldContact & { t: number })[] = [];
      const t = performance.now();
      nearField.drainContacts((c) => out.push({ ...c, t }));
      contactLog.push(...out);
      return out;
    },
    contactLog,
    simulate: simulatePhysics,
    /** Live tuning table (docs/PHYSICS_PLAN.md §7.3). */
    tuning: {
      get: (): PhysicsTuning => ({ ...getPhysicsTuning() }),
      set: (p: Partial<PhysicsTuning>): PhysicsTuning => {
        setPhysicsTuning(p);
        const t = getPhysicsTuning();
        nearField.setMaterial(t.restitution, t.friction);
        return { ...t };
      },
    },
    /** The live game's impacts: one entry per hit (damage applied once). */
    impacts: {
      log: () => impactLog.slice(),
      counters: () => ({ ...liveImpactCounters }),
      clear: (): void => {
        impactLog.length = 0;
        liveImpactCounters.impacts = 0;
        liveImpactCounters.damageApplications = 0;
      },
    },
    /** Dev view switches. */
    debug: {
      outlines(on?: boolean): boolean {
        if (on !== undefined) physicsDebug.outlines = on;
        return physicsDebug.outlines;
      },
    },
    /** Hull, death and respawn, for the live gates. */
    game: {
      health: (): { health: number; max: number } => ({ health: store.get(shipHealthAtom), max: store.get(effectiveShipConfigAtom).maxHealth }),
      setHealth: (h: number): void => store.set(shipHealthAtom, h),
      isDead: (): boolean => store.get(isDeadAtom),
      cargo: (): Record<string, number> => ({ ...store.get(cargoAtom).items }),
      wrecks: () => store.get(wrecksAtom).map((w) => ({ ...w })),
      /** The death screen's respawn button. */
      respawn(): void {
        store.set(respawnAtom, [...STARTING_POSITION_KM]);
      },
    },
    /** Real asteroid colliders (M2b). */
    asteroids: {
      /** Warp to a field's centre (+ offset km), facing +z. */
      warpToField(fieldId?: string, offsetKm: [number, number, number] = [0, 0, 0]) {
        const f = fieldId ? fieldDef(fieldId) : (store.get(systemConfigAtom).asteroidFields ?? [])[0];
        if (!f) throw new Error("[phys] no such field");
        store.set(devTeleportAtom, { positionKm: [f.anchorKm[0] + offsetKm[0], f.anchorKm[1] + offsetKm[1], f.anchorKm[2] + offsetKm[2]], quaternion: [0, 0, 0, 1] });
        return f.id;
      },
      fields: () => Array.from(asteroidFieldColliders.entries()).map(([id, set]) => ({ id, ...set.stats() })),
      models: () => listAsteroidColliderModels().map((m) => ({
        modelId: m.modelId, source: m.source, points: m.points.length / 3, hullPoints: m.hull ? m.hull.points.length / 3 : null,
        hullFailed: m.hullFailed, info: m.info,
      })),
      /** Nearest loaded rocks with their collider state. */
      nearest(n = 5, maxM = Infinity) {
        return rocks(maxM).slice(0, n).map((r) => ({ ...r, collider: colliderState(r), rendered: gpuTransform(r) !== null }));
      },
      /** Is the instance loaded, drawn and solid? */
      state(instanceId: number) {
        const r = findRock(instanceId);
        return r ? { loaded: true, rendered: gpuTransform(r) !== null, collider: colliderState(r), surfaceDistM: r.surfaceDistM, radiusM: r.radiusM } : { loaded: false, rendered: false, collider: null };
      },
      /**
       * Warp to `distM` from the rock's bounding sphere, facing its centre, approaching along the
       * current ship→rock line (or `dir`, unit, from rock to ship).
       */
      standoff(instanceId: number, distM = 150, dir?: [number, number, number]) {
        const r = findRock(instanceId);
        if (!r) throw new Error(`[phys] rock ${instanceId} not loaded`);
        const s = ship();
        const shipAbs = frameOriginKm(s.frameId, new Vector3()).add(s.posKm);
        const rock = new Vector3(...r.absKm);
        const away = dir ? new Vector3(...dir).normalize() : shipAbs.clone().sub(rock).normalize();
        const pos = rock.clone().addScaledVector(away, (r.radiusM + distM) / 1000);
        const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), away.clone().negate());
        store.set(devTeleportAtom, { positionKm: [pos.x, pos.y, pos.z], quaternion: [q.x, q.y, q.z, q.w] });
        return { instanceId: r.instanceId, fieldId: r.fieldId, modelId: r.modelId, radiusM: r.radiusM, standoffM: distM };
      },
      /** Destroy a rock through the world authority (as mining does). */
      destroy(instanceId: number): boolean {
        const r = findRock(instanceId);
        if (!r) return false;
        const o = worldAuthority.submit({ type: "asteroid.destroy", opId: newOpId(), fieldId: r.fieldId, chunkKey: r.chunkKey, instanceId: r.instanceId, cause: "mined" }, getLocalPlayerId());
        return o.status === "accepted";
      },
      /**
       * Streaming check: registry vs. the loaded instances within the physics radius (surface
       * distance). `missing` = inside R without a collider; `extra` = collider beyond the keep band.
       */
      audit() {
        const R = getPhysicsTuning().physicsRadiusKm * 1000;
        const keep = R * 1.1 + 50;
        const all = rocks(keep + 1);
        const ids = new Set<number>(), dropped = new Set<number>();
        asteroidFieldColliders.forEach((set) => set.list().forEach((e) => {
          if (e.colliderId !== null) ids.add(e.instanceId);
          else if (e.dropped) dropped.add(e.instanceId);
        }));
        const inR = all.filter((r) => r.surfaceDistM <= R);
        // Over the cap the farthest are dropped on purpose; they are not "missing".
        const missing = inR.filter((r) => !ids.has(r.instanceId) && !dropped.has(r.instanceId)).map((r) => ({ id: r.instanceId, distM: r.surfaceDistM }));
        const near = new Set(all.map((r) => r.instanceId));
        const extra = Array.from(ids).filter((id) => !near.has(id));
        const byTag = nearField.colliderCountsByTag();
        let asteroidColliders = 0;
        for (const k in byTag) if (k.startsWith("asteroid:")) asteroidColliders += byTag[k];
        return { inRadius: inR.length, registered: ids.size, dropped: dropped.size, asteroidColliders, missing, extra, cap: getPhysicsTuning().colliderCap };
      },
      /**
       * Gate 8b: for up to `n` hull colliders, the engine's collider (pose read back, hull read back)
       * against the near tier's GPU transform and the model's mesh vertices under that transform.
       */
      transforms(n = 8) {
        const out: Record<string, unknown>[] = [];
        for (const r of rocks(getPhysicsTuning().physicsRadiusKm * 1100)) {
          if (out.length >= n) break;
          const st = colliderState(r);
          if (!st || st.kind !== "hull" || st.colliderId === null) continue;
          const id = st.colliderId as NearFieldColliderId;
          const pose = nearField.enginePose(id), hull = nearField.engineHull(id), gpu = gpuTransform(r), m = getAsteroidColliderModel(r.modelId);
          const f = fieldDef(r.fieldId);
          if (!pose || !hull || !gpu || !m || !f) continue;
          const fo = frameOriginKm(pose.frameId, new Vector3());
          const local = [0, 1, 2].map((k) => (fo.getComponent(k) + pose.relKm[k] - f.anchorKm[k]) * 1000);
          const posErrM = Math.hypot(local[0] - gpu.x, local[1] - gpu.y, local[2] - gpu.z);
          const gq = norm([gpu.qx, gpu.qy, gpu.qz, gpu.qw]);
          const eq = norm(pose.quat);
          const hullUnit = m.hull ? maxRadius(m.hull.points) : NaN;
          const engineScale = maxRadius(hull) / hullUnit;
          let worst = 0;
          for (const d of DIRS26) {
            const he = support(hull, 1, eq, d), hm = support(m.points, gpu.scale, gq, d);
            worst = Math.max(worst, Math.abs(he - hm) / Math.abs(hm));
          }
          out.push({
            instanceId: r.instanceId, modelId: r.modelId, radiusM: r.radiusM, surfaceDistM: r.surfaceDistM,
            posErrCm: posErrM * 100, angleErrDeg: angleDeg(gq, eq), scaleRelErr: Math.abs(engineScale / gpu.scale - 1),
            supportWorstRelErr: worst,
          });
        }
        return out;
      },
      /** Gate 8a: per model, the engine-built hull's support distance vs. the mesh's, 26 directions. */
      hullFidelity() {
        return listAsteroidColliderModels().map((m) => {
          const h = ensureModelHull(m, nearField);
          if (!h) return { modelId: m.modelId, hull: false };
          let worst = 0;
          const rows = DIRS26.map((d) => {
            const hh = support(h.points, 1, [0, 0, 0, 1], d), hm = support(m.points, 1, [0, 0, 0, 1], d);
            worst = Math.max(worst, Math.abs(hh - hm) / Math.abs(hm));
            return hh / hm;
          });
          return { modelId: m.modelId, source: m.source, meshPoints: m.points.length / 3, hullPoints: h.points.length / 3, worstRelErr: worst, minRatio: Math.min(...rows), maxRatio: Math.max(...rows), info: m.info };
        });
      },
      /**
       * Float precision of the drawn rocks: for the `n` nearest, over `frames` frames, the rendered
       * world-origin-relative centre (f32 as the GPU rounds) minus the f64 truth. `jitter` = largest
       * frame-to-frame change of that error. `speedMps` > 0 drifts the ship (decoupled) sideways.
       */
      async renderError(n = 5, frames = 240, speedMps = 0) {
        const picks = rocks().slice(0, n);
        if (!picks.length) throw new Error("[phys] no rocks loaded");
        const s = ship();
        if (speedMps > 0) drift(speedMps, picks[0]);
        const rows = picks.map((r) => ({ instanceId: r.instanceId, surfaceDistM: r.surfaceDistM, maxErrM: 0, maxJitterM: 0, prev: null as number[] | null }));
        let sampled = 0;
        const shipStart = frameOriginKm(s.frameId, new Vector3()).add(s.posKm);
        try {
          for (let k = 0; k < frames; k++) {
            await afterFrame();
            picks.forEach((r, i) => {
              const c = renderedCentre(r);
              if (!c) return;
              const e = [0, 1, 2].map((j) => c.gpu[j] - c.truth[j]);
              const row = rows[i];
              row.maxErrM = Math.max(row.maxErrM, Math.hypot(e[0], e[1], e[2]));
              if (row.prev) row.maxJitterM = Math.max(row.maxJitterM, Math.hypot(e[0] - row.prev[0], e[1] - row.prev[1], e[2] - row.prev[2]));
              row.prev = e;
              sampled++;
            });
          }
        } finally {
          if (speedMps > 0) drift(0, undefined);
        }
        const movedM = frameOriginKm(s.frameId, new Vector3()).add(s.posKm).distanceTo(shipStart) * 1000;
        return {
          frames, samples: sampled, movedM,
          maxErrM: Math.max(...rows.map((r) => r.maxErrM)), maxJitterM: Math.max(...rows.map((r) => r.maxJitterM)),
          rocks: rows.map(({ prev: _prev, ...r }) => r),
        };
      },
      /**
       * End to end: read a tier's GPU output back and find each of the `n` nearest rocks that its
       * cull must draw (inside band and frustum on the f64 truth, with margin); distance of the
       * drawn translation to the f32 model and to the f64 truth (batch-local space).
       */
      async gpuCheck(n = 5, tier: "near" | "mid" | "far" = "near") {
        const f = Math.fround;
        const out: Record<string, unknown>[] = [];
        for (const r of rocks()) {
          if (out.length >= n) break;
          const b = renderDebug.batches.get(`${tier}:${r.fieldId}:${r.modelId}`);
          const slot = renderDebug.allocators.get(r.fieldId)?.current.get(r.modelId)?.readInstance(r.chunkKey, r.localIndex);
          if (!b || !slot || !b.mesh.visible) continue;
          const u = b.cull;
          const truth = [0, 1, 2].map((k) => r.fieldLocalM[k] - u.originM[k]);
          const c = u.uCameraPos.value;
          const [lo, hi] = u.bandM();
          const dist = Math.hypot(truth[0] - c.x, truth[1] - c.y, truth[2] - c.z);
          if (dist < lo + 1 || dist > hi - 1) continue;
          if (u.uFrustum.some(({ value: pl }) => pl.x * truth[0] + pl.y * truth[1] + pl.z * truth[2] + pl.w < r.radiusM)) continue;
          const oh = u.uOriginHigh.value, ol = u.uOriginLow.value;
          const ohv = [oh.x, oh.y, oh.z], olv = [ol.x, ol.y, ol.z];
          const model = [0, 1, 2].map((k) => f(f(slot[k] - f(ohv[k])) + f(slot[4 + k] - f(olv[k]))));
          const [count, buf] = await Promise.all([b.readCount(), b.readOutput()]);
          const stride = tier === "far" ? 4 : 16, off = tier === "far" ? 0 : 12;
          let bestModel = Infinity, bestTruth = Infinity;
          for (let j = 0; j < Math.min(count, buf.length / stride); j++) {
            const o = j * stride + off;
            const dm = Math.hypot(buf[o] - model[0], buf[o + 1] - model[1], buf[o + 2] - model[2]);
            if (dm < bestModel) {
              bestModel = dm;
              bestTruth = Math.hypot(buf[o] - truth[0], buf[o + 1] - truth[1], buf[o + 2] - truth[2]);
            }
          }
          out.push({ tier, instanceId: r.instanceId, camDistM: dist, visible: count, gpuVsModelM: bestModel, gpuVsTruthM: bestTruth });
        }
        return out;
      },
      /** Coast (decoupled) at `speedMps` sideways past the nearest rock; 0 stops and restores the assist. */
      drift(speedMps: number): void {
        drift(speedMps, rocks()[0]);
      },
      /** Visible instances per tier, summed over fields and models (GPU read-back of the indirect counts). */
      async tierCounts() {
        const out: Record<string, number> = { near: 0, mid: 0, far: 0 };
        for (const b of Array.from(renderDebug.batches.values())) if (b.mesh.visible) out[b.tier] += await b.readCount();
        return out;
      },
    },
    /** The profiler's physics.step series (needs ?perf). */
    perf: {
      enabled: (): boolean => perf.enabled,
      reset: (): void => perf.reset(),
      step: () => perf.snapshot().cpuPasses.find((c) => c.label === CPU_PASS_PHYSICS)?.cpu ?? null,
    },
    dev: {
      /** Drawn dev colliders with their live centre distance from the ship. */
      list() {
        const s = ship();
        const out: { id: number; frameId: string; distanceM: number; engineDriftM: number | null }[] = [];
        nearField.forEachCollider((id, _shape, frameId, relKm, tag) => {
          if (tag !== DEV_COLLIDER_TAG) return;
          frameOriginKm(frameId, _a).add(relKm);
          frameOriginKm(s.frameId, _b).add(s.posKm);
          out.push({ id, frameId, distanceM: _a.distanceTo(_b) * 1000, engineDriftM: nearField.engineDriftM(id) });
        });
        return out;
      },
      /** One synthetic collider placed in the ship's body axes, in the ship's frame. */
      add(spec: DevColliderSpec = {}): number {
        const s = ship();
        shipBodyAxes(s.quat, _f, _r, _u);
        const p = s.posKm.clone()
          .addScaledVector(_f, (spec.aheadM ?? 100) / 1000)
          .addScaledVector(_r, (spec.rightM ?? 0) / 1000)
          .addScaledVector(_u, (spec.upM ?? 0) / 1000);
        const shape = shapeOf(spec.kind ?? "ball", spec.radiusM ?? 15, nearField.colliderCount() + 1);
        if (!spec.systemFrame) return nearField.addCollider(shape, s.frameId, p, undefined, DEV_COLLIDER_TAG);
        frameOriginKm(s.frameId, _a).add(p);
        return nearField.addCollider(shape, SYSTEM_FRAME_ID, _a, undefined, DEV_COLLIDER_TAG);
      },
      /**
       * `n` colliders scattered in a shell around the ship (cost tests), never within
       * `minM` of it. Returns the creation wall time.
       */
      scatter(n: number, opts: { kind?: "ball" | "hull"; radiusM?: number; minM?: number; maxM?: number; seed?: number } = {}) {
        const s = ship();
        const minM = opts.minM ?? 300, maxM = opts.maxM ?? 1900;
        let seed = opts.seed ?? 7;
        const rnd = () => {
          seed = (seed * 16807) % 2147483647;
          return seed / 2147483647;
        };
        const q = new Quaternion();
        const t0 = performance.now();
        for (let i = 0; i < n; i++) {
          const dir = new Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize();
          const d = (minM + (maxM - minM) * rnd()) / 1000;
          q.setFromAxisAngle(new Vector3(rnd(), rnd(), rnd()).normalize(), rnd() * Math.PI);
          nearField.addCollider(shapeOf(opts.kind ?? "hull", opts.radiusM ?? 8 + rnd() * 30, i + 1),
            s.frameId, s.posKm.clone().addScaledVector(dir, d), q, DEV_BULK_TAG);
        }
        return { n, ms: performance.now() - t0, colliders: nearField.colliderCount() };
      },
      clear(tag?: string): number {
        if (tag !== undefined) return nearField.clearColliders(tag);
        return nearField.clearColliders(DEV_COLLIDER_TAG) + nearField.clearColliders(DEV_BULK_TAG);
      },
      /** Force a re-seed (every collider repositioned) on the next step; resets the reanchor-ms max. */
      reseed(resetMax = false): void {
        if (resetMax) nearField.counters.maxReanchorMs = 0;
        nearField.markReseed();
      },
      /** Live speed-gate override (m/s); null restores the default. */
      maxSpeed(mps: number | null): number {
        nearField.maxSpeedKmps = mps === null ? PHYSICS_MAX_SPEED_KMPS : mps / 1000;
        return nearField.maxSpeedKmps * 1000;
      },
    },
  };
}

export type PhysicsHarness = ReturnType<typeof createPhysicsHarness>;
