# Volumetric Clouds — Implementation Plan

Reference doc for upgrading Earth's (and later other planets') cloud layer from a flat texture overlay to a true 3D / volumetric look when the camera is close.

Target: photorealistic AAA look (Star Citizen / Starfield / Outlaws reference), cheap enough to keep 120 FPS on an M2 Pro, generic enough to extend to other planets.

---

## Current state (baseline)

- Earth is rendered with a TSL `NodeMaterial` on a sphere. See `src/components/celestial/bodies/earth.ts`.
- Clouds today are a single-channel texture (`earth_clouds_*k.ktx2`, R channel) sampled at surface UV and composited into the surface shader (lines ~260–283 in `earth.ts`).
- Cloud shadows on the ground are a two-tap sun-projected texture lookup (lines ~193–205).
- Rayleigh scattering is baked into the surface shader (lines ~285–302). No separate atmosphere mesh at close range (that will come later).
- LOD tiers: `near < 35_000 km`, `mid < 1_500_000 km`, `far` billboard. Distance per body is computed each frame in `CelestialBody.tsx`.
- Postprocessing: WebGPU `RenderPipeline` with TSL `bloom()` + tonemapping (`SpaceRenderer.tsx`). Two scenes (scaled + local) composited in HDR.
- Floating origin recentres at >10 000 km drift (`src/sim/worldOrigin.tsx`).

Headroom: Earth close-up currently easily at 120 FPS — we have budget for a shader-heavy effect, but not unlimited.

---

## Core idea

Use the **existing 2D cloud texture as the "weather map"** that drives a volumetric ray-march on a thin sphere shell above the planet. This is how Horizon/Decima, Frostbite, RED Engine, and Starfield all do it. Coverage will automatically match the current look.

A second, low-poly sphere (~64 segments) is mounted at atmosphere altitude and rendered **after** the planet surface, **alpha-blended**, **back-face culled off**. In its fragment shader we:

1. Analytically intersect the view ray with the inner + outer cloud shells to get `[tEnter, tExit]`.
2. Ray-march through the slab, sampling a density field.
3. For each primary sample, do a short secondary march toward the sun for light transmittance.
4. Composite with Beer extinction + Henyey-Greenstein phase + powder term.

---

## Density field

```
density(p) =
      coverage_sample(weatherMap, uv(p)).r          // existing cloud texture
    * height_gradient(altitude01)                   // 0 at bottom/top, peak middle
    * base_noise(p * Kbase)                         // low-freq Perlin-Worley
    - detail_noise(p * Kdetail) * edge_erosion_mask // wispy edges
```

- **Weather map (R channel)** — `earth_clouds_8k.ktx2` unchanged. This guarantees global cloud distribution matches the current look.
- **Weather map (G/B channels, later)** — pack cloud *type* (G) and base altitude offset (B) for cumulus vs stratus regions. Optional v2; start with just R.
- **Height gradient** — analytic curve (e.g. `smoothstep(0, 0.2, h) * (1 - smoothstep(0.6, 1.0, h))`) scaled by type for puffy vs flat tops.
- **Base noise** — a 128³ RGBA8 `Data3DTexture`. R = Perlin-Worley, GBA = Worley octaves. Baked once at app start (compute pass or preloaded binary asset). ~8 MB VRAM, tiled many times over the sphere.
- **Detail noise** — a second, smaller 3D texture (32³ or 64³) sampled at higher frequency, subtracted near cloud edges (where `base < ~0.4`). Gives wispy silhouettes.

Layer geometry: inner ≈ R+1 km, outer ≈ R+14 km (tunable).

---

## Lighting model

Per primary sample:

- **Sun transmittance** — 4–6-tap secondary ray toward sun, `T_sun = exp(-sum(density * sigma_e * dt))`.
- **Beer extinction** along view: `T *= exp(-density * sigma_e * stepLen)`.
- **In-scatter luminance**: `L = sunColor * phaseHG(cosTheta, g≈0.6) * T_sun * (1 - exp(-density*sigma_s*stepLen))`.
- **Powder term**: `* (1 - exp(-2 * density * sigma_e * stepLen))` — darkens cloud bottoms facing the sun, a classic Wrenninge/Schneider trick.
- **Multi-scatter hack** (Wrenninge): sum 2–3 octaves of `exp(-k_n * opticalDepth)` with decreasing contribution to fake diffuse light inside thick clouds.
- **Ambient** — sample sky/Rayleigh tint at altitude; blend in darker when deep inside.

Accumulate front-to-back: `color += L * T`, `T *= exp(-density*sigma_e*dt)`, early-out if `T < 0.01`.

Phase `g ≈ 0.6` gives the silver lining on the sun side (visible in the reference image).

---

## Surface shadows from clouds

- **Near-term**: keep the existing two-tap surface shadow trick in `earth.ts` — it's cheap and looks good.
- **Later (optional)**: render the shell's sun-facing transmittance into a low-res (256²) "shadow map" RT once per frame, sample it when shading the surface. Better shadow shapes that match the 3D clouds. Defer.

