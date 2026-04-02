"use client";

import { memo, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { NodeMaterial } from "three/webgpu";
import {
  Fn,
  uniform,
  uv,
  vec3,
  vec4,
  float,
  pow,
  clamp,
  sin,
  mix,
  mul,
  add,
} from "three/tsl";

// ── Types ────────────────────────────────────────────────────────────
export type ExhaustConfig = {
  /** Position in ship-model local space (inside the ShipOne 0.3× group) */
  position: [number, number, number];
  /** Nozzle radius in model-local units */
  radius: number;
};

type Props = {
  /** One entry per engine nozzle */
  configs: ExhaustConfig[];
  /**
   * Ref updated every frame by the parent (Spaceship) with the current
   * thrust intensity in [0, 1]. 0 = no thrust, 1 = full thrust.
   */
  intensityRef: React.RefObject<number>;
};

// ── Tuning ───────────────────────────────────────────────────────────
/** Maximum plume length (in model-local units) at full thrust */
const PLUME_MAX_LENGTH = 4.0;
/** Segments around the cone circumference */
const PLUME_RADIAL_SEGMENTS = 16;
/** HDR brightness multiplier — pushes core above bloom threshold */
const PLUME_HDR = 12.0;
/** Point-light intensity at full thrust */
const LIGHT_INTENSITY = 2.0;
/** Point-light distance (model-local) */
const LIGHT_DISTANCE = 6.0;

// ── Shared geometry (one allocation for all exhausts) ────────────────
let _sharedGeo: THREE.ConeGeometry | null = null;
function getSharedGeometry(radius: number): THREE.ConeGeometry {
  // Geometry is reused across instances. Radius differences are handled
  // by per-instance scale, but for the common case we bake the first
  // config's radius. Callers scale X/Y to match their actual nozzle.
  if (!_sharedGeo) {
    _sharedGeo = new THREE.ConeGeometry(
      radius,
      PLUME_MAX_LENGTH,
      PLUME_RADIAL_SEGMENTS,
      1,
      true, // openEnded — no cap at the base
    );
    // Default cone: apex (point) at +Y, base (wide circle) at -Y.
    // Rotate so base sits at +Z and apex at -Z, then translate so
    // base lands at Z=0 (nozzle exit) and apex extends to -Z (behind ship).
    _sharedGeo.rotateX(-Math.PI / 2);
    _sharedGeo.translate(0, 0, -PLUME_MAX_LENGTH / 2);
  }
  return _sharedGeo;
}

// ── Reusable color for light ─────────────────────────────────────────
const LIGHT_COLOR = new THREE.Color(5.0, 7.0, 10.0);

// ── Component ────────────────────────────────────────────────────────
const EngineExhaust = memo(function EngineExhaust({
  configs,
  intensityRef,
}: Props) {
  // Refs for per-frame mutation (no React re-renders)
  const meshRefs = useRef<(THREE.Mesh | null)[]>([]);
  const lightRefs = useRef<(THREE.PointLight | null)[]>([]);

  // ── TSL uniforms (shared across all plumes) ─────────────────────
  const uIntensity = useMemo(() => uniform(0.0), []);
  const uTime = useMemo(() => uniform(0.0), []);

  // ── Geometry ────────────────────────────────────────────────────
  const geo = useMemo(
    () => getSharedGeometry(configs[0]?.radius ?? 0.3),
    [configs],
  );

  // ── TSL NodeMaterial ────────────────────────────────────────────
  const mat = useMemo(() => {
    const m = new NodeMaterial();
    m.side = THREE.DoubleSide;
    m.depthWrite = false;
    m.transparent = true;
    m.blending = THREE.AdditiveBlending;

    m.fragmentNode = Fn(() => {
      // UV.y: 0 = nozzle (base), 1 = plume tip (apex)
      const v = uv().y;

      // ── Axial falloff: bright at nozzle, fading toward tip ──
      const axial = clamp(float(1.0).sub(v), 0.0, 1.0);
      const axialFalloff = pow(axial, float(1.8));

      // ── Color: white-blue core near nozzle → deeper blue at tip ──
      // Ion/electric thruster palette (xenon-like)
      const coreColor = vec3(0.82, 0.9, 1.0); // warm white-blue
      const midColor = vec3(0.35, 0.6, 1.0); // bright blue
      const tipColor = vec3(0.12, 0.25, 0.8); // deep blue-indigo
      const color = mix(
        mix(coreColor, midColor, clamp(v.mul(2.0), 0.0, 1.0)),
        tipColor,
        clamp(v.mul(1.5).sub(0.5), 0.0, 1.0),
      );

      // ── Animated flicker (subtle, high-frequency) ──────────
      const flicker = add(
        float(0.9),
        mul(
          float(0.1),
          sin(add(mul(uTime, float(30.0)), mul(v, float(12.0)))),
        ),
      );

      // ── Secondary shimmer for realism ──────────────────────
      const shimmer = add(
        float(0.95),
        mul(
          float(0.05),
          sin(add(mul(uTime, float(47.0)), mul(v, float(7.0)))),
        ),
      );

      // ── Combine ────────────────────────────────────────────
      const brightness = mul(axialFalloff, mul(uIntensity, mul(flicker, shimmer)));
      const hdr = mul(color, mul(brightness, float(PLUME_HDR)));
      const alpha = clamp(brightness, 0.0, 1.0);

      return vec4(hdr, alpha);
    })();

    return m;
  }, [uIntensity, uTime]);

  // ── Per-frame update ────────────────────────────────────────────
  useFrame((_, delta) => {
    const intensity = intensityRef.current ?? 0;

    uIntensity.value = intensity;
    uTime.value += delta;

    // Scale plume length by intensity (Z axis); keep X/Y at 1.
    // When intensity is 0, scale Z → 0 hides the cone entirely.
    for (let i = 0; i < configs.length; i++) {
      const mesh = meshRefs.current[i];
      if (mesh) {
        const scaleXY = configs[i].radius / (configs[0]?.radius ?? 0.3);
        mesh.scale.set(scaleXY, scaleXY, Math.max(intensity, 0.001));
        mesh.visible = intensity > 0.001;
      }
      const light = lightRefs.current[i];
      if (light) {
        light.intensity = intensity * LIGHT_INTENSITY;
        light.visible = intensity > 0.01;
      }
    }
  });

  return (
    <>
      {configs.map((cfg, i) => (
        <group key={i} position={cfg.position}>
          {/* Plume cone */}
          <mesh
            ref={(m) => { meshRefs.current[i] = m; }}
            geometry={geo}
            material={mat}
            frustumCulled={false}
          />
          {/* Nozzle glow light — illuminates nearby hull */}
          <pointLight
            ref={(l) => { lightRefs.current[i] = l; }}
            color={LIGHT_COLOR}
            intensity={0}
            distance={LIGHT_DISTANCE}
            decay={2}
          />
        </group>
      ))}
    </>
  );
});

export default EngineExhaust;
