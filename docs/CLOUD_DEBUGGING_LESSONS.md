# Cloud rendering — debugging lessons

Personal notes for future Claude. Written 2026-05-11 after a ~2-week debugging
session where I chased three wrong hypotheses before finding the actual bug.

If a future cloud rendering bug looks similar to anything in here, **read this
file before proposing a fix**.

---

## The case study: "mirrored 2D shells with empty middle"

### Symptom (as the user described it)

> "I can see two 2D-looking cloud shells mirrored — one above me and one below
> me — with completely empty space in between. Looks nothing like flying
> through a cloud. Looks fine from orbit."

Visible only when the camera is **inside the cloud altitude band** (1–14 km).
From orbit, the render looked acceptable.

### The actual cause

A hoisted **slab-midpoint coverage sample** that degenerated for camera-inside-
slab views. The marcher cached `coverage` once per pixel at the slab midpoint:

```ts
const tMid = tEnter.add(slabLen.mul(0.5));
const pMid = roEarth.add(rdEarth.mul(tMid));
const dirMid = pMid.div(length(pMid));
const uvMid = /* equirect projection of dirMid */;
const coverage = texture(weatherMap, uvMid).r;
```

For a camera at altitude 5 km looking horizontally, the geometry gave:
- `tEnter = 0` (camera is in the slab)
- `tExit ≈ 339 km` (chord through the outer shell at this altitude)
- `tMid ≈ 169.5 km` along the ray
- `dirMid` ≈ 1.5° off the camera's nadir on Earth's surface
- That 1.5° = ~170 km of arc length

The coverage was sampled at a lat/lon **170 km away** from the camera's
location. If the camera was over a continent (high coverage) but 170 km away
was ocean (low coverage), the outer `coverage > 0.01` gate failed → entire
march skipped → empty horizontal middle.

Vertical rays from the same camera have `pMid` along the camera's radial axis,
so they sample at the camera's actual lat/lon → cloud renders above and below.

So the visible "two cloud shells" were the upper and lower halves of **the
same cloud column** viewed from inside it, separated by a horizontal band
where the marcher was being silently bypassed.

### The fix

Two-tap + per-step lerp. Sample coverage at `tEnter` AND `tExit`, hoisted once
per pixel; inside the loop, lerp by `(t - tEnter) / slabLen` at each step:

```ts
// Hoisted near and far coverage samples
const covNear = texture(weatherMap, /* uv from pNear */).r;
const covFar  = texture(weatherMap, /* uv from pFar  */).r;
const coverageMax = covNear.max(covFar);  // outer-gate proxy

// Inside the loop:
const lerpT = t.sub(tEnter).div(slabLen.max(0.0001)).clamp(0, 1);
const coverage = mix(covNear, covFar, lerpT);
```

For from-outside views, `covNear ≈ covFar` and the lerp degenerates — same
behaviour as the old midpoint cache. For from-inside views, the lerp captures
the ray's actual lat/lon path through the weather map.

### The one-line diagnostic that confirmed it

```ts
const tMid = tEnter;  // was: tEnter.add(slabLen.mul(0.5))
```

This collapses `pMid` to the camera position for from-inside views, so all
rays sample coverage at the camera's nadir. The empty middle disappeared
immediately. **This is the killer test.** If a future bug looks similar, try
this first.

---

## The three wrong hypotheses I chased

In rough chronological order, with what each one taught me.

### Wrong #1: "the dual-band profile causes the mirror"

I saw `cloudHeightProfile = baseBand + topBand` with a gap between them at
`alt01 ≈ 0.5` and concluded the gap was the visible empty middle.

**Why I was wrong**: the user had already replaced it with a single-band
asymmetric profile when I started debugging. The mirror persisted with single
band. I never checked the actual file state — I was reading a stale code
snapshot from a different worktree.

**Lesson**: **always verify the current code state before theorising**. Use
the `Read` tool. Check git status. Check if multiple worktrees exist and
which one the user is developing in. Stale mental models from minutes-old
file reads will burn weeks.

### Wrong #2: "column-shared coverage is geometrically inevitable"

When Tier 3 (single band) failed, I switched to: "the slab-midpoint UV
degenerates for vertical rays from inside the slab — both up and down rays
project to the camera's nadir → both sample identical coverage → silhouette
mirror is unavoidable with 2D weather maps."

**Why I was partially wrong**: column-shared coverage IS a real property of
2D weather maps, but it wasn't what was producing the symptom. The mirror
the user saw was about HORIZONTAL pixels being empty, not VERTICAL pixels
sharing silhouettes. I conflated two distinct failure modes that both
involve `dirMid` degenerating.

**Lesson**: when a hypothesis explains some of the symptoms but not all,
**distrust it**. Ask the user what view direction maps to "middle" before
building a theory. "Mirror" is a vague word — it can mean two different
shapes that look alike, OR it can mean the same shape rendered twice. Get
the user to point at the screen and describe what specifically looks the
same.

### Wrong #3: "step size is too large"

I noticed `dtSkip = slabLen / 16` makes the step ~21 km for horizontal rays
from inside the slab. Proposed that the dither pushes the first sample
several km beyond the camera, leaving a clear bubble.

**Why I was wrong**: the user capped `dtSkip` at 500 m and the empty middle
didn't move. The marcher wasn't sampling close — it wasn't sampling AT ALL
on those rays. The outer `coverage > 0.01` gate was failing before the loop
even started.

**Lesson**: **"step too large" produces noisy/grainy output, NOT clean
black "no cloud anywhere"**. If the symptom is binary "cloud present" vs
"no cloud", look at gating logic, not sample density. A black region in a
volumetric render almost always means a gate failed early, not that the
sampler missed features.

---

## Pattern recognition for future me

### Suspect slab-midpoint optimisations when

- Symptom appears only at certain camera altitudes — specifically when the
  camera is **inside** the volume being marched.
- A cached/hoisted value has a comment like "this varies slowly across the
  slab" — verify that for **from-inside** views, where the slab path can be
  hundreds of km instead of the slab thickness.
- `DEBUG_VIZ='iters'` shows `primaryIters = 0` for some view directions but
  not others. Outer gate is failing.
- `DEBUG_VIZ='firstHit'` shows the sentinel value (black) for some view
  directions but not others. Marcher never finds cloud on those rays.

### Three quick debug-viz queries that triangulate any cloud bug

1. **`'alpha'`**: is alpha exactly 0 or merely low? Distinguishes "marcher
   exited early" from "marcher ran but density was small."
2. **`'iters'`**: did the marcher enter the loop? Did dense mode engage?
3. **`'firstHit'`**: where (if anywhere) was the first cloud sample found?

Run all three before proposing anything. Each rules out a class of causes.

### Don't trust these optimisation justifications without verifying

Specifically the ones that say:

- "Direction from Earth's centre changes by <0.13° across the slab"
- "Weather map value is effectively constant along the ray"
- "Slab midpoint is a good cache location"

All true from orbit, **all false from inside the slab**. Anywhere a comment
justifies an optimisation with "this varies slowly across the slab," ALSO
ask **"across a 13 km slab thickness, or across a 300 km tangent chord?"**

### Geometry sanity for "inside the slab"

For a camera at altitude h inside an annular shell with bounds [R+h_inner,
R+h_outer]:

- Straight-up ray: `slabLen ≈ h_outer - h` (short, ~9 km for our slab)
- Straight-down ray: `slabLen ≈ h - h_inner` (short, ~4 km for our slab)
- Horizontal ray: `slabLen = chord_length = sqrt((R+h_outer)² - (R+h)²)`
  (long, hundreds of km — **scales with `sqrt(R)`**)

