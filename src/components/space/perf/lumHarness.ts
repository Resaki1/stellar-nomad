/**
 * `__lum` — the PHOTOMETRIC validation harness.
 *
 * The companion to `__bench` (docs/PERF_MEASUREMENT.md). `__bench` exists
 * because eye-balled FPS turned out to be worthless as a before/after; `__lum`
 * exists for exactly the same reason applied to brightness. The lighting work in
 * docs/LIGHTING_PLAN.md changes absolute luminances by factors of 6–6,000, and
 * "it looks about right" cannot tell a correct 2.76 from an incorrect 0.43.
 *
 *   await __lum.probe()               // centre pixel: game units, cd/m², EV100
 *   await __lum.probe(x, y)           // a specific pixel (drawing-buffer coords)
 *   await __lum.sweep()               // the ladder: measured vs expected + ratio
 *   __lum.expected("luna")            // what physics says this body's disc is
 *   __lum.setEV(14) / __lum.auto()    // pin / release exposure
 *   __lum.sun()                       // eclipse / umbra state on the ship (D27)
 *   await __lum.star("Sirius")        // THE STAR GATE — measured vs published mag
 *   __lum.aim(17.7611, -29.0078)     // aim at a sky coordinate (orientation check)
 *   await __lum.skyAlign()           // GATE: is the Milky Way panorama aligned?
 *   __lum.skyProbe()                 // GATE: is the sky lighting the hull? (D29)
 *   __lum.units()                     // print the unit convention
 *
 * ── WHAT IS MEASURED ────────────────────────────────────────────────────────
 * The probe reads the FINAL PRE-TONEMAP RGBA16F target — i.e. linear scene
 * luminance in game units, before exposure, bloom or the tone curve. That is the
 * only place a physical number exists; everything after it is display-referred.
 *
 * ── THE TWO RULES ───────────────────────────────────────────────────────────
 * 1. EXPOSURE IS PINNED while sweeping. Auto-exposure (Phase 5) is frame-to-frame
 *    state, so an unpinned sweep measures a function of the previous frame — the
 *    same class of error as the start-state contamination that invalidated three
 *    perf sweeps (docs/PERF_MEASUREMENT.md § VARIANCE RESOLVED).
 * 2. SETTLE BEFORE PROBING. Warping provokes texture streaming, LOD tier swaps
 *    and shader compiles, and the cloud/atmosphere passes have multi-frame
 *    temporal state. A probe on the frame after a warp measures a half-built
 *    image.
 */

import type { createStore } from "jotai";
import { Matrix4, Quaternion, Vector3 } from "three";
import type { RenderTarget, WebGPURenderer } from "three/webgpu";

import solSystem from "@/sim/systems/sol.json";
import { STAR_LUMINOSITY_SUN } from "@/sim/celestialConstants";
import { devTeleportAtom, type DevWarp } from "@/store/dev";
import { bodyPhotometry } from "@/data/bodyPhotometry";
import {
  getAtmosphereBody,
  getDominantAtmosphereBody,
  setFmsMax,
  setMsScale,
} from "../atmospherePass";
import { sunOcclusionStatus } from "../sunOcclusion";
import {
  setErosionScale,
  setShellOpticalPath,
} from "@/components/celestial/bodies/earthClouds";
import { setCloudSunScale } from "@/components/celestial/bodies/cloudCommon";
import {
  adaptationTarget,
  exposureMeterStatus,
  resetExposureAdaptation,
} from "../exposureMeter";
import {
  NITS_PER_GAME_UNIT,
  SUN_ILLUM_GAME_1AU,
  discRadianceAtZeroPhase,
  subSolarRadianceLambert,
  evFromGameUnits,
  getExposure,
  getPreExposure,
  getExposureCompensation,
  setExposureEV,
  setManualExposure,
  setPreExposureOverride,
  sunIlluminanceAt,
} from "../photometry";
import {
  resolveBodyWarp,
  resolveLookDirectionWarp,
  resolveUmbraWarp,
} from "./scenarios";
import {
  STAR_ARTISTIC_GAIN,
  STAR_PSF_SIGMA_PX,
  starCompressionFactor,
  equatorialToGame,
  getStarPsfInputs,
  getStarPsfNorm,
  starIlluminanceGame,
} from "@/components/Stars/StarField";
import {
  SKY_ARTISTIC_GAIN,
  SKY_DIFFUSE_TARGET_NITS,
} from "@/components/Skybox/MilkyWaySkybox";
import {
  SKY_CUBE_SIZE,
  captureTanPerPx,
  skySpecularStatus,
} from "@/components/space/skySpecular";
import {
  accumulatePointSource,
  evaluateShIrradiance,
  getPanoramaMeanRadiance,
  getSkySh,
  skyIrradianceStatus,
  type ShCoefficients,
} from "@/components/space/skyIrradiance";

type Store = ReturnType<typeof createStore>;

// ── The probe source, registered by SpaceRenderer each frame ─────────────

type LumSource = {
  renderer: WebGPURenderer;
  /** The final composited pre-tonemap target (rtB when the AP pass routes through it). */
  target: RenderTarget;
  /**
   * The SCALED camera, needed only by `disc()` to convert a body's angular
   * radius into a pixel radius. Optional so an older caller still registers.
   */
  camera?: { fov: number };
};

let _source: LumSource | null = null;
let _setCount = 0;

/**
 * Publish the current pre-tonemap target for probing. Called by SpaceRenderer
 * once per frame — cheap (a few reference writes) and it has to be per-frame
 * because `rt`/`rtB` are recreated on resize and dpr change.
 */
export function setLumSource(
  renderer: WebGPURenderer,
  target: RenderTarget,
  camera?: { fov: number },
): void {
  _setCount++;
  if (
    _source &&
    _source.renderer === renderer &&
    _source.target === target &&
    _source.camera === camera
  ) {
    return;
  }
  _source = { renderer, target, camera };
}

export function clearLumSource(): void {
  _source = null;
}

/**
 * Is a probe target registered, and has SpaceRenderer ever published one into
 * THIS module instance?
 *
 * `setCount === 0` while the scene is visibly rendering means the renderer and
 * the harness are holding two different instances of this module — the classic
 * Fast Refresh split. Full page reload, don't debug the physics.
 */
export function lumSourceStatus(): {
  registered: boolean;
  setCount: number;
  width: number;
  height: number;
} {
  return {
    registered: _source !== null,
    setCount: _setCount,
    width: _source?.target.width ?? 0,
    height: _source?.target.height ?? 0,
  };
}

// ── Types ────────────────────────────────────────────────────────────────

export type LumSample = {
  x: number;
  y: number;
  /** Linear scene luminance, game units (pre-exposure, pre-tonemap). */
  units: [number, number, number];
  /** Photopic mix of the above, game units. */
  luma: number;
  /** Photopic luminance in cd/m². */
  nits: number;
  /** EV100 of `nits`. */
  ev: number;
};

export type LumExpectation = {
  bodyId: string;
  geometricAlbedo: number;
  /** Live top-of-atmosphere illuminance at that body, game units. */
  sunIlluminance: number;
  /** Lambertian-equivalent DISC-AVERAGE radiance p·E/π, game units. */
  discUnits: number;
  /** What a SUB-SOLAR probe should read on a Lambert sphere: 1.5·p·E/π. */
  subSolarUnits: number;
  discNits: number;
  discEv: number;
  note?: string;
};

/** One row of the ladder: where to look from, and what should be under the cursor. */
type LumScenario = {
  id: string;
  bodyId: string;
  altitudeKm: number;
  /**
   * What the centre pixel should be showing. `disc` = the body's sunlit disc, so
   * compare against p·E/π. `sky` / `space` have no closed-form expectation yet
   * and are recorded for tracking rather than asserted.
   */
  expect: "disc" | "sky" | "space";
  what: string;
};

/**
 * The ladder. Deliberately small — every row has to be a view whose expected
 * luminance is derivable, or it is just a number with no opinion attached.
 *
 * ⚠ These are all DAY-SIDE, near-zero-phase views, because that is the geometry
 * `p·E/π` describes. Once bodies orbit (LIGHTING_PLAN §3.0) add a non-zero-phase
 * row — a crescent Venus — so latent full-phase assumptions get caught here
 * rather than by eye (risk #12).
 */
const LADDER: readonly LumScenario[] = [
  { id: "earth_disc", bodyId: "earth", altitudeKm: 12_629, expect: "disc", what: "Earth's sunlit disc from high orbit" },
  { id: "earth_sky", bodyId: "earth", altitudeKm: 8, expect: "sky", what: "Sky from the cloud deck (replica ground truth: 0.61 units photopic)" },
  { id: "luna_disc", bodyId: "luna", altitudeKm: 20_000, expect: "disc", what: "The Moon's sunlit disc" },
  { id: "venus_disc", bodyId: "venus", altitudeKm: 30_000, expect: "disc", what: "Venus' cloud deck — was the 0.025-trim victim; the acid test for Phase 2" },
  { id: "mars_disc", bodyId: "mars", altitudeKm: 20_000, expect: "disc", what: "Mars' disc" },
  { id: "jupiter_disc", bodyId: "jupiter", altitudeKm: 200_000, expect: "disc", what: "Jupiter's disc at 5.2 AU" },
  { id: "neptune_disc", bodyId: "neptune", altitudeKm: 100_000, expect: "disc", what: "Neptune's disc at 30 AU — the 1/r² acid test" },
  { id: "deep_space", bodyId: "earth", altitudeKm: 40_000_000, expect: "space", what: "Nothing in range — the floor (skybox + stars)" },
];

const REC709 = [0.2126, 0.7152, 0.0722] as const;

// Pose scratch — same convention as scenarios.ts (`_flipY` included; without it
// the ship faces 180° away and every probe reads empty sky).
const _eye = new Vector3();
const _target = new Vector3();
const _sunDir = new Vector3();
const _up = new Vector3(0, 1, 0);
const _lookMatrix = new Matrix4();
const _quat = new Quaternion();
const _flipY = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);

/** A body's authored record from the system description. */
function authoredBody(bodyId: string) {
  const bodies = solSystem.celestialBodies as unknown as Array<{
    id: string;
    radiusKm?: number;
    positionKm?: number[];
  }>;
  return bodies.find((b) => b.id === bodyId) ?? null;
}

/**
 * Camera pose on the body→star line, looking back at the body: the SUB-SOLAR
 * point dead centre, at zero phase angle.
 *
 * This is the geometry `p·E/π` is defined at, and it is NOT what
 * `resolveBodyWarp` gives — that uses a fixed approach axis, so the phase angle
 * is incidental and a body can end up measured over its night side. That is
 * exactly what made Earth read 0.0106× (198 cd/m²) on the first attempt.
 *
 * Default altitude is 3 radii: far enough that the disc is comfortably inside
 * the probe block and any atmosphere is fully in front of it, close enough that
 * the body still fills the frame centre.
 */
function subSolarPose(bodyId: string, altitudeKm?: number): DevWarp | null {
  const b = authoredBody(bodyId);
  const star = authoredBody("sol");
  if (!b?.positionKm || !b.radiusKm || !star?.positionKm) return null;

  _target.set(b.positionKm[0], b.positionKm[1], b.positionKm[2]);
  _sunDir
    .set(star.positionKm[0], star.positionKm[1], star.positionKm[2])
    .sub(_target)
    .normalize();
  _eye
    .copy(_sunDir)
    .multiplyScalar(b.radiusKm + (altitudeKm ?? b.radiusKm * 3))
    .add(_target);

  _lookMatrix.lookAt(_eye, _target, _up);
  _quat.setFromRotationMatrix(_lookMatrix).multiply(_flipY);
  return {
    positionKm: [_eye.x, _eye.y, _eye.z],
    quaternion: [_quat.x, _quat.y, _quat.z, _quat.w],
  };
}

/**
 * Body→star distance in km from the AUTHORED system description.
 *
 * Fallback for `expected()` when the body is not the currently registered
 * atmosphere body — which is most of them, most of the time. Once bodies orbit
 * this becomes stale and the live record must win; that is why it is only a
 * fallback.
 */
