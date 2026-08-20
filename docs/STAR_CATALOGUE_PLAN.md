# Star catalogue plan — real stars, real magnitudes

Closes **D30** in [`LIGHTING_PLAN.md`](LIGHTING_PLAN.md) and unblocks **D29** (the sky as a light
source). Written before any code, because the data model decision is the one that is expensive to
change later.

---

## 1. Why the panorama cannot be fixed

Measured, not assumed:

| | value |
|---|---|
| Sirius (V = −1.46) *should* render as | **14.9 cd/m²** (flux ÷ one pixel's solid angle, 6.53e-7 sr at 50° vFOV / 1080 px) |
| our brightest panorama texel measures | **3.1e-2 cd/m²** |
| implied magnitude of the brightest thing in our sky | **5.25** |
| deficit | **482× = 8.9 stops = 6.7 magnitudes** |

Two independent reasons a better texture does not fix this:

1. **Dynamic range.** Real Sirius : diffuse Milky Way = **1.19e5 : 1 = 16.9 stops**. An 8-bit sRGB
   panorama holds ~8 stops. Calibrating by the whole-sky *mean* — which is correct for the diffuse band,
   and what `SKY_RADIANCE_SCALE` does — necessarily crushes the stars toward that mean. An HDR/EXR
   panorama removes this one.
2. **A star is a delta function.** Stored in a texture it occupies ≥1 texel, so at any viewing
   resolution other than the texture's own, filtering either blurs it (flux not conserved) or aliases
   it. Total flux is correct at exactly one FOV. Already observed from the other side: reading the
   panorama at mip 4 suggested the stars vanish entirely — that was pure mip-averaging of point
   sources. **An HDR panorama does not fix this one.**

⚠ So do not raise the star texels or re-scale the panorama. That re-breaks the diffuse band (the
189,000×-too-bright error) and there is no per-texel way to tell a star from nebulosity in an LDR image.

⚠ `StarsComponent.tsx` is drei's `<Stars>` — randomly placed points, and its own header says
*"Deprecated: using image-based stars for realistic star positioning."* It is not a base to build on.

---

## 2. Locked decision — hybrid

**Catalogue point sprites for resolved stars + panorama for the diffuse background only.**

This is what Space Engine, Elite Dangerous, Celestia and Stellarium do. It is also the only option that
generalises to procedurally generated systems (§7), which is a standing constraint from
LIGHTING_PLAN §3.0.

---

## 3. Data model — the decision that matters

### 3.1 Store 3D POSITIONS, not directions

The instinct is to store a direction plus a magnitude, since the sky looks fixed. That is wrong, and the
numbers are dramatic. Travelling 4.24 ly (Sol → Proxima):

| star distance | max angular shift |
|---|---|
| Alpha Cen (4.37 ly) | **76°** |
| Sirius (8.60 ly) | **29.5°** |
| 25 ly | 9.8° |
| 100 ly | 2.4° |
| 2000 ly | 0.1° |

The near constellations **visibly distort**; the Milky Way band and everything beyond ~1000 ly is
effectively fixed. Store distance (from parallax) and apparent direction is
`normalize(starPos − observerPos)` — parallax then comes out free, correct, and identical in the
procedural path.

**Within a system, though, the sky is rigid.** The observer moves at most a few AU (1.5e8 km) against
star distances of ~4e13 km → parallax of `arcsin(1.5e8/4e13)` = **0.04 arcsec**. So apparent directions
are recomputed only on an interstellar jump, never per frame. That is the whole perf story.

### 3.2 ⚠ TWO catalogues, because they answer different questions

**Proxima Centauri is magnitude 11.13. It is not in the Yale BSC and it is invisible to the naked eye.**
Nor are most of our nearest neighbours:

| star | dist | V | naked-eye? |
|---|---|---|---|
| Proxima Centauri | 4.24 ly | 11.13 | **no** |
| Alpha Cen A / B | 4.37 ly | −0.01 / 1.33 | yes |
| Barnard's Star | 5.96 ly | 9.51 | **no** |
| Wolf 359 | 7.86 ly | 13.54 | **no** |
| Lalande 21185 | 8.31 ly | 7.52 | **no** |
| Sirius A | 8.60 ly | −1.46 | yes |
| Epsilon Eridani | 10.5 ly | 3.73 | yes |
| Tau Ceti | 11.9 ly | 3.50 | yes |

So:

| catalogue | selection | answers | size |
|---|---|---|---|
| **Visual** | magnitude-limited (V ≤ 6.5) | *what the sky looks like* | ~9,110 |
| **Neighbourhood** | distance-limited (≤ ~25 ly) | *where you can go* | ~few hundred |

They overlap only in a handful of entries (Alpha Cen, Sirius, Procyon, Altair, Fomalhaut, Tau Ceti…).
The union is still small enough to be irrelevant to load time.

**This is a gameplay finding as much as a data one.** The player cannot eyeball Proxima and fly to it.
But Alpha Centauri — 4th-brightest star in the sky — sits **0.2 ly** from Proxima, i.e. the same
direction. "Aim at Alpha Cen by eye, then acquire Proxima on instruments" is physically true and is a
real navigation loop rather than a decorative one. Treat naked-eye invisibility as the mechanic, not a
problem to design around.

### 3.3 Record layout

```
position   3 × f32   light-years, barycentric equatorial (or km — see §3.1 note)
magV       1 × f32   apparent V magnitude from Sol (or absolute M_V; derive the other)
colorBV    1 × f32   B−V colour index
                     ── 20 bytes/star ──
```

9,110 stars → **182 KB**. Hipparcos (118,218) → 2.4 MB if depth is ever wanted. Ship as a binary blob,
not JSON. Flags/ids only for the neighbourhood set (it needs names for the UI).

---

## 4. Sourcing

| source | contents | note |
|---|---|---|
| **Yale Bright Star Catalogue, 5th ed.** (VizieR V/50) | 9,110 stars, V ≤ ~6.5, V and B−V | the visual set |
| **Hipparcos** (VizieR I/239, or van Leeuwen 2007 I/311) | 118,218 stars with parallaxes | depth, later |
| **Gaia DR3** | ~1.8e9 | far beyond need; useful only for the diffuse bake |
| **RECONS / nearest-stars lists** | the ≤25 ly neighbourhood | the navigation set |
| **NASA SVS "Deep Star Maps 2020"** | equirect maps from Gaia DR2 + Tycho-2, **star and dust layers separately** | the dust layer is exactly the diffuse component we want |

⚠ **Verify each licence before shipping** rather than trusting this table: CDS/VizieR catalogues are
freely redistributable with citation, Hipparcos and Gaia are ESA with attribution terms, NASA SVS
imagery is usually public domain but is worth confirming per-asset. Record the citation next to the
data file.

---

## 5. Rendering

### 5.1 Instanced billboards, NOT `THREE.Points`

⚠ **WebGPU has no `gl_PointSize`** — point primitives are always 1 px. So instanced quads, which is
exactly what [`StellarPoint.tsx`](../src/components/space/StellarPoint.tsx) already does for planets.
One instanced draw for the whole catalogue.

### 5.2 Photometry — reuse what already exists

Most of this is already written and validated:

```
E      = 2.54e-6 · 10^(−0.4·m)        lux          (mag-0 star = 2.54e-6 lux)
E_game = E / NITS_PER_GAME_UNIT                     photometry.ts
L_px   = E_game / pixelSolidAngle                   spread over the PSF
```

- **`subPixelFluxScale()`** already conserves flux for a sub-pixel disc — written and verified for the
  sun disc (exact at 30 AU). The same function gives a star a minimum rendered size (~1.5–2 px, so a
  sub-pixel point cannot flicker as the camera drifts) while preserving total flux.
- **`blackbodyLinearSrgb()`** already converts a temperature to luminance-normalised linear sRGB. For
  B−V → temperature, Ballesteros (2012) is a good closed form:
  `T = 4600·(1/(0.92·BV + 1.70) + 1/(0.92·BV + 0.62))` — checked against two anchors: BV 0.65 → 5,778 K
  (Sun is 5,772) and BV 0.00 → 10,125 K (Vega is ~9,600).
- `pixelSolidAngle` is a function of FOV and drawing-buffer size, so it must be a **uniform** refreshed
  on resize and FOV change — the same class of bug D31 was.

### 5.3 Bloom — add nothing star-specific

Real glare on bright stars comes from the **observer's optics** (lens striae in the eye, which is why
Sirius shows a starburst), not from the atmosphere — there is no scintillation in vacuum. So a little
glare on the brightest handful is right and everything else should be a crisp point.

