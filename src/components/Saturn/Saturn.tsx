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
  SATURN_POSITION_KM,
  SATURN_RADIUS_KM,
} from "@/sim/celestialConstants";

export { SATURN_POSITION_KM, SATURN_RADIUS_KM };

// ── Saturn ring dimensions (km) ──
const RING_INNER_RADIUS_KM = 66_900;
const RING_OUTER_RADIUS_KM = 140_220;

// ── LOD thresholds (km from Saturn center) ──
const LOD_NEAR_THRESHOLD = 700_000;
const LOD_FAR_THRESHOLD = 16_000_000;

// ── Reusable vectors (no per-frame allocs) ──
const _sunScaled = new THREE.Vector3();
const _saturnScaled = new THREE.Vector3();
const _sunRelative = new THREE.Vector3();
const _relativeKm = new THREE.Vector3();
const _shipToSaturn = new THREE.Vector3();

// ── Saturn average albedo for far impostor (pale golden) ──
const SATURN_ALBEDO = new THREE.Color(0.62, 0.55, 0.40);

type SaturnProps = {
  positionKm?: [number, number, number];
  sunPositionKm?: [number, number, number];
  radiusKm?: number;
};

// ─────────────────────────────────────────────────────────────────────
// Ring geometry: flat annulus with radial UV mapping
// ─────────────────────────────────────────────────────────────────────