---

## Performance tricks (the make-or-break list)

1. **Adaptive step count** — 48–96 primary steps based on slab thickness along the ray; 4–6 light steps. More steps near limb, fewer straight down.
2. **Empty-space skipping** — if `coverage_sample < eps` or `base_noise < eps`, skip detail noise sample entirely. Empty sky is most pixels; this is the biggest win.
3. **Blue-noise (or 4×4 bayer) dither** on the march start offset — hides banding at low step counts.
4. **Cone-march / cheap tap first** — do a 1-tap density probe before the expensive full density eval.
5. **Bake the 3D noise once** — do not compute fBM in-shader. Use `Data3DTexture` / a volume texture.
6. **Distance gate** — shell only mounts when `distKm < ~30 000`. Fade the existing flat cloud overlay out across 25 k–35 k so there's no pop.
7. **Half-res pass with bilateral upsample** — only add this if we don't hit frame budget full-res. Start simple.
8. **TSL loop counts must be constants**, not uniforms — otherwise WebGPU shader compile time explodes. Bake quality tiers as separate pipelines.
9. **No allocations per frame** — follow existing CLAUDE.md rules; preallocated scratch vectors only.

---

## Generic configuration for other planets

Extract into `src/components/celestial/shaders/volumetricCloudShell.ts` with a params object:

```ts
type VolumetricCloudConfig = {
  innerRadiusKm: number;
  outerRadiusKm: number;
  weatherMap: THREE.Texture;         // R=coverage, G=type, B=altitude bias
  coverageMul: number;               // global density scale
  baseNoiseScale: number;
  detailNoiseScale: number;
  phaseG: number;                    // 0.6 Earth, higher for thicker atmospheres
  sigmaExtinction: number;
  sigmaScatter: number;
  ambientColor: THREE.Color;
  sunTint: THREE.Color;
  heightGradientCurve: "cumulus" | "stratus" | "mixed";
};
```

- **Venus**: full-coverage weather map, wider slab, yellowish tint, higher g.
- **Gas giants**: derive a band-stretched weather map from the existing surface texture; the shell geometry itself may become the visible "surface" at close range.
- **Mars**: skip for now (too thin for visible volumetrics).

Hook on `CelestialBodyConfig` via `extraMeshes`, not as a replacement for the surface material. Surface shader keeps its flat overlay as the far/mid fallback.

---

## Implementation order (iterate visually, do not skip steps)

1. **Shell + intersection + distance gate** — mount a transparent sphere at `R+1..R+14` only when `distKm < 30 000`. Render flat magenta on entry, zero alpha on exit. Prove the geometry is right.
2. **Density from weather map only** — march the slab, density = `coverage * height_gradient`. No lighting. Output `(1-T)` as alpha. You should see the cloud pattern extruded into puffy blobs that match today's texture.
3. **Add 3D base noise** — bake or preload 128³ RGBA8. Multiply into density. Now it looks varied, not a perfect extrusion.
4. **Add sun transmittance march + HG phase** — clouds now have light and shadow. This is where it starts feeling AAA.
5. **Add detail noise + edge erosion + powder + multi-scatter hack** — the "art pass".
6. **Fade the flat cloud overlay out** across 25 k–35 k so the transition is invisible.
7. **Profile on M2 Pro**. If <90 FPS, add half-res + bilateral upsample. If ≥100 FPS, leave alone.
8. **(Optional)** Low-res shell shadow RT → sample in surface shader, replace two-tap trick.
9. **(Optional)** G/B weather channels for cloud type variety.
10. **Generalise to `volumetricCloudShell.ts` + config**, port Venus.

---

## Risks / things to watch

- **TSL `Loop` compile time** — keep step counts constant. Expect a one-time compile hitch on first close approach; consider pre-warming on scene load.
- **3D textures + KTX2** — KTX2 doesn't do 3D. Use `Data3DTexture` with raw R8/RGBA8 data loaded from a `.bin`, or generate on GPU at startup.
- **Banding** — without dither, low step counts will band visibly. Don't ship without blue noise/bayer.
- **Seam at distance transition** — budget time for tuning the 25 k–35 k crossfade; this is where cheap volumetric implementations look wrong.
- **Floating origin** — the shell lives in the scaled scene; make sure the ray origin (camera) and sphere centre are both in scaled coords when intersecting.
- **Tonemapping / bloom interaction** — volumetric output is HDR; let bloom catch the bright sunlit tops but don't let tonemapping crush them to white. Test with AgX and Neutral.

---

## File layout (proposed)

```
src/components/celestial/
  shaders/
    volumetricCloudShell.ts    // TSL fragment builder + config type
    noiseVolume.ts             // Data3DTexture loader / generator
  bodies/
    earth.ts                   // wire up shell via extraMeshes, fade flat overlay
public/textures/clouds/
  base_noise_128.bin           // baked 128³ RGBA8 noise (or generated at boot)
  detail_noise_32.bin
```

No new dependencies needed. Everything is TSL + existing three/webgpu.
