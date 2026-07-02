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

import solSystem from "@/sim/systems/sol.json";
import type { AtmosphereGasId, CelestialBodyDef } from "@/sim/systemTypes";
import type { AtmosphereParams, Vec3Tuple } from "../types";

// Unified linear-luminance working space (see ATMOSPHERE_PLAN.md §6).
// The whole scaled scene (sun illuminance, atmosphere in-scatter, surface
// lighting) shares this scale; a single EXPOSURE multiply is applied before
// tonemapping. Calibrated in Phase 1 against a noon Earth view — for now it is
// an identity placeholder so Phase 0 is a strict no-op.
export const ATMOSPHERE_EXPOSURE = 1.0;

// ── Physical constants ─────────────────────────────────────────────────
const R_GAS = 8.314462; // universal gas constant, J/(mol·K)
const G_GRAV = 6.674e-11; // gravitational constant, m³/(kg·s²)
const AU_KM = 1.495979e8;

// ── Earth anchors (Hillaire 2020, Table 1) ─────────────────────────────
// The derivation is a set of physical RATIOS against these. Earth sea-level
// air at 1.01325 bar / 288 K scatters RAYLEIGH_EARTH (the table is pure λ⁻⁴:
// 13.558·(550/680)⁴ = 5.803, ·(550/440)⁴ = 33.10 — so one 550 nm magnitude +
// λ⁻⁴ covers the spectrum, and other gases only scale the magnitude).
const EARTH_PRESSURE_BAR = 1.01325;
const EARTH_TEMPERATURE_K = 288;
const RAYLEIGH_EARTH: Vec3Tuple = [5.802e-6, 13.558e-6, 33.1e-6];
const RAYLEIGH_SCALE_HEIGHT_EARTH_KM = 8.0;
const MIE_SCATTER_EARTH = 3.996e-6; // clear-sky aerosol baseline (haze = 1)
const MIE_ABSORB_EARTH = 4.4e-6;
const MIE_SCALE_HEIGHT_EARTH_KM = 1.2;
const OZONE_EARTH: Vec3Tuple = [0.65e-6, 1.881e-6, 0.085e-6];
const OZONE_O2_REF = 0.209; // Earth's O2 mole fraction → OZONE_EARTH
const OZONE_CENTER_EARTH_KM = 25;
const OZONE_WIDTH_EARTH_KM = 30;
// Ideal-gas H = RT/(Mg) uses the SURFACE temperature, but the column cools
// with altitude; this effective-column factor calibrates Earth (288 K,
// 28.96 g/mol, 9.82 m/s²) to exactly Hillaire's 8.0 km density scale height.
const COLUMN_TEMP_FACTOR = 0.9502;
// Atmosphere top = this many Rayleigh scale heights (density ~e⁻¹²·⁵ ≈ 4e-6
// of surface — visually nothing above). Earth: 12.5 × 8 km = the canonical 100.
const TOP_SCALE_HEIGHTS = 12.5;
// Game-luminance units received at 1 AU from a 1 L☉ star (the §6 unified
// scale; Phase 1 tuned Earth's sky against sunIlluminance = 21.2).
const SUN_ILLUM_GAME_1AU = 21.2;

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
type GasProps = {
  molarKgPerMol: number;
  rayleighRel: number;
  absorption?: Vec3Tuple;
};

const GASES: Record<AtmosphereGasId, GasProps> = {
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

  // Surface gravity + density scale height H = RT/(Mg) (× column calibration).
  const radiusM = body.radiusKm * 1000;
  const gravity = (G_GRAV * body.massKg) / (radiusM * radiusM);
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
  const gasAbsorption: Vec3Tuple = [
    gasAbs[0] * nRel,
    gasAbs[1] * nRel,
    gasAbs[2] * nRel,
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

  // Top-of-atmosphere illuminance from the star's luminosity + actual distance.
  const dx = body.positionKm[0] - star.positionKm[0];
  const dy = body.positionKm[1] - star.positionKm[1];
  const dz = body.positionKm[2] - star.positionKm[2];
  const dAU = Math.sqrt(dx * dx + dy * dy + dz * dz) / AU_KM;
  const illum =
    (SUN_ILLUM_GAME_1AU * (star.luminositySun ?? 1)) / Math.max(1e-6, dAU * dAU);

  // Scalar g broadcasts to all channels; a tuple gives wavelength-dependent
  // forward peaking (Mars' blue sunset glow).
  const gIn = atm.mieG ?? 0.8;
  const mieG: Vec3Tuple = typeof gIn === "number" ? [gIn, gIn, gIn] : gIn;

  return {
    groundRadiusKm: body.radiusKm,
    atmosphereHeightKm: TOP_SCALE_HEIGHTS * scaleHeightKm,
    rayleighScattering,
    rayleighScaleHeightKm: scaleHeightKm,
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
    sunIlluminance: [illum, illum, illum],
    ...tweaks,
  };
}

// ── Sol-system presets (derived from sol.json descriptions) ─────────────

const bodies = solSystem.celestialBodies as CelestialBodyDef[];

function findBody(id: string): CelestialBodyDef {
  const body = bodies.find((b) => b.id === id);
  if (!body) throw new Error(`[atmosphereData] body "${id}" not found in sol.json`);
  return body;
}

const sol = findBody("sol");

// Earth reproduces Hillaire Table 1 from its physical description (scale
// height 8.000 km, Rayleigh +0.1%, ozone/Mie exact). Only the illuminance is
// pinned: the game's Earth orbits at 0.972 AU (system-authoring quirk), which
// would derive 21.2 and brighten the Phase-1-tuned look by 6%.
export const EARTH_ATMOSPHERE: AtmosphereParams = deriveAtmosphere(
  findBody("earth"),
  sol,
  { sunIlluminance: [20, 20, 20] },
);

// Venus: 92 bar CO2 → Rayleigh ~90× Earth (the sky is optically deep; the
// transmittance LUT goes ~0 well above the surface, as it should), plus the
// H2SO4 cloud shroud as a tall bright Mie deck.
//
// ILLUMINANCE TRIM (§6 exposure bridge, on-device finding 2026-07-02): with the
// full derived illuminance (~40 — Venus sits at 0.72 AU) the disc renders BLOWN
// WHITE from orbit until touching the surface. Physically Venus IS the
// brightest planet, but the game's surfaces shade on a ~[0,1] albedo scale
// while atmosphere in-scatter lives on the sunIlluminance scale — an optically-
// DEEP atmosphere (vertical Rayleigh OD ≈ 18: the disc "surface" is pure
// in-scatter) therefore reads ~30-40 game units vs ~1-5 for everything else,
// far past the tonemap shoulder. (Hillaire's Ψ/(1−F_ms) multi-scatter
// approximation also overshoots on near-conservative deep atmospheres,
// compounding it.) Until the §6 unified-exposure pass lands, trim Venus'
// illuminance to keep the disc in the scene's luminance range — ONE knob,
// raise/lower to taste.
const VENUS_ILLUM_TRIM = 0.025;
const venusDerived = deriveAtmosphere(findBody("venus"), sol);
export const VENUS_ATMOSPHERE: AtmosphereParams = {
  ...venusDerived,
  sunIlluminance: [
    venusDerived.sunIlluminance[0] * VENUS_ILLUM_TRIM,
    venusDerived.sunIlluminance[1] * VENUS_ILLUM_TRIM,
    venusDerived.sunIlluminance[2] * VENUS_ILLUM_TRIM,
  ],
};

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
