# Atmospheric Scattering — Implementation Plan

Physically-based, per-planet atmospheres for Stellar Nomad (WebGPU / three.js TSL).
Visible from space, low orbit, and the surface; correct sunsets, limb glow, aerial
perspective, and light coupling onto clouds + the ship. Earth is the testing ground;
the system generalizes to Mars, the gas giants, and procedural planets.

> Status: **planning complete, implementation not started.**
> Companion references live in [`docs/AtmosphereReferences/`](AtmosphereReferences/)
> (Hillaire 2020 = `EpicGames.md`, Hillaire 2016 = `Frostbite.md`,
> Bruneton 2008 = `HAL.md`, Unreal Sky Atmosphere = `UnrealEngine.md`).

---

## 1. Technique & rationale

We implement **Hillaire 2020, "A Scalable and Production Ready Sky and Atmosphere
Rendering Technique"** (the model that ships in Unreal Engine). It is the only
technique in our references that simultaneously:

- renders correctly across the **full range we need** — ground → low orbit → deep
  space — from a single model (the analytic clear-sky models like Preetham/Hosek are
  ground-only; the LUT models like Bruneton are accurate but heavy to update);
- supports **arbitrary atmosphere composition** (Earth, Mars, procedural) by swapping
  coefficients, with **no expensive LUT rebake** on change — its O(1) multiple-scattering
  approximation is the headline contribution that makes this possible;
- is **cheap**: ~0.3–0.5 ms at 720p on a 2016 GTX 1080, ~1 ms total on an iPhone 6s.
  On an M2 Pro the atmosphere itself is near-free. **The clouds remain our cost risk,
  not this.**

**Lineage** (so we know which doc to consult for what):
`Bruneton 2008 (HAL)` → `Frostbite 2016 (Hillaire)` → `Hillaire 2020 (Epic)` → `Unreal docs`.
We take Hillaire 2020 as the core and borrow from the others:
- **Frostbite 2016:** the **ozone model**, the **sun/moon/limb-darkening photometry**,
  and the **energy-conserving analytic step integral** (sample-count-independent — use
  it in every march, atmosphere and cloud).
- **Unreal docs:** artist-facing **parameter defaults** + the **per-pixel-transmittance /
  space-view** gotchas.
- **Bruneton 2008:** why the transmittance LUT is only 2D (spherical symmetry) and the
  `T(x,v)/T(y,v)` ratio trick for transmittance between two points.

### Locked decisions (from planning discussion)
1. **Luminance/exposure:** one **unified linear-luminance working space** for the scaled
   scene (sun illuminance, atmosphere in-scatter, surface lighting), with a **single
   tunable exposure constant** applied before tonemapping. Re-tune the sun disk,
   directional light, and bloom **once** against this scale. **No auto-exposure** in v1
   (deferred to Phase 6).
2. **Phase 1 scope:** **sky + limb + sunset only**, Earth only, via per-pixel ray march.
   No aerial-perspective froxel, no cloud coupling yet. Fastest path to a dramatic,
   verifiable result; it also lets us delete the fake Rayleigh hack immediately.

---

## 2. Engine facts this plan is built on (verified against current code)

