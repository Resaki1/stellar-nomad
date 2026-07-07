# Adversarial review — CLOUD_TYPES_PLAN.md §4–§5 (design + migration)

*(Red-team pass 2026-07-06, run AFTER the anatomy/SC/docs-references amendments
were drafted but reviewing the pre-amendment §4/§5 text in places — all
SUGGESTED PLAN EDITS have since been applied to CLOUD_TYPES_PLAN.md, including
the two §4.2 blockers. Kept for the reasoning + verification record.)*

## SUMMARY

The synthesized design is architecturally sound: the continuous-axes channel stack, the LUT-profile mechanism, the separate cirrus layer, and the phase ordering all correctly follow the research base, and the headline perf claim (−1 tex3D / +1 tex2D per in-band step) verifies against the current tree — the column tap's only live consumer is `topAlt` (warpVec is a zero vector at every use site, `WARP_AMPLITUDE`/`_MIRROR` both 0). The km-anchoring scheme genuinely survives a slab raise, and — contrary to `docs_references.md`'s claim of a third lockstep constant — the plan's "2 lockstep constants" count is **correct** in the current tree (`SHELL_ALTITUDE_KM` and `SHELL_FADE_OFF_ALT_KM` both derive).

However, §4.2's LUT spec contains two mistakes that would silently defeat the project's own hardest-won anatomy lessons: (1) the stratiform row spec ("mass at altNorm 0.75–1.0") combined with `saturate()` normalization extrudes every stratiform sheet from its top to the slab ceiling; (2) authoring 4 anchor rows and letting texture filtering blend them is exactly the "crossfade finished profiles" anti-pattern the plan's own §3.2 identifies — intermediate convectivity values get two-bump, half-amplitude profiles that the Remap erosion deletes, relocating the binary-border symptom to LUT row midpoints. Both are one-paragraph fixes to the LUT-generator spec. §4.4 has two formula-level bugs (unclamped anvil remap goes to a negative exponent; the shear skew is circularly defined on altNorm). §5 has systemic gaps: it never mentions the two OPEN shell bugs it walks past, omits the light-volume re-bake staleness hazard entirely (verified: nothing in the bake machinery watches the weather texture or LUT), and Phase 0/1 site lists predate the staged shell work that added a third copy of the derivation chain.

On the user's #1 complaint (thick-cloud porridge): §4 *as amended by the anatomy implications* does address the three dominant causes (erosion K, topAlt ceiling, missing mesoscale octave) — but §5 currently has no phase slot for the erosion fix, and the amendments themselves miss two lockstep sites (`cloudCommon.COVERAGE_GAMMA`/`coverageToOpacity`, and the Q1/Q2 shell handoff re-tune the K change forces). Ns/deep-frontal cloud is honestly unrepresentable in v1 and the plan's "approximated from coverage·thickness" claim is circular — but Ns is not in R1's minimum list, so this needs an honesty edit, not a design change.

## ISSUES

### [blocker] [§4.2] LUT rows must be identically zero at altNorm 0 and 1, or stratiform sheets extrude to the slab ceiling
**Problem:** `altNorm = saturate((altKm − baseKm)/max(topKm − baseKm, ε))` clamps to 1 for all `altKm > topKm` and 0 below `baseKm`. Any LUT row with nonzero density at u=1 therefore renders at *every* altitude above `topKm` up to the slab outer radius. §4.2 specs the v≈0 row as "thin sheet concentrated near altNorm 0.75–**1.0**" — nonzero at the saturation boundary → every stratiform texel becomes an infinite column from its top to 14 km. Same at u=0 (density to slab floor). The current analytic curves avoid this only because `cumTop = 1−fadeX²` reaches exactly 0 at `topAlt` and stratus/Sc bands are interior.
**Evidence:** §4.2 formula + row spec; `earthClouds.ts:783-820` (current curves all →0 at their band edges); linear-filter clamp-to-edge means the *last texel*, not u=1, is the effective boundary.
**Fix:** Add a hard generator invariant to §4.2: "every row's first and last texel are 0; peaks strictly interior; verified by an automated check in the LUT script." Alternatively an explicit `If(altKm > topKm)` zero — rejected because it reintroduces hard slice tops; the row-shape invariant preserves the parabolic dome.

