# Cloud empty-space skipping — scope

Status: ✅ **SHIPPED 2026-09-14 as §5 — a conservative empty-space skip built on a
bake-time max-reduction of the meso field. MEASURED −1.58 / −0.94 / −2.48 ms at
earth_8 / earth_horizon_8 / earth_up_8, neutral at earth_250, control flat, and the
`densePerRay` invariant holds so the image is unchanged.**
The original two phases stay dead — read §3b for why, then §5 for what replaced them.

Status (original): ❌ **BOTH PHASES KILLED IN SCOPING, 2026-09-08, before any shader was written.**
See §3b for the killer: the top-altitude field carries a **±6 km runtime jitter on a
488 m horizontal scale**, so no conservative altitude envelope is tight, and even a
perfect one saves only ~0.39 ms because the camera sits inside the envelope. The 2.18 ms
oracle bound in §2 stands but is not reachable this way.
Supersedes the empty-space-skipping items in `CLOUD_REVIEW_2026-09.md` §1 and X4; read
§1a–§1g there first for how the numbers below were obtained.

---

## 0. The one-paragraph version

**80.6% of a nadir chord and 91.5% of a horizon chord carry no cloud** (`profile ≤ 0.01`),
and the march currently pays a full step through all of it at a **measured 0.0605 ms/step**.
A perfect oracle would save **~36 steps ≈ 2.18 ms** at `earth_8`. That bound is sound.

❌ **But neither proposed mechanism can reach it.** §3b: the top-altitude field carries a
**±6 km jitter on a 488 m horizontal scale**, so no conservative altitude envelope is tight;
and the skippable 80% is the **profile taper inside** the envelope, not the envelope itself,
so even a perfect `[base, top]` clip saves ~0.39 ms — below the plan's own 0.8 ms kill line.

⚠ §3 and §4 below are the pre-kill reasoning. They are kept because the geometry in them is
correct and reusable; their conclusion is not.

---

## 1. What is measured, and what is derived from it

Measured (see `PERF_MEASUREMENT.md` 2026-09-08, all cold, thermometer both ends):

| quantity | value | how |
|---|---|---|
| march loop at `earth_8` | **3.925 ms = 20.5% of frame** | `__lum.cloudMarch(false)` ablation |
| per-step cost | **0.0605 ms/step** | 3.925 / 64.9 steps; ladder slope agrees (0.051–0.071) |
| loop scales with step count | **proportional, no fixed term** | lod 40 predicted −0.708 vs measured −0.675; lod 24 −0.974 vs −0.818 |
| steps / dense / cheap-probe at `earth_8` lod 40 | 53.2 / 6.8 / 10.3 | `__lum.cloudIters()` |
| same at `earth_horizon_8` | 78.4 / 4.1 / 6.7 | `__lum.cloudIters()` |

Derived (arithmetic only, no new measurement):

| | `earth_8` | `earth_horizon_8` |
|---|---|---|
| chord | 7.35 km | 319.6 km |
| mean step | 138 m | 4077 m |
| cloud actually sampled (dense) | 235 m = **3.2%** | 4.18 km = **1.3%** |
| `profile > 0.01` band | 1.42 km = **19.4%** | 27.3 km = **8.6%** |
| **skippable** | **80.6%** | **91.5%** |

⚠ `0.0605 ms/step` was measured at `earth_8`. **Do not transfer it to another pose** — the
one time a cost was carried across conditions (a hot→cold rescale) it was 62% wrong.

---

## 2. ✅ The ceiling survives its own kill test

The feature was to be abandoned if a perfect oracle still needed >20 steps. It does not:

| | band | steps after a perfect clip | today | saved |
|---|---|---|---|---|
| `earth_8` | 1.42 km | **14.2** (+~3 to reach it) | 53.2 | **36.0 ⇒ 2.18 ms** |
| `earth_horizon_8` | 27.3 km | **40.0** (+~3) | 78.4 | 35.4 steps ⚠ ms unknown |

2.18 ms sits inside the 2.06–2.96 ms ceiling claimed in §1e, derived independently. ✅

⚠⚠ **The step count does NOT fall in proportion to the chord, and this is the trap.** Clipping
`[tEnter, tExit]` shortens `slabLen`, which feeds
`lodCap = max(1, slabLen / (dtSkip · uLodMinSamples))`, which sets the step size. At
`earth_8` the chord falls **5.2×** (7.35 → 1.42 km) but `lodCap` falls **1.84 → 1.00**, so
the step *shrinks* from 184 m to 100 m and the count falls only **3.7×** (53.2 → 14.2). Any
implementation that clips the slab must decide deliberately what `uLodMinSamples` means on a
clipped slab — it is "minimum samples through the slab", and a clipped slab honestly needs
fewer. Getting this wrong turns a 2.18 ms win into roughly half of one.

---

## 3. 🔑 The finding that reshapes the plan: nadir rays are ONE column

Both taps in the march are indexed by **direction**, so radial motion projects out and the
sampled point sweeps an arc of `Rg · sweep`, with `sweep ≈ slabLen · b / r²` (b = impact
parameter):

| pose | weather texels crossed (2k map) |
|---|---|
| `earth_8`, centre pixel | **0.00** |
| `earth_8`, frame edge | **0.27** |
| `earth_horizon_8` | **16.33** |

⇒ **At `earth_8` the entire ray, across the whole frame, stays inside one weather texel.**
One tap before the loop yields `coverage`, `topHeight` → `topAlt` → `columnBaseN` → the
altitude envelope for the *whole ray*. Clipping the march to that envelope needs **no
pyramid, no bake, no new texture, and costs one tap per ray instead of ~53.**

The pyramid is only needed where the sweep exceeds a texel — which is exactly where a
single tap would be *wrong* rather than merely loose.

---

## 3b. ❌❌ PHASE 1 IS DEAD — killed 2026-09-08 before any shader was written

It fails its own kill criterion (<0.8 ms) by 2–3×, and the reason kills part of Phase 2 too.

