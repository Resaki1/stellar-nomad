import * as THREE from "three";
import { NodeMaterial, RenderTarget } from "three/webgpu";
import type { WebGPURenderer } from "three/webgpu";
import {
  Fn,
  If,
  Loop,
  uniform,
  texture,
  screenUV,
  vec2,
  vec3,
  vec4,
  float,
  dot,
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
  select,
  int,
  smoothstep,
} from "three/tsl";
import { SCALED_UNITS_PER_KM } from "@/sim/units";
import type { AtmosphereParams } from "../celestial/types";

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

// Step / sample counts.
const TRANSMITTANCE_STEPS = 40;
const MS_SQRT_SAMPLES = 8; // → 64 sphere directions
const MS_SAMPLE_COUNT = MS_SQRT_SAMPLES * MS_SQRT_SAMPLES;
const MS_STEPS = 20;
const MAIN_STEPS = 32; // per-pixel screen march (fixed; jitter/adaptive is Phase 4)
const SAMPLE_SEGMENT_T = 0.3; // reference midpoint bias for the screen march

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
  | "lutMS"; // blit the multiple-scattering LUT
const DEBUG_ATMOSPHERE: AtmoDebug = "off";

// =============================================================================
// Atmosphere-body registry. Each CelestialBody with config.atmosphere pushes its
// scaled center + sun direction + distance here each frame (while its sphere LOD
// is visible). The pass picks the nearest active body. Mirrors the cloud
// pipeline's global-singleton handoff (getActiveCloudPipeline).
// =============================================================================

export type AtmosphereBodyRecord = {
  id: string;
  /** Planet centre in scaled-world units (origin-relative — same frame as the scaled camera). */
  centerScaled: THREE.Vector3;
  /** Normalised direction from the planet centre toward the sun (scaled-world axes). */
  sunDir: THREE.Vector3;
  /** Camera→centre distance in km (dominance + gating). */
  distanceKm: number;
  params: AtmosphereParams;
};

const atmosphereBodies = new Map<string, AtmosphereBodyRecord>();

/** Register/update a body's atmosphere for this frame. Vectors are copied. */
export function setAtmosphereBody(
  id: string,
  centerScaled: THREE.Vector3,
  sunDir: THREE.Vector3,
  distanceKm: number,
  params: AtmosphereParams,
): void {
  let rec = atmosphereBodies.get(id);
  if (!rec) {
    rec = {
      id,
      centerScaled: new THREE.Vector3(),
      sunDir: new THREE.Vector3(),
      distanceKm: 0,
      params,
    };
    atmosphereBodies.set(id, rec);
  }
  rec.centerScaled.copy(centerScaled);
  rec.sunDir.copy(sunDir).normalize();
  rec.distanceKm = distanceKm;
  rec.params = params;
}

