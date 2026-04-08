import * as THREE from "three";
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
  smoothstep,
  Discard,
} from "three/tsl";
import {
  PLANET_POSITION_KM,
  PLANET_RADIUS_KM,
  LUNA_POSITION_KM,
  LUNA_RADIUS_KM,
  STAR_RADIUS_KM,
} from "@/sim/celestialConstants";
import { kmToScaledUnits, toScaledUnitsKm } from "@/sim/units";
import type { CelestialBodyConfig } from "../types";

export { PLANET_POSITION_KM };

const EARTH_ROTATION = new THREE.Euler(0.0, 0.5 * Math.PI, 0.8 * Math.PI);

// ── Scratch vectors for onFrame ──
const _moonScaled = new THREE.Vector3();
const _earthRelKm = new THREE.Vector3();

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
      .div(float(1.0).add(exp(float(-40).mul(cosSunToGeomNormal))))
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

    const eclipseAmount = eclipseFn(angSunMoon, angSunDisk, angMoonDisk);
    hemiAmount.mulAssign(eclipseAmount);

    // ── Detail-dependent: normal mapping + cloud shadow ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let nMapped: any = nGeom;
    const cloudShadowVal = float(0).toVar();

    if (detailed && texNormal) {
      // Normal mapping via TBN
      const tN = texture(texNormal, uvCoord).xyz.mul(2).sub(1);
      // @ts-ignore -- TSL node type inference limitation
      const tW = normalize(tangentWorld) as any;
      // @ts-ignore -- TSL node type inference limitation
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

      // Cloud shadow: project sun onto tangent plane for shadow offset
      const sunOnSurface = sunDir.sub(nGeom.mul(cosSunToGeomNormal));
      const shadowOffset = vec3(
        dot(tW, sunOnSurface),
        dot(bW, sunOnSurface),
        float(0)
      );
      // Shadows stretch at grazing sun angles (longer projection of cloud height)
      const shadowScale = float(0.0015).div(cosSunToGeomNormal.max(0.12));
      const shadowUV = shadowOffset.xy.mul(shadowScale);

      // Two-tap soft shadow for penumbra
      const cs1 = texture(texClouds, uvCoord.add(shadowUV.mul(0.4))).r;
      const cs2 = texture(texClouds, uvCoord.add(shadowUV)).r;
      cloudShadowVal.assign(cs1.mul(0.6).add(cs2.mul(0.4)));
      dayAmount.mulAssign(float(1.0).sub(float(0.7).mul(cloudShadowVal)));
    }

    // Apply only eclipse darkening — the base sigmoid is already in dayAmount.
    dayAmount.mulAssign(eclipseAmount);
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
      .toVar();

    // Night mask (sharper city-light cutoff)
    const tN2 = clamp(float(0.15).sub(dayAmount).div(0.15), 0, 1);
    const nightMask = tN2.mul(tN2).mul(float(3.0).sub(tN2.mul(2.0)));
    const col = mix(nightCol.mul(nightMask), dayCol, dayAmount).toVar();

    // Apply terminator warmth -- reduced for mid LOD where the smooth geometric
    // normal makes the band bleed across the entire day side.
    const terminatorStrength = float(detailed ? 0.25 : 0.06);
    col.assign(mix(col, col.mul(warmTint), terminatorBand.mul(terminatorStrength)));

    // ── Ocean specular ──
    const viewDir = normalize(cameraPosition.sub(surfacePosW));

    if (texSpec) {
      const specMask = texture(texSpec, uvCoord).r;
      const refl = reflect(sunDir.negate(), nMapped);
      const specAngle = dot(refl, viewDir).max(0);
      const specHighlight = pow(specAngle, float(40.0)).mul(0.8).mul(specMask);
      const specBroad = pow(specAngle, float(8.0)).mul(0.15).mul(specMask);
      col.addAssign(dayAmount.mul(specHighlight.add(specBroad)));

      // ── Fresnel ocean reflection + land limb darkening ──
      const vDotN = clamp(dot(viewDir, nGeom), 0, 1);
      const oneMinusVdotN = float(1.0).sub(vDotN);
      // Schlick Fresnel: F0 ≈ 0.02 for water
      const fresnel = float(0.02).add(
        float(2.0).mul(pow(oneMinusVdotN, float(2.5)))
      );
      // Ocean reflects atmosphere blue at grazing angles
      col.addAssign(
        vec3(0.0, 0.25, 1.0).mul(fresnel).mul(specMask).mul(dayAmount)
      );

      // Land: rough diffuse surfaces darken at oblique viewing angles
      const landMask = float(1.0).sub(specMask);
      const limbDarken = pow(vDotN.max(0.05), float(0.3));
      col.mulAssign(float(1.0).sub(landMask.mul(float(1.0).sub(limbDarken))));
    }

    // ── Cloud overlay ──
    const cloudSunFactor = clamp(
      cosSunToGeomNormal.mul(4.0).add(0.9),
      0,
      1
    );
    const csf = cloudSunFactor
      .mul(cloudSunFactor)
      .mul(float(8.0).sub(cloudSunFactor.mul(1.0)));

    // Cloud color: white in full sunlight, warm at the terminator.
    const cloudSunBlend = clamp(cosSunToGeomNormal.mul(3.0), 0, 1);
    const cloudWhite = vec3(1, 1, 1);
    const cloudWarm = vec3(1.0, 0.8, 0.7);
    const cloudBaseCol = mix(cloudWarm, cloudWhite, cloudSunBlend);
    // Clouds at ~10 km altitude catch sunlight slightly past the surface
    // terminator. Offset ≈ sqrt(2h/R) in cos-space for h=10 km, R=6371 km.
    const cloudHemi = float(1.0).div(
      float(1.0).add(exp(float(-40).mul(cosSunToGeomNormal.add(0.025))))
    );
    // Self-shadow: clouds with other clouds sunward of them get darker bases
    const cloudSelfShadow = float(1.0).sub(float(0.5).mul(cloudShadowVal));
    const cloudLit = cloudBaseCol.mul(csf).mul(cloudHemi).mul(cloudSelfShadow);
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

