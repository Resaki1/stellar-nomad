# VFX Realism Plan — Stellar Nomad

**Status:** review + plan, 2026-11-22. No code changed yet. Written before M6.
**Scope:** station lights at distance, mining beam + impact, engine exhaust (vacuum and
atmosphere), shadows and local light, airspeed relative to rotating atmospheres,
light-speed delay (opinion only).
**Captures:** `.captures/vfx-review/` (gitignored), referenced below as `[cap N]`.

| Owner decisions so far | |
|---|---|
| Mining beam | **Never bends.** Fires straight along the ship's forward axis from the mining socket; ends at the real mesh hit; **mining halts while the ray misses** (aiming is part of the challenge). |
| Exhaust | Must respond to the real atmosphere (density, pressure, composition), the way the wind audio does. |
| Drive model inside atmospheres (2026-11-22) | **Variable-Isp atmospheric mode.** In air the drive adds reaction mass and lowers exhaust velocity, so the plume becomes a real hot-gas jet with gas dynamics, at a fuel cost. See §5.4. |

---

## 0. Ground rules for this work

- **Measure every look** with `pnpm drive -- --perf` (vsync). Default "fast" mode
  measured 209 rAF/s, 99 % GPU, ~2.7 CPU cores on the M2 Pro and is what overheated the
  Mac; `--perf` is 60 rAF/s, ~70 % GPU, ~1 core. Never leave a `--keep` Chrome idle.
- **Perf baseline** (asteroid field, 720p, `--perf`): GPU p50 ~10–12 ms. Scaled scene
  ~0.6 ms, atmosphere ~1.35, atmosphere apply ~1.4, **local scene ~1.0**, glare PSF
  ~1.6–1.7, post output ~4.4–5.1. Current beam and exhaust: not measurable. Quote pass
  ms at a named scenario for every before/after (docs/PERF_MEASUREMENT.md).
- **Every emissive is pre-exposed** (D25): multiply by `getPreExposure()` or it vanishes
  in dark scenes.
- **Never toggle `light.visible` or add/remove lights at runtime** (lights hash → every
  lit material recompiles, ~1 s stall). Fixed light pools, intensity 0 when idle.
  Same for `renderer.shadowMap.enabled`: set once at startup.
- **One shared primitive per concept**: one beam component (player, co-op, drones), one
  light-point system (station lamps, beacons, far exhausts, impacts, far beams).

---

## 1. Shared infrastructure: flux-conserving light points (L-series)

Everything below that is small and bright (lamps, beacons, beam muzzle/impact, distant
exhausts) ends up sub-pixel. One system handles it.

### 1.1 Problem (measured)

Station lamps are tiny HDR meshes under 4× MSAA on the HDR target. Each frame a lamp
covers some of a pixel's 4 samples or none; one covered sample is already saturating, so
it pops whenever the camera moves a fraction of a pixel.

- Lit amber pixels at 250 m, consecutive frames, ship drifting 4 m/s: **7, 2, 4, 10, 10,
  10, 9, 8, 6, 6** `[cap 4]`. At 2 km a lamp goes 1 → 0 px mid-sequence. At 4–8 km
  nothing shows, even during beacon flashes.
- Mast lamps ~0.64 m across → sub-pixel beyond ~340 m at 720p (~930 m at the owner's
  resolution). Status lenses 10 cm → sub-pixel from ~50 m.
- LOD switches at 600 m / 1100 m merge lamps into light bars: another jump.
- Sunlit hull (~28k cd/m²) drowns the 18,000 cd/m² lamps `[cap 6]`.

### 1.2 Ideal (real-world behaviour)

A distant light never disappears or flickers: it becomes a point at the eye's PSF size
(~1 arcmin core plus scatter halo) whose total flux falls as 1/d².
Mast beacon: 65,000 cd/m² peak over ~0.3–0.6 m² ≈ **20–40k cd** (an airliner
anti-collision strobe needs ~400 cd). E = I/d², m = −14.18 − 2.5 log₁₀(E/lux):

| Distance | Apparent magnitude | Comparable |
|---|---|---|
| 8 km | ≈ −5.5 | brighter than Venus |
| 100 km | ≈ 0 | Vega |
| ~1000 km | ≈ 5 | naked-eye limit |

The station should dissolve into a steady amber constellation plus two blinking beacons,
visible from far away, never shimmering.

### 1.3 Plan

- **L1 — `LightPoints` module** (pattern: `src/components/space/StellarPoint.tsx`).
  Instanced camera-facing sprites. Input per point: position (frame-relative), intensity
  I (cd, photometric via `emissivePhotometry.ts`), colour, optional direction + cone,
  blink group. Output: a PSF sprite whose integrated pre-exposed radiance × solid angle
  equals E = I/d². The existing glare pass adds the halo; do not paint one.
- **L2 — mesh ↔ point crossfade by projected size**: mesh only above ~3 px, point only
  below ~1.5 px, blend between **holding total flux constant**. Removes both the MSAA
  pop and the LOD light-bar jump.
- **L3 — Blender export of per-light empties** (`art/stations/replication-r4/build.py`,
  documented in `docs/MODEL_WORKFLOW.md`): one empty per lamp with custom props
  `intensity_cd`, `colour`, `blink_group`, `dir`/`cone_deg`. The code reads them from the
  GLB; meshes stay for close-ups. Blink timing stays in code
  (`MAST_LIGHT_PERIOD_S 2`, on 0.45 s), synced to sim time so co-op peers agree.
- **L4 — sunlit contrast**: nothing to fix physically (a lamp does lose against a sunlit
  hull), but give lamps a slight bloom-only boost so they read at mid-range. Flag any
  artistic gain explicitly (LIGHTING_PLAN rule).

**Gates:** at 250 m and 2 km, per-frame total lamp flux varies < 5 % over 30 frames of
drift (today: 2 → 10 px); beacons visible at 8 km during the ON phase; no step in total
flux across 600/1100 m LOD switches. Perf: local scene + points ≤ +0.1 ms.

---

## 2. Mining beam (B-series)

### 2.1 Current state

`src/components/Mining/MiningSystem.tsx`:
- `NativeLineSegment` = `THREE.Line` + `LineBasicMaterial` → always exactly **1 px**
  (why far co-op beams stay visible: a 1 px line never fades).
- 6 travelling 10 m glow sprites (`BEAM_PULSE_COUNT`, `BEAM_PULSE_SIZE_M`) = the cheap
  pulse `[cap 2]`; sin flicker; pulse mode dims to 8 %.
