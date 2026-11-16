# Stellar Nomad — Roadmap

**Status:** active roadmap; original proposal 2026-11-13, gameplay/story direction and
M3 scope agreed 2026-11-15. M0/M1 are built as recorded below; M2 is in progress.
Supersedes `CURRENT_PLAN.md` (the old asteroid-streaming brief, long since built).

This document orders the nine big items (multiplayer, physics, game loop, terrain, flight
model, clouds, procedural systems, asteroid fields v2, ship interiors), splits them where
parts of one depend on parts of another, and defines milestones with exit gates. Each
milestone marked *own plan doc* gets a detailed design doc when it starts; this file only
fixes order, scope and the seams between them.

**Gameplay handoff:** [GAMEPLAY_AND_STORY.md](GAMEPLAY_AND_STORY.md) records the agreed
sandbox, nomadic progression, replication, and Von Neumann premise.
[M3_GAMEPLAY_PLAN.md](M3_GAMEPLAY_PLAN.md) is the detailed M3 design and ordered
implementation plan. These documents include the discussion absent from the original
M0–M2 implementation context. They supersede the old root story/progression documents;
the following historical survey is not a description of the current code.

---

## 1. The short answer

Your instinct on priority is right: **flight model and game loop first**. But four small
foundations sit underneath almost everything on the list, and three of them are cheap now
and very expensive to retrofit:

| # | Foundation | Why it cannot wait |
|---|---|---|
| F1 | **Ship sim out of React** (`Spaceship.tsx` → `src/sim/ship/`) | Flight model, physics, remote players and drones all need "a ship" to be data plus a step function, not a component |
| F2 | **Reference frames** (ship position relative to a body, not to the Sun) | Real-time orbits, stations, ring fields, landing, and any position sent over the network |
| F3 | **Player state vs world state, mutated through commands** | Multiplayer. Stations, drones and shared storage built on today's global atoms would be written twice |
| F4 | **Parameterised body description** (one generic body renderer) | Procedural systems, clouds on other planets. Not urgent; listed so it is not forgotten |

So the order is: **F1–F3 → flight model → physics → solo survival loop → co-op → shared
structures and drones → asteroid fields v2 → terrain → generic bodies / clouds / gas giants
→ procedural systems → interiors.**

Multiplayer is *architecturally* early (F3) and *feature-wise* in the middle: it lands
after the solo loop is fun but **before industrial stations and drones**, so those are
built once, networked from day one. **Exception decided for M3:** a simple standalone
replication point is pulled forward from M5 to support nomadic solo recovery. It uses
the shared-world authority/save seam immediately; M4 networks it along with discoveries
and shared research. It does not pull depot storage or general station building forward.

---

## 2. Historical baseline before M0 (surveyed 2026-11-13)

Only the facts that drive the ordering. File references are where to start reading.

**Ship and flight** — [`Spaceship.tsx`](../src/components/Spaceship.tsx)
- One 629-line component holds input read, flight integration, celestial collision, death,
  chase camera, camera shake, HUD write, audio write and persistence.
- State is `posKm`, `simQuat`, and a **scalar `speed` along the forward axis**. There is no
  velocity vector, no mass, no roll, no strafe. Base top speed 400 m/s.
- Fixed 120 Hz step with render interpolation and a floating origin: a good substrate,
  already what physics and netcode want.
- Input is `movementAtom {yaw, pitch, speed}`. Keyboard gives -1/0/1. **There is no mouse
  steering at all** (no pointer handlers, no pointer lock) and no gamepad code.

**World and time**
- The ship lives in a Sun-centred frame. `simRateAtom` defaults to **0 (time frozen)**. If
  it is non-zero, bodies and asteroid field anchors move and the **ship is left behind**
  (Earth leaves at ~30 km/s). Nothing inherits a body's velocity.
- One system (`sol.json`, 14 bodies). `systemRegistry.ts` already lists the four blockers to
  a second system; three are mechanical, the fourth is F4.
- Transit drive: Newtonian flip-and-burn at 800 km/s², no speed cap, so interstellar legs
  exceed c by a wide margin. Not relativistic, not labelled as FTL.

**Game state**
- 15 separate `localStorage` keys, versioned ad hoc per key. No save object, no IndexedDB.
- No distinction between "mine" (cargo, research, modules) and "the world's" (asteroid
  deltas, wrecks). ~8 module-level single-ship buffers (`transitDriveBuffer`,
  `audioShipBuffer`, `poiBuffer`, …). Mining finds the ship by scene-graph name.
