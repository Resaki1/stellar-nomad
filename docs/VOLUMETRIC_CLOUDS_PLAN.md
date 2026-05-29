# Volumetric Clouds — Nubis-tier Roadmap

Path to AAA-grade volumetric clouds on Earth (and later other planets), targeting
**photoreal, shipped 2.5D Nubis quality** as seen in Horizon Zero Dawn / Forbidden West,
KSP EVE volumetrics, RDR2, and Star Citizen.

Reference: Andrew Schneider, *"Real-Time Volumetric Cloudscapes of Horizon: Zero Dawn"*,
SIGGRAPH 2015 / GDC 2017. Schneider's HZD-era 2.5D Nubis is the canonical
implementation we're adapting; everything below is that algorithm reworked for WebGPU + TSL.

We are explicitly **not** targeting Nubis³ (Burning Shores 2023) — that requires an offline
Houdini NVDF authoring pipeline, BC6/BC1-compressed 3D voxel grids per cloudscape,
sphere-traced SDFs, and pre-baked voxel-based lighting. Different architecture, different
tooling, much more memory. HZD-era 2.5D is photoreal and shipped, and is the right target
for a browser engine.

**Order of priorities (per user direction):** quality first. Performance is a follow-up
phase once the look is right. The cost map at the end is qualitative, not a budget.

---

## The Nubis algorithm in 60 seconds

For each pixel, fire a primary ray. Find where it enters and exits the cloud altitude
slab (an annular spherical shell ~1–14 km above the planet surface). Step along the ray
inside the slab. At each step:

1. **Sample density** = function of weather-map coverage, an altitude-and-cloud-type
   height curve, and 3D noise (base + detail).
2. **Sample direct light** = a short march toward the sun (cone of 6 samples), accumulating
   density to compute Beer-Lambert transmittance, modulated by Henyey-Greenstein phase
   and a powder approximation.
3. **Sample ambient and multi-scatter** = analytic approximations driven by the *dimensional
   profile* (see next section).
4. **Integrate** premultiplied colour and alpha into the pixel along the view ray.
5. **Choose the next step size** adaptively: long steps in empty space, short steps inside
   cloud bodies.
6. **Stop** when transmittance is below a threshold or the ray exits the slab.

Off-frame, animate UVs by wind drift; carve organic motion with curl noise advection.

For temporal reconstruction (Phase D), only render 1 in 16 pixels per frame and reproject
the rest from the previous frame's history buffer.

---

## The Nubis density and lighting model

This is the **central abstraction the previous version of this plan was missing**. The
algorithm is most legible if we organise it around one concept: the *dimensional profile*.

### Dimensional profile

A smooth 3D scalar field, range `[0, 1]`, that **increases toward the interior** of a
cloud body. It is *distinct from the detail noise*. Two ways to build it:

- **Analytic (HZD 2015 / our target)**: reconstructed in the shader from a 2D weather
  map (coverage) and a 1D vertical curve (height profile per cloud type):

  ```
  profile = coverage(uv) × heightProfile(altitude01, cloudType)
  ```

- **Voxel (Nubis³ 2023)**: authored in Houdini, stored as a low-res 3D NVDF. Out of scope
  for this plan.

### Density (Schneider's value erosion)

```
shape           = remap(baseSample.r, -(1 - baseFbm), 1, 0, 1)        // multi-octave shape
shape          *= profile                                              // shape lives where profile is non-zero
noiseComposite  = mix(billowyNoise, wispyNoise, cloudType_at_uv)
heightFraction  = (alt - cloudBottom) / (cloudTop - cloudBottom)
detailMask      = mix(detailFbm, 1 - detailFbm, saturate(heightFraction × 10))
density         = remap(shape, detailMask × detailMul, 1, 0, 1) × densityScale
```

Two things to notice:

- The detail erosion mask flips with **height**, not density. Bottom of cloud → subtractive
  billowy noise (rounded undersides). Top of cloud → subtractive wispy noise (feathery tops).
  This is what gives clouds anatomy.
- The detail mask is keyed by the **cloud type** (billowy for cumulus, wispy for stratus),
  read from the weather map.

### Lighting driven by profile

The profile is not just a density scaffold — it's also a **probability field for light
transport**. Several Nubis lighting components fall out of it directly:

- **Direct light** = `HG(view·sun) × exp(-sumDensitySun × k)` — Beer-Lambert along the
  sun march.
- **Powder** = `1 - exp(-density × 2k)`, applied to direct light only, **before** the
  phase function. Models how thin cloud edges back-lit by the sun look brighter.
- **Ambient** = `pow(1 - profile, 0.5) × skyColor` — the *outward* gradient acts as a
  probability that sky light reaches the sample. High at edges, low in cores.
- **Multi-scatter** = `profile × exp(-sumDensitySun × k_ms)` — the *inward* gradient acts
  as a probability that sun light, having bounced multiple times, has reached the sample.
  High in cores, drops off at edges. This is the "inner glow" thunderhead effect.
- **Detail-noise frequency blend** = low-frequency noise where profile is high (rounded
  cores), high-frequency where profile is low (feathery edges). Mimics real cloud anatomy
  where billows are larger near the centre and finer near the surface.

Plug these into the integrator:

```
ambient   = pow(1 - profile, 0.5) × skyColor
ms        = profile × exp(-sumDensitySun × kMS)
direct    = HG(cosTheta) × powder × exp(-sumDensitySun × kDirect) × sunColor
inscatter = direct + (ambient + ms) × density
```

### Why this matters

Earlier versions of this plan combined `coverage × height × noise` into one density
expression and computed lighting separately from a single density value. That collapses
the profile and the noise into one number, which loses the "smooth core, eroded surface"
gradient that all of Nubis's lighting depends on. The visible symptom is uniformly grey,
flat-shaded cloud bodies — the speckle look — rather than sunlit tops and shadowed
undersides with internal glow.

### Coordinates

- Profile, density, and noise are all sampled in **planet-local space** (rotation-aware).
  Weather-map UV is the horizontal-plane projection (sphere → equirect).
- `altitude01` is the normalised height inside the slab.
- All cosine terms (sun direction, view direction, up vector) are computed against
  planet-local up at the sample point, not screen-space.

---

## Reference targets (visual fidelity)

The four screenshots in `docs/VolumetricCloudReferences/ExampleScreenshots/` are the
quality bar. They share a recipe (≈ Schneider 2015), differ only in tuning:

- **Star Citizen (orbit-to-surface)**: dense stratocumulus deck with regional cloud-type
  variation; tall cumulus columns visible against the planet limb.
- **RDR2**: convincing cumulus with sunlit tops and shadowed undersides, soft silver-lining,
  internal density variation.
- **KSP EVE**: same recipe, plus curl-noise advection and STBN blue-noise jittering for
  temporal stability — the closest in spirit to what we're building.
- **Nubis (HZD)**: the original, with the cleanest example of profile-driven multi-scatter
  glow.

If our render ever diverges qualitatively from this set (uniform speckle, flat 2D bands,
mirrored shapes, fixed silhouettes, no parallax), something below this line is wrong, not
the plan.

---

## Status snapshot

### Current state (2026-05-29, end of Phase D implementation session)

**Phase D** complete (D1–D8 landed):
- D1: STBN spatiotemporal blue-noise dither replaces `fract(sin(...))` hash
  in the marcher's tStart jitter. 128 × 128 × 64 R8 atlas from KSP-EVE.
- D2: Sparse 1/16-resolution marcher target with Bayer 4×4 deterministic
  sub-pixel schedule.
- D3: Full-resolution reconstruction pass — fresh path blends new marched
  sample with reprojected history (FRESH_ALPHA = 0.3, raw — not clamped —
  history for genuine temporal averaging). Stale path samples variance-
  clamped history.
- D4: YCoCg variance clamp using 3×3 sparse-RT fresh neighbourhood.
- D5: Full-res ping-pong history RT (RGBA16F).
- D6: Disocclusion via off-screen check + variance clamp (motion+alpha
  heuristic dropped).
