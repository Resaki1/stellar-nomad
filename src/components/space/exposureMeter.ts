// ─────────────────────────────────────────────────────────────────────
// AUTO-EXPOSURE / EYE ADAPTATION — LIGHTING_PLAN.md Phase 5
//
// ── Why this is not a copy of Unreal's histogram ─────────────────────────────
// The AAA baseline (UE5, Frostbite, REDengine) is: build a GPU histogram of
// log-luminance, average a percentile band (UE defaults 80–98.3%), clamp to
// min/max EV, then follow it with asymmetric speeds and an artist-authored
// exposure-compensation curve. UE5.1 adds *local* exposure (a bilateral filter)
// to keep local contrast in high-range scenes. Forza is the other school: a real
// camera model (aperture/shutter/ISO) with a filmic curve — explicitly a CAMERA,
// which §8 rejected for this game in favour of the EYE.
//
// We skip the histogram, but NOT the percentile band — and the first draft of
// this file got that distinction wrong, so it is worth stating precisely.
//
// A log-space average is robust to a bright MINORITY: a 0.1%-coverage sun at
// EV 21 shifts a log mean by 0.02 EV, nothing. That much was right. **It is
// catastrophically NOT robust to a dark MAJORITY**, and that is the case that
// actually matters here. Once the skybox was rescaled to its true ~1e-8 game
// units, deep space sits 25–30 stops below any lit subject, so a frame that is
// 75% empty simply outvotes the planet in it. MEASURED on device: Earth half-lit
// and centred in frame metered **−17.68** when its disc is at EV ≈ 3 — 21 stops
// low — and the resulting 1057× exposure blew the whole image out.
//
// **This is exactly why Unreal meters a percentile BAND (80–98.3%) rather than an
// average**: the band is biased bright, which is what survives the
// subject-versus-sky case. So we take the band, and skip only the GPU histogram
// that normally computes it — because with 4096 samples read back per frame the
// percentiles are cheaper to take in JS, which keeps **the entire metering
// algorithm inspectable and changeable from the console with no shader
// recompile**. (Four wrong analytic models of the cloud opacity LUT in one
// session is the argument for that.) That choice is what made this fix a JS
// edit rather than a shader rewrite.
//
// ── Why full adaptation would throw away the entire phase 0–3 effort ─────────
// Terrestrial games span perhaps 15–20 stops. **We measured 44** (EV −10 airglow
// → +34 sun disc). If exposure always maps the metered value to middle grey,
// then deep space and sunlit Mercury render EQUALLY BRIGHT — the photometric
// work that made the solar system's relative brightness correct would be undone
// in the last pass. So adaptation must be PARTIAL.
//
// The amount is not a taste call; it has a physiological anchor. Stevens' power
// law puts perceived brightness ∝ L^≈0.33, so a 44-stop luminance range should
// present as ≈44 × 0.33 ≈ 15 stops of perceived range, not 0. In exposure terms
// that is `adaptedEV = anchor + k·(metered − anchor)` with **k ≈ 0.67**, leaving
// (1 − k) = ⅓ of the real variation visible. This is what Unreal's
// exposure-compensation curve is hand-authored to do; deriving it instead means
// it also holds for procedurally generated systems with no per-system tuning
// (§3.0), which is the whole point.
//
// ── Eye, not camera: two timescales ─────────────────────────────────────────
// Adapting to BRIGHTER is fast and protective (the squint response, ~0.25 s) —
// this is what stops a glance at the sun from blinding you for seconds. Adapting
// to DARKER is slow, and slower the darker it gets: cone adaptation is a couple
// of seconds, rod (scotopic) dark adaptation is really 20–40 MINUTES, compressed
// here to ~6 s so that looking away from a planet into deep space gives a
// gradual reveal of stars instead of an instant one. §8's decisions call for
// exactly this asymmetry.
// ─────────────────────────────────────────────────────────────────────

import * as THREE from "three";
import { NodeMaterial, RenderTarget } from "three/webgpu";
import type { WebGPURenderer } from "three/webgpu";
import type { Node } from "three/webgpu";
import {
  Fn,
  Loop,
  exp2,
  float,
  length,
  log2,
  max,
  min,
  texture,
  uniform,
  uv,
  vec2,
  vec4,
} from "three/tsl";
import {
  EV_MAX,
  EV_MIN,
  NITS_PER_GAME_UNIT,
  evFromGameUnits,
  getPreExposure,
  isManualExposure,
  setMeteredEV,
} from "./photometry";
import { updateScotopicUniforms } from "./scotopic";

// ── Sampling ────────────────────────────────────────────────────────────────
// 64×64 = 4096 samples of the frame. Statistically ample for a scalar exposure
// (the standard error of a mean over 4096 samples is 1.6% of the spread) and it
// keeps the readback at 16 KB, which is nothing. One pass, no mip chain.
// ⚠ Point sampling can miss a sub-pixel-bright object between grid points. That
// is fine and slightly desirable: the adaptation filter below integrates over
// ~0.25–6 s, so a sample that flickers in and out contributes its time-average,
// and a bright object big enough to matter for exposure covers many grid cells.
const GRID = 64;

// ── Metering weight ─────────────────────────────────────────────────────────
// Centre-weighted, like every camera and (more to the point) like the eye, whose
// adaptation is strongly foveal. Without it, flying toward a planet against a
// mostly-empty starfield meters the EMPTY part and blows the planet out — the
// classic subject-versus-sky metering failure, which in this game is the common
// case rather than the exception.
// Gaussian in radius (fraction of the half-diagonal). σ is the load-bearing
// number: it decides the smallest CENTRED subject that can still win the
// weighted percentile against a black background. MEASURED by simulation against
// the on-device failures — a subject occupying this fraction of frame area meters
// correctly at:  σ 0.60 → 25% only.  σ 0.35 → 3%.  **σ 0.25 → 3%.**  σ 0.18 → 1%.
// 0.25 is the compromise: it recovers Neptune (3% of frame, which was metering
// 15 stops low) without narrowing the field so far that simply turning the camera
// makes exposure twitchy. Subjects under ~1% of frame still over-expose; that is
// accepted — the eye does not fully adapt to a tiny bright dot either, and
// sub-pixel/small bodies are Phase 4's impostor problem.
// ── Hot-tail cap (D26) ───────────────────────────────────────────────────────
// Fraction of total sample WEIGHT treated as the "hot tail", and the largest
// share of total flux that tail is allowed to contribute.
//
// While the tail sits UNDER the cap it lifts the reading by at most
// log2(1/(1−S)) = 0.51 stops above the rest-only reading; past the cap the power
// law below lets that grow slowly rather than freezing (which was non-monotonic).
// ⚠ This is NOT a bound on `hotClipStops`, which measures the distance from an
// uncapped mean and is unbounded on purpose. 2% of weight sits BELOW the coverage of a
// legitimately bright subject (Earth's disc fills 10–20% of frame at orbit, so its
// bulk stays in `rest` and still meters normally) and ABOVE that of a nozzle glow.
// Taps per axis inside each metering tile (TILE_TAPS² samples per output texel).
// 16 → 256 taps × 4096 texels = 1.05 M fetches/frame, which is nothing next to a
// 2 MP frame. See the stratified-sampling note at the use site for why this is
// about VARIANCE, not coverage.
const TILE_TAPS = 16;

const HOT_WEIGHT_FRACTION = 0.02;
const MAX_HOT_FLUX_SHARE = 0.3;
// Log-log slope applied to the hot tail's flux ABOVE the cap. 1.0 = no
// compression (raw flux mean); 0 = a hard cap, which is non-monotonic — see the
// soft-compression note at the use site. 0.25 = 4:1 compression in stops.
const HOT_COMPRESS_EXPONENT = 0.5;

// ── Spatial weighting ────────────────────────────────────────────────────────
// ⚠ σ = 0.25 was a CAMERA's spot meter and it contradicted §8's own premise.
// MEASURED: with σ = 0.25, a subject sliding from frame centre to the left edge
// loses 2.9 stops of weight (1.0 → 0.135), so simply TURNING made the scene
// brighten — "the earth and ship get visibly brighter" when the sun came into
// frame, because the subject had moved off-centre faster than the sun added.
//
// A camera wants a chosen SUBJECT exposed, so it must discount the rest of the
// frame. An eye cannot discount anything — adaptation is dominated by the fovea
// but the whole retina contributes. σ = 0.5 with a 0.25 floor keeps a mild centre
// bias (edge weight 0.61, corner 0.38) while making exposure far less a function
// of where the camera happens to point.
//
// ⚠ Trade-off: a SMALL centred subject now gets less relative emphasis, so if a
// distant planet under-meters, σ is the knob — not the hot-tail constants.
const CENTRE_SIGMA = 0.5;
const EDGE_WEIGHT = 0.25; // an eye cannot discount the periphery (see above)

