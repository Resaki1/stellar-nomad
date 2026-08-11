import * as THREE from "three";
import { NodeMaterial, RenderTarget } from "three/webgpu";
import type { WebGPURenderer } from "three/webgpu";
import {
  Fn,
  If,
  Loop,
  screenUV,
  texture,
  texture3D,
  uniform,
  vec2,
  vec3,
  vec4,
  float,
  int,
  dot,
  length,
  exp,
  sqrt,
  clamp,
  atan,
  acos,
  fract,
  min,
  max,
  select,
  mix,
  smoothstep,
  PI,
} from "three/tsl";
import { kmToScaledUnits } from "@/sim/units";
import {
  cloudHeightProfile,
  deriveCloudType,
  deriveTopAlt,
  WEATHER_V2,
  MESO_SCALE,
  fractionPlacement,
  deriveColumnV2,
  convectiveCoverage,
  anvilProfileConv,
} from "@/components/celestial/bodies/cloudShared";
import {
  detileBlend,
  USE_DETILE,
  baseDilate,
} from "@/components/celestial/bodies/cloudDetile";
import { WARP_AMPLITUDE_MIRROR } from "./cloudLightVolume";
import { PASS } from "./perf/perfProfiler";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

// =============================================================================
// Cloud Beer Shadow Map (BSM) — L0 of docs/CLOUD_SHADOWS_GODRAYS_PLAN.md.
//
// A sun-orthographic 2D transmittance map: one texel = one sun-parallel ray
// through the cloud slab. Baked each frame by a fullscreen FRAGMENT pass into a
// process-lifetime RGBA16F RenderTarget (the getAtmosphereLUTs() singleton
// pattern — NOT a storage texture; RT+fragment has no storage-format constraints
// and gives free readback for the ship shadow in L3).
//
// Channels (per sun-parallel ray, over the SUNWARD cloud crossing):
//   R = d_front   sun-depth of the first cloud hit          (scaled units)
//   G = sigma_mean mean extinction over [d_front, d_back]   (extinction/unit)
//   B = tau_max   total optical depth of the crossing       (dimensionless)
//   A = hit       1 if any cloud was crossed, else 0        (debug / gate)
// so a receiver at sun-depth d reconstructs
//   tau(d) = min(sigma_mean · max(d − d_front, 0), tau_max),  T = exp(−tau)
// (points sunward of the deck → d < d_front → T=1; below the deck → clamps to
// tau_max → full shadow; inside → a smooth exponential). See cloudShadowAt().
//
// SPACE: everything here is EARTH-MODEL (planet-FIXED) SCALED units, exactly
// like cloudLightVolume.ts — the density recipe derives the weather UV from the
// earth-model direction, so the shadows register with the drawn clouds. The
// window basis + centre are computed in earth-model space on the CPU
// (updateWindow rotates the inertial camera/sun by the earth model matrix).
// CONSUMERS that hold an INERTIAL position must rotate it by uEarthInverseModel
// (and scale km→scaled) BEFORE calling cloudShadowAt() — see the helper's doc.
//
// The bake mirrors cloudLightVolume's densityAt VERBATIM (coverage tap +
// deriveColumnV2 + profile LUT + baseDilate + detile, detail carve OFF) so every
// cloudShared build-const toggle stays in lockstep automatically.
// =============================================================================

// Build-time master toggle. When false, createCloudShadowMap() is a no-op and
// the RT is never allocated → zero cost. Flip on for L0+.
export const USE_CLOUD_SHADOW_MAP = true;

// ── Config ──
const BSM_SIZE = 512; // 512² → ~5.9 km/texel over a 3000 km window
export const BSM_HALF_EXTENT_KM = 1500; // window half-width (covers visible ground
//                                         from any in-atmosphere altitude)
// Above this altitude (km above ground) the bake is skipped: the near-tier
// anchor is still mounted (< 35 000 km) but no consumer needs the map. Mirrors
// FROXEL_BAKE_MAX_ALT_KM. The atmosphere consumers (god rays, ground shadow) all
// live below this.
export const BSM_MAX_ALT_KM = 2000;
const BSM_MARCH_STEPS = 24; // per-texel march over the sunward cloud crossing
const BSM_DENSITY_EPS = 1e-3; // first-hit density threshold (extinction units)
// Extinction scale for the shadow march. The PRIMARY-ray density multiplier
// (uDensityMul = 3000, earthClouds.ts) rather than the light-volume cone's
// decoupled CONE_DENSITY = 1000 — ground shadows and god rays should reflect the
// clouds' TRUE opacity, not the self-shadow's artistic value. Tunable per the
// work log; L1 adds a per-consumer strength dial on top.
const BSM_EXTINCTION = 3000;
// Base-volume mip for the density tap. MUST be 0: three r183's WebGPU backend
// zero-inits mip levels 1+ for Data3DTexture, so a nonzero LOD bakes against
// phantom ~0.5 density (cloudLightVolume.ts BAKE_BASE_LOD note).
const BSM_BASE_LOD = 0;
// No-hit SEED for the d_front min() accumulator only — must sit above any real
// depth (real d_front ≤ 0, sunward) so the first cloud sample wins the min. It
// is NEVER stored to the texture: the bake writes R=0 for no-hit texels (an
// in-range value that survives the RT's bilinear filter — see the store below).
const BSM_NO_HIT_DEPTH = 1000;
// Window-edge soft fade (fraction of half-window) so the map's border is a
// gradient to fully-lit, not a hard shadow line (mirrors LIGHT_VOL_EDGE_FRAC).
const BSM_EDGE_FRAC = 0.08;
// ── Shadow τ gate (tune to taste) ──
// The BSM integrates the MACRO density (no detail carve, low threshold), so it
// "sees" the broad optically-THIN coverage across the whole weather map — far
// more than renders as visible cloud (the volumetric/shell only show the DENSE
// subset). A linear τ multiplier can't win: darken enough for dense clouds and
// the thin coverage shadows too ("magenta everywhere"); low enough to hide thin
// and dense barely shows. Instead GATE on optical depth: columns below
// SHADOW_TAU_LO cast NO shadow (invisible thin cloud), above SHADOW_TAU_HI cast
// the full physical exp(−τ) shadow, smoothstep between. This is the standard
// threshold-cloud-shadow approach (Frostbite/Nubis). CALIBRATE with
// BSM_BLIT="tau" (shows τ/10 in grey): read the grey under a DENSE cloud (×10 =
// its τ) vs thin coverage, and set LO/HI between them.
const SHADOW_TAU_LO = 0.4; // τ ≤ this → no shadow (thin, invisible cloud)
const SHADOW_TAU_HI = 4.0; // τ ≥ this → full physical shadow (dense cloud)

