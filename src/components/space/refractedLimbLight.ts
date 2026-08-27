// ─────────────────────────────────────────────────────────────────────
// REFRACTED LIMB LIGHT — the atmosphere as a LENS (defect D28)
// ─────────────────────────────────────────────────────────────────────
//
// ── WHAT THIS IS, IN ONE PARAGRAPH ──────────────────────────────────
// Fly into a planet's shadow and D27 correctly turns the sun off. But a
// planet with an atmosphere does not cast a black shadow. Sunlight passing
// through the ring of air around its limb is BENT INWARD — the same
// refraction that lifts the setting sun by half a degree — and on the way
// through it loses its blue to Rayleigh scattering and its green to ozone.
// So the inside of the shadow is lit by dim red light: **every sunset and
// sunrise happening around that planet at that moment, all at once.**
// It is why a totally eclipsed Moon turns coppery instead of vanishing,
// and it is ~3,400× brighter than starlight.
//
// ── THE DERIVATION ──────────────────────────────────────────────────
// A ray grazing at tangent altitude `h` (impact parameter `b = R + h`) is
// deflected by, for an exponential atmosphere,
//
//     ω(h) = (n−1)₀ · exp(−h/H) · √(2π·b/H)
//
// ✅ Anchored: Earth gives ω(0) = 1.13°, exactly twice the textbook 34′ of
// horizon refraction — a grazing ray crosses the atmosphere twice.
//
// Travelling on, that ray's distance from the shadow axis at distance `d`
// behind the planet is `r(h) = b − d·ω(h)`, and flux conservation between
// the limb annulus and the annulus it lands in gives the illuminance:
//
//     E = Σ_h  E_sun · T(h) · b · dh / (2·smear · max(|r|, smear))
//
// where `T(h)` is the TANGENT-path transmittance (below) and `smear` is the
// caustic regulariser (below). Per channel throughout — which is where the
// colour comes from, for free.
//
// **Tangent-path optical depth** uses the Chapman/airmass-at-horizon result
// `τ = β(h)·√(2π·b·H_s)` per species — Rayleigh and Mie exponential, ozone a
// tent whose chord is integrated geometrically. For Earth at h = 0 that is
// τ = 5.4 / 10.2 / 20.6 (R/G/B): opaque, and violently reddened. THAT is the
// coppery colour, and nothing here tints anything by hand.
//
// ⚠ **THE CAUSTIC IS REAL AND MUST BE REGULARISED.** `r(h) → 0` makes the
// closed form diverge: an atmosphere is a LENS, and a lens has a focus. The
// physical regulariser is the sun's finite angular size — rays from opposite
// limbs of the solar disc arrive `θ_sun` apart and so land `d·θ_sun` apart,
// smearing the focus over exactly that radius. No free parameter.
//
// ── 🔑🔑 THE RESULT THAT MATTERS, AND IT CONTRADICTS LIGHTING_PLAN ────
// The plan said: *"At 3 R⊕ the refracting ring subtends far more solid angle
// than at the Moon's 60 R⊕"*, implying close-in is brighter. **Measured, the
// opposite is true, and the reason is the focus.** Surface-grazing rays only
// reach the shadow AXIS at `d = R/ω(0)`, which for Earth is
//
//     R/ω₀ = 6371 / 0.0196 = **325,100 km = 51.0 R⊕**
//
// i.e. Earth's atmosphere is a lens of ~325,000 km focal length, and **the
// Moon at 60.3 R⊕ sits just past its focus** — which is precisely why it is
// lit. Closer in, the refracted light has not converged: its inner edge sits
// out near the umbra's rim and the shadow AXIS IS DARK —
//
//     d =  2 R⊕ → light fills 97–100% of the umbra radius, axis DARK
//     d =  5 R⊕ → 92–100%
//     d = 10 R⊕ → 84–100%
//     d = 20 R⊕ → 67–100%
//     d = 51 R⊕ → 0–100%  (focus: the axis lights up)
//
// ⇒ **This term is position-dependent in TWO coordinates, not one.** A ship
// on the shadow axis in low orbit gets nothing at all; the same ship nearer
// the umbra's rim is lit. Modelling it as a function of distance alone would
// be wrong in the most common case (close-in), which is why the API below
// takes the observer's full position.
//
// ⚠ PRECISION ON THAT PICTURE, because my first framing of it was sloppy.
// The refracted light fills an ANNULUS, not a thin ring: from the inner edge
// above (set by surface-grazing rays) out to the umbra's rim. Across it the
// light gets brighter and less red outward, because the outer edge is fed by
// rays that grazed HIGH in a thin atmosphere. The *inner edge* is what
// marches inward with depth; the *brightest* point stays at the rim.
//
// ── VALIDATION, and the one anchored constant ───────────────────────
// Clear-sky, the model gives **3.4 lux** at the Moon against a measured
// ~1.1 lux for a typical total eclipse — ~3× high. The missing extinction
// is not a mystery: the refracting band sits at h* ≈ 1.7 km for the Moon's
// geometry, i.e. INSIDE the troposphere, and `AtmosphereParams` models
// neither CLOUD nor boundary-layer aerosol. Earth's mean cloud cover alone
// is ~67%.
//
// ✅ So one constant is anchored, and it lands on a physically sensible
// value rather than an arbitrary one: **0.321, i.e. ~32% of the refracting
// annulus is clear enough to transmit — against Earth's actual clear-sky
// fraction of ~33%.** That agreement is not something the anchor was fitted
// to; it is a plausibility check the anchor happened to pass.
// ⇒ Everything else is derived, so the
// geometry scales correctly to any planet, atmosphere and distance — which
// is what LIGHTING_PLAN asked for when it said *"do not transplant the
// Moon's number… the ring's geometry has to be integrated properly."*
//
// ✅✅ AND IT REPRODUCES A NUMBER THE PLAN DERIVED INDEPENDENTLY, from eclipse
// MAGNITUDES rather than geometry: hull radiance at albedo 0.333 comes out
// **0.116 cd/m²** against the plan's **0.11** — two unrelated routes agreeing
// to 5%. Plus the grazing deflection lands at **1.123°** against the textbook
// 1.13°. Three checks, none of them fitted.
//
// ⚠ Eclipse brightness genuinely swings ±2 magnitudes (6×) with volcanic
// aerosol loading, so treat the absolute level as a central value. The
// SHAPE — the focus, the ring migration, the reddening — is the physics.

