// =============================================================================
// Tile-&-offset anti-tiling for the cloud noise (replaces the WARP_AMPLITUDE
// domain warp).
//
// WHY: the old anti-tiling was a domain warp whose source was the base volume's
// high-frequency Worley-FBM channels — a steep displacement gradient that
// SHEARED the noise into curved "stringy" filaments (the bug we chased for
// days; see docs/CLOUD_DEBUGGING_LESSONS.md case study #19 and
// docs/VOLUMETRIC_CLOUDS_SHAPE_PLAN.md). Tile-&-offset (Inigo Quilez "texture
// repetition" / what EVE's "noise detiling" does) instead partitions the world
// horizontal plane into tiles and gives each a RIGID hashed offset, so each
// tile samples a different phase of the infinite (RepeatWrapping) tiled noise.
// A rigid per-tile translation cannot shear — billows stay round — while the
// per-tile phase break hides the 20 km base-tile repetition. A 4-tap bilinear
// blend (seam at tile centres, `DETILE_BLEND` controls the band) avoids hard
// seams. Validated in /dev/cloud-slice (tile 20 km, blend 0.5).
//
// ⚠️ SINGLE SOURCE OF TRUTH. The offset hash + tiling MUST be identical between
// the renderer (earthClouds.ts) and the shadow bake (cloudLightVolume.ts), or
// the baked shadows won't register with the rendered clouds. Both import from
// here. Do not fork this logic.
//
// Cost: tile-&-offset evaluates the wrapped sampler 4× (vs 1×). It's gated by
// `USE_DETILE` (compile-time) so the OFF path is byte-for-byte the original
// single-tap warp. Profile before lowering `DETILE_BLEND` for an interior
// early-out (at blend 0.5 the whole tile blends → no interior to skip).
// =============================================================================

import {
  vec2,
  vec3,
  float,
  floor,
  fract,
  dot,
  smoothstep,
  mix,
  clamp,
} from "three/tsl";

// =============================================================================
// Base-shape DILATION (2026-06-16 — floater / smooth-blob / sliced-top
// root-cause fix; CONFIRMED with the noiseVolumes.ts histogram).
//
// ROOT CAUSE (measured): the raw Perlin-Worley channel R is a HEALTHY
// distribution (mean 0.605, spread 0.2..1.0, 28% of voxels < 0.5). But the old
// Schneider dilation `(R + (1-fbm)) / (2-fbm)` adds `(1-fbm)` (~0.65, since the
// Worley-FBM mean is low) as a FILL term — it lifted the whole field to a hard
// 0.45 floor and crushed it into [0.45, 1.0] (histogram piled 40%/32%/10% in
// the top three bins, NOTHING below 0.45). With no low tail, the value-erosion
// had no gaps to carve → smooth envelope blobs; and the huge high pile survived
// at any profile>0 → floaters / sliced tops.
//
// THE FIX — `baseDilate`: erode R with the Worley-FBM instead of filling with
// it. `saturate(R - fbm * BASE_ERODE)` carves gaps (restores the low tail →
// real cloud separation) AND stamps Worley billow structure into the macro
// shape. BASE_ERODE is the carve strength: 0 = raw R (mean 0.6, min 0.2),
// higher = deeper gaps / lower mean. Tune it LIVE against the noiseVolumes
// histogram (target: a centred distribution with a real low tail) and
// DEBUG_VIZ='baseColumn' (structure, not uniform pale).
//
// ⚠️ LOCKSTEP: baseDilate MUST be used identically in the marcher (earthClouds
// primary + local self-shadow probe + the baseColumn viz) AND the shadow bake
// (cloudLightVolume densityAt), AND the noiseVolumes histogram must mirror the
// formula, or shadows/readouts drift from the rendered clouds.
// =============================================================================

// Carve strength for baseDilate. Also consumed (as a plain number) by the
// noiseVolumes.ts distribution histogram so the readout matches the shader.
export const BASE_ERODE = 0.0;