// ── Grazing-sun penumbra (soften long terminator shadows) ──
// Real cloud shadows soften along their sides as they lengthen (penumbra widens
// with length; twilight skylight scatters into them). Our sun-ortho map keeps
// razor-sharp texel-scale sides regardless of length → long terminator shadows
// read as hard streaks. Fix: blur the map lookup by a radius that GROWS as the
// sun grazes (cosElev = sin(sun elevation) → 0 at the terminator). A tiny always-
// on blur (MIN) also hides the 512² texel aliasing at high sun.
const SHADOW_PENUMBRA_MIN = 0.6; // blur radius (texels) at high sun
const SHADOW_PENUMBRA_MAX = 6.0; // blur radius (texels) at the terminator
const SHADOW_PENUMBRA_ELEV = 0.5; // cosElev at/above which the blur is MIN (~30°)

// ── Soft (blurred) map for the VOLUME consumers (L2 god rays) ──
// The god-ray shafts are extrusions of this map through the whole atmosphere:
// at 5.9 km/texel, bilinear's piecewise-linear ramps (further sharpened by the
// τ gate) read as hard BLOCKY facets in the sky. The industry fix is to blur
// the shadow map itself (UE r.VolumetricCloud.ShadowMap.Blur, Frostbite,
// Unity's cookie): physically, multiple scattering through cloud edges diffuses
// real shafts far beyond the ~50 m geometric penumbra, and sub-texel features
// are unresolvable anyway. A 3×3 Gaussian at BSM_SOFT_BLUR_TEXELS offset runs
// after each bake into a second RT. The SURFACE consumer keeps the SHARP map
// (its grazing-adaptive 5-tap penumbra already softens it — tuned in L1).
const BSM_SOFT_BLUR_TEXELS = 1.5; // blur tap offset (texels); raise for softer shafts

// ── Singleton RenderTarget (process-lifetime; bound once at graph build for
//    bind-group-cache stability — never reassigned, never disposed) ──
let _bsmRT: RenderTarget | null = null;
export function getCloudShadowMap(): RenderTarget {
  if (!_bsmRT) {
    const rt = new RenderTarget(BSM_SIZE, BSM_SIZE, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
    });
    // Orthographic window — no wrap on either axis (beyond the window the
    // reconstruction's edge fade returns fully-lit). Default LinearFilter is
    // what the bilinear cloudShadowAt fetch wants.
    rt.texture.wrapS = THREE.ClampToEdgeWrapping;
    rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    _bsmRT = rt;
  }
  return _bsmRT;
}

// The blurred companion (see BSM_SOFT_BLUR_TEXELS) — written by the blur pass
// right after each bake, sampled by the VOLUME consumers (god rays). Same
// process-lifetime singleton discipline as the sharp map.
let _bsmSoftRT: RenderTarget | null = null;
export function getCloudShadowMapSoft(): RenderTarget {
  if (!_bsmSoftRT) {
    const rt = new RenderTarget(BSM_SIZE, BSM_SIZE, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
    });
    rt.texture.wrapS = THREE.ClampToEdgeWrapping;
    rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    _bsmSoftRT = rt;
  }
  return _bsmSoftRT;
}

// ── L3: ship cloud-shadow probe (docs/CLOUD_SHADOWS_GODRAYS_PLAN.md) ─────────
// A 1×1 FloatType RT whose single fragment evaluates cloudShadowCore at the
// ship's earth-model position — the GPU reconstruction is the single source of
// truth (no CPU mirror to drift, no uv/y-flip/fp16 concerns; rgba32float reads
// back as Float32Array). Rendered every bake (one fragment ≈ free), read back
// asynchronously every SHIP_READBACK_INTERVAL frames, EMA-smoothed on the CPU.
// FloatType because rgba32float is renderable (NoBlending) and readback-exact.
let _shipProbeRT: RenderTarget | null = null;
function getShipProbeRT(): RenderTarget {
  if (!_shipProbeRT) {
    _shipProbeRT = new RenderTarget(1, 1, {
      type: THREE.FloatType,
      depthBuffer: false,
    });
  }
  return _shipProbeRT;
}
const SHIP_READBACK_INTERVAL = 2; // frames between async 1-px readbacks
// EMA coefficient per frame (~0.07 s time constant at 60 fps): smooths the
// readback latency + cloud-edge crossings without the sluggish lag the user hit
// when flying out of a deck into a sunlit gap (was 0.08 ≈ 0.25 s). Raise toward
// 1 for snappier / lower for smoother.
const SHIP_SHADOW_SMOOTH = 0.2;
// DEBUG (dev only): console-log the ship-shadow readback chain — the raw 1-px
// probe value, the EMA'd value, and the strength gate — throttled to once per
// readback. Reveals whether the GPU probe ever returns <1 (ship under cloud)
// and whether it survives the strength gate + EMA into the lighting bridge.
const SHIP_PROBE_DEBUG = false;
let _shipCloudTRead = 1; // latest readback value
let _shipCloudTSmooth = 1; // EMA'd value handed to the lighting bridge
let _shipReadbackInFlight = false;
let _shipFrameCounter = 0;

