// ─────────────────────────────────────────────────────────────────────
// VEILING GLARE — a point-spread function for the human eye. Phase 8, defect D12.
//
// Replaces `bloom(exposed, 0.001, 0, 1)`: strength 0.001, **radius 0**, additive.
// A Gaussian mip chain at radius 0 cannot represent the glare of a 1.6e9 cd/m²
// point source, and additive-on-top is the wrong composite (see ENERGY below).
//
// ── WHAT THIS IS PHYSICALLY ─────────────────────────────────────────────────
// A few percent of the light entering a human eye never reaches the retinal
// point it was aimed at. It scatters — in the cornea, the crystalline lens, the
// vitreous, and off the fundus — and lands as a broad haze over the whole retinal
// image. That haze is **veiling glare**, and it is why you cannot see stars with
// the sun in view, why oncoming headlights erase the road, and why a bright
// window makes a dim room look flat.
//
// 🔑 THIS IS THE THING THAT MAKES A CLIPPED SUN READ AS *BLINDING*. The display
// cannot show 1.6e9 cd/m²; it clips to white either way. What communicates
// "unbearably bright" is not the disc — it is the veil the disc throws over
// everything else. §3.9c of the plan: the requirement "stars brightly visible
// unless something really bright is in the view" is PRODUCED BY THIS, not art
// directed.
//
// ── THE SHAPE IS DERIVED, AND IT IS A SUM OF TWO POWER LAWS ─────────────────
// See `GLARE_CORE_CROSSOVER_DEG` below for the full derivation. Summary:
//
//     P(θ) = a/θ³ + b/θ²      θ in DEGREES,  b = 10 = the CIE straylight parameter
//                             of a normal young eye (Stiles–Holladay, verified),
//                             a = b·θc with θc the core/tail crossover.
//
// A steep core (the tight aureole hugging a bright silhouette) plus a shallow tail
// (the broad frame-wide veil). **Neither alone is enough**, and two single-exponent
// versions shipped and failed in opposite directions to prove it — θ⁻³ had no veil,
// θ⁻² had no aureole and read as detached fog.
//
// ⚠⚠ THE CIE 135/1-1999 (Vos & van den Berg) FORMULA IS RETAINED ONLY AS A
// DIAGNOSTIC (`cieGlareSpreadFunction`), AND IS NOT TRUSTED FOR EITHER MAGNITUDE OR
// SHAPE. As transcribed it integrates to ~3800% of the incident light (impossible),
// and its first bracket sits **91× above the entire Stiles–Holladay value at 1°** —
// which ALSO forged a false θ⁻³ slope by swamping its own θ⁻² term. One over-scaled
// bracket, two wrong conclusions. Do not re-derive anything from it without a
// primary source.
//
// 🔑 WHY A MIP PYRAMID IS THE RIGHT DISCRETISATION ANYWAY: one mip level is one
// octave of angle, and for any power law the per-octave energy is analytic
// (`∝ 2^(2−n)`), so the weights are just the PSF's own energy per octave. For a
// Gaussian PSF a pyramid would be a poor fit; for a power law it is natural.
// ⚠ The per-octave ratio is NOT constant here — that is the whole point of the
// second term. It runs tight near the source and flat far from it.
//
// ── NO THRESHOLD, AND THAT HAS A CONSEQUENCE FOR PIPELINE ORDER ─────────────
// The eye scatters ALL light, not "light brighter than white". A physical PSF
// therefore has **no threshold** — and the moment the threshold goes, so does the
// reason bloom had to sit AFTER the exposure multiply (its threshold was a
// display-referred test, so it had to see post-exposure values). This pass runs on
// the raw pre-exposure scene buffer, in absolute game units, which is also where
// the scotopic driver reads.
//
// ── ENERGY: `mix`, NOT `add` ────────────────────────────────────────────────
//     out = (1 − k)·scene + k·PSF(scene)
// The scattered light is **REMOVED from where it was and put somewhere else**,
// because that is what scattering is. `scene + bloom` invents energy, which is why
// additive bloom has to be kept tiny to avoid washing out — and being tiny is
// exactly why it cannot veil. Redistribution can be strong without inventing
// anything, and the pyramid is built to preserve the mean so this is exact.
//
// `k` is the **integrated straylight fraction**: "in normal eyes, a few percent of
// all light entering the eye is scattered" (van den Berg et al., the straylight
// literature). ⚠ THIS IS THE ONE AUTHORED NUMBER, bounded by a citation rather
// than derived, and it is the only knob worth turning.
//
// ── IMPLEMENTATION: the Call of Duty pyramid, which is what AAA actually ships ─
// Jimenez, "Next Generation Post Processing in Call of Duty: Advanced Warfare"
// (SIGGRAPH 2014): a 13-tap downsample and a 3×3 tent upsample, progressive, no
// separable Gaussian per level. Chosen over the alternative AAA route — **Unreal's
// FFT convolution bloom**, which convolves against a real 256²–512² PSF kernel
// image and is the *most* physically direct option — because an FFT convolution is
// far outside this project's perf budget (§6: "no headroom at the deck").
//
// ✅ MEASURED, and it is not a wash — it is a WIN: `5a glare PSF` costs 0.9–1.3 ms
// while removing bloom drops `5 post` from ~9.5 to ~3.7 ms, for **−4.8 ms of GPU per
// frame across all 13 `__bench` scenarios**. ⚠ §6 estimated bloom at "1.8–2.0 ms";
// it was ~5.8 ms. Another entry in that doc's "estimates are 0 for N" ledger.
//
// ✅ THE P8d UNDER-DRIVE IS RESOLVED, AND NOT THE WAY P8d PROPOSED. R3,
// docs/STAR_RENDERING_PLAN.md §9. P8d said: the buffer clamps at 60,000 while the
// sun disc is ~3.1e5 game units, so reading the buffer under-drives the sun's
// glare; fix it with a star-flux splat path.
//
// ⚠⚠ THE PREMISE WAS ONLY SOMETIMES TRUE, AND NOBODY CHECKED WHICH. `Star.tsx`
// writes `discRadiance × preExposure`, so the clamp bites only below a metered EV
// that varies with range (EV 2.11 in the inner system, −2.97 at Neptune). Verify
// at a pose with `__lum.starGlare()` before quoting a number.
//
// 🔑 THE FIX NEEDED NO SPLAT PATH. `Star.tsx` now SPREADS the disc instead of
// clipping it — `renderPx = max(trueSize, pixelFloor, halfFloatCeiling)` with the
// radiance divided by the area ratio — so the flux is conserved and this pass reads
// the star's true flux straight out of the buffer. One `max` replaced a whole extra
// render path.
//
// ⚠ What WAS unambiguously wrong: the star's hand-authored corona injected **5.3×
// the star's entire physical flux** beyond ~5 AU, so this pass was over-driven at
// the very ranges P8d thought it was under-driven. Deleted in R3.
// ─────────────────────────────────────────────────────────────────────