- 4.5 m muzzle glow, 14 m impact glow; the impact sprite is depth-clipped by the rock →
  hard edge along the rock outline `[cap 1]`.
- **Endpoint (§3 bug):** lines ~1275–1311. Hit is computed on the rock's *bounding*
  sphere (`radiusM` = bounding radius, `src/sim/asteroids/modelRegistry.ts`
  `baseRadiusM = boundingSphere.radius * baseScale`), locked once as an offset from the
  rock centre (`lockedEndOffsetFromCenterRef`), then reused. So the beam ends metres in
  front of an irregular surface, and swings when the ship moves. Aim gating uses an
  inflated sphere `radiusM * 1.08 + 0.75`.
- Drones (`src/components/Industry/IndustryWorld.tsx` `UtilityDrone`): a different blue
  `BoxGeometry` (0.16·√strength m), aimed at the rock *centre*, artificial sin wobble.
- Co-op (`src/components/Coop/CoopLayer.tsx`) reuses `MiningBeam`, stale after 300 ms.

### 2.2 Ideal look

A real mining laser is invisible from the side in vacuum; a visible beam is accepted
sci-fi. Make it a believable one:
- Thin very bright core (~5–10 cm, near-white, tinted by laser colour) inside a faint
  narrow sheath (~0.3–0.5 m).
- Camera-facing ribbon with **real width in metres**. When thinner than 1 px it stays
  1 px but dims by (true width / 1 px) so flux per unit length is conserved: solid up
  close, a faint thread far away, never flickering.
- No travelling blobs. At most a low-amplitude shimmer streaming toward the rock. Pulse
  mode = real on/off pulses with a sharp rise.
- Muzzle: small emitter glint + a little light on the nose, not a 4.5 m fog ball.
- Far co-op beams: visibility mainly from impact spot + muzzle as **light points** (L1).

### 2.3 Plan

- **B1 — straight beam + mesh hit + halt on miss** (owner decision).
  - Every frame: ray from the mining socket along `shipView` forward
    (`src/components/Camera/shipView.ts`, never the camera ray).
  - Transform the ray into the rock's model space (inverse instance matrix incl. scale)
    and intersect the **LOD0 mesh** (not the displayed LOD1) with Möller–Trumbore and a
    bounding-sphere early-out. Check triangle counts first; if brute force at 20 Hz is
    over ~0.05 ms, build a tiny static BVH per model once at load (own code). A
    dependency (`three-mesh-bvh`) needs owner OK.
  - Beam end = hit point, stored in rock-local coords so it rides the rock's rotation;
    interpolate render frames between 20 Hz tests.
  - Miss → mining progress stops; beam continues to its max range (or fades out over a
    short distance). Optional silhouette debounce (≤ 0.15 s, a tuning constant, not a
    bend) so grazing the outline doesn't stutter. Clear miss feedback on the reticle
    (visual, not text — UI feedback memory).
  - Remove `lockedEndOffsetFromCenterRef`, the inflated aim sphere for the visual, and
    the bounding-sphere endpoint.
  - Co-op: the ship's owner decides hit/miss and only sends mining progress while
    hitting; remote beams are drawn from the replicated pose + the same local raycast.
  - **Gameplay gates touched:** `GAME_PARTS=res,m32,reach`, `pace` (bot aiming must
    track the surface), `__test.gameplay.res.forceMining`. Re-run them.
- **B2 — shared `BeamRenderer`** for player, co-op and drones: ribbon core + sheath with
  min-1px energy rule, pre-exposed, one material. Drones switch from the box to it,
  firing from their emitter along their own axis at the mesh hit (no centre aim, no
  wobble).
- **B3 — upgrade parameters** wired to the look:
  `mining.powerMultiplier` → core radiance + width, impact temperature, melt-pool size,
  spark rate; laser heat (`heatBuildUpRateMultiplier`) → emitter housing glows hotter;
  pulse mode → visible pulse train; optional colour per tier (decision: owner).
- **B4 — far visibility**: muzzle + impact as light points; beam ribbon follows the 1 px
  rule. Keeps the co-op "see their beam from km away" property honestly.

**Gates:** beam end within 0.1 m of the rendered surface over a 360° orbit of an
irregular rock; beam direction equals ship forward to < 0.01° every frame; miss ⇒
mining rate 0 within one test tick. Perf: beam pass ≤ 0.1 ms at 3 beams.

---

## 3. Mining impact VFX (I-series)

### 3.1 Ideal (laser-melted rock in vacuum)

- Tiny white-yellow melt pool ~2,000–3,000 K with an orange-red molten rim.
- Small bright vapour/plasma core hugging the surface (DLR basalt-in-vacuum work: the
  plume expands freely, leaving only a compact bright core).
- Glowing droplets in **perfectly straight lines** (no gravity, no drag) cooling yellow →
  orange → red → dark within ~1–2 s.
- Glassy dark scar glowing dull red, fading over a few seconds. A moving beam leaves a
  cooling trail: strong feedback for the straight-beam aiming.

### 3.2 Plan

- **I1 — hot spots in the rock material:** 4–8 uniform slots (rock-local position,
  radius, age, peak temperature). Per pixel: blackbody colour from T(age, distance) ×
  crack noise; emissive pre-exposed. Ring buffer; new spot every N cm of beam travel.
- **I2 — sparks:** 64–256 GPU sprites, ballistic straight lines, stretched along
  velocity, blackbody cooling. Emission rate ∝ beam power.
- **I3 — impact light:** one permanent point light at the hit, intensity 0 when idle
  (never toggled). Lights the nearby rock and the ship nose.
- **I4 —** replace the 14 m depth-clipped impact sprite with the plasma core (small,
  depth-tested against the rock with a soft fade, not a hard clip).

**Gates:** no hard edge along the rock outline `[cap 1]` regression shot; hot-spot trail
visible for ≥ 2 s after the beam moves; ≤ 0.15 ms at one active impact.

---

## 4. Shadows and local light (S-series)

### 4.1 Current state (measured)

No shadow map anywhere. `castShadow`/`receiveShadow` are set on the ship but the renderer
shadow map is off and `src/components/Star/SunLight.tsx`'s directional sun casts none.
Only planets occlude the sun (`sunVisibility`, `src/components/space/sunOcclusion.ts:271`).
Ship inside a 286 m rock's umbra: sun-facing luma **42.59 vs 42.54** sunlit
`[cap 5]`. Exhaust point lights light only the local ship (remote `castLight={false}`);
model emissives light nothing.

### 4.2 Ideal

