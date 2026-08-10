# Clouds: Stellar Nomad vs. @takram/three-clouds — Comparison & Prioritized Roadmap

**Status: ANALYSIS (2026-07-20).** Source-grounded comparison of our volumetric
cloud system against `@takram/three-clouds` (part of
[takram-design-engineering/three-geospatial](https://github.com/takram-design-engineering/three-geospatial),
commit `b012ad0`, MIT). Goal: identify what they do better that we should copy,
what we already do better that we must not regress, clever tricks worth stealing,
and a roadmap ranked by impact (then effort/risk), tied to Christian's ranked
pain points: **cloud shapes > cloud types > ground shadows > performance.**

This doc is self-contained so work can resume after a compaction. It was built
from (a) full reads of takram's `README.md`, `clouds.glsl`, `DensityProfile.ts`;
(b) structured briefs of both systems' shape/lighting/shadow/temporal subsystems;
(c) our own `docs/CloudTypesResearch/cloud_shape_anatomy.md` diagnosis. Takram
line refs are against their repo tree; ours are symbols in our tree (re-grep, they
drift). Takram clone used for this analysis lived in scratch, not committed.

---

## 0. TL;DR — the 8 highest-leverage takeaways

1. **Our "unnatural towers" trace to a *coupled* erosion+gamma mis-tune, not one
   bad constant.** Our own `cloud_shape_anatomy.md` (Phase F) validated *Nubis-form
   erosion K=1* + *linear topAlt* + *mesoscale octave* as the porridge fix, and the
   code defines it (`EROSION_NUBIS_FORM=true` → `BASE_EROSION_K_EFF=1.0`,
   `earthClouds.ts:639-640`) — **but that value is only used when `PER_TYPE_DETAIL`
   is off.** With it on (it is), `erosionKForType` returns
   `mix(EROSION_K_ST 0.5, EROSION_K_CU 0.7, conv)` (`:730-731, 1118-1122`), a ramp
   deliberately *centered on the old legacy `0.6`* (`mix(0.5,0.7,0.5)=0.6`, per the
   documented "midpoint = legacy constant" rule `:705-707`) — so the Phase-F K=1
   decision was **never propagated into the endpoints**. The convective end `0.7`
   leaves a density floor, and `DENSITY_GAMMA_CU=0.1` (`shape^0.1`, `:735`) then
   flattens the core to near-solid; the two reinforce a solid-but-featureless tower.
   **Fix = a *coupled* re-tune (raise convective K **and** soften convective gamma
   together; keep stratiform K<1, which is intended), gated on first verifying the
   topHeight-variance + mesoscale fixes actually fire on the real ERA5 map** (they
   were tuned on the synthetic map). Not a one-liner — see §5 #1. Risk med, not low.

2. **Takram's clean cumulus is 90% edge/detail treatment, not tower simulation.**
   They render modest fair-weather cumulus/stratocumulus *decks* with excellent
   silhouettes; they do **not** grow cumulonimbus towers at all (fixed 4-layer
   model). So "their cumulus look better" is largely: (a) erosion-by-remap that
   keeps cores solid while only rounding edges, (b) a biased-semicircle
   shape-altering height gradient, (c) height-dependent detail (fluffy top /
   whippy bottom), (d) turbulence domain-warp confined to cloud bottoms. We
   already have (a). Adopting (c)+(d) is cheap and high-impact. (b) we approximate
   with the profile LUT. **Match their *ordinary cumulus* quality first; treat
   convincing Cb towers as a separate, harder track** — our towers read wrong
   partly because we attempt a harder thing than they do.

3. **Ground-shadow sharpness (pain #3) is a single root cause: no cascades.**
   Our Beer Shadow Map is one 512² map over a 3000 km window ≈ **5.9 km/texel**.
   Takram's is a 3-cascade, texel-snapped CSM (512²/cascade) so the near cascade
   packs texels into a few km near the camera → orders-of-magnitude sharper.
   **Cascaded (or at least one tight camera-following near-cascade) BSM is the
   fix.**

4. **We are genuinely ahead where takram has open TODOs — protect these.**
   Takram's own README lists as *unbuilt/planned*: "rendering views from space",
   "global cloud coverage." It flickers-then-fades from orbit (hard 200 km march
   cap, no far-field fallback). Its weather is one globally-tiled texture
   (cube-sphere seams) → looks the same everywhere. **Our from-space analytic
   shell (Monte-Carlo opacity LUT, zero per-frame noise → no flicker), regional
   ERA5 weather map, and the continuous convectivity/type axis are real
   advantages. Do not regress them.**

5. **Steal turbulence domain-warp at cloud bottoms.** One curl-noise texture,
   displacement weighted to the lower ~30% of cloud height, added to the shape
   sample position → wind-sheared wispy bases with crisp tops. Cheap, big
   naturalness win, no re-bake if we reuse an existing curl channel.
   (`clouds.glsl:134-143`.)

6. **Steal STBN (spatiotemporal blue noise) as the jitter source.** Takram uses
   STBN everywhere (march offset, PCF rotation, SVS). It's *why* they can afford
   1/16-res temporal upscaling and 512² shadows. We use Bayer. Better jitter →
   better reconstruction → headroom to push our sparse divisor past 1/4 (which we
   backed off from for near/fast clouds). This is the keystone perf enabler.

7. **Steal the energy-conserving analytic scattering integral + octave
   multi-scatter.** Frostbite's per-step `(L - L·T)/σ` integral decouples
   brightness from step size (bigger steps, no darkening = perf). Their 8-octave
   multi-scatter is more energy-plausible than our single `pow(Tsun,MS_COEF)·MS_GAIN`
   fudge and would let us drop the global `MS_GAIN` hack.

8. **Cloud *types* (pain #2): we're conceptually ahead; the missing piece is
   coexisting decks.** Our continuous convectivity axis + 64-row genus profile
   LUT is more expressive and more procedural-planet-ready than takram's 4 scalar
   `a·e^(bη)+cη+d` profiles. What takram has that we don't yet ship: **multiple
   overlapping decks in one march** (e.g. cirrus veil above a cumulus field),
   marched as a `vec4`. That directly serves requirement R2.

---

## 1. Executive summary — who's ahead per dimension

| Dimension | Ahead | Why |
|---|---|---|
| **Cloud shape / cumulus naturalness** | **Takram (today)** | Erosion-by-remap keeps solid cores + biased-semicircle dome + height-dependent detail + turbulence bottoms. Ours regressed via shipped K=0.5/0.7 + gamma 4.0/0.1. We have the same Remap primitive and a *validated* fix already scoped. |
| **Cloud types / vertical profile** | **Ours** | Continuous convectivity axis (map G) + 64-row genus LUT interpolating anatomy params. Takram = 4 scalar analytic terms, one monotone curve. |
| **Multiple coexisting decks (cirrus over cumulus)** | **Takram** | 4 layers packed in weather RGBA, marched as vec4, with empty-gap interval skipping. We have a cirrus channel but no separate deck yet. |
| **Regional weather variety** | **Ours** | Real ERA5 equirect map (coverage/convectivity/topHeight/cirrus) + fraction-to-placement. Takram = one texture tiled 100× via cube-sphere UV (seams; looks uniform globally; "global coverage" is their TODO). |
| **Ground shadows (sharp/precise)** | **Takram** | 3-cascade texel-snapped CSM + BSM analytic optical depth + SVS + shadow-resolve TAA + horizon-gated PCF. Ours = single 512² BSM @ ~5.9 km/texel. |
| **Cloud self-shadow** | **Mixed** | Both use a BSM + a short local sun march. Ours adds a baked light-volume froxel + detail probe correlated to the carve noise; theirs adds the tail-extrapolation trick. |
| **Lighting / scattering realism** | **Takram (slightly)** | 8-octave energy-conserving multi-scatter + analytic scattering integral + Beer-Powder + dual-lobe HG (or fitted Mie). Ours = dual-lobe HG + `pow(Tsun,MS_COEF)·MS_GAIN` (global fudge) + powder. |
| **Atmosphere coupling** | **Ours (slightly)** | Per-sample sun color from the *shared* Hillaire transmittance LUT (sky+ship+clouds agree by construction) + altitude-aware terminator. Takram couples via aerial-perspective mean-depth (an approximation they flag). |
| **Temporal reconstruction** | **Takram** | 1/16-res upscale + variance clipping + STBN + (optional) Catmull-Rom, matched projection jitter. Ours = 1/4-res + YCoCg variance clamp + Bayer + EMA (we backed off 1/16 for near-cloud noise). |
| **From-space / orbit rendering + LOD** | **Ours (decisively)** | Analytic far shell, opacity = Monte-Carlo *expectation* of the marcher's Beer opacity, zero per-frame noise, mean-preserving variance fade handoff. Takram: hard 200 km cap, no fallback, flickers/fades (their acknowledged TODO). |
| **Stack / perf ceiling** | **Ours (potential)** | WebGPU/TSL + compute noise bake. Takram is WebGL2/GLSL; WebGPU "planned". Our ceiling is higher if we exploit it. |
| **Modularity / API polish** | **Takram** | Clean pass separation, `ProceduralTexture`/`Procedural3DTexture` bakers, formal quality presets (low/med/high/ultra), per-layer config objects. Ours is powerful but concentrated in one 4300-line file with lockstep-duplicated density chains. |

---

## 2. What takram does better — adopt these (grouped)

### 2A. Shape / naturalness

**(i) Erosion-by-renormalizing-remap — the core of clean cumulus.**
`density = remapClamped(density, (1-shape)*shapeAmount, 1.0)` (`clouds.glsl:145`).
Because the low bound is `(1-shape)` and high bound is `1`, texels where `shape≈1`
keep full density while low-`shape` texels have their floor lifted toward 1,
collapsing edges to 0 *without muddying interiors*. **We already do the equivalent
Nubis-form Remap** (`earthClouds.ts` `shape = saturate(dimProfile - (1-carved)*K)`).
The problem is our shipped `K<1`, not the primitive. → See roadmap #1.

**(ii) Biased-semicircle shape-altering height gradient.**
`shapeAlteringFunction(η,bias): x = clamp(pow(η,bias)*2-1,-1,1); return 1-x²`
(`clouds.glsl:68-73`), default `bias=0.35`. A parabola pinned to 0 at base/top,
peak skewed downward → rounded shoulders, pinched base. Folded into coverage as
`factor = 1 - coverage*heightScale`. **We approximate this with the 64-row genus
profile LUT** (sharp base ramp + parabolic dome + Cb waist), which is *more*
expressive. Keep ours; borrow the idea of exposing a single per-type "dome bias"
if the LUT anchors feel too rigid.
*TSL port:* pure ALU, trivial.

**(iii) Height-dependent detail sign — "fluffy top / whippy bottom".**
`modifier = mix(pow(detail,6), 1-detail, remapClamped(η,0.2,0.4))` (`clouds.glsl:151-160`):
below η=0.2 sparse high-contrast spikes (torn wispy base), above η=0.4 inverted
Worley (fluffy billow crowns), from **one** detail texture. We frequency-grade
fine detail by `profile` but do not flip the *morphology* by height. Adopting the
explicit sign flip is cheap and directly targets cumulus realism.
*TSL port:* ALU only, reuses existing detail channels; **no re-bake** if mapped to
our Alligator octaves. Effort **S**.

**(iv) Turbulence curl domain-warp confined to cloud bottoms.**
`turbulence = displacement · (curlTex.rgb*2-1) · dot(density, remap(η,0.3,0))`
added to the shape sample position (`clouds.glsl:134-143`). Divergence-free curl
warp only in the lower 30% → wind-sheared wispy bases, crisp tops undisturbed. We
have a curl-wisp channel (`noiseVolumes.ts` detail A) used for edge blend but do
**not** domain-warp the base lookup by it. **High visual ROI, low effort.**
*TSL port:* one extra 2D/3D tap + a vec3 add to the sample position; reuse curl
channel. Effort **S–M**. Constraint: warp must be inside `DETAIL_FADE`/variance
fade so it can't alias at range (case #22).

**(v) `coverageFilterWidth` — per-type edge hardness in one knob.**
`density = remapClamped(mix(weather,1,width), factor, factor+width)`
(`clouds.glsl:95-100`). `width→0` = hard cumuliform edge; `width→1` = linear
overcast/stratiform. A clean single knob spanning the stratiform↔cumuliform edge
family. We control edges via fraction-placement + per-type carve/wisp; consider
adding an explicit per-type edge-width term for authoring clarity.

### 2B. Ground shadows (pain #3)

**(vi) Cascaded Beer Shadow Map with texel snapping.** 3 cascades, PSSM
"practical" split (`splitLambda 0.6`), 512²/cascade, and crucially the light-space
center is **rounded to whole texel increments** (`CascadedShadowMaps.ts:240-244`)
to kill shadow swimming. Cross-cascade seams hidden by *stochastic dithered
cascade selection* (`getFadedCascadeIndex`) that the shadow-resolve TAA smooths.
This is the sharpness mechanism. → Roadmap #4.

**(vii) BSM stores optical-depth *statistics*, and the tail trick.** Per texel:
`vec4(frontDepth, meanExtinction, maxOpticalDepth, maxOpticalDepthTail)`
(`shadow.frag`). Optical depth at any point = `min(maxOD+tail, meanExt·distToFront)`
→ continuous, Beer-correct, both soft *and* sharp-edged from one cheap map. We
store `R=d_front, B=tau_max, A=hit` — **we already have most of this; add the
mean-extinction channel and the `tail = tailScale·step·exp(1-sampleCount)`
extrapolation** so early-terminated thick cores still shadow correctly.

**(viii) Structured Volume Sampling + shadow-resolve TAA.** SVS snaps the shadow
march to a shared icosahedral-plane lattice (`structuredSampling.glsl`) → *temporally
stable* samples on a low-res map (trades spatial aliasing, cleaned by a dedicated
variance-clipping TAA on the cascades). This is what lets 512² look higher-res and
stop sparkling. Adopt alongside CSM.

**(ix) Screen-space-sized, horizon-gated PCF (Vogel disk).** PCF radius derived
from the *projected on-screen pixel size* of a shadow texel and gated by
`dot(sun,normal)` — razor-sharp at midday, penumbra only at grazing sun
(`clouds.frag:185-219`, `aerialPerspectiveEffect.frag:237-267`). We already blur
by grazing angle; the screen-space texel-size heuristic is a cleaner, sharper
default.

### 2C. Lighting / scattering

**(x) Octave-summed energy-conserving multiple scattering.** 8 octaves; per octave
`scatter += a·exp(-opticalDepth·b)·phase(cosθ,c)` with `a,b,c *= 0.5` each octave
(`clouds.frag:397-415`). Brightens interiors/backs plausibly and would let us
**delete the global `MS_GAIN=5` fudge** (a documented risk in our lighting brief).
*TSL port:* small unrolled loop; reuses the one sun optical depth we already have.
Effort **M**, risk **medium** (needs re-tuning against our atmosphere exposure).

**(xi) Frostbite energy-conserving analytic scattering integral.**
`Sint = (L - L·T)/σ; radiance += Tacc·Sint; Tacc *= T` per step
(`clouds.frag:591-597`) decouples brightness from step size → we can grow step
size in thin/empty regions without darkening = perf. **Verify whether our
front-to-back accumulation already uses this; if not, adopt it** (it's a
prerequisite for cheaply lengthening steps).

**(xii) Beer-Powder** (`radiance *= 1 - powderScale·exp(-σ·powderExp)`): we have a
powder term already; parity. Keep.

### 2D. Temporal / performance

**(xiii) STBN everywhere** (see TL;DR #6). The single enabling change for cheaper
temporal upscaling and stable low-res shadows. Ship the STBN 3D texture; route it
through march start offset, PCF rotation, and (new) SVS. Effort **M**.

**(xiv) More aggressive temporal upscale, *earned* by better reconstruction.**
Takram marches 1/16; we march 1/4 (we deliberately backed off 1/16 for
close/fast-cloud noise — `cloudReconstructionPass.ts:77-79`). Do **not** just set
`SPARSE_DIVISOR=4`. Instead: add STBN + variance clipping quality (and optionally
Catmull-Rom history) *first*, then re-test whether 1/9 or 1/16 becomes acceptable
for near clouds. Keep the fresh/stale Bayer split we already have.

**(xv) Empty-space march-range bounding from history.** Takram's own "possible
improvements" note: most weather samples are wasted checking outside the cloud
shell; use the reprojected previous-frame front depth + sample count to bound this
frame's march range. **We already store `tFront` history** for reconstruction, so
this is a natural, high-value perf idea for us specifically.

**(xvi) Inter-layer empty-gap interval skipping** (`CloudLayers.packIntervalHeights`
+ `insideLayerIntervals`): big-step through dead air between decks. Relevant once
we add coexisting decks (roadmap #3).

### 2E. Architecture / API

**(xvii) Procedural texture bakers + formal quality presets.** `ProceduralTexture`
/ `Procedural3DTexture` (render-to-texture bakers with a uniform `render()` and
`dispose()`), and clean `low/medium/high/ultra` presets that toggle shapeDetail /
lightShafts / turbulence / accurateSunSkyLight / iteration counts / cascade
count+size (`qualityPresets.ts`). We have LOD sample lerping but no formal preset
surface. A preset enum would help hit the M2-Pro-and-weaker targets.

---

## 3. What WE do better — keep, do NOT regress

1. **From-space / orbit rendering.** Analytic far shell (`earthClouds.ts`
   `buildCloudShellMesh`), opacity = Monte-Carlo `E_noise[1-exp(-eroded·PATH)]`
   baked from the *real* noise volumes into a LUT (`getShellOpacityLUT`), lit by
   the shared `farCloudLit`. Zero per-frame 3D noise → **no orbit flicker/alias**,
   and far cloud *area* matches near field by construction. Takram has none of
   this (hard 200 km cap, fades out — their explicit TODO). **This is our single
   biggest advantage. Protect it in any near-field rework** (the shape/K/gamma
   changes flow through the shared helpers so the shell re-derives automatically —
   keep that discipline).

2. **Seamless near→far handoff via mean-preserving variance fade.**
   `BILLOW_VAR_FADE` fades the marcher's noise *variance* to its mean over the same
   band the shell fades in → the volumetric converges to the shell's macro look;
   crossfade is invisible. "One representation, LOD'd" done coherently.

3. **Regional weather from real data.** ERA5 equirect RGBA
   (coverage/convectivity/topHeight/cirrus) + fraction-to-placement (area-preserving
   thresholding of the updraft field). Takram = one tiled texture, globally uniform,
   cube-sphere seams. Our region-to-region variety is a core realism differentiator
   and the path to procedural planets.

4. **Continuous convectivity type axis + 64-row genus profile LUT.** Type is an
   independent map channel, not coverage-derived; the LUT interpolates *anatomy
   parameters* (base ramp, dome exponent, plateau, waist) so every intermediate
   genus is a valid single-bump curve. More expressive than takram's 4 analytic
   terms and better suited to gas-giant/procedural generalization (R4/R5).

5. **Tight physical atmosphere coupling.** Per-sample sun color from the *same*
   Hillaire transmittance LUT the sky and ship read + altitude-aware terminator
   (`mu_set = -sqrt(1-(R/r)²)` → tops glow after the ground darkens). Sky/ship/cloud
   color agree by construction, not by tuning.

6. **WebGPU + TSL + compute noise bake.** Higher performance ceiling; takram is
   WebGL2/GLSL with WebGPU only "planned". Our compute-baked 3D noise is already
   what they'd need to build.

7. **Nubis-cubed self-shadow split.** Orbit fade applied *only* to the baked far
   light volume; local 800 m macro + detail sun probes stay live at every altitude
   (killed the 400–3000 km "flat white balls" band). Detail probe samples the same
   carve noise as opacity → shadows land in real crevices.

8. **Shared single-source density chain** (`cloudShared.ts`) consumed by marcher,
   far shell, and light-volume bake → shadows never detach from the render.

---

## 4. Clever tricks worth stealing (small, high-ROI)

| Trick | Where (takram) | Value | Effort |
|---|---|---|---|
| Turbulence curl domain-warp weighted to cloud bottom | `clouds.glsl:134-143` | Wind-sheared wispy bases; big naturalness/frame | **S–M** |
| Height-dependent detail sign (fluffy top / whippy bottom) | `clouds.glsl:151-160` | Direct cumulus morphology from one detail tex | **S** |
| Texel-snapped light-space center (kills shadow swimming) | `CascadedShadowMaps.ts:240-244` | Stability; we already clipmap-snap the light *volume*, apply to BSM | **S** |
| BSM `maxOpticalDepthTail` extrapolation past early-termination | `shadow.frag:105-116` | Deep cores shadow correctly without full march | **S** |
| STBN as universal jitter (march/PCF/SVS) | `clouds.glsl:1-5` | Enables cheaper upscaling + stable low-res shadows | **M** |
| Screen-space-sized PCF radius (sharp by default) | `aerialPerspectiveEffect.frag:237-267` | Crisp midday, soft only at grazing | **S–M** |
| Energy-conserving analytic scattering integral | `clouds.frag:591-597` | Bigger steps w/o darkening = perf | **S–M** |
| Octave multi-scatter (retire our global `MS_GAIN`) | `clouds.frag:397-415` | More energy-plausible interiors | **M** |
| History-bounded march range (reuse our `tFront` history) | README "possible improvements" | Skip wasted out-of-shell samples | **M** |
| Stochastic dithered cascade blend + resolve | `getFadedCascadeIndex` + `shadowResolve.frag` | Seamless cascades for ~free | (part of #4) |
| Non-cloud velocity reprojected in *view* space | `clouds.frag:966-969` | Dodges far-plane float precision loss | **S** |

---

## 5. Prioritized roadmap (ranked by impact, then effort/risk)

Effort: S(<½ day) · M(1–3 days) · L(a week) · XL(multi-week). Impact H/M/L.
**Every near-field change must flow through `cloudShared.ts` so the far shell +
light volume re-derive** (lockstep hazard #1). Measure-first per CLAUDE.md.

### DO FIRST — high leverage

**#1 — Coupled erosion-K + convective-gamma re-tune (with a precondition).**
Impact **H** · Effort **M** · Risk **med**.
Pain #1 (unnatural towers/porridge).

*Root cause (investigated 2026-07-20).* The Phase-F-validated Nubis `K=1`
(`BASE_EROSION_K_EFF=1.0`, `:640`) is bypassed by the per-type ramp
`erosionKForType = mix(EROSION_K_ST 0.5, EROSION_K_CU 0.7, conv)` (`:730-731,
1118-1122`), which was deliberately *centered on the legacy `0.6`*
(`mix(0.5,0.7,0.5)=0.6`) for continuity when `PER_TYPE_DETAIL` shipped — the K=1
decision never reached the endpoints. `EROSION_K_CU=0.7` (density floor) +
`DENSITY_GAMMA_CU=0.1` (`shape^0.1`, near-binary) **co-produce** solid, featureless
convective cores. They are co-tuned to a look; move them **together**, not singly.

*Precondition — MEASURED 2026-07-20* (area-weighted histogram of
`era5_2005082818.png` + in-app `DEBUG_VIZ` over a dense deck at 6472 km).
Convectivity `G=sqrt(CAPE/2000)`: mean 0.186, p50 0.063, p90 0.63. Area fraction
above the gates: `G>0.55` (turret) **13%**, `G>0.6` (anvil) **11%**, `G>0.8` (full)
**~5%**. Jitter amplitude scales with conv → ~0 over the p50 stratiform half. Of
dense decks (R>0.6, ~10% of globe): **82% stratiform (G<0.3), only 11% convective
(G>0.55)**. In-app `topAlt` viz was mostly-black + sparse light patches (flat low
deck); `eroded` showed true black between lumps (**no porridge floor at that
scene's coverage**). Conclusions:
  - The jitter/turret/anvil machinery **correctly fires in convective regions**
    (~1–13% of surface) — precondition IS met where towers form.
  - It is **dormant in the common stratiform dense deck** (the screenshots) — which
    is *physically correct* (marine Sc / frontal St are flat), so high K there would
    just punch through-holes in a flat slab. Keep `EROSION_K_ST<1`.
  - **Because the ramp interpolates K/gamma by convectivity, raising only the
    convective end (`EROSION_K_CU`, `DENSITY_GAMMA_CU`) auto-confines the change to
    the convective regions where jitter/turrets are active** → #1 is well-targeted
    and lower-risk than a global K change. GREEN to try.
  - **A/B must be over a CONVECTIVE region** — this map is Hurricane Katrina
    (2005-08-28), so the Gulf of Mexico / tropics, NOT the stratiform deck in the
    screenshots. Caveat: turrets fire only weakly even there (need `mesoG>0.6` AND
    `conv>0.55` jointly — `:267` "T rarely tops 0.3") and are mask-stamps on
    isotropic noise (#10), so #1 fixes solid-flat cores but not "tower = taller lump".

*Then.* A/B raise `EROSION_K_CU` toward `~0.9–1.0` **while** softening
`DENSITY_GAMMA_CU` toward `~0.7`, from a dense deck at 16–20 km (the pain-point
view) AND from orbit (shell handoff). Keep `EROSION_K_ST<1` — a smooth filled
stratus sheet is *desired*. Confirm the floor disappears with `DEBUG_VIZ='eroded'`
(expect true black, not a grey plateau).

*Files:* `earthClouds.ts:730-735` (constants), `erosionKForType`/`densityGammaForType`
(`:1118-1129`). Change flows through `cloudShared.ts` to `cloudLightVolume.ts`
`densityAt` + the shell opacity LUT (they re-derive); case #13 — the probeShape
skip-gate must move with the erosion (it already reads `erosionKForType`).

*Constraints:* (a) `BASE_EROSION_K=0.6` and the low ramp were partly tuned for the
near/far brightness+fullness match (`:592-620`; commit `7db0ce4`) — re-check the
shell handoff when raising K. (b) **Distrust the nearby comments** — several are
stale: `:725-728` claims convective "capped at 1.0 / fully Nubis-carved" but ships
`0.7`; `:732-735` claims `γ=1.0/0.7` but ships `4.0/0.1`; `:709-712` claims
`FINE_CARVE_CU=0.28` but ships `0.20`. Trust the constants + `DEBUG_VIZ`, not the prose.

**#2 — Height-dependent detail sign (fluffy top / whippy bottom).** ~~+ turbulence
domain-warp at cloud bottoms~~
Impact **M** · Effort **M** (needs `altNorm` plumbed to `fineCarveDelta`, currently
only inside `cloudShared`) · Risk **low** (behind a toggle).
Height-graded detail character: near the base bias detail toward wispy/eroded, near
the top toward fluffy billow. Reuses existing detail channels (no re-bake). *Files:*
`fineCarveDelta` (`earthClouds.ts:1143`) + its two call sites (`:2914` view ray,
`:3367` probe) — pass a shared `altNorm`.

> **⚠️ The turbulence-domain-warp half is CONTRAINDICATED — do NOT blind-add it.**
> `WARP_AMPLITUDE=0` today on purpose: **case #19** (CLOUD_DEBUGGING_LESSONS) spent
> multiple days proving that domain-warping the base shape produces "curved, swirly,
> elongated filaments instead of round cauliflower billows" — i.e. the *stringy/
> malformed* look. Takram avoids that only because its warp is a bounded (~350 m),
> bottom-only, **divergence-free curl** displacement (curl swirls without shearing).
> If ever attempted, it must be curl-based + validated in `/dev/cloud-slice` first,
> never as an in-game blind edit.

*Reality check (2026-07-20 A/B):* #1's K/gamma re-tune was kept (less-smooth towers),
but the user reports the **macro silhouette is still malformed/messy** — which #2
(detail-level) will NOT fix. The macro shape is now the dominant open problem →
see the macro-shape note below.

**#2b — MACRO-SHAPE: coarsen the billow carve (DIAGNOSED 2026-07-20).**
Impact **H** · Effort **S** · Risk **low–med**.
**Root cause FOUND** via `/dev/cloud-slice` (extended with an ENVELOPE mode that
applies the real `dimProfile = coverage × cloudHeightProfile(altNorm)` + Nubis
erosion + gamma, so a vertical slice shows the true side-view silhouette):

- The **envelope is fine** — flat base, bumpy cauliflower top, discrete masses at
  low coverage, height tracks topAlt. (Rules out the "amorphous vertical extrusion"
  and "profile broken" hypotheses.)
- The messy/unnatural look is **interior fragmentation from a too-fine billow carve**:
  `CARVE_SCALE=360` runs the carve at **~0.7 km — finer than a cauliflower lobe** — so
  it Swiss-cheeses the body into speckle instead of sculpting lobes. K≈0.95 (from #1)
  lets those fine holes punch through.
- **Fix (viewer-validated):** lower `CARVE_SCALE` to **~150** (~1.7 km cells) → the
  carve makes **rounded cauliflower-scale lobes**. At coarse carve, `K≈0.7–0.8` reads
  solid+structured (K 0.95 is holier), so this likely lets #1's K relax back down.
  Slice img at (carveScale 150, BILLOW_CARVE 0.85, K 0.7, grayscale) = a genuine
  cumulus cross-section.

*Next:* apply `CARVE_SCALE ≈ 150–200` in `earthClouds.ts` (flows through `cloudShared`
→ shell LUT + light-volume re-derive; lockstep-safe) and A/B in-game over a convective
region, re-balancing `EROSION_K_CU` (~0.75–0.85) with it. Watch the far-shell match
(coarser carve changes the noise statistics the shell LUT Monte-Carlos). Note the base
noise (~5 km caps) is unchanged — the carve just needs to be ~1/3 that scale for
cauliflower. H3 (10–40 km mesoscale organization) remains a separate, later item.

**DEEPER ROOT CAUSE — the profile PLATEAU (found 2026-07-20, the "towers not domes"
complaint).** Even with the carve fixed, cumulus rendered as *constant-width vertical
columns/towers*, not base-heavy domes. Cause: the genus profile LUT held a long
full-density **plateau** (Cu `fadeStart=0.48` → full from altNorm 0.08–0.48; Cb 0.70).
Through a plateau the value-erosion threshold is constant → constant width up the
column. Takram avoids this: its `shapeAlteringFunction` is a *downward-biased
semicircle* — density peaks just above the base and **tapers continuously to the top**
(no plateau) → the threshold rises with height → wide base, narrowing dome (real
cumulus physics). **FIX APPLIED:** lowered `fadeStart` on the convective anchors in
`cloudProfileLUT.ts` (Cu 0.48→0.14, Cb 0.70→0.24, Sc 0.6→0.45; St kept — flat sheets
are correct), domeExp kept ≥2 for a rounded top, Cb waist 0.25→0.12. St/Sc keep more
plateau. Tune in `/dev/cloud-profile` (curve) + `/dev/cloud-slice` envelope mode. This
is arguably the single most important shape fix. *Secondary/later:* turrets raise
NARROW columns' tops → even with a taper a turret makes a thin spike; real Cb are
wide-based, so "tall" should come from wider coverage cells, not narrow raised columns.

**#2c — LIGHTING: restore self-shadow contrast (the "cotton wool" look).**
Impact **H** · Effort **M** · Risk **low–med**. NEW dominant issue (2026-07-20, after
the carve-scale shape fix landed). With the shape fixed, the cumulus render as **flat,
over-bright cotton wool** — brilliant tops but no dark undersides/crevices, so no 3D
bulk (takram/Nubis have a strong dark-base→bright-top gradient). This is lighting, not
shape. `MS_GAIN`=2, `MS_COEF`=0.9, `skylight`=0.07, `CLOUD_SUN_SCALE`=0.6, sunlit ≈12
HDR. Two candidate causes: (1) self-shadow not producing relief; (2) relief blown out
by over-brightness (tonemap crushes lit+shadowed to white). *Diagnose first* with
`DEBUG_VIZ='detailShadow'` (lobed=relief works / flat=none), `'lightingOnly'` (varies
vs uniform), `'coneDepth'` (absorption varies?) — the in-code comments (~L908-936) say
coneDepth-varies-but-lightingOnly-uniform ⇒ lower sunColor / change the lighting
tonemap. *Quick A/B:* `MS_GAIN` 2→1, `skylight` 0.07→0.03, `CLOUD_SUN_SCALE` 0.6→0.45.
Relates to takram's Beer-Powder + strong BSM self-shadow (§2C) and the multi-scatter
rebalance (#6). Likely the highest remaining lever for near-cloud realism.

**#3 — Cascaded (or tight near-cascade) Beer Shadow Map + texel snapping.**
Impact **H** · Effort **L** · Risk **med**.
Pain #3 (sharp ground shadows), the clear root cause (single 512² @ 5.9 km/texel).
*First step (cheap interim):* add ONE camera-following near-cascade (e.g. 512²
over a ~30–60 km window) composited with the existing wide map — validates the
sharpness win before full CSM plumbing. *Then:* generalize to N cascades (practical
split) with texel-snapped centers and stochastic dithered blend. *Files:*
`cloudShadowMap.ts`, consumers in `earthClouds.ts` (ground shadow read) +
`atmospherePass.ts` (god rays). *TSL port notes:* WebGPU supports texture arrays &
`dpdx/dpdy`; per-cascade render can be a layered target or N passes; add the
mean-extinction channel + tail term (#trick vii) while here. *Constraint:* keep the
grazing penumbra + god-ray soft-blur copy working.

### MEDIUM — strong value, more work or dependency

**#4 — STBN jitter + reconstruction-quality pass, then re-evaluate sparse divisor.**
Impact **M–H** · Effort **M** · Risk **med**.
Pain #4. Ship STBN, route through march offset + (new) shadow SVS + PCF rotation;
tighten `cloudReconstructionPass.ts` variance clipping (consider Catmull-Rom
history). *Then* re-test 1/9 or 1/16 for near/fast clouds (we backed off before).
Keystone that also stabilizes #3's low-res shadows. *Constraint:* don't regress the
2026-06-01 near-cloud-noise fix — gate any divisor increase on measured ghosting.

**#5 — Coexisting cloud decks (cirrus veil over cumulus).**
Impact **M–H** · Effort **M–L** · Risk **med**.
Pain #2 / requirement R2. Takram marches up to 4 decks as a `vec4` from weather
RGBA with empty-gap interval skipping. We have a cirrus map channel but no separate
high deck. *First step:* implement the already-scoped 2.5D cirrus shell (§4.5 of
CLOUD_TYPES_PLAN) OR a second thin high-altitude march band gated by the cirrus
channel, with interval-skipping of the clear air between decks. *Files:*
`earthClouds.ts` march band logic, `cloudShared.ts`, weather channel usage. *Keep*
our per-region variety and profile LUT (don't collapse to takram's global model).

**#6 — Octave multi-scatter + analytic scattering integral (retire MS_GAIN fudge).**
Impact **M** · Effort **M** · Risk **med**.
Realism + a step toward unified exposure. Replace `pow(Tsun,MS_COEF)·MS_GAIN` with
an 8-octave energy-conserving sum; adopt the Frostbite per-step analytic integral
if not already present. *Files:* `earthClouds.ts` lighting combine (~L2960–3760).
*Constraint:* re-tune against the shared atmosphere exposure; verify orbit/shell
brightness still matches (the whole point of the shared LUT coupling). Do AFTER #1
so you're not chasing two brightness changes at once.

**#7 — History-bounded march range.**
Impact **M** · Effort **M** · Risk **low–med**.
Pain #4. Use reprojected previous-frame `tFront` + sample count to bound this
frame's march entry/exit, skipping out-of-shell weather taps. We already keep the
history buffer. *Files:* `cloudFullscreenPass.ts` marcher entry, `cloudReconstructionPass.ts`.

### LATER — polish, generality, or speculative

**#8 — Formal quality-preset surface (low/med/high/ultra).** Impact **M** · Effort
**M**. Wrap existing toggles (shapeDetail, god rays, self-shadow probes, sample
counts, shadow resolution/cascades, sparse divisor) into presets to hit weaker
devices; mirrors takram's `qualityPresets.ts`.

**#9 — Far-shell projected self-shadow.** Impact **M** · Effort **M**. Replace the
`selfShadow = 1 - coverage*0.5` proxy with a real `1 - k·cloudShadowMap` projection
so far-field ground shading isn't flat (our lighting brief flags this TODO;
`cloudCommon.farCloudLit`).

**#10 — True Cb tower structure (the hard track).** Impact **H (visual)** · Effort
**XL** · Risk **high**. Our towers are heuristic mask-stamps on *isotropic* noise
("a tower is a taller lump"). Takram doesn't solve this (no towers). Real fix needs
anisotropic/structured noise or lightweight grown-convection — a research item.
Sequence AFTER #1/#2 (which may make current towers acceptable) and gate on whether
the complaint persists. Candidate: vertically-sheared/anisotropic base noise
(dual-file re-bake) + updraft-aligned detail.

**#11 — Gas-giant / procedural generalization.** Impact **M (goal)** · Effort **L**.
Neither system does banded-flow gas giants. Our weather-map + convectivity-axis +
profile-LUT path is the vehicle (define banded coverage/flow maps, thicker slab).
Unblocked by keeping the near-field changes flowing through `cloudShared.ts`.

**#12 — Modularization of the 4300-line `earthClouds.ts`.** Impact **L (velocity)**
· Effort **L** · Risk **med**. Reduce the lockstep-duplicated density chains
(marcher / light volume / shell). Only if it stops paying rent as friction; keep
changes local per CLAUDE.md.

---

## 6. Open questions — prototype & measure before committing

1. ~~**Do the topHeight-variance + mesoscale + turret/anvil fixes fire on the real
   ERA5 map?**~~ **ANSWERED 2026-07-20 (see §5 #1 precondition).** Yes in convective
   regions (G>0.55 ≈ 13% of surface), dormant in the stratiform 82% of dense decks
   (correct). NEW insight from the measurement: **the dense deck you usually fly
   over is stratiform, whose problem is uniform single-scale popcorn (H3 = missing
   10–40 km mesoscale organization), NOT erosion K.** So #1 fixes the *rare*
   convective towers; the *common* stratiform look is #2 + a mesoscale-organization
   pass (H3; see CLOUD_TYPES_PLAN §4.7). Weigh which matters more for "everyday" feel.
2. **Does re-raising K to ~1.0 break the near→far shell brightness match?** (`K=0.6`
   was tuned for that handoff.) Measure the shell A/B at orbit while doing §5 #1.
2. **Do we already use the Frostbite analytic scattering integral?** Read the
   `earthClouds.ts` accumulation loop; it gates #6 and any step-size increase.
3. **How aggressive a sparse divisor can STBN+variance-clip buy us for *near/fast*
   clouds specifically?** The 2026-06-01 note says 1/4 was needed; re-measure after
   #4, don't assume.
4. **Cascaded BSM cost on WebGPU** — is a layered array target or N passes cheaper
   in our TSL pipeline? Prototype the single near-cascade (#3 first step) and
   profile before full CSM.
5. **Does the octave multi-scatter (#6) let us drop `MS_GAIN` without the orbital
   body going ~2.5× under-lit again?** (That was the reason MS_GAIN=5 exists.)
6. **Is the perceived quality gap partly sun angle / coverage tuning?** Reproduce
   takram's Tokyo scene sun elevation + `coverage≈0.3–0.4` fair-weather deck in our
   engine before attributing everything to the shape pipeline.

---

## 7. Appendix — key file references

**Ours (`src/components/…`):**
- `celestial/bodies/earthClouds.ts` — main marcher, density chain, lighting, far shell (~4300 lines)
- `celestial/bodies/cloudShared.ts` — SINGLE-SOURCE density chain (coverage→type→topAlt→profile→K/gamma/wisp), consumed by marcher/shell/light-volume
- `celestial/bodies/cloudProfileLUT.ts` — 64×64 R16F genus profile LUT
- `celestial/bodies/noiseVolumes.ts` (CPU) / `cloudVolumeCompute.ts` (GPU) — noise bake (base 128³ RGBA + detail 64³ RGBA + mip1)
- `celestial/bodies/cloudCommon.ts` — planet-agnostic seam: `equirectDirToUv`, `farCloudLit`, `coverageToOpacity`, `CloudFieldProvider`
- `space/cloudLightVolume.ts` — 256×32×256 sun-transmittance froxel (dual-volume crossfade)
- `space/cloudReconstructionPass.ts` — sparse 1/4-res (`SPARSE_DIVISOR=2`) → full-res temporal reconstruction (YCoCg variance clamp + EMA)
- `space/cloudShadowMap.ts` — Beer Shadow Map (`BSM_SIZE=512`, `BSM_HALF_EXTENT_KM=1500` ≈ 5.9 km/texel, single cascade)
- `space/cloudFullscreenPass.ts` — fullscreen marcher driver (Bayer sub-pixel schedule)
- `space/atmospherePass.ts` — Hillaire atmosphere, shared transmittance/MS LUTs, cloud aerial-perspective, god rays
- Docs: `CLOUD_TYPES_PLAN.md`, `CloudTypesResearch/cloud_shape_anatomy.md` (the porridge diagnosis + Phase F validations), `CLOUD_SHADOWS_GODRAYS_PLAN.md`, `CLOUD_REVIEW_2026-07.md`, `CLOUD_DEBUGGING_LESSONS.md`

**Takram (`@takram/three-clouds`, `packages/clouds/src/…`):**
- `shaders/clouds.frag` (1003 ln) — main march: shape, lighting, multiscatter, phase, powder, hybrid sun OD, aerial perspective, velocity
- `shaders/clouds.glsl` (190 ln) — `sampleWeather` / `sampleMedia` / `shapeAlteringFunction` / `getLayerDensity` (**the shape heart**)
- `shaders/cloudShape.frag` / `cloudShapeDetail.frag` — Perlin-Worley base + Worley-fbm detail bakers
- `shaders/localWeather.frag` — procedural RGBA weather (R low / G mid / B cirrus / A extra)
- `shaders/turbulence.frag` — curl-noise vector field (bottom domain-warp)
- `DensityProfile.ts` / `CloudLayer.ts` / `CloudLayers.ts` — 4-layer model, `a·e^(bη)+cη+d`, RGBA packing, interval skipping
- `CloudsEffect.ts` / `CloudsPass.ts` / `CloudsMaterial.ts` — orchestration + quarter-res MRT
- `CloudsResolveMaterial.ts` + `shaders/cloudsResolve.frag` — 1/16 Bayer temporal upscale
- `shaders/varianceClipping.glsl` / `catmullRomSampling.glsl` / `bayer.ts` — TAA machinery
- `ShadowPass.ts` / `ShadowMaterial.ts` + `shaders/shadow.frag` / `shadowResolve.frag` — BSM render + TAA
- `CascadedShadowMaps.ts` + `helpers/splitFrustum.ts` / `FrustumCorners.ts` — CSM (texel snapping, practical split)
- `shaders/structuredSampling.glsl` — SVS (icosahedral strata)
- `qualityPresets.ts` / `constants.ts` / `uniforms.ts` / `shaders/parameters.glsl` — presets + vec4 packing
- `README.md` — design writeup + **Limitations/Known issues/Planned features** (space rendering & global coverage are *unbuilt*)

---

*Analysis workflow: 6 parallel briefs (5 completed) + 7 dimension comparisons were
run via a background workflow; the compare/verify/synthesis phases were cut short
by an org spend limit, so this synthesis was assembled in the main session from the
5 completed briefs plus direct primary-source reads of takram's README, `clouds.glsl`,
`DensityProfile.ts`, and our shadow/temporal source. Claims about takram's shape
pipeline, shadow CSM/BSM, and from-space limitations were verified against source;
the two "ours" findings (shipped K and gamma vs plan targets) came from the source
brief and should be re-confirmed by grepping the live constants before acting.*
