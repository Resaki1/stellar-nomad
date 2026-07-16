# Cloud Shadows, Ship↔Cloud Lighting & God Rays — Implementation Plan

**Created:** 2026-07-13.
**Status:** PLANNED — no code yet.
**Sequence:** these features come BEFORE the remaining CLOUD_TYPES_PLAN phases
(4.8 procedural planets, 4.9 gas giants, 4.10 perf accounting). Everything here
is Earth-specific for now; the per-planet parameterization in 4.8 will absorb
the new uniforms/consts like it absorbs the existing ones.

**Goals (user-stated):**
1. Volumetric clouds cast shadows on the planet surface.
2. Clouds shadow the player ship / affect its lighting (like the atmosphere
   already does via `getAtmosphereLighting()`).
3. The ship casts a (rough) shadow on the clouds.
4. God rays — physically-based, not a screen-space post effect.

**Constraints:** physically-correct where affordable; ≥60 fps on M2 Pro
(ideally 120); build-time consts for toggles (dead branches eliminate);
no per-frame allocations; process-lifetime singleton render targets
(WebGPU bind-group stability); verify each phase in the browser before the
next; `pnpm lint` + `pnpm exec tsc --noEmit` as quality gates (no `pnpm build`
in sandbox).

---

## 1. How the reference engines do it (survey)

All the material below is in `/docs` — pointers included so future sessions
can re-read the sources.

### Frostbite (Hillaire) — the canonical architecture
`docs/VolumetricCloudReferences/Frostbite.md:1312-1345` (§5.9):
- **Cloud shadows = a 2D texture storing transmittance, projected onto the
  world** ("Beer shadow map"). Applied to ALL opaque + transparent surfaces,
  sampled by the particle system, and fed into GI. Their projection "assumes
  an overall flat planet around the camera".
- **Clouds affecting aerial perspective** (§5.9.2, Eq. 22):
  `L_AP = L_AP · Tr_cloud + L_cloud` — atmosphere in-scatter is attenuated by
  cloud transmittance. This *is* god rays when done per-position instead of
  per-camera (our atmosphere march already integrates per-step, so we can do
  the strictly better spatially-varying version).
- Their full 1080p cloud budget: 1.6 ms on XBox One — shadow map cost is a
  rounding error inside that.

