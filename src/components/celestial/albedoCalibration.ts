// ─────────────────────────────────────────────────────────────────────
// D09 — ALBEDO CALIBRATION: making a body's texture carry its real albedo
//
// ── The defect ───────────────────────────────────────────────────────────────
// Planet colour maps are ARTWORK. They were authored (or downloaded) to look right
// on a monitor, which means their mean brightness is a presentation choice, not a
// measurement. The renderer then feeds that mean straight into `surfaceRadiance`
// as if it were a reflectance, so each body's rendered brightness is off by
// whatever its texture happens to be off by.
//
// 🔑🔑 THE HARM IS THE SPREAD, NOT THE MEAN, and this is the whole reason D09 is
// worth fixing. A uniform error across all bodies is invisible — auto-exposure
// absorbs it in one stop and nobody can tell. A SPREAD cannot be absorbed by
// anything: MEASURED on the far tier's authored colours, 8.7× (3.12 stops) of
// spread around a geometric mean of 1.076. Luna renders +1.64 stops hot while
// Neptune renders −1.49 cold, IN THE SAME FRAME. No exposure setting, no tone
// curve and no metering estimator can fix that — only per-body calibration can.
// (Two independent instruments agree on Luna: +1.64 stops here, and `__lum.disc`
// measured its disc 3.5× hot.)
//
// ── ⚠⚠ WHY THIS IS MEASURED AT RUNTIME AND NOT A TABLE OF CONSTANTS ──────────
// The obvious fix is one hand-measured scalar per body pasted into `bodies/*.ts`.
// That is wrong here for a stated reason: **the textures are expected to change.**
// A pasted constant silently becomes a lie the moment an asset is swapped, and
// nothing in the build would notice — this repo has already been burned twice by a
// derived constant drifting from its asset (`SKY_TEXTURE_MEAN_LINEAR`, and the sky
// orientation). So the scale is derived from the texture that is actually loaded,
// every run. Swap an asset and the calibration follows it with no code change.
//
// ── What is measured ────────────────────────────────────────────────────────
// The texture's SPHERE-mean linear luminance: an equirectangular map over-samples
// the poles by 1/cos(latitude), so a plain average over-states polar features —
// ice caps on Earth and Mars, exactly the bright ones. Rows are therefore weighted
// by cos(latitude) = sin(π·v). ⚠ That weighting is symmetric about the equator, so
// the KTX2 v-flip (`flipGeometryV`, defect D24) cannot affect this number — one
// place in this codebase where that trap is structurally absent.
//
// ⚠ LEVEL 0 WITH STRATIFIED TAPS, NOT A MIP. Reading a small mip would be cheaper
// and is tempting, but `toktx --genmipmap` filters in the texture's own (sRGB)
// encoding, so a mip's value is the average of ENCODED texels — which is not the
// average of the decoded ones, sRGB being concave. Sampling level 0 and letting
// three's sRGB decode run per tap keeps the average in the space it belongs in.
// One bilinear tap per output texel would be the D31 aliasing bug again; stratified
// taps make the tile mean an unbiased estimator with ~1/N the variance.
//
// ── What the scale is compared against, and the ONE constant left over ───────
// `scale = geometricAlbedo / measuredSphereMean`. ⚠ The sphere-mean of a surface
// albedo map is not identically the disc-averaged geometric albedo — the projection
// and the limb-darkening law sit in between. That residual is deliberately NOT
// derived here, because it is **body-independent**: it is one global constant, and
// `__lum.disc()` measures it directly as `impliedGeometricAlbedo /
// referenceGeometricAlbedo`. So the job of this module is to remove the per-body
// SPREAD (which nothing else can), and to leave at most a single global offset
// (which exposure absorbs anyway). Making the far tier and this share one target —
// `geometricAlbedo` — is what keeps the LOD tiers consistent by construction.
// ─────────────────────────────────────────────────────────────────────

import * as THREE from "three";
import { NodeMaterial, RenderTarget } from "three/webgpu";
import type { WebGPURenderer } from "three/webgpu";
import type { Node } from "three/webgpu";
import { Fn, Loop, float, texture, uniform, uv, vec2, vec4 } from "three/tsl";
import { bodyPhotometry } from "@/data/bodyPhotometry";
import { bodyReflectanceRgb } from "./bodyColour";

