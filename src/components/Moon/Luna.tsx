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
  tangentWorld,
  bitangentWorld,
  positionWorld,
  positionLocal,
  normalLocal,
  vec2,
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
  max,
  abs,
  step,
  mix,
  cross,
  Discard,
  cameraPosition,
  positionGeometry,
  modelWorldMatrix,
  cameraViewMatrix,
  cameraProjectionMatrix,
} from "three/tsl";
import SimGroup from "../space/SimGroup";
import { kmToScaledUnits, toScaledUnitsKm } from "@/sim/units";
import { useWorldOrigin } from "@/sim/worldOrigin";
import {
  STAR_POSITION_KM,
  LUNA_POSITION_KM,
  LUNA_RADIUS_KM,
} from "@/sim/celestialConstants";

export { LUNA_POSITION_KM, LUNA_RADIUS_KM };

// ── LOD thresholds (km from Luna center) ──
const LOD_NEAR_THRESHOLD = 40_000;
const LOD_FAR_THRESHOLD = 250_000;

// ── Displacement ──
const DISPLACEMENT_SCALE_KM = 10.786; // ~10.8 km peak-to-valley (real lunar range)

// ── Reusable vectors (no per-frame allocs) ──
const _sunScaled = new THREE.Vector3();
const _lunaScaled = new THREE.Vector3();
const _sunRelative = new THREE.Vector3();
const _relativeKm = new THREE.Vector3();
const _shipToLuna = new THREE.Vector3();

// ── Moon color (average albedo for far impostor) ──
const LUNA_ALBEDO = new THREE.Color(0.44, 0.42, 0.40);

type LunaProps = {
  positionKm?: [number, number, number];
  sunPositionKm?: [number, number, number];
  radiusKm?: number;
};

// ─────────────────────────────────────────────────────────────────────
// Shared fragment logic for the textured sphere LODs (near + mid).
// ─────────────────────────────────────────────────────────────────────

function buildSphereFragmentNode(
  colorTex: THREE.Texture,
  dispTex: THREE.Texture,
  bumpStrength: number,
  texelSize: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSunRel: any,
) {
  return Fn(() => {
    const uvCoord = uv();
    const sunDir = normalize(uSunRel);
    const albedo = texture(colorTex, uvCoord).rgb;

    // ── Perturbed normal from heightmap (Sobel filter) ──
    // A 3×3 Sobel kernel smooths out compression quantisation in the
    // displacement texture that otherwise shows as blocky grid artifacts.
    // Wider sampling (3-texel radius) averages over enough neighbours to
    // hide 8-bit webp banding while preserving crater-scale features.
    const t = float(texelSize * 2.0);

    // 3×3 neighbourhood heights
    const hTL = texture(dispTex, uvCoord.add(vec2(t.negate(), t))).r;
    const hTC = texture(dispTex, uvCoord.add(vec2(0, t))).r;
    const hTR = texture(dispTex, uvCoord.add(vec2(t, t))).r;
    const hML = texture(dispTex, uvCoord.add(vec2(t.negate(), 0))).r;
    const hMR = texture(dispTex, uvCoord.add(vec2(t, 0))).r;
    const hBL = texture(dispTex, uvCoord.add(vec2(t.negate(), t.negate()))).r;
    const hBC = texture(dispTex, uvCoord.add(vec2(0, t.negate()))).r;
    const hBR = texture(dispTex, uvCoord.add(vec2(t, t.negate()))).r;

    // Sobel horizontal: [-1 0 +1; -2 0 +2; -1 0 +1]
    const gradU = hTR.add(hMR.mul(2)).add(hBR)
      .sub(hTL).sub(hML.mul(2)).sub(hBL)
      .mul(float(bumpStrength));

    // Sobel vertical:   [+1 +2 +1;  0  0  0; -1 -2 -1]
    const gradV = hTL.add(hTC.mul(2)).add(hTR)
      .sub(hBL).sub(hBC.mul(2)).sub(hBR)
      .mul(float(bumpStrength));

    // Tangent-space perturbed normal
    // @ts-ignore -- TSL MathNode inference limitation
    const tsNormal = normalize(vec3(gradU.negate(), gradV.negate(), float(1.0)));

    // TBN matrix — requires geometry with computed tangents
    // @ts-ignore -- TSL node type inference limitation
    const T: any = normalize(tangentWorld);
    // @ts-ignore -- TSL node type inference limitation
    const B: any = normalize(bitangentWorld);
    const N_geom: any = normalize(normalWorld);
    const N = normalize(
      T.mul(tsNormal.x).add(B.mul(tsNormal.y)).add(N_geom.mul(tsNormal.z)),
    );

    const NdotL = dot(N, sunDir);
    const diffuse = clamp(NdotL, 0, 1);

    const viewDir = normalize(sub(cameraPosition, positionWorld));
    const halfVec = normalize(sunDir.add(viewDir));
    const NdotH = dot(N, halfVec).max(0);
    const surge = pow(NdotH, float(3.0)).mul(0.12).mul(diffuse);

    const earthshine = float(0.002);
    const earthshineColor = vec3(0.55, 0.65, 1.0);
    const darkSideMask = clamp(NdotL.negate().mul(2.0), 0, 1);
    const darkColor = albedo
      .mul(earthshine)
      .mul(earthshineColor)
      .mul(darkSideMask);

    const col = albedo.mul(diffuse.add(surge)).add(darkColor);
    return vec4(col, 1.0);
  })();
}

