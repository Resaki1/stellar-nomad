"use client";

// ─────────────────────────────────────────────────────────────────────
// StellarPoint — renders a celestial body as a bright point of light
// when it's too far away to resolve as a disc.
//
// Physics: apparent brightness is computed from the Lambert sphere
// phase function, geometric albedo, planet radius, and inverse-square
// distances to both the sun and the camera.
//
// Rendering: small opaque billboard with alphaHash and minimum screen
// size. The bright HDR core triggers the bloom pipeline for a natural
// glow halo. Uses opaque + alphaHash + depthWrite for correct depth
// occlusion by nearby planet geometry.
//
// Depth: when the renderer uses logarithmicDepthBuffer, THREE.js
// derives log depth from its internal position pipeline — which
// doesn't account for the runtime uniform scaling in our custom
// vertexNode. We fix this by passing clip.w from the vertex shader
// via a varying and computing log depth explicitly in depthNode.
//
// Brightness is normalized so Jupiter at opposition from Earth
// produces a comfortable HDR intensity (~magnitude −2.5).
//
// Usage: place inside the parent planet's <SimGroup> as a sibling
// of the far-LOD billboard mesh. The component is self-contained —
// it manages its own visibility via useFrame.
// ─────────────────────────────────────────────────────────────────────

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
  vec4,
  float,
  length,
  pow,
  clamp,
  varying,
  log2,
  cameraFar,
} from "three/tsl";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { STAR_POSITION_KM } from "@/sim/celestialConstants";

// ── Constants ────────────────────────────────────────────────────────

// Below this projected pixel diameter the planet disc is unresolvable
// and the stellar point takes over.
const STELLAR_PX_THRESHOLD = 8;

// Minimum screen diameter (pixels) for the stellar-point billboard.
// Keeps the dot visible even from across the solar system.
const MIN_SCREEN_PX = 6;

// HDR intensity for a planet with the same apparent flux as Jupiter
// at opposition from Earth (~apparent magnitude −2.5). Above the bloom
// threshold (1.0) so it picks up a natural glow halo.
const REFERENCE_HDR = 12.0;

const AU_KM = 149_597_870.7;

// Jupiter at opposition from ~4.2 AU — reference flux for normalization.
// flux = p × R² × Φ(0) / (d_sun² × d_cam²), with Φ(0) = 1 by
// definition when using geometric albedo.
const JUPITER_REF_FLUX = (() => {
  const p = 0.538; // geometric albedo
  const R = 69_911; // km
  const dSun = 5.2 * AU_KM; // km
  const dCam = 4.2 * AU_KM; // km
  return (p * R * R) / (dSun * dSun * dCam * dCam);
})();

// ── Reusable scratch vectors (safe — useFrame callbacks are sequential) ──
const _shipToBody = new THREE.Vector3();
const _bodyToSun = new THREE.Vector3();
const _bodyToCam = new THREE.Vector3();

// ── Types ────────────────────────────────────────────────────────────

export type StellarPointProps = {
  /** Body position in km (for brightness computation). */
  positionKm: [number, number, number];
  /** Sun position in km. Defaults to Sol. */
  sunPositionKm?: [number, number, number];
  /** Body radius in km. */
  radiusKm: number;
  /** Geometric albedo (0–1). Determines opposition brightness. */
  geometricAlbedo: number;
  /**
   * Characteristic point-source color [r, g, b] in 0–1 range.
   * Should approximate the body's naked-eye colour — typically
   * a desaturated tint of the surface/cloud albedo.
   */
  color: readonly [number, number, number];
};

// ── Component ────────────────────────────────────────────────────────

