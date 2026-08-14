# AUDIT 1 — Render output chain, radiometric

Scope: fragment → canvas pixel. Read in full: `src/components/space/SpaceRenderer.tsx`,
`src/components/Scene/Scene.tsx`, `src/components/space/renderLayers.ts`,
`src/store/store.ts`, `src/components/HUD/SettingsMenu/SettingsMenu.tsx`, plus the
three.js r183 code the chain actually executes (cited from `node_modules/three/src/…`
and `node_modules/three/examples/jsm/…`, which is what runs).

**Confidence labelling** used throughout:
- **[CODE]** — read directly from source, cited.
- **[COMMENT]** — a comment *claims* it; flagged where the code disagrees.
- **[INFERRED]** — my reasoning/arithmetic on top of cited code; not observed at runtime.

**Headline answers, up front:**

1. The offscreen chain **is genuinely HDR end-to-end** — every single render target in
   the chain is `HalfFloatType` (RGBA16F). Nothing silently clamps to [0,1] before the
   tonemapper. The clamp is exactly where it should be: the final canvas write.
2. Tone mapping is applied **exactly once**. The save/restore dance around the
   scaled/local passes is **vestigial (a provable no-op)**, not a double-tonemap bug.
3. **There is no exposure control of any kind.** Not auto, not manual, not exposed in
   settings. `renderer.toneMappingExposure` is wired into the graph but never written,
   so it sits at 1.0. `ATMOSPHERE_EXPOSURE = 1.0` is referenced by nothing.
4. The real radiometric defect is **not** in the plumbing — it is that the *default*
   tonemapper (Neutral, when `settings.toneMapping === false`) crushes everything above
   linear ≈4 into the top two 8-bit code values, while the scene's own reference white
   (`SUN_ILLUM_GAME_1AU = 21.2`) sits far above that. The output transfer function and
   the scene scale were never reconciled. This is the same disease as `VENUS_ILLUM_TRIM`.
5. The canvas is **plain 8-bit sRGB, `toneMapping.mode: 'standard'`** — SDR only. A
   one-word renderer option (`outputType: HalfFloatType`) would switch it to
   RGBA16Float + `'extended'`, which is the WebGPU HDR path. Currently unused.

---

## 1. The exact value chain, hop by hop

### 1.0 Renderer construction — what was and was not asked for

`src/components/Scene/Scene.tsx:160-165`:

```ts
const renderer = new THREE.WebGPURenderer({
  canvas: defaultProps.canvas as HTMLCanvasElement,
  powerPreference: "high-performance",
  logarithmicDepthBuffer: true,
  trackTimestamp: perf.enabled,
});
```

Everything else is a three.js default **[CODE]**:

| Renderer property | Value | Source |
|---|---|---|
| `outputColorSpace` | `SRGBColorSpace` | `three/src/renderers/common/Renderer.js:184` |
| `toneMapping` | `NoToneMapping` | `Renderer.js:192` |
| `toneMappingExposure` | `1.0` | `Renderer.js:200` |
| `alpha` | `true` → canvas `alphaMode: 'premultiplied'`, clear alpha 0 | `Renderer.js:98,158,467` |
| `antialias` / `samples` | `false` / `0` → **no MSAA anywhere** | `Renderer.js:101,275` |
| `outputBufferType` | `HalfFloatType` (internal FB target only — never used here, see §2) | `Renderer.js:107,608` |
| `outputType` | **not passed** → canvas format `navigator.gpu.getPreferredCanvasFormat()` | `WebGPUUtils.js:229-233` |

Critically, **R3F 9.5.0 never touches `toneMapping` or `outputColorSpace`**. I grepped
the whole dist bundle (`node_modules/@react-three/fiber/dist/react-three-fiber.cjs.dev.js`)
for `toneMapping|outputColorSpace|ColorManagement` — **zero hits**. So the three.js
defaults above are the live values. This is load-bearing for §2.

`ColorManagement.workingColorSpace` is left at its default `LinearSRGBColorSpace`
**[INFERRED — not written anywhere in `src/`; verified by grep for `ColorManagement`]**.

### 1.1 Hop table

`W`,`H` = CSS size; `D` = `gl.getPixelRatio()` = `clamp(devicePixelRatio, 0.5, 1.5)`
(see §6); `Dc = min(D, 1.0)` (`CLOUD_MAX_DPR`, `SpaceRenderer.tsx:141`);
`SPARSE_DIVISOR = 2` (`cloudReconstructionPass.ts`, referenced `SpaceRenderer.tsx:36`).

| # | Pass | Target | Dims | Format / type | colorSpace | >1 survives? |
|---|---|---|---|---|---|---|
| — | (LUT bake) transmittance | `atmosphereLUTs.transmittance` | 256×64 | RGBA16F (`HalfFloatType`) | `NoColorSpace` | yes |
| — | (LUT bake) multiscatter | `…multiScatter` | 32×32 | RGBA16F | `NoColorSpace` | yes |
| — | (LUT bake) sky-view | `skyViewLUT` | `SKYVIEW_W×H` | RGBA16F | `NoColorSpace` | yes |
| — | BSM bake | `bsmRT`, `bsmSoftRT` | 512² | RGBA16F | `NoColorSpace` | yes |
| — | ship shadow probe | `_shipProbeRT` | 1×1 | RGBA**32F** (`FloatType`) | `NoColorSpace` | yes |
| — | light volume | `Storage3DTexture` | — | rgba16float | n/a | yes |
| 1 | scaled scene (planets, skybox, star, stellar points) | `rt` | `⌊W·D⌋×⌊H·D⌋` | **RGBA16F**, depth | `NoColorSpace` | **yes** |
| 1.5 | AP march | `apRT` | `⌊W·D·AP_RES_SCALE⌋…` | RGBA16F | `NoColorSpace` | yes |
| 1.6 | AP apply (`scene·T + L`) | `rtB` | `⌊W·D⌋×⌊H·D⌋` | **RGBA16F**, depth | `NoColorSpace` | **yes** |
| 2a | sparse cloud marcher (MRT ×2) | `sparseCloudRts[i]` | `⌊W·Dc/2⌋×…` | RGBA16F ×2 | `NoColorSpace` | yes |
| 2c | cloud reconstruction | `historyRts[i]` | `⌊W·Dc⌋×⌊H·Dc⌋` | RGBA16F | `NoColorSpace` | yes |
| 3 | cloud composite (premul blend) | `rtB` | full | RGBA16F | `NoColorSpace` | yes |
| 4 | local scene (ship, asteroids, VFX) | `rtB` | full | RGBA16F | `NoColorSpace` | yes |
| 5a | bloom high-pass | `_renderTargetBright` | `⌊W·D/2⌋…` | RGBA16F | `NoColorSpace` | yes |
| 5b | bloom blur mips ×5 (H+V) | `_renderTargets{Horizontal,Vertical}[i]` | halving | RGBA16F | `NoColorSpace` | yes |
| 5c | bloom composite | `_renderTargetsHorizontal[0]` | `⌊W·D/2⌋…` | RGBA16F | `NoColorSpace` | yes |
| 6 | **pipeline quad → canvas** | canvas | `⌊W·D⌋×⌊H·D⌋` | **`bgra8unorm` (8-bit UNORM)** | `'srgb'` | **NO — clamped [0,1]** |