- Shadows near-black, filled only by earthshine/sky light (exists: `skyIrradiance`,
  planetshine).
- Sun disc 0.53° → penumbra grows ~1 m per 107 m of occluder–receiver distance. Ship
  self-shadows ≈ hard; a rock 100 m away casts a ~1 m soft edge.
- Flying into a rock's shadow plunges the ship into darkness and exposure adapts.
- Lamp/emissive light matters only in shadow (2,000 cd lamp ≈ 500 lux at 2 m vs
  127,000 lux sunlight).

### 4.3 Plan

- **S1 — analytic occluders in `sunVisibility`** (cheapest, biggest win): nearby rocks
  and stations as spheres (rocks: area-equivalent radius, calibrate per model, not the
  bounding radius; stations: a few spheres/capsules) with the solar-disc overlap maths
  for penumbra. CPU only, near-free. Gives "ship goes dark behind an asteroid".
- **S2 — one ship-following shadow map:** directional, 2048², ~200–400 m extent,
  texel-snapped (no swimming), local scene only, enabled once at startup, quality tier.
  Covers ship self-shadowing, rocks, stations, drones. Estimate 0.3–1 ms: **measure**
  before committing; kill line > 1 ms at `earth_650` and the asteroid field.
- **S3 — emissive spill:** bake lamp spill into station textures in Blender; for dynamic
  sources (impact, exhausts, remote ships) a small fixed pool of point lights assigned
  to the nearest N sources, intensity 0 when unused.

**Gates:** S1 — umbra luma drops to the sky-light floor, penumbra width within 20 % of
the 0.53° rule. S2 — no shadow acne/swim in a slow orbit capture; pass ms reported.

---

## 5. Engine exhaust (E-series)

### 5.1 Current state

`src/components/VFX/EngineExhaust.tsx`: open `ConeGeometry` (`PLUME_MAX_LENGTH 4.0`,
16 segments), additive `NodeMaterial`, axial `pow(1−v, 1.8)` uv falloff, xenon-blue
ion-thruster palette, two sine flickers, `PLUME_HDR 12` (72,456 cd/m²). Uniforms:
`uIntensity` (× pre-exposure) and `uTime` only. One point light per nozzle. The smooth
featureless gradient is the "too smooth" look `[cap 3]`.

### 5.2 What the engine physically is

Tuning: `propellantKgPerMps 0.008`, `mainThrustMps2 120` ⇒ ṁ = 0.96 kg/s for any mass,
v_e = m/0.008 = **1,250–6,250 km/s** (10–50 t), F 1.2–6 MN, jet power ½Fv_e =
**0.75–19 TW**. Two nozzles r = 0.455 m (A = 1.30 m²): exit density 5.9e-7–1.2e-7 kg/m³,
momentum flux F/A 0.92–4.6 MPa, ions 8–200 keV/nucleon. Hydrogen–oxygen combustion
(4.4 km/s) would only work for a ~35 kg ship. Story: **water from the hydrates as
reaction mass, fusion-heated to plasma, magnetic nozzle.** Power ∝ throttle at fixed v_e.

### 5.3 Ideal look in vacuum

- Nozzle interior is the brightest thing: blinding near-white disc, slight violet.
- Short dense core, 1–2 nozzle diameters; hydrogen plasma pink-magenta (Hα + Hβ/Hγ),
  oxygen adds blue-green. Fades fast (emission ∝ n² ⇒ ~r⁻⁴). Visible plume a few
  diameters at full throttle; **throttle changes brightness, not length**.
- No smoke, no turbulence, no shock diamonds, no heat haze (all need air). Fine flow
  streaks, fast irregular flicker, faint outward-racing bands if the fusion is pulsed.
- Nozzle bell glows dull red-orange after a sustained burn, cools over seconds.
- Tone reference: Interstellar (compact bright engine glows, almost no plume).

### 5.4 In atmosphere — physics by regime

Data available today: `src/audio/acoustics.ts` (React-free) `acousticsForBody(id)` →
molar mass, γ, surface T/P/ρ, c, scale height RT/(Mg) from the body's own gravity,
dominant gas; `densityAtAltitude` isothermal ρ₀e^(−h/H); P(h) = P₀e^(−h/H) is trivial
to add; full mole fractions on `body.atmosphere.composition` (`sol.json`). Limits:
one temperature per body (no tropopause ⇒ no contrail criterion), c constant with
altitude, gas giants anchored at 1 bar.

At the tuned power the plume is not a flame but a multi-TW ion beam stopping in air.
Stopping length L = Σ/ρ, Σ ~0.6–1 g/m² for air (order of magnitude — PSTAR not
retrieved; H₂ 2–3× smaller Σ):

| Where | Ambient | What you'd see (torch) |
|---|---|---|
| Vacuum | — | §5.3. |
| Earth > ~100 km | ρ < 6e-7, beam longer than km; charge-exchange mfp ~1 m at 100 km | Artificial aurora: long faint streak; colour by altitude like aurora — O 630 nm red > 200 km, O 557.7 nm green 100–150 km, N₂⁺ 391/428 nm violet-blue < 100 km, N₂ 1P pink lower fringe. Earth's field can bend it (proton gyroradius ~600 m). |
| Earth 50–100 km | L ≈ 22 m at 80 km, ≈ 0.4 m at 50 km | Streak shortens and brightens (∝ 1/ρ); violet-white teardrop, pink fringe. |
| Earth < 50 km to sea level | L ≈ 0.25 mm at SL | Radiating air-plasma fireball, R = √(P/4πσT⁴), T 8–10 kK ⇒ **~22–35 m at 3 TW**, ~3e14 lm (≈ the Sun seen from 14 km). Cooler orange-brown NO₂ shell, heat shimmer, scattering halo, lit clouds/ground. |
| Mars surface | ≈ Earth at ~30 km; jet underexpanded 2–170× | Decimetre–metre flare. Tint **unverified** (CN violet + CN red ⇒ pale violet/pinkish-orange per one source; bluish-white per another). Shimmer negligible (refractivity ~1.5 % of Earth SL). |
| Venus surface | 9.2 MPa > jet 1–5 MPa | Jet crushed; white-orange fireball diffused into glowing fog (visibility a few km), extreme shimmer (~55× Earth). |
| Gas giants | H₂/He | Pink-magenta Balmer (Hα) glow, somewhat longer than Earth at equal ρ (smaller Σ). |

