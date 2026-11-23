// ---------------------------------------------------------------------------
// MINING IMPACT — docs/VFX_REALISM_PLAN.md §3 (I1–I4). Laser-melted rock in vacuum:
//  I1 hot spots: a Gaussian TEMPERATURE profile per spot (8-slot ring) in the near-tier
//     asteroid material, coloured through a blackbody LUT, so the white-yellow melt core
//     falls to an orange-red rim by physics, not by a colour ramp. A spot stops being fed when
//     the beam moves on and cools: a trail behind a moving beam.
//  I2 sparks: molten droplets flying in straight lines (no gravity, no drag), cooling by
//     radiation, T(t) = T0·(1 + 3kT0³t)^(−1/3), k = 3εσ/(ρcr). Drawn as flux-conserving light
//     points (§1): a 1–3 mm droplet is a point at any distance worth drawing.
//  I3 impact light and I4 plasma core: in ImpactVFX.tsx.
// Positions are FIELD-local metres (rocks are static there; lunar fields move with their
// anchor), resolved to scene metres each frame.
// ---------------------------------------------------------------------------

import { SHADOW_SELF_ROCK } from "@/components/space/localShadows";
import { ClampToEdgeWrapping, DataTexture, FloatType, LinearFilter, type MeshStandardMaterial, Vector4 } from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";
import {
  float, Fn, If, Loop, materialEmissive, max, mx_noise_float, positionWorld, select, texture, uniform, uniformArray, vec2, vec3, vec4,
} from "three/tsl";
import { blackbodyLinearSrgb, blackbodyLuminanceNits, HALF_FLOAT_WRITE_MAX, nitsToGameUnits } from "@/components/space/photometry";
import { lampMeshWeight, pushLightPoint } from "@/components/space/lightPoints";

export const HOT_SLOTS = 8;
/** Rock/basalt emissivity (emissivePhotometry EMISSIVITY_ROCK). */
const EPS = 0.9;
/** Melt core peak while the beam feeds it, K (silicate melt + superheat, plan §3.1: 2,000–3,000 K). */
export const MELT_PEAK_K = 2700;
/** Profile radius, m: the visible scar; the white core is its inner ~third. */
const SPOT_R_M = 0.12;
/** Peak temperature relaxes to this with τ once unfed (dark glass below ~800 K). */
const AMBIENT_K = 650;
const COOL_TAU_S = 2.5;
/** A new spot once the hit point has moved this many radii from the fed one. */
const SPOT_STEP = 0.6;

// ── Blackbody LUT: radiance per channel, game units, ε folded in ─────────────
const LUT_MIN_K = 600;
const LUT_MAX_K = 3300;
const LUT_N = 271; // 10 K steps
let _lut: Float32Array | null = null;
/** CPU copy too: luminance (cd/m², ε folded) per entry, for spark/point intensities. */
let _nits: Float32Array | null = null;

function lut(): Float32Array {
  if (_lut) return _lut;
  _lut = new Float32Array(LUT_N * 4);
  _nits = new Float32Array(LUT_N);
  for (let i = 0; i < LUT_N; i++) {
    const T = LUT_MIN_K + ((LUT_MAX_K - LUT_MIN_K) * i) / (LUT_N - 1);
    const nits = EPS * blackbodyLuminanceNits(T);
    const L = nitsToGameUnits(nits);
    const [r, g, b] = blackbodyLinearSrgb(T);
    _lut[i * 4] = Math.max(0, r) * L;
    _lut[i * 4 + 1] = Math.max(0, g) * L;
    _lut[i * 4 + 2] = Math.max(0, b) * L;
    _lut[i * 4 + 3] = 1;
    _nits[i] = nits;
  }
  return _lut;
}

/** ε·L_v(T), cd/m² (LUT-interpolated). */
export function hotNits(T: number): number {
  lut();
  const x = (Math.min(Math.max(T, LUT_MIN_K), LUT_MAX_K) - LUT_MIN_K) / ((LUT_MAX_K - LUT_MIN_K) / (LUT_N - 1));
  const i = Math.min(Math.floor(x), LUT_N - 2);
  const f = x - i;
  return _nits![i] * (1 - f) + _nits![i + 1] * f;
}

/** Linear-sRGB hue at T, luminance-normalised (into `out`). */
export function hotHue(T: number, out: number[]): void {
  const c = blackbodyLinearSrgb(Math.min(Math.max(T, 1000), LUT_MAX_K));
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] || 1;
  out[0] = Math.max(0, c[0]) / l; out[1] = Math.max(0, c[1]) / l; out[2] = Math.max(0, c[2]) / l;
}

