# Cloud System Review — 2026-09-05

Full review of the volumetric-cloud stack as it stands at `e125728`, against the
three complaints Christian raised: **clouds sometimes look weird**, **the far
cloud shell looks flat**, **performance is not ideal** — plus a research pass over
what shipped AAA systems do that we don't.

**No code changed.** Everything below is either read off the current tree
(line numbers = 2026-09-05, re-grep the symbol) or quoted from a measurement
already in the repo/memory. Where I could not verify something I say so.

Companion docs, in the order they matter now:
`CLOUD_VS_TAKRAM.md` (most current narrative) → `CLOUD_DEBUGGING_LESSONS.md`
cases #24/#25/#26 (most recent measurements) → `CLOUD_REVIEW_2026-07.md`
(architecture decisions) → `LIGHTING_PLAN.md` §5.7 (the open cloud-area deficit)
→ `PERF_MEASUREMENT.md` (how to get a number you can act on).

---

## 0. What the system actually is today (verified)

| Layer | Where | State |
|---|---|---|
| Near volumetric | `earthClouds.ts` `marchCloudVolume` (5,027-line file) | 256-step two-state march, ¼-res sparse MRT + full-res temporal reconstruction, capped at `SHELL_HANDOFF_FAR_KM` |
| Far field | `buildCloudShellMesh` (`earthClouds.ts:1704`) | analytic sphere at cloud-top, coverage from the shared macro model + a Monte-Carlo'd expected-opacity LUT, **zero 3D noise per frame** |
| Hand-off | `SHELL_HANDOFF_NEAR/FAR_KM = 250 / 700` km camera→fragment | volumetric owns ≤250 km, shell owns ≥700 km |
| Weather | `weatherMapV2.ts` + ERA5 bake `era5_2005082818.ktx2` | R coverage / G convectivity / B topHeight / **A cirrus (baked, never read)** |
| Sun transport | `cloudLightVolume.ts` 256×32×256 RGBA16F ×2 (A/B crossfade) | sun transmittance only |
| Shadows | `cloudShadowMap.ts` single 512² BSM over ±1500 km | **5.86 km/texel**, cached while inputs are static |
| Animation | — | **none. `uCloudUvOffset` is never written** |

Dead-but-present paths (all JS-side `if`, so no shader cost, but their comments
have already been caught lying about shipped values — `CLOUD_VS_TAKRAM.md` §5#1):
`TAKRAM_SHAPE=false`, `USE_DETILE=false`, `ANVIL=false`,
`TAKRAM_ENVELOPE_WARP=false`, `WARP_AMPLITUDE=0`, `MS_DENSITY_MIX=0`,
`TAKRAM_NOISE_WARP_FRAC=0`, `TAKRAM_TOP_PERTURB_AMP=0`.

---

## 1g. ❌ LEVER B (tap reuse) DROPPED — refuted by its own texel arithmetic

I pitched it on "the same two taps are re-fetched ~65× for essentially one texel". Checked
before building, and that is **only true for the exact centre pixel**. Both taps depend on
direction only, so radial motion is projected out and the sampled point moves along an arc
of `Rg × sweep`, with `sweep ≈ slabLen · b / r²` (b = impact parameter):

| pose | arc swept | **meso** texels (488 m) | **weather** texels (19.5 km @2k) |
|---|---|---|---|
| earth_8, centre px | 0 m | **0** | 0 |
| earth_8, frame edge | 4.5–5.4 km | **9–11** | 0.23 |
| earth_horizon_8 | 319 km | **654** | 16.3 |

🔑 **The expensive tap is the un-hoistable one.** `mesoTap` is a `texture3D` on 100% of
steps with **488 m** texels — it crosses 9–11 of them at the earth_8 frame edge and 654 at
the horizon. `wTap` *is* hoistable at earth_8 (≤1 texel across the whole frame, at 2k or
8k) but it is the cheap `texture2D`. ⇒ **B can only remove the cheap tap, on one pose
class.** Dropped.

⚠ Direction *quantisation* — my original phrasing — is worse than a hoist and buys nothing:
the fetch instruction still executes, and neighbouring texels are already cache-warm. The
only thing quantising changes is a hit that was already hitting.

🔑 **What the arithmetic DOES leave on the table:** at earth_8 the skip step is 113–151 m
against a 488 m meso texel, so **the field is oversampled 3–4× at nadir** (and undersampled
~8× at the horizon, where the step is 3.7 km). Reuse across ~3 steps, bounded by the texel
size, is the only "cheaper steps" variant the geometry supports — and it is pose-limited to
exactly the poses where the pyramid also wins, so it is a strictly smaller version of A.

### ⇒ DECISION: build A (the 2D min/max skip pyramid). It is the only lever with a MEASURED ceiling.

| lever | ceiling | basis |
|---|---|---|
| **A — skip pyramid** | **2.06–2.96 ms (11–16% of frame)** | steps_removed × **measured** 0.0605 ms/step |
| B — tap hoist/quantise | ~0 | ❌ refuted above |
| B′ — meso reuse across 3 steps | unmeasured, ⊂ A | strictly smaller than A, same poses |
| step count (`uLodMinSamples`) | **spent** | 60 → 40 landed, −0.675 ms; 40 is a quality floor |

**A also subsumes the only surviving B variant**, because every step it removes drops that
step's `mesoTap` too — the one thing no reuse scheme can hoist.

**What A needs, all of it already known rather than assumed:**
1. A conservative 2D pyramid of `(min base, max top, max coverage)` over the weather map.
   Inputs exist: coverage in R, topHeight in B, `columnBaseN` for the base.
2. An analytic skip distance from it — **zero 3D taps**, which is the point.
3. ⚠⚠ **It MUST bypass `min(1 + t·LOD_STEP_GROWTH, lodCap)`.** Otherwise the skip distance
   is clamped straight back to `slabLen/(dtSkip · uLodMinSamples)` and the feature measures
   as nothing. This is the single most likely way a correct implementation still fails.
4. Dilate the pyramid's bounds by anything that displaces the sample position, or the skip
   can jump over cloud. (`TAKRAM_ENVELOPE_WARP` is false today, so there is nothing to
   dilate by — but that is a build const, so the dilation has to be derived, not omitted.)
5. Gate: `__lum.cloudIters()` for the step count (pure-skip 54 → ?) and
   `__bench.run("earth_8"|"earth_horizon_8")` for the frame, thermometer both ends.

⚠ This is a multi-day feature, unlike everything else in §1b–§1g. It should be started
deliberately, not on the back of a measurement round.

---

## 1f. 🐛 CORRECTION — "only 8.1% of steps pay 3D taps" was WRONG. It is 100%.

I read `probeIters` as the 3D-tap rate. It is not. It counts steps passing the
`profile > 0.01` gate, i.e. steps paying the **cheap probe** — but two taps already happen
on **every** step, before that gate. Enumerated with each guard resolved against its live
build const:

| site | what | guard | emitted? |
|---|---|---|---|
| `earthClouds.ts:2977` | `convGate` texture2D | `TAKRAM_SHAPE && TAKRAM_ENVELOPE_WARP` | ❌ both false |
| `:2983` | `placeGate` texture3D | same | ❌ |
| `:2988` | `warpTap` texture3D | same | ❌ |
| **`:3032`** | **`wTap` weather texture2D** | **unconditional** | **✅ every step** |
| **`:3045`** | **`mesoTap` texture3D into `baseVolume`** | **`WEATHER_V2 \|\| MESOSCALE_TEST`, WEATHER_V2 = true** | **✅ every step** |
| `:3122` | `colTap` texture3D | `else` of `if (WEATHER_V2)` | ❌ |

⇒ **Every march step pays one `texture3D` + one `texture2D` + an equirect `atan/asin`
before the gate.** So `wasted / probed = 18.6%` bounds the **cheap probe** only; it does
**not** bound what a skip structure would remove, because a removed step also removes its
unconditional `mesoTap`, `wTap` and transcendentals. `cloudIters` now says so in its own
output, and the misleading `probed (paid 3D taps)` label is renamed
`cheap-probe steps`.

✅ **What this does NOT change: the pyramid's ceiling.** §1e derived 2.06–2.96 ms from the
MEASURED 0.0605 ms/step (3.925 ms / 64.9 steps), which already includes whatever each step
spends its time on. **The arithmetic is unaffected; only my explanation of it was wrong.**
And the case is if anything stronger — each skipped step avoids a 3D volume fetch, not just
2D work.

### ⇒ The per-step breakdown ablation is CANCELLED. It is confounded and not decision-relevant.

I proposed forcing `profile` (or the taps) to constants to price the per-step 2D work.
Dropping it, for two reasons:

1. **Not decision-relevant.** The pyramid's value is `steps_removed × 0.0605 ms/step`. What
   a step spends its time on does not enter that product.
2. **Every variant is confounded.** `coverage` drives the skip advance
   (`dtSkipInBand`, the detection cap), and `mesoTap` feeds coverage placement — so
   constant-ing either changes the **step count**, which changes the cost through the very
   proportionality being measured. The confound is the same size as the signal.

### 🔑 But it surfaced a genuinely new candidate lever: TAP REUSE on near-radial rays

`mesoTap` is sampled at `dirP · uInnerRadius · MESO_SCALE` — it depends on the **direction
only**, not on radius. Its own comment says so: *"World-anchored (projected to the inner
shell → a 2D pattern on the sphere, not volume noise)."* Same for `wTap`, whose UV comes
from `equirectDirToUv(dirP)`.

⇒ **On a near-radial ray the direction barely changes, so the same two taps are re-fetched
~65 times for essentially the same texel.** At `earth_8` (nadir, 7 km chord) the swept
direction is a small fraction of a weather texel. ⚠ At `earth_horizon_8` the direction
sweeps far more, so this cannot be hoisted unconditionally — it needs a "re-tap only when
the direction has moved more than one texel" test, which is itself a per-step branch.

**Two candidate levers now share the same measured ceiling** (both remove per-step work
priced at 0.0605 ms/step):
- **A: 2D min/max skip pyramid** — fewer steps. Ceiling 2.06–2.96 ms. ⚠ Must bypass the
  `min(1 + t·LOD_STEP_GROWTH, lodCap)` clamp or it is pinned.
- **B: direction-quantised tap reuse** — cheaper steps. Ceiling unmeasured, but bounded by
  the same 3.925 ms loop, and it is a much smaller change than a pyramid. ⚠ Its win is
  pose-dependent in the opposite direction to A's: best on nadir rays, worst at the horizon.

⚠ Neither is measured yet, and **B is the cheaper experiment** — quantise `dirP` to a
weather-texel grid for the tap only (not for the geometry) and see what the loop costs.
That is a contained change and a genuine A/B, unlike the cancelled one.

---

## 1e. ✅✅ CLOSED — the march loop is 3.93 ms (20.5% of frame) and is PURE STEP WORK

One session, all cold, thermometer **14.415 → 14.684 = +0.27 ms of drift** (against 0.76
last time — this is a tight measurement):

| | frame mean | GPU |
|---|---|---|
| `earth_8`, lod 60 | 19.103 | 55.53 |
| `__lum.cloudMarch(false)` | 15.178 | 38.85 |
| **⇒ march loop** | **3.925 ms = 20.5% of frame** | |

🔑🔑 **STEP WORK ACCOUNTS FOR THE ENTIRE LOOP.** The ladder's slope (0.051–0.071 ms/step)
× 64.9 steps = **3.3–4.6 ms** against a measured loop of **3.93 ms**. And a purely
proportional model reproduces the whole ladder:

| | steps | predicted | measured |
|---|---|---|---|
| lod 40 | 53.2 (−18.0%) | −0.708 ms | **−0.675 ms** |
| lod 24 | 48.8 (−24.8%) | −0.974 ms | **−0.818 ms** |

⇒ **The loop has no meaningful fixed cost. Cost ∝ step count.**

### ⚠⚠ TWO CORRECTIONS, BOTH MINE, BOTH ABOUT THERMAL RESCALING

**1. "Step count is not the march's cost" (§1d) was WRONG.** It compared the ladder slope
against a loop cost of 8.18 ms taken in the HOT 3-arm session and thermally rescaled by
1.286 to 6.36 ms. The direct cold measurement is **3.93 ms** — the scaled estimate was
**62% high**. ⇒ **Never thermally rescale an ablation delta. Re-measure cold.** A single
whole-frame factor does not transfer to a subsystem delta.

**2. "The shares are thermal-invariant" was also WRONG.** March share is **30.6% hot**
(8.18/26.70) and **20.5% cold** (3.93/19.10). Throttling clocks down the *latency-bound*
marcher — many dependent 3D fetches — harder than the bandwidth-bound fullscreen passes, so
it changes the **relative** cost of passes, not just the absolute. ⇒ The earlier
"33–38% of frame" headline for the whole pipeline is a HOT figure; the cold pipeline is
nearer **~24%**, and a cold `CLOUD_ABLATE_DIAGNOSTIC` run is still owed to pin it.

### ✅ LANDED: `LOD_MIN_SAMPLES_NEAR` 60 → 40

−0.675 ms (3.4% of frame) with the dense cloud sample count **unchanged at 6.8/ray**. 24
measured better (−0.818) but the author saw quality degradation at some distances below 40,
so **40 is a quality floor, not a perf one** — the remaining headroom in this constant is
~0.14 ms and it is spent.

### 🔑🔑 AND EMPTY-SPACE SKIPPING IS BACK — RE-AIMED, with a quantified ceiling

§1b demoted it because its *stated* mechanism (skip steps paying 4–6 `texture3D` taps to
find nothing) is 1.5% of steps. That refutation stands. But the decomposition now shows the
right target, and it is large:

| steps at earth_8, lod 60 | |
|---|---|
| total | 64.9 |
| dense (full cloud sample) | 6.8 |
| any 3D tap ("probed") | 10.9 |
| **pure-skip, NO 3D tap at all** | **54.0 = 83% of steps** |

Those 54 steps each still pay position maths, an equirect `atan/asin`, and the
weather-map / coverage / heightProfile evaluation. **The cost is the 2D per-step work, not
the 3D probes** — and since the loop is pure step work, removing steps converts 1:1:

| pure-skip 54 → | steps | loop | saving |
|---|---|---|---|
| 20 | 30.9 (−52%) | 1.87 ms | **2.06 ms = 10.8% of frame** |
| 10 | 20.9 (−68%) | 1.26 ms | **2.66 ms = 13.9%** |
| 5 | 15.9 (−76%) | 0.96 ms | **2.96 ms = 15.5%** |

So a conservative 2D min/max pyramid over the weather map — one coarse tap answering "no
cloud between t₀ and t₁" instead of N fine evaluations — is worth **~2–3 ms, 11–16% of
frame**. That is the Nubis³-shaped win, reached through the correct mechanism.

⚠⚠ **Two hard design constraints, both discovered rather than assumed:**
1. **It must BYPASS the `min(1 + t·LOD_STEP_GROWTH, lodCap)` clamp.** Otherwise the skip
   distance is pinned straight back to `slabLen/(dtSkip · uLodMinSamples)` and the feature
   does nothing. This is why the naive version would have underperformed.
2. **The ceiling above assumes the structure reduces pure-skip steps to 5–20.** That is an
   assumption, not a measurement. ⚠ Before building the pyramid, price the per-step 2D work
   directly: ablate the weather/profile evaluation (force `profile` constant) and see how
   much of the 3.93 ms it is. If it is a small share, the cost is loop overhead and
   position maths instead, and a skip structure still helps — but the ceiling moves.

---

## 1d. ✅ TIMED — the step-count lever is worth 4–6% of frame, and it SATURATES at lod 24

`earth_8`, frame **mean**, all settled, `bi` ≤ 1.012, thermometer at both ends:

| | frame | vs lod 60 | GPU | steps/ray |
|---|---|---|---|---|
| `earth_750` thermometer | **14.69** | — | 24.96 | — (cold ✅) |
| lod 60 (authored) | 19.751 | — | 57.12 | 64.9 |
| lod 40 | 19.076 | −0.675 | 55.48 | 53.2 |
| lod 24 | 18.933 | **−0.818** | 54.48 | 48.8 |
| lod 8 | 18.928 | **−0.823** | 54.80 | 48.8 |
| `earth_750` thermometer | **15.45** | — | 25.71 | — (+0.76 drift) |

⚠⚠ **THE THERMAL DRIFT (+0.76 ms) IS THE SAME SIZE AS THE WHOLE EFFECT (0.82 ms).** The
thermometer earned its place on its first real use — without it this would have been
written up as a solid −0.82 ms. And the drift *opposes* the ladder (later runs are hotter
and lower-lod), so the true effect is **larger**: interpolating the two reads gives
**−1.14 ms at lod 24**. ⚠ That is a 2-point drift model whose correction is the size of the
signal, so the honest statement is **the saving is 0.8–1.3 ms, i.e. 4–6% of frame**
(50.6 → 52.8 fps).

✅🔑 **THE SATURATION MECHANISM IS CONFIRMED WITH A SHARP THRESHOLD.** lod 24 → 8 moves the
frame by **−0.005 ms** — nothing. Predicted and verified: the cap only binds while
`1 + t·LOD_STEP_GROWTH` is below it, and over earth_8's 7 km chord

| lod | `lodCap` | growth reaches the cap at |
|---|---|---|
| 60 | 1.17 | 0.42 km |
| 40 | 1.75 | 1.89 km |
| 24 | 2.92 | 4.81 km |
| 8 | 8.77 | **19.44 km — beyond the chord, so the cap NEVER binds** |

⇒ **Below lod ≈ 24 the dial is inert by construction.** `lod 24` is the whole available
win, and the 0.005 ms repeat between two runs at identical step counts also tells us the
harness resolves to ~0.005 ms on a repeat.

🔑🔑 **AND STEP COUNT IS NOT THE MARCH'S COST HERE EITHER: −24.8% steps buys 4–6% of frame.**
On a steps x-axis the slope is **0.051 ms/step raw / 0.071 corrected** (64.9 → 48.8 steps
for 0.818 → 1.138 ms; the middle point predicts within 14%). ⚠ Three distinct points, and
the atmosphere's *analogous* slope was falsified by a five-point ladder — treat it as a
bound, not a model. But the bound is decisive on its own: extrapolating to zero steps gives
**3.3–4.6 ms**, while `cloudMarch(false)` measured the whole loop at **8.18 ms**. ⇒ **Roughly
half the march loop's cost does not scale with step count at all.**

**That is the second step-count lever in a week to come back small** (the atmosphere's
`atmoSteps` was flat outright), and it redirects the search: the remaining cost is per-ray
setup or per-step FIXED work — the position maths, the equirect `atan/asin` conversion and
the weather-map/coverage/heightProfile evaluation that **all** ~65 steps pay, versus the 3D
taps that only 8.1% of them reach.

**⇒ Two recommendations.**
1. **`LOD_MIN_SAMPLES_NEAR` 60 → 24 is worth taking if the image holds.** 4–6% of frame for
   one constant, with the dense (cloud) sample count **invariant** at 6.8/ray. ⚠ The one
   thing to check is cloud-FRONT localisation, not interiors: `probed` falls 10.9 → 10.1
   and the skip→dense rewind is `dtSkipInBand × 0.5`, so edges can shift by up to half a
   skip step. Look at cloud silhouettes against the sky.
2. **The next measurement is a same-session `cloudMarch(false)`** to close the
   decomposition. If the loop really is ~8 ms while its step work is ~4 ms, the other ~4 ms
   is fixed per-ray/per-step work and that is where the remaining 30%+ of the frame lives.
   ⚠ Take the thermometer before AND after — this session showed 0.76 ms of drift in under
   three minutes, which is larger than most of what we are now chasing.

---

## 1c. The `uLodMinSamples` ladder — MEASURED at both poses, 2026-09-08

`__lum.cloudLod(n)` at `earth_8` and `earth_horizon_8`:

| pose | lod | primary | vs 60 | **dense** | skip | probed | wasted |
|---|---|---|---|---|---|---|---|
| earth_horizon_8 | 60 | 86.4 | — | **4.2** | 82.2 | 7.0 | 1.3 |
| | 40 | 78.4 | −9.3% | **4.1** | 74.3 | 6.7 | 1.0 |
| | 24 | 75.2 | **−13.0%** | **4.0** | 71.1 | 6.6 | 0.9 |
| earth_8 | 60 | 64.9 | — | **6.8** | 58.1 | 10.9 | 2.3 |
| | 40 | 53.2 | −18.0% | **6.8** | 46.3 | 10.3 | 1.5 |
| | 24 | 48.8 | **−24.8%** | **6.8** | 42.0 | 10.1 | 1.0 |

✅🔑 **THE QUALITY WORRY IS MEASURED AWAY: the DENSE (actual cloud) sample count is
INVARIANT.** 6.8 / 6.8 / 6.8 at earth_8, 4.2 / 4.1 / 4.0 at the horizon. Every step saved
comes out of EMPTY skip traversal (58.1 → 42.0). ⇒ **This is not the sample-count trade it
looked like**, and the earlier blanket warning that it "WILL change the image" was too
pessimistic. ⚠ What can still move is cloud-FRONT localisation — a coarser skip step
detects the front later and the rewind is `dtSkipInBand × 0.5`, so edges may shift by up to
half a skip step, and `probed` falls slightly (10.9 → 10.1). **Check edges, not interiors.**

⚠⚠ **BUT THE DIAL IS FAR WEAKER THAN ITS RATIO: 2.5× fewer requested samples buys only
1.33× fewer steps at earth_8 and 1.15× at the horizon.** Because the other arm of
`min(1 + t·LOD_STEP_GROWTH, lodCap)` takes over the moment the cap lifts.

🔑🔑 **SO `uLodMinSamples` IS NOT "THE STEP COUNT" — `dtSkip · lodScale` IS, AND IT HAS A
FLOOR OF `dtSkip` = `SKIP_STEP_SCALED` = 100 m.** The arithmetic closes exactly:

- earth_8, lod 60: `lodCap` = 1.17 ⇒ step ≈ 117 m ⇒ 7.35 km / 0.117 = **63 steps**,
  measured **64.9**. ✓
- earth_8, lod 24: mean step 151 m ⇒ mean `lodScale` **1.51**, i.e. still near the floor —
  over a 7 km chord `LOD_STEP_GROWTH = 400` reaches only 1 + 0.007·400 = 3.8 at the far
  end and averages far less.
- earth_horizon_8: mean step **3.70 km** ⇒ mean `lodScale` **37**, so the horizon is
  already deep in the growth-limited regime and the cap barely bites — which is exactly
  why the same dial moves it only 13%.

⇒ **The two controlling constants are `SKIP_STEP_SCALED` (100 m) and `LOD_STEP_GROWTH`
(400).** `uLodMinSamples` only lifts the cap off them. Any future step-count work targets
that product, not the sample floor.

