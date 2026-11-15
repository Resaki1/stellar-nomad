# Stellar Nomad — Roadmap

**Status:** proposal, 2026-11-13. Supersedes `CURRENT_PLAN.md` (the old asteroid-streaming
brief, long since built). Not yet reviewed by Christian.

This document orders the nine big items (multiplayer, physics, game loop, terrain, flight
model, clouds, procedural systems, asteroid fields v2, ship interiors), splits them where
parts of one depend on parts of another, and defines milestones with exit gates. Each
milestone marked *own plan doc* gets a detailed design doc when it starts; this file only
fixes order, scope and the seams between them.

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
after the solo loop is fun but **before stations and drones**, so those are built once,
networked from day one.

---

## 2. What the code looks like today (surveyed 2026-11-13)

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
(system switch blockers, parked procedural stars). **Stale:** `STORY.md`, the story and
comms parts of `GAME_DESIGN.md`, `CURRENT_PLAN.md`, `COMMS_IDEAS.md`.

---

## 3. How the nine items split

| Your item | Splits into | Lands in |
|---|---|---|
| Flight model | sim extraction (F1) · velocity-vector 6DOF + flight assist · mouse/input layer · camera rig · atmospheric drag | M0, M1, (drag: M7) |
| Physics | near-field collision + response (`PHYSICS_PLAN` P0–P3) · ship-vs-ship, debris (P4) · terrain heightfield collision | M2, M5, M7 |
| Game loop | design doc v2 · solo survival pressures + tier rebalance · stations, storage, drones · later tiers (belt, giants, interstellar) | M3, M5, then with each world milestone |
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

### M2 — Near-field physics · size L · plan exists

Execute [`PHYSICS_PLAN.md`](PHYSICS_PLAN.md) P0–P3 with three amendments:

1. The physics world lives in the **ship's current frame** (local metres), per M0.2.
2. **One flight integrator.** We keep computing accelerations ourselves; in the near field
   the ship is a Rapier dynamic body whose velocity we set before the step and read back
   after, so Rapier resolves contacts but never owns flight feel. Above the speed gate we
   integrate position ourselves.
3. P3's impulses use M1's real mass and velocity.

Adds a dependency: `@dimforge/rapier3d-simd-compat` (already chosen in that plan).
**Exit gates:** as written there (zero missed contacts against a 1 kHz reference sweep).

### M3 — Survival loop v1, solo · size L · *own plan doc (GAME_DESIGN v2)*

Design work can start in parallel with M0–M2; it is writing, not code.

- **Pressures** (D3). The rule that keeps this from becoming a fight for life: **nothing
  drains while you are idle.** Every pressure is spent by *doing* something, so it shapes
  how far an expedition goes rather than putting a timer on the player.

  | Pressure | Spent by | Restored by | When it runs out |
  |---|---|---|---|
  | **Propellant** | thrust; transit burns a lot | refined from hydrates (water as reaction mass), depots, other players | limp-home thrust only, never death. It is the range limiter that makes "can I reach the Moon and get back?" a real question |
  | **Power** | not a draining bar: a reactor gives a budget, modules draw from it, a capacitor covers bursts (boost, pulse mining) | better reactors (He-3 at tier 1+) | you cannot run everything at once; a loadout constraint |
  | **Heat** | mining laser (exists today), boost, transit spool, later the Sun and atmospheric entry | radiators, heat sinks, time | systems throttle, then hull damage |
  | **Hull** | impacts scaled by impact energy (M2), sustained overheating | repair costs Fe-Ni; no free regeneration by default | ship destroyed |

  No oxygen, food or crew needs. Radiation arrives with tier 3 as a location gate.
- **Destruction** stays real: a scrape costs hull, a head-on hit on a large asteroid at
  speed or any impact with the Moon destroys the ship. Fairness comes from the flight
  model (collision warning, flight assist), not from soft damage. On destruction: respawn
  at the last depot (or the start), cargo stays in a recoverable wreck, as today.
- **Difficulty** is a per-world setting chosen at world creation, implemented as one data
  table of multipliers on top of the existing effects system, so it costs almost nothing
  if it is there from the first pressure onward:

  | | Explorer | Standard | Hard |
  |---|---|---|---|
  | Propellant use | off | 1× | 1.5× |
  | Collision damage | hull cannot drop below 1% | 1× | 1.5× |
  | Hull repair | free, automatic | costs resources | costs resources |
  | On destruction | respawn in place | cargo left in a wreck | cargo lost, one equipped module damaged |

  Balance Standard first; the other two columns are numbers to tune later.
- **Tiers by destination**, each adding one resource, one hazard and one capability:

  | Tier | Place | New resource | New hazard | Unlocks |
  |---|---|---|---|---|
  | 0 | Earth far-orbit field | silicates, Fe-Ni, carbon, sulfur, hydrates | collisions | better engine |
  | 1 | Moon | titanium, He-3 | fuel range | depot, first drone |
  | 2 | Mars, main belt | to design | distance, dust | refining, hauler drones |
  | 3 | Jupiter, Saturn | ring ice, atmospheric gases | radiation, gravity wells | scooping, larger stations |
  | 4 | Outer system, Kuiper belt | volatiles | cold, isolation | interstellar drive |
  | 5 | Other stars | to design | to design | to design |

  Only tiers 0–1 are built in M3; the table exists so early systems do not block later ones.
