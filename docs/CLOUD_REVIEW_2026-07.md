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

## ⇢ RESUME HERE (2026-07-07 pt.2): baked HEIGHT field + parallax LANDED — awaiting user verification

The expected-opacity LUT shell (below) VERIFIED GOOD by the user (needed
`SHELL_OPTICAL_PATH = 1` — the marcher's orbital opacity is quite translucent —
and handoff widened to 600→1600 km). User then asked whether a baked texture
could add DEPTH; conclusion (recorded below): bake only view-INDEPENDENT scalar
FIELDS, never lit appearance (phase/silver-lining is view-dependent) and never a
planet-wide 3D volume (memory-prohibitive + redundant with the marcher).

**FUTURE depth options (not done):** stacked shells at 2–3 altitudes; bake a
THICKNESS channel too (vertical extent) for view-dependent extinction; keep
widening the handoff so the real marcher supplies depth sooner. Principle to
hold: bake only view-independent fields, light live, never go 3D.

---

## Previous (2026-07-07 pt.1): expected-opacity LUT + timing fix — VERIFIED GOOD

Two rounds of measurement fixed the shell. Round 1 (2026-07-06) = the analytic
survival-CCDF shell. User tested it and found TWO new problems (screenshots):
  1. Shell only appeared ≤ ~9,300 km from Earth centre (~2,900 km alt).
  2. `SHELL_SURVIVAL_LAYERS`=1 → most of the planet gray (low coverage too
     opaque); =0.08 → low ok but hard edges + high-coverage too transparent.
     A single tone exponent could not satisfy both coverage regimes.
Diagnosed (not guessed):
  1. **Timing bug.** The LUT compute rode `pendingBakes`, drained unconditionally
     only ONCE at startup (`warmCloudBakes`, frame 1). The LUT is queued LATER
     (when `buildEarthClouds` runs at tier-entry), so it sat undispatched until
     the *gated* `flushCloudBakes` (inside `if (cloudsVisible)` = volumetric
     blend > 0 = near-surface). Until then LUT = zero-filled → alpha 0 →
     invisible shell. → FIX: `SpaceRenderer` now calls `flushCloudBakes`
     UNCONDITIONALLY each frame (right after `warmCloudBakes`), so a late-queued
     LUT dispatches from orbit.
  2. **CCDF over-counted thin density.** P(carved > threshold) counts a `carved`
     barely above threshold — near-zero eroded density the marcher would
     Beer-Lambert to ~transparent — as fully covered. So low coverage read gray
     and no exponent could fix both ends. → FIX: the LUT now bakes **expected
     rendered opacity** E_noise[1 − exp(−pow(eroded, DENSITY_GAMMA)·PATH)] vs
     dimProfile, eroded = saturate(dimProfile − (1−carved)·K_EFF). The exp()
     makes thin→~0, thick→~1 by construction; shell reads LUT(maxDim) directly,
     NO tone knob.

**Current implementation (`getShellOpacityLUT` + `columnMacroCoverage`):**
- Shell samples ZERO 3D noise per frame (flicker source gone). Coverage =
  mipped weathermap → type → profile over `SHELL_ALT_SAMPLES {0.1,0.3,0.55,0.8}`
  (low band = the stratus fix) → `maxDim = coverage·maxProfile` → `LUT(maxDim)`.
- LUT = 256×1 rgba8, Monte-Carlo'd (8192 samples/bin) on the GPU from the REAL
  volumes at load, riding the bake queue via `queueCloudBake`; kernel mirrors
  the marcher dense branch (dilate + billow carve + K erosion + DENSITY_GAMMA)
  — **keep in lockstep** (comment at the kernel). Same monotone-by-construction
  sample stream; d=0 → opacity 0 → clear sky stays clear.
- ONE knob: `SHELL_OPTICAL_PATH` (default 18; ×eroded inside the exp → sets
  saturation rate, shapes low vs high correctly at ALL values). `SHELL_COL_SAMPLE
  = 0.65` const replaces the column tap. `SHELL_OPACITY_LO/HI` + the
  `SHELL_SURVIVAL_LAYERS` exponent + `applyBillowCarve` all removed.
