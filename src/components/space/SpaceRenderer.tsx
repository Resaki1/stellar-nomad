"use client";

import { ReactNode, useEffect, useMemo, useRef } from "react";
import { createPortal, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { NodeMaterial, RenderPipeline, RenderTarget } from "three/webgpu";
import { texture, screenUV } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { LOCAL_TO_SCALED_FROM_LOCAL_UNITS } from "@/sim/units";
import { HalfFloatType, AgXToneMapping, NeutralToneMapping, NoToneMapping } from "three";
import { useAtomValue } from "jotai/react";
import { settingsAtom } from "@/store/store";
import { CLOUD_LAYER } from "./renderLayers";

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
const scaledScene = new THREE.Scene();
const localScene = new THREE.Scene();

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

  // Half-res RT for the volumetric cloud pass. ¼ the fragments of the main RT
  // — the single biggest fill-rate reduction for a fragment-shader-bound
  // effect like this one. Sized from the same DPR so clouds are crisp enough
  // on high-DPI displays without paying full cost.
  const cloudRt = useMemo(() => {
    const dpr = gl.getPixelRatio();
    return new RenderTarget(
      Math.max(1, Math.floor(size.width * dpr * CLOUD_RT_SCALE)),
      Math.max(1, Math.floor(size.height * dpr * CLOUD_RT_SCALE)),
      { type: HalfFloatType, depthBuffer: true },
    );
  }, [gl, size.width, size.height]);

  useEffect(() => () => { cloudRt.dispose(); }, [cloudRt]);

  // Composite material: full-screen quad that samples the cloud RT and blends
  // it into the main RT with premultiplied alpha. Bilinear sampling on a
  // premul texture is the correct resampling for alpha-blended colour — it
  // matches what an N× higher-res render would converge to at the same
  // filtered sample point.
  const compositeMesh = useMemo(() => {
    const mat = new NodeMaterial();
    mat.transparent = true;
    mat.depthTest = false;
    mat.depthWrite = false;
    mat.blending = THREE.CustomBlending;
    mat.blendSrc = THREE.OneFactor;
    mat.blendDst = THREE.OneMinusSrcAlphaFactor;
    mat.blendSrcAlpha = THREE.OneFactor;
    mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    // Use screenUV (not the plane's geometry uv) — WebGPU RTs have origin at
    // top-left, matching screenUV.y=0 at top. Geometry uv has origin at
    // bottom-left, which flips the composite vertically and produces a "ghost"
    // Earth reflected across the horizon line.
    mat.fragmentNode = texture(cloudRt.texture, screenUV);
    return new THREE.Mesh(compositeGeometry, mat);
  }, [cloudRt]);

  useEffect(() => {
    compositeScene.add(compositeMesh);
    return () => {
      compositeScene.remove(compositeMesh);
      (compositeMesh.material as NodeMaterial).dispose();
    };
  }, [compositeMesh]);

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

    // Pass 1: scaled scene WITHOUT the cloud layer — planets, skybox, stars.
    scaledCamera.layers.enable(0);
    scaledCamera.layers.disable(CLOUD_LAYER);
    renderer.setRenderTarget(rt);
    gl.autoClear = true;
    gl.render(scaledScene, scaledCamera);

    // Pass 2: cloud shell only, rendered at half-res into cloudRt.
    // The premul-alpha clear ((0,0,0,0)) is critical — non-zero clear alpha
    // would bleed the clear colour into cloud fringes on composite.
    scaledCamera.layers.disable(0);
    scaledCamera.layers.enable(CLOUD_LAYER);

    gl.getClearColor(tempClearColor);
    const savedClearAlpha = gl.getClearAlpha();
    gl.setClearColor(0x000000, 0);

    renderer.setRenderTarget(cloudRt);
    gl.autoClear = true;
    gl.render(scaledScene, scaledCamera);

    gl.setClearColor(tempClearColor, savedClearAlpha);

    // Restore default camera layer mask so consumers that reuse scaledCamera
    // (e.g. R3F's raycaster, future debug overlays) see the scaled layer.
    scaledCamera.layers.enable(0);
    scaledCamera.layers.disable(CLOUD_LAYER);

    // Pass 3: composite cloudRt → rt with premultiplied alpha blend.
    // Bilinear upsample happens automatically via the sampler.
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
  }, 1);

  return (
    <>
      {createPortal(scaled, scaledScene)}
      {createPortal(local, localScene)}
    </>
  );
};

export default SpaceRenderer;
