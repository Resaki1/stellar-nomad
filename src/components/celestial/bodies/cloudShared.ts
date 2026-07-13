import {
  float,
  smoothstep,
  mix,
  clamp,
  texture,
  vec2,
  int,
  floor,
  fract,
} from "three/tsl";
import { getCloudProfileLUT } from "./cloudProfileLUT";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

// =============================================================================
// Shared cloud-shape derivation chain (CLOUD_TYPES_PLAN.md Phase 0).
//
// SINGLE SOURCE OF TRUTH for the coverage → cloudType → topAlt → vertical-
// profile relationship, consumed by ALL THREE former copies:
//   • the volumetric marcher's dense branch      (earthClouds.ts)
//   • the far-field cloud shell's macro model     (earthClouds.ts)
//   • the baked light volume's densityAt          (cloudLightVolume.ts)
// Before this module each had a hand-kept copy; drift between them detached
// baked shadows from the clouds that cast them (lockstep hazard #1 in
// docs/CLOUD_REVIEW_2026-07.md). This is the cloudDetile.ts pattern
// generalized — a plain TSL-only module both `celestial/bodies` and `space`
// import, with no back-edge into the marcher (no import cycle).
//
// Phase 2 (CLOUD_TYPES_PLAN.md §4.2) replaces `cloudHeightProfile` here with a
// baked (altNorm × convectivity) profile LUT — doing it in ONE place is the
// whole point of this consolidation.
// =============================================================================

// ── Weather Map v2 master toggle (CLOUD_TYPES_PLAN.md Phase 1) ───────────────
// Build const — flip + reload (no runtime re-bake needed: a page reload rebuilds
// the node graph and re-runs the light-volume bake fresh). OFF = legacy
// coverage-derived cloudType + colSample-derived topAlt (unchanged). ON = drive
// cloudType from the map's G (convectivity), topAlt from B (topHeight), consume
// LINEAR coverage (drop the pow(0.6) lift — it existed only for the old K<1
// erosion; the adopted Nubis-form K=1 doesn't need it, §3.6 H2), and DELETE the
// per-step 3D column tap (topHeight now comes from the map → −1 texture3D/step).
// ALL consumers branch on this in lockstep (marcher dense branch + far shell +
// light-volume bake) or near/far/shadow topAlt diverge. Input = the synthetic
// getSyntheticWeatherMapV2() (weatherMapV2.ts); the real ERA5 bake is Phase 4.
export const WEATHER_V2 = true;

// ── Phase 4 (§4.7): real ERA5 weather map ────────────────────────────────────
// Build const — flip + reload once the bake exists (scripts/bake_weather_map.py
// → convert-to-ktx2.sh --linear → this path). Lives HERE (the leaf module) so
// earthClouds (loader swap), earth.ts (tier records), and fractionPlacement
// below can all read it without an import cycle. The REAL map's R channel
// carries BAKED placement (the baker thresholds the ERA5 area fraction by a
// synthesized ~8-16 km Worley field at 8192×4096 ≈ 5 km/texel — the Blue
// Marble regime, so the far shell + orbit view get real mippable structure);
// the SYNTHETIC map's R is a smooth fraction and gets placement at RUNTIME.
export const REAL_WEATHER_MAP = true;
export const REAL_WEATHER_MAP_PATH = "/textures/weather/era5_2005082818.ktx2";

// ── Cloud slab (T2/§4.4: raised 14→16 km so Cb turrets + anvils have
// headroom ABOVE the ordinary deck ceiling; ~+15% in-band march cost, §4.10
// budgeted). SINGLE SOURCE: earthClouds (marcher + shell sphere + uniforms)
// and earth.ts (shell fade) import these — the old hand-mirrored
// CLOUD_TOP_ALTITUDE_KM copy is gone structurally. The light-volume bake gets
// the slab via the marcher's radius uniforms (nothing to mirror).
export const CLOUD_INNER_ALTITUDE_KM = 1;
export const CLOUD_OUTER_ALTITUDE_KM = 16;
const SLAB_SPAN_KM = CLOUD_OUTER_ALTITUDE_KM - CLOUD_INNER_ALTITUDE_KM; // 15

