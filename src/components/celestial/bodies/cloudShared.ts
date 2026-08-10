import {
  float,
  smoothstep,
  mix,
  clamp,
  texture,
  vec2,
  vec3,
  dot,
  int,
  floor,
  fract,
  pow,
} from "three/tsl";
import { kmToScaledUnits } from "@/sim/units";
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
export const ANVIL = false; // RESET 2026-07-23: MEASURED annular-cavity source — the skirt sheet-morph fires on EVERY tall convective column at conv 0.9 (gate=1.00), not just mature Cb, lifting a ring of columns' bases to 4-11 km with clear air beneath. Re-enable only behind a far tighter gate.
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

// ═══════════════════════════════════════════════════════════════════════════
// TAKRAM-RECIPE SHAPE PORT (docs/CLOUD_VS_TAKRAM.md #2b fallback, 2026-07-20).
// A composition-only port of @takram/three-clouds' density shaping, driving it
// with OUR baked noise + coverage map. Gated by TAKRAM_SHAPE; when off, nothing
// here runs and the legacy profile-LUT + Nubis-erosion path is byte-identical.
// The point of takram's clean cumulus is the COMPOSITION, not new noise:
//   1. shapeAlteringFunction — a downward-biased semicircle height gradient
//      (bias<1 → widest just above base, tapering to top = the cumulus DOME,
//      the thing our profile-LUT plateau could never give).
//   2. coverageFilterWidth remap — soft/hard cloud edge per type.
//   3. remap-erosion by the base shape (renormalising, keeps cores solid).
//   4. height-dependent detail — pow(detail,6) whippy base / (1-detail) fluffy
//      top, from one detail tap.
// Reference: clouds.glsl sampleWeather/sampleMedia; cloudShape/Detail.frag.
// Phase 1 wires only the view-ray marcher + its skip-gate; the self-shadow
// probe + far shell still use the legacy path (so under the toggle self-shadow
// / orbit may not match yet — Phase 2). ALL knobs below are tunable.
export const TAKRAM_SHAPE = false;
const TAKRAM_COVERAGE = 0.5; //          global cloudiness bias in `factor`
const TAKRAM_BIAS_ST = 0.6; //           shapeAlteringFunction bias: St less base-heavy
const TAKRAM_BIAS_CU = 0.25; //          Cu strongly base-heavy (takram default 0.35)
const TAKRAM_COVW_ST = 0.9; //           coverageFilterWidth: St soft/overcast edge
const TAKRAM_COVW_CU = 0.7; //           Cu harder cumuliform edge
const TAKRAM_SHAPE_AMT_ST = 0.6; //      base-shape erosion strength (St gentler)
// 2026-07-20: 1.0 → 1.8. At 1.0 the deepest erosion threshold is (1−shapeMin
// 0.43)·1.0 = 0.57, so a DENSE tower (covD≈0.95) only erodes to ~0.88 → smooth
// opaque mound, no lobes. >1 lets (1−shape)·amt reach ≥1 → erosion can carve
// dense bodies to 0 at lobe boundaries → actual cauliflower lobes + crevices.
const TAKRAM_SHAPE_AMT_CU = 1.0; // RESET 2026-07-23: back inside takram's range. >1 lets the erosion threshold (1-baseMin)*amt exceed covD and punch holes through solid body.
// How strongly a dense core resists erosion (see the coupling in takramDensity).
// erosionThreshold *= (1 - covD * TAKRAM_CORE_SOLIDITY). At 0.6 a full-coverage
// mid-height core (covD ≈ 0.71) caps its threshold at ≈0.59 < covD → CANNOT be
// hollowed, while an edge column (covD ≈ 0.4) still reaches ≈0.78 > covD → still
// erodes to zero → wispy edges + lobed tops. 0 = the old sponge behaviour.
const TAKRAM_CORE_SOLIDITY = 0; // RESET 2026-07-23: unnecessary at shapeAmt <= 1.0 (cores cannot be hollowed anyway). Kept wired for when shapeAmt is raised again.
// ── Nubis erosion form (see the long note in takramDensity) ─────────────────
// true  = Remap(NOISE, 1 - covD*k, 1)  → outline is an iso-contour of the NOISE
//         (billowy). MEASURED +31% lobe prominence at k=2.0 with solid cores.
// false = the takram form (outline follows the smooth coverage envelope).
export const TAKRAM_NUBIS_FORM = true;
const TAKRAM_NUBIS_K = 2.0;
// Measured percentiles of the RE-BAKED shape volume — used to normalize the
// noise to a full [0,1] signal. Re-measure if the volume is re-baked.
const SHAPE_VOL_P1 = 0.584;
const SHAPE_VOL_P99 = 0.941;
const TAKRAM_DETAIL_AMT_ST = 0.5; //     detail erosion strength
const TAKRAM_DETAIL_AMT_CU = 1.0;
// Tap scales for the takram noise volumes (used by earthClouds' marcher). The
// volume tiles ≈ 1000/scale km. Shape ≈3.3 km matches takram's shapeRepeat
// 0.0003; detail finer. The Phase-1 composition test used our coarse base at
// 20 km (uBaseScale 50) — far too big for cumulus lobes. TUNE for lobe size.
export const TAKRAM_SHAPE_TAP_SCALE = 150; //  ~3.3 km billows
export const TAKRAM_DETAIL_TAP_SCALE = 1200; // ~0.83 km detail
// Phase 2 self-shadow of the takram lobes: march takramDensity toward the sun at
// the detail (~1 km) + lobe (~3 km) scales so crevices between lobes read dark
// (the cauliflower look). TAKRAM_SS_DENSITY = per-tap optical-depth scale (tune
// for crevice darkness; kept < LOCAL_SHADOW_DENSITY 2000 so the long far tap
// doesn't crush interiors to black — the multi-scatter term lifts them back).
// ── SUN MARCH SCHEDULE (rewritten 2026-07-23 — the FLAT-CLOUD root cause) ────
// The old probe was TWO taps at 1 km and 3 km, weighted by their own distance:
//   odT = dens(1km)*D*0.001 + dens(3km)*D*0.003
// MEASURED (scratchpad/od_measure.mjs, 2716 visible-surface samples, high sun):
//   • sampled density at BOTH taps: p50 = 0.000 — they land OUTSIDE the cloud
//   • resulting odT p50 = 0.000  →  Tsun p50 = 1.000  →  DEBUG_VIZ 'tsunMs'
//     reads pure white in-game, exactly as observed
//   • but 77% of the TRUE sun-path optical depth lies within 0-1 km — the range
//     the old schedule sampled ZERO times.
// Since Tsun is the ONLY per-voxel term in the lighting (phase is constant per
// ray, `profile` is the smooth envelope), Tsun≡1 collapses the cloud to a flat
// mid-white blob. THAT is why midday cumulus had no tonal range.
//
// Fix: a proper Beer-Lambert quadrature — samples concentrated NEAR the surface
// with explicit SEGMENT LENGTHS (not "weight by own distance", which both
// double-counted the far tap and left 0-1 km unsampled).
// [distance, segmentLength] in SCALED units (1 unit = 1000 km ⇒ 0.0003 = 300 m).
// Measured vs a 48-sample ground-truth integral: 3-tap corr 0.727, Tsun spread
// 0.02–1.0 (vs the old 2-tap's degenerate 1.0). A 4th tap only buys corr 0.764,
// not worth +2 texture3D in the hot loop — add [0.0026, 0.002] if you want it.
export const TAKRAM_SS_TAPS: readonly (readonly [number, number])[] = [
  [0.00015, 0.0003], // 150 m, 300 m segment — the near field that carries ~77%
  [0.0006, 0.0006], // 600 m, 600 m segment
  [0.0018, 0.0021], // 1.8 km, 2.1 km segment — inter-lobe / neighbour shadowing
];
// Extinction for the sun march, per SCALED unit (÷1000 = per km). The view ray
// uses uDensityMul = 12000 (12/km); a physically-matched sun march would use the
// same, but that is the classic single-scatter over-darkening (real clouds stay
// bright via multiple scattering, which we only approximate with MS_COEF). 6000
// (6/km) was picked from the measured sweep: Tsun p10/p50/p90 = 0.02/0.41/0.91 —
// genuinely dark crevices and bases, bright sunlit crowns. Raise → more dramatic
// and darker; lower → flatter. (Old value 800 was tuned to compensate for the
// broken quadrature and is meaningless under the new one.)
export const TAKRAM_SS_DENSITY = 6000;

