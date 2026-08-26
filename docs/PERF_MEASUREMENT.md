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
quarter) before dropping back below 0.5.

**Correction:** an earlier draft of this section claimed `SAMPLE_SEGMENT_T` provides
jitter that decorrelates step positions. It does not — it is a **fixed** 0.3 midpoint
bias (its own comment says "fixed; jitter/adaptive is Phase 4"), and this pass keeps no
temporal history. There is **no dither anywhere in the atmosphere march**, so nothing
masks coarse sampling. That matters for step-count changes, not for resolution ones.

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

### PENDING MEASUREMENT — `USE_SKYVIEW = false`: is the Sky-View LUT still worth having?

Prediction recorded **before** measuring (method: §6 — predict which rows move, treat
leakage as proof the attribution is wrong).

Why this and not a bake-only ablation: the reported 4.3–4.7 ms is not believable
(1.5 M step-evals should be ~0.2 ms at the march's own measured rate — 35× off) and its
straddle bounds it at ≤1.80 ms, so "what does the bake cost" has no trustworthy answer
to improve on. The decision-relevant question is whether the LUT should exist at all,
and **the half-res split changed the trade-off that justified it** — sky-ray marching
is now ~3× cheaper than when the LUT was added. The LUT has exactly one consumer
(`sampleSkyView`), and `USE_SKYVIEW = false` forces `uSkyViewBlend = 1`, a clean
full-march fallback.

`uSkyViewBlend = smoothstep(60, 150, altKm)`, so:

| scenario | alt | blend now | bake? | prediction |
|---|---|---|---|---|
| earth_120 | 120 km | **0.741** | yes | **clearest win** — already ¾ marching yet paying the full bake |
| earth_30 | 30 km | **0.000** | yes | swaps bake for a full sky march — **sign unknown** |
| earth_8 | 8 km | **0.000** | yes | swaps bake for a full sky march — **sign unknown** |
| earth_250 and above | ≥250 km | 1.000 | no (alt > 180) | **must be flat** |
| deep_space, belt | — | — | no | **must be flat** |

Any movement in the 11 flat rows means the attribution is wrong, not that the change
worked.

**Quality points the same way, which is why this is worth doing even at perf parity:**
shafts baked into the 200×256 lattice band the low-altitude sky — a documented KNOWN
LIMITATION with two attempted per-pixel fixes, both reverted. Marching gives crisp
per-pixel shafts. Perf-neutral-or-better ⇒ delete the subsystem and the limitation
with it.

**Scenario-coverage caveat:** every scenario looks *at* the planet, so sky pixels are a
minority in all of them — this sweep systematically **under**-measures both the LUT's
benefit and the march's added cost. Judge quality by looking **up** from low altitude
by hand. (Still-open gap: `earth_up_8` / `earth_horizon_8` / `earth_up_120` scenarios.)

### RESULT — `USE_SKYVIEW = false`, measured 2026-08-11 14:24

`gates.skyViewBaked` is `false` on every row and the `1d sky-view LUT` pass is gone, so
the bake definitely stopped. Frame p50 vs the 13:12 run:

| scenario | prev | new | Δ | predicted |
|---|---|---|---|---|
| earth_120 | 17.50 | 17.40 | **−0.10** | must move ✓ |
| earth_30 | 18.10 | 17.80 | **−0.30** | must move ✓ |
| earth_8 | 17.80 | 17.50 | **−0.30** | must move ✓ |
| belt | 5.90 | 6.10 | +0.20 | flat (CPU-bound row, cpu p50 also moved 4.30 → 3.80) |
| earth_750 | 11.30 | 11.50 | +0.20 | flat |
| earth_250 | 15.70 | 15.80 | +0.10 | flat |
| earth_3900 | 8.30 | 8.40 | +0.10 | flat |
| other 7 | — | — | 0.00 | flat ✓ |

**The prediction held in direction and location** — all three predicted rows moved, and
they are the only ones that moved *faster*. But the honest conclusion is about
magnitude: **the largest delta anywhere is 0.30 ms, which is exactly the run-to-run
reproducibility floor.** So:

**⚠ PROFILER ARTIFACT #5 — the whole Sky-View subsystem cost ≲0.3 ms, not 4.3–4.7 ms.**
Bake *and* sample together are indistinguishable from zero. The reported 4.3–4.7 ms was
a phantom, as the step-eval arithmetic predicted (1.5 M step-evals should be ~0.2 ms).
Cause is almost certainly a write→read barrier stall inside the timestamp span: the main
pass samples the LUT in the same frame it is baked. **General rule: a small pass whose
output is consumed later in the same frame will over-report.**

**Decision: keep `USE_SKYVIEW = false`.** It is not a perf lever — but it is free, and it
retires the 200×256 lattice banding of god-ray shafts (the KNOWN LIMITATION with two
reverted fix attempts). User on looking up: *"maybe it looks a little bit better"*,
consistent with crisp per-pixel shafts replacing the lattice smear.

Note the orientation caveat cuts the reassuring way here: looking **up** from low
altitude, rays exit the shell in ~90 km versus 300 km+ toward the horizon, so sky-up
pixels are *cheaper* per pixel than the ground pixels already being marched. Dropping
the LUT is therefore not a perf risk in the orientation the scenario set fails to cover.

Dead code left in place deliberately (the never-taken `uSkyViewBlend < 0.999` branch is
uniform-valued and free; the unused LUT is one 200×256 RGBA16F ≈ 400 KB). Removing it is
a cleanup, not a perf fix.

### PENDING — `MAIN_STEPS` 32 → 16

Prediction recorded before measuring. The march runs wherever `uActive = 1`, so:

- **`deep_space` must be flat** (no body in range → no march at all).
- **Everything else should move**, but the five rows pinned at 8.30 (12629, 6629, 4100,
  3900, 2100) cannot show it — see the harness gap below.
- Measurable rows, if it scales a true 2× on the march (reported `1.5` minus ~0.8 ms of
  apply, halved): `earth_1900` 9.70 → ~6.7 and `earth_750` 11.50 → ~7.6 **should both
  reach the cap**; `earth_650` 13.60 → ~9.7; `earth_250` 15.80 → ~11.6;
  `earth_120` 17.40 → ~13.2; `earth_30` 17.80 → ~13.5; `earth_8` 17.50 → ~13.4.
- If it instead scales like the resolution cut did (~0.7 of ideal), the deck lands
  ~14.6 ms. **Either way the whole ladder clears 60 fps.**

Watch for **banding** on the limb, the terminator and the twilight sky — there is no
dither to hide it (see the correction above). Fallback ladder: 24 steps, then a
blue-noise dither via the existing `stbnTexture.ts` / BAYER infrastructure.

### RESULT — `MAIN_STEPS` 32 → 16, measured 2026-08-11 15:08. **≥60 fps everywhere.**

| scenario | frame p50 | fps | | scenario | frame p50 | fps |
|---|---|---|---|---|---|---|
| deep_space | 8.30 → 8.30 | 120 (cap), **flat ✓** | | earth_1900 | 9.70 → **8.30** | 103 → **120 (cap)** |
| belt | 6.10 → 5.70 | 164 → 175 | | earth_750 | 11.50 → **8.80** | 87 → **114** |
| earth_12629 | 8.30 → 8.30 | 120 (cap) | | earth_650 | 13.60 → **11.10** | 74 → **90** |
| earth_6629 | 8.30 → 8.30 | 120 (cap) | | earth_250 | 15.80 → **13.10** | 63 → **76** |
| earth_4100 | 8.30 → 8.30 | 120 (cap) | | earth_120 | 17.40 → **14.90** | 57 → **67** |
| earth_3900 | 8.40 → 8.30 | 119 → 120 (cap) | | earth_30 | 17.80 → **15.40** | 56 → **65** |
| earth_2100 | 8.30 → 8.30 | 120 (cap) | | earth_8 | 17.50 → **14.90** | 57 → **67** |

`deep_space` flat as predicted (no body → no march), `earth_1900` reached the cap as
predicted, no leakage. **Every scenario is now ≥64 fps; the ≥60 target is met.**
No banding reported.

**My 2× prediction was wrong — it delivered 1.4×.** The reasoning ("halving steps halves
the dependent chain without cutting occupancy, so it should beat the resolution cut's
efficiency") does not survive the data. Both levers deliver the *same* ~70% of ideal, and
that regularity is the actual finding:

### ⚠ A ~3 ms FIXED COST that scales with NEITHER resolution NOR step count

Marginal cost of a step-eval, from the two levers independently (frame-time ground
truth at `earth_8`, so no timestamps involved):

| lever | step-evals removed | frame saved | marginal rate |
|---|---|---|---|
| resolution 4× (full → half) | 130.4 M | 14.55 ms | **8.96 G/s** |
| steps 2× (32 → 16) | 21.8 M | 2.60 ms | **8.38 G/s** |

Two completely different changes agree on **~8.7 G step-evals/s**. So the marginal
model is solid — and it leaves a residual:

```
atmosphere family at earth_8, 16 steps, half res:   6.30 ms  (ground truth)
  step-evals   21.8 M / 8.7 G/s                  = 2.51 ms
  apply blit   (clean deep_space measurement)     = 0.75 ms
  ─────────────────────────────────────────────────────────
  UNEXPLAINED                                      3.04 ms
```

A three-point fit across all measurements — full-res/32, half-res/32, half-res/16 —
gives `cost = 3.2 ms + work / 8.5 G/s` and predicts all three within 0.25 ms. A term
independent of *both* pixels and steps is the only thing that explains 2.88×-from-4× and
1.4×-from-2× simultaneously; neither a per-pixel term nor a per-step term can.

**This ~3 ms is now 48% of the atmosphere family and the single largest item in the
frame.** Leading hypothesis: a **GPU bubble from the apRT write → read dependency** —
the AP march writes the half-res target and the apply pass samples it immediately, so
the GPU stalls waiting for the write to flush. That is the same mechanism as profiler
artifacts #4 and #5, except here it costs real frame time rather than just mis-reporting.

Candidate fixes, cheapest first:
1. **Reorder passes** so independent work sits between the AP march and the apply. Note
   the BSM cannot move after the march (the march taps it for god rays), but the cloud
   marcher (~9.8 ms) looks independent of both `apRT` and `rtB` — verify before trusting.
   Free if it works, and it is simultaneously the test and the fix.
2. **Merge the apply into a pass that already reads `rtB`** (cloud composite / local
   scene), removing the round trip entirely.
3. Confirm-only: `AP_RES_SCALE = 0.25` should save just ~0.6 ms of work if the model
   holds, versus ~1.9 ms if the residual is really pixel-dependent after all.

**Quality note from this change** (user-observed): *"the shadows the clouds throw into
the atmosphere … not really worse, just different"*. Expected and worth naming — god rays
tap the BSM **per march step**, so halving the steps halves the shaft sampling rate along
each ray. Shafts get slightly chunkier. This is the one real fidelity cost of the step
cut, and it is recoverable independently (tap the BSM on a different cadence than the
medium samples) if it ever reads wrong.

### PENDING — pass reorder: put the cloud pipeline inside the AP march → apply gap

Refined model first. The pre-split build had no `apRT` round trip at all, so fitting
`cost = bubble + P·px + S·px·steps` across all three measurements at `earth_8`
(pre-split full/32 = 23.65, post-split half/32 = 8.35, half/16 = 5.81) pins each term —
and the bubble term is only needed for the **post-split** rows:

| term | value | scales with |
|---|---|---|
| **bubble** | **2.44 ms** | **nothing — appeared *with* the split** |
| step work | 2.54 ms (at 16 steps) | pixels × steps |
| per-pixel setup | 0.83 ms (at half res) | pixels |
| apply blit | 0.75 ms | pixels |
| total | 6.56 ms | — measured 6.56 ✓ |

`S = 0.117 ms per Mpx per step` and `P = 0.611 ms per Mpx` both come out physically
sensible, and the fit reproduces the pre-split 23.65 ms with **no bubble term** — which is
what a write→read flush stall predicts, since that dependency did not exist before.

**The change:** `AtmospherePass.render()` is split into `marchAP()` and `applyAP()`.
`marchAP` stays at pass 1.5; `applyAP` moves down to just before the cloud composite, so
the marcher + reconstruction (~17 ms) sit between writing the half-res AP target and
sampling it.

Verified safe before moving it: the cloud marcher and reconstruction bind **only** the
sparse colour/depth and history RTs — `rg` finds no reference to the scene target in
either module — and everything that *does* read `rtB` (the composite, which blends with
`autoClear` off; the local scene; post) comes after the new call site. Both call sites
carry the same `atmospherePass && rtB` guard, so they stay symmetric.

Prediction, recorded before measuring — with a built-in control group, because the cloud
pipeline is gated on `cloudsVisible` (below 700 km): clouds-on rows should gain **−2.4 ms**,
`earth_750` (clouds off, nothing to fill the gap) should be **unchanged**.

### ❌ RESULT 2026-08-11 18:51 — REFUTED ON BOTH ARMS, AND REVERTED

| scenario | before | after | Δ | clouds | predicted |
|---|---|---|---|---|---|
| earth_650 | 11.10 | 11.40 | **+0.30** | on | −2.4 |
| earth_250 | 13.10 | 13.50 | **+0.40** | on | −2.4 |
| earth_120 | 14.90 | 15.50 | **+0.60** | on | −2.4 |
| earth_30 | 15.40 | 16.00 | **+0.60** | on | −2.4 |
| earth_8 | 14.90 | 15.60 | **+0.70** | on | −2.4 |
| **earth_750** | 8.80 | 9.40 | **+0.60** | **off — control** | **0.00** |
| belt | 5.70 | 5.90 | +0.20 | off | 0.00 |
| deep_space, ≥1900 km | 8.30 | 8.30 | 0.00 | capped — uninformative | — |

**Every row moved the same direction: slower.** The clouds-on rows went the *opposite*
way from the prediction, and the control row — where nothing at all moved into the gap —
regressed by the same amount. That second fact is what kills the hypothesis: a change
that only reorders work around the cloud pipeline cannot slow down a frame that has no
cloud pipeline, so the regression is not about filling the gap.

**Conclusion: the ~2.4 ms fixed cost is NOT an inter-pass write→read flush stall.**
Reverted to the adjacent ordering, with a warning comment at both sites.

Two secondary observations worth keeping:
- The reported `1.5` and `1.6` **stopped being near-equal** once separated (6.95 vs 9.28
  at `earth_120`). So artifact #4's duplication was caused by *adjacency* — which is
  self-consistent, and means the duplication is a property of the measurement, not of the
  work.
- The apply's reported time *rose* (6.6→8.0 … 7.1→10.0 ms) when moved later. The most
  likely mechanism for the regression is the opposite of the hypothesis: adjacency was
  **helping** via cache/tile locality on `apRT`, and ~17 ms of cloud work in between
  evicts it. Splitting also adds render-pass transitions.

What the ~2.4 ms actually is remains **unknown**. The remaining candidate is a general
occupancy/latency floor inside the march itself — which is where the "latency-bound"
reading pointed before the two-lever symmetry argued against it. It is not resolved, and
it should not be guessed at again without a way to measure inside a pass (Xcode Metal
capture on the GPU process, per §1).

### 2026-08-13 07:22 — a repeat of the 15:08 build. Revert confirmed; variance floor widened.

This sweep ran 3 minutes after the commit that reverted the pass reorder, on **identical
code** to the 15:08 run. It is therefore a variance measurement, not a change:

| scenario | 15:08 | 07:22 | Δ |
|---|---|---|---|
| earth_750 | 8.80 | 9.00 | +0.20 |
| earth_650 | 11.10 | 11.30 | +0.20 |
| earth_250 | 13.10 | 13.30 | +0.20 |
| earth_120 | 14.90 | 15.10 | +0.20 |
| earth_30 | 15.40 | 15.70 | +0.30 |
| earth_8 | 14.90 | 15.30 | **+0.40** |
| all eight capped rows | 8.30 | 8.30 | 0.00 |

The reorder revert restored the baseline. But **the reproducibility floor is ~0.4 ms on
uncapped rows, not the 0.3 ms recorded earlier** — treat anything below 0.5 ms as noise.

Note the trap in reading this table: *all* the movement is on BSM-active rows, which looks
like a pattern until you notice those are simply the only rows not pinned at the vsync cap.
The capped rows cannot vary. With 8 of 14 scenarios capped, "where the variance appeared"
carries almost no information any more — another reason the off-vsync mode matters.

**⚠ A PROCESS FAILURE WORTH NOT REPEATING.** This sweep was initially read as a
measurement of `GODRAY_SHADOW_STRIDE = 2`, and a conclusion ("BSM taps are free, so the
2000 km gate cost must be the bake") was drawn from it. **The stride change was not in the
tree** — the worktree had been reset to HEAD, discarding it. Check `git status` / grep for
the knob before attributing a sweep to a change. A clean worktree after an edit is the
tell.

### PENDING (re-applied 2026-08-13) — `GODRAY_SHADOW_STRIDE = 2`

The naive form is a trap: changing *where* the tap happens still taps once per step. The
saving needs the fetch skipped, so the tap sits inside `If(s.mod(2) == 0)` — a condition on
the **loop counter**, identical for every invocation in the draw, hence a uniform-valued
branch and free, the same property behind the `strength > 0` and `uRingOpacity > 0` gates.
16 dependent fetches per pixel become 8.

The retained tap is at the **centre** of each pair, not its first step, so shafts are not
biased toward the camera. Inside the branch `s` is already the group's first step, so the
centre is `s + SAMPLE_SEGMENT_T + (stride−1)/2` — no `floor()` — and at stride 1 that
collapses back to the step's own position, making 1 an exact no-op.

Prediction — the `strength > 0` gate provides the control group for free:

| rows | bsmStrength | prediction |
|---|---|---|
| earth_8 / 30 / 120 / 250 / 650 / 750 | 1 | **−1.0 ms** if the taps are the cost |
| earth_1900 | 0.156 | should gain, but **capped** — cannot show |
| deep_space, belt, ≥2100 km | **0** | **exactly flat** — the tap never runs |

If the BSM-active rows move by less than ~0.5 ms, the taps are **not** the lever, and the
+5.60 ms the 2000 km gate cost pre-half-res has to be the **bake** instead (3 renders ×
512² × 24 steps ≈ 18.9 M step-evals ≈ 2.2 ms at the measured 8.7 G step-evals/s) plus the
planet surface shader's 5-tap penumbra. That would redirect this lever from the taps to the
bake's step count and resolution — a genuinely useful negative result, so it is worth the
sweep either way.

### ❌ RESULT 2026-08-13 07:41 — `GODRAY_SHADOW_STRIDE = 2`: the BSM taps are already free. Reverted.

Control group perfect (every `bsmStrength = 0` row exactly 0.00). But:

| | frame p50 Δ | `1.5 atmosphere` Δ |
|---|---|---|
| earth_750 | −0.10 | −0.18 |
| earth_650 | 0.00 | −0.07 |
| earth_250 | −0.10 | −0.20 |
| earth_120 | 0.00 | −0.19 |
| earth_30 | 0.00 | −0.21 |
| earth_8 | 0.00 | −0.18 |

Removing **eight dependent BSM fetches per pixel** moved the pass by a mean of
**−0.17 ms** and frame time by nothing above the 0.4 ms floor. That is ≈**21 µs per
fetch per frame** at 1.36 Mpx — the BSM is a 512² map, small enough to live in cache,
unlike the transmittance/MS LUTs or the 3D noise volumes. Reverted: it cost god-ray
fidelity for no frame time.

**COROLLARY — this redirects the BSM lever.** The +5.60 ms the 2000 km gate cost
pre-half-res is not the march taps, and not the planet surface shader's 5-tap penumbra
either (`1 scaled scene` moves only +0.12 ms across that gate). What remains is the
**bake**: 3 renders × 512² × 24 steps ≈ 18.9 M step-evals ≈ **2.2 ms** at the measured
8.7 G step-evals/s. Any future BSM work belongs in `cloudShadowMap.ts` — its step count
and resolution — not in the tap rate.

### ⚠ METAL TOOLING IS CLOSED: hardened runtime strips the debug env vars

`MTL_HUD_ENABLED=1` and `MTL_CAPTURE_ENABLED=1` do **nothing** for a stock-signed
browser, whether passed on the command line or via `launchctl setenv`. Verified by
code signature:

```
Arc:    flags=0x10000(runtime)
Chrome: flags=0x12a00(kill,restrict,library-validation,runtime)
```

Both are hardened-runtime signed with **no** `com.apple.security.get-task-allow`, and
Chrome additionally sets `restrict`. macOS strips `MTL_*` and `DYLD_*` from such
processes before they start, which is also why `launchctl setenv` changes nothing —
same delivery path, same stripping. Xcode Metal frame capture is closed for the same
reason. Re-signing Chromium would work but breaks its signature; not worth it.

**Consequence for §1's tooling table:** the "frame capture (RenderDoc/PIX/Xcode Metal)"
row has NO working equivalent for us. In-pass questions must be answered by **ablation
using the existing harness**, not by an external profiler.

### PENDING — diagnostic: `MAIN_STEPS = 2` to test whether the 2.44 ms floor is real

⚠ Not a shipping value; the atmosphere looks wrong in this build. Restore 16 after.

The fitted model says `pass = 2.44 (fixed) + 0.117·Mpx·steps + 0.611·Mpx + 0.75`. At 2
steps the step term collapses to 0.32 ms, so whatever remains is floor + setup + apply:

| hypothesis | predicted `1.5 atmosphere` at earth_8 |
|---|---|
| the 2.44 ms floor is real | **≈4.3 ms** |
| there is no floor (3-point fit was overfitting) | **≈1.9 ms** |

Those are 2.3× apart — far outside any noise. This is the single highest-information
experiment available and it costs one sweep and one line. Either answer is progress: a
real floor becomes the top remaining target, and no floor kills the whole line of
enquiry and hands the budget back to the step term (where `AP_RES_SCALE` and
`MAIN_STEPS` already work).

### ✅ RESULT 2026-08-13 08:31 — the fixed cost is REAL, and it is bigger than fitted

`MAIN_STEPS = 2` diagnostic. Predicted ≈4.3 ms if the floor is real, ≈1.9 if not.
**Measured 4.47 ms at earth_8** — within 0.17 of one prediction and 2.4× off the other.

Per-step coefficient, refitted from 16 → 2 steps across six rows (remarkably tight):

| scenario | `1.5` @16 | @2 | Δ | ms/Mpx/step |
|---|---|---|---|---|
| earth_8 | 6.37 | 4.47 | −1.90 | 0.0996 |
| earth_30 | 6.80 | 4.91 | −1.89 | 0.0991 |
| earth_120 | 6.65 | 4.77 | −1.88 | 0.0986 |
| earth_250 | 6.51 | 4.60 | −1.91 | 0.1002 |
| earth_650 | 5.99 | 4.00 | −1.99 | 0.1044 |
| earth_750 | 5.84 | 4.00 | −1.84 | 0.0965 |

**S = 0.0997 ms per Mpx per step.** Extrapolating earth_8 to zero steps leaves
**4.20 ms**; minus the ~0.70 ms apply blit, the march carries a **~3.50 ms fixed cost.**

So the shipping 6.37 ms atmosphere family at earth_8 decomposes as:

| | ms | share |
|---|---|---|
| step work (16 steps) | 2.17 | 34% |
| apply blit | 0.70 | 11% |
| **FIXED** | **3.50** | **55%** |

**That 3.50 ms is the single largest item in the entire frame** (23% of earth_8's
15.30 ms). And it reframes the two levers already spent: driving steps to *zero* would
save only 2.2 ms of the 6.37. `MAIN_STEPS` and `AP_RES_SCALE` have both been mined out.

`MAIN_STEPS` restored to 16.

### LANDED — gate the ring-GLOW-occlusion term (free, zero quality change)

Found while reading the newly-identified per-pixel region: the ring-glow term
(`atmospherePass.ts` ~1711) was computed **unconditionally per pixel**, while the
structurally identical term inside `directSunOcclusion` (~1296) has been gated on
`uRingOpacity > 0` since 2026-08-11. The in-march one was gated; this one was missed.
On every ringless body it is ~40 ALU ops including 6 smoothsteps for a guaranteed
no-op, and it sits in the outside-loop region that the probe above just showed is 55%
of the pass.

Now gated the same way. Verified both branches in-engine: Earth (gate closed) renders
correctly with clouds; **Saturn at 150,000 km (gate open) renders rings, the planet's
shadow on the rings, the limb glow, and the ring passing in front of the atmosphere
glow** — which is exactly what this term computes.

Expected saving is honestly small — pure ALU arithmetic says ~0.05 ms, though the
earlier in-march ring gate over-delivered relative to the same arithmetic. **It may
well sit under the 0.4 ms noise floor and be unmeasurable.** Kept regardless: it is
free and provably a no-op on ringless bodies. Its effect can be read later by comparing
a normal (0.5-scale) sweep against the 07:41 run.

### PENDING — diagnostic: `AP_RES_SCALE = 0.25`, per-PIXEL vs per-PASS

⚠ Not a shipping value. This is the one thing we still cannot tell about the 3.50 ms,
and it decides where to attack it. Predictions for `1.5 atmosphere` at earth_8, against
6.37 ms at 0.5 scale:

| hypothesis | step 0.54 | apply 0.70 | fixed | **total** |
|---|---|---|---|---|
| fixed is **per-pixel** | 0.54 | 0.70 | 3.50 × ¼ = 0.88 | **≈2.1 ms** |
| fixed is **per-pass** | 0.54 | 0.70 | 3.50 | **≈4.7 ms** |

2.2× apart. **Per-pixel** → the outside-loop work and shader occupancy are the target,
and resolution becomes a genuine lever (which would need a quality decision).
**Per-pass** → something structural, and resolution will never help no matter how far
it is pushed.

Note the ring gate rides along in this build. It cannot confuse the result: at most
~0.5 ms against a 2.6 ms separation.

### ✅ RESULT 2026-08-13 08:44 — the fixed cost is per-PASS. Both knobs are mined out.

`AP_RES_SCALE = 0.25` diagnostic (a 4× pixel cut). Predicted ≈2.1 ms if the fixed cost
is per-pixel, ≈4.7 if per-pass. **Measured 4.59 ms at earth_8** — within 0.11 of one,
2.2× off the other.

| scenario | `1.5` @0.5 | @0.25 | Δ measured | Δ if step-work only | Δ if fixed scaled too |
|---|---|---|---|---|---|
| earth_8 | 6.37 | 4.59 | **−1.78** | −1.63 | −4.26 |
| earth_30 | 6.80 | 5.11 | **−1.69** | −1.63 | −4.26 |
| earth_120 | 6.65 | 4.97 | **−1.68** | −1.63 | −4.26 |
| earth_250 | 6.51 | 4.79 | **−1.72** | −1.63 | −4.26 |
| earth_650 | 5.99 | 4.23 | **−1.76** | −1.63 | −4.26 |
| earth_750 | 5.84 | 4.18 | **−1.66** | −1.63 | −4.26 |

Every row matches "step work only". The fixed term did not move at all.

**So the ~3.50 ms is per-PASS: independent of resolution AND step count.** That closes
out both knobs — each can only ever reach the 2.17 ms step term, and pushing either
further buys progressively less for progressively more quality. `AP_RES_SCALE` restored
to 0.5, `MAIN_STEPS` to 16. Neither is a lever any more.

### PENDING — GROUND-TRUTH ablation: force `uActive = 0`

Two mechanism guesses have now been measured and refuted (the inter-pass flush stall,
and the BSM taps). The reported numbers have produced **five** distinct artifacts. So
the next step deliberately uses **no timestamps at all**.

`uActive` gates the entire `If(uActive > 0.5)` block in `apFragment`. Setting it to 0
leaves both passes running, both render targets identical, and the apply computing
`scene·1 + 0` — only the march's work vanishes. **The frame-p50 delta is then the
march's true cost, measured on ground truth.**

Against the 07:41 baseline at earth_8 (frame 15.30, reported family 6.37):

| hypothesis | predicted frame p50 |
|---|---|
| the family really costs ~6.37 (pass structure ~1.2) | **≈10.2 ms (98 fps)** |
| most of the reported 6.37 is phantom | **≈14.x ms** |

This also sets a hard **upper bound on every possible future atmosphere optimisation**:
no amount of work on this pass can beat deleting it. If the answer is ≈14, the
atmosphere is already cheap, the last several rounds were chasing a measurement
artifact, and the remaining budget lives in the BSM bake, the cloud pipeline and post
instead.

Verified the ablation is actually live before measuring: at `earth_2100` the terminator
is razor-sharp with no scattering gradient and no limb glow.

### ⛔ RESULT 2026-08-13 09:05 — the "3.5 ms fixed cost" was largely a MEASUREMENT ARTIFACT

Ground-truth ablation: `uActive = 0` deletes the entire march while leaving both passes
running, both targets identical, and the apply computing `scene·1 + 0`.

| scenario | frame ON | frame OFF | Δ | fps OFF | `1.5` ON | `1.5` OFF |
|---|---|---|---|---|---|---|
| earth_8 | 15.30 | **12.70** | −2.60 | 79 | 6.37 | 4.07 |
| earth_30 | 15.70 | **13.10** | −2.60 | 76 | 6.80 | 4.51 |
| earth_120 | 15.10 | **12.60** | −2.50 | 79 | 6.65 | 4.39 |
| earth_250 | 13.20 | **10.80** | −2.40 | 93 | 6.51 | 4.19 |
| earth_650 | 11.30 | **8.60** | −2.70 | 116 | 5.99 | 3.58 |
| earth_750 | 8.90 | 8.30 | −0.60 | 120 (cap) | 5.84 | 3.55 |

**Deleting the entire march saves 2.56 ms.** Predictions were ≈10.2 ms (family real) or
≈14.x (family phantom); the answer, 12.70, is neither — because both predictions rested
on the reported numbers being decomposable, and they are not.

**2.56 ms ≈ the 2.17 ms step-work term. So the march has no meaningful fixed cost of its
own.** The "~3.5 ms fixed" lives in the two fullscreen passes' structure — and even that
is mostly inflation:

| | `1.5` reported with **zero** march work | gpu/frame |
|---|---|---|
| earth_8 | **4.07 ms** | 3.3 — saturated, spans overlap |
| deep_space | **0.38 ms** | 0.8 — unsaturated, trustworthy |

Same passes, same targets, same full-res writes, 10× different reported cost. The
difference is GPU saturation, not work.

**⚠ THE METHODOLOGICAL LESSON, and it is the most important entry in this document:
when `gpu/frame` > 1.15, ABLATE — do not do arithmetic on reported per-pass numbers.**
Three consecutive rounds fitted an increasingly precise model (2.44 → 3.50 ms, a 3-point
fit reproducing every measurement within 0.25 ms, two independent levers agreeing on
8.7 G step-evals/s) to numbers that were partly artifact. The model's internal
consistency was not evidence — inflated numbers can be *consistently* inflated. One
ablation settled in a single sweep what the curve-fitting got wrong, and it is the same
trap already catalogued as artifacts #1–#5. `§ Interpretation rule` says to read
gpu/frame first; that rule should have stopped the arithmetic at earth_8's 3.3.

### ✅ THE ATMOSPHERE IS DONE AS AN OPTIMISATION TARGET

Hard ceiling: **2.56 ms** at the deck for everything the march could ever give, and the
resolution and step levers have already taken most of what is reachable. From where this
started — a full-res 32-step march at 23.65 ms, 74–90% of frame — the march is now worth
2.56 ms. All diagnostics restored: `MAIN_STEPS = 16`, `AP_RES_SCALE = 0.5`, `uActive = 1`.

**120 fps at the deck therefore requires the other systems**, and every remaining
estimate for them rests on the same untrustworthy reported numbers. The next step is
three one-line ablations, each ground truth, each one sweep:

| ablation | what it measures | current *reported* (untrustworthy) |
|---|---|---|
| force `bsmStrength = 0` | true Beer-Shadow-Map cost | 12.20 ms |
| force `cloudsVisible = false` | true cloud pipeline cost | ~2.3 ms (straddle, trustworthy) |
| disable bloom | true post cost | 1.81 ms |

The BSM is the big unknown: it *reports* 12.20 ms at the deck, its bake arithmetic
suggests ~2.2 ms, and its taps measured free. Given 12.70 ms remains at the deck with the
atmosphere march deleted, and post + scaled + froxel + local + clouds account for only
~6 ms of it, the BSM is the largest unexplained item left. **Ablate it before touching
it.**

### PENDING — GROUND-TRUTH ablation: `BSM_ABLATE_DIAGNOSTIC = true`

⚠ Not a shipping value; cloud shadows disappear. One flag in `SpaceRenderer.tsx`
short-circuits the whole BSM block, which removes **both** the bake (3 renders × 512² ×
24 steps) **and** every consumer — skipping the block leaves `bsmStrength = 0`, closing
the `strength > 0` gate in the atmosphere march and the planet surface shader alike.
Frame-p50 delta = the BSM's true total cost.

Three numbers for this pass cannot all be right, which is why it needs ground truth:

| source | says |
|---|---|
| reported `1b beer shadow map` at the deck | **12.20 ms** |
| bake arithmetic (18.9 M step-evals at 8.7 G/s) | **~2.2 ms** |
| its per-march taps, measured 2026-08-13 | **free** |

And it is the largest unexplained item left: with the atmosphere march deleted entirely,
`earth_8` still sat at 12.70 ms, while post (1.81) + scaled (1.42) + froxel/local (0.38)
+ clouds (~2.3, straddle-measured) account for only ~6 ms of it.

Prediction — control group free, since below the gate the work does not run at all:

| rows | bsmStrength | prediction |
|---|---|---|
| earth_750 / 650 / 250 / 120 / 30 / 8 | 1 | **should move** — magnitude is the question |
| earth_1900 | 0.156 | should gain, but **capped** — cannot show |
| deep_space, belt, ≥2100 km | **0** | **exactly flat** |

Confirmation the ablation is live: every row must report `bsmStrength: 0` **and**
`bsmBaked: false`. Verified in-engine at `earth_250` — clouds still render but are
uniformly lit, with no self-shadowing between masses.

**⚠ One confound, stated up front:** the baseline is the 07:41 run, which predates the
ring-glow gate. So the measured delta is (BSM) + (ring gate, expected ≤0.5 ms and
probably under the 0.4 ms noise floor), both in the same direction. That does not affect
the decision at the expected BSM magnitudes, but subtract ~0.3 ms before quoting a
number. There is no clean control for it here because every `bsmStrength = 0` row except
`belt` is vsync-capped.

If it lands near 2 ms, the bake's step count (24) and resolution (512²) are the lever.
If it lands near 6, something else is happening and it needs its own investigation.

### ✅ RESULT 2026-08-13 11:24 — the BSM costs 2.8–3.7 ms. Largest single item in the frame.

| scenario | BSM on | BSM off | Δ | fps off | bsmStrength |
|---|---|---|---|---|---|
| earth_8 | 15.30 | **11.60** | **−3.70** | 86 | 1 |
| earth_30 | 15.70 | **12.10** | **−3.60** | 83 | 1 |
| earth_120 | 15.10 | **11.80** | **−3.30** | 85 | 1 |
| earth_250 | 13.20 | **10.10** | **−3.10** | 99 | 1 |
| earth_650 | 11.30 | **8.50** | **−2.80** | 118 | 1 |
| earth_750 | 8.90 | 8.30 | −0.60 | 120 (cap) | 1 |
| deep_space, belt, ≥1900 km | — | — | **0.00** | — | 0 |

**Control group perfect** — every `bsmStrength = 0` row moved exactly 0.00 (belt −0.20 is
the CPU-bound row). Gates confirm `bsmStrength: 0` and `bsmBaked: false` throughout.
Backing out the ~0.3 ms ring-gate confound: **the BSM is ~2.5–3.4 ms.**

That resolves the three mutually-inconsistent claims:

| claim | verdict |
|---|---|
| reported `1b beer shadow map` = 12.20 ms | **phantom, 3.6× inflated** |
| its per-march taps are free | **confirmed** |
| bake arithmetic ≈ 2.2 ms | **wrong — and my arithmetic was wrong by 3×** |

**Correction to an earlier note in this document:** the bake is *not* "3 renders × 512² ×
24 steps". Only **one** of the three renders in `bakeCloudShadowMap` does the 24-step
march (512² × 24 = 6.29 M step-evals ≈ **0.7 ms** at 8.7 G/s); the other two are a 512²
blur and a 1×1 ship probe. So the bake plausibly accounts for only ~0.7 of the ~3.4 ms,
which would make `BSM_MARCH_STEPS` and `BSM_SIZE` nearly pointless as levers.

### PENDING — split the 3.4 ms: `BSM_CONSUMERS_ABLATE_DIAGNOSTIC = true`

Leaves the bake running and zeroes only the strength, closing every consumer gate. Then
`full − this` = the consumers, and `this − full-off` = the bake.

| hypothesis | predicted earth_8 frame | ⇒ lever |
|---|---|---|
| bake ~0.7, consumers ~2.7 | **≈12.3 ms** | cheapen the **consumers** |
| bake ~2.7, consumers ~0.7 | **≈14.3 ms** | cheapen the **bake** |

2 ms apart. Same control group as before: `bsmStrength = 0` rows exactly flat.

This is deliberately one more ablation rather than a change: the bake's step count and
resolution are the obvious knobs, and the arithmetic says they may be worth almost
nothing. Given that arithmetic on this pass has now been wrong twice (12.20 reported,
2.2 estimated, ~3.4 actual), the split gets measured before anything gets tuned.

### ✅ RESULT 2026-08-13 13:46 — the BSM split: bake 1.7–2.4 ms, consumers 1.1–1.3 ms

| scenario | full | consumers off | all off | ⇒ consumers | ⇒ **bake** |
|---|---|---|---|---|---|
| earth_8 | 15.30 | 14.00 | 11.60 | 1.30 | **2.40** |
| earth_30 | 15.70 | 14.40 | 12.10 | 1.30 | **2.30** |
| earth_120 | 15.10 | 14.00 | 11.80 | 1.10 | **2.20** |
| earth_250 | 13.20 | 12.10 | 10.10 | 1.10 | **2.00** |
| earth_650 | 11.30 | 10.20 | 8.50 | 1.10 | **1.70** |

Predicted ≈12.3 (bake small) or ≈14.3 (bake large); measured **14.00**. **The bake
dominates**, so the lever is `bakeCloudShadowMap` — `BSM_MARCH_STEPS` (24), `BSM_SIZE`
(512), or baking on alternate frames — not the consumers.

**⚠ THIRD WRONG PREDICTION ON THIS ONE PASS, and a new portable lesson.** I predicted the
bake at ~0.7 ms from "512² × 24 = 6.29 M step-evals at 8.7 G step-evals/s". Actual 2.40.
The 8.7 G/s figure was measured on the *atmosphere* march, which taps 2D LUTs; the BSM
march samples **3D cloud noise volumes** and is far heavier per step.
**Step-eval rates are NOT portable between shaders.** Running tally for this single pass:
reported 12.20 (phantom), my estimate 2.2 (3× wrong), my estimate 0.7 (3× wrong), measured
3.4 total. Every ablation was right; every estimate was wrong.

### ⛔ 120 fps AT THE DECK IS NOT REACHABLE — the arithmetic that settles it

Using only ground-truth ablation numbers at `earth_8` (15.30 ms / 65 fps):

| remove | remaining | fps |
|---|---|---|
| — | 15.30 | 65 |
| the **entire** BSM (3.40, measured) | 11.90 | 84 |
| **and** the entire atmosphere march (2.56, measured) | **9.34** | **107** |

**Deleting both systems outright — every cloud shadow, every god ray, all aerial
perspective — still leaves 9.34 ms, i.e. 107 fps, not 120.** The remaining 9.34 is the
cloud pipeline, post, the scaled scene and the atmosphere's pass structure. So 120 fps at
the cloud deck would require cutting into the volumetric clouds and bloom as well, which
is the visual core of the game.

**Recommendation: stop here.** The ≥60 fps target is met with margin everywhere
(deck 65, low orbit 66–72, everything ≥2100 km on the 120 cap). The remaining levers are
each ~1 ms for a real quality cost:

| lever | est. saving | cost |
|---|---|---|
| `BSM_MARCH_STEPS` 24 → 12 | ~1.0 ms | optical-depth accuracy, partly hidden by the existing blur |
| `BSM_SIZE` 512 → 384 | ~0.9 ms | shadow sharpness (already 5.9 km/texel) |
| bake on alternate frames | ~1.2 ms | no spatial cost, but alternating frame cost risks judder |
| the BSM consumers | ~1.2 ms total | spread thin; taps already measured free |

### PENDING — the BSM bake was redundant. Cache it. (User's observation, and it is right.)

"Why do we even need to rebake the BSM? our volumetric clouds are completely static."

Reading `updateWindow`, the bake's output is a pure function of exactly four things, and
**none of them change frame to frame in the common case:**

| input | varies? |
|---|---|
| the cloud field | **static** — drift (`uCloudUvOffset`) is "future-proofed for sim-time animation", not animated yet |
| the sun direction | **static** — nothing orbits or rotates |
| the window basis (`right`, `up`) | derived purely from the sun direction ⇒ **static** |
| the window centre | already **TEXEL-SNAPPED**, so it only moves in whole 5.86 km steps |

So with the camera parked — **every bench scenario, since the ship sits at 0 m/s** — the
second and every subsequent bake was redrawing a **bit-identical image** at 1.7–2.4 ms a
frame. That is not a quality trade at all; it is pure waste, and it is the largest single
item in the frame.

**The fix:** cache the bake inputs and skip the two expensive renders when none changed.
Three details that make it safe:

1. **It compares the actual inputs, not an assumption about what is static.** Animate
   cloud drift, add planetary rotation, or make the sun move, and rebaking simply resumes.
   Self-correcting — no future discipline required.
2. **The window centre is compared as integer texel snap indices**, so that part needs no
   epsilon. The sun direction does get one (1e-12 squared ≈ 1e-6 rad) because
   `_inverseModel` is re-inverted every frame — the floating origin shifts its translation,
   which leaves FP jitter in the rotation part.
3. **The 1-fragment ship probe still runs every frame.** The ship keeps moving *within* a
   texel while the window stands still, so its cloud-shadow lighting must track that. Only
   the 512² march and the blur are skipped.

Plus `bake(renderer, fieldUnstable)` — SpaceRenderer passes `hasPendingCloudBakes()` so a
half-built noise field can never be cached as final.

Prediction: the bake cost disappears from every stationary row.

| scenario | full | predicted | fps |
|---|---|---|---|
| earth_8 | 15.30 | **≈12.90** | 78 |
| earth_30 | 15.70 | **≈13.40** | 75 |
| earth_120 | 15.10 | **≈12.90** | 78 |
| earth_250 | 13.20 | **≈11.20** | 89 |
| earth_650 | 11.30 | **≈9.60** | 104 |
| earth_750 | 8.90 | ≈7.4 → **cap** | 120 |
| `bsmStrength = 0` rows | — | **exactly flat** | — |

**⚠ Honest caveat — the sweep measures the BEST case.** The bench camera never moves, so
the sweep shows the full win. In flight a rebake is needed every 5.86 km of
sun-perpendicular travel, i.e. at 120 fps: ~0.1% of frames at 1 km/s, ~14% at 100 km/s,
and *every* frame above ~700 km/s. So the benefit is largest when parked or slow — which
is exactly when the player is looking at the scenery — and degrades gracefully to the old
cost during fast transit. Quote the sweep as "stationary", not as a universal number.

Not verified in-engine: fine-grained invalidation while flying, because every bench
scenario is stationary. Gross invalidation is verified (warping between 250/8/30 km
re-bakes and renders correctly). **Fly around and confirm shadows track the ship.**

### ✅ RESULT 2026-08-13 14:13 — the bake cache lands, and the prediction was near-exact

| scenario | before | after | Δ | predicted | fps |
|---|---|---|---|---|---|
| earth_8 | 15.30 | **12.80** | −2.50 | 12.90 | **78** |
| earth_30 | 15.70 | **13.30** | −2.40 | 13.40 | **75** |
| earth_120 | 15.10 | **12.90** | −2.20 | 12.90 | **78** |
| earth_250 | 13.20 | **11.00** | −2.20 | 11.20 | **91** |
| earth_650 | 11.30 | **9.60** | −1.70 | 9.60 | **104** |
| **earth_750** | 8.90 | **8.30** | −0.60 | →cap | **120 (cap)** |
| all `bsmStrength = 0` rows | — | — | 0.00 | flat | — |

**Prediction error: 0.00 / −0.10 / 0.00 / −0.20 / −0.10 ms across five rows.** Worth
noting *why* it was that accurate: every input came from a ground-truth ablation, none
from reported per-pass arithmetic. The same method that produced a confident wrong model
three rounds earlier produced a near-perfect one once it was fed measured numbers.

The reported `1b beer shadow map` collapsed 8–13× (earth_8: 12.03 → 0.94), i.e. its
phantom inflation shrank in proportion to the real work — consistent with every other
artifact observation. The ~1.0–1.3 ms residual is the always-on 1-fragment ship probe plus
that pass's share of overlap.

User confirms **no shadow issues while flying**, so fine-grained invalidation works in
practice, not just on warps.

## 8. FINAL STATE — and what 120 fps at the deck would still cost

| scenario | eye-balled start | 2026-08-11 baseline | **now** | fps |
|---|---|---|---|---|
| earth_4100 and above | <60 | 11.80 | **8.30** | **120 (cap)** |
| earth_2100 | <60 | 17.60 | **8.30** | **120 (cap)** |
| earth_1900 | ~43 | 23.20 | **8.30** | **120 (cap)** |
| earth_750 | ~39 | 25.90 | **8.30** | **120 (cap)** |
| earth_650 | ~35 | 28.25 | **9.60** | **104** |
| earth_250 | ~33 | 30.10 | **11.00** | **91** |
| earth_120 | ~31 | 32.30 | **12.90** | **78** |
| earth_30 | ~30 | 32.85 | **13.30** | **75** |
| earth_8 (deck) | 25–40 | 32.35 | **12.80** | **78** |

**Everything from 750 km up is on the 120 fps cap. The deck band is 75–78 fps.** Against
the 12:35 baseline that is −60% frame time at the deck; against the original eye-balled
ladder the deck went 25–40 → 78 fps.

Reaching 120 at the deck needs a further −4.5 ms, and no single item supplies it — the
remainder is the cloud pipeline, post/bloom, the scaled scene, the atmosphere's pass
structure and the BSM consumers, each 1–2 ms. That means cutting into the volumetric
clouds and bloom, i.e. the visual core. **The ≥60 target is met with wide margin; 120 at
the deck is a separate, much more expensive project.**

Anything further should start with the three remaining one-line ablations — cloud
pipeline, bloom, scaled scene — because every estimate for them still rests on reported
numbers, and this document's record on those is 0 for 4.

Best build is the 15:08 one (half-res AP, 16 steps, no Sky-View, adjacent ordering).
Budget at `earth_8`, the worst case, at **14.90 ms / 67 fps**:

| item | ms | % | how measured |
|---|---|---|---|
| atmosphere family | 6.56 | 44% | reported `1.5` ≈ ground truth (artifact #4) |
| cloud pipeline | 2.30 | 15% | straddle 750 → 650, stable across **3** sweeps |
| BSM taps | ~2.1 | 14% | straddle scaled by the resolution cut, + coverage |
| post (bloom) | 1.80 | 12% | per-pass, unsaturated rows agree |
| scaled scene | 1.33 | 9% | per-pass |
| froxel + local | 0.60 | 4% | per-pass |
| **total** | **14.69** | | vs frame **14.90** — closes to 0.2 ms |

**120 fps at the deck needs −6.57 ms, and there is no longer a single lever that gets
it.** When this work started, one pass was 74–90% of the frame; now the top six items are
6.6 / 2.3 / 2.1 / 1.8 / 1.3 / 0.6. Reaching 8.33 ms means roughly halving *everything*.

That is the honest state, and it is a normal place for a renderer to arrive. The mid band
(≥2100 km) is already at 120 and done.

Candidate program, with sizes, if 120 at the deck is wanted:

| change | est. saving | risk |
|---|---|---|
| `AP_RES_SCALE` 0.5 → 0.35 (step work 2.54→1.24, setup 0.83→0.41) | ~1.7 ms | more upsample blur |
| post/bloom: fewer mips, or half-res high-pass | ~0.9 ms | affects the whole game's look |
| cloud pipeline: `CLOUD_MAX_DPR` or march steps | ~1.0 ms | cloud detail — the thing being built |
| BSM taps: every Nth step, or a coarser mip (task #8) | ~1.0 ms | god-ray shaft fidelity |
| the unexplained 2.4 ms atmosphere floor | up to 2.4 ms | mechanism unknown after the refutation |

The first four sum to ~4.6 ms → ~10.3 ms → **97 fps**. Closing the last gap to 120
requires cracking the 2.4 ms floor, which needs in-pass profiling (Xcode Metal capture),
not another guess.

### ⚠ HARNESS GAP: the mid band is now unmeasurable

**Now blocking, as of the 15:08 run.** Eight of fourteen scenarios sit at exactly
8.30 ms: `deep_space`, `belt` (CPU-bound anyway), `earth_12629`, `earth_6629`,
`earth_4100`, `earth_3900`, `earth_2100`, `earth_1900`.

- The **froxel straddle** (4100 → 3900) is dead — both sides cap.
- The **BSM straddle** (2100 → 1900) is now dead too — both sides cap. It gave a
  ≥1.37 ms floor last run; it gives nothing now.
- Only the **cloud straddle** (750 → 650) still works, and 750 is at 8.80 ms — one more
  win and it goes too. (It has read +2.30/+2.35 ms in three consecutive sweeps, so the
  cloud pipeline's cost is at least well established before we lose the instrument.)

Any further attribution below 4100 km needs an off-vsync mode first. Options: render N
times per frame and divide; scale the canvas up to re-saturate the GPU (canvas size is
already normalised across runs); or present without waiting for vblank.

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

## 2026-08-26 — `5 post` is the standing target, and it is bloom at strength 0.001

**MEASURED with SMAA off:** `5 post` = **11.59 ms at deep_space = 81% of gpuTotal**, 9.83 (54%) at earth_4100,
7.77 (14%) at earth_8. ⚠ It is **flat across all 14 scenarios** while every other pass scales ~20× with scene
content — the signature of a fixed, resolution-driven cost. The output transform alone should be <0.5 ms at
5.4 Mpx, so **bloom is ~11 ms** — for `bloom(exposed, 0.001, 0, 1)`: strength 0.001, radius 0, deliberately
tuned down by the author because it was too strong.

⚠ three's `BloomNode` **does** downsample correctly (starts at W/2, halves per mip). I hypothesised it did not,
then read the source: blur pixels are only **3.63 Mpx** against a 5.45 Mpx frame. **The cost is ~49 M DEPENDENT
texture fetches** across kernel radii `[6,10,14,18,22]` in `Loop()`s whose bound is a NODE (`int(kernelRadius)`)
and so may not unroll. **Latency-bound, not fill-bound** — the same conclusion the atmosphere march reached, and
the same reason a resolution cut under-delivers there.

Fix options, cheapest first: feed `bloom()` a half-res input (all its mips shrink 4×); or replace it with a cheap
custom glow (downsample + 2 blurs, Kawase/dual-filter). ⚠ Both change the LOOK of a tuned value — not a silent
change.

### SMAA measured +4.19 ms and fixed nothing reported → default OFF

Enabling post-tonemap SMAA moved `5 post` by **+3.51 … +4.80 ms (mean +4.19)** across all 12 scenarios, ~24% of
the earth_8 budget. Its `render:RTT` blit is the giveaway in `env.unlabeledPasses`. It was added for a real
effect — MSAA resolves in linear HDR with the tone curve after, so on a high-contrast edge its first coverage
step measures **73% of the whole output range** — but the aliasing actually reported was atmosphere march
banding (D14d), fixed by a jitter for ~0 ms.

### ⚠ Reading `gpuTotalMs` vs `frameMs`

`gpuTotalMs` still exceeds `frameMs` (2.13× at deep_space). **GPUs pipeline across frames, so pass spans from
consecutive frames overlap and sum past the frame interval — this does NOT require saturation** (measured while
hitting 120 fps with zero dropped frames). Per-pass numbers are SPANS, not an additive budget; compare them to
each other and across runs. A secondary suspect is an unexcluded CONTAINER context (see `CONTAINER_NAMES` in
`perfProfiler.ts`) — but three's `Render Pipeline` container measured ~0 ms of its own, so excluding it moved the
post bucket by 0.1 ms. ⚠ And at 120 fps with 0 dropped frames the frame is **vsync-capped**, so `frameMs` reveals
no headroom at all there: the only scenarios with a readable budget are those actually missing vsync.