// Map the v2 topHeight channel into the cloud-TOP altitude parameter topN.
// KM-ANCHORED (T2): ordinary columns span the same PHYSICAL 2.3–13.35 km
// they had in the 14 km slab — the 2 km raise is reserved as turret/anvil
// headroom (TOPALT_CEIL 0.95 = 15.25 km, ~1.9 km above the ordinary
// ceiling), NOT a stretch of every deck. LINEAR (anti-bimodal rule, §3.6 H4).
// NOTE: the LEGACY analytic cloudHeightProfile (PROFILE_LUT off) was authored
// for topAlt∈[0.45,0.95] — off-spec below that; the LUT path is unaffected.
const TOP_KM_MIN = 2.3;
const TOP_KM_MAX = 13.35;
const TOPALT_FLOOR = (TOP_KM_MIN - CLOUD_INNER_ALTITUDE_KM) / SLAB_SPAN_KM; // ≈0.087
const TOPALT_ORDINARY_CEIL =
  (TOP_KM_MAX - CLOUD_INNER_ALTITUDE_KM) / SLAB_SPAN_KM; // ≈0.823
const TOPALT_CEIL = 0.95; // 15.25 km — turret/anvil headroom only
export function topHeightToTopAlt(topHeight01: Node): Node {
  return mix(
    float(TOPALT_FLOOR),
    float(TOPALT_ORDINARY_CEIL),
    clamp(topHeight01, 0, 1),
  );
}

// ── Per-cell tower-height jitter (§3.6 H4, second half) ─────────────────────
// The map's topHeight is a SMOOTH hundreds-of-km field with zero local
// variance → two visible artifacts (user-confirmed 2026-07-08): every cloud in
// a region tops out at ONE altitude (wrong for convective fields — real
// cumulus neighbours differ by km, each cell at its own life-cycle stage), and
// where the field gradients the deck roof follows it as a smooth unnatural
// RAMP (real transitions STEP between levels). Real ERA5 data does NOT fix
// this — closed-deck tops are flat at 28 km/px too ("injected variance is
// mandatory", §4.2 acceptance test: dense-region p10-p90 top spread ≥ 4 km).
//
// Fix: perturb topAlt per ~16 km cell with the mesoscale noise tap the marcher
// ALREADY samples for the coverage lanes (mesoTap.g — the first Worley-FBM
// octave at MESO_SCALE; zero new fetches in the hot path), LINEAR remap
// (anti-bimodal rule), gated by CONVECTIVITY: stratiform stays inversion-flat
// (physically correct), convective gets a varied tower skyline; ramps become
// stepped lines of towers. LOCKSTEP: the marcher and the light-volume bake
// BOTH apply this helper to their topAlt (same field, same formula) or baked
// shadows detach from the tower tops. The far shell is unaffected (its LUT
// peak scan is span-independent).
export const TOPALT_JITTER = true;
// baseVolume tile at this scale = 62.5 km → ~16 km R-channel cells (the
// coverage lanes) and ~8 km G-channel cells (the tower jitter). NOTE this one
// constant sets BOTH: user-tuned 8→16 (2026-07-08) for per-cloud-body jitter;
// the lanes halved with it (31→16 km) as a side effect. Shared so the
// marcher's mask/jitter and the bake's jitter sample the IDENTICAL field.
export const MESO_SCALE = 16;

// ── Fraction→placement (Phase 4 follow-up, 2026-07-11) ──────────────────────
// ERA5 gives cloud AREA FRACTION per ~28 km cell, not cloud PLACEMENT: a cell
// of scattered cumulus arrives as a uniform 0.55 and rendered directly it
// becomes a translucent smeared deck (the user's "washed out, big chunks"
// verdict on the first real bake; the old Blue Marble looked right because a
// PHOTO carries real placement). Standard fix: use the fraction as the
// THRESHOLD of a placement noise — the same mesoTap.g updraft field that
// drives jitter/turrets (one fetch, four consumers; physically coherent:
// strong updraft = cloud present AND taller AND turret candidate). Cells with
// G above the threshold become REAL clouds with REAL gaps; the local area
// mean matches the map fraction because the threshold line is calibrated to
// G's MEASURED quantiles (Monte-Carlo 2026-07-08: p10 0.316, p50 0.472,
// p90 0.634 — near-linear: Q(p) ≈ 0.475 + 0.4·(p − 0.5)):
//   thr(cov) = 0.675 − 0.4·cov   →   P(G > thr) ≈ cov            [area ✓]
// This ALSO dissolves the bilinear grid blockiness: cloud edges become
// iso-contours of the smooth 3D noise instead of texel edges. LOCKSTEP: the
// light-volume bake applies the identical helper (else shadows land on the
// un-placed fraction soup). The far shell keeps RAW fraction — placement is
// mean-preserving, and its ~8 km cells are sub-pixel at shell distances.
// The v2 synthetic map keeps its own lane mask semantics OFF this path
// (placement replaces the lane multiply under WEATHER_V2).
export const FRACTION_PLACEMENT = true;
// Soft edge half-width of the placement threshold (bigger = fluffier cloud
// edges, smaller = harder binary placement).
const PLACEMENT_EDGE = 0.1;
// Kill-switch below tiny fractions: thr(0) = 0.675 still leaves ~4% of G
// above it — without this, clear-sky regions would grow ghost clouds.
const PLACEMENT_MIN_COV_LO = 0.03;
const PLACEMENT_MIN_COV_HI = 0.12;

