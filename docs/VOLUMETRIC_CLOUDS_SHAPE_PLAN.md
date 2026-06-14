# Volumetric Clouds — Shape & Form Improvement Plan

**Status:** Phase A.0 implemented (awaiting visual regression-gate verification); A–D not started.
**Created:** 2026-06-14
**Scope:** Earth clouds (generalises to other planets later — see §9).

This plan exists so the work survives a session compaction. It is the
canonical record of *why* we're changing the cloud shape pipeline and *what*
the concrete steps are. Read this before touching cloud form/density code, and
read [`CLOUD_DEBUGGING_LESSONS.md`](CLOUD_DEBUGGING_LESSONS.md) before debugging
the marcher.

---

## 1. The problem (target vs current)

**Current look** (in-game): smooth, low-contrast convex lumps — "mashed-potato /
cotton-ball". Rounded blobs, soft edges, no fine structure. Effectively two
density bands (a low puffy layer + a taller thicker mass) that read as *the same
cloud, shorter or taller* — not as different cloud types.

**Target look** (real life / Nubis / EVE / Frostbite references): four things we lack
1. **Cauliflower** — stacked rounded billows at recursively smaller scales (self-similar), concentrated near the lit surface.
2. **Fine wisps** — high-frequency feathery erosion in low-density regions and at edges.
3. **Distinct cloud types coexisting** — flat stratus, billowing cumulus congestus towers, anvil-topped cumulonimbus — at different altitudes, strong vertical variation.
4. **Crisp, detailed silhouettes** with hard billow-vs-crevice contrast (ours are deliberately *softened* at edges).

Art-direction target: **realistic / true-to-life.** Earth-accurate meteorology —
fair-weather cumulus dominate, occasional congestus, rare cumulonimbus with
anvil; stratus/stratocumulus decks; realistic altitude bands and coverage
fractions; flat cumulus bases + billowing tops. No stylised exaggeration.

---

## 2. Key decisions (locked this session)

1. **Synthesise weather/cloud-type maps procedurally** (not hand-authored
   textures). Rationale: the game streams planet→orbit with no loading screens
   and must generalise to gas giants / procedural planets, so procedural is the
   correct default. An authored-texture *override* may be added per-planet later,
   but is not the baseline. Maps to synthesise: `R = coverage`, `G = cloud type`,
   `B = density / wetness` (domain-warped FBM, blended with existing coverage).
2. **Realistic art direction** — type curves, altitude bands, and type
   distribution follow real meteorology (see §7 Phase C).
3. **Mip-LOD sampling is a prerequisite (Phase A.0).** The three.js
   `Data3DTexture` mip-upload patch is verified but not yet wired into our
   code. We implement it *first*, because the entire "raise detail strength /
   stop suppressing detail at silhouettes" strategy depends on band-limiting
   high-frequency noise by mip (not by amplitude). Without it, cranking detail
   re-creates the salt-and-pepper aliasing that originally forced the
   suppression.

---

## 3. The reference recipe (canonical formulas)

We already implement the core. The form quality lives in the **noise
composite** fed to the value-erosion.

**Density = value-erosion of the dimensional profile** (Nubis, Schneider 2015→2023):
```
cloud_density = saturate(noise_composite − (1 − dimensional_profile))
dimensional_profile = coverage × heightProfile     // 0 at edges, 1 in cores
```

**Frequency-graded noise composite** (Nubis³ slides 100–116) — *the trick we're missing*:
```
wispy        = lerp(lowFreqWisp,   highFreqWisp,   dimensional_profile)
billowy_grad = pow(dimensional_profile, 0.25)
billowy      = lerp(lowFreqBillow, highFreqBillow, billowy_grad)
composite    = lerp(wispy, billowy, cloudType)      // type: 0=wispy/stratus, 1=billowy/cumulus
```
Low-frequency structure at edges (rounded), high-frequency toward the
interior/surface. This is what reads as *structured billows* instead of "smooth
blob" (no high-freq) or "speckled everywhere" (flat high-freq).

