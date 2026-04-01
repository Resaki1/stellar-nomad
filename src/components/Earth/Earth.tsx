"use client";

import { memo, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { useKTX2 } from "@/hooks/useKTX2";
import * as THREE from "three";
import { NodeMaterial } from "three/webgpu";
import {
  Fn,
  If,
  uniform,
  texture,
  uv,
  normalWorld,
  positionWorld,
  tangentWorld,
  bitangentWorld,
  cameraPosition,
  positionGeometry,
  modelWorldMatrix,
  cameraViewMatrix,
  cameraProjectionMatrix,
  vec3,
  vec4,
  float,
  dot,
  normalize,
  mix,
  clamp,
  pow,
  exp,
  acos,
  asin,
  sin,
  reflect,
  length,
  sub,
  PI,
  smoothstep,
  Discard,
} from "three/tsl";
import SimGroup from "../space/SimGroup";
import StellarPoint from "../space/StellarPoint";
import { kmToScaledUnits, toScaledUnitsKm } from "@/sim/units";
import { useWorldOrigin } from "@/sim/worldOrigin";
import {
  STAR_POSITION_KM,
  STAR_RADIUS_KM,
  PLANET_POSITION_KM,
  LUNA_POSITION_KM,
  LUNA_RADIUS_KM,
} from "@/sim/celestialConstants";

export { PLANET_POSITION_KM };

// ── LOD thresholds (km from Earth center) ──
const LOD_NEAR_THRESHOLD = 35_000;
const LOD_FAR_THRESHOLD = 1_500_000;

const PLANET_ROTATION = new THREE.Euler(
  0.0 * Math.PI,
  0.5 * Math.PI,
  0.8 * Math.PI
);
const DEFAULT_PLANET_RADIUS_KM = 6371;
const DEFAULT_SUN_POSITION_KM = STAR_POSITION_KM;

// ── Reusable vectors (no per-frame allocs) ──
const sunScaled = new THREE.Vector3();
const moonScaled = new THREE.Vector3();
const earthScaled = new THREE.Vector3();
const sunRelative = new THREE.Vector3();
const moonRelative = new THREE.Vector3();
const relativeKm = new THREE.Vector3();
const _shipToEarth = new THREE.Vector3();

// ---------- TSL: Eclipse function ----------
const eclipseFn = Fn(
  ([
    angleBetween,
    angleLight,
    angleOcc,
  ]: [
    ReturnType<typeof float>,
    ReturnType<typeof float>,
    ReturnType<typeof float>,
  ]) => {
    const r2 = pow(angleOcc.div(angleLight), float(2));
    const v = float(1.0).toVar();

    If(
      angleBetween
        .greaterThan(angleLight.sub(angleOcc))
        .and(angleBetween.lessThan(angleLight.add(angleOcc))),
      () => {
        If(angleBetween.lessThan(angleOcc.sub(angleLight)), () => {
          v.assign(0.0);
        }).Else(() => {
          const x = float(0.5)
            .div(angleBetween)
            .mul(
              angleBetween
                .mul(angleBetween)
                .add(angleLight.mul(angleLight))
                .sub(angleOcc.mul(angleOcc))
            );
          const thL = acos(x.div(angleLight));
          const thO = acos(angleBetween.sub(x).div(angleOcc));
          v.assign(
            float(1.0)
              .div(PI)
              .mul(
                sub(PI, thL)
                  .add(float(0.5).mul(sin(thL.mul(2))))
                  .sub(thO.mul(r2))
                  .add(float(0.5).mul(r2).mul(sin(thO.mul(2))))
              )
          );
        });
      }
    )
      .ElseIf(angleBetween.greaterThan(angleLight.add(angleOcc)), () => {
        v.assign(1.0);
      })
      .Else(() => {
        v.assign(float(1.0).sub(r2));
      });

    return clamp(v, 0, 1);
  }
);

// ─────────────────────────────────────────────────────────────────────
// Shared Earth fragment node builder
// ─────────────────────────────────────────────────────────────────────

function buildEarthFragmentNode(opts: {
  texDay: THREE.Texture;
  texNight: THREE.Texture;
  texClouds: THREE.Texture;
  /** Pass null to skip normal mapping (mid LOD). */
  texNormal: THREE.Texture | null;
  /** Pass null to skip ocean specular (mid LOD). */
  texSpec: THREE.Texture | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSunRel: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uMoonPos: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uMoonRadius: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSunRadius: any;
}) {
  const {
    texDay, texNight, texClouds, texNormal, texSpec,
    uSunRel, uMoonPos, uMoonRadius, uSunRadius,
  } = opts;
  const detailed = texNormal !== null;

  return Fn(() => {
    const uvCoord = uv();
    const sunDir = normalize(uSunRel);

    const dayCol = texture(texDay, uvCoord).rgb;
    const nightCol = texture(texNight, uvCoord).rgb.mul(float(0.35));

    // Geometric normal in world space
    const nGeom = normalize(normalWorld);
    const cosSunToGeomNormal = dot(nGeom, sunDir);

    // ── Day/night transition ──
    const dayAmount = float(1.0)
      .div(float(1.0).add(exp(float(-10).mul(cosSunToGeomNormal))))
      .toVar();
    const hemiAmount = dayAmount.toVar();

    // ── Eclipse calculation ──
    const surfacePosW = positionWorld;
    const distEarthToSun = length(uSunRel);
    const moonToSurf = sub(uMoonPos, surfacePosW);
    const distSurfToMoon = length(moonToSurf);

    const cosSunMoon = dot(sunDir, normalize(moonToSurf));
    const angSunMoon = acos(clamp(cosSunMoon, -1, 1));
    const angSunDisk = asin(
      clamp(uSunRadius.div(distEarthToSun), 0, 1)
    );
    const angMoonDisk = asin(
      clamp(uMoonRadius.div(distSurfToMoon), 0, 1)
    );

    hemiAmount.mulAssign(eclipseFn(angSunMoon, angSunDisk, angMoonDisk));

    // ── Detail-dependent: normal mapping + cloud shadow ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let nMapped: any = nGeom;

    if (detailed && texNormal) {
      // Normal mapping via TBN
      const tN = texture(texNormal, uvCoord).xyz.mul(2).sub(1);
      // @ts-ignore – TSL node type inference limitation
      const tW = normalize(tangentWorld) as any;
      // @ts-ignore – TSL node type inference limitation
      const bW = normalize(bitangentWorld) as any;
      nMapped = normalize(
        tW.mul(tN.x).add(bW.mul(tN.y)).add(nGeom.mul(tN.z))
      );

      const cosSunToMappedNormal = dot(nMapped, sunDir);
      dayAmount.mulAssign(
        float(1.0).add(
          float(0.8).mul(cosSunToMappedNormal.sub(cosSunToGeomNormal))
        )
      );

      // Cloud shadow: offset UV along sun direction in tangent space
      const delta = nGeom.sub(sunDir).mul(0.0006);
      const deltaT = vec3(dot(tW, delta), dot(bW, delta), dot(nGeom, delta));
      const cloudShadow = texture(texClouds, uvCoord.sub(deltaT.xy)).r;
      dayAmount.mulAssign(float(1.0).sub(float(0.65).mul(cloudShadow)));
    }

    dayAmount.mulAssign(hemiAmount);
    dayAmount.assign(clamp(dayAmount, 0, 1));

    // ── Terminator warm tones (Rayleigh at low sun angles) ──
    const tA = clamp(dayAmount.div(0.5), 0, 1);
    const ssA = tA.mul(tA).mul(float(3.0).sub(tA.mul(2.0)));
    const tB = clamp(float(1.0).sub(dayAmount).div(0.5), 0, 1);
    const ssB = tB.mul(tB).mul(float(3.0).sub(tB.mul(2.0)));
    const terminatorBand = ssA.mul(ssB);
    const warmTint = vec3(1.0, 0.6, 0.3);

    // ── Clouds ──
    const cloudMask = texture(texClouds, uvCoord).r
      .mul(float(0.8))
      .toVar();

    // Night mask (sharper city-light cutoff)
    const tN2 = clamp(float(0.15).sub(dayAmount).div(0.15), 0, 1);
    const nightMask = tN2.mul(tN2).mul(float(3.0).sub(tN2.mul(2.0)));
    const col = mix(nightCol.mul(nightMask), dayCol, dayAmount).toVar();

    // Apply terminator warmth — reduced for mid LOD where the smooth geometric
    // normal makes the band bleed across the entire day side.
    const terminatorStrength = float(detailed ? 0.25 : 0.06);
    col.assign(mix(col, col.mul(warmTint), terminatorBand.mul(terminatorStrength)));

    // ── Ocean specular ──
    const viewDir = normalize(cameraPosition.sub(surfacePosW));

    if (texSpec) {
      const specMask = texture(texSpec, uvCoord).r;
      const refl = reflect(sunDir.negate(), nMapped);
      const specAngle = dot(refl, viewDir).max(0);
      const specHighlight = pow(specAngle, float(80.0)).mul(1.8).mul(specMask);
      const specBroad = pow(specAngle, float(8.0)).mul(0.15).mul(specMask);
      col.addAssign(dayAmount.mul(specHighlight.add(specBroad)));
    }

    // ── Cloud overlay ──
    const cloudSunFactor = clamp(
      cosSunToGeomNormal.mul(4.0).add(0.9),
      0,
      1
    );
    const csf = cloudSunFactor
      .mul(cloudSunFactor)
      .mul(float(5.0).sub(cloudSunFactor.mul(2.0)));

    // Cloud color: white in full sunlight, warm at the terminator.
    // Use cosSunToGeomNormal directly (not terminatorBand which depends on
    // dayAmount and is affected by cloud shadow in the near LOD).
    const cloudSunBlend = clamp(cosSunToGeomNormal.mul(3.0), 0, 1);
    const cloudWhite = vec3(1.12, 1.12, 1.12);
    const cloudWarm = vec3(0.7, 0.4, 0.3);
    const cloudBaseCol = mix(cloudWarm, cloudWhite, cloudSunBlend);
    const cloudLit = cloudBaseCol.mul(csf);
    col.assign(mix(col, cloudLit, clamp(cloudMask, 0, 1)));

    // ── Rayleigh scattering (in-scatter + extinction) ──
    const viewDotN = dot(viewDir, nGeom).max(0.08);
    const opticalDepth = clamp(float(1.0).div(viewDotN), 1, 12);
    const scatter01 = clamp(opticalDepth.sub(1).div(11), 0, 1);

    const hazeDayMask = clamp(hemiAmount.mul(2.0), 0, 1);

    // Extinction: desaturate as optical depth increases
    const luminance = dot(col, vec3(0.2126, 0.7152, 0.0722));
    const desatAmount = scatter01.mul(0.4).add(0.1).mul(hazeDayMask);
    col.assign(mix(col, vec3(luminance, luminance, luminance), desatAmount));

    // In-scatter: blue Rayleigh light
    const rayleighColor = vec3(0.3, 0.5, 0.9);
    const inScatterBase = float(0.08);
    const inScatterLimb = pow(scatter01, float(1.2)).mul(0.75);
    const inScatter = inScatterBase.add(inScatterLimb).mul(hazeDayMask);
    col.assign(mix(col, rayleighColor, inScatter));

    return vec4(col, 1.0);
  })();
}

// ─────────────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────────────
// Near LOD: 8k textures + normal + specular, 128-segment sphere
// ─────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function useNearLOD(scaledRadius: number, uniforms: any) {
  const tex = useKTX2({
    day: "/textures/earth_day_8k.ktx2",
    night: "/textures/earth_night_8k.ktx2",
    clouds: "/textures/earth_clouds_8k.ktx2",
    normal: "/textures/earth_normal.ktx2",
    spec: "/textures/earth_specular.ktx2",
  }, '/basis/') as Record<string, THREE.Texture>;

  useMemo(() => {
    tex.clouds.anisotropy = 8;
  }, [tex.clouds]);

  const geo = useMemo(() => {
    const g = new THREE.SphereGeometry(scaledRadius, 128, 128);
    g.computeTangents();
    return g;
  }, [scaledRadius]);

  const mat = useMemo(() => {
    const m = new NodeMaterial();
    m.side = THREE.FrontSide;
    m.fragmentNode = buildEarthFragmentNode({
      texDay: tex.day,
      texNight: tex.night,
      texClouds: tex.clouds,
      texNormal: tex.normal,
      texSpec: tex.spec,
      ...uniforms,
    });
    return m;
  }, [tex.day, tex.night, tex.clouds, tex.normal, tex.spec, uniforms]);

  return { geo, mat };
}

