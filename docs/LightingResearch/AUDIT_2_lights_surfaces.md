# AUDIT 2 — Light sources & surface shading

Scope: every light in the scene, and every surface BRDF that consumes (or ignores) it.
Read in full: `src/components/Star/{SunLight,Star,AtmosphereSkyLight}.tsx`,
`src/components/celestial/{CelestialBody.tsx,types.ts,useFarLOD.ts}`,
`src/components/celestial/bodies/{earth,luna,venus,mars,mercury,jupiter,saturn,uranus,neptune,io,europa,ganymede,callisto,rockyFragment,atmosphereData,cloudCommon}.ts`,
`src/components/space/{StellarPoint.tsx,atmospherePass.ts}` (lighting sections),
`src/components/Skybox/MilkyWaySkybox.tsx`, `src/components/Spaceship.tsx`,
`src/components/models/ships/ShipOne.tsx`, `src/components/VFX/EngineExhaust.tsx`,
`src/components/Asteroids/{AsteroidField,AsteroidChunk,NearTierBatch,MidTierBatch,FarTierBatch,AsteroidImpostors}.tsx`,
`src/sim/asteroids/modelRegistry.ts`, `src/sim/systems/sol.json`, `src/sim/systemTypes.ts`,
`src/sim/{units,celestialConstants}.ts`, plus the three.js r183 code that actually executes
(`node_modules/three/build/three.webgpu.js`) and the GLB material JSON.

**Confidence labelling** (same convention as AUDIT 1):
- **[CODE]** — read directly from source, cited.
- **[COMMENT]** — a comment *claims* it; flagged where the code disagrees.
- **[MEASURED]** — I decoded the actual asset and computed the number.
- **[INFERRED]** — arithmetic on top of cited code; not observed at runtime.

---

## HEADLINE ANSWERS

1. **There is no radiometric connection between the lights and the planets at all.**
   The three.js lights live in `localScene`; the planets live in `scaledScene`; they are
   rendered by two separate `gl.render()` calls (`SpaceRenderer.tsx:707` vs `:1004`).
   On top of that, every celestial material sets `NodeMaterial.fragmentNode`, and three
   r183 skips `setupLighting()` entirely when `fragmentNode !== null`
   (`three.webgpu.js:20934` / `:20990-21003`). So the planets are **doubly** disconnected
   from `ambientLight`, `SunLight` and `AtmosphereSkyLight`. Those three lights illuminate
   *only* the ship and the near/mid asteroid tiers.

2. **The sun's brightness is constant everywhere in the solar system — three times over.**
   (a) `<SunLight />` is instantiated with no props (`Scene.tsx:131`), so `intensity = 30`
   forever (`SunLight.tsx:21`); the only per-frame update is *direction* and a
   transmittance *tint* (`SunLight.tsx:32-47`). (b) Every planet surface shader computes
   `albedo × f(N·L)` with **no irradiance factor whatsoever**. (c) `Star.tsx` emits a
   fixed `CORE_HDR = 4096` and, beyond ~1 AU, a fixed 60-px glow. Mercury and Neptune are
   lit identically despite a real 900:1 irradiance ratio.

3. **The single missing factor is `sunIlluminance / π`.** The atmosphere/clouds work on a
   physical illuminance scale (`SUN_ILLUM_GAME_1AU = 21.2`, Earth pinned to 20). The
   surfaces work on a bare `[0,1]` albedo scale. The ship works on `30/π = 9.55`. Three
   scales, one frame. `VENUS_ILLUM_TRIM = 0.025` and `CLOUD_SUN_SCALE = 0.45` are both
   hand-fitted bridges between them.

4. **The seam is one line:** `atmospherePass.ts:2039`
   ```ts
   return vec4(sceneColor.mul(T).add(apSample.rgb), 1);
   ```
   `sceneColor` is albedo-scale (≈0.09 for Earth's ground). `apSample.rgb` is
   `uSunIlluminance × (…)` — illuminance-scale (≈20 × scattering integrals). They are
   added. Nothing rescales either side.

5. **Earth has no Lambert cosine at all.** `earth.ts:269-271` replaces `N·L` with a
   sigmoid `1/(1+exp(-40·cosθ))`, which is ≥0.98 for every `cosθ > 0.1`. Earth's day disc
   is flat-lit to the terminator. Every other body uses `clamp(N·L, 0, 1)` (correct) or a
   light-wrap `k·N·L + (1-k)` (a fake).

6. **Nothing casts a real shadow-map shadow.** `renderer.shadowMap` is never touched, no
   light has `castShadow`, and `ShipOne`'s `castShadow`/`receiveShadow`
   (`ShipOne.tsx:33-34`) are inert. All seven shadowing effects in the game are analytic
   or texture-based (enumerated in §7).

7. **[MEASURED]** The body colour textures are brightness-normalised art, and nothing
   corrects for it. Against literature albedos the per-body error spans **0.37× (Luna, too
   bright) to 5.4× (Neptune, too dark)** — a 14.6× spread. Combined with the missing
   inverse-square this makes the solar system's relative brightness ordering arbitrary.

---

## 1. Every light in the scene

### 1.1 The complete inventory

`grep -rn "ambientLight|directionalLight|pointLight|spotLight|hemisphereLight|rectAreaLight|<Environment|useEnvironment|Lightformer"` over `src/` + `app/` returns exactly four
light instantiations. There is **no** IBL / env-map of any kind. **[CODE]**

| # | Light | Site | Intensity | three r183 semantics | Scene | Physically motivated? |
|---|---|---|---|---|---|---|
| 1 | `ambientLight` | `Scene.tsx:130` | `0.5`, constant | `context.irradiance += color×intensity` (`three.webgpu.js:52423`) — irradiance, **no cosine** | `localScene` | **No.** Pure eyeballed lift. |
| 2 | `directionalLight` (SunLight) | `Scene.tsx:131`, `SunLight.tsx:54-58` | `30`, constant | `irradiance = max(0,N·L) × color×intensity` (`three.webgpu.js:44601`, `:52455-52461`) — illuminance at normal incidence | `localScene` | **Direction: yes. Magnitude: no.** |
| 3 | `hemisphereLight` (AtmosphereSkyLight) | `Scene.tsx:132`, `AtmosphereSkyLight.tsx:45` | `0` → `skyIntensity` ∈ [0, 2.5] | `irradiance = mix(ground, sky, 0.5+0.5·N·up) × intensity` (`three.webgpu.js:52527-52533`) | `localScene` | **Partly.** Its *shape* (density × day-factor) and *tint* (Rayleigh coefficients, `groundAlbedo`) come from the physical atmosphere; its *magnitude* is a hand constant. |
| 4 | `pointLight` ×N (engine nozzles) | `EngineExhaust.tsx:189-195` | `intensity × 2.0`, `distance 6.0`, `decay 2` | candela-like, inverse-square with cutoff | `localScene` | **No.** Colour is `THREE.Color(5.0, 7.0, 10.0)` (`EngineExhaust.tsx:76`) — HDR ×10, pure art direction. |

Two *emitters* that are not `Light` objects but function as light in the image:

| Emitter | Site | Value | Notes |
|---|---|---|---|
| Sun disc + glow billboard | `Star.tsx:80,144,149` | disc `4096`, inner glow `1228.8`, outer glow `8.0` | Additive, unlit. See §5. |
| Milky Way skybox | `MilkyWaySkybox.tsx:34-39` | `MeshBasicMaterial`, `toneMapped: false` | Unlit; the sRGB-decoded texture *is* the radiance. Sets the scene's effective black level. See §6.4. |
| Ship hull emissive | `ShipOne.glb` material `Material.003` | `emissiveFactor [1,1,1]`, `KHR_materials_emissive_strength: 3.3372` | **[MEASURED from the GLB JSON]** three-stdlib maps this to `emissiveIntensity = 3.3372` (`three-stdlib/loaders/GLTFLoader.js:382-384`). Emissive panels output up to 3.34 linear — above the tonemapper's white point, so they clip white. |

### 1.2 Does the sun's intensity vary with distance from the sun? **No. Definitively.**

Following the props from `Scene.tsx`:

```tsx
// Scene.tsx:131 — no props at all
<SunLight />
```
```tsx
// SunLight.tsx:18-22
const SunLight = ({
  sunPositionKm = STAR_POSITION_KM,
  intensity = 30,       // ← the live value, forever
  color = "white",
}: SunLightProps) => {
```

`localContent` is `useMemo(…, [])` (`Scene.tsx:127-147`), so this element is created once
and the `intensity` prop is never re-applied — the comment at `SunLight.tsx:50-52` says so
explicitly and is **accurate**. The `useFrame` at `SunLight.tsx:28-48` writes only:

- `ref.current.position` ← normalised ship→sun direction (`:32-37`). Correct: for a
  `DirectionalLight` three uses `lightTargetDirection(light)` = `normalize(position −
  target.position)` and `target` defaults to the origin of the light's parent, so a unit
  vector is the right thing to store.
- `ref.current.color` ← `baseColor × lighting.sunTransmittance` (`:44`). `sunTransmittance`
  is **dimensionless ∈[0,1]** (`atmospherePass.ts:851-852`, `:998-1002`). It can only
  *darken*.

So `intensity` is 30 at Mercury and 30 at Neptune. The ship is lit identically at 0.39 AU
and 30 AU. **[CODE]**

### 1.3 Is `intensity = 30` in physically-correct units?

**It is arbitrary / display-referred.** Reasoning:

- `useLegacyLights` / `physicallyCorrectLights` **do not exist in three r183** — grep for
  `useLegacyLights` in `three.core.js` returns nothing (removed in r165). There is no mode
  switch; three always uses the "physically correct" convention. **[CODE]**
- That convention for a `DirectionalLight` is: `intensity` is the **illuminance in lux** at
  normal incidence. three applies **no** unit conversion — `AnalyticLightNode.update()`
  does `this.color.copy(light.color).multiplyScalar(light.intensity)`
  (`three.webgpu.js:44601`), and `DirectionalLightNode.setupDirect()` hands that straight to
  the lighting model (`:52455-52461`), which computes
  `irradiance = clamp(N·L) × lightColor`, then
  `directDiffuse += irradiance × BRDF_Lambert(diffuse)` where
  `BRDF_Lambert = diffuseColor × (1/π)` (`:23252-23256`, `:27834`). **[CODE]**
- Therefore outgoing diffuse radiance = `albedo × intensity/π × N·L` =
  `albedo × 9.549 × N·L`.
- The real solar constant at 1 AU is ≈127 000 lux. `30` is **~4200× too small** to be lux.
  It is instead chosen so that a mid-albedo hull lands at ≈1 linear ⇒ near-white after
  tonemapping. The code says so: *"the hull is lit by an intensity-30 sun through
  bloom+tonemapping, so it clips near white"* (`atmospherePass.ts:1059-1061`). **[COMMENT,
  and the arithmetic agrees]**
