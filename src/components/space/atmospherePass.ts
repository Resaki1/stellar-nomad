import * as THREE from "three";
import { NodeMaterial, RenderTarget, Storage3DTexture } from "three/webgpu";
import type { WebGPURenderer } from "three/webgpu";
import {
  Fn,
  If,
  Loop,
  uniform,
  texture,
  texture3D,
  screenUV,
  vec2,
  vec3,
  vec4,
  float,
  dot,
  cross,
  normalize,
  length,
  exp,
  pow,
  sqrt,
  abs,
  max,
  clamp,
  sin,
  cos,
  acos,
  atan,
  select,
  mix,
  int,
  uint,
  uvec3,
  instanceIndex,
  textureStore,
  smoothstep,
} from "three/tsl";
import { SCALED_UNITS_PER_KM } from "@/sim/units";
import type { AtmosphereParams } from "../celestial/types";

// =============================================================================
// Physically-based atmospheric scattering — Hillaire 2020 (the Unreal model).
// See docs/ATMOSPHERE_PLAN.md (§3-6) and the research synthesis it was built
// from. This is the Phase-1 core: two static LUTs (transmittance, multiple-
// scattering) baked once per atmosphere, and a per-pixel raymarch fullscreen
// pass that fogs the scaled-scene background (planets/skybox/stars) with
// transmittance + in-scattering. Delivers blue day sky, reddened sunset, the
// glowing limb / full disc from space, and the twilight planet-shadow wedge.
//
// All scattering math runs in PLANET-CENTERED KILOMETRES (planet at origin,
// axes aligned with scaled-world). Coefficients in AtmosphereParams are m^-1;
// they are converted to km^-1 once on the CPU (×1000) in setAtmosphere, so the
// shader works purely in km / km^-1. (Mixing the two is the classic failure
// mode — convert exactly once.)
//
// Reference: Hillaire 2020 + github.com/sebh/UnrealEngineSkyAtmosphere.
// =============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

const PI = Math.PI;
const ISOTROPIC_PHASE = 1.0 / (4.0 * PI);
// Push march start points off sphere boundaries to kill self-intersection
// (Hillaire's PLANET_RADIUS_OFFSET), in km.
const SURFACE_OFFSET_KM = 0.01;

// LUT dimensions (Hillaire 2020, Table 2).
export const TRANSMITTANCE_LUT_W = 256;
export const TRANSMITTANCE_LUT_H = 64;
export const MULTISCATTER_LUT_SIZE = 32;

// Step / sample counts.
const TRANSMITTANCE_STEPS = 40;
const MS_SQRT_SAMPLES = 8; // → 64 sphere directions
const MS_SAMPLE_COUNT = MS_SQRT_SAMPLES * MS_SQRT_SAMPLES;
const MS_STEPS = 20;
const MAIN_STEPS = 32; // per-pixel screen march (fixed; jitter/adaptive is Phase 4)
const SAMPLE_SEGMENT_T = 0.3; // reference midpoint bias for the screen march

// ── Aerial-perspective froxel (Phase 4) ──
// A camera-frustum volume: (x,y) = screen tile, z = depth slice. Stores the
// atmosphere integrated from the camera to each depth (RGB = in-scatter, A =
// mean transmittance), so any object can be fogged by sampling at its depth.
export const FROXEL_DIM = 32; // NX = NY = NZ
const FROXEL_VOXELS = FROXEL_DIM * FROXEL_DIM * FROXEL_DIM;
const FROXEL_MARCH_STEPS = 24; // per-voxel march steps from the camera to its depth
// Far plane of the froxel (km). Depth is distributed QUADRATICALLY (w² · max),
// so near slices are dense where aerial perspective varies fastest. Beyond this
// the consumer clamps to the last slice (AP is near-saturated there anyway).
const FROXEL_MAX_DEPTH_KM = 600;

// ── GPU debug viz (off by default) ──
// Build-const → only the selected path compiles, so 'off' costs nothing. Each
// mode replaces the on-screen output with a diagnostic. Mirrors the cloud
// pipeline's DEBUG_VIZ convention; handy when bringing up new atmospheres
// (Mars/procedural) or for Phase 2.
type AtmoDebug =
  | "off"
  | "slabHit" // blue where the atmosphere shell is intersected (else dark red)
  | "extinction" // sampleMedium extinction at the surface ×30 → medium sampling
  | "sunT" // transmittance toward the sun → transmittance LUT + its sampler
  | "inscatter" // raw accumulated in-scatter L → the march integral
  | "lutT" // blit the transmittance LUT
  | "lutMS" // blit the multiple-scattering LUT
  | "froxel" // blit the AP froxel's far-slice in-scatter → the froxel bake
  | "skyView"; // blit the Sky-View LUT (lat/long sky map) → the sky-view bake
const DEBUG_ATMOSPHERE: AtmoDebug = "off";

// The AP froxel bake is GPU work worth doing only when something consumes the
// volume: the 'froxel' debug viz, or the cloud aerial perspective (Phase 4
// step 2 — the cloud composite samples the froxel at the cloud-front depth).
// Gate the per-frame dispatch on this so it costs ZERO until a consumer exists.
const USE_FROXEL_AP = true;
export const FROXEL_ENABLED: boolean =
  // `as string` defeats TS's module-scope const narrowing (it pins
  // DEBUG_ATMOSPHERE to its literal here, which would make the comparison a
  // "no-overlap" error — the in-Fn viz checks dodge this via closure widening).
  USE_FROXEL_AP || (DEBUG_ATMOSPHERE as string) === "froxel";

// Sky-View LUT per-frame bake gate. Step 2: the main pass samples the LUT for
// sky rays at low altitude (crossfading to the raymarch above), so the bake is
// on. Flip false to disable the whole Sky-View path (main pass falls back to the
// per-pixel march everywhere).
const USE_SKYVIEW = true;
export const SKYVIEW_ENABLED: boolean =
  USE_SKYVIEW || (DEBUG_ATMOSPHERE as string) === "skyView";

/**
 * Map (radius, sun-zenith-cosine) → transmittance-LUT UV (Bruneton param).
 * Pure TSL; UNIT-AGNOSTIC — r, bottomRadius, topRadius, H must share one unit
 * (the result is built from length RATIOS, so it is scale-invariant). The
 * atmosphere pass calls it in km; the cloud marcher calls it in scaled-world
 * units. Single source of truth so both map into the LUT identically.
 */
export const transmittanceLutUv = (
  r: Node,
  mu: Node,
  bottomRadius: Node,
  topRadius: Node,
  H: Node,
): Node => {
  const rho = sqrt(max(0, r.mul(r).sub(bottomRadius.mul(bottomRadius))));
  const disc = r.mul(r).mul(mu.mul(mu).sub(1)).add(topRadius.mul(topRadius));
  const d = max(0, r.mul(mu).negate().add(sqrt(max(0, disc))));
  const dMin = topRadius.sub(r);
  const dMax = rho.add(H);
  const xMu = d.sub(dMin).div(dMax.sub(dMin).max(1e-6));
  const xR = rho.div(H.max(1e-6));
  return vec2(xMu, xR);
};

// Shared static LUT render targets (transmittance, multiple-scattering). A
// process-lifetime singleton (like the cloud noise volumes) so BOTH the
// atmosphere pass and the cloud marcher can bind the SAME stable textures at
// graph-build time — the WebGPU bind-group cache wants textures bound once and
// never reassigned. SpaceRenderer's atmosphere pass BAKES them; the cloud
// marcher only READS (sampling the transmittance LUT for per-sample sun colour).
let _sharedLUTs: {
  transmittance: RenderTarget;
  multiScatter: RenderTarget;
} | null = null;

export function getAtmosphereLUTs(): {
  transmittance: RenderTarget;
  multiScatter: RenderTarget;
} {
  if (!_sharedLUTs) {
    _sharedLUTs = {
      transmittance: new RenderTarget(TRANSMITTANCE_LUT_W, TRANSMITTANCE_LUT_H, {
        type: THREE.HalfFloatType,
        depthBuffer: false,
      }),
      multiScatter: new RenderTarget(MULTISCATTER_LUT_SIZE, MULTISCATTER_LUT_SIZE, {
        type: THREE.HalfFloatType,
        depthBuffer: false,
      }),
    };
  }
  return _sharedLUTs;
}

// Shared aerial-perspective froxel (Phase 4). A process-lifetime singleton
// rgba16float Storage3DTexture (the only storage-writable + linear-filterable
// base format), trilinear + clamp-to-edge, single-mip — written by the
// atmosphere pass's compute bake each frame, sampled by consumers (clouds /
// local scene) at (screenUV, depthSlice). Mirrors cloudLightVolume's makeVolTex.
let _sharedFroxel: Storage3DTexture | null = null;

export function getAtmosphereFroxel(): Storage3DTexture {
  if (!_sharedFroxel) {
    const tex = new Storage3DTexture(FROXEL_DIM, FROXEL_DIM, FROXEL_DIM);
    tex.format = THREE.RGBAFormat; // REQUIRED — drives getFormat()
    tex.type = THREE.HalfFloatType; // RGBAFormat + HalfFloat ⇒ rgba16float
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.wrapR = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false; // storage textures are single-mip
    _sharedFroxel = tex;
  }
  return _sharedFroxel;
}

// ── Sky-View LUT (Phase 4) ──────────────────────────────────────────────────
// A lat/long map of the DISTANT sky from the camera's CURRENT altitude, baked
// per frame: u = azimuth around local-up measured from the sun (u=0.5 → toward
// the sun, u=0/1 → anti-sun seam), v = view elevation with Hillaire's quadratic
// horizon-concentrating map `v = 0.5 + 0.5·sign(l)·sqrt(|l|/(π/2))`, l∈[-π/2,π/2]
// (l=0 = local horizontal → v=0.5; upper half = sky, lower half = toward ground).
// Stores RGB = sky in-scatter, A = mean transmittance (background/star
// attenuation). The main pass samples it for SKY rays at low altitude instead
// of marching per pixel (Phase 4 step 2); it degenerates from space (the planet
// shrinks, most of the map is wasted) so the pass crossfades back to the
// per-pixel raymarch with altitude. Process-lifetime singleton (bound at
// graph-build like the other LUTs; survives pass rebuilds on resize).
export const SKYVIEW_W = 200;
// Elevation resolution. Hillaire's paper baseline is 100, but that "renders at a
// lower resolution" (his words) and only the non-linear map hides it — residual
// banding shows in the bright limb gradient at altitude (worse the higher you
// are, as the limb compresses). The paper's own remedy is to raise the LUT
// resolution; the bake is a cheap fullscreen pass so we over-resolve elevation
// (the banding axis) generously. Azimuth (W) stays at baseline — no azimuthal
// banding. Tune down if the bake ever shows on a profile.
export const SKYVIEW_H = 256;
const SKYVIEW_STEPS = 30; // per-texel sky march (Hillaire Table 2; sky is low-freq)