function StellarPoint({
  positionKm,
  sunPositionKm = STAR_POSITION_KM,
  radiusKm,
  geometricAlbedo,
  color,
}: StellarPointProps) {
  const worldOrigin = useWorldOrigin();
  const camera = useThree((s) => s.camera);

  // Billboard half-extent (scaled units). Updated per frame.
  const uScale = useMemo(() => uniform(0.001), []);
  // HDR intensity multiplier. Updated per frame from physics.
  const uBrightness = useMemo(() => uniform(0.0), []);
  // Planet tint colour (constant per body).
  const uColor = useMemo(
    () => uniform(new THREE.Vector3(color[0], color[1], color[2])),
    // Color is constant per planet — individual element deps avoid
    // reference-equality issues with tuple props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [color[0], color[1], color[2]],
  );

  const geo = useMemo(() => new THREE.PlaneGeometry(1, 1), []);

  const mat = useMemo(() => {
    const m = new NodeMaterial();
    m.side = THREE.DoubleSide;
    m.depthWrite = true;
    m.transparent = false;
    m.alphaHash = true;

    const worldCenter = modelWorldMatrix.mul(vec4(0, 0, 0, 1));

    // Varying to forward clip W to the fragment shader for log depth.
    const vLogZ = varying(float(1.0), "v_stellarLogZ");

    // ── Vertex: view-aligned billboard scaled by uniform ──
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
      // Pass W+1 for logarithmic depth — must match THREE.js internal
      // formula: gl_FragDepth = log2(w+1) * 2/(log2(far+1)) * 0.5
      vLogZ.assign(clip.w.add(1.0));
      return clip;
    })();

    // Explicit logarithmic depth output. Without this, the renderer's
    // log depth uses the internal position pipeline which doesn't see
    // the uniform scaling applied in our custom vertexNode.
    const logDepthBufFC = float(2.0).div(log2(cameraFar.add(1.0)));
    m.depthNode = log2(vLogZ).mul(logDepthBufFC).mul(0.5);

    // ── Fragment: bright HDR core, alpha falls off for alphaHash ──
    m.fragmentNode = Fn(() => {
      const p = uv().mul(2).sub(1);
      const dist = length(p);

      // Tight bright core — the bloom pipeline turns this into a glow.
      const coreFalloff = clamp(float(0.2).sub(dist).div(0.2), 0, 1);
      const core = pow(coreFalloff, float(1.2));

      // Softer halo that alphaHash stochastically keeps — bloom
      // amplifies whatever survives into a natural glow.
      const haloFalloff = clamp(float(0.6).sub(dist).div(0.6), 0, 1);
      const halo = pow(haloFalloff, float(2.5)).mul(0.4);

      const intensity = core.add(halo).mul(uBrightness);
      const col = uColor.mul(intensity);

      // Alpha drives alphaHash discard: 1.0 at the bright core,
      // falling to 0 at the billboard edge. alphaHash stochastically
      // discards low-alpha fragments, creating a soft dithered edge
      // that bloom smooths into a halo.
      const alpha = clamp(core.add(halo.mul(2.0)), 0, 1);

      return vec4(col, alpha);
    })();

    return m;
  }, [uScale, uBrightness, uColor]);

  const meshRef = useMemo(() => ({ current: null as THREE.Mesh | null }), []);

  useFrame(() => {
    // ── Distance from camera (ship) to body ──
    _shipToBody.set(
      positionKm[0] - worldOrigin.shipPosKm.x,
      positionKm[1] - worldOrigin.shipPosKm.y,
      positionKm[2] - worldOrigin.shipPosKm.z,
    );
    const distKm = _shipToBody.length();
    if (distKm < 1) {
      if (meshRef.current) meshRef.current.visible = false;
      return;
    }

    // ── Projected pixel diameter of the planet disc ──
    const cam = camera as THREE.PerspectiveCamera;
    const fovRad = cam.fov * (Math.PI / 180);
    const screenH = Math.max(window.innerHeight, 1);
    const angularDiameter = (radiusKm * 2) / distKm;
    const pixelDiameter = (angularDiameter / fovRad) * screenH;

    // Only show when the disc is too small to resolve.
    const visible = pixelDiameter < STELLAR_PX_THRESHOLD;
    if (meshRef.current) meshRef.current.visible = visible;
    if (!visible) return;

    // ── Phase angle (sun–body–camera) ──
    _bodyToSun.set(
      sunPositionKm[0] - positionKm[0],
      sunPositionKm[1] - positionKm[1],
      sunPositionKm[2] - positionKm[2],
    );
    // Camera is at the ship position → body-to-camera = −(ship-to-body)
    _bodyToCam.copy(_shipToBody).negate();

    const dSunKm = _bodyToSun.length();
    const cosPhase = _bodyToSun.normalize().dot(_bodyToCam.normalize());
    const phaseAngle = Math.acos(Math.max(-1, Math.min(1, cosPhase)));

    // Lambert sphere phase function:
    //   Φ(α) = (1/π) × [(π − α) cos α + sin α]
    // At opposition (α = 0): Φ = 1 (by definition with geometric albedo).
    // At quadrature (α = π/2): Φ ≈ 0.318.
    // At superior conjunction (α = π): Φ = 0 (fully shadowed).
    const phase =
      (1 / Math.PI) *
      ((Math.PI - phaseAngle) * Math.cos(phaseAngle) +
        Math.sin(phaseAngle));

    // ── Apparent flux (proportional) ──
    // flux = p × R² × Φ(α) / (d_sun² × d_cam²)
    const flux =
      (geometricAlbedo * radiusKm * radiusKm * phase) /
      (dSunKm * dSunKm * distKm * distKm);

    // Normalize to Jupiter reference → HDR intensity.
    const hdr = (flux / JUPITER_REF_FLUX) * REFERENCE_HDR;

    // ── Smooth fade-in ─────────────────────────────────────────────
    // Quadratic ease-in over the full threshold range. This keeps the
    // stellar point very dim when the billboard is still a few visible
    // pixels, and ramps aggressively only once it's truly sub-pixel.
    //
    //   8px → fade = 0        (invisible)
    //   6px → fade = 0.0625   (barely there — matches fading billboard)
    //   4px → fade = 0.25
    //   2px → fade = 0.5625
    //   0px → fade = 1.0      (full brightness)
    const t = (STELLAR_PX_THRESHOLD - pixelDiameter) / STELLAR_PX_THRESHOLD;
    const fade = t * t;

    // Clamp to a sane maximum — Venus at inferior conjunction can spike.
    uBrightness.value = Math.min(hdr * fade, 500);

    // ── Billboard size: guarantee minimum screen pixels ──
    const distScaled = distKm * 0.001; // km → scaled units
    const minAngle = (MIN_SCREEN_PX / screenH) * fovRad;
    const minHalf = distScaled * Math.tan(minAngle * 0.5);
    uScale.value = minHalf * 2; // PlaneGeometry spans ±0.5
  });

  return (
    <mesh
      ref={(m) => {
        meshRef.current = m;
      }}
      geometry={geo}
      material={mat}
      visible={false}
    />
  );
}

export default memo(StellarPoint);
