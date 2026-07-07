# Cloud Shape Anatomy — how the marcher builds each cloud type, and why thick clouds read as porridge

**Status: ANALYSIS (2026-07-06).** Companion to `docs/CLOUD_REVIEW_2026-07.md` ISSUE 3 and the input analysis for `docs/CLOUD_TYPES_PLAN.md`. All line anchors are against the **current working tree** (staged, uncommitted far-shell work included — `BASE_EROSION_K` is analyzed at its staged value **0.6**, changed from 1.2 in the staged diff). Line numbers drift; re-grep symbols before editing.

**Method note.** Every distribution/percentage below comes from a Monte-Carlo reproduction of the exact noise chain (Alligator-Worley metaball-max `ALLIGATOR_RADIUS=0.9`, Perlin-Worley hybrid, same salts/grids/weights as `noiseVolumes.ts`, same shader formulas as `earthClouds.ts`), N = 200k–400k samples. They are *field statistics* (fraction of noise space), not screenshots — verify in-app with the DEBUG_VIZ steps given per hypothesis. The sim's base-R mean (0.697) differs from the 2026-06-16 measured histogram (0.605) because that measurement predates the Alligator switch (case #21); re-log `[cloud base dist]` to confirm current GPU-bake numbers. The Monte-Carlo scripts are preserved alongside this doc: `cloudstats.mjs`, `worked.mjs`.

---

## Part A — Anatomy walkthrough: how a march sample becomes cloud

### A.0 The per-sample pipeline (current tree, with constants)

Per dense-march sample at earth-space position `p`, `r=|p|`, `alt01=(r−rInner)/(rOuter−rInner)` (slab 1–14 km, `earthClouds.ts:68-69`):

| # | Stage | Formula (constants inlined) | Anchor |
|---|-------|------------------------------|--------|
| 1 | Weather tap (per step) | `coverageRaw = weatherMap(equirectDirToUv(p/r)).r` — Blue Marble 8k, R only | :2007-2008 |
| 2 | Coverage lift | `coverage = coverageRaw^0.6` | :2022 |
| 3 | Cloud type | `cloudType = smoothstep(0.3, 0.6, coverage)` — the ONLY type signal | :2038 |
| 4 | Column tap | `colSample = baseVolume(p/r·rInner · 30).r` — Perlin-Worley **hybrid** (not pure Perlin; see H4), 33 km tile, 8.3 km cells | :2062-2065 |
| 5 | Top altitude | `covSpan = smoothstep(0.35,0.7,coverage)`; `topAlt = 0.45 + smoothstep(0.3,0.7,colSample)·0.5·covSpan` → [0.45, 0.95] | :2102-2105 |
| 6 | Height profile | `heightProfile = cloudHeightProfile(alt01, topAlt, cloudType)` — 3 analytic curves mixed at type 0.5 pivot | :783-820, call :2120 |
| 7 | Dimensional profile | `profile = coverage · heightProfile`; gate `If(profile > 0.01)` before any 3D tap | :2126, :2137 |
| 8 | Base shape + dilation | `baseShape = clamp(baseVol.r + (fbm − 0.4)·1.2, 0, 1)`, `fbm = 0.625g+0.25b+0.125a` @ scale 50 (20 km tile, 5 km Alligator cells) | :2176-2185, `cloudDetile.ts:94-102` |
| 9 | Macro carve (gated `baseShape > (1−profile) − 0.12`) | `carveWorley = 0.6·det.r + 0.4·det.g` @ 360 (2.78 km tile; 0.69/0.35 km cells); `carveThresh = (1−carveWorley)·0.45`; `carved = saturate((baseShape−carveThresh)/(1−carveThresh))` | :2197-2212 |
| 10 | Fine carve / wisp / HHF | `fine = mix(det.r, det.b, profile²)` @ 350; wisp `mix(fine, det.a, (1−smoothstep(0,0.5,profile))·0.7)`; HHF twice-fold < 12 km; `fineDelta = (fine−0.4)·0.2·detailFade`, `detailFade = 1−smoothstep(20 km, 100 km, t)`; `carved += fineDelta` | :2222-2284 |
| 11 | Skip/dense gate | `probeShape = profile − (1−carved)·K`, dense iff > 0.0001, `K = BASE_EROSION_K = 0.6` (staged; was 1.2) | :2313-2318, :483 |
| 12 | Value erosion | `shape = saturate(profile − (1−carved)·0.6)` | :2366-2372 |
| 13 | Density gamma | `density = shape^0.8 · 3000` (`DENSITY_GAMMA` :601, `uDensityMul` :1221) | :2387-2393 |
| 14 | Integration | `od = density · dtDenseEff` (dtDense 25 m near, **capped 750 m** far, :258); `T *= exp(−od)` | :1948, :2987 |
| 15 | Lighting (reads the *smooth* profile, not shape) | `ms = profile·Tsun_ms·5`; `ambient = (1−profile)^0.5·0.07` | :3048-3050 |
| 16 | Output shaping | `alpha += (1−alpha)·smoothstep(0.7, 0.95, alpha)` (ALPHA_SHARP); volumetric fades out 300→600 km as the shell fades in | :3581-3587, :3595-3600, :101-102 |

