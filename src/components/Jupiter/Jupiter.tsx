"use client";

import { memo, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { useDeferredKTX2 } from "@/hooks/useDeferredKTX2";
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
import StellarPoint from "../space/StellarPoint";
import { kmToScaledUnits, toScaledUnitsKm } from "@/sim/units";
import { useWorldOrigin } from "@/sim/worldOrigin";
import {
  STAR_POSITION_KM,
  JUPITER_POSITION_KM,
  JUPITER_RADIUS_KM,
} from "@/sim/celestialConstants";

export { JUPITER_POSITION_KM, JUPITER_RADIUS_KM };

// ── LOD thresholds (km from Jupiter center) ──
// Jupiter radius 69911 km — ~10 radii near, ~230 radii far
const LOD_NEAR_THRESHOLD = 700_000;
const LOD_FAR_THRESHOLD = 16_000_000;

// ── Jupiter axial tilt: only 3.13° (nearly upright) ──
const JUPITER_ROTATION = new THREE.Euler(0.0, 0.4 * Math.PI, 0.055 * Math.PI);

// ── Reusable vectors (no per-frame allocs) ──
const _sunScaled = new THREE.Vector3();
const _jupiterScaled = new THREE.Vector3();
const _sunRelative = new THREE.Vector3();
const _relativeKm = new THREE.Vector3();
const _shipToJupiter = new THREE.Vector3();

// ── Jupiter average albedo for far impostor (warm tan/ochre) ──
const JUPITER_ALBEDO = new THREE.Color(0.65, 0.55, 0.40);

type JupiterProps = {
  positionKm?: [number, number, number];
  sunPositionKm?: [number, number, number];
  radiusKm?: number;
};

// ─────────────────────────────────────────────────────────────────────
// Jupiter fragment node builder (shared between near + mid LOD).
//
// Physical considerations for Jupiter shading:
// - Gas giant: the visible "surface" IS the cloud tops
// - Very deep, thick atmosphere → pronounced limb darkening as photons
//   at grazing angles scatter out before reaching the cloud deck
// - Ammonia crystal clouds reflect with a warm tan/ochre palette
// - No solid surface, no specular highlights
// - Softer terminator than rocky planets — sunlight scatters through
//   the upper atmosphere, wrapping light slightly past the day/night boundary
// - Subtle warm haze at the limb from molecular hydrogen Rayleigh
//   scattering (weaker than Earth's, warmer due to cloud composition)
// ─────────────────────────────────────────────────────────────────────

function buildJupiterFragmentNode(
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

    // ── Soft diffuse with atmospheric light-wrap ──
    const diffuse = clamp(NdotL.mul(0.9).add(0.1), 0, 1);

    // ── Limb darkening ──
    const viewDir = normalize(sub(cameraPosition, positionWorld));
    const viewDotN = dot(viewDir, N).max(0.05);
    const limbDarkening = pow(viewDotN, float(0.4));

    // ── Warm atmospheric limb haze ──
    const limb = clamp(float(1.0).sub(viewDotN).mul(2.0), 0, 1);
    const limbPow = pow(limb, float(3.0));
    const hazeColor = vec3(0.7, 0.55, 0.35);
    const hazeDayMask = clamp(NdotL.mul(2.0).add(0.3), 0, 1);

    // ── Compose ──
    const col = albedo.mul(diffuse).mul(limbDarkening).toVar();

    // Atmospheric limb haze (additive on lit side)
    col.addAssign(hazeColor.mul(limbPow).mul(hazeDayMask).mul(0.06));

    // Slight desaturation at extreme limb (atmospheric extinction)
    const lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    const desatAmount = limbPow.mul(0.2).mul(hazeDayMask);
    col.assign(mix(col, vec3(lum, lum, lum), desatAmount));

    return vec4(col, 1.0);
  })();
}

// ─────────────────────────────────────────────────────────────────────
// Far LOD: billboard impostor — warm tan disc with limb darkening
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

      // Limb darkening for the billboard — darken toward edges
      const limbDark = pow(domeZ, float(0.4));

      const albedo = vec3(JUPITER_ALBEDO.r, JUPITER_ALBEDO.g, JUPITER_ALBEDO.b);
      const col = albedo.mul(sunDot).mul(limbDark).toVar();

      // Subtle warm atmospheric rim on lit side
      const rimFactor = clamp(float(1.0).sub(domeZ).mul(2.5), 0, 1);
      const hazeColor = vec3(0.7, 0.55, 0.35);
      col.addAssign(hazeColor.mul(rimFactor).mul(sunDot).mul(0.06));

      return vec4(col, edge);
    })();

    return m;
  }, [uSpR, uSpU, uSpF, scaledRadius]);

  return { geo, mat };
}

// ─────────────────────────────────────────────────────────────────────
// Textured LODs (near + mid) — loaded via useDeferredKTX2 (no Suspense)
// ─────────────────────────────────────────────────────────────────────

type TexturedLODsProps = {
  scaledRadius: number;
  uSunRel: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  nearRef: { current: THREE.Mesh | null };
  midRef: { current: THREE.Mesh | null };
  nearCompiled: { current: boolean };
};

