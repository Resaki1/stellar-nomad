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

## 0.9 REMAINING WORK — status as of 2026-08-18

Phases 0, 1, 2a, 2b, 2d, 3a, 3b and 5 are shipped. **2c, 4, 6, 7, 8, 9 are open.**

Closed defects: D01, D02, D03, D03b, D05, D08, D10, D11, D15, D17, D18, D22, D24, **D25, D27, D31**.

### Open, grouped by what actually unblocks what

| # | work | defects | blocked by | note |
|---|------|---------|-----------|------|
| 1 | ✅ **Star catalogue** rendering — S0–S2 done, validated 0.999× | **D30** ✅ | — | S3 diffuse split ✅ too; remaining: S4 SH bake (D29), S5 parallax, S6 navigation |
| 2 | ✅ **Emissive calibration** — step 1 done (2026-08-26) | **D26** | — | every VFX emissive now carries a temperature or a stated cd/m², in [`emissivePhotometry.ts`](../src/components/space/emissivePhotometry.ts). Gate `__lum.emissives()`. 🔑 The audit's verdict: they were NOT badly miscalibrated, they were **unstated** — see D26e. Remaining: the metering policy (step 2), which the hot-tail cap already largely covers |
| 3 | ✅ **Phase 4 — unified impostor radiance** | **D04, D06, D20** | — | **CLOSED and verified 2026-08-26**: worst |log2| **0.29 stops** (from 1.31), worst tier jump **0.32** (from 0.59), gate reports scale continuous across every transition. The ×3/2 geometric→Lambert prediction landed within **1.5%**. Only residual is the mid tier at 1.22× dim, which is D09/D23 territory |
| 4 | ✅ **Phase 2c — texture calibration** | **D09** ✅, **D23** ✅ | — | D09 (runtime albedo), D09e (hue from measured band spectra, 8 planets) and **D23** (ocean diffuse = physical water-leaving) all closed. ⚠⚠ **But D23 was never a visual defect: MEASURED at 0.098% of an ocean pixel from orbit (D23c), so its value is at low altitude only.** Its "21–43×" premise was also a units error (D23/D23b). Remaining: **D09f**, Io/Luna/Galileans on one colour degree of freedom |
| 4b | ⛔ **NEW, and it now has a live number — CLEAR-SKY RADIANCE OVER OCEAN IS ~5.7× TOO DARK, in the ATMOSPHERE pass** | (was D23) | nothing | MEASURED: the orbital ocean pixel reads **0.119 game units** where a physical clear-ocean column (reflectance ~0.10 at 1 AU) is **0.675** — **5.7× too dark** — and 99.9% of that pixel is `atmospherePass.ts`, not the surface (D23c). Its B/R was 5.68: Rayleigh, neither water nor cloud. 🔑 This is what the old "clear sky 0.044 vs a real ~0.12" observation was actually seeing, and it is the defect the player can see. ⚠ Re-measure first: the 0.044 figure predates several atmosphere fixes, and the probe above is a single pixel at one geometry — sweep sun angle and altitude before touching the in-scattering |
| 4e | 🐛 **E0's "ZERO-MIGRATION" ALIASING TRICK SHIPPED FOUR BUGS.** Making `*_POSITION_KM` mutable arrays was supposed to give every consumer live positions for free. **It did not.** (1) The exports were `[...spread]` COPIES, creating **two independent sets of position arrays** — body render configs went live while everything reading `systemConfigAtom` kept the static originals. Symptoms on device: **POI markers in the wrong place, bodies unfindable, dev warps landing where planets used to be, and the ship crashing into empty space.** Fixed by mutating `body.positionKm` inside `sol.json` itself — ONE set of arrays, since `celestialConstants` and `store/system.ts` import the same JSON module. (2) **Aliasing only reaches consumers holding a REFERENCE**: `Spaceship.tsx` and `TransitTicker.tsx` both built flat `{x,y,z}` collider structs in a `useMemo([])`, behind the comment *"systemConfigAtom is effectively static in the current codebase"* — which E0 made false. (3) **Asteroid fields carried their own absolute `anchorKm`** and never moved: the belt meant to sit 15,800 km from Earth ended up 380,000 km away. Now `anchorBody` + `anchorOffsetKm` with `anchorKm` derived in place. (4) **Positions stayed static until the first `CelestialBody` frame loop**, so any earlier `useMemo` captured launch-day coordinates permanently — fixed with a solve at module load. 🔑🔑 **A "zero-migration" aliasing trick has a precise reach, and every consumer outside it fails SILENTLY and PERSISTENTLY. Enumerate them before claiming the migration is deferred.** | [`celestialConstants.ts`](../src/sim/celestialConstants.ts), [`Spaceship.tsx`](../src/components/Spaceship.tsx), [`TransitTicker.tsx`](../src/components/Transit/TransitTicker.tsx) | 4 shipped bugs | ✅ |
| 4f | 🐛 **THREE MORE E0 STALENESS BUGS, ALL FOUND ON DEVICE — and the third one is a `useMemo` dependency array.** (5) **The SPAWN POINT was still absolute.** `startingPositionKm` was authored next to Earth's static position, so once Earth orbited, the spawn — *and the `belt` perf scenario, which references that exact array* — pointed at empty space. The user's report was "the warp to the belt still goes to the old position". Same treatment as the fields: `startingBody` + `startingOffsetKm` (the fixed authored geometry, 16,746 km from Earth's centre and 2,834 km from the belt's, i.e. inside its 3,000 km core), with the absolute value derived in place. ⚠ `APPROACH_DIR` now comes from `startingOffsetKm` too, because differencing two LIVE arrays at module load depends on whether `celestialConstants` has solved yet. (6) ⚠⚠ **`frameloop="never"` IS A STALENESS SOURCE IN ITS OWN RIGHT.** `settingsIsOpenAtom` pauses the render loop, and `CelestialBody`'s frame loop was the ONLY caller of `updateEphemerisPositions` — so setting a date in the dev menu and then warping resolved the warp against whatever positions the last rendered frame left behind. Fixed by making `simEpochMsAtom` **write-through**: setting it solves the ephemeris immediately. 🔑 A write-through atom rather than a second `setEpochAndSolve` atom, because a rule every caller must remember is a rule the next caller forgets. (7) 🔑🔑 **THE WHOLE DEV UI FOR SIM TIME WAS DEAD, AND THE CAUSE WAS A DEPENDENCY ARRAY.** `simEpochMs`/`simRate` were threaded through `devHandlers`, a `useMemo` whose deps listed neither — so the atoms updated while the props did not. The date field and the rate slider both appeared frozen, and *caught up only when an unrelated dependency (the max-speed override) invalidated the memo*, which is exactly what the user observed. **Fixed by deleting the props: `SimTimeControls` reads the atoms where it renders them, and has no dependency array to get wrong.** ⚠ The same file's `devHandlers` memo omits several other deps — this class will recur there. Also fixed with it: the `datetime-local` field was clipped to 72px ("08.0" plus a picker icon on top of the digits), had no way to APPLY a typed date (a controlled `onChange` write is impossible to type into — a half-typed year parses as 0002), and the eclipse button used a `dev-controls__button` class **that does not exist in the SCSS**, so it rendered as an unstyled native button. ✅ New diagnostic: `__lum.ephemeris()` now prints an **anchor table** comparing each anchored object's live distance-from-parent against its authored offset — a stale copy disagrees by ~1 AU, not by rounding. | [`SettingsMenu.tsx`](../src/components/HUD/SettingsMenu/SettingsMenu.tsx), [`simTime.ts`](../src/store/simTime.ts), [`scenarios.ts`](../src/components/space/perf/scenarios.ts), [`celestialConstants.ts`](../src/sim/celestialConstants.ts) | 3 more shipped bugs | ✅ |
| 4d | ✅ **E0 — real orbits and rotation (ephemeris)** | — | — | LANDED 2026-08-27. [`sim/ephemeris.ts`](../src/sim/ephemeris.ts): Kepler solver + JPL approximate-position table + abridged ELP2000 for Luna + IAU-style spin, all in a fixed ecliptic-J2000 frame (+Y north). Sim time is one scalar ([`store/simTime.ts`](../src/store/simTime.ts)), default rate **0 = frozen**, settable date + rate in Settings → Dev. ✅✅ **VALIDATED ON TWO PUBLISHED ECLIPSES: greatest eclipse to 1 MINUTE and γ to 0.5%, twice** (2024-04-08 18:18/18:17, γ 0.3453/0.3435; 2017-08-21 18:27/18:26, γ 0.4384/0.4367), plus Earth's perihelion 0.98331 (vs 0.98330) and aphelion 1.01670 (vs 1.01671). Gate `__lum.ephemeris()`. ⚠ Galilean orbital PHASE is a placeholder |
| 4c | ✅ **D34 — body-on-body eclipses** | **D34** | — | LANDED 2026-08-27. Generic per-pixel star-disc occlusion for every body, both directions, from the existing occluder registry; Earth de-hardcoded off Luna. Gate `__lum.eclipses()`. ⚠ Remaining: an eclipsed body is BLACK, not coppery — D28's refracted term reaches the ship but not body shaders yet (D34c) |
| 5 | ✅ **D28 — refracted limb light** | D28 | — | LANDED 2026-08-27. Derived from the atmosphere's own composition; validated on three independent anchors (1.123° deflection, 0.116 cd/m² hull, ~32% clear annulus). 🔑 Found the atmosphere's **focal length** (Earth 51 R⊕) and that the shadow axis is DARK inside it — overturning this plan's own "closer is brighter" assumption. See D28b/D28c |
| 6 | **Phase 6 — HDR output** | D13 | ✅ **unblocked** | the star work it wanted to follow (D30/D32, S0–S3) is done. Next up |
| 7 | **Phase 7 — scotopic/mesopic + Purkinje** | D19 | after stars | the "night vision" look; pointless while stars are 482× too dim |
| 8 | **Phase 8 — PSF glare replacing mip bloom** | D12 | ✅ **unblocked** | both prerequisites are done: Phase 4 landed and D26 step 1 gave every emissive an absolute luminance. Glare can now read real inputs. 🔑 This is the answer to "with the sun in view everything else is black" — a PSF veils, a mip bloom does not |
| 9 | **Phase 9 — night-side stack** | D16 | after 4 | city lights at absolute luminance, moonlight, airglow, aurora |
| — | **D21** `earth_normal` asset | D21 | asset re-source | mitigated by the grazing fade; a 4K+ normal map would let that fade be deleted |
| — | **D07** planets bypass three.js lights | D07 | — | arguably *resolved by design*: surfaces consume `uSunIlluminance` directly. Revisit only if a body ever needs multiple light sources |
| — | **D14** no AA | D14 | — | outside the lighting plan, but interacts: sub-pixel stars and the sun disc both alias |

### Two independent findings worth carrying forward

- **The cloud terminator nonlinearity.** `__lum.preExposure(8)` shifts the far cloud shell's terminator
  and pushes it through orange before fading. A brightness change would be a missing multiply; a **hue
  and position** change means a genuine nonlinearity in the shell path. Candidates: the AP target's
  `(L, Tmean)` split, the extra half-float hops through the sparse/history RTs, the opacity LUT. Needs
  `SHELL_DEBUG_VIZ`, not speculation — see `CLOUD_DEBUGGING_LESSONS.md`.
