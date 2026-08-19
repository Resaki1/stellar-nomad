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
import { Fn, Loop, float, length, log2, max, texture, uv, vec2, vec4 } from "three/tsl";
import {
  EV_MAX,
  EV_MIN,
  evFromGameUnits,
  getPreExposure,
  isManualExposure,
  setMeteredEV,
} from "./photometry";

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
// ⚠ IT IS ONLY AS GOOD AS THE EMISSIVES. A flux mean responds to whatever is
// actually bright, so an UNCALIBRATED emissive now moves exposure. Measured: at
// Neptune the ship's exhaust glow (≈1.13 game units ≈ 6,800 cd/m², ~1% of frame)
// contributes 13× the flux of Neptune's entire 92%-of-frame disc, pulling the
// meter 1.7 stops bright. That is the meter reading a wrong input correctly —
// see `topFluxShare` in the diagnostics, which exists to catch exactly this.
const ADAPTATION_K = 0.85;

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
// ⚠ This is the ONE artistic number in the file; everything else is derived. It
// must NOT be used to paper over a metering error — a scene that is wrong only in
// one view is a metering bug, and only a consistent offset belongs here.
const EXPOSURE_BIAS_STOPS = 2.5;

// ── Time constants, seconds ─────────────────────────────────────────────────
const TAU_BRIGHTEN = 0.25; // scene got brighter → exposure drops fast (squint)
const TAU_DARKEN_CONE = 2.0; // scene got darker, photopic → cones, seconds
const TAU_DARKEN_ROD = 6.0; // scene got darker, scotopic → rods (real: 20–40 min)
// Mesopic boundary, GAME-UNIT EV: below this, rod adaptation sets the rate.
// 0.03 cd/m² = 4.97e-6 game units → log2(4.97e-6 × 8) = −14.62.
const MESOPIC_EV = -14.62;

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
  _initialised = true;
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
  if (isManualExposure()) return; // `__lum` / `__bench` pin exposure
  if (!_initialised) build(renderer);
  if (!_rt || !_scene || !_camera) return;

  _sourceTex.value = source;
  const prevTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(_rt);
  renderer.render(_scene, _camera);
  renderer.setRenderTarget(prevTarget);

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
        if (den > 0) {
          // Linear mean back to EV, floored so a truly black frame is finite.
          _lastMeteredEV = Math.log2(Math.max(num / den, 1e-14) * 8);
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
  _rt = null;
  _scene = null;
  _camera = null;
  _initialised = false;
  _readPending = false;
}

export { evFromGameUnits };
