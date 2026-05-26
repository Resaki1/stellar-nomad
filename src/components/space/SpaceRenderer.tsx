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
import { HalfFloatType, AgXToneMapping, NeutralToneMapping, NoToneMapping } from "three";
import { useAtomValue } from "jotai/react";
import { settingsAtom } from "@/store/store";
import {
  getActiveFullscreenCloudPass,
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

// Half-res cloud pass: render the cloud shell at 0.5× each axis (= ¼ pixels).
// Cloud detail is inherently low-frequency; bilinear upsample in the composite
// pass is visually indistinguishable for cloud interiors, and the silhouette
// against the planet limb stays sharp because it's the planet pass (full res)
// that defines that edge. The cloud shell does NOT bound the silhouette.
const CLOUD_RT_SCALE = 0.5;

const tempScaledPos = new THREE.Vector3();
const tempClearColor = new THREE.Color();
const tempJitter = new THREE.Vector2();
const tempViewProj = new THREE.Matrix4();
const tempOriginShiftScaled = new THREE.Vector3();
const scaledScene = new THREE.Scene();
const localScene = new THREE.Scene();

// Phase D2: 16-entry Halton(2,3) low-discrepancy sequence, centred so each
// entry is in [-0.5, 0.5]. Each frame we pick the next entry, divide by RT
// pixel dims, and feed it as a sub-pixel jitter for the cloud ray-march.
// Halton beats random and Bayer for spatial-coverage convergence within a
// short cycle (16 frames here = 4×4 effective stratification).
const HALTON_LEN = 16;
const HALTON_JITTER: ReadonlyArray<readonly [number, number]> = (() => {
  const halton = (index: number, base: number): number => {
    let f = 1;
    let r = 0;
    let i = index;
    while (i > 0) {
      f /= base;
      r += f * (i % base);
      i = Math.floor(i / base);
    }
    return r;
  };
  const out: [number, number][] = [];
  for (let i = 1; i <= HALTON_LEN; i++) {
    out.push([halton(i, 2) - 0.5, halton(i, 3) - 0.5]);
  }
  return out;
})();

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

  // Phase D ping-pong cloud RTs. Each frame writes one and (once D6
  // lands) reads the other as history. Half-res for now; D5 lifts to full
  // res alongside the 1/16 stochastic schedule that pays the perf cost back.
  // (An MRT layout for a 2nd "tFront" attachment was attempted but three's
  // NodeMaterial only honours MRT when fragmentNode is a direct
  // OutputStructNode, which is incompatible with the Fn(()=>...)() wrapping
  // the marcher needs for Loop/If stack scope. D6 falls back to camera-only
  // reprojection — accurate at orbit altitudes; close-range parallax is the
  // tradeoff.)
  const cloudRts = useMemo(() => {
    const dpr = gl.getPixelRatio();
    const w = Math.max(1, Math.floor(size.width * dpr * CLOUD_RT_SCALE));
    const h = Math.max(1, Math.floor(size.height * dpr * CLOUD_RT_SCALE));
    return [
      new RenderTarget(w, h, { type: HalfFloatType, depthBuffer: true }),
      new RenderTarget(w, h, { type: HalfFloatType, depthBuffer: true }),
    ] as const;
  }, [gl, size.width, size.height]);

  useEffect(() => () => {
    cloudRts[0].dispose();
    cloudRts[1].dispose();
  }, [cloudRts]);

  // One composite mesh per cloud RT. Pre-built so swapping which one is in
  // compositeScene each frame is a parent/child mutation, not a TSL
  // recompile. (Reassigning a TextureNode's `.value` mid-frame is not
  // reliably honoured by the WebGPU backend's bind-group caching.)
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
      // Use screenUV (not the plane's geometry uv) — WebGPU RTs have origin
      // at top-left, matching screenUV.y=0 at top. Geometry uv has origin at
      // bottom-left, which flips the composite vertically.
      mat.fragmentNode = texture(rt.texture, screenUV);
      return new THREE.Mesh(compositeGeometry, mat);
    };
    return [make(cloudRts[0]), make(cloudRts[1])] as const;
  }, [cloudRts]);

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
  // Phase D2: monotonic frame counter (mod HALTON_LEN) drives sub-pixel
  // jitter selection. Distinct from frameParity (which is just 2-state).
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
  }, [cloudRts]);

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

    // Pass 2: per-pixel cloud ray-march into the half-res cloudRt. Premul-
    // alpha clear (0,0,0,0) is critical — non-zero clear alpha would bleed
    // the clear colour into cloud fringes on composite. Each fragment shoots
    // its own ray into the slab, so cloud-front depth varies per pixel and
    // camera motion produces real 3D parallax (Phase G).
    gl.getClearColor(tempClearColor);
    const savedClearAlpha = gl.getClearAlpha();
    gl.setClearColor(0x000000, 0);

    const writeIdx = frameParity.current;
    const writeRt = cloudRts[writeIdx];
    const writeCompositeMesh = compositeMeshes[writeIdx];

    const fullscreenPass = getActiveFullscreenCloudPass();
    const earthMesh = fullscreenPass ? getEarthMatrixWorldRef() : null;

    if (fullscreenPass && earthMesh) {
      // Phase D2: pick this frame's Halton offset and convert pixel-space
      // jitter to UV space using the actual cloud RT dims.
      const haltonIdx = cloudFrameIndex.current % HALTON_LEN;
      const [hx, hy] = HALTON_JITTER[haltonIdx];
      tempJitter.set(hx / writeRt.width, hy / writeRt.height);
      // Phase D6: feed the *off-parity* RT in as history. Its content was
      // written one frame ago by the same shader, so reprojection has
      // something coherent to sample. cloudHistoryValid is 0 on the first
      // post-mount frame so the shader skips the blend; flips to 1 after.
      const historyRt = cloudRts[writeIdx ^ 1];
      // Origin shift = (currentOriginKm − prevOriginKm) × SCALED_UNITS_PER_KM.
      // First frame after mount / resize / pass resume → no valid previous
      // origin yet; zero the shift (history is invalid this frame anyway,
      // gated by cloudHistoryValid).
      if (hasPrevWorldOrigin.current) {
        tempOriginShiftScaled
          .copy(worldOrigin.worldOriginKm)
          .sub(prevWorldOriginKm.current)
          .multiplyScalar(SCALED_UNITS_PER_KM);
      } else {
        tempOriginShiftScaled.set(0, 0, 0);
      }
      fullscreenPass.updateUniforms(
        scaledCamera,
        earthMesh,
        tempJitter,
        prevCloudViewProj.current,
        tempOriginShiftScaled,
        historyRt.texture,
        cloudHistoryValid.current,
      );
      renderer.setRenderTarget(writeRt);
      gl.autoClear = true;
      gl.render(fullscreenPass.cloudScene, fullscreenPass.cloudCamera);
      cloudHistoryValid.current = 1;
    } else {
      // No active pass (Earth not yet mounted, or player out of near range).
      // Clear cloudRt to fully transparent so the composite contributes
      // nothing this frame. Also invalidate history — when the pass
      // resumes, the off-parity RT may have just been cleared here, and
      // blending against (0,0,0,0) would briefly erase the cloud.
      renderer.setRenderTarget(writeRt);
      gl.autoClear = true;
      gl.clear();
      cloudHistoryValid.current = 0;
      // Pass is dormant; the prev origin snapshot is no longer meaningful
      // for the next active frame either. Clear so the first resumed frame
      // takes the "no shift, history invalid" branch above.
      hasPrevWorldOrigin.current = false;
    }

    gl.setClearColor(tempClearColor, savedClearAlpha);

    // Pass 3: composite the just-written cloud RT → main rt with premul-
    // alpha blend. Swap which mesh sits in compositeScene to match the RT
    // we just wrote (each mesh has its TextureNode bound to one specific RT
    // at compile time).
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

    // Advance the ping-pong parity so next frame writes the *other* RT
    // (and, once D6 lands, reads this one as history).
    frameParity.current ^= 1;
    cloudFrameIndex.current = (cloudFrameIndex.current + 1) % HALTON_LEN;

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
