"use client";

import { ReactNode, useEffect, useMemo, useRef } from "react";
import { createPortal, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { RenderPipeline, RenderTarget } from "three/webgpu";
import { texture } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { LOCAL_TO_SCALED_FROM_LOCAL_UNITS } from "@/sim/units";
import { HalfFloatType, CineonToneMapping, NoToneMapping } from "three";
import { useAtomValue } from "jotai/react";
import { settingsAtom } from "@/store/store";

const LOCAL_CAMERA_NEAR = 0.01;
// 20,000 km expressed in local meters
const LOCAL_CAMERA_FAR = 20_000 * 1000;
const SCALED_CAMERA_NEAR = 0.001;
const SCALED_CAMERA_FAR = 2_000_000;

const tempScaledPos = new THREE.Vector3();
const scaledScene = new THREE.Scene();
const localScene = new THREE.Scene();

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
      ? CineonToneMapping
      : NoToneMapping;

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

  useFrame(() => {
    // Skip until WebGPU backend is ready (init is async).
    if (!(gl as any).initialized) return;

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

    renderer.setRenderTarget(rt);

    // Scaled scene (skybox, stars, planets) — clear color + depth
    gl.autoClear = true;
    gl.render(scaledScene, scaledCamera);

    // Local scene (ship, asteroids, beam, lights) — clear depth only, draw on top.
    // This naturally composites local content over the scaled background,
    // including objects that don't write depth (lines, sprites, particles).
    gl.autoClear = false;
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