Citations for the target constructions:

- `rt`: `SpaceRenderer.tsx:327-334` — `new RenderTarget(…, { type: HalfFloatType, depthBuffer: true })`
- `rtB`: `SpaceRenderer.tsx:342-350` — same
- sparse MRT: `SpaceRenderer.tsx:421-436` — `{ type: HalfFloatType, depthBuffer: false, count: 2 }`
- history pair: `SpaceRenderer.tsx:438-449` — `{ type: HalfFloatType, depthBuffer: false }`
- atmosphere LUTs: `atmospherePass.ts:377-384`; sky-view `atmospherePass.ts:452-455`; AP `atmospherePass.ts:1180-1182`
- BSM: `cloudShadowMap.ts:163-164, 183-184`; ship probe (`FloatType`) `cloudShadowMap.ts:204-205`
- light volume: `cloudLightVolume.ts:266-267`
- bloom RTs: `BloomNode.js:129-151` (all `{ depthBuffer: false, type: HalfFloatType }`), sizes `BloomNode.js:262-284`
- canvas: `WebGPUBackend.js:285-293` + `WebGPUUtils.js:229-233`

**This is the answer to question 1: the HDR chain is intact.** Note this is *not* free —
`RenderTarget`'s default `type` is `UnsignedByteType` and default `colorSpace` is
`NoColorSpace` (`three/src/core/RenderTarget.js:24-30`), so every one of those explicit
`type: HalfFloatType` args is doing real work. Any future RT added without it silently
becomes an 8-bit clamp. Worth a lint rule / helper.

Half-float caveats **[INFERRED]**: max finite ≈65504, 10-bit mantissa (≈0.05 % relative
step). The largest scene value I found is `CORE_HDR = 4096` (`Star.tsx:80`) and
`StellarPoint`'s cap of 500 (`StellarPoint.tsx:271`) — both comfortable. No overflow risk
in the bloom chain either, since the blur kernels are normalised Gaussians
(`BloomNode.js:544-551` coefficients, `BloomNode.js:487-500` accumulation) and the
composite gain is 0.06 (§4).

### 1.2 Alpha, and why it doesn't bite

The renderer's clear alpha is **0**, not 1 (`Renderer.js:467`: `alphaClear = this.alpha === true ? 0 : 1`,
and `alpha` defaults `true`). Combined with the canvas being configured
`alphaMode: 'premultiplied'` (`WebGPUBackend.js:281,289`) that would be a real hazard —
Chrome may clamp `rgb ≤ a` for premultiplied canvases **[INFERRED, spec-level]**.

It doesn't bite, for two independently sufficient reasons **[CODE]**:
- the atmosphere apply pass (the last thing to write full-screen colour into `rtB`)
  hardcodes `alpha = 1`: `atmospherePass.ts:2039`
  `return vec4(sceneColor.mul(T).add(apSample.rgb), 1);`
- the page background is `black` (`Scene.tsx:151`), so `rgb + (1−a)·bg == rgb` for any `a`.

One small real artefact: the output dither is added to **all four** components, alpha
included — `mapped.add(dither)` where `mapped` is a `vec4`
(`SpaceRenderer.tsx:531`; `ToneMappingNode.js:setup` returns `vec4(fn(rgb), a)`).
So final alpha is `1 ± 1/255`. Harmless here *only* because the page background is black.

---

## 2. Tone mapping — where, and exactly once?

### 2.1 Where

`SpaceRenderer.tsx:525-531`:

```ts
const toneMode = settings.toneMapping ? AgXToneMapping : NeutralToneMapping;
const mapped = hdr.toneMapping(toneMode);
…
pipeline.outputNode = OUTPUT_DITHER_LSB > 0 ? mapped.add(dither) : mapped;
```

`hdr.toneMapping(mode)` resolves via `addMethodChaining('toneMapping', …)`
(`ToneMappingNode.js:` last line) to `new ToneMappingNode(mode, nodeObject(undefined), color)`.
`nodeObject(undefined)` returns `undefined` (`TSLCore.js:296-314` — `getValueType(undefined)`
is not `'node'`/`'shader'`/anything, so it falls through to `return obj`), which means the
constructor default **does** apply: `exposureNode = toneMappingExposure`
(`ToneMappingNode.js:29`), i.e. `rendererReference('toneMappingExposure', 'float')`.
See §3 for why that matters (and why it currently does nothing).

### 2.2 Exactly once — the proof

`RenderPipeline.render()` (`three/src/renderers/common/RenderPipeline.js:104-134`) is the
whole story:

```js
render() {
  this._update();                                       // ← line 108
  …
  const toneMapping = renderer.toneMapping;              // 112
  const outputColorSpace = renderer.outputColorSpace;    // 113
  renderer.toneMapping = NoToneMapping;                  // 115
  renderer.outputColorSpace = ColorManagement.workingColorSpace; // 116
  this._quadMesh.render( renderer );                     // 123
  renderer.toneMapping = toneMapping;                    // 129
  renderer.outputColorSpace = outputColorSpace;          // 130
}
```