- D7: Origin-shift correction for floating-origin reprojection. Already
  landed as prerequisite.
- D8: Marcher quality lift — cone-march 3 → 6 taps (no compensation
  multiplier); first-hit threshold 0.01 → 0.0001 (less binary aliasing).

**Phase D close-out diagnostics (2026-05-27/29)** tested and ruled out
several suspects for residual thin-cloud-region speckle:
- Detail erosion (uDetailErosion 0.0 → 6.0 tested) — not the source.
- Per-voxel altPerturb hash — not the source.
- First-hit threshold gating (lowered from 0.01 → 0.0001) — minor improvement.

Residual noise traced to **MC integration variance** at low-density
cloud regions (thin cloud, silhouettes). This is fundamental to single-
pass volumetric rendering with the marcher's per-pixel sample budget.
Improvements require either:
- More samples per ray (smaller dtSkip / dtDense, more MAX_STEPS) — perf cost
- Spatial smoothing post-pass — softens edges
- Higher-resolution noise volumes (Phase A2 extension) — memory cost
- Reference-quality only achievable with offline NVDF voxel pipeline (Nubis³,
  explicitly out of scope per plan top)

See `CLOUD_DEBUGGING_LESSONS.md` case study #7 for the full diagnostic
session and meta-lessons.

### Phase D shipped tuning constants

| Constant | Value | Role |
|---|---|---|
| `BAYER_4X4` schedule | 16 entries | 1/16 sub-pixel selection |
| `FRESH_ALPHA` | 0.3 | Temporal blend weight (38% input variance steady-state) |
| YCoCg padding | 10% | Variance clamp slack |
| Sparse RT scale | 1/4 × 1/4 | 16× pixel-count reduction |
| Cumulus pattern smoothstep | (0.15, 0.85) | Widened from (0.35, 0.65) for less binary masking |
| Cumulus pattern distance fade | 5 km → 80 km | Fades to no-modulation at distance to prevent aliasing |
| First-hit threshold | 0.0001 | Lowered from 0.01 to soften binary detection |
| Cone taps | 6 (was 3) | Full stratified low-discrepancy kernel |
| `MAX_PRIMARY_STEPS` | 96 (unchanged) | Slab coverage at 500m skip step |
| `STBN_PERIOD_XY` | 128 | Spatial period of dither atlas |
| `STBN_PERIOD_Z` | 64 | Temporal slice count |

### Pre-Phase-D state (2026-05-26, end of Phase B implementation session)

**Phase A** complete:
- 128³ RGBA8 base volume (Perlin-Worley R + 3 Worley FBM octaves GBA)
- 32³ RGB detail volume (Worley FBM, used for high-frequency erosion)
- Both procedurally generated at boot from `noiseVolumes.ts` (no asset imports)
- 64³ curl-noise volume deferred to C5

**Phase B** complete:
- B1: Three-type vertical density profile (stratus/stratocumulus/cumulus) mixed
  by cloudType
- B2: cloudType derived procedurally from `smoothstep(0.4, 0.8, coverage)`
- B3: Type-driven detail FBM mix (billowy vs wispy via channel reweight; full
  curl-warped wispy deferred)
- B4: Schneider value erosion with explicit `profile = coverage × heightProfile`
  as first-class shader local
- B5: Profile-driven lighting with separate sun/sky color split:
  `L = sunColor × (direct + ms) + skyColor × ambient`

**Beyond-plan structural additions** that landed during Phase B:
- **Procedural cumulus pattern overlay**: `coverage = coverageRaw × smoothstep(0.35, 0.65, baseVolume.g_at_km_scale)`.
  Creates real coverage-zero gaps between cumulus bodies that linear modulation
  could never produce.
