import { float, smoothstep, mix, clamp } from "three/tsl";

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
