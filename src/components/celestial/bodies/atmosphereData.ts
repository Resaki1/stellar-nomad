// ─────────────────────────────────────────────────────────────────────
// Atmosphere derivation (Phase 5) — physically-based AtmosphereParams from a
// planet's bulk description (docs/ATMOSPHERE_PLAN.md §7 Phase 5).
//
// Planets are DESCRIBED, not tuned: sol.json gives each body its mass, surface
// pressure/temperature and gas composition (plus art-directed aerosol knobs —
// dust/cloud load is not derivable from bulk physics), and deriveAtmosphere()
// turns that into the renderer's AtmosphereParams:
//
//   mass + radius        → surface gravity → density scale height H = RT/(Mg)
//   pressure/temperature → surface number density → Rayleigh magnitude
//   composition          → per-gas Rayleigh cross-sections (Rayleigh tint),
//                          molar mass (scale height), CH4-style molecular
//                          absorption (teal/blue ice giants), O2 → ozone proxy
//   star distance + L    → top-of-atmosphere sun illuminance
//
// Everything is ANCHORED so Earth's description reproduces Hillaire 2020
// Table 1 (the hand-validated Phase 1-4 values) to <0.2% — the derivation is
// calibrated at Earth and extrapolated by physical ratios, so procedurally
// generated planets stay on the same visual scale.
//
// Units: scattering/absorption coefficients are per-RGB, in m^-1, at the
// reference wavelengths (R,G,B) ≈ (680, 550, 440) nm. Density profiles are
// exponential exp(-h / scaleHeight) for Rayleigh + Mie (+ the well-mixed gas
// absorber riding the Rayleigh profile); ozone is a tent layer.
// ─────────────────────────────────────────────────────────────────────

import { activeSystem } from "@/sim/systemRegistry";
import type { AtmosphereGasId, CelestialBodyDef } from "@/sim/systemTypes";
import { sunIlluminanceAt } from "@/components/space/photometry";
import type { AtmosphereParams, Vec3Tuple } from "../types";

// The unified linear-luminance working space now lives in
// `space/photometry.ts` — 1 game unit ≈ 6,038 cd/m², and the single global
// EXPOSURE multiply is `uExposure`, applied in SpaceRenderer's post chain.
// (The old `ATMOSPHERE_EXPOSURE = 1.0` placeholder was referenced by nothing
// for the whole of Phases 1–5; deleted rather than left as a decoy.)

// ── Physical constants ─────────────────────────────────────────────────
const R_GAS = 8.314462; // universal gas constant, J/(mol·K)
const G_GRAV = 6.674e-11; // gravitational constant, m³/(kg·s²)