/**
 * Smoothed sun transmittance through clouds at the SHIP ∈ (0,1]. Call once per
 * frame (the atmosphere lighting bridge does) — each call advances the EMA.
 * Relaxes to 1 whenever the BSM is stale/unbaked (strength gate 0 — high
 * altitude, no cloud pipeline), so the key light never keeps a stale shadow.
 */
export function getShipCloudShadowT(): number {
  const strength = _bsmUniforms ? (_bsmUniforms.strength.value as number) : 0;
  const target = strength > 0 ? _shipCloudTRead : 1;
  _shipCloudTSmooth += (target - _shipCloudTSmooth) * SHIP_SHADOW_SMOOTH;
  return _shipCloudTSmooth;
}

// ── Window uniforms (process-lifetime singleton, like the RT) ──
// Shared by the bake fragment (createCloudShadowMap) AND the reconstruction
// helper (cloudShadowAt, built into consumer graphs). One BSM ⇒ one Earth ⇒ one
// set of window uniforms. Lazily created so no uniform() runs at import time.
type BsmUniforms = {
  center: Node; // window centre, earth-model scaled (on the plane ⊥ sunDir)
  right: Node; // window +x axis (⊥ sunDir), earth-model
  up: Node; // window +y axis (⊥ sunDir), earth-model
  sunDir: Node; // earth-model sun direction (planet→sun)
  halfExtent: Node; // half-window width, scaled units
  // Consumer gate ∈ [0,1]: 1 where the map is freshly baked (low altitude),
  // faded to 0 approaching BSM_MAX_ALT_KM (and 0 when the bake is skipped), so a
  // stale/unbaked map contributes NO shadow. Driven by setCloudShadowStrength().
  strength: Node;
  // Cloud-slab OUTER radius (scaled units). The reconstruction recomputes the
  // sunward-entry depth tOuter = sqrt(rOut²−wp²) to undo the slab-relative R
  // encoding. Set once from the deps in createCloudShadowMap.
  outerRadius: Node;
  // scaled-world → earth-model matrix (refreshed each updateWindow). Consumers
  // holding planet-centred INERTIAL positions (the atmosphere pass, L2) rotate
  // them into the BSM's earth-model frame through this — as a DIRECTION (w=0),
  // since planet-centred positions need only the rotation part.
  invModel: Node;
  // Ship position in earth-model scaled units (refreshed each updateWindow) —
  // the L3 probe's receiver point. Ship ≈ camera (the third-person offset is
  // metres against km-scale penumbra/texels).
  shipPos: Node;
};
let _bsmUniforms: BsmUniforms | null = null;
function getBsmUniforms(): BsmUniforms {
  if (!_bsmUniforms) {
    _bsmUniforms = {
      center: uniform(new THREE.Vector3()),
      right: uniform(new THREE.Vector3(1, 0, 0)),
      up: uniform(new THREE.Vector3(0, 1, 0)),
      sunDir: uniform(new THREE.Vector3(0, 0, 1)),
      halfExtent: uniform(kmToScaledUnits(BSM_HALF_EXTENT_KM)),
      strength: uniform(0),
      // 0 until createCloudShadowMap copies the real cloud-outer radius; with 0,
      // tOuter collapses to 0 → depthIntoDeck ≤ 0 → no shadow (safe transient).
      outerRadius: uniform(0),
      invModel: uniform(new THREE.Matrix4()),
      shipPos: uniform(new THREE.Vector3()),
    };
  }
  return _bsmUniforms;
}

export type CloudShadowMapDeps = {
  baseVolume: THREE.Texture;
  weatherMap: THREE.Texture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uInnerRadius: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uOuterRadius: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uBaseScale: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uColumnScale: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uCloudUvOffset: any;
  // Sun direction in SCALED world space (inertial). SHARED node from the marcher.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSunRel: any;
};

export type CloudShadowMap = {
  /** Recompute the sun-space window (basis + texel-snapped centre) from the
   *  current camera + sun. Call once per frame before bake(). */
  updateWindow: (
    cameraScaledPos: THREE.Vector3,
    earthMesh: THREE.Object3D,
  ) => void;
  /** Render the BSM for this frame. SYNCHRONOUS; call after updateWindow and
   *  BEFORE any consumer (froxel/sky-view/main atmosphere pass). */
  bake: (renderer: WebGPURenderer) => void;
  dispose: () => void;
};

