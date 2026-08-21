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
| **S3** ✅ | Diffuse split | adopt a **star-free** dust layer (Deep Star Maps galaxy layer); keep it LDR — the band is only 2.6 stops, see §8.2; re-measure `SKY_TEXTURE_MEAN_LINEAR` |
| **S4** ✅ | SH-L2 bake | closes D29 — the hull lit by the real sky. Panorama projected off a 64×32 supersampled render, catalogue summed ANALYTICALLY. Gate `__lum.skyProbe()`. See §8.9 |
| **S4b** ✅ | Specular IBL | sky captured to a 256²/face cube → PMREM → `scene.environmentNode`; the band reflects off the hull. Gate witnesses `uPsfNorm` during capture (the 85.5× trap). See §8.10 |
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

## 8.4 S3 as built (2026-08-20) — the diffuse split

`scripts/strip_panorama_stars.sh` → `public/assets/8k_milkyway_diffuse.ktx2` (13 MB, down from the
star-laden 24.6 MB — a smooth field compresses better).

**Method: a radius-3 median filter.** Stars are impulses, nebulosity is a smooth field, so a median at a
radius larger than a star removes the former and keeps the latter — the standard way astronomers build
star-free background maps. No new asset had to be sourced.

🔑 **The split is DERIVED and cross-validated by two unrelated routes:**

| route | star share of sky flux |
|---|---|
| summing `E = 2.54e-6·10^(−0.4m)` over the whole catalogue vs 4π·1e-4 cd/m² | **19.5%** |
| linear flux the median filter removed from the texture | **20.9%** |

Agreeing to 1.4 points. So the diffuse layer is calibrated to `SKY_TARGET_NITS × (1 − 0.195)` =
**8.05e-5 cd/m²** and total sky flux is conserved across the change — re-enabling the panorama alongside
the catalogue does not shift the sky's overall brightness.

🔑 **That 80.5% is physics, not a fudge.** The catalogue's flux is still *rising* at its faint limit —
mag 5–6 alone carries 21% of it and mag 6–6.5 another 13% — so most integrated starlight comes from stars
*fainter* than the naked-eye cutoff. Those unresolved stars belong in a diffuse layer, together with
diffuse galactic light and zodiacal light.

