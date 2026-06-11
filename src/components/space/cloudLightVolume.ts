import * as THREE from "three";
import { Storage3DTexture } from "three/webgpu";
import {
  Fn,
  instanceIndex,
  uvec3,
  uint,
  textureStore,
  texture,
  texture3D,
  uniform,
  vec2,
  vec3,
  vec4,
  float,
  int,
  clamp,
  length,
  exp,
  atan,
  acos,
  fract,
  smoothstep,
  mix,
  normalize,
  PI,
} from "three/tsl";

// =============================================================================
// 3D cloud light volume — per-voxel sun transmittance (exp(-tau_sun)).
//
// A snap-stabilised, LOCAL-UP-ORIENTED box of voxels in earth model space,
// centred on the slab mid-shell under the camera (constant extent — see
// BOX_HALF). Each voxel runs a short straight sun-march (the marcher's cone
// inner loop, with the cone kernel removed) reusing the same cheap macro
// density the marcher uses: dilated base shape × coverage × height profile
// (anti-tiling warp included). The result exp(-tau) is stored in .r.
//
// The per-pixel marcher (earthClouds.ts, behind USE_LIGHT_VOLUME) then replaces
// its 6-tap cone with ONE trilinear texture3D fetch of this volume — turning a
// per-(pixel × dense-voxel) sun-march into a per-(volume-voxel) one baked once
// per frame and sampled with a single tap. Modern reference: Nubis³ light voxel
// grid / KSP-EVE Light Volume.
//
// Toggle-gated upstream: this module is only constructed when USE_LIGHT_VOLUME
// is true, so toggle=off never allocates the texture or builds the compute node.
//
// API notes (verified against three r183):
//  - Storage3DTexture must be rgba16float (RGBAFormat + HalfFloatType): the only
//    base-spec format that is BOTH storage-writable AND linear-filterable. The
//    scalar transmittance lives in .r; gba are padding. (r16float needs
//    texture-formats-tier1; r32float needs float32-filterable — both unsafe.)
//  - Written by a compute Fn via textureStore(vol, uvec3, vec4).toWriteOnly(),
//    dispatched with .compute(W*H*D) + renderer.compute() (synchronous). The
//    compute submit precedes pass-2a's draw submit on the same queue, so the
//    same-frame read in the marcher is ordered safe.
// =============================================================================

// ── Volume dimensions (constants baked into the dispatch count) ──
// 256×256 horizontal over the constant 1200 km box ≈ 4.7 km/voxel; 32 vertical
// over the ~74 km box height ≈ 2.3 km/voxel (the 13 km slab spans ~6 voxels).
// A sun-transmittance field is smoother than density (an integral along the sun
// dir), so it tolerates coarse sampling. rgba16f → 16.8 MB.
const NX = 256;
const NY = 32;
const NZ = 256;
const VOXEL_COUNT = NX * NY * NZ;

// ── Sun-march config (mirrors the cone in earthClouds.ts) ──
const LIGHT_STEP_SCALED = 0.002; // 2 km — MUST match earthClouds.ts LIGHT_STEP_SCALED
const SUN_STEPS = 7; // 7 × 2 km ≈ 14 km ≈ one slab crossing
const CONE_DENSITY = 1000; // decoupled from uDensityMul — matches the cone