export function createCloudShadowMap(
  deps: CloudShadowMapDeps,
): CloudShadowMap | null {
  if (!USE_CLOUD_SHADOW_MAP) return null;
  const {
    baseVolume,
    weatherMap,
    uInnerRadius,
    uOuterRadius,
    uBaseScale,
    uColumnScale,
    uCloudUvOffset,
    uSunRel,
  } = deps;

  const U = getBsmUniforms();
  const bsmRT = getCloudShadowMap();
  // Share the outer radius with the reconstruction (static per setup, but the
  // node's .value is read at render time so this is safe even before any frame).
  U.outerRadius.value = uOuterRadius.value;

  const invSlabThickness = float(1).div(uOuterRadius.sub(uInnerRadius));
  const invTwoPi = float(1).div(PI.mul(2));
  const invPi = float(1).div(PI);

  // ── Cheap macro density at an earth-model point q (VERBATIM mirror of
  //    cloudLightVolume.ts densityAt — same taps, same shared helpers, detail
  //    carve OFF, ×BSM_EXTINCTION). Keep in lockstep or shadows detach. ──
  const densityAt = (q: Node): Node => {
    const r = length(q).max(0.0001);
    const alt01 = clamp(r.sub(uInnerRadius).mul(invSlabThickness), 0, 1);
    const dir = q.div(r);

    const u = fract(atan(dir.z, dir.x.negate()).mul(invTwoPi));
    const v = acos(clamp(dir.y.negate(), -1, 1)).mul(invPi);
    const uv = vec2(u, v).add(uCloudUvOffset);
    const wTap = texture(weatherMap, uv).level(int(0)) as Node;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let coverage: any = WEATHER_V2 ? wTap.r : wTap.r.pow(float(0.6));
    const cloudType = WEATHER_V2 ? wTap.g : deriveCloudType(coverage);

    const pColumn = dir.mul(uInnerRadius);
    const colTap = texture3D(baseVolume, pColumn.mul(uColumnScale)).level(
      int(0),
    ) as Node;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let topAlt: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let profileConv: any = cloudType;
    if (WEATHER_V2) {
      const mesoTap = texture3D(
        baseVolume,
        pColumn.mul(float(MESO_SCALE)),
      ).level(int(0)) as Node;
      coverage = fractionPlacement(coverage, mesoTap.g);
      const col = deriveColumnV2(wTap.b, mesoTap.g, cloudType);
      topAlt = col.topAlt;
      coverage = convectiveCoverage(coverage, col.turretT, col.shield);
      profileConv = anvilProfileConv(cloudType, col.sheet);
    } else {
      topAlt = deriveTopAlt(coverage, colTap.r);
    }
    const profile = cloudHeightProfile(alt01, topAlt, profileConv);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let baseShapeDilated: any;
    if (USE_DETILE) {
      const dilatedAt = (pos: Node): Node => {
        const b = texture3D(baseVolume, pos.mul(uBaseScale)).level(
          int(BSM_BASE_LOD),
        ) as Node;
        const f = b.g.mul(0.625).add(b.b.mul(0.25)).add(b.a.mul(0.125));
        return baseDilate(b.r, f);
      };
      baseShapeDilated = detileBlend(q, dilatedAt);
    } else {
      // Anti-tiling domain warp — VERBATIM mirror of cloudLightVolume.ts's
      // else-branch (colTap.gba × WARP_AMPLITUDE_MIRROR, shared const). 0 today
      // (warp-off path), so the offset is nil; kept so the BSM stays in lockstep
      // if the warp is ever re-enabled — otherwise the shadows would silently
      // detach from the clouds that cast them.
      const warpVec = vec3(
        colTap.g.sub(0.5),
        colTap.b.sub(0.5),
        colTap.a.sub(0.5),
      ).mul(float(WARP_AMPLITUDE_MIRROR));
      const bs = texture3D(baseVolume, q.add(warpVec).mul(uBaseScale)).level(
        int(BSM_BASE_LOD),
      ) as Node;
      const fbm = bs.g.mul(0.625).add(bs.b.mul(0.25)).add(bs.a.mul(0.125));
      baseShapeDilated = baseDilate(bs.r, fbm);
    }

    return baseShapeDilated.mul(coverage).mul(profile).mul(float(BSM_EXTINCTION));
  };

  // ── Bake fragment: one sun-parallel ray per texel ──
  const bsmBakeFragment = Fn(() => {
    // Texel → point on the window plane (earth-model scaled). The window centre
    // lies on the plane through the earth centre ⊥ sunDir, and (right,up) are
    // both ⊥ sunDir, so dot(winPoint, sunDir) = 0 → the window plane is at
    // sun-depth 0 and the ray's slab intersection is symmetric about it.
    const local = screenUV.mul(2).sub(1);
    const winPoint = U.center
      .add(U.right.mul(local.x.mul(U.halfExtent)))
      .add(U.up.mul(local.y.mul(U.halfExtent)))
      .toVar();

    const wp2 = dot(winPoint, winPoint);
    const rOut2 = uOuterRadius.mul(uOuterRadius);
    const rIn2 = uInnerRadius.mul(uInnerRadius);

    // Accumulators (no-hit defaults).
    const tau = float(0).toVar();
    const dFront = float(BSM_NO_HIT_DEPTH).toVar();
    const dLast = float(BSM_NO_HIT_DEPTH).negate().toVar();
    const hit = float(0).toVar();
    // Hoisted so the sigma_mean span guard below can floor at the actual step
    // size (see the single-sample overflow note there).
    const dt = float(0).toVar();
    // Hoisted for the slab-RELATIVE d_front encoding: R stores (d_front + tOuter)
    // = the depth into the slab from the sunward outer-shell entry — a SMALL
    // magnitude (0..slab-crossing ≈ 0.03 scaled) so fp16 resolves it to ~15 m
    // instead of the ~3.9 km it gave for the absolute ~6400 km depth (which
    // rounded d_front into plateaus → jagged step-lines in the ground shadow).
    // The consumer recomputes tOuter from the receiver's ray and undoes this.
    const tOuterV = float(0).toVar();

    // disc = rOut² − wp²  (> 0 ⇒ the sun-parallel ray crosses the outer shell).
    const disc = rOut2.sub(wp2);
    If(disc.greaterThan(0), () => {
      const tOuter = sqrt(disc.max(0));
      tOuterV.assign(tOuter);
      // Sunward march end: the inner-sphere hit if the ray enters the hollow
      // (wp < rIn), else the far outer hit (a continuous shell crossing).
      const innerDisc = rIn2.sub(wp2);
      const tEnd = select(
        innerDisc.greaterThan(0),
        sqrt(innerDisc.max(0)),
        tOuter.negate(),
      );
      dt.assign(tOuter.sub(tEnd).div(BSM_MARCH_STEPS));
      Loop(BSM_MARCH_STEPS, ({ i: s }: { i: Node }) => {
        // March from the sunward outer hit (t = +tOuter) inward. Depth along the
        // light's travel = −dot(P, sunDir) = −t (winPoint contributes 0).
        const t = tOuter.sub(dt.mul(float(s).add(0.5)));
        const P = winPoint.add(U.sunDir.mul(t));
        const dens = densityAt(P);
        tau.addAssign(dens.mul(dt));
        const depth = t.negate();
        const isCloud = dens.greaterThan(BSM_DENSITY_EPS);
        dFront.assign(select(isCloud, min(dFront, depth), dFront));
        dLast.assign(select(isCloud, max(dLast, depth), dLast));
        hit.assign(max(hit, select(isCloud, float(1), float(0))));
      });
    });

    // sigma_mean over the cloudy interval. Floor the span at the march STEP dt,
    // not a tiny epsilon: a lone cloud sample gives dLast==dFront → span 0. With
    // an epsilon floor, sigma = tau/eps blows up to ~1e5+ and OVERFLOWS the
    // RGBA16F G channel to +Inf, which the RT's LinearFilter then bleeds across
    // its 2×2 footprint → NaN in the reconstruction (min(Inf·0, …)). Flooring at
    // dt makes a single sample yield sigma = tau/dt ≈ dens (the correct mean),
    // and multi-sample spans are already ≥ dt so they are unchanged. The extra
    // clamp at BSM_EXTINCTION is a belt-and-suspenders ceiling (mean density can
    // never exceed the peak extinction) so G can never reach half-float overflow.
    const span = dLast.sub(dFront).max(dt);
    const sigmaMean = tau.div(span).min(float(BSM_EXTINCTION));
    const isHit = hit.greaterThan(0.5);
    // R = SLAB-RELATIVE front depth = d_front + tOuter (∈ [0, slab-crossing],
    // small → fp16-precise). No-hit stores 0 (in range; G=B=0 already force
    // tau=0 → T=1 there, and the small magnitude keeps the LinearFilter blend at
    // shadow edges within the real band).
    const rFront = dFront.add(tOuterV);
    return vec4(
      select(isHit, rFront, float(0)),
      select(isHit, sigmaMean, float(0)),
      select(isHit, tau, float(0)),
      hit,
    );
  });

  // ── Fullscreen bake scene (makeScene shape from atmospherePass.ts) ──
  const quad = new THREE.PlaneGeometry(2, 2);
  const bakeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const mat = new NodeMaterial();
  mat.transparent = false;
  mat.depthTest = false;
  mat.depthWrite = false;
  mat.blending = THREE.NoBlending;
  mat.fragmentNode = bsmBakeFragment();
  const mesh = new THREE.Mesh(quad, mat);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  // All three BSM passes (bake, blur, ship probe) share one profiler label —
  // they are one logical cost. See perf/perfProfiler.ts.
  scene.name = PASS.bsm;

  // ── Soft-map blur pass: sharp bsmRT → 3×3 Gaussian → soft RT ──
  // All four channels blur together; across cloud/no-cloud boundaries the
  // G=σ/B=τ channels shrink toward their 0 no-hit values, weakening the shadow
  // smoothly (the same argument that makes the LinearFilter edge bleed safe).
  const bsmSoftRT = getCloudShadowMapSoft();
  const blurFragment = Fn(() => {
    const px = float(BSM_SOFT_BLUR_TEXELS / BSM_SIZE);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tap = (dx: number, dy: number, w: number): any =>
      (
        texture(
          bsmRT.texture,
          screenUV.add(vec2(px.mul(dx), px.mul(dy))),
        ).level(int(0)) as Node
      ).mul(w);
    // 3×3 Gaussian (1 2 1 / 2 4 2 / 1 2 1) / 16.
    return tap(-1, -1, 1 / 16)
      .add(tap(0, -1, 2 / 16))
      .add(tap(1, -1, 1 / 16))
      .add(tap(-1, 0, 2 / 16))
      .add(tap(0, 0, 4 / 16))
      .add(tap(1, 0, 2 / 16))
      .add(tap(-1, 1, 1 / 16))
      .add(tap(0, 1, 2 / 16))
      .add(tap(1, 1, 1 / 16));
  });
  const blurMat = new NodeMaterial();
  blurMat.transparent = false;
  blurMat.depthTest = false;
  blurMat.depthWrite = false;
  blurMat.blending = THREE.NoBlending;
  blurMat.fragmentNode = blurFragment();
  const blurMesh = new THREE.Mesh(quad, blurMat);
  blurMesh.frustumCulled = false;
  const blurScene = new THREE.Scene();
  blurScene.add(blurMesh);
  blurScene.name = PASS.bsm;

  // ── L3 ship probe: reconstruct the BSM shadow at the ship's earth-model
  //    position. R = SINGLE-tap (used for lighting — a point receiver wants the
  //    value AT its position, NOT the edge-softening penumbra blur, which
  //    averages a narrow tower's shadow into the clear air around it →
  //    under-dims; that blur is only for the ground shadow's visible EDGES).
  //    G = the old 5-tap penumbra value, kept purely as a DIAGNOSTIC (compare
  //    R vs G under a tower: R≪G ⇒ the blur was the culprit; R≈G ⇒ the macro
  //    512² map genuinely can't resolve the tower and a dedicated sun-march is
  //    the only fix). ──
  const shipProbeRT = getShipProbeRT();
  const shipProbeFragment = Fn(() => {
    // .r drives the lighting. Telemetry (2026-07-17) showed the single tap reads
    // the ship's OWN macro column, which is frequently a no-hit (1.0) even when
    // the ship is visually inside a detailed tower — so the 5-tap neighbourhood
    // (which catches surrounding macro cloud) is the LESS-wrong BSM answer. Both
    // are fundamentally macro-limited; the accurate fix is the dedicated
    // sun-march below. .g keeps the single tap as a diagnostic.
    const soft = cloudShadowCore(U.shipPos, true);
    const single = cloudShadowCore(U.shipPos, false);
    return vec4(soft, single, 0, 1);
  });
  const probeMat = new NodeMaterial();
  probeMat.transparent = false;
  probeMat.depthTest = false;
  probeMat.depthWrite = false;
  probeMat.blending = THREE.NoBlending;
  probeMat.fragmentNode = shipProbeFragment();
  const probeMesh = new THREE.Mesh(quad, probeMat);
  probeMesh.frustumCulled = false;
  const probeScene = new THREE.Scene();
  probeScene.add(probeMesh);
  probeScene.name = PASS.bsm;

  // ── CPU per-frame window update (no per-frame allocation) ──
  const _inverseModel = new THREE.Matrix4();
  const _earthCam = new THREE.Vector3();
  const _sunDirEarth = new THREE.Vector3();
  const _refUp = new THREE.Vector3(0, 1, 0); // earth-model north pole
  const _right = new THREE.Vector3();
  const _up = new THREE.Vector3();
  const _center = new THREE.Vector3();

  const updateWindow: CloudShadowMap["updateWindow"] = (
    cameraScaledPos,
    earthMesh,
  ) => {
    // scaled-world → earth-model (rotation+translation). The near-tier anchor
    // provides the matrix; the marcher's shared uEarthInverseModel is only
    // refreshed inside the cloudsVisible block (low alt), so the BSM inverts
    // here itself — correct at every altitude it bakes at.
    earthMesh.updateWorldMatrix(true, false);
    _inverseModel.copy(earthMesh.matrixWorld).invert();

    // Camera + sun into earth-model space.
    _earthCam.copy(cameraScaledPos).applyMatrix4(_inverseModel);
    // uSunRel is the sun-minus-centre vector in scaled INERTIAL units; rotate it
    // into earth-model as a DIRECTION (ignores translation, normalises).
    _sunDirEarth.copy(uSunRel.value).transformDirection(_inverseModel);
    if (_sunDirEarth.lengthSq() < 1e-12) _sunDirEarth.set(0, 0, 1);

    // Sun-space basis ⊥ sunDir. right = refUp × sunDir; fall back to +X if the
    // sun is within ~0.057° of the pole (|right|²=sin²θ, so the 1e-6 test is
    // sinθ<1e-3 → θ<0.057° — a degenerate near-zero cross product).
    _right.crossVectors(_refUp, _sunDirEarth);
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
    _right.normalize();
    _up.crossVectors(_sunDirEarth, _right).normalize();

    // Window centre = earth-space camera projected onto the plane through the
    // earth centre ⊥ sunDir, then TEXEL-SNAPPED in (right,up) so the discrete
    // window only moves in whole texels (the light-volume swim fix): un-snapped
    // sub-texel drift re-discretises the sampled field every frame.
    const half = U.halfExtent.value as number;
    const texel = (2 * half) / BSM_SIZE;
    const cx = _earthCam.dot(_right);
    const cy = _earthCam.dot(_up);
    const cxS = Math.round(cx / texel) * texel;
    const cyS = Math.round(cy / texel) * texel;
    _center
      .copy(_right)
      .multiplyScalar(cxS)
      .addScaledVector(_up, cyS);

    U.center.value.copy(_center);
    U.right.value.copy(_right);
    U.up.value.copy(_up);
    U.sunDir.value.copy(_sunDirEarth);
    // For inertial-km consumers (cloudShadowAtPlanetKm — the atmosphere pass).
    U.invModel.value.copy(_inverseModel);
    // L3 ship probe receiver (ship ≈ camera; _earthCam already computed above).
    U.shipPos.value.copy(_earthCam);
  };

  const bake: CloudShadowMap["bake"] = (renderer) => {
    if (!(renderer as unknown as { backend?: { device?: unknown } }).backend?.device)
      return;
    renderer.setRenderTarget(bsmRT);
    renderer.render(scene, bakeCamera);
    // Blur into the soft map (same queue → ordered before any consumer read).
    renderer.setRenderTarget(bsmSoftRT);
    renderer.render(blurScene, bakeCamera);
    // L3 ship probe (1 fragment; reads the sharp map just written — same-queue
    // ordering makes the same-frame read safe).
    renderer.setRenderTarget(shipProbeRT);
    renderer.render(probeScene, bakeCamera);
    renderer.setRenderTarget(null);
    // Async 1-px readback every Nth frame. FIRE-AND-FORGET — never awaited in
    // the frame loop (plan risk #7); the in-flight flag stops promise pile-up
    // if a backend maps slowly. Value lands 1-2 frames later; the consumer-side
    // EMA (getShipCloudShadowT) absorbs the latency.
    _shipFrameCounter++;
    if (_shipFrameCounter % SHIP_READBACK_INTERVAL === 0 && !_shipReadbackInFlight) {
      _shipReadbackInFlight = true;
      (
        renderer as unknown as {
          readRenderTargetPixelsAsync: (
            rt: RenderTarget,
            x: number,
            y: number,
            w: number,
            h: number,
          ) => Promise<Float32Array>;
        }
      )
        .readRenderTargetPixelsAsync(shipProbeRT, 0, 0, 1, 1)
        .then((px) => {
          // rgba32float → Float32Array. .r = 5-tap soft (lighting), .g =
          // single-tap (diagnostic only).
          if (px && px.length >= 1 && Number.isFinite(px[0])) {
            _shipCloudTRead = Math.min(Math.max(px[0], 0), 1);
          }
          if (SHIP_PROBE_DEBUG) {
            const sp = U.shipPos.value as THREE.Vector3;
            console.log(
              `[ship-probe] soft=${px && px.length ? px[0].toFixed(3) : "n/a"} ` +
                `single=${px && px.length >= 2 ? px[1].toFixed(3) : "n/a"} ` +
                `ema=${_shipCloudTSmooth.toFixed(3)} ` +
                `strength=${(U.strength.value as number).toFixed(2)} ` +
                `shipR=${sp.length().toFixed(3)}`,
            );
          }
          _shipReadbackInFlight = false;
        })
        .catch(() => {
          _shipReadbackInFlight = false;
        });
    }
  };

  const dispose: CloudShadowMap["dispose"] = () => {
    scene.remove(mesh);
    mat.dispose();
    blurScene.remove(blurMesh);
    blurMat.dispose();
    probeScene.remove(probeMesh);
    probeMat.dispose();
    quad.dispose();
    // The RTs are process-lifetime singletons — deliberately NOT disposed (they
    // outlive pass rebuilds for bind-group stability).
  };

  return { updateWindow, bake, dispose };
}