and `_update()` (`RenderPipeline.js:162-203`) **captures the renderer's tonemap/colour-space
at graph-build time**, not at draw time:

```js
const toneMapping = renderer.toneMapping;            // 168
const outputColorSpace = renderer.outputColorSpace;  // 169
…
outputNode = renderOutput( outputNode, toneMapping, outputColorSpace ); // 183
```

So the question reduces to: *what are `renderer.toneMapping` / `.outputColorSpace` at the
instant `pipeline.render()` is called?*

Call site: `SpaceRenderer.tsx:1013`, which is **after** the restore at
`SpaceRenderer.tsx:1009-1010`. And the restored values are the ones read at
`SpaceRenderer.tsx:669-670`, at the *top* of the same frame. Fixed-point analysis of all
writers of those two properties:

| Writer | Value | When |
|---|---|---|
| three defaults | `NoToneMapping`, `SRGBColorSpace` | construction (`Renderer.js:184,192`) |
| R3F | — | **never** (verified by grep) |
| `SpaceRenderer.tsx:537` | `toneMapping = NoToneMapping` | graph-build effect, runs before the first `useFrame` |
| `SpaceRenderer.tsx:671-672` | `NoToneMapping`, `LinearSRGBColorSpace` | per frame, reverted at 1009-1010 |
| `RenderPipeline.js:115-116` | `NoToneMapping`, working | inside `render()`, after `_update()`, reverted at 129-130 |
| `RendererUtils.resetRendererState` (bloom) | saves+restores all three | `RendererUtils.js:16-18, 69-71` |
| `src/app/dev/*/page.tsx` | `NoToneMapping` | separate routes, different renderers |

⇒ `savedToneMapping` is **always** `NoToneMapping` and `savedColorSpace` **always**
`SRGBColorSpace`. Therefore `renderOutput(node, NoToneMapping, SRGBColorSpace)` →
tone mapping skipped, one sRGB OETF applied (`RenderOutputNode.js:setup`, the
`toneMapping !== NoToneMapping` and `outputColorSpace !== workingColorSpace` branches).

**Verdict: tone mapping once (in-graph), colour-space encode once (in `renderOutput`).
No double application.** The comment at `SpaceRenderer.tsx:534-535` is accurate.

### 2.3 …but the save/restore is dead code, and one line of it is a live landmine

Two independent reasons the save/restore at `SpaceRenderer.tsx:669-672` / `1009-1010`
cannot affect the offscreen passes **[CODE]**:

1. `Renderer.currentToneMapping` / `currentColorSpace` (`Renderer.js:2328-2342`) return
   `NoToneMapping` / `workingColorSpace` whenever `isOutputTarget` is false — i.e.
   whenever *any* render target is bound. Every pass between lines 669 and 1010 binds a
   target. So the assignments are inert for those passes regardless of value.
2. As shown above, the values being "disabled" were already the disabled values.

