# Cloud rendering — visible issues (2026-05-06)

Catalogue of the visible-quality problems with the current volumetric +
flat-overlay system, in priority order. Every issue here is a *visible*
defect — separate from the long-term Nubis roadmap in
`VOLUMETRIC_CLOUDS_PLAN.md`.

---

## #1 Terminator color is inverted

**Symptom.** The day side of Earth is washed orange/brown. The actual
terminator band reads grey. The expected behaviour — pure white sunlit
clouds, narrow orange band at the horizon, black night side — is reversed.

**Reference screenshot.** `Bildschirmfoto 2026-05-06 um 17.18.42.png`
(Africa under cloud cover; clouds over the lit hemisphere are warm
orange when they should be neutral white).

**Root cause.** `earthClouds.ts:515–518`:

```ts
const daylight = smoothstep(float(-0.1), float(0.5), sunDotPoint);
const sunset = daylight.mul(daylight.oneMinus()).mul(4);
```

`sunset` peaks at `daylight = 0.5`. With `smoothstep(-0.1, 0.5)`, that
maps to `sunDotPoint ≈ 0.2` — sun ≈ 11° above horizon, i.e. mid-morning,
not sunset. Peak orange tint fires across the entire day-side limb. By
the time the ray actually hits the terminator (`sunDotPoint = 0`),
`daylight` has dropped back toward 0 and so has `sunset` — the
terminator itself reads grey.

The original "asymmetric — tight night cutoff, wide day falloff"
rationale (preserved in the comments around line 504) was the wrong call:
sunset should be a *narrow* band centred on the actual horizon, not a
wide ramp across the lit side.

**Fix (proposed).** Replace the asymmetric smoothstep with a narrow
symmetric one centred on `sunDotPoint = 0`:

```ts
const daylight = smoothstep(float(-0.15), float(0.15), sunDotPoint);
```

Then:
- `sunDotPoint > 0.15` → full daylight, no sunset → pure white.
- `sunDotPoint ≈ 0`   → peak sunset → pure orange.
- `sunDotPoint < -0.15` → full night → black.

**Risk.** Narrowing daylight to `[-0.15, 0.15]` makes the night-side
cutoff softer than the previous `-0.1`. Should still leave clouds dark
on the night side — the multi-scatter octave's NaN-guard floor is gated
by `daylight`, so it cuts off cleanly at `daylight = 0`.

---

## #2 ~~2D and volumetric clouds are physically separate layers~~ — **resolved as misperception**

**Verified 2026-05-06.** Setting `uVolumetricBlend.value = 0`
permanently in `earth.ts:421` made the apparent "2D layer at altitude"
disappear, leaving only the surface-painted cloud texture. So there
is **no separate 2D shell mesh in 3D space** — the layer the player
perceived was the volumetric cloud slab itself, viewed at saturated
alpha.

