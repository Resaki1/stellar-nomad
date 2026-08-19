# Physically-Based Lighting & Exposure — Implementation Plan

Status: **design, not started.** Companion to [`ATMOSPHERE_PLAN.md`](ATMOSPHERE_PLAN.md),
whose §6 ("Photometry & exposure — the unified scale") was specified but never built.
This document is that §6, expanded to cover the whole engine.

Evidence base: [`LightingResearch/AUDIT_1_pipeline.md`](LightingResearch/AUDIT_1_pipeline.md),
[`AUDIT_2_lights_surfaces.md`](LightingResearch/AUDIT_2_lights_surfaces.md),
[`AUDIT_3_far_lod.md`](LightingResearch/AUDIT_3_far_lod.md) (12 / 16 / 23 findings, all
cited to file:line), plus two numerical replicas of the engine's own atmosphere march in
[`LightingResearch/`](LightingResearch/).

---

## 0. Read this first

1. The engine has **five mutually incompatible brightness scales**. Only two respond to
   distance from the sun. No two agree on what `1.0` means.
2. **There is no exposure control of any kind** — not auto, not manual. `ATMOSPHERE_EXPOSURE`
   is declared and referenced by nothing.
3. The planets are **not lit by the three.js lights at all** (two independent disconnects).
   `SunLight` and `ambientLight` illuminate only the ship and near/mid asteroids.
4. Every planet surface is missing exactly one factor: **`sunIlluminance / π` = 6.37× at 1 AU**.
5. `VENUS_ILLUM_TRIM = 0.025` is **backwards**. Measured, the Venus disc marches to 11–13
   game units against a physical 8.9 — it was never 40× too bright. The trim *under*-renders
   Venus ~32×, and only looked right because Earth's surfaces are simultaneously 6.37× too dark.
   **Two errors partially cancelling** → the surface-irradiance fix and the trim removal must
   land in the *same* commit.
6. The good news: the scene's existing scale is **already a pre-exposed physical scale** with a
   discoverable constant — **1 game unit ≈ 6,400 cd/m²**. Almost nothing needs rescaling; the
   scale needs *finishing* and *documenting*.
7. The offscreen chain is genuinely RGBA16F end-to-end and tone-maps exactly once. **The
   plumbing is fine.** The defects are all in the radiometry and the missing exposure stage.
8. Scene dynamic range is **44 stops** (EV100 −10 → +34). Unreal's default auto-exposure
   histogram covers 12. This is the central design constraint.