// ── Earth anchors (Hillaire 2020, Table 1) ─────────────────────────────
// The derivation is a set of physical RATIOS against these. Earth sea-level
// air at 1.01325 bar / 288 K scatters RAYLEIGH_EARTH (the table is pure λ⁻⁴:
// 13.558·(550/680)⁴ = 5.803, ·(550/440)⁴ = 33.10 — so one 550 nm magnitude +
// λ⁻⁴ covers the spectrum, and other gases only scale the magnitude).
const EARTH_PRESSURE_BAR = 1.01325;
const EARTH_TEMPERATURE_K = 288;
const RAYLEIGH_EARTH: Vec3Tuple = [5.802e-6, 13.558e-6, 33.1e-6];
// Refractivity (n − 1) of Earth air at the SAME reference state as RAYLEIGH_EARTH
// (1.01325 bar / 288 K), ~550 nm. D28's atmospheric-lens term scales off this.
// ✅ Cross-check: a ray passing tangentially through the whole atmosphere bends by
// `(n−1)·√(2πR/H)` = 2.77e-4 × 70.7 = **1.13°**, which is twice the standard 34′
// of horizon refraction — the textbook value for a grazing through-ray, and the
// number lunar-eclipse geometry is built on.
const REFRACTIVITY_AIR_REF = 2.77e-4;
const RAYLEIGH_SCALE_HEIGHT_EARTH_KM = 8.0;
const MIE_SCATTER_EARTH = 3.996e-6; // clear-sky aerosol baseline (haze = 1)
// 🐛🐛 WAS 4.4e-6, WHICH IS BRUNETON'S MIE **EXTINCTION** IN THE ABSORPTION SLOT (D35).
// Two exact four-significant-figure fingerprints establish it without needing the paper:
//   3.996 / 4.44 = 0.900000  → the scattering constant exists only as 0.9 × 4.44e-6,
//                              i.e. the source model's Mie SSA of 0.9 BY CONSTRUCTION
//   4.44e-6 × 1200 m = 5.328e-3 → exactly Bruneton's kMieAngstromBeta
// and the shipped value fails the same test: 3.996 / 4.4 = 0.9082, not 0.9.
// ⇒ absorption = extinction − scattering = 4.44e-6 − 3.996e-6.
//
// 🔑 HOW IT WAS FOUND, because the method generalises: `__lum.atmoSpectrum()` prints
// aerosol single-scatter albedo, and Earth, Uranus and Neptune all reported
// 0.4759409242496427 — identical to 16 digits. A per-body physical property cannot be
// bit-identical across three bodies, so that is a shared constant leaking through.
// **Add the column that would expose a mis-slotted coefficient as a shared value.**
//
// ⚠ Effect: Earth's aerosol extinction τ falls 0.0101 → 0.00533 (= 4.44e-6 × 1.2 km,
// exactly the source table, so the header's "ozone/Mie exact" claim is finally true)
// and its SSA rises 0.476 → 0.900. A near-half-absorbing aerosol was a grey
// neutral-density filter, not an aerosol.
// ⚠⚠ EVERY `haze` IN sol.json WAS ART-DIRECTED AGAINST THE WRONG UNIT, so this could
// not land alone — Mars' block moves with it in this commit. Jupiter's and Saturn's
// aerosols also thin by ~2x here; both are pending their own fits (LIGHTING_PLAN D36).
const MIE_ABSORB_EARTH = 4.44e-7;
const MIE_SCALE_HEIGHT_EARTH_KM = 1.2;
// ⚠ `haze` MULTIPLIES A CLEAN-SKY BASELINE, so Earth's 15 is a NORMAL DAY, not 15×
// hazy: AOD(550) = 4.44e-6 × 1.2 km × haze ⇒ haze 1 = 0.0053 (Bruneton's pristine
// value — Koschmieder visual range 3.912/β = 217 km, which no real Earth atmosphere
// achieves), haze 15 = 0.080 = the median clear-sky column, V = 49 km (D39).
const OZONE_EARTH: Vec3Tuple = [0.65e-6, 1.881e-6, 0.085e-6];
const OZONE_O2_REF = 0.209; // Earth's O2 mole fraction → OZONE_EARTH
const OZONE_CENTER_EARTH_KM = 25;
const OZONE_WIDTH_EARTH_KM = 30;
// Ideal-gas H = RT/(Mg) uses the SURFACE temperature, but the column cools
// with altitude; this effective-column factor calibrates Earth (288 K,
// 28.96 g/mol, 9.82 m/s²) to exactly Hillaire's 8.0 km density scale height.
// ⚠⚠ RE-PINNED from 0.9502 when D36 switched to the effective gravity. This factor
// exists ONLY to land Earth on Hillaire's exactly-8.000 km, so it has to move whenever
// the gravity it divides does — otherwise the anchor body silently drifts off its own
// reference. Fixing the gravity and leaving this alone would have moved Earth to
// 8.046 km, which is the same two-sided-cancellation trap as the Venus trim.
// Solved as 8.0 km × (M_air · g_eff,Earth) / (R · T_Earth) with g_eff = 9.7642 m/s².
const COLUMN_TEMP_FACTOR = 0.944837;
// Atmosphere top = this many Rayleigh scale heights (density ~e⁻¹²·⁵ ≈ 4e-6
// of surface — visually nothing above). Earth: 12.5 × 8 km = the canonical 100.
const TOP_SCALE_HEIGHTS = 12.5;
// SUN_ILLUM_GAME_1AU (the game-luminance units received at 1 AU from a 1 L☉
// star) moved to space/photometry.ts, which is now the single definition of the
// light scale. Illuminance itself is derived PER FRAME there, not here.