- No entity abstraction: no other ships, drones or stations. No networking code.
- The loop that works end to end: target → mine → assay samples → research (14 nodes) →
  craft (32 items, 7 slots) → equip → transit to the Moon field. No survival pressure
  except collision damage.

**Asteroids** — [`src/sim/asteroids/`](../src/sim/asteroids)
- Two fields, both spheres of 2,000–3,000 km. Shapes: sphere, box. Density: one constant
  plus edge falloff. One uniform 20 km chunk grid, capped at 5,000 chunks (~210 km load
  radius). 3 GLB models. Static. Deterministic from seed plus a per-field list of destroyed
  ids, which is already the right shape for multiplayer.
- Collision: discrete point-in-sphere at 10 Hz; the asteroid is deleted on contact.
  [`PHYSICS_PLAN.md`](PHYSICS_PLAN.md) §1.3 documents this fully.

**Planets**
- Plain `SphereGeometry` (128² near). Collision is a sphere at `radiusKm`, any contact is
  death. No terrain code of any kind. Height data on disk: Moon only (used as a bump map).
- Saturn's rings: textured annulus. The atmosphere pass uses a *separate hand-written*
  analytic density profile, not the texture.
- Depth: `logarithmicDepthBuffer: true` in `Scene.tsx`, while `cameraPlanes.ts` says never
  to use it. One of the two is stale; terrain needs this settled by measurement.

**Clouds** — Earth only; pipeline, shadow map, light volume and matrix source are
module-level singletons. Gas giants are Phase 8 of [`CLOUD_TYPES_PLAN.md`](CLOUD_TYPES_PLAN.md).

**Existing plans that stay valid:** `PHYSICS_PLAN.md` (Rapier behind a facade, P0–P4),
`CLOUD_TYPES_PLAN.md`, `CLOUD_SHADOWS_GODRAYS_PLAN.md`, `STAR_RENDERING_PLAN.md` §25–§28
(system switch blockers, parked procedural stars). **Superseded:** `STORY.md`, the story,
comms and prescribed progression parts of `GAME_DESIGN.md`, `CURRENT_PLAN.md`, and
`COMMS_IDEAS.md`. Current gameplay/story requirements are in
[GAMEPLAY_AND_STORY.md](GAMEPLAY_AND_STORY.md); M3 details are in
[M3_GAMEPLAY_PLAN.md](M3_GAMEPLAY_PLAN.md).

---

## 3. How the nine items split

