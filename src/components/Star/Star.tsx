"use client";

import { memo, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { NodeMaterial } from "three/webgpu";
import {
  Fn,
  uniform,
  uv,
  positionGeometry,
  modelWorldMatrix,
  cameraViewMatrix,
  cameraProjectionMatrix,
  vec3,
  vec4,
  float,
  length,
  pow,
  clamp,
  smoothstep,
  max,
  varying,
  log2,
  cameraFar,
} from "three/tsl";
import SimGroup from "../space/SimGroup";
import { kmToScaledUnits } from "@/sim/units";
import { STAR_POSITION_KM } from "@/sim/celestialConstants";
import { useWorldOrigin } from "@/sim/worldOrigin";

export { STAR_POSITION_KM };

type StarProps = {
  bloom: boolean;
};

const RADIUS_KM = 696_340;
const RADIUS = kmToScaledUnits(RADIUS_KM); // 696.34 scaled units

// ── Reusable vectors ──
const _shipToStar = new THREE.Vector3();

// ─────────────────────────────────────────────────────────────────────
// Rendered as a single view-space billboard at all distances.
//
// The billboard size is computed each frame as:
//   max(physicalGlowSize, minimumScreenSize)
//
// "physicalGlowSize" = RADIUS * GLOW_PAD. This gives the correct angular
// size for the star disc (inner portion) with glow padding around it.
// Perspective projection naturally shrinks it with distance.
//
// "minimumScreenSize" kicks in when the physical size would be too few
// pixels on screen (outer solar system). It's computed from the view-space
// depth so the billboard always covers at least MIN_SCREEN_PX pixels.
//
// The fragment shader knows what fraction of the billboard is the real
// star disc (uCoreRatio uniform). It draws:
//   - A bright core at the physically correct radius
//   - A smooth shader-baked glow that extends to the billboard edges
//
// HDR values are moderate (~60) so bloom adds a natural halo without the
// instability that extreme values (4096) cause at low pixel counts.
// The visual quality comes from the shader glow, not from bloom alone.
//
// Additive blending composites cleanly over the background.
// ─────────────────────────────────────────────────────────────────────

// Glow padding multiplier: billboard is this × the star diameter.
// At 8×, the star disc occupies the inner 12.5% of the billboard.
const GLOW_PAD = 8;

// Minimum angular coverage in pixels (diameter). Ensures the billboard
// is large enough from the outer solar system for stable rendering.
const MIN_SCREEN_PX = 60;

// Core HDR brightness — above bloom threshold (1.0) but moderate enough
// that sub-pixel drift doesn't cause visible bloom flicker.
const CORE_HDR = 4096;

function Star({ bloom: _bloom }: StarProps) {
  const worldOrigin = useWorldOrigin();
  const camera = useThree((s) => s.camera);

  // Billboard half-extent in view-space units. Updated each frame.
  const uScale = useMemo(() => uniform(RADIUS * GLOW_PAD), []);
  // Fraction of billboard radius that is the star disc [0..0.5].
  const uCoreRatio = useMemo(() => uniform(1 / GLOW_PAD), []);

  const geo = useMemo(() => new THREE.PlaneGeometry(1, 1), []);

  const mat = useMemo(() => {
    const m = new NodeMaterial();
    m.side = THREE.DoubleSide;
    m.depthWrite = false;
    m.transparent = true;
    m.blending = THREE.AdditiveBlending;

    const worldCenter = modelWorldMatrix.mul(vec4(0, 0, 0, 1));

    // Varying to forward clip W to the fragment shader for log depth.
    const vLogZ = varying(float(1.0), "v_starLogZ");

    // ── Vertex: screen-aligned billboard ──
    m.vertexNode = Fn(() => {
      const viewCenter = cameraViewMatrix.mul(worldCenter);
      const viewPos = viewCenter.add(
        vec4(
          positionGeometry.x.mul(uScale),
          positionGeometry.y.mul(uScale),
          float(0),
          float(0),
        ),
      );
      const clip = cameraProjectionMatrix.mul(viewPos);
      vLogZ.assign(clip.w.add(1.0));
      return clip;
    })();

    // Explicit logarithmic depth — custom vertexNode scaling means
    // the renderer's internal log depth doesn't match our clip output.
    const logDepthBufFC = float(2.0).div(log2(cameraFar.add(1.0)));
    m.depthNode = log2(vLogZ).mul(logDepthBufFC).mul(0.5);

    // ── Fragment: star disc + baked glow ──
    m.fragmentNode = Fn(() => {
      const p = uv().mul(2).sub(1);
      const dist = length(p);

      // Star disc: flat bright circle at the physically correct radius.
      // Smooth edge to avoid aliasing.
      const discEdge = smoothstep(
        uCoreRatio.add(uCoreRatio.mul(0.15)),
        max(uCoreRatio.sub(uCoreRatio.mul(0.15)), float(0)),
        dist,
      );
      const disc = discEdge.mul(float(CORE_HDR));

      // Inner glow: bright halo just beyond the disc. Falls off with
      // distance² for a concentrated luminous feel.
      const innerR = float(0.35);
      const innerFalloff = clamp(innerR.sub(dist).div(innerR), 0, 1);
      const innerGlow = pow(innerFalloff, float(2.5)).mul(float(CORE_HDR * 0.3));

      // Outer glow: wide soft halo extending to billboard edge.
      // Stays above bloom threshold (1.0) for the inner half.
      const outerFalloff = clamp(float(1.0).sub(dist), 0, 1);
      const outerGlow = pow(outerFalloff, float(3.5)).mul(float(8.0));

      const brightness = disc.add(innerGlow).add(outerGlow);

      // G2V star: warm white
      const color = vec3(1.0, 0.95, 0.9).mul(brightness);

      // Alpha ramps to zero at billboard edge so additive blending
      // doesn't add light where there's no glow.
      const alpha = clamp(brightness.mul(0.5), 0, 1);

      return vec4(color, alpha);
    })();

    return m;
  }, [uScale, uCoreRatio]);

  const meshRef = useMemo(() => ({ current: null as THREE.Mesh | null }), []);

  useFrame(() => {
    _shipToStar.set(
      STAR_POSITION_KM[0] - worldOrigin.shipPosKm.x,
      STAR_POSITION_KM[1] - worldOrigin.shipPosKm.y,
      STAR_POSITION_KM[2] - worldOrigin.shipPosKm.z,
    );
    const distScaled = _shipToStar.length() * 0.001;

    // Physical billboard size: star radius + glow padding.
    const physicalHalf = RADIUS * GLOW_PAD;

    // Minimum billboard size for screen-pixel stability.
    // We want at least MIN_SCREEN_PX pixels across. At view-space depth
    // `distScaled`, the billboard needs half-extent:
    //   minHalf = distScaled * tan(minAngle / 2)
    // where minAngle = MIN_SCREEN_PX / screenHeightPx * fov.
    const cam = camera as THREE.PerspectiveCamera;
    const fovRad = cam.fov * (Math.PI / 180);
    const screenH = cam.getFilmHeight()
      ? Math.max(window.innerHeight, 1)
      : 1080;
    const minAngle = (MIN_SCREEN_PX / screenH) * fovRad;
    const minHalf = distScaled * Math.tan(minAngle * 0.5);

    const halfExtent = Math.max(physicalHalf, minHalf);

    uScale.value = halfExtent * 2; // PlaneGeometry goes ±0.5, so ×2
    uCoreRatio.value = RADIUS / halfExtent;
  });

  return (
    <SimGroup space="scaled" positionKm={STAR_POSITION_KM}>
      <mesh
        ref={(m) => { meshRef.current = m; }}
        geometry={geo}
        material={mat}
      />
    </SimGroup>
  );
}

export default memo(Star);