// ── Envelope domain warp (the SILHOUETTE fix, 2026-07-23) ────────────────────
// ROOT CAUSE of "smooth-pyramid" cumulus outlines (offline-proven, see
// docs/CLOUD_VS_TAKRAM.md + memory): the macro shape is a SEPARABLE smooth
// envelope coverage(dir)×heightProfile(alt); inward-only erosion can only fringe
// its edge, never bulge OUT into the medium-scale lobes real cumulus has. The
// fix is a domain warp of the ENVELOPE evaluation position — it displaces the
// smooth coverage/altitude field into 3D lobes → scalloped organic outline.
// MEASURED: warping the NOISE phase (the retired legacy warp) does NOT lump the
// outline; only warping the COVERAGE+ALTITUDE lookup does. Envelope warp can't
// re-introduce the old "stringy" shear (that was noise-phase warp of a high-freq
// field; the coverage field is smooth/low-freq). Radial component is damped so
// cloud bases stay roughly flat. Cost: +1 base-volume tap per primary step.
export const TAKRAM_ENVELOPE_WARP = false; // RESET 2026-07-23: neither reference uses an envelope warp; ours caused rings, flames/drips (via the noise warp it fed) and fold cavities (5.3% of volume at amp 2.5).
// ANTI-FOLD RULE (2026-07-23): the warp punches rings/holes through the cloud
// (domain-warp FOLDING) once the displacement gradient ≈ AMP_KM × SCALE / 250
// approaches 1. The user's 3.3/78 was ~1.03 → heavy rings. Keep the product
// ≲ 165 (gradient ≲ 0.66). To get MORE lumpy displacement without folding you
// must accept BIGGER lobes (lower SCALE): 2.5/65≈0.65 (~3.9 km lobes),
// 3.0/54≈0.65 (~4.6 km), 2.0/80≈0.64 (~3.1 km).
// 2.5 → 1.0 (2026-07-23): MEASURED FOLDING. A domain warp is only a valid
// (invertible) deformation while |∇displacement| < 1; above that det(Jacobian)
// goes negative and space is DOUBLED OVER — regions get traversed twice and the
// fold surfaces render as smooth layered walls around a cavity. That is the
// "outer shell → empty space → dense core" the user flew through.
// Monte-Carlo over the warp field (40k samples, incl. the TANGENT/RADIAL scaling):
//   amp 2.5 → 5.3% of volume FOLDED (min det −1.86, mean|∇d| 1.18)
//   amp 1.5 → 0.0% but min det −0.08 (marginal)
//   amp 1.0 → 0.0%, min det +0.24  ← safe
// (My earlier "gradient 0.65 is fold-free" was wrong: that divided amplitude by
// wavelength; the true mean gradient is ~1.18 at amp 2.5.)
// NOTE the references use NO envelope warp at all — takram gets its puffiness
// from the noise + composition alone. Treat this knob as a small optional nudge,
// never as the mechanism that creates the shape.
export const TAKRAM_ENV_WARP_AMP_KM = 1.0; //  lobe displacement (keep ≤1.0: fold-free)
export const TAKRAM_ENV_WARP_SCALE = 65; //   ~15 km tile → ~3.9 km lobes (fold-free at amp 2.5)
// ── TANGENTIAL vs RADIAL split (2026-07-23, the "flames not puffs" fix) ──────
// These do VERY different things and were previously conflated:
//   TANGENTIAL — slides the position sideways, which slides `dirP`: the lookup
//     into the WEATHER MAP and the mesoTap PLACEMENT field (fractionPlacement,
//     turret mask, anvil skirt, topAlt jitter). Because those fields carry real
//     STRUCTURE, displacing the lookup by a noise SMEARS that structure into
//     streaks — the licking/flame-like tendrils (user-reported 2026-07-23). It
//     lobes the outline, but it scrambles placement to do it.
//   RADIAL — moves the sample up/down the column, so it reads a different point
//     of the vertical profile. This undulates the cloud's TOP SURFACE into lobes
//     WITHOUT touching the horizontal placement at all — the clean way to lump.
// The old single RADIAL=0.1 knob meant the offset was ~90% TANGENTIAL, i.e.
// almost all lobing came from the placement-scrambling path. Bisect in-game:
// set TANGENT 0 (pure radial) — if the flames vanish, tangential is the culprit.
// TANGENT 1.0 / RADIAL 0.1 reproduces the previous (flame-y) behaviour exactly.
// With TAKRAM_NOISE_WARP_FRAC = 0 the noise is no longer sheared by either
// component, so both can contribute lobing without the flame/drip artifact.
// TANGENT still slides the weather/placement LOOKUP (keep it moderate — it
// smears placement structure, a milder artifact than the noise shear);
// RADIAL undulates the column's top surface, which is the cleanest lobing.
export const TAKRAM_ENV_WARP_TANGENT = 0.35;
export const TAKRAM_ENV_WARP_RADIAL = 0.4;
// CONVECTIVITY GATE (2026-07-23): warping a thin STRATIFORM sheet fragments it
// (user-confirmed "ST looks weird"). Gate the warp by the weather map's
// convectivity (G) so only convective CU/Cb columns lobe; stratiform stays the
// smooth flat sheet it was. Sampled at the UNWARPED direction (convectivity is a
// smooth hundreds-of-km field → warped≈unwarped). Below LO = no warp, above HI =
// full warp.
export const TAKRAM_ENV_WARP_CONV_LO = 0.4;
export const TAKRAM_ENV_WARP_CONV_HI = 0.65;
// PLACEMENT gate (2026-07-23, rev 2): the conv gate stops STRATIFORM warping,
// but thin sheets BETWEEN cumulus towers still swirled. First attempt gated by
// the weather map's coverage (.r) — WRONG signal: for the real ERA5 map .r is a
// ~28 km cell average, moderate even under a big tower, so it starved the CU of
// warp too (user-confirmed). The signal that separates a TOWER from the thin
// inter-cloud gap is the SUB-CELL placement/updraft field (mesoTap.g, the same
// field that drives fractionPlacement + turrets): high in solid cloud cores,
// near the placement threshold (~0.475) in the marginal gaps. Gate the warp by
// it → towers lobe, thin gaps stay flat. Sampled at the UNWARPED dir.
export const TAKRAM_ENV_WARP_PLACE_LO = 0.48;
export const TAKRAM_ENV_WARP_PLACE_HI = 0.6;
// NOISE warp (2026-07-23): the ENV warp lobes the OUTLINE but leaves compact
// "floating blob" edges; displacing the NOISE tap by a fraction of the same
// (conv-gated) warp vector stretches edge detail into fine WISPS instead (the
// look the user liked in the offline `final_winner`). REUSES the env warp vector
// → zero extra taps. Applied to BOTH the view ray AND the self-shadow probe so
// crest/crevice relief stays correlated (case #21). CAUTION: this is the
// noise-phase warp that historically caused "stringy" shear (CLOUD_DEBUGGING_
// LESSONS #19) — keep the fraction modest and watch top-down views for strings.
// 0 = env-only (no wisps, no string risk); 1 = noise warps as much as the
// envelope (max wisps, max string risk).
// 0.55 → 0.3 → 0 (2026-07-23). THIS KNOB WAS THE "FLAMES"/"DRIPS" ARTIFACT.
// It displaces the NOISE PHASE by a fraction of the envelope warp, which SHEARS
// the noise features along the warp direction — the documented "stringy billows"
// failure (CLOUD_DEBUGGING_LESSONS #19). Proven by A/B: with a mostly-TANGENTIAL
// warp the smear was horizontal → licking flame tendrils; after the split made
// the warp mostly RADIAL the smear rotated to vertical → candle-wax drips down
// the towers. Same bug, rotated with the warp — so no tangential/radial split
// can cure it. Only the ENVELOPE warp (which moves the coverage/altitude LOOKUP
// and leaves the noise features intact) may lump the outline.
// COST OF 0: we lose the fine wisps this bought at the cloud edges (the look the
// user liked in the offline `final_winner`). Wisps must come from a mechanism
// that doesn't shear the body — e.g. the detail volume's Alligator/wisp channel
// applied at EDGES only — not from warping the whole noise field.
export const TAKRAM_NOISE_WARP_FRAC = 0;

