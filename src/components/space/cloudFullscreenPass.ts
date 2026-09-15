import * as THREE from "three";
import { NodeMaterial } from "three/webgpu";
import {
  Fn,
  outputStruct,
  property,
  uniform,
  screenUV,
  screenCoordinate,
  vec2,
  vec3,
  vec4,
  float,
  normalize,
  dot,
  length,
} from "three/tsl";
import {
  applyCloudAerialPerspectiveDirect,
  CLOUD_AP_IN_MARCHER,
} from "./atmospherePass";
import {
  marchCloudVolume,
  LOD_MIN_SAMPLES_NEAR,
  LOD_MIN_SAMPLES_FAR,
  MIN_SAMPLES_NEAR_ALT_KM,
  MIN_SAMPLES_FAR_ALT_KM,
} from "@/components/celestial/bodies/earthClouds";
import { kmToScaledUnits } from "@/sim/units";
import { PASS } from "./perf/perfProfiler";
import {
  getStbnTexture,
} from "@/components/celestial/bodies/stbnTexture";

// STBN slice modulus. Deliberately 63 (coprime with the Bayer cycle length,
// SPARSE_DIVISOR²) rather than the texture's actual 64 slices. The Bayer
// schedule makes each pixel "fresh" once per cycle, so the number of distinct
// STBN slices a pixel sees over time is
// `STBN_FRAME_MODULUS / gcd(STBN_FRAME_MODULUS, cycleLen)`. 63 is coprime with
// both 16 (N=4) and 4 (N=2), so a pixel sees all 63 slices → maximal temporal
// variance reduction. Skipping slice 63 occasionally is invisible (adjacent
// slices have similar blue-noise statistics).
import {
  setupCloudReconstructionPass,
  SPARSE_DIVISOR,
  type CloudReconstructionPass,
} from "./cloudReconstructionPass";
import {
  createCloudLightVolume,
  type CloudLightVolume,
} from "./cloudLightVolume";
import { createCloudShadowMap } from "./cloudShadowMap";
import { setCloudSkipJitterAuto } from "@/components/celestial/bodies/cloudCommon";

// ── Empty-space-skip ring dither (docs/CLOUD_SKIP_PLAN.md §5) ──
// Altitude band over which the dither ramps. Tuned by eye 2026-09-14 while descending;
// the artifact lives roughly 6785 → 6380 km from Earth's centre (≈414 → 9 km altitude).
// ⚠ It costs ~j/2 of the skip's reach and the skip is worth MOST at altitude (longest
// empty traverse), so this ramps rather than pinning 0.5 everywhere.
// ⚠⚠ THE RING RESPONSE IS NON-MONOTONE IN THIS DIAL. Measured by eye 2026-09-15 at
// 127 km and 197 km: rings are WORST around 0.125–0.25 and fade toward 0.5–1.0. At 0 they
// are clean at 197 km but return as many sharp rings at 127 km, so NEITHER end is safe.
// ⇒ 0.5 is the lowest value that works at both. Do not "split the difference" downward;
// the midpoint is the worst place to be. The old 0.25→0.5 lerp delivered 0.34–0.42
// across the whole band a player flies in — i.e. parked just under the value that works,
// which is what "rings still visible at some altitudes" was.
// ⚠⚠ 0.25 IS A MEASURED FLOOR, NOT A GUESS — both lower rungs were tried at 6400 km and
// below on 2026-09-15 and both look WORSE: 0 rings all the way down into the deck, and
// 0.125 is worse still. Setting this to 0 would return 0.91 ms at earth_horizon_8 and
// 0.79 at earth_30 — that is the size of the temptation, and it is not available.
// 🔑 jitter 0 is clean at exactly ONE altitude tested (~197 km) and rings at every other.
// So case #28's "the dither's cost is forced" verdict stands, though not for the reason
// it gave: not the sample count, but that 0 rings on its own.
const SKIP_JITTER_NEAR = 0.25;
// 0.5 is the floor that works at ~110–180 km above the tops, but NOT higher: with a flat
// 0.5 the author still saw rings from 6550–6800 km (≈180–430 km alt), matching the 197 km
// by-eye sweep where 0.5 was only "almost gone", 0.75 barely visible and 1.0 gone.
// 🔑 Going to 1.0 up there is nearly FREE: above ~250 km the skip is neutral
// (tEnter = tOuterNear — nothing to skip), so the dither has no reach to give back.
const SKIP_JITTER_MID = 0.5;
const SKIP_JITTER_FAR = 1.0;
// 🔑 ALTITUDES ARE ABOVE THE CLOUD TOPS (altScaled subtracts uOuterRadius), so these are
// ~16 km lower than the HUD reads. 0 below the tops-relative floor because the dither is
// only worth paying where rings can FORM: ring boundaries are footprint-capped skips, and
// their count scales with the approach distance to the deck, so close in there is nothing
// to break. MEASURED: the dither costs 0.91 ms at earth_horizon_8 and 0.92 ms at earth_30
// — where the author reports no rings at all. It is free at 250 km (skip is neutral there:
// tEnter = tOuterNear, nothing to skip). The old schedule had it backwards.
// ⚠ The ramp is DELIBERATELY NARROW: any lerp from 0 to 0.5 crosses the bad 0.125–0.25
// zone, so it must be crossed low and fast, where the approach is too short to ring.
const SKIP_JITTER_NEAR_ALT_KM = 15;
const SKIP_JITTER_MID_ALT_KM = 40;
const SKIP_JITTER_FAR_ALT_KM = 250;