function createRingGeometry(
  innerRadius: number,
  outerRadius: number,
  segments: number,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    // Inner vertex
    positions.push(cos * innerRadius, 0, sin * innerRadius);
    uvs.push(0, 0.5);

    // Outer vertex
    positions.push(cos * outerRadius, 0, sin * outerRadius);
    uvs.push(1, 0.5);

    if (i < segments) {
      const base = i * 2;
      // Two triangles per segment — front face
      indices.push(base, base + 1, base + 2);
      indices.push(base + 1, base + 3, base + 2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// ─────────────────────────────────────────────────────────────────────
// Ring material: texture-mapped annulus with simple diffuse lighting
// ─────────────────────────────────────────────────────────────────────

function buildRingFragmentNode(
  ringTex: THREE.Texture,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSunRel: any,
) {
  return Fn(() => {
    const uvCoord = uv();
    // Ring texture is horizontal strip: u maps radially (0=inner, 1=outer)
    const samp = texture(ringTex, uvCoord);
    const albedo = samp.rgb;
    const alpha = samp.a;

    // Discard transparent gaps in the rings
    Discard(alpha.lessThan(0.05));

    const sunDir = normalize(uSunRel);

    // Rings are flat in XZ plane — normal is (0,1,0).
    // Use abs of sun's Y component for how much light hits the ring plane.
    // Mix with a base so rings aren't completely dark when edge-on.
    const sunElevation = clamp(sunDir.y.abs(), 0, 1);
    const diffuse = sunElevation.mul(0.7).add(0.3);

    const col = albedo.mul(diffuse);

    return vec4(col, alpha);
  })();
}

// ─────────────────────────────────────────────────────────────────────
// Planet fragment (same pattern as Jupiter: limb darkening, light-wrap)
// ─────────────────────────────────────────────────────────────────────

function buildSaturnFragmentNode(
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

    // Soft diffuse with atmospheric light-wrap (gas giant)
    const diffuse = clamp(NdotL.mul(0.85).add(0.15), 0, 1);

    // Limb darkening
    const viewDir = normalize(sub(cameraPosition, positionWorld));
    const viewDotN = dot(viewDir, N).max(0.05);
    const limbDark = pow(viewDotN, float(0.4));

    // Warm atmospheric haze at limb
    const limb = clamp(float(1.0).sub(viewDotN).mul(2.0), 0, 1);
    const limbPow = pow(limb, float(3.0));
    const dayMask = clamp(NdotL.mul(2.0).add(0.5), 0, 1);
    const haze = vec3(0.7, 0.55, 0.3).mul(limbPow).mul(dayMask).mul(0.08);

    // Limb desaturation
    const col = albedo.mul(diffuse).mul(limbDark).add(haze).toVar();
    const lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    const desatAmount = limbPow.mul(0.2).mul(dayMask);
    col.assign(mix(col, vec3(lum, lum, lum), desatAmount));

    return vec4(col, 1.0);
  })();
}

// ─────────────────────────────────────────────────────────────────────
// Near LOD: 8k planet + 8k rings, 128 segments
// ─────────────────────────────────────────────────────────────────────

function useNearLOD(
  scaledRadius: number,
  uSunRel: any, // eslint-disable-line @typescript-eslint/no-explicit-any
) {
  const gl = useThree((s) => s.gl);
  const tex = useTexture({
    color: "/textures/saturn/8k_saturn.webp",
    ring: "/textures/saturn/8k_saturn_ring_alpha.webp",
  }) as Record<string, THREE.Texture>;

  useMemo(() => {
    tex.color.colorSpace = THREE.SRGBColorSpace;
    tex.color.needsUpdate = true;
    tex.ring.colorSpace = THREE.SRGBColorSpace;
    tex.ring.needsUpdate = true;
  }, [tex]);

  useEffect(() => {
    for (const t of Object.values(tex)) gl.initTexture(t);
  }, [gl, tex]);

  const planetGeo = useMemo(() => {
    return new THREE.SphereGeometry(scaledRadius, 128, 128);
  }, [scaledRadius]);

  const ringGeo = useMemo(() => {
    const inner = kmToScaledUnits(RING_INNER_RADIUS_KM);
    const outer = kmToScaledUnits(RING_OUTER_RADIUS_KM);
    return createRingGeometry(inner, outer, 128);
  }, []);

  const planetMat = useMemo(() => {
    const m = new NodeMaterial();
    m.side = THREE.FrontSide;
    m.fragmentNode = buildSaturnFragmentNode(tex.color, uSunRel);
    return m;
  }, [tex, uSunRel]);

  const ringMat = useMemo(() => {
    const m = new NodeMaterial();
    m.side = THREE.DoubleSide;
    m.transparent = true;
    m.depthWrite = false;
    m.fragmentNode = buildRingFragmentNode(tex.ring, uSunRel);
    return m;
  }, [tex, uSunRel]);

  return { planetGeo, ringGeo, planetMat, ringMat };
}

// ─────────────────────────────────────────────────────────────────────
// Mid LOD: 2k planet + 2k rings, 48 segments
// ─────────────────────────────────────────────────────────────────────

function useMidLOD(
  scaledRadius: number,
  uSunRel: any, // eslint-disable-line @typescript-eslint/no-explicit-any
) {
  const tex = useTexture({
    color: "/textures/saturn/2k_saturn.webp",
    ring: "/textures/saturn/2k_saturn_ring_alpha.webp",
  }) as Record<string, THREE.Texture>;

  useMemo(() => {
    tex.color.colorSpace = THREE.SRGBColorSpace;
    tex.color.needsUpdate = true;
    tex.ring.colorSpace = THREE.SRGBColorSpace;
    tex.ring.needsUpdate = true;
  }, [tex]);

  const planetGeo = useMemo(() => {
    return new THREE.SphereGeometry(scaledRadius, 48, 48);
  }, [scaledRadius]);

  const ringGeo = useMemo(() => {
    const inner = kmToScaledUnits(RING_INNER_RADIUS_KM);
    const outer = kmToScaledUnits(RING_OUTER_RADIUS_KM);
    return createRingGeometry(inner, outer, 64);
  }, []);

  const planetMat = useMemo(() => {
    const m = new NodeMaterial();
    m.side = THREE.FrontSide;
    m.fragmentNode = buildSaturnFragmentNode(tex.color, uSunRel);
    return m;
  }, [tex, uSunRel]);

  const ringMat = useMemo(() => {
    const m = new NodeMaterial();
    m.side = THREE.DoubleSide;
    m.transparent = true;
    m.depthWrite = false;
    m.fragmentNode = buildRingFragmentNode(tex.ring, uSunRel);
    return m;
  }, [tex, uSunRel]);

  return { planetGeo, ringGeo, planetMat, ringMat };
}

// ─────────────────────────────────────────────────────────────────────
// Far LOD: billboard impostor (planet only, no rings at extreme distance)
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
      // Soft diffuse for gas giant billboard
      const diffuse = clamp(sunDot.mul(0.85).add(0.15), 0, 1);
      // Limb darkening
      const limbDark = pow(domeZ, float(0.4));

      const albedo = vec3(SATURN_ALBEDO.r, SATURN_ALBEDO.g, SATURN_ALBEDO.b);
      const col = albedo.mul(diffuse).mul(limbDark);

      return vec4(col, edge);
    })();

    return m;
  }, [uSpR, uSpU, uSpF, scaledRadius]);

  return { geo, mat };
}