The comment at `SpaceRenderer.tsx:666-668` ("Disable tone mapping so HDR values stay above
1.0 for bloom threshold") therefore describes a **precaution that is structurally
unnecessary** in three r183. **[COMMENT vs CODE mismatch — the comment isn't wrong about
intent, it's wrong that the code is what achieves it.]**

The landmine: `SpaceRenderer.tsx:672` sets `renderer.outputColorSpace = LinearSRGBColorSpace`
for the duration of the frame. If **anything** ever caused `pipeline._update()` to run
while that assignment is in effect (e.g. someone moves `pipeline.needsUpdate = true` +
a `pipeline.render()` inside the frame body, or a future pass calls into the pipeline),
`renderOutput` would be built with `outputColorSpace === workingColorSpace` and
**silently drop the sRGB encode entirely** — the whole image would go dark/contrasty with
no error. Today it is safe purely because `_update()` is only reachable from
`RenderPipeline.render()`.

### 2.4 What each tonemapper actually does to the scene scale

This is where the real problem is. Both curves are in
`three/src/nodes/display/ToneMappingFunctions.js`.

**AgX** (`settings.toneMapping === true`): `AgxMinEv = -12.47393`, `AgxMaxEv = 4.026069`,
then `clamp(…, 0, 1)` on the normalised log position, and a final `clamp(…, 0, 1)`.
So the input window is `2^-12.474 … 2^4.026` ≈ **1.75e-4 … 16.29** (per channel, after the
Rec.2020 + inset transform). Anything ≥ ~16.3 is **hard-clipped to display white**.

**Neutral** (`settings.toneMapping === false` — **the default**): `StartCompression = 0.76`,
`Desaturation = 0.15`, `newPeak = 1 − d²/(peak + d − S)` with `d = 0.24`. Asymptotes to 1,
never clips.

Response, computed from those formulas **[INFERRED — arithmetic on cited code, not measured]**:

| linear input (peak) | Neutral → display-linear | → 8-bit sRGB | AgX → display-linear | → 8-bit sRGB |
|---|---|---|---|---|
| 1.0 | 0.880 | **241** | 0.591 | **203** |
| 2 | 0.961 | 251 | — | ~222 |
| 4 | 0.983 | **253** | 0.864 | **238** |
| 10 | 0.994 | 254 | — | ~250 |
| 21.2 (`SUN_ILLUM_GAME_1AU`) | 0.997 | **255** | clipped 1.0 | **255** |
| 4096 (`CORE_HDR`) | ~1.000 | 255 | clipped 1.0 | 255 |

**Findings that fall straight out of that table:**

- Under the **default** tonemapper, the entire range `4 … ∞` occupies 253–255. Given
  `SunLight` intensity 30 (`SunLight.tsx:20`) → a Lambertian albedo-1 surface at normal
  incidence lands at ≈`30/π` ≈ 9.5 **[INFERRED, three's `BRDF_Lambert` = albedo/π]** —
  i.e. *every lit white surface in the local scene is already at 254/255*. There is no
  highlight range left for anything. This is the "surfaces on a [0,1] albedo scale vs
  atmosphere on the sunIlluminance scale" split described at
  `atmosphereData.ts:271`'s `VENUS_ILLUM_TRIM` comment, seen from the output end.
- **AgX's white point (16.29) is BELOW the scene's own nominal sun illuminance
  (`SUN_ILLUM_GAME_1AU = 21.2`, `atmosphereData.ts:69`).** So on the AgX path, "full
  sunlight at 1 AU" is definitionally clipped. The atmosphere was calibrated
  (`atmosphereData.ts:68` comment: "Phase 1 tuned Earth's sky against sunIlluminance = 21.2")
  against a curve whose ceiling it exceeds.
- The two tonemappers are **not** a quality tier — they are two radically different looks
  (203 vs 241 for the same linear 1.0, a ~0.85 stop difference in mid-tone placement).
  Yet the toggle is labelled `"AgX tone mapping"` in a *Graphics* menu
  (`SettingsMenu.tsx:82-91`) and is auto-enabled only on `gpu.tier >= 3`
  (`SettingsMenu.tsx:746-753`). **Two players on different GPUs see materially different
  tonality of the same scene, and nothing in the codebase is calibrated for both.**
- `settings.toneMapping = false` (`store.ts:30`) means the *stored* default is Neutral;
  the first-run tier bump (`SettingsMenu.tsx:733-755`) only fires while
  `storedSettings.initial === true`.

---

## 3. Exposure control

**There is none. Plainly: no exposure, auto or manual, anywhere in the chain.**

Verified:

- `renderer.toneMappingExposure` is the *only* scalar multiply wired in front of the
  tonemapper (via `ToneMappingNode`'s default `exposureNode`, §2.1). Grep for
  `toneMappingExposure` across `src/` + `app/`: **zero hits.** It stays at its
  constructor value `1.0` (`Renderer.js:200`). Identity.
- `ATMOSPHERE_EXPOSURE = 1.0` (`atmosphereData.ts:37`) — grep across all of `src/`
  returns **exactly one hit, its own declaration**. It is imported by nothing, used by
  nothing. Its own comment says "for now it is an identity placeholder so Phase 0 is a
  strict no-op" — that is **accurate**, and confirms `docs/ATMOSPHERE_PLAN.md` §6's
  unified-exposure pass was never built.
- `settings` (`store.ts:12-25`) exposes exactly: `invertPitch`, `bloom`, `toneMapping`,
  `fps`, `perf`, `initial`. The Graphics submenu (`SettingsMenu.tsx:69-93`) shows exactly
  two knobs: `bloom` and `AgX tone mapping`. **No brightness, no exposure, no gamma.**
- The atmosphere apply pass writes `sceneColor.mul(T).add(apSample.rgb)` with no scalar
  (`atmospherePass.ts:2039`). No hidden exposure there either.

Consequence: the *only* way to change overall image brightness today is to edit a light
intensity or an albedo. The one dial that would let scene scale and display scale be
reconciled independently is present in the graph and pinned to 1.

---

## 4. Bloom

`SpaceRenderer.tsx:514-517`:

```ts
let hdr: typeof pipeline.outputNode = sceneTexture;
if (settings.bloom) {
  hdr = sceneTexture.add(bloom(sceneTexture, 0.02, 0, 1));
}
```

Signature is `bloom(node, strength, radius, threshold)` (`BloomNode.js:` bottom;
constructor `BloomNode.js:60`). So **strength 0.02, radius 0, threshold 1**, plus the
non-overridable `smoothWidth = 0.01` (`BloomNode.js:93`).

**Position in the chain:** on the *linear HDR* scene texture, before the in-graph
tonemap. Correct placement. Note it reads `sceneRt.texture` (`SpaceRenderer.tsx:510-511`)
— i.e. `rtB`, the post-atmosphere, post-cloud, post-local-scene composite. Everything
blooms; there is no MRT/emissive selection (the `BloomNode` docstring describes that
option; this code doesn't use it).

**Resolution:** bloom sizes itself from `renderer.getDrawingBufferSize()` each frame
(`BloomNode.js:290-292`), so mip 0 is half the full DPR buffer — it matches `rt`/`rtB`,
not the clamped cloud DPR.

**What threshold = 1 means on this scale.** The high-pass is
`alpha = smoothstep(threshold, threshold + 0.01, luminance(texel.rgb))`, then
`mix(vec4(0), texel, alpha)` (`BloomNode.js:462-470`). So:
- gate is on **Rec.709 relative luminance**, not per-channel;
- it is a **1 %-wide knee** at exactly 1.0 — effectively a hard step;
- the pixel passes through **whole**, not `texel − threshold`.

Given §2.4, linear 1.0 already maps to 241/255 (Neutral) or 203/255 (AgX). So the bloom
gate sits at roughly "brighter than a fully-lit mid-grey surface" — meaning under Neutral
almost the entire lit scene is above threshold, not just the intended specular/star
highlights. **[INFERRED from the 30/π ≈ 9.5 surface estimate.]**

**Energy behaviour — not energy conserving.** Two separate reasons **[CODE]**:
1. Composition is `sceneTexture.add(bloom(...))` (`SpaceRenderer.tsx:516`) — the original
   is not attenuated to pay for the halo. Total energy strictly increases.
2. The internal composite is
   `Σ_{i=0..4} lerpBloomFactor(f_i, radius) · blur_i · strength`
   with `f = [1.0, 0.8, 0.6, 0.4, 0.2]` (`BloomNode.js:363`), and
   `lerpBloomFactor(f, 0) = mix(f, 1.2−f, 0) = f` (`BloomNode.js:365-377`) because
   `radius = 0`. Σf = 3.0, so total gain = `3.0 × 0.02 = 0.06` of the bright-pass image
   spread across five scales. Each blur is an unnormalised-but-analytic Gaussian
   (coefficients `0.39894·exp(−i²/2σ²)/σ`, `σ = kernelRadius/3`,
   `BloomNode.js:544-551`; kernels `[6,10,14,18,22]` at `BloomNode.js:355`) so each blur
   ≈ preserves mean radiance, and mip decimation is plain bilinear point-sampling (no box
   prefilter) — the standard UnrealBloomPass aliasing.

**`radius = 0` is a meaningful choice, not a disabled feature.** It selects the
*non-mirrored* mip weights, i.e. bloom energy is concentrated in the tightest mip.
`radius = 1` would invert the weights to `1.2 − f` and make the widest mip dominate.

**Bloom is off by default** (`store.ts:29` `bloom: false`), auto-enabled on
`gpu.tier >= 2` first run only (`SettingsMenu.tsx:737-745`). So on a low-tier GPU the
*only* mechanism communicating "brighter than white" is absent entirely, and the sun's
4096-radiance core is a flat white disc with a shader-baked glow.

**Temporal-stability hazard [INFERRED]:** hard 1 %-knee + no MSAA (`Renderer.js:275`,
`samples = 0`) + no temporal AA on the scaled scene ⇒ any pixel oscillating across
luminance 1.0 pops fully in and out of bloom between frames. `Star.tsx:78-79` shows the
author already fighting this ("moderate enough that sub-pixel drift doesn't cause visible
bloom flicker"). Widening `smoothWidth` is not exposed by the `bloom()` helper — it needs
`bloomNode.smoothWidth.value = …` on the instance.

---

## 5. Canvas / display output — SDR, and the HDR switch is one word away

`three/src/renderers/webgpu/WebGPUBackend.js:281-293`:

```js
const alphaMode = parameters.alpha ? 'premultiplied' : 'opaque';
const toneMappingMode = parameters.outputType === HalfFloatType ? 'extended' : 'standard';
context.configure({
  device: this.device,
  format: this.utils.getPreferredCanvasFormat(),
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  alphaMode: alphaMode,
  toneMapping: { mode: toneMappingMode }
});
```

Actual state for this app **[CODE]**:

| Property | Value | Why |
|---|---|---|
| `format` | `navigator.gpu.getPreferredCanvasFormat()` — `bgra8unorm` on macOS/Chrome | `outputType` not passed (`Scene.tsx:160-165`) → `WebGPUUtils.js:231-233` |
| `colorSpace` | **not specified → defaults to `'srgb'`** | no `colorSpace` key in the `configure` call above |
| `toneMapping.mode` | **`'standard'`** | `parameters.outputType === undefined !== HalfFloatType` |
| `alphaMode` | `'premultiplied'` | `alpha` defaults `true` |

So: **plain 8-bit sRGB SDR canvas.** `'standard'` mode is precisely the mode that tells
the compositor to treat values as SDR and clamp to the SDR white level.

Also confirmed absent, by grep over `src/` and `app/`:
- `'rec2100-hlg'`, `'display-p3'`, `'extended-srgb'` — **no hits**
- CSS `dynamic-range-limit` — **no hits** in any `.scss`/`.css`
- `matchMedia('(dynamic-range: high)')` — **no hits**. The only `matchMedia` call in the
  codebase is `Navigation.tsx:12`, `(pointer: coarse)`.

**What this means for HDR displays:** on an HDR-capable display, the page is composited
as SDR. The tonemapper's output white (1.0) is mapped to SDR white (typically ~100–200
nits / the OS SDR level), and there is no headroom above it. The sun disc at radiance
4096 and a lit white asteroid at radiance ~9.5 both land on the same 255 — and both are
displayed at the same nit level. Nothing in the chain can signal "this pixel is 10× SDR
white". Bloom is the *only* HDR cue, and it's an SDR-range trick (spreading energy
sideways because it cannot go up).

**The switch.** Passing `outputType: HalfFloatType` in the `WebGPURenderer` options
(`Scene.tsx:160`) would simultaneously give `format: 'rgba16float'`
(`WebGPUUtils.js:239-241`) **and** `toneMapping: { mode: 'extended' }`
(`WebGPUBackend.js:283`) — i.e. the canvas would accept and display values above 1.0 on
HDR displays. That is a real, single-line experiment. It would, of course, be pointless
until the tonemapper stops clamping to [0,1] (AgX clamps twice, explicitly;
`ToneMappingFunctions.js` agx last line) — so the correct sequence is: exposure control
first (§3), then a display-referred output transform, then the canvas format. Flagging it
so the option is on record, **not** recommending it as a standalone change.

**One extra hop that does NOT happen (worth knowing):** `Renderer._getFrameBufferTarget()`
(`Renderer.js:1296-1330`) would allocate an internal `_outputBufferType` (= `HalfFloatType`)
RT and add a blit whenever `needsFrameBufferTarget` (`Renderer.js:2274-2280`) is true.
Because `RenderPipeline.render()` sets `toneMapping = NoToneMapping` and
`outputColorSpace = workingColorSpace` *before* `_quadMesh.render()`
(`RenderPipeline.js:115-116`), that predicate is false and the pipeline quad draws
straight into the swapchain texture. So there is exactly one 8-bit write, no hidden
intermediate, and no hardware sRGB encode either (`getPreferredCanvasFormat()` never
returns a `-srgb` format, and `WebGPUBackend` passes it through unmodified — grep for
`srgb` in that file returns nothing but the format call). Single manual OETF in the
shader. Clean.

**Missing clear [CODE, minor]:** `gl.autoClear = false` is set at `SpaceRenderer.tsx:988`
and never restored before `pipelineRef.current.render()` at `SpaceRenderer.tsx:1013`. The
pipeline quad is a full-screen opaque triangle (`QuadMesh`/`QuadGeometry`,
`three/src/renderers/common/QuadMesh.js:16-36`) so colour is fully overwritten; the canvas
depth attachment is *not* cleared, and the quad's `NodeMaterial` keeps `depthTest = true`
with `depthFunc` `LessEqualDepth`, so it passes on equal depth from the previous frame.
Works, but it is load-bearing on `LessEqual` and on the quad's z being frame-invariant.
**[INFERRED — this is a fragility, not an observed bug.]**

---

## 6. dpr and brightness

**What dpr actually resolves to.** `dpr={[0.5, 1.5]}` (`Scene.tsx:154`) →
R3F `calculateDpr` = `Math.min(Math.max(dpr[0], devicePixelRatio), dpr[1])`
(`@react-three/fiber/dist/events-358c3764.cjs.dev.js:118-124`) = `clamp(dPR, 0.5, 1.5)`.
Since `devicePixelRatio >= 1` on every real display, and `<AdaptiveDpr pixelated />` is
**commented out** (`Scene.tsx:208`), **the 0.5 lower bound is unreachable dead
configuration.** Live range is `{1.0, 1.25, 1.5, …}` → in practice 1.0 or 1.5.

`rt`/`rtB` are `⌊size · gl.getPixelRatio()⌋` (`SpaceRenderer.tsx:328-333, 344-349`), and
bloom follows `getDrawingBufferSize()` (`BloomNode.js:290-292`), so those all track dpr
consistently. The cloud chain is deliberately decoupled at `min(D, 1.0)`
(`CLOUD_MAX_DPR = 1.0`, `SpaceRenderer.tsx:141`) and upsampled at composite — a
resolution decision, radiometrically neutral (premultiplied-alpha bilinear filtering is
linear).

**Does dpr change perceived brightness of small bright things?** Yes, for stars —
and the mechanism is specific and citable.

`StellarPoint` sizes its billboard from **CSS pixels**, not device pixels:

- `screenH = Math.max(window.innerHeight, 1)` (`StellarPoint.tsx:216`) — CSS px
- `pixelDiameter = (angularDiameter / fovRad) * screenH` (`StellarPoint.tsx:218`)
- visibility gate `pixelDiameter < STELLAR_PX_THRESHOLD` (=8, `StellarPoint.tsx:58,221`)
- `minAngle = (MIN_SCREEN_PX / screenH) * fovRad` (=6 px, `StellarPoint.tsx:62,275`)

Same pattern in `Star.tsx:186-190` (`MIN_SCREEN_PX = 60`, `window.innerHeight`).

The fragment shader emits a **radiance profile in UV space** — `coreFalloff`/`haloFalloff`
are functions of normalised billboard UV (`StellarPoint.tsx:170-192`), scaled by
`uBrightness`, with **no** dependence on how many device pixels the billboard covers.

Therefore **[INFERRED, but it follows directly]**:

- **Apparent size and peak radiance are dpr-invariant** (both defined in CSS px / UV) —
  so the dot itself looks the same, and after tone mapping its clipped-white core looks
  identical at dpr 1.0 and 1.5.
- **Total integrated energy scales as dpr²** — a 6-CSS-px dot covers 9× more device
  pixels at dpr 1.5 than … no: 2.25× more (1.5²). Each carries the same radiance.
- Bloom integrates over *device* pixels at half the drawing-buffer resolution. Its
  kernels are in device pixels (`invSize = 1/res`, `BloomNode.js:283`), so a dot that is
  2.25× more device pixels feeds 2.25× more energy into the same *relative* kernel
  footprint ⇒ **the bloom halo around stars is brighter and relatively wider at higher
  dpr.** This is the concrete brightness-vs-dpr coupling.
- With `samples = 0` (no MSAA) and only `alphaHash` stochastic discard for edge AA
  (`StellarPoint.tsx:138,186-190`), the halo's dithered edge is also finer/denser at
  higher dpr, which changes how much of the halo survives to feed bloom.

The other dpr coupling is the **output dither**, which is defined in device pixels
(`screenCoordinate` = `gl_FragCoord.xy`, `three/src/nodes/display/ScreenNode.js:181-195`),
so its grain is physically finer at dpr 1.5 — and its aliasing threshold is on the
*drawing-buffer* width, see §7.4.

`Star.tsx:186-188` also has `const screenH = cam.getFilmHeight() ? Math.max(window.innerHeight, 1) : 1080;`
— `getFilmHeight()` returns `filmGauge / max(aspect, 1)` which is never 0 for a normal
camera, so the `1080` fallback is unreachable. Dead branch **[INFERRED]**.

---

## 7. Clamp / saturate inventory

### 7.1 Clamps that destroy HDR range — the real list

| Where | What | Verdict |
|---|---|---|
| canvas write, `bgra8unorm` | values → [0,1], 8-bit | **The** clamp. Correct location, but SDR-only (§5). |
| `ToneMappingFunctions.js` agx, `clamp(colortone, 0, 1)` on the log window | input hard-limited to `2^-12.474 … 2^4.026` ≈ `1.75e-4 … 16.29` | **HDR-destroying by design**, but the ceiling (16.29) is *below* `SUN_ILLUM_GAME_1AU = 21.2`. |
| `ToneMappingFunctions.js` agx, final `clamp(colortone, 0, 1)` | output clamp | expected for an SDR transform |
| `ToneMappingFunctions.js` agx, `pow(max(vec3(0), colortone), 2.2)` | negative guard after the outset matrix | fine |
| `ToneMappingFunctions.js` neutral | no hard clamp, but asymptotic: `4 → 0.983`, `21 → 0.997` | **effectively a clamp** at ~4 in 8-bit terms (§2.4) |
| `Star.tsx:158` `alpha = clamp(brightness.mul(0.5), 0, 1)` | with `AdditiveBlending` (`Star.tsx:98`) the src factor is `SrcAlpha`, so the glow's outer skirt where `brightness < 2` is attenuated **by its own value** → `~brightness²·0.5` | **[INFERRED]** unintended non-linearity in the sun's outer glow falloff |
| `StellarPoint.tsx:271` `Math.min(hdr * fade, 500)` | caps peak stellar radiance at 500 | intentional (comment: "Venus at inferior conjunction can spike"), and invisible anyway since ≥16.3 clips under AgX / ≥4 crushes under Neutral |

### 7.2 Clamps that are NOT a problem (checked, so they can be ruled out)

I grepped `clamp|saturate|.min(|.max(` across `atmospherePass.ts`, `cloudFullscreenPass.ts`,
`cloudReconstructionPass.ts`, `cloudShadowMap.ts`, `cloudLightVolume.ts` and inspected
every hit near a `0, 1` bound. **None of them clamp a radiance/colour to [0,1].** They are:

- parameter/coordinate clamps: `atmospherePass.ts:598,702` (froxel depth01),
  `:1352` (radius into the shell), `:1367,1369` (LUT UVs), `:1409,1442` (acos guards),
  `:1470,1489` (trig `sqrt(1−μ²)` guards), `:1486` (screenUV), `:1272` (a ring coverage
  weight, genuinely a [0,1] opacity), `:1734` (ring glow keep factor),
  `cloudLightVolume.ts:350` / `cloudShadowMap.ts:358` (`alt01`),
  `cloudShadowMap.ts:900` (penumbra elevation ramp),
  `cloudFullscreenPass.ts:416` (a length ratio),
  `cloudReconstructionPass.ts:317` (a tFront-derived gate).
- epsilon floors that *protect* HDR maths: `atmospherePass.ts:1340` (`max(1e-4)` in the
  HG denominator), `:1559` (`max(1e-4)` in the multiple-scattering `1−Fms`),
  `:1041` (`max(rs, 1e-12)`), `:2036` (`apSample.a.max(0)` before `pow` — explicitly
  because bilinear filtering of an HDR target can produce negatives).
- the YCoCg variance clamp in the cloud reconstruction
  (`cloudReconstructionPass.ts:455-470`) clamps *history to the neighbourhood*, not to
  [0,1] — HDR-safe by construction.

### 7.3 The one place a clamp is conspicuously ABSENT

Nothing floors the composited scene at ≥ 0 before the tonemapper. AgX handles negatives
(`max(colortone, 1e-10)` before `log2`), but **Neutral does not**: its
`offset = select(x < 0.08, x − 6.25x², 0.04)` and subsequent `mulAssign(newPeak/peak)`
are undefined-ish for negative channels, and negatives *can* reach it — bilinear
filtering of the half-res `apRT` next to a sharp edge in `L` produces them (that is
exactly why `atmospherePass.ts:2036` guards its own `pow`). **[INFERRED]** Candidate
cause of dark fringes at high-contrast silhouettes on the default (Neutral) path.
Falsifiable with a one-line `.max(0)` before `.toneMapping()` at `SpaceRenderer.tsx:526`.

### 7.4 Output dither — two concrete defects

`SpaceRenderer.tsx:527-531`:

```ts
const px = screenCoordinate;
const dither = hash(px.x.add(px.y.mul(1000)))
  .sub(hash(px.y.add(px.x.mul(1000))))
  .mul(OUTPUT_DITHER_LSB / 255);
```

**(a) It is applied in the wrong space, so its amplitude is ~13× too large in shadows.**
`pipeline.outputNode = mapped.add(dither)`, and `renderOutput` *then* applies the sRGB
OETF (`RenderPipeline.js:183` → `RenderOutputNode.js:setup` → `workingToColorSpace`).
So a ±1/255 perturbation is injected in **display-linear** space and then passed through
a transfer function whose slope is 12.92 near black. Output LSB amplitude
**[INFERRED, derivative of the sRGB OETF]**:

| display-linear value | d(sRGB′)/dv | dither amplitude in output LSB |
|---|---|---|
| ≤ 0.0031 (toe) | 12.92 | **±12.9** |
| 0.01 | 6.45 | ±6.5 |
| 0.0745 | 2.0 | ±2.0 |
| 0.5 | 0.66 | ±0.66 |
| 1.0 | 0.55 | ±0.55 |

The comment at `SpaceRenderer.tsx:148` **claims** "~1 LSB pre-sRGB ≈ 1–2 LSB in the dark
sky (sRGB expands near black)". That is only true above display-linear ≈0.0745, i.e.
output code ≈76/255 — which is *not* the dark sky. In a genuinely dark sky (code ~20/255)
the real amplification is ~9×. **[COMMENT contradicted by arithmetic on the cited code.]**
The banding it targets is a 1-*output*-LSB artefact; breaking it needs ±0.0003 linear near
black, not ±0.0039. Correct fix: add the dither *after* the colour-space encode (which
requires `pipeline.outputColorTransform = false` and an explicit
`renderOutput(...)` in the graph — `RenderPipeline.js:48-66,185-191` documents exactly
that hook), or scale it by the local OETF derivative.

**(b) The hash seeds alias once the drawing buffer exceeds 1000 px.**
`hash` is a PCG int hash on `seed.toUint()` (`three/src/nodes/math/Hash.js:11-20`), and
`screenCoordinate` is `gl_FragCoord.xy` in **drawing-buffer** pixels
(`ScreenNode.js:181-195`). `x + 1000·y` is injective only for `x < 1000`; the drawing
buffer is `size.width × D`, i.e. > 1000 for any window wider than ~667 CSS px at dpr 1.5.
So `h1(x, y) == h1(x − 1000, y + 1)` exactly, and symmetrically `h2 = y + 1000x` aliases
for `y ≥ 1000`. The TPDF difference therefore carries a **structured, 1000-px-period
diagonal correlation** instead of being white. **[INFERRED — arithmetic, not observed.]**
Standard fix is a 2D hash (`hash(x + y·W)` with `W` = actual buffer width, or a
`pcg2d`-style mix).

**(c) It is static.** No frame index in the seed, so the noise is frozen in screen space
and never averages out over time — it reads as fixed grain rather than film grain. The
frame counter is right there (`cloudFrameIndex`, `SpaceRenderer.tsx:571,1027-1028`).

---

## 8. Every hardcoded lighting / brightness / exposure magic number found

See the structured `constants` list for the machine-readable version. Grouped here by what
scale they live on — which is the actual point:

**Three.js photometric-ish scale (local scene only):**
`ambientLight intensity={0.5}` (`Scene.tsx:130`), `SunLight` default `intensity = 30`
(`SunLight.tsx:20`), `hemisphereLight` intensity driven at runtime from
`getAtmosphereLighting().skyIntensity` (`AtmosphereSkyLight.tsx:35,45`).
Note: `grep '<ambientLight|<directionalLight|<hemisphereLight|<pointLight|<spotLight'`
over `src/` returns **only** those three plus `EngineExhaust.tsx:189` — and all of them
are in `localContent` (`Scene.tsx:127-147`). **The scaled scene (all 14 bodies + skybox +
star) contains no three.js lights at all** and therefore lights itself in its own node
materials, on its own scale. That is the structural root of the two-scales problem.

**Ad-hoc "HDR" scale (scaled scene):**
`CORE_HDR = 4096` (`Star.tsx:80`), inner glow `CORE_HDR * 0.3` (`Star.tsx:144`), outer
glow `× 8.0` (`Star.tsx:149`), `REFERENCE_HDR = 12.0` (`StellarPoint.tsx:67`), stellar
cap `500` (`StellarPoint.tsx:271`).

**Physical-ish luminance scale (atmosphere only):**
`SUN_ILLUM_GAME_1AU = 21.2` (`atmosphereData.ts:69`, applied `:205`),
`VENUS_ILLUM_TRIM = 0.025` (`atmosphereData.ts:271`, applied `:276-278`),
`ATMOSPHERE_EXPOSURE = 1.0` (`atmosphereData.ts:37`, **unused**).

**Output-chain scale:**
bloom `strength 0.02`, `radius 0`, `threshold 1` (`SpaceRenderer.tsx:516`),
`smoothWidth 0.01` (three default, `BloomNode.js:93`),
mip weights `[1.0,0.8,0.6,0.4,0.2]` (`BloomNode.js:363`),
`OUTPUT_DITHER_LSB = 1.0` (`SpaceRenderer.tsx:149`),
`toneMappingExposure = 1.0` (three default, never written),
AgX window `[-12.47393, 4.026069]` EV, Neutral `StartCompression = 0.76`,
`Desaturation = 0.15` (`ToneMappingFunctions.js`).

**Four mutually unreconciled scales in one image.** No conversion exists between them.

---

## 9. Comments that the code contradicts

Flagged because the brief says several are known stale.

1. **`Star.tsx:63-64`** — "HDR values are moderate (~60) so bloom adds a natural halo
   without the instability that extreme values (4096) cause at low pixel counts."
   `Star.tsx:80` is literally `const CORE_HDR = 4096;`. The comment warns against the
   exact value in use, and `Star.tsx:78-79` then describes 4096 as "moderate". **Stale.**
2. **`renderLayers.ts:8-10`** — "Cloud shell is rendered separately at half-res into its
   own RT, then composited back into the main RT with premultiplied alpha. Saves 3-4× on
   fragment fill cost." The current architecture is a sparse MRT marcher +
   full-cloud-DPR reconstruction + upsampling composite (`SpaceRenderer.tsx:399-449`),
   and `CLOUD_LAYER` is never enabled on any camera (only layer 0 is —
   `SpaceRenderer.tsx:704`). **Stale, describes a replaced design.**
3. **`SpaceRenderer.tsx:65`** — "(Don't use logarithmicDepthBuffer — it breaks depth for
   custom vertexNode.)" `Scene.tsx:162` passes `logarithmicDepthBuffer: true`, and
   `Star.tsx:121-124` / `StellarPoint.tsx:163-167` implement explicit `depthNode` log-depth
   workarounds *because* it is on. **Contradicted by the code it sits next to.**
4. **`SpaceRenderer.tsx:148`** — the dither's "≈1–2 LSB in the dark sky" claim. Off by
   ~5–10× in the dark sky (§7.4a).
5. **`SpaceRenderer.tsx:666-668`** — "Disable tone mapping so HDR values stay above 1.0
   for bloom threshold." The intent is right, but the mechanism is inert: `currentToneMapping`
   is forced to `NoToneMapping` for any bound render target anyway (`Renderer.js:2328-2330`),
   and the saved value is already `NoToneMapping`. **Describes a no-op as load-bearing.**
6. **`Star.tsx:82`** — the `bloom` prop is received as `_bloom` and **never used**. The
   only effect of `<Star bloom={settings.bloom} />` (`Scene.tsx:121`) is to invalidate the
   `scaledContent` memo. Not a comment, but the same class of drift.

---

## 10. Open questions / what this audit cannot settle

1. **What are the actual histogram statistics of `rtB`?** Every quantitative claim in
   §2.4 and §4 about "the lit scene sits at 9.5" is arithmetic on light intensities, not a
   measurement. The next step should be a readback/probe pass (there is already a 1×1
   `FloatType` probe pattern to copy — `cloudShadowMap.ts:204-205`) reporting min/max/mean/
   p99 luminance of `rtB` per benchmark scenario. Without that, choosing an exposure
   constant would repeat the eyeballing this codebase is already full of.
2. **Which tonemapper is the intended look?** The two differ by ~0.85 stops of mid-tone
   placement and by 4 stops of highlight handling. Nothing in the repo states an intent,
   and the GPU-tier auto-enable (`SettingsMenu.tsx:746-753`) makes it accidental.
3. **Are the negative values reaching Neutral real?** §7.3 is an inference from the
   `.max(0)` guard the author already needed at `atmospherePass.ts:2036`. Needs a
   DEBUG_VIZ of `min(rgb, 0)` over `rtB`.
4. **`GPUCanvasConfiguration` `colorSpace`/`toneMapping` support matrix** — I read three's
   code, not the browser's. Whether `'extended'` mode is actually honoured on the target
   Chrome/macOS versions is unverified here.
5. **Does the `Star.tsx:158` alpha/`AdditiveBlending` interaction actually distort the
   glow?** It depends on three's WebGPU mapping of `AdditiveBlending` to
   (`SrcAlpha`, `One`), which I did not read. Marked inferred.
6. **Does anything downstream depend on the current dither amplitude?** Fixing §7.4a
   reduces shadow noise ~13×, which may re-expose the atmosphere-sky banding it was added
   to hide. The banding's real fix is more output bits (§5), not more noise.
