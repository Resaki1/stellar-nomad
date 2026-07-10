import { float, smoothstep, mix, clamp, texture, vec2, int } from "three/tsl";
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

// Map the v2 topHeight channel into the cloud-TOP altitude parameter topN
// (alt01 units over the 1–14 km slab). LINEAR (never a smoothstep — the
// anti-bimodal rule, §3.6 H4). Range widened 2026-07-08 to [0.10, 0.95]
// (was [0.45, 0.95]): the 0.45 floor made the LOWEST possible cloud top ~7 km
// and every base ≥4 km → NO low stratus/cumulus. 0.10 → topHeight 0 puts the
// top at ~2.3 km (low cloud). NOTE: the LEGACY analytic cloudHeightProfile
// (PROFILE_LUT off) was authored for topAlt∈[0.45,0.95]; with this wider range
// its cumulus fade goes off-spec — the LUT path (default) is unaffected (it
// uses topN as the span top and clamps baseN below).
export function topHeightToTopAlt(topHeight01: Node): Node {
  return mix(float(0.1), float(0.95), clamp(topHeight01, 0, 1));
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
    .clamp(0.1, 0.95); // same floor/ceiling as topHeightToTopAlt
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

// km-anchoring span constants (alt01 units over the 1–14 km slab). The LUT row is
// normalized to each column's OWN [baseN, topN] span, so the SAME genus shape
// fills a thin high sheet OR a deep tower depending on where the span sits:
//   • CONVECTIVE_BASE_N — deep convective columns sit on a shared low LCL-like
//     deck (matches the ported cumulus base, smoothstep 0.04–0.16 → base ≈ 0.05).
//   • STRATIFORM_THICKNESS_N — layered columns HUG their top: baseN = topN −
//     thickness (a thin sheet just below the cloud top). ≈ 1.5 km / 13 km slab.
// topAlt (from the topHeight channel) sets topN → preserves region-to-region
// height variation; convectivity slides the base between these two regimes.
const CONVECTIVE_BASE_N = 0.05;
const STRATIFORM_THICKNESS_N = 0.12;

// Raw LUT row fetch at (altNorm, convectivity), L0 (the LUT is mip-less; its UV
// is non-spatial so a mip level would be meaningless). Used by cloudHeightProfile
// AND directly by the far shell's profile-peak scan — the shell samples the ROW
// at fixed altNorm (not km-anchored alt01) to catch stratiform mass wherever the
// span puts it (Bug A: km-anchoring RELOCATES the stratiform nonzero band away
// from the shell's fixed slab samples, so scanning alt01 would miss thin sheets).
export function profileLUTRowSample(altNorm: Node, convectivity: Node): Node {
  return (
    texture(
      getCloudProfileLUT(),
      vec2(clamp(altNorm, 0, 1), clamp(convectivity, 0, 1)),
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
