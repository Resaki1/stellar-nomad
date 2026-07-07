import * as THREE from "three";
import { NodeMaterial, StorageTexture } from "three/webgpu";
import {
  Fn,
  If,
  Loop,
  Break,
  uniform,
  texture,
  texture3D,
  textureStore,
  screenCoordinate,
  positionLocal,
  positionWorld,
  cameraPosition,
  normalWorld,
  normalize,
  vec2,
  vec3,
  vec4,
  float,
  int,
  uint,
  uvec2,
  instanceIndex,
  dot,
  sub,
  clamp,
  length,
  mix,
  smoothstep,
  exp,
  fract,
  sin,
  pow,
  PI,
} from "three/tsl";
import { kmToScaledUnits } from "@/sim/units";
import { PLANET_RADIUS_KM } from "@/sim/celestialConstants";
import type { ExtraMeshContext, ExtraMeshDef } from "../types";
import {
  getGpuCloudBaseVolume,
  getGpuCloudDetailVolume,
  getGpuCloudDetailMip1,
  queueCloudBake,
  tslHash3,
} from "./cloudVolumeCompute";
import { detileBlend, USE_DETILE, baseDilate } from "./cloudDetile";
import {
  cloudHeightProfile,
  deriveCloudType,
  deriveTopAlt,
  topAltSpread,
  topHeightToTopAlt,
  WEATHER_V2,
} from "./cloudShared";
import { getSyntheticWeatherMapV2 } from "./weatherMapV2";
import {
  CLOUD_SUN_SCALE,
  CLOUD_SKY_SCALE,
  CLOUD_SKY_AMBIENT,
  COVERAGE_GAMMA,
  equirectDirToUv,
  makeEquirectTextureField,
  farCloudLit,
  type CloudFieldProvider,
} from "./cloudCommon";
import { EARTH_ATMOSPHERE } from "./atmosphereData";
import { STBN_PERIOD_XY } from "./stbnTexture";
import { CLOUD_LAYER } from "@/components/space/renderLayers";
import {
  setupCloudPipeline,
  setEarthMatrixWorldSource,
  USE_LIGHT_VOLUME,
} from "@/components/space/cloudFullscreenPass";
import {
  getAtmosphereLUTs,
  transmittanceLutUv,
} from "@/components/space/atmospherePass";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

// Troposphere-ish slab. Photoreal-leaning, not exaggerated.
const CLOUD_INNER_ALTITUDE_KM = 1;
const CLOUD_OUTER_ALTITUDE_KM = 14;

// Base / per-column noise scales (1 scaled unit = 1000 km). SHARED by the
// marcher's uBaseScale/uColumnScale uniforms AND the far-shell's macro-coverage
// model (columnMacroCoverage), so both sample the noise identically → the
// shell's coverage matches the volumetric footprint by construction.
const BASE_SCALE = 50;
const COLUMN_SCALE = 30;

// Altitude (km) of the far-field cloud SHELL sphere (ISSUE 2 Phase 2). Defaults
// to the cloud-top (CLOUD_OUTER_ALTITUDE_KM) so the shell's clouds sit at the
// same altitude as the volumetric cloud tops → correct parallax + a seamless
// hand-off. DIAGNOSTIC: because the shell is 14 km above the ground, it shows
// real parallax vs the surface under motion (the old ground-painted overlay had
// none). To check whether the "stutter" the shell shows on fast approach is that
// parallax vs a genuine bug, temporarily set this to ~1: if the differential
// motion / stutter drops roughly 14×, it's parallax (expected); if unchanged,
// it's a real transform/render issue and needs a different fix.
const SHELL_ALTITUDE_KM = CLOUD_OUTER_ALTITUDE_KM;

// ── Distance-based near/far hand-off (ISSUE 2 step 7) ────────────────────────
// The shell is the FAR representation; the volumetric owns the NEAR field. Fade
// the shell IN by camera-to-fragment distance so it vanishes close to the camera
// (where the volumetric renders — incl. its over-eroded gaps, so no flat-vs-3D
// backfill) and only carries the far HORIZON the volumetric can't reach. This is
// the Star-Citizen near-volumetric / far-flat split (case #22 deferred). Because
// the shell is a sphere, the sub-camera point is near (faded) while the limb is
// far (full), so the hand-off tracks altitude for free: from orbit the whole
// shell is far (full); descending, the below-camera field hands to the volumetric
// while the horizon stays shell. Tune so FAR ≈ where the volumetric becomes the
// reliable near-field authority (~the volumetric-blend-full altitude) and NEAR ≈
// the volumetric's confident dense reach. In km (camera→fragment distance).
const SHELL_HANDOFF_NEAR_KM = 1000; // ≤ this from camera → shell fully OFF (volumetric owns)
const SHELL_HANDOFF_FAR_KM = 2500; // ≥ this → shell FULL (far horizon)

// ── Shell analytic envelope + expected-opacity transfer (2026-07-06/07) ──────
// The measured (SHELL_DEBUG_VIZ) diagnosis of the two shell bugs:
//   • FLICKER: the shell's per-pixel mip-0 3D noise taps (base/carve/column)
//     are sub-pixel at every distance the shell renders (carve cells 0.5–1.5 km
//     vs ≥0.6 km/px footprint) — frizz + moiré rings, confirmed by the tap
//     ladder ('carve' worst) and by 'noiseFree' killing it.
//   • LOW-COVERAGE ABSENCE: what the marcher shows from orbit in low-coverage
//     regions is sparse NEAR-OPAQUE puffs covering a FRACTION of the area (it
//     Beer-Lambert-saturates the eroded density, and samples the low altitude
//     band the shell's old {0.3,0.55,0.8} ladder missed). Point-sampling the
//     noise cannot represent an area fraction.
// FIX (the "analytic now, bake later" decision — see docs/CLOUD_REVIEW_2026-07):
// the shell samples NO 3D noise per frame. Its alpha is the STATISTICAL
// EXPECTATION of the marcher's rendered opacity over the pixel footprint, as a
// function of the smooth dimensional profile `dimProfile = coverage·height`:
//   alpha(dimProfile) = E_noise[ 1 − exp(−eroded·OPTICAL_PATH) ],
//   eroded = saturate(dimProfile − (1−carved)·K_EFF)
// Monte-Carlo'd from the REAL noise volumes into a 256×1 LUT at load
// (getShellOpacityLUT). This is the KEY fix over the 2026-07-06 survival-CCDF:
// the CCDF counted P(eroded>0) so it over-weighted invisibly-thin density (low
// coverage read gray, and no single exponent could pull the low end down while
// keeping the high end opaque — the measured N=1 vs 0.08 dilemma). Weighting by
// Beer-Lambert opacity makes thin→transparent and thick→opaque BY CONSTRUCTION.
// Any noise/erosion rework re-derives the curve automatically at next load.
//
// Sample altitudes for the height profile (pure ALU — no noise taps): the low
// band 0.1 is REQUIRED (stratus/low-sc live at alt01 0.0–0.25; its absence was
// half the low-coverage bug — validated via 'profileMaxLow').
const SHELL_ALT_SAMPLES = [0.1, 0.3, 0.55, 0.8] as const;
// topAlt column tap replacement: the hybrid baseVolume.r's ~p50 (measured
// 0.48/0.71/0.89 p10/p50/p90 — see TOPALT_LINEAR). A constant mid value, NOT a
// noise tap ('colSample' frizzes from orbit); only sways the cumulus top fade.
// 0.65 is the value the user validated visually via the 'noiseFree' test.
const SHELL_COL_SAMPLE = 0.65;
// Effective optical path (× eroded density) baked into the opacity LUT — the
// ONE calibration knob (replaced the failed SHELL_SURVIVAL_LAYERS exponent).
// Sets how quickly eroded density saturates to opaque: alpha per sample =
// 1−exp(−pow(eroded, DENSITY_GAMMA)·OPTICAL_PATH), meaned over the noise. RAISE
// → fuller/harder-edged far field, LOWER → softer/thinner. Because it lives
// inside the exp(), it shapes low vs high coverage correctly at ALL values, not
// as a global multiply. EMPIRICAL (2026-07-07): 1 gives the seamless
// orbit→surface transition — the marcher's apparent orbital opacity is quite
// translucent, so the shell must be too. (Started at 18 ≈ opaque; that made the
// far field far denser than the volumetric it hands to.) Tune ~1–5.
const SHELL_OPTICAL_PATH = 1;

// ── SHELL debug visualisation ────────────────────────────────────────────────
// Replaces the shell's output with a false-colour scalar (alpha=1, no lighting,
// no distFade/uShellOpacity — visible at ANY camera distance) so each stage of
// columnMacroCoverage can be inspected in isolation. These drove the 2026-07-06
// diagnosis (results in docs/CLOUD_REVIEW_2026-07.md) and stay as regression
// diagnostics. (The old 'noiseFree' test mode IS the normal path now.)
//
//   'off'         : normal shell rendering.
//   'rawCoverage' : the weathermap tap (auto-mip), pre-gamma. Expected smooth +
//                   stable at every distance (14-mip KTX2) — measured ✓.
//   'profileMax'  : max cloudHeightProfile over SHELL_ALT_SAMPLES (real
//                   cloudType, const topAlt; NO coverage multiply). Should be
//                   nonzero everywhere (the 0.1 tap carries every type:
//                   stratus=1, sc≈0.35, cum≈0.5) — measured ✓ ("light-gray
//                   everywhere").
//   'maxDim'      : coverage × profileMax — the dimensional-profile input to
//                   the opacity transfer (the LUT's index axis).
//   'opacity'     : the LUT output = E_noise[1−exp(−eroded·OPTICAL_PATH)] at
//                   maxDim (the shell's final coverage before lighting/fades).
//                   All-black despite nonzero maxDim → the LUT bake never
//                   dispatched (texture still zero-filled — the timing bug the
//                   unconditional flushCloudBakes fixed).
//   'colSample' / 'baseMacro' / 'carve' :
//                   the three RETIRED per-pixel 3D noise taps (column tap /
//                   dilated base / carve-Worley mix at slab-mid alt). Kept as
//                   the aliasing ladder: all three frizz + moiré-ring from
//                   orbit (measured 2026-07-06, carve worst — its 0.5–1.5 km
//                   cells are sub-pixel at every shell distance), which is WHY
//                   the normal path samples NO 3D noise anymore.
//
// The volumetric marcher still composites OVER these visualisations. View near
// nadir; the atmosphere pass tints the limb.
const SHELL_DEBUG_VIZ:
  | "off"
  | "rawCoverage"
  | "profileMax"
  | "maxDim"
  | "opacity"
  | "colSample"
  | "baseMacro"
  | "carve" = "off";

// Ray-march config. MUST be constants — TSL Loop count is baked into the shader.
//
// Two-state adaptive march (Nubis C1+C2). Skip mode advances at dtSkip
// (~slab/16 ≈ 800 m) using a cheap base-shape probe; on first hit, rewinds
// half a long step and switches to dense mode at dtDense (~dtSkip/4
// ≈ 200 m) which does the full Schneider density + cone light march +
// accumulation. After EMPTY_THRESHOLD consecutive dense-mode empty samples,
// the march drops back to skip mode. Empty pixels finish in ~16 cheap
// probes; pixels through dense bodies get 4× finer sampling without paying
// the dense-mode cost outside cloud bodies.
const MAX_PRIMARY_STEPS = 256;
// Fixed skip-mode step size in scaled units (1 scaled unit = 1000 km).
//
// Earlier this was `dtSkip = slabLen / 16` (adaptive). That's the wrong
// relationship: cumulus towers have constant world-space size (~1–3 km
// wide), so step size must also be in world space.
//
// NOTE (2026-06-01): tried 0.0001 (100 m) to refine thin-feature detection —
// REFUTED. It did NOT reduce the flicker (sparseOnly flickers identically at
// any skip size), and the finer near-steps exhausted the 96-step budget before
// reaching the horizon (close-only clouds + skip-grid stripes). So the skip
// step governs REACH, not the flicker. 0.001 (1 km) gives horizon reach at all
// camera heights with no stripes. The flicker source is elsewhere — the
// per-voxel altitude hash (see altPerturb below).
const SKIP_STEP_SCALED = 0.0001;
// dtDense / dtSkip ratio. 0.25 = 4× finer sampling inside cloud bodies than
// the skip step. Worst-case cumulative dense-step traversal: 96 × dtDense,
// roughly slab thickness — enough to push through a dense column when the
// empty-streak fallback never fires.
//
// NOTE (2026-06-01): tested finer (0.0625, 0.00125) during edge-noise
// debugging — NO help on the flicker, and it shrinks clouds (96 ultra-fine
// steps cover almost no distance → budget exhausted before exiting the cloud).
// Proved the variance is in DETECTION (skip), not integration (dense). Kept at
// 0.25.
const DENSE_STEP_RATIO = 0.25;
// Consecutive dense-mode empty samples before falling back to skip mode.
// 8 × dtDense = 1 km of empty space tolerated inside dense mode before
// a switch — keeps cloud-body holes from triggering ping-pong, but falls
// back fast enough not to waste short steps on truly-empty post-cloud
// columns. (Was briefly 12 alongside the step caps; reverted with them.)
const EMPTY_THRESHOLD = 4;
// ── Distance-adaptive step LOD (Step 1, 2026-05-30) ──
// Step size grows with camera distance `t` (scaled units, 1 = 1000 km) so the
// fixed MAX_PRIMARY_STEPS budget spans the whole visible range instead of dying
// at ~26 km (256 × 100 m). Near the camera lodScale ≈ 1 → fine ~100 m steps
// (cumulus detail); far away it grows → coarse steps (distant clouds present,
// blurry, cheap). CAPPED per-ray (lodCap) so the growth can never over-step a
// thin slab — orbit looking straight down at the 14 km shell still gets at
// least uLodMinSamples samples through it.
//   lodScale = min(1 + t · LOD_STEP_GROWTH,  slabLen / (dtSkip · uLodMinSamples))
// Tune with DEBUG_VIZ = 'lod' (step-size ramp) + 'iters' (budget usage).
// 2026-05-30: tuned empirically to 800 (DEBUG_VIZ='whyStop' showed RED =
// budget-cutoff creeping in from the horizon as you descend into the layer;
// 800 pushes it past the horizon). Why so high — three reasons the naive
// skip-mode reach estimate (~120) missed:
//   1. Dense mode is 4× finer (dtDense = 0.25·dtSkip). The budget-eating
//      segment of a grazing ray is the stretch THROUGH cloud bodies = dense,
//      so the effective reach-per-step there is ~4× smaller → needs ~4× more k.
//   2. Grazing paths to the horizon are 500–1500 km from altitude / the limb,
//      not the ~250 km a mid-altitude estimate assumes.
//   3. The per-ray cap (lodCap) makes a large global k nearly free: it only
//      FIRES on long grazing paths (where huge steps are wanted) and is clamped
//      everywhere else, so the right value is just "whatever reaches the
//      worst-case grazing path." Only downside is distant blur (intended LOD).
const LOD_STEP_GROWTH = 400;
// Minimum samples forced through any slab crossing (the lodCap denominator) is
// now the `uLodMinSamples` UNIFORM, lerped per frame between these two values
// by camera altitude above the cloud tops (see cloudFullscreenPass.ts):
//   near/inside the deck (alt < MIN_SAMPLES_NEAR_ALT_KM) → LOD_MIN_SAMPLES_NEAR
//   high above            (alt > MIN_SAMPLES_FAR_ALT_KM) → LOD_MIN_SAMPLES_FAR
// Rationale: 60 forced samples are needed near the deck where the vertical
// profile carries visible structure; from a couple hundred km up the carve /
// WISP / HHF detail is distance-faded out (see DETAIL_FADE_*), so only the
// macro billow form is left and a handful of samples resolve it — at far less
// march cost exactly where the planet disk fills the whole screen.
// Tuned 2026-06-22 (Issue ③, orbit-perf valley ~200–250 km up: full-screen
// broken deck, shallow grazing rays, no early-out, lodCap-bound — confirmed by
// LOD_STEP_GROWTH having zero FPS effect there, uLodMinSamples being the only
// lever). FAR_ALT 800 → 200 so the floor is reached across the valley; FAR
// floor 24 → 8 (sweet spot by eye: no visible cloud loss, ~69 → ~87 fps). NEAR
// stays 60 for detection (Issue ④). Going below 8 risks thin-cloud detection.
export const LOD_MIN_SAMPLES_NEAR = 60;
export const LOD_MIN_SAMPLES_FAR = 8;
export const MIN_SAMPLES_NEAR_ALT_KM = 50;
export const MIN_SAMPLES_FAR_ALT_KM = 200;
// ── In-cloud step growth (budget-death fix, 2026-06-10/11) ──
// Flying INTO a large cloud used to kill every cloud behind it: dense mode
// steps ~25 m near the camera, so 256 steps cover only ~6 km before the budget
// dies (DEBUG_VIZ='whyStop' → RED) — all further clouds vanish until the
// camera exits the body, exactly the "other clouds disappear when I fly close
// to a cloud" symptom. Fix: scale the dense step by TWO terms,
//   dtDenseEff = dtDenseL × (1 + (1−T)·DENSE_OPACITY_GROWTH
//                              + denseIters·DENSE_ITER_GROWTH)
// 1. Accumulated opacity (1−T): once the pixel is mostly covered, the
//    remaining samples only modulate the last few % of alpha, so coarsening
//    them is invisible. This alone FAILED for WISPY bodies (2026-06-11 user
//    report: mid-distance clouds still vanished while touching a cloud) —
//    low density keeps T high, the step stays fine, the budget still dies.
// 2. Dense-iteration count: prolonged dense marching coarsens regardless of
//    opacity — a deep-march LOD. Fresh cloud fronts (low denseIters) keep
//    full resolution; by 64 dense steps (~1.6 km in) the step has doubled.
//    Worst-case all-dense reach: 25 m × Σ(1+n/32) ≈ 32 km (was 6.4 km),
//    after which the empty-streak fallback + grown skip steps take over.
// Banding risk from coarse in-body steps is confined to deep/wispy interiors
// where accumulated alpha + the EMA hide it; surfaces stay finely sampled.
const DENSE_OPACITY_GROWTH = 3;
const DENSE_ITER_GROWTH = 1 / 32;
// ── Coverage-adaptive detection / integration caps (2026-06-11) ──
// THE "small clouds fade in at close range" fix. Where the per-ray lodCap
// stops binding (DEBUG_VIZ='lod': the red→gray boundary — which the user
// observed aligns exactly with where small clouds fade out), the step jumps
// to the raw 1 + t·LOD_STEP_GROWTH: skip steps grow past small cloud bodies
// (detection becomes a per-frame coin flip → EMA ghosts that "fade in" as
// you approach) and dense steps grow to multiple km (a detected 2 km body
// gets ≤1 sample → faint noise). Large bodies survive — they exceed the
// step — which produced the "big clouds at the horizon, small ones only
// near" signature.
//
// Fix: world-space caps that bind ONLY where clouds can exist, so empty
// space keeps the full grown stride (horizon reach, the reason the growth
// exists at all):
//   • dtSkipInBand = min(grown, SKIP_DETECT_CAP) — the skip ADVANCE uses
//     this wherever profile > 0.01 (per-step coverage × height envelope says
//     cloud is possible here); outside the band the advance stays uncapped.
//     1.5 km ≈ the smallest macro feature the far field renders (the carve
//     lump scale; finer detail is distance-faded anyway).
//   • dtDenseL = min(grown, DENSE_INTEG_CAP) — a DETECTED body is never
//     integrated coarser than 750 m, so a small body gets a stable handful
//     of jittered samples instead of one noisy one. 750 m is the
//     historically-validated "always looked clean" dense step (the old
//     DENSE_LOD_CAP=3 note).
//
// History: absolute step caps were tried 2026-06-03 (SKIP_LOD_CAP /
// DENSE_LOD_CAP) and reverted for "motion-dependent cut-in-half gaps" —
// that variant capped dense at 75 m with NO budget protection, so the march
// died inside bodies (cut-in-half = budget death mid-body). This variant
// caps 10× coarser, applies the skip cap only in-band, and sits on top of
// the opacity/iteration growth terms + the T early-exit, which bound the
// dense spend. Worst case (continuous in-band haze to the horizon) the
// in-band reach is ~256 × 1.5 km ≈ 380 km before budget cutoff — beyond
// the practical visible range of km-scale features; the far field there is
// carried by the thin-coverage 2D overlay.
const SKIP_DETECT_CAP_SCALED = 0.0015; // 1.5 km
const DENSE_INTEG_CAP_SCALED = 0.00075; // 750 m
// ── Data3DTexture mips on the GPU: FIXED by patches/three@0.183.2.patch ──
// Stock three (≤ r184) allocates mipLevelCount = texture.mipmaps.length but
// its Data3DTexture upload path writes ONLY level 0 (slice by slice;
// texture.mipmaps is never transferred) — WebGPU zero-initializes the rest,
// so any .level(>0) sample blended toward ZERO. A footprint-matched mip lod
// lived here 2026-06-10/11 and was the root cause of "small clouds fade in
// at close range / only big decks at the horizon"; the SAME zero-mips also
// explain the 2026-06-03 "mips drop coverage / clouds morph" revert
// (misdiagnosed then as box-filter variance loss — noiseVolumes.ts carries
// the variance-renormalized chain). Diagnosed via the maxProfile (band
// sampled everywhere) vs maxProbeShape (field empty at range) DEBUG_VIZ
// pair. See CLOUD_DEBUGGING_LESSONS case study #16.
// As of 2026-06-11 the pnpm patch uploads the full mipmaps[] chain
// (verified via the /dev/mip3d-test readback page), so .level(>0) is SAFE.
//
// (The footprint-matched detail mip LOD — DETAIL_MIP_DIST_K/MAX, `detailLod` —
// was removed 2026-06-18 with the old opacity-only detail-erosion tap it served.
// The current detail comes from baseShapeCarved's FINE_CARVE at level 0.)
//
// Dead-end notes for four removed zero-valued knobs (PROFILE_BLUR_K,
// ALT_DITHER_K, START_JITTER_FRAC, LOD_DITHER — all empirically refuted as
// band fixes, see git history 2026-06-01..03): profile-envelope blur did not
// soften far bands; altitude dither had no effect; start-grid jitter traded
// bands for flicker; LOD-growth dither only added body noise.
// Per-pixel dither amplitude, as a FRACTION of one skip step (dtSkip). The
// dither jitters each ray's march start to decorrelate the skip-grid across
// pixels — without it, skip-mode sampling produces concentric iso-distance
// "miss-rings". Historically full-amplitude (1.0): lower values reintroduced
// those rings. BUT that full ~500 m jitter is ALSO what scatters the
// silhouette detection (pixel-to-pixel AND frame-to-frame): the near-binary
// alpha cliff at a cloud edge gets sampled at a randomly-shifted position each
// time, producing the "spray of speckle into the sky" the edge screenshots
// show. (Confirmed not detail-erosion — disabling it left the spray intact.)
//
// REPURPOSED (2026-06-01): this is now the PER-SAMPLE stratified-jitter
// strength (see `stratJitter` in the march loop), NOT the old coherent
// whole-march offset. 1.0 = jitter each sample across its full local step
// (Frostbite §5.5.3). Because the offset is per-sample + per-step (a
// low-discrepancy sequence), it breaks both the skip-grid stripes and the LOD
// sample-count bands WITHIN a single frame, at much lower variance than the
// old coherent offset — so 1.0 no longer means "noisy". Lower it only if edges
// still get noisy; raise toward 1.0 if bands reappear.
const DITHER_FRACTION = 1.0;
// ── Anti-tiling domain warp (2026-06-10) ──
// The base volume tiles every 1000/uBaseScale km (= 20 km at 50) with only 4
// low-frequency Worley cells per tile — from a few hundred km up the SAME
// 4-cell pattern visibly repeats in rows across the planet (the user's orbit
// screenshot). Fix: offset the base-volume sample position by a vector built
// from the column tap's UNUSED g/b/a channels (the per-column tap at
// uColumnScale = 8 → 125 km period is already fetched every step for topAlt,
// so the warp is FREE — no extra fetch). A ±WARP_AMPLITUDE offset that varies
// at 125 km scale means neighbouring base tiles no longer line up → the 20 km
// periodicity is destroyed while local shapes are untouched (the warp is
// near-constant across any single cloud body). Static field in earth space →
// no morphing under camera motion. Amplitude in scaled units; 0.01 = 10 km =
// half a base tile, enough to fully decorrelate adjacent tiles.
const WARP_AMPLITUDE = 0;
// ── Local lump self-shadow for the light-volume path (2026-06-10) ──
// The 3D light volume stores MACRO sun transmittance at 4.7 km (tangent) ×
// ~0.5 km (altitude) voxels — switching to it from the 6-tap cone lost the
// per-lump (~1-3 km carve-scale) self-shadow that gave cumulus their crisp
// sunlit-crest / dark-crevice shading. Restore it with ONE short directional probe: sample the carved base
// shape a few hundred metres toward the sun and treat it as local occluding
// density,
//   Tsun *= exp(−carvedShape(p + sunDir·DIST) × coverage × profile × DENS × DIST)
// Costs 2 texture3D per dense voxel (base + carve at the offset point).
// ACTIVE AT ALL DISTANCES (2026-06-12) — a 5→40 km distance gate lived here
// and produced a camera-locked brightness border (the probe's MEAN darkening
// is nonzero, so fading it by camera distance steps the deck's brightness at
// a constant range). Nubis³ equivalent: near sun samples live everywhere,
// baked volume = far tail only. The macro top-bright/under-dark gradient
// still comes from the volume; this only adds the high-freq relief + DC.
const LOCAL_SHADOW_DIST = 0.0008; // 800 m toward the sun
const LOCAL_SHADOW_DENSITY = 2000; // od ≈ 0..1.6 over typical carved densities
// Cone-traced light march (Nubis C3). 6 stratified samples toward the sun,
// each perturbed by a pre-baked low-discrepancy 3D kernel, scaled by step
// distance so the cone widens with depth. Total integration range ≈ 12 km
// (same as the previous 3×4 km linear march), but the cone-tap pattern
// smooths per-pixel transmittance variance and reads more like a real
// volumetric integral — removes the "speckled cores" common to short
// linear light marches. Step count is hard-coded into the unrolled call
// sites in buildCloudFragment (TSL can't index a constant kernel by loop
// variable), so there's no LIGHT_STEPS constant.
const LIGHT_STEP_SCALED = 0.002; // ~2 km step; 6 steps ≈ 12 km into the slab.
// ── Cheaper cone (perf, 2026-06-10) ──
// Each cone tap reconstructs the primary's dilated + billow-carved shape so
// cumulus lumps self-shadow — but that costs a SECOND texture3D (detailVolume
// carve) per tap, i.e. 12 texture3D per dense voxel for the 6-tap cone, ~70% of
// a dense voxel's texture cost. With CONE_SAMPLE_CARVE = false the cone samples
// only the dilated BASE shape (1 texture3D/tap → 6 per voxel), halving cone
// fetch cost. Tradeoff: the sun-march no longer sees the ~km billow valleys, so
// within-body self-shadow detail on lumps is softer (the macro top-bright /
// underside-dark gradient is unaffected — that comes from the base shape +
// coverage + profile, which the cone still sees). Set true to restore the crisp
// lump self-shadow at 2× cone fetch cost. (Macro density along the sun path is
// still integrated; only the high-freq carve is dropped.)
const CONE_SAMPLE_CARVE = true;