**Once magnitudes are correct this happens by itself**: Sirius is 480× a mag-5 star, so one global bloom
threshold naturally catches only the brightest few. Same lesson as the engine plume, where an apparent
"too much bloom" was bloom faithfully reporting a 251,000 cd/m² nozzle. **Get the photometry right and
bloom sorts itself out.**

---

## 6. The sky as a light source (closes D29)

Total integrated starlight is ~3e-4 lux → **3.3e-5 cd/m²** on the hull: 33× the dark-adapted eye's
absolute threshold, so genuinely visible, but 0.27× the Milky Way band, so the correct look is a **dark
silhouette against a brighter sky**, not a visibly grey ship.

**D25 unblocked this.** In absolute units the hull term is 5.5e-9 game units, *below* the half-float
floor of 5.96e-8 — which is why D29 was filed as blocked. With source pre-exposure shipped, a dark scene
carries a factor of ~218,000, so 5.5e-9 × 218,000 = 1.2e-3. Representable.

**Mechanism: one SH-L2 irradiance bake from catalogue + panorama together.** 9 coefficients × 3
channels = 27 floats. Stars enter as delta functions (`Y_lm(dir) · E_star`), the panorama as a
solid-angle-weighted texture integral. ~9,110 × 9 evaluations, run once per interstellar jump (§3.1),
never per frame. L2 is sufficient because the irradiance of a sky whose only structure is one broad band
is inherently low-frequency; a PMREM would buy specular reflections that are meaningless at 3e-5 cd/m².