Everything below profile-gate scale is decided by **one scalar** (`coverageRaw`) plus **one isotropic 3D noise stack**.

### A.1 Type-band map (in RAW weather-map values — what an artist would paint)

The lift `cov = raw^0.6` compresses the map's upper range; converting the type thresholds back to raw values:

| raw map value | lifted coverage | cloudType | covSpan | Regime |
|---|---|---|---|---|
| < 0.134 | < 0.30 | 0 | 0 | pure stratus |
| 0.134–0.264 | 0.30–0.45 | 0→0.5 | 0–0.24 | stratus→Sc blend |
| 0.264–0.427 | 0.45–0.60 | 0.5→1 | 0.24–0.61 | Sc→cumulus blend |
| **> 0.427** | > 0.60 | **1.0** | 0.61–1.0 | pure cumulus |
| > 0.552 | > 0.70 | 1.0 | **1.0** | full-span cumulus |

Two-thirds of the map's dynamic range (raw 0.43–1.0) is a single look. And — not a coincidence, both are the same 0.6 constant — **raw 0.427 is also exactly the carvability bound at K=0.6** (see H1): the moment a region becomes pure cumulus, its mid-band becomes impossible to carve a hole in.

### A.2 Stratus path (raw < ~0.13, e.g. type ≈ 0)

- **Silhouette**: `profile = cov · stratus(alt01)`, `stratus = smoothstep(0,0.10,alt01)·(1−smoothstep(0.15,0.25,alt01))` — a thin sheet, mass 1.0–4.25 km, plateau 2.3–2.95 km (:785-787).
- **Base**: the 0→0.10 smoothstep ramp (1.0–2.3 km). Because coverage ≤ 0.3, profile ≤ 0.3 → erosion threshold `1 − profile/0.6 ≥ 0.5` → only base-noise peaks survive (56–71% of noise space is holes at profile 0.2–0.3, sim table in H1). **So "stratus" does not render as a sheet — it renders as scattered 5 km Alligator puffs**, the "plausible scattered thin type" in the screenshots. Real St (featureless overcast, tau 3-30) is unreachable in the current system: low coverage *means* strong erosion.
- **Top/edges**: erosion + wisp blend (profile < 0.5 → wispiness up to 0.7·`det.a` curl web) + fine grading mostly at the rounded `det.r` octave.

### A.3 Stratocumulus path (raw 0.13–0.43, type 0→1 blend)

- **Silhouette**: mix of stratus and `sc = smoothstep(0,0.25,alt01)·(1−smoothstep(0.45,0.65,alt01))` (:790-792) below type 0.5, blending into cumulus above. Sc's top is **hard-coded at alt01 0.45–0.65 (6.9–9.5 km — mid-troposphere, not the real Sc 1–2.5 km inversion cap!) and ignores `topAlt`**.
- At the type = 0.5 point (raw 0.264, cov 0.45): profile peaks ≈ 0.45·~0.9 ≈ 0.4 → 28–58% holes → "broken slab" of merged lumps.
- **No mesoscale cells**: real Sc organizes in 10–40 km closed/open Bénard cells; nothing in the pipeline has content between the 8.3 km column cells and the weather map's smooth blobs (H3).

### A.4 Cumulus path (raw > 0.43, type = 1)

