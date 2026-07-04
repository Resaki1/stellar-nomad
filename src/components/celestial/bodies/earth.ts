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
  vec2,
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
  int,
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
import { buildEarthClouds } from "./earthClouds";
import { EARTH_ATMOSPHERE } from "./atmosphereData";
import {
  farCloudLit,
  coverageToOpacity,
  CLOUD_SKY_AMBIENT,
} from "./cloudCommon";
import {
  getAtmosphereLUTs,
  transmittanceLutUv,
} from "@/components/space/atmospherePass";

export { PLANET_POSITION_KM };

const EARTH_ROTATION = new THREE.Euler(0.0, 0.5 * Math.PI, 0.8 * Math.PI);
const CLOUD_BRIGHTNESS = 3;

// Light the flat 2D cloud overlay with the SHARED far-cloud model (cloudCommon)
// instead of the ad-hoc white×CLOUD_BRIGHTNESS×csf curve, so its brightness/
// colour + apparent coverage match the volumetric marcher at the 2D↔3D
// crossfade (docs/CLOUD_REVIEW_2026-07.md ISSUE 2, Phase 1). Flip false to A/B
// against the old hand-tuned overlay.
const USE_SHARED_CLOUD_FARFIELD = true;

// ── Atmosphere↔surface lighting coupling (Phase 3b, docs/ATMOSPHERE_PLAN.md §5.4) ──
// When ON, the day-lit surface (+ ocean sun-glint + flat cloud overlay) is tinted
// by the PHYSICAL sun transmittance from the shared LUT — sampled at ground
// radius + sun-zenith cos, so the slant path reddens the terminator correctly —
// NORMALISED by the zenith transmittance so noon brightness is unchanged (only
// the angular reddening shows). This REPLACES the fake `warmTint` terminator
// tint and the cloud warm-mix (which double-counted with the atmosphere pass).
// Build-time JS const → the OFF path keeps those hand-tuned tints (A/B + revert).
const USE_ATMOSPHERE_SURFACE_LIGHTING = true;
const SURFACE_SUN_SCALE = 1.0; // overall multiplier on the (zenith-normalised) tint
// Representative altitude (km) for tinting the FLAT 2D cloud overlay: it stands
// in for the cloud DECK, so it must redden like the VOLUMETRIC clouds (whose
// transmittance is sampled at cloud altitude → mild) — NOT like the ground
// (full slant path → dramatic), or the flat clouds stick out too orange.
const CLOUD_OVERLAY_ALTITUDE_KM = 10;

// Flat 2D cloud overlay (painted on the surface as the far-cloud LOD) fade band.
// The overlay must vanish once the camera is at/below the volumetric cloud top:
// it lives at ground level, so under the deck it would paint a ghost copy of the
// cloud cover flat on the terrain beneath a camera whose real clouds (volumetric)
// are above it — the "2D-clouds-on-the-ground" double-layer bug. Above the deck it
// fades back in to fill the globe past the marcher's limited reach.
//   altitude ≤ CLOUD_TOP_ALTITUDE_KM     → overlay off (0)
//   altitude ≥ FLAT_OVERLAY_FULL_ALT_KM  → overlay full (1)
// CLOUD_TOP matches CLOUD_OUTER_ALTITUDE_KM in earthClouds.ts.
const CLOUD_TOP_ALTITUDE_KM = 14;
const FLAT_OVERLAY_FULL_ALT_KM = 50;

// Per-pixel COVERAGE gate for the flat overlay while the volumetric is active
// (see the overlay block in buildEarthFragmentNode). History: a view-INCIDENCE
// gate was tried here first (overlay on at grazing angles, off at steep) on
// the theory that the march is only reliable on steep slab crossings — WRONG:
// since the distance-LOD step growth landed, the march reaches the horizon at
// every altitude, so the incidence gate painted a 2D ring at mid view angles
// UNDER perfectly good volumetric clouds (the user-reported "overlay creeping
// in from the horizon" + "gap between near and far volumetric filled with
// 2D"). The correct split is by COVERAGE, not geometry:
//   dense regions (coverage ≥ HI)  → overlay OFF everywhere — the volumetric
//     is the authority from camera to horizon; the ground-painted copy only
//     ever shows through carved gaps as a parallax ghost.
//   thin regions  (coverage ≤ LO)  → overlay stays ON — the volumetric
//     renders little there (the Remap thresholds away low coverage) and a
//     flat translucent haze IS the right far-field look; with no crisp
//     volumetric features above it there's nothing to ghost against.
// This also smooths the 2D↔3D crossfade band: thin cloud never pops out of
// existence at the blend boundary. Tune LO/HI together: raise both if thin
// 2D haze visibly doubles under volumetric wisps up close; lower both if
// mid-coverage regions lose too much cloud after the crossfade.
const FLAT_OVERLAY_COVERAGE_LO = 0.05; // coverage ≤ → overlay fully kept
const FLAT_OVERLAY_COVERAGE_HI = 0.25; // coverage ≥ → overlay fully removed

