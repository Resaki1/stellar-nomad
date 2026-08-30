"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { STAR_POSITION_KM } from "./Star";
import { useWorldOrigin } from "@/sim/worldOrigin";
import {
  getAtmosphereLighting,
  getDominantAtmosphereBody,
} from "@/components/space/atmospherePass";
import {
  publishDirectSunState,
  sunOccluderCenterKm,
  sunVisibility,
} from "@/components/space/sunOcclusion";
import {
  refractedLimbIlluminance,
  type RefractedLimb,
} from "@/components/space/refractedLimbLight";
import {
  STAR_COLOR_LINEAR,
  getPreExposure,
  sunIlluminanceAt,
} from "@/components/space/photometry";
import {
  STAR_LUMINOSITY_SUN,
  STAR_RADIUS_KM,
} from "@/sim/celestialConstants";
import {
  publishHullShine,
  shineLightsAt,
  type ShineLight,
} from "@/components/celestial/planetshine";

type SunLightProps = {
  sunPositionKm?: [number, number, number];
  /**
   * Ignored for magnitude — kept only so existing call sites type-check. The
   * key light's intensity is now DERIVED from the live star distance; see below.
   */
  intensity?: number;
  color?: string | number;
};

const _dir = new THREE.Vector3();
// D28 scratch — refracted-limb geometry, resolved on the CPU once per frame.
const _toPlanet = new THREE.Vector3();
const _antiSun = new THREE.Vector3();
const _limbColor = new THREE.Color();
let _lastLimb: RefractedLimb | null = null;
// Direct sunlight actually reaching the hull: base star colour × atmospheric
// transmittance × geometric eclipse visibility. Drives BOTH lights (see below).
const _directColor = new THREE.Color();
const _shineColor = new THREE.Color();
const _shineLights: ShineLight[] = [
  { id: "", distKm: 0, dirX: 0, dirY: 0, dirZ: 1, r: 0, g: 0, b: 0 },
  { id: "", distKm: 0, dirX: 0, dirY: 0, dirZ: 1, r: 0, g: 0, b: 0 },
];
const _WHITE = new THREE.Color(1, 1, 1);

// ── Bounce/zodiacal fill, as a FRACTION of the star's illuminance ────────────
// The flat `<ambientLight intensity={0.5} />` that used to live in Scene.tsx was
// distance-independent, which is untenable once the key light scales as 1/r²: at
// Neptune the sun delivers 0.023 game units, so a fixed 0.5 fill would have been
// **21× brighter than the sun** and the ship would read as a flat grey cut-out in
// the outer system. Expressing it as a fraction of the star's illuminance keeps
// it physically sane (it stands for self-bounce off the hull plus zodiacal light,
// both of which DO scale with sunlight) and it scales for free in generated
// systems.
//
// 1/60 is chosen to PRESERVE THE SHIPPED KEY:FILL RATIO exactly: the old pair
// was 30 : 0.5 = 60 : 1. So the only change at 1 AU is that both terms drop by
// the same 30 → 21.2 factor (see below), which the exposure stage absorbs — the
// ship's modelling is untouched, only its absolute level is corrected.
//
// D27 — THE FILL IS OCCLUDED WITH THE KEY. This term stands for sunlight
// bouncing off the hull onto itself, so it is a FUNCTION of the direct sun and
// must vanish when the direct sun does. It used to be driven by illuminance
// alone, which is what made the ship glow inside Neptune's umbra: the key light
// went correctly black (the atmosphere pass zeroes its transmittance there) and
// this fill kept delivering illuminance/60 from every direction, uniformly, with
// no falloff. Measured at Neptune: 21.2/30.08²/60 = 3.90e-4 game units of
// ambient × albedo/π → 0.25 cd/m² at hull albedo 0.333, matching the observed
// peak exactly. That 0.25 cd/m² was 99% of the metered flux, so the eye adapted
// to the ship and the stars disappeared (the symptom logged as D26).
//
// The one term that genuinely does NOT vanish in an umbra is zodiacal light, but
// it is ~1e-4 cd/m² — three orders below the hull self-bounce this fraction was
// fitted to, and below the half-float floor D25 is about anyway. Modelling it is
// not worth a constant.
//
// A ship in a planet's umbra now goes very nearly black. That is correct, not a
// regression: an eclipsed spacecraft is lit only by starlight and by the thin
// sunlit crescent of the planet's limb. PLANETSHINE — which does light the hull
// at crescent phases, and is a derivable (2/3)·A·E·(R/d)²·Φ(α) term needing no
// tuning — is Phase 4 IBL work, not this fix.
const BOUNCE_FILL_FRACTION = 1 / 60;

