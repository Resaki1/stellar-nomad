"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { getAtmosphereLighting } from "@/components/space/atmospherePass";

// ─────────────────────────────────────────────────────────────────────
// Sky-ambient IBL fill (Phase 2 — docs/ATMOSPHERE_PLAN.md §5.4).
//
// A hemisphere light driven by the dominant atmosphere body: the ship picks up
// blue sky-fill from above and ground-bounce from below when it descends into
// the atmosphere on the day side, fading to nothing in space and at night. This
// lifts the shadowed side of the ship the way a real sky does, complementing the
// transmittance-tinted key light in SunLight.tsx.
//
// HemisphereLight derives its sky/ground axis from the (normalised) light
// position, so we point it along the planet-local up each frame — otherwise the
// split would be locked to world +Y and wrong whenever the ship isn't "upright"
// relative to the planet.
//
// Intensity/colours come from getAtmosphereLighting() (computed once per frame
// on the CPU in SpaceRenderer). Intensity is 0 when no body is in range, so in
// deep space this contributes nothing and the existing flat ambientLight is the
// only fill — i.e. the deep-space look is unchanged.
// ─────────────────────────────────────────────────────────────────────

const AtmosphereSkyLight = () => {
  const ref = useRef<THREE.HemisphereLight>(null!);

  useFrame(() => {
    const light = ref.current;
    const lighting = getAtmosphereLighting();
    if (lighting.active && lighting.skyIntensity > 0) {
      light.intensity = lighting.skyIntensity;
      light.color.copy(lighting.skyColor);
      light.groundColor.copy(lighting.groundColor);
      // Orient the hemisphere so "sky" points along the planet-local up.
      light.position.copy(lighting.upDir);
    } else {
      light.intensity = 0;
    }
  });

  return <hemisphereLight ref={ref} intensity={0} />;
};

export default AtmosphereSkyLight;
