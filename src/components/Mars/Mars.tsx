"use client";

import { memo, useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { useTexture } from "@react-three/drei";
import * as THREE from "three";
import { NodeMaterial } from "three/webgpu";
import {
  Fn,
  uniform,
  texture,
  uv,
  normalWorld,
  positionWorld,
  positionGeometry,
  modelWorldMatrix,
  cameraViewMatrix,
  cameraProjectionMatrix,
  cameraPosition,
  vec3,
  vec4,
  float,
  dot,
  normalize,
  clamp,
  pow,
  sub,
  length,
  smoothstep,
  mix,
  Discard,
} from "three/tsl";
import SimGroup from "../space/SimGroup";
import { kmToScaledUnits, toScaledUnitsKm } from "@/sim/units";
import { useWorldOrigin } from "@/sim/worldOrigin";
import {
  STAR_POSITION_KM,
  MARS_POSITION_KM,
  MARS_RADIUS_KM,
} from "@/sim/celestialConstants";

export { MARS_POSITION_KM, MARS_RADIUS_KM };

// ── LOD thresholds (km from Mars center) ──
const LOD_NEAR_THRESHOLD = 36_000;
const LOD_FAR_THRESHOLD = 800_000;

// ── Mars axial tilt: 25.19° ──
const MARS_ROTATION = new THREE.Euler(0.0, 0.3 * Math.PI, 0.44 * Math.PI);

// ── Reusable vectors (no per-frame allocs) ──
const _sunScaled = new THREE.Vector3();
const _marsScaled = new THREE.Vector3();
const _sunRelative = new THREE.Vector3();
const _relativeKm = new THREE.Vector3();
const _shipToMars = new THREE.Vector3();

// ── Mars average albedo for far impostor (rusty orange-brown) ──
const MARS_ALBEDO = new THREE.Color(0.6, 0.3, 0.15);

type MarsProps = {
  positionKm?: [number, number, number];
  sunPositionKm?: [number, number, number];
  radiusKm?: number;
};

// ─────────────────────────────────────────────────────────────────────
// Mars fragment node builder (shared between near + mid LOD).
//
// Physical considerations for Mars shading:
// - No oceans → no specular water highlights
// - Extremely thin atmosphere (~1% of Earth) → minimal Rayleigh scattering
// - Iron oxide dust gives warm reddish atmospheric haze at the limb
//   (opposite of Earth's blue rim — Mars limb glows warm orange)
// - No night lights, no significant cloud layer
// - Subtle opposition surge (slight brightening at low phase angles)
// - Oren-Nayar-like diffuse for dusty rough surfaces: softer terminator
//   transition than Lambertian, dust scatters light into shadow region
// ─────────────────────────────────────────────────────────────────────

function buildMarsFragmentNode(
  colorTex: THREE.Texture,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSunRel: any,
) {
  return Fn(() => {
    const uvCoord = uv();
    const sunDir = normalize(uSunRel);

    const albedo = texture(colorTex, uvCoord).rgb;

    // Geometric normal
    const N = normalize(normalWorld);
    const NdotL = dot(N, sunDir);

    // ── Oren-Nayar approximation for dusty surface ──
    // Mars surface is very rough (regolith, dust). Pure Lambertian is too
    // harsh at the terminator. This qualitative approximation softens the
    // falloff, letting light wrap slightly into the shadow side — matching
    // how fine dust grains forward-scatter sunlight.
    const diffuse = clamp(NdotL.mul(0.85).add(0.15), 0, 1);

    // ── Warm terminator band ──
    // Sunlight passing tangent to the surface travels through the maximum
    // column of dusty atmosphere, picking up a warm reddish-orange tint.
    const terminatorMask = smoothstep(float(-0.05), float(0.3), NdotL)
      .mul(smoothstep(float(0.5), float(0.15), NdotL));
    const warmTint = vec3(1.0, 0.7, 0.45);

    // ── Atmospheric limb haze ──
    // Mars's thin CO₂ atmosphere with suspended dust creates a warm glow
    // at grazing angles. Unlike Earth's blue Rayleigh rim, Mars dust
    // scatters preferentially in the red/orange.
    const viewDir = normalize(sub(cameraPosition, positionWorld));
    const viewDotN = dot(viewDir, N).max(0.05);
    const limb = clamp(float(1.0).sub(viewDotN).mul(2.0), 0, 1);
    const limbPow = pow(limb, float(2.5));
    const hazeColor = vec3(0.75, 0.4, 0.2);
    const hazeDayMask = clamp(NdotL.mul(2.0).add(0.3), 0, 1);

    // ── Opposition surge ──
    // Slight brightening when the sun is nearly behind the viewer
    // (shadow-hiding effect in regolith). Subtle but physically real.
    const halfVec = normalize(sunDir.add(viewDir));
    const NdotH = dot(N, halfVec).max(0);
    const surge = pow(NdotH, float(4.0)).mul(0.08).mul(diffuse);

    // ── Compose ──
    const col = albedo.mul(diffuse).add(albedo.mul(surge)).toVar();

    // Terminator warmth
    col.assign(mix(col, col.mul(warmTint), terminatorMask.mul(0.2)));

    // Atmospheric limb haze (additive on lit side)
    col.addAssign(hazeColor.mul(limbPow).mul(hazeDayMask).mul(0.08));

    // Slight desaturation at extreme limb (dust extinction)
    const lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    const desatAmount = limbPow.mul(0.15).mul(hazeDayMask);
    col.assign(mix(col, vec3(lum, lum, lum), desatAmount));

    return vec4(col, 1.0);
  })();
}

// ─────────────────────────────────────────────────────────────────────
// Near LOD: 8k texture, 128-segment sphere
// ─────────────────────────────────────────────────────────────────────

function useNearLOD(
  scaledRadius: number,
  uSunRel: any, // eslint-disable-line @typescript-eslint/no-explicit-any
) {
  const gl = useThree((s) => s.gl);
  const tex = useTexture({
    color: "/textures/mars/8k_mars.webp",
  }) as Record<string, THREE.Texture>;

  useMemo(() => {
    tex.color.colorSpace = THREE.SRGBColorSpace;
    tex.color.needsUpdate = true;
  }, [tex]);

  // Force GPU upload eagerly so the mid→near LOD switch doesn't stall.
  useEffect(() => {
    for (const t of Object.values(tex)) gl.initTexture(t);
  }, [gl, tex]);

  const geo = useMemo(() => {
    return new THREE.SphereGeometry(scaledRadius, 128, 128);
  }, [scaledRadius]);

  const mat = useMemo(() => {
    const m = new NodeMaterial();
    m.side = THREE.FrontSide;
    m.fragmentNode = buildMarsFragmentNode(tex.color, uSunRel);
    return m;
  }, [tex, uSunRel]);

  return { geo, mat };
}

// ─────────────────────────────────────────────────────────────────────
// Mid LOD: 2k texture, 48-segment sphere
// ─────────────────────────────────────────────────────────────────────

function useMidLOD(
  scaledRadius: number,
  uSunRel: any, // eslint-disable-line @typescript-eslint/no-explicit-any
) {
  const tex = useTexture({
    color: "/textures/mars/2k_mars.webp",
  }) as Record<string, THREE.Texture>;

  useMemo(() => {
    tex.color.colorSpace = THREE.SRGBColorSpace;
    tex.color.needsUpdate = true;
  }, [tex]);

  const geo = useMemo(() => {
    return new THREE.SphereGeometry(scaledRadius, 48, 48);
  }, [scaledRadius]);

  const mat = useMemo(() => {
    const m = new NodeMaterial();
    m.side = THREE.FrontSide;
    m.fragmentNode = buildMarsFragmentNode(tex.color, uSunRel);
    return m;
  }, [tex, uSunRel]);

  return { geo, mat };
}

// ─────────────────────────────────────────────────────────────────────
// Far LOD: billboard impostor — warm reddish-brown disc with dusty rim
// ─────────────────────────────────────────────────────────────────────

function useFarLOD(
  scaledRadius: number,
  uSpR: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  uSpU: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  uSpF: any, // eslint-disable-line @typescript-eslint/no-explicit-any
) {
  const geo = useMemo(
    () => new THREE.PlaneGeometry(scaledRadius * 2.1, scaledRadius * 2.1),
    [scaledRadius],
  );

  const mat = useMemo(() => {
    const m = new NodeMaterial();
    m.side = THREE.DoubleSide;
    m.depthWrite = true;
    m.transparent = false;
    m.alphaHash = true;

    const worldCenter = modelWorldMatrix.mul(vec4(0, 0, 0, 1));

    m.vertexNode = Fn(() => {
      const viewCenter = cameraViewMatrix.mul(worldCenter);
      const viewPos = viewCenter.add(
        vec4(positionGeometry.xy, float(0), float(0)),
      );
      return cameraProjectionMatrix.mul(viewPos);
    })();

    m.fragmentNode = Fn(() => {
      const p = uv().mul(2).sub(1);
      const dist = length(p);

      const edge = smoothstep(float(1.0), float(0.92), dist);
      Discard(edge.lessThan(0.01));

      const domeZ = float(1.0).sub(dist.mul(dist)).max(0).sqrt();

      const sunDot = clamp(
        uSpR.mul(p.x).add(uSpU.mul(p.y)).add(uSpF.mul(domeZ)),
        0, 1,
      );

      const albedo = vec3(MARS_ALBEDO.r, MARS_ALBEDO.g, MARS_ALBEDO.b);
      const col = albedo.mul(sunDot).toVar();

      // Warm dusty atmosphere rim on lit side
      const rimFactor = clamp(float(1.0).sub(domeZ).mul(2.5), 0, 1);
      const hazeColor = vec3(12.0, 0.1, 0.05);
      col.addAssign(hazeColor.mul(rimFactor).mul(sunDot).mul(0.2));

      return vec4(col, edge);
    })();

    return m;
  }, [uSpR, uSpU, uSpF, scaledRadius]);

  return { geo, mat };
}

// ─────────────────────────────────────────────────────────────────────
// Main Mars component with LOD switching
// ─────────────────────────────────────────────────────────────────────

function Mars({
  positionKm = MARS_POSITION_KM,
  sunPositionKm = STAR_POSITION_KM,
  radiusKm = MARS_RADIUS_KM,
}: MarsProps) {
  const worldOrigin = useWorldOrigin();
  const { camera, gl } = useThree((s) => ({ camera: s.camera, gl: s.gl }));

  const scaledRadius = useMemo(() => kmToScaledUnits(radiusKm), [radiusKm]);

  const uSunRel = useMemo(() => uniform(new THREE.Vector3(0, 0, 1)), []);
  const uSpR = useMemo(() => uniform(0), []);
  const uSpU = useMemo(() => uniform(0), []);
  const uSpF = useMemo(() => uniform(0), []);

  const near = useNearLOD(scaledRadius, uSunRel);
  const mid = useMidLOD(scaledRadius, uSunRel);
  const far = useFarLOD(scaledRadius, uSpR, uSpU, uSpF);

  const nearRef = useMemo(() => ({ current: null as THREE.Mesh | null }), []);
  const midRef = useMemo(() => ({ current: null as THREE.Mesh | null }), []);
  const farRef = useMemo(() => ({ current: null as THREE.Mesh | null }), []);

  const nearCompiled = useMemo(() => ({ current: false }), []);

  useFrame(() => {
    // ── Update uniforms ──
    _relativeKm.set(positionKm[0], positionKm[1], positionKm[2]);
    _relativeKm.sub(worldOrigin.worldOriginKm);
    toScaledUnitsKm(_relativeKm, _marsScaled);

    _relativeKm.set(sunPositionKm[0], sunPositionKm[1], sunPositionKm[2]);
    _relativeKm.sub(worldOrigin.worldOriginKm);
    toScaledUnitsKm(_relativeKm, _sunScaled);

    _sunRelative.copy(_sunScaled).sub(_marsScaled);
    uSunRel.value.copy(_sunRelative);

    // ── LOD selection based on ship distance ──
    _shipToMars.set(
      positionKm[0] - worldOrigin.shipPosKm.x,
      positionKm[1] - worldOrigin.shipPosKm.y,
      positionKm[2] - worldOrigin.shipPosKm.z,
    );
    const distKm = _shipToMars.length();

    const showNear = distKm < LOD_NEAR_THRESHOLD;
    const showMid = !showNear && distKm < LOD_FAR_THRESHOLD;
    const showFar = !showNear && !showMid;

    if (nearRef.current) nearRef.current.visible = showNear;
    if (midRef.current) midRef.current.visible = showMid;
    if (farRef.current) farRef.current.visible = showFar;

    // ── Sun projection for far impostor billboard ──
    // The billboard lives in view space, so project sun direction
    // into the same space via the inverse camera quaternion.
    {
      const qInv = camera.quaternion.clone().invert();

      const sdView = new THREE.Vector3(
        sunPositionKm[0] - positionKm[0],
        sunPositionKm[1] - positionKm[1],
        sunPositionKm[2] - positionKm[2],
      ).normalize().applyQuaternion(qInv);

      const bodyView = _shipToMars.clone().applyQuaternion(qInv);
      const fw = bodyView.negate().normalize();

      const ru = Math.abs(fw.y) > 0.99
        ? new THREE.Vector3(1, 0, 0)
        : new THREE.Vector3(0, 1, 0);
      const ri = new THREE.Vector3().crossVectors(ru, fw).normalize();
      const up = new THREE.Vector3().crossVectors(fw, ri);
      uSpR.value = ri.dot(sdView);
      uSpU.value = up.dot(sdView);
      uSpF.value = fw.dot(sdView);
    }
  });

  return (
    <SimGroup space="scaled" positionKm={positionKm}>
      <group rotation={MARS_ROTATION}>
        <mesh
          ref={(m) => {
            nearRef.current = m;
            if (m && !nearCompiled.current) {
              nearCompiled.current = true;
              gl.compileAsync(m, camera).catch(() => {});
            }
          }}
          geometry={near.geo}
          material={near.mat}
          visible={false}
        />
        <mesh
          ref={(m) => { midRef.current = m; }}
          geometry={mid.geo}
          material={mid.mat}
          visible={false}
        />
      </group>
      <mesh
        ref={(m) => { farRef.current = m; }}
        geometry={far.geo}
        material={far.mat}
        visible={false}
      />
    </SimGroup>
  );
}

// Preload all textures so LOD transitions don't stall.
useTexture.preload("/textures/mars/8k_mars.webp");
useTexture.preload("/textures/mars/2k_mars.webp");

export default memo(Mars);
