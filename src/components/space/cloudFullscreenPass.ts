import * as THREE from "three";
import { NodeMaterial } from "three/webgpu";
import {
  Fn,
  uniform,
  screenUV,
  vec2,
  vec3,
  vec4,
  float,
  normalize,
  dot,
  length,
  mix,
  texture,
  sqrt,
  smoothstep,
  max as tslMax,
} from "three/tsl";
import { marchCloudVolume } from "@/components/celestial/bodies/earthClouds";

// =============================================================================
// FULLSCREEN-PASS DIAGNOSTICS
//
// Set DEBUG_FULLSCREEN to anything other than 'off' to short-circuit the
// fragment shader before marchCloudVolume. Each mode forces α=1 (output
// REPLACES Earth in the composite) so the diagnostic is unambiguous.
//
//   'off'         : normal volumetric march
//   'solid'       : every pixel = red, half-alpha. Confirms quad renders at
//                   all and the composite blends correctly. If you see no
//                   red tint over Earth, the quad isn't being drawn into
//                   cloudRt — pass-2 plumbing or scene/camera setup issue.
//   'screenUV'    : (R, G, 0, 1) = (screenUV.x, screenUV.y_flipped, 0, 1).
//                   Should be black at top-left, red at top-right, green at
//                   bottom-left, yellow at bottom-right. Confirms screenUV
//                   semantics + y-flip orientation.
//   'rdEarth'     : visualises Earth-local view direction as colour
//                   ((rdEarth+1)*0.5 → R/G/B). For a camera looking roughly
//                   towards Earth, the centre pixels point at Earth → all
//                   three channels mid-grey, gradients out to the corners.
//                   If you see a constant flat colour, ray reconstruction
//                   is broken (likely uInvViewProj or camera matrix).
//   'slabHit'     : white where the ray analytically intersects the cloud
//                   slab outer shell, black otherwise. Should match the
//                   visible Earth disk silhouette + a small atmosphere halo.
//                   If black everywhere → ray geometry is wrong; if pure
//                   white everywhere → roEarth is at origin (uEarthInverseModel
//                   broken).
//   'roEarthAlt'  : roEarth length normalised over 10 scaled units (10 000 km).
//                   For a camera at LEO altitude ≈ 6.4 scaled units, this
//                   should be ~0.64 grey across the full quad. If 0 (black)
//                   the camera-position uniform is zero.
// =============================================================================
type FullscreenDebug =
  | "off"
  | "solid"
  | "screenUV"
  | "rdEarth"
  | "slabHit"
  | "roEarthAlt";
const DEBUG_FULLSCREEN: FullscreenDebug = "off";

export type FullscreenCloudPass = {
  cloudScene: THREE.Scene;
  cloudCamera: THREE.OrthographicCamera;
  /**
   * Recompute the per-frame uniforms (camera matrices + Earth world inverse
   * + sub-pixel jitter + previous-frame view-projection + history texture).
   * Call once per frame, before `gl.render(cloudScene, cloudCamera)`.
   *
   * - `earthMesh`: Object3D parented to Earth's rotation group; supplies
   *   the world transform that drives `uEarthInverseModel`.
   * - `jitterUv`: Halton(2,3) sub-pixel offset in UV space (pixel-fraction
   *   / RT pixel dim).
   * - `prevViewProj`: scaled-camera VP snapshotted at the end of the
   *   previous frame.
   * - `historyTexture`: the off-parity cloud RT's colour attachment. The
   *   shader reprojects to it and exponentially blends.
   * - `historyValid`: 0 = ignore history (first frame, post-rebase, after
   *   resize); 1 = blend at full weight.
   */
  updateUniforms: (
    scaledCamera: THREE.PerspectiveCamera,
    earthMesh: THREE.Object3D,
    jitterUv: THREE.Vector2,
    prevViewProj: THREE.Matrix4,
    historyTexture: THREE.Texture,
    historyValid: number,
  ) => void;
  dispose: () => void;
};