| Fact | Location | Consequence for atmosphere |
|---|---|---|
| Two scenes / two cameras: `scaledScene`+`scaledCamera` (planets, skybox, stars; 1 unit = 1000 km) and `localScene`+`localCamera` (ship, asteroids; 1 unit = 1 m) | `SpaceRenderer.tsx:85,86,172+` | Atmosphere is a **scaled-scene** post-pass. Aerial perspective on the *ship* is a separate, later concern (local scene composited last). |
| Render order: `scaled→rt` → cloud passes (skipped when blend≈0) → cloud composite→`rt` → local→`rt` (clearDepth) → `RenderPipeline` (bloom+tonemap)→canvas | `SpaceRenderer.tsx:421–577` | Insert the atmosphere pass **right after Pass 1**. |
| `rt` is `RGBA16F` with `depthBuffer:true`, but **no downstream pass reads scaled-scene depth** (clouds are analytic; local clears depth) | `SpaceRenderer.tsx:191–198, 567` | v1 needs **no depth texture** — planets are perfect spheres → analytic intersection. (A sampleable `rt.depthTexture` is a Phase-2 add for object AP.) |
| Scaled camera: `near=0.001` (1 km), `far=2_000_000`, **no** log-depth buffer | `SpaceRenderer.tsx:43–44, 334–340` | Plenty of range; do scattering math in **planet-centered km**, not scaled units, for precision. |
| Fullscreen-pass pattern: ortho cam `(-1,1,1,-1,0,1)`, `PlaneGeometry(2,2)`, `NodeMaterial`, ray reconstructed from `screenUV` + `uCameraMatrixWorld` + `uTanHalfFov` + `uAspect` | `cloudFullscreenPass.ts`, `SpaceRenderer.tsx:96–98` | The atmosphere pass copies this verbatim. |
| Cloud pipeline is a **global singleton** registered via `getActiveCloudPipeline()`; `setupCloudPipeline()` returns `{scenes, cameras, updateUniforms, …}`; meshes self-register a `matrixWorld` provider via `ExtraMeshDef.onMount` | `cloudFullscreenPass.ts:108+`, `types.ts:24–37` | Atmosphere mirrors this: `setupAtmospherePass()` singleton + per-frame `updateUniforms`. |
| Per-body sun direction `uSunRel` computed every frame; `createUniforms`/`onFrame`/`extraMeshes` hooks exist on `CelestialBodyConfig` | `CelestialBody.tsx:230,275–286,365–373`; `types.ts:68–94` | Reuse `uSunRel`; add per-body `atmosphere?` config + uniforms. |
| Scales/units helpers | `units.ts` (`SCALED_UNITS_PER_KM = 1/1000`, `kmToScaledUnits`, `toScaledUnitsKm`) | Convert planet center/radius + camera into planet-local km in `updateUniforms`. |
| Sun is at `STAR_POSITION_KM` (sol.json); Earth far away at `PLANET_POSITION_KM` | `celestialConstants.ts:32,47` | Sun is effectively a directional light per body (already modeled). |

### Existing FAKE atmosphere to remove/replace (do not leave double-counting)
- `earth.ts:375–392` — fake "Rayleigh" (view-angle desaturation + blue limb in-scatter) in the **surface** shader. **Replace** with real AP in Phase 1/2.
- `earth.ts:265–281` — terminator warm-tone tint. Superseded by real transmittance-tinted lighting (Phase 2).
- `earth.ts:398–427` (`earthBillboardFragment`) — far-LOD billboard "atmosphere rim glow." Keep for the *far* billboard tier (atmosphere pass only runs when a body is near), but revisit so the near→billboard handoff matches.
- Ad-hoc cloud tints (`CLOUD_BRIGHTNESS`, warm-terminator mix in `earth.ts`, cloud color logic in the marcher) — **replace** with atmosphere-driven sun color + sky ambient in Phase 3.

---

## 3. Physical model & seed constants

Atmosphere = sum of components, each with per-wavelength (RGB) scattering σs and
absorption σa coefficients and an altitude density profile. Extinction σt = σs + σa.

### Earth (Hillaire 2020, Table 1). Use real `PLANET_RADIUS_KM = 6371`; atmosphere top = +100 km.

| Component | σs (×10⁻⁶ m⁻¹) | σa (×10⁻⁶ m⁻¹) | Density profile | Phase |
|---|---|---|---|---|
| Rayleigh | (5.802, 13.558, 33.1) | 0 | exp(−h / 8 km) | `3(1+cos²θ)/(16π)` |
| Mie | 3.996 | 4.40 | exp(−h / 1.2 km) | Cornette–Shanks, **g = 0.8** |
| Ozone | 0 | (0.650, 1.881, 0.085) | tent: `max(0, 1 − |h−25|/15)` | n/a (absorption only) |

