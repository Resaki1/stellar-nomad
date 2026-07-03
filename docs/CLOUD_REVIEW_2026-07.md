# Cloud + Atmosphere Review — Findings & Roadmap (2026-07)

Reference doc for the volumetric cloud / atmosphere review done 2026-07-03
(commit `d251506`). Written so future sessions (Fable or Opus) can pick up any
item without re-deriving the analysis. **Line numbers drift** — treat them as
"was here at d251506", re-grep the named symbol before editing.

Companion docs (read alongside): `CLOUD_DEBUGGING_LESSONS.md` (case studies,
esp. #16 zero-mips, #22 terminator/horizon/flicker/orbit-perf),
`VOLUMETRIC_CLOUDS_PLAN.md`, `VOLUMETRIC_CLOUDS_SHAPE_PLAN.md`,
`VOLUMETRIC_CLOUDS_PERF.md`, `ATMOSPHERE_PLAN.md`. Memory pointer:
`project_cloud_review_2026_07`.

## Working method (do not skip)

The user requires **measure-first, no speculative fixes** (see memory
`feedback_debugging`). Every item below carries a falsification/measurement
step using diagnostics that ALREADY EXIST in the code. Do the measurement,
confirm the mechanism moves the symptom, THEN implement. When a fix lands,
append the result (and any new lesson) to `CLOUD_DEBUGGING_LESSONS.md`.

Build-const A/B toggles available (flip, reload, observe):
- `ATMOSPHERE_PASS_ENABLED` (SpaceRenderer)
- `USE_FROXEL_AP`, `USE_SKYVIEW`, `DEBUG_ATMOSPHERE`, `AP_DEBUG` (atmospherePass)
- `USE_LIGHT_VOLUME`, `DEBUG_FULLSCREEN` (cloudFullscreenPass)
- `DEBUG_VIZ`, `USE_DETILE`, `FINE_CARVE`, `WISP_DETAIL`, `HHF_STRENGTH` (earthClouds)
- `DEBUG_RECONSTRUCTION` (cloudReconstructionPass)

---

## Overall verdict

The system is well-engineered and already encodes most industry lessons
(per-step coverage sampling, STBN jitter, footprint/detail-distance LOD,
world-anchored light volume, MRT sparse marcher + reconstruction). The
remaining problems are **architectural seams between representations**, not
sloppy code:
- froxel AP is a *near-field* structure being asked to fog *orbital* distances;
- the flat 2D overlay and the volumetric are lit and shaped by different math;
- cloud *type* and *height* are both hardwired to coverage → only two looks.

---

## DONE (landed 2026-07-03)

- **Skip cloud composite + repeated history clears at orbit.**
  `SpaceRenderer.tsx` — when `cloudsVisible` is false (blend = 0, above
  ~3000 km) the full-DPR composite pass (25 denoise taps + 9 AP-depth taps +
  froxel sample/pixel) and the per-frame history clear were still running to
  blend zeros. Now each ping-pong history RT is cleared once (`clearedHistoryCount`
  ref, 2 frames) then both clear and composite are skipped until clouds resume.
  Pass 4 target/autoClear state still set unconditionally.
  - Verify: below 1500 km unchanged; climbing past 3000 km no ghost remnant +
    small FPS gain; descending no one-frame flash; resize at orbit then descend
    no stale-history flash.
- **Comment fixes** in `cloudReconstructionPass.ts`: variance-clamp pad said
  "50%" (code is 0.125); two comments described the old `SPARSE_DIVISOR=4`
  layout (now 2).

---

## ISSUE 1 — Froxel aerial-perspective "blue ring" + banding/flicker (HIGH priority)

**Symptom (user):** froxel fog fades clouds to blue with distance; looks good
at cloud level; from orbit a bluer ring surrounds the camera (clouds inside the
froxel range hazed, clouds beyond it not). Raising `FROXEL_MAX_DEPTH_KM`
300→600 shrank the ring but introduced banding + flicker near the horizon.

**Root cause A — the ring (CONFIRMED from code):**
`applyCloudAerialPerspective` (atmospherePass.ts ~L392):
```
depth01 = clamp(depthKm / FROXEL_MAX_DEPTH_KM, 0, 1)
wSlice  = sqrt(depth01)         // quadratic slice distribution
```
Every cloud beyond the far plane samples the SAME last slice → AP stops growing
with distance exactly at that radius. The iso-distance circle at that radius IS
the ring. Raising the constant only moves the circle outward.

**Root cause B — banding/flicker (TWO candidates, must disambiguate):**
1. **Bake undersampling.** Each 32³ froxel voxel marches `[0, depth]` with a
   fixed `FROXEL_MARCH_STEPS = 24` (atmospherePass.ts ~L1457/L1465). At 600 km
   that's ~25 km/step vs an ~8 km Rayleigh scale height on grazing rays →
   per-slice integration error differs slice-to-slice → horizon bands. At 300 km
   steps were half as long, hence banding appeared with the 300→600 change.
2. **Depth jitter.** The fog depth is the CURRENT frame's sparse `tFront`
   (STBN + Bayer jittered, half-res), read via a 3×3 sentinel-rejecting mean
   (`CLOUD_DEPTH_GATHER_RADIUS = 1`). AP is applied at COMPOSITE time, so the
   colour path's temporal EMA never damps this depth. Jitter → `sqrt(depth01)`
   → slice space → multiplies a steep AP gradient → flicker. (The code comment
   at atmospherePass.ts ~L266 already discusses this stability tradeoff.)

**Measurement plan (one screenshot each, orbit view of the limb):**
- `AP_DEBUG = 'constSlice'` (pins the slice; froxel CONTENT drives output). If
  banding PERSISTS → it's bake content (cause A). If it VANISHES → it's the
  depth path (cause B).
- `AP_DEBUG = 'wslice'` vs `'sparseRaw'` — the gathered slice coordinate vs the
  raw single tap. Smooth 'wslice' + speckled 'sparseRaw' = depth jitter present;
  the gather is the intended fix and any residual points at cause A.
- `AP_DEBUG = 'apL'` / `'apT'` — the froxel's in-scatter / transmittance
  directly, to see the bake's own smoothness.
- One-line A/B: `FROXEL_MARCH_STEPS` 24 → 48 (bake is trivial at 32³).

**Fix options (do AFTER measurement), ranked:**
| # | Fix | Effort | Notes |
|---|-----|--------|-------|
| 1 | Bake steps 24→32/48, keep 600 km | trivial | Kills content banding if cause A. First thing to try. |
| 2 | Analytic AP fallback beyond the far plane: for `depthKm > max`, extend the far-slice value along the view ray using transmittance-LUT extinction (or the main pass's single-scatter integral) | medium | **The correct ring fix.** Froxel stays a dense near-field structure (Hillaire's intent); distance fog continues smoothly past it. |
| 3 | Altitude-adaptive far plane via existing `uFroxelMaxDepthKm` uniform (≈ horizon distance) + scale bake steps with it | low-med | Removes ring but stretches slices → only viable WITH #1; #2 is cleaner. |
| 4 | Feed AP depth through a tiny temporal filter (reuse reconstruction history) if cause B dominates | medium | Only if 'constSlice' proves depth path is the flicker. |

**Recommended path:** measure → apply #1 (cheap) → if ring remains (it will),
implement #2. This is the highest-value next session.

---

## ISSUE 2 — 2D overlay ↔ volumetric crossfade seam (HIGH priority)

**Symptom (user):** the fade between the flat 2D cloud texture (orbit) and the
volumetric clouds (close) is "not really seamless."

**Root cause — THREE stacked mismatches between the two representations:**
1. **Lighting model.** Flat overlay (earth.ts ~L391-424):
   `white × CLOUD_BRIGHTNESS(3) × csf(ad-hoc curve) × cloudHemi × cloudSelfShadow
   × sunTCloud`. Volumetric: physical — `sunIlluminance × transmittanceLUT ×
   HG dual-lobe + multi-scatter + sky ambient`. They only match by tuning
   accident at the handoff altitude.
2. **Coverage mapping.** Volumetric shows `pow(texture.r, 0.6)` then Remap-erodes
   by 3D noise; overlay shows the texture ~directly. The `thinKeep` gate
   (earth.ts ~L452, `FLAT_OVERLAY_COVERAGE_LO/HI` 0.05/0.25) removes the 2D
   overlay above coverage 0.25 while the volumetric under-renders mid-coverage →
   a net cloudiness DIP in the 0.25–0.6 band during the blend.
3. **Geometry / parallax.** Overlay painted at surface radius WITH mipmaps;
   volumetric at 1–14 km altitude with forced `.level(0)`. At the limb this is a
   visible parallax offset + a sharpness discontinuity.

**Measurement plan:**
- Park the camera at blend ≈ 0.5 (altitude ~2250 km). Screenshot. Compare region
  luminance and coverage of overlay-only vs volumetric-only zones — the dip
  should be visible in the 0.25–0.6 coverage band.
- Toggle `uFlatCloudOpacity`/`uVolumetricBlend` curves (earth.ts onFrame ~L587)
  to hold each fixed and see which layer causes the visible step.

**Fix options, ranked by payoff-per-effort:**
| # | Fix | Effort | Notes |
|---|-----|--------|-------|
| 1 | Relight the flat overlay with the SAME physical terms (sun illuminance × cloud-altitude transmittance LUT × a fixed pseudo-phase + atmosphere sky ambient), replacing `CLOUD_BRIGHTNESS`/`csf` | low | Biggest ratio. Makes the two layers agree in colour/brightness at the seam. |
| 2 | Apply a matching coverage curve to the overlay alpha so integrated opacity ≈ the volumetric's post-Remap result across the blend band | medium | Removes the cloudiness dip. Validate with the blend≈0.5 screenshot. |
| 3 | **Distance-based handoff (the real fix):** near = volumetric, far = flat/impostor, split per-pixel by DISTANCE not global altitude | medium-high | Solves the seam AND the orbit-perf valley in one change. Already flagged "deferred" in `CLOUD_DEBUGGING_LESSONS.md` case #22. The industry standard (Nubis near-volumetric / far-impostor). |
| 4 | Bake the far LOD FROM the volumetric system (so lighting + coverage match by construction) | high | The most seamless but largest change; consider only if #1-3 leave residual seam. |

**Recommended path:** #1 first (cheap, high impact) → #2 → schedule #3 as its
own project (it overlaps the perf work below).

---

## ISSUE 3 — Cloud shapes: the binary "puffs vs fields" look (MEDIUM-HIGH priority)

**Symptom (user):** close-up shapes look good (image 1); at medium distance /
from above they don't read as real (image 2, mushy). Exactly two modes — small
puffs in low coverage, dense fields in high coverage — never a mix. Wants real
cloud TYPES (cirrus, cirrostratus, cumulonimbus w/ anvils) + weather-driven
precipitation later; wants the system to port to gas giants / procedural planets.

**Root cause — CONFIRMED: type and height are deterministic functions of coverage.**
- `cloudType = smoothstep(0.3, 0.6, coverage)` (earthClouds.ts ~L1665).
- `covSpan = smoothstep(0.35, 0.7, coverage)` gates `topAlt` (~L1729).
So low coverage ALWAYS → short broken puffs (stratus/stratocumulus profile);
high coverage ALWAYS → tall dense fields (cumulus). No independent axis → the
sky has exactly two looks. The code itself marks this deferred: "Stage 2:
re-author weather map with explicit cloudType channel."

Medium-distance mushiness: `DETAIL_FADE_NEAR/FAR` (20→100 km, earthClouds.ts
~L535) fades ALL fine octaves (FINE_CARVE + WISP + HHF) to ZERO, leaving only
macro Worley blobs. That's the case-#22 anti-flicker fix — necessary, but it
over-smooths the mid range.

**Improvement plan, ordered by visual-payoff-per-effort:**
1. **Multi-channel weather map** (R=coverage, G=type, B=height/precip). THE
   Nubis/Decima/Star Citizen answer — yes, they generate/simulate weather maps.
   Shader change is tiny (replace the two `smoothstep`s with texture channels);
   the work is GENERATING the map. Start procedural: existing coverage texture +
   an independent low-frequency noise for type + another for height. Later a
   drifting weather sim. This ALSO becomes the driver for rain/thunder/snow and
   the port to other planets (each planet supplies its own map + profile params).
   Effort: ~days. Risk: low (additive, gated behind a flag). **Do this first.**
2. **Height-dependent erosion + wind shear.** User's instinct is right. Add
   altitude-dependent horizontal skew (`p += windDir · shearK · alt01²`) and
   scale `FINE_CARVE_STRENGTH` up with `alt01` so tops fray harder than bases →
   anvils / real cumulonimbus tops. Cheap ALU. Tune vs `DEBUG_VIZ='eroded'`.
   Effort: ~hours-days.
3. **Cirrus / high thin clouds as a SEPARATE cheap layer** (textured shell above
   the 1–14 km slab), NOT more volumetric types. Frostbite/SC do exactly this.
   Keeps the marcher's slab thin (perf) while adding large sky variety.
   Effort: ~days.
4. **Fix mid-distance mushiness:** fade fine detail to a mid-frequency FLOOR
   instead of 0, or raise `DETAIL_FADE_FAR` — BUT re-measure the distant-flicker
   regression this fade exists to prevent (case #22) before keeping. Effort: hours.

**Validation for all:** `DEBUG_VIZ='eroded'` / `'profile'` / `'maxProfile'`;
compare against reference cloudscape photos at matched view distances.

---

## PERFORMANCE (MEDIUM priority — measure attribution first)

**Symptom:** 39–49 fps at 10–13% CPU in screenshots → GPU-bound. Case #22 had
tuned the orbit valley to ~87 fps; the atmosphere passes landed AFTER that.

**Prime suspect:** Pass 1.5 (atmosphere march) runs full-DPR (1.5× on Retina =
2.25× pixels) × 32 steps EVERY frame, plus froxel + sky-view bakes.

**Attribution measurement (~15 min, do FIRST):** at each of the three screenshot
locations (in-cloud, high-atmosphere, orbit), flip one at a time and record fps:
`ATMOSPHERE_PASS_ENABLED`, `USE_FROXEL_AP`, `USE_SKYVIEW`. Also `DEBUG_VIZ='iters'`
in the marcher to see whether the residual is skip- or dense-bound (case #22
method: null-result of `LOD_STEP_GROWTH` change proved lodCap-bound).

**Levers, ranked (after attribution):**
| # | Lever | Effort | Notes |
|---|-------|--------|-------|
| 1 | Atmosphere pass at half-DPR + depth-aware upsample; extend sky-view LUT to orbit so sky pixels skip the march at altitude (Hillaire covers this) | medium | Likely the biggest single win if #suspect confirmed. |
| 2 | Dense-voxel fetch budget: ~8-9 texture3D/voxel (base, carve, fine, column, weather, light-vol, macro-probe base+carve, near-probe). Code flags the 800 m probe for profiling ~240 km with a designed fallback ("fade toward its MEAN absorption with distance, never toward 1") | medium | `DEBUG_VIZ='iters'` + GPU timing. |
| 3 | Gate the per-step column tap (earthClouds ~L1689) on `coverage>0.01` BEFORE the 3D fetch — saves one 3D fetch per empty step on sky rays | low | Measure; the tap currently runs before any coverage gate. |
| 4 | Composite `CLOUD_DENOISE_RADIUS` 2→1 (25→9 taps at full DPR) | trivial | A/B for grain tolerance. |
| 5 | Distance-based volumetric→flat handoff (Issue 2 #3) — the fundamental orbit-perf fix per case #22 | high | Overlaps the crossfade work; every pixel marching the whole deck from orbit doesn't scale. |

---

## SMALLER FINDINGS (quality / maintainability)

- **Lockstep-duplication debt (biggest maintainability risk).** These MUST be
  hand-kept-in-sync across files, each with a "keep in sync" comment:
  `CLOUD_TOP_ALTITUDE_KM`(earth.ts) ↔ `CLOUD_OUTER_ALTITUDE_KM`(earthClouds);
  `LIGHT_STEP_SCALED`, `CONE_DENSITY`; `cloudHeightProfile` ↔
  `cloudHeightProfileInline`(cloudLightVolume); `WARP_AMPLITUDE` ↔
  `WARP_AMPLITUDE_MIRROR`; the `topAlt`/`covSpan` formula; the ENTIRE noise stack
  duplicated `noiseVolumes.ts` ↔ `cloudVolumeCompute.ts`. `cloudDetile.ts`
  already proves the shared-module pattern (single `baseDilate`). Consolidate
  into one `cloudShared.ts`. Low-risk, kills the silent-drift bug class.
  Effort: medium; do as a dedicated cleanup pass.
- **Latent WebGPU hazard.** Reconstruction reassigns `TextureNode.value`
  per-frame (cloudReconstructionPass.ts ~L547) — the exact pattern SpaceRenderer
  avoids elsewhere (pre-built composite mesh pairs) because the WebGPU bind-group
  cache doesn't always honour it. Works today; if one-frame-stale reconstruction
  ever appears, look here first.
- `DETILE_BLEND = 2.0` is outside its documented [0..0.5] range (cloudDetile.ts).
  Inert while `USE_DETILE=false`; a trap on re-enable.
- **Dead-while-toggled code:** the 6-tap cone-march (~200 lines in earthClouds)
  is dead while `USE_LIGHT_VOLUME=true`, carries a detile TODO if revived. The
  hoisted 3-tap coverage samples (covNear/covMid/covFar) survive only to feed a
  trivially-true `If` gate (3 wasted 2D taps + trig/pixel) — BUT the `If` is
  documented load-bearing TSL scope magic (removing it zeroed alpha). Leave
  unless someone re-falsifies that.
- `noiseVolumes.ts` (829 lines, CPU) is now dev-pages-only; live path is the GPU
  bake `cloudVolumeCompute.ts`. Add a header note naming the GPU bake as the
  source of truth.

---

## FUTURE FEATURES (sequence AFTER the weather-map refactor)

All three consume the weather map, so do Issue 3 #1 first.
- **God rays** — natural home is the froxel (already integrates in-scatter along
  view rays); crepuscular rays = froxel in-scatter modulated by cloud shadow.
- **Ship ↔ cloud lighting** — the light volume already gives sun transmittance at
  arbitrary earth-space points nearly free; sample it at the ship position for
  cloud-shadowed ship lighting. Trails / turbulence shake = separate systems
  keyed off the marcher's density at the ship position.
- **Gas giants / procedural planets** — parameterize the Earth-specific constants
  (radius, slab altitudes 1–14 km, weather texture, scaled-unit conversions,
  atmosphere params) into a per-planet config object. The marcher is already
  "geometry-agnostic" (its comment) — the blocker is the hardcoded constants and
  the single weather texture, both resolved by the multi-channel-map work.

---

## Suggested session ordering

1. **Froxel measurement + fix** (Issue 1) — highest value, self-contained, cheap.
2. **Perf attribution** (15 min) — cheap, informs everything else.
3. **Crossfade relight** (Issue 2 #1-2) — high impact, low-medium effort.
4. **Multi-channel weather map** (Issue 3 #1) — unblocks shapes + features + porting.
5. **Distance-based handoff** (Issue 2 #3 / Perf #5) — the big architectural one.
6. **Shared-constants consolidation** — cleanup, do when touching these files anyway.
