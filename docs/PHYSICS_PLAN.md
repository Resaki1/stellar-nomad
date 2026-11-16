# Physics Engine Plan — Stellar Nomad

**Status:** proposal 2026-09-05; M2 scope fixed 2026-11-16 in §7 (read that first)
**Decision:** adopt **Rapier** (`@dimforge/rapier3d-simd-compat`) as a *near-field*
rigid-body layer behind our own `src/sim/physics` facade. Keep the existing swept
analytic tests for the far-field / transit regime. Re-evaluate Jolt at the point we
need vehicles, character controllers or planetary terrain; re-evaluate Box3D in 2027.

**Ordering answer (physics vs terrain vs multiplayer):** physics first, but a
*scoped* physics. Terrain needs a collision backend to be worth anything, and
multiplayer needs the simulation contract (what is authoritative, what is
deterministic, what is a fixed step) to already exist. Doing physics first is the
right call — doing *all* of physics first is not; see Phase gating below.

---

## 1. Review of the current collision implementation

### 1.1 What exists today

There is no physics engine. There are three independent, hand-written analytic
systems, none of which produce a contact response:

| System | File | Test | Rate | Response |
|---|---|---|---|---|
| Celestial bodies + promoted stars | [`src/sim/celestialCollision.ts`](src/sim/celestialCollision.ts) | swept segment-vs-sphere (CCD) | 120 Hz (fixed substep) | clamp to entry point, **instant death** |
| Asteroids | [`AsteroidField.tsx:510`](src/components/Asteroids/AsteroidField.tsx:510) | discrete point-in-sphere | **10 Hz** | delete asteroid, HP damage, speed dip |
| Mining target selection | [`MiningSystem.tsx:253`](src/components/Mining/MiningSystem.tsx:253) | ray-vs-sphere | 20 Hz | selection only |

Simulation shape: `Spaceship.tsx` runs a fixed-`dt` accumulator (`FIXED_DT = 1/120`)
with render interpolation, mutating `posKm`/`simQuat` refs. Positions are `f64`
kilometres; render space is rebased every frame via `worldOrigin`
([`src/sim/worldOrigin.tsx`](src/sim/worldOrigin.tsx)), 1 local unit = 1 m. That is
already the correct substrate for a physics engine — the fixed step, the
prev/curr interpolation and the floating origin are all in place.

### 1.2 Celestial collision — assessment

The swept sphere test is genuinely good work: allocation-free, module-level result
struct, correct quadratic, `startInside` short-circuit, and two hard-won traps
already documented in-file (empty pool slots with `r = 0`; scalars re-read from the
live ephemeris arrays each frame after the "crashed into empty space" bug).

Defects / limits:

- **C1 — response is binary.** Any contact is death. There is no bounce, no slide,
  no glancing hit, no atmospheric entry. This is the single biggest *gameplay*
  gap, and it is not a bug in the test — it is a missing solver.
- **C2 — bodies are spheres at their true radius.** No terrain, no oblateness, no
  atmosphere shell as a separate trigger volume.
- **C3 — `startInside` returns the first array-order body, not the deepest.** With
  overlapping colliders (a moon inside a planet's inflated radius, a star slot at a
  stale position) the reported body can be the wrong one.
- **C4 — the body's own velocity is ignored.** The sweep is ship-vs-static. Planets
  move ≤ 30 km/s against a ship that can move 10,000+ km/s, so this is currently
  unmeasurable, but it is wrong in the parked-ship regime.
- **C5 — the star tail is a fixed 4 slots** (`STAR_COLLIDER_SLOTS`). A fifth
  promoted star is silently non-solid.
- **C6 — the collider refresh runs inside the substep loop.** 14 bodies × 3 writes ×
  120 Hz — cheap, but it is per-substep work that only changes per-frame.
- **C7 — hull radius disagreement.** Celestial uses `SHIP_HULL_RADIUS_KM = 0.05`
  (50 m); asteroids use `SHIP_COLLIDER_RADIUS_M = 60`. Two numbers for one ship.