function buildSpherePositionNode(
  dispTex: THREE.Texture,
  displacementScaled: number,
) {
  const uDisp = float(displacementScaled);
  return Fn(() => {
    const d = texture(dispTex, uv()).r;
    return positionLocal.add(normalLocal.mul(d.mul(uDisp)));
  })();
}

// ─────────────────────────────────────────────────────────────────────
// Near LOD: 8k textures, 128-segment sphere
// ─────────────────────────────────────────────────────────────────────

function useNearLOD(
  scaledRadius: number,
  displacementScaled: number,
  uSunRel: any, // eslint-disable-line @typescript-eslint/no-explicit-any -- TSL node type inference limitation
) {
  const gl = useThree((s) => s.gl);
  const tex = useTexture({
    color: "/textures/luna/luna_color_8k.webp",
    displacement: "/textures/luna/luna_displacement_16.webp",
  }) as Record<string, THREE.Texture>;

  useMemo(() => {
    tex.color.colorSpace = THREE.SRGBColorSpace;
    tex.color.needsUpdate = true;
    tex.displacement.colorSpace = THREE.NoColorSpace;
    tex.displacement.minFilter = THREE.LinearMipmapLinearFilter;
    tex.displacement.magFilter = THREE.LinearFilter;
    tex.displacement.needsUpdate = true;
  }, [tex]);

  // Force GPU upload eagerly so the mid→near LOD switch doesn't stall.
  useEffect(() => {
    for (const t of Object.values(tex)) gl.initTexture(t);
  }, [gl, tex]);

  const geo = useMemo(() => {
    const g = new THREE.SphereGeometry(scaledRadius, 128, 128);
    g.computeTangents();
    return g;
  }, [scaledRadius]);

  const mat = useMemo(() => {
    const m = new NodeMaterial();
    m.side = THREE.FrontSide;
    m.positionNode = buildSpherePositionNode(tex.displacement, displacementScaled);
    // Near LOD: 8k color, 16-bit displacement (assume ~4096 wide map → 1/4096 texel)
    // Sobel kernel amplifies ~4x vs central diff, so bump strength is lower.
    m.fragmentNode = buildSphereFragmentNode(tex.color, tex.displacement, 0.8, 1 / 4096, uSunRel);
    return m;
  }, [tex, uSunRel, displacementScaled]);

  return { geo, mat };
}

// ─────────────────────────────────────────────────────────────────────
// Mid LOD: 2k textures, 48-segment sphere
// ─────────────────────────────────────────────────────────────────────

function useMidLOD(
  scaledRadius: number,
  displacementScaled: number,
  uSunRel: any, // eslint-disable-line @typescript-eslint/no-explicit-any -- TSL node type inference limitation
) {
  const tex = useTexture({
    color: "/textures/luna/luna_color_2k.webp",
    displacement: "/textures/luna/luna_displacement_4.webp",
  }) as Record<string, THREE.Texture>;

  useMemo(() => {
    tex.color.colorSpace = THREE.SRGBColorSpace;
    tex.color.needsUpdate = true;
    tex.displacement.colorSpace = THREE.NoColorSpace;
    tex.displacement.minFilter = THREE.LinearMipmapLinearFilter;
    tex.displacement.magFilter = THREE.LinearFilter;
    tex.displacement.needsUpdate = true;
  }, [tex]);

  const geo = useMemo(() => {
    const g = new THREE.SphereGeometry(scaledRadius, 48, 48);
    g.computeTangents();
    return g;
  }, [scaledRadius]);

  const mat = useMemo(() => {
    const m = new NodeMaterial();
    m.side = THREE.FrontSide;
    m.positionNode = buildSpherePositionNode(tex.displacement, displacementScaled);
    // Mid LOD: 2k color, 4-bit displacement (assume ~1024 wide map → 1/1024 texel)
    m.fragmentNode = buildSphereFragmentNode(tex.color, tex.displacement, 0.6, 1 / 1024, uSunRel);
    return m;
  }, [tex, uSunRel, displacementScaled]);

  return { geo, mat };
}

// ─────────────────────────────────────────────────────────────────────
// Far LOD: billboard impostor (no geometry, no textures)
// ─────────────────────────────────────────────────────────────────────

