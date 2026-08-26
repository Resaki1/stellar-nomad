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
  screenCoordinate,
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
import { PASS } from "./perf/perfProfiler";
import {
  STAR_COLOR_LINEAR,
  getPreExposure,
  sunIlluminanceAt,
} from "./photometry";
import type { AtmosphereParams } from "../celestial/types";
import {
  getCloudShadowMap,
  cloudShadowAtPlanetKm,
  getShipCloudShadowT,
} from "./cloudShadowMap";

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

// ── Diagnostic dials (docs/LIGHTING_PLAN.md §2.2.4) ──────────────────────
// Module scope so `__lum` can drive them without a handle on the pass. Both
// default to a strict no-op; they exist to ABLATE, which is this repo's rule for
// in-pass questions (see docs/PERF_MEASUREMENT.md — "when gpu/frame > 1.15,
// ablate, never do arithmetic on reported numbers"; the same discipline applies
// to radiometry, and skipping it is what produced the retracted §2.2 verdict).

/** Scales the multiple-scattering contribution. 0 = single scattering only. */
export const uMsScale = uniform(1);
/**
 * Upper clamp on F_ms before the 1/(1−F_ms) geometric series, bounding the
 * multiple-scattering amplification to 1/(1−x). 1 = unclamped.
 *
 * ── WHY THIS EXISTS AND WHY 0.92 (docs/LIGHTING_PLAN.md §2.2.5) ──────────
 *
 * MEASURED on device, Venus' disc, `__lum.compare("venus")`, implied
 * reflectance R = L·π/E (R > 1 is physically impossible — the body would emit
 * more than it receives):
 *
 *   MS ablated (uMsScale = 0)   R = 0.061   ← single scattering alone, 13× too dim
 *   clamp 1.00 (unclamped)      R = 6.974   ← IMPOSSIBLE, 10.1× over expectation
 *   clamp 0.95                  R = 1.176   ← still impossible
 *   clamp 0.90                  R = 0.618
 *   clamp 0.85                  R = 0.432
 *
 * So the ENTIRE excess lives in the geometric series, not in single scattering.
 *
 * ⚠ THE APPROXIMATION GENUINELY DIVERGES HERE — this is a regularisation, not a
 * fudge. Ψ = L₂/(1−F_ms) sums infinite isotropic re-scattering assuming each
 * bounce returns a fraction F_ms. For a near-conservative deep atmosphere
 * (Venus: single-scatter albedo 0.984–0.994, vertical τ 9–46) F_ms → 0.994 is
 * arguably CORRECT, and the series' honest answer is then ~174× — but the series
 * is the wrong model at that point, because it ignores that energy also escapes.
 * Hillaire says F_ms is "in the range [0,1]" and recommends techniques "to help
 * respect that range", i.e. he acknowledges it can breach. His own
 * `max(1−F_ms, 1e-4)` is a divide-by-zero guard that still permits 10,000×.
 *
 * ⚠ THE TABLE ABOVE WAS TAKEN AT THE WRONG GEOMETRY. `__lum.compare()` did not
 * warp at the time, so it probed an off-centre point on the disc — measured
 * 1.852× dimmer than the sub-solar point it was assumed to be. The first
 * calibration (0.92) and its apparent 4.4% agreement with ground truth were both
 * artefacts of that. Scaling the series by the measured pose factor:
 *
 *   clamp 0.95 → R ≈ 2.18   (2.75× over ground truth)
 *   clamp 0.90 → R ≈ 1.15   (1.44×)
 *   clamp 0.85 → R ≈ 0.80   (1.01×)   ← lands on ground truth
 *
 * Cross-check: that scaling predicts R = 1.32 at clamp 0.92 against a MEASURED
 * 1.403 — 6% agreement at an independent point, so the factor is sound.
 *
 * ── THE VALUE IS CALIBRATED AGAINST GROUND TRUTH, NOT AGAINST TASTE ──────
 * The validated Monte Carlo (`docs/LightingResearch/audit4_mc_validation.mjs`,
 * checked to ±0.9% against an analytic single-scatter reference) gives Venus'
 * nadir sub-solar π·L/E = [0.7245, 0.8068, 0.8541], photopic **R* = 0.7927**.
 * That puts the clamp at **0.85**. Note R* is NOT Venus' geometric albedo 0.689:
 * sub-solar nadir legitimately exceeds the disc average (for Venus by 1.15×, and
 * for a Lambert sphere by exactly 1.5× — see LAMBERT_SUBSOLAR_OVER_GEOMETRIC).
 *
 * ✅ VERIFIED at the sub-solar pose: **R = 0.8316 vs ground truth 0.7927 — 4.9%
 * high, and below 1**, so the energy violation is gone. The rescaled-series
 * prediction was 0.80, i.e. accurate to 4%. 4.9% sits inside the stacked
 * uncertainty (MC ±0.7%, pose-factor rescale ±6%, derived-vs-real Venus
 * atmosphere), so this is CONVERGED — do not tune it further. Chasing the last
 * 5% would be exactly the over-fitting that produced VENUS_ILLUM_TRIM.
 *
 * ── AND IT IS PROVABLY INERT EVERYWHERE ELSE ─────────────────────────────
 * The clamp only bites where 1/(1−F_ms) would exceed 12.5×. Earth's F_ms peaks
 * at 0.310 (amplification 1.45×) — two-thirds of the way below the clamp, so it
 * never engages. The H₂/He giants scatter weakly per molecule and sit lower
 * still. This is therefore a GLOBAL bound on a divergent series, not a per-body
 * art constant of the kind §3.0 forbids: it changes exactly the bodies where the
 * approximation has already broken down.
 */
export const uFmsMax = uniform(0.85);

/**
 * LUT epoch — bumped whenever a diagnostic dial changes, so SpaceRenderer knows
 * to re-bake. Necessary because the transmittance/multi-scatter LUTs are baked
 * ONLY when the dominant body changes; without this, turning a dial at runtime
 * would silently do nothing until you warped to another planet and back.
 */
let _lutEpoch = 0;
export const getAtmosphereLutEpoch = (): number => _lutEpoch;
export const invalidateAtmosphereLUTs = (): void => {
  _lutEpoch++;
};

/** Ablate multiple scattering (0) or restore it (1). Forces a LUT re-bake. */
export function setMsScale(scale: number): void {
  uMsScale.value = scale;
  invalidateAtmosphereLUTs();
}

/** Clamp F_ms before the geometric series. Forces a LUT re-bake. */
export function setFmsMax(maxFms: number): void {
  uFmsMax.value = maxFms;
  invalidateAtmosphereLUTs();
}

// Step / sample counts.
const TRANSMITTANCE_STEPS = 40;
const MS_SQRT_SAMPLES = 8; // → 64 sphere directions
const MS_SAMPLE_COUNT = MS_SQRT_SAMPLES * MS_SQRT_SAMPLES;
const MS_STEPS = 20;
// Per-pixel screen march step count. 32 → 16 on 2026-08-11, chosen from the
// MEASURED finding that this march is LATENCY-bound, not throughput-bound: the
// half-res AP split quartered the pixels but bought only 2.7–3.4×, and the
// per-step-eval rate DROPPED (7.4 → 5.1 G/s). See docs/PERF_MEASUREMENT.md
// § "THE MARCH IS NOW LATENCY-BOUND".
//
// Each step issues ~2–3 dependent texture fetches (getSunTransmittance,
// getMultipleScattering, and cloudShadowAtPlanetKm once the BSM gate opens), so
// 32 steps is a 64–96-deep dependent chain per pixel. Halving the steps halves
// that chain and — unlike another resolution cut — does NOT reduce occupancy, so
// it should scale closer to a true 2× than AP_RES_SCALE managed.
//
// ⚠ NO DITHER SAFETY NET. SAMPLE_SEGMENT_T below is a FIXED bias, not per-frame
// jitter (see its comment), and this pass keeps no temporal history, so nothing
// hides coarser steps. Banding on smooth gradients — the limb, the terminator,
// the twilight sky — is the risk to look for, and it is unmitigated. If it shows:
// 24 first (still ~1.5× on the chain), and only then reach for a dither. A dither
// here needs care: without temporal accumulation it converts banding into static
// per-pixel noise, though the half-res → full-res bilinear upsample does smooth
// some of it. Blue-noise infrastructure already exists (stbnTexture.ts, and the
// cloud marcher's BAYER cycle) if it comes to that.
// Per-pixel screen march step count. Restored to 16 after the 2026-08-13 diagnostic
// build (MAIN_STEPS = 2) confirmed the fixed-cost floor is real.
//
// MEASURED at earth_8, half res: 16 steps → `1.5 atmosphere` 6.37 ms; 2 steps → 4.47.
// That gives S = 0.0997 ms per Mpx per step and, extrapolated to zero steps, **4.20 ms
// of cost that is not step work at all**. Minus the ~0.70 ms apply blit, the march
// carries a **~3.50 ms fixed cost — 55% of the pass, and the single largest item in the
// frame** (23% of earth_8's 15.30 ms).
//
// So step count is NOT where the remaining time is: driving steps to zero would save
// only ~2.2 ms of the 6.37. Do not spend quality here again without re-reading
// docs/PERF_MEASUREMENT.md § "the fixed cost is real".
const MAIN_STEPS = 16;
const SAMPLE_SEGMENT_T = 0.3; // reference midpoint bias for the screen march

