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
| **R2b** ✅ | Promote | one catalogue star rendered as a disc; dev warp, distance/speed units, interstellar POI markers. §12 |
| **R3** ✅ | **corona + half-float ceiling** | corona gated off (it carried 5.3× the star's flux); flux conserved where the disc is sub-pixel. §9, §9.7 | medium |
| **R3b** ✅ | **P8d proper** | analytic point-source glare + veil→adaptation feedback; retired the ceiling spread. §9.8–§9.10 | medium |
| **R4** ✅ | T2 limb darkening + sharp limb | derived from `T_eff` alone; the visible half is the LIMB, not the gradient. §11 | low |
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


---

## 9.7 ⚠⚠ MEASURED IN PLAY: the ceiling bound EVERYWHERE, and that was the eclipse bug

§9.2 derived the threshold correctly (the clamp bites below metered EV 2.11 at 1 AU) and then
**guessed the wrong side of it.** I assumed a frame with the sun in it meters high. Measured:

| pose | metered EV (game-unit) | preExposure | unspread peak | disc true → drawn |
|---|---|---|---|---|
| Earth's belt, 1 AU | **−1.87** | 3.05 | 9.51e5 | 10.97 px → **45.99 px (4.19×)** |
| Neptune, 30 AU | **−5.84** | 47.5 | 1.48e7 | 0.37 px → 6.08 px (16.5×) |

Not +4…+6 as assumed — **−0.3 to −1.9**, because `exposureMeter`'s hot-tail compressor deliberately
holds the meter down when the sun is in frame. So `sizedBy` read `"halfFloatCeiling"` at *every* range,
i.e. the regime I told the author to report as exceptional was the only regime.

🔑🔑 **AND THAT IS THE REPORTED ECLIPSE BUG.** At 1 AU the sun's true disc is ~11 px and Luna's is
~11 px, but the sun was *drawn* at 46 px — so an eclipsed sun rendered a 4.2×-too-wide white disc with a
small black Luna inside it, exactly as photographed. *"Grows very large as the exposure adjusts"* is the
§9.4 feedback loop, observed: eclipse darkens the frame → EV falls → `preExposure` rises →
`ceilingPx` rises → the disc grows. *"Flying out of the shadow resolves it"* closes the loop the other
way. The model reproduces the measurements to 0.4% (predicted 45.99 px vs measured 45.992).

⚠ Lesson, and it is the same one twice in this plan: **deriving a threshold is not measuring which side
of it you are on.** §9.2 has the right table and the wrong conclusion, and only a `__lum` reading in
the actual game settled it.

### 9.7a The fix: the ceiling may only spend size that is already fiction

```ts
const resolved = discPx >= DISC_PX_FLOOR;
const ceilingPx = resolved ? 0 : discPx * Math.sqrt(Math.max(1, unspreadPeak / writeBudget));
```

**A resolved disc's angular size is a real observable and must not be spent on flux conservation. A
sub-pixel disc's size is already a rasterisation fiction — that is what `DISC_PX_FLOOR` is — so
spending it there costs nothing.** And the deficit is largest exactly where the disc is smallest
(246× at 30 AU), so the two regimes want opposite things and the split gives each what it needs:

| range | disc px | resolved | renderPx | flux kept | residual P8d |
|---|---|---|---|---|---|
| 1 AU | 12.88 | yes | **12.88** (true) | 5.7% | **17.6× (4.14 stops)** |
| 5 AU | 2.58 | yes | 2.58 (true) | 3.7% | 27.2× (4.76 stops) |
| 30 AU | 0.43 | no | 7.12 | **100%** | none |
| 300 AU | 0.04 | no | 2.50 (floor) | **100%** | none |

Plus **fast-attack / slow-release smoothing** on `renderPx` (`SIZE_RELEASE_TAU = 0.6 s`): growth is
instant so the write budget is never exceeded, shrinking is damped so the §9.4 loop cannot ring. That
is aimed at the reported flicker in the sun at 300 AU, which is the loop ringing where `ceilingPx`
hovers near `DISC_PX_FLOOR`.

### 9.7b R3b — the remaining P8d deficit, and why a splat is still the wrong shape

Inside ~5 AU the guard now clips **17–27× (4.1–4.8 stops)** of the sun's flux, so P8d is real again in
the resolved regime. `__lum.starGlare()` reports it as `residualDeficitStops` rather than hiding it.

⚠ P8d's original prescription — splat the deficit into the glare pyramid — **cannot work**, and this is
worth recording before anyone tries it. The pyramid is half-float too. At 1 AU the deficit is ~8.5e7
(value × px²); one `_down[0]` texel holds 4 full-res px², so a single-texel splat needs 2.1e7 and
overflows. Spreading it to fit needs a **21×21 texel block = 42×42 full-res px**, which is wider than
the sun's own 11 px disc — so the "point source" would be a 42 px flat blob and the aureole's inner
shape would be destroyed. Levels 0–4 would all need Float32 (~24 MB and the bandwidth) to avoid it.

🔑 **R3b should instead add the deficit's glare ANALYTICALLY in the composite.** The glare of a point
source of known flux at a known screen position is closed-form — `glarePsf(θ)` already exists — so:

```
glare += k · F_deficit · PSF(θ) / ∫PSF dΩ      θ = angle from the sun's screen position
```

A handful of ALU ops in the existing composite, no new render target, no overflow (the flux is a
float32 uniform), exact PSF shape at every octave, and occlusion comes from `starVis` rather than a
depth test. That is what *"drive the glare from the star-flux uniform"* should have meant all along.


---

## 9.8 R3b as built — the analytic point-source glare

`glareNode` now adds, on top of the pyramid:

```
out += uGlareStrength · starRgb · (deficitFlux · ω_px / ∫P dΩ) · P(θ)
```

with `θ = atan(r_px · tanPerPx)` in degrees about the star's screen position, `ω_px = tanPerPx²`, and
`P(θ) = a/θ³ + b/θ²` — the **same** two-term PSF the pyramid's weights come from.

**Why this and not P8d's splat:** the pyramid is half-float too. At 1 AU the deficit is ~3.5e7
(value·px²) and one `down[0]` texel holds 4 px², so a single-texel splat needs ~9e6 and overflows.
Spreading it to fit needs a **21×21 texel = 42×42 px block, wider than the sun's own 11 px disc** — the
"point source" would be a flat blob and the aureole's shape would be destroyed. Levels 0–4 would all
need Float32 (~24 MB + bandwidth). Analytically it is ~10 ALU ops in a pass that already runs, exact at
every octave, and cannot overflow because the flux is a float32 uniform.

### 9.8a Verified numerically

| check | result |
|---|---|
| ∫(normalised PSF) dΩ over [0.05°, 51.2°] | **1.000000** ✅ |
| `∫P dΩ` shares `octaveEnergies` with `deriveGlareWeights` | ✅ one integral, not two |
| deficit at 1 AU (from the author's measurement) | 3.509e7 of 4.137e7 total = **5.59× the written flux** |
| analytic term vs the pyramid's own star contribution at 1° | **5.6×**, as it must be |

🔑 The energy identity: `∫ value dA_px = k · deficitFlux`, because
`∫ P_norm · ω_px dA_px = ∫ P_norm dΩ = 1`. So the analytic term and the pyramid are on the same scale
by construction, and adding them cannot double-count — the pyramid carries `writtenFlux`, this carries
`trueFlux − writtenFlux`.

⚠ `∫P dΩ` is a 10 × 1024 numeric integral, so it is **cached** (`getGlarePsfEnergy()`) and recomputed
only where `_crossover` changes. Calling `glarePsfEnergyTotal()` per frame would be 10,240 iterations of
`sin` in the frame loop.

### 9.8b 🐛 A third mislabelled quantity, same class as the other two

`fluxKept` was `writeBudget / peak` — a **peak** ratio reported as a flux fraction. At 1 AU it read
0.1244 where the true flux fraction is **0.1518**, because part of the soft edge sits below the cap and
is never clipped. Now derived from the same profile integrals the deficit uses.

🔑 That is **three** instances in this phase of a gate reporting a *neighbouring* quantity to the one it
named: the tinted-vs-untinted peak (§9.4b), the "no flux is discarded" line that meant "no channel
overflow", and this. The pattern is always the same — a plausible nearby number is easier to reach than
the one the label claims. **Measure what you name.**

### 9.8c The deficit is computed by integrating the shader's own profile

`discProfileFlux(peak, cap, radiusPx)` integrates `min(S(r)·peak, cap)·2πr dr` with `S` the identical
smoothstep the fragment shader applies. Closed-form algebra on an assumed hard disc would disagree with
what was actually written, because clipping happens **per pixel** and the soft edge is partly under the
cap. 64 samples, once per frame.

### 9.8d ⚠ Two things to check on device

1. **Y orientation.** `uv()` in the post chain and NDC do not agree about Y across three's backends, and
   this repo has lost time to exactly that before (`screenUV.y increases DOWNWARD` in `hdrCalibration`).
   Rather than guess, it is a runtime toggle: put the sun well off-centre vertically, and if the glare
   is centred on the opposite side, call **`__lum.starGlareFlipY(true)`**.
2. **Magnitude.** At 1 AU the term reaches ~21 game units at 1° from the sun (pre-exposed), i.e. ~92,000
   cd/m² absolute. ⓘ For reference, Stiles–Holladay's absolute veil formula (`10·E/θ²`) would give
   1.28e6 cd/m² there — ~12× more. That is *not* evidence of a bug here: `glarePass`'s header records
   that the CIE/Vos–van den Berg formula is not trusted for magnitude, and the pass is normalised
   instead by the integrated straylight fraction `k = 0.03`. But it does mean **`k` is the knob** if the
   veil still reads too weak after R3b — not this term's scale.

### 9.8e A/B

```
__lum.starPointGlare(false)   // pre-R3b: the clipped flux is discarded (P8d)
__lum.starPointGlare(true)    // R3b
__lum.starGlareFlipY(true)    // only if the glare is centred on the wrong side
```

Only the **veil and aureole** move; the disc is identical either way, so watch the space *around* the
sun and whether nearby stars wash out. `__lum.starGlare()` reports `pointGlareFlux`, `pointGlareUv` and
`psfEnergyTotal`; the term is idle wherever nothing is clipped (0.1 AU, and everything beyond ~5 AU).


---

## 9.9 R3b on device — three findings, one of them the real defect

### 9.9a 🐛 The Y default was wrong

`__lum.starGlareFlipY(true)` fixed it, so the default is now `true`. `uv()` in the post chain runs Y
opposite to NDC on this backend. Left as a toggle for the next backend.

### 9.9b 🔑🔑 The frame washed out to uniform grey at 1 AU — and it is an EXPOSURE bug

Measured with the author's own uniforms at 1 AU (`pointGlareRgb` 409.6, `preExposure` 9.206):

| θ from the sun | our veil | Stiles–Holladay `10·E/θ²` | ratio |
|---|---|---|---|
| 1° | 1.61e5 cd/m² | 1.28e6 | **0.13** |
| 5° | 3.87e3 | 5.12e4 | 0.08 |
| 25° | 1.34e2 | 2.05e3 | 0.07 |

🔑 **The veil's absolute luminance is 7–13× BELOW Stiles–Holladay, so its scale is not the problem.**
The problem is that its frame mean was **10× middle grey** while the meter reported EV **−3.47** — "this
scene is dark".

⚠⚠ **Because the analytic veil is added in the POST chain and `exposureMeter` reads the SCENE buffer,
the meter could not see the veil it was creating.** In a real eye the straylight *is* part of the
retinal image adaptation responds to, so this is a modelling gap, not a tuning problem. Fixed by adding
the veil's mean as a pedestal to `totalFlux` **before** the hot-tail split — it belongs in `restFlux`
because the veil is spatially broad and must not be treated as a compressible hot feature.

**Solved fixed point at 1 AU** (calibrated from the author's reading):

| | before | after |
|---|---|---|
| preExposure | 9.206 | **0.810** |
| metered EV | −3.47 | **+0.04** |
| veil pedestal | 10.0× mid-grey | **0.71× mid-grey** |

⚠ **Stability is real but not generous.** The loop gain is `g′ = −1.271`, so naive iteration would
diverge; the adaptation low-pass is what stabilises it (multiplier 0.854 at 60 fps, 0.926 at 120 fps —
so a *faster* follower is *less* stable). If the brightness visibly breathes on a ~1 s period with the
sun in view, that is this loop, and the fix is a longer adaptation time constant or damping the
pedestal — not reducing the veil.

### 9.9c 🔑🔑 R3b makes the half-float ceiling spread obsolete — deleted

With the clipped flux carried analytically, size never has to be traded for flux:

- **geometry** → `renderPx = max(discPx, DISC_PX_FLOOR)`, nothing else;
- **flux** → the disc keeps what fits, the eye's PSF carries the rest.

That deletes, in one change: the adaptation-dependent disc size, the §9.4 breathing, the ringing (the
reported 300 AU flicker), the `SIZE_RELEASE_TAU` follower needed to damp it, and the `sizedBy`
misreporting the author's data exposed (`"releasing"` at 5/8/30 AU where the ceiling was in fact the
dominant limit, its 0.6% release residual notwithstanding). The measured inflations it removes: **0.37 px
→ 11.8 px at 30 AU (32×)** and **2.2 px → 34.2 px at 5 AU (15.5×)**.

⇒ `sizedBy` is now only `"true"` or `"pixelFloor"`, and the residual P8d deficit is expected
**everywhere the disc clips**, not only where it is resolved — which is what R3b is for.


---

## 9.10 R3 + R3b verified on device — CLOSED

The veil→adaptation loop was solved before measuring, so this is a prediction check, not a fit:

| at 1 AU | predicted (§9.9b) | measured |
|---|---|---|
| metered EV | +0.04 | **+1.09** |
| preExposure | 0.810 | 0.392 |
| brightness breathing | stable (loop multiplier 0.854–0.926) | **stable, none observed** ✅ |

1.05 stops out, from a fixed point calibrated on a single earlier reading — direction and magnitude
right, and the washout is gone. Stability held, which was the open risk.

Final measured behaviour, `sizedBy` now only ever `"true"` or `"pixelFloor"`:

| range | disc true → drawn | clip ratio at the drawn size | R3b carries |
|---|---|---|---|
| 0.1 AU | 105.3 → 105.3 px | none | idle |
| 1 AU | 10.97 → 10.97 px | 2.26× | 5.80e6 |
| 5 AU | 2.20 → 2.50 px | 11.4× | 2.72e6 |
| 30 AU | 0.37 → 2.50 px | 2.06× | 2.53e5 |

ⓘ The clipping is worst around **3–6 AU**, where the disc sits just below `DISC_PX_FLOOR` so the
flux-conserving spread barely helps while the exposure is still fairly open. Inherent, and harmless:
R3b carries it, and the disc renders saturated white either way.

### 9.10a 🐛 The fourth mislabelled quantity in this phase

The gate printed *"wanted 5.171e+6, written 5.404e+4"* at 30 AU, implying **95.7×** of clipping. The
real clip ratio is **2.06×** — `unspreadPeak` is the peak at the disc's TRUE size while the written
value is at its DRAWN size, so the printed ratio conflated the *flux-conserving spread* (which loses
nothing) with *clipping* (which does). Now prints all three peaks with the spread factor called out, and
`drawnPeak` / `clipRatio` are published.

The historical `oldClampLossFactor` was removed rather than fixed: the sizing changed twice during R3, so
"what the old clamp would have discarded" no longer names a well-defined configuration. `fluxKept` and
`clipRatio` describe the present, which is what a gate is for.

🔑🔑 **FOUR instances in one phase of this gate reporting a quantity ADJACENT to the one its label
claimed** — tinted vs untinted peak, "no flux discarded" that meant "no channel overflow", `fluxKept` as
a peak ratio, and now true-size vs drawn-size peak. Every one was a plausible neighbour that happened to
be easier to reach. **A gate is only as good as the identity between its label and its expression, and
that identity needs checking as deliberately as the physics does.**


---

## 11. R4 as built — limb darkening derived, and the limb made sharp

### 11.1 🔑 The visible defect was the EDGE, not the gradient — measured first

| | value |
|---|---|
| disc mean radiance at 0.1 AU (author's reading) | 15,736 pre-exposed |
| display white clip (AgX scene-linear) | 16.29 |
| disc is above white by | **966× = 9.9 stops** |
| limb (0.42× the mean) is above white by | 406× |
| exposure reduction needed to reveal the gradient | **8.7 stops** |

⚠⚠ **So limb darkening is NOT visible on the Sun, and that is correct** — the naked eye cannot see
solar limb darkening either; photographs of it use heavy neutral density. The flat white disc in the
author's close-up screenshot is the right answer. What was *wrong*:

| | value |
|---|---|
| photosphere thickness / R☉ | 500 km / 696,340 km = 0.07% |
| ⇒ true limb sharpness on a 105 px disc | **0.038 px** |
| previous ±15%-of-radius smoothstep | **15.8 px** |
| too soft by | **418×** |

🔑 And all apparent softness *should* come from the eye's PSF, which `glarePass` calibrates — a shader
blur double-counts it, exactly as the hand-authored corona did in R3. So the limb is now antialiased
over `EDGE_AA_PX = 0.7 px` and nothing else.

### 11.2 The profile is derived from `T_eff` alone

Eddington grey atmosphere, `T(τ)⁴ = ¾·T_eff⁴·(τ + ⅔)`, with the emergent intensity

```
I_λ(μ) = ∫₀^∞ B_λ(T(τ))·e^(−τ/μ)·dτ/μ
```

evaluated per wavelength and integrated against the **same** `planck`/`xFit`/`yFit`/`zFit` kernel
`blackbodyLinearSrgb` uses, then least-squares fitted to `I/I(1) = 1 − a(1−μ) − b(1−μ)²` per
linear-sRGB channel. **No table, no fitted constants, nothing per-star.**

⚠ Substituting `τ = μ·s` makes the integral `∫B(T(μs))e^(−s)ds`, well-behaved at every μ including 0.
A first draft integrated in τ and returned exactly 0 at the limb for every wavelength — a pure
step-size artefact that read as infinitely strong limb darkening.

✅ **Validated against published solar limb darkening with nothing fitted:**

| λ | derived `u` | measured (solar) | ratio |
|---|---|---|---|
| 400 nm | 0.790 | ~0.90 | 0.88 |
| 550 nm | **0.662** | ~0.70 | **0.95** |
| 700 nm | 0.569 | ~0.55 | 1.03 |
| frequency-integrated | **0.600** | 0.600 (classic Eddington) | **1.000** — algebra check |

### 11.3 🔑 Why it generalises: the wavelength dependence is physical

Limb darkening is set by how sensitive `B_λ` is to temperature at that wavelength, so it becomes
stronger for cooler stars and toward the blue automatically:

| T_eff | `I_limb/I_centre` (G) | limb reddening R/B | centre/mean (G) |
|---|---|---|---|
| 3000 K | **0.082** | **3.8×** | 1.604 |
| 4500 K | 0.226 | 2.1× | 1.367 |
| 5772 K | 0.333 | 1.6× | 1.273 |
| 10000 K | 0.538 | 1.25× | 1.155 |
| 30000 K | **0.737** | 1.05× | 1.078 |

A hot star is nearly a flat disc; an M dwarf has a dramatic edge and a visibly redder limb. **None of
that is authored.** ⚠ Grey-atmosphere limits (convection, molecular opacity worst for M dwarfs, NLTE)
are accepted: the alternative is Claret-style per-`(T_eff, log g, band)` tables — exactly the baked
per-star data this project forbids — for a few percent in the visible.

### 11.4 Flux conservation

The shader multiplies the profile by `1/discMeanNorm` where `discMeanNorm = 1 − a/3 − b/6`, so the
disc-mean is exactly 1 and limb darkening **cannot change the star's luminosity** — which matters
because `discLuminanceNits` derives the disc-MEAN radiance from the star's total flux. ✅ The closed
form matches a numeric integration of the exact profile to **0.03%** (R 1.00031, G 0.99987, B 0.99904).

### 11.5 🔑 The clamp moved to the assembled vec3, and that retires a whole class of bug

R4 adds a **second** per-channel gain (the limb centre boost, up to 1.60× at 3000 K) on top of the
blackbody tint. The R3 fix — a scalar budget of `60,000 / max(r,g,b)` — would have had to track both,
and would go stale the next time a per-channel term appears.

⇒ The shader now clamps the **assembled colour** per channel at `HALF_FLOAT_WRITE_MAX`, which is
correct for any combination of tint and profile by construction. `uWriteBudget` is gone; `writeBudget`
survives only as the CPU-side cap for the deficit integral, and is simply 60,000.

⚠ `discChannelFlux` replaced `discProfileFlux` for the same reason: the clamp is per pixel **and per
channel**, so the clipped flux is redder or bluer than the star depending on which channel saturated
hardest, and R3b's analytic PSF now carries that colour rather than re-tinting a scalar.

### 11.6 Predicted readings (falsify these)

| range | disc true → drawn | brightest channel | clips | `fluxKept` | R3b carries |
|---|---|---|---|---|---|
| 0.1 AU | 122.6 → 122.6 px | 2.15e4 | no | 1.000 | idle |
| 1 AU | 12.8 → 12.8 px | 6.00e4 | yes | 0.503 | 7.76e6 |
| 5 AU | 2.57 → 2.57 px | 6.00e4 | yes | 0.144 | 3.40e6 |
| 30 AU | 0.43 → 2.50 px | 6.00e4 | yes | 0.510 | 3.48e5 |

`fluxKept` drops slightly against R3b's numbers — expected, because the limb's centre boost raises the
peak into the cap. Gates: `__lum.limbDarkening()`, `__lum.starLimb(0|1)`.

### 11.7 ⚠⚠ RETRACTED: a visor is NOT required — the threshold is `d/R★ ≈ 3`, for every star

The first draft of this section claimed surface detail needs ~8–9 stops of deliberate attenuation and
so has to wait for a filter/visor. **That was wrong, and the author's own measurement refuted it:** at
**0.01 AU the Sol disc reads −1.43 stops, i.e. BELOW display white**, and the gate correctly says the
profile should be visible.

**The rule, from this repo's own measured exposure law** (`project_exposure_coverage_law`: rendered
brightness ∝ coverage^(−`ADAPTATION_K`), K = 0.85):

```
rendered peak  ∝  discRadiance^0.15 · coverage^(−0.85)
```

🔑🔑 **Surface brightness enters only as the 0.15 power — it barely matters. Coverage dominates, and
coverage is set by angular size 2R/d, so the visibility threshold is a RATIO of stellar radii and is
almost the same for every star.** Measured against the author's two readings (11.03 stops per decade of
distance): Sol's disc reaches display white at **0.0135 AU = 2.90 R☉**, where it subtends **39.6°** —
i.e. the disc has to fill most of the frame.

| star | T_eff | R (R☉) | surface lum vs Sol | threshold distance |
|---|---|---|---|---|
| Sun (G2V) | 5772 | 1 | 1.00 | 2.0e6 km (**2.9 R★**) — a sungrazer |
| Proxima (M5.5V) | 3042 | 0.154 | 1.8e−2 | 0.44e6 km (4.1 R★) |
| Sirius A (A1V) | 9940 | 1.71 | 7.1 | 2.9e6 km (2.4 R★) |
| Arcturus (K1.5III) | 4286 | 25.4 | 0.21 | **0.39 AU** (3.3 R★) |
| Antares (M1.5Iab) | 3660 | 680 | 7.6e−2 | **11.5 AU** (3.6 R★) |
| Betelgeuse (M1-2Ia) | 3600 | 764 | 6.7e−2 | **13.1 AU** (3.7 R★) |

🔑 **So giants are where this is free.** "Three stellar radii" is a lethal 2 million km at the Sun but a
completely comfortable **13 AU** at Betelgeuse — and red supergiants are exactly the stars with the most
dramatic profile: `I_limb/I_centre` = **0.084** at 3600 K against Sol's 0.332, with **3.9×** limb
reddening against 1.6×. A supergiant seen from 13 AU fills ~40° of sky with a bright centre fading to a
deep orange-red limb, naked-eye, no equipment. It will work automatically once R2b mounts catalogue
stars, because the whole profile is derived from `T_eff`.

⇒ **R5 (granulation, spicules) does NOT need to wait for a visor** — it shares this threshold exactly.
A visor would only extend the effect to stars you are *not* nearly touching.

### 11.8 ✅ Checked and NOT a problem: the flat billboard at close range

The visible regime is the *close* regime, where a flat billboard is a poor model of a sphere — the
shader's `μ = √(1 − ρ²)` is the orthographic limit, while the true value for an observer at `D = d/R` is
`μ = (D cos α − 1)/√(D² − 2D cos α + 1)` with the silhouette at `cos α = 1/D`. Measured error in the
rendered intensity:

| `d/R` | worst error over the disc |
|---|---|
| 10 | 0.1% |
| 5 | 0.3% |
| **2.9** (visibility threshold) | **0.8%** |
| 1.5 (grazing the photosphere) | 3.7% |

Negligible where it matters, so the orthographic form stays. Recorded because "the approximation breaks
exactly where the feature becomes visible" was a plausible worry that turned out to be false — and
without the check it would have looked like a reason to build spherical geometry.

### 11.9 ⓘ Two different flux-conservation numbers, both correct

`__lum.limbDarkening()` reports the disc-mean deviating **0.0000011%** from 1, while §11.4 quotes
**0.03%**. They measure different things and neither is wrong: the gate checks the *analytic identity*
`1 − a/3 − b/6` against a numeric integral of the **fitted** law (exact by construction, so ~0), while
§11.4 compares the fitted law against the **exact Eddington** profile (0.03% — the fit residual).


---

## 12. R2b as built — a catalogue star through the same renderer

### 12.1 What ships

| piece | file |
|---|---|
| catalogue → game-frame km + derived `StarParams` | [`sim/nearbyStars.ts`](../src/sim/nearbyStars.ts) |
| promotes one star to `<Star>`, suppresses its sprite | [`Star/NearbyStarDisc.tsx`](../src/components/Star/NearbyStarDisc.tsx) |
| marker gates (player toggle / dev reveal-all / discovered set) | [`store/starMarkers.ts`](../src/store/starMarkers.ts) |
| star + **Sol** markers | [`POI/POIProjector.tsx`](../src/components/POI/POIProjector.tsx) |
| `resolveStarWarp` | [`perf/scenarios.ts`](../src/components/space/perf/scenarios.ts) |
| `ly/s`, `pc/s`; `DistanceUnit` km/AU/ly/pc | [`sim/units.ts`](../src/sim/units.ts) |

**Which star gets promoted is derived, not chosen:** the largest **angular diameter** `R/d`. From Sol
that is **Rigil Kentaurus (α Cen A)** — 4.32 ly, derived R 1.343 R☉, T_eff 5568 K, magV −0.01.
⚠ Angular size rather than distance specifically because Toliman and Rigil Kentaurus sit at the *same*
4.32 ly, so a nearest-first rule would flap between them every frame; `SWAP_MARGIN = 1.05` adds
hysteresis on top.

**Sprite suppression is matched by DIRECTION, not index** — `stars_visual.bin` (8,920) and
`stars_nearby.json` (166) share no index space, so a dot product against the catalogue direction is the
only index-free match. ⚠ It uses the direction **from Sol**, which is where the sprite is drawn; the
live direction from the ship diverges once you leave and would un-suppress the sprite mid-flight.

### 12.2 🐛🐛 R2's continuity proof did NOT cover the shipped image — two display gains

R2 established T0↔T1 agreement to **1.6e-16 stops**, and §12's first draft leaned on that: "this is a
mounting problem, not a physics one". ⚠⚠ **That was true of *physical* flux and false of what is
actually drawn**, because `StarField` multiplies every sprite by **two** display gains that the disc
path has neither of:

| gain | value | nature |
|---|---|---|
| `STAR_ARTISTIC_GAIN` | **1024×** | flat; compensates a sub-pixel PSF diluting a point's peak |
| `starCompressionFactor(magV)` | `STAR_MAGNITUDE_COMPRESSION = 0.6` | **per-star**, and it bites hard |

| star | magV | compression | true sprite gain |
|---|---|---|---|
| Sirius | −1.44 | 0.054 | **54.9×** |
| Rigil Kentaurus | −0.01 | 0.091 | **93.0×** |
| Toliman | 1.35 | 0.150 | 153.6× |
| mag 6.5 (anchor) | 6.50 | 1.000 | 1024× |
| Proxima | 11.01 | 5.267 | **5394×** |

🔑 I caught the flat gain first and wired only that — which would have made Rigil Kentaurus **11×
(3.46 stops) too bright**. The per-star one was the second, easier-to-miss half. *Two* artistic gains on
one path, and finding one is not finding them.

**Fixed** by a `unresolvedGain` prop carrying their product, which **tapers to 1 as the disc resolves**
(smoothstep in `discPx` over `[0, DISC_PX_FLOOR]`). ⚠ Not a fudge: `StarField`'s own comment on the
gain says a properly concentrated PSF makes *"the dilution term here go to 1 by construction"*, and a
resolved disc IS properly concentrated. The taper is what that sentence asks for.

✅ **Verified EXACT.** With both gains carried, the disc's flux equals the sprite's:

```
disc flux = discRadiance · Ω · gain · preExp / tanPerPx²  =  E · gain · preExp / tanPerPx²  =  sprite flux
```

Numerically for Rigil Kentaurus: **4.59420e1 vs 4.59420e1, ratio 1.000000.** The π/4 of the disc's area
and the 2πσ² of the Gaussian cancel against `psfNorm` identically.

⚠ The gains remain a ~6.5-stop lie while unresolved, inherited deliberately. Retiring them must happen
on **both** paths in one change or the handover breaks again — the Venus-trim cancellation shape.

### 12.3 Test infrastructure

- **Dev → warp to star**: a dropdown of the 12 notable nearest stars + a distance with a **unit**
  (km/AU/ly/pc), and a hint showing derived `T_eff`, R in R☉, and the ~3 R★ distance at which limb
  darkening becomes visible for *that* star.
- **Dev → warp to body** now takes a unit too (it was km-only).
- **Max speed** gains `ly/s` and `pc/s`. ⚠ 1 ly/s is ~3.15e7 c — the nearest star is 4.24 ly and
  untraversable at any physical speed, so these exist purely to make the trip playable.
- **Markers** for every catalogue star inside `STAR_MARKER_MAX_LY = 20`, **plus Sol** — which the
  celestial-body loop deliberately skips (`type === "star"`), and which is the one marker that matters
  most once you have left. Arrival stand-off is `5 × params.radiusKm`, derived, so autopilot stops
  outside a supergiant as readily as outside a red dwarf.

### 12.4 ⚠ What R2b does NOT do

- The promoted star is **not a light source** — `SunLight` still serves the primary.
- **No sky parallax.** The sprite field still places all 8,920 stars by their direction *from Sol*
  (`S5` in STAR_CATALOGUE_PLAN), so the sky behind you is wrong the moment you leave. The promoted star
  and its marker use live 3D positions, so the star you are flying *to* behaves correctly.
- Only **one** star is promoted. α Cen is a binary; its companion stays a sprite.


---

## 13. Interstellar architecture (R7) — proposed, not built

The author's question: *"properly promoting the other stars when we get closer, including SunLight
and colliders, the sky parallax… support multi-star systems out of the box. And it doesn't really make
sense to allow only one star to be promoted — what if two systems with very large stars are near each
other?"*

**Agreed, and R2b's one-star limit was a stopgap, not a design.** What follows is the shape that gets
there without a rewrite.

### 13.1 🔑 The one idea: tier is a per-frame FUNCTION, and every tier is a fixed-size POOL

There is no "primary" and no "promoted star" — there is one catalogue, and each star's rendering tier
is derived every frame from its angular size and its illuminance at the ship:

| tier | selector | cardinality | cost |
|---|---|---|---|
| **sprite** | default | ~10⁴ | 1 instanced draw |
| **disc** (`<Star>`) | `2R/d` over a pixel threshold | **pool of ~4** | 1 draw each |
| **light** | illuminance at the ship over a threshold | **pool of ~4** | uniform array |
| **occluder / collider** | within ~10³ R★ | **pool of ~2** | registry entry |

🔑🔑 **Fixed-size pools are the load-bearing decision, and for a WebGPU-specific reason.** The slots
exist for the lifetime of the scene; only their *contents* change. So promoting a star is a **uniform
write**, never a mount or a graph rebuild — which is what avoids the shader-compilation stutter this
repo already documents. It also makes the cost a constant the perf budget can hold, independent of how
many stars are nearby.

⚠ **R2b violates this today and it must be fixed first:** `Star`'s material `useMemo` lists
`uLimbA/uLimbB/uLimbGain` in its deps, and those are rebuilt when `tempK` changes — so changing which
star a slot holds rebuilds the NodeMaterial. The fix is small: keep the uniform *objects* stable for the
slot's lifetime and only ever write `.value`.

### 13.2 ⚠⚠ The artistic gains have to go FIRST, and that is not optional

`STAR_ARTISTIC_GAIN = 1024` and `starCompressionFactor` (`STAR_MAGNITUDE_COMPRESSION = 0.6`) are
display lies on the sprite path only. §12.2 already shows what they cost — a 3.46-stop error from
catching only one of them. **With parallax they get qualitatively worse**, because a star's apparent
magnitude changes as you fly, so the compression factor changes, so its brightness would swim
non-physically during a journey. And the disc↔sprite handover needs the gains carried across, which
means every tier boundary inherits them.

🔑 Phase 8's glare PSF is the sanctioned replacement — `StarField`'s own comment says a properly
concentrated PSF makes "the dilution term here go to 1 by construction". **Retire both gains on both
paths in one change** (the Venus-trim cancellation shape: fixing one side alone doubles the error), then
`unresolvedGain` and its monotonicity cap delete themselves.

### 13.3 Sky parallax (S5) is cheap; the precision worry is unfounded

Store 3D positions in the instance buffer instead of directions, and in the vertex shader:

```
dir   = normalize(aPosLy − uCamPosLy)
illum = aIllumAtCatalogueDist · (aDistLy / |aPosLy − uCamPosLy|)²
```

⚠ Float32 for `aPosLy` is fine and the arithmetic says so: a 24-bit mantissa gives ~6e-8 relative, so
the **direction** error is ~6e-8 rad (0.012 arcsec) — four orders below a pixel. It is the *brightness*
term that needs care, not the geometry: it is a difference of large numbers when the camera is close to
a star, so clamp `|Δ|` at that star's own radius.

⇒ Two attributes and two shader lines. The reason it has not landed is §13.2, not difficulty.

### 13.4 Multi-star is mostly NOT a rendering problem

Rendering N stars is the pool above. The real work is that **one-star assumptions are baked into the
lighting chain** — `atmospherePass`, `skyIrradiance`, `planetshine`, `sunOcclusion`'s dominant-body
skip, and the exposure meter all take a single star direction. 36 references across 5 files.

Staging that keeps each step shippable:

| step | scope |
|---|---|
| **R7a** ✅ | Stabilise `Star`'s uniforms (§13.1) — done, §14.1 |
| **R7b** ✅ | ~~Retire~~ **REPLACE** both artistic gains — §13.2's framing was wrong, see §14.2 |
| **R7c** | `stars[]` in the system description; `STAR_*` singletons in `celestialConstants` become `stars[0]`. This is the seam R2 named and never cut |
| **R7d** | Disc pool of 4 + occluder pool — pure rendering, no lighting change |
| **R7e** | Light pool of 4 for the LOCAL scene (ship, asteroids). Atmosphere stays single-dominant-star — a second sun in a planet's sky is a much bigger piece |
| **R7f** | Sky parallax (§13.3) |
| **R7g** | Atmosphere/sky-irradiance for N stars — the genuinely large one |

⚠ **R7e's boundary is the honest compromise:** a binary companion would light your hull and the
asteroids correctly, but a planet's sky would still be lit by one star. Worth doing in that order
because R7e is bounded and R7g is not.

### 13.5 What this buys, physically

The α Cen system is the test case that motivates all of it: A and B orbit at 11–36 AU, so from a planet
there you would see **two suns of different colour** (G2V 5568 K and K1V 4996 K) with two shadows, and
Proxima as a bright red point 0.2 ly away. Every number needed for that is already derived from the
catalogue — §12 showed radius, temperature and disc radiance all come out of `(absMagV, B−V)`. The
architecture above is what lets more than one of them be on screen at once.


---

## 14. R7a + R7b as built

### 14.1 R7a — every uniform created once

All 13 of `Star`'s TSL uniforms are now `useMemo(..., [])`; per-star values (blackbody colour,
limb-darkening coefficients) are pushed to `.value` in an effect keyed on the props. The material's
`useMemo` lists only those stable objects, so **the NodeMaterial is built exactly once per mount**.