---

## 7. Procedural systems

A generated system needs a synthetic catalogue anyway, so the same renderer consumes it with no new
code path — which is the §3.0 constraint satisfied rather than worked around. Generate from a plausible
stellar population (initial-mass-function-weighted spectral types → absolute magnitude and B−V, spatial
distribution with a galactic-plane bias), emit the same 20-byte records, re-bake the SH.

⚠ Keep the *real* catalogue as the Sol-system asset. Players who know the sky will notice, and it costs
182 KB.

---

## 8. Phases

| # | phase | deliverable |
|---|---|---|
| **S0** ✅ | Data pipeline | [`scripts/build_star_catalogue.py`](../scripts/build_star_catalogue.py) → `public/data/stars_visual.bin` (8,920 stars, 174 KB) + `stars_nearby.json` (166, 44 KB). Source is **HYG v41**, not VizieR — see §4 and the ⚠ licence note |
| **S1** ✅ | Renderer | [`StarField.tsx`](../src/components/Stars/StarField.tsx) — renders, 8,920 instances, one draw. **Three gaps below before this is done** |
| **S2** ✅ | Validate | `__lum.star(name)` compares **FLUX**. Sirius/Vega/Betelgeuse all **0.999×**; found two real bugs on the way |
| **S3** | Diffuse split | adopt a **star-free** dust layer (Deep Star Maps galaxy layer); keep it LDR — the band is only 2.6 stops, see §8.2; re-measure `SKY_TEXTURE_MEAN_LINEAR` |
| **S4** | SH-L2 bake | closes D29 — the hull lit by the real sky |
| **S5** | Parallax | 3D positions live; apparent directions recomputed on interstellar jump |
| **S6** | Neighbourhood set | navigation targets, names, the "acquire Proxima on instruments" loop |