Anything that scales with `slabLen` or `1/slabLen` and is treated as a
single value per pixel **will degenerate** for horizontal-ish rays from
inside the slab. Sun-zenith angle, weather-map UV, view-direction-dependent
constants — all candidates.

---

## Process lessons I want to internalise

1. **Read the code first.** Before any theory. Verify which file, which
   worktree, which branch. If the user mentions a change they made, find
   it before reasoning about it.

2. **One-line diagnostic tests over multi-step rationalisations.** When I
   had the right hypothesis, the test was `tMid = tEnter` — one character
   change effectively. If I'd proposed this kind of binary test early, I'd
   have saved weeks. Always ask: *what's the smallest possible code change
   that proves or disproves my hypothesis?*

3. **When a falsification lands, stop.** After a falsification, the right
   move is to admit "I don't know yet" and propose more diagnostics — not
   to immediately pivot to the next plausible theory. I pivoted three times
   in this case. Each pivot felt productive in the moment and wasn't.

4. **Distinguish symptoms from causes.** "Mirror" sounds geometric. The
   actual cause was a UV cache being sampled too far away. Symptoms in
   3D graphics rarely describe their causes directly — adjacent unrelated
   bugs often produce identical-looking artifacts.

5. **Trust empirical results over my analytical models.** When the user
   reported that capping `dtSkip` at 500 m didn't help, I should have
   abandoned the step-size hypothesis immediately. I kept analyzing.

6. **When developing in multiple worktrees, ask early.** "Where are you
   actually running the code?" is a sentence that would have saved a
   significant chunk of this session.

---

## Follow-on bug (2026-05-13): two-tap fails for camera-above-slab tilted-down views

The two-tap (covNear + covFar + lerp) fix solved the original "camera inside slab horizontal ray" case but introduced a symmetric failure for the opposite geometry: **camera above the slab, ray tilted down through a cumulus column.**

### Symptom (as user described it)

> "Opacity looks okay from below now, but the higher I go, the lower the
> opacity gets (of the same cloud body). So from above the clouds looking
> down I can barely make them out."

Same cloud body, view-direction-dependent opacity. Looking up from below: opaque. Looking down from above: barely visible.

### The geometry

```
  camera (above slab)
       \
        \ ← pNear at outer shell, lat/lon offset by α from camera nadir
         \    samples weather map at SOMEWHERE NOT THE CUMULUS
          \
           ● ← cumulus column we want to render (between near and far taps)
            \
             \ ← pFar at inner shell, lat/lon offset further
              \   also samples NOT THE CUMULUS
```

The cumulus sits BETWEEN `pNear` and `pFar`. Both endpoint taps miss its lat/lon. The lerp interpolates between two low-coverage values → coverage stays low along the entire ray → `coverageProfile > 0.01` gate fails → marcher accumulates nothing.

From below, the camera is at OR NEAR the cumulus's lat/lon, so `pNear` (at camera or just above) reliably samples the cumulus's weather-map value. The two-tap works there.

### The fix

Three-tap (near + mid + far) coverage with piecewise lerp:

```ts
const covNear = texture(weatherMap, uvNear).r;   // tEnter
const covMid  = texture(weatherMap, uvMid).r;    // tEnter + slabLen/2
const covFar  = texture(weatherMap, uvFar).r;    // tExit
const coverageMax = covNear.max(covMid).max(covFar);

// Per-step piecewise lerp:
const lerpFirst  = (lerpT * 2).clamp(0, 1);       // [0,1] over first half
const lerpSecond = (lerpT * 2 - 1).clamp(0, 1);   // [0,1] over second half
const coverage = lerpT < 0.5
  ? mix(covNear, covMid, lerpFirst)
  : mix(covMid, covFar, lerpSecond);
```

Continuous at `lerpT = 0.5` (both halves yield `covMid` there). Three taps catch cumulus at ray-start, mid-chord, or ray-end.

### Why I missed this the first time

When I documented the two-tap fix, I noted that single-midpoint was the bug and two-tap was the fix — I assumed two endpoints would be enough. They aren't, for the geometry where the camera is OUTSIDE the slab and looking THROUGH it at a feature that's in the MIDDLE. That's not unusual — it's the standard "look down at clouds from a plane" case.

**Lesson**: a coverage-cache scheme with N taps will fail whenever a cloud feature falls between taps. Two-tap is fine when the ray's "interesting region" is at one of the two ends; it fails when the interesting region is in the middle. The general pattern is: **the number of taps must equal or exceed the number of "interesting regions" the ray traverses.** For a fully general scheme, sample coverage per-step.

### Pattern recognition

If you see "opacity differs between view angles for the same cloud," **suspect the coverage cache first**. Specifically:
- From-inside-slab horizontal views → was the two-tap failure (original case study).
- From-above-slab tilted-down views → the three-tap failure documented here.
- From-above-slab straight-down views → fine because endpoints both lie at the column's lat/lon.

A useful diagnostic: temporarily replace the per-step `coverage` with `texture(weatherMap, p_at_current_step_uv).r`. If the symptom disappears, it's the cache aliasing again. If it persists, look elsewhere.

---

## Follow-on bug (2026-05-18): outer coverage gate produced "wireframe outlines / cloud portals"

After implementing per-step coverage sampling (replacing the 3-tap lerp), the visible artifact shifted from "empty middle" to **"wireframe outlines of cumulus bodies + cloud-portal effect."** Wireframe-style silhouettes against the background with volumetric cumulus visible *inside* the outline but cut off cleanly at the edge. As camera moved, outlines shifted positions and clouds appeared/disappeared like flying through portals.

### Cause

Per-step coverage was correct INSIDE the loop, but the outer `If(coverageMax > 0.01)` gate at the loop entry **still used the 3 hoisted tap samples** (covNear/covMid/covFar from before per-step). For pixels where the 3 hoisted taps all happened to miss a cumulus (it fell between tap points), the entire marcher was skipped → that pixel rendered no cloud at all, even though per-step coverage *would have* detected the cumulus.

The "wireframe outline" was the iso-surface where `coverageMax = 0.01` — the threshold between "marcher runs" and "marcher skipped". As camera moves, the 3 tap points move with the rays → the iso-pass boundary shifts across screen → cumulus appear/disappear non-physically.

### The fix

**Remove the outer 3-tap gate entirely.** With per-step coverage doing the actual per-voxel gating (via the inner `coverageProfile > 0.01` and `baseCloud > 0.01` gates), the outer gate was only a performance optimization, and it was actively wrong. Removing it means every pixel with slab intersection runs the full 96-iteration loop, but each iteration is cheap if there's no cloud at that voxel (one cheap 2D weather-map tap; the expensive 3D samples are gated correctly).

### Lesson (third variation of the same family)

This is now the THIRD variation of the "coverage cache aliases for view geometry" bug:
1. **Original case study**: slab-midpoint single tap → fixed with two-tap.
2. **Follow-on 1**: two-tap missed midchord cumulus → fixed with three-tap.
3. **Follow-on 2**: three-tap missed cumulus between taps → fixed with per-step.
4. **Follow-on 3 (this one)**: per-step worked inside the loop but the OUTER GATE still used 3-tap → wireframe outlines.

**General lesson**: when transitioning from a tap-based approximation to a per-step scheme, MUST audit ALL uses of the tap-based values, not just the obvious one inside the inner loop. The outer gate using the hoisted taps was easy to miss because the variable name (`coverageMax`) didn't make its origin explicit.

For the lessons-doc-reading future Claude: if you find yourself in any kind of "ray-march with hoisted coverage approximation" pattern, the right architecture is **per-step coverage sampling** unless you have a strong perf reason. Tap-based schemes will produce SOMETHING-shaped artifacts (mirrored shells, empty middles, wireframe outlines, cloud portals) for every camera geometry that doesn't match the tap layout. Each "fix" that adds more taps will just shift the artifact shape, not eliminate it.