🔑 That is the §13.1 prerequisite: a pool slot can now re-point at a different star with uniform
writes rather than a graph rebuild, which is what makes the disc pool free of shader-compile stutter.
Before this, `uScale` was keyed on `radiusKm` and `uStarColor`/`uLimb*` on `tempK`, so changing which
star a slot held recompiled.

### 14.2 ⚠⚠ R7b — §13.2 said "retire the gains". That was WRONG, and the author's reason is why

§13.2 called `STAR_ARTISTIC_GAIN` a display lie to delete. The author's reason for it:

> *"I wanted players to pretty much always see at least some stars to help them orientate. Before
> that, I had scenarios where they were somewhere far away from any planet, but the ship was brightly
> lit by the star. So the auto exposure kicked in and the whole sky around them was pitch black and no
> star was visible anywhere. I think this a) looks bad/unexpected and b) can be disorientating."*

⚠ **That sky is physically CORRECT** — astronauts in daylight cannot see stars, which is why daylight
orbital photographs have black skies. MEASURED: with a sunlit hull filling the frame the meter settles
near `preExposure ≈ 0.13` and Sirius renders at **8.9e-5**, ~2,000× below middle grey. So the gain is
**not a defect to delete — it is a legitimate readability aid**, and the job was to make it honest.

🔑🔑 **And measuring it showed the flat gain serves that requirement badly in BOTH directions:**