import * as THREE from "three";
import { atan, float, length, mix, texture, uniform, uv, vec2, vec4 } from "three/tsl";
import { NodeMaterial, RenderTarget } from "three/webgpu";
import type { WebGPURenderer } from "three/webgpu";
import { PASS } from "./perf/perfProfiler";

/* eslint-disable @typescript-eslint/no-explicit-any */
/** TSL node. Repo-local alias — see `bodyEclipse.ts` / `planetshine.ts`. */
type U = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Octaves of angle to model.
 *
 * ⚠⚠ WAS 6, AND 6 WAS VISIBLY WRONG — the author reported the glare "first fades
 * out but then has almost a hard edge against dark space", and they were right.
 *
 * 🔑 THE MISTAKE, WHICH IS WORTH STATING PRECISELY BECAUSE THE REASONING *SOUNDED*
 * COMPLETE. I derived "one mip level = one octave of angle" from the GSF's θ⁻³
 * slope, checked that six octaves span 0.05°–3.2° and that they hold 97.7% of the
 * scattered energy, and shipped. But **the octave a WEIGHT describes and the
 * distance the TENT can actually carry light are two different quantities**, and I
 * only verified the first. The pyramid's reach is set by the coarsest mip's texel
 * size times the tent's ~1-texel spread:
 *
 *   MIP_COUNT   coarsest mip (2430×1816)   texel     tent reach
 *      6              37×28                1.35°       ~2.7°   ← shipped, WRONG
 *      8               9×7                 5.56°      ~11.1°
 *     10               2×1                25.0°       ~50.0°   ← now
 *
 * Beyond the reach the glare is **exactly zero**, so the veil ended in a step at
 * ~2.7°. What that produced was the *aureole* — the compact near-field glow that
 * carries 97.7% of the energy — with the far veil amputated. And the far veil is
 * the half that matters perceptually: it is the whole-field haze that raises the
 * floor and makes stars vanish. 97.7% of the ENERGY was present and ~0% of the
 * EFFECT this pass exists for.
 *
 * ⇒ **10.** Reaches ~50°, i.e. the whole frame. The four added levels are 19×14,
 * 9×7, 4×3 and 2×1 — together they carry only 2.1% of the energy and cost four
 * essentially free draws, but that 2.1% spread over the entire screen IS the veil.
 *
 * ⚠ Not a quality dial. Raising it re-derives the weights (`deriveGlareWeights`
 * keys off it), so the energy is re-normalised, not added.
 * ⚠ At 2×1 the "octave" abstraction has broken down and the level is effectively a
 * flat full-field floor. That is fine — it is what the GSF's far tail *is*.
 */
const MIP_COUNT = 10;

/**
 * Integrated straylight — the fraction of incident light that never reaches the
 * retinal point it was aimed at.
 *
 * ⚠ **THE ONE AUTHORED NUMBER IN THIS FILE.** Bounded by citation, not derived:
 * the straylight literature's "in normal eyes, a few percent of all light entering
 * the eye is scattered". 0.03 sits in the middle of "a few percent".
 *
 * 🔑 It is a REDISTRIBUTION fraction, not a gain, so raising it cannot brighten the
 * image — it can only move contrast from the source into the veil. That is why it
 * can be large enough to matter, unlike additive bloom's strength.
 */