// Volumetric crossfade altitudes (drives uVolumetricBlend in onFrame).
// ALTITUDE-based (2026-06-10; was distance-based 35k→25k km, i.e. blend = 1
// from ~28,600 km altitude down — the volumetric marcher then ran at FULL
// cost across that entire range while its 5–10 km features were sub-pixel,
// which is what made orbit views 10–20 fps; SpaceRenderer now skips the cloud
// passes entirely while blend = 0). At 3000 km a 5 km cumulus cell subtends
// ~2 px — below that the volumetric becomes visually meaningful, so ramp it
// in across 3000 → 1500 km and let the flat overlay carry everything higher.
const VOLUMETRIC_BLEND_START_ALT_KM = 3000;
const VOLUMETRIC_BLEND_FULL_ALT_KM = 1500;

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uVolumetricBlend: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uFlatCloudOpacity: any;
  // Atmosphere transmittance LUT (Phase 3b surface coupling). Bound at graph-
  // build time; sampled per-pixel for physical sun colour. Optional: when absent
  // (toggle off) the surface keeps its hand-tuned terminator tint.
  transmittanceLUT?: THREE.Texture;
}) {
  const {
    texDay, texNight, texClouds, texNormal, texSpec,
    uSunRel, uMoonPos, uMoonRadius, uSunRadius, uVolumetricBlend,
    uFlatCloudOpacity, transmittanceLUT,
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

    // ── Atmosphere-coupled sun colour (Phase 3b) ──
    // Physical sunlight reaching the surface, from the SAME transmittance LUT the
    // sky/clouds/ship use, NORMALISED by the zenith transmittance at that
    // altitude (so noon brightness is unchanged; only the angular sunset
    // reddening shows) and clamped ≤ 1 (the sun is never less-attenuated than at
    // zenith). This replaces the fake `warmTint` + cloud warm-mix. Two altitudes:
    //   sunT      — GROUND (terrain + ocean glint): full slant path → DRAMATIC
    //               terminator reddening.
    //   sunTCloud — CLOUD deck (the flat 2D overlay): sampled at cloud altitude
    //               so it reddens MILDLY, matching the volumetric marcher (which
    //               samples cloud-altitude transmittance per-voxel) instead of
    //               the much-redder ground — otherwise the flat clouds stick out.
    // Below-horizon μ clamps the UV harmlessly (night is gated by dayAmount). Off
    // → white (no change).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sunT: any = vec3(1, 1, 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sunTCloud: any = vec3(1, 1, 1);
    if (USE_ATMOSPHERE_SURFACE_LIGHTING && transmittanceLUT) {
      const rgKm = EARTH_ATMOSPHERE.groundRadiusKm;
      const rtKm = rgKm + EARTH_ATMOSPHERE.atmosphereHeightKm;
      const hKm = Math.sqrt(Math.max(0, rtKm * rtKm - rgKm * rgKm));
      // Normalised sun transmittance at radius rKm: T(rKm, μ) / T(rKm, zenith),
      // clamped ≤ 1, × SURFACE_SUN_SCALE. (μ=1 → xMu=0, so the zenith tap is the
      // xR row for that altitude: UV (0,0) at the ground, (0, xR) at altitude.)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sunTAt = (rKm: number): any => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tA: any = texture(
          transmittanceLUT,
          transmittanceLutUv(float(rKm), cosSunToGeomNormal, float(rgKm), float(rtKm), float(hKm)),
        ).level(int(0));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tZen: any = texture(
          transmittanceLUT,
          transmittanceLutUv(float(rKm), float(1), float(rgKm), float(rtKm), float(hKm)),
        ).level(int(0));
        return tA.rgb.div(tZen.rgb.max(float(1e-4))).clamp(0, 1).mul(float(SURFACE_SUN_SCALE));
      };
      sunT = sunTAt(rgKm);
      sunTCloud = sunTAt(rgKm + CLOUD_OVERLAY_ALTITUDE_KM);
    }

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
      // three/tsl's normalize() overloads don't accept the tangent/bitangent
      // attribute node types, though they are valid vec3 nodes at runtime.
      // Cast the input to the same node type normalWorld uses (accepted above).
      const tW = normalize(tangentWorld as unknown as typeof normalWorld);
      const bW = normalize(bitangentWorld as unknown as typeof normalWorld);
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
      // Shadows stretch at grazing sun angles (longer projection of cloud height)
      const shadowUV = vec2(
        dot(tW, sunOnSurface),
        dot(bW, sunOnSurface)
      ).mul(float(0.0015).div(cosSunToGeomNormal.max(0.12)));

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
    const terminatorBand = smoothstep(float(0), float(0.5), dayAmount)
      .mul(smoothstep(float(1), float(0.5), dayAmount));
    const warmTint = vec3(1.0, 0.6, 0.3);

    // ── Clouds ──
    const cloudMask = texture(texClouds, uvCoord).r
      .toVar();

    // Night mask (sharper city-light cutoff)
    const nightMask = smoothstep(float(0.15), float(0), dayAmount);
    // Sun-lit day albedo is tinted by the atmospheric transmittance (Phase 3b);
    // the night-light emission (city lights) is NOT — it's not sunlit.
    const col = mix(nightCol.mul(nightMask), dayCol.mul(sunT), dayAmount).toVar();

    // Apply terminator warmth -- reduced for mid LOD where the smooth geometric
    // normal makes the band bleed across the entire day side. Phase 3b: skipped
    // when the surface is physically transmittance-lit (sunT already reddens the
    // terminator); kept on the OFF path so the A/B baseline is unchanged.
    if (!USE_ATMOSPHERE_SURFACE_LIGHTING) {
      const terminatorStrength = float(detailed ? 0.25 : 0.06);
      col.assign(mix(col, col.mul(warmTint), terminatorBand.mul(terminatorStrength)));
    }

    // ── Ocean specular ──
    const viewDir = normalize(cameraPosition.sub(surfacePosW));
    const viewDotNRaw = dot(viewDir, nGeom);

    if (texSpec) {
      const specMask = texture(texSpec, uvCoord).r;
      const refl = reflect(sunDir.negate(), nMapped);
      const specAngle = dot(refl, viewDir).max(0);
      const specHighlight = pow(specAngle, float(40.0)).mul(0.8).mul(specMask);
      const specBroad = pow(specAngle, float(8.0)).mul(0.15).mul(specMask);
      // Sun glint is reflected sunlight → tint by the same transmittance (Phase
      // 3b); reddens the glint at sunset. (The fresnel sky-reflection below is
      // skylight, not sun, so it is left as the fixed sky-blue.)
      col.addAssign(dayAmount.mul(sunT).mul(specHighlight.add(specBroad)));

      // ── Fresnel ocean reflection + land limb darkening ──
      const vDotN = clamp(viewDotNRaw, 0, 1);
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
      .mul(float(8.0).sub(cloudSunFactor));

    // Cloud color: white in full sunlight, warm at the terminator. Phase 3b:
    // the warm-mix is the OFF-path baseline — when ON, the flat clouds are plain
    // white albedo and the physical transmittance (sunT) reddens them instead.
    const cloudSunBlend = clamp(cosSunToGeomNormal.mul(3.0), 0, 1);
    const cloudWhite = vec3(1, 1, 1).mul(CLOUD_BRIGHTNESS);
    const cloudWarm = vec3(1.0, 0.8, 0.7);
    const cloudBaseCol = USE_ATMOSPHERE_SURFACE_LIGHTING
      ? cloudWhite
      : mix(cloudWarm, cloudWhite, cloudSunBlend);
    // Clouds at ~10 km altitude catch sunlight slightly past the surface
    // terminator. Offset ≈ sqrt(2h/R) in cos-space for h=10 km, R=6371 km.
    const cloudHemi = float(1.0).div(
      float(1.0).add(exp(float(-40).mul(cosSunToGeomNormal.add(0.025))))
    );
    // Self-shadow: clouds with other clouds sunward of them get darker bases
    const cloudSelfShadow = float(1.0).sub(float(0.5).mul(cloudShadowVal));
    // Flat clouds are sunlit → tint by the CLOUD-ALTITUDE transmittance (Phase
    // 3b) so they redden mildly like the volumetric clouds, not like the ground
    // (OFF: sunTCloud = white, no change).
    //
    // SHARED far-field lighting (ISSUE 2, Phase 1): the physical model the
    // volumetric marcher uses (sunIlluminance × cloud-alt transmittance ×
    // CLOUD_SUN_SCALE + sky ambient), so the overlay and the volumetric agree in
    // brightness/colour at the crossfade. `cloudHemi` is the cloud-horizon
    // daylight gate; `sunTCloud` already reddens at sunset via the LUT. OFF path
    // keeps the old hand-tuned white×CLOUD_BRIGHTNESS×csf overlay for A/B.
    const cloudLit = USE_SHARED_CLOUD_FARFIELD
      ? farCloudLit({
          sunIlluminance: vec3(
            EARTH_ATMOSPHERE.sunIlluminance[0],
            EARTH_ATMOSPHERE.sunIlluminance[1],
            EARTH_ATMOSPHERE.sunIlluminance[2],
          ),
          sunT: sunTCloud,
          skyColor: vec3(
            CLOUD_SKY_AMBIENT[0],
            CLOUD_SKY_AMBIENT[1],
            CLOUD_SKY_AMBIENT[2],
          ),
          daylight: cloudHemi,
          selfShadow: cloudSelfShadow,
        })
      : cloudBaseCol.mul(csf).mul(cloudHemi).mul(cloudSelfShadow).mul(sunTCloud);
    // Flat 2D cloud overlay — the far-cloud LOD. It paints the global cloud
    // texture on the planet surface to fill cloud cover beyond the volumetric
    // marcher's limited reach; the volumetric premultiplied composite renders
    // on top and *replaces* it wherever there's a near cloud body (α > 0).
    //
    // CRITICAL: this must fade out once the camera is at/below the cloud-top
    // altitude. The overlay lives at ground level (radius = planet surface),
    // so when the camera is *under* the deck looking down, the real clouds are
    // the volumetric ones around/above the camera while this would paint a
    // ghost copy of the cloud cover flat on the terrain below — the
    // "double-layer / 2D-clouds-on-the-ground" bug (visible when flying under
    // the cumulus deck). `uFlatCloudOpacity` is driven from camera altitude in
    // onFrame: 1 above ~50 km, 0 at/below the 14 km cloud top. It is NOT gated
    // by uVolumetricBlend, which can't distinguish "above the deck at 1000 km"
    // from "under the deck at 5 km" — both clamp to 1.
    //
    // ── Per-pixel coverage gate (2026-06-11) ──
    // Where the volumetric renders REAL cloud bodies (dense coverage) the
    // overlay must be off per-pixel: it's painted at ground level, 1–14 km
    // BELOW the volumetric clouds, so it showed through carved gaps with
    // parallax offset — the "I can still see the 2D texture where only
    // volumetric should show" bug. Where coverage is THIN the volumetric
    // renders little (the Remap thresholds away low coverage) and the flat
    // haze is the desired far-field fill, so it stays. See the
    // FLAT_OVERLAY_COVERAGE_* constants for the full rationale + the
    // incidence-gate dead end. Scaled by uVolumetricBlend so at high altitude
    // (blend → 0, volumetric pass skipped) the overlay covers everything.
    const thinKeep = float(1).sub(
      smoothstep(
        float(FLAT_OVERLAY_COVERAGE_LO),
        float(FLAT_OVERLAY_COVERAGE_HI),
        cloudMask,
      ),
    );
    const flatCloudOpacity = float(uFlatCloudOpacity).mul(
      mix(float(1), thinKeep, uVolumetricBlend),
    );
    // Apparent coverage via the SHARED coverage→opacity curve (ISSUE 2, Phase 1)
    // so the overlay renders the same cloud AREA the volumetric does. Default is
    // gentle (keeps the orbit coverage); tune cloudCommon COVERAGE_OPACITY_* to
    // tighten the match. OFF path uses raw coverage (the old behaviour).
    const overlayCoverage = USE_SHARED_CLOUD_FARFIELD
      ? coverageToOpacity(cloudMask)
      : cloudMask;
    col.assign(
      mix(col, cloudLit, clamp(overlayCoverage.mul(flatCloudOpacity), 0, 1)),
    );

    // NOTE: the old fake Rayleigh in-scatter/extinction (view-angle desaturation
    // + blue limb glow) lived here. It is now handled physically by the
    // atmosphere pass (atmospherePass.ts), which fogs this surface color with
    // real transmittance + in-scattering. The surface shader outputs ground
    // radiance only; all atmospheric effects are applied downstream.
    // (`hemiAmount` is retained for the eclipse term; the terminator warm tint
    // above is superseded by the atmosphere's sunset reddening in Phase 2.)

    return vec4(col, 1.0);
  })();
}