- `renderer.toneMappingExposure` is never written (grep: zero hits in `src/`), so the
  tonemapper's exposure node sits at 1.0 (`three.webgpu.js:9601`, `:9670-9690`). There is no
  exposure stage that could reconcile 30 with 127 000. **[CODE]**

**The quantitative inconsistency, stated exactly:** `30` and `SUN_ILLUM_GAME_1AU = 21.2`
(`atmosphereData.ts:69`, Earth pinned to `20` at `:252`) are *the same physical quantity* —
top-of-atmosphere solar illuminance near 1 AU — written twice with different values.
`30/20 = 1.5`. **[INFERRED]**

### 1.4 The three luminance scales, side by side

For a Lambertian surface of albedo *a* at normal incidence, in the same frame:

| Subsystem | Outgoing radiance | At *a* = 0.3 | Site |
|---|---|---|---|
| Ship / near-mid asteroids (three.js light) | `a × 30/π` = `a × 9.549` | **2.86** | `three.webgpu.js:23252`, `SunLight.tsx:21` |
| Planet surface (custom `fragmentNode`) | `a × 1` | **0.30** | e.g. `mercury.ts:59`, `earth.ts:381` |
| Earth cloud deck | `20 × T × 0.45 ≈ 9` (independent of *a*) | **≈9** | `cloudCommon.ts:103,141` |
| Atmosphere in-scatter | `20 × (scattering integrals)` | order 1–5 | `atmospherePass.ts:1578` |
| Physically consistent value (Earth) | `a × 20/π` = `a × 6.366` | **1.91** | — |

**The ship is 9.55× brighter than a planet surface of the same albedo.** The planet surface
is 6.37× *darker* than the atmosphere scale wants. The clouds are ~30× the ground beneath
them where physics wants ~5–7×. Every one of these is exactly a missing `E/π`. **[INFERRED
— arithmetic on cited code]**

---

## 2. `ambientLight intensity={0.5}` — what it actually does

### 2.1 It does **nothing** to any planet's dark side

Two independent reasons, either sufficient:

1. **Wrong scene.** `<ambientLight>` is inside `localContent` (`Scene.tsx:127-147`), which
   is portalled to `localScene` (`SpaceRenderer.tsx:1072`). Planets are in `scaledContent`
   → `scaledScene` (`:1071`). The two are drawn by separate `gl.render()` calls
   (`:707` scaled, `:1004` local). A light in one scene cannot reach the other. **[CODE]**
2. **Wrong material.** Even in the same scene it would be ignored: `CelestialBody.tsx:117`
   and `:128` set `m.fragmentNode = config.buildFragmentNode(...)`, and three r183 does
   ```js
   if ( this.fragmentNode === null ) {   // three.webgpu.js:20934
     this.setupDiffuseColor( builder );
     this.setupVariants( builder );
     const outgoingLightNode = this.setupLighting( builder );  // ← never reached
     …
   } else {
     resultNode = this.setupOutput( builder, vec4( this.fragmentNode ) );  // :20996-21004
   }
   ```
   **[CODE]** The same applies to `Star.tsx:127`, `useFarLOD.ts:84`, `StellarPoint.tsx:170`,
   `FarTierBatch.tsx:125`, `AsteroidImpostors.tsx:137`, and every `atmospherePass` /
   `cloudFullscreenPass` quad.

So the "night side is not black" question splits cleanly:

- **Planets:** night-side brightness comes from body-specific shader terms only —
  Earth's city lights, Luna's earthshine constant, and the fake light-wrap `+k` offsets.
  See §6.
- **Ship + near/mid asteroids:** yes, `ambientLight 0.5` is exactly why their dark sides
  are not black.

### 2.2 Quantifying it for the ship / asteroids

`AmbientLightNode.setup()` adds `color × intensity` **directly to `context.irradiance`**
with no cosine (`three.webgpu.js:52423`); the physical model then does
`indirectDiffuse += irradiance × albedo/π` (`:27847`).

| Term | Irradiance | Radiance at *a* = 0.5 | Ratio to sunlit peak |
|---|---|---|---|
| Sun (normal incidence) | 30 | 4.775 | 1 |
| Ambient (all directions) | 0.5 | 0.0796 | **1/60 = 1.67% = −5.9 stops** |
| Atmosphere sky fill (max) | 2.5 | 0.398 | 1/12 = 8.3% |

**Through the default tonemapper** (Neutral / Khronos PBR Neutral, since
`settings.toneMapping` defaults to `false` — `store.ts:30`; exposure 1.0):

- Sunlit 4.775 → ≈0.986 → sRGB ≈**0.994** (clipped white).
- Ambient-only 0.0796 → below `startCompression`, minus the 0.04 toe offset → 0.0396 →
  sRGB ≈**0.22**.

So the ship's unlit side reads as a **~22 % mid-grey**, not black. That is a very visible
"flat CG lift" and it is the single biggest reason the ship never looks like it is in
vacuum. **[INFERRED — Neutral's formula, exposure 1, applied by hand]**

Real vacuum has no ambient. A physically motivated replacement would be the
`AtmosphereSkyLight` path (already exists) plus star/planet-shine, i.e. `ambientLight`
should be ~0 in deep space.

### 2.3 Sky fill: physical in shape, arbitrary in magnitude

`atmospherePass.ts:1037`:
```ts
_lighting.skyIntensity = SKY_AMBIENT_MAX_INTENSITY * densityAtCam * dayFactor;
```
- `SKY_AMBIENT_MAX_INTENSITY = 2.5` (`:843`), with the comment *"Tuning (all in SunLight's
  intensity scale…)"* (`:835`) — so it is 2.5 against the key light's 30, i.e. **8.3 % of
  the key**. On Earth's ground under clear sky the diffuse-to-direct horizontal
  illuminance ratio is ~15–20 %, and in a shadow the sky is essentially the *only* light.
  8.3 % is low, and it is a constant rather than a hemispherical irradiance integral. The
  comment admits this: *"a deliberately simple analytic stand-in for a proper hemispherical
  irradiance (LUT-based; Phase 4)"* (`:831-832`). **[CODE + COMMENT]**
