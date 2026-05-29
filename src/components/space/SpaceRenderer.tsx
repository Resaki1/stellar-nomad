"use client";

import { ReactNode, useEffect, useMemo, useRef } from "react";
import { createPortal, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { NodeMaterial, RenderPipeline, RenderTarget } from "three/webgpu";
import { texture, screenUV } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import {
  LOCAL_TO_SCALED_FROM_LOCAL_UNITS,
  SCALED_UNITS_PER_KM,
} from "@/sim/units";
import { useWorldOrigin } from "@/sim/worldOrigin";
import {
  HalfFloatType,
  RedFormat,
  AgXToneMapping,
  NeutralToneMapping,
  NoToneMapping,
} from "three";
import { useAtomValue } from "jotai/react";
import { settingsAtom } from "@/store/store";
import {
  getActiveCloudPipeline,
  getEarthMatrixWorldRef,
} from "./cloudFullscreenPass";

const LOCAL_CAMERA_NEAR = 0.01;
// 20,000 km expressed in local meters
const LOCAL_CAMERA_FAR = 20_000 * 1000;
// 0.1 scaled units = 100 km. The closest geometry in the scaled scene
// is a planet surface at ~30+ scaled units (with floating origin), so
// this is safe. A tighter near plane gives far better depth precision
// at medium distances — fixes z-fighting on Saturn's rings at ~1.4M km.
// (Don't use logarithmicDepthBuffer — it breaks depth for custom vertexNode.)
const SCALED_CAMERA_NEAR = 0.001;
const SCALED_CAMERA_FAR = 2_000_000;

// Phase D: 1/16 reconstruction. The marcher writes a SPARSE RT (1/4 × 1/4
// of screen = 1/16 of full pixels). Each sparse texel = one 4×4 full-res
// tile, marched at the current Bayer sub-pixel slot. A full-res
// reconstruction pass fills the other 15/16 pixels from reprojected history
// with YCoCg variance clamping. See cloudFullscreenPass.ts and
// cloudReconstructionPass.ts.
const SPARSE_DIVISOR = 4;

// Canonical Bayer 4×4 ordered-dither matrix, value → (x, y). Each frame
// picks index `frameIndex mod 16`; after 16 frames every sub-pixel of every
// 4×4 tile has been marched exactly once. Short windows still cover
// well-spread sub-positions (any 4 consecutive frames hit 4 spatially
// separated slots — the property of the Bayer ordering).
const BAYER_4X4: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [2, 2], [2, 0], [0, 2],
  [1, 1], [3, 3], [3, 1], [1, 3],
  [1, 0], [3, 2], [3, 0], [1, 2],
  [0, 1], [2, 3], [2, 1], [0, 3],
];

const tempScaledPos = new THREE.Vector3();
const tempClearColor = new THREE.Color();
const tempBayerSub = new THREE.Vector2();
const tempViewProj = new THREE.Matrix4();
const tempOriginShiftScaled = new THREE.Vector3();
const tempFullSize = new THREE.Vector2();
const tempSparseSize = new THREE.Vector2();
const scaledScene = new THREE.Scene();
const localScene = new THREE.Scene();

// Halton(2,3) sub-pixel jitter is obsolete in the 1/16 reconstruction
// architecture — replaced by the deterministic BAYER_4X4 schedule above.
// The Bayer slot index is `frameIndex % 16` and the sub-pixel offset is
// applied integer-pixel-wise inside the marcher (not as a fractional jitter).

// Full-screen quad for the cloud composite pass. One per SpaceRenderer
// lifetime — the cloud-texture node inside the material is rebuilt when the
// RT changes, but the geometry + camera are static.
const compositeScene = new THREE.Scene();
const compositeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const compositeGeometry = new THREE.PlaneGeometry(2, 2);

export type SpaceRendererProps = {
  scaled: ReactNode;
  local: ReactNode;
};

