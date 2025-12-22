"use client";

import { useTexture } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useEffect } from "react";
import * as THREE from "three";

type Props = {
  url?: string;
};

export default function MilkyWaySkybox({
  url = "/assets/8k_stars.webp",
}: Props) {
  const tex = useTexture(url);
  const { scene } = useThree();

  useEffect(() => {
    // Correct color management for an LDR image
    tex.colorSpace = THREE.SRGBColorSpace;

    // Treat as an equirectangular panorama
    tex.mapping = THREE.EquirectangularReflectionMapping;

    // Optional: crisper stars (trade-offs: shimmering vs blur)
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    scene.backgroundIntensity = 2.0;

    tex.needsUpdate = true;
  }, [tex]);

  // Attach to *the current scene* (and since this component will live in the scaled portal,
  // it will attach to scaledScene, not the default scene)
  return <primitive attach="background" object={tex} />;
}