// ── Gas table ──────────────────────────────────────────────────────────
// rayleighRel = Rayleigh scattering cross-section at 550 nm RELATIVE to Earth
// air, from refractivity + King factor: ((n−1)g/(n−1)air)² · (Fg/Fair). CO2
// scatters ~2.6× air per molecule; H2/He barely at all (why gas-giant limbs
// stay subtle despite deep columns). λ⁻⁴ dispersion is assumed universal —
// per-gas dispersion differences are a ~% effect, ignored.
// absorption = molecular absorption (m^-1 per RGB) the PURE gas would add at
// Earth-air surface number density. Only CH4 matters in practice: its red/
// near-IR bands (620/730/890 nm) are what turn Uranus/Neptune teal-blue.
// Magnitude is a game anchor (real band integration is overkill), set so
// Uranus' 2.3% CH4 column reaches red optical depth ≈ 2.
export type GasProps = {
  molarKgPerMol: number;
  rayleighRel: number;
  absorption?: Vec3Tuple;
};

/**
 * ⚠ EXPORTED FOR THE ACOUSTIC MODEL (`src/audio/acoustics.ts`), which needs the
 * same mean molar mass this table already carries in order to compute a body's
 * speed of sound and gas density. Exported rather than duplicated: a second
 * molar-mass table would silently drift from this one.
 *
 * The acoustic module adds the properties THIS table has no reason to hold
 * (heat-capacity ratio, viscosity), so only the molar masses are shared.
 */
export const GASES: Record<AtmosphereGasId, GasProps> = {
  n2: { molarKgPerMol: 0.028014, rayleighRel: 1.027 },
  o2: { molarKgPerMol: 0.031999, rayleighRel: 0.907 },
  co2: { molarKgPerMol: 0.04401, rayleighRel: 2.57 },
  ar: { molarKgPerMol: 0.039948, rayleighRel: 0.883 },
  ch4: {
    molarKgPerMol: 0.016043,
    rayleighRel: 2.2,
    absorption: [9.0e-4, 1.5e-4, 5.0e-6],
  },
  h2: { molarKgPerMol: 0.002016, rayleighRel: 0.199 },
  he: { molarKgPerMol: 0.004003, rayleighRel: 0.0137 },
  h2o: { molarKgPerMol: 0.018015, rayleighRel: 0.7 },
  so2: { molarKgPerMol: 0.064066, rayleighRel: 5.5 },
};

// ── Derivation ─────────────────────────────────────────────────────────

/**
 * Derive renderer AtmosphereParams from a body's physical description
 * (CelestialBodyDef.atmosphere + massKg) and its star (position → distance,
 * luminositySun → illuminance). Throws if the body lacks the required fields —
 * fail fast at module load, not silently airless.
 *
 * `tweaks` is the art-direction escape hatch: a partial AtmosphereParams
 * merged LAST over the derived values (used e.g. to pin Earth's illuminance).
 */
