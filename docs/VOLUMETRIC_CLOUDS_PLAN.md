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

### Current state (2026-05-26, end of Phase B implementation session)

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

**Goal**: render `1/16` of pixels per frame, reuse history for the rest. The single
biggest engineering lift, and the single biggest unlock for matching reference quality
at sane cost.

**Pick one technique and stick to it.** The Nubis approach is *geometric 1/16
reconstruction* with a deterministic Bayer 4×4 sub-pixel pattern, *not* TAA-style Halton
jitter on every-pixel rendering. This plan commits to the geometric method. Mixing the
two (as the previous plan did) causes one to undo the other.

### D1. History RT infrastructure

Two RTs ping-pong (read previous, write current):

```ts
const cloudRtA = new RenderTarget(fullW, fullH, { type: HalfFloatType });
const cloudRtB = new RenderTarget(fullW, fullH, { type: HalfFloatType });
let frameParity = 0;
```

Half-res is no longer needed (or desired) once temporal is on — D handles perf, not the
resolution drop. Lift back to full-res at this point.

The cloud RT now carries `(R, G, B, alpha, t_front)`. `t_front` is needed for
reprojection. Pack into the alpha channel as 16-bit float (sufficient precision over
the 14 km slab) or use a 5-channel RT (RGBA + R32F secondary).

### D2. Geometric 1/16 schedule (Bayer 4×4)

Each frame, render only one of 16 deterministic sub-pixel positions inside every 4×4
tile. After 16 frames every sub-pixel has been written.

Two implementation options:

- **(A) 1/4-res buffer + scattered composite**: render the cloud march at 1/4 × 1/4 the
  full resolution (so 1/16 the pixel count). Each frame, the 1/4-res buffer corresponds
  to a different sub-pixel in the full-res 4×4 tile. Composite into the full-res history
  at the correct sub-pixel slot. **This is what HZD shipped.** Slightly more pipeline
  work but predictable convergence and cheap shading.
- **(B) Full-res with stochastic skip**: render full-res but the fragment shader
  early-outs unless `(frameIndex % 16) == bayer4x4(pixelX, pixelY)`. Simpler — single
  shader — but wastes fragment-shader launches even on skipped pixels.

**Plan commits to (A).** The added pipeline complexity is worth the predictable quality.

### D3. Camera-motion reprojection

Each frame, store the previous frame's combined view-projection matrix.

In the current frame, for each pixel that wasn't marched this frame, reproject from
history:

1. Read `t_front` from the current-frame's neighbourhood (the marched sub-pixel inside
   this 4×4 tile).
2. Reconstruct the world-space cloud-front position: `worldFront = camPos + rd × t_front`.
3. Project through the stored `prevViewProjection` to get `prevUV`.
4. Sample history RT at `prevUV` (bilinear).

```ts
const prevClip = prevViewProjMat.mul(vec4(worldFront, 1));
const prevUv   = prevClip.xy.div(prevClip.w).mul(0.5).add(0.5);
const history  = texture(prevCloudRt, prevUv);
```

Store `prevViewProjection` in the *same coordinate space* the marcher operates in
(planet-local or scaled-world — pick one and keep both consistent).

### D4. Disocclusion handling

History sample is invalid if:

- `prevUV` is outside `[0, 1]` (off-screen last frame).
- `length(prevWorldFront - currentWorldFront) > threshold` (camera teleport).
- Cloud silhouette change: `historyAlpha == 0 && currentAlpha > 0` or vice versa.
- Floating-origin rebase: the entire history is invalid; clear cloud RT entirely. Detect
  via the `worldOrigin` rebase event already plumbed in the engine.

When invalid, skip the history blend; output the current-frame sample at full weight.
Causes a transient blocky frame on disocclusion — acceptable; the next 16 frames repair.

### D5. Variance clamp using fresh neighbours only

The standard "clamp history to 3×3 neighbourhood mean ± k×stddev" is *broken under
1/16 reconstruction* because 15/16 of the neighbourhood is itself stale history. Two
working approaches:

- **(A) Fresh-only neighbourhood**: build the variance bounds using *only* the freshly
  marched pixel(s) in the current 4×4 tile. Smaller sample, larger bounds, but
  guaranteed stale-free.
- **(B) YCoCg chroma clamp**: clamp in YCoCg colour space rather than RGB, with looser
  bounds. Less aggressive ghost rejection but more forgiving of sparse fresh samples.
  Karis 2014 / Salvi 2016 style.

Recommend (A) for v1; revisit if ghosting appears on fast camera motion.

### D6. Reconstruction blend

```ts
const isFresh = pixelMatchesFrameSchedule;
const isHistoryValid = ... ;  // D4 checks

const finalColour = isFresh.select(
  currentSample,
  isHistoryValid.select(historyClamped, currentSample)
);
```

Fresh pixels: replace history outright with the new sample (no exponential blend).
Stale-valid pixels: pure history (clamped). Stale-invalid: fall back to current frame's
unconverged sample (acceptable artefact in the disocclusion frame).

### D7. Floating-origin invalidation hook

Hook into the existing `worldOrigin` rebase signal. On rebase:

- Clear both ping-pong cloud RTs to zero alpha.
- Reset the frame schedule index (effectively force 16-frame reconvergence).
- One-frame artefact is unavoidable; document and ship.

**Risks**: ghosting on fast yaw/pitch (D5 mitigates); disocclusion artefacts at
silhouettes (D6 falls back); shader-compile cost grows with branching (Phase F4 pre-warm
becomes mandatory).

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
   - ✅ Cone light march (C4) — landed, reduced to 3 taps for perf
   - ⏸ Curl noise advection (C5)
   - ⏸ Distance-scaled step length (C3)
6. ⏸ **E1**: sun shadow map.
7. ⏸ **F2**: cloud–terrain interaction.
8. ⏸ **D1–D7**: temporal reconstruction. (Partial: TAA reprojection + jitter
   is in cloudFullscreenPass.ts, but no 1/16 reconstruction scheduling.)
9. ⏸ **E2**: aerial perspective.
10. ⏸ **F1**: generalise to per-planet config.
11. ⏸ **F3, F4, F5**: tiers, pre-warm, Venus.

**Recommended next**: C5 (curl noise) for visible animation/flow, or D
(temporal accumulation) for cleaning up per-pixel variance. Both unlock
visible quality gains beyond the diminishing-returns tuning regime.

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