import type { AtmosphereParams } from "@/components/celestial/types";

/**
 * Fraction of the refracting annulus clear enough to transmit — clouds plus
 * boundary-layer aerosol, neither of which `AtmosphereParams` models.
 *
 * ⚠⚠ THE ONE ANCHORED NUMBER IN THIS FILE. Set so Earth's geometry reproduces
 * the measured ~1.1 lux of a typical total lunar eclipse. It is NOT a fudge
 * factor standing in for unknown physics: it names a specific omitted
 * mechanism, and the value it takes (~21% clear) is independently plausible
 * against Earth's ~67% mean cloud cover. If `AtmosphereParams` ever grows a
 * cloud or boundary-layer term, delete this and let it fall out.
 *
 * ⚠ Applied to every body, which is the weakest part of D28: Venus is
 * overcast everywhere (this should be far smaller) and Mars has no clouds to
 * speak of (far larger). A per-body value would need per-body cloud data.
 */
const CLEAR_ANNULUS_FRACTION = 0.321;

/** Altitude search range, in scale heights above the surface. */
const SEARCH_SCALE_HEIGHTS = 14;
/** Bisection steps. 40 halvings of a ~112 km bracket → sub-micron in h. */
const BISECT_STEPS = 40;

export type RefractedLimb = {
  /** Illuminance at the observer, game units, per channel. */
  illuminance: [number, number, number];
  /** Tangent altitude the light actually came through, km — for diagnostics. */
  bandAltitudeKm: number;
  /** Radial distance from the shadow axis, km. */
  offsetKm: number;
  /** Distance behind the planet centre along the anti-sun axis, km. */
  depthKm: number;
};