🔑🔑 **THE TOP-ALTITUDE FIELD VARIES ±6 km ON A 488 m HORIZONTAL SCALE.**
`jitterTopAlt` (cloudShared.ts:182) adds `(mesoG − 0.5) · TOPALT_JITTER_AMOUNT · conv` with
`TOPALT_JITTER_AMOUNT = 0.8`, i.e. **±0.4 in alt01 = ±6.0 km** over a 15 km band — and
`mesoG` comes from `mesoTap`, whose texels are **488 m of arc**. `deriveColumnV2` then adds
up to `TURRET_RISE = 0.3` = **+4.5 km** more.

⇒ **A conservative bound over any footprint is nearly the band ceiling:**

| map B | `topAlt` evaluated | conservatively bounded | band ceiling |
|---|---|---|---|
| 0.0 | 2.30 km | **12.80 km** | 16.00 |
| 0.5 | 7.83 km | **14.84 km** | 16.00 |

⚠ **And even a PERFECT, non-conservative clip barely helps at `earth_8`.** With the camera
at 8 km and the envelope at [1.65, 7.83] km, the 7.00 km chord clips to **6.18 km — 12%
saved, ≈0.39 ms** — because the camera sits just *above* the cloud top, so the chord is
already almost entirely inside the altitude envelope.

| variant | saving | verdict |
|---|---|---|
| conservative `[base, topMax]` clip | **0.29 ms** | ❌ fails (<0.8) |
| perfect evaluated `[base, top]` clip | **0.39 ms** | ❌ fails |

🔑🔑 **THE ROOT MISTAKE IN THE SCOPE: I equated "80.6% skippable" with "clippable by
altitude envelope". It is not.** The measured `profile > 0.01` band is **1.42 km** of the
chord while `[base, top]` spans **6.18 km** — the profile interval is **4.4× narrower**,
because `heightProfile` tapers *inside* the envelope. `profile = coverage · heightProfile`,
and on a one-column nadir ray coverage is constant, so what makes 80% of the chord skippable
is the **profile taper**, not the envelope. Clipping to `[base, top]` misses it entirely.

⚠ **This also damages Phase 2.** A min/max pyramid over the weather map must bound the same
±6 km jitter and +4.5 km rise, so its `maxTop` is near the band ceiling almost everywhere
and it would skip almost nothing. **The pyramid inherits the blocker; it does not solve it.**

### What would actually work, and why it is a different (larger) piece of work

Clip to the interval where `coverage · heightProfile > 0.01` — i.e. **invert the height
profile**, not the envelope. `heightProfile` is a LUT (`cloudProfileLUT.ts`), so this needs
either an analytic inverse or a precomputed "first/last altitude above threshold" per
(topAlt, conv, coverage) — a 3D LUT query, or a second channel on the existing profile LUT.

⚠ And it still needs `topAlt`, so it still meets the ±6 km jitter. The only clean escapes:
1. **Gate on convectivity.** At `conv = 0` there is no jitter and no turret rise, so
   `topAlt = topHeightToTopAlt(B)` exactly and the bound is tight. ⚠ Prize unknown — needs
   the weather map's G-channel distribution measured, which nothing has done.
2. **Bake the jitter into the map.** If `mesoG`'s contribution to `topAlt` were resolved at
   bake time into a per-texel min/max, the pyramid becomes tight. That is a real design, and
   it is what Nubis³ actually does — its distance field is built over **height data**, not
   over a coverage map with a ±6 km runtime jitter on top.

⇒ **Recommendation: do not build either phase as scoped.** Empty-space skipping in *this*
system is blocked on the topAlt jitter being a runtime, high-frequency, unbounded-in-practice
term. Either resolve it at bake time (option 2, the real fix and the one the references use)
or accept that the 2.18 ms is not reachable by a pre-loop clip.

⚠ The 2.18 ms oracle bound in §2 is still correct — it is just not reachable by an altitude
clip. It remains reachable in principle by anything that knows where `profile > 0.01`.

---

## 4. Phases — ⚠ SUPERSEDED BY §3b, kept for the reasoning

### Phase 1 — per-ray altitude-envelope clip (no pyramid)

**Change.** Before the march loop: tap the weather map once at the ray's mid-chord
direction, derive `[baseAlt, topAlt]` for that column with the *existing* `columnBaseN` and
topAlt derivations, intersect the ray with that altitude shell pair, and clip
`[tEnter, tExit]`. Fall through to today's behaviour when the guard below fails.

**Guard.** Apply only when `slabLen · b / r² < oneWeatherTexelAngle`, i.e. the ray stays
within one column. Cheap: `b = |ro × rd|` is already available or one cross product.

**Dilation.** ⚠ The clip must be conservative against everything that displaces the sample
relative to the envelope:
- `stratJitter × DITHER_FRACTION` — dilate by one dense step.
- `TOPALT_JITTER` and the mesoscale topAlt jitter — dilate by their amplitude. ⚠ Derive it
  from the constants; do not hardcode.
- `TAKRAM_ENVELOPE_WARP` is **false** today, so its displacement is zero — but it is a build
  const, so the dilation must be *computed* from it, not omitted. A future flip must not
  silently start skipping over cloud.
- Detail erosion only ever *removes* cloud, so it needs no dilation.

**`uLodMinSamples` decision.** §2 above: state explicitly whether the clipped slab keeps the
same sample floor (fewer, larger steps) or the same step size (fewer steps). ⚠ Measure both
— the difference is ~2× on the win.

**Gate, with the prediction recorded first:**
```bash
await __bench.run("earth_750")                # thermometer: <15 ms = cold enough
__lum.cloudLod(0); await __bench.run("earth_8")
# then DEBUG_VIZ="stats", reload:
await __lum.cloudIters()                       # at earth_8
```
| prediction | value |
|---|---|
| `earth_8` primary steps | 53.2 → **14–20** |
| `earth_8` frame mean | −**1.8 to −2.2 ms** |
| `earth_horizon_8` | **unchanged** (guard rejects it) — any movement means the guard is wrong |
| `earth_750`, `deep_space` | **unchanged** |
| dense steps | **unchanged at ~6.8** — if they fall, the clip is eating cloud |