- `densityAtCam = exp(-(r−Rg)/H_rayleigh)` (`:1031`) — physical shape.
- `skyColor` from `params.rayleighScattering` desaturated by `SKY_TINT_SATURATION = 0.7`
  (`:844`, `:1040-1046`) — physical hue, art-directed saturation.
- `groundColor` = `params.groundAlbedo` (`:1048-1049`) — from `sol.json`. Physical.
- **It never registers for an airless body.** `CelestialBody.tsx:349` gates registration on
  `if (config.atmosphere)`, and only Venus/Earth/Mars/Jupiter/Saturn/Uranus/Neptune have
  one. So flying to Luna, Mercury, Io, Europa, Ganymede or Callisto gives
  `skyIntensity = 0` and **no planet-shine at all** — a ship 10 km above Europa's icy
  (albedo 0.67) day side receives zero bounce. **[CODE]**

---

## 3. Per-body albedo / texture / BRDF inventory

Common structure: every body's material is `new NodeMaterial()` with `side = FrontSide`
and `fragmentNode` fully replaced (`CelestialBody.tsx:113-133`). The only light input is
`uSunRel` = body-centre→sun vector in scaled world units
(`CelestialBody.tsx:252`, `:303-308`). Nothing is per-fragment-sun-position; the resulting
direction error is `R/d` ≈ 4×10⁻⁵ rad for Earth — negligible, no issue.

Textures are loaded by `useDeferredKTX2` (`src/hooks/useDeferredKTX2.ts`) which sets **no
`colorSpace`** — it relies on the KTX2 DFD written by `scripts/convert-to-ktx2.sh`. So
`texture(colorTex, uv).rgb` is linear after the sRGB decode. That part is correct.
**[CODE]**

### 3.1 The table

`p_lit` = literature geometric albedo. `A_lit ≈ 1.5·p_lit` (exact for a Lambert sphere) is
what a *normal-albedo map* should average to. `Y_tex` is the cosine-latitude-weighted mean
**linear** luminance I decoded from the shipped 2k texture. **[MEASURED — decoded the
`.webp` sources with a hand-rolled PNG/sips path, sRGB→linear, sin(lat) weighting]**

| Body | Texture(s) | BRDF in code | Site | `p_lit` | `A_lit` | `Y_tex` | `A_lit/Y_tex` |
|---|---|---|---|---|---|---|---|
| **Mercury** | `8k/2k_mercury` | `clamp(N·L,0,1)` + Blinn surge `pow(N·H,3)×0.12` + limb `pow(V·N,0.25)` | `mercury.ts:47,53,57,59` | 0.142 | 0.213 | **0.229** | 0.93 ✔ |
| **Venus** | `4k/2k_venus` | `clamp(0.75·N·L + 0.25, 0, 1)` — light-wrap only, no view term | `venus.ts:55,57` | 0.689 | 1.03 | **0.557** | 1.86 |
| **Earth** | `earth_day_8k/2k`, `earth_night`, `earth_clouds`, `earth_normal`, `earth_specular` | **sigmoid**, not `N·L`; + TBN normal relief; + Blinn ocean spec; + Schlick fresnel; + view limb-darkening on land | `earth.ts:269-271,300-317,407-433` | 0.434 | 0.65 | **0.086** | 7.6 (see note) |
| **Luna** | `luna_color_8k/2k` + `luna_displacement` (also a `positionNode` displacement, 10.786 km) | `clamp(N·L,0,1)` + Sobel-bump normal + surge `pow(N·H,3)×0.12` + earthshine `0.002` | `luna.ts:92-108,113-122` | 0.12 | 0.18 | **0.482** | **0.37** ✗ |
| **Mars** | `8k/2k_mars` | `clamp(0.85·N·L + 0.15, 0, 1)` + surge `pow(N·H,4)×0.08` + warm-tint band ×0.2 | `mars.ts:63,74,77,80` | 0.170 | 0.255 | **0.183** | 1.39 |
| **Jupiter** | `8k/2k_jupiter` | `clamp(0.9·N·L + 0.1)` × `pow(V·N,0.4)` + haze `(0.7,0.55,0.35)×0.06` + limb desat 0.2 | `jupiter.ts:56,61,66-77` | 0.538 | 0.81 | **0.411** | 1.97 |
| **Saturn** | `8k/2k_saturn` + `_ring_alpha` | `clamp(0.85·N·L + 0.15)` × `pow(V·N,0.4)` + haze ×0.08 + desat 0.2 | `saturn.ts:153,158,164,167-170` | 0.499 | 0.75 | **0.616** | 1.22 ✔ |
| Saturn **rings** | `8k/2k_saturn_ring_alpha` | `|sunDir.y|×0.7 + 0.3`, planet-shadow mask → 0.05 | `saturn.ts:108-129` | — | — | — | — |
| **Uranus** | `8k/2k_uranus` | `clamp(0.8·N·L + 0.2)` × `pow(V·N,0.35)` + haze ×0.06 + desat 0.15 | `uranus.ts:55,60,66,69-72` | 0.488 | 0.73 | **0.565** | 1.29 |
| **Neptune** | `2k_neptune` (**no near tier** — `lod: { far: 12_000_000 }`, `near: undefined`) | `clamp(0.8·N·L + 0.2)` × `pow(V·N,0.35)` + haze ×0.08 | `neptune.ts:55,60,66,114-116` | 0.442 | 0.66 | **0.123** | **5.4** ✗ |
| **Io** | `4k/2k_io` | shared `buildRockyFragmentNode`, surge 0.10 | `io.ts:25`, `rockyFragment.ts:40,46,50,52` | 0.63 | 0.945 | **0.346** | 2.73 ✗ |
| **Europa** | `8k/2k_europa` | ditto | `europa.ts:25` | 0.67 | 1.005 | **0.315** | 3.19 ✗ |
| **Ganymede** | `8k/2k_ganymede` | ditto | `ganymede.ts:25` | 0.43 | 0.645 | **0.423** | 1.52 |
| **Callisto** | `8k/2k_callisto` | ditto | `callisto.ts:25` | 0.22 | 0.33 | **0.312** | 1.06 ✔ |

*Earth note:* the `earth_day` map is deliberately cloud-free (BMNG), and clouds are a
separate renderable — so `p_lit = 0.434` (which includes clouds) is not the right target.
Against a cloud-free Earth (Bond ≈0.10–0.15 ⇒ `A` ≈0.15–0.22) the texture's 0.086 is
~1.9× dark, i.e. in family with the others.

*Luna note:* `A_lit = 1.5p` is generous for regolith (opposition surge inflates *p*).
Lunar *normal* albedo is 0.07 (maria) – 0.15 (highlands), so 0.482 is **3.2–6.9× too
bright**. This is the single worst albedo error in the game and it is exactly the failure
mode the brief predicted: the SSS/LRO colour map is contrast-stretched for human viewing,
not calibrated.

### 3.2 Does anything correct for brightness-normalised source art? **No.**

- Grep `geometricAlbedo` over `src/`: 15 hits, **all** of them either the type definition
  (`types.ts:56`), the `StellarPoint` prop plumbing (`CelestialBody.tsx:461`,
  `StellarPoint.tsx:97,112,251`), or the per-body literal in the `stellarPoint:` config
  block. **Not one of them reaches a sphere or billboard material.** The real measured
  albedos exist in the repo and are used *only* for the sub-8-pixel point-source flux.
  **[CODE]**
- `atmosphere.groundAlbedo` from `sol.json` (`systemTypes.ts:232`,
  `atmosphereData.ts:227`) is consumed only by the atmosphere's multi-scatter ground
  bounce (`atmospherePass.ts:2116`) and the hemisphere light's `groundColor` (`:1048`). So
  Earth's ground has **two independent albedos**: `[0.3,0.3,0.3]` (the default, since
  `sol.json` gives Earth no `groundAlbedo`) for the scattering, and the 0.086-mean texture
  for the actual pixels — a 3.5× disagreement about the same surface. **[CODE +
  MEASURED]**
