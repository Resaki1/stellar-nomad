"use client";

import { ReactNode, useEffect, useMemo, useRef } from "react";
import { createPortal, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { NodeMaterial, RenderPipeline, RenderTarget } from "three/webgpu";
import type { WebGPURenderer } from "three/webgpu";
import {
  texture,
  screenUV,
  vec2,
  float,
  screenCoordinate,
  hash,
} from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import {
  LOCAL_TO_SCALED_FROM_LOCAL_UNITS,
  SCALED_UNITS_PER_KM,
} from "@/sim/units";
import { useWorldOrigin } from "@/sim/worldOrigin";
import {
  HalfFloatType,
  AgXToneMapping,
  NeutralToneMapping,
  NoToneMapping,
} from "three";
import { useAtomValue } from "jotai/react";
import { settingsAtom } from "@/store/store";
import {
  getActiveCloudPipeline,
  getEarthMatrixWorldRef,
  STBN_FRAME_MODULUS,
  USE_LIGHT_VOLUME,
} from "./cloudFullscreenPass";
import { SPARSE_DIVISOR } from "./cloudReconstructionPass";
import { BSM_MAX_ALT_KM, setCloudShadowStrength } from "./cloudShadowMap";
import {
  setExposureCompensation,
  updatePreExposureForFrame,
  uPostExposure,
} from "./photometry";
import { updatePreExposedEmissives } from "./preExposedEmissive";
import { clearLumSource, setLumSource } from "./perf/lumHarness";
import { updateExposureMeter } from "./exposureMeter";
import {
  setupAtmospherePass,
  getDominantAtmosphereBody,
  getAtmosphereLutEpoch,
  getAtmosphereLUTs,
  getAtmosphereLighting,
  computeAtmosphereLighting,
  clearAtmosphereLighting,
  FROXEL_ENABLED,
  SKYVIEW_ENABLED,
  SKYVIEW_BAKE_MAX_ALT_KM,
  applyCloudAerialPerspective,
  CLOUD_AP_IN_MARCHER,
} from "./atmospherePass";
import {
  flushCloudBakes,
  warmCloudBakes,
  hasPendingCloudBakes,
} from "@/components/celestial/bodies/cloudVolumeCompute";
import { PASS, perf, type GateState } from "./perf/perfProfiler";

const LOCAL_CAMERA_NEAR = 0.01;
// 20,000 km expressed in local meters
const LOCAL_CAMERA_FAR = 20_000 * 1000;
// 0.1 scaled units = 100 km. The closest geometry in the scaled scene
// is a planet surface at ~30+ scaled units (with floating origin), so
// this is safe. A tighter near plane gives far better depth precision
// at medium distances — fixes z-fighting on Saturn's rings at ~1.4M km.
// (Don't use logarithmicDepthBuffer — it breaks depth for custom vertexNode.)
const SCALED_CAMERA_NEAR = 0.001;
const SCALED_CAMERA_FAR = 2_000_000;

// ── Atmosphere pass (docs/ATMOSPHERE_PLAN.md) ────────────────────────────────
// A physically-based scattering post-pass (Hillaire 2020) inserted right after
// the scaled scene renders: it fogs the background (planets/skybox/stars in
// `rt`) with transmittance + in-scattering and writes `rtB`; clouds, the local
// scene, and the post pipeline then target `rtB`. Two static LUTs (transmittance
// 256×64, multiple-scattering 32×32) are baked once per atmosphere. When no
// atmosphere-bearing body is in range the pass runs as a cheap passthrough copy
// (uActive=0). When disabled entirely the renderer keeps targeting `rt`.
const ATMOSPHERE_PASS_ENABLED = true;

// Skip the AP froxel bake above this altitude (km). The froxel's only consumer
// is the cloud aerial perspective, and the volumetric clouds only render below
// ~3000 km (earth.ts VOLUMETRIC_BLEND_START_ALT_KM); above that the bake is
// wasted. Set a touch higher so the froxel is ready before clouds fade in.
const FROXEL_BAKE_MAX_ALT_KM = 4000;

// Altitude band (km, below BSM_MAX_ALT_KM) over which the ground cloud-shadow
// strength ramps 1→0, so shadows don't pop off at the BSM bake ceiling.
const BSM_FADE_BAND_KM = 400;

// ⚠⚠ TEMPORARY DIAGNOSTIC — MUST be false. Cloud shadows disappear when true.
//
// GROUND-TRUTH ablation of the ENTIRE Beer Shadow Map — bake AND every consumer, because
// skipping the block leaves `bsmStrength = 0`, which closes the `strength > 0` gate in the
// atmosphere march, the planet surface penumbra and the ship lighting alike.
//
// ✅ MEASURED 2026-08-13: **the BSM costs 2.8–3.7 ms** (≈2.5–3.4 after backing out the
// ring-gate confound). earth_8 15.30 → 11.60, earth_30 15.70 → 12.10, earth_650
// 11.30 → 8.50. Control group perfect: every `bsmStrength = 0` row moved exactly 0.00.
// **This is the largest single item left in the frame.**
//
// It also settled which of three mutually-inconsistent claims was right: the reported
// `1b beer shadow map` 12.20 ms is a PHANTOM (3.6× inflated), and the per-march taps
// really are free. Per docs/PERF_MEASUREMENT.md § "the METHODOLOGICAL LESSON", do not
// substitute arithmetic on reported per-pass numbers for an ablation like this.
const BSM_ABLATE_DIAGNOSTIC = false;

// ⚠⚠ TEMPORARY DIAGNOSTIC — MUST be false. Cloud shadows disappear when true.
//
// Splits the MEASURED ~3.4 ms total BSM cost into BAKE vs CONSUMERS. This one leaves the
// bake running and zeroes only the strength, which closes every consumer gate (atmosphere
// march, planet surface penumbra, ship lighting). So:
//   full − this      = the consumers' cost
//   this − full-off  = the bake's cost
//
// ✅ MEASURED 2026-08-13 (earth_8: full 15.30, this 14.00, all-off 11.60):
//   **consumers 1.1–1.3 ms, BAKE 1.7–2.4 ms — the bake dominates.**
// So the lever is `bakeCloudShadowMap` in cloudShadowMap.ts (BSM_MARCH_STEPS = 24,
// BSM_SIZE = 512, or baking on alternate frames), NOT the consumers.
//
// ⚠ AND THE THIRD WRONG PREDICTION ON THIS PASS. I predicted the bake at ~0.7 ms from
// "512² × 24 = 6.29 M step-evals at 8.7 G step-evals/s". Actual: 2.40 ms. The 8.7 G/s
// figure was measured on the ATMOSPHERE march, which taps 2D LUTs; the BSM march samples
// 3D cloud noise volumes and is far heavier per step.
// **LESSON: step-eval rates are NOT portable between shaders.** Running tally on this one
// pass: reported 12.20 (phantom), my estimate 2.2 (wrong 3×), my estimate 0.7 (wrong 3×),
// measured 3.4 total. Ablate.
const BSM_CONSUMERS_ABLATE_DIAGNOSTIC = false;

// ── Cloud-only resolution clamp ──────────────────────────────────────────────
// The whole scene renders at gl.getPixelRatio() (DPR, clamped to [0.5, 1.5] in
// Scene.tsx → 1.5 on a Retina M-series). The volumetric cloud pipeline (the
// sparse ray-marcher AND the full-res reconstruction) is the dominant GPU cost
// and scales with pixel count, so we render ONLY the clouds at
// min(DPR, CLOUD_MAX_DPR) and let the composite (pass 3) bilinearly upsample to
// the full-DPR scene RT. Result: clouds soften slightly; the planet, ship, and
// UI stay full-res. On a 1.5-DPR Retina, CLOUD_MAX_DPR=1.0 cuts cloud fragment
// count ~2.25× (both the marcher and the reconstruction). The marcher's sparse
// RT and the reconstruction/history RTs MUST share this DPR so the Bayer tile
// mapping (sparse = cloud-full / SPARSE_DIVISOR) stays exact. Raise toward the
// device DPR (e.g. 1.5) for sharper clouds at higher cost; set high (e.g. 4) to
// disable the clamp entirely.
const CLOUD_MAX_DPR = 1.0;

// Output dither amplitude, in 8-bit LSB (applied post-tonemap, pre-sRGB). Breaks
// the 8-bit quantization banding that shows on smooth gradients — chiefly the
// atmosphere sky, which bands at the final quantization regardless of whether it
// came from the Sky-View LUT or the raymarch (this is why raising LUT resolution
// / lowering the crossfade couldn't fully fix it). The Unreal/Frostbite trick.
// ~1 LSB pre-sRGB ≈ 1–2 LSB in the dark sky (sRGB expands near black). 0 = off.
const OUTPUT_DITHER_LSB = 1.0;

// Phase D reconstruction. The marcher writes a SPARSE RT (1/SPARSE_DIVISOR²
// of full pixels); a full-res reconstruction pass fills the rest from
// reprojected history with YCoCg variance clamping, over a SPARSE_DIVISOR²-
// frame Bayer cycle. SPARSE_DIVISOR is the single source (cloudReconstructionPass);
// the BAYER pattern below must cover all SPARSE_DIVISOR² sub-positions.
// See cloudFullscreenPass.ts and cloudReconstructionPass.ts.

// Bayer ordered-dither schedule, value → (x, y) sub-pixel slot. Each frame
// picks index `frameIndex mod BAYER.length`; after one full cycle every
// sub-pixel of every SPARSE_DIVISOR×SPARSE_DIVISOR tile has been marched once.
// MUST match SPARSE_DIVISOR: exactly SPARSE_DIVISOR² entries covering all
// sub-positions. This is the 2×2 pattern (N=2 → 4-frame cycle); for N=4 swap in
// the 16-entry 4×4 Bayer matrix.
const BAYER: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [1, 1], [1, 0], [0, 1],
];