// =============================================================================
// Reconstruction helpers (for L1 ground shadow / L2 god rays / L3 ship).
// =============================================================================

/**
 * Shared reconstruction core. `P` is EARTH-MODEL SCALED. `penumbra` (build-time
 * JS boolean — dead branch eliminated) picks 5-tap grazing-widened blur (surface
 * shading) vs a single tap (volume marches, where the per-step integration
 * already averages and 5 taps × 32 steps would be 160 taps/pixel).
 */
function cloudShadowCore(P: Node, penumbra: boolean): Node {
  const U = getBsmUniforms();

  // ── Uniform early-out when the map is not live ────────────────────────────
  // `strength` is SpaceRenderer's freshness gate: 0 whenever the BSM was not
  // baked this frame (altitude > BSM_MAX_ALT_KM, no pipeline, etc.). Every path
  // below already multiplies out to exactly 1 in that case — via
  // `edgeFade = smoothstep(...)·strength` feeding `mix(1, shadowT, edgeFade)` —
  // but it multiplied AFTER doing the work, so the texture fetch and the whole
  // τ reconstruction still ran. Inside the atmosphere pass's 32-step march that
  // is 32 wasted dependent fetches per ground pixel on every frame above
  // 2000 km, which MEASURED as the dominant share of a 13–22 ms pass
  // (docs/PERF_MEASUREMENT.md).
  //
  // `strength` is a per-frame uniform, so this branch is coherent across the
  // entire draw — the whole pass takes one side, no divergence. Returning 1
  // directly is also strictly safer than `mix(1, x, 0)`, which propagates a NaN
  // from `x` on hardware where 0·NaN = NaN.
  const shadowOut = float(1).toVar();
  If(U.strength.greaterThan(0), () => {
    shadowOut.assign(cloudShadowLive(P, penumbra));
  });
  return shadowOut;
}