// ── Near-surface detail self-shadow (2026-06-18 — the cauliflower fix) ──
// Nubis³ ("256 m / 10-sample" old light march; new = 2 live near-surface taps
// through the FULL detail-eroded density + baked far-field grid) and Frostbite
// §5.5.2 (4 shadow samples at a base distance × a constant factor) both build
// cloud self-shadow from a SHORT sun march at the DETAIL scale. Our existing
// 800 m probe self-shadows the km-scale macro lumps but is blind to the
// ~tens-of-metres cauliflower: at 800 m the detail is decorrelated from the
// surface lump → no relief (confirmed empirically: putting detail into the
// 800 m probe changed nothing). This adds a SECOND, SHORT probe tap at the
// detail scale — sample the
// detail-eroded density ~DETAIL_SS_DIST toward the sun, accrue a short optical
// depth, and layer it onto the macro probe: Tsun = exp(-(odMacro + odNear)).
// Because the near tap sits at the lump scale, a sunlit crest finds clear air
// (bright) and a crevice finds cloud (dark) → real lobed cauliflower relief.
//
// Cost: +1 texture3D per day-side dense voxel (DETAIL volume only; the macro
// shape is reused from the surface — macro is ~constant over the short tap).
// This is the PROTOTYPE for the fix: default ON so it shows on reload; flip
// false to A/B against the current look. Tune DETAIL_SS_DENSITY for relief
// strength and DETAIL_SS_DIST for which feature scale self-shadows (smaller →
// finer lumps shade, but too small re-introduces the macro-only smoothness;
// too large re-introduces the 800 m decorrelation). Watch DEBUG_VIZ
// 'detailShadow' (the near term in isolation) and 'off' (the result).
// REQUIRES USE_LIGHT_VOLUME=true (the default) — lives in the same probe.
const DETAIL_SELFSHADOW = true;
const DETAIL_SS_DIST = 0.0002; // toward the sun; ~ the FINE_CARVE lump scale
const DETAIL_SS_DENSITY = 20000; // self-shadow strength (od scale); tune live
// The fine-carve Worley self-shadow tap samples the box-downsampled level-1 of
// the detail volume (getGpuCloudDetailMip1 — a dedicated 32³ storage texture)
// for smooth ~hundreds-of-metres lobes. Previously this was detailVolume.level(
// 1.0); the GPU detail volume is single-mip, so level-1 is its own texture.
// Soft fade width for the 3D light-volume window edge (USE_LIGHT_VOLUME), as
// a fraction of the XZ half-extent. The volume only covers a finite tangent
// window around the camera; without a soft edge the inside (self-shadowed) →
// outside (fully lit) boundary reads as a hard lighting line sweeping across
// clouds as you fly. Fading the volume → lit over the outer
// LIGHT_VOL_EDGE_FRAC of the window turns that line into a soft gradient.
// XZ-ONLY since shell-Y (2026-06-12): the slab fills the altitude span by
// design, so a Y fade would wrongly fade everything everywhere.
const LIGHT_VOL_EDGE_FRAC = 0.25;
// Henyey-Greenstein DUAL-LOBE phase. Real clouds are strongly forward-
// scattering (the silver lining you see looking toward the sun) yet still
// scatter sideways and back — a single HG lobe can't do both. We blend a
// sharp forward lobe with a gentle back lobe (the Hillaire/Schneider cloud
// phase):
//   phase(θ) = mix( HG(g_fwd, θ), HG(g_back, θ), blend )   // blend = back weight
//
// Why dual-lobe and not a single g (the journey, so we don't loop back):
//   - Single g=0.6: strong silver lining but the phase swings ~65× with view
//     angle → a harsh left-right brightness ramp across the WHOLE deck. Back
//     when the deck was a flat blanket that ramp was the only variation, so it
//     read as a cheap screen-space gradient. The user disliked it.
//   - Single g=0.1 (previous): killed the ramp but ALSO killed the silver
//     lining and all directional body shading → the washed-out flat look in
//     the reference-comparison screenshots. The within-cloud self-shadow
//     (cone-marched Tsun) then reached colour only through the sqrt-
//     compressed, profile-gated `ms` term → smooth, "same colour all over".
//   - Dual-lobe (current): now that the deck has real relief (macro carve)
//     plus per-voxel self-shadow, a forward lobe modulates REAL geometry → it
//     reads as physical top-bright/side-dark shading + a silver rim, NOT a
//     flat ramp. The back lobe keeps the away-from-sun side from collapsing to
//     near-zero, which is what made the single-lobe ramp so harsh.
//
// Dial guide: lower HG_BLEND → more forward drama (brighter, narrower silver
// lining); raise it → softer/more isotropic (less gradient). Raise HG_FORWARD
// for a tighter, brighter rim; lower it for a broader sheen.
const HG_FORWARD = 0.8; // sharp forward lobe — silver lining toward the sun
const HG_BACK = -0.3; // gentle back lobe — lifts the away-from-sun side
const HG_BLEND = 0.5; // weight of the back lobe (0 = pure forward, 1 = pure back)

// ── Macro-scale billowy carving (shape-relief; landed 2026-05-30) ──
// The dilated base macro shape is a smooth, flat-topped dome. Carve it with a
// crisp Worley field so the cloud BOUNDARY undulates into ~1.5-3 km lumps with
// valleys between them. This is the key to non-flat cloud lighting: without
// boundary relief the surface is a flat slab top, the sun cone escapes upward,
// and there is no surface self-shadow → uniform colour. Proven via
// DEBUG_VIZ='firstConeDepth' (the visible surface's sun optical depth), which
// read black on the flat deck and only varied where the cloud had real
// vertical buildup; 'off' tracked it exactly. The macro carve gives the whole
// deck that vertical relief, so the surface self-shadows everywhere.
//
// Two things were essential (both found empirically — see CLOUD_DEBUGGING_LESSONS):
//  1. SOURCE: the base volume's G/B Worley is FBM (averaged → too smooth);
//     carving with it merely scaled body size. We sample the DETAIL volume's
//     single-octave Worley (crisp cells, distinct valleys) at CARVE_SCALE.
//  2. SCALE: must be MACRO (~1.5-3 km). Fine carving (CARVE_SCALE 350) makes
//     internal texture but leaves the top boundary flat → cone still escapes.
//
// Schneider value-erosion form: remap(baseShape, (1-carveWorley)*BILLOW_CARVE, 1, 0, 1).
// Strength: higher = deeper valleys → lumpier / more-broken deck. 0.99 reduced
// the deck to sparse cell-centre puffs; at 0.99 with the new cumulus towers it
// over-eroded them into DISCONNECTED floating blobs (no connected base).
// 2026-05-30: 0.99 → 0.75 now that height-profile towers (Step 3) provide the
// macro form — back off the carve for fuller, CONNECTED bodies. If the lower
// deck flattens too much, make the carve altitude-dependent (solid base, eroded
// top) instead of a single constant. Tune against DEBUG_VIZ='eroded'.
const BILLOW_CARVE = 0.45;
// Coverage-envelope erosion strength (2026-06-16 — the density MODEL fix).
// Density = the coverage×height envelope (`profile`) ERODED by the base noise:
//   shape = saturate( profile − (1 − base) × BASE_EROSION_K )
// This is the reference (Nubis/Frostbite) relationship: the 2D coverage×height
// envelope is the cloud PRESENCE, and the 3D noise SUBTRACTS from it. Two
// consequences fall out for free:
//   • shape ≤ profile ALWAYS → nothing survives above the envelope → no
//     floaters by construction (a base peak at low profile is still ≤ profile).
//   • K < 1 lets HIGH coverage FILL the base's cellular gaps → a solid deck,
//     while LOW coverage leaves them eroded → broken cumulus. (The old
//     `base + profile − 1` form was K = 1 exactly: at full coverage shape =
//     base, so the Perlin-Worley cell gaps showed as permanent holes and the
//     deck could never close — the "disconnected round clouds at full
//     coverage" bug.)
// K=1 = base fully carves (gappy even at full coverage); K=0 = pure smooth
// envelope (no noise structure). Tune live against the real render + 'density'.
//
// 2026-06-18 (#2 mid-scale billowing): 0.25 → 0.45. K is the noise's INFLUENCE
// on the silhouette: shape = saturate(cov·prof − (1−base)·K), so the base 3D
// noise modulates the shape by only ±K. At 0.25 the coverage×height ENVELOPE
// dominated 4:1 → cumulus towers were the envelope extruded with straight
// vertical walls (only the fine detail nibbled them). 0.45 lets the now
// mid-rich base (BASE_FBM_BILLOW folds the Worley-FBM octaves in) actually
// billow the WALLS. TRADEOFF: this is exactly the lever the floater fix lowered
// — higher K = more billow but risks gappy decks / isolated floaters. The
// Alligator noise (round caps), covSpan gating, and solidity gamma should keep
// it solid now; if floaters/gaps return, lower K. Marcher-only (the bake uses a
// plain baseDilate·cov·prof, no K). Tune live with BASE_FBM_BILLOW.
const BASE_EROSION_K = 0.6;

// ── Phase F falsification toggles (docs/CLOUD_TYPES_PLAN.md §3.6) ──────────
// Phase F is COMPLETE (2026-07-06): all three dominant porridge causes
// confirmed in-app and their fixes validated. The toggles survive as A/B
// levers until Phase 1 delivers the real system via the weather map; the
// values below are the ADOPTED settings, not "default OFF".
//
// Step 3 — Nubis-form value erosion. Algebraically the Nubis 2017 relationship
// saturate(carved − (1−profile)) IS this pipeline's erosion at K = 1 exactly:
//   profile − (1−carved)·1 = carved − (1−profile).
// K=1 keeps noise authority at ALL coverages (~7% holes at profile 1.0 with
// our noise, Monte-Carlo in docs/CloudTypesResearch/cloud_shape_anatomy.md)
// instead of K=0.6's mathematically hole-free floor above raw coverage 0.427.
// This const feeds the dense-branch erosion, the probeShape skip-gate (MUST
// move together — case #13 gate law), and the far shell's columnMacroCoverage
// (coherent near/far). The light-volume bake has NO K erosion (multiplicative
// density) — nothing to mirror there. VALIDATED: closed-but-structured deck,
// true black restored in the 'eroded' viz (§3.6 step 3).
const EROSION_NUBIS_FORM = true;
const BASE_EROSION_K_EFF = EROSION_NUBIS_FORM ? 1.0 : BASE_EROSION_K;
//
// Step 4 — LINEAR topAlt spread now lives in cloudShared.ts (TOPALT_LINEAR +
// topAltSpread), the single source of truth for the marcher, the shell, the
// light-volume bake, and the 'topAlt' diagnostic. VALIDATED (§3.6 step 4).
//
// Step 5 — synthetic mesoscale organization mask. Multiplies RAW coverage by
// a 10-40 km cellular field with TRUE ZEROS in the lanes, previewing the
// weather-map v2 bake's mesoscale octave (§3.6 H3: nothing exists today
// between the 8.3 km column cells and the smooth weather map). One extra
// baseVolume tap per in-band step at MESO_SCALE (tile 1000/8 = 125 km,
// grid-4 Alligator cells ≈ 31 km — inside the real Sc-cell band). TEST-ONLY
// caveats: marcher-only (the far shell beyond ~300 km and the light-volume
// bake do NOT see the mask — expect a visible handoff seam and slightly
// off tower-wall lighting near lanes during the test).
// EXPECTED if H3 holds: instant closed/open-cell deck organization with
// clear-sky lanes at the 10-40 km scale.
const MESOSCALE_TEST = true;
const MESO_SCALE = 8; // baseVolume tile 125 km → ~31 km cells
const MESO_LANE_LO = 0.45; // below → lane (true zero); tune vs p10 ≈ 0.48
const MESO_LANE_HI = 0.7; // above → cell interior (mask 1)
//
// Step 6 needs no new code: A/B the existing DETAIL_FADE_FAR 0.1 → 0.25.
// ───────────────────────────────────────────────────────────────────────────

// Carve-noise scale: detail-volume tile ≈ 1000/CARVE_SCALE km. 80 → ~12.5 km
// tile, R-octave cells ~3 km, G-octave ~1.6 km → ~1.5-3 km macro relief.
// (Fine cauliflower detail will return as a separate close-up layer — Step 4.)
const CARVE_SCALE = 360;

// ── Fine cauliflower carve (2026-06-18 — the SHARED-density cauliflower fix) ──
// The macro BILLOW_CARVE (~5.5 km) gives km-scale lumps. Cauliflower lives at
// ~hundreds of metres, and CRUCIALLY it must be in the SHARED density so the
// silhouette (opacity) and the self-shadow agree. (Self-shadowing an unrelated
// detail-noise field just paints "noise on smooth clouds" and reads inverted —
// confirmed empirically 2026-06-18.) This is a SECOND billow carve at a finer
// scale, applied to baseShapeCarved (so the view ray carves real bumps) AND
// sampled by the near self-shadow probe along the sun ray (so those SAME bumps
// self-shadow: a crevice has a lump sunward → dark, a crest → clear → bright).
// Same Schneider value-erosion form as BILLOW_CARVE.
//   FINE_CARVE_SCALE: tile ≈ 1000/scale km. 2000 → 0.5 km tile, R-octave cells
//     ~125 m → ~125-250 m cauliflower lumps.
//   FINE_CARVE_STRENGTH: carve depth (like BILLOW_CARVE=0.45). Too high
//     fragments thin clouds (suspect B); too low → no relief.
// Toggle to A/B. NOTE: applied to the OPACITY + near probe only; the 800 m
// macro probe and the baked light volume are NOT fine-carved yet (deferred —
// near the deck the baked volume is faded, so lockstep drift is tolerable for
// this experiment). If it lands, propagate to cloudLightVolume.ts (lockstep).
const FINE_CARVE = true;
const FINE_CARVE_SCALE = 350;
const FINE_CARVE_STRENGTH = 0.2;
// Fine-octave BIAS (2026-06-18 — the "half-lumps" fix; reference-grounded).
// Nubis/Frostbite build the silhouette from a MULTI-OCTAVE base field (noiseL),
// so lumps bulge OUT; their erosion (noiseH) is a separate finest-edge refine.
// A pure-subtractive fine carve (our prior approach) can only bite INWARD →
// lumps clipped at the macro outline ("half-lumps"). Centering the fine octave
// makes it raise the field where the noise is high (bulge out past the macro
// envelope) and lower it where low (crease in) — i.e. a multi-octave base
// shape, which is what the references actually do. BIAS is the pivot:
//   1.0 = pure subtractive (old behaviour; half-lumps),
//   ~0.4 = centered (bulge + crease; ≈ the fine-noise mean → coverage-neutral),
//   0.0 = pure additive (only bulges).
// Start ~0.4. Pairs with a widened carve gate so bulges can extend beyond the
// macro footprint.
const FINE_CARVE_BIAS = 0.4;
// Max OUTWARD bulge the centered fine octave can add (= strength × (1−bias));
// widens the macro carve gate so the bulge isn't clipped at the macro footprint.
// 0 when FINE_CARVE off or bias=1 (pure subtractive) → original gate / perf.
const FINE_MAX_BULGE =
  FINE_CARVE && FINE_CARVE_BIAS < 1
    ? FINE_CARVE_STRENGTH * (1 - FINE_CARVE_BIAS)
    : 0;
// Fine-octave FREQUENCY GRADING (2026-06-18 — thin-cloud/edge pockmark fix;
// Nubis p.109). Nubis: "we want the edges to have more rounded structure than
// the core — otherwise we will just get high frequency noise everywhere on the
// edges, so we blend from low frequency to high frequency over the dimensional
// profile." Our single-octave fine carve was exactly "high-freq everywhere on
// the edges" → pockmarks on thin clouds + blobby edges. Fix: blend the fine
// noise from a LOW-freq octave (detail R, rounded) at the edges to a HIGH-freq
// octave (detail B) in the dense core, graded by `profile` (coverage×height —
// our smooth dimensional-profile analog, low at thin/edge). GRADE_POW: HIGHER =
// edges stay low-freq longer (rounder, fewer pockmarks); LOWER → high-freq
// reaches closer to the edge. 0 → all high-freq (the bug).
const FINE_CARVE_GRADE_POW = 2.0;

// ── HHF up-close detail (2026-06-18; Nubis p.117 "twice-folded noise") ──
// Up close there is a "dramatic lack of detail" — the fine octave's hundreds-of-
// metres cells read as blobs. Nubis reuses an existing high-freq channel folded
// TWICE over zero — abs(abs(n·2−1)·2−1) — to synthesize ~4× higher frequency for
// FREE (no extra 3D sample), blended in only NEAR camera so far clouds don't
// alias. We fold the fine high-freq channel (B), pow it for rounded billow caps,
// and blend it into the fine carve noise over HHF_FAR→HHF_NEAR. Pure shader ALU,
// no re-bake. HHF_STRENGTH = 0 disables.
//   HHF_STRENGTH: blend weight at the closest range (0..1).
//   HHF_NEAR/FAR: scaled-unit distances (1 = 1000 km) — full HHF nearer than
//     NEAR, none beyond FAR. ~80 m..600 m. Tune to where "blobby up close" sits.
const HHF_STRENGTH = 0.2;
const HHF_NEAR = 0.0008;
const HHF_FAR = 0.012;

// ── Wispy detail (2026-06-18; Nubis "Curly-Alligator") ──
// The detail volume's A channel is now a curl-distorted inverted-Alligator web =
// feathery wisps (see noiseVolumes.ts). Blend billowy (RGB) ↔ wispy (A) by
// EDGE/density: wisps where density is DECREASING (low profile = edges/thin),
// billows in the dense core — Nubis "Decreasing Density = Curly Layered Wisps."
// This gives the feathery edges instead of rounded blobs. (The full cloud-type
// system, when built, would drive a richer wispiness signal — e.g. cirrus
// regions fully wispy.) WISP_AMOUNT = 0 disables; needs a noise re-bake to take
// effect (the A channel is baked).
//   WISP_AMOUNT: max wispy blend at the thin edge (0..1).
//   WISP_PROFILE_LO/HI: profile band — fully wispy below LO, fully billowy above
//     HI (profile = coverage×height, low at edges/tops).
const WISP_DETAIL = true;
const WISP_AMOUNT = 0.7;
const WISP_PROFILE_LO = 0.0;
const WISP_PROFILE_HI = 0.5;

// ── Detail distance fade (footprint LOD; 2026-06-22) ──
// FINE_CARVE / WISP / HHF are sub-km-to-few-km features. Past a few tens of km
// they fall below the per-pixel ray footprint: the single point-sample per step
// lands on a random side of a feature and the per-frame STBN jitter flips it →
// "distant clouds flicker, worse the further away" (Issue ①). Nubis (p.115)
// fades the high-frequency detail AMPLITUDE to 0 with distance — no sub-pixel
// detail left to alias (an amplitude fade, NOT a noise mip: the file forces
// .level(0) everywhere because auto-mip + dither banded, see case study #2). We
// fade the whole `fineDelta` (the R/B carve + WISP + HHF together) over
// DETAIL_FADE_NEAR→FAR by march distance `t`, leaving the macro billow form
// (dilation + BILLOW_CARVE) intact far away — all the footprint can resolve.
// Pure ALU, no extra taps; marcher-only so no bake-lockstep concern.
//   NEAR/FAR: scaled-unit march distances (1 = 1000 km). Full detail < NEAR,
//   smooth macro-only > FAR. Lower FAR = kill flicker sooner but smooth closer
//   clouds; raise = keep detail further but more flicker.
const DETAIL_FADE_NEAR = 0.02; // 20 km — full detail nearer than this
const DETAIL_FADE_FAR = 0.1; // 100 km — macro-only beyond this

// ── Solidity gamma (2026-06-18; Nubis low-density sharpen, talk p.123) ──
// Nubis applies pow(density, lerp(0.3,0.6,...)) to "sharpen low-density areas
// and bring out cauliflower definition." With an exponent < 1 it RAISES mid
// densities → fills the semi-transparent gaps between carved lumps so the body
// reads as a SOLID mass instead of "white balls suspended in transparent."
// 1.0 = off (identity). Lower = more solid/opaque body (softer relief). Tune
// against 'off'. Applied to the view-ray density only.
const DENSITY_GAMMA = 0.8;