⚠⚠ **NO TIMING WAS TAKEN, so the ms value of this is still UNKNOWN — and step count does
not imply frame time here.** The precedent is one week old and unambiguous: the
atmosphere's five-point `atmoSteps` ladder moved the *pass* span 6.99 → 5.97 ms while the
FRAME stayed flat within 0.98 ms of noise, falsifying a 0.247 ms/step model by 6.7×. **Do
not assume −25% steps is −25% of the march.**

**Next, and it is three commands per pose:**
```bash
# DEBUG_VIZ back to "off" and reload FIRST — in "stats" mode the marcher skips its whole
# colour assembly, so the frame cost is not the shipping cost.
await __bench.run("earth_750")                       # thermometer: under ~15 ms = cold
__lum.cloudLod(0);  await __bench.run("earth_8")
__lum.cloudLod(40); await __bench.run("earth_8")
__lum.cloudLod(24); await __bench.run("earth_8")
```
then the same at `earth_horizon_8`. Read frame **mean**, check `bi` ≤ 1.1. If the frame is
flat across the ladder — as the atmosphere's was — then step count is not the cloud
march's cost either, and the next thing to price is the per-step work rather than the
number of steps.

---

## 1b. ❌ EMPTY-SPACE SKIPPING IS DEMOTED — MEASURED 2026-09-08

X4 calls it "the highest-confidence structural item". **Measured, it is worth ~0.1 ms.**
`await __lum.cloudIters()` at the cloud deck, over 262,144 marching pixels:

| | per ray |
|---|---|
| primary steps | **86.4** (p50 81, p95 128, max 231) |
| dense steps (real cloud samples) | **4.2** |
| skip steps | 82.2 |
| steps paying any 3D tap | **7.0 — i.e. 8.1% of steps** |
| **wasted probes** | **1.3 → 18.6% of probes, 1.5% of ALL steps** |
| rays at the 256-step budget | **0.0%** |
| exit reason | budget 0.0% · **slab 93.0%** · opaque 7.0% |

🔑🔑 **THE REVIEW'S STATED MECHANISM IS REFUTED.** §1 says *"every skip step whose column
has `profile > 0.01` still pays the probe: ~4–6 `texture3D` taps just to discover there is
nothing there."* Only **8.1% of steps** pass that gate at all — the existing
`profile > 0.01` test already eliminates **91.9%** of the 3D work — and only **1.5% of all
steps** are wasted probes. A distance field removes that 1.5%. On a ~7.3 ms march that is
**~0.11 ms**, not the 3.2× Nubis³ reports.

🔑🔑 **AND THE REAL FINDING IS BIGGER THAN THE ONE WE WERE LOOKING FOR: 86.4 STEPS TO
PRODUCE 4.2 CLOUD SAMPLES — 95% TRAVERSAL OVERHEAD.** The march is not slow because it
struggles to find cloud. It is slow because it takes ~86 steps per ray by construction:
`lodCap = slabLen/(dtSkip · uLodMinSamples)` **binds** (1.17 at the nadir), so the step
count is pinned to roughly `LOD_MIN_SAMPLES_NEAR = 60`. **Those 86 steps are a sample-count
floor we asked for, not a search cost.**

⚠⚠ **This also explains why a distance field would have underperformed even if built well.**
`lodScale = min(1 + t·LOD_STEP_GROWTH, lodCap)`. A perfect analytic skip distance still
gets clamped straight back down to `slabLen/(dtSkip · 60)` unless the floor moves with it.
**Empty-space skipping cannot beat a cap it does not bypass** — the nested-knob problem
with a concrete mechanism.

⚠ `93% of rays exit at the slab boundary` — they traverse the entire chord (up to 736 km at
the horizon) and only 7% terminate on opacity. Nothing is cap-bound, so there is no hidden
budget starvation; the rays are simply walking a long way to gather very little.

**⇒ Revised order.** `__lum.cloudLod(n)` now overrides `uLodMinSamples` at runtime (applied
after the per-frame altitude lerp, which would otherwise overwrite it). That dial *is* the
step count, so it is the first thing to A/B: 60 → 40 → 24 at both `earth_horizon_8` and
`earth_8`, with `cloudIters` confirming the step count actually moved. ⚠ It trades samples
for speed and **will** change the image — thin cloud and cloud edges first, where 4.2
samples are already marginal — so it needs the quality gate that does not exist yet. Do not
spend it blind; that is how four degenerate `limbScan` versions happened.

⚠ Not yet run at the second pose. `lodCap` is 1.17 at the nadir and **53.3** at the
horizon, so this dial binds hard at one and weakly at the other, and a single-pose reading
cannot generalise. Also unrecorded: which pose the numbers above came from.

---

## 1a. ⚠⚠ §1 IS SUPERSEDED (2026-09-08) — read this before acting on anything below it

§1's whole decision tree rests on two numbers that **cannot be reconciled** with the
current baseline, and on one that was produced by a statistic since found to be wrong.
Nothing below it should be actioned as written.

**Do not quote "+2.35 ms whole cloud pipeline", "12.80 ms deck" or "78 fps" again.**

🔑🔑 **"+2.35 ms" is a floor of a floor, not a cost.** It came from a 750→650 gate
straddle, and at 650 km the pipeline runs in its **cheapest** configuration, every term
verified in code: `uVolumetricBlend` = 0.111; `uLodMinSamples` = 16 against **60** at
earth_8 (3.75× fewer samples); `uVolumeWeight` = 0, so the light-volume bake is skipped
at *both* ends and contributes nothing to the delta; `uShipOccluderOn` = 0. All four are
at maximum inside the band. And it was measured at 91° phase / on the night side, where
the marcher's entire lighting block — sun march, light-volume tap, dual-lobe phase,
powder, multi-scatter — sits inside `If(daylightS > 0.001)`. The v2 straddle gives
**+1.60 ms** by the same method; both are floors.

⚠ **The 12.80 ms deck frame cannot be reconciled with today's 18.6 ms.** Accounting:
pose epoch v1→v2 is at most **+1.20 ms** (the measured day−night delta), the canvas got
**12.4% smaller** (5.05 → 4.43 Mpx, which *widens* the gap), and only `5a glare PSF`
≈ 1.0 ms of new work is itemised. ~1.2 ms of a ~5.7 ms move is explained; the rest sits
partly in **build state that was recorded on neither side**. Both baselines were taken
on dirty trees. `BenchReport.env` now carries `gitState` (`sha-dirty`) and `simEpochMs`
for exactly this reason.

⚠ **X4's "highest-confidence structural item" rests on a null that was guaranteed.** Case
#22 raised `LOD_STEP_GROWTH` 400→4000, saw "FPS moved by zero", and concluded the rays
are `lodCap`-bound. But at earth_8 `lodCap` = **1.17**, so `lodScale` saturates 0.42 km
into the ray and `LOD_STEP_GROWTH` **cannot bind** — 4000 only moves the crossover to
0.042 km. The experiment could not have produced anything else at that pose. It also
used `fps` from `frameMs.p50`, the statistic that reported 138 fps on a 120 Hz display.
Empty-space skipping may well still be right; **its evidence has to be rebuilt.**

⚠ **§1's `DETAIL_FADE_NEAR/FAR` row is not a perf knob**, and the A/B order it
recommends produces nulls: the four knobs are **nested**, not independent. At earth_120
the r=2 composite has already attenuated the finest octave (356 m) by **−4.78 stops**
before the distance fade reaches it, and past 160 km that octave is above the cloud RT's
Nyquist and structurally absent. So `DETAIL_FADE_FAR` 100→250 km there is a predicted
null — the opposite of §1 calling it "the risky one".

🔑 **`earth_8` is not the cloud worst case; it ranks third.** `earth_horizon_8` 19.40 ms,
`earth_30` 18.90, `earth_8` 18.50. Looking down from 8 km is the **shortest** chord
through the 1–16 km band (7.0–7.7 km) while a level ray spans 319.6 km centrally and up
to 736.3 km — a **42–96× longer in-slab path** at identical gates. `earth_horizon_25` was
added for the above-deck grazing regime nothing covered.

**What landed instead of a measurement (2026-09-08):** the ablation surface this needed
and did not have.
- `__lum.cloudMarch(false)` — prices the **march loop**, clean by construction (only the
  loop's exit test sees the modified `tExit`, so `lodCap`, `dtSkip`, all three
  weather-map taps and the STBN dither are bit-identical across arms).
- `CLOUD_ABLATE_DIAGNOSTIC` (SpaceRenderer) — prices the **whole pipeline**. ⚠⚠ Two
  ablations, not one, because the reconstruction and composite passes have **zero
  data-dependent control flow** and run at full cost in a march-only bypass:
  composite 25 taps × 4.43 Mpx = **110.7 M**, reconstruction 12 × 1.97 Mpx = **23.6 M**,
  i.e. **~134 M taps survive** against the loop's 88–199 M. A march-only delta read as
  "the clouds are cheap" is the error §1 already made once.
- `CLOUD_TEMPORAL_CYCLE` is now **derived** from `SPARSE_DIVISOR` and
  `STBN_FRAME_MODULUS` rather than a hard-coded 252 with a comment asking to keep it in
  sync. Raising `SPARSE_DIVISOR` to 4 makes the true cycle **1008**, and the runner would
  have kept measuring 252 — the two arms then sampling different jitter subsets.
- ⚠ **Still missing, and it blocks pricing any step-budget knob:** a numeric readback of
  `primaryIters`/`whyStop`. `DEBUG_VIZ` has `'iters'`, `'lod'` and `'whyStop'` but they
  emit **colour, not numbers**, which is why case #22's null had no diagnosis.
- ⚠ **Also unresolved:** exposure adaptation is the one accumulator the settle window does
  not wait out (τ_darken 2.0 s cone / 6.0 s rod against a 5.58 s settle ⇒ 6.1% of the
  step remaining by day, **39.5% on the night rows**). Frame-time A/Bs are safe — nothing
  gates GPU work on exposure — but absolute-level quality metrics are not.

---

## 1. Performance — the premise needs re-testing before anything is spent on it

**The last ground-truth measurement says the clouds are not the problem.**
2026-08-13, gate-straddle ablation on frame time (not reported per-pass numbers,
which for the cloud passes are known **3.6× phantoms**):

- whole cloud pipeline on/off: **+2.35 ms**
- BSM: +5.60 ms → root-caused to the *bake*, then cached → deck 15.30 → **12.80 ms (78 fps)**
- final ladder: **deck 75–78 fps, everything ≥750 km altitude on the 120 fps cap**

Since then eight commits landed (lighting phases 6/7/8, eclipses, ephemerides,
star catalogue/parallax) and **nothing re-measured the clouds**. So:

> **Action 0 (30 min, do first): reload from `deep_space`, then `await __bench.sweep()`.**
> Read the `gpu/frame` ratio column first; where it exceeds 1.15 use gate-straddle
> ablation, never arithmetic on per-pass numbers. Compare against
> `PERF_MEASUREMENT.md` § "THE BASELINE".

Two outcomes, both actionable:

**If the ladder still holds** — the clouds have ~2.4 ms of a 12.8 ms frame and we
are *over*-optimised on knobs that cost visible quality. Four of them compound
into exactly the "mushy at medium distance" complaint from the July review:

| Knob | Value | What it costs the image |
|---|---|---|
| `CLOUD_MAX_DPR` (SpaceRenderer:168) | 1.0 | on a 1.5-DPR canvas the cloud RTs carry **0.44× the fragments** of the scene |
| `SPARSE_DIVISOR` (cloudReconstructionPass:85) | 2 | ¼-res march, 4-frame Bayer |
| `CLOUD_DENOISE_RADIUS` (SpaceRenderer:269) | 2 | **25-tap Gaussian at full res**, on top of the above |
| `DETAIL_FADE_NEAR/FAR` | 20 / 100 km | *all* fine octaves → 0 beyond 100 km |