// Envelope warp offset — the SINGLE source of the warp math, called by BOTH the
// marcher AND the light-volume bake so they can't drift (the whole cloudShared
// philosophy; before this the warp lived marcher-only and baked shadows detached
// from the warped clouds). Callers sample the inputs at the UNWARPED position:
//   convectivity — weather map .g   (gate OUT stratiform)
//   placement    — mesoTap.g        (gate OUT thin inter-cloud gaps; the
//                  sub-cell updraft field that also drives placement/turrets)
//   warpNoiseVec — baseVolume .gba at q·TAKRAM_ENV_WARP_SCALE (vec3)
// Returns a scaled-units offset (0 when disabled / stratiform / gap). Radial
// component damped (flat-ish bases). The caller adds it to q before deriving the
// coverage-lookup dir + altitude; the marcher additionally reuses a FRACTION of
// it (TAKRAM_NOISE_WARP_FRAC) to displace the noise tap for wisps.
export function envelopeWarpOffset(
  q: Node,
  r: Node,
  convectivity: Node,
  placement: Node,
  warpNoiseVec: Node,
): Node {
  const gate = smoothstep(
    float(TAKRAM_ENV_WARP_CONV_LO),
    float(TAKRAM_ENV_WARP_CONV_HI),
    clamp(convectivity, 0, 1),
  ).mul(
    smoothstep(
      float(TAKRAM_ENV_WARP_PLACE_LO),
      float(TAKRAM_ENV_WARP_PLACE_HI),
      clamp(placement, 0, 1),
    ),
  );
  const raw = warpNoiseVec
    .sub(vec3(0.5, 0.5, 0.5))
    .mul(float(kmToScaledUnits(TAKRAM_ENV_WARP_AMP_KM) * 2))
    .mul(gate);
  // Split the raw displacement into its RADIAL and TANGENTIAL parts and scale
  // them independently (see TAKRAM_ENV_WARP_TANGENT/RADIAL): tangential slides
  // the weather/placement LOOKUP (lobes the outline but smears placement into
  // flame-like streaks); radial slides up/down the column (undulates the top
  // surface into lobes with placement untouched).
  const dirUp = q.div(r);
  const radial = dot(raw, dirUp);
  const radialVec = dirUp.mul(radial);
  const tangentVec = raw.sub(radialVec);
  return tangentVec
    .mul(float(TAKRAM_ENV_WARP_TANGENT))
    .add(radialVec.mul(float(TAKRAM_ENV_WARP_RADIAL)));
}