// =============================================================================
// DIAGNOSTIC VISUALIZATION
//
// Set DEBUG_VIZ to anything other than 'off' to replace the normal cloud
// output with a false-colour visualisation. Output is forced to alpha=1, so
// the cloud-RT pixels REPLACE the underlying scene at every fragment where
// the cloud shell renders — not blended through. uVolumetricBlend is
// bypassed in debug modes so the visualisation is consistent regardless of
// camera distance to Earth.
//
//   'off'         : normal cloud rendering
//   'alpha'       : integrated alpha as grayscale. Black = no cloud detected,
//                   white = saturated opacity. Tells us whether the integration
//                   is reaching α=1 in regions where coverage is high (i.e.
//                   are we density-limited, or sampling-limited?)
//   'topAlt'      : per-column topAlt sampled at the slab midpoint, mapped to
//                   grayscale: black = topAlt=0.4, white = topAlt=0.95. The
//                   key question this answers: does topAlt actually vary
//                   across the FOV, or does it cluster around one value
//                   (which would mean Perlin distribution is too narrow and
//                   the per-column tower variation is invisible).
//   'insideInner' : red = camera is below inner shell at this fragment,
//                   green = above. Reveals whether the insideInner branch
//                   in the geometry intersection fires correctly and at the
//                   expected screen regions.
//   'iters'       : R = primary loop iterations / 96, G = dense (full-sample)
//                   iterations / 96, B = 0. Tells us whether the march is
//                   early-terminating (R low), running to MAX_PRIMARY_STEPS
//                   (R = 1), and whether dense mode actually engages (G > 0
//                   in cloud regions).
//   'slabLen'     : slab path length normalised. Helps spot grazing-angle
//                   pixels where the slab is much longer than nominal
//                   13 km (e.g. limb views).
//   'firstHit'    : t-value of first cloud sample (premul alpha first
//                   exceeds 0.01) divided by tExit, false-coloured. The
//                   parallax-sanity check: per-pixel depth variation
//                   means adjacent pixels can show very different colours
//                   wherever they hit clouds at different distances along
//                   their respective rays. A uniform colour across the
//                   cloud disk means cloud-front depth is locked (i.e.
//                   shell-painting behaviour). Empty pixels = black
//                   (no hit, sentinel = 0).
//   'lightingOnly': accumulated col / alpha (the cloud's unpremul colour,
//                   ignoring transparency). Pixels where alpha is non-zero
//                   show the cloud's actual shading. LINEAR-SCALED to a
//                   0–5 HDR window so subtle variation isn't squashed by
//                   tonemap compression — Reinhard's x/(x+1) curve maps
//                   5-10 HDR to 0.83-0.91, indistinguishable to the eye
//                   even when the underlying variation is 2x. Linear /5
//                   shows 0-5 HDR clearly; above 5 clamps to white.
//   'tsunMs'      : last-dense Tsun_ms (multi-scatter transmittance from
//                   cone-march), grayscale. Black = 0, white = 1. THE
//                   diagnostic for "does cone-march produce spatial
//                   variation?" — if uniform, the cone-march is the
//                   problem; if varying but lightingOnly is uniform,
//                   the issue is downstream in the lighting formula.
//                   CAUTION: pow(x, 0.15) compresses heavily near x=1
//                   (e.g. opticalDepth 0.5 → Tsun_ms 0.92, opticalDepth
//                   2.0 → Tsun_ms 0.74), so visually-uniform tsunMs can
//                   hide a 4× variation in the underlying raw cone-march
//                   density. Use 'coneDepth' as the un-compressed truth.
//   'coneDepth'   : last-dense raw opticalDepthSun (before pow-tonemap),
//                   scaled /10 for display. Shows whether cone-march is
//                   ACTUALLY producing varying absorption. Black = 0 (no
//                   absorption), white ≥ 10 (heavy absorption). If
//                   coneDepth is uniform across cloud disk → cone-march
//                   physically isn't varying (texture3D / sunDir bug). If
//                   coneDepth varies but tsunMs and lightingOnly look
//                   uniform → pow compression is hiding the variation
//                   and we need either lower sunColor brightness or a
//                   different lighting tonemap.
//   'eroded'      : last-dense `eroded` value (post-detail-erosion shape,
//                   range 0-1). Shows the actual per-voxel density
//                   structure at the visible surface, before any lighting
//                   or cone-march. If this varies pixel-to-pixel at close
//                   range → detail noise IS at sub-pixel resolution and
//                   lighting is just not surfacing it. If uniform → noise
//                   volumes don't have sub-100m features and close-range
//                   detail needs a different mechanism entirely.
//   'density'     : last-dense density (eroded × densScale), scaled
//                   /20000 for display. Same diagnostic intent as
//                   'eroded'; cross-check that densScale isn't masking
//                   variation.
//   'sunDir'      : visualizes `sunDirEarth` as colour: R = sunDir.x*0.5+0.5,
//                   G = sunDir.y*0.5+0.5, B = sunDir.z*0.5+0.5. Identical
//                   across the whole screen (since sun direction is the
//                   same for every voxel — sun at AU distance). Use this
//                   to verify sunDir is pointing where the sun visibly
//                   appears in the scene. If the visible sun on screen
//                   is in the upper-left but sunDir colour suggests
//                   downward direction, there's a transform bug.
//   'daylight'    : the PER-RAY daylight scalar at the slab-chord midpoint
//                   pMid (the actual lighting uses per-sample `daylightS`
//                   since 2026-06-12 — expect this viz to disagree with the
//                   render along the limb, where pMid jumps). Varies across
//                   the cloud disk: clouds near the sub-solar point read
//                   bright, terminator mid-gray, night side black. The
//                   "left-bright / right-dim" gradient when the sun is off
//                   to one side is correct physics, not a bug.
//   'dither'      : the per-pixel dither hash output as grayscale [0, 1].
//                   Tests whether the dither hash is producing uniform
//                   per-pixel variation or some structured pattern.
//
// ── Cauliflower-detail measurement set ──
//   'eroded'      : the final [0,1] density shape at the visible surface
//                   (grayscale) — shows the carved cauliflower/wisp structure.
//   'litShape'    : the [0,1] LIT base shape the 800 m self-shadow probe
//                   absorbs by (base+macro-carve), grayscale, day side only.
//                   Requires USE_LIGHT_VOLUME=true (the default); reads black
//                   on the cone path. Compare to 'eroded': if 'eroded' shows
//                   crisp detail but 'litShape' is smooth/km-scale, the macro
//                   probe can't see the detail — the NEAR self-shadow probe
//                   (DETAIL_SELFSHADOW) is what carries it.
//   'detailShadow': the near detail self-shadow term in isolation (exp(-odNear)),
//                   day side only — lobed light/dark = working cauliflower
//                   self-shadow; flat = no relief.
// (The old 'detailField'/'detailCut'/'detailLod' modes were removed 2026-06-18
// with the opacity-only detail-erosion pass they measured.)
// =============================================================================
const DEBUG_VIZ:
  | "off"
  | "firstConeDepth"
  | "alpha"
  | "topAlt"
  | "insideInner"
  | "iters"
  | "slabLen"
  | "profile"
  | "firstHit"
  | "lightingOnly"
  | "tsunMs"
  | "coneDepth"
  | "eroded"
  | "density"
  | "sunDir"
  | "daylight"
  | "dither"
  | "lod"
  | "whyStop"
  | "lightVol"
  | "maxProfile"
  | "maxProbeShape"
  | "baseShape"
  | "floaterProbe"
  | "baseColumn"
  | "litShape"
  | "detailShadow" = "off";

// cloudHeightProfile moved to cloudShared.ts (Phase 0) — single source of
// truth for the marcher, the far shell, and the light-volume bake.

/**
 * Earth cloud system: registers a fullscreen-quad ray-march pass that
 * produces per-pixel cloud-front depth (real 3D parallax under camera
 * motion). Returns a tiny anchor mesh whose only role is to inherit
 * Earth's matrixWorld via the rotation-group parent — `onMount` registers
 * it as the world-transform source for the fullscreen pass's
 * `uEarthInverseModel` uniform. Mesh is on CLOUD_LAYER (which no camera
 * enables), so it never renders.
 */
// ── Shared macro cloud-density model (ISSUE 2 Q2; revised 2026-07-06) ────────
// The far-field SHELL derives its coverage from THESE functions — the same
// coverage→type→profile relationship the volumetric marcher uses — so the
// shell's footprint tracks the volumetric BY CONSTRUCTION. The NOISE half of
// the model enters the shell STATISTICALLY (the erosion-survival LUT below),
// not per-position: point-sampling the mip-less 3D noise from orbit was
// measured to alias (frizz + moiré) and to zero out low-coverage columns —
// see docs/CLOUD_REVIEW_2026-07.md "MEASURED (2026-07-06)". "Macro" = the
// dilated + billow-carved base shape; the marcher layers FINE_CARVE/WISP/HHF
// on top for the NEAR view, which the far shell doesn't need.
//
// NOTE: the marcher still computes these inline (its dense branch is gated for
// perf); the formulas here MUST match it. Unifying the marcher to call these is
// a clean follow-up (Q2b) — deferred to keep the working marcher untouched.
// Known marcher-only divergence: MESOSCALE_TEST masks the marcher's raw
// coverage (Phase F step 5, test-only) — the shell will read fuller than the
// meso-broken decks until the mask graduates into the weather map / the bake.

// deriveCloudType / topAltSpread / deriveTopAlt moved to cloudShared.ts
// (Phase 0). The far shell + the marcher dense branch both import them.

// Dilated macro base shape at an earth-space position (baseVolume + baseDilate).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function macroDilatedShapeAt(pos: any, baseVolume: THREE.Texture): any {
  const bs = texture3D(baseVolume, pos.mul(float(BASE_SCALE))).level(
    int(0),
  ) as Node;
  const fbm = bs.g.mul(0.625).add(bs.b.mul(0.25)).add(bs.a.mul(0.125));
  return baseDilate(bs.r, fbm);
}

// (applyBillowCarve — the shared per-position billow-carve — was removed
// 2026-07-06: the shell no longer point-samples the carve (measured sub-pixel
// aliasing, Bug B); its statistics live in the survival LUT below, whose kernel
// mirrors the marcher's dense-branch carve: cw = detail.r·0.6 + detail.g·0.4,
// remap by (1−cw)·BILLOW_CARVE. Keep the LUT kernel in lockstep with the
// MARCHER if the carve form changes.)

// ── Shared marcher composition kernels (Phase 0b) ────────────────────────────
// One definition each for the two compositions the dense march repeated
// verbatim across its primary/probe/detile/cone paths. These are MARCHER-LOCAL
// (the light-volume bake is macro-only — no carve/fine; the shell uses the
// statistical LUT above), so they live here rather than in cloudShared.ts.

// Schneider value-erosion "billow carve": remap the dilated macro shape by the
// carve-Worley threshold (1−cw)·BILLOW_CARVE. `carveSrc` = the detailVolume tap
// at CARVE_SCALE, sampled by the caller (texture/position differ per site:
// primary pWarped, 800 m probe pLsWarped, cone pL). Used by carvedShapeAt (the
// detile path), the primary non-detile carve, the 800 m self-shadow probe, and
// the dead cone path — so a carve-form change lands everywhere at once.
function billowCarveKernel(dilated: Node, carveSrc: Node): Node {
  const cw = carveSrc.r.mul(0.6).add(carveSrc.g.mul(0.4));
  const ct = float(1).sub(cw).mul(float(BILLOW_CARVE));
  return dilated.sub(ct).div(float(1).sub(ct).max(0.0001)).clamp(0, 1);
}

// Fine-octave delta (grade → wisp → HHF → centered bias·strength·fade).
// The full FINE_CARVE/WISP/HHF composition, ONE definition shared by the
// opacity path AND the near self-shadow probe (case #21: the probe MUST carve
// with the SAME fine octave the view ray does, or the relief self-shadows
// inverted). Caller supplies the already-sampled `fineSrc` (opacity taps
// detailVolume @ pWarped; probe taps detailVolumeMip1 @ pNear), the smooth
// `profileInput` (profile vs profileLs), the march distance `tDist` (HHF
// range), and `detailFade` (footprint LOD on the opacity path; float(1) on the
// probe — the shadow is never distance-faded). Returns the centered delta to
// ADD to the macro shape. This is the per-type-detail knob surface for
// CLOUD_TYPES_PLAN Phase 3 — one place for WISP_AMOUNT / FINE_CARVE_STRENGTH
// etc. to become functions of convectivity.
function fineCarveDelta(
  fineSrc: Node,
  profileInput: Node,
  tDist: Node,
  detailFade: Node,
): Node {
  // Frequency-grade by the smooth profile (Nubis p.109): LOW-freq rounded
  // octave (R) at thin/edge, HIGH-freq (B) in the core.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fineNoise: any = mix(
    fineSrc.r,
    fineSrc.b,
    pow(profileInput.clamp(0, 1), float(FINE_CARVE_GRADE_POW)),
  );
  // Billowy → WISPY (A channel) toward the thin edge (feathery curl strands).
  if (WISP_DETAIL) {
    const wispiness = float(1)
      .sub(
        smoothstep(
          float(WISP_PROFILE_LO),
          float(WISP_PROFILE_HI),
          profileInput.clamp(0, 1),
        ),
      )
      .mul(float(WISP_AMOUNT));
    fineNoise = mix(fineNoise, fineSrc.a, wispiness);
  }
  // HHF: twice-folded high-freq channel blended in near camera (Nubis p.117).
  if (HHF_STRENGTH > 0) {
    const folded = fineSrc.b.mul(2).sub(1).abs().mul(2).sub(1).abs();
    const hhf = pow(folded, float(2));
    const hhfBlend = smoothstep(float(HHF_FAR), float(HHF_NEAR), tDist).mul(
      float(HHF_STRENGTH),
    );
    fineNoise = mix(fineNoise, hhf, hhfBlend);
  }
  return fineNoise
    .sub(float(FINE_CARVE_BIAS))
    .mul(float(FINE_CARVE_STRENGTH))
    .mul(detailFade);
}

// ── Shell opacity LUT (the shell's noise term, statistically) ────────────────
// 256×1 table: texel i = E_noise[ 1 − exp(−pow(eroded, DENSITY_GAMMA)·PATH) ]
// for dimProfile d_i = i/255, where eroded = saturate(d_i − (1−carved)·K_EFF).
// Monte-Carlo'd on the GPU from the REAL baked noise volumes at load (one tiny
// one-shot compute riding the cloudVolumeCompute bake queue). The shell reads
// LUT(maxDim) as its coverage. This is the EXPECTED RENDERED OPACITY the
// marcher would integrate for a column of dimensional-profile d — the correct
// far-field average, not a point sample:
//   • The exp() Beer-Lambert weighting is the fix over the 2026-07-06 CCDF: the
//     CCDF counted P(eroded>0), over-weighting invisibly-thin density (low
//     coverage read gray). Opacity weighting makes thin→~0, thick→~1, monotone
//     in d with a physical S-shape → high & low coverage BOTH correct with no
//     tone knob.
//   • Positions: `carved` is a stationary tiled field, so uniform random
//     texture-space coords reproduce the marcher's sampling statistics; base &
//     detail decorrelate via their very different world scales (50 vs 360), so
//     independent uniforms are the correct joint. (The marcher's domain warp
//     doesn't change the marginal — stationarity.)
//   • Same sample stream (keyed on the loop index) across all d-threads → LUT
//     monotone by construction, no bin jitter.
//   • d=0 → eroded=0 → opacity 0 → clear sky stays perfectly clear.
// Any rework of the noise volumes / dilate / carve / K re-derives the curve at
// next load — no hand-tuned transfer to desync (the Q2 goal, robust against the
// cloud-types rework). LOCKSTEP: the kernel mirrors the marcher dense branch
// (dilate + billow carve + K erosion + DENSITY_GAMMA); keep in sync if those
// change. OPTICAL_PATH is the one free knob (see SHELL_OPTICAL_PATH).
const SHELL_OPACITY_LUT_SIZE = 256;
const SHELL_OPACITY_LUT_SAMPLES = 8192; // stderr ≈ 0.55% per bin

let cachedOpacityLUT: THREE.Texture | null = null;
function getShellOpacityLUT(
  baseVolume: THREE.Texture,
  detailVolume: THREE.Texture,
): THREE.Texture {
  if (cachedOpacityLUT) return cachedOpacityLUT;
  const tex = new StorageTexture(SHELL_OPACITY_LUT_SIZE, 1);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType; // rgba8unorm — 1/255 alpha quantisation is fine
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = false;

  const kernel = Fn(() => {
    // This bin's dimensional-profile value (LUT index → d ∈ [0,1]).
    const dimProfile = float(instanceIndex).div(SHELL_OPACITY_LUT_SIZE - 1);
    const sum = float(0).toVar();
    Loop(
      {
        start: uint(0),
        end: uint(SHELL_OPACITY_LUT_SAMPLES),
        type: "uint",
        condition: "<",
      },
      ({ i }: { i: Node }) => {
        // Sample stream keyed ONLY on the loop index (identical across all
        // d-threads → monotone LUT). Salts pick independent hash streams.
        const pb = vec3(
          tslHash3(i, uint(0), uint(0), 101),
          tslHash3(i, uint(1), uint(0), 102),
          tslHash3(i, uint(2), uint(0), 103),
        );
        const pc = vec3(
          tslHash3(i, uint(3), uint(0), 104),
          tslHash3(i, uint(4), uint(0), 105),
          tslHash3(i, uint(5), uint(0), 106),
        );
        // Pointwise mirror of the marcher's macro shape: dilate + the shared
        // dense-branch billow carve (billowCarveKernel — one definition).
        const bs = texture3D(baseVolume, pb).level(int(0)) as Node;
        const fbm = bs.g.mul(0.625).add(bs.b.mul(0.25)).add(bs.a.mul(0.125));
        const dilated = baseDilate(bs.r, fbm);
        const cs = texture3D(detailVolume, pc).level(int(0)) as Node;
        const carved = billowCarveKernel(dilated, cs);
        // Marcher erosion + solidity gamma → Beer-Lambert opacity for this
        // sample's density (see BASE_EROSION_K, DENSITY_GAMMA, uDensityMul).
        const eroded = dimProfile
          .sub(float(1).sub(carved).mul(float(BASE_EROSION_K_EFF)))
          .clamp(0, 1);
        const dens =
          (DENSITY_GAMMA as number) === 1
            ? eroded
            : pow(eroded, float(DENSITY_GAMMA));
        sum.addAssign(
          float(1).sub(exp(dens.mul(float(-SHELL_OPTICAL_PATH)))),
        );
      },
    );
    const opacity = sum.div(float(SHELL_OPACITY_LUT_SAMPLES));
    textureStore(
      tex,
      (uvec2 as Node)(instanceIndex, uint(0)),
      vec4(opacity, opacity, opacity, 1),
    ).toWriteOnly();
  });

  // Queued AFTER the volumes (getShellOpacityLUT is called with the already-
  // requested singletons) so the in-order bake dispatch populates its inputs
  // first — same ordering contract as detail mip1.
  queueCloudBake({ computeNode: kernel().compute(SHELL_OPACITY_LUT_SIZE) });
  cachedOpacityLUT = tex;
  return tex;
}

// Far-shell per-column coverage → ALPHA. The analytic macro envelope: mipped
// raw coverage (CloudFieldProvider seam) × the shared coverage→type→profile
// model over SHELL_ALT_SAMPLES, pushed through the expected-opacity transfer
// (see the LUT above). NO 3D noise taps in the normal path — the noise enters
// only as its statistical mean via the LUT, so nothing sub-pixel can flicker
// (the measured Bug B) and low-coverage columns keep their honest fractional
// alpha instead of a point-sampled zero (the measured Bug A).
function columnMacroCoverage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dir: any,
  field: CloudFieldProvider,
  opts: {
    baseVolume: THREE.Texture;
    detailVolume: THREE.Texture;
    opacityLUT: THREE.Texture;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    innerRadiusScaled: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outerRadiusScaled: any;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const {
    baseVolume,
    detailVolume,
    opacityLUT,
    innerRadiusScaled,
    outerRadiusScaled,
  } = opts;
  if (SHELL_DEBUG_VIZ === "rawCoverage") return field.coverageAt(dir);
  // DEBUG-ONLY 3D taps (the retired aliasing ladder — see SHELL_DEBUG_VIZ).
  // baseVolume/detailVolume are otherwise UNUSED here (the LUT replaced them).
  if (SHELL_DEBUG_VIZ === "colSample") {
    return (
      texture3D(
        baseVolume,
        dir.mul(innerRadiusScaled).mul(float(COLUMN_SCALE)),
      ).level(int(0)) as Node
    ).r;
  }
  if (SHELL_DEBUG_VIZ === "baseMacro" || SHELL_DEBUG_VIZ === "carve") {
    const pos = dir.mul(mix(innerRadiusScaled, outerRadiusScaled, float(0.55)));
    if (SHELL_DEBUG_VIZ === "baseMacro")
      return macroDilatedShapeAt(pos, baseVolume);
    // Raw carve field (the cs tap the carve remap consumes), not the remap.
    const cs = texture3D(detailVolume, pos.mul(float(CARVE_SCALE))).level(
      int(0),
    ) as Node;
    return cs.r.mul(0.6).add(cs.g.mul(0.4));
  }
  // v2: coverage/convectivity/topHeight straight from the map (ONE swizzled
  // sample) → the far shell reads the SAME channels as the marcher (fixes Bug A:
  // stratus no longer missing from fixed alt samples) and needs NO SHELL_COL_SAMPLE.
  // LEGACY: coverage-derived type + a fixed column sample.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let coverage: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cloudType: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let topAlt: any;
  if (WEATHER_V2) {
    const w = field.weatherAt(dir);
    coverage = w.coverage;
    cloudType = w.convectivity;
    topAlt = topHeightToTopAlt(w.topHeight);
  } else {
    coverage = field.coverageAt(dir).pow(float(COVERAGE_GAMMA));
    cloudType = deriveCloudType(coverage);
    topAlt = deriveTopAlt(coverage, float(SHELL_COL_SAMPLE));
  }
  // Profile peak over the slab (pure ALU). Coverage is per-column constant, so
  // max(coverage×profile) = coverage × max(profile).
  const maxProfile = float(0).toVar();
  for (const a of SHELL_ALT_SAMPLES) {
    maxProfile.assign(
      maxProfile.max(cloudHeightProfile(float(a), topAlt, cloudType)),
    );
  }
  if (SHELL_DEBUG_VIZ === "profileMax") return maxProfile;
  const maxDim = coverage.mul(maxProfile).clamp(0, 1);
  if (SHELL_DEBUG_VIZ === "maxDim") return maxDim;
  // Expected-opacity transfer: LUT indexed by dimProfile (maxDim). Texel
  // centres: u = d·(N−1)/N + 0.5/N.
  const lutU = maxDim
    .mul((SHELL_OPACITY_LUT_SIZE - 1) / SHELL_OPACITY_LUT_SIZE)
    .add(0.5 / SHELL_OPACITY_LUT_SIZE);
  const opacity = (
    texture(opacityLUT, vec2(lutU, 0.5)).level(int(0)) as Node
  ).r;
  // 'opacity' viz falls through here (final shell coverage before lighting).
  return opacity;
}

