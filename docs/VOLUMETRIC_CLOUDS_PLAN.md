# Volumetric Clouds — Nubis-tier Roadmap

Path to AAA-grade volumetric clouds on Earth (and later other planets), targeting **photorealistic Horizon Zero Dawn quality** at **120 FPS on M2 Pro**.

Reference: Andrew Schneider, *"Real-Time Volumetric Cloudscapes of Horizon: Zero Dawn"*, SIGGRAPH 2015 / GDC 2017. The Nubis system is the canonical implementation; everything below is an adaptation of those techniques to WebGPU + TSL.

---

## Where we are (2026-05-06)

> **Architecture pivot — Phase G complete.** The cloud pass no longer
> renders onto a sphere shell; it's a fullscreen-quad ray-march that
> preserves per-pixel cloud-front depth (real 3D parallax under camera
> motion, prerequisite for seamless orbit-to-surface flythrough). Shell
> path removed. See `docs/CLOUD_FULLSCREEN_MIGRATION.md` for the
> rationale and the *Phase G* section below.

The baseline volumetric system is **shipped and looks decent**. Steps 1–6, the first round of visual tuning, Phases A–C (sans C4 curl advection), Phase G (fullscreen migration), and most of Phase D (TAA, with caveats) are done.

### Built

- **Fullscreen ray-march** (Phase G): `PlaneGeometry(2,2)` quad in dedicated `cloudScene` + `OrthographicCamera`; per-pixel `screenUV → NDC → rdView (FOV-based) → rdWorld → rdEarth` reconstruction. Per-pixel cloud-front depth (real parallax). Half-res `HalfFloatType` RT (ping-pong pair for D1).
- **Premultiplied alpha pipeline** end-to-end: `(ONE, 1-α)` blending, bilinear upsample on a premultiplied texture in the composite pass.
- **Analytic ray-shell intersection** with a "below-inner-shell" branch so the slab is still marched correctly when the camera flies under 1 km altitude.
- **Two-state adaptive march** (Phase C1+C2): skip mode at `dtSkip = slab/16` with cheap base-only probe; on first hit, half-step rewind into dense mode at `dtDense = dtSkip/4`; `EMPTY_THRESHOLD=8` consecutive empty samples drop back to skip mode. `MAX_PRIMARY_STEPS=96`, `MIN_STEP_SCALED` floor for grazing rays.
- **Slab-midpoint caches**: weather-map UV, coverage, sun-zenith dot, daylight/sunset terms all computed once per fragment (≪ 0.13° angular drift across the slab).
- **128³ RGBA8 base volume** (Phase A1, `noiseVolumes.ts`): R = pure low-freq Perlin macro shape (avoids cellular GPU-mip artefacts); GBA = three Worley FBM bands at progressively higher octaves [4,8,16] / [8,16,32] / [16,32,48]. Hand-built mip chain.
- **32³ RGBA8 detail volume** (Phase A2): three independent Worley octaves [4, 8, 16] in RGB; A unused (WebGPU drops RGBFormat).
- **Schneider density pipeline** (Phase A3–A5, B3): `baseFbm = 0.625·G + 0.25·B + 0.125·A`; `baseShape = (R + 1-fbm) / (2-fbm)`; `baseCloud = baseShape · coverage`; detail erosion with edge-weighted strength (floor 0.35 in cores, ramps to 1.0 at silhouette edges) and altitude-modulated FBM inversion (raw FBM low, `1-fbm` high). Per-column cloud-top altitude `topAlt` sampled from baseVolume.r Perlin at column projection (`uColumnScale`), driving the cloud-type vertical profile.
- **Cloud-type vertical profile** (Phase B1+B2): base band [0.05–0.45] + top band [0.4 → topAlt], BASE_WEIGHT=0.5, TOP_WEIGHT=2.0 to bias visible cloud-top altitude toward the topAlt-driven upper region.
- **Cone-traced light march** (Phase C3): 6 stratified samples toward the sun with a pre-baked low-discrepancy 3D kernel, scaled by step distance so the cone widens with depth. Coverage cached from slab midpoint.
- **Sun colour & terminator**: asymmetric `daylight = smoothstep(-0.1, 0.5, sunDotPoint)` (tight night cutoff, wide day falloff); `sunset = 4·d·(1-d)` tent. Sun colour multiplier 21× HDR; skylight 0.45×daylight. Multi-scatter via Wrenninge's `pow(Tsun, 0.15) · 0.7`. Powder term active.
- **Distance crossfade with flat overlay**: `uVolumetricBlend` uniform ramps `(35k - distKm) / 10k` clamped 0..1.
- **TAA** (Phase D, partial — see "Done differently" below): ping-pong RTs (D1), Halton(2,3) sub-pixel jitter on ray origin (D2), camera-motion reprojection via outer-shell intersection (D3 substitute), motion×alpha disocclusion gate (D4/D7 single-pass approximation), 0.95 history blend (D6), animated sin-hash dither phase to converge across frames.
- **Performance**: easily 120 FPS on M2 Pro (frame cap; we have substantial headroom).

### Done differently / partial