| Your item | Splits into | Lands in |
|---|---|---|
| Flight model | sim extraction (F1) · velocity-vector 6DOF + flight assist · mouse/input layer · camera rig · atmospheric drag | M0, M1, (drag: M7) |
| Physics | near-field collision + response (`PHYSICS_PLAN` P0–P3) · ship-vs-ship, debris (P4) · terrain heightfield collision | M2, M5, M7 |
| Game loop | nomadic solo survival, discovery-based research, simple replication · industrial stations, fuel routes, drones · branching regional/interstellar opportunities | M3, M5, then with each world milestone |
| Multiplayer | state/authority split (F3) · presence · shared world deltas · shared structures · dedicated server | M0, M4, M5, later |
| Asteroid fields v2 | chunk-keyed deltas (F3) · new shapes + density functions + multi-scale grid · rings · system-wide belts | M0, M6 |
| Terrain | rotating frames · quadtree LOD + real data (Moon) · collision + landing · Mars · Earth · walking | M7, later |
| Clouds | perf/look polish (parallel, optional) · un-singleton per body · gas giants | track C, M8 |
| Procedural systems | generic body renderer (F4) · system generation · system switching · procedural stars (S6) | M8, M9 |
| Ship interiors | cockpit camera (cheap, falls out of M1's camera rig) · walkable interior | M1 option, M10 |

Dependencies that are easy to miss:

- **Flight assist needs frames.** "Come to a stop" means zero velocity *relative to
  something*. Without F2 that something is the Sun.
- **Contact response needs the new flight model.** An impulse needs a velocity vector and a
  mass; today's ship has neither. Doing physics before the flight model means doing P3 twice.
- **Rings and belts need frames.** Ring particles orbit Saturn at ~20 km/s. A player can only
  mine there if the field is a co-moving frame the ship rides in.
- **Stations and drones need both the entity table (F1) and the authority split (F3).**
- **Landing needs rotating frames, terrain and physics**, in that order.
- **Procedural planets need terrain + generic bodies + per-body clouds.** It is the last
  world feature because it is the sum of the others.

---

## 4. Milestones

Sizes are relative: S (days), M (1–2 weeks), L (several weeks), XL (months).

### M0 — Foundations · ✅ built 2026-11-14 (branch `m0-foundations`)

**As built** (each part: implemented, reviewed by two independent reviewers, fixed, then
re-verified headless; gate scripts live in `scripts/drive-examples/`):

| Part | Where | Gate script | Measured |
|---|---|---|---|
| M0.1 | `src/sim/ship/`, `src/sim/entities.ts`, `src/components/Camera/chaseCamera.ts` | `flight-trace.mjs` | per-step motion equal to the pre-refactor baseline within key-timing noise (<2%) |
| M0.2 | `src/sim/frames.ts`, `src/sim/ship/shipFrame.ts`, `src/components/frameOrder.ts` | `frames-check.mjs` | parked 500 km above the Moon at 10⁴× time: frame-relative position bit-identical while the Moon moved 1.45 M km; ship↔body offset spread 1.8e-12 km over 120 frames; no jump crossing the Moon's SOI either way |
| M0.3 | `src/save/`, `src/sim/world/`, `src/store/savedAtom.ts`, `src/store/worldBridge.ts` | `save-check.mjs` | fresh world, legacy import (15/15), export→reset→import round trip, reload persistence, write isolation all pass |
| M0.4 | `src/components/AppShell/`, `src/components/Loading/`, `src/sim/simPause.ts` | `shell-check.mjs` | title interactive in ~0.2 s warm with no game asset or WebGPU device (only UI sounds and the title theme, "Glacial Pads", which starts on the first key press or click); cold-cache first 10 s of play: max frame 24 ms gated vs 539 ms ungated |

Deviations and open items:
- **Sim time now runs at 1× by default** (D6). Bench and `__test.isolate()` freeze it.
- `movementAtom` and its keyboard/touch writers are unchanged; the `ShipInput` buffer and
  the input layer move to M1, where they are redesigned anyway.
- No consumer needed `getLocalPlayerShip()` yet: mining needs the rendered Object3D, the
  wreck collector reads `worldOrigin`. The entity table exists for M1/M4.
- Transit velocity is **not** converted on a frame switch: `TransitTicker` keeps only the
  speed and re-aims along the ship's forward, so adding a vector changed the speed
  arbitrarily. Revisit with M1's velocity vector.
- Transit from the spawn field to the Moon stops at Earth: Earth is in the line of sight at
  the default date and the existing proximity brake fires. Existing behaviour.
- Cloud temporal reprojection compensates Earth's orbital motion but not its rotation
  (~8 m per frame at the equator at 1×); checked visually only. A body-fixed frame (M7)
  removes the cause.
- `renderer.compileAsync` takes 2–8 ms and gives no measurable warm-up benefit with this
  renderer; the loading gate's run of fast frames is what hides the hitches.
- **Not verified at runtime:** a full mine-one-asteroid sequence (aiming is not scriptable
  yet; confirmed by hand on 2026-11-14), the renderer-failure screen (no run with WebGPU
  disabled), and the music hold during loading (no recording taken).
- `src/sim/nearbyStars.ts` still imports a helper from a component and is on the ESLint
  guard's ignore list; move `equatorialToGame` into `src/sim`.
- Difficulty and seed are stored per world and consumed by nothing until M3.

Original scope, for reference:

**M0.1 Ship sim extraction (F1)**
- `src/sim/ship/`: `ShipState` (frame id, position, orientation, later velocity),
  `ShipInput` (plain intent struct), `stepShip(state, input, env, dt)`. No React, no R3F.
- `src/sim/entities.ts`: a table of simulated things (`id`, `kind`, frame, pose). The local
  player is entry 0. `worldOrigin.shipPosKm` stays as "the camera's focus entity"; its 73
  call sites are **not** mass-migrated.
- `Spaceship.tsx` shrinks to a view. Camera moves to its own `ChaseCamera` rig. Input
  writers fill a `ShipInput` buffer instead of `movementAtom`.
- Mining looks the ship up in the entity table, not by mesh name.
- **Exit gate:** a scripted `pnpm drive` flight produces the same pose trace before and after.

**M0.2 Reference frames (F2)**
- `src/sim/frames.ts`. A frame is anything with an analytic pose over time:
  `poseAt(t) → origin (f64 km), orientation, linear + angular velocity`. Three kinds are
  planned; **only the first is built now**:
  1. *body-inertial*: moves with a body, does not rotate (this milestone)
  2. *orbit co-moving*: rides a circular orbit around a body (M6: rings, belts, stations)
  3. *body-fixed*: rotates with the surface (M7: landing)
- The ship stores `frameId` + position in that frame. Sphere-of-influence switching with
  hysteresis; position and velocity are converted on a switch.
- This is how we get "planets move in real time but do not fly away" **without gravity**:
  the ship rides whichever frame it is in. No orbital mechanics for ships.
- Transit autopilot targets a point in the *destination's* frame. Celestial collision sweeps
  in relative coordinates (fixes `PHYSICS_PLAN` C4).
- **Exit gate:** with sim rate 10⁴, a ship parked 500 km from the Moon holds its offset;
  Earth→Moon transit arrives at the intended standoff; no pose jump on frame switch
  (measured through `__test`, not by eye).

**M0.3 State split and save v1 (F3)**
- **PlayerState** (pose, health, cargo, modules, research) vs **WorldState** (seed, sim
  epoch and rate, asteroid deltas, wrecks, later structures and drones).
- Shared-world mutations go through **commands** (`asteroid.destroy`, `wreck.collect`, …)
  submitted to an `Authority`. Solo play uses a synchronous in-process `LocalAuthority`.
  Jotai atoms stay as the UI's read view. Add the rule to `CLAUDE.md`.
- Versioned saves in IndexedDB, **one record per world** (name, seed, difficulty, created /
  last-played, WorldState, and PlayerState keyed by player id), with a migration that turns
  today's localStorage keys into "World 1". Settings, keybinds and audio prefs stay in
  localStorage (they belong to the device).
- Asteroid deltas re-keyed per chunk (a per-field array does not scale to M6).
- `src/sim/**` may import `three` math but nothing from React, R3F or the DOM, so the world
  sim can later run headless. Enforce with an ESLint `no-restricted-imports` rule.
- Remove the narrative comms; keep the ship-AI messages (already decided 2026-09-16).
- **Exit gate:** export → reset → import restores a session exactly; no caller of
  `destroyInstance` outside the authority.

**M0.4 Title screen and loading · size M**

Today the game boots straight into the last position and streams assets while playing.
- **Title screen**: Continue · New world (name, seed, difficulty) · Load world · Settings.
  Host / Join are added by M4. The click that starts a game is also the user gesture that
  unlocks the `AudioContext` and pointer lock, so both stop being special cases.
- **Loading stage with real progress**, gated on three things in order: assets fetched
  (KTX2, GLB, noise volumes, star catalogue, audio), render pipelines compiled
  (`renderer.compileAsync`, the WebGPU first-use stutter is otherwise paid in flight), and
  the first settled frame (`__test.settled` already defines this). Then fade in.
- The canvas stays at `frameloop="never"` until the gate opens; once the scene is warm the
  title screen can show it live as a backdrop.
- **Exit gate:** cold-cache start shows no frame over a set budget in the first 10 s of
  flight at a named `__bench` scenario; warm-cache time-to-title measured and recorded.

### M1 — Flight model v2 · ✅ built 2026-11-15 (branch `m1-flight-model`), awaiting playtest

Design and as-built notes: [`FLIGHT_MODEL_PLAN.md`](FLIGHT_MODEL_PLAN.md). Gate script:
`scripts/drive-examples/flight-trace.mjs` (`FLIGHT_PARTS=sim,live,mouse,camera,reticle`),
14 of 14 pass. Open: the playtest that turns the starting values into defaults; pointer
lock paths for boot failure and alt-tab, and the reduced-motion camera, were checked by
reading the code only.

Original scope, for reference:

- **Velocity-vector flight, 6DOF**: pitch, yaw, roll, lateral/vertical strafe, throttle,
  boost, brake. Ship stats become physical (mass, thrust per axis); module effects remap.
- **Flight assist** as a controller on top of Newtonian state. *Coupled* (default): velocity
  is driven toward the commanded vector within per-axis acceleration limits, strong main
  engine, weaker retro and lateral. *Decoupled* (toggle): drift, for skilled play.
  Angular: rate command with acceleration limits instead of today's lerp damping.
- **Input layer**: devices map to `ShipInput`. Mouse via pointer lock, two mappings to
  playtest: virtual stick (Star Citizen / Elite) and aim-to-turn (No Man's Sky). Gamepad
  later is just another mapper. Touch keeps working.
- **Camera rig**: spring lag, look-ahead, FOV response, free look. A cockpit camera becomes
  one more rig once a cockpit model exists.
- **Speed regimes** need a design decision (D5 below).
- **Exit gate:** scripted manoeuvres with numeric targets (stop time from top speed, 180°
  turn time, strafe authority), then your playtest.

### M2 — Near-field physics · ✅ built 2026-11-17 (branch `m2-physics`), awaiting playtest

As built: [`PHYSICS_PLAN.md`](PHYSICS_PLAN.md) §7. Gate script:
`scripts/drive-examples/physics-check.mjs` (`PHYS_PARTS=sim,damage,hull,asteroids`, plus
`live,park,switch,transit,foreign` and, with `--perf`, `cost,stream`).
- Rapier 0.21 behind `src/sim/physics/`; ship hull 7.8 × 2.0 × 6.6 m from its own mesh,
  rocks as convex hulls of their LOD1 meshes, matching the rendered instance to 0.05 cm.
- Asteroids no longer vanish on contact: the ship bounces, damage follows impact speed
  (nothing under 8 m/s, lethal from 120 m/s). Pushable or shattering rocks: M5.
- Asteroids are not solid above 0.9 km/s, in transit, or under the dev speed override.
- Cost: 0.2 ms per step with 40 colliders, 0.46 ms with 2,000. Download +1.65 MB.
- Asteroid render precision (found in playtest, predates M2): instance positions were f32
  metres from the field anchor (~2,800 km away → 0.25 m steps, visible jitter up close).
  Now stored split on a 1 km grid and subtracted from the world origin part by part:
  error 0.22 m → under 0.7 mm. Gate: `scripts/drive-examples/asteroid-precision.mjs`.
  Side effect: the far tier's fade measured distance from the field anchor and hid far
  billboards at the start pose; it now uses camera distance, so more distant rocks show.
  Cost: +16 B per slot (+48 MiB GPU and CPU reserved across 6 allocators; size them per
  field as a follow-up).
- Open: playtest of bounce and damage values (Settings → Dev → Physics); with the default
  3 km radius the field is so sparse (~0.5 rocks in range) that streaming was only
  exercised with a widened radius; if the engine fails to load, asteroids have no collision.


Execute the current contract in [`PHYSICS_PLAN.md` §7](PHYSICS_PLAN.md#7-m2-as-decided-2026-11-16--supersedes-3-where-they-differ),
which supersedes that document's older P0–P3 details where they differ. Keep one flight
integrator and a near-field contact resolve step, frame-relative local metres, a speed
gate, and the raw Rapier facade (`@dimforge/rapier3d-simd-compat`). Asteroids stay fixed
and are not destroyed by ramming; damage follows the contact-normal delta-v curve.
Celestial swept collisions stay lethal until terrain/landing. **Exit gates:** §7.4,
including M0/M1 regressions. Record as-built results when actually verified; this
gameplay documentation update does not mark M2 complete.

### M3 — Solo exploration and survival · size L · design ready

Detailed design, code map, migrations, ordered phases M3.0–M3.8, and verification:
[`M3_GAMEPLAY_PLAN.md`](M3_GAMEPLAY_PLAN.md). Agreed gameplay/story decisions:
[`GAMEPLAY_AND_STORY.md`](GAMEPLAY_AND_STORY.md). No M3 implementation is claimed yet.

- **Outcome:** a self-sufficient probe can prepare a worthwhile lunar-orbit expedition,
  establish a new recovery point, and keep operating there without returning to Earth.
  One-way relocation, settling, and continued nomadic exploration are all valid.
- **Starter self-sufficiency:** basic scanning, mining, analysis, onboard fabrication,
  hydrate-to-propellant processing, common-material repair, and an initial replication
  point. No Earth service, rare drop, or lunar material is required for basic survival.
- **Prospecting and progression:** useful composition/yield inspection, persistent
  resource/site discoveries, typed discovery/trial-based research, and a small branching
  equipment catalogue. Remove the generic-assay/timer grind and the unrelated
  three-tier-2 transit prerequisite. Basic scanner information is not a consumable tax.
- **Pressures:** propellant spent on actual thrust/transit; reactor output and capacitor
  constrain simultaneous/burst work; shared heat throttles sustained activity before
  damage; hull repairs cost material. Safe inactivity has no upkeep. Preserve M2's
  collision/damage contract. No oxygen, food, crew, or archive meters.
- **Fuel-aware travel:** ETA/burn/arrival reserve, safe abort/braking fuel, and reachable
  clearance legs where Earth blocks the lunar route. One initial propellant; distant
  drive physics/fiction remains D4. A small reserve is not a substitute for recovery.
- **Replication pulled forward from M5:** craft/place/name a standalone point anywhere
  usable and safe; placement activates it for its owner; explicit nearby activation
  selects an existing point. No depot storage, modular stations, or station physics.
- **Loss:** restore at the last activated valid point; leave cargo/consumables and
  remaining ordinary fuel in recoverable wrecks. Preserve research, discoveries,
  manufactured permanent equipment, and archive copies. Emergency abandonment uses
  the same flow. Protected recovery allowance plus an explicit supplied-starter fallback
  prevents isolated-point/zero-fuel loops; these are first-slice implementation defaults.
- **Playable content:** Earth and lunar orbital regions with practical local resources,
  several useful opportunities, and one small lunar survey-equipment/sample recovery
  activity. No terrain or surface extraction. No easy helium-3 early economy.
- **Guidance:** optional player-selected projects, contextual companion-AI hints and
  records; no prescribed ground-control campaign or mandatory return-home objective.
- **State:** research/evidence/discoveries and placed points are shared world state
  through the authority. Fuel, equipment, tracked projects, and active replication ID
  remain per-player. Migrate old saves without erasing progress; atomic loss/transfer
  operations must survive reloads and future asynchronous M4 acceptance.
- **Difficulty:** balance Standard first; simple resource/damage multipliers for the
  other presets. Preserve the recovery/knowledge model; old punitive hard-mode module
  loss and in-place explorer respawn are not M3 requirements.

**Exit gates:** a fresh save completes scan → mine → process → research → craft/equip
→ lunar transit → survey/salvage → replication placement → destruction → restoration
→ partial/full cargo/fuel recovery. At least two viable early investment priorities,
one understood resource decision, indefinite practical self-sufficiency near the Moon,
usable zero-fuel/invalid/isolated-point recovery, migration/reload integrity, measured
performance, and passing M0–M2 regressions. Detailed cases are in the plan; reaching
the Moon alone is insufficient.

### M4 — Co-op v1 · size L · *own plan doc*

- **N0 session + transport** (D1): host-authoritative; the host's game applies commands.
  **WebRTC data channels**, star topology (host ↔ each guest), behind a small `Transport`
  interface so a dedicated server can speak something else later. Two channels: reliable
  ordered for commands, unreliable unordered for pose snapshots (WebSockets cannot do the
  second; one lost packet would stall every pose behind it). Native browser API, no library.
  - Needs **signalling** only while connecting: a join code plus an offer/answer exchange.
    Short-lived HTTP requests against a small key-value store are enough, so this fits
    serverless hosting and needs no always-on process.
  - Needs public **STUN** (free) and a **TURN** fallback for the minority of networks where
    a direct connection fails. TURN relays traffic and can cost money; pick a provider in
    the M4 plan and verify its current free tier then.
  - ⚠ Browsers throttle background tabs. If the host tabs away, the authority stalls for
    everyone. Either run the authority in a Web Worker or pause the session; decide in the
    M4 plan with a measurement, since it shapes where F3's `Authority` lives.
- **N1 presence**: remote ships as entities; pose snapshots in frame-relative coordinates
  at ~15 Hz with an interpolation buffer; shared sim clock from the host; remote exhaust,
  lights and spatial audio. Each client simulates its own ship. No rollback, no lockstep.
- **N2 shared world**: asteroid deltas, mining locks, cargo/fuel wrecks, M3 replication
  points, discoveries/evidence and research unlocks through host commands; join-in-progress
  sends the world save. Do not reintroduce individual research grinding.
- **N3 player persistence** (D2), individual active replication selections, and item/fuel
  transfer between players. All essential activities remain possible solo; no compulsory
  crew roles or synchronized progression attendance.
- Scale target: a handful of ships. Friends only, so no anti-cheat.
- **Exit gate:** two browsers mine the same field for 30 minutes; world saves are identical
  afterwards; a late joiner sees the same destroyed asteroids.

### M5 — Industrial structures, sustainable routes, and drones · size L · own plan doc

- Extend the simple M3 placeable/authority model into **depots** with shared storage,
  expanded fabrication and specialized production. Basic ship self-sufficiency remains.
  A depot may include replication; respawning is no longer a depot-exclusive feature.
  Use existing body frames initially or pull an orbit co-moving frame forward only if
  needed. No compulsory fixed home.
- **Fuel production and routes:** a refinery at a resource source can supply itself;
  relay depots receive cargo deliveries. Players carry construction outward and establish
  longer routes. Adequate production/transport/buffers make a route sustainable without
  constant manual top-ups.
- **Drones v1:** UI-assigned jobs, resource filters/priorities, destination, return reserve,
  and stop conditions. No required scripting, random breakdowns, or recurring maintenance.
  Simulate detailed work nearby and resource-conserving rates/routes remotely. A few
  detailed drones per station, not hundreds of full rigid bodies.
- Physics P4: ship-vs-ship and ship-vs-station contact, mining debris.
- **Exit gate:** two players and two drones operate a depot and a supplied fuel route;
  state survives host restart, and sustained operation needs no manual refill round.

### M6 — Asteroid fields v2 · size L · *own plan doc*

- **Shapes**: annulus/disc with thickness, torus, shell, orbit band.
- **Density as a composed function**: constant × radial profile × 3D clumping noise.
  Saturn's ring mesh, the atmosphere pass's ring shadow and the field density must read
  **one** radial profile (today there are two that can disagree).
- **Size-stratified grid**: each size band gets its own cell size and load radius,
  proportional to the distance at which that size is visible. Cell count per band stays
  constant, so a field can span a planetary system. Replaces the single 20 km grid.
- **System-wide populations**: main belt, Trojans, Kuiper belt as orbit bands with a
  heliocentric density law; composition by distance from the Sun (rock inside the frost
  line, ice outside), which gives the tier table real geography.
- **Rings**: instances fade in under the texture as optical depth is matched (D7).
- **Orbit co-moving frames** so a ship inside a ring or belt is at rest relative to it.
- More mesh variety (offline-generated set; watch the shader-compile stutter trap).
- **Exit gate:** fly from outside Saturn's rings to a standstill among ring bodies with no
  visible pop, at a named `__bench` scenario within the frame budget.

### M7 — Terrain and landing, Moon first · size XL · *own plan doc*

- **T0 spike**: LOD scheme, tile format and hosting (D8), depth precision (resolve the
  log-depth contradiction by measurement; evaluate reversed-Z), frame budget.
- **T1** body-fixed frames and altitude handoff; replace the death sphere with a height query.
- **T2** quadtree cube-sphere with GPU displacement and geomorphing, cross-faded into the
  existing far sphere so photometry, albedo calibration and eclipses stay valid.
- **T3 Moon**: real elevation (LOLA) down to its resolution; below that, procedural
  amplification from the real crater size distribution plus instanced rocks. The Moon goes
  first because it has no atmosphere, ocean, vegetation or clouds, and it extends the
  already-playable M3 lunar orbital region.
- **T4** heightfield collision patches around the ship, landing gear contact, landing
  assist, surface resource nodes.
- **T5 Mars** (MOLA/HRSC), with atmospheric drag and entry heating in the flight model.
- **T6 Earth** is explicitly last and may stay orbit-only (D9).
- On-foot is a separate later decision (M10).

### M8 — Generic bodies, clouds v2, gas giants · size XL

- **F4**: `BodyDescriptor` → one parameterised renderer (rocky, icy, gas archetypes),
  clearing `systemRegistry` blockers 1–4. Existing hand-tuned bodies become descriptors.
- Clouds: remove the Earth singletons, per-body cloud config, then `CLOUD_TYPES_PLAN`
  Phase 8 (gas giants). Enables the atmospheric collection branch of regional gameplay.

### M9 — Procedural systems and the interstellar loop · size XL

- System generation from stellar parameters: real exoplanets where catalogued, seeded fill
  elsewhere. System activation by distance. Procedural stars per the entry conditions in
  `STAR_RENDERING_PLAN.md` §28.2.
- Interstellar travel design (D4).
- Later astronomical surveying can identify promising systems without revealing exact
  remote deposits. Local investigation and scientific discovery remain worthwhile
  alongside resource gathering. No mandatory sequence through every earlier planet.

### M10 — Interiors and on-foot · size XL · far future

### Later gameplay — regional hazards and optional human restoration

- Introduce intense solar heating, radiation, and specialist extraction alongside the
  regional content that makes preparation for them useful. Scope their thermal/scientific
  models separately; M3 activity heat does not authorize changes to calibrated lighting.
- A Von Neumann probe carries humanity's protected archive after Earth's loss. Finding
  a suitable world and establishing a human colony is an **optional endgame ambition**,
  comparable to a major sandbox milestone, not a required campaign or game-ending trigger.
- Actual habitability/colony systems require their own later plan after the necessary
  exploration/world foundations. They are not silently included in M9 or M10. No archive
  maintenance, decay, countdown, or permanent loss of this goal after ship destruction.

### Track C — Cloud polish · parallel, optional

Clouds are the largest historical time sink in this repo (six docs, ~10,000 lines of
notes). Nothing before M8 depends on them. Recommendation: no cloud work until M3 ships,
then time-boxed sessions only.

---

## 5. Decision record and remaining choices

Do not re-request agreed direction when starting M3. Detailed rule defaults and tuning
values are in its plan; D4/D8 and later feature details remain appropriately deferred.

| # | Decision | Recommendation |
|---|---|---|
| D1 | **Who hosts a co-op world?** | ✅ **Decided 2026-11-13:** a player's browser hosts; dedicated servers only once there are players beyond friends. Transport: WebRTC data channels, see M4 |
| D2 | **Where does progress live in co-op?** | ✅ **Decided 2026-11-13; refined 2026-11-15:** individual ships/equipment/supplies live in the world save keyed by player (Minecraft model); research/evidence/discoveries and structures are shared world state (D11). |
| D3 | **Survival pressures and player identity** | ✅ **Direction decided 2026-11-13; refined 2026-11-15:** propellant, power/capacitor, hull, heat; no safe-idle upkeep. Player is an autonomous Von Neumann probe intelligence, with a distinct companion AI. No crew/oxygen/food/archive care. |
| D4 | **Transit/interstellar travel** | Exact technology remains open before M9. Real-scale short journeys already need an explicit fictional concession; do not label present performance conventional physics or revive a compulsory relativistic/time-dilation campaign. M3 implements honest fuel/ETA/braking rules without settling the final interstellar drive. |
| D5 | **Speed regimes** | Keep two (manoeuvring + transit). Derive the manoeuvring speed cap from stopping distance vs sensor range instead of a fixed 400 m/s, so better engines and scanners raise it |
| D6 | **Run sim time at 1× by default after M0.2?** | Yes. The terminator moves, moons orbit, and frames are exercised constantly instead of only in tests |
| D7 | **Ring particle scale** | Real ring particles are centimetres to ~10 m. Render true scale near the camera and add rarer, larger mineable bodies; say so in the design doc |
| D8 | **Terrain tile hosting** | Elevation pyramids are gigabytes: object storage + CDN, outside git. Decide in M7's spike |
| D9 | **Is landing on Earth in scope?** | Not for the first terrain pass |
| D10 | **Home and progression** | ✅ **Decided 2026-11-15:** Earth is a starting region, not a required home. Basic self-sufficiency travels with the ship; progression branches and supports one-way relocation. |
| D11 | **Shared research and discovery** | ✅ **Decided 2026-11-15:** world-owned knowledge/unlocks; individual ships, equipment, supplies, tracked projects, and recovery selections. Establish ownership in M3 before networking. |
| D12 | **Replication and loss** | ✅ **Decided 2026-11-15:** craftable free-form points; last placed automatically active for the placer, existing points explicitly reactivated nearby. Destruction leaves cargo/fuel at a wreck and preserves permanent progression. M3 defaults add protected startup allowance and an explicit safe fallback. |
| D13 | **Story and optional endgame** | ✅ **Decided 2026-11-15:** delayed awakening after humanity is gone; Earth uninhabitable for humans; protected reproducible archive; optional human colony goal, continued sandbox afterward. Exact catastrophe, time elapsed, archive biology, and colony implementation remain open. |

---

## 6. Implementation language

The sim core stays **TypeScript**. No Rust/C → WASM for M0–M1.

- The work is tiny: a few entities, a few hundred floating-point operations per 120 Hz
  step. JS engines compile `f64` arithmetic to the same machine instructions WASM would.
- WASM adds a cost at every call across the boundary and a copy of state in and out, which
  for small, frequent calls is slower than staying in JS.
- A second toolchain, a second debugger, no shared types with `content.ts`, and a `.wasm`
  asset in a bundler that has already 404'd chunks in this repo.
- The same TS runs unchanged in a Node dedicated server later.

WASM pays off for heavy numeric kernels over large arrays. We get that where it matters
without writing any: Rapier (M2) *is* Rust compiled to WASM. Candidates of our own, only
if a profile shows them hot after moving to a worker: terrain tile decode/meshing (M7).

---

## 7. Current implementation handoff

1. Finish/verify M2 against its current `PHYSICS_PLAN.md` §7 contract and record actual
   as-built results. Preserve the existing M0/M1 flight, frame, save and loading seams.
2. Read [GAMEPLAY_AND_STORY.md](GAMEPLAY_AND_STORY.md) for decisions made after the
   original roadmap discussion. Root story/progression documents are historical.
3. Follow [M3_GAMEPLAY_PLAN.md](M3_GAMEPLAY_PLAN.md), starting with M3.0's current-code
   reconciliation, save migration policy, tuning tables, and measured baseline.
4. Implement M3 in its ordered, gated slices. Record deviations and playtest evidence;
   do not expand it into M5 automation or M7 terrain.

The 2026-11-15 update adds documentation only. It neither implements M3 nor certifies
the active M2 working tree. Exact source/gate APIs must be re-read when M3 starts.