/** Output grid for the reduction. 128×64 keeps the cos weighting well resolved. */
const GRID_W = 128;
const GRID_H = 64;
/** Stratified taps per axis inside each output texel (TAPS² samples per texel). */
const TAPS = 16;
/** Rec.709 relative luminance — the same weights `__lum` and the meter use. */
const REC709 = [0.2126, 0.7152, 0.0722] as const;
/**
 * Refuse to apply a correction outside this range and log loudly instead.
 * A legitimate art-vs-physics mismatch is a few×; 20× means the texture is not
 * what we think it is (wrong colour space, a normal map, a missing decode) and
 * silently scaling by it would hide a real bug behind a plausible picture.
 */
const MAX_SCALE = 20;
const MIN_SCALE = 1 / 20;
/**
 * How far the correction may rotate a texture's HUE, in stops per channel relative
 * to its luminance scale.
 *
 * ⚠⚠ WHY THE CORRECTION IS PER-CHANNEL AND NOT A SCALAR, i.e. the bug this fixes.
 * A scalar fixes luminance and leaves hue to the texture — which put the two LOD
 * tiers on different sources and made them disagree. MEASURED on Neptune: the far
 * tier's derived hue is R/B **0.690** while its texture renders R/B **0.051** — a
 * **13.5× disagreement on the same body in the same frame**, visible as a colour
 * shift across the LOD transition. Worse, Neptune's texture is a saturated blue, and
 * a saturated blue has LOW Rec709 luminance (blue's weight is 0.0722) — so a
 * luminance-only fix scaled it +1.85 stops and produced a *brighter* vivid blue
 * rather than the pale cyan its colour index says it is. 🔑 Correcting per channel
 * makes the texture's MEAN colour equal the derived colour while keeping all of its
 * spatial variation, so both tiers agree by construction.
 *
 * ⚠⚠ AND WHY THE BOUND IS TIGHT (1.5 stops), which is a deliberate admission of
 * ignorance rather than a safety margin. MEASURED on Neptune: the wanted per-channel
 * scale is **[19.3, 3.54, 1.42]** — a **19× boost on a red channel whose texture mean
 * is only 0.0196**. And Neptune is precisely where the derivation is LEAST reliable:
 * methane absorbs in the RED, which a linear slope fitted between 442 and 540 nm
 * cannot see, so the derived R/B of 0.69 is model extrapolation into a band the model
 * does not represent. The texture's 0.051 is probably too low (enhanced) and the
 * derived 0.69 too high; **the truth is in between and neither source knows where.**
 * Amplifying red 19× on the strength of an inapplicable model would be worse than an
 * imperfect match, so the hue moves at most 1.5 stops per channel toward the
 * measurement and the body is NAMED instead.
 *
 * 🔑 When this clamp engages it is a FINDING, not a nuisance: that body needs a real
 * second colour index (V−R or B−R) in `measuredReflectanceRgb`. ⚠ For a clamped body
 * the far tier (pure derivation) and the near/mid tier (bounded texture) still differ
 * — accepted, and far smaller than the 13.5× it started at. Luminance stays exact
 * either way, which is the part we actually know.
 */
const HUE_ROTATION_MAX_STOPS = 1.5;

export type AlbedoCalibration = {
  bodyId: string;
  state: "pending" | "done" | "failed" | "clamped" | "skipped";
  /** cos(lat)-weighted mean linear luminance of the colour map, 0..1. */
  measuredSphereMean?: number;
  measuredRgb?: [number, number, number];
  /** The body's published geometric albedo — the target. */
  targetAlbedo?: number;
  /** Luminance scale — the unambiguous part. 1 until measured, 1 on failure. */
  scale: number;
  /** Per-channel scale actually applied (hue + luminance). [1,1,1] until measured. */
  scaleRgb: [number, number, number];
  /** The derived target mean colour (luminance = geometricAlbedo). */
  targetRgb?: [number, number, number];
  /** True when the hue rotation hit HUE_ROTATION_MAX_STOPS on any channel. */
  hueClamped?: boolean;
  note?: string;
};

type Entry = AlbedoCalibration & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uniformNode: any;
  requested: boolean;
};

const _entries = new Map<string, Entry>();

