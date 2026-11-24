/**
 * S3 — dynamic emissive spill (docs/VFX_REALISM_PLAN.md §4).
 *
 * Impacts (co-op, drones), remote exhausts, drone lamps and beacon flashes light nothing on
 * their own. One pooled PointLight takes the brightest of them as seen from the camera.
 * Steady station lamps are baked into the station textures (`LightTemplate.bakedSpill`), and
 * sources with a light of their own (local impact, local exhaust) claim their spot.
 * Why one, MEASURED on a station fixture (local pass, 6 runs each): +0.48 ms for one light,
 * +1.16 ms for two, +1.7 ms for three (a cliff over the scene's ~9 lights); a shader-side
 * Lambert term was ~20× weaker (metal hulls: spill is mostly specular) and still +0.43 ms.
 * Handover: the light keeps its source until another beats it by HYSTERESIS, then fades out
 * over FADE_S and fades in at the new one (a short dip; with SPILL_LIGHTS_MAX 2, a crossfade).
 */

import { lightPointBuffer } from "./lightPoints";

export const SPILL_LIGHTS_MAX = 1;
const CANDIDATES = 6;
const HYSTERESIS = 1.5;
const FADE_S = 0.2;
/** Light this far off the surface a point sits on, m (the 1/d² near field blows out its mount). */
const SURFACE_OFFSET_M = 0.5;
/** Score softening, m². */
const NEAR_M2 = 4;
/** A light's source is the candidate within this of where it was, m (tracks movers). */
const MATCH_M = 4;

// ── Light-only sources and claims, cleared every frame ──────────────────────

const EXTRA_CAP = 64;
const extra = { count: 0, pos: new Float32Array(EXTRA_CAP * 3), rgb: new Float32Array(EXTRA_CAP * 3) };

/** A light-only source (scene metres; rgb in game units × m² = cd / 6037.7), this frame. */
export function pushSpillSource(x: number, y: number, z: number, r: number, g: number, b: number): void {
  if (extra.count >= EXTRA_CAP) return;
  const i = extra.count++;
  extra.pos[i * 3] = x; extra.pos[i * 3 + 1] = y; extra.pos[i * 3 + 2] = z;
  extra.rgb[i * 3] = r; extra.rgb[i * 3 + 1] = g; extra.rgb[i * 3 + 2] = b;
}

const CLAIM_CAP = 4;
const claims = new Float32Array(CLAIM_CAP * 4);
let claimCount = 0;

/** A source with its own light: points within `radiusM` of it are skipped this frame. */
export function claimSpill(x: number, y: number, z: number, radiusM: number): void {
  if (claimCount >= CLAIM_CAP) return;
  const k = claimCount++ * 4;
  claims[k] = x; claims[k + 1] = y; claims[k + 2] = z; claims[k + 3] = radiusM * radiusM;
}

function claimed(x: number, y: number, z: number): boolean {
  for (let k = 0; k < claimCount; k++) {
    const dx = x - claims[k * 4], dy = y - claims[k * 4 + 1], dz = z - claims[k * 4 + 2];
    if (dx * dx + dy * dy + dz * dz < claims[k * 4 + 3]) return true;
  }
  return false;
}

// ── Candidates: top N by I/d² from the camera ───────────────────────────────

type Src = { x: number; y: number; z: number; r: number; g: number; b: number; score: number };
const mk = (): Src => ({ x: 0, y: 0, z: 0, r: 0, g: 0, b: 0, score: 0 });
const cand: Src[] = Array.from({ length: CANDIDATES }, mk);
let nCand = 0;
let considered = 0;

function offer(x: number, y: number, z: number, r: number, g: number, b: number, cx: number, cy: number, cz: number): void {
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (!(lum > 0) || claimed(x, y, z)) return;
  considered++;
  const dx = x - cx, dy = y - cy, dz = z - cz;
  const score = lum / (dx * dx + dy * dy + dz * dz + NEAR_M2);
  let k = nCand;
  if (nCand < CANDIDATES) nCand++;
  else {
    k = 0;
    for (let j = 1; j < CANDIDATES; j++) if (cand[j].score < cand[k].score) k = j;
    if (score <= cand[k].score) return;
  }
  const s = cand[k];
  s.x = x; s.y = y; s.z = z; s.r = r; s.g = g; s.b = b; s.score = score;
}

/** Dev: sources re-pushed every frame (vfx-spill.mjs pool test), scene metres + game units. */
let devSources: number[][] = [];
export function setDevSpillSources(list: number[][]): void {
  devSources = list;
}