- No texture mean-normalisation, no `albedoScale` uniform, no `bondAlbedo` field anywhere
  in `systemTypes.ts` (`CelestialBodyDef` at `:236-253` has no albedo field at all).

### 3.3 The `stellarPoint.geometricAlbedo` values are literature-accurate — with one outlier

Mercury 0.142, Venus 0.689, Earth 0.434, Mars 0.170, Jupiter 0.538, Saturn 0.499, Uranus
0.488, Neptune 0.442, Io 0.63, Europa 0.67, Ganymede 0.43, Callisto 0.22 — all match
published geometric albedos to 3 significant figures. **[CODE]**

**`luna.ts:151` is `geometricAlbedo: 0.0036`.** The Moon's geometric albedo is **0.12**.
This is 33× low, i.e. the Moon's point source is ~3.8 magnitudes too faint. Given every
other value is textbook-exact, this reads as a typo or a leftover hand-fudge, not a
deliberate choice. **[CODE — high confidence anomaly]**

### 3.4 The far billboards use "albedo" as radiance

`useFarLOD.ts:43` (default) and each body's custom billboard fragment do
`col = albedo × sunDot`. For a Lambert surface `L = a·E/π`, so writing `L = a` asserts
`E = π` — i.e. **every billboard is implicitly lit by a fixed illuminance of π regardless
of heliocentric distance.** Neptune's billboard is as bright as Mercury's. **[INFERRED]**

The billboard albedo constants are art-direction, not measurement, and two are outright
non-physical:

| Body | Billboard albedo | Site | Note |
|---|---|---|---|
| Earth | `vec3(0.38,0.42,0.80).mul(2.0)` = up to **1.6** | `earth.ts:477` | An albedo > 1. |
| Mars rim haze | `vec3(12.0, 0.1, 0.05)` × 0.2 | `mars.ts:109-110` | A "colour" with a 12.0 red channel — 12 HDR against a ~0.6 disc. |
| Neptune | `(0.05, 0.12, 0.85)` | `neptune.ts:31` | r/b = 0.06; real Neptune r/b ≈ 0.5. |
| Venus | `(0.70, 0.52, 0.28)` | `venus.ts:26` | Venus's cloud tops are near-neutral cream; b/r = 0.4 here. |
| Luna | `(0.44, 0.42, 0.40)` | `luna.ts:32` | ~3–4× real lunar reflectance, same error as the texture. |
| Mercury | `(0.35, 0.33, 0.30)` | `mercury.ts:75` | ~2.5× real. |
| Mars | `(0.6, 0.3, 0.15)` | `mars.ts:32` | red 3.5× real. |
| Io | `(0.36,0.26,0.14)` / Europa `(0.55,0.52,0.48)` / Ganymede `(0.45,0.43,0.40)` / Callisto `(0.30,0.28,0.25)` | `io.ts:21`, `europa.ts:21`, `ganymede.ts:21`, `callisto.ts:21` | Io/Europa too dark, the other two about right. |

### 3.5 Ship & asteroids

- **Ship**: `ShipOne.tsx:36` uses the GLB's own `MeshStandardMaterial` unmodified —
  `baseColorTexture`, `metallicRoughnessTexture`, `normalTexture`, `occlusionTexture`,
  `emissiveFactor [1,1,1]` with `emissiveStrength 3.3372`. It is the **only** properly
  lit PBR surface in the game (three's `PhysicalLightingModel`, GGX + Lambert). It
  responds to lights 1–4. **[MEASURED from GLB JSON]**
  - `occlusionTexture` needs a second UV set to become `aoMap`; whether the GLB has one is
    **unverified**.
- **Asteroids, near tier** (`AsteroidChunk.tsx:182`, `NearTierBatch.tsx:82`): the GLB's
  `MeshStandardMaterial` via `modelRegistry.ts:86`. Also correctly lit PBR.
  `asteroid01.glb` carries an `emissiveTexture` with **no** `emissiveFactor` → glTF default
  `[0,0,0]` → the map is loaded, uploaded and multiplied by black. Dead VRAM. **[MEASURED
  from GLB JSON]**
- **Asteroids, mid tier** (`MidTierBatch.tsx:79`): the LOD1 GLB material — per `CLAUDE.md`
  a flat grey `baseColor 0.15/0.14/0.13`, `roughness 1.0`, `metallic 0.0`. That is a
  plausible S-type albedo. **[COMMENT — not verified against the LOD1 GLBs]**
- **Asteroids, far tier + impostors** (`FarTierBatch.tsx:149-151`,
  `AsteroidImpostors.tsx:166-170`): `NodeMaterial` + `fragmentNode`, so **unlit**:
  ```ts
  const sunDot = max(float(0), dot(worldNormal, uSunDir));
  const shade  = float(0.15).add(float(8.0).mul(sunDot));
  const color  = vec3(0.1, 0.1, 0.1).mul(shade);
  ```
  Peak radiance `0.1 × 8.15 = 0.815`. The near/mid tier at albedo 0.15 peaks at
  `0.15 × 9.549 = 1.43`. **The far tier is 1.76× (0.8 stop) darker than the near tier at
  full sun** — a LOD-tier brightness step. The `8.0` is clearly an eyeball at three's
  `30/π = 9.55`, off by 16 %. The `0.15` ambient floor gives 0.015 vs the three.js ambient
  path's `0.5/π × 0.15 = 0.0239` — those two happen to match within 40 %. **[INFERRED]**

---

## 4. The seam between `sunIlluminance` and the three.js light

**Answer: they never meet in a shader. They meet in exactly three places, and each one
passes only *dimensionless* information across the boundary — never magnitude.**

### Crossing 1 — atmosphere → key-light *tint* (the only light↔atmosphere coupling)

```ts
// SunLight.tsx:42-47
const lighting = getAtmosphereLighting();
if (lighting.active) {
  ref.current.color.copy(baseColor).multiply(lighting.sunTransmittance);
} else {
  ref.current.color.copy(baseColor);
}
```
`sunTransmittance ∈ [0,1]³` (`atmospherePass.ts:851-852`). It can redden and it can black
out (planet shadow, `:978-980`; ring shadow, `:1009-1026`; cloud shadow, `:1058-1067`). It
can never brighten, and it carries no illuminance. `intensity` stays 30.

### Crossing 2 — atmosphere → hemisphere-light *magnitude*, via a hand constant

```ts
// atmospherePass.ts:1037
_lighting.skyIntensity = SKY_AMBIENT_MAX_INTENSITY * densityAtCam * dayFactor;
```
`SKY_AMBIENT_MAX_INTENSITY = 2.5` is declared under the header
*"Tuning (all in SunLight's intensity scale / cosine-of-zenith units)"* (`:835`).
So the sky fill is expressed in the **three.js light scale**, while the sky it represents
is computed in the **illuminance scale**. The conversion factor between them is the
literal `2.5`. **[CODE + COMMENT]**

### Crossing 3 — atmosphere → surface *tint*, explicitly magnitude-neutralised

Earth is the only body that reads any atmosphere quantity into its surface shader, and it
divides the magnitude straight back out:

```ts
// earth.ts:263  (inside sunTAt())
return tA.rgb.div(tZen.rgb.max(float(1e-4))).clamp(0, 1).mul(float(SURFACE_SUN_SCALE));
```
`SURFACE_SUN_SCALE = 1.0` (`earth.ts:90`). The comment is explicit and **accurate**:
*"NORMALISED by the zenith transmittance so noon brightness is unchanged (only the angular
reddening shows)"* (`earth.ts:82-87`). And then:

```ts
// earth.ts:381 — THE surface composite. No illuminance anywhere.
const col = mix(nightCol.mul(nightMask), dayCol.mul(sunT), dayAmount).toVar();
```

`dayCol` is the raw linear texture (≤1). `sunT` is ≤1. `dayAmount` is ≤1. **Earth's ground
radiance can never exceed 1, and averages 0.086.** No other body reads the atmosphere at
all — Venus/Mars/Jupiter/Saturn/Uranus/Neptune surfaces are `albedo × f(N·L)`, full stop.

