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
  VENUS_POSITION_KM,
  VENUS_RADIUS_KM,
} from "@/sim/celestialConstants";

export { VENUS_POSITION_KM, VENUS_RADIUS_KM };

// ── LOD thresholds (km from Venus center) ──
const LOD_NEAR_THRESHOLD = 50_000;
const LOD_FAR_THRESHOLD = 350_000;

// ── Reusable vectors (no per-frame allocs) ──
const _sunScaled = new THREE.Vector3();
const _venusScaled = new THREE.Vector3();
const _sunRelative = new THREE.Vector3();
const _relativeKm = new THREE.Vector3();
const _shipToVenus = new THREE.Vector3();

// ── Venus average albedo for far impostor (bright yellowish-white clouds) ──
const VENUS_ALBEDO = new THREE.Color(0.70, 0.52, 0.28);

type VenusProps = {
  positionKm?: [number, number, number];
  sunPositionKm?: [number, number, number];
  radiusKm?: number;
};

// ─────────────────────────────────────────────────────────────────────
// Shared fragment logic for textured sphere LODs (near + mid).
//
// Venus: thick sulfuric acid cloud blanket, extremely dense atmosphere.
// - Visible "surface" is opaque cloud tops — no terrain visible
// - Very high albedo (~0.77) — brightest planet
// - Thick atmosphere → very soft terminator with deep light-wrap
// - Pronounced limb brightening from forward-scattered sunlight
//   through the cloud deck (opposite of rocky planet limb darkening)
// - Warm yellowish-white palette from sulfuric acid clouds
// ─────────────────────────────────────────────────────────────────────

function buildVenusFragmentNode(
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

    // Soft diffuse with deep atmospheric light-wrap.
    // Venus's thick clouds scatter light well past the terminator.
    const diffuse = clamp(NdotL.mul(0.75).add(0.25), 0, 1);

    // Limb brightening: thick clouds forward-scatter sunlight at the limb,
    // making edges appear brighter on the lit side (opposite of airless bodies).
    const viewDir = normalize(sub(cameraPosition, positionWorld));
    const viewDotN = dot(viewDir, N).max(0.05);
    const limb = clamp(float(1.0).sub(viewDotN).mul(2.0), 0, 1);
    const limbPow = pow(limb, float(2.5));
    const limbDayMask = clamp(NdotL.mul(2.0).add(0.5), 0, 1);
    const limbBright = limbPow.mul(limbDayMask).mul(0.15);

    // Slight desaturation at limb (atmospheric scattering washes out color)
    const col = albedo.mul(diffuse).toVar();
    col.addAssign(vec3(0.72, 0.65, 0.50).mul(limbBright));

    const lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    const desatAmount = limbPow.mul(0.15).mul(limbDayMask);
    col.assign(mix(col, vec3(lum, lum, lum), desatAmount));

    return vec4(col, 1.0);
  })();
}

// ─────────────────────────────────────────────────────────────────────
// Near LOD: 4k texture, 128-segment sphere
// ─────────────────────────────────────────────────────────────────────

function useNearLOD(
  scaledRadius: number,
  uSunRel: any, // eslint-disable-line @typescript-eslint/no-explicit-any
) {
  const gl = useThree((s) => s.gl);
  const tex = useTexture({
    color: "/textures/venus/4k_venus.webp",
  }) as Record<string, THREE.Texture>;

  useMemo(() => {
    tex.color.colorSpace = THREE.SRGBColorSpace;
    tex.color.needsUpdate = true;
  }, [tex]);

  useEffect(() => {
    for (const t of Object.values(tex)) gl.initTexture(t);
  }, [gl, tex]);

  const geo = useMemo(() => {
    return new THREE.SphereGeometry(scaledRadius, 128, 128);
  }, [scaledRadius]);

  const mat = useMemo(() => {
    const m = new NodeMaterial();
    m.side = THREE.FrontSide;
    m.fragmentNode = buildVenusFragmentNode(tex.color, uSunRel);
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
    color: "/textures/venus/2k_venus.webp",
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
    m.fragmentNode = buildVenusFragmentNode(tex.color, uSunRel);
    return m;
  }, [tex, uSunRel]);

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

      // Soft diffuse with light-wrap for billboard too
      const sunDot = clamp(
        uSpR.mul(p.x).add(uSpU.mul(p.y)).add(uSpF.mul(domeZ)),
        -1, 1,
      );
      const diffuse = clamp(sunDot.mul(0.75).add(0.25), 0, 1);

      const albedo = vec3(VENUS_ALBEDO.r, VENUS_ALBEDO.g, VENUS_ALBEDO.b);
      const col = albedo.mul(diffuse);

      return vec4(col, edge);
    })();

    return m;
  }, [uSpR, uSpU, uSpF, scaledRadius]);

  return { geo, mat };
}

// ─────────────────────────────────────────────────────────────────────
// Main Venus component with LOD switching
// ─────────────────────────────────────────────────────────────────────

function Venus({
  positionKm = VENUS_POSITION_KM,
  sunPositionKm = STAR_POSITION_KM,
  radiusKm = VENUS_RADIUS_KM,
}: VenusProps) {
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
    // ── Sun direction relative to Venus ──
    _relativeKm.set(positionKm[0], positionKm[1], positionKm[2]);
    _relativeKm.sub(worldOrigin.worldOriginKm);
    toScaledUnitsKm(_relativeKm, _venusScaled);

    _relativeKm.set(sunPositionKm[0], sunPositionKm[1], sunPositionKm[2]);
    _relativeKm.sub(worldOrigin.worldOriginKm);
    toScaledUnitsKm(_relativeKm, _sunScaled);

    _sunRelative.copy(_sunScaled).sub(_venusScaled);
    uSunRel.value.copy(_sunRelative);

    // ── LOD selection based on ship distance ──
    _shipToVenus.set(
      positionKm[0] - worldOrigin.shipPosKm.x,
      positionKm[1] - worldOrigin.shipPosKm.y,
      positionKm[2] - worldOrigin.shipPosKm.z,
    );
    const distKm = _shipToVenus.length();

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

      const bodyView = _shipToVenus.clone().applyQuaternion(qInv);
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
useTexture.preload("/textures/venus/4k_venus.webp");
useTexture.preload("/textures/venus/2k_venus.webp");

export default memo(Venus);
