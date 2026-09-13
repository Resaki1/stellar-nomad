# Cloud empty-space skipping — scope

Status: ❌ **BOTH PHASES KILLED IN SCOPING, 2026-09-08, before any shader was written.**
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
