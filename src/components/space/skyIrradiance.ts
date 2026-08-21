/**
 * SKY IRRADIANCE — SH-L2 diffuse lighting from the real sky (S4, closes D29).
 *
 * The skybox and the 8,920-star catalogue were photometrically calibrated but were
 * not LIGHT SOURCES: an atmosphere-less umbra rendered pure black, because the only
 * things lighting the hull were the sun's key light and a bounce fill derived from
 * it, and both vanish in shadow. This module turns the sky into a light.
 *
 * ── WHY SH-L2, WHICH IS ALSO WHAT THE ENGINES DO ─────────────────────────────
 * Second-order spherical harmonics are the standard representation for distant
 * DIFFUSE irradiance — Unity's ambient probe, Unreal's SkyLight lower band,
 * Frostbite's distant diffuse. Ramamoorthi & Hanrahan (2001) is the reason: the
 * cosine lobe is so smooth that 9 coefficients capture ~99% of the diffuse response
 * to *any* environment. 27 floats, no texture, no per-frame cost.
 *
 * 🔑 AND IT IS THE RIGHT CHOICE HERE FOR A SECOND, SHARPER REASON. The obvious
 * alternative is to capture the sky into a cubemap and prefilter it (three's
 * `PMREMGenerator` would do it). But **the catalogue's stars are delta functions** —
 * the very fact that made a panorama unable to carry them (plan §1: flux is only
 * correct at exactly one viewing FOV). Rasterising them into a cubemap would spread
 * each star over whatever texel it happened to land in. SH has no such problem: a
 * point source of illuminance E from direction d contributes **exactly** `E·Y_i(d)`,
 * analytically, at any resolution. So the half of the sky's flux that lives in the
 * catalogue is integrated exactly, and the diffuse half is integrated by projection.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────────
 * ⚠ NO SPECULAR. SH-L2 cannot carry a mirror reflection; star reflections on a
 * glossy hull need a prefiltered GGX cubemap (the split-sum half of the engines'
 * scheme). That is S4b, and half-doing it here would be worse than not doing it.
 *
 * ⚠ NO OCCLUSION. This is ONE global probe for a sky at infinity, so inside Luna's
 * umbra the hull receives the whole sky even though Luna blocks half of it. Real
 * engines answer this with probe grids or capsule/AO occlusion. The cheap fix
 * available here is the disc-overlap machinery already written for D27
 * (`sunOcclusion.ts`), which could supply a scalar occlusion factor per body — worth
 * doing when a body large enough to matter is ever close enough to matter.
 *
 * ── CONVENTION (three's, verified against its source, not assumed) ───────────
 * `THREE.SphericalHarmonics3.coefficients[i]` are RADIANCE projections
 * `∫ L(ω)·Y_i(ω) dω`, with `Y_i` as in `SphericalHarmonics3.getBasisAt`. The
 * cosine-lobe convolution constants Â_l are applied by the EVALUATION
 * (`getShIrradianceAt`, band 0 factor `0.886227 = π·0.282095`), so feeding true
 * radiance and leaving `LightProbe.intensity` at 1 yields true irradiance.
 *
 * Two consequences are exactly analytic, and `__lum.skyProbe()` gates on both:
 *   • a uniform sky of radiance L gives irradiance **exactly πL** on every normal;
 *   • a single source of illuminance E gives **1.0625·E** at the source direction,
 *     since `[Â₀ + 3Â₁ + 5Â₂]/4π = 4.25π/4π`. That 6.25% overshoot is SH-L2
 *     ringing — a known property of the truncation, so it is asserted rather than
 *     discovered.
 */

import * as THREE from "three";
import {
  Fn,
  Loop,
  float,
  normalize,
  texture as tslTexture,
  uv,
  vec3,
  vec4,
} from "three/tsl";
import { NodeMaterial, QuadMesh, RenderTarget } from "three/webgpu";
import { panoramaUvFromGameDir } from "@/components/Skybox/skyPanoramaMapping";

/**
 * Resolution of the lat-long grid the panorama is integrated on.
 *
 * SH-L2 is a 9-term low-pass — its highest basis function varies as cos2θ — so the
 * integration grid only has to resolve that, not the texture. 64×32 gives 2,048
 * samples over the sphere, which is ~100× oversampled for band 2. Going higher buys
 * nothing measurable and costs readback latency.
 */
const GRID_W = 64;
const GRID_H = 32;

/**
 * Stratified taps per axis inside each grid cell, so the bake integrates an AREA
 * rather than point-sampling a texel. See the shader for the measured justification.
 */
const SUPERSAMPLE = 4;