function entryFor(bodyId: string): Entry {
  let e = _entries.get(bodyId);
  if (!e) {
    e = {
      bodyId,
      state: "pending",
      scale: 1,
      scaleRgb: [1, 1, 1],
      // ⚠ Stable node, created once, `.value` written when the measurement lands.
      // The body's material is built from a useMemo that runs long before the
      // texture has been read back, so a node created at measurement time would
      // never reach the shader. Same pattern as the metering source proxy.
      uniformNode: uniform(new THREE.Vector3(1, 1, 1)),
      requested: false,
    };
    _entries.set(bodyId, e);
  }
  return e;
}

/**
 * The stable uniform a body's shader multiplies its output by. Exactly 1.0 until a
 * measurement lands, and 1.0 forever if one never does — so wiring this up is a
 * bit-exact no-op on any body that has no colour map or no photometry entry.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function albedoScaleUniform(bodyId: string): any {
  return entryFor(bodyId).uniformNode;
}

/**
 * The `stellarPoint.geometricAlbedo` a body is ACTUALLY configured with, published
 * as it mounts.
 *
 * 🔑 WHY PUBLISHED RATHER THAN IMPORTED. The same albedo is written down in three
 * places — `bodyPhotometry` (the reference), each body's `stellarPoint`, and the far
 * billboard's authored colour — and two of those can silently drift from the first.
 * The far tier is normalised from the reference at consumption so it cannot; the
 * stellar point's copy can, and a disagreement there is a per-body brightness step at
 * the LOD boundary that is hardest to eyeball. `__lum.albedo()` audits it.
 *
 * ⚠ There is no central registry of body configs — each body has its own wrapper
 * component — so the alternative was importing 13 body modules into the harness,
 * which would drag every planet's shaders and textures into its module graph. Same
 * witness-don't-recompute pattern as `lodState.ts`.
 */
const _stellarPointAlbedo = new Map<string, number>();

export function publishStellarPointAlbedo(bodyId: string, p: number): void {
  _stellarPointAlbedo.set(bodyId, p);
}

export function getStellarPointAlbedos(): Array<[string, number]> {
  return Array.from(_stellarPointAlbedo.entries());
}

export function albedoCalibrationStatus(): AlbedoCalibration[] {
  return Array.from(_entries.values()).map((e) => ({
    bodyId: e.bodyId,
    state: e.state,
    measuredSphereMean: e.measuredSphereMean,
    measuredRgb: e.measuredRgb,
    targetAlbedo: e.targetAlbedo,
    scale: e.scale,
    scaleRgb: e.scaleRgb,
    targetRgb: e.targetRgb,
    hueClamped: e.hueClamped,
    note: e.note,
  }));
}

let _rt: RenderTarget | null = null;
let _scene: THREE.Scene | null = null;
let _camera: THREE.OrthographicCamera | null = null;
let _srcTex: { value: THREE.Texture | null } = { value: null };

