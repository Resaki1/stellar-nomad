# Performance Measurement

How to get numbers you can act on, instead of eye-balling an FPS counter.

Companion to `VOLUMETRIC_CLOUDS_PERF.md` (which is about *what* to optimise).
This doc is about *how to know*.

---

## TL;DR

```
Settings → Dev → "perf profiler (reload)"   →  reload the page
```

Then either read the HUD in the top-left corner, or in the console:

```js
__bench.list()                  // available scenarios
await __bench.sweep()           // measure all of them, prints two tables
await __bench.run("earth_650")  // measure one
__bench.warp("earth_8")         // just fly there and look
__bench.report()                // print live per-pass timings, no warping
__bench.lastJson                // full result as JSON — copy this to share
```

Or from **Settings → Dev**, no console needed:
- **warp to body** — any body + an altitude above its surface. Uses the same
  `resolveScenario` math the benchmark does, so what you eyeball is what gets
  measured.
- **perf scenario** — pick a named scenario, then *warp* to it or *measure* just
  that one (~30 s, vs ~2 min for a full sweep).
- **run perf sweep** — the whole ladder.

All of these close the settings menu first, because `settingsIsOpenAtom` sets
`frameloop="never"` — with the menu open there are no frames to measure and a warp
sits unconsumed.

A sweep takes roughly `14 scenarios × ~550 frames` ≈ 2 minutes at 60 fps.
Don't touch the mouse or keyboard while it runs.

### ⚠ Reload before a sweep you intend to compare

`CelestialBody`'s LOD latch only ever *loads* tiers — it never unloads them. So
wherever you flew before a sweep leaves its textures resident for the whole run.
MEASURED: a sweep started near Saturn read **8–23% higher on `1 scaled scene`** at
Earth than the same build started near Earth, with *identical* draw calls and
triangle counts — so it is residency, not extra geometry. Flying away does not undo
it; only a page reload does.

Every report now records `env.startedFrom` (body, altitude, and resident
texture/geometry counts) and prints it as a header, and each scenario row carries a
`tex` column. **Two runs are only comparable when those match.**

---

## 1. How the industry does this

Rendering perf work is measurement-first everywhere, and the toolchain has four
distinct layers. It is worth knowing which layer answers which question, because
reaching for the wrong one wastes days.

| Layer | Question it answers | AAA tool | Ours |
|---|---|---|---|
| **Per-pass GPU timers** | Which pass got slower? | Unreal `stat gpu` / GPU Visualizer; D3D12 / Vulkan timestamp queries | three.js WebGPU timestamp queries → `space/perf/perfProfiler.ts` |
| **Frame capture** | Why is *this draw* slow? (occupancy, bandwidth, shader stalls) | RenderDoc, PIX, **Xcode Metal Frame Debugger** | Xcode Metal capture on Chromium's GPU process; `MTL_HUD_ENABLED=1` |
| **CPU sampling + frame markers** | Are we even GPU-bound? | Tracy, Optick, Superluminal, Instruments | Chrome DevTools Performance panel; our `cpuTotalMs` |
| **Automated perf runs** | Did we regress since Tuesday? | fixed camera flythroughs in CI with per-pass budgets | `__bench.sweep()` over a fixed scenario ladder |

Four conventions from that world that this harness deliberately copies:

1. **Percentiles of frame time, never mean FPS.** FPS is a reciprocal, so
   averaging it is mathematically wrong and hides hitches. Everything here
   reports **p50 / p95 / p99 in milliseconds**; the single `fps` field is derived
   from p50 purely for human comfort.
2. **Named GPU scopes.** Every pass carries a label so the profile reads like the
   frame, not like a list of anonymous draws. We get this by naming every
   `THREE.Scene` and compute node — three's inspector reports each render context
   under its scene's name.
3. **A fixed, repeatable scenario.** A benchmark you can't re-run is an anecdote.
   Ours teleports to a fixed pose, waits for the temporal accumulators to settle,
   then measures a fixed frame count.
4. **Budgets per pass, not just per frame.** 120 fps means the *whole* frame fits
   in 8.3 ms. Reference points: Nubis clouds ~2 ms on PS4; Frostbite's cloud
   shadow map is a single 512² pass. If our cloud marcher reads 9 ms, that is the
   number to argue with — not the FPS.

### The one thing timestamp queries cannot do

They stop at pass boundaries. Nothing tells you which *line* of the cloud
marcher costs 9 ms. For that, the standard techniques are:

- **Ablation.** Flip a compile-time flag, re-run the same scenario, diff.
  The cloud system is full of these already: `USE_LIGHT_VOLUME`,
  `DETAIL_SELFSHADOW`, `CONE_SAMPLE_CARVE`, `MULTI_OCTAVE_SHAPE`,
  `CLOUD_DENOISE_RADIUS`, `GODRAYS`.
- **Resolution scaling.** Halve `CLOUD_MAX_DPR` (`SpaceRenderer.tsx`). If the
  pass time halves, it is **fragment-bound** — the fix is fewer pixels or fewer
  samples per pixel. If it barely moves, it is bound by something per-draw or by
  a fixed-cost dependency, and shrinking resolution will never help.
- **Sample-count scaling.** Change `uLodMinSamples` (via `LOD_MIN_SAMPLES_NEAR/FAR`
  in `earthClouds.ts`). Linear response = march-bound; flat = texture-fetch-bound.
- **Texture-fetch ablation.** Replace a 3D noise tap with a constant. If the pass
  time collapses, you are bandwidth/cache-bound, and the lever is mip selection
  and cache locality, not ALU.

Do these one at a time, against the same scenario id, and write the numbers down.

---

## 2. What the harness measures

### Per-pass GPU time

`new WebGPURenderer({ trackTimestamp: true })` makes three write a GPU timestamp
pair around every render pass and compute dispatch. `RendererInspector`
(shipped in `three/addons`) resolves them a frame or two later and reports
`{ name, cpu, gpu }` per pass; `PerfInspector` in
`src/components/space/perf/perfProfiler.ts` subclasses it and drains the numbers
into ring buffers.

Pass labels come from `PASS` in that file, assigned to `scene.name` /
`computeNode.name` at each pass's construction site. The frame, in order:

| Label | What | Gate |
|---|---|---|
| `1a atmo LUT bake` | transmittance 256×64 + multi-scatter 32×32 | one-shot per body |
| `1 scaled scene` | planets, skybox, stars — full DPR | always |
| `1b beer shadow map` | 3 passes at 512² (bake, blur, ship probe) | altitude < 2000 km |
| `1c AP froxel` | 32³ compute × 24 march steps | altitude < 4000 km |
| `1d sky-view LUT` | 200×256, 30 steps | altitude < 180 km |
| `1.5 atmosphere` | full-DPR scattering march, 32 steps | always |
| `2p noise bake` | 128³ + 64³ + 32³ volume bakes | one-shot at startup |
| `2p light volume` | 256×32×256 compute × 8 sun steps | clouds visible + box moved |
| `2a cloud marcher` | sparse ¼-res MRT marcher, ≤256 steps | altitude < 700 km |
| `2c reconstruction` | full cloud-DPR temporal reconstruct | altitude < 700 km |
| `3 cloud composite` | full DPR, 25 denoise + 9 AP taps/px | altitude < 700 km |
| `4 local scene` | ship, asteroids, VFX | always |
| `5 post (bloom+out)` | RenderPipeline bloom chain + tonemap + blit | always |
| `misc compute` | asteroid tier-batch culling (dispatches an array of nodes, so it has no single name) | belt only |