/** 9 RGB coefficients — the shape `THREE.SphericalHarmonics3` uses. */
export type ShCoefficients = THREE.Vector3[];

const makeSh = (): ShCoefficients =>
  Array.from({ length: 9 }, () => new THREE.Vector3());

let _panoramaSh: ShCoefficients | null = null;
let _catalogueSh: ShCoefficients | null = null;
const _combined = makeSh();
let _combinedDirty = true;
let _panoramaMeanRadiance = 0;
let _bakeInFlight = false;
/** Bumped whenever either half changes, so consumers can skip redundant copies. */
let _version = 0;

/**
 * Real SH basis at a direction, three's ordering and normalisation.
 *
 * ⚠ Deliberately a transcription of `SphericalHarmonics3.getBasisAt` rather than a
 * re-derivation. Re-deriving would risk a Condon–Shortley sign or a normalisation
 * that differs from the evaluator's — a mismatch that would look like a lighting
 * bug and be almost impossible to localise from a picture.
 */
function shBasis(x: number, y: number, z: number, out: number[]): void {
  out[0] = 0.282095;
  out[1] = 0.488603 * y;
  out[2] = 0.488603 * z;
  out[3] = 0.488603 * x;
  out[4] = 1.092548 * x * y;
  out[5] = 1.092548 * y * z;
  out[6] = 0.315392 * (3 * z * z - 1);
  out[7] = 1.092548 * x * z;
  out[8] = 0.546274 * (x * x - y * y);
}

const _basis = new Array<number>(9).fill(0);

/**
 * Accumulate ONE point source into a coefficient set: `coeff_i += E·rgb·Y_i(d)`.
 *
 * Exact for a delta source at any resolution — see the header. `illumGame` is the
 * star's total illuminance in game units and `r,g,b` its luminance-normalised hue,
 * exactly the pair `StarField` already stores per instance, so the probe's colour
 * comes out right for free.
 */
export function accumulatePointSource(
  sh: ShCoefficients,
  dirX: number,
  dirY: number,
  dirZ: number,
  illumGame: number,
  r: number,
  g: number,
  b: number,
): void {
  shBasis(dirX, dirY, dirZ, _basis);
  for (let i = 0; i < 9; i++) {
    const w = _basis[i] * illumGame;
    sh[i].x += w * r;
    sh[i].y += w * g;
    sh[i].z += w * b;
  }
}

/**
 * Publish the catalogue's contribution. Called by `StarField` after it parses the
 * blob — the same pass that builds the instance buffer, so this costs one extra
 * multiply-add per star and no extra iteration.
 *
 * Recomputed on an interstellar jump for free, because a jump re-derives every
 * star's DIRECTION from its stored 3D position (plan §3.1) and therefore re-parses.
 */
export function setCatalogueSh(sh: ShCoefficients | null): void {
  _catalogueSh = sh;
  _combinedDirty = true;
  _version++;
}

/** Increments on every re-bake. Lets `SkyLight` copy 9 vectors only when needed. */
export const getSkyShVersion = (): number => _version;

/** Mean panorama radiance in game units, for the gate's πL check. */
export const getPanoramaMeanRadiance = (): number => _panoramaMeanRadiance;

/**
 * Combined sky radiance SH, game units. `null` until at least one half has landed.
 * The returned array is REUSED — copy it if you need to keep it.
 */
export function getSkySh(): ShCoefficients | null {
  if (!_panoramaSh && !_catalogueSh) return null;
  if (_combinedDirty) {
    for (let i = 0; i < 9; i++) {
      const c = _combined[i].set(0, 0, 0);
      if (_panoramaSh) c.add(_panoramaSh[i]);
      if (_catalogueSh) c.add(_catalogueSh[i]);
    }
    _combinedDirty = false;
  }
  return _combined;
}

export function skyIrradianceStatus(): {
  panoramaBaked: boolean;
  catalogueBaked: boolean;
  bakeInFlight: boolean;
  grid: string;
  panoramaMeanRadianceGame: number;
} {
  return {
    panoramaBaked: _panoramaSh !== null,
    catalogueBaked: _catalogueSh !== null,
    bakeInFlight: _bakeInFlight,
    grid: `${GRID_W}×${GRID_H}`,
    panoramaMeanRadianceGame: _panoramaMeanRadiance,
  };
}

/** Test hook: overwrite the panorama half with a synthetic sky. Used by the gate. */
export function setPanoramaShForTest(sh: ShCoefficients | null): void {
  _panoramaSh = sh;
  _combinedDirty = true;
  _version++;
}

let _quad: QuadMesh | null = null;
let _rt: RenderTarget | null = null;

