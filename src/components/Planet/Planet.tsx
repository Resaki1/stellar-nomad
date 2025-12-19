"use client";

import { memo, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useTexture } from "@react-three/drei";
import * as THREE from "three";
import { AdditiveBlending, FrontSide, Group, Mesh } from "three";
import SimGroup from "../space/SimGroup";
import { kmToScaledUnits, toScaledUnitsKm } from "@/sim/units";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { STAR_POSITION_KM } from "../Star/Star";

const PLANET_ROTATION = new THREE.Euler(
  1.1 * Math.PI,
  1.8 * Math.PI,
  0.8 * Math.PI
);
const DEFAULT_PLANET_POSITION_KM: readonly [number, number, number] = [
  10_000,
  0,
  -10_000,
];
const DEFAULT_PLANET_RADIUS_KM = 6371;
const DEFAULT_SUN_POSITION_KM = STAR_POSITION_KM;

// Eclipse disabled by default (moon far away)
const DEFAULT_MOON_POSITION_KM: readonly [number, number, number] = [1e9, 0, 0];
const DEFAULT_MOON_RADIUS_KM = 1737;
const DEFAULT_SUN_RADIUS_KM = 696_340;

const earthVertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosWRel;
  varying mat3 vTbn;

  attribute vec4 tangent;

  void main() {
    vUv = uv;

    vNormalW = normalize(mat3(modelMatrix) * normal);
    vPosWRel = mat3(modelMatrix) * position;

    vec3 t = normalize(tangent.xyz);
    vec3 n = normalize(normal.xyz);
    vec3 b = normalize(cross(t, n));

    t = mat3(modelMatrix) * t;
    b = mat3(modelMatrix) * b;
    n = mat3(modelMatrix) * n;

    vTbn = mat3(normalize(t), normalize(b), normalize(n));

    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const earthFragmentShader = /* glsl */ `
  uniform sampler2D uDayTex;
  uniform sampler2D uNightTex;
  uniform sampler2D uNormalTex;
  uniform sampler2D uSpecTex;
  uniform sampler2D uCloudTex;

  uniform vec3 uSunRel;
  uniform vec3 uEarthPos;

  uniform float uNormalPower;

  uniform vec3 uMoonPos;
  uniform float uMoonRadius;
  uniform float uSunRadius;

  // simple artistic knobs
  uniform float uNightBoost;     // helps if night map is too dim
  uniform float uCloudOpacity;   // overall cloud strength (0..1)

  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosWRel;
  varying mat3 vTbn;

  #define PI 3.14159265359

  float eclipseFactor(float angleBetween, float angleLight, float angleOcc) {
    float r2 = pow(angleOcc / angleLight, 2.0);
    float v;

    if (angleBetween > angleLight - angleOcc && angleBetween < angleLight + angleOcc) {
      if (angleBetween < angleOcc - angleLight) {
        v = 0.0;
      } else {
        float x = 0.5 / angleBetween * (angleBetween*angleBetween + angleLight*angleLight - angleOcc*angleOcc);
        float thL = acos(x / angleLight);
        float thO = acos((angleBetween - x) / angleOcc);
        v = 1.0/PI * (PI - thL + 0.5*sin(2.0*thL) - thO*r2 + 0.5*r2*sin(2.0*thO));
      }
    } else if (angleBetween > angleLight + angleOcc) {
      v = 1.0;
    } else {
      v = 1.0 - r2;
    }

    return clamp(v, 0.0, 1.0);
  }

  void main() {
    vec3 sunDir = normalize(uSunRel);

    vec3 dayCol   = texture2D(uDayTex, vUv).rgb;
    vec3 nightCol = texture2D(uNightTex, vUv).rgb * uNightBoost;

    float cosSunToGeomNormal = dot(vNormalW, sunDir);
    float dayAmount = 1.0 / (1.0 + exp(-20.0 * cosSunToGeomNormal));
    float hemiAmount = dayAmount;

    vec3 surfacePosW = uEarthPos + vPosWRel;

    float distEarthToSun  = length(uSunRel);
    float distSurfToMoon  = length(uMoonPos - surfacePosW);

    float cosSunMoon = dot(sunDir, normalize(uMoonPos - surfacePosW));
    float angSunMoon = acos(clamp(cosSunMoon, -1.0, 1.0));

    float angSunDisk  = asin(clamp(uSunRadius / distEarthToSun,  0.0, 1.0));
    float angMoonDisk = asin(clamp(uMoonRadius / distSurfToMoon, 0.0, 1.0));

    hemiAmount *= eclipseFactor(angSunMoon, angSunDisk, angMoonDisk);

    // normal mapping
    vec3 tN = texture2D(uNormalTex, vUv).xyz * 2.0 - 1.0;
    vec3 nW = normalize(vTbn * tN);
    float cosSunToMappedNormal = dot(nW, sunDir);

    dayAmount *= (1.0 + uNormalPower * (cosSunToMappedNormal - cosSunToGeomNormal));
    dayAmount *= hemiAmount;
    dayAmount = clamp(dayAmount, 0.0, 1.0);

    // IMPORTANT: your clouds.webp likely has NO alpha channel
    // so we derive the mask from the red channel (grayscale).
    float cloudMask = texture2D(uCloudTex, vUv).r;
    cloudMask *= uCloudOpacity;

    // Cloud shadow: sample slightly “towards the sun”
    vec3 transl = 0.0005 * inverse(vTbn) * (vNormalW - sunDir);
    float cloudShadow = texture2D(uCloudTex, vUv - transl.xy).r;
    dayAmount *= (1.0 - 0.5 * cloudShadow);

    // base day/night
    vec3 col = mix(nightCol, dayCol, dayAmount);

    // specular from spec map (assumed grayscale in R)
    float specMask = texture2D(uSpecTex, vUv).r;
    float reflectRatio = 0.3 * specMask + 0.1;

    vec3 refl = reflect(-sunDir, nW);
    float specPow = clamp(dot(refl, normalize(cameraPosition - surfacePosW)), 0.0, 1.0);
    col += dayAmount * pow(specPow, 2.0) * reflectRatio;

    // Clouds as white-ish scattering on lit side, but still visible a bit at night
    float h = clamp(hemiAmount, 0.0, 1.0);
    vec3 cloudCol = vec3(1.0);

    // slight blue tint on day side
    cloudCol.r *= clamp(h, 0.2, 1.0);
    cloudCol.g *= clamp(pow(h, 1.5), 0.2, 1.0);
    cloudCol.b *= clamp(pow(h, 2.0), 0.2, 1.0);

    // Blend clouds using derived mask
    col = mix(col, cloudCol, clamp(cloudMask, 0.0, 1.0));

    gl_FragColor = vec4(col, 1.0);
  }
`;

const addonVertexShader = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vNormalV;
  varying vec3 vPosV;

  void main() {
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vNormalV = normalize(normalMatrix * normal);
    vPosV = normalize((modelViewMatrix * vec4(position, 1.0)).xyz);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const atmosphereFragmentShader = /* glsl */ `
  uniform vec3 uSunRel;
  uniform vec3 uColor;

  varying vec3 vNormalW;
  varying vec3 vNormalV;
  varying vec3 vPosV;

  void main() {
    vec3 sunDir = normalize(uSunRel);

    float cosSunToNormal = dot(vNormalW, sunDir);
    float dayMask = 1.0 / (1.0 + exp(-7.0 * (cosSunToNormal + 0.1)));

    float raw = 3.0 * max(dot(vPosV, vNormalV), 0.0);
    float intensity = pow(raw, 3.0);

    gl_FragColor = vec4(uColor, intensity) * dayMask;
  }
`;

const fresnelFragmentShader = /* glsl */ `
  uniform vec3 uSunRel;
  uniform vec3 uColor;

  varying vec3 vNormalW;
  varying vec3 vNormalV;
  varying vec3 vPosV;

  float saturate(float x) { return clamp(x, 0.0, 1.0); }

  void main() {
    vec3 sunDir = normalize(uSunRel);

    // Keep day masking (as in article)
    float cosSunToNormal = dot(vNormalW, sunDir);
    float dayMask = 1.0 / (1.0 + exp(-7.0 * (cosSunToNormal + 0.1)));

    // View dir in view space: camera is at origin in view space, so V = -pos
    vec3 V = normalize(-vPosV);
    vec3 N = normalize(vNormalV);

    // Standard Fresnel form: strongest at grazing angles
    float ndv = saturate(dot(N, V));
    float fres = pow(1.0 - ndv, 2.0);

    // Soften/widen the rim (these thresholds are the main "photoreal" lever)
    fres = smoothstep(0.02, 0.55, fres);

    // Reduce energy so it doesn't look like a stroke under ACES
    float strength = 0.15;
    vec3 rgb = uColor * fres * strength * dayMask;

    float fresnelTerm = 1.0 + dot(normalize(vPosV), normalize(vNormalV));
    fresnelTerm = pow(fresnelTerm, 2.0);

    gl_FragColor = vec4(uColor, 1.0) * fresnelTerm * dayMask;
  }
`;

type PlanetProps = {
  positionKm?: readonly [number, number, number];
  sunPositionKm?: readonly [number, number, number];
  moonPositionKm?: readonly [number, number, number];
  moonRadiusKm?: number;
  sunRadiusKm?: number;
  radiusKm?: number;
};

function setTextureColorSpace(
  tex: THREE.Texture | undefined,
  kind: "srgb" | "linear"
) {
  if (!tex) return;

  // Prefer modern three.js property
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
  const groupRef = useRef<Group>(null!);

  const scaledRadius = useMemo(() => kmToScaledUnits(radiusKm), [radiusKm]);

  const sphereGeo = useMemo(() => {
    const g = new THREE.SphereGeometry(scaledRadius, 64, 64);
    g.computeTangents();
    return g;
  }, [scaledRadius]);

  const tex = useTexture({
    day: "/textures/earth_day.webp",
    night: "/textures/earth_night.webp",
    normal: "/textures/earth_normal.webp",
    spec: "/textures/earth_specular.webp",
    clouds: "/textures/earth_clouds.webp",
  }) as Record<string, THREE.Texture>;

  const moonRadiusScaled = useMemo(
    () => kmToScaledUnits(moonRadiusKm),
    [moonRadiusKm]
  );
  const sunRadiusScaled = useMemo(() => kmToScaledUnits(sunRadiusKm), [sunRadiusKm]);

  const sunScaled = useMemo(() => new THREE.Vector3(), []);
  const moonScaled = useMemo(() => new THREE.Vector3(), []);
  const earthScaled = useMemo(() => new THREE.Vector3(), []);
  const sunRelative = useMemo(() => new THREE.Vector3(), []);
  const moonRelative = useMemo(() => new THREE.Vector3(), []);
  const relativeKm = useMemo(() => new THREE.Vector3(), []);

  useMemo(() => {
    // Color textures
    setTextureColorSpace(tex.day, "srgb");
    setTextureColorSpace(tex.night, "srgb");

    // Data textures (IMPORTANT: clouds is data here)
    setTextureColorSpace(tex.normal, "linear");
    setTextureColorSpace(tex.spec, "linear");
    setTextureColorSpace(tex.clouds, "linear");

    // Make the clouds less “sparkly” when far away
    tex.clouds.minFilter = THREE.LinearMipmapLinearFilter;
    tex.clouds.magFilter = THREE.LinearFilter;
    tex.clouds.anisotropy = 8;
  }, [tex]);

  const earthMat = useMemo(() => {
    return new THREE.ShaderMaterial({
      vertexShader: earthVertexShader,
      fragmentShader: earthFragmentShader,
      uniforms: {
        uDayTex: { value: tex.day },
        uNightTex: { value: tex.night },
        uNormalTex: { value: tex.normal },
        uSpecTex: { value: tex.spec },
        uCloudTex: { value: tex.clouds },

        uSunRel: { value: new THREE.Vector3(0, 0, 1) },
        uEarthPos: { value: new THREE.Vector3() },

        uNormalPower: { value: 0.6 },

        uMoonPos: { value: new THREE.Vector3(1e9, 0, 0) },
        uMoonRadius: { value: moonRadiusScaled },
        uSunRadius: { value: sunRadiusScaled },

        uNightBoost: { value: 0.5 }, // tweak 1.0–3.0
        uCloudOpacity: { value: 0.65 }, // tweak 0.2–0.9
      },
      side: FrontSide,
    });
  }, [moonRadiusScaled, sunRadiusScaled, tex]);

  const atmosphereMat = useMemo(() => {
    return new THREE.ShaderMaterial({
      vertexShader: addonVertexShader,
      fragmentShader: atmosphereFragmentShader,
      uniforms: {
        uSunRel: { value: new THREE.Vector3(0, 0, 1) },
        uColor: { value: new THREE.Vector3(0.2, 0.45, 1.0) },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }, []);

  const fresnelMat = useMemo(() => {
    return new THREE.ShaderMaterial({
      vertexShader: addonVertexShader,
      fragmentShader: fresnelFragmentShader,
      uniforms: {
        uSunRel: { value: new THREE.Vector3(0, 0, 1) },
        uColor: { value: new THREE.Vector3(0.2, 0.45, 1.0) },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }, []);

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

    earthMat.uniforms.uEarthPos.value.copy(earthScaled);
    earthMat.uniforms.uSunRel.value.copy(sunRelative);
    earthMat.uniforms.uMoonPos.value.copy(moonRelative);

    atmosphereMat.uniforms.uSunRel.value.copy(sunRelative);
    fresnelMat.uniforms.uSunRel.value.copy(sunRelative);
  });

  return (
    <SimGroup space="scaled" positionKm={positionKm}>
      <group ref={groupRef} rotation={PLANET_ROTATION}>
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
