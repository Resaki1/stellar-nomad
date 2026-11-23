// ---------------------------------------------------------------------------
// DRIVE-BELL THERMAL GLOW — docs/HEAT_SYSTEM_PLAN.md §4, phase H1.
//
// The bell liner (and throat) emit blackbody radiance at the bell temperature from
// the thermal network: physical cd/m² (blackbodyLuminanceNits × ε), blackbody hue,
// pre-exposed (D25), clamped to the half-float write limit. Exactly zero below
// 700 K: a glowing cold bell is the ShipOne metering defect.
// Materials are cloned per ship: the GLTF cache shares them between the local ship
// and every remote one.
// ---------------------------------------------------------------------------

import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { ClampToEdgeWrapping, DataTexture, FloatType, LinearFilter, Mesh, type Material, type MeshStandardMaterial, type Object3D } from "three";
import {
  blackbodyLinearSrgb,
  blackbodyLuminanceNits,
  getPreExposure,
  HALF_FLOAT_WRITE_MAX,
  nitsToGameUnits,
} from "@/components/space/photometry";
import { THERMAL } from "@/sim/ship/thermal";

/** Hot-section materials at every LOD (build.py: LOD0 liner + throat; LOD1/2 "Distant drive liner"). */
const HOT = new Map<string, number>([
  ["Oxidized liner", 1],
  ["Distant drive liner", 1],
  // The throat cup sits upstream of the bell: hotter than the lumped bell node.
  ["Carbon refractory throat", 1.08],
]);
const GLOW_MIN_K = 700;
const LUT_MIN_K = 700;
const LUT_MAX_K = 2400;
const LUT_STEP_K = 10;
let lut: Float32Array | null = null;

/** Emitted radiance in linear game units per channel, ε folded in (lazy; the integrals are slow). */
function radianceLut(): Float32Array {
  if (lut) return lut;
  const n = Math.round((LUT_MAX_K - LUT_MIN_K) / LUT_STEP_K) + 1;
  lut = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const T = LUT_MIN_K + i * LUT_STEP_K;
    const L = nitsToGameUnits(THERMAL.bellEmissivity * blackbodyLuminanceNits(T));
    const [r, g, b] = blackbodyLinearSrgb(T);
    lut[i * 3] = Math.max(0, r) * L;
    lut[i * 3 + 1] = Math.max(0, g) * L;
    lut[i * 3 + 2] = Math.max(0, b) * L;
  }
  return lut;
}

/** `peak`: the emissiveMap's maximum, which the shader multiplies in AFTER our clamp. */
type HotMat = { mat: MeshStandardMaterial; gain: number; peak: number };
const GRADIENT_PEAK = 1.7;

/**
 * Throat→lip radiance gradient for the LOD0 liner, along its "Nozzle wrap" UV v (build.py:
 * v 0.08 at the throat ring, 0.94 at the lip). The lumped node is the bell's MEAN temperature;
 * the throat runs hotter, the radiating lip cooler (~±8 % in T ≈ ×1.7 / ×0.3 in luminance at
 * T¹²). Luminance only — the hue stays the mean's. Shared by every ship (read-only).
 */
let gradient: DataTexture | null = null;
function axialGradient(): DataTexture {
  if (gradient) return gradient;
  const n = 64;
  const data = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const v = (i + 0.5) / n;
    const g = GRADIENT_PEAK * Math.pow(0.3 / GRADIENT_PEAK, Math.min(1, Math.max(0, (v - 0.08) / 0.86)));
    data.set([g, g, g, 1], i * 4);
  }
  gradient = new DataTexture(data, 1, n, undefined, FloatType);
  gradient.minFilter = gradient.magFilter = LinearFilter;
  gradient.wrapS = gradient.wrapT = ClampToEdgeWrapping;
  gradient.needsUpdate = true;
  return gradient;
}

/** Clone the hot-section materials under `root` so this ship glows on its own; `release` undoes it. */
function claimHotMaterials(root: Object3D): { hot: HotMat[]; release: () => void } {
  const hot: HotMat[] = [];
  const swapped: { part: Mesh; original: Material; clone: Material }[] = [];
  root.traverse((part) => {
    if (!(part instanceof Mesh) || Array.isArray(part.material)) return;
    const gain = HOT.get(part.material.name);
    if (gain === undefined || !("emissive" in part.material)) return;
    const original = part.material as MeshStandardMaterial;
    const mat = original.clone();
    mat.emissive.setRGB(0, 0, 0);
    mat.emissiveIntensity = 1;
    // Only the LOD0 liner carries the bell's wrap UVs; far LODs glow uniformly (sub-pixel there).
    const mapped = original.name === "Oxidized liner" && !!part.geometry.getAttribute("uv");
    if (mapped) {
      mat.emissiveMap = axialGradient();
      mat.needsUpdate = true;
    }
    part.material = mat;
    swapped.push({ part, original, clone: mat });
    hot.push({ mat, gain, peak: mapped ? GRADIENT_PEAK : 1 });
  });
  return {
    hot,
    release: () => swapped.forEach(({ part, original, clone }) => {
      part.material = original;
      clone.dispose();
    }),
  };
}

/** Write one frame of glow for a bell at `bellK`. */
function applyGlow(hot: readonly HotMat[], bellK: number): void {
  const table = radianceLut();
  const p = getPreExposure();
  for (const { mat, gain, peak } of hot) {
    // The map multiplies after this write, so the cap must leave room for its peak (review F3).
    const cap = HALF_FLOAT_WRITE_MAX / peak;
    const T = bellK * gain;
    if (!(T > GLOW_MIN_K)) {
      mat.emissive.setRGB(0, 0, 0);
      continue;
    }
    const x = (Math.min(T, LUT_MAX_K) - LUT_MIN_K) / LUT_STEP_K;
    const i = Math.min(Math.floor(x), table.length / 3 - 2);
    const f = x - i;
    const a = i * 3, b = a + 3, g = 1 - f;
    mat.emissive.setRGB(
      Math.min((table[a] * g + table[b] * f) * p, cap),
      Math.min((table[a + 1] * g + table[b + 1] * f) * p, cap),
      Math.min((table[a + 2] * g + table[b + 2] * f) * p, cap),
    );
  }
}

/**
 * Drive the hot-section emissive of `root` from `bellK()` every frame.
 * `bellK` reads the local ship's sim state or a remote ship's local integration (`remote`).
 */
type GlowProbe = { remote: boolean; bellK: () => number; hot: () => HotMat[] };

export function useBellGlow(root: Object3D, bellK: () => number, remote = false): void {
  const hot = useRef<HotMat[]>([]);
  const bellKRef = useRef(bellK);
  // ⚠ In an effect, never a useMemo: the claim swaps materials on shared meshes, and StrictMode's
  // double-invoked memo left the mesh holding one set of clones while the frame loop lit the other.
  useEffect(() => {
    const claimed = claimHotMaterials(root);
    hot.current = claimed.hot;
    // Dev-only probe for scripted checks (co-op remoteBells gate); never read by the game.
    const probes = process.env.NODE_ENV !== "production"
      ? ((globalThis as unknown as { __bellGlows?: Set<GlowProbe> }).__bellGlows ??= new Set()) : null;
    const probe: GlowProbe = { remote, bellK: () => bellKRef.current(), hot: () => hot.current };
    probes?.add(probe);
    return () => {
      probes?.delete(probe);
      hot.current = [];
      claimed.release();
    };
  }, [root, remote]);
  useFrame(() => {
    bellKRef.current = bellK;
    applyGlow(hot.current, bellK());
  });
}