Effects that exist only inside an atmosphere: heat shimmer (∝ ρ·(1 − T_amb/T_plume),
Δ(n−1) ~2e-4 at Earth SL), scattering halo and cloud illumination (∝ column along the
sight line), sweep-back (momentum-flux ratio J = (F/A)/(ρv²); 10 t at 10 km/s: SL
0.0075, 50 km 8.9, 100 km 1.6e4, Mars 0.46, Venus 1.4e-4 — matters only for braking and
lateral burns; a rear main engine co-flows), ram glow at LEO (Shuttle-glow red-orange
∝ ρ·v), contrails (Earth, T < 233 K, needs a T profile). Chemical afterburning is
negligible (keV vs eV). Space-jellyfish scattering negligible for a plasma plume.

**The catch:** at sea level full thrust gives ~3 kW/cm² at 100 m and a blast radius
(E/p₀)^(1/3) ≈ 330 m after 1 s (Venus ~73 m). It would destroy the ship and anything
near it. Hence a design decision, **taken 2026-11-22: option (a)**:

- **(a) Variable-Isp atmospheric mode (CHOSEN).** In air the drive adds reaction mass
  (ingested air first, then water) and lowers v_e at fixed thrust, so near the ground
  jet power drops ~600× to GW (Raptor class) and the plume becomes a real hot-gas jet
  with gas dynamics. Costs up to 10× fuel in the thin middle band. Full design: §5.6.
- **(b) Capped torch fiction** (rejected). Keep the torch; render the regime table with an
  artistic cap on size/brightness (state it as an artistic gain). No gameplay change.

### 5.5 Plan

- **E1 — vacuum plume rewrite** (do now, independent):
  short bounding mesh + emission-only volume inside (analytic integral or 8–16 steps),
  density ∝ r⁻² falloff, axial noise scrolling fast (reuse `noiseVolumes.ts` lazily —
  their bake is a known startup cost), nozzle disc, nozzle-bell heat glow with thermal
  lag, Hα/O palette. Per-instance uniforms (shared uniforms today). Keep `PLUME_HDR`
  photometry and the hull light. Far away: a light point (L1).
- **E2 — atmosphere inputs per plume:**
  per-instance ρ, P, T, composition id, airspeed vector (§6). Remote co-op ships compute
  them from *their own* position. Smooth inputs; fix the body pick (§6.3).
- **E3 — regime model + colour LUT** (after the §5.4 decision):
  continuous regime value from log ρ, p_e/p_a and J (from `drivePlume`, §5.6.7); length
  `clamp(Σ/ρ, floor, cap)`, fireball radius ∝ √(throttle·P); tint LUT per body baked at
  load from the gas mix (N₂/O₂ altitude-auroral, CO₂, H₂/He); power ∝ throttle.
- **E4 — halo and environment light:** scattering halo sprite with radius/strength ∝
  local scattering coefficient (local scene gets no atmospheric fog, so it must be
  explicit); plume point light scaled with plume power; cloud-deck illumination later
  via the cloud lighting plan.
- **E5 — heat shimmer pass** (new infrastructure): screen-space distortion from a plume
  mask × ρ-driven strength; zero in vacuum. Estimate 0.2–0.5 ms at 1080p, **measure**,
  quality tier, kill line 0.5 ms.
- **E6 — contrails** (optional): needs a temperature profile (tropopause) in
  `acoustics.ts`.
- **E7 — re-entry plasma / meteor trail** (separate feature, bigger than the plume): at
  up to 10 km/s below ~100 km the ship's own shock layer (N₂⁺ violet, ∝ ½ρv³) outshines
  any plume. Own plan item.

**Gates:** E1 — side-by-side vs `[cap 3]`, plume pass ≤ 0.2 ms with two ships. E3 —
scripted descent capture (vacuum → 200 → 100 → 50 → 10 km → SL) at Earth, plus Mars,
Venus surface and Jupiter 1 bar; continuous change, no pops. E5 — pass ms at
`earth_650`.

### 5.6 Variable-Isp drive mode — design (V-series)

Design workflow 2026-11-22: code map → one designer → two adversarial reviewers
(physics, code fit). Corrections from the reviewers are already folded in below; the
raw reports are in the session scratchpad (`visp/`).

#### 5.6.1 What the code does today (constraints the design must respect)

- **No ship mass, gravity or drag in the sim.** Thrust is a fixed acceleration
  (`flightTuning.ts:29`, main 120 m/s²); `frames.ts:3` "no gravity simulation". Hover and
  coasting cost nothing. Only surface contact kills (`sweptSphereCollide`, radius =
  `radiusKm`). Speed limit 0.402 km/s (from retro accel, `flightTuning.ts:76–84`).
- **Fuel is charged per delivered Δv**, L1 over body axes:
  `resourceStep.ts:196–200` `dvMps·propellantKgPerMps` via `spendManoeuvre` (`:132`);
  sub-deadband carry; rotation separate (`rotationKgPerRadps`). Thrust is gated by
  `worstStepKg` (`:149`) → `propellantGate` (`:161`) → `env.thrustScale`.
  ⇒ Variable-Isp reduces to **one density-dependent multiplier M on kg per m/s**.
- Tank 600 kg, start fill 200, protected reserve 60, Aux Tank Mk1 +400
  (`shipResources.ts:7–11`, `content.ts:507`). Refuel: hydrates 20 kg/unit at 10 kg/s.
  Difficulty `fuelUse` 0.75/1/1.25 scales `propellantKgPerMps` (`difficulty.ts`), so it
  carries through M unchanged.
- Normal play is in vacuum (start ~10,375 km above Earth). Atmosphere today is visual +
  audio only.
- Transit has its own fuel model (`transitKgPerKmps`, `transitKgPerKm`) and never ends in
  an atmosphere (`transitDrive.ts:444`), but **nothing stops a transit from starting in
  one**. Drones use a separate scale (`route.ts:38`) and stay ≥ 150 km up; unaffected.
- **No density reachable from `src/sim`.** `densityAtAltitude` lives in
  `src/audio/acoustics.ts`; molar masses in `components/celestial/bodies/atmosphereData.ts`
  (`GASES` holds molar mass + Rayleigh only; **γ lives in `acoustics.ts`**); the atmosphere
  top (12.5·H) in `deriveAtmosphere`. `src/sim` may not import `@/components/*` (ESLint).

#### 5.6.2 Control law

**Hold thrust (acceleration) fixed; lower v_e, and with it power, as ambient density
rises.** P = ½F·v_e, ṁ = F/v_e. Constant-power (VASIMR-style) trading would keep the
hazard and multiply thrust ~600×: wrong axis. Fixed acceleration also leaves `stepShip`,
the speed limit and every flight gate untouched. (LANTR's "×2.75 thrust for −30 % Isp" is
*not* a constant-power trade — it adds LOX afterburning — so it is only a loose analogy.)