// ── D14d: BLUE-NOISE JITTER OF THE MARCH SAMPLE POSITION ────────────────────
//
// 🔑🔑 THIS IS THE ACTUAL CAUSE OF THE "ALIASED ATMOSPHERE LIMB", and the warning
// above called it before it was seen: "Banding on smooth gradients — THE LIMB, the
// terminator, the twilight sky — is the risk to look for, and it is unmitigated."
//
// With MAIN_STEPS fixed and SAMPLE_SEGMENT_T a CONSTANT, every pixel samples the same
// lattice of positions along its ray. As the path length varies continuously across
// the limb, which parts of the density profile land on a sample changes DISCRETELY →
// terracing. ⚠ It is a quantisation of the INTEGRAL, not of coverage or of the pixel
// grid, which is why 4× MSAA, post-tonemap SMAA and an analytic silhouette band all
// changed NOTHING, and why AP_RES_SCALE = 1.0 only helped "a bit" (finer terraces,
// same terraces). The user's own observation localised it exactly: "hard steps INSIDE
// the atmosphere at the limb… the planet sphere below it does not seem to alias."
//
// ⚠⚠ THE STRUCTURE MATTERS MORE THAN THE NOISE, and getting it wrong trades bands for
// GRAIN. The march used SAMPLE POSITIONS as segment ends (`dt = tNew − t`), so the
// integrated path was `tMax·(N−1+ξ)/N`. Jittering ξ in that scheme varies the TOTAL
// PATH LENGTH per pixel by 1/N ≈ 6% ⇒ per-pixel brightness noise. So the segment
// BOUNDARIES are now fixed (`dt = tMax/N`, constant, total exactly `tMax`) and only
// the sample POSITION inside each segment moves. That is textbook stratified
// sampling: zero path-length noise, and the sample lattice decorrelates per pixel.
//
// 🔑 Matches the hard-won cloud-marcher result: "the per-sample stratified jitter in
// the loop is what actually broke the bands", whereas a whole-march start offset
// "traded bands for flicker, refuted, removed".
//
// ⚠ SPATIAL ONLY — deliberately NOT cycled per frame. This pass keeps no temporal
// history, so per-frame noise would shimmer on a static view. Static blue-ish noise
// at half res, bilinearly upsampled by the apply pass, reads as very fine grain.
//
// ⚠ SIDE EFFECT TO EXPECT: fixing the boundaries also integrates the ~0.7/N ≈ 4.4% of
// path the old right-endpoint scheme systematically DROPPED, so the atmosphere gets
// slightly denser/brighter. That is a bug fix, not a tuning change — but it is
// visible, hence the flag.
const ATMO_MARCH_JITTER = true;

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
const FROXEL_MAX_DEPTH_KM = 1800;

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

// ── Cloud Beer Shadow Map blit (docs/CLOUD_SHADOWS_GODRAYS_PLAN.md L0) ──
// Build-const, mirroring DEBUG_ATMOSPHERE: 'off' compiles the branch away
// entirely (no BSM texture bind). Blits the singleton getCloudShadowMap() at
// screenUV — the map is a sun-orthographic projection, so this is a top-down-
// from-the-sun view of the cloud shadow field. Purpose: verify L0 (the bake
// produces the cloud pattern, is stable when the camera is still, and doesn't
// swim when flying — the texel-snapped window). Modes:
//   "hit"    — A channel: white where a cloud was crossed (the coverage
//              silhouette in sun projection). The primary "is it working" check.
//   "shadow" — exp(−tau_max): full-column transmittance (white lit → black
//              thick shadow). Reads like the shadow that will land on the ground.
//   "tau"    — tau_max × 0.1: raw optical depth ramp.
//   "front"  — |d_front| × 0.15: sun-depth of the first hit (structure check).
type BsmBlit = "off" | "hit" | "shadow" | "tau" | "front";
const BSM_BLIT: BsmBlit = "off";

// ── God rays (docs/CLOUD_SHADOWS_GODRAYS_PLAN.md L2) ────────────────────────
// Multiply the DIRECT single-scatter term of ALL THREE atmosphere integrals by
// the cloud sun-transmittance from the (soft/blurred) Beer Shadow Map, per
// step. Shadowed air in-scatters less → bright/dark shafts anchored to the
// clouds that cast them (crepuscular rays). Sites: the full-res per-pixel main
// march (ground rays + high-alt sky), the AP froxel (cloud fog), and the
// Sky-View LUT bake (low-altitude sky — where the 200×256 lattice quantizes
// shafts into soft curved bands, an ACCEPTED known limitation; see the bake
// site's note for the two reverted per-pixel alternatives). Build const: false
// compiles the taps away and the BSM texture is never bound here. When the BSM
// is stale/unbaked (no cloud pipeline — e.g. Mars — or above its altitude
// ceiling) its strength gate is 0 and cloudShadowAtPlanetKm returns 1 → god
// rays gracefully absent.
const GODRAYS = true;
// Overall god-ray shaft CONTRAST (0 = off, 1 = full physical). The shafts read
// too harsh from near-horizontal / orbital views where they extrude across the
// whole limb (user, image 2); this lerps the per-step cloud shadow toward
// unshadowed so shafts stay present but paler. Also try a larger
// BSM_SOFT_BLUR_TEXELS (cloudShadowMap.ts) for softer shaft EDGES.
const GODRAY_STRENGTH = 0.6;
// The multi-scatter term is directionless ambient — under a deck some ambient
// survives (light leaks around the clouds), so shadow it only partially.
// 0 = unshadowed ambient, 1 = fully shadowed. Frostbite-style middle ground.
const MS_CLOUD_SHADOW = 0.5;
// Force the per-pixel march for SKY rays at low altitude (uSkyViewBlend → 1) so
// sky-side shafts render crisp per-pixel instead of quantized to the Sky-View
// LUT lattice. Measured at −10–20% fps — the candidate QUALITY TIER if the
// LUT-lattice banding ever needs solving (post-blur the marched shafts look
// correct). Default OFF.
const GODRAYS_SKY_MARCH = false;

// ⚠ DO NOT try to make the per-step BSM tap cheaper — MEASURED, IT IS ALREADY FREE.
// On 2026-08-13 the tap was strided to every 2nd march step (held across the pair,
// sampled at the pair centre, skipped via a uniform-valued `If(s.mod(2) == 0)` so
// the fetch genuinely did not execute). Removing EIGHT dependent fetches per pixel
// moved `1.5 atmosphere` by a mean of **−0.17 ms** and frame p50 by **0.00…−0.10 ms**,
// i.e. nothing above the 0.4 ms noise floor. The control group was perfect: every
// `bsmStrength = 0` row moved exactly 0.00. Reverted — it cost god-ray fidelity for
// no frame time. ≈21 µs per fetch per frame at 1.36 Mpx: the BSM is a 512² map, small
// enough to stay in cache, unlike the transmittance/MS LUTs or the 3D noise volumes.
//
// COROLLARY, and this is the useful part: the +5.60 ms that the 2000 km gate cost
// pre-half-res is therefore NOT the march taps. Nor is it the planet surface shader's
// 5-tap penumbra (`1 scaled scene` moves only +0.12 ms across that same gate). What
// is left is the **bake** — 3 renders × 512² × 24 steps ≈ 18.9 M step-evals ≈ 2.2 ms
// at the measured 8.7 G step-evals/s. Attack the bake's step count or resolution
// (cloudShadowMap.ts), not the tap rate. See docs/PERF_MEASUREMENT.md.