const SpaceRenderer = ({ scaled, local }: SpaceRendererProps) => {
  const settings = useAtomValue(settingsAtom);
  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);
  const localCamera = useThree(
    (state) => state.camera as THREE.PerspectiveCamera
  );
  // Floating-origin tracking. `worldOriginKm` is mutated every frame by
  // Spaceship.tsx to follow the ship's interpolated position, so the
  // scaled-world coordinate system slides under static objects from one
  // frame to the next. The cloud pass's TAA reprojection must subtract
  // this slide before sampling the history RT — see uOriginShiftScaled
  // in cloudFullscreenPass.ts.
  const worldOrigin = useWorldOrigin();

  const scaledCamera = useMemo(() => localCamera.clone(), [localCamera]);

  // Offscreen render target — both scenes render here with depth-clear
  // compositing, then the pipeline reads from it for bloom + tonemapping.
  const rt = useMemo(() => {
    const dpr = gl.getPixelRatio();
    return new RenderTarget(
      Math.floor(size.width * dpr),
      Math.floor(size.height * dpr),
      { type: HalfFloatType, depthBuffer: true }
    );
  }, [gl, size.width, size.height]);

  useEffect(() => () => { rt.dispose(); }, [rt]);

  // Phase D RT layout — three pairs:
  //
  //   sparseCloudRts: W/4 × H/4 RGBA16F. The marcher (pass 2a) writes one
  //     fresh sample per 4×4 full-res tile here. Ping-pong only because
  //     the reconstruction pass reads it the same frame; the OTHER
  //     parity isn't used as history (reconstruction reads its own
  //     history RT, not the sparse RT). Single RT would work too, but
  //     ping-ponging keeps WebGPU happy if it complains about
  //     concurrent read/write of the same texture in adjacent passes.
  //
  //   sparseDepthRts: W/4 × H/4 R16F (RedFormat + HalfFloatType). Pass 2b
  //     writes `tFront` (scaled-world depth of the cloud front along the
  //     ray, sentinel −1 = no hit). Used by the reconstruction pass for
  //     per-tile reprojection depth.
  //
  //   historyRts: full-res RGBA16F. Pass 2c (reconstruction) writes the
  //     final per-pixel cloud colour here; the off-parity is read back
  //     next frame as the previous-frame history. Composite (pass 3)
  //     reads from this RT, premul-alpha blending onto the main scene RT.
  //
  // Total VRAM at 1080p × DPR=2: sparse color 2×(960×540×8) = 8 MiB,
  // sparse depth 2×(960×540×2) = 2 MiB, history 2×(1920×1080×8) = 33 MiB.
  // ≈ 43 MiB cloud working set. Acceptable.
  const sparseCloudRts = useMemo(() => {
    const dpr = gl.getPixelRatio();
    const w = Math.max(1, Math.floor(size.width * dpr / SPARSE_DIVISOR));
    const h = Math.max(1, Math.floor(size.height * dpr / SPARSE_DIVISOR));
    return [
      new RenderTarget(w, h, { type: HalfFloatType, depthBuffer: false }),
      new RenderTarget(w, h, { type: HalfFloatType, depthBuffer: false }),
    ] as const;
  }, [gl, size.width, size.height]);

  const sparseDepthRts = useMemo(() => {
    const dpr = gl.getPixelRatio();
    const w = Math.max(1, Math.floor(size.width * dpr / SPARSE_DIVISOR));
    const h = Math.max(1, Math.floor(size.height * dpr / SPARSE_DIVISOR));
    return [
      new RenderTarget(w, h, {
        type: HalfFloatType,
        format: RedFormat,
        depthBuffer: false,
      }),
      new RenderTarget(w, h, {
        type: HalfFloatType,
        format: RedFormat,
        depthBuffer: false,
      }),
    ] as const;
  }, [gl, size.width, size.height]);

  const historyRts = useMemo(() => {
    const dpr = gl.getPixelRatio();
    const w = Math.max(1, Math.floor(size.width * dpr));
    const h = Math.max(1, Math.floor(size.height * dpr));
    return [
      new RenderTarget(w, h, { type: HalfFloatType, depthBuffer: false }),
      new RenderTarget(w, h, { type: HalfFloatType, depthBuffer: false }),
    ] as const;
  }, [gl, size.width, size.height]);

  useEffect(() => () => {
    sparseCloudRts[0].dispose();
    sparseCloudRts[1].dispose();
  }, [sparseCloudRts]);
  useEffect(() => () => {
    sparseDepthRts[0].dispose();
    sparseDepthRts[1].dispose();
  }, [sparseDepthRts]);
  useEffect(() => () => {
    historyRts[0].dispose();
    historyRts[1].dispose();
  }, [historyRts]);

  // Composite meshes: read from the full-res historyRts (the reconstruction
  // output) and premul-alpha blend onto the main scene RT. No bilinear
  // upsample needed — reconstruction is already at full resolution.
  // Pre-built pair so the per-frame parity swap is just a parent/child
  // mutation (avoids TextureNode `.value` reassignment, which the WebGPU
  // backend's bind-group cache doesn't always honour mid-frame).
  const compositeMeshes = useMemo(() => {
    const make = (rt: RenderTarget) => {
      const mat = new NodeMaterial();
      mat.transparent = true;
      mat.depthTest = false;
      mat.depthWrite = false;
      mat.blending = THREE.CustomBlending;
      mat.blendSrc = THREE.OneFactor;
      mat.blendDst = THREE.OneMinusSrcAlphaFactor;
      mat.blendSrcAlpha = THREE.OneFactor;
      mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
      mat.fragmentNode = texture(rt.texture, screenUV);
      return new THREE.Mesh(compositeGeometry, mat);
    };
    return [make(historyRts[0]), make(historyRts[1])] as const;
  }, [historyRts]);

  useEffect(() => () => {
    for (const mesh of compositeMeshes) {
      (mesh.material as NodeMaterial).dispose();
    }
  }, [compositeMeshes]);

  // RenderPipeline (replaces the old EffectComposer)
  const pipeline = useMemo(
    () => new RenderPipeline(gl as any),
    [gl]
  );
  const pipelineRef = useRef(pipeline);
  pipelineRef.current = pipeline;

  // Rebuild the node graph when bloom / toneMapping / RT changes
  useEffect(() => {
    const sceneTexture = texture(rt.texture);

    let outputNode: any = sceneTexture;
    if (settings.bloom) {
      const bloomPass = bloom(sceneTexture, 0.02, 0, 1);
      outputNode = sceneTexture.add(bloomPass);
    }

    pipeline.outputNode = outputNode;
    pipeline.needsUpdate = true;

    // Tone mapping applied by RenderPipeline's renderOutput() wrapper
    const renderer = gl as any;
    renderer.toneMapping = settings.toneMapping
      ? AgXToneMapping
      : NeutralToneMapping;

    return () => {
      pipeline.needsUpdate = true;
    };
  }, [settings.bloom, settings.toneMapping, pipeline, rt, gl]);

  // Camera setup
  useEffect(() => {
    localCamera.near = LOCAL_CAMERA_NEAR;
    localCamera.far = LOCAL_CAMERA_FAR;
    localCamera.updateProjectionMatrix();
  }, [localCamera]);

  useEffect(() => {
    scaledCamera.near = SCALED_CAMERA_NEAR;
    scaledCamera.far = SCALED_CAMERA_FAR;
    scaledCamera.fov = localCamera.fov;
    scaledCamera.aspect = size.width / size.height;
    scaledCamera.updateProjectionMatrix();
  }, [localCamera.fov, scaledCamera, size.height, size.width]);

  // Cleanup
  useEffect(() => () => { pipeline.dispose(); }, [pipeline]);

  const firstFrameLogged = useRef(false);
  // Ping-pong index: this frame writes cloudRts[frameParity], next frame
  // writes the other. compositeScene gets the matching mesh swapped in.
  const frameParity = useRef(0);
  const mountedCompositeMesh = useRef<THREE.Mesh | null>(null);
  // Phase D2: monotonic frame counter (mod 16) drives the Bayer 4×4
  // schedule lookup. Distinct from frameParity (which is just 2-state).
  // Also drives the STBN frame-slice uniform in the cloud pipeline
  // (advanced by 1/STBN_PERIOD_Z per frame inside setupCloudPipeline).
  const cloudFrameIndex = useRef(0);
  // Phase D3: previous frame's combined view-projection matrix in scaled
  // world space, snapshotted at end of frame. Identity on the first frame.
  const prevCloudViewProj = useRef(new THREE.Matrix4());
  // Phase D3+: previous frame's world origin (km). Used together with
  // prevCloudViewProj to express this frame's reprojection target in the
  // *previous* frame's scaled coordinate system. Without this, the
  // floating origin (which slides every frame in Spaceship.tsx) introduces
  // a velocity-proportional offset in the history sample UV.
  // `hasPrevWorldOrigin` is false on the very first render and is also
  // reset whenever we choose to invalidate history mid-session.
  const prevWorldOriginKm = useRef(new THREE.Vector3());
  const hasPrevWorldOrigin = useRef(false);
  // Phase D6: history-validity flag passed to the cloud pass each frame.
  // Starts at 0 so the first cloud render outputs only the new sample
  // (history is uninitialised). Flips to 1 after one full cycle. Reset to
  // 0 whenever the RT pair is recreated (resize) — the new RT may share
  // memory with a torn-down one but its content is undefined.
  const cloudHistoryValid = useRef(0);
  useEffect(() => {
    cloudHistoryValid.current = 0;
    hasPrevWorldOrigin.current = false;
  }, [historyRts, sparseCloudRts, sparseDepthRts]);

  useFrame(() => {
    // Skip until WebGPU backend is ready (init is async).
    if (!(gl as any).initialized) return;

    if (!firstFrameLogged.current) {
      firstFrameLogged.current = true;
      performance.mark("first-frame-render");
      console.log(
        "[perf] First frame render",
        performance.now().toFixed(0) + "ms",
      );
    }

    // Advance the node frame so BloomNode's updateBefore runs each frame.
    // Normally the renderer's internal animation loop does this, but we
    // stopped it because R3F owns the frame loop (Scene.tsx: _animation.stop()).
    const renderer = gl as any;
    renderer._nodes.nodeFrame.update();

    // Sync scaled camera with local camera
    tempScaledPos
      .copy(localCamera.position)
      .multiplyScalar(LOCAL_TO_SCALED_FROM_LOCAL_UNITS);
    scaledCamera.position.copy(tempScaledPos);
    scaledCamera.quaternion.copy(localCamera.quaternion);

    // ── Render both scenes into the offscreen RT in linear HDR ──
    // Disable tone mapping so HDR values stay above 1.0 for bloom threshold.
    // RenderPipeline applies tone mapping + color space at the end.
    const savedToneMapping = renderer.toneMapping;
    const savedColorSpace = renderer.outputColorSpace;
    renderer.toneMapping = NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

    // Pass 1: scaled scene — planets, skybox, stars. Layer 0 only; the cloud
    // anchor mesh sits on CLOUD_LAYER (which no camera enables) and never
    // renders. It exists only as a matrixWorld provider for the fullscreen
    // pass below.
    scaledCamera.layers.enable(0);
    renderer.setRenderTarget(rt);
    gl.autoClear = true;
    gl.render(scaledScene, scaledCamera);

    // ── Phase D cloud pipeline: pass 2a (sparse color) → 2b (sparse depth)
    // → 2c (full-res reconstruction) → pass 3 (composite onto main RT). ──
    //
    // Premul-alpha clear (0,0,0,0) on the sparse color RT: non-zero clear
    // alpha would bleed the clear colour into cloud fringes during the
    // reconstruction's variance-clamp neighbourhood read.
    gl.getClearColor(tempClearColor);
    const savedClearAlpha = gl.getClearAlpha();
    gl.setClearColor(0x000000, 0);

    const writeIdx = frameParity.current;
    const sparseColorRt = sparseCloudRts[writeIdx];
    const sparseDepthRt = sparseDepthRts[writeIdx];
    const historyWriteRt = historyRts[writeIdx];
    const historyReadRt = historyRts[writeIdx ^ 1];
    const writeCompositeMesh = compositeMeshes[writeIdx];

    const pipelineHandle = getActiveCloudPipeline();
    const earthMesh = pipelineHandle ? getEarthMatrixWorldRef() : null;

    if (pipelineHandle && earthMesh) {
      // Bayer 4×4 schedule pick for this frame. Sub-pixel slot (0..3, 0..3)
      // marks which full-res pixel within every 4×4 tile is fresh this frame.
      const bayerIdx = cloudFrameIndex.current % BAYER_4X4.length;
      const [bx, by] = BAYER_4X4[bayerIdx];
      tempBayerSub.set(bx, by);

      // Full-res / sparse RT dims for the reconstruction pass's UV math.
      tempFullSize.set(historyWriteRt.width, historyWriteRt.height);
      tempSparseSize.set(sparseColorRt.width, sparseColorRt.height);

      // Origin shift = (currentOriginKm − prevOriginKm) × SCALED_UNITS_PER_KM.
      // First frame after mount / resize → no prev origin; zero the shift
      // (history is invalid this frame anyway via cloudHistoryValid).
      if (hasPrevWorldOrigin.current) {
        tempOriginShiftScaled
          .copy(worldOrigin.worldOriginKm)
          .sub(prevWorldOriginKm.current)
          .multiplyScalar(SCALED_UNITS_PER_KM);
      } else {
        tempOriginShiftScaled.set(0, 0, 0);
      }

      // One uniform-update call distributes state to all three pass
      // materials (color, depth, reconstruction).
      pipelineHandle.updateUniforms({
        scaledCamera,
        earthMesh,
        bayerSubPixel: tempBayerSub,
        prevViewProj: prevCloudViewProj.current,
        originShiftScaled: tempOriginShiftScaled,
        sparseColorTexture: sparseColorRt.texture,
        sparseDepthTexture: sparseDepthRt.texture,
        historyTexture: historyReadRt.texture,
        historyValid: cloudHistoryValid.current,
        frameIndex: cloudFrameIndex.current,
        fullSize: tempFullSize,
        sparseSize: tempSparseSize,
      });

      // Pass 2a: sparse color marcher (W/4 × H/4 RGBA16F).
      renderer.setRenderTarget(sparseColorRt);
      gl.autoClear = true;
      gl.render(pipelineHandle.colorScene, pipelineHandle.colorCamera);

      // Pass 2b: sparse depth marcher (W/4 × H/4 R16F, tFront in .r).
      renderer.setRenderTarget(sparseDepthRt);
      gl.autoClear = true;
      gl.render(pipelineHandle.depthScene, pipelineHandle.depthCamera);

      // Pass 2c: full-res reconstruction. Reads sparseColor + sparseDepth +
      // historyReadRt, writes historyWriteRt (full-res RGBA16F).
      renderer.setRenderTarget(historyWriteRt);
      gl.autoClear = true;
      gl.render(
        pipelineHandle.reconstructionScene,
        pipelineHandle.reconstructionCamera,
      );

      cloudHistoryValid.current = 1;
    } else {
      // No active pipeline (Earth not yet mounted, or player out of near
      // range). Clear the full-res history RT to fully transparent so the
      // composite contributes nothing this frame. Also invalidate history
      // for next time the pipeline resumes — its off-parity RT may have
      // been cleared here, and blending against (0,0,0,0) would briefly
      // erase the cloud.
      renderer.setRenderTarget(historyWriteRt);
      gl.autoClear = true;
      gl.clear();
      cloudHistoryValid.current = 0;
      hasPrevWorldOrigin.current = false;
    }

    gl.setClearColor(tempClearColor, savedClearAlpha);

    // Pass 3: composite the just-reconstructed full-res cloud RT → main rt
    // with premul-alpha blend. Swap which mesh sits in compositeScene to
    // match the historyRt we just wrote (each mesh's TextureNode is bound
    // to one specific RT at compile time).
    if (mountedCompositeMesh.current !== writeCompositeMesh) {
      if (mountedCompositeMesh.current) {
        compositeScene.remove(mountedCompositeMesh.current);
      }
      compositeScene.add(writeCompositeMesh);
      mountedCompositeMesh.current = writeCompositeMesh;
    }
    renderer.setRenderTarget(rt);
    gl.autoClear = false;
    gl.render(compositeScene, compositeCamera);

    // Pass 4: local scene (ship, asteroids, beam, lights) — clear depth only,
    // draw on top. This naturally composites local content over the scaled
    // background, including objects that don't write depth.
    gl.clearDepth();
    gl.render(localScene, localCamera);

    renderer.setRenderTarget(null);

    // Restore so the RenderPipeline picks them up for its renderOutput() pass
    renderer.toneMapping = savedToneMapping;
    renderer.outputColorSpace = savedColorSpace;

    // ── Apply postprocessing (bloom, tonemapping) and blit to canvas ──
    pipelineRef.current.render();

    // Advance the ping-pong parity so next frame writes the *other* history
    // RT (and reads this one back as history input).
    frameParity.current ^= 1;
    // Bayer 4×4 schedule wraps every 16 frames — after 16 frames every
    // sub-pixel of every 4×4 tile has been marched exactly once.
    cloudFrameIndex.current = (cloudFrameIndex.current + 1) % BAYER_4X4.length;

    // Phase D3: snapshot this frame's combined view-projection in scaled
    // space. Next frame this becomes `uPrevViewProj` and lets the shader
    // compute the previous-frame UV for the world point each pixel sampled.
    // matrixWorldInverse was updated by `gl.render(scaledScene, scaledCamera)`
    // above, so it's current as of this frame.
    tempViewProj.multiplyMatrices(
      scaledCamera.projectionMatrix,
      scaledCamera.matrixWorldInverse,
    );
    prevCloudViewProj.current.copy(tempViewProj);
    // Snapshot the world origin alongside the VP matrix — both describe
    // *this* frame's scaled coordinate system, and reprojection next frame
    // needs both to be consistent. (Spaceship.tsx mutates worldOriginKm
    // before each render frame, so the value we read here is the one the
    // scaled scene was just rendered with.)
    prevWorldOriginKm.current.copy(worldOrigin.worldOriginKm);
    hasPrevWorldOrigin.current = true;
  }, 1);

  return (
    <>
      {createPortal(scaled, scaledScene)}
      {createPortal(local, localScene)}
    </>
  );
};

export default SpaceRenderer;