// Altitude crossfade (km above ground) between the Sky-View LUT and the per-pixel
// raymarch for SKY rays. The LUT assumes the planet fills the lower hemisphere —
// true near/in the atmosphere, false from space (the planet becomes a small
// disk), so we fade to the march with altitude. Below FULL → pure LUT (the perf
// win: the march is skipped for sky pixels); above MARCH → pure march; the band
// blends. The LUT is baked from the SAME march integral, so the two agree almost
// exactly → the crossfade is seamless (avoids the classic LUT↔march hitch).
const SKYVIEW_FULL_ALT_KM = 60; // ≤ this altitude → pure LUT
const SKYVIEW_MARCH_ALT_KM = 150; // ≥ this altitude → pure march
// Bake only where the LUT is consumed (blend < 1), plus a small descent margin.
export const SKYVIEW_BAKE_MAX_ALT_KM = SKYVIEW_MARCH_ALT_KM + 30;

let _skyViewLUT: RenderTarget | null = null;

export function getSkyViewLUT(): RenderTarget {
  if (!_skyViewLUT) {
    const rt = new RenderTarget(SKYVIEW_W, SKYVIEW_H, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
    });
    // Azimuth wraps at the anti-sun seam (u=0 ≡ u=1) → RepeatWrapping on S so the
    // bilinear fetch there is seamless; elevation clamps. (Filter defaults are
    // Linear, which the sampler wants.)
    rt.texture.wrapS = THREE.RepeatWrapping;
    rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    _skyViewLUT = rt;
  }
  return _skyViewLUT;
}

// Strength dial for the cloud aerial-perspective fog (1 = full physical, 0 =
// off). Lets the user trim it if the in-scatter reads too strong against the
// cloud brightness scale (clouds sit at CLOUD_SUN_SCALE, the sky at full
// illuminance — the §6 unified-exposure pass would reconcile the two).
const CLOUD_AP_STRENGTH = 1.0;

// ── AP fog depth (Phase 4 step 2 — flicker fix) ─────────────────────────────
// The cloud AP fogs each cloud pixel by the froxel sampled at the cloud's camera
// distance. That distance is the marcher's per-pixel cloud-front depth (sparse
// `tFront`) — the only quantity that is geometrically correct in EVERY regime
// (distant limb clouds, the in-deck fly-through, cloud tops above the shell
// tangent). An analytic single-shell distance was tried and FAILED there: rays
// that miss the shell got zero depth (hard "no-haze above the horizon" line) and
// the geometry inverts once the camera crosses the shell. The catch with tFront
// is purely STABILITY: it is half-res, its no-hit value (≤0) bleeds across
// silhouettes under bilinear upsampling, and the marcher jitters it ±a skip-step
// per frame (earthClouds.ts §stratJitter) — a jitter the colour path's temporal
// EMA averages out but the raw-depth read does not → the distant-cloud flicker.
// Fix: read it through a small SENTINEL-REJECTING average (only taps with depth
// >0 contribute), which rejects the no-hit bleed at edges and damps the jitter,
// and gate the fog on cloud presence (a valid tap) instead of a per-pixel
// depth>0 test (the old edge on/off toggle). Kernel radius in SPARSE texels.
const CLOUD_DEPTH_GATHER_RADIUS = 1; // 1 → 3×3 sparse-texel taps

// ── Cloud-AP diagnostics (off by default) ───────────────────────────────────
// Build-const, mirroring DEBUG_ATMOSPHERE: only the selected branch compiles, so
// 'off' costs nothing. Each mode (except constSlice) overlays an OPAQUE viz ONLY
// where a cloud exists and passes the cloud through elsewhere — so you fly the
// normal scene and read the diagnostic on the clouds themselves. Purpose-built
// to root-cause the distant-cloud "dark rectangle" flicker:
//
//   "off"        normal cloud AP (ship default — keep this committed).
//   "wslice"     grayscale of the froxel z-index sampled (sqrt of normalised
//                GATHERED depth). Smooth + steady with a still camera = fixed.
//   "sparseRaw"  A/B: the OLD single raw sparse-tFront tap, for contrast against
//                "wslice". Should look speckled/jittery at edges where "wslice"
//                is smooth — the visual proof of the gather.
//   "depthRaw"   grayscale of the gathered depth (km, normalised), pre-sqrt.
//   "apT"        grayscale of the sampled mean transmittance (ap.a).
//   "apL"        the sampled in-scatter (ap.rgb) — should be a smooth haze field.
//   "nan"        magenta over clouds wherever the froxel sample is non-finite.
//   "constSlice" pins the froxel slice to a constant (froxel-content check).
//   "constAP"    constant fog, no froxel/depth — isolates cloudPremul.
//
// Diagnosis (resolved): the distant-cloud "dark rectangle" flicker was the AP
// reading the cloud's fog depth from the marcher's raw sparse tFront — half-res
// (no-hit ≤0 bleeds across silhouettes under bilinear upsampling) and jittered
// ±a skip-step per frame (un-averaged on this path), so the depth>0 gate toggled
// fog on/off at edges. Confirmed on-device: constSlice no-change (not the slice),
// nan clean (no bad voxels), constAP clean (not cloudPremul), wslice/depthRaw
// black-speckle at edges (depth≤0). An analytic cloud-shell depth was tried and
// failed (no fog above the shell tangent; inverts when the camera crosses it).
// Fix: keep the real per-pixel tFront but read it through a SENTINEL-REJECTING
// gather (CLOUD_DEPTH_GATHER_RADIUS) + gate on cloud presence not depth>0.
type ApDebug =
  | "off"
  | "constSlice"
  | "constAP"
  | "wslice"
  | "depthRaw"
  | "sparseRaw"
  | "apT"
  | "apL"
  | "nan";
const AP_DEBUG: ApDebug = "off";
// Fixed froxel slice for "constSlice" (0..1; 0.6 ≈ mid-far depth). Only read in
// that mode.
const AP_DEBUG_CONST_SLICE = 0.6;

/**
 * Fog a premultiplied-alpha cloud RGBA by the aerial-perspective froxel (Phase 4
 * step 2). Samples the froxel at this pixel's screen UV and the cloud's camera
 * distance, then applies premultiplied AP: rgb' = rgb·Tmean + inscatter·alpha,
 * alpha unchanged. Built into the cloud-composite fragment (SpaceRenderer).
 *
 * Fog depth = the marcher's per-pixel cloud-front depth (sparse `tFront`, scaled-
 * world units), read through a SENTINEL-REJECTING average over a small kernel
 * (CLOUD_DEPTH_GATHER_RADIUS, in sparse texels): only taps with depth>0 (a real
 * cloud hit) contribute. This rejects the no-hit value (≤0) bleeding across
 * silhouettes under bilinear upsampling and damps the marcher's per-frame
 * ±skip-step jitter (earthClouds.ts §stratJitter) — the two causes of the
 * distant-cloud edge flicker — WITHOUT discarding the real depth (which, unlike
 * an analytic single-shell distance, is correct in every regime: distant limb
 * clouds, in-deck fly-through, cloud tops). `texelX/Y` are the sparse depth RT's
 * 1/width, 1/height (the gather step).
 *
 * Gated on (a valid depth tap exists) AND (the froxel is baked). The first
 * replaces the old per-pixel depth>0 test — that toggled fog on/off frame-to-
 * frame at silhouettes (the flicker); the gather's "any valid tap in the kernel"
 * is stable across the cloud body and only wobbles ~1 sparse texel outside it,
 * where the premultiplied alpha is ~0 so the fog is a no-op anyway. The baked
 * guard ((a+rgb)>ε) avoids BLACK clouds from a never-baked all-zero froxel and
 * distinguishes that from legitimate FULL haze (Tmean→0 but L large).
 */
export const applyCloudAerialPerspective = (
  cloudPremul: Node,
  screenUvNode: Node,
  sparseDepthTexture: THREE.Texture,
  texelX: number,
  texelY: number,
): Node => {
  // Widen past TS's literal-narrowing of the module const (it pins AP_DEBUG to
  // "off", which makes the mode comparisons "no-overlap" errors) — mirrors the
  // `as string` dodge on FROXEL_ENABLED. Runtime value is unchanged.
  const dbg = AP_DEBUG as ApDebug;

  // Sentinel-rejecting average of the sparse cloud-front depth: only taps with
  // depth>0 contribute, so the no-hit value (≤0) can't bleed in and the jitter is
  // averaged down. dSum/wSum = mean valid depth (0 if no valid tap); wSum = valid
  // tap count = cloud-presence signal.
  const r = CLOUD_DEPTH_GATHER_RADIUS;
  let dSum: Node = float(0);
  let wSum: Node = float(0);
  for (let oy = -r; oy <= r; oy++) {
    for (let ox = -r; ox <= r; ox++) {
      const d = (
        texture(
          sparseDepthTexture,
          vec2(
            screenUvNode.x.add(float(ox * texelX)),
            screenUvNode.y.add(float(oy * texelY)),
          ),
        ).level(int(0)) as Node
      ).r;
      const w = select(d.greaterThan(0), float(1), float(0));
      dSum = dSum.add(d.mul(w));
      wSum = wSum.add(w);
    }
  }
  const hasDepth = wSum.greaterThan(float(0.5));
  const depthSU = dSum.div(wSum.max(float(1e-6))); // scaled units
  const depthKm = depthSU.div(SCALED_UNITS_PER_KM);
  const depth01 = clamp(depthKm.div(FROXEL_MAX_DEPTH_KM), 0, 1);
  const wSliceFromDepth = sqrt(depth01);

  // constAP: constant fog, no froxel read, no depth — the only per-frame input is
  // cloudPremul (the depth-path discriminator that confirmed the diagnosis).
  if (dbg === "constAP") {
    const cT = float(0.6);
    const cL = vec3(0.3, 0.35, 0.5);
    return vec4(
      cloudPremul.rgb.mul(cT).add(cL.mul(cloudPremul.a)),
      cloudPremul.a,
    );
  }

  // constSlice pins the slice so the froxel CONTENT (not the depth) drives output.
  const wSlice =
    dbg === "constSlice" ? float(AP_DEBUG_CONST_SLICE) : wSliceFromDepth;
  const ap = texture3D(
    getAtmosphereFroxel(),
    vec3(screenUvNode.x, screenUvNode.y, wSlice),
  ).level(int(0)) as Node;
  // Premultiplied AP: rgb·T (A=mean transmittance) + inscatter·alpha (RGB).
  const fogged = vec4(
    cloudPremul.rgb.mul(ap.a).add(ap.rgb.mul(cloudPremul.a)),
    cloudPremul.a,
  );
  const baked = ap.a.add(ap.r).add(ap.g).add(ap.b).greaterThan(float(1e-4));
  const normal = select(
    baked.and(hasDepth),
    mix(cloudPremul, fogged, float(CLOUD_AP_STRENGTH)),
    cloudPremul,
  );

  // ── Diagnostics (build-const; 'off'/'constSlice' take the physical path) ──
  if (dbg === "off" || dbg === "constSlice") return normal;
  // Opaque overlay where a cloud exists (premul alpha > 0); passthrough else.
  // CustomBlending(One, OneMinusSrcAlpha): returning alpha=1 replaces the pixel.
  const overCloud = cloudPremul.a.greaterThan(float(0.01));
  const viz = (rgb: Node): Node => select(overCloud, vec4(rgb, 1), cloudPremul);
  if (dbg === "wslice") return viz(vec3(wSliceFromDepth));
  if (dbg === "depthRaw") return viz(vec3(depth01));
  if (dbg === "sparseRaw") {
    // A/B contrast: the OLD single raw sparse-tFront tap (the flicker source) vs
    // the gathered, now-stable 'wslice'. Should look speckled/jittery at edges
    // where 'wslice' is smooth — the visual proof of the fix.
    const sd = (texture(sparseDepthTexture, screenUvNode).level(int(0)) as Node).r;
    const sd01 = clamp(
      sd.div(SCALED_UNITS_PER_KM).div(FROXEL_MAX_DEPTH_KM),
      0,
      1,
    );
    return viz(vec3(sqrt(sd01)));
  }
  if (dbg === "apT") return viz(vec3(ap.a));
  if (dbg === "apL") return viz(ap.rgb);
  // "nan": magenta over clouds where the froxel sample is non-finite. abs(x) <
  // 1e20 is FALSE for both NaN and Inf, so 'finite' is false there → magenta.
  const finite = abs(ap.r)
    .lessThan(float(1e20))
    .and(abs(ap.g).lessThan(float(1e20)))
    .and(abs(ap.b).lessThan(float(1e20)))
    .and(abs(ap.a).lessThan(float(1e20)));
  return select(finite, normal, viz(vec3(1, 0, 1)));
};

