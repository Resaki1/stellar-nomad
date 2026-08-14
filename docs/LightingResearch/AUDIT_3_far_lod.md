# AUDIT 3 — Distant objects, impostors, starfield

Scope: everything that renders a celestial body once it is too small to be a textured
sphere, plus the sky behind it and the pixel pipeline it lands in.

Read in full:
`src/components/celestial/useFarLOD.ts`, `src/components/celestial/CelestialBody.tsx`,
`src/components/celestial/types.ts`, `src/components/space/StellarPoint.tsx`,
`src/components/space/SimGroup.tsx`, `src/components/Star/Star.tsx`,
`src/components/Stars/StarsComponent.tsx`, `src/components/Skybox/MilkyWaySkybox.tsx`,
`src/components/POI/POIProjector.tsx`, `src/components/HUD/POIMarkers/POIMarkers.tsx`,
`src/components/Navigation/Navigation.tsx`, `src/components/Scene/Scene.tsx`,
`src/components/space/SpaceRenderer.tsx`, `src/hooks/useKTX2.ts`, `src/sim/units.ts`,
`src/sim/celestialConstants.ts`, `src/sim/systems/sol.json`,
`src/components/celestial/bodies/{luna,venus,earth,mars,mercury,jupiter,saturn,uranus,neptune,io,europa,ganymede,callisto,rockyFragment,atmosphereData}.ts`,
plus the three.js r183.2 source that actually executes
(`node_modules/three/src/materials/nodes/NodeMaterial.js`,
`node_modules/three/src/renderers/common/{Renderer,Textures,RenderList,RenderTarget}.js`,
`node_modules/three/src/renderers/webgpu/{WebGPURenderer,WebGPUBackend}.js`,
`node_modules/three/src/renderers/webgpu/utils/{WebGPUTextureUtils,WebGPUPipelineUtils}.js`,
`node_modules/three/src/nodes/functions/material/getAlphaHashThreshold.js`),
and the decoded assets themselves.

**Confidence labelling** (same convention as AUDIT 1 / AUDIT 2):
- **[CODE]** — read directly from source, cited.
- **[COMMENT]** — a comment *claims* it; flagged where the code disagrees.
- **[MEASURED]** — I decoded the actual asset / three.js path and computed the number.
- **[INFERRED]** — arithmetic on top of cited code; not observed at runtime.

---

## HEADLINE ANSWERS

1. **There is no sphere→impostor transition. There are two impostors, and both draw at
   once.** `showFar` (`CelestialBody.tsx:332`) turns on the flat disc billboard when the
   body leaves `lod.far`; `StellarPoint` turns on independently at `pixelDiameter < 8`
   (`StellarPoint.tsx:221`). Nothing couples them. Between those two states both meshes
   render, opaque, at the same depth, and the point sprite is *smaller* than the disc, so
   it lands **inside** it. **[CODE]**

2. **`m.alphaHash = true` is dead code on both impostors.** three r183 only reaches the
   alpha-hash discard from `setupDiffuseColor()` (`NodeMaterial.js:930`), and
   `setup()` skips that whole branch when `material.fragmentNode !== null`
   (`NodeMaterial.js:560`). Both `useFarLOD.ts:71` and `StellarPoint.tsx:138` set
   `fragmentNode`. Consequences: the far billboard's `edge` alpha
   (`useFarLOD.ts:33`) never softens anything — every distant planet has a **hard,
   fully-aliased circular rim**; and `StellarPoint`, which returns colour → 0 at its
   sprite edge and has *no* `Discard`, **stamps a black square over the sky**. **[MEASURED
   in the three.js source path]**

3. **The point-source impostor and the disc impostor live on scales that differ by
   68× to 86,000× at the very pixel size where they hand over**, and the mismatch is
   body-dependent because the disc shader has no irradiance term while the point does. A
   single `REFERENCE_HDR` cannot reconcile them: the value needed spans 1.4e-4 (Mercury)
   to 1.8e-1 (Uranus). The shipped value is `12.0`. **[INFERRED, arithmetic below]**

4. **There is no starfield.** `StarsComponent.tsx` (drei `<Stars>`) is not imported
   anywhere — the file's own line 1 says "Deprecated". The only stars in the game are
   pixels baked into an 8192×4096 sRGB panorama. No catalogue, no magnitudes, no
   magnitude→luminance mapping, no PSF. **[CODE + MEASURED]**

5. **The Milky Way panorama is authored at "looks nice in SDR" levels and is the
   brightest thing in the far field.** Decoded: peak linear value **1.000**, mean linear
   luminance **2.62e-3**, 204 pixels at ≥250/255. On the engine's own surface convention
   (`albedo × N·L`, max 1.0) that makes the galaxy's brightest pixels **2.37× brighter
   than the sunlit Moon's disc**, where physics demands the Moon be **1.8e7× brighter**
   than the galaxy — a **19.1 magnitude** relative error. It would not survive any
   auto-exposure system. **[MEASURED]**

6. **No MSAA, no FXAA, no TAA anywhere in the scaled scene.** `WebGPURenderer` is built
   without `antialias` (`Scene.tsx:160-165`; default `false` →
   `Renderer.js:101,275` → `samples = 0`), and both offscreen targets are created
   with default `samples: 0` (`SpaceRenderer.tsx:329-333, 345-349`;
   `RenderTarget.js:62`). The only temporal filter in the frame is the *cloud*
   reconstruction, which never touches planets. **[MEASURED in the three.js source]**

7. **From Earth, the textured Moon can never be seen.** `lunaConfig.lod.far = 250_000`
   (`luna.ts:133`) but the Earth–Moon distance in `sol.json` is **384,400 km** and the
   spawn→Luna distance is **376,869 km**. The Moon is therefore *always* the flat grey
   billboard plus a glowing dot, never the 8k-textured sphere. **[MEASURED from
   `sol.json`]**

8. **Uranus and Neptune do not render at all from Earth.**
   `SCALED_CAMERA_FAR = 2_000_000` scaled units = 2e9 km (`SpaceRenderer.tsx:67`).
   Spawn→Uranus = 3.0007e9 km (3.00e6 scaled), spawn→Neptune = 4.6305e9 km (4.63e6
   scaled). Both are beyond the far plane, so both the billboard and the StellarPoint are
   frustum-culled and hardware-clipped — while their HUD diamonds still show
   (`sol.json` markers `maxDistanceKm: 5e10`). **[MEASURED from `sol.json` + CODE]**

---

## 1. THE FAR-FIELD RENDERING ARCHITECTURE

Every `CelestialBody` mounts **four** representations simultaneously
(`CelestialBody.tsx:416-464`):

| Tier | Mesh | Gate | Luminance convention |
|---|---|---|---|
| near | `SphereGeometry(scaledRadius, cfg.near.segments)` | `distKm < lod.near` **and** textures loaded **and** shader compiled (`:324,327,330`) | `texture(albedo) × f(N·L)` ∈ [0,1] |
| mid | `SphereGeometry(scaledRadius, cfg.mid.segments)` | `distKm < lod.far` (`:325,331`) | same [0,1] |
| far | `PlaneGeometry(scaledRadius×2.1, …)` camera-space billboard (`useFarLOD.ts:61-64`) | `!showNear && !showMid` (`:332`) | hard-coded `THREE.Color` × `sunDot` ∈ [0,~1.6] |
| point | `PlaneGeometry(1,1)` scaled to 6 CSS px (`StellarPoint.tsx:131,277`) | `pixelDiameter < 8` (`:221`) | physical flux ÷ `JUPITER_REF_FLUX` × 12, clamped 500 |

Plus, in the same scene, the sky:

| | Source | Convention |
|---|---|---|
| Sun | `Star.tsx` billboard, `CORE_HDR = 4096` (`:80`), min 60 px (`:76`) | fixed, no 1/r² |
| Milky Way | inverted sphere, `8k_stars_nasa.ktx2`, `MeshBasicMaterial` (`MilkyWaySkybox.tsx:34-39`) | sRGB→linear [0,1] |
| stars | *none* (`StarsComponent.tsx` unused) | — |
| atmosphere | `sunIlluminance` scale, 21.2 at 1 AU (`atmosphereData.ts:69,205`) | ~21.2·ρ/π |

**Four mutually inconsistent radiometric scales in one render target.** This is the
same "two scales" disease the Venus trim comment describes
(`atmosphereData.ts:259-271`), but in the far field there are four of them.

### The scaled camera and the apparent-size chain

`scaledCamera = localCamera.clone()` (`SpaceRenderer.tsx:323`), with
`near = 0.001`, `far = 2_000_000` (`:66-67, 552-553`), `fov` copied from the local
camera (`:554`) and `aspect` from the canvas (`:555`). Position/orientation are synced
every frame (`:660-664`). Scale is `SCALED_UNITS_PER_KM = 1/1000` (`units.ts:6`), i.e.
**1 scaled unit = 1000 km**, applied by `SimGroup` (`SimGroup.tsx:29,33`).

FOV is **never set** — `Scene.tsx:152` passes only `near`/`far`, so R3F's
`PerspectiveCamera` default **fov = 75°** applies. **[INFERRED, but no `fov` assignment
exists anywhere in `src/` — grep shows only *reads*.]**

Consequence for apparent size, which matters for every number below: at a 1000-px-tall
viewport, **1 px ≈ 1.534 mrad ≈ 5.27′**. The real full Moon (31′) is therefore only
**~6.0 px** across; Venus (25″) is **~0.027 px**. The engine is not wrong about *size* —
it is wrong about *brightness*, and about what it draws at those sizes.