export function deriveAtmosphere(
  body: CelestialBodyDef,
  star: CelestialBodyDef,
  tweaks?: Partial<AtmosphereParams>,
): AtmosphereParams {
  const atm = body.atmosphere;
  if (!atm) throw new Error(`[atmosphere] body "${body.id}" has no atmosphere def`);
  if (body.massKg == null)
    throw new Error(`[atmosphere] body "${body.id}" needs massKg to derive an atmosphere`);

  // Normalised composition + mixture aggregates.
  const entries = Object.entries(atm.composition) as [AtmosphereGasId, number][];
  const sumX = entries.reduce((s, [, x]) => s + x, 0);
  if (!(sumX > 0))
    throw new Error(`[atmosphere] body "${body.id}" has an empty gas composition`);
  let molarKgPerMol = 0;
  let rayleighRel = 0;
  const gasAbs: Vec3Tuple = [0, 0, 0];
  let xO2 = 0;
  for (const [id, x] of entries) {
    const gas = GASES[id];
    if (!gas) throw new Error(`[atmosphere] unknown gas "${id}" on body "${body.id}"`);
    const xn = x / sumX;
    molarKgPerMol += xn * gas.molarKgPerMol;
    rayleighRel += xn * gas.rayleighRel;
    if (gas.absorption) {
      gasAbs[0] += xn * gas.absorption[0];
      gasAbs[1] += xn * gas.absorption[1];
      gasAbs[2] += xn * gas.absorption[2];
    }
    if (id === "o2") xO2 = xn;
  }

  // ── EFFECTIVE gravity at the 1-bar equator, not GM/r_mean² (D36) ──────────
  //
  // 🔑🔑 `GM/r_mean²` OVERSTATES THE GRAVITY THAT SETS A SCALE HEIGHT on any oblate,
  // fast-rotating body, and the error is large: Saturn's H came out 44.15 km against a
  // published 59.5 (0.74×) and Jupiter's 22.30 against 27.0 (0.83×). Both are the
  // "atmosphere looks far too thin" report. MEASURED after this fix: **0.94× on both**,
  // Venus 0.945, Mars 0.925, Uranus 0.964, Neptune 0.992, Earth pinned exactly — nothing
  // regressed. The residual few percent is the isothermal approximation, which is
  // precisely what COLUMN_TEMP_FACTOR absorbs.
  //
  // Two corrections, both needed:
  //   1. OBLATENESS — the 1-bar level sits further out at the equator, so
  //      `R_eq = r_mean/(1−f)^(1/3)` (from `r_mean = (R_eq²·R_pol)^(1/3)`).
  //      ⚠ This RECOVERS the published equatorial radii exactly (Jupiter 71492,
  //      Saturn 60268, Earth 6378), which doubles as a check that `flattening` and
  //      `radiusKm` came from the same source.
  //   2. CENTRIFUGAL — Saturn turns in 10.66 h, and `ω²R_eq` removes 1.6 m/s² there.
  //      Ignoring it is over half of Saturn's error on its own.
  //
  // ⚠ Bodies without `flattening`/`rotation` fall back to the sphere, so an airless or
  // newly-added body behaves exactly as before.
  const flattening = body.flattening ?? 0;
  const radiusM =
    (body.radiusKm * 1000) / Math.cbrt(Math.max(1e-6, 1 - flattening));
  const rot = body.rotation;
  // ⚠ Both spellings are live in the data: most bodies author `spinDegPerDay` (IAU Ẇ)
  // while Venus authors a negative `periodHours`. `abs` because retrograde spin still
  // throws mass outward.
  const spinRadPerSec = rot
    ? rot.spinDegPerDay !== undefined
      ? (Math.abs(rot.spinDegPerDay) * Math.PI) / 180 / 86400
      : rot.periodHours
        ? (2 * Math.PI) / Math.abs(rot.periodHours * 3600)
        : 0
    : 0;
  const gravity = Math.max(
    1e-6,
    (G_GRAV * body.massKg) / (radiusM * radiusM) -
      spinRadPerSec * spinRadPerSec * radiusM,
  );
  const scaleHeightKm =
    (COLUMN_TEMP_FACTOR * R_GAS * atm.surfaceTemperatureK) /
    (molarKgPerMol * gravity) /
    1000;

  // Surface number density relative to Earth air (ideal gas: n = P/kT).
  const nRel =
    (atm.surfacePressureBar / EARTH_PRESSURE_BAR) *
    (EARTH_TEMPERATURE_K / atm.surfaceTemperatureK);

  const rayleighScattering: Vec3Tuple = [
    RAYLEIGH_EARTH[0] * nRel * rayleighRel,
    RAYLEIGH_EARTH[1] * nRel * rayleighRel,
    RAYLEIGH_EARTH[2] * nRel * rayleighRel,
  ];
  // ⚠ `gasAbsorptionScale` defaults to 1, so every body reproduces the shared value
  // exactly until one opts out. See its note in systemTypes.ts for why the shared
  // constant cannot be tuned before the reflecting level is right.
  const gScaleIn = atm.gasAbsorptionScale ?? 1;
  const gScale: Vec3Tuple =
    typeof gScaleIn === "number" ? [gScaleIn, gScaleIn, gScaleIn] : gScaleIn;
  const gasAbsorption: Vec3Tuple = [
    gasAbs[0] * nRel * gScale[0],
    gasAbs[1] * nRel * gScale[1],
    gasAbs[2] * nRel * gScale[2],
  ];

  // Ozone proxy: photochemical O3 needs free O2, so scale Earth's layer by the
  // O2 fraction; trace O2 (<0.5%) → none. Layer altitude tracks the scale
  // height (it lives at a pressure level, not a fixed km).
  const hRatio = scaleHeightKm / RAYLEIGH_SCALE_HEIGHT_EARTH_KM;
  const hasOzone = xO2 >= 0.005;
  const ozoneScale = hasOzone ? xO2 / OZONE_O2_REF : 0;
  const ozoneAbsorption: Vec3Tuple = [
    OZONE_EARTH[0] * ozoneScale,
    OZONE_EARTH[1] * ozoneScale,
    OZONE_EARTH[2] * ozoneScale,
  ];

  // Aerosols (art-directed): Earth clear-sky baseline × haze load × tints.
  const haze = atm.haze ?? 1;
  const tintS = atm.hazeTint ?? [1, 1, 1];
  const tintA = atm.hazeAbsorptionTint ?? [1, 1, 1];
  const mieScattering: Vec3Tuple = [
    MIE_SCATTER_EARTH * haze * tintS[0],
    MIE_SCATTER_EARTH * haze * tintS[1],
    MIE_SCATTER_EARTH * haze * tintS[2],
  ];
  const mieAbsorption: Vec3Tuple = [
    MIE_ABSORB_EARTH * haze * tintA[0],
    MIE_ABSORB_EARTH * haze * tintA[1],
    MIE_ABSORB_EARTH * haze * tintA[2],
  ];

  // NOTE: sun illuminance is NOT derived here any more. It depends on the body's
  // LIVE distance to its star, so it is computed per frame in
  // `setAtmosphereBody()` via `sunIlluminanceAt()` (space/photometry.ts). Only
  // the star's luminosity — genuinely static — is carried through.
  // See docs/LIGHTING_PLAN.md §3.0 (defect D17).

  // Scalar g broadcasts to all channels; a tuple gives wavelength-dependent
  // forward peaking (Mars' blue sunset glow).
  const gIn = atm.mieG ?? 0.8;
  const mieG: Vec3Tuple = typeof gIn === "number" ? [gIn, gIn, gIn] : gIn;

  return {
    groundRadiusKm: body.radiusKm,
    atmosphereHeightKm: TOP_SCALE_HEIGHTS * scaleHeightKm,
    rayleighScattering,
    rayleighScaleHeightKm: scaleHeightKm,
    // D28: refractivity is LINEAR in number density, while Rayleigh scattering
    // goes as (n−1)². `rayleighRel` is defined as ((n−1)_g/(n−1)_air)²·(F_g/F_air)
    // (see its comment above), so √rayleighRel recovers the per-molecule
    // refractivity ratio and `nRel` carries the density. ⚠ Strictly, mixture
    // refractivity is Σxᵢ(n−1)ᵢ while √(Σxᵢ(n−1)ᵢ²) is what this gives — they
    // differ only for mixtures of very dissimilar gases, and for Earth air
    // (rayleighRel ≈ 1.0) it is exact. Good to ~1% everywhere it matters.
    surfaceRefractivity:
      REFRACTIVITY_AIR_REF * nRel * Math.sqrt(Math.max(rayleighRel, 0)),
    mieScattering,
    mieAbsorption,
    mieScaleHeightKm:
      atm.hazeScaleHeightKm ??
      (MIE_SCALE_HEIGHT_EARTH_KM / RAYLEIGH_SCALE_HEIGHT_EARTH_KM) * scaleHeightKm,
    mieG,
    ozoneAbsorption,
    ozoneCenterKm: hasOzone ? OZONE_CENTER_EARTH_KM * hRatio : 0,
    ozoneWidthKm: hasOzone ? OZONE_WIDTH_EARTH_KM * hRatio : 0,
    gasAbsorption,
    groundAlbedo: atm.groundAlbedo ?? [0.3, 0.3, 0.3],
    starLuminositySun: star.luminositySun ?? 1,
    ...tweaks,
  };
}