- Debug modes: 'maxDim' + 'opacity' (was 'survival'); tap ladder kept.
- tsc 0, lint 0 (only pre-existing `sin`/`phaseIsotropic` warnings).

**VERIFY (user, in-game):** (1) shell now visible from FAR orbit (not just
≤9,300 km); (2) far orbit: no frizz/rings under camera motion; (3) high-coverage
opaque AND low-coverage soft-but-present, simultaneously (the fix); (4) approach:
300–600 km hand-off continuous; (5) tune `SHELL_OPTICAL_PATH` ~10–30 for
fuller/thinner; (6) 'opacity' debug: smooth monotone field. Accepted deltas:
smooth haze (not resolved puffs) at low coverage; fuller than MESOSCALE_TEST
decks (marcher-only mask).

### Rotation / drift / procedural analysis (user Qs 2026-07-07) — the LUT is likely the KEEPER
- **View-direction independent?** YES. Neither the shell nor a would-be bake is
  a billboard/octahedral impostor (those pick a baked viewpoint at runtime →
  view-dependent, parallax artefacts — NOT used). This is a coverage FIELD in an
  equirect (lat/lon) texture sampled on a REAL sphere mesh, exactly like the
  planet albedo/weathermap. Correct from every angle, true geometric parallax.
- **Rotation-safe?** YES. The shell is planet-LOCAL (parented to the rotation
  group), like the ground. Rotates rigidly with the planet; no view-space state.
- **Drift (future, true-to-life speed):** the analytic LUT wins here. Drift is a
  rigid equirect UV shift of the coverage source (uCloudUvOffset), applied LIVE
  on the mipped weathermap at sample time → free, zero re-bake. The LUT is a 1D
  erosion-statistics distribution — **drift-invariant**. A full 2D equirect bake
  would fold coverage×erosion spatial alignment into the texel → needs re-baking
  as drift advances (cheap at glacial real speeds, but non-zero). So the LUT is
  MORE rotation/drift-friendly than the 2D bake, not less.
- **Procedural planets:** the LUT bakes from the per-planet noise volumes +
  CloudFieldProvider — works for any planet by construction.

**Bottom line:** if verification passes, the expected-opacity LUT is the
long-term answer, not an interim step. The only thing the deferred 2D bake buys
is resolved sub-texel PUFF STRUCTURE (the LUT gives a smooth field) — and from
orbit puffs are sub-pixel anyway, with the volumetric supplying detail past the
hand-off. Revisit the 2D bake ONLY if the smooth far field reads too flat at the
300–600 km band; otherwise drop it (it costs drift-rebaking + VRAM for little).

---

## Previous state (2026-07-06 morning): two OPEN cloud-shell bugs — SHELL_DEBUG_VIZ landed, awaiting measurements

Phase 2 (dedicated cloud shell) + Q1 (hand-off/perf) + Q2 (shared coverage
model) + the shell mip fix have LANDED (see DONE below). Two bugs remain on the
shell; **debug measure-first, not guess**. Both are in `earthClouds.ts`
(`buildCloudShellMesh` + `columnMacroCoverage`).

**2026-07-06 static verification (code + assets inspected, strengthens both
hypotheses):**
- `earth_clouds_8k.ktx2` HAS a full 14-level mip chain (ktxinfo) and near-tier
  sets aniso 8 → the weathermap sampling should be alias-free. Near tier runs to
  35,000 km (`earth.ts lod.near`) → both user screenshots (6,693 / 12,535 km)
  are near-tier/8k — no tier crossfade involved.
- The 3D noise volumes are **single-mip storage textures**
  (`cloudVolumeCompute.ts`: `generateMipmaps = false`; that's why
  `getGpuCloudDetailMip1` exists as a hand-built downsample). So the shell's
  three `.level(0)` 3D taps CANNOT be mipped even in principle. Feature sizes vs
  pixel footprint (~1 px ≈ dist·0.001): carve @ CARVE_SCALE=360 → 0.5–1.5 km
  cells, sub-pixel at EVERY distance the shell is visible (footprint ~0.6 km
  already at the 600 km hand-off); base FBM @ BASE_SCALE=50 → 2.5–20 km, sub-
  pixel beyond ~2,500–5,000 km; colSample @ COLUMN_SCALE=30 → ~8 km, marginal at
  12,535 km. Sub-pixel periodic noise + pixel grid = the frizz that re-rolls
  under camera motion + the concentric moiré rings in the 12,535 km screenshot.