let _tex: DataTexture | null = null;
function lutTexture(): DataTexture {
  if (_tex) return _tex;
  _tex = new DataTexture(lut(), LUT_N, 1, undefined, FloatType);
  _tex.minFilter = _tex.magFilter = LinearFilter;
  _tex.wrapS = _tex.wrapT = ClampToEdgeWrapping;
  _tex.needsUpdate = true;
  return _tex;
}

// ── I1: spot slots ───────────────────────────────────────────────────────────

type Spot = {
  live: boolean;
  fieldId: string;
  rock: string; // chunkKey:instanceId
  x: number; y: number; z: number; // field-local m
  r: number;
  peakK: number;
  fed: boolean;
};

const spots: Spot[] = Array.from({ length: HOT_SLOTS }, () => ({
  live: false, fieldId: "", rock: "", x: 0, y: 0, z: 0, r: SPOT_R_M, peakK: AMBIENT_K, fed: false,
}));
let nextSlot = 0;
let fedSlot = -1;

/** xyz: scene metres, w: profile radius (0 = empty slot). */
const _spotVecs = Array.from({ length: HOT_SLOTS }, () => new Vector4());
export const uSpotPos = uniformArray(_spotVecs, "vec4");
/** x: peak temperature K. */
export const uSpotT = uniformArray(new Array(HOT_SLOTS).fill(0), "float");
export const uHotPre = uniform(1);
/** 1 while any spot is live: idle rocks skip the slot loop, noise and LUT entirely. */
export const uHotAny = uniform(0);

export type BeamImpact = {
  on: boolean;
  fieldId: string;
  rock: string;
  /** Field-local hit point, m. */
  x: number; y: number; z: number;
  power: number;
};

/** Feed / spawn / cool the spots for this frame. */
export function stepHotSpots(beam: BeamImpact, dt: number): void {
  // Fixed radius: the rock emissive's crossfade is baked for 2·SPOT_R_M, so a power-scaled
  // radius would break flux at the handover (review finding). Power raises the temperature.
  const r = SPOT_R_M;
  let fed = -1;
  if (beam.on) {
    const cur = fedSlot >= 0 ? spots[fedSlot] : null;
    const near = cur && cur.live && cur.rock === beam.rock && cur.fieldId === beam.fieldId &&
      Math.hypot(cur.x - beam.x, cur.y - beam.y, cur.z - beam.z) < SPOT_STEP * cur.r;
    if (near) fed = fedSlot;
    else {
      fed = nextSlot;
      nextSlot = (nextSlot + 1) % HOT_SLOTS;
      const s = spots[fed];
      s.live = true; s.fieldId = beam.fieldId; s.rock = beam.rock;
      s.x = beam.x; s.y = beam.y; s.z = beam.z; s.r = r;
      // A fresh spot heats from the rim temperature of its neighbour, not from cold.
      s.peakK = cur && cur.live ? Math.max(AMBIENT_K, cur.peakK * 0.8) : AMBIENT_K;
    }
  }
  fedSlot = fed;
  const k = 1 - Math.exp(-dt / COOL_TAU_S);
  for (let i = 0; i < HOT_SLOTS; i++) {
    const s = spots[i];
    if (!s.live) continue;
    s.fed = i === fed;
    // Fed: heats toward the melt peak within ~0.15 s. Unfed: relaxes to ambient with τ.
    if (s.fed) s.peakK += (MELT_PEAK_K * Math.min(1.1, 0.85 + 0.15 * beam.power) - s.peakK) * (1 - Math.exp(-dt / 0.05));
    else s.peakK += (AMBIENT_K - s.peakK) * k;
    if (!s.fed && s.peakK < 760) s.live = false;
  }
}

/** Drop spots on a rock that no longer exists. */
export function clearHotSpotsOn(rock: string): void {
  for (const s of spots) if (s.rock === rock) s.live = false;
  for (const p of sparks) if (p.rock === rock) p.live = false;
}