// ── L3: clouds shadow the ship ──────────────────────────────────────────────
// The CPU lighting bridge multiplies the ship's key light by the smoothed BSM
// transmittance at the ship position (getShipCloudShadowT — 1×1 GPU probe +
// async readback in cloudShadowMap.ts) and partially dims the hemisphere sky
// fill. Flip false to detach ship lighting from clouds entirely.
const SHIP_CLOUD_SHADOW = true;
// How much of the sky-fill dims under a fully opaque deck (0 = none, 1 = all).
// Under a deck the sky dome darkens but the cloud itself scatters light down,
// so full dimming reads wrong.
const AMBIENT_CLOUD_DIM = 0.6;
// Contrast curve on the ship's cloud transmittance before it dims the key light
// (shipT^γ, γ>1). The hull is exposed near white (sun intensity 30 + bloom/
// tonemap) so a raw ≤35% dim is invisible; γ pushes moderate cloud (0.65) to a
// visible 0.34 while leaving clear sky (≈1) unchanged. Raise for punchier ship
// shadow, 1 = raw physical.
const SHIP_SHADOW_GAMMA = 3.0;

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
//
// ── ABLATION IN PROGRESS 2026-08-11 — currently FALSE, see below ──
// The profiler reports this bake at 4.3–4.7 ms, but 200×256 texels × 30 steps is
// only 1.5 M step-evals; at the main march's own measured rate (~7.4 G/s that run)
// it should cost ~0.2 ms. It is reporting ~35× too much time per step-eval, and
// its own gate straddle (earth_250 → earth_120) bounds it at ≤1.80 ms including
// coverage growth. So the reported number is not believable and the real one is
// unknown.
//
// The half-res AP split changed the trade-off that justified this LUT in the
// first place: sky-ray marching is now ~3× cheaper than when the LUT was added.
// So the decision-relevant question is not "what does the bake cost" but "is the
// LUT still worth having at all" — which this flag answers directly, because the
// LUT has exactly ONE consumer (sampleSkyView) and blend→1 is a clean full-march
// fallback.
//
// There is a QUALITY dimension pointing the same way: shafts baked into the
// 200×256 lattice band the low-altitude sky (see the KNOWN LIMITATION note in the
// bake — two per-pixel fixes were tried and both reverted). Marching gives crisp
// per-pixel shafts instead. If this is perf-neutral or better, it is a double win
// and the whole subsystem can go.
//
// PREDICTION, written before measuring (uSkyViewBlend = smoothstep(60,150,altKm)):
//   MUST move — earth_120 (blend 0.741, so already ¾ marching yet paying the full
//     bake → should be the clearest win), earth_30 and earth_8 (blend 0.000, pure
//     LUT → these two swap the bake for a full sky march, sign unknown).
//   MUST stay flat — the other 11. earth_250 and above already run blend = 1.000
//     with the bake skipped (alt > SKYVIEW_BAKE_MAX_ALT_KM = 180). Any movement
//     there means the attribution is wrong, not that the change worked.
const USE_SKYVIEW = false;
export const SKYVIEW_ENABLED: boolean =
  USE_SKYVIEW || (DEBUG_ATMOSPHERE as string) === "skyView";

// ── Half-resolution aerial perspective (perf) ───────────────────────────────
// MEASURED 2026-08-11 (docs/PERF_MEASUREMENT.md § THE BASELINE): the full-DPR
// 32-step march was 76% / 84% / 88% of frame time at 4100 / 2100 / 1900 km
// altitude, saturating at ~23.7 ms once the planet fills the screen — the single
// largest cost in the renderer by a wide margin.
//
// Fix, following Hillaire §5.5 and Unreal's AerialPerspectiveLUT: the march no
// longer produces final pixels. It produces AERIAL PERSPECTIVE — in-scattered
// radiance (rgb) and mean transmittance (a) — at REDUCED resolution, and a cheap
// full-resolution "apply" pass combines it with the scene: scene·T + L.
//
// Why that split is the right one: the scene colour stays FULL RES, so geometry
// edges (terrain silhouettes, the ship, stars) keep their exact pixels. Only the
// two smooth scattering terms are upsampled, and those are low-frequency by
// construction — the same property that makes the froxel and Sky-View LUT work
// at 32³ and 200×256 respectively.
//
// 0.5 = quarter the marched pixels. 1 = full res (structurally identical graph,
// so it is a clean A/B for the upsample's quality cost — use it to bisect any
// artefact before blaming the split itself).
// Restored to 0.5 after the 2026-08-13 per-pixel-vs-per-pass diagnostic (0.25).
//
// MEASURED: quartering the pixels dropped `1.5 atmosphere` by only 1.66–1.78 ms on
// every row — exactly the step-work term (16 × 0.0997 × (1.362 − 0.34) = 1.63) and
// nothing more. Had the ~3.50 ms fixed cost been per-pixel, each row would have
// dropped a further ~2.6 ms. It did not move at all.
//
// **So the fixed cost is per-PASS: independent of resolution AND of step count.**
// Both knobs are therefore mined out — each can only ever reach the 2.17 ms step term,
// and pushing either further trades quality for progressively less. Do not reach for
// AP_RES_SCALE again as a perf lever without re-reading docs/PERF_MEASUREMENT.md.
export const AP_RES_SCALE = 0.5;

/**
 * Half-width of the ground-silhouette antialiasing band, in MARCH pixels (D14b).
 *
 * 0.5 = a one-march-pixel ramp, the narrowest a half-res march can represent; the
 * apply pass's bilinear upsample then spreads it over ~2 screen pixels. Raise it if
 * the limb still steps, lower it if the limb looks soft. ⚠ Below ~0.5 the ramp is
 * narrower than the march grid and the stair-stepping returns.
 */
const SILHOUETTE_AA_MARCH_PX = 0.5;

// Reconstruct PER-CHANNEL transmittance from the stored mean in the apply pass.
//
// The march accumulates a vec3 throughput (Rayleigh reddens long paths — this is
// what makes a low sun redden distant terrain), but only 4 channels fit in the
// AP target and rgb is spent on L. Storing the mean and reconstructing is what
// keeps that reddening: since T_c = exp(-tau_c) and the path's spectral SHAPE is
// dominated by a fixed extinction ratio, T_c ≈ Tmean^(tau_c/tau_mean), i.e. a
// per-channel pow() with a constant vec3 exponent (uTSpectralK, from the
// vertical column integral in setAtmosphere).
//
// Two properties make the approximation safe where it matters: it is EXACT at
// Tmean = 1 (no attenuation → no error), and exact for a grey atmosphere
// (k = 1,1,1). Error grows only with optical depth, which is precisely where a
// grey transmittance would visibly desaturate. Flip false to store/apply the
// mean greyly (Hillaire's own froxel convention, and what getSkyViewLUT and
// getAtmosphereFroxel already do) if the pow() ever misbehaves.
const AP_SPECTRAL_TRANSMITTANCE = true;

// Compile-time debug blits bypass the AP split: the march writes its diagnostic
// colour straight to rgb with a = 0, so the apply pass (scene·a + rgb) hands it
// through verbatim. Keeps every DEBUG_ATMOSPHERE / BSM_BLIT mode working.
const AP_DEBUG_BLIT: boolean =
  (DEBUG_ATMOSPHERE as string) !== "off" || (BSM_BLIT as string) !== "off";

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