// clamp((v−lo)/(hi−lo), 0, 1) — takram's remapClamped(v, lo, hi) → [0,1].
export function remapClamped(v: Node, lo: Node, hi: Node): Node {
  return v.sub(lo).div(hi.sub(lo).max(float(1e-4))).clamp(0, 1);
}

// Biased semicircle (clouds.glsl:68-73): 0 at base+top, peak skewed toward the
// base when bias<1 → wide base narrowing to a rounded top (the cumulus dome).
export function shapeAlteringFunction(heightFraction: Node, bias: Node): Node {
  const biased = pow(clamp(heightFraction, 0, 1), bias);
  const x = clamp(biased.mul(2).sub(1), -1, 1);
  return float(1).sub(x.mul(x));
}

// The km-anchored altNorm the profile uses internally (see cloudHeightProfile):
// altitude fraction within the column's own [baseN, topN] span. Exposed so the
// takram path can drive shapeAlteringFunction with the SAME height axis.
// `topAltForBase` (optional) lets the caller derive the column BASE from a
// different (unperturbed) top than the one that sets the span's TOP. Needed by
// the fine top perturbation below: without it, wobbling the top drags the base
// with it and cloud bases go ragged — real cumulus share a flat condensation
// level (MEASURED: decoupling holds base sd at 0.05 km at every amplitude).
export function columnAltNorm(
  alt01: Node,
  topAlt: Node,
  cloudType: Node,
  topAltForBase?: Node,
): Node {
  const topN = clamp(topAlt, 0, 1);
  const baseRef = clamp(topAltForBase ?? topAlt, 0, 1);
  const convectivity = clamp(cloudType, 0, 1);
  const baseN = mix(
    baseRef.sub(float(STRATIFORM_THICKNESS_N)),
    float(CONVECTIVE_BASE_N),
    convectivity,
  ).max(float(0));
  const span = topN.sub(baseN).max(float(0.001));
  return alt01.sub(baseN).div(span).clamp(0, 1);
}

