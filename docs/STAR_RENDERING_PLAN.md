# Star rendering plan — one parameterised star, continuous LOD

Closes the reported defects **R-A** (the sun vanishes past ~13 AU) and **R-B** (no star LOD), and
absorbs **P8d** from [`LIGHTING_PLAN.md`](LIGHTING_PLAN.md) — whose premise turned out to be only
*sometimes* true (§9.2).

Companion to [`STAR_CATALOGUE_PLAN.md`](STAR_CATALOGUE_PLAN.md), which owns the *catalogue* (data,
magnitudes, sky irradiance). This doc owns *how a star is drawn* at every range, from a 174 KB
catalogue row to a photosphere filling the frame.

---

## 1. R-A — the sun vanishes past ~13 AU, and it is the far plane

Reported: *"out at Uranus it is only visible when it is close to the edge of the screen. In the
centre it becomes invisible (though the light still hits the ship and the planets)"*, at 19.6 AU,
working again at Saturn's distance.

**Not a brightness bug.** At 19.6 AU the sun is apparent magnitude **−20.3** — ~10⁵× the full moon —
and 0.44 px across. Nothing in the photometric chain could hide it.

It is geometry:

```
SCALED_CAMERA_FAR = 2_000_000 scaled units × 1000 km/unit = 2.0e9 km = 13.369 AU
```

and [`Star.tsx`](../src/components/Star/Star.tsx) is the only billboard in the repo with **neither**
a bounding-sphere override **nor** `frustumCulled={false}`:

| path | custom boundingSphere | `frustumCulled={false}` |
|---|---|---|
| [`StarField.tsx`](../src/components/Stars/StarField.tsx) | ✅ | ✅ |
| [`MilkyWaySkybox.tsx`](../src/components/Skybox/MilkyWaySkybox.tsx) | — | ✅ |
| **`Star.tsx`** | ❌ | ❌ |

🔑🔑 **The far plane is FLAT, so the cull boundary is `far / cos θ`** — further away toward the frame
edges. That is the whole centre-vs-edge report, and it is quantitative:

| off-axis θ | cull distance (fov 50°, aspect 1.76) |
|---|---|
| centre | **13.37 AU** |
| vertical edge (25°) | 14.75 AU |
| horizontal edge (39.4°) | 17.30 AU |
| corner (43.3°) | 18.38 AU |

Cross-checks against the report: Saturn **9.58 AU** is inside the centre limit (works ✅); at
**19.6 AU** the star needs **θ ≥ 47.0°** to clear the plane, i.e. only the extreme edge ✅; *"had to
fly a few AU closer"* = crossing back inside ~13.4 AU ✅.

Both the hardware clip and three's frustum test trigger at the same boundary — the quad's four
corners share `viewZ`, so `clip.z/clip.w` is identical for all of them and they clip together.

### 1.1 The falsification test — run this BEFORE the fix

The model predicts a **threshold, not a direction**: flying outward, the sun leaves the frame centre
at **13.37 AU ± 2%**, and re-appears there when you cross back inside. A predicted threshold is a far
stronger test than "did the fix help", and it needs no code change.

### 1.2 R-B's second symptom is the same bug

*"when I turn away it instantly jumps from white to not visible."*

The bounding sphere is `PlaneGeometry(1,1)` → radius **0.707 scaled units (707 km)**, while the shader
inflates the quad to `uScale` — a **5,570-unit half-extent** near the sun (`RADIUS × GLOW_PAD`). At
0.1 AU that glow spans ±20.4° of a ±25° frame, and the *side* planes cull all of it the instant the
star's **centre** crosses them. One root cause, both symptoms.

---

## 2. Why `SCALED_CAMERA_FAR` cannot simply be raised

1. **It does not generalise.** Neptune 30 AU, Kuiper 50 AU, Oort 1e5 AU, nearest star **253,000 AU**.
   There is no far plane that covers the target content.