- **Distance-falloff detail layer** (Schneider's canonical LOD trick): detail
  erosion threshold is multiplied by
  `detailStrength = 1 - smoothstep(5km, 80km, t)` per dense voxel.
  Detail features at ~60m visible at close range, fade out at orbital to
  prevent grain aliasing.
- **Decoupled cone-march density**: `CONE_DENSITY = 3000` hardcoded constant
  instead of scaling with `uDensityMul`. Lets primary density be high (for
  opacity) without making cone-march absorb everything.

**Fullscreen-pass migration** completed earlier in the session timeline.
Half-res HalfFloatType cloud RT, premultiplied alpha, bilinear upsample
composite, TAA reprojection via tFront, planet-occlusion clamp from day 1.

**Phase D prerequisite — origin-shift reprojection (2026-05-27)** completed
ahead of full Phase D. The world origin slides every render frame to follow
the ship (see `Spaceship.tsx`), so consecutive frames use different
scaled-world coordinate systems. The reprojection now adds
`(currentOriginKm - prevOriginKm) * SCALED_UNITS_PER_KM` to the world hit
point before multiplying by the previous-frame view-projection. Without
this, every TAA blend was geometrically wrong by ship-displacement-per-frame
— visible as velocity-proportional smear at high speed. See
`CLOUD_DEBUGGING_LESSONS.md` case study #6.

### Current tuning constants (representative — see code comments for rationale)

| Constant | Value | Role |
|---|---|---|
| `uDensityMul` | 140000 | Primary cumulus opacity |
| `CONE_DENSITY` | 3000 | Cone-march absorption (decoupled from primary) |
| `uDetailErosion` | 0.2 | Gentle silhouette nibbling (coverage threshold does main carving) |
| `uDetailScale` | 500 | ~60m detail features (with distance falloff) |
| `uBaseScale` | 50 | 20km base-volume period, ~km-scale macro shape |
| `MS_COEF` | 0.5 | Sharp multi-scatter falloff for top-bright/bottom-dim contrast |
| `HG_G` | 0.1 | Nearly isotropic phase, minimises view-direction gradient |
| `sunColor magnitude` | 12 | Cumulus tops reach AgX 0.85 |
| `skyColor` | (0.3, 0.5, 1.0) × 2 | Saturated cool blue for shadow undersides |
| `skylight` | 0.15 | Low ambient floor for dramatic sunlit/shadow contrast |
| Cone taps | 3 (was 6) | Halved for perf at indices 0/2/4 with 2× contribution |

### Visible characteristics

Cumulus reads as discrete 3D bodies with:
- Visibly opaque cores (alpha > 0.99 in 3-4 dense steps)
- Soft wispy edges (alpha < 0.7 at periphery — realistic cumulus fringes)
- Bright sunlit tops, cool blue shadow undersides
- Clear gaps between cumulus bodies (visible sky-blue / atmosphere through)
- Moderate within-cloud lighting variation driven by cone-marched `ms`

Not yet matching Star Citizen / Nubis reference quality. Gaps to reference
(in priority order):
1. **Higher noise volume resolution** would unlock per-pixel detail at close
   range that's currently smoothed by trilinear interpolation.
2. **Curl-noise advection (C5)** would add organic flow and twist that makes
   cumulus look "alive".
3. **Temporal accumulation (Phase D)** would clean up per-pixel noise variance.
4. **More sophisticated cone-march** (full Schneider density at each tap)
   would give more dramatic per-voxel sun absorption variation.

### Active visible characteristics — not bugs, but known limits

- View-direction asymmetry minimised but not zero (HG_G=0.1 gives ~2× phase
  ratio). Acceptable; silver-lining effect lost as trade-off.
- Within-cloud variation visible but subtle; doesn't read as "dramatic 3D
  shading" like references. Limited by noise resolution + cone-march
  resolution.

The 2026-05-06 list of visible defects (inverted terminator, speckle, no
internal shading) is largely resolved or no longer applicable in current
form. See `CLOUD_VISIBLE_ISSUES.md` end-of-doc for updated status.

### Files involved

| File | Purpose |
|------|---------|
| `src/components/celestial/bodies/earthClouds.ts` | Marcher source / shell-era plumbing. Migrating to fullscreen pass. |
| `src/components/celestial/bodies/earth.ts` | Surface shader; owns `uVolumetricBlend`; surface flat overlay. |
| `src/components/celestial/bodies/cloudNoise.ts` | 64³ Worley generator + mip chain. Will become `noiseVolumes.ts`. |
| `src/components/space/cloudFullscreenPass.ts` (planned) | New fullscreen quad scene + per-frame uniform updates. |
| `src/components/space/SpaceRenderer.tsx` | Multi-pass orchestration: cloud RT, composite, postFX. |
| `src/components/space/renderLayers.ts` | `CLOUD_LAYER` enum (will be removed post-migration). |

---

## Architecture overview (post-migration)

```
┌─────────────────── Frame ───────────────────┐
│                                             │
│  scaledScene  → rt (full-res, depth)        │  Pass 1: planets, skybox, stars
│                  ↑ no clouds                │
│                                             │
│  cloudFullscreenPass → cloudRt              │  Pass 2: fullscreen quad ray-march
│                  premul α, planet-occluded  │
│                                             │
│  cloudRt → rt (composite, ONE/1-α)          │  Pass 3: bilinear / bilateral upsample
│                                             │
│  localScene → rt (depth-cleared)            │  Pass 4: ship, asteroids, beam
│                                             │
│  pipeline.render() → canvas                 │  PostFX: bloom + tonemap
│                                             │
└─────────────────────────────────────────────┘
```

The Nubis temporal layer slots **between Pass 2 and Pass 3** as a history-RT ping-pong.

### Marcher contract (non-negotiable from day 1)

The fullscreen pass marcher must, in this order:

1. Reconstruct the world-space ray from screen UV via inverse view-projection.
2. Transform into planet-local space via `uPlanetInverseModel`.
3. Compute slab entry/exit from the analytic ring intersection, with the inside-inner-shell
   branch for camera-below-1km cases.
4. **Clamp ray exit at the planet surface intersection** (sphere of radius
   `PLANET_RADIUS_KM`). If the planet entry comes before the slab entry, output
   alpha = 0. This prevents rays from sampling cloud volume on the antipode and is
   what causes the "mirrored shapes between two shells" symptom when omitted. This is
   **required from the first version** of the fullscreen marcher, not deferred.
5. March the (possibly clipped) slab segment.
6. Output `(R, G, B, alpha)` premultiplied, plus `t_front` (front-of-cloud distance) packed
   into alpha or a secondary channel — needed for Phase D reprojection and Phase E3 aerial
   perspective.

---

## Gap analysis — current vs Schneider 2015

| Subsystem | Schneider 2015 | Current (approx.) | Gap |
|---|---|---|---|
| Base volume | 128³ RGBA: Perlin-Worley + 3 Worley FBM octaves | 64³ R: single Worley | **Big** |
| Detail volume | 32³ RGB: 3 Worley FBM octaves at high freq | none | **Big** |
| Curl volume | 64³ RGB curl noise for advection | none | Medium |
| Weather map | RGBA: coverage, type, height bias, wetness | R only (coverage) | Medium |
| Profile | `coverage × heightProfile(alt, type)` as first-class | implicit, conflated with noise | **Big** |
| Density | Schneider value erosion with height-driven detail mask | `shape × cov × heightCurve − densityMaskedDetail` (density-driven) | **Big** |
| Type-driven detail blend | mix(billowy, wispy, type) per sample | single detail noise | **Big** |
| Phase | HG (optional dual-lobe / Mie LUT for limb halo) | HG g=0.6 | Tiny |
| Powder | `1 - exp(-density · 2k)` on direct only, before phase | active, formula not pinned | Small |
| Multi-scatter | profile-driven probability field (Nubis 2018+) or N-octave HG | Wrenninge octave hack | Small–Medium |
| Ambient | `pow(1 - profile, 0.5) × skyColor` | flat ambient | Small |
| Light march | 6 cone samples, multi-octave, blue-noise jitter | 3 linear samples | Medium |
| Primary march | 64–128 adaptive | 16 fixed | **Big** |
| Tile classification | coarse 2D pre-pass marks empty/edge/dense tiles | per-fragment guard only | Medium |
| Animation | Curl-warped UVs + UV scroll | static | Medium |
| **Temporal** | Bayer 4×4 1/16 reconstruction + history reproject | None | **Huge** |
| Upsample | Depth-aware bilateral (or 1:1 post-temporal) | Bilinear | Small post-D |
| Surface shadows | Sun-projected shadow RT | 2-tap surface trick | Small |
| Atmosphere coupling | Aerial perspective fog into clouds | None | Small |
| Cloud-terrain interaction | density clipped to terrain height | None | **Big** for landings |

Big/Huge gaps are what's keeping us short of the reference shots. Items in **Big** map
roughly 1:1 to phases A–C below; **Huge** is Phase D.

---

## Phase A — Noise volumes

**Goal**: replace the single 64³ Worley with the full Nubis noise pipeline. Closes ~40 %
of the visual gap on its own.

### A1. 128³ RGBA8 base volume

Refactor `cloudNoise.ts` → `noiseVolumes.ts`, exporting `getCloudBaseVolume()`,
`getCloudDetailVolume()`, and `getCurlVolume()`.

- **R channel**: Perlin-Worley combination. `pwl = remap(perlin, 0, 1, worley, 1)`. This
  is the formula from the Schneider 2015 paper. It gives the base its bumpy-but-puffy
  shape; pure Worley alone is too cellular.
- **G channel**: Worley FBM at base frequency (3 octaves, lacunarity 2, gain 0.5).
- **B channel**: Worley FBM at 2× base frequency.
- **A channel**: Worley FBM at 4× base frequency.
- All inverted (`1 - distance`) and tileable via the existing wrap-around `((n % GRID) + GRID) % GRID`.

Memory: 128³ × RGBA8 = 8 MB. Generation cost: ~200–400 ms one-time at boot. Move into a
deferred chunk after first frame so it doesn't block startup. Keep the manual mip chain.

### A2. 32³ RGB detail volume

`getCloudDetailVolume()` — small, high-frequency.

- **R/G/B**: 3 octaves of Worley FBM at progressively higher frequency. Tiles aggressively.
- 32³ × RGB8 = 96 KB. Fits in L1 cache effortlessly.

### A3. 64³ RGB curl-noise volume

For organic flow advection (used in C5).

- Curl noise = `∇ × noise3D`. Divergence-free vector field; sampled positions appear to
  swirl rather than scroll uniformly.
- 64³ × RGB8 = 768 KB.

### A4. Wire all three volumes into the fullscreen marcher

Pass `baseVolume`, `detailVolume`, `curlVolume` as `texture3D` uniforms.

### A5. Sample base correctly (Schneider remap)

```ts
const baseSample = texture3D(baseVolume, p.mul(uBaseScale));
const baseFbm = baseSample.g.mul(0.625)
  .add(baseSample.b.mul(0.25))
  .add(baseSample.a.mul(0.125));
const shape = remap(baseSample.r, baseFbm.oneMinus().negate(), float(1), float(0), float(1));
```

This is the textbook Schneider remap — it keeps the Perlin-Worley macro shape but
modulates its low-frequency dynamic range by the FBM tail. Use a `remap` helper
(`(v - inMin) / (inMax - inMin) × (outMax - outMin) + outMin`).

### A6. Detail erosion with height-driven mask (Schneider recipe)

```ts
const heightFraction = saturate((alt - bottom).div(top.sub(bottom)));
const dilateAmount = saturate(heightFraction.mul(10.0));
const detailFbm = detailSample.r.mul(0.625)
  .add(detailSample.g.mul(0.25))
  .add(detailSample.b.mul(0.125));
const detailMask = mix(detailFbm, detailFbm.oneMinus(), dilateAmount);
```

The mask flips from `detailFbm` (subtractive billows) at the base to `1 - detailFbm`
(subtractive wisps) at the top. **This is the key fix from the previous version of this
plan**, which used a density-driven edge mask and produced uniform erosion.

### A7. Combine into density (Phase B integrates with profile)

The combined density formula lives in Phase B once the dimensional profile is built.
Until then, an interim test using a flat profile is acceptable for visual sanity-checking
the noise pipeline alone.

**Risk**: noise volume tuning is sensitive — base scale, detail scale, FBM weights all
matter. Budget half a day per pass for visual tuning. Keep tuneable as uniforms while
iterating.

---

## Phase B — Density and lighting model

**Goal**: introduce the dimensional profile as a first-class quantity, drive both density
and the lighting approximations from it. This is the difference between "noise blobs that
look 2D" and "cloud bodies with anatomy".

### B1. Cloud-type-aware vertical profiles

The current symmetric height curve (`hRamp · hFade`) is the wrong shape. Real clouds
aren't symmetric: stratus is flat, stratocumulus has a soft bottom and a smoother top,
cumulus has a strong bottom-up bulge with a higher anvil.

Define analytic profiles per type:

```ts
function densityHeightProfile(altitude01, cloudType) {
  const stratus = saturate(remap(altitude01, 0,    0.1,  0, 1))
                * saturate(remap(altitude01, 0.2,  0.3,  1, 0));
  const stratocumulus = saturate(remap(altitude01, 0,    0.25, 0, 1))
                      * saturate(remap(altitude01, 0.45, 0.65, 1, 0));
  const cumulus = saturate(remap(altitude01, 0,    0.4,  0, 1))
                * saturate(remap(altitude01, 0.6,  0.95, 1, 0));
  return mix(mix(stratus, stratocumulus, smoothstep(0,   0.5, cloudType)),
             cumulus,                  smoothstep(0.5, 1,   cloudType));
}
```

`cloudType ∈ [0, 1]` is sampled from the weather map (B2).

### B2. Weather map structure and cloud-type encoding

Two stages:

- **Stage 1 (cheap, do first)**: derive `cloudType` procedurally from `coverage`.
  `cloudType = smoothstep(0.4, 0.8, coverage)` — denser regions read as cumulus, sparser
  as stratus. Free, no asset work, gives type variation.
- **Stage 2 (asset work, defer until tuning needs it)**: re-author the Earth weather map
  to RGBA. R = coverage, G = type, B = height-offset bias (regional cloud-deck altitude
  variation), A = wetness (used in Phase E for tinting / rain). The current
  `earth_clouds_8k.ktx2` is single-channel; needs re-export. Do not block on this for
  visual completion.

Wetness is on the spec but the *only* current consumer is desaturation tinting in B5;
deciding whether to author it is a Phase E decision, not Phase B.

### B3. Type-driven detail blend (billowy vs wispy)

Schneider's detail noise is *not* a single texture — it's a **mix** keyed by cloud type:

```ts
const billowyNoise = detailFbm;                     // existing detail volume FBM
const wispyNoise   = curlAdvected(detailFbm);       // detail FBM warped by curl noise
                                                    // (or a separate FBM channel)
const noiseComposite = mix(billowyNoise, wispyNoise, cloudType);
```

Cumulus regions get billowy detail; stratus gets wispy. Without this, all clouds share one
anatomy and the variety in the reference shots can't appear. Implementation note: with our
single detail volume, the wispy variant can be the same FBM warped by the curl volume
sampled at a lower frequency — cheap, no extra texture.

### B4. Final density via Schneider value erosion

Build the dimensional profile and apply value erosion:

```ts
const profile        = coverage.mul(densityHeightProfile(altitude01, cloudType));
const shape          = baseShape.mul(profile);                             // see A5 for baseShape
const detailMaskAmt  = detailMask.mul(uDetailErosion);                     // see A6
const density        = remap(shape, detailMaskAmt, 1, 0, 1).mul(uDensityMul);
```

Make `profile` a top-level shader local — pass it into B5 lighting unchanged. **Do not
recompute it** for lighting; reuse the same value to ensure consistency between density
and lighting.

### B5. Lighting approximations from profile

Replace the current ambient + multi-scatter with profile-driven probability fields:

```ts
// in the integrate-step:
const ambient = profile.oneMinus().pow(0.5).mul(uSkyColor);
const ms      = profile.mul(exp(sumDensitySun.negate().mul(uMSCoef)));
const direct  = phaseHG(cosTheta, uPhaseG)
                 .mul(powder)
                 .mul(exp(sumDensitySun.negate().mul(uDirectCoef)))
                 .mul(uSunColor);

const radiance = direct.add(ambient.add(ms).mul(density));
```

- `powder = 1 - exp(-density × 2 × uPowderK)` — applied to direct only, **before**
  multiplication by phase function. Drop powder when sun is behind camera (cosTheta < 0).
- `uPhaseG = 0.6` to start; tune.
- `uMSCoef`, `uDirectCoef`, `uPowderK` exposed as uniforms for tuning.

This replaces the Wrenninge octave-hack multi-scatter currently in use. Wrenninge's hack
works but undershoots the inner-glow effect that makes thunderheads look right; the
profile-driven MS is the Nubis 2018+ technique and gives cleaner shapes.

**Performance impact of B**: math-only after A. ~+0.05 ms.

---

## Phase C — March quality

**Goal**: fewer wasted samples in clear sky, more samples where it counts (inside cloud
bodies). The current 16-step uniform march is the proximate cause of "blurry close-up"
and contributes heavily to the speckle problem.

### C1. Coverage tile-classification pre-pass

Before the heavy fullscreen march, run a *cheap* classification pass at 1/8 resolution:
for each tile, sample `coverage(uv)` once at the tile's view-ray midpoint. Three classes:

- `coverage < 0.05` → **empty tile**, skip the march entirely (composite as zero alpha).
- `coverage > 0.95` AND density-along-mid-ray saturates → **dense tile**, march with
  reduced steps and early-out aggressively.
- otherwise → **edge tile**, full march.

Output: a 1/8-res R8 mask + an indirect dispatch mask. Most clear-sky pixels become near-free.

This is what shipped Nubis-style implementations do at the screen-tiling level. It
combines well with C2/C3 and is the single biggest perf-and-quality win after Phase A/B.

### C2. Adaptive two-state march

Per-ray state machine. Both states share the same compile-time-constant `MAX_STEPS`
(WebGPU/TSL requirement); termination is via `Break`.

- **Skip mode** (default): step `dt_long` (~2× current). Sample only the *cheap base
  shape* (coverage × profile, no 3D noise, no detail). If shape > epsilon, transition
  to dense mode at the **next** step, sampling at the shape-detection point with the
  short step (no half-step rewind — it can re-confuse the state machine). Set a 2-step
  "warm-up" counter to prevent flicker on the boundary.
- **Dense mode**: step `dt_short` (~0.5× current). Full density evaluation
  (base + detail + erosion). Integrate. If `density < epsilon` for N consecutive steps,
  return to skip mode.

```ts
const stepMode = float(0).toVar(); // 0 = skip, 1 = dense
const t = tStart.toVar();
const consecEmpty = float(0).toVar();
const transmittance = float(1).toVar();

Loop(MAX_STEPS, () => {
  If(t.greaterThan(tExit).or(transmittance.lessThan(0.005)), () => Break());

  const dt = stepMode.equal(0).select(dtLong, dtShort);
  const p = ro.add(rd.mul(t));

  // Cheap shape probe in skip mode
  const baseShape = stepMode.equal(0)
    .select(cheapShape(p), float(1));  // skip detail / coverage in dense state

  If(stepMode.equal(0).and(baseShape.greaterThan(eps)), () => {
    stepMode.assign(1);
    consecEmpty.assign(0);
  }).ElseIf(stepMode.equal(1), () => {
    const density = fullDensity(p);   // full Schneider value-erosion + profile
    If(density.greaterThan(eps), () => {
      consecEmpty.assign(0);
      integrateSample(density, p, transmittance, /* radiance accum */);
    }).Else(() => {
      consecEmpty.addAssign(1);
      If(consecEmpty.greaterThan(2), () => stepMode.assign(0));
    });
  });

  t.addAssign(dt);
});
```

`MAX_STEPS = 96`. Real cost is gated by adaptive stepping + early termination.

### C3. Distance-scaled step length

Step lengths grow with `√(distance from camera) × k` (Nubis formula). Distant samples
don't need short steps because their projected screen footprint is large and detail noise
isn't visible. Combine with C2 by scaling `dt_long` and `dt_short` by this factor.

### C4. Cone light march

Replace the linear 3-step march with 6 cone samples toward the sun. Each sample is
offset slightly perpendicular to the sun direction; the cone widens with distance:

```ts
const coneOffsets = [ /* 6 stratified directions */ ];
Loop(LIGHT_STEPS, ({ i }) => {
  const stepDist = float(LIGHT_STEP_LEN).mul(float(i).add(0.5));
  const conePerturb = coneOffsets[i].mul(stepDist).mul(uConeRadius);
  const pL = p.add(sunDirLocal.mul(stepDist)).add(conePerturb);
  // accumulate density at pL into sumDensitySun
});
```

The neighbourhood sampling smooths per-pixel transmittance variance, which is what
removes the "speckle" look of a short linear march. The longest sample can drop the
detail noise (cheap multi-octave lighting; Schneider does this).

Jitter the per-frame ray-origin offset using a **STBN texture** (spatiotemporal blue
noise; KSP-EVE ships one as `stbn.R8`). Blue noise averages perceptually well across
frames and pixels — far better than per-pixel `fract(sin(...))` hashes which produce the
incoherent speckle currently visible.

### C5. Curl-noise UV advection

Add curl-noise advection of the **detail noise position**, not the base — base movement
is too obvious:

```ts
const flowVec = texture3D(curlVolume, p.mul(uFlowScale).add(uTime.mul(uFlowSpeed))).rgb
                  .sub(0.5).mul(2);                          // re-centre to [-1,1]
const pDetail = p.mul(uDetailScale).add(flowVec.mul(uFlowAmount));
const detailSample = texture3D(detailVolume, pDetail);
```

Drives `uTime` from sim time at slow rate (≈ 1/300 of camera relative motion). Combine
with a cheap UV scroll (wind-direction × time) on both base and detail for parallax
animation.

### C6. (Deferred / optional) SDF-based step distance

Nubis³ uses a low-res signed-distance field of the cloudscape to set step length
("sphere tracing"). Step grows with the closest empty distance, so empty space is
traversed in one big step.

Out of scope for this plan unless C2's two-state proves insufficient up close. If we
adopt it later: 512×512×64 BC1-encoded SDF with the sphere-trace-safe custom packing
described in the Nubis³ slides. Bake offline.

**Performance impact of C**: hard to predict without profiling — depends heavily on the
tile-classification hit rate. Expect an *increase* over current frame cost in dense
scenes (more total samples) and a *decrease* in clear-sky scenes (tile skip + adaptive
step). Phase D pulls it back hard.

---

## Phase D — Temporal reconstruction (the AAA layer)

**Goal**: render `1/16` of pixels per frame on a deterministic sub-pixel schedule;
reconstruct the other 15/16 via reprojection from a full-res history RT. Cuts per-frame
cloud-march cost by ~16×, which buys the perf headroom for higher-quality marching
(MAX_STEPS 16→64+, LIGHT_STEPS 3→6) at no net cost.

**Why now**: the current every-frame TAA blend in `cloudFullscreenPass.ts` doesn't
reduce per-frame work and produces *velocity-proportional smear* at high speed (the
user-reported symptom). Continuous-TAA mixing 14+ frames of view-dependent radiance
cannot converge cleanly under fast motion. Geometric reconstruction with proper
variance clamping is the canonical fix.

### Cross-engine learnings folded into this plan

Phase D commits to Schneider's HZD-era recipe (1/16 reconstruction, Bayer 4×4 schedule,
per-pixel reprojection, fresh-neighbourhood variance clamp) with two grafts:

- **STBN jitter from KSP-EVE (Blackrack)**: replace `fract(sin(...))` per-pixel hash
  with samples from a 128³ R8 spatiotemporal blue noise atlas. Spatially and temporally
  blue-noise-correlated — perceptually smoother and TAA-friendly. Asset is publicly
  licensed and already in `docs/VolumetricCloudReferences/.../stbn.R8`.
- **YCoCg variance clamp from RDR2**: clamp history in chroma space rather than RGB.
  Less saturation drift on disocclusion; doesn't false-trigger on legitimate dither
  variance the way our current `motionGate × alphaGate` heuristic does.

Star Citizen's aggressive adaptive stepping and RDR2's 2D-cloud-sheets-for-far-range
are interesting but out of Phase D scope — they're Phase C polish and Phase F1
respectively.

### Prerequisites (✅ complete)

- **Camera reprojection** with sub-pixel jitter and history sampling. Done.
- **Origin-shift correction** for floating-origin reprojection (`uOriginShiftScaled`
  in `cloudFullscreenPass.ts`). The world origin slides every frame to follow the
  ship, so consecutive frames use *different* scaled-world coordinate systems for the
  same fixed world point. Without this correction, every-frame slides produce
  velocity-proportional smear regardless of how the rest of D is built. See
  `CLOUD_DEBUGGING_LESSONS.md` case study #6 for the full diagnosis.

