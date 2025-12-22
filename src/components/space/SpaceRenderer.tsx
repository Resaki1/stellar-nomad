"use client";

import { ReactNode, useEffect, useMemo } from "react";
import { createPortal, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { LOCAL_TO_SCALED_FROM_LOCAL_UNITS } from "@/sim/units";
import {
  EffectComposer as PostProcessingComposer,
  RenderPass,
  EffectPass,
  SMAAEffect,
  BloomEffect,
  ToneMappingEffect,
  KernelSize,
  ToneMappingMode,
} from "postprocessing";
import { HalfFloatType } from "three";
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
  const scaledPass = useMemo(
    () => new RenderPass(scaledScene, scaledCamera),
    [scaledScene, scaledCamera]
  );
  const localPass = useMemo(
    () => new RenderPass(localScene, localCamera),
    [localScene, localCamera]
  );
  const composer = useMemo(() => {
    const newComposer = new PostProcessingComposer(gl, {
      frameBufferType: HalfFloatType,
      multisampling: 8,
    });
    return newComposer;
  }, [gl]);

  useEffect(() => {
    const previous = gl.autoClear;
    gl.autoClear = false;
    return () => {
      gl.autoClear = previous;
    };
  }, [gl]);

  useEffect(() => {
    scaledPass.clear = true;
    localPass.clear = false;

    composer.removeAllPasses();
    composer.addPass(scaledPass);
    composer.addPass(localPass);

    const effects = [] as Array<BloomEffect | ToneMappingEffect | SMAAEffect>;
    if (settings.bloom) {
      effects.push(
        new BloomEffect({
          intensity: 0.02,
          luminanceThreshold: 1,
          kernelSize: KernelSize.VERY_SMALL,
        })
      );
    }
    if (settings.toneMapping) {
      effects.push(new ToneMappingEffect({ mode: ToneMappingMode.CINEON }));
    }

    effects.push(new SMAAEffect());

    if (effects.length > 0) {
      composer.addPass(new EffectPass(localCamera, ...effects));
    }

    return () => {
      composer.removeAllPasses();
    };
  }, [
    composer,
    localCamera,
    localPass,
    settings.bloom,
    settings.toneMapping,
    scaledPass,
  ]);

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

  useEffect(() => () => composer.dispose(), [composer]);

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