// ── Mid-scale billow (2026-06-18 — #2; Schneider 2015 base-shape dilation) ──
// Schneider/Frostbite build the base SHAPE by dilating the Perlin-Worley core
// (`r`) with the Worley-FBM octaves (`fbm`) — that dilation IS the medium-scale
// cauliflower billowing (the base G/B/A bands span ~0.4-5 km at uBaseScale=50).
// We had this OFF (BASE_ERODE=0 → baseDilate = r only), so cumulus towers were
// just the coverage envelope extruded → straight vertical walls. Re-enable it
// as a CENTERED fold (mean-preserving) instead of Schneider's original additive
// dilation, which saturated the whole field and caused the "floater" /
// can't-separate bug (see CLOUD_DEBUGGING_LESSONS). Centered → the FBM bulges
// the shape where high and creases it where low, at the FBM (mid) scales, so
// tower walls billow without re-saturating. Shared → marcher + bake + histogram
// stay in lockstep. BASE_FBM_BILLOW = 0 restores the r-only behaviour.
//   BASE_FBM_BILLOW: mid-billow amplitude. Higher = more medium billowing
//     (pairs with a higher BASE_EROSION_K so it reaches the silhouette).
//   BASE_FBM_BIAS:   pivot ≈ the (Alligator) FBM mean → coverage-neutral.
export const BASE_FBM_BILLOW = 1.2;
export const BASE_FBM_BIAS = 0.4;

// Dilated base shape from the Perlin-Worley core `r` and the Worley-FBM `fbm`,
// both in [0,1]. Legacy erode term (BASE_ERODE, usually 0) + the centered
// mid-scale FBM billow (BASE_FBM_BILLOW). Single source of truth.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function baseDilate(r: any, fbm: any): any {
  return clamp(
    r
      .sub(fbm.mul(float(BASE_ERODE)))
      .add(fbm.sub(float(BASE_FBM_BIAS)).mul(float(BASE_FBM_BILLOW))),
    0,
    1,
  );
}

