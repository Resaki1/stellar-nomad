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

## What's still likely to bite us in this same area

Even after the two-tap fix, these are still slab-midpoint-based:

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
  own lat/lon. This is an approximation Schneider also makes; revisit if
  internal cloud shading looks wrong.

---

## How to use this file

- Open it whenever working on cloud rendering bugs.
- If a symptom matches the case study, the fix path is documented.
- If the symptom is new, the **Pattern recognition** + **Process lessons**
  sections are the general toolkit — apply them before theorising.
- If a new debugging journey teaches a similar lesson, add it here.

The user has explicitly asked me to maintain this. Treat updates as part
of the work, not extra effort.