**S2 is the gate.** Until a probe on Sirius reads ~15 cd/m² and a mag-6 star reads ~0.0155, nothing
downstream is trustworthy — the same discipline that caught every defect from D08 onward.

---

## 8.1 S0 as built (2026-08-18)

Source is **HYG v41** rather than VizieR directly: HYG already merges Hipparcos + Yale BSC + Gliese and
pre-computes distances and Cartesian positions, i.e. exactly the §3.3 record shape. ⚠ It is
**CC BY-SA 4.0** (share-alike) and the derived blob is a derivative work — the open decision and the
non-share-alike alternatives are recorded in
[`public/data/STARS_ATTRIBUTION.md`](../public/data/STARS_ATTRIBUTION.md). The 34 MB source CSV is not
committed; only the 174 KB blob.

`hr` (Harvard Revised) marks Yale BSC membership and `gl` marks Gliese, so the §3.2 two-catalogue split
falls straight out of one file.

**Validated against published values, not eyeballed:**

| check | result |
|---|---|
| Sirius | HYG mag −1.44 → **14.66 cd/m²** at the reference pixel (published −1.46 → 14.9) |
| mag 6.0 reference | **0.0155 cd/m²** — matches §9's gate exactly |
| Vega / Alpha Cen A / Polaris | +0.03 / −0.01 / +1.97 vs published +0.03 / −0.01 / +1.98 |
| B−V → T_eff (Ballesteros) | Arcturus B−V 1.24 → **4,234 K** vs published 4,286 K |
| defaulted B−V | 40 of 8,920 |
| unknown-parallax sentinel | 206 of 8,920 — left as-is; at 326,000 ly its travel parallax is 2.7 arcsec, so the star simply sits fixed, which is the honest answer and needs no renderer special case |

⚠ **The §3.2 gameplay finding is now literally in the data.** `stars_nearby.json` row 1 is Proxima
Centauri, 4.23 ly, `nakedEye: false`; row 3 is Rigil Kentaurus (Alpha Cen A, G2V, mag −0.01), 4.32 ly,
`nakedEye: true`. **0.09 ly apart.** "Aim at Alpha Cen by eye, acquire Proxima on instruments" is not a
design conceit — it is what the catalogue says.

⚠ One diagnostic bug worth remembering: the first version counted defaulted-B−V and sentinel rows across
all 119,626 input rows rather than the 8,920 emitted, reporting 1,891 and 10,225 — overstating a data
problem by 47×. A diagnostic that misreports is worse than none.

## 8.2 S1 as built (2026-08-18) — renders, with three gaps

[`StarField.tsx`](../src/components/Stars/StarField.tsx), mounted in Scene's scaled content just after
the panorama. One instanced draw, 8,920 quads, `renderOrder −999`, additive, no depth test or write —
so opaque geometry drawn later simply paints over them.

