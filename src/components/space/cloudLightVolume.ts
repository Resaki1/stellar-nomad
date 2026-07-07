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
import {
  detileBlend,
  USE_DETILE,
  baseDilate,
} from "@/components/celestial/bodies/cloudDetile";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

// =============================================================================
// 3D cloud light volume — per-voxel sun transmittance (exp(-tau_sun)).
//
// A SHELL-ALIGNED window of voxels on a WORLD-ANCHORED lattice in earth model
// space: voxel columns live on a per-region fixed tangent lattice (gnomonic
// projection through the region anchor frame — see REANCHOR_ANGLE) and the
// vertical axis is ALTITUDE (radius), not box-linear Y. Shell-Y (2026-06-12)
// means:
//  - every vertical voxel covers the actual cloud slab (~0.5 km/voxel over
//    the 13 km slab + pad) instead of a curvature/tilt-padded ~3 km — this
//    removed the visible piecewise-trilinear "shadow zone" banding (hard
//    horizontal borders at the same height on every cloud);
//  - the altitude lattice is GLOBALLY fixed (rMid/hy are runtime constants),
//    immune to anchor tilt, so containment is exact by construction — no
//    curvature sag or tilt pad;
//  - re-anchors only re-discretise the tangent (XZ) lattice.
// Window moves are whole-voxel steps along the region frame, so re-bakes
// reproduce identical values in the overlap (clipmap-style stability).
//
// Each voxel runs a short straight sun-march (the marcher's cone inner loop,
// with the cone kernel removed) reusing the same cheap macro density the
// marcher uses: dilated base shape × coverage × height profile (anti-tiling
// warp included). The result exp(-tau) is stored in .r.
//
// DUAL-VOLUME CROSSFADE (2026-06-12): re-anchoring (and sun rotation) still
// re-discretises the field — a discrete, globally visible pop, once per
// ~96 km of flight ("shadows suddenly change a few times" at 50-100 km/s).
// Fix: ping-pong between TWO volumes. A transition bakes the new
// frame/lighting into the INACTIVE side and ramps uMixA over ~XFADE frames
// while the old side stays frozen; the marcher samples both sides only while
// the fade is in flight. Modern reference: Nubis³ light voxel grid (world-
// fixed lattice, amortised update) / RTXGI scrolling volumes.
//
// The per-pixel marcher (earthClouds.ts, behind USE_LIGHT_VOLUME) replaces
// its 6-tap cone with ONE trilinear texture3D fetch of this volume (two
// during a crossfade) — turning a per-(pixel × dense-voxel) sun-march into a
// per-(volume-voxel) one baked once per change and sampled with a single tap.
//
// Toggle-gated upstream: this module is only constructed when USE_LIGHT_VOLUME
// is true, so toggle=off never allocates the textures or builds compute nodes.
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
// over the ~15 km altitude span (slab + ALT_PAD) ≈ 0.47 km/voxel — the slab
// spans ~28 voxels (was ~4.3 under the box-linear scheme; the coarse vertical
// trilinear was the "shadow zones" banding). A sun-transmittance field is
// smoother than density (an integral along the sun dir), so it tolerates the
// coarse HORIZONTAL sampling. rgba16f → 16.8 MB per side, ×2 sides.
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
// Altitude pad above/below the slab (shell-Y vertical half-extent =
// slab half-thickness + ALT_PAD). 1 km ≈ 2 voxels — keeps the trilinear
// footprint of in-slab samples off the clamp border. No tilt/sag terms: the
// altitude axis is exact regardless of anchor tilt.
const ALT_PAD = 0.001;
const VOL_FADE_ALT_LO = 0.15; // ~150 km — box still covers near clouds
const VOL_FADE_ALT_HI = 0.4; //  ~400 km — volume fully faded out (orbit)
// Re-bake threshold for the sun direction (earth space). The transmittance
// field is STATIC in earth space for a fixed sun — the bake only needs to
// re-run when the box snaps to a new lattice cell or the sun has rotated
// (earth spin) by more than ~half the sun's angular diameter. Sun rebakes go
// through the crossfade path, so the 0.25° step never pops.
const SUN_REBAKE_COS = Math.cos((0.25 * Math.PI) / 180);
// ── Region anchoring (the per-snap shadow-pop fix, 2026-06-12) ──
// The voxel lattice must be a deterministic function of EARTH space, not of
// the camera. The previous scheme snapped the camera POSITION to a voxel grid
// but then normalised it into a direction and re-derived the box centre AND
// the tangent axes from it — so every ~4.7 km snap slightly ROTATED the
// lattice and shifted it by a non-integer voxel amount. Each re-bake then
// sampled the (static) field at new world points → the whole shadow pattern
// visibly reshuffled once per voxel crossed ("shadows change ~1×/s at
// 4.7 km/s"). Fix: hold a persistent tangent frame (the region anchor) and
// snap the window centre to WHOLE VOXELS ALONG THAT FRAME, phase-anchored at
// the earth centre. Within a region the window only ever translates by
// integer voxel counts on a fixed lattice, so every re-bake reproduces
// identical values in the overlap (up to ~1 f32 ulp ≈ 0.5 m of sample-point
// re-rounding — nil vs km-scale voxels) and the window move is invisible.
// The anchor is re-seeded only once the camera direction drifts >
// REANCHOR_ANGLE from it (~96 km of flight); that re-discretisation is
// hidden by the dual-volume crossfade (see XFADE_STEP).
const REANCHOR_ANGLE = 0.015; // rad ≈ 0.86° ≈ 96 km of surface travel
const REANCHOR_COS = Math.cos(REANCHOR_ANGLE);
// Per-frame advance of the crossfade mix: full fade in ~17 frames
// (≈ 0.14 s at 120 fps / 0.28 s at 60). Short enough that back-to-back
// re-anchors (≥ 96 km apart, ≈ 1 s even at 100 km/s) never overlap; long
// enough that the lattice re-discretisation reads as a soft lighting morph,
// not a pop. If two transitions DO collide the in-flight fade is snapped
// (small residual pop, rare by construction).
const XFADE_STEP = 0.06;
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
// 2026-06-16: 0 to match WARP_AMPLITUDE=0 (warp-off path; see cloudDetile.ts
// USE_DETILE note). MUST equal earthClouds.ts WARP_AMPLITUDE.
const WARP_AMPLITUDE_MIRROR = 0;
// Inline mirror of earthClouds.ts TOPALT_LINEAR (Phase F falsification step 4,
// docs/CLOUD_TYPES_PLAN.md §3.6 — TEST-ONLY, default false). Same lockstep
// rule as WARP_AMPLITUDE_MIRROR: MUST equal earthClouds.ts TOPALT_LINEAR or
// the bake assumes tower tops the marcher no longer draws (shadows detach).
// Linear remap constants mirror earthClouds.ts topAltSpread (0.48 / 0.42).
const TOPALT_LINEAR_MIRROR = true;