export function fractionPlacement(mapCov: Node, mesoG: Node): Node {
  // The REAL map carries BAKED placement (the baker applies this same
  // calibrated threshold at 8k against a synthesized placement field — see
  // scripts/bake_weather_map.py, kept in lockstep with these constants);
  // re-thresholding placed coverage would double-erode every cloud edge.
  // Runtime placement exists for the SYNTHETIC map, whose R is a smooth
  // fraction field.
  if (!FRACTION_PLACEMENT || REAL_WEATHER_MAP) return mapCov;
  const cov = clamp(mapCov, 0, 1);
  const thr = float(0.675).sub(cov.mul(0.4));
  return smoothstep(
    thr.sub(float(PLACEMENT_EDGE)),
    thr.add(float(PLACEMENT_EDGE)),
    mesoG,
  ).mul(
    smoothstep(float(PLACEMENT_MIN_COV_LO), float(PLACEMENT_MIN_COV_HI), cov),
  );
}
// ±AMOUNT/2 × gate in alt01 units at the G channel's extremes (user-tuned
// 0.5→0.8): up to ±4-5 km cell-to-cell in fully convective regions, ×FLOOR of
// that in pure stratiform.
const TOPALT_JITTER_AMOUNT = 0.8;
// (A round-2 "stratiform floor + topAlt terracing" attempt at the smooth-ramp
// artifact was REVERTED 2026-07-08: quantizing topAlt gave flat decks hard
// unnatural edges everywhere — worse than the ramp it fixed. The ramp only
// appears where the SYNTHETIC map has unnaturally steep topHeight transitions;
// real ERA5 gradients (Phase 4) shouldn't produce it. Re-check after the real
// bake; if it persists there, revisit with a gentler mechanism.)

export function jitterTopAlt(
  topAlt: Node,
  mesoG: Node,
  convectivity: Node,
): Node {
  if (!TOPALT_JITTER) return topAlt;
  return topAlt
    .add(
      mesoG
        .sub(0.5)
        .mul(float(TOPALT_JITTER_AMOUNT))
        .mul(clamp(convectivity, 0, 1)),
    )
    .clamp(TOPALT_FLOOR, TOPALT_CEIL); // strong upward jitter may enter headroom
}

// ── T1 Convective turret field (§4.11) ──────────────────────────────────────
// Sparse, narrow, FULL columns rising above the convective deck — the tower
// skyline of the KSP/Blackrack + Star Citizen references. A turret is the
// extreme tail of the SAME updraft field (mesoTap.g) that drives the topAlt
// jitter: jitter = per-cell life-cycle variance, turret = the strongest
// updrafts. Three coupled effects, one mask:
//   rise      — topAlt += T·TURRET_RISE (a tower is taller than its field)
//   fullness  — coverage = max(coverage, T·0.9). THE load-bearing part
//               (Nubis 2015: Cb is FORCED at ≥70% coverage; Blackrack: Cb core
//               density 2.5-6× boost): without it, raising topAlt just makes a
//               taller broken blob. With it the erosion cannot hollow the core
//               → a filled column whose silhouette is the profile envelope.
//   solid core — erosion K × (1 − T·0.4): boiling solid core, fully-carved
//               cauliflower flanks where T fades (case #13: gate + opacity
//               erosion must BOTH read the softened K).
// Footprint = the peak of the updraft cell above TURRET_LO ≈ 2-4 km wide vs
// 5-11 km tall → taller than wide (congestus/Cb proportions, τ 50-300 ≈ the
// opaque core). DELIBERATE sparse mask (a skyline IS a positive tail) — not
// the accidental §3.6-H4 bimodality trap. LOCKSTEP: marcher and light-volume
// bake apply the same helpers (probes inherit the step locals); far shell =
// accepted sub-texel divergence (turrets are ~3% of cells).
export const TURRETS = true;
// Thresholds MEASURED against the baked G-channel distribution (Monte-Carlo
// N=200k, 2026-07-08: mean 0.473, p90 0.634, P(G>0.60)=15.7%, P(G>0.70)=3.1%):
// cells enter turret in the top ~16% of the updraft field, FULL turret in the
// top ~3%. (The §4.11 draft guessed 0.72/0.9 — measured: 2% / never. Guessing
// thresholds on an unmeasured noise distribution strikes again.)
const TURRET_LO = 0.6;
const TURRET_HI = 0.9;
// Convectivity gate: turrets only in genuinely convective regions.
const TURRET_CONV_LO = 0.55;
const TURRET_CONV_HI = 0.8;
const TURRET_RISE = 0.3; // alt01 (+~4 km at full T); ceiling-clamped until §4.4 slab raise
const TURRET_COVERAGE = 0.9;
const TURRET_K_SOFTEN = 0.3;