// ── Custom billboard fragment (Earth with atmosphere rim glow) ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function earthBillboardFragment({ uSpR, uSpU, uSpF }: { albedo: THREE.Color; uSpR: any; uSpU: any; uSpF: any }) {
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
  atmosphere: EARTH_ATMOSPHERE,

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

  extraMeshes: buildEarthClouds,

  onTexturesLoaded: (tier, textures) => {
    if (tier === "near" && textures.clouds) {
      textures.clouds.anisotropy = 8;
      // Shell ray-march samples across the atan2 seam; wrap to avoid a visible line.
      textures.clouds.wrapS = THREE.RepeatWrapping;
      textures.clouds.needsUpdate = true;
    }
    if (tier === "mid" && textures.clouds) {
      textures.clouds.anisotropy = 4;
    }
  },

  createUniforms: () => ({
    uMoonPos: uniform(new THREE.Vector3(1e9, 0, 0)),
    uMoonRadius: uniform(kmToScaledUnits(LUNA_RADIUS_KM)),
    uSunRadius: uniform(kmToScaledUnits(STAR_RADIUS_KM)),
    // 0 = far (flat overlay only), 1 = close (volumetric shell only).
    // Driven from camera ALTITUDE in onFrame; ramps linearly across
    // VOLUMETRIC_BLEND_START_ALT_KM → VOLUMETRIC_BLEND_FULL_ALT_KM.
    uVolumetricBlend: uniform(0),
    // Flat 2D cloud-overlay opacity. Driven from camera altitude in onFrame:
    // 1 above ~50 km, 0 at/below the 14 km cloud top — altitude- (not
    // distance-) gated. See the flat-overlay block in buildEarthFragmentNode.
    uFlatCloudOpacity: uniform(1),
  }),

  onFrame: ({ uniforms, worldOrigin, distKm }) => {
    // Update moon position in scaled coords
    const moonKm = LUNA_POSITION_KM;
    _earthRelKm.set(moonKm[0], moonKm[1], moonKm[2]);
    _earthRelKm.sub(worldOrigin.worldOriginKm);
    toScaledUnitsKm(_earthRelKm, _moonScaled);
    uniforms.uMoonPos.value.copy(_moonScaled);

    // Volumetric/flat cloud crossfade — ALTITUDE-based (see the
    // VOLUMETRIC_BLEND_*_ALT_KM constants for rationale + history). 0 above
    // 3000 km altitude (flat overlay only; SpaceRenderer skips the cloud
    // passes entirely), 1 below 1500 km (volumetric over the near field, flat
    // overlay only beyond per-pixel reach). The near-tier shell mounts at
    // 35 k km distance with blend = 0, so there's no mount discontinuity.
    const altKm = distKm - PLANET_RADIUS_KM;
    uniforms.uVolumetricBlend.value = THREE.MathUtils.clamp(
      (VOLUMETRIC_BLEND_START_ALT_KM - altKm) /
        (VOLUMETRIC_BLEND_START_ALT_KM - VOLUMETRIC_BLEND_FULL_ALT_KM),
      0,
      1,
    );

    // Flat 2D cloud overlay fade. Fade the surface-painted cloud overlay out
    // as the camera drops to/below the cloud top — otherwise it draws ghost
    // clouds on the ground beneath a camera that's inside/under the deck
    // (see buildEarthFragmentNode).
    uniforms.uFlatCloudOpacity.value = THREE.MathUtils.clamp(
      (altKm - CLOUD_TOP_ALTITUDE_KM) /
        (FLAT_OVERLAY_FULL_ALT_KM - CLOUD_TOP_ALTITUDE_KM),
      0,
      1,
    );
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
      uVolumetricBlend: uniforms.uVolumetricBlend,
      uFlatCloudOpacity: uniforms.uFlatCloudOpacity,
      // Phase 3b: bind the shared transmittance LUT (baked by SpaceRenderer's
      // atmosphere pass) so the surface shader reads per-pixel sun colour.
      transmittanceLUT: USE_ATMOSPHERE_SURFACE_LIGHTING
        ? getAtmosphereLUTs().transmittance.texture
        : undefined,
    });
  },
};