| adaptation state | `preExposure` | Sirius, physical | flat gain gives | lift needed for target 0.03 |
|---|---|---|---|---|
| deep space, dark adapted | 600 | **0.401** (already visible) | ×55 → 22, clipped hard | **1.0×** |
| outer system | 47 | 0.031 | ×55 | 1.0× |
| 1 AU, sun in frame | 0.39 | 2.6e-4 | ×55 → 0.014, marginal | 115× |
| sunlit hull fills frame | 0.13 | 8.9e-5 | ×55 → 0.005, still invisible | **338×** |

**Too little exactly where help was wanted, too much where none was needed.** (The flat term is 1024
but `starCompressionFactor(−1.44) = 0.054`, so Sirius only ever got 55×.)

⇒ Replaced by [`space/starVisibility.ts`](../src/components/space/starVisibility.ts): one **global**
scalar derived from the adaptation state,

```
lift = clamp(STAR_VISIBILITY_TARGET / (anchorIllum · psfNorm · preExposure), 1, STAR_LIFT_MAX)
```

with `STAR_VISIBILITY_TARGET = 0.03` (mid-grey is 0.18; below ~0.01 a point is invisible) and
`STAR_ANCHOR_MAG = 1.5` (~the 20 brightest stars — the classic navigation set). What that buys:

- **Exactly 1.0 in deep space** — no lie at all in the regime that was already right.
- **Global**, so sprites, the Milky Way band and a promoted disc all read the same uniform. Tier
  continuity is free instead of hand-carried — R2b had to thread the gain across the sprite→disc
  handover by hand, and catching only one of the two gains cost 3.46 stops.
- **Preserves relative star brightness exactly**, unlike the magnitude compression.
- **Bounded**, and it inherits the adaptation follower's smoothing, so it cannot pop.
- **One reportable number**, which is what makes LIGHTING_PLAN's P7d/P8 ("the artistic gains lie to
  the scotopic driver") fixable rather than merely documented — there is now a single scalar to divide
  out, and `__lum.star()` already does.

⚠ `STAR_MAGNITUDE_COMPRESSION = 0.6` is **kept** and is the remaining distortion: it changes the
*ratios* between stars, and being magnitude-dependent it will swim under parallax (S5). It is a
separate decision from the lift, and it needs the author's judgement on the look, so it is left alone
rather than bundled in.

⚠ `STAR_ARTISTIC_GAIN` and `SKY_ARTISTIC_GAIN` are retained but no longer applied — only
`__lum.starLift("legacy")` reads them, to reproduce the old look for comparison.

### 14.3 How to judge it

```
__lum.starLift()            // mode, lift, and whether it is faking anything
__lum.starLift('legacy')    // the flat 1024× this replaced
__lum.starLift('off')       // fully physical: the pitch-black sky the gain was added to fix
__lum.star('Sirius')        // the flux gate — still divides the lift out
```

The three judgements:
1. **Deep space** — `faking` should be **false** and the lift **1.0**. ⚠ Stars will be *dimmer and
   smaller* than before, because they are no longer multiplied by 55–850×. This is the biggest visible
   change and the one to judge first.
2. **Sunlit hull, sun out of frame** — the original bad case. The bright stars should now be *more*
   visible than with the flat gain (338× vs 55×), while faint ones still fade, which is what
   "orientate by the bright ones" wants.
3. **Flying between the two** — the lift is continuous and inherits adaptation smoothing, so watch for
   any pop as it leaves 1.0.


### 14.4 🐛🐛 Two HIGH defects the adversarial review caught (11 refuted, 4 confirmed)

**(1) `MilkyWaySkybox` never applied the lift.** The band kept `.mul(float(SKY_ARTISTIC_GAIN))` — the
flat 1024× — while the sprites moved to `uStarLift`. §14.2's claim that the lift is *"global, so
sprites, the Milky Way band and a promoted disc all read the same uniform"* was **false as built**.

⚠ Consequence, from the repo's own measured numbers (deep space, `preExposure = 600`, lift = 1): the
band stays at 0.0127 scene-linear while Sirius drops from 22 to **0.022** and a mag-6.5 sprite from
0.274 to **2.7e-4**. So the brightest star renders at 1.7× the band and the faint half of the catalogue
sits ~48× *below* it, against ~21× *above* it before — **a ~10-stop shift in the relative weight of the
two halves of the same sky.** Exactly the failure R2b §12.2 records ("catching only one of the two
gains cost 3.46 stops"), an order of magnitude larger. `__lum.starLift('off')` also could not produce a
physical sky, because the band ignored the mode entirely.

🐛 **Process cause, worth recording: the edit script printed `ok sky lift` and then aborted on a later
assertion, before writing.** The dead `uStarLift` import it left behind was the only trace. Third
occurrence of that pattern in this session. **Verify an edit by grepping the file afterwards; a
scripted "ok" is not evidence the file changed.**

**(2) The promoted disc's lift was frozen.** `unresolvedGain={getStarLift() * …}` was evaluated during
React *render*, and `NearbyStarDisc` only re-renders when the promoted star changes — so the value
froze at selection time. Promoted in deep space (lift 1) then flying to a sunlit hull (lift ~338) left
the promoted star as **the one star in the sky that did not brighten**, and since its sprite is
suppressed it simply vanished. Worse than the flat gain it replaced, which at least could not go stale.

⇒ Split the prop by what varies: `applyDisplayLift` (a boolean; `Star` reads the **global** lift inside
its own `useFrame`, so it tracks adaptation) and `magnitudeCompression` (a scalar, legitimately stable
because it depends only on apparent magnitude). 🔑 The global/per-star split is also the
architecturally right place for each half, which is a hint the first version was wrong on structure and
not just on timing.

⚠ Still open from the review: `Star/SkyLight.tsx:101` reads `SKY_ARTISTIC_GAIN` for the sky probe's
intensity and is currently consistent with the *unlifted* band. Now that the band is lifted, that
probe and the band are on different scales. Both must move in one commit (the Venus-trim cancellation
trap), and P7d's finding — that the hull, not the band, is the dimmest thing that must stay visible —
means a lifted band with an unlifted probe re-creates "band bright, hull crushed" in the other
direction. **Not fixed here; it needs the sky-light calibration re-measured.**


### 14.5 ⚠⚠ R7b IS PARKED: the gain has a THIRD role, and it is numerical

Default mode is now **`"legacy"`**, i.e. bit-equivalent to pre-R7b. `"auto"` is opt-in via
`__lum.starLift('auto')`.

R7b assumed `STAR_ARTISTIC_GAIN` had two jobs — a flat display lift and (via
`starCompressionFactor`) a per-star range compression. **It has a third, and it is not a look knob at
all:** [`space/skySpecular.ts`](../src/components/space/skySpecular.ts) bakes the gain into the sky
**cube capture**, and says exactly why —

> *"The captured cube is a half-float texture, and the physical sky is ~1e-8 game units against
> RGBA16F's smallest subnormal of 2⁻²⁴ = 5.96e-8 — so a physical capture underflows to black."*

⇒ In deep space, where `"auto"` **correctly** reports lift = 1.0, the captured cube goes **black** and
the hull loses its sky lighting and reflections outright. A numerical failure, not a matter of taste,
and one I introduced.

🔑 The fix separates two quantities that were sharing one constant:
- a **fixed encode scale** for the capture, chosen against the underflow margin and divided out on
  read — the capture's job is to survive half-float, and that has nothing to do with adaptation;
- the **adaptation-driven lift** for what the player sees.

`withStarCaptureResolution` is already the hook that knows a capture is in progress, so the band's
shader can multiply by `CAPTURE_SCALE / lift` during capture and leave the total fixed.

⚠⚠ **Three roles, and I found them one at a time — flat lift (R7b), per-star compression (§12.2,
3.46 stops), capture encode (here, total loss of hull lighting).** The lesson is not "look for a third
gain" but: **a constant that has survived a long time in a physically anchored system has usually
acquired jobs nobody wrote down. Enumerate its readers before redefining it, not after.** `grep` for
the symbol was not enough — `skySpecular` explains its dependency in prose, in a *different* file from
the one that declares the constant.

### 14.6 Two reported bugs — one diagnosed, one hypothesis

**(a) "The star shines right through the ship and asteroids, only celestial bodies occlude it."**
🔑 CONFIRMED, and it is R3b's analytic veil, not the disc. Pass 4 draws the local scene (ship,
asteroids) *on top* of the scaled scene, so the **disc** is correctly occluded. The **veil** is added in
the post chain, after that composite, so it paints over everything — and its only attenuation is
`starVis`, which is the *celestial* occluder registry. That is both halves of the report exactly.

⚠ Physically the veil *should* cover the ship — straylight is added after the retinal image forms — but
its **amplitude** must go to zero when the source is blocked. So the fix is the occlusion factor, not
the pass order. Options, cheapest first: extend the star's occlusion test to the ship's bounding sphere
on the CPU (covers the dominant, always-present case); or sample framebuffer depth at the star's UV
(`viewportDepthTexture` exists in this three build) which covers ship *and* asteroids exactly but needs
a sampleable depth attachment `rt` does not currently have.

**(b) "Turning back toward the sun shows a quick bright flash before it comes into view."**
⚠ HYPOTHESIS, not diagnosed: the veil is added in the post chain **instantly**, while its own
contribution to adaptation reaches the meter only through the async readback (several frames) plus the
adaptation time constant. So there is a window where the veil is at full strength at the *old*
exposure. Some flash is correct — turning toward the sun should dazzle — but the *latency* is not.
**To confirm:** watch `__lum.starGlare()`'s `pointGlareFlux` and the metered EV across the turn; if the
flux jumps a frame or more before EV responds, that is it.