function authoredStarDistanceKm(bodyId: string): number | null {
  const bodies = solSystem.celestialBodies as unknown as Array<{
    id: string;
    positionKm?: number[];
  }>;
  const body = bodies.find((b) => b.id === bodyId);
  const star = bodies.find((b) => b.id === "sol");
  if (!body?.positionKm || !star?.positionKm) return null;
  return Math.hypot(
    body.positionKm[0] - star.positionKm[0],
    body.positionKm[1] - star.positionKm[1],
    body.positionKm[2] - star.positionKm[2],
  );
}

// ── Readback decoding ────────────────────────────────────────────────────
//
// ⚠ TWO TRAPS, both hit on the first live run (2026-08-14). The symptom was a
// probe of dark space returning exactly 6272 in all three channels — a uniform
// integer, which is never a rendered radiance. Both are properties of
// `readRenderTargetPixelsAsync` on a HalfFloatType target:
//
// 1. IT RETURNS RAW HALF-FLOAT BITS, NOT FLOATS. `rgba16float` maps to
//    `Uint16Array` in WebGPUTextureUtils._getTypedArrayType, and three does no
//    decoding. 6272 = 0x1880 = 2^(6−15)·1.125 = 0.002197. Reading the bits as
//    numbers inflated every value by 10³–10⁶ and made the EV column meaningless.
// 2. ROWS ARE PADDED TO A 256-BYTE STRIDE
//    (`bytesPerRow = ceil(width·bytesPerTexel / 256) · 256`), so for a
//    multi-pixel read the row pitch is NOT `width · 4` elements. A 9-wide read
//    is padded from 72 to 256 bytes — indexing linearly walks into padding.

const BYTES_PER_TEXEL_RGBA16F = 8;

/** IEEE 754 binary16 → number. Handles subnormals, Inf and NaN. */
function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h & 0x7c00) >> 10;
  const frac = h & 0x03ff;
  if (exp === 0) return sign * 2 ** -14 * (frac / 1024); // subnormal (incl. zero)
  if (exp === 0x1f) return frac ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + frac / 1024);
}

/**
 * Elements per row in the returned typed array, accounting for the 256-byte
 * alignment. `width` is the requested read width in pixels.
 */
function rowStrideElements(width: number, bytesPerElement: number): number {
  const bytesPerRow =
    Math.ceil((width * BYTES_PER_TEXEL_RGBA16F) / 256) * 256;
  return bytesPerRow / bytesPerElement;
}

/**
 * Decode one pixel's RGB from a readback buffer, whatever its storage type, and
 * return it in ABSOLUTE game units.
 *
 * ⚠ The divide by `getPreExposure()` is what keeps this whole harness meaningful
 * after D25. The buffer holds radiance × preExposure, so without it every number
 * in docs/LIGHTING_PLAN.md — every `compare` ratio, every implied albedo — would
 * silently become a reading of the exposure follower instead of the scene. It is
 * 1.0 while pre-exposure is off, so this is a bit-exact no-op until D25 goes live.
 *
 * This is the ONE chokepoint: probe, probeMax and disc all decode through here,
 * so there is no second place to forget.
 */
function decodeRgb(
  buf: ArrayLike<number>,
  base: number,
  isHalf: boolean,
  isByte: boolean,
): [number, number, number] {
  const inv = 1 / getPreExposure();
  const c = (k: number) => {
    const raw = buf[base + k] ?? 0;
    const v = isHalf ? halfToFloat(raw) : isByte ? raw / 255 : raw;
    return v * inv;
  };
  return [c(0), c(1), c(2)];
}

