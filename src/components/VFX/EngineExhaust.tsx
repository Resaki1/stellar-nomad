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
import { getPreExposure } from "@/components/space/photometry";

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
/**
 * Plume peak radiance in game units at full thrust.
 *
 * 12 game units = **72,456 cd/m²** (LIGHTING_PLAN §3.1: 1 unit = 6,038 cd/m²), which
 * is a defensible plasma-plume luminance — a sunlit cloud top is ~20,000 and an arc
 * lamp ~1e8. ⚠ So contrary to D26's original framing this is NOT badly calibrated.
 *
 * 🔑 MEASURED, and this is D26's real finding: the plume still drags metered EV from
 * −14.74 to −10.3 (**4.4 stops**) in deep space, occupying 2% of frame weight while
 * carrying ~100% of frame flux, with the hot-tail compressor already holding back
 * ~5.5 stops. That is not a units error — deep space is ~1e-4 cd/m², so a physically
 * correct plume IS ~7e8× the sky and a real eye WOULD be blinded by it. Which is why
 * real spacecraft do not put the nozzle in the pilot's field of view, and we do.
 *
 * ⇒ The remaining fix is therefore a METERING POLICY, not a value here. Do not
 * "solve" it by lowering this number: that trades a correct plume for a wrong one and
 * silently corrupts every consumer that now reads absolute luminance — S4b's
 * reflection cube, the SH probe, and Phase 8's energy-conserving glare.
 */
const PLUME_HDR = 12.0;
/**
 * Luminous intensity of a nozzle's glow light at full thrust — the light the
 * plume CASTS, as distinct from the radiance it EMITS.
 *
 * ✅ NOW DERIVED (LIGHTING_PLAN D26 step 1). It was `2.0`, flagged in this file
 * as "still an uncalibrated eyeball value… not derived from PLUME_HDR × the
 * plume's solid angle, so the plume and its illumination can disagree."
 *
 * `E = L · Ω`, and a `decay = 2` point light in three.js produces `E = I / d²`,
 * so `I = L · Ω · d²`. The plume presents its side profile to a hull point: a
 * triangle of base `2r` and height `PLUME_MAX_LENGTH`, i.e. projected area
 * `r · PLUME_MAX_LENGTH`, and `Ω ≈ area / d²`. The `d²` cancels:
 *
 *     I = PLUME_HDR · r · PLUME_MAX_LENGTH
 *
 * 🔑 Note what the cancellation means: the hull's distance from the nozzle drops
 * out entirely, so this needs no reference distance and no per-ship tuning. That
 * is the inverse-square law and the solid-angle law being the same law.
 *
 * 🔑 THE DERIVATION LANDED ON THE AUTHORED VALUE. At the nominal r = 0.3 this
 * gives **14.4** game units, against an effective authored value of **13.6** —
 * agreement to 6%, which is a genuine independent check rather than a fit,
 * because the authored side had to be computed through the hidden multiplier
 * below to even be comparable. Nobody had noticed it was already right.
 *
 * ⚠ Order-unity uncertainty: Ω is a flat-triangle stand-in for a cone seen from
 * a point beside it, and the true hull distance varies over the hull. Read this
 * as "±2×, and the shape of the answer is right", not as three digits.
 *
 * ⚠ Per-nozzle, because Ω scales with the nozzle radius — a bigger engine both
 * emits over a larger area and lights the hull more. That is the property that
 * makes this survive a ship refit, which a constant could not.
 */
function plumeLightIntensity(nozzleRadius: number): number {
  return PLUME_HDR * nozzleRadius * PLUME_MAX_LENGTH;
}
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
/**
 * ⚠⚠ WAS `new THREE.Color(5.0, 7.0, 10.0)` — A HIDDEN 6.79× MULTIPLIER.
 * three.js computes a light's contribution as `color × intensity`, so a colour
 * whose channels exceed 1 is an undeclared second intensity: the Rec709
 * luminance of (5, 7, 10) is **6.79**, which made the real intensity
 * `2.0 × 6.79 = 13.6` while the constant next to it said 2.0.
 *
 * 🔑 The same defect class as `STAR_COLOR_LINEAR`'s note and D09d's per-channel
 * clamp: a colour that is not luminance-normalised silently rescales whatever it
 * multiplies, and the number you can see stops meaning anything. Normalised to
 * luminance 1 so the hue is hue and the intensity is intensity — and the 6.79 is
 * now visible inside `plumeLightIntensity`'s derived value instead of hiding here.
 *
 * ⚠ NOT a visual change: 6.79 × 2.0 = 13.6 against the derived 14.4 (+6%).
 */
const LIGHT_COLOR = (() => {
  const c = new THREE.Color(5.0, 7.0, 10.0);
  const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return c.multiplyScalar(1 / lum);
})();

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

    // × preExposure (D25) — the plume is emissive, so nothing else scales it.
    // PLUME_HDR is calibrated (72,456 cd/m², a defensible plasma luminance) and
    // is the anchor the rest of `emissivePhotometry.ts` is read against.
    uIntensity.value = intensity * getPreExposure();
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
        // ⚠ × preExposure, like EVERY other light in the project (D25). This was
        // missing, and the asymmetry is the bug: the plume MESH above is multiplied by
        // `getPreExposure()` but its point light was not, so in a dark scene — where
        // pre-exposure runs to ~1e4–1e5 — the plume blazed while casting essentially
        // NO light on the hull. A blindingly bright exhaust that fails to illuminate
        // the ship it is attached to.
        //
        // 🔑 Same class as D27, where the bounce fill was not occluded with the key:
        // when one term of a pair gets a per-frame factor, EVERY consumer of that pair
        // needs it, and the one you forget is invisible precisely because the other
        // one looks right.
        light.intensity =
          intensity * plumeLightIntensity(configs[i].radius) * getPreExposure();
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