/**
 * Body→star distance in km, from the authored positions.
 *
 * ⚠ Only for INITIALISING uniforms so nothing flashes on frame 0. Runtime code
 * must NOT use this — it
 * reads the authored (static) position, which is precisely what breaks once
 * bodies orbit. Live distance comes from `CelestialBody`'s per-frame update.
 */
function authoredStarDistanceKm(body: CelestialBodyDef, star: CelestialBodyDef): number {
  const dx = body.positionKm[0] - star.positionKm[0];
  const dy = body.positionKm[1] - star.positionKm[1];
  const dz = body.positionKm[2] - star.positionKm[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ── Sol-system presets (derived from sol.json descriptions) ─────────────

const bodies = activeSystem().celestialBodies as CelestialBodyDef[];

function findBody(id: string): CelestialBodyDef {
  const body = bodies.find((b) => b.id === id);
  if (!body) throw new Error(`[atmosphereData] body "${id}" not found in sol.json`);
  return body;
}

const sol = findBody("sol");

// Earth reproduces Hillaire Table 1 from its physical description (scale
// height 8.000 km, Rayleigh +0.1%, ozone/Mie exact).
//
// ✅ THE ILLUMINANCE PIN IS GONE (lighting Phase 2). Earth's sky was hand-tuned
// against sunIlluminance = 20 while its authored orbit (0.9716 AU) derives
// 22.458 — a 12% discrepancy that existed only because the tuning had no
// physical anchor. Now that surfaces carry sunIlluminance/π and the whole frame
// shares one documented scale (1 game unit ≈ 6,038 cd/m²), the derived value IS
// the right value and the pin would be a lie.
const earthBody = findBody("earth");
export const EARTH_ATMOSPHERE: AtmosphereParams = deriveAtmosphere(earthBody, sol);

/**
 * Earth's sun illuminance at its AUTHORED position, in game units.
 *
 * Only for INITIALISING uniforms so nothing flashes on frame 0. The live value
 * is on the AtmosphereBodyRecord and is what actually drives rendering — do not
 * use this constant in a shader or a per-frame path.
 */
export const EARTH_SUN_ILLUMINANCE_AUTHORED = sunIlluminanceAt(
  authoredStarDistanceKm(earthBody, sol),
  sol.luminositySun ?? 1,
);

// Venus: 92 bar CO2 → Rayleigh ~90× Earth (the sky is optically deep; the
// transmittance LUT goes ~0 well above the surface, as it should), plus the
// H2SO4 cloud shroud as a tall bright Mie deck.
//
// ✅ THE 0.025 ILLUMINANCE TRIM IS GONE (lighting Phase 2), together with the
// missing surface irradiance factor it was compensating for — the SAME COMMIT,
// which was mandatory (docs/LIGHTING_PLAN.md §4.1, the cancellation trap).
//
// The history, because it is the most instructive bug in this system: the trim
// was added on the belief that Venus' disc rendered ~40× too bright. Measuring it
// showed the opposite — a JS replica of this very march puts the disc at
// L = [11.1, 12.6, 13.3] game units against a Lambertian-equivalent 8.92 at
// Venus' real geometric albedo 0.69, so the trim was UNDER-rendering Venus ~32×.
// It only looked right because every planet surface was simultaneously missing
// sunIlluminance/π (6.37× at Earth's orbit). Two errors partially cancelling.
//
// ⚠ THE CANCELLATION WAS PARTIAL AND BODY-DEPENDENT, so this pair of changes is
// NOT expected to be self-balancing: measured pre-change, Venus' disc sat 16.5×
// above its own trimmed p·E/π and Neptune's 12.9× above its (untrimmed) one, i.e.
// most of Venus' brightness arrived through the albedo-scale path rather than
// through illuminance. Re-measure with `__lum.compare("venus")` and
// `__lum.compare("neptune")` — do not assume.
//
// Residual +18…+21% from Hillaire's Ψ/(1−F_ms) approximation IS real (validated
// against a Monte Carlo in §2.2) but is the paper's own documented hue-drift
// limit at high scattering coefficients, not a bug here. Accepted; not a knob.
export const VENUS_ATMOSPHERE: AtmosphereParams = deriveAtmosphere(
  findBody("venus"),
  sol,
);

// Mars: 6 mbar CO2 → feeble Rayleigh; the look is the DUST — red-scattering,
// blue-absorbing Mie mixed high (butterscotch day sky, bluish sunsets).
export const MARS_ATMOSPHERE: AtmosphereParams = deriveAtmosphere(
  findBody("mars"),
  sol,
);

// Gas giants: radiusKm is the 1-bar level by convention, so the "surface" is
// the visible cloud deck. H2/He columns scatter weakly per molecule but run
// deep (tens of km scale heights); CH4 red absorption sets the ice-giant hue.
export const JUPITER_ATMOSPHERE: AtmosphereParams = deriveAtmosphere(
  findBody("jupiter"),
  sol,
);
export const SATURN_ATMOSPHERE: AtmosphereParams = deriveAtmosphere(
  findBody("saturn"),
  sol,
);
export const URANUS_ATMOSPHERE: AtmosphereParams = deriveAtmosphere(
  findBody("uranus"),
  sol,
);
export const NEPTUNE_ATMOSPHERE: AtmosphereParams = deriveAtmosphere(
  findBody("neptune"),
  sol,
);