// ── Fine per-column TOP perturbation (silhouette lobing, 2026-07-23) ─────────
// THE measured way to lobe the silhouette without a domain warp. Established by
// measurement that the outline is essentially INVARIANT to the noise (tap scale,
// carve depth, core solidity, noise contrast, coverage structure, cloud size and
// optical density all left lobe prominence at ~3%): the silhouette is just where
// the SMOOTH SEPARABLE envelope crosses the erosion threshold, so only moving
// the ENVELOPE moves it. The domain warp did that by displacing POSITION — and
// folded space (cavities). This perturbs the envelope BY VALUE instead: each
// column's top wobbles, so the cloud's upper surface undulates. A value
// perturbation has no Jacobian, so FOLDING IS MATHEMATICALLY IMPOSSIBLE.
// MEASURED (N=16 independent samples): convex protrusions along the silhouette
// 3.3 (baseline) → 4.3 (amp .08) → 5.4 (amp .15) → 6.0 (amp .22), with base
// flatness unchanged at 0.05 km. Cauliflower is MANY bumps, not a few big ones,
// so the lobe COUNT is the meaningful gain here (prominence stays ~3-4%, which
// is the noise fringe width). Scale 300 (~3.3 km tile) measured best; 150 and
// 600 gave no gain. Physically this is "each convective cell tops out at its own
// height" at bud scale — the existing TOPALT_JITTER does the same at ~8 km.
// COST: +1 texture3D per primary step (column-direction tap). Set AMP 0 to disable.
export const TAKRAM_TOP_PERTURB_AMP = 0;
export const TAKRAM_TOP_PERTURB_SCALE = 300;
// The baked shape volume's measured distribution — used to turn a raw sample
// into a zero-mean, unit-ish signed perturbation.
const SHAPE_VOL_MEAN = 0.797;
const SHAPE_VOL_SD = 0.077;
export function perturbTopAlt(topAlt: Node, shapeSample: Node): Node {
  if (TAKRAM_TOP_PERTURB_AMP <= 0) return topAlt;
  const z = shapeSample.sub(float(SHAPE_VOL_MEAN)).div(float(SHAPE_VOL_SD));
  return topAlt
    .add(z.mul(0.5).mul(float(TAKRAM_TOP_PERTURB_AMP)))
    .clamp(float(TOPALT_FLOOR), float(TOPALT_CEIL));
}