// ── Box parameterization (scaled units; 1 unit = 1000 km) ──
// CONSTANT half-extent (2026-06-10). The box previously GREW with altitude
// (0.5 + alt × 2.5, capped 0.7), which made the voxel size — and therefore the
// position-snap grid derived from it — change CONTINUOUSLY while the camera
// climbed or descended. Every frame of vertical motion re-discretised the
// whole field → the "shadows constantly change while I fly" swimming (stable
// only with a perfectly still camera, exactly the reported symptom). With a
// constant extent the voxel grid is a fixed angular lattice on the shell: the
// box only ever moves in whole-voxel snaps (absorbed by the temporal EMA) and
// a pure vertical descent doesn't move it at all.
const BOX_HALF = 0.6; // 600 km half-width — covers the near field; the soft
//                       edge fade + per-pixel orbit fade handle everything
//                       beyond (unshadowed macro = correct at that distance).
const VOL_FADE_ALT_LO = 0.15; // ~150 km — box still covers near clouds
const VOL_FADE_ALT_HI = 0.4; //  ~400 km — volume fully faded out (orbit)
// Re-bake threshold for the sun direction (earth space). The transmittance
// field is STATIC in earth space for a fixed sun — the bake only needs to
// re-run when the box snaps to a new lattice cell or the sun has rotated
// (earth spin) by more than ~half the sun's angular diameter.
const SUN_REBAKE_COS = Math.cos((0.25 * Math.PI) / 180);
// Bake base-volume taps MUST sample LEVEL 0: three r183's WebGPU backend
// never uploads Data3DTexture.mipmaps (level 0 only) while allocating the
// full mip count — levels 1+ are zero-initialized, so the brief
// BAKE_BASE_LOD = 2/3 experiment (2026-06-11) baked shadows against a
// near-CONSTANT phantom density ((0+1)/(2−0) = 0.5). See the level-0 warning
// in earthClouds.ts + CLOUD_DEBUGGING_LESSONS case study #16.
const BAKE_BASE_LOD = 0;
// Inline mirror of earthClouds.ts WARP_AMPLITUDE (anti-tiling domain warp for
// the base-volume sample). Kept inline like cloudHeightProfileInline to avoid
// extending the earthClouds ↔ cloudFullscreenPass import cycle — keep in
// lockstep with the marcher or shadows drift off their clouds.
const WARP_AMPLITUDE_MIRROR = 0.01;

export type CloudLightVolumeDeps = {
  baseVolume: THREE.Data3DTexture;
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
  // Sun direction in SCALED world space (same uniform the cone derives from).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSunRel: any;
  // shared.uEarthInverseModel (scaled-world → earth model). SHARED object.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uEarthInverseModel: any;
};