export const GLARE_STRAYLIGHT_FRACTION = 0.03;

/**
 * Horizontal FOV assumed when reporting the pyramid's angular reach. ⚠ DIAGNOSTIC
 * ONLY — nothing in the pass depends on it; it exists so `__lum.glare()` can state
 * the reach in degrees instead of in texels.
 */
const GLARE_ASSUMED_FOV_DEG = 50;

/**
 * The CIE 135/1-1999 (Vos & van den Berg) glare spread function, θ in DEGREES.
 * Returns L_eq/E_gl. ⚠ Used for its SHAPE ONLY — see the header on why its absolute
 * magnitude is not trusted.
 *
 * @param ageYears observer age; the plan's target is a young dark-adapted observer
 * @param pigmentation iris: 0 very dark, 0.5 brown, 1.0 blue-green, 1.2 blue
 */
export function cieGlareSpreadFunction(
  thetaDeg: number,
  ageYears = 25,
  pigmentation = 1.0,
): number {
  const a = (ageYears / 70) ** 4;
  const p = pigmentation;
  const q = (x: number) => 1 + (thetaDeg / x) ** 2;
  const t1 =
    (1 - 0.08 * a) *
    (9.2e6 / q(0.046) ** 1.5 + 1.5e5 / q(0.045) ** 1.5);
  const t2 =
    (1 + 1.6 * a) *
    (400 / q(0.1) +
      3e-8 * thetaDeg * thetaDeg +
      p * (1300 / q(0.1) ** 1.5 + 0.8 / q(0.1) ** 0.5));
  return t1 + t2 + 2.5e-3 * p;
}

/**
 * ── THE PSF: A STEEP CORE PLUS A SHALLOW TAIL. NOT ONE POWER LAW. ───────────
 *
 *     P(θ) = a/θ³ + b/θ²        θ in DEGREES, P in 1/sr
 *     b = 10   the CIE straylight parameter of a normal young eye (log s ≈ 1.0),
 *              i.e. Stiles–Holladay — independently verified, NOT authored.
 *     a = b·θc  where θc is the core/tail crossover.
 *
 * ⚠⚠ TWO SINGLE-POWER-LAW VERSIONS SHIPPED AND BOTH FAILED, IN OPPOSITE WAYS. That
 * is the evidence that the model needed a second term, and it took the author
 * reporting both symptoms to see it:
 *
 *     n = 3  → near 87.6%, far 1.5%   "does not veil the whole screen"
 *     n = 2  → near 30.3%, far 39.4%  "creates a weird halo around the ship"
 *
 * 🔑 THE SECOND FAILURE IS THE INFORMATIVE ONE. At n = 2 the near field is STARVED
 * (30% where n=3 had 88%), so the glow does not decay away from a bright edge — it
 * **plateaus**, and a plateau reads as a detached halo or fog rather than as glare.
 * A real bright object throws BOTH a tight aureole hugging its silhouette AND a
 * broad faint veil, and **no single exponent can produce both**: the aureole needs
 * θ⁻³, the veil needs θ⁻². Trading one for the other is what the exponent knob was
 * really doing.
 *
 * ⇒ Sum them. The local slope then runs **−2.89 → −2.73 → −2.46 → −2.22 → −2.08**
 * from 0.1° to 30°, which is precisely how the eye's GSF is described in the
 * literature: *steeper than θ⁻² inside ~1°, θ⁻² over 1–30°*. It converges to
 * Stiles–Holladay at wide angles and sits a few × above it at 1°, where the core
 * lives. At θc = 2.3° the split is **aureole ≈80%, far veil ≈6.6%** — the aureole
 * back (no plateau, no fog) AND a veil ~4× stronger than n=3 managed.
 *
 * ⚠ **θc = 1.0° IS AUTHOR-JUDGED ON THIS MODEL** (aureole 72.9%, far veil 11.2%),
 * chosen after A/B against 3.0° in-game. An earlier draft used 2.3 because the author
 * had said "maybe 2.3 is a good middle ground" — but that was about EXPONENTS on the
 * previous single-power-law model, where the number meant something else entirely.
 * 🔑 **A tuning value does not survive a change of model, even when the parameter
 * keeps its name.** Re-ask, do not re-use.
 *
 * Measured splits (aureole ≤0.4° / far veil ≥3.2°): 1.0 → 72.9/11.2 ← shipped,
 * 1.5 → 76.9/8.5, 2.3 → 80.1/6.4, 3.0 → 81.7/5.4.
 *
 * 🔑 AND THIS IS THE STRUCTURE THE CIE FORMULA ALREADY HAD — bracket 1 the steep
 * core, bracket 2 the θ⁻² tail. Mis-scaling bracket 1 by 91× is what made it look
 * like a single θ⁻³ law. The fix was not a better exponent; it was noticing the
 * formula was a SUM.
 *
 * ⚠ `GLARE_CORE_CROSSOVER_DEG` is the ONE authored number in the shape (the
 * literature says "~1°"; 1.5° is inside that). It trades aureole against veil, so it
 * is the natural tuning knob — and unlike an exponent, **both ends stay physically
 * shaped.** Smaller = broader/hazier, larger = tighter/punchier.
 */