export const STBN_FRAME_MODULUS = 63;

/**
 * ── `__lum.cloudLod(n)` override for `uLodMinSamples`. 0 = the authored lerp. ──
 *
 * 🔑🔑 THIS IS THE MEASURED LEVER, and `__lum.cloudIters()` is what identified it.
 * At earth_8 the march takes **86.4 primary steps per ray to produce 4.2 dense cloud
 * samples** — 95% traversal overhead — and `lodCap = slabLen/(dtSkip · uLodMinSamples)`
 * BINDS there (1.17), so the step count is pinned by construction to roughly this value.
 * The 86 steps are not the cost of *discovering* empty space; they are a sample-count
 * floor we asked for.
 *
 * ⚠⚠ AND IT IS WHY A DISTANCE FIELD WOULD HAVE UNDERPERFORMED: `lodScale` is a
 * `min(growth, lodCap)`, so a perfect analytic skip distance gets clamped straight back
 * down to `slabLen/(dtSkip · 60)` unless this floor moves with it. Empty-space skipping
 * cannot beat a cap it does not bypass — see docs/PERF_MEASUREMENT.md 2026-09-08 and
 * CLOUD_REVIEW §1a/X4.
 */
let _lodMinOverride = 0;
export function setCloudLodMinSamples(n: number): void {
  _lodMinOverride = Math.max(0, n);
}

/**
 * The value actually in force this frame — override if set, else the altitude lerp.
 * Returns 0 before the first frame has run (see `_sharedLodMinSamples`).
 */
export function cloudLodMinSamplesLive(): number {
  return _lodMinOverride > 0 ? _lodMinOverride : _sharedLodMinSamples;
}

/**
 * Mirror of the last value written to the uniform, so the getter needs no handle.
 *
 * 🐛 MUST NOT be initialised from `LOD_MIN_SAMPLES_NEAR`. This module and `earthClouds.ts`
 * import from each other, so at module-evaluation time that binding is still in its
 * temporal dead zone and reading it throws `Cannot access 'LOD_MIN_SAMPLES_NEAR' before
 * initialization` before the first frame ever renders. ⚠ `tsc` cannot see module-eval
 * order across an import cycle and passes clean — this class of crash is only findable by
 * running the app. 0 until `update()` writes the real value on frame 1, which the getter
 * reports honestly rather than inventing a default.
 */
let _sharedLodMinSamples = 0;

// =============================================================================
// Phase D — Cloud pipeline (two-pass architecture, MRT marcher)
//
// Pass 2a: SPARSE COLOR+DEPTH marcher (MRT). Output = one render target with
//          TWO color attachments, each W/SPARSE_DIVISOR × H/SPARSE_DIVISOR
//          (SPARSE_DIVISOR=2 → ¼-res). The fragment marches the volume ONCE
//          and emits `outputStruct(rgba, vec4(tFront,…))`:
//            attachment 0 = premultiplied cloud colour (RGBA16F)
//            attachment 1 = tFront cloud-front depth in .r (<0 = miss)
//          Each sparse texel corresponds to one SPARSE_DIVISOR² full-res tile,
//          marched at the current Bayer sub-pixel slot. Previously this was
//          TWO passes (a separate depth marcher re-ran the whole volume just
//          to extract tFront) — folding it into an MRT struct output removes a
//          full duplicate march per frame (~2× the marcher cost) with byte-
//          identical output (same ray, same STBN slice, same accumulation).
// Pass 2c: FULL-RES RECONSTRUCTION  (cloudReconstructionPass.ts). Reads the
//          two sparse attachments + previous frame's history. Reprojects
//          history through the tile's tFront with origin-shift correction,
//          then YCoCg variance-clamps against the 3×3 fresh neighbourhood and
//          EMA-blends.
//
// Composite (pass 3 in SpaceRenderer) reads the reconstruction RT and
// premul-alpha blends it onto the main scene RT.
//
// The pipeline replaces the previous single-pass continuous-TAA design.
// Motivation: continuous TAA blends ~14 frames of view-dependent radiance
// regardless of motion, producing velocity-proportional smear at high speed.
// Geometric reconstruction with variance clamp converges to a supersampled
// image on still cameras and degrades to per-pixel STBN noise (not smear)
// under extreme motion — bounded, single-frame, recoverable.
//
// Reference: Schneider 2015 (HZD Nubis), Karis 2014 (YCoCg clamp).
// =============================================================================

