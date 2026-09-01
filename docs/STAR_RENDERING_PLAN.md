# Star rendering plan — one parameterised star, continuous LOD

Closes the reported defects **R-A** (the sun vanishes past ~13 AU) and **R-B** (no star LOD), and
absorbs **P8d** from [`LIGHTING_PLAN.md`](LIGHTING_PLAN.md) (the sun's glare is 4.4× too weak).

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
| **R3** | **P8d + corona** | glare driven from the star-flux uniform; delete `INNER_GLOW_FRAC` / `OUTER_GLOW_ABS` / `GLOW_PAD` and the D25 bug with them | medium |
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