### 14.7 🐛 The "smaller reddish disc that is not occluded" — diagnosed and fixed

The author's report was more specific than my §14.6 diagnosis and pinned it exactly: *"the large
whiteish disc of the sun is (partially) occluded properly, but at the centre there is a smaller, reddish
disc that is not occluded… only with HDR… at 10 AU the star doesn't change much when occluded… at really
close distances, where the star fills the screen and no veil is visible, occlusion works fine."*

Every clause follows from R3b's analytic veil:

| observation | cause |
|---|---|
| a separate small disc, unoccluded | the veil is composited AFTER the local scene |
| **reddish** | `_deficitRgb` carries Sol's tint `[1.11, 0.98, 0.91]` |
| **only in HDR** | its core is ~1e6 pre-exposed; SDR clips it to white along with the real disc |
| 10 AU: occluding changes little | the disc is sub-pixel there, so the veil is nearly all of the star |
| very close: occlusion fine | nothing clips ⇒ `deficit = 0` ⇒ **no veil at all** |

🐛 **And a second defect inside it: the PSF's inner cutoff was a fixed `GLARE_THETA_MIN_DEG = 0.05°`.**
The PSF goes as θ⁻³, so evaluating it at 0.05° while the star's angular *radius* is much larger
manufactures a bright core:

| distance | Sol's angular radius | spurious core over-brightness |
|---|---|---|
| 0.1 AU | 2.665° | **43,383×** |
| 1 AU | 0.267° | **126×** |
| ≥ 5 AU | ≤ 0.053° | 1× (no artefact) |

Which is exactly why it is only visible close in. **Fixed:** the cutoff is now the star's own angular
radius (`atan(R/d)`, not the small-angle form — they differ at 2.67°). 🔑 Physically right, not a
patch: the PSF describes light scattered *away* from the source, so inside the source's own silhouette
it has no meaning — and the light that belongs there is already drawn, by the disc. Flattening at the
limb removes the artefact *and* stops the veil double-counting the disc's own flux.

⚠ STILL OPEN — the veil does not dim when the ship partially covers the star. Physically the veil
*should* cover the ship (straylight is added after the retinal image forms), but its amplitude must fall
with the fraction of the source that is blocked, and a bounding-sphere test cannot resolve a wing. That
needs a depth read at the star's UV (`viewportDepthTexture`), which needs a sampleable depth attachment
`rt` does not have. Lower severity now that the 43,383× core is gone.

### 14.8 ✅ The deep-space hull, re-measured on a coherent build

The author re-tested after the band fix: *"the ship is mostly black in deep space, with only the
brightest parts of the Milky Way faintly reflecting off the most reflective surfaces."* That is the
capture-underflow prediction of §14.5 confirmed from the other side — and note it is **not** obviously
wrong-looking, it is simply very dark. Whether real starlight *should* leave a hull that dark is
LIGHTING_PLAN's P7d question, and it can only be answered once the capture has its own encode scale, so
that "dark" is a physical result rather than a half-float artefact.


### 14.9 ✅ Veil occlusion — fixed with the pyramid, not a depth attachment

§14.7's θ-min fix removed the spurious 43,383× core but left the veil itself unoccluded, and the author
confirmed that directly: *"I can still see the sun clearly through the ship, even when it is fully
occluded."*

🔑🔑 **The key realisation is that `updateGlare` is handed the FULLY COMPOSITED target** — Pass 4's
local scene (ship, asteroids) has already been drawn into it — so this pass's own `_down[0]`, the
half-res reduction it builds anyway, already knows whether the star is covered. Sampling it at the
star's screen position and comparing against the radiance the star is *known* to have written gives a
graded visibility in **one texture tap**:

```
seen = luminance(down0.sample(uStarUv))
vis  = saturate(seen / expectedLum)      expectedLum = min(uCoreRadiance, writeBudget)
```

Why it needs no footprint correction: the disc is always ≥ `DISC_PX_FLOOR` = 2.5 px, so it always fills
a half-res texel ⇒ the texel's average at the disc centre *is* the disc's radiance. And the 13-tap
downsample averages a ~5×5 neighbourhood, so **partial** coverage grades rather than snapping.

⚠ It is a colour test, not a depth test — deliberately. `rt` carries a depth *renderbuffer*, not a
sampleable texture, so a real depth read needs a target change plus an MSAA resolve; the colour test
needs neither and sees everything the frame actually drew, which is what the depth test would have told
us. Separation is ample: at 0.1 AU the sunlit hull sits ~3e-5 of the disc's written radiance.

⚠ No feedback loop: the veil is added in the post chain and never written back into `rt`, so the probe
cannot see its own output.

⚠ **The off-screen case is explicitly excluded.** `sample` clamps outside [0,1], so an off-screen star
would read a dark edge texel and be treated as occluded — killing the veil from a star just outside the
frame. That veil is real (it is why you squint before the sun enters your field of view) and the author
noticed it working, so an *untestable* star is treated as unoccluded rather than hidden.

⚠ Not verified on device by me — the browser pane cannot hold a WebGPU context here. The check is:
fully hide the sun behind the hull at 1 AU and confirm the glow goes with it, then confirm a star just
off the frame edge still veils.

---

## 15. R7b unparked — the sky capture's encode scale, separated from the display lift

**Status: built 2026-09-02. Not verified on device by me** (the browser pane cannot hold a WebGPU
context in this session); the checks are listed at the end.

### 15.1 What was actually wrong

R7b replaced the flat `STAR_ARTISTIC_GAIN = 1024` with an adaptation-driven lift, and had to be parked
at `mode: "legacy"` because the constant turned out to have a **third role nobody had written down**:
`space/skySpecular.ts` leaned on it for half-float headroom. The sky is ~1.33e-8 game units against
RGBA16F's smallest subnormal of 2⁻²⁴ = 5.96e-8, so a capture at unit scale stores **black**. In deep
space, where "auto" correctly reports a lift of 1.0, the environment cube went dark and the hull lost
all sky lighting and reflections.

🔑 The two quantities were never the same question:

| | LIFT | ENCODE |
|---|---|---|
| answers | "how visible must the sky be to the player" | "where in half-float do these numbers live" |
| owner | adaptation | the storage format |
| cadence | every frame | fixed for the life of a capture |
| is it a lie? | yes, deliberately | no — divided straight back out on read |

### 15.2 🐛 And it was hiding a second defect: pre-exposure applied twice

`skySpecular`'s own header claimed *"`uPreExposure` stays OUT of the texture and is applied per frame
through the environment node"*. **Nothing implemented that.** Both sky materials multiply by
`uPreExposure` in their graphs, so the capture baked in the capture frame's pre-exposure and
`buildEnvNode` applied the live value again.

⚠ **Dormant at startup, detonating later** — which is exactly why it survived review and every gate.
The capture ran ~5 frames after the skybox mounted, before the exposure follower's first async readback
lands, so `preExposure ≈ 1` and the squaring was invisible. The first `invalidateSkyCube()` — an
interstellar jump, i.e. the feature this work exists to enable — re-captures at the **live**
pre-exposure: order 1e5 in deep space, ~5e-5 with a sunlit planet in frame. The hull's reflections
would then be wrong by that factor.

🔑 The reason no gate caught it is stated in the gate itself: `skyProbe()` validates the capture's
**inputs** (`uPsfNorm` retargeted to the cube face) and says in a comment that it never looks at the
output. A check that only ever validates inputs cannot catch a defect in what is written.

### 15.3 As built

`space/skyCaptureEncode.ts` (new, leaf module — imports nothing but `three/tsl`):

```ts
export const uSkyCaptureScale = uniform(1);   // multiplied into BOTH sky graphs, last
export const uSkyEnvDecode    = uniform(1);   // applied by skySpecular's environment node
export function skyCaptureScaleFor(meanRadiance: number): number
export function withSkyCaptureEncode<T>(scale, displayFactor, body): T
```

Both sky graphs end in `× uPreExposure × uStarLift`, so one uniform cancels both:

```
during capture:  uSkyCaptureScale = scale / (preExposure × lift)   ⇒ stored = radiance × scale
on screen:       uSkyCaptureScale = 1                              ⇒ unchanged, bit-for-bit
on read:         pmrem × uSkyEnvDecode × uPreExposure × uStarLift  ⇒ physical × live display factors
```

⚠ **Rejected: temporarily overwriting `uPreExposure.value` and `uStarLift.value` during the capture.**
It needs no shader change at all, and that is precisely the problem — it makes the cube's scale
invisible at every site that determines it, and it mutates two globals every other material in the
scene reads. An explicit uniform costs one multiply in two shaders and cannot leak.

⚠ The environment node now applies `uStarLift` as well, which it previously got for free from the
baked-in gain. That is required, not incidental: `SkyLight`'s invariant is that *the hull must be lit
by the sky the player can SEE*.

### 15.4 The scale is derived, and the round trip is bit-exact

`skyCaptureScaleFor` places the panorama's **measured** mean radiance at 1.0 in the stored texture,
rounded to a power of two. Two properties earn their keep:

* **It adapts.** The mean comes from `skyIrradiance`'s bake of the actually-loaded panorama, so a
  different sky asset — or a procedurally generated one — gets a correct scale with no table to update.
  This is the same discipline as D09's runtime albedo measurement: never a constant table.
* **The round trip is exact.** A power of two divides out with no rounding whatever, so decoupling the
  encode introduces **zero** photometric error. The gate asserts `scale × decode === 1` literally.

MEASURED ON DEVICE by `__lum.skyCapture()` — all six faces, solid-angle weighted (mean
1.3466e-8 game units ⇒ **scale 2²⁶ = 6.711e7**):

| stored quantity | encoded value | verdict |
|---|---|---|
| Ω-weighted mean | 0.9864 | centre of range |
| max | 25.43 | 2.58e3× under the 65504 ceiling (11.3 stops) |
| min non-zero | 1.31e-3 | 21.5× over the smallest normal (4.4 stops) |
| texels stored as exactly 0 | 1 / 393,216 | |
| texels in the subnormals | 0 / 393,216 | |

⚠ Two of my predictions were off, both harmlessly, both worth recording:

* the max is the **panorama's** brightest texel (25.4), not Sirius' PSF peak in a cube face (predicted
  20.8) — the galactic core sets the ceiling constraint, not the brightest star, so a brighter
  catalogue is not what would push this over;
* the darkest non-zero texel is 1.31e-3, not the 7.66e-3 I predicted from "8-bit level 1". The panorama
  is UASTC, which decodes to finer values than the sRGB quantisation step, so the dim-end margin is
  4.4 stops rather than 7.0. Ample, but do not reason about this asset as if it were 8-bit.

The whole sky spans ~14 stops in the cube while half-float's normal range spans 27, so the placement is
not delicate — it just has to be done at all.

⚠ **The capture does not WAIT for the bake, and an earlier draft of this made it do so.** The measured
mean is 0 until `bakePanoramaSh`'s async readback resolves, and gating the capture on it would mean one
failed readback kills two systems — reflections as well as the SH probe. The fallback is
`SKY_TARGET_MEAN_RADIANCE = SKY_DIFFUSE_TARGET_NITS / NITS_PER_GAME_UNIT`, which is what the panorama's
mean radiance *is* by construction (`SKY_RADIANCE_SCALE` is defined to make it so) — derived, not
authored. The measured value still wins once it arrives, because it is the one that would reveal a
stale `SKY_TEXTURE_MEAN_LINEAR`.

Driving the capture off `isSkyCubeCaptured()` instead of a local one-shot is what makes
`invalidateSkyCube()` work with no further wiring.

### 15.5 The capture is now amortised — one face per frame

The user's requirement: *"we also need a good LOD transition when doing interstellar travel without
loading times. If modern engines have a solution for this, take inspiration there."*

They do, and it is the same one: **Unreal's SkyLight "Real Time Capture"** and **Unity HDRP's dynamic
ambient probe** both re-capture the sky on a rolling schedule and time-slice the convolution, rather
than invalidating and rebuilding in a single frame. A sky that *changes* — an interstellar transit —
needs re-capturing continuously, and a 6-face burst is a visible hitch every time it happens.

`FACES_PER_CALL = 1`, so `captureSkyCube` draws one face per frame and returns true only on the call
that completes a set. Cost estimate for the burst it replaces: 6 faces × (one sky sphere + all 8,920
sprite quads, no frustum culling) ≈ 3.4M sprite pixels plus PMREM — a few ms in one frame, and a
permanent per-frame tax under continuous re-capture. Amortised it is ~1/6 of that, spread.

🔑 **Mixed old/new faces are invisible while the sequence runs, and that is not luck:** materials
sample the *PMREM*, a separate texture regenerated only when the sixth face lands. The double-buffering
the amortisation needs already existed. `invalidateSkyCube()` therefore causes **no black frame** — the
old PMREM keeps serving until the new set is complete.

⚠ **`cube.texture.needsPMREMUpdate = true` is mandatory on a re-capture and was missing.** `PMREMNode`
regenerates only when `texture.pmremVersion` changes, and only that setter bumps it (verified in
three 0.183.2: `Texture.js:762`, `PMREMNode.js:50`). Without it a re-capture writes six fresh faces the
roughness lookup never sees, and the hull keeps reflecting the old sky — a bug that would have looked
like "the jump didn't update the reflections" and been blamed on the capture.

⚠ The **scale is frozen when a sequence starts** while the **display factor is read per face**. That
asymmetry is deliberate: six faces at six encodings is a cube with seams the decode cannot undo, while
per-face display correction means all six still store `radiance × scale` even if the player turns
toward the sun mid-sequence.

⚠ And the **decode is published only when the set completes** (`commitSkyCaptureScale`, called in the
same step as `needsPMREMUpdate`). The first version set it at the start of the sequence, which pairs a
new scale with the *old* texels for six frames — invisible while the scale is unchanged, wrong by the
ratio the moment it is not. Same class as the Venus-trim cancellation trap: two halves of one factor
must move together.

### 15.6 `STAR_LIFT_FLOOR` — what makes "auto" shippable

With the numerical blocker gone, the remaining objection to `mode: "auto"` was the author's own
on-device reading in deep space at lift 1.0: *"the ship is mostly black... only the brightest parts of
the milky way faintly reflecting"*.

⚠ My R7b framing — "1.0 in deep space, no lie at all in the regime that was already right" — **was
wrong about which regime was right.** The anchor is a *star*, and holding a star at the visibility
target says nothing about the Milky Way **band**, whose surface brightness is orders of magnitude below
a star's PSF peak. The band and the hull need help that the anchor rule does not supply.

So the rule gained a floor:

```
lift = clamp(TARGET / anchorPeak, STAR_LIFT_FLOOR, STAR_LIFT_MAX)
```

🔑🔑 **With `FLOOR = 1024`, "auto" is a strict superset of "legacy".** It is bit-identical wherever the
old flat gain was already enough and can only ever add lift where it fell short — so there is no regime
the flip can make worse, which turns it from a look gamble into a one-way improvement. And the value is
not arbitrary: 1024 is what `SKY_ARTISTIC_GAIN`'s measured hull-contrast table settled on (at ×64 the
sky-lit hull sat 3.7× above AgX's black floor and was crushed; at ×1024, 59.5× and visible). Keeping
the floor there preserves that measurement exactly.

`SKY_ARTISTIC_GAIN` is now retired — nothing reads it. The constant and its table stay in
`MilkyWaySkybox.tsx` because the table is the justification the floor cites.

### 15.7 🐛 `STAR_LIFT_MAX = 4096` defeated the whole point

MEASURED (computed from the shipped constants, not eyeballed): with a sunlit hull at
`preExposure ≈ 0.13` the anchor rule asks for **×4.47e4**. The old ceiling of 4096 clipped that by a
full decade, so the anchor still rendered ~11× below the target — **the aid did not work in the one
case it was built for**, which is precisely the case the author described.

