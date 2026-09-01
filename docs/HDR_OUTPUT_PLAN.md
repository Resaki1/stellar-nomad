# Phase 6 — HDR display output, colour space, and display calibration

**Status: PLANNED (research + discovery complete, nothing implemented).**
Companion to [`LIGHTING_PLAN.md`](LIGHTING_PLAN.md) §3.5, which owns the tone-mapping
decision. This file owns everything downstream of it: the canvas, the transfer
function, the peak-luminance parameter, and the player-facing UX.

Reference devices for this phase: **MacBook Pro M2 Pro built-in XDR** (mini-LED,
P3, ~1,000 nits sustained / 1,600 peak), a **generic AOC SDR** panel, and an
**LG 27GL850-B** (1440p IPS, "HDR10" input but ~400 nits, no local dimming — the
important case of a display that *advertises* HDR and should probably not use it).
A **colorimeter is available**, and §7 gives it a specific, high-value job.

---

## 1. Executive summary — what actually changes, and what does not

| | |
|---|---|
| **The single blocking fact** | three.js's `agxToneMapping` node ends with `clamp(colortone, 0.0, 1.0)`. Everything above display white is destroyed *inside the tone mapper*, so no canvas configuration can recover it. Phase 6 is therefore **90% a display-transform change and 10% a canvas change**. |
| **The canvas change is trivial** | `new WebGPURenderer({ outputType: THREE.HalfFloatType })`. That one option makes three request `rgba16float` **and** set `toneMapping: { mode: 'extended' }` on the WebGPU canvas. Verified in the installed r183 source. |
| **Wide gamut is NOT worth doing** | Measured (§3): **every** blackbody star from 2,400 K to 100,000 K is already inside sRGB. The `Math.max(0, …)` gamut clamp in `blackbodyLinearSrgb` never fires for any real star. P3 buys nothing for the content we ship today. |
| **Headroom cannot be queried** | By deliberate spec design (fingerprinting). ⇒ a **calibration screen** is not a workaround, it is the only correct mechanism. |
| **The SDR image need not change** | …but we should let it change by a measured **2.35 LSB** in the upper mid-tones, in exchange for one curve serving both outputs. See §4.3 for why that trade is the right one. |
| ✅ **HDR WORKS, END TO END** | Verified on the XDR: at 2 stops of headroom the sun's core, hull highlights and engine plumes punch above white while mid-tones stay put. Canvas (6a) + peak-parameterised AgX (6b) + headroom setting (6c) all landed. §5.4–5.5 |
| ⚠⚠ **HDR costs ~1.75 ms/frame, FIXED** | Measured over 6 sweeps at two resolutions: `1.754 ms fixed + 0.032 ms/Mpx`. Doubling the pixels moved it 7%, so **rendering the HDR canvas at reduced resolution is not a lever.** 21% of a 120 fps budget, 10.5% of 60 fps, 7% of an already-heavy frame. §5.3 |
| **This pays the §5 ordering debt** | `GLARE_CORE_CROSSOVER_DEG`, the glare slider default, `PURKINJE_CCT_K`, `EXPOSURE_BIAS_STOPS` were all judged on SDR. The design in §4 anchors the pivot so the *mid-tones* are unchanged, which means **only the highlight-facing judgements need re-making** — chiefly glare. |

---

## 2. Discovery — what the platform actually gives us (all verified, not quoted)

### 2.1 The canvas

Read out of `node_modules/three@0.183.2`:

```js
// WebGPUUtils.js:getPreferredCanvasFormat()
outputType === HalfFloatType   →  GPUTextureFormat.RGBA16Float
// WebGPUBackend.js:283 (the `context` getter)
const toneMappingMode = parameters.outputType === HalfFloatType ? 'extended' : 'standard';
context.configure( { device, format, usage, alphaMode, toneMapping: { mode: toneMappingMode } } );
```

⚠⚠ **Three traps found by reading, each of which would have cost a debugging session:**

| # | Trap | Consequence |
|---|---|---|
| T1 | **`ExtendedSRGBColorSpace` is a no-op on the WebGPU backend.** `ColorManagement.getToneMappingMode()` has **zero callers** in the whole of `src/` (grepped). The addon's `ExtendedSRGBColorSpaceImpl` is literally `{...sRGB, outputColorSpaceConfig: { …, toneMappingMode: 'extended' } }` — same primaries, same transfer, and the one field that differs is never read. | LIGHTING_PLAN §3.5's prescription (`ColorManagement.define(...)` + `outputColorSpace = ExtendedSRGBColorSpace`) is **harmless but useless** in r183. The working switch is `outputType` alone. Do not spend time on it and do not conclude HDR is broken when it changes nothing. |
| T2 | **`drawingBufferColorSpace` is consumed only by `WebGLRenderer.js:3506`.** The WebGPU backend never sets `GPUCanvasConfiguration.colorSpace`, so it stays at the `'srgb'` default. | Setting `outputColorSpace = DisplayP3ColorSpace` would apply the P3 matrix **in the shader** while the canvas still declares sRGB → systematically over-saturated output, with no error. A P3 path needs its own `context.configure()`. §3 says don't bother yet. |
| T3 | **There is exactly one `context.configure()` call in the backend, inside a getter that caches.** Resize does not reconfigure. | We *can* safely re-configure the context once after `renderer.init()` without three stomping it. The robust form reads the existing config back rather than duplicating three's internals: `ctx.configure({ ...ctx.getConfiguration(), colorSpace: 'display-p3' })`. |

### 2.2 The encoding — what a number in the canvas means

This is the question that decides whether the whole image has a gamma error, so it
was chased to the specs rather than inferred:

- `GPUCanvasConfiguration.colorSpace` is `'srgb'` (default) or `'display-p3'`; `format` may be
  `bgra8unorm`, `rgba8unorm`, or **`rgba16float`** ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/GPUCanvasContext/configure)).
- `'srgb'` is the CSS predefined colour space, which is **transfer-encoded (non-linear)** —
  `color(srgb …)`, not `color(srgb-linear …)`.
- CSS Color HDR L1: **the value 1.0 is HDR Reference White**, nominally **203 cd/m²**
  (ITU-R BT.2408). Headroom is defined as `log2(peak) − log2(reference)`, **in stops**, and SDR
  has 0 stops by definition.
- `toneMapping.mode`: `'standard'` clamps to [0,1] in screen space; `'extended'`
  **"matches `standard` in the [0,1] range"** and extends above it.

🔑 **Therefore: we write sRGB-**encoded** values, extended above 1.0, and the browser
guarantees the sub-1.0 region is untouched.** That last guarantee is load-bearing — it
is what lets our display transform keep the SDR look byte-for-byte and only add range
on top, instead of re-tuning the whole image for HDR.

🔑 **And three already does the right encode for free.** We keep
`renderer.outputColorSpace = SRGBColorSpace`; `RenderPipeline` wraps our output node in
`workingToColorSpace(SRGBColorSpace)` → `sRGBTransferOETF`, which is
`1.055·x^(1/2.4) − 0.055` with **no upper clamp**. At 3 stops of headroom (linear 8×) it
emits **encoded 2.454** — monotonic, well inside half-float. Nothing to write.

⚠⚠ **NaN HAZARD, and it is currently masked by the clamp we are about to remove.**
AgX's tail is `AgXOutsetMatrix` → `pow(max(0,c), 2.2)` → `LINEAR_REC2020_TO_LINEAR_SRGB`
→ `clamp(0,1)`. Both matrices carry **negative off-diagonals**, so a bright saturated
colour can leave the Rec2020→sRGB multiply with a negative channel. Today the final
clamp eats it. Remove only the **upper** bound: the lower `max(0, ·)` must stay, or
`sRGBTransferOETF`'s `pow(negative, 0.41666)` produces **NaN**, which then poisons the
glare pyramid on the next frame (the same failure class already documented for the
pre-exposure path).

### 2.3 Detection, and why it must be a calibration screen