Note the code's own pixel formula is 17% optimistic:
```ts
// StellarPoint.tsx:217-218
const angularDiameter = (radiusKm * 2) / distKm;
const pixelDiameter  = (angularDiameter / fovRad) * screenH;
```
`fovRad = 1.3090` where the geometrically correct divisor is `2·tan(fov/2) = 1.5344`.
Every `pixelDiameter` in the code is **×1.172** too large. **[CODE + INFERRED]**

---

## 2. Q1 — HOW A BODY TRANSITIONS SPHERE → IMPOSTOR

### The gate (`CelestialBody.tsx:322-344`)

```ts
const wantNear = hasNear && distKm < config.lod.near!;
const wantMid  = hasNear ? (!wantNear && distKm < config.lod.far) : (distKm < config.lod.far);
const nearReady = nearReadyState.current === 2;
const midReady  = midReadyState.current === 2;
const showNear = wantNear && nearReady;
const showMid  = (wantMid && midReady) || (wantNear && !nearReady && midReady);
const showFar  = !showNear && !showMid;
if (nearRef.current) nearRef.current.visible = showNear;
if (midRef.current)  midRef.current.visible  = showMid;
if (farRef.current)  farRef.current.visible  = showFar;
```

- **Threshold type: pure metric distance in km.** Not angular size, not pixels.
  `lod.far` ranges from 250,000 km (Luna, `luna.ts:133`) to 16,000,000 km (Jupiter/Saturn,
  `jupiter.ts:126`, `saturn.ts:231`). Because it is a distance and not an angle, the
  *apparent size* at the switch differs wildly per body: at `lod.far` the disc is
  **26.4 px for Venus, 11.5 px for Ganymede, 10.6 px for Luna, 6.7 px for Jupiter,
  3.1 px for Neptune** — an **8.5× spread** (at 1000 px / 75°; full table in §7). So "the
  LOD switches when the body is small" is false; it switches at an arbitrary apparent size
  per body. **[INFERRED from cited constants]**
- **Crossfade: none.** Three boolean `.visible` assignments. **[CODE]**
- The switch is *also* not hysteretic — a body oscillating across `lod.far` pops every
  frame. `PREFETCH_MULT = 1.5` (`CelestialBody.tsx:29`) only gates *texture loading*.
- Registration with the atmosphere pass flips with the same booleans
  (`:349-362`), so a body's atmosphere disappears entirely at `lod.far` and the billboard
  is expected to fake it (`:346-348` comment: "the billboard carries its own rim glow" —
  true for Earth/Mars/Jupiter, **false** for Luna, Venus's rim, Mercury, and the four
  Jovian moons, which use the plain `defaultBillboardFragment`).

### Is brightness conserved across mid → far?

**Yes, to ~13%, and by hand-tuning rather than by construction.** [MEASURED]

The far billboard's colour is a hard-coded `THREE.Color` per body. I decoded the actual
mid-tier textures and computed their **cos-latitude-weighted (i.e. true spherical) mean
linear reflectance**:

| Body | `far.albedo` (`*.ts`) | texture spherical mean (linear RGB) | ratio |
|---|---|---|---|
| Luna | `(0.44, 0.42, 0.40)` `luna.ts:32` | `(0.5041, 0.4780, 0.4633)` | 0.87 / 0.88 / 0.86 |
| Venus | `(0.70, 0.52, 0.28)` `venus.ts:26` | `(0.7915, 0.5204, 0.2217)` | 0.88 / 1.00 / 1.26 |

So somebody eyeballed each `far.albedo` off its texture. Integrated over the disc at the
Luna switch distance the two tiers agree within ~10% (25.7 vs 24.8 engine·px² —
arithmetic in §7). That is the *one* transition in this subsystem that is roughly
energy-conserving, and it is conserving the **wrong** energy: the Luna texture's spherical
mean reflectance is **0.4825**, whereas the Moon's real geometric albedo is **0.12**. The
Moon's sphere *and* its billboard are both **~4× too bright**. **[MEASURED]**

Three residual defects at this transition:
- **5% oversize.** `sizeMultiplier ?? 2.1` (`useFarLOD.ts:59`) makes a plane of
  half-width `scaledRadius × 1.05`, and the fragment draws a disc out to `dist = 1`
  (`useFarLOD.ts:30-33`), i.e. the inscribed circle = the half-width. So every billboard
  planet is **1.05× its true angular radius** (10% more solid angle). No body overrides
  `sizeMultiplier`. **[CODE]**
- **Limb darkening / opposition surge vanish.** `rockyFragment.ts:46-50` has both;
  `defaultBillboardFragment` (`useFarLOD.ts:29-46`) has neither. Jupiter/Saturn/Uranus/
  Neptune billboards keep a `pow(domeZ, 0.35..0.4)` limb term (`jupiter.ts:102`,
  `saturn.ts:196`, `uranus.ts:96`, `neptune.ts:96`); Luna, Mercury and the Jovian moons
  do not.
- **The billboard's depth is derived from the wrong vertices** — see §6.

### Is brightness conserved across far → point? **No, by a factor of 68–86,000.**

There is no handoff. `StellarPoint` never hides the billboard and the billboard never
hides `StellarPoint`. The only thing standing between them is a screen-size ramp:

```ts
// StellarPoint.tsx:267-268
const t = (STELLAR_PX_THRESHOLD - pixelDiameter) / STELLAR_PX_THRESHOLD;
const fade = t * t;
```

I integrated both impostors analytically (sprite profile integral = **0.8383 px² per unit
`uBrightness`**; disc = `π·(px·1.05/2)² · lum(albedo) · ⟨cos i⟩`) and evaluated at the
8-px handoff with each body at opposition and its **config** geometric albedo:

| Body | `dSun` | disc energy (engine·px²) | *unfaded* point energy | point/disc | `REFERENCE_HDR` that would match |
|---|---|---|---|---|---|
| Mercury | 0.39 AU | 12.27 | 1.06e6 | **86,200×** | 1.39e-4 |
| Venus | 0.72 AU | 19.99 | 1.48e6 | **73,980×** | 1.62e-4 |
| Earth | 0.97 AU | 32.43 | 5.15e5 | **15,870×** | 7.56e-4 |
| **Luna (p=0.0036 as shipped)** | 0.97 AU | 15.62 | 4.25e3 | **272×** | 4.41e-2 |
| Luna (p=0.12, physical) | 0.97 AU | 15.62 | 1.42e5 | 9,068× | 1.32e-3 |
| Mars | 1.53 AU | 13.04 | 8.18e4 | **6,275×** | 1.91e-3 |
| Jupiter | 5.25 AU | 20.71 | 2.19e4 | **1,057×** | 1.14e-2 |
| Saturn | 9.56 AU | 20.47 | 6.11e3 | **299×** | 4.02e-2 |
| Uranus | 19.2 AU | 21.79 | 1.48e3 | **68×** | 1.76e-1 |
| Neptune | 30.1 AU | 5.83 | 5.47e2 | **94×** | 1.28e-1 |

**Shipped value: `REFERENCE_HDR = 12.0` (`StellarPoint.tsx:67`).** It is between 68× and
86,000× too large. **[INFERRED — arithmetic on cited constants; script reproduced below in
§7]**

The required value spans **1270×** across the ten bodies, and the spread is *exactly*
`1/dSun²`: the point tier divides by `dSun²` (`StellarPoint.tsx:251-252`) and the disc
tier does not multiply by any irradiance at all. **No single constant can reconcile the
two tiers until the disc shader gets a `1/dSun²` illuminance factor.** That is the
structural bug, and it is the far-field face of the same defect AUDIT 2 found on the
sphere tiers.

What the `fade = t²` ramp actually does: it hides a 272× step for Luna and a 74,000× step
for Venus behind the *same* curve. Solving numerically for where the faded point overtakes
the disc:

- Luna, `p = 0.0036`: crossover at **7.51 px** (d = 353,388 km), point 12.92 vs disc 12.80.
- Luna, `p = 0.12`: crossover at **7.91 px**, point 16.12 vs disc 14.20.

i.e. the fade ramp only buys **0.4 px of grace**, then the point runs away by the factors
in the table above. `Math.min(hdr * fade, 500)` (`:271`) is the third band-aid on the
same wound.

### Does a sub-pixel sphere lose energy to rasterisation, and does anything compensate?

- **Above ~2 px:** the disc's rasterised area ∝ 1/d² and its per-pixel value is
  distance-invariant, so integrated energy ∝ 1/d² — *correct*.