// ── Partial adaptation (see the header) ─────────────────────────────────────
// k: fraction of a scene's real brightness change that exposure cancels.
// 1 = everything renders identically bright (wrong), 0 = fixed exposure.
// ── The estimator: a LINEAR (flux) mean. Three wrong answers preceded it. ────
// 1. Weighted log-average of the frame → read **21 stops low**. A log-average is
//    robust to a bright minority and catastrophically not to a dark majority;
//    with the sky 25–30 stops down, a 75%-empty frame outvotes the subject.
// 2. Unreal's percentile band (p90–p98) → fixed big subjects, broke small ones.
//    Measured on the sun: p90 = −23.6 (void), p98 = −0.9 (sun) — the band
//    straddled two populations 23 stops apart and returned a number describing
//    nothing. **A percentile of PIXELS conflates "how bright" with "how much of
//    the frame".**
// 3. Void rejection + log-average → still INVERTED. Measured: Earth metered 0.85
//    (exposure 0.297), then turning to the SUN metered −1.81 (exposure 1.404).
//    Turning toward the brightest object in the solar system RAISED exposure.
//
// The mistake common to all three is the domain. **Log space is right for TONE
// MAPPING and wrong for ADAPTATION.** Retinal illuminance is a LINEAR integral of
// the field — the eye adapts to total flux arriving, not to a log-average of it.
// §8 asked for an eye rather than a camera, and camera metering is exactly where
// log/percentile estimators come from: a camera wants a chosen SUBJECT correctly
// exposed, so it must discount the rest of the frame. An eye cannot discount
// anything; photons are photons.
//
// So: weighted mean of linear radiance, converted back to EV at the end. This
// needs no void rejection and no percentile band, because **the void contributes
// ~0 to a linear sum by construction** — that is the property all three earlier
// attempts were trying to fake. It also responds correctly to the sun for the
// same reason.
//
// ⚠⚠⚠ 2026-08-24 — **THE PARAGRAPH ABOVE IS HALF RIGHT, AND THE OTHER HALF IS D33.**
// "The void contributes ~0 to a linear sum" is true of the NUMERATOR and false of
// the DENOMINATOR. `Σ L·w / Σ w` adds nothing to the top for an empty pixel and its
// full share to the bottom — so this estimator is the mean IRRADIANCE OF THE FIELD,
// which is proportional to how much of the frame the subject covers:
//
//     metered ≈ coverage · L_subject      ⇒     rendered ∝ coverage^(−ADAPTATION_K)
//
// MEASURED on Uranus at 100/200/400 kkm (`__lum.meter`): the disc's own radiance is
// invariant — 57.3 / 57.7 / 55.3 cd/m², exactly as radiance conservation requires —
// while `metered EV` swings **3.38 stops** and the disc renders at **0.93 / 3.08 /
// 6.85** display-linear. Predicted +1.70 stops per 4× coverage drop, measured +1.72.
// At coverage = 1 the same chain puts the disc on **0.160**, i.e. middle grey, so
// ANCHOR_EV / ADAPTATION_K / EXPOSURE_BIAS_STOPS are all correctly set and the whole
// error is **+2.5 to +5.4 stops of coverage over-exposure.**
//
// 🔑 So the log-average, the percentile band and this flux mean are **ONE defect in
// three guises**: every global frame statistic is a function of the frame's
// COMPOSITION as well as its light. Do NOT try to tune out of it.
//
// 🔑 The fix follows from this file's own premise — "photons are photons" — applied
// to the denominator too: **weight by FLUX, not by area.** `Σ L²w / Σ Lw` is the mean
// luminance of an arriving photon; it returns L_subject independently of coverage,
// returns L on a uniform field, and needs no threshold or percentile. ⚠ It is a
// SECOND moment, so it makes D26 worse and the hot-tail cap (derived on the first
// moment) must be re-derived with it. The alternative, and the modern AAA answer, is
// local exposure (UE5.1) — coverage-independent by construction because the local
// neighbourhood of a disc IS the disc, and it also handles Mercury at 105,000 cd/m²
// and Neptune at 8 cd/m² in one frame, which NO global exposure can. ⚠ That needs an
// edge-aware pyramid; a Gaussian local mean across a disc/black-sky edge haloes.
//
// ⚠ IT IS ONLY AS GOOD AS THE EMISSIVES. A flux mean responds to whatever is
// actually bright, so an UNCALIBRATED emissive now moves exposure. Measured: at
// Neptune the ship's exhaust glow (≈1.13 game units ≈ 6,800 cd/m², ~1% of frame)
// contributes 13× the flux of Neptune's entire 92%-of-frame disc, pulling the
// meter 1.7 stops bright. That is the meter reading a wrong input correctly —
// see `topFluxShare` in the diagnostics, which exists to catch exactly this.
const ADAPTATION_K = 0.85;