// ── MULTI-OCTAVE SHAPE (case study #24, 2026-08-07) ─────────────────────────
// MEASURED PROBLEM: `baseDilate` is dominated by ONE octave — `r` (Perlin-Worley,
// grid 4 = 5.6 km cells at BASE_SCALE 45) — with the multi-octave `fbm` entering
// only as a small additive perturbation. The detail volume is used ONLY
// subtractively (billow + fine carve), and a subtractive carve can bite inward
// but cannot ADD octaves to a silhouette. Result: the field's amplitude GROWS at
// every octave (octave step 1.29-1.57 vs a self-similar ~1.0), which is
// mathematically a smooth bell curve with faint texture — the user's "smooth
// rounded pyramids / shaved off by a 3D bell curve". It also makes surface
// roughness PATCHY (p90/p10 = 1.8x across half-cloud windows), because whether a
// patch looks bumpy depends entirely on where the single dominant octave's
// features happen to land — which is why two clouds at the SAME distance differ,
// and one side of one cloud differs from the other.
//
// BASE_FBM_BILLOW was introduced (2026-06-18) as the fix for exactly this and
// MEASURABLY DOES NOT WORK: raising it 1.2 -> 3.0 moves the average octave step
// by 0.01. It only adds the base volume's own bands, which are correlated with r
// and far too small in amplitude.
//
// FOUR NULL RESULTS before this (do not re-run — see case study #24): the
// DETAIL_FADE distance fade, clamp saturation in baseDilate, shader-side G/B/A
// reweighting, and re-baking the volume at higher FBM persistence.
//
// THE FIX: sum the detail volume into the SHAPE as extra octaves, in addition to
// its existing subtractive carve role. MEASURED offline on the real volumes:
//              octave step avg   roughness   patchiness
//   current           1.29         0.0166       1.4x
//   fbm only (no r)   1.19         0.0105       2.4x   <- WORSE, keep r
//   this              1.16         0.0283       1.4x
//   takram ref        1.14         0.0149       1.2x
// Honest limit: patchiness 1.8 -> 1.4, NOT to takram's 1.2. This reduces the
// smooth/bumpy variation; it does not eliminate it.
//
// A/B: set MULTI_OCTAVE_SHAPE = false for the byte-identical previous behaviour.
export const MULTI_OCTAVE_SHAPE = true;
// Weights on the two base-volume terms. r supplies the coherent cloud-body scale
// (dropping it makes patchiness WORSE — measured 2.4x), the flat g/b/a mean
// supplies the mid octaves. The flat (1/3,1/3,1/3) mean replaces Schneider's
// 0.625/0.25/0.125 here specifically because that weighting is what biases the
// composite toward its lowest band.
const MO_R_WEIGHT = 0.5;
const MO_FBM_WEIGHT = 0.5;
// Detail-volume octaves added to the SHAPE. d1 is taken at CARVE_SCALE (the tap
// the billow carve already uses — same position and scale, so it is perfectly
// correlated with the carve, which is what the real field does); d2 is a new,
// finer tap. Both are centered on the detail volume's ~0.4 mean so they bulge
// and crease rather than only filling.
const MO_DETAIL1 = 0.45;
const MO_DETAIL2 = 0.27;
export const MO_DETAIL2_SCALE = 700; // tile = 1000/700 = 1.43 km
// Contrast gain about the 0.4 pivot, matching baseDilate's BASE_FBM_BILLOW.
const MO_GAIN = 1.2;
// ── PROFILE GRADING (2026-08-07, follow-up: "CU break apart into blobs") ──
// Ungraded, the extra octaves fire at FULL amplitude in thin/edge regions where
// the erosion threshold (1 − dimProfile) is already near 1, so any downward
// excursion disconnects material. MEASURED on a synthetic cumulus (3D
// 6-connected flood fill, shape > 0.02):
//                          components   floater mass   octave avg   roughness
//   old (pre multi-octave)     512          0.05%         1.34        0.0150
//   multi-octave ungraded     1158          0.26%         1.16        0.0283
//   AMPLITUDE grade p^0.5      669          0.12%          —            —
//   AMPLITUDE grade p^1.0      571          0.08%         1.20        0.0212
//   FREQUENCY grade p^1.0      498          0.29%         1.21        0.0207
// AMPLITUDE grading (scale BOTH extra octaves by profile^p) is the one that
// fixes it. FREQUENCY grading (keep the coarse octave full at the edges, grade
// only the fine one — the literal Nubis p.109 reading) gives the FEWEST
// fragments but does NOT reduce floater MASS, because the coarse octave is
// exactly what makes an edge lump big enough to see and detach. Fragment COUNT
// and visible-blob MASS are different metrics; mass is what the eye reads.
// p = 1.0 keeps ~75% of the octave-balance win and ~47% of the roughness gain
// while returning floater mass to near the pre-change baseline. Lower it toward
// 0.5 for more edge detail at the cost of more floaters.
const MO_GRADE_POW = 1.0;
// MEASURED E[shape] = 0.6748 vs the old E[baseDilate] = 0.6716, so
// DILATED_BASE_MEAN (0.672) stays valid for BASE_VAR_FADE — no DC step at
// distance (case #18(c): always check a faded term's MEAN).
//
// NOTE the marcher's necessary-condition carve gate needs NO widening: it tests
// `baseShape` itself, and the extra octaves are already inside it, so the
// "carve only lowers" property still holds.
export function baseDilateMulti(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  r: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  g: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  b: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  a: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  d1: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  d2: any,
  // Dimensional profile (coverage × height) at this sample. Grades the extra
  // octaves down toward thin edges so they cannot fragment the body — see
  // MO_GRADE_POW. MUST be the profile at THIS position, not the view ray's
  // (case #21: the self-shadow probe has to read the same field).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dimProfile: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  if (!MULTI_OCTAVE_SHAPE) {
    return baseDilate(r, g.mul(0.625).add(b.mul(0.25)).add(a.mul(0.125)));
  }
  const flat = g.add(b).add(a).div(float(3));
  const grade = clamp(dimProfile, 0, 1).pow(float(MO_GRADE_POW));
  const extra = d1
    .sub(float(BASE_FBM_BIAS))
    .mul(float(MO_DETAIL1))
    .add(d2.sub(float(BASE_FBM_BIAS)).mul(float(MO_DETAIL2)))
    .mul(grade);
  const sum = r
    .mul(float(MO_R_WEIGHT))
    .add(flat.mul(float(MO_FBM_WEIGHT)))
    .add(extra);
  return clamp(
    sum.sub(float(BASE_FBM_BIAS)).mul(float(MO_GAIN)).add(float(0.5)),
    0,
    1,
  );
}