- **Below ~1 px:** with `samples = 0` there is no coverage AA. A 0.315-px disc (Venus's
  size at Luna's crossover scaling, see §6) covers a pixel *centre* with probability
  ≈ its area ≈ 0.078. So in ~92% of frames the billboard renders **nothing**, and in ~8%
  it renders **one pixel at full surface brightness**. The *expectation* is right; the
  variance is 100%. Not energy loss — energy **quantisation**, i.e. flicker.
- **Compensation:** the only mechanism is `MIN_SCREEN_PX = 6` (`:62`), which pins the
  point sprite to a 6-CSS-px floor so *something* stable is always on screen. But its
  brightness comes from a different formula with a different normalisation, and the
  `fade` term contains **no energy-matching factor whatsoever** — it is a bare function of
  screen size. So: yes there is a mechanism; no, it does not conserve energy.

---

## 3. Q2 — THE IMPOSTORS' FORMULAE, LINE BY LINE

### 3a. The disc impostor (`useFarLOD.ts`)

Geometry (`:61-64`):
```ts
const sizeMultiplier = farConfig.sizeMultiplier ?? 2.1;         // ← eyeballed
new THREE.PlaneGeometry(scaledRadius * sizeMultiplier, scaledRadius * sizeMultiplier)
```
Vertex (`:75-81`) — a strict **view-space** billboard: the world centre is transformed to
view space and `positionGeometry.xy` is added there, so the quad's axes are exactly view X
and view Y. No `depthNode` override (contrast `StellarPoint.tsx:166-167`).

Fragment (`:29-46`, and the per-body variants):
```ts
const p    = uv().mul(2).sub(1);
const dist = length(p);
const edge = smoothstep(float(1.0), float(0.92), dist);   // ← 0.92 eyeballed
Discard(edge.lessThan(0.01));                             // ← 0.01 eyeballed
const domeZ = float(1.0).sub(dist.mul(dist)).max(0).sqrt();          // sphere normal z
const sunDot = clamp(uSpR.mul(p.x).add(uSpU.mul(p.y)).add(uSpF.mul(domeZ)), 0, 1);
const col = vec3(albedo.r, albedo.g, albedo.b).mul(sunDot);
return vec4(col, edge);                                   // ← alpha IGNORED (see §1.2)
```

**Does the impostor know the sun direction? YES, and the geometry is correct.**
`(p.x, p.y, domeZ)` is the unit normal of a sphere seen head-on, and
`uSpR/uSpU/uSpF` are the sun direction projected onto the billboard basis
(`CelestialBody.tsx:365-403`). So a distant Venus **does** compute a proper
crescent/gibbous terminator. What the *player* sees is a different matter: at 0.037 px the
disc is invisible next to the point sprite, and the point sprite is radially symmetric —
its only phase dependence is the *scalar* Lambert Φ(α) in its brightness
(`StellarPoint.tsx:243-246`). **So no, a distant Venus does not show a crescent. It shows
a uniform round blob whose total brightness happens to respect the phase law.**

Because `edge` is discarded (§1.2), the visible silhouette is a **hard binary circle** at
`dist ≈ 0.9954` (solving `smoothstep = 0.01`). The 8%-of-radius soft rim the author wrote
is thrown away. **[MEASURED in the three.js path]**

**Billboard-basis bug for Luna.** `billboardMode` (`types.ts:151`, default
`"camera-space"`) selects between two basis constructions:

```ts
// camera-space (correct): CelestialBody.tsx:365-384
const qInv    = camera.quaternion.clone().invert();
const sdView  = sunDirWorld.applyQuaternion(qInv);
const bodyView= _shipToBody.clone().applyQuaternion(qInv);
const fw = bodyView.negate().normalize();
const ru = Math.abs(fw.y) > 0.99 ? X : Y;   // in CAMERA space Y *is* the camera up
const ri = cross(ru, fw); const up = cross(fw, ri);

// world-space (Luna only, luna.ts:131): CelestialBody.tsx:385-403
const sd = sunDirWorld;                      // NOT rotated into view space
const fw = shipToBody.negate().normalize();  // WORLD vector
const ru = WORLD (0,1,0);
const ri = cross(ru, fw); const up = cross(fw, ri);
```
The **vertex shader is the same in both modes** (`useFarLOD.ts:75-81`), i.e. the quad is
always screen-aligned. In `"world-space"` mode `ri`/`up` are ecliptic-frame axes, so the
terminator's **roll about the view axis is locked to the world frame and does not follow
camera roll**. `uSpF` (the fraction that decides full/new phase) is identical in both
modes; only the crescent's orientation is wrong. **Luna is the only body using this mode,
and the Moon is one of the two bodies the user reported as wrong.** **[CODE + INFERRED —
the geometric argument is airtight; I could not run it]**

**Per-body eyeballed billboard constants:**

| Site | Constant | Note |
|---|---|---|
| `venus.ts:78` | `sunDot·0.75 + 0.25` | 25% ambient wrap; also on the sphere tier (`:55`) |
| `venus.ts:26` | `VENUS_ALBEDO (0.70,0.52,0.28)` | R:B = **2.5** → renders **orange**. Real Venus is creamy white (B−V ≈ +0.82). The mid texture is worse: measured R:B = **3.57**. **[MEASURED]** |
| `earth.ts:477` | `vec3(0.38,0.42,0.80).mul(2.0)` | peak **1.60**, i.e. **above the bloom threshold of 1.0** → distant Earth blooms. `EARTH_FAR_ALBEDO` (`:493`) is dead — the comment at `:491-492` admits it. |
| `earth.ts:481-483` | rim `vec3(0.3,0.5,0.9) × clamp((1−domeZ)·2.5) × 0.2` | fake atmosphere |
| **`mars.ts:109-110`** | **`hazeColor = vec3(12.0, 0.1, 0.05)`** × rim × `sunDot` × 0.2 | **peak red = 2.4, i.e. 2.4× the bloom threshold.** A red-channel value of 12.0 in a [0,1] albedo shader is almost certainly a `1.2` typo. Distant Mars gets a blooming red ring. **[CODE]** |
| `jupiter.ts:109-110` | `vec3(0.7,0.55,0.35) × rim × 0.06` | |
| `jupiter.ts:102`, `saturn.ts:196` | `pow(domeZ, 0.4)` | limb darkening |
| `saturn.ts:194`, `uranus.ts:95`, `neptune.ts:95` | `sunDot·0.85+0.15` / `·0.8+0.2` | ambient wrap |
| `uranus.ts:96`, `neptune.ts:96` | `pow(domeZ, 0.35)` | |
| `luna.ts:32` | `LUNA_ALBEDO (0.44,0.42,0.40)` | ~3.5× the Moon's real albedo **[MEASURED]** |

**Is apparent magnitude / solid angle / phase angle / albedo used anywhere in the disc
impostor?** Albedo: yes (a hand-tuned constant). Phase: yes, geometrically, via
`uSpR/uSpU/uSpF`. Solid angle: implicitly, via the physically-sized quad. Apparent
magnitude: **no**. Irradiance / heliocentric distance: **no** — Mercury's billboard and
Neptune's billboard are lit identically.

### 3b. The point impostor (`StellarPoint.tsx`)

```ts
const STELLAR_PX_THRESHOLD = 8;    // :58  CSS px, eyeballed
const MIN_SCREEN_PX        = 6;    // :62  CSS px, eyeballed
const REFERENCE_HDR        = 12.0; // :67  "Jupiter at opposition ≈ mag −2.5", eyeballed
const JUPITER_REF_FLUX = (() => {  // :74-80
  const p = 0.538, R = 69_911, dSun = 5.2*AU_KM, dCam = 4.2*AU_KM;
  return (p * R * R) / (dSun * dSun * dCam * dCam);     // = 1.100693e-26
})();
```

Per frame (`:200-278`):
```ts
const distKm = |bodyKm − shipKm|;                                        // :207
if (distKm < 1) { hide; return; }                                       // :208-211
const fovRad = cam.fov * π/180;                                         // :215
const screenH = Math.max(window.innerHeight, 1);                        // :216  ← CSS px
const angularDiameter = (radiusKm*2)/distKm;                            // :217
const pixelDiameter   = (angularDiameter/fovRad)*screenH;               // :218  ← 1.172× too big
const visible = pixelDiameter < STELLAR_PX_THRESHOLD;                   // :221
const cosPhase  = normalize(bodyToSun) · normalize(bodyToCam);           // :235
const phaseAngle= acos(clamp(cosPhase));                                // :236
const phase = (1/π)·((π−α)·cos α + sin α);          // Lambert sphere    // :243-246
const flux  = (p · R² · Φ) / (dSun² · dCam²);                           // :250-252
const hdr   = (flux / JUPITER_REF_FLUX) * REFERENCE_HDR;                // :255
const t = (8 − pixelDiameter)/8;  const fade = t*t;                     // :267-268
uBrightness.value = Math.min(hdr * fade, 500);                          // :271   ← eyeballed clamp
const minAngle = (MIN_SCREEN_PX/screenH)*fovRad;                        // :275
uScale.value   = 2 * distScaled * Math.tan(minAngle*0.5);               // :276-277
```

Fragment (`:170-193`):
```ts
const coreFalloff = clamp((0.2 − dist)/0.2, 0, 1);  const core = pow(coreFalloff, 1.2);
const haloFalloff = clamp((0.6 − dist)/0.6, 0, 1);  const halo = pow(haloFalloff, 2.5).mul(0.4);
const intensity = core.add(halo).mul(uBrightness);
const col = uColor.mul(intensity);
const alpha = clamp(core.add(halo.mul(2.0)), 0, 1);   // ← IGNORED (opaque, alphaHash dead)
return vec4(col, alpha);
```

**What is physically right here:**
- The Lambert phase function is textbook-correct, and Φ(0) = 1 is the right normalisation
  to pair with a *geometric* albedo.
- `flux ∝ p·R²·Φ/(dSun²·dCam²)` is the correct proportionality for a resolved-to-
  unresolved reflecting sphere.
- Rendering a fixed-solid-angle sprite whose *radiance* ∝ flux is dimensionally correct
  for an unresolved source (E = L·Ω with Ω fixed).
- `getFilmHeight()`-free, allocation-free, uses scratch vectors. Clean.

**What is wrong:**

1. **`REFERENCE_HDR = 12.0` is 68–86,000× too large** relative to the disc tier it is
   supposed to continue (§2 table). Its stated justification — "Jupiter at opposition ≈
   mag −2.5" (`:64-66`) — anchors the scale to a *magnitude*, but nothing else in the
   engine has a magnitude scale, so the anchor is unfalsifiable.
2. **`geometricAlbedo` is not a geometric albedo.** `luna.ts:151` ships **0.0036**;
   the Moon's real value is **0.12**. `git show f9328ee` ("adjust earth and moon
   brightness", 2026-04-22) changed it from `0.136` → `0.0036` — a **37.8× eyeballed
   reduction of a field the type documents as "Geometric albedo (0–1). Determines
   opposition brightness"** (`StellarPoint.tsx:96`, `types.ts:56`). **[MEASURED from git]**
   Every other body keeps a plausible value (`venus.ts:101` 0.689, `jupiter.ts:130`
   0.538, `mercury.ts:76` 0.142, `mars.ts:131` 0.170, `earth.ts:529` 0.434), so Luna is
   the lone poisoned entry — and its per-body error is exactly what makes the
   Moon-vs-Venus comparison fail (§7).
3. **`fade = t²` is a non-physical brightness multiplier of up to 69× applied by screen
   size.** At Luna's real distance `fade = 0.0143`; at Venus's, `fade = 0.9907`. Same
   frame, same formula, **69× differential penalty** against the Moon. This is the single
   largest contributor to the Moon/Venus inversion.
4. **`Math.min(…, 500)` (`:271`)** hard-clips a quantity that physically spans ~10 orders
   of magnitude. With the *physical* lunar albedo the clamp binds immediately
   (`hdr·fade` = 120,413 × 0.0143 = **1,726 → clamped to 500**), i.e. the formula's output
   is already saturated for the Moon. The comment "Venus at inferior conjunction can
   spike" is **wrong about the mechanism**: at inferior conjunction α → 180° so Φ → 0 and
   the flux *vanishes*. The clamp actually binds on close approach to any body.
   **[COMMENT contradicted by CODE]**
5. **The sprite writes black.** No `Discard`; `alphaHash` dead; `transparent = false` →
   three disables blending (`WebGPUPipelineUtils.js:123`: the guard requires
   `blending !== NormalBlending || transparent !== false`, and this material is
   `NormalBlending` + `transparent === false`). Beyond `dist = 0.6` both `core` and `halo`
   are 0, so the shader outputs `vec3(0)` **opaquely, with `depthWrite = true`**
   (`:136-137`) over a 6-CSS-px square. **[MEASURED in the three.js path]**
6. **The bright core is ~1 CSS px wide.** `dist < 0.2` of a 3-px sprite radius = **0.6 px
   radius**. So the peak value (up to `1.4 × 500 = 700` HDR) lives in about one pixel,
   whose sampled value depends on sub-pixel placement → **bloom flicker**. This is
   precisely the failure `Star.tsx:78-80` documents avoiding ("moderate enough that
   sub-pixel drift doesn't cause visible bloom flicker") — and `StellarPoint`
   reintroduces it. **[CODE + INFERRED]**
7. **`uColor` is a third, independent albedo.** `stellarPoint.color` (`types.ts:57`) is a
   hand-picked tint that need not match `far.albedo` *or* the texture. Luna:
   `(0.85,0.82,0.78)` for the point vs `(0.44,0.42,0.40)` for the disc — the disc is
   1.9× darker *and* differently tinted. Venus: `(1.0,0.97,0.85)` (correctly whitish!) for
   the point vs `(0.70,0.52,0.28)` (orange) for the disc. **So Venus changes hue as it
   crosses 8 px.** **[CODE]**
8. **CSS px vs device px.** `screenH = window.innerHeight` (`:216`) is CSS pixels; the
   render target is `size.{w,h} × gl.getPixelRatio()` with `dpr ∈ [0.5, 1.5]`
   (`Scene.tsx:154`; `SpaceRenderer.tsx:328-333`). Brightness *per CSS pixel* is
   dpr-invariant (the sprite's angular size is CSS-derived, so its CSS footprint is
   fixed) — but the **structure** is not: at `dpr = 0.5` the 1.2-CSS-px core is
   **0.6 device px** and disappears or dithers; at `dpr = 1.5` the handoff at 8 CSS px
   happens while the disc is still **12 device px** and clearly resolved, so a resolved
   disc gets a glowing sprite stamped inside it. `window.innerHeight` is also not the
   canvas height — any HUD chrome above/below the canvas biases every number.
9. **Frustum-culling bounding sphere is 1370× too small.** The geometry is
   `PlaneGeometry(1,1)` → bounding-sphere radius 0.707 scaled units = 707 km, but the
   rendered sprite half-extent is `uScale/2` (970 scaled units = 970,000 km for Venus).
   `Object3D.frustumCulled` defaults to `true`, so the sprite is culled the instant its
   **centre** leaves the frustum → a hard ~3-px pop at the screen edge. **[CODE + INFERRED]**
10. **No 1/dSun² on its companion tier**, as covered in §2 — the point tier is the *only*
    far-field renderer that knows the star's distance, which is why it cannot be
    reconciled with the others by a constant.

---

## 4. Q3 — THE STARFIELD

**There is no procedural starfield in the running game.**

`src/components/Stars/StarsComponent.tsx:1` — `// Deprecated: using image-based stars for
realistic star positioning`. A repo-wide grep for `StarsComponent` finds **only its own
definition and export** — it is imported nowhere. `Scene.tsx:104-125` mounts
`<MilkyWaySkybox />` and the 14 bodies; no `<Stars>`. **[CODE]**

For the record, had it been mounted: drei `<Stars radius={100_000} depth={500}
count={20_000} factor={2_000} saturation={0} fade speed={0} />`
(`StarsComponent.tsx:30-40`) generates **random** positions and **random** sizes — no
catalogue, no magnitudes — and `radius = 100_000` scaled units = 1e8 km = 0.67 AU, i.e.
*inside* Jupiter's orbit. It is right that it is unused.

So, answering the question as asked:

- **How are star brightnesses assigned?** They are not. They are 8-bit sRGB texels in
  `public/assets/8k_stars_nasa.ktx2`. **[MEASURED]**
- **Real catalogue magnitudes or random?** Neither — baked image pixels. Whatever
  magnitude information exists was destroyed by the source image's own tone curve.
- **Mapping magnitude → rendered luminance?** None. The chain is
  `sRGB 8-bit → linear [0,1]` (the texture is tagged `THREE.SRGBColorSpace`,
  `MilkyWaySkybox.tsx:22`), then straight into the scene RT. Decoded distribution:

  | statistic | value |
  |---|---|
  | dimensions | 8192 × 4096, 14 mip levels, UASTC/Basis, Zstd (`vkFormat 0`, `supercompression 2`) |
  | max sRGB channel | **255** → linear **1.000** |
  | pixels ≥ 250/255 | **204** (0.00061%) |
  | pixels ≥ 200/255 | 1,059 |
  | pixels ≥ 128/255 | 5,201 |
  | sRGB value at top-1e-4 fraction | 148 → linear 0.216 |
  | median sRGB | 6 |
  | **mean linear luminance** | **2.6247e-3** |

  So the whole "starfield" occupies a **linear dynamic range of about 1:1** — 204 pixels
  at 1.0 and everything else below 0.58. Real naked-eye stars span **~10,000:1** in flux
  (mag −1.5 to +6.5). The range is not compressed, it is *absent*. **[MEASURED]**
- **Point-spread / glare?** Only whatever the source image baked. The engine's bloom is
  `bloom(sceneTexture, 0.02, 0, 1)` (`SpaceRenderer.tsx:516`) = strength **0.02**,
  radius **0**, threshold **1.0** (`BloomNode.js:532` signature). Only the 204 pixels at
  exactly linear 1.0 can bloom at all, at 2% strength with zero radius — i.e.
  **effectively no glare on any star.** **[MEASURED]**
- **How does dpr affect it?** The panorama **is** mip-filtered, contrary to what the
  source suggests. `MilkyWaySkybox.tsx:24-26` sets `generateMipmaps = false;
  minFilter = LinearFilter`, which on a WebGL backend would pin sampling to mip 0. On
  three's **WebGPU** backend: `Textures.needsMipmaps()` returns true because
  `texture.mipmaps.length > 0` (`Textures.js:467`) — the KTX2 carries 14 baked levels —
  and `getMipLevels()` returns 14 (`Textures.js:433-435`), so the GPU texture is created
  with `mipLevelCount: 14` (`WebGPUTextureUtils.js:291`); and the sampler sets
  **`mipmapFilter: this._convertFilterMode(texture.minFilter)`**
  (`WebGPUTextureUtils.js:124`) — i.e. `LinearFilter` → `'linear'` → **trilinear**.
  `anisotropy` is left at the default 1 (`:125,139-143`). **[MEASURED in the three.js
  path]**
  Consequence: lowering `dpr` (0.5–1.5, `Scene.tsx:154`) raises the sampled mip level, and
  because a "star" is 1–2 texels, mip-averaging **dims individual stars roughly ∝ 1/dpr²**.
  Star brightness in this game is a function of window size and device pixel ratio. It is
  also a function of FOV. Neither is a property real stars have.

`tex.mapping = THREE.EquirectangularReflectionMapping` (`MilkyWaySkybox.tsx:23`) is a
no-op: `mapping` is only consulted for environment maps, and this texture is bound to the
`map` slot of a sphere with its own UVs. Harmless, but it advertises intent the code does
not implement. **[COMMENT/CODE mismatch, cosmetic]**

---

## 5. Q4 — THE MILKY WAY SKYBOX

```tsx
// MilkyWaySkybox.tsx:16-54
url = "/assets/8k_stars_nasa.ktx2"
tex.colorSpace = THREE.SRGBColorSpace;                       // :22
const geo = new THREE.SphereGeometry(1, 64, 32); geo.scale(-1,1,1);   // :30-32
const mat = new THREE.MeshBasicMaterial({ map: tex, side: FrontSide,
  depthWrite: false, toneMapped: false });                    // :34-39
<mesh scale={[1e6, 1e6, 1e6]} frustumCulled={false} renderOrder={-1000} />  // :50-53
```

**Texture:** `public/assets/8k_stars_nasa.ktx2`, 24.6 MB, 8192×4096, 14 mips,
UASTC + Zstd. **[MEASURED — KTX2 header parsed]** (Three unused predecessors sit next to
it: `8k_stars.webp`, `8k_stars_milky_way.webp`, `8k_stars_nasa.webp`.)

**Brightness scale:** sRGB 8-bit decoded to linear **[0, 1]** — the full statistics are in
§4. It is authored at **exactly SDR display levels**, i.e. "looks nice on a monitor with
the sky filling the frame". **[MEASURED]**

**Is it tone-mapped consistently with the rest of the scene?** Yes — but *not* because of
anything in this file. `toneMapped: false` (`:38`) is **inert**: the scaled scene is
rendered with `renderer.toneMapping = NoToneMapping` (`SpaceRenderer.tsx:671`), and tone
mapping is then applied **to the whole render target** inside the node graph
(`SpaceRenderer.tsx:525-526`: `hdr.toneMapping(AgX | Neutral)`). Nothing can opt out of a
full-screen tone map. So the flag documents an intention that the architecture forbids.
**[COMMENT contradicted by CODE]**

**Would it survive auto-exposure? No — it would be the first thing to break.**
Anchoring on the engine's own surface convention (a Lambertian surface at 1 AU with
reflectance 1.0 reads 1.0, so **1 engine unit ≡ 127,000/π = 40,425 cd/m²**):

| | engine value | implied luminance | real luminance | error |
|---|---|---|---|---|
| panorama peak pixel | 1.000 | 40,425 cd/m² | ~2.7e-4 cd/m² (21.5 mag/arcsec²) | **1.49e8× = 20.4 mag** |
| panorama mean | 2.62e-3 | 106 cd/m² | ~1e-4 cd/m² | ~1e6× |
| Moon disc (billboard) | 0.4228 | 17,092 cd/m² | 4,851 cd/m² (ρ=0.12 at 1 AU) | 3.5× |
| galaxy peak ÷ Moon disc | **2.37×** | — | should be **1/1.79e7** | **19.1 mag** |

**[MEASURED + INFERRED]**

That last row is the answer to "why doesn't it look like real life". In reality the Moon
obliterates the Milky Way; in this engine **the Milky Way is 2.4× brighter than the
sunlit Moon**. Any auto-exposure metering the frame would key off the galaxy, not the
planets.

Three anchors exist in the codebase and they disagree with each other, which is why no
number above can be called definitive:

| anchor | derivation | 1 engine unit ≡ | vs anchor A |
|---|---|---|---|
| **A** surface reflectance (`rockyFragment.ts:52`, all billboards) | ρ=1 at 1 AU → 127,000/π cd/m² | 40,425 cd/m² | 1× |
| **B** atmosphere `SUN_ILLUM_GAME_1AU = 21.2` (`atmosphereData.ts:69`) | 21.2 units ≡ 127,000 lx | 5,991 lx → a ρ=1 Lambert surface should read **6.75** | surface shader is **6.75× too dim** on this scale |
| **C** `Star.tsx:80 CORE_HDR = 4096` | solar disc ≈ 1.6e9 cd/m² | 3.91e5 cd/m² | Sun disc is **9.66× too dim** vs A |

Depth/ordering notes: `depthWrite: false` + `renderOrder = -1000` (`:51-53`) makes the
skybox a safe first draw. But its radius is `1e6` scaled units = **1e9 km = 6.7 AU**,
which is *inside* the modelled solar system — Saturn sits at 1.56e6 scaled units from
Earth, i.e. **outside the "sky"**. It happens to work only because the sphere writes no
depth. Uranus and Neptune are outside the *camera far plane* as well (§6), so they are
gone for a different reason. **[MEASURED from `sol.json`]**

---

## 6. Q5 — SUB-PIXEL AND ALIASING BEHAVIOUR

### Is there any AA? No.

| candidate | status |
|---|---|
| MSAA on canvas | `new THREE.WebGPURenderer({ canvas, powerPreference, logarithmicDepthBuffer, trackTimestamp })` (`Scene.tsx:160-165`) — **no `antialias`**, default `false` (`Renderer.js:101`) → `_samples = 0` (`Renderer.js:275`). |
| MSAA on offscreen RTs | `new RenderTarget(w, h, { type: HalfFloatType, depthBuffer: true })` (`SpaceRenderer.tsx:329-333, 345-349`) — `samples` unset → default **0** (`RenderTarget.js:62`). |
| FXAA / SMAA | grep: absent. |
| TAA / TRAA | absent for the scene. The only temporal filter is the **cloud** reconstruction (`cloudReconstructionPass.ts`, `SpaceRenderer.tsx:151-166, 413-417`), which reads only the cloud RTs. |
| dither | `OUTPUT_DITHER_LSB = 1.0` (`SpaceRenderer.tsx:149, 527-531`) — an 8-bit banding fix applied *post*-tonemap. Irrelevant to geometry aliasing. |

**[MEASURED in the three.js source]**

### What happens to a body at 0.3 px?

Take Venus's actual apparent size in-engine (0.037 px) or any body at 0.3 px:

1. **The far billboard** is still `visible` (`showFar` is true for every body beyond
   `lod.far`). Its quad is `0.3 × 1.05 = 0.315` px across. With `samples = 0`,
   rasterisation is a binary pixel-centre test → the disc lights **one** pixel in ~7.8% of
   frames and **zero** in ~92%, at full surface brightness when it hits. Because the
   camera is in continuous motion (floating origin slides every frame,
   `SpaceRenderer.tsx:315-321`), that is a **hard per-frame on/off flicker**. There is no
   MSAA, no TAA, and — because `alphaHash` is dead (§1.2) — not even the stochastic
   dither the author intended.
2. **The point sprite** is also visible (`0.3 < 8`), pinned at 6 CSS px, `fade = 0.927`.
   It is spatially stable. Its **1-px core** at up to 700 HDR is *not* value-stable:
   `pow(clamp((0.2−dist)/0.2), 1.2)` over a 0.6-px radius means the sampled peak depends
   on sub-pixel placement, and it sits above the bloom threshold → **bloom flicker**.
3. Net: the visible artefact is *not* the disc (it is 2% of the sprite's core) but the
   sprite's own core scintillation.

### The five distinct flicker mechanisms this code invites

| # | mechanism | citation | severity |
|---|---|---|---|
| F1 | **Hard binary disc silhouette.** `edge` alpha is discarded (§1.2), so the disc's rim is a step at `dist ≈ 0.9954` with `samples = 0`. For the 7.0-px Moon the intended soft rim was 8% of the radius = **0.28 px** — sub-pixel either way. The rim crawls by ±1 px as the ship moves. | `useFarLOD.ts:33-34`, `NodeMaterial.js:560,930` | **high** — this is the "distant bodies shimmer" symptom |
| F2 | **Sub-pixel disc pixel-centre lottery.** As above. | `Scene.tsx:160-165` | high below ~1 px, but masked by the sprite |
| F3 | **1-px bloom core on the point sprite.** | `StellarPoint.tsx:175-176, 271` | medium–high |
| F4 | **Wrong log depth on the far billboard → orientation-dependent occlusion of the point sprite.** `useFarLOD.ts` sets a custom `vertexNode` but **no `depthNode`**, so three falls back to `viewZToLogarithmicDepth(positionView.z, …)` (`NodeMaterial.js:727-731`), where `positionView` comes from the **untransformed plane geometry**, not from the camera-space quad the vertex shader actually emits. The quad lies in the body's local XY plane, so its vertices' view-z spreads by up to `±1.41 × scaledRadius × 1.05` depending on camera orientation (±2,571 km for the Moon at 376,869 km). `StellarPoint` computes its depth **correctly** (`:158-167`) — and its header comment (`:16-21`) documents exactly this hazard without fixing it for `useFarLOD`. Draw order is deterministic (`painterSortStable`: equal `z` → `a.id - b.id`, `RenderList.js`; the billboard's material/mesh are created first, `CelestialBody.tsx:451` before `:457`), so the sprite draws second and wins where its depth ≤ the billboard's — i.e. over roughly the half of the quad that slopes away. **The result is a black notch on one side of every 6-px sprite that sits inside a disc, sweeping around as the camera rotates.** | `useFarLOD.ts:66-87`, `NodeMaterial.js:711-747`, `SpaceRenderer.tsx:65` | **high, and it is a visible artefact, not just flicker** |
| F5 | **Skybox minification.** Trilinear, `anisotropy = 1` (§4). Star texels shimmer at the panorama's poles and under fast rotation. | `MilkyWaySkybox.tsx:24-26`, `WebGPUTextureUtils.js:124-143` | low–medium |

Note on F4's premise: `SpaceRenderer.tsx:65` says *"(Don't use logarithmicDepthBuffer — it
breaks depth for custom vertexNode.)"*, but `Scene.tsx:163` constructs the renderer with
`logarithmicDepthBuffer: true`. **The comment is stale and the hazard it warns about is
live.** **[COMMENT contradicted by CODE]**

### Frustum / far-plane clipping of the outer planets

`SCALED_CAMERA_FAR = 2_000_000` scaled units = **2e9 km = 13.4 AU** (`:67`).
Distances from the spawn point (`sol.json startingPositionKm =
[-130002822, 175, -65000194]`):

| body | distance (km) | scaled units | inside `far = 2e6`? |
|---|---|---|---|
| Earth | 16,746 | 16.7 | ✔ (near tier, 581 px) |
| Luna | 376,869 | 377 | ✔ |
| Mars | 8.341e7 | 8.34e4 | ✔ |
| Mercury | 1.989e8 | 1.99e5 | ✔ |
| Venus | 2.468e8 | 2.47e5 | ✔ |
| Jupiter + moons | 7.47e8 | 7.47e5 | ✔ |
| Saturn | 1.561e9 | 1.56e6 | ✔ (78% of the far plane) |
| **Uranus** | **3.0007e9** | **3.00e6** | ✘ **clipped** |
| **Neptune** | **4.6305e9** | **4.63e6** | ✘ **clipped** |

Both culling paths agree: `Object3D.frustumCulled` defaults true and `Frustum` includes
the far plane, and even if culling were bypassed the vertex stage clips on `z/w > 1`.
Their POI markers still render (`sol.json` markers: `maxDistanceKm: 5e10`;
`POIProjector.tsx:130`), so the HUD shows a labelled diamond with a distance pointing at
nothing. **[MEASURED + CODE]**

### HUD markers (`POIProjector.tsx`, `POIMarkers.tsx`)

Not a lighting concern, and correctly implemented for what it does: distance-gated
(`:130`), projected through the **local** camera with distant positions renormalised to
`camera.far * 0.5` so the projection matrix cannot clip the *direction*
(`:139-146`), NDC → screen (`:149-159`), written to a mutable `poiBuffer` and flushed to
pooled DOM in the same frame (`POIMarkers.tsx:29-32, 145`). `localCamera` and
`scaledCamera` share position, orientation, fov and aspect (`SpaceRenderer.tsx:554-555,
663-664`), so marker positions agree with rendered positions. The one issue is the
mismatch called out above: markers are gated on `maxDistanceKm` from `sol.json`, the
bodies on `lod.far` and `SCALED_CAMERA_FAR`, and nothing keeps the three consistent.
`Navigation.tsx` is a touch/keyboard input switch only — no rendering.

---

## 7. Q6 — THE WORKED CASE: VENUS AND THE MOON, SEEN FROM EARTH

### Geometry, from `sol.json` (single source of truth)

```
sol    r=696340  at [0, 0, 0]
earth  r=6371    at [-129995000, 0, -65015000]      → 0.9716 AU from the Sun
luna   r=1737    at [-130379400, 0, -65015000]      → 384,400 km from Earth ✔
venus  r=6052    at [ 108060000, 0,        0]      → 0.7223 AU from the Sun ✔
spawn           at [-130002822, 175, -65000194]     → 16,746 km from Earth centre (alt 10,375 km)
```

From spawn:

| | Luna | Venus |
|---|---|---|
| distance | 376,869 km | 2.46777e8 km = **1.6496 AU** |
| phase angle α (sun–body–camera) | **24.25°** | **15.27°** |
| Lambert Φ(α) | 0.9197 | 0.9667 |
| true angular diameter | 9.218 mrad = **31.7′** | 49.05 µrad = **10.1″** |
| `pixelDiameter` as coded (`/fovRad`) | **7.0421 px** | **0.0375 px** |
| `pixelDiameter` geometrically correct (`/2tan(fov/2)`) | 6.007 px | 0.0320 px |
| tier selected | `distKm > lod.far (250,000)` → **far billboard** | `> 350,000` → **far billboard** |
| `StellarPoint` visible? | 7.04 < 8 → **yes** | 0.0375 < 8 → **yes** |

So **both** bodies render as *billboard + point sprite simultaneously*, and the Moon —
the body whose 8k texture, displacement map and Sobel bump shader all exist
(`luna.ts:134-141, 43-111`) — **is never allowed to use them from Earth**, because
`lod.far = 250,000 km < 384,400 km`.

Venus's target magnitude is worth checking against the config: V ≈ −4.47 + 5·log₁₀(0.7223
× 1.6496) + phase ≈ **−4.0**, matching the −4.1 in the brief. Good — the *positions* in
`sol.json` are right. Everything that follows is a shading error, not a geometry error.

### What the code computes

`JUPITER_REF_FLUX = (0.538 × 69911²)/((5.2·AU)² (4.2·AU)²) = **1.100693e-26**`
(`StellarPoint.tsx:74-80`).

**Luna** (`geometricAlbedo = 0.0036`, `luna.ts:151`):
```
flux = 0.0036 × 1737² × 0.9197 / ((1.4569e8)² × 376869²) = 3.3126e-24
hdr  = 3.3126e-24 / 1.100693e-26 × 12.0                  = 3,612.4
t    = (8 − 7.0421)/8 = 0.11974        fade = t² =  0.014338
uBrightness = min(3612.4 × 0.014338, 500)                =    51.79
```
**Venus** (`geometricAlbedo = 0.689`, `venus.ts:101`):
```
flux = 0.689 × 6052² × 0.9667 / ((1.0806e8)² × (2.46777e8)²) = 3.4298e-26
hdr  = 3.4298e-26 / 1.100693e-26 × 12.0                      =    37.40
t    = (8 − 0.0375)/8 = 0.99531        fade = t² =  0.990654
uBrightness = min(37.40 × 0.990654, 500)                     =    37.05
```

Integrating the sprite profile (`core + halo` over the 6-px disc, radius 3 px) gives
**0.8383 px² per unit `uBrightness`**; integrating the billboard disc gives
`π·(px·1.05/2)² · lum(albedo) · ⟨cos i⟩`:

| | Luna | Venus |
|---|---|---|
| point sprite | 0.8383 × 51.79 = **43.42** | 0.8383 × 37.05 = **31.06** |
| far billboard | π(7.0421·1.05/2)² × 0.4228 × 0.62 = **11.26** | π(0.0375·1.05/2)² × 0.5409 × 0.75 = **4.9e-4** |
| **total (engine·px²)** | **54.68** | **31.06** |

### Why this is wrong — three independent ways

**(i) The relative brightness is inverted by a factor of ~820.**

```
engine  Luna / Venus = 54.68 / 31.06 = 1.760×   →  −0.61 mag
```
The engine's own Lambert model, run with the **physical** lunar albedo 0.12, says:
```
Lambert Luna / Venus = 3,219×  →  −8.77 mag
```
and reality (Moon at α = 24° ≈ −11.9, Venus ≈ −4.0) says **7.9 mag ≈ 1,300×**.

**Error = 1,829× = 8.16 mag against the engine's own model, ~820× = 7.29 mag against
reality.** Decomposition:

| cause | factor against the Moon | citation |
|---|---|---|
| `geometricAlbedo` 0.0036 instead of 0.12 | **33.3×** | `luna.ts:151` (git `f9328ee`: was 0.136) |
| `fade = t²` — Luna 0.0143 vs Venus 0.9907 | **69.1×** | `StellarPoint.tsx:267-268` |
| (partly offset by the Moon's far billboard contributing 11.26) | ÷1.26 | `useFarLOD.ts` |
| **net** | **1,829×** | |

Neither of the two dominant factors has any physical content. `fade` is a **function of
screen size only** — it penalises the Moon 69× *because the Moon is bigger*.

**(ii) The absolute levels are also wrong, by different amounts.** Using anchor A
(1 engine unit ≡ 40,425 cd/m²) and pixel solid angle Ω = (2tan37.5°/1000)² = 2.355e-6 sr,
sprite illuminance E = Σ L·Ω:

| | engine E (lx) | effective magnitude | real magnitude | error |
|---|---|---|---|---|
| Venus | 2.957 | **−15.17** | −4.0 | **29,245× = 11.17 mag too bright** |
| Luna | 5.206 | **−15.78** | −11.9 | **35.6× = 3.88 mag too bright** |

Both far too bright; Venus 11.2 mag too bright, the Moon "only" 3.9. **The engine renders
Venus at very nearly the brightness of the full Moon.** That is the user's complaint,
quantified.

**(iii) The sky is brighter than the Moon.** From §5: the panorama's peak pixel is
**2.37× brighter** than the Moon's disc, where physics wants the Moon **1.79e7×** brighter
— a **19.1 mag** relative error. So even after the two impostor scales are fixed, the
scene will not look real until the skybox comes down by ~20 magnitudes.

### And what the Moon actually looks like on screen

Assembling the mechanisms: at spawn the Moon is a **7.4-px hard-edged flat grey disc**
(F1, no limb darkening, no surge, 5% oversized, terminator roll locked to the ecliptic
frame by the `"world-space"` billboard bug), with a **6-px opaque sprite stamped inside
it** whose outer annulus writes **black** (§3b.5) and whose ~1-px core sits at 1.4 × 51.8
= 72 HDR and scintillates (F3), partially occluded on one side by the billboard's
incorrectly-derived log depth (F4). It is 3.5× too bright in reflectance and 3.9 mag too
bright in integrated flux, against a galaxy that is 20 mag too bright.

For comparison, the LOD table at 1000 px / 75° — what apparent size each body has when
its `lod.far` switch fires:

| body | `lod.far` (km) | disc at the switch, as the code measures it | geometrically true |
|---|---|---|---|
| Luna | 250,000 | **10.62 px** | 9.05 px |
| Mercury | 350,000 | **10.65 px** | 9.09 px |
| Venus | 350,000 | **26.42 px** | 22.53 px |
| Io | 350,000 | 7.95 px | 6.78 px |
| Europa | 350,000 | 6.81 px | 5.81 px |
| Ganymede | 350,000 | **11.50 px** | 9.81 px |
| Callisto | 350,000 | **10.50 px** | 8.96 px |
| Mars | 800,000 | 6.47 px | 5.52 px |
| Earth | 1,500,000 | 6.49 px | 5.54 px |
| Uranus | 12,000,000 | 3.25 px | 2.78 px |
| Neptune | 12,000,000 | 3.13 px | 2.67 px |
| Jupiter | 16,000,000 | 6.68 px | 5.69 px |
| Saturn | 16,000,000 | 5.56 px | 4.74 px |

Two things fall out of this table:
- **The switch size varies 8.5× across bodies** (3.13 → 26.42 px), which is what happens
  when an angular decision is encoded as a distance.
- **Eight of thirteen bodies enter the billboard tier already *below* the 8-px
  point-source threshold** (Io, Europa, Mars, Earth, Uranus, Neptune, Jupiter, Saturn), so
  for them the point sprite is *already fading in* the instant the sphere disappears —
  disc and sprite are never separated. The other five (Venus, Ganymede, Mercury, Luna,
  Callisto) get a band of clean billboard before the sprite starts. In no case is there a
  distance at which exactly one impostor is drawn and the other is off.

### Reproduction script

```js
// node - (verified 2026-08-13; all §7 numbers come from this)
const AU = 149597870.7;
const REF = (0.538 * 69911**2) / ((5.2*AU)**2 * (4.2*AU)**2);       // 1.100693e-26
const fov = 75*Math.PI/180, screenH = 1000, SPRITE = 0.8383;        // px² per uBrightness
function body({R, p, dSun, dCam, phi, albLum, meanCos}) {
  const px = ((2*R/dCam)/fov)*screenH;
  const hdr = (p*R*R*phi)/(dSun*dSun*dCam*dCam)/REF*12;
  const fade = Math.max(0,(8-px)/8)**2;
  const point = SPRITE*Math.min(hdr*fade, 500);
  const disc  = Math.PI*(px*1.05/2)**2*albLum*meanCos;
  return {px, hdr, fade, point, disc, total: point+disc};
}
```

---

## 8. CONSTANT INVENTORY (every hardcoded lighting/brightness/exposure number in this subsystem)

| value | name | site | apparent unit / scale |
|---|---|---|---|
| 8 | `STELLAR_PX_THRESHOLD` | `StellarPoint.tsx:58` | CSS pixels (disc diameter) |
| 6 | `MIN_SCREEN_PX` | `StellarPoint.tsx:62` | CSS pixels (sprite diameter) |
| **12.0** | `REFERENCE_HDR` | `StellarPoint.tsx:67` | engine linear HDR — **the master far-field brightness knob** |
| 1.100693e-26 | `JUPITER_REF_FLUX` | `StellarPoint.tsx:74-80` | km⁻² (p·R²/(dSun²dCam²)); p=0.538, R=69911, 5.2 AU, 4.2 AU |
| 0.2 / 1.2 | core radius / exponent | `StellarPoint.tsx:175-176` | sprite-normalised radius; ⇒ 0.6-px core |
| 0.6 / 2.5 / 0.4 | halo radius / exponent / weight | `StellarPoint.tsx:180-181` | sprite-normalised |
| 2.0 | halo alpha boost | `StellarPoint.tsx:190` | dead (alpha ignored) |
| `t²` | `fade` | `StellarPoint.tsx:268` | dimensionless, screen-size-driven — up to 69× differential |
| **500** | `uBrightness` clamp | `StellarPoint.tsx:271` | engine linear HDR |
| 2.1 | `sizeMultiplier` default | `useFarLOD.ts:59` | quad width / radius ⇒ disc is **1.05×** true size |
| 1.0 / 0.92 | `edge` smoothstep | `useFarLOD.ts:33` | disc-normalised radius; **discarded** |
| 0.01 | `Discard` threshold | `useFarLOD.ts:34` | alpha ⇒ hard rim at r = 0.9954 |
| `(0.44,0.42,0.40)` | `LUNA_ALBEDO` | `luna.ts:32` | linear reflectance; texture mean is `(0.504,0.478,0.463)`, real ρ = 0.12 |
| **0.0036** | Luna `geometricAlbedo` | `luna.ts:151` | "geometric albedo (0–1)" — real 0.12; was 0.136 (git `f9328ee`) |
| 0.002 / `(0.55,0.65,1.0)` | earthshine / tint | `luna.ts:100-101` | engine reflectance |
| 3.0 / 0.12 | opposition-surge exponent / weight | `luna.ts:98` | |
| `(0.70,0.52,0.28)` | `VENUS_ALBEDO` | `venus.ts:26` | linear reflectance; R:B = 2.5 → too orange |
| 0.75 / 0.25 | Venus light wrap | `venus.ts:55, 78` | `sunDot·0.75+0.25` |
| 0.689 | Venus `geometricAlbedo` | `venus.ts:101` | correct |
| `(0.38,0.42,0.80)` × **2.0** | Earth billboard albedo | `earth.ts:477` | peak **1.60** > bloom threshold 1.0 |
| `(0.3,0.5,0.9)` × 0.2 / 2.5 | Earth fake rim | `earth.ts:481-483` | |
| `(0.38,0.42,0.80)` | `EARTH_FAR_ALBEDO` | `earth.ts:493` | **dead** (see `:491-492`) |
| **`vec3(12.0, 0.1, 0.05)`** × 0.2 / 2.5 | Mars billboard haze | `mars.ts:109-110` | peak red **2.4** — near-certainly a `1.2` typo |
| `(0.6,0.3,0.15)` | `MARS_ALBEDO` | `mars.ts:32` | |
| `(0.65,0.55,0.40)` / `(0.7,0.55,0.35)` × 0.06 / `pow(domeZ,0.4)` | Jupiter | `jupiter.ts:32,109-110,102` | |
| `(0.62,0.55,0.40)` / 0.85+0.15 / `pow(domeZ,0.4)` | Saturn | `saturn.ts:35,194,196` | |
| `(0.35,0.65,0.70)` / 0.8+0.2 / `pow(domeZ,0.35)` | Uranus | `uranus.ts:31,95,96` | |
| `(0.05,0.12,0.85)` / 0.8+0.2 / `pow(domeZ,0.35)` | Neptune | `neptune.ts:31,95,96` | |
| `(0.35,0.33,0.30)` / `(0.36,0.26,0.14)` / `(0.55,0.52,0.48)` / `(0.45,0.43,0.40)` / `(0.30,0.28,0.25)` | Mercury / Io / Europa / Ganymede / Callisto far albedos | `mercury.ts:75`, `io.ts:21`, `europa.ts:21`, `ganymede.ts:21`, `callisto.ts:21` | |
| 0.142 / 0.63 / 0.67 / 0.43 / 0.22 / 0.170 / 0.434 / 0.538 / 0.499 / 0.488 / 0.442 | `geometricAlbedo` per body | `mercury.ts:76`, `io.ts:22`, `europa.ts:22`, `ganymede.ts:22`, `callisto.ts:22`, `mars.ts:131`, `earth.ts:529`, `jupiter.ts:130`, `saturn.ts:247`, `uranus.ts:118`, `neptune.ts:118` | all plausible — Luna is the outlier |
| 8 | `GLOW_PAD` | `Star.tsx:72` | billboard / star diameter |
| 60 | `MIN_SCREEN_PX` (Sun) | `Star.tsx:76` | CSS px — the Sun's glow keeps a **fixed 60-px footprint at every distance**, so the glow's integrated flux is distance-invariant |
| **4096** | `CORE_HDR` | `Star.tsx:80` | engine linear HDR; ×0.3 inner glow (`:144`), ×8.0 outer (`:149`) |
| 0.35 / 2.5 / 3.5 / 0.5 | Sun glow profile | `Star.tsx:142,144,149,158` | |
| 1080 | `screenH` fallback | `Star.tsx:188` | dead branch — `getFilmHeight()` is always truthy |
| 1e6 | skybox scale | `MilkyWaySkybox.tsx:50` | scaled units = 1e9 km = 6.7 AU (**inside** Saturn's distance) |
| −1000 | skybox `renderOrder` | `MilkyWaySkybox.tsx:53` | |
| `false` | `toneMapped` | `MilkyWaySkybox.tsx:38` | **inert** — tone mapping is full-screen |
| **1.000 / 2.62e-3** | panorama peak / mean linear luminance | `public/assets/8k_stars_nasa.ktx2` | **[MEASURED]** engine linear |
| 0.001 / **2_000_000** | `SCALED_CAMERA_NEAR` / `_FAR` | `SpaceRenderer.tsx:66-67` | scaled units; far = 13.4 AU → clips Uranus & Neptune |
| 0.02 / 0 / **1** | bloom strength / radius / threshold | `SpaceRenderer.tsx:516` | linear HDR threshold |
| AgX \| Neutral | tone mapping mode | `SpaceRenderer.tsx:525-526` | in-graph, whole-frame |
| 1.0 | `OUTPUT_DITHER_LSB` | `SpaceRenderer.tsx:149` | 8-bit LSB |
| [0.5, 1.5] | `dpr` | `Scene.tsx:154` | device pixel ratio clamp |
| 75 | camera `fov` | **not set** — R3F default (`Scene.tsx:152`) | degrees |
| 1.0 | `ATMOSPHERE_EXPOSURE` | `atmosphereData.ts:37` | identity placeholder — the §6 unified pass never landed |
| 21.2 | `SUN_ILLUM_GAME_1AU` | `atmosphereData.ts:69` | game luminance units at 1 AU (**anchor B**) |
| 0.025 | `VENUS_ILLUM_TRIM` | `atmosphereData.ts:271` | the 40× hack; comment `:259-270` diagnoses it correctly |
| 250k … 16M | `lod.far` per body | see §7 table | km — **distance**, not angle |
| 1.5 | `PREFETCH_MULT` | `CelestialBody.tsx:29` | texture prefetch only |

---

## 9. FINDINGS, RANKED

Ranked by how much each one contributes to "distant bodies don't look like real life".

1. **`fade = t²` applies a screen-size-driven brightness penalty of up to 69× and is the
   single largest cause of the Moon/Venus inversion.** `StellarPoint.tsx:267-268`.
   VERIFIED.
2. **Luna's `geometricAlbedo = 0.0036` is a 33× lie in a field the type documents as a
   geometric albedo.** `luna.ts:151`; git `f9328ee` changed 0.136 → 0.0036. VERIFIED.
3. **`REFERENCE_HDR = 12.0` is 68×–86,000× larger than the value that would make the point
   sprite continuous with the disc it replaces, and no single value can work because the
   disc tier has no `1/dSun²` irradiance factor.** `StellarPoint.tsx:67, 251-252` vs
   `useFarLOD.ts:43` / `rockyFragment.ts:52`. VERIFIED (arithmetic).
4. **The Milky Way panorama is ~20 magnitudes too bright and is brighter than the sunlit
   Moon.** `MilkyWaySkybox.tsx:17`, peak linear 1.000 MEASURED. VERIFIED.
5. **`alphaHash = true` is dead on both impostors** → the disc has a hard aliased rim and
   the point sprite writes black over the sky. `useFarLOD.ts:71`,
   `StellarPoint.tsx:138, 170-193` vs `NodeMaterial.js:560, 930`. VERIFIED.
6. **The far billboard writes logarithmic depth derived from the wrong vertices**, so it
   occludes the point sprite in an orientation-dependent pattern. `useFarLOD.ts:66-87`
   (no `depthNode`) vs `NodeMaterial.js:727-731`; the stale warning at
   `SpaceRenderer.tsx:65`. VERIFIED (mechanism); visible artefact LIKELY.
7. **The disc impostor and the point impostor both draw at once, with different albedos
   and different colours.** Venus changes hue at 8 px (`(0.70,0.52,0.28)` →
   `(1.0,0.97,0.85)`). `CelestialBody.tsx:332` vs `StellarPoint.tsx:221`. VERIFIED.
8. **`lod.far = 250_000` for Luna < the 384,400 km Earth–Moon distance**, so the Moon's
   8k texture, displacement map and bump shader are unreachable from Earth.
   `luna.ts:133-141` vs `sol.json`. VERIFIED.
9. **`SCALED_CAMERA_FAR = 2e6` clips Uranus and Neptune out of existence from Earth**,
   while their HUD markers still show. `SpaceRenderer.tsx:67`, `sol.json`. VERIFIED.
10. **No MSAA / FXAA / TAA anywhere in the scaled scene**, so every sub-pixel and
    hard-edged element flickers. `Scene.tsx:160-165`, `SpaceRenderer.tsx:329-333`.
    VERIFIED.
11. **`mars.ts:109` `vec3(12.0, 0.1, 0.05)`** puts a blooming red ring on distant Mars.
    VERIFIED (value); typo LIKELY.
12. **Luna's `billboardMode: "world-space"` shades with a world-frame basis while the quad
    is screen-aligned**, so the Moon's terminator roll ignores camera roll.
    `luna.ts:131`, `CelestialBody.tsx:385-403`, `useFarLOD.ts:75-81`. VERIFIED
    (inconsistency); visible effect LIKELY.
    Note this affects Luna *only*: every other body leaves `billboardMode` unset and
    therefore takes the correct `"camera-space"` branch (`CelestialBody.tsx:295`).
13. **`earth.ts:477` `.mul(2.0)`** pushes distant Earth's billboard to 1.60, above the
    bloom threshold. VERIFIED.
14. **The Moon's mid/near colour texture has a spherical-mean linear reflectance of
    0.4825 against a true geometric albedo of 0.12** — the sphere tier is ~4× too bright,
    and `LUNA_ALBEDO` was hand-matched to it. MEASURED.
15. **Venus's colour texture has a linear R:B of 3.57 (billboard 2.5)**, so Venus renders
    orange instead of creamy white. MEASURED.
16. **`pixelDiameter` uses `fovRad` instead of `2·tan(fov/2)`** — every pixel-size
    decision in `StellarPoint.tsx` and `Star.tsx` is 17% off. `StellarPoint.tsx:218`,
    `Star.tsx:189`. VERIFIED.
17. **`lod.far` is a distance, not an angle**, so the switch fires at 1.6 px for Uranus and
    10.6 px for Luna. Per-body configs, §7 table. VERIFIED.
18. **`StellarPoint`'s frustum bounding sphere is 1370× smaller than its rendered
    sprite**, popping the sprite at screen edges. `StellarPoint.tsx:131` vs `:277`.
    VERIFIED (mechanism).
19. **`Star.tsx`'s `MIN_SCREEN_PX = 60` glow makes the Sun's halo distance-invariant** —
    the Sun's glow is as bright from Neptune as from Earth. `Star.tsx:76, 148-149, 190-195`
    (the *disc* is handled correctly via `uCoreRatio`, `:195`). VERIFIED.
20. **`MilkyWaySkybox`'s `toneMapped: false` and `generateMipmaps = false` both do the
    opposite of what they read as** (full-screen tone map applies anyway; the KTX2's 14
    baked mips are used because three's WebGPU sampler derives `mipmapFilter` from
    `minFilter`). `MilkyWaySkybox.tsx:24-26, 38`; `Textures.js:433-467`,
    `WebGPUTextureUtils.js:124, 291`. VERIFIED.
21. **`StarsComponent.tsx` is dead code** carrying a `radius = 100_000` scaled units
    (0.67 AU) starfield. VERIFIED.
22. **No crossfade or hysteresis on any LOD boundary.** `CelestialBody.tsx:330-336`.
    VERIFIED.
23. **`Math.min(hdr*fade, 500)`'s comment blames inferior conjunction**, where Φ → 0 and
    the flux actually vanishes. `StellarPoint.tsx:270-271`. VERIFIED (comment wrong).

---

## 10. OPEN QUESTIONS

1. **Which anchor is intended?** A (surface reflectance), B (`SUN_ILLUM_GAME_1AU = 21.2`)
   and C (`CORE_HDR = 4096` as the solar disc) disagree by 6.75× and 9.66×. Every absolute
   number in §5 and §7(ii) is anchor-dependent; the *relative* Moon/Venus result in
   §7(i) is not. Fixing the far field needs this decided first — it is the same decision
   `docs/ATMOSPHERE_PLAN.md` §6 defers.
2. **Is `mars.ts:109`'s `12.0` a typo for `1.2`?** Needs the author.
3. **Is the black square from `StellarPoint` actually visible in-game?** The mechanism is
   verified in the three.js source; the depth-test outcome per pixel (F4) determines how
   much of it survives, and I could not run the app to confirm. A one-line falsification:
   add `Discard(alpha.lessThan(0.004))` to `StellarPoint.tsx:192` and see whether the dark
   ring around distant bodies disappears.
4. **Was `fade = t²` introduced to hide the `REFERENCE_HDR` mismatch, or for its own
   reason?** Both it and `REFERENCE_HDR` arrived in `29189a2` "objects glowing in the
   distance"; the fade's own comment (`:257-266`) describes it as "matches fading
   billboard", which is the energy-matching intent — but there is no energy term in it.
5. **Should the sub-8-px case be a point *spread function* rather than a fixed 6-px
   sprite?** A physically-motivated PSF (Airy-ish core + halo, total flux = the computed
   illuminance) would remove `MIN_SCREEN_PX`, `fade` and the 500 clamp in one move, and
   would make the disc→point handoff automatic (integrate the disc's flux, splat it
   through the same PSF). Not attempted here.
6. **Do the fov-dependent formulae need to move to the drawing-buffer resolution?**
   `window.innerHeight` (`StellarPoint.tsx:216`, `Star.tsx:187`) vs
   `size.height × gl.getPixelRatio()`. Related: the 17% `fovRad` error (finding 16).
7. **How should `lod.far` be re-expressed?** An angular threshold (e.g. switch at
   `angularDiameter < X mrad`) would make the switch size-consistent across bodies, but it
   changes texture-streaming distances, so it is a gameplay/perf decision too.
8. **What replaces the panorama?** A ~20-magnitude reduction makes it invisible in SDR.
   Either the sky needs an authored absolute-luminance HDR panorama, or the whole scene
   needs an exposure that places the sky near the tonemap's noise floor — which is the
   real answer, and is again the §6 unified-exposure pass.