### The actual radiometric seam — one line

```ts
// atmospherePass.ts:2030-2039  (applyFragment, full-res)
const sceneColor = texture(inputTexture, screenUV).rgb;     // albedo scale, ≤1
const apSample   = texture(apRT.texture, screenUV).toVar();  // rgb = L, a = Tmean
const T = AP_SPECTRAL_TRANSMITTANCE ? powVec3(apSample.a.max(0), uTSpectralK) : vec3(apSample.a);
return vec4(sceneColor.mul(T).add(apSample.rgb), 1);
```

and `L` itself:
```ts
// atmospherePass.ts:1578-1580  (shadowedSunScatter)
return uSunIlluminance.mul(
  earthShadow.mul(Tsun).mul(phaseScat).add(msContrib),
);
```
with `uSunIlluminance.value.set(p.sunIlluminance…)` at `:2117` and
`sunIlluminance = 21.2·L☉/d_AU²` at `atmosphereData.ts:204-205` (Earth pinned to 20 at
`:252`).

**Consequence [INFERRED]:** Earth's ground contributes `0.086 × T` while the in-scatter
adds an order-1-to-5 term on the illuminance scale. Viewed from orbit, an Earth pixel is
**mostly sky**, and the ground texture is a faint modulation on top. This is why the
terminator work, the ocean glint and the land/water contrast all read as washed out — they
are being added at 1/6.4 of the scale they should be. It is also the *same* defect that
`VENUS_ILLUM_TRIM = 0.025` (`atmosphereData.ts:271`) papers over from the other direction,
and the comment there diagnoses it correctly: *"the game's surfaces shade on a ~[0,1]
albedo scale while atmosphere in-scatter lives on the sunIlluminance scale"*
(`atmosphereData.ts:265-267`). **[COMMENT — and it is right]**

`ATMOSPHERE_EXPOSURE = 1.0` (`atmosphereData.ts:37`) is the placeholder for the fix and is
referenced by nothing (grep: only its own declaration and AUDIT 1).

**The minimal correct fix, stated as a formula:** every surface shader should return
`albedo × sunIlluminance/π × f(N·L)` instead of `albedo × f(N·L)`, and `SunLight.intensity`
should be `sunIlluminance(d)` recomputed per frame from the ship's heliocentric distance.
That single change removes the need for `VENUS_ILLUM_TRIM`, `SKY_AMBIENT_MAX_INTENSITY`'s
2.5, `CLOUD_SUN_SCALE`'s 0.45, and the far-asteroid `8.0`.

---

## 5. `Star.tsx` — the sun disc

### 5.1 Construction

A single screen-aligned billboard at all distances (`Star.tsx:106-119`), `AdditiveBlending`,
`depthWrite = false`, explicit log-depth via `depthNode` (`:123-124`).

Per-frame sizing (`:168-196`):
```ts
const physicalHalf = RADIUS * GLOW_PAD;                    // 696.34 × 8 = 5570.7 scaled units
const minAngle = (MIN_SCREEN_PX / screenH) * fovRad;       // 60 px
const minHalf  = distScaled * Math.tan(minAngle * 0.5);
const halfExtent = Math.max(physicalHalf, minHalf);
uScale.value = halfExtent * 2;
uCoreRatio.value = RADIUS / halfExtent;
```

Fragment (`:127-161`): `disc = smoothstep(…) × 4096`; `innerGlow = pow(falloff, 2.5) ×
1228.8` over `innerR = 0.35` of the billboard; `outerGlow = pow(1−dist, 3.5) × 8.0` to the
billboard edge; colour `(1.0, 0.95, 0.9)` (a reasonable G2V chromaticity); `alpha =
clamp(brightness × 0.5, 0, 1)`.

### 5.2 Angular size: **correct**

