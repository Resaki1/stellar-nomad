# Volumetric Clouds — Shape & Form Improvement Plan

**Status (2026-06-15): ROOT CAUSE FOUND — the elongation is the DOMAIN WARP, not
the noise.** The `/dev/cloud-slice` instrument showed: warp OFF → round blobs; warp
ON → curved stringy filaments. The 2026-06-14 "warp ruled out by analysis" was wrong
(the warp source is high-frequency Worley FBM, not the 125 km tile period). **The
"need an Alligator noise rewrite" conclusion is retracted** — base noise makes round
blobs. New problem = anti-tiling without shear (the warp's job, done badly). **FIX
IMPLEMENTED (2026-06-15): tile-&-offset** (shared `cloudDetile.ts`, behind compile-time
`USE_DETILE`) at primary + self-shadow probe + light-volume bake; validated in
`/dev/cloud-slice` (tile 20 km, blend 0.5). Pending in-WebGPU verification + perf
profile (4× taps in the hot loop). Rollback = `USE_DETILE=false`. Crease test (`BILLOW_CREASE_POWER`) refuted at k=3 (irrelevant
now). Baseline = original + **A.0** + **A1**. Full detail in the dated **2026-06-15**
block under §Phase A findings.
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
1. **Frequency-graded composite** — `wispy = lerp(low,high,profile)`, `billowy = lerp(low,high,pow(profile,0.25))`, `composite = lerp(wispy,billowy,cloudType)`. Pure ALU on existing fetches. Biggest single win. — **DONE 2026-06-14** (graded over the 3D `shape` gradient — not the smooth `dimProfile` — so detail hugs the carved surface; billowy = R→G via `pow(shape,0.25)`, wispy = G→B linear; detail channels are Worley grids 4/8/16 = low/mid/high; erosion strength + edge-suppression left untouched so it's one isolated variable; mean preserved → density unchanged. Pending visual verify.)
2. **Density-gradient wisp/billow flip** — replace altitude-only `altMod` with the density-gradient sign (wisps where density decreases, billows where it increases).
3. **Near-camera twice-folded HHF** (§3 formula), blended within ~150 m.
4. **Raise `uDetailErosion`; remove silhouette `edgeness` suppression** — push aliasing control onto mips (A.0) + temporal pass. — **TRIED & REVERTED 2026-06-14** (see findings below).
5. **Curl-distorted sampling** — add a ~64³ curl-noise volume (~1 MB); warp the detail sample position (and later base) by it. Kills "packed spheres" regularity.
- Files: [noiseVolumes.ts](../src/components/celestial/bodies/noiseVolumes.ts), [earthClouds.ts](../src/components/celestial/bodies/earthClouds.ts).
- **Verify:** deck-level framing (screenshot-3 angle); inspect edge silhouettes; DEBUG_VIZ `eroded`/`density` modes.

#### Phase A findings (2026-06-14) — KEY PIVOT
Cranking the detail erosion (A4: removed `edgeness`, raised `uDetailErosion` 0.2→0.4,
`erosionStrength`→2.0) did **not** produce cauliflower. Empirical results:
- Thick clouds stayed **smooth** at any erosion strength.
- Thin regions fragmented into **"cotton balls suspended in transparent jelly"** (unlit dense lumps).
- A "white line + transparent padding" halo appeared around bodies.

**Root cause: detail erosion modulates OPACITY, not LIGHTING.** The light march
(cone, ~2 km steps) and the 800 m self-shadow probe sample the **base shape +
macro carve** — NOT the detail-eroded density. So detail lumps get the same
lighting as the surrounding macro shape → uniformly-lit blobs ("cotton balls"),
never shaded cauliflower. Additionally, where `shape` saturates to 1 (thick
cores) the value-erosion remap `(shape−t)/(1−t)` is a **no-op**, so detail can't
touch thick bodies at all — only the thin fringe (→ the halo). The `'eroded'`
DEBUG_VIZ confirmed the relief *exists in the density field*; it just isn't lit.

**Conclusion: visible cauliflower must come from the LIT layer (the carve that
the cone/probe sample), not from detail-erosion strength.** A4 reverted; A.0
(mip) and A1 (frequency-graded composite) kept (both sound, A1 will matter for
fine surface texture once the lit relief exists). **→ Re-prioritise: Phase B
(lit carve relief) is now the cauliflower lever, ahead of A2/A3/A5.**

Note: `DEBUG_VIZ='firstConeDepth'` is **uninformative while `USE_LIGHT_VOLUME` is
on** — it measures the cone march, which the light-volume path disables, so it
reads black in every scene. Don't use it for diagnosis in this config.

**Lit-carve lever CONFIRMED (2026-06-14):** raising `CARVE_SCALE` (80→250) and
`BILLOW_CARVE` (0.75→0.85) live produces visibly more (and "a bit more natural")
structure → relief in the carve layer DOES reach the render (unlike unlit detail
erosion). **Open issue:** the broken-up bits are **elongated / "flaky", not the
round packed billows** of the references. Three candidate causes, different fixes:
(1) vertical thinness → flat horizontal flakes (fix: thicker clouds / taller
profiles, Phase C); (2) Voronoi angularity of single-octave inverted-Worley
erosion → faceted/elongated cells (fix: round multi-octave billow noise);
(3) base Perlin ridginess → streaks (fix: base contrast / less Perlin).
Nadir test result (2026-06-14): bits are **elongated/streaky from straight
above too** (if anything more than from the side) → **NOT vertical thinness**
(rules out cause 1 / Phase-C thickness). The streaks are flowing, curved
*filaments* at km-scale → signature of the **Perlin (gradient) component in the
base shape** (Perlin = brush-stroke ridges; Worley = round blobs; references use
Worley-family packed-sphere noise for round billows). Carve cells (~1 km at
CARVE_SCALE 250) are smaller than the streaks, so the streaks come from the
larger base structure, not the carve.

**Elongation root cause narrowed (2026-06-14):**
- Vertical thinness: RULED OUT (nadir still elongated).
- Base Perlin: RULED OUT (`BASE_R_PERLIN_WEIGHT=0`, pure Worley R → streaks persist).
- Domain warp: ruled out by analysis (per-column 2D displacement, ~6% shear across
  one cloud — shifts whole clouds for anti-tiling, can't smear within one).
- **Confirmed cause: the elongation is the ISOSURFACE of merging blobs.** Where
  inverted-Worley peaks overlap at the carve threshold, the surviving region is a
  connected mass with elongated *necks/saddles* between cell centres — intrinsic to
  thresholding ANY noise at merging density (independent of noise type, hence
  Perlin-removal didn't help). Real cauliflower = compact, separated round billows
  that touch but don't melt into necks.
- **Fix in test: `CARVE_COMPACT_POWER`** (earthClouds.ts, default 1.0 = identity).
  `pow(carveWorley, P>1)` shrinks each Worley peak to a tight cap → compact round
  spheres, killing the necks. Applied at all 3 carve sites (primary + local probe +
  cone). Try P=2–3 live (HMR, no noise regen). Higher P = rounder/separated/thinner
  (rebalance density after with BILLOW_CARVE / density mul). If it rounds out → the
  cauliflower lever. (`BASE_R_PERLIN_WEIGHT` left at user's 0.0; set back to 1.0 for
  a normal-density test of compaction.)
- **Compaction RESULT (2026-06-14): still stringy at P=3.** So the necks form in the
  BASE shape before the carve — no carve-side knob fixes it. Reframe: the carve goes
  smooth-blobs (low CARVE_SCALE) → stringy fragments (high) WITHOUT passing through
  round cauliflower; references show *coherent bumpy bodies*, we get a fragmented
  stringy field. **Conclusion: the current base generator (threshold of Worley-FBM /
  Perlin-Worley) can't produce round packed billows — every cheap knob is exhausted.**
  Real fix = a NOISE-GENERATOR change (Phase A5): the noise must BE round packed
  billows *before* thresholding. Options: (a) Alligator-style noise (Nubis³ — rounder
  "cloud-like lacunarity" than Worley); (b) additive packed-sphere billows (sum of
  compact round bumps) instead of thresholded FBM; (c) depth-aware "surface billow"
  carve so coherent bodies get round surface bumps without fragmenting. Deliberate
  work in noiseVolumes.ts, not a tuning pass. Honest expectation: Guerrilla's
  reference look uses purpose-built noise + Houdini fluid sims — better procedural
  noise gets us closer, not pixel-identical.
- Experimental knobs left in code as dormant defaults: `CARVE_COMPACT_POWER=1.0`
  (identity), `BASE_R_PERLIN_WEIGHT` (user's working copy 0.0). Suggested committed
  baseline for the next effort: `CARVE_SCALE` back to ~80–120, `BILLOW_CARVE` ~0.75,
  `BASE_R_PERLIN_WEIGHT` 1.0 (coherent bodies), then build the new billow noise.

#### Reference grounding + crease test (2026-06-15)
- **Reference answer confirmed (Nubis³ p.98, verbatim):** Schneider hit our exact
  wall — inverted Worley billows look like *"packed spheres"* and needed "a lot of
  layering and work in the sampler"; they fixed it by switching the generator to
  **Houdini Alligator noise** ("more appropriate cloud-like lacunarity"), wisps to
  **Curly-Alligator** (inverted alligator + curl). Plus frequency-grade low→high over
  the dimensional profile so EDGES get LOW-freq round structure (p.109). **Frostbite
  §5.4 is the SAME generation as us** (Perlin-Worley + Worley FBM) and does NOT
  address necking — not the reference to mine for this. Our value-erosion
  architecture (earthClouds.ts:1669) already equals the Nubis recipe; what's missing
  is round-billow NOISE + the extra flat macro-carve threshold (a 2nd Worley
  threshold) compounding the necks.
- **Cheap crease test — REFUTED.** Added `BILLOW_CREASE_POWER` (noiseVolumes.ts):
  mean-preserving per-sample `crease(v)=pow(v,k)·(k+1)/2` on the billow Worley (base
  R, base FBM G/B/A, detail R/G/B). Hypothesis: deepening Worley's broad saddles →
  rounder billows. **Result: still stringy at k=3** (more obvious at CARVE_SCALE 250,
  nadir). So crease depth is NOT the lever — the necking is structural, not a
  saddle-contrast issue. (`BILLOW_CREASE_POWER` left in code; k=1 is exact identity.)
- **Instrument built (stop guessing): `/dev/cloud-slice`** — a flat 2D slice viewer
  that samples the SAME base+detail volumes and applies the SAME composition math
  (mirrored from earthClouds.ts:1516-1564), with NO march/lighting/temporal/spherical
  geometry. Flip Field through R → baseShape → carveWorley → baseShapeCarved (binary
  isosurface + threshold sweep + warp toggle). **Decisive bisection:** if
  `baseShapeCarved` is stringy in the slice → necking is in the noise/composition
  (attack the noise); if it's round in the slice but stringy in-game → it's a RENDER
  artifact (warp/march/temporal).
- **ROOT CAUSE FOUND (2026-06-15) — the DOMAIN WARP, not the noise generator.**
  Slice read: with warp ON the curved stringy filaments appear in `baseShapeCarved`
  (and faintly in `carveWorley`/`R`); **with warp OFF they vanish and the noise is
  round blobs** (with a repeating tile pattern). The curved/swirly filaments are the
  textbook signature of fBm domain warping. Why the 2026-06-14 "warp ruled out by
  analysis" was WRONG: that analysis assumed the warp source varied over its 125 km
  *tile period*, but the source is the base volume's **Worley-FBM g/b/a channels**
  (earthClouds.ts:1433-1437, sampled at `uColumnScale=8`) whose *content* runs down to
  ~2.6 km features → a ±5 km displacement with km-scale gradient → it SHEARS clouds
  into filaments. Empirical toggle beat the paper analysis (cf. feedback_debugging).
- **MAJOR REFRAME:** the base noise itself produces ROUND blobs (warp off) → the
  "current generator can't make round billows, need Alligator" conclusion was
  **contaminated by the warp** and is now retracted as the cause of the *elongation*.
  We likely do NOT need a noise-generator rewrite to fix the stringiness. (Alligator /
  frequency-grading may still improve cauliflower *quality* later, but that's separate
  and lower priority than thought.)
- **NEW problem to solve = anti-tiling without shear.** The warp exists because the
  base tiles every 20 km (4 Worley cells) → visible repetition from orbit (seen as the
  "repeating pattern" with warp off). Domain warp is the WRONG tool: anti-tiling wants
  the displacement to differ between adjacent 20 km tiles (≈ tile-period frequency),
  which is exactly the frequency that shears. **CONFIRMED IN-GAME (2026-06-15):**
  `WARP_AMPLITUDE=0` removes the strings in the real render.
- **What the references do for anti-tiling (2026-06-15):**
  - **Nubis** — side-steps it: authored voxel hero-clouds + a bounded cloudscape
    "arena," not planet-scale tiled noise. Not applicable.
  - **Frostbite §5.4** — **incommensurate multi-scale layering**, NOT warp: the
    low-freq base noise "break[s] down the repeatability of the weather texture"
    (weather map @ one scale + base @ another + detail @ another → long combined
    repeat). Tileable noise (Hillaire) underneath for seamless wrap.
  - **EVE / Blackrack** (closest analog) — a DEDICATED **"noise detiling"** feature,
    *"performance intensive, enabled by default"* (method undisclosed; perf cost ⇒ a
    MULTI-SAMPLE technique = tile-&-offset family, not a one-tap warp). Configs also use
    non-harmonic per-layer `baseNoiseTiling` (1852/1853/1854/3000/1499/1999/2501…).
  - **Academic** — "Non-periodic Tiling of Procedural Noise Functions" (ACM
    10.1145/3233306); Quilez "texture repetition" (tile-&-offset).
  - **Takeaway:** none use domain warp (matches our finding). Fix = incommensurate
    scales (free, partial) + Quilez tile-&-offset (the real one, what EVE does; gate
    behind a quality tier — it multiplies base taps in the hot loop). Prototype in the
    slice first; slice now has warp amp + source-scale sliders.
- **Tile-&-offset VALIDATED in the slice (2026-06-15).** Added a `detile` toggle to
  `/dev/cloud-slice`: partition the world horizontal plane into tiles, give each a rigid
  hashed offset (so the tile samples a different phase of the infinite tiled noise — no
  shear), 4-tap bilinear blend (seam at tile centre, blend-width controls the band).
  Result: round blobs PRESERVED + tiling broken. **Empirical sweet spot: tile size
  ~20 km, blend width ~0.5.** Known artifact: a few **perfectly straight edges** inside
  clouds = the square-grid blend (axis-separable weights → grid-aligned blend loci);
  reduced by larger tiles (mostly gone at 20 km). Full fix if it shows when LIT in-game:
  per-tile random rotation/flip, or hex/simplex tiling (no long axis-aligned grid lines).
- **PORTED to the marcher (2026-06-15).** Shared module
  [`cloudDetile.ts`](../src/components/celestial/bodies/cloudDetile.ts) (single source
  of truth: sin-free Hoskins hash, `detileBlend`, consts tile=0.02 / blend=0.5 /
  offset=1.0) + compile-time `USE_DETILE` flag. Applied at the 3 ACTIVE base/carve
  sites, each as `if (USE_DETILE) { detile } else { original warp }` so OFF is the
  exact original:
  - **Primary march** (earthClouds.ts) — carved shape (the visible silhouette).
  - **Local 800 m self-shadow probe** (earthClouds.ts) — carved (near shadow).
  - **Light-volume bake** (`cloudLightVolume.ts` `densityAt`) — dilated (far shadow);
    same offsets keyed on Earth-space `q` so baked shadows register with the render.
  - Cone (earthClouds.ts) left with a TODO — it's DEAD while `USE_LIGHT_VOLUME=true`.
  - Dropped the primary's "skip carve" perf gate on the detile path (the 4-tap blend
    carves every tile). **PERF: detile = 4× base/carve taps in the hot loop AND the
    bake; at blend 0.5 there's no single-tap interior to early-out.** Profile; if too
    hot, lower `DETILE_BLEND` (interior early-out) or drop to a 2-tap control-noise
    variant. **Rollback: set `USE_DETILE=false`** → byte-for-byte the old warp.
  - `WARP_AMPLITUDE` still drives the OFF path + the (unwarped-anyway) detail erosion;
    set it to 0 if keeping detile permanently. Lint 0 errors; hash pattern matches
    three's WoodNodeMaterial. NOT yet run in WebGPU — verify in-session.

#### Anti-tiling reality check (2026-06-16) — the crossfade is the real lever
The 4-tap detile cost 60→15 fps in near-orbit + showed straight grid lines in low
coverage. Before optimising, checked WHERE volumetric is actually visible (the bound on
the repeat period that matters):
- **Volumetric renders from ground up to 3000 km altitude, FULL below 1500 km**
  (`uVolumetricBlend`, [earth.ts:92-93](../src/components/celestial/bodies/earth.ts);
  ramp [earth.ts:508-513](../src/components/celestial/bodies/earth.ts); above 3000 km the
  passes are skipped entirely and the planet-scale 2D overlay carries the view).
- **At those altitudes the footprint is continental.** Code comment: a 5 km cell ≈ 2 px
  at 3000 km → a 20 km tile ≈ 8 px → **~120–240 tile repeats across the screen** at
  1500 km. To drop that to a few repeats you'd need a ~600 km repeat period → an
  unbakeable volume. **So a bigger bake (256³ → 40 km) does NOT hide the tiling** (still
  ~60–120 repeats). The bigger-bake idea is shelved. (The research agent's "60 repeats →
  imperceptible" was backwards — many repeats = MORE visible grid.)
- **Conclusion: the crossfade altitude is the master lever.** Volumetric currently
  renders over continental footprints where (a) any storable noise tiles visibly and
  (b) perf is worst (long ray chords → the 15 fps). The code's own intent is "let the
  flat overlay carry everything higher" — the 1500/3000 km thresholds are just set high.
  Options: (1) **lower the crossfade** so volumetric only renders close (small footprint
  → little tiling; short chords → fast; high-altitude clouds become the non-tiling 2D
  overlay; trades away high-altitude volumetric detail that's ~2–4 px anyway) —
  CHEAPEST, fixes tiling + perf together; (2) keep it high + a cheaper 2-tap technique-3
  detiler as a quality tier (perf still hurts at altitude); (3) accept high-altitude
  tiling, revert to the fast warp-off round-blob path, focus close-range quality.
  Pending user art-direction call on (1) vs (2) vs (3).

### Phase B — Lit carve relief (billows / cauliflower) — NOW THE PRIORITY (per Phase A findings)
**Goal:** put cauliflower-scale relief into the LIT shape so it self-shadows
(the macro carve at 1.5–3 km is too coarse to read as cauliflower at deck-view
scale; the detail erosion is unlit). The carve is already sampled by the primary
march AND the cone + 800 m self-shadow probe (they reconstruct the carved base
shape), so relief added here gets self-shadowed automatically — unlike detail.
1. **Add a 2nd, finer carve octave** (~400–800 m features) on top of the existing
   1.5–3 km macro carve → multi-scale recursive billows. Must be added to the
   carved base shape that the cone/probe sample (so it's lit). Watch the
   documented failure mode: a single fine carve (CARVE_SCALE 350) once left the
   top boundary flat / cone escaped — but that predates the 800 m local probe +
   light volume, so re-test. May need a shorter/extra self-shadow probe (~300 m)
   to resolve the finer octave.
2. **Contrast the base shape** (EVE `contrast≈1.5, lift≈0.5`) so cores billow and
   valleys deepen instead of rounding; reduce FBM over-inflation.
- Files: [earthClouds.ts](../src/components/celestial/bodies/earthClouds.ts) carve block (`CARVE_SCALE`/`BILLOW_CARVE`) + cone/probe sample sites + base dilation.
- **Verify:** `DEBUG_VIZ='firstConeDepth'` should gain fine variation on thick bodies (it was flat); then `'off'` thick clouds should show shaded cauliflower, not smooth.

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