const sleepFrames = (n: number) =>
  new Promise<void>((resolve) => {
    let left = n;
    const tick = () => (left-- <= 0 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });

export class LumHarness {
  constructor(private readonly store: Store) {}

  /** Whether a probe target is registered, and how many times it was published. */
  status(): ReturnType<typeof lumSourceStatus> & { exposure: number } {
    return { ...lumSourceStatus(), exposure: getExposure() };
  }

  /**
   * Verify the half-float decoder against known bit patterns.
   *
   * Exists because the first live run of this harness reported dark space at
   * 13 million cd/m² — `readRenderTargetPixelsAsync` returns raw binary16 bits
   * for a HalfFloatType target and they were being read as floats. Cheap
   * insurance against that silently coming back; run it if numbers look absurd.
   */
  selftest(): boolean {
    const cases: Array<[number, number]> = [
      [0x0000, 0], //  zero
      [0x3c00, 1], //  1.0
      [0x4000, 2], //  2.0
      [0xbc00, -1], // −1.0
      [0x1880, 0.002197265625], // the value that exposed the bug
      [0x41d7, 2.919921875], //   sunlit cloud tops, from the same run
      [0x0001, 2 ** -24], //      smallest subnormal
      [0x7bff, 65504], //         largest finite
    ];
    let ok = true;
    for (const [bits, want] of cases) {
      const got = halfToFloat(bits);
      if (Math.abs(got - want) > Math.abs(want) * 1e-6 + 1e-30) {
        console.error(
          `[lum] halfToFloat(0x${bits.toString(16)}) = ${got}, expected ${want}`,
        );
        ok = false;
      }
    }
    // Row stride must respect the 256-byte alignment, not width×4.
    if (rowStrideElements(9, 2) !== 128) {
      console.error(`[lum] rowStrideElements(9, 2) = ${rowStrideElements(9, 2)}, expected 128`);
      ok = false;
    }
    console.log(ok ? "[lum] selftest OK" : "[lum] selftest FAILED");
    return ok;
  }

  /**
   * Warp to a body's SUB-SOLAR point, settle, probe, and print against physics.
   *
   * ⚠ IT WARPS BY DEFAULT, AND THAT IS THE WHOLE POINT. The first version just
   * probed the screen centre, so `compare("earth")` while parked at Venus
   * measured VENUS and compared it to EARTH's expectation — silently, with a
   * confident-looking ratio. Two calls from one location returned byte-identical
   * "measurements" for different bodies, which is how it was caught.
   *
   * The pose is deliberately NOT `resolveBodyWarp`'s: that places the eye along a
   * fixed approach axis, so the phase angle is whatever it happens to be, and a
   * body can be measured over its night side. `p·E/π` is defined at ZERO PHASE,
   * so this puts the camera on the body→star line looking back at the body —
   * the sub-solar point dead centre, which is the geometry the expectation
   * describes.
   *
   * Pass `{ warp: false }` to probe wherever you already are.
   */
  async compare(
    bodyId: string,
    {
      warp = true,
      altitudeKm,
      settleFrames = 420,
      blockSize = 9,
    }: {
      warp?: boolean;
      altitudeKm?: number;
      settleFrames?: number;
      blockSize?: number;
    } = {},
  ) {
    if (warp) {
      const pose = subSolarPose(bodyId, altitudeKm);
      if (!pose) {
        console.error(`[lum] no pose for "${bodyId}" — not in the system description`);
        return null;
      }
      this.store.set(devTeleportAtom, pose);
      await sleepFrames(settleFrames);
    }
    const m = await this.probeMax(blockSize);
    const exp = this.expected(bodyId);
    if (!m || !exp) return null;
    const ratio = m.luma / exp.discUnits;
    // Back-solve the REFLECTANCE the shader must be emitting: R = L·π/E.
    //
    // ⚠ THIS IS THE DIAGNOSTIC THAT MATTERS, because it separates a real energy
    // bug from a bad probe. Unfavourable geometry (off sub-solar point, limb
    // darkening, N·L < 1, atmospheric transmittance) can only push R DOWN. So:
    //   • R > 1  ⇒ the body emits more light than falls on it. IMPOSSIBLE at any
    //              geometry — an unambiguous energy-conservation violation.
    //   • R < p  ⇒ ambiguous: could be texture-albedo error (D09), or just a
    //              probe that landed away from the sub-solar point. Re-measure
    //              with a consistent pose (`sweep()`) before concluding.
    const reflectance = (m.luma * Math.PI) / exp.sunIlluminance;
    const verdict =
      reflectance > 1
        ? `← IMPOSSIBLE: reflectance ${reflectance.toPrecision(3)} > 1, emits more than it receives`
        : ratio > 3
          ? "← too bright"
          : ratio < 0.5
            ? "← too dim (or the probe missed the sub-solar point — see below)"
            : "";
    console.log(
      [
        `${bodyId}:`,
        `  measured      ${m.luma.toPrecision(4)} units  (${Math.round(m.nits)} cd/m², EV ${m.ev.toFixed(1)})`,
        `  expected      ${exp.discUnits.toPrecision(4)} units  (${Math.round(exp.discNits)} cd/m², EV ${exp.discEv.toFixed(1)})`,
        `  ratio         ${ratio.toPrecision(4)}× vs disc-avg p·E/π  ${verdict}`,
        `  vs sub-solar  ${(m.luma / exp.subSolarUnits).toPrecision(4)}×  ← THE ONE TO READ (1.0 = a correct Lambert sphere at this probe geometry)`,
        `  implied refl. ${reflectance.toPrecision(4)}  (geometric albedo ${exp.geometricAlbedo}; R>1 is impossible, R<p is ambiguous)`,
        exp.note ? `  note: ${exp.note}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    return { measured: m, expected: exp, ratio, reflectance };
  }

  /**
   * ABLATE the multiple-scattering term (0) or restore it (1).
   *
   * The binary falsification test for Venus' measured ~16× excess
   * (docs/LIGHTING_PLAN.md §2.2.4). Run `__lum.compare("venus")` at 1 and at 0:
   *   • ratio collapses toward ~1  ⇒ the MS geometric series is the culprit;
   *     narrow it with `setFmsMax()`.
   *   • ratio stays ~16×           ⇒ single scattering is the culprit; the MS
   *     term is innocent and the search moves to the phase/normalisation path.
   * Forces a LUT re-bake, so it takes effect on the next frame.
   */
  setMsScale(scale: number): void {
    setMsScale(scale);
    console.log(`[lum] multiple-scattering scale = ${scale} (LUTs re-baking)`);
  }

  /**
   * Clamp F_ms before the 1/(1−F_ms) geometric series. 1 = unclamped.
   *
   * Ψ = L2nd/(1−F_ms) is ill-conditioned as F_ms → 1: on Venus the replica
   * measured F_ms = 0.9943 (a 174× amplification), where a 0.5% change in F_ms
   * moves the output 6×. Clamping bounds the amplification to 1/(1−x).
   * Try 0.95 (20×), 0.9 (10×), 0.8 (5×) and re-measure.
   */
  setFmsMax(maxFms: number): void {
    setFmsMax(maxFms);
    console.log(`[lum] F_ms clamp = ${maxFms} → max amplification ${(1 / (1 - Math.min(maxFms, 0.999999))).toFixed(1)}× (LUTs re-baking)`);
  }

  /**
   * Sweep the far cloud shell's effective optical path and re-bake its opacity
   * LUT. The knob that decides how much of the disc reads as cloud.
   *
   * At the shipped value of 1, Beer caps even a FULLY dense column at
   * 1 − e⁻¹ = 0.632, and the erosion in front of it (`saturate(d + carved − 1)`,
   * K_EFF = 1) zeroes any column with `carved < 1 − d` — two multiplicative
   * gates compounding, the same shape as the `profile × inScatter` bug in
   * CLOUD_DEBUGGING_LESSONS case #25.
   *
   * ⚠ A DIAGNOSTIC, NOT A FIX. The 1 was fitted down from 18 to match the
   * marcher at the 250–700 km handoff, so raising the shell alone fixes orbit
   * and tears the seam. Use it to size how much of Earth's 5.5× albedo deficit
   * the shell can account for, then move the marcher with it.
   *
   * Suggested ladder, measuring `__lum.disc("earth")` at each:
   *   1 (shipped) → 3 → 8 → 20.  Target: disc mean → 0.434, contrast staying ~8×.
   */
  setOpticalPath(path: number): void {
    setShellOpticalPath(path);
    const cap = 1 - Math.exp(-path);
    console.log(
      `[lum] shell optical path = ${path} → a fully dense column caps at ` +
        `${(cap * 100).toFixed(1)}% opacity (LUT re-baking; give it a frame). ` +
        `Then: await __lum.disc("earth")`,
    );
  }

  /**
   * Scale the SHARED cloud erosion K — the cloud-AREA knob, and the one lever
   * measurement says can actually close Earth's 5.5× disc-albedo deficit.
   *
   * Erosion is `eroded = saturate(d − (1−carved)·K)`. With K = 1 (cumulus), any
   * column whose carve field sits below `1 − d` vanishes outright, and the
   * weather map's cloudy texels carry d ≈ 0.2 (it is a reflectance-encoded
   * image read as a fraction — its cloud AREA is correct at 64% of the globe
   * above 0.10, only its VALUES are low). So the erosion deletes real cloud.
   *
   * ✅ Unlike `setOpticalPath`, this is applied inside `erosionKForType`, which
   * the shell's opacity LUT and the marcher's dense branch BOTH read — so near
   * and far move together and the 250–700 km handoff cannot tear. No
   * fix-both-sides-in-one-commit trap here.
   *
   * Ladder, with `await __lum.disc("earth")` after each:
   *   1 (shipped) → 0.7 → 0.5 → 0.3
   * ACCEPTANCE: p50 must rise much faster than p98 (that is what "more cloud
   * AREA" looks like), disc mean → 0.434, and p98/p02 contrast should stay
   * near 8.7. If p98 outruns p50, it is the wrong lever again.
   */
  setErosionScale(scale: number): void {
    setErosionScale(scale);
    console.log(
      `[lum] cloud erosion K × ${scale} (shell LUT re-baking; marcher live). ` +
        `Then: await __lum.disc("earth") — watch p50 vs p98.`,
    );
  }

  /**
   * Cloud sun scale — the Phase-2d brightness re-anchor, live.
   *
   * Physically `albedo/π` = 0.7/π ≈ **0.223**, half the shipped 0.45. Pair it
   * with a large `setOpticalPath`: PATH's physical value is an OPTICAL DEPTH
   * (τ = density × extinction × slab), so for a 14 km slab at density 0.25 with
   * cloud extinction 10–50/km, τ ≈ 35–175 — i.e. **~50–100, not 1**. At that
   * PATH most covered columns go opaque, which is how the missing cloud AREA
   * returns; 0.223 then keeps the tops at a physical reflectance instead of the
   * 0.749 overshoot measured at PATH 20 with 0.45.
   *
   * Both the shell (farCloudLit) and the marcher read this uniform, so near and
   * far stay in lockstep. Runtime only — no LUT re-bake needed.
   */
  setCloudSunScale(scale: number): void {
    setCloudSunScale(scale);
    console.log(
      `[lum] cloud sun scale = ${scale} (albedo/π = 0.223 is the physical value) ` +
        `→ implied cloud-top reflectance ≈ ${(scale * 0.725 * Math.PI).toFixed(3)}`,
    );
  }

  /**
   * Auto-exposure / eye-adaptation state (Phase 5).
   *
   * `metered` is the centre-weighted log-average EV of the frame; `target` is
   * what partial adaptation asks for; `adapted` is where the follower actually
   * is. **`target` ≠ `metered` is not a bug** — full adaptation would render deep
   * space and sunlit Mercury equally bright, undoing Phases 0–3. See
   * ADAPTATION_K in exposureMeter.ts (Stevens' ⅓ brightness exponent).
   */
  exposure(): void {
    const st = exposureMeterStatus();
    console.table({
      "metered EV (scene)": Number(st.meteredEV.toFixed(2)),
      "target EV (adapted)": Number(st.targetEV.toFixed(2)),
      "actual EV (follower)": Number(st.adaptedEV.toFixed(2)),
      "exposure multiplier": Number(getExposure().toPrecision(4)),
      "compensation (stops)": getExposureCompensation(),
      "samples this frame": st.samples,
      "EV p05 (darkest)": Number(st.dist.p05.toFixed(2)),
      "EV p50": Number(st.dist.p50.toFixed(2)),
      "EV p90": Number(st.dist.p90.toFixed(2)),
      "EV p98": Number(st.dist.p98.toFixed(2)),
      "EV max": Number(st.dist.max.toFixed(2)),
      "hot-tail flux share": `${(st.topFluxShare * 100).toFixed(0)}% (uncapped)`,
      "hot tail = top": `${(st.hotWeightFraction * 100).toFixed(0)}% of weight`,
      "hot share cap": `${(st.maxHotFluxShare * 100).toFixed(0)}%`,
      "hot tail LIFTS reading by": `${st.hotLiftStops.toFixed(2)} stops`,
      "compressor HELD BACK": `${st.hotClipStops.toFixed(2)} stops (unbounded)`,
      "hot compress exponent": st.hotCompressExponent,
      "centre sigma": st.centreSigma,
      "adaptation k": st.adaptationK,
      "output bias (stops)": st.biasStops,
      "anchor EV": st.anchorEV,
      "PINNED (manual)": st.manual,
    });
    if (st.hotClipStops > 0.05) {
      console.log(
        `[lum] HOT-TAIL CAP is active: the brightest ${(st.hotWeightFraction * 100).toFixed(0)}% of ` +
          `weight wanted ${(st.topFluxShare * 100).toFixed(0)}% of total flux, capped to ` +
          `${(st.maxHotFluxShare * 100).toFixed(0)}% before compression. It LIFTS the reading ` +
          `${st.hotLiftStops.toFixed(2)} stops above the rest of the frame, and the compressor HELD ` +
          `BACK ${st.hotClipStops.toFixed(2)} stops relative to a raw flux mean. ⚠ Those are two ` +
          `different numbers — "held back" is unbounded ON PURPOSE. Expect this whenever a small ` +
          `un-calibrated emissive (engine plume, VFX) is on screen. See D26.`,
      );
    }
    console.log(
      "[lum] ⚠ EVs here are GAME-UNIT EVs (log2(units×8)), NOT the cd/m² EVs the " +
        "probe tables print — they differ by ~12.6 stops. If `metered` sits far " +
        "from p90/p98 the band is landing on the wrong part of the scene.",
    );
    if (st.manual) {
      console.warn(
        "[lum] exposure is PINNED — auto-exposure is not running. __lum.auto() to release.",
      );
    } else {
      console.log(
        `[lum] partial adaptation: a ${(1 - st.adaptationK).toFixed(2)}× slope, so a ` +
          `44-stop world presents as ~${(44 * (1 - st.adaptationK)).toFixed(0)} stops. ` +
          `Full adaptation (k=1) would flatten it to 0.`,
      );
    }
  }

  /**
   * Direct-sun state on the LOCAL scene (ship/asteroids) — eclipses, umbra,
   * atmospheric transmittance, and the hull self-bounce fill (defect D27).
   *
   * Read this when the ship looks wrongly bright or wrongly dark. `visibility`
   * is the fraction of the star's DISC that is geometrically unobstructed;
   * `transmittance` is what the atmosphere pass left of the sun for the DOMINANT
   * body (it hard-zeroes on its own ground hit, so 0,0,0 there means "in that
   * body's shadow"). The two have separate owners on purpose — see
   * space/sunOcclusion.ts "DIVISION OF LABOUR".
   */
  sun(): void {
    const st = sunOcclusionStatus();
    const dominant = getDominantAtmosphereBody();
    const t = st.transmittance;
    // What the hull's shadow side actually receives, so this table can be
    // compared directly against `__lum.probe()` on the ship.
    const tMean = (t[0] + t[1] + t[2]) / 3;
    const fillRadiance = (st.fillIntensity * tMean * st.visibility) / Math.PI;
    console.table({
      "sun disc visible": `${(st.visibility * 100).toFixed(1)}%`,
      "atmo transmittance": t.map((v) => Number(v.toFixed(4))).join(", "),
      "dominant body": dominant?.id ?? "(none — deep space)",
      "illuminance (game)": Number(st.illuminance.toPrecision(4)),
      "illuminance (lux)": Number((st.illuminance * NITS_PER_GAME_UNIT).toPrecision(4)),
      "key light (game)": Number((st.illuminance * tMean * st.visibility).toPrecision(4)),
      "bounce fill (game)": Number((st.fillIntensity * tMean * st.visibility).toPrecision(4)),
      "fill → albedo-1 hull": `${(fillRadiance * NITS_PER_GAME_UNIT).toPrecision(3)} cd/m²`,
      "occluders registered": st.registered,
    });
    if (st.occluding.length === 0) {
      console.log(
        "[lum] nothing geometrically eclipsing the star" +
          (dominant
            ? ` (${dominant.id} is dominant, so ITS shadow is in transmittance above, not here)`
            : ""),
      );
    } else {
      console.log("[lum] bodies covering the star's disc:");
      console.table(
        st.occluding.map((o) => ({
          body: o.id,
          "covers": `${(o.covered * 100).toFixed(1)}%`,
          "ang. radius (°)": Number(o.angOccDeg.toFixed(3)),
          "separation (°)": Number(o.angSepDeg.toFixed(3)),
          "distance (km)": Number(o.distKm.toPrecision(4)),
        })),
      );
    }
    if (st.visibility > 0.999 && tMean > 0.999) {
      console.log("[lum] the ship is in FULL sun — nothing is shadowing it.");
    }
  }

  /**
   * Warp into a body's UMBRA and report the resulting sun occlusion (D27).
   *
   * `await __lum.eclipse("luna")` is the canonical check that a body with no
   * atmosphere casts a shadow at all; `__lum.eclipse("neptune")` checks that an
   * atmosphere body's shadow survives past its LOD gate. The ship should go
   * essentially black — the only thing lighting it in an umbra is starlight and
   * the planet's sunlit crescent (planetshine, Phase 4).
   */
  async eclipse(bodyId: string, radiiBehind = 4): Promise<void> {
    this.store.set(devTeleportAtom, resolveUmbraWarp(bodyId, radiiBehind));
    await sleepFrames(120);
    console.log(
      `[lum] in ${bodyId}'s umbra, ${radiiBehind} body radii down-sun of centre:`,
    );
    this.sun();
  }

  /**
   * Force a FIXED source pre-exposure, to test D25's core invariance.
   *
   * **The image must not change.** The post chain divides out exactly what the
   * sources multiplied in, so `__lum.preExposure(8)` should be visually
   * indistinguishable from `__lum.preExposure(1)`. Anything that DOES change
   * brightness is a radiance source that was never pre-exposed — the region that
   * moves localises the missed site. Call with no argument to hand control back
   * to the exposure follower.
   */
  preExposure(factor?: number): void {
    setPreExposureOverride(factor ?? null);
    if (factor === undefined) {
      console.log(
        `[lum] pre-exposure released to the exposure follower (now ×${getPreExposure().toPrecision(4)})`,
      );
      return;
    }
    console.log(
      [
        `[lum] pre-exposure PINNED at ×${factor}`,
        `  The image should look IDENTICAL to __lum.preExposure(1).`,
        `  Anything that brightens/darkens by ~${factor}× is a source that`,
        `  is missing its × getPreExposure() — the moving region names it.`,
        `  Absolute readings (probe/disc/compare) are corrected automatically.`,
      ].join("\n"),
    );
  }

  /**
   * **THE STAR GATE** (STAR_CATALOGUE_PLAN.md §9 / S2). Aim at a NAMED star and
   * measure it.
   *
   *     await __lum.star("Sirius")
   *
   * Everything before this only proved the star pipeline was self-consistent. This
   * is the check that it is *correct*: it takes the star's published magnitude,
   * converts to illuminance, applies the PSF normalisation THE SHADER IS ACTUALLY
   * USING this frame, and compares against a probe of the centre pixel.
   *
   * ⚠ The expected value is the PSF **peak**, not `E / Ω_pixel`. With σ = 1 px a
   * star's flux spreads over 2πσ² ≈ 6.3 px², so Sirius peaks near 2.4 cd/m² while
   * still carrying its full 14.9 cd/m²-equivalent flux. Reading the gate as
   * "flux ÷ one pixel" would look like a 6× failure when nothing is wrong.
   *
   * It also validates the equatorial → game-frame rotation end to end: the name
   * lookup is in the catalogue's equatorial frame, the camera is aimed through
   * `StarField`'s own `equatorialToGame`, so a wrong rotation puts empty sky at
   * the centre and the probe reads ~0.
   */
  async star(name: string, radiiBehind = 400): Promise<void> {
    if (!_namedStars) {
      const res = await fetch("/data/stars_named.json");
      if (!res.ok) {
        console.error(`[lum] no /data/stars_named.json (${res.status})`);
        return;
      }
      _namedStars = (await res.json()) as NamedStar[];
      console.log(`[lum] loaded ${_namedStars.length} named stars`);
    }
    const key = name.trim().toLowerCase();
    const star =
      _namedStars.find((s2) => s2.name.toLowerCase() === key) ??
      _namedStars.find((s2) => s2.name.toLowerCase().startsWith(key));
    if (!star) {
      const near = _namedStars
        .filter((s2) => s2.name.toLowerCase().includes(key))
        .slice(0, 8)
        .map((s2) => s2.name);
      console.error(
        `[lum] "${name}" not found.` +
          (near.length ? ` Did you mean: ${near.join(", ")}?` : ""),
      );
      return;
    }

    // Measure from deep inside Neptune's umbra: the darkest sky available, no sun
    // in frame, and the panorama's diffuse floor at its least intrusive.
    const dark = resolveUmbraWarp("neptune", radiiBehind);
    equatorialToGame(_starDir, star.posEqLy[0], star.posEqLy[1], star.posEqLy[2]);
    _starDir.normalize();
    this.store.set(
      devTeleportAtom,
      resolveLookDirectionWarp(_starDir, dark.positionKm),
    );
    await sleepFrames(150);

    const psfNorm = getStarPsfNorm();
    const illum = starIlluminanceGame(star.magV);
    // ⚠ COMPARE FLUX, NOT PEAK. The first version of this gate compared the peak
    // and reported 0.7087× for Sirius, Vega AND Betelgeuse — identical to four
    // figures across three magnitudes and two very different colours, i.e. a
    // systematic factor, not an error. The cause is that aiming dead-centre puts
    // the star on a pixel CORNER (the exact centre of an even-sized buffer), so
    // its true peak is never sampled. The pixel SUM is 2πσ² regardless of
    // sub-pixel placement, so integrating removes the artefact entirely — and
    // flux is what the design actually promises to conserve.
    //
    // A peak comparison that passes at 0.71 is a gate with a badly chosen
    // tolerance, not a validated renderer.
    const expectedPeak = illum * psfNorm;
    // 2πσ² pixels of effective area — the Gaussian's normalisation.
    const psfPixelArea = 2 * Math.PI * STAR_PSF_SIGMA_PX * STAR_PSF_SIGMA_PX;
    const expectedFlux = expectedPeak * psfPixelArea;
    const f = await this.probeFlux(15);
    const m = await this.probeMax(9);
    if (!f || !m) {
      console.error("[lum] probe failed — is the scene rendering?");
      return;
    }
    // ⚠ DIVIDE OUT THE ARTISTIC GAIN so this gate keeps measuring PHYSICS. The
    // gain is a display knob applied after the photometric conversion; if it were
    // left in, the gate would report 1.0 only when the look happened to match the
    // physics, and would "fail" the moment anyone tuned the sky — i.e. it would be
    // certifying the art. Reported separately below so it is never invisible.
    // ⚠ AND divide out the MAGNITUDE COMPRESSION, which unlike the gain is
    // per-star: γ ≠ 1 scales each star by `starCompressionFactor(magV)`, so a single
    // constant cannot undo it. Miss this and the gate reads 1.0 only for stars at
    // the anchor magnitude and drifts smoothly with brightness everywhere else —
    // which would look exactly like a photometric bug in the renderer.
    const lookGain =
      STAR_ARTISTIC_GAIN * starCompressionFactor(star.magV);
    // ⚠ Subtract the sky from the PEAK too, or the σ solve below inherits the bias.
    // `probeMax` reads a raw pixel; the background estimate comes from probeFlux's
    // annulus, which is the only place it is measured.
    const physicalFlux = f.sumLuma / Math.max(lookGain, 1e-12);
    const physicalPeak =
      Math.max(m.luma - f.backgroundPerPx, 0) / Math.max(lookGain, 1e-12);
    const ratio = physicalFlux / Math.max(expectedFlux, 1e-30);
    console.table({
      star: star.name,
      "magnitude V": star.magV,
      "B−V": star.colorBV,
      "illuminance (lux)": Number((illum * NITS_PER_GAME_UNIT).toPrecision(4)),
      "PSF σ (px)": STAR_PSF_SIGMA_PX,
      "expected FLUX (Σ game)": Number(expectedFlux.toPrecision(4)),
      "measured FLUX (Σ game)": Number(physicalFlux.toPrecision(4)),
      "sky subtracted (Σ game)": Number(
        ((f.sumLumaRaw - f.sumLuma) / Math.max(lookGain, 1e-12)).toPrecision(4),
      ),
      "sky was % of raw sum": Number(
        (100 * (1 - f.sumLuma / Math.max(f.sumLumaRaw, 1e-30))).toPrecision(3),
      ),
      "artistic gain (divided out)": STAR_ARTISTIC_GAIN,
      "mag compression (divided out)": Number(
        starCompressionFactor(star.magV).toPrecision(4),
      ),
      "total look gain (divided out)": Number(lookGain.toPrecision(4)),
      "FLUX measured / expected": Number(ratio.toPrecision(4)),
      "— peak, for reference —": "",
      "expected peak (cd/m²)": Number((expectedPeak * NITS_PER_GAME_UNIT).toPrecision(4)),
      "measured peak (cd/m²)": Number(
        (physicalPeak * NITS_PER_GAME_UNIT).toPrecision(4),
      ),
      "peak ratio (grid-dependent)": Number(
        (physicalPeak / Math.max(expectedPeak, 1e-30)).toPrecision(4),
      ),
      "measured RGB": m.units.map((v) => Number(v.toPrecision(3))).join(", "),
    });

    // ── Solve the ACTUAL on-screen PSF from the two measurements ──────────────
    // Two unknowns (the rendered σ in screen pixels, and how far off a pixel
    // centre the star landed) against two measurements (flux ratio and peak
    // ratio), so both are determined:
    //     fluxRatio = (σ_screen / σ_intended)²      (amplitude cancels)
    //     peakRatio = exp(−r_offset² / (2 σ_screen²))
    //
    // 🐛 ⚠⚠ THE FIRST VERSION CONFLATED A DIMENSIONLESS SCALE WITH A LENGTH.
    // `sqrt(fluxRatio)` is the scale factor σ_screen/σ_intended, but it was printed
    // as "solved σ on screen (px)" — and it was INVISIBLE for months because
    // `PSF_SIGMA_PX` was exactly 1.0, the one value where a ratio and an absolute σ
    // are numerically identical. Setting σ = 0.85 exposed it instantly: the label
    // read 1.017 px for an intended 0.85, which looks like a 20% rendering error and
    // is actually 1.7%.
    //
    // The offset inherited the same bug — it used `ratio` where σ_screen² IN PIXELS²
    // belongs, inflating a true 0.508 px to 0.597. 🔑 Same lesson as the `fov/height`
    // small-angle bug this table was built to catch: **a factor of 1 hides a unit
    // error perfectly.** Anything printed with a unit must be constructed with one.
    const peakRatio = physicalPeak / Math.max(expectedPeak, 1e-30);
    const sigmaScale = Math.sqrt(Math.max(ratio, 1e-12));
    const sigmaScreenPx = STAR_PSF_SIGMA_PX * sigmaScale;
    const rOffset = Math.sqrt(
      Math.max(
        0,
        -2 * sigmaScreenPx * sigmaScreenPx * Math.log(Math.max(peakRatio, 1e-12)),
      ),
    );
    const inputs = getStarPsfInputs();
    const src = lumSourceStatus();
    console.table({
      "solved σ on screen (px)": Number(sigmaScreenPx.toPrecision(4)),
      "intended σ (px)": STAR_PSF_SIGMA_PX,
      "σ scale (solved / intended)": Number(sigmaScale.toPrecision(4)),
      "sprite renders (px wide)": Number((sigmaScale * 8).toPrecision(4)),
      "intended (px wide)": 8,
      "sprite scale error": `${((sigmaScale - 1) * 100).toFixed(1)}% ${
        sigmaScale >= 1 ? "LARGER" : "smaller"
      } than intended`,
      "solved sampling offset (px)": Number(rOffset.toPrecision(4)),
      "  (expect ~0.5 — dead centre of an even buffer is a pixel CORNER)": "",
      "— raw inputs —": "",
      "camera fov (deg)": Number(inputs.fovDeg.toPrecision(4)),
      "drawing buffer height": inputs.bufferH,
      "RENDER TARGET height": src.height,
      "⚠ buffer / target": Number(
        (inputs.bufferH / Math.max(src.height, 1)).toPrecision(4),
      ),
      "devicePixelRatio": window.devicePixelRatio,
      "projection u/tan(u)": Number(
        (((inputs.fovDeg * Math.PI) / 360) /
          Math.tan((inputs.fovDeg * Math.PI) / 360)).toPrecision(4),
      ),
    });
    console.log(
      "[lum] If `buffer / target` is not 1.0, StarField is sizing its sprites " +
        "against a different resolution than the scene rasterises into. " +
        "`projection u/tan(u)` is the small-angle error in pxAngle — it can only " +
        "ever be ≤ 1, so a solved σ ABOVE that product needs a third explanation.",
    );
    // Tight, because flux is placement-independent: ±10% leaves room for the
    // half-float buffer and the 15×15 window's clipped tail, and nothing else.
    // The old ±40% band was wide enough to pass a 29% systematic error.
    if (ratio > 0.9 && ratio < 1.1) {
      console.log(
        `[lum] ✅ GATE PASSED — ${star.name}'s FLUX is within ` +
          `${(Math.abs(ratio - 1) * 100).toFixed(1)}% of its published magnitude.`,
      );
    } else if (ratio < 0.05) {
      console.warn(
        "[lum] ⚠ essentially nothing at the centre. Either the equatorial → game " +
          "rotation is wrong (empty sky is being aimed at), or StarField is not mounted.",
      );
    } else {
      console.warn(
        `[lum] ⚠ GATE FAILED on FLUX at ${ratio.toPrecision(3)}× — ` +
          `${Math.abs(Math.log2(ratio)).toFixed(2)} stops ` +
          `${ratio > 1 ? "BRIGHT" : "DIM"}. Suspect the PSF normalisation, the ` +
          "pixel-solid-angle uniform, or a double pre-exposure.",
      );
    }
  }

  /**
   * Aim at an equatorial (RA/Dec, J2000) sky direction from a dark vantage.
   *
   *     __lum.aim(17.7611, -29.0078, "galactic centre")   // Sgr A*
   *     __lum.aim(5.5883,   -1.2019, "Orion's belt (Alnilam)")
   *     __lum.aim(0, 90, "north celestial pole")           // Polaris ~0.7° away
   *
   * 🔑 **This is how to check the PANORAMA's orientation**, which cannot be
   * validated on its own — an all-sky image has no landmark whose position we know
   * independently. But the star catalogue IS validated (flux to 0.999×, positions
   * to 0.07°), so it can be used as the reference: aim at the galactic centre and
   * the Milky Way's core should be dead centre, with catalogue stars sitting ON the
   * band rather than beside it. Any offset is the panorama's, not the catalogue's.
   *
   * Uses `StarField`'s own `equatorialToGame`, so it tests the shipped rotation
   * rather than a second copy of it.
   */
  aim(raHours: number, decDeg: number, label = ""): void {
    const ra = (raHours * 15 * Math.PI) / 180;
    const dec = (decDeg * Math.PI) / 180;
    // Equatorial unit vector: +x to the vernal equinox, +z to the celestial pole.
    equatorialToGame(
      _starDir,
      Math.cos(dec) * Math.cos(ra),
      Math.cos(dec) * Math.sin(ra),
      Math.sin(dec),
    );
    _starDir.normalize();
    const dark = resolveUmbraWarp("neptune", 400);
    this.store.set(
      devTeleportAtom,
      resolveLookDirectionWarp(_starDir, dark.positionKm),
    );
    const latDeg = (Math.asin(_starDir.y) * 180) / Math.PI;
    const lonDeg =
      ((Math.atan2(-_starDir.z, _starDir.x) * 180) / Math.PI + 360) % 360;
    console.log(
      `[lum] aiming at RA ${raHours}h Dec ${decDeg}°${label ? ` (${label})` : ""} → ` +
        `game dir (${_starDir.x.toFixed(4)}, ${_starDir.y.toFixed(4)}, ${_starDir.z.toFixed(4)}), ` +
        `ecliptic lat ${latDeg.toFixed(2)}° lon ${lonDeg.toFixed(2)}°`,
    );
    console.log(
      "[lum] give adaptation a second, then check what is at the CENTRE of frame.",
    );
  }

  /**
   * SKYBOX ORIENTATION GATE — is the Milky Way panorama aligned with the sky?
   *
   *     await __lum.skyAlign()
   *
   * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
   * The panorama was misaligned for FOUR attempts, and every attempt that
   * "verified" it verified the wrong thing:
   *   • `geo.scale(-1,1,1)` then `side: BackSide` — guessed, wrong.
   *   • a derived `rotX(π−ε)` — guessed, wrong (no rotation can undo a mirror).
   *   • an explicit UV formula checked to 1e-14 against the equirect DEFINITION —
   *     correct about the definition, which was never the unknown.
   *   • `aim()` at Orion and at the celestial pole "looking right" — those tests
   *     were exercising the STAR CATALOGUE, which is drawn as geometry and never
   *     touched the panorama's UVs at all.
   *
   * 🔑 So this gate does not aim at anything and ask a human to look. It measures
   * the one thing that must be true if the panorama is aligned and cannot be true
   * if it is not: **the light has to be concentrated at galactic latitude 0.**
   * Landmarks are specified in GALACTIC coordinates precisely so the intent is
   * unarguable — b = 0 is the band and must be bright, b = ±90 is the galactic
   * pole and must be dark. A misaligned panorama puts band on pole and the
   * contrast collapses toward 1.
   *
   * Measures the MEDIAN of a 31×31 window, not the mean: a catalogue star landing
   * in the window would dominate a mean, and this gate is about the diffuse layer.
   * `SKY_ARTISTIC_GAIN` is divided out so it keeps measuring physics.
   */
  async skyAlign(settleFrames = 150): Promise<{
    pass: boolean;
    contrast: number;
    monotone: boolean;
    bandMinNits: number;
    poleMaxNits: number;
  } | null> {
    // Galactic → equatorial, from the IAU definition: the north galactic pole and
    // the l = 0, b = 0 direction, J2000. Built as an orthonormal frame (x̂ is
    // re-projected perpendicular to ẑ — the two published directions are 0.01° from
    // orthogonal) so the conversion is exact rather than nearly exact.
    const dir = (raDeg: number, decDeg: number): [number, number, number] => {
      const ra = (raDeg * Math.PI) / 180;
      const dec = (decDeg * Math.PI) / 180;
      return [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
    };
    const gz = dir(192.85948, 27.12825); // north galactic pole
    const gcRaw = dir(266.40510, -28.93617); // l = 0, b = 0
    const d0 = gz[0] * gcRaw[0] + gz[1] * gcRaw[1] + gz[2] * gcRaw[2];
    const gxU = gcRaw.map((c, i) => c - gz[i] * d0);
    const gxN = Math.hypot(gxU[0], gxU[1], gxU[2]);
    const gx = gxU.map((c) => c / gxN);
    const gy = [
      gz[1] * gx[2] - gz[2] * gx[1],
      gz[2] * gx[0] - gz[0] * gx[2],
      gz[0] * gx[1] - gz[1] * gx[0],
    ];
    const galToEq = (lDeg: number, bDeg: number): [number, number, number] => {
      const l = (lDeg * Math.PI) / 180;
      const b = (bDeg * Math.PI) / 180;
      const cb = Math.cos(b);
      return [0, 1, 2].map(
        (i) => cb * Math.cos(l) * gx[i] + cb * Math.sin(l) * gy[i] + Math.sin(b) * gz[i],
      ) as [number, number, number];
    };

    // ⚠⚠ THE FIRST VERSION OF THIS GATE FAILED A CORRECTLY-ALIGNED SKY, and the bug
    // was the METRIC, not the renderer. It compared `min(band) / max(off-band)` with
    // "off-band" meaning b = ±20 at l = 0 — and **b = ±20 at l = 0 is still the
    // galactic BULGE**, which is brighter than the band's own faint stretches. The
    // band's surface brightness varies ~6× along its length (l = 270 measures 0.17 of
    // the centre), so that ratio divided the dimmest band point by a bulge sample and
    // came out at 0.81×. Verified offline too: `solve_sky_orientation.py` §11 prints
    // the same three ratios on the raw asset — 7.93×, 38.55× and 0.56× for the same,
    // correct alignment.
    //
    // 🔑 The lesson generalises past this file: **a gate is only as good as the
    // quantity it compares.** A tolerance can be wrong by being tight on the wrong
    // measurement, exactly as it can be wrong by being loose on the right one (the
    // ±40% star-gate lesson). Both ship a renderer whose state you do not know.
    //
    // So this gate asserts the two things that are actually diagnostic:
    //   1. every b = 0 point beats every |b| = 90 point by ≥3×, and
    //   2. brightness falls MONOTONICALLY with |b| at fixed longitude.
    // (2) is the real signature: a misaligned panorama cannot produce it, because its
    // band crosses the latitude ladder at some other angle. Longitude variation is
    // divided out by comparing only along a meridian.
    const marks: Array<{ l: number; b: number; what: string }> = [
      { l: 0, b: 0, what: "galactic centre" },
      { l: 90, b: 0, what: "band, l=90" },
      { l: 180, b: 0, what: "anticentre" },
      { l: 270, b: 0, what: "band, l=270 (a genuinely FAINT stretch)" },
      { l: 0, b: 20, what: "b=+20 (still bulge!)" },
      { l: 0, b: -20, what: "b=-20 (still bulge!)" },
      { l: 0, b: 40, what: "b=+40" },
      { l: 0, b: -40, what: "b=-40" },
      { l: 0, b: 60, what: "b=+60 (Big Dipper's latitude)" },
      { l: 0, b: -60, what: "b=-60" },
      { l: 0, b: 90, what: "north galactic pole" },
      { l: 0, b: -90, what: "south galactic pole" },
    ];

    if (!_source) {
      console.error("[lum] no render source — is the scene rendering?");
      return null;
    }
    const dark = resolveUmbraWarp("neptune", 400);
    // The eye sits radially OUTSIDE Neptune on the anti-sun line, so the sun (and
    // Neptune's dark disc in front of it) is at −normalize(eye). Reported per row:
    // a landmark that happens to point that way is measuring an eclipsed disc, not
    // sky, and that must not be invisible in the table.
    const en = Math.hypot(...dark.positionKm);
    const sunDir = dark.positionKm.map((c) => -c / en);

    const rows: Record<string, Record<string, string>> = {};
    const measured = new Map<string, number>();
    const N = 31;

    for (const m of marks) {
      const eq = galToEq(m.l, m.b);
      equatorialToGame(_starDir, eq[0], eq[1], eq[2]);
      _starDir.normalize();
      this.store.set(
        devTeleportAtom,
        resolveLookDirectionWarp(_starDir, dark.positionKm),
      );
      await sleepFrames(settleFrames);

      const { renderer, target } = _source;
      const half = Math.floor(N / 2);
      const cx = Math.round(target.width / 2) - half;
      const cy = Math.round(target.height / 2) - half;
      const buf = await renderer.readRenderTargetPixelsAsync(target, cx, cy, N, N);
      const isHalf = buf instanceof Uint16Array;
      const isByte = buf instanceof Uint8Array;
      const a = buf as unknown as ArrayLike<number>;
      const stride = rowStrideElements(N, isHalf ? 2 : isByte ? 1 : 4);
      const lumas: number[] = [];
      for (let row = 0; row < N; row++) {
        for (let col = 0; col < N; col++) {
          const [r, g, b] = decodeRgb(a, row * stride + col * 4, isHalf, isByte);
          lumas.push(REC709[0] * r + REC709[1] * g + REC709[2] * b);
        }
      }
      lumas.sort((x, y) => x - y);
      const median = lumas[Math.floor(lumas.length / 2)];
      const physical = median / Math.max(SKY_ARTISTIC_GAIN, 1e-12);
      const nits = physical * NITS_PER_GAME_UNIT;
      measured.set(`${m.l},${m.b}`, nits);
      const sunAng =
        (Math.acos(
          Math.max(-1, Math.min(1, _starDir.x * sunDir[0] + _starDir.y * sunDir[1] + _starDir.z * sunDir[2])),
        ) *
          180) /
        Math.PI;
      rows[`gal l=${m.l} b=${m.b >= 0 ? "+" : ""}${m.b}`] = {
        what: m.what,
        "median cd/m²": nits.toExponential(3),
        "vs sky mean": `${(nits / 8.05e-5).toFixed(2)}×`,
        "° from sun": sunAng.toFixed(0) + (sunAng < 5 ? " ⚠ Neptune in frame" : ""),
      };
    }
    console.table(rows);

    const at = (l: number, b: number) => measured.get(`${l},${b}`) ?? 0;
    const bandMin = Math.min(...[0, 90, 180, 270].map((l) => at(l, 0)));
    const poleMax = Math.max(at(0, 90), at(0, -90));
    const contrast = bandMin / Math.max(poleMax, 1e-30);

    // Monotone falloff along each meridian arm. A 1.25× slack per rung absorbs the
    // faint-end noise (a 31×31 median at ~1e-5 cd/m² sits near the half-float floor
    // even with pre-exposure) without admitting a real reversal.
    const SLACK = 1.25;
    const arms: Array<[string, number[]]> = [
      ["b = 0 → +20 → +40 → +60 → +90", [0, 20, 40, 60, 90]],
      ["b = 0 → −20 → −40 → −60 → −90", [0, -20, -40, -60, -90]],
    ];
    let monotone = true;
    for (const [label, ladder] of arms) {
      const vals = ladder.map((b) => at(0, b));
      const steps = vals
        .slice(0, -1)
        .map((v, i) => `${(vals[i + 1] / Math.max(v, 1e-30)).toFixed(2)}×`);
      const ok = vals.every((v, i) => i === 0 || v <= vals[i - 1] * SLACK);
      if (!ok) monotone = false;
      console.log(
        `[lum] ${ok ? "✓" : "✗"} ${label}:  ` +
          vals.map((v) => v.toExponential(2)).join("  →  ") +
          `   (ratios ${steps.join(" ")})`,
      );
    }
    console.log(
      `[lum] faintest b=0 point ${bandMin.toExponential(3)} cd/m²,  ` +
        `brightest galactic pole ${poleMax.toExponential(3)} cd/m²  →  ${contrast.toFixed(2)}×`,
    );
    // ⚠ Compare b=0 against |b|=90 ONLY. The poles are the one place on the sky that
    // is unambiguously off the band; every intermediate latitude at l≈0 still catches
    // bulge. Measured on this asset: 7.93× offline, ~7× in-engine, so 3× is a floor a
    // misalignment cannot sneak past — a wrong orientation drives this toward 1.
    if (contrast >= 3 && monotone) {
      console.log(
        `[lum] ✅ SKY ALIGNED — band/pole ${contrast.toFixed(2)}× ≥ 3 and brightness falls\n` +
          "      monotonically with galactic latitude on both arms.",
      );
    } else if (contrast >= 3) {
      console.error(
        "[lum] ⚠ band/pole contrast is fine but the latitude falloff is NOT monotone.\n" +
          "      Either the sky is subtly rotated, or a bright body is in frame for one\n" +
          "      of the landmarks — check the '° from sun' column above.",
      );
    } else {
      console.error(
        `[lum] ❌ SKY MISALIGNED — band/pole ${contrast.toFixed(2)}× < 3. The panorama's\n` +
          "      bright band is not sitting on galactic latitude 0. Re-run\n" +
          "      `python3 scripts/solve_sky_orientation.py <panorama>` and compare its\n" +
          "      answer with the u/v formula in MilkyWaySkybox.tsx.",
      );
    }
    console.log(
      "[lum] cross-check by eye: __lum.aim(12.2570, 56.382, 'Big Dipper') — galactic\n" +
        "      latitude +60°, so it must sit FAR off the band. That is the check that\n" +
        "      exposed the original misalignment when four others had passed.",
    );
    // Returned as well as logged, so the gate can be asserted on rather than read.
    return {
      pass: contrast >= 3 && monotone,
      contrast,
      monotone,
      bandMinNits: bandMin,
      poleMaxNits: poleMax,
    };
  }

  /**
   * SKY IRRADIANCE GATE — is the SH-L2 light probe correct? (S4 / D29)
   *
   *     __lum.skyProbe()
   *
   * ── WHY THIS CAN BE AN EXACT GATE, UNLIKE MOST LIGHTING CHECKS ────────────
   * Diffuse irradiance from an environment is normally only checkable against a
   * reference render. But SH-L2 has two closed-form consequences, and they pin the
   * convention AND the truncation with no renderer involved:
   *
   *   1. **A uniform sky of radiance L gives irradiance exactly πL** on every
   *      normal. Band 0 alone: `0.886227 × (L·0.282095·4π) = πL`, and all higher
   *      bands are identically zero. Any error in the basis normalisation, the
   *      solid-angle weighting, or the Â_l constants breaks this immediately.
   *   2. **A single source of illuminance E gives exactly 1.0625·E** at its own
   *      direction, because `Σ_l Â_l (2l+1)/4π = [π + 3(2π/3) + 5(π/4)]/4π =
   *      4.25π/4π`. 🔑 That 6.25% overshoot is SH-L2 RINGING — a known property of
   *      truncating at band 2, not an error. Asserting it means the gate would also
   *      catch someone "fixing" it, which would be the real bug.
   *
   * Then it reports the SHIPPED sky, whose absolute level cannot be derived in
   * closed form but whose SHAPE can be sanity-checked: irradiance must peak toward
   * the galactic plane and trough toward the poles, mirroring `skyAlign()`.
   *
   * ⚠ Everything here evaluates through `evaluateShIrradiance`, a transcription of
   * three's own `getShIrradianceAt` constants, so the gate measures the shipping
   * evaluator rather than a second implementation of it.
   */
  skyProbe(): void {
    // ⚠ TOLERANCE IS BOUNDED BELOW BY THE REFERENCE CONSTANTS, not by the maths.
    // three publishes its SH constants rounded to 6 decimals (0.282095 for
    // 1/(2√π) = 0.2820947917…, and so on), each carrying ~1e-6 of relative error;
    // summed over nine terms that reaches ~1.6e-6. A 1e-6 tolerance therefore FAILS
    // a perfectly correct implementation — it did, on the first run of this gate —
    // while a real defect here (a wrong basis normalisation, a missing sinθ weight,
    // a dropped Â_l) is percent-level or worse. So 1e-5: an order of magnitude above
    // the achievable floor and four below anything that could actually be wrong.
    const SH_TOL = 1e-5;
    const mk = (): ShCoefficients =>
      Array.from({ length: 9 }, () => new Vector3());
    const NORMALS: Array<[string, [number, number, number]]> = [
      ["+x", [1, 0, 0]],
      ["−x", [-1, 0, 0]],
      ["+y (ecliptic N)", [0, 1, 0]],
      ["−y", [0, -1, 0]],
      ["+z", [0, 0, 1]],
      ["diagonal", [0.5774, 0.5774, 0.5774]],
    ];

    // ── Test 1: uniform sky ⇒ πL exactly, on EVERY normal ──────────────────
    const L = 3.7;
    const uni = mk();
    // Project a constant radiance analytically: coeff_i = L·∫Y_i dω, which is
    // L·0.282095·4π for band 0 and exactly 0 for every other band.
    uni[0].set(L, L, L).multiplyScalar(0.282095 * 4 * Math.PI);
    let uniWorst = 0;
    for (const [, n] of NORMALS) {
      const e = evaluateShIrradiance(uni, n[0], n[1], n[2]);
      uniWorst = Math.max(uniWorst, Math.abs(e[0] / (Math.PI * L) - 1));
    }

    // ── Test 2: one point source ⇒ 1.0625·E at its own direction ───────────
    const E = 0.25;
    // ⚠ NORMALISE, don't trust a hand-typed "unit" vector. The first version of
    // this gate used [0.2673, 0.5345, 0.8018], whose length is 1.000011 — and the
    // 1.1e-5 error propagated straight into the band-2 terms and failed a 1e-6
    // tolerance on machinery that was perfectly correct. A gate that is less exact
    // than its own tolerance reports bugs it invented.
    const dRaw = new Vector3(1, 2, 3).normalize();
    const d: [number, number, number] = [dRaw.x, dRaw.y, dRaw.z];
    const pt = mk();
    accumulatePointSource(pt, d[0], d[1], d[2], E, 1, 1, 1);
    // Three exact values, all from E(θ)/E = ¼ + ½cosθ + (5/32)(3cos²θ − 1), which
    // is Σ_l Â_l (2l+1)/(4π) P_l(cosθ) — the SH-L2 reconstruction of a delta source.
    //
    // 🐛 The first version asserted only "the opposite lobe should be NEGATIVE",
    // and that was WRONG: since Y_lm(−d) = (−1)^l Y_lm(d), the antipode is
    // [Â₀ − 3Â₁ + 5Â₂]/4π = +1/16 exactly. The lobe does go negative — but at
    // cos θ = −8/15 (θ = 122.2°), where it reaches exactly −19/480. Asserting a
    // SIGN at the wrong angle taught nothing; asserting three closed-form values
    // pins the whole reconstruction.
    const atSource = evaluateShIrradiance(pt, d[0], d[1], d[2])[0];
    const RING = (Math.PI + 3 * ((2 * Math.PI) / 3) + 5 * (Math.PI / 4)) /
      (4 * Math.PI); // = 1.0625 = 17/16
    const opp = evaluateShIrradiance(pt, -d[0], -d[1], -d[2])[0];
    const OPP_EXACT = (Math.PI - 3 * ((2 * Math.PI) / 3) + 5 * (Math.PI / 4)) /
      (4 * Math.PI); // = 0.0625 = 1/16
    // The true minimum, at cos θ = −8/15. Build that direction by rotating d.
    const perp = new Vector3(d[0], d[1], d[2])
      .clone()
      .cross(new Vector3(0, 0, 1))
      .normalize();
    const cMin = -8 / 15;
    const nMin = new Vector3(d[0], d[1], d[2])
      .multiplyScalar(cMin)
      .addScaledVector(perp, Math.sqrt(1 - cMin * cMin));
    const atMin = evaluateShIrradiance(pt, nMin.x, nMin.y, nMin.z)[0];
    const MIN_EXACT = -19 / 480;

    console.table({
      "uniform sky: worst |E/πL − 1|": uniWorst.toExponential(3),
      "  → tests basis norm, dΩ weight, Â_l": uniWorst < SH_TOL ? "✅" : "❌",
      "point source: at source, E/E": Number((atSource / E).toPrecision(8)),
      "  → analytic 17/16": Number(RING.toPrecision(8)),
      "point source: antipode, E/E": Number((opp / E).toPrecision(8)),
      "  → analytic 1/16": Number(OPP_EXACT.toPrecision(8)),
      "point source: min at cosθ=−8/15": Number((atMin / E).toPrecision(8)),
      "  → analytic −19/480 (ringing goes NEGATIVE here)": Number(
        MIN_EXACT.toPrecision(8),
      ),
    });
    const t1 = uniWorst < SH_TOL;
    const t2 = Math.abs(atSource / E / RING - 1) < SH_TOL;
    const t3 = Math.abs(opp / E / OPP_EXACT - 1) < SH_TOL;
    const t4 = Math.abs(atMin / E - MIN_EXACT) < SH_TOL;
    if (t1 && t2 && t3 && t4) {
      console.log(
        "[lum] ✅ SH machinery exact — uniform sky = πL; delta source 17/16 at the\n" +
          "      source, 1/16 at the antipode, −19/480 at its minimum.",
      );
    } else {
      console.error(
        `[lum] ❌ SH machinery WRONG (uniform ${t1 ? "ok" : "FAIL"}, ` +
          `source ${t2 ? "ok" : "FAIL"}, antipode ${t3 ? "ok" : "FAIL"}, ` +
          `min ${t4 ? "ok" : "FAIL"}). Check shBasis() against three's ` +
          "SphericalHarmonics3.getBasisAt and the dΩ = sinθ·Δθ·Δφ weighting.",
      );
    }

    // ── The shipped sky ────────────────────────────────────────────────────
    const st = skyIrradianceStatus();
    console.table(st);
    const sh = getSkySh();
    if (!sh) {
      console.error(
        "[lum] no sky SH yet — the panorama bake runs a few frames after " +
          "MilkyWaySkybox mounts, and the catalogue half lands when stars_visual.bin " +
          "parses. Reload and retry.",
      );
      return;
    }
    const gain = SKY_ARTISTIC_GAIN;
    const rows: Record<string, Record<string, string | number>> = {};
    for (const [name, n] of NORMALS) {
      const e = evaluateShIrradiance(sh, n[0], n[1], n[2]);
      const luma = REC709[0] * e[0] + REC709[1] * e[1] + REC709[2] * e[2];
      rows[name] = {
        "irradiance (game)": luma.toExponential(3),
        "irradiance (lux)": (luma * NITS_PER_GAME_UNIT).toExponential(3),
        "as rendered (×gain)": (luma * gain * NITS_PER_GAME_UNIT).toExponential(3),
        "R:G:B": `${e[0].toExponential(2)} ${e[1].toExponential(2)} ${e[2].toExponential(2)}`,
      };
    }
    console.table(rows);

    // ── Does the PANORAMA half hit its own calibration target? ─────────────
    // 🔑 THIS IS THE CHECK THAT SHOULD HAVE EXISTED FIRST. The ratio test below did
    // catch the underflow bug — it read 2.418 against a predicted 1.24 — but its
    // message blamed the CATALOGUE half, when the catalogue was exact and the
    // panorama was 5.85× low. A ratio between two measured things tells you they
    // disagree; only an absolute check against a KNOWN target says which one moved.
    const meanNits = getPanoramaMeanRadiance() * NITS_PER_GAME_UNIT;
    const meanRatio = meanNits / SKY_DIFFUSE_TARGET_NITS;
    console.log(
      `[lum] panorama mean radiance ${meanNits.toExponential(4)} cd/m² vs target ` +
        `${SKY_DIFFUSE_TARGET_NITS.toExponential(4)} → ${meanRatio.toFixed(4)}×`,
    );
    if (Math.abs(meanRatio - 1) < 0.05) {
      console.log("[lum] ✅ panorama half is calibrated (within 5%).");
    } else {
      console.error(
        `[lum] ❌ panorama half is ${meanRatio.toFixed(3)}× its target.\n` +
          "      If it is LOW by roughly 6×, suspect half-float underflow in the bake:\n" +
          "      RGBA16F's smallest subnormal is 5.96e-8 and the calibrated sky is\n" +
          "      ~1.3e-8, so the render target must hold RAW texels with radianceScale\n" +
          "      applied on the CPU (skyIrradiance.ts says why). If it is off by the\n" +
          "      texture's mean, SKY_TEXTURE_MEAN_LINEAR is stale — re-run\n" +
          "      scripts/build_diffuse_sky.sh and paste the printed value.",
      );
    }

    // Whole-sky consistency: the MEAN irradiance over all normals must equal
    // π × (mean radiance), because every band above 0 integrates to zero over the
    // sphere. That ties the SH back to the flux the bake actually measured, and it
    // is the one absolute check available on the real sky.
    const meanIrr =
      0.886227 *
      (REC709[0] * sh[0].x + REC709[1] * sh[0].y + REC709[2] * sh[0].z);
    const fromMean = Math.PI * getPanoramaMeanRadiance();
    console.log(
      `[lum] band-0 irradiance ${meanIrr.toExponential(4)} game units;  ` +
        `π × panorama mean radiance ${fromMean.toExponential(4)}  ` +
        `→ ratio ${(meanIrr / Math.max(fromMean, 1e-30)).toFixed(3)}`,
    );
    console.log(
      "[lum] ⚠ expect ≈1.24: π×mean covers the PANORAMA only, while band 0 also\n" +
        "      carries the catalogue's ~19.5% share of the sky's flux (0.195/0.805).\n" +
        "      ≈1.0 → the catalogue half never landed. MUCH HIGHER → the panorama\n" +
        "      half is too dim; read the absolute panorama check above, which names\n" +
        "      which half moved instead of only saying that they disagree.",
    );
    // ── S4b: was the environment cube captured at the right star scale? ─────
    // 🔑 THIS IS THE ONE CHECK THAT MATTERS FOR THE CAPTURE. A cube face is 90° FOV
    // over 256 px; the canvas is 75° over ~1816. `StarField` derives sprite size AND
    // PSF normalisation from `tanPerPx`, so capturing without overriding those inputs
    // gives every star (0.0078125/0.000845)² ≈ **85.5×** its correct flux — and it
    // would read as "the reflections look too bright", a LOOK problem, which is how
    // long it would have survived. Asserting the witnessed inputs is cheap and
    // catches it exactly.
    //
    // ⚠ What this does NOT yet do is integrate the cube's own texels and compare
    // that flux against the SH. That needs per-cube-face readback, which
    // `readRenderTargetPixelsAsync` is not wired for here, so it is honest to say the
    // capture's photometry is checked at its INPUTS and not at its output.
    const sp = skySpecularStatus();
    console.table(sp);
    if (!sp.captured) {
      console.log(
        "[lum] sky cube not captured yet — it runs a few frames after the skybox\n" +
          "      mounts, on the same one-shot as the SH bake.",
      );
    } else {
      // 🔑 WITNESS THE UNIFORM, NOT THE BOOKKEEPING. The first version of this check
      // compared `capturePsfFovDeg/BufferH`, which come from `_psfDebug` — a field
      // only StarField's useFrame wrote. The override set the uniforms correctly but
      // not that field, so the gate FAILED A WORKING CAPTURE and its message
      // confidently blamed `withStarCaptureResolution` for not running.
      //
      // `uPsfNorm` is what the shader actually samples, so comparing it cannot be
      // fooled by stale notes. The expected value is built HERE because it needs σ
      // (StarField) and the face geometry (skySpecular), and this is the only module
      // that legitimately imports both.
      const t = captureTanPerPx();
      const expectedNorm =
        1 / (2 * Math.PI * STAR_PSF_SIGMA_PX * STAR_PSF_SIGMA_PX * t * t);
      const normRatio = sp.capturePsfNorm / expectedNorm;
      // uPsfNorm ∝ 1/Ω_pixel, so a wrong buffer scales it by the solid-angle ratio —
      // i.e. this ratio IS the flux error, directly.
      console.log(
        `[lum] uPsfNorm during capture ${sp.capturePsfNorm.toPrecision(6)} vs ` +
          `expected ${expectedNorm.toPrecision(6)} → ${normRatio.toPrecision(4)}×`,
      );
      if (Math.abs(normRatio - 1) < 1e-4) {
        console.log(
          `[lum] ✅ capture used the cube-face PSF (90° over ${SKY_CUBE_SIZE} px) —\n` +
            "      star flux in the cube faces is scaled correctly.",
        );
      } else {
        console.error(
          `[lum] ❌ capture used the WRONG PSF: uPsfNorm was ${normRatio.toPrecision(4)}×\n` +
            `      its correct value, so every star's flux in the cube is off by that\n` +
            `      factor. Reported inputs: fov ${sp.capturePsfFovDeg}° over ` +
            `${sp.capturePsfBufferH} px, expected 90° over ${SKY_CUBE_SIZE}.\n` +
            "      Check that StarField is mounted before captureSkyCube() runs.",
        );
      }
    }

    console.log(
      "[lum] then look: warp into Neptune's umbra and check the hull is lit at all\n" +
        "      (it used to be pure black), brighter on the side facing the galactic\n" +
        "      plane, and now with the band faintly REFLECTED in the glossy panels.\n" +
        "      __lum.aim(17.7611, -29.0078) puts the core behind you.",
    );
  }

  /** Snap adaptation to the current scene — no slow fade after a warp. */
  snapExposure(): void {
    resetExposureAdaptation();
    console.log(
      `[lum] adaptation snapped to ${adaptationTarget(exposureMeterStatus().meteredEV).toFixed(2)} EV`,
    );
  }

  /** Print the unit convention and the current exposure. */
  units(): void {
    console.log(
      [
        `1 game unit        = ${NITS_PER_GAME_UNIT.toFixed(0)} cd/m² (or lux)`,
        `sun illuminance    = ${SUN_ILLUM_GAME_1AU} game units at 1 AU from 1 L☉`,
        `current exposure   = ${getExposure().toPrecision(4)}`,
        `see docs/LIGHTING_PLAN.md §3.1`,
      ].join("\n"),
    );
  }

  /** Pin exposure at a metered EV100. Always do this before measuring. */
  setEV(ev100: number): void {
    setManualExposure(true);
    setExposureEV(ev100);
    console.log(`[lum] exposure pinned at EV100 ${ev100} (×${getExposure().toPrecision(4)})`);
  }

  /** Hand exposure back to auto-exposure (Phase 5; a no-op before that). */
  auto(): void {
    setManualExposure(false);
    console.log("[lum] exposure released to auto");
  }

  /**
   * Read one pixel of the pre-tonemap target.
   *
   * Coordinates are in DRAWING-BUFFER pixels with the origin at the BOTTOM-left
   * (the GPU convention `readRenderTargetPixelsAsync` uses), not CSS pixels
   * top-left. Defaults to the centre, which is where the ladder aims its bodies.
   */
  async probe(x?: number, y?: number): Promise<LumSample | null> {
    if (!_source) {
      console.error("[lum] no render target registered — is the scene mounted?");
      return null;
    }
    const { renderer, target } = _source;
    const px = Math.round(x ?? target.width / 2);
    const py = Math.round(y ?? target.height / 2);

    const buf = await renderer.readRenderTargetPixelsAsync(target, px, py, 1, 1);
    const isHalf = buf instanceof Uint16Array;
    const isByte = buf instanceof Uint8Array;
    const units = decodeRgb(buf as unknown as ArrayLike<number>, 0, isHalf, isByte);
    const luma = REC709[0] * units[0] + REC709[1] * units[1] + REC709[2] * units[2];
    return {
      x: px,
      y: py,
      units,
      luma,
      nits: luma * NITS_PER_GAME_UNIT,
      ev: evFromGameUnits(luma),
    };
  }

  /**
   * Max photopic luma over an n×n block centred on the target — use this for a
   * body's disc rather than `probe()`, so a one-pixel miss (the body slightly
   * off-centre, a cloud gap, a dark surface feature) doesn't read as a failure.
   */
  /**
   * Integrate photopic luma over an n×n block centred on the target, and return
   * both the sum and the peak.
   *
   * 🔑 **FLUX, not peak, is the placement-independent quantity.** A point source
   * aimed dead-centre lands on a pixel CORNER for any even-sized buffer, so its
   * true peak is never sampled — but the SUM over pixels is `2πσ²` whatever the
   * sub-pixel offset (verified: 6.2832 both on-grid and half-pixel-off). Comparing
   * peaks measures where the star fell relative to the pixel grid; comparing sums
   * measures the physics. Used by `star()`.
   */
  async probeFlux(
    n = 15,
    outer = 31,
  ): Promise<{
    sumLuma: number;
    peakLuma: number;
    samples: number;
    backgroundPerPx: number;
    sumLumaRaw: number;
  } | null> {
    if (!_source) return null;
    const { renderer, target } = _source;
    // ── APERTURE PHOTOMETRY, not a bare sum ─────────────────────────────────
    // ⚠ A raw window sum is aperture PLUS SKY, and the sky is not negligible any
    // more. `SKY_ARTISTIC_GAIN` is a look knob that has been pushed to ~1e3, which
    // makes the diffuse Milky Way a real contributor inside a 15×15 window —
    // MEASURED as +3.3% on Sirius and +5.8% on Vega, both of which sit within ~20°
    // of the galactic plane. That is the whole reason the two stars disagreed with
    // each other while each looked "close enough".
    //
    // 🔑 The fix is the standard one from astronomical photometry: estimate the sky
    // from an ANNULUS outside the aperture and subtract `sky × aperture_area`. The
    // annulus starts at Chebyshev radius `half + 2`, where a σ ≈ 0.85 px Gaussian is
    // ~e^−56 of its peak, so it cannot contain any of the star. The MEDIAN is used
    // rather than the mean so a neighbouring catalogue star in the annulus — likely,
    // at 8,920 stars — cannot bias the estimate.
    const half = Math.floor(n / 2);
    const oHalf = Math.floor(outer / 2);
    const cx = Math.round(target.width / 2) - oHalf;
    const cy = Math.round(target.height / 2) - oHalf;
    const buf = await renderer.readRenderTargetPixelsAsync(
      target,
      cx,
      cy,
      outer,
      outer,
    );
    const isHalf = buf instanceof Uint16Array;
    const isByte = buf instanceof Uint8Array;
    const a = buf as unknown as ArrayLike<number>;
    const stride = rowStrideElements(outer, isHalf ? 2 : isByte ? 1 : 4);
    const ring: number[] = [];
    const lumas: number[][] = [];
    for (let row = 0; row < outer; row++) {
      const line: number[] = [];
      for (let col = 0; col < outer; col++) {
        const [r, g, b] = decodeRgb(a, row * stride + col * 4, isHalf, isByte);
        const l = REC709[0] * r + REC709[1] * g + REC709[2] * b;
        line.push(l);
        const cheb = Math.max(Math.abs(row - oHalf), Math.abs(col - oHalf));
        if (cheb >= half + 2) ring.push(l);
      }
      lumas.push(line);
    }
    ring.sort((x, y) => x - y);
    const bg = ring.length ? ring[Math.floor(ring.length / 2)] : 0;

    let raw = 0;
    let peak = 0;
    for (let row = oHalf - half; row <= oHalf + half; row++) {
      for (let col = oHalf - half; col <= oHalf + half; col++) {
        const l = lumas[row][col];
        raw += l;
        if (l > peak) peak = l;
      }
    }
    return {
      sumLuma: raw - bg * n * n,
      peakLuma: Math.max(peak - bg, 0),
      samples: n * n,
      backgroundPerPx: bg,
      sumLumaRaw: raw,
    };
  }

  async probeMax(n = 9): Promise<LumSample | null> {
    if (!_source) return null;
    const { renderer, target } = _source;
    const half = Math.floor(n / 2);
    const cx = Math.round(target.width / 2) - half;
    const cy = Math.round(target.height / 2) - half;
    const buf = await renderer.readRenderTargetPixelsAsync(target, cx, cy, n, n);
    const isHalf = buf instanceof Uint16Array;
    const isByte = buf instanceof Uint8Array;
    const a = buf as unknown as ArrayLike<number>;
    const bytesPerElement = isHalf ? 2 : isByte ? 1 : 4;
    const stride = rowStrideElements(n, bytesPerElement);

    let best: [number, number, number] = [0, 0, 0];
    let bestLuma = -1;
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        const [r, g, b] = decodeRgb(a, row * stride + col * 4, isHalf, isByte);
        const l = REC709[0] * r + REC709[1] * g + REC709[2] * b;
        if (l > bestLuma) {
          bestLuma = l;
          best = [r, g, b];
        }
      }
    }
    return {
      x: cx + half,
      y: cy + half,
      units: best,
      luma: bestLuma,
      nits: bestLuma * NITS_PER_GAME_UNIT,
      ev: evFromGameUnits(bestLuma),
    };
  }

  /**
   * DISC AVERAGE + brightness distribution over a body's whole lit disc.
   *
   * The instrument LIGHTING_PLAN §2.2.9 says Phase 2c needs, and the answer to
   * "which pixels do I probe?" — you don't. It warps to the sub-solar pose,
   * finds the disc analytically (angular radius from the pose distance and the
   * camera FOV — no luminance thresholding, so the atmosphere's halo cannot
   * inflate the footprint), reads it back in one go and reports percentiles.
   *
   * Why percentiles rather than named points: on a textured body the ordering
   * IS the identification. The darkest few per cent of a fully-lit Earth disc is
   * clear deep ocean; the brightest non-glint few per cent is thick cloud top.
   * So p02 and p98 answer the cloud-contrast question without anyone picking a
   * pixel, and p50/mean answer the geometric-albedo question that a centre probe
   * structurally cannot (§2.2.9).
   *
   * ⚠ `p100` is usually the SPECULAR GLINT, not cloud — read p98 for cloud.
   *
   * `mean` is over the disc's projected area, which is what geometric albedo is
   * defined on, so `impliedGeometricAlbedo` is directly comparable to
   * bodyPhotometry's value. Anything ABOVE 1.0 is an energy violation.
   */
  async disc(
    bodyId = "earth",
    {
      warp = true,
      altitudeKm,
      settleFrames = 420,
      inset = 0.92,
    }: {
      warp?: boolean;
      altitudeKm?: number;
      settleFrames?: number;
      /** Fraction of the disc radius to sample within — trims the limb. */
      inset?: number;
    } = {},
  ) {
    if (!_source) {
      console.error("[lum] no render target registered — is the scene mounted?");
      return null;
    }
    const body = authoredBody(bodyId);
    if (!body?.radiusKm) {
      console.error(`[lum] unknown body "${bodyId}"`);
      return null;
    }

    if (warp) {
      const pose = subSolarPose(bodyId, altitudeKm);
      if (!pose) {
        console.error(`[lum] cannot pose at "${bodyId}"`);
        return null;
      }
      this.store.set(devTeleportAtom, pose);
      await sleepFrames(settleFrames);
    }

    const { renderer, target, camera } = _source;
    if (!camera) {
      console.error(
        "[lum] no camera registered — SpaceRenderer must pass it to setLumSource. Full reload if you just edited it.",
      );
      return null;
    }

    // Disc radius in pixels. subSolarPose puts the camera at radius+altitude on
    // the body→star line looking straight back, so the disc is centred and its
    // angular radius is asin(R/d). Vertical FOV maps to target.height.
    const distKm = body.radiusKm + (altitudeKm ?? body.radiusKm * 3);
    const angRadius = Math.asin(Math.min(1, body.radiusKm / distKm));
    const halfFov = (camera.fov * Math.PI) / 180 / 2;
    const radiusPx = (Math.tan(angRadius) / Math.tan(halfFov)) * (target.height / 2);
    const rInner = radiusPx * inset;
    if (rInner < 4) {
      console.error(
        `[lum] disc is only ${(radiusPx * 2).toFixed(1)} px across — move closer (lower altitudeKm).`,
      );
      return null;
    }

    // One readback of the disc's bounding box, clamped to the target.
    const cx = target.width / 2;
    const cy = target.height / 2;
    const x0 = Math.max(0, Math.floor(cx - rInner));
    const y0 = Math.max(0, Math.floor(cy - rInner));
    const x1 = Math.min(target.width, Math.ceil(cx + rInner));
    const y1 = Math.min(target.height, Math.ceil(cy + rInner));
    const w = x1 - x0;
    const h = y1 - y0;
    const buf = await renderer.readRenderTargetPixelsAsync(target, x0, y0, w, h);
    const isHalf = buf instanceof Uint16Array;
    const isByte = buf instanceof Uint8Array;
    const a = buf as unknown as ArrayLike<number>;
    const stride = rowStrideElements(w, isHalf ? 2 : isByte ? 1 : 4);

    const lumas: number[] = [];
    let sum = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    const r2 = rInner * rInner;
    for (let row = 0; row < h; row++) {
      const dy = y0 + row + 0.5 - cy;
      for (let col = 0; col < w; col++) {
        const dx = x0 + col + 0.5 - cx;
        if (dx * dx + dy * dy > r2) continue; // circular mask, not the bbox
        const [r, g, b] = decodeRgb(a, row * stride + col * 4, isHalf, isByte);
        const l = REC709[0] * r + REC709[1] * g + REC709[2] * b;
        lumas.push(l);
        sum += l;
        sumR += r;
        sumG += g;
        sumB += b;
      }
    }
    if (lumas.length === 0) {
      console.error("[lum] no pixels inside the disc mask");
      return null;
    }
    lumas.sort((p, q) => p - q);
    const pct = (f: number) =>
      lumas[Math.min(lumas.length - 1, Math.floor(f * lumas.length))];
    const n = lumas.length;
    const mean = sum / n;

    const exp = this.expected(bodyId);
    const ref = bodyPhotometry(bodyId);
    // Disc-mean radiance → geometric albedo: p = L·π/E, the definition.
    const impliedP = exp ? (mean * Math.PI) / exp.sunIlluminance : NaN;

    const rows = [
      ["p02  (darkest — clear ocean on Earth)", pct(0.02)],
      ["p25", pct(0.25)],
      ["p50  (median)", pct(0.5)],
      ["mean (disc average)", mean],
      ["p75", pct(0.75)],
      ["p98  (brightest non-glint — cloud top)", pct(0.98)],
      ["p100 (usually the SPECULAR GLINT)", lumas[n - 1]],
    ] as const;

    console.log(
      `[lum] ${bodyId} disc — ${n.toLocaleString()} px, radius ${radiusPx.toFixed(0)} px (inset ${inset})`,
    );
    console.table(
      Object.fromEntries(
        rows.map(([label, v]) => [
          label,
          {
            units: Number(v.toPrecision(4)),
            "cd/m²": Math.round(v * NITS_PER_GAME_UNIT),
            EV: Number(evFromGameUnits(v).toFixed(1)),
            "implied refl.": exp
              ? Number(((v * Math.PI) / exp.sunIlluminance).toPrecision(3))
              : "—",
          },
        ]),
      ),
    );
    const contrast = pct(0.98) / Math.max(pct(0.02), 1e-9);
    console.log(
      `[lum] p98/p02 contrast = ${contrast.toFixed(1)}×` +
        (bodyId === "earth" ? "  (real Earth cloud:ocean from orbit ≈ 8.7×)" : ""),
    );
    console.log(
      `[lum] implied geometric albedo = ${impliedP.toFixed(4)}` +
        (ref ? `  vs measured ${ref.geometricAlbedo}` : "") +
        (impliedP > 1 ? "   ⚠ IMPOSSIBLE (>1)" : ""),
    );

    return {
      bodyId,
      pixels: n,
      radiusPx,
      mean,
      meanRgb: [sumR / n, sumG / n, sumB / n] as [number, number, number],
      p02: pct(0.02),
      p25: pct(0.25),
      p50: pct(0.5),
      p75: pct(0.75),
      p98: pct(0.98),
      max: lumas[n - 1],
      contrast,
      impliedGeometricAlbedo: impliedP,
      referenceGeometricAlbedo: ref?.geometricAlbedo,
    };
  }

  /**
   * What physics says a body's sunlit disc should be, in game units.
   *
   * Computed from the body's LIVE illuminance where it is registered as an
   * atmosphere body, and from its authored distance otherwise — deliberately
   * parametric rather than a hardcoded table, so it stays valid when bodies
   * orbit and for procedurally generated systems (LIGHTING_PLAN §3.0).
   */
  expected(bodyId: string, starDistanceKm?: number): LumExpectation | null {
    const phot = bodyPhotometry(bodyId);
    if (!phot) {
      console.error(`[lum] no reference photometry for "${bodyId}"`);
      return null;
    }
    // Prefer the LIVE record (correct once bodies orbit). Fall back to the
    // authored position, so `expected()` works for every body from anywhere —
    // the first version only worked for whichever body was currently registered
    // as the dominant atmosphere, which made cross-body comparison impossible.
    const rec = getAtmosphereBody(bodyId);
    const dist = starDistanceKm ?? authoredStarDistanceKm(bodyId);
    const illum =
      rec?.sunIlluminance.x ??
      (dist != null ? sunIlluminanceAt(dist, STAR_LUMINOSITY_SUN) : NaN);
    if (!Number.isFinite(illum)) {
      console.warn(
        `[lum] cannot derive illuminance for "${bodyId}" — not a registered ` +
          `atmosphere body and not found in the system description.`,
      );
      return null;
    }
    const discUnits = discRadianceAtZeroPhase(phot.geometricAlbedo, illum);
    return {
      bodyId,
      geometricAlbedo: phot.geometricAlbedo,
      sunIlluminance: illum,
      discUnits,
      subSolarUnits: subSolarRadianceLambert(phot.geometricAlbedo, illum),
      discNits: discUnits * NITS_PER_GAME_UNIT,
      discEv: evFromGameUnits(discUnits),
      note: phot.note,
    };
  }

  /** The ladder's rows, for reference. */
  list(): Array<{ id: string; what: string }> {
    return LADDER.map((s) => ({ id: s.id, what: s.what }));
  }

  /**
   * Warp the ladder, probe each row, print measured vs expected.
   *
   * `settleFrames` defaults high because a warp triggers texture streaming and a
   * LOD tier swap; too low and you measure the previous body.
   */
  async sweep({ settleFrames = 420, ev = 14 }: { settleFrames?: number; ev?: number } = {}) {
    if (!_source) {
      console.error("[lum] no render target registered — is the scene mounted?");
      return [];
    }
    const prevExposure = getExposure();
    this.setEV(ev);

    const rows: Array<Record<string, string | number>> = [];
    for (const s of LADDER) {
      // Disc rows use the SUB-SOLAR pose (zero phase — the geometry p·E/π is
      // defined at). Sky/space rows keep the approach-axis warp, which is what
      // they are actually about.
      const pose =
        s.expect === "disc"
          ? subSolarPose(s.bodyId, s.altitudeKm)
          : resolveBodyWarp(s.bodyId, s.altitudeKm);
      this.store.set(devTeleportAtom, pose ?? resolveBodyWarp(s.bodyId, s.altitudeKm));
      await sleepFrames(settleFrames);
      // ⚠ PROBE TWICE. Earth swung 7.1× between two identical sweeps (implied
      // reflectance 0.875 vs 0.123 — cloud top vs open ocean) because its 8K
      // tiers, cloud shell and TAA reconstruction had not finished settling. A
      // single probe reports that as a confident number. Two probes separated in
      // time turn it into a visible warning, which is the whole point of having
      // an instrument.
      const m0 = await this.probeMax(9);
      await sleepFrames(90);
      const m = await this.probeMax(9);
      if (!m || !m0) continue;
      const drift = Math.abs(m.luma - m0.luma) / Math.max(m.luma, m0.luma, 1e-12);
      if (drift > 0.02) {
        console.warn(
          `[lum] ${s.id}: UNSETTLED — two probes 90 frames apart differ by ` +
            `${(drift * 100).toFixed(1)}% (${m0.luma.toPrecision(4)} → ${m.luma.toPrecision(4)}). ` +
            `Raise settleFrames; do not trust this row.`,
        );
      }

      const exp = s.expect === "disc" ? this.expected(s.bodyId) : null;
      rows.push({
        row: s.id,
        expect: s.expect,
        "measured (units)": m.luma.toPrecision(4),
        "measured (cd/m²)": Math.round(m.nits),
        "measured EV": m.ev.toFixed(1),
        "expected disc-avg": exp ? exp.discUnits.toPrecision(4) : "—",
        "expected sub-solar": exp ? exp.subSolarUnits.toPrecision(4) : "—",
        "ratio vs sub-solar": exp ? (m.luma / exp.subSolarUnits).toFixed(3) : "—",
        drift: drift > 0.02 ? `⚠ ${(drift * 100).toFixed(1)}%` : "ok",
      });
    }

    console.table(rows);
    console.log(
      "[lum] Read `ratio vs sub-solar`: 1.0 = a correct Lambert sphere at this probe\n" +
        "      geometry. The probe aims at the SUB-SOLAR POINT, which on a Lambert sphere is\n" +
        "      1.5× the disc-averaged p·E/π that geometric albedo is defined by — so the\n" +
        "      disc-average column is NOT the target and reading it as one overstates every\n" +
        "      body by 1.5×. Real surfaces sit somewhat above 1.0 (backscatter, opposition).",
    );
    // Restore rather than leave the session pinned somewhere surprising.
    setManualExposure(true);
    setExposureEV(Math.log2(1 / (1.2 * prevExposure)));
    return rows;
  }
}

type NamedStar = {
  name: string;
  magV: number;
  colorBV: number;
  posEqLy: [number, number, number];
};
let _namedStars: NamedStar[] | null = null;
const _starDir = new Vector3();

let _harness: LumHarness | null = null;

/** The one shared harness (DevTools publishes it as `window.__lum`). */
export function getLumHarness(store: Store): LumHarness {
  if (!_harness) _harness = new LumHarness(store);
  return _harness;
}
