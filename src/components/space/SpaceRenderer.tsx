"use client";

import { ReactNode, useEffect, useMemo } from "react";
import { createPortal, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { SCALED_UNITS_PER_KM } from "@/sim/units";

const LOCAL_CAMERA_NEAR = 0.01;
const LOCAL_CAMERA_FAR = 20_000;
const SCALED_CAMERA_NEAR = 0.001;
const SCALED_CAMERA_FAR = 2_000_000;

const tempScaledPos = new THREE.Vector3();

export type SpaceRendererProps = {
  scaled: ReactNode;
  local: ReactNode;
};

const SpaceRenderer = ({ scaled, local }: SpaceRendererProps) => {
  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);
  const localCamera = useThree((state) => state.camera as THREE.PerspectiveCamera);

  const scaledScene = useMemo(() => new THREE.Scene(), []);
  const localScene = useMemo(() => new THREE.Scene(), []);
  const scaledCamera = useMemo(() => localCamera.clone(), [localCamera]);

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

  useFrame(() => {
    tempScaledPos.copy(localCamera.position).multiplyScalar(SCALED_UNITS_PER_KM);
    scaledCamera.position.copy(tempScaledPos);
    scaledCamera.quaternion.copy(localCamera.quaternion);

    gl.clear();
    gl.render(scaledScene, scaledCamera);
    gl.clearDepth();
    gl.render(localScene, localCamera);
  }, 1);

  return (
    <>
      {createPortal(scaled, scaledScene)}
      {createPortal(local, localScene)}
    </>
  );
};

export default SpaceRenderer;