/** Write the uniforms: spot centres in scene metres. `toScene` maps field-local → scene. */
export function uploadHotSpots(toScene: (fieldId: string, x: number, y: number, z: number, out: number[]) => boolean, preExposure: number): void {
  const pos = _spotVecs;
  const T = uSpotT.array as number[];
  for (let i = 0; i < HOT_SLOTS; i++) {
    const s = spots[i];
    if (s.live && toScene(s.fieldId, s.x, s.y, s.z, _p)) {
      pos[i].x = _p[0]; pos[i].y = _p[1]; pos[i].z = _p[2]; pos[i].w = s.r;
      T[i] = s.peakK;
    } else {
      pos[i].w = 0;
      T[i] = 0;
    }
  }
  uHotPre.value = preExposure;
  uHotAny.value = spots.some((sp) => sp.live) ? 1 : 0;
}
const _p = [0, 0, 0];
const _hue = [1, 1, 1];

/** Luminous intensity of one spot, cd (∫ ε L_v(T(d)) dA over its temperature profile). */
function spotCandela(sp: Spot): number {
  let I = 0;
  const n = 16;
  for (let k = 0; k < n; k++) {
    const d = ((k + 0.5) / n) * 2.5 * sp.r;
    const T = AMBIENT_K + (sp.peakK - AMBIENT_K) * Math.exp(-(d * d) / (sp.r * sp.r));
    I += hotNits(T) * 2 * Math.PI * d * ((2.5 * sp.r) / n);
  }
  return I;
}

/** The fed spot's intensity, cd (0 when nothing is fed): what the impact PointLight carries. */
export function fedSpotCandela(): number {
  return fedSlot >= 0 && spots[fedSlot].live ? spotCandela(spots[fedSlot]) : 0;
}

/**
 * Every live spot as a light point (size 2r, so it takes over exactly as the rock emissive
 * fades by the same rule, `lampMeshWeight`): trail spots stay visible as dim red points far off.
 */
export function drawSpotPoints(toScene: (fieldId: string, x: number, y: number, z: number, out: number[]) => boolean): void {
  for (const sp of spots) {
    if (!sp.live || !toScene(sp.fieldId, sp.x, sp.y, sp.z, _p)) continue;
    const cd = spotCandela(sp);
    if (cd <= 0) continue;
    // Hue of the flux-weighted temperature, close to the peak (luminance runs ~T¹²).
    hotHue(sp.peakK * 0.97, _hue);
    const g = nitsToGameUnits(cd);
    pushLightPoint(_p[0], _p[1], _p[2], _hue[0] * g, _hue[1] * g, _hue[2] * g, 2 * sp.r);
  }
}

export function fedSpotPeakK(): number {
  return fedSlot >= 0 ? spots[fedSlot].peakK : 0;
}

/**
 * The near-tier asteroid material with hot spots: a node copy of the GLB material whose
 * emissive is the blackbody radiance of T(p) = ambient + Σ (peak − ambient)·e^(−d²/r²),
 * the max over slots, with ±6 % crack noise in TEMPERATURE (luminance runs ~T¹² there).
 */
const _hotMats = new WeakMap<object, MeshStandardNodeMaterial>();
export function hotRockMaterial(src: MeshStandardMaterial): MeshStandardNodeMaterial {
  const cached = _hotMats.get(src);
  if (cached) return cached;
  const m = new MeshStandardNodeMaterial();
  m.name = src.name;
  m.userData[SHADOW_SELF_ROCK] = true;
  m.color.copy(src.color);
  m.roughness = src.roughness;
  m.metalness = src.metalness;
  m.map = src.map;
  m.normalMap = src.normalMap;
  m.normalScale.copy(src.normalScale);
  m.roughnessMap = src.roughnessMap;
  m.metalnessMap = src.metalnessMap;
  m.aoMap = src.aoMap;
  m.emissive.copy(src.emissive);
  m.emissiveMap = src.emissiveMap;
  m.emissiveIntensity = src.emissiveIntensity;
  m.side = src.side;
  m.flatShading = src.flatShading;
  m.vertexColors = src.vertexColors;
  const tex = lutTexture();
  m.emissiveNode = Fn(() => {
    const T = float(0).toVar();
    If(uHotAny.greaterThan(0.5), () => Loop(HOT_SLOTS, ({ i }) => {
      const s = vec4(uSpotPos.element(i));
      const r = s.w;
      const d2 = positionWorld.sub(s.xyz).lengthSq();
      const t = float(uSpotT.element(i)).sub(AMBIENT_K).max(0).mul(d2.div(r.mul(r).max(1e-6)).negate().exp()).add(AMBIENT_K);
      T.assign(max(T, t.mul(select(r.greaterThan(0), float(1), float(0)))));
    }));
    const crack = float(1).add(mx_noise_float(positionWorld.mul(9)).mul(0.06));
    const Tn = T.mul(crack);
    const u = Tn.sub(LUT_MIN_K).div(LUT_MAX_K - LUT_MIN_K).clamp(0, 1);
    const L = texture(tex, vec2(u, 0.5)).rgb.mul(select(Tn.greaterThan(700), float(1), float(0)))
      .mul(lampMeshWeight(2 * SPOT_R_M));
    return vec3(L.mul(uHotPre)).min(HALF_FLOAT_WRITE_MAX).add(vec3(materialEmissive));
  })();
  _hotMats.set(src, m);
  return m;
}

