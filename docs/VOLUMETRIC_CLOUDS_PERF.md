# Volumetric Clouds — Performance Optimization Plan

Companion to `VOLUMETRIC_CLOUDS_PLAN.md`. This doc covers how we get from the current **20 FPS at 9k km** state to a stable 100+ FPS without visibly dropping fidelity. Written after the initial implementation and the first hoisting pass (slab-midpoint weather-map cache).

---

## 1. Where the time actually goes

Current per-pixel cost in a cloud-covered column (after weather-map hoisting):

| Work | Per primary step | × 16 steps |
|---|---|---|
| 2D weather-map fetch | 0 (hoisted, 1× per pixel) | 1 total |
| 3D base-noise fetch | 1 | 16 |
| 3D detail-noise fetch | 1 | 16 |
| Sun march (ALU only) | ~30 FLOPs | 480 |
| Density/lighting math | ~40 FLOPs | 640 |

**Bottleneck: 3D-texture fill rate.** Each trilinear 3D fetch is an 8-voxel lookup; 32 of them per pixel at 1440p with 40% covered area is roughly **~500 MB/s** of 3D-texture bandwidth. On M-series GPUs that's painful.

Everything else — the sun march, the shadow test, the phase/powder/multi-scatter math — is now ALU-cheap relative to the 3D taps. **To move the FPS needle we must reduce either the number of fragment invocations or the number of 3D texture fetches per invocation.**

---

## 2. How AAA engines solve this

Every shipped AAA volumetric cloud implementation since ~2015 uses a superset of the same tricks:

### Horizon Zero Dawn / Decima (2015 SIGGRAPH, Schneider+Vos — the canonical reference)
- **Quarter-res raymarch** (half per axis).
- **Temporal reconstruction**: per frame only **1 of every 4×4 pixels** is marched fresh — the other 15 are reprojected from a history buffer using camera motion. Converges in 16 frames.
- Weather map drives coverage (we do this).
- Perlin-Worley noise base + higher-freq detail erosion (we do this).
- Budget: ~2 ms on PS4.

### Frostbite (Andersson, Battlefield)
- Half-res + bilateral upsample.
- **Pre-baked cloud shadow map** into a 512² RT. Sampled once for cloud self-shadow AND once for ground shadow from clouds.
- No temporal — dithered single-frame.

### CryEngine V / Star Citizen
- **Cascaded LOD**: full 3D volumetric near the camera, 2D billboard imposters at distance, full blend between.
- Regional cloud-type masks (cumulus vs stratus vs cirrus).
- Temporal reprojection.

### RDR2 (RAGE)
- Same recipe as above: half-res + temporal + shadow map.

### Unreal Engine 5 VolumetricCloud
- Half-res default, bilateral upsample.
- Temporal integrated with TAA.
- **Skyview + transmittance LUTs** (pre-baked atmosphere look-up tables).
- 1-tap coverage probe before full density eval.

### The universal playbook

1. **Half-res raymarch + bilateral upsample** (always present).
2. **Temporal reconstruction** (sub-pixel offset + history reprojection).
3. **Pre-baked sun shadow map** (replaces the sun-march loop).
4. **Low-res density pre-pass** (tile classification — skip full-res over empty pixels).
5. **Cone / cheap-then-expensive sampling** (probe before fetch).
6. **Distance LOD** (step-count and noise-complexity fall-off).
7. **Atmosphere / phase LUTs** (trade texture fetch for math).

---

## 3. What WebGPU gives us that naive WebGL didn't

- **Compute shaders** — first-class shadow-map generation, temporal blending, tile classification.
- **Storage textures** — writable textures, readable next frame. Makes history-buffer ping-pong trivial.
- **MRT** — output color + depth + motion in one pass.
- **`textureSampleLevel`** — explicit MIP selection on 3D textures for distance-based LOD.
- **Low-res RTs + bilinear sampling** — basic building block for upsampling.
- **Async compute queue** — overlap cloud-shadow-map generation with geometry rasterization (currently unused).