export type CloudLightVolumeDeps = {
  baseVolume: THREE.Texture; // GPU-baked Storage3DTexture or CPU Data3DTexture
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
  // Ping-pong crossfade pair. The marcher blends A→B by uMixA (1 = pure A).
  lightVolTexA: Storage3DTexture;
  lightVolTexB: Storage3DTexture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uBoxCenterA: any; // uniform(Vector3) — side-A window centre, earth space
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uBoxCenterB: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uBoxHalfExtent: any; // shared: (x,z) tangent half-width; (y) altitude half-span
  // ── Per-side tangent frames (earth space). Y = the side's anchor up
  // (radial); X/Z span its tangent plane. Frozen per region.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uBoxAxisXA: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uBoxAxisYA: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uBoxAxisZA: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uBoxAxisXB: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uBoxAxisYB: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uBoxAxisZB: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uMixA: any; // uniform(float) — crossfade weight of side A (1 = pure A)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uVolumeWeight: any; // uniform(float) — orbit fade (1 near → 0 orbit)
  /** Recompute window/frame uniforms + crossfade from the current camera. */
  updateBox: (cameraScaledPos: THREE.Vector3) => void;
  /** Dispatch any pending bake. SYNCHRONOUS; call before pass 2a renders. */
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

  // ── Storage3DTextures: rgba16float, trilinear, clamp-to-edge ──
  const makeVolTex = () => {
    const tex = new Storage3DTexture(NX, NY, NZ);
    tex.format = THREE.RGBAFormat; // REQUIRED — drives getFormat()
    tex.type = THREE.HalfFloatType; // RGBAFormat + HalfFloat ⇒ rgba16float
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.wrapR = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false; // storage textures are single-mip
    return tex;
  };
  const lightVolTexA = makeVolTex();
  const lightVolTexB = makeVolTex();

  // ── Uniforms (CPU-updated in updateBox) ──
  const uBoxHalfExtent = uniform(new THREE.Vector3()); // shared by both sides
  const uMixA = uniform(1); // 1 = pure side A
  const uVolumeWeight = uniform(0); // consumed marcher-side
  const uBoxCenterA = uniform(new THREE.Vector3());
  const uBoxCenterB = uniform(new THREE.Vector3());
  const uBoxAxisXA = uniform(new THREE.Vector3(1, 0, 0));
  const uBoxAxisYA = uniform(new THREE.Vector3(0, 1, 0));
  const uBoxAxisZA = uniform(new THREE.Vector3(0, 0, 1));
  const uBoxAxisXB = uniform(new THREE.Vector3(1, 0, 0));
  const uBoxAxisYB = uniform(new THREE.Vector3(0, 1, 0));
  const uBoxAxisZB = uniform(new THREE.Vector3(0, 0, 1));

  const Wc = uint(NX);
  const Hc = uint(NY);
  const invSlabThickness = float(1).div(uOuterRadius.sub(uInnerRadius));
  const invTwoPi = float(1).div(PI.mul(2));
  const invPi = float(1).div(PI);
  // Mid-shell radius — the altitude lattice's centre (runtime-constant).
  const rMidShell = uInnerRadius.add(uOuterRadius).mul(0.5);

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
    const coverageRaw = (texture(weatherMap, uv).level(int(0)) as Node).r;
    const coverage = coverageRaw.pow(float(0.6));
    const cloudType = smoothstep(float(0.3), float(0.6), coverage);

    // Per-column top altitude + anti-tiling warp (matches the primary: the
    // tap's g/b/a channels become the 125 km-scale base-sample offset).
    const pColumn = dir.mul(uInnerRadius);
    const colTap = texture3D(baseVolume, pColumn.mul(uColumnScale)).level(
      int(0),
    ) as Node;
    // Couple tower span to coverage — LOCKSTEP with earthClouds.ts topAlt
    // (topAltSpread incl. the TOPALT_LINEAR Phase-F toggle).
    const covSpan = smoothstep(float(0.35), float(0.7), coverage);
    const colSpread = TOPALT_LINEAR_MIRROR
      ? colTap.r.sub(float(0.48)).div(float(0.42)).clamp(0, 1)
      : smoothstep(float(0.3), float(0.7), colTap.r);
    const topAlt = float(0.45).add(colSpread.mul(0.5).mul(covSpan));
    const profile = cloudHeightProfileInline(alt01, topAlt, cloudType);

    // Dilated base shape — MUST match the marcher's anti-tiling (detile or
    // warp) AND dilation, or the baked shadows land beside the clouds that
    // cast them. Sampled at the bake mip (BAKE_BASE_LOD); CARVE intentionally
    // OFF (this volume is a low-freq field).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let baseShapeDilated: any;
    if (USE_DETILE) {
      // Tile-&-offset — SAME offsets as earthClouds.ts (shared cloudDetile.ts),
      // keyed on the same Earth-space scaled position, so shadows register.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dilatedAt = (pos: any) => {
        const b = texture3D(baseVolume, pos.mul(uBaseScale)).level(
          int(BAKE_BASE_LOD),
        ) as Node;
        const f = b.g.mul(0.625).add(b.b.mul(0.25)).add(b.a.mul(0.125));
        return baseDilate(b.r, f);
      };
      baseShapeDilated = detileBlend(q, dilatedAt);
    } else {
      // Original anti-tiling domain warp.
      const warpVec = vec3(
        colTap.g.sub(0.5),
        colTap.b.sub(0.5),
        colTap.a.sub(0.5),
      ).mul(float(WARP_AMPLITUDE_MIRROR));
      const bs = texture3D(baseVolume, q.add(warpVec).mul(uBaseScale)).level(
        int(BAKE_BASE_LOD),
      ) as Node;
      const fbm = bs.g.mul(0.625).add(bs.b.mul(0.25)).add(bs.a.mul(0.125));
      // Dilated base — LOCKSTEP with the marcher (shared baseDilate).
      baseShapeDilated = baseDilate(bs.r, fbm);
    }

    return baseShapeDilated.mul(coverage).mul(profile).mul(float(CONE_DENSITY));
  };

  // ── Bake compute kernel factory: 1 invocation per voxel, per side ──
  // Two structurally identical kernels, each bound to its side's texture +
  // frame uniforms (textures/uniforms can't be swapped on a built node
  // without a pipeline rebuild — the project's known compile-stutter).
  const buildPopulateNode = (
    tex: Storage3DTexture,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    uCenter: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    uAxX: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    uAxZ: any,
  ) => {
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

      // voxel-centre normalized [0,1] → local [-1,1] → SHELL coordinates.
      const uvw = vec3(
        float(x).add(0.5).div(float(NX)),
        float(y).add(0.5).div(float(NY)),
        float(z).add(0.5).div(float(NZ)),
      );
      const local = uvw.mul(2).sub(1);
      // ── Shell-Y voxel → earth space ──
      // Column: a point on the region's tangent-plane lattice (at radius
      // rMid along the anchor up — dot(centre, up) = rMid by construction),
      // projected onto the sphere through normalize. Altitude: rMid +
      // local.y · halfSpan — a GLOBALLY fixed altitude lattice (rMid and
      // halfExtent.y are runtime constants), exact containment, no tilt pad.
      // The marcher's inline inverse (sideShadow in earthClouds.ts) is exact:
      // cp = p·(rMid/dot(p, axisY)) reconstructs this column point
      // algebraically (verified 2026-06-12).
      const cp = uCenter
        .add(uAxX.mul(local.x.mul(uBoxHalfExtent.x)))
        .add(uAxZ.mul(local.z.mul(uBoxHalfExtent.z)));
      const dCol = normalize(cp);
      const rPos = rMidShell.add(local.y.mul(uBoxHalfExtent.y));
      const earthPos = dCol.mul(rPos);

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

      textureStore(tex, coord, vec4(T, T, T, float(1))).toWriteOnly();
    });
    // Build the compute node ONCE — rebuilding each frame recompiles the
    // pipeline. Per-frame inputs flow through the uniform() nodes, mutated
    // CPU-side in updateBox.
    return populate().compute(VOXEL_COUNT);
  };

  // ── Per-side CPU state ──
  type Side = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    node: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    center: any; // uniform(Vector3)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    axX: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    axY: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    axZ: any;
    lastBakedCenter: THREE.Vector3;
    lastBakedSun: THREE.Vector3;
    bakeQueued: boolean;
  };
  const sides: [Side, Side] = [
    {
      node: buildPopulateNode(lightVolTexA, uBoxCenterA, uBoxAxisXA, uBoxAxisZA),
      center: uBoxCenterA,
      axX: uBoxAxisXA,
      axY: uBoxAxisYA,
      axZ: uBoxAxisZA,
      lastBakedCenter: new THREE.Vector3(),
      lastBakedSun: new THREE.Vector3(),
      bakeQueued: true, // first-ever bake (deferred until uVolumeWeight > 0)
    },
    {
      node: buildPopulateNode(lightVolTexB, uBoxCenterB, uBoxAxisXB, uBoxAxisZB),
      center: uBoxCenterB,
      axX: uBoxAxisXB,
      axY: uBoxAxisYB,
      axZ: uBoxAxisZB,
      lastBakedCenter: new THREE.Vector3(),
      lastBakedSun: new THREE.Vector3(),
      bakeQueued: false,
    },
  ];
  let activeSide = 0; // index into `sides`; the side new bakes target
  let mixA = 1; // CPU shadow of uMixA
  let warmedInactive = false; // inactive-side pipeline pre-compile (see compute)

  // ── Per-frame box update (CPU) ──
  const tmpEarthCam = new THREE.Vector3();
  const tmpUp = new THREE.Vector3();
  const tmpRef = new THREE.Vector3();
  const tmpMid = new THREE.Vector3();
  const tmpSunEarth = new THREE.Vector3();
  // Region anchor: a persistent tangent frame, re-seeded only after the
  // camera direction drifts > REANCHOR_ANGLE (see the constant's comment).
  // anchorUp.lengthSq() === 0 ⇒ not yet seeded.
  const anchorUp = new THREE.Vector3();
  const anchorAxX = new THREE.Vector3();
  const anchorAxZ = new THREE.Vector3();

  // Begin a crossfade: finish any in-flight fade instantly (rare collision),
  // flip the active side, stamp the current anchor frame into it and queue
  // its bake. The old side keeps its frozen frame + content as fade source.
  const startTransition = () => {
    mixA = activeSide === 0 ? 1 : 0;
    activeSide = 1 - activeSide;
    const s = sides[activeSide];
    s.axX.value.copy(anchorAxX);
    s.axY.value.copy(anchorUp);
    s.axZ.value.copy(anchorAxZ);
    s.bakeQueued = true;
  };

  const updateBox: CloudLightVolume["updateBox"] = (cameraScaledPos) => {
    // Earth-space camera position = uEarthInverseModel · cameraScaledPos (the
    // same product the marcher builds as roEarth — origin-slide invariant).
    tmpEarthCam.copy(cameraScaledPos).applyMatrix4(uEarthInverseModel.value);
    const rC = tmpEarthCam.length() || 1;
    const rIn = uInnerRadius.value;
    const rOut = uOuterRadius.value;
    const rMid = 0.5 * (rIn + rOut);

    const alt = rC - rIn; // scaled altitude

    // CONSTANT extents — voxel size must never change at runtime or the
    // world lattice below stops being a lattice (rIn/rOut are static).
    // Shell-Y: y half-extent = slab half-thickness + ALT_PAD, exact
    // containment at any anchor tilt (altitude is tilt-independent).
    const hxz = BOX_HALF;
    const voxelXZ = (2 * hxz) / NX;
    const hy = 0.5 * (rOut - rIn) + ALT_PAD;
    uBoxHalfExtent.value.set(hxz, hy, hxz);

    // Orbit fade: 1 while the box meaningfully covers near clouds → 0 at
    // orbit. Computed BEFORE the transition logic — sun-rebake transitions
    // are suppressed while nothing reads the volume.
    const tFade =
      (alt - VOL_FADE_ALT_LO) / (VOL_FADE_ALT_HI - VOL_FADE_ALT_LO);
    const sc = Math.min(Math.max(tFade, 0), 1);
    uVolumeWeight.value = 1 - sc * sc * (3 - 2 * sc); // 1 - smoothstep

    // ── Region anchor (see REANCHOR_ANGLE) ──
    // The window must be oriented to LOCAL UP (radial) — its tangent lattice
    // degenerates far from the anchor column. Local up changes continuously
    // with the camera, so the frame is held FIXED per region and re-seeded
    // from the exact camera direction only after REANCHOR_ANGLE of drift.
    // Re-seeding is self-hysteretic: after a seed the drift is zero, so the
    // next one needs the full angle again.
    tmpUp.copy(tmpEarthCam).divideScalar(rC); // exact local up (radial)
    const seeded = anchorUp.lengthSq() > 0;
    if (!seeded || anchorUp.dot(tmpUp) < REANCHOR_COS) {
      anchorUp.copy(tmpUp);
      if (Math.abs(anchorUp.y) < 0.99) tmpRef.set(0, 1, 0);
      else tmpRef.set(1, 0, 0);
      anchorAxX.crossVectors(tmpRef, anchorUp).normalize();
      anchorAxZ.crossVectors(anchorUp, anchorAxX).normalize();
      if (!seeded) {
        // First seed: no fade source exists — stamp the active side directly.
        const s = sides[activeSide];
        s.axX.value.copy(anchorAxX);
        s.axY.value.copy(anchorUp);
        s.axZ.value.copy(anchorAxZ);
        s.bakeQueued = true;
      } else {
        startTransition(); // re-anchor → crossfaded re-discretisation
      }
    } else if (uVolumeWeight.value > 0) {
      // Sun rotated past the rebake threshold (earth spin, ~1 min of real
      // time per 0.25°)? Same frame, new lighting — crossfade it too.
      // Only while the volume is visible: at weight 0 the check would loop
      // (compute() skips, lastBakedSun never refreshes).
      tmpSunEarth
        .copy(uSunRel.value)
        .transformDirection(uEarthInverseModel.value);
      const sAct = sides[activeSide];
      if (
        !sAct.bakeQueued &&
        sAct.lastBakedSun.lengthSq() > 0 &&
        sAct.lastBakedSun.dot(tmpSunEarth) < SUN_REBAKE_COS
      ) {
        startTransition();
      }
    }

    // ── World-anchored lattice snap (active side only; the inactive side
    // is a frozen crossfade source) ──
    // Window target = mid-shell under the camera. Snap its tangent
    // coordinates ALONG THE ANCHOR AXES to whole voxels, phase anchored at
    // the earth centre (coordinate 0); the radial coordinate is EXACTLY
    // rMid (runtime-constant — no vertical snap exists in shell-Y). All
    // voxel world positions are then deterministic functions of the region
    // frame + integer lattice indices ⇒ points of one fixed earth-space
    // lattice, regardless of how the window has moved — so re-bakes
    // reproduce identical values in the overlap (f64 snap here; the
    // kernel's f32 sum re-rounds by ≤ ~1 ulp ≈ 0.5 m — nil vs km voxels).
    // "Identical" is exact for POSITIONS; values additionally absorb the
    // sub-threshold sun drift (< 0.25°) accumulated since the last bake —
    // ≤ ~60 m of shadow shift over the 14 km sun march, sub-voxel.
    tmpMid.copy(tmpUp).multiplyScalar(rMid);
    const cx = Math.round(tmpMid.dot(anchorAxX) / voxelXZ) * voxelXZ;
    const cz = Math.round(tmpMid.dot(anchorAxZ) / voxelXZ) * voxelXZ;
    const sAct = sides[activeSide];
    sAct.center.value
      .set(0, 0, 0)
      .addScaledVector(anchorAxX, cx)
      .addScaledVector(anchorUp, rMid)
      .addScaledVector(anchorAxZ, cz);

    // ── Crossfade ramp toward the active side ──
    // At weight 0 nothing reads the volume — SNAP instead of ramping, so a
    // fade can never still be in flight when the volume fades back in. (A
    // re-anchor at orbit would otherwise leave the frozen side — stale, or
    // never baked at all (zero-init storage reads T = 0 = full shadow) — at
    // up to ~0.94 mix weight during a fast descent across the fade-in
    // boundary. 2026-06-12 adversarial-verification finding.)
    const target = activeSide === 0 ? 1 : 0;
    if (uVolumeWeight.value <= 0) {
      mixA = target;
    } else {
      const d = target - mixA;
      mixA += Math.max(-XFADE_STEP, Math.min(XFADE_STEP, d));
    }
    uMixA.value = mixA;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const compute: CloudLightVolume["compute"] = (renderer: any) => {
    // Guard the first frame(s) before the WebGPU device is initialized.
    if (!renderer?.backend?.device) return;
    // Nothing reads the volume while it's fully faded out (the marcher mixes
    // toward "lit" with weight 0) — skip the bake entirely above the fade-out
    // altitude. bakeQueued / centre-dirty tracking re-bakes on the way down.
    if (uVolumeWeight.value <= 0) return;
    // ── Bake amortisation ──
    // Only the ACTIVE side ever re-bakes (the inactive side is a frozen
    // crossfade source). Re-bake when a transition queued one (re-anchor /
    // sun step / first-ever) or the window stepped to a new lattice cell —
    // a hovering camera pays ZERO bake cost. Within a region a re-bake
    // reproduces identical values in the overlap (world-anchored lattice),
    // so the step itself is invisible.
    const s = sides[activeSide];
    const dirty = s.bakeQueued || !s.lastBakedCenter.equals(s.center.value);
    if (!dirty) return;
    renderer.compute(s.node); // SYNCHRONOUS; submits its own command buffer
    s.bakeQueued = false;
    s.lastBakedCenter.copy(s.center.value);
    s.lastBakedSun
      .copy(uSunRel.value)
      .transformDirection(uEarthInverseModel.value);
    if (!warmedInactive) {
      // Pre-compile the OTHER side's pipeline alongside the first real bake.
      // WebGPU creates a compute pipeline at the first dispatch of a node —
      // deferring side B's to the first crossfade would pay the project's
      // known shader-compile stutter at exactly the pop the fade exists to
      // hide. Content is garbage (default uniforms) but unread at steady
      // mix; the side is re-baked when a transition flips it in.
      warmedInactive = true;
      renderer.compute(sides[1 - activeSide].node);
    }
  };

  const dispose = () => {
    lightVolTexA.dispose();
    lightVolTexB.dispose();
  };

  return {
    lightVolTexA,
    lightVolTexB,
    uBoxCenterA,
    uBoxCenterB,
    uBoxHalfExtent,
    uBoxAxisXA,
    uBoxAxisYA,
    uBoxAxisZA,
    uBoxAxisXB,
    uBoxAxisYB,
    uBoxAxisZB,
    uMixA,
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

  // Flat condensation base (anatomy 2026-06-16) — MUST match earthClouds.ts
  // cloudHeightProfile cumBase or the baked shadows detach from the clouds.
  const cumBase = smoothstep(float(0.04), float(0.16), alt01);
  const fadeStart = topAlt.sub(float(0.35));
  // Parabolic billow top-fade — LOCKSTEP with earthClouds.ts cloudHeightProfile.
  const fadeX = clamp(
    alt01.sub(fadeStart).div(topAlt.sub(fadeStart).max(0.0001)),
    0,
    1,
  );
  const cumTop = float(1).sub(fadeX.mul(fadeX));
  const cumulus = cumBase.mul(cumTop);

  const lowerMix = mix(
    stratus,
    stratocumulus,
    smoothstep(float(0.0), float(0.5), cloudType),
  );
  return mix(lowerMix, cumulus, smoothstep(float(0.5), float(1.0), cloudType));
}