// ── Far-field cloud shell (ISSUE 2 Phase 2) ──────────────────────────────────
// A sphere at cloud-top radius, parented (via ExtraMeshDef) to the planet's
// rotation group so its OBJECT space == the marcher's "earth space". Its
// fragment samples the SAME coverage field (cloudCommon provider + shared
// equirect projection) so its clouds register pixel-for-pixel with the
// volumetric marcher and the (soon-removed) surface overlay. Renders on layer 0
// (unlike the marcher anchor on CLOUD_LAYER) so Pass 1 draws it into the scaled
// scene → the atmosphere pass fogs it for free and the volumetric composites
// over it. FrontSide: the near hemisphere shows over the planet from outside
// (orbit); from inside/below the deck the back faces are culled → no ghost
// ceiling. Replaces the surface-shader overlay (removed in step 6); renders in
// BOTH near and mid tiers so orbit keeps cloud cover.
//
// STEP 4: lit with the SHARED far-cloud model (cloudCommon.farCloudLit), matching
// the overlay + marcher (sunIlluminance × cloud-altitude transmittance from the
// shared LUT + sky ambient), so the shell agrees in brightness/colour and
// reddens at the terminator in lockstep. selfShadow is a cheap coverage proxy
// for now (no 2-tap shadow projection — see ISSUE 2 risks).
function buildCloudShellMesh({
  tier,
  weatherMap,
  baseVolume,
  detailVolume,
  opacityLUT,
  innerRadiusScaled,
  outerRadiusScaled,
  shellRadiusScaled,
  uSunRel,
  uShellOpacity,
}: {
  tier: "near" | "mid";
  weatherMap: THREE.Texture;
  baseVolume: THREE.Texture;
  detailVolume: THREE.Texture;
  opacityLUT: THREE.Texture;
  innerRadiusScaled: number;
  outerRadiusScaled: number;
  shellRadiusScaled: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSunRel: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uShellOpacity: any;
}): ExtraMeshDef {
  // Drift uniform: static 0 today (cloud drift unused). Local to the shell for
  // now — when drift is animated, consolidate with the marcher's uCloudUvOffset
  // into ONE shared per-planet uniform (they must match or the shell/marcher
  // clouds would slide apart).
  const uCloudUvOffset = uniform(new THREE.Vector2(0, 0));
  // Raw-coverage source (the CloudFieldProvider seam — texture for Earth,
  // procedural later); columnMacroCoverage applies the shared erosion model.
  const field = makeEquirectTextureField(weatherMap, uCloudUvOffset);

  // Shared transmittance LUT for physical sun colour (guarded like the marcher).
  const transmittanceLUT = USE_ATMOSPHERE_CLOUD_LIGHTING
    ? getAtmosphereLUTs().transmittance.texture
    : undefined;

  const segments = tier === "near" ? 96 : 64;
  const geometry = new THREE.SphereGeometry(
    shellRadiusScaled,
    segments,
    segments,
  );

  const mat = new NodeMaterial();
  mat.transparent = true;
  mat.depthWrite = false;
  mat.depthTest = true;
  mat.side = THREE.FrontSide;
  // Premultiplied-alpha — matches the rest of the cloud pipeline.
  mat.blending = THREE.CustomBlending;
  mat.blendSrc = THREE.OneFactor;
  mat.blendDst = THREE.OneMinusSrcAlphaFactor;
  mat.blendSrcAlpha = THREE.OneFactor;
  mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;

  mat.fragmentNode = Fn(() => {
    // COVERAGE uses the LOCAL (earth-space) direction — the texture is fixed to
    // the rotating planet (validated by step 3's alignment). LIGHTING uses the
    // WORLD-space normal — the sun (uSunRel) is in world space, and the planet
    // rotates under it. Mixing the two spaces (local normal · world sun) rotated
    // the terminator by the planet's rotation; splitting them mirrors the surface
    // shader (texClouds in mesh UV / local, sun dot in normalWorld / world).
    const dir = normalize(positionLocal);
    // Coverage = the volumetric's eroded MACRO footprint via the SHARED density
    // model (columnMacroCoverage) — matches the marcher by construction, no
    // hand-tuned curve. `field.coverageAt` is the raw-coverage source.
    const coverage = columnMacroCoverage(dir, field, {
      baseVolume,
      detailVolume,
      opacityLUT,
      innerRadiusScaled,
      outerRadiusScaled,
    });
    // Scalar debug modes: raw false-colour, alpha=1, no lighting, no fades —
    // inspectable at any distance.
    if (SHELL_DEBUG_VIZ !== "off") {
      return vec4(coverage, coverage, coverage, 1);
    }
    // Distance-based near/far hand-off (see SHELL_HANDOFF_*): fade the shell IN
    // with camera→fragment distance so the volumetric owns the near field
    // (including its over-eroded gaps → no flat backfill) and the shell only
    // carries the far horizon. The sub-camera point is near (faded) while the
    // limb is far (full), so this tracks altitude for free.
    const fragDist = length(positionWorld.sub(cameraPosition));
    const distFade = smoothstep(
      float(kmToScaledUnits(SHELL_HANDOFF_NEAR_KM)),
      float(kmToScaledUnits(SHELL_HANDOFF_FAR_KM)),
      fragDist,
    );
    const alpha = coverage.mul(uShellOpacity).mul(distFade);

    const nWorld = normalize(normalWorld);
    const sunDir = normalize(uSunRel);
    const cosSun = dot(nWorld, sunDir);
    // Cloud-horizon daylight gate — clouds catch sun slightly past the ground
    // terminator (mirrors earth.ts overlay's cloudHemi).
    const daylight = float(1).div(
      float(1).add(exp(float(-40).mul(cosSun.add(0.025)))),
    );

    // Physical sun transmittance at cloud altitude, normalised by the zenith tap
    // (noon unchanged; only angular sunset reddening shows), from the SHARED LUT
    // the marcher + surface sample — so the shell reddens at the terminator in
    // lockstep. Off / no LUT → white (no tint).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sunT: any = vec3(1, 1, 1);
    if (transmittanceLUT) {
      const rgKm = EARTH_ATMOSPHERE.groundRadiusKm;
      const rtKm = rgKm + EARTH_ATMOSPHERE.atmosphereHeightKm;
      const hKm = Math.sqrt(Math.max(0, rtKm * rtKm - rgKm * rgKm));
      const rCloudKm = rgKm + CLOUD_OUTER_ALTITUDE_KM;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tA: any = texture(
        transmittanceLUT,
        transmittanceLutUv(
          float(rCloudKm),
          cosSun,
          float(rgKm),
          float(rtKm),
          float(hKm),
        ),
      ).level(int(0));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tZen: any = texture(
        transmittanceLUT,
        transmittanceLutUv(
          float(rCloudKm),
          float(1),
          float(rgKm),
          float(rtKm),
          float(hKm),
        ),
      ).level(int(0));
      sunT = tA.rgb.div(tZen.rgb.max(float(1e-4))).clamp(0, 1);
    }

    // Cheap self-shadow proxy: denser coverage → darker base. (No 2-tap shadow
    // projection like the overlay had — port it in if the base reads too flat.)
    const selfShadow = float(1).sub(coverage.mul(0.5));

    const lit = farCloudLit({
      sunIlluminance: vec3(
        EARTH_ATMOSPHERE.sunIlluminance[0],
        EARTH_ATMOSPHERE.sunIlluminance[1],
        EARTH_ATMOSPHERE.sunIlluminance[2],
      ),
      sunT,
      skyColor: vec3(
        CLOUD_SKY_AMBIENT[0],
        CLOUD_SKY_AMBIENT[1],
        CLOUD_SKY_AMBIENT[2],
      ),
      daylight,
      selfShadow,
    });
    // Premultiplied output (rgb × alpha, alpha).
    return vec4(lit.mul(alpha), alpha);
  })();

  return {
    key: `earth-cloud-shell-${tier}`,
    geometry,
    material: mat,
    tier,
    // No renderLayer → layer 0 → rendered by the scaled camera in Pass 1.
  };
}

export function buildEarthClouds(ctx: ExtraMeshContext): ExtraMeshDef[] {
  // WEATHER_V2: swap the Blue Marble coverage KTX2 for the synthetic v2 control
  // stack (R=coverage / G=convectivity / B=topHeight / A=cirrus). Chosen ONCE
  // at graph-build time (build const → page reload), so no WebGPU bind-group
  // reassignment. Flows to the marcher, shell, AND light-volume bake (all take
  // this same `weatherMap`), keeping them coherent by construction.
  const weatherMap = WEATHER_V2
    ? getSyntheticWeatherMapV2()
    : ctx.textures.clouds;
  if (!weatherMap) return [];

  const outerRadiusScaled = kmToScaledUnits(
    PLANET_RADIUS_KM + CLOUD_OUTER_ALTITUDE_KM,
  );
  const innerRadiusScaled = kmToScaledUnits(
    PLANET_RADIUS_KM + CLOUD_INNER_ALTITUDE_KM,
  );

  // Base + detail noise volumes (GPU-baked singletons). Needed by BOTH the near
  // marcher AND the shell's shared macro-coverage model (near+mid), so fetch
  // them before the tier branch. (getGpuCloud* return process-lifetime
  // singletons — safe to request from any tier.)
  const baseVolume = getGpuCloudBaseVolume();
  const detailVolume = getGpuCloudDetailVolume();
  // Expected-opacity LUT for the shell's transfer — MUST be requested after the
  // volumes (its bake reads them; queue order = dispatch order).
  const opacityLUT = getShellOpacityLUT(baseVolume, detailVolume);

  // Far-field cloud shell — built for the current tier (near AND mid). Its
  // coverage uses the SHARED macro-density model (columnMacroCoverage) so it
  // matches the volumetric's eroded footprint by construction.
  const shellDef = buildCloudShellMesh({
    tier: ctx.tier,
    weatherMap,
    baseVolume,
    detailVolume,
    opacityLUT,
    innerRadiusScaled,
    outerRadiusScaled,
    // Shell at SHELL_ALTITUDE_KM (default = cloud-top). Separate from the
    // marcher's outerRadiusScaled so it can be tuned for the parallax diagnostic.
    shellRadiusScaled: kmToScaledUnits(PLANET_RADIUS_KM + SHELL_ALTITUDE_KM),
    uSunRel: ctx.uSunRel,
    uShellOpacity: ctx.uniforms.uShellOpacity,
  });

  // Mid (and any non-near) tier: ONLY the shell. The volumetric marcher + its
  // transform anchor are near-only (the marcher never runs at mid range), so
  // don't set the pipeline up again for mid.
  if (ctx.tier !== "near") return [shellDef];

  // detailVolumeMip1 is the box-downsampled level-1 for the self-shadow tap
  // (marcher-only).
  const detailVolumeMip1 = getGpuCloudDetailMip1();

  const uInnerRadius = uniform(innerRadiusScaled);
  const uOuterRadius = uniform(outerRadiusScaled);
  // Shared drift uniform — future-proofed for sim-time animation (step 2+).
  const uCloudUvOffset = uniform(new THREE.Vector2(0, 0));
  // Extinction × density_raw (scaled-km units).
  //
  // OD per dense step = density × densMul × dtDense. Targets SOFT alpha
  // buildup over ~10 dense steps inside a cloud body, not instant
  // saturation — binary saturation would expose the underlying noise's
  // iso-density isosurfaces as hard visible rings on the cumulus body
  // (see CLOUD_DEBUGGING_LESSONS.md, follow-on to case study #1).
  //
  // Primary-ray density multiplier. Tuned for opaque cumulus body:
  // cores need alpha > 0.99 in 3-4 dense steps (~500m of cloud) so stars
  // don't bleed through. Each step contributes scatterFrac ≈ 1 - exp(
  // -density × dtDense), so we need density × dtDense > ~1.5 per step
  // for solid opacity.
  //
  // At 140000 with typical body voxel (eroded ≈ 0.16) and dtDense =
  // 0.000125: density × dtDense ≈ 2.8, scatterFrac ≈ 0.94 per step.
  // Alpha reaches 0.999 in 2 dense steps — solid cumulus.
  //
  // Cone-march density does NOT scale with this. It's hardcoded as
  // CONE_DENSITY = 3000 inside the marcher to keep cone-marched
  // opticalDepthSun in a useful range (~2-10) regardless of primary
  // opacity tuning. See sampleConeTap.
  //
  // Tuned for opaque cumulus body: cores need alpha > 0.99 in a few dense
  // steps so stars/horizon don't bleed through thick bodies.
  //
  // NOTE (2026-05-29): lowering this to 35000 to integrate the self-shadow
  // gradient over more voxels did NOT surface form — the visible *surface*
  // is uniformly lit regardless of how many voxels we integrate (the
  // variation `coneDepth` shows lives in the cloud interior/valleys, not on
  // the lit outer skin). The flatness is a cloud-SHAPE problem (smooth
  // blobs, no macro relief to self-shadow), not an opacity one — so opacity
  // restored to its no-see-through value. See CLOUD_DEBUGGING_LESSONS.
  // SOFT-EDGE FIX (2026-06-01): lowered 140000 → 10000. At 140000 the optical
  // depth of a SINGLE close-range dense step (eroded × 140000 × 125 m ≈ 17) is
  // so large that alpha slams to opaque the instant a ray touches cloud — the
  // silhouette becomes a hard in/out cliff, so grazing edge rays go binary and
  // produce the edge salt-and-pepper. (Confirmed by elimination: not detail
  // erosion, not dither — both ruled out empirically.) Moderate extinction lets
  // alpha build over several steps (Beer's law), so grazing edges get a smooth
  // partial-alpha gradient the spatial+temporal filters CAN resolve → soft
  // edges, like the references.
  //
  // Cores stay opaque (multi-km path = many steps → T→0 regardless), and the
  // LOD step-growth (dtDenseL) raises per-step optical depth with distance, so
  // DISTANT clouds stay crisp/opaque — only CLOSE silhouettes soften, which is
  // exactly where the speckle lived. Lighting is decoupled (CONE_DENSITY=3000),
  // so shading/colour is unchanged; only view-ray opacity buildup softens.
  //
  // Sweep 5000 (softest / most translucent) → 40000 (crisper / harder edges)
  // to taste. Watch thin wisps (translucency) and iso-altitude banding at the
  // low end.
  const uDensityMul = uniform(3000);
  // Base-volume tiling per scaled unit. 1 scaled unit = 1000 km.
  //
  // Was 250 → 4 km tile, 1 km cumulus cells. At orbital view distances,
  // 1 km features are sub-pixel and produce visible noise/speckle instead
  // of recognizable cumulus shapes. Reference engines (Nubis/HZD/RDR2)
  // operate with cumulus *bodies* on the order of 5–30 km wide so they
  // fill multiple screen pixels at the typical viewing distances.
  //
  // 50 → 20 km tile, 5 km low-freq Worley cells (cumulus puff size),
  // 2.5 km mid-freq, 1.25 km high-freq. Cumulus bodies are now ~5–10 km
  // wide and read as coherent cloud forms from any view distance,
  // including orbital.
  const uBaseScale = uniform(BASE_SCALE);
  // (uDetailScale + uDetailErosion REMOVED 2026-06-18 with the old opacity-only
  // detail-erosion pass they fed. Detail now comes from baseShapeCarved's
  // FINE_CARVE/WISP at FINE_CARVE_SCALE — see cloudDetile.ts + the dense branch.)
  // Domain warp is currently disabled inside the marcher (see DIAGNOSTIC
  // note where uvWarped = uvMid). When re-introducing with a smoother
  // (Perlin-only) warp source, recreate a `uWarpAmount = uniform(0.002)`
  // uniform here and pass it to the marcher; ~70 km world equivalent at the
  // equator is the sweet spot between visible structure breakup and
  // weather-map alignment with the flat overlay during 25–35 k crossfade.
  // Column-scale tile for per-column cloud-top variation (Nubis B2). Sampled
  // from baseVolume.r (Perlin) at the column's projection onto the inner
  // shell.
  //
  // Was 50 → ~5 km column cells. With the previous smoothstep(0.3, 0.7)
  // contrast on top of the column sample, adjacent columns ended up
  // wildly different in cloud-band thickness (5.5 km Δ), and their
  // boundaries projected as visible curved stripes on the cloud body.
  //
  // 20 → ~12.5 km columns. Combined with the SMOOTH linear topAlt mapping,
  // column boundaries were larger AND softer — no visible stripes.
  //
  // 2026-05-30: 20 → 8 (~31 km regions). At 12.5 km the per-column tower-
  // height variation was too fine to read as a skyline from ORBIT (averaged
  // to uniform grey at distance). Coarser regions make the height variation
  // visible from far AND give the re-introduced topAlt smoothstep spread
  // wide, soft region boundaries instead of stripes.
  //
  // 2026-06-18 (#1 per-cloud height variation): 8 → 30 (~33 km period,
  // ~8 km grid-4 cells). At 8 the deck top was dead-level across a close-up
  // view (every cloud within ~31 km capped at the same tower height → "straight
  // macro shape"). 30 gives cluster-scale (~8 km) height variation visible up
  // close. TRADEOFF: this is a single per-column scalar, so pushing it much
  // finer (per individual cumulus) reintroduces the bimodal "thickness cliff"
  // stripes (see the smoothstep history) AND averages to grey from orbit. True
  // per-cloud height variation without cliffs comes from the 3D mid-scale
  // billowing (#2), which shapes the top via the density field, not this scalar.
  // Shared uniform → the bake (cloudLightVolume.ts) stays in lockstep. Tune
  // live; lower toward ~12-16 if stripes/averaging appear, raise for finer.
  const uColumnScale = uniform(COLUMN_SCALE);
  // Cone-light radius — multiplier on the world-space kernel offsets in the
  // light march. 0.3 puts the outermost sample ~3 km perpendicular to the
  // primary sample (kernel norm ≈ 1, stepDist at i=5 ≈ 0.011 scaled = 11 km;
  // 0.3 × 11 km ≈ 3 km perpendicular spread). Wider = smoother but starts
  // sampling outside the cloud body for narrow towers; tighter = more
  // speckle. Schneider's reference is in this 0.25–0.4 range.
  const uLightConeRadius = uniform(0.3);

  // Shared crossfade uniform owned by earth.ts (`createUniforms`). 0 → flat
  // overlay only (above ~3000 km ALTITUDE), 1 → volumetric (below ~1500 km).
  // SpaceRenderer skips the cloud passes entirely while this is 0, so the
  // anchor mesh registering at the lod.near boundary (35 k km distance) costs
  // nothing until the camera actually descends toward the volumetric range.
  const uVolumetricBlend = ctx.uniforms.uVolumetricBlend;

  setupCloudPipeline({
    weatherMap,
    baseVolume,
    detailVolume,
    detailVolumeMip1,
    uInnerRadius,
    uOuterRadius,
    uCloudUvOffset,
    uDensityMul,
    uBaseScale,
    uColumnScale,
    uLightConeRadius,
    uVolumetricBlend,
    uSunRel: ctx.uSunRel,
    // Phase 3: bind the (shared, process-lifetime) transmittance LUT so the
    // marcher can read per-sample sun transmittance. Baked by SpaceRenderer's
    // atmosphere pass; null when the coupling toggle is off.
    transmittanceLUT: USE_ATMOSPHERE_CLOUD_LIGHTING
      ? getAtmosphereLUTs().transmittance.texture
      : undefined,
  });

  // Anchor mesh: empty geometry + material, parented to Earth's rotation
  // group via the celestial framework so its matrixWorld inherits the full
  // Earth transform. Lives on CLOUD_LAYER (no camera enables this layer →
  // never rendered). `onMount` registers it as the world-transform source
  // for the fullscreen pass's uEarthInverseModel.
  const anchorGeo = new THREE.BufferGeometry();
  const anchorMat = new NodeMaterial();
  return [
    {
      key: "earth-clouds",
      geometry: anchorGeo,
      material: anchorMat,
      tier: "near",
      renderLayer: CLOUD_LAYER,
      onMount: (mesh) => setEarthMatrixWorldSource(mesh),
    },
    shellDef,
  ];
}

/**
 * Pure cloud-volume marcher. Inputs are the Earth-local ray (`roEarth`,
 * `rdEarth`) and Earth-local sun direction (`sunDirEarth`); driven by the
 * fullscreen-quad pass (`cloudFullscreenPass.ts`) which reconstructs these
 * via `screenUV → FOV-based ray dir → uEarthInverseModel`. Geometry-agnostic
 * — anything that can produce the inputs can drive the same marcher.
 *
 * Returns `{ rgba, tFront }`:
 * - `rgba` — premultiplied `vec4(col, alpha) * uVolumetricBlend`.
 * - `tFront` — first-hit ray parameter in Earth-local units (= scaled-world
 *   units; magnitudes are preserved by Earth's rotation-only model matrix).
 *   Sentinel `-1` means the ray missed every cloud body. Used by Phase D3
 *   reprojection to compute the world-space cloud-front for history sampling.
 *
 * DEBUG_VIZ branches force α = 1 to bypass the volumetric crossfade and
 * return `tFront = 0` (reprojection is meaningless under diagnostic modes).
 */
// ── Atmosphere↔cloud lighting coupling (Phase 3, docs/ATMOSPHERE_PLAN.md §5.4) ──
// When ON, the marcher replaces its hand-tuned day→sunset sun/sky colours with
// PHYSICAL ones: per-sample sun colour = sunIlluminance × transmittance(LUT;
// cloud altitude, sun-zenith) — the SAME transmittance the sky + ship use, so
// clouds redden at sunset and darken in the planet's shadow consistently — and
// the ambient = the atmosphere sky tint. Build-time JS const → the off path is
// byte-identical to the pre-Phase-3 shader. The sacred per-sample `daylightS`
// terminator gate and `Tsun` self-shadow are UNTOUCHED; only the colour inputs
// change. CLOUD_SUN_SCALE / CLOUD_SKY_SCALE re-anchor the physical magnitudes to
// the marcher's existing tuned brightness (sunColor≈12, skyColor≈2) so Phase 3
// shifts COLOUR, not overall exposure (full unification is the §6 exposure pass).
const USE_ATMOSPHERE_CLOUD_LIGHTING = true;
// CLOUD_SUN_SCALE / CLOUD_SKY_SCALE now live in cloudCommon.ts (SHARED with the
// far-field overlay/shell so near↔far brightness matches — see ISSUE 2). Values
// unchanged (0.6 / 2.0).