// ─────────────────────────────────────────────────────────────────────
// Mid LOD: 2k textures + specular, no normal mapping, 48-segment sphere
// ─────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function useMidLOD(scaledRadius: number, uniforms: any) {
  const tex = useKTX2({
    day: "/textures/earth_day_2k.ktx2",
    night: "/textures/earth_night_2k.ktx2",
    clouds: "/textures/earth_clouds_2k.ktx2",
    spec: "/textures/earth_specular.ktx2",
  }, '/basis/') as Record<string, THREE.Texture>;

  useMemo(() => {
    tex.clouds.anisotropy = 4;
  }, [tex.clouds]);

  const geo = useMemo(() => {
    return new THREE.SphereGeometry(scaledRadius, 48, 48);
  }, [scaledRadius]);

  const mat = useMemo(() => {
    const m = new NodeMaterial();
    m.side = THREE.FrontSide;
    m.fragmentNode = buildEarthFragmentNode({
      texDay: tex.day,
      texNight: tex.night,
      texClouds: tex.clouds,
      texNormal: null,
      texSpec: tex.spec,
      ...uniforms,
    });
    return m;
  }, [tex.day, tex.night, tex.clouds, tex.spec, uniforms]);

  return { geo, mat };
}

// ─────────────────────────────────────────────────────────────────────
// Far LOD: billboard impostor
// ─────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function useFarLOD(scaledRadius: number, uSpR: any, uSpU: any, uSpF: any) {
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

      // Earth-like coloring.
      const dayAlbedo = vec3(0.38, 0.42, 0.80).mul(2.0);
      const col = dayAlbedo.mul(sunDot).toVar();

      // Atmosphere rim glow on lit side.
      const rimFactor = clamp(float(1.0).sub(domeZ).mul(2.5), 0, 1);
      const atmosColor = vec3(0.3, 0.5, 0.9);
      col.addAssign(atmosColor.mul(rimFactor).mul(sunDot).mul(0.2));

      return vec4(col, edge);
    })();

    return m;
  }, [uSpR, uSpU, uSpF, scaledRadius]);

  return { geo, mat };
}

