"use client";

import { memo, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { useKTX2 } from "@/hooks/useKTX2";
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
  URANUS_POSITION_KM,
  URANUS_RADIUS_KM,
} from "@/sim/celestialConstants";

export { URANUS_POSITION_KM, URANUS_RADIUS_KM };

// ── LOD thresholds (km from Uranus center) ──
const LOD_NEAR_THRESHOLD = 600_000;
const LOD_FAR_THRESHOLD = 12_000_000;

// ── Reusable vectors (no per-frame allocs) ──
const _sunScaled = new THREE.Vector3();
const _uranusScaled = new THREE.Vector3();
const _sunRelative = new THREE.Vector3();
const _relativeKm = new THREE.Vector3();
const _shipToUranus = new THREE.Vector3();

// ── Uranus average albedo for far impostor (pale cyan-blue) ──
const URANUS_ALBEDO = new THREE.Color(0.35, 0.65, 0.70);

type UranusProps = {
  positionKm?: [number, number, number];
  sunPositionKm?: [number, number, number];
  radiusKm?: number;
};

// ─────────────────────────────────────────────────────────────────────
// Uranus fragment: ice giant with methane atmosphere.
// - Featureless pale blue-green from methane absorption
// - Thick atmosphere → soft terminator with light-wrap
// - Limb darkening from atmospheric scattering
// - Slight limb brightening on day side (forward scatter through haze)
// ─────────────────────────────────────────────────────────────────────

function buildUranusFragmentNode(
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

    // Soft diffuse with atmospheric light-wrap (ice giant)
    const diffuse = clamp(NdotL.mul(0.8).add(0.2), 0, 1);

    // Limb darkening
    const viewDir = normalize(sub(cameraPosition, positionWorld));
    const viewDotN = dot(viewDir, N).max(0.05);
    const limbDark = pow(viewDotN, float(0.35));

    // Subtle atmospheric haze at limb
    const limb = clamp(float(1.0).sub(viewDotN).mul(2.0), 0, 1);
    const limbPow = pow(limb, float(3.0));
    const dayMask = clamp(NdotL.mul(2.0).add(0.5), 0, 1);
    const haze = vec3(0.5, 0.65, 0.75).mul(limbPow).mul(dayMask).mul(0.06);

    // Limb desaturation
    const col = albedo.mul(diffuse).mul(limbDark).add(haze).toVar();
    const lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    const desatAmount = limbPow.mul(0.15).mul(dayMask);
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
  const tex = useKTX2({
    color: "/textures/uranus/8k_uranus.ktx2",
  }, '/basis/') as Record<string, THREE.Texture>;

  const geo = useMemo(() => {
    return new THREE.SphereGeometry(scaledRadius, 128, 128);
  }, [scaledRadius]);

  const mat = useMemo(() => {
    const m = new NodeMaterial();
    m.side = THREE.FrontSide;
    m.fragmentNode = buildUranusFragmentNode(tex.color, uSunRel);
    return m;
  }, [tex.color, uSunRel]);

  return { geo, mat };
}

// ─────────────────────────────────────────────────────────────────────
// Mid LOD: 2k texture, 48-segment sphere
// ─────────────────────────────────────────────────────────────────────

function useMidLOD(
  scaledRadius: number,
  uSunRel: any, // eslint-disable-line @typescript-eslint/no-explicit-any
) {
  const tex = useKTX2({
    color: "/textures/uranus/2k_uranus.ktx2",
  }, '/basis/') as Record<string, THREE.Texture>;

  const geo = useMemo(() => {
    return new THREE.SphereGeometry(scaledRadius, 48, 48);
  }, [scaledRadius]);

  const mat = useMemo(() => {
    const m = new NodeMaterial();
    m.side = THREE.FrontSide;
    m.fragmentNode = buildUranusFragmentNode(tex.color, uSunRel);
    return m;
  }, [tex.color, uSunRel]);

  return { geo, mat };
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
        -1, 1,
      );
      const diffuse = clamp(sunDot.mul(0.8).add(0.2), 0, 1);
      const limbDark = pow(domeZ, float(0.35));

      const albedo = vec3(URANUS_ALBEDO.r, URANUS_ALBEDO.g, URANUS_ALBEDO.b);
      const col = albedo.mul(diffuse).mul(limbDark);

      return vec4(col, edge);
    })();

    return m;
  }, [uSpR, uSpU, uSpF, scaledRadius]);

  return { geo, mat };
}

// ─────────────────────────────────────────────────────────────────────
// Main Uranus component with LOD switching
// ─────────────────────────────────────────────────────────────────────

function Uranus({
  positionKm = URANUS_POSITION_KM,
  sunPositionKm = STAR_POSITION_KM,
  radiusKm = URANUS_RADIUS_KM,
}: UranusProps) {
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
    _relativeKm.set(positionKm[0], positionKm[1], positionKm[2]);
    _relativeKm.sub(worldOrigin.worldOriginKm);
    toScaledUnitsKm(_relativeKm, _uranusScaled);

    _relativeKm.set(sunPositionKm[0], sunPositionKm[1], sunPositionKm[2]);
    _relativeKm.sub(worldOrigin.worldOriginKm);
    toScaledUnitsKm(_relativeKm, _sunScaled);

    _sunRelative.copy(_sunScaled).sub(_uranusScaled);
    uSunRel.value.copy(_sunRelative);

    _shipToUranus.set(
      positionKm[0] - worldOrigin.shipPosKm.x,
      positionKm[1] - worldOrigin.shipPosKm.y,
      positionKm[2] - worldOrigin.shipPosKm.z,
    );
    const distKm = _shipToUranus.length();

    const showNear = distKm < LOD_NEAR_THRESHOLD;
    const showMid = !showNear && distKm < LOD_FAR_THRESHOLD;
    const showFar = !showNear && !showMid;

    if (nearRef.current) nearRef.current.visible = showNear;
    if (midRef.current) midRef.current.visible = showMid;
    if (farRef.current) farRef.current.visible = showFar;

    {
      const qInv = camera.quaternion.clone().invert();

      const sdView = new THREE.Vector3(
        sunPositionKm[0] - positionKm[0],
        sunPositionKm[1] - positionKm[1],
        sunPositionKm[2] - positionKm[2],
      ).normalize().applyQuaternion(qInv);

      const bodyView = _shipToUranus.clone().applyQuaternion(qInv);
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
        <mesh
          ref={(m) => { farRef.current = m; }}
          geometry={far.geo}
          material={far.mat}
          visible={false}
        />
      </group>
      <StellarPoint
        positionKm={positionKm}
        sunPositionKm={sunPositionKm}
        radiusKm={radiusKm}
        geometricAlbedo={0.488}
        color={[0.62, 0.82, 0.88]}
      />
    </SimGroup>
  );
}

export default memo(Uranus);
