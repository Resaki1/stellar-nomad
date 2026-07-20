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
  half. **L1 signed off by user after this fix ("Looks good").**
- 2026-07-14 — **L2 LANDED (god rays)** — code-complete, static-verified,
  adversarial review CLEAN (2 lenses — frames/units + TSL/integration — read the
  live code and returned zero findings; no fixes needed).
  - `cloudShadowMap.ts`: new `invModel` Matrix4 uniform (earth inverse-model,
    refreshed each `updateWindow`); `cloudShadowAt` refactored into
    `cloudShadowCore(P, penumbra)` (surface path unchanged, 5-tap penumbra); NEW
    `cloudShadowAtPlanetKm(PKm)` — planet-centred INERTIAL km input, converts
    km→scaled (`kmToScaledUnits(1)`) and rotates through `invModel` as a
    direction (`vec4(…,0)`, valid because the earth mesh is translation=centre,
    scale=1 — same precedent as `cloudLightVolume.ts:296`), SINGLE-tap
    reconstruction (5 penumbra taps × 32 steps would be 160 taps/pixel; the
    march's own integration averages).
  - `atmospherePass.ts`: `GODRAYS=true` + `MS_CLOUD_SHADOW=0.5` +
    `GODRAYS_SKY_MARCH=false` consts (by `BSM_BLIT`); one shared
    `shadowedSunScatter(P, earthShadow, Tsun, phaseScat, msContrib)` closure in
    `setupAtmospherePass`; ALL THREE per-step integrands now call it (main march
    `runMarch`, froxel bake, Sky-View bake — grep `shadowedSunScatter`). Direct
    single-scatter ×= cloudT (one BSM tap/step, `.toVar()`d); directionless MS
    term ×= `mix(1, cloudT, 0.5)`. `GODRAYS=false` compiles the taps away.
    `GODRAYS_SKY_MARCH` forces `uSkyViewBlend=1` (crisp per-pixel sky shafts;
    re-spends the Phase-4 sky-march savings — measure before shipping on).
  - Graceful degradation: BSM stale/unbaked (Mars, high alt) → strength gate 0 →
    cloudT=1 → god rays absent, no per-body special-casing.
  - tsc 0, lint 101 baseline.
  - **Verify in-engine (user):** sun low over broken cumulus, camera under/beside
    the deck → bright/dark shafts converging on the sun, anchored to specific
    clouds (fly sideways: shafts parallax with the clouds, unlike a post effect);
    overcast deck → haze beneath globally dimmed; from above looking down-sun →
    dark anti-shafts across the ground haze; DEBUG_ATMOSPHERE="inscatter" shows
    the raw shafts if in doubt. Measure frame time before/after at 1440p (expect
    <0.3 ms). Knobs: MS_CLOUD_SHADOW (ambient fill under decks),
    GODRAYS_SKY_MARCH (crisp sky shafts, perf), SHADOW_TAU_LO/HI (shared with L1
    — gate which clouds cast).
- 2026-07-14 — **L2 in-engine feedback + FIX 1: soft (blurred) shadow map.**
  USER CONFIRMED: shafts render above/inside/below the deck; anti-sunward sky
  shadow bands visible (real phenomenon — ANTICREPUSCULAR rays, cloud shadow
  volumes through haze converging at the antisolar point). ISSUES: shafts "too
  harsh, individual lines" from above; BLOCKY shadow volumes in the sky;
  GODRAYS_SKY_MARCH=true measured **−10–20% fps and looked WORSE** (the Sky-View
  LUT had been hiding the blocks; per-pixel march renders the raw texels) → keep
  OFF, treat as dead knob.
  - ROOT CAUSE of blockiness: shafts are extrusions of the 512² map
    (5.9 km/texel) through the whole atmosphere; bilinear's piecewise-linear
    ramps (re-sharpened by the τ gate) read as hard facets edge-on.
  - FIX (the industry standard — UE r.VolumetricCloud.ShadowMap.Blur, Frostbite,
    Unity cookie blur): second singleton RT `getCloudShadowMapSoft()`; a 3×3
    Gaussian pass (offset `BSM_SOFT_BLUR_TEXELS=1.5`) runs right after each bake
    (same queue → ordered). VOLUME consumers (cloudShadowAtPlanetKm → god rays)
    sample the SOFT map; the SURFACE consumer keeps the SHARP map + its
    grazing-adaptive penumbra (L1 tuning untouched). Physically justified:
    multi-scattering diffuses real shafts far beyond the ~50 m geometric
    penumbra; sub-texel features are unresolvable anyway.
  - Knobs for residual harshness: `BSM_SOFT_BLUR_TEXELS` (shaft softness; raise
    to 2–3 for hazier), `MS_CLOUD_SHADOW` (lower → more ambient fill → less
    contrast). tsc 0, lint baseline.
- 2026-07-14 — **L2 FIX 2: sky-ray shafts off the LUT lattice** (user: post-blur,
  shafts fine BELOW the horizon but blocky CURVED bands ABOVE it). ROOT CAUSE:
  two render paths — ground rays march per-pixel (smooth), but low-altitude SKY
  pixels read the 200×256 Sky-View LUT, and the L2 bake-injection quantized the
  shafts to its (azimuth, elevation) lattice → curved texel bands (Hillaire's own
  caveat: a sky-view LUT cannot carry volumetric shadows; UE evaluates shafts
  per-pixel).
  - FIX: Sky-View bake reverted to UNSHADOWED; new `skyShaftFactor(ro, rd)` in
    the main fragment modulates the LUT's in-scatter per pixel at sample time:
    density-weighted mean of soft-BSM transmittance along the ray — 12 taps,
    quadratic spacing t=s²·400 km (dense near camera), weights
    2s·exp(−h/6 km) (air density at sample altitude: thin-air/high samples don't
    dilute the shadow; horizon-grazing rays keep far contributions), denominator-
    guarded → 1 outside the atmosphere. Tmean untouched (star attenuation isn't
    cloud-shadowed). ~1/6 the cost of GODRAYS_SKY_MARCH for the same full-res
    lattice-free result; taps only on LUT-path sky pixels. No double-shadowing:
    LUT path = unshadowed LUT × factor; march paths keep per-step shadow; the
    crossfade band mixes two independently-shadowed estimates.
  - `GODRAYS_SKY_MARCH` now documented as superseded (A/B tool only).
  - Consts: GODRAY_SKY_SAMPLES=12, GODRAY_SKY_TMAX_KM=400,
    GODRAY_SKY_WEIGHT_H_KM=6. tsc 0, lint baseline.
- 2026-07-14 — **L2 FIX 3: multiplicative → ADDITIVE sky-shaft correction.** The
  FIX 2 multiplicative factor FAILED in-engine (user screenshots: near-black band
  hugging the horizon + the deck's cloud pattern smeared onto the sky).
  STRUCTURAL failure, diagnosable from the formulation: the factor averaged
  cloud shadow over the NEAR 400 km and multiplied the WHOLE path's LUT
  in-scatter — but horizon-grazing rays draw most of their light from hundreds
  of km of bright UNSHADOWED far air, and with the camera just above a deck the
  near segment of every low sky ray sits inside the deck's shadow volume →
  (near shadow ≈ 0.02) × (far-field brightness) = black horizon band. High sky
  fine (near-field dominated) — exactly the screenshots' signature.
  - FIX: `skyShaftDelta(ro, rd)` — a 10-step quadratic near-field march
    (RANGE=150 km) of the light the shadow REMOVES: ΔL = ∫T·σs·phase·Tsun·
    earthShadow·(1−cloudT)dt, same integrand as the real march (direct term
    only); `L′ = L_LUT − ΔL, max(0)`. The far field stays exactly LUT-bright →
    the horizon-band artifact class is impossible by construction. Beyond RANGE
    the shadow is assumed 1 (slight under-shadow far along grazing rays —
    benign). Cost ≈ ⅓ of GODRAYS_SKY_MARCH (10 steps × sampleMedium ALU + 1
    transmittance tap + 1 soft-BSM tap, LUT-path sky pixels only).
  - LESSON (design-level, not TSL): a shadow factor estimated over a SEGMENT of
    a ray must never scale the radiance of the WHOLE ray — either march the
    shadowed segment's contribution (delta/additive) or shadow per-step. Any
    "mean shadow × total L" shortcut fails wherever the unshadowed remainder
    dominates (horizons, limbs). Consts: GODRAY_SKY_STEPS=10,
    GODRAY_SKY_RANGE_KM=150. tsc 0, lint baseline.
- 2026-07-14 — **FIX 2 + FIX 3 REVERTED (user decision) — sky-ray shafts back to
  LUT-BAKED shadows; the curved-band artifact is an ACCEPTED KNOWN LIMITATION.**
  In-engine result of FIX 3: the additive delta did NOT cure the artifact and
  cost additional frame time. So BOTH per-pixel LUT-path corrections failed:
  the multiplicative factor (structural horizon failure, correctly diagnosed)
  AND the delta whose design made that failure "impossible" — meaning the
  REAL mechanism was never established. Two "structurally certain" armchair
  diagnoses in a row shipped without an in-engine falsification step; the
  second failure proves the first diagnosis was at best incomplete.
  UNVERIFIED candidate mechanisms for the persistent artifact (for whoever
  picks this up): (a) sharp per-pixel ΔL subtracted from the BILINEARLY-SMEARED
  LUT L goes negative at the horizon's steep radiance gradient → max(0) clamps
  to black band; (b) something wrong in cloudShadowAtPlanetKm specifically for
  near-horizontal sky rays (frame/units) that ground-ray marching doesn't hit;
  (c) the LUT sample's (φ,θ) mapping vs the delta's assumptions. NEXT TIME:
  in-engine bisection FIRST (constant-override the delta to 0 / to a fixed
  value / visualize ΔL directly as a debug output) before ANY redesign — the
  damascus lesson applied to design changes, not just debugging.
  - Current shipped state: sky-view bake keeps `shadowedSunScatter` (shadows in
    the LUT, soft curved bands at low-alt sky); main march + froxel keep per-step
    shadows (correct, artifact-free); `GODRAYS_SKY_MARCH=false` documented as the
    quality-tier candidate (−10–20% fps, looks correct post-blur).
  - tsc 0, lint baseline.
- 2026-07-14 — **L3 LANDED (clouds shadow the ship)** — code-complete,
  static-verified; in-engine pending.
  - DESIGN CHANGE from the plan's readback sketch: instead of reading raw BSM
    texels + a CPU mirror of the reconstruction (fp16 decode, y-flip risk,
    math-drift risk), a **1×1 FloatType GPU probe** renders
    `cloudShadowCore(U.shipPos, penumbra=true)` each bake — the GPU
    reconstruction stays the single source of truth — and
    `readRenderTargetPixelsAsync` reads that ONE pixel (rgba32float → exact
    Float32Array; verified in three r183's WebGPUTextureUtils).
  - `cloudShadowMap.ts`: `shipPos` uniform (earth-model, = camera; the
    third-person offset is metres vs km-scale penumbra), probe scene rendered in
    `bake()` after the blur; async readback every `SHIP_READBACK_INTERVAL=4`
    frames, fire-and-forget with an in-flight guard (plan risk #7);
    `getShipCloudShadowT()` advances an EMA (`SHIP_SHADOW_SMOOTH=0.08`,
    ~0.25 s) toward the readback, RELAXING to 1 whenever the strength gate is 0
    (high alt / no pipeline) so a stale shadow never sticks to the key light.
  - `atmospherePass.ts` `computeAtmosphereLighting` (after the eclipse/ring
    occlusion): `sunTransmittance ×= shipT`;
    `skyIntensity ×= 1 − AMBIENT_CLOUD_DIM·(1−shipT)` (`AMBIENT_CLOUD_DIM=0.6`
    — under a deck the sky dome dims but the deck itself scatters light down).
    `SHIP_CLOUD_SHADOW=true` build const. SunLight.tsx / AtmosphereSkyLight.tsx
    unchanged (they already consume these fields).
  - tsc 0, lint baseline.
  - **Verify in-engine (user):** fly under the edge of a THICK deck at midday →
    the hull's key light dims smoothly (~quarter-second ramp, no pop) and the
    blue sky-fill softens; back out into a gap → brightens; above the deck →
    unchanged; climb past ~2000 km → shadow releases to fully lit even if you
    were shadowed when the gate closed. Knobs: `AMBIENT_CLOUD_DIM` (fill
    dimming), `SHIP_SHADOW_SMOOTH` (response speed), `SHIP_READBACK_INTERVAL`.
- 2026-07-17 — **L4 LANDED (ship casts shadow on clouds)** — code-complete,
  static-verified; in-engine pending (user testing L3+L4 together).
  - Analytic directional-sun SPHERE occluder multiplied into the marcher's
    finalized per-sample `Tsun` (earthClouds.ts, right after the light-volume/
    cone if-else joins, BEFORE the `Tsun_ms` derivation → the ms fill dims with
    it; slightly over-dark in the umbra core — accepted, the shadow should read
    dramatic). Disk-overlap model: αo=R/h vs αs=SUN_ANGULAR_RADIUS(0.00465);
    occFrac = 1−smoothstep(αo−αs, αo+αs, β=perp/h); ×maxOcc=clamp((αo/αs)²,0,1)
    (area ratio once the ship is smaller than the sun disk — fades the shadow
    out past the R/αs ≈ 10.7 km umbra); ×soft sun-ward gate (h>0 over 10 m).
    Branchless, ~10 ALU/dense sample, inside a UNIFORM `If(uShipOccluderOn)`.
  - Consts (earthClouds.ts): SHIP_OCCLUDER=true, SHIP_OCCLUDER_RADIUS_KM=0.05,
    SUN_ANGULAR_RADIUS=0.00465, SHIP_SHADOW_STRENGTH=1.0.
  - Plumbing (cloudFullscreenPass.ts): shared uniforms uShipOccluderPos (earth-
    model scaled, = tmpEarthCam already computed for uLodMinSamples) +
    uShipOccluderOn (gate: camera radius < outer shell + SHIP_OCCLUDER_MAX_ALT_KM
    =15 km — beyond that the umbra can't touch any cloud), set in
    updateUniforms; passed into marchCloudVolume as optional params (light-volume
    pattern). Cone fallback path also covered (the multiply sits after the join).
  - tsc 0, lint baseline.
  - **Verify in-engine (user):** skim 100–500 m above a deck at MIDDAY (high
    sun) → a soft dark blob a few hundred metres wide tracks the ship across the
    cloud tops directly anti-sunward; descend closer → it sharpens/shrinks;
    climb → it softens, fades entirely by ~10 km above the deck; at low sun it
    elongates away from the sun. Knobs: SHIP_OCCLUDER_RADIUS_KM (size),
    SHIP_SHADOW_STRENGTH (darkness).
- 2026-07-17 — **DEBUG INSTRUMENTS for the L3/L4/L1 review (user reported: L4
  ship shadow too sharp / hard circle edge from afar; L3 ship dimming barely
  visible / maybe not working; L1 ground shadows start where no cloud + look at
  the wrong height "above the clouds"). No behavioural change — measure first.**
  - `DEBUG_VIZ = "shipShadow"` (earthClouds.ts) — greyscale of the L4 occlusion
    factor at the visible cloud surface (`lastShipOcc`). White = full ship
    shadow, grey ramp = penumbra, black = clear/gate-off. Reads the blob
    directly: size, penumbra gradient, whether it softens with ship height.
    Only non-black within SHIP_OCCLUDER_MAX_ALT_KM (15 km) of the deck.
  - `SHIP_PROBE_DEBUG = true` (cloudShadowMap.ts) — console-logs the L3 readback
    chain once per readback: raw 1-px probe value, EMA'd value, strength gate,
    ship radius. Reveals whether the GPU probe ever returns <1 under a deck and
    whether it survives the gate + EMA into the lighting bridge.
  - L1 isolation uses EXISTING instruments: `SHADOW_DEBUG` (earth.ts, magenta on
    shadowed ground) + `BSM_BLIT="shadow"` (atmospherePass.ts, sun-space map),
    with GODRAYS/SHIP_CLOUD_SHADOW/SHIP_OCCLUDER flipped false to separate a
    genuine ground-shadow error from L2 god-ray shafts in the AIR being read as
    "shadows above the clouds".
  - tsc 0, lint baseline. Findings + fixes to follow once the user reports.
- 2026-07-17 — **L3/L4/L1-review FINDINGS (from the debug instruments) + FIXES.**
  All three diagnosed from evidence, no guessing:
  - **A (L4 ship shadow hard/doesn't soften with height):** `shipShadow` viz →
    hard-cored disk that shrinks with height, constant softness. ROOT: the bare
    sun geometric penumbra (±SUN_ANGULAR_RADIUS=0.00465) on a 50 m ship is
    metres → razor dot; physically pure but wrong-looking. FIX: separate
    `SHIP_PENUMBRA_ANGLE=0.015` (≈3× sun) for the shadow EDGE smoothstep band,
    keeping SUN_ANGULAR_RADIUS for the maxOcc umbra-length. Angular band ⇒
    penumbra grows with ship height, umbra dissolves above ~R/pen ≈ 3.3 km →
    soft/fading when high, crisp when skimming. Models atmospheric/cloud-top
    scattering (same reasoning as the god-ray map blur).
  - **B (L3 ship dimming barely visible / "specular unaffected"):**
    `SHIP_PROBE_DEBUG` telemetry → probe WORKS (raw 0.65 under thick deck, 0.88
    tower, 0.997 clear; chain read=ema=raw, strength=1). So the DATA path is
    correct. ROOT (two compounding): (1) the hull is lit by an intensity-30 sun
    through bloom+tonemap → clipped near white, so ≤35% key dim stays clipped;
    (2) the τ-gate caps the probe at ~0.65 even under a visually-thick deck
    (0.651 ≈ mix(1,exp(−τ),gate) for moderate τ). FIX: `SHIP_SHADOW_GAMMA=3.0` —
    shipT^γ turns 0.65→0.27 (visible, survives the clip) while clear sky (≈1)
    stays put. Specular-clip is the real reason raw values read as "nothing";
    the gamma pushes moderate cloud below the clip point.
  - **C (L1 "shadows above the clouds / wrong height / harsh, inconsistent with
    cloud pos"):** GODRAYS=false test → they VANISH ⇒ they are the L2 god-ray
    shafts in the AIR (crepuscular, offset from clouds by the sun angle — real,
    but too harsh from near-horizontal/orbital views), NOT an L1 ground-shadow
    bug. L1 itself is fine. FIX: `GODRAY_STRENGTH=0.6` dial (lerps the per-step
    cloud shadow toward unshadowed → shafts present but paler); BSM_SOFT_BLUR_TEXELS
    remains the softer-EDGES knob.
  - Instruments left in place (off by default): `DEBUG_VIZ="shipShadow"`,
    `SHIP_PROBE_DEBUG`. tsc 0, lint baseline.
  - **User to re-test:** A — skim + climb, blob should soften/fade with height
    now; B — under a thick deck the hull should now visibly dim; C — the harsh
    air-shafts should be tamer. Knobs: SHIP_PENUMBRA_ANGLE, SHIP_SHADOW_GAMMA,
    GODRAY_STRENGTH, MS_CLOUD_SHADOW, BSM_SOFT_BLUR_TEXELS.
- 2026-07-17 — **Follow-up review (godrays-near-clear-sun; ship behind tower).**
  - GODRAYS near a clear sun: PHYSICS is correct (crepuscular rays — the caster
    cloud is between the sun and the shadowed AIR, need not be near the sun in
    view / can be off-screen), BUT low-alt SKY pixels read the 200×256 Sky-View
    LUT (baked shadows → coarse lattice bands = the documented FIX-2/3 limitation)
    so distant-cloud shadows can smear into unexpected sky bands. BISECTION for
    the user: GODRAYS_SKY_MARCH=true → if the odd bands sharpen/vanish it was the
    LUT (tune GODRAY_STRENGTH / accept), if they persist they're real off-view
    shafts. Not a bug.
  - SHIP behind a tall TOWER not dimming (telemetry raw=0.996): ROOT = the ship
    shadow reads the MACRO BSM (512² ≈ 5.9 km/texel, τ-gated, NO detail carve).
    Broad decks fill texels → probe drops (works). A narrow tower / ship grazing
    its edge at low sun is under-resolved in the macro field → raw≈1 while the
    detailed rendered tower visually blocks the sun. Fundamental coarse-map
    limitation for a point receiver (what most engines accept for object
    shadows). Proper fix if wanted: a dedicated 1-px sun-MARCH probe through the
    full density (base+detail+carve) instead of the BSM tap — moderate lift
    (the carve density lives in the marcher closure, not shared). DEFERRED
    pending user preference.
  - Responsiveness (ship laggy leaving a deck into sun): FIXED —
    SHIP_READBACK_INTERVAL 4→2, SHIP_SHADOW_SMOOTH 0.08→0.2 (~0.25 s → ~0.07 s).
    tsc 0, lint baseline.
- 2026-07-17 — **Ship-shadow follow-up 2.** GODRAYS_SKY_MARCH toggle changed
  NOTHING for the near-clear-sun godrays ⇒ they are the per-pixel main-march
  shafts, NOT the coarse LUT ⇒ Issue 1 CONFIRMED physically correct (real
  crepuscular rays from off-view clouds); GODRAY_STRENGTH is the only taste dial.
  - Ship still under-dims (user: inside a tower's dark base, single=... was
    raw=0.881). DESIGN BUG found: the L3 probe used cloudShadowCore(shipPos,
    penumbra=TRUE) — the 5-tap grazing EDGE blur (up to 6 texels ≈ 35 km) meant
    for softening the ground shadow's visible edges. A POINT receiver must not
    use it: it averages a narrow tower's shadow into the surrounding clear air →
    under-dims. FIX: probe now uses penumbra=FALSE (single bilinear tap at the
    ship). The probe RT now also outputs the old 5-tap value in .g as a pure
    DIAGNOSTIC: SHIP_PROBE_DEBUG logs `single` (lighting) vs `soft`. If under a
    tower single≪soft ⇒ the blur was the whole problem (fixed); if single≈soft
    (~0.88) ⇒ the macro 512² map genuinely can't resolve the tower and only a
    dedicated sun-march probe will.
  - COST of the dedicated ship sun-march (answer to the user): RUNTIME ~free —
    it is ONE pixel doing ~24 density samples/frame (the main marcher does
    millions); <0.01 ms. The real cost is CODE — the detailed density (weather +
    base + DETAIL + carve) lives inside the marcher closure, so it needs
    factoring out / replicating (~40–60 lines). Build it ONLY if the telemetry
    shows single≈soft under a tower. tsc 0, lint baseline.
- 2026-07-17 — **Ship-shadow follow-up 3 — telemetry verdict + STOP.** Under a
  tower: `single=1.000 soft=0.881`, and ALWAYS single ≥ soft. So the ship's OWN
  macro column is a NO-HIT (the coarse 512² map has zero cloud there) even when
  the ship is visually inside a detailed tower; the 5-tap soft only dims because
  it averages in NEIGHBOURING macro cloud. Reverted the probe to the SOFT tap
  (.r) — it's the less-wrong BSM answer (single=1.0 = no dimming at all); single
  kept in .g as a diagnostic. CONSEQUENCE: NO BSM tap can fix the ship-in-tower
  case — the macro map lacks the data. COST CORRECTION: the dedicated detailed
  sun-march is NOT the "~40–60 line" job estimated earlier — `billowCarveKernel`/
  `carvedShapeAt`/fine-carve are module-local in earthClouds and entangled with
  per-sample locals (detailConv, noiseVarFade, topAlt…), so it's a real refactor
  of the MOST-debugged file with regression risk to the whole cloud render
  (CLAUDE.md "avoid large refactors without explicit ask"). Also unresolved WHY
  the macro sun-ray reads clear there (coverage-placement gap? sun-ray exits a
  narrow tower's side? — would need more in-engine bisection). RECOMMENDATION:
  ACCEPT the macro limit — ship dims correctly + responsively under broad decks
  (the common case); inside narrow detailed towers it stays ~0.88 (mild). This is
  the standard shadow-map-for-objects tradeoff. Deferred the detailed march
  unless the user explicitly wants it. Ship lighting = SOLID for the common case;
  L1–L4 all functionally complete.