export function turretMask(mesoG: Node, convectivity: Node): Node {
  return smoothstep(float(TURRET_LO), float(TURRET_HI), mesoG).mul(
    smoothstep(
      float(TURRET_CONV_LO),
      float(TURRET_CONV_HI),
      clamp(convectivity, 0, 1),
    ),
  );
}
export function turretErosionScale(turretT: Node): Node {
  return float(1).sub(turretT.mul(float(TURRET_K_SOFTEN)));
}

// ── Soft ceiling knee (mesa fix, 2026-07-09) ────────────────────────────────
// Jitter + turret rise pushed MANY adjacent cells onto the hard TOPALT_CEIL
// clamp → they all shared exactly one top = flat mesa plateaus (the §3.6-H4
// ceiling pile re-created at 0.95; user screenshot). Instead of clamping,
// COMPRESS the headroom: above the ordinary ceiling the slope drops to
// TOPALT_KNEE_SLOPE, so a pile spanning [0.823, 1.25] spreads into distinct
// tops over [0.823, ~0.95] — varied summits, the hard clamp almost never
// exactly hit. Applied ONCE at the end of the topAlt chain (deriveColumnV2).
const TOPALT_KNEE_SLOPE = 0.3;
function finalizeTopAlt(topAlt: Node): Node {
  const excess = topAlt.sub(float(TOPALT_ORDINARY_CEIL)).max(0);
  return topAlt
    .min(float(TOPALT_ORDINARY_CEIL))
    .add(excess.mul(float(TOPALT_KNEE_SLOPE)))
    .clamp(TOPALT_FLOOR, TOPALT_CEIL);
}