2. **Depth precision.** `SCALED_CAMERA_NEAR = 0.001` is deliberately tight (it fixed z-fighting on
   Saturn's rings at ~1.4 M km); range is paid for out of the same budget.

**Locked decision: project distant stars onto a shell inside the far plane.** A uniform scale about
the camera origin is a projective **no-op** — the perspective divide cancels it — so the rendered
image is unchanged apart from depth. This is already the established pattern here
(`STAR_SHELL_RADIUS = 900_000` in `StarField`, the panorama at 1e6).

---

## 3. R-B — there is no LOD, and the glow fights the physics

Current geometry: **one `PlaneGeometry(1,1)` view-space billboard at every distance.** The disc is a
`smoothstep` circle at uniform radiance — no limb darkening, no granulation. At 0.1 AU that is ~92 px
of flat white, which is the reported *"no visible detail when I fly close"*.

Around it, `GLOW_PAD = 8`, `MIN_SCREEN_PX = 60`, `INNER_GLOW_FRAC = 0.3`, `OUTER_GLOW_ABS = 8.0` are a
hand-authored corona from the bloom era. Phase 8 replaced bloom with a calibrated eye PSF
([`glarePass.ts`](../src/components/space/glarePass.ts)) and **nobody deleted the fake corona it made
redundant** — the recurring "artistic gain lying to a physically anchored system" trap.

🐛 **Live D25 bug found while reading:** `outerGlow` multiplies a bare `OUTER_GLOW_ABS = 8.0` with
**no `preExposure`**, while the disc and `innerGlow` both carry it. The outer glow's absolute radiance
therefore swings by orders of magnitude as the eye adapts.

### 3.1 Why P8d belongs in this work, not before it

P8d's fix is *"drive the glare from the star-flux uniform rather than the buffer"*. That per-star flux
uniform is **the same object** the LOD tiers need, so building it standalone builds it twice. And the
two halves are not separable in judgement:

- fix the drive, keep the fake corona → **two** coronas;
- delete the corona, leave the drive under-driven → too little glare.

They must land together, which is why P8d sits at **R3** below and not first.

---

## 4. The finding that makes this generalise for free

`public/data/stars_visual.bin` stores `count × (x, y, z light-years, magV, B−V)`. From data already in
the file:

| quantity | from |
|---|---|
| `T_eff` | B−V, via the existing `temperatureFromBV()` |
| distance | `\|xyz\|` |
| absolute magnitude | `M = m − 5·log₁₀(d_pc/10)` |
| luminosity | `L/L☉ = 10^(−0.4(M − 4.83))` |
| **radius** | **Stefan–Boltzmann: `R = R☉·√(L_bol/L☉)·(T☉/T)²`** |

🔑 **Every catalogue star's radius is derivable — no table, nothing baked at module load.** One
renderer parameterised by `(position, T_eff, R)` covers Sol, all 8,920 catalogue stars, and any
procedurally generated star automatically. That is the standing no-per-system-tuning constraint
satisfied by construction, and it is what the industry does: Space Engine, Elite and the Celestia /
Stellarium lineage all drive one parameterised star from `(T_eff, R, L)` with a continuous LOD from
catalogue sprite → PSF point → limb-darkened disc → photosphere with granulation, plus the corona as
a separate layer.

⚠⚠ **TWO LUMINOSITIES, AND THE FIRST DRAFT OF THIS SECTION CONFLATED THEM.** Measured in §8.1:
- **Radius** needs the **bolometric** luminosity, so it needs a bolometric correction `BC_V(T_eff)`.
  Omitting it puts Proxima's radius **6.4× low** and Betelgeuse's **2.3× low**.
- **Brightness** (lux, cd/m²) needs the **visual** luminosity and must NOT apply `BC_V`: a 3000 K star
  radiates mostly in the IR, so its bolometric output badly over-states what the eye receives.
  Magnitudes already *are* a luminous scale, so `absMagV` goes straight in.

⚠ Remaining error sources: interstellar extinction, unresolved binaries, and — the dominant one —
**`B−V` is degenerate for cool stars.** Betelgeuse (B−V 1.85) and Proxima (B−V 1.807) are the same
colour with T_eff 3600 K and 3042 K, because `B−V` cannot see luminosity class and reddening bites
hardest at the red end. `stars_nearby.json` carries a `spectral` string that would break the
degeneracy; unused so far because §8.1 shows it does not matter yet.

---

## 5. Tiers

Extending the pattern this repo **already validated** — Phase 4 closed every *planet* LOD transition
to 0.29 stops (`project_impostor_radiance`). The star path predates that work and never adopted it.

| tier | when | what |
|---|---|---|
| **T0** shell sprite | star beyond the clamp radius | flux-conserving Gaussian PSF on the shell. Never clipped, never culled. What `StarField` already does — extended to cover the primary |
| **T1** sub-pixel point | disc < `DISC_PX_FLOOR` | draw at the floor size, radiance ÷ area ratio (`subPixelFluxScale`). Already in `Star.tsx` |
| **T2** resolved disc | disc resolves | billboard + **limb darkening** |
| **T3** photosphere | disc fills a large part of the frame | sphere geometry, granulation, spicules; chromosphere/corona as a separate additive shell |

Orthogonal to all four: the corona comes from the **calibrated eye PSF**, driven at true flux (R3),
not from an authored `pow(falloff, 3.5)`.

---

## 6. Phases

| # | phase | deliverable | risk |
|---|---|---|---|
| **R0** | Measure | confirm the 13.37 AU centre threshold (§1.1) before touching code | none |
| **R1** | Shell clamp | `uShellScale` + `frustumCulled={false}`; bit-exact no-op inside the clamp radius. Fixes R-A and §1.2 | low |
| **R2** ✅ | Unify | one star renderer parameterised by `(position, T_eff, R)`; derived radius (§4); T0↔T1 continuity **proven to 1.6e-16 stops**; the primary stops being special-cased. §8 | medium |
| **R2b** | Promote | mount a *catalogue* star through the same component on approach; needs `S5` parallax from STAR_CATALOGUE_PLAN | medium |
| **R3** ✅ | **P8d + corona** | flux conserved instead of clipped (no splat path needed); corona gated off behind a runtime A/B. §9 | medium |
| **R4** | T2 limb darkening | the "flat white circle" fix | low |
| **R5** | T3 photosphere | granulation, spicules, chromosphere shell | medium |
| **R6** | `HOT_COMPRESS_EXPONENT` | make staring at the sun punishing — a *look* knob, so it goes last, once the sun renders correctly | low |

⚠ Doc drift to reconcile at R6: `LIGHTING_PLAN` says `HOT_COMPRESS_EXPONENT = 0.25`; the code says
**0.5** ([`exposureMeter.ts:139`](../src/components/space/exposureMeter.ts:139)).

---

## 7. R1 as built (2026-09-01)

**The clamp.** `uShellScale = min(1, SHELL_CLAMP_SCALED / distScaled)`, applied in the vertex shader
to the assembled view-space position:

```ts
const vp = viewCenter.add(offset);            // w = 1 + 0
const viewPos = vec4(vp.xyz.mul(uShellScale), 1.0);
```

🔑 **Correctness argument: a uniform scale about the camera origin is a projective no-op.** View space
puts the camera at the origin, so scaling `(centre + offset)` by `s` slides the whole billboard along
the camera→star ray; the perspective divide cancels `s` exactly. The rendered image is
**bit-identical** apart from the depth written — which is the entire point, since depth is what the
far plane tests. No `normalize`, no `length`, 3 extra vertex multiplies on a 4-vertex quad.

`uShellScale` is **exactly 1.0** inside the clamp radius, so everything tuned in the inner system is
untouched.

**`SHELL_CLAMP_SCALED = 1_200_000`** (8.02 AU) — 40% inside `SCALED_CAMERA_FAR`. Not constrained by
the panorama (1e6) or the catalogue shell (9e5): both use `depthTest = false, depthWrite = false`, so
they cannot fail the star's depth test, and the star is in the `transparent` bucket, so it paints
after both regardless. R2 will move this onto the catalogue shell when the paths unify.

**Occlusion.** ⚠ Once clamped, depth order against a body *beyond* the clamp radius is no longer
trustworthy (a planet at 10 AU seen from 19 AU would sort behind the pulled-in star). So `uDiscVis`
falls back to the analytic occluder registry (`sunVisibility`) whenever the clamp is active, not only
in the sub-pixel branch. That is strictly better than a depth test on a ≤2.5 px disc, and it is the
mechanism a transit at these ranges was always going to use.

**Also fixed here** — both are the pixel-size formula bugs this repo has hit three times
(`StellarPoint.tsx:406`), and they set the T1 threshold:

- `discPx` used the small-angle `/ fovRad` instead of `/ (2·tan(fov/2))` — **6.9% low** at fov 50°;
- it used `window.innerHeight` instead of the **drawing-buffer** height — **1.5× low** at dpr 1.5.

Together the T1 handover was firing at 3.67 AU instead of 5.15 AU.

**Diagnostics.** `__lum.starLod()` prints distance, tier, disc pixels, `shellScale`, and the drawn
depth against the far plane. It lives in `space/starLodStatus.ts`, a plain leaf module, **not** an
export from `Star.tsx`: ⚠ importing a `"use client"` component module into `lumHarness` produced a
SECOND module instance, so the harness read a status object the mounted component never wrote — it
reported "has not run a frame" while the star was visibly rendering. Same push-not-pull shape as
`sunOcclusion.ts`. Camera planes moved to `space/cameraPlanes.ts` for the same class of reason:
`Star.tsx` needs `SCALED_CAMERA_FAR`, but `SpaceRenderer` imports `lumHarness`, so importing it
directly would have closed a cycle. `SHELL_CLAMP_SCALED` is now **derived** (`0.6 × far`) so the two
cannot drift.

### 7.1 Measured (2026-09-01)

`__lum.starLod()` at the Neptune-umbra pose, with R1 in place:

| field | value |
|---|---|
| `distAu` | **29.961** |
| `tier` / `discPx` | `point` / 0.219 px |
| `shellScale` | **0.26774** (= 1.2e6 / 4.482e6 ✅) |
| `drawnAtScaled` | **1.200e6** |
| `farScaled` | 2.000e6 |
| `centreLimitAu` | **13.369** |
| `clipped` | **false** |
| `rescuedByClamp` | **true** |

✅ The centre limit matches §1's arithmetic to all quoted digits, and the distance is confirmed
independently: `__lum.sun()` read **142.6 lux** at the same pose, and √(128000/142.6) = **29.96 AU**.
At 30 AU the star is drawn 1.67× *inside* the far plane where it was previously 2.24× beyond it.

⚠ **Not yet confirmed visually.** `starVis` was 0 at that pose (Neptune occludes the sun
geometrically), and there is no airless body past 13.37 AU to stand behind, so every outer pose the
harness can reach sits on an atmosphere-bearing planet's shadow ray. The remaining check is the §1.1
threshold, flown: **the sun should now stay visible in the frame centre through 13.37 AU and beyond**,
where before it vanished there.


---

## 8. R2 as built (2026-09-01)

**[`space/starPhysics.ts`](../src/components/space/starPhysics.ts)** — one parameterised star. Pure
functions, no state, nothing baked at module load. `starParamsFromSystem(...)` and
`starParamsFromCatalogue(...)` return the **same struct**, which is what lets one renderer serve Sol,
a catalogue star and a generated primary.

**[`Star.tsx`](../src/components/Star/Star.tsx)** now takes `StarProps`
(`positionKm, radiusKm, tempK, luminositySun, primary?`). The primary is passed in from
[`Scene.tsx`](../src/components/Scene/Scene.tsx) — that mount site *is* the procedural-systems seam,
and it is now visible instead of hidden behind module constants. `temperatureFromBV` de-duplicated
out of `StarField.tsx` so the sprite tier and the disc tier cannot disagree about a temperature.

### 8.1 Measured — `__lum.starPhysics()`

🐛 **DEFECT FOUND AND FIXED: `SUN_DISC_LUMINANCE_NITS = 1.6e9` was 0.851× (−0.233 stops) too dim.**
It was stated independently while `SOLAR_ILLUMINANCE_1AU_LUX = 128,000` plus the Sun's own solid angle
imply **1.8805e9**. Two numbers for one physical quantity, and the disc lost. Now derived:

```
E(d) = L·π(R/d)²  and  E(d) = E☉(1 AU)·Lv·(AU/d)²   ⇒   L = E☉(1 AU)·Lv·AU²/(π R²)
```

`d` cancels, as it must for a radiance. Disc radiance went **265,000 → 311,454 game units**.

| gate | result |
|---|---|
| disc route vs anchor at 1 AU | both **21.2000** game units — **0.0000 stops**, exact by construction ✅ |
| magnitude route (m = −26.74) vs anchor | **−0.0212 stops** ✅ (residual is the accepted m☉ vs the 128,000 lux anchor, not code) |
| **T0↔T1 flux, 0.4–100 AU** | worst **1.6e-16 stops** ✅ machine epsilon |
| `BC_V(5772 K)` | **−0.0810** vs −0.09 implied by `Mbol☉ − MV☉` — 0.009 mag ✅ |
| radius, B−V < 1.5 | worst **1.076×** (Arcturus); Sun 0.998, Sirius 0.989, Rigel 0.995, Vega 1.06 ✅ |
| radius, B−V ≥ 1.5 | worst **0.452×** (Proxima) — the `B−V` degeneracy in §4, not arithmetic |
| **flux invariance under radius ×0.5…×10** | spread **0.00e+0** ✅ EXACT |

🔑🔑 **That last row is why a ±2× radius is acceptable, and it is asserted rather than argued.**
Radiance ∝ 1/R² and solid angle ∝ R², so they cancel *exactly*: **a wrong radius cannot change how
bright a star looks — only the range at which its disc stops being sub-pixel.** Betelgeuse's radius is
2.03× too large, so its disc would resolve at 2× the correct distance; you would only ever see it
resolved from inside its own system. Nothing else is affected.

⚠ The radius numbers are *worse* than a first offline pass, and the reason is worth keeping: that pass
fed the **published** `T_eff`, while the gate derives `T_eff` from `B−V` as the renderer must. The
extra error is entirely the colour-index conversion, not the Stefan–Boltzmann chain.

⚠ `Star.tsx` still publishes `starLodStatus` only when `primary` is true, so `__lum.starLod()` stays
unambiguous once R2b mounts a second star.

### 8.2 Knock-on for R3

The glare under-drive P8d records grows with the corrected disc: the scene buffer still clamps at
`HALF_FLOAT_WRITE_MAX = 60,000`, so the shortfall is now **311,454 / 60,000 = 5.19× (2.38 stops)**,
not the 4.4× (2.14 stops) LIGHTING_PLAN quotes.

### 8.3 Not done in R2, deliberately

Catalogue stars do **not** yet grow into discs on approach. That is R2b, and it depends on `S5`
(parallax / live 3D directions) in [`STAR_CATALOGUE_PLAN.md`](STAR_CATALOGUE_PLAN.md), which is
unimplemented — within one system the sprites are correctly a fixed-direction shell. What R2 delivers
is that the *parameters* for any such star are derivable and the two tiers are photometrically
continuous, so R2b is a mounting problem rather than a physics problem.

⚠ **Not yet observed in the running scene.** The gate is pure CPU and fully green, `tsc` is clean and
`pnpm lint` holds at 0 errors, but the dev server's WebGPU init had degraded to ~2 minutes after this
session's repeated reloads, so the scene tree never mounted for a visual check. The sun should now be
**0.233 stops brighter**; a dev-server restart is enough to confirm.


---

## 9. R3 as built (2026-09-01)

### 9.1 🐛 The unambiguous defect: the corona carried 5.3× the star's flux

Integrated the billboard's three terms as flux (value × px²) at each range, before touching code:

| range | quad radius | disc flux | innerGlow | outerGlow | **corona / disc** |
|---|---|---|---|---|---|
| 0.4 AU | 129 px | 2.54e8 | 7.57e7 | 3.37e4 | **0.30** |
| 1 AU | 52 px | 4.06e7 | 1.21e7 | 5.39e3 | **0.30** |
| 5.2 AU | 42 px | 1.50e6 | 7.95e6 | 3.60e3 | **5.30** |
| 9.6 AU | 42 px | 4.40e5 | 2.33e6 | 3.60e3 | **5.31** |
| 19.2 AU | 42 px | 1.10e5 | 5.83e5 | 3.60e3 | **5.33** |
| 30 AU | 42 px | 4.51e4 | 2.39e5 | 3.60e3 | **5.38** |

🔑🔑 **Beyond ~5 AU the hand-authored corona emitted 5.3× the star's entire physical flux**, because
`MIN_SCREEN_PX = 60` pinned the quad at ~42 buffer px while the disc shrank to the 2.5 px floor —
`innerGlow` is `0.3 × coreRadiance` over a 14.7 px footprint against a 1.25 px disc. That flux fed
**both** the glare pyramid and the exposure meter, so the star was lying to two physically anchored
systems at once. Deleted (gated to 0).

⚠ Plus the D25 bug §3 already recorded: `outerGlow` carried no pre-exposure, so its *absolute*
radiance swung with adaptation.

### 9.2 ⚠⚠ P8d's premise was only sometimes true, and nobody had checked which

P8d: *"the buffer clamps at `HALF_FLOAT_WRITE_MAX` = 60,000 while the disc is ~3.1e5, so the sun's
glare is 5.19× too weak."* But `Star.tsx` writes `discRadiance × preExposure`, so **the clamp bites
only below a metered EV that depends on range**:

| range | disc px | sub-pixel scale | peak ÷ preExposure | clamp bites when EV < |
|---|---|---|---|---|
| 1 AU | 12.88 | 1.0 | 311,454 | **2.11** |
| 5.2 AU | 2.48 | 0.981 | 305,586 | 2.09 |
| 9.6 AU | 1.34 | 0.288 | 89,660 | 0.32 |
| 19.2 AU | 0.67 | 0.072 | 22,415 | −1.68 |
| 30 AU | 0.43 | 0.029 | 9,181 | **−2.97** |

So P8d is **not a constant 5.19×** — it is zero whenever the eye is adapted to a frame with the sun
in it, and largest when dark-adapted. `__lum.starGlare()` prints which regime the current pose is in
and says so explicitly. ⚠ **Do not quote P8d's number again without running it.**

⚠ And it was *anti-correlated* with §9.1: at exactly the ranges P8d thought the glare was
under-driven, the corona was over-driving it by a similar factor. Two opposite-signed errors partly
cancelling — the "Venus-trim cancellation trap" from LIGHTING_PLAN §2.2, which is why §3.1 was right
that the halves had to land together.

### 9.3 🔑 The fix needed no splat path

P8d's proposed fix was to drive the glare from a star-flux uniform via a separate splat render path.
That is unnecessary. The disc's flux is `value × px²`, so instead of *clipping* the value, **spread
the disc**:

```ts
const unspreadPeak = discRadiance * preExp;
const ceilingPx = discPx * Math.sqrt(Math.max(1, unspreadPeak / HALF_FLOAT_WRITE_MAX));
const renderPx  = Math.max(discPx, DISC_PX_FLOOR, ceilingPx);
uCoreRadiance.value = unspreadPeak * subPixelFluxScale(discPx, renderPx);
```

**One `max` of three limits, with the radiance always `trueFlux / renderedArea`:**

1. the disc's **true** angular size — the normal case, `subPixelFluxScale` returns exactly 1;
2. `DISC_PX_FLOOR` — the rasterisation floor that already existed;
3. the **half-float ceiling** — new, and what replaces P8d.

Flux is conserved by construction in all three, so the glare pass reads the star's true flux straight
out of the buffer and `.min(HALF_FLOAT_WRITE_MAX)` becomes a *guard* rather than the mechanism. The
extra render path, the screen-space projection and the per-level splat amplitude all disappear.

Worked example at 30 AU, dark-adapted (preExposure 26.67): the old path wrote 244,800 → clipped to
60,000, discarding **4.08×** of the flux. The new path draws the disc at 5.06 px instead of 0.43 px
and writes 59,970 — nothing discarded. Only the disc's apparent *size* is approximate, and only in a
regime where it was already clipping to a flat white blob whose apparent size is set by the glare
anyway.

### 9.4 ⚠ One new artefact — and my first justification for it was wrong

While limit 3 binds, `renderPx ∝ √preExposure`, so the disc's **size breathes during an adaptation
transient**. `starLodStatus.sizedBy` reports which limit won, so `__lum.starGlare()` says whether the
ceiling binds in normal play.

⚠⚠ **The original justification here — "what it replaces pumped the disc's FLUX instead, which is
worse because flux feeds back into the exposure meter" — does not survive review, and the reason is
worth keeping.** It assumes the meter is a pure function of flux. It is not: `exposureMeter`'s hot-tail
cap keys off the flux's spatial **extent** (its weight share, `HOT_WEIGHT_FRACTION`), so growing
`renderPx` migrates the sun's flux out of the *compressed* hot tail into *uncompressed* `restFlux`.
That closes the same loop through a different term. **Two variables, one of which I had not
considered, so "size-only is safe" was not established.**

What *is* true, on tracing the sign: the loop is **negative**. Larger `renderPx` → more of the sun
counted uncompressed → higher metered EV → smaller `preExposure` → smaller `ceilingPx` → smaller
`renderPx`. So it is self-limiting rather than runaway, but it can **ring** depending on the
adaptation time constants, and ringing in the sun's apparent size is exactly the sort of thing the
eye locks onto. Watch for it whenever `sizedBy` reports `"halfFloatCeiling"`.

### 9.4b 🐛🐛 Two HIGH defects the adversarial review caught (both mine)

**(1) The half-float cap was applied to LUMINANCE, then multiplied by a colour channel > 1.**
`uStarColor` is luminance-normalised, so its brightest channel exceeds 1 — Sol (5772 K) is
`[1.1103, 0.9761, 0.9119]`. Capping the scalar at 60,000 and *then* tinting wrote **R = 66,618**,
above half-float's 65,504 finite max, so the disc's interior stored **+Inf**:

| T_eff | max channel | written at cap 60,000 | safe scalar budget |
|---|---|---|---|
| 5772 K | 1.1103 (red) | 66,618 / 58,566 / 54,714 | **58,996** |
| 3000 K | 1.7546 (red) | 105,276 / 50,958 / 16,266 | **37,332** |
| 30,000 K | 1.9800 (blue) | 43,158 / 59,070 / 118,800 | **33,082** |

This is the exact trap [`preExposedEmissive.ts`](../src/components/space/preExposedEmissive.ts)
documents — *"an absolute cap applied before a scale is not a cap at all"* — and that file's comment
even claims it clamps after the multiply *"exactly as Star.tsx does"*. Star.tsx did the opposite.

⚠ Provenance: **R2 created the hazard** by replacing the hardcoded `vec3(1, 0.95, 0.9)` (max 1.0,
always safe) with the blackbody; **R3 made it the designed steady state**, because the ceiling parks
the write at exactly the cap across the whole regime the feature exists for; and **R3's own gate
reported it as safe**, because it printed the untinted scalar. Consequences were not cosmetic:
`glarePass` has no threshold and its 13-tap pyramid propagates Inf to every mip, so
`mix(scene, PSF, k)` returns Inf for the *entire frame*; and `exposureMeter` rejects non-finite tiles,
so the sun was silently dropped from metering. Fixed with one `uWriteBudget = HALF_FLOAT_WRITE_MAX /
max(r,g,b)` uniform feeding both the CPU sizing and the GPU guard, so they cannot drift.

**(2) The inflated disc was analytically occluded AND still depth-tested, so the two multiplied.**
Only `depthWrite` was off; `depthTest` defaults to on, so occluders that wrote depth already remove
fragments — and `uDiscVis = starVis` on top double-counts, which is the failure the D34c comment in
that file says must not happen. It was also a **binary switch on `renderPx > discPx`, i.e. on the
adaptation state**, so a transit's brightness jumped by `1/starVis` between frames.

🔑 Fixed with the exact hand-off. An occluder covering fraction `c` of the true disc covers ≈ `c·f` of
the drawn disc, where `f = (discPx/renderPx)²`; depth therefore already delivers `(1 − c·f)`, so the
factor still needed is

```
uDiscVis = (1 − c) / (1 − c·f) = starVis / (1 − (1 − starVis)·f)
```

Continuous in `f`, exact under that approximation, never exceeds 1 (since `1 − c·f ≥ 1 − c = starVis`),
and it reduces correctly at both ends: `f → 1` gives 1 (depth owns occlusion), `f → 0` gives `starVis`
(analytic owns it). Beyond the shell clamp the analytic factor is still applied whole, because an
occluder past the clamp radius is not depth-ordered against the pulled-in star at all.

**Also fixed:** `starLodStatus.tier` keyed off "did any limit inflate the draw", which reported
`"point"` at 1 AU whenever the ceiling bound — an adaptation-dependent lie. It now keys off
`discPx < DISC_PX_FLOOR`, and `writtenPeak` is the **tinted** peak channel.

### 9.5 How to verify

Both halves change the sun at once, so a runtime A/B is the only honest way to judge it:

```
__lum.starGlare()      // the numbers at this pose — read `sizedBy` and `clipping`
__lum.starCorona(1)    // the shipped pre-R3 look, bug included
__lum.starCorona(0)    // R3
__lum.starLod()        // tier / shell clamp, unchanged from R1
```

⚠ Wait ~1 s between corona toggles: the corona changes the frame's flux, so the meter moves and an
immediate comparison measures the adaptation transient rather than the change.

Judgements needed, at 1 AU and out past Saturn:
1. **Is the aureole still convincing close in?** The glare's `k = 0.03` straylight fraction now has to
   carry it alone. If it reads too weak, that is a `GLARE_STRAYLIGHT_FRACTION` / crossover
   conversation, not a reason to bring the corona back.
2. **Is the sun's size right in the outer system?** It should be a small, very bright point with
   glare around it — not a 60 px blob. This is the biggest visible change.
3. **Does anything pump or flicker** as the eye adapts with the sun entering frame.
4. ⚠ **With glare turned off** (`__lum.glare(false)`) the sun is now a bare disc with no halo at all.
   That is the honest consequence of the corona having been the eye model all along, but confirm it
   is acceptable as a settings extreme.

### 9.6 Still open after R3

`HOT_COMPRESS_EXPONENT` (R6) is untouched, and the code says **0.5** where LIGHTING_PLAN says 0.25.
R4 (limb darkening) should also replace the disc's ±15% *relative* soft edge with a fixed pixel
width — at a resolved 32 px disc it currently softens ~4.8 px. ⚠ But note what the relative edge buys:
measured, it adds only **+0.45% flux (0.0065 stops)** versus a hard step, and because the width is
relative that bias is **constant at every range**. A fixed *pixel* width would make it
range-dependent, so R4 must integrate the limb profile properly rather than just narrowing the ramp.

⚠ Guard added while checking degenerate inputs: `renderHalfView` evaluates to exactly `RADIUS` at any
distance where the true size wins (verified down to 1e-3 scaled units), but at `distScaled === 0` it is
`0 × Infinity = NaN` and one NaN vertex removes the whole quad. `distScaled` is now floored at 1e-6.