const tempScaledPos = new THREE.Vector3();
const tempClearColor = new THREE.Color();
const tempBayerSub = new THREE.Vector2();
const tempViewProj = new THREE.Matrix4();
const tempOriginShiftScaled = new THREE.Vector3();
const tempFullSize = new THREE.Vector2();
const tempSparseSize = new THREE.Vector2();
// Camera position relative to the dominant atmosphere body, in km — feeds the
// per-frame CPU lighting coupling (SunLight tint + sky-ambient fill).
const tempCamPlanetKm = new THREE.Vector3();
// Scratch for the dominant body's sun illuminance handed to the cloud marcher
// (Phase 3 cloud↔atmosphere coupling) — avoids a per-frame allocation.
const tempAtmoSunIll = new THREE.Vector3();
// Live gate state handed to the perf profiler each frame (mutated in place — a
// timing table is uninterpretable without knowing which altitude gates were open
// when it was captured). See perf/perfProfiler.ts.
const frameGates: GateState = {
  altitudeKm: 0,
  distanceKm: 0,
  body: null,
  volumetricBlend: 0,
  bsmStrength: 0,
  cloudsVisible: false,
  froxelBaked: false,
  skyViewBaked: false,
  bsmBaked: false,
  lightVolume: false,
};

const scaledScene = new THREE.Scene();
const localScene = new THREE.Scene();
// Scene names double as the per-pass profiler labels: three's inspector hook
// reports each render context under its scene's name (see perf/perfProfiler.ts).
scaledScene.name = PASS.scaled;
localScene.name = PASS.local;

// Halton(2,3) sub-pixel jitter is obsolete in the 1/16 reconstruction
// architecture — replaced by the deterministic BAYER schedule above.
// The Bayer slot index is `frameIndex % 16` and the sub-pixel offset is
// applied integer-pixel-wise inside the marcher (not as a fractional jitter).

// Full-screen quad for the cloud composite pass. One per SpaceRenderer
// lifetime — the cloud-texture node inside the material is rebuilt when the
// RT changes, but the geometry + camera are static.
const compositeScene = new THREE.Scene();
compositeScene.name = PASS.composite;
const compositeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const compositeGeometry = new THREE.PlaneGeometry(2, 2);

// ── Cloud spatial denoise (Step 1) ──────────────────────────────────────────
// The 1/16 reconstruction holds 16 INDEPENDENT single-sample marcher
// realisations side-by-side in every 4×4 tile: each pixel is refreshed once
// per 16 frames (Bayer schedule), then held. Temporal accumulation smooths
// each pixel's *time* series but does nothing for the *spatial* variance
// between neighbours — so the marcher's high single-sample variance shows up
// directly as salt-and-pepper, worst on thin/edge regions where the marcher's
// hit/miss is bistable. This is the noise that persists with a stationary
// camera (confirmed: `sparseOnly` flickers hard when still; `freshNoBlend`
// barely changes anything → the temporal blend isn't the lever).
//
// The references all pair temporal reprojection with a SPATIAL filter that our
// reconstruction lacks: Nubis renders at quarter-res + bilinear upsample (a
// 2×2 low-pass); Star Citizen and RDR2 run an explicit bilateral blur on the
// cloud buffer. We fold a small Gaussian gather into the composite fetch —
// cheap (no new pass/RT), and it blurs only the screen-facing copy, leaving
// the feedback-history RT clean so the blur can't compound across frames.
//
// Premultiplied-alpha values (the marcher returns vec4(col, alpha) premul)
// filter linearly, so a plain weighted average is halo-free at silhouettes:
// averaging toward transparent yields the soft cloud edge we want anyway.
//
//   0 = off (raw single fetch — the A/B baseline)
//   1 = 3×3 Gaussian   (default; +8 taps/pixel)
//   2 = 5×5 Gaussian   (+24 taps/pixel — use if 3×3 leaves residual grain)
const CLOUD_DENOISE_RADIUS = 2;