### Unreal Engine (SkyAtmosphere + Volumetric Clouds)
`docs/AtmosphereReferences/EpicGames.md:61` — for volumetric shadowing of the
atmosphere they keep **ray marching with shadow/transmittance maps sampled
per step** ("this is an area where ray marching still has a definite
advantage" for soft cloud shadows). UE ships a **Beer shadow map** for clouds
(r.VolumetricCloud.ShadowMap): front depth + extinction stored from the sun's
POV, sampled by opaque shading, volumetric fog, and the atmosphere raymarch —
that's their "atmosphere light shafts".

### Nubis³ / Decima (Horizon)
`docs/CloudTypesResearch/web_nubis-decima.md:8,59` — a coarse
**256×256×32 summed-density-toward-sun 3D grid**, amortized over 8 frames,
replaces all but the first 2 live light-march samples (-40% frame cost, buys
long-distance inter-cloud shadows). **We already have exactly this**: our
`cloudLightVolume.ts` is architecturally the Nubis³ light grid.

### Star Citizen
`docs/CloudTypesResearch/web_star-citizen-genesis.md:41-52` — cloud shadow
maps with **incremental amortized updates** (Jan 2021), clouds cast shadows
"onto the entire scene" (2021), **cloud shadows integrated into the atmosphere
→ light shafts** (Oct 2021), "truly-3D volumetric cloud light shafts —
explicitly contrasted with post-effect god rays" (CitizenCon 2953), and
**spherical cloud shadow rendering** for orbit views.

### Blackrack / KSP (EVE + Scatterer)
The vendored mod (`docs/VolumetricCloudReferences/KerbalSpaceProgramVolumetricCloudsMod/`)
is compiled bundles + configs, but the architecture is public knowledge and
visible in the configs: EVE projects a cloud shadow texture onto terrain/ocean
(a projected "cookie"), and Scatterer has a `useGodrays` quality toggle — a
raymarch of the shadowed atmospheric in-scatter. Same family as Frostbite/UE.

### Unity HDRP
Volumetric clouds bake a **cloud shadow cookie** applied to the directional
light (so every lit shader receives it for free), and the volumetric-fog
froxel samples the same cookie → god rays.

### The common pattern (and our design)
Every shipped implementation converges on:

> **One sun-space 2D transmittance map** (Beer shadow map, "BSM") baked from
> the cloud density field, sampled by (a) surface/object shading, (b) the
> atmospheric in-scatter integral (= god rays), (c) anything else that wants
> "how much sun reaches point P". A **3D light volume** is used only for
> near-field quality (Nubis³, Star Citizen) — which we already have.

Screen-space radial-blur god rays (the 2000s post effect) are rejected by all
modern references (and by Star Citizen explicitly): not physical, break when
the sun is off-screen, double-count occluders.

Prior in-repo designs agree: `docs/VOLUMETRIC_CLOUDS_PERF.md:142-163`
(Tier 2 pre-baked shadow map), `docs/VOLUMETRIC_CLOUDS_PLAN.md:1287-1310`
(E1 sun shadow map, "what RDR2 ships"), `docs/CLOUD_REVIEW_2026-07.md:639-644`
(god rays = froxel in-scatter modulated by cloud shadow; ship lighting =
sample the light volume at the ship).

---

## 2. What we already have (inventory)

| Piece | Where | Relevance |
|---|---|---|
| 3D sun-transmittance light volume, 256×32×256 over a 1200 km camera-local box, shell-Y altitude lattice, dual ping-pong crossfade, faded out at 150–400 km alt | `cloudLightVolume.ts` (NX/NY/NZ :105-107, BOX_HALF :125) | Near-field in-slab transmittance. The Nubis³ grid. Reuse for near god rays + in-cloud ship shadowing. Its bake's macro-density recipe is what the BSM bake must share. |
| Marcher per-sample sun transmittance `Tsun` = light-volume tap (+edge fade, dual-volume mix) | `earthClouds.ts:3099-3180` | Injection point for the ship→cloud occluder (multiply into `Tsun`). |
| Full-res per-pixel atmosphere march for GROUND rays (32 steps, per-step `earthShadow·Tsun_atmo·phase + ms`) | `atmospherePass.ts:1286-1478` (`runMarch` loop :1398-1441) | THE god-ray injection point. Ground rays already pay the march — adding one 2D tap per step is nearly free and gives **full-res** shafts. |
| AP froxel 32³, same integral, quadratic depth to 1800 km | `atmospherePass.ts:1490-1559` | Second injection point (fogs the clouds themselves + anything sampled through the froxel). |
| Sky-View LUT 200×256, replaces the sky-ray march below 60 km alt (crossfade to march by 150 km) | `atmospherePass.ts:207-258, 1569+` | Third injection point (coarse sky-level shafts). The march-skip is the one tension with crisp sky god rays — see L2. |
| CPU per-frame lighting bridge: `getAtmosphereLighting()` → sun transmittance tint on the `DirectionalLight`, hemisphere sky/ground fill | `atmospherePass.ts:646-843`, `SunLight.tsx:42-47`, `AtmosphereSkyLight.tsx` | Exactly where cloud shadow on the ship plugs in (it already handles planet-eclipse occlusion the same way, :816). |
| Ground cloud-shadow FAKE: 2 taps of `texClouds.r` at sun-projected UV offsets, darkens `dayAmount` by up to 0.7 — near tier only, mid tier has NO shadow | `earth.ts:273-320` | To be replaced by the BSM (near) + retargeted as the far/orbit fallback. |
| Transmittance/multi-scatter LUT singletons pattern (`getAtmosphereLUTs()`), fragment-pass bakes into `RenderTarget`s | `atmospherePass.ts:160-205` | The BSM should follow this exact pattern (RT + fragment bake, singleton getter) — it also makes GPU→CPU readback trivial for the ship. |
| Macro density recipe shared marcher↔light volume (coverage tap, `deriveColumnV2`, profile LUT, `baseDilate`, detile) | `cloudShared.ts`, `cloudDetile.ts` | BSM bake imports the SAME helpers → shadows agree with the rendered clouds by construction. |
| Units: 1 scaled unit = 1000 km; atmosphere works in planet-centred km; marcher in planet-centred scaled units | throughout | BSM canonical space = **planet-centred km** (inertial, non-rotating); consumers convert. |

---

## 3. Architecture — one new asset + four consumers

```
                 ┌────────────────────────────────────────────┐
                 │  Cloud Beer Shadow Map (BSM) — NEW          │
                 │  sun-orthographic 2D RT, camera-centred     │
                 │  512² (→1024²), RGBA16F                     │
                 │  R = d_front  G = σ_mean  B = τ_max  A = —  │
                 └──────┬──────────┬──────────┬───────┬───────┘
                        │          │          │       │
      L1 ground shadows │  L2 god rays        │       │ L3 ship readback
   earth.ts dayAmount ──┘  main march + froxel│       └→ getAtmosphereLighting()
   (replaces 2-tap fake)   + sky-view bake ───┘           → SunLight tint,
                                                            hemisphere dim
   L4 ship→cloud shadow: analytic sphere occluder × Tsun (earthClouds marcher)
   L5 near-field polish: light volume as the in-slab refinement of the BSM
```

### 3.1 The BSM (Frostbite-style, curvature-correct)

**Projection.** Directional sun ⇒ define a sun-space orthonormal basis
`(right, up, sunDir)` (basis from `normalize(cross(planetNorth, sunDir))`,
degenerate-guarded). The map is an orthographic window ⊥ `sunDir`, centred on
the camera's projection onto the plane through the planet centre, **snapped to
whole texels** (the light-volume lesson — un-snapped window motion
re-discretises the field every frame and swims, `cloudLightVolume.ts:115-127`).
Half-extent ~**1500 km** (covers the froxel's 1800 km quadratic depth range
for the directions that matter and the visible ground from any in-atmosphere
altitude; window edge fades to T=1 like `LIGHT_VOL_EDGE_FRAC`).

Unlike Frostbite we do NOT assume a flat planet (our window is 3000 km wide —
curvature is metres near the centre but ~180 km of drop at the edge):
the *bake* marches the true spherical slab per texel, and the *lookup* is an
exact orthographic projection, so curvature lives entirely in the baked
values. Sun-depth coordinate: `d(P) = −dot(P_km, sunDir)` (planet-centred km;
increases along the light's travel direction). This is exact for a
directional sun at any curvature.

**Channels (RGBA16F, one texel = one sun-parallel ray):**
- `R = d_front` — sun-depth where cloud density first exceeds ε along the ray
  (km; half-float range is ±65k, fine).
- `G = σ_mean` — mean extinction over the cloudy interval (so transmittance
  decays exponentially *through* the slab, giving height-correct shadows for
  receivers INSIDE the cloud layer, not just below it).
- `B = τ_max` — total optical depth of the whole crossing (the clamp).
- `A` — spare (future: cirrus-layer τ from the weather map's A channel).

**Reconstruction (shared TSL helper, exported for all consumers):**
```ts
// P in planet-centred km. Returns sun transmittance ∈ (0,1].
cloudShadowAt(P):
  uv     = bsmUv(P)                       // ortho projection, edge-faded
  d      = -dot(P, sunDir)
  bsm    = texture(bsmRT, uv)             // .toVar()! (TSL aliasing lesson)
  tau    = min(bsm.g * max(d - bsm.r, 0), bsm.b)
  return mix(1.0, exp(-tau), edgeFade(uv))
```
Points above the cloud tops get `d < d_front` → T=1; below the deck
`τ → τ_max`; inside the slab a smooth exponential. Ground receivers therefore
need no special casing, and the same helper serves the atmosphere march at
any altitude.

**Bake.** Fragment pass into a singleton `RenderTarget` (the
`getAtmosphereLUTs()` pattern — NOT a storage texture: RT + fragment is
simpler, has no storage-format constraints, and gives free
`readRenderTargetPixelsAsync` for L3). Per texel: intersect the sun-parallel
ray with the spherical cloud slab (inner/outer radius from `cloudShared`),
march the crossing with ~24 steps (chord elongates at low sun — clamp step
count, accept softening; shadows at grazing sun are physically enormous
anyway), accumulating the SAME macro density the light volume bakes
(coverage tap + `deriveColumnV2` + profile LUT + `baseDilate`, NO detail
noise — shadows are soft). Track first-hit depth, Σσ·dt, and the cloudy path
length → derive the three channels.

**Cadence.** 512²×24 steps ≈ 6.3M density evals — bake every frame initially
(it's ~⅓ of one light-volume side bake, which is itself amortized), then
measure; if it shows on the profile, bake every 2nd–4th frame (sun/planet
rotation and weather scroll are slow — Star Citizen amortizes incrementally,
Nubis over 8 frames). If N-frame rebakes pop visibly, add the light volume's
ping-pong crossfade. Inputs that must match the marcher exactly: the weather
UV offset uniform and the earth rotation matrix (the shell-local duplicate
`uCloudUvOffset` footgun documented in
`docs/CloudTypesResearch/code_farfield+config.md` — bind the SAME uniform
node, don't create a twin).

**Debug viz.** `BSM_DEBUG_VIZ: "off" | "blit" | "tau" | "front"` blit modes on
the atmosphere pass (the `DEBUG_ATMOSPHERE` convention) + a `"bsmShadow"`
ground overlay. Build these FIRST — the damascus-hunt lesson: read-only viz
tells you WHERE a value is wrong before any consumer obscures it.

### 3.2 Alternatives considered and rejected
- **Screen-space radial blur god rays** — not physical, sun-off-screen
  failure, rejected by every modern reference (see §1).
- **Froxel-only god rays** — the AP froxel is 32³; 32×32 screen tiles smear
  shafts into mush. UE/Frostbite fog froxels are ~240×135×64+ when they carry
  shafts. Our main march is already per-pixel for ground rays, so we get
  full-res shafts cheaper than upsizing the froxel.
- **Light-volume-only shadows** (CLOUD_REVIEW suggestion) — right idea for
  the ship (near field) but the volume's 1200 km box and 150–400 km altitude
  fade can't serve the atmosphere march (1800 km depth ranges) or ground
  shadows seen from orbit. The BSM complements it; the volume remains the
  near-field refinement.
- **Real shadow map (depth) from the sun for the ship→cloud shadow** — a
  render pass + depth sampling in the marcher for one small object; the
  analytic occluder is ~10 lines, no pass, penumbra-correct. "Rough" was
  explicitly acceptable. Revisit only if multi-ship scenes need it.

---

## 4. Phases

Each phase is independently shippable and browser-verified before the next.
Suggested toggles: `USE_CLOUD_SHADOW_MAP`, `GODRAYS`, `SHIP_CLOUD_SHADOW`,
`SHIP_OCCLUDER` — build-time consts, all defaulting on once verified.

### L0 — BSM module + bake + debug viz  (foundation; no visible change)
New `src/components/space/cloudShadowMap.ts`:
- singleton `getCloudShadowMap()` RT (512² RGBA16F) + `bakeCloudShadowMap(renderer)`
  fragment pass + `cloudShadowAt(P_km)` / `bsmUv(P_km)` TSL helpers + the CPU
  mirror of `bsmUv` (for L3's readback coordinates).
- Uniforms: sun basis (right/up/sunDir), window centre (texel-snapped),
  half-extent, weather uv offset + earth rotation (shared nodes with the marcher).
- Wire the bake into `SpaceRenderer`'s frame sequence BEFORE the passes that
  consume it, gated to `altitude < BSM_MAX_ALT_KM` (~2000 km — beyond that no
  consumer needs it; mirrors the froxel's altitude gate at `SpaceRenderer.tsx:76`).
- Debug viz modes (§3.1). **Verify:** blit shows the weather-map cloud pattern
  in sun projection; stationary camera → rock-stable; flying → no swimming
  (texel snap works); `tau`/`front` look plausible at low sun. Measure bake ms.

### L1 — Cloud shadows on the surface  (user goal 1)
`earth.ts:273-320`: replace the `cs1/cs2` texClouds fake with
`dayAmount *= mix(1, cloudShadowAt(P_surface), GROUND_SHADOW_STRENGTH)` where
`P_surface` = world position of the fragment relative to the earth centre in
km (the shader has the world position; needs the centre uniform — the
scaled-scene earth group already carries it for the marcher anchor).
- Keep a retuned far-field fallback OUTSIDE the BSM window and for the mid
  tier (which currently has NO ground shadow): the existing 2-tap projected
  darkening retargeted at the weather map's R channel (same texture object —
  `textures.clouds` IS the weather source for all cloud consumers). Crossfade
  fake→BSM over the window edge band.
- **Verify:** shadows sit directly under the rendered clouds (compare against
  the shell from ~20 km alt); shadow direction tracks the sun (dawn/dusk =
  long offsets); no double-darkening where the old fake overlapped; mid-tier
  orbit view now shows coverage shadows near the terminator.

### L2 — God rays  (user goal 4; the big visual payoff)
One shared injection, three sites — multiply the DIRECT single-scatter term
by cloud transmittance (and the multi-scatter term by a softened version —
the MS LUT is directionless, so full shadowing would over-darken; Frostbite
attenuates AP by mean cloud transmittance, we do it per-step):
```ts
// inside the per-step loop:  (was: earthShadow.mul(Tsun).mul(phaseScat) …)
const cloudT = cloudShadowAt(P).toVar();
const S = uSunIlluminance.mul(
  earthShadow.mul(Tsun).mul(cloudT).mul(phaseScat)
    .add(msContrib.mul(mix(float(1), cloudT, MS_CLOUD_SHADOW))), // ~0.5
);
```
Sites:
1. **Main march** (`atmospherePass.ts:1398-1441`) — ground rays are per-pixel
   full-res: crisp shafts on the haze below/around broken cloud, sunset beams
   across terrain. This is where 90% of the look lives.
2. **Froxel bake** (`:1490-1559`) — the cloud AP fogs clouds with shadowed
   haze (a deck's own shadow dims the haze in front of it — Frostbite Eq. 22,
   but spatially varying).
3. **Sky-View LUT bake** — large-scale sky darkening under decks + coarse sky
   shafts (200×256 ⇒ ≥1.8°/texel smear; stable but soft).
   Optional `GODRAYS_SKY_MARCH` build-const: force the per-pixel march for sky
   rays below ~30 km alt (the gate at `:1456-1459` already crossfades; this
   just biases `uSkyViewBlend`) for crisp sky shafts. This re-spends the
   Phase-4 sky-march savings — MEASURE, default off unless it fits the budget.
- The froxel/main-march marches extend far beyond the BSM window; `cloudShadowAt`
  returns 1 outside (edge fade) — correct-at-distance, same philosophy as the
  light volume's edge.
- **Verify:** sun low over broken cumulus → visible bright/dark shafts
  converging on the sun, anchored to specific clouds (fly sideways: shafts
  parallax correctly, unlike a post effect); overcast deck → haze under it
  globally dimmed; from above the deck looking down-sun → dark "anti-shafts"
  across the ground haze. Frame time before/after at 1440p.

### L3 — Clouds shadow the ship  (user goal 2)
- Tiny helper in `cloudShadowMap.ts`: once per N frames (N≈4),
  `readRenderTargetPixelsAsync` a 1×1 (or 2×2) region at the ship's `bsmUv`
  (CPU mirror) — fire-and-forget promise, EMA-smooth the result
  (`shipCloudT`). At 300 m/s a 2-frame latency is ~10 m of position error —
  invisible under a km-scale penumbra. Fallback if readback misbehaves on
  some backend: CPU-side coverage estimate from a low-res weather sidecar
  (note: current KTX2 is GPU-only — the readback path avoids needing one).
- `getAtmosphereLighting()` (`atmospherePass.ts:~816`, next to the
  planet-eclipse `occ` multiply): `sunTransmittance *= shipCloudT` and
  `skyIntensity *= mix(1, shipCloudT, AMBIENT_CLOUD_DIM≈0.6)` (under a deck
  the sky dome darkens too; full dimming would be wrong — the deck itself
  scatters). `SunLight.tsx`/`AtmosphereSkyLight.tsx` need NO changes — they
  already consume these fields.
- When the ship is INSIDE the slab, the BSM reconstruction already gives the
  height-correct value (that's what σ_mean buys) — no light-volume readback
  needed for v1.
- **Verify:** fly under a thick deck → ship visibly darkens (key + fill),
  smoothly (no popping at cloud edges); above the deck → unchanged; night
  side → unchanged (already dark).

### L4 — Ship casts shadow on clouds  (user goal 3)
Analytic directional-sun sphere occluder multiplied into the marcher's `Tsun`
(`earthClouds.ts:3099-3180`, after the light-volume tap):
```
v = shipPos − P;  h = dot(v, sunDir)          // occluder must be sun-ward
ρ = length(v − sunDir·h)                       // ray-to-centre distance
αo = Rship/h;  αs = SUN_ANGULAR_RADIUS (0.00465)
occ = maxOcc(αo,αs) · smoothstep-overlap(ρ/h, αo, αs)
Tsun *= 1 − SHIP_SHADOW_STRENGTH · occ
```
- A ~50 m ship's umbra reaches ~`R/αs` ≈ 10 km — the shadow is a real,
  visible feature when skimming a deck, fading to nothing beyond.
- Gate: CPU sets `uShipOccluderOn` only when the ship is within ~15 km of the
  slab; the `If` is uniform → near-zero cost when off. 1–2 spheres (fuselage
  + wing span) as uniforms; positions already available (ship ≈ camera frame,
  `worldOrigin.shipPosKm`).
- NOT added to the atmosphere march (a 50 m occluder's haze shafts are
  negligible); note as an optional flourish in L5.
- **Verify:** skim 100–500 m above a deck at midday → soft dark blob tracks
  the ship, elongates toward sunset, sharpens as you descend closer.

### L5 — Optional polish (do only what earns its keep)
- **Near-field 3D shafts:** inside the light-volume window AND slab altitudes,
  use the light-volume tap instead of the BSM in the main march / froxel
  (`min` or window-blend) — crisper 3D shadow structure under cloud edges
  near the camera (the Star Citizen "truly 3D shafts" refinement).
- **Shell far-field shadows:** multiply the shell's `selfShadow` proxy by a
  BSM tap where inside the window (long-distance inter-cloud shadows on the
  far field).
- **Ship occluder in the atmosphere march** (visible ship shadow shaft in
  thick haze — cheap, same function).
- **`GODRAYS_SKY_MARCH` default-on** if the L2 measurement allows.
- **Exposure/strength dials:** `GODRAY_STRENGTH`-style trims only if the
  physical result reads too strong against the cloud exposure scale (same
  caveat as `CLOUD_AP_STRENGTH`, `atmospherePass.ts:264`).

---

## 5. Performance budget (M2 Pro, 1440p, targets)

| Item | Est. cost | Notes / degrade knob |
|---|---|---|
| BSM bake 512²×24 steps | 0.2–0.5 ms | every frame → every 2–4 frames; 24→16 steps |
| L1 surface tap | ~0 (replaces 2 taps with 1) | — |
| L2 main march +1 tap/step | <0.3 ms (taps into an existing 32-step march) | `GODRAYS=false` |
| L2 froxel/sky-view +1 tap/step | ~0 (32³·24 and 200×256·30 texels) | — |
| L2 `GODRAYS_SKY_MARCH` | the one real risk — re-enables sky-ray march below 30 km | default OFF; measure |
| L3 readback | ~0 (1×1 async, every 4th frame) | — |
| L4 occluder | ~0 (few ALU, uniform-gated) | — |
| **Total (defaults)** | **≤1 ms worst case** | fits 60 with margin; likely fits 120 |

Measure with the Chrome performance panel + the existing per-pass timing
before/after each phase (the CLOUD_TYPES_PLAN 4.10 accounting will formalize
this — keep the raw numbers in the work log below).

---

## 6. Risks & TSL gotchas (read before implementing)

1. **TSL `.toVar()` aliasing** — materialize every BSM sample and any value
   read after a mutable reassign (the invisible-atmosphere bug; memory
   `feedback_tsl_var_aliasing`, and `atmospherePass.ts:1399-1407` shows the
   in-repo precedent).
2. **Bind-group stability** — BSM RT must be a process-lifetime singleton
   bound once at graph build (`getAtmosphereLUTs()` precedent). Never swap
   the texture object; update contents in place.
3. **Uniform twins** — bind the marcher's actual weather-offset/rotation
   uniform NODES into the bake; a same-valued duplicate will drift (the
   `uCloudUvOffset` shell footgun).
4. **Window swimming** — texel-snap the BSM centre; if N-frame rebakes pop,
   copy the light volume's ping-pong crossfade (don't invent a new mechanism).
5. **Frame ordering** — bake BEFORE froxel/sky-view bakes and the main pass
   in `SpaceRenderer`'s sequence (same-queue ordering is what makes same-frame
   reads safe — the light-volume comment at `cloudLightVolume.ts:92-95`).
6. **Space mismatches** — the BSM canonical space landed as **earth-MODEL
   SCALED units** (planet-fixed, 1 unit = 1000 km), matching `cloudLightVolume`
   rather than inertial km (the density recipe is native to that space, so the
   shadows register with the drawn clouds by construction). `updateWindow`
   rotates the inertial camera + `uSunRel` into earth-model on the CPU; the bake
   + `cloudShadowAt` are pure earth-model. CONSUMERS holding an inertial position
   (atmosphere march in km, earth surface `positionWorld` scaled) must rotate by
   the earth inverse-model + convert units BEFORE `cloudShadowAt`. Get one debug
   viz per consumer before trusting any of it.
7. **Readback** — `readRenderTargetPixelsAsync` must be fire-and-forget
   (never awaited in the frame loop). If a backend stalls, drop to every-8th
   frame or the CPU fallback.
8. **Empirical debugging** — if shadows/shafts look wrong, use the viz modes
   and constant-override bisection (the damascus lesson,
   `docs/CLOUD_DEBUGGING_LESSONS.md` case #23) — don't theorize from the
   integral.

---

## 7. Work log

*(append per session: date, phase, what landed, measurements, deviations)*

- 2026-07-13 — Plan written. No code yet. Next: L0.
- 2026-07-14 — **L0 LANDED** (code-complete, statically verified; in-engine blit
  verification pending user).
  - New `src/components/space/cloudShadowMap.ts`: `getCloudShadowMap()` singleton
    512² RGBA16F RT (ClampToEdge, LinearFilter); `createCloudShadowMap(deps)`
    factory with the sun-orthographic bake fragment (mirrors `cloudLightVolume`
    `densityAt` VERBATIM incl. the warp branch → shared `WARP_AMPLITUDE_MIRROR`);
    CPU `updateWindow` (earth-model sun basis + texel-snapped window centre);
    `bake(renderer)`; reconstruction helpers `cloudShadowAt(P)` / `bsmDepthAt(P)`
    (earth-model scaled P) + CPU mirror `bsmUvCPU` for L3.
  - **DECISION: earth-MODEL SCALED space** (not inertial km — see risk #6), so the
    density recipe transfers verbatim and shadows register with drawn clouds.
  - Channels: R=d_front, G=σ_mean, B=τ_max, A=hit. Bake marches only the SUNWARD
    slab crossing (24 steps). `BSM_EXTINCTION=3000` (primary density, not the
    cone's 1000). `BSM_MAX_ALT_KM=2000`, `BSM_HALF_EXTENT_KM=1500`.
  - Wired into `cloudFullscreenPass.setupCloudPipeline` (identical shared density
    nodes as the light volume) + `CloudPipeline.{updateCloudShadowMap,
    bakeCloudShadowMap,hasCloudShadowMap}`. Dispatched in `SpaceRenderer`'s
    ATMOSPHERE block (after `updateUniforms`, before froxel/sky-view/main pass),
    gated on pipeline-mounted + alt<2000 km — OUTSIDE `cloudsVisible` (consumers
    are the atmosphere pass, which runs above the marcher's range). Base noise
    volume is warm-baked at startup + drained unconditionally, so it is valid at
    the bake altitude.
  - Debug blit: `BSM_BLIT` build-const in `atmospherePass.ts` (`hit`/`shadow`/
    `tau`/`front`), default `"off"` → zero cost, no texture bind. Committed OFF
    (L0 is a no-op by design).
  - **Verification:** `tsc --noEmit` 0 errors; `pnpm lint` 101 baseline (0 new).
    Adversarial 3-lens review workflow (TSL / geometry-units / integration) →
    **5 confirmed findings, all fixed**: (1 HIGH) single-sample `span` floored at
    1e-5 → σ_mean overflowed fp16 G to +Inf → NaN via LinearFilter bleed — now
    floored at the march step `dt` + clamped at `BSM_EXTINCTION`; (2) no-hit R
    sentinel 1000 bled across shadow edges — now stores R=0 (in-range; G/B=0
    already force T=1); (3) pole-guard comment corrected (~0.057°, not 0.6°);
    (4) dead unread `active` uniform removed; (5) non-detile warp branch now
    mirrored for true lockstep. Two geometry verify-agents died on the org spend
    limit; their findings were the same no-hit bleed (fixed) + the fp16 precision
    watch-item below (reviewed by me, deferred).
  - **WATCH-ITEM for L1 (deferred, LOW):** d_front is stored as absolute sun-depth
    (~planet-radius magnitude, 4–6.4 scaled), so fp16 quantises it to ~3.9 km near
    window centre. Cloud penumbra is km-soft so this is likely invisible; if L1
    ground-shadow edges look stepped/quantised, re-encode d_front slab-relative
    (store depth-into-slab from the per-ray outer-shell entry; consumer recomputes
    the entry from `wp²=|P|²−dot(P,sunDir)²`). Measure in-engine first.
  - **Next: L1** (ground shadows) — first real consumer; validate with the blit +
    `cloudShadowAt` against the drawn shell before wiring `earth.ts`.
- 2026-07-14 — **L0 in-engine VERIFIED by user** (blit). Confirmed: sun-ortho
  projection tethered to Earth; stable when stationary; texel-snap produces
  discrete one-texel steps when flying (no continuous swim ✓). The full-screen
  blit at low altitude overlays the real volumetric clouds → two-layer view (real
  clouds move with camera rotation; the BSM map is screen-fixed + steps when
  translating). Black specks = the BINARY hit channel aliasing the base-noise
  high-freq structure at 512²; the τ-based shadow (what L1 consumes) is smoother.
  Watch for speckled ground shadows in L1.
- 2026-07-14 — **L1 LANDED** (code-complete, static-verified; in-engine pending).
  - `cloudShadowMap.ts`: reintroduced the `strength` uniform (removed in L0 as
    dead — now with a real reader+writer). `cloudShadowAt` folds `strength` into
    its edge fade (→ 1 = no shadow when stale). Added `setCloudShadowStrength(v)`
    + `cloudShadowStrengthNode()`.
  - `SpaceRenderer`: after the BSM bake, `setCloudShadowStrength(1 − smoothstep(
    alt, MAX−FADE_BAND, MAX))` (`BSM_FADE_BAND_KM=400`); 0 when the bake is
    skipped. So shadows ramp off over 1600→2000 km and never read a stale map.
  - `earth.ts` (detailed/near-tier surface): ground shadow is now
    `dayAmount *= mix(fakeLight, bsmLight, strength)` where `bsmLight = mix(1,
    cloudShadowAt(positionLocal), GROUND_SHADOW_STRENGTH=0.7)` and `fakeLight` is
    the legacy 2-tap `texClouds` fake. Crossfade by the SAME strength → pure BSM
    below the fade band (no double-count), pure fake above (no regression).
  - **FRAME (verified from code):** the earth surface mesh and the cloud anchor
    are both children of one `<group rotation={EARTH_ROTATION}>` (CelestialBody
    :418) with identity local transforms + `SphereGeometry(scaledRadius)`, so the
    surface's object-space `positionLocal` IS the BSM's scaled-km earth-fixed
    frame (`getEarthMatrixWorldRef()` = the anchor). No transform needed; shadows
    register with clouds by construction. The shadow's sun is `cloudShadowAt`'s
    internal earth-model `U.sunDir` (self-consistent, not the surface's inertial
    `sunDir`).
  - tsc 0, lint 101 baseline. One tsc fix: `edgeFade` annotated `: Node` (the
    `.mul(U.strength)` with an `any` operand otherwise resolved to a vec3
    overload and broke the scalar `mix`).
  - **Verify in-engine:** fly < ~1000 km over a broken deck at a low-ish sun
    angle → dark shadow patches on ground/ocean directly under clouds, offset
    anti-sunward, tracking the sun; seamless as you climb through 1600→2000 km
    (BSM → fake). Watch for speckle (defer to a BSM blur if bad).
- 2026-07-14 — **L1 FIX 1: jagged step-lines + darkening** (user saw jagged lines
  on the ground/orbit + shadows too faint).
  - ROOT CAUSE (the deferred L0 watch-item, biting): `d_front` was stored ABSOLUTE
    (~6400 km scaled) → fp16 rounded it into ~3.9 km plateaus → adjacent texels
    share a value then step at a boundary that wanders across texels → jagged
    stair-stepped lines in the reconstructed shadow (ground isn't fully saturated,
    so d_front modulates τ visibly).
  - FIX: store R SLAB-RELATIVE = `d_front + tOuter` (∈ [0, slab-crossing] ≈ 0.03
    scaled → fp16 ~15 m). Reconstruction recomputes `tOuter = sqrt(rOut² − wp²)`,
    `wp² = |P|² − d²`, and `d − d_front = d − R + tOuter` at float32. EXACT because
    for any receiver on a texel's ray `wp²(P) = |winPoint|²` → same tOuter as the
    bake. Added `outerRadius` to the BSM uniforms (set from deps).
  - DARKENING KNOBS (shadows read faint — orbital cloud is optically thin): (#1)
    `GROUND_SHADOW_STRENGTH` 0.7→0.8 in earth.ts (caps day-term darkening: thick
    cloud → 0.2× daylight; raise toward 1 for near-black); (#2) `SHADOW_TAU_BOOST`
    = 2.0 in cloudShadowMap.ts (multiplies τ for contrast).
  - tsc 0, lint baseline. IF jagged lines persist after this: bisect with
    `BSM_BLIT="shadow"` — lines IN the sun-space map ⇒ bake (base-noise speckle at
    512² / geometry); lines only on the GROUND ⇒ projection (window square edge —
    then widen the window or use a radial edge fade).
- 2026-07-14 — **L1 FIX 2: terminator shadows + registration debug** (user: long
  razor-sharp shadows near the terminator look wrong; shadows seem not to match
  the rendered clouds).
  - TERMINATOR: long shadows at grazing sun are geometrically CORRECT (offset =
    h/tan(elevation) → ∞), but physically they also (a) widen their penumbra ∝
    length → SOFTEN, and (b) wash out in heavy twilight scattering. Ours were long
    AND razor-sharp AND high-contrast = wrong, and the sun-ortho map is unreliable
    at grazing angles anyway (rays exit the window). FIX: grazing-sun fade in
    earth.ts — shadow → lit below GRAZE_HI (sin(elev) 0.15 ≈ 8.6°), gone by
    GRAZE_LO (0.03 ≈ 1.7°). Cheap approximation of twilight wash-out; a fuller
    model would blur the penumbra ∝ shadow length (deferred).
  - "MISMATCH": largely the (correct) sun OFFSET — a shadow lands anti-sunward of
    its cloud, and the caster can be off-screen toward the sun, so "shadow with no
    cloud below it" is often right. Two aggravators fixed: SHADOW_TAU_BOOST 2.0→1.5
    (2.0 lifted optically-THIN clouds — invisible in the render — into visible
    shadows) and the grazing streaks (above). Darkening rebalanced onto
    GROUND_SHADOW_STRENGTH 0.8→0.85 (darkens THICK clouds without lifting thin).
  - DEBUG added: `SHADOW_DEBUG` build-const in earth.ts tints shadowed ground
    MAGENTA over the normal surface → check each patch sits anti-sunward of a
    cloud (correct) vs. has no sun-ward caster (real mismatch). Near-tier only.
  - tsc 0, lint baseline.
- 2026-07-14 — **L1 FIX 3: τ gate (macro-vs-visible mismatch)** — the SHADOW_DEBUG
  magenta revealed broad shadow over areas with NO visible cloud. ROOT CAUSE (not
  a bug): the BSM integrates MACRO density (no detail carve, threshold 1e-3) so it
  sees the broad optically-THIN weather-map coverage, while the rendered clouds
  (volumetric w/ carve, or the shell's opacity threshold) show only the DENSE
  subset. A linear τ multiplier is unwinnable (dense-dark ⇒ thin also shadows;
  thin-hidden ⇒ dense faint — the user confirmed both ends: boost 2.0 → magenta
  everywhere, boost 0.1 → realistic positions but invisible).
  - FIX: replaced `SHADOW_TAU_BOOST` with a NON-LINEAR τ GATE in cloudShadowAt:
    `gate = smoothstep(SHADOW_TAU_LO=2, SHADOW_TAU_HI=8, τ); shadowT = mix(1,
    exp(−τ), gate)`. Thin columns (τ<LO) → no shadow; dense (τ>HI) → full physical
    exp(−τ). Standard threshold-cloud-shadow (Frostbite/Nubis). CALIBRATE with
    `BSM_BLIT="tau"` (grey = τ/10): read dense-cloud τ vs thin, set LO/HI between.
  - GROUND_SHADOW_STRENGTH kept at 1.0 (user's edit; fine now that the gate stops
    thin over-shadow — thick → shadowT≈0 → full black, thin → shadowT=1 → lit).
  - tsc 0, lint baseline. Defaults LO/HI are a guess (dense τ≈8–15, thin≈1–2);
    user to fine-tune in-engine via the tau blit. USER TUNED to LO=0.15, HI=4.0.
- 2026-07-14 — **L1 FIX 4: grazing-sun penumbra** (user: shadows too sharp,
  sharper toward the terminator). DIAGNOSIS: streaking toward the terminator is
  correct geometry (length = h/tan(elev)), but the sun-ortho map keeps razor-sharp
  512²-texel SIDES regardless of length → long hard streaks. Real shadows soften
  along their sides as they lengthen (penumbra widens; twilight skylight fills
  them). FIX: cloudShadowAt now blurs the map lookup with a 5-tap cross whose
  radius grows as the sun grazes — SHADOW_PENUMBRA_MIN=0.6 texel (high sun, also
  hides 512² aliasing) → MAX=6 texels at the terminator (cosElev=−d/|P| below
  SHADOW_PENUMBRA_ELEV=0.5). d/tOuter are per-receiver (constant across taps);
  only the MAP tap offsets. Cost: 5 map taps + reconstructions per near-tier
  surface pixel (cheap vs the marcher). tsc 0, lint baseline. NOTE: the fuller
  physical fix (skylight in-scatter FILLING the shadow toward the terminator)
  arrives with L2 atmosphere↔cloud coupling; this penumbra blur is the geometric
  half.