### 1.3 Asteroid collision — assessment

This is the weak system. Findings, worst first:

- **A1 — discrete test at 10 Hz ⇒ tunnelling is the default, not the edge case.**
  `COLLISION_INTERVAL_S = 0.1`. At the base `SHIP_MAX_SPEED_KMPS = 0.4` the ship
  advances **40 m per tick** while asteroid radii are tens of metres — small rocks
  are already passable today. With `cfg.speedMult`, the dev speed override, or the
  transit drive (10,000+ km/s), asteroid collision is *entirely* non-functional:
  the ship crosses hundreds of 5 km chunks between two consecutive tests.
- **A2 — the neighbourhood is 3×3×3 chunks around the ship's current position**
  (15 km box at `chunkSizeKm = 5`). Correct at 400 m/s, meaningless above it. There
  is no sweep over the chunks crossed since the last test.
- **A3 — brute force inside each chunk.** Every instance of every model in 27 chunks
  is distance-tested. There is no per-chunk BVH/grid; the 10 Hz throttle is what
  hides the cost, which is also what causes A1. Correctness and cost are coupled by
  a single constant.
- **A4 — collision spheres vs irregular models.** `radiiM` is a bounding sphere
  around a visually lumpy rock: hits register in visibly empty space, and real
  brushes against a spur pass through.
- **A5 — no contact response.** The asteroid is *deleted*
  (`removeAsteroidInstance`), the ship takes HP damage and a scalar speed dip
  (`COLLISION_SPEED_DIP_*`). Nothing is deflected, nothing spins, momentum is not
  conserved, and mass never enters the calculation. A 500 m rock evaporating on
  contact with a 60 m ship is the least believable thing in the game.
- **A6 — `logsThisTick` silently caps collisions at 3 per tick.** The name says
  logging; the `break`s make it a physics cap.
- **A7 — mutation during iteration.** `destroyInstance` swap-deletes into
  **freshly `.slice()`d copies** and publishes a new chunk object, while the loop
  keeps scanning the stale `positions`/`radii`/`ids`/`count` it captured. Currently
  benign (the `lastLog` cooldown and the `instanceIndex` lookup absorb it), but it
  is a live foot-gun, and each removal allocates four full typed-array copies of
  the whole chunk.
- **A8 — asteroids are static.** No spin, no drift, no orbital motion. Any physics
  adoption should decide deliberately whether they stay kinematic.

### 1.4 What we should keep no matter which engine wins

**No general-purpose engine can handle the transit regime.** Rapier's and Jolt's CCD
are motion-clamping schemes designed for metres-per-step, not for 100,000 km per
step across a solar system in `f64` kilometres. The swept analytic celestial test is
not legacy code to be replaced — it is the correct tool for that regime and must
survive. The engine's job is the **near field**: the ~±20 km around the ship where
the floating origin keeps `f32` honest and speeds are sane.

---

## 2. Engine comparison

### 2.1 Box3D (the one you named)

Worth noting up front, because it changed recently: **Box3D is real and is new.**
Erin Catto (author of Box2D) announced it in June 2026 and it debuted in July 2026.
It is C17, MIT, a "fork of Box2D extended for 3D", built for *The Legend of
California*, and it is a genuinely strong fit on paper for what you asked about:

- **Large-world support using doubles for positions** — the only one of the three
  that treats big worlds as a first-class design goal rather than a workaround.
- **Cross-platform determinism** and **recording/replay**, and it is already used in
  a server-authoritative context, reportedly including a 1000-player space game.
- Triangle mesh + height-field collision, convex hulls, capsules, compound shapes,
  CCD, sensors, ray/shape casts, six joint types, multithreading, SIMD, soft-step
  solver with graph colouring for large islands.