Confirmed working: the catalogue loads (`8920 catalogue stars; brightest 9.568e-6 lux` — matching the
pipeline's spot check exactly), a real star field renders with a visible range of brightnesses, and
`probeMax` over a 700 px block reads a peak of **0.221 cd/m²**, which back-solves through
`E = peak · 2πσ² · Ω_px` to an implied magnitude of **≈ 2.0** — plausible for the brightest star in that
particular view.

✅ **GAP 1 CLOSED — the gate is built AND PASSED**

(history below kept for the two bugs it caught)

🔨 **GAP 1 — the gate is BUILT (`__lum.star("Sirius")`), not yet run to completion here.**

`scripts/build_star_catalogue.py` now also emits `public/data/stars_named.json` — **358 named naked-eye
stars**, 43 KB. `__lum.star(name)` warps deep into Neptune's umbra (darkest available sky, no sun),
aims along the star's direction, and probes.

🔑 **The expected value is computed from the PSF normalisation the SHADER IS USING THIS FRAME**
(`getStarPsfNorm()`), not recomputed in the harness. Two implementations of the same conversion is
exactly how a validated pipeline silently drifts out of validation — and it would make the gate agree
with a bug in the renderer.

⚠ Positions in `stars_named.json` stay in the catalogue's **equatorial** frame on purpose, and the
harness rotates them through `StarField`'s own `equatorialToGame`. So a wrong rotation aims at empty sky
and the probe reads ~0 — the gate tests the frame transform end to end, not just the photometry.

**Confirmed in-engine:** the named index loads (`loaded 358 named stars`) and aiming at Sirius puts a
visibly bright star **dead centre** — which is the independent, in-engine confirmation of gap 2 that a
script alone could not give. The numeric comparison did not complete in the sandbox: `sleepFrames(150)`
needs 150 real frames and the automation tab throttles `requestAnimationFrame` to a few frames per
screenshot. On real hardware at 120 FPS it settles in ~1.2 s.

**To close S2, run:**
```
await __lum.star("Sirius")     // expect ~2.4 cd/m² peak, ratio within 0.7–1.4
await __lum.star("Vega")       // an independent magnitude and a very different colour
await __lum.star("Betelgeuse") // B−V 1.5, so it also checks the blackbody path
```

⚠ **Superseded gap-1 text:** the S2 gate is NOT passed. "Implied mag 2.0 is plausible" is not a measurement, because
nothing identifies *which* star was hit. The gate needs an instrument that aims at a **named** star and
probes it: `__lum.star("Sirius")`. Until then the photometry is only self-consistent, not validated.

✅ **GAP 2 CLOSED (2026-08-18) — equatorial J2000 → the game's ecliptic frame.**

MEASURED from `sol.json` rather than assumed: **every body has `y = 0`**, so the game's ecliptic is the
**xz-plane** and **+y is the ecliptic north pole** — the ordinary three.js y-up convention. (Also
correcting an earlier over-general claim of mine: the bodies are *not* all collinear. Earth, Mars and
Jupiter sit at different angles in that plane; only Mercury, Venus, Saturn, Uranus and Neptune share the
+x axis, which is why the "everything transits the sun from behind Neptune" observation was real but
narrower than I described.)

Two rotations compose, both about x, so they add: equatorial → ecliptic by the obliquity ε = 23.4392911°,
then astronomical z-up → three.js y-up as `(x, y, z) → (x, z, −y)`. Applied at **parse time** in
`StarField.tsx`, not in the `.bin` — the catalogue is data and belongs in a published astronomical frame;
which axes the game uses is a game concern, and changing it must not force an asset re-bake.

Validated by extracting the **shipped** constant out of the `.tsx` and running it over the **real blob**,
against published ecliptic coordinates:

| star | computed (lat, lon) | published | error |
|---|---|---|---|
| Sirius | −39.61°, 104.08° | −39.6°, 104.1° | **0.019°** |
| Vega | +61.73°, 285.32° | +61.7°, 285.3° | **0.037°** |
| Canopus | −75.82°, 104.96° | −75.8°, 104.9° | **0.065°** |
| north ecliptic pole | exactly (0, 1, 0) | — | 0 |
| vernal equinox | exactly (1, 0, 0) | — | 0 |

⚠ **The longitude origin is a deliberate, changeable choice.** This puts the vernal equinox on +x
(ecliptic longitude 0) — the standard convention and the only principled option, because sol.json's
positions are not a real ephemeris for any date. It places Earth at ecliptic longitude 153°. When orbits
and an epoch land, the planets' true longitudes pin this and the only edit is one rotation about +y.

⚠ My first verification script reported a 205° error — because its "brightest so far" sentinel was
`best < 0`, which stays true once a magnitude is legitimately negative, so it walked to the last star and
compared **Vega** against **Sirius's** published values. Same class of self-inflicted test bug as the
penumbra sweep that mixed small-angle and `atan2`. When a validation fails by a suspiciously round
amount, suspect the test.

⚠ **Superseded gap-2 text (kept for the reasoning):** the coordinate frames were not aligned. The catalogue is in HYG's equatorial J2000 axes;
the scaled scene's axes come from `sol.json`. Directions are therefore currently in an arbitrary
orientation relative to the ecliptic, so **the constellations are rotated wrongly against the planets** —
Sirius is not where it should be relative to Earth's orbit. Needs one fixed rotation (equatorial →
whatever frame `sol.json` uses, obliquity 23.44° among it) applied at parse time. This is a data-frame
question, not a rendering one, and it is why aiming at a named star (gap 1) is the test that catches it.

