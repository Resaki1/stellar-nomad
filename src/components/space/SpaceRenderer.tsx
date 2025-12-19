"use client";

import { createPortal, useFrame, useThree } from "@react-three/fiber";
import { ReactNode, useEffect, useMemo } from "react";
import * as THREE from "three";
import { LOCAL_UNITS_PER_KM, SCALED_UNITS_PER_KM } from "@/sim/units";

export const LOCAL_CAMERA_NEAR = 0.01;
export const LOCAL_CAMERA_FAR = 20_000;
export const SCALED_CAMERA_NEAR = 0.001;
export const SCALED_CAMERA_FAR = 2_000_000;

type SpaceRendererProps = {
  scaled: ReactNode;
  local: ReactNode;
};

const SpaceRenderer = ({ local, scaled }: SpaceRendererProps) => {
  const { gl, camera: localCamera, size, scene } = useThree();

  const scaledScene = useMemo(() => new THREE.Scene(), []);
  const scaledCamera = useMemo(() => {
    const next = (localCamera as THREE.PerspectiveCamera).clone();
    next.near = SCALED_CAMERA_NEAR;
    next.far = SCALED_CAMERA_FAR;
    next.updateProjectionMatrix();
    return next;
  }, [localCamera]);

  useEffect(() => {
    scaledCamera.aspect = size.width / size.height;
    scaledCamera.updateProjectionMatrix();
  }, [scaledCamera, size.height, size.width]);

  useFrame(() => {
    const perspective = localCamera as THREE.PerspectiveCamera;
    scaledCamera.position
      .copy(perspective.position)
      .multiplyScalar(SCALED_UNITS_PER_KM / LOCAL_UNITS_PER_KM);
    scaledCamera.quaternion.copy(perspective.quaternion);

    gl.autoClear = false;
    gl.clear();
    gl.render(scaledScene, scaledCamera);
  }, -1);

  return (
    <>
      {createPortal(local, scene)}
      {createPortal(scaled, scaledScene)}
    </>
  );
};

export default SpaceRenderer;