/**
 * Project the panorama into SH-L2 by rendering it once and reading it back.
 *
 * ── WHY A RUNTIME BAKE AND NOT A CONSTANT IN THE SOURCE ─────────────────────
 * The 27 numbers could have been computed offline in `build_diffuse_sky.sh` and
 * pasted in, which would be exact and free. Rejected because this codebase has
 * already been burned twice by a derived constant drifting from the asset it
 * describes — `SKY_TEXTURE_MEAN_LINEAR` after the panorama was replaced, and the
 * orientation itself (D32). A bake that reads the shipped texture through the
 * shipped mapping cannot go stale, and it works unchanged for a procedurally
 * generated sky, which the north-star goals require.
 *
 * Each texel of the target is a KNOWN game-frame direction on a lat-long grid, so
 * the CPU side needs no inverse mapping — it reconstructs the direction from the
 * texel index and weights by that row's solid angle.
 *
 * ⚠ The radiance sampled here is PHYSICAL: `SKY_RADIANCE_SCALE` is applied (it is
 * the calibration) but `SKY_ARTISTIC_GAIN` and `uPreExposure` are NOT, because both
 * are per-frame display terms and belong on `LightProbe.intensity`. Baking a look
 * knob into the coefficients would make the probe un-gateable, the same mistake the
 * star gate exists to prevent.
 */
export async function bakePanoramaSh(
  renderer: {
    setRenderTarget: (rt: RenderTarget | null) => void;
    readRenderTargetPixelsAsync: (
      rt: RenderTarget,
      x: number,
      y: number,
      w: number,
      h: number,
    ) => Promise<ArrayBufferLike>;
  },
  panorama: THREE.Texture,
  radianceScale: number,
): Promise<boolean> {
  if (_bakeInFlight) return false;
  _bakeInFlight = true;
  try {
    if (!_rt) {
      _rt = new RenderTarget(GRID_W, GRID_H, {
        type: THREE.HalfFloatType,
        depthBuffer: false,
        colorSpace: THREE.NoColorSpace,
      });
    }
    if (!_quad) _quad = new QuadMesh(new NodeMaterial());

    const mat = _quad.material as NodeMaterial;
    mat.fragmentNode = Fn(() => {
      // uv() is the target's [0,1]² — turn it into the same lat-long direction the
      // CPU reconstructs below. θ from +Y (the ecliptic pole), φ about it.
      // ── Stratified supersampling within each cell ─────────────────────────
      // One tap per cell point-samples 2,048 texels out of 33.5M. MEASURED offline
      // against the full-resolution solid-angle-weighted mean: 1 tap lands at
      // 0.9937×, 4×4 at 0.9990×, 8×8 at 1.0005×. So a single tap carries −0.63% of
      // pure sampling error — small, but it is error the bake INVENTS, and removing
      // it means the gate's residual is attributable to the asset alone (UASTC block
      // compression, ~+2.7%, which `build_diffuse_sky.sh` warns about because
      // SKY_TEXTURE_MEAN_LINEAR is measured on the PNG).
      //
      // 🔑 Same fix, same reason, as D31's stratified tile averaging in the exposure
      // meter: a mean over a high-variance field needs samples, not one probe.
      // 4×4 is the knee — 16× the taps for 6× less error, and 8×8 buys ~nothing.
      const sum = vec3(0).toVar();
      Loop(SUPERSAMPLE, ({ i }: { i: unknown }) => {
        Loop(SUPERSAMPLE, ({ i: j }: { i: unknown }) => {
          const su = float(i as never)
            .add(0.5)
            .div(float(SUPERSAMPLE));
          const sv = float(j as never)
            .add(0.5)
            .div(float(SUPERSAMPLE));
          const theta = uv()
            .y.add(sv.sub(0.5).mul(float(1 / GRID_H)))
            .mul(float(Math.PI));
          const phi = uv()
            .x.add(su.sub(0.5).mul(float(1 / GRID_W)))
            .mul(float(2 * Math.PI));
          const d = normalize(
            vec3(
              theta.sin().mul(phi.cos()),
              theta.cos(),
              theta.sin().mul(phi.sin()),
            ),
          );
          sum.addAssign(tslTexture(panorama, panoramaUvFromGameDir(d)).rgb);
        });
      });
      // ⚠⚠ RENDER THE RAW TEXEL, NOT THE CALIBRATED RADIANCE. The first version
      // multiplied by `radianceScale` here and lost 5.85× of the sky: the target is
      // RGBA16F, whose smallest subnormal is 2⁻²⁴ = 5.96e-8, and the calibrated sky
      // is ~1.3e-8 game units. Most of the sphere underflowed to ZERO and only the
      // bright band survived, so the baked mean read 2.28e-9 against a 1.33e-8
      // target. This is defect D25 all over again, inside the bake that was written
      // with a comment warning about that exact floor.
      //
      // 🔑 The fix is not a bigger buffer, it is to keep the numbers O(1) where the
      // precision lives: the texel is in [0,1], and `radianceScale` is applied on
      // the CPU in float64 during the projection. Same trick as source
      // pre-exposure, minus the need for any exposure.
      return vec4(sum.div(float(SUPERSAMPLE * SUPERSAMPLE)), 1);
    })();
    mat.needsUpdate = true;

    renderer.setRenderTarget(_rt);
    _quad.render(renderer as never);
    renderer.setRenderTarget(null);

    const buf = await renderer.readRenderTargetPixelsAsync(
      _rt,
      0,
      0,
      GRID_W,
      GRID_H,
    );
    const isHalf = buf instanceof Uint16Array;
    const data = buf as unknown as ArrayLike<number>;

    const sh = makeSh();
    // Solid angle of one texel at row j: sinθ · Δθ · Δφ. Including sinθ is what
    // stops the poles — where texels are geometrically tiny — from being counted as
    // if they covered as much sky as the equator.
    const dTheta = Math.PI / GRID_H;
    const dPhi = (2 * Math.PI) / GRID_W;
    let fluxSum = 0;
    let solidAngleSum = 0;
    for (let j = 0; j < GRID_H; j++) {
      const theta = ((j + 0.5) / GRID_H) * Math.PI;
      const sinT = Math.sin(theta);
      const cosT = Math.cos(theta);
      const dOmega = sinT * dTheta * dPhi;
      for (let i = 0; i < GRID_W; i++) {
        const phi = ((i + 0.5) / GRID_W) * 2 * Math.PI;
        const o = (j * GRID_W + i) * 4;
        // × radianceScale HERE, in float64, for the reason in the shader above.
        const r =
          (isHalf ? fromHalf(data[o]) : (data[o] as number)) * radianceScale;
        const g =
          (isHalf ? fromHalf(data[o + 1]) : (data[o + 1] as number)) *
          radianceScale;
        const b =
          (isHalf ? fromHalf(data[o + 2]) : (data[o + 2] as number)) *
          radianceScale;
        const dirX = sinT * Math.cos(phi);
        const dirY = cosT;
        const dirZ = sinT * Math.sin(phi);
        shBasis(dirX, dirY, dirZ, _basis);
        for (let k = 0; k < 9; k++) {
          const w = _basis[k] * dOmega;
          sh[k].x += w * r;
          sh[k].y += w * g;
          sh[k].z += w * b;
        }
        fluxSum += (0.2126 * r + 0.7152 * g + 0.0722 * b) * dOmega;
        solidAngleSum += dOmega;
      }
    }
    _panoramaMeanRadiance = solidAngleSum > 0 ? fluxSum / solidAngleSum : 0;
    _panoramaSh = sh;
    _combinedDirty = true;
    _version++;
    return true;
  } finally {
    _bakeInFlight = false;
  }
}

