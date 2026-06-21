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