9. The shipped defaults are `toneMapping: false` **and** `bloom: false`
   ([`store.ts:29-30`](../src/store/store.ts#L29)) — so a fresh player gets `Neutral`
   (which crushes everything above linear ≈4) with no bloom at all. Flip both.
10. Real browser HDR output exists today (three r180+): `outputType: HalfFloatType` +
    `ExtendedSRGBColorSpace`. Display headroom is **not** reliably detectable → ship a
    calibration screen, as every console HDR title does.
11. **`sunIlluminance` is baked at module load** from a static position
    ([`atmosphereData.ts:249`](../src/components/celestial/bodies/atmosphereData.ts#L249)).
    Orbital motion and procedural systems both require it to be per-frame. Fix in Phase 0 — see §3.0.
12. **§2.2 is closed** — Venus over-scatters by +18…+21%, which is the Hillaire multiple-scattering
    approximation's own documented hue-drift limit at high scattering coefficients, not a bug in
    our code. Accepted without a correction knob. Nothing blocks Phase 0.
13. The aesthetic target is **what a dark-adapted human eye would see**, which means a
    scotopic/mesopic vision model, two-timescale adaptation, and veiling glare — not just
    a tone curve. See §3.9. Happily, "stars visible unless something bright is in frame"
    falls out of that physics for free rather than needing to be art-directed.

---

## 1. Problem statement

### 1.1 The root cause

One defect explains most of the symptoms: **the engine grew two lighting systems that never
met.** The atmosphere/cloud system (Phases 1–5 of `ATMOSPHERE_PLAN.md`) is physically based and
carries a real illuminance scale derived from star luminosity and true orbital distance. Every
other surface in the game predates it and shades on a bare `[0,1]` albedo scale. The bridge
between them — a single global exposure multiply — was specified in `ATMOSPHERE_PLAN.md` §6 and
never implemented, so the two scales were reconciled **per body, by hand**, with art constants.

`VENUS_ILLUM_TRIM = 0.025` and `CLOUD_SUN_SCALE = 0.45` are not tuning knobs. They are the
missing exposure pass, implemented twice, badly, in the wrong place.

### 1.2 The five scales

| Tier | Site | Output is… | Scale | 1/r²? |
|---|---|---|---|---|
| Sphere near/mid | `bodies/*.ts` `buildFragmentNode` | `albedo × f(N·L)` | `[0,1]` albedo | ❌ |
| Far billboard | [`useFarLOD.ts:43`](../src/components/celestial/useFarLOD.ts#L43) | `albedo × sunDot` | `[0,1]` albedo | ❌ |
| Stellar point | [`StellarPoint.tsx:250-255`](../src/components/space/StellarPoint.tsx#L250) | `flux/JUPITER_REF_FLUX × 12` | arbitrary, clamped 500 | ✅ |
| Sun disc | [`Star.tsx:80`](../src/components/Star/Star.tsx#L80) | `CORE_HDR = 4096` | arbitrary | n/a (correctly constant) |
| Atmosphere + clouds | [`atmosphereData.ts:69`](../src/components/celestial/bodies/atmosphereData.ts#L69) | `sunIlluminance × …` | 20 units @ 1 AU | ✅ |
| Ship + asteroids | [`Scene.tsx:130-131`](../src/components/Scene/Scene.tsx#L130) | three.js lights | `30/π = 9.55` | ❌ |

Six, if you count the ship separately from the planets it flies past. It is worth stating
plainly: **`SunLight` does not light a single planet.**

### 1.3 Ranked defects

Severity is quantified as the factor by which the render deviates from its own physics.

| # | Defect | Where | Wrong by | Root cause |
|---|---|---|---|---|
| D01 | No exposure stage anywhere | `ATMOSPHERE_EXPOSURE` unused | — | R |
| D02 | Surfaces missing `E/π` irradiance factor | all `bodies/*.ts` | **6.37×** @ 1 AU | R |
| D03 | **Ship/asteroid** sun brightness constant across the system | [`SunLight.tsx:21`](../src/components/Star/SunLight.tsx#L21) | **6,040×** Mercury↔Neptune | R |
| D03b | **Planet-disc** luminance partly bypasses `sunIlluminance` | surface shaders + the §4.1 seam | **12.9× Neptune, 16.5× Venus** (measured, §2.2.2) | R |
| D04 | Far billboard has no illuminance term | [`useFarLOD.ts:43`](../src/components/celestial/useFarLOD.ts#L43) | **1,940×** disc ratio | R |
| D05 | `VENUS_ILLUM_TRIM` under-renders Venus | [`atmosphereData.ts:271`](../src/components/celestial/bodies/atmosphereData.ts#L271) | **32×** | R |
| D06 | Billboard→point handoff discontinuity | AUDIT_3 §2 | **68–86,000×** | R |
| D07 | Planets unreachable by three.js lights | `fragmentNode` bypasses `setupLighting()` | structural | I |
| D08 ✅ | Earth has no Lambert cosine (sigmoid, ≥0.98 for cosθ>0.1) | [`earth.ts:269`](../src/components/celestial/bodies/earth.ts#L269) | flat day disc | I |
| D09 | Textures are brightness-normalised art, uncorrected | all colour maps | **0.37×–5.4×**, 14.6× spread | I |
| D10 | Clouds ~100× brighter than the ground below them | [`cloudCommon.ts:141`](../src/components/celestial/bodies/cloudCommon.ts#L141) | **10–30×** | R |
| D11 | Shipped defaults are `toneMapping: false` (→ Neutral, crushes above linear ≈4) **and** `bloom: false` | [`store.ts:29-30`](../src/store/store.ts#L29) | 2 code values | I |
| D12 | Bloom is radius 0, strength 0.02, additive | [`SpaceRenderer.tsx:516`](../src/components/space/SpaceRenderer.tsx#L516) | no glare | I |
| D13 | No SDR/HDR display handling; 8-bit sRGB only | `Scene.tsx` renderer ctor | — | I |
| D14 | No AA of any kind (`antialias:false`, no TAA) | `Renderer.js:101,275` | flicker | I |
| D15 | Sun disc radiance 61× below its own scale | [`Star.tsx:80`](../src/components/Star/Star.tsx#L80) | **61×** | R |
| D16 | Night side has nothing but a texture | — | — | I |
| D17 | `sunIlluminance` baked at module load from a static position | [`atmosphereData.ts:249`](../src/components/celestial/bodies/atmosphereData.ts#L249) | blocks orbital motion + procedural systems | F |
| D18 ✅ | Star radius, colour and luminance hardcoded G2V/Sol | [`Star.tsx:38,154`](../src/components/Star/Star.tsx#L38) | blocks procedural systems | F |
| D19 | No scotopic/mesopic vision model; deep space is underexposed daylight | — | look, not correctness | I |
| D20 | Luna's `stellarPoint.geometricAlbedo` is 0.0036 vs a measured 0.136 | [`luna.ts:151`](../src/components/celestial/bodies/luna.ts#L151) | **38×** too dim | I |
| D21 | `earth_normal` is 2K/58 KB; 1 LSB = 1.00° spurious tilt, and `N·L` amplifies it 1/cosθ | `public/textures/earth_normal.ktx2` | ±28% hard-edged steps at 87° SZA; **asset, mitigated in-shader** — §5.5 | I |
| D22 ✅ | Ocean "Schlick" Fresnel is `0.02 + 2.0·(1−cosθ)^2.5` — not Schlick, **peaks at 2.02** | [`earth.ts:543`](../src/components/celestial/bodies/earth.ts#L543) | ocean returns 202% of incident light; 7.4× hot at 60° | I |
| D23 | Day texture's dark end is crushed: deep Pacific linear luminance **0.0014** vs a real 0.03–0.06 | `earth_day_*.ktx2` | ocean **21–43× too dark**, Amazon 4–6×; Sahara + ice correct ⇒ non-uniform, per-region. Phase 2c | I |
| D24 ✅ | **Every planet rendered MIRRORED.** All KTX2s are `KTXorientation: rd` (top-down); three's KTX2Loader ignores orientation; `SphereGeometry` `uv.y = 1` at north ⇒ v-flip | `CelestialBody.tsx`, `cloudCommon.ts` | geometric north pole was showing Antarctica — see §5.6 | I |
| D25 | Diffuse sky **underflows RGBA16F** (2⁻²⁴ = 5.96e-8; sky p50 is 9.6e-9) → stores as exactly 0 | `MilkyWaySkybox.tsx` | no Milky Way nebulosity; needs source pre-exposure (§3.2) | I |
| D26 | The player ship's hull carries **99% of metered flux** in deep space | `ShipOne.tsx` + meter | stars vanish; third-person-camera problem, damp the local scene in metering | I |
| D27 | ✅ **The bounce fill was never occluded** (and non-dominant bodies cast no shadow at all) | [`SunLight.tsx`](../src/components/Star/SunLight.tsx), [`sunOcclusion.ts`](../src/components/space/sunOcclusion.ts) | ship glowed at 0.25 cd/m² inside an umbra, drowning the stars | ✅ |

`R` = resolved by the unified scale + exposure work. `I` = **independent** bug that would
survive a perfect exposure system and needs its own fix. `F` = blocks a stated **future**
requirement (orbital motion, procedural systems — §3.0) rather than being visible today.

Note that eight are independent and two are future-blocking — this is not "just add
auto-exposure". The two `F` rows are the cheapest items on the list *now* and among the most
expensive to retrofit later, which is why they land in Phase 0 and Phase 3.

---

## 2. Engine facts verified against current code

Everything here is cited and was read, not assumed.

- **The HDR chain is real.** Every offscreen target is `HalfFloatType` (RGBA16F): `rt`, `rtB`,
  `apRT`, both LUTs, the BSM pair, the sparse cloud MRT, the cloud history. Nothing clamps to
  `[0,1]` before the tonemapper. The clamp is exactly where it should be — the final canvas write.
- **Tone mapping is applied exactly once**, in-graph at
  [`SpaceRenderer.tsx:526`](../src/components/space/SpaceRenderer.tsx#L526), with
  `renderer.toneMapping = NoToneMapping` set so `renderOutput()` cannot re-apply it. The
  save/restore dance around the scaled/local passes is **vestigial — a provable no-op**, not a bug.
- **`renderer.toneMappingExposure` is already wired into the node graph and never written.**
  It sits at 1.0. This is a free exposure hook.
- **R3F never touches `toneMapping` or `outputColorSpace`** (grepped the dist bundle; zero hits),
  so the three.js defaults are live: `outputColorSpace = SRGBColorSpace`,
  `toneMapping = NoToneMapping`, `toneMappingExposure = 1.0`.
- **`ColorManagement.workingColorSpace` is the default `LinearSRGBColorSpace`** — not written
  anywhere in `src/`.
- **Planets are doubly disconnected from the lights.** (a) They live in `scaledScene`, rendered
  by a separate `gl.render()` call ([`:707`](../src/components/space/SpaceRenderer.tsx#L707) vs
  [`:1004`](../src/components/space/SpaceRenderer.tsx#L1004)). (b) three r183 skips
  `setupLighting()` entirely when `NodeMaterial.fragmentNode !== null`
  (`three.webgpu.js:20934`, `:20990-21003`).
- **The seam is one line** —
  [`atmospherePass.ts:2039`](../src/components/space/atmospherePass.ts#L2039):
  ```ts
  return vec4(sceneColor.mul(T).add(apSample.rgb), 1);
  ```
  `sceneColor` ≈ 0.09 (albedo scale) is added to `apSample.rgb` = `uSunIlluminance × (…)` ≈ 20
  (illuminance scale). Nothing rescales either side.
- **`sunIlluminance` already derives from real orbital distance and 1/r²**
  ([`atmosphereData.ts:199`](../src/components/celestial/bodies/atmosphereData.ts#L199)). The
  physics is there; only the surfaces don't consume it.
- **Clouds already consume `sunIlluminance`** —
  [`cloudCommon.ts:141`](../src/components/celestial/bodies/cloudCommon.ts#L141):
  `sunIlluminance.mul(sunT).mul(CLOUD_SUN_SCALE).mul(shadow)`. So clouds sit at ≈9 units while
  the ground beneath them sits at ≈0.09. That ~100× ratio (physically ~3–10×) is why the
  screenshots show blown-white cloud tops over a dark ocean.
- **Nothing casts a shadow-map shadow.** `renderer.shadowMap` is never touched, no light has
  `castShadow`, and `ShipOne`'s `castShadow`/`receiveShadow` flags are inert. All seven
  shadowing effects in the game are analytic or texture-based.
- **No MSAA, no TAA, no FXAA.** `antialias: false`, `samples: 0`.

### 2.1 Measured (numerical replica of the engine's own march)

`node docs/LightingResearch/audit4_atmosphere_replica.mjs` — a JS replica of the MS bake +
main march driven by the real `sol.json`:

| | Earth (illum 20) | Venus (illum 40.631, untrimmed) |
|---|---|---|
| Disc L, 256 steps | `[0.151, 0.325, 0.781]` | `[11.081, 12.605, 13.271]` |
| Single-scatter only | `[0.103, 0.219, 0.486]` | `[2.160, 2.311, 2.380]` |
| `1/(1−F_ms)` peak | `1.45` | **`174`** |
| Lambertian physical `p·E/π` | 2.737 (p=0.43) | 8.924 (p=0.69) |
| Blue transmittance at surface | 0.80 | 2.5e-17 |

Ground-truth zenith sky from the surface, sun at zenith: `[0.459, 0.614, 1.019]` game units,
photopic mix 0.610 → **3,900 cd/m²** at the calibration below. Real clear-sky zenith at solar
noon is ~2,000–8,000 cd/m². ✅ The atmosphere's absolute scale is right.

### 2.2 The Venus multiple-scattering question

> ## ⛔ THE "+18…+21%, ACCEPTED" VERDICT BELOW IS RETRACTED — see §2.2.4
>
> On-device measurement after Phase 2a puts Venus' disc at an implied **reflectance of 11.35**,
> i.e. it emits **11× more light than falls on it**. That is impossible at any geometry, so the
> excess is **~16×, not 20%**, and it IS a bug.
>
> **RESOLVED in §2.2.5** — it was the multiple-scattering geometric series diverging; clamped
> at `uFmsMax = 0.92`, calibrated against the validated Monte Carlo.
>
> **The reasoning error was mine and it is worth naming:** §2.2 validated the Monte Carlo against
> an analytic reference, and the *replica* against the Monte Carlo — then I concluded something
> about the **engine**, which was never measured against either. The replica was written as "a JS
> replica of the engine's own march" and I trusted that label instead of testing it. The engine
> produces ~12× more than the replica does.
>
> The rest of this section is still valid *about the replica and the Monte Carlo*, and §2.2.3's
> paper findings still stand. Read it as background, not as a verdict on the engine.

Three findings, in the order they were established.

**(a) The Monte Carlo estimator is validated.** The three-way disagreement in the original audit
was resolved: **my own derivation was the wrong one.** I used Rayleigh `p(180°) = 3/(8π) = 0.1194`
(the `∫p dΩ = 1` convention) inside a formula written for the `∫p dΩ = 4π` convention, which
needs `p(180°) = (3/4)(1+cos²Θ) = 1.5`. That is a factor of exactly `4π = 12.566` — and
`0.00271 × 4π = 0.0341`. The correct analytic reference is:

```
π·L/F₀ = ω · p(180°) · [1 − e^{−2τ}] / 8 ,   p(180°) = 1.5      [∫p dΩ = 4π]
τ = 0.1, ω = 1  ⇒  0.0340
```

Restricting the MC to **exactly one scattering event** makes it compute the same quantity as the
analytic. Run at N = 4×10⁶ (`audit4_mc_validation.mjs`):

| τ | analytic SS | MC (1 scatter) | ratio | ±1σ |
|---|---|---|---|---|
| 0.01 | 3.713e-3 | 3.918e-3 | 1.0553 | 2.56% |
| 0.03 | 1.092e-2 | 1.094e-2 | **1.0015** | 1.53% |
| 0.1 | 3.399e-2 | 3.418e-2 | **1.0056** | 0.86% |
| 0.3 | 8.460e-2 | 8.464e-2 | **1.0005** | 0.55% |
| 1.0 | 1.621e-1 | 1.611e-1 | **0.9939** | 0.40% |

Agreement within ±0.9% across two decades of τ (the τ=0.01 row is 2σ on ~150 counted photons).
With full physics restored the excess grows monotonically with τ — 1.002, 1.033, 1.089, 1.272 at
τ = 0.01…0.3 — which *is* multiple scattering. The earlier apparent "20% bias" was Poisson noise
at N = 4×10⁵; the original script's printed expectation of 0.0188 remains unexplained and should
be deleted.

**(b) Venus, with the validated estimator** (N = 2×10⁵, `E_venus = 40.631` game units):

| ch | τ | ω | true π·L/E | L_true | engine | **engine/true** |
|---|---|---|---|---|---|---|
| R | 9.07 | 0.9838 | 0.7245 ±0.75% | 9.370 | 11.081 | **1.183** |
| G | 19.52 | 0.9912 | 0.8068 ±0.72% | 10.434 | 12.605 | **1.208** |
| B | 45.88 | 0.9941 | 0.8541 ±0.70% | 11.047 | 13.271 | **1.201** |

Re-running with `surfAlb = 0` instead of 0.5 moves the result by 0.3–0.6%, confirming the ground
is irrelevant at these optical depths and the comparison is clean. The +18…+21% excess is ~28σ
outside the error bar: **real, and quantified.**

Note also that the *true* values (9.37–11.05) themselves exceed the Lambertian `p·E/π` of 8.924
by 1.05–1.24×. So the original caution was right: exceeding `A·E/π` at phase 0 is **not** evidence
of an energy violation, and the audit was correct to refuse to conclude from it.

**(c) It is the approximation's own documented failure mode, not our bug.** From
[`EpicGames.md`](AtmosphereReferences/EpicGames.md) (Hillaire 2020):

- The method explicitly targets dense atmospheres. Figure 7 shows "**50 times denser air**";
  Figure 11 shows "Earth atmosphere **55× thicker**" against a path-traced reference at depth 100,
  and claims it is "the only non-iterative technique that can approximate the ground truth". §7:
  "the atmosphere may get denser and it then becomes important to account for higher scattering
  orders. **While our new model (O) automatically takes that into account**…". Venus' ~90×
  Rayleigh is only 1.6–1.8× beyond the published test — the same order, not a different regime.
- But §7 names our exact symptom: "When using very high scattering coefficients, the **hue** can
  be lost or even start to drift as compared to the ground truth," and Figure 12: "a dense
  atmosphere can result in a **different multiple-scattering color**." Our error is not a uniform
  gain — it is 1.183 / 1.208 / 1.201, i.e. red-deficient relative to green and blue. **A mild hue
  drift at high scattering coefficients is precisely what the paper says to expect.**
- **Our implementation follows the paper's own recommendation.** The paper says `f_ms` must stay
  in `[0,1]` and that "to help respect that range, it is recommended to use the analytical
  solution to the integration of Equation 8". [`atmospherePass.ts:1533-1536`](../src/components/space/atmospherePass.ts#L1533)
  does exactly that: `MSint = scattering·(1 − sampleT)/extinction`. And the guard at
  [`:1559`](../src/components/space/atmospherePass.ts#L1559),
  `psi = inScattered / max(1 − Fms, 1e-4)`, permits amplification to 10,000× — our Venus peak is
  174×, so it never engages. There is no clamp bug and no range violation.
- Also settled: the paper states 16-bit float is sufficient for its LUTs ("a 16 bit float
  representation is enough for model (O)"), so our `HalfFloatType` LUTs are per its own guidance.
  The `T = 2.5e-17` blue transmittance underflowing to 0 in half-float is **correct behaviour** —
  at optical depth 46 the true transmittance is zero to any precision that matters.

**Decision: accept the +20%.** It is 0.24 stops, on a body that will be at or near exposure
clipping regardless, and it is dwarfed by the defects this plan actually fixes (6.37× on surfaces,
32× on the trim). Adding an `f_ms` clamp or a density-dependent correction would be a new
per-body art constant — exactly the pattern §3.0 forbids. Revisit only if Venus' hue reads wrong
on device after Phase 2, and if so fix it by improving the *model* (a real UV/blue absorber for
the H₂SO₄ haze), not by scaling the output.

### 2.2.2 FIRST LIVE MEASUREMENTS — `__lum`, 2026-08-14

Six probes of the real engine, decoded (the raw readings needed a half-float fix — see §5.2).
**Two of these validate the design; two quantify defects for the first time.**

All values below are from the **fixed** decoder, with `__lum.selftest()` passing.

| View | units (R,G,B) | photopic units | cd/m² | expected | verdict |
|---|---|---|---|---|---|
| Day side, just above cloud tops, sun high | 2.92, 3.19, 3.74 | 3.17 | **19,143** | 10,000–30,000 | ✅ |
| Sun **disc** near the horizon | 208, 62.5, 18.0 | 90.2 | 545,000 | ≈600,000 | ✅ R/B = 11.6 |
| Sky **beside** the horizon sun | 1.55, 0.379, 0.128 | 0.609 | 3,678 | — | ✅ R/B = 12.1 |
| Terminator, looking up | 0.0114, 0.0136, 0.0346 | 0.0147 | 89 | twilight | ✅ B/R = 3.0 |
| Terminator, looking down at Earth | 0.0019, 0.0031, 0.0107 | 0.0034 | 21 | — | plausible |
| **Venus** disc from orbit, zero phase | 2.18, 3.89, 6.05 | 3.68 | 22,216 | 0.223 units | ❌ **16.5×** |
| **Neptune** disc from orbit | 0.0086, 0.0385, 0.174 | 0.0420 | 253 | 0.0033 units | ❌ **12.9×** |
| Venus' shadow, facing deep space | 0.0034, 0.0027, 0.0029 | 0.0029 | 17.3 | ~1e-4 | ❌ **~170,000×** |

**✅ The 6,038 cd/m² calibration is independently confirmed.** Sunlit cloud tops at 19,143 cd/m²
lands inside the real 10,000–30,000 range, by a completely different route from the two anchors in
§3.1. The unit convention is settled.

**✅ The atmosphere's spectral behaviour is right.** The horizon sun at R/B = 11.6 and the sky
beside it at R/B = 12.1 are Rayleigh extinction through a horizon airmass, at an absolute level
(545,000 cd/m²) matching the real horizon sun.

**❌ THE PLANET-DISC ERROR IS 13–17×, NOT THE 400–1,100× FIRST REPORTED.** The first pass
misidentified Venus as an ice giant from its blue colour and drew a wildly wrong conclusion. Venus'
disc from orbit *is* blue-dominant (B/R = 2.8) because it is dominated by in-scatter through a
Rayleigh column of optical depth 9–46 — exactly what the §2.1 replica predicted
(`[11.08, 12.61, 13.27]`, blue-highest). The warm `[1.0, 0.97, 0.85]` tint belongs to the
*stellar-point* tier, which is not in play from orbit. **Measured, per body:**

| Body | live E | expected `p·E/π` | measured | error |
|---|---|---|---|---|
| Neptune | 0.02343 | 0.00330 units (20 cd/m²) | 0.0420 | **12.9×** |
| Venus (against its TRIMMED E) | 1.0158 | 0.2228 units (1,345 cd/m²) | 3.68 | **16.5×** |
| Venus (against UNTRIMMED E) | 40.631 | 8.912 units (53,815 cd/m²) | 3.68 | 0.41× |

**Two consequences, and the second is new:**

1. **Distinguish two different defects that §1.3 conflated.** D03 (the *ship's* `SunLight.intensity`
   being distance-independent, a structural 6,040× across Mercury↔Neptune) is separate from the
   *planet-disc* error, which is now measured at **13–17×**. Both are real; only the second has a
   number. Correct the expectation for Phase 2: it is a ~1-in-15 brightness change on planet discs,
   not a thousandfold one.
2. **Removing the Venus trim alone will NOT restore physics — a large part of Venus' disc bypasses
   `sunIlluminance` entirely.** Venus measures 16.5× *above* what its own trimmed illuminance
   implies, and 0.41× of the untrimmed value. If the disc were purely atmospheric in-scatter it
   would track illuminance linearly and land at 0.28 units (the replica's 11.08 scaled by
   1.0158/40.631). It measures 3.68. So most of Venus' brightness arrives through an
   albedo-scale path that ignores illuminance — which is precisely the §4.1 seam, and it means the
   cancellation is *partial and body-dependent*, not a clean factor. Phase 2 must re-measure
   Venus and Neptune with `__lum.compare()` after the change, not assume the trim removal balances.
   That Neptune (12.9×) and Venus (16.5×) sit so close together is encouraging: it suggests a
   systematic bypass fraction rather than per-body chaos.

**❌ The deep-space floor is ~170,000× too bright, and it IS the skybox.** 17.3 cd/m² where
airglow/zodiacal light is ~1e-4 — that is 13.1 magnitudes, matching AUDIT_3's "~20 mag" estimate in
kind. **Correction to the first report:** I claimed the floor was "exactly grey (R=G=B to the bit)"
and inferred a constant additive term. With the decoder fixed the channels differ
(0.0034, 0.0027, 0.0029, red-dominant), so it is a *texture* — the Milky Way panorama — not a
constant. Phase 7 should re-author or rescale it, as originally planned.

⚠ **This is the real constraint on `evMin`.** §3.4 argued the background sits ~3 orders of
magnitude *below* a mag-6 star's per-pixel equivalent (1.07e-2 cd/m²). At 17.3 cd/m² it currently
sits ~1,600× *above* it, so no exposure setting can show stars against this sky. **The skybox
rescale is therefore a prerequisite for the stars-visible goal, not a nice-to-have — promote it
from Phase 7 into Phase 5 alongside auto-exposure.**

### 2.2.4 POST-PHASE-2a MEASUREMENTS — Venus is a real energy bug, ~16×

Measured on device with `__lum.compare()` after Phase 2a. `E` is each body's live illuminance;
**implied reflectance** `R = L·π/E` is the reflectance the shader must be emitting.

| body | E | expected `p·E/π` | measured | ratio | implied R | p | R/p |
|---|---|---|---|---|---|---|---|
| earth | 22.458 | 3.103 | 0.2845 | 0.092× | 0.0398 | 0.434 | 0.092 |
| **venus** | 40.631 | 8.911 | **146.8** | **16.47×** | **11.35** | 0.689 | **16.5** |
| mars | 9.124 | 0.4937 | 0.2414 | 0.489× | 0.0831 | 0.170 | 0.489 |
| jupiter | 0.7715 | 0.1321 | 0.08337 | 0.631× | 0.3395 | 0.538 | 0.631 |
| neptune | 0.02343 | 0.003296 | 0.00002827 | 0.0086× | 0.00379 | 0.442 | 0.0086 |

**The `R > 1` test is what makes this conclusive, and it is the tool to reach for in future.**
Unfavourable geometry — probing away from the sub-solar point, limb darkening, `N·L < 1`,
atmospheric transmittance — can only push `R` **down**. So:

- **Venus `R = 11.35 > 1` is impossible at any geometry.** A body cannot emit more than it
  receives. This is an unambiguous energy-conservation violation in the atmosphere pass, ~16×.
  It is now the largest known defect in the system.
- **Every other row has `R < p`, which is AMBIGUOUS.** It could be the texture-albedo error (D09,
  Phase 2c) or simply a probe that landed off the sub-solar point — a single hand-aimed probe
  cannot separate them. Do not read Earth's 0.092× or Neptune's 0.0086× as measurements of D09
  until they are re-taken from a consistent pose.

**Venus' ratio is invariant across Phase 2a — 16.5× before, 16.47× after — while its `E` changed
40×.** That is itself informative: the disc scales exactly with illuminance, so it is entirely
in-scatter, with no albedo-scale component. It also means the trim removal did precisely what it
was supposed to (it was a pure exposure hack) and left the underlying 16× untouched.

**Harness bug found and fixed by this run:** `expected()` only worked for whichever body was
currently the registered dominant atmosphere, so four of five `compare()` calls failed. It now
falls back to the authored star distance, and `compare()` prints the implied reflectance.

### 2.2.5 FOUND AND FIXED — the multiple-scattering geometric series (2026-08-14)

Ablation settled it in one session. `__lum.compare("venus")` in Venus orbit, implied
reflectance `R = L·π/E` (R > 1 is physically impossible):

| configuration | max amplification | measured R | vs ground truth |
|---|---|---|---|
| MS ablated (`setMsScale(0)`) | — | 0.061 | 13× too dim |
| `uFmsMax = 1` (previous behaviour) | 10,000× | **6.974** | **8.8× — IMPOSSIBLE** |
| `uFmsMax = 0.95` | 20× | 1.176 | 1.48× — still impossible |
| `uFmsMax = 0.90` | 10× | 0.618 | 0.78× |
| `uFmsMax = 0.85` | 6.7× | 0.432 | 0.55× |

**The entire excess lives in the geometric series**, not in single scattering — MS off leaves
Venus 13× too *dim*, MS unclamped leaves it emitting 7× more light than falls on it.

**Why this is a regularisation and not a fudge.** `Ψ = L₂/(1−F_ms)` sums infinite isotropic
re-scattering assuming each bounce returns a fraction `F_ms`. For Venus (single-scatter albedo
0.984–0.994, vertical τ 9–46) `F_ms → 0.994` is arguably *correct* — and the series' honest answer
is then ~174×. The series is simply the wrong model at that point, because it ignores that energy
also escapes. Hillaire states `F_ms` is "in the range [0,1]" and recommends techniques "to help
respect that range", i.e. he acknowledges it can breach; his `max(1−F_ms, 1e-4)` is a
divide-by-zero guard that still permits 10,000×.

**The value is calibrated against ground truth, not taste.** The validated Monte Carlo (±0.9%
against an analytic single-scatter reference) gives Venus' nadir sub-solar π·L/E =
[0.7245, 0.8068, 0.8541], photopic **R\* = 0.7927**. Log-interpolating the table above for
`R = R*` gives **0.9193 → `uFmsMax = 0.92`**, now the default. Note R\* is *not* Venus' geometric
albedo 0.689 — sub-solar nadir legitimately exceeds the disc average for a limb-darkened body.

**And it is provably inert everywhere else.** The clamp only bites where `1/(1−F_ms)` would exceed
12.5×. Earth's `F_ms` peaks at 0.310 (amplification 1.45×), far below it; the H₂/He giants scatter
weakly per molecule and sit lower still. So this is a **global bound on a divergent series**, not
the kind of per-body art constant §3.0 forbids — it changes exactly those bodies where the
approximation has already broken down.

✅ **VERIFIED on device:** with `uFmsMax = 0.92`, Venus measures **R = 0.7575 against the Monte
Carlo's R\* = 0.7927 — 4.4% low**, comfortably inside the MC's own uncertainty. Ratio vs the
disc-averaged `p·E/π` is 1.099×, which is the expected sign (sub-solar exceeds the disc average).

⚠ **Earth's inertness is still unverified** — the attempt was invalidated by the `compare()` bug
below. The clamp *cannot* engage at Earth's F_ms = 0.31, but that is an argument, not a measurement.

### 2.2.6 `compare()` was measuring the wrong body — fixed

The Earth inertness check returned `ratio 3.158×, R = 1.370` from Venus orbit, and
**byte-identical `measured` values for `compare("venus")` and `compare("earth")` from the same
location** (9.797 units at Venus, 0.03279 at Earth). That is the tell: `compare()` probed the
screen centre *without warping*, so it measured whatever was on screen and compared it against
the **named** body's expectation. Every cross-body number taken this way is meaningless.

Two fixes, both now in:

1. **`compare()` warps by default.** Pass `{ warp: false }` to probe where you are.
2. **The pose is the SUB-SOLAR point**, not `resolveBodyWarp`'s. That helper places the eye along
   a fixed approach axis, so the phase angle is incidental and a body can be measured over its
   night side — which is exactly why Earth read 0.0106× (198 cd/m²) at `earth_4100`. `p·E/π` is
   defined at **zero phase**, so the harness now puts the camera on the body→star line looking
   back at the body, sub-solar point dead centre. `sweep()`'s disc rows use the same pose.

**This retroactively voids the "ambiguous `R < p`" readings in §2.2.4** for Earth, Mars, Jupiter
and Neptune — they may have been measuring partly-lit discs. Re-take them with the fixed
`compare()` before drawing any conclusion about texture calibration (Phase 2c).

**Diagnostics retained:** `__lum.setMsScale(x)` and `__lum.setFmsMax(x)`, both forcing a LUT
re-bake via an epoch counter (the LUTs are otherwise baked only on body change, so a runtime dial
would silently do nothing).

### 2.2.7 The 3/2 I dropped, and what the clean sweep actually shows

**My expectation was wrong by a factor of 1.5, and it coloured every "too dim/too bright" call.**
`p·E/π` is a DISC-AVERAGED quantity — geometric albedo is defined by the total flux the disc
returns at zero phase. The probe aims at the **sub-solar point**, the brightest point on that disc.
For a Lambert sphere of surface albedo A: sub-solar `R = A`, geometric `p = (2/3)A`, so
**`R = 1.5p`**. A perfectly correct Lambertian body reads **ratio 1.5, not 1.0**.

`__lum` now reports `ratio vs sub-solar` as the headline number (1.0 = correct Lambert sphere).
First clean sweep, re-read against it:

| body | vs disc-avg | **vs sub-solar** | implied A | p |
|---|---|---|---|---|
| earth | 2.015 | **1.343** | 0.875 | 0.434 |
| venus | 2.037 | **1.358** | 1.403 | 0.689 |
| mars | 2.013 | **1.342** | 0.342 | 0.170 |
| luna | 2.979 | **1.986** | 0.405 | 0.136 |
| jupiter | 0.782 | **0.521** | 0.421 | 0.538 |
| neptune | 0.427 | **0.285** | 0.189 | 0.442 |

**This splits into two independent defects, which is the useful result:**

1. **The three bodies with significant atmospheres cluster at 1.34 within 1.2%** (earth 1.343,
   venus 1.358, mars 1.342). Three very different discs — ocean+land texture, pure in-scatter
   cloud deck, dust haze — cannot agree to 1% by coincidence. Venus in particular is in-scatter
   dominated (T ≈ 0), so a texture explanation is impossible for it. **This is the atmosphere pass.**
2. **The weak/no-atmosphere bodies scatter 0.29–1.99**, which is D09 texture calibration and
   matches AUDIT_2's independent per-body measurements in both sign and magnitude: Luna's texture
   too bright (audit 0.37× ⇒ 2.7×; measured 1.99), Neptune's too dark (audit 5.4×; measured 3.5×).
   **This is Phase 2c**, and it now has numbers.

### 2.2.8 RETRACTED — the disc IS distance-invariant

Measured across 2,000 → 60,000 km at the sub-solar pose: **18.13, 18.14, 18.15, 18.16 units.**
Flat to 0.2%. Radiometry is intact; there is no altitude-dependent bug.

**The apparent 1.85× was my own instrument.** The 9,600 km reading (9.797 units) was taken with
the OLD `compare()`, before it warped — so it sampled an off-centre point on the disc, not the
sub-solar point. Two probes of different points on the same disc, compared as if they were the
same measurement.

⚠ **This invalidates the clamp calibration in §2.2.5.** That whole ablation series was taken at the
off-centre pose, so the fit — and the "R = 0.7575 vs R\* = 0.7927, 4.4%, verified" — were both
artefacts. The clamp was tuned to the wrong target.

**Recalibrated** by scaling the series by the measured pose factor (1.852), which cross-checks to
6% at an independent point (predicts R = 1.32 at clamp 0.92 against a measured 1.403):

| clamp | R at sub-solar | vs ground truth R\* = 0.7927 |
|---|---|---|
| 0.95 | 2.18 | 2.75× |
| 0.92 | 1.40 (measured) | 1.77× — still impossible (R > 1) |
| 0.90 | 1.15 | 1.44× |
| **0.85** | **0.80** | **1.01×** ✅ |

`uFmsMax` is now **0.85**.

✅ **VERIFIED at the sub-solar pose: R = 0.8316 against ground truth 0.7927 — 4.9% high, and
below 1.** The energy violation is gone, and the rescaled-series prediction (0.80) held to 4%.
`ratio vs sub-solar` reads 0.8046 against a target of 0.767 — the same 4.9%, consistently.

**CONVERGED — stop here.** 4.9% sits inside the stacked uncertainty: the MC's own ±0.7%, the
±6% pose-factor rescale, and the gap between the *derived* Venus atmosphere and the real one
(`deriveAtmosphere` fits bulk composition, not Venus' actual H₂SO₄ haze). Chasing the last 5%
would be over-fitting a single body — precisely how `VENUS_ILLUM_TRIM` came to exist.

⚠ Note Venus' target is **0.767, not 1.0**. The Lambert reference assumes sub-solar = 1.5·p;
Venus' real ratio is `R*/p = 1.15`, so `1.15/1.5 = 0.767`. The "1.0 = correct" rule is a Lambert
approximation — wherever real ground truth exists, it wins.

### 2.2.10 Clamp confirmed body-selective; Earth's row is unsettled

Post-clamp sweep. Four of five non-Venus bodies moved by ≤2%, confirming the `F_ms` argument —
the clamp only bites where the series has diverged:

| body | before | after | change |
|---|---|---|---|
| venus | 18.15 | 10.76 | **−41%** (intended) |
| luna | 2.882 | 2.934 | +1.8% |
| mars | 0.9940 | 0.9950 | +0.1% |
| jupiter | 0.1033 | 0.1032 | −0.1% |
| neptune | 0.001409 | 0.001409 | 0.0% |

Venus reads **0.805 against its 0.767 target**, matching `compare()`'s 0.8046 — two independent
paths agreeing.

⚠ **Earth swung 7.1× between identical sweeps** (6.253 → 0.8777 units). Nothing in the change can
do that: its `F_ms` is 0.31, far below the clamp, and every other body held. The implied
reflectance went 0.875 → 0.123 — **cloud top versus open ocean**. Earth is the only body with
volumetric clouds, a cloud shell, TAA reconstruction and 8K texture tiers, so the probe lands on
different content depending on what has finished streaming. `deep_space`'s 5.2× swing is separate
and benign: it uses the approach-axis pose and 317,001 cd/m² is the sun drifting into frame.

**Fixed by making it visible rather than silent:** `sweep()` now settles 420 frames (was 180) and
**probes twice, 90 frames apart**, warning when the two differ by >2% and printing a `drift`
column. A single probe reports an unsettled scene as a confident number — which is the failure an
instrument exists to prevent.

### 2.2.9 ⚠ A limit of point-probing textured bodies

Venus was clean to calibrate because its disc is a **uniform** cloud deck: the sub-solar point is
representative, so comparing it to a whole-disc geometric albedo is meaningful.

That does **not** hold for a textured body. Earth's measured sub-solar reflectance is 0.875 — but
Earth's geometric albedo of 0.434 is a whole-disc average over bright cloud *and* dark ocean, and
a thick cloud alone is 0.8–0.9. So Earth's 1.34 may be entirely legitimate: the probe simply landed
on cloud. Mars is the same story (implied 0.342 against p = 0.170, and Martian bright dust reaches
0.3+).

**So the Earth/Mars/Luna/Jupiter/Neptune ratios cannot settle D09 on their own.** Phase 2c needs a
**disc-average** measurement — integrate the rendered disc and compare *that* to geometric albedo,
which is the quantity geometric albedo is actually defined as. A centre probe is the wrong
instrument for that question, and reading D09 off these numbers would repeat the geometry mistake
in a new costume.

**✅ BUILT 2026-08-17 — `__lum.disc(bodyId)`.** Warps to the sub-solar pose, derives the disc's
pixel radius **analytically** (`asin(R/d)` against the scaled camera's FOV — no luminance
thresholding, so the atmosphere's halo cannot inflate the footprint), masks to a circle, and reads
the whole disc back in one call. Reports the projected-area **mean** → `impliedGeometricAlbedo`,
directly comparable to `bodyPhotometry`, plus **percentiles**.

Percentiles because on a textured body *the ordering is the identification*: p02 of a fully-lit
Earth disc is clear deep ocean, p98 is thick cloud top. So the cloud-contrast question gets answered
without anyone hand-picking a pixel — which was the other half of why point-probing failed here.
⚠ `p100` is normally the specular glint, not cloud; read p98. `setLumSource` now carries the scaled
camera to make this possible.

#### First run (2026-08-17) — it overturned two standing beliefs at once

| | units | implied R | real |
|---|---|---|---|
| p02 clear ocean | 0.3165 | **0.0443** | 0.06–0.10 ✅ |
| p50 | 0.4104 | 0.0574 | |
| **mean (disc avg)** | 0.5636 | **0.0788** | **0.434 ⇒ 5.5× too dark** |
| p98 cloud top | 2.652 | 0.371 | ~0.70 |
| p100 glint | 6.30 | 0.881 | |

**p98/p02 contrast = 8.4× against a real 8.7×.** So the atmosphere in-scatter and the ocean level
are both about right, and the prediction that the haze was running 4–6× hot was **wrong** — the
washed-out look is not a too-bright atmosphere.

**The entire 5.5× deficit is cloud COVERAGE.** 75% of the rendered disc sits at R ≤ 0.076, i.e.
clear sky; only ~2% reaches cloud brightness. Real Earth is ~60–67% cloud. The arithmetic closes
from both directions: real `0.67·0.7 + 0.33·0.05 = 0.49 ≈ 0.434`; ours
`0.02·0.371 + 0.98·0.055 = 0.061 ≈ 0.079`. And cloud pixels are only ~⅓ opaque — the shell's own
radiance implies R ≈ 1.02, so p98 landing at 0.371 means α ≈ 0.33 at the *brightest* cloud. The
ERA5 data is not the problem (coverage ≥0.2 over 53% of the globe, and the opacity transfer
saturates at raw 0.2), so this is `columnMacroCoverage`/`fractionPlacement`. **Fix coverage, not
brightness** — and note Phase 2d still wants the brightness *halved*, so tuning it up here would
have to be undone.

⚠ **`compare("earth")` has been measuring the SPECULAR GLINT.** `p100 = 6.30` matches compare()'s
6.288 exactly. At the sub-solar pose the retroreflection is dead centre *by construction*, and
`probeMax(9)` takes the max over the centre block — so it finds the glint every time. That is also
what made Earth's row swing 7.1×. **Earth's compare()/sweep number is meaningless**, and the
§2.2's "three atmospheric bodies agree at 1.34 ⇒ atmosphere pass" inference loses Earth and is down
to two bodies — re-derive before leaning on it. The sub-solar pose is *correct* for geometric
albedo and *wrong* for a max-of-centre probe on a body with a specular ocean; the two choices
interact, and `disc()` is the instrument for Earth from here on.

**Lesson, third time on the same theme:** every one of these three errors — the replica standing in
for the engine, `compare()` measuring the wrong body, and now a rescaled pose — came from trusting
a measurement whose *geometry* I had not verified. The value was always plausible. Check what the
instrument is pointed at before believing what it says.

### 2.2.3 Probe methodology note

Two probes of "the horizon sun" at the same pose returned 90.2 and 0.609 photopic units — a 148×
spread — with **near-identical hue** (R/B 11.6 vs 12.1). Same optical path, different position on
the glare falloff: one hit the disc, one the aureole beside it. For anything small or point-like,
single-pixel `probe()` is too fragile; use `probeMax(n)` or `compare(bodyId)`, which is what the
ladder does.

### 2.2.1 Still open (does not block any phase)

- The MC's nadir sub-solar reflectance for the engine's Venus model is 0.72/0.81/0.85, while real
  Venus' *geometric* albedo is 0.689. These are **not directly comparable** — normal albedo at the
  sub-solar point exceeds the disc-averaged geometric albedo for any limb-darkened body — so no
  conclusion follows about whether the derived Venus coefficients are too reflective. Answering it
  needs a disc integration, not a nadir sample. Worth doing when `__lum` exists, since it would
  validate `deriveAtmosphere()` against measured albedo for *every* body at once, which is
  directly load-bearing for procedural systems (§3.0).

---

## 3. Target architecture

### 3.0 Locked decision — design for motion and procedural generation from day one

Two confirmed future requirements change what "correct" means here, and both are cheap now and
expensive later:

1. **True-to-life orbital motion and rotation.** Bodies orbit, so their distance to the star
   changes continuously — and so do the phase angle (sun–body–camera) and the sun's direction.
2. **Procedurally generated star systems, backed by real science, with no per-system tuning.**

Together they impose one rule: **nothing about lighting may be a hand-tuned per-body constant,
and nothing may be baked at module load.** Every brightness must be a pure function of
(physical description, live geometry). This is already the stated philosophy of
[`atmosphereData.ts`](../src/components/celestial/bodies/atmosphereData.ts) — *"Planets are
DESCRIBED, not tuned"* — but it is only half-implemented.

**The blocker.** `AtmosphereParams` is built once at import:
```ts
export const EARTH_ATMOSPHERE: AtmosphereParams = deriveAtmosphere(findBody("earth"), sol, …)
```
against a **static** `PLANET_POSITION_KM`. So `sunIlluminance` is a compile-time constant. Under
orbital motion Earth's illuminance would be frozen at its authored position; under procedural
generation there is no module-level body list to enumerate at all.

**The fix — split `AtmosphereParams` by what it depends on:**

| Static (composition + mass + radius) | Dynamic (per frame, from live geometry) |
|---|---|
| Rayleigh/Mie/ozone coefficients, scale heights | `sunIlluminance` = `L★ / d(t)²` |
| radii, atmosphere top, phase-function `g` | sun direction, phase angle α |
| aerosol/dust load | star colour temperature → RGB |

Only the static half is derivable once per body and cacheable; the dynamic half becomes a
per-frame uniform. This is a small, surgical change (`sunIlluminance` is already a uniform,
`uSunIlluminance`, at [`atmospherePass.ts:1150`](../src/components/space/atmospherePass.ts#L1150)
— it is only its *source* that is frozen) and it is the difference between this design surviving
requirement #1 or being rewritten for it.

**Consequences for the rest of this plan:**

- **Phase angle must be a first-class input.** §3.6's `Φ(α)` already takes it; the sphere tier
  gets it from `N·L` and the view vector. Nothing may assume full-phase.
- **The star is not necessarily G2V.** `Star.tsx` hardcodes `vec3(1.0, 0.95, 0.9)` and
  `RADIUS_KM = 696_340`. Both must come from the star's description: radius from the body def,
  colour from a blackbody(T_eff) → linear-sRGB conversion, and luminance from
  `L = σT⁴/π` scaled into game units. Then an M-dwarf system is red and dim *for free*.
- **Texture-mean albedo calibration (§3.6) does not generalise.** Procedural bodies have no
  authored texture. So the albedo pipeline must be: *the body's geometric albedo is the
  authority; a texture, if present, is a zero-mean variation on it.* That works identically for
  hand-authored and generated bodies. Do not implement it the other way round.
- **No new per-body art constants.** `VENUS_ILLUM_TRIM`, `CLOUD_SUN_SCALE`,
  `REFERENCE_HDR`, `JUPITER_REF_FLUX` and `mars.ts:109`'s `12.0` are exactly the pattern to
  eliminate, not to extend. Each one is a future procedural system rendered wrong.
- **Validation must be parametric.** `__lum` (§4.2) should be able to assert the §3.6 table for
  a *generated* system too, by checking `L = p·E/π` against its own description rather than
  against hardcoded expectations.

### 3.1 Locked decision — the unit convention

**One linear scale for the entire frame: pre-exposed physical luminance, where
1 game unit = 6,400 cd/m² (equivalently 6,400 lux for illuminance).**

This is not a new scale — it is the scale the atmosphere already uses, back-solved:

```
Earth TOA solar illuminance  = 1361 W/m² × ~93 lm/W ≈ 126,600 lux
Engine pins Earth to           sunIlluminance = 20 game units
                            ⇒ 1 game unit = 126,600 / 20 ≈ 6,330 ≈ 6,400 lux
```

Adopting it means **the atmosphere, clouds and sky need no rescaling at all**. Only the
surfaces, impostors, star and ship lights move — and they move by a factor that is now
*derived*, not tuned.

Every shader variable gets an explicit documented quantity:

| Variable | Quantity | Units |
|---|---|---|
| `sunIlluminance` | illuminance ⊥ to the sun at the body | game units (=6,400 lux) |
| surface output | radiance | game units (=6,400 cd/m²) |
| `apSample.rgb` | in-scattered radiance | game units |
| `apSample.a` | transmittance | dimensionless `[0,1]` |
| impostor output | radiance | game units |
| `uExposure` | scale to tonemapper domain | 1/game units |

**The Lambertian surface term becomes, exactly:**
```
L_surface = albedo · (sunIlluminance / π) · N·L · T_atmos  +  ambient
```
The `1/π` is the Lambertian BRDF normalisation and is the single most commonly dropped factor
in this class of bug. Its absence is D02.

### 3.2 Locked decision — pre-exposure, not absolute luminance

The sun's disc is 1.6e9 cd/m² = **250,000 game units**, which overflows RGBA16F (max 65,504).
An absolute-luminance pipeline is therefore *impossible* in half-float. Two consequences:

1. **Adopt Frostbite's pre-exposure trick**: multiply by the current frame's exposure *at the
   source* in each shader, so buffers hold post-exposure values around `[0.01, 100]` and
   half-float precision is spent where the eye is. `uExposure` becomes a global uniform that
   every radiance-producing shader multiplies by.
2. **An exposure ceiling is mandatory, for numerical reasons as well as aesthetic ones.** With
   the ship in deep space metering on starlight (~1e-8 units), an unclamped auto-exposure would
   drive the sun disc past half-float max. The same clamp that prevents the overflow is the
   clamp that stops space being auto-brightened into grey mush. One knob, two jobs.

### 3.3 Closing the seam — sun illuminance everywhere

`sunIlluminance` already exists per body with correct 1/r². The work is to route it to the four
consumers that ignore it:

1. **Planet surfaces** — multiply by `sunIlluminance/π`. Removes D02 and, with the trim removal,
   D05.
2. **Far billboards** — replace `albedo × sunDot` with `albedo × (E/π) × Φ(α)`, where `E` is the
   body's illuminance and `Φ` a proper phase function (§3.6). Removes D04.
3. **Ship + asteroids** — `SunLight.intensity` becomes a per-frame value derived from the ship's
   actual distance to the star, in the same units. Removes D03. Note this is the *one* place
   three.js's light pipeline is still used, so the unit conversion to `DirectionalLight.intensity`
   must be pinned by a test (§4.2).
4. **Sun disc** — `CORE_HDR` becomes `solarLuminance / 6400 = 250,000`, pre-exposed. Removes D15.
   Disc *radiance* is correctly distance-invariant; only its solid angle changes. The existing
   code gets this right and must not be "fixed".

### 3.4 Exposure — the camera model and auto-exposure

**Locked: a physically based camera with histogram auto-exposure, and hard clamps.**

Metering (Filament/Unreal convention, `S=100`, `K=12.5`):
```
EV100    = log2(L_avg · 100 / 12.5) = log2(L_avg · 8)
exposure = 1 / (1.2 · 2^EV100)
```

**The scene spans 44 stops** and this is the design's hardest constraint:

| Subject | cd/m² | game units | EV100 |
|---|---|---|---|
| Sun disc | 1.6e9 | 250,000 | **+33.6** |
| Mercury sub-solar | 38,600 | 6.03 | +18.2 |
| Earth sub-solar | 17,700 | 2.76 | +17.1 |
| Full Moon | 5,540 | 0.87 | +15.4 |
| Neptune full disc | 20 | 0.0031 | +7.3 |
| Milky Way (22 mag/arcsec²) | 1.7e-4 | 2.7e-8 | −9.5 |
| Airglow | ~1e-4 | 1.6e-8 | −10.3 |

For comparison, Unreal's default histogram covers `histogram_log_min = −8` to
`histogram_log_max = +4` — **12 stops**. Ours must cover ≥44. Initial parameters:

| Parameter | Value | Rationale |
|---|---|---|
| histogram bins | 128 | 0.35 stops/bin over the range |
| `logMin` / `logMax` | −12 / +34 EV | covers airglow → sun disc |
| low / high percentile | 40% / 90% | high tail must exclude the sun; 90% is deliberately below Unreal's default because a 0.5°-wide 1e9 source is a bigger outlier than anything in a car game |
| metering | centre-weighted, cos⁴ falloff | keeps a sun at the frame edge from driving the whole exposure |
| adapt speed up / down | 1.5 / 0.6 EV s⁻¹ | asymmetric, as human adaptation is |
| **`evMin` (floor on metered EV100)** | **−16** | the most sensitive the eye is allowed to get — see the derivation below |
| `evMax` (ceiling on metered EV100) | +20 | prevents crushing a sub-solar Mercury |
| manual override | full | screenshot/photo mode, and the perf bench (§4.3) |

Note the direction: **low EV = high exposure = more sensitive.** `evMin` is therefore the
*brightest* the pipeline may render a dark scene.

**Deriving `evMin` from the stated goal ("stars brightly visible").** The dark-adapted naked-eye
limit outside the atmosphere is about magnitude 8 — more stars than anyone sees from the ground.
Targeting a comfortable mag 6:

```
E(mag 6)    = 2.54e-6 · 10^(−6/2.5)        = 1.01e-8 lux
Ω(1 px)     = (1.047 rad / 1080)²           ≈ 9.4e-7 sr      (60° FOV, 1080p)
L_equiv     = E / Ω = 1.07e-2 cd/m²         = 1.68e-6 game units
render at ~0.1 post-exposure ⇒ exposure    ≈ 6e4
exposure = 1/(1.2·2^EV)      ⇒ EV100       ≈ −16.1
```

**The "grey mush" fear is misplaced, and this matters for where the aesthetic control lives.**
At `evMin = −16` the interplanetary sky background (zodiacal light + integrated starlight,
~1e-4 cd/m² = 1.6e-8 units) renders at ~9e-4 — essentially black. Stars sit **three orders of
magnitude above the background**, so they pop against black rather than washing into haze. The
real risk of grey mush is the **Milky Way panorama being authored ~20 magnitudes too bright**
(AUDIT_3 §5). So the aesthetic knob is the *skybox's absolute luminance* and the *adaptation time
constants* (§3.9), **not** a hard exposure clamp. Set `evMin` loose and fix the skybox.

**⚠ Do not use the exposure clamp to prevent half-float overflow.** Never clamping the sun disc
out of range would require `EV ≳ +1.7`, which directly contradicts `evMin = −16`. Instead:

- **Clamp the written radiance, not the exposure**: `min(preExposed, 60000)` in the shaders that
  can emit the star. Nothing is lost — the tonemapper maps everything above ~10 to white anyway.
- **Drive the glare from a uniform carrying the star's true flux**, not from reading the clipped
  buffer. This is the one architectural consequence of clipping the sun, and getting it wrong is
  how a clipped sun ends up with a glare that is too *small* rather than blinding (§3.7).

**Implementation note:** a GPU histogram + a 1-frame-latent readback is the standard approach,
but a CPU readback stalls the frame. Prefer keeping the histogram and the adaptation entirely
on the GPU (a 1×1 `exposure` storage texture read as a uniform next frame), which is what
Unreal does — no readback, one frame of latency, no stall.

### 3.5 Tone mapping and display output

**Locked: AgX as the default operator.** Rationale:

- Its hue-preserving desaturation toward white on the path to clipping is *exactly* the fix for
  the "blown white Venus" and "hue-twisted sun" failure modes. Per-channel curves (Reinhard,
  Hable) skew hue as channels clip at different points — the problem GT7 named "hue twisting"
  and rebuilt its operator to solve.
- `NeutralToneMapping` — the **current default** — is the Khronos PBR Neutral operator, designed
  for asset fidelity in low-dynamic-range product shots. It crushes everything above linear ≈4.
  It is the wrong tool and it is what ships today (D11). Demote to a debug option.
- GT7's "Color Volume Mapping" (Yasutomi / Suzuki / Uchimura, CEDEC 2026) is the genuine state
  of the art — it maps brightness and colour *together* rather than per-channel, and drives one
  pipeline to both SDR and HDR. It is the right long-term target, but the published material
  does not contain implementable detail. AgX is the closest available shipping equivalent and is
  already in three.js. **Revisit if Polyphony publishes the operator.**

**Display output, three tiers from one render:**

| Display | Path |
|---|---|
| SDR sRGB | current path: AgX → sRGB encode → 8-bit + dither. Unchanged. |
| SDR P3 | as above; optionally `outputColorSpace = DisplayP3ColorSpace` |
| **HDR** | `new WebGPURenderer({ outputType: THREE.HalfFloatType })` + `ColorManagement.define({ [ExtendedSRGBColorSpace]: ExtendedSRGBColorSpaceImpl })` + `renderer.outputColorSpace = ExtendedSRGBColorSpace` (three r180+) |

Detection: `matchMedia('(dynamic-range: high)')`. Gamut: `matchMedia('(color-gamut: p3)')`.

⚠ **Display peak luminance is not reliably detectable in the browser.** The three.js HDR PR
says so explicitly: WebGPU's HDR support tells you "nothing about the display", leaving
developers guessing at headroom. Therefore: **ship an HDR calibration screen** — the
"raise until the logo just disappears" pattern every console HDR title uses. That value feeds
the tonemapper's peak-luminance parameter. This is not a workaround; it is what the industry does.

⚠ Also from that PR: three's own tone mapping and HDR output are **not yet meant to be
configured together**. We are lucky here — tone mapping is already applied in-graph with
`renderer.toneMapping = NoToneMapping`, so we own the display transform and can emit
extended-range values ourselves. The existing architecture is the one this needs.

CSS `dynamic-range-limit` (Chrome 133+) is available to constrain HDR on the *page* if the HUD
ever needs protection from an extended-range canvas.

### 3.6 Distant-body photometry — one radiance model for all LOD tiers

**Locked: all three tiers compute radiance from the same formula, so brightness is continuous
by construction rather than by matched fudge factors.**

```
L_body(α) = p · (E_body / π) · Φ(α)          [game units]
E_body    = L_star_solar / d_AU²  ·  20      [game units, = the existing sunIlluminance]
```

with `Φ(0) = 1` by the definition of geometric albedo. The sphere tier gets it per-pixel via
`N·L`; the billboard tier per-pixel via its dome normal; the point tier integrates it over the
disc's solid angle. **The 68–86,000× handoff discontinuity (D06) disappears** because there is
nothing left to mismatch — and `REFERENCE_HDR`, `JUPITER_REF_FLUX`, the `fade = t²` ramp and the
`500` clamp can all be deleted.

**Phase function.** `clamp(N·L, 0, 1)` is a Lambertian sphere and is wrong for regolith — it is
why the Moon reads as a soft ball rather than a flat disc with a hard limb. Use the
**lunar-Lambert (McEwen) mix**, which is one `mix()` in the shader:
```
Φ_LL = (1−k)·μ₀ + k·(2μ₀/(μ₀+μ))       // k ≈ 0.9 for lunar regolith, 0 for clouds/ice
```
The second term is Lommel-Seeliger. This also delivers the opposition surge that makes a full
Moon 1.2 mag brighter than 2× a half Moon.

**Per-body reference table** (derived: `L = 6.366·p/d²` game units; ×6,400 for cd/m²):

| Body | d (AU) | p (geom. albedo) | disc L (units) | disc L (cd/m²) | EV100 |
|---|---|---|---|---|---|
| Mercury | 0.387 | 0.142 | 6.03 | 38,600 | +18.2 |
| Venus | 0.723 | 0.689 | 8.39 | 53,700 | +18.7 |
| Earth | 1.000 | 0.434 | 2.76 | 17,700 | +17.1 |
| Moon | 1.000 | 0.136 | 0.866 | 5,540 | +15.4 |
| Mars | 1.524 | 0.170 | 0.466 | 2,980 | +14.6 |
| Jupiter | 5.203 | 0.538 | 0.127 | 810 | +12.7 |
| Io | 5.203 | 0.63 | 0.148 | 947 | +12.9 |
| Europa | 5.203 | 0.67 | 0.158 | 1,011 | +13.0 |
| Ganymede | 5.203 | 0.43 | 0.101 | 646 | +12.4 |
| Callisto | 5.203 | 0.22 | 0.052 | 331 | +11.4 |
| Saturn | 9.537 | 0.499 | 0.035 | 223 | +10.8 |
| Uranus | 19.19 | 0.488 | 0.0084 | 54 | +8.8 |
| Neptune | 30.07 | 0.442 | 0.0031 | 20 | +7.3 |

**Two independent cross-checks that this table is right:**
- Moon row → 5,540 cd/m². Derived independently from the magnitude system: full Moon
  `m = −12.74`, `E = 2.54e-6 × 10^(12.74/2.5) = 0.317 lux` (literature: 0.25–0.32 ✅),
  `Ω = π(1865″/2 / 206265)² = 6.42e-5 sr`, `L = E/Ω = 4,938 cd/m²`. **Agreement to 12%.**
- Earth row → 17,700 cd/m². A sunlit cloud top at noon measures 10,000–30,000 cd/m². ✅

**Colour** must be calibrated, not eyeballed (D09). Every colour texture in the repo is
brightness-normalised art; the fix is to rescale each texture so its *mean* matches the body's
geometric albedo above, preserving its variation. That single operation removes a 14.6× spread.

**Sub-pixel flux conservation.** A body below ~1 px must be splatted through a PSF that
conserves total flux, not rasterised as a shrinking quad (D06/D14). This also removes
`MIN_SCREEN_PX` and the flicker. Note the case that motivated this whole audit:

> Venus from Earth subtends 25″ = 0.125 px at 60° FOV / 1080 p — deep in the point regime.
> The full Moon subtends 1865″ = **9.3 px**, which sits *directly on* the
> `STELLAR_PX_THRESHOLD = 8` handoff. The Moon is rendered right at the seam where the
> brightness discontinuity is largest. That is why it looks wrong.

### 3.7 Glare as a point-spread function

Bloom currently carries all the "brighter than white" information and is mis-shaped for it:
`bloom(sceneTexture, 0.02, 0, 1)` — strength 0.02, **radius 0**, additive (D12). A Gaussian mip
chain at radius 0 cannot represent the glare of a 1e9 cd/m² point source.

**Locked: a Spencer et al. (1995) style PSF, energy-conserving.** Spencer's filter is
psychophysically derived from measured human-eye optics (corneal/lens/retinal scatter plus
diffraction on the lens's radial fibres — the ciliary corona) and its whole purpose is to
"substantially increase the *perceived* dynamic range" of an image containing light sources.
That is precisely the requirement.

Two decisions:
- **Eye, not camera.** The player is looking out of a cockpit, not through a lens. Commit to the
  eye PSF and drop lens-flare/anamorphic streaks, which would be a different and inconsistent
  conceit. (Aperture diffraction stays available for a photo mode.)
- **Energy-conserving composite**: `out = (1−k)·scene + k·PSF(scene)` rather than
  `scene + bloom`. The clipped sun then reads as blinding because its energy is *redistributed*
  into the glare, which is how the real percept works — instead of an additive fudge on top.

### 3.8 The night side

The night side is currently a texture and nothing else (D16). Everything below is real light
that exists and is absent. Under a working auto-exposure system, adding it is what turns the
dark side from "black" into "quiet" — this is where "realistic *and* awe-inspiring" is won.

| Source | cd/m² | game units | Notes |
|---|---|---|---|
| City lights (dense urban, from orbit) | ~1–10 | 1.6e-4 – 1.6e-3 | VIIRS DNB is the data source |
| Full-moon-lit ground | ~0.1 | 1.6e-5 | from 0.25 lux ÷ π × albedo |
| Aurora (IBC III) | ~1e-2 | 1.6e-6 | |
| Airglow | ~1e-4 | 1.6e-8 | the true night-sky floor |
| Zodiacal light / integrated starlight | ~1e-4 | 1.6e-8 | |

The terminator spans ~6 orders of magnitude between the sunlit and airglow ends, so it is also
the best available test of whether the exposure curve behaves.

### 3.9 Locked decision — model the eye, not a camera

The stated goal is *what the player's own eyes would see, flying through space*. That is more
than a tone curve: three properties of human vision are load-bearing, and all three are cheap.

**(a) Two-timescale adaptation.** Cone adaptation is fast (~0.2–2 s); rod adaptation is slow
(20–40 minutes for full dark adaptation). A single exponential cannot represent both, and 40
minutes is unplayable.

> **Deliberate deviation from physics, stated explicitly:** compress rod adaptation to ~4–8 s.
> Keep the *asymmetry* (dark-adaptation slower than light-adaptation, roughly 3:1), because that
> asymmetry is what the player actually feels — the wince coming into sunlight, the slow reveal
> of stars afterwards. Model as two exponentials blended by adapted luminance, not one.

**(b) Scotopic/mesopic vision — this is the big awe win, and it is nearly free.** Below about
0.03 cd/m² the rods dominate: **no colour**, a blue-shifted spectral response (the Purkinje
shift), and reduced acuity. Between ~0.03 and ~3 cd/m² vision is mesopic — partial colour. In
deep space, looking away from the sun, the eye is genuinely scotopic. This is why astronauts and
observers report the Milky Way as **grey**, not colourful, and why naked-eye nebulae have no hue.

Implementation is a lerp in the tonemap stage, driven by the adaptation luminance `L_a`:
```
s        = smoothstep(0.03, 3.0, L_a)          // 0 = scotopic, 1 = photopic
rodLum   = dot(colour, scotopicWeights)        // V′(λ) — blue-weighted vs photopic
colour   = mix(rodLum · purkinjeTint, colour, s)
```
Two constants and a mix. It makes deep space read as *night vision* — desaturated, blue-grey,
quiet — instead of an underexposed daylight image, and it is a genuine differentiator.

**(c) Veiling glare is what makes stars disappear, not the exposure curve.** Intraocular scatter
raises the retinal light floor whenever something bright is in view. This is the Spencer PSF of
§3.7, and it means the requirement *"stars brightly visible unless something really bright is in
the view"* is **produced by the physics rather than art-directed**. Nothing extra to build.

**⚠ One honest limitation.** The human eye adapts *locally*; a single global exposure cannot.
So you cannot have brightly-visible stars **and** a correctly-exposed sunlit Earth in the same
frame. The good news is that this is not a compromise — it is what actually happens: with a
sunlit planet filling your view your eye adapts to it and the stars genuinely vanish, which is
exactly why astronauts must shield their eyes and wait to see stars. **A single global exposure
plus veiling glare is the physically correct answer here**, and it satisfies the requirement as
stated. Do not add local/bilateral adaptation to "fix" it — that would be the unrealistic choice.

---

## 4. Migration strategy

### 4.1 The cancellation constraint (read before touching anything)

**D02 and D05 must be fixed in the same commit.** Earth's surfaces are 6.37× too dark; Venus is
32× too dark from the trim. Fix the surfaces alone and Venus becomes invisible relative to a
now-correct Earth. Remove the trim alone and Venus blows out again. The general rule:

> Any commit that changes one side of the albedo↔illuminance seam must change the other side,
> or add the compensating exposure, in the same commit.

This is why §5 leads with a *no-visual-change* refactor phase.

### 4.2 Validation harness — `__lum`

Modelled on the existing `__bench` (see [`PERF_MEASUREMENT.md`](PERF_MEASUREMENT.md)), which
proved that eye-balled before/after is worthless. Build the photometric equivalent **first**, in
Phase 0, so every later phase has a numeric acceptance test:

- `__lum.probe(x, y)` — reads back the pre-tonemap RGBA16F value at a pixel, in game units, and
  prints it alongside cd/m² and EV100.
- `__lum.sweep()` — warps to a fixed ladder of named views (`earth_subsolar`, `earth_terminator`,
  `earth_night_city`, `moon_full_from_earth`, `venus_from_earth`, `neptune_disc`, `sun_disc_1au`,
  `sun_disc_30au`, `deep_space_milkyway`) and prints measured vs **expected** luminance from the
  §3.6 table, with the ratio.
- `__lum.assert()` — fails any row outside a stated tolerance.

Acceptance for the whole project: **every row within ±25% of the §3.6 table.**

The harness must force **manual exposure** while sweeping, or auto-exposure makes every
measurement a function of the previous frame. Same lesson as `__bench`'s start-state protocol.

### 4.3 Interaction with `__bench`

⚠ Auto-exposure introduces frame-to-frame state, which will break `__bench` reproducibility
(currently ±0.4 ms) unless the bench pins exposure manually. Add that to `__bench`'s warp
protocol in the same phase that lands auto-exposure.

---

## 5. Phased plan

Each phase is independently shippable and has an explicit on-device check. Phases 0–2 are
ordered so the risky look-changing work happens only after the measurement tools exist.

| Phase | Content | Visual change | Risk |
|---|---|---|---|
| **0** ✅ | `__lum` harness; document the unit convention in code; **split `AtmosphereParams` static/dynamic so `sunIlluminance` is per-frame (§3.0)**; `uExposure` wired at 1.0 | **none** (no-op) | low |
| **1** ✅ | Manual exposure: compensation slider in Settings → Dev, flip defaults `toneMapping → true` (AgX) and `bloom → true` | AgX + bloom become the default look; exposure becomes tunable | low |
| **2a** ✅ | **The seam commit (atomic).** Surfaces × `sunIlluminance/π`; delete `VENUS_ILLUM_TRIM` **and** Earth's illuminance pin; delete the `illuminanceTrim` field itself | **large** — the solar system's relative brightness becomes correct | **high** |
| **2b** ✅ | Earth's sigmoid → true `N·L` (D08), **ground and cloud deck together** | day disc gains a real cosine falloff to the terminator | medium |
| **2c** | Albedo-authoritative texture calibration (§3.0, D09 + **D23**) | per-body 0.37×–5.4×; Earth's disc **0.146 → 0.434** is now **entirely** surface texture (§5.7). ⚠ D23 is per-REGION (ocean 21–43×, forest 4–6×, desert/ice correct) so **no single scalar works** | medium |
| **2d** ✅ | `CLOUD_SUN_SCALE` → `albedo/π` = 0.223 **+ `SHELL_OPTICAL_PATH` 1 → 60 (a units error, not a fit) + erosion-area factor 0.5** | cloud cover 3.5% → **21.9%** measured (user chose 0.5 over 0.3 for edge detail); see §5.7 | medium |
| **3a** ✅ | **Distance-correct sun for ship + asteroids** — `SunLight.intensity` and the bounce fill from live star distance via the SAME `sunIlluminanceAt` the planets use | ship/asteroids stop being lit by a constant: 4.7× brighter at Mercury, 1,280× dimmer at Neptune | medium |
| **3b** ✅ | `CORE_HDR` 4096 → **`SUN_DISC_RADIANCE_GAME` ≈ 265,000** (derived, distance-independent) + `HALF_FLOAT_WRITE_MAX` clamp + **sub-pixel flux conservation**; star radius and **blackbody T_eff colour** from the system description | the sun disc becomes physically bright; steady (not strobing) in the outer system | medium |
| **4** | Unified impostor radiance across all three LOD tiers; lunar-Lambert phase; delete `REFERENCE_HDR`/`JUPITER_REF_FLUX`/`fade`/the `500` clamp/`mars.ts:109`'s `12.0`; PSF splat for sub-pixel bodies | Moon, Venus and Mars finally read correctly | medium |
| **5** ✅ | **Auto-exposure / eye adaptation**: centre-weighted log-average metering, **PARTIAL** adaptation (Stevens' ⅓), asymmetric cone/rod time constants, + the **skybox rescaled to absolute luminance** (measured 189,000× hot) | the "eye" arrives; stars become visible in deep space and vanish when the sun enters frame | medium |
| **6** | **HDR display output + calibration screen; P3 path.** Validate on the M2 Pro XDR panel | HDR displays gain real headroom | low |
| **7** | Scotopic/mesopic vision model + Purkinje shift (§3.9b); fix the skybox's absolute luminance | deep space becomes night-vision quiet, not underexposed daylight | low |
| **8** | PSF glare replacing mip-chain bloom, energy-conserving, driven by the star-flux uniform | the sun becomes blinding; stars veil correctly | medium |
| **9** | Night-side stack: city lights at absolute luminance, moonlight, airglow, aurora | night side becomes quietly alive | low |

**Per-phase on-device checks** are the corresponding `__lum.sweep()` rows plus a look pass at:
ground / low orbit / high orbit / deep space / sunrise / night side / Neptune / looking at the sun.

### 5.1 Phase 0 — as built (2026-08-14)

New: [`space/photometry.ts`](../src/components/space/photometry.ts) (the convention, EV/exposure
helpers, `sunIlluminanceAt`, `uExposure`), [`data/bodyPhotometry.ts`](../src/data/bodyPhotometry.ts)
(reference albedos + lunar-Lambert k), [`space/perf/lumHarness.ts`](../src/components/space/perf/lumHarness.ts)
(`__lum`). Touched: `celestial/types.ts`, `bodies/atmosphereData.ts`, `space/atmospherePass.ts`,
`celestial/CelestialBody.tsx`, `bodies/earth.ts`, `bodies/earthClouds.ts`, `space/SpaceRenderer.tsx`,
`DevTools.tsx`.

**The exact calibration constant is 6,038, not 6,400.** Derived, not rounded:
`128,000 lux at 1 AU ÷ SUN_ILLUM_GAME_1AU (21.2) = 6,038`. The 6,400 quoted in §3.1/§3.6 was a
round figure; the cd/m² column of §3.6's table is therefore ~6% high. Immaterial against its own
±25% tolerance, and the Moon cross-check *improves* with the exact value (5,843 vs the
magnitude-derived 4,938 — 18% high, which is the right sign for sub-solar vs disc-average).

**The no-op is proven, not assumed.** All seven atmosphere bodies produce bit-identical
illuminance before and after (`===`, not "close"): Earth exactly 20, Venus 1.0157736376550237,
and Mars/Jupiter/Saturn/Uranus/Neptune unchanged to full precision. Earth's pin is expressed as
`illuminanceTrim = 20 / 22.4583 = 0.8905395790877341` rather than an absolute override, so the
derivation stays the single path.

**A second static bake was found and fixed.** Beyond D17, `earthClouds.ts:1738` baked
`EARTH_ATMOSPHERE.sunIlluminance` into the far cloud shell's shader as a **compile-time literal**.
Now a per-frame uniform fed from the atmosphere record via `earth.ts`'s `onFrame`
(`setAtmosphereBody` runs earlier in the same `CelestialBody` frame, so it is same-frame fresh).

**Deviation from the plan text, deliberate:** `uExposure` is applied **once in the post chain**,
not per-shader at the source. Mathematically identical while nothing overflows, and the brightest
thing in the scene today is `CORE_HDR = 4096`. Source pre-exposure becomes necessary in Phase 3
when `CORE_HDR` reaches its physical ~265,000. It is applied **before** bloom so bloom's
threshold keeps meaning "brighter than white", and deliberately **not** via
`renderer.toneMappingExposure` (three's `ToneMappingNode` defaults its exposure to a renderer
reference for that property, which would put exposure on the wrong side of the threshold and risk
double-counting).

**New defect found, D20:** [`luna.ts:151`](../src/components/celestial/bodies/luna.ts#L151) sets
`stellarPoint.geometricAlbedo = 0.0036`. The measured lunar geometric albedo is **0.136 — the
value in the engine is 38× too dim.** Almost certainly eyeballed down to stop the point glaring,
i.e. the same hand-patching pattern as Mars' `12.0`. Correct value is in `bodyPhotometry.ts`;
fix in Phase 4. Expect `__lum`'s `luna_disc` row to fail until then — that is the harness working.

### 5.3 Phase 1 — as built (2026-08-14)

Touched: `space/photometry.ts`, `store/store.ts`, `space/SpaceRenderer.tsx`,
`HUD/SettingsMenu/SettingsMenu.{tsx,scss}`.

**Exposure is split into two composing inputs, not one setter.** A single
"set the exposure" would be overwritten by Phase 5's histogram, and the manual knob
would have to be rebuilt:

```
effective = exposureFromEV(clamp(meteredEV, EV_MIN, EV_MAX)) · 2^compensation
```

`meteredEV` is the scene's reading — pinned at `EV_NEUTRAL` in Phases 0–4, written by the
histogram in Phase 5. `compensation` is the Dev slider, in **stops, + = brighter**, matching the
photographic convention and Unreal's `ExposureCompensation`. It survives into Phase 5 untouched.

`EV_NEUTRAL = evFromExposure(1) = −0.263` — the EV that reproduces the pre-lighting-work image.
Naming it makes explicit that today's look is an arbitrary point on the exposure axis, not a
calibrated one. **Verified: `stops = 0` yields exposure exactly `1.0` to full float precision, and
±N stops yield exactly 2^±N**, so the default is a strict no-op.

**Defaults flipped** (`store.ts`): `bloom: true`, `toneMapping: true`. The first-run GPU-tier pass
now only *steps down* — bloom off below tier 2 (a measured 1.8–2.0 ms mip chain). Tone mapping is
deliberately **not** stepped down: swapping AgX for Neutral is not a perf win (one curve evaluation
either way), it just picks a worse curve.

**⚠ `atomWithStorage` REPLACES the default object, it does not merge.** Anyone who opened Settings
before `exposureStops` existed has a stored object without it, so it reads `undefined` and the
slider's `.toFixed()` would throw. Guarded with `?? 0` at both read sites. Confirmed live: the dev
browser's stored value is
`{"invertPitch":false,"bloom":true,"toneMapping":true,"fps":false,"perf":false,"initial":false}` —
no `exposureStops`. Same hazard as the comms-store hydration trap.

**⚠ The default flip does NOT affect existing profiles**, for the same reason. Anyone with stored
settings keeps whatever they had; only fresh installs get the new defaults. Existing players who
want AgX must toggle it in Settings → Graphics, or clear the `settings` localStorage key.

### 5.4 Phase 2a — as built (2026-08-14)

**Phase 2 was SPLIT.** The original phase bundled five changes; only three were actually
inseparable (the surface factor + both trim removals — §4.1). Earth's sigmoid, the texture
calibration and the `CLOUD_SUN_SCALE` re-anchor each change the look on their own and each
deserves its own measurement, so they became 2b/2c/2d. Bundling them would have made an
unattributable diff — the same reasoning as `PERF_MEASUREMENT.md`'s one-lever-at-a-time rule.

**Every body now gets a per-frame `uSunIlluminance`**, created and written in
`CelestialBody.tsx` from the LIVE body→star distance and threaded through
`FragmentNodeContext` / `ExtraMeshContext`. Deliberately not routed via the atmosphere record:
airless moons need it just as much as Earth, and they never register as atmosphere bodies.
`STAR_LUMINOSITY_SUN` (new, `celestialConstants.ts`) is the marked seam for procedural systems.

**All 14 sphere fragments + Saturn's rings** now convert reflectance → radiance through one
shared helper, `surfaceRadiance(reflectance, uSunIlluminance)` in `photometry.ts`, so the `1/π`
lives in exactly one place. Billboard fragments were deliberately **not** touched — they are the
Phase 4 impostor work and have no illuminance in scope.

**Earth's emissive night lights are held out of the conversion.** `col` now accumulates
reflectance only; `nightEmissive` is added *after* the `× E/π`, because city lights do not get
brighter when Earth is nearer the sun. The split reproduces the old `mix()` exactly
(`mix(n,d,a) = n·(1−a) + d·a`), so the night side is unchanged. Giving city lights a real absolute
luminance is still §3.8's job.

**Both trims are gone, and so is the field.** `illuminanceTrim` was removed from
`AtmosphereParams` entirely rather than left pinned at 1 — a permanent-1 brightness knob is a trap
that §3.0 forbids. Verified zero remaining references.

**Expected deltas (derived, NOT yet measured on device):**

| Body | E before → after | surface factor | net |
|---|---|---|---|
| Mercury | 141 (unchanged) | × 141/π = **×44.9** | far brighter |
| Earth | 20 → 22.458 | × **×7.15** | ground ~7× brighter; sky +12%; cloud/ground ratio 35× → ~5× ✅ |
| Venus | 1.016 → 40.631 | ×12.93, but T≈0 so in-scatter dominates: **×40** | far brighter |
| Neptune | 0.0234 (unchanged) | × 0.0234/π = **×0.00746** | surface 134× dimmer |

⚠ **The solar system's dynamic range just went from ~flat to ~6,000:1, which is the point — and
it means ONE global exposure can no longer serve both Mercury and Neptune.** Expect to move the
Dev exposure slider when travelling between them. That is correct behaviour, not a regression, and
it is precisely the gap Phase 5's auto-exposure closes.

**Acceptance (run before starting 2b):** `__lum.compare()` on `earth`, `venus`, `neptune`,
`mars`, `jupiter`. Ratios should collapse from 12.9–16.5× toward ~1–2× (above 1 is expected —
sub-solar nadir exceeds the disc-averaged `p·E/π` for a limb-darkened body). **Venus is the one to
watch**: pre-change it sat 16.5× above its *trimmed* expectation, meaning much of its brightness
arrived through the albedo-scale path, so this pair of changes is not guaranteed to balance.

### 5.5 Phase 2b — as built (2026-08-16)

**The one-line version of D08:** Earth's day term was `1/(1+exp(−40·cosθ))`. That is ≥0.98 for
every `cosθ > 0.1`, so the lit hemisphere was a flat wall of light with a hard 6°-wide edge, not a
sphere curving into shadow.

**What made it more than a one-line fix** is that the single `dayAmount` variable was doing two
unrelated jobs. It multiplied the diffuse albedo (a *lighting* term, which wants `cosθ`) **and** it
gated the ocean specular, the fresnel, and the city-light mask (a *visibility* term, which does
not). Swapping the sigmoid for a cosine in place would have lit the cities through mid-morning —
`1 − cosθ` is 0.5 at 30° sun elevation. So the fix splits it:

| | drives | function |
|---|---|---|
| `nDotL` | diffuse albedo | soft Lambert cosine |
| `sunVis` | specular, fresnel, city-light mask, terminator band | the legacy sigmoid, unchanged |

Both are then attenuated by the shared occluders (lunar eclipse × ground cloud shadow).

**Specular deliberately keeps the visibility gate.** A glint does not fade as `cosθ`: in a
microfacet BRDF the `1/(4·cosθᵢ·cosθₒ)` denominator cancels the incident cosine outright and
Fresnel climbs toward grazing. That is *why* the sunset glint is the bright one, and gating it by
`cosθ` would have deleted the best thing on the water.

**The normal map went from multiplicative to additive.** It was `× (1 + 0.8·Δcos)` — a relative
delta, which is what you are forced into when the base term is a saturated sigmoid you cannot
re-evaluate at a new angle. On a real cosine it is just the additive blend it always meant:
`mix(cosGeom, cosMapped, 0.8) ≡ cosGeom + 0.8·Δcos`. Same strength, correct algebra.

**Soft terminator from the star's finite angular radius.** `max(N·L, 0)` has a slope
discontinuity at the terminator. The physical fix is free: the star is a disc of angular radius
`r = R★/d`, and the irradiance from a partly-risen disc is `≈(cosθ+r)²/(4r)`, which meets `cosθ`
continuously in *both value and slope* at `cosθ = r`. Written branch-free by clamping the argument
into the band and adding the linear part above it. At 1 AU `r = 0.00465`, a 0.53°-wide band — you
will never see it. **It is in for §3.0:** a close-orbiting red dwarf subtends degrees and gets a
correctly soft terminator with no per-system tuning. Verified numerically: identical to
`max(cosθ,0)` to machine precision outside the band, slope 1.000000 on both sides of the seam.

**`hemiAmount` was dead** — assigned, eclipse-scaled, never read. Deleted.

#### The cloud deck had the same defect, and fixing only the ground would have looked worse

`earthClouds.ts` carried a second copy of the identical `exp(−40·…)` sigmoid, and `farCloudLit`
had **no cosine at all** — the deck sat at full noon brightness to the terminator. That was
harmless only because the ground underneath it was equally flat-lit. Fixing the ground alone would
have painted a blazing white cloud band along the terminator. Measured:

| `cosθ` | cloud:ground, before | **ground fixed, deck left flat** | both fixed |
|---|---|---|---|
| 1.0 | 4.9× | 4.9× | 4.9× |
| 0.5 | 4.9× | 9.9× | 5.3× |
| 0.15 | 5.0× | **33.0×** | 6.7× |

A thick cloud deck is genuinely close to Lambert in `μ₀` near nadir, which is the licence to use
the same cosine: Chandrasekhar's conservative semi-infinite reflection
`R = H(μ)H(μ₀)/(4(μ+μ₀))` gives `L/F = 1.06 / 0.55 / 0.21` at `μ₀ = 1 / 0.5 / 0.2` — proportional
to `μ₀` within ~6%, because `H(μ₀)`'s growth cancels against the `(μ+μ₀)` denominator. So
`farCloudLit` gained a `sunCos` parameter scaling the direct term, and `daylight` went back to
being a pure night gate.

The deck's cosine is lifted by its own horizon: a sheet at altitude `h` still sees the sun until
`cosθ = −√(1−(R/(R+h))²)`, which is **0.066** at 14 km — the hand-picked `0.025` it replaces was
standing in for exactly this. Derived from the geometry, so any planet or deck altitude gets it
right for free. The lift also keeps the sunset-cloud glow, which is physically a *volume* being lit
from below its local horizontal rather than a sheet obeying a cosine.

**Only the far-field shell needed this.** The volumetric marcher computes per-voxel sun
transmittance along the slant path, so it already darkens a low sun through real extinction. The
shell is the analytic stand-in that had no such mechanism.

#### Predictions to check against

Derived before the change, so they are falsifiable:

- **`__lum.compare("earth")` must not move.** At the sub-solar point `cosθ = 1` and both the old
  sigmoid and the new cosine equal 1.000000. If the probe moves, something else broke.
- **The disc average drops by exactly 2/3 — 0.58 stops.** Numerically integrated over the lit
  disc at zero phase: 0.9990 → 0.6667, landing on the Lambert ideal. This is *not* a D09 fix and
  does not change what Phase 2c has to do; 2c's texture calibration is still open.
- Neither prediction can be confirmed by a centre probe alone. **The disc-average instrument
  (§2.2.9) is what closes this**, and it is a 2c blocker regardless.

#### D21 — the normal map cannot survive a real cosine (found by 2b, on device)

Phase 2b shipped and immediately produced **hard-edged squares near the terminator**, fixed to the
surface, all the same orientation, only a few of them. Worth recording the *diagnosis path*, because
I got it wrong twice before the user's bisection settled it:

| hypothesis | killed by |
|---|---|
| AP froxel (32×32 screen cells — shape fit perfectly) | froxel bake is skipped above 4,000 km; the shot was at 10,471 km |
| AP march step quantisation (`MAIN_STEPS = 16`, no dither — the code even *pre-registers* banding at "the limb, the terminator, the twilight sky") | `MAIN_STEPS = 64` and `AP_RES_SCALE = 1.0` both changed nothing |
| weather-map block compression | no `SHELL_DEBUG_VIZ` or `DEBUG_VIZ` mode showed it |
| bloom mip chain (`radius 0`, `threshold 1`) | toggling bloom and tone mapping changed nothing |

**The user's bisection found it in one step:** swapping `texNormal` for `texSpec` in
`buildEarthFragmentNode` makes it vanish. It is the normal map.

**Measured on the decoded source.** `earth_normal.ktx2` is 2048×1024 from a **58 KB** WebP —
0.028 bytes/px, against the 8K/1.5 MB albedo beside it, and the oldest asset in the set. The ocean,
which should be exactly `(128,128,255)` everywhere, holds **two distinct values per channel**
(R∈{126,128}, G∈{127,128}) in flat, hard-edged, axis-aligned patches. That is 1 LSB =
**1.00° of spurious tilt**.

1° is nothing at normal incidence. But a true Lambert cosine amplifies any tilt error by **1/cosθ**:

| cosθ | SZA | brightness error |
|---|---|---|
| 1.00 | 0° | ±1.4% |
| 0.20 | 78° | ±7% |
| 0.10 | 84° | ±14% |
| 0.05 | 87° | ±28% |

So D08's fix did not create this — it removed the thing that was hiding it. The old sigmoid pinned
the modulation at a constant ~1% across the entire disc.

**A quantisation deadzone was tried and rejected by measurement**, which is the part worth
remembering: 96% of Sahara and 95% of Himalaya texels *also* sit within 2 LSB. The map's
signal-to-quantisation ratio is **≈1 over almost its whole area** — there is nothing to threshold
against. This asset cannot drive grazing-incidence lighting at all.

**Shipped mitigation** (`NORMAL_MAP_STRENGTH` / `NORMAL_GRAZE_LO` / `_HI` in `earth.ts`): full
normal strength above 75° SZA, fading to the geometric normal by 87°. Noise now **peaks at ~6% and
falls to zero** instead of diverging. Relief still reads strongly at 75–85° SZA where 1/cosθ is
already a 4–10× amplifier. Defensible past the artifact — sub-texel relief self-shadows at grazing
incidence, so naive `N'·L` over-predicts contrast there regardless, and fading toward geometric is a
conservative stand-in for the masking term we do not compute.

**The real fix is the asset**, and this mitigation should be walked back (GRAZE_LO/HI → 0) when it
lands: a 16-bit normal map, or normals baked from elevation, at 8K to match the albedo. There is no
height/displacement source in the repo, so this needs an external asset.

**D21 has a second site: the sun glint.** The grazing fade above only covers the *diffuse* cosine.
`reflect(-sunDir, nMapped)` still fed the mapped normal into a `pow(·,40)` lobe, and the same
squares reappeared inside the ocean specular. A reflection doubles an angular error and that lobe is
steepest ~10° off-axis, so 1° of quantisation noise is plenty. Fixed by reflecting the GEOMETRIC
normal — which is independently correct: `earth_normal` is a LAND relief map whose ocean is a
uniform `(128,128,255)`, so it has no wave data to contribute and everything it adds over water is
noise. Real glint breakup needs an actual wave normal.
**Generalise: after fixing an amplifier, grep for every other consumer of the same input.** The
diffuse path was one of two.

#### D22/D23 — found while answering "why are the clouds so faint from orbit?"

Two measurements, both independent of Phase 2b:

- **D22, an outright energy violation.** The ocean's "Schlick Fresnel" is
  `0.02 + 2.0·(1−cosθ)^2.5`. Schlick is `F0 + (1−F0)·(1−cosθ)⁵` and is bounded by 1.0; this one
  **peaks at 2.02** and runs 7.4× hot at a 60° view angle (0.374 vs 0.051). The ocean was returning
  up to 202% of the light falling on it, as a blue wash that grows toward the limb — which is
  exactly the term that flattens the contrast clouds need to read against. Fixed to real Schlick.
- **D23, the day texture's dark end is crushed** (measured on the decoded asset, linearised from
  sRGB): deep Pacific luminance **0.0014** against a real 0.03–0.06, Amazon 0.031 vs 0.12–0.18 —
  but Sahara 0.315 vs 0.30–0.40 ✅ and Antarctic ice 0.853 vs 0.60–0.80 ≈✅. So the error is
  **non-uniform and per-region**, not a global gain. A single scalar cannot fix it, which is a
  direct constraint on how Phase 2c must work.

Note the two pull opposite ways on cloud contrast: D22 was inflating the ocean, D23 is deflating it.
Do not tune either by eye against the cloud look — measure cloud and clear-ocean radiance at the
same solar geometry and compare to the real ~8:1.

**LESSON, and it is the session's recurring one in a new costume:** correct physics is an amplifier.
`N·L` multiplies input error by 1/cosθ, so a fix that is right in isolation can expose an asset that
was only ever adequate because the wrong code was numerically forgiving. When a physical correction
lands and something ugly appears, suspect the inputs it newly stresses — not just the change.

### 5.6 D24 — every planet was rendering mirrored, and why nobody could see it

Noticed only once Phase 2b's darker terminator and the Fresnel fix stopped the clouds from
obscuring the ground. Spain rendered east of Turkey; Sicily on the wrong side of Italy's toe.

**The chain, each link verified:**

1. `toktx` defaults to upper-left → (s0,t0) and stamps **`KTXorientation: rd`** (right, DOWN).
   Confirmed with `ktxinfo` on all of them — day, night, clouds, normal, specular, ERA5. Row 0 of
   the stored data is the TOP of the image (north).
2. three's `KTX2Loader` **never reads that metadata** — grep it for `orientation` or `flipY`, both
   come back empty. And a compressed texture cannot be flipped at upload the way `flipY` flips an
   uncompressed one.
3. `SphereGeometry` emits `uvs.push(u, 1 - v)`, so **`uv.y = 1` at the north pole**.
4. ⇒ The north pole sampled t=1 = the last row = **Antarctica**. Every planet texture upside down.

**Why it presented as an east-west mirror rather than an upside-down globe** — this is the part
that hid it. Inverting v maps latitude λ → −λ: a reflection through the equatorial plane,
determinant −1, so the rendered globe is its own mirror image. Nothing else in the scene defines
which geometric pole is north (each body's rotation Euler is arbitrary), so the flip has no way to
present as "upside down". It can only present as **chirality**.

**This is also why analysing `u` kept exonerating the code.** Differentiating three's own formula,
`dP/du = (+2πr, 0, 0)` at the point facing the camera — east really does go to screen right. The
mirror was never in `u`, and two rounds of checking `u` could never have found it. When something
is mirrored and the obvious axis checks out, **check the other axis for a chirality flip** before
re-checking the first.

**Fix:** `flipGeometryV()` in `CelestialBody.tsx` (before `computeTangents` — tangents derive from
uv) and the matching `.negate()` removal in `cloudCommon.ts`'s `equirectDirToUv`. Both must move
together: ground and cloud were mirrored *in lockstep*, which kept them registered to each other
and removed the one cue that would have exposed this years earlier.

The root-cause alternative is `toktx --lower_left_maps_to_s0t0` (→ orientation `ru`) in
`scripts/convert-to-ktx2.sh` plus a full re-convert; it costs no runtime work but re-encodes every
texture in the repo. If that is ever done, **both** flips must be removed.

⚠ NOT covered: Saturn's rings build their own `BufferGeometry` with a radial UV convention, so they
are untouched by this and want a separate look.

### 5.7 Phase 2d + the cloud-cover hunt — as built (2026-08-17)

Earth rendered a **5.5× too dark disc** (implied geometric albedo 0.0788 vs 0.434) with visibly too
few clouds against the Apollo 8 and Artemis II photographs. `__lum.disc()` localised it: 75% of the
disc sat at clear-sky reflectance, the median pixel was 4% cloud where Earth's is ~65%.

**Shipped values, and which are derived:**

| constant | from | to | basis |
|---|---|---|---|
| `SHELL_OPTICAL_PATH` | 1 | **60** | **derived** — `τ = density × extinction × slab`; a 14 km deck at density 0.25 with extinction 10–50 /km is τ ≈ 35–175 |
| `CLOUD_SUN_SCALE` | 0.45 | **0.223** | **derived** — `albedo/π` |
| `uErosionScale` | — | **0.3** | **empirical** — the only one; kept out of `EROSION_K_ST/CU` so their Nubis provenance survives |

Measured result: effective cloud cover **3.5% → 25.6%**, disc albedo **0.0788 → 0.163**, cloud-top
reflectance 0.479 (under the ~0.70 physical ceiling, no overshoot), clear sky untouched, and the
250–700 km handoff verified good on device at every step.

**The root cause was a units error, not a tuning miss.** `SHELL_OPTICAL_PATH` multiplied a
*normalised density* to produce what the Beer term treats as an *optical depth*. At 1, a fully dense
column capped at `1−e⁻¹` = 0.632 and a median one reached ~0.05. The old comment recorded it as
"EMPIRICAL: 1 gives the seamless orbit→surface transition… tune ~1–5", having rejected 18 as too
dense — so the wrong value was locked in by matching a marcher that was wrong the same way.

**Two knobs that compound must be swept jointly.** `SHELL_OPTICAL_PATH` and the erosion K each read
as a null result alone (20× of PATH moved albedo 0.0788 → 0.1212 with the median pixel's cloud
fraction pinned at 4–5%; 3.3× of K moved it 0.0788 → 0.0863 with **p98 frozen**, which was the tell
that the other gate was binding). Jointly, (0.3, 8) gave 1.75× where the product of the two singles
predicted 1.39×. This is the same structure as `profile × inScatter` in CLOUD_DEBUGGING_LESSONS case
#25 — cited during this hunt and then still tested one knob at a time.

**Metrics that misled, and what replaced them:**

- **Disc albedo against 0.434 was the wrong acceptance target.** Even with perfect cloud area the
  disc reaches only `0.65·0.42 + 0.35·0.044 = 0.288`, because D23 leaves clear sky at 0.044 against
  a real ~0.12. **The cloud finish line is ~0.29; the last 1.5× is Phase 2c.**
- **`p98/p02` contrast is not usable while D23 is open** — our clear-sky floor is 1.8× too dark, so
  the correct target is **11.4×, not 8.7×**. The measured 10.8× is right, not an overshoot.
- **Use effective cloud cover** = `(mean_R − clear_R)/(fullCloud_R − clear_R)`. Normalised by both
  endpoints, so D23 cancels.

**Still open: ~2.5× of cloud area** (25.6% vs ~65%). Four successive analytic models of the opacity
LUT's internals were each wrong in a new way — the last assumed `carved` was independent of
`dimProfile` when it is computed *from* it, which invalidated a distribution back-out and predicted
a step change at K=0.2 that measured as +2.1pp. **That residual needs the LUT's internals
instrumented (`dilated`/`carved`/`eroded` distributions), not more knob sweeps.**

⚠ Ruled out along the way, so nobody re-treads it: the weather map is NOT short of cloud (73% of the
globe above 0.05, 64% above 0.10, against Earth's ~67% — its *values* are low because it is
reflectance-encoded, and every transfer that lifts its mean to 0.567 saturates 25–44% of the globe
to flat white); and `maxProfile` ≈ 1, so the profile is not attenuating anything.

### 5.8 Phase 3 — as built (2026-08-17)

**3a — D03, the last structural 1/r² error.** `SunLight.tsx` carried a hardcoded `intensity = 30`.
Every planet had scaled correctly since 2a, so the ship — the one object on screen in every frame —
was the only thing lit by a constant: **0.21× at Mercury, 1,280× at Neptune, a 6,037× span** that
matches the audit's D03 figure exactly. Now `sunIlluminanceAt(distKm, STAR_LUMINOSITY_SUN)`, the
same helper the surfaces and atmosphere pass use, so ship and bodies cannot drift and generated
systems need no tuning.

⚠ The flat `<ambientLight intensity={0.5}/>` **had to move with it** — against Neptune's 0.0234 sun a
fixed fill is 21× brighter than the star, i.e. a flat grey cut-out ship in the outer system. It is
now `illuminance × 1/60`, and `SunLight` owns both lights so they cannot desync. **1/60 preserves the
shipped 30 : 0.5 key:fill ratio exactly**, so the only change at 1 AU is a uniform 1.42× dim
(30 → 21.2, the convention's own value) that the exposure stage absorbs — the ship's modelling is
untouched, only its absolute level corrected. *Reusable: when fixing an absolute scale, pick the
companion constant to preserve the existing ratio, and the visible change becomes one global factor
instead of a re-tune.*

**3b — the star's surface.** `CORE_HDR = 4096` → `SUN_DISC_RADIANCE_GAME ≈ 265,000`, derived from the
photosphere's 1.6e9 cd/m² and **distance-independent** (a surface's radiance does not fall off with
range; only its solid angle does). Three things had to come with it:

- **`HALF_FLOAT_WRITE_MAX = 60,000` clamp on the write.** 265,000 exceeds RGBA16F's 65,504, and an
  `Inf` in that buffer becomes NaN through every filter downstream — bloom's mip chain, TAA, the
  half-res AP upsample — where one texel poisons a neighbourhood. The clipping is invisible (any
  exposure showing 60,000 as other than flat white shows 265,000 the same), but it means **nothing
  may infer the star's flux from the buffer** — Phase 8's glare must read the constant.
- **Sub-pixel flux conservation.** `uCoreRatio` keeps the disc at its true angular size at all
  ranges, so it genuinely goes sub-pixel outward (Neptune: 0.38 px). At 265,000 that strobes — one
  fragment sample decides between a 265,000 core and nothing, which is precisely the instability the
  old `4096` comment settled for. Below a 2.5 px floor the core is drawn at the floor with radiance
  divided by the area ratio; verified exact (30 AU: true px² 0.1468 = rendered px²×scale 0.1468).
  Same trick `StellarPoint` already used.
- **Blackbody colour.** `vec3(1, 0.95, 0.9)` only ever described a G2V star. Now Planck integrated
  against CIE 1931 CMFs (Wyman/Sloan/Shirley analytic fits) → linear sRGB, **luminance-normalised so
  it carries hue only** and the magnitude stays `SUN_DISC_RADIANCE_GAME`'s job. Sol's 5772 K lands at
  (1.110, 0.976, 0.912), within a few percent of the hand-picked value — and a 3500 K M-dwarf now
  renders orange, a 20,000 K B-star blue, with no per-system work. `tempK` added to the system
  description alongside `luminositySun`; `STAR_RADIUS_KM` replaces a duplicated 696,340 literal.

**D18 — the illuminant's colour, closed in the same phase (and only because the user asked).** I
marked Phase 3 done with `tempK` wired to the star's DISC only. The three sites that actually cast
sunlight were all still grey: `atmospherePass`'s `rec.sunIlluminance` (sky + clouds),
`CelestialBody`'s `uSunIlluminance` (every planet surface) and `SunLight`'s hardcoded `"white"`
(ship + asteroids). So the star rendered at its blackbody colour while everything it lit was D65 —
the two disagreed, and the atmosphere site's own comment had already flagged it as "becomes a
per-channel tint in Phase 3 — defect D18".

All three now multiply `STAR_COLOR_LINEAR`, one definition in photometry.ts.
**Luminance-normalised is the load-bearing property**: 21.2 game units stays 21.2 after tinting, so
§3.1's calibration is untouched and only the hue moves. Sol is a ±10% warm nudge; a 3500 K M-dwarf is
(1.553, 0.896, 0.405), which is why grey was untenable for §3.0.

⚠ Known tension, resolved deliberately: the body textures are photographs, i.e. closer to
"reflectance already white-balanced under daylight" than to raw spectral reflectance, so a physical
illuminant arguably double-counts the sun's warmth. The choice is to keep the ILLUMINANT physical and
leave viewer chromatic adaptation to the eye model (Phase 7), where the real eye does it. Do not grey
this out to remove a warm cast.

Resulting disc: 265,000 radiance while resolved (Mercury 29.8 px, Earth 11.5 px), falling to 6,224
at Neptune's 0.38 px and 563 at 100 AU — so apparent brightness now drops through **solid angle**,
which is the physics, rather than through a fudged radiance.

### 5.9 Phase 5 — auto-exposure, as built (2026-08-17)

#### Why not Unreal's histogram

The AAA baseline (UE5, Frostbite, REDengine) builds a GPU histogram of log-luminance, averages a
percentile band (UE defaults 80–98.3%), clamps to min/max EV, then follows with asymmetric speeds and
an artist-authored exposure-compensation curve. Forza is the other school — a real camera model
(aperture/shutter/ISO) with a filmic curve, explicitly a CAMERA, which §8 rejected for this game.

### The estimator took FOUR attempts, and the fourth is the one with a principle

| attempt | failed how (all MEASURED on device) |
|---|---|
| 1. weighted log-average of the frame | **21 stops low.** Earth centred metered −17.68 vs a disc at EV 3 → 1057× exposure → white screen. Log-averages are robust to a bright *minority* and catastrophically not to a dark *majority*. |
| 2. Unreal's percentile band p90–p98 | Fixed big subjects, broke small ones. On the sun, p90 = −23.6 (void) and p98 = −0.9 (sun): the band straddled two populations 23 stops apart. **A percentile of PIXELS conflates "how bright" with "how much of the frame".** |
| 3. void rejection + log-average | **Still inverted.** Earth metered 0.85 (exposure 0.297); turning to the SUN metered −1.81 (exposure **1.404**). Turning toward the brightest object in the solar system *raised* exposure. |
| 4. ✅ **weighted mean of LINEAR radiance** | Sun now meters 1.4 stops brighter than Earth. Direction correct. |

**The mistake common to the first three was the domain, and it was avoidable from the start.**
Log space is right for TONE MAPPING and wrong for ADAPTATION. Retinal illuminance is a *linear*
integral of the field — the eye adapts to total flux arriving, not to a log-average of it. §8 asked
for an eye rather than a camera, and log/percentile metering is exactly where *cameras* come from: a
camera wants a chosen SUBJECT correctly exposed, so it must discount the rest of the frame. An eye
cannot discount anything.

A linear mean needs no void rejection and no percentile band, because **the void contributes ~0 to a
linear sum by construction** — that is precisely the property attempts 2 and 3 were trying to fake.

⚠ **A flux mean is only as good as the emissives.** It responds to whatever is genuinely bright, so an
uncalibrated emissive now moves exposure. MEASURED: at Neptune the ship's exhaust glow (≈1.13 game
units ≈ 6,800 cd/m², ~1% of frame) carries **13× the flux of Neptune's entire 92%-of-frame disc**,
pulling the meter 1.7 stops bright. That is the meter reading a wrong input correctly — the same shape
as D21/D23, where a physical correction exposed an asset that was only ever adequate because the
previous code was forgiving. `__lum.exposure()` now reports **`top 1% flux share`** for exactly this:
a physical scene sits low, and >~50% means one small hot feature is driving adaptation.

### Phase 5 follow-ups from on-device tuning

**`EXPOSURE_BIAS_STOPS = 2.5`, and it decomposes.** 0.79 stops are derived: the photographic constant
places the metered luminance at 1/9.6 = 0.104 display-linear, but tone curves including AgX are built
around middle grey ≈ 0.18, and log2(0.18/0.104) = 0.79. The remaining ~1.7 are authored — the user
judged the physically-neutral result "a bit dark" *consistently across unrelated scenes* (Earth from
the belt AND looking at the sun), and a consistent offset is a calibration constant rather than a
per-scene tweak. It is the ONE artistic number in `exposureMeter.ts`. ⚠ It must never be used to mask
a metering error: a scene wrong in only one view is a bug, and only a consistent offset belongs here.

**The ship's hull emissive was 6,700 cd/m².** The GLB bakes lit-panel emissive at `emissiveIntensity 1`
= 1.11 game units — as bright as a sunlit cloud top, on a small part, always on regardless of throttle
(the plume is the separate `<EngineExhaust>`). Invisible while exposure was manual; load-bearing the
moment Phase 5 metered a LINEAR flux mean, where ~1% of frame carried **13× the flux of Neptune's
entire 92%-of-frame disc** and dragged adaptation 1.7 stops bright. Fixed at the source rather than
worked around in the meter: `HULL_EMISSIVE_INTENSITY = 0.03` ≈ 200 cd/m², a plausible lit panel. Flux
share vs Neptune's disc goes 13× → **0.38×**. Cloned rather than mutated, since `useGLTF` caches
materials per URL. **No Blender edit needed.**

**Player-facing brightness slider** added to Settings → Graphics, riding on `exposureStops` — the
compensation term, which composes with the metered EV instead of replacing it, exactly as Unreal's
ExposureCompensation does. So the eye still adapts and the player only shifts where it settles, which
is the right control to expose given display peak luminance is not detectable (§3.5).

### ⛔ D25 — the diffuse sky UNDERFLOWS half-float, and it is the same defect as the sun overflowing it

`await __lum.probe()` on empty sky returns **`units: [0,0,0]`, `luma: 0`**. Not dim — exactly zero. The
cause is numerical, not a lost multiply:

| | value |
|---|---|
| RGBA16F smallest subnormal (2⁻²⁴) | **5.96e-8** — below this stores as exactly 0 |
| sky p50 / p75 / p90 (correctly calibrated) | 9.6e-9 / 1.7e-8 / 2.8e-8 → **all underflow** |
| sky p99 | 7.3e-8 → survives |
| brightest star | 5.1e-6 → survives |

So the panorama's stars store fine and its nebulosity flushes to zero — which is exactly what the
render shows and exactly what the probe reports.

**This is Phase 3b's problem at the other end.** There the sun disc (265,000) exceeded half-float's
65,504 ceiling and needed a write clamp. Here the sky falls under its floor. The buffer offers ~40
stops; the scene spans **44.6**. No fixed calibration can seat both ends at once.

⚠ **Do NOT "fix" this by raising `SKY_TARGET_NITS`** — that recreates the original 189,000× error and
turns deep space grey. **The fix is source pre-exposure (§3.2):** multiply radiance by the adapted
exposure at write time and divide it out in the post chain. It works precisely *because* exposure
tracks the scene — in a dark frame the sky is scaled up and the sun is not present; with the sun in
frame exposure is ~0.05 and 265,000 × 0.05 = 13,250 sits comfortably inside range. The seams to touch
already exist and are centralised (`surfaceRadiance`, `farCloudLit`, the atmosphere output, `Star.tsx`,
the skybox, and `SunLight`'s two intensities), plus one division in the post chain.

### ⛔ D26 — the player's own ship owns adaptation in dark scenes

MEASURED with `HULL_EMISSIVE_INTENSITY = 0.03` (≈60 cd/m² peak) in a deep-space frame: the hull carried
**99% of the metered flux** and stars vanished. At 0 the same frame meters −17 instead of −11.98.

The meter is not wrong — physically your own lit hull *is* the brightest thing in interstellar space,
so an eye would adapt to it and lose the sky. This is the **third-person camera problem** every game
with a visible player vehicle hits, and the standard answer is to exclude or damp the player vehicle in
metering rather than to dim the ship. Set to 0 as an interim; restore a physical value once the meter
can discount the local scene. ⚠ Metering `rt` (pre-local) is not a shortcut — the atmosphere and clouds
composite into `rtB`, so that would drop the sky near a planet.

### ✅ D27 — the bounce fill was never occluded (CLOSED 2026-08-18)

**⛔ My first diagnosis of this was wrong and the correction is the interesting part.** I wrote that
"`SunLight` only attenuates via `getAtmosphereLighting().sunTransmittance`, which is atmospheric
extinction, not a geometric eclipse test." That is false: `computeAtmosphereLighting` **already**
hard-zeroes `sunTransmittance` when the camera→sun ray hits the ground (see the `tGround` branch and
the `SUN_EMERGE_BAND` comment). The key light was correctly black inside Neptune's umbra the whole
time.

**What was actually lit was the FILL.** `fillRef.current.intensity = illuminance *
BOUNCE_FILL_FRACTION` never saw the transmittance, so an un-occluded ambient kept delivering
illuminance/60 from every direction. The arithmetic closes to three digits:

```
Neptune at 30.081 AU  → illuminance   21.2 / 30.081²      = 2.343e-2 game units
bounce fill           → 2.343e-2 / 60                     = 3.905e-4 game units
hull radiance         → 3.905e-4 × albedo / π
                        at albedo 0.333                   = 4.14e-5 game units
                                                          = 0.250 cd/m²   ← measured peak: 0.25
```

An implied hull albedo of exactly 0.333 for a grey hull is not a coincidence. **Lesson: when a defect
is "X is not attenuated", check every consumer of X, not the one you expect.** The key light was the
obvious suspect and it was innocent; the fill had no occlusion code at all, which is why grepping for
a *wrong* attenuation found nothing.

Physically the fill stands for sunlight bouncing off the hull onto itself, so it is a *function of*
the direct sun and must vanish with it. It now does. The one term that genuinely survives an umbra is
zodiacal light (~1e-4 cd/m²) — three decades below the self-bounce this fraction was fitted to, and
under the D25 half-float floor anyway, so it is not worth a constant.

#### Three real gaps, closed by [`space/sunOcclusion.ts`](../src/components/space/sunOcclusion.ts)

The atmosphere path occludes exactly ONE body — the nearest one that registered an atmosphere — which
leaves:

| # | gap | evidence |
|---|-----|----------|
| 1 | Bodies with no `config.atmosphere` (Luna, Mercury, Io, Europa, Ganymede, Callisto) never register, so they cast **no shadow at all** | in Luna's umbra: `transmittance 1,1,1`, dominant = earth |
| 2 | Only the NEAREST atmosphere body is dominant, so a second body in the same neighbourhood cannot eclipse | — |
| 3 | Registration is gated on the sphere LOD (`distKm < config.lod.far`). **Neptune's gate is 12 M km; its umbra is 165 M km** | at 19.7 M km down-sun: `dominant (none)`, `transmittance 1,1,1` |

The new module is a registry every `CelestialBody` writes to **unconditionally** (gating it is
precisely bug 3) plus one CPU visibility test per frame. The penumbra is the exact analytic
circle-circle overlap of the star's disc and the occluder's — not a binary test, because the star is
0.267° wide at 1 AU and a binary test would snap the hull from full sun to black in one frame.

**DIVISION OF LABOUR — exactly one owner per body.** `sunVisibility()` takes a `skipId` and `SunLight`
passes the dominant body's id, so the dominant body's shadow stays with the atmosphere path (which
does it *better* — it reddens through the limb) and every other body is handled geometrically.
Applying both would multiply two different soft ramps together and narrow the penumbra, and would put
this ramp in a fight with the emergence band that was tuned to fix the orange flash on shadow exit.

#### Validation

Geometry checked against known astronomy before touching the scene, by `eval`-ing the shipped
`discCoveredFraction` out of the source file:

| case | expected | measured |
|------|----------|----------|
| Moon at perigee (356,500 km) vs Sun | total, 100% | **100.00%** |
| Moon at apogee (406,700 km) vs Sun | annular, r² = (0.2448/0.2666)² = 84.3% | **84.31%** |
| Neptune umbra length | `R·d/(R☆−R)` = 165 M km | visibility 0% to 165 M km, **30.9% at 200 M** |
| penumbra ramp | smooth, 50% at the geometric midpoint | 50.0% at sep = angOcc exactly |

Penumbra widths come out right too: 25 km at Neptune (the sun is nearly a point at 30 AU) against
5,900 km far down-sun of Earth.

In-scene, via the new `__lum.eclipse(bodyId)` / `__lum.sun()`:

| pose | disc visible | transmittance | dominant | key | fill |
|------|-------------|---------------|----------|-----|------|
| Earth day side (baseline) | 100% | 1,1,1 | earth | 22.46 | 0.374 |
| Luna's umbra, 4 R behind | **0%** (luna, ang 14.478°) | 1,1,1 | earth | 0 | **0** |
| Neptune, 19.7 M km down-sun | **0%** (neptune, ang 0.072°) | 1,1,1 | **(none)** | 0 | **0** |
| Earth's umbra, 3 R behind | 100% (**earth skipped**) | **0,0,0** | earth | 0 | **0** |

The last two rows are the ones that matter. Neptune proves gap 3 (nothing else attenuates there — the
old code left the hull in full sun); Earth proves the skip, with the shadow owned by transmittance and
the geometric test reporting 100% so nothing is double-counted. Luna's `ang 14.478°` is
`asin(1737.4/6948)` to five digits.

⚠ **A ship in an umbra now goes very nearly black, and that is correct.** An eclipsed spacecraft is
lit only by starlight and by the planet's sunlit crescent. PLANETSHINE is the missing term that lights
a hull at crescent phases, and it is fully derivable — `E = (2/3)·A·E☉·(R/d)²·Φ(α)`, validated against
earthshine on the Moon (predicts 7.0 lux at full Earth against ~8 cited) — but it is Phase 4 IBL work,
not this fix. Note it does **not** rescue the umbra: at α ≈ 180° the phase function Φ → 0.

⚠ **sol.json places every body on one axis**, so from behind Neptune every inner planet also transits
the star (measured: Uranus 1.0%, Saturn 1.5%, both matching r² for their angular radii). Harmless — a
0.06-stop dip — and it disappears once bodies orbit. But do not read it as a bug in the registry.

### Two more corrections found by the same measurements

**⛔ My own luma clamp was above the sky.** The floor was 1e-8 game units; the rescaled skybox is
9.6e-9 — so the clamp flattened the entire void to one value, and the reported distribution read
p05 = p50 = p90 = p98 = −23.56. That destroyed exactly the star/sky contrast the metering needed to
see. Now 1e-11 (6e-8 cd/m², three decades below scotopic threshold).

**`EV_MIN` −16 → −18.** It was derived as "a mag-6 star renders at middle grey", but the panorama's
texels are dimmer than the magnitudes they stand for, so at −16 only the brightest few hundred stars
showed (measured: brightest sampled texel rendered 0.051). −18 gives 4× more headroom → 0.20. It only
ever binds in near-total darkness.

**⛔ `ADAPTATION_K = 0.67` was Stevens misapplied.** Stevens' ⅓ exponent describes brightness matching
**within** a fixed adaptation state, not **across** adaptation — and across a large excursion the eye
adapts far more completely than ⅓. Consequence, measured: Neptune's day side rendered 3.8 stops below
middle grey (0.0065 linear — "barely visible", and it was). **Now 0.85**, leaving 44 × 0.15 ≈ 6.6
stops of the world's range visible, still far from the k = 1 that would render deep space and sunlit
Mercury identically.

⚠ For the record, one thing that *is* working as intended and looked wrong: turning from dark space
toward Earth shows Earth bright, then dimming. That is correct dark-adapted behaviour — a bright
object is initially dazzling and settles as adaptation catches up. `TAU_BRIGHTEN` is only 0.25 s, so
the settle is fast by design.

#### Why FULL adaptation would have undone Phases 0–3

Terrestrial games span 15–20 stops. **We measured 44.6** (deep space −23.6 → sun disc +21.0, game-unit
EV). If exposure always maps the metered value to middle grey, deep space and sunlit Mercury render
*equally bright* — the entire photometric effort would be thrown away in the last pass. This is the
one decision that mattered.

The amount is not taste. **Stevens' power law** puts perceived brightness ∝ L^≈0.33, so a 44-stop
luminance range should present as ≈15 stops of perceived range, not 0:
`adaptedEV = anchor + k·(metered − anchor)` with **k = 0.67**. That is what Unreal's compensation curve
is hand-authored to accomplish; deriving it means it also holds for generated systems untuned (§3.0).

Validated end to end before shipping:

| scene | metered | target | stars render at | cloud tops | sun disc |
|---|---|---|---|---|---|
| deep space | −23.6 | −14.3 | **0.086** ✅ visible | — | — |
| Earth high orbit | 3.06 | 3.59 | ~0 | 0.220 | — |
| sunlit ground | 4.66 | 4.66 | ~0 | **0.104** = 1/9.6, middle grey ✅ | — |
| sun 20% of frame | 18.7 | 14.1 | **2.5e-10** gone ✅ | 0.0002 | 12.9 blown ✅ |

The last two rows are §8's requirement verbatim — "stars brightly visible unless something really
bright, like the sun, is in the view" — arrived at by physics rather than art direction.

#### ⚠ The unit trap, caught by checking

**Every EV in `exposureMeter.ts` is a GAME-UNIT EV**, `log2(gameUnits × 8)` — *not* the cd/m² EV that
`evFromGameUnits` and the `__lum` probe tables print. They differ by log2(6038) ≈ 12.6 stops, so
confusing them is a 6,038× exposure error. The tell that settles it: `exposureFromEV` feeds
`uExposure`, which multiplies the scene in game units, and `EV_MIN = −16` works out to 1.15e-2 cd/m²
— a mag-6 star's per-pixel equivalent, exactly how §8 derived it. My first draft used cd/m² anchors
(17.0 instead of 4.665) and would have been 12.6 stops off.

#### Eye, not camera: asymmetric two-timescale

Adapting to BRIGHTER is fast and protective — τ 0.25 s, the squint response that stops a glance at the
sun from blinding you. Adapting to DARKER is slow and slower the darker it gets: τ 2 s photopic
(cones) ramping to 6 s below the mesopic boundary (rods, really 20–40 minutes, compressed per §8).
Looking away from a planet into deep space therefore gives a gradual star reveal rather than an
instant one.

Also: **centre-weighted metering** (power 2, 5% edge floor), because the eye's adaptation is strongly
foveal and because without it, flying toward a planet against a mostly-empty starfield meters the
empty part and blows the planet out — the subject-versus-sky failure, which here is the common case.

#### The skybox rescale

`MilkyWaySkybox` had `map: tex` and nothing else, so the texture's sRGB-decoded value WAS the radiance:
a whole-sky mean of 0.0031 game units = **19 cd/m²** against a real interplanetary ~1e-4. That is
189,000× hot and sat ~1,600× above a mag-6 star, so **no exposure could ever have shown stars** — which
is why this was promoted out of Phase 7. The scale is derived (target ÷ the texture's own
solid-angle-weighted mean linear luminance, measured 0.003137 — the sin θ weight matters), and it
cross-checks against the independent in-engine probe of 17.3 cd/m².

✅ **Stars survive it**, measured at mip 1: median sky 5.8e-5 cd/m², p99.9 1.5e-3, brightest texel
3.1e-2 — a 530× contrast, brightest stars near naked-eye mag 4–5. An earlier read off mip 4 suggested
they would vanish; that was mip-averaging of point sources. **Measure point features at full res.**

⚠ Not addressed: the skybox mesh uses `geo.scale(-1,1,1)` to face inward, which mirrors the panorama —
the same chirality class as D24, but far harder to notice on a starfield. And `StarsComponent.tsx`
exists but is not mounted anywhere, so the panorama is the only star source.

### 5.2 The readback bug — two traps in `readRenderTargetPixelsAsync`

`__lum` shipped broken and its first live run caught it, which is the harness doing its job. The
tell was a probe of dark space returning **exactly 6272 in all three channels**: a uniform integer
is never a rendered radiance. Both faults are properties of reading a `HalfFloatType` target:

1. **It returns raw binary16 BITS, not floats.** `rgba16float` maps to `Uint16Array` in
   `WebGPUTextureUtils._getTypedArrayType` and three does no decoding.
   `6272 = 0x1880 = 2^(6−15)·1.125 = 0.002197`. Reading bits as numbers inflated everything by
   10³–10⁶ and made every cd/m² and EV figure meaningless.
2. **Rows are padded to a 256-byte stride** (`bytesPerRow = ceil(width·8 / 256)·256`), so a
   multi-pixel read's row pitch is *not* `width·4` elements — a 9-wide read is padded from 72 to
   256 bytes. Indexing linearly walks into padding.

Fixed with an explicit `halfToFloat` + stride-aware indexing, plus **`__lum.selftest()`** which
checks the decoder against eight known bit patterns (including the two from this run) and the
stride against the 256-byte rule. Run it whenever a number looks absurd.

**Lesson, and it is the same one as `docs/PERF_MEASUREMENT.md`'s:** a measurement harness needs its
own ground truth before its output is worth anything. Here the falsifier was free — a physically
impossible reading (uniform integer, dark space at 13 million cd/m²) — and it was available on the
very first probe. Sanity-check a new instrument against a value you already know before you
believe anything it says about a value you don't.

**Why this order:**

- Phase 2 is the one that can leave the game looking broken, which is why Phase 0's harness and
  Phase 1's exposure slider land first — with a manual EV control, Phase 2's output can be
  re-centred by hand in seconds instead of by re-tuning 50 constants.
- **Phase 0's `AtmosphereParams` split is new and non-negotiable.** It is a pure refactor with no
  visual change, and doing it first means every later phase is written against per-frame
  illuminance. Retrofitting it after Phase 4 would touch all of them again.
- **HDR (6) now precedes glare (8), deliberately.** Glare is partly a *trick for faking dynamic
  range the display cannot show* — its correct strength differs by several times between an
  8-bit SDR output and a 1600-nit XDR panel. Tuning it before the output path is settled
  guarantees re-tuning it after. Auto-exposure (5) must come first either way, since HDR needs a
  stable reference white to map against.
- Scotopic vision (7) precedes glare (8) because both operate on the deep-space look and glare
  should be judged against the final desaturated night-vision image, not a colourful one.

---

## 6. Performance budget

The current baseline (`PERF_MEASUREMENT.md` § THE BASELINE, post-BSM-cache) is **deck 75–78 fps,
everything from 750 km up on the 120 fps cap**, with the atmosphere pass dominating. There is
**no headroom at the deck** — the doc's own conclusion is that reaching 120 there would require
cutting the volumetric clouds. So this work must be close to free.

| Element | Est. cost | Notes |
|---|---|---|
| `uExposure` multiply | ~0 | one MAD in shaders that already run |
| Surface `E/π` factor | ~0 | one multiply |
| Impostor radiance + phase | ~0 | impostors are a handful of pixels |
| Histogram auto-exposure | **0.1–0.3 ms** | one 128-bin compute pass over a downsampled target; keep it at ≤¼ res and off the readback path |
| PSF glare | **⚠ 0.5–2.0 ms** | the real risk. Replaces bloom's measured ~1.8–2.0 ms, so it can be *net neutral* — but only if implemented as a separable/mip approximation of the PSF rather than an FFT convolution. **Must be ablated, not estimated.** |
| Night-side additions | ~0 | texture reads in an existing shader |
| HDR output path | ~0 | format change only |

⚠ Per `PERF_MEASUREMENT.md`'s hardest-won lesson: when `gpu/frame > 1.15`, **ablate, never do
arithmetic on reported per-pass numbers**. The record on estimates in this repo is *0 for 4*.
Every number in the table above is an estimate and must be replaced by a ground-truth ablation
before it is believed. In particular, do not accept the "PSF is net neutral vs bloom" claim
without measuring it.

---

## 7. Risks & gotchas

1. **The cancellation trap (§4.1).** The single most likely way to make this work look like a
   regression. Mitigated by phase ordering.
2. **`fragmentNode` bypasses `setupLighting()`.** Any plan that assumes adding a three.js light
   will illuminate a planet is wrong (D07). Planet lighting is hand-written TSL; keep it that way
   and pass illuminance as a uniform. Do not attempt to move planets into the local scene.
3. **Half-float overflow.** 250,000 game units for the sun disc exceeds RGBA16F max 65,504.
   Pre-exposure is mandatory, and the exposure *ceiling* is a numerical requirement, not just an
   aesthetic one (§3.2).
4. **Auto-exposure pumping.** A 0.5°-wide 1e9 cd/m² source entering frame will slam any naive
   metering. Mitigated by log-domain histogram + 90% percentile clipping + centre weighting.
5. **Auto-exposure vs `__bench`.** Breaks perf reproducibility unless pinned (§4.3).
6. **Auto-exposure vs the HUD.** The HUD is HTML over the canvas and is *not* tone-mapped, so it
   will not track exposure. That is arguably correct (it is a screen, not a window) but must be
   checked for legibility against a fully-exposed bright planet.
7. **The Milky Way skybox is authored for SDR looks, not absolute luminance.** AUDIT_3 estimates
   a ~20-magnitude discrepancy. Under correct exposure it either vanishes or needs re-authoring.
   Decide before Phase 5.
8. **TSL mutable-var aliasing.** A node reading a `.toVar()` that is reassigned before use
   evaluates to the *new* value — this previously caused an invisible atmosphere. Materialise
   with `.toVar()` when threading `uExposure` through existing graphs.
9. **No AA.** Sub-pixel bright bodies will flicker regardless of the radiance fix (D14).
   The PSF splat in Phase 4 addresses the bodies; a general TAA is out of scope here.
10. **three.js HDR + tone mapping are not officially composable yet.** We are insulated because
    tone mapping is already in-graph, but a three.js upgrade could change that assumption.
11. **Venus multiple scattering: RESOLVED, +18…+21%, accepted** (§2.2). Faithful implementation
    of an approximation operating near its documented limit. Not a bug, not blocking, and
    deliberately *not* given a correction knob. Do not "fix" it by scaling the output.
12. **Orbital motion will expose latent full-phase assumptions.** Anything that currently reads
    correctly only because bodies never move — a frozen `sunIlluminance`, an impostor tuned at one
    phase angle, a texture-space sun direction — will break the day orbits are enabled. §3.0's
    split removes the known one; assume there are more, and make `__lum.sweep()` include at least
    one non-zero-phase view (e.g. `venus_crescent`) so they are caught by the harness rather than
    by eye.
13. **Compressed rod adaptation is a deliberate physics deviation** (§3.9a): ~4–8 s instead of
    20–40 minutes. Documented here so it is not later "fixed" into unplayability. The asymmetry
    between light- and dark-adaptation is the part that must be preserved.
14. **Scotopic desaturation will fight the HUD and the impostor colours.** A grey-blue deep-space
    image makes the coloured HUD markers and any remaining saturated impostor tint look pasted-on.
    Check both when Phase 7 lands.

---

## 8. Decisions — settled with the author, 2026-08-14

1. **How dark should space be? → Replicate the dark-adapted human eye.** Stars brightly visible
   unless something bright is in frame. Implemented as `evMin = −16` (derived in §3.4, not
   guessed) + veiling glare + the scotopic model (§3.9). The requirement falls out of the physics.
   The aesthetic knob moved from a hard exposure clamp to the **skybox's absolute luminance** and
   the **adaptation time constants** — see §3.4 for why the "grey mush" fear was misplaced.
2. **Eye, not camera.** Human-eye PSF; no lens flare, no anamorphic streaks. The player should
   feel what *they* would see out of the cockpit. Aperture diffraction stays available for photo
   mode only. This also settles §3.9's scotopic model as in-scope: an eye has rods, a camera doesn't.
3. **Let exposure place the Milky Way first**, re-author only if needed. AUDIT_3 estimates it is
   ~20 magnitudes off, so expect to re-author — but measure before spending the effort (Phase 7).
4. **AgX now**, GT7-style Color Volume Mapping later as a swap-in.
5. **HDR is a first-class goal, not an afterthought.** Target device: MacBook M2 Pro built-in XDR
   (P3, ~1,000 nits sustained / 1,600 peak). SDR still comes first — a correct SDR image is a
   prerequisite for a correct HDR one, not the reverse — but HDR moved **from Phase 8 to Phase 6**,
   ahead of the glare work, because glare strength depends on the output path (§5). Every phase
   from 3 onward should be sanity-checked on the XDR panel even before Phase 6 lands.
6. **`mars.ts:109`'s `12.0` is not a typo — it is a symptom, and it confirms the diagnosis.**
   The author set Mars' stellar point bright red to match how Mars looks to the naked eye from
   Earth, then pushed the *billboard* value to `12.0` because the transition between the two
   tiers looked wrong. That is D06 — the 68–86,000× billboard↔point discontinuity — being
   hand-patched at one body. It is the clearest possible evidence for §3.6's unified radiance
   model: once all three tiers compute `L = p·(E/π)·Φ(α)`, there is no transition to patch.
   **Delete the `12.0` in Phase 4** rather than retuning it; Mars will then be correct by
   construction (disc L = 0.466 units = 2,980 cd/m², and a properly red-orange
   albedo-calibrated texture gives the naked-eye colour for free).

### 8.1 Remaining open questions

None blocking. §2.2 closed the Venus multiple-scattering question (+18…+21%, accepted as the
approximation's documented limit). The one loose end, §2.2.1, is whether `deriveAtmosphere()`
reproduces measured geometric albedo across all bodies — best answered by a disc integration once
`__lum` exists, and directly load-bearing for procedural systems.

**Everything in §2.2 is now settled, so implementation can start at Phase 0.**

---

## 9. Key files

**New:** `src/components/space/exposure.ts` (histogram + adaptation + `uExposure`),
`src/components/space/glarePass.ts` (PSF), `src/components/space/perf/lumHarness.ts` (`__lum`),
`src/data/bodyPhotometry.ts` (the §3.6 table).

**Touched:** `SpaceRenderer.tsx` (exposure stage, glare replacing bloom, HDR output),
`Scene.tsx` (renderer ctor for HDR), `Star/SunLight.tsx` (distance), `Star/Star.tsx` (`CORE_HDR`),
`celestial/useFarLOD.ts` + `space/StellarPoint.tsx` (unified radiance),
`celestial/bodies/*.ts` (all surface shaders: `E/π`; Earth's sigmoid; texture calibration),
`celestial/bodies/atmosphereData.ts` (delete `VENUS_ILLUM_TRIM`, document the 6,400 constant),
`celestial/bodies/cloudCommon.ts` (`CLOUD_SUN_SCALE` re-anchor), `store/store.ts` +
`SettingsMenu.tsx` (exposure/HDR settings).

---

## 10. References

- Hillaire, *A Scalable and Production Ready Sky and Atmosphere Rendering Technique* (2020) —
  `docs/AtmosphereReferences/Frostbite.md`
- Lagarde & de Rousiers, *Moving Frostbite to Physically Based Rendering* — pre-exposure, units
- Google Filament documentation — physically based camera, EV100, light units
- Unreal Engine, [Auto Exposure](https://dev.epicgames.com/documentation/en-us/unreal-engine/auto-exposure-in-unreal-engine) — histogram defaults (−8…+4 EV, 10/90 percentile)
- Spencer, Shirley, Zimmerman & Greenberg, *Physically-Based Glare Effects for Digital Images*, SIGGRAPH 1995
- Ritschel et al., *[Temporal Glare](http://people.compute.dtu.dk/jerf/papers/TemporalGlare.pdf)* — real-time eye scattering
- Uchimura, *Practical HDR and Wide Color Techniques in Gran Turismo SPORT*, [SIGGRAPH Asia 2018](http://cdn2.gran-turismo.com/data/www/pdi_publications/siggraph_asia_2018_cousenotes.pdf)
- Yasutomi, Suzuki & Uchimura, *Driving Toward Reality: Physically Based Tone Mapping and Perceptual Fidelity in Gran Turismo 7*, CEDEC 2026 — "Color Volume Mapping"
- three.js [WebGPURenderer HDR support PR #29573](https://github.com/mrdoob/three.js/pull/29573) and [`.outputType` PR #30320](https://github.com/mrdoob/three.js/pull/30320)
- MDN — [`dynamic-range-limit`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/dynamic-range-limit), [`@media (dynamic-range)`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/dynamic-range)
- McEwen, *Photometric functions for photoclinometry* (1991) — the lunar-Lambert mix
- `docs/PERF_MEASUREMENT.md` — the ablate-don't-estimate rule this plan's §6 defers to
