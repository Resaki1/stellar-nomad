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
  sunVisibility,
} from "@/components/space/sunOcclusion";
import {
  STAR_COLOR_LINEAR,
  sunIlluminanceAt,
} from "@/components/space/photometry";
import {
  STAR_LUMINOSITY_SUN,
  STAR_RADIUS_KM,
} from "@/sim/celestialConstants";

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
// Direct sunlight actually reaching the hull: base star colour × atmospheric
// transmittance × geometric eclipse visibility. Drives BOTH lights (see below).
const _directColor = new THREE.Color();
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
    ref.current.intensity = illuminance;
    fillRef.current.intensity = illuminance * BOUNCE_FILL_FRACTION;

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

    // Both lights carry the same occluded, tinted direct sunlight: the key IS
    // that light, and the fill is that light bounced off the hull. (The fill was
    // previously left at three.js's default white, so it also ignored the star's
    // blackbody hue — a D18 leftover this closes.)
    ref.current.color.copy(_directColor);
    fillRef.current.color.copy(_directColor);

    publishDirectSunState(
      illuminance,
      lighting.active ? lighting.sunTransmittance : _WHITE,
      fillRef.current.intensity,
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
    </>
  );
};

export default SunLight;