// Module singletons. The cloud system is Earth-only for now; one active pass
// is sufficient. SpaceRenderer reads these via getActiveFullscreenCloudPass()
// each frame.
let activePass: FullscreenCloudPass | null = null;
let earthMatrixWorldRef: THREE.Object3D | null = null;

export function getActiveFullscreenCloudPass(): FullscreenCloudPass | null {
  if (!activePass || !earthMatrixWorldRef) return null;
  return activePass;
}

export function getEarthMatrixWorldRef(): THREE.Object3D | null {
  return earthMatrixWorldRef;
}

export function setEarthMatrixWorldSource(mesh: THREE.Object3D | null) {
  earthMatrixWorldRef = mesh;
}

export type SetupFullscreenCloudPassOpts = {
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
  // Sun direction in scaled-world frame (Vec3 uniform). Transformed to
  // Earth-local via uEarthInverseModel inside the fragment shader, matching
  // the shell wrapper's modelWorldMatrixInverse·uSunRel logic.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSunRel: any;
};

export function setupFullscreenCloudPass(
  opts: SetupFullscreenCloudPassOpts,
): FullscreenCloudPass {
  if (activePass) activePass.dispose();

  const cloudScene = new THREE.Scene();
  // Z range [0, 1] matches WebGPU NDC; the fullscreen plane sits at z = 0
  // (between the ortho near=0 and far=1 planes) and is never frustum-culled.
  const cloudCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const geo = new THREE.PlaneGeometry(2, 2);
  const mat = new NodeMaterial();

  // Premul-alpha output, identical pipeline to the shell version — bilinear
  // upsample on the cloudRt during the composite pass interpolates colour
  // and alpha together, no fringing at transparency edges.
  mat.transparent = true;
  mat.depthTest = false;
  mat.depthWrite = false;
  mat.blending = THREE.CustomBlending;
  mat.blendSrc = THREE.OneFactor;
  mat.blendDst = THREE.OneMinusSrcAlphaFactor;
  mat.blendSrcAlpha = THREE.OneFactor;
  mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;

  // Per-frame uniforms.
  //
  // FOV-based ray reconstruction (avoids projectionMatrix.invert(), which
  // loses precision in float32 with our extreme far/near ratio of ~2 × 10⁹):
  //   ndcXY → rdView = vec3(ndcXY.x · aspect · tanHalfFov,
  //                         ndcXY.y · tanHalfFov,
  //                         −1)
  //   rdWorld = normalize((cameraMatrixWorld · vec4(rdView, 0)).xyz)
  // No matrix inversion involved → numerically stable.
  const uCameraMatrixWorld = uniform(new THREE.Matrix4());
  const uCameraScaledPos = uniform(new THREE.Vector3());
  const uTanHalfFov = uniform(0);
  const uAspect = uniform(1);
  const uEarthInverseModel = uniform(new THREE.Matrix4());
  // Phase D2: sub-pixel ray-origin jitter in UV space (Halton(2,3) offset
  // divided by RT pixel dims, advanced once per frame by the caller). Alone
  // this only adds per-frame shimmer at cloud edges; the value is to seed a
  // different sample location each frame so the D6 history blend converges
  // on a supersampled image.
  const uJitterUv = uniform(new THREE.Vector2());
  // Phase D3: previous-frame combined view-projection matrix (scaled-world
  // space). D6 uses it to project this frame's outer-shell intersection
  // into the previous frame's screen space and sample the history RT.
  //
  // Note: an earlier attempt at per-pixel reprojection planned a 2nd MRT
  // attachment for true cloud-front depth, but three.js NodeMaterial
  // requires fragmentNode to be a direct OutputStructNode for MRT, which is
  // incompatible with `Fn(() => ...)()` (Fn wraps the return in a
  // FunctionCallNode, losing the OutputStructNode marker). Loop/If need
  // Fn's stack scope, so we can't drop the wrapper. D6 falls back to outer-
  // shell intersection for the reprojection depth — exact for sky pixels,
  // good enough for cloud-disk pixels (the visible cloud surface sits
  // 1–13 km below the outer shell; reprojection error there is sub-pixel
  // at all orbital altitudes and small-but-finite at close range).
  const uPrevViewProj = uniform(new THREE.Matrix4());

  // Phase D6: history texture (the *other* ping-pong cloud RT, swapped each
  // frame by SpaceRenderer via `updateUniforms`). Bound to a 1×1 placeholder
  // at material setup so the TextureNode can be constructed before any
  // history exists; the placeholder is overwritten on every frame the cloud
  // pass renders. uHistoryValid gates the blend off on the first frame and
  // any time SpaceRenderer detects a discontinuity (resize, floating-origin
  // rebase, etc.).
  const placeholderHistory = new THREE.DataTexture(
    new Uint8Array([0, 0, 0, 0]),
    1,
    1,
  );
  placeholderHistory.needsUpdate = true;
  const uHistoryTextureNode = texture(placeholderHistory);
  const uHistoryValid = uniform(0);
  // Phase D6 dither animation: drives a per-frame phase shift in the
  // marcher's screen-space hash. Without this, each pixel gets a fixed
  // dither offset, producing a static dot pattern that TAA's spatial
  // jitter can't smooth (the pattern is between pixels, not within them).
  // Set per frame by the caller from a low-discrepancy sequence; any
  // monotonic float that wraps quickly works.
  const uDitherPhase = uniform(0);

  mat.fragmentNode = Fn(() => {
    // Apply sub-pixel jitter to the UV before NDC reconstruction. screenUV
    // is in [0, 1]; uJitterUv is already in UV space (pixel-fraction /
    // pixel-dim) so no further scaling needed.
    const jitteredUvX = screenUV.x.add(uJitterUv.x);
    const jitteredUvY = screenUV.y.add(uJitterUv.y);

    // NDC.xy from screenUV. screenUV.y=0 sits at the TOP of the screen
    // (matches WebGPU RT origin), NDC.y=+1 is the TOP → y is flipped:
    // ndc.y = 1 - 2·screenUV.y.  x maps directly.
    const ndcX = jitteredUvX.mul(2).sub(1);
    const ndcY = float(1).sub(jitteredUvY.mul(2));

    if (DEBUG_FULLSCREEN === "solid") {
      // Premul-correct opaque red: composite REPLACES Earth fully.
      return vec4(1, 0, 0, 1);
    }
    if (DEBUG_FULLSCREEN === "screenUV") {
      return vec4(
        screenUV.x,
        float(1).sub(screenUV.y),
        float(0),
        float(1),
      );
    }

    // View-space ray direction: at the far plane, the eye looks down -Z by
    // convention. `tan(fov/2)` gives the half-height at unit depth; multiply
    // by aspect for the half-width.
    const rdView = vec3(
      ndcX.mul(uAspect).mul(uTanHalfFov),
      ndcY.mul(uTanHalfFov),
      float(-1),
    );
    const rdScaled = normalize(uCameraMatrixWorld.mul(vec4(rdView, 0)).xyz);

    // Transform ray + sun into Earth-local frame. Direction vectors use w=0
    // (no translation); positions use w=1.
    const roEarth = uEarthInverseModel.mul(vec4(uCameraScaledPos, 1)).xyz;
    const rdEarth = normalize(uEarthInverseModel.mul(vec4(rdScaled, 0)).xyz);
    const sunDirEarth = normalize(
      uEarthInverseModel.mul(vec4(opts.uSunRel, 0)).xyz,
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

    // marchCloudVolume returns `{ rgba, tFront }`. tFront is the t-value at
    // which the SKIP-mode march first detected cloud along this ray
    // (sentinel -1 = no hit). Used below as the per-pixel reprojection depth
    // — replaces an earlier outer-shell-t approximation that was off by up
    // to 13 km from the actual cloud surface (sub-pixel error at orbital
    // altitudes, a few pixels at close range). tFront lands reprojection
    // exactly on the cloud surface the pixel sampled last frame.
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
      uDitherPhase,
    });

    // ── Phase D6: temporal reprojection blend ──
    // Per-pixel reprojection depth, in order of preference:
    //   1. tFront (true cloud-front depth) — when the marcher actually hit
    //      cloud. This is the depth of the visible cloud surface, so
    //      reprojection lands EXACTLY on the same surface position the
    //      pixel sampled last frame.
    //   2. tShell (outer-shell entry) — when the ray hit the slab but
    //      missed cloud (covers sky-with-shell-grazing pixels).
    //   3. far constant (1000) — pure sky, ray misses the slab. Sky
    //      doesn't parallax under translation, so any large value is fine.
    const bShell = dot(roEarth, rdEarth);
    const cShell = dot(roEarth, roEarth)
      .sub(opts.uOuterRadius.mul(opts.uOuterRadius));
    const discShell = bShell.mul(bShell).sub(cShell);
    // Near intersection (ray entering slab from outside).
    const tShell = bShell.negate().sub(sqrt(tslMax(discShell, float(0))));
    const useShell = discShell.greaterThan(0).and(tShell.greaterThan(0));
    // tShell-or-far for the "missed cloud" fallback.
    const tShellOrFar = useShell.select(tShell, float(1000));
    // True cloud-front depth when present; otherwise the slab-or-sky depth.
    const hasCloudFront = tFront.greaterThan(0);
    const tReproj = hasCloudFront.select(tFront, tShellOrFar);

    // World position the current pixel "looked at" this frame, in scaled-
    // world coordinates (the same frame uPrevViewProj operates in).
    const reprojWorldPos = uCameraScaledPos.add(rdScaled.mul(tReproj));
    const prevClip = uPrevViewProj.mul(vec4(reprojWorldPos, 1));
    const prevNdcX = prevClip.x.div(prevClip.w);
    const prevNdcY = prevClip.y.div(prevClip.w);
    // NDC.y → screenUV.y flips: NDC.y=+1 is top, screenUV.y=0 is top.
    const prevUv = vec2(
      prevNdcX.mul(0.5).add(0.5),
      float(0.5).sub(prevNdcY.mul(0.5)),
    );

    // Disocclusion bound check: drop history if the previous-frame UV is
    // off-screen. (D4 will add a fuller validity model — for now this is
    // the cheap baseline.)
    const inBounds = prevUv.x.greaterThan(0).and(prevUv.x.lessThan(1))
      .and(prevUv.y.greaterThan(0)).and(prevUv.y.lessThan(1));
    const blendWeight = uHistoryValid.mul(inBounds.select(float(1), float(0)));

    // Per-frame pixel-space motion: comparing prev UV to THIS frame's
    // jittered UV (not raw screenUV) — the jitter offset is the same on
    // both sides for a stationary camera, so motionMag is exactly zero
    // when nothing moved. Used by D7 below to gate the alpha disocclusion
    // test: when stationary, no disocclusion is possible, so we trust TAA
    // fully even if per-frame alpha jitter is large (which it is — the
    // marcher's animated dither produces alpha variance in [0, ~0.5]
    // even on a static cloud body, and that variance is exactly what TAA
    // is supposed to integrate).
    const jitteredUv = vec2(jitteredUvX, jitteredUvY);
    const motionMag = length(prevUv.sub(jitteredUv));

    // Sample history at the reprojected UV. The placeholder texture binds
    // a 1×1 black at material setup; updateUniforms swaps in the actual
    // history each frame, so by the time the shader runs uHistoryTextureNode
    // is bound to the off-parity cloud RT.
    const historyRgba = texture(uHistoryTextureNode, prevUv);

    // ── Phase D7: anti-ghost mitigation ──
    // Proper variance clamping needs a 3×3 neighbourhood of the CURRENT
    // frame's colour buffer, which we don't have inside this single pass
    // (the marcher only computes one ray per fragment). Splitting into a
    // marcher-pass + TAA-composite-pass would expose neighbours but adds
    // an RT and a fragment shader; deferred until ghosting becomes worse.
    //
    // Cheaper single-pass mitigation: gate disocclusion on BOTH motion
    // AND alpha-mismatch. Either alone is unreliable —
    //   - Alpha alone false-triggers on normal per-frame dither variance
    //     (the cloud sample's alpha legitimately varies as dither shifts
    //     the march start), collapsing the blend to near-zero when TAA
    //     should be integrating freely.
    //   - Motion alone over-blocks: any orbital pan would dump history
    //     across cloud bodies where reprojection IS correct.
    //   - The product fires only when motion is significant AND the
    //     reprojected history's alpha disagrees sharply with the new
    //     sample. That's the signature of a real silhouette transition
    //     (cloud moved off this pixel) — the case that produces visible
    //     ghost trails. Static-camera dot integration runs at full TAA
    //     weight, so the dancing dots converge to a smooth average.
    //
    // Threshold rationale: motionGate engages around half a pixel UV
    // motion (well past the jitter floor); alphaGate triggers only at
    // near-total alpha change (inside-cloud dither variance never gets
    // there).
    const motionGate = smoothstep(float(0.001), float(0.02), motionMag);
    const alphaDiff = historyRgba.a.sub(rgba.a).abs();
    const alphaGate = smoothstep(float(0.4), float(0.8), alphaDiff);
    const disocclusion = motionGate.mul(alphaGate);
    const similarity = float(1).sub(disocclusion);
    const finalBlend = blendWeight.mul(0.95).mul(similarity);

    // Premul colours mix linearly per channel (incl. alpha), so the
    // mix is correct without unpremul/premul round-tripping.
    const final = mix(rgba, historyRgba, finalBlend);
    return final;
  })();

  const mesh = new THREE.Mesh(geo, mat);
  // Ortho clip volume at z∈[0,1] should never cull a centred plane, but be
  // explicit — the fullscreen quad must paint every frame.
  mesh.frustumCulled = false;
  cloudScene.add(mesh);

  const updateUniforms = (
    scaledCamera: THREE.PerspectiveCamera,
    earthMesh: THREE.Object3D,
    jitterUv: THREE.Vector2,
    prevViewProj: THREE.Matrix4,
    historyTexture: THREE.Texture,
    historyValid: number,
  ) => {
    uCameraMatrixWorld.value.copy(scaledCamera.matrixWorld);
    uCameraScaledPos.value.copy(scaledCamera.position);
    // FOV is stored in degrees on the camera; tan needs radians.
    uTanHalfFov.value = Math.tan((scaledCamera.fov * Math.PI) / 180 / 2);
    uAspect.value = scaledCamera.aspect;
    earthMesh.updateWorldMatrix(true, false);
    uEarthInverseModel.value.copy(earthMesh.matrixWorld).invert();
    uJitterUv.value.copy(jitterUv);
    uPrevViewProj.value.copy(prevViewProj);
    // Swap the history binding to whichever ping-pong RT held the
    // previous frame. WebGPU rebinds the bind group on texture-identity
    // change; format must match (both RTs use HalfFloatType, so OK).
    uHistoryTextureNode.value = historyTexture;
    uHistoryValid.value = historyValid;
    // Phase D6: derive a per-frame dither phase from the same Halton
    // sequence that drives `jitterUv`. The jitter is sub-pixel UV
    // (~1e-4); scaling by 1e4 gives a phase of order 1, enough to shift
    // the sin's hash argument into a different bucket each frame so per-
    // pixel dither cycles through 16 distinct values across the TAA window.
    uDitherPhase.value = (jitterUv.x + jitterUv.y) * 1e4;
  };

  const dispose = () => {
    cloudScene.remove(mesh);
    mat.dispose();
    geo.dispose();
    placeholderHistory.dispose();
    if (activePass === handle) activePass = null;
  };

  const handle: FullscreenCloudPass = {
    cloudScene,
    cloudCamera,
    updateUniforms,
    dispose,
  };
  activePass = handle;
  return handle;
}