- Ground albedo ρ = 0.3 (uniform diffuse sphere for the multi-scatter + ground-bounce term).
- Multiple scattering uses an **isotropic** phase (Hillaire's simplification) — only the
  single-scatter term uses the real Rayleigh/Mie phases.
- (Variant for reference: Bruneton/Frostbite use Mie σs = 2.0e-6, σt = 1.11·σs. We use
  Hillaire 2020's table.)
- Ozone fallback if the tent layer misbehaves in RGB: give ozone the **Rayleigh exp
  profile** and add σa to Rayleigh extinction (Frostbite's pragmatic hack).

### `AtmosphereParams` (the per-planet data structure)
```ts
type AtmosphereParams = {
  groundRadiusKm: number;       // = body radiusKm
  atmosphereHeightKm: number;   // Earth 100
  rayleighScattering: Vec3;      // m^-1, per-RGB
  rayleighScaleHeightKm: number; // Earth 8
  mieScattering: number;         // m^-1
  mieAbsorption: number;         // m^-1
  mieScaleHeightKm: number;      // Earth 1.2
  mieG: number;                  // Earth 0.8
  ozoneAbsorption: Vec3;         // m^-1, per-RGB (0 if none)
  ozoneCenterKm: number;         // Earth 25
  ozoneWidthKm: number;          // Earth 30
  groundAlbedo: Vec3;            // Earth ~0.3
  sunIlluminance: Vec3;          // top-of-atmosphere, in the unified luminance scale
};
```
New file `src/components/celestial/bodies/atmosphereData.ts`:
`EARTH_ATMOSPHERE`, `MARS_ATMOSPHERE` (thin, dusty, reddish, no ozone — art-directed
against reference photos), gas-giant presets, and `proceduralAtmosphere(knobs)` deriving
coefficients from a small knob set (surface density/pressure, radius, atmosphere height,
dominant-gas tint, Mie/haze amount + g, optional ozone-like absorber). Earth's
`earthConfig` gets `atmosphere: EARTH_ATMOSPHERE`.

> **Phase 5 update (2026-07-02):** all presets are now DERIVED — bodies carry a physical
> description in `sol.json` and `deriveAtmosphere()` produces the params (Earth reproduces
> the table above to <0.2%). `AtmosphereParams` gained per-channel Mie and `gasAbsorption`
> (well-mixed absorber on the Rayleigh profile, e.g. CH4). See §7 Phase 5.

---

## 4. The four LUTs (Hillaire 2020, Table 2)

| LUT | Dim / res (PC) | Steps | Cadence | Role | Phase |
|---|---|---|---|---|---|
| **Transmittance** | 2D 256×64 | 40 | static / planet | medium+sun transmittance for any (altitude, sun-zenith) — the workhorse | **1** |
| **Multiple-scattering** | 2D 32×32 | 20 (×64 dirs) | static / planet | Hillaire's O(1) infinite multi-scatter (16-bit ok) | **1** |
| **Sky-View** | 200×100 lat/long | 30 | per frame | fast distant-sky lookup for ground/low-alt views (waste in space → fall back to raymarch) | 4 |
| **Aerial-perspective** | 32×32×32 froxel | 30 | per frame | in-scatter+transmittance vs depth, applied to surface/clouds/ship | 4 |

- Transmittance + Multi-scatter are tiny **static** textures, baked once per planet via a
  fullscreen/compute pass — exactly the pattern of the cloud-noise bake
  (`cloudVolumeCompute.ts`, `warmCloudBakes`/`flushCloudBakes`). Rebake only when params
  change (rare).
- **v1 skips the per-frame LUTs** and ray-marches per pixel (correct; what Hillaire does
  for space views regardless). The per-frame LUTs are Phase-4 perf for ground views.
- Sky-View non-linear latitude mapping (concentrate texels at the horizon):
  `v = 0.5 + 0.5·sign(l)·sqrt(|l|/(π/2))`.

---

## 5. Render-pipeline integration

### 5.1 New pass module
`src/components/space/atmospherePass.ts` — singleton `setupAtmospherePass()` →
`{ scene, camera, updateUniforms, bakeLUTs, getActiveAtmosphere }`, registered like the
cloud pipeline. Per frame the CPU selects the **dominant atmosphere-bearing body**
(nearest / most in-view) and supplies, in **planet-centered km**:
camera position, planet center+radius, atmosphere height, sun direction (`uSunRel`),
`AtmosphereParams` uniforms, exposure, and the two static LUT textures.

### 5.2 Fragment shader (per pixel)
1. Reconstruct the view ray (existing `screenUV`/`uCameraMatrixWorld`/`uTanHalfFov`/`uAspect` recipe).
2. To planet-centered km space (precision).
3. Analytic intersect **planet sphere** and **atmosphere shell**.
4. **Ray hits planet:** ray-march single scattering over `[0, t_surface]` (Transmittance
   LUT for sun shadowing each step, Multi-scatter LUT for the multi-scatter term,
   Rayleigh+Mie+ozone, energy-conserving analytic integral). Output
   `sceneColor·T_rgb + Inscatter`. The surface color is what Pass 1 already shaded.
5. **Ray misses (sky):** march `[t_enter, t_exit]`; background = skybox/stars from
   `sceneColor`. Output `sceneColor·T + Inscatter` → blue day sky, reddened horizon, stars
   correctly washing out in daylight, glowing limb / full disc from space, planet-shadow
   twilight wedge.

Use **full RGB transmittance** (per-channel) so the surface reddens at sunset — this is
why we read→write rather than a single scalar-alpha blend.

### 5.3 Insertion in `SpaceRenderer.tsx`
```
Pass 1   scaled scene             → rt        (planets, skybox, stars; linear HDR)
Pass 1.5 ATMOSPHERE  (new)        rt → rtB    (RGB transmittance + in-scatter)
Pass 3   cloud composite          → rtB
Pass 4   local scene (clearDepth) → rtB
Post     RenderPipeline reads rtB → canvas
```
- Add one full-res `RGBA16F` + depth target `rtB` (depth needed for Pass 4's
  clearDepth+draw). `rt` becomes the scene-color *input* to the atmosphere pass; both are
  fully overwritten each frame (no frame-to-frame ping-pong needed).
- **Gate like clouds:** if no atmosphere-bearing body is within range, skip the pass and
  keep targeting `rt` directly → zero cost in deep space. (Mirror the `cloudsVisible`
  branch at `SpaceRenderer.tsx:457`.)
- Crossfade the pass on/off by altitude/distance (reuse the `uVolumetricBlend` idea) to
  avoid a pop at the near-body boundary.

### 5.4 Coupling to existing systems (Phases 2–3)
- **`SunLight.tsx` (intensity 30):** multiply light color/intensity by Transmittance LUT at
  the ship's altitude+sun-angle → ship & asteroids lit by warm sunset light.
- **`Star.tsx` (CORE_HDR 4096):** derive disk luminance from illuminance/solid-angle and
  multiply by transmittance (Frostbite §4) → horizon reddening/dimming for free; bigger
  disk auto-dims. Add limb darkening (Neckel a=(0.397,0.503,0.652)).
- **Sky ambient / IBL:** a `DistanceSkyLight`-style term so shadowed surfaces and the
  ship's dark side pick up sky color.
- **Clouds:** light the marcher with `sunIlluminance · transmittance(cloud alt, sun)` +
  sky ambient; apply AP at the cloud's transmittance-weighted mean depth (Frostbite Eq.
  21). Delete the ad-hoc cloud tints.

---

## 6. Photometry & exposure (the unified scale)

- One linear-luminance space for the scaled scene. `sunIlluminance` (per planet, RGB) is
  the top-of-atmosphere driver; surface = `albedo · sunIlluminance · transmittance · NdotL`
  (+ sky ambient); in-scatter is in the same units; sun disk = illuminance / solid-angle ·
  transmittance.
- A single global **`EXPOSURE`** constant scales luminance into tonemapper range before
  `AgX`/`Neutral` (`SpaceRenderer.tsx:318`). Calibrate once so a noon Earth view reads well,
  then verify sunset + space. Re-tune bloom threshold (currently 0.02,
  `SpaceRenderer.tsx:309`) against the new scale.
- No auto-exposure in v1; Phase 6 can add eye-adaptation for ground↔space.

---

## 7. Phased plan

Each phase is independently shippable and has an explicit on-device check.

- **Phase 0 — Scaffolding + units.** `AtmosphereParams`, `atmosphereData.ts`, `rtB` +
  pass skeleton (passthrough), exposure constant + unified-scale plumbing.
  *Verify: no visual change, no perf regression.*
- **Phase 1 — Core (sky + limb + sunset, Earth).** Transmittance + Multi-scatter bakes;
  per-pixel raymarch pass; delete fake `earth.ts:375–392` Rayleigh. Delivers blue day sky,
  reddened sunset, glowing limb & full disc from space, twilight planet shadow.
  *Verify on-device: ground / low orbit / space / sunrise; 120-fps cap held in space.*
- **Phase 2 — Aerial perspective + light coupling.** Surface AP; tint `SunLight` + `Star`
  by transmittance; sky-ambient IBL; add sampleable `rt.depthTexture` for object AP.
  Delivers haze + sunset light on terrain and the ship.
- **Phase 3 — Cloud ↔ atmosphere coupling.** Unify cloud lighting; AP over clouds; remove
  remaining ad-hoc cloud tints. *Highest integration risk — touches the tuned cloud
  pipeline; do last among the core phases.*
- **Phase 4 — Perf.** Sky-View + AP froxel LUTs; temporal reuse via existing STBN/Bayer/
  reconstruction infra; quality tiers wired to the settings menu.
  *Target: 120 fps at ground & orbit on M2 Pro.*
- **Phase 5 — Generalize.** ✅ DONE (2026-07-02). Physical descriptions live in `sol.json`
  (`massKg` + `atmosphere: { surfacePressureBar, surfaceTemperatureK, composition, haze* }`,
  star `luminositySun`); `deriveAtmosphere()` in `atmosphereData.ts` turns them into
  `AtmosphereParams` (replaces the `proceduralAtmosphere(knobs)` stub). Anchored so Earth's
  description reproduces Hillaire Table 1 to <0.2% (verified). Wired: Venus, Mars, Jupiter,
  Saturn, Uranus, Neptune (moons/Mercury airless). Additions: per-channel Mie
  (Mars' blue-absorbing dust) and a `gasAbsorption` channel — well-mixed molecular absorber
  on the Rayleigh profile (Frostbite fallback) for CH4's red absorption (teal/blue ice
  giants). Mars/Venus sphere-shader fake limb hazes removed (double-count); billboard tiers
  keep theirs (pass only runs at sphere LODs). Multi-body: registry + nearest-dominant +
  LUT re-bake on body switch were already in place (Phase 1); per-frame uniforms cover the
  rest. Remaining niceties (deferred): Sky-View/froxel altitude gates are Earth-tuned fixed
  km (could scale with the body's scale height); giants' shader band-haze may double-count
  subtly — re-tune by eye if it shows.
- **Phase 6 — Polish (optional).** Volumetric light shafts (terrain/cloud shadows
  in-scatter via raymarch + reproject); auto-exposure; eclipse / ring-shadow interplay.

---

## 8. Performance plan

- Atmosphere math is cheap; discipline = (a) reuse **STBN + Bayer + reconstruction** for
  the space-view raymarch rather than brute force, (b) add **Sky-View + AP LUTs** for
  ground views in Phase 4, (c) **gate the whole pass** out in deep space.
- Quality tiers (mobile-style scaling): LUT resolution + step counts behind settings.
- Profile with the same lens as clouds: this is fragment/fill-bound; watch full-screen
  space views (limb fills the frame).

---

## 9. Risks & gotchas (design around these up front)

- **Near-ground undersampling "blobs"** where exponential density spikes (Unreal): enough
  steps near the surface + jitter; consider distance-uniform step remap.
- **LUT↔raymarch transition hitch** at altitude (Unreal): crossfade like `uVolumetricBlend`;
  keep the transmittance LUT identical across tiers for a matching look.
- **Ozone in RGB** can produce instability: Frostbite's "ozone on the Rayleigh exp profile,
  added to Rayleigh extinction" is the safe fallback.
- **Float precision** at planetary scale: do all scattering in planet-centered km,
  camera-relative — never raw scaled units.
- **Double-counting:** delete the fake `earth.ts` Rayleigh + cloud tints when the real
  system lands; otherwise the look compounds.
- **Tone-map/bloom interaction:** the new luminance scale will shift bloom; re-tune once.
- **Two-scene split:** AP on the *ship* (local scene, composited last, different scale) is
  genuinely separate work — Phase 2, via a froxel sampled in the local pass.

---

## 10. Key files (new vs touched)

**New**
- `src/components/space/atmospherePass.ts` — singleton pass + LUT bakes + updateUniforms.
- `src/components/celestial/bodies/atmosphereData.ts` — params, presets, procedural derivation.
- (Phase 4) Sky-View + AP froxel bake modules.

**Touched**
- `src/components/space/SpaceRenderer.tsx` — `rtB`, insert Pass 1.5, gating, exposure.
- `src/components/celestial/types.ts` — `atmosphere?: AtmosphereParams` on `CelestialBodyConfig`.
- `src/components/celestial/bodies/earth.ts` — attach atmosphere; remove fake Rayleigh
  (375–392) / terminator tint (265–281) / billboard rim (398–427) as real terms replace them.
- `src/components/Star/SunLight.tsx`, `src/components/Star/Star.tsx` — transmittance tint
  (Phase 2).
- Cloud marcher (`earthClouds.ts` / `cloudFullscreenPass.ts`) — atmosphere-driven lighting (Phase 3).

---

## 11. References
- `docs/AtmosphereReferences/EpicGames.md` — Hillaire 2020 (core technique, LUT set, multi-scatter).
- `docs/AtmosphereReferences/Frostbite.md` — Hillaire 2016 (ozone, sun/limb photometry,
  energy-conserving integral, cloud coupling).
- `docs/AtmosphereReferences/HAL.md` — Bruneton 2008 (LUT parameterization foundations).
- `docs/AtmosphereReferences/UnrealEngine.md` — artist defaults + space-view gotchas.
- Open-source code: github.com/sebh/UnrealEngineSkyAtmosphere (Hillaire's reference impl).