// Build the composite pass's fragment node for one history RT: either a raw
// single fetch (denoise off) or a normalised binomial-Gaussian gather over the
// premultiplied RGBA. Built once per RT (rebuilt on resize, when historyRts is
// recreated), so the JS-side weight loop runs at graph-build time — the shader
// just does 2r+1 squared texture fetches and a weighted sum per pixel.
function buildCompositeFetch(
  rt: RenderTarget,
  sparseRt: RenderTarget | null,
) {
  // Phase 4 step 2: fog the gathered cloud by the aerial-perspective froxel at
  // the cloud-front depth (sparseRt.textures[1] = tFront) so distant clouds fade
  // into the atmospheric haze. The fog samples that depth through a sentinel-
  // rejecting gather (needs the sparse RT's texel size). No-op (returns the raw
  // cloud) when the froxel is disabled or no sparse RT is bound.
  const sparseDepthTex = sparseRt ? sparseRt.textures[1] : null;
  const sTx = sparseRt ? 1 / Math.max(1, sparseRt.width) : 0;
  const sTy = sparseRt ? 1 / Math.max(1, sparseRt.height) : 0;
  // AP is normally applied inside the marcher (pre-reconstruction, temporally
  // stable — see CLOUD_AP_IN_MARCHER). Only fog at composite when that path is
  // off (A/B toggle or an AP_DEBUG viz, which lives on this path).
  const fog = (cloud: Parameters<typeof applyCloudAerialPerspective>[0]) =>
    FROXEL_ENABLED && !CLOUD_AP_IN_MARCHER && sparseDepthTex
      ? applyCloudAerialPerspective(cloud, screenUV, sparseDepthTex, sTx, sTy)
      : cloud;

  if (CLOUD_DENOISE_RADIUS <= 0) {
    return fog(texture(rt.texture, screenUV));
  }
  const r = CLOUD_DENOISE_RADIUS;
  const tx = 1 / Math.max(1, rt.width);
  const ty = 1 / Math.max(1, rt.height);
  // 1D binomial weights (Pascal row 2r) approximate a Gaussian; the 2D kernel
  // is their separable outer product. e.g. r=1 → [1,2,1], 2D sum = 16.
  const n = 2 * r;
  const w1d: number[] = [];
  for (let k = 0; k <= n; k++) {
    let coeff = 1;
    for (let i = 0; i < k; i++) coeff = (coeff * (n - i)) / (i + 1);
    w1d.push(coeff);
  }
  const taps: Array<[number, number, number]> = [];
  let wSum = 0;
  for (let oy = -r; oy <= r; oy++) {
    for (let ox = -r; ox <= r; ox++) {
      const w = w1d[ox + r] * w1d[oy + r];
      wSum += w;
      taps.push([ox, oy, w]);
    }
  }
  const sample = ([ox, oy, w]: [number, number, number]) =>
    texture(
      rt.texture,
      vec2(screenUV.x.add(float(ox * tx)), screenUV.y.add(float(oy * ty))),
    ).mul(float(w));
  let acc = sample(taps[0]);
  for (let i = 1; i < taps.length; i++) acc = acc.add(sample(taps[i]));
  return fog(acc.div(float(wSum)));
}

export type SpaceRendererProps = {
  scaled: ReactNode;
  local: ReactNode;
};

