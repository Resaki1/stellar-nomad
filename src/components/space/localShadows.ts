/**
 * S1 — analytic local sun shadows (docs/VFX_REALISM_PLAN.md §4).
 *
 * The key light's shadow term is a TSL node (`light.shadow.shadowNode`, no shadow map):
 * every receiving fragment tests the sun's disc against the few nearest occluder spheres
 * (rocks at their area-equivalent radius), so the ship goes dark behind a rock while
 * rocks outside the umbra stay lit. The same maths runs on the CPU for the hull fill.
 * Planet shadows stay in sunOcclusion.ts (one owner per body).
 */

import { Vector2, Vector3, Vector4 } from "three";
import {
  Fn, If, Loop, asin, atan, clamp, cross, dot, float, length, min, positionWorld, select, smoothstep,
  mix, uniform, uniformArray, vec4,
} from "three/tsl";

export const MAX_SHADOW_OCCLUDERS = 8;
/** A ship-class receiver inside [1, 1 + band]·R_eq fades out the shadow (the sphere is an average surface). */
const SELF_BAND = 0.1;

/** xyz: centre, scene metres; w: area-equivalent radius (0 = empty slot). */
const _occ = Array.from({ length: MAX_SHADOW_OCCLUDERS }, () => new Vector4());
/** Radius within which a ROCK fragment belongs to this occluder (its own mesh reach). */
const _guard: number[] = new Array(MAX_SHADOW_OCCLUDERS).fill(0);
const uOcc = uniformArray(_occ, "vec4");
const uGuard = uniformArray(_guard, "float");
const uSunDir = uniform(new Vector3(0, 0, 1));
const uSunAng = uniform(0.00465);
/** Dev A/B on ship-class receivers only (rocks keep theirs, so they cancel in a luma diff): x = shadows on, y = sun scale. */
const uDev = uniform(new Vector2(1, 1));

/**
 * Fraction of the sun's disc an occluder of angular radius `aOcc` at separation `sep` covers.
 * Exact width (0 at sep = a+b, full at |a−b|); smoothstep stands in for the lens-area S-curve.
 */
function coverJs(aOcc: number, aSun: number, sep: number): number {
  const lo = Math.min(aOcc, aSun);
  const x = Math.min(1, Math.max(0, (aOcc + aSun - sep) / (2 * lo)));
  const s = x * x * (3 - 2 * x);
  const ratio = aOcc / aSun;
  return s * Math.min(1, ratio * ratio);
}

/** Material flag: the receiver is itself one of the occluders (an asteroid), so skip its own sphere. */
export const SHADOW_SELF_ROCK = "shadowSelfRock";

let _node: ReturnType<typeof buildNode> | null = null;
const _builds = { rock: 0, other: 0 };
let _enabled = true;
let _cleared = false;

/** Dev perf A/B: upload no occluders (every slot skips its work). */
export function clearLocalShadows(on: boolean): void {
  _cleared = on;
}

/** Dev A/B: ship-class receivers unshadowed (rocks unchanged). */
export function setLocalShadowsEnabled(on: boolean): void {
  _enabled = on;
  uDev.value.x = on ? 1 : 0;
}

/** Dev: ship-class receivers fully shadowed — the floor every shadow should reach. */
export function forceLocalShadow(dark: boolean): void {
  uDev.value.y = dark ? 0 : 1;
}

function buildNode() {
  // Fn bodies run per material build, so the rock branch is a compile-time choice.
  return Fn((_: unknown, builder: { material?: { userData?: Record<string, unknown> } }) => {
    const rock = builder.material?.userData?.[SHADOW_SELF_ROCK] === true;
    _builds[rock ? "rock" : "other"]++;
    const P = positionWorld;
    const vis = float(1).toVar();
    Loop(MAX_SHADOW_OCCLUDERS, ({ i }) => {
      const o = vec4(uOcc.element(i));
      const r = o.w;
      If(r.greaterThan(0), () => {
        const v = o.xyz.sub(P).toVar();
        const t = dot(v, uSunDir);
        If(t.greaterThan(0), () => {
          const d = length(v);
          const perp = length(cross(v, uSunDir));
          const aOcc = asin(min(r.div(d), 1));
          const sep = atan(perp, t);
          const lo = min(aOcc, uSunAng);
          const x = clamp(aOcc.add(uSunAng).sub(sep).div(lo.mul(2)), 0, 1);
          const ratio = aOcc.div(uSunAng);
          const cov = smoothstep(0, 1, x).mul(min(ratio.mul(ratio), 1));
          // Rocks never shadow themselves (their own N·L does); ships fade in over the surface band.
          const keep = rock
            ? select(d.greaterThan(float(uGuard.element(i))), float(1), float(0))
            : smoothstep(r, r.mul(1 + SELF_BAND), d);
          vis.mulAssign(float(1).sub(cov.mul(keep)));
        });
      });
    });
    return rock ? vis : mix(float(1), vis, uDev.x).mul(uDev.y);
  })();
}

/** The key light's shadow node (built once; branches per receiving material). */
export function localShadowNode(): ReturnType<typeof buildNode> {
  return (_node ??= buildNode());
}

