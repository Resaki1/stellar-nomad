# Volumetric Clouds — Nubis-tier Roadmap

Path to AAA-grade volumetric clouds on Earth (and later other planets), targeting **photorealistic Horizon Zero Dawn quality** at **120 FPS on M2 Pro**.

Reference: Andrew Schneider, *"Real-Time Volumetric Cloudscapes of Horizon: Zero Dawn"*, SIGGRAPH 2015 / GDC 2017. The Nubis system is the canonical implementation; everything below is an adaptation of those techniques to WebGPU + TSL.

---

## Where we are (2026-04-26)

The baseline volumetric shell is **shipped and looks decent**. Steps 1–6 of the original plan plus the first round of visual tuning are done.

### Built

- **Shell geometry**: 64-segment back-side sphere mounted at `R+1..R+14 km`, on its own `CLOUD_LAYER`, rendered into a half-res `HalfFloatType` RT (`SpaceRenderer.tsx` does the multi-pass orchestration: scaled background → cloud RT → composite into main RT → local scene → postFX).
- **Premultiplied alpha pipeline** end-to-end: `(ONE, 1-α)` blending, bilinear upsample on a premultiplied texture in the composite pass.
- **Analytic ray-shell intersection** with a "below-inner-shell" branch so the slab is still marched correctly when the camera flies under 1 km altitude.
- **16-step primary march** with `MIN_STEP_SCALED` floor for short slabs, sin-hash dither on `tStart`.
- **Slab-midpoint UV cache**: weather-map UV computed once per fragment (cloud altitude is < 0.13° angular drift across the slab — UV is effectively constant). Coverage is sampled once and reused inside both the primary and light loops. This is the optimization that turns the shader from sampler-bound to ALU-bound.
- **Domain-warped weather-map UV** — two `texture3D` taps at offset positions perturb the lookup so silhouettes aren't locked to the 8k texture's pixel grid.
- **Density** = `coverage(uv_warped) × heightGradient(altitude01) × baseNoise × (1 - detail × edgeMask × erosion)`. Single 64³ inverted Worley `Data3DTexture` with a hand-built mip chain.
- **Light march**: 3 steps × ~4 km toward the sun, coverage cached from mid-slab so the inner loop is pure ALU.
- **Sun colour & terminator**: `daylight = smoothstep(-0.1, 0.25, sunDotPoint)` softens the umbra; `sunset = 4·d·(1-d)` is a tent function tinting sunlight orange across the terminator band. Sun colour multiplied by `12.0` HDR so AgX tonemapping reads "bright white" not "grey", and bloom catches silver-lining edges. Night-side leak (from `pow(Tsun.max(0.0001), 0.3)`'s NaN-guard floor) is gated by `daylight`.
- **Phase**: Henyey-Greenstein, `g = 0.6`. Multi-scatter approximation via Wrenninge's "raise transmittance to a low power" octave hack, weighted at 0.7. Powder term active.
- **Distance crossfade with flat overlay**: `uVolumetricBlend` uniform owned by `earth.ts` (ramps `(35_000 - distKm) / 10_000` clamped 0..1). Surface shader's flat cloud overlay fades inversely. Cloud-on-ground shadow tap kept active throughout.
- **Performance**: easily 120 FPS on M2 Pro (frame cap; we have substantial headroom).

### Not built yet

- Detail noise volume (separate high-frequency 3D texture for fluffy edge erosion)
- Multi-octave base volume (Perlin-Worley + Worley FBM packed RGBA)
- Cloud-type-aware vertical density profile (stratus / stratocumulus / cumulus)
- Adaptive raymarch step length (long-step in empty / short-step in density)
- Cone-tracing light march (>1 ray-direction per primary sample)
- Curl-noise UV advection (organic motion, breaks tiling visibly)
- **Temporal reprojection** (the AAA polish layer — 1 ray per 16 pixels, accumulated across frames)
- Bilateral / depth-aware upsample
- Shell-shadow RT (replacing the surface shader's two-tap cloud-shadow trick)
- Generalisation to `volumetricCloudShell.ts` + `VolumetricCloudConfig`
- Quality tiers + pre-warm

### Files involved

| File | Purpose |
|------|---------|
| `src/components/celestial/bodies/earthClouds.ts` | Shell + fragment shader. **Heart of the work.** |
| `src/components/celestial/bodies/earth.ts` | Surface shader; owns `uVolumetricBlend`; flat overlay fade. |
| `src/components/celestial/bodies/cloudNoise.ts` | 64³ Worley generator + mip chain. |
| `src/components/space/SpaceRenderer.tsx` | Multi-pass orchestration: cloud RT, composite, postFX. |
| `src/components/space/renderLayers.ts` | `CLOUD_LAYER` enum. |

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

## Phase A — Volume authoring (the missing fluff)

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

## Phase B — Density model upgrade

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

## Phase C — March quality

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

## Phase D — Temporal reprojection (the AAA layer)

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

## Phase F — Productionise

### F1. Generalise to `volumetricCloudShell.ts`

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

Phases are roughly sequential but A↔B and E1↔E3 are parallelisable. Suggested order:

1. **A1–A5**: noise volumes + detail erosion. Visible win on first close approach.
2. **B1–B3**: cloud-type profile. Variety per region.
3. **C1–C3**: adaptive march + cone light. Quality at distance.
4. **C4**: curl advection. Animation.
5. **E1**: shell-shadow RT. Surface coherence.
6. **D1–D7**: temporal reprojection. **The big lift, but what makes it AAA.**
7. **E3**: aerial perspective.
8. **F1**: generalise.
9. **F2–F4**: tiers, pre-warm, Venus.

Verify visually after each step on the live build (Earth close-up at sub-orbital altitude is the ground-truth shot; also test sub-1-km flyby and orbital limb view).

---

## References

- **Schneider 2015**: "The Real-time Volumetric Cloudscapes of Horizon Zero Dawn" — SIGGRAPH 2015 Advances in Real-Time Rendering. The canonical paper. Density remap, Perlin-Worley, weather map structure.
- **Schneider 2017**: "Nubis: Authoring Real-Time Volumetric Cloudscapes with the Decima Engine" — GDC 2017. Production details, performance numbers, temporal reprojection.
- **Schneider 2022**: "Nubis³" — SIGGRAPH 2022. Successor system in Horizon Forbidden West. New stuff: 3D weather data, fully procedural authoring.
- **Wrenninge 2013**: "Oz: The Great and Volumetric" — multi-scatter octave hack used in our `Tsun_ms = pow(Tsun, 0.3)` term.
- **Karis 2014**: "High Quality Temporal Supersampling" — variance clamping, history sample validation.