// ── T2 Anvil (§4.4/§4.11): skirt-as-stratiform-sheet (REDESIGNED 2026-07-09) ─
// A mature Cb glaciates and spreads at its top — the flat overhanging shield
// of the KSP/Blackrack + Star Citizen references.
//
// WHY THE FIRST MECHANISM (Nubis 2017 coverage-pow) FAILED HERE — two causes,
// both user-diagnosed in-app ("no anvil shapes anywhere"):
//  1. GATE COLLAPSE (measured): bias = T × ss(0.75,1,conv) × topWindow. The
//     synthetic map's convectivity p90 ≈ 0.71 → the middle gate ≈ 0 nearly
//     everywhere; with TURRET_HI=0.9 T itself rarely tops 0.3 → bias ≤ ~0.1
//     → pow(coverage, ~0.95) — invisible at any tuning.
//  2. STRUCTURAL: pow(coverage, e) only acts where heightProfile > 0 — INSIDE
//     columns whose own topAlt reaches the shield band. Neighbouring columns
//     top out km lower; NO coverage exponent can create cloud ABOVE a
//     column's own top. Nubis's anvil worked because their type-profile holds
//     top density across the whole anvil footprint; in our per-column
//     km-anchored model the pow can only fatten the 2-4 km core itself.
//
// THE FIX — build the shield out of the NEIGHBOURING COLUMNS: a wide SKIRT
// mask around the same updraft peak RAISES the skirt columns' tops to the
// core's level, while their PROFILE convectivity is pulled to stratiform →
// km-anchoring (baseN = topN − thickness at conv→0) turns each skirt column
// into a thin sheet hugging the raised top: mass ONLY near the shield level,
// CLEAR AIR below = the overhang. Tower = core column (full from base);
// shield = skirt columns (sheet at top). One continuous morph, no seam:
//   skirt A   — smoothstep(SKIRT_LO, SKIRT_HI, G): wider footprint of the
//               same cell peak the turret core sits in (2-3× core width).
//   gate      — smoothstep(conv) × smoothstep(topKm on the PRE-RISE top):
//               only deep convection with genuinely high tops anvils out.
//               (Pre-rise top: the raised top would be circular.)
//   rise      — riseMask = mix(T, max(T, A), gate): outside anvil regions
//               the rise stays on the narrow core (plain turret); inside, the
//               whole skirt rises to a SHARED level = the flat shield top.
//   sheet     — gate·A·(1−T): skirt-not-core → profileConv → stratiform.
//   coverage  — max(coverage, shield·ANVIL_COVERAGE): the sheet has substance.
//   smoothing — anvilDetailConv (glaciated shield: detail pulled stratiform).
//   erosion   — callers derive K from profileConv (NOT cloudType): the sheet
//               erodes like the smooth stratiform sheet it is, else the
//               region's convective K (user-tuned up to 2.0) moth-eats it.
// LOCKSTEP: everything lives in deriveColumnV2 below — marcher, light-volume
// bake, and the topAlt diagnostics call the SAME function. Far shell =
// accepted divergence (its LUT peak scan is span-independent; anvil regions
// are rare).
export const ANVIL = true;
// Region gates — MEASURED-reachable (map conv p90 ≈ 0.71; the failed draft's
// ss(0.75, 1.0) was ≈ 0 over virtually the whole planet).
const ANVIL_CONV_LO = 0.6;
const ANVIL_CONV_HI = 0.85;
// Cloud-top altitude window (km) on the PRE-RISE (ordinary) column top:
// anvils appear as tops pass ~8 km, fully developed by ~11 km.
const ANVIL_TOP_KM_LO = 8;
const ANVIL_TOP_KM_HI = 11;
// Skirt thresholds on the SAME G channel as the turret (measured: P(G>0.50)
// ≈ 45% partial, P(G>0.62) ≈ 12% full) → shield ~2-3× the core footprint.
const ANVIL_SKIRT_LO = 0.5;
const ANVIL_SKIRT_HI = 0.62;
// The sheet's profile convectivity (stratiform row → thin top-hugging sheet).
const ANVIL_SHEET_CONV = 0.06;
// Shield coverage floor (the sheet must be substantial or the erosion —
// even at stratiform K — shreds the overhang).
const ANVIL_COVERAGE = 0.8;
// The glaciated band: the top ANVIL_BAND_N below the column top, where the
// DETAIL character is pulled toward stratiform (ice, not boiling droplets).
const ANVIL_BAND_N = 0.15;
const ANVIL_DETAIL_SMOOTH = 0.85;

function anvilRegionGate(convectivity: Node, topAltPreRise: Node): Node {
  const topKmLoN =
    (ANVIL_TOP_KM_LO - CLOUD_INNER_ALTITUDE_KM) / SLAB_SPAN_KM; // ≈0.467
  const topKmHiN =
    (ANVIL_TOP_KM_HI - CLOUD_INNER_ALTITUDE_KM) / SLAB_SPAN_KM; // ≈0.667
  return smoothstep(
    float(ANVIL_CONV_LO),
    float(ANVIL_CONV_HI),
    clamp(convectivity, 0, 1),
  ).mul(smoothstep(float(topKmLoN), float(topKmHiN), topAltPreRise));
}
// 0 below the glaciated band → 1 at the column top (keyed on alt01 relative
// to topAlt — altNorm would be circular here, §4.4).
export function anvilBandMask(alt01: Node, topAlt: Node): Node {
  return clamp(
    alt01.sub(topAlt.sub(float(ANVIL_BAND_N))).div(float(ANVIL_BAND_N)),
    0,
    1,
  );
}
export function anvilDetailConv(
  cloudType: Node,
  shield: Node,
  bandMask: Node,
): Node {
  return mix(
    clamp(cloudType, 0, 1),
    float(0.08),
    shield.mul(bandMask).mul(float(ANVIL_DETAIL_SMOOTH)),
  );
}