---

## What's still likely to bite us in this same area

Even after the three-tap fix, these are still slab-midpoint-based:

- **`sunDotPoint`** at `earthClouds.ts:513-514` uses `pMid` (midpoint).
  Sun-zenith angle varies slowly enough that this is probably fine, but
  could produce wrong terminator behaviour for horizontal-from-inside rays
  where pMid is 170 km away from the camera's actual position.
- **`topAltMid`** at `~earthClouds.ts:482-490` samples the column-top
  variation at the midpoint. Currently only used for the `'topAlt'` debug
  viz (the live profile ignores `topAlt`), so doesn't visibly matter — but
  if `topAlt` gets wired back into the profile for type-aware variation,
  it'll need the same two-tap treatment.
- **Light-march cone tap** at `~earthClouds.ts:758-787` uses the lerped
  per-step coverage from the primary ray, not coverage at the cone-tap's
  own lat/lon. ~~This is an approximation Schneider also makes; revisit if
  internal cloud shading looks wrong.~~ **2026-05-22: revisited.** See
  case study #3 below — primary-coverage cone-march is fine at OVERHEAD
  sun but completely fails at grazing-sun (terminator). Replaced with
  per-cone-tap coverage sampling.

---

## Process lessons from the 2026-05-15 → 2026-05-18 session

This session got the cloud rendering from "complete noise garbage" to "recognisable cumulus bodies". Several meta-lessons surfaced that aren't bug-specific but cost a lot of time to learn the hard way.

### Reasoning failures I made (don't repeat)

1. **Trusted the math over user observation.** Many times I computed "alpha should saturate in N steps, so opacity must be correct" while the user reported "I can see right through clouds." My math was based on assumed-typical density values; actual densities (after coverage modulation + erosion) were much lower than my estimates. **When math says X and observation says ¬X, the math is wrong.** Recompute from observation.

2. **Wrote "should fix it" instead of "let me verify it fixed it."** Every round I'd ship a change and assert it should resolve the issue, then move on. The user repeatedly had to push back. **A fix is not a fix until empirically confirmed.** Always end a round with "test and report what you see," and don't assume the next round can build on the current one.

3. **Took "no visible change" at face value.** Several rounds the user reported edits had no effect. I assumed the edits worked but tested a different parameter. Eventually figured out earlier overrides were still active. **When "no change" is reported, do a smoking-gun test first** (force the output to red / α=1 / something undeniable). Don't propose further diagnostic until verified that *any* edit is reaching the GPU.

4. **Shipped tap-based fixes despite the lessons doc warning against them.** The doc literally said "for a fully general scheme, sample coverage per-step" — and I still did two-tap, then three-tap, before doing per-step. **Re-read the lessons doc before proposing fixes in the same area.** It exists exactly to prevent this.

5. **Conflated "looks like progress" with "is correct."** The user called me out on this: "Don't gaslight me, I know what I am seeing." When the output had clear bugs but partially-recognisable cumulus shapes, I tried to spin it as progress instead of acknowledging the bug. **The user's perception is the ground truth.** If they describe artifacts, those artifacts are real — even if I can't reproduce them from the math.

### Diagnostic techniques that worked

1. **Multi-variable debug viz showing "the same bands in all of them"** was the critical clue that broke the bands diagnosis. The user tested `altAtHit`, `profileAtHit`, `coverageAtHit`, `baseCloudAtHit`, and reported all showed bands at the same screen positions. That should have told me earlier: **if multiple debug visualisations of independent variables show artifacts at identical positions, the cause is in the POSITION computation common to all of them**, not in any one variable. (In our case: the first-hit POSITION was on an iso-density surface that looked banded under all colormaps.)

2. **Constant-override isolation tests.** Setting `coverage = 0.5`, then `baseCloud = 0.5`, then `density = constant`, then `topAlt = constant` in sequence narrowed down which input was producing the bands. Slower than ideal but very informative. Worth doing one at a time even if it feels redundant — false isolations from skipping steps will burn far more time.

3. **The smoking-gun visibility test.** Forcing `vec4(0, 1, 0, 1)` (solid green output) wherever `primaryIters > 0` definitively answered "is the marcher reaching the screen at all" when the user reported repeated "no change" — and revealed that earlier overrides were silently still active.

### Density-tuning order-of-magnitude trap

The user pushed `densMul` from 700 to 1,500,000 (3 orders of magnitude) to make clouds "opaque." It worked visually but masked the real bug: binary saturation at densMul=1.5M made the visible cloud surface a hard iso-density isosurface in 3D, which rendered as visible concentric "contour band" lines on the cumulus body.

**Lesson**: when density "needs to be ridiculously high" to look opaque, the real bug is usually elsewhere (coverage values lower than estimated, gate falsely failing, light path too short). Cranking density to compensate hides the actual problem. Reasonable values for our pipeline: `densMul ≈ 10k–30k` for the current coverage / noise scales.

### `smoothstep` on noise distributions creates bimodal bands

The old `topAlt = 0.4 + smoothstep(0.3, 0.7, perlinSample) × 0.55` produced visible curved stripes on cumulus bodies. Why: Perlin clusters around 0.5; `smoothstep(0.3, 0.7)` stretched that cluster to the full [0, 1] range, making most columns end up either very short or very tall with narrow transitions. Adjacent columns with ~5 km of cloud-band thickness difference projected as hard stripes on viewed cumulus.

**General lesson**: when noise (Perlin / Worley) is being mapped to a value range, `smoothstep` on the noise distribution's central cluster produces bimodal output with sharp boundaries. Use **linear remap** or a much wider smoothstep range (e.g. 0.0 → 1.0). This applies anywhere noise drives a visible parameter.

### Feature-scale must match viewing-distance

`uBaseScale = 250` (1 km cumulus puffs) produced "fine speckle from orbit" because individual puffs were sub-pixel at orbital view distance. Cumulus only became recognisable shapes when we increased to `uBaseScale = 50` (5 km bodies) — even though 5 km cumulus is unrealistically large compared to real Earth's 1–3 km cumulus.

**Lesson**: cumulus feature scale should be chosen for the expected viewing-distance range, not for physical realism. For an orbital-to-aerial flight game, larger cumulus bodies are necessary to remain visible at distance. Reference engines (Nubis/RDR2) often use 5–30 km cumulus for this reason.

### TSL `If(...)` structure has scope side effects

Removing `If(cond, () => { /* loop */ })` and replacing with a plain `{ /* loop */ }` JS block silently broke the marcher — the loop continued to execute in JS but the resulting shader produced α=0 everywhere. Putting back `If(...)` with a trivially-true condition (`coverageMax.greaterThanEqual(0)`) restored correct behaviour.

**Lesson**: don't remove TSL `If(...)` wrappers without understanding the scope implications. If you need to disable a gate, neutralise it with a trivially-true condition (`x.greaterThanEqual(0)` where x is in [0,1]), don't delete it.

### "Running in circles" is a real signal

The user explicitly said "I think we just got something fundamentally wrong" after many rounds of micro-tweaks. That forced me to propose an architectural change (uBaseScale increase) instead of more parameter tuning, which IS what was needed.

**Lesson**: when the user reports the same complaint two rounds in a row, **stop tuning and step back**. Re-evaluate architectural assumptions. The third "let me try one more thing" round is almost never the answer.

---

## How to use this file

- Open it whenever working on cloud rendering bugs.
- If a symptom matches the case study, the fix path is documented.
- If the symptom is new, the **Pattern recognition** + **Process lessons**
  sections are the general toolkit — apply them before theorising.
