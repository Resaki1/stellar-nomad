import * as THREE from "three";
import { NodeMaterial } from "three/webgpu";
import {
  Fn,
  uniform,
  screenUV,
  screenCoordinate,
  vec2,
  vec3,
  vec4,
  float,
  normalize,
  dot,
  length,
} from "three/tsl";
import { marchCloudVolume } from "@/components/celestial/bodies/earthClouds";
import {
  getStbnTexture,
} from "@/components/celestial/bodies/stbnTexture";

// STBN slice modulus. Deliberately set to 63 (coprime with the 16-frame
// Bayer cycle) rather than the texture's actual 64 slices. The Bayer
// schedule makes each pixel "fresh" exactly once per 16 frames, so the
// effective number of distinct STBN slices a pixel sees across cycles
// is `STBN_FRAME_MODULUS / gcd(STBN_FRAME_MODULUS, 16)`:
//
//   modulus = 64 → gcd = 16 → 4 distinct slices per pixel
//   modulus = 63 → gcd = 1  → 63 distinct slices per pixel
//
// The 16× increase in distinct samples translates to ≈ 4× more variance
// reduction in the per-pixel temporal mean (sampling stddev = σ/√N).
// Using 63 means we skip slice 63 of the texture occasionally; the
// asymmetry is invisible because adjacent slice indices have similar
// blue-noise statistics.
const STBN_FRAME_MODULUS = 63;
import {
  setupCloudReconstructionPass,
  type CloudReconstructionPass,
} from "./cloudReconstructionPass";

// =============================================================================
// Phase D — Cloud pipeline (three-pass architecture)
//
// Pass 2a: SPARSE COLOR marcher.    Output W/4 × H/4 RGBA16F. Each sparse
//          texel corresponds to one 4×4 full-res tile, marched at the
//          current Bayer sub-pixel slot.
// Pass 2b: SPARSE DEPTH marcher.    Output W/4 × H/4 R16F. Same march, but
//          the fragment shader returns vec4(tFront, 0, 0, 1) so the
//          R-channel of the depth RT carries the cloud-front depth for
//          each tile. Identical ray (same Bayer offset, same STBN slice)
//          → tFront is for the SAME sample as the color RT's RGBA.
//          Burns 1× of marcher work (we run the full marcher twice and
//          throw away one output), but at 1/16 of the screen pixels this
//          is still well under what continuous-TAA at half-res cost.
// Pass 2c: FULL-RES RECONSTRUCTION  (cloudReconstructionPass.ts). Reads
//          both sparse RTs + previous frame's history. Fresh sub-pixels
//          copy the sparse sample directly; stale sub-pixels reproject
//          history through the tile's tFront with origin-shift correction,
//          then YCoCg variance-clamp against the 3×3 fresh neighbourhood.
//
// Composite (pass 3 in SpaceRenderer) reads the reconstruction RT and
// premul-alpha blends it onto the main scene RT.
//
// The pipeline replaces the previous single-pass continuous-TAA design.
// Motivation: continuous TAA blends ~14 frames of view-dependent radiance
// regardless of motion, producing velocity-proportional smear at high
// speed. Geometric reconstruction with variance clamp converges to a
// supersampled image on still cameras (16-frame cycle through the Bayer
// schedule) and degrades to per-pixel STBN noise (not smear) under
// extreme motion — bounded, single-frame, recoverable.
//
// Reference: Schneider 2015 (HZD Nubis), Karis 2014 (YCoCg clamp).
// =============================================================================

// -----------------------------------------------------------------------------
// DEBUG: short-circuit modes for the color pass. Visible inside the marched
// 1/16 fresh sub-pixels only; reconstruction will clamp the other pixels
// against the debug bounds.
// -----------------------------------------------------------------------------
type FullscreenDebug =
  | "off"
  | "solid"
  | "screenUV"
  | "rdEarth"
  | "slabHit"
  | "roEarthAlt";
const DEBUG_FULLSCREEN: FullscreenDebug = "off";

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------
export type CloudPipeline = {
  // Pass 2a: writes sparseCloudRt
  colorScene: THREE.Scene;
  colorCamera: THREE.OrthographicCamera;

  // Pass 2b: writes sparseDepthRt
  depthScene: THREE.Scene;
  depthCamera: THREE.OrthographicCamera;

  // Pass 2c: writes historyRt[current]
  reconstructionScene: THREE.Scene;
  reconstructionCamera: THREE.OrthographicCamera;

  /**
   * One updateUniforms call refreshes uniforms for all three passes. Call
   * once per frame, before rendering any of the three scenes.
   */
  updateUniforms: (params: {
    scaledCamera: THREE.PerspectiveCamera;
    earthMesh: THREE.Object3D;
    bayerSubPixel: THREE.Vector2;   // (0..3, 0..3) — Bayer schedule pick this frame
    prevViewProj: THREE.Matrix4;
    originShiftScaled: THREE.Vector3;
    sparseColorTexture: THREE.Texture; // input to reconstruction
    sparseDepthTexture: THREE.Texture; // input to reconstruction
    historyTexture: THREE.Texture;     // input to reconstruction (prev frame)
    historyValid: number;              // 0 / 1
    frameIndex: number;                // for STBN slice
    fullSize: THREE.Vector2;           // full-res screen pixels (DPR-adjusted)
    sparseSize: THREE.Vector2;         // sparse RT pixels (= fullSize / 4)
  }) => void;

  dispose: () => void;
};