### D1. STBN asset + loader

Source: KSP-EVE ships a **128³ R8** STBN volume as `stbn.R8` (raw bytes, 1 MiB).

- Copy to `public/textures/stbn_128.bin`.
- Build a loader in `src/components/celestial/bodies/stbnTexture.ts`:
  ```ts
  export async function loadStbnTexture(): Promise<THREE.Data3DTexture> {
    const bytes = await fetch("/textures/stbn_128.bin").then(r => r.arrayBuffer());
    const tex = new THREE.Data3DTexture(new Uint8Array(bytes), 128, 128, 128);
    tex.format = THREE.RedFormat;
    tex.type = THREE.UnsignedByteType;
    tex.minFilter = tex.magFilter = THREE.NearestFilter;     // STBN is sample-as-is
    tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    return tex;
  }
  ```
- Bind as a sampler uniform in `cloudFullscreenPass.ts` (`uStbn: texture3D`).
- In the marcher (`earthClouds.ts`), replace every dither/jitter site (currently the
  `tStart` jitter on line 431 and any cone-offset jitter) with:
  ```ts
  const stbnSample = texture3D(
    uStbn,
    vec3(
      fragCoord.x.mod(128).div(128),
      fragCoord.y.mod(128).div(128),
      uFrameSlice,  // wraps 0..1 across 128 frames
    ),
  ).r;
  ```
  `uFrameSlice` advances by `1/128` per frame, wrapping. Per-pixel value rotates
  through 128 distinct STBN realisations across the TAA window.
- Verification: visually identical to today on still cameras; smoother on slow pans.

### D2. Sparse marcher target + 1/16 schedule

Replace half-res `cloudRts[2]` (currently `W/2 × H/2`) with sparse `sparseCloudRts[2]`
at `W/4 × H/4` — 1/16 the pixel count.

- Add the canonical Bayer4×4 schedule (best-spread ordering: any 4-frame window covers
  4 spatially separated sub-pixels):
  ```ts
  // Standard Bayer 4×4 ordered-dither matrix. M[y][x] = sequence index 0..15.
  const BAYER_4X4: ReadonlyArray<readonly [number, number]> = [
    [0,0],[2,2],[2,0],[0,2],[1,1],[3,3],[3,1],[1,3],
    [1,0],[3,2],[3,0],[1,2],[0,1],[2,3],[2,1],[0,3],
  ];
  ```
