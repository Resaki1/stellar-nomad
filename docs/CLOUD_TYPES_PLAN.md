# Cloud Types & Weather-Map System — Design Plan

**Status: RESEARCH COMPLETE + DESIGN AMENDED (2026-07-06).** All research
gaps closed; design red-teamed and amended. Not yet reviewed by Christian;
implementation not started. This is the detailed design for
CLOUD_REVIEW_2026-07.md → ISSUE 3 ("binary puffs-vs-fields") plus the
forward-looking pieces: realistic cloud *types*, smooth type *transitions*,
Earth driven by *real data maps*, and a path to *procedurally generated
planets* and *gas giants* (fly into Saturn/Jupiter).

**Full research reports** (primary-source extractions, keep!): see
`docs/CloudTypesResearch/` —
- `code_marcher.md` — exhaustive marcher deep-dive (formulas + line anchors;
  anchors are pre-shell-diff, re-grep symbols)
- `code_farfield+config.md` — texture loading, the STAGED shell work + its two
  open bugs, other planets, renderer pass structure (anchors current)
- `docs_references.md` — ~20 hard constraints mined from the project's own
  debugging history, mapped to the migration phases below
- `cloud_shape_anatomy.md` — **how each type is built today + the Monte-Carlo
  porridge diagnosis (§3.6)**; falsification sequence + plan amendments
  (applied). Companion scripts `cloudstats.mjs`/`worked.mjs` alongside.