### [blocker] [§4.2] Filtering between 4 sparse anchor rows = crossfading finished profiles — the exact anti-pattern §3.2 documents
**Problem:** §4.2 names 4 anchor rows (v≈0, 0.4, 0.7, 1.0) in a 64-row LUT and claims "filtering across v = free continuous genus morphing (the Nubis mechanism)". It is not: Nubis 2017's mechanism *slides remap endpoints* so every intermediate type is itself a plausible profile; linear blending of two dissimilar finished curves (e.g. v0.4's mass-at-0.5–1.0 slab with v0.7's base-at-0.04–0.16 cumulus) yields a two-bump superposition at *half amplitude*. Halved profile → erosion threshold `1−profile/K` rises → mid-v regions erode to nothing or to floaters (the Remap-survival lesson, case #20/SHAPE_PLAN). Result: the binary-border symptom returns, relocated to LUT row midpoints — silently defeating the core goal.
**Evidence:** §3.2 ("type does not crossfade finished profiles"); web_nubis-decima "How the lineage blends type transitions"; docs_references case #20/flat-base Remap-survival finding.
**Fix:** Require the generator to fill **all 64 rows** by interpolating anatomical *parameters* (base-ramp position/width, plateau level, top-fade start, dome exponent) between the genus anchors — the 2017 endpoint-slide evaluated at 64 samples. Texture filtering then only bridges near-identical adjacent rows. One sentence in §4.2 + one in Phase 2's verify step ("check DEBUG_VIZ 'profile' at v-midpoints between anchors, not just at anchors").

### [major] [§4.2/§5 Phases 1/2/4] Light-volume re-bake staleness is unhandled — stale shadows after any in-place map/LUT change
**Problem:** The bake is amortized: `bakeQueued` is set only by voxel-window snaps and sun rotation past a threshold (`cloudLightVolume.ts:126-143, 432-485` — verified, nothing watches texture or LUT contents). Build-const flips reload the page (fresh bake — safe), but the plan's own recommended tuning loop (regenerate the LUT DataTexture *in place*) and any runtime map-content update serve a transmittance field baked against the OLD density → globally detached shadows until an incidental snap. Phase 2's "shadows still attached" check can pass or fail by accident of when the last snap occurred.
**Fix:** Add to Phases 1, 2 and 4: "any in-place weather-map/LUT content update must set `bakeQueued` on BOTH ping-pong sides; never fade in a never-baked side (case #18)." Add "after map swap" to Phase 2's shadow-attachment verify.

### [major] [§4.4] Wind-shear skew formula is circularly defined
**Problem:** `p += windDir · shearKm · altNorm²` — but `altNorm` requires `topKm`, which comes from the weather tap *at the skewed position*. Circular. Nubis 2017 skews by **layer** height fraction (`p += height_fraction · wind_direction · 500m`), which is geometry-only.
**Fix:** Use slab-relative `alt01²` (pure geometry) for the skew. Note the light-volume `densityAt` must apply the identical skew or baked shadows land beside the sheared clouds (lockstep).

### [major] [§4.4] Anvil exponent must use a clamped remap — unclamped it goes negative and pow explodes
**Problem:** `remap(altNorm, 0.7, 0.8, 1.0, lerp(1.0, 0.5, anvilBias))` — TSL `remap` is unclamped. At altNorm=1.0 with anvilBias=1 the exponent extrapolates to 1+3·(0.5−1) = **−0.5**; `pow(coverage, −0.5)` turns coverage 0.1 into 3.16 → a solid inverted cap at every anvil column's top, inflating the erosion envelope beyond bounds.
**Fix:** Specify `remapClamp` (or saturate the exponent into [lerp(1,0.5,bias), 1]) in the plan text.

### [major] [§4.2] `thickness(convectivity, topKm)` is load-bearing and unspecified; "encode the shape inside the LUT rows instead" is misleading for stratiform
**Problem:** A span-normalized row *cannot* encode constant physical thickness — the row's physical extent scales with `topKm − baseKm`. For St/As (roughly constant ~0.5–3 km thickness regardless of top altitude) the entire anatomy therefore lives in the `thickness()` function that derives `baseKm`, which the plan waves at but never specs. It must also be shared lockstep (marcher, light volume, shell). Additionally, `topKm ≤ baseKm` (low tops with LCL-anchored convective base) degenerates via the ε clamp.
**Fix:** Spec `thickness()` concretely (a small function of conv and topKm, fitted from the CALIPSO/CloudSat step already planned), place it in cloudShared, and add a baker validation rule `topKm ≥ baseKm + minThickness` alongside the floater clamp.