function TexturedLODs({
  scaledRadius,
  uSunRel,
  nearRef,
  midRef,
  nearCompiled,
}: TexturedLODsProps) {
  const { camera, gl } = useThree((s) => ({ camera: s.camera, gl: s.gl }));

  const nearTex = useDeferredKTX2({ color: "/textures/jupiter/8k_jupiter.ktx2" }, '/basis/');
  const midTex = useDeferredKTX2({ color: "/textures/jupiter/2k_jupiter.ktx2" }, '/basis/');

  const nearGeo = useMemo(() => new THREE.SphereGeometry(scaledRadius, 128, 128), [scaledRadius]);
  const midGeo = useMemo(() => new THREE.SphereGeometry(scaledRadius, 48, 48), [scaledRadius]);

  const nearMat = useMemo(() => {
    if (!nearTex) return null;
    const m = new NodeMaterial();
    m.side = THREE.FrontSide;
    m.fragmentNode = buildJupiterFragmentNode(nearTex.color, uSunRel);
    return m;
  }, [nearTex, uSunRel]);

  const midMat = useMemo(() => {
    if (!midTex) return null;
    const m = new NodeMaterial();
    m.side = THREE.FrontSide;
    m.fragmentNode = buildJupiterFragmentNode(midTex.color, uSunRel);
    return m;
  }, [midTex, uSunRel]);

  if (!nearMat || !midMat) return null;

  return (
    <>
      <mesh
        ref={(m) => {
          nearRef.current = m;
          if (m && !nearCompiled.current) {
            nearCompiled.current = true;
            gl.compileAsync(m, camera).catch(() => {});
          }
        }}
        geometry={nearGeo}
        material={nearMat}
        visible={false}
      />
      <mesh
        ref={(m) => { midRef.current = m; }}
        geometry={midGeo}
        material={midMat}
        visible={false}
      />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Main Jupiter component with LOD switching
// ─────────────────────────────────────────────────────────────────────

function Jupiter({
  positionKm = JUPITER_POSITION_KM,
  sunPositionKm = STAR_POSITION_KM,
  radiusKm = JUPITER_RADIUS_KM,
}: JupiterProps) {
  const worldOrigin = useWorldOrigin();
  const camera = useThree((s) => s.camera);

  const scaledRadius = useMemo(() => kmToScaledUnits(radiusKm), [radiusKm]);

  const uSunRel = useMemo(() => uniform(new THREE.Vector3(0, 0, 1)), []);
  const uSpR = useMemo(() => uniform(0), []);
  const uSpU = useMemo(() => uniform(0), []);
  const uSpF = useMemo(() => uniform(0), []);

  const far = useFarLOD(scaledRadius, uSpR, uSpU, uSpF);

  const nearRef = useMemo(() => ({ current: null as THREE.Mesh | null }), []);
  const midRef = useMemo(() => ({ current: null as THREE.Mesh | null }), []);
  const farRef = useMemo(() => ({ current: null as THREE.Mesh | null }), []);

  const nearCompiled = useMemo(() => ({ current: false }), []);

  useFrame(() => {
    // ── Update uniforms ──
    _relativeKm.set(positionKm[0], positionKm[1], positionKm[2]);
    _relativeKm.sub(worldOrigin.worldOriginKm);
    toScaledUnitsKm(_relativeKm, _jupiterScaled);

    _relativeKm.set(sunPositionKm[0], sunPositionKm[1], sunPositionKm[2]);
    _relativeKm.sub(worldOrigin.worldOriginKm);
    toScaledUnitsKm(_relativeKm, _sunScaled);

    _sunRelative.copy(_sunScaled).sub(_jupiterScaled);
    uSunRel.value.copy(_sunRelative);

    // ── LOD selection based on ship distance ──
    _shipToJupiter.set(
      positionKm[0] - worldOrigin.shipPosKm.x,
      positionKm[1] - worldOrigin.shipPosKm.y,
      positionKm[2] - worldOrigin.shipPosKm.z,
    );
    const distKm = _shipToJupiter.length();

    const showNear = distKm < LOD_NEAR_THRESHOLD;
    const showMid = !showNear && distKm < LOD_FAR_THRESHOLD;
    const showFar = !showNear && !showMid;

    if (nearRef.current) nearRef.current.visible = showNear;
    if (midRef.current) midRef.current.visible = showMid;
    if (farRef.current) farRef.current.visible = showFar;

    // ── Sun projection for far impostor billboard ──
    {
      const qInv = camera.quaternion.clone().invert();

      const sdView = new THREE.Vector3(
        sunPositionKm[0] - positionKm[0],
        sunPositionKm[1] - positionKm[1],
        sunPositionKm[2] - positionKm[2],
      ).normalize().applyQuaternion(qInv);

      const bodyView = _shipToJupiter.clone().applyQuaternion(qInv);
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
      <group rotation={JUPITER_ROTATION}>
        <TexturedLODs
          scaledRadius={scaledRadius}
          uSunRel={uSunRel}
          nearRef={nearRef}
          midRef={midRef}
          nearCompiled={nearCompiled}
        />
      </group>
      <mesh
        ref={(m) => { farRef.current = m; }}
        geometry={far.geo}
        material={far.mat}
        visible={false}
      />
      <StellarPoint
        positionKm={positionKm}
        sunPositionKm={sunPositionKm}
        radiusKm={radiusKm}
        geometricAlbedo={0.538}
        color={[0.90, 0.83, 0.65]}
      />
    </SimGroup>
  );
}

export default memo(Jupiter);