let activePipeline: CloudPipeline | null = null;
let earthMatrixWorldRef: THREE.Object3D | null = null;

export function getActiveCloudPipeline(): CloudPipeline | null {
  if (!activePipeline || !earthMatrixWorldRef) return null;
  return activePipeline;
}

export function getEarthMatrixWorldRef(): THREE.Object3D | null {
  return earthMatrixWorldRef;
}

export function setEarthMatrixWorldSource(mesh: THREE.Object3D | null) {
  earthMatrixWorldRef = mesh;
}

export type SetupCloudPipelineOpts = {
  weatherMap: THREE.Texture;
  baseVolume: THREE.Data3DTexture;
  detailVolume: THREE.Data3DTexture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uInnerRadius: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uOuterRadius: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uCloudUvOffset: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uDensityMul: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uBaseScale: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uDetailScale: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uDetailErosion: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uColumnScale: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uLightConeRadius: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uVolumetricBlend: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSunRel: any;
};

// -----------------------------------------------------------------------------
// Shared uniforms — created once, referenced by all three pass materials.
// Mutating .value on one updates everywhere.
// -----------------------------------------------------------------------------
type SharedUniforms = ReturnType<typeof createSharedUniforms>;

function createSharedUniforms() {
  return {
    uCameraMatrixWorld: uniform(new THREE.Matrix4()),
    uCameraScaledPos: uniform(new THREE.Vector3()),
    uTanHalfFov: uniform(0),
    uAspect: uniform(1),
    uEarthInverseModel: uniform(new THREE.Matrix4()),
    // Bayer schedule: which sub-pixel slot (0..3, 0..3) is fresh this frame.
    uBayerSubPixel: uniform(new THREE.Vector2(0, 0)),
    // STBN slice for per-frame jitter (color + depth use the SAME slice so
    // their ray-origin offsets agree — depth.tFront and color.rgba thus
    // describe the same sample).
    uStbnFrameSlice: uniform(0),
    // Full-res screen pixel dimensions. Color & depth passes derive the
    // full-res UV for their fresh sub-pixel; reconstruction also needs
    // this to convert sparse-RT coords back to screen coords.
    uFullSize: uniform(new THREE.Vector2(1, 1)),
  };
}

// -----------------------------------------------------------------------------
// Helpers for the color/depth pass marcher entry: compute the full-res
// ray for THIS sparse pixel given the current Bayer offset.
// -----------------------------------------------------------------------------
function buildMarchRay(shared: SharedUniforms) {
  // We're rendering to a SPARSE RT of size W/4 × H/4. screenCoordinate gives
  // pixel coords in that sparse RT (range [0.5, sparseW-0.5] × [0.5, sparseH-0.5]).
  // To compute the full-res pixel each sparse texel represents this frame:
  //   sparseTileIndex = floor(screenCoordinate.xy)   (integer 0..sparseW-1)
  //   fullPixel = sparseTileIndex * 4 + bayerSubPixel + 0.5
  //   fullUv = fullPixel / fullSize
  const sparseTileX = screenCoordinate.x.floor();
  const sparseTileY = screenCoordinate.y.floor();
  const fullPixelX = sparseTileX.mul(float(4))
    .add(shared.uBayerSubPixel.x)
    .add(float(0.5));
  const fullPixelY = sparseTileY.mul(float(4))
    .add(shared.uBayerSubPixel.y)
    .add(float(0.5));
  const fullUvX = fullPixelX.div(shared.uFullSize.x);
  const fullUvY = fullPixelY.div(shared.uFullSize.y);

  // NDC from full-res UV. ndc.y = 1 - 2·uv.y because WebGPU RT origin
  // is at top-left (matches our screenUV convention everywhere else).
  const ndcX = fullUvX.mul(2).sub(1);
  const ndcY = float(1).sub(fullUvY.mul(2));

  // View-space ray direction (FOV-based, no projection inverse).
  const rdView = vec3(
    ndcX.mul(shared.uAspect).mul(shared.uTanHalfFov),
    ndcY.mul(shared.uTanHalfFov),
    float(-1),
  );
  const rdScaled = normalize(
    shared.uCameraMatrixWorld.mul(vec4(rdView, 0)).xyz,
  );
  const roEarth = shared.uEarthInverseModel
    .mul(vec4(shared.uCameraScaledPos, 1)).xyz;
  const rdEarth = normalize(
    shared.uEarthInverseModel.mul(vec4(rdScaled, 0)).xyz,
  );

  return { roEarth, rdEarth, rdScaled };
}