/**
 * Decode an IEEE-754 half. The render target is RGBA16F, and a readback hands back
 * raw `Uint16` — the same decode `lumHarness` does for its probes.
 */
function fromHalf(h: number): number {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  const sign = s ? -1 : 1;
  if (e === 0) return sign * 2 ** -24 * f;
  if (e === 0x1f) return f ? NaN : sign * Infinity;
  return sign * 2 ** (e - 15) * (1 + f / 1024);
}

/**
 * Irradiance the probe will deliver at a normal, evaluated on the CPU with three's
 * own constants. Used by the gate so it compares against the SHIPPING evaluator
 * rather than a second implementation of it.
 */
export function evaluateShIrradiance(
  sh: ShCoefficients,
  nx: number,
  ny: number,
  nz: number,
): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  const add = (c: THREE.Vector3, w: number) => {
    out[0] += c.x * w;
    out[1] += c.y * w;
    out[2] += c.z * w;
  };
  add(sh[0], 0.886227);
  add(sh[1], 2.0 * 0.511664 * ny);
  add(sh[2], 2.0 * 0.511664 * nz);
  add(sh[3], 2.0 * 0.511664 * nx);
  add(sh[4], 2.0 * 0.429043 * nx * ny);
  add(sh[5], 2.0 * 0.429043 * ny * nz);
  add(sh[6], 0.743125 * nz * nz - 0.247708);
  add(sh[7], 2.0 * 0.429043 * nx * nz);
  add(sh[8], 0.429043 * (nx * nx - ny * ny));
  return out;
}