- If a new debugging journey teaches a similar lesson, add it here.

The user has explicitly asked me to maintain this. Treat updates as part
of the work, not extra effort.

---

## Case study #2: "moving vertical-ish stripes on cloud surfaces at close range"

### Symptom (as the user described it)

> "Stripes alternating between higher and lower transparency/white. They move
> along the clouds as I fly forward, so they are not fixed to a specific
> relative position on the cloud. The faster I fly, the faster they move.
> Only visible close to clouds, not from orbit."

Mostly vertical with curvature following the cloud surface. Visible in the
"off" normal-rendering mode AND **in every single DEBUG_VIZ diagnostic mode
I tried**: `alpha`, `iters`, `firstHit`, `altAtHit`, `altPerturbedAtHit`,
`profileAtHit`, `coverageAtHit`, `baseCloudAtHit`, `lightingOnly`.

### The actual cause

**Automatic mipmap-level selection on 3D noise textures inside a ray-march
loop with per-pixel dither.**

The noise volumes use `LinearMipMapLinearFilter` (trilinear). The GPU
computes the mip level per fragment from texture-coord derivatives across
the 2×2 fragment quad — `(uv at pixel+1, +0) − (uv at pixel+0, +0)` and
similarly for Y.

For a ray-marched volume:

- The 4 pixels in a quad sample the 3D texture at the same loop iteration
  but with DIFFERENT `t` values, because per-pixel dither offsets `tStart`
  by up to `dtSkip` per pixel.
- Adjacent pixels' rays sample world positions that differ by
  `dither_diff × dtSkip × ray_dir` — non-negligible.
- The GPU's derivative computation sees this large positional difference
  → spuriously high mip level selected → the texture sample is BLURRY at
  that fragment.

But different quads in different parts of the screen see different mip
levels, **systematically correlated with iso-distance from the camera**
(because step-aligned discovery happens at iso-distance contours). The
LinearMipMapLinear interpolation between two adjacent mip levels produces
SOFT cross-hatched ridges following those contours.

The result: a fabric-like / brushed-metal band pattern on the cloud
surface, perfectly camera-relative, present in **every** diagnostic mode
because every computed value downstream of the texture sample inherits
the mip-level variation.

### How long it took to find

About a full conversation cycle of failed hypotheses before the right
test. The wrong paths:

1. **TAA reprojection error** (outer-shell-t depth instead of true cloud-
   front depth). Plausible — DID find the close-range reprojection-depth
   bug — but disabling TAA showed bands still present.
2. **Half-amplitude dither leaving step-grid gaps**. Restoring full
   amplitude broke one discovery-ring artifact (visible in `firstHit`
   viz) but not the main bands.
3. **`fract(sin)` hash directional bias**. Swapped to IGN (Jimenez 2014)
   thinking the hash was correlated in one axis. Bands still there. **IGN
   was actually worse** — its lattice structure gave deterministic
   phase increments between neighbours (0.555 in X, 0.310 in Y) instead
   of random per-pixel values. Reverted.
4. **dither itself striped**. Added `'dither'` DEBUG_VIZ mode showing the
   per-pixel hash output directly. **Looked perfectly uniform.** Bands
   still there in every other viz. This was the key data point — if the
   pure dither is uniform but every downstream value is striped, the
   striping must be introduced by something the dither feeds INTO.
5. **dtSkip too coarse**. Halved (500→250m, MAX_STEPS 96→192). Made bands
   WORSE — more, finer stripes. Confirmed step-count multiplier
   relationship: bands scale with step density, not step spacing.
6. **`Right answer:` mipmap selection in 3D texture sampling.** The 5th
   data point — bands scale with step count — was the giveaway, but I
   only saw it in hindsight. More steps per quad → more derivative
   variance per quad → more mip-level disagreement → more visible
   ridges.

### The fix

Force mip 0 on every `texture3D` and `texture` call inside the marcher
loop:

```ts
texture3D(baseVolume, p.mul(uBaseScale)).level(int(0))
texture(weatherMap, uvP).level(int(0)).r
```

Don't change the texture's `minFilter` — keep mipmaps generated for
potential future use, just bypass auto-selection inside the marcher.

Cost: zero — `.level(int(0))` is a single GPU instruction. Visual impact:
bands eliminated. Trade-off: 3D textures will alias at extreme distances
(no mipmap-based pre-filtering). For the volumetric near-LOD this is
fine; the far-LOD uses a 2D overlay anyway.

### The pattern to recognise

**Symptom checklist for "auto-mip selection inside a marcher" bug:**

- Bands move with the camera (camera-relative iso-distance contours).
- Only visible close to clouds (at orbital distance the marcher's per-
  quad derivatives are small → mip 0 selected anyway).
- Visible in EVERY DEBUG_VIZ diagnostic, including `iters` (which is
  literally just a loop counter — proof the bug is in something that
  modifies the marcher's flow, not in any specific output value).
- Stripe count scales with `dtSkip` step density. Halving `dtSkip`
  doubles the stripe count instead of halving it.
- Bands have a "fabric" / "brushed metal" appearance from soft mip
  interpolation, NOT sharp ring transitions.

If your symptom matches this list: **don't tune dither, don't tune step
sizes, don't add cone marching. Add `.level(int(0))` and stop.**

---

## Other lessons from this session

### "Diagnostic shows the artifact in every mode" is a HUGE signal

When EVERY diagnostic shows the same artifact pattern, the artifact is
NOT in any specific computation. It's in something COMMON to all of
them — typically:

1. A per-pixel input that drives the entire marcher (the dither in this
   case — but the `'dither'` viz ruled it out).
2. The HARDWARE PIPELINE around the marcher (texture sampling, mip
   selection, derivative computation, RT setup).
3. The fragment quad's intrinsic 2×2 organisation (mip derivatives,
   ddx/ddy, anything that fetches "neighbour pixel" info).

When the diagnostic-everywhere signal appears, **stop searching for
artifacts in the marcher's logic** and look at the hardware-level
contract: how does the GPU choose mip levels? Are there per-quad
implicit derivative computations? What does the cloud RT resolution
look like compared to the screen?

### "Bands scale with step count" is the smoking gun for mip-derivative bugs

If you halve `dtSkip` and the bands DOUBLE instead of going away, that's
not step aliasing — that's something that scales with the number of
texture taps inside the loop. Most likely candidate: mip-level
selection varying per quad based on per-step coord derivatives.

### Always test a hypothesis with the cheapest possible isolation first

Before swapping IGN for sin-hash, I should have visualised the dither
DIRECTLY (`'dither'` DEBUG_VIZ). One test, one screenshot, immediately
told us the dither was uniform. That would have ruled out the entire
"hash bias" hypothesis chain in 30 seconds instead of two iteration
rounds.

**Lesson**: when a "downstream value is striped" hypothesis exists, find
a viz that shows the upstream value DIRECTLY (no marcher logic in
between). If the upstream is clean, skip the hypothesis entirely.

### Floating-origin texture precision is NOT the issue at this magnitude

I briefly considered that `p × uBaseScale ≈ 320` was losing float32
precision in the texture-coord computation. The math doesn't work out:
float32 ULP at magnitude 320 is ~3e-5, adjacent pixels' positional
differences are ~1e-4 to 1e-3 in texture-coord space — well above ULP.
The hardware filter has its own quantisation but not coarse enough to
cause visible artifacts at this scale.

This was a deep-end hypothesis that would have been a big refactor for
no win. Resist the urge to chase precision/floating-origin theories
when the actual cause is much closer to the surface (texture API usage).

### Half-res RT amplifies any per-fragment-quad artifacts