// ── The estimator (D33) — THREE, and the third is the answer ────────────────
// All three are computed every frame and all three print in `__lum.exposure()`,
// because their DIFFERENCES are the diagnostic.
//
//  • **"area"** — `Σ L·w / Σ w`, the mean IRRADIANCE of the field. What shipped.
//    An empty pixel adds nothing to the numerator and its full share to the
//    denominator ⇒ the reading is proportional to the subject's COVERAGE, which is
//    D33: rendered ∝ coverage^(−k). MEASURED slope −0.678.
//  • **"flux"** — `Σ L²w / Σ Lw`, the flux-weighted mean luminance. Coverage-
//    independent (MEASURED flat to 0.05 stops where the hot cap is idle) but it
//    discards AREA, so a bright dot claims full authority over adaptation: with the
//    sun in frame everything else went black. Rejected — see the note below.
//  • **"pooled"** — the foveally-weighted soft-max over the metering grid's CELLS.
//    ✅ THE ONE THAT IS RIGHT, and the reason is that it separates two things the
//    other two conflate.
//
// 🔑🔑 THE INSIGHT THAT RESOLVES D33: **POOLING and COVERAGE-INDEPENDENCE ARE TWO
// DIFFERENT MECHANISMS, and each estimator above tried to get both from one number.**
//
//   1. A source SMALLER than the eye's adaptation pooling area (~1° of visual angle)
//      should count as its FLUX SPREAD OVER THAT AREA, not as its surface luminance.
//      That is why a bright dot does not blind you — and it is a property of the
//      SAMPLING, not of the statistic.
//   2. A source LARGER than the pool should count as its own luminance, whatever
//      fraction of the frame it fills. That is coverage-independence, and it is a
//      property of the STATISTIC.
//
// 🔑 THE GRID IS ALREADY THE POOL. Each of the 64×64 cells is a tile AVERAGE of the
// frame — at 1080p tall that is 16.9 px ≈ **0.78° at a 50° FOV**, i.e. the retinal
// pooling area, by accident of a grid chosen for readback size. So mechanism (1) is
// already paid for: a sub-cell plume or star already enters as flux/cellArea. All
// that was ever needed was to stop averaging the pooled cells over the whole frame
// and instead take the brightest of them.
//
// ⚠⚠ AND THE INSTRUMENT HAD ALREADY PROVEN IT. `dist.max` — the brightest cell — read
// **−3.72 / −3.71 / −3.77** on Uranus across a 4× distance change while `metered`
// swung **3.38 stops**. The coverage-invariant estimator was sitting in the
// diagnostics the whole time, printed next to the broken one.
//
// ⚠ WHY THIS IS NOT §5.9's FAILED PERCENTILE BAND. That was a percentile of AREA
// (p90–p98 of pixels), which by construction asks "how much of the frame", so it
// straddled two populations 23 stops apart. This asks "what is the brightest pooled
// region", which has no area term at all. Unreal's histogram band is the same family
// and works there only because a terrestrial scene has no 25-stop void in it.
//
// ⚠ A SOFT max, not `max()`: the mean of every cell within POOL_WINDOW_STOPS of the
// weighted maximum. A hard max would ride one noisy cell frame to frame; averaging
// the top plateau gives the same answer on a resolved subject (all its cells are
// within the window) and is stable.
type Estimator = "area" | "flux" | "pooled";
// ⚠⚠ 2026-08-24 — BACK TO "area", AND THE REASON MATTERS MORE THAN THE VALUE.
// "pooled" did what it claimed (slope −0.678 → −0.084) and the game got WORSE, in two
// ways that are both fatal and both instructive:
//
//  1. **IT STEPS.** The 2-stop window is a HARD membership test, so as the camera
//     moves a cell entering or leaving the pool changes the mean discontinuously. With
//     a subject spanning a handful of the 4096 cells, one cell is a large fraction of
//     the pool. A mean over the whole frame is smooth; a windowed max is not. The user
//     reported exactly this: "adapting less smooth", "harder steps".
//  2. **THE POOLING SCALE IS WRONG FOR THE GLOBAL TERM.** Luna at 377,000 km subtends
//     0.53° — smaller than one 0.78° cell — and blacked out the whole frame. Check it
//     against reality: the full moon is ~3,000 cd/m² at 0.52°, and it does NOT stop you
//     seeing stars. Your GLOBAL adaptation is set by the whole-field average, in which
//     the moon contributes 3,000·(0.5/200)² ≈ 0.02 cd/m². **The moon is genuinely
//     clipped in your visual experience** — a bright white disc whose maria you can
//     barely make out. So "let a small bright object clip" is CORRECT behaviour, and
//     the area-weighted mean was producing it for the right reason.
//
// 🔑🔑 THE ERROR IN THE D33 ARGUMENT, STATED PLAINLY: the eye has BOTH a global term
// (pupil + photochemical, driven by the field AVERAGE — that is `area`) and a local
// term (receptor gain at ~1°). I measured the coverage law correctly and then assigned
// it to the wrong term. Coverage-independence is a property of the LOCAL term; forcing
// it into the GLOBAL term is what produced the moon blackout and the sun blackout.
//
// ⚠⚠ AND I OVER-FITTED THE LADDER. `__lum.meter` sweeps to 0.166% coverage, where the
// spread is 5.4 stops — but that is a 91 px dot, the Luna case, where clipping is
// right. At the coverage the ACTUAL COMPLAINT lived at (a planet filling ~40% of frame)
// the coverage error is only ~1 stop. **The washed-out planets were mostly the TONE
// CURVE POSITION, not metering**: at the old +2.5 stops bias a metered scene renders at
// 0.59 display-linear, deep in AgX's desaturating shoulder, and a planet's disc is a
// LOW-CONTRAST subject — Saturn's bands are a ~20% reflectance spread, which survives
// at 0.18 and dies at 0.6. A 5-stop "fix" was applied to a ~1-stop problem.
const ESTIMATOR: Estimator = "area";
// Cells within this many stops of the weighted max form the "brightest thing I am
// looking at". 2 stops passes a real subject's own shading variation and excludes
// the next population down.
const POOL_WINDOW_STOPS = 2.0;

// ⚠⚠ EVERY EV IN THIS FILE IS A **GAME-UNIT** EV, i.e. log2(gameUnits × 8) — NOT
// the cd/m² EV that `evFromGameUnits` and the `__lum` probe tables report. The
// two differ by log2(NITS_PER_GAME_UNIT) ≈ 12.6 stops, and getting it wrong here
// is a 6,038× exposure error.
// The reason: `exposureFromEV` is applied to `uExposure`, which multiplies the
// scene in GAME UNITS. `EV_MIN = −16` confirms it — that is 1.15e-2 cd/m², a
// mag-6 star's per-pixel equivalent, which is exactly how §8 derived it.
//
// ANCHOR_EV = sunlit cloud top at 1 AU = 3.171 game units → log2(3.171×8) = 4.665.
// This is the look the whole calibration was built around, and at k's fixed point
// it renders at 1/9.6 = 0.104 — the standard middle grey.
const ANCHOR_EV = 4.665;

// ── Output bias, stops brighter ─────────────────────────────────────────────
// Two parts, one derived and one authored, and worth keeping separate:
//
//  • **0.79 stops are a grey-point mismatch.** The photographic constant
//    `exposure = 1/(1.2·2^EV)` places the metered luminance at 1/9.6 = 0.104 in
//    display-linear, but tone curves — AgX included — are built around middle grey
//    ≈ 0.18. log2(0.18/0.104) = 0.79. Without this every correctly-metered scene
//    renders below the grey the curve was designed for.
//  • **~1.7 stops are authored.** The user judged the physically-neutral result
//    "a bit dark" consistently across scenes (Earth from the belt AND looking at
//    the sun), and settled on ≈+2.5 total. A consistent offset across unrelated
//    scenes is a calibration constant, not a per-scene tweak — which is exactly
//    what Unreal's global ExposureCompensation is for.
//
// ⚠⚠ 2026-08-21: THE WARNING BELOW CAME TRUE, AND THIS VALUE DROPPED BY 0.585.
// The authored ~1.7 stops existed because the physically-neutral result looked "a
// bit dark" — and Phase 4 then proved the scene really WAS too dark: every lit
// surface was missing the geometric→Lambert albedo conversion (`p = (2/3)·A`), i.e.
// exactly **log2(1.5) = 0.585 stops**. So that much of the authored offset was
// compensating for a renderer bug, not expressing a preference.
//
// 🔑 HOW IT SURFACED: with the Lambert factor restored, planets went washed-out and
// featureless — and the discriminating observation was that **Uranus did NOT**.
// Uranus's sub-solar radiance is 81 cd/m² against Saturn's 332 and Jupiter's 1,216,
// so it lands ~2 stops lower on the curve and escapes the shoulder. A clipping
// threshold that depends only on absolute radiance is a TONE problem, not a per-body
// one. At +2.5 stops a correctly-metered planet renders at 0.104 × 2^2.5 = 0.59
// display-linear, well into AgX's desaturating shoulder; that is the washout.
//
// 0.585 removed, leaving 1.915 = 0.79 derived + ~1.125 authored. ⚠ THE REMAINING
// AUTHORED PART IS STILL A LOOK CHOICE and should be re-judged now that lit bodies
// are correct — 0.79 alone puts a metered scene exactly on middle grey (0.18), which
// is where surface detail is most visible. Do not go back up without checking a
// planet's disc for clipping.
//
// ⚠ This is the ONE artistic number in the file; everything else is derived. It
// must NOT be used to paper over a metering error — a scene that is wrong only in
// one view is a metering bug, and only a consistent offset belongs here.
//
// ⚠⚠ AND D33 IS EXACTLY SUCH A METERING BUG — planets read washed out because
// exposure scales as coverage^(−k), NOT because this number is too high. Lowering it
// would darken the coverage-100% case (already correct at middle grey) to fix the
// coverage-1% case. Run `__lum.meter()` before touching this.
const EXPOSURE_BIAS_STOPS = 1.415;

// ── Time constants, seconds ─────────────────────────────────────────────────
const TAU_BRIGHTEN = 0.25; // scene got brighter → exposure drops fast (squint)
const TAU_DARKEN_CONE = 2.0; // scene got darker, photopic → cones, seconds
const TAU_DARKEN_ROD = 6.0; // scene got darker, scotopic → rods (real: 20–40 min)
// Mesopic boundary, GAME-UNIT EV: below this, rod adaptation sets the rate.
// 0.03 cd/m² = 4.97e-6 game units → log2(4.97e-6 × 8) = −14.62.
const MESOPIC_EV = -14.62;