With R3F's default `fov = 50`… actually R3F constructs `new PerspectiveCamera(75, 0, 0.1,
1000)` (`@react-three/fiber/dist/events-*.js`) and `Scene.tsx:152` overrides only
`near`/`far`, so **fov = 75** (1.309 rad). **[CODE]**

At 1 AU (`distScaled = 1.496e5`): `minHalf = 1.496e5 × tan(0.03364) = 5033`;
`physicalHalf = 5570.7` → physical wins, `coreRatio = 0.125`. Disc angular diameter =
`2 × 696.34 / 1.496e5 = 9.31e-3 rad = 0.533°`. **The real value is 0.533°.** ✔

At 30 AU: `minHalf = 1.634e5` ≫ `physicalHalf`, so the billboard clamps to 60 px and
`coreRatio = 696.34/1.634e5 = 0.00426` → disc = 0.0178°. Real value at 30.07 AU = 0.0177°.
✔ The `coreRatio` bookkeeping is right: **the disc's angular size is correct at every
distance.** **[INFERRED — arithmetic on cited code]**

### 5.3 Disc radiance: **correct in principle, wrong in the tail**

`CORE_HDR = 4096` is constant, which is the physically right call — the surface radiance of
a resolved disc *is* distance-invariant; only the solid angle changes. Good.

But the disc is sub-pixel beyond ~2 AU. At 30 AU the disc radius is `0.00426 × 30 px =
0.13 px`. With no analytic coverage term, the rasterizer simply misses it most frames, so
the disc's flux is lost rather than concentrated. The `smoothstep` edge
(`:133-137`, ±15 % of `coreRatio`) is far narrower than a pixel there. **[INFERRED]**

### 5.4 The glow does **not** obey inverse-square — a real defect

Both glow lobes are parameterised in **billboard-normalised** coordinates
(`innerR = 0.35`, `outerFalloff = 1 − dist`), and beyond ~1 AU the billboard is pinned to
`MIN_SCREEN_PX = 60`. Therefore:

- The inner glow occupies a **fixed 10.5-px radius** at a **fixed peak 1228.8** at every
  distance from 1 AU to Neptune.
- The outer glow occupies a **fixed 30-px radius** at a fixed peak 8.0.

Total flux from the sun's glow is **distance-invariant**. Physically it should drop ~900×
from Earth to Neptune. **The sun looks equally blinding from Neptune as from Earth.**
`MIN_SCREEN_PX` was added for rasterization stability (comment at `:74-76`) and the fix is
to compensate the radiance for the enlarged solid angle
(`× (physicalHalf/halfExtent)²`), which the code does not do. **[CODE + INFERRED]**

### 5.5 No limb darkening

The disc is a flat `smoothstep` — no `1 − u(1 − μ)` law. Real solar limb darkening at
550 nm is ≈0.3 edge/centre. Absent. **[CODE]**

### 5.6 Bloom interaction — and a stale comment

`SpaceRenderer.tsx:516`: `bloom(sceneTexture, 0.02, 0, 1)` — strength 0.02, radius 0,
threshold 1. So 4096 contributes ~82 to the bloom buffer. But **`settings.bloom` defaults
to `false`** (`store.ts:29`), so out of the box there is *no* bloom, and 4096 simply clips
to white in the tonemapper.

The header comment at `Star.tsx:63-64` says:

> *"HDR values are moderate (~60) so bloom adds a natural halo without the instability that
> extreme values (4096) cause at low pixel counts."*

`CORE_HDR` **is 4096** (`Star.tsx:80`). The comment describes the value it was changed
*away from*, and names 4096 as the thing to avoid. **Stale comment — flag it.**
`:78-79` then re-describes 4096 as *"moderate enough that sub-pixel drift doesn't cause
visible bloom flicker"*, contradicting `:63-64`. **[COMMENT vs CODE]**

### 5.7 `StellarPoint` — correct physics, then destroyed

`StellarPoint.tsx:238-255` implements the Lambert-sphere phase function, geometric albedo,
and inverse-square on **both** legs (`d_sun²·d_cam²`) — genuinely the most physically
correct lighting code in the repo. Then:

- `hdr = (flux / JUPITER_REF_FLUX) × REFERENCE_HDR` with `REFERENCE_HDR = 12`
  (`:67`, `:255`), clamped to 500 (`:271`).
- With bloom off, the Neutral tonemapper maps 12 → 0.995 and 500 → 0.99988, i.e. sRGB
  **254 vs 255**. Two code values for a 40× flux range.
- Worse, `alpha` does **not** depend on `uBrightness`:
  ```ts
  // StellarPoint.tsx:183-190
  const intensity = core.add(halo).mul(uBrightness);
  const col = uColor.mul(intensity);
  const alpha = clamp(core.add(halo.mul(2.0)), 0, 1);   // ← brightness-independent
  ```
  With `MIN_SCREEN_PX = 6` (`:62`) the footprint is also distance-independent. So **every
  stellar point renders as the same 6-px dot** and the entire flux computation collapses.
  **[CODE + INFERRED]**
- **Likely visible bug:** `transparent = false`, `alphaHash = true`, `depthWrite = true`
  (`:135-138`). For a faint body `col ≈ 0` while `alpha ≈ 1` over the inner ~1.5 px, so the
  billboard writes an **opaque near-black disc with depth** over the Milky Way. Worked
  example: Neptune viewed from ~1 AU gives `hdr ≈ 7.7e-4` → 8-bit output ≈1, while the
  starfield around it sits at 15–60. Also true exactly at the 8-px handover, where
  `fade = t² = 0` (`:267-268`) ⇒ `uBrightness = 0` with `alpha = 1`. **[INFERRED — not
  observed]**

---

## 6. Night-side features — what exists and what does not

### 6.1 Exists

| Feature | Body | Implementation | Site |
|---|---|---|---|
| **City lights** | Earth only | `nightCol = texture(texNight).rgb × 0.35`, gated by `nightMask = smoothstep(0.15, 0, dayAmount)`, composited via `mix(nightCol×nightMask, dayCol×sunT, dayAmount)` | `earth.ts:222,378,381` |
| **Earthshine** | Luna only | `earthshine = 0.002`, `earthshineColor = (0.55,0.65,1.0)`, `darkSideMask = clamp(−N·L × 2, 0, 1)` | `luna.ts:100-106` |
| **Fake light-wrap "night crescent"** | Venus, Mars, Jupiter, Saturn, Uranus, Neptune | `clamp(k·N·L + (1−k), 0, 1)` with `k` = 0.75 / 0.85 / 0.9 / 0.85 / 0.8 / 0.8 | `venus.ts:55`, `mars.ts:63`, `jupiter.ts:56`, `saturn.ts:153`, `uranus.ts:55`, `neptune.ts:55` |
| **Atmosphere multi-scatter twilight** | bodies with `atmosphere` | `getMultipleScattering` gated by `sunVis` | `atmospherePass.ts:1783-1790` |
| **Ring "night" floor** | Saturn's rings | `diffuse = |sun.y|×0.7 + 0.3` — a 0.3 floor even edge-on / from the unlit face | `saturn.ts:109` |

### 6.2 Does not exist

- **Moonlight on Earth.** Nothing. `uMoonPos` is used *only* for the eclipse geometry
  (`earth.ts:277-289`). A full moon gives Earth's night side ~0.25 lux; here it gives 0.
- **Earthshine as a function of Earth's phase or distance.** Luna's `0.002` is a compile
  time constant — it does not change when Earth is new, full, or when Luna is at apogee.
  For scale: real earthshine ≈0.1 lux vs 127 000 lux direct sun = **7.7e-7**; the code uses
  **2e-3**, i.e. ~2600× too bright *in ratio*. Because the day side clips white it still
  renders near-black, so the visible error is small — but the number is not physical.
- **Planet-shine on moons.** Jupiter at Io's distance delivers substantial illumination
  (Jupiter's disc is ~19° across from Io); Io/Europa/Ganymede/Callisto have **no**
  planet-shine term at all (`rockyFragment.ts` has only sun + surge + limb).
- **Airglow.** Grep for `airglow`: zero hits.
- **Aurorae.** None.
- **Zodiacal light.** None.
- **Star-shine / galactic light on the ship.** The skybox is not an IBL source.

### 6.3 What actually keeps the *ship's* dark side from being black

Ranked, at albedo 0.5, in linear radiance:

1. `ambientLight 0.5` → **0.0796** (always on, everywhere, including deep space).
2. `AtmosphereSkyLight` up to 2.5 → up to 0.398 (only inside an atmosphere, day side).
3. `pointLight` nozzles → local, throttle-gated (`EngineExhaust.tsx:171`).
4. Hull emissive at `emissiveIntensity 3.337` — self-illumination, unaffected by any light.

### 6.4 The skybox sets the black level, and its `toneMapped: false` is dead

`MilkyWaySkybox.tsx:34-39` uses `MeshBasicMaterial({ map, toneMapped: false })`. But
`SpaceRenderer.tsx:537` sets `renderer.toneMapping = NoToneMapping` and does the tonemap
in-graph on the whole scene RT (`:526`). `toneMapped: false` only suppresses the
*material's* own tonemap output node — with the renderer already at `NoToneMapping` it is a
**no-op**, and the skybox is tone-mapped like everything else. Misleading flag. **[CODE]**

Radiometrically, the sRGB-decoded starfield texture is used directly as radiance. The real
night sky is ~10⁻⁸ of a sunlit surface; here it is within ~1–2 stops of a planet's day
side, which is what makes deep space read as "lit". Worth a measurement pass in a later
audit.

---

## 7. Shadows — complete enumeration

**No three.js shadow maps exist.** `renderer.shadowMap` is never referenced in `src/`;
no light sets `castShadow`; `ShipOne.tsx:33-34`'s `castShadow`/`receiveShadow` are inert
flags on a mesh no shadow camera ever sees. **[CODE]**

Seven real shadowing mechanisms, all analytic or texture-based:

| # | Shadow | Caster → receiver | Mechanism | Site |
|---|---|---|---|---|
| 1 | **Solar eclipse** | Luna → Earth's surface | Analytic overlapping-disc integral (`eclipseFn`) with true angular radii `asin(R/d)`; gives a graded penumbra, not a binary mask | `earth.ts:131-184, 277-289, 365` |
| 2 | **Planet shadow on rings** | Saturn → its rings | Ray–sphere from the ring fragment toward the sun; `shadowMask = inShadow ? 0.05 : 1.0` (hard edge, 0.05 floor) | `saturn.ts:111-127` |
| 3 | **Ring shadow in the atmosphere** | Saturn's rings → its own in-scatter + fog clamp | Analytic annulus with a radial density profile (C/B/Cassini/A) | `types.ts:104-117`, `CelestialBody.tsx:239-249`, `atmospherePass.ts:893-898` (`ringDensityProfile`) |
| 4 | **Ring shadow on the ship's key light** | Saturn's rings → `SunLight` | CPU ray–plane against the same annulus; `sunTransmittance × (1 − occ)` | `atmospherePass.ts:1009-1026` |
| 5 | **Planet shadow on the ship's key light** | dominant atmosphere body → `SunLight` | CPU ray–sphere toward the sun; `tGround > 0` ⇒ `sunTransmittance = 0` hard, with a `SUN_EMERGE_BAND = 0.04` ramp above the horizon | `atmospherePass.ts:973-1004` |
| 6 | **Cloud shadows on Earth's ground** | clouds → terrain | Beer Shadow Map (`cloudShadowAt(positionLocal)`), crossfaded with a legacy UV-offset fake above the bake ceiling, faded out at grazing sun (`GRAZE_LO/HI`) | `earth.ts:327-361` |
| 7 | **Cloud shadow on the ship** | clouds → `SunLight` + sky fill | 1×1 GPU BSM probe + async readback, `shipT^γ` on the key light, `1 − 0.?·(1−shipT)` on the sky | `atmospherePass.ts:1058-1067` |

### 7.1 Missing shadows

- **Earth's shadow on Luna.** `luna.ts` has **no** eclipse term. Earth→Luna eclipses are
  the reverse case of #1 and would use the same `eclipseFn`, but the asymmetry is real:
  Luna occults the Sun for Earth, Earth never occults the Sun for Luna. **[CODE]**
- **Jupiter's shadow on Io/Europa/Ganymede/Callisto**, and moon-on-moon transits. None of
  the four moon configs has any occlusion term.
- **Ring shadow on Saturn's own disc.** #3 shadows the *atmosphere in-scatter*;
  `buildSaturnFragmentNode` (`saturn.ts:139-174`) has no ring term at all, so the cloud
  deck itself receives no ring shadow band.
- **Ship self-shadowing.** None (no shadow map, no SSAO, no SDF).
- **Ship shadow on a planet / asteroid, or asteroid-on-asteroid.** None.
- **Planet shadow on the ship for airless bodies.** #5 only runs for a *dominant atmosphere
  body* (`SpaceRenderer.tsx:804`, `getDominantAtmosphereBody` at
  `atmospherePass.ts:806-812`, registration gated at `CelestialBody.tsx:349`). Flying into
  Luna's, Mercury's or Europa's shadow leaves the ship at full 30-intensity daylight.
  **[CODE — high confidence]**

---

## 8. Every hardcoded lighting/brightness/exposure constant found

Grouped by subsystem. Units column says what the number *is*, not what it claims.

### 8.1 Lights and global scale

| Constant | Value | Site | Unit / scale |
|---|---|---|---|
| `ambientLight intensity` | `0.5` | `Scene.tsx:130` | irradiance, three's arbitrary "lux" |
| `SunLightProps.intensity` default | `30` | `SunLight.tsx:21` | illuminance at normal incidence, three's "lux" |
| `SKY_AMBIENT_MAX_INTENSITY` | `2.5` | `atmospherePass.ts:843` | same scale as ↑ (explicitly, `:835`) |
| `SKY_TINT_SATURATION` | `0.7` | `atmospherePass.ts:844` | dimensionless lerp |
| `SKY_DAY_BAND_LO` / `_HI` | `0.25` / `0.1` | `atmospherePass.ts:845-846` | cosine of sun-zenith |
| `SUN_EMERGE_BAND` | `0.04` | `atmospherePass.ts:842` | cosine |
| `SUN_T_STEPS` | `64` | `atmospherePass.ts:836` | march steps |
| `SUN_ILLUM_GAME_1AU` | `21.2` | `atmosphereData.ts:69` | "game luminance units" illuminance at 1 AU |
| Earth `sunIlluminance` override | `[20,20,20]` | `atmosphereData.ts:252` | ditto |
| `VENUS_ILLUM_TRIM` | `0.025` | `atmosphereData.ts:271` | dimensionless 40× hack |
| `ATMOSPHERE_EXPOSURE` | `1.0` | `atmosphereData.ts:37` | **unused** identity placeholder |
| Bloom `(strength, radius, threshold)` | `(0.02, 0, 1)` | `SpaceRenderer.tsx:516` | linear HDR |
| `settings.bloom` / `.toneMapping` defaults | `false` / `false` | `store.ts:29-30` | ⇒ no bloom, Neutral tonemap |
| `LIGHT_INTENSITY` (nozzle) | `2.0` | `EngineExhaust.tsx:48` | candela-like |
| `LIGHT_DISTANCE` | `6.0` | `EngineExhaust.tsx:50` | local metres |
| `LIGHT_COLOR` | `Color(5.0, 7.0, 10.0)` | `EngineExhaust.tsx:76` | HDR ×10 colour |

### 8.2 Sun disc / point sources

| Constant | Value | Site | Unit / scale |
|---|---|---|---|
| `CORE_HDR` | `4096` | `Star.tsx:80` | linear HDR radiance |
| inner-glow multiplier | `CORE_HDR × 0.3` = `1228.8` | `Star.tsx:144` | linear HDR |
| inner-glow radius | `0.35` | `Star.tsx:143` | fraction of billboard radius |
| outer-glow multiplier / power | `8.0` / `3.5` | `Star.tsx:149` | linear HDR / exponent |
| `GLOW_PAD` | `8` | `Star.tsx:72` | billboard ÷ star diameter |
| `MIN_SCREEN_PX` (star) | `60` | `Star.tsx:76` | pixels |
| star colour | `(1.0, 0.95, 0.9)` | `Star.tsx:154` | linear chromaticity |
| alpha scale | `× 0.5` | `Star.tsx:158` | dimensionless |
| `REFERENCE_HDR` | `12.0` | `StellarPoint.tsx:67` | linear HDR |
| `STELLAR_PX_THRESHOLD` | `8` | `StellarPoint.tsx:58` | pixels |
| `MIN_SCREEN_PX` (point) | `6` | `StellarPoint.tsx:62` | pixels |
| brightness clamp | `500` | `StellarPoint.tsx:271` | linear HDR |
| core / halo profile | `0.2` / `0.6`, powers `1.2` / `2.5`, halo `×0.4`, alpha `halo×2` | `StellarPoint.tsx:175-190` | billboard fractions |

### 8.3 Earth surface

| Constant | Value | Site | Unit / scale |
|---|---|---|---|
| night-texture scale | `0.35` | `earth.ts:222` | × linear texture |
| day/night sigmoid slope | `-40` | `earth.ts:270` | 1/cosine |
| night mask band | `smoothstep(0.15, 0)` | `earth.ts:378` | on `dayAmount` |
| `SURFACE_SUN_SCALE` | `1.0` | `earth.ts:90` | × normalised transmittance |
| normal-map relief gain | `0.8` | `earth.ts:315` | × Δcos |
| `GROUND_SHADOW_STRENGTH` | `1.0` | `earth.ts:68` | lerp toward `T_sun` |
| fake cloud-shadow depth | `0.7`, taps `0.6/0.4`, offset `0.0015`, cos floor `0.12` | `earth.ts:325,332,333` | dimensionless / UV |
| `GRAZE_LO` / `GRAZE_HI` | `0.03` / `0.15` | `earth.ts:73-74` | sin(sun elevation) |
| terminator warm tint | `(1.0, 0.6, 0.3)`, strength `0.25`/`0.06` | `earth.ts:371,399` | **dead** (`USE_ATMOSPHERE_SURFACE_LIGHTING = true`) |
| ocean spec | `pow(·,40)×0.8` + `pow(·,8)×0.15` | `earth.ts:411-412` | Blinn lobes |
| water Fresnel | `0.02 + 2.0·(1−V·N)^2.5` | `earth.ts:422-424` | Schlick; the `2.0` makes F ≫ 1 at grazing |
| ocean sky-reflection colour | `(0.0, 0.25, 1.0)` | `earth.ts:427` | linear radiance |
| land limb darkening | `pow(V·N, 0.3)`, floor `0.05` | `earth.ts:432` | view-angle only |
| billboard albedo | `(0.38,0.42,0.80) × 2.0` | `earth.ts:477` | radiance (>1) |
| billboard rim | `(0.3,0.5,0.9) × 0.2`, `rim = (1−domeZ)×2.5` | `earth.ts:482-483` | additive radiance |

### 8.4 Other bodies

| Body | Constants | Site |
|---|---|---|
| Luna | earthshine `0.002`, colour `(0.55,0.65,1.0)`, dark mask `×2.0`, surge `pow(N·H,3)×0.12`, bump `0.8`/`0.6`, texel `1/4096`/`1/1024`, displacement `10.786 km`, far albedo `(0.44,0.42,0.40)`, `geometricAlbedo 0.0036` | `luna.ts:32,35,98,100-102,151-155` |
| Venus | wrap `×0.75 + 0.25`, far albedo `(0.70,0.52,0.28)` | `venus.ts:26,55,78` |
| Mars | wrap `×0.85 + 0.15`, surge `pow(N·H,4)×0.08`, warm tint `(1.0,0.7,0.45)×0.2`, terminator band `smoothstep(-0.05,0.3)·smoothstep(0.5,0.15)`, billboard haze `(12.0,0.1,0.05)×0.2`, far albedo `(0.6,0.3,0.15)` | `mars.ts:32,63,66-68,74,80,109-110` |
| Mercury | surge `pow(N·H,3)×0.12`, limb `pow(V·N,0.25)` floor `0.05`, far albedo `(0.35,0.33,0.30)` | `mercury.ts:53,56-57,75` |
| Jupiter | wrap `×0.9 + 0.1`, limb `pow(V·N,0.4)`, haze `(0.7,0.55,0.35)×0.06`, day mask `×2+0.3`, desat `0.2`, far albedo `(0.65,0.55,0.40)` | `jupiter.ts:32,56,61,66-67,72,76` |
| Saturn | wrap `×0.85+0.15`, limb `pow(V·N,0.4)`, haze `(0.7,0.55,0.3)×0.08`, day mask `×2+0.5`, desat `0.2`, ring diffuse `|sun.y|×0.7+0.3`, ring shadow floor `0.05`, alpha cutoff `0.05`, ring radii `66 900`/`140 220 km`, tilt `26.7°`, far albedo `(0.62,0.55,0.40)` | `saturn.ts:35,38-39,101,108-109,127,153,158,163-164,169,214` |
| Uranus | wrap `×0.8+0.2`, limb `pow(V·N,0.35)`, haze `(0.5,0.65,0.75)×0.06`, desat `0.15`, far albedo `(0.35,0.65,0.70)` | `uranus.ts:31,55,60,65-66,71` |
| Neptune | wrap `×0.8+0.2`, limb `pow(V·N,0.35)`, haze `(0.3,0.45,0.75)×0.08`, desat `0.15`, far albedo `(0.05,0.12,0.85)` | `neptune.ts:31,55,60,65-66,71` |
| Io / Europa / Ganymede / Callisto | shared `surgeStrength 0.10`, limb `pow(V·N,0.25)` floor `0.05`; far albedos `(0.36,0.26,0.14)` / `(0.55,0.52,0.48)` / `(0.45,0.43,0.40)` / `(0.30,0.28,0.25)` | `rockyFragment.ts:28,49-50`; `io.ts:21`, `europa.ts:21`, `ganymede.ts:21`, `callisto.ts:21` |
| Far billboards (all) | `sizeMultiplier 2.1`, edge `smoothstep(1.0, 0.92)` | `useFarLOD.ts:33,59` |

### 8.5 Clouds (lighting magnitudes only)

| Constant | Value | Site |
|---|---|---|
| `CLOUD_SUN_SCALE` | `0.45` (× `sunIlluminance` × `T`) | `cloudCommon.ts:103` |
| `CLOUD_SKY_SCALE` | `1.0` | `cloudCommon.ts:104` |
| `CLOUD_SKY_AMBIENT` | `(0.3, 0.5, 1.0)` | `cloudCommon.ts:105` |
| `FAR_SHADOW_FLOOR` | `0.45` | `cloudCommon.ts:118` |
| `FAR_AMBIENT_FRAC` | `0.3` | `cloudCommon.ts:119` |
| legacy sun magnitude (dead branch) | `12.0`, tint `(1.0,0.96,0.88)`→`(1.0,0.55,0.25)` | `earthClouds.ts:3387-3391` |
| `CLOUD_AP_STRENGTH` | `1.0` | `atmospherePass.ts:470` |

### 8.6 Asteroids

| Constant | Value | Site |
|---|---|---|
| far/impostor `shade` | `0.15 + 8.0 × sunDot` | `FarTierBatch.tsx:150`, `AsteroidImpostors.tsx:167` |
| far/impostor albedo | `vec3(0.1, 0.1, 0.1)` | `FarTierBatch.tsx:151`, `AsteroidImpostors.tsx:170` |
| far billboard visual scale | `radius × 0.4` | `FarTierBatch.tsx:110` |
| disc edge | `smoothstep(1.0, 0.45)` | both, `:132` / `:148` |
| LOD1 base colour | `0.15 / 0.14 / 0.13`, rough 1.0, metal 0.0 | `CLAUDE.md` strip script — **not verified in-repo** |

---

## 9. Stale or misleading comments found

| Claim | Reality |
|---|---|
| `Star.tsx:63-64`: *"HDR values are moderate (~60) … the instability that extreme values (4096) cause"* | `CORE_HDR = 4096` (`:80`). The comment names the live value as the anti-pattern. |
| `StellarPoint.tsx:24, 65-66, 175, 181, 186`: *"the bright HDR core triggers the bloom pipeline"*, *"bloom amplifies whatever survives"* | `settings.bloom` defaults `false` (`store.ts:29`). The default build has no bloom; the HDR values just clip. |
| `earth.ts:451`: *"(`hemiAmount` is retained for the eclipse term…)"* | `hemiAmount` (declared `:272`, multiplied `:290`) is **never read**. Dead variable. The eclipse actually lands on `dayAmount` at `:365`. |
| `cloudCommon.ts:103`: *"≈ 12 HDR sunlit"* | `20 × T × 0.45` ≈ 8–9 with a realistic `T`, not 12. The 12 was the *legacy* hand-tuned magnitude at `earthClouds.ts:3391`. |
| `MilkyWaySkybox.tsx:38`: `toneMapped: false` | No-op — `renderer.toneMapping = NoToneMapping` (`SpaceRenderer.tsx:537`) and the tonemap is applied to the whole RT in-graph. |
| `atmospherePass.ts:806`: *"(Phase 1: only Earth registers.)"* | Seven bodies register now (Venus/Earth/Mars/Jupiter/Saturn/Uranus/Neptune). |
| `types.ts:126-129`: *"Not yet read in Phase 0 (atmosphere pass is a passthrough)"* | Long since consumed. |
| `ShipOne.tsx:33-34`: `castShadow` / `receiveShadow` | Inert — no shadow map anywhere. |

Comments that are **accurate and load-bearing** (do not "fix" these):
`SunLight.tsx:50-52` (prop-application semantics), `earth.ts:82-90` (the normalisation is
deliberate), `atmosphereData.ts:263-270` (the Venus diagnosis is correct),
`atmospherePass.ts:829-832` and `:835` (the sky-ambient is a stand-in, in SunLight's scale),
`atmospherePass.ts:1059-1064` (the intensity-30 clipping explanation).

---

## 10. Priority ranking for a fix

1. **Introduce one luminance scale.** Surfaces return `albedo × E/π × f(N·L)` with
   `E = sunIlluminance(d)`; `SunLight.intensity` becomes `sunIlluminance(d_ship)`;
   `ATMOSPHERE_EXPOSURE` becomes a real pre-tonemap divide. Retires
   `VENUS_ILLUM_TRIM`, `SKY_AMBIENT_MAX_INTENSITY`'s 2.5, `CLOUD_SUN_SCALE`'s 0.45, the
   far-asteroid `8.0`, and the `30` vs `21.2` split.
2. **Give Earth its Lambert cosine back** (`earth.ts:269-271`). Cheapest single visual win.
3. **Calibrate the albedo maps.** A per-body `albedoScale` = `A_lit / Y_tex` from §3.1
   fixes a 14.6× spread with 13 numbers. Fix `luna.ts:151`'s `0.0036` while there.
4. **Kill `ambientLight 0.5`** once the sky fill is physical; it is a −5.9-stop flat lift on
   the only PBR surfaces in the game.
5. **Make the sun's glow obey inverse-square** (`Star.tsx:190-195`) — compensate the glow
   radiance by `(physicalHalf / halfExtent)²`.
6. **Fix `StellarPoint`'s alpha** so a faint body fades out instead of punching a black
   disc, and let the footprint or the bloom carry magnitude.
7. **Register airless bodies for the lighting probe** so planet shadow + planet-shine work
   at Luna, Mercury and the Galileans.

---

## 11. Open questions

- What is the *actual* mean linear luminance of the Milky Way skybox texture
  (`8k_stars_nasa.ktx2`), and where does it sit relative to a planet's day side? That sets
  the whole scene's black level and I did not measure it.
- Does `ShipOne.glb` carry a second UV set? Without one the `occlusionTexture` is silently
  dropped by `GLTFLoader` and the hull has no AO.
- What are the LOD0 asteroid GLBs' actual `baseColorTexture` means? I verified the material
  *structure* from the GLB JSON but not the texel values, so the near↔far tier brightness
  step (§3.5) is computed against `CLAUDE.md`'s documented LOD1 grey, not a measurement.
- Was `SKY_AMBIENT_MAX_INTENSITY = 2.5` fitted against the key light's 30 (⇒ 8.3 %) or
  against the atmosphere's 20 (⇒ 12.5 %)? The comment says the former; the physics wants
  ~15–20 % either way.
- `Star.tsx:186-188` gates `screenH` on `cam.getFilmHeight()` being truthy — for a default
  `PerspectiveCamera` `filmGauge = 35`, `filmHeight = 35/aspect`, so this is always truthy
  and the `1080` fallback is dead. Intentional, or a leftover from a different camera setup?
- Is the `0.05` floor on `shadowMask` (`saturn.ts:127`) meant to represent ring
  forward-scatter, or is it just an anti-black guard?