// -----------------------------------------------------------------------------
// DEBUG: short-circuit modes for the color pass. Visible inside the marched
// 1/16 fresh sub-pixels only; reconstruction will clamp the other pixels
// against the debug bounds.
// -----------------------------------------------------------------------------
type FullscreenDebug =
  | "off"
  | "solid"
  | "screenUV"
  | "rdEarth"
  | "slabHit"
  | "roEarthAlt";
const DEBUG_FULLSCREEN: FullscreenDebug = "off";

// Build-time opt-in for the 3D cloud light volume (sun-transmittance froxel).
// DEFAULT false → the proven 6-tap cone Tsun path (the game never breaks).
// Flip to true to bake a per-voxel sun-transmittance volume once per frame (a
// WebGPU compute pass) and have the marcher read it with ONE trilinear lookup
// instead of cone-marching per fresh pixel. Mirrors DEBUG_FULLSCREEN / DEBUG_VIZ:
// a JS const resolved at TSL graph-build time, so toggle=off emits the exact
// current shader (no runtime cost, no dead uniforms, no texture allocation).
export const USE_LIGHT_VOLUME = true;

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------
export type CloudPipeline = {
  // Pass 2a: marches ONCE, writes BOTH attachments of the sparse MRT RT
  // (texture[0] = color RGBA16F, texture[1] = tFront R16F).
  colorScene: THREE.Scene;
  colorCamera: THREE.OrthographicCamera;

  // Pass 2c: writes historyRt[current]
  reconstructionScene: THREE.Scene;
  reconstructionCamera: THREE.OrthographicCamera;

  /**
   * One updateUniforms call refreshes uniforms for all three passes. Call
   * once per frame, before rendering any of the three scenes.
   */
  updateUniforms: (params: {
    scaledCamera: THREE.PerspectiveCamera;
    earthMesh: THREE.Object3D;
    bayerSubPixel: THREE.Vector2;   // (0..3, 0..3) — Bayer schedule pick this frame
    prevViewProj: THREE.Matrix4;
    originShiftScaled: THREE.Vector3;
    sparseColorTexture: THREE.Texture; // input to reconstruction
    sparseDepthTexture: THREE.Texture; // input to reconstruction
    historyTexture: THREE.Texture;     // input to reconstruction (prev frame)
    historyValid: number;              // 0 / 1
    frameIndex: number;                // for STBN slice
    fullSize: THREE.Vector2;           // full-res screen pixels (DPR-adjusted)
    sparseSize: THREE.Vector2;         // sparse RT pixels (= fullSize / 4)
    // Atmosphere coupling (Phase 3) — from the dominant atmosphere body. Radii
    // in SCALED-world units (match the marcher's earth-space r). Optional: when
    // omitted the cloud uniforms keep their last/default values.
    atmoBottomRadiusScaled?: number;
    atmoTopRadiusScaled?: number;
    atmoHScaled?: number;
    atmoSunIlluminance?: THREE.Vector3;
    atmoSkyColor?: THREE.Color;
  }) => void;

  /**
   * Bake the per-voxel sun-transmittance light volume (a compute pass). MUST be
   * called once per frame BEFORE the colour pass (2a) renders. No-op when
   * USE_LIGHT_VOLUME is false.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  computeLightVolume: (renderer: any) => void;

  /**
   * Cloud Beer Shadow Map (docs/CLOUD_SHADOWS_GODRAYS_PLAN.md L0). Driven from
   * SpaceRenderer's ATMOSPHERE block (not the cloudsVisible block) so the map
   * bakes up to BSM_MAX_ALT_KM for the atmosphere-pass consumers. updateWindow
   * recomputes the sun-space window; bake renders it. Both no-op when the BSM
   * toggle is off (hasCloudShadowMap() === false).
   */
  updateCloudShadowMap: (
    cameraScaledPos: THREE.Vector3,
    earthMesh: THREE.Object3D,
  ) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bakeCloudShadowMap: (renderer: any, fieldUnstable?: boolean) => void;
  hasCloudShadowMap: () => boolean;

  /**
   * Current volumetric crossfade value (earth.ts uVolumetricBlend, 0 = flat
   * 2D overlay only / 1 = volumetric). SpaceRenderer skips the whole cloud
   * pipeline (marcher + reconstruction + light-volume bake) when this is ~0 —
   * the single biggest orbit-perf lever, since the flat overlay carries the
   * orbital view entirely.
   */
  getVolumetricBlend: () => number;

  dispose: () => void;
};

let activePipeline: CloudPipeline | null = null;
let earthMatrixWorldRef: THREE.Object3D | null = null;
// Scratch for the per-frame altitude computation (no per-frame allocation).
const tmpEarthCam = new THREE.Vector3();

export function getActiveCloudPipeline(): CloudPipeline | null {
  if (!activePipeline || !earthMatrixWorldRef) return null;
  return activePipeline;
}

export function getEarthMatrixWorldRef(): THREE.Object3D | null {
  return earthMatrixWorldRef;
}

export function setEarthMatrixWorldSource(mesh: THREE.Object3D | null) {
  earthMatrixWorldRef = mesh;
}