// ─────────────────────────────────────────────────────────────────────
// LOCAL EXPOSURE (D33 / D33b) — the actual fix, and NOT a new pipeline
//
// ── Why a local term is forced, not chosen ──────────────────────────────────
// D33 measured `rendered ∝ coverage^(−ADAPTATION_K)`: a global mean is a function
// of the frame's COMPOSITION as well as its light. Both moments of that mean were
// measured (`__lum.meter`, 324× of coverage) and both fail, in opposite directions
// — p = 1 slope −0.678, p = 2 slope −0.302 — and the hot-tail cap that causes
// p = 2's residual is the same cap that stops a bright dot owning adaptation. It
// cannot separate those cases because **both are "small and bright", and size is
// the wrong discriminator.** Only SPATIAL LOCALITY separates them. That is the
// whole argument for this block, and it is UE5.1's Local Exposure.
//
// 🔑 THE PASS WE NEED ALREADY EXISTS. The metering shader above renders a 64×64
// target whose R channel is tile-averaged log-luma. At 1920 wide that is ~30 screen
// px per cell — **≈1° of visual angle, which is the actual retinal pooling scale of
// local adaptation.** So this costs one bilateral blur of 4096 texels and one
// multiply in the composite, not a new pyramid.
//
// ── The strength is DERIVED, not authored ───────────────────────────────────
// For a subject of coverage f on a void the global meter reads `EV_disc + log2(f)`,
// so the subject sits `gap = log2(1/f)` stops above the reference, and D33's law
// says it renders `k · log2(1/f)` stops too bright. Those are the same quantity:
//
//        over-exposure = ADAPTATION_K · gap        ⇒  **strength = ADAPTATION_K**
//
// ✅ CHECKED against the p = 1 sweep at four coverages (54.4 / 10.7 / 1.51 / 0.168%):
// k·gap = 0.84 / 2.81 / 5.23 / 6.21 stops against a measured over-exposure of
// 0.55 / 2.58 / 5.00 / 6.00. That is a **flat −0.24-stop residual with no slope** —
// i.e. this flattens the coverage law and leaves a constant offset, which is a bias
// question (EXPOSURE_BIAS_STOPS) and not a coverage one. ⚠ Do not pre-compensate the
// 0.24 here; a constant belongs in the one place constants belong.
// So there is no per-system tuning and nothing to re-derive for a procedural system.
//
// ── ⚠⚠ HIGHLIGHTS ONLY, AND THAT IS NOT A SIMPLIFICATION ────────────────────
// A symmetric local gain would BRIGHTEN dark regions toward the reference, and in
// this game the dark region is deep space sitting ~25 stops down: it would be lifted
// ~12 stops, blowing the starfield to white and undoing the entire 44-stop
// calibration locally. UE exposes highlight and shadow contrast separately for
// exactly this reason. Our defect is one-sided — bright subjects render too bright —
// so this only ever DARKENS. `LOCAL_SHADOW_STRENGTH` exists, defaults to 0, and
// should stay there until something measured asks for it.
// 🔑 The one-sided clamp also makes an unbuilt/black map safe by construction: a
// local EV of −∞ gives a positive `stops` that `max(…, 0)` on the shadow side
// ignores, so the gain is exactly 1 before the first blur lands.
// ─────────────────────────────────────────────────────────────────────
// ── ⚠⚠ WHY THIS IS OFF BY DEFAULT — MEASURED, 2026-08-24 ────────────────────
// Built, wired, measured, and turned off. It WORKS as specified — it pulled the
// coverage slope from −0.678 to **−0.151** — and it is still the wrong tool here.
//
// 🔑 THE USER'S OBJECTION WAS THE RIGHT ONE: *"isn't this just compressing the
// dynamic range?"* Yes. That is definitionally what a per-pixel gain does, and the
// gate says how much: `local gain` ran **0.572 → 0.0283** across the sweep, i.e. it
// was applying **4.3 stops of spatially-varying compression.** For scale, UE5's
// Local Exposure ships around 0.8 highlight contrast ≈ 1.3 stops, and its docs warn
// about flatness and halos at that. Four stops through a local operator is not a
// setting anybody ships; it is the 2008 HDR-photo look.
//
// And it showed exactly as theory predicts for a 30 px pooling grid asked to carry a
// 5-stop gradient: **visible cell structure and temporal flicker** (the map is
// re-derived every frame from a stratified sample with no history, so the bilateral's
// range weights flip between neighbours frame to frame).
//
// ⚠ It also had a real bug: the map was applied VERTICALLY MIRRORED, so the
// darkening landed on the reflection of the subject. That is fixable. It is not why
// this is off — the compression is.
//
// **The reframe that made it unnecessary:** the per-pixel gain was compensating for a
// GLOBAL estimator that was wrong. Fix the global estimator (see "pooled" above) and
// there is no per-pixel correction left to make, no compression, no cells, no halos,
// no flicker. Kept, gated at strength 0, because it is the honest answer to a
// DIFFERENT problem we will eventually have — a lit cockpit interior against a
// sunlit planet, where two surfaces genuinely need different exposure in one frame.
// ⚠ Fix the flip before ever re-enabling it, and keep the strength near UE's ~1 stop.
//
// ── ⚠ KNOWN LIMIT: THE CELL SIZE IS THE HALO WIDTH ─────────────────────────
// A cell is 30 screen px at 1920 wide, so the gain transitions from "subject" to
// "void" over ~1 cell at the limb. That is fine for a disc hundreds of px across and
// MARGINAL for a small one: at the 5%-of-height stop the disc is ~91 px ≈ 3 cells, so
// a third of it is transition and the limb will darken visibly less than the middle —
// a bright rim. Below ~3 cells local exposure degenerates and a global scalar is all
// there is. **If a rim shows, GRID is the knob** (128 → 15 px cells, 4× the metering
// fetches, and it also changes the global metering statistics — change ONE at a time).
// ⚠⚠ AND NOTE THE GATE'S BLIND SPOT: `__lum.meter()` reads `probeMax(9)` at the disc
// CENTRE, the most-darkened point, so it can report a flat slope while the limb
// glows. Confirm with `__lum.localMap()` and with your eyes, not the slope alone.
const LOCAL_BLUR_RADIUS = 3; // cells; 7×7 taps over a 64×64 map
const LOCAL_SPATIAL_SIGMA = 1.5; // cells ≈ 45 px ≈ 1.2° at a 50° FOV
// ⚠ THE EDGE-AWARE TERM IS THE WHOLE POINT. A plain Gaussian local mean across a
// planet/black-sky boundary is what produces the classic dark halo, because the
// cells just outside the limb average in the disc. 2 stops passes real shading
// variation and rejects a 10-stop subject/void step outright.
const LOCAL_RANGE_SIGMA_STOPS = 2.0;
// Backstop only — the derived strength cannot reach this on any physical frame.
const LOCAL_MAX_DARKEN_STOPS = 8;
const LOCAL_SHADOW_STRENGTH = 0; // see above; do not raise without a measurement

// ⚠⚠ DEFAULT OFF. See "WHY THIS IS OFF" above the constants.
let _localEnabled = false;
let _localStrengthOverride: number | null = null;
let _blurRt: RenderTarget | null = null;
let _blurScene: THREE.Scene | null = null;
// ⚠ ONE stable node, created at module scope and its `.value` swapped in `build()`.
// `localExposureNode()` is called from SpaceRenderer's node-graph useMemo, which runs
// BEFORE the first frame builds the render targets — so a node created at call time
// would capture the placeholder texture and never see the real map. Same pattern the
// metering pass already uses for its own source proxy.
const _localMapNode = /*#__PURE__*/ texture(new THREE.Texture());
const _localMapTex = _localMapNode as unknown as { value: THREE.Texture | null };
let _blurSrcTex: { value: THREE.Texture | null } = { value: null };
let _localMapReady = false;
/** Stops the local map's reference sits at, in the SAME pre-exposed units it stores. */
const uLocalRefEv = /*#__PURE__*/ uniform(0);
/** 0 disables local exposure entirely (bit-exact no-op). Derived: ADAPTATION_K. */
const uLocalStrength = /*#__PURE__*/ uniform(0);

let _rt: RenderTarget | null = null;
let _scene: THREE.Scene | null = null;
let _camera: THREE.OrthographicCamera | null = null;
let _sourceTex: { value: THREE.Texture | null } = { value: null };

let _adaptedEV = ANCHOR_EV;
let _initialised = false;
let _readPending = false;
let _lastMeteredEV = ANCHOR_EV;
let _lastSampleCount = 0;
// Weighted percentiles of the last frame's EV distribution — the thing to read
// FIRST when exposure misbehaves. A metered value far from p90/p98 means the
// band is landing on the wrong part of the scene, which is the failure that
// shipped in the first draft (weighted mean → 21 stops low on a mostly-void frame).
let _lastDist: { p05: number; p50: number; p90: number; p98: number; max: number } = {
  p05: 0, p50: 0, p90: 0, p98: 0, max: 0,
};
// Share of the metered FLUX carried by the brightest 1% of samples. **Read this
// first when exposure misbehaves.** A physical scene sits low; >~50% means one
// small hot feature is driving adaptation, which in practice means an emissive
// that was never put on the game-unit scale.
let _lastTopFluxShare = 0;
let _lastHotClipStops = 0;
let _lastHotLiftStops = 0;
// Both estimators, always, so the D33 divergence is visible without a rebuild.
let _lastEvArea = ANCHOR_EV;
let _lastEvFlux = ANCHOR_EV;
let _lastEvPooled = ANCHOR_EV;
let _lastPoolCells = 0;