// ── The unified v2 column derivation (T1+T2) ────────────────────────────────
// ONE definition of the whole topAlt chain + convective masks, called by the
// marcher dense branch, the light-volume bake, AND the topAlt/weatherRaw
// diagnostics — the chain was previously hand-repeated at all three (the
// exact wiring-drift class Phase 0 was built to kill). Returns:
//   topAlt  — jittered + turret/anvil-risen + knee-compressed column top
//   turretT — the narrow core mask (drives fullness + K softening)
//   shield  — gate·skirt (drives shield coverage + glaciated detail)
//   sheet   — shield·(1−T) (drives the profileConv stratiform morph)
export function deriveColumnV2(
  topHeight01: Node,
  mesoG: Node,
  convectivity: Node,
): {
  topAlt: Node;
  turretT: Node;
  shield: Node;
  sheet: Node;
} {
  const conv = clamp(convectivity, 0, 1);
  let topAlt = topHeightToTopAlt(topHeight01);
  topAlt = jitterTopAlt(topAlt, mesoG, conv);
  let turretT: Node = float(0);
  let shield: Node = float(0);
  let sheet: Node = float(0);
  if (TURRETS) {
    turretT = turretMask(mesoG, conv);
    let riseMask: Node = turretT;
    if (ANVIL) {
      const gate = anvilRegionGate(conv, topAlt); // PRE-RISE top (see above)
      const skirt = smoothstep(
        float(ANVIL_SKIRT_LO),
        float(ANVIL_SKIRT_HI),
        mesoG,
      );
      shield = gate.mul(skirt);
      riseMask = mix(turretT, skirt.max(turretT), gate);
      // Core exclusion from G DIRECTLY (not 1−turretT: T's peak depends on
      // the TURRET_HI tuning — with the user's 0.9 it tops at ~0.5, and a
      // 1−T sheet would morph the CORE half-stratiform too → the tower's
      // base lifts to ~7 km and the whole anvil floats, verified in the
      // 2026-07-09 numeric trace). ss(TURRET_LO, +0.1) → the sheet morph
      // dies exactly where the core column begins; the tower keeps its
      // ground-rooted base under the shield.
      const coreness = smoothstep(
        float(TURRET_LO),
        float(TURRET_LO + 0.1),
        mesoG,
      );
      sheet = shield.mul(float(1).sub(coreness));
    }
    topAlt = topAlt.add(riseMask.mul(float(TURRET_RISE)));
  }
  return { topAlt: finalizeTopAlt(topAlt), turretT, shield, sheet };
}

// Convective coverage floor: turret core fullness (T1) + anvil shield
// substance (T2). Replaces the plain turretCoverage.
export function convectiveCoverage(
  coverage: Node,
  turretT: Node,
  shield: Node,
): Node {
  return coverage
    .max(turretT.mul(float(TURRET_COVERAGE)))
    .max(shield.mul(float(ANVIL_COVERAGE)));
}

// The convectivity the PROFILE (and erosion K / density gamma) should read:
// cloudType everywhere except sheet columns, where it morphs to stratiform —
// the km-anchoring then places a thin sheet at the raised top (the shield).
export function anvilProfileConv(cloudType: Node, sheet: Node): Node {
  return mix(clamp(cloudType, 0, 1), float(ANVIL_SHEET_CONV), sheet);
}

// ── Phase 2 (§4.2): vertical-profile LUT master toggle ───────────────────────
// Build const — flip + reload (a page reload rebuilds the node graph AND re-runs
// the light-volume bake fresh, so no runtime re-bake plumbing is needed). OFF =
// the legacy 3 analytic curves in cloudHeightProfile below (byte-identical). ON =
// sample the 64×64 genus LUT (cloudProfileLUT.ts): a CONTINUOUS family of genus
// anatomies indexed by convectivity, which kills the "two looks" + binary-border
// symptom of the 3-curve mix (one 0.5 pivot → only three shapes). Marcher, far
// shell, AND light-volume bake all route through cloudHeightProfile → they sample
// the SAME texture → lockstep hazard #1 (shadows detaching from clouds) is gone
// structurally, not by hand-kept parity.
export const PROFILE_LUT = true;

// km-anchoring span constants. KM-DEFINED (T2) and converted to alt01 so slab
// raises don't silently thicken every sheet / lift every base. The LUT row is
// normalized to each column's OWN [baseN, topN] span, so the SAME genus shape
// fills a thin high sheet OR a deep tower depending on where the span sits:
//   • CONVECTIVE_BASE_KM — deep convective columns sit on a shared low
//     LCL-like deck (the ported cumulus base ≈ 1.65 km).
//   • STRATIFORM_THICKNESS_KM — layered columns HUG their top: baseN = topN −
//     thickness (a thin ~1.6 km sheet just below the cloud top).
// topAlt (from the topHeight channel) sets topN → preserves region-to-region
// height variation; convectivity slides the base between these two regimes.
const CONVECTIVE_BASE_KM = 1.65;
const STRATIFORM_THICKNESS_KM = 1.6;
const CONVECTIVE_BASE_N =
  (CONVECTIVE_BASE_KM - CLOUD_INNER_ALTITUDE_KM) / SLAB_SPAN_KM; // ≈0.043
const STRATIFORM_THICKNESS_N = STRATIFORM_THICKNESS_KM / SLAB_SPAN_KM; // ≈0.107