export function clearAtmosphereBody(id: string): void {
  atmosphereBodies.delete(id);
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

// Extinction (km^-1, per-RGB) at planet-centred radius rKm — JS twin of the
// shader's sampleMedium().extinction (Rayleigh scattering + Mie extinction +
// ozone absorption). Coefficients in `params` are m^-1 → ×1000.
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
  const mieExt = (p.mieScattering + p.mieAbsorption) * 1000 * dM;
  out.set(
    p.rayleighScattering[0] * 1000 * dR + mieExt + p.ozoneAbsorption[0] * 1000 * dO,
    p.rayleighScattering[1] * 1000 * dR + mieExt + p.ozoneAbsorption[1] * 1000 * dO,
    p.rayleighScattering[2] * 1000 * dR + mieExt + p.ozoneAbsorption[2] * 1000 * dO,
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

  // ── Sky ambient (cheap analytic; LUT irradiance is Phase 4) ──
  // Fades with air density at the camera (≈0 in space) and with sun elevation
  // (a wider twilight band than the sun term, so the fill lingers after sunset).
  const densityAtCam = Math.exp(-Math.max(0, r - Rg) / params.rayleighScaleHeightKm);
  const dayFactor = smoothstepScalar(
    cosHorizon - SKY_DAY_BAND_LO,
    cosHorizon + SKY_DAY_BAND_HI,
    cosSunUp,
  );
  _lighting.skyIntensity = SKY_AMBIENT_MAX_INTENSITY * densityAtCam * dayFactor;

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

  _lighting.active = true;
}

// =============================================================================
// The pass
// =============================================================================

export type AtmospherePass = {
  // Main on-screen pass (rt → rtB).
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
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
  dispose: () => void;
};

/**
 * Build the atmosphere pass. `inputTexture` is the scaled-scene colour RT
 * (rt.texture, the background). The two LUT RTs are owned by SpaceRenderer and
 * passed in; this module binds them (read in the MS bake + main pass) and writes
 * them in bakeLUTs. Textures are bound at build time (stable RTs) per the
 * WebGPU bind-group-cache caveat; rebuild on resize (input RT change).
 */
export function setupAtmospherePass(
  inputTexture: THREE.Texture,
  transmittanceLUT: RenderTarget,
  multiScatterLUT: RenderTarget,
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
  const uMieG = uniform(0.8);
  const uOzoneAbsorption = uniform(new THREE.Vector3());
  const uOzoneCenterKm = uniform(25);
  const uOzoneHalfWidthKm = uniform(15);
  const uGroundAlbedo = uniform(new THREE.Vector3(0.3, 0.3, 0.3));
  const uSunIlluminance = uniform(new THREE.Vector3(1, 1, 1));
  // Dynamic (per-frame).
  const uCameraMatrixWorld = uniform(new THREE.Matrix4());
  const uTanHalfFov = uniform(1);
  const uAspect = uniform(1);
  const uCameraPlanetKm = uniform(new THREE.Vector3()); // camera in planet-centred km
  const uSunDir = uniform(new THREE.Vector3(0, 0, 1)); // normalised, planet frame
  const uActive = uniform(0); // 0 = passthrough, 1 = march

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
    const extinction = scatteringRay.add(extinctionMie).add(uOzoneAbsorption.mul(dO));
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

  // Transmittance LUT: params → uv (Bruneton). r clamped to [Rground, Rtop].
  const transmittanceParamsToUv = (r: Node, mu: Node) => {
    const rho = sqrt(max(0, r.mul(r).sub(uBottomRadius.mul(uBottomRadius))));
    const disc = r.mul(r).mul(mu.mul(mu).sub(1)).add(uTopRadius.mul(uTopRadius));
    const d = max(0, r.mul(mu).negate().add(sqrt(max(0, disc))));
    const dMin = uTopRadius.sub(r);
    const dMax = rho.add(uH);
    const xMu = d.sub(dMin).div(dMax.sub(dMin).max(1e-6));
    const xR = rho.div(uH.max(1e-6));
    return vec2(xMu, xR);
  };

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
    const psi = inScattered.div(vec3(1).sub(Fms).max(1e-4));
    return vec4(psi, 1);
  });

  // ── Main on-screen fragment ────────────────────────────────────────────────
  const mainFragment = Fn(() => {
    const sceneColor = texture(inputTexture, screenUV).rgb;
    const out = vec4(sceneColor, 1).toVar();

    // Geometry-free debug (compile-time):
    if (DEBUG_ATMOSPHERE === "lutT")
      return vec4(texture(transmittanceLUT.texture, screenUV).rgb, 1);
    if (DEBUG_ATMOSPHERE === "lutMS")
      return vec4(texture(multiScatterLUT.texture, screenUV).rgb, 1);

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
          select(atmo.tFar.greaterThan(0), vec4(0, 0, 1, 1), vec4(0.3, 0, 0, 1)),
        );
        return;
      }
      if (DEBUG_ATMOSPHERE === "extinction") {
        const Ptest = select(
          groundHit,
          ro.add(rd.mul(tGround)),
          ro.add(rd.mul(atmo.tNear.max(0))),
        );
        out.assign(vec4(sampleMedium(Ptest).extinction.mul(30), 1));
        return;
      }
      if (DEBUG_ATMOSPHERE === "sunT") {
        const Ptest = select(
          groundHit,
          ro.add(rd.mul(tGround)),
          ro.add(rd.mul(atmo.tNear.max(0))),
        );
        out.assign(vec4(getSunTransmittance(Ptest, uSunDir), 1));
        return;
      }

      If(atmo.tFar.greaterThan(0), () => {
        // tStart = atmosphere entry (0 if camera already inside); push off the
        // shell when entering from outside.
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

          const L = vec3(0).toVar();
          const throughput = vec3(1).toVar();
          const t = float(0).toVar();

          Loop(MAIN_STEPS, ({ i: s }: { i: Node }) => {
            const tNew = tMax.mul(float(s).add(SAMPLE_SEGMENT_T).div(MAIN_STEPS));
            // .toVar() MATERIALISES dt = tNew - t_old HERE, before t is
            // reassigned below. Without it, `dt` is a live node referencing the
            // variable `t`; since `t.assign(tNew)` runs before dt is consumed,
            // dt would evaluate to tNew - tNew = 0 → sampleT=1 → Sint=0 → the
            // entire in-scatter integral collapses to zero (the invisible-
            // atmosphere bug).
            const dt = tNew.sub(t).toVar();
            t.assign(tNew);
            const P = ro.add(rd.mul(tStart.add(t)));
            const m = sampleMedium(P);
            const sampleT = expVec3(m.extinction.mul(dt).negate());

            const Tsun = getSunTransmittance(P, uSunDir);
            // Nudge off the surface (local normal) to avoid self-intersection
            // false-shadowing near the terminator.
            const earthShadow = select(
              raySphereNearest(
                P.add(normalize(P).mul(SURFACE_OFFSET_KM)),
                uSunDir,
                uBottomRadius,
              ).greaterThan(0),
              float(0),
              float(1),
            );
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
              .mul(sunVis);
            const S = uSunIlluminance.mul(
              earthShadow.mul(Tsun).mul(phaseScat).add(msContrib),
            );
            const Sint = S.sub(S.mul(sampleT)).div(m.extinction.max(1e-6));
            L.addAssign(throughput.mul(Sint));
            throughput.mulAssign(sampleT);
          });

          if (DEBUG_ATMOSPHERE === "inscatter") out.assign(vec4(L, 1));
          else out.assign(vec4(sceneColor.mul(throughput).add(L), 1));
        });
      });
    });

    return out;
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
  const main = makeScene(mainFragment);

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
    uMieScattering.value.setScalar(p.mieScattering * 1000);
    uMieExtinction.value.setScalar((p.mieScattering + p.mieAbsorption) * 1000);
    uMieExpScale.value = -1 / p.mieScaleHeightKm;
    uMieG.value = p.mieG;
    uOzoneAbsorption.value.set(
      p.ozoneAbsorption[0] * 1000,
      p.ozoneAbsorption[1] * 1000,
      p.ozoneAbsorption[2] * 1000,
    );
    uOzoneCenterKm.value = p.ozoneCenterKm;
    uOzoneHalfWidthKm.value = p.ozoneWidthKm * 0.5;
    uGroundAlbedo.value.set(p.groundAlbedo[0], p.groundAlbedo[1], p.groundAlbedo[2]);
    uSunIlluminance.value.set(p.sunIlluminance[0], p.sunIlluminance[1], p.sunIlluminance[2]);
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
    uActive.value = 1;
    uCameraMatrixWorld.value.copy(scaledCamera.matrixWorld);
    uTanHalfFov.value = Math.tan((scaledCamera.fov * Math.PI) / 180 / 2);
    uAspect.value = scaledCamera.aspect;
    // Camera relative to planet centre, scaled→km (÷ SCALED_UNITS_PER_KM).
    _camToPlanet
      .copy(scaledCamera.position)
      .sub(dominant.centerScaled)
      .multiplyScalar(1 / SCALED_UNITS_PER_KM);
    uCameraPlanetKm.value.copy(_camToPlanet);
    uSunDir.value.copy(dominant.sunDir);
  };

  const bakeLUTs = (renderer: WebGPURenderer) => {
    renderer.setRenderTarget(transmittanceLUT);
    renderer.render(transmittanceBake.scene, bakeCamera);
    renderer.setRenderTarget(multiScatterLUT); // reads the transmittance LUT just written
    renderer.render(multiScatterBake.scene, bakeCamera);
    renderer.setRenderTarget(null);
  };

  const dispose = () => {
    quad.dispose();
    transmittanceBake.mat.dispose();
    multiScatterBake.mat.dispose();
    main.mat.dispose();
  };

  return {
    scene: main.scene,
    camera,
    transmittanceBakeScene: transmittanceBake.scene,
    multiScatterBakeScene: multiScatterBake.scene,
    bakeCamera,
    setAtmosphere,
    updateUniforms,
    bakeLUTs,
    dispose,
  };
}