Schedule, mass-free (the fuel model has no mass):

```
f(ρ) = v_e / v_vac = min(1, sqrt(ρ_hand / min(ρ_eff, ρ_floor)))
ρ_hand  = 3.1e-6 kg/m³   (= 1.225·(4 km/s / 2500 km/s)², torch at full power above this)
ρ_floor = 1.225 kg/m³    (denser air, e.g. Venus, stays at the floor)
ρ_eff   = ρ·(1 − smoothstep(0.85·top, top, h))   (continuous fade to vacuum at each body's top)
```

The ½ exponent is a **game choice** (allowed power ∝ 1/√ρ). Be honest about what it buys:
power is low only near the ground and **rises with altitude**:

| 20 t, full thrust | v_e | ṁ | Jet power | Exhaust state |
|---|---|---|---|---|
| Earth SL | 4.0 km/s | 600 kg/s | 4.8 GW (≈ Raptor 3.7, F-1 8.8) | ~5 kK air / ~3.6 kK steam |
| 10 km | 7.2 km/s | 333 kg/s | 8.7 GW | dissociated, 7–9 kK, slightly ionised |
| 30 km | 23.6 km/s | 102 kg/s | 28 GW | dissociated, partly ionised (~1.5–2 eV) |
| 50 km | 77 km/s | 31 kg/s | 93 GW | fully ionised plasma |
| 80 km | 460 km/s | 5.2 kg/s | 0.55 TW | rarefied: collisionless beam (§5.4 streak) |
| ≥ ~100 km | 2,500 km/s | 0.96 kg/s | 3 TW | vacuum torch |
| Mars surface | 35 km/s | 69 kg/s | 42 GW | CO₂ plasma |
| Venus surface | 4.0 km/s | 600 kg/s | 4.8 GW | jet crushed (p₀ ≈ 7 MPa < 9.2 MPa) |
| Jupiter 1 bar | 10.9 km/s | 220 kg/s | 13 GW | hot H₂, ~4–5 kK |

⚠ The floor v_e scales with mass (v_e = f·m/k): 2 km/s at 10 t, 10 km/s at 50 t. Every
plume regime in this doc is for a **20 t reference** (`driveRefMassKg`). The game's
isothermal atmosphere is 1.9× (30 km) to 5× (80 km) denser than US76, so band edges sit
~5 km higher than in reality.

#### 5.6.3 Reaction mass: hybrid, air first

- **Water only** is honest and unplayable: 600 kg/s at sea level empties the tank in
  0.9 s; even a physical 1 g hover (49 kg/s) lasts 11 s.