// ─────────────────────────────────────────────────────────────────────
// Main Saturn component with LOD switching
// ─────────────────────────────────────────────────────────────────────

function Saturn({
  positionKm = SATURN_POSITION_KM,
  sunPositionKm = STAR_POSITION_KM,
  radiusKm = SATURN_RADIUS_KM,
}: SaturnProps) {
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

  const nearPlanetRef = useMemo(() => ({ current: null as THREE.Mesh | null }), []);
  const nearRingRef = useMemo(() => ({ current: null as THREE.Mesh | null }), []);
  const midPlanetRef = useMemo(() => ({ current: null as THREE.Mesh | null }), []);
  const midRingRef = useMemo(() => ({ current: null as THREE.Mesh | null }), []);
  const farRef = useMemo(() => ({ current: null as THREE.Mesh | null }), []);
  const nearCompiled = useMemo(() => ({ current: false }), []);

  useFrame(() => {
    // ── Sun direction relative to Saturn ──
    _relativeKm.set(positionKm[0], positionKm[1], positionKm[2]);
    _relativeKm.sub(worldOrigin.worldOriginKm);
    toScaledUnitsKm(_relativeKm, _saturnScaled);

    _relativeKm.set(sunPositionKm[0], sunPositionKm[1], sunPositionKm[2]);
    _relativeKm.sub(worldOrigin.worldOriginKm);
    toScaledUnitsKm(_relativeKm, _sunScaled);

    _sunRelative.copy(_sunScaled).sub(_saturnScaled);
    uSunRel.value.copy(_sunRelative);

    // ── LOD selection based on ship distance ──
    _shipToSaturn.set(
      positionKm[0] - worldOrigin.shipPosKm.x,
      positionKm[1] - worldOrigin.shipPosKm.y,
      positionKm[2] - worldOrigin.shipPosKm.z,
    );
    const distKm = _shipToSaturn.length();

    const showNear = distKm < LOD_NEAR_THRESHOLD;
    const showMid = !showNear && distKm < LOD_FAR_THRESHOLD;
    const showFar = !showNear && !showMid;

    if (nearPlanetRef.current) nearPlanetRef.current.visible = showNear;
    if (nearRingRef.current) nearRingRef.current.visible = showNear;
    if (midPlanetRef.current) midPlanetRef.current.visible = showMid;
    if (midRingRef.current) midRingRef.current.visible = showMid;
    if (farRef.current) farRef.current.visible = showFar;

    // ── Sun projection for far impostor billboard ──
    {
      const qInv = camera.quaternion.clone().invert();

      const sdView = new THREE.Vector3(
        sunPositionKm[0] - positionKm[0],
        sunPositionKm[1] - positionKm[1],
        sunPositionKm[2] - positionKm[2],
      ).normalize().applyQuaternion(qInv);

      const bodyView = _shipToSaturn.clone().applyQuaternion(qInv);
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
        {/* Near LOD: planet + ring */}
        <mesh
          ref={(m) => {
            nearPlanetRef.current = m;
            if (m && !nearCompiled.current) {
              nearCompiled.current = true;
              gl.compileAsync(m, camera).catch(() => {});
            }
          }}
          geometry={near.planetGeo}
          material={near.planetMat}
          visible={false}
        />
        <mesh
          ref={(m) => { nearRingRef.current = m; }}
          geometry={near.ringGeo}
          material={near.ringMat}
          visible={false}
        />
        {/* Mid LOD: planet + ring */}
        <mesh
          ref={(m) => { midPlanetRef.current = m; }}
          geometry={mid.planetGeo}
          material={mid.planetMat}
          visible={false}
        />
        <mesh
          ref={(m) => { midRingRef.current = m; }}
          geometry={mid.ringGeo}
          material={mid.ringMat}
          visible={false}
        />
        {/* Far LOD: billboard (planet only) */}
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
useTexture.preload("/textures/saturn/8k_saturn.webp");
useTexture.preload("/textures/saturn/2k_saturn.webp");
useTexture.preload("/textures/saturn/8k_saturn_ring_alpha.webp");
useTexture.preload("/textures/saturn/2k_saturn_ring_alpha.webp");

export default memo(Saturn);