- Each frame, `(sx, sy) = BAYER_4X4[cloudFrameIndex % 16]` picks the sub-pixel slot
  within every 4×4 tile that's marched this frame.
- The marcher's UV reconstruction shifts so each sparse texel samples the correct
  sub-pixel of its full-res 4×4 tile:
  ```ts
  // sparseCoord is in [0, W/4) × [0, H/4).
  // Full-res pixel coord = sparseCoord * 4 + (sx, sy).
  const fullPixel = sparseCoord.mul(4).add(vec2(sx, sy)).add(0.5);
  const fullUv = fullPixel.div(vec2(fullW, fullH));
  ```
- Output: full RGBA into sparseCloudRt. No blend, no history sampling in this pass —
  the marcher purely renders fresh samples now. Reconstruction is its own pass (D3).

### D3. Reconstruction pass (new full-res shader)

A new fullscreen pass between the marcher and the existing composite (pass 3). Inputs:

- `sparseCloudRt` — this frame's freshly marched 1/16-res output
- `historyRt[N-1]` — previous frame's full-res reconstructed output
- `uPrevViewProj`, `uOriginShiftScaled` — already plumbed, reuse
- `uFreshSubPixel` — `(sx, sy)` ∈ [0, 3]² for this frame

For each full-res pixel `(x, y)`:

```ts
const tile = (x >> 2, y >> 2);                   // which 4×4 tile
const localSub = (x & 3, y & 3);                 // which sub-pixel in tile
const isFresh = (localSub == (sx, sy));

// Sparse RT samples the fresh sub-pixel of every tile.
const freshSample = sparseCloudRt[tile];

if (isFresh) {
  output = freshSample;                          // direct copy, no blending
} else {
  // Stale path: reproject and clamp.
  const worldHit = camera.position + rd * freshSample.depth;  // depth proxy from tile's fresh sample
  const prevClip = uPrevViewProj * vec4(worldHit + uOriginShiftScaled, 1);
  const prevUv = prevClip.xy / prevClip.w * 0.5 + 0.5;

  if (prevUv outside [0,1]) {
    output = freshSample;                        // fallback: use the tile's fresh sample
  } else {
    const history = historyRt[N-1].sample(prevUv);
    const clamped = yCoCgClamp(history, sparseNeighbourhood(tile));  // D4
    output = clamped;
  }
}
```

Output: full-res RGBA into `historyRt[N]` (this frame's write target). Feeds the
existing composite pass.

**Depth proxy**: each tile's fresh-sample alpha implicitly encodes whether the tile
had cloud. For v1 we use the tile's `tFront` directly when available (still readable
from `sparseCloudRt` since the marcher computes it per fresh pixel) or fall back to
outer-shell-t — same as today. A separate depth pass for proper history-depth
comparison is **deferred to v2** (MRT is TSL-blocked; see "v2 deferred" below).

### D4. YCoCg variance clamp

Standard 3×3-neighbourhood clamp built from **fresh samples only**: sample the tile
plus its 8 neighbours in `sparseCloudRt` (all of which are fresh this frame, just at
different tiles).

```ts
// Convert each neighbour sample to YCoCg and accumulate min/max bound.
let cMin = vec3(huge), cMax = vec3(-huge);
for (let dy = -1; dy <= 1; dy++) {
  for (let dx = -1; dx <= 1; dx++) {
    const ycocg = rgbToYCoCg(sparseCloudRt[tile + vec2(dx, dy)].rgb);
    cMin = min(cMin, ycocg);
    cMax = max(cMax, ycocg);
  }
}
// Small dilation prevents over-tight bounds.
const pad = (cMax - cMin) * 0.1;
cMin = cMin - pad;
cMax = cMax + pad;

const historyYCoCg = rgbToYCoCg(history.rgb);
const clamped = yCoCgToRgb(clamp(historyYCoCg, cMin, cMax));

// Alpha clamped separately as scalar (YCoCg is 3-channel).
const alphaMin = min over 3x3 neighbourhood;
const alphaMax = max over 3x3 neighbourhood;
const clampedAlpha = clamp(history.a, alphaMin - 0.1*(alphaMax-alphaMin), alphaMax + 0.1*(alphaMax-alphaMin));
```

YCoCg conversion (Karis 2014 / Salvi 2016 convention):

```ts
function rgbToYCoCg(rgb: vec3): vec3 {
  return vec3(
    0.25 * rgb.r + 0.5 * rgb.g + 0.25 * rgb.b,   // Y (luma)
    0.5  * rgb.r              - 0.5  * rgb.b,    // Co (orange-blue)
   -0.25 * rgb.r + 0.5 * rgb.g - 0.25 * rgb.b,   // Cg (green-magenta)
  );
}
function yCoCgToRgb(ycocg: vec3): vec3 {
  const tmp = ycocg.x - ycocg.z;
  return vec3(tmp + ycocg.y, ycocg.x + ycocg.z, tmp - ycocg.y);
}
```

Why YCoCg over RGB: chroma channels (Co, Cg) have lower variance than RGB channels,
so the clamping bound is tighter and rejects more ghosting; luma (Y) has wider
tolerance which avoids killing the TAA blend on luminance variance from dither.

### D5. History RT (full-res ping-pong)

Replace the half-res `cloudRts[2]` with full-res `historyRts[2]` of format
`RGBA16F`. The frame flow becomes:

```
Pass 2a (marcher):       sparseCloudRts[writeIdx]    ← fresh 1/16-res samples
Pass 2b (reconstruct):   historyRts[writeIdx]        ← full-res output
                                + historyRts[writeIdx ^ 1] (prev) for reprojection
                                + sparseCloudRts[writeIdx] for fresh + clamp bounds
Pass 3 (composite):       main RT                     ← existing premul-alpha blend
                                + historyRts[writeIdx]
```

`historyValid` semantics unchanged; gates the blend off for the first frame after
mount, resize, or pass-resume.

### D6. Disocclusion gating (v1)

Two checks only:

1. **Off-screen `prevUv` → drop history**, fall back to tile's fresh sample.
2. **YCoCg variance clamp** → implicit rejection of divergent history.