export function marchCloudVolume({
  roEarth,
  rdEarth,
  sunDirEarth,
  weatherMap,
  baseVolume,
  detailVolume,
  detailVolumeMip1,
  uInnerRadius,
  uOuterRadius,
  uCloudUvOffset,
  uDensityMul,
  uBaseScale,
  uColumnScale,
  uLightConeRadius,
  uVolumetricBlend,
  uStbn,
  uStbnFrameSlice,
  uLodMinSamples,
  uLightVol,
  uLightVolB,
  uLightVolCenter,
  uLightVolCenterB,
  uLightVolHalfExtent,
  uLightVolAxisX,
  uLightVolAxisY,
  uLightVolAxisZ,
  uLightVolAxisXB,
  uLightVolAxisYB,
  uLightVolAxisZB,
  uLightVolMixA,
  uVolumeWeight,
  uTransmittanceLUT,
  uAtmoBottomRadius,
  uAtmoTopRadius,
  uAtmoH,
  uAtmoSunIlluminance,
  uAtmoSkyColor,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  roEarth: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rdEarth: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sunDirEarth: any;
  weatherMap: THREE.Texture;
  // Base is GPU-baked (Storage3DTexture); detail is still a CPU Data3DTexture.
  // THREE.Texture is the common base — texture3D() samples either.
  baseVolume: THREE.Texture;
  detailVolume: THREE.Texture; // GPU-baked Storage3DTexture (64³ level-0)
  detailVolumeMip1: THREE.Texture; // box-downsampled level-1 (32³) for the SS tap
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
  uStbn: THREE.Data3DTexture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uStbnFrameSlice: any;
  // Altitude-adaptive minimum samples per slab crossing (see the
  // LOD_MIN_SAMPLES_NEAR/FAR constants; CPU-lerped in cloudFullscreenPass).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uLodMinSamples: any;
  // ── 3D light-volume lookup (optional; only bound when USE_LIGHT_VOLUME) ──
  // Dual-volume crossfade pair (see cloudLightVolume.ts): A is sampled at
  // uLightVolMixA weight, B at (1 − mixA). Steady state sits at exactly 0 or
  // 1 so only one side is fetched outside transitions.
  uLightVol?: THREE.Texture;
  uLightVolB?: THREE.Texture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uLightVolCenter?: any; // side-A window CENTRE (earth space, scaled)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uLightVolCenterB?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uLightVolHalfExtent?: any; // shared: (x,z) tangent half-width; (y) altitude half-span
  // ── Per-side region tangent frames (earth space) — see shell addressing ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uLightVolAxisX?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uLightVolAxisY?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uLightVolAxisZ?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uLightVolAxisXB?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uLightVolAxisYB?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uLightVolAxisZB?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uLightVolMixA?: any; // crossfade weight of side A (1 = pure A)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uVolumeWeight?: any; // orbit fade (1 near → 0 orbit)
  // ── Atmosphere coupling (Phase 3) — see USE_ATMOSPHERE_CLOUD_LIGHTING ──
  uTransmittanceLUT?: THREE.Texture; // transmittance LUT (bound at build time)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uAtmoBottomRadius?: any; // ground radius (scaled units)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uAtmoTopRadius?: any; // atmosphere top radius (scaled units)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uAtmoH?: any; // √(Rt²−Rg²) (scaled units)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uAtmoSunIlluminance?: any; // top-of-atmosphere sun illuminance (vec3)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uAtmoSkyColor?: any; // sky-ambient tint (vec3)
}) {
    const b = dot(roEarth, rdEarth);
    const d2 = dot(roEarth, roEarth);

    // Outer shell: entry + far exit.
    const cOuter = d2.sub(uOuterRadius.mul(uOuterRadius));
    const discOuter = b.mul(b).sub(cOuter);
    const sqrtOuter = discOuter.max(0).sqrt();
    const tOuterNear = b.negate().sub(sqrtOuter);
    const tOuterFar = b.negate().add(sqrtOuter);

    // Inner shell: the upward FAR-side crossing (tInnerFar) is where a
    // below-deck camera enters the slab (tEnter, insideInner branch). The near
    // crossing is no longer used now that tExitSlab always reaches tOuterFar.
    const cInner = d2.sub(uInnerRadius.mul(uInnerRadius));
    const discInner = b.mul(b).sub(cInner);
    const sqrtInner = discInner.max(0).sqrt();
    const tInnerFar = b.negate().add(sqrtInner);

    // When the camera is below the inner shell (altitude < 1 km — flying low
    // through atmosphere), the slab is *above* the camera. Without this branch,
    // tEnter clamps to 0 and the march wastes half its steps in the gap below
    // the slab where the height gradient is zero. Setting tEnter to tInnerFar
    // (where the upward ray exits the inner sphere into the slab) reclaims
    // those samples for the cloud column that's actually present.
    const insideInner = cInner.lessThan(0);
    const tEnterDefault = tOuterNear.max(0);
    const tEnter = insideInner.select(tInnerFar.max(0), tEnterDefault);
    // March to the FAR outer-shell exit, NOT the first inner-shell crossing.
    // tExitSlab used to clamp to tInnerNear (the band BOTTOM) whenever a
    // downward ray hit the inner shell — truncating the march at the deck
    // floor. That's wrong for near-horizontal views from INSIDE the band: the
    // ray dips below the deck into the clear gap and RE-ENTERS the band far
    // away (the distant horizon clouds you see under a broken deck), but that
    // far segment was never marched → clouds cut off at a fixed distance, until
    // the camera dropped fully below the deck (insideInner) where tExitSlab was
    // already tOuterFar. Confirmed 2026-06-22 ("fixed distance inside the band,
    // unlimited below it"). The planet-surface clamp below floors downward rays
    // that actually hit the ground; the sub-deck gap (heightProfile = 0) is
    // skipped cheaply by the empty-space stride.
    const tExitSlab = tOuterFar;

    // ── Planet-surface occlusion clamp ──
    // tExitSlab now always reaches the far outer-shell exit (tOuterFar), so
    // this surface clamp is the SOLE mechanism flooring downward rays. It stops
    // the march at the near planet-surface intersection so a ray aimed at/below
    // the horizon is occluded by the ground instead of marching through the
    // planet into the cloud band on the far side (which renders clouds "through"
    // the ground — the whole planetary deck appearing below you, the original
    // antipodal-march bug). Rays aimed above the horizon never hit the surface
    // forward, so they march the full slab (near band + sub-deck gap + far
    // band) — that far band is the distant horizon clouds, now restored from
    // INSIDE the band too. Also kills the wasted antipodal march that tanked
    // perf below the deck. (Plan: "planet-occlusion clamp non-negotiable.")
    const surfaceRadius = uInnerRadius.sub(
      kmToScaledUnits(CLOUD_INNER_ALTITUDE_KM),
    );
    const cSurf = d2.sub(surfaceRadius.mul(surfaceRadius));
    const discSurf = b.mul(b).sub(cSurf);
    const tSurfNear = b.negate().sub(discSurf.max(0).sqrt());
    const hitsSurface = discSurf.greaterThan(0).and(tSurfNear.greaterThan(0));
    const tExitSurf = hitsSurface.select(tExitSlab.min(tSurfNear), tExitSlab);
    // ── Q1 near/far hand-off: cap the march where the shell takes over ──
    // Don't march past SHELL_HANDOFF_FAR_KM — beyond it the far shell (full
    // there, distance-faded in) carries the clouds. This is the case-#22 fix:
    // it stops the expensive far-deck/horizon marching (the orbit-perf valley).
    // Shares the shell's hand-off constant so the two stay coupled by
    // construction; slabLen (below) shrinks with it, so lodCap adapts for free.
    const tExit = tExitSurf.min(
      float(kmToScaledUnits(SHELL_HANDOFF_FAR_KM)),
    );

    const slabLen = sub(tExit, tEnter).max(0);
    // Fixed-world-space step sizes. dtSkip = 100 m, dtDense = 25 m
    // (4× finer). See the constants block above for why this is fixed
    // rather than slab-length-adaptive — short version: tower features
    // have constant world-space size so step size must too.
    const dtSkip = float(SKIP_STEP_SCALED);
    const dtDense = dtSkip.mul(float(DENSE_STEP_RATIO));
    // Per-ray cap for the distance-adaptive step (see LOD_STEP_GROWTH):
    // lodScale ≤ slabLen / (dtSkip · uLodMinSamples) guarantees at least
    // uLodMinSamples steps across THIS ray's slab path, so the growth can't
    // over-step a thin slab (orbit looking down). Loop-invariant; .max(1) keeps
    // the cap from ever forcing steps finer than the base. uLodMinSamples is
    // altitude-adaptive (60 near the deck → 24 high above; see constants).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lodCap: any = slabLen.div(dtSkip.mul(uLodMinSamples)).max(1);

    // Per-pixel dither: jitters the ray entry point by [0, dtSkip) per
    // fragment so adjacent pixels' discovery samples don't all align to
    // the same dtSkip-spaced grid — without this, step-aliasing produces
    // visible concentric "miss-rings" at iso-distance from the camera.
    //
    // Phase D1: spatiotemporal blue noise (STBN). Sampled at
    //   uv = (screenCoordinate.xy mod STBN_PERIOD_XY, uStbnFrameSlice)
    // → 128² spatial tile (RepeatWrapping handles the mod), 64 temporal
    // slices selected per frame from `uStbnFrameSlice`.
    //
    // Properties this gives us that the old `fract(sin(...))` hash
    // didn't:
    //   - Adjacent pixels have decorrelated *but* blue-noise-distributed
    //     values, so per-pixel step aliasing breaks AND the spatial
    //     pattern is perceptually smooth (no high-frequency hash speckle).
    //   - Consecutive frames at one pixel are designed to be blue-noise-
    //     distant in time, so TAA integration converges to a clean
    //     supersampled image rather than just averaging hash noise.
    //
    // Until the async loader (`stbnTexture.ts`) resolves, the texture
    // returns 0; the marcher renders with no jitter for a few frames
    // (mild banding) and then jitter smoothly fades in once the bytes
    // arrive — no flash, no recompile.
    const stbnUv = vec3(
      screenCoordinate.x.div(float(STBN_PERIOD_XY)),
      screenCoordinate.y.div(float(STBN_PERIOD_XY)),
      uStbnFrameSlice,
    );
    const dither = texture3D(uStbn, stbnUv).r;
    // (Two further STBN taps — an altitude dither and a per-pixel LOD-growth
    // dither — lived here as band-fix attempts; both empirically refuted and
    // removed 2026-06-10. The per-sample stratified jitter in the loop is
    // what actually broke the bands.)
    // March start = slab entry. A START_JITTER_FRAC whole-grid jitter was
    // tried here (moves the march cell walls per pixel/frame) — traded bands
    // for flicker, refuted, removed.
    const tStart = tEnter;

    // Dual-lobe Henyey-Greenstein phase, constant per fragment (sun is
    // effectively at infinity vs cloud scale, and the view dir is constant
    // along the march). See HG_FORWARD/HG_BACK/HG_BLEND for the rationale.
    const cosTheta = dot(rdEarth, sunDirEarth);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hgLobe = (gVal: number): any => {
      const gC = float(gVal);
      const ggC = gC.mul(gC);
      const denomC = pow(
        float(1).add(ggC).sub(gC.mul(2).mul(cosTheta)).max(0.0001),
        float(1.5),
      );
      return float(1).sub(ggC).div(float(4).mul(PI).mul(denomC));
    };
    const phase = mix(hgLobe(HG_FORWARD), hgLobe(HG_BACK), float(HG_BLEND));

    // Sun colour is computed per-fragment below from the local sun-elevation
    // because we tint sunlight toward orange at the terminator.

    // Accumulate transmittance + in-scatter along the view ray (front-to-back).
    const T = float(1.0).toVar();
    const col = vec3(0, 0, 0).toVar();
    const invSlabThickness = float(1.0).div(sub(uOuterRadius, uInnerRadius));

    // ── Per-pixel coverage cache (three-tap + piecewise lerp) ──
    // Coverage is sampled at the ray's slab ENTRY, MIDPOINT, and EXIT
    // points and piecewise-lerped per-step along the march.
    //
    // History of this scheme:
    //   - Original single-midpoint sample failed for camera-inside-slab
    //     horizontal views (slab path 100+ km, midpoint UV 100s of km
    //     from camera nadir → coverage gate failed → empty middle).
    //     See `docs/CLOUD_DEBUGGING_LESSONS.md`.
    //   - Two-tap (near+far+lerp) fixed that case but introduced a new
    //     one: camera ABOVE the slab looking tilted-down at a cumulus
    //     between the ray's slab-entry and slab-exit. Both endpoints
    //     sample weather map at lat/lons that miss the cumulus → coverage
    //     low along entire ray → cloud barely renders. Visible as "cloud
    //     bodies have proper opacity from below, but barely visible from
    //     above" — same physics bug, different geometry.
    //   - Three-tap (near+mid+far + piecewise lerp) catches all three
    //     regimes: cumulus at ray-start (covNear), cumulus mid-chord
    //     (covMid), cumulus at ray-end (covFar). Outer skip-gate uses the
    //     max of all three; per-step lerp piecewise blends through the
    //     three samples.
    //
    // pMid is reused — it's already computed for sunDotPoint and the
    // 'topAlt' diagnostic, where it's slow-varying.
    const tMid = tEnter.add(slabLen.mul(0.5));
    const pMid = roEarth.add(rdEarth.mul(tMid));
    const rMid = length(pMid).max(0.0001);
    const dirMid = pMid.div(rMid);

    // Slab-midpoint topAlt sample for the 'topAlt' diagnostic mode. Cheap
    // (one extra texture3D tap; same column-scale value the loop already
    // computes per-step). Always evaluated so JS-side debug branching at
    // build time can use it without restructuring the shader graph.
    // v2: the 'topAlt'/'profile' diagnostics read the map's B/G at the mid
    // direction (so they stay truthful under WEATHER_V2). Legacy: colSample-
    // derived, mirroring the per-step topAlt mapping (shared topAltSpread,
    // range [0.45, 0.95], incl. the TOPALT_LINEAR toggle).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let topAltMid: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cloudTypeMidV2: any = null;
    if (WEATHER_V2) {
      const wMid = texture(
        weatherMap,
        equirectDirToUv(dirMid, uCloudUvOffset),
      ).level(int(0)) as Node;
      topAltMid = topHeightToTopAlt(wMid.b);
      cloudTypeMidV2 = wMid.g;
    } else {
      const pMidColumn = dirMid.mul(uInnerRadius);
      const colSampleMid = (
        texture3D(baseVolume, pMidColumn.mul(uColumnScale)).level(
          int(0),
        ) as Node
      ).r;
      topAltMid = float(0.45).add(topAltSpread(colSampleMid).mul(0.5));
    }

    // Coverage near/mid/far hoisted samples — see comment block above.
    const pNear = roEarth.add(rdEarth.mul(tEnter));
    const pFar = roEarth.add(rdEarth.mul(tExit));
    const rNear = length(pNear).max(0.0001);
    const rFar = length(pFar).max(0.0001);
    const dirNear = pNear.div(rNear);
    const dirFar = pFar.div(rFar);
    // Shared equirect projection (cloudCommon.equirectDirToUv) — one definition
    // for marcher + overlay + shell so their cloud features register.
    const uvNear = equirectDirToUv(dirNear, uCloudUvOffset);
    const uvFar = equirectDirToUv(dirFar, uCloudUvOffset);
    // Midpoint UV — reuses pMid/dirMid already computed above for sunDotPoint.
    const uvMidWeather = equirectDirToUv(dirMid, uCloudUvOffset);
    // Domain warping (previously applied to the single uvMid sample) is
    // currently disabled — the warp source had Worley cells visible at
    // close range. Keep the clean uvNear/uvMid/uvFar values for now;
    // re-enable with a Perlin-only low-frequency warp source when we
    // revisit it.
    const covNear = (texture(weatherMap, uvNear).level(int(0)) as Node).r;
    const covMid = (
      texture(weatherMap, uvMidWeather).level(int(0)) as Node
    ).r;
    const covFar = (texture(weatherMap, uvFar).level(int(0)) as Node).r;
    // Outer-gate proxy: skip the whole march only if ALL THREE tap points
    // have near-zero coverage. Catches cumulus at ray-start, mid-chord,
    // or ray-end equally.
    const coverageMax = covNear.max(covMid).max(covFar);

    // ── Terminator daylight is PER-SAMPLE, not per-ray ──
    // It used to be computed once per ray at the slab-chord midpoint pMid
    // ("varies slowly across the slab"). At the LIMB that assumption breaks
    // discontinuously: rays that hit earth have their chord clamped at the
    // surface, while rays a pixel higher march on to the far shell behind
    // the planet — pMid jumps hundreds of km between neighbouring pixels,
    // so daylight/sunset jumped with it, drawing a hard curved lighting
    // line through the clouds exactly along the horizon (worst near the
    // terminator where daylight's gradient is steep). The same slab-
    // midpoint anti-pattern as CLOUD_DEBUGGING_LESSONS case study #2 —
    // daylightS/sunColorS/skyColorS now live in the dense branch, evaluated
    // at each sample p. This ray-level value survives ONLY for the
    // DEBUG_VIZ 'daylight' view.
    const pDotS_Mid = dot(pMid, sunDirEarth);
    const sunDotPoint = pDotS_Mid.div(rMid);
    const daylight = smoothstep(float(-0.1), float(0.1), sunDotPoint);

    // Skylight: scalar attenuation of skyColor, multiplied into ambient.
    // Tuned together with skyColor for shadow brightness:
    //   0.25 (previous): ambient × skyColor(4) = 1 HDR floor → shadows
    //     at AgX 0.5, too bright vs sunlit AgX 0.86. Low contrast.
    //   0.15: ambient × skyColor(2) = 0.3 HDR floor → shadows at AgX 0.25.
    //     Still kept crevices/undersides too lit to read as a deck of
    //     discrete puffs from above — they washed into a uniform tan sheet.
    //   0.07 (current): ambient × skyColor(2) = 0.14 HDR floor → shadows at
    //     AgX ~0.13. Crevices between cells and cloud undersides go genuinely
    //     dark so the cellular structure separates from above (the deep
    //     valley shadows the Star Citizen / KSP-EVE refs rely on). Only the
    //     shadow fill is affected — sunlit tops (sun-dominated) are unchanged,
    //     so this raises contrast without dimming the deck overall.
    // Tracks daylight via skyColor (no duplication needed here).
    const skylight = float(0.07);

    // Powder blend, constant along ray (depends only on cosTheta).
    const powderFrontMix = clamp(cosTheta.mul(0.5).add(0.5), 0, 1);
    const powderFrontInv = powderFrontMix.oneMinus();

    // Constants, hoisted so TSL doesn't rebuild them per-iteration.
    const phaseIsotropic = float(0.07957747); // 1 / (4π)
    const densScale = uDensityMul;

    // ── Tile-&-offset shape samplers (anti-tiling; see cloudDetile.ts) ──
    // Dilated, and dilated+carved, base shape at an arbitrary Earth-space
    // scaled position — mirrors the inline composition at the primary/probe
    // sites so detileBlend() can blend them across rigidly-offset tiles. Used
    // only on the USE_DETILE path; the OFF path keeps the original inline warp.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dilatedShapeAt = (pos: any) => {
      const bs = texture3D(baseVolume, pos.mul(uBaseScale)).level(
        int(0),
      ) as Node;
      const fbm = bs.g.mul(0.625).add(bs.b.mul(0.25)).add(bs.a.mul(0.125));
      return baseDilate(bs.r, fbm);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const carvedShapeAt = (pos: any) => {
      const dil = dilatedShapeAt(pos);
      const cs = texture3D(detailVolume, pos.mul(float(CARVE_SCALE))).level(
        int(0),
      ) as Node;
      return billowCarveKernel(dil, cs);
    };

    // Diagnostic counters hoisted to fragment scope so the debug return at
    // the bottom of the shader can read them. Always declared (zero cost
    // when DEBUG_VIZ === 'off' since the GPU's dead-store elimination
    // drops the increments). When the whole-column coverage gate fails
    // these stay 0, which correctly reads as "march never engaged".
    const primaryIters = float(0).toVar();
    const denseIters = float(0).toVar();
    // Why the march ended (DEBUG_VIZ='whyStop'): 0 = ran out of the 96-step
    // budget (cutoff), 1 = exited the slab (saw the whole path), 2 = went
    // opaque (blocked by cloud — correct). Default 0 = budget. Function-scope
    // so the post-loop diagnostic branch can read it.
    const exitReason = float(0).toVar();
    // Sentinel = -1 (no hit). Captured the first time skip-mode finds
    // cloud along the ray; the t-value at that point is the cloud-front
    // depth for this pixel. Used by the TAA reprojection for accurate
    // history sampling, and by DEBUG_VIZ='firstHit' for parallax checks.
    const firstHitT = float(-1).toVar();

    // Opacity-weighted depth accumulators — the transmittance-weighted
    // "apparent" depth used for TAA reprojection. firstHitT (the FIRST sample
    // above the gate) is meaningless for diffuse/low-density cloud — the first
    // faint speck is essentially random — so reprojecting history through it
    // lands at the wrong parallax → the swimming "ghost-cloud" dots (confirmed:
    // sparseOnly, which skips reprojection, shows no swimming). Instead we
    // accumulate Σ(t·w) / Σ(w) with w = scatterFrac·T = each step's opacity
    // contribution that actually reaches the camera. Opaque cloud → weight
    // piles at the front → ≈ firstHitT (no change to what works); diffuse cloud
    // → a STABLE centre-of-mass depth instead of garbage. (Schneider/Hillaire
    // canonical cloud-reprojection depth.)
    const weightedDepthSum = float(0).toVar();
    const depthWeightSum = float(0).toVar();

    // Last-dense Tsun_ms capture for DEBUG_VIZ='tsunMs'. Persists the most
    // recent multi-scatter transmittance from the dense march so we can
    // visualise whether the cone-march is producing spatial variation.
    // Front-to-back integration means the LAST written value is from
    // roughly the visible surface (where alpha saturates).
    const lastTsunMs = float(0).toVar();
    const lastTsun = float(0).toVar(); // DEBUG_VIZ='lightVol' / cone parity

    // Last-dense raw cone-march optical depth, for DEBUG_VIZ='coneDepth'.
    // Shows opticalDepthSun directly (before pow-tonemap), bypassing the
    // aggressive compression of pow(x, 0.15) which makes Tsun_ms look
    // uniform at high transmittance (0.92 vs 0.74 over a 4x range of
    // underlying opticalDepth). This is the un-tonemapped truth about
    // whether the cone-march finds varying absorption.
    const lastOpticalDepthSun = float(0).toVar();
    // FIRST-dense-voxel cone optical depth (vs lastOpticalDepthSun = last).
    // For DEBUG_VIZ='firstConeDepth'. The visible surface is dominated by the
    // first dense voxel (high opacity saturates there), so this is the self-
    // shadow of what we actually SEE. Comparing to 'coneDepth' (last voxel)
    // answers: surface uniformly lit (first uniform, last varies → need
    // boundary/tower relief) or surface itself varies (first varies → lighting
    // combine is flattening it). Sentinel −1 = ray never entered dense mode.
    const firstOpticalDepthSun = float(-1).toVar();

    // Last-dense voxel density (eroded × densScale), for DEBUG_VIZ='density'.
    // Shows the actual primary-voxel density at the visible surface. If
    // this varies pixel-to-pixel at close range, the underlying data has
    // variation and the lighting model is just not surfacing it. If
    // uniform, the noise volumes don't have sub-100m features and no
    // lighting tweak can produce close-range body detail without a
    // different mechanism (e.g. higher-res noise or local self-shadow).
    const lastDensity = float(0).toVar();

    // Last-dense eroded value (per-voxel post-detail-erosion shape, 0-1
    // range, no densScale). For DEBUG_VIZ='eroded'. Same diagnostic intent
    // as 'density' but normalised — shows the detail-noise structure
    // directly without the densScale multiplier obscuring it.
    const lastEroded = float(0).toVar();

    // ── Cauliflower-detail measurement captures ──
    // Dead-store-eliminated when DEBUG_VIZ is 'off'. Captured at the last dense
    // voxel (≈ the visible surface after front-to-back saturation).
    //   lastLitShape = the [0,1] LIT base shape the 800 m self-shadow probe
    //                  absorbs by (base+macro-carve). Day side only; 0 at night.
    const lastLitShape = float(0).toVar();
    // exp(-odNear) — the NEAR detail self-shadow term in isolation (DEBUG_VIZ
    // 'detailShadow'). 1 = no near occlusion; <1 = detail occluded the sun.
    const lastDetailSS = float(1).toVar();

    // ── Field-vs-sampling discriminators (DEBUG_VIZ 'maxProfile' /
    // 'maxProbeShape', added 2026-06-11 during the far-small-cloud hunt) ──
    // maxProfile  = max coverage×heightProfile seen along the ray. BLACK at
    //   a distance where clouds are missing ⇒ the march never SAMPLED the
    //   cloud altitude band there (geometry/stepping problem).
    // maxProbeShape = max remapped probe shape seen along the ray. maxProfile
    //   GRAY but maxProbeShape BLACK ⇒ the band was sampled but the FIELD
    //   passes nothing through the Remap threshold there (density-model
    //   problem — thresholds/noise distribution, not stepping).
    // Together they split every "clouds missing at distance" hypothesis into
    // sampling vs field in one screenshot each.
    const maxProfile = float(0).toVar();
    const maxProbeShape = float(0).toVar();
    // DEBUG ONLY: max raw dilated+carved base shape along the ray (drives the
    // 'baseShape' / 'floaterProbe' DEBUG_VIZ). Dead-store eliminated when
    // DEBUG_VIZ === 'off'.
    const maxBaseShape = float(0).toVar();

    // ── Outer gate neutralised (trivially-true condition) ──
    // Previously: `If(coverageMax > 0.01)` based on hoisted 3-tap samples.
    // That gate caused the "wireframe outlines / cloud portal" artifact:
    // pixels where all 3 hoisted taps missed the cumulus had their entire
    // marcher skipped → wireframe outline at the iso-pass boundary.
    //
    // Per-step coverage (sampled inside the loop body) is now the actual
    // gating mechanism — every voxel sees coverage at its real lat/lon.
    //
    // The `If(...)` STRUCTURE is preserved with a trivially-true condition
    // because removing it entirely caused the marcher to silently produce
    // alpha=0 everywhere (some TSL scope / variable visibility interaction
    // I don't fully understand). Keeping the If with `coverageMax >= 0`
    // (always true since covNear/covMid/covFar are texture samples in
    // [0, 1]) preserves the TSL graph topology while effectively
    // bypassing the gate.
    If(coverageMax.greaterThanEqual(0), () => {
      // ── Two-state adaptive march (Nubis C1+C2) ──
      //
      // stepMode  0 = skip mode (cheap probe, big steps)
      //           1 = dense mode (full sample, small steps, accumulates)
      //
      // Skip mode samples only the base Schneider shape — one texture3D tap
      // for the volume, plus the column-top tap that's needed everywhere.
      // It advances at dtSkip (~slab/16) until the probe finds cloud, at
      // which point it rewinds half a long step and switches to dense.
      //
      // Dense mode samples the full pipeline (Schneider remap, detail
      // erosion, cone-traced light march, multi-scatter, accumulation).
      // Steps are dtDense = 4× finer than skip — the resolution win that
      // makes close-range cloud bodies look like solid 3D shapes instead
      // of blurry slabs. After EMPTY_THRESHOLD consecutive empty samples,
      // it falls back to skip mode so we don't waste short steps on the
      // far side of a thinning cloud.
      const stepMode = float(0).toVar(); // start in skip mode (cheap empty-space reach)
      const t = tStart.toVar();
      const emptyStreak = float(0).toVar();

      Loop(MAX_PRIMARY_STEPS, () => {
        If(t.greaterThan(tExit), () => {
          exitReason.assign(1);
          Break();
        });
        primaryIters.addAssign(1);

        // Distance-adaptive step size (see LOD_STEP_GROWTH). Grows with `t`,
        // capped per-ray by lodCap. Used by the advance, the skip→dense rewind,
        // AND the density integration (a longer step covers more cloud, so it
        // must integrate proportionally more optical depth).
        const lodScale = float(1)
          .add(t.mul(float(LOD_STEP_GROWTH)))
          .min(lodCap);
        const dtSkipGrown = dtSkip.mul(lodScale);
        // Detection cap for the IN-BAND skip step (see SKIP_DETECT_CAP_SCALED
        // — the "small clouds fade in close" fix). The empty-space advance
        // further below still uses the uncapped dtSkipGrown for reach.
        const dtSkipInBand = dtSkipGrown.min(float(SKIP_DETECT_CAP_SCALED));
        // Dense INTEGRATION step: footprint-matched distance growth, DECOUPLED
        // from lodCap (2026-06-22, Issue ③). lodCap guarantees uLodMinSamples
        // across the slab for DETECTION/reach (the skip stride) — but on a THIN
        // orbit-down slab it clamps lodScale to ~2.7, pinning the dense step to
        // ~67 m and burning ~200 dense iterations per ray grinding through the
        // broken deck. Integration doesn't need that fineness: a far, small-on-
        // screen puff integrates fine at the footprint scale. So grow the dense
        // step with distance via lodScaleDense (the SAME 1+t·GROWTH, but without
        // the lodCap clamp), bounded by (a) dtSkipInBand — never coarser than
        // the stride that DETECTED the body — and (b) the validated-clean
        // DENSE_INTEG_CAP. At orbit dense ≈ skip ≈ footprint → ~4× fewer dense
        // steps; up close (small t) it stays at the fine dtDense floor.
        const lodScaleDense = float(1).add(t.mul(float(LOD_STEP_GROWTH)));
        const dtDenseL = dtDense
          .mul(lodScaleDense)
          .min(dtSkipInBand)
          .min(float(DENSE_INTEG_CAP_SCALED));
        // Budget-death fix (see DENSE_OPACITY_GROWTH / DENSE_ITER_GROWTH):
        // dense step grows with accumulated opacity (covered pixels stop
        // burning fine steps on cloud they can barely see) AND with the
        // dense-iteration count (wispy bodies keep T high, so depth into the
        // march is the only signal that the budget is being eaten). These
        // multipliers apply ON TOP of the integration cap — they exist to
        // protect the budget, which the cap alone would otherwise spend.
        const dtDenseEff = dtDenseL.mul(
          float(1)
            .add(float(1).sub(T).mul(float(DENSE_OPACITY_GROWTH)))
            .add(denseIters.mul(float(DENSE_ITER_GROWTH))),
        );

        // Per-sample stratified jitter (Frostbite §5.5.3): offset this sample
        // within its LOCAL step using a per-step low-discrepancy value — a
        // golden-ratio additive recurrence (primaryIters × φ⁻¹) rotated by the
        // per-pixel blue noise `dither`. `t` stays the nominal march position
        // (progression, depth, detail/pattern LOD); only the SAMPLE moves.
        //
        // Jitter scale = the CURRENT mode's step. CRITICAL: in SKIP mode use a
        // FULL skip step. The cloud FRONT is detected at skip resolution, which
        // grows coarse with distance → the front (and the colour + tFront depth
        // downstream) snaps to the skip grid → iso-distance bands (confirmed in
        // BOTH sparseOnly AND tFront, and deterministic, so the EMA couldn't
        // average them). A full-skip-step jitter makes the detection point vary
        // a whole step per frame → the EMA then averages the quantization away.
        // The earlier dtDenseL-everywhere scale (= 0.25 skip step) was far too
        // weak to dither the detection grid — which is why the bands survived
        // every previous attempt. Dense mode keeps the fine dtDenseL scale
        // (stratify the integration without over-jittering it).
        //
        // Jitter uses the IN-BAND (capped) skip step, not the empty-space
        // grown one: the jitter's job is breaking the DETECTION grid, which
        // only exists where clouds can (the capped regime). Jittering across
        // a full multi-km empty-space step would also smear tFront by ± that
        // step for no benefit.
        const stratJitter = fract(
          dither.add(primaryIters.mul(float(0.61803398875))),
        );
        const jitterScale = stepMode
          .lessThan(0.5)
          .select(dtSkipInBand, dtDenseEff);
        const tSample = t.add(stratJitter.mul(jitterScale).mul(DITHER_FRACTION));
        const p = roEarth.add(rdEarth.mul(tSample));
        const r = length(p).max(0.0001);
        const altitude01 = clamp(
          sub(r, uInnerRadius).mul(invSlabThickness),
          0,
          1,
        );

        // ── Per-step coverage sampling ──
        // Sample the weather map at the CURRENT march position's lat/lon.
        // Replaces the 3-tap near/mid/far + piecewise lerp, which failed
        // for cumulus that fell in the gap between tap points (visible
        // as "two halves of a cloud with empty middle" — same family as
        // the original case study in CLOUD_DEBUGGING_LESSONS.md). Per-step
        // is the only fully-general scheme: every voxel sees coverage at
        // its actual lat/lon, no aliasing from sample density.
        //
        // Cost: one extra 2D texture lookup per primary loop iteration.
        // For pixels missing cloud, the outer `coverageMax > 0.01` gate
        // (still using the hoisted 3-tap max) early-exits the loop so
        // they pay 0 of these per-step samples. For pixels through cloud
        // regions, ~96 extra weather-map taps — modest cost on modern GPUs.
        const dirP = p.div(r);
        const uvP = equirectDirToUv(dirP, uCloudUvOffset);
        // ONE weather tap, swizzled (never re-sampled). Forced mip 0 (the
        // marcher's per-quad derivatives break auto-mip — case #2). v2 reads
        // RGBA = coverage/convectivity/topHeight/cirrus; legacy uses only .r.
        const wTap = texture(weatherMap, uvP).level(int(0)) as Node;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let coverageRaw: any = wTap.r;
        if (WEATHER_V2 || MESOSCALE_TEST) {
          // MARCHER-SPACE mesoscale octave (§3.6 H3): mask coverage with a
          // ~31 km cellular field (true zeros in the lanes) sampled from the 3D
          // base noise — resolution-FREE, so it supplies the 10-40 km local
          // organization a 2D equirect map at 2048px physically cannot carry
          // (the Phase-1a RESOLUTION FORK, resolved toward option b). In v2 this
          // is the STANDING mechanism (layered under the map's coarse hundreds-
          // of-km cells → hierarchical, like real Sc); in legacy it's the
          // Phase-F MESOSCALE_TEST preview. World-anchored (projected to the
          // inner shell → a 2D pattern on the sphere, not volume noise).
          const mesoTap = texture3D(
            baseVolume,
            dirP.mul(uInnerRadius).mul(float(MESO_SCALE)),
          ).level(int(0)) as Node;
          coverageRaw = coverageRaw.mul(
            smoothstep(float(MESO_LANE_LO), float(MESO_LANE_HI), mesoTap.r),
          );
        }

        // Coverage. LEGACY lifts with pow(0.6) (the Nubis Remap thresholds away
        // coverage under ~1−baseShape, so the raw low/mid deck would be deleted;
        // the lift kept 0→0). v2 consumes LINEAR coverage — the lift existed
        // only for the old K<1 erosion; the adopted Nubis-form K=1 (§3.6 H2)
        // makes it unnecessary and the baker owns the histogram.
        const coverage = WEATHER_V2 ? coverageRaw : coverageRaw.pow(float(0.6));

        // ── Cloud type ──
        // v2: the map's G channel (convectivity) — an INDEPENDENT type axis, so
        // type no longer collapses to a function of coverage (the binary-border
        // fix). LEGACY: coverage-derived (cloudShared.deriveCloudType).
        const cloudType = WEATHER_V2 ? wTap.g : deriveCloudType(coverage);

        // ── Per-column top altitude + anti-tiling warp ──
        // v2: topAlt from the map's B channel (topHeight) → the per-step 3D
        // COLUMN TAP is DELETED (−1 texture3D/step, the plan's perf win); warp
        // is a zero vector (WARP_AMPLITUDE=0) so v2 skips it outright. LEGACY:
        // colSample→deriveTopAlt + the g/b/a warp vector (case #19 — warp off).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let topAlt: any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let warpVec: any;
        if (WEATHER_V2) {
          topAlt = topHeightToTopAlt(wTap.b);
          warpVec = vec3(0, 0, 0);
        } else {
          const pColumn = p.div(r).mul(uInnerRadius);
          // Explicit mip 0 (case #2, as above).
          const colTap = texture3D(baseVolume, pColumn.mul(uColumnScale)).level(
            int(0),
          ) as Node;
          const colSample = colTap.r;
          warpVec = vec3(
            colTap.g.sub(0.5),
            colTap.b.sub(0.5),
            colTap.a.sub(0.5),
          ).mul(float(WARP_AMPLITUDE));
          // Coverage-gated spread of the Perlin-Worley column sample; the
          // "lava-lamp floater" / bimodal history lives in cloudShared. v2 moves
          // the floater-avoidance coupling into the BAKER (§4.2). WATCH for
          // stripes: if they return, lower uColumnScale.
          topAlt = deriveTopAlt(coverage, colSample);
        }

        // (An altitude-perturbation hash and a profile-blur band-limit lived
        // here as iso-altitude-band fixes; both empirically refuted — removed
        // 2026-06-10. The band fix that stuck is the footprint-matched base
        // mip below.)

        // ── Dimensional profile (Nubis B4) ──
        // profile = coverage × heightProfile(alt, cloudType). First-class
        // shader local that drives BOTH density (via Schneider value
        // erosion below) and lighting (ambient + multi-scatter probability
        // fields in B5). Combining them at this layer keeps the "smooth
        // core, eroded surface" gradient that profile-driven Nubis lighting
        // depends on.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const heightProfile: any = cloudHeightProfile(
          altitude01,
          topAlt,
          cloudType,
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const profile: any = coverage.mul(heightProfile);
        maxProfile.assign(maxProfile.max(profile));

        // Tracks whether this iteration found cloud (drives empty-streak
        // bookkeeping below). Zero by default; set to 1 inside the cloud
        // branches.
        const hitThisStep = float(0).toVar();

        // Step-level empty-space skip — gate on `coverage × profile` so the
        // outer fringes of the slab (above/below the active cloud-type band)
        // skip 3D taps entirely.
        If(profile.greaterThan(0.01), () => {
          // ── Cheap probe: Schneider macro shape (no detail erosion) ──
          // Used by both modes. In skip mode it's the only volume sample
          // taken; in dense mode it feeds into the detail-erosion pipeline.
          // R = pure Perlin-Worley, GBA = three octaves of Worley FBM. The
          // remap `(R + 1 - fbm) / (2 - fbm)` dilates the macro shape
          // proportionally to FBM strength. Sampled at the WARPED position
          // (anti-tiling, see warpVec above).
          //
          // EXPLICIT LEVEL 0 — a footprint-matched mip lod lived here briefly
          // (2026-06-10/11) and was the root cause of "small clouds fade in
          // at close range / only big decks at the horizon": three r183's
          // WebGPU backend allocates mipLevelCount = texture.mipmaps.length
          // for a Data3DTexture but its upload path NEVER writes the mipmaps
          // array (level 0 only, slice by slice) — so levels 1+ are
          // WebGPU-zero-initialized and any .level(>0) sample blends toward
          // ZERO. The dilated base then collapses to (0+1)/(2−0) = 0.5 and
          // the carved shape to exactly 0 with distance, deleting everything
          // the Remap threshold doesn't favour. This was ALSO the real cause
          // of the 2026-06-03 "mips drop coverage" revert (misdiagnosed then
          // as box-filter variance loss). See CLOUD_DEBUGGING_LESSONS case
          // study #16. patches/three@0.183.2.patch (2026-06-11) makes the
          // backend upload the mipmaps[] chain, so .level(>0) is now safe —
          // taps stay at level 0 until the footprint-matched mip scheme is
          // deliberately re-enabled.
          const baseShapeCarved = float(0).toVar();
          if (USE_DETILE) {
            // ── Tile-&-offset anti-tiling (cloudDetile.ts) ──
            // Blend the dilated+carved base shape across 4 rigidly-offset
            // tiles → no warp, no shear (the warp's km-scale shear was the
            // "stringy" cause; see CLOUD_DEBUGGING_LESSONS #19). NOTE: the
            // original's "skip carve when the uncarved base fails the Remap
            // threshold" perf gate is dropped here — the 4-tap blend carves at
            // every contributing tile. Profile; if the hot loop is too slow,
            // lower DETILE_BLEND for a single-tap interior + seam-only blend.
            baseShapeCarved.assign(detileBlend(p, carvedShapeAt));
          } else {
            // ── ORIGINAL single-tap domain-warp path (anti-tiling via warp) ──
            const pWarped = p.add(warpVec);
            const baseSample = texture3D(
              baseVolume,
              pWarped.mul(uBaseScale),
            ).level(int(0)) as Node;
            const baseFbm = baseSample.g
              .mul(0.625)
              .add(baseSample.b.mul(0.25))
              .add(baseSample.a.mul(0.125));
            // Dilated base shape — erosion form (see cloudDetile.ts baseDilate).
            const baseShape = baseDilate(baseSample.r, baseFbm);
            // ── Mid-scale billowy carve (Step 1; see BILLOW_CARVE) ──
            // Carve valleys (low carve-Worley) deeper than lump centres so the
            // smooth dilated dome becomes ~1-2 km cauliflower. Schneider
            // value-erosion form.
            //
            // NECESSARY-CONDITION GATE (perf): the macro carve only LOWERS the
            // shape, so if the UNCARVED base fails the Remap threshold it fails
            // carved too — skip. WIDENED by the fine octave's max OUTWARD bulge
            // (FINE_MAX_BULGE) so a centered fine octave can extend the
            // silhouette just past the macro footprint (the "half-lumps" fix);
            // 0 when FINE_CARVE off / bias=1 → original gate.
            const remapThreshold = float(1).sub(profile);
            If(baseShape.greaterThan(remapThreshold.sub(float(FINE_MAX_BULGE))), () => {
              const carveSrc = texture3D(
                detailVolume,
                pWarped.mul(float(CARVE_SCALE)),
              ).level(int(0)) as Node;
              baseShapeCarved.assign(billowCarveKernel(baseShape, carveSrc));
              // ── Fine octave folded into the base field (see FINE_CARVE_BIAS) ──
              // CENTERED perturbation, not a one-sided erosion: raises the field
              // where the fine noise is high (lump bulges OUT past the macro
              // envelope) and lowers it where low (crease IN). This makes the
              // silhouette multi-octave — what Frostbite noiseL / Nubis's noise
              // composite do — so lumps define the outline instead of being
              // clipped to the macro shape (the "half-lumps"). The near probe
              // samples the SAME fine octave along the sun ray → correlated
              // self-shadow. +1 texture3D per dense voxel.
              if (FINE_CARVE) {
                const fineSrc = texture3D(
                  detailVolume,
                  pWarped.mul(float(FINE_CARVE_SCALE)),
                ).level(int(0)) as Node;
                // Footprint LOD (DETAIL_FADE_*): fade the whole fine
                // perturbation toward 0 with march distance so sub-pixel detail
                // far away can't alias (flicker) — only the macro billow form
                // survives at range, which is all the footprint resolves.
                const detailFade = float(1).sub(
                  smoothstep(
                    float(DETAIL_FADE_NEAR),
                    float(DETAIL_FADE_FAR),
                    t,
                  ),
                );
                // Grade → wisp → HHF → centered bias·strength·fade (shared with
                // the near self-shadow probe — see fineCarveDelta).
                const fineDelta = fineCarveDelta(fineSrc, profile, t, detailFade);
                baseShapeCarved.assign(baseShapeCarved.add(fineDelta).clamp(0, 1));
              }
            });
          }
          // ── Dense-mode gate: the REMAPPED shape, not the macro product ──
          // (2026-06-11) This gate used to be `baseShapeCarved × coverage >
          // 0.0001`. With the Nubis Remap composition that product is nonzero
          // across the ENTIRE coverage footprint — including everywhere the
          // remapped density is exactly 0 (low dimProfile → only base-noise
          // peaks survive the threshold). Consequence: in low/mid-coverage
          // regions the march dense-locked the moment it entered the altitude
          // band and never left (hitThisStep fired every step, so the
          // empty-streak fallback couldn't trigger), crawling 50–300 km of
          // in-band path at fine dense steps until the 256-step budget died
          // mid-field. User-visible: a ring of volumetric near the camera +
          // volumetric at the horizon (grazing rays enter the slab at large t
          // where even dense steps are km-scale, so they survive) + a
          // 2D-overlay-only GAP in between, keyed to coverage.
          //
          // Gate instead on the SAME remapped shape the dense branch
          // integrates — `profile` here ≡ the dense branch's `dimProfile`,
          // so this is pure ALU on already-fetched values, no extra taps.
          // Zero-density voxels now stay in skip mode at full skip-step
          // reach; dense mode engages only inside real cloud bodies, where
          // alpha accumulation (or the streak fallback at carved valleys)
          // bounds the dense run. The tiny epsilon keeps the gate an
          // inclusion test, not a binary density cliff (the 2026-05-27
          // tile-speckle lesson — see git history for the full note).
          // Same coverage-envelope erosion as the dense branch (BASE_EROSION_K),
          // so the gate engages exactly where density can be > 0.
          const probeShape = profile.sub(
            float(1).sub(baseShapeCarved).mul(float(BASE_EROSION_K_EFF)),
          );
          maxProbeShape.assign(maxProbeShape.max(probeShape));
          maxBaseShape.assign(maxBaseShape.max(baseShapeCarved));
          If(probeShape.greaterThan(0.0001), () => {
            hitThisStep.assign(1);

            If(stepMode.lessThan(0.5), () => {
              // ── Skip → dense transition ──
              // Rewind half a long step. The next iteration's step-forward
              // will use dtDense, so we land at (current t - dtSkip/2 +
              // dtDense) = (current t - 2·dtDense + dtDense) = (current t -
              // dtDense). Net: dense mode resumes one short step before the
              // detection point, so the leading cloud edge is sampled at
              // short-step resolution. No accumulation in this iteration —
              // the cheap-probe sample is discarded; the next dense step
              // will redo the full computation.
              // (Rewind by the IN-BAND skip step — detection only ever
              // happens in the capped regime, so the rewind matches the
              // stride that found the cloud.)
              t.subAssign(dtSkipInBand.mul(0.5));
              stepMode.assign(1);
              emptyStreak.assign(0);
              // Capture cloud-front depth on first hit (sentinel was -1).
              // Drives TAA reprojection (true cloud-surface depth, not
              // outer-shell approximation) and the 'firstHit' debug viz.
              If(firstHitT.lessThan(0), () => {
                firstHitT.assign(t);
              });
            }).Else(() => {
              // ── Steady-state dense: full sample + accumulate ──
              emptyStreak.assign(0);
              denseIters.addAssign(1);

              // ── Nubis base-shape composition: REMAP, not multiply ──
              // THE key shape step (2026-05-30). `dimProfile = coverage ×
              // heightProfile` is the 3D "how much cloud should be here"
              // envelope (horizontal × vertical). Schneider/Nubis THRESHOLDS
              // the base noise by it:
              //   shape = Remap(baseShape, 1 - dimProfile, 1, 0, 1)
              //         = (baseShape - (1 - dimProfile)) / dimProfile, clamped
              // Why threshold, not multiply: multiply SCALES the noise
              // amplitude → the shape collapses to the (coverage × profile)
              // envelope extruded, so the 3D noise stops sculpting and bodies
              // read as the coverage mask extruded vertically (blobs / spikes /
              // walls). Remap THRESHOLDS: in cores (dimProfile high) the
              // threshold is low → noise mostly passes → solid; at tops
              // (heightProfile fades) and edges (coverage fades) the threshold
              // rises → only noise PEAKS survive → cauliflower tapering tops +
              // wispy edges. The organic form IS the 3D noise, carved by the
              // profile. (The skip/dense gate above — `probeShape` — is this
              // exact remap, so dense mode and nonzero density coincide.)
              const dimProfile = coverage.mul(heightProfile);
              // Coverage envelope eroded by the base noise (see BASE_EROSION_K):
              // shape = saturate(profile − (1 − base) × K). shape ≤ profile, so
              // no floaters; K<1 fills base gaps at high coverage → solid deck.
              const shape = dimProfile
                .sub(
                  float(1).sub(baseShapeCarved).mul(float(BASE_EROSION_K_EFF)),
                )
                .clamp(0, 1);

              // NOTE: the old opacity-only detail erosion (the original
              // Schneider remap: eroded = Remap(shape, detailFBM·strength,...))
              // was REMOVED 2026-06-18. It was superseded by the shared
              // FINE_CARVE (centered, frequency-graded, wisp + HHF) which is in
              // the LIT density and self-shadowed; the old pass re-applied
              // un-self-shadowed high-freq on top → disconnected edge speckle.
              // `shape` already carries all detail via baseShapeCarved.
              lastEroded.assign(shape);

              // Solidity gamma (Nubis low-density sharpen; see DENSITY_GAMMA):
              // raise mid densities so the carved body reads SOLID, not balls in
              // transparent. JS-const gated → off path is byte-identical.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const density: any = (
                // `as number` defeats TS's module-scope const narrowing (same
                // dodge as FROXEL_ENABLED in atmospherePass.ts).
                (DENSITY_GAMMA as number) === 1
                  ? shape
                  : pow(shape, float(DENSITY_GAMMA))
              ).mul(densScale);
              lastDensity.assign(density);

              // ── Terminator tuning (altitude-aware sun visibility +
              //    low-sun reddening). Build-time JS consts — tune freely. ──
              const surfaceRScaled = kmToScaledUnits(PLANET_RADIUS_KM); // ground radius = the solid-Earth sun occluder
              const TERMINATOR_SOFT = 0.08; // smoothstep half-width around μ_set (soft terminator band)
              const REDDEN_START_MU = 0.25; // sun-zenith cos where warming begins (~14° sun elevation)
              const REDDEN_POW = 1.5; // >1 keeps reddening subtle until the sun is genuinely low
              const ALPENGLOW_AMOUNT = 0.5; // how far the cool ambient warms toward rose at low sun

              // ── Per-sample terminator daylight (altitude-aware, 2026-06-22) ──
              // μ = cos(sun-zenith) at this sample = sin(sun elevation). The
              // sun stays geometrically visible at altitude until it drops
              // below the DEPRESSED horizon:
              //   μ_set = −√(1 − (R/r)²),  R = planet surface radius.
              // So cloud TOPS (larger r) stay lit after the ground — and after
              // lower cloud bases — go dark: the real "tops glow after sunset"
              // look. The old fixed smoothstep(−0.1, 0.1, μ) used the GROUND
              // horizon (μ=0) at every altitude, so clouds darkened ~5° BEFORE
              // the sun actually set. Pure ALU on p/r — no extra taps. MUST
              // stay per-sample (not slab-midpoint) or the limb gets a hard
              // line — see the ray-level `daylight` comment.
              const mu = dot(p, sunDirEarth).div(r);
              const muHorizon = float(1)
                .sub(float(surfaceRScaled * surfaceRScaled).div(r.mul(r)))
                .max(0)
                .sqrt()
                .negate();
              const daylightS = smoothstep(
                muHorizon.sub(float(TERMINATOR_SOFT)),
                muHorizon.add(float(TERMINATOR_SOFT)),
                mu,
              );
              // Reddening ramps up MONOTONICALLY as the sun lowers (the long
              // atmospheric slant path Rayleigh-strips blue → warm light) and
              // STAYS warm through the terminator — vs the old symmetric
              // 4·d·(1−d) that brightened then vanished again at night.
              const redden = smoothstep(
                float(REDDEN_START_MU),
                muHorizon,
                mu,
              ).pow(float(REDDEN_POW));
              // ── Sun / sky colour ──
              // Phase 3 (USE_ATMOSPHERE_CLOUD_LIGHTING): PHYSICAL coupling. The
              // per-sample sun colour is sunIlluminance × transmittance from the
              // shared LUT, sampled with THIS voxel's altitude r + sun-zenith μ
              // (the very params daylightS already uses). Identical LUT to the
              // sky + ship, so the cloud's sunset reddening / planet-shadow
              // darkening match the rest of the scene — and it stays per-sample,
              // honouring the slab-midpoint rule. Ambient = the atmosphere sky
              // tint; daylightS still gates night per-sample. CLOUD_SUN/SKY_SCALE
              // re-anchor magnitudes to the marcher's tuned brightness.
              // Off path: the original hand-tuned day→sunset ramp (byte-identical).
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              let sunColorS: any;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              let skyColorS: any;
              if (USE_ATMOSPHERE_CLOUD_LIGHTING && uTransmittanceLUT) {
                const sunUv = transmittanceLutUv(
                  r,
                  mu,
                  uAtmoBottomRadius,
                  uAtmoTopRadius,
                  uAtmoH,
                );
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const sunT: any = texture(uTransmittanceLUT, sunUv).level(int(0));
                sunColorS = uAtmoSunIlluminance
                  .mul(sunT.rgb)
                  .mul(float(CLOUD_SUN_SCALE));
                skyColorS = uAtmoSkyColor
                  .mul(daylightS)
                  .mul(float(CLOUD_SKY_SCALE));
              } else {
                // Sun tint: warm white (day) → Rayleigh-reddened orange (low
                // sun). Magnitude 12 HDR (tuned against 'lightingOnly').
                sunColorS = mix(
                  vec3(1.0, 0.96, 0.88),
                  vec3(1.0, 0.55, 0.25),
                  redden,
                ).mul(12.0);
                // Sky color: COOL BLUE ambient by day, warmed toward a dim rose
                // at low sun (alpenglow). Schneider split: L = sun×(direct+ms) +
                // sky×ambient. 2 HDR, blue-dominant so shadow sides read cool.
                skyColorS = mix(
                  vec3(0.3, 0.5, 1.0),
                  vec3(0.8, 0.5, 0.45),
                  redden.mul(float(ALPENGLOW_AMOUNT)),
                )
                  .mul(daylightS)
                  .mul(2.0);
              }

              // ── Sun transmittance: 3D light-volume lookup (toggle) OR the
              //    6-tap cone march (default). USE_LIGHT_VOLUME is a build-time
              //    JS const, so toggle=off emits the exact cone shader below. ──
              const Tsun = float(0).toVar();
              if (USE_LIGHT_VOLUME && uLightVol && uLightVolB && uLightVolMixA) {
                // ── Shell addressing (inverse of the bake's voxelToEarth) ──
                // Y is ALTITUDE: (r − rMid)/halfSpan — a globally fixed
                // lattice shared by both sides (shell-Y, 2026-06-12: replaced
                // box-linear Y, whose ~3 km voxels over a 97 km tilt-padded
                // box left the 13 km slab spanning only ~4 voxels — the
                // piecewise-trilinear vertical gradient read as hard "shadow
                // zone" bands at the same altitude on every cloud).
                // XZ: gnomonic column projection — scale p onto the side's
                // tangent plane (⊥ axisY through the window centre, which
                // sits at radius rMid along axisY, so dot(centre,axisY) =
                // rMid), then project onto the side's tangent axes.
                const rMidShell = uInnerRadius.add(uOuterRadius).mul(0.5);
                const altY = r
                  .sub(rMidShell)
                  .div(uLightVolHalfExtent.y)
                  .mul(0.5)
                  .add(0.5);
                // Per-side shadow factor: the volume sample faded to fully-
                // lit (1) over the outer LIGHT_VOL_EDGE_FRAC of the XZ window
                // so the window border is a soft gradient, not a hard
                // lighting line. Y does NOT participate in the edge fade —
                // the slab fills the altitude span by design and clamp-to-
                // edge there is benign. (dY ≤ 0 = far side of the planet →
                // uvw lands far outside [0,1] → edgeFade 0 → fully lit.
                // Latent trap: in a ~2e-5 rad cone around the exact ANTIPODE
                // the clamped projection folds back INSIDE the window at
                // full edge fade — unreachable today because the surface-
                // occlusion clamp bounds samples to ≲25° from camera-up, but
                // know it's here before marching far-side chords.)
                const sideShadow = (
                  vol: THREE.Texture,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  center: any,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  axX: any,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  axY: any,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  axZ: any,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ): any => {
                  const dY = dot(p, axY).max(0.0001);
                  const cp = p.mul(rMidShell.div(dY));
                  const dV = cp.sub(center);
                  const uvwS = vec3(
                    dot(dV, axX).div(uLightVolHalfExtent.x).mul(0.5).add(0.5),
                    altY,
                    dot(dV, axZ).div(uLightVolHalfExtent.z).mul(0.5).add(0.5),
                  );
                  const edgeDist = uvwS.x
                    .min(float(1).sub(uvwS.x))
                    .min(uvwS.z.min(float(1).sub(uvwS.z)));
                  const edgeFade = smoothstep(
                    float(0),
                    float(LIGHT_VOL_EDGE_FRAC),
                    edgeDist,
                  );
                  // One trilinear fetch replaces the whole 6-tap cone.
                  // .r = exp(-tau).
                  const Tv = (texture3D(vol, uvwS).level(int(0)) as Node).r;
                  return mix(float(1), Tv, edgeFade);
                };
                // ── Dual-volume crossfade (see cloudLightVolume.ts) ──
                // uLightVolMixA sits at exactly 0 or 1 outside transitions,
                // so the If-gates keep this at ONE fetch in steady state and
                // two only while a re-anchor/sun-step fade is in flight.
                const shadowA = float(1).toVar();
                const shadowB = float(1).toVar();
                If(uLightVolMixA.greaterThan(0.0001), () => {
                  shadowA.assign(
                    sideShadow(
                      uLightVol,
                      uLightVolCenter,
                      uLightVolAxisX,
                      uLightVolAxisY,
                      uLightVolAxisZ,
                    ),
                  );
                });
                If(uLightVolMixA.lessThan(0.9999), () => {
                  shadowB.assign(
                    sideShadow(
                      uLightVolB,
                      uLightVolCenterB,
                      uLightVolAxisXB,
                      uLightVolAxisYB,
                      uLightVolAxisZB,
                    ),
                  );
                });
                const TsunVol = mix(shadowB, shadowA, uLightVolMixA);
                // ── Local lump self-shadow (see LOCAL_SHADOW_* constants) ──
                // The volume's km-scale voxels can't resolve the ~1-3 km
                // carve lumps, so on its own it shades the deck like a soft
                // macro blanket (flat vs the cone it replaced). One short
                // probe toward the sun re-adds the high-freq crest/crevice
                // shading: sample the carved base shape 800 m sunward,
                // absorb by it.
                // ACTIVE AT ALL DISTANCES (2026-06-12). The probe used to
                // fade out over 5→40 km "because lump-scale shading is sub-
                // pixel beyond that" — but its MEAN is not 1: it darkens
                // everything it touches by the average lump absorption, so
                // the fade created a camera-locked brightness border at a
                // constant ~40 km ("clouds near me are darker, with a clear
                // boundary that flies along"). Distant lump VARIATION is
                // sub-pixel; the DC shift is not. This is also the Nubis³
                // split: near sun samples LIVE at every distance, the baked
                // volume only supplies the smooth far-field tail. Cost: 2
                // texture3D per day-side dense voxel. NOT cheap on horizon /
                // 150-400 km nadir views: most dense voxels there sit beyond
                // the old 40 km gate (far dense fetches go ~3-4 → ~5-6).
                // PROFILE at the ~240 km regime; if too hot, fade TsunLocal
                // toward its MEAN absorption with distance (keeps the DC,
                // drops the fetches) — never back toward 1.
                const TsunLocal = float(1).toVar();
                // NOTE (2026-06-16): the local probe is NO LONGER gated by
                // uVolumeWeight — it stays live at EVERY altitude the
                // volumetric pass renders (up to ~3000 km, where
                // uVolumetricBlend fades the whole pass). uVolumeWeight faded
                // to 0 by just 400 km, but volumetric clouds keep rendering to
                // 3000 km → a 400–3000 km band of flat-white, unshaded cloud.
                // See the Tsun composition below.
                If(
                  daylightS.greaterThan(0.001),
                  () => {
                    const pLs = p.add(
                      sunDirEarth.mul(float(LOCAL_SHADOW_DIST)),
                    );
                    const rLs = length(pLs).max(0.0001);
                    const altLs = clamp(
                      sub(rLs, uInnerRadius).mul(invSlabThickness),
                      0,
                      1,
                    );
                    // ── Carved base shape at the 800 m self-shadow probe ──
                    // Must use the SAME anti-tiling as the primary or the near
                    // self-shadow won't register with the rendered cloud.
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    let carvedLs: any;
                    if (USE_DETILE) {
                      carvedLs = detileBlend(pLs, carvedShapeAt);
                    } else {
                      const pLsWarped = pLs.add(warpVec);
                      const baseLs = texture3D(
                        baseVolume,
                        pLsWarped.mul(uBaseScale),
                      ).level(int(0)) as Node;
                      const fbmLs = baseLs.g
                        .mul(0.625)
                        .add(baseLs.b.mul(0.25))
                        .add(baseLs.a.mul(0.125));
                      const dilatedLs = baseDilate(baseLs.r, fbmLs);
                      const carveLsSrc = texture3D(
                        detailVolume,
                        pLsWarped.mul(float(CARVE_SCALE)),
                      ).level(int(0)) as Node;
                      carvedLs = billowCarveKernel(dilatedLs, carveLsSrc);
                    }
                    const profileLs = cloudHeightProfile(
                      altLs,
                      topAlt,
                      cloudType,
                    );
                    // MEASUREMENT: the LIT macro shape the 800 m probe absorbs
                    // by (DEBUG_VIZ 'litShape'). Compare to 'eroded'. (The
                    // DETAIL_IN_LIGHTING experiment — detail at 800 m — was
                    // removed 2026-06-18: 800 m decorrelates the detail, so it
                    // produced no relief; the near probe below carries detail.)
                    lastLitShape.assign(carvedLs);
                    // ── Macro self-shadow (existing 800 m probe) ──
                    const odMacro = carvedLs
                      .mul(coverage)
                      .mul(profileLs)
                      .mul(float(LOCAL_SHADOW_DENSITY))
                      .mul(float(LOCAL_SHADOW_DIST));
                    // ── Near detail self-shadow (the cauliflower fix) ──
                    // A short tap at the DETAIL scale, layered onto the macro
                    // probe. Macro presence reused from the surface
                    // (baseShapeCarved ~ constant over the short tap); only the
                    // DETAIL volume is sampled (+1 texture3D).
                    const odNear = float(0).toVar();
                    if (DETAIL_SELFSHADOW && FINE_CARVE) {
                      const pNear = p.add(
                        sunDirEarth.mul(float(DETAIL_SS_DIST)),
                      );
                      // Sample the SAME fine-carve Worley the opacity carves
                      // with (FINE_CARVE_SCALE), at pNear along the sun ray, and
                      // carve the macro shape (carvedLs, macro-only) by it → the
                      // fine-carved DENSITY toward the sun. Because the opacity
                      // bumps and this shadow come from the same field, the
                      // shadow lands on the real crevices (dark) and spares the
                      // crests (bright) — correlated relief, not painted noise.
                      // DETAIL_SS_MIP box-filters the fine Worley for smooth
                      // lobes. +1 texture3D.
                      // Sample the box-downsampled level-1 (separate 32³ tex)
                      // at LOD 0 — the GPU storage texture is single-mip, so the
                      // old .level(DETAIL_SS_MIP) is realised as a dedicated tex.
                      const fineSrc = texture3D(
                        detailVolumeMip1,
                        pNear.add(warpVec).mul(float(FINE_CARVE_SCALE)),
                      ).level(int(0)) as Node;
                      // Match the opacity's CENTERED, FREQUENCY-GRADED fine
                      // octave via the SHARED fineCarveDelta (case #21: same
                      // octave the view ray carves → correlated self-shadow).
                      // No detailFade — the shadow is never distance-faded.
                      const fineDelta = fineCarveDelta(
                        fineSrc,
                        profileLs,
                        t,
                        float(1),
                      );
                      const fineCarvedNear = carvedLs
                        .add(fineDelta)
                        .clamp(0, 1);
                      odNear.assign(
                        fineCarvedNear
                          .mul(coverage)
                          .mul(profileLs)
                          .mul(float(DETAIL_SS_DENSITY))
                          .mul(float(DETAIL_SS_DIST)),
                      );
                    }
                    // MEASUREMENT: the near self-shadow term in isolation
                    // (DEBUG_VIZ 'detailShadow'): white = clear, dark = the
                    // detail occluded the sun. Lobed light/dark = cauliflower.
                    lastDetailSS.assign(exp(odNear.negate()));
                    TsunLocal.assign(exp(odMacro.add(odNear).negate()));
                  },
                );
                // Orbit fade applies ONLY to the BAKED far-field volume
                // (TsunVol): its window goes stale / stops covering the visible
                // deck as the camera climbs, so it hands off over 150→400 km.
                // The LOCAL 800 m probe stays live at every altitude the
                // volumetric pass renders — it is always geometrically valid
                // and carries the crisp crest/crevice self-shadow. Previously
                // uVolumeWeight faded BOTH terms out by 400 km, leaving a
                // 400–3000 km band of unshaded (flat-white) volumetric cloud —
                // the dominant cause of the "smooth white balls" look. This is
                // the Nubis³ split: near sun samples live always, the baked
                // volume supplies only the smooth far-field tail.
                Tsun.assign(
                  TsunLocal.mul(mix(float(1), TsunVol, uVolumeWeight)).mul(
                    daylightS,
                  ),
                );
                lastTsun.assign(Tsun);
              } else {
              If(daylightS.greaterThan(0.001), () => {
                const opticalDepthSun = float(0).toVar();
                 
                const sampleConeTap = (
                  kx: number,
                  ky: number,
                  kz: number,
                  i: number,
                ) => {
                  const stepDist = float(LIGHT_STEP_SCALED).mul(
                    float(i).add(0.5),
                  );
                  const conePerturb = vec3(kx, ky, kz)
                    .mul(stepDist)
                    .mul(uLightConeRadius);
                  const pL = p.add(sunDirEarth.mul(stepDist)).add(conePerturb);
                  const rL = length(pL);
                  const altL = clamp(
                    sub(rL, uInnerRadius).mul(invSlabThickness),
                    0,
                    1,
                  );
                  // ── Per-cone-tap density sampling (Schneider-canonical) ──
                  // Sample the 3D BASE VOLUME at each cone tap. The actual
                  // cloud density variation along the sun path lives in
                  // the 3D Perlin-Worley base volume (~km features), not
                  // the macro-scale 2D weather map.
                  //
                  // Without sampling baseShape per cone tap, the cone-march
                  // sees "this lat/lon column has cloud (yes/no)" but not
                  // "how thick the cloud is along this 12 km sun path" →
                  // Tsun_ms ≈ 1 across the cloud → flat lighting.
                  //
                  // Coverage is taken from the PRIMARY RAY (not per-tap).
                  // Per-tap coverage was tried for grazing-sun cases but
                  // it varies negligibly over a 12 km cone vs Earth's
                  // 6371 km radius (~0.0003 rad UV shift) — visual impact
                  // was zero, fetch cost was 6× texture2D per dense voxel.
                  // Dropped for perf.
                  //
                  // Cost: 3 texture3D fetches per dense voxel (3 cone taps).
                  // ── Step 2: cone sees the dilated (optionally carved) shape ──
                  // Reconstruct the primary's dilated base shape at each cone tap
                  // so lumps self-shadow: a voxel beneath a lump finds more cloud
                  // toward the sun than one on a sunlit crest → bright crests /
                  // dark crevices. The optional billow-carve (CONE_SAMPLE_CARVE)
                  // adds the ~km valley detail at a 2nd texture3D/tap; default off
                  // for perf (see the constant's note).
                  //
                  // TODO(detile): this cone path is DEAD while USE_LIGHT_VOLUME
                  // is true (the baked volume + 800 m probe replace it). It is
                  // NOT tile-&-offset detiled — if USE_LIGHT_VOLUME is ever set
                  // false, wrap this in detileBlend(pL, dilatedShapeAt) (and
                  // carvedShapeAt under CONE_SAMPLE_CARVE) so its self-shadow
                  // matches the detiled render. See cloudDetile.ts.
                  const baseSampleL = texture3D(
                    baseVolume,
                    pL.mul(uBaseScale),
                  ).level(int(0)) as Node;
                  const baseFbmL = baseSampleL.g
                    .mul(0.625)
                    .add(baseSampleL.b.mul(0.25))
                    .add(baseSampleL.a.mul(0.125));
                  const baseShapeDilatedL = baseSampleL.r
                    .add(float(1).sub(baseFbmL))
                    .div(float(2).sub(baseFbmL).max(0.0001))
                    .clamp(0, 1);
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  let baseShapeL: any = baseShapeDilatedL;
                  if (CONE_SAMPLE_CARVE) {
                    const carveSrcL = texture3D(
                      detailVolume,
                      pL.mul(float(CARVE_SCALE)),
                    ).level(int(0)) as Node;
                    baseShapeL = billowCarveKernel(baseShapeDilatedL, carveSrcL);
                  }
                  const coverageL = coverage;  // primary-ray's coverage

                  // Cone density is DECOUPLED from primary `densScale`
                  // (uDensityMul). Primary density wants to be high
                  // (~140000) for opaque cumulus body alpha integration.
                  // But scaling cone density with uDensityMul made
                  // cone-march absorption blow up: at 140000, every voxel
                  // had opticalDepthSun ≈ 75 → Tsun_ms ≈ 0 → ms term
                  // pegged at zero → lighting collapsed to HG-phase-
                  // dominated, which is bright when looking toward sun
                  // and dim when looking away. Wrong.
                  //
                  // CONE_DENSITY = 3000 hardcoded keeps cone absorption
                  // in a useful range regardless of primary densMul:
                  //   typical cumulus voxel: opticalDepthSun ≈ 5.4 →
                  //     Tsun_ms (MS_COEF=0.3) ≈ 0.20
                  //   cumulus top voxel (cone exits quickly):
                  //     opticalDepthSun ≈ 1.8 → Tsun_ms ≈ 0.57
                  //   cumulus bottom voxel (cone through full column):
                  //     opticalDepthSun ≈ 9 → Tsun_ms ≈ 0.10
                  //
                  // Range Tsun_ms 0.10–0.57 → ms varies 5.7× across
                  // cloud → visible top-bright/bottom-dark gradient.
                  const profileL = cloudHeightProfile(altL, topAlt, cloudType);
                  // Lowered 3000 → 1000: once the cone sees the dilated+carved
                  // shape (Step 2), 3000 pushed cone optical depth into the
                  // ~3-6 range → Tsun = exp(-OD) ≈ 0 everywhere → the lit terms
                  // collapsed and the self-shadow variation (clear in
                  // DEBUG_VIZ='coneDepth') never reached the colour (flat
                  // lightingOnly). 1000 brings OD into ~0.5-2 (Tsun 0.6-0.14)
                  // where the self-shadow shows as real brightness variation.
                  // Tune against 'off'/'lightingOnly': too dark/flat → lower
                  // more; washed-out bright → raise.
                  //
                  // 1000 (ceiling-test): with the deepened ambient floor
                  // (skylight 0.07) and dual-lobe direct term, 500 left the
                  // self-shadow contrast soft. Doubling cone absorption pushes
                  // OD into ~1-4 (Tsun ~0.37-0.018) so occluded crevices/
                  // undersides go genuinely dark — amplifies the existing
                  // self-shadow variation exponentially (exp(-OD)). Watch for
                  // the documented failure mode: if too much of the deck goes
                  // uniformly dark (cone always through neighbours), back off —
                  // that means the SHAPE is too uniform to self-shadow and the
                  // next lever is shape detail, not more cone density.
                  const CONE_DENSITY = float(1000);
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const densL: any = baseShapeL
                    .mul(coverageL)
                    .mul(profileL)
                    .mul(CONE_DENSITY);
                  // Phase D8 lift: 6 cone taps (was 3 with 2× compensation
                  // during Phase B's perf-reduction). With Phase D's 1/16
                  // reconstruction savings we now have the budget to march
                  // all 6 taps per fresh pixel. Each tap contributes 1×
                  // (no compensation multiplier).
                  //
                  // Why 6 taps reduces noise: each pixel's cone-marched
                  // Tsun is the average of N taps' transmittance integrals.
                  // Var(mean) = σ² / N. Going from 3 → 6 taps gives √2 ≈ 1.4×
                  // less per-pixel transmittance variance, → smoother
                  // Tsun_ms → less lighting noise across adjacent pixels.
                  // Compounds well with the 1/16 temporal accumulation:
                  // each pixel ends up averaging 6 lighting integrals per
                  // cycle, then accumulating across cycles.
                  opticalDepthSun.addAssign(
                    densL.mul(float(LIGHT_STEP_SCALED)),
                  );
                };
                // Full 6-point low-discrepancy kernel stratified across
                // the unit sphere. Directions 0/2/4 were the ones kept
                // during Phase B's 3-tap reduction; 1/3/5 are the
                // complementary set generated to fill the gaps (octants
                // that 0/2/4 didn't cover).
                sampleConeTap(0.38051305, 0.92453449, -0.02111345, 0);
                sampleConeTap(-0.92453449, 0.38051305, -0.02111345, 1);
                sampleConeTap(-0.32509218, -0.94575601, -0.01428496, 2);
                sampleConeTap(0.94575601, -0.32509218, 0.01428496, 3);
                sampleConeTap(0.28128598, 0.42443639, -0.86065785, 4);
                sampleConeTap(-0.42443639, 0.28128598, 0.86065785, 5);
                Tsun.assign(exp(opticalDepthSun.negate()).mul(daylightS));
                lastTsun.assign(Tsun);
                lastOpticalDepthSun.assign(opticalDepthSun);
                If(firstOpticalDepthSun.lessThan(0), () => {
                  firstOpticalDepthSun.assign(opticalDepthSun);
                });
              });
              }

              // Multi-scatter transmittance.
              // pow(Tsun, MS_COEF) ≡ exp(-MS_COEF × opticalDepthSun) on the
              // day side. MS_COEF controls how fast multi-scatter
              // illumination falls off as cone-marched sun absorption rises:
              //   MS_COEF = 0.15 (Wrenninge default): very gentle. At full
              //     absorption, Tsun_ms ≈ 0.35 — still bright. Shadow
              //     sides too bright.
              //   MS_COEF = 0.5: Tsun_ms = √Tsun — sqrt LIFTS the shadow
              //     end (0.14 → 0.37) so the self-shadow contrast in the
              //     dominant `ms` term gets compressed → bodies read as one
              //     flat colour even though Tsun varies. This was a primary
              //     cause of the "same colour all over" look.
              //   MS_COEF = 0.75 (current): Tsun_ms = Tsun^0.75 — keeps far
              //     more of the RAW cone-march self-shadow (shadow end
              //     0.14 → 0.23 vs 0.37) and pushes shadowed undersides
              //     genuinely darker → dramatic top-bright / underside-dark
              //     per-body shading like the Star Citizen / KSP-EVE refs.
              //     Pairs with the dual-lobe phase (direct term): `ms` does
              //     the within-body contrast, `direct` adds the silver rim.
              //     Higher (→1.0) deepens shadows further but dims overall;
              //     lower brightens but flattens. Dial against 'lightingOnly'.
              //   0.9 (current): in the FINAL 'off' image the white cloud
              //     albedo + ms fill were lifting shadowed valleys to mid-grey
              //     (form present but soft). 0.9 drops the fill in shadow
              //     (Tsun^0.9) so valleys read darker → more dramatic body
              //     shading, while sunlit crowns (Tsun≈1) stay bright/white.
              const MS_COEF = float(0.9);
              const Tsun_ms = pow(Tsun.max(0.0001), MS_COEF).mul(daylightS);
              lastTsunMs.assign(Tsun_ms);

              // Optical depth integrates over dtDense — accumulation only
              // happens in dense mode, and dense steps are dtDense apart.
              const opticalDepthStep = density.mul(dtDenseEff);

              // Powder approximation — back-lit edges read brighter.
              // Applied to direct light only (pre-phase), per Schneider.
              const POWDER_K = float(2);
              const powderTerm = float(1).sub(
                exp(opticalDepthStep.mul(POWDER_K.negate())),
              );
              const powderFactor = powderFrontInv
                .mul(powderTerm)
                .add(powderFrontMix);

              // ── Profile-driven lighting model (Nubis B5) ──
              // Three terms, each gated by a probability field derived from
              // the dimensional profile (= coverage × heightProfile):
              //   direct  — sun reaching this voxel directly (Beer-Lambert
              //             through cone-marched sun density), modulated by
              //             the dual-lobe HG phase and powder. Not profile-
              //             gated: direct light reaches every voxel the cone-
              //             march sees. The dual-lobe phase peaks ~1.8 toward
              //             the sun (silver lining / rim) and falls to ~0.04
              //             on the sides — so `direct` carries BOTH the silver
              //             lining and, via raw Tsun, the directional self-
              //             shadow. (Single g=0.1 gave a flat ~0.08 peak →
              //             no rim, no directional shading.)
              //   ms      — sun light arriving after multiple scatters.
              //             Profile-gated → fills cloud CORES (high
              //             profile), not edges. No phase function
              //             multiplier (per plan B5).
              //             History: tried `ms = eroded × Tsun_ms` to
              //             surface per-voxel detail variation. Eroded
              //             peaks higher than profile (Schneider remap
              //             normalises (shape-thr)/(1-thr) which biases
              //             toward 1 in cores), pushing ms HDR into the
              //             AgX saturation regime where variation is
              //             squashed to white. Reverted; pursuing visible
              //             body detail via reduced sunColor magnitude
              //             instead (see sunColor comment).
              //   ambient — sky light reaching this voxel. Gated by
              //             (1 - profile)^0.5 → bright at edges, dark in
              //             cores. Outward probability gradient.
              const direct = phase.mul(Tsun).mul(powderFactor);
              // ── Multiple-scatter body brightness (ISSUE 2, "pull volumetric
              // toward the overlay") ──
              // MEASURED 2026-07-03: from orbit `alpha` reads white (clouds are
              // opaque) but `lightingOnly` reads ~2.5× darker than the flat NASA
              // overlay — the volumetric body is UNDER-LIT, not translucent. The
              // lit body is dominated by `ms` (the `direct` term is crushed to
              // ~0.04 by the HG phase except toward the sun), and `ms = profile ×
              // Tsun_ms` peaks well below the overlay's albedo×sunlight. Real
              // thick clouds are bright precisely BECAUSE of heavy multiple
              // scattering, so lifting this is physically-honest, not a fudge.
              // MS_GAIN scales the diffuse term to bring sunlit tops up to the
              // overlay peak; the `direct` silver-lining term is left untouched
              // so looking toward the sun doesn't blow out, and shadowed cores
              // keep low Tsun_ms → they stay relatively dark (crevice contrast
              // preserved for the near view). Tune against DEBUG_VIZ
              // 'lightingOnly' vs the overlay: raise if still grey from orbit,
              // lower if cores/near clouds wash out. (If brightening the far
              // view over-brightens the NEAR clouds, the next step is to
              // distance-gate this gain like DETAIL_FADE.)
              const MS_GAIN = float(5);
              const ms = profile.mul(Tsun_ms).mul(MS_GAIN);
              const ambient = profile.oneMinus().pow(float(0.5)).mul(skylight);

              const scatterFrac = float(1).sub(exp(opticalDepthStep.negate()));
              // Schneider canonical: sun-side contributions (direct + ms)
              // use sunColor (warm); ambient uses skyColor (cool blue) to
              // give cumulus undersides their characteristic blue-gray
              // tint instead of warm-cream. Mixed before scatterFrac so
              // each step's accumulated radiance has both color sources
              // correctly weighted.
              const L = sunColorS
                .mul(direct.add(ms))
                .add(skyColorS.mul(ambient))
                .mul(scatterFrac);
              col.addAssign(L.mul(T));

              // Opacity-weighted depth (see weightedDepthSum decl): this step's
              // weight = its camera-reaching opacity = scatterFrac · T(pre-step).
              const depthWeight = scatterFrac.mul(T);
              weightedDepthSum.addAssign(t.mul(depthWeight));
              depthWeightSum.addAssign(depthWeight);

              T.mulAssign(exp(opticalDepthStep.negate()));
            });
          });
        });

        // Empty-streak handling: if this step found no cloud and we're in
        // dense mode, count it. After EMPTY_THRESHOLD empties, drop back to
        // skip mode. Skip mode never increments the streak (no need —
        // already at the cheap rate).
        If(hitThisStep.lessThan(0.5), () => {
          If(stepMode.greaterThan(0.5), () => {
            emptyStreak.addAssign(1);
            If(emptyStreak.greaterThan(float(EMPTY_THRESHOLD)), () => {
              stepMode.assign(0);
              emptyStreak.assign(0);
            });
          });
        });

        // Step forward at the (possibly just-updated) mode's rate.
         
        // Skip advance is COVERAGE-ADAPTIVE (the detection-cap design, see
        // SKIP_DETECT_CAP_SCALED): inside the potential-cloud band
        // (profile > 0.01 at this sample) advance at the capped detection
        // stride; through empty space (no coverage / outside the altitude
        // envelope) advance at the full grown stride for horizon reach.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dtSkipEff: any = profile
          .greaterThan(0.01)
          .select(dtSkipInBand, dtSkipGrown);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dtThis: any = stepMode.lessThan(0.5).select(dtSkipEff, dtDenseEff);
        t.addAssign(dtThis);

        If(T.lessThan(0.01), () => {
          exitReason.assign(2);
          Break();
        });
      });
    });

    const alpha = clamp(sub(1, T), 0, 1);

    // ── Diagnostic visualisations (DEBUG_VIZ != 'off') ──
    // Each branch returns a forced-α=1 vec4 so the cloud RT REPLACES the
    // underlying scene at every shell-fragment pixel — diagnostic is
    // unambiguous, bypasses the volumetric-blend crossfade.
    if (DEBUG_VIZ === "alpha") {
      return { rgba: vec4(alpha, alpha, alpha, float(1)), tFront: float(0) };
    }
    if (DEBUG_VIZ === "maxProfile") {
      // Max coverage×heightProfile sampled along the ray (see the toVar's
      // comment block). BLACK where clouds are missing ⇒ stepping/geometry
      // never sampled the band; GRAY/WHITE ⇒ band sampled, look at
      // 'maxProbeShape' next.
      const m = maxProfile.clamp(0, 1);
      return { rgba: vec4(m, m, m, float(1)), tFront: float(0) };
    }
    if (DEBUG_VIZ === "maxProbeShape") {
      // Max remapped probe shape along the ray. With 'maxProfile' gray but
      // THIS black, the field passes nothing through the Remap threshold
      // there — density-model problem, not sampling.
      const m = maxProbeShape.clamp(0, 1);
      return { rgba: vec4(m, m, m, float(1)), tFront: float(0) };
    }
    if (DEBUG_VIZ === "baseShape") {
      // DEBUG (2026-06-16, floater hunt): max RAW dilated+carved base shape
      // along the ray, BEFORE the value-erosion Remap and coverage. Grayscale.
      // The dilation floors at ~0.5 wherever the FBM bands are low, so the deck
      // reads mid-gray; ISOLATED NEAR-WHITE spots = base-noise PEAKS (bs.r puff
      // cores, baseShapeCarved→1). If the floaters are bright isolated spots
      // here, they are base-noise peaks (the stash/detile test predicts this).
      const m = maxBaseShape.clamp(0, 1);
      return { rgba: vec4(m, m, m, float(1)), tFront: float(0) };
    }
    if (DEBUG_VIZ === "floaterProbe") {
      // DEBUG (2026-06-16, floater hunt): THE decisive image. Per pixel,
      //   R = maxProbeShape (what actually SURVIVES the value-erosion Remap)
      //   G = maxProfile    (coverage × heightProfile AVAILABLE there)
      // Read-out:
      //   RED floater (R high, G low)  = density survives where there is almost
      //     no coverage×height ⇒ an ISOLATED BASE-NOISE PEAK with no deck to
      //     belong to. This is the floater hypothesis — if floaters are red,
      //     it's CONFIRMED, and the fix belongs in the base shape, not coverage.
      //   YELLOW (R high, G high)      = legitimate cloud (deck) — both present.
      //   GREEN (R low, G high)        = profile present but nothing survives
      //     (a clear gap between bodies).
      //   BLACK                        = nothing in the band.
      const r = maxProbeShape.clamp(0, 1);
      const g = maxProfile.clamp(0, 1);
      return { rgba: vec4(r, g, float(0), float(1)), tFront: float(0) };
    }
    if (DEBUG_VIZ === "baseColumn") {
      // DEBUG (2026-06-16, floater ROOT-CAUSE probe): the dilated+contrast base
      // shape sampled at THREE altitudes in the FIRST-HIT column →
      //   R = low (alt 0.20), G = mid (alt 0.50), B = high (alt 0.85).
      // This makes VERTICAL COHERENCE of the base field directly visible:
      //   white            = base present at all heights → a CONNECTED column
      //   red / red+green  = base only low/mid → normal grounded deck
      //   MAGENTA (R+B, no G) = a vertical GAP in the middle → stacked bodies
      //   BLUE (B, ~no R)  = a HIGH core with NO base below it = a FLOATER
      // i.e. blue/magenta pixels ARE the floaters' signature (a core detached
      // from the deck by a gap in the 3D noise — the root cause). The fix
      // (vertical coherence) should collapse blue/magenta toward white/red.
      // Built from the FIRST-HIT position's column (the lat/lon of whatever
      // cloud the pixel actually sees), NOT the ray direction — so it works
      // from ANY viewpoint, including inside the slab. (The old dirMid version
      // degenerated to flat iridescent planes for near-horizontal rays.)
      const pHit = roEarth.add(rdEarth.mul(firstHitT.max(0.0)));
      const dirHit = pHit.div(length(pHit).max(0.0001));
      const baseAtAlt = (a01: number) => {
        const pos = dirHit.mul(mix(uInnerRadius, uOuterRadius, float(a01)));
        const bs = texture3D(baseVolume, pos.mul(uBaseScale)).level(
          int(0),
        ) as Node;
        const f = bs.g.mul(0.625).add(bs.b.mul(0.25)).add(bs.a.mul(0.125));
        return baseDilate(bs.r, f);
      };
      // No hit along this ray → black (empty sky, not a cloud).
      const colBC = vec3(baseAtAlt(0.2), baseAtAlt(0.5), baseAtAlt(0.85));
      return {
        rgba: vec4(
          firstHitT.greaterThan(0.0).select(colBC, vec3(0, 0, 0)),
          float(1),
        ),
        tFront: float(0),
      };
    }
    if (DEBUG_VIZ === "profile") {
      // Profile shape at three altitudes (R = 0.25, G = 0.50, B = 0.75),
      // sampled with the per-fragment slab-midpoint topAlt and the
      // coverage-derived cloudType at the midpoint UV. Lets us see
      // type-driven anatomy: stratus regions read green-only (mass at 0.5);
      // stratocumulus shows red+green; cumulus shows green+blue.
      const cloudTypeMid = WEATHER_V2
        ? cloudTypeMidV2
        : smoothstep(float(0.3), float(0.6), covMid);
      const p25 = cloudHeightProfile(float(0.25), topAltMid, cloudTypeMid);
      const p50 = cloudHeightProfile(float(0.50), topAltMid, cloudTypeMid);
      const p75 = cloudHeightProfile(float(0.75), topAltMid, cloudTypeMid);
      return { rgba: vec4(p25, p50, p75, float(1)), tFront: float(0) };
    }
    if (DEBUG_VIZ === "topAlt") {
      // Map [0.4, 0.95] → [0, 1] for grayscale display.
      const topAltNorm = topAltMid
        .sub(float(0.4))
        .div(float(0.55))
        .clamp(0, 1);
      return {
        rgba: vec4(topAltNorm, topAltNorm, topAltNorm, float(1)),
        tFront: float(0),
      };
    }
    if (DEBUG_VIZ === "insideInner") {
      const r = insideInner.select(float(1), float(0));
      const g = insideInner.select(float(0), float(1));
      return { rgba: vec4(r, g, float(0), float(1)), tFront: float(0) };
    }
    if (DEBUG_VIZ === "iters") {
      const primaryNorm = primaryIters
        .div(float(MAX_PRIMARY_STEPS))
        .clamp(0, 1);
      const denseNorm = denseIters
        .div(float(MAX_PRIMARY_STEPS))
        .clamp(0, 1);
      return {
        rgba: vec4(primaryNorm, denseNorm, float(0), float(1)),
        tFront: float(0),
      };
    }
    if (DEBUG_VIZ === "slabLen") {
      // Normalise against the nominal vertical slab length (13 km in
      // scaled units = 0.013). Grazing-angle slabs go well above 1.0.
      const slabNorm = slabLen.div(float(0.013)).clamp(0, 1);
      return {
        rgba: vec4(slabNorm, slabNorm, slabNorm, float(1)),
        tFront: float(0),
      };
    }
    if (DEBUG_VIZ === "lod") {
      // Distance-adaptive step-size ramp (Step 1). Shows lodScale at the slab
      // midpoint = how many × bigger each step is vs the 500 m base. Grayscale:
      // black ≈ 1× (fine, near) → white = 20× (coarse, far). RED tint where the
      // per-ray cap (lodCap) is limiting the growth — i.e. a thin slab forcing
      // finer steps so it isn't over-stepped (near-vertical / orbit down-views).
      // Lets us see the LOD field AND where the cap bites.
      const lodGrow = float(1).add(tMid.mul(float(LOD_STEP_GROWTH)));
      const lodMid = lodGrow.min(lodCap);
      const g = lodMid.div(float(20)).clamp(0, 1);
      const capped = lodGrow.greaterThan(lodCap).select(float(1), float(0));
      return {
        rgba: vec4(g.max(capped), g, g, float(1)),
        tFront: float(0),
      };
    }
    if (DEBUG_VIZ === "whyStop") {
      // Why each ray's march ended. RED = ran out of the 96-step budget
      // (cutoff — what we're chasing); GREEN = exited the slab (saw the whole
      // path); BLUE = went opaque (blocked by cloud, physically correct).
      const isBudget = exitReason.lessThan(0.5).select(float(1), float(0));
      const isSlab = exitReason
        .greaterThan(0.5)
        .and(exitReason.lessThan(1.5))
        .select(float(1), float(0));
      const isOpaque = exitReason.greaterThan(1.5).select(float(1), float(0));
      return {
        rgba: vec4(isBudget, isSlab, isOpaque, float(1)),
        tFront: float(0),
      };
    }
    if (DEBUG_VIZ === "firstHit") {
      // Sentinel -1 (no hit) → black. Otherwise normalise (firstHitT -
      // tEnter) by slabLen so depth maps to [0, 1]: 0 = entered slab and
      // hit immediately at the front face, 1 = hit at the back face.
      // False-coloured: blue→cyan→green→yellow→red as depth increases,
      // so adjacent pixels with different cloud-front depths show
      // visibly different colours. Uniform colour across the cloud disk
      // = depth is locked (shell-painting bug); colour gradient =
      // per-pixel parallax working.
      const hit = firstHitT.greaterThan(0);
      const depth01 = firstHitT.sub(tEnter).div(slabLen.max(0.0001)).clamp(0, 1);
      // Simple jet-like ramp via four piecewise channels.
      const r = smoothstep(float(0.5), float(0.9), depth01);
      const g = float(1).sub(
        smoothstep(float(0.7), float(1.0), depth01).mul(1),
      ).mul(smoothstep(float(0.2), float(0.5), depth01));
      const b = float(1).sub(smoothstep(float(0.3), float(0.6), depth01));
      return {
        rgba: vec4(
          hit.select(r, float(0)),
          hit.select(g, float(0)),
          hit.select(b, float(0)),
          float(1),
        ),
        tFront: float(0),
      };
    }

    // ── lightingOnly: cloud colour without alpha modulation ──
    // Reveals what the cloud LOOKS like (sun lighting, phase, MS, sky
    // contribution) independent of how transparent the alpha is.
    // - Stripes here but NOT in 'alpha' → stripes are in the colour /
    //   lighting computation (cone light march, phase, etc.).
    // - Stripes in 'alpha' too → alpha integration has them.
    // - Smooth here but stripes in 'off' → composition with the underlying
    //   scene is what makes them visible (e.g. partial alpha showing
    //   flat-overlay artifacts through).
    if (DEBUG_VIZ === "lightingOnly") {
      // Unpremultiply colour by alpha, then LINEAR-SCALE to a 0-5 HDR
      // window. Reinhard tone map (`x/(x+1)`) used to live here, but
      // its compression curve at 5-10 HDR (output 0.83-0.91) made
      // 2× brightness variations indistinguishable to the eye. Linear
      // scaling keeps variation visible in the 0-5 range; above 5 HDR
      // clamps to white.
      const unpremul = col.div(alpha.max(0.001));
      const exposed = unpremul.div(float(5)).clamp(0, 1);
      const hit = alpha.greaterThan(0.001);
      return {
        rgba: vec4(
          hit.select(exposed.x, float(0)),
          hit.select(exposed.y, float(0)),
          hit.select(exposed.z, float(0)),
          float(1),
        ),
        tFront: float(0),
      };
    }

    if (DEBUG_VIZ === "lightVol") {
      // Greyscale baked sun-transmittance at the visible-surface voxel (the
      // 3D light-volume lookup result). White = clear sun path (Tsun≈1), black
      // = occluded. With USE_LIGHT_VOLUME on, the spatial pattern should match
      // DEBUG_VIZ='tsunMs' captured on the cone path (toggle off). Flat grey
      // everywhere ⇒ volume not written (compute didn't run / box wrong).
      const hitV = alpha.greaterThan(0.001);
      return {
        rgba: vec4(
          hitV.select(lastTsun, float(0)),
          hitV.select(lastTsun, float(0)),
          hitV.select(lastTsun, float(0)),
          float(1),
        ),
        tFront: float(0),
      };
    }

    if (DEBUG_VIZ === "tsunMs") {
      // Last-dense Tsun_ms (cone-marched multi-scatter transmittance),
      // grayscale. Pixels where the marcher never entered dense mode
      // show black (lastTsunMs starts at 0). Pixels that hit cloud
      // show a grayscale level reflecting the cone-march output for
      // the most recent dense voxel along the ray (≈ visible surface).
      // Uniform across the cloud disk ⇒ cone-march not producing spatial
      // variation. Varying ⇒ cone-march works, downstream lighting math
      // is muting it.
      const hitT = alpha.greaterThan(0.001);
      return {
        rgba: vec4(
          hitT.select(lastTsunMs, float(0)),
          hitT.select(lastTsunMs, float(0)),
          hitT.select(lastTsunMs, float(0)),
          float(1),
        ),
        tFront: float(0),
      };
    }

    if (DEBUG_VIZ === "coneDepth") {
      // Last-dense raw opticalDepthSun (cone-march absorption), scaled /10
      // for display. Bypasses the pow-tonemap that makes tsunMs look
      // uniform at high transmittance. Black = no sun absorption (cone
      // exits cloud immediately); white = heavy absorption. If THIS is
      // uniform across the cloud disk, the cone-march genuinely isn't
      // varying — would indicate a deeper bug (texture3D, sun direction,
      // or pL computation). If THIS varies but tsunMs/lightingOnly look
      // uniform, the issue is just visual compression.
      const hitC = alpha.greaterThan(0.001);
      const scaled = lastOpticalDepthSun.div(float(10)).clamp(0, 1);
      return {
        rgba: vec4(
          hitC.select(scaled, float(0)),
          hitC.select(scaled, float(0)),
          hitC.select(scaled, float(0)),
          float(1),
        ),
        tFront: float(0),
      };
    }

    if (DEBUG_VIZ === "firstConeDepth") {
      // FIRST-dense-voxel sun optical depth (the VISIBLE surface's self-
      // shadow), scaled /10. Compare against 'coneDepth' (last/deepest voxel):
      //   first UNIFORM + last varies → surface uniformly lit; the variation
      //     is buried inside the cloud → we need boundary/tower relief.
      //   first VARIES (like last) → the surface self-shadow IS there and the
      //     lighting combine is flattening it → fix the lighting, not the shape.
      const hitF = alpha.greaterThan(0.001);
      const scaledF = firstOpticalDepthSun.max(0).div(float(10)).clamp(0, 1);
      return {
        rgba: vec4(
          hitF.select(scaledF, float(0)),
          hitF.select(scaledF, float(0)),
          hitF.select(scaledF, float(0)),
          float(1),
        ),
        tFront: float(0),
      };
    }

    if (DEBUG_VIZ === "eroded") {
      // Last-dense per-voxel `eroded` value (0-1). Shows the actual
      // detail-noise structure at the visible cloud surface, with NO
      // lighting math involved. This is the cleanest test of whether
      // per-pixel data variation exists at the current view distance.
      const hitE = alpha.greaterThan(0.001);
      return {
        rgba: vec4(
          hitE.select(lastEroded, float(0)),
          hitE.select(lastEroded, float(0)),
          hitE.select(lastEroded, float(0)),
          float(1),
        ),
        tFront: float(0),
      };
    }

    if (DEBUG_VIZ === "density") {
      // Last-dense density (eroded × densScale), scaled /20000 for display.
      const hitD = alpha.greaterThan(0.001);
      const scaled = lastDensity.div(float(20000)).clamp(0, 1);
      return {
        rgba: vec4(
          hitD.select(scaled, float(0)),
          hitD.select(scaled, float(0)),
          hitD.select(scaled, float(0)),
          float(1),
        ),
        tFront: float(0),
      };
    }

    if (DEBUG_VIZ === "litShape") {
      // The [0,1] LIT base shape the 800 m MACRO self-shadow probe absorbs by
      // (base+macro-carve), grayscale, day side only (black at night and on the
      // cone path — REQUIRES USE_LIGHT_VOLUME=true, the default). Compare to
      // 'eroded': it's smooth/km-scale while 'eroded' has fine detail — the
      // macro probe only shadows macro lumps; the fine cauliflower is
      // self-shadowed by the separate NEAR probe (DETAIL_SELFSHADOW, see
      // 'detailShadow').
      const hitLS = alpha.greaterThan(0.001);
      return {
        rgba: vec4(
          hitLS.select(lastLitShape, float(0)),
          hitLS.select(lastLitShape, float(0)),
          hitLS.select(lastLitShape, float(0)),
          float(1),
        ),
        tFront: float(0),
      };
    }

    if (DEBUG_VIZ === "detailShadow") {
      // The NEAR detail self-shadow term in isolation: exp(-odNear), grayscale,
      // day side only (REQUIRES USE_LIGHT_VOLUME=true + DETAIL_SELFSHADOW=true;
      // else flat white). White = clear sun path through the near detail; darker
      // = the near detail occluded the sun. LOBED light/dark patches at the
      // cauliflower scale = the fix is working. Flat grey / random speckle =
      // either no variation (DETAIL_SS_DIST wrong) or decorrelated noise.
      const hitDS = alpha.greaterThan(0.001);
      return {
        rgba: vec4(
          hitDS.select(lastDetailSS, float(0)),
          hitDS.select(lastDetailSS, float(0)),
          hitDS.select(lastDetailSS, float(0)),
          float(1),
        ),
        tFront: float(0),
      };
    }

    if (DEBUG_VIZ === "sunDir") {
      // Visualizes sunDirEarth as RGB colour. The colour will be
      // UNIFORM across the entire screen because sun direction is the
      // same for every voxel (sun at AU distance).
      // R = sunDir.x × 0.5 + 0.5 (0 means -X, 1 means +X)
      // G = sunDir.y × 0.5 + 0.5 (0 means -Y, 1 means +Y) — Earth-Y axis
      //     is the rotation axis (north pole). High green = sun overhead
      //     (above equator at solstice etc.); low green = sun below horizon
      //     of current Earth orientation.
      // B = sunDir.z × 0.5 + 0.5
      // If the visible sun on screen is in a particular corner but the
      // sunDir colour suggests opposite direction, there's a transform bug.
      const sr = sunDirEarth.x.mul(0.5).add(0.5);
      const sg = sunDirEarth.y.mul(0.5).add(0.5);
      const sb = sunDirEarth.z.mul(0.5).add(0.5);
      return {
        rgba: vec4(sr, sg, sb, float(1)),
        tFront: float(0),
      };
    }

    if (DEBUG_VIZ === "daylight") {
      // RAY-LEVEL daylight at the slab-chord midpoint pMid (the actual
      // lighting uses the per-sample `daylightS` since 2026-06-12 — this viz
      // keeps the cheap per-ray approximation; expect it to disagree with
      // the render exactly along the limb, where pMid jumps).
      // Bright = sub-solar (cloud directly illuminated), dark = terminator
      // / night side. Provides the "across-FOV brightness gradient" that
      // makes clouds near sun overall brighter than clouds toward the
      // terminator — correct physics, but masks within-cloud variation.
      const hitDay = alpha.greaterThan(0.001);
      return {
        rgba: vec4(
          hitDay.select(daylight, float(0)),
          hitDay.select(daylight, float(0)),
          hitDay.select(daylight, float(0)),
          float(1),
        ),
        tFront: float(0),
      };
    }

    // ── dither: visualise the per-pixel dither value directly ──
    // Outputs `dither` (the per-pixel hash output, already in [0, 1]) as
    // grayscale, with no marcher logic in between. Useful for verifying
    // that the hash produces uniform per-pixel variation — should look
    // like clean white noise. If you see ANY directional pattern here
    // (vertical/horizontal/diagonal bands), the hash has a spatial bias
    // and every downstream value will inherit that bias.
    if (DEBUG_VIZ === "dither") {
      return {
        rgba: vec4(dither, dither, dither, float(1)),
        tFront: float(0),
      };
    }

    // Far-LOD fade was here (12–20 km, then 30–50 km). Both ranges killed
    // opacity for cloud bodies in the typical viewing-distance band.
    // Removed for now — the volumetric marches its full ~48 km reach
    // and the flat overlay in earth.ts shows through where the volumetric
    // alpha is 0 (clear sky or pixels that missed the slab). Distant
    // pixels will still produce noise; that's a separate problem for the
    // far-LOD architecture and we'll revisit once the near-cloud
    // appearance is fixed (Issue #2: Perlin-Worley R channel).
    //
    // Premultiplied output — `col` is already color·α from front-to-back
    // accumulation. Blending is configured with (ONE, 1-α) to match.
    // Scale BOTH channels by the crossfade factor: since the framebuffer math
    // is `out = src + (1-src.a)*dst`, multiplying (col, alpha) by k uniformly
    // scales the cloud's contribution toward fully transparent without
    // changing the unpremultiplied colour.
    // Opacity-weighted apparent depth for TAA reprojection (falls back to
    // firstHitT — including the −1 no-hit sentinel — when nothing scattered).
    const apparentDepth = depthWeightSum.greaterThan(float(0.0001)).select(
      weightedDepthSum.div(depthWeightSum.max(float(0.0001))),
      firstHitT,
    );

    // ── Opacity saturation (2026-06-22, "horizon bleeds through dark cloud") ──
    // A ray that exits the slab before T<0.01 lands at α≈0.9–0.99, not 1. That
    // residual (1−α) transmittance is invisible against the dim star background
    // but GLARING against the very bright HDR atmosphere limb — so dark cloud in
    // front of the limb reads see-through while the same cloud over space looks
    // opaque (confirmed: stars occluded, only the bright horizon edge leaks; it
    // took ~100× density to brute-force closed — the additive-vs-multiplicative
    // tell). Earth + stars are BOTH in the pre-cloud scaled scene with a correct
    // premul-over composite, so this is NOT a blend/bloom/order bug — the cloud
    // just isn't quite opaque. Push substantially-opaque clouds to fully opaque
    // (closing the leak) while leaving genuinely thin edges (α < LO) translucent,
    // which they SHOULD be. Curve only — decoupled from density, so the lit look
    // / cauliflower tuning is unchanged. `col` is premul at the old α; for the
    // affected high-α band α≈col-premul-α already, so no col rescale needed.
    const ALPHA_SHARP_LO = 0.7; // below this, leave translucent (thin edges)
    const ALPHA_SHARP_HI = 0.95; // at/above this, force fully opaque
    const alphaSharp = alpha.add(
      float(1)
        .sub(alpha)
        .mul(smoothstep(float(ALPHA_SHARP_LO), float(ALPHA_SHARP_HI), alpha)),
    );
    // ── Q1 near/far crossfade (complement of the shell's distance fade-IN) ──
    // Fade the volumetric OUT over SHELL_HANDOFF_NEAR→FAR (by the cloud-front
    // distance) as the shell fades IN over the same band, so the hand-off is a
    // smooth crossfade rather than a hard edge at the march cap. Near clouds →
    // full volumetric; approaching FAR → volumetric fades, shell takes over.
    // (apparentDepth is camera distance in scaled units; −1 sentinel → no hit →
    // alpha already 0, so the fade value is irrelevant there.)
    const farFade = float(1).sub(
      smoothstep(
        float(kmToScaledUnits(SHELL_HANDOFF_NEAR_KM)),
        float(kmToScaledUnits(SHELL_HANDOFF_FAR_KM)),
        apparentDepth,
      ),
    );
    return {
      rgba: vec4(col, alphaSharp).mul(uVolumetricBlend).mul(farFade),
      tFront: apparentDepth,
    };
}