export type SetupCloudPipelineOpts = {
  weatherMap: THREE.Texture;
  baseVolume: THREE.Texture; // GPU-baked Storage3DTexture or CPU Data3DTexture
  detailVolume: THREE.Texture; // GPU-baked Storage3DTexture (64³ level-0)
  detailVolumeMip1: THREE.Texture; // GPU-baked box-downsampled level-1 (32³) for the SS tap
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uInnerRadius: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uOuterRadius: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uCloudUvOffset: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uDensityMul: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uBaseScale: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uColumnScale: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uLightConeRadius: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uVolumetricBlend: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSunRel: any;
  // Atmosphere transmittance LUT (Phase 3 cloud↔atmosphere coupling). Bound at
  // graph-build time; the marcher samples it per dense voxel for physical sun
  // colour. Supplied by earthClouds via getAtmosphereLUTs().transmittance.
  // Optional: when absent (toggle off / atmosphere disabled) the marcher keeps
  // its hand-tuned sun/sky colours.
  transmittanceLUT?: THREE.Texture;
};

// -----------------------------------------------------------------------------
// Shared uniforms — created once, referenced by all three pass materials.
// Mutating .value on one updates everywhere.
// -----------------------------------------------------------------------------
type SharedUniforms = ReturnType<typeof createSharedUniforms>;

function createSharedUniforms() {
  return {
    uCameraMatrixWorld: uniform(new THREE.Matrix4()),
    uCameraScaledPos: uniform(new THREE.Vector3()),
    uTanHalfFov: uniform(0),
    uAspect: uniform(1),
    uEarthInverseModel: uniform(new THREE.Matrix4()),
    // Bayer schedule: which sub-pixel slot (0..3, 0..3) is fresh this frame.
    uBayerSubPixel: uniform(new THREE.Vector2(0, 0)),
    // STBN slice for per-frame jitter (color + depth use the SAME slice so
    // their ray-origin offsets agree — depth.tFront and color.rgba thus
    // describe the same sample).
    uStbnFrameSlice: uniform(0),
    // Full-res screen pixel dimensions. Color & depth passes derive the
    // full-res UV for their fresh sub-pixel; reconstruction also needs
    // this to convert sparse-RT coords back to screen coords.
    uFullSize: uniform(new THREE.Vector2(1, 1)),
    // Altitude-adaptive minimum samples per slab crossing (the marcher's
    // lodCap denominator). Lerped 60 → 24 between MIN_SAMPLES_NEAR_ALT_KM
    // and MIN_SAMPLES_FAR_ALT_KM of camera altitude above the cloud tops.
    uLodMinSamples: uniform(LOD_MIN_SAMPLES_NEAR),
    // ── Atmosphere coupling (Phase 3) ──
    // Static atmosphere geometry in SCALED-world units (matching the marcher's
    // earth-space `r`) for the transmittance-LUT param map, plus the unified sun
    // illuminance and the sky-ambient tint. Driven per frame from the dominant
    // atmosphere body in SpaceRenderer; defaults are Earth so the marcher is
    // correct even before the first push (or if the push never comes). MUST stay
    // consistent with the params the transmittance LUT was BAKED from — they
    // come from the same dominant body, so they do.
    uAtmoBottomRadius: uniform(kmToScaledUnits(6371)),
    uAtmoTopRadius: uniform(kmToScaledUnits(6471)),
    uAtmoH: uniform(kmToScaledUnits(Math.sqrt(6471 * 6471 - 6371 * 6371))),
    uAtmoSunIlluminance: uniform(new THREE.Vector3(20, 20, 20)),
    uAtmoSkyColor: uniform(new THREE.Vector3(0.4, 0.6, 1.0)),
    // ── L4 ship occluder (earthClouds SHIP_OCCLUDER) ──
    // Ship position in earth-model scaled units (≈ camera; the third-person
    // offset is metres against the shadow's ~100 m+ width) and the uniform
    // gate — CPU-set below, 1 only when the ship is within
    // SHIP_OCCLUDER_MAX_ALT_KM of the cloud tops so the marcher's occluder
    // branch costs nothing while flying high.
    uShipOccluderPos: uniform(new THREE.Vector3()),
    uShipOccluderOn: uniform(0),
  };
}

// Gate altitude for the ship→cloud occluder (km above the cloud OUTER shell).
// The 50 m ship's umbra reaches ~10.7 km, so beyond ~15 km above the tops the
// shadow cannot touch any cloud.
const SHIP_OCCLUDER_MAX_ALT_KM = 15;

