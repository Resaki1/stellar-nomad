// ─────────────────────────────────────────────────────────────────────
// Per-planet atmosphere parameters (physically-based scattering).
//
// Backing data for the atmosphere system planned in docs/ATMOSPHERE_PLAN.md
// (Hillaire 2020). Phase 0: data + presets only — nothing reads these yet
// (the atmosphere pass is a passthrough copy). Phase 1 feeds EARTH_ATMOSPHERE
// into the Transmittance / Multiple-scattering LUT bakes and the raymarch pass.
//
// Units: scattering / absorption coefficients are per-RGB, in m^-1, at the
// reference wavelengths (R,G,B) ≈ (680, 550, 440) nm. Density profiles are
// exponential exp(-h / scaleHeight) for Rayleigh + Mie; ozone is a tent layer
// max(0, 1 - |h - center| / (width/2)).
// ─────────────────────────────────────────────────────────────────────

import type { AtmosphereParams } from "../types";
import { PLANET_RADIUS_KM, MARS_RADIUS_KM } from "@/sim/celestialConstants";

// Unified linear-luminance working space (see ATMOSPHERE_PLAN.md §6).
// The whole scaled scene (sun illuminance, atmosphere in-scatter, surface
// lighting) shares this scale; a single EXPOSURE multiply is applied before
// tonemapping. Calibrated in Phase 1 against a noon Earth view — for now it is
// an identity placeholder so Phase 0 is a strict no-op.
export const ATMOSPHERE_EXPOSURE = 1.0;

// Earth's atmosphere — Hillaire 2020, Table 1. Real planet radius (6371 km);
// atmosphere top = ground + 100 km. These are the canonical values the whole
// reference set agrees on (modulo the Mie variant noted below).
export const EARTH_ATMOSPHERE: AtmosphereParams = {
  groundRadiusKm: PLANET_RADIUS_KM,
  atmosphereHeightKm: 100,

  // Rayleigh: air molecules. Scattering only (no absorption). σs ×10^-6 m^-1.
  rayleighScattering: [5.802e-6, 13.558e-6, 33.1e-6],
  rayleighScaleHeightKm: 8.0,

  // Mie: aerosols / haze. Cornette-Shanks phase, g = 0.8.
  // (Variant: Bruneton/Frostbite use σs = 2.0e-6 with σt = 1.11·σs. We follow
  // Hillaire 2020's table: σs = 3.996e-6, σa = 4.40e-6.)
  mieScattering: 3.996e-6,
  mieAbsorption: 4.40e-6,
  mieScaleHeightKm: 1.2,
  mieG: 0.8,

  // Ozone: absorption only, tent layer centered at 25 km, 30 km wide. Key to
  // the blue sky when the sun is near the horizon.
  ozoneAbsorption: [0.650e-6, 1.881e-6, 0.085e-6],
  ozoneCenterKm: 25,
  ozoneWidthKm: 30,

  // Uniform diffuse ground sphere used by the multi-scatter + ground-bounce term.
  groundAlbedo: [0.3, 0.3, 0.3],

  // Top-of-atmosphere sun illuminance in the unified scale. Placeholder identity
  // (white) — calibrated in Phase 1 alongside EXPOSURE and the bloom threshold.
  sunIlluminance: [1.0, 1.0, 1.0],
};

// Mars — thin, dusty, reddish, no ozone. Starting point only; art-directed
// against reference photos in Phase 5 (Mars' famous *blue* sunset comes from
// dust forward-scattering, so the Mie setup matters more than Rayleigh here).
export const MARS_ATMOSPHERE: AtmosphereParams = {
  groundRadiusKm: MARS_RADIUS_KM,
  atmosphereHeightKm: 110, // lower gravity → more extended

  // Very weak molecular scattering (thin CO₂).
  rayleighScattering: [3.0e-6, 2.2e-6, 1.6e-6],
  rayleighScaleHeightKm: 11.1,

  // Dust dominates; reddish absorption.
  mieScattering: 6.0e-6,
  mieAbsorption: 3.0e-6,
  mieScaleHeightKm: 2.5,
  mieG: 0.78,

  ozoneAbsorption: [0, 0, 0],
  ozoneCenterKm: 0,
  ozoneWidthKm: 0,

  groundAlbedo: [0.25, 0.16, 0.10],
  sunIlluminance: [1.0, 1.0, 1.0],
};

// ── Procedural derivation (Phase 5) ───────────────────────────────────
// Derive a plausible atmosphere from a small high-level knob set so future
// procedural planets get atmospheres for free. Intentionally simple for now;
// refined when procedural worlds land.
export type AtmosphereKnobs = {
  groundRadiusKm: number;
  atmosphereHeightKm: number;
  /** Air density relative to Earth (1 = Earth-like, 0 = airless). */
  densityScale: number;
  /** Dominant-gas tint applied to the Rayleigh coefficient (normalized). */
  rayleighTint: [number, number, number];
  /** Aerosol/haze amount relative to Earth. */
  hazeScale: number;
  /** Mie anisotropy. */
  mieG: number;
  groundAlbedo: [number, number, number];
};

export function proceduralAtmosphere(knobs: AtmosphereKnobs): AtmosphereParams {
  const base = EARTH_ATMOSPHERE.rayleighScattering;
  const [tr, tg, tb] = knobs.rayleighTint;
  return {
    groundRadiusKm: knobs.groundRadiusKm,
    atmosphereHeightKm: knobs.atmosphereHeightKm,
    rayleighScattering: [
      base[0] * knobs.densityScale * tr,
      base[1] * knobs.densityScale * tg,
      base[2] * knobs.densityScale * tb,
    ],
    rayleighScaleHeightKm: 8.0,
    mieScattering: EARTH_ATMOSPHERE.mieScattering * knobs.hazeScale,
    mieAbsorption: EARTH_ATMOSPHERE.mieAbsorption * knobs.hazeScale,
    mieScaleHeightKm: 1.2,
    mieG: knobs.mieG,
    ozoneAbsorption: [0, 0, 0],
    ozoneCenterKm: 0,
    ozoneWidthKm: 0,
    groundAlbedo: knobs.groundAlbedo,
    sunIlluminance: [1.0, 1.0, 1.0],
  };
}
