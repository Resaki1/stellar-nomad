"use client";

import { useMemo } from "react";
import * as THREE from "three";
import { useKTX2 } from "@/hooks/useKTX2";

type Props = {
  url?: string;
};

/**
 * Renders the star panorama as a large inverted sphere instead of scene.background.
 * This avoids issues with the WebGPU renderer's internal background caching
 * when using a cloned camera in a portal scene.
 */
export default function MilkyWaySkybox({
  url = "/assets/8k_stars_nasa.ktx2",
}: Props) {
  const tex = useKTX2(url);

  const [geometry, material] = useMemo(() => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;

    tex.needsUpdate = true;

    const geo = new THREE.SphereGeometry(1, 64, 32);
    // Flip faces inward so the texture is visible from inside
    geo.scale(-1, 1, 1);

    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      side: THREE.FrontSide,
      depthWrite: false,
      toneMapped: false,
    });

    return [geo, mat];
  }, [tex]);

  // Render at a large radius within the scaled camera's far plane.
  // depthWrite=false ensures it never occludes other scaled objects.
  return (
    <mesh
      geometry={geometry}
      material={material}
      scale={[1_000_000, 1_000_000, 1_000_000]}
      frustumCulled={false}
      renderOrder={-1000}
    />
  );
}
