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
  };

  const bake: CloudShadowMap["bake"] = (renderer) => {
    if (!(renderer as unknown as { backend?: { device?: unknown } }).backend?.device)
      return;
    renderer.setRenderTarget(bsmRT);
    renderer.render(scene, bakeCamera);
    renderer.setRenderTarget(null);
  };

  const dispose: CloudShadowMap["dispose"] = () => {
    scene.remove(mesh);
    mat.dispose();
    quad.dispose();
    // The RT is a process-lifetime singleton — deliberately NOT disposed (it
    // outlives pass rebuilds for bind-group stability).
  };

  return { updateWindow, bake, dispose };
}

// =============================================================================
// Reconstruction helpers (for L1 ground shadow / L2 god rays / L3 ship).
// =============================================================================

/**
 * Sun transmittance ∈ (0,1] at an EARTH-MODEL SCALED position `P` (e.g. the
 * earth surface mesh's object-space `positionLocal`, which is scaled-km and
 * earth-fixed — the BSM's exact frame). A consumer holding an INERTIAL position
 * must rotate it by the earth inverse-model + convert km→scaled first.
 * Returns 1 (fully lit) outside the window, sunward of the deck, AND wherever the
 * map is stale/unbaked (strength 0 — the SpaceRenderer altitude gate).
 */
export function cloudShadowAt(P: Node): Node {
  const U = getBsmUniforms();
  const rt = getCloudShadowMap();
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