export const GLARE_CORE_CROSSOVER_DEG = 1.0;

/** CIE straylight parameter of a normal young eye — Stiles–Holladay's `s`. */
const GLARE_STRAYLIGHT_S = 10;

/** The two-term PSF, θ in degrees. */
export function glarePsf(thetaDeg: number, crossoverDeg = _crossover): number {
  const b = GLARE_STRAYLIGHT_S;
  const a = b * crossoverDeg;
  return a / thetaDeg ** 3 + b / thetaDeg ** 2;
}

/**
 * Per-mip weights = the PSF's energy in each octave of angle, normalised to sum 1
 * (which is what makes the `mix` composite energy-exact).
 *
 *     E_i = ∫ P(θ)·2π·sin θ dθ   over  [θ₀·2ⁱ, θ₀·2ⁱ⁺¹]
 *
 * ⚠ Numeric again, and it has to be: a SUM of power laws has no closed-form
 * per-octave ratio, which is exactly the point — the ratio varies across the
 * pyramid, tight near the source and flat far from it.
 */
/** Finest angle the pyramid models, degrees — the inner edge of octave 0. */
export const GLARE_THETA_MIN_DEG = 0.05;

function octaveEnergies(
  mipCount: number,
  crossoverDeg: number,
  theta0Deg: number,
): number[] {
  const D2R = Math.PI / 180;
  const e: number[] = [];
  for (let i = 0; i < mipCount; i++) {
    const lo = theta0Deg * 2 ** i;
    const hi = lo * 2;
    let acc = 0;
    const N = 1024;
    for (let j = 0; j < N; j++) {
      const th = lo + ((j + 0.5) * (hi - lo)) / N;
      acc +=
        glarePsf(th, crossoverDeg) *
        2 *
        Math.PI *
        Math.sin(th * D2R) *
        ((hi - lo) / N) *
        D2R;
    }
    e.push(acc);
  }
  return e;
}

export function deriveGlareWeights(
  mipCount = MIP_COUNT,
  crossoverDeg = _crossover,
  theta0Deg = GLARE_THETA_MIN_DEG,
): number[] {
  const e = octaveEnergies(mipCount, crossoverDeg, theta0Deg);
  const sum = e.reduce((x, y) => x + y, 0);
  return e.map((v) => v / sum);
}

/**
 * ∫P dΩ over the modelled range [0.05°, 51.2°], in (PSF units · sr).
 *
 * 🔑 Dividing the raw PSF by this gives a **density that integrates to 1 over the
 * same range the pyramid covers**, which is what lets an analytic point source
 * (R3b) and the pyramid be added together without double-counting or a scale
 * mismatch. Shares `octaveEnergies` with the weights on purpose — two copies of
 * this integral would be two chances to disagree.
 */
export function glarePsfEnergyTotal(
  crossoverDeg = _crossover,
  mipCount = MIP_COUNT,
  theta0Deg = GLARE_THETA_MIN_DEG,
): number {
  return octaveEnergies(mipCount, crossoverDeg, theta0Deg).reduce((x, y) => x + y, 0);
}

// ── Uniforms ────────────────────────────────────────────────────────────────
//
// 🔑 Gated on a uniform at 0, exactly like `uLocalStrength` and `uScotopicStrength`:
// the node-graph rebuild `useEffect` would recompile every shader on a settings
// toggle, and WebGPU shader-compilation stutter is a known problem here.
const uGlareStrength = /*#__PURE__*/ uniform(0);
const _glareTex = /*#__PURE__*/ texture(new THREE.Texture());

// ── R3b: analytic point-source glare ────────────────────────────────────────
// The pyramid can only scatter what is IN the scene buffer, and a star's disc is
// clipped there (half-float). This adds the CLIPPED flux back as a closed-form
// PSF about the star's screen position.
//
// 🔑 Why not splat it into the pyramid, which is what P8d proposed: the pyramid is
// half-float too. At 1 AU the deficit is ~8.5e7 (value·px²) and one `down[0]` texel
// holds 4 px², so a single-texel splat needs 2.1e7 and overflows. Spreading it to
// fit needs a 21×21 texel block = 42×42 full-res px — wider than the sun's own
// 11 px disc — so the "point source" would be a flat blob and the aureole's shape
// would be destroyed. Levels 0–4 would all need Float32. Analytically it is a
// handful of ALU ops, exact at every octave, and cannot overflow.
const uStarGlareRgb = /*#__PURE__*/ uniform(new THREE.Vector3(0, 0, 0));
const uStarUv = /*#__PURE__*/ uniform(new THREE.Vector2(-10, -10));
const uStarBufferPx = /*#__PURE__*/ uniform(new THREE.Vector2(1, 1));
const uStarTanPerPx = /*#__PURE__*/ uniform(1);
const uStarPsfA = /*#__PURE__*/ uniform(GLARE_STRAYLIGHT_S * GLARE_CORE_CROSSOVER_DEG);
const uStarPsfB = /*#__PURE__*/ uniform(GLARE_STRAYLIGHT_S);
/** deficitFlux ÷ frame pixels — see starPointGlarePedestal. */
let _pointPedestal = 0;