The current `motionGate × alphaGate` heuristic is **removed**. The variance clamp
covers the same intent more rigorously (it's a *bound*, not a heuristic) and doesn't
false-trigger on dither variance (which contributes equally to fresh and history
samples, so falls inside the bound).

If post-implementation testing shows residual ghosting on close-range silhouette
crossings, re-add explicit depth-comparison gating (v2 — requires the MRT workaround).

### D7. Floating-origin handling

Already done via per-frame `uOriginShiftScaled`. No history-clear required — the
per-frame shift exactly cancels the slide so history reprojection is geometrically
exact regardless of ship velocity.

If we ever do explicit threshold-triggered rebases again (currently dead code per
`worldOrigin.tsx`), the existing `cloudHistoryValid = 0` machinery already
invalidates one frame to allow reconvergence.

### D8. Lift marcher quality

With ~16× headroom from the 1/16 schedule, lift `earthClouds.ts` constants:

- `MAX_STEPS`: 16 → 64 (then iterate to 96 if perf allows)
- `LIGHT_STEPS`: 3 → 6 cone taps
- Remove `CLOUD_RT_SCALE = 0.5` in `SpaceRenderer.tsx` (obsolete; the new sparse RT
  is the resolution drop)

Verify per-frame cost is ≤ pre-Phase-D baseline; ideally well below it.

### v2 deferred items (not blocking initial Phase D landing)

- **True depth-based disocclusion**: separate second pass that outputs `tFront` to a
  depth-only RT. ~1.1× total cost (the second pass runs skip-mode-until-first-hit
  only, no integration). MRT is TSL-blocked per the comment in
  `cloudFullscreenPass.ts:194-202`, so this needs to be a separate fragmentNode +
  pass rather than an MRT output. Adds robustness on close-range silhouette
  transitions that variance clamp alone can miss.
- **Wind-aware reprojection**: when C5 (curl noise) lands, add `windDir × dt` to the
  world-space reprojection point before applying `uPrevViewProj`.
- **Hybrid 2D-far + 3D-near** (RDR2 trick): orthogonal to D; lives under Phase F1
  if we ever need to push render distance beyond what pure 3D march can deliver.

### Verification

- **Orbital static camera**: no per-pixel speckle; cloud edges smooth. STBN + 16-frame
  convergence should converge in <1s of stillness.
- **Slow camera pan**: variance clamp keeps history; no visible ghosting.
- **High-speed flyby (user's current failure case)**: history-off-screen branch fires
  often; image is per-frame STBN noise but *bounded* (no accumulating smear).
- **Cumulus silhouette crossings**: variance clamp rejects history through the edge
  transition. Single-frame disocclusion artefact acceptable (Schneider's HZD ships
  this).
- **Floating-origin slides at all speeds**: handled by origin-shift; verified already
  during the prereq fix.

**Risks**:
- Shader-compile cost grows with the new reconstruction pass branching; Phase F4
  pre-warm becomes mandatory.
- 1/16 convergence visible as a "wash" on disocclusion until the next 16 frames
  refresh; acceptable but worth measuring under typical gameplay motion.
- YCoCg clamp can over-clamp in regions with high HG-driven luma variance; if so,
  pad the Y bound more aggressively or switch to fresh-only-with-padding (Karis
  variant).

---

## Phase E — Polish

### E1. Sun shadow map (Frostbite-style)

Replace the per-pixel cone light march with a precomputed sun shadow map. Once per N
frames (sun moves slowly):

- Allocate a 256² R16F (or R8 with `exp`-encoded extinction) RT.
- Render a sun-positioned orthographic camera looking at planet centre, marching a
  coarse 4–6 step density-only pass through the slab. Output `exp(-tau)` per texel.
- In the main marcher, replace the `LIGHT_STEPS` loop with one texture sample.

Surface shader also samples this for ground shadows (replacing the current 2-tap
trick in `earth.ts`).

256² at planet scale is ~16 km/texel. Plenty for cloud shadows (their natural blur
covers this); 512² if penumbra needs to be sharper.

**Alternative — Nubis³ voxel-based lighting**: precompute summed sun-density into a
3D voxel grid (e.g. 256×256×32). Sample in the main march. Better quality (proper
anisotropic transmittance, long-distance inter-cloud shadows), more memory, more compute
in the precompute pass. Defer unless E1 proves visually insufficient — E1 is what RDR2
ships and the visual bar is met.

### E2. Aerial perspective coupling

Apply atmospheric Rayleigh attenuation to cloud colour based on `t_front`:

```ts
const aerialFog = computeRayleighTransmittance(roLocal, rdLocal, tFront);
col.assign(col.mul(aerialFog).add(rayleighInscatter));
```

This is what makes Earth-from-orbit clouds blend into the atmosphere at the limb. Reuse
the Earth surface shader's existing Rayleigh constants.

### E3. Phase function tuning

Optional dual-lobe HG: `phase = mix(HG(g_forward = 0.8), HG(g_back = -0.3), 0.5)`.
The back-scatter lobe gives the "halo" effect when the sun is behind clouds. Schneider
doesn't use it; add only if visual taste calls for it.

### E4. Bilateral upsample (only if half-res is kept)

Phase D returns clouds to full-res; this is unnecessary. Keep as a fallback for a
future "low-quality" tier where half-res is forced.

---

## Phase F — Productionise

### F1. Generalise to volumetric cloud module + per-planet config

Extract the marcher into `src/components/celestial/shaders/cloudMarcher.ts` and the
fullscreen-pass plumbing into `src/components/space/cloudFullscreenPass.ts`. The
marcher takes a config:

```ts
type VolumetricCloudConfig = {
  innerRadiusKm: number;
  outerRadiusKm: number;
  weatherMap: THREE.Texture;             // R = coverage; later RGBA
  baseVolume: THREE.Data3DTexture;
  detailVolume: THREE.Data3DTexture;
  curlVolume: THREE.Data3DTexture;

  baseScale: number;
  detailScale: number;
  detailErosion: number;
  warpAmount: number;
  densityMul: number;

  phaseG: number;
  phaseGBack?: number;                   // dual-lobe (E3)
  msCoef: number;
  directCoef: number;
  powderK: number;

  ambientColor: THREE.Color;
  sunColor: THREE.Color;
  sunsetTint: THREE.Color;

  cloudTypeProfile: "stratus" | "stratocumulus" | "cumulus" | "auto";
  flowSpeed?: number;

  qualityTier: "low" | "medium" | "high";
};
```

Each planet supplies its own config. Earth: `{ phaseG: 0.6, msCoef: 1.0, sunColor: ... }`.
Venus: `{ phaseG: 0.85, msCoef: 1.5, sunColor: yellow, baseScale: smaller, ... }`.

### F2. Cloud–terrain interaction (essential for landings)

For seamless orbit-to-surface flight, cloud bases that intersect terrain must clip,
and fog should be able to flow through valleys. Without this, cumulus clouds
over a mountain look pasted-on and fog never wraps around terrain features.

Implementation:

- The cloud shader receives the planet's terrain heightmap (the same low-res displacement
  map used for distance-LOD terrain rendering).
- Before sampling cloud density at a point, sample terrain height at that lat/lon. If
  `pointAltitude < terrainHeight`, density = 0.
- Cost: one extra 2D texture tap per density evaluation, gated by altitude check
  (skip when `pointAltitude > maxTerrainAltitude` globally).

This is **quality-critical for the gameplay loop**, not optional polish. Schedule it
before F3 if landings are gating the milestone.

### F3. Quality tiers

Pre-compile three pipeline variants. Settings menu exposes the tier; Jotai atom gates
which material is mounted on the fullscreen quad.

- **Low**: `PRIMARY_STEPS=32`, `LIGHT_STEPS=2`, no curl, no temporal, half-res. Older
  laptops.
- **Medium**: `PRIMARY_STEPS=64`, `LIGHT_STEPS=4`, curl, no temporal, half-res. Default
  mid-tier.
- **High**: `PRIMARY_STEPS=96`, `LIGHT_STEPS=6`, curl, temporal, full-res. M2 Pro target.

### F4. Pre-warm shader compile

The first close approach to Earth currently triggers a one-time TSL compile hitch. Pre-
compile the high-tier pipeline at scene-load time by rendering the cloud pass off-screen
for one frame at boot, so first-actual-use is instant.

### F5. Venus port (validation)

Adapt the system to Venus to validate the config abstraction:

- Full-coverage opaque weather map (procedural; no equirect photo asset).
- Wider slab (50 km).
- Yellow sun tint, higher scatter g.
- Lower detail erosion (Venus clouds are smoother / more uniform).

If Venus needs new config knobs, lift them into the config type.

---

## Approximate cost map (qualitative)

We are explicitly *not* committing to a per-frame budget yet — the goal is the look.
This map exists only to show where the work goes so we know what to optimise once
we have the quality.

- **Phase A** adds 1–3 extra `texture3D` taps per primary step (gated). Increases per-pixel
  cost in cloud-covered regions, no impact on clear-sky pixels.
- **Phase B** is math-only after A. Negligible.
- **Phase C1 (tile classification)** turns most clear-sky pixels into ~zero-cost. *Dominant
  perf win on average scenes.*
- **Phase C2 (adaptive march)** raises peak cost (96 max steps) but lowers average cost
  in mixed scenes via skip mode + early termination.
- **Phase C3–C5 (distance scaling, cone march, curl)** small additions.
- **Phase D** drops *per-frame* cost ~16× by skipping 15/16 marches, paid for by
  history reproject (texture sample + matrix multiply) and variance clamp (3×3 neighbourhood
  read).
- **Phase E1 (shadow map)** is amortised over multiple frames; replaces the per-pixel
  cone march with one tap.
- **Phase F2 (terrain clip)** adds one heightmap tap per density evaluation, gated by
  altitude.

Rough comparison points for sanity:

- Nubis³ on PS5: 2.2–4 ms.
- KSP-EVE on a 3070-class card: 3–5 ms.
- WebGPU on M2 Pro: comparable to a mid-range desktop GPU at 60–80 % efficiency.

A realistic high-tier target is **3–5 ms** for the cloud pass, not 1 ms. Concrete budget
gets set after profiling once the look lands.

---

## Risks & open questions

- **Planet-occlusion clamping is non-negotiable from day 1.** Without ray clamp at
  `PLANET_RADIUS_KM`, downward rays from low altitude sample cloud volume on the antipode,
  producing the "mirrored 2D shapes between two shells" symptom. This goes into the
  marcher contract before any other Phase A work.
- **TSL `Loop` count must be a compile-time constant.** Adaptive stepping is a fixed
  `MAX_STEPS` loop with `Break`. Verified working at 16; should scale to 96 cleanly.
- **WebGPU shader compile cost** scales with branch complexity. Phase C2's two-state
  march and Phase D's reprojection logic both add branches. F4 pre-warm is mandatory.
- **History RT memory**: full-res RGBA HalfFloat at 1440p × 2 ping-pong = ~32 MB VRAM.
  Acceptable.
- **Floating-origin invalidation**: Phase D requires explicit history clear on
  `worldOrigin` rebase events. Hook into the existing atom.
- **STBN texture asset**: we need a 128³ R8 spatiotemporal blue noise volume for jitter.
  Use the publicly available STBN atlas (e.g. Christoph Peters / EVE's `stbn.R8`); ship as
  `public/textures/stbn_128.bin`.
- **Coordinates consistency**: profile, density, lighting, reprojection, terrain clip
  must all operate in the same space (planet-local or scaled-world). Pick one, document,
  enforce in code review.
- **Disocclusion at floating-origin recentre**: rebase invalidates the entire history RT;
  first frame post-rebase shows a 1-frame "low quality" render until the next 16 frames
  repopulate. Document.
- **Cloud-front t precision**: half-float over 14 km slab gives ~0.5 m precision —
  sufficient for reprojection. If push comes to shove, use the auxiliary R32F MRT slot.
- **Variance clamp methodology under 1/16 reconstruction** is subtle; D5 commits to
  fresh-only neighbourhoods but expect tuning iterations.
- **Wetness channel**: encoded in the weather-map spec but not used by anything in this
  plan. Re-evaluate during E2 (aerial perspective): wetness could scale Rayleigh inscatter
  to make rainstorms read bluer. If unused at E2 time, drop it from the spec.
- **Cloud–terrain integration risk**: F2 depends on the heightmap pipeline being readily
  accessible from the cloud shader's planet-local frame. If terrain heights are stored
  in world-space chunks, this becomes a non-trivial sampling problem. Audit before
  scheduling F2.

---

## Implementation order

Phases roughly sequential. A↔B and E1↔E2 are parallelisable. The fullscreen-pass
migration (`CLOUD_FULLSCREEN_MIGRATION.md`) must complete before A's new code paths
land — A1–A6 produce the data, but the consumer is the fullscreen marcher, and the
fullscreen marcher must include the planet-occlusion clamp from day 1.

1. ✅ **Fullscreen migration G1–G5** (separate doc) — completes geometry foundation.
2. ✅ **A1–A6**: noise volumes + Schneider remap + height-driven detail erosion.
3. ✅ **B1–B5**: cloud-type profile, type-driven detail, profile-driven lighting.
4. ⏸ **C1**: coverage tile classification. Free perf for the next phases.
5. ✅ partial **C2–C5**:
   - ✅ Adaptive two-state march (C2) — landed earlier
   - ✅ Cone light march (C4) — restored to 6 taps in D8
   - ⏸ Curl noise advection (C5)
   - ⏸ Distance-scaled step length (C3)
6. ✅ **D prereqs**: per-pixel reprojection + sub-pixel jitter; origin-shift
   correction for floating-origin reprojection.
7. ✅ **D1–D8** (landed 2026-05-27/29): STBN jitter, sparse 1/16 marcher
   target with Bayer 4×4 schedule, full-res reconstruction pass with
   YCoCg variance clamp, lift marcher quality (6 cone taps, lowered first-
   hit threshold). v1 disocclusion = off-screen + variance clamp; depth-
   based disocclusion deferred to v2.
   - Residual MC variance at thin cloud regions is a fundamental limit
     of single-pass volumetric rendering at our sample budget. See plan
     status snapshot + `CLOUD_DEBUGGING_LESSONS.md` case study #7.
8. ⏸ **E1**: sun shadow map.
9. ⏸ **F2**: cloud–terrain interaction.
10. ⏸ **E2**: aerial perspective.
11. ⏸ **F1**: generalise to per-planet config.
12. ⏸ **F3, F4, F5**: tiers, pre-warm, Venus.

**Recommended next**: Phase E1 (sun shadow map) for cloud shadows on terrain;
or further marcher quality investment if reference-quality clouds are needed
before atmospheric polish. The thin-cloud-region noise that remains after
Phase D is fixable but expensive (more samples per ray, or spatial smoothing
post-pass that trades sharpness for noise reduction).

**Historical context** (kept for reference):
Phase D close-out: the original goal of fixing the user's high-speed smearing
symptom is unfixable inside the every-frame-TAA architecture; D's 1/16
reconstruction + variance clamp is the canonical solution.

Verify visually after each step on the live build. Required test shots:

- **Orbital limb** (≈ 12 000 km altitude): cloud silhouettes against deep space, atmosphere
  tint at limb.
- **Sub-orbital approach** (≈ 200 km altitude): cumulus columns with parallax against
  rotating Earth surface.
- **Deck flight** (≈ 5 km altitude): immersion through a cumulus deck, sunlit tops and
  shadowed undersides clearly visible.
- **Sub-1km flyby**: clouds wrap correctly around camera; below-inner-shell branch and
  planet-occlusion clamp both engaged.
- **Landing approach** (after F2): clouds clip realistically to mountain ridges.

---

## References

- **Schneider 2015**: *"The Real-Time Volumetric Cloudscapes of Horizon Zero Dawn"* —
  SIGGRAPH 2015 Advances in Real-Time Rendering. The canonical paper. Density value
  erosion, Perlin-Worley, weather-map structure, height-driven detail mask.
- **Schneider 2017**: *"Nubis: Authoring Real-Time Volumetric Cloudscapes with the
  Decima Engine"* — GDC 2017. Production details, performance numbers, temporal
  reprojection.
- **Schneider 2022**: *"Nubis, Evolved"* — SIGGRAPH 2022. Profile-driven multi-scatter
  approximation, voxel-lighting precursor.
- **Schneider 2023**: *"Nubis³"* — SIGGRAPH 2023 (`docs/VolumetricCloudReferences/Nubis Volumetric Clouds.pdf`).
  Voxel NVDFs, sphere-traced SDF stepping, alligator/curly-alligator noise. Out of scope
  for this plan but the roadmap if we ever go beyond HZD-era quality.
- **Wrenninge 2013**: *"Oz: The Great and Volumetric"* — multi-scatter octave hack
  (used in earlier versions of our marcher; superseded by profile-driven MS in B5).
- **Karis 2014 / Salvi 2016**: *"High Quality Temporal Supersampling"* / TAA reading —
  variance clamping, history sample validation, YCoCg-space clamping.
- **EVE volumetric mod** (`docs/VolumetricCloudReferences/KerbalSpaceProgramVolumetricCloudsMod/`):
  shipped real-time 2.5D-Nubis-flavour clouds for KSP; closest reference to what we are
  building, including STBN texture asset and per-cloud-type coverage curves.