- **Base**: `cumBase = smoothstep(0.04, 0.16, alt01)` — sharp condensation base 1.5–3.1 km, the documented Remap-survival fix (flat bottoms; :802, case #20/SHAPE_PLAN).
- **Top**: parabolic fade `cumTop = 1 − fadeX²` from `fadeStart = topAlt − 0.35` (fixed 4.55 km fade band) to `topAlt` (:803-816) — rounded dome isosurface.
- **Tower placement**: per-column `topAlt` from the column tap — but the distribution **piles at the 0.95 ceiling** in dense regions (H4): >50% of columns are *exactly* 0.95, 69% > 0.90. The "skyline" is actually a ceiling with occasional dips.
- **Walls/edges**: base dilation (±1.2·(fbm−0.4)) billows the walls; macro carve (0.45) cuts 0.7 km valleys; fine carve (±0.12 centered) + wisp for feathery edges — all folded into `carved` *before* erosion so opacity and self-shadow agree.

### A.5 Three worked examples (stage-by-stage numbers)

Constants: K=0.6, detailFade=0 (the ≥100 km screenshot regime), density = meanShape^0.8·3000, od per 750 m far-field dense step. `topAlt` uses the median column (`colSample` p50 = 0.712 → smoothstep saturates → median topAlt = 0.45+0.5·covSpan). "hole%" = fraction of noise space with shape exactly 0.

**Example 1 — raw 0.2** → cov **0.381**, type **0.178**, covSpan **0.022**, topAlt ≈ 0.46 (fixed):

| alt01 (km) | heightProfile | profile | hole% | mean shape (σ) | od/750 m |
|---|---|---|---|---|---|
| 0.05 (1.6) | 0.385 | 0.147 | 66% | 0.036 (0.057) | 0.16 |
| 0.12 (2.6) | 0.846 | 0.322 | 40% | 0.118 (0.127) | 0.41 |
| 0.16 (3.1) | 0.894 | 0.340 | 37% | 0.130 (0.134) | 0.44 |
| 0.35 (5.5) | 0.291 | 0.111 | 71% | 0.024 (0.043) | 0.12 |
| 0.65 (9.5) | 0 | 0 | 100% | 0 | 0 |

Read: a broken 2–4 km deck of separated puffs, most of the slab empty. Looks right from above — matches the screenshots.

**Example 2 — raw 0.45** → cov **0.619**, type **1.0** (already pure cumulus!), covSpan **0.865**, topAlt(med) **0.883**:

| alt01 (km) | heightProfile | profile | hole% | mean shape (σ) | od/750 m |
|---|---|---|---|---|---|
| 0.05 (1.6) | 0.020 | 0.012 | 83% | 0.002 | 0.02 |
| 0.08 (2.0) | 0.259 | 0.161 | 64% | 0.041 | 0.17 |
| 0.12 (2.6) | 0.741 | 0.459 | 20% | 0.215 (0.171) | 0.66 |
| 0.16–0.50 (3.1–7.5) | 1.0 | 0.619 | **0%** | 0.357 (0.197) | 0.99 |
| 0.65 (9.5) | 0.887 | 0.550 | 11% | 0.291 | 0.84 |
| 0.80 (11.4) | 0.416 | 0.258 | 49% | 0.083 | 0.31 |

Read: **mid coverage already produces an unbroken 3–9 km slab** (0% holes through the whole mid-band). The flat base exists (holes 83%→0% between 1.6 and 3.1 km) but nothing above it breaks.

**Example 3 — raw 0.85** → cov **0.907**, type **1.0**, covSpan **1.0**, topAlt(med) **0.95**:

| alt01 (km) | heightProfile | profile | hole% | mean shape (σ) | od/750 m |
|---|---|---|---|---|---|
| 0.08 (2.0) | 0.259 | 0.235 | 53% | 0.072 | 0.27 |
| 0.12 (2.6) | 0.741 | 0.672 | **0%** | 0.409 (0.197) | 1.10 |
| 0.16–0.50 (3.1–7.5) | 1.0 | 0.907 | **0%** | 0.644 (0.197) | 1.58 |
| 0.65 (9.5) | 0.980 | 0.889 | **0%** | 0.626 | 1.55 |
| 0.80 (11.4) | 0.673 | 0.611 | **0%** | 0.348 | 0.97 |
| 0.90 (12.7) | 0.265 | 0.241 | 52% | 0.074 | 0.28 |

Read: a solid block from 2.6 to ~11.4 km with a hard density **floor** of `profile − 0.6` (= 0.307 in the mid-band; a fully-carved-away voxel still has shape 0.307 → density 1167). At od 1.58/step, transmittance dies in 1–2 steps (~1 km) — **the camera only ever sees the smooth profile envelope surface**, modulated ±0.197 by the 5 km base cells. That *is* the quilted duvet.

---

## Part B — Why thick clouds read as porridge (ranked root causes)

### H1 — Value-erosion saturation: K=0.6 makes the entire upper half of the map physically hole-free (PRIMARY)

**Mechanism.** `shape = saturate(profile − (1−carved)·K)` can only reach 0 if some reachable `carved` satisfies `carved ≤ 1 − profile/K`. `carved = 0` **is** reachable (7.3% of macro noise space; sim: carved mean 0.561, σ 0.329, 7.3% at exactly 0, 15.7% at exactly 1). So the carvability bound is simply:

> **A hole is possible iff `profile ≤ K`.** With K=0.6 and `heightProfile=1`: `raw^0.6 ≤ 0.6` ⟺ **raw ≤ 0.427**. Every map texel above 0.427 produces a mid-band that NO noise value can zero — and worse, a positive density floor `profile − 0.6` everywhere in it.

**Numbers** (Monte-Carlo over the real composed noise, detailFade=0; "Nubis form" = `saturate(carved − (1−profile))`, i.e. K=1):

| profile | K=0.6 hole% / mean | K=1.2 hole% / mean | Nubis hole% / mean |
|---|---|---|---|
| 0.2 | 58% / 0.056 | 73% / 0.043 | 70% / 0.045 |
| 0.4 | 28% / 0.170 | 58% / 0.111 | 52% / 0.123 |
| 0.6 | 7% / 0.337 | 43% / 0.210 | 34% / 0.237 |
| 0.8 | **0% / 0.537** | 28% / 0.339 | 18% / 0.385 |
| 0.9 | **0% / 0.637** | 22% / 0.414 | 12% / 0.471 |
| 1.0 | **0% / 0.737** | 16% / 0.496 | 7% / 0.561 |

Field contrast at profile 0.9: K=0.6 → σ/mean = **0.31**; K=1.2 → 0.81; Nubis → 0.67. The K=0.6 field is a low-contrast plateau; combined with od≈1.6/step opacity saturation and `ALPHA_SHARP` (:3581), all remaining variation compresses toward uniform white.

**The staged change 1.2 → 0.6 made porridge strictly WORSE** (holes at profile 0.9: 21.6% → 0.0%; floor: none → 0.31). Why it was changed: **undocumented** — the diff touches only the value; the surrounding comment still describes the 2026-06-18 "0.25 → 0.45" rationale. Context: `code_marcher.md` flagged K=1.2 as contradicting its own K<1 design comment; the review doc records `K 1.2→0.1` *tried and falsified* for shell Bug A; and the Q2 reference-look decision was "pull the volumetric TOWARD the overlay (bright/full)" — 0.6 is most consistent with a fuller/brighter-volumetric tuning for the near/far handoff (commit 7db0ce4 "brightness transition fix cloud far - near" is the neighbouring work). It restores the documented K<1 semantics, but the cost quantified above was invisible without this arithmetic.

**Falsification (cheap, in order).** (1) `DEBUG_VIZ='eroded'` over a dense deck at the screenshot distance — expect NO black pixels and a visible ~0.3 floor. (2) One-line `BASE_EROSION_K` 0.6→1.2, reload — expect gaps/texture to reappear in the thick deck (and thin regions to get sparser). (3) One-line Nubis-form test: `shape = saturate(baseShapeCarved − (1−dimProfile))` — **must change :2370 AND the probeShape gate :2313 together** (case #13 gate law) — expect discrete bodies at every coverage with the deck still ~93% closed at cov→1.

**Does Weather Map v2 fix it?** **No.** The plan (§4.2) deliberately preserves the composition form (`profile = coverage·LUT`, then the same K erosion) per case #20 — it would inherit the porridge wholesale. **Design fix:** restore the Nubis relationship where erosion strength never dies: K=1 (exact Nubis), or make erosion **coverage/type-dependent** (e.g. `K = lerp(0.7, 1.1, convectivity)` so stratiform sheets stay smooth and convective fields stay carved), or adopt Frostbite's LUT G-channel = per-type erosion amount (`docs_references.md` already recommends this). Case #20's floater guarantee (`shape ≤ profile`) survives all of these — it only requires the *subtractive* form, not K<1.

### H2 — The coverage coupling is weaker than Nubis's, and the γ-lift eats the map's dynamic range (PRIMARY, with H1)

**Mechanism.** Side by side:

- **Nubis 2017/2022:** `density = saturate(noise − (1 − coverage·verticalProfile))`. The threshold `1−profile` stays ≥ 0 for all coverage; noise keeps slope-1 authority over the silhouette all the way to profile=1 (holes: 7% at profile 1.0 with our noise). Coverage *inflates/deflates* bodies; the last few % of holes close only at exactly full envelope. Discrete towers at high regional coverage additionally come from the **coverage field itself** (2017 G channel = Perlin-Worley "isolated islands with connective tissue") — placement lives in the 2D map, not just the 3D noise.
- **Ours:** `shape = saturate(K·(carved − (1 − profile/K)))` — algebraically Nubis with the threshold slope steepened to 1/K and the output scaled by K. K=0.6 → threshold hits zero at profile 0.6 and goes *negative* beyond (the floor). On top, `coverage = raw^0.6` (:2022) lifts the input: the raw interval [0.43, 1.0] — 57% of the map's range — maps to the hole-free regime. The lift exists purely for Remap survival of the old K; with a Nubis-form erosion it becomes unnecessary.

Hole-frequency scaling: Nubis ∝ `CDF_noise(1−profile)` — smooth, positive everywhere; ours-K0.6 ∝ `CDF_noise(1−profile/0.6)` — hits 0 at profile 0.6. **Nubis preserves discrete towers at high coverage; ours cannot.**

**Falsification.** Same one-liner as H1(3). Additionally paint/patch a synthetic weather map with hard 0/1 island structure (or multiply `coverageRaw` by a 10–40 km cellular mask, see H3) and compare tower discreteness.

**Weather Map v2 fix?** Partially — §4.1 keeps the shader `pow(0.6)` "for Remap-survival as today". **Amend:** with the erosion fixed, move any gamma into the baker and let the shader consume linear coverage; document the carvability bound `profile ≤ K` as a hard design constraint on channel encoding.

### H3 — Single-scale isotropic base noise + the missing mesoscale octave (PRIMARY for "no cellular organization / one lump scale")

**Mechanism.** The complete spatial spectrum available to shape a dense region today:

| Source | Tile | Feature size | Anchor |
|---|---|---|---|
| base volume R (Alligator) | 20 km | **~5 km** caps | uBaseScale=50, :75, :1234 |
| base FBM G/B/A | 20 km | 2.5/1.25/0.6 km | :2180-2183 |
| macro carve 0.6r+0.4g | 2.78 km | 0.69/0.35 km | CARVE_SCALE=360, :487 |
| fine carve / wisp | 2.86 km | 0.71/0.18/0.36 km | :508 |
| column tap (topAlt) | 33 km | 8.3 km | uColumnScale=30, :76 |
| weather map | planet | ≥ ~50 km effective (Blue Marble dense decks are smooth; 4.9 km/px nominal) | earth.ts:427 |

**Nothing exists between 8.3 km and the map's smooth blobs.** Real Sc decks organize at 10–40 km (closed/open Bénard cells) and real cumulus fields have 2–10 km spacing *with clear sky between* (`web_meteorology-datasets.md`). Our base field can't supply the gaps either: the Alligator metaball-max is a "mostly full" field (dilated baseShape mean 0.675, **15.7% of space clamped at exactly 1.0**, holes are thin creases, not sky). And it is **isotropic in 3D** — identical statistics vertically and horizontally — so all vertical asymmetry (flat base, structured top) must come from the analytic profile alone; the noise fights it. At range, the visible modulation reduces to exactly one scale: the 5 km caps (0.7 km carve cells are ~1 dense step at the 750 m far cap — integrated away; fine octaves faded, H5), repeating on a 20 km tile. **Uniform rounded lumps at one scale = the literal render of this spectrum.**

**Falsification.** (1) `DEBUG_VIZ='baseShape'` from above a dense region — expect wall-to-wall pale field with thin creases (no sky-scale gaps). (2) Cheap preview: multiply `coverageRaw` (or `coverage`) by a synthetic 10–40 km cellular field (one extra 2D noise tap or a hand-painted test texture) — expect immediate cellular deck organization with clear lanes.

**Weather Map v2 fix?** Mostly yes — §4.7 step 6 injects bake-time sub-grid detail. **Amend:** promote "Sc-cell hints" from a *hint* to a **required mesoscale-organization octave** (10–40 km cellular/streets, with true zeros for clear-sky lanes, respecting the feature-scale-vs-viewing-distance law ≥5 km), plus Nubis-2017-style island structure in the coverage channel for convective regions. The runtime deliberately keeps no noise at this band — so if the bake doesn't carry it, nobody does. Anisotropic (vertically-squashed) base noise remains a later, bake-lockstep option; with profile+erosion fixed it may be unnecessary.

### H4 — Type/height uniformity: dense regions are one slab at one ceiling (STRONG SECONDARY)

**Mechanism, two stacked collapses:**
1. **Type collapses**: `cloudType = 1` for every raw > 0.427 (A.1). Whole dense regions are pure cumulus with identical profile shape.
2. **topAlt collapses**: the column formula `smoothstep(0.3, 0.7, colSample)` was designed for **pure Perlin clustered at 0.5** (the :2045-2054 comment still says so), but `baseVolume.r` has been the **Perlin-Worley hybrid** since the R-channel rework — sim percentiles p10/p50/p90 = **0.481 / 0.712 / 0.894**, mean 0.697. The smoothstep saturates at 1 for every colSample ≥ 0.7, i.e. for **the majority of columns**. In covSpan=1 regions: **topAlt median = 0.95 exactly; 69% of columns > 0.90; only 6.8% < 0.60** (topAlt "variance" σ=0.128 is a pile at the ceiling, not a skyline). Result: dense regions form one continuous slab with tops at 13.35 km, dipping occasionally at 8.3 km-cell boundaries — an *inverted* skyline. No towers-taller-than-wide, no variance between neighbours.

This is also the third documented recurrence of the smoothstep-on-noise-distribution trap (`CLOUD_DEBUGGING_LESSONS` "bimodal bands") — this instance caused by a *channel semantics change* under an unchanged formula.

**Falsification.** `DEBUG_VIZ='topAlt'` over a dense region — expect near-uniform white. One-line: replace `smoothstep(0.3,0.7,colSample)` with a linear remap matched to the hybrid's actual range, e.g. `saturate((colSample − 0.48)/0.42)` — expect an actual tower skyline (linear per the bimodal lesson). Mirror in `cloudLightVolume.ts:312-315` if kept beyond a test.

**Weather Map v2 fix?** Yes — B channel (topHeight) + G (convectivity) remove both collapses and delete the column tap (−1 tex3D/step). **Amend:** the §4.7 bake must inject **tower-height variance** in dense regions with a *linear* noise mapping and verify the resulting histogram (target: dense-region p10–p90 topHeight span ≥ 4 km, vs today's degenerate pile) — otherwise the LUT reproduces the same ceiling-slab from data (ERA5 cloud-top in a closed deck is also flat).

### H5 — DETAIL_FADE leaves the screenshot's mid-ground macro-only (SECONDARY, the "soft everywhere" term)

**Mechanism.** At the symptom's viewing distance, the fine stages are already off: HHF is zero beyond **12 km** (:557); `detailFade = 1−smoothstep(20 km, 100 km, t)` → 0.84 at 40 km, 0.5 at 60 km, **0 at ≥100 km** (:591-592) — and it removes FINE_CARVE *and* WISP together (fineDelta ±0.12 max, vs. the H1 floor of 0.31 — even at full strength the fine octave cannot punch through the floor in dense regions). What survives at range: 5 km base caps + 0.7 km carve cells sampled at 750 m dense steps (≈1 sample/cell — averaged to mush) at 20 km tiling. This is the deliberate case-#22 anti-flicker amplitude fade (a "LOD deletion" per case #15's rule) — necessary, but it defines the mid-range look.

**Falsification.** A/B `DETAIL_FADE_FAR` 0.1 → 0.25 at a 50–150 km view: expect more mid-range texture and *measure* the distant-flicker regression this fade exists to prevent (case #22) before keeping anything.

**Weather Map v2 fix?** No (orthogonal). **Design addition:** fade fine detail to a **mid-frequency floor** instead of zero (review ISSUE 3 #4), or band-limit by mip rather than amplitude (constrained by the case #16 Data3DTexture patch), and let the incoming mesoscale octave (H3) carry structure at range — mesoscale features (10–40 km) are footprint-resolvable exactly where the sub-km octaves are not.

### H6 — Softening/uniformity stack: gamma, alpha sharpening, profile-driven lighting, shell handoff (TERTIARY, polish)

Individually small, all pushing the same direction:
- **DENSITY_GAMMA 0.8** (:601, :2387-2393): raises mids (0.31→0.39, 0.64→0.70), compresses relative contrast (a 3× shape ratio becomes 2.4×) — by design ("solid body"), but on a floor-filled field it's uniformity on uniformity.
- **ALPHA_SHARP** (:3581-3587): every α ≥ 0.7 is pushed toward 1 — merges distinct lumps into one opaque sheet (correct for the horizon-leak bug it fixes; costly for deck texture).
- **Lighting reads the smooth profile, not the eroded shape**: `ms = profile·Tsun_ms·5`, `ambient = (1−profile)^0.5·0.07` (:3048-3050) — shading across a dense deck varies only with the envelope; and the baked light volume's density is **multiplicative** (`baseDilate·coverage·profile`, *no K erosion at all*, `cloudLightVolume.ts:291-355`) — a systematically different field from what the camera sees, so self-shadow cannot restore the missing silhouette contrast either.
- **Shell handoff check (screenshot 2)**: from "a few km above the deck" (camera alt 16–20 km), the horizon sits at √(2Rh) ≈ 450–505 km. `uShellOpacity` = (alt−14)/14 ≈ 0.14–0.43 (earth.ts:76-77) and the shell's distance fade spans 300→600 km (:101-102) — so **the mid-ground porridge (20–300 km) is genuinely the MARCHER** (H1/H3/H4/H5 apply), while the far rim is the shell, whose `smoothstep(0.05, 0.35, maxShape)` firm-up (:111-112, :933-936) binarizes an already hole-free field (mean maxShape 0.64 at cov 0.9) into a featureless white band — the same porridge by a different route (it shares K=0.6, :926-928).

**Falsification.** `DEBUG_VIZ='lightingOnly'` (smooth shading confirms profile-driven light); flip `uShellOpacity`→0 temporarily to attribute mid vs far field; ALPHA_SHARP_LO 0.7→0.95 A/B for the sheet-merging contribution.

**Weather Map v2 fix?** Mostly orthogonal. §4.3's per-type DENSITY_GAMMA/MS ramps help; add: far-shell opacity must preserve map-carried cell gaps (don't smoothstep-binarize), and revisit ALPHA_SHARP once the field actually contains holes.

---

## Verdict

**Dominant causes, in order:**
1. **H1/H2 — the erosion semantics.** At the staged K=0.6, every region above raw coverage 0.427 has a mathematically hole-free mid-band with a density floor of `profile − 0.6`; opacity saturates in ~1 km so the camera sees the smooth envelope with ±0.2 modulation. The staged 1.2→0.6 change (undocumented, likely near/far brightness matching) converted "over-eroded but structured" into "unbreakable porridge".
2. **H4 — one slab at one ceiling.** cloudType=1 everywhere dense + topAlt piled at 0.95 (69% of columns > 0.9; smoothstep saturating on a mean-0.7 hybrid the formula believes is mean-0.5 Perlin) — no tower skyline for the erosion to reveal even if it could.
3. **H3 — the missing mesoscale octave.** No content between 8.3 km and the smooth map; the only surviving modulation at range is the 5 km Alligator caps on a 20 km tile → "uniform rounded lumps at one scale", no 10–40 km cells, no clear-sky lanes.

**Falsification sequence (run in this order; ~1 line each):**
1. `DEBUG_VIZ='eroded'` over the thick deck at screenshot distance → expect a ≥0.3 floor, zero black. *(Confirms H1's floor.)*
2. `BASE_EROSION_K` 0.6→1.2, reload → expect gaps return in the thick deck (≈22% hole space at profile 0.9), thin regions sparser. *(Confirms K is the porridge lever; quantifies the staged regression.)*
3. Nubis-form one-liner — `shape = saturate(baseShapeCarved − (1−dimProfile))` at :2370 **and** :2313 (gate lockstep, case #13) → expect discrete bodies at all coverages, deck ~93% closed at cov→1. Judge whether residual 7% holes at full coverage read better than today's floor. *(Decides the H1 design fix.)*
4. `DEBUG_VIZ='topAlt'` dense region → expect near-white. Then linear remap `saturate((colSample−0.48)/0.42)` → expect a skyline. *(Confirms H4; result feeds the topHeight bake spec.)*
5. Multiply coverage by a synthetic 10–40 km cellular mask → expect instant mesoscale organization. *(Confirms H3; previews the bake's organization octave.)*
6. `DETAIL_FADE_FAR` 0.1→0.25 A/B at 50–150 km + flicker check. *(Sizes H5's contribution against its case-#22 cost.)*

Expected combined outcome: 2+4+5 together should make a dense region read as a cellular deck of discrete flat-based towers with varied tops — the falsifiable definition of "not porridge".

## Implications for CLOUD_TYPES_PLAN.md (concrete amendments)

1. **§4.2 (profile LUT) — add an erosion-semantics precondition.** The plan preserves the case-#20 composition form; this analysis shows the *form's K parameter* is the top porridge cause. Add a step (Phase 1.5 or fold into Phase 2): restore Nubis-form erosion (K=1) or make K a function of convectivity (`lerp(~0.8 stratiform-smooth, ~1.1 convective-carved, conv)`), or adopt the Frostbite LUT **G channel = erosion amount** (already suggested in docs_references.md). Keep `shape ≤ profile` (floater guarantee) — it constrains the subtractive form, not K<1. Update the skip-gate (:2313) in the same commit (case #13).
2. **§4.1 (R channel) — drop "shader keeps pow(0.6)".** The lift exists to survive an erosion threshold that the K fix changes; with Nubis-form erosion, consume linear coverage and let the baker own the histogram. Document the hard constraint: *hole formation requires `coverage·profile ≤ K` somewhere in every deck that should read broken.*
3. **§4.7 step 6 — promote the mesoscale octave.** Bake-time injection must include a first-class 10–40 km organization field with true zeros (closed/open Sc cells, cloud streets, cumulus island structure à la Nubis 2017 G-channel), not "hints". Runtime has nothing between 8.3 km and map scale — the bake is the only owner of this band. Respect the ≥5 km feature-scale law and the linear-remap (anti-bimodal) rule.
4. **§4.2 (topHeight) — add a variance acceptance test.** Current system: >50% of dense columns pinned at exactly topAlt 0.95. The bake must inject linear tower-height noise and verify dense-region p10–p90 topHeight span (target ≥4 km); ERA5 alone will reproduce a flat ceiling in closed decks.
5. **§4.3 — add the K/erosion ramp to the per-type knob list** (alongside WISP/FINE_CARVE/DENSITY_GAMMA), and note DETAIL_FADE should fade to a mid-frequency floor once mesoscale content exists at range (re-measure case #22).
6. **§4.6 (far field) — the shell must inherit the fixed erosion AND preserve map gaps.** `columnMacroCoverage` shares K (good) but `smoothstep(0.05,0.35)` firm-up binarizes; once the map carries cell structure, the firm-up must not erase it. (It also currently shares H1's zero-hole property at high coverage.)
7. **Record two code-comment corrections for Phase 0/1:** `colSample` is the Perlin-*Worley hybrid* (mean ≈0.7), not Perlin (mean 0.5) — the :2045 comment and the smoothstep(0.3,0.7) design assumption are stale (moot once the column tap is deleted in Phase 1); and `BASE_EROSION_K = 0.6`'s staged change is undocumented — whatever value survives the falsification sequence, write its rationale into the comment block (:455-483).
8. **Light-volume parity note for Phase 2:** the bake density is multiplicative (no K); once erosion semantics change, re-evaluate whether the bake should mirror the subtractive form — the larger the marcher/bake field divergence, the weaker self-shadow's ability to draw silhouette structure.

---

## Addendum 2026-07-06 — H1 falsification step 2 RUN BY THE USER (K=0.6 vs 1.2 screenshots)

Christian A/B'd `BASE_EROSION_K` 0.6 vs 1.2 from ~16-20 km above a dense deck
and provided screenshots. Result, and why it CONFIRMS (not contradicts) H1-H4:

- **K=1.2**: "patchy and less satisfying even in the highest-coverage areas"
  — visible see-through holes to terrain. As the H1 table predicts (22% hole
  space at profile 0.9), but crucially the holes read WRONG: they punch
  through the whole slab (holes-in-a-slab) rather than forming crevices
  between towers, because topAlt is pinned at the ceiling (H4) and there is
  no mesoscale organization (H3) — erosion has no vertical structure to
  reveal, so more erosion = more through-holes, not more anatomy.
- **K=0.6**: "thicker and more natural" — the closed deck reads full, at the
  cost of the floor-filled uniform-lump porridge this doc quantifies.
- Both screenshots show the SAME single lump scale (~5 km caps) — H3 is
  K-independent, exactly as ranked.

**Interpretation locked into the plan (§4.2/§6 Q8):** K was the only knob
available that traded patchy↔full, and Christian's tune to 0.6 was the right
call GIVEN the current uniform profile. Real high-coverage decks are closed
AND structured; that combination is unreachable by any K alone. Target state:
Nubis-form K≈1 (deck ~93% closed at profile→1, σ/mean 0.67 of surface
structure) + topHeight variance (crevices, not through-holes) + mesoscale
octave (cells/lanes where coverage genuinely dips). Convective K should cap
at ~1.0 (not 1.1) per this A/B. Acceptance criterion: as closed as K=0.6 at
high coverage, structured like reference photos of real decks.

---

## Addendum 2026-07-06 (evening) — Phase F complete: all six falsifications run in-app

Toggles implemented (`EROSION_NUBIS_FORM`, `TOPALT_LINEAR`(+`_MIRROR`),
`MESOSCALE_TEST` — earthClouds.ts / cloudLightVolume.ts) and run by Christian
with screenshots. Outcomes vs this doc's predictions:

- **Step 1 (eroded viz, K=0.6): H1 floor CONFIRMED** — mostly light gray over
  the dense deck, no true black; dark erosion only where profile ≤ K.
- **Step 3 (Nubis-form K=1): H1 fix VALIDATED** — deck stays ~closed but
  gains distinct masses, deep crevices, some true holes; `eroded` viz shows
  full value range incl. black. User: "more realistic already". → §4.2
  baseline = Nubis-form K=1 (decided).
- **Step 4 (linear topAlt): H4 CONFIRMED** — `topAlt` viz near-uniform white
  (ceiling pile) → varied gray; render gains height variation. Mean tower
  height drops as expected (placeholder constants; B channel owns the
  distribution from Phase 1).
- **Step 5 (mesoscale mask, with 3+4): H3 CONFIRMED** — "better height
  variation in thick cloud fields with true 0 holes in between them" = the
  not-porridge acceptance criterion MET.
- **Step 6 (DETAIL_FADE_FAR 0.1/0.25/0.9): NULL RESULT — H5 DEMOTED.** No
  static visual difference at any value. Post-hoc explanation this doc's H5
  under-weighted: fine-carve features (≤0.7 km) are sub-pixel-footprint at
  the 20-300 km viewing distances of the symptom — no amplitude of
  sub-footprint detail can alter a still frame. The fade's role is purely
  TEMPORAL (anti-flicker, case #22). H5's "mid-range mush" contribution is
  therefore negligible for the static look; the mid-frequency-floor design
  idea is deprioritized. DETAIL_FADE stays unchanged.

Net: the three dominant causes (H1 erosion / H4 height collapse / H3 missing
mesoscale octave) are each empirically confirmed AND their v2-design fixes
validated in-app before implementation. See CLOUD_TYPES_PLAN.md §3.6 for the
canonical results record + interim toggle disposition.