function gather(cx: number, cy: number, cz: number): void {
  nCand = 0;
  considered = 0;
  for (const s of devSources) pushSpillSource(s[0], s[1], s[2], s[3], s[4], s[5]);
  const B = lightPointBuffer;
  for (let i = 0; i < B.count; i++) {
    if (B.baked[i]) continue;
    let x = B.pos[i * 3], y = B.pos[i * 3 + 1], z = B.pos[i * 3 + 2];
    const dx = B.dir[i * 3], dy = B.dir[i * 3 + 1], dz = B.dir[i * 3 + 2];
    if (dx !== 0 || dy !== 0 || dz !== 0) {
      x += dx * SURFACE_OFFSET_M; y += dy * SURFACE_OFFSET_M; z += dz * SURFACE_OFFSET_M;
    } else {
      // No normal here (impacts): pull toward the camera, off the surface it lights.
      const vx = cx - x, vy = cy - y, vz = cz - z, l = Math.hypot(vx, vy, vz);
      if (l > 1e-3) { const k = Math.min(SURFACE_OFFSET_M, 0.5 * l) / l; x += vx * k; y += vy * k; z += vz * k; }
    }
    offer(x, y, z, B.rgb[i * 3], B.rgb[i * 3 + 1], B.rgb[i * 3 + 2], cx, cy, cz);
  }
  for (let i = 0; i < extra.count; i++) {
    offer(extra.pos[i * 3], extra.pos[i * 3 + 1], extra.pos[i * 3 + 2], extra.rgb[i * 3], extra.rgb[i * 3 + 1], extra.rgb[i * 3 + 2], cx, cy, cz);
  }
  extra.count = 0;
  claimCount = 0;
}

// ── The lights: sticky assignment + fades ───────────────────────────────────

/** `step`: how far the source moved last frame, m (widens the match for fast movers). */
export type SpillLight = Src & { live: boolean; w: number; leaving: boolean; displaced: boolean; step: number };
const lights: SpillLight[] = Array.from({ length: SPILL_LIGHTS_MAX }, () => ({ ...mk(), live: false, w: 0, leaving: false, displaced: false, step: 0 }));
const taken = new Uint8Array(CANDIDATES);

function match(l: SpillLight): number {
  const r = MATCH_M + 2 * l.step;
  let best = -1, bd = r * r;
  for (let k = 0; k < nCand; k++) {
    if (taken[k]) continue;
    const c = cand[k];
    const d = (c.x - l.x) ** 2 + (c.y - l.y) ** 2 + (c.z - l.z) ** 2;
    if (d < bd) { bd = d; best = k; }
  }
  return best;
}

/** Update `n` lights (≤ SPILL_LIGHTS_MAX) for this frame; camera in scene metres. */
export function stepSpill(n: number, cx: number, cy: number, cz: number, dt: number): readonly SpillLight[] {
  gather(cx, cy, cz);
  taken.fill(0);
  const fade = Math.min(1, dt / FADE_S);
  // 1. Each live light follows its source while it is still a candidate, else starts leaving.
  //    A light displaced by hysteresis stays leaving; one that only lost its source for a
  //    frame or two (a blink, a fast pass) picks it back up and fades back in.
  for (let j = 0; j < n; j++) {
    const l = lights[j];
    if (!l.live) continue;
    const k = l.displaced ? -1 : match(l);
    if (k >= 0) {
      taken[k] = 1;
      const c = cand[k];
      l.step = Math.hypot(c.x - l.x, c.y - l.y, c.z - l.z);
      l.x = c.x; l.y = c.y; l.z = c.z; l.r = c.r; l.g = c.g; l.b = c.b; l.score = c.score;
      l.leaving = false;
    } else l.leaving = true;
  }
  // 2. The best unlit candidate displaces the weakest kept light only by HYSTERESIS.
  let bestFree = -1;
  for (let k = 0; k < nCand; k++) if (!taken[k] && (bestFree < 0 || cand[k].score > cand[bestFree].score)) bestFree = k;
  if (bestFree >= 0) {
    let free = -1, weakest = -1;
    for (let j = 0; j < n; j++) {
      const l = lights[j];
      if (!l.live) { if (free < 0) free = j; continue; }
      if (!l.leaving && (weakest < 0 || l.score < lights[weakest].score)) weakest = j;
    }
    if (free < 0 && weakest >= 0 && cand[bestFree].score > HYSTERESIS * lights[weakest].score) {
      lights[weakest].leaving = true;
      lights[weakest].displaced = true;
    }
    // 3. A free light takes it, fading in (with two lights: while the other fades out).
    if (free >= 0) {
      const l = lights[free], c = cand[bestFree];
      l.x = c.x; l.y = c.y; l.z = c.z; l.r = c.r; l.g = c.g; l.b = c.b; l.score = c.score;
      l.live = true; l.leaving = false; l.displaced = false; l.w = 0; l.step = 0;
      taken[bestFree] = 1;
    }
  }
  // 4. Fades; a light that has faded out is free next frame.
  for (let j = 0; j < n; j++) {
    const l = lights[j];
    if (!l.live) continue;
    l.w = l.leaving ? Math.max(0, l.w - fade) : Math.min(1, l.w + fade);
    if (l.leaving && l.w <= 0) { l.live = false; l.displaced = false; }
  }
  return lights;
}

export function spillStatus(): { considered: number; candidates: number; lights: SpillLight[] } {
  return { considered, candidates: nCand, lights: lights.map((l) => ({ ...l })) };
}