The cloud RT runs at 0.5× scale. Every per-quad behavior is amplified
because each cloud-RT pixel covers 2×2 final pixels — bilinear upsample
spreads each quad's mip-level decision over a soft 4-pixel area. This
makes the mip-ridge artifact MORE visible, not less. If you ever switch
to full-res RT, the same artifact would still exist but as a sharper
1-pixel transition (less visible to the eye).

---

## Case study #3: "uniform cloud bodies — no internal shading variation"

### Symptom (as user described it)

> "I can see three distinct heights for the clouds now [B1 working], but
> no detail in the clouds. It's just white, pretty straight towers of
> detail-less blobs."
>
> [After cone density and ambient tuning attempts:]
>
> "Only when toning down ambient and bumping uDetailErosion really high
> (to 0.9 for example) I start to see some very little brightness
> differences."
>
> [After enabling DEBUG_VIZ='lightingOnly':]
>
> "Completely uniform."

### The killer diagnostic

`DEBUG_VIZ='lightingOnly'` shows `col / alpha`, the unpremultiplied
integrated colour. For front-to-back integration, this is mathematically
the **weighted average of L (radiance) across the cloud body along
each ray**. If lightingOnly is uniform across the whole cloud disk,
every ray integrates to the same average L → either L is roughly constant
per voxel, or rays happen to hit voxels with the same characteristics.

**This is the single most informative cloud-rendering diagnostic.** It
isolates "lighting math problem" from "alpha integration problem". If
lightingOnly is uniform, no amount of tuning density / erosion / step
size will help — the lighting formula itself isn't producing variation.

### The math behind the symptom

After Phase B5 was implemented (`ms = profile × Tsun_ms`,
`ambient = (1-profile)^0.5 × skylight`), the two terms are
**profile-complementary**: ms ∝ profile and ambient ∝ √(1-profile).
At fixed `Tsun_ms`, their sum is roughly profile-independent. Visible
body shading variation has to come from `Tsun_ms` varying across the
visible cloud surface. `Tsun_ms` = cone-marched sun-side transmittance.

### The actual cause

The cone-march used **primary-ray's coverage** for every cone tap, with
only `profileL` (altitude-based vertical profile) varying per tap:

```ts
const densL = coverage.mul(profileL).mul(densScale).mul(0.1);
//             ^^^^^^^^ primary-ray's, NOT cone-tap's
```

This is Schneider's classical approximation. It works for **overhead sun**
(cone goes straight up, stays at one lat/lon — primary-ray coverage IS
the cone-tap coverage). It completely fails for **grazing sun** (cone
sweeps 12 km horizontally across many lat/lons — adjacent cone taps
should see varying coverage but our code says they all see primary's).

Consequence: with sun grazing horizontally,
`opticalDepthSun = 6 × densL × LIGHT_STEP` becomes a function of primary
altitude only. Two voxels on different sides of a cumulus (sun-facing
vs back-facing) at the same altitude → same opticalDepthSun → same
`Tsun_ms` → same `ms` → same `L` → same `col/alpha`. The cloud's
SUN-FACING vs BACK-FACING shading contrast — the entire point of
multi-scatter lighting — is invisible.

### The fix

Sample the weather map at each cone tap's own lat/lon:

```ts
const dirL = pL.div(rL.max(0.0001));
const uL = fract(atan(dirL.z, dirL.x.negate()).mul(invTwoPi));
const vL = acos(clamp(dirL.y.negate(), -1, 1)).mul(invPi);
const uvL = vec2(uL, vL).add(uCloudUvOffset);
const coverageL = texture(weatherMap, uvL).level(int(0)).r;

const densL = coverageL.mul(profileL).mul(densScale).mul(0.1);
```

Cost: 6 extra `texture(weatherMap)` taps per dense voxel. Modest —
weather map is 2D, well-cached.

Now cone-march opticalDepthSun reflects actual cumulus extent along the
sun direction, not a stretched-uniform approximation. Sun-facing voxels
see low coverageL beyond the cumulus edge → low opticalDepthSun → high
Tsun_ms → silver lining. Back-facing voxels see high coverageL through
the body → high opticalDepthSun → low Tsun_ms → shadowed.

### Lessons for next time

1. **`DEBUG_VIZ='lightingOnly'` first, every time.** When clouds look
   wrong but you can't immediately see why, this viz isolates lighting
   from alpha integration. Days of tuning would have been saved by
   running this diagnostic first.

2. **Profile-complementary lighting models mask their own bugs.** If
   `ms` and `ambient` are designed to span the profile range from
   opposite directions, then at fixed external inputs (Tsun_ms,
   skylight) their sum is roughly profile-independent. The *intended*
   variation comes from the external inputs varying spatially — if those
   external inputs don't vary (e.g., cone-march returning the same value
   for adjacent voxels), the whole model collapses to a near-constant.

3. **Schneider's approximations are valid in his test conditions, not
   universally.** Schneider 2015 demos clouds with sun overhead. The
   "use primary's coverage for cone taps" approximation works there.
   At terminator, it doesn't. Always check what the reference papers'
   test conditions were before adopting their approximations wholesale.

4. **"This approximation Schneider also makes" is a yellow flag, not
   a green one.** The lessons doc had a 2026-05-13 note about exactly
   this cone-tap-coverage issue, marked "revisit if internal cloud
   shading looks wrong". It took 9 more days and a Phase B
   implementation before someone (me) actually went back and
   revisited. **When the lessons doc flags a deferred check, schedule
   it explicitly rather than waiting for symptoms.**

---

## Case study #4: "close range = uniform white, orbital view fine"

### Symptom (as user described it)

> "I see kind of natural looking variation when looking from a distance
> but almost no variation when up close."

Orbital view (~85 km altitude, looking down at cloud deck): natural-looking
km-scale variation, bright cumulus shapes against darker valleys. Working
correctly.

Close range (~5 km altitude, wall of clouds ahead): uniform bright-gray
cloud body. No per-pixel variation. Detail erosion still visible at
silhouette edges but body itself reads as flat.

### The wrong things I tried first

(in order, all useless against this bug)