**Kill criteria.** `earth_8` frame saving < **0.8 ms**, or dense steps fall by >5%, or
`earth_horizon_8` moves at all.

**Effort.** ~1 day. No new texture, no bake, no async coherence problem.

### Phase 2 — the conservative min/max pyramid

Only for rays the Phase-1 guard rejects (sweep > 1 texel). Do **not** start until Phase 1 is
measured, because Phase 1 sets the remaining prize.

**Representation.** `RG16F` storing `(minBase, maxTop)` per texel, plus `maxCoverage` if a
third channel proves necessary — a texel is skippable when `maxCoverage · maxHeightProfile ≤
0.01` over its whole footprint.

**⚠ Two problems the design must answer explicitly:**
1. **`generateMipmaps` AVERAGES, which is not conservative.** min/max needs a custom
   reduction — follow the `cloudVolumeCompute.ts` compute-bake pattern
   (`createDetailMip1Compute`, `queueCloudBake`).
2. **Equirect poles.** Texels converge in longitude, so a fixed texel footprint is a wildly
   varying metric footprint. Either accept over-conservatism near the poles or use a
   latitude-aware reduction. State which.

**⚠ Async coherence.** `earthClouds.ts:1956` picks the weather map **once at graph-build
time**: the real KTX2 if loaded, else the synthetic `DataTexture`. The comment says the
marcher, far shell and light-volume bake all take the same map "keeping them coherent by
construction". A pyramid is a **second source of truth** — say exactly how it re-bakes when
the real map arrives, and what the frame in between renders.

**⚠ Derivation drift.** `columnBaseN` and the topAlt derivation are TSL. If the bake
duplicates them instead of calling them, the pyramid and the march can disagree — and that
class of drift is already recorded in this repo between the light-volume bake and the
marcher. Call the shared function.

**Injection.** `dtSkipEff = profile > 0.01 ? dtSkipInBand : dtSkipGrown` →
`max(dtSkipGrown, skipDist)`. 🔑 A `max` sits **outside** the
`min(1 + t·LOD_STEP_GROWTH, lodCap)`, so it bypasses the clamp — which is the single most
likely way a correct pyramid still measures as nothing. ⚠ Verify against the second-order
consumers: `dtSkipInBand`, the skip→dense rewind of `dtSkipInBand · 0.5`, and
`emptyStreak`/`EMPTY_THRESHOLD`, all of which may assume a bounded stride.

**Gate.** `earth_horizon_8`: primary steps 78.4 → **40–50**, frame saving to be predicted
from a *horizon-measured* per-step cost (`cloudMarch(false)` at that pose), never from
`earth_8`'s 0.0605.

**Kill criteria.** `earth_horizon_8` saving < 1.0 ms, or `earth_8` regresses (the pyramid
must be inert where Phase 1 already served the ray).

---

## 5. Risks, ranked

| risk | why | mitigation |
|---|---|---|
| **The `lodCap` interaction halves the win** | clipping the slab shrinks the step (§2) | measure both `uLodMinSamples` interpretations in Phase 1 |
| **Skipping over cloud** | jitter + topAlt jitter displace samples | derive every dilation from its constant; gate on dense-step count being unchanged |
| **Temporal instability** | skip distance is discontinuous in direction; the reconstruction has a 4-frame Bayer + EMA, and camera-motion stability is an OPEN complaint (§A4/X6) | check a moving camera, not just a frozen pose, before landing Phase 2 |
| **Pyramid/march disagreement** | duplicated derivations drift | call `columnBaseN`; do not reimplement |
| **Async map swap** | pyramid is a second source of truth | re-bake on arrival; define the in-between frame |
| **Measuring it at all** | thermal spread is 28.6%, and drift of 0.76 ms/3 min has been seen | `earth_750` thermometer before AND after every arm |

---

## 6. What is explicitly NOT in scope

- **Tap hoisting / direction quantisation** — refuted, §1g. The expensive tap (`mesoTap`,
  texture3D, 488 m texels) crosses 9–11 texels at the `earth_8` frame edge and 654 at the
  horizon, so it cannot be hoisted; the hoistable one is the cheap `texture2D`.
- **Further `uLodMinSamples` reduction** — spent. 60 → 40 landed (−0.675 ms); 40 is a
  quality floor set by the author's own visual check, and the dial is inert below ~24.
- **A 3D distance field** — the 2D envelope is the cheap 90% and nothing has yet shown the
  3D version is needed. Revisit only if Phase 2 lands and the residual justifies it.

---

# 5. REVIVAL — the bake-time max-topAlt field (scoped 2026-09-13)

## 5.1 Why the original mechanism was the wrong one

§3b killed an **altitude envelope clip** and a **min/max pyramid over the coverage map**.
Then on 2026-09-13 I proposed a **max-mip of the coverage map** instead. All three are
wrong for the same newly-measured reason:

`__lum.cloudIters()` at three poses, 262,144 marched px each, `uLodMinSamples = 40`:

| pose | empty rays | empty **steps** | primary/ray | dense/ray |
|---|---|---|---|---|
| `earth_8` (looking DOWN) | 6.7% | 6.0% | 53.2 | 6.84 |
| `earth_horizon_8` | 54.9% | **54.1%** | 78.4 | 4.05 |
| `earth_up_8` (looking UP) | **100%** | **100%** | 47.4 | **0** |

🔑🔑 **The discriminator is ALTITUDE, not coverage, and the data proves it with no new
run.** A straight-up ray at `earth_up_8` sweeps ~0 weather texels — it stays inside ONE
column. So the up-ray and the down-ray from the same camera read **the same weather
column**, yet looking down 93% of rays find cloud and looking up **100% find nothing**.
Same coverage, opposite result. ⇒ A coverage-based test cannot cull these; only an
altitude test can, and that is what the ±6 km `topAlt` jitter blocks.

## 5.2 Measured prize (cold, `CLOUD_ABLATE_DIAGNOSTIC`, control flat to 9 µs)