### CPU time

- `cpuTotalMs` — total JS per frame, measured by two `useFrame` callbacks at
  priority `-1000` and `+1000` (`PerfProbe` in `Scene.tsx`) that bracket every
  other `useFrame`: ship physics, the 14 `CelestialBody` LOD updates, asteroid
  streaming, POI projection, and pass submission.
- `cpuRenderMs` — just `SpaceRenderer`'s submission. `cpuTotalMs − cpuRenderMs`
  is everything else, i.e. the simulation side.

### Reading it

```
frameMs.p50 ≈ gpuTotalMs, and cpuTotalMs is much smaller   →  GPU-bound
frameMs.p50 ≈ cpuTotalMs, and gpuTotalMs is much smaller   →  CPU-bound
frameMs.p50 ≫ both                                         →  stalling somewhere
                                                               else (vsync,
                                                               present, readback)
```

A capped 120 fps reading (`frameMs.p50 ≈ 8.33`) means vsync, not headroom —
compare `gpuTotalMs` to see how much slack there really is.

### ⚠ Per-pass GPU times are not additive when the GPU is saturated

A timestamp pair measures the **wall-clock span of a pass on the GPU timeline**,
and those spans overlap — across passes and across frames in flight. Measured on
an M2 Pro at 1920×1200:

| scenario | frame p50 | Σ per-pass GPU | ratio |
|---|---|---|---|
| `earth_6629` (clouds off, vsync-capped) | 8.30 ms | 5.28 ms | 0.64× — consistent |
| `earth_8` (cloud deck, saturated) | 19.2 ms | 70.4 ms | **3.7× — overlapping** |

So when the GPU has headroom the sums are believable, and when it is saturated
they inflate. `__bench` prints a warning whenever Σ per-pass exceeds the frame
period by >15%.

**What this does and does not invalidate.** It does not invalidate ranking or
deltas: a resolution change moves precisely the resolution-bound passes and leaves
the fixed-size ones untouched (see the specificity check below), and an ablation
that halves a pass still shows up as halved. It does invalidate reading a single
pass's ms against the 8.33 ms frame budget. Use `frameMs` for budget questions and
per-pass numbers for "which pass, and by how much relative to the others".

---

## 3. Why the scenarios are what they are

GPU cost on an Earth approach is dominated by **altitude gates**: module
constants that switch entire passes on as you descend. The scenario ladder in
`space/perf/scenarios.ts` straddles each one (just above / just below), so the
*difference* between two neighbouring scenarios is that gate's cost.

| Altitude | Distance from centre | Gate opens | Source |
|---|---|---|---|
| 35,000 km | 41,371 km | Earth `lod.near` tier mounts | `earth.ts` |
| 4,000 km | 10,371 km | AP froxel bake | `SpaceRenderer.tsx` `FROXEL_BAKE_MAX_ALT_KM` |
| 2,000 km | 8,371 km | Beer Shadow Map (3 passes) | `cloudShadowMap.ts` `BSM_MAX_ALT_KM` |
| 700 km | 7,071 km | **volumetric cloud pipeline** | `earth.ts` `VOLUMETRIC_BLEND_START_ALT_KM` |
| 400 km | 6,771 km | light volume gains weight | `cloudLightVolume.ts` `VOL_FADE_ALT_HI` |
| 250 km | 6,621 km | volumetric blend reaches 1.0 | `earth.ts` `VOLUMETRIC_BLEND_FULL_ALT_KM` |
| 180 km | 6,551 km | Sky-View LUT bake | `atmospherePass.ts` |
| 1–16 km | 6,372–6,387 km | inside the cloud band | `cloudShared.ts` |

**Note this, because it is easy to get wrong:** the eye-balled ladder (120 fps at
19,000 km from centre, <60 fps at 10,000 km, 30 fps at 7,000 km) means most of
the approach regression happens **above** 7,071 km — where the cloud marcher is
skipped entirely (`cloudsVisible = getVolumetricBlend() > 0.001`). Compare
`earth_12629` → `earth_6629` → `earth_4100`: if those already drop, the cost is
the atmosphere pass, the planet surface shader, or CPU. Do not assume clouds.

### What makes it reproducible

The sim has **no time**: planet positions are static constants from `sol.json`,
sun direction is pure geometry, nothing rotates, and `SHIP_MAX_SPEED_KMPS` is 0
so a warped ship does not drift. That leaves four things to control, and the
runner handles all of them:

1. **Pose.** `devTeleportAtom` now carries an optional quaternion and zeroes
   throttle, steering rates, `movementAtom` and the transit drive. Throttle
   matters more than it looks: the chase camera's standoff distance scales with
   `speed.current`, so a non-zero throttle silently changes the framing.
2. **Wall-clock side effects.** `benchModeAtom` suppresses ship-position
   persistence (otherwise a benchmark teleport becomes your next spawn point),
   camera shake, the per-frame `hudInfoAtom` write, and comms messages entering
   the queue.
3. **Temporal accumulators.** The settle phase runs ≥ 300 frames and only ends
   when no recent frame exceeded 3× the median. The measure window is **252
   frames** = `BAYER.length (4) × STBN_FRAME_MODULUS (63)`, the cloud pipeline's
   full temporal cycle — measure a different length and two runs sample a
   different subset of the marcher's jitter. Also covers the ~17-frame
   light-volume crossfade and the ~10-frame reconstruction EMA.
4. **One-shot loads.** The runner waits for the cloud-volume compute bakes
   (`hasPendingCloudBakes()`, a ~150 ms pipeline compile) and the blue-noise
   fetch (`isStbnLoaded()`) before it starts counting.

If a scenario reports `settled: false`, something was still loading or hitching —
the numbers are printed but should not be quoted.

---

## 4. Caveats

- **Chrome may quantise timestamp queries** to 100 µs. If `env.gpuResolutionMs`
  reads `0.1`, every GPU number is rounded to 0.1 ms — still fine for pass-level
  work (passes are 1–15 ms), but if you need finer, enable
  `chrome://flags/#enable-webgpu-developer-features`. Measured in Chromium on an
  M2 Pro it reads **0.0655 ms**, i.e. the raw GPU timer tick with no quantisation,
  so this is usually a non-issue. The report always states which mode it ran in.