// ─────────────────────────────────────────────────────────────────────
// Main Planet component with LOD switching
// ─────────────────────────────────────────────────────────────────────

type PlanetProps = {
  positionKm?: [number, number, number];
  sunPositionKm?: [number, number, number];
  moonPositionKm?: [number, number, number];
  moonRadiusKm?: number;
  sunRadiusKm?: number;
  radiusKm?: number;
};

function Planet({
  positionKm = PLANET_POSITION_KM,
  sunPositionKm = DEFAULT_SUN_POSITION_KM,
  moonPositionKm = LUNA_POSITION_KM,
  moonRadiusKm = LUNA_RADIUS_KM,
  sunRadiusKm = STAR_RADIUS_KM,
  radiusKm = DEFAULT_PLANET_RADIUS_KM,
}: PlanetProps) {
  const worldOrigin = useWorldOrigin();
  const { camera, gl } = useThree((s) => ({ camera: s.camera, gl: s.gl }));

  const scaledRadius = useMemo(() => kmToScaledUnits(radiusKm), [radiusKm]);

  // TSL uniforms (shared across LOD materials)
  const uSunRel = useMemo(() => uniform(new THREE.Vector3(0, 0, 1)), []);
  // Sun projection onto billboard frame — separate floats, camera axes.
  const uSpR = useMemo(() => uniform(0), []);
  const uSpU = useMemo(() => uniform(0), []);
  const uSpF = useMemo(() => uniform(0), []);
  const uMoonPos = useMemo(
    () => uniform(new THREE.Vector3(1e9, 0, 0)),
    []
  );
  const uMoonRadius = useMemo(
    () => uniform(kmToScaledUnits(moonRadiusKm)),
    [moonRadiusKm]
  );
  const uSunRadius = useMemo(
    () => uniform(kmToScaledUnits(sunRadiusKm)),
    [sunRadiusKm]
  );

  // Bundle uniforms for LOD hooks
  const uniforms = useMemo(
    () => ({ uSunRel, uMoonPos, uMoonRadius, uSunRadius }),
    [uSunRel, uMoonPos, uMoonRadius, uSunRadius],
  );

  const near = useNearLOD(scaledRadius, uniforms);
  const mid = useMidLOD(scaledRadius, uniforms);
  const far = useFarLOD(scaledRadius, uSpR, uSpU, uSpF);

  // Refs for LOD meshes — toggle visibility without re-renders.
  const nearRef = useMemo(() => ({ current: null as THREE.Mesh | null }), []);
  const midRef = useMemo(() => ({ current: null as THREE.Mesh | null }), []);
  const farRef = useMemo(() => ({ current: null as THREE.Mesh | null }), []);

  // Warm up the near-LOD shader so the mid→near switch doesn't compile-stall.
  const nearCompiled = useMemo(() => ({ current: false }), []);

  useFrame(() => {
    // ── Update uniforms ──
    relativeKm.set(positionKm[0], positionKm[1], positionKm[2]);
    relativeKm.sub(worldOrigin.worldOriginKm);
    toScaledUnitsKm(relativeKm, earthScaled);

    relativeKm.set(sunPositionKm[0], sunPositionKm[1], sunPositionKm[2]);
    relativeKm.sub(worldOrigin.worldOriginKm);
    toScaledUnitsKm(relativeKm, sunScaled);

    relativeKm.set(moonPositionKm[0], moonPositionKm[1], moonPositionKm[2]);
    relativeKm.sub(worldOrigin.worldOriginKm);
    toScaledUnitsKm(relativeKm, moonScaled);

    sunRelative.copy(sunScaled).sub(earthScaled);
    moonRelative.copy(moonScaled);

    uSunRel.value.copy(sunRelative);
    uMoonPos.value.copy(moonRelative);

    // ── LOD selection based on ship distance ──
    _shipToEarth.set(
      positionKm[0] - worldOrigin.shipPosKm.x,
      positionKm[1] - worldOrigin.shipPosKm.y,
      positionKm[2] - worldOrigin.shipPosKm.z,
    );
    const distKm = _shipToEarth.length();

    const showNear = distKm < LOD_NEAR_THRESHOLD;
    const showMid = !showNear && distKm < LOD_FAR_THRESHOLD;
    const showFar = !showNear && !showMid;

    if (nearRef.current) nearRef.current.visible = showNear;
    if (midRef.current) midRef.current.visible = showMid;
    if (farRef.current) farRef.current.visible = showFar;

    // ── Sun projection for far impostor billboard ──
    // The billboard is in VIEW space — build dome frame in view space too.
    {
      const qInv = camera.quaternion.clone().invert();

      const sdView = new THREE.Vector3(
        sunPositionKm[0] - positionKm[0],
        sunPositionKm[1] - positionKm[1],
        sunPositionKm[2] - positionKm[2],
      ).normalize().applyQuaternion(qInv);

      const bodyView = _shipToEarth.clone().applyQuaternion(qInv);
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
      <group rotation={PLANET_ROTATION}>
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
      <StellarPoint
        positionKm={positionKm}
        sunPositionKm={sunPositionKm}
        radiusKm={radiusKm}
        geometricAlbedo={0.434}
        color={[0.55, 0.65, 0.95]}
      />
    </SimGroup>
  );
}

export default memo(Planet);