- **Air-breathing** (the fusion core heats ingested air: a nuclear thermal turbojet/ramjet,
  cf. Project Pluto's Tory-II-C, 513 MW, ~156 kN) is honest and free where air is dense.
  Static intake 700 m³/s + ram capture 3.5 m² × airspeed. Sea level captures 858 kg/s >
  600 needed. Any gas works (no oxidiser needed; H₂ is the best working fluid; CO₂
  dissociation costs enthalpy). Need ∝ √ρ while capture ∝ ρ, so breathing fails with
  altitude: an honest expensive middle band.
- **Design:** air first, water fills the shortfall under a soft cap; whatever is still
  missing is **overdrive** (v_e above the safe curve), charged as hull heat through the
  existing heat store. Per fixed step:

```
needKg  = dvMps·k / f
airKg   = ρ_eff·max(Q, A·V_air)·dt
Mh      = max(0, needKg − airKg) / (dvMps·k)                     // honest water multiplier
M       = Mh ≤ floor ? floor : floor + (cap−floor)·(1 − exp(−(Mh−floor)/(cap−floor)))
waterKg = M·dvMps·k
over    = needKg / (min(airKg, needKg) + waterKg)                 // ≥ 1
```

Recomputed with the top fade (floor 1, cap 10, Q 700, A 3.5, airspeed 0, full thrust):

| Earth | 0 | 5 km | 10 | 20 | 30 | 50 | 80 | 90 | 95 | ≥ 100 |
|---|---|---|---|---|---|---|---|---|---|---|
| M | 1 | 1 | 10 | 10 | 10 | 9.6 | 4.5 | 2.8 | 1.8 | 1 |
| over | 1 | 1 | 1.23 | 2.06 | 3.0 | 2.7 | 1.2 | 1.07 | 1.02 | 1 |

Mars surface M 10 (over 3.3); Venus surface 1; Jupiter 1 bar static 10 (over 1.8), at
≥ 390 m/s airspeed 1. **The breathing ceiling on Earth is sharp:** air covers the need
below ~6 km (ρ ≈ 0.61) and M climbs to the cap by ~8–10 km. That is a learnable rule
("below ~6 km you breathe; the stratosphere is expensive"), but it is a cliff, not a ramp.

#### 5.6.4 Gameplay and balance

- Holding full thrust at the cap: 9.6 kg/s → 540 kg lasts 56 s, the 140 kg above reserve
  at start 15 s, Aux 940 kg 98 s (vacuum: 9.4 min).
- Without airspeed (§6 not landed) the ram credit is 0. Budgets that leaned on ram credit
  (the designer's "72 kg dive to 30 km") must be re-derived after A1–A3. Rule of thumb now:
  every m/s of Δv spent between ~8 and ~90 km costs up to 10×.
- Free coasting (no gravity/drag) means a moving player only pays for turning, braking and
  boost in the band. Accept now; re-entry heating (E7) and any future drag add the cost of
  diving fast. Revisit with `FLIGHT_MODEL_PLAN`.
- Overdrive heat: q = `atmoOverdriveHeatKW`·θ·clamp(log₂(over)/2, 0, 1). At 30 km static
  full thrust, 119 kW against radiators 77.1 + 50h kW ⇒ equilibrium h ≈ 0.84 (warning
  band). Boost (+144.9 kW) goes past 0.9 and throttles. **Mining or processing in the
  stratosphere shares the same heat store and will overheat**: intended, state it in the
  hint.
- **Switching is automatic**, continuous in the physics. Only the HUD glyph has
  hysteresis.
- **HUD (visual-first, no text):** one drive glyph on the `ShipDashboard` fuel bar: none in
  vacuum, cyan intake-wave when M ≤ 1.2 (breathing), amber droplet pulsing ∝ log M above
  1.5. Fuel-bar drain shimmer tinted by M; overdrive shows through the existing heat bar.
  One-time `useHint` ("thin air costs fuel"), not comms. Needs a transient drive slice
  sampled through `store/shipResources.ts` at human rate (excluded from the save).
- **Transit:** add refusal `IN_ATMOSPHERE` when the start is below top + margin (a
  sustained full-power torch); `TransitHUD` shows a climb arrow.
- **Simplifications to state in code comments:** pressure thrust ignored (−p_a·A_e is −5 %
  at sea level, −12 MN on Venus); intake/ram drag ignored (340 kN, 14 % of thrust at
  400 m/s); compressor work (~0.4 GW, ~9 % of jet power) ignored; overdrive heat is a game
  abstraction (real jet power at over 3 is 3× the safe value).

#### 5.6.5 Tuning constants (`resourceTuning.ts`, Settings → Dev)

| Name | Default | Meaning |
|---|---|---|
| `atmoHandoffRhoKgM3` | 3.1e-6 | torch at full power at or below this density |
| `atmoFloorRhoKgM3` | 1.225 | f stops falling above this density |
| `atmoPowerExponent` | 0.5 | f ∝ ρ^−α (game choice) |
| `atmoIntakeM3PerS` | 700 | static intake |
| `atmoIntakeAreaM2` | 3.5 | ram capture area |
| `atmoBreathingFuelMult` | 1.0 | floor for M (< 1 would reward breathing; exploit risk) |
| `atmoFuelMultMax` | 10 | soft cap for M |
| `atmoOverdriveHeatKW` | 150 | overdrive heat scale |
| `atmoTopFadeFrac` | 0.15 | fade width below each body's top |
| `driveRefMassKg` | 20000 | VFX/HUD only (v_e, P, p_e); fuel model stays mass-free |

Check `difficulty.ts` (copies and scales tuning fields), `save-check.mjs` and the Dev
panel for key enumeration when adding these. `T.propellantKgPerMps` as read by
`__test.gameplay.res.tuning()` must stay the unscaled vacuum rate.

#### 5.6.6 Sim integration (V-series)

- **V1 — `src/sim/atmosphere.ts`** (pure, no component imports). Move the molar-mass
  table out of `atmosphereData.ts` (which then re-exports from sim; its comment forbids a
  duplicate table), **and** γ + the hydrostatic H derivation out of `acoustics.ts`, **and**
  the 12.5·H top out of `deriveAtmosphere`, so render, audio, transit and sim share one
  top. `acousticsForBody`, `TransitTicker` and `deriveAtmosphere` import from it. API:

  ```ts
  export interface AtmosphereModel { bodyId: string; radiusKm: number; topKm: number;
    scaleHeightKm: number; rho0KgM3: number; p0Pa: number; tempK: number;
    molarMassKgPerMol: number; gamma: number; gas: AtmosphereGasId }
  export function atmosphereModel(bodyId: string): AtmosphereModel | null; // cached per system
  export interface Ambient { bodyId: string | null; altitudeKm: number; rhoKgM3: number; pressurePa: number }
  export function ambientAt(frameId: FrameId, posKm: Vec3Like, out: Ambient): Ambient; // incl. top fade; 0 in vacuum
  ```
  Confirm `posKm` is body-centred for every frame id and that non-body frames (Sun) return
  ρ = 0 cheaply. Same module hosts §6's `airVelocityAt`.
- **V2 — `src/sim/ship/atmoDrive.ts`**: `drivePowerFrac(ρ, t)`, `atmoFuel(ρ, airspeed, dv,
  dt, t, out)` → `{ powerFrac, fuelMult, airFrac, overdrive }`, and `drivePlume(...)` (§5.6.7,
  shared local/remote). Allocation-free `out` structs.
- **V3 — wire into the step:** `ResourceRequests` gains `ambientRhoKgM3: 0` and
  `airspeedMps: 0` (defaults keep vacuum bit-identical). `stepShipResources` charges
  `waterKg` only when ρ > 0, adds overdrive kW to heat, keeps a transient `s.drive`
  (excluded from `src/save`). `worstStepKg(…, fuelMult = 1)`: it is hoisted per frame in
  `Spaceship.tsx:392`, so sample ρ per frame for the gate and pass `atmoFuelMultMax`
  (conservative; clips only the last ~1 kg). `Spaceship.tsx` fills `req` from
  `ambientAt(ship.frameId, ship.posKm)` per fixed step; `airspeedMps` stays 0 until A1
  lands (inertial speed would give a false 465 m/s ram credit). Also check
  `store/shipResources.ts` and `loadoutPreview.ts`, which reference `ResourceRequests`.
  `resourceSim`/`transitSim` default ρ = 0; `resourceSim` gets a `{ bodyId, altitudeKm }`
  start option for gates.
- **V4 — HUD glyph + hint + `ResourceTuningControls`** row "1500 m/s hop @ 30 km" computed
  by `atmoFuel` (the same function as the sim).
- **V5 — transit `IN_ATMOSPHERE` refusal.**
- **Co-op:** fuel burn stays client-side. Remote plumes derive f, p_e/p_a and the air/water
  blend from the replicated pose (`f`, `p`) + `th` through `drivePlume` using
  **`DEFAULT_RESOURCE_TUNING`, never local Dev tuning**, so every peer draws the same plume.
  Zero wire bytes.
- **Save/migration:** none (transient state, tuning not saved — verify in `save-check`).

**Gates** (new `GAME_PARTS=atmo` + pure tests):
1. Vacuum bit-identical: m32 V1 axes to 1e-9, 12 kg ±10 % hop, 30/60/144 Hz pacing, m37
   hop bands; plus the other scripts that read propellant (`replication-fuel`,
   `save-check`, `industry-coop`, `industry-ui`, `gameplay-hud`, `gameplay-m36`).
2. Pure `atmoFuel`, full thrust, static, with the fade: Earth SL M = 1 exactly; 30 km
   M 10.0 ±0.05, over 3.0 ±0.1; 90 km M 2.77 ±0.05; 100 km and above M = 1 exactly;
   Venus surface 1; Jupiter 1 bar at 400 m/s 1.
3. Continuity: |ΔM| < 1e-3 per 10 m across every body's top and across ρ_floor.
4. `resourceSim` at Earth 30 km: a 1500 m/s burn costs 120 kg ±2 % and heat rises.
5. At 1 km: 60 s with zero input costs 0 kg; 5 s full thrust costs 4.8 kg ±1 %.
6. Determinism: same totals at 30/60/144 Hz inside the atmosphere.
7. `pnpm lint` errors = 0 after the module move (read the summary line).

#### 5.6.7 VFX hand-off (feeds E2/E3)

Per plume, from `drivePlume` (renderer smooths, sim doesn't): `throttle`, `powerFrac`,
`veKmps`, `mdotKgS`, `powerW`, `airFrac`, `overdrive`, `peOverPa`, `p0Pa`, `machDiskM`,
`cellLenM`, `rhoAmb`, `pAmb`, `gas`, `energyPerNucleonEv`, and J = (F/A)/(ρV²) once
airspeed exists.

Nozzle (20 t reference, θ = throttle): A_e = 1.30 m², p_e ≈ F/(γM_e²A_e) ≈ 164 kPa·θ at
M_e 3. ⚠ M_e 3 with a 4 km/s jet is not self-consistent for air (that gives 2.8 km/s);
4 km/s needs M_e ≈ 4.3 or a lighter, dissociated gas. Treat p₀ (≈ 7 MPa·θ) and M_e as
±40 % until the nozzle is pinned down; p_e and everything derived from F are unaffected.
r* ≈ 0.19 m is geometry (constant); scales go with √θ through p₀.

Earth regime map (full throttle; p_e ∝ θ shifts it):

| Altitude | p_e/p_a | Look |
|---|---|---|
| 0–5 km | 0.5–3 | **Shock cells**, no Mach disk (z_m formula invalid below p_e/p_a ≈ 3–5). Cell length ≈ 1.306·D_j·√(M_j²−1), D_j ≈ 0.99 m, M_j 3.27 ⇒ ~3.7 m; 4–8 diamonds over 15–25 m. Below ~60 % throttle at sea level: over-expanded, pinched, short. |
| 5–25 km | 3–30 | Barrel + **Mach disk**, z_m = 1.34·r*·√(p₀/p_a) (Ashkenas–Sherman): ~2.8 m at 5 km, ~9 m at 25 km. |
| 25–60 km | 30–2,000 | Wide under-expanded bell, disk 10–75 m, faint; collisional plasma, partly ionised. |
| 60–105 km | — | Rarefied, ion mfp > plume: no gas dynamics. §5.4 auroral streak fading into the torch. |
| > top | — | Vacuum torch (§5.3). |

Colour (no soot; corrections applied):
- Air jet ~5 kK: nearly transparent core; Mach disks/diamonds re-heat and glow
  white-violet; O+NO air-afterglow continuum yellow-green to orange; orange-brown NO₂ haze
  downstream. (NO-γ is UV, not visible.)
- Few-eV air plasma (20–60 km): N₂⁺ 391/428 nm violet core, N₂ 1P pink fringe.
- Water share: OH 306–310 nm is UV (at most a violet lift), O 777 nm; Hα weak at these
  temperatures; white condensation cloud downstream at low throttle near the ground.
- **Sodium:** ppm-level Na in hydrate water puts Na D 589 nm into the plume and dominates a
  4 kK water jet's visible colour (yellow-orange). Owner call: unpurified (realistic tint)
  or purified by processing (cleaner look).
- Mars: CN violet 388 nm (from the 2.7 % N₂) dominant, plus CO Ångström / CO₂⁺ FDB
  blue-violet; C₂ Swan green possible.
- Jupiter: hot H₂ nearly invisible at 1 bar; Hα pink-magenta once dissociated/plasma.
- Venus: white-orange glow trapped in fog, crushed jet.

Also missing for later: ground impingement (jet dynamic pressure ~1.85 MPa) and noise
(~1 % of 4.8 GW ≈ 48 MW acoustic, Saturn-V class): matters for audio now and terrain VFX
at M7.

---

## 6. Airspeed relative to rotating atmospheres (A-series)

### 6.1 Bug

Frames are inertial only (`src/sim/frames.ts:15–17`: `"orbit"` is M6, `"fixed"` M7); a
frame origin translates with its body (`frames.ts:127`) but does not rotate. The wind
audio uses `audioShipBuffer.speedMps` (`src/components/Spaceship.tsx:586`,
`max(|velKmps|·1000, transit speed)`) — speed relative to the body centre in a
non-rotating frame — for Mach, q and wall pressure (`src/audio/wind.ts` `updateWind`).
Atmospheres co-rotate with their planet, so:

| Body | Equatorial co-rotation speed | Effect today for a ship "hovering" |
|---|---|---|
| Earth | 465 m/s | false Mach ~1.4, loud wind at rest |
| Mars | 241 m/s | false wind |
| Venus | 1.8 m/s (retrograde) | negligible (super-rotating cloud tops ~100 m/s not modelled) |
| Jupiter | ~12.6 km/s | absurd Mach |

It will also drive plume sweep-back (E2/E3), and any future drag/heating.

### 6.2 Fix

- **A1 — `airVelocityAt` helper in `src/sim/`** (pure maths, no React):
  ω = pole × rate from `bodyOrientation()` (`src/sim/ephemeris.ts:533`; pole in game
  frame, rate = `spinDegPerDay` or 360/(periodHours/24), **sidereal**). Air velocity at
  frame-relative position r: v_air = ω × r (rigid co-rotation). Airspeed vector
  v_rel = v_ship − ω × r. **Verify** retrograde sign (Venus, Uranus) and that the pole is
  in the same axes as the frame's `posKm` (the J2000-vs-equinox-of-date trap cost 33 min
  in E0).
- Applied only inside the atmosphere (blend to inertial speed over the top ~10 % of
  `atmosphereHeightKm`; above that ρ ≈ 0 anyway). Transit keeps its scalar speed (no
  direction available; transit is outside atmospheres).
- **A2 — feed it:** new `audioShipBuffer.airspeedMps` (and the vector in a render-side
  buffer for the plume); `wind.ts` uses airspeed for Mach/q/SPL; `speedMps` stays for
  everything else (HUD speed, Doppler later).
- **A3 — body pick:** `getDominantAtmosphereBody()` (`atmospherePass.ts:1425`) is
  nearest-by-distance (can pick the atmosphere-less Moon over Earth) and drops for a
  frame during texture loads. For wind and plumes use the nearest body *with an
  atmosphere* whose top is within range, and hold the last value through dropouts.
- Out of scope: zonal winds / jet streams, Venus super-rotation, gas-giant differential
  rotation (use System III). Note them as data, not code.

**Gates (headless):** ship co-moving with Earth's surface at 1 km, equator → airspeed
< 1 m/s and wind silent; inertially stationary at the equator → 465 ± 2 m/s; at the pole
→ ~0 either way; Jupiter equator co-moving → < 10 m/s. Re-run the wind audio checks
(`__audio.selftest()`, `pnpm check:audio`) and `FLIGHT_PARTS=sim`.

A session card for A1–A3 was proposed separately ("Airspeed relative to rotating
atmospheres"); this section is its spec.

---

## 7. Light-speed delay for co-op (opinion, deferred)

Cheap: keep a timestamped history of each remote ship's pose and effects (Mars at
maximum distance ≈ 1 MB per player at 20 Hz). Each frame draw each remote at the
retarded time (solve d = c·Δt in 2–3 iterations); deliver events (explosions) when their
light front arrives. CPU bookkeeping, no render cost.
Design catch: Moon 1.3 s, Mars 3–22 min, but at those distances objects are far below a
pixel (only flashes show), and instant voice/chat contradicts it while delayed chat hurts
co-op. **Recommendation:** later, presentation-only for remote events beyond ~1 light-s;
simulation stays instant; chat never delayed by default.

---

## 8. Tooling

- Driver: make `--perf` (vsync) the default, add `--fps 30`, pause rendering between
  steps of a kept Chrome. Avoids the thermal problem in §0.
- Add a reusable VFX capture script under `scripts/drive-examples/` (beam orbit, station
  drift, umbra pair, descent ladder) so every phase's gate is one command.

---

## 9. Sequencing

| # | Item | Depends on | Why this order |
|---|---|---|---|
| 1 | **A1–A3** airspeed + body pick | — | Small, fixes the wind audio now; E2 needs it |
| 2 | **B1** straight beam, mesh hit, halt on miss | — | Owner decision made; gameplay gates must be re-run |
| 3 | **L1–L2** light points | — | Shared by lamps, beam, impact, far exhausts |
| 4 | **B2–B4** shared beam, upgrades, far beams | 2, 3 | |
| 5 | **I1–I4** impact | 2 | |
| 6 | **L3** Blender light empties | 3 | Needs the owner's model pipeline; coordinate with uncommitted model work |
| 7 | **E1** vacuum plume | 3 | |
| 8 | **S1** analytic occluders | — | Near-free, big visible win |
| 9 | **E2** atmosphere inputs | 1, 7 | |
| 10 | **V1–V5** variable-Isp drive (§5.6) | 1 (V1 hosts `airVelocityAt`) | Sim-core + fuel change; full gate re-run |
| 11 | **E3–E4** regimes + halo | 9, 10 | |
| 12 | **S2** shadow map | measure | 0.3–1 ms budget item |
| 13 | **E5** shimmer pass | 11, measure | New full-screen pass |
| — | E6 contrails, E7 re-entry plasma, §7 light delay, S3 | later | |

Budget for everything above at the asteroid-field scenario: ≤ +1.5 ms GPU p50 total,
with S2 and E5 the only items allowed > 0.2 ms each.

---

## 10. Open questions

1. ~~Drive behaviour in atmosphere~~ decided: variable-Isp mode (§5.4, design §5.6).
2. Beam colour per upgrade tier, or one colour with brightness only (B3).
3. Silhouette debounce for halt-on-miss: 0 or ≤ 0.15 s (B1).
4. Mars (CO₂) emission tint: CN violet now looks dominant; confirm before E3.
5. Should breathing air be *cheaper* than vacuum (`atmoBreathingFuelMult` < 1)?
   Recommendation: 1.0 now (no exploit); 0.3–0.5 later as a "breathe to save fuel" reward.
6. Honest mid-band fuel cost is 30–150×. Recommendation: soft cap 10, excess as overdrive
   heat (§5.6.3).
7. Free coasting through the expensive band (no gravity/drag). Recommendation: accept now,
   revisit with FLIGHT_MODEL_PLAN and E7.
8. Venus: chamber pressure below ambient. Recommendation: ignore pressure thrust, render a
   crushed jet, state the simplification.
9. Mars at cap everywhere (thin CO₂). Recommendation: keep ("Mars is expensive, Jupiter
   breathes"); if playtests hate it, raise `atmoIntakeM3PerS`, no per-body cases.
10. Plume sodium tint: unpurified hydrate water (yellow-orange Na D) or purified (§5.6.7).

---

## References

- [14 CFR § 25.1401, anti-collision lights](https://www.law.cornell.edu/cfr/text/14/25.1401)
- [FAA AC 20-74](https://www.faa.gov/documentLibrary/media/Advisory_Circular/AC_20-74.pdf)
- [DLR, laser plasmas on basalt in vacuum (EPSC2024)](https://elib.dlr.de/208368/1/EPSC2024-232-print-1.pdf)
- [DLR, Icarus paper](https://elib.dlr.de/209443/1/1-s2.0-S0019103524004366-main.pdf)
- [Fiber laser spatter on olivine/pyroxene](https://core.ac.uk/download/401689353.pdf)
- [Basalt laser melt droplets](https://katalog.lib.cas.cz/KNAV/EdsRecord/edb,141916013)
- [ns-laser vacuum melt droplets](https://cris-portal.uni-muenster.de/portal/en/publication/83324386)
- [Pulsed discharges in water, Hα prominent](https://arxiv.org/pdf/2102.02760)
- [Water-vapour Hall thruster](https://link.springer.com/content/pdf/10.1007/s44205-023-00047-w.pdf)
- [KSP2 exhaust VFX dev diary](https://kerbalspaceprogram.com/news/dev-diaries-developer-insights-11-engine-exhaust-visual-effects)
- [Star Citizen GPU-particle thrusters](https://www.moddb.com/news/engine-effects-quite-literally)
- [Shock diamond](https://en.wikipedia.org/wiki/Shock_diamond)
- [Aerospaceweb: nozzle expansion](https://aerospaceweb.org/question/propulsion/q0220.shtml)
- [Space jellyfish](https://en.wikipedia.org/wiki/Space_jellyfish)
- [Ashkenas–Sherman Mach-disk scaling (via astro-ph/0701854)](https://arxiv.org/pdf/astro-ph/0701854)
- [JFM shock-cell model](https://www.cambridge.org/core/journals/journal-of-fluid-mechanics/article/abs/multiplescales-model-of-the-shockcell-structure-of-imperfectly-expanded-supersonic-jets/C54F4B27A7FEDE57B5029595296B9AFF)
- [Riabov 1995, underexpanded jets](https://www2.rivier.edu/faculty/vriabov/Riabov_JAircraft_1995_V32_N3.pdf)

Unverified numbers (treat as order of magnitude): ion stopping Σ, shock-cell
coefficient, Mars CO₂ tint, vacuum plasma line emission.