// -----------------------------------------------------------------------------
// Helpers for the color/depth pass marcher entry: compute the full-res
// ray for THIS sparse pixel given the current Bayer offset.
// -----------------------------------------------------------------------------
function buildMarchRay(shared: SharedUniforms) {
  // We're rendering to a SPARSE RT of size W/N × H/N (N = SPARSE_DIVISOR).
  // screenCoordinate gives pixel coords in that sparse RT. To compute the
  // full-res pixel each sparse texel represents this frame:
  //   sparseTileIndex = floor(screenCoordinate.xy)   (integer 0..sparseW-1)
  //   fullPixel = sparseTileIndex * N + bayerSubPixel + 0.5
  //   fullUv = fullPixel / fullSize
  const sparseTileX = screenCoordinate.x.floor();
  const sparseTileY = screenCoordinate.y.floor();
  const fullPixelX = sparseTileX.mul(float(SPARSE_DIVISOR))
    .add(shared.uBayerSubPixel.x)
    .add(float(0.5));
  const fullPixelY = sparseTileY.mul(float(SPARSE_DIVISOR))
    .add(shared.uBayerSubPixel.y)
    .add(float(0.5));
  const fullUvX = fullPixelX.div(shared.uFullSize.x);
  const fullUvY = fullPixelY.div(shared.uFullSize.y);

  // NDC from full-res UV. ndc.y = 1 - 2·uv.y because WebGPU RT origin
  // is at top-left (matches our screenUV convention everywhere else).
  const ndcX = fullUvX.mul(2).sub(1);
  const ndcY = float(1).sub(fullUvY.mul(2));

  // View-space ray direction (FOV-based, no projection inverse).
  const rdView = vec3(
    ndcX.mul(shared.uAspect).mul(shared.uTanHalfFov),
    ndcY.mul(shared.uTanHalfFov),
    float(-1),
  );
  const rdScaled = normalize(
    shared.uCameraMatrixWorld.mul(vec4(rdView, 0)).xyz,
  );
  const roEarth = shared.uEarthInverseModel
    .mul(vec4(shared.uCameraScaledPos, 1)).xyz;
  const rdEarth = normalize(
    shared.uEarthInverseModel.mul(vec4(rdScaled, 0)).xyz,
  );

  // Full-res screen UV of this sample (same [0,1] y-down convention as the
  // froxel bake / composite screenUV) — used to apply the aerial-perspective
  // froxel to the marcher output pre-reconstruction (see CLOUD_AP_IN_MARCHER).
  const fullUv = vec2(fullUvX, fullUvY);

  return { roEarth, rdEarth, rdScaled, fullUv };
}

