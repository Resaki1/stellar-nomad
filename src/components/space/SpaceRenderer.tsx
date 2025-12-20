"use client";

import { ReactNode, useEffect, useMemo } from "react";
import { createPortal, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { LOCAL_TO_SCALED_FROM_LOCAL_UNITS } from "@/sim/units";
import {
  Bloom,
  EffectComposer,
  SMAA,
  ToneMapping,
} from "@react-three/postprocessing";
import { KernelSize, RenderPass, ToneMappingMode } from "postprocessing";
import { HalfFloatType } from "three";

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

const SpaceRenderer = ({ scaled, local, postprocessing }: SpaceRendererProps) => {
  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);
  const localCamera = useThree((state) => state.camera as THREE.PerspectiveCamera);
  const localScene = useThree((state) => state.scene);

  const scaledScene = useMemo(() => new THREE.Scene(), []);
  const scaledCamera = useMemo(() => localCamera.clone(), [localCamera]);
  const localPass = useMemo(() => new RenderPass(localScene, localCamera), [localCamera, localScene]);

  useEffect(() => {
    const previous = gl.autoClear;
    gl.autoClear = false;
    return () => {
      gl.autoClear = previous;
    };
  }, [gl]);

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
    localPass.clear = false;
    localPass.clearDepth = true;
  }, [localPass]);

  useFrame(() => {
    tempScaledPos
      .copy(localCamera.position)
      .multiplyScalar(LOCAL_TO_SCALED_FROM_LOCAL_UNITS);
    scaledCamera.position.copy(tempScaledPos);
    scaledCamera.quaternion.copy(localCamera.quaternion);
  }, 1);

  return (
    <>
      {createPortal(scaled, scaledScene)}
      {createPortal(local, localScene)}
      <EffectComposer
        autoClear
        camera={scaledCamera}
        scene={scaledScene}
        enableNormalPass={false}
        frameBufferType={HalfFloatType}
        multisampling={8}
      >
        <primitive object={localPass} />
        {postprocessing?.bloom ? (
          <Bloom
            intensity={0.02}
            luminanceThreshold={1}
            kernelSize={KernelSize.VERY_SMALL}
          />
        ) : null}
        {postprocessing?.toneMapping ? (
          <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
        ) : null}
        <SMAA />
      </EffectComposer>
    </>
  );
};

export default SpaceRenderer;