// Compile-time toggle. true = tile-&-offset; false = the original warp path
// (each call site keeps its original code under `else`).
//
// 2026-06-16: set FALSE — tile-&-offset was validated (round billows, no
// tiling) but cost 60→15 fps in near-orbit (4× base/carve taps on long ray
// chords) and showed square-grid edges in low coverage. Decision: ACCEPT the
// high-altitude tiling and run the cheap warp-off path (this flag false +
// WARP_AMPLITUDE/WARP_AMPLITUDE_MIRROR = 0 → single tap, round blobs, no
// shear). The detile scaffolding is kept behind this flag because it becomes
// viable if the volumetric→overlay crossfade is ever lowered (small footprint
// → affordable). See VOLUMETRIC_CLOUDS_SHAPE_PLAN.md "Anti-tiling reality
// check (2026-06-16)".
export const USE_DETILE = false;

// Tile size in SCALED units (1 unit = 1000 km). 0.02 = 20 km ≈ the base
// volume's tile period (1000/uBaseScale at uBaseScale=50). Empirical sweet
// spot from /dev/cloud-slice: ~20 km (breaks tiling, few straight edges).
export const DETILE_TILE = 0.02;
// Blend-band half-width in tile fraction [0..0.5]. 0.5 = full bilinear blend
// across the whole tile (fewest straight-grid edges; no single-tap interior).
export const DETILE_BLEND = 2.0;
// Per-tile offset range (scaled units). Must be ≫ DETILE_TILE so the hashed
// phase is effectively random; small enough to keep texcoord precision sane.
export const DETILE_OFFSET = 1.0; // 1000 km = 50 tile periods

// Stable hashed per-tile offset: Dave Hoskins hash33 (sin-free → no precision
// collapse at the large integer tile indices we hit at planet scale, unlike a
// sin-based hash). Returns a vec3 offset in scaled units.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function detileOffset(cell: any): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let p3: any = fract(
    vec3(cell.x, cell.y, cell.x.mul(0.7).add(cell.y.mul(0.37))).mul(
      vec3(0.1031, 0.103, 0.0973),
    ),
  );
  p3 = p3.add(dot(p3, p3.yxz.add(33.33)));
  const r = fract(p3.xxy.add(p3.yxx).mul(p3.zyx)); // vec3 in [0,1)
  return r.sub(0.5).mul(float(DETILE_OFFSET));
}

// Blend a per-position scalar `fn(pos)` across the 4 surrounding tiles, each
// sampled at its own rigid offset. `fn` is invoked 4× (it builds its own
// texture taps); pass the SAME Earth-space scaled position `p` in the renderer
// and the bake so a given world point lands on the same tile → same offset.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function detileBlend(p: any, fn: (pos: any) => any): any {
  if (!USE_DETILE) return fn(p);
  const h = vec2(p.x, p.z).div(float(DETILE_TILE));
  const cell = floor(h);
  const fr = fract(h);
  const wx = smoothstep(
    float(0.5 - DETILE_BLEND),
    float(0.5 + DETILE_BLEND),
    fr.x,
  );
  const wy = smoothstep(
    float(0.5 - DETILE_BLEND),
    float(0.5 + DETILE_BLEND),
    fr.y,
  );
  const s00 = fn(p.add(detileOffset(cell)));
  const s10 = fn(p.add(detileOffset(cell.add(vec2(1, 0)))));
  const s01 = fn(p.add(detileOffset(cell.add(vec2(0, 1)))));
  const s11 = fn(p.add(detileOffset(cell.add(vec2(1, 1)))));
  return mix(mix(s00, s10, wx), mix(s01, s11, wx), wy);
}