- **`HOT_COMPRESS_EXPONENT = 0.25` is an artistic knob**, not a derived constant. With the sun in frame
  the hot tail is 98% of flux and the compressor holds back 4.4 stops, lifting the reading only 1.27.
  Raise the exponent toward 1.0 to make staring at the sun genuinely punishing.

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
| D04 | ✅ Far billboard had no illuminance term | [`useFarLOD.ts`](../src/components/celestial/useFarLOD.ts) | CLOSED: `useFarLOD` now wraps EVERY builder in `surfaceRadiance` (× E/π), one conversion shared with the near/mid tiers. Also fixed the 7 overrides' missing D25 pre-exposure. Gate `__lum.lod()` | ✅ |
| D05 | `VENUS_ILLUM_TRIM` under-renders Venus | [`atmosphereData.ts:271`](../src/components/celestial/bodies/atmosphereData.ts#L271) | **32×** | R |
| D06 | ✅ Billboard→point handoff discontinuity | [`StellarPoint.tsx`](../src/components/space/StellarPoint.tsx) | CLOSED: `bodyIlluminanceAtCamera` + `stellarPointRadiance`; `REFERENCE_HDR`/`JUPITER_REF_FLUX`/the 500 clamp deleted. Every point dims by ONE body-independent factor (1/1,038× at 1783p) and is now correctly resolution-dependent | ✅ |
| D07 | Planets unreachable by three.js lights | `fragmentNode` bypasses `setupLighting()` | structural | I |
| D08 ✅ | Earth has no Lambert cosine (sigmoid, ≥0.98 for cosθ>0.1) | [`earth.ts:269`](../src/components/celestial/bodies/earth.ts#L269) | flat day disc | I |
| D09 | 🔶 **Textures are brightness-normalised art, uncorrected — now calibrated at RUNTIME.** ⚠ Fixed as a MEASUREMENT, not a table: the textures are expected to change, and a pasted constant becomes a lie the moment an asset is swapped (this repo has been burned twice already). **(a) Far tier — analytic, no measurement needed:** the 13 authored `THREE.Color` albedos span **8.7× (3.12 stops)** against `bodyPhotometry` with a geometric mean of **1.076** — 🔑 spread with NO systematic offset, i.e. a pure per-body error that **no exposure setting or tone curve can absorb** (Luna +1.64 hot while Neptune is −1.49 cold in the same frame). `useFarLOD` now normalises each colour's LUMINANCE to `geometricAlbedo`, hue preserved, at consumption. **(b) Near/mid — measured:** [`albedoCalibration.ts`](../src/components/celestial/albedoCalibration.ts) renders the loaded colour map to 128×64 with 16×16 stratified taps at **level 0** (⚠ not a mip: `toktx --genmipmap` filters in sRGB, so a mip is the average of ENCODED texels; and derivative LOD would have made all 256 taps read mip ~6, so the sampler's mip filtering is suppressed for the one draw), then takes the **cos(latitude)-weighted** sphere mean (an equirect over-samples the poles, i.e. the bright ice caps). ⚠ Weighting is symmetric ⇒ immune to the D24 v-flip. Scale = `geometricAlbedo / mean`, applied as ONE wrapper multiply in `CelestialBody` so no body can forget it. **✅ VALIDATED: Earth's day map measured 0.0893 against an independently-computed cloud-free surface albedo of 0.0900 — 0.993×.** ⚠⚠ Which is exactly why Earth is now `colourMapPartialReason`-SKIPPED: its texture is CLOUD-FREE, so most of p=0.434 lives in the separate cloud layer and calibration wanted a wrong **+2.28 stops**. 🔑 D09 is about the texture's MEAN, D23 about its DISTRIBUTION — different defects; Earth's mean is right while its ocean p02 is crushed. Gate `__lum.albedo()` (also audits the duplicated `stellarPoint.geometricAlbedo`: ✅ all 13 match). ⚠ Remaining: the residual sphere-mean→disc-average constant is body-independent, measured by `__lum.disc()` across 3+ bodies. | all colour maps | **8.7× spread closed on the far tier** | R |
| D09b | ✅ **Hue derived from the measured colour index, not authored.** Both RGB triples per body — the far billboard's `albedo` and `stellarPoint.color` — were picked by eye while `bodyPhotometry.colorIndexBV` sat unused with the comment "used to derive a defensible tint". [`bodyColour.ts`](../src/components/celestial/bodyColour.ts): `Δ(B−V) = −2.5·log₁₀(R_B/R_V)` against the Sun's 0.653 ⇒ `R_B/R_V = 10^(−0.4·Δ)`, closed to RGB by a **linear spectral slope** through the Johnson band centres (442/540 nm) evaluated at the sRGB primaries' dominant wavelengths (611/549/465 nm), then renormalised so Rec709 luminance = `geometricAlbedo`. Both LOD tiers read it, so the crossfade cannot shift colour. ⚠⚠ **B−V is ONE degree of freedom and RGB needs TWO**, so red is an extrapolation and the model **systematically UNDER-saturates** anything with narrow absorption bands — most visibly Io (sulphur) and the ice giants (methane absorbing in the RED, the opposite of a smooth slope). Treat the output as a defensible LOWER BOUND; the real fix is a second measured index (V−R/B−R). Override hook `measuredReflectanceRgb`, cited values only. 🔑 Big visible changes, all toward calibrated imagery: Mars R/B **4.00 → 2.12** (muted butterscotch, not saturated orange), Venus **2.50 → 1.24** (pale cream), Neptune **0.06 → 0.69** — the vivid Voyager blue was contrast-enhanced and the reprocessed data shows a pale cyan close to Uranus. | [`useFarLOD.ts`](../src/components/celestial/useFarLOD.ts), [`CelestialBody.tsx`](../src/components/celestial/CelestialBody.tsx) | 13 authored triples removed | ✅ |
| D09d | ⚠ **A TIER-HUE STEP I INTRODUCED WITH D09b, then fixed per-channel.** Deriving the FAR tier's hue from B−V while the near/mid tier kept its TEXTURE's hue put the two tiers on different sources. MEASURED on Neptune: far tier R/B **0.690**, texture R/B **0.051** — a **13.5× disagreement on one body in one frame**, visible as a colour shift across the LOD transition. Worse, a saturated-blue texture has LOW Rec709 luminance (blue weight 0.0722), so the luminance-only fix scaled Neptune **+1.85 stops** and produced a *brighter vivid blue* instead of the pale cyan its colour index implies. **Fix: the correction is PER-CHANNEL** — the texture's cos-weighted mean RGB is moved onto the derived RGB, so both tiers share one source and all spatial variation survives. ⚠⚠ **Bounded at 1.5 stops per channel, as an admission of ignorance not a safety margin:** Neptune wants **[19.3, 3.54, 1.42]** — a 19× boost on a red channel whose texture mean is 0.0196 — and Neptune is exactly where the model fails (methane absorbs in the RED, invisible to a slope fitted 442→540 nm). The texture's 0.051 is likely too low and the derived 0.69 too high; **neither source knows where the truth is**, so the hue moves at most 1.5 stops and the body is NAMED. 🔑 A clamp here is a WORKLIST ENTRY: that body needs a real V−R/B−R in `measuredReflectanceRgb`. Luminance stays exact via post-clamp renormalisation — trading the certain result for the uncertain one would be backwards. | [`albedoCalibration.ts`](../src/components/celestial/albedoCalibration.ts) | 13.5× → ≤1.5 stops | 🔶 |
| D09e | ✅ **HUE FROM A MEASURED SPECTRUM, NOT A ONE-PARAMETER MODEL — D09b's known failure closed for all eight planets (2026-08-26).** D09b derived colour from `colorIndexBV` alone and said so in writing: *"B−V is ONE degree of freedom and RGB needs TWO… the model systematically UNDER-saturates anything with narrow absorption bands… the real fix is a second measured index."* **The fix turned out to be better than a second index: full per-band geometric albedos.** [`bodyPhotometry.bandAlbedo`](../src/data/bodyPhotometry.ts) now carries U/B/V/R/I for all eight planets from **Mallama, Krobusek & Pavlov (2017), Icarus 282, 19–33, Table 7** (arXiv:1609.05048), and [`bodyColour.ts`](../src/components/celestial/bodyColour.ts) integrates the interpolated spectrum against the CIE colour-matching functions under the star's own Planck spectrum via `reflectanceSpectrumToLinearSrgb`. 🔑🔑 **THE DECISIVE CHECK: that is the table `geometricAlbedo` ALREADY CAME FROM.** All eight V-column values match this repo's existing albedos to every digit (Mercury 0.142, Venus 0.689, Earth 0.434, Mars 0.170, Jupiter 0.538, Saturn 0.499, Uranus 0.488, Neptune 0.442) — so this is the rest of a row the project was quoting one cell of, not a second opinion beside the first. Same for the zero point: `SUN_B_MINUS_V = 0.653` turned out to be **Ramírez et al. (2012), ApJ 752, 5** exactly, which also supplies (V−R)☉ = 0.352 for the two-index path. **⚠⚠ MEASURED — the old model's error, quantified, and it fails EXACTLY where D09b predicted:** Uranus R/B **0.875 → 0.360** (model 1.8× too red), Neptune **0.686 → 0.322** (1.6× too red), Mars **2.13 → 3.27** (1.5× too pale), Earth **0.448 → 0.816** (1.8× too blue) — while Jupiter/Venus/Saturn/Mercury move only 0.89–1.15×. 🔑 The four smooth-spectrum bodies barely budge and the four with real spectral structure move a lot, so the slope model is **kept as the fallback** rather than deleted. ⚠ Luminance is still renormalised to `geometricAlbedo`, so **hue only** moves and the whole D09 brightness calibration is untouched. | [`bodyColour.ts`](../src/components/celestial/bodyColour.ts), [`photometry.ts`](../src/components/space/photometry.ts) | **up to 1.8× on hue, 4 bodies** | ✅ |
| D09f | ⚠⚠ **A CITATION IS NECESSARY BUT NOT SUFFICIENT — Io and the moons stay OPEN, on purpose.** The obvious route for the moons was the V−R column of a compilation (johnstonsarchive, crediting "L09b"): Ganymede **1.04**, Io **0.72**, Europa **0.69**, Callisto **0.25**. 🔑 That puts **Ganymede redder than Io** and **Callisto bluer than the Sun** (0.352) — both flatly contradicting how those bodies look, while the *same page's* B−V column has the ordering right (Io 1.17 ≫ Europa 0.87 ≈ Ganymede 0.83 ≈ Callisto 0.86). Probably mixing photometric systems. **Rejected, and the rejection is the deliverable:** `colorIndexVR` ships as a supported field with the failed check written into its doc comment, and Luna + the four Galileans stay on the B−V slope model with D09d's ±1.5-stop clamp. Io remains the named worklist body it was. ⇒ **Do not fill these in from a compilation; they need a primary source.** | [`bodyPhotometry.ts`](../src/data/bodyPhotometry.ts) | 5 bodies still on 1 DOF | ⛔ |
| D09g | 🐛 **GATE BUG — `__lum.albedo()`'s hue table was gated on runtime mounting.** It iterated the published-body registry, so the one table that is a **pure function of static data** (band albedos and colour indices → RGB) was the hardest in the harness to read: empty until a body streamed in, empty again after every HMR cycle, and unavailable to any headless check. Now iterates `BODY_PHOTOMETRY` directly. ⚠ The duplicated-constant audit below it still needs live bodies and correctly still gates on them — it compares against what the renderer PUBLISHED, which is a different question. 🔑 Ask whether a diagnostic depends on runtime state before making it wait for runtime state. | [`lumHarness.ts`](../src/components/space/perf/lumHarness.ts) | instrument | ✅ |
| D09c | 🐛 **GATE BUG, not a renderer bug — `__lum.disc()` read a PRE-EXPOSED RED CHANNEL.** `expected()` took `rec.sunIlluminance.x`, which `atmospherePass` sets to `illum × getPreExposure() × starTint[0]` (D25), while `decodeRgb` divides pre-exposure OUT of the measured side. MEASURED fallout: Saturn reported **0.040× (−4.66 stops)** and Neptune **0.014× (−6.12)** — apparently catastrophic — while the renderer was correct to **0.86×** and **1.09×** against hand-computed physics. 🔑 The tell was WHICH bodies were wrong, not how wrong: only the AIRLESS ones (Mercury, Luna) read correctly, because with no atmosphere record they fell through to the clean authored-distance path. Fixed to take the record's live `starDistanceKm` and recompute. **After the fix, five bodies from 0.39 to 30 AU agree to 0.51 stops with a geometric mean of 0.993** — so the sphere-mean→disc-average residual D09 expected to leave behind is not there at all. | [`lumHarness.ts`](../src/components/space/perf/lumHarness.ts) | instrument | ✅ |
| D10 | Clouds ~100× brighter than the ground below them | [`cloudCommon.ts:141`](../src/components/celestial/bodies/cloudCommon.ts#L141) | **10–30×** | R |
| D11 | Shipped defaults are `toneMapping: false` (→ Neutral, crushes above linear ≈4) **and** `bloom: false` | [`store.ts:29-30`](../src/store/store.ts#L29) | 2 code values | I |
| D12 | Bloom is radius 0, strength 0.02, additive | [`SpaceRenderer.tsx:516`](../src/components/space/SpaceRenderer.tsx#L516) | no glare | I |
| D13 | No SDR/HDR display handling; 8-bit sRGB only | `Scene.tsx` renderer ctor | — | I |
| D14 | 🔶 **No AA of any kind → fixed with 4× MSAA on the scaled-scene target.** The user's report: "planets look really pixelated at the edges until I get pretty close". 🔑 **MSAA over FXAA/SMAA because of what the content is:** a planet limb is a GEOMETRIC edge against black, which coverage supersampling solves exactly — and MSAA does not touch shading, which matters more than usual here because the starfield is 1–2 px Gaussian point sprites whose flux was calibrated to 0.999×, and FXAA's edge detector treats an isolated bright pixel as an edge and blurs it. **A post-process AA would quietly undo the star photometry.** ⚠⚠ Applied to `rt` ONLY, not `rtB`: geometry is drawn in two places (scaled scene → `rt`, ship → `rtB`) with the atmosphere and cloud FULLSCREEN passes between, and multisampling `rtB` would make those — the two most expensive passes in the frame — pay 4× coverage for nothing. The ship stays aliased; small, close, not what was reported. Setting: Graphics → "anti-aliasing (4× MSAA)", tier-gated to `gpu.tier >= 2` on first run. 🐛 Found alongside: `atomWithStorage` REPLACES defaults with the persisted blob, so any setting added after a player's first run arrives `undefined` and its shipped default never applies — hence `settings.antialias ?? true` at both read sites, matching the existing `exposureStops ?? 0`. | `SpaceRenderer.tsx`, `store.ts`, `SettingsMenu.tsx` | flicker | 🔶 |
| D14b | 🔶 **THE ATMOSPHERE LIMB'S ALIASING IS A SHADER BRANCH, NOT COVERAGE — so neither MSAA nor a shell mesh can fix it.** The march had `tEnd = select(groundHit, tGround, atmo.tFar)`: a HARD BINARY branch at the planet's ground silhouette, where `tGround` is the grazing distance and `atmo.tFar` the far shell exit, so `L` and `T` jump discontinuously across the planet's edge. ⚠ Compounded by `AP_RES_SCALE = 0.5` — the branch is evaluated at HALF res and bilinearly upsampled, giving 2×2-px blocks. 🔑 That explains the user's exact three-regime report ("aliased at mid distances, fine when far or close"): far = billboard tier, no march; close = the edge leaves the screen. And why 4× MSAA visibly fixed AIRLESS bodies and did nothing for Jupiter. **Fix: analytic sub-pixel coverage** — the silhouette is an exact circle, impact parameter `b⊥ = √(r²−(ro·rd)²)`, silhouette at `b⊥ = Rg`, and one pixel of angle maps to `db⊥/dθ = √(r²−Rg²)` km, so the band half-width is `0.5 · tanPerMarchPx · √(r²−Rg²)`. Same tan-not-angle discipline as the sky LOD and star sprites. ⚠ Sized in MARCH pixels: a ramp narrower than the half-res grid would alias again. 🐛 Caught pre-test: `b⊥` is the distance to the infinite LINE, so a camera looking AWAY from the planet can have `b⊥ < Rg` with no forward hit, making `tEnd` negative and the march run backwards — guarded with `ro·rd ≥ 0` ⇒ full sky coverage. ⚠ Left alone: the Sky-View LUT bake (angular bins, sampled smoothly) and the AP froxel (its ground clamp is a documented correctness property). ⚠ NOT visually verified — the Browser pane does not run rAF, so frame-based warps cannot reach a limb. | [`atmospherePass.ts`](../src/components/space/atmospherePass.ts) | 2×2-px stair-stepping | 🔶 |
| D14d | 🔶 **THE REAL CAUSE OF THE "ALIASED ATMOSPHERE LIMB": RAY-MARCH BANDING.** Not coverage, not the silhouette, not resolution. `MAIN_STEPS = 16` with a CONSTANT `SAMPLE_SEGMENT_T = 0.3` means every pixel samples the same lattice along its ray, so as path length varies continuously across the limb, which parts of the density profile land on a sample changes DISCRETELY ⇒ terracing. ⚠⚠ **`atmospherePass.ts` PREDICTED THIS IN WRITING** — "NO DITHER SAFETY NET… Banding on smooth gradients — **the limb**, the terminator, the twilight sky — is the risk to look for, and it is unmitigated." 🔑 It quantises the INTEGRAL, not the pixel grid, which is why 4× MSAA, post-tonemap SMAA and D14b's analytic silhouette band all changed **nothing**, and `AP_RES_SCALE = 1.0` only helped "a bit" (finer terraces, same terraces). The user's observation nailed it: "hard steps INSIDE the atmosphere at the limb… the planet sphere below it does not seem to alias." **Fix: per-pixel interleaved-gradient jitter of the sample position** (Jimenez 2014 — one dot, two fracts, no texture fetch). ⚠⚠ **The STRUCTURE matters more than the noise:** the march used sample positions as segment ENDS, so total path was `tMax·(N−1+ξ)/N` and jittering ξ there would vary path length ⇒ **6% per-pixel BRIGHTNESS grain**. Segment boundaries are now FIXED (`dt = tMax/N`, total exactly `tMax`) and only the position inside each segment moves — textbook stratified sampling. Matches the cloud marcher's hard-won result that per-sample in-loop jitter breaks bands while a whole-march start offset "traded bands for flicker". ⚠ Spatial only, never per-frame: no temporal history here, so cycling would shimmer on a static view. ⚠ SIDE EFFECT: fixing the boundaries also integrates the ~0.7/N ≈ **4.4%** of path the old right-endpoint scheme silently dropped, so the atmosphere gets slightly denser — a bug fix, but visible; hence `ATMO_MARCH_JITTER`. | [`atmospherePass.ts`](../src/components/space/atmospherePass.ts) | limb terracing | 🔶 |
| D15 | Sun disc radiance 61× below its own scale | [`Star.tsx:80`](../src/components/Star/Star.tsx#L80) | **61×** | R |
| D16 | Night side has nothing but a texture | — | — | I |
| D17 | `sunIlluminance` baked at module load from a static position | [`atmosphereData.ts:249`](../src/components/celestial/bodies/atmosphereData.ts#L249) | blocks orbital motion + procedural systems | F |
| D18 ✅ | Star radius, colour and luminance hardcoded G2V/Sol | [`Star.tsx:38,154`](../src/components/Star/Star.tsx#L38) | blocks procedural systems | F |
| D19 | No scotopic/mesopic vision model; deep space is underexposed daylight | — | look, not correctness | I |
| D20 | ✅ Luna's `stellarPoint.geometricAlbedo` was 0.0036 vs a measured 0.136 — now 0.136 | [`luna.ts:151`](../src/components/celestial/bodies/luna.ts#L151) | **38×** too dim | I |
| D21 | `earth_normal` is 2K/58 KB; 1 LSB = 1.00° spurious tilt, and `N·L` amplifies it 1/cosθ | `public/textures/earth_normal.ktx2` | ±28% hard-edged steps at 87° SZA; **asset, mitigated in-shader** — §5.5 | I |
| D22 ✅ | Ocean "Schlick" Fresnel is `0.02 + 2.0·(1−cosθ)^2.5` — not Schlick, **peaks at 2.02** | [`earth.ts:543`](../src/components/celestial/bodies/earth.ts#L543) | ocean returns 202% of incident light; 7.4× hot at 60° | I |
| D23 | ⚠⚠ **RE-DIAGNOSED AND FIXED 2026-08-26 — THE ORIGINAL FRAMING WAS A UNITS ERROR IN MY OWN MEASUREMENT.** Was: *"day texture's dark end is crushed, ocean 21–43× too dark, Amazon 4–6×, Sahara + ice correct"*. 🔑🔑 **The 21–43× came from comparing a VISIBLE-BAND, LUMINANCE-WEIGHTED texture value against a BROADBAND (NIR-inclusive) albedo.** Water and chlorophyll both have near-zero visible reflectance and a huge NIR plateau, so a broadband figure is mostly light an RGB texture cannot and must not carry. ⚠ **Note which two regions "passed": sand and snow — the two with FLAT spectra, where visible ≈ broadband.** The result was diagnostic of the method, and I read it as a property of the asset. ⚠⚠ **AND ACTING ON IT WOULD HAVE BEEN AN ENERGY BUG:** deep ocean's ~0.06 broadband albedo is mostly SPECULAR sky reflection, which `earth.ts` already adds separately (Schlick + sky-blue reflection + sun glint) — putting 0.03–0.06 into the DIFFUSE map double-counts it, the same class of violation D22 had just removed. **RE-MEASURED** on the decoded 8K source, linearised, cos-latitude weighted, ocean/land split by the same `earth_specular` mask the shader uses: ocean mean **0.00619** (mask area **70.9%**, i.e. Earth's real 71% ✅), land **0.29639**, global **0.08934** = **0.993×** an independent cloud-free surface albedo of 0.0900. **The map's MEAN was already right.** What is wrong is its DISTRIBUTION: the ocean is 88% one flat value (p25 = p50 = p75 = 0.00178) that is **4.0× too dark** (physical water-leaving 0.00714) and **3.0× too red** (R/B 0.130 vs 0.043). 🔑 A 2% bright coastal/sea-ice tail compensates in the mean, which is exactly why `__lum.disc()` cannot see it. A fix was built (diffuse = `physical water-leaving + the texture's excess above it`, no threshold, no runtime measurement, sea ice provably untouched) and then **REMOVED after it measured as a no-op in three geometries — see D23c.** The measurements are the deliverable; the code was not. | [`earth.ts`](../src/components/celestial/bodies/earth.ts) | **ocean 4.0× lum, 3.0× chroma; 71% of the surface** | 🔶 |
| D23c | ⚠⚠ **MEASURED IN THREE GEOMETRIES: THE OCEAN'S DIFFUSE ALBEDO IS NOT A VISIBLE PARAMETER AT ANY GEOMETRY — so D23 was never a visual defect, and THE FIX WAS REMOVED.** Toggling it produced **no visible change** anywhere. 🔑 Rather than theorise about magnitudes, `D23_DEBUG_VIZ` was added per this repo's own rule (*a parameter change with zero visible effect is evidence about the MECHANISM*): magenta landed **exactly on the oceans**, proving mask and code path correct and isolating the cause to magnitude. `__lum.probe()`, fix on vs off: **orbit 15,000 km +0.295%** (0.0042 stops) · **250 km terminator +0.022%** · **8 km terminator +0.019%**. ⚠⚠ **THE LOW-ALTITUDE READINGS ARE *SMALLER* THAN ORBIT, WHICH REFUTED MY OWN JUSTIFICATION FOR KEEPING IT.** I had argued the atmosphere's share collapses near the ground so the term would matter there; near the terminator `nDotL → 0` kills the surface term instead, and the pixel goes to B/R = 44.5 — pure Rayleigh twilight. Extracting `A = sunT · nDotL · T(surf→cam)` from the three points gives **6.4e-3 at orbit, ~1e-4 at the terminator**, so even at the BEST possible geometry (sun overhead, nadir, clear) the term is **4.6% of the pixel = 0.064 stops**. 🔑 That settled it from the user's own data without a fourth test. ⇒ **Code removed rather than left as dead cost; only the findings remain, as a comment block in `earth.ts`.** ⚠ Two magnitude predictions wrong in a row here — 3% vs 0.098% measured (31×), then "matters at low altitude" vs 14× *less* than orbit. **Getting the direction and the conclusion right is not evidence of getting the magnitude right.** | [`earth.ts`](../src/components/celestial/bodies/earth.ts) | **≤4.6% of the pixel, ever** | ✅ |
| D23b | 🔑🔑 **THE DISC MEAN IS BLIND TO D23, AND THAT IS THE METHODOLOGICAL RESULT.** MEASURED: the fix moves the global cos-weighted mean **0.08934 → 0.09307**, i.e. **0.993× → 1.034×** of the 0.0900 target — a lateral move inside the target's own uncertainty, **not an improvement**. ⚠ So the plan's standing expectation that D23 would supply "the last 1.5×" on Earth's disc albedo is **wrong**: the mean was never the deficit. **This is the D09-vs-D23 split stated precisely — D09 is the texture's MEAN (right, 0.993×), D23 is its DISTRIBUTION (wrong) — and it means `__lum.disc()` must NOT be used to accept or reject D23.** ✅ **The check that DOES discriminate is independent and it passes:** Mallama Table 7 gives Earth's disc **B 0.512 / R 0.418 = B/R 1.225** — Earth is genuinely brighter in blue. The day map's global mean B/R is **0.851 before** (on the wrong side of neutral for the Blue Planet) and **1.060 after**, landing just below the disc figure — where a surface term belongs, since clouds are grey and Rayleigh is bluer still. Same table D09e brought in for hue, used here as a falsification test. ⚠ Also retired: *"`p98/p02` contrast is not usable while D23 is open… the correct target is 11.4× not 8.7×"* — that correction assumed a uniform 1.8× clear-sky deficit, and the deficit is neither uniform nor 1.8×. | [`earth.ts`](../src/components/celestial/bodies/earth.ts) | acceptance test corrected | ✅ |
| D24 ✅ | **Every planet rendered MIRRORED.** All KTX2s are `KTXorientation: rd` (top-down); three's KTX2Loader ignores orientation; `SphereGeometry` `uv.y = 1` at north ⇒ v-flip | `CelestialBody.tsx`, `cloudCommon.ts` | geometric north pole was showing Antarctica — see §5.6 | I |
| D25 | ✅ Diffuse sky **underflowed RGBA16F** (2⁻²⁴ = 5.96e-8; sky p50 is 9.6e-9) → stored as exactly 0 | [`photometry.ts`](../src/components/space/photometry.ts) + 6 source sites | fixed by source pre-exposure; sky now reads 2.3e-8 where it read 0 | ✅ |
| D26 | 🔶 The player's vehicle carries ~100% of metered flux in deep space | meter + [`EngineExhaust.tsx`](../src/components/VFX/EngineExhaust.tsx) | ⚠⚠ **RE-DIAGNOSED AGAIN, 2026-08-21: NOT a calibration bug.** `PLUME_HDR = 12` = **72,456 cd/m²**, a defensible plasma luminance. MEASURED: the plume drags metered EV −14.74 → −10.3 (**4.4 stops**) at 2% of frame weight / ~100% of flux, compressor already holding back ~5.5 stops. Deep space is 1e-4 cd/m², so a CORRECT plume is ~7e8× the sky and a real eye WOULD be blinded. The hull emissive was never the cause (it is 0 because a nozzle glowing at zero throttle is wrong). ✅ Fixed alongside: the plume's point light was missing `× preExposure` while its mesh had it — a blazing plume casting no light on its own hull. **Remaining part is a METERING POLICY, not a value.** | I |
| D27 | ✅ **The bounce fill was never occluded** (and non-dominant bodies cast no shadow at all) | [`SunLight.tsx`](../src/components/Star/SunLight.tsx), [`sunOcclusion.ts`](../src/components/space/sunOcclusion.ts) | ship glowed at 0.25 cd/m² inside an umbra, drowning the stars | ✅ |
| D26e | ✅ **EMISSIVE CALIBRATION (D26 step 1) — and the audit's verdict overturns the premise.** Every self-luminous VFX surface now lives in [`emissivePhotometry.ts`](../src/components/space/emissivePhotometry.ts), each entry carrying either a **temperature** (derived) or a **stated cd/m²** (authored, with its implied physics recorded). 🔑🔑 **THE VFX WERE NOT BADLY MISCALIBRATED — THEY WERE UNSTATED.** Measured across all 11: 197–4,748 cd/m², i.e. "bright fluorescent tube" territory, entirely defensible. The same conclusion the plume reached, now generalised. The defect was never the magnitudes; it was that no number had a unit, so nothing could be checked, and Phase 8's energy-conserving glare had nothing to read. **New derivation:** `blackbodyLuminanceNits(T)` = `(683/π)·∫M_λ(T)·V(λ)dλ`, reusing `photometry.ts`'s existing `planck()` and CIE ȳ fit (the ȳ CMF **is** V(λ)) so hue and magnitude cannot drift apart. ✅ **VALIDATED LIVE on three anchors this project did not choose, across nine decades: 5772 K → 1.844e9 cd/m² vs a measured solar disc of ~2.0e9; 2800 K → 1.657e7 vs a tabulated tungsten filament of 5e6–2e7; 1000 K → 2.71, where "dull red heat" is conventionally placed.** ⚠⚠ **The steepest knob in the project:** visible-band blackbody luminance is NOT ∝T⁴ — the Planck peak sweeps *into* the photopic band, so it runs **~T¹² near 1500 K** (1200 K → 1.4e2, 1600 K → 2.1e4, 2500 K → 5.6e6). A ±200 K guess about a glow is a ±10× guess about its brightness. Gate `__lum.emissives()` | [`emissivePhotometry.ts`](../src/components/space/emissivePhotometry.ts) | **11 emissives, 0 units → 11 units** | ✅ |
| D26f | 🔑 **WHY SPRITES CANNOT BE DERIVED AND MESHES CAN — the distinction that keeps this honest.** A `MeshStandardMaterial.emissive` on real geometry IS that surface's radiance: no fill factor, derivation complete. A **SPRITE** is a billboard standing in for something SMALLER than itself, so its radiance is `L_emitter · (A_emitter/A_sprite)` — and the fill factor depends on a physical size the sprite does not know. MEASURED consequence: claiming a temperature for the mining impact glow would assert fill = 1 and land **1,800× hot** (a 2500 K melt pool is 5.07e6 cd/m² against the authored 2,810). Same reasoning as `STELLAR_POINT_PROFILE_INTEGRAL` and `uPsfNorm` — a sub-resolution source conserves **FLUX, not radiance**. ⇒ meshes are `kind: "thermal"`, sprites are `kind: "design"`. 🔑🔑 **AND RUNNING IT BACKWARDS IS THE PAYOFF:** the mining glow's effective emitting area is `2πR²·∫a(u)u du·opacity` = **18.2 m²** (the alpha gradient concentrates the light 8.5× versus the naive πR² = 154 m²), so at 4,684 cd/m² it emits **8.54e4 cd** — which is a real ablation spot **6.3 cm across at 3000 K**, or 14.6 cm at 2500 K. Both plausible mining-laser footprints, so the authored value was already physically right; it just never said so. Three more rows came out the same way, which is the real content of D26e's verdict. ⚠ **CORRECTED:** the first version of this row said "33 cm at 2500 K", from a radiance-RATIO shortcut (`authored / L_melt = (r/R)²`) that ignored both the alpha gradient and the 0.6 opacity. **Compare FLUX, never radiance, when the two areas differ** — exactly the discipline `STELLAR_POINT_PROFILE_INTEGRAL` exists to enforce, cited two lines earlier in this very row and then not applied. | — | 1,800× error avoided | ✅ |
| D26g | 🐛 **FOUR LIVE BUGS FOUND BY DOING THE CALIBRATION — none of them about brightness.** (1) **Four VFX materials were never registered for pre-exposure** (`DebrisEffect` ×2, `FlashEffect`, `WreckCollector`), so they darkened by the full pre-exposure factor as the scene darkened — the D25 signature, flagged as "still unregistered" in this doc since 2026-08-18. (2) ⚠⚠ **The registry could only scale `color`, which is an ENERGY BUG on a lit material**: `MeshStandardMaterial.color` is REFLECTANCE and the light already carries pre-exposure, so scaling it would apply the factor twice to the reflected term and not at all to the emitted one. Now auto-targets `emissive` when the property exists — the same discriminator three.js uses to decide whether the emissive term is in the shader, so the two cannot disagree. (3) 🐛 **`MiningSystem` registered inside a `useMemo` and dropped the disposer**, on a memo with seven dependencies — the registry grew for the whole session and kept writing to disposed materials. The registry's own doc warned about exactly this. (4) ⚠⚠ **NO HALF-FLOAT CLAMP.** `rt` is RGBA16F and pre-exposure reaches `1/(1.2·2^EV_MIN)` ≈ **2.2e5** when dark-adapted, so any emissive above ~0.3 game units overflows to Inf → NaN through the bloom chain during the 0.25 s `TAU_BRIGHTEN` transient — which is exactly when VFX fire in the dark. Now clamped to `HALF_FLOAT_WRITE_MAX` **after** the multiply, as `Star.tsx` does for the sun disc (an absolute cap applied *before* a scale is not a cap). | [`preExposedEmissive.ts`](../src/components/space/preExposedEmissive.ts), [`MiningSystem.tsx`](../src/components/Mining/MiningSystem.tsx) | 4 D25 sites + a NaN hazard | ✅ |
| D26h | ⚠⚠ **A HIDDEN 6.79× MULTIPLIER IN THE EXHAUST'S LIGHT, and a derivation that landed on the authored value.** `LIGHT_COLOR = Color(5.0, 7.0, 10.0)` sat beside `LIGHT_INTENSITY = 2.0`; three.js computes `color × intensity`, so a colour whose channels exceed 1 is an **undeclared second intensity** — Rec709 luminance of (5,7,10) is **6.79**, making the real intensity 13.6 while the constant next to it said 2.0. Same class as `STAR_COLOR_LINEAR`'s normalisation note and D09d's per-channel clamp: an un-normalised colour silently rescales whatever it multiplies and the visible number stops meaning anything. **Fixed** by normalising the colour to luminance 1. ✅ **And `LIGHT_INTENSITY` is now DERIVED** — this file had flagged it as "an uncalibrated eyeball value… not derived from PLUME_HDR × the plume's solid angle". `E = L·Ω` and a `decay = 2` point light gives `E = I/d²`, so `I = L·Ω·d² = PLUME_HDR · r · PLUME_MAX_LENGTH` — **the d² cancels**, so no reference distance and no per-ship tuning is needed (the inverse-square law and the solid-angle law being the same law). 🔑 At the nominal r = 0.3 that is **14.4** against the authored effective **13.6 — agreement to 6%**, a real independent check because the authored side had to be computed *through* the hidden multiplier to even be comparable. Nobody had noticed it was already right. ⚠ Now per-nozzle, since Ω scales with nozzle radius — the property that survives a ship refit, which a constant could not. | [`EngineExhaust.tsx`](../src/components/VFX/EngineExhaust.tsx) | hidden 6.79× | ✅ |
| D26i | 🔑 **THE WRECK'S EMISSIVE DERIVES TO ZERO, AND THAT IS THE RESULT.** `WRECK_MAT.emissive = (0.08, 0.08, 0.1) × 0.4` = **197 cd/m²** of hull self-emission. A wrecked hull holding 600 K of residual heat emits **6.0e-7 cd/m²** — 3.3e8× less — and there is **no temperature that glows visibly without also being visibly molten** (1000 K, the threshold of "dull red heat", is 2.7 cd/m² and still invisible on screen). ⇒ the authored value was not a dim glow, it was **ambient light smuggled in as emission**, which is the D26 defect in its purest form. Set to 0. ⚠ A cold object in space is lit by the sun and the sky, and both are now real (`SunLight` distance-correct per Phase 3a; sky an SH probe over the star catalogue per D29). If wrecks become hard to FIND, that is the navigation-marker system's job — do not put the glow back. Same reasoning retired `DebrisEffect`'s "slightly emissive so it reads in dark space" comment: 1200 K of shock heating is a real mechanism and gives 126 cd/m² (2.6× *below* the authored 325), so the glow survives on physics rather than on need. | [`WreckCollector.tsx`](../src/components/WreckCollector.tsx) | 197 → 0 cd/m² | ✅ |
| D26j | ⚠ **THE MINING DEBRIS WAS BLUE, WHICH IS THERMALLY BACKWARDS** — `emissive: (0.1, 0.15, 0.25)`, comment "bluish from laser heat". Nothing at rock's melting point is blue; blue means >8,000 K. Laser spall leaves the melt front at ~1600 K, which is orange-red at 1.93e4 cd/m². 🔑 **This is the one entry whose magnitude genuinely moved: 531 → 19,320 cd/m² (36×).** It is the only VFX in the set where the physics is fully determined (real mesh geometry ⇒ no fill factor) *and* the authored value was far off, so it is the one place to look first if the mining VFX now read too hot — and the knob is `debris_mined.tempK`, where 1400 K would give 3.9e3 and 1200 K 1.4e2. ⚠ NOT visually verified: `document.hidden` is permanently true in the Browser pane, so rAF never fires there and neither the effect nor `__lum.preExposure(8)` can be reached. Confirmation has to come from the user. | [`DebrisEffect.tsx`](../src/components/VFX/DebrisEffect.tsx) | 36× on one row | 🔶 |
| D28 | ✅ **REFRACTED LIMB LIGHT — the atmosphere as a LENS (2026-08-27).** A ship in an atmosphere-bearing planet's umbra was black; physically it is lit by **every sunset on that planet at once** — sunlight bent inward through the limb, reddened by the tangent path. [`refractedLimbLight.ts`](../src/components/space/refractedLimbLight.ts) derives it: deflection `ω(h) = (n−1)₀·e^(−h/H)·√(2πb/H)`, landing radius `r(h) = b − d·ω(h)`, and flux conservation limb-annulus → landing-annulus. Per channel, so the coppery colour falls out of the tangent optical depth (Earth at h=0: τ = 5.4/10.2/20.6 R/G/B) with nothing tinted by hand. New `AtmosphereParams.surfaceRefractivity`, derived from the composition already there — `rayleighRel` is *defined* as `((n−1)_g/(n−1)_air)²·(F_g/F_air)`, so `√rayleighRel` recovers it. ✅✅ **THREE INDEPENDENT CHECKS, none fitted:** grazing deflection **1.123°** vs the textbook 1.13° (= 2 × 34′ horizon refraction, since a grazing ray crosses twice); hull radiance at albedo 0.333 **0.116 cd/m²** vs the **0.11** this plan derived from eclipse *magnitudes* by a completely different route; and the one anchored constant lands at **~32% of the annulus clear** against Earth's actual **~33% clear-sky fraction**. ⚠ That constant (`CLEAR_ANNULUS_FRACTION`) is the only non-derived number and it names a specific omission — `AtmosphereParams` carries no cloud or boundary-layer aerosol, and the refracting band sits at h ≈ 1.7 km, inside the troposphere. Clear-sky the model runs ~3× hot without it. ⚠ Applied to every body, which is D28's weakest point: Venus is overcast everywhere (its umbra should be far darker than this gives) and Mars is nearly cloudless (~3× brighter). ⚠⚠ **GAS GIANTS ARE THE OTHER LIMIT:** `groundRadiusKm` is the 1-bar level, not a surface, so the model truncates the refracting column where the atmosphere is still getting denser — it under-bends, and the "surface" reference is physically arbitrary there. ✅ **What DOES generalise correctly, with no per-body tuning:** refractivity (from gas composition), scale height (from mass/temperature/molar mass), Rayleigh/Mie/ozone extinction, ground radius, star distance, star luminosity and the star's angular size — all already derived by `deriveAtmosphere`, so a procedurally generated system gets a correct focal length and a correct colour for free. Gate `__lum.umbra()`. | [`refractedLimbLight.ts`](../src/components/space/refractedLimbLight.ts), [`SunLight.tsx`](../src/components/Star/SunLight.tsx) | eclipsed hull 0 → **0.116 cd/m²** | ✅ |
| D28b | 🔑🔑 **THE ATMOSPHERE IS A LENS WITH A FOCAL LENGTH, AND THAT OVERTURNS THIS PLAN'S OWN ASSUMPTION.** D28 said *"at 3 R⊕ the refracting ring subtends far more solid angle than at the Moon's 60 R⊕"*, implying close-in is brighter. **MEASURED: the opposite.** Surface-grazing rays only reach the shadow AXIS at `R/ω(0)` = **325,100 km = 51.0 R⊕** for Earth — so **the Moon at 60.3 R⊕ sits just past the focus of Earth's atmospheric lens, which is precisely why it is lit.** Closer in the light has not converged: it fills an annulus whose INNER edge sits near the umbra's rim and marches inward with depth (97% of the umbra radius at 2 R⊕, 92% at 5, 84% at 10, 67% at 20, 0% at 51), leaving the axis **completely dark**. ⇒ **The term is position-dependent in TWO coordinates, and a distance-only model would be wrong in the most common case.** ⚠ Precision on the picture, because my own first framing was sloppy: it is an ANNULUS, not a thin ring — brighter and less red toward the rim, where rays grazed high through thin air. The *inner edge* migrates; the *brightest point* stays at the rim. | — | axis dark below 51 R⊕ | ✅ |
| D28d | 🐛🐛 **PRE-EXPOSURE APPLIED TWICE — SHIPPED, CAUGHT ON DEVICE, AND IT IS THE D09c TRAP AGAIN.** `AtmosphereBodyRecord.sunIlluminance` is `illum × getPreExposure() × starTint` (D25). I passed it into the model AND multiplied the result by `preExp` in `SunLight`, so the rendered light was wrong by **p²** — 10⁴–10⁶× in a dark scene. **Symptom: a blazing red hull** where a coppery hint belonged, and a `__lum.umbra()` ladder whose values moved with where the ship was standing (the 2.0 R row read **972,000 / 1,110,000 / 272,000 / 66,200 / 48,500 lux** from five vantage points, for a table that is a pure function of `d`). 🔑 **A diagnostic that varies with the observer is reporting the observer, not the thing** — that is what exposed it. ⚠⚠ **D09c is this exact field, this exact mistake**, logged in this document, and I had read that row earlier the same day. ⇒ **`sunIlluminance` on that record is PRE-EXPOSED; anything on the CPU wanting absolute game units must recompute from `starDistanceKm`.** Fixed in both `SunLight` and the gate via `sunIlluminanceAt(starDistanceKm, starLuminositySun) × STAR_COLOR_LINEAR`. After the fix, the five live positions read **0 / 0 / 0.554 / 6.48 / 0.0525 lux** against the 1.1 lux eclipse reference. | [`SunLight.tsx`](../src/components/Star/SunLight.tsx), [`lumHarness.ts`](../src/components/space/perf/lumHarness.ts) | **p² ≈ 10⁴–10⁶×** | ✅ |
| D28e | 🔑 **NOT A BUG — on-axis brightness RISES past the focus, because the umbra NARROWS.** Measured on axis: 0.225 lux at 325,000 km → 1.10 at 384,400 → 2.77 at 500,000 → 4.82 at 800,000 → 5.32 at 1,350,000. That looks unphysical and is not: the same refracted flux lands inside an umbra whose radius shrinks toward the tip (4,530 km at the Moon → 2,649 km at 800,000 km, an area ratio of 2.92 against a measured brightness ratio of 4.4, the remainder being that a more distant observer is fed by rays grazing HIGHER through cleaner air). ⚠ Earth's umbra ends at 1.369 M km, so the tip is a second caustic and the model does not regularise it — expect a spike within a few thousand km of the tip. ⚠ Also: at 1.35 M km the umbra is only **86 km** wide, so a ship at 15,002 km off-axis is not in shadow at all; the `1 − sunTransmittance` ramp is what suppresses the term there, not the model. | — | tip caustic unregularised | 🔶 |
| D34 | ✅ **BODY-ON-BODY ECLIPSES, BOTH DIRECTIONS, EVERY BODY (2026-08-27).** Was: `CelestialBody` set `uSunIlluminance` from the body's own star distance and **never called `sunVisibility()`** — it REGISTERED as an occluder (D27, so the ship gets shadowed) but never asked whether anything shadowed IT. ⇒ **Luna rendered at FULL SUNLIGHT inside Earth's umbra — no lunar eclipse existed at all**, which is worse than "an eclipsed Moon is black". And the one eclipse that did work was hardcoded: `earth.ts` carried `uMoonPos`/`uMoonRadius`, so Earth could only ever be eclipsed by Luna. 🔑🔑 **THE FIX IS A PROMOTION, NOT NEW PHYSICS — the maths already existed TWICE**: `sunOcclusion.ts`'s `discCoveredFraction` (CPU, for the ship) and `earth.ts`'s `eclipseFn` (TSL, per-pixel, which drew Earth's solar-eclipse shadow). Lifted into [`bodyEclipse.ts`](../src/components/celestial/bodyEclipse.ts), driven by the occluder registry that already holds every body's absolute km centre. 🔑 **ONE function covers both directions BECAUSE IT IS PER-PIXEL:** occluder shadow ≫ body ⇒ every pixel dark ⇒ lunar eclipse, with a correct penumbra gradient across a PARTIAL one that a per-body-centre test cannot give; shadow ≪ body ⇒ only pixels in the spot darken ⇒ solar eclipse with real umbra and penumbra. ⚠ Far/point tiers are a few px across, so there the same maths runs once at the body centre on the CPU (`updateEclipseUniforms` returns it) — and it *has* to, because `positionLocal` on a billboard is a QUAD, not a sphere. **Earth keeps its own richer path** (`ownEclipse: true`) since its coverage feeds `sunVis`, which also switches city lights on inside a total eclipse and gates the ocean specular — but it now consumes the SAME shared occluders, so its Luna hardcoding is gone. Gate `__lum.eclipses()`. | [`bodyEclipse.ts`](../src/components/celestial/bodyEclipse.ts), [`CelestialBody.tsx`](../src/components/celestial/CelestialBody.tsx), [`earth.ts`](../src/components/celestial/bodies/earth.ts) | **lunar eclipse 0 → correct** | ✅ |
| D34b | 🐛 **I DROPPED THE ANNULAR BRANCH WHILE PROMOTING THE FUNCTION, and `tsc` could not care.** The original `eclipseFn` had four cases; my port kept three, losing `angleBetween ≤ angleLight − angleOcc ⇒ v = 1 − (angleOcc/angleLight)²` — the case where the occluder's disc sits ENTIRELY INSIDE the star's. ⇒ **a transiting moon smaller than the star would have read fully lit**, which is precisely the Io-across-Jupiter case D34 exists for. 🔑 That same branch is also what makes an UNUSED occluder slot correct: `angleOcc = 0` gives `r2 = 0` gives `v = 1`, so slots are encoded as `radius = 0` and evaluated **branchlessly** through the ordinary path — no `count` uniform, no divergence, no special case. ⚠ **Verify a promoted function case-by-case against the original, not by whether it compiles.** | [`bodyEclipse.ts`](../src/components/celestial/bodyEclipse.ts) | annular eclipses lost | ✅ |
| D34c | ⚠ **WHAT THIS DOES AND DOES NOT MODEL.** ✅ Exact for spherical bodies against a uniform stellar disc — umbra, penumbra and annular all fall out of one closed form. ✅ **Generalises for free**: nothing is hardcoded, the registry is populated by whatever bodies exist, so added moons and procedurally generated systems work with no per-body data. Cost: CPU one registry pass per body per frame (~170 iterations for Sol's 13 bodies); GPU `MAX_ECLIPSE_OCCLUDERS = 4` unrolled at ~15 ALU each, branchless. ❌ **NOT modelled:** the star's limb darkening (would slightly deepen the penumbra gradient), non-spherical bodies, and — the important one — **the occluder's atmosphere refracting light into its own umbra, so an eclipsed body still goes BLACK rather than coppery.** That is D28, which currently reaches the SHIP only; feeding it into a body's shader is the remaining step. ⚠ Occluders combine multiplicatively: exact unless two overlap ON the star's disc, and the error there is conservative (slightly too dark) — same choice `sunOcclusion.ts` documents. | — | eclipsed bodies black, not coppery | 🔶 |
| D28c | 🐛 **TWO BUGS IN MY OWN IMPLEMENTATION, both caught before shipping.** (1) ⚠⚠ **FRAME MIXING.** `AtmosphereBodyRecord.centerScaled` is SCALED-WORLD while `worldOrigin.shipPosKm` is km; subtracting them yields a vector with the right direction and a meaningless magnitude. The shortcut I reached for instead — dotting the ship→sun direction against the planet→sun direction — is ≈1 for *any* ship near the planet (both point at the same distant star), so it reported **"on the shadow axis" always**, which by D28b is the one answer that is wrong close in. Fixed with a new `sunOccluderCenterKm()`: the occluder registry already holds every body's ABSOLUTE km centre, registered unconditionally each frame. 🔑 *When two records live in different frames, add the getter rather than the subtraction.* (2) **A UNIFORM SCAN WAS THE WRONG INTEGRATOR.** The contributing band is a few km wide (`2·smear/|dr/dh|`, and `|dr/dh|` runs to ~800), so 64 samples over 110 km put ~3 inside it — and *which* samples land inside is quantised, so the light would have **flickered as the ship moved**. `r(h)` is monotonically increasing (b grows, ω decays), so it has exactly one root per level: replaced with bisection + the closed form, which is exact and cheaper. 🔑 *A flickering light is worse than a wrong one; check the integrator against the width of the thing being integrated.* | [`SunLight.tsx`](../src/components/Star/SunLight.tsx), [`refractedLimbLight.ts`](../src/components/space/refractedLimbLight.ts) | 2 pre-ship bugs | ✅ |
| D29 | ✅ **The skybox was not a light source** — integrated starlight never reached the hull | [`skyIrradiance.ts`](../src/components/space/skyIrradiance.ts), [`SkyLight.tsx`](../src/components/Star/SkyLight.tsx) | CLOSED: SH-L2 probe from panorama + catalogue. Panorama projected off a 64×32 render, **stars summed analytically** (exact for delta sources). Gate `__lum.skyProbe()` asserts πL, 17/16, 1/16, −19/480. ⚠ diffuse only — specular is S4b; no occlusion. See STAR_CATALOGUE_PLAN §8.9 | ✅ |
| D30 | ✅ **Stars were 6.7 magnitudes / 482× too dim** — the panorama is an LDR asset asked to carry 17 stops | `MilkyWaySkybox.tsx`, unmounted `StarsComponent.tsx` | CLOSED: 8,920-star catalogue, flux validated to **0.999×** on 3 named stars. See STAR_CATALOGUE_PLAN §8.3 | ✅ |
| D31 | ✅ Metering **point-sampled** one tap per tile → the sun was never metered, and the reading depended on display resolution | [`exposureMeter.ts`](../src/components/space/exposureMeter.ts) | fixed with stratified tile averaging; resolution drift 1 stop → **0.03** | ✅ |
| D32 | ✅ **The Milky Way panorama was MIRRORED** — the NASA asset is a sky *chart* (RA 0h centred, RA increasing **leftward**), not a globe texture, so the textbook `u = RA/2π` renders the sky reflected | [`MilkyWaySkybox.tsx`](../src/components/Skybox/MilkyWaySkybox.tsx) | CLOSED: `u = fract(0.5 − RA/2π)`. Measured `det(R) = −1.00000`; whole-image rms galactic latitude **37.7° → 9.69°**; Big Dipper stars now read **71×** dimmer than band stars. Gate: `__lum.skyAlign()` — whose own v1 metric produced a false ❌ on the fixed sky, see §8.6 | ✅ |
| D33 | ⚠⚠ **Exposure is a function of how much of the SCREEN a body fills, not of its light.** MEASURED on Uranus at 100/200/400 kkm: the disc's own radiance is invariant (**57.3 / 57.7 / 55.3 cd/m²**, and `probe` reads 48.7) while `metered EV` swings **3.38 stops** (−6.95 → −10.33) and the disc renders at **0.93 / 3.08 / 6.85** display-linear — i.e. **+2.54 / +4.26 / +5.42 stops** over the coverage-100% reference of 0.160 (which is middle grey, so the *calibration* is right). 🔑 CLOSED FORM: a frame-average flux mean returns `metered ≈ coverage · L_disc`, so rendered brightness ∝ `coverage^(−ADAPTATION_K)` ⇒ **+1.70 stops per 4× coverage drop, measured +1.72.** ⚠ NOT tunable — any global frame mean is proportional to coverage by definition; §5.9's log-average and percentile-band attempts fail the same way in different guises. Needs a coverage-independent estimator or **local exposure** (UE5.1). Explains the whole washout thread, why Uranus looked fine (the user was close), and D26's plume (same pathology, opposite sign). Gate `__lum.meter()` | [`exposureMeter.ts`](../src/components/space/exposureMeter.ts) | **2.5–5.4 stops** | R |
| D33b | ⚠ **The hot-tail cap suppresses legitimately bright SMALL subjects.** `HOT_WEIGHT_FRACTION = 0.02` / `MAX_HOT_FLUX_SHARE = 0.3` were chosen on the premise that a real subject covers ≥10% of frame; below ~4% **the subject IS the tail.** MEASURED (`__lum.meter`, p=2 estimator where coverage is otherwise neutralised): metered sits a flat **−0.32 stops** under the disc's own EV while the tail is at 4–23%, then **−0.71 / −1.60 / −2.37 / −2.97** as it crosses the 30% cap at 47–66%. Predicted vs measured over-exposure agrees to **0.03–0.06 stops at all seven stops** ⇒ the residual is 100% the cap. ⚠⚠ **NOT independently fixable**: the cap is also the only restraint on a bright dot owning adaptation, and it cannot separate the two cases because both are "small and bright" — size is the wrong discriminator, which is D33's own finding. Resolved only by local exposure. | [`exposureMeter.ts`](../src/components/space/exposureMeter.ts) | **up to 3.0 stops** | R |
| D33c | ⚠⚠ **REVERTED — `ESTIMATOR = "area"` (original p=1), local exposure OFF.** Both fixes worked as specified and both made the game worse. **Error 1: the eye has TWO adaptation terms and D33's law belongs to the LOCAL one.** Global adaptation (pupil + photochemical) IS the field average = p=1. Falsifying case: Luna at 377,000 km subtends 0.53° and "pooled" blacked out the frame — but the real full moon is ~3,000 cd/m² at 0.52° and does not hide the stars, because it adds 3,000·(0.5/200)² ≈ 0.02 cd/m² to the field average. **Letting a small bright object clip is CORRECT.** **Error 2: over-fitted the gate's ladder** — the 5.4-stop spread lives at 0.166% coverage (a 91 px dot = the Luna case); at the ~40% coverage the complaint actually lived at it is ~1 stop. ⇒ **the washout was mostly the TONE CURVE POSITION** (0.59 display-linear at the old +2.5 bias is inside AgX's shoulder, and a planet disc is a ~20%-contrast subject). "pooled" also STEPS: its 2-stop window is a hard membership test, so cells entering/leaving move the mean discontinuously. 🐛 Gate bug fixed alongside: `__lum.meter` snapped the follower to a STALE async readback and reported ×254.8 where the converged value is ×32 — a 3-stop error, whole run a transient. **Next: D09 first** (Luna 10× hot, 14.6× spread ⇒ up to 2.4 stops of per-body mis-exposure before the meter runs), then a simulation-driven adaptation target. | [`exposureMeter.ts`](../src/components/space/exposureMeter.ts) | ~1 stop, not 5.4 | R |

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
| **2c** ✅ | Albedo-authoritative texture calibration (§3.0, D09 + **D23**) | **D09** closed (runtime albedo calibration), **D09e** closed hue from measured band spectra, **D23** closed (ocean diffuse = physical water-leaving). ⚠ The "ocean 21–43×" premise was a visible-vs-broadband units error in the original measurement — see D23. Remaining under 2c: **D09f**, Io/Luna/Galileans still on one colour degree of freedom | medium |
| **2d** ✅ | `CLOUD_SUN_SCALE` → `albedo/π` = 0.223 **+ `SHELL_OPTICAL_PATH` 1 → 60 (a units error, not a fit) + erosion-area factor 0.5** | cloud cover 3.5% → **21.9%** measured (user chose 0.5 over 0.3 for edge detail); see §5.7 | medium |
| **3a** ✅ | **Distance-correct sun for ship + asteroids** — `SunLight.intensity` and the bounce fill from live star distance via the SAME `sunIlluminanceAt` the planets use | ship/asteroids stop being lit by a constant: 4.7× brighter at Mercury, 1,280× dimmer at Neptune | medium |
| **3b** ✅ | `CORE_HDR` 4096 → **`SUN_DISC_RADIANCE_GAME` ≈ 265,000** (derived, distance-independent) + `HALF_FLOAT_WRITE_MAX` clamp + **sub-pixel flux conservation**; star radius and **blackbody T_eff colour** from the system description | the sun disc becomes physically bright; steady (not strobing) in the outer system | medium |
| **4** ✅ | **CLOSED, measured 0.29 stops worst / 0.32 stops worst jump.** Unified impostor radiance across all three LOD tiers; lunar-Lambert phase; delete `REFERENCE_HDR`/`JUPITER_REF_FLUX`/`fade`/the `500` clamp/`mars.ts:109`'s `12.0`; PSF splat for sub-pixel bodies | Moon, Venus and Mars finally read correctly | medium |
| **5** ✅ | **Auto-exposure / eye adaptation**: centre-weighted log-average metering, **PARTIAL** adaptation (Stevens' ⅓), asymmetric cone/rod time constants, + the **skybox rescaled to absolute luminance** (measured 189,000× hot) | the "eye" arrives; stars become visible in deep space and vanish when the sun enters frame | medium |
| **6** ⛔ | **HDR display output + calibration screen; P3 path.** Validate on the M2 Pro XDR panel | HDR displays gain real headroom | low |
| **7** ⛔ | Scotopic/mesopic vision model + Purkinje shift (§3.9b); fix the skybox's absolute luminance | deep space becomes night-vision quiet, not underexposed daylight | low |
| **8** ⛔ | PSF glare replacing mip-chain bloom, energy-conserving, driven by the star-flux uniform | the sun becomes blinding; stars veil correctly | medium |
| **9** ⛔ | Night-side stack: city lights at absolute luminance, moonlight, airglow, aurora | night side becomes quietly alive | low |

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

  ⚠⚠ **THE PARAGRAPH ABOVE IS WRONG AND IS KEPT ONLY TO SHOW HOW. Re-measured 2026-08-26 — see the
  D23/D23b rows in §1.3.** The texture values are right; the *comparison* was not. Each one is a
  visible-band, luminance-weighted reflectance being checked against a **broadband albedo** that is
  mostly NIR for water and chlorophyll. 🔑 **The tell was in the result and I read past it: the two
  regions that "passed" are sand and snow — the two with flat spectra.** Correct per-pixel figures:
  deep ocean is **4.0×** dark and **3.0×** too red; the global mean was already **0.993×** of an
  independent target. ⚠ And acting on the broadband ocean number would have double-counted the
  specular sky reflection the very next bullet had just finished removing.

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

🔁 **This recurred as D32** (2026-08-20), in the same shape and with the same misdirection: the Milky Way panorama was reflected, `det = −1`, and *three* attempted fixes were rotations — which cannot undo a reflection. The generalised lesson is in STAR_CATALOGUE_PLAN §8.6, and the sharpest part is new: **a check that verifies your formula against a *definition* proves nothing when the unknown is an *asset's* convention.** What broke it open was cross-checking two independently-sourced things in one frame — catalogue geometry against panorama texels.

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
  ⚠⚠ **THE "last 1.5× is Phase 2c" PART IS RETRACTED (2026-08-26).** The day map's mean was already
  **0.993×** of an independent cloud-free surface albedo, and the D23 fix moves it to **1.034×** — so
  Phase 2c never held a 1.5× on the surface. The gap between 0.044 and ~0.12 for *clear sky* is
  **Rayleigh scattering**, which the atmosphere pass owns, not the surface texture. See D23b.
- **`p98/p02` contrast is not usable while D23 is open** — our clear-sky floor is 1.8× too dark, so
  the correct target is **11.4×, not 8.7×**. The measured 10.8× is right, not an overshoot.
  ⚠ **Also retired** — that correction assumed a *uniform* 1.8× clear-sky deficit, and the deficit is
  neither uniform (ocean 4.0×, land 1.0×) nor 1.8×. Use 8.7×.
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

### ✅ D25 — source pre-exposure (CLOSED 2026-08-18)

**A static rescale cannot work, and that is worth proving before reaching for one.** The scene spans
44.6 stops; RGBA16F holds ~40 (subnormal 5.96e-8 → below that a value stores as *exactly* zero; max
65,504). Putting the sky safely into the normals needs ×1e5, which sends sunlit Mercury (6 units) to
6e5 and over the ceiling. So the two ends cannot be seated at once by any fixed factor — the fix has
to move with the scene, which is exactly Frostbite's/UE's pre-exposure (§3.2).

#### Why multiplying the LIGHT SOURCES is equivalent — and much safer

The render is **linear in its light sources**, so scaling every source scales the image; there is no
need to find every shader that writes radiance. The seams are the places an absolute photometric value
*enters*, which is already the "one authority" list Phases 2a/3 funnelled everything through:

| # | site | covers |
|---|------|--------|
| 1 | `CelestialBody`'s `uSunIlluminance` | every lit planet/moon surface |
| 2 | `setAtmosphereBody`'s `rec.sunIlluminance` | atmosphere march, cloud shell, volumetric marcher |
| 3 | `SunLight`'s key + fill intensity | the whole local scene (ship, asteroids) |
| 4 | `computeAtmosphereLighting`'s `skyIntensity` | `AtmosphereSkyLight`'s hemisphere fill |
| 5 | `MilkyWaySkybox`'s `material.color` | the panorama — **the site D25 is about** |
| 6 | `Star.tsx`'s `uCoreRadiance` | the sun disc — the site the *ceiling* bit |

Five of the six are CPU-side per-frame writes, so this is mostly JS multiplies, not shader surgery.
(#5 is a `MeshBasicMaterial` colour, set once at material creation, so it had to become a `useFrame`.)

⚠ **Linearity is the whole licence, so every NON-linear op on radiance had to be audited.** Checked
and cleared: the atmosphere's spectral-transmittance `powVec3` operates on a *transmittance* (and the
AP target keeps radiance in rgb, mean transmittance in alpha, so `scene·a + rgb` stays uniformly
pre-exposed), the Henyey-Greenstein denominator is dimensionless, and the ship cloud-shadow gamma is
applied to a transmittance. None is radiance.

#### Three consumers MUST divide it back out

1. **The exposure meter** — it reads the pre-exposed buffer, so without the divide-out it meters its
   own output and the loop (brighter reading → more exposure → brighter reading) diverges to `EV_MAX`.
   The downsample stores `log2(luma·8)`, so pre-exposure is a pure **offset** and removal is one
   subtraction. Captured at *submit* time, not in the async callback, which would belong to a later
   frame.
2. **`__lum`** — done in `decodeRgb`, the single chokepoint all of probe/probeMax/disc route through.
   Without it every absolute number in this document would silently become a reading of the exposure
   follower instead of the scene.
3. **Temporal history** — the cloud reconstruction blends last frame's output, written at the
   *previous* pre-exposure. `uPreExposureRatio` rescales it on read. Skipping this would not look like
   a scale error: the YCoCg variance clamp would see legitimate history as divergent and reject it, so
   the TAA would quietly stop converging exactly while the eye is adapting.

`uPostExposure = exposure / preExposure` is what the post chain multiplies by — not `exposure`, and
not 1. It is ~1.0 in the steady state, but the meter updates `_exposure` *after* the scaled scene has
been rendered, so this carries that late change onto an already-written frame instead of dropping it.

#### Validation — an invariance test, not an enumeration

`__lum.preExposure(f)` pins an arbitrary factor. The design rests on one invariant: **the image must
not depend on the pre-exposure**, since the post chain divides out exactly what the sources multiplied
in. So any site that was MISSED shows up immediately as a region moving by `f`. That is falsifiable,
which an enumeration of source sites is not.

Measured, same camera, dark-sky frame:

| probe | preExp ×1 | preExp ×10⁴ (divided back out) |
|-------|-----------|-------------------------------|
| (400,400) | `0, 0, 0` | `3.09e-8, 2.45e-8, 2.71e-8` |
| (400,250) | `0, 0, 0` | `2.71e-8, 2.19e-8, 1.81e-8` |
| (200,300) | `0, 0, 0` | `2.58e-8` (grey) |
| (640,120) | `0, 0, 0` | `2.32e-8, 1.81e-8, 2.06e-8` |

Exactly zero → correctly valued, and the channels now **differ**, which is real nebulosity colour
rather than a flat fill. 2.3e-8 × 6038 = **1.4e-4 cd/m²**, landing where `SKY_TARGET_NITS` (1e-4) and
the Milky Way band (1.25e-4) predict — so the divide-out preserves the absolute calibration. The image
was visually identical at ×1 and ×10⁴.

**End-to-end with the follower driving it** (`preExposure = exposure`, no override): Earth correctly
exposed with cloud structure, ship lit, stars visible, and the meter *stable* — metered 1.25 → target
1.76 → follower 5.3, with exposure 0.12 reconciling to EV 5.3 exactly once the +2.5-stop output bias is
applied. At `preExposure ≈ 6e-6`, a source that had been missed would render ~10⁵× off — pure black or
blown white — so "everything looks right" is a strong completeness check here, not a weak one.

⚠ **Values far below what the current exposure can display still underflow, and that is correct.**
With Earth in frame the exposure is small, so the sky underflows again — but it would display as black
either way. Pre-exposure spends half-float precision where the exposure says the eye is looking; it
does not widen the buffer.

#### What the invariance test then found — and the two results that are NOT bugs

Run by the user with the sun and the night side in frame. Six things moved, and they split three ways —
which is the point of a test that *localises* rather than one that just passes or fails.

**(a) Four genuinely missing multiplies.** All darkened by exactly the 8× the test predicts for a
source that never got pre-exposed (raw value unchanged, post chain still divides by 8):

| site | fix |
|------|-----|
| Earth's night-side city lights | `nightEmissive.mul(uPreExposure)` — held out of `col` on purpose, so the × sunIlluminance/π conversion that pre-exposes every reflective term never touched them |
| distant bodies, billboard tier | `useFarLOD`'s `albedo × sunDot` × `uPreExposure` |
| distant bodies, stellar-point tier | `StellarPoint`'s `uBrightness` × `getPreExposure()` |
| engine exhaust + mining laser | `uIntensity` × `getPreExposure()`; the laser via a registry (below) |

🔑 **Pre-exposure and CALIBRATION are orthogonal, and conflating them would have stalled this.** The
billboard is `albedo × sunDot` with no illuminance at all (still **D04**) and the stellar point is
normalised to an arbitrary Jupiter reference (still **D06**). Multiplying an arbitrary-scale value by
the pre-exposure makes it scale-INVARIANT while leaving it exactly as mis-calibrated as it was. That is
the correct separation: D25 owns invariance, D04/D06 own the absolute level.

Plain (non-TSL) emissive materials needed [`preExposedEmissive.ts`](../src/components/space/preExposedEmissive.ts)
rather than an inline multiply. A `MeshBasicMaterial`'s `color` is a CPU value, so pre-exposing it means
**rewriting** it each frame — and rewriting in place destroys the base, so frame two would compound
(base × p × p × …). The registry keeps each material's authored colour and always writes `base × p`.
It also stops the next VFX site added from silently breaking invariance, which would surface as "this
effect darkens as the scene brightens" — miserable to debug from the symptom.

**(b) ⚠ The sun getting darker is the `HALF_FLOAT_WRITE_MAX` clamp, not a missing multiply.**
`SUN_DISC_RADIANCE_GAME` is 265,000, so at preExposure 8 the write is 2.12e6 → clamped to 60,000, and
the post chain then divides by 8 → exactly the 8× dimming observed. **An absolute clamp cannot be
invariant to a scale applied before it**, by construction.

In real play this is nearly inert, which is the whole point of pre-exposure: with `preExposure =
exposure`, the clamp binds only when 265,000 × exposure > 60,000, i.e. exposure > 0.226 → below EV
≈1.9. So it can only bite in the ~0.25 s `TAU_BRIGHTEN` transient after swinging toward the sun from
deep space, and there it *limits* a blowout rather than causing one. Left as a guard against `Inf`, no
longer the mechanism. (`StellarPoint`'s 500 clamp is the same hazard and was fixed properly — the clamp
is applied INSIDE the pre-exposure, so the cap stays absolute.)

**(c) ⚠ Background stars getting BRIGHTER is D25 working, not a double-multiply.** The skybox is
pre-exposed exactly once. What changes is that the panorama's FAINT star texels sit below the half-float
floor at preExposure 1 and emerge above it at 8 — so more stars appear, which reads as "brighter". The
direct evidence is already in the table above: four "empty sky" points all read exactly `0`, so
sub-floor content exists everywhere in the panorama, not just in the diffuse band.

✅ **All registered as of 2026-08-26** (D26g). `DebrisEffect` (×2 materials), `FlashEffect`,
`WreckCollector` and `MiningSystem`'s five sprites are on the registry; `AsteroidVFX` turned out to own
no materials at all — it is a pure event manager, and the emissives are in the `DebrisEffect` /
`FlashEffect` it mounts. ⚠ It was NOT "the same one-line registry call": the registry could only scale
`color`, which on a lit material is REFLECTANCE, so `DebrisEffect` and `WreckCollector` needed the
channel auto-detection first. See D26g for that and for the three other bugs the work turned up.

### ⛔ D26 — re-diagnosed 2026-08-18: it is an EMISSIVE CALIBRATION defect, not a metering defect

**A metering exclusion was implemented and REVERTED.** Recording it because the negative result is worth
more than the code was.

**The attempt:** put the player's vehicle on its own layer, split the local pass in two (world, then
vehicle), and meter between them so adaptation never sees the ship.

**Failure 1 — ⚠⚠ THREE.JS LAYERS GATE LIGHT↔OBJECT INTERACTION, not just visibility.** A light
illuminates an object only if `light.layers.test(object.layers)`. Moving the vehicle to its own layer
while `SunLight`'s key and fill stayed on the world layer left the hull lit by *nothing but its own
emissive* — black in full sun. Enabling both layers on every light fixes that specific bug, but see
failure 3.

**Failure 2 — the exclusion did not solve the problem, it MOVED it.** With the ship out of the meter,
adaptation stopped collapsing… and the exhaust went fully blown instead. Which is the real finding:
**excluding the plume from metering revealed that the plume's value is radiometrically absurd.**
`uIntensity` reaches 1.0 game units = **6,038 cd/m²** — brighter than a sunlit cloud top — because it
was chosen to look right against a *fixed* exposure of 30. It was never a luminance.

**Failure 3 — `layers.set()` mutates persistent `Object3D` state, so reverting the code did not revert
the scene.** The stamped objects kept layer 1 and stayed invisible until a full page reload. Anything
that writes to live scene-graph state needs an explicit undo path, not just a code revert.

#### 🔑 The re-diagnosis: my own instrument had already said this

`_lastTopFluxShare` ships with the comment *">~50% means a small hot feature is driving adaptation —
usually an emissive that is not on the photometric scale."* That is exactly the situation, and I built a
metering exclusion instead of reading it. **The estimator is also implicated:** the shipped metering is a
**weighted mean of LINEAR radiance**, which is maximally sensitive to a single hot pixel. That choice was
right for the "eye, not camera" premise — but it makes one small blown emissive able to set the whole
frame's exposure, which a real eye does *not* let a small peripheral source do.

#### How shipped AAA games actually handle this

| technique | who | notes |
|---|---|---|
| **Emissives authored in real luminance units** | UE5, Frostbite | the first line of defence, and the root fix here. UE documents that implausible emissive values break auto-exposure |
| **Exposure metering MASK** (screen-space weight texture) | UE5 | down-weights, does not exclude — and crucially never touches how the scene is RENDERED, so it cannot break lighting the way a layer split does |
| **Local Exposure** (bilateral log-luminance base/detail split) | UE5.1+ | shipped precisely because one global exposure cannot hold a bright emissive plus a dark world |
| **Percentile / histogram metering** rather than a mean | UE, most engines | a hot 1% cannot drag the reading |
| **Tone curve with a long shoulder** + bloom | ACES, AgX | a blown plume reads as "very bright" instead of clipping the frame |

#### ✅ Step 2 shipped — the HOT-TAIL CAP (2026-08-18)

Taken FIRST, ahead of calibration, because it bounds *any* small hot feature rather than the one we
happen to have found — including ones not yet built.

**🔑 The goal is a BOUND, not identification.** Being explicit about why no estimator can single out the
ship: the exhaust at 1.0 game units and Earth's sunlit disc at 0.43 are the same order of brightness and
can occupy the same small screen area. They are genuinely indistinguishable to a meter. So instead:
*no small part of the visual field may hold unlimited authority over adaptation.*

That is also the better model of the eye. Adaptation is spatially distributed and dominated by where you
foveate; a small bright source in the periphery does not fully reset your night vision — which a pure
flux mean says it should.

```
hot tail  = brightest HOT_WEIGHT_FRACTION (2%) of total sample WEIGHT
constraint: hot / (hot + rest) ≤ MAX_HOT_FLUX_SHARE (0.3)   →   hot ≤ S/(1−S) · rest
bound on the metered EV: log2(1/(1−S)) = 0.51 stops, vs ~unbounded for a raw flux mean
```

⚠ **The tail is defined by WEIGHT, not sample count.** The centre-weighted Gaussian makes a centre
sample worth ~50× an edge one, and the player's vehicle sits dead centre — exactly where a count-based
percentile would under-measure it.

⚠ **2% is chosen to sit BELOW the coverage of a legitimately bright subject** (Earth fills 10–20% of
frame at orbit, so its bulk stays in `rest` and meters normally) **and above that of a nozzle glow**.

**Measured, Earth at orbit with the exhaust lit:** the hot tail wanted **40%** of total flux, capped to
30%, moving the metered EV by **0.16 stops**; metered EV **1.24**, against a pre-D26 baseline of 1.25 in
the same view — so Earth still meters correctly while the plume no longer owns the frame. `EV max` 8.38
(41.6 game units ≈ 251,000 cd/m²) confirms the plume *is* the hot tail.

⚠ The diagnostic reports the **shift in the metered EV**, not `log2(hotFlux/hotCap)`. The latter is the
tail's own attenuation, reads considerably larger (0.65 vs 0.16 stops in the measurement above), and
would overstate the effect. First version of this table got that wrong.

#### Remaining plan, in order

1. ✅ **Calibrate the emissives** — exhaust, mining beam/muzzle, debris, flash, wreck — to real
   luminances. **DONE 2026-08-26**; see D26e–D26j and
   [`emissivePhotometry.ts`](../src/components/space/emissivePhotometry.ts).

   🔑🔑 **AND THE RESULT OVERTURNS THIS STEP'S OWN PREMISE.** The step was written expecting to find
   radiometrically absurd values. Measured, all eleven emissives sit between **197 and 4,748 cd/m²** —
   "bright fluorescent tube", entirely defensible. Exactly the conclusion the plume reached in 2026-08,
   now generalised to the whole set. **The magnitudes were never the defect; the missing UNITS were.**
   One row genuinely moved (mined debris, 36×, and it was the *hue* that was wrong — blue for hot
   rock), one derived to zero (the wreck hull, which was ambient light disguised as emission), and
   three came out *within a few percent of their authored values*, which is a result rather than a
   coincidence.

   ⚠ So the sentence "expect the plume to be legitimately very bright, so this alone will not tame it"
   was right, and understated: **nothing about step 1 was ever going to tame it**, because there was
   almost nothing to tame. What step 1 actually bought is that Phase 8's energy-conserving glare now
   has real inputs, and that four live D25/NaN bugs got found (D26g).
2. ✅ **Hot-pixel-capped metering** — shipped 2026-08-18 as the HOT-TAIL CAP above, which bounds the
   metered-EV shift to 0.51 stops. ⚠ Re-reading the order: this step and step 1 are done, so what is
   left of D26 is only steps 3–4, and both are **speculative until someone reports the symptom again**
   on calibrated inputs. ⚠⚠ Do NOT pre-emptively re-open the estimator: three attempts in one session
   (`flux`, `pooled`, local exposure) all worked as specified and all made the game worse — D33c.
3. **Then a screen-space metering weight mask** if the vehicle still dominates — UE's approach, and
   safe because it changes only metering, never the render.
4. **Local exposure** last, if a global exposure still cannot hold it. ⚠ Built and reverted once
   already (D33c): 4.3 stops of compression against UE5's ~1.3, visible cells, flicker.

⚠ Do NOT re-attempt the layer split. Even with the light layers fixed it is the wrong tool: it is a
render-order change in service of a metering problem, and it cannot express "count this less", only
"do not count this at all".

### ✅ D31 — the meter point-sampled, so it never saw the sun (CLOSED 2026-08-18)

Found while checking why fixing D26's monotonicity appeared to fix the sun-in-frame inversion "too well":
turning to put the sun on screen changed the metered EV by 0.02 stops. It should have changed it a lot.

`updateExposureMeter`'s downsample took **one bilinear tap per 64×64 output texel** — one sample standing
in for a 30×30-screen-pixel tile at 1920 wide, and more on a Retina buffer. Three symptoms, two measured:

1. **The sun was not metered at all.** `EV max` read 5.3 (≈4.9 game units — Earth's cloud highlights)
   while the sun disc is 265,000 game units = **EV 21**. A ~3 px disc has roughly a 10% chance of landing
   on any given tap, so looking straight at the sun cost no adaptation whatsoever.
2. **The reading depended on display resolution.** The same pose measured `EV max` **6.55** on a Retina
   XDR buffer and **5.60** at 1920×1080 — ~1 stop apart. A measurement of the SCENE must not be a
   function of the drawing-buffer size. (This came from the user correcting my assumed 1920; the
   correction strengthened the diagnosis rather than weakening it.)
3. **Latent flicker**, the worst of the three: when a small bright feature *does* hit a tap, the reading
   jumps ~15 stops, so exposure would twitch as the camera drifts sub-pixel.

#### 🔑 The fix is about VARIANCE, not coverage

A single tap is already an *unbiased* estimator of the tile mean — in expectation. Its problem is
enormous variance, and that variance IS the flicker. `TILE_TAPS²` stratified taps spread evenly across
the tile cut the variance ~TILE_TAPS²-fold (16× in stddev at 16 taps) while staying unbiased **at any
resolution**, because the offsets are computed in UV and therefore cover the tile whatever its pixel
size. That framing matters: chasing "full pixel coverage" would have made the tap count
resolution-dependent for no gain.

⚠ **The average must be of LINEAR luma, taken BEFORE the log2.** Averaging the per-tap EVs would be a
geometric mean, which under-weights exactly the hot features this pass exists to see — the same class of
error as the log-average estimator that read 21 stops low (§5.9).

Cost: 256 taps × 4096 texels = 1.05 M fetches/frame, nothing against a 2 MP frame.

**Measured after the fix**, identical pose at two buffer sizes 1.68× apart in linear resolution:

| | 2560×1440 | 1520×860 |
|---|---|---|
| **EV max** | −4.18 | **−4.21** |
| metered EV | −12.75 | −12.63 |
| p98 | −7.46 | −7.36 |
| hot-tail share | 81% | 79% |

**0.03 stops** on `EV max`, against ~1 stop before. Resolution independence achieved.

⚠ Note what this changes about the sun: its flux is now *averaged into* its tile rather than missed, so a
3 px disc in a 900 px tile contributes 265,000 × 3/900 ≈ 883 game units. That is the correct flux-average
answer, and it means **looking at the sun finally costs adaptation** — the hot-tail compressor (D26) is
what keeps that from being a cliff.

### ⛔ D30 — stars are 6.7 magnitudes too dim, and no rescale can fix it

User: *"at sunset the brightest stars start to become visible… at cloud level at the terminator I see no
star at all. Are you sure the brightness of our stars is correct?"* **No. They are 482× too dim, and the
answer is not a bigger number.**

A star is a POINT source, so what matters is its flux divided by the solid angle it lands in
(6.53e-7 sr for one pixel at 50° vFOV / 1080 px):

| star | mag | should render as |
|---|---|---|
| Sirius | −1.46 | **14.9 cd/m²** |
| Vega | 0.03 | 3.78 cd/m² |
| Polaris | 1.98 | 0.63 cd/m² |
| naked-eye limit | 6.0 | 0.0155 cd/m² |

Our brightest panorama texel post-rescale measures **3.1e-2 cd/m²** → an implied magnitude of **5.25**.
So the brightest object in our sky renders as a *barely-naked-eye* star. Deficit vs Sirius: **482× = 8.9
stops = 6.7 magnitudes.**

#### 🔑 Root cause: the asset is LDR and is being asked to hold 17 stops

Real Sirius : diffuse Milky Way = **1.19e5 : 1 = 16.9 stops**. An 8-bit sRGB texture holds ~8 stops of
usable range. **The panorama physically cannot represent both ends**, so calibrating it by the whole-sky
MEAN — which is correct for the diffuse band, and what `SKY_RADIANCE_SCALE` does — necessarily leaves the
stars crushed toward that mean.

This is D25's problem one level out: there, the *buffer* could not hold the scene's range; here the
*asset* cannot hold the sky's. And it has the same shape of answer — no single scale works, the two
populations must be separated.

⚠ **So do NOT "fix" this by raising the star texels or re-scaling the panorama.** Brightening the whole
texture re-breaks the diffuse band (the 189,000×-too-bright error), and there is no per-texel way to tell
a star from nebulosity in an LDR image.

#### The fix: stars from a catalogue, panorama for diffuse only

Render stars as point sprites from a real catalogue (Hipparcos / Yale BSC) with physical magnitudes →
illuminance → per-pixel luminance, and strip them from the panorama so it carries only nebulosity. This
is what Space Engine, Elite and Star Citizen do, it needs no per-system tuning (a generated system gets
its own catalogue), and there is already an **unmounted `StarsComponent.tsx`** in the repo to build on.

#### Cross-check against the user's own test

At the terminator with the sun set, looking up: measured sky p50 = EV −3.34 = **74.5 cd/m²** — a
plausible twilight zenith (real: 10–100). Sirius at 14.9 cd/m² against that is a **0.20 : 1** contrast,
i.e. genuinely marginal in reality too — which matches the user's observation that the brightest stars
only *start* to appear. But our star at 3.1e-2 cd/m² sits **2,404× below the sky**, so it is not marginal,
it is absent. The sky level is roughly right; the stars are the defect.

### ⛔ D28 — no refracted limb light (the dominant illuminant in an umbra)

Closing D27 raised the right question: *should* an eclipsed ship be black? Physically no — and the
term that saves it is not starlight, it is **sunlight refracted through the planet's atmosphere**.
That is why a totally eclipsed Moon is coppery red rather than invisible, and it is ~3,400× larger
than starlight.

Backed out of real total-lunar-eclipse photometry. The back-out is valid because the albedo and the
phase are the *same* in both cases, so the magnitude drop from full moon IS the drop in incident
illuminance:

| eclipsed Moon V | incident | hull radiance @ albedo 0.333 | vs half-float floor |
|---|---|---|---|
| −1.5 (bright eclipse) | 4.2 lux | 0.45 cd/m² | 1,248× |
| 0 (typical) | **1.1 lux** | **0.11 cd/m²** | **315×** |
| +1 | 0.42 lux | 0.045 cd/m² | 125× |
| +2.5 (dark, post-volcanic) | 0.11 lux | 0.011 cd/m² | 31× |

**It is representable in half-float TODAY** (315× above the 5.96e-8 floor), unlike starlight — so
unlike D29 this is not blocked by D25.

⚠ Two things not to get wrong:
- **Eclipse brightness swings ~2 magnitudes** with atmospheric aerosol loading (volcanic eruptions
  darken eclipses measurably). ~1 lux is a central value, not a constant to bake.
- **Do not transplant the Moon's number.** At 3 R⊕ the refracting ring subtends far more solid angle
  than at the Moon's 60 R⊕, so the ring's geometry has to be integrated properly. The atmosphere pass
  already owns the transmittance LUT and grazing-path machinery this needs.

Applies **only to atmosphere-bearing bodies.** In Luna's umbra starlight really is all there is, so
D27's near-black is *correct* at Luna and *wrong* at Earth. Do not "fix" it globally.

### ⛔ D29 — the skybox is not a light source (blocked by D25)

The panorama lights nothing. Physically the hull in an atmosphere-less umbra is lit by integrated
starlight plus zodiacal light, and it is faintly visible — but **darker than the sky behind it**:

| | value | reading |
|---|---|---|
| hull radiance from starlight | **3.3e-5 cd/m²** | |
| vs scotopic absolute threshold (~1e-6 cd/m²) | **33× above** | a real eye WOULD see it |
| vs Milky Way band (1.25e-4 cd/m²) | **0.27×** | a dark silhouette AGAINST the galaxy |
| vs half-float floor (5.96e-8 game) | **0.093×** | **stores as exactly zero** |

So "almost black" is closer to right than "lit" — the correct look is a dark shape against a brighter
sky, not a visibly grey ship.

**🔑 The calibration is already done and it validates independently.** Integrated starlight from S10
units (40 S10 at the galactic pole, 150 in the plane; `1 S10 = 8.34e-7 cd/m²`, machinery checked
against the known 22 mag/arcsec² = 1.7e-4 cd/m²) gives `E = πL ≈ 1.6e-4 lux`, ~3e-4 with zodiacal.
And `π × SKY_TARGET_NITS = 3.14e-4 lux`. Those agreeing means **an IBL derived from the panorama is
automatically photometrically correct** — and it makes the hull and the sky share ONE authority, so
they cannot drift apart. It also needs no per-system tuning: bake from whatever skybox a generated
system ships.

**Use SH-L2 (9 coefficients), not a PMREM.** The irradiance of a sky whose only structure is one
broad band is inherently low-frequency, so L2 captures the plane-vs-pole gradient (4× in radiance,
~2–3× in irradiance) exactly, at 9 `vec3`s and zero texture fetches, baked once from the KTX2 already
loaded. A PMREM would buy specular reflections that are meaningless at 3e-5 cd/m².

⚠ **BLOCKED BY D25.** At 5.5e-9 game units this is 0.093× the half-float floor — it renders *exactly
nothing* until source pre-exposure lands. Building it first means debugging a correct implementation.

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
`src/data/bodyPhotometry.ts` (the §3.6 table),
`src/components/space/emissivePhotometry.ts` (**the D26 emitter table** — every self-luminous VFX
surface, thermal rows derived from `blackbodyLuminanceNits`, design rows stated in cd/m²),
`src/components/space/preExposedEmissive.ts` (D25 registry for plain three.js materials).

**Touched:** `SpaceRenderer.tsx` (exposure stage, glare replacing bloom, HDR output),
`Scene.tsx` (renderer ctor for HDR), `Star/SunLight.tsx` (distance), `Star/Star.tsx` (`CORE_HDR`),
`celestial/useFarLOD.ts` + `space/StellarPoint.tsx` (unified radiance),
`celestial/bodies/*.ts` (all surface shaders: `E/π`; Earth's sigmoid; texture calibration),
`celestial/bodies/atmosphereData.ts` (delete `VENUS_ILLUM_TRIM`, document the 6,400 constant),
`celestial/bodies/cloudCommon.ts` (`CLOUD_SUN_SCALE` re-anchor), `store/store.ts` +
`SettingsMenu.tsx` (exposure/HDR settings).

---

## 10. References

- **Mallama, Krobusek & Pavlov,** *Comprehensive wide-band magnitudes and albedos for the planets*
  (Icarus 282, 19–33, 2017; arXiv:1609.05048) — **Table 7 is the source of both `geometricAlbedo` and
  `bandAlbedo`** in `bodyPhotometry.ts` (D09e).
- **Ramírez et al.,** *The UBV(RI)c colors of the Sun* (ApJ 752, 5, 2012; arXiv:1204.0828) — the
  (B−V)☉ = 0.653 and (V−R)☉ = 0.352 zero points in `bodyColour.ts`.
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

## Phase 4 rewire — executable spec (written 2026-08-21, groundwork landed, rewire NOT started)

Foundation is in `photometry.ts`: `bodyIlluminanceAtCamera()`, `stellarPointRadiance()`,
`STELLAR_POINT_PROFILE_INTEGRAL = 0.093146`. **Nothing is wired to them.** Do the whole list below in ONE
change — see the atomicity warning.

### ⚠⚠ ATOMICITY — the reason this was not started piecemeal

`useFarLOD` emits `albedo × sunDot × uPreExposure`: pure REFLECTANCE, no illuminance (**D04**).
`StellarPoint` emits `(flux / JUPITER_REF_FLUX) × 12.0`: normalised to an arbitrary Jupiter reference
(**D06**). Correcting either alone makes the billboard→point handoff discontinuity WORSE. This is the
Venus-trim cancellation trap: two errors that partly cancel in one scene and diverge in every other.

### Measured targets

For Jupiter at `StellarPoint`'s own reference geometry (p 0.538, R 69,911 km, 5.2 AU sun, 4.2 AU camera):

| quantity | value |
|---|---|
| `E_cam` | **5.222e-9** game units = 3.15e-5 lux |
| correct `uBrightness` | **1.156e-2** @1783p, **4.24e-3** @1080p |
| shipped | 12.0 |
| ⇒ error | **1,038× too bright @1783p, 2,830× @1080p** |

⚠ Note the **resolution dependence**: correct radiance ∝ `1/θ_h²` because the sprite is a fixed 6 PIXELS, so
its solid angle shrinks as resolution rises. `REFERENCE_HDR` is a constant ⇒ distant planets' flux currently
depends on window size. Same defect class as D31 and the star gate's `pxAngle = fov/height` bug.

### The work, in dependency order

1. **`StellarPoint.tsx`** — `uBrightness = stellarPointRadiance(bodyIlluminanceAtCamera(p, phase, radiusKm,
   dSunKm, distKm), minAngle / 2) × getPreExposure()`. Delete `REFERENCE_HDR`, `JUPITER_REF_FLUX`, and the
   `500` clamp (it exists only because the scale was arbitrary). ⚠ Keep the `× getPreExposure()` INSIDE any
   remaining clamp, per the D25 note already in that file.
2. **`CelestialBody.tsx`** — one new `uSunIllum` uniform beside `uSpR/uSpU/uSpF`, set per frame from
   `sunIlluminanceAt(|positionKm − sunPositionKm|)`. Both branches of the frame loop already have those two
   vectors. Pass it into `useFarLOD`. This is the ONLY call site for both tiers, which is what makes the
   atomic switch tractable.
3. **`useFarLOD.ts`** — thread `uSunIllum` through the props object and multiply:
   `col = albedo × sunDot × (uSunIllum / π) × uPreExposure`. The `/π` is the Lambert conversion from
   irradiance to radiance — the same `E/π` factor D02 fixed for surfaces and this tier never received.
4. **⚠ EVERY `farConfig.buildFragment` OVERRIDE.** `useFarLOD` takes a per-body fragment builder
   (`farConfig.buildFragment ?? defaultBillboardFragment`) and ~14 body files define one. **Each needs the
   same illuminance multiply**, or those bodies stay uncalibrated while their neighbours change — a worse
   state than today. This is the bulk of the work and the reason it is not a quick edit.
5. **`fade`** — reconsider, do not delete blindly. It exists to hide the discontinuity. Once both tiers share
   one formula the handoff should be continuous BY CONSTRUCTION, so the fade becomes a cosmetic
   cross-dissolve rather than a cover-up; measure before removing.
6. **D20** — Luna's `stellarPoint.geometricAlbedo` is 0.0036 against a measured 0.136 (**38×**). This should
   fall out by construction once the tier reads real albedo × real illuminance.

### The gate

Probe a named body's flux at three distances that straddle both handoffs (near→billboard, billboard→point) and
assert the total flux is continuous across each. 🔑 Flux, not peak — the same reasoning as `__lum.star()`:
peak depends on how many pixels the body covers, flux does not, and flux is what the tiers must agree on.
Expected absolute value comes from `bodyIlluminanceAtCamera` for the same geometry.


## Phase 4 — measured state after the rewire (2026-08-21)

`__lum.lod("jupiter")`, 1783p, DPR 1.8, after the fixes below. Ratio = measured flux / `E_cam·(1+fade)`.

| stop | tier | ratio |
|---|---|---|
| 24 px | mid (sphere) | **0.466** |
| 9 px | far | 0.082 |
| 8.5 px | far | 0.100 |
| 7.5 px | far + point | 0.165 |
| 6 px | far + point | 0.277 |
| 3 px | far + point | 0.536 |
| 1 px | far + point | **1.187** |

### ✅ What is fixed and validated

- **D04** — `useFarLOD` wraps EVERY builder in `surfaceRadiance` (× E/π), the same converter the near/mid
  tiers use. Also gave the 7 `buildFragment` overrides the D25 pre-exposure they never had.
- **D06** — `StellarPoint` uses `bodyIlluminanceAtCamera` + `stellarPointRadiance`; `REFERENCE_HDR`,
  `JUPITER_REF_FLUX` and the `500` clamp are gone. At 1 px the point reads **1.187**, i.e. right.
- **D20** — Luna 0.0036 → 0.136.
- **`mars.ts`** — rim reflectance `12.0` → `0.12` (a lost decimal; an energy violation once the tier became
  photometric).
- **⚠ DPR bug in `StellarPoint`** — `screenH` was `window.innerHeight` (CSS px) while rasterisation is in
  drawing-buffer px. At DPR 1.8 the sprite was **10.8 device px** not 6, the visibility gate fired at
  **14.4** not 8, and θ_h — hence the flux normalisation — was off by **3.24×**. `StarField` uses
  `size.height` and gates at 0.999×. 🔑 **Two sub-pixel-source renderers must not disagree about what a
  pixel is.** Fixing it moved the 1 px point reading from 0.40 to 1.187.

### ❌ What remains: the far billboard is ~7.5× dim

With the point off (9 / 8.5 px) the far tier reads **0.082–0.100**. Derivation says it should read ~0.68:

```
flux = E_sun·(R/d)²·1.05²·albedo_luma·(2π/3.4)/π          → 0.72·Φ(α) ≈ 0.68
```

using `albedo_luma(JUPITER_ALBEDO) = 0.5605` (vs `p = 0.538`, ratio 1.04 — so the albedo constant is NOT the
cause), the quad's 1.05× oversize, and `limbDark = domeZ^0.4` reducing the disc integral from 2π/3 to 2π/3.4.

⚠ **The deficit is in RADIANCE, not area.** At the 9 px stop the measured mean disc radiance is **0.0067**
game units where `albedo × sunDot × E_sun/π` predicts **0.0839** — ~12×. Geometry is ruled out: the quad is
`PlaneGeometry(scaledRadius × 2.1)` with a view-aligned vertex path, no `sizeMultiplier` overrides, and
`p` spans ±1 across it so the disc radius is 1.05 R.

Remaining suspects, in order: `m.alphaHash = true` (stochastic discard — should cost only the rim, since
`edge = smoothstep(1.0, 0.92, dist)` is 1 over most of the disc, but worth measuring rather than assuming);
the `uSpR/uSpU/uSpF` basis magnitude; and whether the scaled scene composites the far tier with any
additional factor.

### 🔑 The architectural fix, regardless of the residual

The billboard's `domeZ = sqrt(1−r²)` with `sunDot = clamp(ŝ·n̂)` is **not an approximation** — it is the exact
Lambert-sphere geometry. So the SHAPE is right and only the NORMALISATION is wrong. Rather than hunt
constants, normalise the profile by its own integral and multiply by the analytic `E_cam`, exactly as
`STELLAR_POINT_PROFILE_INTEGRAL` does for the point and `uPsfNorm` does for stars:

```
radiance = shape(p) · E_cam / (θ_q² · ∫shape dA_p)
```

Then flux equals `E_cam` **by construction** for all 8 builders, the tier step vanishes without tuning, and
the `fade` ramp becomes a cosmetic cross-dissolve that can finally be deleted. The shape integral varies with
phase, so measure it on the GPU (one small render + readback, the pattern `skyIrradiance` already uses)
rather than deriving it 8 times.

### ⚠ Gate bugs found along the way — all in the instrument

`__lum.lod()` needed four fixes before its numbers meant anything: missing `Ω_pixel` (compared Σ radiance to
an illuminance); a **double** `/preExposure` (`decodeRgb` is the single chokepoint and already divides —
a defensive extra divide is still a bug); tiers INFERRED from pixel size when the switch is in km and depends
on texture-streaming readiness; and stops landing within 1% of a threshold, which measures the switch rather
than a tier. 🔑 The gate now WITNESSES tier, `preExposure` and `uPsfNorm` instead of recomputing them — every
one of those changes came from a wrong inference.


## Phase 4 — after the crossfade fix (2026-08-21, second measurement round)

`__lum.lod("jupiter")`, points ON. **Worst jump 4.22 → 0.59 stops; worst |log2| 5.82 → 1.31.**

| stop | tier | ratio | Δ from previous stop |
|---|---|---|---|
| 24 px | mid | 0.4606 | — |
| 9 px | far | 0.6925 | +0.59 |
| 8.5 px | far | 0.7009 | +0.02 |
| 7.5 px | far + point | 0.6951 | −0.01 |
| 6 px | far + point | 0.6845 | −0.02 |
| 3 px | far + point | 0.4590 | −0.58 |
| 1 px | far + point | 0.4039 | −0.18 |

### 🔑 The bug the isolation sweep caught

Sweeping with `__lum.lod(id, 180, false)` (stellar points DISABLED) versus `true` made the overlap
attributable for the first time. At 7.5 px the billboard ALONE carried **0.6905**; switching the point on
dropped the total to **0.0442** — the point *destroyed* 15.6× of the flux it was supposed to add.

⚠ `depthWrite = false` did NOT fix it, and that was the useful result: it ruled out occlusion and left one
explanation. **`transparent = false` means NO BLENDING**, so the point's fragments OVERWRITE the billboard's
colour. At 7.5 px the point carries `fade = 0.0039` of the flux and replaced a full-strength billboard with
it. **A source that REDUCES total flux when added is not blending.**

Fixed with One/One `CustomBlending` (⚠ NOT `THREE.AdditiveBlending`, which is `SrcAlpha/One` and would halve
the flux — the bug the star gate caught), `alphaHash` dropped (it discards ~10% of the energy and would
corrupt the flux normalisation), and `renderOrder = 1` so the additive sprite draws AFTER the opaque
billboard.

⚠ Three hypotheses were spent on this overlap — occlusion, non-complementary fade, hidden visibility
coupling — before the toggle answered it in one run. **The recurring error was trying to attribute a SUM of
two sources from a single number, which is underdetermined however careful the arithmetic.** Build the
isolation switch as soon as two things draw in the same place.

## ✅ Phase 4 — CLOSED AND MEASURED (2026-08-26)

`__lum.lod("jupiter")`, stellar points enabled. **The three form factors are gone.**

| stop | tier | ratio (was) | Δ from previous stop |
|---|---|---|---|
| 24 px | mid (sphere) | **0.8168** (0.4606) | — |
| 9 px | far | **1.020** (0.6925) | +0.32 |
| 8.5 px | far | **0.9743** (0.7009) | −0.07 |
| 7.5 px | far + point | **0.9992** (0.6951) | +0.04 |
| 6 px | far + point | **0.9867** (0.6845) | −0.02 |
| 3 px | far + point | **1.000** (0.4590) | +0.02 |
| 1 px | far + point | **1.005** (0.4039) | +0.01 |

**Worst |log2(measured/expected)| across all stops: 0.29 stops, from 1.31. Largest tier jump: 0.32
stops, from 0.59 — and 4.22 before the crossfade fix.** The gate's own verdict: *"✅ SCALE IS CONTINUOUS
across every LOD transition (all jumps < 0.5 stops)."*

🔑🔑 **AND THE ×3/2 PREDICTION VERIFIED TO 1.5%.** The section below derived that the far tier's 0.6925
was a missing geometric→Lambert albedo conversion, predicting `0.6925 × 1.5 = 1.039`. Measured: **1.020**.
A convention factor predicted from theory, applied blind to all three tiers at once, landing within
1.5% — which is the strongest evidence available that the billboard's `domeZ`+`sunDot` really is the
exact Lambert-sphere geometry and not an approximation.

### ⚠ The one residual: the mid tier reads 0.8168 (1.22× dim)

It is the entire 0.32-stop mid→far jump and the whole of the 0.29-stop worst case. The section below
attributes it to **D09** — texture MEAN albedo versus the disc-averaged reference — and predicted
~1.45× there; the runtime albedo calibration has since taken it to **1.22×**. Not chased further: a
single tier 22% dim with every transition continuous is a good place to stop, and the next move on it
is D23 (the texture's *distribution*, not its mean) rather than another form factor.

⚠ **Do not read the `Ø measured/expected` column as a renderer defect.** It sits at 0.80–0.84 on every
resolved stop, but the flux aperture is 61 px against a 20 px lit disc, so no flux is escaping — the
diameter is threshold-measured and simply under-reads the cosine-dimmed limb. Consistency across three
different tiers is the tell that it is the instrument, not the render. (The 1.43 and 4.30 at 3 px and
1 px are the PSF sprite being legitimately wider than the geometric disc for a sub-pixel source.)

### ⚠⚠ Why the section below is STALE — kept for its derivations (noted 2026-08-26)

**Its "what remains" prose would send a reader to rebuild finished work.** What landed after it was
written, and closed it:

- **`LAMBERT_SUBSOLAR_OVER_GEOMETRIC = 1.5` is now applied inside `surfaceRadiance()`**, i.e. to all
  three tiers at once. Every albedo this project feeds in is a GEOMETRIC albedo and a Lambertian shader
  needs the LAMBERT one (`p = (2/3)·A`). That comment records the measurement: the far tier's **0.6925 ×
  1.5 = 1.039**. So the far billboard's form factor is closed, and closed by a convention factor rather
  than a fudge — which is what you would expect given the section below already establishes that the
  billboard's `domeZ`+`sunDot` is the EXACT Lambert-sphere geometry.
- **`STELLAR_POINT_PROFILE_INTEGRAL` and `stellarPointRadiance()` are DELETED.** The integral (0.093146)
  was correct for a shape the rasteriser could not sample — the `core` term spanned 0.6 px radius while
  carrying 38% of the integral. 🔑 That also resolves the "one unreconciled number" the section below
  ends on: the point's peak read 10× under prediction while its flux ratio was 0.40, and the answer was
  that the profile was mis-sampled, not that the normalisation was wrong. `StellarPoint` now shares
  `psfNormForBuffer()` with `StarField`, whose flux gate reads **0.999×**. ⚠ *An exactly-correct
  normalisation of a badly-sampled shape is still wrong — check the shape can be sampled before
  deriving its integral.*
- **The mid tier's residual is D09**, texture mean albedo vs the disc-averaged reference, and the runtime
  albedo calibration has since landed for it.

⇒ **Verified 2026-08-26 — see the measured table above.** 🔑 The generalisable lesson: this doc's
per-phase "what remains" prose is written at the moment of measurement and does not self-update, so the
fixes that closed it landed in `photometry.ts`'s comments instead. **Check the code's own comments for a
defect before believing a plan section that says it is open.**

### What remains: three form factors, one fix — ⚠ SUPERSEDED, see above

Each tier is FLAT within itself but lands on its own constant fraction of `E`:

| tier | form factor |
|---|---|
| mid sphere | **0.46** |
| far billboard | **0.69** (matches the analytic 0.68 derivation to 3%) |
| stellar point | **~0.41–0.46** |

That is the whole of the remaining +0.59 (mid→far) and −0.58 (6→3 px). **Profile normalisation fixes all
three**: divide each tier's shape by its own integral, multiply by the analytic `E_cam`, so flux is `E` by
construction. `STELLAR_POINT_PROFILE_INTEGRAL = 0.093146` already attempts this for the point, so its value
is WRONG rather than missing — recheck it now that `alphaHash` no longer discards part of the profile.

⚠ **One unreconciled number, the thread to pull next.** At the 1 px stop the point's measured PEAK radiance
is 0.0118 where `E/(θ_h²·I)·f(0)` predicts 0.124 — 10×. But its FLUX ratio is 0.40, not 0.10. Both cannot be
right: either the rendered sprite is larger than `θ_h` implies (so the flux spreads further than the
normalisation assumes) or the peak is clipping. Resolving that probably explains the point's form factor
outright.

### Also fixed this round

- **`StellarPoint` used `window.innerHeight`** — CSS pixels — while rasterising into drawing-buffer pixels.
  At DPR 1.8: `MIN_SCREEN_PX = 6` became 10.8 device px, the visibility gate fired at 14.4 instead of 8, and
  θ_h (hence the flux normalisation) was off by 3.24×. Now `gl.getDrawingBufferSize()`, the same source
  `StarField` uses. ⚠ **The first attempt at this fix was a no-op** — `useThree(s => s.size.height)` is also
  CSS — and it was caught only because the gate returned numbers IDENTICAL to the pre-fix run, digit for
  digit. **A fix that changes nothing measurable did not fix anything.**
- `stellarPointFade()` exported as the single source of truth for the crossfade weight, taking the buffer
  height explicitly, so the billboard's `1 − fade` and the point's `fade` cannot diverge.
