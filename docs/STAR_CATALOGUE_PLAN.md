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
| **S0** | Data pipeline | script: VizieR → binary blob; verify counts and a spot-check of known magnitudes |
| **S1** | Renderer | instanced billboards, magnitude → luminance, PSF with flux conservation, B−V colour |
| **S2** | Validate | `__lum` probe on named stars vs the table in §1: Sirius ≈ 14.9 cd/m², mag 6 ≈ 0.0155 |
| **S3** | Diffuse split | strip stars from the panorama (or adopt the Deep Star Maps dust layer); re-measure `SKY_TEXTURE_MEAN_LINEAR` |
| **S4** | SH-L2 bake | closes D29 — the hull lit by the real sky |
| **S5** | Parallax | 3D positions live; apparent directions recomputed on interstellar jump |
| **S6** | Neighbourhood set | navigation targets, names, the "acquire Proxima on instruments" loop |

**S2 is the gate.** Until a probe on Sirius reads ~15 cd/m² and a mag-6 star reads ~0.0155, nothing
downstream is trustworthy — the same discipline that caught every defect from D08 onward.

---

## 9. Verification

The user's own test is the acceptance criterion: **at Earth's terminator with the sun just set, the
brightest stars should be visible.** Measured sky there is p50 = 74.5 cd/m² — a plausible twilight
zenith (real: 10–100), so the sky level is already right. Sirius at 14.9 cd/m² against that is a
0.20 : 1 contrast, i.e. marginal in reality too, which matches "the brightest stars *start* to become
visible." Today our star sits 2,404× below the sky, so it is not marginal, it is absent.

Second criterion: **from Proxima, Sol should be a magnitude 0.40 star** — comparable to Altair. That
single check exercises the position pipeline, the parallax path and the magnitude conversion at once.