### [major] [§4.1/§4.2] topKm above the slab outer radius produces the documented "sliced tops" regression
**Problem:** B channel spans 0–18 km; the slab is 14 km (16 after Phase 6). Any texel with topKm in (outerKm, 18] has its profile truncated mid-dome at the slab ceiling — a flat iso-altitude slice, the precise anatomy failure §3.0 says "MUST survive". Real ITCZ Cb in ERA5 data will hit 16–18 km, so Phase 4 bakes this in planet-wide along the ITCZ.
**Fix:** Baker validation rule: clamp topHeight to (outerKm − margin) per planet at bake time. Phase 6's raise to 16 km reduces but does not remove the clamp.

### [major] [§4.1 + anatomy amendments] The erosion/lift amendments miss two lockstep sites: cloudCommon and the Q1/Q2 shell handoff re-tune
**Problem:** Amendment 2 drops the shader `pow(0.6)`; amendment 1 changes K. Neither names: (a) `cloudCommon.ts:140-150` `COVERAGE_GAMMA`/`coverageToOpacity` (the shell's area-match curve must match the marcher's lift) and the shell's own `pow(COVERAGE_GAMMA)` at `earthClouds.ts:904`; (b) the staged K=0.6 was plausibly part of the near/far brightness/area matching (commit 7db0ce4's neighbouring work) — restoring K≈1 or conv-dependent K changes the volumetric's apparent coverage that `SHELL_OPACITY_LO/HI` and the 300–600 km handoff were tuned against.
**Fix:** Co-change `COVERAGE_GAMMA`/`coverageToOpacity` + shell lift in the same commit; add "re-verify near/far handoff at blend≈0.5 and re-tune SHELL_OPACITY_*" to the erosion-fix checklist.

### [major] [§5] The migration plan never mentions the two OPEN shell bugs it walks past
**Problem:** Bug A (stratus absent from shell) and Bug B (shell flicker). The plan's Phases 1–2 *are* the structural fix for both (topHeight+LUT solves A; a shell consuming only smooth `weatherAt` fields + full-slab profile term with no 3D-noise taps solves B **and** deletes the shell's current ~7 tex3D/pixel — a perf win §4.10 doesn't claim). Phase 2's relocated stratiform rows re-expose Bug A's discrete-altitude sampling even if hot-fixed first.
**Fix:** Explicit "shell bugs A/B strategy": park the hot-fix, fold both into Phases 1–2 by making the shell a first-class consumer of `weatherAt` + an analytic full-slab integral of the LUT row; claim the shell tex3D deletion in §4.10.

### [major] [§5 Phase 1] Column-tap deletion consumer list is incomplete for the current tree
**Problem:** Verified consumers today: marcher `colSample`→topAlt (`:2062-2104`), `warpVec` zero-vector at `:2175, :2634, :2700`; light volume `colTap` (`cloudLightVolume.ts:308-342`); shell `deriveTopAlt`/`columnMacroCoverage` (`:855, :907-911`); `colSampleMid` diagnostic (`:1663-1666`); DEBUG_VIZ 'topAlt'/'baseColumn'. Deletion is safe (no live warp) but shell + light volume must migrate to the B channel in the same commit or topAlt semantics diverge near/far/shadow.

### [major] [§5 Phase 0] Site list predates the staged shell work; absorb Q2b
**Fix:** Shell helpers (`:848-937`) as the cloudShared seed; macro-carve = 5 sites; absorb CLOUD_REVIEW's deferred Q2b; name the TSL hazards.

### [major] [§4.1] The Ns story is circular; state the v1 alias honestly
**Problem:** "Optical depth approximated from coverage·thickness" adds zero information (thickness is itself derived from conv+topKm); §3.4's Ns decode requires τ, a channel not in the map.
**Fix:** "Ns renders as As in v1; the dark rain-bearing look requires the optical-depth channel (weather map B)." Strengthens the case for τ as the next channel (open question 1).