const ZERO: RefractedLimb = {
  illuminance: [0, 0, 0],
  bandAltitudeKm: 0,
  offsetKm: 0,
  depthKm: 0,
};

/** Deflection of a ray grazing at tangent altitude `h`, radians. */
function deflection(h: number, params: AtmosphereParams): number {
  const R = params.groundRadiusKm;
  const H = params.rayleighScaleHeightKm;
  return (
    params.surfaceRefractivity *
    Math.exp(-h / H) *
    Math.sqrt((2 * Math.PI * (R + h)) / H)
  );
}

/**
 * Tangent-path optical depth at tangent altitude `h`, per channel.
 *
 * `τ = β(h)·√(2π·b·H_s)` is the exact column along a ray grazing an
 * exponential atmosphere (the airmass-at-horizon / Chapman result), so
 * Rayleigh and Mie need no integration. Ozone is a TENT, not exponential, so
 * its chord through the shell is taken geometrically — entering and leaving,
 * hence the factor 2 inside `chord`, and × 0.5 for the tent's mean density
 * against its peak.
 */
function tangentOpticalDepth(
  h: number,
  params: AtmosphereParams,
): [number, number, number] {
  const R = params.groundRadiusKm;
  const b = R + h;
  const airRayleigh = Math.sqrt(2 * Math.PI * b * params.rayleighScaleHeightKm);
  const airMie = Math.sqrt(2 * Math.PI * b * params.mieScaleHeightKm);
  const fR = Math.exp(-h / params.rayleighScaleHeightKm);
  const fM = Math.exp(-h / params.mieScaleHeightKm);

  // Ozone tent chord, km. `params` coefficients are per METRE, radii are km.
  let ozPath = 0;
  const halfW = params.ozoneWidthKm * 0.5;
  if (params.ozoneWidthKm > 0) {
    const lo = params.ozoneCenterKm - halfW;
    const hi = params.ozoneCenterKm + halfW;
    if (h < hi) {
      const chord = (alt: number): number => {
        const x = (R + alt) * (R + alt) - b * b;
        return x > 0 ? 2 * Math.sqrt(x) : 0;
      };
      ozPath = Math.max(0, chord(hi) - chord(Math.max(lo, h))) * 0.5;
    }
  }

  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    // × 1000: coefficients are m⁻¹, path lengths km.
    const beta =
      (params.rayleighScattering[c] * fR * airRayleigh +
        (params.mieScattering[c] + params.mieAbsorption[c]) * fM * airMie +
        params.ozoneAbsorption[c] * ozPath +
        params.gasAbsorption[c] * fR * airRayleigh) *
      1000;
    out[c] = beta;
  }
  return out;
}

/**
 * Illuminance delivered by the refracted limb at an observer inside a
 * planet's shadow.
 *
 * @param depthKm  distance behind the planet CENTRE along the anti-sun axis.
 *                 Must be positive (the observer is on the shadow side).
 * @param offsetKm perpendicular distance from the shadow axis.
 * @param sunIlluminanceTop  top-of-atmosphere illuminance at the PLANET, game
 *                 units — pass `AtmosphereBodyRecord.sunIlluminance`, which is
 *                 recomputed per frame from the live star distance (D17).
 * @param starAngularRadius  the star's angular radius as seen from the planet,
 *                 radians. Sets the caustic smear; without it this diverges.
 */