export type CloudLightVolume = {
  lightVolTex: Storage3DTexture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uBoxCenter: any; // uniform(Vector3) — box centre, earth model space, scaled
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uBoxHalfExtent: any; // uniform(Vector3) — box half-extents (x,z tangent; y up)
  // ── Local-up box basis (earth space). The slab is a thin spherical shell, so
  // the thin box axis MUST follow local up (radial); X/Z span the tangent plane.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uBoxAxisX: any; // uniform(Vector3) — tangent
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uBoxAxisY: any; // uniform(Vector3) — local up (radial)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uBoxAxisZ: any; // uniform(Vector3) — tangent
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uVolumeWeight: any; // uniform(float) — orbit fade (1 near → 0 orbit)
  /** Recompute box uniforms from the current camera (scaled-world position). */
  updateBox: (cameraScaledPos: THREE.Vector3) => void;
  /** Dispatch the bake. SYNCHRONOUS; call before pass 2a renders. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  compute: (renderer: any) => void;
  dispose: () => void;
};

export function createCloudLightVolume(
  deps: CloudLightVolumeDeps,
): CloudLightVolume {
  const {
    baseVolume,
    weatherMap,
    uInnerRadius,
    uOuterRadius,
    uBaseScale,
    uColumnScale,
    uCloudUvOffset,
    uSunRel,
    uEarthInverseModel,
  } = deps;

  // ── Storage3DTexture: rgba16float, trilinear, clamp-to-edge ──
  const lightVolTex = new Storage3DTexture(NX, NY, NZ);
  lightVolTex.format = THREE.RGBAFormat; // REQUIRED — drives getFormat()
  lightVolTex.type = THREE.HalfFloatType; // RGBAFormat + HalfFloat ⇒ rgba16float
  lightVolTex.minFilter = THREE.LinearFilter;
  lightVolTex.magFilter = THREE.LinearFilter;
  lightVolTex.wrapS = THREE.ClampToEdgeWrapping;
  lightVolTex.wrapT = THREE.ClampToEdgeWrapping;
  lightVolTex.wrapR = THREE.ClampToEdgeWrapping;
  lightVolTex.generateMipmaps = false; // storage textures are single-mip

  // ── Box uniforms (CPU-updated each frame in updateBox) ──
  const uBoxCenter = uniform(new THREE.Vector3());
  const uBoxHalfExtent = uniform(new THREE.Vector3());
  // Local-up box basis (earth space): Y = radial up; X,Z = tangent plane. An
  // axis-aligned box would only contain the thin slab near the earth-frame pole
  // and cut it into a stripe elsewhere — so the box is oriented to local up.
  const uBoxAxisX = uniform(new THREE.Vector3(1, 0, 0));
  const uBoxAxisY = uniform(new THREE.Vector3(0, 1, 0));
  const uBoxAxisZ = uniform(new THREE.Vector3(0, 0, 1));
  const uVolumeWeight = uniform(0); // consumed marcher-side

  const Wc = uint(NX);
  const Hc = uint(NY);
  const invSlabThickness = float(1).div(uOuterRadius.sub(uInnerRadius));
  const invTwoPi = float(1).div(PI.mul(2));
  const invPi = float(1).div(PI);

  // Sun direction in EARTH MODEL space (same derivation as the marcher).
  const sunDirEarth = normalize(uEarthInverseModel.mul(vec4(uSunRel, 0)).xyz);

  // ── Cheap macro density at an arbitrary earth-space point q ──
  // Faithful to marchCloudVolume's primary chain, with the fine detail carve
  // OFF (the volume is a low-freq field). MUST track the marcher's density
  // composition — including the anti-tiling domain warp — or the baked
  // shadows land beside the clouds that should cast them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const densityAt = (q: any) => {
    const r = length(q).max(0.0001);
    const alt01 = clamp(r.sub(uInnerRadius).mul(invSlabThickness), 0, 1);
    const dir = q.div(r);

    // Coverage from the weather map at the column lat/lon — same pow(0.6)
    // shaping as the marcher.
    const u = fract(atan(dir.z, dir.x.negate()).mul(invTwoPi));
    const v = acos(clamp(dir.y.negate(), -1, 1)).mul(invPi);
    const uv = vec2(u, v).add(uCloudUvOffset);
    const coverageRaw = texture(weatherMap, uv).level(int(0)).r;
    const coverage = coverageRaw.pow(float(0.6));
    const cloudType = smoothstep(float(0.3), float(0.6), coverage);

    // Per-column top altitude + anti-tiling warp (matches the primary: the
    // tap's g/b/a channels become the 125 km-scale base-sample offset).
    const pColumn = dir.mul(uInnerRadius);
    const colTap = texture3D(baseVolume, pColumn.mul(uColumnScale))
      .level(int(0));
    const topAlt = float(0.45).add(
      smoothstep(float(0.3), float(0.7), colTap.r).mul(0.5),
    );
    const warpVec = vec3(
      colTap.g.sub(0.5),
      colTap.b.sub(0.5),
      colTap.a.sub(0.5),
    ).mul(float(WARP_AMPLITUDE_MIRROR));

    const profile = cloudHeightProfileInline(alt01, topAlt, cloudType);

    // Dilated base shape (matches the marcher's dilation, warped, sampled at
    // the bake mip — see BAKE_BASE_LOD). CARVE intentionally OFF.
    const bs = texture3D(baseVolume, q.add(warpVec).mul(uBaseScale))
      .level(int(BAKE_BASE_LOD));
    const fbm = bs.g.mul(0.625).add(bs.b.mul(0.25)).add(bs.a.mul(0.125));
    const baseShapeDilated = bs.r
      .add(float(1).sub(fbm))
      .div(float(2).sub(fbm).max(0.0001))
      .clamp(0, 1);

    return baseShapeDilated.mul(coverage).mul(profile).mul(float(CONE_DENSITY));
  };

  // ── Bake compute kernel: 1 invocation per voxel ──
  const populate = Fn(() => {
    const i = instanceIndex; // uint linear index over the W*H*D dispatch
    const x = i.mod(Wc); // x = i % NX
    const y = i.div(Wc).mod(Hc); // y = (i / NX) % NY
    const z = i.div(Wc.mul(Hc)); // z = i / (NX*NY)
    // Storage write coords MUST be uvec3 (unsigned). uvec3's TS typing only
    // declares a 1-arg conversion overload, but the 3-component form is valid
    // TSL at runtime (cf. the 2D uvec2(x,y) storage example) — cast past it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const coord = (uvec3 as any)(x, y, z);

    // voxel-centre normalized [0,1] → local [-1,1] → oriented box → earth space.
    const uvw = vec3(
      float(x).add(0.5).div(float(NX)),
      float(y).add(0.5).div(float(NY)),
      float(z).add(0.5).div(float(NZ)),
    );
    const local = uvw.mul(2).sub(1);
    const earthPos = uBoxCenter
      .add(uBoxAxisX.mul(local.x.mul(uBoxHalfExtent.x)))
      .add(uBoxAxisY.mul(local.y.mul(uBoxHalfExtent.y)))
      .add(uBoxAxisZ.mul(local.z.mul(uBoxHalfExtent.z)));

    // Straight sun-march (cone with kernel perturbation removed). Density taken
    // at qs = earthPos + sunDir*(s+0.5)*step — first sample half a step toward
    // the sun (matches the cone's offset → no self-occlusion bias at the voxel).
    const tau = float(0).toVar();
    for (let s = 0; s < SUN_STEPS; s++) {
      const stepDist = float(LIGHT_STEP_SCALED).mul(float(s + 0.5));
      const qs = earthPos.add(sunDirEarth.mul(stepDist));
      tau.addAssign(densityAt(qs).mul(float(LIGHT_STEP_SCALED)));
    }
    const T = exp(tau.negate()); // pure geometric transmittance; NO daylight

    textureStore(lightVolTex, coord, vec4(T, T, T, float(1))).toWriteOnly();
  });

  // Build the compute node ONCE — rebuilding each frame recompiles the pipeline
  // (the project's known WebGPU shader-compile stutter). Per-frame inputs flow
  // through the uniform() nodes above, mutated CPU-side in updateBox.
  const populateNode = populate().compute(VOXEL_COUNT);

  // ── Per-frame box update (CPU) ──
  const tmpEarthCam = new THREE.Vector3();
  const tmpUp = new THREE.Vector3();
  const tmpRef = new THREE.Vector3();
  const tmpAxX = new THREE.Vector3();
  const tmpAxZ = new THREE.Vector3();
  const tmpSunEarth = new THREE.Vector3();
  // Bake-dirty tracking: the field is static in earth space for a fixed box +
  // sun, so `compute` re-bakes ONLY when one of these changed since the last
  // bake. lastBakedUp doubles as the "ever baked" flag (0-length = never).
  const lastBakedUp = new THREE.Vector3();
  const lastBakedSun = new THREE.Vector3();
  const updateBox: CloudLightVolume["updateBox"] = (cameraScaledPos) => {
    // Earth-space camera position = uEarthInverseModel · cameraScaledPos (the
    // same product the marcher builds as roEarth — origin-slide invariant).
    tmpEarthCam.copy(cameraScaledPos).applyMatrix4(uEarthInverseModel.value);
    const rC = tmpEarthCam.length() || 1;
    const rIn = uInnerRadius.value;
    const rOut = uOuterRadius.value;
    const rMid = 0.5 * (rIn + rOut);

    const alt = rC - rIn; // scaled altitude

    // CONSTANT extents (see BOX_HALF) — the per-frame altitude-driven growth
    // was the swimming-shadows root cause (continuously changing voxel size =
    // continuous re-discretisation of the field under camera motion).
    const hxz = BOX_HALF;
    const sag = (hxz * hxz) / (2 * rIn); // shell drop over the footprint
    const hy = 0.5 * (rOut - rIn) + sag + 0.002; // slab half + sag + ~2 km pad
    uBoxHalfExtent.value.set(hxz, hy, hxz);

    // ── Stabilise against motion shimmer ──
    // The box's voxel grid would otherwise slide continuously with the camera,
    // so a static cloud point samples a continuously-shifting discretisation of
    // the (static) transmittance field → flickering shadows under the EMA
    // (worst in dark shadow, where exp(−τ) amplifies small changes). Snap the
    // camera's earth-space DIRECTION to a voxel-sized grid (double precision
    // here; the snapped centre stored as a float32 uniform is stable between
    // jumps) so the box steps in whole-voxel increments — the residual is a
    // small periodic jump the EMA absorbs, not continuous wobble. With the
    // constant extent the snap lattice itself is now fixed, so vertical
    // motion doesn't move the box at all.
    const voxelXZ = (2 * hxz) / NX;
    const sx = Math.round(tmpEarthCam.x / voxelXZ) * voxelXZ;
    const sy = Math.round(tmpEarthCam.y / voxelXZ) * voxelXZ;
    const sz = Math.round(tmpEarthCam.z / voxelXZ) * voxelXZ;
    const sLen = Math.hypot(sx, sy, sz) || 1;
    tmpUp.set(sx / sLen, sy / sLen, sz / sLen); // snapped local up (radial)

    // Centre on the slab mid-shell under the (snapped) camera direction.
    uBoxCenter.value.copy(tmpUp).multiplyScalar(rMid);

    // Orient the box to LOCAL UP (radial), NOT the earth axes: Y = up, X/Z span
    // the tangent plane. (Axis-aligning a thin box only contains the spherical
    // slab near the earth-frame pole and slices it into a stripe elsewhere.)
    // Build a stable tangent frame from a reference axis not parallel to up.
    // Everything below derives from the SNAPPED up, so the axes are piecewise
    // constant too.
    if (Math.abs(tmpUp.y) < 0.99) tmpRef.set(0, 1, 0);
    else tmpRef.set(1, 0, 0);
    tmpAxX.crossVectors(tmpRef, tmpUp).normalize();
    tmpAxZ.crossVectors(tmpUp, tmpAxX).normalize();
    uBoxAxisX.value.copy(tmpAxX);
    uBoxAxisY.value.copy(tmpUp);
    uBoxAxisZ.value.copy(tmpAxZ);

    // Orbit fade: 1 while the box meaningfully covers near clouds → 0 at orbit.
    const tFade =
      (alt - VOL_FADE_ALT_LO) / (VOL_FADE_ALT_HI - VOL_FADE_ALT_LO);
    const sc = Math.min(Math.max(tFade, 0), 1);
    uVolumeWeight.value = 1 - sc * sc * (3 - 2 * sc); // 1 - smoothstep
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const compute: CloudLightVolume["compute"] = (renderer: any) => {
    // Guard the first frame(s) before the WebGPU device is initialized.
    if (!renderer?.backend?.device) return;
    // Nothing reads the volume while it's fully faded out (the marcher mixes
    // toward "lit" with weight 0) — skip the bake entirely above the fade-out
    // altitude. The dirty tracking below re-bakes on the way back down.
    if (uVolumeWeight.value <= 0) return;
    // ── Bake amortisation ──
    // The baked field only depends on the (snapped) box and the earth-space
    // sun direction; both are piecewise constant. Re-bake only when the box
    // jumped to a new lattice cell or the sun rotated > ~0.25° (earth spin) —
    // a hovering camera pays ZERO bake cost, a moving one only pays on snap
    // boundaries.
    tmpSunEarth
      .copy(uSunRel.value)
      .transformDirection(uEarthInverseModel.value);
    const upUnchanged = lastBakedUp.equals(uBoxAxisY.value);
    const sunUnchanged =
      lastBakedSun.lengthSq() > 0 &&
      lastBakedSun.dot(tmpSunEarth) > SUN_REBAKE_COS;
    if (upUnchanged && sunUnchanged) return;
    renderer.compute(populateNode); // SYNCHRONOUS; submits its own command buffer
    lastBakedUp.copy(uBoxAxisY.value);
    lastBakedSun.copy(tmpSunEarth);
  };

  const dispose = () => {
    lightVolTex.dispose();
  };

  return {
    lightVolTex,
    uBoxCenter,
    uBoxHalfExtent,
    uBoxAxisX,
    uBoxAxisY,
    uBoxAxisZ,
    uVolumeWeight,
    updateBox,
    compute,
    dispose,
  };
}

// Inlined mirror of earthClouds.ts `cloudHeightProfile` with blur fixed to 0
// (the prebake doesn't band-limit the envelope). Kept inline to avoid extending
// the earthClouds ↔ cloudFullscreenPass import cycle. If the original profile
// changes, update this in lockstep.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cloudHeightProfileInline(alt01: any, topAlt: any, cloudType: any): any {
  const stratusBase = smoothstep(float(0.0), float(0.1), alt01);
  const stratusTop = float(1).sub(smoothstep(float(0.15), float(0.25), alt01));
  const stratus = stratusBase.mul(stratusTop);

  const scBase = smoothstep(float(0.0), float(0.25), alt01);
  const scTop = float(1).sub(smoothstep(float(0.45), float(0.65), alt01));
  const stratocumulus = scBase.mul(scTop);

  const cumBase = smoothstep(float(0.0), float(0.4), alt01);
  const fadeStart = topAlt.sub(float(0.35));
  const cumTop = float(1).sub(smoothstep(fadeStart, topAlt, alt01));
  const cumulus = cumBase.mul(cumTop);

  const lowerMix = mix(
    stratus,
    stratocumulus,
    smoothstep(float(0.0), float(0.5), cloudType),
  );
  return mix(lowerMix, cumulus, smoothstep(float(0.5), float(1.0), cloudType));
}
