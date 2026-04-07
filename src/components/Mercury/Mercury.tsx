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
  Discard,
} from "three/tsl";
import SimGroup from "../space/SimGroup";
import StellarPoint from "../space/StellarPoint";
import { kmToScaledUnits, toScaledUnitsKm } from "@/sim/units";
import { useWorldOrigin } from "@/sim/worldOrigin";
import {
  STAR_POSITION_KM,
  MERCURY_POSITION_KM,
  MERCURY_RADIUS_KM,
} from "@/sim/celestialConstants";

export { MERCURY_POSITION_KM, MERCURY_RADIUS_KM };

// ── LOD thresholds (km from Mercury center) ──
const LOD_NEAR_THRESHOLD = 50_000;
const LOD_FAR_THRESHOLD = 350_000;

// ── Reusable vectors (no per-frame allocs) ──
const _sunScaled = new THREE.Vector3();
const _mercuryScaled = new THREE.Vector3();
const _sunRelative = new THREE.Vector3();
const _relativeKm = new THREE.Vector3();
const _shipToMercury = new THREE.Vector3();

// ── Mercury average albedo for far impostor (dark grey, Luna-like) ──
const MERCURY_ALBEDO = new THREE.Color(0.35, 0.33, 0.30);

type MercuryProps = {
  positionKm?: [number, number, number];
  sunPositionKm?: [number, number, number];
  radiusKm?: number;
};

// ─────────────────────────────────────────────────────────────────────
// Shared fragment logic for textured sphere LODs (near + mid).
//
// Mercury: heavily cratered, airless, Luna-like appearance.
// - No atmosphere → hard terminator
// - Very low albedo (~0.14) — darkest inner planet
// - Opposition surge from regolith backscatter
// - Limb darkening from surface roughness
// ─────────────────────────────────────────────────────────────────────

function buildMercuryFragmentNode(
  colorTex: THREE.Texture,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSunRel: any,
) {
  return Fn(() => {
    const uvCoord = uv();
    const sunDir = normalize(uSunRel);
    const albedo = texture(colorTex, uvCoord).rgb;

    const N = normalize(normalWorld);
    const NdotL = dot(N, sunDir);

    // Hard diffuse — no atmosphere
    const diffuse = clamp(NdotL, 0, 1);

    // Opposition surge
    const viewDir = normalize(sub(cameraPosition, positionWorld));
    const halfVec = normalize(sunDir.add(viewDir));
    const NdotH = dot(N, halfVec).max(0);
    const surge = pow(NdotH, float(3.0)).mul(0.12).mul(diffuse);

    // Limb darkening from surface roughness
    const viewDotN = dot(viewDir, N).max(0.05);
    const limbDark = pow(viewDotN, float(0.25));

    const col = albedo.mul(diffuse.add(surge)).mul(limbDark);

    return vec4(col, 1.0);
  })();
}

// ─────────────────────────────────────────────────────────────────────
// Far LOD: billboard impostor
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

      const albedo = vec3(MERCURY_ALBEDO.r, MERCURY_ALBEDO.g, MERCURY_ALBEDO.b);
      const col = albedo.mul(sunDot);

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

function TexturedLODs({ scaledRadius, uSunRel, nearRef, midRef, nearCompiled }: TexturedLODsProps) {
  const { camera, gl } = useThree((s) => ({ camera: s.camera, gl: s.gl }));

  const nearTex = useDeferredKTX2({ color: "/textures/mercury/8k_mercury.ktx2" }, '/basis/');
  const midTex = useDeferredKTX2({ color: "/textures/mercury/2k_mercury.ktx2" }, '/basis/');

  const nearGeo = useMemo(() => new THREE.SphereGeometry(scaledRadius, 128, 128), [scaledRadius]);
  const midGeo = useMemo(() => new THREE.SphereGeometry(scaledRadius, 48, 48), [scaledRadius]);

  const nearMat = useMemo(() => {
    if (!nearTex) return null;
    const m = new NodeMaterial();
    m.side = THREE.FrontSide;
    m.fragmentNode = buildMercuryFragmentNode(nearTex.color, uSunRel);
    return m;
  }, [nearTex, uSunRel]);

  const midMat = useMemo(() => {
    if (!midTex) return null;
    const m = new NodeMaterial();
    m.side = THREE.FrontSide;
    m.fragmentNode = buildMercuryFragmentNode(midTex.color, uSunRel);
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
// Main Mercury component with LOD switching
// ─────────────────────────────────────────────────────────────────────

function Mercury({
  positionKm = MERCURY_POSITION_KM,
  sunPositionKm = STAR_POSITION_KM,
  radiusKm = MERCURY_RADIUS_KM,
}: MercuryProps) {
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
    // ── Sun direction relative to Mercury ──
    _relativeKm.set(positionKm[0], positionKm[1], positionKm[2]);
    _relativeKm.sub(worldOrigin.worldOriginKm);
    toScaledUnitsKm(_relativeKm, _mercuryScaled);

    _relativeKm.set(sunPositionKm[0], sunPositionKm[1], sunPositionKm[2]);
    _relativeKm.sub(worldOrigin.worldOriginKm);
    toScaledUnitsKm(_relativeKm, _sunScaled);

    _sunRelative.copy(_sunScaled).sub(_mercuryScaled);
    uSunRel.value.copy(_sunRelative);

    // ── LOD selection based on ship distance ──
    _shipToMercury.set(
      positionKm[0] - worldOrigin.shipPosKm.x,
      positionKm[1] - worldOrigin.shipPosKm.y,
      positionKm[2] - worldOrigin.shipPosKm.z,
    );
    const distKm = _shipToMercury.length();

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

      const bodyView = _shipToMercury.clone().applyQuaternion(qInv);
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
      <group>
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
        geometricAlbedo={0.142}
        color={[0.78, 0.74, 0.70]}
      />
    </SimGroup>
  );
}

export default memo(Mercury);
