"use client";

import { ReactNode, useEffect, useMemo } from "react";
import { createPortal, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { LOCAL_UNITS_PER_KM, SCALED_UNITS_PER_KM } from "@/sim/units";

// Local scene renders in meters; extend the far plane to comfortably cover
// multi-hundred-kilometer gameplay volumes.
const LOCAL_CAMERA_NEAR = 0.1;
const LOCAL_CAMERA_FAR = 5_000_000; // 5,000 km
const SCALED_CAMERA_NEAR = 0.001;
const SCALED_CAMERA_FAR = 2_000_000;
const LOCAL_TO_SCALED_FACTOR = SCALED_UNITS_PER_KM / LOCAL_UNITS_PER_KM;

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
    // Convert the local camera (meters) into scaled space (kilometers).
    tempScaledPos
      .copy(localCamera.position)
      .multiplyScalar(LOCAL_TO_SCALED_FACTOR);
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
