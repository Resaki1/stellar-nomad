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
import {
  LOCAL_TO_SCALED_FROM_LOCAL_UNITS,
  SCALED_UNITS_PER_KM,
} from "@/sim/units";
import { useWorldOrigin } from "@/sim/worldOrigin";
import {
  HalfFloatType,
  NeutralToneMapping,
  NoToneMapping,
} from "three";
import { useAtomValue, useSetAtom } from "jotai/react";
import { advanceSimTimeAtom } from "@/store/simTime";
import { hdrCalibrationOpenAtom, settingsAtom } from "@/store/store";
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
import { localExposureNode, updateExposureMeter } from "./exposureMeter";
import {
  displayTransformNode,
  setDisplayCurveRebuildHook,
  setDisplayPeak,
} from "./displayTransform";
import { hdrCalibrationNode } from "./hdrCalibration";
import { isHdrCanvasActive } from "./hdrOutput";
import { scotopicNode } from "./scotopic";
import { glareNode, setGlareUserScale, updateGlare } from "./glarePass";
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
import {
  LOCAL_CAMERA_FAR,
  LOCAL_CAMERA_NEAR,
  SCALED_CAMERA_FAR,
  SCALED_CAMERA_NEAR,
} from "./cameraPlanes";

// Camera planes live in ./cameraPlanes so Star.tsx can share SCALED_CAMERA_FAR.

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
  // Phase 6d: the calibration wedge replaces the output node, so the post graph has to know.
  const calibrating = useAtomValue(hdrCalibrationOpenAtom);
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
  // compositing, then the pipeline reads from it for glare + tonemapping.
  // ── D14: MSAA, ON THIS TARGET ONLY ────────────────────────────────────────
  // The scene had no anti-aliasing of any kind (`antialias:false`, no TAA), which
  // the user reported as "planets look really pixelated at the edges until I get
  // pretty close". This is the fix, and the choice of MSAA over a post-process AA
  // is driven by what the content actually is.
  //
  // 🔑 WHY MSAA AND NOT FXAA/SMAA. A planet limb is a GEOMETRIC edge against black —
  // exactly what coverage supersampling solves exactly. And MSAA does not touch
  // shading, which matters here more than usual: the starfield is 1–2 px Gaussian
  // point sprites whose flux was calibrated to 0.999× (STAR_CATALOGUE_PLAN §8.3),
  // and FXAA's edge detector treats an isolated bright pixel as an edge and blurs
  // it. A post-process AA would quietly undo the star photometry.
  //
  // ⚠⚠ WHY ONLY `rt` AND NOT `rtB`. Geometry is drawn in TWO places: the scaled
  // scene into `rt` (planets, asteroids, stars, skybox) and the local scene into
  // `rtB` (the ship), with the atmosphere and cloud FULLSCREEN passes in between.
  // Multisampling `rtB` would make those fullscreen writes pay 4× coverage for
  // nothing — and they are the two most expensive passes in the frame. So the ship
  // stays aliased for now; it is small, close, and not what was reported. A
  // dedicated cheap AA for the local pass is the follow-up.
  //
  // three's WebGPU backend allocates a separate MSAA texture and resolves into the
  // primary, so `rt.texture` stays sampleable by the atmosphere pass unchanged.
  // ⚠⚠ `?? true` IS LOAD-BEARING, NOT DEFENSIVE. `settingsAtom` is an
  // `atomWithStorage`, which REPLACES the defaults with the persisted blob rather
  // than merging into them — so every setting added after a player's first run
  // arrives as `undefined` and its shipped default never applies. MEASURED on this
  // very change: a saved blob had no `antialias` key, so MSAA read as off and the
  // `antialias: true` default in store.ts did nothing. `exposureStops ?? 0` a few
  // lines down exists for the same reason; match it for every new key.
  const rtSamples = (settings.antialias ?? true) ? 4 : 0;
  const rt = useMemo(() => {
    const dpr = gl.getPixelRatio();
    return new RenderTarget(
      Math.floor(size.width * dpr),
      Math.floor(size.height * dpr),
      { type: HalfFloatType, depthBuffer: true, samples: rtSamples }
    );
  }, [gl, size.width, size.height, rtSamples]);

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
  // ONE tick site for sim time — see the call in the frame loop below.
  const advanceSimTime = useSetAtom(advanceSimTimeAtom);
  const pipelineRef = useRef(pipeline);
  pipelineRef.current = pipeline;

  // Rebuild the node graph when toneMapping / RT changes
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
    // NOT done via `renderer.toneMappingExposure` — three's ToneMappingNode
    // defaults its exposure to a renderer reference for that property, so using it
    // would apply exposure at the wrong point in the chain and risk double-counting.
    // Left at its default 1.0; `uExposure` is the one hook.
    // `uPostExposure` = exposure / preExposure (photometry.ts). Before D25 went
    // live that is just the exposure; with pre-exposure on it is ~1.0, because
    // the buffer already carries the exposure the sources applied. Using the
    // ratio rather than either term means the two can never double-count.
    // ── LOCAL EXPOSURE (D33/D33b, UE5.1's Local Exposure) ────────────────────
    // Multiplied in HERE, alongside the global exposure: both are display-mapping
    // terms and belong on the same side of the tone curve.
    //
    // 🔑 WHY THIS EXISTS AT ALL. A global scalar cannot be right: D33 measured
    // `rendered ∝ coverage^(−k)`, so the same planet renders up to 5.4 stops brighter
    // when it is small on screen — and neither moment of the global mean fixes it
    // (see the estimator note in exposureMeter.ts). This term is coverage-independent
    // by construction, because the local neighbourhood of a disc IS the disc.
    //
    // Bit-exact 1.0 while the map is unbuilt or `__lum.localExposure(false)` is set,
    // so it can be A/B'd without a reload. Its strength is DERIVED (= ADAPTATION_K),
    // not authored.
    // ── VEILING GLARE (Phase 8, glarePass.ts) ────────────────────────────────
    // The eye's point-spread function, applied to the RAW scene in absolute game
    // units and BEFORE the exposure multiply.
    //
    // 🔑 WHY IT SITS IN FRONT OF EXPOSURE, WHERE THE BLOOM IT REPLACED COULD NOT.
    // Bloom's threshold (1.0) was a display-referred "brighter than white" test, so it
    // had to see post-exposure values or it meant something different at every
    // exposure — which forced it behind the exposure multiply. **A
    // physical PSF has no threshold** — the eye scatters all light — so that
    // constraint simply disappears, and the correct place is the earliest one:
    // scattering happens in the ocular media, before any adaptation.
    //
    //     glared = (1 − k)·scene + k·PSF(scene)      k = integrated straylight
    //
    // `mix`, not `add`: scattered light is REMOVED from where it was aimed and put
    // somewhere else. That is what lets it be strong enough to actually veil.
    const glared = glareNode(sceneTexture);

    const exposed = glared.mul(uPostExposure).mul(localExposureNode());

    // ⚠⚠ BLOOM IS GONE, DELETED 2026-08-31, AND THIS NOTE EXISTS SO IT IS NOT
    // REINTRODUCED. `bloom(exposed, 0.001, 0, 1)` was retained through Phase 8 purely
    // as the A/B baseline for judging the PSF against; that judgement is done and it
    // shipped as a strict downgrade on every axis:
    //   • physically wrong — ADDITIVE (invents energy), THRESHOLDED (the eye scatters
    //     all light, not "brighter than white"), and its mip factors
    //     [1, 0.8, 0.6, 0.4, 0.2] sum to 3.0 rather than 1;
    //   • ~5.8 ms of GPU measured, vs 0.9–1.3 ms for the whole PSF pyramid;
    //   • and DOUBLE-COUNTED the halo whenever it ran alongside the glare.
    // 🔑 The A/B it existed for is now `__lum.glare(false)`, which is strictly better:
    // it isolates one variable instead of swapping two implementations.
    const hdr = exposed;
    // ── RETINA (Phase 7, scotopic.ts) ────────────────────────────────────────
    // Rod/cone mix + Purkinje shift, applied to the veiled image and BEFORE the
    // display transform, because that is where the retina sits: ocular media →
    // receptors → neural → display. `sceneTexture` is passed separately so the
    // threshold can be taken in ABSOLUTE cd/m²; the exposed value cannot be used
    // for it (that would make the rod/cone balance a function of exposure, i.e. a
    // feedback loop that settles at the tone curve's fixed point).
    //
    // Bit-exact no-op until `__lum.scotopic(true)` raises the strength uniform, so
    // this costs one uniform multiply and no shader recompile while it is off.
    // ⚠ The driver is `glared`, NOT `sceneTexture`. scotopic.ts deliberately read
    // the pre-glare value and said so: "veiling glare genuinely does raise the
    // retinal light floor and SHOULD feed the driver… but today's bloom is a mip
    // chain with an authored strength, not a calibrated PSF." That is no longer
    // true, so the coupling is made — the retina now sees the veiled image, which
    // is the physically correct input.
    const retina = scotopicNode(hdr, glared);

    // ── DISPLAY TRANSFORM (Phase 6b, displayTransform.ts) ────────────────────
    // ⚠⚠ NO LONGER `retina.toneMapping(AgXToneMapping)`, and the reason is one line of
    // three's source: `agxToneMapping` ends in `clamp(colortone, 0.0, 1.0)`. Headroom is
    // destroyed INSIDE the tone mapper, so no canvas configuration can recover it —
    // Phase 6a's extended-range canvas is inert until this clamp becomes a parameter.
    //
    // `displayTransformNode` is three's AgX with the peak as a uniform instead of a
    // constant: same inset/outset matrices, same 16.5-stop log window, same `pow(·,2.2)`
    // tail, and a parametric sigmoid in place of the fixed 6th-order polynomial so the
    // shoulder's asymptote can move. **Peak 1 = SDR**, which is where it ships until 6c.
    //
    // 🔑 The pivot is PINNED to middle grey, so mid-tones are invariant in the peak by
    // construction — that is what keeps auto-exposure (Phase 5), the scotopic driver
    // (Phase 7) and `EXPOSURE_BIAS_STOPS` meaningful when the peak moves. Only highlights
    // change. Cost of the swap: 2.429 of 255 delivered code values, measured.
    //
    // Khronos PBR Neutral stays on three's node: it has no peak parameter and is a
    // debug/comparison option, not a candidate for the HDR path (it crushes above
    // linear ≈4, which is worse with more range to fill, not better).
    const toneMapped = settings.toneMapping
      ? displayTransformNode(retina)
      : retina.toneMapping(NeutralToneMapping);

    // ⚠ NO post-process AA here, and that was measured too. Post-tonemap SMAA was
    // built (MSAA resolves in linear HDR with the tone curve after, so on a
    // high-contrast edge its first coverage step is 73% of the output range) and
    // REMOVED: it cost **+4.19 ms mean across all 12 scenarios** and fixed nothing
    // that had been reported — the aliasing actually complained about was atmosphere
    // march banding (D14d), fixed by a jitter for ~0 ms. See docs/LIGHTING_PLAN.md.
    const mapped = toneMapped;

    const px = screenCoordinate;
    // ⚠ Dither stays LAST, immediately before the 8-bit write — if a post-process AA
    // is ever added back, it must run BEFORE this or its edge detector reads the noise
    // as structure.
    const dither = hash(px.x.add(px.y.mul(1000)))
      .sub(hash(px.y.add(px.x.mul(1000))))
      .mul(OUTPUT_DITHER_LSB / 255);
    // ⚠⚠ PHASE 6a — `.max(0)` IS LOAD-BEARING ON THE HDR PATH, AND WAS FREE BEFORE IT.
    // AgX ends at display-linear [0,1], and the dither is added AFTER it, so a black
    // pixel can leave here at −1/255. On the SDR canvas (`toneMapping: 'standard'`) the
    // compositor clamped that to 0 and nobody noticed. An extended-range canvas does NOT
    // clamp: a negative channel is a legal out-of-gamut colour, and a gamut mapper is
    // entitled to render it as a faintly COLOURED dark pixel rather than black — which is
    // the worst possible place for it, since deep space is most of our frame. Clamping
    // the floor in-shader is behaviour-identical on SDR and removes the class entirely.
    // 🔑 Only the FLOOR is clamped. The ceiling is what Phase 6b/6c exist to remove.
    const dithered = OUTPUT_DITHER_LSB > 0 ? mapped.add(dither).max(0) : mapped;

    // ── HDR CALIBRATION (Phase 6d, hdrCalibration.ts) ────────────────────────
    // ⚠ Replaces the whole output, tone curve included, and that is the point: the wedge
    // measures the DISPLAY's headroom, so routing it through AgX's shoulder would make the
    // reading about our curve instead of the panel. Values are display-linear multiples of
    // reference white — the same units as `Settings.hdrPeakStops`. The pipeline still
    // applies the sRGB encode after this, exactly as it does for the normal path.
    pipeline.outputNode = calibrating ? hdrCalibrationNode() : dithered;
    pipeline.needsUpdate = true;

    // Tonemapping is now done in-graph → the pipeline's renderOutput() must NOT
    // re-apply it (it still does the sRGB colour-space encode + the canvas write —
    // 8-bit on the SDR path, RGBA16F extended-range when Phase 6a's HDR output is on).
    const renderer = gl as unknown as WebGPURenderer;
    renderer.toneMapping = NoToneMapping;

    // `__lum.tonecurve("poly")` bakes a different curve into the graph, so it needs a
    // recompile — the peak does not (it is a uniform). Registered here because this effect
    // is what owns the graph.
    setDisplayCurveRebuildHook(() => {
      pipeline.needsUpdate = true;
    });

    return () => {
      setDisplayCurveRebuildHook(null);
      pipeline.needsUpdate = true;
    };
  }, [settings.toneMapping, calibrating, pipeline, rt, rtB, gl]);

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
    // ── Advance sim time (ephemeris) ────────────────────────────────────────
    // ONE tick site, here, because every `CelestialBody` READS the clock and
    // exactly one thing may advance it. No-op while `simRateAtom` is 0, which is
    // the default — see store/simTime.ts.
    advanceSimTime(delta);

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
    // Advance the node frame so any node's `updateBefore` runs each frame.
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
    // Disable tone mapping so HDR values stay in absolute game units.
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
    // chain applies exposure/glare/tonemapping — because game units only exist
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
    // ⚠ The meter reads the PRE-GLARE target, i.e. it does not see the veil, and
    // that is a stated limitation rather than an oversight. The veil is
    // mean-preserving by construction, so the LINEAR field average the meter is
    // built around is unchanged by it exactly; only the log-mean would shift, and
    // reaching the composited value would mean metering a node-graph result rather
    // than a render target. Revisit if the shift is ever measured to matter.
    // ⚠ The player's glare setting is pushed HERE, per frame, not through the node
    // graph's `useEffect` deps — it must scale a uniform, never trigger a shader
    // recompile (WebGPU compilation stutter is a known problem in this project).
    // `?? 1` because atomWithStorage returns `undefined` for a key added after the
    // player's settings blob was first written.
    // ⚠⚠ `setGlareUserScale`, NOT `setGlare` — a per-frame writer must not share a
    // setter with the debug override, or `__lum.glare(false)` is undone every frame.
    setGlareUserScale(settings.glare ?? 1);
    // ── DISPLAY PEAK (Phase 6c) ───────────────────────────────────────────────
    // Only meaningful when the compositor is actually accepting extended values; on the
    // SDR path anything above 1.0 is clamped, so asking for headroom there would compress
    // highlights for nothing. `isHdrCanvasActive()` is the read-back of the canvas's own
    // `getConfiguration()`, not a media query — see hdrOutput.ts.
    //
    // ⚠ Written per frame ON PURPOSE: macOS/EDR headroom shrinks as screen brightness
    // rises, so this is a runtime quantity. It is a uniform write, so it costs nothing and
    // never recompiles. `__lum.hdrPeak(H)` overrides it until the next frame, which is why
    // the gate tells you to look immediately.
    setDisplayPeak(
      isHdrCanvasActive() ? Math.pow(2, settings.hdrPeakStops ?? 2) : 1,
    );
    updateGlare(renderer, (rtB ?? rt).texture);
    updateExposureMeter(renderer, (rtB ?? rt).texture, delta);
    // ── Apply postprocessing (glare, retina, tonemapping) and blit to canvas ──
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