let _enabled = true;
// ⚠ Initialised FROM the exported constant, not a duplicated literal — the two
// drifted apart once already (the constant moved to 2.3 while this stayed 1.5, so
// the gate reported a crossover nobody had chosen).
let _crossover = GLARE_CORE_CROSSOVER_DEG;
let _userScale = 1;
let _strengthOverride: number | null = null;
let _weights = deriveGlareWeights();
/**
 * Cached ∫P dΩ. ⚠ `glarePsfEnergyTotal()` runs a 10 × 1024 numeric integral, so it
 * must NOT be called per frame — recomputed only where `_crossover` changes.
 */
let _psfEnergy = glarePsfEnergyTotal();

/** Cached ∫P dΩ over the modelled range. Safe to call every frame. */
export const getGlarePsfEnergy = (): number => _psfEnergy;
let _initialised = false;
let _ready = false;
let _lastPasses = 0;
const _bufSize = /*#__PURE__*/ new THREE.Vector2();

let _down: RenderTarget[] = [];
let _up: RenderTarget[] = [];
let _downScene: THREE.Scene | null = null;
let _upScene: THREE.Scene | null = null;
let _seedScene: THREE.Scene | null = null;
let _camera: THREE.OrthographicCamera | null = null;
let _downSrc: { value: THREE.Texture | null } | null = null;
let _downTexel: { value: THREE.Vector2 } | null = null;
let _upPrev: { value: THREE.Texture | null } | null = null;
let _upCur: { value: THREE.Texture | null } | null = null;
let _upTexel: { value: THREE.Vector2 } | null = null;
let _upWeight: { value: number } | null = null;
let _seedSrc: { value: THREE.Texture | null } | null = null;
let _seedWeight: { value: number } | null = null;