Effective near-cloud sharpness is ≈⅔ linear resolution through a 5×5 blur. The
cheapest quality win available is to hand some of the recovered perf back:
A/B `CLOUD_MAX_DPR` 1.0→1.5 and `CLOUD_DENOISE_RADIUS` 2→1, measure both.
(`DETAIL_FADE_FAR` is the risky one — it exists to fix case-#22 distant flicker;
fade to a mid-frequency *floor* rather than to zero, and re-check flicker.)

**If the ladder has regressed** — the regression is almost certainly not in the
cloud passes; check the atmosphere march and the new star/glare work first, using
the same ablation method.

### The one structural perf lever still missing: empty-space skipping

This is real and it is the *only* item where our architecture differs from every
shipped reference. Measured (case #22): raising `LOD_STEP_GROWTH` 400→4000 moved
FPS by **zero** while `uLodMinSamples` moved it → the cost rays are `lodCap`-bound,
`DEBUG_VIZ='iters'` stays mostly RED (skip, not dense). Every skip step whose
column has `profile > 0.01` still pays the probe: ~4–6 `texture3D` taps
(`earthClouds.ts:3174–3244`) just to discover there is nothing there.

Three shipped systems solved precisely this, and all three used a *distance field*:

- **Nubis³** (repo PDF pp. 44–48): cone step mapping + distance step mapping over
  **height data only** → **4.2 ms → 1.3 ms**. p.171 ships the step rule:
  `step = max(sdf_cloud_distance, adaptive_step) + jitter`.
- **Star Citizen** (Jun 2021 monthly report): "narrow-band SDF computed over cloud
  coverage with signed-format mips for empty-space skipping".
- **KSP-EVE Release 4**: signed distance fields, per the EVE wiki feature list.

We have the inputs already: coverage (R) and topHeight (B) in the weather map,
and `columnBaseN` for the base. A conservative 2D pyramid of
`(min base, max top, max coverage)` gives an analytic skip distance with **zero**
3D taps; a coarse 3D distance field is the fuller version — and it has a free
home (§3).

---

## 2. The far shell looks flat — four causes, all inside one 40-line fragment

The shell fragment (`earthClouds.ts:1770–1900`) computes coverage correctly and
then lights it with almost no spatial information:

1. **`const selfShadow = float(1).sub(coverage.mul(0.5))` (`:1883`).** That is the
   entire shadow model. It has no sun direction in it at all. The only directional
   term in the whole shell is `sunCos = dot(normalWorld, sunDir)` — a *planet*-scale
   gradient, not a cloud-scale one. Nothing in the shell can produce relief.
2. **`FAR_SHADOW_FLOOR = 0.45` (`cloudCommon.ts:145`)** clamps the darkest a far
   cloud can get to 45% of full sun. Even a correct shadow term would only span
   2.2:1 — real cloud-deck shadow contrast near the terminator is far larger.
3. **No phase function.** `farCloudLit` is Lambert + ambient. No forward lobe →
   no silver lining, no brightening toward the sun, none of the anisotropy the
   near marcher has (dual-lobe HG, measured effective g = 0.250).
4. **The topHeight channel is thrown away for appearance.** The shell already
   samples it (through `columnMacroCoverage`) to *place* cloud, then renders a
   geometrically flat sphere. No thickness, no limb, no inter-cloud shadow.

### The fix is cheap and 2D

All of this is fixable in the shell fragment with 2–3 extra **2D** taps
(the shell currently does one):

- **Height-field relief.** `h(uv) = topHeight × coverage` is already in hand.
  Two offset taps (or `dFdx/dFdy` — the shell is a rasterised mesh with correct
  derivatives, which is exactly why `makeEquirectTextureField` uses auto-mip)
  give a gradient → perturb the sphere normal → `N·L`. Relief for ~free.
- **Sun-offset shadow tap** — this is *the* cue. Offset the uv along the sun
  direction projected into the local tangent plane by `h / tan(elevation)` and
  sample coverage there. That is long inter-cloud shadowing: it is what makes
  Apollo/ISS photographs of a cloud deck read as three-dimensional, and it grows
  automatically toward the terminator where the deck currently looks flattest.
  It is also `CLOUD_SHADOWS_GODRAYS_PLAN.md` L5's "shell far-field shadows" item,
  which was scoped and never built.
- Add a forward HG lobe, then let `FAR_SHADOW_FLOOR` drop well below 0.45.

Risk to watch: the shell's whole reason for being noise-free is that per-pixel
mip-0 3D taps aliased (measured 2026-07-06 — frizz + moiré rings, `carve` worst).
These new taps are **2D on an auto-mipped texture**, i.e. the one sampling path
that was measured *clean* (`rawCoverage`: "smooth + stable"). Keep it that way —
do not reintroduce a 3D tap into the shell.

### …but the bigger half of "flat" is that there is not enough cloud

`LIGHTING_PLAN.md` §5.7, measured 2026-08-17 with `__lum.disc()`:

> effective cloud cover **25.6%** (Earth ≈ 65%), disc albedo **0.163** against a
> cloud-finish-line of ~0.29. **Still open: ~2.5× of cloud area.**

A deck that is three-quarters clear sky with smooth patches in it will read flat
however it is lit. This is the single largest "Earth doesn't look like Earth"
item, and §5.7 already names the next step and rules out the shortcuts:

- The weather map is **not** short of cloud (73% of the globe above 0.05).
- `maxProfile ≈ 1`, so the profile is not attenuating anything.
- Four successive analytic models of the opacity LUT's internals were each wrong
  in a new way. **The residual needs the LUT's internals instrumented
  (`dilated` / `carved` / `eroded` distributions), not more knob sweeps.**
- Two knobs that compound must be swept **jointly** (`SHELL_OPTICAL_PATH` × erosion
  K measured 1.75× jointly vs 1.39× predicted from the singles) — the same
  structure as case #25's `profile × inScatter`.

Note the trap already recorded at `earthClouds.ts:222–237`: the shell is faithfully
reproducing a marcher that is *itself* too thin, so raising only the shell fixes
orbit and tears the 250–700 km seam. Move both in one commit.

---

## 3. The highest value-per-line item in the review: the light volume has three free channels

`cloudLightVolume.ts:499`:

```ts
textureStore(tex, coord, vec4(T, T, T, float(1))).toWriteOnly();
```

256×32×256 RGBA16F, **twice** (A/B crossfade) = 33.6 MB of VRAM carrying one
scalar in `.r`. The bake is already amortised (re-bakes only on box snap or
>0.25° of sun movement). Three channels are sitting there, and each one maps
onto a currently-open problem:

**G — sky/zenith occlusion.** Nubis³ p.149 ships exactly this:

```
ambient_scattering = pow(1.0 - dimensional_profile, 0.5) * exp(-summed_ambient_density)
```

…where the second factor is summed density *toward the sky*, precomputed in the
same grid. We have only the first factor. This is the direct, physically-grounded
fix for the open **"flat over-bright cotton wool, no dark undersides"** complaint
(`CLOUD_VS_TAKRAM.md` §5 #2c, still open) — a cloud base is dark because the sky
above it is occluded by the cloud's own body, and we currently model none of that.
UE ships the same idea as the Sky Light's "Cloud Ambient Occlusion".

**B — distance to cloud (a coarse SDF).** Two payoffs from one channel:
- the empty-space skipping of §1 (`step = max(sdf, adaptive)`, Nubis³ p.171);
- Nubis³'s **inner glow** (p.141), which relaxes the multi-scatter Beer curve
  using the distance field:
  `ms *= exp(-sunOD * remap(sun_dot, 0, 0.9, 0.25, remap(cloud_distance, -128, 0, 0.05, 0.25)))`.
  That is a principled replacement for the `MS_PROFILE_W` / `MS_INSCATTER_V`
  softening from case #25 — same intent (stop the gates compounding), but keyed
  on depth-into-the-cloud rather than on a global fudge factor.

The volume is only valid inside its ±600 km box and fades out above ~400 km
altitude, so both terms need the existing box-weight fallback. That's fine —
they are near-field quality terms.

---

## 4. The clouds are completely static

`uCloudUvOffset` exists in three places and is written in none. No wind offset on
the noise sample position, no curl advection, no upward cumulus motion, no flow
map. Every reference animates:

- **Nubis³** p.26 / p.99: `noise_sample_pos -= wind_direction * scroll_speed`,
  applied to the sample position, plus a separate voxel-cloud animation speed.
- **KSP-EVE** (`clouds.cfg` in the repo): per-layer `speed`, `detailSpeed`,
  `upwardsCloudSpeed = 5`, and **flow maps** — Jool's gas-giant bands are four
  stacked layers each advected by `JoolFlowMap` at 0.008–0.1 speed. That is also
  the answer to "how do I do a gas giant with this marcher".
- **Star Citizen** calls its own shipped clouds "completely static" and treats
  fixing that as the headline feature of Genesis — i.e. even they consider it the
  visible gap.

⚠ **This is coupled to the perf work and must not be landed casually.** The BSM
cache (`cloudShadowMap.ts:614`) and the light-volume amortisation both key off
the cloud field being static. Turning on drift re-arms both every frame and hands
back the 2.2 ms BSM bake that 2026-08-13 removed. Sequence it *after* the bake
is made cheap (alternate-frame, fewer steps, or lower resolution with a
near-cascade covering the detail — see §5).

---

## 5. Ground-shadow sharpness — still one 512² map, and it has a second victim

`BSM_SIZE = 512` over `BSM_HALF_EXTENT_KM = 1500` → **5.86 km/texel**. takram
ships 3 texel-snapped cascades with a stochastic dithered blend; UE exposes
"Cloud Shadow Extent" purely to pack texels near the camera; Nubis³ moved the
whole light march into a 256×256×32 grid and got long-distance inter-cloud
shadows *plus* 40% off the frame.

The second victim is the ship. 2026-07-17 telemetry: under a visually thick tower
the ship's own macro column reads `single = 1.000` — a **no-hit**. The 512² map
simply has no cloud there. The plan's conclusion was "accept the macro limit";
one camera-following near cascade (512² over 30–60 km = 60–120 m/texel) fixes the
ground shadows *and* the ship probe with one asset, and is strictly cheaper than
the "dedicated detailed sun-march" that was costed and rejected.

---

## 6. Shape and variety — what is genuinely still open

Ordered by how much of the "looks weird" complaint each explains.

**6.1 No cirrus, no second deck.** The A channel is baked in both the synthetic
and ERA5 maps and **nothing reads it**. Real skies are almost never one deck.
KSP-EVE runs 2–5 layers per body with `receiveShadowsFromLayer` (a *higher* layer
shadowing a lower one); takram marches 4 layers packed in a `vec4`; Frostbite and
SC add a cheap high layer rather than widening the volumetric slab. A textured
cirrus shell above the 1–16 km slab costs the marcher nothing and is the largest
variety-per-day item on the board (`CLOUD_REVIEW_2026-07.md` Issue 3 #3).

**6.2 Height-graded detail sign — scoped, cheap, never built.**
`CLOUD_VS_TAKRAM.md` §5 #2: bias detail toward wispy/eroded at the base and
fluffy/billow at the top. Nubis³ gives the exact formulas (p.103, p.108):

```
wispy_noise           = lerp(noise.r, noise.g, dimensional_profile);
billowy_type_gradient = pow(dimensional_profile, 0.25);
billowy_noise         = lerp(noise.b * 0.3, noise.a * 0.3, billowy_type_gradient);
noise_composite       = lerp(wispy_noise, billowy_noise, detail_type);
```

We already have the HHF fold (p.117) and the wisp/billow channels; the missing
piece is specifically **grading which detail type applies by profile/height**.
Mechanically it needs `altNorm` threaded into `fineCarveDelta` and its two call
sites (`earthClouds.ts:1143`, `:2914`, `:3367`).

**6.3 Octave balance is improved, not solved.** Case #24's `MULTI_OCTAVE_SHAPE`
landed: octave step 1.34 → **1.20** (takram 1.14), patchiness 1.8× → **1.4×**
(takram 1.2×). "Some clouds smooth, some shaved off" is reduced by roughly half.
Closing the rest means adding octaves to the *silhouette* — the graded extra
octaves at `MO_GRADE_POW = 1.0` currently trade detail for connectivity
(floater mass 0.26% → 0.08%). A finer trade (0.5–0.7) is available if floaters
can be suppressed another way.

**6.4 Do NOT re-chase these** — each was measured and refuted:

| Idea | Verdict |
|---|---|
| `BASE_FBM_BILLOW` to make the base multi-octave | 1.2 → 3.0 moves octave step by **0.01** (case #24) |
| Domain-warping the base shape | days of case #19: stringy filaments, not billows |
| 8-octave energy-conserving multi-scatter | measured **worse on every metric** than our `MS_GAIN` fudge (case #25 close-out) |
| Normalising remap erosion for "contrast" | identical silhouette, 2.6× over-dense edges, breaks the case-#20 envelope bound |
| `MS_COEF` above 1 | backwards physics; r→1 is the signature of *single* scattering |
| Raising skylight to brighten shadows | +0.1% of total radiance at real HDR weights — inert |
| `DETAIL_FADE` as the cause of per-cloud variation | refuted by observation (same distance, different clouds) |

---

## 7. Maintainability risks worth naming

- **`earthClouds.ts` is 5,027 lines** and holds the marcher, the far shell, the
  opacity-LUT bake and the Earth wiring. `cloudShared.ts` (1,051) split out in
  Phase 0 and the file still grew. The shell in particular has no dependency on
  the marcher's internals and is a clean extraction.
- **Two independent `uCloudUvOffset` uniforms** (`:1745` shell, `:1987` marcher).
  The shell's own comment says they must be consolidated before drift is
  animated. They will silently slide apart the day §4 lands.
- **Stale comments on shipped constants** — already caught three times
  (`CLOUD_VS_TAKRAM.md` §5#1: comments claiming K capped at 1.0 while 0.7 shipped,
  γ = 1.0/0.7 while 4.0/0.1 shipped, `FINE_CARVE_CU` 0.28 while 0.20 shipped).
  Trust the constants and `DEBUG_VIZ`, not the prose. Worth one sweep.
- **Three wasted 2D taps** (`covNear/covMid/covFar`, `:2565–2573`) feeding a
  trivially-true `If` at `:2788` that is *load-bearing TSL scope magic* — removing
  it zeroed alpha. Leave it unless someone re-falsifies it; just know it is there.
- **`cloudReconstructionPass.ts` reassigns `TextureNode.value` per frame** — the
  pattern SpaceRenderer avoids elsewhere because the WebGPU bind-group cache does
  not always honour it. First suspect if one-frame-stale reconstruction ever appears.

---

## 8. Recommended order

Effort: S <½ day · M 1–3 days · L ~a week.

| # | Item | Impact | Effort | Why here |
|---|---|---|---|---|
| 0 | **Re-measure** (`__bench.sweep()` from a clean `deep_space` reload) | — | S | Every item below is sized by it; the last cloud number is three weeks and eight commits old |
| 1 | **Sky-occlusion channel** in the light volume's free `.g` | H | S–M | Nubis³ p.149 verbatim; the direct fix for flat/over-bright bases; bake already amortised |
| 2 | **Far-shell relief**: height-gradient normal + sun-offset shadow tap + drop `FAR_SHADOW_FLOOR` | H | S | Answers "the far shell looks flat" directly; 2–3 2D taps on the sampling path already measured clean |
| 3 | **Instrument the opacity LUT's internals** (`dilated`/`carved`/`eroded` distributions) | H | M | The 2.5× cloud-area deficit is the biggest realism gap and §5.7 says it needs data, not sweeps |
| 4 | **Spend the perf surplus on sharpness** (`CLOUD_MAX_DPR`, denoise radius, detail-fade floor) | M–H | S | Only if #0 confirms the headroom; interleave A/B/A, plugged in |
| 5 | **Near-cascade BSM** | H | L | Fixes ground-shadow sharpness *and* the ship-in-tower no-hit with one asset; prerequisite for cheapening the bake enough to allow #7 |
| 6 | **Empty-space skipping** (2D height/cone pyramid first, SDF in the light volume's `.b` second) | M–H | L | The only structural perf lever left; 3.2× in Nubis³, shipped in SC and EVE |
| 7 | **Animation** — wind offset on the noise sample position, curl advection, flow maps | H (aliveness) | M–L | Also the gas-giant enabler; blocked on the BSM bake cost |
| 8 | **Cirrus deck** from the already-baked A channel | M–H | M | Largest sky-variety win per day; costs the marcher nothing |
| 9 | **Height-graded detail sign** (Nubis³ p.103/108) | M | S–M | Cheap shape polish once #1 makes the shading read |

Two framings worth carrying into all of it:

- **Match ordinary cumulus before chasing towers.** takram's clouds read better
  largely because they render modest decks extremely well and never attempt
  cumulonimbus. Our tower machinery fires on ~1–13% of the surface (measured);
  the other 87% is where the eye spends its time.
- **Star Citizen has no far-field representation at all** — they de-tile the same
  volumetrics from orbit. Ours is the right call for a browser budget, but it
  means the shell has to *earn* its 3D read (§2) rather than inherit it.

---

# Addendum — 2026-09-05, after the live sweep + screenshots

Christian supplied a fresh `__bench.sweep()` (dirty tree, canvas 2496×1816,
DPR 1.8, started from deep space) and three in-game screenshots, plus five more
specific complaints. Everything in §1 about *how* to read the numbers still
holds; the numbers themselves change several conclusions.

## A1. The sweep is measured on the NIGHT SIDE, and that invalidates the ladder

Christian flagged this himself and it is the most important thing in the data.
Real orbits now put every `earth_*` scenario on the unlit hemisphere. Two
consequences, both large:

1. **The cloud marcher's entire lighting block is skipped.** `earthClouds.ts:3915`
   gates it on `If(daylightS.greaterThan(0.001), …)` — sun march, light-volume
   tap, dual-lobe phase, powder, multi-scatter, all of it. So the measured cloud
   cost is the *unlit* cost.
2. **The atmosphere march has almost nothing to integrate.**

The screenshots give the day-side numbers, and the gap is enormous:

| | bench (night) | screenshot (day) | ratio |
|---|---|---|---|
| deck, `blend 1.00` — frame p50 | 18.20 ms (55 fps) | **25.48 ms (39 fps)** | 1.40× |
| `1.5 atmosphere` at comparable orbit alt | 2.83 ms (earth_6629) | **8.17 ms** (SS3) | 2.9× |
| `1 scaled scene`, same | 1.86 ms | 3.75 ms | 2.0× |

⚠ The deck comparison is confounded — the screenshots also look *along* the deck
(grazing rays, no early-out), which the bench pose may not. Lighting and pose
need separating. But either way the conclusion is the same:

> **The benchmark ladder is measuring a materially easier scene than gameplay.
> Add day-side scenarios before any further perf attribution.** `resolveScenario`
> should place the ship at a sun-facing longitude (and one horizon-looking deck
> pose), otherwise every future A/B is run against the cheap half of the problem.

This also retires the §1 framing "the clouds are nearly free": that was measured
unlit. On the lit deck the cloud passes are the top three reported entries
(marcher 16.43, reconstruction 17.03, composite 18.25) — reported, therefore
inflated (gpu/frame = 83.25/25.48 = **3.3**), so they must be ablated, not summed.

## A2. Gate straddles (valid — frame p50, timestamp-independent)

| gate | 2026-08-13 | 2026-09-05 | note |
|---|---|---|---|
| froxel (4100→3900) | +0.60 ms | **+0.4 ms** | unchanged |
| BSM (2100→1900) | +5.60 ms | **+1.4 ms** | the bake cache is holding ✅ |
| whole cloud pipeline (750→650) | +2.35 ms | **+1.6 ms** | unchanged — **but night-side** |

## A3. ⚠ The whole ladder has regressed ~5–7 ms, and it is NOT the clouds

Against the post-BSM-cache baseline recorded in `PERF_MEASUREMENT.md`:

| scenario | 2026-08-13 | now | Δ | clouds active? |
|---|---|---|---|---|
| earth_6629 | 120 cap (≤8.3) | 10.5 ms | +2.2 | **no** |
| earth_4100 | ~11.8 | 12.0 | +0.2 | **no** |
| earth_2100 | 120 cap | 13.9 | +5.6 | **no** |
| earth_750 | 120 cap | 15.2 | +6.9 | **no** |
| earth_650 | 9.60 | 16.8 | +7.2 | yes |
| earth_250 | 11.00 | 17.2 | +6.2 | yes |
| earth_120 | 12.90 | 18.6 | +5.7 | yes |
| earth_30 | 13.30 | 19.1 | +5.8 | yes |
| earth_8 | 12.80 | 18.2 | +5.4 | yes |

**The regression is present in scenarios with `cloudsVisible: false`**, at a
*smaller* canvas (4.53 Mpx now vs 5.45 Mpx then). So it is not the cloud system.
Two new passes appear that were not in the August list:

- **`1.6 atmo apply` — and it costs as much as the 32-step march itself, at
  every altitude.** At `earth_12629`, the one row where `gpu/frame = 1.08` and
  the per-pass numbers are trustworthy: atmosphere **1.65** vs atmo apply
  **1.94**. Same at 6629 (2.83 / 2.98), 4100 (4.36 / 4.48), 2100 (6.34 / 6.57).
  This is the half-res AP split's full-res application pass. It should be
  `scene·T + L` — two fetches and a mad — and it is instead tracking the march
  1:1 in both magnitude and scaling. **That is the number I would chase first.**
  Prime suspect is already instrumented: the per-channel
  `pow(a, uTSpectralK)` spectral-transmittance reconstruction, which has a
  runtime ablation (`uSpectralTOn` / `__lum.atmoSpectralT`).
- **`5a glare PSF` ~1.0 ms** flat — the Phase 8 replacement for bloom. Fine.

⚠⚠ **And the sweep was taken on a dirty tree** — 378 uncommitted lines in
`atmospherePass.ts`, including `uShadowSplit = 1` (D14e), which *adds* march
work at the shadow boundary. So part of the +5–7 ms may be uncommitted debugging
work. That work shipped its own runtime knobs precisely for this.

**Do this before anything else** (three one-line ablations, interleave A/B/A,
plugged in):

1. `__lum.atmoSplit(false)` — is the D14e shadow split the regression?
2. `__lum.atmoSpectralT(false)` — is the `pow` the reason `atmo apply` costs a march?
3. `git stash` the atmosphere changes and re-sweep — the clean-tree control.

Only then look at clouds.

## A4. "Volumetric clouds are not fully stable when moving the camera"

Root-caused to the reconstruction's design point, which is currently set toward
"wobble" over "noise", plus three compounding inputs.

`cloudReconstructionPass.ts` is a Frostbite EMA:
`out = lerp(rectifiedHistory, currentSample, EMA_ALPHA)` with **`EMA_ALPHA = 0.1`
(`:202`) — a ~10-frame window** — and a **deliberately loose ±12.5% YCoCg clamp**
(`:461`) whose own comment says it "must reject only GROSS disoccluded history …
never bite legitimate accumulation", i.e. it is tuned to *not* suppress wobble.

Why 10 frames of history cannot stay registered under motion:

1. **Clouds have no single depth, so the reprojection depth is a compromise.**
   The marcher reprojects through `weightedDepthSum / depthWeightSum` — a
   transmittance-weighted centre of mass (`earthClouds.ts` ≈:2680). That is the
   right choice for diffuse cloud (it fixed the swimming ghost-dots) but it is
   *not a surface*: for a semi-transparent pixel the history is fetched from a
   position that is behind the visible edge, so the edge slides as the camera
   moves.
2. **`currentSample` is a bilinear upsample of the ¼-res sparse buffer**, so each
   full-res pixel's "current estimate" is a 2×2 smear that shifts with the camera.
3. **`EMA_ALPHA` is a compile-time constant** — no velocity adaptation. Every
   shipped TAA raises alpha (shortens the window) under fast motion; we don't.
4. **`DITHER_FRACTION = 1.0`** — full-step STBN jitter on `tStart`, plus coarse
   first-hit detection at altitude (`uLodMinSamples` floors at 8 by ~200 km), so
   the front position itself re-rolls per frame in exactly the thin regions the
   clamp is told not to touch.

Levers, cheapest first: velocity-adaptive `EMA_ALPHA`; a Catmull-Rom (or
sharpened) history fetch instead of bilinear — takram's, and the standard TAA
answer to upsample smear; reprojecting high-alpha pixels through a *front*-biased
depth rather than the centre of mass; takram's view-space velocity for non-cloud
pixels (dodges far-plane float precision). Measure each against a fixed camera
sweep, not by eye.

## A5. "The cloud height variation is weird — individual clouds randomly slope up and down"

**Found it, and the code comment states the intended behaviour that the
implementation cannot produce.**

`cloudShared.ts:182` —

```ts
jitterTopAlt = topAlt + (mesoG − 0.5) × TOPALT_JITTER_AMOUNT × convectivity
```

with `TOPALT_JITTER_AMOUNT = 0.8` (`:174`) and `mesoG` = the **smooth Worley-FBM
G octave at `MESO_SCALE = 16`**, documented at `:117` as **~8 km cells**.

Two problems, and they compound:

1. **The jitter field is smooth and its correlation length is the same order as a
   cloud body.** A cumulus is 1–5 km across; the jitter varies over ~8 km. So it
   varies *within* one cloud rather than *between* clouds — the top surface of a
   single body is a continuous ramp. That is literally "individual clouds slope
   up and down".
2. **The amplitude is huge.** ±0.4 in alt01 on a 15 km slab is **±6 km**, up to
   12 km peak-to-trough, before `TURRET_RISE = 0.3` (+4 km) is added on top.

The design intent is written right there at `:113` — *"ramps become stepped lines
of towers"* — but a smooth remap of a smooth field cannot produce steps. And the
one previous attempt (2026-07-08) failed for a different reason: it **quantised
`topAlt` globally in altitude**, which gave "flat decks hard unnatural edges
everywhere". That failure does not apply to the right fix.

**The right fix is a piecewise-constant field: key the jitter to a cell *id*, not
to a smooth noise *value*.** Hash the Worley cell index (or the placement cell
centre) → one constant top per cloud body, neighbours step, no intra-body slope,
and no global altitude quantisation. This is the standard trick and it is exactly
what the comment asked for. Amplitude can probably come down at the same time —
±6 km of *per-cell* variation reads as a skyline; ±6 km of *within-cell* gradient
reads as broken geometry.

Verify with `DEBUG_VIZ='topAlt'` before and after, and remember case #26's lesson:
**calibrate the viz to the effect size** — a 7 km colour ramp cannot show a 1.5 km
artefact.

⚠ Lockstep: `jitterTopAlt` is applied by the marcher **and** the light-volume
bake. Both must change together or baked shadows detach from the tower tops.

## A6. "Ground shadows are not crisp"

Confirmed, unchanged, and quantified in §5: one 512² BSM over ±1500 km =
**5.86 km/texel**, no cascades. On top of that the consumer blurs further —
`SHADOW_PENUMBRA_MAX = 6.0` texels at grazing sun ≈ **35 km of blur**, and
`BSM_SOFT_BLUR_TEXELS = 1.5` on the god-ray copy.

Screenshot 3 shows the second half of the problem: **from orbit there are no
cloud shadows on the ocean at all**, because `BSM_MAX_ALT_KM = 2000` gates the
whole thing off above 2000 km. Cloud shadows near the terminator are one of the
strongest 3D cues in real orbital imagery, and we render none. That is a second,
independent reason the far view reads flat (§2) — and the fix is the same
sun-offset coverage tap proposed there, which needs no shadow map at all.

Recommended shape, unchanged: one camera-following near cascade (512² over
30–60 km ⇒ 60–120 m/texel), texel-snapped, stochastic dithered blend with the
existing wide map. It also fixes the ship-in-tower no-hit (§5) with the same asset.

## A7. "It's only one cloud layer"

Confirmed — see §6.1. Worth adding what the reference configs actually do, since
the KSP-EVE mod is sitting in the repo and is the closest shipped analogue:
`docs/VolumetricCloudReferences/.../Clouds/clouds.cfg` gives Kerbin **five**
layers (two cloud decks at 2.7 km and 6.7 km, two weather layers, snow
particles) with `receiveShadowsFromLayer = Kerbin-clouds2` so the *upper* deck
shadows the lower one, and Duna a separate `Duna-rare-cirrus` layer at 12.2 km.
Jool (the gas giant) is four stacked layers, all at 20 km, each advected by
`JoolFlowMap` at a different speed — which is simultaneously the answer to
"multiple layers" and to "how do I do a gas giant with this marcher".

## A8. "Cumulus towers don't look fully realistic"

Three things are true at once here and they should not be conflated:

1. **The reference we are chasing does not do this either.** takram renders no
   cumulonimbus at all (fixed 4-layer model); its clouds look good because its
   *ordinary* cumulus decks are excellent. Our towers read wrong partly because
   we attempt a harder thing. `CLOUD_VS_TAKRAM.md` §5 #2 is explicit: match
   ordinary cumulus first, treat Cb as a separate track.
2. **The turret machinery is a mask stamped on isotropic noise.** `turretMask`
   raises `topAlt` and forces coverage on the top ~16% of the updraft field, but
   the underlying shape noise is the same isotropic Worley everywhere — so a
   turret is a *taller lump*, not a structurally different body. Measured:
   turrets fire on ~1–13% of the surface and "T rarely tops 0.3". Real Cb are
   wide-based and vertically organised; ours are narrow columns raised out of a
   deck. The plan already notes "tall should come from wider coverage cells, not
   narrow raised columns".
3. **`ANVIL = false`** — the shield mechanism is disabled (it fired on every tall
   convective column and lifted a ring of bases to 4–11 km with clear air
   beneath). So the single most recognisable Cb silhouette feature is off.

A5's per-cell top fix is a prerequisite for any of this: while a tower's own top
slopes across its width, no amount of profile work will make it read as a tower.

## A9. What the screenshots show, read directly

**SS1 (in-deck, day, 39 fps).** The mid-distance ridge has genuine cauliflower
relief along its top edge — the shape work is visible and working. But the body
below it is a uniform bright grey-white with **no dark base and no crevice
shading**, and the foreground mass is completely featureless. That is §3's
missing sky-occlusion term plus the reconstruction blur, exactly as predicted.
This is the clearest single image of the "cotton wool" problem.

**SS2 (day, 6 km, 38 fps).** The left tower reads well. The **long thin straight
diagonal streak** to its right does not — it is too linear and too uniform to be
a natural cloud. First suspect: `MESOSCALE_TEST = true` (`earthClouds.ts:771`),
whose `smoothstep(MESO_LANE_LO 0.45, MESO_LANE_HI 0.70)` cuts **true-zero clear
lanes** through coverage at a ~31 km cell scale. A cell boundary seen edge-on
would render as exactly this. Check with `DEBUG_VIZ='profile'`.

> ⚠ Separately: `MESOSCALE_TEST` is documented in its own comment as **TEST-ONLY**
> and **marcher-only** — "the far shell … and the light-volume bake do NOT see the
> mask — expect a visible handoff seam and slightly off tower-wall lighting near
> lanes during the test". It has been live in the shipped build for two months.
> Either promote it into the shared model (shell + light volume) or turn it off;
> right now it is a known near/far seam and known-wrong lighting near lanes.

Both close-range shots also show **soft silhouettes everywhere** — no crisp edge
anywhere in frame. That is the ¼-res march → bilinear upsample → 25-tap Gaussian
→ `CLOUD_MAX_DPR = 1.0` chain of §1, all four stacked.

**SS3 (orbit, day, clouds off, shell only).** The coverage and the weather
systems read genuinely well — the cyclone spiral off South America is
convincing, and this hemisphere looks fuller than the 25.6% disc average would
suggest. The failure is exactly §2: the clouds are **uniformly white with zero
shading variation**, soft-edged, and cast **no shadow on the ocean**. It reads as
white paint on a globe rather than a cloud deck. Nothing about the coverage field
needs fixing to improve this shot — it is entirely the shell's lighting.

## A10. Starship Simulator — what is actually published

Fleetyard Studios, UE5, 1:1 Milky Way (this is the game Christian meant; not the
same as Synthes Games' *Verse Project*, which is also a 1:1 Solar System in UE5).

**They have published no cloud-rendering internals.** What their update notes do
say, and what is transferable:

- Stock UE5 stack — `SkyAtmosphere` + `VolumetricCloud`. Their notes mention
  "reduced the planetary atmosphere GPU overhead considerably" but not how.
- **AgX tonemapping** "for more realistic colour response" — the same choice we made.
- **Nanite Tessellation on planetary surfaces, "giving them very basic 3D terrain
  when viewed from orbit."** This is the one genuinely interesting idea, and it
  is conceptually the same fix as §2: they concluded that a *painted* far
  representation reads flat and gave it real geometry instead. We cannot use
  Nanite, but the principle transfers directly — the shell needs relief (a height
  field and a shadow), not a better texture.
- Planetary rings cast shadows; gas giants got "atmospheric chemicals".

So: no implementation detail to steal, and nothing that contradicts the plan.
Practically, a stock-UE5 game is a *lower* bar than takram or KSP-EVE on cloud
internals — UE's `VolumetricCloud` has the same orbit weaknesses we do (its
recommended "Mode 0" quarter-res trace is what we already run). The systems worth
continuing to mine are KSP-EVE (shipped, planetary, multi-layer, animated, and
the source is effectively documented in the wiki + the config in our repo),
Nubis³ (the PDF we already have), and takram.

## A11. Revised order

The re-measure moved three things, so the §8 table is superseded by this:

| # | Item | Why it moved |
|---|---|---|
| 0a | **Ablate the three atmosphere knobs + re-sweep on a clean tree** | A3: a ~5–7 ms ladder-wide regression exists in cloud-free scenarios. Nothing else should be optimised until it is explained. |
| 0b | **Add day-side (and one horizon-looking deck) bench scenarios** | A1: the current ladder measures the unlit half. Every A/B below is otherwise run against the cheap case. |
| 1 | **Chase `1.6 atmo apply`** | A3: it costs as much as the 32-step march at every altitude, on the one trustworthy row. Biggest single unexplained number in the sweep. |
| 2 | **Per-cell `topAlt` jitter** (cell id, not smooth value) | A5: root-caused, small, and it unblocks any tower work. |
| 3 | **Sky-occlusion channel in the light volume** | unchanged — SS1 is the picture of why. |
| 4 | **Far-shell relief + sun-offset shadow tap** | unchanged — SS3 is the picture of why, and it also restores orbital cloud shadows that the BSM gate removes above 2000 km. |
| 5 | **Reconstruction stability** (velocity-adaptive EMA, Catmull-Rom history) | A4: newly root-caused, and it is a named complaint. |
| 6 | **Decide `MESOSCALE_TEST`** — promote to the shared model or turn it off | A9: a TEST-ONLY, marcher-only flag has been shipping for two months, and it is the first suspect for SS2's streak. |
| 7 | Near-cascade BSM · cloud-area instrumentation · empty-space skipping · animation · cirrus deck · height-graded detail | as in §8 |

---

# Cross-check against the shipped references (2026-09-05)

Sources read for this section, primary where possible:

| Source | What I read | Status |
|---|---|---|
| **RDR2 / RAGE** — Bauer, *Creating the Atmospheric World of Red Dead Redemption 2*, SIGGRAPH 2019 Advances | full 79-slide deck **+ 76 speaker-note pages**, downloaded and text-extracted | primary |
| **Frostbite** — Hillaire, *Physically Based Sky, Atmosphere and Cloud Rendering*, SIGGRAPH 2016 | §5 in full (`docs/VolumetricCloudReferences/Frostbite.md`, already in repo) | primary |
| **Nubis³ / Decima** — Schneider, SIGGRAPH 2023 | full 220-page deck (repo PDF), incl. the Nubis-Evolved retrospective | primary |
| **KSP-EVE / Blackrack** | shipped configs in repo + EVE wiki feature pages | primary-ish |
| **takram/three-clouds** | `CLOUD_VS_TAKRAM.md` (source-grounded, 2026-07-20) | secondary |
| **UE5** | Volumetric Cloud Component docs | primary |
| **Star Citizen** | `CloudTypesResearch/web_star-citizen-genesis.md` (CIG monthly reports) | secondary |
| 2024-26 literature | ICCS 2024 single/multi-scatter; *Environmental Volumetric Neural Shading of Clouds* (PACMCGIT 2025); Condor 2025 Gaussian volumes | scanned — all out of scope for a browser budget |

## X0. The framing that matters most: every reference is a LOCAL-SKY system

RDR2's entire cloud world is a **dome over a 32 × 32 km map** driven by a
**512 × 512** two-channel cloud map. Frostbite, Nubis and takram are the same
shape of problem. Our marcher reaches **700 km** and our field is a 6,371 km
sphere.

This is not a detail — it silently invalidates most direct number-for-number
comparisons, and it cuts both ways:

- **Their texel densities are unreachable and irrelevant.** RDR2's cloud shadow
  map is 768² over 32 km = **42 m/texel**. Matching that over our ±1500 km window
  would need a 71,000² map. This is the strongest possible argument that
  **cascades are not an optimisation for us, they are the only mechanism that
  exists** (§5 / A6).
- **Their step budgets describe short rays.** Frostbite ships **16 samples** at
  half res, 1.60 ms at 1080p on Xbox One, worst case. We run `MAX_PRIMARY_STEPS
  = 256`. That is not 16× the profligacy it looks like — their worst ray crosses
  a few km of slab, ours crosses hundreds. **Our step budget is a consequence of
  the 700 km reach, which means `SHELL_HANDOFF_FAR_KM` is a *performance* knob as
  much as a quality one.** That connection is not in the review above and it
  should be: improving the shell (§2) lets the hand-off come closer, which
  shortens every ray. Nubis³ says the same thing from the other side (p.173):
  long grazing rays under cloud bases are their worst case and "can be mitigated
  by offsetting the heights of these clouds to shorten the rays."
- **Nobody in the reference set renders clouds from orbit.** RDR2/Frostbite/Nubis
  never leave the troposphere; takram hard-caps at 200 km and flickers beyond it
  (their acknowledged TODO); only Star Citizen goes orbit-to-surface, and they do
  it by **de-tiling the same volumetrics**, with no far-field representation at
  all. Our analytic shell has **no prior art to copy**. That is a real advantage
  (nobody else has a flicker-free orbit view) and a real liability (there is no
  reference to tell us what it should look like — §2 has to be reasoned from
  first principles, which is what it does).

## X1. Feature-by-feature

Legend: ✅ we match or exceed · ⚠️ we differ and it costs us · ➖ they don't do it either.

| Dimension | RDR2 (2019) | Frostbite (2016) | Nubis³ (2023) | Us | |
|---|---|---|---|---|---|
| Cloud map | 512² R16G16, **two layers packed R/G** | weather map | 2D NVDF fields | 2048–8192² RGBA (cov/conv/topH/cirrus) | ✅ richer |
| Vertical profile | **1×128 RGBA8 LUT**, slice chosen by weather | height gradients | dimensional profile | 64-row genus LUT | ✅ |
| Density noise per sample | **1× 3D Perlin-Worley + 2× 2D displacement** | 1 base + 1 detail | uprez from NVDF | **~4–6 `texture3D`** | ⚠️ far heavier |
| Shape composition | Hermite on map+LUT, then `linstep` carve | Schneider remap | `saturate(noise − (1−profile))` | subtractive, K per type | ✅ |
| Phase | **2 HG octaves (g decreasing) + Lambertian back-scatter clamp**, g=0.8 | **dual-lobe HG** | dual-lobe | dual-lobe HG 0.8/−0.3 | ✅ |
| Multi-scatter | **2 direct-light octaves (Wrenninge)** | Wrenninge octaves, N=2 | profile probability field + SDF-relaxed Beer | `pow(Tsun,0.9)·MS_GAIN` + gates | see X3 |
| Sun visibility | shadow map + **ONE** secondary extinction sample, distance per weather | 4 samples, geometric spacing | 2 live samples + **256×256×32 cached grid** | light volume (1 tap) + near detail probe | ✅ same split |
| Ambient occlusion | **reuse the sun secondary sample** | **linear vertical gradient**, biased for ground bounce | **baked zenith-direction density** | **none** | ⚠️ **X2** |
| Cloud shadow map | **ESM 768² R16F + 6 mips**, transmittance-weighted depth, **1 ray per 4×4 tile per frame** | 2D transmittance texture, applied to opaque+transparent+particles+GI | in the light grid | Beer 512², whole-image cache | ⚠️ **X5** |
| Empty space | step refinement (bisection) | — | **compressed SDF + cone step: 10 → 2.2 ms** | none | ⚠️ **X4** |
| Reconstruction | 1-in-4 rays, **depth-rejected** AABB, **adaptive ray placement** | EMA + camera reprojection | **abandoned temporal for near clouds** | ¼-res, EMA α=0.1, loose AABB, fixed Bayer | ⚠️ **X6** |
| Upscale | **4 blue-noise taps, closest-depth on discrepancy, kernel width from weighted depth** | — | two-resolution spatial split | fixed **25-tap depth-blind Gaussian** | ⚠️ **X6** |
| Clouds → aerial perspective | yes (shadow area + weighted depth) | **yes, Eq. 22** | — | **no** (AP→clouds only) | ⚠️ **X7** |
| Cirrus / high layer | **8 km, ONE 2D texture lookup**, same shading model | — | — | channel baked, **unused** | ⚠️ cheaper than we assumed |
| Animation | wind offset on the 3D lookup | scroll | wind offset on sample position | **none** | ⚠️ |
| Depth for AP | transmittance-weighted mean (Eq. 21) | **transmittance-weighted mean (Eq. 21)** | — | same | ✅ canonical |

## X2. Ambient occlusion — three shipped systems, three approximations, and we have zero

This is the strongest corroboration in the cross-check for §3, and it also gives
a much cheaper interim than I proposed.

- **Frostbite** (§5.5.1): explicitly *does not* compute ambient occlusion —
  "would have not been practical … pre-integrating occlusion would also be tricky
  due to the very procedural nature of the volumetric cloud". Instead it weights
  ambient by **a linear vertical gradient from the bottom to the top of the cloud
  layer**, biased to `[a, 1]` so that `a` % is attributed to ground bounce.
- **RDR2** (slide 36 notes): "For ambient light we **re-use the secondary density
  lookups** to save performance (we'd have to gather transmittance in all
  directions otherwise)" — the sun-direction sample doubles as the occlusion term.
- **Nubis³** (p.149): the proper version —
  `ambient = pow(1 − dimensional_profile, 0.5) * exp(−summed_ambient_density)`,
  with the sky-direction sum precomputed in the same voxel grid as the sun.

We ship only the first factor of the Nubis form. `(1 − profile)^0.5` is a smooth
separable envelope — case #25 already established it **cannot see a noise-carved
crevice at all**. So we have no occlusion term of any kind, while all three
references have one. SS1 is the picture of that.

**Revised recommendation — do this in two tiers:**

1. **Tier 0, today, zero taps:** Frostbite's vertical gradient on the ambient
   term, biased for ground bounce. One multiply against `altNorm`, which is
   already computed per sample (`columnAltNorm`). This alone should give bases
   that read darker than tops.
2. **Tier 1:** the Nubis³ zenith-density channel in the light volume's free `.g`
   (§3). Better, and correctly coupled to overlying cloud.

## X3. Multi-scatter — our "don't re-chase" verdict survives, with a caveat

Both RDR2 and Frostbite ship the Wrenninge octave sum (N=2), which
`CLOUD_DEBUGGING_LESSONS.md` case #25 measured as **worse than our fudge on every
metric** in our system. Reading Frostbite §5.8 directly, that test was fair: it
swept the reduced-extinction placement, `a ≤ b` energy conservation, and the
per-octave phase compression `p(θ · cⁿ)` — i.e. the full Equation 20, not a
partial. So the verdict holds.

**But note what both references pair the octaves with, which we do not:** RDR2
adds an explicit **back-scattering term clamped toward the Lambertian `1/π`,
driven by the material's extinction** (slides 30–32) on top of its two HG octaves,
because "with a strong forward peak, only ambient lighting would remain when
looking at clouds when the sun is behind the camera." Our dual-lobe's measured
effective `g = 0.250` is already far more isotropic than either reference
(RDR2 uses g = 0.8 for cloud), so we get that behaviour a different way. Worth
knowing before anyone "fixes" our phase to be more forward-scattering: it would
re-open the problem RDR2 needed a hack to close.

## X4. Empty-space skipping is now the highest-confidence structural item

Nubis³ publishes the number, and it is the largest single optimisation in the
entire cross-check:

| Nubis³ scene | base | + voxel lighting | **+ adaptive & SDF ray-march** |
|---|---|---|---|
| ground | 10 ms | 6.1 | **2.2** |
| air between clouds (long grazing rays) | 12 ms | 8.2 | **4.0** |
| full immersion | 10 ms | 8.0 | **4.0** |

`step = max(sdf_cloud_distance, adaptive_step_size) + jitter` (p.171). Star Citizen
independently ships a narrow-band SDF over the coverage field with signed mips;
KSP-EVE added SDFs in Release 4. **Three shipped planetary/large-scale systems,
one answer.** And note the middle row is our exact worst case — long rays glancing
under cloud bases.

RDR2 does it without an SDF, and their method is nearly free for us to adopt
(X6.1 below).

## X5. Two corrections to the review from RDR2's shadow map

1. **ESM, not raw Beer, plus a mip chain.** RDR2 stores the cloud shadow as an
   **exponential shadow map** — transmittance-weighted ray length — then
   **blurs it and keeps 6 mips**, explicitly "to reduce aliasing, flickering and
   unwanted crawling effects". We do the softening at *read* time with a 5-tap
   penumbra kernel up to 6 texels (≈35 km) wide. Pre-filtered mips are both
   cheaper and more stable than a runtime kernel, and a mip chain is what lets a
   *cascade* blend cleanly. Add it while doing the near-cascade work.
2. **🔑 They amortise the shadow map by RAYS, not by caching the image** — "we only
   update **1 ray in a 4×4 tile** for the cloud shadow map" (slide 57 notes).
   **This unblocks the animation item (§4).** The review said drift is blocked
   because our BSM cache keys on the field being static, and re-arming it costs
   back the 2.2 ms bake. RDR2's answer is that you never needed the whole-image
   cache: refresh 1/16 of the texels every frame and the map tracks moving clouds
   at 1/16 the cost, permanently. That is strictly better than our all-or-nothing
   cache and it removes the blocker.

## X6. Camera-motion stability — the references disagree with our design point

This is the part of the cross-check that most changes the plan. Two shipped
systems, two opposite strategies, and **both of them reject what we currently do.**

**Guerrilla abandoned temporal upscaling for near clouds outright.** Nubis³ p.50:
16-frame temporal upscaling "worked for distant clouds but **not for nearby
clouds because the image would not be able to resolve in time when the camera
moves quickly**." Their replacement (p.181, p.184) is a purely *spatial* split —
**480×270 under 200 m, 960×540 beyond** — "we did away with temporal upscaling".
It saves ~50% and it is what made flight through clouds possible. The SDF march
(X4) is what made dropping the amortisation affordable.

**RDR2 kept 1-in-4 temporal reconstruction, but every detail differs from ours in
the direction of stability:**

| | RDR2 | Us |
|---|---|---|
| history validation | AABB from 3×3, **dropping neighbours with high depth difference** — "prevents overly large AABBs which can't sufficiently clamp the reprojected pixel and **therefore cause ghosting in motion**" | raw 3×3 with a **deliberately loose ±12.5% pad**, no depth rejection |
| ray placement in the tile | checkerboard + **depth min/max neighbourhood analysis**, ray placed at the under-represented depth | fixed 4-entry Bayer — **explicitly their failed "first attempt"** (slide 53) |
| no history | nearest valid depth sample from the neighbourhood | fresh sample |
| upscale | 4 blue-noise taps, average *or* **closest depth on discrepancy**, **kernel width from the transmittance-weighted ray depth** "to avoid unwanted blurring at far distances" | fixed **25-tap Gaussian, depth-blind, constant width** |
| froxel temporal | **none** — "light ghosting… **trailing with strong forward scattering on moving camera**"; dithered + TAA instead | n/a, but we run HG forward 0.8 with a 10-frame EMA |

Our loose clamp is a *deliberate* choice recorded in the code ("must reject only
GROSS disoccluded history … never bite legitimate accumulation"), taken because
tightening it re-introduced noise. RDR2's slide says the correct move is not to
loosen the pad but to **tighten the neighbourhood** — reject depth-discrepant
samples so the AABB is small *and* valid. That gets both properties at once.

**And this is nearly free for us: `cloudReconstructionPass.ts` already binds
`uSparseDepthNode` and reads `freshTFront` (`:267`, `:297`).** The per-tile depth
needed for the rejection is already in the shader. Same for the composite: the
sparse `tFront` target is already passed into `buildCompositeFetch` for the AP
path, so a depth-scaled, depth-rejecting upscale needs no new plumbing either.

**One more, cheap, and previously unnoticed:** RDR2's step refinement (slide 50
notes) is a **bisection** — "each time we hit the base shape of a cloud, we
**half** the step length and move the sample position back by that distance …
repeat with a fixed number of iterations `i_max`". Our skip→dense transition
(`earthClouds.ts:3376`) does **exactly one** such halving, `t -= dtSkipInBand·0.5`.
So our dense-entry point is quantised to ±½ the skip stride — **up to ±750 m**
(`SKIP_DETECT_CAP_SCALED = 1.5 km`) — and it re-rolls every frame with the STBN
jitter. The visible cloud front therefore moves up to 750 m frame-to-frame at
close range, inside a 10-frame history window. Three more iterations bring that to
~90 m, cost only on transition steps. **This is likely a direct contributor to the
instability complaint and it is a handful of lines.**

## X7. One missing interaction nobody in the review caught: clouds → aerial perspective

Frostbite §5.9.2 and RDR2 slide 62 both do this; we do only the reverse direction.

Frostbite Eq. 22: `L_AP = L_AP × Tr_cloud + L_cloud` — the hemisphere-mean cloud
transmittance attenuates the aerial perspective, and the clouds' own integrated
luminance is added into it. Their Figure 41 is exactly the failure we have: with
AP applied *to* clouds but clouds not affecting AP, the haze under a heavy overcast
stays as bright as clear-sky haze. RDR2 does the same thing via an accumulated
"shadow area" term applied at the weighted depth.

We apply the froxel AP inside the marcher (`CLOUD_AP_IN_MARCHER`) and stop there.
Cost is small — one low-res render of clouds over black, or reuse of the BSM's
mean transmittance — and it is the difference between an overcast sky that feels
overcast and one that just has grey shapes in it.

## X8. What the cross-check did NOT change

- **§2 far-shell relief** stands, and X0 explains why there is no reference to
  crib from. Starship Simulator's Nanite-tessellated planets-from-orbit is the
  only adjacent data point and it agrees with the direction.
- **The cloud-area deficit (§2, LIGHTING_PLAN §5.7)** is unaffected — it is our
  own measurement problem.
- **§6.4's "do not re-chase" list** survives contact with the primary sources; see
  X3 for the one caveat.
- **Cirrus (§6.1)** gets *cheaper*, not harder: RDR2 does it with a single 2D
  texture lookup at 8 km sharing the main shading model, not a second march.

## X9. Revised priority after the cross-check

Changes from A11, with reasons:

| # | Item | Change |
|---|---|---|
| 0 | Atmosphere ablations + day-side bench scenarios | unchanged (A3, A1) |
| 1 | **Reconstruction/upscale: depth-rejected AABB, depth-scaled upscale kernel, bisected dense entry** | ⬆ **moved up.** X6 gives three specific, small, primary-source-backed fixes for the named stability complaint, and the depth data is already bound in both passes. |
| 2 | **Ambient occlusion — Frostbite vertical gradient now, Nubis³ zenith channel next** | ⬆ tier-0 version is a one-liner (X2) |
| 3 | Per-cell `topAlt` jitter | unchanged (A5) |
| 4 | Far-shell relief + sun-offset shadow | unchanged (§2) |
| 5 | **Empty-space skipping (SDF / cone-step)** | ⬆⬆ **reframed as a quality item.** X4 gives the numbers (10 → 2.2 ms), and X6 shows it is the *prerequisite* for reducing temporal amortisation — which is the real fix for camera-motion stability. Also note `SHELL_HANDOFF_FAR_KM` is the other lever on the same cost (X0). |
| 6 | **BSM: near cascade + ESM + mips + per-ray amortisation** | merged; the 1-ray-in-4×4 refresh (X5.2) **removes the blocker on animation** |
| 7 | Animation / wind | ⬆ unblocked by 6 |
| 8 | Clouds → aerial perspective | **new** (X7) |
| 9 | Cirrus layer | cheaper than assumed (X8) |
| 10 | Cloud-area instrumentation, height-graded detail | unchanged |

---

# X10. TO DO ALONGSIDE THIS WORK: an aerosol LAYER profile (from LIGHTING_PLAN D38)

Added 2026-09-06. This is atmosphere work, but it is listed here because it must be
**designed together with** the volumetric cloud deck rather than before it — the split
between "haze layer" and "cloud deck" is the design decision, and fitting either alone
bakes in a compensation the other then has to unpick.

## X10.1 The structural gap

`AtmosphereParams` can only place aerosol as an **exponential from the surface**
(`mieScaleHeightKm`). **Ozone is the only term with a tent profile**
(`ozoneCenterKm` / `ozoneWidthKm`, `sampleMedium` in `atmospherePass.ts`).

Every remaining planetary-colour defect is a **layer-at-ALTITUDE** problem:

| body | what is missing | why the exponential cannot express it |
|---|---|---|
| Saturn | gold photochemical haze | it is stratospheric (0.01–0.05 bar ≈ 130–200 km up), i.e. **above** the Rayleigh column |
| Jupiter | same, milder | same |
| Uranus / Neptune | stratospheric haze | their `mieScaleHeightKm` defaults to 0.15 × H = 4.0 / 2.9 km, hugging the 1-bar level |
| Venus | cloud deck | opacity currently carried by **Rayleigh** (τ_B 44.4) instead of a high bright cloud (real τ 25–40) |

MEASURED consequence for Saturn: at `hazeScaleHeightKm: 25` against its own 55.6 km gas
scale height, **56.8% of the blue Rayleigh optical depth sits ABOVE the haze**, where no
haze absorption can reach it. As blue haze absorption → ∞ the blue reflectance
asymptotes to a **floor of 0.2624 against a target of 0.2592**.
⇒ **No value of `hazeAbsorptionTint` can produce Saturn's measured colour at that scale
height.** A fit that ignores this returns tint_B ≈ 30, which is fiction — the haze being
asked to absorb light it never sees.

## X10.2 Why it belongs with the cloud work, not before it

🔑🔑 **The CH₄ defect and the missing cloud deck are the same defect** (D38). A
band-averaged grey absorption coefficient is only meaningful together with the PATH
LENGTH photons travel, and that is set by the **reflecting level**. The model reflects off
`groundRadiusKm` — the **1-bar level** — because there is no deck. Real gas giants turn
photons around far above that: Jupiter/Saturn ammonia ~0.5–0.6 bar, ice giants' methane
~1.3–1.5 bar.

MEASURED: scaling each CH₄ column to its real reflecting level accounts for **Jupiter's
entire discrepancy (1.32×)** and part of Saturn's (**7.24× remains**).

⚠⚠ And the requirement itself is unknowable beforehand: Saturn's "needed τ_R = 0.033"
was fit against photons bouncing off a 1-bar Lambert deck of albedo 0.57 — neither the
right depth nor the right brightness.

## X10.3 What to build

1. **A second aerosol mode with a tent profile**, mirroring ozone exactly:
   `hazeLayerCenterKm`, `hazeLayerWidthKm`, plus its own scattering/absorption/`g`.
   Default zero width ⇒ the term collapses to nothing, so it ships as a **provable
   no-op** until a body authors it. Ozone already pays ~5 ALU per march step for the
   same shape, so the cost precedent exists.
2. **An explicit reflecting level** (cloud-top pressure, or a radius) so the gas
   absorption column and the cloud deck agree on where photons turn around. The hook for
   the per-body half already landed: `AtmosphereDef.gasAbsorptionScale`, default 1.
3. **Only then** re-fit, in ONE commit: CH₄ per body, Saturn's haze, Jupiter's deck. The
   targets in LIGHTING_PLAN D36 were all computed against the pre-D37 optical depths and
   a 1-bar reflecting level; **treat them as superseded, not as inputs.**

## X10.4 Gate

`__lum.atmoSpectrum()` prints vertical τ per channel, aerosol single-scatter albedo and
limb transmission, all as a pure CPU read of the shipped params — no GPU, no pose. It is
how the mis-slotted `MIE_ABSORB_EARTH` was caught (three bodies reported SSA identical to
16 digits). Re-measure with it before and after any of the above.