- **Phase D3 — per-pixel cloud-front reprojection depth.** Plan called for MRT (RGBA + R32F secondary) so reprojection samples history at the *true* cloud-front t. **MRT abandoned** because TSL's `Fn(...)` wrapper strips `isOutputStructNode`, and `NodeMaterial` path B requires that flag for MRT setup. Substitute is **analytic outer-shell t** (radius R+14 km) — adequate at orbital distance, will under-reproject parallax up close. Marcher already returns `tFront` (sentinel −1 = no hit) for future re-attempt. Re-enabling needs splitting the cloud pass into a marcher-pass + TAA-composite-pass.
- **Phase D5 — 1/16 stratified pixel schedule.** **Skipped.** Currently every pixel marches every frame; only sub-pixel jitter + history blend is active. The 16× perf reduction lever is unused — but isn't needed (we're at 120 FPS already with substantial headroom).
- **Phase D7 — variance clamping.** Implemented as **single-pass motion×alpha logical-AND gate** in `cloudFullscreenPass.ts`, not a true 3×3 neighbourhood clamp (which would require the same two-pass split as MRT D3). v3 holds up empirically as of 2026-05-06.
- **Cloud type axis** (Phase B1). Plan called for `stratus / stratocumulus / cumulus` with three discrete profiles; built version is a single base+top decomposition with per-column `topAlt` Perlin variation, which functionally produces the same height variety without the discrete-type complexity.

### Not built yet

