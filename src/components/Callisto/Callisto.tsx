"use client";

import { memo, useMemo } from "react";
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
  Discard,
} from "three/tsl";
import SimGroup from "../space/SimGroup";
import { kmToScaledUnits, toScaledUnitsKm } from "@/sim/units";
import { useWorldOrigin } from "@/sim/worldOrigin";
import {
  STAR_POSITION_KM,
  CALLISTO_POSITION_KM,
  CALLISTO_RADIUS_KM,
} from "@/sim/celestialConstants";

export { CALLISTO_POSITION_KM, CALLISTO_RADIUS_KM };

// ── LOD thresholds (km from Callisto center) ──
const LOD_NEAR_THRESHOLD = 50_000;
const LOD_FAR_THRESHOLD = 350_000;

// ── Reusable vectors (no per-frame allocs) ──
const _sunScaled = new THREE.Vector3();
const _callistoScaled = new THREE.Vector3();
const _sunRelative = new THREE.Vector3();
const _relativeKm = new THREE.Vector3();
const _shipToCallisto = new THREE.Vector3();

// ── Callisto average albedo for far impostor (dark, heavily cratered ice) ──
const CALLISTO_ALBEDO = new THREE.Color(0.30, 0.28, 0.25);

type CallistoProps = {
  positionKm?: [number, number, number];
  sunPositionKm?: [number, number, number];
  radiusKm?: number;
};

// ─────────────────────────────────────────────────────────────────────
// Shared fragment logic for textured sphere LODs (near + mid).
//
// Callisto: oldest, most heavily cratered surface in the solar system.
// - Dark, icy surface with ancient impact basins
// - No atmosphere → hard terminator
// - Low albedo (~0.17) — darkest of the Galilean moons
// - Opposition surge from regolith backscatter
// ─────────────────────────────────────────────────────────────────────

function buildCallistoFragmentNode(
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
    const surge = pow(NdotH, float(3.0)).mul(0.10).mul(diffuse);

    // Subtle limb darkening from surface roughness
    const viewDotN = dot(viewDir, N).max(0.05);
    const limbDark = pow(viewDotN, float(0.25));

    const col = albedo.mul(diffuse.add(surge)).mul(limbDark);

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
  const tex = useTexture({
    color: "/textures/callisto/8k_callisto.webp",
  }) as Record<string, THREE.Texture>;

  useMemo(() => {
    tex.color.colorSpace = THREE.SRGBColorSpace;
    tex.color.needsUpdate = true;
  }, [tex.color]);

  const geo = useMemo(() => {
    return new THREE.SphereGeometry(scaledRadius, 128, 128);
  }, [scaledRadius]);

  const mat = useMemo(() => {
    const m = new NodeMaterial();
    m.side = THREE.FrontSide;
    m.fragmentNode = buildCallistoFragmentNode(tex.color, uSunRel);
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
  const tex = useTexture({
    color: "/textures/callisto/2k_callisto.webp",
  }) as Record<string, THREE.Texture>;

  useMemo(() => {
    tex.color.colorSpace = THREE.SRGBColorSpace;
    tex.color.needsUpdate = true;
  }, [tex.color]);

  const geo = useMemo(() => {
    return new THREE.SphereGeometry(scaledRadius, 48, 48);
  }, [scaledRadius]);

  const mat = useMemo(() => {
    const m = new NodeMaterial();
    m.side = THREE.FrontSide;
    m.fragmentNode = buildCallistoFragmentNode(tex.color, uSunRel);
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
        0, 1,
      );

      const albedo = vec3(CALLISTO_ALBEDO.r, CALLISTO_ALBEDO.g, CALLISTO_ALBEDO.b);
      const col = albedo.mul(sunDot);

      return vec4(col, edge);
    })();

    return m;
  }, [uSpR, uSpU, uSpF, scaledRadius]);

  return { geo, mat };
}

// ─────────────────────────────────────────────────────────────────────
// Main Callisto component with LOD switching
// ─────────────────────────────────────────────────────────────────────

function Callisto({
  positionKm = CALLISTO_POSITION_KM,
  sunPositionKm = STAR_POSITION_KM,
  radiusKm = CALLISTO_RADIUS_KM,
}: CallistoProps) {
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
    // ── Sun direction relative to Callisto ──
    _relativeKm.set(positionKm[0], positionKm[1], positionKm[2]);
    _relativeKm.sub(worldOrigin.worldOriginKm);
    toScaledUnitsKm(_relativeKm, _callistoScaled);

    _relativeKm.set(sunPositionKm[0], sunPositionKm[1], sunPositionKm[2]);
    _relativeKm.sub(worldOrigin.worldOriginKm);
    toScaledUnitsKm(_relativeKm, _sunScaled);

    _sunRelative.copy(_sunScaled).sub(_callistoScaled);
    uSunRel.value.copy(_sunRelative);

    // ── LOD selection based on ship distance ──
    _shipToCallisto.set(
      positionKm[0] - worldOrigin.shipPosKm.x,
      positionKm[1] - worldOrigin.shipPosKm.y,
      positionKm[2] - worldOrigin.shipPosKm.z,
    );
    const distKm = _shipToCallisto.length();

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

      const bodyView = _shipToCallisto.clone().applyQuaternion(qInv);
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
    </SimGroup>
  );
}

// Preload textures so LOD transitions don't stall.
useTexture.preload("/textures/callisto/2k_callisto.webp");

export default memo(Callisto);