// -----------------------------------------------------------------------------
// Pass 2a: SPARSE COLOR marcher
// -----------------------------------------------------------------------------
function createColorPass(
  opts: SetupCloudPipelineOpts,
  shared: SharedUniforms,
  stbnTexture: THREE.Data3DTexture,
) {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const geo = new THREE.PlaneGeometry(2, 2);
  const mat = new NodeMaterial();

  // Replace contents of sparseCloudRt; reconstruction pass owns the blend.
  mat.transparent = false;
  mat.depthTest = false;
  mat.depthWrite = false;
  mat.blending = THREE.NoBlending;

  mat.fragmentNode = Fn(() => {
    // ── DEBUG short-circuits ──
    if (DEBUG_FULLSCREEN === "solid") {
      return vec4(1, 0, 0, 1);
    }
    if (DEBUG_FULLSCREEN === "screenUV") {
      return vec4(screenUV.x, float(1).sub(screenUV.y), float(0), float(1));
    }

    const { roEarth, rdEarth } = buildMarchRay(shared);
    const sunDirEarth = normalize(
      shared.uEarthInverseModel.mul(vec4(opts.uSunRel, 0)).xyz,
    );

    if (DEBUG_FULLSCREEN === "rdEarth") {
      return vec4(
        rdEarth.x.mul(0.5).add(0.5),
        rdEarth.y.mul(0.5).add(0.5),
        rdEarth.z.mul(0.5).add(0.5),
        float(1),
      );
    }
    if (DEBUG_FULLSCREEN === "roEarthAlt") {
      const len = length(roEarth).div(10).clamp(0, 1);
      return vec4(len, len, len, float(1));
    }
    if (DEBUG_FULLSCREEN === "slabHit") {
      const b = dot(roEarth, rdEarth);
      const d2 = dot(roEarth, roEarth);
      const cOuter = d2.sub(opts.uOuterRadius.mul(opts.uOuterRadius));
      const discOuter = b.mul(b).sub(cOuter);
      const hit = discOuter.greaterThan(0).select(float(1), float(0));
      return vec4(hit, hit, hit, float(1));
    }

    const { rgba } = marchCloudVolume({
      roEarth,
      rdEarth,
      sunDirEarth,
      weatherMap: opts.weatherMap,
      baseVolume: opts.baseVolume,
      detailVolume: opts.detailVolume,
      uInnerRadius: opts.uInnerRadius,
      uOuterRadius: opts.uOuterRadius,
      uCloudUvOffset: opts.uCloudUvOffset,
      uDensityMul: opts.uDensityMul,
      uBaseScale: opts.uBaseScale,
      uDetailScale: opts.uDetailScale,
      uDetailErosion: opts.uDetailErosion,
      uColumnScale: opts.uColumnScale,
      uLightConeRadius: opts.uLightConeRadius,
      uVolumetricBlend: opts.uVolumetricBlend,
      uStbn: stbnTexture,
      uStbnFrameSlice: shared.uStbnFrameSlice,
    });
    return rgba;
  })();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  scene.add(mesh);

  return { scene, camera, mat, geo, mesh };
}

// -----------------------------------------------------------------------------
// Pass 2b: SPARSE DEPTH marcher
// Runs the same marcher to extract `tFront` only. RGBA output is throw-away;
// only .r is consumed by the R16F depth RT.
//
// NOTE: this duplicates marcher work (color and depth both run a full
// marchCloudVolume). The TSL `Fn(...)()` wrapping that Loop/If requires is
// incompatible with MRT output (which would let one pass write both
// rgba and tFront), so we accept the 2× cost for now. At 1/16 screen pixels
// per pass, total marcher work = 2 × (1/16) = 1/8 of full-res continuous,
// still well below the pre-Phase-D cost.
// -----------------------------------------------------------------------------
function createDepthPass(
  opts: SetupCloudPipelineOpts,
  shared: SharedUniforms,
  stbnTexture: THREE.Data3DTexture,
) {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const geo = new THREE.PlaneGeometry(2, 2);
  const mat = new NodeMaterial();

  mat.transparent = false;
  mat.depthTest = false;
  mat.depthWrite = false;
  mat.blending = THREE.NoBlending;

  mat.fragmentNode = Fn(() => {
    const { roEarth, rdEarth } = buildMarchRay(shared);
    const sunDirEarth = normalize(
      shared.uEarthInverseModel.mul(vec4(opts.uSunRel, 0)).xyz,
    );

    const { tFront } = marchCloudVolume({
      roEarth,
      rdEarth,
      sunDirEarth,
      weatherMap: opts.weatherMap,
      baseVolume: opts.baseVolume,
      detailVolume: opts.detailVolume,
      uInnerRadius: opts.uInnerRadius,
      uOuterRadius: opts.uOuterRadius,
      uCloudUvOffset: opts.uCloudUvOffset,
      uDensityMul: opts.uDensityMul,
      uBaseScale: opts.uBaseScale,
      uDetailScale: opts.uDetailScale,
      uDetailErosion: opts.uDetailErosion,
      uColumnScale: opts.uColumnScale,
      uLightConeRadius: opts.uLightConeRadius,
      uVolumetricBlend: opts.uVolumetricBlend,
      uStbn: stbnTexture,
      uStbnFrameSlice: shared.uStbnFrameSlice,
    });
    return vec4(tFront, float(0), float(0), float(1));
  })();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  scene.add(mesh);

  return { scene, camera, mat, geo, mesh };
}