// =============================================================================
// Atmosphere-body registry. Each CelestialBody with config.atmosphere pushes its
// scaled center + sun direction + distance here each frame (while its sphere LOD
// is visible). The pass picks the nearest active body. Mirrors the cloud
// pipeline's global-singleton handoff (getActiveCloudPipeline).
// =============================================================================

/**
 * Analytic ring annulus registered alongside a body's atmosphere (Phase 5 ring
 * coupling). Plane passes through the planet centre; `normal` is in scaled-
 * world axes (the same frame as sunDir, and — directionally — the planet-
 * centred km frame the shader marches in).
 */
export type AtmosphereRingRecord = {
  normal: THREE.Vector3;
  innerRadiusKm: number;
  outerRadiusKm: number;
  /** Mean ring opacity (fog clamp weight + sun-shadow strength). */
  opacity: number;
};

export type AtmosphereBodyRecord = {
  id: string;
  /** Planet centre in scaled-world units (origin-relative — same frame as the scaled camera). */
  centerScaled: THREE.Vector3;
  /** Normalised direction from the planet centre toward the sun (scaled-world axes). */
  sunDir: THREE.Vector3;
  /** Camera→centre distance in km (dominance + gating). */
  distanceKm: number;
  params: AtmosphereParams;
  rings: AtmosphereRingRecord | null;
};

const atmosphereBodies = new Map<string, AtmosphereBodyRecord>();

/** Register/update a body's atmosphere for this frame. Vectors are copied. */
export function setAtmosphereBody(
  id: string,
  centerScaled: THREE.Vector3,
  sunDir: THREE.Vector3,
  distanceKm: number,
  params: AtmosphereParams,
  rings: AtmosphereRingRecord | null = null,
): void {
  let rec = atmosphereBodies.get(id);
  if (!rec) {
    rec = {
      id,
      centerScaled: new THREE.Vector3(),
      sunDir: new THREE.Vector3(),
      distanceKm: 0,
      params,
      rings: null,
    };
    atmosphereBodies.set(id, rec);
  }
  rec.centerScaled.copy(centerScaled);
  rec.sunDir.copy(sunDir).normalize();
  rec.distanceKm = distanceKm;
  rec.params = params;
  if (rings) {
    if (!rec.rings) {
      rec.rings = {
        normal: new THREE.Vector3(),
        innerRadiusKm: 0,
        outerRadiusKm: 0,
        opacity: 0,
      };
    }
    rec.rings.normal.copy(rings.normal).normalize();
    rec.rings.innerRadiusKm = rings.innerRadiusKm;
    rec.rings.outerRadiusKm = rings.outerRadiusKm;
    rec.rings.opacity = rings.opacity;
  } else {
    rec.rings = null;
  }
}

export function clearAtmosphereBody(id: string): void {
  atmosphereBodies.delete(id);
}

/** Nearest active atmosphere body, or null. (Phase 1: only Earth registers.) */
export function getDominantAtmosphereBody(): AtmosphereBodyRecord | null {
  let best: AtmosphereBodyRecord | null = null;
  atmosphereBodies.forEach((rec) => {
    if (!best || rec.distanceKm < best.distanceKm) best = rec;
  });
  return best;
}

// =============================================================================
// CPU-side lighting coupling (Phase 2 — docs/ATMOSPHERE_PLAN.md §5.4).
//
// The atmosphere pass fogs the scaled-scene BACKGROUND (planets/skybox/stars,
// incl. the sun disk). But the LOCAL scene (ship/asteroids; composited later by
// SpaceRenderer) is lit by ordinary three.js lights and is never touched by the
// pass. To make the ship pick up sunset reddening, planet-shadow darkening, and
// blue sky fill, we compute — once per frame, on the CPU — the sun transmittance
// reaching the camera and a cheap sky-ambient term, and stash them for
// `SunLight` and the sky-ambient hemisphere light to read.
//
// CPU (not a GPU LUT read-back): a 40-step optical-depth march in JS is ~free
// once per frame, and avoids a stalling async GPU read. The math mirrors the
// shader's `sampleMedium` + ray-sphere exactly (same m^-1 → km^-1 ×1000).
//
// NOTE: the SUN DISK is intentionally NOT tinted here. It lives in the scaled
// scene and is already reddened by the main pass's view-ray throughput; tinting
// it again would double-count. The sky-ambient term is a deliberately simple
// analytic stand-in for a proper hemispherical irradiance (LUT-based; Phase 4).
// =============================================================================

// Tuning (all in SunLight's intensity scale / cosine-of-zenith units).
const SUN_T_STEPS = 64; // optical-depth march steps toward the sun
// Soft "emergence" band (cosine), applied JUST ABOVE the geometric horizon, to
// ramp the sun in over roughly its angular size as it clears the planet limb.
// Below the horizon the sun is hard-occluded (T=0); the band sits entirely in
// the clear region so the two meet continuously at the horizon — without this
// (or with a centred band + partial-path march) shadow exit flashes orange.
const SUN_EMERGE_BAND = 0.04;
const SKY_AMBIENT_MAX_INTENSITY = 2.5; // hemisphere fill at full day on the ground
const SKY_TINT_SATURATION = 0.7; // 0 = white sky fill, 1 = pure Rayleigh blue
const SKY_DAY_BAND_LO = 0.25; // wide twilight band so the fill lingers past sunset
const SKY_DAY_BAND_HI = 0.1;

export type AtmosphereLighting = {
  /** True when a dominant atmosphere body is driving the lighting. */
  active: boolean;
  /** Per-channel sun transmittance reaching the camera (∈[0,1]); white when inactive. */
  sunTransmittance: THREE.Color;
  /** Hemisphere sky-fill colour (sky side). */
  skyColor: THREE.Color;
  /** Hemisphere ground-bounce colour (down side). */
  groundColor: THREE.Color;
  /** Sky-fill intensity in SunLight's scale (0 when inactive / in space). */
  skyIntensity: number;
  /** Planet-local up at the camera (world axes) — orients the hemisphere light. */
  upDir: THREE.Vector3;
};

const _lighting: AtmosphereLighting = {
  active: false,
  sunTransmittance: new THREE.Color(1, 1, 1),
  skyColor: new THREE.Color(1, 1, 1),
  groundColor: new THREE.Color(1, 1, 1),
  skyIntensity: 0,
  upDir: new THREE.Vector3(0, 1, 0),
};

/** Current per-frame atmosphere lighting (mutated in place; do not retain). */
export function getAtmosphereLighting(): AtmosphereLighting {
  return _lighting;
}

/** Reset to "no atmosphere" — white sun, no sky fill (deep space / no body). */
export function clearAtmosphereLighting(): void {
  _lighting.active = false;
  _lighting.sunTransmittance.setRGB(1, 1, 1);
  _lighting.skyIntensity = 0;
}

const smoothstepScalar = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / Math.max(1e-6, e1 - e0)));
  return t * t * (3 - 2 * t);
};

// Radial ring density at a normalised radius u∈[0,1] across [inner,outer] —
// EXACT JS twin of the shader's `ringDensityProfile` (keep the two in sync).
// Used by the CPU sun-transmittance march so the ship's ring shadow matches
// the GPU atmosphere shadow (incl. the Cassini gap).
const ringDensityProfileScalar = (u: number): number => {
  const c = 0.3 * smoothstepScalar(0.09, 0.13, u) * (1 - smoothstepScalar(0.33, 0.36, u));
  const b = 0.92 * smoothstepScalar(0.34, 0.38, u) * (1 - smoothstepScalar(0.67, 0.7, u));
  const a = 0.58 * smoothstepScalar(0.75, 0.78, u) * (1 - smoothstepScalar(0.93, 0.96, u));
  return Math.min(1, Math.max(0, Math.max(c, b, a)));
};

// Extinction (km^-1, per-RGB) at planet-centred radius rKm — JS twin of the
// shader's sampleMedium().extinction (Rayleigh scattering + Mie extinction +
// ozone absorption + well-mixed gas absorption on the Rayleigh profile).
// Coefficients in `params` are m^-1 → ×1000.
const sampleExtinctionKm = (
  rKm: number,
  p: AtmosphereParams,
  Rg: number,
  out: THREE.Vector3,
): void => {
  const h = Math.max(0, rKm - Rg);
  const dR = Math.exp(-h / p.rayleighScaleHeightKm);
  const dM = Math.exp(-h / p.mieScaleHeightKm);
  const halfW = p.ozoneWidthKm * 0.5;
  const dO = halfW > 0 ? Math.max(0, 1 - Math.abs(h - p.ozoneCenterKm) / halfW) : 0;
  out.set(
    (p.rayleighScattering[0] * dR +
      (p.mieScattering[0] + p.mieAbsorption[0]) * dM +
      p.ozoneAbsorption[0] * dO +
      p.gasAbsorption[0] * dR) *
      1000,
    (p.rayleighScattering[1] * dR +
      (p.mieScattering[1] + p.mieAbsorption[1]) * dM +
      p.ozoneAbsorption[1] * dO +
      p.gasAbsorption[1] * dR) *
      1000,
    (p.rayleighScattering[2] * dR +
      (p.mieScattering[2] + p.mieAbsorption[2]) * dM +
      p.ozoneAbsorption[2] * dO +
      p.gasAbsorption[2] * dR) *
      1000,
  );
};