// ── Cloud AP: apply INSIDE the marcher (pre-reconstruction) vs composite ─────
// See docs/CLOUD_REVIEW_2026-07.md ISSUE 1. The composite path
// (applyCloudAerialPerspective above) fogs each cloud pixel at the marcher's
// per-frame cloud-front depth — which is NEVER temporally filtered. The depth
// jitters ±a skip-step per frame (earthClouds §stratJitter) and that step GROWS
// with distance (LOD_STEP_GROWTH), so far/edge clouds get a large per-frame
// depth wobble → the froxel slice (hence in-scatter/transmittance) wobbles →
// the "dark blocks flickering on/off" the user sees, worst far away. The prior
// spatial gather (CLOUD_DEPTH_GATHER_RADIUS) damped the no-hit bleed but a
// SPATIAL average can't fix a TEMPORAL instability (all 9 taps share the
// frame's jitter bias). Fix: apply the AP inside the sparse marcher, BEFORE the
// reconstruction pass's temporal EMA — so the depth-jitter-driven colour
// variance is averaged out by the same accumulation that already stabilises the
// cloud colour. (Frostbite reconstructs the cloud AP together with the cloud at
// half-res for exactly this reason; RDR2/Nubis integrate scattering along the
// march.) Net perf is also POSITIVE: a ¼-res single froxel tap replaces a
// full-res 9-tap depth gather + froxel tap at composite.
//
// Flip AP_IN_MARCHER=false to A/B against the old composite-time path. Any
// AP_DEBUG mode forces the composite path (the debug viz lives there).
const AP_IN_MARCHER = true;
export const CLOUD_AP_IN_MARCHER: boolean =
  FROXEL_ENABLED && AP_IN_MARCHER && (AP_DEBUG as string) === "off";

/**
 * Direct cloud aerial-perspective for the sparse marcher: fog a premultiplied
 * cloud RGBA by the froxel at a KNOWN depth (no sparse gather, no reprojection —
 * the marcher has the per-pixel depth in hand). `screenUvNode` is the full-res
 * screen UV of this sample (same convention as the froxel bake / composite),
 * `depthScaled` is the cloud-front depth in scaled-world units (marcher tFront;
 * ≤0 = no hit → passthrough). Same premultiplied AP + baked/hit gating as
 * applyCloudAerialPerspective, minus the debug branches.
 */
export const applyCloudAerialPerspectiveDirect = (
  cloudPremul: Node,
  screenUvNode: Node,
  depthScaled: Node,
): Node => {
  const depthKm = depthScaled.div(SCALED_UNITS_PER_KM);
  const depth01 = clamp(depthKm.div(FROXEL_MAX_DEPTH_KM), 0, 1);
  const wSlice = sqrt(depth01);
  const ap = texture3D(
    getAtmosphereFroxel(),
    vec3(screenUvNode.x, screenUvNode.y, wSlice),
  ).level(int(0)) as Node;
  const fogged = vec4(
    cloudPremul.rgb.mul(ap.a).add(ap.rgb.mul(cloudPremul.a)),
    cloudPremul.a,
  );
  // Guard the never-baked all-zero froxel (would BLACK the cloud) and no-hit
  // pixels (depth sentinel ≤0).
  const baked = ap.a.add(ap.r).add(ap.g).add(ap.b).greaterThan(float(1e-4));
  const hasDepth = depthScaled.greaterThan(float(0));
  return select(
    baked.and(hasDepth),
    mix(cloudPremul, fogged, float(CLOUD_AP_STRENGTH)),
    cloudPremul,
  );
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
  /** Body→STAR distance in km. Drives `sunIlluminance` — must be live. */
  starDistanceKm: number;
  /**
   * Top-of-atmosphere sun illuminance in game units (≈6,038 lux each), RECOMPUTED
   * EVERY FRAME from `starDistanceKm`. This used to be a compile-time constant on
   * `AtmosphereParams`, which froze every body's brightness at its authored
   * position — defect D17 in docs/LIGHTING_PLAN.md, and a hard blocker for both
   * orbital motion and procedural systems. Read this, never `params.*`.
   */
  sunIlluminance: THREE.Vector3;
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
  starDistanceKm: number,
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
      starDistanceKm: 0,
      sunIlluminance: new THREE.Vector3(),
      params,
      rings: null,
    };
    atmosphereBodies.set(id, rec);
  }
  rec.centerScaled.copy(centerScaled);
  rec.sunDir.copy(sunDir).normalize();
  rec.distanceKm = distanceKm;
  rec.starDistanceKm = starDistanceKm;
  rec.params = params;
  // Per-frame 1/r² illuminance. Grey for now (the star's colour temperature
  // becomes a per-channel tint in Phase 3 — LIGHTING_PLAN §3.0, defect D18).
  const illum = sunIlluminanceAt(starDistanceKm, params.starLuminositySun);
  // D18 CLOSED: tinted by the star's blackbody colour instead of grey. The tint
  // is luminance-normalised, so total illuminance is still exactly `illum` —
  // only the hue changes, and the §3.1 calibration is untouched.
  // × preExposure (D25) — pre-exposes the atmosphere march, the cloud shell and
  // the volumetric marcher in one write, since all three are linear in it.
  const illumPre = illum * getPreExposure();
  rec.sunIlluminance.set(
    illumPre * STAR_COLOR_LINEAR[0],
    illumPre * STAR_COLOR_LINEAR[1],
    illumPre * STAR_COLOR_LINEAR[2],
  );
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

/**
 * One body's live atmosphere record, or undefined if it is not registered this
 * frame. Use this to read a body's PER-FRAME `sunIlluminance` from code that
 * isn't the atmosphere pass (e.g. Earth's cloud shell) instead of baking the
 * old static `params.sunIlluminance` into a shader literal.
 */
export function getAtmosphereBody(id: string): AtmosphereBodyRecord | undefined {
  return atmosphereBodies.get(id);
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
  // × preExposure (D25): this drives AtmosphereSkyLight's hemisphere intensity,
  // which lights the LOCAL scene — so it must move in lockstep with SunLight's
  // key and fill or the ship's sky fill and its sunlit side would disagree.
  _lighting.skyIntensity =
    SKY_AMBIENT_MAX_INTENSITY * densityAtCam * dayFactor * getPreExposure();

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

  // ── L3: cloud shadow on the ship (docs/CLOUD_SHADOWS_GODRAYS_PLAN.md) ──
  // Smoothed BSM transmittance at the ship (1×1 GPU probe + async readback;
  // relaxes to 1 when the map is stale). Scales the key light like the
  // planet-eclipse occlusion above (scalar — clouds are grey), and dims the
  // hemisphere sky fill PARTIALLY: under a deck the sky dome darkens, but the
  // deck itself scatters, so full dimming would read wrong. SunLight.tsx /
  // AtmosphereSkyLight.tsx consume these fields unchanged.
  if (SHIP_CLOUD_SHADOW) {
    // Gamma the raw transmittance DOWN: the hull is lit by an intensity-30 sun
    // through bloom+tonemapping, so it clips near white and a ≤35% key-light
    // dim stays clipped (user: "specular unaffected, barely dims"). The τ-gate
    // also caps the probe at ~0.65 even under a visually-thick deck. shipT^γ
    // (γ>1) turns a moderate 0.65 into a dramatic 0.34 that survives the clip,
    // while leaving near-1 (clear sky) essentially unchanged.
    const shipT = Math.pow(getShipCloudShadowT(), SHIP_SHADOW_GAMMA);
    _lighting.sunTransmittance.multiplyScalar(shipT);
    _lighting.skyIntensity *= 1 - AMBIENT_CLOUD_DIM * (1 - shipT);
  }

  _lighting.active = true;
}

// =============================================================================
// The pass
// =============================================================================