Raised to **65536**. The derivation self-limits (the anchor lands at exactly `TARGET`, never above), so
the ceiling only guards against a bogus input — `psfNorm` from an unmounted field, a pre-exposure of
~0 — not against the rule running away. Where it lands, per pose:

| pose | preExposure | lift asked for | bound |
|---|---|---|---|
| deep space | ~1e5 | ×0.058 | **floor** — constant 1024, unchanged from shipped |
| sunlit hull, no planet in frame | 0.13 | ×4.47e4 | **none** — anchor lands exactly on target |
| sunlit planet filling the frame | ~5e-5 | ×1.1e8 | **ceiling** — stays hopeless, correctly |

That last row is the right answer, not a shortfall: you cannot see stars beside a sunlit planet, and
the ceiling means the renderer stops trying.

### 15.8 ⚠⚠ The lift closes a positive loop with the exposure meter, and I first claimed it could not

My first draft of `starVisibility`'s header argued the lift "cannot feed back", because in the
unclamped regime `preExposure × lift` is constant, so a sky pixel's **buffer** value never moves. That
much is true and it is **not sufficient**: the meter divides pre-exposure back out — it must (D25) — so
it recovers `physical × lift` and sees the sky brighten as the lift rises. Loop gain is exactly the
sky's share of the metered luminance, and it is positive.

🔑 What actually makes it safe is the two bounds and *where they bind*:

* the lift only grows large when adaptation is bright, and adaptation is bright because something
  **sun-lit** is in frame — whose luminance the lift does not touch. So the share, and therefore the
  gain, is small exactly when the lift is moving;
* the one pose whose entire frame scales with the lift (deep space, where even the hull is lit by the
  sky) is the pose where `needed` collapses far below the floor — so the lift is a constant there and
  the loop is **open**;
* both ends are hard-clamped, so even a marginal-gain excursion is bounded rather than divergent.

⚠ The structural fix is the one LIGHTING_PLAN's **P7d-ii** already names: a per-pixel sky mask, so the
lift can be applied *after* metering instead of inside the radiance the meter reads. Until then
`__lum.starLift()` reports `clampedBy`, which doubles as the honest read on whether the loop is
currently open or live.

### 15.9 `__lum.skyCapture()` — the gate that closes the input-only gap

Three checks, in order of how decisive they are:

1. **Round trip** — `scale × decode` must be exactly 1.
2. **Range** — reads back all six faces (solid-angle weighted; a corner texel subtends
   3^(−3/2) = 0.192× a centre one, so an unweighted mean cannot be compared against a whole-sky
   radiance) and reports the stored mean/min/max against half-float's limits, **including how many
   texels stored as exactly zero** — the underflow that started all of this. It also divides the scale
   out and compares the implied physical sky mean against the panorama's, expecting 1.0–1.24× (the cube
   also carries the sprites, worth 19.5% of sky flux at full strength and less after the magnitude
   compression).
3. 🔑 **The falsification test** — re-capture under a 997× pre-exposure override with the lift forced
   off, and assert the stored texels do not move. That tests exactly the property being claimed, needs
   no flux model to interpret, and is the check that would have caught **both** defects in §15.1 and
   §15.2. It reports the display-factor ratio alongside, and refuses to pass as "inconclusive" if the
   factor did not actually move (e.g. pre-exposure pinned by another gate).

The failure message discriminates: if the stored-mean ratio *tracks* the display-factor ratio, a
display factor is not being divided out (check both graphs end in `.mul(uSkyCaptureScale)`); if it does
not track, suspect a third factor in one of the two graphs.

### 15.10 What to check on device

1. `__lum.skyCapture()` — expect ✅ on the round trip, ✅ adaptation-free, 0 non-finite texels, a
   min-non-zero margin comfortably above the smallest normal, and an implied-mean ratio between 1.0
   and 1.24. ⚠ A large "stored as exactly 0" count is *not* a failure: the starless panorama has
   genuinely black texels away from the galactic plane, and 0 stores exactly. The discriminator for
   underflow is the min-non-zero margin — an underflowing capture has no small-but-representable
   values at all, only zeros and a handful of bright stars.
2. `__lum.starLift()` in three poses — deep space (expect `clampedBy: "floor"`, lift 1024), near Earth
   with the hull sunlit (expect `clampedBy: "none"` and a lift of order 1e4), and with a sunlit planet
   filling the frame (expect `clampedBy: "ceiling"`).
3. **The look call, which is the point of the exercise:** in the inner system with the hull sunlit the
   sky is now ~44× (5.5 stops) brighter than it shipped, because the anchor rule is finally allowed to
   reach its target. Expect the brightest ~20 stars as clear points and a faint hint of the Milky Way's
   brightest structure; the mean band stays below AgX's black floor, so it should not read as washed
   out. If it does, `STAR_VISIBILITY_TARGET` is the one knob — everything else is derived.
4. Deep space should be **unchanged** from what shipped. If it is not, the floor is not binding and
   something else moved.
5. `__lum.starLift('legacy')` remains the A/B; `'off'` is now a deliberate way to ask P7d's question
   (does real starlight alone keep the hull visible) rather than something the default answers for you.

### 15.11 What this unblocks

* **R7f (parallax)** — the sky changes continuously during a transit, so the environment must be
  re-captured continuously. That needed both the decoupling (a re-capture must not depend on the
  exposure at capture time) and the amortisation (it must not cost a hitch). Both are now in place;
  what remains is deciding *when* to invalidate, which is a function of how far the ship has moved
  relative to the nearest stars' parallax.
* **P7d / P8** — the lift is one reportable number the scotopic driver and the exposure meter can
  divide out, which is what makes those defects fixable rather than merely documented.
* `invalidateSkyCube()` still has **no callers**. That is correct today: the sprite field places all
  8,920 stars by their direction *from Sol*, so the sky genuinely does not change yet. It changes the
  moment R7f lands.

### 15.12 ⚠⚠ MEASURED ON DEVICE: the plumbing was right and `STAR_VISIBILITY_TARGET` was wrong by 16×

`__lum.skyCapture()` passed everything it was built to test — round trip exactly 1, **adaptation-free
across a 15.76× change in the display factor** (stored mean 9.86401e-1 → 9.86401e-1, ratio
1.000000), 0 non-finite texels, 0 subnormals, `uPsfNorm` exact, implied physical sky mean 1.091× the
panorama's own (inside the predicted 1.0–1.24 band). §15.1–§15.11 are confirmed.

The look was still wrong at 1 AU, and the gate's own `starLift` output localised it in one read:

| pose | preExposure | `needed` | carried by | **anchor rendered at** | author's verdict |
|---|---|---|---|---|---|
| 1 AU, sun behind | 5.59 | 1038 | the **rule** | **0.030** | "a handful of the brightest stars, very dim" |
| 3 AU | 89.4 | 63.3 | the **floor** | **0.486** | "closer to what I would have expected at 1 AU" |
| deep space | ~250 | 4.10 | the **floor** | **7.49** | "perfect — reflects realistically off the ship" |