const _camPlanetKmL = new THREE.Vector3();
const _Psun = new THREE.Vector3();
const _od = new THREE.Vector3();
const _ext = new THREE.Vector3();

/**
 * Compute + stash this frame's atmosphere lighting from the camera position
 * (planet-centred km), the planet→sun direction (normalised), and the body's
 * params. Read back via getAtmosphereLighting() in SunLight / the sky light.
 */
export function computeAtmosphereLighting(
  camPlanetKm: THREE.Vector3,
  sunDir: THREE.Vector3,
  params: AtmosphereParams,
  rings: AtmosphereRingRecord | null = null,
): void {
  const Rg = params.groundRadiusKm;
  const Rt = params.groundRadiusKm + params.atmosphereHeightKm;
  _camPlanetKmL.copy(camPlanetKm);
  const r = _camPlanetKmL.length();

  // Planet-local up at the camera.
  if (r > 1e-6) _lighting.upDir.copy(_camPlanetKmL).multiplyScalar(1 / r);
  else _lighting.upDir.set(0, 1, 0);

  // Sun elevation vs the altitude-depressed geometric horizon (same gate the
  // shader uses for the multi-scatter night fade): cosHorizon = -√(1-(Rg/r)²).
  const cosSunUp = _lighting.upDir.dot(sunDir);
  const cosHorizon = -Math.sqrt(Math.max(0, 1 - (Rg * Rg) / (r * r)));

  // ── Sun transmittance camera→sun ──
  // The sunlight reaching the camera is exp(-optical depth) along the ray toward
  // the sun — UNLESS that ray hits the planet first, in which case the sun is
  // geometrically occluded and no direct light arrives (hard 0). A soft
  // "emergence" band sitting ENTIRELY above the horizon ramps the sun in over
  // its angular size and meets the occluded side continuously at the horizon.
  // (A ground-CLAMPED march of the partial chord — what we tried first — leaves
  // a non-zero partial-path transmittance just below the horizon → an orange
  // flash on shadow exit. Occlude-to-zero is the correct model for sun visibility.)
  const b = _camPlanetKmL.dot(sunDir);
  const dg = b * b - (r * r - Rg * Rg); // ground (Rg) intersection discriminant
  const tGround = dg >= 0 ? -b - Math.sqrt(dg) : -1; // nearest forward ground hit
  const discRt = b * b - (r * r - Rt * Rt); // atmosphere shell (Rt)
  const tFar = discRt < 0 ? -1 : -b + Math.sqrt(discRt);
  if (tGround > 1e-4) {
    // Ray toward the sun hits the planet → sun below the horizon → no direct light.
    _lighting.sunTransmittance.setRGB(0, 0, 0);
  } else {
    // Emergence ramp: 0 at the geometric horizon, 1 once the disc has cleared.
    const emerge = smoothstepScalar(cosHorizon, cosHorizon + SUN_EMERGE_BAND, cosSunUp);
    if (tFar <= 0) {
      // No shell on the path (camera in space, sun well clear) → unattenuated.
      _lighting.sunTransmittance.setRGB(emerge, emerge, emerge);
    } else {
      // Clear chord through the shell (the ray does not enter the planet here).
      const tStart = Math.max(0, -b - Math.sqrt(discRt));
      const dt = (tFar - tStart) / SUN_T_STEPS;
      _od.set(0, 0, 0);
      for (let i = 0; i < SUN_T_STEPS; i++) {
        const t = tStart + (i + 0.5) * dt;
        _Psun.copy(sunDir).multiplyScalar(t).add(_camPlanetKmL);
        sampleExtinctionKm(_Psun.length(), params, Rg, _ext);
        _od.addScaledVector(_ext, dt);
      }
      _lighting.sunTransmittance.setRGB(
        Math.exp(-_od.x) * emerge,
        Math.exp(-_od.y) * emerge,
        Math.exp(-_od.z) * emerge,
      );
    }
  }

  // ── Ring shadow on the direct sun (ship under/behind the rings) ──
  // Same analytic annulus the GPU march uses (plane through the planet centre,
  // normal in scaled-world axes — directionally identical to this km frame).
  if (rings) {
    const denom = sunDir.dot(rings.normal);
    if (Math.abs(denom) > 1e-6) {
      const t = -camPlanetKm.dot(rings.normal) / denom;
      if (t > 0) {
        _Psun.copy(sunDir).multiplyScalar(t).add(camPlanetKm);
        const rHit = _Psun.length();
        if (rHit >= rings.innerRadiusKm && rHit <= rings.outerRadiusKm) {
          // Per-radius opacity (matches the GPU shadow): gaps let sun through.
          const u =
            (rHit - rings.innerRadiusKm) /
            Math.max(1e-3, rings.outerRadiusKm - rings.innerRadiusKm);
          const occ = rings.opacity * ringDensityProfileScalar(u);
          _lighting.sunTransmittance.multiplyScalar(1 - occ);
        }
      }
    }
  }

  // ── Sky ambient (cheap analytic; LUT irradiance is Phase 4) ──
  // Fades with air density at the camera (≈0 in space) and with sun elevation
  // (a wider twilight band than the sun term, so the fill lingers after sunset).
  const densityAtCam = Math.exp(-Math.max(0, r - Rg) / params.rayleighScaleHeightKm);
  const dayFactor = smoothstepScalar(
    cosHorizon - SKY_DAY_BAND_LO,
    cosHorizon + SKY_DAY_BAND_HI,
    cosSunUp,
  );
  _lighting.skyIntensity = SKY_AMBIENT_MAX_INTENSITY * densityAtCam * dayFactor;

  // Sky tint: Rayleigh-blue, desaturated toward white by SKY_TINT_SATURATION.
  const rs = params.rayleighScattering;
  const maxRs = Math.max(rs[0], rs[1], rs[2], 1e-12);
  _lighting.skyColor.setRGB(
    1 + (rs[0] / maxRs - 1) * SKY_TINT_SATURATION,
    1 + (rs[1] / maxRs - 1) * SKY_TINT_SATURATION,
    1 + (rs[2] / maxRs - 1) * SKY_TINT_SATURATION,
  );
  // Ground-bounce tint (down side of the hemisphere).
  const ga = params.groundAlbedo;
  _lighting.groundColor.setRGB(ga[0], ga[1], ga[2]);

  _lighting.active = true;
}

// =============================================================================
// The pass
// =============================================================================

export type AtmospherePass = {
  // Main on-screen pass (rt → rtB).
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  // Static LUT bakes (rendered once per atmosphere).
  transmittanceBakeScene: THREE.Scene;
  multiScatterBakeScene: THREE.Scene;
  bakeCamera: THREE.OrthographicCamera;
  /** Push the static (per-atmosphere) coefficients; call before baking. */
  setAtmosphere: (params: AtmosphereParams) => void;
  /** Per-frame dynamic uniforms. dominant=null → passthrough (active=0). */
  updateUniforms: (params: {
    scaledCamera: THREE.PerspectiveCamera;
    dominant: AtmosphereBodyRecord | null;
  }) => void;
  /** Render the two static LUTs into their RTs (transmittance first). */
  bakeLUTs: (renderer: WebGPURenderer) => void;
  /** Bake the aerial-perspective froxel for this frame (after updateUniforms). */
  bakeFroxel: (renderer: WebGPURenderer) => void;
  /** Bake the Sky-View LUT for this frame (after updateUniforms + bakeLUTs). */
  bakeSkyView: (renderer: WebGPURenderer) => void;
  dispose: () => void;
};

/**
 * Build the atmosphere pass. `inputTexture` is the scaled-scene colour RT
 * (rt.texture, the background). The two LUT RTs are owned by SpaceRenderer and
 * passed in; this module binds them (read in the MS bake + main pass) and writes
 * them in bakeLUTs. Textures are bound at build time (stable RTs) per the
 * WebGPU bind-group-cache caveat; rebuild on resize (input RT change).
 */