// ── CPU side ────────────────────────────────────────────────────────────────

type Cand = { x: number; y: number; z: number; r: number; guard: number; score: number };
const _cands: Cand[] = Array.from({ length: MAX_SHADOW_OCCLUDERS }, () => ({ x: 0, y: 0, z: 0, r: 0, guard: 0, score: Infinity }));
let _n = 0;
const _sun = { x: 0, y: 0, z: 1, ang: 0.00465 };
let _shipVis = 1;
let _offered = 0;

/** Ship→sun unit direction and the sun's angular radius, rad. */
export function setLocalSun(dx: number, dy: number, dz: number, angRad: number): void {
  _sun.x = dx; _sun.y = dy; _sun.z = dz; _sun.ang = angRad;
  uSunDir.value.set(dx, dy, dz);
  uSunAng.value = angRad;
}

export function beginShadowOccluders(): void {
  _n = 0;
  _offered = 0;
}

/** Offer an occluder (scene metres); keeps the MAX lowest scores. */
export function offerShadowOccluder(x: number, y: number, z: number, r: number, guard: number, score: number): void {
  _offered++;
  if (_n < MAX_SHADOW_OCCLUDERS) {
    const c = _cands[_n++];
    c.x = x; c.y = y; c.z = z; c.r = r; c.guard = guard; c.score = score;
    return;
  }
  let worst = 0;
  for (let k = 1; k < _n; k++) if (_cands[k].score > _cands[worst].score) worst = k;
  const c = _cands[worst];
  if (score >= c.score) return;
  c.x = x; c.y = y; c.z = z; c.r = r; c.guard = guard; c.score = score;
}

/** Upload this frame's set and resolve the visibility at the ship (scene metres). */
export function commitShadowOccluders(shipX: number, shipY: number, shipZ: number): void {
  if (_cleared) _n = 0;
  for (let k = 0; k < MAX_SHADOW_OCCLUDERS; k++) {
    const c = k < _n ? _cands[k] : null;
    _occ[k].set(c?.x ?? 0, c?.y ?? 0, c?.z ?? 0, c?.r ?? 0);
    _guard[k] = c?.guard ?? 0;
  }
  _shipVis = (_enabled ? localSunVisibility(shipX, shipY, shipZ) : 1) * uDev.value.y;
}

/** CPU twin of the shader (ship-class receiver). */
export function localSunVisibility(px: number, py: number, pz: number): number {
  let vis = 1;
  for (let k = 0; k < _n; k++) {
    const c = _cands[k];
    const vx = c.x - px, vy = c.y - py, vz = c.z - pz;
    const t = vx * _sun.x + vy * _sun.y + vz * _sun.z;
    if (t <= 0) continue;
    const d = Math.hypot(vx, vy, vz);
    const cx = vy * _sun.z - vz * _sun.y, cy = vz * _sun.x - vx * _sun.z, cz = vx * _sun.y - vy * _sun.x;
    const aOcc = Math.asin(Math.min(1, c.r / d));
    const sep = Math.atan2(Math.hypot(cx, cy, cz), t);
    const u = Math.min(1, Math.max(0, (d - c.r) / (c.r * SELF_BAND)));
    vis *= 1 - coverJs(aOcc, _sun.ang, sep) * u * u * (3 - 2 * u);
  }
  return vis;
}

let _camVis = 1;
/** Rock shadows at the camera (scene metres): the eye, for the sun's analytic glare. */
export function setLocalCameraVisibility(x: number, y: number, z: number): void {
  _camVis = _enabled ? localSunVisibility(x, y, z) : 1;
}
export function localCameraVisibility(): number {
  return _camVis;
}

/** Last frame's visibility at the ship (drives the hull bounce fill). */
export function localShipVisibility(): number {
  return _shipVis;
}

/** For `__lum` / gates: the uploaded set and the ship's visibility. */
export function localShadowStatus(): { shipVisibility: number; offered: number; sunAngDeg: number;
  sunDir: [number, number, number]; enabled: boolean; builds: { rock: number; other: number };
  occluders: { x: number; y: number; z: number; r: number; guard: number; score: number }[] } {
  return {
    shipVisibility: _shipVis,
    offered: _offered,
    sunAngDeg: (_sun.ang * 180) / Math.PI,
    sunDir: [_sun.x, _sun.y, _sun.z],
    enabled: _enabled,
    builds: { ..._builds },
    occluders: _cands.slice(0, _n).map((c) => ({ ...c })),
  };
}

/** Shadow-cone test for ranking: true when the point sits in an occluder's umbra or penumbra. */
export function inShadowCone(vx: number, vy: number, vz: number, r: number): boolean {
  const t = vx * _sun.x + vy * _sun.y + vz * _sun.z;
  if (t <= 0) return false;
  const cx = vy * _sun.z - vz * _sun.y, cy = vz * _sun.x - vx * _sun.z, cz = vx * _sun.y - vy * _sun.x;
  return Math.hypot(cx, cy, cz) < r + t * Math.tan(_sun.ang) * 1.05;
}
