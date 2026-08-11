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

A sweep takes roughly `14 scenarios × ~550 frames` ≈ 2 minutes at 60 fps.
Don't touch the mouse or keyboard while it runs.

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