🔑🔑 **THE DEFECT WAS A STEP DOWN AT THE CROSSOVER, AND ONLY A POSE THAT CROSSED IT COULD SHOW IT.**
Where the floor carried, the anchor rendered at 0.486–7.49. The instant the anchor rule took over it
pinned the anchor at `TARGET = 0.03` — **16× dimmer than the floor it exists to extend**. The rule was
*darkening* the sky, not lifting it. Both halves were individually defensible: the floor was measured
(the hull-contrast table), the target was authored from first principles ("middle grey is 0.18 and a
point below ~0.01 is invisible, so 0.03 is a clear but unobtrusive point"). Neither is wrong on its own
terms; their *composition* was, and `clampedBy` is what made that legible.

⚠ Note this is not the same error as §15.7's ceiling. There the bound clipped the rule so it could not
reach its target; here the **target itself** was the wrong place to aim. §15.7 was measured from the
constants; this one could only be measured by looking.

**Fix: `STAR_VISIBILITY_TARGET = 0.03 → 0.5`**, which is the author's own endorsed 3 AU reading (0.486)
rounded. Consequences, all derived:

* the rule becomes **continuous with the floor** at the endorsed pose — `needed` at 3 AU goes to 1055
  against a floor of 1024, a 3% step instead of a 16× one;
* **deep space is untouched** — `needed` there becomes 68, still far below the floor, so the pose the
  author called perfect does not move at all;
* the **band** matches the endorsed pose too, not just the anchor: at 0.5 the Milky Way's mean lands at
  1.27e-3 display-linear at 1 AU against 1.24e-3 at 3 AU;
* every catalogued star clears 0.03 (the faintest, mag 6.5, lands at 0.0316), so the sky fills in
  rather than showing "a handful";
* the ceiling still does its job. `needed` exceeds 65536 below preExposure ≈ 1.48, so the sky fades as
  a lit body enters the frame: ~0.17 at 0.3 AU with the ship lit, 1.7e-5 with a sunlit planet filling
  the frame. You still cannot see stars beside a sunlit planet.

🔑 It remains the ONE knob, and the relationship is exact: whenever the rule is in charge the
mag-`STAR_ANCHOR_MAG` star renders at precisely `STAR_VISIBILITY_TARGET`. "Twice as bright" is 1.0.
0.3–1.0 is the sensible band.

**To check:** 1 AU with the sun behind should now look like the 3 AU screenshot — the star field filled
in and the Milky Way's brightest structure legible. 3 AU should be imperceptibly brighter (3%). Deep
space must be **identical** to the pose already endorsed; if it moved, the floor is not binding and
something else changed.

---

## 16. R7f as built — the sky becomes a 3D field

**Status: built 2026-09-02. Not verified on device by me** (the browser pane cannot hold a WebGPU
context in this session); `__lum.parallax()` is the gate, and §16.9 lists what to look at.

### 16.1 Why this and not R7c/R7d/R7e

You could already warp to α Cen and see a correct, limb-darkened disc. What you could not do was
*travel* there, because all 8,920 sprites were placed by their direction **from Sol**:

* the constellations were frozen at the view from Earth wherever you went;
* **Sol never appeared as a star behind you** — from α Cen it is a magnitude 0.44 point, one of the
  brighter things in that sky;
* the star POI markers already used live 3D positions while the sprites did not, so past ~1 ly you got
  an arrow pointing at empty sky with the star somewhere else entirely. A live bug, not a future one.

§13.3 had already sketched the fix and said *"the reason it has not landed is §13.2, not difficulty"* —
§13.2 being the artistic gains, which R7b replaced and §15 finished. It is also what the §15 sky-capture
work was a prerequisite for: a moving observer means the environment cube must be re-captured
continuously, which needed both the adaptation-decoupling and the amortisation.

### 16.2 The core change: two `length()` calls

```
rel    = aPosLy − uCamPosLy
dLive  = max(length(rel), DIST_EPS_LY)
dCat   = max(length(aPosLy), DIST_EPS_LY)
illum  = aIllum · (dCat/dLive)²
dir    = rel / dLive                       // still billboarded onto the fixed shell
```

The instance buffer now carries the 3D position where it carried a unit direction. **`STRIDE` is
unchanged at 7** — `dir(3)` became `posLy(3)`, nothing was added.

🔑 **The `(dCat/dLive)²` form rather than a re-referenced `1/dLive²` is deliberate**, and it is what
makes the change unable to regress the solar system: at `uCamPosLy = (0,0,0)`, `x − (+0) === x` bitwise
for every finite x, so `rel` is `aPosLy` bit-for-bit, `length()` of identical bits is identical bits,
`x/x` is exactly 1.0 in f32, and `1.0²` is exactly 1.0. **The illuminance inside the solar system is
bit-identical to what shipped.**

⚠ The *direction* is not, and an earlier draft of this section claimed "bit-identical" without
qualification. It used to be normalised on the CPU in f64 and rounded once; it is now normalised on the
GPU in f32. Measured across the shipped catalogue: **6,259 of 8,920 rows change by ≥1 ulp, worst 0.028
arcsec** against 293 arcsec/px at 1080p. Nil visually — but do not write a gate that asserts bit
equality of positions, and do not re-validate anything direction-sensitive on the assumption that
nothing moved.

### 16.3 🐛🐛 The sprite suppression never fired, and that was a live 1.0-stop bug

R2b suppressed the promoted star's sprite by matching its direction:

```ts
uSkipCos.value = Math.cos(1e-4);                    // 0.999999995
const suppress = aDir.dot(uSkipDir).greaterThan(uSkipCos);
```

three stores uniforms in a `Float32Array`, and the ulp below 1.0 in f32 is 5.96e-8, so
`Math.fround(Math.cos(1e-4)) === 1` **exactly** — verified. The shipped test was therefore the strict
`dot(aDir, uSkipDir) > 1.0`, which two unit vectors cannot satisfy in exact arithmetic. It could only
pass by rounding error upward, and measured over the 11 promotable nearby stars it passed for **0 of
them**.

⇒ **The promoted star was drawn twice — additive sprite plus additive disc, exactly 2× flux, 1.0 stop
— on the one star R2b certified continuous to 1.6e-16 stops.** Every photometric continuity number in
§12 is 20× smaller than the error sitting on top of it.

⚠ The old comment claimed 1e-4 rad was "far looser than float error". It is the opposite: an f32 dot of
two independently-rounded near-unit vectors lands within ±1 ulp of 1.0, and `acos(1 − 5.96e-8)` is
**71 arcsec** — so the authored 20.6 arcsec tolerance was 3.4× *tighter* than the arithmetic can
resolve. The smallest tolerance whose cosine is even representable below 1.0f is 50.4 arcsec.

⚠⚠ And the tolerance could never have worked: **α Cen A and B are 19.19 arcsec apart as seen from
Sol**, inside the 20.63 arcsec tolerance, so promoting either suppressed both. Harmless while they
overlap in one 0.2 px blob — and R7f is exactly what opens it, because their live separation grows as
25.4 AU / d. At 100 AU that is 14.6° = 268 px, with α Cen B at apparent magnitude −15.8 (brighter than
the full Moon's illuminance) drawn by nothing at all.

**Fix: match by catalogue row index.** `instanceIndex` against a float uniform is exact arithmetic —
f32 represents every integer below 2²⁴ and the catalogue is 8,920 rows — with no tolerance to get
wrong. The cross-file index problem (`stars_visual.bin` has 8,920 rows, `stars_nearby.json` 166, no
shared index space) is solved **once at promotion time**, not per frame in a shader — see §16.3b for
how that cross-walk had to be built, because the obvious version of it also failed silently.

### 16.3b 🐛🐛 …and my replacement failed silently too, for a different reason

I matched the two catalogues on |Δposition| with a 1e-4 ly tolerance, on a review's assurance that
α Cen A and B "match their rows to 5.5e-6 and 5.9e-6 ly". **MEASURED against the actual shipped files:
the error is 7.46e-4 ly — about 100× larger.** So every star failed the tolerance, the lookup returned
−1 for all of them, and the promoted stars stayed double-drawn.

⚠ It had no direct symptom. It surfaced as `__lum.skyCapture()` reporting a **stored max of 57,163
against a 65,504 ceiling** at 100 AU from α Cen, and an implied sky mean 3.4× the panorama's — an
unsuppressed magnitude −15.9 sprite saturating the environment cube. §16.7's vertex clamp is the only
reason that was a bounded clip rather than the +Inf that would have NaN'd every PMREM mip.

🔑 **The error is radial, and it is by design.** `nearbyStars` builds positions as `dir × distLy`
because `distLy` is the column `absMagV` was computed from, while `stars_visual.bin` stores |posLy|.
The two differ in the last printed digit — 4.32016 vs 4.3209 — which is 7.4e-4 ly of pure radial
offset. A position metric mixes that into the same scalar as the angular separation it is trying to
resolve, and the margin collapses: best 7.465e-4 against runner-up 8.484e-4 on the α Cen pair, a **13%
margin**. It was one rounding away from picking the wrong star even if the tolerance had been right.

**Fix: separate the two axes** — angular separation ≤ 2 arcsec AND |d/d′ − 1| ≤ 1%. Both scale-free, so
it works at 4 ly and at 300 ly. MEASURED over all 166 nearby stars:

| | | |
|---|---|---|
| Rigil Kentaurus → row 5365 | separation **0.169″** | \|d/d−1\| 1.7e-4 ✅ |
| Toliman → row 5364 | separation **0.266″** | \|d/d−1\| 1.7e-4 ✅ |
| α Cen A↔B separation | **19.20″** | — the thing that must not be confused |
| Proxima (V 11.01, no sprite) | 5746″ | rejected ✅ |
| Barnard's (V 9.54, no sprite) | 2492″ | rejected ✅ |
| | **31 matched, 135 rejected** | **0 magnitude mismatches among the matches** |

🔑 That last figure is the real validator, and it is the kind worth reaching for: `magV` is a column the
matcher does not use, so every match agreeing with it is an *independent* check that it paired the
right stars. A margin (23× above the worst true match, 10× below the pair separation) says the metric
is well conditioned; the magnitude agreement says it is actually right.

⚠⚠ **THE PROCESS LESSON, which is the expensive one.** The 5.5e-6 figure came from a subagent that
reported it as measured, and I wrote it into the plan and set a tolerance from it without checking. It
was wrong by 100×, and it was wrong in the direction that silently disabled the fix I was shipping. A
number that sets a threshold has to be measured by whoever sets the threshold — the two data files were
sitting on disk and the check took one command.

`__lum.starPool()` now exists so this class cannot be silent a third time: it prints, per promoted
star, the sprite row it resolved to, and errors on any slot holding a mounted disc with row −1. The
suppression has failed silently twice with no symptom except a photometric anomaly somewhere else;
"which stars are promoted, and did their sprite rows resolve" needed to be one command.

### 16.4 The disc pool is 2, because α Centauri is the first destination

R2b promoted exactly one star and called it a stopgap. §16.3's 268 px hole is what makes it a defect
rather than a simplification: with one slot, whichever of α Cen A/B is not promoted is drawn by the
sprite tier at a brightness the format cannot hold. Two slots is the smallest number that makes the
first interstellar destination correct.

Both slots stay mounted for the scene's lifetime and only their *contents* change — §13.1's
fixed-size-pool rule — so promotion is a set of uniform writes and never a NodeMaterial rebuild.
Hysteresis (`SWAP_MARGIN = 1.05`) is compared against the incumbent's **current** angular size, and at
most one swap is committed per frame so two near-tied orderings cannot oscillate.

### 16.5 🐛 The gain expression had to change, and `max(1, G)` was the wrong fix

R7f puts the magnitude compression on the **live** illuminance, which is what keeps the sprite tier and
the disc tier on one rule: the sprite's `E_anchor·(E/E_anchor)^γ` is identically `E·C(E)` with
`C(E) = (E_anchor/E)^(1−γ)`, and that is exactly what the disc multiplies into its gain.
`starCompressionForIlluminance` is the single implementation both call — verified identical to
`starCompressionFactor(m)` to **6.4e-16 stops** over magnitudes −2…8.

But `C ∝ d^0.8`, so **G falls below 1 as you approach a star**, and the shipped
`gain = min(G, 1/fluxScale)` is only safe while G > 1. MEASURED for α Cen A at the lift floor:

| pose | G | `min(G, 1/fs)` | consequence |
|---|---|---|---|
| 0.02 AU (the pose already validated for limb darkening) | 1.8e-4 | 1.8e-4 | **12.43 stops of dimming** |
| 1 AU | 4.1e-3 | 4.1e-3 | 7.92 stops |
| Sol at 1 AU, with the primary lifted | 5.0e-3 | 5.0e-3 | 7.66 stops |

⚠ **`max(1, G)` was the obvious fix and it is wrong**, because the expression is shared by both mount
sites and so applies to the promoted catalogue star too — reinstating exactly the cross-tier mismatch
R2b exists to prevent. MEASURED: **2.86 stops at the α Cen A/B promotion swap (80 AU), and 3.46 stops
with the lift off** — the latter being, to three digits, the historic figure `starVisibility` records as
the cost of wiring only one of the two gains. In the swap case α Cen A would **dim by 2.86 stops in a
single frame as you flew toward it**, with hysteresis making it a brightness loop rather than one event.

**Fix — the resolution-gated form:**

```ts
gain = min(pow(unresolvedGain, 1 − fluxScale), 1 / max(fluxScale, 1e-30))
```

`fluxScale` is exactly 1 iff the disc is resolved, so the exponent is 0 and the gain is exactly 1
whatever G is — the sun at 1 AU is untouched. `fluxScale → 0` gives the sprite's own G, so the tiers
agree. MEASURED: monotone in rendered **flux** across a 1.25×-step ladder from 0.5 AU to 6 ly at
lift ∈ {1, 1024, 65536}, and the 80 AU swap step collapses from 2.86 stops to **0.016**.

⚠ Monotonicity must be checked on **flux**, not peak. My first sweep flagged a spurious +0.023-stop
step because in the resolved regime the radiance is distance-independent while the gain grows as d^0.8,
so the *peak* legitimately rises with distance while the *area* shrinks faster. All three candidate
expressions are monotone in flux.

### 16.6 The primary is lifted now too

`<Star>` for Sol gets `applyDisplayLift`. Without it, at 4 ly Sol would render **~110× (6.8 stops)
dimmer than its catalogue neighbours of the same apparent magnitude**, because every sprite around it
carries `lift × C`. With the live compression and the resolution-gated gain it lands at exactly the
gain a sprite of the same live magnitude gets — Sol at 4.3209 ly has m 0.441, C 0.1073, G 109.9,
matching a mag-0.441 sprite to 0.000 stops.

The gain's crossover for Sol is at **769 AU**, and Sol is already unresolved beyond ~4 AU, so the lift
never engages anywhere inside the planetary system.

### 16.7 ⚠⚠ The half-float ceiling, which is what parallax actually removes

Before R7f the sprite fragment returned raw radiance with **no `min()` anywhere**, and that was safe
for one reason only: `aIllum` had a fixed catalogue ceiling — Sirius at 1.585e-9 game units — with no
distance term in the graph at all. `(dCat/dLive)²` is unbounded above, and γ = 0.6 only softens the
growth to d^−1.2; it does not bound it.

Unbounded means **+Inf in an RGBA16F target**, and the cube path makes it unrecoverable: one +Inf texel
goes through the PMREM blur and turns *every* roughness mip into NaN, taking the hull's whole
environment with it, with no fallback (the SH probe is pinned to 0 once `envAssigned` latches). The
cube's ceiling is a constant because `uSkyCaptureScale` cancels adaptation by construction and the
encode scale comes from the position-independent panorama mean: **apparent magnitude −16.03**, reached
at 91 AU (Toliman), 170 AU (Rigil Kentaurus), 656 AU (Sirius), 797 AU (a median mag-6.5 star). The
compression *flattens* this, so every one of the 8,920 sprites overflows somewhere in 90–800 AU —
"arrive anywhere" is the trigger, not "arrive at a bright star".

On screen it bites earlier and the exposure meter cannot save it: at the frame where the pixel reaches
65,520 the sprite carries ~3% of the frame's flux, so a mean-luminance follower has moved 0.04 stops.

**Fix, and the bound is derived in the graph:**

```
writeMultiplier = uPsfNorm · uPreExposure · uStarLift · uSkyCaptureScale
peakIllumCeil   = HALF_FLOAT_WRITE_MAX / writeMultiplier
vIllum          = compress(illumLive).min(peakIllumCeil)
```

plus a per-channel `.min(vec3(HALF_FLOAT_WRITE_MAX))` on the assembled colour, because `vColor` is
luminance-normalised and a channel legitimately exceeds 1 (Sol's red is 1.1103) — the same trap two
reviewers caught in `Star.tsx`.

Three things about that shape matter:

* **In the graph, not on the CPU.** `withCaptureResolution` retargets the PSF *before*
  `withSkyCaptureEncode` sets the encode scale, so any CPU-side product would be computed against a
  stale capture scale for the whole capture.
* **At the vertex, i.e. on the PEAK**, so the Gaussian below it is untouched. A fragment-side clamp
  would flatten the core into a widening plateau, making apparent size a function of brightness — the
  adaptation-coupled breathing R3b deleted from the disc tier.
* **Not a distance floor.** Solving the format ceiling for a per-star minimum distance gives
  `dCat·√(E_cat/E_ceil)`, which depends on both the star's distance and its magnitude; measured across
  the catalogue that spans **100,520×**, so one scalar set for the tightest star throws away ~17 stops
  of parallax for the rest and set for the loosest does nothing. `DIST_EPS_LY` survives only as an
  anti-NaN guard, and is documented as such.

### 16.8 🐛 The catalogue SH light probe was never re-baked, and it is not inert

A comment in the parse loop claimed the interstellar case "comes free because a jump re-derives
directions here". **It did not**: `setCatalogueSh` was reachable only from `parseCatalogue`, which runs
from a `useEffect` keyed on a url that never changes.

And the belief that it would not matter — that `SkyLight` pins the probe to 0 once the environment cube
is assigned — is true only for the **local** scene. `getSkySh()` sums the panorama and catalogue halves
and has a second, live consumer in the **scaled** scene: `CelestialBody` renders `skyIrradianceNode`
from it every frame, for every body and every tier, and the environment cube never reaches that scene.
So the catalogue SH is the *only* carrier of the star catalogue's **19.5% of sky flux** onto every
planet's night side — and under parallax it would be pointed the wrong way and scaled to the wrong
distance, permanently, with no diagnostic.

`rebakeCatalogueShFor(camPosLy)` re-runs **only the SH loop**, reading the colours back out of the
parsed rows. That distinction is the whole reason it is affordable: the accumulation is ~0.84 ms over
8,920 rows while the per-star blackbody×CMF integral is ~88 ms, so re-deriving colours would turn a
1 ms job into a 90 ms main-thread stall. It is fed the **uncompressed** live illuminance — the
compression is a display knob, and folding it into a light probe would break the physical/artistic split
and stop `__lum.skyProbe()` measuring physics.

**Thresholds (`space/skyParallax.ts`), both derived, from different limits.** Both scale with `d_ref`,
the distance to the nearest star the *sprite* tier still draws:

| | limit | threshold | at `d_ref` = 4.32 ly | events over a 4.32 ly transit |
|---|---|---|---|---|
| cube | angular: one 0.352° cube texel | `6.14e-3 · d_ref` | 0.0265 ly | 163 |
| SH | photometric: `dE/E = 2Δ/d`, 0.14 stops | `0.05 · d_ref` | 0.216 ly | 20 |

⚠⚠ **`d_ref` excludes the promoted stars**, and that is not a detail: as you approach your destination
its distance goes to zero, so a naive nearest-star rule would demand a re-capture every frame at
exactly the moment you are moving fastest. A star that close is a `<Star>` disc drawn from its live
position — its parallax is exact every frame and contributes nothing to the cube's staleness. The
(POOL+1)-th nearest is used instead, which keeps the rule bounded through an arrival.

⚠ **A re-capture cannot be started while one is in flight.** The capture is amortised to one face per
frame (§15.5), and at 1 ly/s the threshold fires every ~3 frames while a set needs 6 — the sequence
would restart for ever and never complete. `pendingFace === 0` is the gate; the cost is that worst-case
staleness is one sequence's travel rather than one threshold's, which is the honest price of amortising.

### 16.9 `__lum.parallax()` — a falsification test, because a measurement cannot catch this

The failure mode R7f can have is a **wrong frame or sign**, and no self-consistent measurement catches
that: `project_sky_orientation` records four independent checks that all passed while the panorama was
mirrored. So the gate offsets the ship **perpendicular** to a named star's Sol-referenced direction —
which is what maximises the parallax, since offsetting *along* it changes nothing — and then aims twice:

1. at `normalize(posLy − camPosLy)`: the star **must** be at the centre;
2. at the **Sol-referenced** direction: the star must **not** be there.

A renderer that ignored `uCamPosLy` passes (2) and fails (1). One with a sign or frame error fails
both. Only a correct one passes both. `await __lum.parallax()` uses Sirius with a 1 ly offset, giving a
**6.63°** separation — 160 px, far outside the 9 px probe window — and passes on a contrast above 30×.

It also checks the photometric half separately (measured flux vs `(dCat/dLive)²`-scaled prediction,
±15%), because the direction can be right while the brightness is not, and prints
`skyParallaxStatus()` so the re-bake cadence is visible at the same pose.

`__lum.star("Sirius")` is now parallax-aware too: it derives the expected illuminance and the
compression it divides out from the **live** distance. ⚠ It agreed to 0.02% at its own pose (Neptune's
umbra is 4.7e-4 ly from Sol against a 4.24 ly nearest star) — which is exactly how it would have
survived being wrong.

**What to check on device**

1. `await __lum.parallax()` — expect ✅ with a contrast ≫30× and a flux ratio near 1.000.
2. `await __lum.star("Sirius")` in the solar system — must be unchanged from before this landing; the
   illuminance path is bit-identical at the origin.
3. **Warp to α Cen and look back.** Sol should be a clearly visible star, comparable to the brighter
   catalogue stars around it, and the constellations should be visibly *different* from the view at
   Earth. That is the whole point of the phase.
4. **Stand 100 AU from α Cen B.** Both A and B should be discs. Before this landing, one of them was
   missing entirely.
5. `__lum.skyCapture()` after travelling — expect 0 non-finite texels. That is the assertion §16.7
   exists for.
6. `__lum.skyParallax(false)` freezes the cube and probe re-bakes while the sprites keep moving — the
   A/B for how much the reflections actually track the sky.

### 16.10 What the perf review changed, after the fact

The perf lens came back after the first implementation and found three things in it. Recording them
because two were mine and one was a five-year-old comment.

**🐛 `uCamPosLy` was derived from the wrong origin.** I used `worldOrigin.shipPosKm` — the raw sim
position. But the sprite shell is centred on the **scaled-scene origin** (`worldOriginKm`), and
`SimGroup` places the promoted disc at `positionKm − worldOriginKm`. The two are written one line apart
in `Spaceship` and differ by up to one physics substep: at the dev 1 ly/s override that is 8.3e-3 ly,
which against a 4.32 ly star is **2.3 px of visible offset between a promoted disc and the sprites
around it** (7.4 px at 1 pc/s). Deriving from `worldOriginKm` makes that offset exactly zero by
construction. It is a staircase (it only moves every 10,000 km) but that is 2.4e-10 rad — the
self-consistency is worth incomparably more.

**🐛 One write site was not enough.** The capture lives in `MilkyWaySkybox`'s **priority-0** `useFrame`
while my write was in `SpaceRenderer`'s **priority-1** hook, so the cube was built from a one-frame-old
observer — 0.23° at 1 ly/s, and 0.68° of seam between face 0 and face 5 of a six-frame set. Fixed with
a mandatory `refreshObserver` in `SkyCaptureDeps` that goes through the *same* exported function, so
there is still one derivation. Exactly the lesson `_setPsfForBuffer` already paid for: *a capture
cannot wait for the next useFrame.*

**⚠ The real cost is the PMREM prefilter, not the sprites.** Per face the capture is the panorama
sphere plus ~95k additive sprite fragments — tens of µs. The expensive part is three's
`_applyGGXFilter` on the frame the set completes: 512 samples × 139,776 output pixels ≈ **7.2e7
dependent gradient fetches, 1.4–3.6 ms in one frame**, 17–42% of an 8.5 ms budget. And it is billed to
the wrong passes — every cube face is summed into `PASS.scaled` because the capture renders
`scaledScene`, and PMREM's own contexts fall through to `PASS.post`.

⇒ `MIN_RECAPTURE_MS = 417`, derived: 2.5 ms of PMREM held under 0.1 ms/frame amortised needs 25 frames.
🔑 Two independent derivations agreeing is the reassuring part: 417 ms at 1 ly/s is 0.417 ly ⇒ **5.5°**
for a 4.32 ly star, and the finest level the PMREM lookup actually *samples* for any roughness above
0.054 is a 16×16 tile ⇒ **5.625°/texel** (`bilinearCubeUV` clamps `mipInt` to `cubeUV_minMipLevel = 4`
and `faceSize = exp2(mipInt)` — verified in three 0.183.2). The interval floor and the
resolvable-staleness bound land within 2% of each other from completely different directions.

⚠ And a framing correction worth carrying: **the warp hazard is a dev-override pose, not a gameplay
one.** Saturation needs v ≥ 0.265 ly/s at 60 fps, while the shipped transit drive peaks at 1.9e-5 ly/s
— one re-capture roughly every 20 minutes. So R7f's payoff is about *where you are*, not about
continuous change, and the invalidation is a rare event with a floor rather than a per-frame race.

**⚠ The panorama had no capture-resolution override**, and R7f is what promotes that from invisible to
visible. `uSkyLod` was written from the on-screen camera — 0.140 for 75° over 1816 px against an
8192-wide equirect — while a 256² face at 90° wants **3.35**. The cube sampled the band 3.21 mips too
sharp: 9.2× undersampled per axis, 85× in solid angle, numerically the same ratio as the star path's
85.5× flux trap but appearing as aliasing rather than brightness. Static and unnoticeable with a
one-shot capture; with periodic re-capture each set re-samples at a different sub-texel phase and the
reflected Milky Way crawls. `withSkyCaptureLod` mirrors `withStarCaptureResolution` exactly, including
being witnessed in `__lum.skyProbe()` rather than trusted.

Three smaller things fixed while the files were open:

* `Star.tsx` ran the R3b deficit integral (3 channels × 2 integrals × 96 steps = 576 iterations)
  unconditionally, while every consumer is gated on `primary` — so a promoted disc computed and threw
  it away every frame, and R7d's pool of 2 doubled that. Now gated.
* `updateSkyShUniforms`' doc claimed a version cache that did not exist; it copied nine `Vector3` per
  body, per tier, per frame. Implemented rather than deleted, because R7f is what makes the version
  actually change — and a reader budgeting §16.8's re-bake would otherwise assume the path was already
  change-gated.
* `_status.coreRadianceGame` divided out only pre-exposure. R7f makes the primary's gain ≠ 1 beyond
  ~769 AU, so it would have silently stopped being a radiance out there. Now divides out
  `fluxScale · gain` too — "measure what you name".

⚠ One latent loop left documented rather than fixed: giving the primary a gain ≠ 1 means its
`deficitFlux` feeds `starPointGlarePedestal()` → the exposure meter → pre-exposure → the lift. It
cannot close today because the ranges are disjoint — the gain exceeds 1 beyond 769 AU while Sol clips
`HALF_FLOAT_WRITE_MAX` only inside ~159 AU — but raising `STAR_LIFT_FLOOR` 10× moves the gain>1
boundary to 43 AU, *inside* the clipping range, and closes it. `STAR_VISIBILITY_TARGET` has already
moved once (§15.12), so this is a live constant, not a hypothetical.

### 16.11 What is still not done

* ~~**R7e** — a promoted star is still not a LIGHT.~~ ✅ done, §17.
* **R7c** — `stars[]` in the system description; the `STAR_*` singletons are still `celestialConstants`.
* **R7g** — a planet's sky is still lit by one star.
* The panorama's `uSkyLod` is not overridden for the sky capture, so the band is sampled ~3.2 stops too
  sharply for a 256²/90° face. PMREM blurs most of it away; it matters more now that the capture runs
  continuously.

---

## 17. R7e as built — catalogue stars as lights

**Status: built 2026-09-02. Not verified on device by me.** `__lum.starLights()` is the gate.

### 17.1 The defect

After R7f you could fly to α Centauri, see a limb-darkened disc filling the sky in front of you, and
**cast no shadow from it.** `SunLight` is driven by the system's primary, and Sol at 4.3 ly delivers
2.8e-10 game units — correctly nothing. So the hull was lit only by the sky. That was the most glaring
single-frame defect left.

### 17.2 🔑 A separate pool from the disc pool, because they answer different questions

§13.1's table already said it, and it is worth restating as a rule:

```
disc   ←  angular size 2R/d over a pixel threshold
light  ←  ILLUMINANCE at the ship over a threshold
```

A star can matter as a light while being sub-pixel as a disc (a hot, distant companion), and can matter
as a disc while contributing nothing as a light (a large cool giant seen from far off). Coupling the two
selectors would make one of those wrong, so each tier runs its own over the same catalogue.

`SLOTS = 4` — a hierarchical triple plus one, which is as deep as real systems within 10 pc go. Fixed
for the scene's lifetime, so promotion is a set of uniform writes and never a material rebuild.

### 17.3 The threshold is derived, and the pool is empty in the solar system

A star earns a light when it delivers more than **the whole sky put together**:
`4π · SKY_TARGET_NITS` = 1.257e-3 lux = **2.081e-7 game units**. Below that, a directional light adds
nothing the SH probe is not already delivering — and the SH is where the star already lives. Hysteresis
takes a slot at 2× and gives it up at 0.5×.

MEASURED consequences:

| star | L_v | becomes a light at | gives it up at |
|---|---|---|---|
| α Cen A | 1.515 | 0.139 ly (8,784 AU) | 0.278 ly |
| α Cen B | 0.500 | 0.080 ly (5,046 AU) | 0.160 ly |
| Sirius A | 25.4 | 0.569 ly (35,967 AU) | 1.137 ly |
| Proxima | 0.00155 | 0.0044 ly (281 AU) | 0.0089 ly |

* In the solar system α Cen A delivers **2.07e-3× the sky** ⇒ the pool is **empty**, which is correct
  and is what keeps `SunLight` the sole authority anywhere a player starts.
* At 100 AU from α Cen A it delivers 1.54e4× the sky. (Sol at 1 AU is 1.02e8×, for scale.)
* ⚠ A **fixed** derivation rather than a live read of the SH's own band-0 irradiance, deliberately: the
  pool is *excluded* from that sum, so thresholding on it would close a loop where crossing the
  threshold lowers the thing the threshold is compared against. In practice a star either dominates the
  sky by orders of magnitude or is negligible — so the loop would rarely bite, which is the worst kind.

### 17.4 ⚠⚠ The double-count, and why it is not merely a factor of two

All 8,920 catalogue stars are **already a light**: they are summed into the SH-L2 sky probe, which
`CelestialBody` renders from every frame. Promoting one to a `DirectionalLight` without removing it
from that sum counts its flux twice.

🔑 And the second copy is not just redundant, it is *shaped wrong*. SH-L2 is a 9-coefficient low-pass,
so a dominant point source in it delivers 17/16 at the source and **1/16 at the antipode**, with
negative ringing between (the exact figures `__lum.skyProbe()` already asserts). That is a sun with no
terminator, lighting the dark side of the hull at 6% of the lit side.

⚠ At Sol the error is 0.2% — which is precisely why it would have gone unnoticed until someone arrived
somewhere. ⇒ `rebakeCatalogueShFor` now skips the rows the light pool holds.

**Only the light pool, not the disc pool.** A disc is rendered *geometry*: you see it, but it does not
light the hull, so it correctly stays in the diffuse sum. The general rule is narrower than "explicit
tiers are excluded from the aggregate": **a star is removed from an aggregate only by the tier that
replaces that aggregate's job.** The sprite field's job (be seen) is replaced by the disc; the SH's job
(light things) is replaced by the light.

### 17.5 What it does not do

* **No eclipse test.** `sunVisibility` is built on the primary's radius and the registered occluder set,
  and a promoted star has no planets yet — there is nothing to be eclipsed by. It also gets no
  refracted-limb term and no atmospheric transmittance; both are single-dominant-body concepts owned by
  `SunLight`.
* **A planet's sky is still lit by one star** (R7g), which remains the genuinely large piece.
* The bounce fill is `Σ illuminance / 60`, matching `SunLight`'s shipped 60:1 key:fill ratio and summed
  over the pool because two suns bounce off the hull twice.

### 17.6 What to check on device

1. `__lum.starLights()` **in the solar system** — expect an empty pool and the explanatory line. A
   filled pool there is a threshold bug.
2. **Warp to 100 AU from Rigil Kentaurus.** `__lum.starLights()` should show α Cen A *and* B, both with
   `SH row excluded` ≥ 0, and ✅ on the no-double-count check.
3. **Then look at the hull.** It should have a hard **terminator** from the promoted star, not a soft
   all-over glow — and with both A and B lit, two shadows of slightly different colour (A is 5568 K,
   B is 4996 K).
4. `__lum.starPool()` at the same pose — every promoted disc must show a `sprite row` ≥ 0. A `-1` there
   is the double-draw that §16.3b was about, and it is what saturated the sky cube at 57,163.
5. `__lum.skyCapture()` at the same pose — the stored max should now be back in the tens, not 5.7e4,
   because the sprites that were saturating it are suppressed.

---

## 18. The tier gate — the pools stop re-ranking every frame

**Status: built 2026-09-02.** Gate: `__lum.starTiers()`.

### 18.1 The author's observation, which was right

*"Are we calculating all these things every frame? During normal gameplay everything will stay pretty
much the same for >99% of the gameplay — players start in our solar system and will need many hours
before they can leave."*

Both star tiers were ranking all 166 nearby stars every frame to answer a question whose answer changes
on the scale of hours. `NearbyStarDisc` also allocated 166 `{id, solid}` objects per frame and
`StarLights` allocated a membership string per frame — both against this repo's own no-allocations-in-
hot-paths rule.

### 18.2 🔑 The gate is derived, and it is the same idea as the sky-cube threshold

Both tiers select on a quantity that depends on the ship's position only through `d`:

```
disc   ←  R/d      changes by ~1 part in 100 when the ship moves d/100
light  ←  L/d²     changes by ~2 parts in 100 for the same move
```

So a re-selection can only change the answer once the ship has moved a fixed *fraction* of the distance
to the nearest candidate. Anchor the position at each selection, store
`RESELECT_FRACTION × d_nearest`, skip the ranking until the ship leaves that ball.

MEASURED, which is the whole point:

| pose | d_nearest | budget | re-ranks after |
|---|---|---|---|
| anywhere in the solar system | 4.23 ly | 0.042 ly | **2,673 AU of travel** |
| 8,784 AU from α Cen A | 0.139 ly | 1.4e-3 ly | 88 AU |
| 100 AU from α Cen A | 100 AU | 1 AU | 1 AU |

⇒ In the solar system the pools re-rank essentially never; near a star they re-rank often — which is
exactly when the answer can change. One derivation, no mode switch, and it is the same shape as
`skyParallax`'s cube/SH thresholds (a fraction of the distance to the nearest star).

⚠ **1% is safe against the hysteresis, which is why it can be this loose.** The disc pool needs a 5%
margin to swap (`SWAP_MARGIN = 1.05`) and the light pool a 4× band, so a ≤2% drift in the selector
cannot flip a decision either has already made. **The gate is strictly finer than the thing it gates** —
that is the property that makes it safe rather than merely cheap.

### 18.3 ⚠⚠ It gates SELECTION only, never the per-frame writes

A held star's direction and illuminance change continuously as the ship moves, so `StarLights` still
writes each slot's direction and intensity every frame — O(slots), allocation-free. Gating those too
would be the bug this design looks like it might introduce: **a light frozen at the pose it was selected
from**, which would read as a sun whose shadow direction lags the ship.

`NearbyStarDisc` needs no equivalent, because `Star` already computes its own geometry from
`positionKm` each frame; only the *choice of which star* is gated there.

### 18.4 What else is and is not per-frame

| work | cadence | why |
|---|---|---|
| disc-pool ranking (166 stars) | **gated** | answer changes on the scale of hours |
| light-pool ranking (166 stars) | **gated** | same |
| SH row exclusion (`findStarFieldIndexForStar`, 8,920 rows) | **on membership change** | a pass per pool member; set changes once per journey |
| light slot direction + intensity | every frame | continuous in ship position |
| `uCamPosLy` write | every frame | one uniform; sprites, disc and capture must agree within a frame |
| sky-cube re-capture | on a drift threshold, one face per frame | §15.5, §16 |
| catalogue SH re-bake | on a drift threshold | §16 |
| `Star`'s own geometry / gain chain | every frame | it is the thing being rendered |

`__lum.starTiers()` prints `skipped/(runs+skipped)` per tier, so the claim is measured rather than
asserted. Near 1.0 in steady flight is the design working; near 0 means either the derivation is wrong
or you are warping continuously — the one regime where re-ranking every frame *is* correct.

### 18.5 🐛 …and the same session found the residual "two positions for one star"

The author's earlier report — *"I can see three bright stars in a line, Rigil, Tolman, and what I assume
to be Proxima"* — was **not** Proxima. Proxima is V 11.01, outside the V ≤ 6.5 sprite catalogue, and its
`R/d` is far too small to promote: it is invisible by design. The third point was the **double-drawn
sprite of one of the pair**, displaced from its own disc.

MEASURED: the two catalogues place α Cen A at radii differing by 7.4e-4 ly = **46.8 AU** — pure radial
disagreement, because `stars_visual.bin` stores HYG's x/y/z (|posLy| 4.32016) while
`stars_nearby.json` carries HYG's `dist` column (4.3209). From Sol that is 1e-4 rad and invisible. From
100 AU:

| ship distance to A | \|ship→sprite\| / \|ship→disc\| | sprite flux vs disc |
|---|---|---|
| 100 AU | **1.468×** | 0.464× |
| 300 AU | 1.156× | 0.748× |
| 1,000 AU | 1.047× | 0.913× |
| 8,784 AU | 1.005× | 0.989× |

Any transverse offset turns that radial split into a large angular one, i.e. a separate star.

**Fix: the nearby catalogue wins, and not arbitrarily** — `distLy` is the column `absMagV` was computed
from, so it is the one the derived radius, temperature and disc radiance are all consistent with.
`reconcileStarFieldPositions` patches the 31 matched sprite rows at load, so sprite, disc, POI marker
and light pool cannot disagree.

⚠ Suppression hides this for a promoted star, which is why it only surfaced while the suppression was
broken. It would still have bitten any star that is a **light but not a disc**: its illumination would
arrive from one place and its sprite draw in another.

### 18.6 🐛 `__lum.parallax()` broke the harness's own Rule 1

The flux ratio went 2.007× → 0.846× after the lift-sampling fix, and the residual was the same class of
error one level down: the gate never pinned exposure. The harness's stated **Rule 1** is *"exposure is
PINNED while sweeping — auto-exposure is frame-to-frame state, so an unpinned sweep measures a function
of the previous frame."* The display lift is *derived* from pre-exposure, so an unpinned lift is still
drifting after 90 settling frames — MEASURED, it moved **0.497×** between the gate's two aims.

Now pinned, with `psfNorm`, `preExposure` and the background share printed alongside so the next run
localises anything left rather than needing another round.

---

## 19. Every star is promotable — and the formulae had to be domain-clamped first

**Status: built 2026-09-02. Not verified on device by me.** Gates: `__lum.starRows()`,
`__lum.starPool()`.

### 19.1 The defect

The author flew to a star and it never became real: *"I picked a star that seemed relatively near but
did not have a marker and flew towards that. It kept getting bigger, but only to a certain point. It
did not seem to become a real sphere and real light source. I thought our system would automatically
work for all stars in the catalogue?"*

It should have. Both pools ranked `getNearbyStars()` — the **166** rows of `stars_nearby.json` — while
the sprite field renders the **8,920** rows of `stars_visual.bin`. So **8,754 rendered stars could
never become a disc, a light, or a collider.** The one flown to was one of them, and what "kept getting
bigger" was its sprite's `1/d²` brightening running into the vertex illuminance ceiling.

🔑 Nothing new was needed to fix it: `absMagV = magV − 5log₁₀(d/10pc)` and the distance is already in
the file. `StarField` now derives `radiusKm`, `visualLumSun` and `T_eff` for every row at parse and
both pools rank over all of them.

### 19.2 ⚠⚠ …but promoting the whole catalogue naively ranks GARBAGE first

MEASURED, before any fix, the top of the angular-diameter ranking:

| row | d (ly) | magV | derived T | derived R | R/d |
|---|---|---|---|---|---|
| 1663 | 1230.8 | 6.10 | 2213 K | **1.1e13 R☉** | 670 rad |
| 5566 | 1173.2 | 5.75 | 2244 K | 5.2e12 R☉ | 324 rad |
| α Cen A (for scale) | 4.32 | −0.01 | 5568 K | 2.6 R☉ | **4.5e-8 rad** |

Ten orders of magnitude of nonsense, and a "radius" larger than the observable universe.

**Both formulae were being evaluated far outside their published domains, and both return finite
numbers there — which is exactly what makes extrapolation dangerous.**

* `temperatureFromBV` is Ballesteros (2012), fitted for **−0.4 ≤ B−V ≤ 2.0**. 25 rows carry B−V > 2 and
  were assigned 2213–2600 K.
* `bolometricCorrectionV` is Flower/Torres, valid for **3.5 ≤ log₁₀T ≤ 4.6** (3162–39,811 K). MEASURED
  at the cool edge and below it:

| T (K) | log₁₀T | BC_V | factor on L_bol |
|---|---|---|---|
| 3162 (domain edge) | 3.500 | −3.885 | 35.8 |
| 2600 | 3.415 | −9.377 | 5.6e3 |
| **2213** | 3.345 | **−17.14** | **7.19e6** |

7.19e6 on the luminosity is 2680× on the radius. That is the whole defect.

🔑 **Clamping to the domain is strictly better than extrapolating, because outside it the polynomial
carries no information at all — it is not "less accurate", it is unrelated to the star.** And the bound
is *derived* (from the papers) rather than authored, which is this project's standing rule.

### 19.3 🔑 The clamp doesn't just remove garbage — it recovers the right stars

MEASURED with both formulae clamped. The top five by derived angular radius, identified against
published values the derivation never touches:

| row | magV | d (ly) | T | R (R☉) | is | R error |
|---|---|---|---|---|---|---|
| 6031 | 1.06 | 553.8 | 3316 | 1144 | **Antares** (V 1.06, ~550 ly, ~680 R☉) | 1.68× |
| 2064 | 0.45 | 498.0 | 3794 | 507 | **Betelgeuse** (V 0.42, 152.7 pc rev. Hipparcos, ~900 R☉) | 0.56× |
| 1489 | 0.87 | 66.7 | 3737 | 61 | **Aldebaran** (V 0.85, 65.3 ly, ~45 R☉) | 1.36× |
| 4681 | 1.59 | 88.6 | 3649 | 68 | **Gacrux** (V 1.63, 88.6 ly, ~84 R☉) | 0.81× |
| 5232 | −0.05 | 36.7 | 4234 | 27.9 | **Arcturus** (V −0.05, 36.7 ly, 25.4 R☉) | 1.10× |

Those are five of the largest angular-diameter stars in the real sky, in nearly the right order, from
three catalogue columns and no per-star tuning. **That is the validation, and it is independent: the
names and radii come from entirely outside the pipeline.** Accuracy is ~10% on a K giant and a factor
~1.7 on a cool supergiant — good enough for a game, and stated rather than overclaimed.

Also measured: rows with an implausible radius fall **10 → 0**, and the largest derived radius falls
**2801 → 1297 R☉** (physical; the largest known star is ~2150).

### 19.4 What is still not promotable, and why that is right

`starParamsUsable` rejects a row when the derived radius is outside [0.005, 3000] R☉ or the distance is
≥ 50,000 ly. **206 of 8,920 rows fail**, all on distance: they sit at HYG's 326,156 ly "parallax
unknown" sentinel, where `absMagV` and everything downstream is meaningless. ⇒ **8,714 (97.7%)
promotable.**

⚠ A row can be perfectly fine as a *sprite* — which needs only `magV` and `B−V` — and unusable as a
disc or light, which need a trustworthy *distance*. That asymmetry is why the gate lives on the
promotion path and not on the catalogue.

The radius bound rejects 0 rows today. It is a guard against future data, not a filter doing work — and
`__lum.starRows()` errors loudly if it ever starts firing, naming the domain clamps as the first
suspect.

### 19.5 🔑 Identity became the row index, which deleted a whole class of bug

Selecting from the same catalogue the sprites come from means **the pool's identity IS the sprite's
index**, so suppression needs no cross-file match at all. The suppression had failed silently twice —
once from a cosine rounding to 1.0f (§16.3), once from a position tolerance 100× too tight (§16.3b) —
and both failures lived entirely in that cross-walk. `findStarFieldIndexForStar` survives only to
attach *names*, which only the 166 nearby rows have; a nameless promoted star falls back to `HYG <row>`.

### 19.6 Colliders for promoted stars

The author again: *"colliders with stars only currently work with Sol, I can fly straight through other
stars."* Correct — `Spaceship`'s collider list was built once from `systemConfigAtom.celestialBodies`,
which holds Sol and its planets and nothing else.

Fixed with a fixed-size **collider tail**: `STAR_COLLIDER_SLOTS = 4` entries appended once, refreshed
each frame from `starDiscPool`. Same fixed-pool discipline as the disc and light tiers, so a promotion
is a set of scalar writes.

⚠ Unused slots carry `r = 0` and `sweptSphereCollide` now skips non-positive radii. Without that skip an
empty slot would present as a sphere of the *hull's* own radius sitting at whatever stale position it
held — most likely (0,0,0), which is exactly where Sol is.

⚠ The refresh copies the **scalars**, matching the note already in that function: the pool's slots are
replaced wholesale on promotion rather than mutated, so anything holding a reference would go stale.
That is the same aliasing rule the ephemeris imposed, and the reason the old comment there says the ship
once "crashed into empty space".

---

## 20. 🐛🐛 §19 traded one blind spot for its mirror — the promotable set is the UNION

**Status: built 2026-09-02. Not verified on device by me.** Gates: `__lum.starRows()`, `__lum.starPool()`.

### 20.1 The defect I introduced

§19 moved both pools off `stars_nearby.json` (166 rows) and onto `stars_visual.bin` (8,920 rows),
because 8,754 rendered stars could not be promoted. It fixed the reported case and created the mirror
one immediately: the author flew to **Proxima Centauri** and *"it never appeared visible. I only saw the
marker, even at only 11 km from it, and also no collision. Works for other stars, like Toliman."*

Proxima is **V 11.01**. The sprite catalogue is V ≤ 6.5 *apparent*. It has no row, so under §19 it had
no candidate — no disc, no light, no collider.

### 20.2 🔑 Neither catalogue is a superset, and they are complementary by construction

```
stars_visual.bin    V ≤ 6.5 APPARENT   → bright, mostly distant  (the naked-eye sky)
stars_nearby.json   within ~50 ly      → close, mostly FAINT
```

MEASURED: only **31 of 166** nearby stars have a sprite row. The other 135 are all fainter than V 6.5,
and the magnitude distribution shows how thoroughly: 26 at V 6.5–9, 37 at 9–11, 43 at 11–13, 29 fainter
than 13.

⚠⚠ **And they are precisely the stars a player would fly to** — the nearest eight without a sprite:

| star | dist | magV | |
|---|---|---|---|
| Proxima Centauri | 4.227 ly | 11.01 | **the nearest star to the Sun** |
| Barnard's Star | 5.948 ly | 9.54 | |
| Wolf 359 | 7.797 ly | 13.45 | |
| Lalande 21185 | 8.307 ly | 7.49 | |
| Gl 65 A/B | 8.567 ly | 12.57 / 12.70 | |
| Gl 244B | 8.601 ly | 8.44 | Sirius B |
| Ross 154 | 9.686 ly | 10.37 | |

🔑 There is a general shape here worth naming: **an apparent-magnitude catalogue and a distance-limited
catalogue are orthogonal selections, and "the stars you can see" is not "the stars you can visit".**
Either one alone leaves a blind spot; which blind spot you get depends on which you picked, and both
blind spots are invisible until someone flies somewhere.

### 20.3 As built

`space/starCandidates.ts` builds the union once and hands both pools one flat array to rank:

```
stride 8:  posLy(3)  radiusKm  visualLumSun  tempK  spriteRow  magV
```

`spriteRow = −1` for a star with no sprite, and **that is legitimate, not a failed lookup.** The
discriminator is `magV`: only a star brighter than `STAR_SPRITE_MAG_LIMIT = 6.5` with `spriteRow = −1`
is the double-draw the diagnostics hunt for. Without that distinction `__lum.starPool()` would report
the §20 fix as a bug for every faint star.

MEASURED on device: **8,714 visual rows + 134 nearby-only stars = 8,848 candidates**, 165 named.
(134 rather than 135 — one of the 166 fails `starParamsUsable`.)

### 20.4 One module owns all three cross-walk jobs

Reconciling the 46.8 AU radial disagreement (§18.5), building the row→name map, and deciding which
nearby stars need their own candidate all need the same `findStarFieldIndexForStar` pass. Three callers
of one expensive, subtle match is three places to call it with different tolerances — which is exactly
how the suppression failed twice (§16.3, §16.3b). ⇒ One owner, one pass, one set of results.

⚠ **Order is enforced there too:** the reconcile *patches* sprite positions, and candidates built from
visual rows read those positions. Building candidates first would bake in the pre-reconcile values and
reintroduce the 46.8 AU split for exactly the 31 stars the reconcile exists to fix.

### 20.5 The SH exclusion follows the same discriminator

Only a candidate with a sprite row contributes to the catalogue SH, so only those need excluding when
promoted to a light. A nearby star fainter than V 6.5 was never in that sum, so an **empty** exclusion
list is correct whenever every lit star is a faint nearby one — and `__lum.starLights()` now prints the
list rather than index-aligning it against the slots, because the −1s are dropped.

### 20.6 Everything else the author verified this round

All green, and worth recording because several were newly built:

* `__lum.starRows()` — 8,714/8,920 usable, all radii physical, largest 1297 R☉, and the top of the
  angular-diameter table came out **exactly** as predicted in §19.3.
* `__lum.starPool()` at a random unnamed star — `HYG 6031` promoted alongside `Gl 19`, both suppressed
  by exact row index. That is a star from the 8,754 that §19 unlocked, and `HYG 6031` is **Antares**.
* **Collision works** at a promoted non-Sol star (§19.6).
* `__lum.starTiers()` near Earth — skip rate **0.9403**, budget 2,733 AU. The 6% of frames that do
  re-rank are the warps; steady flight skips.
* `__lum.star("Sirius")` — flux **0.9965×** of its published magnitude, σ solved to 0.9982× of intended.
* `__lum.parallax()` — **PASSES at 1.019×** with exposure pinned.

⚠ **One open item, honestly unresolved.** The parallax gate read 0.846× in an earlier pose and 1.019×
here, and the difference correlates with the display lift being *unclamped* (54,854) versus at its floor
(1024) — the pre-exposure between the two runs differed by 1580× at nominally the same pose, which
points at a pose-dependent or unsettled adaptation rather than at the sprite photometry (which
`__lum.star()` independently measures at 0.4%). It is not diagnosed, and the gate is left able to fail
rather than tuned to pass.

---

## 21. 🐛 The marker/disc offset was f32 light-years — and markers became nearest-N

**Status: built 2026-09-02. Not verified on device by me.**

### 21.1 The defect, and it was mine from §20

*"For some stars, the marker does not sit right on the star. Proxima Centauri sits in the top right of
the image while its marker is in the centre. This applies to the warp too."*

§20's candidate array stored positions in **light-years as `Float32Array`**. MEASURED:

| star | \|posLy\| | f32 ulp (ly) | **half-ulp (km)** |
|---|---|---|---|
| Proxima | 4.2267 | 4.768e-7 | **2.256e6** |
| Rigil Kentaurus | 4.3202 | 4.768e-7 | 2.256e6 |
| Gl 244B | 8.601 | 9.537e-7 | 4.511e6 |
| Antares | 553.75 | 6.104e-5 | 2.887e8 |

The screenshot puts the ship **1,495,979 km** from Proxima — so the quantisation step of the star's own
stored position is **1.51× larger than the distance to it**. The marker (built from the nearby
catalogue's f64 numbers) and the disc (built from the f32 candidate array) can then disagree by tens of
degrees. At Gl 244B the same effect is 0.030 AU = 1.7° at 1 AU range.

🔑 **The defect is INCONSISTENCY, not precision.** A star whose position is quantised is simply at a
slightly different place than the catalogue says, and nothing breaks provided the marker, disc, light,
collider and warp target all agree. Two sources for one position is the same failure as §18.5's 46.8 AU
split, one order of magnitude smaller and one order more subtle.

⚠⚠ **And the numerics review had flagged exactly this** — *"uCamPosLy's own f32 ulp quantizes it into
visible steps on close approach"* — with a per-star table. I argued it was covered because `Star`
computes its geometry in f64 on the CPU, and then stored the CPU's own **input** in f32. A review
finding about a data type is not discharged by noting that the consumer is fine.

**Fix:** `Float64Array`, and positions sourced from the nearby catalogue's f64 values whenever the star
has a counterpart there — reading the f32 GPU row would round the reconcile's own f64 input straight
back to f32.

⚠ Sirius B is additionally a red herring: its derived radius is 12,313 km (real 5,850 — a white dwarf,
2.1× over), so at 1 AU it subtends 8.2e-5 rad and is a **sub-pixel point** however accurately it is
placed. That is correct physics, not a bug.

### 21.2 Markers: nearest-N, not within-a-radius

The author asked which rule is better. **Nearest-N to the ship**, and the decisive argument is not
clutter:

🔑 The old rule was `s.distLy > STAR_MARKER_MAX_LY`, where `distLy` is the catalogue distance **from
Sol** — so it silently became wrong the moment the player left the system. That is precisely the defect
R7f fixed for the sky, still live in the HUD. **A nearest-N rule has no origin baked into it.**

On the author's three axes:

| | nearest-N | within X ly |
|---|---|---|
| **gameplay** | constant HUD density; can never leave you with zero markers to navigate by | 12 stars near Sol, could be 40 in a dense region or 3 in a sparse one |
| **performance** | identical — one pass either way, both ride the movement gate. An n-element insertion is *cheaper* than building a variable-length array | — |
| **effort** | less: nothing to tune per region | needs a judgement call that will feel wrong somewhere |

`STAR_MARKER_NEAREST = 6`. `STAR_MARKER_MAX_LY` survives as a **safety cap measured from the ship**
(raised to 30), so an empty direction cannot produce an arrow to something 300 ly away; with 8,848
candidates it essentially never binds.

⚠ Markers now come from the **candidate union**, so a marker, its disc, its light, its collider and the
warp target are one position to the last bit — and all 8,848 stars are markable, not just the 166 named
ones (unnamed ones read `HYG <row>`). Ids stay stable (`hyg-<row>`, or the nearby id when it has one)
so the persisted discovery registry survives.

⚠ The selection rides the same gate as the pools, which is doing double duty here: it also stops the
HUD re-rendering 120 times a second. And it advances the gate **even on an empty result** — otherwise a
pose with nothing inside the cap would re-run the 8,848-candidate pass every frame.

### 21.3 Verified green by the author this round

* Proxima renders as a disc, lights the hull at **6.996 game units = 4.224e4 lux** (3.4e7× the sky's
  own flux), and `__lum.starPool()` shows it with `— no sprite (fainter than V 6.5)` rather than an
  error. The §20 discriminator works.
* `__lum.starRows()` — **8,848 candidates = 8,714 visual + 134 nearby-only**, 165 named.
  (134, not 135: one of the 166 fails `starParamsUsable`.)
* `__lum.starLights()` at Proxima — SH exclusion list empty, and correct: a V 11.01 star was never in
  the catalogue SH.