export function setupAtmospherePass(
  inputTexture: THREE.Texture,
  transmittanceLUT: RenderTarget,
  multiScatterLUT: RenderTarget,
): AtmospherePass {
  // ── Uniforms ──────────────────────────────────────────────────────────────
  // Static (per-atmosphere; km / km^-1) — set in setAtmosphere().
  const uBottomRadius = uniform(6371);
  const uTopRadius = uniform(6471);
  const uH = uniform(0); // sqrt(Rtop^2 - Rground^2)
  const uRayleighScattering = uniform(new THREE.Vector3());
  const uRayleighExpScale = uniform(-0.125);
  const uMieScattering = uniform(new THREE.Vector3());
  const uMieExtinction = uniform(new THREE.Vector3());
  const uMieExpScale = uniform(-0.8333);
  // Per-RGB anisotropy (vec3): wavelength-dependent forward peaking — see
  // AtmosphereParams.mieG. hgPhase broadcasts over it, yielding a vec3 phase.
  const uMieG = uniform(new THREE.Vector3(0.8, 0.8, 0.8));
  const uOzoneAbsorption = uniform(new THREE.Vector3());
  const uOzoneCenterKm = uniform(25);
  const uOzoneHalfWidthKm = uniform(15);
  // Well-mixed molecular absorber on the Rayleigh profile (km^-1) — CH4 etc.
  const uGasAbsorption = uniform(new THREE.Vector3());
  // Ring annulus (Phase 5 ring coupling): plane through the planet centre,
  // radii in km. Zeroed (outer = 0, opacity = 0) for ringless bodies, which
  // makes every ring term a no-op. Set per frame from the dominant record.
  const uRingNormal = uniform(new THREE.Vector3(0, 1, 0));
  const uRingInnerKm = uniform(0);
  const uRingOuterKm = uniform(0);
  const uRingOpacity = uniform(0);
  const uGroundAlbedo = uniform(new THREE.Vector3(0.3, 0.3, 0.3));
  const uSunIlluminance = uniform(new THREE.Vector3(1, 1, 1));
  // Dynamic (per-frame).
  const uCameraMatrixWorld = uniform(new THREE.Matrix4());
  const uTanHalfFov = uniform(1);
  const uAspect = uniform(1);
  const uCameraPlanetKm = uniform(new THREE.Vector3()); // camera in planet-centred km
  const uSunDir = uniform(new THREE.Vector3(0, 0, 1)); // normalised, planet frame
  const uActive = uniform(0); // 0 = passthrough, 1 = march
  // AP froxel far plane (km). Static for now; a per-frame uniform so a future
  // altitude-adaptive depth (Phase 4 tuning) needs no graph rebuild.
  const uFroxelMaxDepthKm = uniform(FROXEL_MAX_DEPTH_KM);
  // Sky-View crossfade for sky rays: 0 = pure LUT lookup (low altitude, the
  // march is skipped), 1 = pure per-pixel march (space). Set per frame from
  // altitude in updateUniforms.
  const uSkyViewBlend = uniform(1);
  const froxel = getAtmosphereFroxel();
  const skyViewLUT = getSkyViewLUT();

  // ── Shared TSL helpers (plain functions → inlined into each graph) ──────────

  // Both roots of ray·sphere (planet at origin). rd assumed normalised (a=1).
  // Returns {tNear, tFar}; (-1,-1) on miss.
  const raySphere2 = (ro: Node, rd: Node, R: Node) => {
    const b = dot(ro, rd);
    const c = dot(ro, ro).sub(R.mul(R));
    const disc = b.mul(b).sub(c);
    const miss = disc.lessThan(0);
    const sq = sqrt(disc.max(0));
    const tNear = select(miss, float(-1), b.negate().sub(sq));
    const tFar = select(miss, float(-1), b.negate().add(sq));
    return { tNear, tFar };
  };

  // Nearest non-negative intersection distance, or -1 on miss.
  const raySphereNearest = (ro: Node, rd: Node, R: Node) => {
    const { tNear, tFar } = raySphere2(ro, rd, R);
    return select(
      tNear.greaterThan(0),
      tNear,
      select(tFar.greaterThan(0), tFar, float(-1)),
    );
  };

  // Component-wise exp for a vec3 (three/tsl types the scalar exp() narrowly,
  // so do it per channel — runtime-identical, fully typed).
  const expVec3 = (v: Node): Node => vec3(exp(v.x), exp(v.y), exp(v.z));

  // Ray ∩ ring annulus (planet-centred km; the ring plane passes through the
  // origin). Returns {t, hitF, rHit}: t = distance to the plane along rd, hitF
  // = 1 when the hit is forward and inside [inner, outer], rHit = radius of the
  // hit (feeds the radial density profile). Near-parallel rays: dSafe keeps t
  // finite-but-huge → the radius test rejects, no branch needed.
  const rayRingHit = (ro: Node, rd: Node) => {
    const denom = dot(rd, uRingNormal);
    const dSafe = select(
      denom.greaterThanEqual(0),
      denom.max(1e-6),
      denom.min(-1e-6),
    );
    const t = dot(ro, uRingNormal).negate().div(dSafe);
    const rHit = length(ro.add(rd.mul(t)));
    const hit = t
      .greaterThan(0)
      .and(rHit.greaterThanEqual(uRingInnerKm))
      .and(rHit.lessThanEqual(uRingOuterKm));
    return { t, hitF: select(hit, float(1), float(0)), rHit };
  };

  // Ring OPACITY at a hit radius = uRingOpacity (overall strength) × the radial
  // density profile. Constant opacity produced a spurious bright band on the
  // disc wherever the annulus crossed a view ray — even through the near-empty
  // gaps — because the fog-clamp weight ignored how VISIBLE the ring actually
  // is at that radius. `ringDensityProfile` (shared JS twin
  // `ringDensityProfileScalar` below → identical curve on the CPU shadow path)
  // is ~Saturn's structure over the normalised span [inner,outer]: faint C
  // ring, dense B ring, the Cassini gap, medium A ring, fading at both edges.
  // Three overlapping bands combined by max(); the gap between B and A falls
  // out naturally. This is a plausibility profile, not the artistic ring
  // texture — good enough for a soft shadow + fog clamp, and it means gaps get
  // ~zero weight (the fix).
  const ringDensityProfile = (rHit: Node): Node => {
    const u = clamp(
      rHit.sub(uRingInnerKm).div(uRingOuterKm.sub(uRingInnerKm).max(1e-3)),
      0,
      1,
    );
    const c = float(0.3)
      .mul(smoothstep(0.09, 0.13, u))
      .mul(float(1).sub(smoothstep(0.33, 0.36, u)));
    const b = float(0.92)
      .mul(smoothstep(0.34, 0.38, u))
      .mul(float(1).sub(smoothstep(0.67, 0.7, u)));
    const a = float(0.58)
      .mul(smoothstep(0.75, 0.78, u))
      .mul(float(1).sub(smoothstep(0.93, 0.96, u)));
    return clamp(max(max(c, b), a), 0, 1);
  };
  const ringOpacityAt = (rHit: Node): Node =>
    uRingOpacity.mul(ringDensityProfile(rHit));

  // Direct-sun occlusion at sample P: the planet's hard shadow (nudged off the
  // surface along the local normal to avoid terminator self-intersection) ×
  // the ring shadow (annulus hit toward the sun attenuates by the ring opacity
  // AT the hit radius — so the Cassini gap shows through as a bright line).
  // Shared by the main march, the froxel bake and the sky-view bake — the ring
  // term is what paints the rings' shadow band into the atmosphere. The
  // multi-scatter term stays un-ring-shadowed (it is a soft angular average).
  const directSunOcclusion = (P: Node): Node => {
    const earthShadow = select(
      raySphereNearest(
        P.add(normalize(P).mul(SURFACE_OFFSET_KM)),
        uSunDir,
        uBottomRadius,
      ).greaterThan(0),
      float(0),
      float(1),
    );
    const ring = rayRingHit(P, uSunDir);
    return earthShadow.mul(float(1).sub(ringOpacityAt(ring.rHit).mul(ring.hitF)));
  };

  // Medium scattering/extinction (km^-1) at position P (planet-centred km).
  const sampleMedium = (P: Node) => {
    const h = max(0, length(P).sub(uBottomRadius));
    const dR = exp(uRayleighExpScale.mul(h));
    const dM = exp(uMieExpScale.mul(h));
    const dOraw = float(1).sub(abs(h.sub(uOzoneCenterKm)).div(uOzoneHalfWidthKm.max(1e-6)));
    const dO = select(uOzoneHalfWidthKm.greaterThan(0), max(0, dOraw), float(0));
    const scatteringRay = uRayleighScattering.mul(dR); // Rayleigh: extinction == scattering
    const scatteringMie = uMieScattering.mul(dM);
    const extinctionMie = uMieExtinction.mul(dM);
    const scattering = scatteringRay.add(scatteringMie);
    const extinction = scatteringRay
      .add(extinctionMie)
      .add(uOzoneAbsorption.mul(dO))
      .add(uGasAbsorption.mul(dR)); // well-mixed absorber rides the Rayleigh profile
    return { scatteringRay, scatteringMie, scattering, extinction };
  };

  const rayleighPhase = (cosT: Node) =>
    float(3.0 / (16.0 * PI)).mul(float(1).add(cosT.mul(cosT)));

  // Cornette-Shanks / HG, forward-peaked at cosT=+1 (dot(viewDir, toSun)=1 →
  // halo on the sun). VERIFY halo position on-device; flip the -2g·cosT sign if
  // it lands on the anti-sun side (convention ambiguity flagged in the spec).
  const hgPhase = (g: Node, cosT: Node) => {
    const g2 = g.mul(g);
    const k = float(3.0 / (8.0 * PI)).mul(float(1).sub(g2)).div(float(2).add(g2));
    const denom = pow(float(1).add(g2).sub(g.mul(2).mul(cosT)).max(1e-4), 1.5);
    return k.mul(float(1).add(cosT.mul(cosT))).div(denom);
  };

  // Transmittance LUT: params → uv (Bruneton). Delegates to the exported
  // transmittanceLutUv (in km here) so the cloud marcher maps identically.
  const transmittanceParamsToUv = (r: Node, mu: Node) =>
    transmittanceLutUv(r, mu, uBottomRadius, uTopRadius, uH);

  // Transmittance from P toward the sun (samples the transmittance LUT).
  const getSunTransmittance = (P: Node, sunDir: Node) => {
    const rTrue = length(P);
    const r = clamp(rTrue, uBottomRadius.add(0.001), uTopRadius);
    const up = P.div(rTrue.max(1e-6));
    const mu = dot(up, sunDir);
    return (
      texture(transmittanceLUT.texture, transmittanceParamsToUv(r, mu)).level(
        int(0),
      ) as Node
    ).rgb;
  };

  // Multiple-scattering LUT sampler (Ψms).
  const getMultipleScattering = (P: Node, sunDir: Node) => {
    const r = length(P);
    const cosSun = dot(sunDir, P).div(r.max(1e-6));
    const u = cosSun.mul(0.5).add(0.5);
    const v = clamp(r.sub(uBottomRadius).div(uTopRadius.sub(uBottomRadius)), 0, 1);
    return (
      texture(multiScatterLUT.texture, clamp(vec2(u, v), 0, 1)).level(
        int(0),
      ) as Node
    ).rgb;
  };

  // Sky-View LUT azimuth basis at camera position `ro` (planet-centred km):
  // local up + an orthonormal (sunForward, right) tangent frame with sunForward =
  // the sun projected onto the horizon plane (u=0.5 → toward the sun). Falls back
  // to a stable tangent when the sun is near-vertical (sky is azimuthally
  // symmetric there anyway). SHARED by the bake (uv→dir) and the sampler
  // (dir→uv) so the two mappings are guaranteed consistent.
  const skyViewBasis = (ro: Node) => {
    const rC = length(ro);
    const up = ro.div(rC.max(1e-6));
    const sunOnUp = dot(uSunDir, up);
    const sunHoriz = uSunDir.sub(up.mul(sunOnUp));
    const sunLen = length(sunHoriz);
    const refAxis = select(abs(up.z).greaterThan(0.99), vec3(1, 0, 0), vec3(0, 0, 1));
    const fallbackFwd = normalize(cross(up, refAxis));
    const sunForward = select(
      sunLen.greaterThan(1e-4),
      sunHoriz.div(sunLen.max(1e-6)),
      fallbackFwd,
    );
    const right = cross(up, sunForward);
    return { up, sunForward, right };
  };

  // Sky-View horizon geometry at camera position `ro`: the view-zenith angle at
  // which a ray grazes the (altitude-DEPRESSED) horizon (zenithHorizonAngle =
  // π − β, which grows past π/2 as altitude lifts the horizon), plus the
  // below-horizon span β. The LUT's elevation axis is split AT this real horizon
  // (Hillaire's production mapping) so texels concentrate on the bright horizon
  // band at EVERY altitude — the simple geometric-horizon quadratic under-
  // resolved it at altitude and banded.
  const skyViewHorizonGeom = (ro: Node) => {
    const r = length(ro);
    const vHorizon = sqrt(max(r.mul(r).sub(uBottomRadius.mul(uBottomRadius)), 0));
    const cosBeta = vHorizon.div(r.max(1e-6));
    const beta = acos(clamp(cosBeta, -1, 1));
    const zenithHorizonAngle = float(PI).sub(beta);
    return { beta, zenithHorizonAngle };
  };

  type SkyGeom = { beta: Node; zenithHorizonAngle: Node };
  // View-zenith angle θ (from local up) → LUT v: split at the horizon with a sqrt
  // curve concentrating texels there. v∈[0,0.5) = above horizon (sky), [0.5,1] =
  // below (ground). Inverse of skyViewVToTheta. `.max(0)` guards the unselected
  // branch's sqrt from NaN.
  const skyViewThetaToV = (theta: Node, g: SkyGeom): Node => {
    const sky = float(1)
      .sub(sqrt(max(float(1).sub(theta.div(g.zenithHorizonAngle.max(1e-6))), 0)))
      .mul(0.5);
    const ground = sqrt(max(theta.sub(g.zenithHorizonAngle).div(g.beta.max(1e-6)), 0))
      .mul(0.5)
      .add(0.5);
    return select(theta.lessThan(g.zenithHorizonAngle), sky, ground);
  };
  // LUT v → view-zenith angle θ (the bake's forward direction). Exact inverse.
  const skyViewVToTheta = (v: Node, g: SkyGeom): Node => {
    const cSky = float(1).sub(float(2).mul(v)); // 1−2v
    const thetaSky = float(1).sub(cSky.mul(cSky)).mul(g.zenithHorizonAngle);
    const cGnd = float(2).mul(v).sub(1); // 2v−1
    const thetaGnd = g.zenithHorizonAngle.add(cGnd.mul(cGnd).mul(g.beta));
    return select(v.lessThan(0.5), thetaSky, thetaGnd);
  };

  // Sample the Sky-View LUT for a sky ray `rd` from camera `ro`. Inverse of the
  // bake's (u,v)→dir mapping: view-zenith θ=acos(rd·up) → v (horizon-aware),
  // azimuth φ=atan2(rd·right, rd·sunForward) → u. Returns {L, Tmean}.
  const sampleSkyView = (rd: Node, ro: Node) => {
    const { up, sunForward, right } = skyViewBasis(ro);
    const theta = acos(clamp(dot(rd, up), -1, 1));
    const v = skyViewThetaToV(theta, skyViewHorizonGeom(ro));
    const rdHoriz = rd.sub(up.mul(dot(rd, up)));
    const phi = atan(dot(rdHoriz, right), dot(rdHoriz, sunForward)); // atan2
    const u = phi.div(2 * PI).add(0.5);
    const s = texture(skyViewLUT.texture, vec2(u, v)).level(int(0)) as Node;
    return { L: s.rgb, Tmean: s.a };
  };

  // ── Bake fragment: TRANSMITTANCE LUT (256×64) ──────────────────────────────
  const transmittanceBakeFragment = Fn(() => {
    const xMu = screenUV.x;
    const xR = screenUV.y;
    const rho = uH.mul(xR);
    const r = sqrt(rho.mul(rho).add(uBottomRadius.mul(uBottomRadius)));
    const dMin = uTopRadius.sub(r);
    const dMax = rho.add(uH);
    const d = dMin.add(xMu.mul(dMax.sub(dMin)));
    const mu = clamp(
      select(
        d.lessThanEqual(0),
        float(1),
        uH.mul(uH).sub(rho.mul(rho)).sub(d.mul(d)).div(r.mul(d).mul(2).max(1e-6)),
      ),
      -1,
      1,
    );
    const ro = vec3(0, 0, r);
    const rd = vec3(sqrt(max(0, float(1).sub(mu.mul(mu)))), 0, mu);
    const tMax = raySphereNearest(ro, rd, uTopRadius).max(0).toVar();
    const dt = tMax.div(TRANSMITTANCE_STEPS);
    const od = vec3(0).toVar();
    Loop(TRANSMITTANCE_STEPS, ({ i }: { i: Node }) => {
      const t = tMax.mul(float(i).add(0.5).div(TRANSMITTANCE_STEPS));
      const m = sampleMedium(ro.add(rd.mul(t)));
      od.addAssign(m.extinction.mul(dt));
    });
    return vec4(expVec3(od.negate()), 1);
  });

  // ── Bake fragment: MULTIPLE-SCATTERING LUT (32×32) ─────────────────────────
  const multiScatterBakeFragment = Fn(() => {
    const cosSunZenith = screenUV.x.mul(2).sub(1);
    const r = uBottomRadius.add(
      clamp(screenUV.y, 0, 1).mul(uTopRadius.sub(uBottomRadius)),
    );
    const ro = vec3(0, 0, r);
    const sunDir = vec3(sqrt(max(0, float(1).sub(cosSunZenith.mul(cosSunZenith)))), 0, cosSunZenith);

    const Lsum = vec3(0).toVar();
    const fmsSum = vec3(0).toVar();

    Loop(MS_SQRT_SAMPLES, ({ i }: { i: Node }) => {
      Loop(MS_SQRT_SAMPLES, ({ i: j }: { i: Node }) => {
        const randA = float(i).add(0.5).div(MS_SQRT_SAMPLES);
        const randB = float(j).add(0.5).div(MS_SQRT_SAMPLES);
        const theta = randA.mul(2 * PI);
        const phi = acos(float(1).sub(randB.mul(2)));
        const sinPhi = sin(phi);
        const dir = vec3(cos(theta).mul(sinPhi), sin(theta).mul(sinPhi), cos(phi));

        const tBottom = raySphereNearest(ro, dir, uBottomRadius);
        const tTop = raySphereNearest(ro, dir, uTopRadius);
        const tMax = select(tBottom.greaterThan(0), tBottom, tTop.max(0));
        const dt = tMax.div(MS_STEPS);

        const throughput = vec3(1).toVar();
        const L = vec3(0).toVar();
        const fms = vec3(0).toVar();
        Loop(MS_STEPS, ({ i: s }: { i: Node }) => {
          const t = float(s).add(0.5).mul(dt);
          const P = ro.add(dir.mul(t));
          const m = sampleMedium(P);
          const sampleT = expVec3(m.extinction.mul(dt).negate());
          const Tsun = getSunTransmittance(P, sunDir);
          // Nudge the shadow-ray origin off the surface along the local normal
          // to avoid self-intersection false-shadowing near the terminator.
          const earthShadow = select(
            raySphereNearest(
              P.add(normalize(P).mul(SURFACE_OFFSET_KM)),
              sunDir,
              uBottomRadius,
            ).greaterThan(0),
            float(0),
            float(1),
          );
          // 2nd-order in-scatter source (isotropic phase, EI=1):
          const S = m.scattering.mul(earthShadow).mul(Tsun).mul(ISOTROPIC_PHASE);
          const Sint = S.sub(S.mul(sampleT)).div(m.extinction.max(1e-6));
          L.addAssign(throughput.mul(Sint));
          // multi-scatter transfer factor (no phase):
          const MSint = m.scattering
            .sub(m.scattering.mul(sampleT))
            .div(m.extinction.max(1e-6));
          fms.addAssign(throughput.mul(MSint));
          throughput.mulAssign(sampleT);
        });

        // Lambertian ground bounce (only if this direction hit the planet).
        If(tBottom.greaterThan(0), () => {
          const Pg = ro.add(dir.mul(tBottom));
          const N = normalize(Pg);
          const NdotL = max(dot(N, sunDir), 0);
          const Tg = getSunTransmittance(Pg, sunDir);
          L.addAssign(
            throughput.mul(uGroundAlbedo).mul(float(1 / PI)).mul(NdotL).mul(Tg),
          );
        });

        Lsum.addAssign(L);
        fmsSum.addAssign(fms);
      });
    });

    // Σ·(4π/N)·(1/4π) = Σ/N (the two 4π factors cancel — see reference).
    const inScattered = Lsum.div(MS_SAMPLE_COUNT);
    const Fms = fmsSum.div(MS_SAMPLE_COUNT);
    const psi = inScattered.div(vec3(1).sub(Fms).max(1e-4));
    return vec4(psi, 1);
  });

  // ── Main on-screen fragment ────────────────────────────────────────────────
  const mainFragment = Fn(() => {
    const sceneColor = texture(inputTexture, screenUV).rgb;
    const out = vec4(sceneColor, 1).toVar();

    // Geometry-free debug (compile-time):
    if (DEBUG_ATMOSPHERE === "lutT")
      return vec4(texture(transmittanceLUT.texture, screenUV).rgb, 1);
    if (DEBUG_ATMOSPHERE === "lutMS")
      return vec4(texture(multiScatterLUT.texture, screenUV).rgb, 1);
    if (DEBUG_ATMOSPHERE === "froxel") {
      // Sample the froxel's far-ish slice (w≈0.97 → depth ≈ 0.94·max) and blit
      // its in-scatter. Should read like the foreground atmospheric haze —
      // compare against 'inscatter' (the main march's L) for in-atmosphere views.
      return vec4(
        (
          texture3D(froxel, vec3(screenUV.x, screenUV.y, float(0.97))).level(
            int(0),
          ) as Node
        ).rgb,
        1,
      );
    }
    if (DEBUG_ATMOSPHERE === "skyView") {
      // Blit the Sky-View LUT directly (screenUV → LUT uv): the upper half is the
      // sky (blue → reddened toward the horizon at v=0.5), the sun glow sits at
      // u=0.5, the lower half is the toward-ground march. Validates the BAKE
      // (forward mapping); the sampler's inverse mapping is exercised in step 2.
      return vec4(texture(skyViewLUT.texture, screenUV).rgb, 1);
    }

    If(uActive.greaterThan(0.5), () => {
      // View ray (scaled-world axes == planet-centred-km axes for a direction).
      const ndcX = screenUV.x.mul(2).sub(1);
      const ndcY = float(1).sub(screenUV.y.mul(2));
      const rdView = vec3(ndcX.mul(uAspect).mul(uTanHalfFov), ndcY.mul(uTanHalfFov), float(-1));
      const rd = normalize(uCameraMatrixWorld.mul(vec4(rdView, 0)).xyz);
      const ro = uCameraPlanetKm;

      const atmo = raySphere2(ro, rd, uTopRadius);
      const tGround = raySphereNearest(ro, rd, uBottomRadius);
      const groundHit = tGround.greaterThan(0);

      // Geometry-dependent debug (compile-time; skips the normal march):
      if (DEBUG_ATMOSPHERE === "slabHit") {
        out.assign(
          select(atmo.tFar.greaterThan(0), vec4(0, 0, 1, 1), vec4(0.3, 0, 0, 1)),
        );
        return;
      }
      if (DEBUG_ATMOSPHERE === "extinction") {
        const Ptest = select(
          groundHit,
          ro.add(rd.mul(tGround)),
          ro.add(rd.mul(atmo.tNear.max(0))),
        );
        out.assign(vec4(sampleMedium(Ptest).extinction.mul(30), 1));
        return;
      }
      if (DEBUG_ATMOSPHERE === "sunT") {
        const Ptest = select(
          groundHit,
          ro.add(rd.mul(tGround)),
          ro.add(rd.mul(atmo.tNear.max(0))),
        );
        out.assign(vec4(getSunTransmittance(Ptest, uSunDir), 1));
        return;
      }

      If(atmo.tFar.greaterThan(0), () => {
        // tStart = atmosphere entry (0 if camera already inside); push off the
        // shell when entering from outside.
        const tStart = atmo.tNear
          .max(0)
          .add(select(atmo.tNear.greaterThan(0), float(SURFACE_OFFSET_KM), float(0)))
          .toVar();
        const tEnd = select(groundHit, tGround, atmo.tFar);
        const tMax = tEnd.sub(tStart);
        // ── Ring occlusion of the atmosphere in-scatter (Phase 5) ──
        // Rings render into the scaled scene transparent + depthWrite:false, so
        // the pass can't depth-test them and would paint the atmosphere GLOW
        // "in front of" a near-side ring. The rings sit OUTSIDE the (thin)
        // atmosphere shell, so along any view ray there is no in-scatter between
        // the camera and the ring — the ENTIRE glow L is behind the ring. So we
        // attenuate L by the ring's coverage at the crossing, weighted by the
        // radial density (transparent gaps → ~0 → glow shows through). We do NOT
        // shorten the march: the earlier length-clamp collapsed tMax→0 for body
        // rays (the ring is crossed before the atmosphere entry, so the clamp
        // target went negative), erasing the body's extinction-darkening on the
        // ring-plane side and flipping when the camera crossed the plane. Keeping
        // the full march preserves that darkening; only the ADDED glow is
        // occluded. Ringless bodies: hitF/opacity 0 → cover 0 → L unchanged.
        const ringView = rayRingHit(ro, rd);
        const ringInFrontCover: Node = ringView.hitF
          .mul(ringOpacityAt(ringView.rHit))
          .mul(select(ringView.t.lessThan(tEnd), float(1), float(0)));
        const ringGlowKeep = float(1).sub(clamp(ringInFrontCover, 0, 1));

        // Per-pixel raymarch (default = unfogged scene when skipped or tMax≤0).
        // GROUND rays always march (fine-grained surface aerial perspective); SKY
        // rays march only when the crossfade needs it (uSkyViewBlend > 0, i.e.
        // near/above the atmosphere top) — below that the Sky-View LUT replaces
        // the march and it is SKIPPED (the perf win).
        const marched = vec4(sceneColor, 1).toVar();
        const runMarch = () => {
          const cosTheta = dot(rd, uSunDir);
          const phaseR = rayleighPhase(cosTheta);
          const phaseM = hgPhase(uMieG, cosTheta);

          const L = vec3(0).toVar();
          const throughput = vec3(1).toVar();
          const t = float(0).toVar();

          Loop(MAIN_STEPS, ({ i: s }: { i: Node }) => {
            const tNew = tMax.mul(float(s).add(SAMPLE_SEGMENT_T).div(MAIN_STEPS));
            // .toVar() MATERIALISES dt = tNew - t_old HERE, before t is
            // reassigned below. Without it, `dt` is a live node referencing the
            // variable `t`; since `t.assign(tNew)` runs before dt is consumed,
            // dt would evaluate to tNew - tNew = 0 → sampleT=1 → Sint=0 → the
            // entire in-scatter integral collapses to zero (the invisible-
            // atmosphere bug).
            const dt = tNew.sub(t).toVar();
            t.assign(tNew);
            const P = ro.add(rd.mul(tStart.add(t)));
            const m = sampleMedium(P);
            const sampleT = expVec3(m.extinction.mul(dt).negate());

            const Tsun = getSunTransmittance(P, uSunDir);
            const earthShadow = directSunOcclusion(P);
            const phaseScat = m.scatteringMie.mul(phaseM).add(m.scatteringRay.mul(phaseR));
            // Multi-scatter sun-visibility gate. The isotropic multi-scatter LUT
            // is broadly uniform and (unlike single scattering) is not shadowed,
            // so without this it glows blue across the planet's night side. The
            // night atmosphere sits in the planet's shadow — no direct sun to
            // multi-scatter — so fade it out as the sun drops below the local
            // (altitude-depressed) horizon: cosHorizon = -sqrt(1 - (Rg/r)^2).
            // The ±0.05 band is the terminator softness (tune to taste).
            const rP = length(P);
            const cosSunZenP = dot(P, uSunDir).div(rP.max(1e-6));
            const cosHorizonP = sqrt(
              max(0, float(1).sub(uBottomRadius.mul(uBottomRadius).div(rP.mul(rP)))),
            ).negate();
            const sunVis = smoothstep(
              cosHorizonP.sub(0.05),
              cosHorizonP.add(0.05),
              cosSunZenP,
            );
            const msContrib = getMultipleScattering(P, uSunDir)
              .mul(m.scattering)
              .mul(sunVis);
            const S = uSunIlluminance.mul(
              earthShadow.mul(Tsun).mul(phaseScat).add(msContrib),
            );
            const Sint = S.sub(S.mul(sampleT)).div(m.extinction.max(1e-6));
            L.addAssign(throughput.mul(Sint));
            throughput.mulAssign(sampleT);
          });

          // Occlude the glow behind a near-side ring (ringGlowKeep=1 when none).
          // Background (sceneColor) already has the ring composited in Pass 1
          // and stays attenuated by the full-path throughput — only the ADDED
          // in-scatter is ring-occluded.
          const Lvis = L.mul(ringGlowKeep);
          if ((DEBUG_ATMOSPHERE as string) === "inscatter")
            marched.assign(vec4(Lvis, 1));
          else marched.assign(vec4(sceneColor.mul(throughput).add(Lvis), 1));
        };

        if ((DEBUG_ATMOSPHERE as string) === "off") {
          // Sky-View LUT for sky rays + altitude crossfade to the march. Ground
          // rays and the crossfade band march; low-altitude sky skips the march.
          If(
            groundHit.or(uSkyViewBlend.greaterThan(0.001)).and(tMax.greaterThan(0)),
            runMarch,
          );
          // Sky-View LUT lookup for sky rays (skipped once fully in march mode).
          const lutOut = vec4(sceneColor, 1).toVar();
          If(tGround.lessThanEqual(0).and(uSkyViewBlend.lessThan(0.999)), () => {
            const sky = sampleSkyView(rd, ro);
            lutOut.assign(vec4(sceneColor.mul(sky.Tmean).add(sky.L), 1));
          });
          out.assign(
            select(groundHit, marched, mix(lutOut, marched, uSkyViewBlend)),
          );
        } else {
          // Debug builds always march (keeps 'inscatter' meaningful).
          If(tMax.greaterThan(0), runMarch);
          out.assign(marched);
        }
      });
    });

    return out;
  });

  // ── Aerial-perspective froxel bake (compute) ───────────────────────────────
  // One invocation per voxel. Each (x,y) is a screen tile (its view ray is the
  // mainFragment recipe); each z is a depth slice. The voxel marches the SAME
  // single+multi-scatter integral as the main pass from the camera to its slice
  // depth (QUADRATIC: w²·max → dense near the camera), then stores RGB = in-
  // scattered light, A = mean transmittance. Re-marches [0,d] per voxel with a
  // fixed step count (cheap at 32³ ≈ 0.8M step-evals, ~100× under the full-screen
  // march) and writes once — the proven textureStore-once compute pattern. dt is
  // constant within a voxel (no dt-aliasing). Compute can't do implicit-LOD, so
  // the LUT samplers' .level(int(0)) (already explicit) is required here.
  const froxelBake = (() => {
    const populate = Fn(() => {
      const i = instanceIndex;
      const x = i.mod(uint(FROXEL_DIM));
      const y = i.div(uint(FROXEL_DIM)).mod(uint(FROXEL_DIM));
      const z = i.div(uint(FROXEL_DIM * FROXEL_DIM));

      // View ray for this screen tile (== mainFragment's reconstruction).
      const su = float(x).add(0.5).div(FROXEL_DIM);
      const sv = float(y).add(0.5).div(FROXEL_DIM);
      const ndcX = su.mul(2).sub(1);
      const ndcY = float(1).sub(sv.mul(2));
      const rdView = vec3(ndcX.mul(uAspect).mul(uTanHalfFov), ndcY.mul(uTanHalfFov), float(-1));
      const rd = normalize(uCameraMatrixWorld.mul(vec4(rdView, 0)).xyz);
      const ro = uCameraPlanetKm;

      // Quadratic depth to this voxel's slice centre, marched in fixed steps.
      const w = float(z).add(0.5).div(FROXEL_DIM);
      const dFar = uFroxelMaxDepthKm.mul(w).mul(w);
      // Clamp the march to the nearest forward GROUND hit so ground-occluded
      // tiles don't integrate through solid rock — sampleMedium clamps h≥0, so a
      // sub-surface march would accumulate full sea-level density and saturate
      // the deep slices to bogus dark/red. Slices past the ground all collapse to
      // the ground-depth integral, which is the correct AP for anything at/behind
      // the silhouette. Mirrors the main pass's tEnd = select(groundHit, …).
      const tGroundF = raySphereNearest(ro, rd, uBottomRadius);
      const dEnd = select(tGroundF.greaterThan(0), dFar.min(tGroundF), dFar);
      const dt = dEnd.div(FROXEL_MARCH_STEPS);

      const cosTheta = dot(rd, uSunDir);
      const phaseR = rayleighPhase(cosTheta);
      const phaseM = hgPhase(uMieG, cosTheta);

      const L = vec3(0).toVar();
      const throughput = vec3(1).toVar();
      Loop(FROXEL_MARCH_STEPS, ({ i: s }: { i: Node }) => {
        const t = dt.mul(float(s).add(0.5));
        const P = ro.add(rd.mul(t));
        const m = sampleMedium(P);
        const sampleT = expVec3(m.extinction.mul(dt).negate());
        const Tsun = getSunTransmittance(P, uSunDir);
        const earthShadow = directSunOcclusion(P);
        const phaseScat = m.scatteringMie.mul(phaseM).add(m.scatteringRay.mul(phaseR));
        const rP = length(P);
        const cosSunZenP = dot(P, uSunDir).div(rP.max(1e-6));
        const cosHorizonP = sqrt(
          max(0, float(1).sub(uBottomRadius.mul(uBottomRadius).div(rP.mul(rP)))),
        ).negate();
        const sunVis = smoothstep(cosHorizonP.sub(0.05), cosHorizonP.add(0.05), cosSunZenP);
        const msContrib = getMultipleScattering(P, uSunDir).mul(m.scattering).mul(sunVis);
        const S = uSunIlluminance.mul(
          earthShadow.mul(Tsun).mul(phaseScat).add(msContrib),
        );
        const Sint = S.sub(S.mul(sampleT)).div(m.extinction.max(1e-6));
        L.addAssign(throughput.mul(Sint));
        throughput.mulAssign(sampleT);
      });

      const Tmean = throughput.x.add(throughput.y).add(throughput.z).div(3);
      // uvec3's TS typing only declares the 1-arg conversion; the 3-component
      // form is valid TSL at runtime (cf. cloudLightVolume) — cast past it.
      const coord = (uvec3 as unknown as (x: Node, y: Node, z: Node) => Node)(
        x,
        y,
        z,
      );
      textureStore(froxel, coord, vec4(L, Tmean)).toWriteOnly();
    });
    return populate().compute(FROXEL_VOXELS);
  })();

  // ── Sky-View LUT bake fragment (200×100) ───────────────────────────────────
  // Per LUT texel: map (u,v) → a view direction in the camera's local frame
  // (u = azimuth around up from the sun; v = elevation, Hillaire's quadratic
  // horizon map), then march the SAME single+multi-scatter integral as the main
  // sky path from the camera through the atmosphere. Stores RGB = in-scatter, A =
  // mean transmittance (background attenuation). Duplicates the main march by
  // design — like froxelBake, the integral is the contract, parametrised by
  // direction instead of screen pixel.
  const skyViewBakeFragment = Fn(() => {
    const ro = uCameraPlanetKm;
    // Azimuth basis (u=0.5 → toward the sun), shared with the sampler so the
    // bake's uv→dir and the main pass's dir→uv are exact inverses.
    const { up, sunForward, right } = skyViewBasis(ro);

    // (u,v) → (azimuth φ, view-zenith θ). Exact inverse of the sampler's mapping:
    //   u = φ/(2π) + 0.5  → φ = (u − 0.5)·2π   (u=0.5 ⇒ toward sun)
    //   v (horizon-aware) → θ via skyViewVToTheta; rd = up·cosθ + horiz·sinθ
    //   (θ=0 ⇒ zenith, θ=π ⇒ nadir; v=0.5 ⇒ the depressed horizon).
    const phi = screenUV.x.sub(0.5).mul(2 * PI);
    const theta = skyViewVToTheta(screenUV.y, skyViewHorizonGeom(ro));
    const cosTh = cos(theta);
    const sinTh = sin(theta);
    const horiz = sunForward.mul(cos(phi)).add(right.mul(sin(phi)));
    const rd = normalize(up.mul(cosTh).add(horiz.mul(sinTh)));

    const atmo = raySphere2(ro, rd, uTopRadius);
    const tGround = raySphereNearest(ro, rd, uBottomRadius);
    const groundHit = tGround.greaterThan(0);

    const L = vec3(0).toVar();
    const throughput = vec3(1).toVar();

    If(atmo.tFar.greaterThan(0), () => {
      const tStart = atmo.tNear
        .max(0)
        .add(select(atmo.tNear.greaterThan(0), float(SURFACE_OFFSET_KM), float(0)))
        .toVar();
      const tEnd = select(groundHit, tGround, atmo.tFar);
      const tMax = tEnd.sub(tStart);

      If(tMax.greaterThan(0), () => {
        const cosTheta = dot(rd, uSunDir);
        const phaseR = rayleighPhase(cosTheta);
        const phaseM = hgPhase(uMieG, cosTheta);
        const t = float(0).toVar();

        Loop(SKYVIEW_STEPS, ({ i: s }: { i: Node }) => {
          const tNew = tMax.mul(float(s).add(SAMPLE_SEGMENT_T).div(SKYVIEW_STEPS));
          const dt = tNew.sub(t).toVar(); // materialise before t is reassigned
          t.assign(tNew);
          const P = ro.add(rd.mul(tStart.add(t)));
          const m = sampleMedium(P);
          const sampleT = expVec3(m.extinction.mul(dt).negate());
          const Tsun = getSunTransmittance(P, uSunDir);
          const earthShadow = directSunOcclusion(P);
          const phaseScat = m.scatteringMie.mul(phaseM).add(m.scatteringRay.mul(phaseR));
          const rP = length(P);
          const cosSunZenP = dot(P, uSunDir).div(rP.max(1e-6));
          const cosHorizonP = sqrt(
            max(0, float(1).sub(uBottomRadius.mul(uBottomRadius).div(rP.mul(rP)))),
          ).negate();
          const sunVis = smoothstep(cosHorizonP.sub(0.05), cosHorizonP.add(0.05), cosSunZenP);
          const msContrib = getMultipleScattering(P, uSunDir).mul(m.scattering).mul(sunVis);
          const S = uSunIlluminance.mul(
            earthShadow.mul(Tsun).mul(phaseScat).add(msContrib),
          );
          const Sint = S.sub(S.mul(sampleT)).div(m.extinction.max(1e-6));
          L.addAssign(throughput.mul(Sint));
          throughput.mulAssign(sampleT);
        });
      });
    });

    const Tmean = throughput.x.add(throughput.y).add(throughput.z).div(3);
    return vec4(L, Tmean);
  });

  // ── Materials / scenes ──────────────────────────────────────────────────
  const quad = new THREE.PlaneGeometry(2, 2);
  const bakeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const makeScene = (fragment: Node) => {
    const mat = new NodeMaterial();
    mat.transparent = false;
    mat.depthTest = false;
    mat.depthWrite = false;
    mat.blending = THREE.NoBlending;
    mat.fragmentNode = fragment();
    const mesh = new THREE.Mesh(quad, mat);
    mesh.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(mesh);
    return { scene, mat };
  };

  const transmittanceBake = makeScene(transmittanceBakeFragment);
  const multiScatterBake = makeScene(multiScatterBakeFragment);
  const skyViewBake = makeScene(skyViewBakeFragment);
  const main = makeScene(mainFragment);

  // ── API ──────────────────────────────────────────────────────────────────
  const setAtmosphere = (p: AtmosphereParams) => {
    const Rg = p.groundRadiusKm;
    const Rt = p.groundRadiusKm + p.atmosphereHeightKm;
    uBottomRadius.value = Rg;
    uTopRadius.value = Rt;
    uH.value = Math.sqrt(Math.max(0, Rt * Rt - Rg * Rg));
    // m^-1 → km^-1 (×1000), once.
    uRayleighScattering.value.set(
      p.rayleighScattering[0] * 1000,
      p.rayleighScattering[1] * 1000,
      p.rayleighScattering[2] * 1000,
    );
    uRayleighExpScale.value = -1 / p.rayleighScaleHeightKm;
    uMieScattering.value.set(
      p.mieScattering[0] * 1000,
      p.mieScattering[1] * 1000,
      p.mieScattering[2] * 1000,
    );
    uMieExtinction.value.set(
      (p.mieScattering[0] + p.mieAbsorption[0]) * 1000,
      (p.mieScattering[1] + p.mieAbsorption[1]) * 1000,
      (p.mieScattering[2] + p.mieAbsorption[2]) * 1000,
    );
    uMieExpScale.value = -1 / p.mieScaleHeightKm;
    uMieG.value.set(p.mieG[0], p.mieG[1], p.mieG[2]);
    uOzoneAbsorption.value.set(
      p.ozoneAbsorption[0] * 1000,
      p.ozoneAbsorption[1] * 1000,
      p.ozoneAbsorption[2] * 1000,
    );
    uOzoneCenterKm.value = p.ozoneCenterKm;
    uOzoneHalfWidthKm.value = p.ozoneWidthKm * 0.5;
    uGasAbsorption.value.set(
      p.gasAbsorption[0] * 1000,
      p.gasAbsorption[1] * 1000,
      p.gasAbsorption[2] * 1000,
    );
    uGroundAlbedo.value.set(p.groundAlbedo[0], p.groundAlbedo[1], p.groundAlbedo[2]);
    uSunIlluminance.value.set(p.sunIlluminance[0], p.sunIlluminance[1], p.sunIlluminance[2]);
  };

  const _camToPlanet = new THREE.Vector3();
  const updateUniforms = ({
    scaledCamera,
    dominant,
  }: {
    scaledCamera: THREE.PerspectiveCamera;
    dominant: AtmosphereBodyRecord | null;
  }) => {
    if (!dominant) {
      uActive.value = 0;
      return;
    }
    uActive.value = 1;
    uCameraMatrixWorld.value.copy(scaledCamera.matrixWorld);
    uTanHalfFov.value = Math.tan((scaledCamera.fov * Math.PI) / 180 / 2);
    uAspect.value = scaledCamera.aspect;
    // Camera relative to planet centre, scaled→km (÷ SCALED_UNITS_PER_KM).
    _camToPlanet
      .copy(scaledCamera.position)
      .sub(dominant.centerScaled)
      .multiplyScalar(1 / SCALED_UNITS_PER_KM);
    uCameraPlanetKm.value.copy(_camToPlanet);
    uSunDir.value.copy(dominant.sunDir);

    // Sky-View crossfade (sky rays): pure LUT at/below FULL_ALT (march skipped),
    // pure per-pixel march at/above MARCH_ALT (the LUT degenerates from space).
    // MUST match the bake gate: when SKYVIEW_ENABLED is false the LUT is never
    // baked, so force blend=1 (march everywhere) — else sky rays would sample a
    // stale/never-baked LUT. This makes USE_SKYVIEW=false a clean full-march
    // fallback (the LUT sample is a never-taken uniform branch → ~zero cost).
    const altKm = _camToPlanet.length() - dominant.params.groundRadiusKm;
    uSkyViewBlend.value = SKYVIEW_ENABLED
      ? smoothstepScalar(SKYVIEW_FULL_ALT_KM, SKYVIEW_MARCH_ALT_KM, altKm)
      : 1;

    // Ring annulus (fog clamp + shadow). Zeroed when the body has none —
    // outer = 0 makes every ring term a no-op.
    if (dominant.rings) {
      uRingNormal.value.copy(dominant.rings.normal);
      uRingInnerKm.value = dominant.rings.innerRadiusKm;
      uRingOuterKm.value = dominant.rings.outerRadiusKm;
      uRingOpacity.value = dominant.rings.opacity;
    } else {
      uRingOuterKm.value = 0;
      uRingOpacity.value = 0;
    }
  };

  const bakeLUTs = (renderer: WebGPURenderer) => {
    renderer.setRenderTarget(transmittanceLUT);
    renderer.render(transmittanceBake.scene, bakeCamera);
    renderer.setRenderTarget(multiScatterLUT); // reads the transmittance LUT just written
    renderer.render(multiScatterBake.scene, bakeCamera);
    renderer.setRenderTarget(null);
  };

  // Dispatch the AP froxel bake. Call AFTER updateUniforms (needs the camera/sun
  // uniforms) and after bakeLUTs (the compute samples the transmittance + MS
  // LUTs). Synchronous, like the cloud light-volume compute. Guards the first
  // frames before the WebGPU device is initialized.
  const bakeFroxel = (renderer: WebGPURenderer) => {
    if (!(renderer as unknown as { backend?: { device?: unknown } }).backend?.device) return;
    (renderer as unknown as { compute: (n: unknown) => void }).compute(froxelBake);
  };

  // Bake the Sky-View LUT for this frame. Call AFTER updateUniforms (camera/sun)
  // and after bakeLUTs (the march samples the transmittance + MS LUTs). A cheap
  // 200×100 fullscreen pass, like the static LUT bakes.
  const bakeSkyView = (renderer: WebGPURenderer) => {
    renderer.setRenderTarget(skyViewLUT);
    renderer.render(skyViewBake.scene, bakeCamera);
    renderer.setRenderTarget(null);
  };

  const dispose = () => {
    quad.dispose();
    transmittanceBake.mat.dispose();
    multiScatterBake.mat.dispose();
    skyViewBake.mat.dispose();
    main.mat.dispose();
  };

  return {
    scene: main.scene,
    camera,
    transmittanceBakeScene: transmittanceBake.scene,
    multiScatterBakeScene: multiScatterBake.scene,
    bakeCamera,
    setAtmosphere,
    updateUniforms,
    bakeLUTs,
    bakeFroxel,
    bakeSkyView,
    dispose,
  };
}