/** The actual reconstruction. Only reached when the map is live — see above. */
function cloudShadowLive(P: Node, penumbra: boolean): Node {
  const U = getBsmUniforms();
  // Surface path (penumbra) reads the SHARP map — its grazing-adaptive 5-tap
  // blur supplies the softness. Volume path (single-tap god rays) reads the
  // pre-BLURRED soft map, whose extruded shafts would otherwise show the 512²
  // texel facets (see BSM_SOFT_BLUR_TEXELS).
  const rt = penumbra ? getCloudShadowMap() : getCloudShadowMapSoft();
  const rel = P.sub(U.center);
  const x = dot(rel, U.right);
  const y = dot(rel, U.up);
  const u = x.div(U.halfExtent).mul(0.5).add(0.5);
  const v = y.div(U.halfExtent).mul(0.5).add(0.5);
  const uv = vec2(u, v);
  // Soft window edge → fully-lit beyond the map (matches the light volume). The
  // freshness `strength` gate folds into the same fade so a stale map (high
  // altitude, bake skipped) contributes no shadow.
  const edgeDist = u.min(float(1).sub(u)).min(v.min(float(1).sub(v)));
  // Annotate Node: `.mul(U.strength)` (U.strength is `any`) otherwise resolves to
  // a vec3 overload and breaks the scalar mix() below.
  const edgeFade: Node = smoothstep(
    float(0),
    float(BSM_EDGE_FRAC),
    edgeDist,
  ).mul(U.strength);
  const d = dot(P, U.sunDir).negate();
  // Undo the slab-relative R encoding: d_front = R − tOuter, where tOuter is the
  // sunward outer-shell entry depth for THIS receiver's ray, recomputed at full
  // precision from the receiver: wp² = |P|² − d² (perpendicular offset from the
  // earth centre), tOuter = sqrt(rOut² − wp²). So d − d_front = d − R + tOuter,
  // all float32 here except the small (fp16-precise) R. This kills the ~3.9 km
  // d_front plateaus that caused the jagged step-lines. d/tOuter are per-RECEIVER
  // (constant across the penumbra taps below — only the MAP lookup blurs).
  const wp2 = dot(P, P).sub(d.mul(d));
  const tOuter = sqrt(U.outerRadius.mul(U.outerRadius).sub(wp2).max(0));

  // Reconstruct the gated shadow transmittance from a map tap at `uv + off`,
  // using THIS receiver's depth. τ gate: thin coverage (τ < LO) → no shadow;
  // dense (τ > HI) → full physical exp(−τ) — kills the broad "shadow with no
  // visible cloud" from thin macro coverage while keeping dense shadows dark.
  const reconstructAt = (off: Node): Node => {
    const b = (texture(rt.texture, uv.add(off)).level(int(0)) as Node).toVar();
    const depthIntoDeck = d.sub(b.r).add(tOuter).max(0);
    const tau = min(b.g.mul(depthIntoDeck), b.b);
    const gate = smoothstep(float(SHADOW_TAU_LO), float(SHADOW_TAU_HI), tau);
    return mix(float(1), exp(tau.negate()), gate);
  };

  if (!penumbra) {
    // Single tap — volume-march consumers (god rays).
    return mix(float(1), reconstructAt(vec2(0, 0)), edgeFade);
  }

  // Grazing-sun penumbra: blur the map lookup with a radius that grows as the sun
  // grazes (cosElev = sin(elevation) = −d/|P| → 0 at the terminator), so long
  // terminator shadows soften instead of streaking razor-sharp. 5-tap cross.
  const cosElev = d.negate().div(length(P).max(1e-4));
  const penTexels = mix(
    float(SHADOW_PENUMBRA_MIN),
    float(SHADOW_PENUMBRA_MAX),
    clamp(float(1).sub(cosElev.div(SHADOW_PENUMBRA_ELEV)), 0, 1),
  );
  const r = penTexels.div(BSM_SIZE);
  const shadowT = reconstructAt(vec2(0, 0))
    .add(reconstructAt(vec2(r, 0)))
    .add(reconstructAt(vec2(r.negate(), 0)))
    .add(reconstructAt(vec2(0, r)))
    .add(reconstructAt(vec2(0, r.negate())))
    .mul(float(1).div(5));
  return mix(float(1), shadowT, edgeFade);
}