// Full takram density ∈ [0,1] at a sample. `coverageSignal` = our per-column
// coverage (takram's per-texel localWeather); `baseShapeRaw` = a base-noise tap
// (takram shapeTexture.r); `detailRaw` = a detail tap (shapeDetailTexture.r).
// Feeds gamma+extinction downstream exactly like the legacy `shape`.
export function takramDensity(
  coverageSignal: Node,
  altNorm: Node,
  convectivity: Node,
  baseShapeRaw: Node,
  detailRaw: Node,
): Node {
  const conv = clamp(convectivity, 0, 1);
  const bias = mix(float(TAKRAM_BIAS_ST), float(TAKRAM_BIAS_CU), conv);
  const covW = mix(float(TAKRAM_COVW_ST), float(TAKRAM_COVW_CU), conv);
  const shapeAmt = mix(float(TAKRAM_SHAPE_AMT_ST), float(TAKRAM_SHAPE_AMT_CU), conv);
  const detAmt = mix(float(TAKRAM_DETAIL_AMT_ST), float(TAKRAM_DETAIL_AMT_CU), conv);

  const heightScale = shapeAlteringFunction(altNorm, bias);
  const factor = float(1).sub(float(TAKRAM_COVERAGE).mul(heightScale));
  // Coverage → soft-edged, dome-shaped density (Skybolt/takram modulation).
  const covD = remapClamped(
    mix(clamp(coverageSignal, 0, 1), float(1), covW),
    factor,
    factor.add(covW),
  );
  // Erode by the base shape (renormalising remap — solid cores, rounded edges).
  //
  // CORE-SOLIDITY COUPLING (2026-07-23 — the "cloud is a sponge" fix).
  // The bare form `remap(covD, (1-base)*shapeAmt, 1)` has an erosion threshold
  // that depends ONLY on the noise, so it bites just as deep in the CORE as at
  // the edge. With shapeAmt raised to 1.8 (done deliberately to force surface
  // lobes out of a smooth mound) the threshold reaches (1-0.43)*1.8 = 1.03 and
  // exceeds covD EVERYWHERE → holes punched clean through the body. MEASURED
  // (scratchpad/hollow_test.mjs): cumulus interiors were 22-42% EMPTY by volume;
  // horizontal cross-sections render as foam. That is what the user hit flying
  // in: wisp shell → void → dense core.
  // Both references avoid this by making the erosion ENVELOPE-MODULATED:
  //   Nubis  — threshold is (1 - dimProfile): →0 in cores (noise passes, SOLID),
  //            →1 at edges (only peaks survive, wispy).
  //   takram — same remap but shapeAmount ≲1, so the max threshold (0.57) can
  //            never exceed a dense core's covD.
  // We keep the strong shapeAmt (needed for edge/top lobes) but scale it down
  // where covD is high, restoring the invariant "cores cannot be hollowed" while
  // leaving edges and tops fully carveable. 0 = old sponge behaviour.
  const coreSolidity = float(1).sub(
    covD.mul(float(TAKRAM_CORE_SOLIDITY)),
  );
  // ── NUBIS FORM vs TAKRAM FORM — the "why is our silhouette smooth" answer ──
  // These two are INVERTED with respect to each other:
  //   Nubis/Schneider: shape = Remap( NOISE , 1 - coverage , 1, 0, 1 )
  //                    → the outline is an ISO-CONTOUR OF THE 3D NOISE
  //                      (billowy by construction); coverage sets the level.
  //   takram (ported):  shape = remap( covD , (1-noise)*amt , 1 )
  //                    → the outline is an iso-contour of the SMOOTH COVERAGE
  //                      ENVELOPE; the noise only nudges the threshold.
  // Ours is smooth because the baked noise spans only ~0.58-0.94, so
  // (1-noise)*amt is squeezed into ~[0.06,0.42] while covD runs 0→0.71 — the
  // boundary therefore sits where covD is small and tracks the coverage falloff.
  // MEASURED (offline, protrusion metric on the alpha=0.5 silhouette):
  //   takram form      lobe prominence 0.281 km, interior 0.4% empty
  //   Nubis k=1.4      0.428 km but 25% HOLLOW
  //   Nubis k=2.0      0.367 km (+31%) and only 3.0% empty  ← chosen
  //   Nubis k=2.4      0.306 km, 0% empty (back to smooth)
  // k scales the coverage's reach into the threshold: high k drives the CORE
  // threshold to ~0 (solid core) while the edges keep a high threshold (carved).
  // Set TAKRAM_NUBIS_FORM=false to return to the takram form exactly.
  const nubisEroded = remapClamped(
    // normalize the baked noise p1..p99 → [0,1] so it can act as a full-range
    // SIGNAL rather than a compressed threshold nudge.
    remapClamped(
      clamp(baseShapeRaw, 0, 1),
      float(SHAPE_VOL_P1),
      float(SHAPE_VOL_P99),
    ),
    float(1).sub(covD.mul(float(TAKRAM_NUBIS_K))),
    float(1),
  );
  const takramEroded = remapClamped(
    covD,
    float(1)
      .sub(clamp(baseShapeRaw, 0, 1))
      .mul(shapeAmt)
      .mul(coreSolidity),
    float(1),
  );
  const eroded = TAKRAM_NUBIS_FORM ? nubisEroded : takramEroded;
  // Height-dependent detail: whippy base (pow6) → fluffy top (1−detail).
  const d = clamp(detailRaw, 0, 1);
  const detailMod = mix(
    pow(d, float(6)),
    float(1).sub(d),
    remapClamped(altNorm, float(0.2), float(0.4)),
  ).mul(detAmt);
  return remapClamped(eroded.mul(2), detailMod.mul(0.5), float(1));
}