- `cloudHeightProfile` stratus support confirmed: nonzero only for alt01 ∈
  (0, 0.25). The shell samples {0.3, 0.55, 0.8} → pure-stratus columns
  (lifted coverage ≲ 0.3, raw ≲ 0.13) read profile = 0 at ALL samples. The shell
  only "turns on" once the 0.3 tap sees stratocumulus, i.e. lifted coverage
  ≈ 0.4+ (raw ≈ 0.22+) — exactly "only HIGH coverage renders".
- Phase-F divergences: `MESOSCALE_TEST` (marcher-only coverage mask, true zeros
  in lanes) makes the MARCHER sparser than the shell model — can't cause Bug A
  (opposite sign) but is a known seam once A is fixed (shell will show unbroken
  stratus where the marcher shows meso-broken puffs). `EROSION_NUBIS_FORM`
  (K_EFF=1.0) and `TOPALT_LINEAR` ARE shared with the shell. The marcher's
  anti-tiling domain warp (warpVec) is NOT in the shell's `macroDilatedShapeAt`
  (minor footprint mismatch, sub-dominant).

### The measurement protocol (SHELL_DEBUG_VIZ, earthClouds.ts ~line 114)
`SHELL_DEBUG_VIZ` renders the shell as false-colour scalars (alpha=1, no
lighting/fades → visible at any distance; the volumetric still composites over
it, which is useful context). `'noiseFree'` is a NORMAL render with all 3D taps
removed from the graph. Set one mode, reload, observe, report:

| Mode | Where to look | What the result means |
|---|---|---|
| `rawCoverage` | far orbit, move camera | Smooth + stable expected (14-mip KTX2). If it frizzes → 2D sampling broken (unexpected). |
| `profileMax` | regions where the volumetric shows small clouds | BLACK there = Bug A confirmed (altitude samples miss the stratus band). |
| `profileMaxLow` | same regions | Now WHITE = the low-band sample (alt 0.10) is the fix direction. |
| `maxShape` | same regions | Gray level: 0 = profile-limited (pure A); ~0.05–0.2 = the SHELL_OPACITY_LO/HI transfer also crushes what the marcher would integrate to ~opaque (A2). |
| `colSample` / `baseMacro` / `carve` | far orbit, move camera | Which tap frizzes/rings, and from what distance. Expect `carve` worst (always sub-pixel), `baseMacro` next, `colSample` least. |
| `noiseFree` | normal gameplay look, far orbit | Flicker/rings GONE = Bug B confirmed as the mip-0 3D taps. Coverage reads fuller (no erosion) — expected, ignore. Doubles as the smooth-envelope look preview. |

### ✅ MEASURED (2026-07-06) — user ran all modes; diagnosis CONFIRMED
- `rawCoverage`: smooth + stable → weathermap sampling fine (ruled out).
- `colSample`/`baseMacro`/`carve`: ALL frizz + rings; carve worst, colSample
  least — exactly the footprint ranking → **Bug B = the mip-0 3D taps (B1
  CONFIRMED)**.
- `noiseFree`: barely any flicker (only tiny threshold-speck dots — coverage
  features at the smoothstep LO edge). User: "good enough for now" → the
  smooth-envelope LOOK is acceptable.
- `profileMax`: NOT black anywhere — **refines A1**: the small-cloud regions
  have lifted coverage ≳ 0.3 (cloudType > 0), so the 0.3-alt tap reads a small
  nonzero sc-mix profile (~0.1–0.5), not exactly 0. The hard gate is NOT the
  profile alone.
- `profileMaxLow` (8,349 km): light-gray everywhere, subtle variation — profile
  at alt 0.1 is ≥ ~0.35 for every type (stratus=1, sc≈0.35, cum≈0.5). The low
  band always carries profile.