**What actually happens:**
- The "2D cloud overlay" in `earth.ts:263–293` is painted onto the
  planet sphere's fragment shader as `mix(surfaceCol, cloudLit,
  cloudMask × flatCloudOpacity)`. There's no separate cloud mesh.
- `flatCloudOpacity = 1 - uVolumetricBlend`, and `uVolumetricBlend`
  is `clamp((35_000 - distKm) / 10_000, 0, 1)` where `distKm` is the
  ship-to-planet-centre distance. At low altitude (a few km),
  `distKm ≈ 6_372 km`, so `uVolumetricBlend = 1` and the surface
  overlay is fully off — exactly as intended.
- The "smooth 2D layer at altitude" the player saw was the volumetric
  layer **inside the slab at near-horizontal viewing angles**, where
  the 20+ km horizontal ray path saturates α to 1 and produces a
  uniform-colour wall (no dot pattern visible because nothing's left
  to dither).
- "Flying through the 2D layer" was traversing a dense volumetric
  cloud body and exiting into a thinner region where the dither/dot
  pattern is visible again.

**Conclusion.** This collapses into issue #3 (the dot/speckle problem).
Once the volumetric stops looking *qualitatively different* between
saturated and unsaturated regions — i.e. once smooth bodies smoothly
transition into thinner haze instead of "smooth wall → individual
dots" — the perception of two distinct layers will go away.

The cloud-on-ground shadow tap (`earth.ts:208`) stays active at all
distances regardless. That's by design and produces faint
darkening on the surface where clouds cast shadows; not a bug.

---

## #3 Volumetric clouds render as visible dots / speckle

**Symptom.** Close-range volumetric clouds appear as a field of
individual dots rather than smooth cloud bodies. Each dot looks like a
single pixel's contribution. No recognisable cloud silhouettes.

**Reference screenshot.** `Bildschirmfoto 2026-05-06 um 16.57.31.png`
(brown speckle field over Earth's terminator).

**Three compounding root causes:**

1. **Half-res cloud RT.** The cloud pass renders at half resolution
   (`CLOUD_RT_SCALE = 0.5` in `SpaceRenderer.tsx`). Each cloud pixel
   covers 4 screen pixels — visible blockiness at close range, even
   after bilinear upsample. We have ~120 FPS headroom on M2 Pro;
   full-res is affordable.
2. **Per-pixel cloud-top altitude variance is too high.** In
   `earthClouds.ts:632–635`:

   ```ts
   const colSample = texture3D(baseVolume, pColumn.mul(uColumnScale)).r;
   const colSharp = smoothstep(float(0.3), float(0.7), colSample);
   const topAlt = float(0.4).add(colSharp.mul(0.55));
   ```

   `smoothstep(0.3, 0.7)` on a Perlin sample produces hard jumps —
   adjacent pixels can see `topAlt` differ by 5+ km of vertical span,
   so they integrate to wildly different alphas. Adjacent columns read
   as discrete "dots." Was tuned this way deliberately for "dramatic
   tall-vs-short visual separation" assuming TAA would average it;
   TAA isn't averaging it because the per-pixel alpha variance exceeds
   the motion-gate threshold.
3. **`fract(sin(...))` dither isn't TAA-friendly.** The in-shader
   `tStart` jitter (line 431) is a pure screen-position hash plus
   `uDitherPhase`, which produces uncorrelated values between adjacent
   pixels. Halton(2,3) on the ray *origin* (D2) jitters sub-pixel, but
   the in-shader dither for `tStart` is independent. TAA can't average
   what isn't spatially correlated.

**Fix (proposed, in priority order):**

1. Drop half-res → full-res RT in `SpaceRenderer.tsx`.
2. Soften `topAlt` smoothstep: `smoothstep(0.1, 0.9, colSample)` or
   reduce the `0.55` multiplier so adjacent columns differ by less.
3. Replace the sin-hash dither with a stratified jitter coordinated
   with `uDitherPhase` so neighbouring pixels see correlated tStart
   values that average across frames.

Items (1) and (2) are independent and either alone should make a
visible difference.

---

## #4 Cloud bodies lack internal shading variation

**Symptom.** Even where volumetric clouds are dense, they read as
uniform-grey speckle rather than cloud bodies with sunlit tops and
shadowed undersides.

**Likely root cause.** The cone-traced light march + multi-scatter +
powder are firing per-sample but the dot/speckle issue (#3) prevents
the per-sample lighting from accumulating into recognisable shape
lighting. Likely auto-resolves once #3 is fixed; revisit then.

---

## Fix order (recommended)

1. **#1 — terminator curve** (1-line change, immediate visual win).
2. **#2 — 2D/3D layering** (read `earth.ts`, decide on fix option,
   implement).
3. **#3 — dot/speckle** (drop half-res first, tame topAlt second,
   stratified jitter third).
4. **#4 — internal shading** revisit after #3.

After this list is closed, return to the long-term Nubis roadmap in
`VOLUMETRIC_CLOUDS_PLAN.md` — next planned item is E1 (shell-shadow RT).