// -----------------------------------------------------------------------------
// Pass 2a: SPARSE COLOR marcher
// -----------------------------------------------------------------------------
function createColorPass(
  opts: SetupCloudPipelineOpts,
  shared: SharedUniforms,
  stbnTexture: THREE.Data3DTexture,
  lightVolume: CloudLightVolume | null,
) {
  const scene = new THREE.Scene();
  // Label for the per-pass GPU profiler (perf/perfProfiler.ts).
  scene.name = PASS.marcher;
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const geo = new THREE.PlaneGeometry(2, 2);
  const mat = new NodeMaterial();

  // Replace contents of sparseCloudRt; reconstruction pass owns the blend.
  mat.transparent = false;
  mat.depthTest = false;
  mat.depthWrite = false;
  mat.blending = THREE.NoBlending;

  // MRT output: attachment 0 = colour RGBA16F, attachment 1 = tFront (in .r).
  // The marcher computes BOTH in ONE pass, replacing the old separate depth
  // marcher (see setupCloudPipeline note).
  //
  // Pattern (canonical three.js MRT — cf. examples/jsm/tsl/display/
  // DepthOfFieldNode): the marcher runs via `colorNode` and writes its two
  // outputs into top-level `property()` vars; `material.outputNode =
  // outputStruct(...)` maps those vars positionally to the RT's two colour
  // attachments. Two pitfalls this avoids:
  //   1. `material.outputNode` is honoured ONLY when `fragmentNode` is null
  //      (NodeMaterial.js), so the compute goes through `colorNode`.
  //   2. Wrapping `outputStruct(...)` inside the Fn and returning it does NOT
  //      work — the OutputType struct fails to register (WGSL "struct member
  //      m0 not found"). The struct must be a top-level node.
  // The colorNode's own return value is discarded (the custom outputNode
  // replaces it); only its side-effect assigns to the property vars matter.
  const rgbaOut = property("vec4");
  const tFrontOut = property("float");

  mat.colorNode = Fn(() => {
    // ── DEBUG short-circuits ──
    if (DEBUG_FULLSCREEN === "solid") {
      rgbaOut.assign(vec4(1, 0, 0, 1));
      tFrontOut.assign(float(0));
      return vec4(0);
    }
    if (DEBUG_FULLSCREEN === "screenUV") {
      rgbaOut.assign(
        vec4(screenUV.x, float(1).sub(screenUV.y), float(0), float(1)),
      );
      tFrontOut.assign(float(0));
      return vec4(0);
    }

    const { roEarth, rdEarth, fullUv } = buildMarchRay(shared);
    const sunDirEarth = normalize(
      shared.uEarthInverseModel.mul(vec4(opts.uSunRel, 0)).xyz,
    );

    if (DEBUG_FULLSCREEN === "rdEarth") {
      rgbaOut.assign(
        vec4(
          rdEarth.x.mul(0.5).add(0.5),
          rdEarth.y.mul(0.5).add(0.5),
          rdEarth.z.mul(0.5).add(0.5),
          float(1),
        ),
      );
      tFrontOut.assign(float(0));
      return vec4(0);
    }
    if (DEBUG_FULLSCREEN === "roEarthAlt") {
      const len = length(roEarth).div(10).clamp(0, 1);
      rgbaOut.assign(vec4(len, len, len, float(1)));
      tFrontOut.assign(float(0));
      return vec4(0);
    }
    if (DEBUG_FULLSCREEN === "slabHit") {
      const b = dot(roEarth, rdEarth);
      const d2 = dot(roEarth, roEarth);
      const cOuter = d2.sub(opts.uOuterRadius.mul(opts.uOuterRadius));
      const discOuter = b.mul(b).sub(cOuter);
      const hit = discOuter.greaterThan(0).select(float(1), float(0));
      rgbaOut.assign(vec4(hit, hit, hit, float(1)));
      tFrontOut.assign(float(0));
      return vec4(0);
    }

    const { rgba, tFront } = marchCloudVolume({
      roEarth,
      rdEarth,
      sunDirEarth,
      weatherMap: opts.weatherMap,
      baseVolume: opts.baseVolume,
      detailVolume: opts.detailVolume,
      detailVolumeMip1: opts.detailVolumeMip1,
      uInnerRadius: opts.uInnerRadius,
      uOuterRadius: opts.uOuterRadius,
      uCloudUvOffset: opts.uCloudUvOffset,
      uDensityMul: opts.uDensityMul,
      uBaseScale: opts.uBaseScale,
      uColumnScale: opts.uColumnScale,
      uLightConeRadius: opts.uLightConeRadius,
      uVolumetricBlend: opts.uVolumetricBlend,
      uStbn: stbnTexture,
      uStbnFrameSlice: shared.uStbnFrameSlice,
      uLodMinSamples: shared.uLodMinSamples,
      // Light-volume lookup (undefined when toggle off → cone path).
      // Dual-volume crossfade pair: per-side window CENTRE + tangent frame,
      // shared half-extent, blended by uMixA (see earthClouds shell
      // addressing / cloudLightVolume.ts crossfade).
      uLightVol: lightVolume?.lightVolTexA,
      uLightVolB: lightVolume?.lightVolTexB,
      uLightVolCenter: lightVolume?.uBoxCenterA,
      uLightVolCenterB: lightVolume?.uBoxCenterB,
      uLightVolHalfExtent: lightVolume?.uBoxHalfExtent,
      uLightVolAxisX: lightVolume?.uBoxAxisXA,
      uLightVolAxisY: lightVolume?.uBoxAxisYA,
      uLightVolAxisZ: lightVolume?.uBoxAxisZA,
      uLightVolAxisXB: lightVolume?.uBoxAxisXB,
      uLightVolAxisYB: lightVolume?.uBoxAxisYB,
      uLightVolAxisZB: lightVolume?.uBoxAxisZB,
      uLightVolMixA: lightVolume?.uMixA,
      uVolumeWeight: lightVolume?.uVolumeWeight,
      // ── Atmosphere coupling (Phase 3) ── transmittance LUT + atmosphere
      // geometry/illuminance/sky tint for per-sample physical cloud lighting.
      uTransmittanceLUT: opts.transmittanceLUT,
      uAtmoBottomRadius: shared.uAtmoBottomRadius,
      uAtmoTopRadius: shared.uAtmoTopRadius,
      uAtmoH: shared.uAtmoH,
      uAtmoSunIlluminance: shared.uAtmoSunIlluminance,
      uAtmoSkyColor: shared.uAtmoSkyColor,
      // ── L4 ship→cloud shadow (analytic occluder) ──
      uShipOccluderPos: shared.uShipOccluderPos,
      uShipOccluderOn: shared.uShipOccluderOn,
    });
    // Aerial-perspective fog applied HERE (pre-reconstruction) so its depth-
    // driven colour variance is averaged by the temporal EMA rather than
    // flickering per-frame at composite time (see CLOUD_AP_IN_MARCHER). Uses
    // this sample's own cloud-front depth (tFront) + full-res UV — no gather /
    // reprojection needed. When off (A/B or a debug mode) the composite fogs.
    if (CLOUD_AP_IN_MARCHER) {
      rgbaOut.assign(applyCloudAerialPerspectiveDirect(rgba, fullUv, tFront));
    } else {
      rgbaOut.assign(rgba);
    }
    tFrontOut.assign(tFront);
    return rgba;
  })();

  // m0 = premultiplied colour, m1.r = tFront (cloud-front depth; <0 = miss).
  mat.outputNode = outputStruct(
    rgbaOut,
    vec4(tFrontOut, float(0), float(0), float(1)),
  );

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  scene.add(mesh);

  return { scene, camera, mat, geo, mesh };
}