export type AtmospherePass = {
  /**
   * Main on-screen pass (rt → `target`, normally rtB). Internally two renders:
   * the aerial-perspective march at AP_RES_SCALE, then a full-resolution apply.
   * They must stay adjacent — separating them was measured and reverted, see the
   * implementation. Leaves the render target set to null.
   */
  render: (renderer: WebGPURenderer, target: RenderTarget) => void;
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
 *
 * `widthPx`/`heightPx` are the FULL-resolution drawing-buffer dimensions (the
 * same numbers `rt` was sized with). The internal aerial-perspective target is
 * derived from them via AP_RES_SCALE, so the caller must rebuild this pass on
 * resize — which it already does, since `inputTexture` changes too.
 */
export function setupAtmospherePass(
  inputTexture: THREE.Texture,
  transmittanceLUT: RenderTarget,
  multiScatterLUT: RenderTarget,
  widthPx: number,
  heightPx: number,
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
  // ── D14b: analytic coverage of the GROUND SILHOUETTE ──────────────────────
  // Half-width of the antialiasing band, in km of IMPACT PARAMETER. Set per frame
  // on the CPU (everything it needs is already a CPU-side value).
  //
  // 🔑🔑 THIS, NOT THE SHELL, IS WHERE THE VISIBLE ALIASING COMES FROM. `tEnd` was
  // `select(groundHit, tGround, atmo.tFar)` — a HARD BINARY BRANCH at the planet's
  // ground silhouette. `tGround` there is the grazing distance while `atmo.tFar` is
  // the far shell exit, so `tEnd`, and with it L and T, jump discontinuously across
  // the planet's edge.
  //
  // ⚠⚠ IT IS AN INTERNAL SHADER BRANCH, SO NEITHER MSAA NOR A SHELL MESH CAN TOUCH
  // IT. MSAA supersamples geometric COVERAGE; this is a per-pixel `if`. That is why
  // 4× MSAA visibly fixed airless bodies and did nothing for Jupiter — and it is why
  // "draw the atmosphere as a shell mesh" fixes occlusion and cost but NOT this.
  //
  // ⚠ Compounded by AP_RES_SCALE = 0.5: the branch is evaluated at HALF resolution
  // and bilinearly upsampled, so the step becomes 2×2-pixel blocks. That matches the
  // reported symptom exactly ("aliased at mid distances, fine when far or close" —
  // far = billboard tier, no march; close = the edge leaves the screen).
  //
  // THE FIX: the silhouette is an exact analytic circle, so its sub-pixel coverage is
  // closed-form. A ray's impact parameter is `b⊥ = √(r² − (ro·rd)²)`, the silhouette
  // sits at `b⊥ = Rg`, and one pixel of angle maps to `db⊥/dθ = √(r² − Rg²)` km (at
  // the silhouette sin θ = Rg/r ⇒ cos θ = √(1 − Rg²/r²)). So the band half-width is
  //   `HALF_PX · tanPerMarchPx · √(r² − Rg²)`.
  // 🔑 Same `tanPerPx` discipline as the sky LOD and the star sprites: a perspective
  // projection is linear in TAN of the angle, not the angle.
  //
  // ⚠ Sized in MARCH pixels, not screen pixels, ON PURPOSE. A ramp narrower than one
  // march pixel cannot be represented at half res — it would alias again. 0.5 gives a
  // one-march-pixel ramp, which the apply pass's bilinear upsample then spreads over
  // ~2 screen pixels.
  const uSilhouetteHalfWidthKm = uniform(0);
  const uSunDir = uniform(new THREE.Vector3(0, 0, 1)); // normalised, planet frame
  const uActive = uniform(0); // 0 = passthrough, 1 = march
  // AP froxel far plane (km). Static for now; a per-frame uniform so a future
  // altitude-adaptive depth (Phase 4 tuning) needs no graph rebuild.
  const uFroxelMaxDepthKm = uniform(FROXEL_MAX_DEPTH_KM);
  // Sky-View crossfade for sky rays: 0 = pure LUT lookup (low altitude, the
  // march is skipped), 1 = pure per-pixel march (space). Set per frame from
  // altitude in updateUniforms.
  const uSkyViewBlend = uniform(1);
  // Per-channel exponent that expands the AP target's mean transmittance back to
  // a spectral one: T_c = Tmean ^ uTSpectralK_c. Set from the atmosphere's
  // vertical column integral in setAtmosphere; (1,1,1) = grey. See
  // AP_SPECTRAL_TRANSMITTANCE.
  const uTSpectralK = uniform(new THREE.Vector3(1, 1, 1));
  const froxel = getAtmosphereFroxel();
  const skyViewLUT = getSkyViewLUT();

  // Aerial-perspective target: the march's output at AP_RES_SCALE. HDR (the
  // in-scatter is scene-referred radiance and routinely exceeds 1), no depth (the
  // pass is a fullscreen quad with depthTest off, and the march finds its own
  // endpoint analytically via raySphere — it never reads a depth buffer).
  // LinearFilter is what makes the apply pass's upsample a free bilinear tap.
  const apWidth = Math.max(1, Math.round(widthPx * AP_RES_SCALE));
  const apHeight = Math.max(1, Math.round(heightPx * AP_RES_SCALE));
  const apRT = new RenderTarget(apWidth, apHeight, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
  });
  apRT.texture.minFilter = THREE.LinearFilter;
  apRT.texture.magFilter = THREE.LinearFilter;
  apRT.texture.wrapS = THREE.ClampToEdgeWrapping;
  apRT.texture.wrapT = THREE.ClampToEdgeWrapping;
  apRT.texture.generateMipmaps = false;

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

  // Scalar base raised to a vec3 of exponents — same narrow-typing dodge as
  // expVec3. Used to expand the AP target's mean transmittance per channel.
  const powVec3 = (base: Node, k: Node): Node =>
    vec3(pow(base, k.x), pow(base, k.y), pow(base, k.z));

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
    // Ring shadow, uniform-gated. `uRingOpacity` is set to 0 every frame for any
    // body without rings (see updateUniforms), which makes `ringOpacityAt` — and
    // therefore this whole factor — collapse to exactly 1. But it collapsed only
    // AFTER running the annulus intersection and the six-smoothstep radial
    // density profile, and this function is called ONCE PER MARCH STEP: ~40 ALU
    // ops × 32 steps × every ground pixel, for a guaranteed no-op at Earth, Mars,
    // Venus and every moon. Same recipe as the BSM strength gate in
    // cloudShadowMap.ts (docs/PERF_MEASUREMENT.md §6).
    //
    // `uRingOpacity` is a per-frame uniform ⇒ the branch is coherent across the
    // whole draw. Saturn takes the branch and is bit-identical to before.
    const ringKeep = float(1).toVar();
    If(uRingOpacity.greaterThan(0), () => {
      const ring = rayRingHit(P, uSunDir);
      ringKeep.assign(float(1).sub(ringOpacityAt(ring.rHit).mul(ring.hitF)));
    });
    return earthShadow.mul(ringKeep);
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

    // ⚠ THE GEOMETRIC SERIES IS THE SUSPECT FOR VENUS' MEASURED ~16× EXCESS
    // (docs/LIGHTING_PLAN.md §2.2.4). Ψ = L2nd/(1−F_ms) models infinite isotropic
    // re-scattering, and it is only meaningful while F_ms is comfortably below 1.
    // On Venus (ω → 0.994, vertical τ 9–46) the replica measured F_ms up to
    // 0.9943, i.e. an amplification of 174×. In that regime the series is
    // catastrophically ill-conditioned: F_ms 0.9938 → 0.9990 is a 0.5% change in
    // the input and a 6× change in the output, so two implementations of the same
    // algorithm that differ only in sample count can disagree by an order of
    // magnitude. Hillaire's own `max(…, 1e-4)` is a divide-by-zero guard (it
    // still permits 10,000×), NOT a physical bound.
    //
    // `uFmsMax` clamps F_ms to a maximum, bounding the amplification to
    // 1/(1−uFmsMax). Default 1.0 reproduces the previous behaviour exactly, so
    // this is a no-op until someone turns the dial. Drive it from
    // `__lum.setFmsMax(x)` and re-measure with `__lum.compare("venus")`.
    const FmsClamped = Fms.min(uFmsMax);
    const psi = inScattered.div(vec3(1).sub(FmsClamped).max(1e-4));
    return vec4(psi, 1);
  });

  // ── Shadowed per-step sun scatter (L2 god rays) ────────────────────────────
  // The one integrand shared by the main march, the froxel bake, and the
  // Sky-View bake: S = illuminance · (shadow·Tsun·phase + ms). With GODRAYS the
  // direct term is additionally shadowed by the cloud Beer-Shadow-Map
  // transmittance at P (planet-centred km — the helper converts to the BSM's
  // earth-model frame), and the ambient ms term partially (MS_CLOUD_SHADOW).
  // GODRAYS=false compiles to the original expression exactly.
  const shadowedSunScatter = (
    P: Node,
    earthShadow: Node,
    Tsun: Node,
    phaseScat: Node,
    msContrib: Node,
  ): Node => {
    if (!GODRAYS) {
      return uSunIlluminance.mul(
        earthShadow.mul(Tsun).mul(phaseScat).add(msContrib),
      );
    }
    // .toVar(): consumed by both the direct and ms terms — evaluate (and tap
    // the BSM) once per step, not twice.
    const cloudTraw = cloudShadowAtPlanetKm(P).toVar();
    // GODRAY_STRENGTH tones the shaft CONTRAST toward unshadowed — the shafts
    // read too harsh from near-horizontal views (user, image 2) where they
    // extrude across the whole limb. mix(1, cloudT, s): s=1 full, lower = softer
    // (paler) shafts. The ms term is toned by the same dial × MS_CLOUD_SHADOW.
    const cloudT = mix(float(1), cloudTraw, float(GODRAY_STRENGTH)).toVar();
    return uSunIlluminance.mul(
      earthShadow
        .mul(Tsun)
        .mul(cloudT)
        .mul(phaseScat)
        .add(msContrib.mul(mix(float(1), cloudT, float(MS_CLOUD_SHADOW)))),
    );
  };

  // ── Aerial-perspective fragment (half res — see AP_RES_SCALE) ──────────────
  // Writes AP, not pixels: rgb = in-scattered radiance, a = mean transmittance.
  // The apply pass below turns that into `scene·T + L` at full resolution.
  // Neutral value is (0,0,0,1) — no in-scatter, full transmittance — so a
  // skipped/inactive pixel leaves the scene untouched.
  //
  // DEBUG builds instead write their diagnostic colour to rgb with a = 0, which
  // the same apply formula passes through verbatim (see AP_DEBUG_BLIT). Only
  // those builds sample the scene here; the shipping graph never does, which is
  // the point — the AP target holds no scene colour to be upsampled.
  const apFragment = Fn(() => {
    const sceneColor = AP_DEBUG_BLIT
      ? texture(inputTexture, screenUV).rgb
      : vec3(0);
    const out = (AP_DEBUG_BLIT ? vec4(sceneColor, 0) : vec4(0, 0, 0, 1)).toVar();

    // Geometry-free debug (compile-time):
    if (DEBUG_ATMOSPHERE === "lutT")
      return vec4(texture(transmittanceLUT.texture, screenUV).rgb, 0);
    if (DEBUG_ATMOSPHERE === "lutMS")
      return vec4(texture(multiScatterLUT.texture, screenUV).rgb, 0);
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
        0,
      );
    }
    if (DEBUG_ATMOSPHERE === "skyView") {
      // Blit the Sky-View LUT directly (screenUV → LUT uv): the upper half is the
      // sky (blue → reddened toward the horizon at v=0.5), the sun glow sits at
      // u=0.5, the lower half is the toward-ground march. Validates the BAKE
      // (forward mapping); the sampler's inverse mapping is exercised in step 2.
      return vec4(texture(skyViewLUT.texture, screenUV).rgb, 0);
    }
    if (BSM_BLIT !== "off") {
      const bsm = (
        texture(getCloudShadowMap().texture, screenUV).level(int(0)) as Node
      ).toVar();
      if (BSM_BLIT === "hit") return vec4(bsm.a, bsm.a, bsm.a, 0);
      if (BSM_BLIT === "shadow") {
        const T = exp(bsm.b.negate());
        return vec4(T, T, T, 0);
      }
      if (BSM_BLIT === "tau") {
        const g = bsm.b.mul(0.1);
        return vec4(g, g, g, 0);
      }
      if (BSM_BLIT === "front") {
        const f = bsm.r.abs().mul(0.15);
        return vec4(f, f, f, 0);
      }
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
          select(atmo.tFar.greaterThan(0), vec4(0, 0, 1, 0), vec4(0.3, 0, 0, 0)),
        );
        return;
      }
      if (DEBUG_ATMOSPHERE === "extinction") {
        const Ptest = select(
          groundHit,
          ro.add(rd.mul(tGround)),
          ro.add(rd.mul(atmo.tNear.max(0))),
        );
        out.assign(vec4(sampleMedium(Ptest).extinction.mul(30), 0));
        return;
      }
      if (DEBUG_ATMOSPHERE === "sunT") {
        const Ptest = select(
          groundHit,
          ro.add(rd.mul(tGround)),
          ro.add(rd.mul(atmo.tNear.max(0))),
        );
        out.assign(vec4(getSunTransmittance(Ptest, uSunDir), 0));
        return;
      }

      If(atmo.tFar.greaterThan(0), () => {
        // tStart = atmosphere entry (0 if camera already inside); push off the
        // shell when entering from outside.
        const tStart = atmo.tNear
          .max(0)
          .add(select(atmo.tNear.greaterThan(0), float(SURFACE_OFFSET_KM), float(0)))
          .toVar();
        // ── D14b: blend the two branches over one march pixel ────────────────
        // ⚠ `tGround` is ≤ 0 where there is no hit, so it cannot be mixed directly.
        // `-(ro·rd)` is the closest-approach distance, which is exactly what
        // `tGround` converges to AT the silhouette (the discriminant vanishes there),
        // so it is the continuous continuation of the ground branch outward and the
        // mix is C0 across the edge.
        //
        // ⚠ This interpolates the march ENDPOINT rather than the two results. L is
        // monotone in `tEnd`, so the blended value is bounded between the branches
        // and moves smoothly — an approximation, but over a one-pixel band and far
        // cheaper than marching twice.
        const roDotRd = dot(ro, rd).toVar();
        const tGroundCont = select(groundHit, tGround, roDotRd.negate());
        // ⚠⚠ `bPerp` is the distance from the planet centre to the INFINITE LINE, not
        // to the forward ray. A camera looking AWAY from the planet has its closest
        // approach BEHIND it, so `bPerp` can be < Rg with no forward hit at all — and
        // then `tGroundCont = −(ro·rd)` is NEGATIVE and the blended `tEnd` would run
        // the march backwards. `ro` points outward from the centre, so `ro·rd ≥ 0` is
        // exactly "moving away"; force full sky coverage there. Continuous at the
        // grazing case, where `ro·rd → 0` and both branches meet.
        const movingAway = roDotRd.greaterThanEqual(0);
        const bPerp = dot(ro, ro).sub(roDotRd.mul(roDotRd)).max(0).sqrt();
        const groundCoverage = select(
          movingAway,
          float(1),
          smoothstep(
            uBottomRadius.sub(uSilhouetteHalfWidthKm),
            uBottomRadius.add(uSilhouetteHalfWidthKm),
            bPerp,
          ),
        );
        const tEnd = mix(tGroundCont, atmo.tFar, groundCoverage);
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
        // Gated on `uRingOpacity > 0` for the same reason directSunOcclusion's ring
        // term is (see there): a per-frame uniform makes the branch coherent across
        // the whole draw, so it is free, and on every ringless body this is ~40 ALU
        // ops including 6 smoothsteps computed per pixel for a guaranteed no-op.
        // This one was missed when the in-march term was gated — and it sits in the
        // per-pixel, OUTSIDE-the-loop part of the pass, which the 2026-08-13
        // MAIN_STEPS=2 probe showed is 55% of the pass's cost. Saturn takes the
        // branch and is bit-identical to before.
        const ringGlowKeep = float(1).toVar();
        If(uRingOpacity.greaterThan(0), () => {
          const ringView = rayRingHit(ro, rd);
          const ringInFrontCover: Node = ringView.hitF
            .mul(ringOpacityAt(ringView.rHit))
            .mul(select(ringView.t.lessThan(tEnd), float(1), float(0)));
          ringGlowKeep.assign(float(1).sub(clamp(ringInFrontCover, 0, 1)));
        });

        // Per-pixel raymarch (default = neutral AP when skipped or tMax≤0).
        // GROUND rays always march (fine-grained surface aerial perspective); SKY
        // rays march only when the crossfade needs it (uSkyViewBlend > 0, i.e.
        // near/above the atmosphere top) — below that the Sky-View LUT replaces
        // the march and it is SKIPPED (the perf win).
        const marched = (
          AP_DEBUG_BLIT ? vec4(sceneColor, 0) : vec4(0, 0, 0, 1)
        ).toVar();
        const runMarch = () => {
          const cosTheta = dot(rd, uSunDir);
          const phaseR = rayleighPhase(cosTheta);
          const phaseM = hgPhase(uMieG, cosTheta);

          const L = vec3(0).toVar();
          const throughput = vec3(1).toVar();
          const t = float(0).toVar();

          // Per-pixel jitter ξ ∈ [0,1), constant across steps for this pixel so the
          // whole sample lattice shifts together (decorrelates bands between
          // neighbours without adding intra-ray noise). Interleaved-gradient noise:
          // one dot + fract, no texture fetch, and far more even than a plain hash.
          // Interleaved-gradient noise (Jimenez 2014):
          //   fract(52.9829189 · fract(0.06711056·x + 0.00583715·y))
          // One dot and two fracts — no texture fetch, and far more evenly
          // distributed than a plain hash, which is what matters for band-breaking.
          // ⚠ `screenCoordinate` here is the AP TARGET's pixel, not the screen's,
          // which is what we want: the lattice must decorrelate per MARCH pixel.
          const jitter = ATMO_MARCH_JITTER
            ? screenCoordinate.x
                .mul(0.06711056)
                .add(screenCoordinate.y.mul(0.00583715))
                .fract()
                .mul(52.9829189)
                .fract()
            : float(SAMPLE_SEGMENT_T);

          Loop(MAIN_STEPS, ({ i: s }: { i: Node }) => {
            const tNew = tMax.mul(float(s).add(jitter).div(MAIN_STEPS));
            // .toVar() MATERIALISES dt = tNew - t_old HERE, before t is
            // reassigned below. Without it, `dt` is a live node referencing the
            // variable `t`; since `t.assign(tNew)` runs before dt is consumed,
            // dt would evaluate to tNew - tNew = 0 → sampleT=1 → Sint=0 → the
            // entire in-scatter integral collapses to zero (the invisible-
            // atmosphere bug).
            // ⚠ FIXED segment length, so ∑dt = tMax exactly and the jitter cannot
            // modulate total optical depth (see ATMO_MARCH_JITTER). The legacy path
            // keeps the old sample-position-as-segment-end scheme bit-exact.
            const dt = (
              ATMO_MARCH_JITTER ? tMax.div(float(MAIN_STEPS)) : tNew.sub(t)
            ).toVar();
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
              .mul(sunVis)
              .mul(uMsScale);
            // L2 god rays: the direct term is additionally cloud-shadowed (BSM).
            const S = shadowedSunScatter(P, earthShadow, Tsun, phaseScat, msContrib);
            const Sint = S.sub(S.mul(sampleT)).div(m.extinction.max(1e-6));
            L.addAssign(throughput.mul(Sint));
            throughput.mulAssign(sampleT);
          });

          // Occlude the glow behind a near-side ring (ringGlowKeep=1 when none).
          // Background (sceneColor) already has the ring composited in Pass 1
          // and stays attenuated by the full-path throughput — only the ADDED
          // in-scatter is ring-occluded.
          const Lvis = L.mul(ringGlowKeep);
          if ((DEBUG_ATMOSPHERE as string) === "inscatter") {
            marched.assign(vec4(Lvis, 0));
          } else if (AP_DEBUG_BLIT) {
            // Debug builds resolve to final pixels here (alpha 0 = pass through).
            marched.assign(vec4(sceneColor.mul(throughput).add(Lvis), 0));
          } else {
            // Ship path: emit AP. `a` is the MEAN transmittance, the same packing
            // getAtmosphereFroxel and getSkyViewLUT already use; the apply pass
            // expands it back to per-channel via uTSpectralK.
            const Tmean = throughput.x.add(throughput.y).add(throughput.z).div(3);
            marched.assign(vec4(Lvis, Tmean));
          }
        };

        if ((DEBUG_ATMOSPHERE as string) === "off") {
          // Sky-View LUT for sky rays + altitude crossfade to the march. Ground
          // rays and the crossfade band march; low-altitude sky skips the march.
          If(
            groundHit.or(uSkyViewBlend.greaterThan(0.001)).and(tMax.greaterThan(0)),
            runMarch,
          );
          // Sky-View LUT lookup for sky rays (skipped once fully in march mode).
          // Cloud-shadow shafts come baked in the LUT (see the bake's KNOWN
          // LIMITATION note — per-pixel corrections tried and reverted).
          // The LUT already stores (L, Tmean), so in AP form this is a straight
          // copy — no scene multiply here any more.
          const lutOut = (
            AP_DEBUG_BLIT ? vec4(sceneColor, 0) : vec4(0, 0, 0, 1)
          ).toVar();
          If(tGround.lessThanEqual(0).and(uSkyViewBlend.lessThan(0.999)), () => {
            const sky = sampleSkyView(rd, ro);
            if (AP_DEBUG_BLIT) {
              lutOut.assign(vec4(sceneColor.mul(sky.Tmean).add(sky.L), 0));
            } else {
              lutOut.assign(vec4(sky.L, sky.Tmean));
            }
          });
          // The crossfade stays valid in AP form: `scene·T + L` is linear in both
          // T and L, so mixing the (L, T) pairs and then applying is identical to
          // applying each and then mixing the pixels.
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
        const msContrib = getMultipleScattering(P, uSunDir).mul(m.scattering).mul(sunVis).mul(uMsScale);
        // L2 god rays: the direct term is additionally cloud-shadowed (BSM).
        const S = shadowedSunScatter(P, earthShadow, Tsun, phaseScat, msContrib);
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
          const msContrib = getMultipleScattering(P, uSunDir).mul(m.scattering).mul(sunVis).mul(uMsScale);
          // L2 god rays: the direct term is additionally cloud-shadowed (BSM).
          // KNOWN LIMITATION: baked into this 200×256 LUT, shafts quantize to
          // its (azimuth, elevation) lattice → soft curved bands on the
          // low-altitude sky. Two per-pixel replacements were tried and BOTH
          // failed in-engine (work log 2026-07-14 FIX 2/3 REVERTED — a
          // multiplicative near-field factor black-banded the horizon; an
          // additive near-field delta didn't cure it and cost more). Revisit
          // only with proper in-engine bisection; candidates: GODRAYS_SKY_MARCH
          // as a quality tier, higher LUT res, froxel-carried sky shadow.
          const S = shadowedSunScatter(P, earthShadow, Tsun, phaseScat, msContrib);
          const Sint = S.sub(S.mul(sampleT)).div(m.extinction.max(1e-6));
          L.addAssign(throughput.mul(Sint));
          throughput.mulAssign(sampleT);
        });
      });
    });

    const Tmean = throughput.x.add(throughput.y).add(throughput.z).div(3);
    return vec4(L, Tmean);
  });

  // ── Aerial-perspective apply fragment (full res) ───────────────────────────
  // The cheap half of the split: one bilinear tap of the AP target, one tap of
  // the scene, `scene·T + L`. No loop, no LUT fetches, no ray/sphere maths — this
  // is what lets the expensive half run at AP_RES_SCALE.
  //
  // Because the scene tap is FULL RES and enters multiplicatively, every hard
  // edge in the scaled scene (terrain silhouette, the planet's limb against
  // space, stars) keeps its own pixel. Only L and T — both smooth by
  // construction — carry the upsample.
  const applyFragment = Fn(() => {
    const sceneColor = texture(inputTexture, screenUV).rgb;
    const apSample = texture(apRT.texture, screenUV).toVar();
    const T = AP_SPECTRAL_TRANSMITTANCE
      ? // Exact at a = 1 and for a grey atmosphere. max() keeps pow away from a
        // negative base, which bilinear filtering of an HDR target can produce
        // next to a sharp edge in L.
        powVec3(apSample.a.max(0), uTSpectralK)
      : vec3(apSample.a);
    return vec4(sceneColor.mul(T).add(apSample.rgb), 1);
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
  const ap = makeScene(apFragment);
  const apply = makeScene(applyFragment);

  // Pass names for the per-pass GPU profiler (perf/perfProfiler.ts): three's
  // inspector hook reports each render context under its scene's name, and each
  // compute dispatch under its node's name. The two static LUT bakes share one
  // label — they are a single one-shot cost.
  transmittanceBake.scene.name = PASS.atmoLUT;
  multiScatterBake.scene.name = PASS.atmoLUT;
  skyViewBake.scene.name = PASS.skyView;
  ap.scene.name = PASS.atmosphere;
  apply.scene.name = PASS.atmoApply;
  froxelBake.name = PASS.froxel;

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
    // uSunIlluminance is NOT set here — it is dynamic (1/r² on the body's live
    // distance to its star) and is written in updateUniforms() from the
    // AtmosphereBodyRecord. See docs/LIGHTING_PLAN.md §3.0.

    // Spectral exponent for the AP apply pass (see AP_SPECTRAL_TRANSMITTANCE).
    // Take each species' VERTICAL COLUMN — coefficient × the thickness over which
    // it acts — so the ratio reflects the optical depth a real path accumulates
    // rather than the ground-level coefficient. Ozone rides a box of full width
    // 2·halfWidth; the well-mixed gas absorber rides the Rayleigh profile (see
    // uGasAbsorption). Then normalise so the mean exponent is 1, which makes the
    // reconstruction the identity for a grey atmosphere.
    const HR = p.rayleighScaleHeightKm;
    const HM = p.mieScaleHeightKm;
    const WO = p.ozoneWidthKm;
    const tau = [0, 1, 2].map(
      (c) =>
        (p.rayleighScattering[c] + p.gasAbsorption[c]) * 1000 * HR +
        (p.mieScattering[c] + p.mieAbsorption[c]) * 1000 * HM +
        p.ozoneAbsorption[c] * 1000 * WO,
    );
    const tauMean = (tau[0] + tau[1] + tau[2]) / 3;
    if (tauMean > 0) {
      uTSpectralK.value.set(tau[0] / tauMean, tau[1] / tauMean, tau[2] / tauMean);
    } else {
      uTSpectralK.value.set(1, 1, 1);
    }
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
    // Restored to 1 after the 2026-08-13 ground-truth march ablation.
    //
    // ⚠ THE ATMOSPHERE MARCH IS DONE AS AN OPTIMISATION TARGET. Setting this to 0
    // deletes the entire march (both passes still run, targets unchanged, apply does
    // `scene·1 + 0`) and MEASURED only **−2.56 ms** of frame time across six rows
    // (earth_8 15.30 → 12.70). That is the hard ceiling on everything this march could
    // ever give — and it is ≈ the 2.17 ms step-work term, so **the march has no
    // meaningful fixed cost of its own.**
    //
    // The "~3.5 ms fixed cost" chased over three rounds was substantially a MEASUREMENT
    // ARTIFACT: with the march off these passes still *report* 4.07 ms at earth_8
    // (gpu/frame 3.3, saturated, spans overlap) but only 0.38 ms at deep_space
    // (gpu/frame 0.8, unsaturated) — same passes, same targets, same full-res writes.
    //
    // LESSON: when gpu/frame > 1.15, ABLATE. Do not do arithmetic on reported per-pass
    // numbers, however self-consistent the model looks. One ablation settled in a single
    // sweep what three rounds of curve-fitting got wrong. See docs/PERF_MEASUREMENT.md.
    uActive.value = 1;
    // Per-frame sun illuminance (1/r² on the LIVE body→star distance). Must be
    // written before bakeSkyView(), which multiplies it into the LUT.
    uSunIlluminance.value.copy(dominant.sunIlluminance);
    uCameraMatrixWorld.value.copy(scaledCamera.matrixWorld);
    uTanHalfFov.value = Math.tan((scaledCamera.fov * Math.PI) / 180 / 2);
    uAspect.value = scaledCamera.aspect;
    // Camera relative to planet centre, scaled→km (÷ SCALED_UNITS_PER_KM).
    _camToPlanet
      .copy(scaledCamera.position)
      .sub(dominant.centerScaled)
      .multiplyScalar(1 / SCALED_UNITS_PER_KM);
    uCameraPlanetKm.value.copy(_camToPlanet);
    // ── D14b: ground-silhouette AA band, in km of impact parameter ───────────
    // ⚠⚠ MUST BE AFTER `_camToPlanet` IS POPULATED. This block first sat ~10 lines
    // EARLIER, before the copy below it — so frame 1 read a zero vector
    // (`rCam = 0` ⇒ `tangentKm = 0` ⇒ half-width 0 ⇒ the smoothstep degenerated to a
    // hard step) and every later frame read a one-frame-stale camera. A uniform whose
    // value is computed from another uniform's SOURCE has an ordering dependency that
    // nothing in the type system can see.
    //
    // `db⊥ = dθ · √(r² − Rg²)`, and one MARCH pixel of angle is
    // `2·tan(fov/2) / apHeight` (tan, not angle — the projection is linear in tan).
    // ⚠ apHeight, not the screen height: the branch is evaluated at AP_RES_SCALE and
    // a band narrower than one march pixel would alias again.
    {
      const rCam = _camToPlanet.length();
      const rg = uBottomRadius.value;
      const tangentKm = Math.sqrt(Math.max(rCam * rCam - rg * rg, 0));
      const tanPerMarchPx = (2 * uTanHalfFov.value) / Math.max(apHeight, 1);
      uSilhouetteHalfWidthKm.value =
        SILHOUETTE_AA_MARCH_PX * tanPerMarchPx * tangentKm;
    }
    uSunDir.value.copy(dominant.sunDir);

    // Sky-View crossfade (sky rays): pure LUT at/below FULL_ALT (march skipped),
    // pure per-pixel march at/above MARCH_ALT (the LUT degenerates from space).
    // MUST match the bake gate: when SKYVIEW_ENABLED is false the LUT is never
    // baked, so force blend=1 (march everywhere) — else sky rays would sample a
    // stale/never-baked LUT. This makes USE_SKYVIEW=false a clean full-march
    // fallback (the LUT sample is a never-taken uniform branch → ~zero cost).
    const altKm = _camToPlanet.length() - dominant.params.groundRadiusKm;
    // GODRAYS_SKY_MARCH: blend=1 forces the per-pixel march for sky rays →
    // crisp per-pixel sky shafts instead of the LUT's 200×256 smear. Perf
    // toggle (re-spends the Phase-4 sky-march savings) — default off.
    uSkyViewBlend.value =
      SKYVIEW_ENABLED && !(GODRAYS && GODRAYS_SKY_MARCH)
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

  // Render the atmosphere into `target`: march AP at AP_RES_SCALE, then apply it
  // to the full-res scene. Two passes so the expensive one is the small one — see
  // AP_RES_SCALE. `autoClear` is set for each because both write every pixel of
  // their target, and the caller's state is not assumed.
  //
  // ⚠ KEEP THESE TWO BACK-TO-BACK. There is a ~2.4 ms fixed cost in this pass that
  // scales with neither resolution nor step count (docs/PERF_MEASUREMENT.md
  // § "A ~3 ms FIXED COST"). It looked exactly like a write→read flush stall — the
  // apply samples the target the march just wrote — so on 2026-08-11 the two were
  // split and the whole cloud pipeline (~17 ms, provably independent) was moved
  // into the gap. **That was MEASURED and REVERTED: it made every scenario 0.3–0.7 ms
  // SLOWER, including the clouds-off control row where nothing moved into the gap
  // at all.** The fixed cost is not an inter-pass stall, and separating these two
  // costs cache locality on `apRT` — the apply wants it while it is still warm. Do
  // not re-litigate without reading that section.
  const render = (renderer: WebGPURenderer, target: RenderTarget) => {
    renderer.setRenderTarget(apRT);
    renderer.autoClear = true;
    renderer.render(ap.scene, camera);
    renderer.setRenderTarget(target);
    renderer.autoClear = true;
    renderer.render(apply.scene, camera);
    renderer.setRenderTarget(null);
  };

  const dispose = () => {
    quad.dispose();
    transmittanceBake.mat.dispose();
    multiScatterBake.mat.dispose();
    skyViewBake.mat.dispose();
    ap.mat.dispose();
    apply.mat.dispose();
    apRT.dispose();
  };

  return {
    render,
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