// -----------------------------------------------------------------------------
// Pipeline setup — builds color, depth, and reconstruction passes;
// returns the orchestrator with a single updateUniforms entry point.
// -----------------------------------------------------------------------------
export function setupCloudPipeline(
  opts: SetupCloudPipelineOpts,
): CloudPipeline {
  if (activePipeline) activePipeline.dispose();

  const shared = createSharedUniforms();
  const stbnTexture = getStbnTexture();

  const color = createColorPass(opts, shared, stbnTexture);
  const depth = createDepthPass(opts, shared, stbnTexture);
  const reconstruction = setupCloudReconstructionPass({
    uOuterRadius: opts.uOuterRadius,
  });

  // The reconstruction pass has its OWN copies of camera/earth uniforms
  // (it can't share `shared` directly because it lives in a different
  // module / TSL graph). updateUniforms below pushes the same values to
  // both. This duplication is intentional — keeps the two passes
  // independently testable and respects TSL's bind-group ownership.

  const updateUniforms: CloudPipeline["updateUniforms"] = (params) => {
    // Shared (color + depth)
    shared.uCameraMatrixWorld.value.copy(params.scaledCamera.matrixWorld);
    shared.uCameraScaledPos.value.copy(params.scaledCamera.position);
    shared.uTanHalfFov.value =
      Math.tan((params.scaledCamera.fov * Math.PI) / 180 / 2);
    shared.uAspect.value = params.scaledCamera.aspect;
    params.earthMesh.updateWorldMatrix(true, false);
    shared.uEarthInverseModel.value
      .copy(params.earthMesh.matrixWorld).invert();
    shared.uBayerSubPixel.value.copy(params.bayerSubPixel);
    // STBN slice = (frame % 63) / 63 — 63 chosen because gcd(63, 16) = 1
    // gives each pixel 63 distinct slices instead of just 4 (which the
    // naive `% 64` would give with the 16-frame Bayer cycle). See
    // STBN_FRAME_MODULUS comment at top of file.
    shared.uStbnFrameSlice.value =
      (params.frameIndex % STBN_FRAME_MODULUS) / STBN_FRAME_MODULUS;
    shared.uFullSize.value.copy(params.fullSize);

    // Reconstruction (everything the color/depth passes don't need)
    reconstruction.updateUniforms(
      params.scaledCamera,
      params.earthMesh,
      params.bayerSubPixel,
      params.prevViewProj,
      params.originShiftScaled,
      params.sparseColorTexture,
      params.sparseDepthTexture,
      params.historyTexture,
      params.historyValid,
      params.sparseSize,
    );
  };

  const dispose = () => {
    color.scene.remove(color.mesh);
    color.mat.dispose();
    color.geo.dispose();
    depth.scene.remove(depth.mesh);
    depth.mat.dispose();
    depth.geo.dispose();
    reconstruction.dispose();
    if (activePipeline === handle) activePipeline = null;
  };

  const handle: CloudPipeline = {
    colorScene: color.scene,
    colorCamera: color.camera,
    depthScene: depth.scene,
    depthCamera: depth.camera,
    reconstructionScene: reconstruction.scene,
    reconstructionCamera: reconstruction.camera,
    updateUniforms,
    dispose,
  };
  activePipeline = handle;
  return handle;
}

// -----------------------------------------------------------------------------
// Backwards-compat re-exports — let other modules keep importing the old
// names while we migrate consumers in a follow-up. Drop these in a cleanup
// pass once SpaceRenderer and earthClouds are updated.
// -----------------------------------------------------------------------------
export { CloudReconstructionPass };