- WebAssembly is supported via Emscripten (`BOX3D_DISABLE_SIMD` exists as an escape
  hatch, SSE2 SIMD otherwise).

The problem is maturity, not design:

- The engine is **explicitly alpha, pre-1.0**, documentation incomplete, character
  movement and joint solver called out as needing work, and **pull requests are
  disabled**.
- There is **no official JS/TS binding**. The only web path is the third-party
  `box3d-wasm` (monteslu) — ~23 stars, ~11 commits, no published bundle-size
  figures, and its binding surface does not yet clearly cover trimeshes, CCD, the
  double-precision build, or determinism flags. We would be depending on one
  person's hobby wrapper for the *safety-critical* part of the game loop.
- The author states he isn't aiming to compete with other engines on benchmarks.

**Verdict: not yet.** It is the most architecturally aligned engine of the three for
a space game, and it deserves a calendar reminder — but adopting an alpha engine
through a 23-star wrapper is the kind of dependency that costs weeks when it breaks,
and the LIGHTING/CLOUD debugging journals in this repo are evidence of how expensive
opaque third-party behaviour is here.

### 2.2 Rapier

- Rust → WASM, official first-party TypeScript bindings, best-in-class docs.
- Package matrix: `rapier3d` / `-simd` / `-deterministic`, each with a `-compat`
  variant that base64-embeds the `.wasm` (bigger, but works with any bundler —
  relevant to our Next.js/Turbopack setup, where a 404'd chunk has bitten us before).
- The 2026 SIMD packages are **2–5× faster than the 2024 releases**; widely reported
  as the fastest browser physics engine as of mid-2026.
- Nonlinear CCD (translational *and* angular) with motion clamping.
- `@react-three/rapier` exists, and we should **not** use it — it is a declarative
  component layer that owns the transform pipeline, which fights our floating origin
  and our manual fixed-step loop. Use the raw API from our own sim layer.
- Weaknesses: **`f32` only in the JS bindings** (`rapier3d-f64` is Rust-only, no npm
  package) — mandatory floating origin, which we already have. No vehicle or soft
  body support. Determinism is a *separate, slower build*, and there are open
  reports of `BroadPhaseBvh` non-determinism biting rollback netcode.

### 2.3 Jolt

- C++ → WASM via the author's own `JoltPhysics.js` (`jolt-physics` on npm). Seven
  build variants: `wasm`, `wasm-compat`, `wasm-multithread`, debug flavours, asm.js.
- The broadest feature set of the three: soft bodies, cloth, wheeled vehicles,
  character controllers, ragdolls, heightfields, path constraints, physics
  materials. This is the AAA-shipped engine (Horizon Forbidden West).
- Build flags that matter to us: `DOUBLE_PRECISION=ON` ("worlds larger than a couple
  of km"), `CROSS_PLATFORM_DETERMINISTIC=ON` (WASM matching native results),
  `ENABLE_SIMD`.
- Early benchmarks report **~2× Rapier on large scenes**.
- Weaknesses: the JS API is Emscripten-shaped — manual `Jolt.destroy()` lifetime
  management, hand-written or community `.d.ts`, far more ceremony than Rapier per
  call site, and easy to leak. Using the double-precision or deterministic builds
  means **compiling our own WASM** and vendoring it, which is a real ongoing cost.

### 2.4 Scored against your three criteria

| | Rapier | Jolt | Box3D |
|---|---|---|---|
| **Performance (browser, M2 Pro)** | ★★★★★ SIMD builds, fastest general-purpose | ★★★★★ ~2× on large scenes, but MT needs COOP/COEP headers | ★★★☆☆ unmeasured on web |
| **Big static counts (asteroid chunks)** | ★★★★☆ | ★★★★★ (broadphase built for it) | ★★★★☆ (graph colouring, unproven on web) |
| **Multiplayer (p2p now, servers later)** | ★★★☆☆ deterministic build exists, slower; rollback reports of desync | ★★★★☆ cross-platform determinism, needs custom build | ★★★★★ determinism + replay + shipping server-authoritative |
| **Realism / feature depth** | ★★★☆☆ rigid bodies + joints only | ★★★★★ vehicles, characters, soft bodies | ★★★★☆ solid core, alpha polish |
| **Large worlds / precision** | ★★☆☆☆ f32 only in JS | ★★★★☆ f64 build available | ★★★★★ f64 positions by design |
| **TypeScript / DX / our conventions** | ★★★★★ | ★★★☆☆ | ★★☆☆☆ |
| **Maturity & risk** | ★★★★★ | ★★★★☆ | ★★☆☆☆ alpha + 23-star wrapper |

### 2.5 Decision

**Rapier, via `@dimforge/rapier3d-simd-compat`, behind our own facade.**

The reasoning, ranked:

1. **What we actually need first is small.** Near-field ship-vs-asteroid contact,
   an impulse response, debris. That is broadphase + convex shapes + CCD + queries —
   the exact intersection where all three engines are equivalent and Rapier is the
   least friction.
2. **Precision is a non-issue for us and only for us.** Rapier's `f32` limit is the
   argument that normally kills it for space games; we already rebase every frame to
   1 local unit = 1 m, and the physics world will never span more than ~40 km. The
   one thing Box3D and Jolt beat Rapier on is the thing our architecture already
   solved.
3. **TypeScript.** `CLAUDE.md` mandates strong types and no `any`. Rapier ships
   first-party `.d.ts`; Jolt does not, and Box3D-on-web has no official binding at all.
4. **The facade makes this reversible.** Every engine call goes through
   `src/sim/physics/*`; swapping to Jolt (for vehicles/terrain) or Box3D (in 2027,
   post-1.0, if determinism becomes the binding constraint) is a backend rewrite,
   not a game rewrite. Build the facade first, and the engine choice stops being a
   one-way door.

**Explicit tradeoffs accepted:** no vehicles/soft bodies (don't need them yet); no
lockstep-grade determinism on the default build (our multiplayer plan is
state-synced, not lockstep — see §4); a base64-embedded WASM payload (~a few hundred
KB gzipped) for bundler safety, which we lazy-load and therefore keep off the
critical path.

---

## 3. Implementation plan

### Non-negotiable invariants

1. **The engine never sees kilometres.** Physics runs in *local metres relative to
   `worldOrigin`*. Every km↔m conversion happens at the facade boundary.
2. **The engine never sees the transit regime.** Above a speed gate the near-field
   world is suspended and the analytic swept test is the only collision system.
3. **Simulation does not depend on React render cadence.** The physics step is
   driven from the existing `FIXED_DT` accumulator, not from `useFrame(delta)`.
4. **No allocation in the step.** Vector/quaternion scratch is module-level, as
   everywhere else in this repo.
5. **Ephemeris stays analytic.** Planetary orbits are Kepler + JPL tables
   ([`src/sim/ephemeris.ts`](src/sim/ephemeris.ts)); the physics engine must never
   integrate them.

### Phase P0 — Facade + harness (no gameplay change)

- `src/sim/physics/types.ts` — engine-agnostic `PhysicsBodyHandle`,
  `PhysicsShapeDesc`, `ContactEvent`, `PhysicsWorldConfig`.
- `src/sim/physics/PhysicsWorld.ts` — the interface: `step(dt)`, `addStatic`,
  `addDynamic`, `removeBody`, `setBodyPose`, `castRay`, `castShape`, `drainContacts`,
  `rebaseOrigin(deltaM)`.
- `src/sim/physics/rapierBackend.ts` — the only file that imports `@dimforge/rapier3d-*`.
- Lazy `await import()` + `RAPIER.init()` behind a `physicsReadyAtom`; the game must
  run (with today's analytic collisions) while the WASM is still loading.
- Dev toggle `physicsEnabledAtom` in [`src/store/dev.ts`](src/store/dev.ts), off by
  default, plus a `__phys` console harness mirroring `__lum` / `__bench`:
  body count, step ms, contact count, active island count.
- **Register the pass in the existing per-pass profiler** so `pnpm`-free
  `await __bench.sweep()` reports `physics.step` in ms. Per `docs/PERF_MEASUREMENT.md`
  and the repo rule: never quote eye-balled FPS as a before/after.
- **Exit gate:** empty world steps at < 0.1 ms; zero effect on any rendered frame.

### Phase P1 — Origin rebasing + the speed gate

- `rebaseOrigin`: when `worldOrigin` shifts, translate every physics body by the
  delta rather than letting coordinates grow. Rebase on a threshold (e.g. 5 km), not
  every frame.
- **Speed gate.** Define `PHYSICS_MAX_SPEED_KMPS`. Above it (transit spool, dev
  override, any `speedMult` that exceeds it) the physics world is put to sleep and
  the analytic path owns collision. Crossing the gate downward re-seeds the world
  from the current chunk neighbourhood.
- Derive the gate from the smallest asteroid radius we want to guarantee against:
  `gate = minAsteroidRadiusM / (physicsSubstepDt)`. Write the derivation into the
  constant's comment — this is the number A1 got wrong.
- **Exit gate:** entering and leaving transit at a planet produces no jump, no
  double-collision, and no orphaned bodies (`__phys` body count returns to baseline).

### Phase P2 — Asteroids as streamed static colliders (fixes A1–A4, A6)

- Hook chunk load/unload in [`src/sim/asteroids/runtime.ts`](src/sim/asteroids/runtime.ts)
  to create/destroy Rapier **fixed** colliders. One collider per instance, no rigid
  body — Rapier's broadphase is the per-chunk BVH that A3 is missing.
- Only chunks within a `PHYSICS_CHUNK_RADIUS_KM` (< the streaming radius) get
  colliders; the rest stay render-only. Budget: cap total physics colliders and log
  what was dropped rather than silently truncating.
- **Shapes.** Start with `Ball` (matching today's `radiiM`) so the change is purely
  the solver. Then generate one **convex hull per asteroid model** (not per instance)
  offline, alongside the existing LOD1 pipeline in `CLAUDE.md`, and share it across
  all instances of that model — this is what fixes A4, at near-zero memory cost.
- The ship becomes a **dynamic** body with CCD enabled and a convex hull (or a
  capsule to start). Resolves C7 by making one hull the single source of truth.
- Contact events replace the hand-rolled 10 Hz scan. Delete the `logsThisTick`
  collision cap (A6) and the stale-array iteration (A7).
- **Exit gate:** fly a straight line at max normal speed through a dense chunk with
  `__phys` recording contacts; **zero** missed contacts vs. a ground-truth offline
  sweep at 1 kHz. Quote physics step ms at a named `__bench` scenario before/after.

### Phase P3 — Contact response (fixes A5, C1)

- Give asteroids a mass from `(4/3)πr³ × density` and resolve real impulses:
  small rocks deflect and tumble away, large ones stop the ship dead.
- Destruction becomes an **energy threshold**, not an automatic consequence of
  contact. Below it: a scrape, a spark, hull damage, a deflection. This is the
  gameplay win and the reason to do physics at all.
- Route the existing `collisionImpactAtom` / `spawnVFXEventAtom` / `cameraShake`
  through the contact impulse magnitude instead of a size-lerped constant.
- Celestial bodies: keep instant-death for a real impact, but add a **grazing**
  outcome from the impact angle so a shallow approach becomes a survivable scrape.
- **Exit gate:** momentum conservation checked in `__phys` for a head-on and a
  glancing hit; damage curve reviewed against `GAME_DESIGN.md` before tuning is frozen.

### Phase P4 — Debris, wreckage, and everything the solver unlocks

- Mined fragments and destroyed-asteroid debris as short-lived dynamic bodies with a
  strict count budget and a lifetime, feeding the existing `DebrisEffect`.
- Ship-vs-ship and ship-vs-station collisions (prerequisite for docking and for
  multiplayer).

### Deferred, deliberately

- Planetary/moon terrain collision (heightfields). Rapier supports it, but this is
  the point where Jolt's `DOUBLE_PRECISION` build and character controller become
  genuinely attractive — decide *then*, with the facade already absorbing the swap.
- Soft bodies, cloth, vehicles: not in scope for Rapier; a Jolt trigger if ever needed.
- N-body gravity. The ephemeris is analytic and validated to 1 minute on two
  published eclipses. Do not touch it.

---

## 4. Multiplayer implications (read before Phase P0)

The engine choice constrains netcode, so record the intent now even though
implementation is far off:

- **The plan is state-synchronised, not lockstep.** In a space sim, ships are mostly
  independent bodies with rare interactions; each peer simulates its own ship
  authoritatively and broadcasts pose + velocity, with interest management by
  distance. This does **not** require cross-platform determinism, which is why
  Rapier's default (non-deterministic, fastest) build is acceptable.
- **If we ever want rollback/lockstep**, the escape hatches in priority order are:
  (1) `@dimforge/rapier3d-deterministic` — one-line swap in `rapierBackend.ts`, but
  note the reported `BroadPhaseBvh` desync in rollback contexts; (2) a custom Jolt
  build with `CROSS_PLATFORM_DETERMINISTIC=ON`; (3) Box3D, post-1.0, which is the
  only one of the three that ships determinism *and* replay *and* f64 positions and
  is already proven server-authoritative in a large space game.
- **Therefore the facade must not leak engine types into game code.** That is the
  entire insurance policy, and it costs one file.
- The fixed-step + interpolation loop already in `Spaceship.tsx` is exactly the
  structure netcode wants. Do not let physics adoption erode it.

---

## 5. Risks

| Risk | Mitigation |
|---|---|
| WASM load stalls first paint | Lazy `import()`, game playable without physics, `physicsReadyAtom` gate |
| Turbopack/Next chunk 404 on the `.wasm` (has bitten this repo before) | Use the `-compat` build (base64-embedded), no separate `.wasm` fetch |
| Physics step blows the frame budget in dense fields | Collider radius budget + hard cap + `__phys` step-ms in the profiler from P0, not P4 |
| Body churn during chunk streaming causes GC spikes | Pre-allocated handle pool, mirroring the existing `starDiscPool` fixed-pool pattern |
| `f32` precision artefacts far from origin | Rebase threshold ≤ 5 km; assert in dev if any body exceeds 20 km from origin |
| Two collision systems disagree at the speed gate | One owner at a time, enforced by an assertion; gate transitions covered by the P1 exit gate |
| Rapier's CCD hitches at large `dt` (known issue) | Physics substeps at `FIXED_DT`, never at frame `delta` |

---

## 6. Verification (manual)

1. Settings → Dev → enable "physics" (P0). Console: `__phys.stats()` shows a live
   world, `__bench.sweep()` reports a `physics.step` row.
2. Fly at max normal speed through the densest asteroid chunk. Every visual contact
   registers; nothing passes through a rock (P2).
3. Clip a small asteroid at a shallow angle: it tumbles away, the ship deflects and
   survives (P3). Hit a large one head-on: the ship stops and takes heavy damage.
4. Engage the transit drive toward a planet. Asteroid physics sleeps at the gate,
   the analytic swept test still kills on planetary impact, and dropping out of
   transit re-seeds the near field with no jump.
5. `pnpm lint` clean. (Do not run `pnpm build` from an agent sandbox.)

---

## 7. M2 as decided (2026-11-16) — supersedes §3 where they differ

§1–§2 stand. §3 was written before the flight model (M1), reference frames (M0.2) and the
world authority (M0.3) existed. This section is what gets built.

### 7.1 Architecture

- **Facade** `src/sim/physics/` (pure TS, no React/jotai): `types.ts`, `PhysicsWorld.ts`
  (interface), `rapierBackend.ts` (the only file importing `@dimforge/rapier3d-simd-compat`,
  v0.21.0, lazy `import()` + `init()`), `nearField.ts` (the game-facing module below).
  Read the package's own `.d.ts` for the API; do not trust remembered signatures.
- **One flight integrator.** `stepShip` stays pure and unchanged: it produces the new
  velocities and a tentative pose every fixed step. A separate **resolve** step runs after
  it: if the near field holds no collider, the tentative pose is accepted as today (exact,
  f64). If it does, the ship body is placed at the *previous* pose with the *new* linear and
  angular velocity, the world is stepped by the same `dt`, and pose and velocities are read
  back into `ShipState`. Rapier resolves contacts; it never decides how the ship flies.
- **Coordinates.** The physics world is in **metres relative to a physics origin expressed
  in the ship's current reference frame** (f64 km anchor). The engine never sees km, never
  sees absolute system coordinates. Rebase when the ship is more than 2 km from the origin:
  move the anchor and rebuild the near-field colliders (counts are small). A reference-frame
  switch rebuilds the same way.
- **Speed gate.** Above `PHYSICS_MAX_SPEED` (derive it: the largest per-step travel the
  ship's CCD body handles against the smallest collider, with margin; write the derivation
  next to the constant), during transit, and under the dev speed override, the near field is
  **suspended**: no body stepping, own integration only, celestial sweep only. Coming back
  under the gate re-seeds it. One owner at a time, asserted in dev.
- **Loading.** The engine loads with the game chunk, never on the title screen. The loading
  gate waits for it (bounded), so there is no window in which rocks are not solid.

### 7.2 Colliders

- **Asteroids are fixed colliders**, created and destroyed as chunks stream within a
  physics radius around the ship (start: 3 km; cap the count and log what was dropped).
  Shape: a **convex hull built from the model's LOD1 mesh vertices** scaled and rotated per
  instance; ball of `radiiM` only as the fallback until a model's vertices are registered.
  Convex hull, not trimesh: cheap, robust, good enough for lumpy rocks.
- **The ship is a dynamic body with CCD** and a convex hull from its own mesh. One hull,
  one size: delete `SHIP_COLLIDER_RADIUS_M = 60` (the model is ~10 m across) and the
  10 Hz point-in-sphere scan, the per-tick collision cap and the stale-array iteration.
- `asteroid.destroyed` events (mining, another player) remove the collider.
- **Celestial bodies stay on the analytic swept test and stay lethal.** Landing is M7.

### 7.3 Contact response and damage

- **Asteroids do not move and are not destroyed by ramming.** Even the smallest rock in
  the field (8 m radius, ~5,000 t at rock density) outweighs the ship several hundred
  times, so the physically honest outcome of every collision is that the ship bounces and
  the rock stays. This removes today's behaviour (rock deleted on contact). Pushable or
  shattering bodies need world state for moved objects and come with M5.
- The ship bounces with low restitution and some friction, can pick up spin from an
  off-centre hit, and the flight assist then recovers. Resting against a rock is stable.
- **Damage depends on impact speed, not rock size**: the component of the ship's velocity
  change along the contact normal. Starting curve: nothing below 8 m/s (a bump), then
  `100 % · ((Δv − 8) / 112)²`, so ~25 % at 64 m/s and lethal from 120 m/s. Scaled by the
  existing `collisionDamageMult` and max health. Constants live in one tuning table with
  the same live-edit API as the flight tuning, shown in Settings → Dev.
- Hull at zero → the existing death flow (wreck with cargo in the ship's frame).
- VFX, camera shake and `world.impact` audio scale with the same Δv.
- One contact episode (contact with one rock until a 0.5 s gap) charges `curve(peak Δv)` in
  total: a scrape or a pogo re-contact only adds damage, flash and sound when it beats the
  episode's peak.
- **Known degradation:** with the engine unavailable (load failure, 20 s timeout) or the
  near field suspended (speed gate, dev speed override) asteroids have no collision at all;
  only celestial bodies keep the analytic sweep.

### 7.4 Harness and gates

- `__phys.stats()`: ready, suspended + reason, colliders, contacts this step, step ms,
  origin, rebases. `physics.step` appears in the per-pass profiler.
- `__test.physics.simulate(script)`: a **private** physics world plus `stepShip`, no
  rendering: ship start state, scripted input, a list of rocks (ball or hull). Used for
  every numeric gate below so results do not depend on frame rate.

Gates:
1. **Free flight unchanged**: with an empty near field every M1 flight gate passes
   bit-for-bit as before; with a rock 500 m away and no contact, the trajectory matches
   the no-physics trajectory to 1 mm over 10 s.
2. **No tunnelling**: at the boosted speed limit, straight at the smallest rock, for 50
   lateral offsets: contact if and only if the swept hull crosses the rock (analytic
   ground truth); zero misses, zero false hits. Repeat just under the speed gate.
3. **Head-on at 30 m/s**: bounces back, exit speed consistent with the restitution,
   damage as the curve says.
4. **Glancing at 100 m/s, 10° incidence**: deflected, small damage, some spin, and with
   flight assist back under 2° sideslip within 3 s.
5. **Lethal**: 200 m/s head-on destroys the ship. **Bump**: 5 m/s does no damage.
6. **Resting**: full throttle against a rock for 10 s: penetration under 0.2 m, no
   jitter above 0.05 m/s, no NaN.
7. **Energy**: the ship never leaves a collision faster than it entered.
8. **Hull fidelity**: for 26 directions, the hull's support distance matches the LOD1
   mesh's within 5 %.
9. **Rebase and frames**: a 10 km straight flight past rocks gives the same contacts and
   trajectory with the rebase threshold at 2 km and at 100 km; parked beside a rock at
   sim rate 10⁴ produces no contact and no drift; a frame switch re-seeds cleanly.
10. **Speed gate**: transit suspends the near field and re-seeds it after; collider count
    returns to its baseline; never two owners.
11. **Cost**: `physics.step` in ms at a named scene with the field loaded, and with 2,000
    synthetic colliders; empty world under 0.1 ms.
12. **Live**: in the running game, fly into a real asteroid at ~20 m/s (damage, rock
    still there, ship bounces) and at ~300 m/s (death, wreck created).
13. Title screen still loads no physics code; M0 and M1 gate scripts pass.

---

## Sources

- Box3D announcement — https://box2d.org/posts/2026/06/announcing-box3d/
- Box3D repo / README — https://github.com/erincatto/box3d
- Box3D docs — https://box2d.org/documentation3d/
- box3d-wasm (third-party web binding) — https://github.com/monteslu/box3d-wasm
- JoltPhysics.js — https://github.com/jrouwe/JoltPhysics.js/
- Jolt build docs (DOUBLE_PRECISION, CROSS_PLATFORM_DETERMINISTIC) — https://jrouwe.github.io/JoltPhysicsDocs/5.2.0/md__build__r_e_a_d_m_e.html
- Rapier — https://rapier.rs/ · JS getting started — https://rapier.rs/docs/user_guides/javascript/getting_started_js/
- Rapier CCD — https://rapier.rs/docs/user_guides/rust/advanced_collision_detection/
- Rapier CCD hitch issue #217 — https://github.com/dimforge/rapier/issues/217
- Rapier rollback determinism report #910 — https://github.com/dimforge/rapier/issues/910
- Dimforge 2025 review / 2026 goals (SIMD packages, 2–5×) — https://dimforge.com/blog/2026/01/09/the-year-2025-in-dimforge/
- Web physics engine comparison — https://www.webgamedev.com/physics