⚠ **GAP 3 — stars are drawn twice.** The panorama still contains its own baked stars, so every catalogue
star sits on top of a dimmer, wrongly-scaled one. That is S3's job.

**⚠ And S3 does NOT want HDR — measured.** The tempting move is to source an HDR/EXR nebulosity map. But
the diffuse band alone spans only **6.2× = 2.6 stops** (galactic pole 3.34e-5 → Sagittarius peak 2.08e-4
cd/m²), against ~8 usable stops in 8-bit sRGB — **5.4 stops of headroom**. The 16.9-stop range that forced
this whole redesign was *Sirius against the band*, i.e. **the stars, not the nebulosity**. Once the stars
leave the texture, LDR is comfortably sufficient.

Against that, HDR costs a great deal: an 8k half-float equirect is ~200 MB uncompressed and a 16k float32
is 1.6 GB — and ⚠ **Basis/UASTC, the project's entire KTX2 path, is an LDR format and cannot carry HDR at
all**, so it would mean either RGBM/RGBE trickery or a separate BC6H/ASTC-HDR pipeline.

So S3's real requirement is not more bits, it is a **star-free** layer: take the NASA SVS *Deep Star Maps
2020* galaxy/dust layer (published separately from its star layer, which is exactly the split we need),
keep it 8-bit, and re-measure `SKY_TEXTURE_MEAN_LINEAR` against it.

Notes on the implementation worth keeping:

- **Flux, not luminance, is what the sprite carries.** The instance holds illuminance in game units and
  the shader converts with the LIVE pixel solid angle (`uPsfNorm = 1/(2πσ²·Ω_px)`), refreshed per frame
  from FOV and drawing-buffer height. Baking a luminance would be right at one resolution and wrong at
  every other — exactly the bug D31 was.
- ⚠ **A single-pixel probe reads the PEAK, not `E/Ω_px`.** With σ = 1 px, Sirius peaks at
  14.9/(2π) ≈ 2.4 cd/m² while carrying its full flux. §9's gate must be read against the peak or against
  an integral; "flux ÷ one pixel" would look like a 6× failure when nothing is wrong.
- ⚠ **Instanced attributes are vertex-only in WebGPU** — illuminance and colour cross to the fragment as
  varyings.
- Two new lint warnings, both the same pre-existing false-positive class as `Star.tsx`'s
  `uCoreRadiance`: `react-hooks/immutability` objecting to writing `uniform().value` from `useFrame`,
  which is the correct R3F pattern. 110 problems, **0 errors**.

## 8.3 S2 PASSED — and the two bugs the gate caught (2026-08-19)

| star | flux measured / expected |
|---|---|
| Sirius | **0.9994** |
| Vega | **0.9995** |
| Betelgeuse | **0.9994** |

Solved on-screen σ **0.9997 px** against an intended 1.0; sprite **7.998 px** against 8; sampling offset
**0.5003 px**. Peak ratio 0.882 = `exp(−0.5²/2)` to four figures — the half-pixel artefact, quantified and
expected rather than mysterious. The remaining 0.06% is half-float.