- **Some frames get dropped, and that is expected.** three reuses a single
  timestamp query set and resets its write cursor on every resolve, so a slot is
  occasionally read before it has been written for the current frame; the
  duration comes back negative (observed: −3.3e6 ms) or absurd. One bad slot
  invalidates that frame's whole breakdown, so `PerfInspector` discards the frame
  and counts it in `droppedFrames` / the report's `dropped` column. A handful per
  scenario is normal. If `dropped` approaches `frames`, don't trust the row.
- **`meanMs` for one-shot passes is amortised.** `1a atmo LUT bake` and
  `2p noise bake` run once, so their mean over 252 frames is a small fraction of
  their real cost — read `maxMs` for those (measured: the GPU noise bake is
  ~42 ms in a single frame).
- **`triangles` is the *declared* count, not the drawn count.** The asteroid
  instanced batches declare `MAX_INSTANCES_PER_MODEL` (524,288) instances and
  cull on the GPU, so in the belt this counter reads ~4.7e8. Use it to spot
  changes, not as a geometry budget.
- **The profiler is not free.** Timestamp writes at every pass boundary plus a
  per-frame query resolve cost a little. Compare profiled runs to profiled runs;
  don't mix a profiled number with an unprofiled FPS reading.
- **Toggling the setting needs a reload.** `trackTimestamp` allocates the query
  pool when the renderer is constructed and cannot be turned on later. `?perf=1`
  in the URL forces it on from a cold load.
- **`drawCalls` / `triangles` are only meaningful now.** `Scene.tsx` stops the
  renderer's internal animation loop, which used to call `info.reset()` every
  frame; `SpaceRenderer` now does that itself. Before this change those counters
  accumulated for the whole session.
- **Fix the window size.** Any resize recreates every render target and resets
  all temporal history. The report records canvas pixels and DPR; two runs are
  only comparable if those match.

---

## 5. Baseline

Record baselines here so every later change can be stated as a delta. Paste the
scenario table from `__bench.sweep()`, plus `env`, and note the git SHA.

<!--
### <date> — <git sha> — <machine>

env: <canvasPx> @ dpr <n>, gpu timings on, resolution <n> ms

| scenario | alt km | fps | frame p50 | frame p95 | gpu ms | cpu ms | notes |
|---|---|---|---|---|---|---|---|

per-pass GPU ms (mean):

| pass | ... |
|---|---|
-->

### 2026-08-11 — baseline — M2 Pro, Chromium, **2783×1816** px, DPR 1.5, **on mains**

DevTools open (so the canvas is smaller than fullscreen). This supersedes a
2026-08-10 run on battery at 2008×1816; that run agreed on every ratio and every
conclusion, at ~0.8× the absolute cost.

`frame` = p50 ms (ground truth). `trusted` = Σ of the six passes that reconcile
(atmosphere + sky-view + scaled + froxel + local + post). `ratio` = Σ **all**
passes ÷ frame — read this column first (see the warning above).

| scenario | alt km | frame | fps | ratio | **atmo** | **atmo %** | trusted | Δ vs frame |
|---|---|---|---|---|---|---|---|---|
| deep_space | — | 8.30 | 120 | 0.57 | 0.72 | 9% | 4.76 | −3.54 (vsync) |
| belt | 10375 | 8.30 | 120 | 0.87 | 4.40 | 53% | 7.24 | −1.06 (vsync) |
| earth_12629 | 12629 | 8.30 | 120 | 0.76 | 3.72 | 45% | 6.28 | −2.02 (vsync) |
| earth_6629 | 6629 | 10.60 | 94 | 1.01 | **7.69** | **73%** | 10.72 | +0.12 |
| earth_4100 | 4100 | 16.00 | 63 | 1.04 | **13.13** | **82%** | 16.62 | +0.62 |
| earth_3900 | 3900 | 17.00 | 59 | 1.02 | **13.80** | **81%** | 17.29 | +0.29 |
| earth_2100 | 2100 | 25.10 | 40 | 1.04 | **21.83** | **87%** | 26.09 | +0.99 |
| earth_1900 | 1900 | 26.20 | 38 | 1.26 | **22.83** | **87%** | 26.96 | +0.76 |
| earth_750 | 750 | 28.00 | 36 | 1.40 | **24.65** | **88%** | 28.78 | +0.78 |
| earth_650 | 650 | 30.20 | 33 | 3.76 | **24.73** | 82% | 28.85 | −1.35 |
| earth_250 | 250 | 32.10 | 31 | 3.68 | **25.21** | 79% | 29.27 | −2.83 |
| earth_120 | 120 | 34.00 | 29 | 3.84 | **25.59** | 75% | 34.09 | +0.09 |
| earth_30 | 30 | 34.50 | 29 | 3.86 | **25.79** | 75% | 34.46 | −0.04 |
| earth_8 | 8 | 34.10 | 29 | 3.74 | **25.37** | 74% | 33.20 | −0.90 |

**The frame is those six passes**, replicated across three independent runs at
different resolutions and power states — all 11 non-vsync-capped rows reconcile
within 0.1–2.8 ms over a 10→34 ms range. CPU is 2–3 ms everywhere: never the
limit. The four high-ratio passes (beer shadow map, cloud marcher, reconstruction,
composite) report 6–29 ms each and contribute almost nothing.

Gate-straddle Δ on ground-truth frame time — no timestamps involved, which is why
this is the arbiter:

| gate switched on | frame Δ | atmosphere growth | **the gate itself** | it reports |
|---|---|---|---|---|
| AP froxel | +1.00 | +0.67 | **+0.33** | 0.16 ✓ |
| beer shadow map | +1.10 | +1.00 | **+0.10** | 6.16 ✗ |
| **whole cloud pipeline** | +2.20 | +0.08 | **+2.12** | 74.25 ✗ |
| sky-view LUT | +1.90 | +0.38 | **+1.52** | 4.43 ✗ |

### What the references say about this

All three references say the same thing, and it is the opposite of what our main
pass does.

- **Bruneton & Neyret** (`AtmosphereReferences/HAL.md`, §Results): sky colour and
  aerial perspective are "computed with a few texture fetches per pixel (< 10)",
  evaluating the transport equation "in constant time, **without any sampling**".
- **Hillaire / Frostbite** (`AtmosphereReferences/Frostbite.md` §3.5–3.5.1): a
  **full-screen** sky main view is **0.42 ms** on XBox One at 720p; the AP volume
  is 0.05 ms. And explicitly: "Evaluating the scattered luminance using LUTs per
  pixel multiple times when rendering the aerial perspective **on opaque surface
  could be expensive** … To reduce the cost, we evaluate each frame the scattered
  luminance for current view in a low resolution 3D texture fitted on the camera
  frustum (default 32x32 with 16 depth slices)." Note the cost he is avoiding is
  *LUT fetches per pixel* — we are doing a 32-step **march** per pixel instead.