**Verified in-engine** (Neptune's umbra, settled adaptation, samples across the Milky Way band):

| | measured | published |
|---|---|---|
| median of band samples | **1.303e-4 cd/m²** | galactic plane **1.25e-4** → **4%** |
| brightest sample | 2.35e-4 | Sagittarius peak 2.08e-4 |
| faintest sample | 9.5e-5 | mid-latitude 5e-5 |

The band correctly reads ~1.6× the whole-sky *mean*, which is what a band should do.

⚠ **A measurement trap that cost a wrong conclusion first time.** Measuring the texture's mean requires
**linearising BEFORE downscaling**. Averaging sRGB-encoded values and linearising afterwards
underestimates a high-variance field, because the EOTF is convex — and it did so badly enough that the
median filter appeared to *raise* the texture's mean (0.002441 → 0.002660), which is impossible. With the
order corrected: 0.002626 → 0.002078, a 20.9% drop. **When a measurement says something impossible,
the measurement is what is wrong.**

⚠ Two open caveats. (1) The radius-3 median also smooths genuine dust structure finer than ~3 px (0.13°
at 8k) — a visual judgement call, and a larger radius makes it worse. (2) `SKY_TEXTURE_MEAN_LINEAR =
0.002078` was measured on the **.webp** while the shipped asset is UASTC-compressed KTX2; the in-engine
probe above is what actually validates it, and the 4% agreement says any compression shift is small.

## 8.5 S3 revised — a SOURCED star-free map beats a filter (2026-08-20)

The median-filter build worked photometrically but **looked smudgy**, and the user (from
astrophotography experience) identified why immediately: *a median cannot distinguish a star from genuine
dust structure at the same scale — it removes both.* That was the caveat §8.4 flagged, and it dominates
the look.

**The fix is to source a map whose stars were never there.** NASA's Deep Star Maps 2020
(<https://svs.gsfc.nasa.gov/4851>) are RENDERED from Gaia DR2 + Tycho-2, so the starless variants simply
**omit** the catalogued stars. No filtering, no detail loss — strictly better than anything recoverable
from a composited image. `scripts/build_diffuse_sky.sh` replaces `strip_panorama_stars.sh`.

Three decisions, with reasons:

| choice | why |
|---|---|
| **celestial (equatorial), not galactic** | `StarField` owns a validated equatorial-J2000 → game rotation (0.07° against published coords for 3 stars). Galactic would need a second, different rotation — more code and another frame to get wrong. |
| **EXR source, 8k or 16k** | Float means no quantisation upstream of our single careful encode. The 1024×512 JPG is far too coarse; 4k is 5.3 arcmin/texel and reads soft, 8k is 2.6 arcmin and resolves dust lanes. |
| **still ship 8-bit sRGB** | The band is only **2.6 stops**, against ~8 usable in 8-bit — and decisively, Basis/UASTC (the whole KTX2 path) is LDR and cannot carry HDR at all. Float in, one careful encode, LDR out. |

⚠ **Licence upside:** NASA SVS imagery is generally public domain, which is materially better than HYG's
CC BY-SA given the intent to sell on Steam. Confirm on the page, and note Gaia's own attribution terms may
still apply upstream.

⚠ Two traps the script guards against:
- **Clipping.** An EXR is linear float and may exceed 1.0. Converting naively would clip the bright band —
  the part that matters most. The script measures the linear peak first and normalises against it. The
  absolute scale is irrelevant anyway, since `SKY_RADIANCE_SCALE` rescales to an absolute target; only the
  SHAPE and the measured mean matter.
- **Banding headroom.** It reports where the mean lands in 8-bit code values after normalisation, because
  a 2.6-stop signal squeezed into the bottom of the range would band on a smooth gradient.

⚠ And the measurement trap from §8.4 still applies and is still guarded: **linearise BEFORE downscaling.**

**Status: pipeline ready, asset not yet fetched.** `svs.gsfc.nasa.gov` is outside the sandbox's network
allowlist, so the download is a manual step:

```
./scripts/build_diffuse_sky.sh path/to/starless_celestial_8k.exr
```

then set the printed `SKY_TEXTURE_MEAN_LINEAR` and re-verify in-engine (band should read ~1.25e-4 cd/m²).
The `CATALOGUE_FLUX_SHARE = 0.195` split is unaffected — it comes from the catalogue's own magnitudes, not
from the texture.

## 9. Verification

The user's own test is the acceptance criterion: **at Earth's terminator with the sun just set, the
brightest stars should be visible.** Measured sky there is p50 = 74.5 cd/m² — a plausible twilight
zenith (real: 10–100), so the sky level is already right. Sirius at 14.9 cd/m² against that is a
0.20 : 1 contrast, i.e. marginal in reality too, which matches "the brightest stars *start* to become
visible." Today our star sits 2,404× below the sky, so it is not marginal, it is absent.

Second criterion: **from Proxima, Sol should be a magnitude 0.40 star** — comparable to Altair. That
single check exercises the position pipeline, the parallax path and the magnitude conversion at once.

## 8.6 S3b — the panorama's orientation, MEASURED (2026-08-20)

The asset from §8.5 loaded, calibrated and looked stunning — and was **misaligned**. This section is
mostly about *how the misalignment survived four fixes*, because that is the reusable part.

### The four failed attempts

| # | attempt | why it failed |
|---|---|---|
| 1 | `geo.scale(-1, 1, 1)` + `BackSide` | guessed. Also mirrors the UVs, so it swapped one wrong for another. |
| 2 | a derived `rotX(π − ε)` | guessed. `SphereGeometry` uses `x = −cos φ sin θ` with `uv = (u, 1−v)`, a **reflection** away from the celestial equirect convention — and **no rotation can undo a reflection**. |
| 3 | explicit UV from the world direction, `u = RA/2π, v = (90° − Dec)/180°`, verified to **1e-14** on six landmarks | The verification was *correct* and *useless*: it checked the formula against the equirect **definition**, and the definition was never the unknown. **The asset's convention was.** |
| 4 | `__lum.aim()` at Orion and at the north celestial pole "looking right" | Those tests were exercising the **star catalogue**, which is drawn as geometry and never touches the panorama's UVs. A passing test on the wrong subsystem proves nothing. |

🔑 **The symptom that finally made it unarguable** was a cross-check between two *independently sourced*
things in one frame: the **Big Dipper**, drawn from the catalogue (equatorial → game validated to 0.07°),
sat **on** the band. Its galactic latitude is **+60°**. One subsystem contradicting another is worth more
than any number of self-consistency checks.

### ⚠ A plane normal cannot solve this

An earlier pass fitted the band plane, found its normal **59° from the true north galactic pole**, and
stalled — correctly. A normal is **2 DOF**; a rotation is **3**. Worse, a plane fit returns **±n**, so it
cannot even distinguish a rotation from a reflection, which is the whole question.

### The measurement: `scripts/solve_sky_orientation.py`

Reads the panorama under whatever convention the shader currently implements, measures **four** landmarks,
and solves orthogonal Procrustes **with reflection allowed** (forcing `det = +1`, the usual Kabsch
convention, would have hidden the answer):

- **band plane** — luma-weighted moment tensor of pixel directions, solid-angle weighted; minimum
  eigenvector is the normal. Stable across floor percentiles (RA 23.026h → 23.008h, Dec +25.73 → +25.68).
- **galactic centre** — brightest *coarse-blurred* point within 12° of that plane.
- **both Magellanic Clouds** — the parity-breakers, and the only landmarks precise enough to trust.

🐛 **The blob detector's first version was wrong in an instructive way.** "Brightest pixel >15° off the
plane" returned two features **11.7°** apart against a true LMC–SMC separation of **20.75°** — they were
lumps of the galactic **bulge**, whose smooth glow at 15–25° latitude outshines the Clouds. **Peak
brightness does not identify an object; SCALE does.** Unsharp masking (a ~2° blur minus a ~20° blur) killed
the smooth bulge and the Clouds came out at **21.33°** apart.

### The answer

```
u = fract(0.5 − RA/2π)        v = (90° − Dec)/180°
```

RA 0h at the image **centre**, RA increasing **leftward** — the ordinary astronomical chart convention
(north up, **east left**). **The asset is a sky chart, not a globe texture**, which makes it a
**reflection** of the naive reading. That is precisely why attempts 1–2 could never have worked.

### Why this is believed, in order of strength

1. **`det(R) = −1.00000`** — a reflection, measured, not assumed.
2. **The Magellanic Clouds match to 1.17° and 0.68°.** They are compact and catalogued to arcminutes.
3. **Whole-image test — the decisive one.** Transform every pixel into true galactic coordinates and
   measure the luma-weighted rms galactic latitude of the light:

   | candidate | rms \|b\| |
   |---|---|
   | old formula (`u = RA/2π`) | **37.7°** — band smeared across the whole sky |
   | **`u = fract(0.5 − RA/2π)`** | **9.69°** |
   | best-fit offset `k = 0.4950` | 9.60° |
   | unconstrained 3×3 Procrustes | 9.66° |

   The residual 9.69° is the band's *real* thickness plus the Clouds at b = −33° and −44°.
4. **The unconstrained 3×3 buys −0.03°.** Its extra ~3° of tilt was fitting the two deliberately-fuzzy
   landmarks (the plane normal is biased by the band's brightness asymmetry; "brightest point near the
   plane" measured Dec −35.7 against Sgr A*'s −29.0). Those two carried the entire 6.70° worst-case
   residual while the Clouds sat under 1.2°. 🔑 **Judging the closed form on all four landmarks reported it
   as a non-fit** — a tolerance can be wrong by being *tight on the wrong measurements*, which is the
   mirror image of the ±40% lesson in §8.3.

### The gate: `await __lum.skyAlign()`

Does not aim at anything and ask a human to look. Landmarks are given in **galactic** coordinates so the
intent is unarguable. Uses the **median** of a 31×31 window (a catalogue star would dominate a mean) and
divides `SKY_ARTISTIC_GAIN` back out, so it measures physics and not the look knob.

#### 🐛 …and its first version FAILED the correctly-aligned sky

Worth recording in full, because the renderer was right and the **gate** was wrong. v1 asserted
`min(band) / max(off-band) ≥ 3` and measured **0.81×**. Both ends of that ratio were bad choices:

- **`b = ±20` at `l = 0` is still the galactic BULGE**, not off-band. It measures 0.20–0.31 of the centre —
  *brighter* than the band's faint stretches.
- **The band's own surface brightness varies ~6× along its length.** `l = 270` measures **0.17** of the
  centre. So v1 divided the dimmest point *on* the band by a bulge sample.

The same three ratios, computed offline on the raw asset by `solve_sky_orientation.py` §11 — same data,
same correct alignment:

| metric | value |
|---|---|
| `min(b=0) / max(\|b\|=90)` | **7.93×** ← the honest one |
| `mean(b=0) / mean(\|b\|=90)` | 38.55× |
| `min(b=0) / max(\|b\|=20, l=0)` | **0.56×** ← what v1 used |

🔑 **A gate is only as good as the quantity it compares.** A tolerance can be wrong by being *tight on the
wrong measurement* just as easily as by being *loose on the right one* (§8.3's ±40%). Both ship a renderer
whose state you do not actually know — and this one is the more dangerous failure, because a false ❌ invites
you to "fix" working code.

#### v2 — what it asserts now

1. **`min(b = 0) / max(|b| = 90) ≥ 3`.** The poles are the only place on the sky unambiguously off the band.
2. **Brightness falls monotonically with `|b|` along each meridian arm** (b = 0 → ±20 → ±40 → ±60 → ±90,
   1.25× slack per rung for faint-end noise). This is the signature that actually discriminates: a
   misaligned panorama crosses the latitude ladder at some other angle and cannot produce it. Comparing
   along a meridian divides the longitude variation out.

#### Offline and in-engine agree

The strongest single consistency check available, since the two share no code — Python sampling the EXR
versus WebGPU sampling the UASTC texture through the TSL graph:

| landmark | offline (rel. to centre) | in-engine (rel. to centre) |
|---|---|---|
| l=0, b=0 | 1.000 | 1.000 |
| l=90, b=0 | 1.103 | 0.982 |
| **l=180, b=0** | **0.435** | **0.436** |
| l=270, b=0 | 0.172 | 0.229 |
| l=0, b=+20 | 0.204 | 0.218 |
| l=0, b=−20 | 0.307 | 0.284 |
| l=0, b=+60 | 0.034 | 0.039 |

The faint end drifts a little because the offline sampler subtracts a p02 floor while the engine carries the
diffuse floor plus faint catalogue stars. The anticentre agreeing to **0.435 vs 0.436** is the meaningful
number.

### Side effect worth knowing

The `fract` wrap — and therefore the **seam** — moved from RA 0h to **RA 12h**, where it now coincides with
`atan`'s own branch cut. Both still land on the texture's `u = 0/1` boundary, which is the only thing
`wrapS = RepeatWrapping` needs in order to keep the pole-to-pole line suppressed.


## 8.7 Star magnitude compression (2026-08-20)

`STAR_ARTISTIC_GAIN` is a **flat** lift — it multiplies Sirius by the same factor as a mag-6.5 star. But the
reason to lift at all is the **faint** end: stars should stay visible when the hull is sunlit. (A real eye
would lose them — Apollo crews had to shield their eyes from sunlit surfaces to see stars — so this is a
deliberate gameplay deviation, not a bug fix.) Dragging the bright end along is pure cost, and the cost is
specific:

🔑 **Gain makes stars BIGGER.** Apparent radius is where the Gaussian crosses the display threshold,
`r = σ·√(2·ln(A/T))` with `A ∝ gain`, so gain enters under a log but never cancels: 1024× widens a 2σ star
to ~4.2σ. The instinct is then to shrink σ — which is how σ reached **0.6**, i.e. **FWHM 1.41 px**, well
under the FWHM ≥ 2 px critical-sampling rule from astronomical photometry. Below that the brightest pixel
depends on sub-pixel position (the same aliasing D31 fixed in the meter, and the reason `__lum.star()` gates
on flux rather than peak), which shows up as **twinkling — worst on stars near the visibility threshold,
which pop in and out rather than merely wobbling.** There is no scintillation in vacuum, so it reads as an
obvious artefact.

**So the two look knobs were fighting each other.** Compression separates them:

```
m_render = ANCHOR + γ·(m − ANCHOR)          ANCHOR = 6.5 = the catalogue's faint limit
```

Anchoring at the faint limit means **faint-star visibility does not move at all** for any γ — only the
bright end comes down, which is the end that was forcing σ down.

| γ | Sirius eff. mag | σ for same apparent size | FWHM | Sirius : faintest |
|---|---|---|---|---|
| **1.00** (identity) | −8.99 | 0.60 | 1.41 | 1528× |
| 0.70 | −6.60 | 0.69 | 1.64 | 169× |
| **0.55** | −5.40 | 0.76 | 1.79 | **56×** |
| 0.40 | −4.21 | 0.85 | **2.01** | 19× |

⚠ **FWHM 2.0 is not free.** Apparent size comes from where the Gaussian crosses the clip threshold, so
compressing brightness compresses **size** too — and the brightness hierarchy is much of what makes
constellations readable. At γ = 0.4 Sirius is only **19×** the faintest visible star against 1528× in
reality: the sky goes flat. **0.5–0.6 is the sane range.**

### As built

| decision | why |
|---|---|
| applied in the **vertex** stage | per-instance, so 4 evaluations per star rather than one per covered pixel |
| in the **shader**, not the buffer | `aIllum` keeps the true photometric value; the physical layer stays auditable. The file's own rule: never fold a look adjustment into the catalogue or into `starIlluminanceGame()` |
| expressed in **illuminance**, `E_render = E_anchor·(E/E_anchor)^γ` | one `pow`, no logarithm |
| γ = 1 **short-circuits the node entirely** | the default is bit-identical to the uncompressed render, not "identical up to `pow(x, 1.0)`" |
| `starCompressionFactor(magV)` exported | `__lum.star()` must divide it out |

⚠ **The gate needed a per-star divisor, not a constant.** `STAR_ARTISTIC_GAIN` is one number for the whole
sky, but compression scales *each star differently*. Dividing out only the gain would make the gate read 1.0
at the anchor magnitude and drift smoothly with brightness everywhere else — which looks exactly like a
photometric bug in the renderer. The table now prints the gain, the per-star compression factor, and their
product, all labelled "divided out".

**Verified:** `starCompressionFactor(m)·E(m)` against the shader's `E_anchor·(E/E_anchor)^γ` over 30 (γ, mag)
pairs — max relative disagreement **7.3e-16**. γ = 1 gives exactly 1.000000000000000 for every magnitude,
and the anchor magnitude gives exactly 1 for every γ.

⚠ Recomputing this table also caught **two errors in the numbers I first quoted**: the "Sirius : faintest"
column had 27× and 83× for γ = 0.55 and 0.40, which were the *peak-reduction* factors (27.1× and 81.4×) in
the wrong column. The true ratios are **56×** and **19×** — i.e. the hierarchy cost is materially worse than
first stated, which is what moved the recommendation firmly to 0.5–0.6.


## 8.8 The star gate needed aperture photometry — and a unit bug it had been hiding

Setting `PSF_SIGMA_PX = 0.85` and `STAR_MAGNITUDE_COMPRESSION = 0.6` made the gate report Sirius at
**1.033×** and Vega at **1.058×** — both passing at ±10%, but *disagreeing with each other*, which for a
systematic factor is the interesting part. Two separate defects, and neither was in the renderer.

### 🐛 A factor of 1 hides a unit error perfectly

The diagnostic table printed:

```
"solved σ on screen (px)": Math.sqrt(fluxRatio)
```

`sqrt(fluxRatio)` is the **dimensionless scale** `σ_screen / σ_intended`, printed with a `px` label. It was
invisible for as long as `PSF_SIGMA_PX` was exactly **1.0** — the single value where a ratio and an absolute
σ are numerically equal. The gate had been reporting "σ 0.9997 px vs intended 1.0" and reading like a
triumph.

Setting σ = 0.85 exposed it at once: the table claimed **1.017 px** against an intended 0.85, which looks
like a 20% rendering error and is actually **1.7%**. The sampling offset inherited the same bug — it used
`fluxRatio` where `σ_screen²` **in px²** belongs:

| quantity | reported | correct |
|---|---|---|
| Sirius σ_screen | "1.017 px" | scale 1.0164 ⇒ **0.864 px** |
| Sirius offset | 0.597 px | **0.508 px** |
| Vega σ_screen | "1.029 px" | scale 1.0286 ⇒ **0.874 px** |
| Vega offset | 0.603 px | **0.513 px** |

Corrected, both offsets land at ~0.51 px — half a pixel, exactly as the model predicts for a star aimed at
the dead centre of an even-sized buffer. 🔑 **Same lesson as the `pxAngle = fov/height` small-angle bug this
very table was built to catch: anything printed with a unit must be constructed with one.** The table now
prints the scale and the absolute σ as separate rows, and states the expected offset inline.

Also fixed: `sprite scale error` reported `1/scale` as "N× too small" — inverted. It now reads
`"+1.6% LARGER than intended"`.

### ⚠ A raw window sum is aperture PLUS SKY

`SKY_ARTISTIC_GAIN` has been pushed to ~1e3 as a stand-in for the Phase 7 adaptation model (§8.7), which
makes the diffuse Milky Way a genuine contributor inside a 15×15 window. Sirius sits at galactic latitude
**−8.9°** and Vega at **+19.2°** — both near the band, and contaminated by different amounts, which is why
they disagreed.

The fix is the standard one from astronomical photometry: estimate the sky from an **annulus** outside the
aperture and subtract `sky × aperture_area`.

| choice | why |
|---|---|
| annulus at Chebyshev radius ≥ `half + 2` | at σ ≈ 0.85 px the Gaussian there is ~e^−56 of peak, so it cannot contain any star |
| **median**, not mean | with 8,920 catalogue stars, a neighbour landing in the annulus is likely; a mean would inherit it |
| subtract from the **peak** as well | otherwise the σ/offset solve inherits the bias |
| report `sky was % of raw sum` | a silent correction is just a different unmeasured number |

**Predictions for the next run**, if the excess was entirely sky: flux ratio → ~1.000 for both, σ_screen →
~0.850 px, offset → ~0.500 px, with the sky rows reading ~3.2% (Sirius) and ~5.5% (Vega).

⚠ **But sky is probably not quite the whole story, and the gate now says so rather than guessing.** At equal
per-pixel sky, Vega should be contaminated **2.25×** more than Sirius (it scales as
`aperture_area / (lookGain · expectedFlux)`). Observed is **1.76×**, implying Vega's sky is 0.78× Sirius's —
where the `skyAlign` latitude ladder puts that pair nearer 0.5×. So a residual of order 1–2% may survive.
The `sky was % of raw sum` row is what turns that from speculation into a reading.

### ✅ Measured, at `STAR_MAGNITUDE_COMPRESSION = 0.6`, `PSF_SIGMA_PX = 0.85`

| quantity | predicted | Sirius | Vega |
|---|---|---|---|
| FLUX measured / expected | ~1.000 | **1.002** | **1.006** |
| solved σ on screen | ~0.850 px | **0.8508** | **0.8525** |
| σ scale vs intended | ~1.000 | 1.001 | 1.003 |
| sampling offset | ~0.500 px | **0.5005** | **0.5019** |
| sky share of raw sum | ~3.2% / ~5.5% | **3.06%** | **4.91%** |

**0.2% and 0.6%** against published magnitudes — the tightest this gate has ever read, and it now reads that
tightly with two look knobs active, which is the whole point of dividing them out.

The predicted residual did **not** survive: sky was essentially all of it. 🔑 And the reason the
latitude-only inference was wrong is worth keeping — **it ignored LONGITUDE.** The band varies ~6× along its
length (§8.6's ladder: `l = 270` measures 0.17 of the centre), and Sirius sits at `l = 227°`, a faint
stretch, while Vega is at `l = 67°`, a brighter one. That offsets Sirius's lower latitude and moves the
expected ratio from 0.5 to the measured **0.729**. Implied aperture sky: **0.103 cd/m² per px** at Sirius,
**0.075** at Vega — a direct consequence of `SKY_ARTISTIC_GAIN = 1024`, and a number that will change when
Phase 7 replaces that knob.

## 8.9 S4 — the sky as a light (SH-L2 irradiance, closes D29)

An atmosphere-less umbra rendered pure black: the key light and its bounce fill both derive from the sun and
both vanish in shadow, so nothing lit the hull. The calibrated sky was not a light source.

### Design, and where it agrees and disagrees with the engines

SH-L2 for distant **diffuse** irradiance is the standard — Unity's ambient probe, Unreal's SkyLight lower
band, Frostbite's distant diffuse — because the cosine lobe is smooth enough that 9 coefficients capture
~99% of the response to any environment (Ramamoorthi & Hanrahan 2001). 27 floats, no texture, no per-frame
cost. `LightProbeNode` is registered in three's WebGPU library (`BasicNodeLibrary`, verified in 0.183.2), so
`THREE.LightProbe` reaches **every** standard material with no per-material shader work.

🔑 **The two halves of the sky are integrated differently, and that is the interesting part.** The obvious
engine answer is to capture the sky into a cubemap and prefilter it. But the catalogue's stars are **delta
functions** — the same property that made a panorama unable to *render* them (§1: flux is correct at exactly
one FOV). Rasterising them into a cubemap smears each star across whatever texel it lands in. SH has no such
problem: a point source of illuminance E from direction d contributes **exactly** `E·Y_i(d)`, at any
resolution. So the panorama is projected numerically off a 64×32 render, and the catalogue is summed
analytically inside the parse loop that already existed. Measured: the catalogue half was correct on the
first run, to 4 significant figures.

**Runtime bake, not 27 pasted constants.** Rejected the offline option because this repo has twice been
burned by a derived constant drifting from its asset (`SKY_TEXTURE_MEAN_LINEAR`, and the orientation itself,
§8.6). A bake that reads the shipped texture through the shipped mapping cannot go stale, and it works
unchanged for a procedural sky. It also forced a structural improvement: the panorama UV mapping now lives in
`skyPanoramaMapping.ts` with **one** copy, shared by the renderer and the bake — because a bake that
disagreed with the render about where the galactic centre is would light the hull with a sky that is not the
sky on screen, and no picture could show you that.

### 🐛 Three defects, all mine, all caught before or by the gate

**1. Double-counted `SKY_ARTISTIC_GAIN`** (caught before running). The bake was handed
`SKY_RADIANCE_SCALE × SKY_ARTISTIC_GAIN` while `SkyLight` also multiplies by it — 1024² = 1.05e6×. The
Venus-trim cancellation pattern, and invisible in practice because nothing else in an umbra is a brightness
reference.

**2. ⚠⚠ HALF-FLOAT UNDERFLOW IN THE BAKE — D25, reproduced inside the module whose own comment warns about
that exact floor.** The bake rendered *calibrated* radiance (~1.3e-8 game units) into an RGBA16F target whose
smallest subnormal is 2⁻²⁴ = **5.96e-8**. Most of the sphere underflowed to zero; only the bright band
survived. Measured mean **2.2807e-9** against a **1.3332e-8** target — **5.85× low**.

The arithmetic that nailed it, from one gate run:

| | |
|---|---|
| catalogue band-0, predicted `0.886227 · Y₀₀ · 4.062e-8` | **1.0154e-8** |
| measured total band-0 | 1.7323e-8 |
| ⇒ implied panorama part | **7.1686e-9** |
| π × measured panorama mean | **7.1650e-9** |

Agreement to 4 figures ⇒ the catalogue half was exact and the panorama half was the whole error.
🔑 **The fix is not a wider buffer, it is to keep the numbers O(1) where the precision lives:** render the
raw texel (in [0,1]) and apply `radianceScale` on the CPU in float64. Source pre-exposure's trick, without
needing an exposure.

**3. Asserted a sign at the wrong angle.** The gate claimed the antipode lobe "should be NEGATIVE". It is
`+1/16` exactly — since `Y_lm(−d) = (−1)^l Y_lm(d)`, the antipode is `[Â₀ − 3Â₁ + 5Â₂]/4π`. The lobe *does*
go negative, at `cos θ = −8/15` (θ = 122.2°) where it equals exactly `−19/480`. Replaced by three
closed-form assertions from `E(θ)/E = ¼ + ½cos θ + (5/32)(3cos²θ − 1)`.

### ⚠ Tolerance is bounded below by the REFERENCE constants

The gate first failed correct code at 1e-6, because three publishes its SH constants rounded to six decimals:

| constant | exact | three | rel err |
|---|---|---|---|
| Y₀₀ | 0.282094791774 | 0.282095 | 7.4e-7 |
| Â₁·Y₁ | 1.023326707946 | 1.023328 | 1.3e-6 |

Nine such terms accumulate to ~1.6e-6. A real defect here — wrong normalisation, missing `sinθ` weight,
dropped `Â_l` — is percent-level. Hence **1e-5**: an order of magnitude above the achievable floor, four
below anything that could be wrong. 🔑 Same family as §8.8's unit bug: **know what your instrument's own
precision is before choosing a tolerance.**

### What the gate asserts, and expected values after the fix

| quantity | expected |
|---|---|
| uniform sky of radiance L | irradiance **exactly πL** on every normal |
| delta source, at the source | **17/16 = 1.0625** |
| delta source, antipode | **1/16 = 0.0625** |
| delta source, minimum (cos θ = −8/15) | **−19/480 = −0.0395833** |
| `panoramaMeanRadianceGame` | **1.3332e-8** (ratio 1.0000×) |
| band-0 irradiance | **5.2039e-8** game units |
| band-0 / (π × panorama mean) | **1.2424** — the catalogue's 0.195/0.805 share |

⚠ The absolute panorama check is new and exists *because* the ratio test, while it did catch the underflow
(2.418 against a predicted 1.24), blamed the wrong half. **A ratio between two measured things says they
disagree; only an absolute check against a known target says which one moved.**

### Deliberately not done

- **No specular.** SH-L2 cannot carry a mirror reflection; star reflections on a glossy hull need a
  prefiltered GGX cubemap (the split-sum half of the engines' scheme). That is **S4b**.
- **No occlusion.** One global probe for a sky at infinity, so inside Luna's umbra the hull receives the
  whole sky although Luna blocks half of it. The disc-overlap machinery from D27 (`sunOcclusion.ts`) could
  supply a scalar factor per body.

## 8.10 S4b — specular IBL, and the skybox mip artefacts (2026-08-21)

Sky captured into a 256²/face cube, PMREM'd, assigned to `scene.environmentNode` — the split-sum half of the
engines' scheme (Karis 2013). ✅ Verified in-game: the galactic band reflects off the hull.

**Option A, not B, and why.** `MeshStandardNodeMaterial.setupEnvironment` ends with an unconditional
`return new EnvironmentNode( envNode )`, and `EnvironmentNode` writes BOTH `context.radiance` and
`context.iblIrradiance`. A specular-only environment is unreachable without a prototype patch on three or
re-creating every material as a subclass. So the environment supplies both terms and `SkyLight`'s SH probe is
held at `intensity = 0` — kept mounted and current because it is the intended REFERENCE for validating the
capture. ⚠ `scene.environmentIntensity` is **dead** in the WebGPU node path (it exists on `Scene`, nothing
reads it); only `material.envMapIntensity` reaches the shader, which is why the per-frame pre-exposure rides
on `scene.environmentNode = pmremTexture(cube).mul(uPreExposure)`.

**⚠ The 85.5× trap.** `StarField` derives sprite size and PSF normalisation from the CANVAS buffer height and
FOV. A cube face is 90° over 256 px, so capturing without overriding those inputs gives every star
`(0.0078125/0.000845)² ≈ 85.5×` its correct flux. ⚠ I first quoted 50× from the height ratio alone — the
projection is linear in **tan**(angle), the same trap as the `pxAngle = fov/height` bug. Hence
`withStarCaptureResolution(faceSize, body)` takes fov AND height through the one shared derivation.

**🐛 The gate failed a working capture, and blamed the wrong thing.** Its first version compared
`getStarPsfInputs()`, which reads `_psfDebug` — a field only StarField's `useFrame` writes. The override set
the uniforms correctly but not that field, so the gate reported the on-screen 75°/1783 px and confidently
told the user `withStarCaptureResolution` had not run. 🔑 **Witness the UNIFORM the shader samples, not a
bookkeeping field that travels alongside it.** A diagnostic that reads its own notes is worthless exactly
when the notes and the state diverge — which is the only time you need it. Now compares `uPsfNorm` against
`1/(2πσ²·Ω_face)`: reads **3609.13 vs 3609.13 → 1.000×**.

⚠ That was the third time in this work that the INSTRUMENT was wrong rather than the renderer (after §8.8's
σ unit label and §8.9's antipode sign). Every one was measuring a proxy instead of the thing.

### The skybox seam line and pole smears — solved

🔑 **The diagnostic observation was the user's:** the line read DARK grey on bright sky and LIGHT grey on dark
sky. Only something pulling toward the GLOBAL MEAN inverts contrast like that — i.e. a 1×1 mip. That skipped
the entire edge-mismatch-vs-compression hypothesis space.

**MEASURED: the shipped KTX2 has `levelCount: 14`**, a full chain down to 1×1, because `convert-to-ktx2.sh`
passes `--genmipmap`. `generateMipmaps = false` only stops *three* from generating mips. At the RA 12h seam
`u` wraps a full turn in one pixel and at the celestial poles every `u` converges, so implicit LOD selection
reached near level 13 — a **~5,800×** texel-footprint error. (Smear positions confirmed the poles
independently: the south celestial pole is ~18° from the Magellanic Clouds, both poles 27° off the plane.)

**⚠ A hard `.level(0)` is NOT free** — at 1080p the screen is coarser than the texture (0.056°/px vs
0.044°/texel) and would alias. ✅ Fix: compute the LOD **analytically per frame**, since a sphere at fixed
radius has uniform angular scale and one global LOD is genuinely correct:
`max(0, log2(tanPerPx / (2π/texWidth)))` → **0.890 @1080p, 0.475 @1440p, 0.166 @1783p, 0 @2160p**. Those
being small is the proof the GPU was ~12 levels off. ✅ User confirms no artefacts on three resolutions.

**⚠⚠ And a real crash `tsc` cannot catch.** `uSkyLod` was first declared AFTER the material `useMemo` that
closes over it — a temporal dead zone, throwing on first render. TypeScript does not track TDZ across
closures; the `react-hooks` React Compiler rule caught it. 🔑 **A new `pnpm lint` ERROR is a bug report, not
a style note.**
