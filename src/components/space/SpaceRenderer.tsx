"use client";

import { ReactNode, useEffect, useMemo } from "react";
import { createPortal, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
  BloomEffect,
  EffectComposer as EffectComposerImpl,
  EffectPass,
  KernelSize,
  Pass,
  SMAAEffect,
  ToneMappingEffect,
  ToneMappingMode,
} from "postprocessing";
import { HalfFloatType } from "three";
import { LOCAL_TO_SCALED_FROM_LOCAL_UNITS } from "@/sim/units";

const LOCAL_CAMERA_NEAR = 0.01;
// 20,000 km expressed in local meters
const LOCAL_CAMERA_FAR = 20_000 * 1000;
const SCALED_CAMERA_NEAR = 0.001;
const SCALED_CAMERA_FAR = 2_000_000;

const tempScaledPos = new THREE.Vector3();

export type SpaceRendererProps = {
  scaled: ReactNode;
  local: ReactNode;
  postprocessing?: {
    bloom: boolean;
    toneMapping: boolean;
  };
};

class DualScenePass extends Pass {
  constructor(
    private readonly scaledScene: THREE.Scene,
    private readonly scaledCamera: THREE.PerspectiveCamera,
    private readonly localScene: THREE.Scene,
    private readonly localCamera: THREE.PerspectiveCamera
  ) {
    super();
    this.clear = true;
    this.needsSwap = false;
  }

  render(
    renderer: THREE.WebGLRenderer,
    _inputBuffer: THREE.WebGLRenderTarget,
    outputBuffer: THREE.WebGLRenderTarget | null
  ) {
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer);
    if (this.clear) renderer.clear();

    renderer.render(this.scaledScene, this.scaledCamera);
    renderer.clearDepth();
    renderer.render(this.localScene, this.localCamera);

    renderer.autoClear = prevAutoClear;
  }
}

const SpaceRenderer = ({ scaled, local, postprocessing }: SpaceRendererProps) => {
  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);
  const localCamera = useThree((state) => state.camera as THREE.PerspectiveCamera);

  const scaledScene = useMemo(() => new THREE.Scene(), []);
  const localScene = useMemo(() => new THREE.Scene(), []);
  const scaledCamera = useMemo(() => localCamera.clone(), [localCamera]);
  const composer = useMemo(() => {
    const effectComposer = new EffectComposerImpl(gl, {
      frameBufferType: HalfFloatType,
      multisampling: 8,
    });

    const dualPass = new DualScenePass(scaledScene, scaledCamera, localScene, localCamera);
    dualPass.enabled = true;
    effectComposer.addPass(dualPass);

    const effects = [] as (
      | BloomEffect
      | ToneMappingEffect
      | SMAAEffect
    )[];

    if (postprocessing?.bloom) {
      effects.push(
        new BloomEffect({
          intensity: 0.02,
          luminanceThreshold: 1,
          kernelSize: KernelSize.VERY_SMALL,
        })
      );
    }

    if (postprocessing?.toneMapping) {
      effects.push(new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }));
    }

    effects.push(new SMAAEffect());

    const effectPass = new EffectPass(localCamera, ...effects);
    effectPass.renderToScreen = true;
    effectComposer.addPass(effectPass);

    return effectComposer;
  }, [gl, localCamera, localScene, postprocessing?.bloom, postprocessing?.toneMapping, scaledCamera, scaledScene]);

  useEffect(() => {
    const previous = gl.autoClear;
    gl.autoClear = false;
    return () => {
      gl.autoClear = previous;
    };
  }, [gl]);

  useEffect(() => () => composer.dispose(), [composer]);

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

  useEffect(() => {
    composer.setSize(size.width, size.height);
  }, [composer, size.height, size.width]);

  useFrame(() => {
    tempScaledPos
      .copy(localCamera.position)
      .multiplyScalar(LOCAL_TO_SCALED_FROM_LOCAL_UNITS);
    scaledCamera.position.copy(tempScaledPos);
    scaledCamera.quaternion.copy(localCamera.quaternion);

    composer.render();
  }, 1);

  return (
    <>
      {createPortal(scaled, scaledScene)}
      {createPortal(local, localScene)}
    </>
  );
};

export default SpaceRenderer;