- Capability: `matchMedia('(dynamic-range: high)')` for the display; **and, better**,
  `ctx.getConfiguration().toneMapping.mode === 'extended'` read back *after* configuring —
  that tests the actual pipeline rather than a media query, and covers browsers that
  ignore the option.
- Peak luminance / headroom: **not exposed.** CSS Color HDR L1 states the platform
  deliberately does not expose it because it "depends on viewing conditions" and would be
  "a tracking vector". `ScreenDetailed.hdrHeadroom` is proposed (W3C Second Screen WG,
  Aug 2025) and has been **behind a flag for years**. Read it opportunistically as a
  default; never depend on it.

⚠⚠ **macOS makes headroom a moving target, which changes the UX requirement.** On EDR,
**headroom shrinks as the brightness slider rises** — max out a MacBook's brightness and
HDR headroom collapses toward 1.0. So:
1. A calibrated value is only valid **at the brightness it was measured at**.
2. The renderer must tolerate headroom changing at runtime without a recompile ⇒ **peak
   must be a uniform, never a shader constant or a pipeline variant.**
3. The calibration UI must say so in one line, and be re-runnable from Settings.

### 2.4 What the industry does (for the parts we should copy)

- **Unity HDR Output** parameterises tone mapping by exactly three numbers in nits —
  min, max, and **Paper White** — and its docs state plainly: *"It is best practice to
  implement a calibration menu."*
- **Unreal** ships **discrete ODTs per peak** (`r.HDR.Display.OutputDevice`: ACES 1000-nit
  scRGB, ACES 2000-nit scRGB, …) rather than a continuous parameter. ⚠ Its scRGB convention
  is **linear with 1.0 = 80 nits**; ours is **encoded with 1.0 = 203 nits**. Do not import
  numbers across that boundary.
- **Windows 11 HDR Calibration** is the interaction pattern to copy: three patterns
  (min luminance, max luminance, max full-frame), each *"drag the slider until the test
  pattern is no longer visible"*. Its warning is worth copying too: making the pattern
  *too* visible overestimates the range and produces blown highlights.
- **Blender** adds HDR by shipping AgX **retargeted onto Rec.2100** display spaces rather
  than by post-scaling the SDR result — i.e. the display transform itself is
  parameterised by peak. That is the design in §4.

🔑 **One convention we get for free that console games do not: we do not need a Paper
White slider.** Canvas 1.0 *is* the OS's SDR white, so the OS brightness control already
is the paper-white control, and our auto-exposure already anchors mid-grey to it. One
knob (peak/headroom), not two.

---

## 2.5 ⚠ Checked against three r185.1: **nothing here changes**

We are on r183.2; latest is r185.1. Every §2.1/§2.2 finding was re-verified against the
published `three-0.185.1.tgz` source, not against release notes:

| finding | r183.2 | r185.1 |
|---|---|---|
| `ColorManagement.getToneMappingMode()` callers | **0** | **0** — `ExtendedSRGBColorSpace` still a no-op on WebGPU |
| `_getDrawingBufferColorSpace()` callers | `WebGLRenderer.js` only | **`WebGLRenderer.js` only** — P3 still unwired on WebGPU |
| canvas `configure()` | `outputType === HalfFloatType ? 'extended' : 'standard'`, no `colorSpace` | **identical** |
| `ToneMappingFunctions.js` (AgX + both `clamp(0,1)`) | — | **byte-identical** |
| `ColorSpaceFunctions.js` (the OETF we rely on) | — | **byte-identical** |
| `ColorManagement.js` | — | **byte-identical** |