/** Diagnostics for `__lum.exposure()`. */
export function exposureMeterStatus() {
  return {
    meteredEV: _lastMeteredEV,
    adaptedEV: _adaptedEV,
    targetEV: adaptationTarget(_lastMeteredEV),
    samples: _lastSampleCount,
    dist: _lastDist,
    topFluxShare: _lastTopFluxShare,
    hotClipStops: _lastHotClipStops,
    hotLiftStops: _lastHotLiftStops,
    estimator: ESTIMATOR,
    evAreaWeighted: _lastEvArea,
    evFluxWeighted: _lastEvFlux,
    evPooledMax: _lastEvPooled,
    poolCells: _lastPoolCells,
    poolWindowStops: POOL_WINDOW_STOPS,
    hotCompressExponent: HOT_COMPRESS_EXPONENT,
    hotWeightFraction: HOT_WEIGHT_FRACTION,
    maxHotFluxShare: MAX_HOT_FLUX_SHARE,
    centreSigma: CENTRE_SIGMA,
    grid: GRID,
    adaptationK: ADAPTATION_K,
    biasStops: EXPOSURE_BIAS_STOPS,
    anchorEV: ANCHOR_EV,
    manual: isManualExposure(),
  };
}

/** Partial-adaptation curve: metered scene EV → the EV exposure should target. */
export function adaptationTarget(meteredEV: number): number {
  return ANCHOR_EV + ADAPTATION_K * (meteredEV - ANCHOR_EV);
}

