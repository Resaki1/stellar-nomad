"use client";

import { createPortal, useFrame, useThree } from "@react-three/fiber";
import { ComponentProps, ReactNode, useEffect, useMemo } from "react";
import { EffectComposer } from "@react-three/postprocessing";
import * as THREE from "three";

import { SCALED_UNITS_PER_KM } from "@/sim/units";

export const LOCAL_CAMERA_NEAR = 0.01;
export const LOCAL_CAMERA_FAR = 20_000;
export const SCALED_CAMERA_NEAR = 0.001;
export const SCALED_CAMERA_FAR = 2_000_000;

type SpaceRendererProps = {
  scaled?: ReactNode;
  local?: ReactNode;
  localEffects?: ReactNode;
  composerProps?: Omit<
    ComponentProps<typeof EffectComposer>,
    "children" | "scene" | "camera"
  >;
};

const SpaceRenderer = ({
  scaled,
  local,
  localEffects,
  composerProps,
}: SpaceRendererProps) => {
  const scaledScene = useMemo(() => new THREE.Scene(), []);
  const localScene = useMemo(() => new THREE.Scene(), []);
  const scaledCamera = useMemo(() => new THREE.PerspectiveCamera(), []);

  const { camera: localCamera, gl, size } = useThree();

  useEffect(() => {
    localCamera.near = LOCAL_CAMERA_NEAR;
    localCamera.far = LOCAL_CAMERA_FAR;
    localCamera.updateProjectionMatrix();
  }, [localCamera]);

  useEffect(() => {
    scaledCamera.near = SCALED_CAMERA_NEAR;
    scaledCamera.far = SCALED_CAMERA_FAR;
    scaledCamera.updateProjectionMatrix();
  }, [scaledCamera]);

  useEffect(() => {
    scaledCamera.aspect = size.width / size.height;
    scaledCamera.fov = (localCamera as THREE.PerspectiveCamera).fov;
    scaledCamera.updateProjectionMatrix();
  }, [localCamera, scaledCamera, size.height, size.width]);

  useFrame(() => {
    scaledCamera.position.copy(localCamera.position);
    scaledCamera.position.multiplyScalar(SCALED_UNITS_PER_KM);
    scaledCamera.quaternion.copy(localCamera.quaternion);
    scaledCamera.updateMatrixWorld();

    gl.autoClear = false;
    gl.clear();
    gl.render(scaledScene, scaledCamera);
    gl.clearDepth();
  });

  useEffect(() => {
    gl.autoClear = false;
    return () => {
      gl.autoClear = true;
    };
  }, [gl]);

  useEffect(() => {
    scaledCamera.position.copy(localCamera.position).multiplyScalar(SCALED_UNITS_PER_KM);
    scaledCamera.quaternion.copy(localCamera.quaternion);
    scaledCamera.updateProjectionMatrix();
    scaledCamera.updateMatrixWorld();
  }, [localCamera, scaledCamera]);

  return (
    <>
      {createPortal(scaled, scaledScene)}
      {createPortal(local, localScene)}
      {localEffects ? (
        <EffectComposer
          scene={localScene}
          camera={localCamera as THREE.PerspectiveCamera}
          renderPriority={1}
          {...composerProps}
        >
          {localEffects}
        </EffectComposer>
      ) : null}
    </>
  );
};

export default SpaceRenderer;