// -----------------------------------------------------------------------------
// Pipeline setup — builds the color (MRT) + reconstruction passes;
// returns the orchestrator with a single updateUniforms entry point.
// -----------------------------------------------------------------------------
export function setupCloudPipeline(
  opts: SetupCloudPipelineOpts,
): CloudPipeline {
  if (activePipeline) activePipeline.dispose();

  const shared = createSharedUniforms();
  const stbnTexture = getStbnTexture();

  // 3D sun-transmittance light volume (only when the toggle is on — otherwise
  // no texture is allocated and no compute node is built). Shares the same
  // uEarthInverseModel uniform object as the marcher so the box + baked sun
  // direction stay in sync with the per-frame update below.
  const lightVolume = USE_LIGHT_VOLUME
    ? createCloudLightVolume({
        baseVolume: opts.baseVolume,
        weatherMap: opts.weatherMap,
        uInnerRadius: opts.uInnerRadius,
        uOuterRadius: opts.uOuterRadius,
        uBaseScale: opts.uBaseScale,
        uColumnScale: opts.uColumnScale,
        uCloudUvOffset: opts.uCloudUvOffset,
        uSunRel: opts.uSunRel,
        uEarthInverseModel: shared.uEarthInverseModel,
      })
    : null;

  // Cloud Beer Shadow Map (docs/CLOUD_SHADOWS_GODRAYS_PLAN.md L0). Shares the
  // EXACT density-recipe nodes with the light volume + marcher so its shadows
  // register with the drawn clouds. Unlike the marcher/light-volume it must bake
  // at higher altitude than cloudsVisible (its consumers are the atmosphere pass),
  // so SpaceRenderer drives updateCloudShadowMap/bakeCloudShadowMap separately in
  // the atmosphere block — NOT through updateUniforms/computeLightVolume below.
  const shadowMap = createCloudShadowMap({
    baseVolume: opts.baseVolume,
    weatherMap: opts.weatherMap,
    uInnerRadius: opts.uInnerRadius,
    uOuterRadius: opts.uOuterRadius,
    uBaseScale: opts.uBaseScale,
    uColumnScale: opts.uColumnScale,
    uCloudUvOffset: opts.uCloudUvOffset,
    uSunRel: opts.uSunRel,
  });

  const color = createColorPass(opts, shared, stbnTexture, lightVolume);
  const reconstruction = setupCloudReconstructionPass({
    uOuterRadius: opts.uOuterRadius,
  });

  // The reconstruction pass has its OWN copies of camera/earth uniforms
  // (it can't share `shared` directly because it lives in a different
  // module / TSL graph). updateUniforms below pushes the same values to
  // both. This duplication is intentional — keeps the two passes
  // independently testable and respects TSL's bind-group ownership.

  const updateUniforms: CloudPipeline["updateUniforms"] = (params) => {
    // Shared (color MRT pass)
    shared.uCameraMatrixWorld.value.copy(params.scaledCamera.matrixWorld);
    shared.uCameraScaledPos.value.copy(params.scaledCamera.position);
    shared.uTanHalfFov.value =
      Math.tan((params.scaledCamera.fov * Math.PI) / 180 / 2);
    shared.uAspect.value = params.scaledCamera.aspect;
    params.earthMesh.updateWorldMatrix(true, false);
    shared.uEarthInverseModel.value
      .copy(params.earthMesh.matrixWorld).invert();
    shared.uBayerSubPixel.value.copy(params.bayerSubPixel);
    // STBN slice = (frame % 63) / 63 — 63 chosen because gcd(63, 16) = 1
    // gives each pixel 63 distinct slices instead of just 4 (which the
    // naive `% 64` would give with the 16-frame Bayer cycle). See
    // STBN_FRAME_MODULUS comment at top of file.
    shared.uStbnFrameSlice.value =
      (params.frameIndex % STBN_FRAME_MODULUS) / STBN_FRAME_MODULUS;
    shared.uFullSize.value.copy(params.fullSize);
    // Altitude-adaptive minimum slab samples (60 near deck → 24 high above).
    // Earth-space camera radius via the just-refreshed inverse model matrix;
    // altitude measured above the cloud-top (outer) shell.
    tmpEarthCam
      .copy(params.scaledCamera.position)
      .applyMatrix4(shared.uEarthInverseModel.value);
    const altScaled = tmpEarthCam.length() - opts.uOuterRadius.value;
    const altT = THREE.MathUtils.clamp(
      (altScaled - kmToScaledUnits(MIN_SAMPLES_NEAR_ALT_KM)) /
        (kmToScaledUnits(MIN_SAMPLES_FAR_ALT_KM) -
          kmToScaledUnits(MIN_SAMPLES_NEAR_ALT_KM)),
      0,
      1,
    );
    shared.uLodMinSamples.value = THREE.MathUtils.lerp(
      LOD_MIN_SAMPLES_NEAR,
      LOD_MIN_SAMPLES_FAR,
      altT,
    );
    // ⚠ AFTER the lerp, because the lerp runs every frame and would overwrite a
    // uniform written from the console. Same shape as the atmosphere's K override.
    _sharedLodMinSamples = shared.uLodMinSamples.value;
    if (_lodMinOverride > 0) shared.uLodMinSamples.value = _lodMinOverride;

    // ── Empty-space-skip ring dither, altitude-adaptive (see uSkipJitter) ──
    // 🔑 WHY IT SCALES WITH ALTITUDE: ring boundaries are footprint-capped skips, and their
    // count scales with the approach distance to the deck — i.e. with altitude. Close in
    // there are too few to ring, so the dither is pure cost there; high up they are many.
    // ⚠ See the constants: the response is NON-MONOTONE, 0.5 is a floor not a midpoint.
    // Piecewise, NOT one lerp: the low leg races 0→0.5 through the bad zone while the
    // approach is too short to ring, and the high leg climbs 0.5→1.0 where it is free.
    const midScaled = kmToScaledUnits(SKIP_JITTER_MID_ALT_KM);
    const jitLowT = THREE.MathUtils.clamp(
      (altScaled - kmToScaledUnits(SKIP_JITTER_NEAR_ALT_KM)) /
        (midScaled - kmToScaledUnits(SKIP_JITTER_NEAR_ALT_KM)),
      0,
      1,
    );
    const jitHighT = THREE.MathUtils.clamp(
      (altScaled - midScaled) /
        (kmToScaledUnits(SKIP_JITTER_FAR_ALT_KM) - midScaled),
      0,
      1,
    );
    setCloudSkipJitterAuto(
      altScaled < midScaled
        ? THREE.MathUtils.lerp(SKIP_JITTER_NEAR, SKIP_JITTER_MID, jitLowT)
        : THREE.MathUtils.lerp(SKIP_JITTER_MID, SKIP_JITTER_FAR, jitHighT),
    );

    // ── L4 ship→cloud occluder: position (ship ≈ camera, earth-model — the
    // tmpEarthCam just computed above) + the near-slab uniform gate. ──
    shared.uShipOccluderPos.value.copy(tmpEarthCam);
    shared.uShipOccluderOn.value =
      tmpEarthCam.length() <
      opts.uOuterRadius.value + kmToScaledUnits(SHIP_OCCLUDER_MAX_ALT_KM)
        ? 1
        : 0;

    // Atmosphere coupling (Phase 3): push the dominant body's static geometry +
    // unified illuminance + sky tint. Static terms are cheap to re-copy; skyColor
    // varies per frame. Guarded so a frame with no dominant body keeps defaults.
    if (params.atmoBottomRadiusScaled !== undefined)
      shared.uAtmoBottomRadius.value = params.atmoBottomRadiusScaled;
    if (params.atmoTopRadiusScaled !== undefined)
      shared.uAtmoTopRadius.value = params.atmoTopRadiusScaled;
    if (params.atmoHScaled !== undefined)
      shared.uAtmoH.value = params.atmoHScaled;
    if (params.atmoSunIlluminance)
      shared.uAtmoSunIlluminance.value.copy(params.atmoSunIlluminance);
    if (params.atmoSkyColor)
      shared.uAtmoSkyColor.value.set(
        params.atmoSkyColor.r,
        params.atmoSkyColor.g,
        params.atmoSkyColor.b,
      );

    // Light-volume box — MUST run AFTER uEarthInverseModel is re-inverted above
    // (updateBox applies it to the camera position). The baked sun direction is
    // read inside the kernel from the same shared uEarthInverseModel × uSunRel.
    lightVolume?.updateBox(params.scaledCamera.position);

    // Reconstruction (everything the color MRT pass doesn't need)
    reconstruction.updateUniforms(
      params.scaledCamera,
      params.earthMesh,
      params.bayerSubPixel,
      params.prevViewProj,
      params.originShiftScaled,
      params.sparseColorTexture,
      params.sparseDepthTexture,
      params.historyTexture,
      params.historyValid,
      params.sparseSize,
    );
  };

  const dispose = () => {
    color.scene.remove(color.mesh);
    color.mat.dispose();
    color.geo.dispose();
    reconstruction.dispose();
    lightVolume?.dispose();
    shadowMap?.dispose();
    if (activePipeline === handle) activePipeline = null;
  };

  const handle: CloudPipeline = {
    colorScene: color.scene,
    colorCamera: color.camera,
    reconstructionScene: reconstruction.scene,
    reconstructionCamera: reconstruction.camera,
    updateUniforms,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    computeLightVolume: (renderer: any) => lightVolume?.compute(renderer),
    updateCloudShadowMap: (cameraScaledPos, earthMesh) =>
      shadowMap?.updateWindow(cameraScaledPos, earthMesh),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bakeCloudShadowMap: (renderer: any, fieldUnstable?: boolean) =>
      shadowMap?.bake(renderer, fieldUnstable),
    hasCloudShadowMap: () => shadowMap !== null,
    getVolumetricBlend: () => opts.uVolumetricBlend.value as number,
    dispose,
  };
  activePipeline = handle;
  return handle;
}

// -----------------------------------------------------------------------------
// Backwards-compat re-exports — let other modules keep importing the old
// names while we migrate consumers in a follow-up. Drop these in a cleanup
// pass once SpaceRenderer and earthClouds are updated.
// -----------------------------------------------------------------------------
export { CloudReconstructionPass };