function makeRt(w: number, h: number): RenderTarget {
  const rt = new RenderTarget(Math.max(1, w), Math.max(1, h), {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    // ⚠ LinearFilter is load-bearing on BOTH chains: the downsample's 13 taps and
    // the upsample's tent both rely on hardware bilinear to be the filter they
    // claim to be. Nearest would turn the pyramid into a box-of-boxes.
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  rt.texture.colorSpace = THREE.NoColorSpace;
  rt.texture.wrapS = THREE.ClampToEdgeWrapping;
  rt.texture.wrapT = THREE.ClampToEdgeWrapping;
  return rt;
}

/**
 * ⚠ All three scenes carry `PASS.glare`, because the profiler attributes GPU time
 * by `scene.name`. Without it the 12 draws would be invisible to `__bench` — and §6
 * is explicit that this pass's cost must be ABLATED, never estimated ("the record
 * on estimates in this repo is 0 for 4"). An unmeasurable pass cannot be ablated.
 */
function fullscreen(mat: NodeMaterial): THREE.Scene {
  mat.transparent = false;
  mat.depthTest = false;
  mat.depthWrite = false;
  mat.blending = THREE.NoBlending;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.name = PASS.glare;
  scene.add(mesh);
  return scene;
}

function build(width: number, height: number): void {
  for (let i = 0; i < MIP_COUNT; i++) {
    const w = Math.max(1, width >> (i + 1));
    const h = Math.max(1, height >> (i + 1));
    _down.push(makeRt(w, h));
    _up.push(makeRt(w, h));
  }

  // ── DOWNSAMPLE: the 13-tap from Jimenez/CoD:AW ────────────────────────────
  // Four "corner" quads (weight 1/8 each via 0.5 groups), four edge midpoints and
  // a centre, arranged so that the result is a smooth, alias-resistant half-res
  // reduction. 🔑 The weights sum to 1 exactly, which is what keeps the whole
  // pyramid mean-preserving and therefore the `mix` composite energy-exact.
  const dSrc = texture(new THREE.Texture());
  const dTexel = uniform(new THREE.Vector2(1, 1));
  const dMat = new NodeMaterial();
  dMat.fragmentNode = (() => {
    const p = uv();
    const tx = dTexel;
    const s = (dx: number, dy: number): U =>
      dSrc.sample(p.add(vec2(dx, dy).mul(tx))).rgb;
    // The 13 taps, on a ±2-texel grid of the SOURCE:
    //     a . b . c          a,c,g,i  outer corners   ×0.03125
    //     . j . k .          b,d,f,h  edge midpoints  ×0.0625
    //     d . e . f          j,k,l,m  inner diagonals ×0.125
    //     . l . m .          e        centre          ×0.125
    //     g . h . i
    // ⚠ Sum written out so it stays auditable, because the pyramid is only
    // mean-preserving — and therefore the `mix` composite only energy-exact — if
    // this is EXACTLY 1: 0.125 + 4(0.125) + 4(0.0625) + 4(0.03125) = 1.0 ✅
    const centre = s(0, 0);
    const inner = s(-1, 1).add(s(1, 1)).add(s(-1, -1)).add(s(1, -1));
    const edges = s(-2, 0).add(s(2, 0)).add(s(0, 2)).add(s(0, -2));
    const corners = s(-2, 2).add(s(2, 2)).add(s(-2, -2)).add(s(2, -2));
    return vec4(
      centre
        .mul(0.125)
        .add(inner.mul(0.125))
        .add(edges.mul(0.0625))
        .add(corners.mul(0.03125)),
      1,
    );
  })();
  _downScene = fullscreen(dMat);
  _downSrc = dSrc as unknown as { value: THREE.Texture | null };
  _downTexel = dTexel as unknown as { value: THREE.Vector2 };

  // ── SEED: the coarsest level, weighted ────────────────────────────────────
  const sSrc = texture(new THREE.Texture());
  const sW = uniform(0);
  const sMat = new NodeMaterial();
  sMat.fragmentNode = vec4(sSrc.sample(uv()).rgb.mul(sW), 1);
  _seedScene = fullscreen(sMat);
  _seedSrc = sSrc as unknown as { value: THREE.Texture | null };
  _seedWeight = sW as unknown as { value: number };

  // ── UPSAMPLE: 3×3 tent on the coarser accumulator, plus this level's share ──
  // `out = tent(prev) + w_i · down_i`, so the finished chain is
  // `Σ w_i · (tent-upsampled down_i)` with the weights NOT compounding — the tent
  // is itself normalised (1/16 · [1 2 1; 2 4 2; 1 2 1]).
  const uPrev = texture(new THREE.Texture());
  const uCur = texture(new THREE.Texture());
  const uTexel = uniform(new THREE.Vector2(1, 1));
  const uW = uniform(0);
  const uMat = new NodeMaterial();
  uMat.fragmentNode = (() => {
    const p = uv();
    const t = (dx: number, dy: number): U =>
      uPrev.sample(p.add(vec2(dx, dy).mul(uTexel))).rgb;
    const tent = t(0, 0)
      .mul(4)
      .add(t(-1, 0).add(t(1, 0)).add(t(0, -1)).add(t(0, 1)).mul(2))
      .add(t(-1, -1).add(t(1, -1)).add(t(-1, 1)).add(t(1, 1)))
      .mul(1 / 16);
    return vec4(tent.add(uCur.sample(p).rgb.mul(uW)), 1);
  })();
  _upScene = fullscreen(uMat);
  _upPrev = uPrev as unknown as { value: THREE.Texture | null };
  _upCur = uCur as unknown as { value: THREE.Texture | null };
  _upTexel = uTexel as unknown as { value: THREE.Vector2 };
  _upWeight = uW as unknown as { value: number };

  _camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  _glareTex.value = _up[0].texture;
  _initialised = true;
}

function resize(width: number, height: number): void {
  for (let i = 0; i < MIP_COUNT; i++) {
    const w = Math.max(1, width >> (i + 1));
    const h = Math.max(1, height >> (i + 1));
    if (_down[i].width !== w || _down[i].height !== h) {
      _down[i].setSize(w, h);
      _up[i].setSize(w, h);
    }
  }
}

/**
 * Render the glare pyramid for this frame.
 *
 * ⚠ `source` must be the **pre-exposure** composited scene, in absolute game
 * units. A physical PSF has no threshold, so unlike bloom there is no reason to
 * feed it display-referred values — and feeding it exposed values would make the
 * veil a function of exposure, which is a feedback loop.
 *
 * Call from the frame loop next to `updateExposureMeter`, before `pipeline.render()`.
 */
export function updateGlare(
  renderer: WebGPURenderer,
  source: THREE.Texture,
): void {
  // ⚠ `source.image` is `{}` on a RenderTarget texture in three's types, so the
  // dimensions have to come off the renderer's drawing buffer, not the texture.
  const size = renderer.getDrawingBufferSize(_bufSize);
  const w = size.width;
  const h = size.height;
  if (!(w > 1 && h > 1)) return;
  if (!_initialised) build(w, h);
  else resize(w, h);
  if (!_downScene || !_upScene || !_seedScene || !_camera) return;

  const strength = _enabled
    ? (_strengthOverride ?? GLARE_STRAYLIGHT_FRACTION * _userScale)
    : 0;
  uGlareStrength.value = strength;
  // Bit-exact no-op when off: skip the passes entirely rather than render a
  // pyramid nobody reads. ⚠ `_ready` stays as-is so the composite keeps sampling a
  // valid texture; the strength uniform is what makes it not matter.
  if (strength <= 0) {
    _lastPasses = 0;
    return;
  }

  const prevTarget = renderer.getRenderTarget();
  let passes = 0;

  // Down: source → down[0] → down[1] → …
  let src = source;
  let srcW = w;
  let srcH = h;
  for (let i = 0; i < MIP_COUNT; i++) {
    _downSrc!.value = src;
    _downTexel!.value.set(1 / srcW, 1 / srcH);
    renderer.setRenderTarget(_down[i]);
    renderer.render(_downScene, _camera);
    passes++;
    src = _down[i].texture;
    srcW = _down[i].width;
    srcH = _down[i].height;
  }

  // Seed the accumulator at the coarsest level.
  _seedSrc!.value = _down[MIP_COUNT - 1].texture;
  _seedWeight!.value = _weights[MIP_COUNT - 1];
  renderer.setRenderTarget(_up[MIP_COUNT - 1]);
  renderer.render(_seedScene, _camera);
  passes++;

  // Up: up[i+1] (coarser) + down[i] → up[i]
  for (let i = MIP_COUNT - 2; i >= 0; i--) {
    _upPrev!.value = _up[i + 1].texture;
    _upCur!.value = _down[i].texture;
    // Tent offsets are in the COARSER level's texels — that is what makes it a
    // tent over the source rather than a box over the destination.
    _upTexel!.value.set(1 / _up[i + 1].width, 1 / _up[i + 1].height);
    _upWeight!.value = _weights[i];
    renderer.setRenderTarget(_up[i]);
    renderer.render(_upScene, _camera);
    passes++;
  }

  renderer.setRenderTarget(prevTarget);
  _glareTex.value = _up[0].texture;
  _ready = true;
  _lastPasses = passes;
}

/**
 * The energy-conserving composite: `(1 − k)·scene + k·PSF(scene)`.
 *
 * 🔑 `mix`, not `add`. Scattered light is REMOVED from where it was aimed and put
 * somewhere else — that is what scattering is, and it is why this can be strong
 * enough to actually veil without inventing energy the way additive bloom does.
 *
 * Returns `scene` bit-exactly while the strength uniform is 0.
 */
export function glareNode(scene: U): U {
  const veiled = mix(scene, vec4(_glareTex.sample(uv()).rgb, scene.a), uGlareStrength);

  // ── R3b: the star's clipped flux, added analytically ──
  // Radially symmetric in ANGLE, so the pixel offset has to go through the real
  // tangent-per-pixel and an `atan` — the small-angle form is 6.9% low at fov 50
  // and this term reaches tens of degrees.
  const d = uv().sub(uStarUv);
  const rPx = length(vec2(d.x.mul(uStarBufferPx.x), d.y.mul(uStarBufferPx.y)));
  const thetaDeg = atan(rPx.mul(uStarTanPerPx))
    .mul(180 / Math.PI)
    .max(float(GLARE_THETA_MIN_DEG));
  const psf = uStarPsfA
    .div(thetaDeg.mul(thetaDeg).mul(thetaDeg))
    .add(uStarPsfB.div(thetaDeg.mul(thetaDeg)));
  // ⚠ × uGlareStrength so this obeys the player's glare setting and vanishes with
  // it, exactly like the pyramid. `uStarGlareRgb` is 0 whenever nothing is
  // clipped, which makes the whole term a no-op without a branch.
  const point = uStarGlareRgb.mul(psf).mul(uGlareStrength);
  return vec4(veiled.rgb.add(point), veiled.a);
}

/**
 * Publish a star's clipped flux for the analytic term.
 *
 * `rgbScale` must already be `deficitFlux · ω_px / glarePsfEnergyTotal() · starColour`
 * — i.e. everything except the straylight fraction, which the shader applies.
 * Units: `deficitFlux` in (buffer value · px²), `ω_px = tanPerPx²` sr/px, so the
 * product is a buffer value. Pass `[0,0,0]` to disable.
 */
export function setStarPointGlare(
  uvX: number,
  uvY: number,
  rgbScale: readonly [number, number, number],
  tanPerBufferPx: number,
  bufferW: number,
  bufferH: number,
  deficitFlux: number,
): void {
  _pointPedestal =
    Number.isFinite(deficitFlux) && deficitFlux > 0
      ? deficitFlux / Math.max(bufferW * bufferH, 1)
      : 0;
  const ok =
    Number.isFinite(uvX) &&
    Number.isFinite(uvY) &&
    rgbScale.every((v) => Number.isFinite(v) && v >= 0);
  if (!ok) {
    uStarGlareRgb.value.set(0, 0, 0);
    return;
  }
  uStarUv.value.set(uvX, uvY);
  uStarBufferPx.value.set(bufferW, bufferH);
  uStarTanPerPx.value = tanPerBufferPx;
  uStarPsfA.value = GLARE_STRAYLIGHT_S * _crossover;
  uStarPsfB.value = GLARE_STRAYLIGHT_S;
  uStarGlareRgb.value.set(rgbScale[0], rgbScale[1], rgbScale[2]);
}

export function clearStarPointGlare(): void {
  uStarGlareRgb.value.set(0, 0, 0);
  _pointPedestal = 0;
}

/**
 * Mean pre-exposed value the analytic term adds across the frame — what the
 * EXPOSURE METER has to see.
 *
 * 🔑🔑 WHY THIS EXISTS. The analytic veil is added in the POST chain, but the meter
 * reads the SCENE buffer, so it never saw the veil it was creating. MEASURED at
 * 1 AU: the veil's frame mean was **10× middle grey** while the meter reported EV
 * −3.47, i.e. "this scene is dark" — and the frame washed out to uniform milk with
 * the ship barely visible. In a real eye the straylight IS part of the retinal
 * image adaptation responds to, so this is a modelling gap, not a tuning problem.
 *
 * Closing it is negative feedback and therefore self-limiting: more veil ⇒ brighter
 * meter ⇒ higher EV ⇒ lower preExposure ⇒ smaller clipped deficit ⇒ less veil.
 *
 * ⚠ Approximation: uses the WHOLE deficit, though the PSF reaches 51° while the
 * frame is ±25°, so some of that energy lands off-screen. Over-counting raises the
 * metered EV, i.e. errs DARK — the safe direction for a washout.
 */
export function starPointGlarePedestal(): number {
  return _pointPedestal * (uGlareStrength.value as number);
}

/** Live state for `__lum.starGlare()`. */
export function starPointGlareStatus(): {
  uv: [number, number];
  rgb: [number, number, number];
  psfEnergyTotal: number;
} {
  const g = uStarGlareRgb.value;
  return {
    uv: [uStarUv.value.x, uStarUv.value.y],
    rgb: [g.x, g.y, g.z],
    psfEnergyTotal: glarePsfEnergyTotal(),
  };
}

/**
 * The PLAYER's glare setting, as a multiple of the physical straylight fraction.
 * Pushed from the settings atom each frame.
 *
 * ⚠⚠ DELIBERATELY SEPARATE FROM `setGlare`, and the reason is a bug caught before it
 * shipped: driving the settings value through `setGlare(true, …)` in the frame loop
 * would re-enable the stage and overwrite the override EVERY FRAME, silently
 * breaking `__lum.glare(false)` and therefore every perf ablation. That is the same
 * failure that already invalidated one 14-scenario sweep. **A per-frame writer and a
 * debug override must never share a setter.**
 */
export function setGlareUserScale(scale: number): void {
  _userScale = Number.isFinite(scale) && scale >= 0 ? scale : 1;
}

/** Runtime A/B, in the `setLocalExposure` / `setScotopic` idiom. Overrides the player. */
export function setGlare(
  enabled: boolean,
  strength?: number,
  crossoverDeg?: number,
): void {
  _enabled = enabled;
  _strengthOverride = strength ?? null;
  // ⚠ Runtime-tweakable: the crossover trades aureole against veil, two
  // single-exponent guesses already failed in opposite directions, and the author
  // has to be able to judge it without a reload.
  if (crossoverDeg !== undefined && crossoverDeg > 0) {
    _crossover = crossoverDeg;
    _weights = deriveGlareWeights();
    _psfEnergy = glarePsfEnergyTotal();
  }
}

/** Live state for `__lum.glare()`. Never recompute — read this. */
export function glareStatus() {
  const ratios: number[] = [];
  for (let i = 1; i < _weights.length; i++) ratios.push(_weights[i] / _weights[i - 1]);
  return {
    enabled: _enabled,
    strength: uGlareStrength.value as number,
    derivedStrength: GLARE_STRAYLIGHT_FRACTION,
    userScale: _userScale,
    overridden: _strengthOverride !== null,
    mipCount: MIP_COUNT,
    crossoverDeg: _crossover,
    /** Share of the scattered light inside ~0.4° — the tight aureole. */
    aureoleShare: _weights.slice(0, 3).reduce((a, b) => a + b, 0),
    /** Share beyond ~3.2° — the whole-frame veil. */
    farVeilShare: _weights.slice(6).reduce((a, b) => a + b, 0),
    weights: [..._weights],
    octaveRatios: ratios,
    ready: _ready,
    passesLastFrame: _lastPasses,
    mipSizes: _down.map((r) => `${r.width}×${r.height}`),
    /**
     * How far from a source the veil can actually reach, in degrees — the coarsest
     * mip's texel size times the tent's ~1-texel spread each side.
     *
     * ⚠⚠ THE NUMBER THAT WAS MISSING WHEN THIS SHIPPED WITH A HARD EDGE AT 2.7°.
     * The per-octave weights say what the glare's SHAPE should be; this says how
     * much of that shape the pyramid can physically express. They are independent,
     * and only reporting the first is how a truncated veil passes review.
     */
    reachDeg:
      _down.length > 0
        ? (2 * GLARE_ASSUMED_FOV_DEG) / Math.max(_down[_down.length - 1].width, 1)
        : 0,
  };
}

export function disposeGlare(): void {
  for (const rt of [..._down, ..._up]) rt.dispose();
  _down = [];
  _up = [];
  _downScene = _upScene = _seedScene = null;
  _camera = null;
  _initialised = false;
  _ready = false;
  _weights = deriveGlareWeights();
}