Whole cloud pipeline: `earth_8` 16.842 → 11.960 = **4.882 ms (29.0%)**; `earth_horizon_8`
17.649 → 11.513 = **6.136 ms (34.8%)**. Control `earth_750` 13.180 → 13.189 = **−0.009 ms**.
Recon+composite has zero data-dependent control flow and fixed resolution ⇒ ~0.96 ms at
both poses ⇒ **march ≈ 3.93 ms (earth_8) and ≈ 5.18 ms (horizon)**.

| pose | oracle prize = emptyStepFrac × march |
|---|---|
| `earth_8` | 0.24 ms ❌ |
| `earth_horizon_8` | **2.80 ms** ✅ |
| `earth_up_8` | **~3.50 ms** (the entire march) ✅✅ |

## 5.3 ✅ FEASIBILITY CONFIRMED — `topAlt` is a pure function of DIRECTION

Every input, traced 2026-09-13:

- `deriveColumnV2(topHeight01, mesoG, convectivity)` — three scalars, no ray dependence.
- `topHeight01 = wTap.b`, `convectivity = wTap.g` — equirect weather map, indexed by dir.
- `mesoG = texture3D(baseVolume, dirP · uInnerRadius · MESO_SCALE).g` — sampled at a
  **fixed radius**, so radial motion is projected out (the marcher's own comment says so).
- `dirP = pEnv/rEnv` and `TAKRAM_SHAPE = TAKRAM_ENVELOPE_WARP = false`, so `pEnv = p`
  and `dirP` is the true unit direction. No warp.

🔑 **Proof by existence: `deriveColumnV2` is ALREADY evaluated inside two bakes** — the
Beer Shadow Map (`cloudShadowMap.ts:422`) and the light volume — using the identical
`pColumn = dir · uInnerRadius` form. The derivation is not merely bakeable; it is baked.

**Monotonicity** (needed for a conservative max over a footprint), all verified:

| link | form | monotone? |
|---|---|---|
| `topHeightToTopAlt` | `mix(FLOOR, CEIL, clamp(b))` | ✅ in `b` |
| `jitterTopAlt` | `+ (mesoG − 0.5)·0.8·clamp(conv)` | ✅ in `mesoG`; ⚠ in `conv` only when `mesoG > 0.5` |
| `turretMask` | `smoothstep(mesoG)·smoothstep(conv)` | ✅ in both |
| `finalizeTopAlt` | slope 1 then `TOPALT_KNEE_SLOPE = 0.3` | ✅ |

⇒ Conservative bound over a footprint, from four reduced fields (`bMax`, `gMax`,
`convMax`, `convMin`):

```
jitterMax = 0.8 · (gMax − 0.5) · (gMax ≥ 0.5 ? convMax : convMin)
topAltMax = finalizeTopAlt(
              clamp(topHeightToTopAlt(bMax) + jitterMax, FLOOR, CEIL)
              + turretMask(gMax, convMax) · TURRET_RISE )
```

`ANVIL = false` ⇒ `shield = sheet = 0` and `riseMask = turretT`, so the bake is the
simple branch. `TURRETS` and `TOPALT_JITTER` are both **true**, so both terms are live.

## 5.4 The structure — max-mips over EXISTING textures, no new resolution

⚠ The trap to avoid: `mesoTap` texels are **488 m of arc**, so an equirect field that
resolves them would be 82k × 41k. Do not bake one.

🔑 Instead reduce the textures that already exist, in their own parameterisation:

- **3D max-mip of `baseVolume.g`** (128³ → 64³ → …). Sampling level *L* at
  `dir · uInnerRadius · MESO_SCALE` bounds `mesoG` over a `2^L × 488 m` footprint.
- **2D max-mip of `weatherMap.b`, max- and min-mip of `weatherMap.g`.**

⚠ `generateMipmaps` AVERAGES. These need a custom max/min compute reduction — follow
`createDetailMip1Compute` / `queueCloudBake`. The weather map is chosen ONCE at
graph-build time and `uCloudUvOffset` is not animated, so **all of these bake once per
session**, not per frame.

Query **per step, at a level matched to the local step footprint** — not once per ray.
A whole-ray footprint at the horizon is 654 meso texels (level ~9), where `gMax → 1` and
the bound degenerates to the Phase-1 slack. The local step is 100 m–3.7 km ⇒ level 0–3 ⇒
tight. **This is the difference between a per-ray clip (dead, §3b) and hierarchical
skipping (this).**

## 5.5 ✅ The validation invariant, which the denoise lever does not have

A conservative cull is **visually a no-op**: if the bound is correct, nothing that was
rendered stops being rendered. So it has a mechanical control —
**`densePerRay` from `__lum.cloudIters()` must be INVARIANT across the change**
(6.84 at `earth_8`, 4.05 at the horizon, 0 at `earth_up_8`), exactly the control that
validated `LOD_MIN_SAMPLES_NEAR 60 → 40`. Any drop in `densePerRay` = the bound is not
conservative = a bug, not a tradeoff.

## 5.6 Phases, each with a kill gate

**Phase 0 — measure the SLACK (half a day). DO NOT SKIP: this is what §3b skipped.**
Before baking anything, instrument the marcher to compute, per ray, both the true first
altitude where `profile > 0.01` and the bound of §5.3 evaluated from live taps at a
simulated mip level, and report the gap. ⚠ **Kill gate: if the bound's slack removes more
than half the oracle prize (i.e. < 1.4 ms at the horizon), stop here.** Cost so far: zero
bakes, zero textures.

### ✅ Phase 0a RESULT (2026-09-13): PASSED by 2x

`__lum.cloudEnvelope()`, 262,144 marching px per pose, control `inconsistentPx = 0`:

| pose | above top | below base | outside | oracle | **envelopeCapture** |
|---|---|---|---|---|---|
| `earth_8` | 64.5% | 15.3% | 79.8% | 80.5% | **99.1%** |
| `earth_horizon_8` | 87.1% | 4.1% | 91.2% | 91.5% | **99.7%** |
| `earth_up_8` | 100% | 0% | 100% | 100% | **100%** |

🔑🔑 **THIS OVERTURNS §3b's OBJECTION.** §3b argued the envelope is 4.4x wider than the
`profile > 0.01` band (6.18 km vs 1.42 km) and therefore an altitude test would miss most
of the prize. That was a **width** ratio and it does not transfer to **step-count**
capture, which measures 99%. Same class of error as §3b's own root error: a ratio in one
quantity asserted about another.

⚠ The first run returned capture 104.4% — impossible — and its control fired on 77% of px.
`__lum.cloudEnvViol()` isolated it: `violAbove = 0.00%` at ALL THREE poses (the top bound
is exact), and the base term owned 100% of it. Cause: `columnBaseN` collapses to the
constant CONVECTIVE_BASE_N (0.043) while `cloudHeightProfile` derives `(topN -
STRATIFORM_THICKNESS_N).max(0)` inline, which drops BELOW 0.043 once topN < 0.107. Fixed
by extracting `profileBaseN` in cloudShared.ts and testing against it.
🔑 **Two live cloud-base functions disagree** — `columnBaseN` still has two marcher call
sites reporting a base 650 m above where density actually starts on thin low decks.
Flagged as a separate correctness question; see the §5.8 note.

### ✅ Phase 0b RESULT (2026-09-13): PASSED — the decorrelation risk is 1.7%

`__lum.envProbe(d); __lum.cloudEnvSlack()`. Controls: `envProbe(0)` returns retention
exactly 100.0%, and `impossiblePx = 0` on all ten runs (the bound never skips more than
the exact test, as it must not).

| probe radius | ~mip | horizon retention | horizon boundCapture | up_8 retention |
|---|---|---|---|---|
| 0 (exact) | — | 100.0% | 95.3% | 100% |
| 0.5 km | 0 | 100.0% | 95.3% | 100% |
| 1 km | 1 | 99.5% | 94.8% | 100% |
| 2 km | 2 | 99.0% | 94.4% | 100% |
| 4 km | 3 | **98.3%** | 93.7% | **100%** |

🔑🔑 **§5.7 named bMax/gMax decorrelation as "the single thing most likely to kill the
feature". MEASURED: it costs 1.7% at a 4 km footprint, and nothing at all at earth_up_8.**

🔑 WHY THE §3b KILLER EVAPORATED, stated precisely: §3b's ±6 km slack came from not
knowing `mesoG` at all, so it had to bound the jitter by its FULL range (±0.4 alt01).
Resolving `mesoG` at bake time collapses that; the residual slack from taking a max over a
finite footprint is 1.7%. **The jitter was never the obstacle — not resolving it was.**

⇒ **PHASE 0 PASSED ON BOTH SUB-GATES. Phase 1 is cleared to start.**

### Prize, bounded from both ends

At `earth_horizon_8` a conservative bound proves **86.5% of steps** empty (march 5.18 ms);
at `earth_up_8`, **100%** (march ~3.50 ms).
⚠ "Provably empty" is NOT "free": a hierarchical skip still spends steps traversing that
space, just far larger ones. So:

| | horizon | up_8 |
|---|---|---|
| conservative end (per-RAY cull, §5.2) | 2.80 ms | 3.50 ms |
| ceiling (empty traversal free) | 4.48 ms | 3.50 ms |

⚠ Do not quote the ceiling as the expected result. Phase 2's step count decides where in
that range it lands, and Phase 3 measures it.

### ⚠ Phase 0b's SWEEP WAS ONLY VALID TO ~1.1 km — a probe-design failure worth keeping

Extending the sweep to 8/16/32/64 km produced retention 100.0 / 97.0 / 96.5 / **97.9%** —
**NON-MONOTONE**, which is impossible: a larger footprint CONTAINS the smaller, so every
max can only rise and retention can only fall. Cause: 4 offset taps land on a RING, not a
disc, so rings at different radii do not nest. Sampling density also fails early — a disc
of radius r holds `π(r/0.488)²` meso texels and the probe takes 5 samples, so
`5/texels >= 0.3` gives **r <= 1.1 km**.
⇒ Only the 0 / 0.5 / 1 km rows were ever valid. **Established: retention 99.5% at ~1 km.**
⇒ Both controls are now in `__lum.cloudEnvSlack()` (density warning + monotonicity error).
🔑 Lesson: a probe whose validity degrades with the parameter being swept needs a control
ON THAT PARAMETER. The monotonicity property was available for free and would have caught
it on the first row.

### 🔑 TWO FACTS THAT SHRANK PHASE 1

1. **The weather map is 2048x1024 equirect = 19.6 km/texel; the meso field is 488 m/texel
   — 40x finer.** For any footprint below ~20 km the weather map contributes no footprint
   variation (the footprint fits inside one texel), so a 2x2 max of the four texels
   bilinear touches is exact and free. ⇒ **No 2D weather bake is needed at all.**
2. Retention is flat from 0 to 1 km (100.0 → 99.5%). ⇒ **One level, not a pyramid.**

### ✅ Phase 1a DONE (2026-09-13) — `createMesoMaxMip1Compute`

`cloudVolumeCompute.ts`: 128³ → 64³ COMPONENTWISE MAX of the base volume, the repo's first
max-reduction (every other one — `createDetailMip1Compute`, `downsample3DRGBA`,
`glarePass`, `exposureMeter` — is an average). Mirrors `createDetailMip1Compute`'s
read-reduce-store shape.
- 🔑 **Exact in BYTE space**: each sample is rounded back to the stored byte, the max is
  taken over bytes, and `/255` re-quantises to exactly that byte. A float max followed by
  re-quantisation could round DOWN and break conservatism by 1 LSB.
- ⚠⚠ **NearestFilter, and it is LOAD-BEARING** (every other storage texture here is
  Linear): interpolating between two block maxima returns a value BELOW one of them,
  which destroys the bound.
- One output voxel bounds a ~976 m footprint — exactly the radius measured at 99.5%.
- ⚠ Queued AFTER the base volume; dispatch order is the only ordering guarantee.
- **Not yet wired in**: `getGpuMesoMaxMip1()` has no callers, so the singleton is never
  created and the game path is byte-identical. Wiring is Phase 1b.

**GATE — `/dev/cloud-volume-gpu`** now bakes it and checks two things with an INDEPENDENT
CPU implementation (`cpuMaxDownsample`, deliberately not shared with the kernel):
exact equality over all 262,144 voxels, AND `countNonConservative` = 0 over all 8.4 M
child comparisons. The page prints PASS/FAIL. ⚠ A tolerance would be wrong here: unlike
the averages, this has a hard correctness property, because the marcher will step through
anything it under-reports.

**GATE RESULT (2026-09-13): ✅ PASS.** max|Δ| = **0** on all four channels, mean|Δ|
0.0000, CPU mean == GPU mean to every printed digit, and **0 of 8,388,608** child
comparisons non-conservative. Bake 2.8 ms, one-shot at startup.

⚠ It FAILED on the first run with a uniform +0.5 LSB (mean|Δ| 0.4997-0.5008, max 1,
0% >1, GPU mean +0.002 on all four channels) — **the reference, not the kernel**. The dev
page has TWO quantisers: `quantize` truncates (`(v*255)|0`) while an rgba8unorm texture
stores `round(v*255)`, which is what the kernel recovers with `floor(s*255+0.5)`. The
reference was maxing different bytes. Fixed with `quantizeRound`.
🔑 The tell that it was an artifact: `nonConservative` was already 0 across 8.4 M
comparisons. If the kernel were under-reporting, that counter fires FIRST — it is the
property the whole feature rests on.
🔑 Methodology, worth keeping: **two quantisers with different rounding sat in one file and
silently changed the verdict.** The averaging rows tolerate ~0.5 LSB so they never
noticed; a max-reduction has a hard correctness property, so it surfaced immediately.

### ✅ Phase 1b DONE + MEASURED (2026-09-13): the TRUE bound retains 99.5%

`gMax` is now ONE NEAREST tap of the baked max-mip (fixed ~976 m footprint); the weather
terms use 4 CORNER taps, which is EXACT for bilinear (a bilinear surface attains its max
over an axis-aligned box at a corner). Both halves are genuine bounds — no sampling.
`uEnvProbeKm` now controls only the WEATHER footprint.

| weather footprint | horizon retention | horizon boundCapture | up_8 |
|---|---|---|---|
| 0 (exact weather) | **99.5%** | 94.7% | 100% |
| 1 km | 99.5% | 94.7% | 100% |
| 5 km | 99.4% | 94.7% | 100% |
| 19 km | 99.3% | 94.6% | 100% |

Monotone ✅, `impossiblePx` 0 ✅.

🔑🔑 **THE MESO BOUND COSTS 0.5%.** `envProbe(0)` isolates it: exact weather + the true
max-mip ⇒ 99.5%. **The ±6 km jitter that killed §3b, once resolved at bake time, costs
half a percent.** That is the entire thesis of §5, measured end to end.
🔑 The weather footprint costs 0.2% across a FULL weather texel (0 → 19 km), confirming
that a 19.6 km/texel map contributes almost nothing to a sub-texel footprint.

⇒ **Composite: the conservative bound reaches 94.7% of the oracle at the horizon and 100%
at earth_up_8.** It skips 86.5% / 100% of all primary steps.
⚠ Still "provably empty", NOT "free" — Phase 2 decides what that converts into.

### ⚠⚠ THE DILATION BUG — a TSL trap that every type check passed

Phase 2's design exposed a hole in Phase 1a: **a single NEAREST tap of a plain 2³
max-reduction bounds the block CONTAINING the sample, so a sample on a block edge has a
guaranteed radius of ZERO.** Fine for Phase 1b's question ("is the ray above this block's
max?"), FATAL for deriving a skip DISTANCE — clouds would pop wherever a ray crossed a
block boundary. Fixed by dilating the reduction with a one-voxel halo ⇒ a guaranteed
`MESO_MAX_RADIUS_KM = 0.488` around any point.

🔑🔑 **The first dilated kernel was WRONG, and nothing but the gate caught it.**
`x`/`y`/`z` come from `instanceIndex`, so they are **uint** nodes: `x.mul(2).add(-1)`
UNDERFLOWS to ~4.29e9 instead of wrapping to the far edge. The halo taps read garbage or
collapsed onto duplicates, so the GPU maxed over a SMALLER set than the CPU and
**under-reported** — max|Δ| 114 LSB, 5,562,808 non-conservative comparisons, GPU mean
below CPU mean on every channel, and `impossiblePx` = 170 flagged it independently from
the marcher side. `tsc` was clean, the shader compiled, the game rendered.
⇒ **Apply neighbourhood offsets in FLOAT**, where -1 is a real negative and
RepeatWrapping does the rest.
⚠ A tolerance-based check would have PASSED this. The averaging rows on that page tolerate
~0.5 LSB; this was off by up to 114. An exactly-valued kernel needs an exact gate.

**GATE RE-RUN: ✅ PASS** — max|Δ| 0, **0 of 67,108,864** child comparisons non-conservative.
**Retention with the dilated bound: 98.5% (horizon), 100% (up_8)**; `impossiblePx` 0.
Dilation cost exactly **1.0 point** (99.5 → 98.5), so the tighter-but-8x-larger 128³
variant was not needed.

### ✅ Phase 2 IMPLEMENTED (2026-09-13) — awaiting in-game verification

Injected at the `dtSkipEff` site in `earthClouds.ts`. Per step:
1. `topBound = topAltBoundFromMaxima(bMax, gMax, cMax, cMin)` — `gMax` from ONE NEAREST
   tap of the dilated max-mip; the weather terms from **4 corner taps offset in UV SPACE**
   (zero extra atan/acos — re-projecting 4 directions would triple the per-step
   transcendentals; bilinear attains its box max at a corner, so it is exact).
2. If `altitude01 > topBound`, advance by `min(dtDescend, dtFoot)`:
   - `dtDescend` — closed-form sphere intersection with `rBound`; when the ray never
     descends (`bp >= 0` or `disc <= 0`) it is `tExit - t`, i.e. the whole remaining slab.
   - `dtFoot` — the radius ONE tap actually bounds, divided by the fraction of the step
     that sweeps ARC (~0 straight up ⇒ unbounded reach; ~1 at the horizon).
⚠ `t.addAssign(dtThis.max(emptySkipDist))` — the `max` deliberately sits OUTSIDE
`min(growth, lodCap)`, the exact bypass §3b warned about. Sound HERE only because lodCap
is a sampling-QUALITY floor for space that MIGHT hold cloud while this distance is a PROOF
that it does not. **Never widen that max to anything not derived from a validated bound.**

**Runtime toggle `__lum.cloudSkip(bool)`** (uniform, no reload) for the Phase 3 ablation.
✅ **INVARIANT:** the two arms must render the SAME IMAGE ⇒ `densePerRay` must be
**6.84 / 4.05 / 0**. Any drop = the bound leaks = a bug, not a tradeoff.
⚠ Cost: 5 extra taps/step (1 max-mip + 4 weather). Net = (far fewer steps) x (dearer
steps); only a frame-mean A/B settles it.

### ✅✅ Phase 3 FINAL (2026-09-14, WITH the ring dither): 0.9-2.5 ms, ZERO quality cost

`__lum.cloudSkip(false/true)` via `__bench.runMany`, frame MEANS, all settled,
bimodality <= 1.009. **These are the shippable numbers** — they include the altitude-lerped
ring dither. (A pre-dither run read −2.05 / −1.68 / −2.75; it is superseded and optimistic.)

| pose | skip OFF | skip ON | **Δ** | fps |
|---|---|---|---|---|
| `earth_750` (CONTROL) | 13.484 | 13.523 | **+0.040** ✅ | — |
| `earth_8` | 18.916 | 17.338 | **−1.58 ms** (−8.3%) | 52.9 → 57.7 |
| `earth_horizon_8` | 20.268 | 19.329 | **−0.94 ms** (−4.6%) | 49.3 → 51.7 |
| `earth_up_8` | 16.530 | 14.052 | **−2.48 ms** (−15.0%) | 60.5 → **71.2** |
| `earth_250` | 16.919 | 16.900 | **−0.02 ms** | NEUTRAL |

🔑 **WHY `earth_250` IS NEUTRAL, and it is not the dither.** `tEnter = tOuterNear`, so the
march NEVER traverses the empty ~234 km approach — it starts at the outer shell and covers
only ~15 km of in-band chord. There is no long empty run to skip. (The rings appeared there
because within that short band the ray is often above `topAlt` and `dtFoot` caps hard: a
short march with many capped segments is the worst artifact-per-benefit ratio.)
✅ NEUTRAL, NOT NEGATIVE: `t.addAssign(dtThis.max(emptySkipDist))` takes the MAX, so the
skip can never shorten a step — it costs its 5 taps and recovers about the same.

⚠ **WHAT THE RING FIX COST, and it is structural.** The horizon fell −1.68 → −0.94 even
though `earth_horizon_8` sits at 8 km where the ramp gives j = 0.25 (not 0.5), so a ~12%
reach cost cannot explain a 44% drop. The rest comes from making the dither RAY-INVARIANT,
which is exactly what killed the banding: with a constant per-ray scale `s`, crossing a gap
takes `D/(s·dtFoot)` skips, and **E[1/s] > 1/E[s]** (Jensen). The same MEAN shortening costs
more STEPS when the factor is constant along a ray than when it varies per step.

### FOLLOW-UPS, both answered 2026-09-14

**1. Dither only the FINAL skip — ❌ REFUTED ON QUALITY, but it priced the ring fix.**
`__lum.cloudSkipJitterFinal(true)`. Faster on every pose (control +0.084, all settled,
bimodality <= 1.002):

| pose | dither EVERY skip (shipped) | FINAL only | difference |
|---|---|---|---|
| earth_8 | −1.58 | −1.93 | +0.35 |
| earth_horizon_8 | −0.94 | **−1.85** | **+0.91** |
| earth_up_8 | −2.48 | −2.97 | +0.49 |

…and the rings come back CLEARLY. ⇒ shipped stays `false`.
🔑 WHY THE HYPOTHESIS WAS WRONG, and it is worth keeping: I argued intermediate skips
traverse provably empty space so their landing points cannot alias anything. True for
DENSITY, false for the ARTIFACT — the rings are the COUNT of capped segments,
`ceil(distance·perp/R)`, and leaving intermediates deterministic leaves that count
deterministic. Dithering the last skip randomizes where stepping RESUMES, not how many
boundaries the ray crossed to get there.
✅ **0.91 ms at the worst pose is now a measured price tag on the ring fix.** A STRUCTURAL
fix (removing the quantization) can claim it; more dither never will.

**2. Above 250 km — NEUTRAL, no altitude gate.** Clean run, bimodality ~1.00, settled:
earth_750 (control) 13.374 → 13.288 (−0.086), earth_650 15.194 → 15.114 (−0.080),
earth_250 16.680 → 16.648 (−0.032).
⚠ **Both deltas are SMALLER than the control's own drift** — indistinguishable from zero,
which is the resolution limit rather than a measurement of "slightly positive". The skip
costs nothing up there (the `max()` can never shorten a step), so a gate would buy a
rounding error and cost a branch. Leave it.

⚠⚠ (SUPERSEDED — the earlier attempt at this was VOID.) A 650/750 A/B was attempted 2026-09-14 and its
skip-ON arm was VOID: `settled: false`, bimodality **1.700 / 1.824**, and `1b beer shadow
map` jumped 0.96 → 2.26 ms — a pass this dial cannot touch. Re-run before concluding
anything about an altitude gate. (The OFF arm was clean: earth_750 13.681, earth_650 15.549.)

Primary steps: 53.2 → **26.6** (earth_8), 78.4 → **56.4** (horizon), 47.4 → **9.4** (up_8).
✅ INVARIANT HELD: `densePerRay` 6.842 / 4.065 / 0 against a 6.839 / 4.047 / 0 baseline —
no drop, so the bound does not leak. User confirmed the image is unchanged.
⚠ The arms ran 7 min apart; the CONTROL rules out a thermal flatter (earth_750 came back
0.02 ms SLOWER with the skip on). This is exactly what the control is for.
⇒ Captured **60% of the §5.2 oracle at the horizon, 79% looking up**; the gap is the 5
extra taps per step.

### ⚠ THE RING ARTIFACT AND ITS FIX (2026-09-14)

Concentric rings FIXED TO SCREEN POSITION, appearing 6785 → 6380 km from Earth's centre,
strongest while flying down, gone by ~6400 km. Only with the skip on.
🔑 Cause: `dtDescend` is PURE GEOMETRY, so every pixel at the same iso-distance lands on
the SAME surface, and the stepping that resumes is phase-locked to it — the per-pixel STBN
entry dither no longer decorrelates it. Same family as the "miss-rings" that dither was
originally added to fix (see the STBN block in earthClouds.ts).
⇒ Fix: `uSkipJitter` (default 0.5) multiplies the skip by `1 - j*stratJitter`.
✅ Safe by construction — it can only SHORTEN a skip, and shorter is always conservative.
⚠ Costs ~j/2 of the skip's average reach, so tune `__lum.cloudSkipJitter(f)` to the
SMALLEST f that clears the rings, judged WHILE MOVING (stationary hides it behind the EMA).

### ✅ THE RING ARTIFACT, DIAGNOSED AND FIXED (2026-09-14)

**Cause: the `dtFoot` clamp.** Empty space is traversed in `ceil(distance·perp / R)`
footprint-capped skips, and `perp` depends only on the view ray's ANGLE ⇒ the integer
boundaries are SCREEN-FIXED concentric rings. Confirmed by `__lum.cloudSkipFoot`: shrinking
R moved the rings toward screen centre and tightened their spacing (f=1 spread, f=0.5
concentrated, f=0.01 gone) — the signature of an integer boundary in `distance·perp/(f·R)`,
and it ruled out both the landing point and the NEAREST-quantized bound.
🔑 The decisive clue was that the rings are fixed to the SCREEN while the clouds move past.
Only a function of view-ray ANGLE can do that; a world-space cause would stick to the
clouds.

**🔑🔑 THE FIX THAT MATTERED: jitter with `dither`, NOT `stratJitter`.**
My first attempt used `stratJitter = fract(dither + primaryIters·φ⁻¹)` — a golden-ratio
additive recurrence, i.e. a LOW-DISCREPANCY sequence. Its defining property is **low
variance when summed**, which is ideal for integrating density and exactly wrong here: the
CUMULATIVE skip distance converges to its mean, so the ring boundaries do not move however
hard each individual step is jittered. Measured: still visible at j = 1.0, which already
costs ~50% of the skip's reach.
⇒ `dither` (the raw per-pixel STBN tap, loop-INVARIANT) scales each ray's whole footprint
grid by a per-pixel amount, so neighbouring pixels put ring n at different radii and the
bands break into blue noise the reconstruction EMA removes. It varies per frame too.
⚠ LESSON: **never use a low-discrepancy sequence to break a CUMULATIVE quantization.**
Its whole purpose is to not vary cumulatively. It fails silently — the artifact just
refuses to spread rather than erroring.

**Altitude-adaptive, because the requirement is:** 0.25 suffices low, 0.5 is needed high.
The number of footprint-capped skips before the deck scales with the DISTANCE to the cloud
band, i.e. with altitude ⇒ more boundaries to break. Shipped as a CPU lerp in
`cloudFullscreenPass` (0.25 at/below 30 km → 0.50 at/above 250 km), same shape as
`uLodMinSamples`. `__lum.cloudSkipJitter(f)` overrides; negative restores the lerp.
⚠ The dither costs ~j/2 of the skip's reach and the skip is worth MOST at altitude, which
is why this ramps rather than pinning 0.5 everywhere.
✅ The Phase 3 table above has been RE-MEASURED with the dither live; those are the
shippable numbers.

**Phase 1 — the max/min reductions (≈1 day).** 3D max-mip of `baseVolume.g`; 2D max-mip
of `weatherMap.b`; max/min-mip of `weatherMap.g`. Verify against a CPU reference on a
small window. No marcher change yet. ⚠ Gate: reductions must be exactly conservative
(`reduced ≥ max(children)`), checked numerically, not by eye.

**Phase 2 — the per-step query and skip (1–2 days).** Inject at the existing
`dtSkipEff` site (`earthClouds.ts:4495`). ⚠ Note from §3b that a `max(...)` there sits
OUTSIDE the `min(growth, lodCap)` clamp, and check the second-order consumers
(`dtSkipInBand`, the skip→dense rewind of `dtSkipInBand · 0.5`, `emptyStreak`).
⚠ Gate: `densePerRay` invariant per §5.5, and `earth_750` still flat.

**Phase 3 — measure.** `CLOUD_ABLATE_DIAGNOSTIC` A/B at all three poses, cold,
`earth_750` as control. Report against the 5.2 oracle.

## 5.7 Risks, stated up front

- ⚠ The bound uses `bMax` and `gMax` **independently**, but they are correlated in the
  real field. The bound stays valid (conservative) and gets looser by the decorrelation.
  Phase 0 measures exactly this; it is the single thing most likely to kill the feature.
- ⚠ `earth_up_8` has the camera at 8 km against a ~7.8 km deck — a **200 m margin**. The
  cull is robust anyway because it is per-segment, not per-frame, but do not tune against
  that pose alone.
- ⚠ Equirect poles: texels converge in longitude, so a fixed texel footprint is a wildly
  varying metric footprint. The mip-level selection must use metric arc, not texels.
- ⚠ At `earth_8` the prize is 0.24 ms. This feature does **nothing** for the nadir pose;
  it is a horizon-and-above-deck lever. Do not expect it to move the `earth_8` row.
- Per `CLAUDE.md` boundaries: this adds a compute bake and new textures on the existing
  bake path. It is **not** a new rendering pipeline and adds **no dependency**, and it is
  a pure-perf change with a zero-quality-loss invariant (§5.5).