### 🔑 Lesson 1 — compare FLUX, not PEAK, for a point source

The first gate compared peaks and reported **0.7087 for all three stars**. Identical to four significant
figures across three magnitudes and two very different colours: impossible as noise, therefore one
systematic factor. Peaks depend on where the star lands relative to the pixel grid (aiming dead-centre
puts it on a pixel *corner* for any even-sized buffer); the pixel SUM is 2πσ² regardless — verified
6.2832 both on-grid and half-pixel-off. Flux is also the quantity the design promises to conserve.

### ⚠⚠ Lesson 2 — a loose tolerance CERTIFIES bugs

That first gate had a ±40% band, so it printed **"✅ GATE PASSED"** on a 29% error that was hiding *two*
real bugs. Tightening to ±10% (justified because flux is placement-independent) is what made them
visible. A tolerance chosen to avoid false alarms is a tolerance that will bless a broken renderer.

### 🐛 BUG A — `THREE.AdditiveBlending` applies the alpha, so the Gaussian was squared

That preset is `blendSrc = SrcAlpha, blendDst = One`: it multiplies the fragment colour by its alpha. The
shader returned the PSF weight *as* alpha, so the written value was `amplitude·g²` — and
`g² = exp(−r²/σ²)` is a Gaussian of width **σ/√2** whose integral is `πσ²`, i.e. **exactly half the
flux**. Fixed with `CustomBlending` + `OneFactor`/`OneFactor`.

⚠ **Invisible in the peak**, because `g(0)² = 1`. Only a flux integral could ever have caught it.

### 🐛 BUG B — the small-angle pixel size is wrong at wide FOV

`pxAngle = fov/height` is wrong by `u/tan(u)`: 0.4% at 10° but **14.7% at this camera's 75°**, making
every sprite 0.853× too small and its flux 0.727× too low. A perspective projection is linear in
**tan(angle)**, not angle. Now `tanPerPx = 2·tan(fov/2)/height`, feeding **both** the quad size and the
solid angle from one quantity so they cannot drift apart.

### The arithmetic that identified them

Two measurements against two unknowns determine both:

```
fluxRatio = σ_screen²                  → σ_screen = 0.6029   (intended 1.0)
peakRatio = exp(−r²/2σ_screen²)        → r        = 0.5002 px  ← exactly half a pixel
```

`r = 0.5002` confirmed the *model* was right and only an input was wrong. Then
`0.6029 / 0.853 = 0.7068 = 1/√2` named bug A, and:

```
½ (blending) × 0.7275 (projection) = 0.3638   measured 0.3635
1/√2       × 0.853                 = 0.6031   measured 0.6029
```

Two independently-derived factors reproducing the measurement to four significant figures — which is
what distinguishes an explanation from a plausible story.

⚠ **A wrong hypothesis on the way, worth remembering:** `devicePixelRatio = 1.8` with a render target
that was *not* dpr-scaled looked like an obvious culprit. It was not — `buffer / target` measured exactly
1.0. Printing the raw inputs killed that theory in one run, after two rounds of me reasoning past a
missing measurement.

## 9. Verification

The user's own test is the acceptance criterion: **at Earth's terminator with the sun just set, the
brightest stars should be visible.** Measured sky there is p50 = 74.5 cd/m² — a plausible twilight
zenith (real: 10–100), so the sky level is already right. Sirius at 14.9 cd/m² against that is a
0.20 : 1 contrast, i.e. marginal in reality too, which matches "the brightest stars *start* to become
visible." Today our star sits 2,404× below the sky, so it is not marginal, it is absent.

Second criterion: **from Proxima, Sol should be a magnitude 0.40 star** — comparable to Altair. That
single check exercises the position pipeline, the parallax path and the magnitude conversion at once.