function build(renderer: WebGPURenderer): void {
  void renderer;
  _rt = new RenderTarget(GRID, GRID, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  _rt.texture.colorSpace = THREE.NoColorSpace;

  const mat = new NodeMaterial();
  mat.transparent = false;
  mat.depthTest = false;
  mat.depthWrite = false;
  mat.blending = THREE.NoBlending;

  // Sampling proxy — assigned per frame to whichever HDR target the frame
  // composited into (rt or rtB; SpaceRenderer ping-pongs).
  const srcNode = texture(new THREE.Texture());

  mat.fragmentNode = Fn(() => {
    const p = uv();
    // ⚠ MUST read the PRE-EXPOSURE buffer. Metering the exposed image would be a
    // feedback loop that settles wherever the tone curve's fixed point happens
    // to be, which is not a measurement of anything.
    // ── TILE AVERAGE, not a point sample (defect D31) ─────────────────────────
    // This used to be a single `srcNode.sample(p)` per output texel — one bilinear
    // tap standing in for a whole tile of the frame (30×30 screen px at 1920 wide,
    // more on a Retina buffer). Two measured symptoms:
    //
    //  1. THE SUN WAS NOT METERED AT ALL. `EV max` read 5.3 (≈4.9 game units,
    //     Earth's cloud highlights) while the sun disc is 265,000 game units =
    //     EV 21. A ~3 px disc has roughly a 10% chance of landing on any given
    //     tap, so looking straight at the sun cost no adaptation whatsoever.
    //  2. THE READING DEPENDED ON DISPLAY RESOLUTION. The same pose measured
    //     `EV max` 6.55 on a Retina XDR buffer and 5.60 at 1920×1080 — ~1 stop
    //     apart. A measurement of the SCENE must not be a function of the
    //     drawing-buffer size.
    //
    // Both are the same aliasing bug, and the latent third symptom is worse: when
    // a small bright feature DOES happen to hit a tap, the reading jumps ~15
    // stops, so exposure would flicker as the camera drifts sub-pixel.
    //
    // 🔑 Stratified taps make the tile mean an UNBIASED estimator at any
    // resolution. One tap is unbiased too — in expectation — but with enormous
    // variance, and that variance IS the flicker. TILE_TAPS² taps spread evenly
    // over the tile cut the variance ~TILE_TAPS²-fold (16× in stddev at 16 taps)
    // without needing to know the source resolution: the offsets are computed in
    // UV, so they cover the tile whatever its pixel size.
    //
    // ⚠ The average MUST be of LINEAR luma, taken BEFORE the log2 below. Avering
    // the per-tap EVs would be a geometric mean, which under-weights exactly the
    // hot features this whole pass exists to see — the same class of error as the
    // log-average estimator that read 21 stops low (§5.9).
    const tileOrigin = p.mul(float(GRID)).floor().div(float(GRID));
    const tapStep = float(1 / (GRID * TILE_TAPS));
    const lumaSum = float(0).toVar();
    Loop(TILE_TAPS, ({ i }: { i: Node }) => {
      Loop(TILE_TAPS, ({ i: j }: { i: Node }) => {
        const off = vec2(
          float(i).add(0.5).mul(tapStep),
          float(j).add(0.5).mul(tapStep),
        );
        const t = srcNode.sample(tileOrigin.add(off));
        lumaSum.addAssign(
          t.r.mul(0.2126).add(t.g.mul(0.7152)).add(t.b.mul(0.0722)),
        );
      });
    });
    const c = lumaSum.div(float(TILE_TAPS * TILE_TAPS));
    // Photopic luma. `max` against a floor keeps log2 finite in true black —
    // 1e-8 game units is ~6e-5 cd/m², two decades below the scotopic threshold,
    // so it can never pull the mean up out of a legitimately black frame.
    // ⚠ FLOOR MUST SIT BELOW THE SKY. It was 1e-8, and the rescaled skybox is
    // 9.6e-9 game units — so the clamp was flattening the ENTIRE void to one
    // value and the reported distribution read p05 = p50 = p90 = p98 = −23.56,
    // destroying the star/sky contrast the metering needs to see. 1e-11 is
    // 6e-8 cd/m², three decades below the scotopic threshold, so it can only
    // ever catch true black.
    const luma = max(c, float(1e-11));
    // Same EV100 convention as photometry.ts: EV = log2(L · 8).
    const ev = log2(luma.mul(8));
    // Centre weight: Gaussian in radius (r = 1 at the frame corner), floored so
    // the periphery is never fully ignored. Foveal, like the eye's adaptation —
    // and necessary, because without it a centred planet loses the weighted
    // percentile to the void around it.
    const r = length(p.sub(vec2(0.5, 0.5))).mul(float(1 / 0.7071));
    const w = max(
      r.mul(r).div(float(-2 * CENTRE_SIGMA * CENTRE_SIGMA)).exp(),
      float(EDGE_WEIGHT),
    );
    // R = EV, G = weight. Kept UNPREMULTIPLIED so the CPU can compute both a
    // weighted mean AND percentiles from the same readback.
    return vec4(ev, w, 0, 1);
  })();

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  mesh.frustumCulled = false;
  _scene = new THREE.Scene();
  _scene.add(mesh);
  _camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  _sourceTex = srcNode as unknown as { value: THREE.Texture | null };

  // ── The local-adaptation map: a bilateral blur of the metering grid ────────
  // ⚠ LinearFilter, unlike the metering target's Nearest: this one is sampled at
  // SCREEN resolution, so each cell is stretched over ~30 px and nearest would make
  // the local gain visibly blocky.
  _blurRt = new RenderTarget(GRID, GRID, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  _blurRt.texture.colorSpace = THREE.NoColorSpace;

  const blurMat = new NodeMaterial();
  blurMat.transparent = false;
  blurMat.depthTest = false;
  blurMat.depthWrite = false;
  blurMat.blending = THREE.NoBlending;
  const blurSrc = texture(_rt.texture);
  const TAPS = 2 * LOCAL_BLUR_RADIUS + 1;
  blurMat.fragmentNode = Fn(() => {
    const p = uv();
    // R is already log2(luma·8) — a GEOMETRIC local mean, which is the right domain
    // for a display gain. (⚠ Not the same call as the ESTIMATOR's: adaptation needs
    // a linear flux mean, §5.9, but this term is tone mapping and log is standard.)
    const centre = blurSrc.sample(p).r.toVar();
    const acc = float(0).toVar();
    const wsum = float(0).toVar();
    Loop(TAPS, ({ i }: { i: Node }) => {
      Loop(TAPS, ({ i: j }: { i: Node }) => {
        const dx = float(i).sub(float(LOCAL_BLUR_RADIUS));
        const dy = float(j).sub(float(LOCAL_BLUR_RADIUS));
        const e = blurSrc.sample(p.add(vec2(dx, dy).mul(float(1 / GRID)))).r;
        const ws = dx
          .mul(dx)
          .add(dy.mul(dy))
          .div(float(-2 * LOCAL_SPATIAL_SIGMA * LOCAL_SPATIAL_SIGMA))
          .exp();
        const d = e.sub(centre);
        const wr = d
          .mul(d)
          .div(float(-2 * LOCAL_RANGE_SIGMA_STOPS * LOCAL_RANGE_SIGMA_STOPS))
          .exp();
        const w = ws.mul(wr);
        acc.addAssign(e.mul(w));
        wsum.addAssign(w);
      });
    });
    return vec4(acc.div(max(wsum, float(1e-6))), 0, 0, 1);
  })();

  const blurMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blurMat);
  blurMesh.frustumCulled = false;
  _blurScene = new THREE.Scene();
  _blurScene.add(blurMesh);
  _blurSrcTex = blurSrc as unknown as { value: THREE.Texture | null };
  _blurSrcTex.value = _rt.texture;
  _localMapTex.value = _blurRt.texture;
  _initialised = true;
}

/**
 * Per-pixel local-exposure gain, to be multiplied into the composite ALONGSIDE the
 * global exposure. Both are display-mapping terms and belong on the same side of
 * the tone curve. (This used to say "BEFORE bloom, because bloom's threshold is a
 * display-referred test" — bloom is gone and a physical PSF has no threshold.)
 *
 * Returns 1.0 exactly while `uLocalStrength` is 0 (map not yet built, or disabled),
 * so wiring it up is a bit-exact no-op until it has something to say.
 */
export function localExposureNode() {
  // Stops this neighbourhood sits ABOVE the global reference. Positive ⇒ a bright
  // subject the global meter under-read because it did not fill the frame.
  const excess = _localMapNode.sample(uv()).r.sub(uLocalRefEv);
  const darken = min(
    max(excess, float(0)).mul(uLocalStrength),
    float(LOCAL_MAX_DARKEN_STOPS),
  );
  const brighten = min(
    max(excess.negate(), float(0)).mul(float(LOCAL_SHADOW_STRENGTH)),
    float(LOCAL_MAX_DARKEN_STOPS),
  );
  return exp2(brighten.sub(darken));
}

/**
 * The whole blurred local-adaptation map, as a GRID×GRID array of pre-exposed EVs,
 * row 0 = BOTTOM of the screen (the GPU readback convention).
 *
 * 🔑 WHY THIS EXISTS. `readLocalGain` at frame centre is flip-invariant, so it cannot
 * catch the one bug that would ruin this feature silently: a vertical flip between
 * `uv()` in the metering pass and `uv()` in the composite would darken the MIRROR of
 * wherever the bright subject is. Printing the map is the only check that sees it —
 * and it also shows at a glance whether the bilateral term is holding an edge or
 * smearing the subject into the sky. Diagnose with the picture, not with theory.
 */
export async function readLocalMapGrid(
  renderer: WebGPURenderer,
): Promise<{ grid: number[][]; refEv: number } | null> {
  if (!_blurRt || !_localMapReady) return null;
  const buf = await renderer.readRenderTargetPixelsAsync(_blurRt, 0, 0, GRID, GRID);
  const isHalf = buf instanceof Uint16Array;
  const a = buf as unknown as ArrayLike<number>;
  const bpe = isHalf ? 2 : buf instanceof Uint8Array ? 1 : 4;
  // ⚠ 256-byte row padding, the same trap as everywhere else in this codebase.
  const stride = Math.ceil((GRID * 4 * bpe) / 256) * (256 / bpe);
  const grid: number[][] = [];
  for (let row = 0; row < GRID; row++) {
    const out: number[] = [];
    for (let col = 0; col < GRID; col++) {
      const i = row * stride + col * 4;
      out.push(isHalf ? halfToFloat(a[i]) : a[i]);
    }
    grid.push(out);
  }
  return { grid, refEv: uLocalRefEv.value };
}

/** Runtime A/B for `__lum.localExposure()`. `null` restores the derived default. */
export function setLocalExposure(enabled: boolean, strength?: number): void {
  _localEnabled = enabled;
  _localStrengthOverride = strength ?? null;
}

export function localExposureStatus() {
  return {
    enabled: _localEnabled,
    strength: uLocalStrength.value,
    derivedStrength: ADAPTATION_K,
    overridden: _localStrengthOverride !== null,
    referenceEv: uLocalRefEv.value,
    mapReady: _localMapReady,
    cellPx: GRID,
    blurRadiusCells: LOCAL_BLUR_RADIUS,
    rangeSigmaStops: LOCAL_RANGE_SIGMA_STOPS,
    shadowStrength: LOCAL_SHADOW_STRENGTH,
  };
}


/**
 * The local gain the SHADER would apply at a screen UV — read back from the actual
 * blurred map, not recomputed.
 *
 * ⚠ `__lum.meter()` needs this: its `display-lin` column is `radiance × exposure`,
 * and with local exposure live that is no longer the whole story. A gate that
 * re-derived the gain from its own copy of the formula would agree with itself
 * while disagreeing with the frame — the same trap as the star-capture witness.
 */
export async function readLocalGain(
  renderer: WebGPURenderer,
  u = 0.5,
  v = 0.5,
): Promise<number> {
  if (!_blurRt || !_localMapReady || uLocalStrength.value === 0) return 1;
  const x = Math.min(GRID - 1, Math.max(0, Math.round(u * GRID - 0.5)));
  const y = Math.min(GRID - 1, Math.max(0, Math.round(v * GRID - 0.5)));
  const buf = await renderer.readRenderTargetPixelsAsync(_blurRt, x, y, 1, 1);
  const isHalf = buf instanceof Uint16Array;
  const a = buf as unknown as ArrayLike<number>;
  const localEv = isHalf ? halfToFloat(a[0]) : a[0];
  const excess = localEv - uLocalRefEv.value;
  const darken = Math.min(
    Math.max(excess, 0) * uLocalStrength.value,
    LOCAL_MAX_DARKEN_STOPS,
  );
  const brighten = Math.min(
    Math.max(-excess, 0) * LOCAL_SHADOW_STRENGTH,
    LOCAL_MAX_DARKEN_STOPS,
  );
  return Math.pow(2, brighten - darken);
}

// ── binary16 decode (same two traps as `__lum`: raw bits + 256-byte rows) ────
function halfToFloat(h: number): number {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1f) return f ? NaN : (s ? -1 : 1) * Infinity;
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

/**
 * One adaptation step. Call once per frame from SpaceRenderer, AFTER the frame
 * has composited into `source` and BEFORE the post chain reads `uExposure`.
 *
 * The readback is fire-and-forget: this never awaits the GPU. The adaptation
 * filter runs on the most recent completed sample, so a 1–2 frame latency is
 * invisible against time constants of 0.25–6 s. Stalling the pipeline to be
 * "current" would cost far more than it buys.
 */
export function updateExposureMeter(
  renderer: WebGPURenderer,
  source: THREE.Texture,
  dtSec: number,
): void {
  if (!_initialised) build(renderer);
  if (!_rt || !_scene || !_camera) return;

  // ⚠⚠ THE MAPS RENDER UNCONDITIONALLY, INCLUDING WHILE EXPOSURE IS PINNED. This
  // used to early-return on `isManualExposure()`, which was right when the only
  // product was a global scalar: pinning meant nothing needed measuring. It is wrong
  // now — `__lum`/`__bench` pin the GLOBAL exposure but the LOCAL map still has to
  // describe the CURRENT frame, and a stale map would silently apply the previous
  // pose's gain to every pinned measurement. Only the readback and the adaptation
  // filter are gated below.
  _sourceTex.value = source;
  const prevTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(_rt);
  renderer.render(_scene, _camera);
  if (_blurRt && _blurScene) {
    renderer.setRenderTarget(_blurRt);
    renderer.render(_blurScene, _camera);
    _localMapReady = true;
  }
  renderer.setRenderTarget(prevTarget);

  // ── Publish the reference the local map is measured against ────────────────
  // 🔑 BOTH SIDES MUST BE IN THE SAME PRE-EXPOSED UNITS, and that is why this is set
  // HERE rather than read from a getter in the shader. The map stores
  // log2(preExposedLuma·8) as rendered THIS frame; `_lastMeteredEV` is ABSOLUTE
  // (the readback subtracted its own frame's pre-exposure). Adding back the CURRENT
  // pre-exposure makes the difference `excess` a pure ratio in which pre-exposure
  // cancels — the D25 discipline applied to a comparison rather than a value.
  uLocalRefEv.value =
    _lastMeteredEV + Math.log2(Math.max(getPreExposure(), 1e-30));
  uLocalStrength.value =
    _localEnabled && _localMapReady
      ? (_localStrengthOverride ?? ADAPTATION_K)
      : 0;

  // ── The retina's GLOBAL term: rod bleaching (Phase 7, scotopic.ts) ─────────
  // ⚠ SET ABOVE THE PIN, for the same reason the local map renders above it: every
  // gate written to validate Phase 7 pins exposure, and a term frozen below this
  // return would silently hold the previous pose's value while being measured.
  //
  // ⚠⚠ `_adaptedEV` is NOT the adapting luminance. It is the PARTIALLY-adapted
  // display EV — deliberately only (1 − k) = 15% of the real scene variation. Rod
  // bleaching depends on the light the eye actually RECEIVED, so the compression
  // has to be inverted. The inversion is exact because the follower is a linear
  // low-pass of an affine function: lowpass(A + k·m) = A + k·lowpass(m), so
  //     sceneEV = ANCHOR_EV + (_adaptedEV − ANCHOR_EV) / ADAPTATION_K
  // ⚠ GAME-UNIT EV throughout this file, log2(units·8) — 12.56 stops off the cd/m²
  // EV100 the `__lum` tables print. Confusing them here is a 6,038× error.
  updateScotopicUniforms(
    (2 ** (ANCHOR_EV + (_adaptedEV - ANCHOR_EV) / ADAPTATION_K) / 8) *
      NITS_PER_GAME_UNIT,
  );

  if (isManualExposure()) return; // global exposure is pinned by `__lum` / `__bench`

  if (!_readPending) {
    _readPending = true;
    // ── D25: undo this frame's source pre-exposure ────────────────────────────
    // `source` holds PRE-EXPOSED radiance, and the downsample shader stores
    // log2(luma·8) — so the pre-exposure appears as a pure OFFSET of log2(preExp)
    // on every sampled EV, and removing it is one subtraction. This is not
    // optional: metering the pre-exposed buffer means metering our own output,
    // and the loop (brighter reading → more exposure → brighter reading) diverges
    // until it hits EV_MAX.
    //
    // Captured HERE, at submit time, not read in the callback: the readback is
    // async, so by the time it resolves `getPreExposure()` may already belong to
    // a later frame. `_readPending` guarantees only one is ever in flight, so a
    // single tag is sufficient.
    const preExpLog2 = Math.log2(Math.max(getPreExposure(), 1e-30));
    void renderer
      .readRenderTargetPixelsAsync(_rt, 0, 0, GRID, GRID)
      .then((buf) => {
        _readPending = false;
        const isHalf = buf instanceof Uint16Array;
        const a = buf as unknown as ArrayLike<number>;
        const bpe = isHalf ? 2 : buf instanceof Uint8Array ? 1 : 4;
        // Rows are padded to a 256-byte stride — the trap that shipped broken in
        // `__lum` (LIGHTING_PLAN §5.2). Never index linearly by width×4.
        const stride = Math.ceil((GRID * 4 * bpe) / 256) * (256 / bpe);
        const samples: Array<[number, number]> = [];
        let totalW = 0;
        for (let row = 0; row < GRID; row++) {
          for (let col = 0; col < GRID; col++) {
            const i = row * stride + col * 4;
            const evRaw = isHalf ? halfToFloat(a[i]) : a[i];
            const w = isHalf ? halfToFloat(a[i + 1]) : a[i + 1];
            if (!Number.isFinite(evRaw) || !Number.isFinite(w) || w <= 0) continue;
            // Back to ABSOLUTE game-unit EV (see preExpLog2 above).
            samples.push([evRaw - preExpLog2, w]);
            totalW += w;
          }
        }
        if (samples.length === 0 || totalW <= 0) return;
        // ── Weighted percentile band ────────────────────────────────────────
        // Sort by EV, walk the cumulative WEIGHT (not the sample count — the
        // centre weight is the whole point), and average the EVs whose weight
        // falls inside [LO, HI]. A weighted MEAN here is what read 21 stops low
        // on device; the band is what makes a lit subject beat a black void.
        samples.sort((x, y) => x[0] - y[0]);
        // Weighted mean of LINEAR radiance. EV → radiance is 2^ev/8 (the inverse
        // of the shader's log2(luma·8)), so this reconstructs flux exactly.
        let den = 0;
        let totalFlux = 0;
        for (const [ev, w] of samples) {
          totalFlux += Math.pow(2, ev) * 0.125 * w;
          den += w;
        }

        // ── HOT-TAIL CAP (defect D26) ─────────────────────────────────────────
        // A weighted mean of linear flux is the physically right estimator — the
        // eye adapts to the flux arriving, not to a log-average of it — but it is
        // also MAXIMALLY sensitive to a single hot sample. One 6,038 cd/m² engine
        // plume covering 1% of a deep-space frame (where everything else is
        // ~1e-8) owns the mean outright, which is what made the scene "go
        // completely black except for the ship".
        //
        // ⚠ NO estimator can single out the ship, and it is worth being explicit
        // about why: the exhaust at 1.0 game units and Earth's sunlit disc at 0.43
        // are the SAME order of brightness and can occupy the SAME small screen
        // area. They are genuinely indistinguishable to a meter. So the goal here
        // is NOT identification — it is a BOUND: no small part of the visual field
        // may hold unlimited authority over adaptation.
        //
        // That bound is also the more defensible model of the eye. Adaptation is
        // spatially distributed and dominated by where you are foveating; a small
        // bright source in the periphery does not fully reset your night vision,
        // which a pure flux mean says it should.
        //
        // The hot tail is defined by WEIGHT, not sample count, because the
        // centre-weighted Gaussian means a centre sample counts for ~50× an edge
        // one — and the player's vehicle sits dead centre, exactly where a
        // count-based percentile would under-measure it.
        const hotWeightTarget = den * HOT_WEIGHT_FRACTION;
        let hotWeight = 0;
        let hotFlux = 0;
        for (let i = samples.length - 1; i >= 0 && hotWeight < hotWeightTarget; i--) {
          hotWeight += samples[i][1];
          hotFlux += Math.pow(2, samples[i][0]) * 0.125 * samples[i][1];
        }
        const restFlux = Math.max(0, totalFlux - hotFlux);
        // Solve hot/(hot+rest) ≤ S for hot: hot ≤ S/(1−S) · rest.
        const hotCap = (MAX_HOT_FLUX_SHARE / (1 - MAX_HOT_FLUX_SHARE)) * restFlux;
        // ⚠ SOFT compression, not a hard `min()`. A hard cap is NON-MONOTONIC:
        // above the cap `hotUsed` is constant, so making a hot feature brighter
        // changes the reading not at all. MEASURED consequence — turning to put the
        // SUN in frame made the metered EV go DOWN (0.46 → −1.95) and exposure UP,
        // because the sun is a few pixels, landed wholly in the hot tail, and was
        // truncated to a constant while the subject slid off-centre. The one thing
        // that genuinely SHOULD dominate adaptation was what the cap discarded
        // hardest.
        //
        // A power law fixes it while keeping the influence bounded in practice:
        //   continuous at hotFlux = hotCap, strictly MONOTONIC (brighter hot
        //   feature always ⇒ brighter reading), and UNBOUNDED, so the sun still
        //   drives adaptation — but compressed, so a 10⁶× overshoot contributes
        //   10^(6·0.25) ≈ 32×, not 10⁶×.
        const hotUsed =
          hotFlux <= hotCap
            ? hotFlux
            : hotCap * Math.pow(hotFlux / hotCap, HOT_COMPRESS_EXPONENT);
        const num = restFlux + hotUsed;
        // Report the UNCAPPED share — the diagnostic's job is to reveal that a hot
        // feature exists, not to hide it once the cap has tamed it.
        _lastTopFluxShare = totalFlux > 0 ? hotFlux / totalFlux : 0;
        // How many stops the CAP moved the final reading — i.e. how much higher
        // exposure is than a raw flux mean would have chosen. Deliberately NOT
        // log2(hotFlux/hotCap), which is the tail's own attenuation and reads
        // larger; the number that matters is the effect on the metered EV.
        // Bounded by log2(1/(1−MAX_HOT_FLUX_SHARE)) = 0.51 stops at S = 0.3.
        // TWO different numbers, and conflating them is a mistake I shipped twice:
        //  • `hotClipStops` = how far the compressor pulled the reading DOWN from an
        //    uncapped flux mean. UNBOUNDED by design — that is the point of it.
        //  • `hotLiftStops` = how much the hot tail lifted the reading ABOVE the
        //    rest-only reading. THIS is the bounded one, ≤ log2(1/(1−S)) only while
        //    the tail is under the cap; the power law lets it grow slowly past that.
        _lastHotClipStops = num > 0 ? Math.log2(totalFlux / num) : 0;
        _lastHotLiftStops = restFlux > 0 ? Math.log2(num / restFlux) : 0;
        // ── p = 2: the flux-weighted mean luminance (D33) ─────────────────────
        // Same hot-tail machinery, re-derived on the second moment. ⚠ THE ONE REAL
        // DIFFERENCE: the compression factor `g` is applied to the hot tail's
        // contribution to BOTH sums, not just the numerator. That is what makes the
        // cap actually bound the hot region's influence on the ANSWER — leaving
        // `hotN` un-attenuated would let the plume own the denominator and drag the
        // reading back down to its own luminance, which is the bound failing open.
        // (The p = 1 path above is left EXACTLY as shipped so the A/B is clean.)
        let m2 = 0;
        let n2 = 0;
        for (const [ev, w] of samples) {
          const L = Math.pow(2, ev) * 0.125;
          m2 += L * L * w;
          n2 += L * w;
        }
        let hotM2 = 0;
        let hotN2 = 0;
        let hw2 = 0;
        for (let i = samples.length - 1; i >= 0 && hw2 < hotWeightTarget; i--) {
          const L = Math.pow(2, samples[i][0]) * 0.125;
          hw2 += samples[i][1];
          hotM2 += L * L * samples[i][1];
          hotN2 += L * samples[i][1];
        }
        const restM2 = Math.max(0, m2 - hotM2);
        const restN2 = Math.max(0, n2 - hotN2);
        const cap2 = (MAX_HOT_FLUX_SHARE / (1 - MAX_HOT_FLUX_SHARE)) * restM2;
        // cap2 = 0 means 2% of weight holds ALL the flux — there is nothing to
        // compress against, so pass it through rather than evaluating 0 · ∞.
        const used2 =
          cap2 <= 0 || hotM2 <= cap2
            ? hotM2
            : cap2 * Math.pow(hotM2 / cap2, HOT_COMPRESS_EXPONENT);
        const g2 = hotM2 > 0 ? used2 / hotM2 : 1;
        const den2 = restN2 + g2 * hotN2;

        // ── "pooled": foveally-weighted soft-max over CELLS ───────────────────
        // The foveal weight enters as a STOP ATTENUATION of the cell's stimulus
        // (`ev + log2(w)`), not as an averaging weight: the question is "how bright
        // is the brightest thing I am looking AT", and w is how much of the retina's
        // adaptation this cell commands. Edge cells (w = EDGE_WEIGHT) are therefore
        // discounted log2(0.25) = 2 stops rather than excluded.
        //
        // 🔑 NO ORIENTATION QUESTION HERE, and that is deliberate. The weight is READ
        // from the map's G channel, which the metering shader wrote in the same pass
        // as R — so the two can never desync. Recomputing the Gaussian from row/col
        // on the CPU would have made this depend on the readback's row order, which
        // is exactly the flip bug that broke the per-pixel version.
        let evTop = -Infinity;
        for (const [ev, w] of samples) {
          const e = ev + Math.log2(w);
          if (e > evTop) evTop = e;
        }
        // ⚠ THE WEIGHT SELECTS, IT DOES NOT DISTORT. Cells are RANKED by the
        // attenuated stimulus `ev + log2(w)` — so a central subject beats a brighter
        // peripheral one — but the pooled value averages the cells' ACTUAL `ev`.
        // Averaging the attenuated value instead re-introduces a coverage term with
        // the sign flipped: a disc spanning centre to edge samples w from 1 down to
        // EDGE_WEIGHT, so its mean attenuation grows with its size and a big disc
        // would meter ~0.4 stops low. Selecting on one quantity and reporting another
        // is the whole trick, and it makes this exactly coverage-independent.
        let poolAcc = 0;
        let poolW = 0;
        let poolCells = 0;
        for (const [ev, w] of samples) {
          if (ev + Math.log2(w) >= evTop - POOL_WINDOW_STOPS) {
            poolAcc += ev * w;
            poolW += w;
            poolCells++;
          }
        }
        _lastEvPooled = poolW > 0 ? poolAcc / poolW : evTop;
        _lastPoolCells = poolCells;

        _lastEvArea = den > 0 ? Math.log2(Math.max(num / den, 1e-14) * 8) : ANCHOR_EV;
        _lastEvFlux =
          den2 > 0 ? Math.log2(Math.max((restM2 + used2) / den2, 1e-14) * 8) : ANCHOR_EV;
        if (den > 0) {
          _lastMeteredEV =
            ESTIMATOR === "pooled"
              ? _lastEvPooled
              : ESTIMATOR === "flux"
                ? _lastEvFlux
                : _lastEvArea;
          _lastSampleCount = samples.length;
        }
        // Weighted percentiles, for diagnostics only.
        const at = (frac: number): number => {
          let a2 = 0;
          for (const [ev, w] of samples) {
            a2 += w;
            if (a2 / totalW >= frac) return ev;
          }
          return samples[samples.length - 1][0];
        };
        _lastDist = {
          p05: at(0.05), p50: at(0.5), p90: at(0.9), p98: at(0.98),
          max: samples[samples.length - 1][0],
        };
      })
      .catch(() => {
        _readPending = false;
      });
  }

  // ── Adaptation ────────────────────────────────────────────────────────────
  const target = adaptationTarget(_lastMeteredEV);
  // Asymmetric: brighter is fast, darker is slow and slower still in scotopic.
  let tau: number;
  if (target > _adaptedEV) {
    tau = TAU_BRIGHTEN; // scene brightened → exposure must drop → fast
  } else {
    // Blend cone → rod by how far into scotopic the TARGET sits.
    const t = THREE.MathUtils.clamp(
      (ANCHOR_EV - target) / (ANCHOR_EV - MESOPIC_EV),
      0,
      1,
    );
    tau = THREE.MathUtils.lerp(TAU_DARKEN_CONE, TAU_DARKEN_ROD, t);
  }
  // Exponential follower, frame-rate independent.
  const alpha = 1 - Math.exp(-Math.max(dtSec, 1e-4) / tau);
  _adaptedEV += (target - _adaptedEV) * alpha;
  // Lower EV = higher exposure, so the bias is SUBTRACTED to brighten.
  setMeteredEV(
    THREE.MathUtils.clamp(_adaptedEV - EXPOSURE_BIAS_STOPS, EV_MIN, EV_MAX),
  );
}

/** Snap adaptation to the current scene — for warps/teleports (no slow fade). */
export function resetExposureAdaptation(): void {
  _adaptedEV = adaptationTarget(_lastMeteredEV);
  setMeteredEV(
    THREE.MathUtils.clamp(_adaptedEV - EXPOSURE_BIAS_STOPS, EV_MIN, EV_MAX),
  );
}

export function disposeExposureMeter(): void {
  _rt?.dispose();
  _blurRt?.dispose();
  _blurRt = null;
  _blurScene = null;
  _localMapReady = false;
  uLocalStrength.value = 0;
  _rt = null;
  _scene = null;
  _camera = null;
  _initialised = false;
  _readPending = false;
}

export { evFromGameUnits };