const SunLight = ({
  sunPositionKm = STAR_POSITION_KM,
  color,
}: SunLightProps) => {
  const ref = useRef<THREE.DirectionalLight>(null!);
  const fillRef = useRef<THREE.AmbientLight>(null!);
  // Phase 9 (P9e): planetshine on the HULL. Two lights, because the emitter
  // ranking falls off a cliff — Jupiter delivers 385,000× the starlight floor to
  // a ship off Io and the next contributor is a rounding error — but two covers a
  // ship between a planet and a large moon.
  const shineARef = useRef<THREE.DirectionalLight>(null!);
  const shineBRef = useRef<THREE.DirectionalLight>(null!);
  const limbRef = useRef<THREE.DirectionalLight>(null!);
  const worldOrigin = useWorldOrigin();
  // ── Key-light colour: the STAR's blackbody hue, not white (defect D18) ──────
  // This was hardcoded `"white"`, so the ship and asteroids were lit by a D65
  // illuminant while the star's own disc rendered at its blackbody colour — the
  // two disagreed. Luminance-normalised, so the intensity set below is still the
  // full illuminance; only the hue changes. An explicit `color` prop still wins,
  // for debugging. See STAR_COLOR_LINEAR for the white-balance caveat.
  const baseColor = useMemo(
    () =>
      color !== undefined
        ? new THREE.Color(color)
        : new THREE.Color(...STAR_COLOR_LINEAR),
    [color],
  );

  useFrame(() => {
    // DirectionalLight.position is interpreted as a direction vector.
    // Compute sun direction relative to the ship so it stays correct
    // regardless of the world origin.
    _dir.set(
      sunPositionKm[0] - worldOrigin.shipPosKm.x,
      sunPositionKm[1] - worldOrigin.shipPosKm.y,
      sunPositionKm[2] - worldOrigin.shipPosKm.z,
    );

    // ── Phase 3: the key light's MAGNITUDE, from the live star distance ──────
    // Was a hardcoded `intensity = 30` — the single largest structural error left
    // in the system (D03). Every planet already scaled as 1/r² after Phase 2a,
    // so the ship was the one object on screen still lit by a constant: 4.7× too
    // DIM at Mercury and 1,282× too BRIGHT at Neptune, a 6,050× span.
    //
    // Deliberately the SAME `sunIlluminanceAt` the planet surfaces and the
    // atmosphere pass use, so the ship cannot drift from the bodies it flies
    // between, and `STAR_LUMINOSITY_SUN` makes it correct for generated systems
    // with no per-system tuning (§3.0). At 1 AU this returns 21.2 game units —
    // the convention's own value — so the ship gets 30/21.2 = 1.42× dimmer at
    // Earth. That is the correction, not a regression: 30 was arbitrary.
    const distKm = _dir.length();
    const illuminance = sunIlluminanceAt(distKm, STAR_LUMINOSITY_SUN);
    // × preExposure (D25). three.js irradiance is linear in `intensity`, so the
    // whole local scene (ship, asteroids) pre-exposes from these two writes. It
    // MUST use the same factor as the planets' `uSunIlluminance` — the ship flies
    // between bodies lit by that, and a mismatch would be a visible seam.
    const preExp = getPreExposure();
    ref.current.intensity = illuminance * preExp;
    fillRef.current.intensity = illuminance * preExp * BOUNCE_FILL_FRACTION;

    _dir.normalize();
    ref.current.position.copy(_dir);

    // Phase 2: tint the key light by the atmospheric transmittance reaching the
    // camera (sunset reddening + planet-shadow darkening on the ship). White
    // when no atmosphere body is in range (deep space → unchanged look).
    const lighting = getAtmosphereLighting();
    _directColor.copy(baseColor);
    if (lighting.active) _directColor.multiply(lighting.sunTransmittance);

    // ── D27: geometric eclipse by every body EXCEPT the dominant one ──────────
    // The dominant atmosphere body's own shadow is already in `sunTransmittance`
    // above, and better than a pure-geometry test can do it (it reddens through
    // the limb). Skipping it here keeps exactly one owner per body — applying
    // both would multiply two different soft ramps and narrow the penumbra. Every
    // other body (atmosphere-less moons, a second body in the same system, or a
    // body whose sphere LOD has dropped out so it no longer registers with the
    // atmosphere pass at all) is handled here. See space/sunOcclusion.ts.
    const visibility = sunVisibility(
      worldOrigin.shipPosKm,
      sunPositionKm,
      STAR_RADIUS_KM,
      getDominantAtmosphereBody()?.id ?? null,
    );
    if (visibility < 1) _directColor.multiplyScalar(visibility);

    // ── D28: REFRACTED LIMB LIGHT — the atmosphere as a lens ─────────────────
    // Closing D27 raised the question "should an eclipsed ship be black?", and
    // physically the answer is no: sunlight refracted through the ring of air at
    // the planet's limb reddens and bends into the shadow. It is why a totally
    // eclipsed Moon is coppery instead of invisible, and it is ~3,400× starlight.
    //
    // ⚠ Only the DOMINANT atmosphere body. That is the one whose shadow the
    // player actually flies into, it is the only one whose `params` are to hand,
    // and it is the body `sunVisibility` deliberately skips (its shadow belongs
    // to the atmosphere pass) — so this adds a term to that body rather than
    // double-counting one already handled geometrically above.
    _lastLimb = null;
    _limbColor.setRGB(0, 0, 0);
    let limbIntensity = 0;
    const atmoBody = getDominantAtmosphereBody();
    // How deep in shadow are we? The atmosphere pass has already zeroed
    // `sunTransmittance` inside the umbra, so its complement IS the shadow ramp.
    // Reusing it keeps the two terms exactly complementary through the penumbra
    // instead of cross-fading two independently-shaped ramps — the
    // one-owner-per-body rule sunOcclusion.ts documents.
    const shadow = lighting.active
      ? 1 -
        Math.max(
          lighting.sunTransmittance.r,
          Math.max(lighting.sunTransmittance.g, lighting.sunTransmittance.b),
        )
      : 0;
    // ⚠⚠ FRAME DISCIPLINE, and this is where my first version was wrong.
    // `atmoBody.centerScaled` is SCALED-WORLD while `shipPosKm` is km, so
    // subtracting them yields a vector with the right direction and a
    // meaningless magnitude. Worse, the shortcut I reached for instead —
    // dotting the ship→sun direction against the planet→sun direction — is ≈1
    // for ANY ship near the planet (both point at the same distant star), so it
    // reported "on the shadow axis" ALWAYS, which is the one answer that is
    // wrong close in. `sunOccluderCenterKm` gives the absolute km centre that
    // every CelestialBody already registers, in one consistent frame.
    const limbCenterKm = atmoBody ? sunOccluderCenterKm(atmoBody.id) : null;
    if (atmoBody && limbCenterKm && shadow > 1e-3) {
      _toPlanet.copy(worldOrigin.shipPosKm).sub(limbCenterKm);
      _antiSun.copy(atmoBody.sunDir).negate().normalize();
      // Depth along the anti-sun axis, and perpendicular offset from it. BOTH
      // are needed — refractedLimbLight.ts explains why one is not enough.
      const depthKm = _toPlanet.dot(_antiSun);
      const offsetKm = Math.sqrt(
        Math.max(0, _toPlanet.lengthSq() - depthKm * depthKm),
      );
      if (depthKm > atmoBody.params.groundRadiusKm) {
        const starAng = Math.asin(
          Math.min(1, STAR_RADIUS_KM / Math.max(atmoBody.starDistanceKm, 1)),
        );
        // ⚠⚠ RECOMPUTED, NOT READ FROM THE RECORD. `rec.sunIlluminance` is
        // `illum × getPreExposure() × starTint` (D25), so passing it in and then
        // multiplying the result by `preExp` below applies pre-exposure TWICE —
        // the rendered light comes out wrong by **p²**, which in a dark scene is
        // 10⁴–10⁶×. Symptom on device: a blazing red hull, and a `__lum.umbra()`
        // table whose values changed with where the ship was standing.
        //
        // 🔑🔑 THIS IS EXACTLY THE D09c TRAP, in the same field, and I had read
        // that entry earlier the same day: "`expected()` took
        // `rec.sunIlluminance.x`, which `atmospherePass` sets to
        // `illum × getPreExposure() × starTint[0]`". ⇒ **`sunIlluminance` on
        // `AtmosphereBodyRecord` is PRE-EXPOSED. Anything on the CPU that wants
        // absolute game units must recompute from `starDistanceKm`.**
        const illumRaw = sunIlluminanceAt(
          atmoBody.starDistanceKm,
          atmoBody.params.starLuminositySun,
        );
        const limb = refractedLimbIlluminance(
          depthKm,
          offsetKm,
          atmoBody.params,
          [
            illumRaw * STAR_COLOR_LINEAR[0],
            illumRaw * STAR_COLOR_LINEAR[1],
            illumRaw * STAR_COLOR_LINEAR[2],
          ],
          starAng,
        );
        _lastLimb = limb;
        const [lr, lg, lb] = limb.illuminance;
        const maxC = Math.max(lr, lg, lb);
        if (maxC > 0) {
          // three.js multiplies colour × intensity, so the MAGNITUDE lives in
          // `intensity` and the colour stays normalised — the hidden-multiplier
          // trap D26h found in the exhaust light.
          _limbColor.setRGB(lr / maxC, lg / maxC, lb / maxC);
          // × preExposure (D25), like every other light in the project.
          limbIntensity = maxC * shadow * preExp;
        }
      }
    }
    limbRef.current.color.copy(_limbColor);
    limbRef.current.intensity = limbIntensity;
    // ⚠ Points FROM the planet TOWARD the ship: the refracting ring surrounds
    // the planet's disc, so its centroid direction is the planet's. A ring is
    // wider than a directional light implies — a hull facet facing away from the
    // planet would catch some of it in reality and catches none here. Acceptable
    // while the ring is small, which is exactly when this term is largest
    // (beyond the focus); revisit if close-in umbra views become common.
    limbRef.current.position.copy(_antiSun).negate();
    limbRef.current.visible = limbIntensity > 0;

    // ── P9e: PLANETSHINE ON THE HULL ─────────────────────────────────────────
    // Physically the same term the planet surfaces got in P9d, and a real one:
    // Apollo photographed the CSM lit by earthshine, and a ship off Io sits in
    // ~60 lux of reflected Jupiter (EV100 −6, brighter than a moonlit landscape).
    //
    // ⚠⚠ THE SKIP IS THE LOAD-BEARING PART. `AtmosphereSkyLight` already delivers
    // the DOMINANT atmosphere body's ground-bounce to the hull, as the "ground"
    // half of its hemisphere light — so adding this on top would count the same
    // photons twice, and worst exactly where it is largest: low over a day side.
    // 🔑 Same ownership rule, and the same `getDominantAtmosphereBody()` call,
    // that `sunVisibility()` above uses for that body's shadow. One owner per
    // body. ⚠ Conditioned on `lighting.active`: out of atmosphere range the
    // hemisphere light contributes nothing, so the skip must lift or a ship near
    // Luna would lose earthshine entirely.
    // ⚠⚠ `skyIntensity > 0`, NOT `lighting.active`. MEASURED FAILURE from the
    // first version, which skipped on `active` alone: `_lighting.active` is true
    // whenever ANY atmosphere body is in LOD range — millions of km — while
    // `skyIntensity = SKY_AMBIENT_MAX_INTENSITY · densityAtCam · dayFactor` is
    // zero unless the camera is actually INSIDE that atmosphere on its day side.
    // So the skip fired essentially everywhere and deleted the term it was meant
    // to protect. On device: a ship at Luna's dark side lost EARTHSHINE entirely
    // (17.4 lux → black), and at Io the only surviving emitter was Io itself —
    // "the light looks like it comes from Io, not Jupiter", which is exactly what
    // a skipped Jupiter leaves behind.
    // 🔑 A guard for "someone else already owns this" must test whether that
    // owner is DELIVERING, not whether it exists.
    const shineSkip =
      lighting.active && lighting.skyIntensity > 0
        ? (getDominantAtmosphereBody()?.id ?? null)
        : null;
    const shipPos = worldOrigin.shipPosKm;
    const shineCount = shineLightsAt(
      [shipPos.x, shipPos.y, shipPos.z],
      sunPositionKm,
      STAR_LUMINOSITY_SUN,
      shineSkip,
      _shineLights,
      STAR_RADIUS_KM,
    );
    for (let i = 0; i < 2; i++) {
      const light = (i === 0 ? shineARef : shineBRef).current;
      const sl = i < shineCount ? _shineLights[i] : null;
      // ⚠ Colour NORMALISED, magnitude in `intensity` — the D26h hidden-multiplier
      // trap. A tinted colour AND a magnitude in the same value cannot be audited.
      const lum = sl ? 0.2126 * sl.r + 0.7152 * sl.g + 0.0722 * sl.b : 0;
      if (!sl || lum <= 0) {
        light.intensity = 0;
        light.visible = false;
        continue;
      }
      _shineColor.setRGB(sl.r / lum, sl.g / lum, sl.b / lum);
      light.color.copy(_shineColor);
      light.intensity = lum * preExp;
      light.position.set(sl.dirX, sl.dirY, sl.dirZ);
      light.visible = true;
    }
    publishHullShine(_shineLights, shineCount, shineSkip, preExp);

    // Both lights carry the same occluded, tinted direct sunlight: the key IS
    // that light, and the fill is that light bounced off the hull. (The fill was
    // previously left at three.js's default white, so it also ignored the star's
    // blackbody hue — a D18 leftover this closes.)
    ref.current.color.copy(_directColor);
    fillRef.current.color.copy(_directColor);

    // Published in ABSOLUTE game units (pre-exposure divided back out) so
    // `__lum.sun()` keeps reporting physical numbers after D25.
    publishDirectSunState(
      illuminance,
      lighting.active ? lighting.sunTransmittance : _WHITE,
      fillRef.current.intensity / preExp,
      _lastLimb,
    );
  });

  // `color` here is only the initial value — the useFrame above owns the live
  // colour (base × transmittance) every frame. Safe because localContent never
  // re-renders (Scene.tsx useMemo([])), so the prop is never re-applied.
  // Intensities start at 0 and are set on the first frame from the live distance.
  return (
    <>
      <directionalLight ref={ref} intensity={0} />
      <ambientLight ref={fillRef} intensity={0} />
      {/* D28 refracted limb light — off until the ship is inside a shadow. */}
      <directionalLight ref={limbRef} intensity={0} visible={false} />
      {/* P9e planetshine — earthshine on the hull, Jupiter over Io. */}
      <directionalLight ref={shineARef} intensity={0} visible={false} />
      <directionalLight ref={shineBRef} intensity={0} visible={false} />
    </>
  );
};

export default SunLight;