**Near-camera "twice-folded" HHF up-rez** (slide 118) — close-range cauliflower, no extra fetches:
```
hhf_wisps   = 1 − pow(abs(abs(noise.g*2−1)*2−1), 4)
hhf_billows =     pow(abs(abs(noise.a*2−1)*2−1), 2)
hhf         = saturate(lerp(hhf_wisps, hhf_billows, cloudType))
composite   = lerp(hhf, composite, remap(dist, 50m, 150m, 0.9, 1.0))   // engage <150m
```

**Density-gradient wisp/billow rule** (slides 94–97): decreasing density → curly
layered wisps; increasing density → layered billows. Drive the wispy↔billowy
blend (or its inversion) from the density gradient, not altitude alone.

**Noise type** (Nubis³): billows from **Alligator noise** (better cloud
lacunarity than raw inverted Worley → fewer "packed spheres"); wisps from
**Curl-distorted Alligator** ("Curly-Alligator"). We currently use Perlin-Worley
+ Worley FBM (older HZD-2015 generation).

**Envelope vertical profile** (Nubis, for flat-bottomed billowing-topped clouds):
```
h        = remap(height, minH, maxH, 0, 1)
bottom   = pow(h, 2)            // flat-ish base
top      = pow(1 − h, 1.5)      // rounded top
profile  = bottom × top × edge
```

**Sharpen pass** (slide 123): `pow(density, lerp(0.3, 0.6, …))` — more sharpening
in low-density regions to bring out definition and reduce undersampling mush.

**Ambient** (already have): `pow(1 − dimensional_profile, 0.5)`.

