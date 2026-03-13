"use client";

import { memo, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { useTexture } from "@react-three/drei";
import * as THREE from "three";
import { NodeMaterial } from "three/webgpu";
import {
  Fn,
  If,
  uniform,
  texture,
  uv,
  normalWorld,
  normalView,
  positionWorld,
  positionView,
  tangentWorld,
  bitangentWorld,
  cameraPosition,
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
} from "three/tsl";
import SimGroup from "../space/SimGroup";
import { kmToScaledUnits, toScaledUnitsKm } from "@/sim/units";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { STAR_POSITION_KM } from "../Star/Star";

const PLANET_ROTATION = new THREE.Euler(
  1.1 * Math.PI,
  1.8 * Math.PI,
  0.8 * Math.PI
);
const DEFAULT_PLANET_POSITION_KM: [number, number, number] = [
  5_000, 0, -15_000,
];
const DEFAULT_PLANET_RADIUS_KM = 6371;
const DEFAULT_SUN_POSITION_KM = STAR_POSITION_KM;

// Eclipse disabled by default (moon far away)
const DEFAULT_MOON_POSITION_KM: [number, number, number] = [1e9, 0, 0];
const DEFAULT_MOON_RADIUS_KM = 1.737;
const DEFAULT_SUN_RADIUS_KM = 696.34;

const sunScaled = new THREE.Vector3();
const moonScaled = new THREE.Vector3();
const earthScaled = new THREE.Vector3();
const sunRelative = new THREE.Vector3();
const moonRelative = new THREE.Vector3();
const relativeKm = new THREE.Vector3();

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

type PlanetProps = {
  positionKm?: [number, number, number];
  sunPositionKm?: [number, number, number];
  moonPositionKm?: [number, number, number];
  moonRadiusKm?: number;
  sunRadiusKm?: number;
  radiusKm?: number;
};

function setTextureColorSpace(
  tex: THREE.Texture | undefined,
  kind: "srgb" | "linear"
) {
  if (!tex) return;

  if ("colorSpace" in tex) {
    // @ts-ignore
    tex.colorSpace =
      kind === "srgb" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  }

  tex.needsUpdate = true;
}

function Planet({
  positionKm = DEFAULT_PLANET_POSITION_KM,
  sunPositionKm = DEFAULT_SUN_POSITION_KM,
  moonPositionKm = DEFAULT_MOON_POSITION_KM,
  moonRadiusKm = DEFAULT_MOON_RADIUS_KM,
  sunRadiusKm = DEFAULT_SUN_RADIUS_KM,
  radiusKm = DEFAULT_PLANET_RADIUS_KM,
}: PlanetProps) {
  const worldOrigin = useWorldOrigin();

  const scaledRadius = useMemo(() => kmToScaledUnits(radiusKm), [radiusKm]);

  const tex = useTexture({
    day: "/textures/earth_day.webp",
    night: "/textures/earth_night.webp",
    normal: "/textures/earth_normal.webp",
    spec: "/textures/earth_specular.webp",
    clouds: "/textures/earth_clouds.webp",
  }) as Record<string, THREE.Texture>;

  useMemo(() => {
    setTextureColorSpace(tex.day, "srgb");
    setTextureColorSpace(tex.night, "srgb");
    setTextureColorSpace(tex.normal, "linear");
    setTextureColorSpace(tex.spec, "linear");
    setTextureColorSpace(tex.clouds, "linear");
    tex.clouds.minFilter = THREE.LinearMipmapLinearFilter;
    tex.clouds.magFilter = THREE.LinearFilter;
    tex.clouds.anisotropy = 8;
  }, [tex]);

  // Sphere geometry with tangents computed for normal mapping
  const sphereGeo = useMemo(() => {
    const geo = new THREE.SphereGeometry(scaledRadius, 128, 128);
    geo.computeTangents();
    return geo;
  }, [scaledRadius]);

  // TSL uniforms (shared across materials)
  const uSunRel = useMemo(() => uniform(new THREE.Vector3(0, 0, 1)), []);
  const uEarthPos = useMemo(() => uniform(new THREE.Vector3()), []);
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

  // ---------- Earth material ----------
  const earthMat = useMemo(() => {
    const mat = new NodeMaterial();
    mat.side = THREE.FrontSide;

    const uNormalPower = float(0.6);
    const uNightBoost = float(0.5);
    const uCloudOpacity = float(0.65);

    mat.fragmentNode = Fn(() => {
      const uvCoord = uv();
      const sunDir = normalize(uSunRel);

      const dayCol = texture(tex.day, uvCoord).rgb;
      const nightCol = texture(tex.night, uvCoord).rgb.mul(uNightBoost);

      // Geometric normal in world space
      const nGeom = normalize(normalWorld);
      const cosSunToGeomNormal = dot(nGeom, sunDir);

      // Day/night sigmoid
      const dayAmount = float(1.0)
        .div(float(1.0).add(exp(float(-20).mul(cosSunToGeomNormal))))
        .toVar();
      const hemiAmount = dayAmount.toVar();

      // Surface world position
      const surfacePosW = positionWorld;

      // Eclipse calculation
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

      // Normal mapping via TBN
      const tN = texture(tex.normal, uvCoord).xyz.mul(2).sub(1);
      // @ts-ignore – TSL node type inference limitation
      const tW = normalize(tangentWorld) as ReturnType<typeof vec3>;
      // @ts-ignore – TSL node type inference limitation
      const bW = normalize(bitangentWorld) as ReturnType<typeof vec3>;
      // TBN * tangentSpaceNormal
      const nW = normalize(
        tW.mul(tN.x).add(bW.mul(tN.y)).add(nGeom.mul(tN.z))
      );

      const cosSunToMappedNormal = dot(nW, sunDir);
      dayAmount.mulAssign(
        float(1.0).add(
          uNormalPower.mul(cosSunToMappedNormal.sub(cosSunToGeomNormal))
        )
      );
      dayAmount.mulAssign(hemiAmount);
      dayAmount.assign(clamp(dayAmount, 0, 1));

      // Clouds
      const cloudMask = texture(tex.clouds, uvCoord).r
        .mul(uCloudOpacity)
        .toVar();

      // Cloud shadow: approximate UV offset towards sun in tangent space
      const delta = nGeom.sub(sunDir).mul(0.0005);
      const deltaT = vec3(dot(tW, delta), dot(bW, delta), dot(nGeom, delta));
      const cloudShadow = texture(
        tex.clouds,
        uvCoord.sub(deltaT.xy)
      ).r;
      dayAmount.mulAssign(float(1.0).sub(float(0.5).mul(cloudShadow)));

      // Base day/night blend
      const col = mix(nightCol, dayCol, dayAmount).toVar();

      // Specular
      const specMask = texture(tex.spec, uvCoord).r;
      const reflectRatio = float(0.3).mul(specMask).add(0.1);
      const refl = reflect(sunDir.negate(), nW);
      const specPow = clamp(
        dot(refl, normalize(cameraPosition.sub(surfacePosW))),
        0,
        1
      );
      col.addAssign(dayAmount.mul(pow(specPow, float(2))).mul(reflectRatio));

      // Cloud overlay
      const h = clamp(hemiAmount, 0, 1);
      const cloudCol = vec3(
        clamp(h, 0.2, 1.0),
        clamp(pow(h, float(1.5)), 0.2, 1.0),
        clamp(pow(h, float(2.0)), 0.2, 1.0)
      );
      col.assign(mix(col, cloudCol, clamp(cloudMask, 0, 1)));

      return vec4(col, 1.0);
    })();

    return mat;
  }, [tex, uSunRel, uEarthPos, uMoonPos, uMoonRadius, uSunRadius]);

  // ---------- Atmosphere material ----------
  const atmosphereMat = useMemo(() => {
    const mat = new NodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.side = THREE.DoubleSide;

    const uColor = vec3(0.2, 0.45, 1.0);

    mat.fragmentNode = Fn(() => {
      const sunDir = normalize(uSunRel);
      const nW = normalize(normalWorld);
      const nV = normalize(normalView);
      const posV = normalize(positionView);

      const cosSunToNormal = dot(nW, sunDir);
      const dayMask = float(1.0).div(
        float(1.0).add(exp(float(-7).mul(cosSunToNormal.add(0.1))))
      );

      const raw = float(3.0).mul(
        dot(posV, nV).max(0)
      );
      const intensity = pow(raw, float(3.0));

      return vec4(uColor, intensity).mul(dayMask);
    })();

    return mat;
  }, [uSunRel]);

  // ---------- Fresnel material ----------
  const fresnelMat = useMemo(() => {
    const mat = new NodeMaterial();
    mat.transparent = true;
    mat.blending = THREE.AdditiveBlending;
    mat.depthWrite = false;
    mat.side = THREE.DoubleSide;

    const uColor = vec3(0.2, 0.45, 1.0);

    mat.fragmentNode = Fn(() => {
      const sunDir = normalize(uSunRel);
      const nW = normalize(normalWorld);
      const nV = normalize(normalView);

      // Day mask
      const cosSunToNormal = dot(nW, sunDir);
      const dayMask = float(1.0).div(
        float(1.0).add(exp(float(-7).mul(cosSunToNormal.add(0.1))))
      );

      // Fresnel
      const fresnelTerm = float(1.0).add(dot(normalize(positionView), nV));
      const fres = pow(fresnelTerm, float(2.0));

      return vec4(uColor, 1.0).mul(fres).mul(dayMask);
    })();

    return mat;
  }, [uSunRel]);

  useFrame(() => {
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

    uEarthPos.value.copy(earthScaled);
    uSunRel.value.copy(sunRelative);
    uMoonPos.value.copy(moonRelative);
  });

  return (
    <SimGroup space="scaled" positionKm={positionKm}>
      <group rotation={PLANET_ROTATION}>
        <mesh geometry={sphereGeo} material={earthMat} />
        <mesh geometry={sphereGeo} material={atmosphereMat} scale={1.03} />
        <mesh geometry={sphereGeo} material={fresnelMat} scale={1.002} />
      </group>
    </SimGroup>
  );
}

useTexture.preload("/textures/earth_day.webp");
useTexture.preload("/textures/earth_night.webp");
useTexture.preload("/textures/earth_normal.webp");
useTexture.preload("/textures/earth_specular.webp");
useTexture.preload("/textures/earth_clouds.webp");

export default memo(Planet);