// Raw LUT row fetch at (altNorm, convectivity), L0 (the LUT is mip-less; its UV
// is non-spatial so a mip level would be meaningless). Used by cloudHeightProfile
// AND directly by the far shell's profile-peak scan — the shell samples the ROW
// at fixed altNorm (not km-anchored alt01) to catch stratiform mass wherever the
// span puts it (Bug A: km-anchoring RELOCATES the stratiform nonzero band away
// from the shell's fixed slab samples, so scanning alt01 would miss thin sheets).
//
// C1 SAMPLING (2026-07-12, the "damascus" orbit-ring fix — ladder-proven:
// PROFILE_LUT=false killed the rings). Hardware bilinear over 64 bins is only
// C0: a derivative kink at every texel boundary. The visible cloud surface's
// altNorm varies smoothly with the topAlt dome, so those kinks land along
// altNorm isolines — 64 potential Mach bands per dome, ~20 km apart at
// typical ERA5 top slopes: the nested rings. Fix: Hermite-ease the fract
// within each texel (smoothstep-weighted bilinear) → C1-continuous
// interpolation from the SAME single hardware fetch. Boundary behaviour is
// preserved (inputs 0/1 map exactly to the edge, where ClampToEdge + the
// boundary-zero texels saturate the profile to 0). The companion defect —
// 8-bit VALUE quantization of the profile — is fixed in cloudProfileLUT.ts
// (R8 → R16F).
export function profileLUTRowSample(altNorm: Node, convectivity: Node): Node {
  const N = float(64); // SIZE — LUT is 64×64 (cloudProfileLUT.ts)
  const c1Coord = (x01: Node): Node => {
    const x = clamp(x01, 0, 1).mul(N).sub(0.5); // texel-center space
    const i = floor(x);
    const f = fract(x);
    const fSmooth = f.mul(f).mul(float(3).sub(f.mul(2))); // Hermite ease
    return i.add(0.5).add(fSmooth).div(N);
  };
  return (
    texture(
      getCloudProfileLUT(),
      vec2(c1Coord(altNorm), c1Coord(convectivity)),
    ).level(int(0)) as Node
  ).r;
}

// ── Phase F step 4 toggle: LINEAR topAlt spread (docs/CLOUD_TYPES_PLAN.md §3.6)
// The smoothstep(0.3, 0.7, colSample) spread was authored for pure Perlin
// clustered at 0.5, but baseVolume.r is the Perlin-Worley HYBRID (measured
// p10/p50/p90 ≈ 0.48/0.71/0.89, mean ≈ 0.70) → the smoothstep SATURATES for
// most columns → topAlt piles at the 0.95 ceiling (69% of dense columns
// > 0.90) → one slab at one height, no tower skyline (H4). The linear remap
// matches the hybrid's actual range. ONE definition now feeds the marcher,
// the shell, the light-volume bake, and the 'topAlt' diagnostic — no more
// hand-mirrored constant (the old earthClouds TOPALT_LINEAR ↔ cloudLightVolume
// TOPALT_LINEAR_MIRROR pair that could silently disagree and detach shadows).
export const TOPALT_LINEAR = true;

// Column-sample → topAlt spread. See TOPALT_LINEAR.
export function topAltSpread(colSample: Node): Node {
  return TOPALT_LINEAR
    ? colSample.sub(float(0.48)).div(float(0.42)).clamp(0, 1)
    : smoothstep(float(0.3), float(0.7), colSample);
}

// coverage (already COVERAGE_GAMMA-lifted) → Nubis cloudType ∈ [0,1]:
// 0 = stratus, 0.5 = stratocumulus, 1 = cumulus. Stage 2 (deferred to
// CLOUD_TYPES_PLAN Phase 1): replace with an explicit weather-map channel.
export function deriveCloudType(coverage: Node): Node {
  return smoothstep(float(0.3), float(0.6), coverage);
}

// Per-column cumulus-top altitude in [0.45, 0.95], coverage-gated (covSpan).
// `colSample` = the per-column Perlin-Worley tap (baseVolume.r at COLUMN_SCALE).
// covSpan keeps sparse columns short (top ~0.45) so only genuinely dense
// columns build tall towers — the 2026-06-16 "lava-lamp floater" fix: without
// it a barely-cumulus column could draw topAlt=0.95 and let one isolated high
// base-noise peak survive with no deck beneath it.
export function deriveTopAlt(coverage: Node, colSample: Node): Node {
  const covSpan = smoothstep(float(0.35), float(0.7), coverage);
  return float(0.45).add(topAltSpread(colSample).mul(0.5).mul(covSpan));
}