/**
 * Sun transmittance ∈ (0,1] at an EARTH-MODEL SCALED position `P` (e.g. the
 * earth surface mesh's object-space `positionLocal`, which is scaled-km and
 * earth-fixed — the BSM's exact frame). 5-tap grazing-widened penumbra — the
 * SURFACE-shading flavour (L1). Returns 1 (fully lit) outside the window,
 * sunward of the deck, AND wherever the map is stale/unbaked (strength 0 —
 * the SpaceRenderer altitude gate).
 */
export function cloudShadowAt(P: Node): Node {
  return cloudShadowCore(P, true);
}

/**
 * Sun transmittance at a planet-centred INERTIAL position in KM (the atmosphere
 * pass's native frame — L2 god rays). Converts km→scaled and rotates into the
 * BSM's earth-model frame via the invModel uniform (as a direction: planet-
 * centred positions need only the rotation part). SINGLE-tap reconstruction —
 * per-step march integration already averages, and the penumbra's 5 taps would
 * be 160 taps/pixel inside a 32-step march.
 */
export function cloudShadowAtPlanetKm(PKm: Node): Node {
  const U = getBsmUniforms();
  const Pm = U.invModel.mul(
    vec4(PKm.mul(float(kmToScaledUnits(1))), 0),
  ).xyz;
  return cloudShadowCore(Pm, false);
}