- `maxShape`: pattern ≈ 'off' — ZERO/near-zero where the volumetric shows small
  clouds → **the FULL model at {0.3, 0.55, 0.8} produces nothing there.**

**Confirmed mechanism for Bug A (A1+A2 combined):** in low-coverage regions
dimProfile at the sampled alts ≈ 0.38 × 0.35 ≈ 0.13; K_EFF=1.0 erosion needs
carved > 0.87 → almost nothing survives → the LO/HI smoothstep crushes the
remainder. The marcher meanwhile ALSO samples alt 0.05–0.25 (dimProfile ≈ 0.29,
needs carved > 0.71 → real patches survive = the small puffs) AND
Beer-Lambert-integrates any eroded ≥ ~0.05 to alpha ≈ 1. Structurally: the
marcher's orbit-view look is an AREA AVERAGE of sparse near-opaque puffs
(fractional coverage); 3 point-samples + max + smoothstep CANNOT represent
that quantity. (Note: the K→0.1 falsification predates EROSION_NUBIS_FORM;
today BASE_EROSION_K_EFF=1.0 ignores BASE_EROSION_K and maximizes the
suppression, but the low band is missed regardless.)

**Fix decision (pending user choice, AskUserQuestion 2026-07-06):**
(a) RECOMMENDED — bake the shared density model into a per-planet mipped
equirect alpha texture at load (GPU pass, supersampled per texel, altitude
ladder incl. the low band, near-binary per-texel transfer → mips give the
honest area average at every footprint). Shell then samples ONE mipped 2D
texture: zero flicker by construction, real puff structure, re-bake follows the
volumetric rework, procedural planets bake their own CloudFieldProvider, shell
shader gets simpler + cheaper (1 tap vs ~10).
(b) Analytic: permanent noiseFree shell + low-band samples + an
erosion-survival LUT (mini-bake of P(carved > 1−x) from the noise volumes at
load). Cheaper to build; shows smooth haze instead of resolved puffs; misses
spatial noise structure (meso organization).

### Bug A — low-coverage clouds ABSENT (pop-in)
- **FALSIFIED:** over-erosion (`BASE_EROSION_K` 1.2 → 0.1 changed nothing).
  Consistent with the profile hypothesis: erosion only SUBTRACTS — 0 − x is
  still 0.
- **LEADING (A1):** altitude samples {0.3, 0.55, 0.8} miss the stratus band
  (see verification above). Fix: sample the low band (add alt01 ≈ 0.10) or
  sample the per-type profile peak.
- **SECONDARY (A2):** transfer mismatch. The marcher Beer-Lamberts density with
  densMul ≈ 140,000 — ANY eroded ≥ ~0.05 sustained over a few hundred metres →
  alpha ≈ 1. The shell maps maxShape 0.1 → smoothstep(0.05, 0.35) ≈ 0.08 alpha.
  Thin decks stay far fainter on the shell even when sampled correctly.
  `maxShape` viz quantifies this; fix = lower LO/HI or a Beer-Lambert-shaped
  transfer (alpha = 1 − exp(−k·maxShape)).

### Bug B — the shell FLICKERS / frizzes / moiré rings
- **LEADING (B1):** the three mip-0 3D noise taps (see verification above —
  single-mip volumes, carve always sub-pixel). `noiseFree` is the one-flip
  falsification; the tap ladder identifies contributors.
- **Ruled out by inspection (confirm with `rawCoverage`):** weathermap mips
  (14 levels present); near/mid double-render (near tier owns both screenshot
  distances; overlap only in the compile-fallback window).

### Synthesis — the likely fix for BOTH (+ the user's independence requirement)
The shell reproduces per-voxel eroded shape that is sub-footprint from orbit
(B) and missed by 3-altitude sampling (A). The far rep should be the **smooth
macro envelope**: mipped coverage × a profile term covering the FULL slab, with
noise erosion represented by its MEAN effect (a smooth attenuation), not point
samples — optionally noise fading in only near the hand-off band.

