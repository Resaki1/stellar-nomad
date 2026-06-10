import * as THREE from "three";
import { NodeMaterial } from "three/webgpu";
import {
  Fn,
  outputStruct,
  property,
  uniform,
  screenUV,
  screenCoordinate,
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

// STBN slice modulus. Deliberately 63 (coprime with the Bayer cycle length,
// SPARSE_DIVISOR²) rather than the texture's actual 64 slices. The Bayer
// schedule makes each pixel "fresh" once per cycle, so the number of distinct
// STBN slices a pixel sees over time is
// `STBN_FRAME_MODULUS / gcd(STBN_FRAME_MODULUS, cycleLen)`. 63 is coprime with
// both 16 (N=4) and 4 (N=2), so a pixel sees all 63 slices → maximal temporal
// variance reduction. Skipping slice 63 occasionally is invisible (adjacent
// slices have similar blue-noise statistics).
export const STBN_FRAME_MODULUS = 63;
import {
  setupCloudReconstructionPass,
  SPARSE_DIVISOR,
  type CloudReconstructionPass,
} from "./cloudReconstructionPass";

// =============================================================================
// Phase D — Cloud pipeline (two-pass architecture, MRT marcher)
//
// Pass 2a: SPARSE COLOR+DEPTH marcher (MRT). Output = one render target with
//          TWO color attachments, each W/SPARSE_DIVISOR × H/SPARSE_DIVISOR
//          (SPARSE_DIVISOR=2 → ¼-res). The fragment marches the volume ONCE
//          and emits `outputStruct(rgba, vec4(tFront,…))`:
//            attachment 0 = premultiplied cloud colour (RGBA16F)
//            attachment 1 = tFront cloud-front depth in .r (<0 = miss)
//          Each sparse texel corresponds to one SPARSE_DIVISOR² full-res tile,
//          marched at the current Bayer sub-pixel slot. Previously this was
//          TWO passes (a separate depth marcher re-ran the whole volume just
//          to extract tFront) — folding it into an MRT struct output removes a
//          full duplicate march per frame (~2× the marcher cost) with byte-
//          identical output (same ray, same STBN slice, same accumulation).
// Pass 2c: FULL-RES RECONSTRUCTION  (cloudReconstructionPass.ts). Reads the
//          two sparse attachments + previous frame's history. Reprojects
//          history through the tile's tFront with origin-shift correction,
//          then YCoCg variance-clamps against the 3×3 fresh neighbourhood and
//          EMA-blends.
//
// Composite (pass 3 in SpaceRenderer) reads the reconstruction RT and
// premul-alpha blends it onto the main scene RT.
//
// The pipeline replaces the previous single-pass continuous-TAA design.
// Motivation: continuous TAA blends ~14 frames of view-dependent radiance
// regardless of motion, producing velocity-proportional smear at high speed.
// Geometric reconstruction with variance clamp converges to a supersampled
// image on still cameras and degrades to per-pixel STBN noise (not smear)
// under extreme motion — bounded, single-frame, recoverable.
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
  // Pass 2a: marches ONCE, writes BOTH attachments of the sparse MRT RT
  // (texture[0] = color RGBA16F, texture[1] = tFront R16F).
  colorScene: THREE.Scene;
  colorCamera: THREE.OrthographicCamera;

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
  // We're rendering to a SPARSE RT of size W/N × H/N (N = SPARSE_DIVISOR).
  // screenCoordinate gives pixel coords in that sparse RT. To compute the
  // full-res pixel each sparse texel represents this frame:
  //   sparseTileIndex = floor(screenCoordinate.xy)   (integer 0..sparseW-1)
  //   fullPixel = sparseTileIndex * N + bayerSubPixel + 0.5
  //   fullUv = fullPixel / fullSize
  const sparseTileX = screenCoordinate.x.floor();
  const sparseTileY = screenCoordinate.y.floor();
  const fullPixelX = sparseTileX.mul(float(SPARSE_DIVISOR))
    .add(shared.uBayerSubPixel.x)
    .add(float(0.5));
  const fullPixelY = sparseTileY.mul(float(SPARSE_DIVISOR))
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

  // MRT output: attachment 0 = colour RGBA16F, attachment 1 = tFront (in .r).
  // The marcher computes BOTH in ONE pass, replacing the old separate depth
  // marcher (see setupCloudPipeline note).
  //
  // Pattern (canonical three.js MRT — cf. examples/jsm/tsl/display/
  // DepthOfFieldNode): the marcher runs via `colorNode` and writes its two
  // outputs into top-level `property()` vars; `material.outputNode =
  // outputStruct(...)` maps those vars positionally to the RT's two colour
  // attachments. Two pitfalls this avoids:
  //   1. `material.outputNode` is honoured ONLY when `fragmentNode` is null
  //      (NodeMaterial.js), so the compute goes through `colorNode`.
  //   2. Wrapping `outputStruct(...)` inside the Fn and returning it does NOT
  //      work — the OutputType struct fails to register (WGSL "struct member
  //      m0 not found"). The struct must be a top-level node.
  // The colorNode's own return value is discarded (the custom outputNode
  // replaces it); only its side-effect assigns to the property vars matter.
  const rgbaOut = property("vec4");
  const tFrontOut = property("float");

  mat.colorNode = Fn(() => {
    // ── DEBUG short-circuits ──
    if (DEBUG_FULLSCREEN === "solid") {
      rgbaOut.assign(vec4(1, 0, 0, 1));
      tFrontOut.assign(float(0));
      return vec4(0);
    }
    if (DEBUG_FULLSCREEN === "screenUV") {
      rgbaOut.assign(
        vec4(screenUV.x, float(1).sub(screenUV.y), float(0), float(1)),
      );
      tFrontOut.assign(float(0));
      return vec4(0);
    }

    const { roEarth, rdEarth } = buildMarchRay(shared);
    const sunDirEarth = normalize(
      shared.uEarthInverseModel.mul(vec4(opts.uSunRel, 0)).xyz,
    );

    if (DEBUG_FULLSCREEN === "rdEarth") {
      rgbaOut.assign(
        vec4(
          rdEarth.x.mul(0.5).add(0.5),
          rdEarth.y.mul(0.5).add(0.5),
          rdEarth.z.mul(0.5).add(0.5),
          float(1),
        ),
      );
      tFrontOut.assign(float(0));
      return vec4(0);
    }
    if (DEBUG_FULLSCREEN === "roEarthAlt") {
      const len = length(roEarth).div(10).clamp(0, 1);
      rgbaOut.assign(vec4(len, len, len, float(1)));
      tFrontOut.assign(float(0));
      return vec4(0);
    }
    if (DEBUG_FULLSCREEN === "slabHit") {
      const b = dot(roEarth, rdEarth);
      const d2 = dot(roEarth, roEarth);
      const cOuter = d2.sub(opts.uOuterRadius.mul(opts.uOuterRadius));
      const discOuter = b.mul(b).sub(cOuter);
      const hit = discOuter.greaterThan(0).select(float(1), float(0));
      rgbaOut.assign(vec4(hit, hit, hit, float(1)));
      tFrontOut.assign(float(0));
      return vec4(0);
    }

    const { rgba, tFront } = marchCloudVolume({
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
    rgbaOut.assign(rgba);
    tFrontOut.assign(tFront);
    return rgba;
  })();

  // m0 = premultiplied colour, m1.r = tFront (cloud-front depth; <0 = miss).
  mat.outputNode = outputStruct(
    rgbaOut,
    vec4(tFrontOut, float(0), float(0), float(1)),
  );

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  scene.add(mesh);

  return { scene, camera, mat, geo, mesh };
}

// -----------------------------------------------------------------------------
// Pipeline setup — builds the color (MRT) + reconstruction passes;
// returns the orchestrator with a single updateUniforms entry point.
// -----------------------------------------------------------------------------
export function setupCloudPipeline(
  opts: SetupCloudPipelineOpts,
): CloudPipeline {
  if (activePipeline) activePipeline.dispose();

  const shared = createSharedUniforms();
  const stbnTexture = getStbnTexture();

  const color = createColorPass(opts, shared, stbnTexture);
  const reconstruction = setupCloudReconstructionPass({
    uOuterRadius: opts.uOuterRadius,
  });

  // The reconstruction pass has its OWN copies of camera/earth uniforms
  // (it can't share `shared` directly because it lives in a different
  // module / TSL graph). updateUniforms below pushes the same values to
  // both. This duplication is intentional — keeps the two passes
  // independently testable and respects TSL's bind-group ownership.

  const updateUniforms: CloudPipeline["updateUniforms"] = (params) => {
    // Shared (color MRT pass)
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

    // Reconstruction (everything the color MRT pass doesn't need)
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
    reconstruction.dispose();
    if (activePipeline === handle) activePipeline = null;
  };

  const handle: CloudPipeline = {
    colorScene: color.scene,
    colorCamera: color.camera,
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