- Rebalance research and recipes around the tiers; replace the old objective tracker.
- Everything here is **per-player state**, so it is multiplayer-safe by construction.
- **Exit gate:** a fresh save reaches the Moon in a play session with at least one moment
  where a pressure forced a decision.

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
- **N2 shared world**: asteroid deltas, mining locks and wrecks through host commands;
  join-in-progress sends the world save.
- **N3 player persistence** (D2) and item transfer between players.
- Scale target: a handful of ships. Friends only, so no anti-cheat.
- **Exit gate:** two browsers mine the same field for 30 minutes; world saves are identical
  afterwards; a late joiner sees the same destroyed asteroids.

### M5 — Shared structures and drones · size L

- **Depot**: first placeable entity. Storage, respawn point, shared access. Rides an
  orbit co-moving frame (pulls that frame kind forward from M6 if needed).
- **Fabrication** at the depot; decide whether ship-side crafting stays instant.
- **Drones v1**: assign a mining drone to a field and a depot. Simulated for real when a
  player is near, as a rate when nobody is. A few drones per station, not hundreds.
- Physics P4: ship-vs-ship and ship-vs-station contact, mining debris.
- **Exit gate:** two players and two drones fill one depot; state survives host restart.

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
  first because it has no atmosphere, ocean, vegetation or clouds, and it is tier 1.
- **T4** heightfield collision patches around the ship, landing gear contact, landing
  assist, surface resource nodes.
- **T5 Mars** (MOLA/HRSC), with atmospheric drag and entry heating in the flight model.
- **T6 Earth** is explicitly last and may stay orbit-only (D9).
- On-foot is a separate later decision (M10).

### M8 — Generic bodies, clouds v2, gas giants · size XL

- **F4**: `BodyDescriptor` → one parameterised renderer (rocky, icy, gas archetypes),
  clearing `systemRegistry` blockers 1–4. Existing hand-tuned bodies become descriptors.
- Clouds: remove the Earth singletons, per-body cloud config, then `CLOUD_TYPES_PLAN`
  Phase 8 (gas giants). Unlocks tier 3 atmosphere scooping.

### M9 — Procedural systems and the interstellar loop · size XL

- System generation from stellar parameters: real exoplanets where catalogued, seeded fill
  elsewhere. System activation by distance. Procedural stars per the entry conditions in
  `STAR_RENDERING_PLAN.md` §28.2.
- Interstellar travel design (D4).

### M10 — Interiors and on-foot · size XL · far future

### Track C — Cloud polish · parallel, optional

Clouds are the largest historical time sink in this repo (six docs, ~10,000 lines of
notes). Nothing before M8 depends on them. Recommendation: no cloud work until M3 ships,
then time-boxed sessions only.

---

## 5. Decisions needed from you

M0–M2 can start without any of these. D1–D3 are needed before M3/M4.

| # | Decision | Recommendation |
|---|---|---|
| D1 | **Who hosts a co-op world?** | ✅ **Decided 2026-11-13:** a player's browser hosts; dedicated servers only once there are players beyond friends. Transport: WebRTC data channels, see M4 |
| D2 | **Where does a player's progress live in co-op?** | ✅ **Decided 2026-11-13:** in the world save, keyed by player (Minecraft model) |
| D3 | **Survival pressures** | ✅ **Direction decided 2026-11-13:** propellant, power, hull, heat; satisfying collect/craft/explore over constant danger; difficulty levels. Details in M3. Still open: whether the player is a crewed pilot or a machine intelligence (affects only fiction and M10) |
| D4 | **Interstellar travel** | Today's drive silently exceeds c. Either a clearly fictional drive with honest rules, or real relativistic travel. Decide before M9, not now |
| D5 | **Speed regimes** | Keep two (manoeuvring + transit). Derive the manoeuvring speed cap from stopping distance vs sensor range instead of a fixed 400 m/s, so better engines and scanners raise it |
| D6 | **Run sim time at 1× by default after M0.2?** | Yes. The terminator moves, moons orbit, and frames are exercised constantly instead of only in tests |
| D7 | **Ring particle scale** | Real ring particles are centimetres to ~10 m. Render true scale near the camera and add rarer, larger mineable bodies; say so in the design doc |
| D8 | **Terrain tile hosting** | Elevation pyramids are gigabytes: object storage + CDN, outside git. Decide in M7's spike |
| D9 | **Is landing on Earth in scope?** | Not for the first terrain pass |

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

## 7. Starting point

M0.1, in this order, each step shippable on its own:

1. Record a reference pose trace with `pnpm drive` (straight flight, turns, a transit hop).
2. Extract `ShipState` + `stepShip` verbatim from `Spaceship.tsx`. No behaviour change.
3. Move the camera into `ChaseCamera`; move input to a `ShipInput` buffer.
4. Add the entity table; point mining and the wreck collector at it.
5. Re-run the trace and diff.