const SpaceRenderer = ({ scaled, local }: SpaceRendererProps) => {
  const settings = useAtomValue(settingsAtom);
  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);
  const localCamera = useThree(
    (state) => state.camera as THREE.PerspectiveCamera
  );
  // Floating-origin tracking. `worldOriginKm` is mutated every frame by
  // Spaceship.tsx to follow the ship's interpolated position, so the
  // scaled-world coordinate system slides under static objects from one
  // frame to the next. The cloud pass's TAA reprojection must subtract
  // this slide before sampling the history RT — see uOriginShiftScaled
  // in cloudFullscreenPass.ts.
  const worldOrigin = useWorldOrigin();

  const scaledCamera = useMemo(() => localCamera.clone(), [localCamera]);

  // Offscreen render target — both scenes render here with depth-clear
  // compositing, then the pipeline reads from it for bloom + tonemapping.
  const rt = useMemo(() => {
    const dpr = gl.getPixelRatio();
    return new RenderTarget(
      Math.floor(size.width * dpr),
      Math.floor(size.height * dpr),
      { type: HalfFloatType, depthBuffer: true }
    );
  }, [gl, size.width, size.height]);

  useEffect(() => () => { rt.dispose(); }, [rt]);

  // Phase-1.5 atmosphere target — see ATMOSPHERE_PASS_ENABLED. Same format as
  // `rt` (HDR + depth, full DPR). The atmosphere pass reads `rt` and writes
  // here; the cloud composite + local scene + post pipeline then target `rtB`.
  // Null when the pass is disabled → the renderer keeps targeting `rt`.
  const rtB = useMemo(() => {
    if (!ATMOSPHERE_PASS_ENABLED) return null;
    const dpr = gl.getPixelRatio();
    return new RenderTarget(
      Math.floor(size.width * dpr),
      Math.floor(size.height * dpr),
      { type: HalfFloatType, depthBuffer: true }
    );
  }, [gl, size.width, size.height]);

  useEffect(() => () => { rtB?.dispose(); }, [rtB]);

  // Static atmosphere LUTs (transmittance, multiple-scattering). These are now a
  // PROCESS-LIFETIME SINGLETON (getAtmosphereLUTs) shared with the cloud marcher,
  // which binds the transmittance LUT for per-sample sun colour (Phase 3). No
  // dispose: the singleton outlives SpaceRenderer remounts (the cloud pipeline
  // holds the same texture), and the LUTs stay baked across a remount. Fixed
  // size; LinearFilter + ClampToEdge + no mipmaps (RenderTarget defaults) is
  // exactly what the LUT samplers need.
  const atmosphereLUTs = useMemo(
    () => (ATMOSPHERE_PASS_ENABLED ? getAtmosphereLUTs() : null),
    [],
  );

  // The scattering pass, bound to the current `rt.texture` (background) + the LUT
  // RTs. Rebuilt (old one disposed) when `rt` is recreated on resize, mirroring
  // the composite-mesh pattern — textures are bound at build time, never
  // reassigned (the WebGPU bind-group cache doesn't reliably honour that). The
  // LUT RTs persist across resize, so their baked content stays valid.
  const atmospherePass = useMemo(
    () =>
      ATMOSPHERE_PASS_ENABLED && atmosphereLUTs
        ? setupAtmospherePass(
            rt.texture,
            atmosphereLUTs.transmittance,
            atmosphereLUTs.multiScatter,
            // Full-res drawing-buffer size; the pass derives its own reduced-res
            // aerial-perspective target from it (AP_RES_SCALE). Same expression
            // `rt` is sized with, and `rt` is in the dep list, so a resize
            // rebuilds both together.
            Math.floor(size.width * gl.getPixelRatio()),
            Math.floor(size.height * gl.getPixelRatio()),
          )
        : null,
    [rt, atmosphereLUTs, gl, size.width, size.height]
  );
  useEffect(() => () => { atmospherePass?.dispose(); }, [atmospherePass]);

  // Identity of the atmosphere the LUTs were last baked for. Reset whenever the
  // pass or LUTs are rebuilt so a one-shot rebake re-runs (idempotent).
  const bakedAtmosphereId = useRef<string | null>(null);
  // Re-bake when a diagnostic dial changes, not only when the body changes —
  // see invalidateAtmosphereLUTs() in atmospherePass.ts.
  const bakedLutEpoch = useRef(-1);
  // Reset only when the LUT RTs are recreated (their GPU content is lost) — NOT
  // on a pass rebuild from resize, which keeps the baked LUTs valid.
  useEffect(() => {
    bakedAtmosphereId.current = null;
  }, [atmosphereLUTs]);

  // Phase D RT layout — two pairs:
  //
  //   sparseCloudRts: MRT pair, each W/SPARSE_DIVISOR × H/SPARSE_DIVISOR with
  //     TWO color attachments (count: 2):
  //       textures[0] = cloud colour RGBA16F (premultiplied)
  //       textures[1] = tFront cloud-front depth (scaled-world units in .r,
  //                     sentinel < 0 = no hit)
  //     The marcher (pass 2a) marches the volume ONCE and writes both via
  //     `outputStruct(rgba, vec4(tFront,…))`. This replaced a separate depth
  //     pass that re-ran the marcher for tFront only (that pass was cheap —
  //     the compiler dead-code-eliminated the lighting/cone-march that only
  //     feeds colour — so the merge saved ~25-30%, not 2×).
  //     Ping-pong only because the reconstruction pass reads it the same frame.
  //
  //   historyRts: cloud-DPR RGBA16F (= sparse × SPARSE_DIVISOR). Pass 2c
  //     (reconstruction) writes the final per-pixel cloud colour here; the
  //     off-parity is read back next frame as previous-frame history. Composite
  //     (pass 3) reads this RT and bilinearly upsamples it to the full-DPR scene
  //     RT (premul-alpha blend). Both this and the sparse RT use CLOUD_MAX_DPR.
  //
  // Both attachments default to RGBA16F (HalfFloatType); textures[1] only uses
  // .r but the extra channels at sparse res are negligible VRAM.
  const sparseCloudRts = useMemo(() => {
    const dpr = Math.min(gl.getPixelRatio(), CLOUD_MAX_DPR);
    const w = Math.max(1, Math.floor(size.width * dpr / SPARSE_DIVISOR));
    const h = Math.max(1, Math.floor(size.height * dpr / SPARSE_DIVISOR));
    const make = () => {
      const rt = new RenderTarget(w, h, {
        type: HalfFloatType,
        depthBuffer: false,
        count: 2,
      });
      rt.textures[0].name = "cloudColor";
      rt.textures[1].name = "cloudDepth";
      return rt;
    };
    return [make(), make()] as const;
  }, [gl, size.width, size.height]);

  const historyRts = useMemo(() => {
    // Cloud reconstruction runs at the clamped cloud DPR (must match the sparse
    // RT's DPR for the Bayer tile mapping). The composite upsamples this to the
    // full-DPR scene RT.
    const dpr = Math.min(gl.getPixelRatio(), CLOUD_MAX_DPR);
    const w = Math.max(1, Math.floor(size.width * dpr));
    const h = Math.max(1, Math.floor(size.height * dpr));
    return [
      new RenderTarget(w, h, { type: HalfFloatType, depthBuffer: false }),
      new RenderTarget(w, h, { type: HalfFloatType, depthBuffer: false }),
    ] as const;
  }, [gl, size.width, size.height]);

  useEffect(() => () => {
    sparseCloudRts[0].dispose();
    sparseCloudRts[1].dispose();
  }, [sparseCloudRts]);
  useEffect(() => () => {
    historyRts[0].dispose();
    historyRts[1].dispose();
  }, [historyRts]);

  // Composite meshes: read from the cloud-DPR historyRts (the reconstruction
  // output) and premul-alpha blend onto the full-DPR main scene RT (bilinear
  // upsample when CLOUD_MAX_DPR < device DPR). The fetch is a small binomial-
  // Gaussian gather (CLOUD_DENOISE_RADIUS) — a spatial denoise that removes the
  // per-pixel salt-and-pepper the reconstruction leaves behind. See
  // buildCompositeFetch + its header for the why.
  // Pre-built pair so the per-frame parity swap is just a parent/child
  // mutation (avoids TextureNode `.value` reassignment, which the WebGPU
  // backend's bind-group cache doesn't always honour mid-frame).
  const compositeMeshes = useMemo(() => {
    const make = (rt: RenderTarget, sparseRt: RenderTarget) => {
      const mat = new NodeMaterial();
      mat.transparent = true;
      mat.depthTest = false;
      mat.depthWrite = false;
      mat.blending = THREE.CustomBlending;
      mat.blendSrc = THREE.OneFactor;
      mat.blendDst = THREE.OneMinusSrcAlphaFactor;
      mat.blendSrcAlpha = THREE.OneFactor;
      mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
      // Pair each history RT with its frame's sparse RT (its textures[1] = tFront,
      // its dims = the AP fog-depth gather step) so the AP fog samples the froxel
      // at the cloud-front depth (Phase 4 step 2).
      mat.fragmentNode = buildCompositeFetch(rt, sparseRt);
      return new THREE.Mesh(compositeGeometry, mat);
    };
    return [
      make(historyRts[0], sparseCloudRts[0]),
      make(historyRts[1], sparseCloudRts[1]),
    ] as const;
  }, [historyRts, sparseCloudRts]);

  useEffect(() => () => {
    for (const mesh of compositeMeshes) {
      (mesh.material as NodeMaterial).dispose();
    }
  }, [compositeMeshes]);

  // RenderPipeline (replaces the old EffectComposer)
  const pipeline = useMemo(
    () => new RenderPipeline(gl as unknown as WebGPURenderer),
    [gl]
  );
  const pipelineRef = useRef(pipeline);
  pipelineRef.current = pipeline;

  // Rebuild the node graph when bloom / toneMapping / RT changes
  useEffect(() => {
    // Post pipeline reads the final composited target: `rtB` when the
    // atmosphere pass routes through it, otherwise `rt`.
    const sceneRt = rtB ?? rt;
    const sceneTexture = texture(sceneRt.texture);

    // ── EXPOSURE (docs/LIGHTING_PLAN.md §3.4) ──
    // The single global exposure multiply, taking the scene from its physical
    // luminance scale (1 game unit ≈ 6,038 cd/m²) into the tonemapper's domain.
    // Phase 0 pins it at 1.0, so this is a bit-exact no-op; Phase 1 hangs a
    // manual EV slider off it and Phase 5 the auto-exposure histogram.
    //
    // Applied BEFORE bloom deliberately: bloom's threshold (1.0) is a
    // display-referred "brighter than white" test, so it has to see
    // post-exposure values or it means something different at every exposure.
    //
    // NOT done via `renderer.toneMappingExposure` — three's ToneMappingNode
    // defaults its exposure to a renderer reference for that property, so using
    // it would apply exposure AFTER bloom (wrong side of the threshold) and risk
    // double-counting. Left at its default 1.0; `uExposure` is the one hook.
    // `uPostExposure` = exposure / preExposure (photometry.ts). Before D25 went
    // live that is just the exposure; with pre-exposure on it is ~1.0, because
    // the buffer already carries the exposure the sources applied. Using the
    // ratio rather than either term means the two can never double-count.
    const exposed = sceneTexture.mul(uPostExposure);

    // Bloom is added in linear HDR (pre-tonemap), as before.
    let hdr: typeof pipeline.outputNode = exposed;
    if (settings.bloom) {
      hdr = exposed.add(bloom(exposed, 0.001, 0, 1));
    }

    // Tone-map IN-GRAPH (the SAME call renderOutput() would make), then add an
    // output DITHER before the pipeline's sRGB encode + 8-bit write. This is the
    // Unreal/Frostbite fix for 8-bit banding on smooth gradients (the atmosphere
    // sky) — which the Sky-View LUT resolution work alone can't remove because the
    // raymarch sky bands at quantization too. TPDF (difference of two per-pixel
    // hashes) is flat, distortion-free dither; scaled to ~OUTPUT_DITHER_LSB.
    const toneMode = settings.toneMapping ? AgXToneMapping : NeutralToneMapping;
    const mapped = hdr.toneMapping(toneMode);
    const px = screenCoordinate;
    const dither = hash(px.x.add(px.y.mul(1000)))
      .sub(hash(px.y.add(px.x.mul(1000))))
      .mul(OUTPUT_DITHER_LSB / 255);
    pipeline.outputNode = OUTPUT_DITHER_LSB > 0 ? mapped.add(dither) : mapped;
    pipeline.needsUpdate = true;

    // Tonemapping is now done in-graph → the pipeline's renderOutput() must NOT
    // re-apply it (it still does the sRGB colour-space encode + 8-bit write).
    const renderer = gl as unknown as WebGPURenderer;
    renderer.toneMapping = NoToneMapping;

    return () => {
      pipeline.needsUpdate = true;
    };
  }, [settings.bloom, settings.toneMapping, pipeline, rt, rtB, gl]);

  // Camera setup
  useEffect(() => {
    localCamera.near = LOCAL_CAMERA_NEAR;
    localCamera.far = LOCAL_CAMERA_FAR;
    localCamera.updateProjectionMatrix();
  }, [localCamera]);

  useEffect(() => {
    scaledCamera.near = SCALED_CAMERA_NEAR;
    scaledCamera.far = SCALED_CAMERA_FAR;
    scaledCamera.fov = localCamera.fov;
    scaledCamera.aspect = size.width / size.height;
    scaledCamera.updateProjectionMatrix();
  }, [localCamera.fov, scaledCamera, size.height, size.width]);

  // Cleanup
  useEffect(() => () => { pipeline.dispose(); }, [pipeline]);

  // Drop the __lum probe target on unmount so the harness reports "no scene"
  // rather than reading a disposed RenderTarget.
  useEffect(() => () => clearLumSource(), []);

  // Exposure compensation (Settings → Dev). Human-rate, so an effect is right —
  // this must NOT go in useFrame. Composes with the metered exposure inside
  // photometry.ts, so Phase 5's auto-exposure will not clobber it.
  useEffect(() => {
    setExposureCompensation(settings.exposureStops ?? 0);
  }, [settings.exposureStops]);

  const firstFrameLogged = useRef(false);
  // Ping-pong index: this frame writes cloudRts[frameParity], next frame
  // writes the other. compositeScene gets the matching mesh swapped in.
  const frameParity = useRef(0);
  const mountedCompositeMesh = useRef<THREE.Mesh | null>(null);
  // Phase D2: monotonic frame counter (mod BAYER.length) drives the Bayer
  // schedule lookup. Distinct from frameParity (which is just 2-state).
  // Also drives the STBN frame-slice uniform in the cloud pipeline
  // (advanced by 1/STBN_PERIOD_Z per frame inside setupCloudPipeline).
  const cloudFrameIndex = useRef(0);
  // Phase D3: previous frame's combined view-projection matrix in scaled
  // world space, snapshotted at end of frame. Identity on the first frame.
  const prevCloudViewProj = useRef(new THREE.Matrix4());
  // Phase D3+: previous frame's world origin (km). Used together with
  // prevCloudViewProj to express this frame's reprojection target in the
  // *previous* frame's scaled coordinate system. Without this, the
  // floating origin (which slides every frame in Spaceship.tsx) introduces
  // a velocity-proportional offset in the history sample UV.
  // `hasPrevWorldOrigin` is false on the very first render and is also
  // reset whenever we choose to invalidate history mid-session.
  const prevWorldOriginKm = useRef(new THREE.Vector3());
  const hasPrevWorldOrigin = useRef(false);
  // Phase D6: history-validity flag passed to the cloud pass each frame.
  // Starts at 0 so the first cloud render outputs only the new sample
  // (history is uninitialised). Flips to 1 after one full cycle. Reset to
  // 0 whenever the RT pair is recreated (resize) — the new RT may share
  // memory with a torn-down one but its content is undefined.
  const cloudHistoryValid = useRef(0);
  // How many history RTs have been cleared since the cloud pipeline went
  // inactive (blend = 0). Both ping-pong RTs must be cleared (two frames)
  // before the per-frame clear AND the composite pass can be skipped — the
  // orbit path otherwise pays a full-DPR fullscreen gather every frame to
  // blend zeros. Reset when the pipeline resumes or the RTs are recreated
  // (fresh RT content is undefined and must be cleared before skipping).
  const clearedHistoryCount = useRef(0);
  useEffect(() => {
    cloudHistoryValid.current = 0;
    hasPrevWorldOrigin.current = false;
    clearedHistoryCount.current = 0;
  }, [historyRts, sparseCloudRts]);

  useFrame((_state, delta) => {
    // Skip until WebGPU backend is ready (init is async).
    if (!(gl as unknown as WebGPURenderer).initialized) return;

    const renderer = gl as unknown as WebGPURenderer;
    perf.markRenderStart();

    // ── D25: pick this frame's SOURCE PRE-EXPOSURE, before anything renders ───
    // Must be the first thing in the frame: every radiance source multiplies by
    // it, and a frame where some sources used the old value is an internally
    // inconsistent image. See photometry.ts's setPreExposure note.
    updatePreExposureForFrame();
    // Plain (non-TSL) emissive materials can't read a uniform — rescale them from
    // their authored colours now that this frame's factor is chosen.
    updatePreExposedEmissives();

    // ── Per-frame renderer bookkeeping ──────────────────────────────────────
    // Scene.tsx calls `_animation.stop()` because R3F owns the frame loop, so
    // four things that loop did (three.js `Renderer._animation.start()`) have to
    // happen here. Only `nodeFrame.update()` was being done. Without the rest:
    // `info.render.{drawCalls,frameCalls,triangles}` accumulate for the whole
    // session (any readout of them is meaningless), `info.frame` stays pinned at
    // 0, and the inspector hook that carries GPU timestamps never fires. Order
    // below matches three's loop exactly.
    if (renderer.info.autoReset) renderer.info.reset();
    // _nodes is a private renderer field; the public animation loop (which
    // normally advances nodeFrame) is stopped because R3F owns the frame loop.
    const nodeFrame = (
      renderer as unknown as {
        _nodes: { nodeFrame: { update: () => void; frameId: number } };
      }
    )._nodes.nodeFrame;
    // Advance the node frame so BloomNode's updateBefore runs each frame.
    nodeFrame.update();
    // `info.frame` is readonly in the typings because the renderer's own loop
    // normally owns it. It is baked into every timestamp-query UID (`…:f<frame>`)
    // which the inspector matches against its per-frame records — leave it at 0
    // and per-pass GPU timings never resolve.
    (renderer.info as unknown as { frame: number }).frame = nodeFrame.frameId;
    // No-op unless a profiling inspector is installed (perf/perfProfiler.ts).
    renderer.inspector.begin();

    if (!firstFrameLogged.current) {
      firstFrameLogged.current = true;
      performance.mark("first-frame-render");
      console.log(
        "[perf] First frame render",
        performance.now().toFixed(0) + "ms",
      );
    }

    // Warm the static cloud-noise bake at startup (off the near-tier crossing):
    // the ~150 ms compute-pipeline compile + bake run async, off the main
    // thread, so flying into the near tier never hitches. Idempotent no-op once
    // warmed. (flushCloudBakes below is the sync safety net.)
    warmCloudBakes(renderer);
    // Drain any pending cloud bakes EVERY frame, unconditionally (not just when
    // clouds are visible). The shell's expected-opacity LUT is queued lazily
    // when Earth enters its tier — long before the volumetric-cloud pipeline
    // becomes visible — so the gated flushCloudBakes deeper in the frame would
    // leave the LUT undispatched (zero-filled → invisible shell) until near the
    // surface. This unconditional drain dispatches it from orbit. No-op once the
    // queue is empty; the tiny 256×1 LUT compile is negligible.
    flushCloudBakes(renderer);

    // Sync scaled camera with local camera
    tempScaledPos
      .copy(localCamera.position)
      .multiplyScalar(LOCAL_TO_SCALED_FROM_LOCAL_UNITS);
    scaledCamera.position.copy(tempScaledPos);
    scaledCamera.quaternion.copy(localCamera.quaternion);

    // ── Render both scenes into the offscreen RT in linear HDR ──
    // Disable tone mapping so HDR values stay above 1.0 for bloom threshold.
    // RenderPipeline applies tone mapping + color space at the end.
    const savedToneMapping = renderer.toneMapping;
    const savedColorSpace = renderer.outputColorSpace;
    renderer.toneMapping = NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

    // Pre-pass: pick the nearest atmosphere-bearing body and BAKE its static
    // LUTs BEFORE Pass 1. The planet-surface shader (Pass 1) now samples the
    // transmittance LUT for physical sun colour (Phase 3b), and the cloud
    // marcher samples it too, so it MUST be baked first. The bake is a one-shot
    // into separate LUT RTs (gated by bakedAtmosphereId); setAtmosphere runs
    // every frame (a window resize rebuilds the pass with zero-valued uniforms,
    // and the bake-id gate would otherwise skip re-supplying its coefficients →
    // invisible atmosphere until reload; the LUT RTs persist so no rebake). The
    // atmosphere MARCH still runs in Pass 1.5 (it reads `rt`).
    const dominant = atmospherePass ? getDominantAtmosphereBody() : null;
    frameGates.body = dominant ? dominant.id : null;
    frameGates.distanceKm = dominant ? dominant.distanceKm : 0;
    frameGates.altitudeKm = dominant
      ? dominant.distanceKm - dominant.params.groundRadiusKm
      : 0;
    frameGates.bsmBaked = false;
    frameGates.froxelBaked = false;
    frameGates.skyViewBaked = false;
    if (atmospherePass && dominant) {
      atmospherePass.setAtmosphere(dominant.params);
      const lutEpoch = getAtmosphereLutEpoch();
      if (bakedAtmosphereId.current !== dominant.id || bakedLutEpoch.current !== lutEpoch) {
        bakedLutEpoch.current = lutEpoch;
        atmospherePass.bakeLUTs(renderer);
        bakedAtmosphereId.current = dominant.id;
      }
    }

    // Pass 1: scaled scene — planets, skybox, stars. Layer 0 only; the cloud
    // anchor mesh sits on CLOUD_LAYER (which no camera enables) and never
    // renders. It exists only as a matrixWorld provider for the fullscreen
    // pass below.
    scaledCamera.layers.enable(0);
    renderer.setRenderTarget(rt);
    gl.autoClear = true;
    gl.render(scaledScene, scaledCamera);

    // Pass 1.5: atmospheric scattering march (rt → rtB). With no body in range
    // the pass runs as a passthrough copy (uActive=0).
    if (atmospherePass && rtB) {
      atmospherePass.updateUniforms({ scaledCamera, dominant });
      // Cloud Beer Shadow Map (docs/CLOUD_SHADOWS_GODRAYS_PLAN.md L0). Bake
      // BEFORE the froxel/sky-view/main pass so those consumers read a fresh
      // map on the same GPU queue. Gated to the near-tier pipeline being mounted
      // (its shared density uniforms/textures back the bake) + low altitude (the
      // consumers are the atmosphere pass, which needs it only below the deck).
      // Runs OUTSIDE the cloudsVisible block on purpose — the marcher is skipped
      // above ~700 km but ground shadows/god rays still apply there. The base
      // noise volume is warm-baked at startup + drained by flushCloudBakes above,
      // so it is valid here regardless of altitude.
      let bsmStrength = 0;
      // BSM_ABLATE_DIAGNOSTIC short-circuits the bake AND leaves strength at 0, which
      // closes the consumer gates too — see its declaration.
      if (dominant && !BSM_ABLATE_DIAGNOSTIC) {
        const bsmPipeline = getActiveCloudPipeline();
        const bsmEarth = bsmPipeline ? getEarthMatrixWorldRef() : null;
        const bsmAltKm =
          dominant.distanceKm - dominant.params.groundRadiusKm;
        if (
          bsmPipeline &&
          bsmEarth &&
          bsmPipeline.hasCloudShadowMap() &&
          bsmAltKm < BSM_MAX_ALT_KM
        ) {
          bsmPipeline.updateCloudShadowMap(scaledCamera.position, bsmEarth);
          // The bake now caches itself and re-runs only when a bake input actually
          // changes (see cloudShadowMap.ts' bake-cache note) — worth 1.7–2.4 ms,
          // because with a static cloud field and a static sun it was redrawing a
          // bit-identical map every frame. Force it while the noise volumes are
          // still settling so a half-built field can never be cached as final.
          bsmPipeline.bakeCloudShadowMap(renderer, hasPendingCloudBakes());
          frameGates.bsmBaked = true;
          // Consumer freshness gate: full below the fade band, ramp to 0 over
          // the top BSM_FADE_BAND_KM so ground shadows don't pop off at the
          // altitude ceiling (above it the bake is skipped → stale map).
          bsmStrength =
            1 -
            THREE.MathUtils.smoothstep(
              bsmAltKm,
              BSM_MAX_ALT_KM - BSM_FADE_BAND_KM,
              BSM_MAX_ALT_KM,
            );
        }
      }
      // Set every frame (0 when not baked) so a stale map never shadows.
      if (BSM_CONSUMERS_ABLATE_DIAGNOSTIC) bsmStrength = 0;
      setCloudShadowStrength(bsmStrength);
      frameGates.bsmStrength = bsmStrength;
      // Phase 4: bake the aerial-perspective froxel for this frame (needs the
      // camera/sun uniforms just set + the LUTs baked in the pre-pass). Cheap
      // 32³ compute. FROXEL_ENABLED gates the dispatch out entirely unless a
      // consumer exists (the 'froxel' debug viz, or the cloud AP). Also gated to
      // low altitude — the froxel's consumer is the volumetric clouds, which
      // only render below ~3000 km, so baking it at orbit is wasted.
      if (
        dominant &&
        FROXEL_ENABLED &&
        dominant.distanceKm - dominant.params.groundRadiusKm <
          FROXEL_BAKE_MAX_ALT_KM
      ) {
        atmospherePass.bakeFroxel(renderer);
        frameGates.froxelBaked = true;
      }
      // Phase 4: bake the Sky-View LUT for this frame (same prerequisites). The
      // main pass samples it for sky rays below the crossfade altitude; above
      // SKYVIEW_BAKE_MAX_ALT_KM the crossfade is fully in march mode (blend=1),
      // so skip the bake there. Gated by SKYVIEW_ENABLED → zero cost when off.
      if (
        dominant &&
        SKYVIEW_ENABLED &&
        dominant.distanceKm - dominant.params.groundRadiusKm <
          SKYVIEW_BAKE_MAX_ALT_KM
      ) {
        atmospherePass.bakeSkyView(renderer);
        frameGates.skyViewBaked = true;
      }
      // Pass 1.5 + 1.6: march aerial perspective at AP_RES_SCALE, then apply it
      // to the full-res scene. Owns its own intermediate target and restores
      // setRenderTarget(null) — the next pass sets its own.
      //
      // The two halves belong together: splitting them to put the cloud pipeline
      // between the AP write and its read was measured on 2026-08-11 and made
      // every scenario 0.3–0.7 ms slower. See atmospherePass.ts `render`.
      atmospherePass.render(renderer, rtB);
    }

    // Phase 2 light coupling: compute the sun transmittance + sky-ambient fill
    // for the LOCAL scene (ship/asteroids) from the camera's position relative
    // to the dominant body. Read next frame by SunLight + AtmosphereSkyLight
    // (priority-0 useFrames run before this priority-1 one — a 1-frame lag that
    // is imperceptible for slowly-varying lighting). The sun DISK is not tinted
    // here: the main pass already reddens it via the view-ray throughput.
    if (dominant) {
      tempCamPlanetKm
        .copy(scaledCamera.position)
        .sub(dominant.centerScaled)
        .multiplyScalar(1 / SCALED_UNITS_PER_KM);
      computeAtmosphereLighting(
        tempCamPlanetKm,
        dominant.sunDir,
        dominant.params,
        dominant.rings,
      );
    } else {
      clearAtmosphereLighting();
    }
    // Target for all subsequent compositing (cloud composite, local scene) and
    // the post pipeline's input.
    const finalTarget = rtB ?? rt;

    // ── Phase D cloud pipeline: pass 2a (sparse color) → 2b (sparse depth)
    // → 2c (full-res reconstruction) → pass 3 (composite onto main RT). ──
    //
    // Premul-alpha clear (0,0,0,0) on the sparse color RT: non-zero clear
    // alpha would bleed the clear colour into cloud fringes during the
    // reconstruction's variance-clamp neighbourhood read.
    gl.getClearColor(tempClearColor);
    const savedClearAlpha = gl.getClearAlpha();
    gl.setClearColor(0x000000, 0);

    const writeIdx = frameParity.current;
    const sparseColorRt = sparseCloudRts[writeIdx];
    const historyWriteRt = historyRts[writeIdx];
    const historyReadRt = historyRts[writeIdx ^ 1];
    const writeCompositeMesh = compositeMeshes[writeIdx];

    const pipelineHandle = getActiveCloudPipeline();
    const earthMesh = pipelineHandle ? getEarthMatrixWorldRef() : null;

    // Skip the ENTIRE cloud pipeline (light-volume bake + sparse marcher +
    // reconstruction) while the volumetric crossfade sits at 0 — above the
    // blend-in altitude the flat 2D overlay carries the whole cloud cover and
    // the marcher's output would be multiplied to nothing anyway. This is the
    // main orbit-perf lever: the near-tier shell mounts at 35 k km distance,
    // but the volumetric only becomes visually meaningful far lower (see the
    // altitude-based crossfade in earth.ts onFrame); previously the full-cost
    // march ran across that whole range for an invisible result.
    const cloudsVisible =
      !!pipelineHandle && pipelineHandle.getVolumetricBlend() > 0.001;
    frameGates.volumetricBlend = pipelineHandle
      ? pipelineHandle.getVolumetricBlend()
      : 0;
    frameGates.cloudsVisible = cloudsVisible;
    frameGates.lightVolume = USE_LIGHT_VOLUME && cloudsVisible;

    if (pipelineHandle && earthMesh && cloudsVisible) {
      clearedHistoryCount.current = 0;
      // Bayer schedule pick for this frame. Sub-pixel slot (0..N-1, 0..N-1)
      // marks which full-res pixel within every N×N tile is fresh this frame.
      const bayerIdx = cloudFrameIndex.current % BAYER.length;
      const [bx, by] = BAYER[bayerIdx];
      tempBayerSub.set(bx, by);

      // Full-res / sparse RT dims for the reconstruction pass's UV math.
      tempFullSize.set(historyWriteRt.width, historyWriteRt.height);
      tempSparseSize.set(sparseColorRt.width, sparseColorRt.height);

      // Origin shift = (currentOriginKm − prevOriginKm) × SCALED_UNITS_PER_KM.
      // First frame after mount / resize → no prev origin; zero the shift
      // (history is invalid this frame anyway via cloudHistoryValid).
      if (hasPrevWorldOrigin.current) {
        tempOriginShiftScaled
          .copy(worldOrigin.worldOriginKm)
          .sub(prevWorldOriginKm.current)
          .multiplyScalar(SCALED_UNITS_PER_KM);
      } else {
        tempOriginShiftScaled.set(0, 0, 0);
      }

      // Phase 3 cloud↔atmosphere coupling: feed the dominant body's geometry
      // (scaled units, matching the marcher's earth-space r), unified sun
      // illuminance, and sky tint so the marcher lights clouds with the SAME
      // transmittance LUT the sky + ship use. dominant is Earth whenever clouds
      // are visible (they only render near an atmosphere body); guarded anyway.
      let atmoBottomRadiusScaled: number | undefined;
      let atmoTopRadiusScaled: number | undefined;
      let atmoHScaled: number | undefined;
      let atmoSunIlluminance: THREE.Vector3 | undefined;
      let atmoSkyColor: THREE.Color | undefined;
      if (dominant) {
        const rg = dominant.params.groundRadiusKm;
        const rt = rg + dominant.params.atmosphereHeightKm;
        atmoBottomRadiusScaled = rg * SCALED_UNITS_PER_KM;
        atmoTopRadiusScaled = rt * SCALED_UNITS_PER_KM;
        atmoHScaled =
          Math.sqrt(Math.max(0, rt * rt - rg * rg)) * SCALED_UNITS_PER_KM;
        // Per-frame illuminance off the record, NOT the static params (D17).
        atmoSunIlluminance = tempAtmoSunIll.copy(dominant.sunIlluminance);
        atmoSkyColor = getAtmosphereLighting().skyColor;
      }

      // One uniform-update call distributes state to both pass materials
      // (color MRT marcher, reconstruction). The two sparse inputs to
      // reconstruction are the two color attachments of the single MRT RT.
      pipelineHandle.updateUniforms({
        scaledCamera,
        earthMesh,
        bayerSubPixel: tempBayerSub,
        prevViewProj: prevCloudViewProj.current,
        originShiftScaled: tempOriginShiftScaled,
        sparseColorTexture: sparseColorRt.textures[0],
        sparseDepthTexture: sparseColorRt.textures[1],
        historyTexture: historyReadRt.texture,
        historyValid: cloudHistoryValid.current,
        frameIndex: cloudFrameIndex.current,
        fullSize: tempFullSize,
        sparseSize: tempSparseSize,
        atmoBottomRadiusScaled,
        atmoTopRadiusScaled,
        atmoHScaled,
        atmoSunIlluminance,
        atmoSkyColor,
      });

      // Pass 2-pre0: one-shot GPU bake of the base cloud noise volume. MUST
      // precede BOTH the light-volume bake (which samples the base) and the
      // marcher draw, so the storage texture is fully written before any read.
      // No-op once baked / until the device is ready.
      flushCloudBakes(renderer);

      // Pass 2-pre: bake the per-voxel sun-transmittance light volume (a
      // compute pass over an earth-local box). MUST precede pass 2a so the
      // colour marcher reads a fully-written volume — renderer.compute() submits
      // its work to the GPU queue ahead of pass 2a's draw, so the same-frame
      // read is ordered. No-op when USE_LIGHT_VOLUME is false.
      if (USE_LIGHT_VOLUME) {
        pipelineHandle.computeLightVolume(renderer);
      }

      // Pass 2a: sparse color+depth marcher (MRT, ¼-res). One march writes
      // both attachments — textures[0] = colour, textures[1].r = tFront.
      renderer.setRenderTarget(sparseColorRt);
      gl.autoClear = true;
      gl.render(pipelineHandle.colorScene, pipelineHandle.colorCamera);

      // Pass 2c: full-res reconstruction. Reads both sparse attachments +
      // historyReadRt, writes historyWriteRt (full-res RGBA16F).
      renderer.setRenderTarget(historyWriteRt);
      gl.autoClear = true;
      gl.render(
        pipelineHandle.reconstructionScene,
        pipelineHandle.reconstructionCamera,
      );

      cloudHistoryValid.current = 1;
    } else {
      // No active pipeline (Earth not yet mounted, player out of near range,
      // or volumetric blend at 0 — camera too high for volumetric clouds).
      // Clear the full-res history RT to fully transparent so the
      // composite contributes nothing. Also invalidate history for next
      // time the pipeline resumes — its off-parity RT may have been
      // cleared here, and blending against (0,0,0,0) would briefly erase
      // the cloud. Each ping-pong RT only needs clearing ONCE (two
      // consecutive frames); after that both the clear and the composite
      // pass are skipped until the pipeline resumes.
      if (clearedHistoryCount.current < 2) {
        renderer.setRenderTarget(historyWriteRt);
        gl.autoClear = true;
        gl.clear();
        clearedHistoryCount.current += 1;
      }
      cloudHistoryValid.current = 0;
      hasPrevWorldOrigin.current = false;
    }

    gl.setClearColor(tempClearColor, savedClearAlpha);

    // Pass 3: composite the just-reconstructed full-res cloud RT → main rt
    // with premul-alpha blend. Swap which mesh sits in compositeScene to
    // match the historyRt we just wrote (each mesh's TextureNode is bound
    // to one specific RT at compile time). Skipped once the pipeline is
    // inactive AND both history RTs are cleared — the pass would blend
    // all-zero pixels at full-DPR gather cost (25 denoise + 9 AP-depth taps
    // per pixel) for no visible result. Pass 4 below still needs the target
    // + autoClear state, so those are set unconditionally.
    renderer.setRenderTarget(finalTarget);
    gl.autoClear = false;
    if (cloudsVisible || clearedHistoryCount.current < 2) {
      if (mountedCompositeMesh.current !== writeCompositeMesh) {
        if (mountedCompositeMesh.current) {
          compositeScene.remove(mountedCompositeMesh.current);
        }
        compositeScene.add(writeCompositeMesh);
        mountedCompositeMesh.current = writeCompositeMesh;
      }
      gl.render(compositeScene, compositeCamera);
    }

    // Pass 4: local scene (ship, asteroids, beam, lights) — clear depth only,
    // draw on top. This naturally composites local content over the scaled
    // background, including objects that don't write depth.
    gl.clearDepth();
    gl.render(localScene, localCamera);

    renderer.setRenderTarget(null);

    // Restore so the RenderPipeline picks them up for its renderOutput() pass
    renderer.toneMapping = savedToneMapping;
    renderer.outputColorSpace = savedColorSpace;

    // Publish the final PRE-TONEMAP target for `__lum` (photometric probing).
    // Must be here — after everything has composited into it, before the post
    // chain applies exposure/bloom/tonemapping — because game units only exist
    // on this side of the tone curve. Two reference writes; no-op when unchanged.
    // `scaledCamera` rides along so `__lum.disc()` can turn a body's angular
    // radius into a pixel radius analytically, instead of thresholding on
    // luminance (which would let the atmosphere's halo inflate the footprint).
    setLumSource(renderer, rtB ?? rt, scaledCamera);

    // ── Phase 5: auto-exposure / eye adaptation ──────────────────────────────
    // Meters the SAME pre-exposure buffer `__lum` probes — it must be this side
    // of the tone chain or metering becomes a feedback loop on its own output.
    // No-ops while exposure is pinned (`__lum`, `__bench`). Fire-and-forget
    // readback; never stalls the pipeline.
    //
    // ⚠ This DOES include the player's own vehicle (defect D26). Excluding it by
    // splitting the local pass on a layer was tried and REVERTED — see the D26
    // section in docs/LIGHTING_PLAN.md. Short version: three.js layers gate
    // light↔object interaction, so it un-lit the ship, and excluding the ship
    // only moved the problem to a blown exhaust. The root cause is that the
    // emissives are not on the photometric scale.
    updateExposureMeter(renderer, (rtB ?? rt).texture, delta);
    // ── Apply postprocessing (bloom, tonemapping) and blit to canvas ──
    pipelineRef.current.render();

    // Advance the ping-pong parity so next frame writes the *other* history
    // RT (and reads this one back as history input).
    frameParity.current ^= 1;
    // Free-running frame counter. It drives TWO independent cycles, each via
    // its own modulo at the use site:
    //   • Bayer sub-pixel:  cloudFrameIndex % BAYER.length   (4)
    //   • STBN time slice:  cloudFrameIndex % STBN_FRAME_MODULUS (63)
    // Wrap at lcm = BAYER.length × STBN_FRAME_MODULUS so BOTH stay periodic and
    // every (sub-pixel, slice) pair is visited. CRITICAL: previously this wrapped
    // at BAYER.length (4), which starved the STBN slice to 4 of 63 values → near-
    // zero temporal decorrelation → the marcher's per-sample jitter never
    // averaged out → static sampling-shell bands. (Regression from BAYER 16→4.)
    cloudFrameIndex.current =
      (cloudFrameIndex.current + 1) % (BAYER.length * STBN_FRAME_MODULUS);

    // Phase D3: snapshot this frame's combined view-projection in scaled
    // space. Next frame this becomes `uPrevViewProj` and lets the shader
    // compute the previous-frame UV for the world point each pixel sampled.
    // matrixWorldInverse was updated by `gl.render(scaledScene, scaledCamera)`
    // above, so it's current as of this frame.
    tempViewProj.multiplyMatrices(
      scaledCamera.projectionMatrix,
      scaledCamera.matrixWorldInverse,
    );
    prevCloudViewProj.current.copy(tempViewProj);
    // Snapshot the world origin alongside the VP matrix — both describe
    // *this* frame's scaled coordinate system, and reprojection next frame
    // needs both to be consistent. (Spaceship.tsx mutates worldOriginKm
    // before each render frame, so the value we read here is the one the
    // scaled scene was just rendered with.)
    prevWorldOriginKm.current.copy(worldOrigin.worldOriginKm);
    hasPrevWorldOrigin.current = true;

    // ── Close the profiling frame ───────────────────────────────────────────
    // Counters are read here because info.reset() at the top of this frame
    // zeroed them — they now describe THIS frame only. `finish()` is what makes
    // the inspector resolve this frame's GPU timestamps (a no-op without a
    // profiling inspector installed).
    perf.setCounters({
      drawCalls: renderer.info.render.drawCalls,
      triangles: renderer.info.render.triangles,
      renderCalls: renderer.info.render.frameCalls,
      computeCalls: renderer.info.compute.frameCalls,
      // Live resident-resource counts (NOT per-frame). These are how a benchmark
      // detects that a previous flight left another body's LOD tier loaded — see
      // PerfSnapshot.counters.
      textures: renderer.info.memory.textures,
      geometries: renderer.info.memory.geometries,
    });
    perf.setGates(frameGates);
    renderer.inspector.finish();
    perf.markRenderEnd();
  }, 1);

  return (
    <>
      {createPortal(scaled, scaledScene)}
      {createPortal(local, localScene)}
    </>
  );
};

export default SpaceRenderer;