- `web_nubis-decima.md` — all 4 Nubis decks, exact channel/profile/anvil formulas
- `web_meteorology-datasets.md` — WMO genera ground truth + ERA5/ISCCP/MODIS bake recipe
- `web_engines-gasgiants.md` — UE5/MSFS/Frostbite/RDR2 + Jupiter/Saturn structure
- `web_star-citizen-genesis.md` — verified CIG picture (corrects §3.3's first draft)

---

## 1. Problem statement (agreed with Christian, 2026-07-04)

Current state (verified in code at commit `7db0ce4` + uncommitted changes):

- ONE weather texture channel (R = coverage) drives EVERYTHING:
  - `cloudType = smoothstep(0.3, 0.6, coverage)` — earthClouds.ts ~L1848
  - `covSpan = smoothstep(0.35, 0.7, coverage)` gates `topAlt` — ~L1912
  - `cloudHeightProfile(alt01, topAlt, cloudType)` mixes exactly 3 analytic
    vertical curves: stratus → stratocumulus → cumulus — ~L749
- Consequences:
  1. Exactly TWO looks planet-wide (small broken puffs vs dense tall fields).
  2. The thin/thick decision is a hard function of coverage → the border
     between the two reads as binary, no gradient/mixing.
  3. No real cloud-type variety (no cirrus, no anvils, no towering Cb, …).
  4. Nothing generalizes: type/height can never vary independently of
     coverage, on Earth or any future procedural planet.

In-progress context (do not confuse with stale code): Christian is replacing
the hand-authored 2D cloud overlay texture with one BAKED FROM the volumetric
system so far-field and near-field agree (ISSUE 2 Phase 2 "cloud shell" work).
The weather map this plan designs is the INPUT to both.

## 2. Requirements

- **R1 — Realistic cloud types.** Distinct, recognizable genera (at minimum:
  stratus, stratocumulus, cumulus humilis→congestus, cumulonimbus w/ anvil,
  altocumulus/altostratus, cirrus/cirrostratus). True-to-life shapes.
- **R2 — Smooth type transitions.** No binary borders; neighbouring types
  blend/coexist (e.g. scattered cumulus under a cirrus veil).
- **R3 — Earth = real data.** Source maps from real datasets (identify WHICH
  and how to bake them into engine-ready textures).
- **R4 — Procedural-planet ready.** Same consumption path accepts procedurally
  generated maps (climate-plausible), Star-Citizen-Genesis-style.
- **R5 — Gas giants.** The abstraction must extend to Jupiter/Saturn (banded
  flow, no surface, ~10× thicker slab, fly-in).
- **R6 — Performance.** 60 fps minimum on MacBook M2 Pro; marcher
  fetches-per-voxel is the currency (project_cloud_perf_costmodel).
- **R7 — Incremental & falsifiable.** Small steps behind build consts, each
  verifiable in-app (DEBUG_VIZ), measure-first.
- **R8 — LOD coherence.** The far-field (baked overlay / cloud shell) and the
  volumetric near-field read the SAME maps.

---

## 3. Research findings

### 3.0 First-hand code anchors (verified in main session, 2026-07-04)

- **Weather map today** = `public/textures/earth_clouds_8k.ktx2` (near tier) /
  `_2k` (mid tier), loaded in earth.ts:427/438. Only `.r` is consumed. It is
  the 2002 NASA Blue Marble cloud composite (see §3.4 — 2 days of MODIS data,
  uncalibrated brightness, cloned patches; demote to reference/detail source).
- **The marcher samples the weather map PER STEP** (earthClouds.ts:1817-1818,
  `equirectDirToUv` → one 2D tap per iteration). Reading `.g/.b/.a` at the
  same tap is FREE — the cost of a multi-channel map is authoring, not fetches.
- **Exact formulas being replaced:**
  - `coverage = coverageRaw.pow(0.6)` (earthClouds.ts:1832)
  - `cloudType = smoothstep(0.3, 0.6, coverage)` (:1848)
  - `covSpan = smoothstep(0.35, 0.7, coverage)`;
    `topAlt = 0.45 + smoothstep(0.3,0.7,colSample)·0.5·covSpan` (:1912-1915),
    colSample = low-freq Perlin column tap (texture3D baseVolume.r @ uColumnScale)
  - `cloudHeightProfile(alt01, topAlt, cloudType)` (:749-786): 3 analytic
    curves (stratus 0-0.10/0.15-0.25; strato-cu 0-0.25/0.45-0.65; cumulus
    base smoothstep(0.04,0.16) + PARABOLIC top fade from `topAlt-0.35`), mixed
    by two smoothsteps over cloudType. The sharp cumulus base (flat bottoms)
    and parabolic top (rounded domes, not iso-altitude slices) are load-bearing
    anatomy fixes — MUST survive into any new profile representation.
- **Lockstep duplication (MUST co-change):** the whole coverage→type→topAlt→
  profile chain is hand-copied in src/components/space/cloudLightVolume.ts
  (`densityAt` L291-352 + `cloudHeightProfileInline` L666-694). Plus: noise
  bake duplicated noiseVolumes.ts (CPU) ↔ cloudVolumeCompute.ts (GPU); FBM
  weights 0.625/0.25/0.125 inlined at ≥7 sites; fine-detail composition
  duplicated between primary march (L2032-2094) and near self-shadow probe
  (L2508-2558); macro-carve composition at 4 sites. Full list:
  CloudTypesResearch/code_marcher.md "Lockstep-duplication hazards".
- **In-progress (uncommitted):** ISSUE 2 Phase 2 far-field cloud shell
  (earthClouds.ts ~L797+): sphere at cloud-top radius sampling the SAME
  coverage field via cloudCommon `CloudFieldProvider` — the natural far-field
  consumer of the new map (R8). cloudCommon.ts already has the planet-agnostic
  seam: `equirectDirToUv`, `CloudFieldProvider { coverageAt }`,
  `makeEquirectTextureField`, `farCloudLit`, `coverageToOpacity`.

### 3.1 Code architecture — what the redesign actually touches

(Condensed from CloudTypesResearch/code_marcher.md — read it before coding.)

- Full density chain per march step: weather tap → coverage lift → type/topAlt
  → `profile = coverage·heightProfile` → gate `If(profile>0.01)` (all 3D taps
  skipped when empty — this is why extra EMPTY altitude bands are cheap) →
  baseDilate(Perlin-Worley) → macro carve (Schneider value erosion) →
  FINE_CARVE (freq-graded by profile, Nubis p.109) + WISP blend (detail A
  channel = curl-Alligator) + HHF (twice-folded, near camera) → dense gate →
  `density = pow(shape, 0.8)·uDensityMul`.
- **Profile feeds LIGHTING too**: `ms = profile·Tsun·MS_GAIN(5)` fills cores,
  `ambient = (1−profile)^0.5·skylight` brightens edges (L2838-2860). Thin
  types (cirrus) will automatically read translucent/ambient-dominated, but
  MS_GAIN tuned for thick decks may need a per-type scale.
- Weather-map sample sites (a multi-channel map touches all): marcher per-step
  tap; hoisted covNear/Mid/Far (load-bearing TSL `If` — do not remove); far
  shell provider; light-volume `densityAt` (7 sun taps/baked voxel); earth.ts
  ground shadow (2 taps — can stay coverage-only).
- Noise stack: base 128³ RGBA (R=Perlin-Worley Alligator hybrid, G/B/A=Worley
  FBM bands), detail 64³ RGBA (R/G/B=Alligator octaves, A=curl-wisp), detail
  mip1 32³ for near probe. Type-differentiation WITHOUT new fetches: blend
  weights of already-fetched channels + WISP_AMOUNT / FINE_CARVE_* /
  BILLOW_CARVE / DENSITY_GAMMA as functions of type. New baked channels (e.g.
  anisotropic sheared cirrus streaks) = dual-file lockstep bake change +
  DETAIL_MIP1_RENORM re-measure — defer.
- Slab: 1–14 km (`CLOUD_INNER/OUTER_ALTITUDE_KM`, lockstep with earth.ts
  `CLOUD_TOP_ALTITUDE_KM`). Raising to 16 km (Cb tops): 2 constants, ~+15%
  in-band march cost, light volume + shell derive automatically. **Profiles
  are in alt01 FRACTIONS today — raising the slab silently moves stratus
  anatomy up.** The new profile representation must be km-anchored.
- Per-step column texture3D tap exists ONLY to feed topAlt (warp vector from
  its gba is dead, WARP_AMPLITUDE=0) → **an explicit height channel makes it
  removable: net −1 texture3D per in-band step, a real perf WIN.**
- Perf budget context: ~8-9 texture3D + 1 texture2D per dense voxel today.

**Update 2026-07-06 — staged (uncommitted) shell work changes the ground truth**
(full detail: code_farfield+config.md):
- The flat 2D surface overlay is REMOVED from earth.ts; the far field is now
  the cloud shell (near+mid tiers), computing coverage at runtime from a
  shared macro-density model (`columnMacroCoverage`) — the "bake from
  volumetric" intent became runtime shared-shader evaluation, no bake script.
- The shell work added a THIRD copy of the coverage→type→topAlt chain
  (`deriveCloudType` :848, `deriveTopAlt` :855, `columnMacroCoverage` :888 in
  earthClouds.ts) — Phase 0 has MORE sites to consolidate than first planned;
  these helpers are the natural seed of the shared module.
- **`BASE_EROSION_K` changed 1.2 → 0.6 in the staged diff, undocumented** —
  this is porridge cause #1, see §3.6.
- Two OPEN shell bugs (CLOUD_REVIEW "RESUME HERE"): Bug A — stratus absent
  from the shell (fixed alt01 taps {0.3,0.55,0.8} miss the stratus band);
  Bug B — shell flickers (unmipped .level(0) 3D-noise taps alias from orbit).
  Both interact with Phases 2/5 (see §5).
- Marcher line anchors moved: coverage lift :2022, cloudType :2038,
  covSpan/topAlt :2102-2104, cloudHeightProfile :783, per-step tap :2007.
- KTX2 loading: useDeferredKTX2 singleton, whole tier record gated by
  Promise.all (adding a texture delays the tier); convert script's linear
  auto-detect will NOT catch "weather" filenames — pass `--linear` explicitly;
  mid-tier clouds texture is missing wrapS=RepeatWrapping (seam risk);
  profile LUT should be a process-lifetime DataTexture singleton
  (getAtmosphereLUTs pattern), never reassigned on live materials (WebGPU
  bind-group hazard).
- Atmosphere Pass 1.5 fogs scene geometry ANALYTICALLY (no depth buffer) —
  shells are fogged ~correctly except a few-pixel limb ring; volumetric
  composite (Pass 3) paints over ALL scene geometry (depthTest off) —
  confirms §4.5's cirrus occlusion caveat.

### 3.2 Nubis / Decima lineage (primary decks fetched; exact formulas)

(Condensed from CloudTypesResearch/web_nubis-decima.md.)

- **2015 (HZD)**: weather map R=coverage, G=precipitation, B=type (0=St,
  0.5=Sc, 1=Cu) — **type was an independent channel from day one**; our
  coverage-derived type is a shortcut nobody shipped. 3 analytic height
  presets blended by type. Precipitation forces Cb at 70% coverage.
  Alto/cirro = cheap scrolling 2D textures above the volumetric band.
- **2017 (shipped Nubis)**: map = R=Perlin coverage (connected formations),
  G=Perlin-Worley coverage (isolated islands), B=type. Per-sky-state scalars
  (skew, anvil_bias, movement, density) live in a "weather state" object, not
  the map. **THE smooth-transition mechanism: type does not crossfade finished
  profiles — it slides the remap in/out points of the height gradient
  continuously through St→Sc→Cu, so every intermediate type is itself a
  plausible profile.** Anvil = modifier, not a type:
  `coverage = pow(coverage, remap(height, 0.7, 0.8, 1.0, lerp(1.0, 0.5, anvil_bias)))`.
  Wind shear: `p += height_fraction · wind_direction · 500m`. Coverage field
  is STATIC; only noise scrolls ("evolution of details, not formations").
- **2022 (Nubis Evolved / HFW)**: five 16 km 2D "NDFs": Min Height, Max
  Height, Coverage, Bottom Type, Top Type. Type channels index **vertical-
  profile LOOKUP TEXTURES** (analytic presets became LUT rows — new genera =
  painted rows): `vertical_profile = topTypeLUT · bottomTypeLUT`,
  `dimensional_profile = vertical_profile · coverage`,
  `density = saturate(noise_composite − (1 − dimensional_profile))`.
  Cirrus = separate **2.5D layer** (coverage+type; type blends 3 baked texture
  channels streaky→wispy→round, sharpened by coverage). Envelope model for
  fly-through: type = the altitude where detail flips wispy→billowy.
  Superstorms (Cb supercells) = influence-NDF OVERRIDES stamped over the
  procedural fields + concentric rotation rings for the mesocyclone.
  Multi-scatter: `ms = Remap(dimProfile·step, 0.1, 1, 0, 1) · pow(coverage·type, 0.25)`;
  ambient `= pow(1 − dimProfile, 0.5)`.
- **2023 (Nubis3 / Burning Shores)**: flyable clouds abandon the 2D map —
  artist-built Houdini voxel cloudscapes (NVDFs: dimensional profile from an
  SDF + detail type + density scale, 512×512×64 over 4×4×0.5 km + BC1 SDF for
  sphere-traced stepping). Detail noise: Alligator (billow) + Curly-Alligator
  (wisp) lo/hi pairs, `wispy = lerp(r, g, dimProfile)`,
  `billowy = lerp(b·0.3, a·0.3, pow(dimProfile, 0.25))`,
  `composite = lerp(wispy, billowy, Type)`; twice-folded HHF within 150 m.
  Decoupled light grid (256×256×32 summed density toward sun, amortized 8
  frames) = −40% cost. NOT the direction for planet-scale weather (bespoke
  4 km dioramas), but the fly-through/perf lessons apply.
- **Relevance ranking for us**: 2017's type→profile-parameter interpolation +
  2022's LUT form + 2022's 2.5D cirrus + superstorm-as-override are the
  blueprint. We already implement most of Nubis3's detail philosophy
  (Alligator/curl-wisp/HHF — see project_cloud_detail_lighting_decouple).

### 3.3 Star Citizen Genesis (VERIFIED 2026-07-06 — full report: web_star-citizen-genesis.md)

Two distinct eras that the first draft of this section conflated:

- **Shipped (through Alpha 4.8, May 2026):** raymarched volumetrics unified
  with the atmosphere raymarcher (Frankfurt R&D 2020-21, debut = Crusader in
  3.14), but cloud placement is **static and artist-authored** — per-planet
  custom **3D volume textures** + tint + shaping params ("cloudscaping").
  **No 2D weather map, no cloud-type system** appears anywhere in CIG's
  engineering reports. Orbit→surface is ONE representation (no separate far
  field): low-res march + temporal reprojection + upsample, with shaping
  tuned so detail doesn't read tiled from orbit.
- **Announced Genesis / PT v5 (CitizenCon 2954, UNSHIPPED):** planet data
  sets = height, temperature, humidity, geology, soil type/depth/nutrients,
  offline-simulated erosion. **Wind and precipitation are NOT input maps** —
  they are fields/outputs of an announced runtime *weather simulation* in
  which clouds form/dissipate from oceans, prevailing winds, mountains,
  temperature ("stratus and cumulus" is the only type vocabulary used; no
  engineering detail published).

**Verdict on Christian's understanding:** right for Genesis biome generation
(temperature+humidity are the historic PT v4 maps, Genesis adds more); for
clouds it describes CIG's announced future, not any shipped system. Our §3.4
recipe (predictor fields → derived channels) is strictly more concrete than
anything CIG has published, and our baked-map design matches what actually
ships across the industry. Crusader validates the "same marcher, per-planet
content" seam (§4.9) and the fog-wall bottom (descent fades to haze), but is
a hand-authored Earth-SIZED aesthetic gas giant — the band-table generator
remains pioneering work. Two engineering nuggets worth stealing later:
narrow-band **SDF over coverage with signed mips** for empty-space skipping,
and **incremental/lazy cloud-shadow updates** (validates the light-volume
amortization; adds the lazy-when-static idea). No further CIG research needed
unless they ever give a GDC/SIGGRAPH talk.

### 3.4 Meteorology ground truth + real Earth datasets (R3/R4)

(Condensed from CloudTypesResearch/web_meteorology-datasets.md — the full
genus table, co-occurrence rules, and dataset gotchas live there.)

**THE design-critical insight: cloud genus is not a category — it is a derived
label from ~4 continuous physical axes.** ISCCP operationally classifies ALL
clouds from just cloud-top pressure × optical thickness (3×3 grid: Cu/Sc/St,
Ac/As/Ns, Ci/Cs/DeepConvection); adding one "convectivity" axis (cellular
hard-edged vs layered smooth) recovers every visual distinction. Therefore:
**store continuous fields, derive genus appearance in-shader.** Transitions
are then smooth by construction (R2), procedural planets generate the same
fields (R4), gas giants reinterpret them (R5).

- Approximate channel→genus decode (full version in the report):
  conv>0.7 & top>8 km ⇒ Cb+anvil · conv>0.5 & top 2-6 km ⇒ Cu congestus ·
  conv>0.4 & top<3 km & cov<0.5 ⇒ Cu humilis · conv 0.2-0.5 & top<2.5 km &
  cov>0.6 ⇒ Sc · conv<0.2 & top<1 km ⇒ St · conv<0.3 & top 3-6 km ⇒ As ·
  tau>25 & top 4-8 km & cov~1 ⇒ Ns · top>7 km & tau<3 ⇒ Ci/Cs.
- Realism cues per genus worth engineering: locally UNIFORM cumulus base
  plane; Sc mesoscale cells (10-40 km, closed near coasts / open offshore) —
  Sc decks off Peru/Namibia/California are THE signature of Earth from orbit;
  Cb = hard cauliflower flanks + glaciated fibrous top + anvil spreading
  50-300 km downwind + dark precip shafts; Ns diffuse rain-blurred base; Ci
  fall-streak hooks, no flat base, tau<2.
- Co-occurrence rules (encode in the BAKER, not the shader): vertical stacking
  is the norm (Cu under Ci = default fair-weather sky); within-level exclusion
  (St xor Cu); warm-front 1D ramp Ci→Cs→As→Ns over ~1000 km; cold-front Cb
  line then clearing; Cb ⇒ downwind cirrus plume; trade transect
  St/Sc→open-cells→Cu→congestus→ITCZ-Cb = a smooth gradient in
  (topHeight, convectivity) — free with continuous channels.
- **Predictor recipe for procedural planets (R4)**: SST/elevation → circulation
  template (ITCZ ascent band; ±20-35° subsidence ⇒ deserts + Sc decks; 40-60°
  storm tracks ⇒ comma-cloud fronts; polar subsidence) → derived fields
  (RH by level, EIS inversion strength, CAPE + diurnal phase, large-scale
  vertical velocity ω, wind) → channels: coverage ~ f(column RH, ω);
  topHeight ~ max(CAPE-top, frontal ascent depth); convectivity ~
  CAPE-vs-stratiform ratio. The two fields most systems forget and that matter
  most: **EIS** (explains Sc decks) and **ω** (explains deserts AND ITCZ).

**Datasets (all verified July 2026; access details + gotchas in the report):**

| Dataset | What it gives us | Access |
|---|---|---|
| **ERA5** (PRIMARY) | lcc/mcc/hcc/tcc coverage, cloud base height, CAPE, **3D cloud fraction** + RH + T + ω on 37 pressure levels, hourly 0.25° | CDS API, free reg., attribution |
| **ISCCP-H HGM** | the ONLY gridded product with cloud amount split into the 9 τ/CTP types (1°, monthly climatology) — the TYPE PRIOR | NCEI HTTPS, no auth, public domain |
| MODIS MOD08_M3 | observed cloud-top pressure + optical thickness to calibrate channels | LAADS/Earthdata or Google Earth Engine |
| GPM IMERG V07 | precipitation (future rain channel) | GES DISC, Earthdata login |
| GMGSI / NASA GIBS | single dramatic "today" snapshot / date-picking reference | AWS open / WMS, no auth |
| CALIPSO-GOCCP, CloudSat 2B-CLDCLASS | offline curve-fitting of per-genus base/top/thickness (LUT rows) | free reg., one-time use |

- **Bake plan**: pick ONE photogenic ERA5 instant (browse NASA Worldview for a
  good N-Atlantic comma cloud + active ITCZ + visible Sc decks; monthly means
  look like fog), derive channels on the 1440×721 grid, blend ISCCP Sc-deck
  prior where ERA5 under-does marine stratocumulus, upsample to texture res
  **injecting sub-grid detail noise at bake time** (data is ~28 km/px; the
  runtime keeps only its existing 3D noise), flip/rotate grid conventions,
  landmark-check (Peru deck west of South America), output equirect RGBA →
  existing `scripts/convert-to-ktx2.sh --linear`.
- Current texture verdict: Blue Marble clouds = 2-day 2001 MODIS visible
  composite, brightness ≈ uncalibrated coverage×τ mix, cloned patches —
  demote to art reference / optional high-freq detail modulator.

### 3.5 Other engines + gas giants (R5)

(Condensed from CloudTypesResearch/web_engines-gasgiants.md.)

- **UE5** official content: RGBA weather map = four COEXISTING genus coverages
  (R=stratocumulus, G=altostratus, B=cirrostratus, A=nimbostratus), each with
  its own height-profile texture channel; summed independent fields ⇒ smooth
  coexistence, one RGBA fetch.
- **MSFS 2020/24**: NO type channel — meteoblue streams a 3D gridded
  atmosphere (60 vertical levels: cloud fraction, liquid/ice water, wind, T,
  RH); genera EMERGE from where the cloud water sits. Authoring abstraction =
  up to 3 layers × (base, top, density, scattering). MSFS 2024 added cirrus
  as a distinct high layer. ⇒ "layered scalar fields, genus is presentation"
  is how the most weather-serious sim represents truth.
- **Frostbite** (Hillaire 2016): Schneider-style volumetric slab + a SEPARATE
  cheap panning 2D high-cloud (cirrus) layer, both lit by the same atmosphere
  LUTs. **RDR2** (SIGGRAPH 2019): realtime global cloud map = TWO channels =
  density of two layers + a table of height gradients. ⇒ Industry consensus:
  **nobody raymarches cirrus in the cumulus slab; high clouds are a separate
  thin layer.** Cb/superstorms are placed/injected anomalies (Guerrilla GDC
  2022), not an emergent corner of the type axis.
- **Gas giants — no shipped fly-through volumetrics are published** (Space
  Engine = ~7 differentially-rotating textured shells; Elite = opaque spheres;
  NMS Worlds II shipped descend-able gas giants Jan 2025 but zero rendering
  internals). We design from planetary science instead:
  - **Jupiter vertical**: 3 chemically-fixed thin decks — NH₃ ice (~0.7 bar,
    tops +9..+40 km rel. 1-bar), NH₄SH (~2-2.5 bar, −18..−25 km), H₂O
    (~5-7.5 bar, −40..−50 km); each deck only ~7-10 km thick (like Earth
    stratiform sheets!); whole weather layer **~100-150 km ≈ 10× Earth's slab,
    NOT thousands of km**. Below the H₂O deck: clear hot haze thickening
    forever ⇒ natural fog-wall bottom, no surface needed. Saturn: same
    sequence, 2-3× deeper, under thick haze (blander).
  - **Jupiter horizontal**: quasi-static 1D latitude skeleton — ~30 alternating
    zonal jets (to ~150 m/s; Saturn ~400), zones = bright upwelling high NH₃
    tops, belts = dark downwelling cleared decks; sparse long-lived vortices
    (GRS ~15,000 km, tops ~8 km above surroundings) + shear turbulence at jet
    boundaries; time evolution ≈ pure differential zonal advection
    (`lon += u(lat)·t/(R·cos lat)`).
  - **Parameterization**: per-latitude band table (jet velocity, per-deck
    clearing, deck-top offset, tint, turbulence amplitude) → bake to the SAME
    equirect channel stack (coverage→deck clearing, topHeight→deck top,
    convectivity→storm/plume mask) + latitude-squashed domain-warped fBm +
    stamped vortex list. Same marcher, per-planet slab config.

### 3.6 How types are built today + why thick clouds read as "porridge" (2026-07-06)

Full analysis with Monte-Carlo statistics over the exact noise chain:
**`docs/CloudTypesResearch/cloud_shape_anatomy.md`** (Part A = per-type
anatomy walkthrough with worked numeric examples; Part B = ranked root
causes; scripts preserved alongside). The three dominant causes:

1. **Erosion saturation (H1/H2, PRIMARY).** `shape = saturate(profile −
   (1−carved)·K)` can only produce a hole where `profile ≤ K`. At the staged
   K=0.6, every raw map value > 0.427 (⅔ of the map's range, ALL thick
   regions) is **mathematically hole-free** with a positive density floor
   `profile − 0.6`; opacity saturates in ~1 km, so the camera sees only the
   smooth profile envelope ±0.2 noise — literally the quilted duvet. The
   staged 1.2→0.6 change (undocumented, likely far/near brightness matching)
   made this strictly worse (holes at profile 0.9: 22% → 0%). Nubis's form
   (K=1: `saturate(noise − (1−profile))`) keeps noise authority at ALL
   coverages (7% holes even at profile 1.0). *Also:* the coverage `pow(0.6)`
   lift exists only to survive the old K's threshold — it compresses 57% of
   the map's range into the hole-free regime.
2. **One slab at one ceiling (H4).** All dense regions get cloudType=1 AND
   topAlt piled at the 0.95 cap: `smoothstep(0.3,0.7,colSample)` was written
   for pure Perlin (mean 0.5) but colSample has been the Perlin-Worley
   HYBRID (mean ≈0.7) since the R-channel rework → the smoothstep saturates
   for most columns (69% of dense columns > 0.90, median exactly 0.95). No
   tower skyline exists for erosion to reveal.
3. **Missing mesoscale octave (H3).** No spatial content exists between the
   8.3 km column cells and the weather map's smooth blobs — real skies
   organize at 10-40 km (Sc cells, streets, cumulus clusters with clear-sky
   gaps). The isotropic Alligator base field is "mostly full" (15.7% clamped
   at 1.0; holes are creases, not sky), so at range exactly one feature scale
   survives: 5 km caps on a 20 km tile = "uniform rounded lumps at one scale".

Secondary: DETAIL_FADE zeroes all fine octaves by 100 km (mid-range mush,
the deliberate case-#22 tradeoff); DENSITY_GAMMA/ALPHA_SHARP/profile-driven
lighting each compress contrast further; the far shell binarizes an already
hole-free field via its smoothstep firm-up (same porridge by another route).

**Falsification sequence** (run BEFORE implementing, ~1 line each — full
expected outcomes in the anatomy doc): (1) ~~`DEBUG_VIZ='eroded'` over a
thick deck~~ **DONE — run by Christian 2026-07-06 (screenshot).** Result as
predicted: mostly light gray over the dense deck, NO true black — the
`profile − K` density floor made visible; real dark/black erosion only in
the lower-coverage distance where `profile ≤ K` still permits holes.
CONFIRMS H1's floor; (2) ~~`BASE_EROSION_K` 0.6→1.2 A/B~~
**DONE — run by Christian 2026-07-06 with screenshots (from ~16-20 km above
a dense deck).** Result exactly as predicted: K=1.2 → patchy, see-through
holes to terrain even in the highest-coverage areas, "less satisfying";
K=0.6 → closed and fuller but the uniform-lump porridge. CONFIRMS K is the
patchy↔full lever AND that no K value alone can produce a real deck — the
holes at K=1.2 punch through-to-ground (holes-in-a-slab) instead of forming
crevices-between-towers, because the vertical structure (H4) and mesoscale
organization (H3) are missing regardless of K. Both screenshots also show
the same single lump scale (H3 is K-independent, as predicted);
(3) ~~Nubis-form one-liner~~ **DONE 2026-07-06 (`EROSION_NUBIS_FORM=true`,
screenshots): CONFIRMED + user verdict "more realistic already".** Thick
deck keeps reading ~closed but gains distinct masses, deep dark crevices,
some true holes; `eroded` viz now shows TRUE BLACK inside the dense deck
(floor gone, full value range). H1 fix validated → **Nubis-form K=1 adopted
as the design baseline (§4.2)**;
(4) ~~topAlt linear remap~~ **DONE: CONFIRMED.** Viz went near-uniform-white
(the predicted ceiling pile) → varied gray with `TOPALT_LINEAR=true`; render
gains real height variation (user: "looks better than before"). Expected
side effect observed: mean tower height + mid-coverage cloud amount drop —
placeholder constants; the B channel + baker histogram own these
distributions from Phase 1;
(5) ~~mesoscale cellular mask~~ **DONE: CONFIRMED** — with 3+4+5 on: "better
height variation in thick cloud fields with true 0 holes in between them"
= the falsifiable not-porridge definition MET. H3 validated; the bake's
mesoscale octave is load-bearing as specced (§4.7 step 6);
(6) ~~`DETAIL_FADE_FAR` A/B~~ **DONE: NULL RESULT (informative).** No static
visual difference at 0.1 / 0.25 / even 0.9 — because fine-carve features
(≤0.7 km) are sub-pixel-footprint at 20-300 km view distances; NO amplitude
of sub-footprint detail can alter a still frame. The fade's role is
TEMPORAL (anti-flicker, case #22). **H5 demoted from the porridge causes;
DETAIL_FADE stays unchanged; the "fade to mid-frequency floor" idea is
deprioritized** — the mesoscale octave owns structure at range.

**PHASE F COMPLETE (2026-07-06).** All three dominant porridge causes
empirically confirmed in-app and their fixes validated BEFORE
implementation. §4.2 erosion parameters are now locked: Nubis-form K=1
baseline; per-type K (capped ~1.0 convective) remains a Phase-3 refinement.

**Interim toggle disposition (until Phase 1 lands):**
`EROSION_NUBIS_FORM` MAY be left ON for daily play — it is coherent across
marcher + skip-gate + far shell by construction; caveats: mid-coverage
regions read sparser (the pow(0.6) lift partially compensates until Phase 1
removes both together) and the 300-600 km near/far handoff + SHELL_OPACITY_*
were tuned against K=0.6 (re-check the seam at blend≈0.5 before committing
to it). `TOPALT_LINEAR` and `MESOSCALE_TEST` should stay OFF for daily play
(placeholder constants / marcher-only far-field seam) — Phase 1 delivers
both properly via the weather map.

**IMPLEMENTED 2026-07-06 (steps 3-5 as build-const toggles, all default
OFF; lint clean; no-op verified by HMR into the live session):**
- Step 3: `EROSION_NUBIS_FORM` (earthClouds.ts, next to `BASE_EROSION_K`).
  Uses the algebraic identity Nubis-form ≡ K=1 → one derived
  `BASE_EROSION_K_EFF` feeds the dense-branch erosion, the probeShape gate
  (case-#13 lockstep by construction), AND the far shell's
  columnMacroCoverage — coherent near/far A/B. Light volume needs no mirror
  (its bake density is multiplicative, no K).
- Step 4: `TOPALT_LINEAR` (earthClouds.ts) via a new shared
  `topAltSpread(colSample)` helper used by the marcher inline, the shell's
  `deriveTopAlt`, and the `topAlt` diagnostic; mirrored as
  `TOPALT_LINEAR_MIRROR` in cloudLightVolume.ts (lockstep comment, same
  pattern as WARP_AMPLITUDE_MIRROR) so shadows stay attached during the test.
  Linear remap `(colSample − 0.48)/0.42` per the measured hybrid range.
- Step 5: `MESOSCALE_TEST` (+ `MESO_SCALE=8`, `MESO_LANE_LO/HI=0.45/0.7`,
  earthClouds.ts): multiplies RAW coverage per step by
  `smoothstep(LO, HI, baseVolume.r @ 125 km tile)` → ~31 km cells with true
  zeros. Marcher-only preview (documented caveats: far shell beyond ~300 km
  and light-volume bake don't see the mask → visible handoff seam + slightly
  off tower-wall light near lanes during the test).
- Step 6: no code needed — flip existing `DETAIL_FADE_FAR` 0.1 → 0.25.

---

## 4. Design — the synthesized system

Synthesis rationale: three schemas were on the table — (A) UE5 per-genus
coverage channels, (B) Nubis-Evolved coverage+type+minmax, (C) MSFS per-layer
fields. We adopt **continuous physical axes (ISCCP-style) as the map payload**
— it is the only representation that simultaneously (i) bakes directly from
ERA5 (R3), (ii) is generated directly by a climate-plausible procedural stack
(R4), (iii) reinterprets cleanly for gas giants (R5), and (iv) makes
transitions continuous by construction (R2) — combined with **Nubis'
profile-parameter-interpolation via a LUT** for the vertical anatomy (R1) and
the **industry-consensus separate high/cirrus layer**.

### 4.1 Weather Map v2 — the "cloud control stack"

One equirect RGBA texture (per planet), all channels LOW-FREQUENCY control
fields (sub-grid detail stays procedural/runtime):

| Ch | Field | Semantics | Earth source |
|----|-------|-----------|--------------|
| R | `coverage` | low+mid cloud coverage 0-1, **consumed LINEAR by the shader** — the old `pow(0.6)` lift is deleted along with the K<1 erosion it existed to survive (§3.6 H2); the baker owns the histogram. Hard constraint: *every deck that should read broken needs `coverage·profile ≤ K` somewhere* (the carvability bound) | ERA5 tcc/lcc/mcc + ISCCP Sc prior + bake-time detail |
| G | `convectivity` | 0 = layered/stratiform … 1 = cellular/convective. THE type axis (replaces `cloudType`) | classifier over ERA5 CAPE, ω, EIS |
| B | `topHeight` | cloud-top altitude, normalized 0-1 over 0-18 km (~70 m steps in 8-bit — fine). Replaces `colSample`/`covSpan`→`topAlt` | highest ERA5 level with 3D cloud fraction > 0.1, calibrated vs MOD08 CTP |
| A | `cirrus` | HIGH-layer (Ci/Cs/Cc family) coverage 0-1, consumed by the separate high layer (§4.5) and the far field | ERA5 hcc |

Deliberately NOT in v1 of the map (add later as a second texture "weather map
B" when needed): optical depth/τ — **which means Ns honestly ALIASES TO As in
v1** (the §3.4 Ns decode requires τ>25, and "approximating τ from
coverage·thickness" is circular since thickness derives from the same
channels; the dark rain-bearing frontal look arrives with weather map B —
this strengthens τ over precipitation as the next channel, see §6 Q1);
precipitation (rain shafts/virga); wind vector (anvil/shear direction —
global per-planet uniform initially); per-column BASE height (derived from
convectivity+topHeight rules for now).

**Supersedes** the older channel specs in VOLUMETRIC_CLOUDS_SHAPE_PLAN.md §2
item 1 (R=coverage, G=type, B=density/wetness) and VOLUMETRIC_CLOUDS_PLAN.md
B2 Stage 2 (coverage/type/height-bias/wetness) — do not treat those as live.
Wetness/precip stays deferred (it never had a consumer; weather map B later).

Resolution/encoding: **4096×2048 RGBA8, LINEAR (not sRGB!), KTX2 UASTC** via
existing script (**pass `--linear` explicitly** — filename auto-detect won't
catch "weather"; needs a mip chain via the script for shell/far consumers
while marcher taps stay `.level(0)`). Source data is only ~1440 px at the equator; the extra
resolution carries bake-time-injected sub-grid structure (Sc cell hints,
coastline-locked detail). VALIDATE that UASTC block compression doesn't
crosstalk channels (each channel is semantic — a coverage wiggle from a
topHeight edge would be a real bug); fallback = two RG8 textures or
uncompressed. Mid tier keeps a 2k copy (same bake, downsampled).

Consumption seam (R4/R5/R8): extend cloudCommon's provider from
`coverageAt(dir) → Node` to
`weatherAt(dir) → { coverage, convectivity, topHeight, cirrus }`
(one struct, **one fetch — call `texture()` ONCE and return swizzles of the
same node / `.toVar()` the vec4; separate `texture()` calls per accessor are
distinct TSL nodes and can compile to 4 samples**). Consumers: marcher
per-step tap, light-volume bake, far shell, cirrus layer, (later)
procedural/gas-giant providers. Ground shadow in earth.ts stays coverage-only.

### 4.2 Genus decode: vertical profile LUT

Replace `cloudHeightProfile` (3 analytic curves + 2 smoothsteps) AND its
inline light-volume copy with **one shared 2D profile LUT**:

```
topKm    = weather.topHeight · 18                       // km-anchored!
altKm    = alt01 · (outerKm − innerKm) + innerKm
altNorm  = saturate((altKm − baseKm) / max(topKm − baseKm, ε))
profile  = coverage · LUT(altNorm, convectivity)        // texture2D, linear filter
```

- `baseKm` derived, not stored: convective columns sit on a shared LCL-like
  deck (`baseKm ≈ 0.7-1.5`, the flat-cumulus-base realism cue); stratiform
  columns hug their top (`baseKm ≈ topKm − thickness(convectivity, topKm)`).
  Encode this shape INSIDE the LUT rows instead where possible — the LUT is
  free-form; baseKm only exists to normalize tall columns sensibly.
- **LUT genus ANCHORS (v = convectivity)** — anatomy PARAMETERS fitted once
  offline against CALIPSO/CloudSat statistics:
  - v≈0.0: thin sheet with its peak near the column top but **strictly
    interior** (e.g. mass at altNorm 0.7-0.95) → topKm 1 km reads as St,
    2.5 km as flat Sc, 5 km as As. One family covers the ISCCP stratiform column.
  - v≈0.4: broken cellular slab (Sc/Ac): mass altNorm 0.5-0.95, softer top.
  - v≈0.7: cumulus mediocris/congestus: **port the existing anatomy — sharp
    low base (smoothstep 0.04-0.16 equivalent) + parabolic dome top** (the
    two documented fixes: flat bottoms, no sliced tops).
  - v≈1.0: full-depth tower (Cb body): hard base, near-full mid density,
    slight taper to the dome; anvil handled by the modifier below, not the row.
- **Generator invariants (red-team blockers — do not skip):**
  1. **Every row's first and last texel are EXACTLY 0**, peaks strictly
     interior, enforced by an automated check in the generator. altNorm
     saturates at the boundaries, so a row that is nonzero at u=1 extrudes
     every such column from its top to the slab ceiling (and u=0 to the floor).
  2. **The generator fills ALL 64 rows by interpolating the anatomy
     PARAMETERS (base-ramp position/width, plateau level, top-fade start,
     dome exponent) between the genus anchors** — the Nubis-2017
     endpoint-slide evaluated at 64 samples. NEVER author sparse anchor rows
     and let texture filtering blend them: blending two dissimilar finished
     curves gives two-bump half-amplitude profiles that the Remap erosion
     deletes → the binary-border symptom returns at row midpoints. Texture
     filtering may only bridge near-identical adjacent rows.
- LUT: 64×64 R8, generated in TS at startup into a **process-lifetime
  DataTexture singleton** (getAtmosphereLUTs pattern — NOT a PNG through the
  tier texture records: that delays tier readiness, duplicates per tier, and
  risks the WebGPU bind-group reassignment hazard). Regenerate contents
  in place for tuning, **forcing a light-volume re-bake (both ping-pong
  sides) on every regen**. Marcher LUT tap `.level(int(0))` (case #2); any
  shell/far consumer auto-mips. Offline fitting script remains the
  CALIPSO/CloudSat reference.
- **`thickness(convectivity, topKm)` is load-bearing — spec it concretely**
  (span-normalized rows cannot encode constant physical thickness; for
  St/As the ~0.5-3 km-regardless-of-top anatomy lives entirely in this
  function). Small shared cloudShared function fitted from the same
  CALIPSO/CloudSat pass; consumed lockstep by marcher, light volume, shell.
  Baker rules: `topKm ≥ baseKm + minThickness`, and **clamp topKm ≤
  outerKm − margin** (ERA5 ITCZ tops hit 16-18 km; an unclamped topKm
  truncates mid-dome at the slab ceiling = the documented sliced-tops
  regression, planet-wide along the ITCZ).
- **Perf**: +1 texture2D per dense step, MORE than paid for by deleting the
  per-step column texture3D tap (topAlt no longer needs colSample; its
  warp-vector side-use is dead, WARP_AMPLITUDE=0). Net: −1 tex3D +1 tex2D.
- **Both the marcher and cloudLightVolume sample the SAME LUT texture** —
  lockstep hazard #1 (shadows detaching) is eliminated structurally.
- Keep sub-grid tower-height variety by baking noise into the topHeight
  channel at map-bake time (not runtime), since data is 28 km/px anyway.
  **Baker rules (from §3.6 H4 + the bimodal-bands lesson):** noise → height
  via LINEAR remap only (never smoothstep-on-noise — third documented
  recurrence of that trap); **acceptance test: dense-region (coverage>0.7)
  p10-p90 topHeight span ≥ 4 km** — ERA5 alone reproduces a flat ceiling in
  closed decks, so injected variance is mandatory, and today's degenerate
  pile (>50% of columns at exactly the cap) is the failure mode to test against.
- Keep the floater fix as a BAKER validation rule, not shader logic: clamp
  topHeight down where coverage is low (the covSpan lesson, earthClouds
  :1903-1911).
- **Erosion semantics — DECIDED (Phase F step 3 passed in-app 2026-07-06):**
  the composition form stays `shape = saturate(profile − (1−carved)·K)`
  (case #20's floater guarantee needs only the subtractive form), with
  **Nubis-form K=1 as the confirmed baseline** (user verdict: "more
  realistic already" — closed-but-structured deck, true black restored in
  the `eroded` viz). Optional Phase-3 refinement: **K as a per-type value**
  (`K = lerp(~0.8 stratiform-smooth, ~1.0 convective, convectivity)` — the
  convective end capped at ~1.0, not 1.1: the 2026-07-06 A/B showed K=1.2's
  through-holes read as unrealistically patchy at high coverage), or
  Frostbite's LUT **G channel = per-type erosion amount** (same fetch as
  the density LUT; our own Frostbite.md documents exactly this, x=type
  y=height R=density G=erosion).
  **ACCEPTANCE CRITERION (from Christian's 2026-07-06 A/B, §6 Q8): a dense
  deck must read AS CLOSED as K=0.6 (no scattered see-through holes to the
  ground at high coverage) while having the structured TOP of a real deck —
  crevices between towers that mostly do NOT punch through, varied tower
  tops, cellular organization. Fullness comes from map coverage ≈ 1 in
  closed cells + the near-zero holes of Nubis-form erosion at profile→1;
  structure comes from topHeight variance (H4) + the mesoscale octave (H3)
  — NOT from a density floor.** Judge against reference photos of real
  broken/overcast decks from above at matched viewing distance.
  Whatever wins the §3.6 falsification sequence: change the erosion AND the
  `probeShape` skip-gate in the same commit (case #13 gate law), document
  the chosen K's rationale in the comment block, and force a light-volume
  re-bake. **Co-change set the K/lift change forces (judge finding):**
  `cloudCommon.COVERAGE_GAMMA`/`coverageToOpacity` + the shell's own
  `pow(COVERAGE_GAMMA)` lift must move in the same commit (the near/far
  area-match curve), and the freshly-tuned 300-600 km shell handoff +
  `SHELL_OPACITY_*` must be re-verified at blend≈0.5 — K=0.6 was plausibly
  part of that brightness/area matching (see §6 Q8), so fixing porridge can
  re-open the seam unless re-tuned.

### 4.3 Per-type detail character (ALU-only, zero new fetches)

Drive the existing detail stages from `convectivity` (and altNorm), exactly
the Nubis wispy↔billowy philosophy:

- `WISP_AMOUNT`: `lerp(0.9, 0.35, convectivity)` — stratiform/decaying edges
  wispy, convective edges solid. (Comment at earthClouds ~L525 already
  anticipates this: "the full cloud-type system … would drive a richer
  wispiness signal".)
- Envelope-model trick (Nubis 2022): wispy→billowy crossover altitude as a
  function of convectivity — `crossover = lerp(1.2, 0.4, conv)`;
  `noiseHeightBlend = smoothstep(crossover − 0.1, crossover + 0.1, altNorm)`
  — wispy bases → billowy cauliflower tops on convective clouds, while
  stratiform (conv→0) NEVER reaches billowy (crossover 1.2 > 1 keeps it
  wispy throughout, agreeing with the WISP ramp instead of fighting it —
  red-team corrected: the naive `conv·0.5` form selects billowy everywhere
  at conv=0).
- `FINE_CARVE_STRENGTH`: `lerp(0.12, 0.28, convectivity)` — hard sharp Cu
  edges vs soft St edges. `DENSITY_GAMMA`: `lerp(1.0, 0.7, convectivity)` —
  soft translucent sheets vs solid cores. `BILLOW_CARVE` similar ramp.
- MS_GAIN / ambient may need a mild per-type scale (thick-deck tuning today).
- **Erosion strength K joins this knob list** (see §4.2) — per-type K (or the
  Frostbite LUT-G variant) is likely the single highest-leverage per-type
  detail knob, since it controls broken-vs-smooth directly.
- Constraints from case #21 (docs_references.md): convectivity ramps must
  multiply INTO the frequency-graded composite (never bypass
  FINE_CARVE_GRADE_POW — HF at edges = pockmarks); ramps live INSIDE the
  DETAIL_FADE amplitude fade; if a type's look exists only via a faded term
  it deletes at range — once the mesoscale octave (§4.7) exists, change
  DETAIL_FADE to fade toward a mid-frequency floor instead of 0 and
  re-measure the case-#22 flicker this fade prevents.
- **Precondition** (Phase 0): extract the duplicated fine-detail composition
  (primary ↔ near probe) and macro-carve composition (4 sites) into shared
  helpers first — otherwise every knob multiplies the drift surface. The
  near self-shadow probe must receive the SAME per-type composition (case
  #21: probe distance = the feature scale that can self-shadow).

### 4.4 Cumulonimbus + anvil: modifier + stamped anomaly, not a type

- Anvil (Nubis 2017 mechanism, with two red-team corrections):
  `anvilBias = smoothstep(0.75, 1.0, convectivity) · smoothstep(9, 12, topKm)`
  `coverageEff = pow(coverage, remapCLAMP(altNorm, 0.7, 0.8, 1.0, lerp(1.0, 0.5, anvilBias)))`
  — the remap MUST clamp (TSL `remap` is unclamped: at altNorm=1 the
  exponent extrapolates negative and `pow(coverage, −0.5)` explodes into a
  solid inverted cap). Wind-shear skew uses SLAB-relative altitude:
  `p += windDir · shearKm · alt01²` (geometry-only; `altNorm` would be
  circular — it needs topKm from the weather tap at the skewed position).
  Global wind uniform for now. Both anvil + skew live in the shared profile
  helper so the 800 m probe and the light-volume bake apply them identically
  (else baked shadows land beside the sheared clouds). Cheap ALU.
- Dramatic supercells / squall lines / (later) gas-giant vortices: **sparse
  anomaly list stamped into the map channels at bake/update time** (Guerrilla
  superstorm pattern — position, radius, intensity, top-boost, anvil spread;
  Cb stamps also inject a downwind cirrus plume into A, per the co-occurrence
  rule). Runtime shader stays unchanged; art/gameplay gets control.
- Requires the slab raise 14→16 km so Cb tops + anvils live above the deck
  (2 lockstep constants; ~+15% in-band cost; profiles km-anchored by §4.2 so
  nothing else moves).

### 4.5 High/cirrus layer (A channel)

Industry consensus: do NOT march cirrus in the cumulus slab. Recommended:
**2.5D cirrus shell** at ~10-11 km reusing the ISSUE-2 shell machinery
(second ExtraMeshDef sphere, scene-geometry → atmosphere-fogged for free),
with the Nubis-Evolved 2.5D density formula: a small baked cirrus texture
with 3 channels (streaky fall-streaks / wispy veil / round Cc granules),
blended by a type scalar (derive from convectivity or fix per-region),
sharpened + gated by `cirrus` coverage:

```
d = ValueRemap(t, .5, 1, ValueRemap(t, 0, .5, cr_streaky, cr_wispy), cr_round)
d = pow(d, 1 − ValueRemap(cirrusCov, 0, 1, −0.9, 0.9)) · ValueRemap(pow(cirrusCov,3), 0, .5, 0, 1)
```

Lit with `farCloudLit` + high-altitude transmittance (thin ⇒ ambient/
translucent; near-zero self-shadow — do NOT reuse the cumulus shadow proxy).

**From-below representation (red-team: the more common viewpoint!).** The
deck shell's recipe does NOT transfer: it is FrontSide (culled from inside)
and fades out below 28→14 km — a cirrus shell built that way vanishes for
any camera under ~10-11 km, i.e. exactly when flying under a cirrus veil.
The cirrus shell needs: DoubleSide (or a BackSide twin) with depthTest; NO
deck-style altitude fade — fade only while the camera crosses the cirrus
band itself; explicit `mesh.renderOrder` set via `onMount` (ExtraMeshDef has
no renderOrder field; two concentric transparent depthWrite=false spheres
otherwise tie in three.js's transparent sort); WebGPU pipeline pre-warm
(extras get no compileAsync — first-visible-frame hitch otherwise); texture
auto-mipped with a real mip chain and ≥footprint-scale content (shell Bug
B's flicker mechanism applies verbatim). From below, the volumetric
composite paints over it near-field — acceptable since cirrus sits above
the slab's dense content.

Known limitation to measure (looking DOWN): the volumetric composite paints
OVER scene geometry, so from 12-14 km looking down, a Cb tower behind/below
the cirrus veil would wrongly occlude it. Mitigations, in order of cost:
accept (thin veil, subtle), depth-aware composite using the marcher's
existing tFront vs shell depth (tFront already flows to the AP path), or the
fallback **in-slab volumetric cirrus band** (profile-gated at 9-13 km;
empty-gap steps are tap-free so cost is confined to cirrus pixels; needs an
anisotropic sheared streak noise = dual-file bake change — the reason this
is the fallback, not the default). Decide on measurement (R7).

### 4.6 Far field / LOD coherence (R8)

The in-progress cloud shell + baked-overlay work consumes `weatherAt` too:
- Shell opacity: from `coverage` via `coverageToOpacity` (as today) PLUS
  `cirrus` compositing (cirrus visible from orbit is a big part of Earth's
  look — currently entirely missing).
- Type-aware far-field shading: self-shadow proxy `1 − 0.5·coverage` must not
  darken cirrus/stratus like cumulus — scale it by convectivity.
- The far-field shell (now the RUNTIME shared-model shell, not a bake — see
  §3.1 update) inherits the coverage/type/height channels through the same
  provider, which directly fixes its open Bug A: with an explicit topHeight
  channel + km-anchored profile, the shell no longer needs fixed alt01
  sample heights that miss the stratus band. Bug B (flicker) argues the
  shell should consume ONLY the smooth weatherAt fields + profile envelope
  (zero 3D-noise taps at range) — which v2 enables: coverage + topHeight +
  convectivity fully determine the macro envelope.
- The shell's `smoothstep(0.05, 0.35, maxShape)` firm-up currently
  binarizes; once the map carries mesoscale cell structure (§4.7), the
  firm-up must preserve map-carried gaps, not erase them (§3.6 H6).
- Consolidate the shell's duplicate `uCloudUvOffset` with the marcher's
  BEFORE any drift animation (code_marcher.md footgun #2).

### 4.7 Earth data bake pipeline (R3)

`scripts/bake_weather_map.py` (cdsapi + xarray + numpy + pillow), checked in:

1. Pick timestamp: browse NASA Worldview for a photogenic UTC instant
   (N-Atlantic comma cloud, active ITCZ, Peru/Namibia/California Sc decks).
2. Pull that ERA5 instant: single-levels (tcc, lcc, mcc, hcc,
   cloud_base_height, CAPE, t2m, skt) + pressure-levels (cc, r, t, w at
   1000…200 hPa). Free CDS registration; Copernicus attribution required.
3. Derive channels on the 1440×721 grid: R=tcc (low+mid weighted);
   G=clamp(normCAPE · ascent(ω) · (1−EISnorm)) (clamp CAPE at 5000 J/kg —
   ERA5 spikes); B=height of highest level with cc>0.1, /18 km;
   A=hcc.
4. Blend ISCCP-H climatological Sc prior in the five marine Sc-deck boxes
   (ERA5 under-represents them). Apply co-occurrence validation rules
   (topHeight clamp at low coverage — the floater rule; Cb⇒cirrus plume
   comes free in real data).
5. Regrid: ERA5 rows start at 90°N, lons 0-360 → flip + rotate to standard
   equirect; verify against the engine's UV convention ONCE with the Peru
   deck landmark.
6. Upsample 1440→4096 injecting per-channel sub-grid detail. **The coverage
   channel's 10-40 km MESOSCALE ORGANIZATION octave is FIRST-CLASS, not a
   hint** (§3.6 H3): closed/open Sc cells, cloud streets, cumulus island
   structure (Nubis-2017 Perlin-Worley G-channel style) — **with true zeros
   for clear-sky lanes**. Nothing at runtime owns the 8.3 km↔map-scale band;
   if the bake doesn't carry it, nobody does. Rules: injected features
   ≥ ~5 km (feature-scale-vs-viewing-distance law; smaller = far-field
   shimmer), all noise→channel mappings LINEAR (anti-bimodal lesson),
   topHeight variance per the §4.2 acceptance test. Optional: old Blue
   Marble as a coverage-detail multiplier.
7. Output PNG(16-bit master) → 8-bit → `convert-to-ktx2.sh --linear` →
   4096 primary + 2048 mid tier. Validate UASTC channel crosstalk. **sRGB
   footgun (red-team verified):** the SHIPPED `earth_clouds_8k.ktx2` is
   sRGB-encoded, while the convert script's batch mode now special-cases
   earth_clouds as *linear* — re-running `--all` today silently changes the
   live cloud look; and all raw-value analysis (e.g. the 0.427 carvability
   bound in §3.6) is in DECODED terms. Pin the intended encoding before this
   phase and state all old-vs-new comparisons in sampled (post-decode) space.
8. Later (weather evolution): bake 8-24 timesteps of one synoptic day into a
   texture array and interpolate — real fronts advect for free.

### 4.8 Procedural planets (R4)

Same channels, different producer — one code path after the classifier:
generate predictor stack (SST/elevation → circulation template: ITCZ band,
±30° subsidence, storm tracks → RH/EIS/CAPE/ω/wind fields) → run the SAME
predictors→channels classifier as step 3 above → same runtime. The classifier
being shared between the Earth baker and the procedural generator is the
architectural guarantee that procedural planets look climate-plausible.
Weather states / temporal evolution: 2017-Nubis-style state objects (density,
anvil bias, wind, movement) lerped over tens of seconds, per climate zone.

### 4.9 Gas giants (R5)

Same consumption path, different generator + per-planet config:
- **Per-planet cloud config** (the R4/R5 seam, replaces Earth-hardwired
  constants): `{ innerKm, outerKm (Jupiter ≈ 150 km slab), planetRadiusKm,
  weatherTexture | provider, profileLUT, detailParams, densityMul,
  windProfile }`.
- Generator: 1D band table (16-32 bands: jet velocity, per-deck clearing,
  deck-top offset, tint, turbulence amplitude) → equirect bake with
  latitude-squashed domain-warped fBm + stamped vortex list (GRS: ~15,000 km,
  top +8 km, 6-day rotation, turbulent wake; use Guerrilla's concentric
  rotation rings for the mesocyclone swirl).
- Channel reinterpretation: coverage→deck clearing (≈1 everywhere),
  topHeight→per-band deck-top altitude, convectivity→convective plume/storm
  mask (bright white H₂O-powered towers punching +50 km — reuses the
  terrestrial convective look!), cirrus→overlying haze veil.
- Profile LUT: per-deck rows (3 thin decks, each ~7-10 km — Earth-stratiform-
  like, so the LUT abstraction fits without change).
- No surface: below the deepest deck, density fades into exponentially
  thickening haze (fog-wall bottom, never an under-surface).
- Time evolution: differential zonal advection of the map/noise
  (`lon += u(lat)·t/(R cos lat)`) + curl-noise shear at band boundaries.
- Note: NOBODY has published a shipped fly-through gas-giant volumetric with
  real structure — Star Citizen's Crusader (the closest shipped analogue) is
  a hand-authored, Earth-sized aesthetic cloudscape using their standard
  per-planet volume textures + tint (§3.3); it validates the fog-wall bottom
  and the "same marcher, per-planet content" seam, but the band-table
  generator remains pioneering work; measure early with a crude band bake.

### 4.10 Performance accounting (R6)

Per dense march step vs today: −1 texture3D (column tap removed — this also
supersedes CLOUD_REVIEW PERF lever #3 and captures more than it),
+1 texture2D (profile LUT), weather tap unchanged (reads RGBA instead of R),
per-type detail = pure ALU on already-fetched values. Expected: **neutral to
slightly better** (verified by the red-team pass against the current tree:
warpVec is a zero vector everywhere, colSample's only live output is topAlt).
**Additional win the plan can claim:** once the far shell consumes only the
smooth `weatherAt` fields + LUT profile envelope (the Bug-B fix, §4.6), it
drops its current ~7 texture3D taps per shell pixel. Cirrus shell = one
textured mesh (negligible). Slab 14→16: ~+15% in-band iterations (only
inside cloud bands). Light volume bake: unchanged cost (same taps, new
shared formulas). Everything behind build consts; measure at the three
canonical camera positions (in-cloud / high / orbit) per the review doc's
method before/after each phase.

---

## 5. Migration plan (each phase shippable + falsifiable, R7)

- **Phase F — falsification sequence FIRST (~half a day, one-liners).** Run
  the §3.6 sequence (eroded-viz floor check → K A/B → Nubis-form one-liner →
  topAlt viz + linear remap → cellular-mask preview → DETAIL_FADE A/B).
  Outputs: the chosen erosion semantics (K value / form / per-type), the
  measured topHeight-variance requirement, and visual proof of the mesoscale
  octave's value — all BEFORE any refactor locks them in. Measure-first.
- **Phase 0 — cloudShared.ts consolidation (pure refactor). ✅ LANDED
  2026-07-06 (derivation chain; pending user visual parity confirmation).**
  Created `src/components/celestial/bodies/cloudShared.ts` (TSL-only, the
  cloudDetile.ts pattern) exporting `TOPALT_LINEAR`, `topAltSpread`,
  `deriveCloudType`, `deriveTopAlt`, `cloudHeightProfile`. Consumed by
  earthClouds.ts (marcher dense branch — Q2b done: inline `cloudType`/
  `covSpan`+`topAlt` now call the shared helpers; + shell + `topAlt`
  diagnostic) and cloudLightVolume.ts (deleted `cloudHeightProfileInline` +
  the inline type/topAlt derivation + the `TOPALT_LINEAR_MIRROR` constant →
  mirror lockstep hazard #1 eliminated structurally). Provable parity:
  every replaced site builds the identical node graph, and the consolidated
  `TOPALT_LINEAR` equals the old earthClouds `TOPALT_LINEAR` ==
  cloudLightVolume `TOPALT_LINEAR_MIRROR` (both were `true`), so behavior is
  unchanged. Lint clean (0 errors; no new warnings in the 3 files).
  **Phase 0b ✅ LANDED 2026-07-06 (pending user visual parity):** two
  marcher-local shared kernels added to earthClouds.ts —
  `billowCarveKernel(dilated, carveSrc)` (the Schneider value-erosion carve;
  1 def + 5 call sites: the detile `carvedShapeAt`, primary non-detile,
  800 m self-shadow probe, dead cone, AND the shell opacity-LUT builder —
  the last removes another "keep in lockstep with the marcher" note) and
  `fineCarveDelta(fineSrc, profileInput, tDist, detailFade)` (the full
  grade→wisp→HHF→centered-bias·strength·fade composition; 1 def + 2 call
  sites: opacity path + near self-shadow probe). The fineCarveDelta share is
  the case-#21 precondition for Phase 3 per-type detail: WISP_AMOUNT /
  FINE_CARVE_STRENGTH / HHF etc. now have ONE home that both the view ray and
  its self-shadow read, so a per-convectivity ramp can't desync them. Kept
  marcher-local (not cloudShared) because the light-volume bake is macro-only
  and the shell uses the statistical LUT. Provable parity (identical node
  graphs; the probe's `.mul(float(1))` fade is a numeric no-op). Lint clean.
  USER VERIFY: pixel-parity at the 3 canonical camera positions + full
  DEBUG_VIZ sweep unchanged (esp. 'profile', 'topAlt', 'eroded', 'litShape',
  'detailShadow', shadow attachment); look closely at NEAR-camera cauliflower
  detail + self-shadowing (fineCarveDelta feeds both). Original scope note:
  Move into one shared module consumed by earthClouds + cloudLightVolume +
  the shell helpers: cloudHeightProfile (+ inline copy), the coverage-lift/
  type/topAlt derivation (now THREE copies — marcher inline, cloudLightVolume
  densityAt, shell's deriveCloudType/deriveTopAlt/columnMacroCoverage; the
  shell helpers are the natural seed), FBM weights, macro-carve composition
  (4 sites), fine-detail composition (2 sites). Hazards (docs_references.md):
  TSL If-scope magic (neutralise gates, never delete), .toVar aliasing
  (materialize inputs read across mutation), delete-superseded-paths rule.
  Fix stale comments found in §3.6 (colSample is the Perlin-Worley HYBRID
  mean≈0.7, not Perlin mean 0.5; document whatever K rationale Phase F
  chose). Verify: pixel-parity screenshots at the 3 canonical positions +
  full DEBUG_VIZ sweep unchanged.
- **Phase 1 — Weather Map v2 plumbing with a SYNTHETIC map.** Build const
  `WEATHER_V2`. Generate a test RGBA map (independent low-freq noises +
  hand-painted regions sweeping convectivity × topHeight — a "genus test
  chart", including a realism-fractions region: Cu-dominant, Cb rare, per
  SHAPE_PLAN C.3). **The synthetic map must already carry the §3.6 porridge
  content — 10-40 km mesoscale organization with true zeros in coverage,
  linear tower-height variance in B (dense-region p10-p90 ≥ 4 km) — so the
  porridge fix is validated in THIS phase, not deferred to the data bake.**
  Extend provider to `weatherAt` struct (ONE materialized fetch, §4.1;
  per-step sampling stays; keep the load-bearing hoisted-If; audit ALL
  consumers of the old hoists — light volume, ground shadow, shell). G
  replaces the cloudType smoothstep; B replaces covSpan/colSample→topAlt;
  DELETE the per-step column tap — **all five consumer sites migrate in one
  commit** (marcher colSample, shell deriveTopAlt/columnMacroCoverage, light
  volume colTap, colSampleMid diagnostic, warpVec zero-vector removal), else
  near/far/shadow topAlt semantics diverge. Migrating the shell to
  `weatherAt` here is ALSO the structural fix for open shell Bugs A+B (it
  drops the shell's per-pixel 3D-noise taps). Apply the Phase-F erosion
  decision (linear coverage, new K/form, probeShape gate in the same commit
  — case #13; plus the §4.2 co-change set: COVERAGE_GAMMA/coverageToOpacity/
  shell lift + handoff re-tune). **Force a light-volume re-bake (both
  ping-pong sides) on WEATHER_V2 flip / any in-place map change** — the
  amortised bake otherwise serves stale shadows. Old path kept for A/B.
  Verify: DEBUG_VIZ 'profile'/'topAlt' match the painted map (scope: B is
  INERT in stratiform regions until Phase 2 — the analytic St/Sc curves
  ignore topAlt; only the cumulus end responds in this phase); whyStop/iters
  clean (gate law); fps at 3 positions (expect ≥ neutral); binary-border
  symptom gone; thick-region porridge visibly broken up (the Phase-F
  criteria); shadows attached after re-bake; near/far handoff at blend≈0.5
  re-verified.
- **Phase 2 — Profile LUT + genus anatomy.** Generated-LUT script (process-
  lifetime DataTexture singleton, never reassigned — WebGPU bind groups),
  km-anchored rows (St/Sc/As/Cu-hum/Cu-con/Cb-body), swap marcher + light
  volume + shell to the LUT (`.level(0)` inside the marcher loop; auto-mip
  for shell consumers). Anvil modifier + shear skew. Re-validate the shell's
  profile sampling after the swap (Bug A's failure mode: stratiform rows
  RELOCATE the nonzero band). Verify: DEBUG_VIZ 'profile' per test-chart
  region vs the genus table **including at LUT v-MIDPOINTS between genus
  anchors** (the parameter-interpolation invariant: every intermediate row
  must be a plausible single-bump profile, never a two-bump half-amplitude
  blend); floaterProbe/baseColumn clean; maxProfile vs maxProbeShape +
  whyStop/iters (case #13: the LUT profile must feed gate, probe, AND dense
  branch); shadows attached after LUT swap (forced re-bake); flat bases /
  rounded tops preserved.
- **Phase 3 — Per-type detail.** Convectivity-driven K/WISP/FINE_CARVE/
  DENSITY_GAMMA ramps + altNorm wispy→billowy crossover, inside the
  frequency grading and the DETAIL_FADE envelope (case #21 rules, §4.3);
  near-probe composition in lockstep. Verify: close-up fly-bys per genus
  region vs reference photos; eroded/litShape/detailShadow vizzes; edge
  speckle regression watch (case #21); distant flicker re-check (case #22).
- **Phase 4 — Earth data bake.** `bake_weather_map.py` per §4.7; convert
  with EXPLICIT `--linear` (filename auto-detect won't catch it); set
  wrapS=RepeatWrapping on the mid tier too; swap texture + force re-bake.
  Verify: orbit look vs NASA reference imagery of the chosen date; Sc decks
  present off Peru/Namibia/California with cell structure; ITCZ reads as
  broken Cb band; topHeight-variance acceptance test (§4.2); ground-shadow +
  far-shell coherence (R8); UASTC channel-crosstalk check.
- **Phase 5 — Cirrus layer.** PRECONDITION: shell Bugs A/B resolved or
  measured (Bug A is largely fixed by Phases 1-2; Bug B's mechanism —
  fresh-every-frame shell + sub-pixel content — applies verbatim to the
  cirrus shell, so its texture must be auto-mipped/footprint-aware from day
  1). A-channel + 2.5D shell + cirrus texture bake; explicit renderOrder for
  the two concentric transparent spheres; expect first-frame compile hitch
  (extras get no compileAsync warmup — pre-warm). Measure the occlusion
  limitation from 12-14 km; decide accept / depth-aware composite (tFront
  already flows to the AP path) / volumetric band fallback. Check the
  analytic-fog limb ring once from orbit.
- **Phase 6 — Slab 14→16 km + Cb polish.** TWO lockstep constants
  (CLOUD_OUTER_ALTITUDE_KM ↔ earth.ts CLOUD_TOP_ALTITUDE_KM — red-team
  verified SHELL_ALTITUDE_KM and SHELL_FADE_OFF_ALT_KM both DERIVE from
  these; only SHELL_FADE_FULL_ALT_KM=28 is an independent judgment value to
  eyeball after the raise) + anvil tuning + (optional) anomaly stamp tool
  for supercells. Reduces but does not remove the baker's topKm ≤
  outerKm−margin clamp (§4.2). slabLen-derived march tuning shifts (lodCap,
  skip strides): re-run whyStop/iters at the 3 canonical positions; watch
  for the case-#18(b) light-volume banding signature; keep tExitSlab =
  tOuterFar ALWAYS (case #22 issue 2).
- **Phase 7 (future) — procedural generator + weather states/evolution;
  precipitation & optical-depth channels (weather map B); rain shafts/virga.**
- **Phase 8 (future) — gas giants** per §4.9 (own plan doc when started;
  needs the per-planet cloud config extraction as its first step).

Phases 1-3 deliver the user-visible goal (realistic, smoothly-mixed types)
with zero external-data dependency; Phase 4 makes Earth *true*; 5-6 complete
the genus set. This ordering was chosen so the highest-priority item
(types/shapes) lands first and every step is A/B-able in-app.

## 6. Decisions (all questions answered by Christian, 2026-07-06)

1. **A channel = cirrus coverage.** τ/precipitation wait for weather map B
   (and the Ns-aliases-to-As caveat in §4.1 stands until then).
2. **Earth look = one photogenic real timestamp**, and the baker ships with
   a known-good default candidate (to be picked once during Phase 4 by
   browsing NASA Worldview for a good N-Atlantic comma + active ITCZ + Sc
   decks day, then hardcoded as the script default).
3. **Cirrus = 2.5D shell first**, with the measured fallback plan (§4.5).
4. **Map encoding — delegated ("do what you think is best")**: DECIDED as
   specced in §4.1 — 4096×2048 RGBA8 linear KTX2 UASTC with the crosstalk
   validation step; fallback to two RG8 textures (or uncompressed 2048) only
   if crosstalk is visible in the channel-isolation check.
5. **Ordering approved**: Phase F → 0 → 1 → 2 → 3 → 4 → 5 → 6.
6. **Star Citizen: closed** — research done (web_star-citizen-genesis.md);
   nothing more is published, no further digging.
7. **Procedural-first locked decision: resolved pragmatically.** Christian's
   stated goal: "a system that produces realistic results both for Earth and
   later for procedurally generated planets." That is exactly what the
   shared-classifier architecture provides (§4.7/§4.8: ONE predictors→
   channels code path; Earth feeds it real ERA5 fields, generated planets
   feed it synthetic predictor fields). The SHAPE_PLAN decision's motivation
   (streaming, no loading screens, generality) is not violated — the baked
   map is a static texture with identical streaming properties to today's
   cloud texture. Earth-from-real-data additionally serves as the ground
   truth that VALIDATES the classifier before procedural planets rely on it.
   The 2026-06-14 locked decision is formally superseded for Earth.
8. **BASE_EROSION_K = 0.6: mystery solved — it was an aesthetic tune.**
   Christian A/B'd 0.6 vs 1.2 with screenshots (= Phase F falsification
   step 2, ALREADY RUN — result recorded in §3.6 below): at 1.2 the deck
   looks "patchy and less satisfying even in the highest-coverage areas"
   (see-through holes to terrain); at 0.6 "thicker and more natural" (but
   it is the §3.6 porridge floor). Stated goal: "true to real life."
   Interpretation: K was the ONLY available knob trading patchy↔full, and
   BOTH endpoints are wrong vs reality — real high-coverage decks are
   CLOSED (like 0.6) but with a STRUCTURED top surface (crevices between
   towers that do NOT punch through, varied tower heights, cells — which
   neither K can produce because the deficit is vertical structure (H4) and
   mesoscale organization (H3), not erosion strength). This becomes the
   Phase-F/Phase-1 ACCEPTANCE CRITERION (see §4.2). **RESOLVED later the
   same day: Phase F ran all six falsifications (results in §3.6) — the
   3+4+5 toggle combo met the criterion in-app; Nubis-form K=1 is the
   confirmed §4.2 baseline.**

## 7. Sources

Primary: Schneider SIGGRAPH 2015 & 2017 (advances.realtimerendering.com),
Nubis Evolved 2022 + Nubis Cubed 2023 (d3d3g8mu99pzk9.cloudfront.net /
guerrilla-games.com), Guerrilla GDC 2022 superstorms; UE5 Volumetric Cloud
docs (dev.epicgames.com); meteoblue/MSFS partnership material + MSFS SDK
Weather Definitions; Hillaire SIGGRAPH 2016 (Frostbite); RDR2 SIGGRAPH 2019;
ERA5/CDS, ISCCP-H NCEI, MOD08 LAADS, GPM IMERG, GMGSI AWS, CALIPSO-GOCCP,
CloudSat CLDCLASS; NASA Jupiter cloud references + zonal-jet review papers;
Space Engine dev blog; NMS Worlds Part II notes. Full URLs inside
`docs/CloudTypesResearch/*.md`.

## 8. Work log

- 2026-07-04: Skeleton + first-hand code anchors (main session). Launched
  7-investigator + 3-proposal + judge workflow.
- 2026-07-05: Workflow returned 4/7 reports (code marcher deep-dive, Nubis
  lineage, meteorology+datasets, engines+gas-giants); 3 investigators + all
  proposals + judge KILLED BY ORG SPEND LIMIT. Reports preserved in
  docs/CloudTypesResearch/. Design synthesized in main session (this doc §4-5).
- 2026-07-06: Gap-fill round. Second parallel wave ALSO hit the spend limit
  (2/4 survived: farfield+config, docs:references) → switched to SEQUENTIAL
  agents per Christian's request. Landed: cloud_shape_anatomy.md (Monte-Carlo
  porridge diagnosis → §3.6 + amendments applied across §4/§5),
  web_star-citizen-genesis.md (§3.3 corrected — two-era picture), staged-shell
  ground truth (§3.1 update), ~20 constraints from docs_references.md folded
  into §4/§5, Phase F (falsification-first) added. Red-team judge pass
  (docs/CloudTypesResearch/judge_redteam.md) found 2 §4.2 blockers (LUT
  boundary-zero invariant; parameter-interpolated rows, never sparse-anchor
  filtering), 2 §4.4 formula bugs (unclamped anvil remap; circular shear
  skew), + verified the perf claims and the 2-constant slab-raise count —
  ALL fixes applied to this doc.
  NEXT: Christian reviews §6 questions (esp. Q7/Q8) → run Phase F → Phase 0.
- 2026-07-06 (later): Christian answered ALL §6 questions (now a decisions
  record) and ran Phase-F step 2 himself (K=0.6 vs 1.2 screenshots) —
  result + interpretation recorded in §3.6/§4.2/§6-Q8 + anatomy-doc
  addendum. Erosion acceptance criterion set: "closed like K=0.6,
  structured like a real deck" (fullness from coverage+Nubis erosion,
  structure from topHeight variance + mesoscale octave, NOT from a density
  floor); convective K capped ~1.0.
  NEXT: Phase F remaining steps (1, 3-6) → Phase 0. Plan is
  implementation-ready.
- 2026-07-06 (evening): **PHASE F COMPLETE.** Implemented steps 3-5 as
  build-const toggles (`EROSION_NUBIS_FORM` / `TOPALT_LINEAR`(+`_MIRROR`) /
  `MESOSCALE_TEST` in earthClouds.ts + cloudLightVolume.ts; lint clean;
  no-op default verified). Christian ran all six falsifications with
  screenshots — H1/H3/H4 CONFIRMED and their fixes validated (3+4+5 combo
  met the not-porridge acceptance criterion); H5 refuted as a static-look
  cause (null result at any DETAIL_FADE_FAR — sub-footprint detail can't
  alter stills; fade is anti-flicker only). §4.2 erosion DECIDED:
  Nubis-form K=1 baseline. Results + interim toggle disposition in §3.6.
  NEXT: **Phase 0** (cloudShared.ts consolidation) — the design is fully
  validated; implementation can start.
- 2026-07-06 (later): **Phase 0 LANDED** (derivation chain). cloudShared.ts
  created; marcher (Q2b), shell, and light-volume bake all consume it;
  cloudHeightProfileInline + TOPALT_LINEAR_MIRROR deleted (mirror hazard #1
  gone). Provable-parity refactor, lint clean. Phase 0b (macro-carve +
  fine-detail composition consolidation) deferred as the riskier half.
  NEXT: user confirms visual parity → Phase 0b or straight to Phase 1
  (weather-map v2 plumbing with a synthetic genus test chart).
- 2026-07-06 (later still): Phase 0 verified identical by user →
  **Phase 0b LANDED.** billowCarveKernel (1 def + 5 sites) + fineCarveDelta
  (1 def + 2 sites) extracted in earthClouds.ts; the fineCarveDelta share is
  the case-#21 Phase-3 precondition (view ray + self-shadow read one
  composition). Provable-parity refactor of the LIVE marcher hot path, lint
  clean. NEXT: user confirms Phase 0b parity (esp. near-camera cauliflower +
  self-shadow) → **Phase 1** (weather-map v2 plumbing + synthetic genus test
  chart). Phase 0 (both a+b) fully done.
