"use client";

import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { useAtomValue } from "jotai";
import { systemConfigAtom } from "@/store/system";
import { useAsteroidRuntime } from "@/sim/asteroids/runtimeContext";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { asteroidShadowModel, createAsteroidRayHit, rayHitInstance } from "@/sim/asteroids/asteroidRaycast";
import { STAR_POSITION_KM, STAR_RADIUS_KM } from "@/sim/celestialConstants";
import {
  beginShadowOccluders,
  commitShadowOccluders,
  inShadowCone,
  clearLocalShadows,
  forceLocalShadow,
  localShadowStatus,
  localSunVisibility,
  offerShadowOccluder,
  setLocalShadowsEnabled,
  setLocalSun,
} from "./localShadows";

/** Rocks within this surface distance of the ship compete for the slots (beyond: only one shading the ship). */
const NEAR_M = 3000;
/** Longest shadow cone searched along the sun line (a 500 m rock's umbra at 1 AU is ~107 km). */
const MAX_CONE_M = 250_000;

let _gatherMs = 0;
/** Dev probe: last gather's CPU time. */
export function localShadowGatherMs(): number {
  return _gatherMs;
}

/** S1: picks the occluders for the key light's analytic shadow each frame (VFX plan §4). */
export default function LocalShadowCaster() {
  const runtime = useAsteroidRuntime();
  const worldOrigin = useWorldOrigin();
  const systemConfig = useAtomValue(systemConfigAtom);
  const anchors = useMemo(() => {
    const map = new Map<string, readonly number[]>();
    for (const f of systemConfig.asteroidFields ?? []) if (f.enabled !== false) map.set(f.id, f.anchorKm);
    return map;
  }, [systemConfig]);

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    // Dev probe for scripts/drive-examples/vfx-shadows.mjs.
    (window as unknown as { __shadow: unknown }).__shadow = {
      status: () => {
        const wo = worldOrigin.worldOriginKm;
        return { ...localShadowStatus(), gatherMs: _gatherMs, originKm: [wo.x, wo.y, wo.z] };
      },
      enable: (on: boolean) => setLocalShadowsEnabled(on),
      force: (dark: boolean) => forceLocalShadow(dark),
      clear: (on: boolean) => clearLocalShadows(on),
      /** CPU visibility at a system-frame km point (this frame's occluder set). */
      /**
       * Calibration: the nearest rock's mean silhouette area over `dirs` random directions,
       * by ray-casting its rendered mesh, as an equivalent radius vs the shadow sphere's.
       */
      calib: (dirs = 24, grid = 48) => {
        const sp = worldOrigin.shipPosKm;
        const box: { v: { chunk: Parameters<typeof rayHitInstance>[6]; modelId: string; i: number; c: number[]; r: number; d: number } | null } = { v: null };
        runtime.forEachField((field, fieldId) => {
          const a = anchors.get(fieldId);
          if (!a) return;
          const ox = (sp.x - a[0]) * 1000, oy = (sp.y - a[1]) * 1000, oz = (sp.z - a[2]) * 1000;
          field.chunks.forEach((chunk) => {
            for (const modelId in chunk.instancesByModel) {
              const inst = chunk.instancesByModel[modelId];
              for (let i = 0; i < inst.count; i++) {
                const c = [chunk.originKm[0] * 1000 + inst.positionsM[i * 3], chunk.originKm[1] * 1000 + inst.positionsM[i * 3 + 1], chunk.originKm[2] * 1000 + inst.positionsM[i * 3 + 2]];
                const d = Math.hypot(c[0] - ox, c[1] - oy, c[2] - oz) - inst.radiiM[i];
                if (!box.v || d < box.v.d) box.v = { chunk, modelId, i, c, r: inst.radiiM[i], d };
              }
            }
          });
        });
        const b = box.v;
        if (!b) return null;
        const m = asteroidShadowModel(b.modelId);
        if (!m) return null;
        const hit = createAsteroidRayHit();
        const ext = b.r * m.reach * 1.05;
        let sum = 0;
        let seed = 12345;
        const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
        for (let k = 0; k < dirs; k++) {
          const z = rnd() * 2 - 1, ph = rnd() * 2 * Math.PI, sr = Math.sqrt(1 - z * z);
          const dv = [sr * Math.cos(ph), sr * Math.sin(ph), z];
          const e1 = Math.abs(dv[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
          const k1 = e1[0] * dv[0] + e1[1] * dv[1] + e1[2] * dv[2];
          const u = [e1[0] - k1 * dv[0], e1[1] - k1 * dv[1], e1[2] - k1 * dv[2]];
          const ul = Math.hypot(u[0], u[1], u[2]);
          u[0] /= ul; u[1] /= ul; u[2] /= ul;
          const w = [dv[1] * u[2] - dv[2] * u[1], dv[2] * u[0] - dv[0] * u[2], dv[0] * u[1] - dv[1] * u[0]];
          let hits = 0;
          for (let gx = 0; gx < grid; gx++) for (let gy = 0; gy < grid; gy++) {
            const s = ((gx + 0.5) / grid) * 2 - 1, t = ((gy + 0.5) / grid) * 2 - 1;
            const o = [0, 1, 2].map((q) => b.c[q] - dv[q] * ext * 2 + (u[q] * s + w[q] * t) * ext);
            if (rayHitInstance(o[0], o[1], o[2], dv[0], dv[1], dv[2], b.chunk, b.modelId, b.i, ext * 4, hit) < Infinity) hits++;
          }
          sum += (hits / (grid * grid)) * 4 * ext * ext;
        }
        const rSil = Math.sqrt(sum / dirs / Math.PI);
        return { modelId: b.modelId, r: b.r, reach: m.reach, eq: m.eq, rSilOverR: rSil / b.r, eqOverSil: (m.eq * b.r) / rSil };
      },
      visAtKm: (p: number[]) => {
        const wo = worldOrigin.worldOriginKm;
        return localSunVisibility((p[0] - wo.x) * 1000, (p[1] - wo.y) * 1000, (p[2] - wo.z) * 1000);
      },
    };
  }, [worldOrigin, runtime, anchors]);

  useFrame(() => {
    const t0 = performance.now();
    const wo = worldOrigin.worldOriginKm;
    const sp = worldOrigin.shipPosKm;
    let dx = STAR_POSITION_KM[0] - sp.x, dy = STAR_POSITION_KM[1] - sp.y, dz = STAR_POSITION_KM[2] - sp.z;
    const dist = Math.hypot(dx, dy, dz) || 1;
    dx /= dist; dy /= dist; dz /= dist;
    const ang = Math.asin(Math.min(1, STAR_RADIUS_KM / dist));
    setLocalSun(dx, dy, dz, ang);
    const tanA = Math.tan(ang);
    // Ship, scene metres.
    const shx = (sp.x - wo.x) * 1000, shy = (sp.y - wo.y) * 1000, shz = (sp.z - wo.z) * 1000;

    beginShadowOccluders();
    runtime.forEachField((field, fieldId) => {
      const a = anchors.get(fieldId);
      if (!a) return;
      // Field-local → scene: subtract (wo − anchor)·1000.
      const fx = (wo.x - a[0]) * 1000, fy = (wo.y - a[1]) * 1000, fz = (wo.z - a[2]) * 1000;
      const ox = fx + shx, oy = fy + shy, oz = fz + shz;
      field.chunks.forEach((chunk) => {
        const pad = chunk.maxRadiusM * 1.5;
        const cone = Math.min(MAX_CONE_M, (pad / Math.max(tanA, 1e-6)) * 1.1);
        const ex = ox + dx * cone, ey = oy + dy * cone, ez = oz + dz * cone;
        const lo = chunk.aabbMinKm, hi = chunk.aabbMaxKm;
        // Near sphere OR the sun-line segment (padded) overlaps the chunk box.
        const nearPad = NEAR_M + pad;
        const near = ox > lo[0] * 1000 - nearPad && ox < hi[0] * 1000 + nearPad &&
          oy > lo[1] * 1000 - nearPad && oy < hi[1] * 1000 + nearPad &&
          oz > lo[2] * 1000 - nearPad && oz < hi[2] * 1000 + nearPad;
        const segPad = pad * 2;
        const seg = !near &&
          Math.min(ox, ex) - segPad < hi[0] * 1000 && Math.max(ox, ex) + segPad > lo[0] * 1000 &&
          Math.min(oy, ey) - segPad < hi[1] * 1000 && Math.max(oy, ey) + segPad > lo[1] * 1000 &&
          Math.min(oz, ez) - segPad < hi[2] * 1000 && Math.max(oz, ez) + segPad > lo[2] * 1000;
        if (!near && !seg) return;
        const cox = chunk.originKm[0] * 1000, coy = chunk.originKm[1] * 1000, coz = chunk.originKm[2] * 1000;
        for (const modelId in chunk.instancesByModel) {
          const m = asteroidShadowModel(modelId);
          if (!m) continue;
          const inst = chunk.instancesByModel[modelId];
          const P = inst.positionsM, Q = inst.quaternions, R = inst.radiiM;
          for (let i = 0; i < inst.count; i++) {
            const r = R[i];
            const req = r * m.eq;
            const vx = cox + P[i * 3] - ox, vy = coy + P[i * 3 + 1] - oy, vz = coz + P[i * 3 + 2] - oz;
            const d = Math.hypot(vx, vy, vz);
            let score: number;
            if (inShadowCone(vx, vy, vz, req * 1.2)) score = d - 1e9;
            else if (d - r < NEAR_M) score = d - r;
            else continue;
            // Centroid offset: q = instanceQuat × baseQuat applied to off·r.
            const ax = Q[i * 4], ay = Q[i * 4 + 1], az = Q[i * 4 + 2], aw = Q[i * 4 + 3];
            const b = m.baseQuat;
            const qx = aw * b[0] + ax * b[3] + ay * b[2] - az * b[1];
            const qy = aw * b[1] - ax * b[2] + ay * b[3] + az * b[0];
            const qz = aw * b[2] + ax * b[1] - ay * b[0] + az * b[3];
            const qw = aw * b[3] - ax * b[0] - ay * b[1] - az * b[2];
            const px = m.off[0] * r, py = m.off[1] * r, pz = m.off[2] * r;
            // v' = v + 2w(q×v) + 2 q×(q×v)
            const tx = 2 * (qy * pz - qz * py), ty = 2 * (qz * px - qx * pz), tz = 2 * (qx * py - qy * px);
            const rx = px + qw * tx + (qy * tz - qz * ty);
            const ry = py + qw * ty + (qz * tx - qx * tz);
            const rz = pz + qw * tz + (qx * ty - qy * tx);
            // Scene position of the shadow sphere; the guard covers the whole mesh around it.
            offerShadowOccluder(vx + rx + shx, vy + ry + shy, vz + rz + shz, req,
              r * m.reach + Math.hypot(rx, ry, rz), score);
          }
        }
      });
    });
    commitShadowOccluders(shx, shy, shz);
    _gatherMs = performance.now() - t0;
  });

  return null;
}