// ── Custom billboard fragment (Earth with atmosphere rim glow) ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function earthBillboardFragment({ albedo, uSpR, uSpU, uSpF }: { albedo: THREE.Color; uSpR: any; uSpU: any; uSpF: any }) {
  return Fn(() => {
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
}

// ─────────────────────────────────────────────────────────────────────

// Far albedo is not used directly by the custom billboard, but the
// FarBillboardConfig requires it. Use a representative blue.
const EARTH_FAR_ALBEDO = new THREE.Color(0.38, 0.42, 0.80);

export const earthConfig: CelestialBodyConfig = {
  id: "earth",
  positionKm: PLANET_POSITION_KM,
  radiusKm: PLANET_RADIUS_KM,
  rotation: EARTH_ROTATION,

  lod: { near: 35_000, far: 1_500_000 },
  near: {
    textures: {
      day: "/textures/earth_day_8k.ktx2",
      night: "/textures/earth_night_8k.ktx2",
      clouds: "/textures/earth_clouds_8k.ktx2",
      normal: "/textures/earth_normal.ktx2",
      spec: "/textures/earth_specular.ktx2",
    },
    segments: 128,
    computeTangents: true,
  },
  mid: {
    textures: {
      day: "/textures/earth_day_2k.ktx2",
      night: "/textures/earth_night_2k.ktx2",
      clouds: "/textures/earth_clouds_2k.ktx2",
      spec: "/textures/earth_specular.ktx2",
    },
    segments: 48,
  },
  far: { albedo: EARTH_FAR_ALBEDO, buildFragment: earthBillboardFragment },
  stellarPoint: { geometricAlbedo: 0.434, color: [0.55, 0.65, 0.95] },

  onTexturesLoaded: (tier, textures) => {
    if (tier === "near" && textures.clouds) {
      textures.clouds.anisotropy = 8;
    }
    if (tier === "mid" && textures.clouds) {
      textures.clouds.anisotropy = 4;
    }
  },

  createUniforms: () => ({
    uMoonPos: uniform(new THREE.Vector3(1e9, 0, 0)),
    uMoonRadius: uniform(kmToScaledUnits(LUNA_RADIUS_KM)),
    uSunRadius: uniform(kmToScaledUnits(STAR_RADIUS_KM)),
  }),

  onFrame: ({ uniforms, worldOrigin }) => {
    // Update moon position in scaled coords
    const moonKm = LUNA_POSITION_KM;
    _earthRelKm.set(moonKm[0], moonKm[1], moonKm[2]);
    _earthRelKm.sub(worldOrigin.worldOriginKm);
    toScaledUnitsKm(_earthRelKm, _moonScaled);
    uniforms.uMoonPos.value.copy(_moonScaled);
  },

  buildFragmentNode: ({ textures, uSunRel, uniforms, tier }) => {
    return buildEarthFragmentNode({
      texDay: textures.day,
      texNight: textures.night,
      texClouds: textures.clouds,
      texNormal: tier === "near" ? textures.normal : null,
      texSpec: textures.spec ?? null,
      uSunRel,
      uMoonPos: uniforms.uMoonPos,
      uMoonRadius: uniforms.uMoonRadius,
      uSunRadius: uniforms.uSunRadius,
    });
  },
};