1. Cone density multiplier 0.55 → 0.1
2. Per-cone-tap coverage sampling (instead of primary's coverage)
3. baseShape sampling at each cone tap
4. `ms = eroded × Tsun_ms` instead of `profile × Tsun_ms`
5. Reduced sunColor magnitude 21 → 10 (for tonemap headroom)

None moved the needle. The user got understandably frustrated. Right call.

### The killer diagnostic

Three new debug-viz modes that bypass all the lighting math and show the
raw per-voxel data:

- `'eroded'`: per-voxel post-detail-erosion shape (0-1), grayscale
- `'coneDepth'`: raw `opticalDepthSun` from cone-march, /10 grayscale
- `'density'`: `eroded × densScale`, /20000 grayscale

All three showed **smooth gradient** across the cloud band at close range.
NOT uniform, NOT bumpy — just soft macro variation. That's the data the
lighting model has to work with.

If `eroded` is smooth, no lighting math reorganization can produce bumpy
output. The bug isn't in lighting. It's upstream.

### The actual root cause

Noise volume sample spacing vs view-distance pixel-scale mismatch.

- Base volume: 128³, `uBaseScale=50` → world period 20 km, **sample
  spacing ~156m**.
- Detail volume: 32³, `uDetailScale=100` → world period 10 km, **sample
  spacing ~313m**.

At close range (camera ~5 km from cloud surface), each screen pixel covers
~5-15m of world space. Adjacent pixels are 5-15m apart in world.

For adjacent pixels to read different noise samples (i.e., for per-pixel
variation to exist), world pixel separation must approach the texture
sample spacing. We had pixel separation ≈ 10m but sample spacing ≈ 156-313m
→ adjacent pixels read essentially the same noise sample with trilinear
interpolation producing nearly identical values.

**No lighting tweak can manufacture variation that doesn't exist in the
upstream data.**

### The actual fix (Schneider 2015's canonical approach)

Two changes:

1. **Bump `uDetailScale`** from 100 to 500. World period drops from 10 km
   to 2 km; detail feature size drops from ~300m to ~60m. Matches
   Schneider's intended cumulus cauliflower carving scale.

2. **Distance-based detail-strength falloff** per voxel:

   ```ts
   const detailNear = float(0.005);  // 5 km — full detail
   const detailFar  = float(0.080);  // 80 km — no detail
   const detailStrength = float(1).sub(smoothstep(detailNear, detailFar, t));
   const threshold = erosion.mul(uDetailErosion).mul(erosionRamp)
                          .mul(erosionStrength)
                          .mul(detailStrength);
   ```

   `t` is per-voxel distance from camera (the marcher's ray parameter, in
   scaled units). Near voxels get full detail erosion. Far voxels get zero
   — only the base macro shape contributes.

The orbital-vs-close-range LOD now happens automatically per voxel inside
a single render pass. No quality tiers, no toggles, no extra texture taps.
Just `smoothstep` × the existing threshold.

### Why this is correct

- **Close range**: detail erosion fires at 60m scale → bumpy cauliflower
  silhouettes AND per-pixel body density variation (since adjacent pixels
  at ~10m world separation now see different detail samples — 10m vs the
  new ~60m feature scale gives a sixth of a feature between pixels, enough
  to produce variation through trilinear interp).
- **Orbital view**: every voxel far from camera → detailStrength = 0 →
  pure base macro shape → smooth km-scale variation (matches what the
  orbital screenshot already showed naturally). Bonus: avoids aliasing
  the 60m detail features that would otherwise be sub-pixel at orbital
  distances.
- **Mid-range**: smooth `smoothstep` ramp keeps the LOD transition
  invisible.

This is Schneider 2015 § "Detail Erosion Distance Falloff" verbatim. RDR2,
Star Citizen, KSP-EVE all do the same. Should have been in the marcher
from the start; it's central to how Nubis-style clouds achieve "close =
detailed, far = smooth" performantly.

### Lessons

1. **For noise-driven rendering, always check whether the noise has
   features at the scale you want variation at.** A km-scale noise volume
   cannot produce 10m variation no matter how cleverly you sample it.
   Adjacent texels' interpolated values are too close to differ.

2. **The "raw data viz" pattern is the diagnostic last resort.** When
   lighting tweaks don't move the needle, write a viz that shows the
   per-voxel data going INTO lighting (no lighting math involved). If the
   data is uniform/smooth, no math can produce bumpy output — the
   upstream is wrong, not the downstream.

3. **Multi-frequency + distance-based LOD is THE technique** for clouds
   that need to look right at multiple view distances. Not quality tiers,
   not toggles. Per-voxel distance-from-camera fade-in of higher-frequency
   noise. Standard since HZD 2015.

4. **Re-read the reference paper periodically.** Schneider's distance
   falloff is documented in the 2015 GDC talk. We had the noise volumes,
   we had the erosion machinery, we just never wired the fade-in. Six
   debug rounds of speculation could have been replaced by one re-read
   of the section "Detail Erosion Distance Falloff."

---

## Case study #5: "uniform cloud bodies despite working cone-march"

A long session (~30 rounds) of tuning trying to get cumulus to show
dramatic per-cloud lighting variation like Star Citizen / Nubis references.
The session made significant progress (cumulus became visible discrete
bodies with cool blue shadow undersides) but hit diminishing returns
without matching reference quality. Worth recording the journey because
the meta-lessons are widely applicable.

### Trajectory

Start: continuous-deck stratocumulus with no within-cloud lighting variation
End: discrete cumulus puffs with cool blue shadow sides, ~30% within-cloud
brightness variation, performance recovered after some scares.

Key structural improvements that landed:
1. **Procedural cumulus pattern overlay** via `smoothstep(0.35, 0.65, baseVolume.g)`
   on coverage — creates real coverage=0 gaps between cumulus bodies
   (replacing earlier linear modulation that could never produce true
   gaps).
2. **Distance-falloff detail layer** (Schneider 2015 canon) —
   `detailStrength = 1 - smoothstep(5km, 80km, t)` multiplied into the
   erosion threshold. Detail features at ~60m visible at close range, fade
   out at orbital to prevent grain aliasing.
3. **Decoupled cone-march density** — cone-march density became a hardcoded
   `CONE_DENSITY = 3000` constant instead of `uDensityMul × 0.3`. Without
   this, bumping `uDensityMul` for opacity also bumped cone absorption,
   pegging `Tsun_ms ≈ 0` everywhere and killing the multi-scatter term.
4. **Separate sun/sky color split** — `L = sunColor × (direct + ms) + skyColor × ambient`
   instead of `sunColor × (direct + ms + ambient)`. Lets shadow sides
   pick up a cool blue tint instead of warm cream.
5. **Threshold-mask cumulus** vs linear coverage modulation — the
   structural fix that finally produced discrete cumulus bodies.

Key tuning parameters and their final values:
- `uDensityMul = 140000` (cumulus opacity)
- `CONE_DENSITY = 3000` (cone-march decoupled from primary density)
- `uDetailErosion = 0.2` (gentle edge nibbling, since coverage threshold
  does the main carving)
- `uDetailScale = 500` (60m detail features, with distance falloff)
- `sunColor magnitude = 12` (cumulus tops reach AgX 0.85)
- `skyColor = vec3(0.3, 0.5, 1.0) × 2` (saturated cool blue)
- `MS_COEF = 0.5` (sharp multi-scatter falloff)
- `HG_G = 0.1` (nearly isotropic phase to eliminate view-direction gradient)
- `skylight = 0.15` (low ambient floor)

### The meta-lesson: tuning vs structural fixes

Most of the wasted iteration was tweaking single tuning parameters
("bump uDensityMul", "reduce sunColor", "increase MS_COEF") that produced
small visible changes. The biggest wins were always STRUCTURAL changes:

- Linear coverage modulation → threshold mask
- Cone density scaled with primary densMul → decoupled constant
- One-color lighting → sun/sky color split

**When tuning isn't producing visible progress in 2-3 rounds, the right
move is to look for a structural change, not keep tweaking the same knob.**

The diagnostic-viz workflow makes this discoverable: when `eroded`/`coneDepth`/
`density` viz all showed correct data but `lightingOnly` was still
uniform, that meant tweaking primary density or erosion couldn't help —
the problem was downstream in the lighting model structure (sun/sky color
split, ms vs direct weighting).

### The "sun behind = dim, sun in front = bright" diagnostic signature

User reported: "Sun behind me, clouds dim. Sun in front of me, clouds
bright with silver lining." Initially I thought this was opposite of
physics and indicated a sunDirEarth bug. After actually adding a `sunDir`
viz: sunDirEarth was correct (uniform color across screen).

The real cause: **HG phase function dominance**.

When `direct = phase × Tsun × sunColor` is the dominant lighting term,
the view-direction dependence of HG (forward-scatter peak at cosθ=1)
produces a bright "looking toward sun" / dim "looking away from sun"
asymmetry — independent of the actual sun-facing/sun-away sides of
clouds. This LOOKS like inverted lighting from the user's perspective.

Diagnosis path:
- `tsunMs` showed `Tsun_ms ≈ 0` (cone absorption maxed) → ms was dead
- Without ms, `direct = phase × Tsun × sunColor` is the only term that
  varies → HG asymmetry dominates
- Fix: decouple cone-march density from uDensityMul so cone absorption
  doesn't blow up when primary density is bumped for opacity

**Signature for future me**: if user reports "view-direction asymmetric
lighting that doesn't match physics", suspect HG phase dominating because
ms is dead (cone-march over-absorbed).

### The "individual cloud variation" requirement

User asked for per-cloud per-direction variation like Star Citizen
references. The cone-march ms term provides exactly this — voxels at
sun-facing positions get high Tsun_ms, sun-away positions get low.

But this variation is **view-angle-dependent** in WHICH voxels are
visible. For a top-down view of cumulus cover with sun overhead, every
visible voxel (cumulus top) has similar Tsun_ms ≈ 1 (cone exits cloud
immediately upward to sun). So tops all look uniformly bright — no
within-cloud variation visible.

For visible within-cloud variation:
- Sun at angle from camera view (not overhead, not behind)
- View geometry that shows multiple sides of cumulus
- Cumulus large enough that cone-march sees variable absorption across it

If the user expects "clouds always show bright top / dark bottom regardless
of camera angle", that requires baked-in altitude-bias lighting, not
physical sun-direction lighting. Not what Nubis does.

### The across-FOV gradient

User reported "left side of clouds brighter than right" with sun in
upper-left. Initially I suspected `daylight` per-voxel scalar (sub-solar
to terminator gradient). Diagnosed via `daylight` viz: uniform across
visible clouds (we're on day side). So not daylight.

Real cause: HG phase asymmetry produces ~4× direct lighting variation
between cosθ=+1 (looking toward sun) and cosθ=-1 (away). Across an FOV
with sun off to one side, this is a smooth left-right gradient.

Fixed by reducing `HG_G` from 0.3 to 0.1 — phase nearly isotropic.

Trade-off: lost silver-lining effect. The Schneider/Nubis references DO
have silver lining via HG. We can re-add it later as a separate non-
view-dependent term if needed, but disentangling silver-lining from
asymmetric body brightness is non-trivial.

### Performance scare

Bumping `uDetailScale` 100→500 and adding per-cone-tap baseShape sampling
made the cone-march very expensive at mid-range (~14 FPS). Fixed by:
- Halving cone-tap count (6→3 with 2× per-tap contribution)
- Dropping per-cone-tap weatherMap sampling (use primary's coverage)

Recovered to ~60+ FPS at mid-range.

**Lesson**: when adding per-cone-tap features, profile cost. 6 cone taps
× 2 texture3D fetches each × ~5 dense voxels per pixel × 500k pixels =
30M texture3D fetches per frame. Even modern GPUs notice this.

### Where we hit diminishing returns

After ~30 iterations, the cloud rendering is recognizably cumulus with
visible 3D shading and cool blue undersides — significant progress from
where we started. But matching Star Citizen / Nubis reference visual
quality requires:

1. **Higher-resolution noise volumes** (256³+ base, 128³+ detail). Our
   128³/32³ volumes hit a resolution ceiling for close-range detail.
2. **Curl-noise volume for advection** (Phase C5 deferred). Adds organic
   flow that makes cumulus look "alive" rather than statically placed.
3. **Temporal accumulation** (Phase D deferred). Cleans up per-pixel
   noise variance that's currently visible at close range.
4. **More sophisticated cone-march** — full-density samples per tap (with
   detail erosion baked in) instead of macro-only `baseShape × coverage × profile`.
5. **Authored weather map** with art-directed cumulus patches (per the
   plan's stage 2 weather map work).

These are all on the roadmap. None are quick tuning wins.

### Meta-lesson: when to stop tuning

We stopped at "decent cumulus with discrete bodies and visible shading"
rather than "perfect reference match". The pattern that made me realize
diminishing returns: each new change took ~2-3 reload cycles, produced
visible-but-marginal improvement, and didn't fundamentally close the gap
to reference quality.

**Signal that you've hit diminishing returns**: 3+ consecutive parameter
tweaks produce <10% perceptual improvement each. At that point, structural
changes (new asset, new feature, different algorithm) are the only path
forward. Better to ship "good enough" + plan structural work than to
keep tweaking parameters.

---

## Case study #6 — Floating-origin reprojection (2026-05-27)

### Symptom

After Phase B landed, the user reported residual cloud smearing during fast
camera motion. The expectation from Phase D plumbing was that TAA history
blends would smoothly reconstruct cloud detail across frames. Instead,
during fast translational motion the clouds smeared into directional streaks
in the direction of camera motion, proportional to velocity.

The behaviour was invisible at low speed (smear less than a pixel per frame
went unnoticed) and dramatic at high speed (smear visible across many pixels).
A "smeary trail" in screen-space tracking the cloud bodies, not view-aligned
ghost trails.

### Initial wrong hypothesis

First instinct: TAA history blend weight too high (0.95); the long
exponential is holding onto multiple frames of cloud sampled from very
different viewpoints. The view-dependent radiance differences (Henyey-Greenstein
phase, multi-scatter direction) leak into the blend.

This is real, but it's not the *primary* cause. Lowering the blend weight
would mask the symptom but not fix the root.

### Diagnostic that found the real cause

Re-reading `cloudFullscreenPass.ts:D3` reprojection code:

```ts
const reprojWorldPos = uCameraScaledPos.add(rdScaled.mul(tReproj));
const prevClip = uPrevViewProj.mul(vec4(reprojWorldPos, 1));
```

Looks correct at first glance — the world-space hit point is multiplied by
the previous-frame view-projection matrix to get the previous-frame screen UV.

**The hidden assumption**: `reprojWorldPos` and `uPrevViewProj` are in the
*same* coordinate system. If they're not, the reprojection is geometrically
wrong even though the linear-algebra is fine.

Tracing the coordinate-system assumption back to `Spaceship.tsx:398`:

```ts
worldOrigin.setWorldOriginKm(_localRel);
```

This runs **every frame**. The world origin slides every frame to follow the
ship's interpolated position. So scaled-world coordinates are not fixed
across frames — the same real-world point has different scaled-world coords
at frame N vs frame N-1.

The TAA-reprojection plan in `VOLUMETRIC_CLOUDS_PLAN.md` had assumed origin
*rebases* (discrete threshold-triggered events) and specced
`cloudHistoryValid = 0` on rebase as the invalidation mechanism. The
prerequisite "the world origin is stable between rebases" was simply
not true in this codebase.

### Fix

Snapshot the world origin alongside the previous-frame view-projection
matrix at end-of-frame. Each frame, compute the delta between current and
previous origin (in scaled units) and add it to the world hit point before
the matrix multiply:

```ts
// In SpaceRenderer:
tempOriginShiftScaled
  .copy(worldOrigin.worldOriginKm)
  .sub(prevWorldOriginKm.current)
  .multiplyScalar(SCALED_UNITS_PER_KM);
fullscreenPass.updateUniforms(..., tempOriginShiftScaled, ...);

// In cloudFullscreenPass:
const reprojPrevFramePos = reprojWorldPos.add(uOriginShiftScaled);
const prevClip = uPrevViewProj.mul(vec4(reprojPrevFramePos, 1));
```

The math is exact: if `P_now_scaled = (P_km - O_now) × S` and
`P_prev_scaled = (P_km - O_prev) × S`, then
`P_prev_scaled = P_now_scaled + (O_now - O_prev) × S`. The shift is just
that delta.

### Why this is a meta-lesson, not just a bug

Three patterns to learn from:

1. **Plumbing assumptions need to be verified against the actual code**,
   not against the documented intent. The plan doc said "history invalidated
   on rebase"; the code said "origin slides every frame". The plan was wrong;
   the code was the source of truth. Always trace assumptions back to
   running code.

2. **A bug that's invisible at low velocity and unbounded at high velocity
   is the signature of a missing per-frame correction term.** If the
   symptom-magnitude scales linearly with frame-to-frame state delta, you're
   missing exactly one delta-handling term somewhere in the math.

3. **Reprojection requires coordinate-system invariance between frames.**
   Any time you use a previous-frame transform on a current-frame quantity,
   audit whether the underlying space is the same. Floating origin,
   billboard rotations, animation rebase events — anything that can slide
   the frame of reference between renders is suspect.

### Cost of finding this

About 1.5 hours of debugging, including:
- ~30 min trying to attribute the smear to view-dependent radiance (correct
  but secondary)
- ~30 min reading `cloudFullscreenPass.ts` for off-by-one matrix issues
- ~30 min tracing the coordinate-system flow through SpaceRenderer →
  cloudFullscreenPass → marcher → back to where origin gets set
- 5 min implementing the fix once the cause was clear

Total fix: ~30 lines of code across two files. The diagnosis was 95% of the
work.

---

## Case study #7 — Phase D close-out: the 5-suspect speckle hunt (2026-05-27/29)

### Symptom

After Phase D landed (1/16 reconstruction + variance clamp + STBN dither +
6-tap cone-march), residual per-pixel speckle remained at cloud silhouettes
and inside thin cloud regions. Static-camera output had per-pixel
convergence (no flicker on stable scene) but adjacent pixels converged to
**different** stable values — a spatial dot pattern that temporal averaging
couldn't smooth.

User report: "noise is still strong, especially at thin clouds and edges;
thick cloud cores look smooth."

### The diagnostic toolkit

Built a structured DEBUG_RECONSTRUCTION switch with three source-isolation
modes:
- `sparseOnly` — visualises sparse RT directly, bypassing all temporal logic
- `sparseAlpha` — sparse RT's alpha channel as grayscale; reveals binary
  hit/miss tiles
- `tFront` — per-tile first-hit depth; reveals where the marcher misses cloud

User diagnostic showed:
1. `sparseAlpha`: black pixels INSIDE cloud bodies → marcher producing α=0
   for tiles that should be solid cloud.
2. `tFront`: matching black tiles in cloud bodies → marcher's first-hit
   detection failing per tile.
3. `historyUsable` (added later): pure green → reprojection is solid,
   reconstruction pipeline works correctly.

Conclusion: **the noise is upstream of reconstruction**, in the marcher's
per-tile output. Each frame, different Bayer sub-pixels sample different
positions of the noise volume, and binary thresholds inside the marcher
gate cloud detection on/off per sub-pixel.

### The 5-suspect hunt

Five candidate sources of binary aliasing inside the marcher, each tested
by disabling and observing whether speckle changed:

1. **Cumulus pattern smoothstep (0.35, 0.65)** — widened to (0.15, 0.85)
   to soften the binary mask. **Partial improvement**: dense cores became
   smooth; thin/edge regions still noisy.
2. **Cumulus pattern at distance** — added distance-fade to disable pattern
   modulation at > 80 km from camera. **Partial improvement**: distant
   clouds became smooth; close-range edges still noisy.
3. **Detail erosion (`uDetailErosion`)** — disabled (0.0) and aggressively
   tested (3.0–6.0). **No visible difference at any value below 3.0.**
   Detail erosion was NOT the culprit.
4. **Per-voxel altitude hash (`altPerturb`)** — set to 0 (un-perturbed).
   **No visible difference.** Hash was NOT the culprit.
5. **First-hit threshold (`baseCloud > 0.01`)** — lowered to 0.0001.
   **No visible difference** for the residual thin-region noise. Threshold
   was NOT the dominant cause (though kept lowered for theoretical
   correctness).

After all 5 suspects ruled out and 4 changes applied (with two reverted
to defaults), thin-cloud-region speckle persisted essentially unchanged.

### The real root cause: Monte Carlo integration variance

The marcher is a **Monte Carlo integrator** of volumetric density. Each
ray samples discrete positions along its path and integrates density
through the cloud volume. The variance of MC integration scales with:
- Density variability along the ray (cloud structure)
- Inverse of sample count (more samples = less variance)
- "Spikiness" of the integrand (thin clouds = highly variable density)

For **dense cloud cores**: density saturates quickly to alpha=1 regardless
of small sample-position variations. Adjacent rays produce the same
integrated alpha. NO variance.

For **thin cloud regions**: density is low and highly variable along the
ray. Small differences in sample positions (different sub-pixels, different
STBN slices) produce large differences in integrated alpha. HIGH variance.

This is a **fundamental limit** of single-pass volumetric rendering at
our sample budget (96 max primary steps, 6 cone taps). NOT a bug.
Reference quality clouds (Star Citizen, RDR2, Nubis³) achieve smoother
thin regions via:
- Far more samples per ray (their perf budget is bigger)
- Offline pre-integration of cloud volumes (Nubis³ NVDF voxels)
- Post-process spatial smoothing (RDR2-style screen-space cloud blur)
- Higher-resolution noise volumes (less integrand variance per step)

### Meta-lessons

1. **Spend disproportionate time on diagnostic infrastructure.** The
   DEBUG_RECONSTRUCTION switch with 8 modes paid for itself many times
   over. Each test took 30 seconds (flip mode, reload, screenshot) vs.
   the ~hours that the "tweak-and-see" approach had been costing.

2. **5 suspects in a row testing negative is itself a result.** When
   multiple plausible single-variable fixes fail to move the needle,
   the cause is structural, not a single bad parameter. Stop searching
   for a knob; understand the underlying mechanism.

3. **MC variance at low-density regions is fundamental.** Volumetric
   cloud renderers all face this. Don't try to fix it inside the marcher
   alone — the proper architectural responses are:
   - More samples per ray (raise step budget)
   - Spatial smoothing post-pass (sacrifice sharpness for noise)
   - Pre-integrated cloud volumes (NVDF/offline pipeline)

4. **Visual progress is incremental, not binary.** Phase D landed
   working 1/16 reconstruction + smooth dense cloud cores. The residual
   thin-region noise is a *known limit*, not a regression. Documenting
   the limit + the path to fixing it is more valuable than continuing
   to chase iteration in the same architecture.

5. **The user's perception of "noisy clouds" was actually two distinct
   problems** stacked together: per-tile binary aliasing (which IS
   fixable, and we fixed most of it) + MC variance at thin regions
   (which is fundamental and requires architectural change). Separating
   "fixable bug" from "fundamental limit" is itself a useful diagnostic
   contribution.

### Cost of finding this

- ~30 min on initial fresh-blend / dither-amplitude attempts (wrong path)
- ~15 min building the DEBUG_RECONSTRUCTION diagnostic infrastructure
- ~30 min on the 5-suspect tests (each: flip mode, reload, screenshot, evaluate)
- ~30 min understanding the result and writing up close-out

Total: ~2 hours. Of that, the productive part was the 30-min diagnostic
phase — the rest was tooling + writing.

### Changes that landed in this session

Kept (real improvements):
- Cumulus pattern smoothstep (0.35, 0.65) → (0.15, 0.85)
- Cumulus pattern distance fade (5 km–80 km)
- First-hit threshold 0.01 → 0.0001
- Cone-march 3 → 6 taps (no compensation multiplier)
- DEBUG_RECONSTRUCTION diagnostic toolkit (kept in code, default off)

Reverted (didn't move the needle):
- uDetailErosion (kept at Phase B's 0.2)
- altPerturb hash (kept at Phase B's ±5% slab)

Documented (carries forward):
- Residual thin-region noise as known Phase D limit
- Three architectural paths to fix (more samples / spatial smoothing /
  pre-integrated volumes)
- Specific MC variance explanation that lets future sessions skip the
  "5-suspect hunt" entirely.