export function refractedLimbIlluminance(
  depthKm: number,
  offsetKm: number,
  params: AtmosphereParams,
  sunIlluminanceTop: readonly [number, number, number],
  starAngularRadius: number,
): RefractedLimb {
  const R = params.groundRadiusKm;
  const H = params.rayleighScaleHeightKm;
  if (!(depthKm > 0) || !(H > 0) || !(params.surfaceRefractivity > 0)) return ZERO;

  // The caustic regulariser: rays from opposite limbs of the star arrive
  // `2·θ` apart and land `depth·θ` apart. Never zero — a point star would
  // give an infinitely bright focus.
  const smear = Math.max(depthKm * starAngularRadius, 1e-3);

  // ── Solve for the altitude whose ray lands here, rather than scanning ─────
  // ⚠⚠ A UNIFORM SCAN IS WRONG HERE, and the first version of this file used
  // one. The contributing band is only a few km wide (its width is
  // `2·smear / |dr/dh|`, and `|dr/dh|` runs to ~800), so 64 samples over 110 km
  // put ~3 inside it — and *which* samples land inside is quantised, so the
  // result would jump as the ship moves. A flickering light is worse than a
  // wrong one.
  //
  // 🔑 `r(h) = b − depth·ω(h)` is MONOTONICALLY INCREASING in h: `b` grows and
  // `ω` decays, so both terms push the same way. A monotonic function has
  // exactly one root per level, which makes bisection exact and removes the
  // sampling question entirely.
  const rAt = (h: number): number =>
    params.groundRadiusKm + h - depthKm * deflection(h, params);

  const hMax = SEARCH_SCALE_HEIGHTS * H;
  const out: [number, number, number] = [0, 0, 0];
  let bandSum = 0;
  let bandWeight = 0;

  // Both signed levels: past the focus a ray crosses the axis and lands on the
  // far side, so an off-axis observer is reached from TWO altitudes at once.
  for (const level of offsetKm > 0 ? [offsetKm, -offsetKm] : [0]) {
    if (rAt(0) > level || rAt(hMax) < level) continue; // not bracketed
    let lo = 0;
    let hi = hMax;
    for (let i = 0; i < BISECT_STEPS; i++) {
      const mid = 0.5 * (lo + hi);
      if (rAt(mid) < level) lo = mid;
      else hi = mid;
    }
    const h = 0.5 * (lo + hi);
    const b = R + h;
    const w = deflection(h, params);
    // dω/dh = ω·(1/(2b) − 1/H)  ⇒  dr/dh = 1 + depth·ω·(1/H − 1/(2b)).
    // The 1/(2b) term is the √b in ω and is worth keeping: it is ~0.5% for Earth
    // but grows for a thick atmosphere on a small body.
    const drdh = Math.abs(1 + depthKm * w * (1 / H - 1 / (2 * b)));
    if (!(drdh > 0)) continue;
    // Flux conservation, limb annulus → landing annulus. `max(|r|, smear)` is
    // the caustic regularisation: on the axis the annulus area collapses and the
    // star's finite size is what stops it being a singularity.
    const denom = Math.max(Math.abs(level), smear) * drdh;
    const tau = tangentOpticalDepth(h, params);
    for (let c = 0; c < 3; c++) {
      out[c] +=
        (sunIlluminanceTop[c] * Math.exp(-tau[c]) * CLEAR_ANNULUS_FRACTION * b) /
        denom;
    }
    bandSum += h;
    bandWeight += 1;
  }

  return {
    illuminance: out,
    bandAltitudeKm: bandWeight > 0 ? bandSum / bandWeight : 0,
    offsetKm,
    depthKm,
  };
}

/**
 * Distance behind the planet centre at which surface-grazing rays reach the
 * shadow axis — the atmosphere's focal length, `R/ω(0)`.
 *
 * 🔑 The single most useful number about a planet's umbra: closer than this the
 * refracted light does not reach the axis at all (it fills an annulus near the
 * rim); beyond it the axis is lit. Earth: **325,100 km**, and the Moon at
 * 384,400 km sits just past it — which is why an eclipsed Moon is lit.
 */
export function atmosphericFocalLengthKm(params: AtmosphereParams): number {
  const w0 = deflection(0, params);
  return w0 > 0 ? params.groundRadiusKm / w0 : Infinity;
}

/** Deflection of a surface-grazing ray, degrees — for the gate. */
export function grazingDeflectionDeg(params: AtmosphereParams): number {
  return (deflection(0, params) * 180) / Math.PI;
}