Not available:
- Variable rate shading (don't need it — half-res accomplishes the same thing).
- Hardware ray tracing (overkill).
- Mesh shaders (irrelevant).

---

## 4. Prioritized attack plan

### Tier 1 — Half-resolution pass + bilateral upsample (highest priority)

**Expected speedup: 3–4× on fill-rate-bound fragments.**

Render the cloud shell into a half-res (½ × ½ = ¼ pixels) RT. Upsample with a depth-aware bilateral filter so the cloud silhouette stays crisp against the planet limb.

**Why it works**: cloud detail is inherently low-frequency. Humans notice aliasing at silhouette edges, not texture sharpness in the cloud interior. A bilateral filter preserves the first, discards the second.

**Implementation sketch**:
- New `RenderTarget`, half of `rt` dimensions, `HalfFloatType` + depth attachment.
- In `SpaceRenderer.tsx`: add a third render pass between the scaled-scene and local-scene passes. Draws ONLY the cloud shell into the half-res RT.
- Cloud shell mesh gets tagged (new scene layer, or a dedicated `THREE.Scene`).
- New full-screen quad pass: reads half-res color + depth + main-scene depth, does a 5-tap bilateral upsample, composites into the main RT.
- Scaled-scene render no longer includes the cloud shell.

**Cost**: ~250 LoC across `SpaceRenderer.tsx`, a new `cloudComposite.ts`, small Earth wiring change.

**Risks**:
- Planet-limb aliasing if the depth weighting is wrong. Standard fix: gaussian-weight depth similarity, threshold set from the depth derivative.
- Has to play nice with the existing `RenderPipeline` + bloom pass. Clouds composite BEFORE bloom so silver linings can bloom.
- Transparency ordering: cloud shell is currently alpha-blended on top of the planet but behind local-scene meshes. The upsample composite must preserve this.

### Tier 2 — Pre-baked cloud shadow map

**Expected speedup: 1.5–2× on top of Tier 1.**

Once per frame (or every N frames), render cloud density from the sun's POV into a small RT. In the main shader, replace the 3-step sun march with **one texture sample**.

**Why it works**: self-shadow is a function of world position, independent of view angle. The shadow map is a perfect cache of `exp(-tau_sun)` for every point in the shell. Free bonus: proper cloud-on-ground shadows for the surface shader, replacing the current 2-tap fake in `earth.ts:193–205`.

**Implementation sketch**:
- New compute pass (or full-screen fragment pass) → 256² R16F RT.
- Each texel represents a column at some `(x, z)` on a sun-aligned plane at Earth's centre. March through the slab along the sun direction, accumulate density with 4–6 steps, write `exp(-tau)`.
- Project cloud samples into this RT via a precomputed `sunViewMatrix` uniform.
- Main shader samples this texture instead of running the `LIGHT_STEPS` loop.
- Surface shader also samples it for ground shadows (replaces `earth.ts` two-tap).

**Cost**: ~350 LoC. A new compute/render pass + a shared uniform.

**Risks**:
- **Regeneration cadence**: 60 FPS × 256² × 6 steps of 3D fetches = expensive if done every frame. Either (a) regenerate every 2–4 frames (sun moves slowly), or (b) use the existing weather-map-only density (no 3D noise) in the shadow-map pass. Both acceptable.
- **Resolution**: 256² at planet scale = 8 km/texel. Fine for cloud shadows (their natural blur covers this). 512² if penumbra needs to be sharper.
- **Update sync**: shadow map must be ready before main pass. Sequence in `useFrame`.

### Tier 3 — Temporal reconstruction (Horizon-style)

**Expected speedup: 3–4× on top of Tier 1+2.**

In the half-res pass, march only **1 pixel per 2×2 sub-tile** each frame (= 1/16 of full-res). Reproject the other 3 from the previous frame's history buffer using the camera's motion. Each pixel converges to full quality over 4 frames.

**Why it works**: clouds are temporally coherent. At 60+ FPS, the reprojection error is smaller than the dither error, and convergence is imperceptible.

**Implementation sketch**:
- Two ping-pong RTs for history color.
- Shader uniform `uSubPixelOffset` cycles a Hammersley 2×2 pattern frame-to-frame.
- Reproject history using `prevViewProjectionMatrix × inverseViewProjectionMatrix`.
- Variance-clamp against a 3×3 neighborhood to suppress ghosting.
- Handle disocclusion: where history reproject is off-screen or hits a freshly-revealed pixel, fall back to current sample (accept one frame of lower quality).

**Cost**: ~600 LoC. This is the highest-risk tier — classic TAA artifacts apply (ghosting, smearing, disocclusion holes).

**Risks**:
- **Ghosting during fast camera pans**. Fix: neighborhood variance clamp.
- **Interaction with bloom**. Temporal artifacts get amplified by bloom. Run bloom AFTER temporal resolve, or clamp max bloom input.
- **Initial frames have no history**. Acceptable — clouds ramp in over 4–16 frames on scene load.

### Tier 4 — Cheap-first density probe (low effort, moderate win)

**Expected speedup: 1.3–1.5× (stacks with Tiers 1–3).**

Sample base noise first; skip the detail fetch if base density < 0.05. In low-density regions (cloud edges, wispy parts) this skips ~40% of detail-noise fetches — which are the biggest per-step cost right now.

```ts
const base = texture3D(noiseVolume, p.mul(uNoiseScale)).r;
const preDensity = coverageHeight.mul(0.6 + 0.4 * base);
If(preDensity.greaterThan(0.05), () => {
  // only here do we fetch the detail noise
  const detail = texture3D(noiseVolume, p.mul(detailMul)).r;
  ...
});
```

**Cost**: ~20 LoC. No architectural change.

**Risks**: slight "pop" if the gate threshold is visible in motion. Dither masks it.

### Tier 5 — Distance-based step LOD (free polish)

**Expected speedup: 1.1–1.3×, proportional to average altitude.**

Bake two shader variants: 16 primary steps (near) and 8 primary steps (far). Swap material at ~15k km distance threshold. TSL requires compile-time loop counts, so this is two compiled pipelines.

**Cost**: ~60 LoC. Two pipelines + distance hysteresis to avoid flicker at the crossover.

### Tier 6 — Noise-MIP LOD (free, small win)

Regenerate the 3D noise volume with mipmaps. Auto-MIP selection by the GPU reduces bandwidth for distant fragments. 64³ → 32³ → 16³ chain is <300 KB total.

**Cost**: ~40 LoC in `cloudNoise.ts`. Generate downsampled LODs, enable mipmapping.

**Risk**: none meaningful; MIPs just blur at distance.

---

## 5. Recommended sequencing

```
Do Tier 1 (half-res + bilateral).
  Measure at 9k km.
  ├─ ≥80 FPS → done. Move to step 6 (crossfade).
  └─ 40–80 FPS → continue.

Do Tier 2 (shadow map).
  Measure.
  ├─ ≥60 FPS → done, polish with Tier 4 + 6.
  └─ <60 FPS → continue.

Do Tier 3 (temporal).
  Now we have the full AAA pipeline. This is the ceiling for WebGPU-native quality/perf.

Tier 4, 5, 6 are free polish — do them anytime they're cheap.
```

Realistic expectations:
- Tier 1 alone: 20 → ~65 FPS at 9k km.
- Tier 1 + 2: ~90 FPS.
- Tier 1 + 2 + 3: 120+ FPS, back to headroom.

---

## 6. Fidelity tradeoffs (honest assessment)

| Tier | What you lose |
|---|---|
| 1 | Nothing visible if bilateral upsample is tuned. Limb softness goes up 1–2 px at high altitudes; invisible. |
| 2 | Sun-march quality goes up (shadow map has more effective "steps" than our 3-step march). Net positive. |
| 3 | Slight ghosting during **very** fast camera rotation. Neighborhood clamp keeps it imperceptible in normal play. |
| 4 | Theoretically could under-erode some cloud edges. In practice zero visible difference. |
| 5 | Distant clouds lose one noise octave of detail. Acceptable — they're small on screen. |
| 6 | Distant clouds use coarser noise MIPs. Expected and desired. |

None of these touch the look substantively. The visual target is preserved.

---

## 7. Out-of-scope tricks (not needed yet)

- **Froxel-based volumetric fog grid** — for atmosphere, not planetary clouds.
- **Gaussian splatting for clouds** — research-grade, risky.
- **Async compute for shadow map** — nice perf bump, but WebGPU scheduling complexity. Save for later.
- **Tile classification pre-pass** — adds one more full-screen pass. Diminishing returns after Tier 1 handles most of the fill cost.
- **Phase function LUT** — the HG phase is already 3 ALU ops; not worth a texture fetch.

---

## 8. File layout (when implemented)

```
src/components/celestial/
  shaders/
    volumetricCloudShell.ts        // main shell shader (split from earthClouds.ts)
    cloudShadowMap.ts              // Tier 2: sun-POV shadow map generator
    cloudComposite.ts              // Tier 1: bilateral upsample fragment
    cloudTemporal.ts               // Tier 3: reprojection + variance clamp
  bodies/
    earth.ts                       // samples shadow map for ground shadows
src/components/space/
  SpaceRenderer.tsx                // adds cloud half-res pass + upsample pass
```

---

## 9. What I'd start with

Tier 1 — half-res + bilateral. Highest reward per line, lowest risk, and it's what every single AAA engine does first. Measure, then decide Tier 2/3.