- **C4** Curl-noise UV advection (organic detail-UV drift; the only Phase C item still missing). Domain warp on the weather-map UV is currently disabled (`uvWarped = uvMid`, line 499) because the previous warp source baked detail-volume Worley cells into weather sampling — fresh implementation required.
- **D3 (proper)** Per-pixel cloud-front depth via MRT or two-pass cloud pipeline.
- **D5** Stratified 4×4 march schedule (deferred, not currently needed for perf).
- **D7 (proper)** True 3×3 neighbourhood variance clamp.
- **D — floating-origin invalidation** Hook into `worldOrigin` rebase events to clear history RT.
- **Bilateral / depth-aware upsample** (only relevant if half-res is kept — currently it is).
- **E1** Shell-shadow RT (replacing the surface shader's 2-tap cloud-shadow trick).
- **E3** Aerial perspective coupling (Rayleigh attenuation on cloud colour using `tFront`).
- **E4** Optional dual-lobe HG.
- **F1** Generalisation to `volumetricCloudShell.ts` + `VolumetricCloudConfig` (per-planet).
- **F2** Quality tiers (low/medium/high pipeline variants).
- **F3** Pre-warm shader compile.
- **F4** Venus port (validation of the config abstraction).

### Files involved

| File | Purpose |
|------|---------|
| `src/components/celestial/bodies/earthClouds.ts` | Earth-side cloud setup + the geometry-agnostic `marchCloudVolume` TSL function. **Heart of the work.** |
| `src/components/space/cloudFullscreenPass.ts` | Fullscreen-quad cloud pass: scene + ortho camera + ray reconstruction (FOV-based) + uniform plumbing. Calls `marchCloudVolume`. |
| `src/components/celestial/bodies/earth.ts` | Surface shader; owns `uVolumetricBlend`; flat overlay fade. |
| `src/components/celestial/bodies/noiseVolumes.ts` | 128³ RGBA base volume + 32³ RGB detail volume generators. |
| `src/components/space/SpaceRenderer.tsx` | Multi-pass orchestration: scaled background → cloud fullscreen pass → composite → local scene → postFX. |
| `src/components/space/renderLayers.ts` | `CLOUD_LAYER` (now used only to isolate the matrixWorld anchor mesh from rendering). |

---

## Architecture overview

```
┌─────────────────── Frame ───────────────────┐
│                                             │
│  scaledScene  → rt (full-res, depth)        │  Pass 1: planets, skybox, stars
│                  ↑ no clouds                │
│                                             │
│  cloudShell  → cloudRt (half-res)           │  Pass 2: volumetric clouds only
│                  premul α, depth ignored    │
│                                             │
│  cloudRt → rt (composite, ONE/1-α)          │  Pass 3: bilinear upsample
│                                             │
│  localScene → rt (depth-cleared)            │  Pass 4: ship, asteroids, beam
│                                             │
│  pipeline.render() → canvas                 │  PostFX: bloom + tonemap
│                                             │
└─────────────────────────────────────────────┘
```

The Nubis architecture slots in **between Pass 2 and Pass 3** — the cloud RT becomes a *temporally accumulated* full-res image, with current-frame samples sparsely contributing into a history RT.

---

## Gap analysis — current vs Nubis

| Subsystem | Nubis | Current | Gap |
|---|---|---|---|
| Base volume | 128³ RGBA: Perlin-Worley + 3 Worley octaves | 64³ R: single Worley | **Big** |
| Detail volume | 32³ RGB: 3 Worley octaves at high-freq | none | **Big** |
| Coverage / weather | RGBA: coverage, type, height, wetness | R only (8k) | Medium |
| Density model | Type-aware vertical profiles, Schneider remap | Symmetric height curve, single profile | Medium |
| Phase | HG g=0.6, optional dual-lobe | HG g=0.6 | Tiny |
| Light march | 6 cone samples, multi-octave | 3 linear samples | Medium |
| Primary march | 64–128 adaptive | 16 fixed | **Big** |
| Empty-space skip | 2-state (skip / density) | 1-tap mid-coverage gate + step-level coverage gate | Medium |
| Animation | Curl noise UV warp + UV scroll | Static | Medium |
| **Temporal** | Halton jitter + 4×4 reproject + history blend | None | **Huge** |
| Upsample | Depth-aware bilateral or 1:1 (post-temporal) | Bilinear | Small (post-D) |
| Surface shadows | Sun-projected shell-shadow RT | 2-tap surface trick | Small |
| Atmosphere coupling | Aerial perspective fog into clouds | None | Small |

The visible "low-res / not photoreal up-close" complaint maps directly to the three **Big**/**Huge** gaps: detail noise, more steps, and temporal reprojection.

---

## Phase A — Volume authoring (the missing fluff) *(complete)*

> **Status:** built. See `noiseVolumes.ts` (`generateBaseVolume`, `generateDetailVolume`)
> and the Schneider density pipeline in `earthClouds.ts:marchCloudVolume` (lines
> 657–725 in the current file). The build differs from the original sketch in
> two places: the base-volume R channel is **pure Perlin** (not Perlin-Worley
> blend) because Worley at any scale produces visible cells in the GPU's fine
> mip levels at close camera ranges; cellular character is deferred to the
> GBA Worley FBM channels and reintroduced via the Schneider remap. Detail
> erosion uses **edge-weighted strength** (floor 0.35 in cores, ramp to 1.0 at
> silhouette edges) and **altitude-modulated FBM inversion** so high-altitude
> remnants poke up like puffy tops.

**Goal**: replace the single 64³ Worley with the full Nubis noise pipeline. This phase alone closes ~50 % of the visual gap.

### A1. Generate 128³ RGBA8 base volume

Refactor `cloudNoise.ts` → `noiseVolumes.ts` (rename), exporting `getCloudBaseVolume()` and `getCloudDetailVolume()`.

- **R channel**: Perlin-Worley combination. Take inverted Worley (current behaviour) and remap with a low-frequency Perlin: `pwl = remap(perlin, 0, 1, worley, 1)`. This is what gives Nubis its bumpy-but-puffy base — pure Worley alone is too "cellular".
- **G channel**: Worley FBM at base frequency (3 octaves, lacunarity 2, gain 0.5).
- **B channel**: Worley FBM at 2× base frequency.
- **A channel**: Worley FBM at 4× base frequency.
- All inverted (1 - distance) and tileable via the existing wrap-around `((n % GRID) + GRID) % GRID` pattern.

Memory: 128³ RGBA8 = 8 MB. Acceptable. Generation cost: ~200–400 ms one-time at boot (current 64³ is ~50–80 ms). Move generation into a `setTimeout(0)` chunk after first frame so it doesn't block startup.

Mip chain: keep the manual `downsample3D` with per-channel averaging.

### A2. Generate 32³ RGB detail volume

`getCloudDetailVolume()` — small, high-frequency.

- **R/G/B**: 3 octaves of Worley FBM, each at progressively higher frequency. Tiles aggressively.
- 32³ × RGB8 = 96 KB. Fits in L1 cache effortlessly.

### A3. Wire both volumes into shader

`buildEarthCloudShell` accepts both volumes; pass the detail volume as a second `texture3D` uniform. Replace existing single-tap noise pattern.

### A4. Sample base correctly

Replace `noise = texture3D(noiseVolume, p * uNoiseScale).r` with:

```ts
const baseSample = texture3D(baseVolume, p.mul(uBaseScale));
// Schneider FBM weighting: 0.625 R + 0.25 G + 0.125 B (or similar)
const baseFbm = baseSample.g.mul(0.625)
  .add(baseSample.b.mul(0.25))
  .add(baseSample.a.mul(0.125));
// Combine the Perlin-Worley macro shape with the FBM detail
const baseShape = baseSample.r.sub(float(1).sub(baseFbm)).max(0);
```

This produces visibly different-shaped cloud bodies depending on coverage region — exactly what's missing currently.

### A5. Detail erosion (Schneider remap)

Sample the detail volume at high freq and erode the base **only at edges**:

```ts
const detailFbm = detailSample.r.mul(0.625)
  .add(detailSample.g.mul(0.25))
  .add(detailSample.b.mul(0.125));
// Schneider's "remap" trick: the detail texture compresses the low end of base,
// which carves out fine wisps without hollowing dense cores.
const detailErosion = mix(detailFbm, detailFbm.oneMinus(), edgeMask);
const finalDensity = remap(baseShape, detailErosion.mul(uDetailErosion), 1, 0, 1).max(0);
```

Where `edgeMask` is roughly `1 - smoothstep(0.5, 0.7, baseShape)` — only the silhouette gets carved.

**Risk**: detail erosion is the technique most sensitive to noise frequency tuning. Budget half a day for the visual pass.

**Performance**: +1 `texture3D` tap per primary step in dense regions (gated behind the cheap-tap-first guard). Net impact at 16 steps and current density: ~+0.2 ms.

---

## Phase B — Density model upgrade *(complete, with simpler axis)*

> **Status:** built. The `cloudHeightProfile` function in `earthClouds.ts`
> (lines 179–187) is a base-band + top-band decomposition with per-column
> `topAlt` derived from a Perlin sample of `baseVolume.r` at the column's
> projection onto the inner shell (`uColumnScale` uniform). This produces
> visibly different cloud-top altitudes per column (range 0.4 → 0.95
> normalised, ≈ 7.2 km vertical span) without the explicit
> stratus/stratocumulus/cumulus axis. `BASE_WEIGHT=0.5`, `TOP_WEIGHT=2.0`
> bias visible cloud-top toward the topAlt-driven upper region. The
> Schneider density remap (B3) is the eroded-line in lines 720–725.
> A weather-map RGBA re-encoding (B2 "Full") was deferred — current
> single-channel coverage is sufficient.

**Goal**: Different cloud regions look like *different cloud types*, not the same texture extruded.

### B1. Cloud-type-aware vertical profile

The current height gradient is symmetric (`hRamp · hFade`). Real clouds aren't: stratus is flat-bottomed and flat-topped, cumulus has a high anvil, stratocumulus is wide and lumpy.

Add an analytic profile per cloud type:

```ts
// cloudType ∈ [0,1]: 0=stratus, 0.5=stratocumulus, 1=cumulus
function densityHeightProfile(altitude01, cloudType) {
  const stratus = saturate(remap(altitude01, 0, 0.1, 0, 1))
                 * saturate(remap(altitude01, 0.2, 0.3, 1, 0));
  const stratocumulus = saturate(remap(altitude01, 0, 0.25, 0, 1))
                      * saturate(remap(altitude01, 0.45, 0.65, 1, 0));
  const cumulus = saturate(remap(altitude01, 0, 0.4, 0, 1))
                * saturate(remap(altitude01, 0.6, 0.95, 1, 0));
  return mix(mix(stratus, stratocumulus, smoothstep(0, 0.5, cloudType)),
             cumulus, smoothstep(0.5, 1, cloudType));
}
```

### B2. Cloud-type encoding in weather map

Two options, in order of effort:

- **Cheap (start here)**: derive cloud type procedurally from coverage. `cloudType = smoothstep(0.4, 0.8, coverage)` — denser regions read as cumulus, sparser as stratus. Free, no asset work.
- **Full (later)**: re-author the weather map to RGBA. R = coverage, G = type, B = height-offset bias, A = unused. The existing `earth_clouds_8k.ktx2` is single-channel; would need re-export. Defer until visual tuning shows we need the control.

### B3. Density remap (Schneider style)

Replace the linear erosion with the textbook remap. This handles "detail subtracts at edges, leaves cores alone" automatically:

```ts
finalDensity = remap(saturate(baseShape * coverage), detailFbm * edgeMask, 1, 0, 1) * heightProfile * uDensityMul;
```

Lifting `heightProfile` outside the `coverage * baseShape` product means cumulus-shaped clouds get the cumulus bottom-up bulge regardless of coverage value — fixes the "all clouds look like the same flat slab" complaint.

**Performance**: math-only changes after Phase A. ~+0.05 ms.

---

## Phase C — March quality *(C1–C3, C5 complete; C4 pending)*

> **Status:** C1 (two-state adaptive march), C2 (`MAX_PRIMARY_STEPS=96`,
> `dtSkip = slab/16`, `dtDense = dtSkip/4`), C3 (6-tap cone-traced light
> march with low-discrepancy 3D kernel) and C5 (whole-column + per-step
> empty-space gates) are all in `earthClouds.ts:marchCloudVolume`.
> **C4 (curl-noise UV advection) is the only Phase C item still missing.**
> The previous static domain-warp on the weather-map UV is currently
> disabled (`uvWarped = uvMid`, line 499) because its detail-volume Worley
> source baked cellular structure into weather sampling. A clean curl-noise
> implementation should advect the **detail UV**, not the weather UV, and
> use a pre-baked curl volume (separate from the existing detail volume).

**Goal**: more samples where they matter (inside cloud bodies), fewer where they don't (clear sky). Current 16-step uniform march is the proximate cause of "blurry close-up".

### C1. Two-state adaptive march

The Nubis pattern: every ray has two modes, controlled by a state variable:

- **Skip mode** (default): step length = `dt_long` (~2× current). Sample only the cheap base shape, no detail. If density > 0, switch to dense mode and **back up** half a step.
- **Dense mode**: step length = `dt_short` (~0.5× current). Sample full density (base + detail erosion). If density falls back to 0 for N consecutive steps, return to skip mode.

Translates to TSL like:

```ts
const stepMode = float(0).toVar(); // 0 = skip, 1 = dense
const t = tStart.toVar();
const consecutiveEmpty = float(0).toVar();

Loop(MAX_STEPS, () => {
  If(t.greaterThan(tExit), () => Break());

  const dt = stepMode.equal(0).select(dtLong, dtShort);
  const p = ro.add(rd.mul(t));

  // Cheap base-only sample
  const baseDensity = sampleBase(p);

  If(baseDensity.greaterThan(eps), () => {
    If(stepMode.equal(0), () => {
      // First hit: rewind half a long step, switch mode
      t.subAssign(dtLong.mul(0.5));
      stepMode.assign(1);
      consecutiveEmpty.assign(0);
    }).Else(() => {
      // Already dense — full sample with detail, accumulate
      const fullDensity = applyDetail(baseDensity, p);
      accumulate(fullDensity);
      consecutiveEmpty.assign(0);
    });
  }).Else(() => {
    consecutiveEmpty.addAssign(1);
    If(consecutiveEmpty.greaterThan(2), () => stepMode.assign(0));
  });

  t.addAssign(dt);
});
```

WebGPU caveat: `MAX_STEPS` must be a compile-time constant. Set it generously (e.g. 96) — the early `Break` on `tExit` and `T < 0.01` keeps real cost bounded.

### C2. Bump primary steps

Set `PRIMARY_STEPS = 96` (max; actual cost is gated by adaptive stepping + early-out). Skip mode in fully-empty columns terminates in ~7 long steps.

### C3. Cone light march

Replace the linear 3-step march toward the sun with 6 samples spread in a cone. Each sample is offset slightly perpendicular to the sun direction, sampling a small neighbourhood:

```ts
const coneOffsets = [
  vec3( 0.30, 0.00,  0.00), vec3(-0.30, 0.10,  0.00),
  vec3( 0.00, 0.30,  0.00), vec3( 0.10,-0.30,  0.10),
  vec3( 0.00, 0.00,  0.30), vec3( 0.10, 0.10, -0.30),
];
Loop(LIGHT_STEPS, ({ i }) => {
  const stepDist = float(LIGHT_STEP_SCALED).mul(float(i).add(0.5));
  // Cone widens with distance
  const conePerturb = coneOffsets[i].mul(stepDist).mul(uConeRadius);
  const pL = p.add(sunDirLocal.mul(stepDist)).add(conePerturb);
  // ... sample density at pL
});
```

The neighbourhood sampling smooths the per-pixel transmittance variance, which removes the "speckled" look common to short light marches.

Last sample (longest step) can drop detail noise — Schneider does this for cheap multi-octave lighting.

### C4. Curl-noise UV advection

To kill the "static texture" look, add curl-noise advection of the **detail noise UV** (not the base — base movement is too obvious):

```ts
const flowVec = curlNoise(p * uFlowScale + uTime * uFlowSpeed);
const pDetail = p.mul(uDetailScale).add(flowVec.mul(uFlowAmount));
const detailSample = texture3D(detailVolume, pDetail);
```

Curl noise = ∇ × noise; gives divergence-free flow that looks organic. Can pre-bake a curl-noise volume (R8G8B8) at boot, same pattern as base.

Drive `uTime` from sim time (slow drift, ~1/300 of camera relative motion).

**Performance impact**: +1 `texture3D` tap per detail sample (curl read). ~+0.1 ms.

### C5. Tighten empty-space skip

Current skip is "midpoint coverage < 0.01 → no march". Phase C1 makes this more granular but we should still gate the *whole shell* against coverage at the slab midpoint to short-circuit clear-sky pixels at zero cost.

---

## Phase D — Temporal reprojection (the AAA layer) *(D1, D2, D6 complete; D3/D4/D7 done differently; D5 skipped)*

> **Status, as built (2026-05-06):**
> - **D1** ping-pong RTs in `SpaceRenderer.tsx` (`cloudRts[2]`, `frameParity` ref, two pre-built composite meshes swapped via `mountedCompositeMesh`).
> - **D2** Halton(2,3) sub-pixel jitter on ray origin (16-entry table at module scope, `uJitterUv` uniform). Animated `uDitherPhase` derived from jitter so the dither term in the marcher varies frame-to-frame and converges under TAA.
> - **D3** Camera-motion reprojection uses **analytic outer-shell t** as a substitute for per-pixel cloud-front depth. MRT was attempted and abandoned (TSL `Fn(...)` wrapper strips `isOutputStructNode`, breaking NodeMaterial path B). Marcher returns `tFront` (sentinel −1 = no hit) for future re-enablement via a two-pass split. Adequate at orbital distance; will under-reproject parallax up close.
> - **D4** Disocclusion gating implemented as **motion×alpha logical-AND** (not the canonical offscreen + worldPos-delta + alpha-mismatch trio). Floating-origin rebase invalidation **not yet hooked up**.
> - **D5** Stratified 1/16 schedule **skipped** — every pixel marches every frame. Lever unused; not currently needed for perf.
> - **D6** Reconstruction blend at 0.95 history weight, premultiplied-alpha mix.
> - **D7** Variance clamp implemented as **single-pass motion×alpha gate** (cf. D4) instead of true 3×3 neighbourhood clamp. v3 holds up empirically. Two-pass split (marcher → currentRt, separate TAA composite reading 3×3 currentRt + historyRt) is the path to a proper variance clamp; deferred until visibly required.
>
> The reprojection logic lives in `cloudFullscreenPass.ts`; ping-pong orchestration and uniform plumbing in `SpaceRenderer.tsx`.

**Goal**: render `1/16` rays per frame, reuse history for the rest. This is the single biggest engineering lift but unlocks Nubis-tier visual quality at a fraction of the per-frame compute.

The principle: the cloud RT already exists. Add a *history* RT, and each frame:
1. Render only `1/16` of pixels in a stratified pattern (4×4 Bayer).
2. Reproject the history RT into the current frame using camera motion.
3. Blend new samples over reprojected history with high temporal weight (~0.95).

After 16 frames every pixel has been resampled at least once, and the cloud image is full-quality at full res, but per-frame fragment count is `(width × height × 1/16)` — a 16× reduction.

### D1. History RT infrastructure

Two RTs ping-pong (read prev, write next).

```ts
const cloudRtA = new RenderTarget(fullWidth, fullHeight, { type: HalfFloatType });
const cloudRtB = new RenderTarget(fullWidth, fullHeight, { type: HalfFloatType });
let frameParity = 0;
// each frame: src = parity===0 ? A : B; dst = the other
```

**Note**: half-res is no longer needed (or even desired) once temporal is on — D handles the perf, not the resolution drop. Lift back to full res at this point.

The cloud RT now must store `(R, G, B, α, depth_or_t)` — the front-of-cloud t value is needed for reprojection. Either pack into the alpha channel (16-bit float depth — sufficient) or use a 5-channel RT (RGBA + R32F secondary).

### D2. Halton jitter

Each frame, jitter the ray origin sub-pixel by `(haltonX[frame % 16], haltonY[frame % 16])`. Halton(2,3) sequence gives low-discrepancy stratification — better than random, much better than Bayer for spatial coverage convergence.

In TSL: pass jitter as a 2D uniform updated each frame from a precomputed 16-entry table.

```ts
const sampleJitter = uniform(new THREE.Vector2());
// in onFrame:
sampleJitter.value.set(haltonX[frameIndex], haltonY[frameIndex]);
// in shader:
const jitteredFragCoord = screenCoordinate.xy.add(sampleJitter);
```

### D3. Camera-motion reprojection

Each frame, store the previous frame's combined view-projection matrix (camera position + orientation in scaled-world space).

In the cloud shader:
1. Compute the world-space position of the cloud sample at front-of-cloud t (from the new RGBA + t output).
2. Project that world position through `prevViewProjection` → previous-frame UV.
3. Sample history RT at that UV.

```ts
const worldPos = cameraPosition.add(rdLocal.mul(tFrontCloud));
const prevClip = prevViewProjMat.mul(vec4(worldPos, 1));
const prevUv = prevClip.xy.div(prevClip.w).mul(0.5).add(0.5);
const history = texture(prevCloudRt, prevUv);
```

Three-js / R3F pattern: store prev VP matrix in a ref, update at end of useFrame.

### D4. Disocclusion handling

History sample is invalid if:
- `prevUv` is outside `[0, 1]` (off-screen last frame)
- `length(prevWorldPos - currentWorldPos) > threshold` (camera teleport — floating origin recentre triggers this)
- `historyAlpha == 0 && currentAlpha > 0` or vice versa (cloud silhouette change, e.g. frame after Earth rotation moved a cloud across the limb)

When invalid, skip the history blend; output the new sample at full weight. Causes a transient blocky frame on disocclusion — acceptable, and the next 16 frames repair it.

**Floating origin caveat**: when `worldOrigin` rebases (>10 000 km drift), the entire history is invalid. Detect rebase and clear history RT.

### D5. 4×4 stratified pixel schedule

Two implementation options:

- **Stochastic schedule**: each fragment computes `marchThisFrame = (frameIndex % 16) == hash(pixelX, pixelY) % 16`. If false, skip the march entirely, just reproject history.
- **Geometric schedule**: render the cloud shell at 1/4 × 1/4 size each frame, composite into the full-res RT at the correct 4×4 pixel pattern. More complex but exactly matches Nubis.

Start with the **stochastic schedule** — simpler, single shader, no extra RTs.

### D6. Reconstruction blend

```ts
const valid = isHistoryValid;
const alpha = valid.select(0.95, 0); // exponential history weight
const finalRgba = mix(currentRgba, historyRgba, alpha.mul(marchedThisFrame.oneMinus()));
```

Marched-this-frame pixels: replace history with new sample.
Not-marched pixels: copy history forward (subject to disocclusion).

The 0.95 history weight gives a 16-frame effective integration window; tune for ghosting vs noise.

### D7. Variance clamping (anti-ghost)

Sample the 3×3 neighbourhood of the current frame in the cloud RT, clamp the historical sample to `mean ± k·stddev`. Standard TAA technique; eliminates ghosting on fast-moving silhouettes (e.g. fast camera pan across cloud edge).

**Performance impact of Phase D**: this is where you spend perf to *save* perf. The march is now done at 1/16 cost (huge net win), but we add: 1× history texture lookup, 1× matrix multiply, 1× 3×3 neighbourhood sample for variance clamp. Net: cloud cost drops from current ~1–2 ms to **~0.3–0.5 ms** at full res.

**Risks**:
- Ghosting on high-motion scenes (fast yaw/pitch): variance clamp mitigates but not perfectly.
- Disocclusion artefacts at silhouettes: fall back to current-frame at full weight.
- Floating-origin rebases need explicit history invalidation.
- `prevViewProjection` must be stored in scaled-world coordinates (the same frame the cloud march operates in).

---

## Phase E — Polish

### E1. Shell-shadow RT

Replace the surface shader's two-tap cloud shadow trick with a real shell-derived shadow:

- Allocate a 256×256 (or 512²) `R8` RT.
- Render the cloud shell into it from a **sun-positioned orthographic camera** (looking at Earth's centre), accumulating transmittance into the R channel.
- Sample this RT in `earth.ts`'s surface shader at the world-space surface point projected back into the sun-camera's UV space.

Cost: one extra render pass per frame, but at very low resolution and with shorter march budget (8 primary steps is plenty for shadow accuracy).

Visual win: cloud shadows on the ground match the 3D cloud shapes pixel-perfectly, including silver-lining gaps. Currently the surface shadow is a blurred copy of the 2D weather map — different shape from the volumetric cloud silhouette, which is the visible mismatch.

### E2. Bilateral upsample (only if needed)

Phase D returns clouds to full-res. If for any reason we keep half-res (perf emergency), add a depth-aware bilateral upsample using the cloud-front t channel: the upsample weights neighbour samples by t-distance, which keeps silhouettes sharp at planet limbs and against atmospheric haze.

Skip otherwise.

### E3. Aerial perspective coupling

Apply atmospheric Rayleigh attenuation to the cloud colour based on `tFrontCloud`:

```ts
const aerialFog = computeRayleighTransmittance(roLocal, rdLocal, tFrontCloud);
col.assign(col.mul(aerialFog).add(rayleighInscatter));
```

Makes distant clouds blend into the atmosphere — Earth from orbit at the limb gets the realistic blue-haze cloud look. Reuses Earth surface's existing Rayleigh constants.

### E4. Phase function tuning

Optional dual-lobe HG: `phase = mix(HG(g_forward = 0.8), HG(g_back = -0.3), 0.5)`. The back-scatter lobe gives the "halo" effect when the sun is behind clouds. Schneider doesn't bother; we can add if visual taste calls for it.

---

## Phase G — Full-screen ray-march migration *(complete)*

> Detailed plan: `docs/CLOUD_FULLSCREEN_MIGRATION.md`.

**Why.** The sphere-shell approach rasterises cloud alpha at the outer-shell
altitude (14 km), so even though each fragment's analytic ray hit produces a
unique cloud-front depth internally, that depth never reaches the screen —
camera motion shifts every shell fragment by the same amount, regardless of
which cloud body the ray actually hit. This kills 3D parallax, which
seamless orbit-to-surface gameplay requires.

**What changed.**
- Cloud rendering moved from a `BackSide` `SphereGeometry` shell on
  `CLOUD_LAYER` to a fullscreen `PlaneGeometry(2,2)` quad in its own
  `cloudScene` + `OrthographicCamera`.
- Ray reconstruction inside the fragment shader: `screenUV → NDC.xy →
  rdView (FOV-based, no projection inversion to avoid float32 precision
  loss at our 2 × 10⁹ far/near ratio) → rdWorld via cameraMatrixWorld →
  rdEarth via uEarthInverseModel`.
- The marcher (`marchCloudVolume` in `earthClouds.ts`) was extracted as a
  pure, geometry-agnostic TSL function — same intersection math, same
  adaptive march, same cone-traced light, same DEBUG_VIZ modes.
- A tiny anchor mesh (empty geometry + material on `CLOUD_LAYER`) lives
  inside Earth's rotation group purely so `mesh.matrixWorld` updates each
  frame, feeding `uEarthInverseModel`. No camera enables `CLOUD_LAYER`, so
  it never renders.
- Diagnostic toggle `DEBUG_FULLSCREEN` in `cloudFullscreenPass.ts`
  preserved (off by default) for future ray-reconstruction debugging.

**Acceptance criterion met.** Camera-motion parallax — tall and short cloud
features shift across the screen at noticeably different rates during pan,
which the shell version fundamentally could not produce.

**Unblocks.**
- Phase D (temporal reprojection) — natural fit on top of per-pixel rays.
- Phase E3 aerial perspective coupling — per-pixel cloud-front depth is
  now available for atmosphere fog integration.
- Per-planet config (old Phase F1) re-applies on top of the fullscreen
  pass instead of a per-planet shell.

**Deferred / follow-ups.**
- *Cloud-tops look 2D-from-above* — orthogonal to G. The bulk-layer
  flatness traces to alpha saturating before the topAlt-driven top band
  contributes; rays plunge through the variable upper region without it
  registering visually. To address: stronger top-band density or a
  profile that makes tall columns dominate the integrated alpha first.
- *Pixel-locked dither dots at close range* — same screen-space hash as
  the shell version had. Phase D (TAA) erases this.
- G5 planet-occlusion test (clamp `tExit` to a planet-surface intersection
  for downward rays from low altitude) — defensive cleanup, not yet
  needed because the slab inner radius already matches `PLANET_RADIUS_KM
  + 1 km`. Add when the gameplay layer drops below 1 km.

## Phase F — Productionise

### F1. Generalise the cloud pass — *superseded by Phase G*

> **Status:** superseded 2026-05-05 by the full-screen quad migration
> (`docs/CLOUD_FULLSCREEN_MIGRATION.md`). The cloud pass no longer lives on a
> sphere shell mesh — it's a fullscreen ray-march in
> `src/components/space/cloudFullscreenPass.ts`, driven by the geometry-
> agnostic `marchCloudVolume` in `src/components/celestial/bodies/earthClouds.ts`.
> Per-planet generalisation (Venus, etc.) re-applies on top of that file
> rather than the original `volumetricCloudShell.ts` extraction sketched
> below — same config shape, different mount point.

Original sketch (kept for reference when porting to other planets):

Extract the shader into `src/components/celestial/shaders/volumetricCloudShell.ts` with a config:

```ts
type VolumetricCloudConfig = {
  innerRadiusKm: number;
  outerRadiusKm: number;
  weatherMap: THREE.Texture;             // R = coverage; later RGBA
  baseVolume: THREE.Data3DTexture;
  detailVolume: THREE.Data3DTexture;
  curlVolume?: THREE.Data3DTexture;

  baseScale: number;
  detailScale: number;
  detailErosion: number;
  warpAmount: number;
  densityMul: number;

  phaseG: number;
  phaseGBack?: number;                   // optional dual-lobe
  msWeight: number;
  powderStrength: number;

  ambientColor: THREE.Color;
  sunTint: THREE.Color;                  // unlit base
  sunsetTint: THREE.Color;               // terminator

  cloudTypeProfile: "stratus" | "stratocumulus" | "cumulus" | "auto";
  flowSpeed?: number;                    // curl advection rate

  qualityTier: "low" | "medium" | "high";
};
```

Each planet provides its own config. Earth: `{ phaseG: 0.6, msWeight: 0.7, sunTint: ... }`. Venus: `{ phaseG: 0.85 (thicker scatter), msWeight: 0.9, sunTint: yellow, baseScale: smaller (broader cloud bands) }`.

### F2. Quality tiers

WebGPU shader compile cost grows with branching. Pre-compile three pipeline variants:

- **Low**: `PRIMARY_STEPS=32`, `LIGHT_STEPS=2`, no curl, no temporal, half-res. Target older laptops.
- **Medium**: `PRIMARY_STEPS=64`, `LIGHT_STEPS=4`, curl, no temporal, half-res. Default mobile / mid-tier.
- **High**: `PRIMARY_STEPS=96`, `LIGHT_STEPS=6`, curl, temporal, full-res. M2 Pro target.

Settings menu exposes the tier; Jotai atom gates which material is mounted on the shell.

### F3. Pre-warm shader compile

The first close approach to Earth currently triggers a one-time TSL compile hitch. Compile the high-tier pipeline at scene-load time by rendering the cloud shell off-screen for one frame at boot, so first-actual-use is instant.

### F4. Venus port (validation)

Adapt the system to Venus to validate the config abstraction:
- Full-coverage opaque weather map (procedural, not photo-derived)
- Wider slab (50 km)
- Yellow sun tint, higher scatter g
- Lower detail erosion (Venus clouds are smoother)

If Venus needs new config knobs, lift them into the type.

---

## Performance budget

Target: 8.3 ms total per frame for 120 FPS. Cloud cost should stay under **2 ms** to leave headroom for the rest of the renderer.

| Phase | Cumulative cost (M2 Pro, full-res, dense scene) | Comments |
|---|---|---|
| Current baseline | ~1.0–1.5 ms | half-res, 16 primary, 3 light |
| + Phase A (volumes) | ~1.3–1.8 ms | extra 3D taps, gated |
| + Phase B (density) | ~1.3–1.8 ms | math only |
| + Phase C (march) | ~2.0–3.0 ms | 64–96 steps with adaptive; only inside dense regions |
| + Phase D (temporal) | ~0.4–0.7 ms | **drops** because we march 1/16 of pixels |
| + Phase E (polish) | ~0.6–1.0 ms | shadow RT pass + aerial perspective |
| Final at high tier | **~1 ms** | full-res, full-quality, full Nubis feature set |

If profiling shows divergence from these estimates, the levers are: lower `PRIMARY_STEPS`, drop curl noise, lower history weight (hurts quality, raises noise floor).

---

## Risks & open questions

- **TSL `Loop` count must be a compile-time constant.** Adaptive stepping is implemented as a fixed-`MAX_STEPS` loop with `Break`. Verified working in current code; should scale to 96 steps cleanly.
- **WebGPU shader compile time** scales with branch complexity. Phase C's two-state march and Phase D's reprojection logic both add branches. Pre-warm (F3) becomes mandatory, not optional.
- **History RT memory**: full-res RGBA HalfFloat at 1440p × 2 ping-pong = ~32 MB VRAM. Acceptable.
- **Floating-origin invalidation**: Phase D requires explicit history clear on `worldOrigin` rebase events. Hook into the existing `worldOrigin` atom.
- **Halton jitter and AgX tonemapping**: ensure jitter is applied to **ray origin only**, not output colour. Tonemapping happens after composite; jitter must not propagate as colour noise.
- **Disocclusion at floating-origin recentre**: rebase invalidates the entire history RT — first frame post-rebase will show a 1-frame "low quality" render until next 16 frames repopulate.
- **Cloud-front t in alpha channel**: half-float storage gives ~3-decimal precision over the 14 km slab, sufficient for reprojection.
- **Variance clamp is mandatory** for D — without it, fast camera moves ghost badly. Allocate dev-time accordingly.

---

## Implementation order

**Already complete:** A1–A5, B1–B3, C1–C3, C5, G, D1, D2, D6 (and D3/D4/D7
in approximate form). See per-phase status notes above.

**Current target:** *Nubis-quality **static** volumetric clouds.* No
animation, no two-pass TAA architectural rework — push the still-image
quality first; defer animated drift and proper-D3/D7 until the static
look is locked in.

**Remaining queue** (suggested order):

1. **E1** — shell-shadow RT. Replaces the surface shader's 2-tap shadow trick
   with a real cloud-derived shadow. One extra render pass per frame at low
   resolution. Visible win on the ground; biggest still-image quality jump
   left in the queue.
2. **E3** — aerial perspective coupling. Reuses the existing `tFront`
   (already returned by the marcher) plus Earth's Rayleigh constants.
   Distant clouds blend into atmospheric haze — orbital limb gets the
   realistic blue-haze cloud look.
3. **D — floating-origin invalidation**. Hook into the `worldOrigin` rebase
   to clear history RT. Quick correctness fix for TAA.
4. **F1** — generalise to `volumetricCloudShell.ts` + `VolumetricCloudConfig`.
5. **F2–F4** — quality tiers, shader pre-warm, Venus port.

**Deferred** (out of scope for "static Nubis quality"):

- **C4** — curl-noise UV advection (animation). Re-enter when we want clouds
  that visibly evolve while standing still.
- **D — proper D3/D7** (two-pass marcher → TAA composite split). Re-enter
  if the current outer-shell reprojection or single-pass disocclusion gate
  proves visibly inadequate at close range.
- **E4** — optional dual-lobe HG.

Verify visually after each step on the live build (Earth close-up at
sub-orbital altitude is the ground-truth shot; also test sub-1-km flyby and
orbital limb view).

---

## References

- **Schneider 2015**: "The Real-time Volumetric Cloudscapes of Horizon Zero Dawn" — SIGGRAPH 2015 Advances in Real-Time Rendering. The canonical paper. Density remap, Perlin-Worley, weather map structure.
- **Schneider 2017**: "Nubis: Authoring Real-Time Volumetric Cloudscapes with the Decima Engine" — GDC 2017. Production details, performance numbers, temporal reprojection.
- **Schneider 2022**: "Nubis³" — SIGGRAPH 2022. Successor system in Horizon Forbidden West. New stuff: 3D weather data, fully procedural authoring.
- **Wrenninge 2013**: "Oz: The Great and Volumetric" — multi-scatter octave hack used in our `Tsun_ms = pow(Tsun, 0.3)` term.
- **Karis 2014**: "High Quality Temporal Supersampling" — variance clamping, history sample validation.
