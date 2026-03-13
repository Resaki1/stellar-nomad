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
  positionWorld,
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
  0.0 * Math.PI,
  0.5 * Math.PI,
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

    const uNormalPower = float(0.8);
    const uNightBoost = float(0.35);
    const uCloudOpacity = float(0.8);

    mat.fragmentNode = Fn(() => {
      const uvCoord = uv();
      const sunDir = normalize(uSunRel);

      const dayCol = texture(tex.day, uvCoord).rgb;
      const nightCol = texture(tex.night, uvCoord).rgb.mul(uNightBoost);

      // Geometric normal in world space
      const nGeom = normalize(normalWorld);
      const cosSunToGeomNormal = dot(nGeom, sunDir);

      // ── Day/night transition ──
      // Softer sigmoid for gradual terminator (was -20, now -10)
      const dayAmount = float(1.0)
        .div(float(1.0).add(exp(float(-10).mul(cosSunToGeomNormal))))
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

      // ── Terminator warm tones (Rayleigh scattering at low sun angles) ──
      // At the terminator, sunlight passes through more atmosphere → red/orange shift
      // Manual smoothstep: t*t*(3-2t)
      const tA = clamp(dayAmount.div(0.5), 0, 1);
      const ssA = tA.mul(tA).mul(float(3.0).sub(tA.mul(2.0)));
      const tB = clamp(float(1.0).sub(dayAmount).div(0.5), 0, 1);
      const ssB = tB.mul(tB).mul(float(3.0).sub(tB.mul(2.0)));
      const terminatorBand = ssA.mul(ssB);
      // Warm color: orange-ish at the terminator
      const warmTint = vec3(1.0, 0.6, 0.3);
      const terminatorStrength = float(0.25);

      // ── Clouds ──
      const cloudMask = texture(tex.clouds, uvCoord).r
        .mul(uCloudOpacity)
        .toVar();

      // Cloud shadow: approximate UV offset towards sun in tangent space
      const delta = nGeom.sub(sunDir).mul(0.0006);
      const deltaT = vec3(dot(tW, delta), dot(bW, delta), dot(nGeom, delta));
      const cloudShadow = texture(
        tex.clouds,
        uvCoord.sub(deltaT.xy)
      ).r;
      // Cloud shadows darken the surface underneath (stronger = more depth)
      dayAmount.mulAssign(float(1.0).sub(float(0.65).mul(cloudShadow)));

      // Base day/night blend with sharper night-side cutoff for city lights
      const tN2 = clamp(float(0.15).sub(dayAmount).div(0.15), 0, 1);
      const nightMask = tN2.mul(tN2).mul(float(3.0).sub(tN2.mul(2.0)));
      const col = mix(nightCol.mul(nightMask), dayCol, dayAmount).toVar();

      // Apply terminator warmth to surface
      col.assign(mix(col, col.mul(warmTint), terminatorBand.mul(terminatorStrength)));

      // ── Ocean specular (concentrated sun glint) ──
      const specMask = texture(tex.spec, uvCoord).r;
      const viewDir = normalize(cameraPosition.sub(surfacePosW));
      const refl = reflect(sunDir.negate(), nW);
      const specAngle = dot(refl, viewDir).max(0);
      // Tight specular: pow 80 for concentrated glint, ocean-only
      const specHighlight = pow(specAngle, float(80.0)).mul(1.8).mul(specMask);
      // Broader secondary specular for wet sheen
      const specBroad = pow(specAngle, float(8.0)).mul(0.15).mul(specMask);
      col.addAssign(dayAmount.mul(specHighlight.add(specBroad)));

      // ── Cloud overlay ──
      // Sharper cloud lighting: use geometric sun angle directly so clouds
      // cut off at the terminator the same way the surface does, but with
      // a steeper falloff so they vanish fully on the night side.
      const cloudSunFactor = clamp(
        cosSunToGeomNormal.mul(4.0).add(0.9),
        0,
        1
      );
      // Smooth the factor for a natural transition (smoothstep)
      const csf = cloudSunFactor
        .mul(cloudSunFactor)
        .mul(float(5.0).sub(cloudSunFactor.mul(2.0)));

      // Bright white on day side, warm only in a narrow terminator band
      const cloudTerminatorCol = vec3(1.12, 1.12, 1.12);
      const cloudDayCol = vec3(0.7, 0.4, 0.3);
      const cloudBaseCol = mix(cloudDayCol, cloudTerminatorCol, terminatorBand);
      // Cloud lit color fades to black sharply at the terminator
      const cloudLit = cloudBaseCol.mul(csf);
      col.assign(mix(col, cloudLit, clamp(cloudMask, 0, 1)));

      // ── Rayleigh scattering (in-scatter + extinction) ──
      // Optical depth: 1 at nadir (looking straight down), increases
      // toward the limb as the view ray traverses more atmosphere.
      const viewDotN = dot(viewDir, nGeom).max(0.08);
      const opticalDepth = clamp(float(1.0).div(viewDotN), 1, 12);
      // Normalize to 0..1 range: 0 = looking straight down, 1 = at the limb
      const scatter01 = clamp(opticalDepth.sub(1).div(11), 0, 1);

      // Day-side mask (no atmospheric effect on dark side)
      const hazeDayMask = clamp(hemiAmount.mul(2.0), 0, 1);

      // 1) Extinction: desaturate surface colors as optical depth increases.
      //    More atmosphere → more light scattered out of the beam → washed out.
      const luminance = dot(col, vec3(0.2126, 0.7152, 0.0722));
      const desatAmount = scatter01.mul(0.4).add(0.1).mul(hazeDayMask);
      col.assign(mix(col, vec3(luminance, luminance, luminance), desatAmount));

      // 2) In-scatter: atmosphere adds blue light toward the viewer.
      //    Proportional to optical depth; even looking straight down there's
      //    a subtle base scatter (the ~1 atmosphere minimum).
      const rayleighColor = vec3(0.3, 0.5, 0.9);
      const inScatterBase = float(0.08); // always present on lit side
      const inScatterLimb = pow(scatter01, float(1.2)).mul(0.75);
      const inScatter = inScatterBase.add(inScatterLimb).mul(hazeDayMask);
      col.assign(mix(col, rayleighColor, inScatter));

      return vec4(col, 1.0);
    })();

    return mat;
  }, [tex, uSunRel, uEarthPos, uMoonPos, uMoonRadius, uSunRadius]);

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