function useFarLOD(
  scaledRadius: number,
  // Sun projection onto billboard frame, as separate floats to avoid
  // any swizzle ambiguity with vec3 uniforms in TSL.
  uSpR: any, // eslint-disable-line @typescript-eslint/no-explicit-any -- dot(right, sunDir)
  uSpU: any, // eslint-disable-line @typescript-eslint/no-explicit-any -- dot(up, sunDir)
  uSpF: any, // eslint-disable-line @typescript-eslint/no-explicit-any -- dot(fwd, sunDir)
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

    // Fragment: hemisphere shading with CPU-precomputed sun projection.
    // NdotL = spR * p.x + spU * p.y + spF * domeZ
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

      const albedo = vec3(LUNA_ALBEDO.r, LUNA_ALBEDO.g, LUNA_ALBEDO.b);
      const col = albedo.mul(sunDot);

      return vec4(col, edge);
    })();

    return m;
  }, [uSpR, uSpU, uSpF, scaledRadius]);

  return { geo, mat };
}

// ─────────────────────────────────────────────────────────────────────
// Main Luna component with LOD switching
// ─────────────────────────────────────────────────────────────────────

function Luna({
  positionKm = LUNA_POSITION_KM,
  sunPositionKm = STAR_POSITION_KM,
  radiusKm = LUNA_RADIUS_KM,
}: LunaProps) {
  const worldOrigin = useWorldOrigin();

  const scaledRadius = useMemo(() => kmToScaledUnits(radiusKm), [radiusKm]);
  const displacementScaled = useMemo(
    () => kmToScaledUnits(DISPLACEMENT_SCALE_KM),
    [],
  );

  const uSunRel = useMemo(() => uniform(new THREE.Vector3(0, 0, 1)), []);
  // Sun projection onto billboard frame — separate floats to avoid TSL issues.
  const uSpR = useMemo(() => uniform(0), []); // dot(right, sunDir)
  const uSpU = useMemo(() => uniform(0), []); // dot(up, sunDir)
  const uSpF = useMemo(() => uniform(0), []); // dot(fwd, sunDir)

  const near = useNearLOD(scaledRadius, displacementScaled, uSunRel);
  const mid = useMidLOD(scaledRadius, displacementScaled, uSunRel);
  const far = useFarLOD(scaledRadius, uSpR, uSpU, uSpF);

  // Refs for the three LOD meshes so we can toggle visibility without re-renders.
  const nearRef = useMemo(() => ({ current: null as THREE.Mesh | null }), []);
  const midRef = useMemo(() => ({ current: null as THREE.Mesh | null }), []);
  const farRef = useMemo(() => ({ current: null as THREE.Mesh | null }), []);

  useFrame(() => {
    // ── Sun direction relative to Luna ──
    _relativeKm.set(positionKm[0], positionKm[1], positionKm[2]);
    _relativeKm.sub(worldOrigin.worldOriginKm);
    toScaledUnitsKm(_relativeKm, _lunaScaled);

    _relativeKm.set(sunPositionKm[0], sunPositionKm[1], sunPositionKm[2]);
    _relativeKm.sub(worldOrigin.worldOriginKm);
    toScaledUnitsKm(_relativeKm, _sunScaled);

    _sunRelative.copy(_sunScaled).sub(_lunaScaled);
    uSunRel.value.copy(_sunRelative);

    // ── LOD selection based on ship distance ──
    _shipToLuna.set(
      positionKm[0] - worldOrigin.shipPosKm.x,
      positionKm[1] - worldOrigin.shipPosKm.y,
      positionKm[2] - worldOrigin.shipPosKm.z,
    );
    const distKm = _shipToLuna.length();

    const showNear = distKm < LOD_NEAR_THRESHOLD;
    const showMid = !showNear && distKm < LOD_FAR_THRESHOLD;
    const showFar = !showNear && !showMid;

    if (nearRef.current) nearRef.current.visible = showNear;
    if (midRef.current) midRef.current.visible = showMid;
    if (farRef.current) farRef.current.visible = showFar;

    // ── Sun projection for far impostor billboard ──
    // Build body-to-camera frame and project sun onto it.
    // Must NOT depend on camera rotation — only on body/ship/sun positions.
    {
      // Both in km space, normalized — ensures same coordinate system.
      const sd = new THREE.Vector3(
        sunPositionKm[0] - positionKm[0],
        sunPositionKm[1] - positionKm[1],
        sunPositionKm[2] - positionKm[2],
      ).normalize();
      const fw = _shipToLuna.clone().negate().normalize(); // body → camera
      const ru = Math.abs(fw.y) > 0.99
        ? new THREE.Vector3(1, 0, 0)
        : new THREE.Vector3(0, 1, 0);
      const ri = new THREE.Vector3().crossVectors(ru, fw).normalize();
      const up = new THREE.Vector3().crossVectors(fw, ri);
      uSpR.value = ri.dot(sd);
      uSpU.value = up.dot(sd);
      uSpF.value = fw.dot(sd);
    }
  });

  return (
    <SimGroup space="scaled" positionKm={positionKm}>
      <group>
        <mesh
          ref={(m) => { nearRef.current = m; }}
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

// Preload all textures so LOD transitions don't stall.
useTexture.preload("/textures/luna/luna_color_8k.webp");
useTexture.preload("/textures/luna/luna_displacement_16.webp");
useTexture.preload("/textures/luna/luna_color_2k.webp");
useTexture.preload("/textures/luna/luna_displacement_4.webp");

export default memo(Luna);