function build(): void {
  _rt = new RenderTarget(GRID_W, GRID_H, {
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

  const src = texture(new THREE.Texture());
  mat.fragmentNode = Fn(() => {
    const p = uv();
    const tileOrigin = p.mul(vec2(GRID_W, GRID_H)).floor().div(vec2(GRID_W, GRID_H));
    const step = vec2(1 / (GRID_W * TAPS), 1 / (GRID_H * TAPS));
    const acc = vec4(0).toVar();
    Loop(TAPS, ({ i }: { i: Node }) => {
      Loop(TAPS, ({ i: j }: { i: Node }) => {
        const off = vec2(float(i).add(0.5), float(j).add(0.5)).mul(step);
        // ⚠ RAW texels, no calibration applied — values stay in [0,1] where
        // half-float precision lives. Scaling happens on the CPU in float64. That
        // is the D25 lesson from `skyIrradiance`, which rendered ~1.3e-8 into
        // RGBA16F (subnormal floor 5.96e-8) and lost 5.85× of the sky.
        acc.addAssign(src.sample(tileOrigin.add(off)));
      });
    });
    return acc.div(float(TAPS * TAPS));
  })();

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  mesh.frustumCulled = false;
  _scene = new THREE.Scene();
  _scene.add(mesh);
  _camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  _srcTex = src as unknown as { value: THREE.Texture | null };
}

function halfToFloat(h: number): number {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1f) return f ? NaN : (s ? -1 : 1) * Infinity;
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

/**
 * Measure a body's colour map once and publish its albedo scale.
 *
 * Idempotent per body: the first call wins and later calls are ignored, so a
 * remount or a tier change cannot re-trigger it. Safe to call from a render-phase
 * memo — the GPU work is one 128×64 draw and the readback is awaited off the frame.
 */
export async function requestAlbedoCalibration(
  renderer: WebGPURenderer,
  bodyId: string,
  tex: THREE.Texture | null | undefined,
): Promise<void> {
  const e = entryFor(bodyId);
  if (e.requested) return;
  const phot = bodyPhotometry(bodyId);
  // ⚠ A body whose colour map is only PART of its disc albedo must not be scaled to
  // the whole-disc value — that double-counts its other layers. Declared in
  // bodyPhotometry with the reason; see `colourMapPartialReason` there for how Earth
  // exposed this. Skipped LOUDLY (state "skipped", surfaced by `__lum.albedo()`), not
  // silently, because "no correction applied" and "correction applied wrongly" look
  // identical in a screenshot.
  if (phot?.colourMapPartialReason) {
    e.requested = true;
    e.state = "skipped";
    e.scale = 1;
    e.scaleRgb = [1, 1, 1];
    e.targetAlbedo = phot.geometricAlbedo;
    e.note = phot.colourMapPartialReason;
    return;
  }
  const target = phot?.geometricAlbedo;
  if (!tex || target === undefined || target <= 0) {
    // Not an error: `sol` emits rather than reflects, and moons may ship without
    // a photometry row. Leaving the scale at 1 keeps them exactly as authored.
    e.state = "failed";
    e.note = !tex ? "no colour map" : "no geometricAlbedo in bodyPhotometry";
    return;
  }
  e.requested = true;
  e.targetAlbedo = target;

  try {
    if (!_rt) build();
    if (!_rt || !_scene || !_camera) throw new Error("calibration pass not built");
    _srcTex.value = tex;
    // ── ⚠⚠ FORCE LEVEL 0 BY SUPPRESSING MIP FILTERING FOR THIS ONE DRAW ───────
    // Without this the stratified taps are pointless AND land in the wrong colour
    // space. The GPU picks LOD from the DERIVATIVE ACROSS FRAGMENTS, and adjacent
    // fragments' tap coordinates differ by 1/GRID_W — a 64-texel footprint on an
    // 8k map — so every tap would read mip ~6. Two consequences: the 256 taps all
    // return the same pre-averaged value (no variance reduction, and the tile mean
    // becomes whatever the mip filter decided), and `toktx --genmipmap` built those
    // mips in the texture's own sRGB encoding, so their values are averages of
    // ENCODED texels — not the average of the decoded ones, sRGB being concave.
    //
    // 🔑 Same class of bug as the skybox seam (derivative LOD selection reaching a
    // level nobody intended) and the same remedy shape as `withStarCaptureResolution`:
    // change the sampler, take the measurement, restore IMMEDIATELY. `minFilter`
    // without a Mipmap variant makes the sampler ignore the mip chain entirely.
    const prevMin = tex.minFilter;
    const prevMag = tex.magFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    const prev = renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(_rt);
      renderer.render(_scene, _camera);
    } finally {
      renderer.setRenderTarget(prev);
      tex.minFilter = prevMin;
      tex.magFilter = prevMag;
    }

    const buf = await renderer.readRenderTargetPixelsAsync(_rt, 0, 0, GRID_W, GRID_H);
    const isHalf = buf instanceof Uint16Array;
    const isByte = buf instanceof Uint8Array;
    const a = buf as unknown as ArrayLike<number>;
    const bpe = isHalf ? 2 : isByte ? 1 : 4;
    // ⚠ Rows are padded to a 256-byte stride. Never index by width×4.
    const stride = Math.ceil((GRID_W * 4 * bpe) / 256) * (256 / bpe);
    const dec = (v: number): number => (isHalf ? halfToFloat(v) : isByte ? v / 255 : v);

    let wSum = 0;
    let lSum = 0;
    const rgb = [0, 0, 0];
    for (let row = 0; row < GRID_H; row++) {
      // cos(latitude) for this row's centre. v runs 0..1 pole to pole, so
      // cos((0.5 − v)·π) = sin(π·v). Symmetric ⇒ immune to the KTX2 v-flip.
      const w = Math.sin(Math.PI * ((row + 0.5) / GRID_H));
      for (let col = 0; col < GRID_W; col++) {
        const i = row * stride + col * 4;
        const r = dec(a[i]);
        const g = dec(a[i + 1]);
        const b = dec(a[i + 2]);
        if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) continue;
        lSum += w * (REC709[0] * r + REC709[1] * g + REC709[2] * b);
        rgb[0] += w * r;
        rgb[1] += w * g;
        rgb[2] += w * b;
        wSum += w;
      }
    }
    if (wSum <= 0 || !(lSum > 0)) throw new Error("empty or black readback");

    const mean = lSum / wSum;
    e.measuredSphereMean = mean;
    const mRgb: [number, number, number] = [
      rgb[0] / wSum,
      rgb[1] / wSum,
      rgb[2] / wSum,
    ];
    e.measuredRgb = mRgb;
    const raw = target / mean;
    if (raw > MAX_SCALE || raw < MIN_SCALE) {
      // ⚠ Do NOT apply it. A scale this far out means the input is not what we
      // think it is, and a plausible-looking picture would bury that.
      e.state = "clamped";
      e.scale = 1;
      e.scaleRgb = [1, 1, 1];
      e.note =
        `implied scale ${raw.toPrecision(3)} is outside [${MIN_SCALE}, ${MAX_SCALE}] — ` +
        "left at 1.0. Check the texture's colour space and that it is the colour map.";
      console.warn(`[albedo] ${bodyId}: ${e.note}`);
      return;
    }
    e.scale = raw;

    // ── Per-channel: make the texture's MEAN colour the DERIVED colour ────────
    // The target is the same object the far tier uses, so the two tiers cannot
    // disagree about a body's colour. Spatial variation is untouched — only the mean
    // moves.
    const derived = bodyReflectanceRgb(bodyId);
    let sRgb: [number, number, number] = [raw, raw, raw];
    if (derived && mRgb.every((v) => v > 1e-6)) {
      e.targetRgb = [derived.r, derived.g, derived.b];
      const lo = raw / Math.pow(2, HUE_ROTATION_MAX_STOPS);
      const hi = raw * Math.pow(2, HUE_ROTATION_MAX_STOPS);
      const want: [number, number, number] = [
        derived.r / mRgb[0],
        derived.g / mRgb[1],
        derived.b / mRgb[2],
      ];
      sRgb = want.map((v) => Math.min(hi, Math.max(lo, v))) as typeof want;
      e.hueClamped = want.some((v, i) => v !== sRgb[i]);
      // ⚠⚠ RENORMALISE AFTER CLAMPING SO LUMINANCE STAYS EXACT. Luminance is the
      // part we actually know (the published geometric albedo); hue is the part
      // under a model. Clamping a channel changes the resulting luminance, so
      // without this a clamped body would silently lose its brightness calibration
      // — trading the certain result for the uncertain one, which is backwards.
      const resultLum =
        REC709[0] * mRgb[0] * sRgb[0] +
        REC709[1] * mRgb[1] * sRgb[1] +
        REC709[2] * mRgb[2] * sRgb[2];
      if (resultLum > 1e-9) {
        const fix = target / resultLum;
        sRgb = sRgb.map((v) => v * fix) as typeof sRgb;
      }
      if (e.hueClamped) {
        e.note =
          `hue rotation CLAMPED at ${HUE_ROTATION_MAX_STOPS} stops — the texture's hue ` +
          `(R/B ${(mRgb[0] / mRgb[2]).toPrecision(3)}) and the B−V-derived hue (R/B ` +
          `${(derived.r / derived.b).toPrecision(3)}) disagree violently. One of them is ` +
          "wrong: either the texture is contrast/saturation-enhanced, or the linear-slope " +
          "model under-saturates this body. Get a second colour index (V−R/B−R) and set " +
          "`measuredReflectanceRgb`. Luminance is still exact.";
        console.warn(`[albedo] ${bodyId}: ${e.note}`);
      }
    }
    e.scaleRgb = sRgb;
    e.state = "done";
    e.uniformNode.value.set(sRgb[0], sRgb[1], sRgb[2]);
  } catch (err) {
    e.state = "failed";
    e.scale = 1;
    e.scaleRgb = [1, 1, 1];
    e.note = String(err);
  }
}

export function disposeAlbedoCalibration(): void {
  _rt?.dispose();
  _rt = null;
  _scene = null;
  _camera = null;
}