⇒ **The upgrade is not a prerequisite and buys nothing for Phase 6.** One small bonus in
r184 (#33187): `RenderPipeline._update()` now watches `renderer.toneMapping` and
`renderer.outputColorSpace` and raises `needsUpdate` itself, instead of relying on the
caller — which is exactly what `SpaceRenderer.tsx` does by hand today.

⚠ **And the upgrade has a real cost that is unrelated to HDR:** r184/185 added a
`layerUpdates` branch to the *same block* in `WebGPUTextureUtils.js` that
`patches/three@0.183.2.patch` rewrites, so **the patch no longer applies**
(`git apply --check` fails at `src/renderers/webgpu/utils/WebGPUTextureUtils.js:538`) and
must be re-authored across three files. Treat the upgrade as its own commit with its own
gates, not as part of Phase 6.

## 3. MEASURED: wide gamut is not worth doing yet

Run with the repo's own `xFit/yFit/zFit` + `planck` (`photometry.ts`), so this measures
*our* colour path, not a textbook's. Δu′v′ ≈ 0.004 is roughly one JND.

**Blackbody stars — min channel before clamping, and delivered vs true chromaticity:**

| T (K) | star | min sRGB channel | Δu′v′ sRGB | Δu′v′ P3 | Δu′v′ Rec2020 |
|---|---|---|---|---|---|
| 2,400 | M6 dwarf | +0.1129 | **0.00000** | 0.00000 | 0.00000 |
| 3,000 | M2 dwarf | +0.2711 | **0.00000** | 0.00000 | 0.00000 |
| 5,772 | Sol G2V | +0.9119 | **0.00000** | 0.00000 | 0.00000 |
| 9,600 | A0 Vega | +0.8851 | **0.00000** | 0.00000 | 0.00000 |
| 30,000 | O9 | +0.7194 | **0.00000** | 0.00000 | 0.00000 |
| 100,000 | — | +0.6815 | **0.00000** | 0.00000 | 0.00000 |

🔑🔑 **Not one real stellar temperature is out of the sRGB gamut** — the Planckian locus is
a narrow arc through the middle of the gamut. **The most obvious "a space game needs wide
gamut" argument is measurably false**, and `blackbodyLinearSrgb`'s comment ("the
out-of-gamut negatives a very hot/cool blackbody produces") is wrong for *hot*: only
blackbodies **below ~1,500 K** clip at all, and only slightly (−0.04 to −0.09 in blue) —
dim embers, not stars.

**Where wide gamut would genuinely pay — narrow-band line emitters:**

| line | Δu′v′ sRGB | Δu′v′ P3 | Δu′v′ Rec2020 |
|---|---|---|---|
| 557.7 nm OI green (aurora / airglow) | 0.0179 | **0.0062** | 0.0035 |
| 589.3 nm Na D (airglow) | 0.0134 | 0.0033 | 0.0023 |
| 630.0 nm OI red (high aurora) | 0.1189 | 0.0746 | **0.0130** |
| 656.3 nm Hα | 0.1245 | 0.0804 | 0.0188 |
| 500.7 nm [OIII] (nebula) | 0.1290 | 0.1077 | 0.0696 |
| 427.8 nm N₂⁺ blue (aurora) | 0.1786 | 0.1696 | 0.1478 |

**Conclusion: defer wide gamut, and record why so it is not re-litigated.**
1. Nothing we render today is out of gamut.
2. The content that *would* be — aurora, airglow, nebulae — **is not built yet** (airglow
   is still an open item in LIGHTING_PLAN).
3. For that content **P3 is a half-measure**: it fixes auroral *green* (2.9× better) but
   barely touches auroral *red* (1.6×) or Hα. The gamut that matters is **Rec2020**, and
   Rec2020 **is not an available canvas colour space** (`'srgb'` | `'display-p3'` only).
4. So the right time to spend this effort is when aurorae exist, and the right question
   then is Rec2020, not P3.

---

## 4. Design — one display transform, parameterised by peak

### 4.0 "If AgX clamps at 1.0, is AgX still the right choice?" — yes, and the numbers say so

**The clamp is not AgX's. It is three's implementation of AgX.** A display transform's job is to
map scene-referred light onto a display's range, so every one of them ends at the display's peak;
three hardcodes that peak at `1.0` because it only ever targeted SDR. What Phase 6b/6c change is
**one constant**, not the operator.

**Does HDR remove the need for a tone curve?** Not remotely — and this is the number that settles
it. Our scene runs from deep space ~1e-4 cd/m² to the sun disc at `SUN_DISC_LUMINANCE_NITS` =
1.6e9 cd/m²: **43.9 stops.** An SDR display gives ~10 usable stops; the XDR adds
`log2(1600/203)` = **2.98**.

| headroom | display range | still to compress away |
|---|---|---|
| 0 stops (SDR) | ~10 stops | **34 stops** |
| 3 stops (XDR) | ~13 stops | **31 stops** |

Three stops off a 34-stop problem. And concretely: moving AgX's peak from H=1 to H=8 lifts the
white clip from scene-linear 16.3 to ~130 — the sun disc goes from **14.0 stops above it to
11.0**. 🔑 **HDR does not make the tone curve less necessary; it moves the shoulder by 3 stops on
a 44-stop scene.**

**Is AgX still the right operator?** The §3.5 reasons are untouched by headroom, and one of them
gets *stronger*:

- **Hue-preserving desaturation toward white** is the fix for blown Venus and the hue-twisted
  sun. Per-channel curves (Reinhard, Hable, Khronos Neutral) skew hue because channels clip at
  different points. **On HDR you clip later, not never** — the sun still clips 11 stops past
  white — so hue-twisting remains exactly the failure mode to avoid.
- `NeutralToneMapping` crushes everything above linear ≈4. With *more* range to fill that is
  worse, not better.

**And un-hardcoding the peak is the documented way to take AgX to HDR** — Blender added HDR by
retargeting AgX onto Rec.2100 display spaces, not by post-scaling an SDR result. §4.2's
parametric sigmoid keeps AgX's inset/outset matrices, its log window, its pivot and its slope;
only the shoulder's asymptote moves.

⚠ **One honest caveat.** Because the parametric family matches three's polynomial only to
2.35 LSB (§4.3), "AgX" after 6b means **AgX's design with our own sigmoid**, not literally
three's curve.

⚠ **The alternative worth naming, since we are writing a sigmoid anyway:** ACES 2.0's output
transform and the **Daniele Evo** curve it is built on are *peak-parameterised by construction*,
so they would not need reverse-fitting. They are the reference to reach for **if the AgX fit
fights us** — but they would move the SDR look by more than 2.35 LSB, and AgX's look is what
every constant in Phases 5–9 was judged against. AgX-shaped first; Daniele/ACES 2.0 as the
fallback, not the default.

### 4.1 Why the obvious approach fails (measured, so we do not build it)

The tempting design: keep three's AgX polynomial **exactly** for display ≤ 1.0, and graft
a C¹-continuous extension above it. That gives a bit-identical SDR image for free.

**It does not work, and the reason is quantitative.** The AgX contrast curve's slope at
the white point is `d/dt agxDefaultContrastApprox(1) = ` **0.5147 per normalised log
unit**, and one normalised unit is the whole **16.5-stop** window ⇒ **0.031 per stop**. A
C¹ extension from that slope is nearly flat. Measured, with 3 stops (8×) of headroom
available:

| scene-linear | display-linear, C¹ graft | of a possible 8.0 |
|---|---|---|
| 32 | 1.067 | 13% |
| 1,000 | 1.425 | 18% |
| 100,000 | 1.927 | **24%** |

🔑 **Matching the slope at SDR white makes the headroom unreachable.** The constraint that
looks safest ("change nothing below white") is the one that guarantees the feature does
nothing. **The correct invariant is a fixed *pivot*, not a fixed *endpoint*.**

### 4.2 What to build instead — a parametric sigmoid with a movable asymptote

Replace the fixed 6th-order polynomial with a two-armed power sigmoid in the same
normalised-log domain. Fixed pivot, fixed slope through the pivot, and **the shoulder's
asymptote is the display peak**:

```
arm(d, s, L, p) = L·q / (1 + q^p)^(1/p),      q = s·d/L      // slope s at d=0, asymptote L
y(x) = x < xp ?  yp − arm(xp − x, s, yp,      toeP)
              :  yp + arm(x − xp, s, Hs − yp, shoulderP)

Hs = H^(1/2.2)        // AgX's sigmoid lives in a γ2.2 space; H is display-LINEAR peak
H  = 1  ⇒ SDR         // one uniform, no branch, no shader variant
```

Fitted to three's polynomial (`H = 1`): `pivot (0.57290, 0.43636)`, `slope 1.90105`,
`toeP 3.2565`, `shoulderP 5.8559`.

**Measured behaviour — display-linear output of a neutral, window unchanged:**

| scene-linear | H=1 (SDR) | H=2 | H=4 | H=8 | H=8 / H=1 |
|---|---|---|---|---|---|
| **0.18 (mid-grey)** | **0.2171** | **0.2171** | **0.2171** | **0.2171** | **1.000** |
| 1.0 (diffuse white) | 0.5806 | 0.5859 | 0.5861 | 0.5862 | 1.010 |
| 4 | 0.8797 | 1.0201 | 1.0319 | 1.0329 | 1.174 |
| 16.29 (SDR clip point) | 0.9768 | 1.4914 | 1.6154 | 1.6275 | 1.666 |
| 256 | 0.9982 | 1.9234 | 2.9079 | 3.1975 | 3.203 |
| 100,000 | 0.9999 | 1.9971 | 3.9212 | 6.7672 | **6.768** |

✅ **Mid-grey is invariant to 4 decimal places across every H**, by construction, and
diffuse white moves by 1%. So auto-exposure, the scotopic driver and the exposure bias
keep their meaning. Highlights gain up to **6.8× of the 8× available**, reaching 95% of
peak at scene EV 21.9 — comfortably inside the sun disc's range.

### 4.3 ⚠ The one honest cost: 2.35 LSB

The parametric family **cannot** reproduce three's polynomial exactly. Best fit over
5 parameters: **max error 9.21e-3 = 2.35 LSB of 8-bit, at x = 0.710** (scene-linear ≈ 0.59
— an upper mid-tone, i.e. the most visible place it could be).

Two ways to spend it, and the recommendation is not the conservative one:

| | SDR image | HDR↔SDR toggle |
|---|---|---|
| Keep the polynomial for H=1, parametric for H>1 | bit-identical | **jumps 2.35 LSB** when HDR is toggled |
| **✅ One parametric curve for both** | **changes once, by ≤2.35 LSB** | **continuous — zero jump** |

**Recommend one curve for both.** A one-time sub-1% shift in upper mid-tones is a smaller
cost than a permanent visible discontinuity on a user-facing toggle, and "one pipeline
drives both SDR and HDR" is what LIGHTING_PLAN §3.5 asked for. Keep the polynomial
reachable as `__lum.tonecurve('poly')` so the 2.35 LSB can be *shown* rather than argued
about. Nothing tuned so far is invalidated: 2.35 LSB is ~40× smaller than the
`EXPOSURE_BIAS_STOPS` increment.

### 4.4 Where it lives

New file `src/components/space/displayTransform.ts`, owning:
`uDisplayPeak` (display-linear, 1 = SDR), the parametric sigmoid, the AgX inset/outset +
Rec2020 hops copied from three (we must fork the node — the clamp is inside it), a CPU
twin, and `displayStatus()`. `SpaceRenderer.tsx` swaps `retina.toneMapping(toneMode)` for
`displayTransformNode(retina)`.

⚠ **The CPU twin must read `uDisplayPeak.value`, not recompute it.** Phase 7's twin
diverged on its first run for exactly this reason (`scotopicMixCpu` re-derived a term the
shader took from a uniform, and reported `s = 1.000` where the shader used 0.17). A twin
that re-derives *any* uniform is a second implementation.

### 4.5 What gets *deleted* on the HDR path (and what does not)

- **The upper clamp** in the forked AgX (keep the lower one — §2.2).

⚠ **RETRACTED, 6a: "delete `OUTPUT_DITHER_LSB` on the HDR path" was an assumption, not a
finding.** The reasoning was "RGBA16F has no 8-bit step, so the dither is pure noise" —
which is true of *our write* and irrelevant to the thing the dither exists for. **The
final quantisation moved to the compositor, it did not disappear**: the panel is still
8- or 10-bit, and whether Chrome dithers when it quantises is not documented anywhere we
found. On a 10-bit path a 1/255 dither is ~4 LSB of noise, so this is not free either
way. ⇒ **The dither stays on, and the decision is deferred to an A/B on the XDR.**
Guessing which way the compositor behaves is exactly the class of error §4.1 was.

---

## 5. Phasing, with a gate on each step

Ordered so each step is independently verifiable and independently revertable.

| # | Step | Verification gate |
|---|---|---|
| **6a** | ✅ **CLOSED** — `outputType: HalfFloatType` behind an opt-in setting. §5.1 | ✅ canvas `rgba16float`/`extended`; ✅ image unchanged; ✅ cost characterised `1.754 ms fixed + 0.032 ms/Mpx` over **8 sweeps** (both orders, two resolutions, two alphaModes); ⛔ every lever refuted ⇒ **documented trade in the UI.** §5.2–5.3 |
| **6b** | ✅ **LANDED** — `displayTransform.ts`, parametric sigmoid, peak a uniform (ships at 1 = SDR). §5.4 | ✅ `__lum.tonecurve()` green on all three: 2.429/255 code delta, mid-grey spread **0**, 0 non-finite / 0 non-monotonic. ✅ delivery proven on the panel in 6c. |
| **6c** | ✅ **LANDED** — peak driven by a `hdrPeakStops` setting (default **2 stops**), applied per frame only when the canvas is actually extended. §5.5 | ✅✅ **DELIVERY GATE PASSED ON THE PANEL** — the sun's core, hull highlights and engine plumes all punch out at 2 stops; mid-tones unmoved. |
| **6d** | ✅ **LANDED** — step-wedge calibration screen writing `hdrPeakStops`. §5.6 | ✅ pattern, marker tracking and enter/exit verified on device. ⬜ cross-check the perceptual reading against the colorimeter (§7) within ~0.3 stops. |
| **6e** | ✅ **CLOSED, NO CHANGES NEEDED** — the §5 debt is discharged. | ⚠⚠ **MY PREDICTION WAS WRONG.** §5 predicted glare would want to come *down* on HDR because part of what it buys on SDR is faking an unshowable highlight. Judged on the XDR with HDR on: **glare 1.0 is still preferred**, and Purkinje still reads correctly. So `GLARE_CORE_CROSSOVER_DEG`, the glare default, `PURKINJE_CCT_K` and `EXPOSURE_BIAS_STOPS` all survive the output change unchanged. 🔑 The likely reason: the PSF is calibrated to the **eye's** straylight, not to the display's limits, so it was never compensating for the output path in the first place — the §5 worry mistook a physically-anchored constant for a display-referred fudge. |
| **6f** | ⛔ Deferred: P3 / Rec2020. | Do not start until aurora/airglow exist (§3) — which Phase 9 would create. |
| **6g** | ⛔ **DECIDED AGAINST** — area-dependent two-value calibration. §5.7 | Frame-average and peak are anti-correlated here because auto-exposure normalises the average. |

### 5.1 6a as built (verified on device, 2026-08-31)

`src/components/space/hdrOutput.ts` (new) · `Scene.tsx` (ctor + read-back) ·
`store.ts` (`hdrOutput`, default **false**) · Settings → Graphics ("HDR output (reload)"
plus a live status line) · `__lum.hdr()` · one guard in `SpaceRenderer.tsx`.

**Measured in the running game, both states in the same session:**

| | `format` | `colorSpace` | `toneMapping.mode` |
|---|---|---|---|
| default | `bgra8unorm` | `srgb` | `standard` |
| **`?hdr` / setting on** | **`rgba16float`** | **`srgb`** | **`extended`** |

✅ `colorSpace: "srgb"` confirms §2.2 from the running pipeline: the canvas is
**encoded** sRGB, extended above 1.0 — so 1.0 is reference white and three's OETF needs
no change. ✅ `(dynamic-range: high)` and `(color-gamut: p3)` both true on the XDR.
✅ `window.screen.hdrHeadroom` is **`undefined`**, exactly as §2.3 predicted — the
headroom API is not there, so the calibration screen is load-bearing, not optional.
✅ The scene renders correctly with the extended canvas and the HUD is legible.
⚠ **But this verifies the CONFIGURATION, not the DELIVERY — see §5.3.** Nothing in the app
emits a value above 1.0 yet, so an overlay-promotion failure that silently clips the extended
range would look exactly like success here.

🔑 **`?hdr` in the query string forces it on for one load.** Needed because the format is
fixed at construction, and it is what makes a perf A/B reproducible without touching
saved settings.

⚠ **A guard that was free before this step and is not any more.** AgX ends at
display-linear [0,1] and the output dither is added *after* it, so a black pixel could
leave the graph at −1/255. `toneMapping: 'standard'` clamped that; **`'extended'` does
not** — a negative channel is a legal out-of-gamut colour, and a gamut mapper may render
it as a faintly *coloured* dark pixel rather than black, in the region that is most of
our frame. Fixed with `.max(0)` on the dithered output: identical on SDR, and it removes
the class. **Only the floor** — the ceiling is what 6b/6c exist to remove.

✅ **RESOLVED — the "crushed HUD" was a capture artefact.** Two HDR screenshots taken
through the browser-automation capture path came back with the HTML HUD almost black while
the canvas looked normal. It did not reproduce on the matched retest, and the author
confirms no visible change on the XDR. 🔑 **Lesson: the screenshot path for an
extended-range canvas is not what the panel emits, so it cannot be used to judge HDR
output at all** — only the panel and the colorimeter can. (§6.3's concern is still live in
principle; `dynamic-range-limit` remains the lever if it ever shows up for real.)

### 5.2 ⚠⚠ CONFIRMED: the HDR canvas costs ~2 ms of frame time

**Four `__bench.sweep()` runs, 14 scenarios each, both run orders.**

| run | order | Δ frame ms (HDR on − off, excl. `deep_space`) |
|---|---|---|
| 1 | off first, on second (on = hotter GPU) | **+2.139** (sd 0.357) |
| 2 | warm-up, **on first**, off second (on = cooler GPU) | **+1.896** (sd 0.416) |

🔑 **Reversing the order did not change the sign or the magnitude, so it is not thermal
drift.** In run 2 the HDR pass ran on the *cooler* GPU and was still ~1.9 ms slower — the
confound worked against the finding and lost. 13 / 14 scenarios regressed in both runs.

✅ **The instrument is trustworthy.** The two HDR-**off** sweeps, 40 minutes apart and in
opposite positions, agree to **0.023 ms mean / 0.278 ms worst**. The two on-runs agree to
0.202 ms mean. This is a real 2 ms against a ±0.3 ms noise floor.

Cost in context: **11.4% of a 60 fps budget.** fps examples (run 2): `earth_12629` 120 → 108,
`earth_120` 61 → 54, `earth_8` 63 → 56.

**Where it is NOT:**

- **Not bandwidth.** 4→8 bytes/px at 4.41 Mpx = 17.7 MB/frame ⇒ **0.088 ms** at ~200 GB/s.
  Observed is **21×** that. ⚠ This is the number the §5 gate predicted, and predicting a cost
  from one term of a model is how that gate came to be wrong by 21–24×.
- **Not our render graph.** `5 post (output)` — which the profiler folds three's
  `Output Color Transform`, `QuadMesh` and `Scene` contexts into — moves by **−0.06 to
  +0.15 ms**, i.e. nothing. Total *labelled* GPU time actually **drops ~0.8 ms**.

⇒ ~2 ms of wall clock appears **outside every render context the renderer issues**. That
points at the browser compositor / presentation path, which our GPU timestamps cannot
instrument at all.

⚠ **Two reproducible per-pass shifts that are NOT real, recorded so they are not chased.**
With HDR on, `1b beer shadow map` reads **2–2.4× higher** and `1 scaled scene` ~20% *lower*,
in both runs. Neither pass can be touched by the output format. `__bench` warns that the
pass sum runs 1.2×–3.5× the frame interval because GPU spans from consecutive frames overlap;
extra compositor work changes how they overlap, which redistributes the measured spans
without changing the work. **Per-pass Δs are not a budget here. `frameMs` is.**

**Cause: see §5.3 — it is DOCUMENTED, and it was in a doc-comment I had already quoted.**

### 5.3 Why it costs that, and the experiment that settles it

🔑🔑 **The mechanism is documented, and the sentence was in a doc-comment this very module
quotes.** three's own JSDoc for the option we set:

> `outputType` — Texture type for output to canvas. By default, device's preferred format is
> used; **other formats may incur overhead.**

And Chrome's WebGPU documentation is explicit about what that overhead is:

> If you don't use the preferred format when configuring the canvas context, you may incur
> **additional overhead, such as additional texture copies**, depending on the platform.

`navigator.gpu.getPreferredCanvasFormat()` on this machine returns **`bgra8unorm`** — exactly
what the SDR path measured. We force **`rgba16float`**, a non-preferred format. On macOS
specifically, [Chromium backs all canvas textures with IOSurfaces](https://github.com/gpuweb/gpuweb/issues/2535),
and a format that cannot be IOSurface-backed directly needs *"an intermediate texture and then
… a final blit into the IOSurface"*, which that thread calls **"quite costly in general"**.
Compounding it: *"if the HDR layer is not promoted to an overlay, then the buffer we render it
into will not be appropriately allocated as HDR-capable"* — so losing the overlay path is a
correctness issue as well as a cost.

⚠ **Magnitude still not fully accounted for, and this is where the last estimate went wrong.**
One extra full-screen copy at 4.41 Mpx × 8 B read + 8 B write ≈ 70 MB ⇒ **~0.35 ms**. Observed
is **~2 ms**, still 6× more. So "additional texture copies" is a documented *mechanism* but not
yet a complete *cost model* — either there are several passes, or overlay promotion is lost and
the whole page goes through a composite that would otherwise have been scanned out. **Recorded
as an open question rather than closed by a plausible mechanism.**

#### ⚠ My `alphaMode` hypothesis is DEMOTED, on evidence against it

I proposed `alpha: false` (⇒ `alphaMode: 'opaque'`) as the leading lever. The evidence points
the other way:

- *"Platform surfaces/overlays generally require **premultiplied** alpha"* — so opaque may
  **lose** the overlay path rather than gain it.
- *"In WebGL, `alpha:false` has significant cost on some platforms because it's necessary to use
  RGBA instead of RGB, meaning the platform surface/overlay's alpha channel needs to get
  cleared or guarded against writes."*

The documented *benefit* of marking a canvas opaque is that the UA can "optimize blending at
page composite time … and cull fully-obscured elements behind the canvas" — real, but about a
blend, not about the format's copy path. ⇒ still worth one cheap run (`?opaque` is wired), but
it is **no longer the first thing to try**.

#### ⚠⚠ ATTEMPT 1 FAILED — I designed an experiment with a PINNED CONTROL

`?hdr&dpr=0.75` vs `?dpr=0.75` was run. **It cannot answer the question**, and the author spotted
why before I did: at quarter pixel count the *SDR baseline* sits on the **120 Hz vsync cap
(8.333 ms) in 13 of 14 scenarios**, so it physically cannot show a 2 ms difference. A control
clamped by the refresh rate measures the refresh rate.

🔑 **I should have predicted it.** The whole point of cutting resolution is to make the frame
cheaper; making it cheaper than the vsync interval destroys the measurement. **Scaling a
measurement DOWN toward a hard floor is the wrong direction — scale it UP, away from the floor.**

**What the run still tells us, as a LOWER bound.** Four scenarios escaped the cap on the HDR
side while the SDR side stayed pinned, so `ON − 8.333` is a floor on the true Δ:

| scenario | ON | OFF | Δ ≥ | full-res Δ | ratio ≥ |
|---|---|---|---|---|---|
| `earth_250` | 8.748 | pinned | +0.415 | +1.987 | 0.21 |
| `earth_120` | 9.491 | pinned | +1.158 | +2.241 | 0.52 |
| `earth_30` | 9.557 | pinned | +1.224 | +1.553 | 0.79 |
| `earth_8` | 9.159 | pinned | +0.826 | +1.859 | 0.44 |
| **mean** | | | **+0.906** | **+1.910** | **≥ 0.47** |

Pure **per-pixel** predicts 0.25×; pure **fixed** predicts 1.00×. We measure **≥ 0.47×** — and
because the control is pinned that is a floor, not an estimate. ⇒ **leans substantially fixed,
not conclusive.**

#### ✅ ATTEMPT 2 — ANSWERED: the cost is FIXED PER FRAME

`?hdr&dpr=2.1` vs `?dpr=2.1` — canvas 3402×2543 = **8.65 Mpx, 1.96× the pixels** of dpr 1.5.
The control is uncapped in 13 of 14 scenarios (only `deep_space` still pins), so this one is
valid.

| pixel count | 4.41 Mpx (dpr 1.5) | 8.65 Mpx (dpr 2.1) |
|---|---|---|
| **measured Δ** | **+1.896 ms** | **+2.033 ms** (sd 0.194, n=13) |
| per-pixel would predict | — | +3.719 (1.96×) |
| fixed would predict | — | +1.896 (1.00×) |
| **observed ratio** | — | **1.072×** |

🔑🔑 **Doubling the pixel count moved the cost by 0.137 ms — 7%, not 96%. The ~2 ms is a
FIXED PER-FRAME cost.**

**Two-point decomposition, `Δ(Mpx) = fixed + slope·Mpx`:**

| term | value | share at 4.41 Mpx |
|---|---|---|
| **fixed** | **1.754 ms** | **92.5%** |
| slope | 0.0322 ms/Mpx | 7.5% (0.142 ms) |

It also predicts the failed dpr=0.75 run: **+1.789 ms** at 1.10 Mpx, consistent with the
≥0.906 ms lower bound measured there.

🔑 **And it locates my original error precisely.** I predicted 0.088 ms from extra write
bandwidth = **0.0200 ms/Mpx**. The measured per-pixel slope is **0.0322 ms/Mpx — within 1.6×.**
**The bandwidth model was right about the term it modelled.** What it missed was a **1.75 ms
fixed cost that has nothing to do with pixels at all.** "Wrong by 21×" was the wrong diagnosis
of my own mistake: it was not a bad estimate, it was a **missing term**.

#### What "fixed" rules in and out

⛔ **There is no per-pixel lever.** Rendering the HDR canvas below page resolution buys
0.032 ms/Mpx — at half resolution that is **0.07 ms**. The most attractive hypothesis in the
previous round is dead: **do not build resolution-scaled HDR output.**

✅ **A fixed per-frame cost is the signature of a MECHANISM change, not a pass** — an extra
present-path step, a lost overlay promotion, a synchronisation. Texture copies scale with
pixels; this does not. ⇒ **`?opaque` becomes the last lever with a plausible mechanism, and
more interesting now, not less**, since `alphaMode` is the one knob that plausibly affects
overlay eligibility. (⚠ The evidence in §5.3 above still argues overlays *want* premultiplied,
so the prior is against it — but it is now the only candidate left, and it is one sweep.)

**Cost in context, and it is not scale-free:** 1.75 ms fixed is **21% of a 120 fps budget** but
**10.5% of a 60 fps one** — and at dpr 2.1 the heavy scenarios pay 1.75 ms out of 25 ms, i.e.
**7%**. HDR is proportionally cheapest exactly when the frame is already GPU-bound, and most
expensive on a light frame at high refresh. That is worth saying in the settings UI.

⚠ `1b beer shadow map` again reads ~1.7–2.1× higher with HDR on, in this pair as in both
earlier ones. Third reproduction of a pass the output format cannot touch. It is span overlap,
not work — see §5.2.

#### ✅ CLOSED: `?opaque` refuted, and 6a's cost is a documented trade

`?hdr&opaque` vs `?hdr`, same session, 4 minutes apart, both dpr 1.5.

| | Δ (opaque − premultiplied) |
|---|---|
| mean, 13 valid scenarios | **+0.373 ms** (sd 0.187) |
| scenarios where opaque was faster | **0 / 13** |

**`alphaMode: 'opaque'` recovers none of the ~1.75 ms — it ADDS ~0.37 ms.** The direction matches
the prior the research had already surfaced and I under-weighted: *"platform surfaces/overlays
generally require premultiplied alpha"*, and WebGL `alpha:false` *"has significant cost … the
overlay's alpha channel needs to get cleared or guarded against writes."* Opaque **loses** a fast
path here rather than gaining one. Knob retained (default unchanged) only because the compositor
path is platform-specific and there are non-Apple displays to test on.

🔑 **A methodology point this run earned.** The three HDR-on sweeps at dpr 1.5 read 9.20 / 9.46 /
8.78 ms at `earth_12629` across two days — **today's machine state is uniformly ~0.59 ms faster
than yesterday's.** So a 0.37 ms effect is *only* visible in a same-session pair, and every
cross-day delta at this magnitude is noise. The ±0.3 ms reproducibility claimed in §5.2 holds
**within** a session, not across days.

### ⛔ VERDICT: ~1.75 ms is the price of HDR output in this browser today

Every lever is exhausted:

| lever | result |
|---|---|
| lower render resolution | ⛔ **dead** — cost is fixed; half resolution saves 0.07 ms (§5.3) |
| `alphaMode: 'opaque'` | ⛔ **refuted** — costs a further 0.37 ms |
| our own render graph | ⛔ not there — `5 post (output)` unchanged, labelled GPU *drops* |
| extra write bandwidth | ✅ accounted, and it is only the 7.5% per-pixel term |

⇒ **Stop looking. Make it a stated trade**, which is now written into Settings → Graphics:
*"costs a fixed ~2 ms per frame (browser compositing, measured), which hurts most at high frame
rates."* Combined with §6.1's opt-in default, the player decides — which was already the design
for picture-quality reasons and is now also the performance answer.

**What would reopen it:** a Chromium release note about HDR canvas overlay promotion on macOS; a
measurement on a non-Apple GPU showing a different fixed cost (which would localise it to the
macOS/Metal path); or Safari behaving differently on the same panel.

#### ⚠⚠ A gap in §5.1 this research exposed: we verified the CONFIGURATION, not the DELIVERY

`getConfiguration().toneMapping.mode === 'extended'` proves what we *asked for*. Chromium's own
note — *"if the HDR layer is not promoted to an overlay … the HDR content will end up being
clipped"* — means a canvas can report `extended` and still deliver clipped output. We could not
have noticed, because AgX still clamps at 1.0, so **nothing in the app has yet emitted a value
above white.**

⇒ **6c gets a hard gate: emit a known extended value and confirm on the panel that it is
brighter than white** (the §6.2 calibration patch does exactly this). Until that passes,
"HDR output is active" means "the canvas accepted the configuration", and this plan should not
claim more.

### 5.4 6b as built (2026-09-01)

`src/components/space/displayTransform.ts` (new) · `SpaceRenderer.tsx` (one line of the post
chain) · `__lum.tonecurve()` / `__lum.hdrPeak(H)`.

**What changed:** `retina.toneMapping(AgXToneMapping)` → `displayTransformNode(retina)`.
Everything of three's AgX is copied unchanged — inset/outset matrices, sRGB↔Rec2020 hops, the
16.5-stop log window, the `pow(·,2.2)` tail. Two things differ: the fixed 6th-order contrast
polynomial becomes the parametric sigmoid, and **`clamp(colortone, 0, 1)` becomes
`min(·, uDisplayPeak)`**. Khronos Neutral stays on three's node (no peak parameter, and it is a
comparison option, not an HDR candidate).

**Final constants**, fitted Nelder-Mead over 6 starts with the pivot pinned:

| | value |
|---|---|
| `PIVOT_X` | `0.60606057` = `t(0.18)` — **middle grey by definition, not by fit** |
| `PIVOT_Y` | `0.49673057` = `agxPolynomial(PIVOT_X)` — inherits the anchor exactly |
| `SLOPE` / `TOE_POWER` / `SHOULDER_POWER` | `1.923234` / `3.223664` / `5.123080` |

**`__lum.tonecurve()` on device, all three conditions green:**

| check | result |
|---|---|
| look preserved | **2.429 / 255** delivered code values (0.95%) at t = 0.701 ✅ |
| mid-grey fixed across peak 1×–8× | spread **exactly 0** ✅ |
| safe over t ∈ [−0.3, 1.8] | **0** non-finite, **0** non-monotonic ✅ |
| pivot lands on | scene-linear **0.18** ✅ |

🔑 **The metric changed, and that matters.** §4.3 quoted "2.35 LSB", but that was `|Δy|` in the
*sigmoid's* γ2.2 space. The sigmoid's output is decoded by `pow(·,2.2)` before it is encoded for
the panel, so `|Δy|` **over-states the error near black by two decades** — y = 0.009 at the black
floor is display-linear 3.2e-5, i.e. **code 0.12, invisible** — and under-states it in the
mid-tones, which is where the eye is. The gate now measures **delivered 8-bit code values**.
Re-fitting against that metric, with the pivot additionally pinned, lands at 2.429/255.

⚠ **What the gate does NOT prove.** It compares the CPU twin against the polynomial, both in the
same module, and asserts against a constant derived from the same computation — so it catches
inconsistent edits, non-monotonicity and NaN, but it **does not verify the GPU shader matches the
twin**. The canvas cannot be read back, so the GPU path's only check so far is that the scene
renders and looks like the previous curve. 6c's calibration patch is the first numeric check on
delivered output.

⚠ **A confound I nearly reported as a result.** Setting the peak to 4× appeared to brighten the
whole frame — Milky Way suddenly visible. It was **auto-exposure still settling**: peak 1 taken
20 s later is indistinguishable from peak 4. Verified `probeMax` for the frame: brightest pixel
× exposure = **8.8e-4**, i.e. **14 stops below** the 16.29 clip. Nothing in a deep-space scene
reaches the shoulder, so peak has no effect there — which is the *correct* behaviour, and it
means **the delivery test needs the sun in frame**, not deep space.

### 5.5 ✅✅ 6c: DELIVERY PROVEN ON THE PANEL — and the author accidentally measured the headroom

**The gate that mattered most is green.** With `?hdr` and the sun in frame, raising the peak
changes exactly what the design says it should:

> *"The core of the sun gets way punchier, the sunlight reflecting off the ship gets brighter, as
> do the engine exhausts."*

And the things that must **not** change did not: Earth's crescent limb, the star field, the HUD
and the deep-space floor are indistinguishable between peak 1 and peak 4 in the paired
screenshots. That is the pinned pivot doing its job — **highlights extend, mid-tones do not
move** — and it is the first end-to-end proof that Chromium is *delivering* extended values
rather than reporting `extended` and clipping. §5.1's caveat is discharged.

🔑🔑 **AND THE "PEAK 8 BARELY HELPS" OBSERVATION IS A MEASUREMENT OF THE DISPLAY, NOT A
DISAPPOINTMENT.** Past the panel's real headroom the compositor clips, so extra peak stops stop
adding brightness and only compress more scene range into the same visible span. **The point where
raising the peak stops helping IS the headroom** — so:

| | |
|---|---|
| 2 stops (4×) | large, obvious effect |
| 3 stops (8×) | *"a small difference too but not much"* |
| ⇒ effective headroom | **≈2–2.5 stops** |

Cross-check: `log2(1600/203)` = **2.98 stops** is the XDR's theoretical maximum at minimum SDR
brightness, and EDR headroom *falls* as screen brightness rises. A working value of ~2 at a normal
brightness setting is exactly what the model predicts. **The calibration screen (§6.2) is now
a refinement of a procedure that already works by hand, not a leap of faith.**

**Shipped:** `Settings.hdrPeakStops`, default **2** — measured, not guessed. Applied per frame as
`setDisplayPeak(isHdrCanvasActive() ? 2^stops : 1)`:
- **Per frame on purpose** — macOS/EDR headroom shrinks as brightness rises, so this is a runtime
  quantity. It is a uniform write; it costs nothing and never recompiles.
- **Gated on `isHdrCanvasActive()`** — the canvas's own `getConfiguration()` read-back, not a media
  query. On the SDR path anything above 1.0 is clamped anyway, so asking for headroom there would
  compress highlights for nothing.
- Player-facing slider, 0–3 stops, shown only when the canvas is extended, with the instruction
  that falls straight out of the measurement: **"raise it until the sun stops getting brighter —
  that point is your display's real limit."**

### 5.7 ⛔ DECIDED AGAINST: area-dependent (two-value) calibration

HDR panels have an area-dependent peak — this MBP publishes **1000 nits sustained full-screen** vs
**1600 nits peak**, a **0.68-stop** spread; OLED does the same thing as ABL against Average Picture
Level. The industry answer is two numbers: Windows HDR Calibration's third pattern is *"Max Full
Frame Luminance"*, Unity exposes `maxToneMapLuminance` **and** `maxFullFrameToneMapLuminance`, and
HDR10 metadata splits **MaxCLL** from **MaxFALL**. §6.2 measures only one, at ~14.6% coverage.

**We are not building the second value.** Tested on device: bright planet and near clouds filling
the frame show **no artefact — and no visible difference between HDR on and off at all.**

🔑🔑 **AND THAT SECOND OBSERVATION IS THE REASON, NOT A CAVEAT. In this renderer, frame-average and
peak are ANTI-CORRELATED, because auto-exposure normalises the average.** A frame filled by a
sunlit surface is a frame where the meter has stopped down until that surface sits near middle grey
— so nothing in it exceeds display white and there is no headroom in use to lose. Concretely: a
sunlit Earth disc is **2.76 game units**; the sun disc is `SUN_DISC_RADIANCE_GAME` ≈ **2.65e5** —
**five decades apart**. HDR only ever shows up on things far above the diffuse level (sun, star
cores, plume), and those are small. **A high-MaxFALL frame is precisely a frame with nothing above
white, so the area limit cannot bite.** The two-value calibration solves a problem the exposure
system already prevents.

⚠ The one case that could still trigger it, and the trigger to watch for: a frame that is *both*
mostly bright *and* contains something far above that level — the sun in shot alongside a filled
sunlit planet, or a specular sun glint on ocean. If the panel visibly dims when that comes into
frame, revisit; the runtime half is cheap because the exposure meter already computes the frame
average, so it is one `mix(peakSmall, peakFull, …)`.

⚠ Also worth stating plainly: "no difference between HDR on and off" on a diffuse-filled frame is
the **predicted** result, not evidence that HDR is failing. Delivery was proven separately on the
sun (§5.5).

### 5.6 6d as built (2026-09-01) — the calibration screen

`src/components/space/hdrCalibration.ts` (the pattern) · `HUD/HdrCalibration/` (the controls) ·
`hdrCalibrationOpenAtom` · a "calibrate HDR…" button in Settings → Graphics, shown only when the
canvas is actually extended.

🔑🔑 **The pattern cannot be HTML, and that shaped the whole design.** A CSS colour tops out at
`#fff` = 1.0 = reference white, so a DOM patch can never test headroom — it would measure nothing
and *look* like it worked. So the wedge is a node that **replaces `pipeline.outputNode`**, and the
HTML is only the slider, the instructions and the readout. It is bottom-anchored because the wedge
occupies the middle of the screen and a centred modal would cover the thing being measured.

⚠ **It deliberately bypasses the display transform.** We are measuring the *display*, not our tone
curve; routing the wedge through AgX's shoulder would make "where does it stop getting brighter" a
statement about the curve. Values are display-linear multiples of reference white — the same units
as `hdrPeakStops` — and the pipeline's sRGB encode still runs, so only the curve is skipped.

**What it shows:** a bright **field** at `2^stops` with a **patch** inside it at
`2^(stops + 0.25)`, both driven by the slider — drag up until the patch disappears into the field;
four **corner marks** just outside the patch so its location stays findable once it vanishes; and a
black-floor ramp above.

#### ⚠⚠ THE FIRST DESIGN WAS A 17-PATCH STEP WEDGE, AND THE AUTHOR'S REPORT KILLED IT

*"The slider on the calibration page does not seem to do anything on that page… the whiteness does
not seem to update. I can see the smaller rectangle below the larger ones move."*

It was working exactly as designed — the wedge was a fixed ladder and the slider moved only a
marker. **The design was wrong.**

🔑🔑 **A step wedge asks "are these two bright patches different?" — simultaneous discrimination
between large bright fields, which is the hardest form of the question.** What the author had
already done successfully by hand was far easier: *change one thing and watch whether it changes.*
Change detection while dragging beats static discrimination, and it is also what every OS and
console calibration screen actually does ("raise until the test pattern is no longer visible").
⇒ **the slider must drive the brightness, not a cursor.** I had cited the Windows pattern in §6.2
and then built something else.

⚠ And a second-order consequence worth keeping: once the patch is *supposed* to vanish, the player
has nothing to look at and cannot tell "vanished" from "looking in the wrong place". An outline
**on** the patch would keep it permanently visible and destroy the measurement; four marks
**outside** it point without marking.

**Three implementation traps, all found on device:**

| trap | symptom | fix |
|---|---|---|
| Masking with `float(boolNode)` products | **entire screen black** | the bool node's own `.select(ifTrue, ifFalse)`. `mix(a, b, boolNode)` is equivalent but is not in TSL's typed overloads. |
| `screenUV.y` increases **downward** | headroom wedge rendered *below* the black-floor band, contradicting on-screen copy calling it "the upper row" | swapped the y ranges; noted in the layout constants so it cannot be re-guessed |
| Floor ramp log-spaced 1e-5 → 1e-3 display-linear | **solid black** — 1e-3 encodes to **1.1 of 255**, so the whole ramp lived inside the first code value | ramp in **8-bit code values** (0–11), the unit the question is actually asked in. For reference AgX's crush point is **code 0.58**, i.e. finer than one code value ⇒ what limits the night side is the panel, not the curve. |
| Floor ramp placed *below* the field | half of it sat behind the bottom-anchored controls panel | moved above the field; every band now stays above y ≈ 0.50 |

**Still owed:** the colorimeter cross-check (§7). The perceptual reading and an absolute
measurement should agree within ~0.3 stops; if they do not, the pattern is wrong rather than the
panel.

**Not in scope, and called out per CLAUDE.md:** no new dependency; no change to
`ColorManagement.workingColorSpace` (it stays `LinearSRGBColorSpace` — moving it would
invalidate every Rec709 luminance weight in `photometry.ts` and `scotopic.ts` at once);
no new render pipeline. Step 6f, if ever taken, is an engine-level change and gets its own
plan. One optional 1-line addition to the existing `patches/three@0.183.2.patch` is
mentioned in T2/T3 as an alternative to a runtime re-configure — **not** required for 6a–6e.

---

## 6. Player-facing UX

### 6.1 Settings → Graphics

| control | type | default | notes |
|---|---|---|---|
| **HDR output** | checkbox | **off** | ⚠ off by default even when detected. Requires a reload (the canvas format is fixed at construction, like `perf profiler`). Disabled with a reason string when `dynamic-range: high` is false. |
| **HDR brightness** | slider, 0–100% of calibrated peak | 100% | Artistic trim over the calibrated value; does **not** replace calibration. |
| **Calibrate HDR…** | button → §6.2 | — | Re-runnable. Shows the current value and the brightness caveat. |
| **veiling glare** | existing slider | 1.0 → **re-judge in 6e** | |
| **AgX tone mapping** | existing checkbox | on | Becomes "display transform: AgX / Neutral"; Neutral stays SDR-only (it has no peak parameter). |

🔑 **HDR off by default is a deliberate call, and the LG 27GL850-B is why.** It advertises
HDR10 with ~400 nits and no local dimming: about **1 stop** of real headroom, and engaging
HDR on such a panel typically looks *worse* than SDR (raised blacks, coarser gradients).
Auto-enabling would make the game look worse on hardware that claims to support the
feature. Opt-in + a calibration screen that *shows* the player their real headroom is the
honest design.

### 6.2 The calibration screen

Copy Windows 11's interaction, with one twist that suits a space game.

```
┌──────────────────────────────────────────────────────────────┐
│  Raise the slider until the disc stops getting brighter.     │
│                                                              │
│              ██████████████████████                          │
│              ████  ◜◝  ████████████    ← patch at value V    │
│              ████  ◟◞  ████████████       on a field at 1.0  │
│              ██████████████████████                          │
│                                                              │
│   headroom  ├────────●───────────────┤   2.9 stops (7.5×)    │
│                                                              │
│   ⓘ Headroom depends on your display brightness. If you      │
│     change it, calibrate again.                              │
└──────────────────────────────────────────────────────────────┘
```

- Patch at extended value `V`, surround at just below `V`. Past the display's clip point
  the two fuse — that is the threshold, and it is the same "until the pattern disappears"
  psychophysics Windows uses.
- Also collect a **black-floor** step (matching Windows' min-luminance pattern). This one
  earns its place here specifically: LIGHTING_PLAN records that AgX crushes below
  display-linear 1.758e-4 and **the night floor sits only 0.4 stops above it**, so the
  dark end of this game is genuinely near the limit of what a panel can show.
- Seed the slider from `ScreenDetailed.hdrHeadroom` when the flag happens to be on, else
  from a **conservative 2 stops**.
- Offer the three Unreal-style presets (~1,000 / 2,000 / 4,000 nit) as coarse shortcuts,
  because a calibration screen the player abandons should still leave a sane value.

🔑 **The calibration screen doubles as the experiment that settles §2.2 empirically.**
Under the encoded-sRGB reading, canvas 2.3 is linear ≈6.9× reference white; under a
linear reading it is 2.3×. Those predict clip points **3 stops apart**, so the very first
run of this screen on the XDR *measures which is true* — the spec-reading in §2.2 becomes
a falsifiable prediction instead of an assumption.

### 6.3 The HUD

The HUD is HTML over the canvas, so it stays at paper white — which is correct
(BT.2408 puts graphics at reference white). Two consequences to watch:
- A very bright scene makes the HUD read dim. Our auto-exposure anchors mid-grey to
  paper white, so the *average* stays put; if it still bites, the lever is the 6e glare
  re-judgement, not HUD brightness.
- If an extended-range canvas ever affects page compositing, CSS **`dynamic-range-limit`**
  (`standard` | `constrained` | `no-limit`) can pin the HUD. Available Chrome 133+.

---

## 7. The colorimeter — a specific, high-value job

Not a nice-to-have. **It is the instrument for the one measurement this project has never
been able to make.** LIGHTING_PLAN records that a WebGPU canvas cannot be read back
(`drawImage` into a 2D canvas returns zeros), so we have never measured the *delivered*
end of the chain — only what we put in.

A colorimeter closes it:

1. **Fit the OETF above 1.0.** Display patches at 0.5, 1.0, 1.25, 1.5, 2.0, 2.5; measure
   cd/m²; fit the exponent. This *settles* encoded-vs-linear (§2.2) by measurement, and
   catches any browser-side tone mapping we did not know about.
2. **Measure what canvas 1.0 actually is, in nits**, at two or three brightness settings.
   Confirms 1.0 = OS SDR white and quantifies the EDR headroom/brightness trade (§2.3) as
   a curve instead of an anecdote.
3. **Cross-check the perceptual calibration.** Gate: within **0.3 stops** of the slider
   result. If they disagree by more, the calibration pattern is wrong, not the panel.
4. 🔑 **Close the photometric loop, end to end, for the first time.** `__lum.probe()`
   says a pixel is *X* cd/m² scene-referred → the display transform maps it to display
   value *Y* → the meter says the screen emits *Z* nits. Every stage of Phases 1–8 has
   been validated against *internal* consistency. This is the first external check, and
   it is the only one that can catch an error common to both sides of every previous A/B.

Practical route: ArgyllCMS `spotread -y l` reports XYZ + cd/m² per patch from most
consumer colorimeters (i1Display, Spyder, ColorMunki) — no vendor app needed.
⚠ Do **not** use Chrome's "Force color profile" flag while measuring: it disables HDR
support outright.

---

## 8. Open risks

| risk | mitigation |
|---|---|
| three's own HDR PR notes that its tone mapping and HDR output are "not yet meant to be configured together". | We are insulated by construction: `renderer.toneMapping = NoToneMapping` and we own the transform in-graph. Step 6a verifies it before anything depends on it. |
| `rgba16float` present costs bandwidth. | Gate 6a measures it with `__bench.sweep()`. Budget: ≤0.2 ms. |
| Headroom changes at runtime (macOS brightness). | `uDisplayPeak` is a uniform; no recompile. Consider listening for a headroom-change event if/when one exists. |
| Safari's WebGPU may not honour `toneMapping`. | `getConfiguration()` read-back is the feature test; fall back to `H = 1`, which is exactly today's image. |
| ⚠ `__bench` numbers are **no longer comparable** to PERF_MEASUREMENT.md's baseline — real orbits (E0) moved the sweep to a ~1/3-lit Earth closing on the night side. | Re-baseline before quoting any 6a delta. |

---

## 9. References

- [ITU-R BT.2408-5](https://www.itu.int/dms_pub/itu-r/opb/rep/R-REP-BT.2408-5-2022-PDF-E.pdf) — HDR reference white 203 cd/m².
- [CSS Color HDR Module Level 1](https://drafts.csswg.org/css-color-hdr/) — reference white, headroom in stops, `dynamic-range-limit`.
- [WebGPU HDR explainer](https://github.com/ccameron-chromium/webgpu-hdr/blob/main/EXPLAINER.md) · [Intent to Ship](https://groups.google.com/a/chromium.org/g/blink-dev/c/rBQIRHUEAe8) · [MDN `GPUCanvasContext.configure()`](https://developer.mozilla.org/en-US/docs/Web/API/GPUCanvasContext/configure)
- [Adding HDR headroom to `ScreenDetailed`](https://lists.w3.org/Archives/Public/public-secondscreen/2025Aug/0001.html) (W3C, Aug 2025) · [ColorWeb-CG issue 42](https://github.com/w3c/ColorWeb-CG/issues/42)
- [Unity HDR Output (HDRP)](https://docs.unity3d.com/Packages/com.unity.render-pipelines.high-definition@15.0/manual/HDR-Output.html) — paper white / max / min nits, "implement a calibration menu".
- [Unreal HDR Display Output](https://dev.epicgames.com/documentation/en-us/unreal-engine/high-dynamic-range-display-output-in-unreal-engine) — per-peak ODTs, scRGB conventions.
- [Blender: HDR options for AgX](https://projects.blender.org/blender/blender/pulls/142758) · [Godot: HDR + AgX parameters](https://github.com/godotengine/godot-proposals/issues/12317) — AgX retargeted by peak.
- [Windows 11 HDR Calibration](https://www.xda-developers.com/how-to-use-hdr-calibration-windows-11/) — the three-pattern interaction.
- [Apple: Explore HDR rendering with EDR (WWDC21)](https://developer.apple.com/videos/play/wwdc2021/10161/) · [EDR headroom vs brightness](https://prolost.com/blog/edr)
- Uchimura, *Practical HDR and Wide Color Techniques in Gran Turismo SPORT*, [SIGGRAPH Asia 2018](http://cdn2.gran-turismo.com/data/www/pdi_publications/siggraph_asia_2018_cousenotes.pdf)