// Cloud-type vertical density profile (Nubis B1, three-type decomposition).
//
// Three analytic vertical density curves mixed by `cloudType ∈ [0, 1]`,
// taken straight from Schneider 2015. Each curve is the product of a bottom
// ramp (condensation base) and a top falloff (cloud-top):
//
//   stratus       — thin flat sheet,    0.0–0.1 ramp up,  0.15–0.25 ramp down
//   stratocumulus — moderate broken slab, 0.0–0.25 ramp up,  0.45–0.65 ramp down
//   cumulus       — tall column, sharp low base, top fades over topAlt
//
// Cumulus uses the per-column `topAlt` from the upstream Perlin sample to
// vary tower height between regions. Stratus and stratocumulus heights are
// fixed by type (real stratus decks have remarkably consistent altitude;
// the regional variation is in their cloudType, not their top).
//
// Mix shape (per Schneider):
//   cloudType ∈ [0,    0.5] → stratus → stratocumulus
//   cloudType ∈ [0.5,  1.0] → stratocumulus → cumulus
//
// LOAD-BEARING ANATOMY (do not "simplify" — each fixed a documented bug):
//  • cumBase = smoothstep(0.04, 0.16): a SHARP low condensation base. Was a
//    gradual smoothstep(0, 0.40) whose low end the value-erosion Remap erased
//    → cumulus had no flat bottom and floated ("lava-lamp" blobs). A defined
//    low base survives the Remap → clouds sit on a common deck (flat bottoms).
//  • cumTop = 1 − fadeX² (PARABOLIC, not a plain smoothstep): a plain
//    smoothstep(fadeStart, topAlt) is an iso-altitude fade → the erosion
//    threshold intersects the base on a near-horizontal plane = a CLEANLY
//    SLICED FLAT TOP. Bending to 1 − x² meets the base on a CURVED locus = an
//    organic rounded dome.
export function cloudHeightProfile(
  alt01: Node,
  topAlt: Node,
  cloudType: Node,
): Node {
  if (PROFILE_LUT) {
    // §4.2 km-anchoring: place + size the column's [baseN, topN] span, then read
    // the genus row at the normalized altitude. altNorm saturates to 0 below
    // baseN and 1 above topN, and the LUT row is 0 at both boundaries → a flat
    // base and a clean top with NO ceiling/floor extrusion. cloudType IS the
    // convectivity axis under WEATHER_V2 (map G); under legacy it is the
    // coverage-derived type — both live in [0,1], so the LUT reads either.
    const topN = clamp(topAlt, 0, 1);
    const convectivity = clamp(cloudType, 0, 1);
    // Clamp baseN ≥ 0: a low stratiform column (topN < STRATIFORM_THICKNESS_N,
    // now reachable since the topN floor dropped to 0.10) would otherwise place
    // its base below the slab floor → the sheet sits ON the floor instead.
    const baseN = mix(
      topN.sub(float(STRATIFORM_THICKNESS_N)),
      float(CONVECTIVE_BASE_N),
      convectivity,
    ).max(float(0));
    const span = topN.sub(baseN).max(float(0.001));
    const altNorm = alt01.sub(baseN).div(span);
    return profileLUTRowSample(altNorm, convectivity);
  }

  // ── Legacy analytic 3-curve profile (PROFILE_LUT off) ──
  // Stratus: thin flat sheet.
  const stratusBase = smoothstep(float(0.0), float(0.1), alt01);
  const stratusTop = float(1).sub(smoothstep(float(0.15), float(0.25), alt01));
  const stratus = stratusBase.mul(stratusTop);

  // Stratocumulus: moderate broken slab.
  const scBase = smoothstep(float(0.0), float(0.25), alt01);
  const scTop = float(1).sub(smoothstep(float(0.45), float(0.65), alt01));
  const stratocumulus = scBase.mul(scTop);

  // Cumulus: tall column whose top fade is keyed by per-column topAlt.
  const cumBase = smoothstep(float(0.04), float(0.16), alt01);
  const fadeStart = topAlt.sub(float(0.35));
  const fadeX = clamp(
    alt01.sub(fadeStart).div(topAlt.sub(fadeStart).max(0.0001)),
    0,
    1,
  );
  const cumTop = float(1).sub(fadeX.mul(fadeX));
  const cumulus = cumBase.mul(cumTop);

  const lowerMix = mix(
    stratus,
    stratocumulus,
    smoothstep(float(0.0), float(0.5), cloudType),
  );
  return mix(lowerMix, cumulus, smoothstep(float(0.5), float(1.0), cloudType));
}