### [major] [§4.5] Cirrus shell reusing the deck-shell machinery is invisible from below — the primary gameplay viewpoint
**Problem:** The existing shell is FrontSide (culled from inside) and fades out below 28→14 km. A cirrus shell built the same way vanishes for any camera under ~10–11 km — flying under a cirrus veil is the classic sky. The look-up case is unaddressed and is arguably more common than the look-down occlusion case.
**Fix:** Spec the from-below representation: DoubleSide (or BackSide twin) with depthTest; fade only when the camera crosses the cirrus altitude band (no deck-style altitude fade-out); explicit `mesh.renderOrder` via `onMount` (ExtraMeshDef has no renderOrder field; two concentric transparent depthWrite=false spheres tie in three.js's sort); WebGPU pipeline pre-warm; auto-mip + real mip chain + footprint-scale content per Bug B.

### [minor] [§4.2] LUT delivery: generated PNG conflicts with the DataTexture-singleton requirement
PNG through tier texture records delays tier readiness, duplicates per tier, hits the bind-group reassignment hazard. Generate rows in TS at startup into a process-lifetime DataTexture singleton (getAtmosphereLUTs pattern). Marcher LUT/weather taps `.level(int(0))`; shell taps auto-mip.

### [minor] [§4.1/§5 Phase 4] sRGB footgun
Verified: `ktx info public/textures/earth_clouds_8k.ktx2` → `KHR_DF_TRANSFER_SRGB`, while `convert-to-ktx2.sh` batch mode special-cases earth_clouds as **linear** (lines 133-136). Re-running `--all` today silently changes the live cloud look; all raw-value tables in cloud_shape_anatomy.md (e.g. the 0.427 bound) are in *decoded* terms. Specify comparisons in sampled-value (post-decode) space.

### [minor] [§5 Phase 1] B channel is inert in stratiform regions until Phase 2
The analytic stratus/Sc curves ignore topAlt entirely; in Phase 1 only the cumulus end responds to painted topHeight. Scope acceptance criteria accordingly.

### [minor] [§4.3] The envelope-crossover formula is backwards at conv→0 and fights the WISP ramp
`smoothstep(conv·0.5−0.1, conv·0.5+0.1, altNorm)` at conv=0 selects billowy everywhere for stratiform while WISP_AMOUNT pushes stratiform maximally wispy. Fix: crossover = `lerp(1.2, 0.4, conv)` (stratiform never reaches billowy) or gate the envelope term by conv.

### [minor] [§4.1/§5 Phase 1] weatherAt must materialize ONE fetch; mid-tier wrapS
The provider must call `texture()` once and return swizzles of the same node (or `.toVar()` the vec4) — separate `texture()` calls per accessor are distinct TSL nodes and can compile to 4 samples. `wrapS=RepeatWrapping` for both tiers.

### Also (applied separately): §3.3 two-era Star Citizen rewrite; Q6 closed; Q7 SHAPE_PLAN reversal; SDF-skip + lazy-shadow nuggets as future perf levers.

## CONFIRMATIONS

- **−1 tex3D / +1 tex2D accounting is sound.** Verified `WARP_AMPLITUDE=0` (`earthClouds.ts:315`) and `WARP_AMPLITUDE_MIRROR=0` (`cloudLightVolume.ts:171`); warpVec consumed only as a zero vector; `colSample`'s only live output is topAlt. The LUT tap replaces it 1:1 at the same frequency; 64² tex2D cheaper than 128³ tex3D. CLOUD_REVIEW PERF lever #3 done-by-supersession.
- **"2 lockstep constants" for the slab raise is CORRECT** — `SHELL_ALTITUDE_KM = CLOUD_OUTER_ALTITUDE_KM` (`:87`, derived), `SHELL_FADE_OFF_ALT_KM = CLOUD_TOP_ALTITUDE_KM` (`earth.ts:76`, derived). docs_references' "third lockstep site" overcounts; only `SHELL_FADE_FULL_ALT_KM=28` is an independent judgment value.
- **km-anchoring survives the slab raise** — substituted chain verified end-to-end; the case-#20 envelope-is-presence architecture is preserved (modulo the two LUT blockers).
- **Anvil and cirrus formulas are transcribed verbatim-correct** vs the Nubis deck extractions — issues are clamping/parameterization, not transcription.
- **§4.5's pass-structure claims check out** (Pass 1 → analytic fog ~free with limb-ring caveat; Pass 3 depthTest=false paints over shells; tFront mitigation feasible).
- **The provider seam exists exactly as §3.0 describes**; the `uCloudUvOffset` duplication footgun is real and open (`earthClouds.ts:985` and `:1168`).
- **Ground shadow can stay coverage-only.**
- **No phase secretly depends on a later one** (anvil works within the 14 km slab pre-Phase-6, just cramped).
- **Porridge:** with the anatomy amendments + these edits, all three dominant causes are addressed, provided the erosion fix lands inside Phases 1–3 and the mesoscale/variance content goes into the Phase-1 SYNTHETIC map rather than waiting for Phase 4.
