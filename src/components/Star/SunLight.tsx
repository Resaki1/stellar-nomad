"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { STAR_POSITION_KM } from "./Star";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { getAtmosphereLighting } from "@/components/space/atmospherePass";

type SunLightProps = {
  sunPositionKm?: [number, number, number];
  intensity?: number;
  color?: string | number;
};

const _dir = new THREE.Vector3();

const SunLight = ({
  sunPositionKm = STAR_POSITION_KM,
  intensity = 30,
  color = "white",
}: SunLightProps) => {
  const ref = useRef<THREE.DirectionalLight>(null!);
  const worldOrigin = useWorldOrigin();
  // Base (untinted) light colour; the atmosphere transmittance multiplies it.
  const baseColor = useMemo(() => new THREE.Color(color), [color]);

  useFrame(() => {
    // DirectionalLight.position is interpreted as a direction vector.
    // Compute sun direction relative to the ship so it stays correct
    // regardless of the world origin.
    _dir.set(
      sunPositionKm[0] - worldOrigin.shipPosKm.x,
      sunPositionKm[1] - worldOrigin.shipPosKm.y,
      sunPositionKm[2] - worldOrigin.shipPosKm.z,
    ).normalize();
    ref.current.position.copy(_dir);

    // Phase 2: tint the key light by the atmospheric transmittance reaching the
    // camera (sunset reddening + planet-shadow darkening on the ship). White
    // when no atmosphere body is in range (deep space → unchanged look).
    const lighting = getAtmosphereLighting();
    if (lighting.active) {
      ref.current.color.copy(baseColor).multiply(lighting.sunTransmittance);
    } else {
      ref.current.color.copy(baseColor);
    }
  });

  // `color` here is only the initial value — the useFrame above owns the live
  // colour (base × transmittance) every frame. Safe because localContent never
  // re-renders (Scene.tsx useMemo([])), so the prop is never re-applied.
  return (
    <directionalLight
      ref={ref}
      intensity={intensity}
      color={color}
    />
  );
};

export default SunLight;