**EVE / Scatterer config** (Blackrack — closest reference: procedural raymarched
planetary clouds). Concrete tuning values worth matching:
- Worley: `octaves=8, periods=3, brightness=1.3, contrast=1.5, lift=0.5` — note **contrast 1.5** on the base (part of why their billows aren't mushy).
- `detailNoiseTiling=785`; per-type `baseNoiseTiling` 1852–4000.
- `coverageMap` + `cloudTypeMap` (separate channels) + per-type **freeform `coverageCurve`** (the vertical density profile; e.g. multi-keyframe anvil curve for cumulonimbus).

---

## 4. What the code already gets right (do NOT rebuild)

Reference-grade skeleton — ~80% of the Nubis recipe is here:
- ✅ Value-erosion remap (not multiply); first-class `dimensional profile = coverage × heightProfile`.
- ✅ Perlin-Worley base + Worley-FBM detail volumes.
- ✅ Wispy↔billowy detail remix driven by a `cloudType` signal.
- ✅ Dual-lobe Henyey-Greenstein (`HG_FORWARD=0.8, HG_BACK=−0.3, HG_BLEND=0.5`), powder (`POWDER_K=2`), Nubis multi-scatter (`Tsun^MS_COEF`, `MS_COEF=0.9`), ambient `pow(1−profile, 0.5)`, `skylight=0.07`.
- ✅ Macro billow-carve for ~1.5–3 km relief (`CARVE_SCALE=80`, `BILLOW_CARVE=0.75`).
- ✅ Precomputed light volume (256×32×256, dual-volume crossfade) — this *is* the Nubis³ voxel-lighting idea.
- ✅ Adaptive two-state SDF-like march; 1/4-res (`SPARSE_DIVISOR=2`) + temporal reconstruction (`EMA_ALPHA=0.1`, YCoCg variance clamp) + STBN.

The remaining 20% is exactly the form-defining 20%.

---

## 5. Root-cause diagnosis (priority order)

1. **No frequency-over-profile gradient + no near-camera HHF up-rez.** Detail volume sampled at a single scale with channel remix, but no low→high blend across the profile and no folded close-range detail. *This is why it stays smooth even up close* (Nubis names this exact symptom). → [earthClouds.ts](../src/components/celestial/bodies/earthClouds.ts) detail-erosion block (~L1597–1701).
2. **Detail suppressed exactly where cauliflower would show.** `uDetailErosion=0.2` (low) and detail ramped *down* at silhouettes via `edgeness` to fight aliasing → lit billowing edges get the least structure. Perf doc rule: *band-limit by mip, never by amplitude.*
3. **Base shape rounded by construction.** `baseShape = (R + (1−FBM))/(2−FBM)` inflates toward smooth convex bumps; Perlin-Worley R is Perlin-fill-dominated (low contrast). At medium/high views (detail sub-pixel) this *is* what's visible. → [noiseVolumes.ts](../src/components/celestial/bodies/noiseVolumes.ts) + dilation (~L1496).
4. **Noise reads as "packed spheres."** No curl distortion; clouds static. Nubis³ moved off raw Worley deliberately.
5. **Cloud type derived from coverage; profiles too gentle; one layer.** `cloudType = smoothstep(0.3,0.6,coverage)` and 3 smoothstep height curves blended → "shorter/taller of the same thing." No flat cumulus bases, no anvil, no second altitude band. → [earthClouds.ts:511](../src/components/celestial/bodies/earthClouds.ts).

---

## 6. Out of scope

- **Nubis³ authored-voxel pipeline** (Houdini "frankenclouds" baked into a 4 km
  voxel grid). Incompatible with seamless planet↔orbit procedural streaming. Our
  references are Nubis 2.5D (procedural erosion) + EVE (planetary procedural) +
  Nubis³ *shader-side* up-rez tricks.

---

## 7. The phased plan

Four independent, individually shippable phases (+ a prerequisite). Order is by
impact-on-shape. Performance: A/B/D are mostly ALU + one curl fetch — cheap vs
the cone/light-volume cost (see [`VOLUMETRIC_CLOUDS_PERF.md`](VOLUMETRIC_CLOUDS_PERF.md));
C is near-free per-sample. Gate HHF + curl behind existing quality tiers.

### Phase A.0 — Mip-LOD foundation (prerequisite) — IMPLEMENTED 2026-06-14
**Done:** detail-erosion tap now samples a footprint-matched mip LOD
(`detailLod = clamp(log2(max(1, t·DETAIL_MIP_DIST_K)), 0, DETAIL_MIP_MAX)`,
`DETAIL_MIP_DIST_K=54`, `DETAIL_MIP_MAX=4`) instead of `.level(int(0))`. Crisp
mip-0 below ~18 km, band-limited beyond. Base/carve/column/cone/light-volume
taps left at level 0 (see in-code note). Added `DEBUG_VIZ='detailLod'`.
Lint clean. **Pending:** visual regression gate (below) in a live WebGPU session.
**Goal:** band-limit detail noise by mip so Phase A can raise detail without aliasing.
- Wire the verified three.js `Data3DTexture` mip patch into our 3D noise sampling.
- Sample detail (and base) at a mip level that grows with ray distance / step footprint, à la Nubis: `mip = log2(1 + dist × scale)`. Independently buys ~15% perf (Nubis figure) and removes the reason detail had to be amplitude-suppressed.
- **Regression gate:** the prior attempt (2026-06-10) caused "small clouds fade in at close range" due to the WebGPU mip-upload bug. Verify that symptom does **not** reappear now that the patch is in. If it does, stop and diagnose before Phase A.
- Files: [noiseVolumes.ts](../src/components/celestial/bodies/noiseVolumes.ts), [earthClouds.ts](../src/components/celestial/bodies/earthClouds.ts).

### Phase A — Detail noise & erosion (the cauliflower fix) — highest impact
**Goal:** turn smooth lumps into structured billows + wisps at all ranges.
1. **Frequency-graded composite** — `wispy = lerp(low,high,profile)`, `billowy = lerp(low,high,pow(profile,0.25))`, `composite = lerp(wispy,billowy,cloudType)`. Pure ALU on existing fetches. Biggest single win.
2. **Density-gradient wisp/billow flip** — replace altitude-only `altMod` with the density-gradient sign (wisps where density decreases, billows where it increases).
3. **Near-camera twice-folded HHF** (§3 formula), blended within ~150 m.
4. **Raise `uDetailErosion`; remove silhouette `edgeness` suppression** — push aliasing control onto mips (A.0) + temporal pass.
5. **Curl-distorted sampling** — add a ~64³ curl-noise volume (~1 MB); warp the detail sample position (and later base) by it. Kills "packed spheres" regularity.
- Files: [noiseVolumes.ts](../src/components/celestial/bodies/noiseVolumes.ts), [earthClouds.ts](../src/components/celestial/bodies/earthClouds.ts).
- **Verify:** deck-level framing (screenshot-3 angle); inspect edge silhouettes; DEBUG_VIZ `eroded`/`density` modes.

### Phase B — Base macro shape (billows at distance)
**Goal:** fix high/medium views where detail is sub-pixel.
1. **Contrast the base shape** (EVE `contrast≈1.5, lift≈0.5`) so cores billow and valleys deepen instead of rounding.
2. **Reduce FBM over-inflation; add a 2nd macro-carve octave** so macro relief is multi-scale (recursive billows), not single-scale 3 km lumps.
- Files: [earthClouds.ts](../src/components/celestial/bodies/earthClouds.ts) base block + `CARVE_SCALE`/`BILLOW_CARVE`.
- **Verify:** hover ~3–10 km above deck; lumps should read as billows with self-shadow contrast (light volume bites into new relief).

### Phase C — Cloud types, height profiles, weather map (variety + anatomy)
**Goal:** "different cloud types at different levels," natural height variation, realistic.
1. **Synthesised multi-channel weather map** (`R=coverage, G=type, B=density`) from domain-warped FBM + existing coverage. Procedural (per §2). Generalises to other planets.
2. **Per-type freeform coverage curves** replacing the 3 smoothstep profiles ([earthClouds.ts:511](../src/components/celestial/bodies/earthClouds.ts)). Add realistic types with Earth-accurate altitude bands:
   - Stratus / stratocumulus — flat sheets, low.
   - Cumulus humilis/mediocris — flat base (~0.6–2 km), billowing top, dominant.
   - Cumulus congestus — tall towers (to ~6 km).
   - Cumulonimbus + anvil — asymmetric, spreading top (to ~12 km+), rare.
   - Use envelope shaping (`bottom=pow(h,2)`, `top=pow(1−h,1.5)`) for flat bases.
3. **Realistic type distribution** — fair-weather cumulus dominate; congestus occasional; Cb rare. Tune coverage fractions to real-life.
4. **Optional second high layer** (cirrus/altocumulus) for genuine multi-altitude variety.
- **Verify:** synthesise a test field with bands of each type; confirm distinct silhouettes coexist at correct altitudes.

### Phase D — Animation (organic motion)
**Goal:** clouds feel alive; reinforces wispy forms.
- Wire `uCloudUvOffset` (already present) + curl-warped sample position for wind advection.
- Lowest priority for still-image shape; high for "feel."
- Files: [earthClouds.ts](../src/components/celestial/bodies/earthClouds.ts), [noiseVolumes.ts](../src/components/celestial/bodies/noiseVolumes.ts).

---

## 8. File map

| File | Role |
|------|------|
| [earthClouds.ts](../src/components/celestial/bodies/earthClouds.ts) | Marcher, density/erosion, height profile, detail composite — **most changes here** |
| [noiseVolumes.ts](../src/components/celestial/bodies/noiseVolumes.ts) | 3D noise generation (base, detail; add curl) |
| [cloudFullscreenPass.ts](../src/components/space/cloudFullscreenPass.ts) | Fullscreen pass setup, uniforms, quality tiers |
| [cloudReconstructionPass.ts](../src/components/space/cloudReconstructionPass.ts) | 1/4-res reconstruction + temporal (aliasing budget lives here) |
| [cloudLightVolume.ts](../src/components/space/cloudLightVolume.ts) | Precomputed sun-transmittance volume |

Key constants (current): `CLOUD_INNER_ALTITUDE_KM=1`, `CLOUD_OUTER_ALTITUDE_KM=14`,
`uDetailScale=500` (2 km tiles), `uDetailErosion=0.2`, `CARVE_SCALE=80`,
`BILLOW_CARVE=0.75`, detail fade `detailNear=0.005`/`detailFar=0.080`.

---

## 9. Future: other planets

The synthesised-map + per-type-coverage-curve approach generalises cleanly:
- Gas giants → swap noise params + band-driven coverage curves (zonal bands), different palette/scattering.
- Procedural planets → drive map synthesis params from the planet's seed/biome.
Keep cloud-type curves and noise params data-driven (per-planet config) rather
than hardcoded to Earth, so the system is reusable without code changes.

---

## 10. Open inputs

- None blocking. Maps are synthesised (decided). Art direction is "realistic" (decided). Mip-LOD goes first (decided).
- A real-world reference still for the *default* Earth sky (mostly fair-weather cumulus) would help tune Phase C type fractions, but is not required to start.