// ── I2: sparks ───────────────────────────────────────────────────────────────

const SPARK_CAP = 256;
type Spark = {
  live: boolean; fieldId: string; rock: string;
  x: number; y: number; z: number; vx: number; vy: number; vz: number;
  age: number; T0: number; k: number; r: number;
};
const sparks: Spark[] = Array.from({ length: SPARK_CAP }, () => ({
  live: false, fieldId: "", rock: "", x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, T0: 0, k: 0, r: 0,
}));
let sparkNext = 0;
let sparkAcc = 0;
/** Droplets per second at stock power (B3: ∝ power). */
const SPARK_RATE = 45;
const SPARK_LIFE_S = 3.5;
/** ρc for molten basalt, J/(m³K): 2,800 kg/m³ × 1,000 J/(kg K). */
const RHO_C = 2.8e6;
const SIGMA = 5.670374e-8;

/** Spawn droplets at the hit (field-local), ejected round the outward normal. */
export function stepSparks(beam: BeamImpact, nx: number, ny: number, nz: number, dt: number, rand = Math.random): void {
  if (beam.on) {
    sparkAcc += SPARK_RATE * beam.power * dt;
    // Tangent frame round the normal.
    const ax = Math.abs(nx) < 0.9 ? 1 : 0, ay = ax ? 0 : 1;
    let tx = ny * 0 - nz * ay, ty = nz * ax - nx * 0, tz = nx * ay - ny * ax;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
    while (sparkAcc >= 1) {
      sparkAcc -= 1;
      const s = sparks[sparkNext];
      sparkNext = (sparkNext + 1) % SPARK_CAP;
      // Cone ~60° about the normal; speeds 3–25 m/s (vacuum melt ejecta).
      const phi = rand() * 2 * Math.PI, ct = 1 - rand() * 0.5, st = Math.sqrt(1 - ct * ct);
      const v = 3 + 22 * rand() * rand();
      const dx = nx * ct + (tx * Math.cos(phi) + bx * Math.sin(phi)) * st;
      const dy = ny * ct + (ty * Math.cos(phi) + by * Math.sin(phi)) * st;
      const dz = nz * ct + (tz * Math.cos(phi) + bz * Math.sin(phi)) * st;
      s.live = true; s.fieldId = beam.fieldId; s.rock = beam.rock;
      s.x = beam.x + nx * 0.05; s.y = beam.y + ny * 0.05; s.z = beam.z + nz * 0.05;
      s.vx = dx * v; s.vy = dy * v; s.vz = dz * v;
      s.age = 0;
      s.T0 = 2300 + 500 * rand();
      s.r = 0.0008 + 0.0017 * rand();
      s.k = (3 * EPS * SIGMA) / (RHO_C * s.r);
    }
  } else sparkAcc = 0;
  for (const s of sparks) {
    if (!s.live) continue;
    s.age += dt;
    s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
    if (s.age > SPARK_LIFE_S) s.live = false;
  }
}

/** Push live sparks as light points: I = ε L_v(T) π r², T from radiative cooling. */
export function drawSparks(toScene: (fieldId: string, x: number, y: number, z: number, out: number[]) => boolean): number {
  let n = 0;
  for (const s of sparks) {
    if (!s.live) continue;
    const T = s.T0 * Math.pow(1 + 3 * s.k * s.T0 ** 3 * s.age, -1 / 3);
    if (T < 850) { s.live = false; continue; }
    if (!toScene(s.fieldId, s.x, s.y, s.z, _p)) continue;
    const cd = hotNits(T) * Math.PI * s.r * s.r;
    hotHue(T, _hue);
    const g = nitsToGameUnits(cd);
    pushLightPoint(_p[0], _p[1], _p[2], _hue[0] * g, _hue[1] * g, _hue[2] * g, 0.004);
    n++;
  }
  return n;
}