**User requirement (2026-07-06): the 2D rep must stay correct through the
ongoing volumetric-creation rework and work for future procedural planets.**
The shared-model coupling is already leaking (MESOSCALE_TEST is marcher-only;
Q2b never unified the marcher's inline copy). The structural candidate:
**bake** the shell's coverage/opacity from the shared density model into a
per-planet equirect texture (GPU pass at load, mipped) — the shell then samples
ONE mipped 2D texture (no flicker by construction, trivially cheap), the bake
re-runs whenever the model changes (stays in sync with any rework), and
procedural planets bake from their own CloudFieldProvider. Decide AFTER the
measurements confirm A1/B1.

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

## DONE (landed 2026-07-03/04)

- **ISSUE 2 Phase 2 — dedicated cloud shell LANDED (all 6 steps).** The
  surface-shader flat overlay is REMOVED; a `SphereGeometry` at cloud-top radius
  (`buildCloudShellMesh` in earthClouds.ts, near+mid tiers, layer 0, FrontSide,
  premul) samples the shared `CloudFieldProvider` (`makeEquirectTextureField`) +
  `equirectDirToUv` + `farCloudLit`/`coverageToOpacity` (cloudCommon.ts) and is
  fogged by the atmosphere pass. Parallax fixed; lighting matches (terminator via
  `normalWorld` world-space sun dot, coverage via `positionLocal` local-space —
  the split that fixed the tilted terminator). `uShellOpacity` (earth.ts) fades
  it out at the deck (28→14 km). `SHELL_ALTITUDE_KM` tunable (=14).
  - KNOWN/deferred: (a) the whole planet has a small FPS-dependent floating-origin
    jitter; the shell's parallax makes it visible — tackle in the PERF pass, not a
    shell bug (confirmed: scales with `SHELL_ALTITUDE_KM`). (b) self-shadow is a
    cheap `1−0.5·coverage` proxy; a real sun-directional 2-tap needs the sun in
    the shell's local space (plumbing) — skipped, low payoff for a far-only layer.
  - LANDED (step 7 — Q1 near/far hand-off): the shell fades IN by
    camera→fragment DISTANCE (`SHELL_HANDOFF_NEAR/FAR_KM`, distFade in the shell
    frag) so the volumetric owns the near field and the shell carries the far
    horizon. COUPLED: the marcher's `tExit` is CAPPED at `SHELL_HANDOFF_FAR_KM`
    (stops the expensive far-deck marching — the case-#22 orbit-perf valley) and
    its output crossfades OUT over NEAR→FAR (`farFade`) as the shell fades in.
    One shared constant drives both. (Star-Citizen near-volumetric/far-flat split.)
  - LANDED (Q2 — coverage match by CONSTRUCTION): the shell's coverage now comes
    from `columnMacroCoverage` — the SHARED macro-density model (coverage^γ →
    cloudType/topAlt → dilated+billow-carve → `saturate(dimProfile−(1−carved)·K)`,
    max over 3 slab altitudes), the SAME constants (`BASE_EROSION_K`,
    `COVERAGE_GAMMA`, `CARVE_SCALE`, `BILLOW_CARVE`, `BASE/COLUMN_SCALE`) and
    `cloudHeightProfile`/`baseDilate` the marcher uses. Replaces the hand-tuned
    `coverageToOpacity(rawTexture)` — no more manual sync ("time bomb"). Reference:
    this is Blackrack/KSP's principle (shared coverage source → outlines match);
    NMS's separate low-res 2D far layer is the anti-pattern. Opacity firmed via
    `SHELL_OPACITY_LO/HI` (footprint from the model; opacity knob independent).
    Marcher UNTOUCHED except `BASE_SCALE`/`COLUMN_SCALE` extraction.
    - shell coverage-texture sample switched to AUTO-MIP (2026-07-05,
      `makeEquirectTextureField`) — was forced mip 0 (a marcher anti-banding
      hack the shell doesn't need); fixes far aliasing / over-sharpness.
    - ⚠️ Q2 is NOT fully working → see "RESUME HERE" at the top: low-coverage
      (stratus) clouds are absent from the shell and it flickers. The Q2
      "fatten the volumetric" follow-up was TRIED (`BASE_EROSION_K` → 0.1) and
      FALSIFIED — it doesn't fix the low-coverage absence. Real cause is likely
      the shell's altitude sampling missing the low profile band + noise
      aliasing. DEBUG per the RESUME HERE section before more changes.
    - DEFERRED (Q2b, cleanliness): unify the marcher's inline dense-branch macro
      to CALL `macroDilatedShapeAt`/`applyBillowCarve` (currently mirrors them),
      removing the last structural duplication. Left out to keep the working
      marcher untouched this pass; verify the marcher is visually unchanged first.
- **ISSUE 1 — froxel AP flicker FIXED.** Root cause (revised after measurement,
  see the issue section): the AP was sampled at the marcher's per-frame,
  never-temporally-filtered cloud-front depth, whose jitter grows with distance →
  far/edge clouds flickered dark. `FROXEL_MARCH_STEPS` 24→48 did nothing (null
  result → not a bake problem); `constSlice` removed it (→ depth-path problem).
  Fix: apply the froxel AP INSIDE the sparse marcher (pre-reconstruction) so the
  temporal EMA averages the depth-jitter-driven colour variance out —
  `applyCloudAerialPerspectiveDirect` + `CLOUD_AP_IN_MARCHER` (atmospherePass),
  called from `createColorPass` (cloudFullscreenPass), composite fog gated off
  in production (SpaceRenderer). Also a small perf win (¼-res tap replaces a
  full-res 9-tap gather). User confirmed clean; then raised `FROXEL_MAX_DEPTH_KM`
  600→1800 for a smoother far transition (safe now the jitter is EMA'd — only
  watch faint near-field slice stepping, since 1800 km tripled near-slice
  spacing; an altitude-adaptive far plane would restore near precision if needed).
- **ISSUE 2 Phase 1 — shared far-cloud lighting + coverage→opacity.** New
  `cloudCommon.ts` (planet-agnostic): `farCloudLit` (physical far-cloud lighting
  matching the marcher's magnitudes) + `coverageToOpacity` (lifted-coverage curve
  matching the marcher's apparent footprint) + shared `CLOUD_SUN_SCALE`/
  `CLOUD_SKY_SCALE` (moved out of earthClouds). Wired into the Earth overlay
  (`USE_SHARED_CLOUD_FARFIELD`, earth.ts). Closes the brightness/colour half of
  the seam; `COVERAGE_OPACITY_LO/HI` is the area-match knob (defaults gentle to
  preserve the orbit look). **Decisions:** phased approach; Phase 2 = a
  DEDICATED CLOUD SHELL (sphere at cloud-top radius) for the far field, planet-
  agnostic, reusing these functions. Reference-look assumption (unconfirmed):
  pull the volumetric TOWARD the overlay (bright/full), not vice-versa.
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

## ISSUE 2 Phase 2 — dedicated cloud shell (PLAN, designed 2026-07-04)

Phase 1 (shared lighting + coverage) landed and closed the brightness/colour
seam (MS_GAIN=5 on the volumetric brought it up to the NASA overlay). Phase 2
replaces the surface-shader flat overlay with a **dedicated cloud shell** so the
far field (a) fixes the limb parallax, (b) decouples from the Earth surface
shader, (c) scales to procedural planets / gas giants. Designed via a 4-map +
synthesis workflow; verified against the code.

**Architecture:** a `THREE.SphereGeometry` at cloud-top radius (`outerRadiusScaled`
= `PLANET_RADIUS_KM + CLOUD_OUTER_ALTITUDE_KM`), returned as a **second
ExtraMeshDef** from `buildEarthClouds` (alongside the existing marcher anchor).
It renders on **layer 0** (NOT CLOUD_LAYER — the anchor's layer never renders) so
Pass 1 (scaled scene) draws it into `rt`; the atmosphere Pass 1.5 then fogs it
for free, exactly as the surface-shader overlay is fogged today (parity — see
correction 2). Its fragment samples the shared coverage source + lights it with
`farCloudLit` + `coverageToOpacity` (the Phase-1 cloudCommon functions). The
volumetric composite (Pass 3, premul-alpha) paints the marcher OVER the shell
where α>0 and lets the shell show through where α=0 → near/far hand off by
construction, no blend uniform needed.

**Provider seam (minimal, planet-agnostic):** in cloudCommon.ts add
`equirectDirToUv(dirLocal, uvOffset)` (the ONE shared equirect projection —
replaces 4 inline copies in earthClouds), `type CloudFieldProvider = { coverageAt(dirLocal): Node }`,
and `makeEquirectTextureField(weatherMap, uCloudUvOffset)` (Earth backing).
Do NOT add `cloudField` to CelestialBodyConfig yet (Earth is the only cloudy
body; the config seam waits for a 2nd planet). Marcher is NOT refactored to
consume the provider now (risk) — only its projection is switched to the shared
`equirectDirToUv` so shell + marcher are provably pixel-aligned.

**Crossfade / fades:** `uVolumetricBlend` UNCHANGED (still gates the marcher
pipeline on/off in SpaceRenderer). A new `uShellOpacity` fades the shell OUT as
the camera drops through the deck (~20→8 km) — replacing `uFlatCloudOpacity`'s
old job (it existed to kill the ground-painted ghost; the shell has no ground
ghost, but must still vanish before the camera crosses the inner radius or you'd
see the shell's far inner wall). Ground cloud-SHADOWS stay in the surface shader
(2-tap `texClouds` darkening terrain) — untouched.

**Steps (each independently verifiable in-app):**
1. Extract `equirectDirToUv` into cloudCommon; replace the 4 inline copies in
   earthClouds. Pure refactor — clouds must look identical. (low)
2. Add `CloudFieldProvider` + `makeEquirectTextureField` (dead code until 3). (low)
3. Build the shell mesh + material, mount it, **debug magenta fill** keyed to
   coverage. Verify placement + coverage alignment vs the overlay at the limb. (med)
4. Light it with `farCloudLit` (LUT `sunT` at cloud alt, `cloudHemi` daylight,
   `1−0.5·coverage` self-shadow proxy). Verify brightness/terminator parity. (med)
5. Drive `uShellOpacity` from altitude (fade out below the deck). Verify the
   descent: volumetric overpaints shell in the band, shell gone under the deck. (med)
6. Remove the surface-shader overlay (block + thinKeep gate + `uFlatCloudOpacity`
   + FLAT_OVERLAY_*/CLOUD_TOP constants). KEEP ground shadows. (med)

**CORRECTIONS to the raw plan (found in review):**
1. **Shell must render in near AND mid tiers.** `buildEarthClouds` early-returns
   `if (ctx.tier !== "near") return []` (earthClouds.ts:776), and the surface
   overlay renders in BOTH near (<35,000 km) and mid (35,000–1.5M km) tiers. If
   the shell is near-only, clouds VANISH at orbit (mid tier) once the overlay is
   removed. Return the shell for near+mid; the marcher anchor stays near-only.
2. **Atmosphere fogging is parity, not a risk.** The shell is scene geometry in
   `rt` fogged by Pass 1.5 — the SAME path the current overlay takes. So fogging
   doesn't regress; the only change is the shell sits 14 km higher (the parallax
   fix). Do NOT also sample the froxel AP in the shell (that would double-fog —
   the froxel AP is only for the volumetric, which is NOT in the scaled scene).

**Resolved defaults** (were open decisions): `uShellOpacity` on earth.ts
createUniforms (symmetry with uVolumetricBlend, one altitude calc); premul-alpha
blend to match the pipeline; 96 segments (near-tier parity); marcher left inline
(projection shared only).

**Risks to watch:** (a) shell `positionLocal` frame must equal the marcher's
earth-space (no local mesh rotation — parented to the rotation group; caught by
step 3's magenta alignment); (b) self-shadow proxy is flatter than the overlay's
2-tap — port the 2-tap in if it reads flat; (c) shell must fade to 0 before the
camera crosses the inner radius (far inner wall); (d) coverage-area continuity
still has the marcher-erosion tension (COVERAGE_OPACITY_* knob), same as today.

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
