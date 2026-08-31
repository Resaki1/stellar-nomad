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
 *   __lum.nightSide()                // GATE: is the sky lighting PLANETS? (Phase 9)
 *   __lum.hull()                     // GATE: what is lighting the SHIP? (P9e)
 *   await __lum.scotopic()            // GATE: rods/cones + Purkinje (Phase 7)
 *   await __lum.scotopic(true)        // ...turn the retina stage on (runtime A/B)
 *   await __lum.lod("jupiter")       // GATE: do the 3 LOD tiers agree? (Phase 4)
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
/** Scratch uniforms for `__lum.eclipse()` — never rendered with. */
const _eclipseProbeU = createEclipseUniforms();

import { STAR_LUMINOSITY_SUN, STAR_POSITION_KM } from "@/sim/celestialConstants";
import { devTeleportAtom, type DevWarp } from "@/store/dev";
import { BODY_PHOTOMETRY, bodyPhotometry } from "@/data/bodyPhotometry";
import { STAR_RADIUS_KM } from "@/sim/celestialConstants";
import { sunOccluderList } from "@/components/space/sunOcclusion";
import {
  AU_KM,
  bodyOrientation,
  createBodyOrientation,
  jdFromUTC,
  jdFromUnixMs,
  moonGeocentric,
  solveSystem,
  sunMoonSeparationDeg,
} from "@/sim/ephemeris";
import { allBodyDefs, solvedEphemerisJD } from "@/sim/celestialConstants";
import {
  createShineUniforms,
  updateShineUniforms,
} from "@/components/celestial/planetshine";
import { bodyReflectanceRgb } from "@/components/celestial/bodyColour";
import { hullShineStatus } from "@/components/celestial/planetshine";
import { formatSimTime, simEpochMsAtom, simRateAtom } from "@/store/simTime";
import {
  MAX_ECLIPSE_OCCLUDERS,
  createEclipseUniforms,
  updateEclipseUniforms,
} from "@/components/celestial/bodyEclipse";
import {
  atmosphericFocalLengthKm,
  grazingDeflectionDeg,
  refractedLimbIlluminance,
} from "@/components/space/refractedLimbLight";
import {
  blackbodyAnchors,
  emitterAudit,
  gameUnitsToNits,
} from "@/components/space/emissivePhotometry";
import {
  preExposedEmissiveRows,
} from "@/components/space/preExposedEmissive";
import {
  albedoCalibrationStatus,
  getStellarPointAlbedos,
} from "@/components/celestial/albedoCalibration";
import { bodyColourStatus } from "@/components/celestial/bodyColour";
import { setStellarPointsEnabled } from "@/components/space/StellarPoint";
import {
  getLodState,
  getLodThresholds,
} from "@/components/celestial/lodState";
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
  localExposureStatus,
  readLocalGain,
  readLocalMapGrid,
  setLocalExposure,
} from "../exposureMeter";
import {
  deriveScotopicWeights,
  rodConeBlend,
  scotopicMixCpu,
  scotopicStatus,
  setScotopic,
  spectralSpRatio,
} from "../scotopic";
import {
  NITS_PER_GAME_UNIT,
  STAR_COLOR_LINEAR,
  evFromNits,
  planck,
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
  bodyPositionKm,
  bodyRadiusKm,
  resolveBodyWarp,
  resolveLookDirectionWarp,
  resolveUmbraWarp,
  starPositionKm,
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
  bodyIlluminanceAtCamera,
} from "@/components/space/photometry";
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
      estimator: st.estimator,
      "  area-weighted (D33)": Number(st.evAreaWeighted.toFixed(2)),
      "  flux-weighted": Number(st.evFluxWeighted.toFixed(2)),
      "  pooled soft-max": Number(st.evPooledMax.toFixed(2)),
      "  pool cells": `${st.poolCells} within ${st.poolWindowStops} stops of the max`,
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
      "local exposure": localExposureStatus().enabled
        ? `ON, strength ${Number(localExposureStatus().strength.toPrecision(3))}`
        : "OFF",
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
    const split = st.evPooledMax - st.evAreaWeighted;
    console.log(
      `[lum] pooled − area = ${split.toFixed(2)} stops. **That gap IS the subject's coverage**: ` +
        `the area-weighted mean is ~coverage × the subject's own luminance, so the bright\n` +
        `      content occupies roughly ${(100 * Math.pow(2, -split)).toFixed(2)}% of the weighted frame. ` +
        `A big gap is not an error — it is the\n      D33 coverage term made visible, and "pooled" is ` +
        `the estimator that does not carry it.`,
    );
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

  /**
   * LOD PHOTOMETRY GATE — do all three impostor tiers agree, and with physics?
   * (Phase 4, defects D04/D06/D20)
   *
   *     await __lum.lod("jupiter")
   *
   * ── WHY A SWEEP AND NOT A SPOT CHECK ─────────────────────────────────────
   * A body is drawn three different ways depending on how many pixels it covers —
   * textured sphere, billboard, stellar point — and before Phase 4 each used its own
   * brightness scale. The billboard emitted pure REFLECTANCE (no illuminance at all),
   * and the point normalised to an arbitrary Jupiter reference times a hand-picked
   * 12.0. Two wrong scales next to each other produce a step at the handoff, and no
   * single measurement can see a step.
   *
   * So this walks the camera across the handoff (the switch is at a disc diameter of
   * 8 px) and at each stop compares the body's MEASURED flux against the one analytic
   * value all three tiers should now be computing:
   *
   *     E_cam = p · Φ(α) · E_sun(d_sun) · (R/d_cam)²
   *
   * 🔑 FLUX, not peak — the same reason `__lum.star()` uses flux. A body's peak
   * brightness depends on how many pixels it is spread over, which is precisely what
   * changes across a LOD switch; its flux does not. Comparing peaks would report a
   * step that is not there and hide one that is.
   *
   * ⚠ Φ(α) is computed from the REAL geometry, because `resolveScenario` places the
   * eye along a fixed `APPROACH_DIR`, not along the sub-solar direction. Assuming
   * Φ = 1 would compare against the wrong reference and read as a renderer error.
   *
   * ⚠ The reference albedo comes from `bodyPhotometry`, the MEASURED table — not from
   * the body's own `stellarPoint.geometricAlbedo`. If a body disagrees with itself
   * that is a finding, and it is how D20 was caught (Luna shipped 0.0036 against a
   * measured 0.136, a number tuned by eye to look right against the old arbitrary
   * scale).
   */
  async lod(
    bodyId: string,
    settleFrames = 180,
    points = true,
  ): Promise<void> {
    // ⚠ Sweep with `points:false` to measure the far billboard ALONE. Below 8 px both
    // it and the stellar point draw, and a single flux number cannot attribute itself.
    setStellarPointsEnabled(points);
    console.log(
      `[lum] stellar points ${points ? "ENABLED" : "DISABLED"} for this sweep.`,
    );
    const ref = bodyPhotometry(bodyId);
    if (!ref) {
      console.error(`[lum] no bodyPhotometry entry for "${bodyId}"`);
      return;
    }
    if (!_source) {
      console.error("[lum] no render source — is the scene rendering?");
      return;
    }
    const R = bodyRadiusKm(bodyId);
    const bPos = bodyPositionKm(bodyId);
    const sPos = starPositionKm();
    const dSunKm = Math.hypot(
      bPos[0] - sPos[0],
      bPos[1] - sPos[1],
      bPos[2] - sPos[2],
    );

    const { camera, target } = _source;
    const fovRad =
      (((camera as unknown as { fov?: number }).fov ?? 50) * Math.PI) / 180;
    const screenH = target.height;

    // Disc diameters that straddle the 8 px stellar-point handoff.
    // The body's own LOD thresholds, so stops near a boundary can be skipped.
    const lodNearKm = getLodThresholds(bodyId)?.near ?? 0;
    const lodFarKm = getLodThresholds(bodyId)?.far ?? 0;
    const DIAMS = [24, 12, 9, 8.5, 7.5, 6, 3, 1];
    const rows: Record<string, Record<string, string | number>> = {};
    const ratios: Array<{ px: number; ratio: number; tier: string }> = [];

    for (const px of DIAMS) {
      // px = (2R/d)/fovRad × screenH  ⇒  d = 2R·screenH/(px·fovRad)
      const dCamKm = (2 * R * screenH) / (px * fovRad);
      const altKm = dCamKm - R;
      if (altKm <= 0) continue;
      // ⚠ Skip stops that sit within 15% of this body's own LOD threshold. Jupiter's
      // 12 px stop landed 1% past its 16,000,000 km boundary and reported tier "far"
      // while its pixels still measured like "mid" — the readback and the published
      // state can straddle the switch. A stop that close to a boundary measures the
      // switch, not the tier.
      const near0 = lodNearKm > 0 && Math.abs(dCamKm / lodNearKm - 1) < 0.15;
      const near1 = lodFarKm > 0 && Math.abs(dCamKm / lodFarKm - 1) < 0.15;
      if (near0 || near1) {
        console.log(
          `[lum]   (skipping ${px} px — ${Math.round(dCamKm)} km is within 15% of a ` +
            "LOD threshold, so it would measure the switch rather than a tier)",
        );
        continue;
      }
      this.store.set(devTeleportAtom, resolveBodyWarp(bodyId, altKm));
      // ⚠ Generous settle: the LOD tier only switches once its textures are LOADED
      // and its shader COMPILED (`nearReadyState === 2`), so an under-settled stop
      // measures whichever tier happened to be ready — which is why repeated runs
      // disagreed. Adaptation does not matter here (decodeRgb divides pre-exposure
      // out), but tier readiness very much does.
      await sleepFrames(settleFrames);

      // Real phase angle at the body, between the sun and the camera.
      const warp = resolveBodyWarp(bodyId, altKm);
      const toSun = new Vector3(
        sPos[0] - bPos[0],
        sPos[1] - bPos[1],
        sPos[2] - bPos[2],
      ).normalize();
      const toCam = new Vector3(
        warp.positionKm[0] - bPos[0],
        warp.positionKm[1] - bPos[1],
        warp.positionKm[2] - bPos[2],
      ).normalize();
      const alpha = Math.acos(Math.max(-1, Math.min(1, toSun.dot(toCam))));
      const phi =
        (1 / Math.PI) *
        ((Math.PI - alpha) * Math.cos(alpha) + Math.sin(alpha));

      const expected = bodyIlluminanceAtCamera(
        ref.geometricAlbedo,
        phi,
        R,
        dSunKm,
        dCamKm,
      );

      // Aperture must contain the whole disc plus its halo; the annulus subtracts
      // sky, which at SKY_ARTISTIC_GAIN ~1e3 is NOT negligible (see §8.8).
      const ap = Math.max(21, 2 * Math.ceil(1.25 * px) + 1);
      const f = await this.probeFlux(ap, ap + 16);
      if (!f) continue;

      // ⚠⚠ × Ω_pixel. `probeFlux` returns Σ RADIANCE; the reference is an
      // ILLUMINANCE. Flux = Σ L·dΩ, so the pixel solid angle is not optional — the
      // first version of this gate omitted it and every ratio came out 10³–10⁴ times
      // too large. 🔑 Ω_pixel is CONSTANT at a fixed resolution, which is why the
      // STEPS it reported were still valid while its absolute numbers were nonsense:
      // a dimensional error that cancels in ratios is the easiest kind to ship.
      // Same family as `pxAngle = fov/height` and the σ-scale mislabel.
      const tanPerPx = (2 * Math.tan(fovRad / 2)) / screenH;
      const omegaPixel = tanPerPx * tanPerPx;
      // ⚠⚠ NO `/ getPreExposure()` HERE — `decodeRgb` ALREADY divides it out, and it
      // is the single chokepoint for exactly that reason. Dividing again put a factor
      // of ~1e-3 under EVERY reading, which is why both tiers looked absurdly dim in
      // absolute terms while their relative step was still correct.
      //
      // 🔑 `star()` gets this right and I did not copy its pattern. A shared
      // chokepoint only helps if callers trust it instead of re-applying the
      // correction "to be safe" — a defensive extra divide is still a bug.
      const measured = f.sumLuma * omegaPixel;

      // ⚠ The point does NOT replace the billboard, it CROSSFADES OVER it.
      // `showFar = !showNear && !showMid` switches on absolute distance
      // (`config.lod.far`), while the stellar point's own gate is
      // `pixelDiameter < 8` — independent. So below 8 px BOTH draw, and the point
      // ramps in with `fade = ((8 − px)/8)²`. The expected total is therefore
      // `E · (1 + fade)`, not `E`. Modelling it as a switch invented a step that the
      // renderer never had.
      // ⚠ WITNESS the tier, do not infer it. `showFar` keys on absolute distance
      // (`config.lod.far`) and only engages once a tier's textures are loaded and its
      // shader compiled, so the same pixel size is a different tier on different
      // bodies AND depends on streaming state. Inferring it from `px` is what made the
      // first reading blame the wrong boundary.
      const lodState = getLodState(bodyId);
      const pointVisible = px < 8;
      const t = pointVisible ? (8 - px) / 8 : 0;
      const fadeExpected = t * t;
      // ⚠ EXPECTED IS `E`, NOT `E·(1+fade)`. The crossfade is COMPLEMENTARY now — the
      // billboard is multiplied by `1 − fade` while the point carries `fade` — so the
      // two sum to E, they do not stack. The `(1+fade)` model was correct only for the
      // old behaviour where the point drew on top at full strength.
      //
      // 🔑 The gate's reference has to track the renderer's INTENT, not its history. A
      // stale expectation reports a correct renderer as broken, which is how the 1 px
      // stop looked like a 4-stop failure.
      const expectedTotal = expected;
      const ratio = measured / Math.max(expectedTotal, 1e-30);
      const tierName = lodState?.tier ?? "?";
      const tier = pointVisible ? `${tierName} + point` : tierName;
      ratios.push({ px, ratio, tier });
      rows[`${px} px disc`] = {
        tier,
        "d_cam (AU)": Number((dCamKm / 1.495979e8).toPrecision(4)),
        "phase α (°)": Number(((alpha * 180) / Math.PI).toFixed(1)),
        "Φ(α)": Number(phi.toPrecision(3)),
        "point fade": Number(fadeExpected.toPrecision(3)),
        "expected E (game)": expectedTotal.toExponential(3),
        "measured flux (game)": measured.toExponential(3),
        "measured/expected": Number(ratio.toPrecision(4)),
        "aperture px": ap,
        "d_cam (km)": Math.round(dCamKm),
        "preExposure": Number(getPreExposure().toPrecision(4)),
        // ⚠ THE MEASUREMENT THAT SPLITS "too dim" FROM "too small". The far billboard
        // quad is `PlaneGeometry(scaledRadius × 2.1)` and its fragment draws the disc
        // out to the quad edge, so the RENDERED disc should be 1.05× the body's true
        // disc — i.e. `1.05 × px`. A 7.5× flux deficit is either a radiance error at
        // the right size, or a 2.74× LINEAR size error at the right radiance, and
        // `sumLuma` cannot tell them apart.
        "lit Ø (px)": Number(f.litDiameterPx.toPrecision(3)),
        "expected Ø (px)": Number((1.05 * px).toPrecision(3)),
        "Ø measured/expected": Number(
          (f.litDiameterPx / Math.max(1.05 * px, 1e-9)).toPrecision(3),
        ),
        "peak radiance (game)": Number(f.peakLuma.toPrecision(3)),
      };
    }
    console.table(rows);

    if (ratios.length < 2) {
      console.error("[lum] not enough stops measured — is the body in frame?");
      return;
    }
    // ── The verdict: is the ratio FLAT across every stop? ───────────────────
    // 🔑 Flatness is the whole test, and it is stronger than checking one step. If
    // all three tiers evaluate the same formula, `measured/expected` is one constant
    // — whatever that constant is — because the form-factor and texture-albedo
    // differences are properties of a tier, not of distance. Any distance at which
    // the ratio jumps is a place two tiers disagree about scale.
    //
    // Every consecutive pair is reported, so the largest jump names its own location
    // rather than being averaged into an rms that hides it.
    let worstJump = { from: 0, to: 0, stops: 0 };
    for (let i = 1; i < ratios.length; i++) {
      const a = ratios[i - 1];
      const b = ratios[i];
      const stops = Math.log2(
        Math.max(b.ratio, 1e-30) / Math.max(a.ratio, 1e-30),
      );
      console.log(
        `[lum]   ${a.px} px → ${b.px} px:  ${a.ratio.toPrecision(4)} → ` +
          `${b.ratio.toPrecision(4)}  (${stops >= 0 ? "+" : ""}${stops.toFixed(2)} stops)` +
          (Math.abs(stops) > 0.5 ? "   ⚠" : ""),
      );
      if (Math.abs(stops) > Math.abs(worstJump.stops)) {
        worstJump = { from: a.px, to: b.px, stops };
      }
    }
    console.log(
      `[lum] largest jump: ${worstJump.from} px → ${worstJump.to} px = ` +
        `${worstJump.stops.toFixed(2)} stops`,
    );
    if (Math.abs(worstJump.stops) < 0.5) {
      console.log(
        "[lum] ✅ SCALE IS CONTINUOUS across every LOD transition (all jumps < 0.5 stops).",
      );
    } else {
      console.error(
        `[lum] ❌ the tiers DISAGREE by ${Math.abs(worstJump.stops).toFixed(2)} stops ` +
          `between ${worstJump.from} px and ${worstJump.to} px.\n` +
          "      ⚠ Note WHERE: a jump around the sphere→billboard boundary is a\n" +
          "      FORM-FACTOR/texture-albedo mismatch (the billboard is a hemisphere\n" +
          "      approximation, the sphere carries a real texture — D09). A jump at\n" +
          "      8 px is the stellar point's scale. They need different fixes.",
      );
    }
    const worst = ratios.reduce(
      (a, r) => Math.max(a, Math.abs(Math.log2(Math.max(r.ratio, 1e-30)))),
      0,
    );
    console.log(
      `[lum] worst |log2(measured/expected)| across all stops: ${worst.toFixed(2)} stops`,
    );
    setStellarPointsEnabled(true);
    console.log(
      "[lum] ⚠ absolute ratios are NOT expected to be exactly 1: the billboard is a\n" +
        "      hemisphere approximation and the sphere carries a real texture whose\n" +
        "      mean albedo differs from bodyPhotometry's disc-averaged value (D09).\n" +
        "      What must hold is that the ratio is STABLE across the handoff — a step\n" +
        "      is a scale mismatch, a constant offset is albedo/texture calibration.",
    );
  }

  /**
   * ⚖ COVERAGE INVARIANCE — does a body's rendered brightness depend on how much
   * of the SCREEN it fills? Physically it must not.
   *
   * 🔑 THE INVARIANT BEING TESTED. Radiance is conserved along a ray, so a planet's
   * surface radiance is **the same at every distance** — only its solid angle
   * shrinks. A photometrically correct pipeline therefore renders the disc at a
   * CONSTANT display-linear value while it changes size. Anything else means
   * exposure is reading the composition of the frame rather than the light in it.
   *
   * ⚠ THIS IS THE ONE GATE THAT MUST RUN WITH AUTO EXPOSURE LIVE. Every other
   * instrument here pins exposure and divides pre-exposure out, precisely so the
   * meter cannot contaminate a radiance measurement. Here the meter IS the
   * subject, so `manual` is forced off for the sweep and restored after.
   *
   * What the two columns separate:
   *  • `disc cd/m²` comes from the PRE-exposure buffer ⇒ pure renderer. Constant.
   *  • `display-lin` is that × `getExposure()` ⇒ renderer × meter. The defect.
   *
   * The fitted slope is the headline number. A flux-mean estimator over the frame
   * returns `metered ≈ coverage · L_disc`, so partial adaptation leaves rendered
   * brightness ∝ `coverage^(−ADAPTATION_K)` — the slope IS the leak, and it should
   * read ≈ 0, not ≈ −k.
   */
  async meter(bodyId = "uranus", settleFrames = 60): Promise<void> {
    if (!_source) {
      console.error("[lum] no render source — is the scene rendering?");
      return;
    }
    const R = bodyRadiusKm(bodyId);
    if (!R) {
      console.error(`[lum] unknown body "${bodyId}"`);
      return;
    }
    const { camera, target } = _source;
    const fovRad =
      (((camera as unknown as { fov?: number }).fov ?? 50) * Math.PI) / 180;
    const screenH = target.height;
    const frameArea = target.width * target.height;

    const wasManual = exposureMeterStatus().manual;
    setManualExposure(false);
    const lx = localExposureStatus();
    console.log(
      `[lum] ⚖ coverage-invariance sweep on ${bodyId} — auto exposure LIVE ` +
        `(restored to ${wasManual ? "manual" : "auto"} afterwards)\n` +
        `      local exposure ${lx.enabled ? "ON" : "OFF"}, strength ` +
        `${lx.enabled ? (lx.overridden ? `${lx.strength} (OVERRIDDEN)` : `${lx.derivedStrength} (derived = ADAPTATION_K)`) : "—"}`,
    );

    // Disc diameter as a fraction of frame HEIGHT. Deliberately all within the
    // textured near/mid tiers: below the far threshold the billboard concentrates
    // the disc's flux into a handful of pixels, so `probeMax` would no longer be
    // measuring a surface radiance and the invariant would not apply.
    const FRACS = [0.9, 0.6, 0.4, 0.25, 0.15, 0.09, 0.05];
    const lodFarKm = getLodThresholds(bodyId)?.far ?? 0;
    const rows: Record<string, Record<string, string | number>> = {};
    const pts: Array<{ cov: number; disp: number; disc: number }> = [];

    for (const frac of FRACS) {
      const px = frac * screenH;
      // px = (2R/d)/fovRad × screenH  ⇒  d = 2R·screenH/(px·fovRad)
      const dCamKm = (2 * R * screenH) / (px * fovRad);
      const altKm = dCamKm - R;
      if (altKm <= 0) continue;
      if (lodFarKm > 0 && dCamKm > lodFarKm) {
        console.log(
          `[lum]   (skipping ${(frac * 100).toFixed(0)}% — ${Math.round(dCamKm)} km is ` +
            "past the far-billboard threshold, where surface radiance is not what draws)",
        );
        continue;
      }
      this.store.set(devTeleportAtom, resolveBodyWarp(bodyId, altKm));
      // Settle the SCENE (tier readiness, streaming), then snap adaptation rather
      // than waiting out TAU_DARKEN_ROD = 6 s per stop, then settle a few more
      // frames so `getExposure()` reflects the snap.
      await sleepFrames(settleFrames);
      // ⚠⚠ ONE SNAP IS NOT ENOUGH, AND THIS SHIPPED WRONG. `resetExposureAdaptation()`
      // snaps the follower to `adaptationTarget(_lastMeteredEV)` — but the metering
      // readback is ASYNC with only one request in flight, so on WebGPU it can lag
      // well past 8 frames. The first version snapped to a STALE metered value and
      // then read the status a few frames later, by which time `meteredEV` had caught
      // up and `adaptedEV` had not. MEASURED consequence: it reported exposure ×254.8
      // where the converged value is ×32 — **a 3-stop error, and every `display-lin`
      // in that run was a transient.** 🔑 A gate that snaps a lagging filter must wait
      // for the INPUT to settle before snapping, and then confirm the two agree.
      let prevEv = Number.NaN;
      let settled = false;
      for (let i = 0; i < 24; i++) {
        await sleepFrames(10);
        const ev = exposureMeterStatus().meteredEV;
        if (Math.abs(ev - prevEv) < 0.02) {
          settled = true;
          break;
        }
        prevEv = ev;
      }
      resetExposureAdaptation();
      await sleepFrames(6);
      const conv = exposureMeterStatus();
      const drift = Math.abs(conv.adaptedEV - conv.targetEV);
      if (!settled || drift > 0.05) {
        console.warn(
          `[lum]   ⚠ ${(frac * 100).toFixed(0)}%: adaptation did NOT converge ` +
            `(metered ${settled ? "settled" : "STILL MOVING"}, follower ${drift.toFixed(2)} ` +
            "stops off target). This row is a transient — do not read it.",
        );
      }

      const m = await this.probeMax(9);
      if (!m) continue;
      const st = exposureMeterStatus();
      const exposure = getExposure();
      // ⚠ WITH LOCAL EXPOSURE LIVE, `radiance × exposure` IS NO LONGER WHAT SHIPS.
      // The composite multiplies a per-pixel local gain too, so a gate that stopped
      // at the global exposure would report the defect as unfixed. Read the gain
      // from the ACTUAL blurred map at the probe's own position rather than
      // recomputing the shader's formula here — a diagnostic that re-derives what it
      // should observe agrees with itself while disagreeing with the frame.
      const localGain = await readLocalGain(_source.renderer, 0.5, 0.5);
      // Analytic disc coverage — the projected area of a circle of `px` diameter
      // over the frame. Not thresholded: an atmosphere halo must not inflate it.
      const coverage = (Math.PI * (px / 2) * (px / 2)) / frameArea;
      const displayLinear = m.luma * exposure * localGain;
      const tier = getLodState(bodyId)?.tier ?? "?";
      pts.push({ cov: coverage, disp: displayLinear, disc: m.luma });
      rows[`${(frac * 100).toFixed(0)}% of height`] = {
        tier,
        "Ø px": Math.round(px),
        "coverage %": Number((coverage * 100).toPrecision(3)),
        "disc cd/m²": Number(m.nits.toPrecision(4)),
        "metered EV": Number(st.meteredEV.toFixed(2)),
        "exposure ×": Number(exposure.toPrecision(4)),
        "local gain": Number(localGain.toPrecision(3)),
        "display-lin": Number(displayLinear.toPrecision(3)),
        "hot share": `${(st.topFluxShare * 100).toFixed(0)}%`,
      };
    }
    console.table(rows);
    setManualExposure(wasManual);

    if (pts.length < 3) {
      console.error("[lum] too few usable stops to fit a slope");
      return;
    }

    const spread = (get: (p: (typeof pts)[number]) => number): number => {
      const v = pts.map(get).filter((x) => x > 0);
      return Math.log2(Math.max(...v) / Math.min(...v));
    };
    const discSpread = spread((p) => p.disc);
    const dispSpread = spread((p) => p.disp);

    // Least squares on log2(display-linear) vs log2(coverage).
    const xs = pts.map((p) => Math.log2(p.cov));
    const ys = pts.map((p) => Math.log2(p.disp));
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < xs.length; i++) {
      sxy += (xs[i] - mx) * (ys[i] - my);
      sxx += (xs[i] - mx) ** 2;
    }
    const slope = sxx > 0 ? sxy / sxx : 0;

    console.log(
      `[lum] disc radiance spread (RENDERER):  ${discSpread.toFixed(2)} stops\n` +
        `[lum] display-linear spread (× METER): ${dispSpread.toFixed(2)} stops\n` +
        `[lum] fitted slope d log2(display) / d log2(coverage) = ${slope.toFixed(3)}\n` +
        `      physically correct = 0.000; a frame-average flux mean predicts ` +
        `−k = ${(-exposureMeterStatus().adaptationK).toFixed(3)}`,
    );
    if (discSpread > 0.35) {
      console.error(
        `[lum] ❌ the RENDERER is not radiance-invariant (${discSpread.toFixed(2)} stops). ` +
          "Fix that before reading the meter columns — a tier change or a phase-angle\n" +
          "      drift in the warp axis would show up here and invalidate the slope.",
      );
    } else {
      console.log(
        `[lum] ✅ renderer is radiance-invariant (${discSpread.toFixed(2)} stops) — ` +
          "the disc's own brightness does not depend on distance, as physics requires.",
      );
    }
    if (Math.abs(slope) < 0.15 && dispSpread < 0.5) {
      console.log(
        `[lum] ✅ COVERAGE INVARIANCE HOLDS — slope ${slope.toFixed(3)}, spread ` +
          `${dispSpread.toFixed(2)} stops. A body's rendered brightness is a function of\n` +
          "      its light, not of how much of the screen it happens to fill.",
      );
    } else {
      console.error(
        `[lum] ❌ COVERAGE-DRIVEN EXPOSURE — the same disc renders ${dispSpread.toFixed(2)} ` +
          `stops brighter when it is small (slope ${slope.toFixed(3)}).\n` +
          "      ⚠ This is NOT fixable by tuning EXPOSURE_BIAS_STOPS or ADAPTATION_K: a\n" +
          "      frame-average estimator is proportional to coverage BY DEFINITION, so any\n" +
          "      global mean carries this slope. It needs a coverage-independent estimator\n" +
          "      or local exposure. See LIGHTING_PLAN D33.",
      );
    }
  }

  /**
   * A/B local exposure (D33) without a reload.
   *
   *   __lum.localExposure()          → report
   *   __lum.localExposure(false)     → OFF (bit-exact: gain becomes 1.0)
   *   __lum.localExposure(true)      → ON at the DERIVED strength (= ADAPTATION_K)
   *   __lum.localExposure(true, 0.5) → ON at a forced strength
   *
   * ⚠ The strength is derived, not authored: `over-exposure = ADAPTATION_K · gap`,
   * so overriding it is a diagnostic, not a tuning knob. If a forced value looks
   * better than the derived one, something else is wrong — check `__lum.meter()`
   * before keeping it.
   */
  localExposure(enabled?: boolean, strength?: number): void {
    if (enabled !== undefined) setLocalExposure(enabled, strength);
    const lx = localExposureStatus();
    console.table({
      enabled: lx.enabled,
      "strength (live)": Number(lx.strength.toPrecision(3)),
      "strength (derived)": lx.derivedStrength,
      overridden: lx.overridden,
      "shadow strength": lx.shadowStrength,
      "map ready": lx.mapReady,
      "map grid": `${lx.cellPx}×${lx.cellPx}`,
      "bilateral radius": `${lx.blurRadiusCells} cells`,
      "range sigma": `${lx.rangeSigmaStops} stops`,
      "reference EV (pre-exposed)": Number(lx.referenceEv.toFixed(2)),
    });
    if (lx.shadowStrength === 0) {
      console.log(
        "[lum] highlights only, ON PURPOSE. A symmetric local gain would lift deep " +
          "space (~25 stops down) by ~12 stops and blow the starfield out. See the\n" +
          "      HIGHLIGHTS ONLY note in exposureMeter.ts.",
      );
    }
    console.log("[lum] gate: await __lum.meter(\"uranus\") — slope should read ~0.");
  }

  /**
   * PRINT the local-adaptation map, as the gain it will actually apply.
   *
   * Orientation is the point: the picture is drawn TOP row = top of the screen, so
   * the dark patch must sit where the bright subject is. If it is mirrored
   * vertically, `uv()` disagrees between the metering pass and the composite — the
   * one failure mode that `__lum.meter()` cannot see, because a centre probe is
   * flip-invariant.
   *
   * Also read the EDGE of the patch: a crisp boundary means the bilateral term is
   * holding the subject/void step, a soft gradient means it is smearing and a halo
   * will be visible at the limb.
   */
  async localMap(): Promise<void> {
    if (!_source) {
      console.error("[lum] no render source — is the scene rendering?");
      return;
    }
    const r = await readLocalMapGrid(_source.renderer);
    if (!r) {
      console.error(
        "[lum] local map not built yet — is local exposure enabled? __lum.localExposure(true)",
      );
      return;
    }
    const lx = localExposureStatus();
    // Darkening in stops, per cell. Ramp is coarse ON PURPOSE: this is a picture of
    // WHERE, not a measurement of how much (that is the `local gain` column).
    const RAMP = " .:-=+*#%@";
    const lines: string[] = [];
    let maxStops = 0;
    // row 0 is the BOTTOM of the screen in the readback, so walk it in reverse.
    for (let row = r.grid.length - 1; row >= 0; row -= 2) {
      let line = "";
      for (let col = 0; col < r.grid[row].length; col++) {
        const excess = r.grid[row][col] - r.refEv;
        const stops = Math.min(Math.max(excess, 0) * lx.strength, 8);
        maxStops = Math.max(maxStops, stops);
        line += RAMP[Math.min(RAMP.length - 1, Math.round((stops / 8) * (RAMP.length - 1)))];
      }
      lines.push(line);
    }
    console.log(
      `[lum] local-adaptation map — '@' = 8 stops of darkening, ' ' = none.\n` +
        `      TOP row = TOP of screen. Peak ${maxStops.toFixed(2)} stops. ` +
        `Reference EV ${r.refEv.toFixed(2)} (pre-exposed), strength ${lx.strength.toPrecision(3)}.\n` +
        lines.join("\n"),
    );
    if (maxStops < 0.05) {
      console.log(
        "[lum] the map is flat — either nothing in frame is above the global " +
          "reference (an even scene, which is correct), or local exposure is off.",
      );
    }
  }

  /**
   * D09 — what each body's colour map actually measures, and the scale applied.
   *
   * Read this FIRST when a body looks individually wrong. `state: "clamped"` or
   * `"failed"` means no correction is being applied at all, which is the case that
   * looks like "the fix didn't work".
   *
   * ⚠ `scale` is derived from the texture that LOADED, so it is only populated for
   * bodies you have been near enough to stream. An empty table means nothing has
   * been visited this session, not that calibration is broken.
   *
   * Also asserts the three places a body's albedo is written down still agree —
   * `bodyPhotometry` (the reference), `stellarPoint.geometricAlbedo` (per body
   * module) and the far billboard's authored colour. The far tier is normalised
   * from `bodyPhotometry` at consumption so it cannot drift; the stellar point's
   * copy CAN, and a silent disagreement there is a per-body brightness step at the
   * one LOD boundary hardest to eyeball.
   */
  albedo(): void {
    const rows: Record<string, Record<string, string | number>> = {};
    for (const c of albedoCalibrationStatus()) {
      rows[c.bodyId] = {
        state: c.state,
        "texture mean": c.measuredSphereMean !== undefined
          ? Number(c.measuredSphereMean.toPrecision(4))
          : "—",
        "target p": c.targetAlbedo ?? "—",
        "lum scale ×": Number(c.scale.toPrecision(4)),
        stops: Number(Math.log2(Math.max(c.scale, 1e-9)).toFixed(2)),
        "per-channel ×": c.scaleRgb.map((x) => x.toPrecision(3)).join(" / "),
        "tex hue R/B": c.measuredRgb
          ? Number((c.measuredRgb[0] / Math.max(c.measuredRgb[2], 1e-9)).toFixed(3))
          : "—",
        "target hue R/B": c.targetRgb
          ? Number((c.targetRgb[0] / Math.max(c.targetRgb[2], 1e-9)).toFixed(3))
          : "—",
        "hue clamped": c.hueClamped ? "⚠ YES" : "",
        note: c.note ?? "",
      };
    }
    if (Object.keys(rows).length === 0) {
      console.log(
        "[lum] no bodies calibrated yet — the scale is measured from the MID tier's " +
          "colour map when it streams in, so visit a body first.",
      );
    } else {
      console.table(rows);
      for (const c of albedoCalibrationStatus()) {
        if (c.state === "skipped") {
          console.warn(
            `[lum] ⚠ ${c.bodyId}: NO texture calibration applied — ${c.note}`,
          );
        }
      }
      const scales = albedoCalibrationStatus()
        .filter((c) => c.state === "done")
        .map((c) => c.scale);
      if (scales.length >= 2) {
        const spread = Math.log2(Math.max(...scales) / Math.min(...scales));
        const gm = Math.exp(
          scales.reduce((a, b) => a + Math.log(b), 0) / scales.length,
        );
        console.log(
          `[lum] correction spread ${spread.toFixed(2)} stops, geometric mean ` +
            `${gm.toPrecision(3)}×.\n` +
            "      🔑 The SPREAD is what D09 removes — a per-body error no exposure " +
            "setting can absorb.\n      The geometric MEAN is harmless: it is one global " +
            "offset that auto-exposure eats.",
        );
      }
    }

    // ── Derived hue (D09) ───────────────────────────────────────────────────
    // ⚠ READ THE CAVEAT BELOW BEFORE TREATING THESE AS FINAL. B−V constrains
    // blue-vs-green only, so red is a LINEAR-SLOPE EXTRAPOLATION — which means the
    // derivation systematically UNDER-saturates any body whose spectrum curves.
    // ⚠ Iterates BODY_PHOTOMETRY, not the mounted-body registry. The hue
    // derivation is a PURE FUNCTION OF STATIC DATA — band albedos and colour
    // indices — so gating its table on what has streamed in was simply wrong: it
    // made the one table that needs no runtime state the hardest to read, empty
    // after every HMR cycle, and unavailable in any headless check. The
    // duplicated-constant audit below still (correctly) needs live bodies,
    // because it compares against what the renderer PUBLISHED.
    const hues: Record<string, Record<string, string | number>> = {};
    for (const id of Object.keys(BODY_PHOTOMETRY)) {
      if (id === "sol") continue;
      const c = bodyColourStatus(id);
      if (!c.rgb) continue;
      const m = Math.max(...c.rgb);
      hues[id] = {
        source: c.source,
        bands: c.bands ?? "—",
        "B−V": c.bMinusV ?? "—",
        "hue R:G:B": c.rgb.map((x) => (x / m).toFixed(2)).join(" : "),
        "R/B": Number((c.rgb[0] / Math.max(c.rgb[2], 1e-6)).toFixed(2)),
      };
    }
    if (Object.keys(hues).length > 0) {
      console.table(hues);
      console.log(
        "[lum] ✅ `band spectrum` rows come from MEASURED per-band geometric albedos\n" +
          "      (Mallama, Krobusek & Pavlov 2017 Table 7 — the same table geometricAlbedo\n" +
          "      itself came from, V column matching to every digit), integrated against the\n" +
          "      CIE colour-matching functions under the star's own Planck spectrum. Those\n" +
          "      rows need no caveat. 🔑 They also QUANTIFIED the old model's error: measured\n" +
          "      R/B is 0.360 for Uranus and 0.322 for Neptune against 0.875 / 0.686 from the\n" +
          "      B−V slope, i.e. 1.8× and 1.6× too red — the exact failure D09b predicted.\n" +
          "      ⚠ `derived from B−V` rows still carry the full caveat below.",
      );
      console.log(
        "[lum] hue is DERIVED from bodyPhotometry.colorIndexBV, not authored — a body's\n" +
          "      colour is a measurement, so a hand-picked triple is a second uncontrolled\n" +
          "      opinion about it (same defect class as the 8.7× brightness spread).\n" +
          "      ⚠⚠ BUT: B−V is ONE degree of freedom and RGB needs TWO, so red comes from a\n" +
          "      linear-spectral-slope model. That model cannot represent narrow absorption\n" +
          "      bands, so it UNDER-saturates bodies whose spectra curve — most visibly Io\n" +
          "      (sulphur) and the ICE GIANTS (methane absorbing in the red, the exact\n" +
          "      opposite of a smooth slope). Treat these as a defensible LOWER BOUND on\n" +
          "      saturation. The real fix is a second measured index (V−R or B−R) per body;\n" +
          "      until then `measuredReflectanceRgb` overrides — CITED VALUES ONLY.\n" +
          "      🔑 Neptune coming out PALE is correct: the iconic vivid-blue Voyager images\n" +
          "      were contrast-enhanced, and reprocessing showed a pale cyan close to Uranus.",
      );
    }

    // ── Duplicated-constant audit ───────────────────────────────────────────
    const dup: Record<string, Record<string, string | number>> = {};
    const seen = getStellarPointAlbedos();
    for (const [id, sp] of seen) {
      const phot = BODY_PHOTOMETRY[id];
      if (!phot || id === "sol") continue;
      const ratio = sp / phot.geometricAlbedo;
      if (Math.abs(Math.log2(ratio)) > 0.02) {
        dup[id] = {
          "bodyPhotometry p": phot.geometricAlbedo,
          "stellarPoint p": sp,
          stops: Number(Math.log2(ratio).toFixed(2)),
        };
      }
    }
    if (seen.length === 0) {
      console.log(
        "[lum] no bodies mounted yet — this audit and the hue table read what the " +
          "renderer PUBLISHED, so they only cover bodies that have been in the scene.\n" +
          "      ⚠ Also empty after an HMR cycle: the registry is a module-level Map, and a " +
          "replaced\n      module starts fresh while the publishing useMemo's deps have not " +
          "changed, so nothing\n      re-publishes until a remount. Reload the page rather " +
          "than trusting an empty table.",
      );
    } else if (Object.keys(dup).length > 0) {
      console.error(
        "[lum] ❌ stellarPoint.geometricAlbedo DISAGREES with bodyPhotometry for these " +
          "bodies. The point tier will step against the billboard:",
      );
      console.table(dup);
    } else {
      console.log(
        `[lum] ✅ all ${seen.length} mounted bodies' stellarPoint.geometricAlbedo match ` +
          "bodyPhotometry (the far tier is normalised from it at consumption, so it " +
          "cannot drift).",
      );
    }
  }

  /**
   * Audit every self-luminous VFX surface in the game (LIGHTING_PLAN D26 step 1).
   *
   * Three things, in the order you want them:
   *
   * 1. **The blackbody integral's anchors.** The thermal rows are only as good as
   *    `blackbodyLuminanceNits`, so this checks it against three targets this
   *    project did not choose — the solar photosphere, a tungsten filament, and
   *    the visible-glow threshold — spanning nine decades. 🔑 If a refactor ever
   *    breaks `planck()` or the ȳ fit, every glowing object in the game silently
   *    rescales; this fails loudly instead.
   * 2. **The emitter table**, brightest first, in cd/m² / game units / EV100.
   *    Compare the EV column against `__lum.prove()`'s metered EV: an emitter far
   *    above everything else in frame is the one owning adaptation.
   * 3. **The live pre-exposure registry.** ⚠ THIS IS THE PART THAT CATCHES BUGS.
   *    The table above is what the code INTENDS; the registry is what is actually
   *    being rescaled each frame. A VFX that is on screen and NOT in the registry
   *    is a D25 site — it will darken by exactly the pre-exposure factor as the
   *    scene gets darker, which `__lum.preExposure(8)` shows as a region moving
   *    when nothing should move.
   */
  emissives(): void {
    for (const a of blackbodyAnchors()) {
      console.log(
        `[lum] blackbody ${a.label.padEnd(24)} ${a.tempK} K -> ` +
          `${a.nits.toExponential(3)} cd/m2   (expected ${a.expected})`,
      );
    }

    const rows: Record<string, Record<string, string | number>> = {};
    for (const r of emitterAudit()) {
      rows[r.id] = {
        kind: r.kind,
        "T (K)": r.tempK ?? "—",
        "cd/m²": Number(r.nits.toPrecision(4)),
        "game units": Number(r.gameUnits.toPrecision(4)),
        EV100: Number(r.ev.toFixed(2)),
        "peak RGB": r.rgb.map((x) => x.toPrecision(3)).join(" / "),
      };
    }
    console.table(rows);
    console.log(
      [
        "[lum] `thermal` rows are DERIVED — real geometry, so `emissive` IS the surface",
        "      radiance and Planck's law fixes it completely. `design` rows are AUTHORED",
        "      but stated in cd/m²: a sprite stands in for something smaller than itself,",
        "      so its radiance is L_emitter × fill and the fill is not known.",
        "      ⚠⚠ Move a thermal row by its TEMPERATURE, never by a multiplier. Visible-band",
        "      blackbody luminance runs ~T¹² near 1500 K (the Planck peak is sweeping INTO",
        "      the photopic band), so ±200 K is ±10× brightness. The most sensitive knob",
        "      in the project.",
        "      🔑 Read each row's `why` in emissivePhotometry.ts before changing it — several",
        "      record a derivation that landed ON the authored value, which is a result.",
      ].join("\n"),
    );

    const live = preExposedEmissiveRows();
    if (live.length === 0) {
      console.warn(
        [
          "[lum] ⚠ the pre-exposure registry is EMPTY. Module-level VFX materials register",
          "      on first import, so this is expected until a mining beam / wreck / debris",
          "      effect has existed once this session. It is NOT expected while one is on",
          "      screen — that would be a live D25 site.",
        ].join("\n"),
      );
      return;
    }
    const byChannel: Record<string, Record<string, string | number>> = {};
    live
      .sort((a, b) => b.baseLuminance - a.baseLuminance)
      .forEach((r, i) => {
        byChannel[`${i}: ${r.type}`] = {
          channel: r.channel,
          "authored units": Number(r.baseLuminance.toPrecision(4)),
          "cd/m²": Number(gameUnitsToNits(r.baseLuminance).toPrecision(4)),
          "authored RGB": r.base.map((x) => x.toPrecision(3)).join(" / "),
        };
      });
    console.table(byChannel);
    console.log(
      [
        `[lum] ${live.length} material(s) under per-frame pre-exposure. The \`channel\` column`,
        "      must read `emissive` for every lit material and `color` for every unlit one.",
        "      ⚠ A lit material showing `color` would be pre-exposing its REFLECTANCE — the",
        "      light already carries pre-exposure, so that applies it twice to the reflected",
        "      term and not at all to the emitted one.",
        "      Cross-check with `await __lum.preExposure(8)`: anything MISSING here moves.",
      ].join("\n"),
    );
  }

  /**
   * D28 — refracted limb light: the atmosphere as a LENS.
   *
   * Prints, for the dominant atmosphere body: the grazing deflection, the
   * atmosphere's FOCAL LENGTH, and the illuminance delivered across a ladder of
   * shadow positions. Then the live value if the ship is currently in shadow.
   *
   * 🔑 The focal length is the number to read first. Surface-grazing rays only
   * reach the shadow AXIS at `R/ω(0)`; closer than that the refracted light is a
   * RING hugging the umbra's edge and the axis is dark. Earth: 310,600 km, and
   * the Moon at 384,400 km sits just past it — which is exactly why an eclipsed
   * Moon is lit at all.
   *
   * ✅ Two independent checks are asserted for Earth: grazing deflection ≈ 1.13°
   * (twice the textbook 34′ of horizon refraction, because a grazing ray crosses
   * the atmosphere twice) and ~1.1 lux on the axis at the Moon's distance (the
   * measured brightness of a typical total lunar eclipse). Neither number was
   * chosen by this project.
   */
  umbra(bodyId?: string): void {
    const rec = bodyId ? getAtmosphereBody(bodyId) : getDominantAtmosphereBody();
    if (!rec) {
      console.log(
        "[lum] no atmosphere body in range. Fly near one, or pass an id: __lum.umbra(\"earth\").",
      );
      return;
    }
    const p = rec.params;
    const R = p.groundRadiusKm;
    const focal = atmosphericFocalLengthKm(p);
    console.log(
      [
        `[lum] ${rec.id}: refracted limb light (D28)`,
        `  grazing deflection ω(0) = ${grazingDeflectionDeg(p).toFixed(3)}°` +
          (rec.id === "earth" ? "   (expect ~1.13 = 2 × 34′ horizon refraction)" : ""),
        `  surface refractivity    = ${p.surfaceRefractivity.toExponential(3)}`,
        `  atmospheric FOCAL LENGTH = ${Math.round(focal).toLocaleString()} km = ${(focal / R).toFixed(1)} R`,
        "  ⇒ closer than that, the refracted light is a RING near the umbra's edge",
        "    and the shadow AXIS is dark. Beyond it, the light fills the axis.",
      ].join("\n"),
    );

    const starAng = Math.asin(
      Math.min(1, STAR_RADIUS_KM / Math.max(rec.starDistanceKm, 1)),
    );
    // ⚠⚠ RECOMPUTED. `rec.sunIlluminance` is PRE-EXPOSED (D25), so reading it
    // here made this whole table scale with the exposure of whatever scene the
    // ship happened to be in — measured on device: the 2.0 R row read 972,000 /
    // 1,110,000 / 272,000 / 66,200 / 48,500 lux from five different vantage
    // points, for a ladder that is supposed to be fixed. 🔑 Same trap as D09c,
    // same field. A diagnostic that varies with the observer is reporting the
    // observer, not the thing.
    const illumRaw = sunIlluminanceAt(
      rec.starDistanceKm,
      rec.params.starLuminositySun,
    );
    const illum: [number, number, number] = [
      illumRaw * STAR_COLOR_LINEAR[0],
      illumRaw * STAR_COLOR_LINEAR[1],
      illumRaw * STAR_COLOR_LINEAR[2],
    ];
    const rows: Record<string, Record<string, string | number>> = {};
    const uLen = (R * rec.starDistanceKm) / STAR_RADIUS_KM;
    for (const mult of [2, 3, 5, 10, 20, focal / R, 60.3]) {
      const d = mult * R;
      if (d <= R) continue;
      const umbraR = Math.max(0, R * (1 - d / uLen));
      // Sweep the offset and keep the brightest — that IS the ring's radius.
      let best = { E: -1, off: 0, band: 0 };
      for (let i = 0; i <= 40; i++) {
        const off = (i / 40) * umbraR;
        const r = refractedLimbIlluminance(d, off, p, illum, starAng);
        const L = r.illuminance[0] * 0.2126 + r.illuminance[1] * 0.7152 + r.illuminance[2] * 0.0722;
        if (L > best.E) best = { E: L, off, band: r.bandAltitudeKm };
      }
      const onAxis = refractedLimbIlluminance(d, 0, p, illum, starAng);
      const axisL =
        onAxis.illuminance[0] * 0.2126 +
        onAxis.illuminance[1] * 0.7152 +
        onAxis.illuminance[2] * 0.0722;
      rows[`${mult.toFixed(1)} R`] = {
        "d (km)": Math.round(d),
        "umbra radius (km)": Math.round(umbraR),
        "on axis (lux)": Number((axisL * NITS_PER_GAME_UNIT).toPrecision(3)),
        "brightest (lux)": Number((best.E * NITS_PER_GAME_UNIT).toPrecision(3)),
        "at offset (% umbra)": umbraR > 0 ? Number(((100 * best.off) / umbraR).toFixed(0)) : "—",
        "through h (km)": Number(best.band.toFixed(1)),
      };
    }
    console.table(rows);
    console.log(
      [
        "[lum] 'brightest' sweeps the offset from the axis out to the umbra edge. The",
        "      refracted light fills an ANNULUS whose INNER edge marches inward with depth",
        "      and reaches the axis at the focal length — that migration is D28's geometry.",
        "      ⚠ The brightest point stays at the RIM (fed by rays grazing high in a thin",
        "      atmosphere, so brighter and less red); watch the 'on axis' column instead,",
        "      which is 0 until the focal length and then climbs.",
        "      ⚠⚠ This table is the RAW model. In the renderer it is multiplied by the",
        "      shadow ramp (1 − sunTransmittance), so the large near-rim values do NOT",
        "      double-count the attenuated direct sun the atmosphere pass already delivers",
        "      there — that ramp goes to 0 exactly where the direct sun survives.",
        "      ⚠ ONE anchored constant in this model (CLEAR_ANNULUS_FRACTION = 0.321, for the",
        "      cloud + boundary-layer aerosol AtmosphereParams does not carry). Everything",
        "      else is derived, so the geometry scales to any planet. Real eclipses swing",
        "      ±2 magnitudes with volcanic aerosol — treat the level as a central value.",
      ].join("\n"),
    );

    const live = sunOcclusionStatus().limb;
    if (live) {
      const L =
        live.illuminance[0] * 0.2126 +
        live.illuminance[1] * 0.7152 +
        live.illuminance[2] * 0.0722;
      console.log(
        [
          `[lum] LIVE — the ship is in ${rec.id}'s shadow:`,
          `  depth ${Math.round(live.depthKm).toLocaleString()} km, offset ${Math.round(live.offsetKm).toLocaleString()} km from the axis`,
          `  refracted illuminance ${(L * NITS_PER_GAME_UNIT).toPrecision(3)} lux, through h = ${live.bandAltitudeKm.toFixed(1)} km`,
          `  hull radiance at albedo 0.333 = ${((L * 0.333) / Math.PI * NITS_PER_GAME_UNIT).toPrecision(3)} cd/m²`,
          "  🔑 A totally eclipsed Moon is ~1.1 lux / 0.11 cd/m². If this reads far under",
          "     that, check the offset against the ring radius in the table above.",
        ].join("\n"),
      );
    } else {
      console.log(
        "[lum] not currently in a planet's shadow, so no live value. Fly into the umbra\n" +
          "      (anti-sunward of the body) and re-run.",
      );
    }
  }

  /**
   * D34 — body-on-body eclipses: which bodies are shadowing which, right now.
   *
   * ⚠ Distinct from `await __lum.eclipse(id)`, which WARPS THE SHIP into a
   * body's umbra to check what the ship sees (D27). This one is synchronous and
   * reports what the BODIES see — no warp, no frames needed.
   *
   * Prints, for every registered body: the star-disc visibility at its CENTRE
   * and the occluders biting into it, with the angular geometry. A total eclipse
   * reads visibility 0; a partial reads between; annular transits read
   * `1 − (r_occ/r_star)²`.
   *
   * 🔑 The centre value is what the FAR/POINT tiers use. The near/mid tiers
   * evaluate the same maths PER PIXEL, so a solar-eclipse spot much smaller than
   * the planet still resolves — a per-centre test would miss it entirely. If a
   * row shows visibility 1 while you can see a shadow on the surface, that is
   * the per-pixel path working and the scalar correctly reporting the centre.
   */
  eclipses(): void {
    const list = sunOccluderList();
    if (list.length === 0) {
      console.log(
        "[lum] no bodies registered yet — CelestialBody registers unconditionally\n" +
          "      every frame, so this is only empty before the scene mounts.",
      );
      return;
    }
    const star = STAR_POSITION_KM;
    const rows: Record<string, Record<string, string | number>> = {};
    let anyEclipse = false;
    for (const body of list) {
      const vis = updateEclipseUniforms(
        _eclipseProbeU,
        body.id,
        [body.centerKm.x, body.centerKm.y, body.centerKm.z],
        body.radiusKm,
        star,
        STAR_RADIUS_KM,
      );
      const occs: string[] = [];
      for (let i = 0; i < MAX_ECLIPSE_OCCLUDERS; i++) {
        const v = _eclipseProbeU.occ[i].value;
        if (v.w <= 0) continue;
        const d = Math.hypot(v.x, v.y, v.z);
        occs.push(
          `${(Math.asin(Math.min(1, v.w / d)) * 180 / Math.PI).toFixed(3)}° @ ${Math.round(d).toLocaleString()} km`,
        );
      }
      if (vis < 0.9999 || occs.length > 0) anyEclipse = true;
      rows[body.id] = {
        "centre visibility": Number(vis.toPrecision(4)),
        "stops lost": vis > 0 ? Number((-Math.log2(vis)).toFixed(2)) : "∞",
        occluders: occs.length > 0 ? occs.join(" | ") : "—",
        ...shadowLandingPoint(body, star, jdFromUnixMs(this.store.get(simEpochMsAtom))),
      };
    }
    console.table(rows);
    console.log(
      [
        `[lum] ${list.length} bodies. ` +
          (anyEclipse
            ? "At least one is being eclipsed right now."
            : "Nothing is eclipsing anything — geometry, not a bug."),
        "      ⚠ `centre visibility` drives the FAR/POINT tiers only. Near/mid run the",
        "      same circle-overlap PER PIXEL, so a solar-eclipse spot smaller than the",
        "      planet resolves there while this column still reads ~1.",
        "      🔑 Both directions come from one function: an occluder whose shadow is",
        "      bigger than the body gives a lunar eclipse, smaller gives a solar one.",
        "      ⚠ An eclipsed body with an ATMOSPHERE-bearing occluder should not be pure",
        "      black — D28's refracted limb light is what makes it coppery, and it",
        "      currently reaches the SHIP only (see `__lum.umbra()`).",
        "      🔑🔑 `umbra lat/lon` IS THE FRAME GATE — where the shadow AXIS hits the body,",
        "      in the body's OWN geographic coordinates, so it tests the whole chain:",
        "      ephemeris → orientation → the frame the per-pixel shader shades in.",
        "      2024-04-08 18:17 UTC must read ≈ 25° N, 104° W (northwest Mexico);",
        "      2027-08-02 10:07 UTC ≈ 25° N, 33° E (Luxor).",
        "      ⚠ EVERY OTHER COLUMN HERE IS COMPUTED WITHOUT THE BODY'S ROTATION and so",
        "      stayed correct while the rendered shadow was painted up to 180° away.",
        "      A centre visibility of 0.31 with no visible shadow is exactly that.",
      ].join("\n"),
    );
  }

  /**
   * The ephemeris, checked against published eclipse data.
   *
   * 🔑 Why eclipses are the gate: γ (the miss distance of the shadow axis from
   * Earth's centre, in Earth radii) and the time of greatest eclipse depend on
   * the Sun AND Moon positions TOGETHER, including the frame handling. No
   * synthetic self-consistency check can catch a frame mismatch; this one did —
   * see the precession note in `ephemeris.ts`, worth 0.34° and 33 minutes.
   */
  ephemeris(): void {
    const cases = [
      { label: "2024-04-08", y: 2024, mo: 4, d: 8, h: 18, mi: 17, gamma: 0.3435 },
      { label: "2017-08-21", y: 2017, mo: 8, d: 21, h: 18, mi: 26, gamma: 0.4367 },
    ];
    const rows: Record<string, Record<string, string | number>> = {};
    for (const c of cases) {
      let best = { sep: 1e9, mins: 0, dist: 0 };
      for (let mins = -300; mins <= 300; mins++) {
        const jd = jdFromUTC(c.y, c.mo, c.d, c.h, c.mi, 0) + mins / 1440;
        const sep = sunMoonSeparationDeg(jd);
        if (sep < best.sep) {
          best = { sep, mins, dist: moonGeocentric(jd).distKm };
        }
      }
      const tot = c.h * 60 + c.mi + best.mins;
      const earthAngDeg =
        (Math.asin(6371 / best.dist) * 180) / Math.PI;
      const gamma = best.sep / earthAngDeg;
      rows[c.label] = {
        "greatest (mine)": `${String(Math.floor(tot / 60)).padStart(2, "0")}:${String(((tot % 60) + 60) % 60).padStart(2, "0")} UTC`,
        "published": `${String(c.h).padStart(2, "0")}:${String(c.mi).padStart(2, "0")} UTC`,
        "Δt (min)": best.mins,
        "γ (mine)": Number(gamma.toFixed(4)),
        "γ (published)": c.gamma,
        "γ error": `${(100 * (gamma / c.gamma - 1)).toFixed(1)}%`,
      };
    }
    console.table(rows);

    // Earth's orbit, independent of the Moon.
    const peri = jdFromUTC(2024, 1, 3);
    const aphe = jdFromUTC(2024, 7, 5);
    const dist = (jd: number): number => {
      const m = solveSystem(allBodyDefs(), jd).get("earth");
      return m ? Math.hypot(m[0], m[1], m[2]) / AU_KM : NaN;
    };
    console.log(
      [
        `[lum] Earth heliocentric distance: perihelion ${dist(peri).toFixed(5)} AU (expect 0.98330),`,
        `      aphelion ${dist(aphe).toFixed(5)} AU (expect 1.01671)`,
      ].join("\n"),
    );

    // Live state.
    // ⚠ Derived from the sim-time ATOM, not from `solvedEphemerisJD()`. The
    // solved JD is NaN until a `CelestialBody` frame loop has run at least once,
    // and a diagnostic that reports NaN because the renderer has not ticked yet
    // is reporting the renderer, not the ephemeris.
    const jdNow = jdFromUnixMs(this.store.get(simEpochMsAtom));
    const jdRendered = solvedEphemerisJD();
    const solved = solveSystem(allBodyDefs(), jdNow);
    const _orient = createBodyOrientation();
    const live: Record<string, Record<string, string | number>> = {};
    const starPos = solved.get(allBodyDefs()[0].id) ?? [0, 0, 0];
    solved.forEach((p, id) => {
      const def = allBodyDefs().find((b) => b.id === id);
      const o = def?.rotation ? bodyOrientation(def, jdNow, _orient) : null;
      // ── SUB-STELLAR POINT: the column the old gate was missing ─────────────
      // ⚠⚠ Greatest-eclipse TIME and γ both passed while the sub-solar LONGITUDE
      // was 93° wrong (the 2024 umbra landed in the Sahara instead of Mexico),
      // because neither depends on the body's own rotation. Latitude and
      // longitude of the point the star is overhead is the ONLY quantity here
      // that tests the orientation chain end to end.
      let subLat: string | number = "—";
      let subLon: string | number = "—";
      if (o) {
        const sx = starPos[0] - p[0];
        const sy = starPos[1] - p[1];
        const sz = starPos[2] - p[2];
        const sl = Math.hypot(sx, sy, sz) || 1;
        const ux = sx / sl, uy = sy / sl, uz = sz / sl;
        // World → object: project onto the body's own axes (X = prime meridian,
        // Y = pole, Z = X × Y = 90° west of the prime meridian).
        const zx = o.meridian[1] * o.pole[2] - o.meridian[2] * o.pole[1];
        const zy = o.meridian[2] * o.pole[0] - o.meridian[0] * o.pole[2];
        const zz = o.meridian[0] * o.pole[1] - o.meridian[1] * o.pole[0];
        const ox = ux * o.meridian[0] + uy * o.meridian[1] + uz * o.meridian[2];
        const oy = ux * o.pole[0] + uy * o.pole[1] + uz * o.pole[2];
        const oz = ux * zx + uy * zy + uz * zz;
        subLat = Number((Math.asin(Math.max(-1, Math.min(1, oy))) * (180 / Math.PI)).toFixed(2));
        subLon = Number((Math.atan2(-oz, ox) * (180 / Math.PI)).toFixed(2));
      }
      live[id] = {
        "dist from origin (AU)": Number((Math.hypot(p[0], p[1], p[2]) / AU_KM).toPrecision(4)),
        "spin (°)": o ? Number(o.spinDeg.toFixed(1)) : "—",
        "tilt (°)": o ? Number(o.tiltDeg.toFixed(2)) : "—",
        "sub-stellar lat (°)": subLat,
        "sub-stellar lon (°)": subLon,
      };
    });
    console.table(live);
    const eref = live["earth"];
    if (eref && typeof eref["sub-stellar lon (°)"] === "number") {
      // Reference values for the DEFAULT epoch only (2024-04-08 18:17 UTC),
      // computed independently from GMST + the sun's apparent RA/dec. At other
      // dates this line is meaningless, hence the guard.
      const isDefaultEpoch = Math.abs(jdNow - 2460409.26181) < 1e-4;
      const dLat = (eref["sub-stellar lat (°)"] as number) - 7.593;
      const dLon = (eref["sub-stellar lon (°)"] as number) - -93.841;
      console.log(
        isDefaultEpoch
          ? `[lum] Earth sub-solar point: expect lat +7.59, lon −93.84 — got lat ` +
            `${eref["sub-stellar lat (°)"]}, lon ${eref["sub-stellar lon (°)"]} ` +
            `(Δ ${dLat.toFixed(2)}° / ${dLon.toFixed(2)}°) ` +
            `${Math.abs(dLat) < 0.5 && Math.abs(dLon) < 0.5 ? "✅" : "❌"}\n` +
            `      🔑 The 2024-04-08 umbra must land on NORTHWEST MEXICO. On the Sahara means the\n` +
            `      orientation chain is broken even though the eclipse TIME and γ above still pass.`
          : `[lum] Earth sub-solar point: lat ${eref["sub-stellar lat (°)"]}, ` +
            `lon ${eref["sub-stellar lon (°)"]} (no reference — not the default epoch)`,
      );
    }

    // ── Anchored positions ───────────────────────────────────────────────────
    // The spawn point and every asteroid field are FIXED OFFSETS from a body,
    // with the absolute value derived in place by `updateEphemerisPositions`.
    // This table is the diagnostic for the E0 staleness class: each row compares
    // the live distance-from-parent against the AUTHORED offset magnitude. A
    // consumer that froze a copy disagrees by ~1 AU, not by rounding.
    const anchorSys = solSystem as unknown as {
      startingPositionKm: number[];
      startingBody?: string;
      startingOffsetKm?: number[];
      asteroidFields?: {
        id: string;
        anchorKm: number[];
        anchorBody?: string;
        anchorOffsetKm?: number[];
      }[];
    };
    const anchorRow = (
      absolute: number[],
      parentId: string | undefined,
      offset: number[] | undefined,
    ): Record<string, string | number> => {
      const parent = allBodyDefs().find((b) => b.id === parentId);
      if (!parent || !offset) return { parent: "— (absolute)", "live |Δ| (km)": "—" };
      const live = Math.hypot(
        absolute[0] - parent.positionKm[0],
        absolute[1] - parent.positionKm[1],
        absolute[2] - parent.positionKm[2],
      );
      const authored = Math.hypot(offset[0], offset[1], offset[2]);
      return {
        parent: parentId ?? "—",
        "live |Δ| (km)": Number(live.toPrecision(6)),
        "authored |Δ| (km)": Number(authored.toPrecision(6)),
        ok: Math.abs(live - authored) < 1 ? "✅" : "❌ STALE",
      };
    };
    const anchorTable: Record<string, Record<string, string | number>> = {
      spawn: anchorRow(
        anchorSys.startingPositionKm,
        anchorSys.startingBody,
        anchorSys.startingOffsetKm,
      ),
    };
    for (const f of anchorSys.asteroidFields ?? []) {
      anchorTable[f.id] = anchorRow(f.anchorKm, f.anchorBody, f.anchorOffsetKm);
    }
    console.table(anchorTable);

    console.log(
      [
        `[lum] sim time = ${formatSimTime(this.store.get(simEpochMsAtom))}  (JD ${jdNow.toFixed(5)})`,
        `      renderer last solved: ${Number.isFinite(jdRendered) ? "JD " + jdRendered.toFixed(5) : "never (no frame has run)"}`,
        `      rate = ${this.store.get(simRateAtom)}× real time (0 = frozen)`,
        "      ⚠ Galilean moons: their ELEMENTS are real but `meanAnomalyAtEpochDeg`",
        "      is a PLACEHOLDER 0, so their orbital PHASE is wrong. Io transits",
        "      Jupiter at the right INTERVAL but not at the right TIME. Needs a",
        "      cited epoch longitude per moon.",
        "      🔑 Everything is referred to the FIXED J2000 ecliptic, +Y = ecliptic",
        "      north. Mixing in an equinox-of-date quantity is a 1.4°/century error.",
      ].join("\n"),
    );
  }

  /**
   * Phase 9: the night-side floor every body now gets from the sky.
   *
   * 🔑 The calibration argument, and it is the user's: if the Milky Way's
   * nebulosity and starlight on the hull are visible, a planet's night side CANNOT
   * be black — it is lit by the same sky. This prints the two side by side.
   */
  nightSide(): void {
    const sh = getSkySh();
    if (!sh) {
      console.log("[lum] sky SH not baked yet — needs StarField parsed + one panorama bake");
      return;
    }
    const MW_BAND_NITS = 1.25e-4; // 150 S10 in the galactic plane; see §8
    const EYE_FLOOR_NITS = 1e-6; // dark-adapted absolute threshold
    const rows: Record<string, Record<string, string | number>> = {};
    // Six normals: the SH gives a real hemispherical gradient, so a body's night
    // side is not one number.
    const dirs: Array<[string, [number, number, number]]> = [
      ["+X", [1, 0, 0]], ["-X", [-1, 0, 0]],
      ["+Y (ecl. north)", [0, 1, 0]], ["-Y", [0, -1, 0]],
      ["+Z", [0, 0, 1]], ["-Z", [0, 0, -1]],
    ];
    for (const [name, d] of dirs) {
      const e = evaluateShIrradiance(sh, d[0], d[1], d[2]);
      const lux = ((e[0] + e[1] + e[2]) / 3) * NITS_PER_GAME_UNIT;
      // Lambert albedo = 3/2 × geometric, then L = A·E/π — the same conversion
      // `surfaceRadiance` applies, so this table and the shader cannot disagree.
      const nits = (0.3 * 1.5 * lux) / Math.PI;
      rows[name] = {
        "sky E (lux)": Number(lux.toPrecision(3)),
        "L at albedo 0.30 (cd/m²)": Number(nits.toPrecision(3)),
        "vs Milky Way band": Number((nits / MW_BAND_NITS).toPrecision(3)),
        "vs eye floor": Number((nits / EYE_FLOOR_NITS).toPrecision(3)),
      };
    }
    console.table(rows);

    // ── Planetshine, per body, from the same registry the eclipse uses ──────
    // 🔑 Every row here is DERIVED — geometry from the sun-occluder registry,
    // albedo from `bodyReflectanceRgb` (D09e band spectra), the emitter's solar
    // illuminance from its live star distance. So a body added to sol.json, or
    // generated, appears here with no new data.
    const shineRows: Record<string, Record<string, string | number>> = {};
    const star = STAR_POSITION_KM;
    for (const body of sunOccluderList()) {
      const strongest = updateShineUniforms(
        _shineProbeU,
        body.id,
        [body.centerKm.x, body.centerKm.y, body.centerKm.z],
        star,
        STAR_LUMINOSITY_SUN,
        1, // pre-exposure 1 ⇒ absolute game units, so this table is observer-free
        STAR_RADIUS_KM,
      );
      if (strongest <= 0) continue;
      // The strongest slot, as the sub-emitter-point irradiance and the resulting
      // surface luminance at that body's own albedo.
      const refl = bodyReflectanceRgb(body.id);
      const p = refl ? 0.2126 * refl.r + 0.7152 * refl.g + 0.0722 * refl.b : 0.3;
      const lux = strongest * NITS_PER_GAME_UNIT;
      const nits = (p * 1.5 * lux) / Math.PI;
      shineRows[body.id] = {
        "E from brightest emitter (lux)": Number(lux.toPrecision(3)),
        "night L at own albedo (cd/m²)": Number(nits.toPrecision(3)),
        "× the sky-light floor": Number((nits / 4.7e-5).toPrecision(3)),
        "EV100 for middle grey": Number(
          Math.log2(1 / (1.2 * (0.18 / (nits / NITS_PER_GAME_UNIT)))).toFixed(1),
        ),
      };
    }
    console.table(shineRows);
    console.log(
      [
        "[lum] PLANETSHINE (Phase 9 step 2) — the DOMINANT night-side term wherever a",
        "      companion exists, and the eclipse problem inverted: same occluder",
        "      registry, same 4 branchless slots, same per-pixel / far-scalar split.",
        "      🔑 `EV100 for middle grey` is the column that matters: EV_MIN = -18, so a",
        "      row at or above -18 WILL be visible and a row below it will not. The",
        "      starlight-only floor needs -25.2 (7.2 stops below the clamp) which is why",
        "      it renders black; moonlit Earth lands at exactly -18.0.",
        "      ✅ VALIDATED ON DEVICE 2026-08-28, and the sharpest check is the PHASE",
        "      REVERSAL: at full moon Earth reads 0.334 lux (EV −14.2, visible) while Luna",
        "      reads 1.86e-4 (EV −26.7, black); at the 2024-04-08 eclipse — a NEW moon —",
        "      they swap, Luna 17.4 lux (EV −10.2) and Earth 9.4e-5 (EV −26.0). 🔑 Earth",
        "      and Luna MUST anti-correlate, because a full Earth seen from the Moon is a",
        "      new Moon seen from Earth. If they ever move together, Φ(g) is broken.",
        "      Predicted 0.355 lux for a full moon vs 0.334 measured: 6%.",
        "      ⚠ Lambert phase function, so the Moon reads 1.42× high against a MEASURED",
        "      0.25 lux (0.355 modelled) — it has a strong opposition surge no Lambert model",
        "      reproduces. Do NOT trim its albedo to hide this: the day side is calibrated",
        "      on that same value.",
        "      ⚠ NOT modelled: an emitter that is itself eclipsed, and interreflection.",
        "      🔑 EMERGENT and correct: Jupiter's own night side is lit by the Galileans to",
        "      EV −18.1, right at the clamp; Mercury and Venus are lit by Earth at ~0.3–1.5×",
        "      the starlight floor. Nothing configured that — it falls out of the registry.",
      ].join("\n"),
    );

    // ── The live chain, so "correctly dim" can be told from "never arrived" ──
    // ⚠ Deliberately observer-DEPENDENT, unlike the table above, and labelled as
    // such: the question this answers is what the BUFFER holds, which depends on
    // this frame's exposure. Mixing the two into one number is what made the D28
    // umbra ladder unreadable.
    const preExp = getPreExposure();
    const worst = 3.2e-5 / NITS_PER_GAME_UNIT; // dimmest normal, game units
    const buffered = worst * preExp;
    const FP16_SUBNORMAL = 2 ** -24;
    const FP16_NORMAL = 2 ** -14;
    console.log(
      [
        `[lum] exposure ${getExposure().toPrecision(4)}  ·  pre-exposure ${preExp.toPrecision(4)}  (EV_MIN allows up to ${(1 / (1.2 * 2 ** -18)).toPrecision(4)})`,
        `      dimmest night-side radiance ${worst.toExponential(2)} game units → buffer holds ${buffered.toExponential(2)}`,
        `      half-float floors: subnormal ${FP16_SUBNORMAL.toExponential(2)}, normal ${FP16_NORMAL.toExponential(2)}`,
        `      ⇒ ${
          buffered < FP16_SUBNORMAL
            ? "❌ FLUSHES TO ZERO — the term cannot survive the buffer at this exposure"
            : buffered < FP16_NORMAL
              ? "⚠ subnormal — survives, but with only a few bits of mantissa"
              : "✅ inside half-float normals — the term is representable"
        }`,
        "      🔑 If this says ✅ and the night side still looks black, the term is",
        "      arriving and is simply DIM — see the reference below. Probe it:",
        "      __lum.probe(x, y) on a night-side pixel gives the absolute value.",
      ].join("\n"),
    );

    console.log(
      [
        "[lum] ── WHAT TO EXPECT, and ⚠⚠ A CORRECTION TO AN EARLIER CLAIM IN THIS GATE ──",
        "      This gate used to say \"expect ~0.002 lux ⇒ 1.9e-4 cd/m² ≈ 1.5× the Milky",
        "      Way band\". **BOTH HALVES WERE WRONG.** Decomposed against Leinert et al.",
        "      1998 (visual, zenith, S10 units; 1 S10 = 8.34e-7 cd/m²):",
        "",
        "        airglow              145 S10   NOT modelled",
        "        zodiacal light        60 S10   NOT modelled",
        "        integrated starlight 100 S10   ✅ in this SH (catalogue)",
        "        diffuse galactic      25 S10   ✅ in this SH (panorama)",
        "        ─────────────────────────────",
        "        real total           330 S10 → 8.65e-4 lux",
        "        modelled             125 S10 → 3.28e-4 lux   = 38% of the real sky",
        "",
        "      🔑 So the SH is CORRECT for what it contains — the measured 2.2e-4..5.1e-4",
        "      lux brackets 3.28e-4. The old 0.002 lux reference was 2.3× too high AND",
        "      ignored that airglow + zodiacal are 62% of the real night sky.",
        "",
        "      🔑🔑 AND THE 1.5× CONCLUSION WAS STRUCTURALLY IMPOSSIBLE: a 30%-albedo",
        "      DIFFUSE surface lit by the WHOLE sky must be dimmer than the BRIGHTEST",
        "      PATCH of that sky. The Milky Way band is that brightest patch. Correct",
        "      targets: 0.38× the band from the modelled sky, 0.99× with airglow and",
        "      zodiacal added. A night side dimmer than the galaxy is EXPECTED.",
        "",
        "      ── WHAT A NIGHT-SIDE PIXEL SHOULD PROBE AS (modelled sky, ~3.0e-4 lux) ──",
        "      ⚠⚠ USE THE TEXTURE'\''S value, NOT a published albedo. The shader multiplies",
        "      the sky irradiance by `dayCol` — the actual texel — so the reference is what",
        "      D23 MEASURED on Earth'\''s day map, linearised, not a broadband figure:",
        "        cloud deck        7.3e-5 cd/m²   E × CLOUD_SUN_SCALE 0.223",
        "        land (mean 0.296) 4.3e-5 cd/m²   E × dayCol × 1.5/π",
        "        ocean (mean .0062) 8.9e-7 cd/m²",
        "        ocean (the flat value 0.00178, = 88% of all ocean) 2.6e-7 cd/m²",
        "      🔑 OCEAN IS ~165× DARKER THAN LAND HERE, not 5× as a broadband albedo",
        "      (0.06 vs 0.30) would suggest. Earth'\''s day texture holds 0.00178 over open",
        "      water — visible-band water-leaving reflectance, which is genuinely near",
        "      zero; 0.06 is BROADBAND and mostly NIR the texture does not and must not",
        "      carry. **This gate previously quoted 9.4e-6 for ocean from that 0.06 — 34×",
        "      too high, and it is the exact D23 error repeated.**",
        "      🔑 CLOUDS ARE THE BRIGHTEST PART of a night side — higher reflectance than",
        "      land — so a cloudy night limb reading DARKER than a clear one is a bug.",
        "      ⚠ FIXED 2026-08-28: `farCloudLit` multiplied everything by",
        "      `clamp(daylight,0,1)`, so the cloud shell drew vec4(0, alpha) at night and,",
        "      being `transparent`, hid the sky-lit ground behind it by (1−alpha) — a thick",
        "      deck is alpha≈0.998, i.e. ~600× of the only light there was, over ~67% of",
        "      Earth. A probe reading ~1e-7 instead of ~5e-5 was that.",
        "      ⚠ STILL OPEN: the VOLUMETRIC marcher has the same gate",
        "      (`skyColorS = uAtmoSkyColor × daylightS`, earthClouds.ts ~3535) and so is",
        "      still black at night. It only runs below 700 km, so it does not affect an",
        "      orbital view — but a low pass over the night side will still be dark.",
        "",
        "      ⇒ What makes a night side visible, and where it stands:",
        "        • PLANETSHINE — ✅ LANDED (P9d). MEASURED on device against this floor:",
        "          Moon→Earth 1,470× (full moon), Earth→Luna 24,000×, Ganymede 7,250–35,200×,",
        "          Jupiter→Io 315,000–385,000×. It is the whole visible night side.",
        "        • airglow (+~2.4×) — ⚠ still open, and the ONE term that is NOT free",
        "          generically: Earth's is O₂/OH chemistry, so it needs an AtmosphereParams",
        "          field rather than a derivation.",
        "        • zodiacal light (+~1.5×) — still open, but IS generic: forward-scattered",
        "          starlight off interplanetary dust, from star luminosity + ecliptic angle.",
        "        ⇒ Neither remaining term rescues a MOONLESS night side: together they are",
        "        3.9×, and the starlight floor is 7.2 stops below the exposure clamp.",
        "",
        "      ⚠ Sol is NOT in this SH (the catalogue builder excludes it), so there is",
        "      no double count with the direct sun term.",
        "      ⚠ At these levels the eye is SCOTOPIC (desaturated, blue-shifted). Phase 7",
        "      owns that; do not hand-tune the night side's colour before it lands.",
      ].join("\n"),
    );
  }


  /**
   * GATE: the retina — scotopic/mesopic vision + the Purkinje shift (Phase 7).
   *
   * 🔑 WHAT THIS ANSWERS, which no screenshot can: **is the frame actually in the
   * luminance range where rods take over, or does it merely LOOK dark?** Those are
   * completely different failures. A night side that renders black because it is
   * 7 stops below the exposure clamp is not a scotopic scene — it is a missing
   * one — and the eye model cannot fix it. This prints the regime split of the
   * real frame so the two can never be confused again.
   *
   * ⚠ THE `s` COLUMN IS PREDICTED, NOT OBSERVED, and that is a real limitation:
   * the retina stage runs AFTER the target `probe()` reads, so no readback can see
   * its output. The defence against the self-agreement trap is narrower than
   * usual and worth stating: the prediction calls `scotopicMixCpu`, which reads
   * the SAME live uniforms the shader samples and the same `rodConeBlend` — so a
   * wrong CONSTANT cannot hide here. What this cannot catch is the stage being
   * unwired entirely. For that, A/B it: `__lum.scotopic(false)` vs `(true)`.
   */
  async scotopic(
    enable?: boolean,
    opts?: { strength?: number; cctK?: number; derive?: boolean },
  ): Promise<Record<string, unknown> | void> {
    if (enable !== undefined) {
      setScotopic(enable, opts);
      console.log(
        `[lum] scotopic ${enable ? "ON" : "OFF"} — strength ${scotopicStatus().strength}, Purkinje ${scotopicStatus().purkinjeCctK} K`,
      );
    }
    const st = scotopicStatus();

    // ── 1. The model, as the shader currently holds it ──────────────────────
    console.log(
      [
        `[lum] RETINA — rods, cones and the Purkinje shift (Phase 7)`,
        `      stage ${st.enabled ? "✅ ON" : "⬜ OFF (bit-exact passthrough)"}   strength ${st.strength.toFixed(2)}`,
        `      scotopic V′ weights  [${st.weights.map((v) => v.toFixed(4)).join(", ")}]  (sum ${st.weights.reduce((a, b) => a + b, 0).toFixed(4)})`,
        `      photopic  V  weights  [${st.photopicWeights.map((v) => v.toFixed(4)).join(", ")}]`,
        `      ⇒ Purkinje per channel  R ×${(st.weights[0] / st.photopicWeights[0]).toFixed(3)}   G ×${(st.weights[1] / st.photopicWeights[1]).toFixed(3)}   B ×${(st.weights[2] / st.photopicWeights[2]).toFixed(3)}`,
        `      Purkinje tint  ${st.purkinjeCctK} K → [${st.purkinjeTint.map((v) => v.toFixed(3)).join(", ")}]  ⚠ the ONE authored number (rods carry no hue)`,
        `      mesopic band  ${st.mesopicLoNits} … ${st.mesopicHiNits} cd/m²  (CIE 191:2010, ${(Math.log2(st.mesopicHiNits / st.mesopicLoNits)).toFixed(2)} stops, smoothstep in LOG L)`,
        `      adapting luminance ${st.adaptNits.toExponential(3)} cd/m²  ⚠ DIAGNOSTIC ONLY — not an input`,
        `        (a global bleaching floor of s ≥ ${st.adaptBlendIfGlobal.toFixed(3)} was built here and REMOVED; see scotopic.ts)`,
      ].join("\n"),
    );

    // ── 2. The ladder — where the transition actually sits ───────────────────
    // Reference luminances this project has already measured elsewhere, so the
    // band can be judged against the scenes it will be seen in rather than
    // against its own definition.
    const ladder: Array<[string, number]> = [
      ["sunlit cloud top (the exposure anchor)", 19146],
      ["sunlit Earth ground", 3000],
      ["full moon disc", 3000],
      ["Jupiter sunlit disc", 1216],
      ["Uranus sunlit disc", 81],
      ["deep twilight", 1],
      ["moonlit ground (Phase 9 measured)", 0.069],
      ["Milky Way band, PHYSICAL", 1.25e-4],
      ["planet night side, sky-lit floor", 3.2e-5],
      ["airglow", 1e-4],
      ["scotopic absolute threshold", 1e-6],
    ];
    const rows: Record<string, Record<string, string | number>> = {};
    for (const [name, nits] of ladder) {
      const s = rodConeBlend(nits);
      rows[name] = {
        "cd/m²": Number(nits.toPrecision(3)),
        "EV100": Number(evFromNits(nits).toFixed(1)),
        "s (1=photopic)": Number(s.toFixed(4)),
        regime: s > 0.99 ? "photopic" : s < 0.01 ? "SCOTOPIC" : "mesopic",
      };
    }
    console.table(rows);

    // ── 3. The live frame: what regime is the player actually in? ────────────
    if (!_source) {
      console.error("[lum] no render target registered — is the scene mounted?");
      return;
    }
    const { renderer, target } = _source;
    const N = 32; // 32×32 = 1024 samples of the real frame
    const stepX = Math.max(1, Math.floor(target.width / N));
    const stepY = Math.max(1, Math.floor(target.height / N));
    const buf = await renderer.readRenderTargetPixelsAsync(
      target,
      0,
      0,
      target.width,
      target.height,
    );
    const isHalf = buf instanceof Uint16Array;
    const isByte = buf instanceof Uint8Array;
    const a = buf as unknown as ArrayLike<number>;
    const stride = rowStrideElements(target.width, isHalf ? 2 : isByte ? 1 : 4);

    let scot = 0;
    let meso = 0;
    let phot = 0;
    let satBefore = 0;
    let satAfter = 0;
    let satGrey = 0;
    let counted = 0;
    let brightest = { nits: 0, rgb: [0, 0, 0] as [number, number, number] };
    for (let y = 0; y < target.height; y += stepY) {
      for (let x = 0; x < target.width; x += stepX) {
        const rgb = decodeRgb(a, y * stride + x * 4, isHalf, isByte);
        const luma =
          REC709[0] * rgb[0] + REC709[1] * rgb[1] + REC709[2] * rgb[2];
        const nits = luma * NITS_PER_GAME_UNIT;
        const s = rodConeBlend(nits);
        if (s > 0.99) phot++;
        else if (s < 0.01) scot++;
        else meso++;
        if (nits > brightest.nits) brightest = { nits, rgb };
        // Saturation as max-min over max — crude, but it is the quantity the
        // complaint is about ("too colourful for the luminance") and it survives
        // the scale-invariance the mix has.
        const sat = (c: readonly number[]) => {
          const mx = Math.max(c[0], c[1], c[2]);
          return mx > 0 ? (mx - Math.min(c[0], c[1], c[2])) / mx : 0;
        };
        satBefore += sat(rgb);
        satAfter += sat(scotopicMixCpu(rgb, nits).out);
        // Desaturation ALONE, with the tint forced neutral. 🔑 Reported separately
        // because the two halves of this stage pull in OPPOSITE directions on the
        // chroma metric, and the first tint default was wrong by 4.9× precisely
        // because one aggregate number hid that.
        const { s: sPix, rod } = scotopicMixCpu(rgb, nits);
        satGrey += sat([
          rod * (1 - sPix) + rgb[0] * sPix,
          rod * (1 - sPix) + rgb[1] * sPix,
          rod * (1 - sPix) + rgb[2] * sPix,
        ]);
        counted++;
      }
    }
    const pct = (n: number) => Number(((100 * n) / counted).toFixed(1));
    console.log(
      [
        `[lum] THIS FRAME — ${counted} samples of the composited scene`,
        `      photopic ${pct(phot)}%   mesopic ${pct(meso)}%   SCOTOPIC ${pct(scot)}%`,
        `      mean chroma  ${(satBefore / counted).toFixed(4)} → ${(satAfter / counted).toFixed(4)}  (${st.enabled ? "DELIVERED" : "would be, if enabled"})`,
        `        of which: desaturation alone → ${(satGrey / counted).toFixed(4)}   the Purkinje tint adds ${((satAfter - satGrey) / counted >= 0 ? "+" : "") + ((satAfter - satGrey) / counted).toFixed(4)}`,
        // ⚠⚠ THE TEST IS AGAINST `satBefore`, NOT AGAINST `satGrey`. An earlier version
        // warned whenever the tint exceeded the desaturation, which fires on any
        // already-neutral frame (deep space) where the tint is most of a SMALL
        // residual — chroma 0.229 → 0.103 is a 2.2× DRAIN even though the tint is 74%
        // of what is left. The only failure worth a warning is net chroma going UP.
        satAfter > satBefore
          ? `        ❌ NET CHROMA WENT UP (${(satBefore / counted).toFixed(4)} → ${(satAfter / counted).toFixed(4)}). The stage is PAINTING the frame`
          : `        ✅ net drain ${(satBefore / satAfter).toFixed(2)}× — the stage is removing colour, not adding it.`,
        satAfter > satBefore
          ? "        blue rather than draining it. Lower PURKINJE_CCT_K toward 6504 K."
          : `        (tint is ${((100 * (satAfter - satGrey)) / Math.max(satAfter, 1e-9)).toFixed(0)}% of the RESIDUAL, which is fine — judge the drain, not the split.)`,
        `      brightest sample ${brightest.nits.toExponential(3)} cd/m²  rgb [${brightest.rgb.map((v) => v.toExponential(2)).join(", ")}]`,
      ].join("\n"),
    );

    // ── 4. The centre pixel, in full ────────────────────────────────────────
    const p = await this.probe();
    if (p) {
      const before = p.units;
      const { out, s, rod } = scotopicMixCpu(before, p.nits);
      const spPixel = p.luma > 0 ? rod / p.luma : 0;
      console.log(
        [
          `[lum] CENTRE PIXEL  ${p.nits.toExponential(3)} cd/m²  (EV100 ${p.ev.toFixed(2)})`,
          `      linear rgb   [${before.map((v) => v.toExponential(3)).join(", ")}]`,
          `      photopic luma ${p.luma.toExponential(3)}   rod luma ${rod.toExponential(3)}   S/P ${spPixel.toFixed(3)}`,
          `      s = ${s.toFixed(4)}  ⇒  ${s > 0.99 ? "photopic — full colour, this stage is a no-op here" : s < 0.01 ? "SCOTOPIC — fully achromatic" : "mesopic — partial colour"}`,
          `      after retina [${out.map((v) => v.toExponential(3)).join(", ")}]`,
          `      🔑 S/P is the Purkinje shift for THIS pixel: >1 means the rods see it`,
          `         brighter than the cones do (blue/green), <1 dimmer (red).`,
        ].join("\n"),
      );
    }

    // ── 5. ⚠⚠ The contamination that will make this look broken ─────────────
    // 150 S10 in the galactic plane — the same figure `nightSide()` uses, so the
    // two gates cannot quote different Milky Ways.
    const skyPhysical = 1.25e-4;
    const skyBuffered = skyPhysical * SKY_ARTISTIC_GAIN;
    console.log(
      [
        "[lum] ⚠⚠ THE SKY AND STARS ARE LYING TO THIS STAGE, AND BY A KNOWN FACTOR.",
        `      SKY_ARTISTIC_GAIN = ${SKY_ARTISTIC_GAIN}, STAR_ARTISTIC_GAIN = ${STAR_ARTISTIC_GAIN}, both applied`,
        "      INSIDE the written radiance — so the two things Phase 7 exists to grey",
        "      out are the two things whose luminance is not physical:",
        `        Milky Way band   physical ${skyPhysical.toExponential(2)} cd/m² → s = ${rodConeBlend(skyPhysical).toFixed(4)}  (SCOTOPIC ✅)`,
        `                         buffered ${skyBuffered.toExponential(2)} cd/m² → s = ${rodConeBlend(skyBuffered).toFixed(4)}  (${rodConeBlend(skyBuffered) > 0.99 ? "PHOTOPIC ❌" : "mesopic ⚠"})`,
        `      That is ${(Math.log2(SKY_ARTISTIC_GAIN)).toFixed(0)} stops, and it is the difference between the Milky Way`,
        "      rendering GREY (right) and keeping its colour (wrong).",
        "      🔑 This is not a bug in this file — it is the plan's own Phase 7 line item",
        '      ("fix the skybox absolute luminance") arriving as a measurement. The gains',
        "      exist because a physically-dim sky was invisible; a scotopic model is what",
        "      makes a dim grey sky legible, so they can now be wound down. ⚠ Do it in ONE",
        "      commit with a re-measure — half-done it reads as a 10-stop brightness bug.",
      ].join("\n"),
    );

    // ── 6. Optional: re-derive the constant instead of trusting it ───────────
    if (opts?.derive) {
      const d = deriveScotopicWeights();
      const shipped = st.shippedWeights;
      const drift = Math.max(...d.weights.map((v, i) => Math.abs(v - shipped[i])));
      console.log(
        [
          `[lum] RE-DERIVED from photometry.ts's own CMFs + CIE 1951 V′(λ):`,
          `      [${d.weights.map((v) => v.toFixed(4)).join(", ")}]  over ${d.samples} in-gamut spectra, RMS ${d.rmsStops.toFixed(4)} stops`,
          `      shipped  [${shipped.map((v) => v.toFixed(4)).join(", ")}]   max drift ${drift.toFixed(4)}`,
          `      implied D65 S/P ${d.d65SpRatio.toFixed(4)}  vs published daylight 2.4–2.5`,
          `      hold-out (never fitted): Sol 5772 K S/P ${spectralSpRatio((nm) => planck(nm, 5772)).toFixed(3)} (published ≈2.3),`,
          `                               CIE A 2856 K S/P ${spectralSpRatio((nm) => planck(nm, 2856)).toFixed(3)} (published ≈1.4)`,
          drift < 0.04
            ? "      ✅ the shipped constant reproduces from first principles"
            : `      ❌ DRIFT ${drift.toFixed(4)} — the pasted constant no longer matches the derivation`,
        ].join("\n"),
      );
    }

    // ── 7. The RETURN VALUE: only what varies with the pose ─────────────────
    //
    // ⚠⚠ WHY THIS EXISTS. The first version of this gate printed everything and
    // returned void. The author sent back five scenarios' worth of `console.table`
    // output and **every table was byte-identical** — because the table is the
    // LADDER, a pure function of the constants, while the pose-dependent numbers
    // were in `console.log` prose that is impractical to copy. A gate whose
    // copy-pasteable output is constant across scenarios cannot validate anything.
    //
    // 🔑 So: print the interpretation, RETURN the measurement. What varies with the
    // pose is small enough to paste, and DevTools renders a returned object as one
    // expandable line. Applies to any gate meant for a human to relay.
    const summary: Record<string, unknown> = {
      enabled: st.enabled,
      purkinjeCctK: st.purkinjeCctK,
      pctPhotopic: pct(phot),
      pctMesopic: pct(meso),
      pctScotopic: pct(scot),
      chromaBefore: Number((satBefore / counted).toPrecision(3)),
      chromaAfter: Number((satAfter / counted).toPrecision(3)),
      chromaDesatOnly: Number((satGrey / counted).toPrecision(3)),
      tintAdds: Number(((satAfter - satGrey) / counted).toPrecision(3)),
      brightestNits: Number(brightest.nits.toPrecision(3)),
      adaptNits: Number(st.adaptNits.toPrecision(3)),
    };
    if (p) {
      const { s: sPix, rod } = scotopicMixCpu(p.units, p.nits);
      summary.centreNits = Number(p.nits.toPrecision(3));
      summary.centreEV100 = Number(p.ev.toFixed(2));
      summary.centreS = Number(sPix.toFixed(4));
      summary.centreSpRatio = Number((p.luma > 0 ? rod / p.luma : 0).toFixed(3));
    }

    // ── 8. Verdict ──────────────────────────────────────────────────────────
    const anyRod = scot + meso > 0;
    console.log(
      [
        anyRod
          ? `[lum] ✅ ${pct(scot + meso)}% of this frame is at or below the mesopic ceiling — the eye model has something to do here.`
          : "[lum] ⬜ this frame is entirely photopic. The stage is correctly doing nothing; point at a night side or deep space.",
        st.enabled
          ? "      A/B it with __lum.scotopic(false) — if nothing changes, the stage is not wired."
          : "      Turn it on with __lum.scotopic(true).",
        "      ⚠ BEFORE concluding 'it does nothing': AgX crushes everything below",
        "      display-linear 1.76e-4 to EXACTLY zero, and the sky-lit night floor sits",
        "      ~0.4 stops above it. Check against NeutralToneMapping first.",
      ].join("\n"),
    );
    return summary;
  }

  /**
   * What is actually lighting the HULL right now (P9e).
   *
   * 🔑 Answers "is that light coming from Jupiter or from Io?", which a frame
   * cannot: two emitters a few degrees apart light a hull almost identically, and
   * the one that is WRONG is the one that got silently skipped. This NAMES each
   * emitter, gives its irradiance and direction, and prints the skip.
   */
  hull(): void {
    const st = hullShineStatus();
    const occ = sunOcclusionStatus();
    if (st.lights.length === 0) {
      console.log(
        "[lum] no planetshine on the hull. Either nothing is in range, or the\n" +
          "      dominant-atmosphere skip removed the only emitter — check `skipped` below.",
      );
    } else {
      const rows: Record<string, Record<string, string | number>> = {};
      for (const l of st.lights) {
        rows[l.id] = {
          "distance (km)": Number(l.distKm.toPrecision(6)),
          "irradiance (lux)": Number(l.lux.toPrecision(4)),
          "hull L at ρ=0.3 (cd/m²)": Number(((0.3 * l.lux) / Math.PI).toPrecision(3)),
          "EV100 for middle grey": Number(
            Math.log2(
              1 / (1.2 * (0.18 / (((0.3 * l.lux) / Math.PI) / NITS_PER_GAME_UNIT))),
            ).toFixed(1),
          ),
          direction: l.dir.map((v) => Number(v.toFixed(3))).join(", "),
        };
      }
      console.table(rows);
    }
    console.log(
      [
        `[lum] planetshine skipped for: ${st.skippedId ?? "— (nothing)"}`,
        "      ⚠ A skip is CORRECT only while `AtmosphereSkyLight` is delivering that",
        "      body's ground-bounce, i.e. the ship is INSIDE its atmosphere on the day",
        "      side. Anywhere else it must read \"— (nothing)\".",
        "      🔑🔑 THE FIRST VERSION SKIPPED ON `lighting.active` ALONE, which is true",
        "      whenever any atmosphere body is in LOD RANGE — millions of km. That deleted",
        "      earthshine at Luna (17.4 lux → black) and left Io lighting the ship instead",
        "      of Jupiter. **A guard for \"someone else owns this\" must test whether that",
        "      owner is DELIVERING, not whether it exists.**",
        "",
        `      direct sun visibility ${occ.visibility.toPrecision(3)}  ·  D28 limb ${
          occ.limb
            ? occ.limb.illuminance
                .map((v) => Number(v.toPrecision(3)))
                .join("/") + " lux (RGB)"
            : "none"
        }`,
        "      ⇒ Cross-check the DIRECTION column against where the emitter actually is:",
        "      it is a unit vector from the ship toward that body, in world axes.",
      ].join("\n"),
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
    litPixels: number;
    litDiameterPx: number;
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
    // ── Lit footprint ─────────────────────────────────────────────────────
    // 🔑 WITHOUT THIS, A FLUX DEFICIT IS AMBIGUOUS. `sumLuma` alone cannot say whether
    // an object is too DIM or too SMALL — dividing by an assumed pixel count to get a
    // "mean radiance" silently assumes the answer. Counting pixels above a fraction of
    // the (background-subtracted) peak measures the footprint directly, and the
    // equivalent diameter `2√(N/π)` is then comparable to the geometry's prediction.
    const peakNet = Math.max(peak - bg, 0);
    const cut = bg + peakNet * 0.05;
    let lit = 0;
    for (let row = oHalf - half; row <= oHalf + half; row++) {
      for (let col = oHalf - half; col <= oHalf + half; col++) {
        if (lumas[row][col] > cut) lit++;
      }
    }
    return {
      sumLuma: raw - bg * n * n,
      peakLuma: peakNet,
      samples: n * n,
      backgroundPerPx: bg,
      sumLumaRaw: raw,
      litPixels: lit,
      /** Diameter of a disc with the same area as the lit region, in pixels. */
      litDiameterPx: 2 * Math.sqrt(lit / Math.PI),
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
    const cal = albedoCalibrationStatus().find((c) => c.bodyId === bodyId);
    const ratio = ref ? impliedP / ref.geometricAlbedo : NaN;
    console.log(
      `[lum] implied geometric albedo = ${impliedP.toFixed(4)}` +
        (ref ? `  vs measured ${ref.geometricAlbedo}` : "") +
        (Number.isFinite(ratio) ? `  → ${ratio.toFixed(3)}× (${(Math.log2(ratio) >= 0 ? "+" : "")}${Math.log2(ratio).toFixed(2)} stops)` : "") +
        (impliedP > 1 ? "   ⚠ IMPOSSIBLE (>1)" : "") +
        (cal ? `\n      D09 calibration: ${cal.state}, scale ×${cal.scale.toPrecision(4)}` : ""),
    );
    console.log(
      "[lum] 🔑 HOW TO READ THE RATIO NOW THAT D09 CALIBRATION IS LIVE. The sphere-mean\n" +
        "      of an albedo MAP is not identically the DISC-AVERAGED geometric albedo — the\n" +
        "      projection and the limb-darkening law sit between them — so a ratio off 1.0 is\n" +
        "      expected. What matters is whether it is the SAME ratio on every body:\n" +
        "        • same on all ⇒ ONE global constant, harmless (auto-exposure absorbs it).\n" +
        "        • different per body ⇒ that body's COMPOSITION is uncalibrated (Earth's night\n" +
        "          lights and glint, Mars' rim term), because the texture term is now handled.\n" +
        "      Run this on 3+ bodies and compare the ratios; a single body's number says little.",
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
    // ⚠⚠ TAKE THE LIVE **DISTANCE**, NOT THE LIVE ILLUMINANCE. This read
    // `rec.sunIlluminance.x`, which is wrong twice over, and both errors are
    // invisible in the printed number:
    //   1. `atmospherePass` sets that vector to `illum × getPreExposure() × tint`
    //      (D25 — it pre-exposes the atmosphere march). But `decodeRgb` divides
    //      pre-exposure OUT of the MEASURED side, so the gate was comparing a
    //      pre-exposed reference against an absolute measurement.
    //   2. `.x` is the RED channel of a per-channel star tint, not the illuminance.
    //
    // MEASURED consequence: Saturn read 0.040× (−4.66 stops) and Neptune 0.014×
    // (−6.12) — apparently catastrophic — while the RENDERER was correct to 0.86×
    // and 1.09× against hand-computed physics. 🔑 The tell was that only the AIRLESS
    // bodies (Mercury, Luna) came out right: they have no atmosphere record, so they
    // fell through to the clean authored-distance path. "Which bodies are wrong" was
    // the diagnosis, not "how wrong".
    //
    // The record's `starDistanceKm` is the field documented as "must be live", and
    // deriving illuminance from it keeps the orbital-motion intent with none of the
    // render-side factors attached.
    const dist =
      starDistanceKm ?? rec?.starDistanceKm ?? authoredStarDistanceKm(bodyId);
    const illum =
      dist != null ? sunIlluminanceAt(dist, STAR_LUMINOSITY_SUN) : NaN;
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

/**
 * Where the shadow AXIS hits `body`, in the body's own geographic coordinates.
 *
 * The axis is the ray from the star's centre through the occluder's centre; the
 * landing point is its near intersection with the body's sphere. Converting that
 * to lat/lon needs the body's ORIENTATION, which is exactly why this is the
 * gate — `centre visibility` and the occluder columns are computed without any
 * rotation at all and stay correct even when the rendered shadow is painted on
 * the wrong side of the planet.
 *
 * Returns `—` when nothing eclipses the body, or when the axis misses it (a
 * partial eclipse: the penumbra touches but the umbral axis passes by).
 */
function shadowLandingPoint(
  body: { id: string; centerKm: Vector3; radiusKm: number },
  star: readonly [number, number, number],
  jd: number,
): Record<string, string | number> {
  const none = { "umbra lat (°)": "—", "umbra lon (°)": "—" };
  const def = allBodyDefs().find((b) => b.id === body.id);
  if (!def?.rotation) return none;

  // Whichever occluder's shadow axis passes closest to the body's centre.
  let hit: [number, number, number] | null = null;
  let bestMiss = Infinity;
  for (const occ of sunOccluderList()) {
    if (occ.id === body.id) continue;
    const ax = occ.centerKm.x - star[0];
    const ay = occ.centerKm.y - star[1];
    const az = occ.centerKm.z - star[2];
    const al = Math.hypot(ax, ay, az) || 1;
    const dx = ax / al, dy = ay / al, dz = az / al;
    const rx = body.centerKm.x - occ.centerKm.x;
    const ry = body.centerKm.y - occ.centerKm.y;
    const rz = body.centerKm.z - occ.centerKm.z;
    const t = rx * dx + ry * dy + rz * dz;
    if (t <= 0) continue; // the body is on the star's side of this occluder
    const miss = Math.hypot(rx - t * dx, ry - t * dy, rz - t * dz);
    if (miss >= bestMiss) continue;
    bestMiss = miss;
    const h2 = body.radiusKm * body.radiusKm - miss * miss;
    hit =
      h2 < 0
        ? null
        : [
            occ.centerKm.x + dx * (t - Math.sqrt(h2)) - body.centerKm.x,
            occ.centerKm.y + dy * (t - Math.sqrt(h2)) - body.centerKm.y,
            occ.centerKm.z + dz * (t - Math.sqrt(h2)) - body.centerKm.z,
          ];
  }
  if (!hit) return none;

  const o = bodyOrientation(def, jd, _orientGate);
  const l = Math.hypot(hit[0], hit[1], hit[2]) || 1;
  const ux = hit[0] / l, uy = hit[1] / l, uz = hit[2] / l;
  const zx = o.meridian[1] * o.pole[2] - o.meridian[2] * o.pole[1];
  const zy = o.meridian[2] * o.pole[0] - o.meridian[0] * o.pole[2];
  const zz = o.meridian[0] * o.pole[1] - o.meridian[1] * o.pole[0];
  const gx = ux * o.meridian[0] + uy * o.meridian[1] + uz * o.meridian[2];
  const gy = ux * o.pole[0] + uy * o.pole[1] + uz * o.pole[2];
  const gz = ux * zx + uy * zy + uz * zz;
  return {
    "umbra lat (°)": Number((Math.asin(Math.max(-1, Math.min(1, gy))) * 180 / Math.PI).toFixed(2)),
    "umbra lon (°)": Number((Math.atan2(-gz, gx) * 180 / Math.PI).toFixed(2)),
  };
}

const _orientGate = createBodyOrientation();
const _shineProbeU = createShineUniforms();