/**
 * Set the consumer-side freshness gate (0 = no shadow, 1 = full). SpaceRenderer
 * drives this per frame: a smoothstep altitude fade to 0 approaching
 * BSM_MAX_ALT_KM, and 0 whenever the bake is skipped (no pipeline / too high).
 */
export function setCloudShadowStrength(v: number): void {
  getBsmUniforms().strength.value = v;
}

/**
 * The freshness-gate uniform node (∈[0,1]), for consumers that crossfade the BSM
 * against a fallback (e.g. earth.ts blends the legacy 2-tap fake → the BSM by
 * this). cloudShadowAt() already folds it in, so most consumers don't need this.
 */
export function cloudShadowStrengthNode(): Node {
  return getBsmUniforms().strength;
}

/**
 * TSL sun-depth coordinate for `P` (earth-model scaled). Exposed for consumers
 * that want the raw depth (e.g. debug). d = −dot(P, sunDir).
 */
export function bsmDepthAt(P: Node): Node {
  return dot(P, getBsmUniforms().sunDir).negate();
}

/**
 * CPU mirror of the window projection for the L3 ship readback: given an
 * earth-model SCALED position, returns its BSM texel UV (may lie outside [0,1]).
 * The caller reads back the RT at this UV. No allocation on the hot path if
 * `out` is supplied.
 */
const _relCPU = new THREE.Vector3();
export function bsmUvCPU(
  pEarthScaled: THREE.Vector3,
  out: THREE.Vector2 = new THREE.Vector2(),
): THREE.Vector2 {
  const U = getBsmUniforms();
  const center = U.center.value as THREE.Vector3;
  const right = U.right.value as THREE.Vector3;
  const up = U.up.value as THREE.Vector3;
  const half = U.halfExtent.value as number;
  _relCPU.copy(pEarthScaled).sub(center);
  const x = _relCPU.dot(right);
  const y = _relCPU.dot(up);
  return out.set((x / half) * 0.5 + 0.5, (y / half) * 0.5 + 0.5);
}