- **Unreal** (`AtmosphereReferences/UnrealEngine.md` §Sky Rendering Options):
  "The sky and aerial perspective is rendered on screen using ray marching.
  **However, doing so for each pixel can be expensive** … That is why the sky is
  evaluated in a few lookup tables (LUTs) at low resolution." `FastSkyViewLUT`
  (sky pixels) and `AerialPerspectiveLUT` ("used to apply aerial perspective **on
  opaque and transparent meshes**") are **on by default**; per-pixel tracing is
  what you get by *disabling* them. And the space case is handled with them on:
  "you can even move seamlessly from the planet's surface through the atmosphere
  to outer space."

Normalising Hillaire's 0.42 ms at 720p (0.92 Mpx) to our 5.05 Mpx gives ~2.3 ms
of equivalent pixel work — on 2013 console hardware. We measure **25 ms**. This is
not a tuning gap, it is an architectural one: the LUTs exist precisely to remove
the per-pixel march, and we bake them (0.16 ms froxel, 4.4 ms sky-view) but then
march anyway for every planet-surface pixel at every altitude, and for every sky
pixel above 150 km.

Levers, in expected-value order:

1. **Apply aerial perspective on the planet surface from the AP froxel** instead of
   marching. This is Hillaire's `FastApplyOnOpaque` and Unreal's default. The
   froxel already exists and costs 0.16 ms; its only consumer today is the cloud
   marcher (`CLOUD_AP_IN_MARCHER`). Needs its depth range extended to cover
   planet-surface distances, and 32³ will not be enough alone at 4,000 km — expect
   to pair it with (2).
2. **Extend the Sky-View LUT crossfade upward.** `SKYVIEW_FULL_ALT_KM = 60` /
   `SKYVIEW_MARCH_ALT_KM = 150` (`atmospherePass.ts`) make it pure march above
   150 km, exactly where the pass costs 13–25 ms. The code's stated reason — the
   lat/long parameterisation degenerates when the planet is a small disk — is real
   but applies at *high* altitude, not across the whole 150–4,000 km band. Unreal
   keeps `FastSkyLUT` on into space.
3. **Half- or quarter-res scattering + bilateral upsample**, if 1 and 2 leave a
   residue. Purely mechanical, no parameterisation risk.
4. **Fewer `MAIN_STEPS`** (32) with better step distribution — last resort, since it
   trades quality where the LUTs would not.

Two measured caveats on the sky-view LUT before touching it: it currently costs
**+1.52 ms of frame time and reduces the atmosphere pass by nothing** (the
`earth_250 → earth_120` straddle), because every scenario here looks *at* the
planet, so sky pixels are a small minority. That is a **gap in the scenario set**,
not proof the feature is useless — add a "looking up from low altitude" scenario
before drawing conclusions about it.

Smaller items:
- **`5 post` is 1.8–3.3 ms** for a 15-context bloom mip chain (visible in
  `env.unlabeledPasses`) — 22–40% of an 8.33 ms budget for a minor effect.
- **`1 scaled scene`** (the planet itself) is only 1.9 ms. The atmosphere post-pass
  costs 13× the planet render it fogs.
- **`belt` is the only CPU-bound scenario**: p50 8.30 but p95 12.3, `cpuTotal` p95
  5.4 — asteroid streaming hitches, unrelated to the above.
- `earth_650` runs the full cloud pipeline at `volumetricBlend = 0.111` — full cost
  for 11% opacity. Free ~2 ms if the `cloudsVisible` threshold is raised.

---

## 6. Optimisation log

One change at a time, each with the scenario rows it is predicted to move. If the
improvement shows up in rows it was **not** predicted to move, something else
changed and the attribution is wrong.

### 2026-08-11 — gate the Beer-Shadow-Map reconstruction on `strength > 0`

`cloudShadowMap.ts` → `cloudShadowCore`. The function ended in
`mix(1, shadowT, edgeFade)` where `edgeFade = smoothstep(…) · strength`, so with
`strength = 0` it always returned exactly 1 — **after** doing a texture fetch and
the full τ reconstruction. `strength` is SpaceRenderer's freshness gate: zero
whenever the BSM was not baked that frame, i.e. above `BSM_MAX_ALT_KM` (2000 km).

The waste, per pixel, on every frame above 2000 km:
- `1.5 atmosphere` — `cloudShadowAtPlanetKm` is called **inside the 32-step
  march** (single tap) → **32 dependent fetches**
- `1 scaled scene` — `cloudShadowAt` is called by the planet surface shader
  (`earth.ts:340`) with the **5-tap** penumbra kernel → **5 fetches**

Now wrapped in `If(strength > 0)`. `strength` is a per-frame uniform, so the
branch is coherent across the whole draw — one side for the entire pass, zero
divergence. Returning 1 directly is also strictly safer than `mix(1, x, 0)`,
which propagates NaN from `x` where `0·NaN = NaN`.

**Zero quality change**: at `strength = 0` the old code's output was already
identically 1. Verified rendering correctly at both ends — high altitude
(gate closed) and inside the cloud band with `clouds froxel bsm skyview lightvol`
all open (gate open, reconstruction still running).

**RESULT — confirmed 2026-08-11 09:32, exactly as predicted.** Canvas grew to
3000×1816 (+7.8% pixels) between runs, so everything below is normalised against
what that pixel increase alone predicts:

| scenario | bsmStrength | `1.5 atmosphere` | frame | fps |
|---|---|---|---|---|
| belt | 0 | **−22.3%** | — (vsync) | 120 |
| earth_12629 | 0 | **−19.5%** | — (vsync) | 120 |
| earth_6629 | 0 | **−22.6%** | **−20.4%** | 94 → **110** |
| earth_4100 | 0 | **−22.1%** | **−20.0%** | 62 → **72** |
| earth_3900 | 0 | **−22.4%** | **−21.4%** | 59 → **69** |
| earth_2100 | 0 | **−22.8%** | **−22.4%** | 40 → **48** |
| earth_1900 | 0.156 | −1.5% | −4.0% | 38 → 37 |
| earth_750 | 1 | +2.3% | −0.3% | 36 → 33 |
| earth_650 | 1 | +1.9% | −1.1% | 33 → 31 |
| earth_250 | 1 | +2.4% | −0.9% | 31 → 29 |
| earth_120 | 1 | +2.3% | −0.7% | 29 → 27 |
| earth_30 | 1 | +1.9% | −0.8% | 29 → 27 |
| earth_8 | 1 | +2.1% | −0.4% | 29 → 27 |

Every `strength = 0` row dropped ~20–23%; every row where the branch is taken is
flat within noise. **Zero leakage into rows it was not predicted to move** — which
is what makes the attribution trustworthy. The residual +2% on taken-branch rows is
the branch itself plus normalisation imprecision. Raw fps *fell* on the taken-branch
rows purely because the canvas got 7.8% bigger; frame time there is flat once
normalised.

Note the `belt` row's raw p50 moved 8.30 → 10.00 while its *mean* stayed 8.34 —
a vsync-capped bimodal distribution (ProMotion switching refresh), not a
regression. In capped scenarios the GPU idles and downclocks, so `deep_space` and
`earth_12629` absolute pass values are not comparable between runs at all.

**Predicted signature** (as written before the run) — from `bsmStrength` in the
2026-08-11 baseline:

| scenario | bsmStrength | prediction |
|---|---|---|
| earth_12629, earth_6629, earth_4100, earth_3900, earth_2100 | 0 | **`1.5 atmosphere` and `1 scaled scene` both drop** |
| earth_1900 | 0.156 | unchanged (branch taken) |
| earth_750, 650, 250, 120, 30, 8 | 1 | unchanged (branch taken) |
| deep_space, belt | 0 | `1 scaled scene` may drop slightly; no atmosphere march to speak of |

The interesting rows are **earth_4100 (16.00 ms) and earth_2100 (25.10 ms)** —
the steepest part of the collapse, and both entirely above the BSM gate.

### 2026-08-11 — gate the ring-shadow term on `uRingOpacity > 0`

`atmospherePass.ts` → `directSunOcclusion`, which runs **once per march step**.
It ended with `earthShadow · (1 − ringOpacityAt(rHit) · hitF)`, and
`ringOpacityAt = uRingOpacity · ringDensityProfile(...)`. `uRingOpacity` is set to
0 every frame for any body without rings (`updateUniforms`), so the factor
collapsed to exactly 1 — but only *after* running the annulus intersection and the
**six-smoothstep** radial density profile. That is ~40 ALU ops × 32 steps × every
ground pixel, for a guaranteed no-op at Earth, Mars, Venus and every moon.

Now wrapped in `If(uRingOpacity > 0)`. Per-frame uniform ⇒ coherent branch. The
branch body is the previous code verbatim, so Saturn (`saturn.ts:223` defines
`rings`) is unchanged.

**Zero quality change** at `uRingOpacity = 0` by the same argument as the BSM gate.
Verified rendering correctly at `earth_8` with all gates open. **Not** visually
verified at Saturn — there is no ringed-body scenario in the harness yet, which is
itself the gap to close (see below).

**Predicted signature** (as written before the run): orthogonal to the BSM gate —
the ring term ran on *every* body, so `1.5 atmosphere` should drop in **all** rows,
including the `strength = 1` rows the BSM gate left flat. Magnitude smaller than the
BSM gate's: ALU, not a dependent texture fetch.

**RESULT — confirmed 2026-08-11 09:51.** Same canvas as the previous run, so no
normalisation needed. The six `strength = 1` rows the BSM gate left flat:

| scenario | `1.5 atmosphere` | frame p50 |
|---|---|---|
| earth_750 | 27.19 → 25.68 (**−5.5%**) | 30.10 → 28.70 |
| earth_650 | 27.18 → 25.69 (**−5.5%**) | 32.20 → 31.00 |
| earth_250 | 27.83 → 26.04 (**−6.4%**) | 34.30 → 32.70 |
| earth_120 | 28.21 → 27.24 (**−3.4%**) | 36.40 → 35.50 |
| earth_30 | 28.34 → 26.23 (**−7.4%**) | 36.90 → 35.30 |
| earth_8 | 27.92 → 25.30 (**−9.4%**) | 36.60 → 34.20 |

Mean **−6.3%** on the previously-flat block; already-fixed rows moved only −1 to
−3.5%. Correct signature, correct relative magnitude.

**Caveat: this run was started near Saturn** and is therefore contaminated —
`1 scaled scene` rose 8–23% (see the reload warning in the TL;DR), and `earth_6629`
and `belt` are outliers. The ring-gate conclusion survives because its signature
sits in a pass the contamination cannot reach (`directSunOcclusion` is in
`atmospherePass`, not the surface shader) and is consistent across six rows — but
per-row precision is degraded. This run is what prompted `env.startedFrom`.

**Ringed path now verified.** Warping to Saturn at 150,000 km via the new dev
control renders rings, planet shadow on the rings, and atmosphere correctly, with
the gate line reading `saturn alt 150000km` — i.e. `uRingOpacity > 0` and the branch
taken. (Note for a future Saturn *scenario*: the shared approach axis puts the rings
near edge-on at first, so a scenario will want its own look direction.)

**Cumulative across both gates**, normalised for canvas: 2,100 km **−23% frame time
(40 → 48 fps)**, 4,100 km −21% (62 → 73 fps), the deck −7%. The atmosphere pass is
still 74–86% of the frame — both wins were dead-work removal, not the architectural
change.

**Add a Saturn scenario** before trusting the ringed path — it is the only branch
here with no test coverage, and the upcoming gas-giant generalisation needs it too.

### 2026-08-11 11:48 — CLEAN BASELINE (both gates) — use this as the reference

First run with `env.startedFrom` recorded: **earth @ 10,375 km alt, 55 textures /
30 geometries resident**, canvas 3000×1816. Both uniform gates in.

| scenario | frame p50 | fps | **atmo** | atmo % | bsm | clouds | tex |
|---|---|---|---|---|---|---|---|
| deep_space | 8.30 | 120 (cap) | 0.99 | 12% | — | — | 55 |
| belt | 6.10 | 164 | 3.05 | 50% | — | — | 55 |
| earth_12629 | 8.30 | 120 (cap) | 2.76 | 33% | — | — | 55 |
| earth_6629 | 8.30 | **120 (cap)** | 5.24 | 63% | — | — | 55 |
| earth_4100 | 11.80 | **85** | 8.99 | 76% | — | — | 55 |
| earth_3900 | 12.30 | **81** | 9.41 | 77% | — | — | 56 |
| earth_2100 | 17.40 | **57** | 14.60 | 84% | — | — | 56 |
| earth_1900 | 23.70 | 42 | 20.95 | 88% | 6.02 | — | 57 |
| earth_750 | 26.10 | 38 | 23.43 | 90% | 10.60 | — | 57 |
| earth_650 | 28.10 | 36 | 23.26 | 83% | 10.63 | 69.3 | 64 |
| earth_250 | 30.40 | 33 | 23.97 | 79% | 12.14 | 72.9 | 64 |
| earth_120 | 32.30 | 31 | 24.26 | 75% | 12.46 | 81.4 | 64 |
| earth_30 | 32.90 | 30 | 24.44 | 74% | 12.87 | 82.9 | 64 |
| earth_8 | 32.60 | 31 | 23.98 | 74% | 11.65 | 79.5 | 64 |

`earth_6629` now sits on the 120 fps vsync cap (was 94). `earth_2100` 40 → 57 fps.
CPU is 1.7–1.9 ms everywhere — never the limit. Atmosphere is **74–90% of frame**.

## ⚠ Run-to-run variance was 5–25% — RESOLVED 2026-08-11 12:35/12:40: it is start state, not noise

**Read the resolution at the end of this section before using any number here.**

The 09:51 and 11:48 runs have **identical shader code** and the same canvas. They
differ only in where the sweep was started (Saturn vs Earth orbit). Yet:

| scenario | atmo 09:51 → 11:48 | frame |
|---|---|---|
| earth_6629 | −24.8% | −19.4% |
| earth_2100 | −17.2% | −16.3% |
| earth_750 | −8.8% | −9.1% |
| earth_8 | −5.2% | −4.7% |

Note the gradient: the effect is **largest where fewest pixels march** and smallest
at the deck where all of them do. That is not what uniform GPU downclocking looks
like. A plausible (UNPROVEN) mechanism: at low marched-pixel counts the pass is
latency-bound rather than throughput-bound, so LUT-fetch cache behaviour dominates,
and another body's resident 8K textures worsen it. At the deck there is enough
parallelism to hide the misses.

**What this invalidates.** A claim made on 2026-08-11 that the ring gate's
signature "sits in a pass the contamination cannot reach" was **wrong** — it reaches
every pass. So the ring gate's −6.3% cannot be cleanly separated from start-state
variance, and neither can the cumulative-vs-original figures below (the original
baseline's start state was never recorded). Treat both as indicative.

**What survives.** *Within-run differential signatures* — "these rows should move,
those should not" — are immune to a global state offset, which is why the BSM gate's
attribution (six rows −20…−23%, six rows flat, zero leakage) still stands.

**Do this before trusting any single-digit-percent result: run the same sweep twice
from the same clean start** (reload, warp nowhere, sweep; reload, warp nowhere,
sweep). That bounds pure variance and tells us whether the 25% above is really
start-state or just noise. Until then, only trust within-run signatures and
changes larger than ~25%.

Indicative cumulative vs the original no-gates baseline, canvas-normalised:
`earth_2100` −36% frame (40 → 57 fps), `earth_4100` −32% (62 → 85), `earth_6629`
−27% (94 → 120, capped), the deck −11%.

### ✅ RESOLUTION — 2026-08-11 12:35 and 12:40, two sweeps from an identical clean start

Protocol used (**this is now the required protocol for any comparable sweep**): warp
to `deep_space`, reload, run the sweep. Both runs report `startedFrom` = no body,
32 textures — i.e. a genuinely empty residency set. Canvas 3000×1816 both times.

`1.5 atmosphere` mean ms, run 1 → run 2:

| scenario | run 1 | run 2 | Δ | | scenario | run 1 | run 2 | Δ |
|---|---|---|---|---|---|---|---|---|
| deep_space | 0.80 | 0.91 | +13.0% ¹ | | earth_1900 | 20.47 | 20.43 | **−0.2%** |
| belt | 3.068 | 3.066 | **−0.1%** | | earth_750 | 23.15 | 23.08 | **−0.3%** |
| earth_12629 | 2.67 | 3.04 | +13.9% ¹ | | earth_650 | 23.17 | 23.39 | **+1.0%** |
| earth_6629 | 5.27 | 5.30 | **+0.7%** | | earth_250 | 23.73 | 23.70 | **−0.1%** |
| earth_4100 | 9.03 | 9.00 | **−0.4%** | | earth_120 | 24.02 | 24.07 | **+0.2%** |
| earth_3900 | 9.46 | 9.55 | **+0.9%** | | earth_30 | 24.20 | 24.25 | **+0.2%** |
| earth_2100 | 14.65 | 14.82 | **+1.2%** | | earth_8 | 23.75 | 23.56 | **−0.8%** |

¹ The only two rows above 1.2% are the two where the atmosphere pass is smallest:
the absolute deltas are **0.10 ms and 0.37 ms**, i.e. 2–6 timestamp quanta
(0.0655 ms). Both rows are also vsync-capped at exactly 8.30 ms frame p50, so
neither affects any decision. Every row that matters agrees within **1.2%**.

Frame p50 agrees within 0.3 ms on all 14 scenarios.

**Conclusions:**

1. **The harness is reproducible to ~1% when the start state is controlled.** Single-
   digit-percent attribution is back on the table. Always reload from `deep_space`.
2. **The 5–25% spread above was caused by start state, not by noise or thermals.**
   These two runs also match the 11:48 *earth-orbit*-start run closely (earth_4100
   85 fps, earth_2100 57, deck 31) — so the outlier is specifically the **09:51
   Saturn-start** run, which was *slower*. Consistent with resident-texture / VRAM
   pressure from another body's 8K set, though the mechanism is still unproven.
3. The retraction above **still stands**: contamination reaches every pass, and the
   ring gate's −6.3% was measured across a start-state boundary so it remains
   indicative. It is now cheaply re-measurable under the clean protocol.

### 2026-08-11 12:35/12:40 — THE BASELINE. Mean of the two clean runs.

| scenario | frame p50 | fps | **atmo ms** | **atmo %** | scaled | post | gpu/frame |
|---|---|---|---|---|---|---|---|
| deep_space | 8.30 | 120 (cap) | 0.85 | 10% | 0.54 | 4.63 ² | 0.78 |
| belt | 6.15 | 163 | 3.07 | 50% | 0.57 | 2.31 | 1.02 |
| earth_12629 | 8.30 | 120 (cap) | 2.86 | 34% | 0.44 | 2.40 ² | 0.73 |
| earth_6629 | 8.30 | 120 (cap) | 5.29 | 64% | 0.63 | 1.98 | 0.98 |
| earth_4100 | 11.80 | 85 | 9.01 | **76%** | 1.00 | 1.97 | 1.04 |
| earth_3900 | 12.40 | 81 | 9.50 | **77%** | 1.10 | 1.93 | 1.04 |
| earth_2100 | 17.60 | 57 | 14.74 | **84%** | 1.41 | 1.95 | 1.05 |
| earth_1900 | 23.20 | 43 | 20.45 | **88%** | 1.61 | 1.85 | 1.28 |
| earth_750 | 25.90 | 39 | 23.11 | **89%** | 1.68 | 1.83 | 1.45 |
| earth_650 | 28.25 | 35 | 23.28 | 82% | 1.72 | 1.84 | 3.84 |
| earth_250 | 30.10 | 33 | 23.71 | 79% | 1.91 | 1.80 | 3.75 |
| earth_120 | 32.30 | 31 | 24.05 | 74% | 1.97 | 1.81 | 3.90 |
| earth_30 | 32.85 | 30 | 24.23 | 74% | 1.98 | 1.80 | 3.93 |
| earth_8 | 32.35 | 31 | 23.65 | 73% | 1.37 | 1.80 | 3.78 |

Rows with `gpu/frame` ≤ 1.05 (**down to and including earth_2100**) are fully
trustworthy per-pass. Below that, use the six-pass subset (which matches frame p50
to ±2.2 ms across the cloud band) or gate-straddle ablation.

² **NEW PROFILER ARTIFACT — the trailing pass absorbs the vsync wait.** `5 post` reads
4.63 ms at `deep_space` and 2.40 at `earth_12629`, but 1.80–1.98 on all eleven other
rows — same canvas, same 15-context bloom chain. The inflation tracks idle time under
the 120 fps cap exactly: deep_space has 8.33 − 6.17 = 2.2 ms idle (post +2.8), 12629
has 2.5 ms idle (+0.5), earth_6629 has 0.2 ms idle (+0.0). **Bloom's real cost is
~1.8–2.0 ms everywhere.** Do not "optimise" it from the deep_space number.

### Gate-straddle Δ on ground-truth frame p50 (mean of both runs)

Independent of timestamps, therefore valid at every altitude:

| gate | straddle | **Δ frame** | Δ atmosphere | what it tells us |
|---|---|---|---|---|
| AP froxel (4000 km) | 4100 → 3900 | **+0.60** | +0.47 | bake 0.12 + what it enables in the march |
| Beer Shadow Map (2000 km) | 2100 → 1900 | **+5.60** | **+5.82** | the cost is the **taps inside the march**, not the bake |
| cloud pipeline (700 km alt) | 750 → 650 | **+2.35** | +0.17 | the whole volumetric cloud system |

The BSM row is the important one. `bsmStrength` goes 0 → 0.156 and the atmosphere
pass alone gains +5.82 ms, which accounts for the entire +5.60 ms frame delta — so
the reported `1b beer shadow map` 5.4–5.6 ms is **phantom**, and the real cost is the
32 dependent shadow fetches per pixel that the `strength > 0` gate opens. (Going
0.156 → 1.0 between 1900 and 750 km adds only +2.7 ms, all of it planet coverage:
once the branch is taken, magnitude is free.) This is the same gate that buys
−20…−23% above 2000 km — below it we still pay in full.

## 7. Next lever, chosen from the baseline above: half-resolution atmosphere

`rtB` is allocated at **full DPR** (`SpaceRenderer.tsx:302-310`, comment says so),
and the march is `MAIN_STEPS = 32` per pixel with ground rays *always* marching
(`atmospherePass.ts:1614`). At 3000×1816 that is 5.45 Mpx × 32 = **174 M step-evals
per frame**, and it saturates at ~23.7 ms from 750 km down once the planet fills the
screen. The clouds got a `CLOUD_MAX_DPR` clamp plus a reconstruction pass; the
atmosphere never did.

### AS BUILT (2026-08-11)

The march no longer produces pixels. It produces **aerial perspective** — in-scattered
radiance in `rgb`, mean transmittance in `a` — into a half-res RGBA16F, and a cheap
full-res pass applies it: `scene·T + L`.

**It costs no extra full-resolution pass.** The old pass was already a full-res
rt → rtB blit that happened to also march. The blit stayed where it was; only the
march moved out of it and into a quarter-of-the-pixels target.

Storing `(L, Tmean)` is not a compromise invented here — it is Hillaire §5.5's own AP
representation, and `getAtmosphereFroxel()` and `getSkyViewLUT()` in this same file
already pack exactly that way (`atmospherePass.ts` `vec4(L, Tmean)`), which is why the
Sky-View crossfade folded in as a straight copy instead of a special case.

Knobs, all in `atmospherePass.ts`:
- `AP_RES_SCALE` (0.5) — 1.0 keeps the split but marches at full res, so it isolates
  the *upsample's* quality cost from the *split's*. Bisect any artefact with this
  before suspecting the split.
- `AP_SPECTRAL_TRANSMITTANCE` (true) — expands the stored mean back to per-channel via
  `T_c = Tmean ^ k_c`, with `k` from the vertical column integral in `setAtmosphere`.
  This is what preserves Rayleigh reddening of distant terrain, which a grey
  transmittance would flatten. Exact at `Tmean = 1` and for a grey atmosphere; error
  grows only with optical depth. `false` = grey (the froxel/sky-view convention).

Why no depth-aware upsample: the march never reads a depth buffer — it finds its
endpoint analytically (`raySphereNearest` against `uBottomRadius`). So there is no
depth discontinuity to respect, and the only edge in the AP field is the **analytic**
limb, across which a bilinear blend of two `(L, T)` pairs is a smooth interpolation
rather than a wrong one.

Projected — atmosphere to ~¼, plus the apply pass appearing as `1.6 atmo apply`
(a 2-tap full-res blit, expect ~0.5–0.8 ms):

| scenario | now | projected frame | projected fps |
|---|---|---|---|
| earth_4100 | 11.80 | ~5.1 | 120 (cap) |
| earth_2100 | 17.60 | ~6.5 | 120 (cap) |
| earth_1900 | 23.20 | ~7.9 | ~120 (cap) |
| earth_8 (deck) | 32.35 | ~14.6 | ~68 |

`deep_space` should be a wash (the march was already ~0.85 ms there, and the blit is
unchanged) — if it *regresses*, the apply pass is costing more than a blit should.

**Verified in-engine before measuring:** compiles with no WGSL errors; Saturn renders
with rings, limb shading, terminator and ring shadow intact (so the ring path and
`uActive` passthrough are fine); Earth at 12,629 km shows the surface through the
atmosphere with the limb glow — which rules out a collapsed transmittance, the failure
mode that would erase the scene. `earth_2100`, the row with 84% atmosphere, renders
correct aerial perspective.

**What still needs the real display + a sweep** (the in-app browser pane runs hidden,
so it cannot sustain a frame loop or read back the WebGPU swapchain):
1. The **analytic-vs-rendered limb** band. The analytic sphere and the rendered planet
   mesh never coincided exactly; at half res that disagreement is ~2 px wider. Look at
   the limb against space at `earth_2100` and `earth_4100`.
2. **Hue/saturation of distant terrain at a low sun** — the one place
   `AP_SPECTRAL_TRANSMITTANCE`'s approximation does real work. Compare the terminator
   at `earth_120` / `earth_8` against the previous build.
3. The numbers. Clean protocol: warp `deep_space` → reload → sweep.

Fallbacks if the limb shows artefacts: `AP_RES_SCALE = 0.707` (half the *area*, not a
quarter) before dropping back; and `SAMPLE_SEGMENT_T` jitter already decorrelates step
positions, so temporal reuse is available if it ever needs to go below 0.5.

### RESULT — 2026-08-11 13:12, clean protocol, no visual issues reported

| scenario | frame p50 | fps | atmo family (ground truth) |
|---|---|---|---|
| deep_space | 8.30 → 8.30 | 120 → 120 (cap) | 0.85 → 1.21 |
| belt | 6.15 → 5.90 | 163 → 169 | 3.07 → 2.82 |
| earth_12629 | 8.30 → 8.30 | 120 → 120 (cap) | capped |
| earth_6629 | 8.30 → 8.30 | 120 → 120 (cap) | capped |
| earth_4100 | 11.80 → **8.30** | 85 → **120 (cap)** | capped |
| earth_3900 | 12.40 → **8.30** | 81 → **120 (cap)** | capped |
| earth_2100 | 17.60 → **8.30** | 57 → **120 (cap)** | capped |
| earth_1900 | 23.20 → **9.70** | 43 → **103** | 20.45 → **6.95** |
| earth_750 | 25.90 → **11.30** | 39 → **88** | 23.11 → **8.51** |
| earth_650 | 28.25 → **13.60** | 35 → **74** | 23.28 → **8.63** |
| earth_250 | 30.10 → **15.70** | 33 → **64** | 23.71 → **9.31** |
| earth_120 | 32.30 → **17.50** | 31 → **57** | 24.05 → **9.25** |
| earth_30 | 32.85 → **18.10** | 30 → **55** | 24.23 → **9.48** |
| earth_8 | 32.35 → **17.80** | 31 → **56** | 23.65 → **9.10** |

Frame time −45% to −58% across the whole band below 4100 km. Everything from 2100 km
up now sits on the 120 fps cap. The atmosphere family fell ~62%.

**⚠ PROFILER ARTIFACT #4 — `1.6 atmo apply` duplicates `1.5 atmosphere`'s window.**
On every GPU-saturated row the two report nearly the same number (9.22 / 9.32 at the
deck) and **`1.5` ALONE equals the ground-truth total of both** — verified against the
frame delta on all 7 uncapped rows, within 0.3 ms. Do not add them. The one clean
measurement of the apply pass is **`deep_space`: 0.72 ms**, where the GPU is idle under
the cap so the spans cannot overlap — and that matches the bandwidth estimate for a
2-tap full-res blit, so 0.72 ms is the apply's real cost at every altitude.

### ⚠ THE MARCH IS NOW LATENCY-BOUND — this changes which levers work

Quartering the pixels did **not** quarter the cost. Backing the apply's 0.72 ms out of
the reported `1.5`:

| scenario | march before | march now | speedup | G step-evals/s before → now |
|---|---|---|---|---|
| earth_1900 | 20.45 | 6.06 | 3.37× | 8.5 → 7.2 |
| earth_750 | 23.11 | 7.78 | 2.97× | 7.5 → 5.6 |
| earth_250 | 23.71 | 8.37 | 2.83× | 7.4 → 5.2 |
| earth_30 | 24.23 | 8.94 | 2.71× | 7.2 → 4.9 |
| earth_8 | 23.65 | 8.50 | 2.78× | 7.4 → 5.1 |

Throughput-bound would be 4.00×. We got 2.7–3.4×, and the per-step-eval *rate got
worse* (7.4 → 5.1 G/s). Fewer pixels in flight = less parallelism to hide the march's
dependent LUT-fetch latency (~2–3 dependent texture fetches per step × 32 steps =
a 64–96-deep chain per pixel).

**This retro-explains the run-to-run variance mystery above.** That gradient was
"largest where FEWEST pixels march" — which is precisely the latency-bound regime,
where cache and fetch behaviour dominate and a neighbouring body's resident textures
can move the number. Same mechanism, two symptoms. The hypothesis recorded there as
unproven now has independent support.

**Consequences for lever choice:**
- Further **resolution** cuts give diminishing returns — another halving would yield
  well under 2×. `AP_RES_SCALE` has given what it has to give.
- What helps a latency-bound shader is a **shorter dependent-fetch chain**: fewer
  steps, or fewer fetches per step. `MAIN_STEPS 32 → 16` halves the chain directly
  and, unlike a resolution cut, does **not** reduce occupancy — so it should scale
  closer to a true 2× than the resolution cut did.

### Budget at `earth_8` (17.80 ms / 56 fps) — where the remaining time goes

Gate-straddle deltas on frame p50, plus the trustworthy per-pass rows:

| item | ms | % frame | how measured |
|---|---|---|---|
| atmosphere family | 9.10 | **51%** | ground truth (frame delta) |
| cloud pipeline | 2.30 | 13% | straddle 750 → 650 (11.30 → 13.60) |
| post (bloom) | 1.81 | 10% | per-pass, unsaturated |
| sky-view LUT | ≤1.80 | 10% | straddle 250 → 120 (15.70 → 17.50) |
| beer shadow map taps | ~1.40 | 8% | straddle 2100 → 1900, floor ≥1.37 |
| scaled scene | 1.36 | 8% | per-pass |
| froxel + local | 0.67 | 4% | per-pass |

Sums to 18.44 against a 17.80 ms frame — the budget closes to 0.6 ms.

Two things worth noting. The **BSM taps fell from +5.60 to ~1.40 ms**, almost exactly
the predicted 5.60/4 — independent confirmation that everything *inside* the march got
the full resolution win. And the **sky-view LUT's reported 4.27 ms is contradicted by
its own straddle (≤1.80, coverage growth included)**, which supports the "reported cost
is 35× too high" suspicion.

### ⚠ HARNESS GAP: the mid band is now unmeasurable

`earth_4100`, `earth_3900`, `earth_2100`, `earth_12629`, `earth_6629` and `deep_space`
all sit at exactly 8.30 ms. **The froxel gate straddle (4100 → 3900) is dead** — both
sides cap — and the BSM straddle only yields a floor. Any further work in that band
needs an off-vsync measurement mode (or a higher-refresh display) before it can be
attributed at all.

**Second lever, after that:** the +5.60 ms of cloud-shadow taps below 2000 km. Tap
every Nth step and interpolate, or fold the shadow term into the AP froxel. Note
this is the same term the god rays need per-step, so it constrains how far it can be
cheapened — see the LUT-safety note below.

**Not a lever:** the volumetric cloud pipeline (2.35 ms of frame time, measured
twice), and bloom (artifact ²).

**Open question, needs one ablation:** `1d sky-view LUT` reports 4.3–4.7 ms for
200×256 texels × 30 steps = 1.5 M step-evals. At the main march's measured rate
(174 M step-evals / 23.7 ms ≈ 7.4 G/s) that should be **~0.2 ms** — it is reporting
**35× too much time per step-eval**. Either the timestamp is capturing a
write→read barrier stall (the main pass samples the LUT in the same frame), or the
bake is doing something unexpected. Gate the bake off for one sweep at `earth_8`
and read frame p50. Do not act on the 4.3 ms until then.

**LUT safety with cloud coupling (answered):** god rays tap the Beer Shadow Map
*per march step* (`shadowedSunScatter` → `cloudShadowAtPlanetKm`, `GODRAYS = true`,
`MS_CLOUD_SHADOW = 0.5`). A LUT parameterised by (altitude, view-zenith,
sun-zenith) cannot represent a term that varies along the ray with the cloud field,
at any resolution. But the BSM only contributes below `BSM_MAX_ALT_KM` = 2000 km:
**above 2000 km there is no coupling to break, so a LUT/froxel path is safe there;
below it the marched path must stay.** The half-res change above is orthogonal — it
preserves the per-step march and so preserves the shafts at every altitude.
