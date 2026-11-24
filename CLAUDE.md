# AGENTS.md — Stellar Nomad

## Commands (run from repo root)

**Package manager:** pnpm

- Install deps: `pnpm install`
- Dev server: `pnpm start` (NOTE: this runs `next dev -H 0.0.0.0`)
- Build: `pnpm build`
- Serve production: `pnpm serve`
- Lint: `pnpm lint`

**Quality gates (run before finishing a task)**
- `pnpm lint`
- `pnpm typecheck` (`tsc --noEmit`)
- `pnpm build`
- `pnpm check:audio` — when you touch anything under `src/audio/`, `src/data/audioEvents.ts`, or `public/audio/`

> ⚠ Read `pnpm lint`'s **`N problems (X errors, Y warnings)`** summary line, not a
> positional tail of the output. There is a standing baseline of ~130 warnings
> (mostly react-compiler advisories, deliberately non-blocking — see
> `eslint.config.mjs`); the number that must be **0** is *errors*.

**Custom ships, drones and depots:** Follow [the Blender asset workflow](docs/MODEL_WORKFLOW.md). Use `pnpm model` for reference review sheets, GLB export and QA.

**Audio scripts**
- `pnpm check:audio` — Tier-1 audio contract tests (§10.1 of the audio plan): manifest
  schema, missing/orphan assets, size budget, mono-where-spatialised, and a grep that
  no code path bypasses the bus graph. Zero npm dependencies; uses the installed `tsc`
  plus `ffprobe` when present.
- `./scripts/process-audio.sh --sfx3d raw/thing.wav` — the asset pipeline (§6.8).
  Two-pass ffmpeg `loudnorm` to −16 LUFS, trim + edge fades, Opus encode, and it
  **force-downmixes `--sfx3d` to mono** (a stereo buffer in a `PannerNode` silently
  smears the directional cue instead of erroring). Kinds: `--sfx2d --sfx3d --ambience
  --music --voice`; `--all-in <dir>` for a batch.
- `pnpm process:music` — process `AUDIO/music/*` (gitignored masters) into
  `public/audio/music/*.opus` and write the measured fields of
  `src/data/musicTracks.json` (add a track there first: id, source, title, artist,
  mood, weight). Opus sources are remuxed losslessly; loudness, edge trim and fades
  are applied at runtime. Strips all metadata. `pnpm check:music` re-verifies.
- `pnpm gen:audio-placeholders` — regenerate the synthetic Phase-0 placeholder SFX.
  Requires `ffmpeg`. These are meant to be replaced by real assets, not tuned.
- **`__audio.selftest()`** in the browser console — Tier-2 offline assertion suite
  (§10.2). 15 deterministic `OfflineAudioContext` checks in ~20 ms, no listening
  required. Run it after touching anything in `src/audio/`. It runs in the browser
  rather than Node because Node has no Web Audio and the alternative is both a new
  dependency and a different DSP engine.

> There is still no `test` script. If you add one, update this section.

**Seeing and hearing the running game (scripted verification)**
- `pnpm drive -- <steps>` — headless Chrome with real Metal WebGPU, driven over CDP
  (zero deps). Warp, settle, hold keys, capture frames/audio, measure. Use it for
  any check you'd otherwise ask the user to eyeball, and for unattended quality-goal
  loops. Needs the dev server and an UNSANDBOXED command (Chrome can't start in
  Seatbelt). Example: `pnpm drive -- --keep scene:earth_650 settle canvas:e650 stats`
- Run the dev server for testing on **:3001** (`.claude/launch.json` → `preview_start {name:"dev"}`);
  :3000 belongs to the owner. The driver probes `127.0.0.1:3001` (another app answers
  `localhost` over IPv6) and launches Chrome with `--mute-audio`, so tests are never audible.
- `--perf` for any timing. Pacing is vsync by default; `--uncapped` (faster, hotter, refused with
  `--perf`: it overflows the GPU timestamp pool), `--fps N` throttles rAF. A kept Chrome is frozen
  between runs (`--no-freeze` to keep it rendering).
- In-page API `window.__test` (scene / settled / image.stats / audio.record / state).
- The in-app browser pane renders at ~2 fps while hidden — don't run loops there.
- Full guide, settle semantics, metrics, traps: [`docs/AUTOMATED_TESTING.md`](docs/AUTOMATED_TESTING.md).

**Generating LOD1 asteroid models:**

To create simplified LOD1 `.glb` models (stripped textures, ~50% geometry, flat grey material):

```bash
# Install deps in a temp dir (not in project)
cd /tmp && npm init -y && npm install @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions meshoptimizer draco3dgltf

# Run the strip script (from repo root)
node /tmp/strip-lod.mjs public/models/asteroids/asteroid01.glb public/models/asteroids/asteroid02.glb public/models/asteroids/asteroid03.glb
```

The script (`strip-lod.mjs`) does: strip all textures, set flat grey material (baseColor 0.15/0.14/0.13, roughness 1.0, metallic 0.0), weld vertices, simplify to 50% ratio with 0.05 error tolerance, dedup, and prune. Output goes to `*_lod1.glb` alongside the originals.

Alternatively, using only the CLI (without the script):
```bash
# One-liner per model (less control over material color):
pnpm dlx @gltf-transform/cli simplify INPUT.glb OUTPUT.glb --ratio 0.5 --error 0.05
```
Note: the CLI alone can't strip textures or set material properties — use the script for full LOD1 generation.

**Converting textures to KTX2 (GPU-compressed):**

All planet/moon textures use KTX2 with Basis Universal UASTC compression. This eliminates CPU image decode on load — compressed data goes straight to GPU VRAM.

Prerequisites: `brew install ktx-software` (provides `toktx`)

```bash
# Batch-convert all textures (auto-detects sRGB vs linear from filename):
./scripts/convert-to-ktx2.sh --all

# Single file (sRGB color texture):
./scripts/convert-to-ktx2.sh public/textures/mercury/8k_mercury.webp

# Single file (linear data — normals, displacement, specular):
./scripts/convert-to-ktx2.sh --linear public/textures/earth_normal.webp
```

The script converts WebP/JPG/PNG → KTX2 (UASTC quality 2, Zstandard supercompression, with mipmaps). Output `.ktx2` is placed alongside the original. Files named `*normal*`, `*displacement*`, or `*specular*` are auto-detected as linear in batch mode.

In code, textures are loaded via `useKTX2` from drei (not `useTexture`):
```tsx
import { useKTX2 } from "@react-three/drei";
const tex = useKTX2({ color: "/textures/foo/bar.ktx2" }, '/basis/');
```

The Basis Universal transcoder WASM files live in `public/basis/` (copied from `node_modules/three/examples/jsm/libs/basis/`). If you update three.js, re-copy them:
```bash
cp node_modules/three/examples/jsm/libs/basis/basis_transcoder.{js,wasm} public/basis/
```

**Regression gates for the sim core (headless, each prints pass/fail JSON)**
- `FLIGHT_PARTS=sim,live,mouse,camera,reticle pnpm drive -- --keep run:scripts/drive-examples/flight-trace.mjs` — flight model (deterministic sim gates + live input, camera, reticle); design in `docs/FLIGHT_MODEL_PLAN.md`
- `PHYS_PARTS=sim,damage,hull,asteroids pnpm drive -- --keep run:scripts/drive-examples/physics-check.mjs` — collisions (deterministic contact gates + live asteroid hits); design in `docs/PHYSICS_PLAN.md` §7
- `FRAMES_PARTS=ride,switch pnpm drive -- --keep run:scripts/drive-examples/frames-check.mjs` — reference frames
- `pnpm drive -- --keep --no-isolate run:scripts/drive-examples/save-check.mjs` — save system
- `LIGHTS_PARTS=drift,xfade,ladder,beacon pnpm drive -- --keep --no-isolate run:scripts/drive-examples/vfx-lights.mjs` — station lamps as flux-conserving light points (VFX plan §1; `perf` part with `--perf`)
- `BEAM_PARTS=orbit,miss,hold,impact,shots pnpm drive -- --keep --no-isolate run:scripts/drive-examples/vfx-beam.mjs` — straight mining beam: mesh hit, nose axis, halt on miss, laser interlock and safety hold, impact captures (VFX plan §2–§3; `perf` part with `--perf`)
- `SHADOW_PARTS=umbra,lit,penumbra,glare,map,swim pnpm drive -- --keep --no-isolate run:scripts/drive-examples/vfx-shadows.mjs` — analytic rock shadows (VFX plan §4 S1: umbra at the floor, no self-shadow, penumbra width vs the 0.53° rule) and the ship-following shadow map (S2: hull self-shadow A/B, no swim); `bench` part with `--perf` and again with `--query shadows=0`. After editing shader code, `pnpm drive -- --stop` first: a kept page wedged twice after the hot-reload recompile
- `pnpm check:atmo` — sim atmosphere + variable-Isp drive under plain Node (`scripts/atmo-check.mjs`):
  co-rotating air vs the rendered surface (Earth/Mars/Venus/Jupiter), body pick, fuel multiplier
  table, plume regimes (VFX_REALISM_PLAN §5.6, §6)
- `pnpm check:thermal` — ship thermal network (HEAT_SYSTEM_PLAN §3) through the real resource step: bell heat-up /
  cool-down times, air vs vacuum, radiator/loop temperature, thrust-alone heat, mining trip with/without thrust
- `pnpm check:engine-audio` — the drive heard from inside (AUDIO_PLAN §6.10) under plain Node: exterior jet noise
  silent in vacuum/beam, impedance-ordered across bodies on the wind scale, shock-cell pitch + gate, pump law
- `pnpm coop:transcript [scenario,...]` — M4 co-op session core under plain Node (no browser): host/guest
  sessions over the memory transport + repository; shared-rock race both orders, dropped reply + retry,
  host restart, remote lunar mine, receipt eviction, old generation, storage failure, activity bounds.
  Loader: `scripts/lib/ts-hooks.mjs` (runs `src/` TypeScript in Node, zero deps)
- `COOP_PARTS=presence,jitter,race,raceRev,dropReply,restart,lunar,joinCard,reloadPose,lateName,remoteFx,pilotMarker,rename,writeGate,exportHidden,cancelJoin,handoff,hostFail,leave pnpm drive:coop -- --url http://127.0.0.1:3001/ run:scripts/drive-examples/coop-check.mjs` — M4.0 exit gate in two headless muted Chromes (host :9341, guest :9342; fresh `[gc] coop` world, deleted after; ~2 min); `pnpm drive:coop -- --stop` stops both
- `SHELL_PARTS=title,continue pnpm drive -- --title run:scripts/drive-examples/shell-check.mjs` — title + loading gate
- `GAME_PARTS=migrate,tx,shared,live pnpm drive -- --keep --no-isolate run:scripts/drive-examples/gameplay-check.mjs` — M3 ownership, transactions, migration, live loop (disposable `[gc] ` fixture worlds)
- `GAME_PARTS=res,m32,reach pnpm drive -- --keep --no-isolate run:scripts/drive-examples/gameplay-check.mjs` — ship resources (fuel, heat, processing, repair)
- `GAME_PARTS=transit,transitLive pnpm drive -- --keep --no-isolate run:scripts/drive-examples/gameplay-check.mjs` — fuel-aware transit (prediction vs execution, reserve, pacing, Earth → Moon at two dates); `TRANSIT_EPOCHS=defaultEpoch,…` splits the live part into runs under 2 min
- `GAME_PARTS=seeds|regions|site|guidance|difficulty|exploits pnpm drive -- --keep --no-isolate run:scripts/drive-examples/gameplay-check.mjs` — M3.7/M3.8 (gameplay-m37.mjs): starter fuel source per seed, lunar rebalance, survey site, hints/projects/overlays, difficulty, exploit sweep (one part per run keeps each under 2 min)
- `GAME_PARTS=sessionA SESSION_PART=1|2|3`, `sessionB` parts 1–5, `sessionC` parts 1–2 — the three end-to-end sessions, one world carried between parts in `.captures/m37-sessions.json` (run the parts in order); `m37shots` / `m37narrow` (`--size 390x844`) captures
- `GAME_PARTS=place,activate,death,recover,salvage,migrate4 pnpm drive -- --keep --no-isolate reload run:scripts/drive-examples/gameplay-check.mjs` — M3.6 replication points, death/recovery, wreck salvage, schema 4 (`GAME_PARTS=live36` real-input run; `m36shots` captures)

- Playtest-1 polish (`--keep --no-isolate`, `gameplay-check.mjs`): `GAME_PARTS=hud`, `panels` (run each at default size and `--size 390x844`), `hudTransit`, `hudSite`, `hudKeys,hudHotbar`, `marks,repairEdge`, `transitBelt,transitSpool`; `PHYS_PARTS=devFlag` and `liveOwner` (physics-check, `--no-isolate`); `SHELL_PARTS=lock`
- `GAME_PARTS=pace` — first-milestone pacing (fresh world → drive → lunar field; resumable, re-run until it reports done; bands: bot 25–50 min, new-player estimate 60–90)
- `GAME_PARTS=audit,fit,evidence,reqs,config,migrate3 pnpm drive -- --keep --no-isolate run:scripts/drive-examples/gameplay-check.mjs` — M3.3/M3.4 discovery research: content audit, loadout fit vs fuel/cargo, findings, requirements, effective-config preview, schema-3 migration
- `GAME_PARTS=playA` / `GAME_PARTS=playB` (same command, one per run) — fresh-save playthroughs to transit (survey first / extraction+cooling first); `GAME_PARTS=m33shots` captures, `m33narrow` with `--size 390x844`

The driver autostarts the last world; `--title` stops at the title screen. If a run hangs
at load, `pnpm drive -- --stop` (a kept Chrome can wedge after the machine sleeps).

---

## Sim core rules (roadmap M0, see [`docs/ROADMAP.md`](docs/ROADMAP.md))

- **`src/sim/**` and `src/save/**` import no React, jotai, R3F, `@/store` or
  `@/components`** (ESLint-enforced; they must run headless for a future server).
- **The ship's position is frame-relative** (`ShipState.frameId` + `posKm`, see
  `src/sim/frames.ts`). Absolute system-frame km is derived each frame and reaches the rest
  of the game through `worldOrigin`. Anything stored in the world (wrecks, later stations)
  stores `frameId` + relative position, never absolute km: bodies move.
- **Per-frame order is fixed** in `src/components/frameOrder.ts`: sim clock + ephemeris,
  then the player ship, then everything else.
- **Shared world state changes only through commands** to the authority
  (`src/sim/world/`): asteroid destruction, wrecks, sim time. Views update from its
  events. Never write world state directly; co-op depends on this seam.
- **Gameplay state persists through `savedAtom`** (`src/store/savedAtom.ts`) into the
  active world save (IndexedDB, `src/save/`), scoped `player` or `world`. Do not add
  `atomWithStorage`/`localStorage` for gameplay; those are for device preferences only.
- **Input reaches the ship only as `ShipInput`** via `src/input/` (`playerInput` buffer,
  sampled once per frame). Flight constants live in `src/sim/ship/flightTuning.ts`, camera
  constants in `src/components/Camera/cameraTuning.ts`; both are editable live in
  Settings → Dev. The camera lags the ship, so **screen centre is not the nose**: target
  with the ship's forward ray (`src/components/Camera/shipView.ts`), never the camera's.
- **Only `src/sim/physics/rapierBackend.ts` imports Rapier.** `stepShip` decides how the
  ship flies; the near field (`nearField.ts`) only resolves contacts after it, in metres
  relative to a physics origin in the ship's frame. Collision constants live in
  `src/sim/physics/physicsTuning.ts` (Settings → Dev → Physics). Run gate scripts on a
  freshly reloaded page; state left by another script has produced false failures.
- **`src/sim/simPause.ts`** is the one pause signal (loading overlay). New tickers must
  respect it.

---

## Project overview

**Stellar Nomad** is a browser-based 3D space exploration game built with **Next.js (App Router) + TypeScript** and **three.js via react-three-fiber**.

**North-star goals**
- Realistic scale/feel while staying fun.
- Inspired by games like Space Engine, No Man's Sky, and Star Citizen, and books like the Bobiverse series and Project Hail Mary.
- Deep, engaging gameplay loop with meaningful progression and player choice.
- UX is key: intuitive controls, clear feedback, and a polished presentation that draws players in.
- Photorealistic triple-A visuals.
- Solid performance by cleverly optimizing rendering, simulation, and data streaming.
- Clean, modular, maintainable code with strong TypeScript types.
- Push modern web tech, but keep debuggability and stability.

---

## Stack & libraries (assume these unless repo contradicts)
- Next.js `/app` (App Router)
- React 19 + TypeScript
- Rendering: `three` (WebGPU via `three/webgpu`), `@react-three/fiber`, `@react-three/drei`
- PostFX: TSL node system (`three/tsl`) + `RenderPipeline` (WebGPU-native bloom, tonemapping)
- Input: `@use-gesture/react`, `react-joystick-component`
- State: `jotai` (with `@swc-jotai/react-refresh` in dev)
- Styling: `sass`

Follow existing patterns and folder conventions. Don’t introduce new frameworks (ECS/physics/state) unless explicitly asked.

---

## Architecture expectations

Keep a clear separation of concerns:

- **Rendering (R3F/three):** scene graph, materials, lighting, postprocessing
- **Simulation:** time stepping, orbits/ephemerides, flight model, mining/resources
- **Game state:** player/ship state, inventory, progression (Jotai atoms)
- **UI:** HUD, menus, overlays (Next/React components in `/app`)

Rules of thumb:
- Simulation must not depend on React render cadence.
- Prefer stable refs and mutation inside `useFrame` for per-tick updates.
- Avoid huge world coordinates; use **floating origin / origin rebasing** as needed.

---

## TypeScript & React standards

**TypeScript**
- Avoid `any`. If unavoidable, isolate behind a well-named wrapper and document why.
- Keep types close to the boundary (I/O, config, data loading).
- Prefer explicit return types for exported functions and public APIs.

**React**
- Prefer small components with explicit props.
- Avoid per-frame `setState`; keep frame updates in refs.
- Keep effects deterministic; document non-obvious dependencies.

**Refactoring**
- Keep changes minimal and local unless asked for broader cleanup.
- If you touch messy code, refactor only as far as necessary to make the change safe and maintainable.

---

## R3F / three.js conventions

### Performance-first defaults
- Follow existing patterns for performance.
- Use modern optimization techniques just like top-tier game engines.
- Avoid allocations in hot paths:
  - Don’t create new `Vector3/Quaternion/Color` each frame.
  - Reuse objects; allocate once and mutate.
- Prefer fewer draw calls:
  - Use instancing for repeated meshes (`<Instances />` / `InstancedMesh`).
  - Use LOD for distant objects (`<Detailed />` or custom LOD).
- Use drei helpers where they reduce custom code:
  - `useGLTF`, `Instances`, `Detailed`, controls/helpers, etc.
- Keep React rerenders cheap:
  - Don’t store rapidly changing values in React state (position, velocity, etc.).
  - Use refs or Jotai atoms only when UI needs the value at human-rate updates.

### Postprocessing & visuals
- PostFX are expensive—treat them as a budget item.
- Prefer toggles/quality tiers for heavy effects (bloom, SSAO, SSR, DOF).
- Avoid adding multiple full-screen passes without profiling.

### Example patterns

✅ Good: stable refs, no per-frame React state
```ts
const Ship = () => {
  const ref = useRef<THREE.Group>(null!)

  useFrame((_, dt) => {
    // mutate refs; avoid allocations here
    ref.current.position.z -= dt * 12
  })

  return <group ref={ref}>{/* ... */}</group>
}
```

❌ Avoid: rerendering every frame

```ts
useFrame(() => setPos((p) => p + 1))
```

## Performance budgets & profiling

Targets (guidelines, not dogma):

Aim for 60 FPS on a typical laptop; degrade gracefully on weaker devices.

Avoid long main-thread tasks. For heavy computation (generation, pathfinding, mining sim),
prefer chunking work over frames or using Web Workers.

When changing perf-sensitive code:

Measure first — see [`docs/PERF_MEASUREMENT.md`](docs/PERF_MEASUREMENT.md). There is
a per-pass GPU/CPU profiler (Settings → Dev → "perf profiler", needs a reload) and a
scripted benchmark: `await __bench.sweep()` in the console warps through a fixed
scenario ladder and prints per-pass GPU milliseconds. Never quote eye-balled FPS as
a before/after; quote pass milliseconds at a named scenario. Chrome's Performance
panel is still the right tool for CPU main-thread work.

Optimize big wins first: allocations/GC, draw calls, shader complexity, postFX passes.

## Testing & verification

No formal test setup is assumed.

Before concluding work:

Provide brief manual verification steps (what to click/observe).

Do not try to build the project, as that would fail in sandbox mode.


## Boundaries (follow strictly)

✅ Always

Match existing conventions and directory structure (/app).

Keep public APIs typed and documented when non-obvious.

Prefer incremental improvements; avoid sweeping rewrites.

⚠️ Call out clearly in your plan (and avoid doing without explicit ask)

Adding/removing dependencies

Large refactors or file moves

New rendering pipelines or engine-level shifts

Changes to core gameplay assumptions (scale, time model, controls)

🚫 Never

Commit secrets/tokens/keys or .env contents

Edit generated files or node_modules

“Fix performance” by deleting features/quality without stating tradeoffs

Introduce new major frameworks (ECS, physics engines, state stores) without request

## Comms System (in-game messages)

Event-driven message overlay for tutorials, story beats, and reactive dialogue. Messages require manual dismissal (no auto-timeout).

### File layout

| File | Purpose |
|------|---------|
| `src/data/commsMessages.ts` | `CommsMessage` interface + `COMMS_MESSAGES` catalogue |
| `src/store/comms.ts` | Jotai atoms: priority queue, played-registry persistence, enqueue/dismiss, delay handling |
| `src/components/HUD/CommsOverlay/CommsOverlay.tsx` | UI overlay (HTML over canvas) |
| `src/components/Comms/GameCommsTriggers.tsx` | **Centralized** trigger component — ALL comms triggers live here |
| `src/components/Comms/CommsTriggers.tsx` | Reusable trigger helpers: `useCommsTrigger`, `SpatialCommsTrigger`, `CommsStatWatcher` |

### Adding a new message

1. Add an entry to `COMMS_MESSAGES` in `src/data/commsMessages.ts`:
```ts
new_message_id: {
  messageId: "new_message_id",
  speaker: "Speaker Name",
  avatar: "/assets/avatars/speaker.jpeg", // optional — shows "?" if omitted
  textContent: [
    "First page of dialogue.",
    "Second page shown after player clicks Continue.",
  ],
  priority: 2, // higher = jumps queue (1=low, 2=medium, 3=high)
  delaySec: 5, // optional — wait N seconds after trigger before entering queue
},
```

2. Trigger it using one of three methods:

**Action trigger** — call from any component when a game event fires:
```ts
import { useCommsTrigger } from "@/components/Comms/CommsTriggers";
const triggerComms = useCommsTrigger();
// later, in a callback:
triggerComms("new_message_id");
```

**Spatial trigger** — R3F component, fires when player enters a sphere (must be inside Canvas):
```tsx
import { SpatialCommsTrigger } from "@/components/Comms/CommsTriggers";
<SpatialCommsTrigger messageId="new_message_id" positionKm={[100, 0, 50]} radiusKm={5} />
```

**Stat trigger** — React component, fires when a condition becomes true:
```tsx
import { CommsStatWatcher } from "@/components/Comms/CommsTriggers";
const health = useAtomValue(shipHealthAtom);
<CommsStatWatcher messageId="low_health_001" value={health} condition={(h) => h < 20} />
```

### Key behaviours
- Messages are **manually dismissed** (Enter key or click). Never auto-timeout.
- `textContent` is an array of strings — each string is one page.
- `delaySec` is optional: if set, the message waits N seconds after the trigger fires before entering the queue. Tracked in a `pendingDelayedIds` set to prevent double-scheduling.
- Played message IDs persist in the player's save (`player.commsPlayed`, a `savedAtom`); old `comms-played-v1` localStorage is only read by the legacy importer. Messages and hints play once per save.
- **Hints** (`src/data/guidance.ts`, `showHintAtom`, `HintStrip`) are one-time, non-blocking lines for routine state; they enter the same registry when SHOWN. There is no hint queue: an offer made while another hint shows is dropped and re-offered by its trigger (`useHint`) once the slot frees, only if its condition still holds. Prefer a hint over a comms entry unless it is a story beat.
- `RETIRED_COMMS_IDS` (pre-M3.7 ground-control/assay/per-craft ids) stay valid in registries; `enqueueCommsAtom` refuses them. Do not reuse them.
- The overlay advances with Enter only and is hidden (queue kept) while dead or in Settings, so it never covers recovery or abandonment.
- `resetCommsPlayedAtom` clears the registry (for "new game" flows).
- Priority queue: higher-priority messages inserted ahead of lower ones; equal priority preserves insertion order.
- **All triggers live in `GameCommsTriggers.tsx`.** Do not enqueue messages directly from gameplay components. Instead, use signal atoms (e.g., `asteroidMinedSignalAtom`, `itemCraftedSignalAtom`) or watch existing state atoms from GameCommsTriggers.

---

## Audio

The audio subsystem's design doc is [`docs/AUDIO_PLAN.md`](docs/AUDIO_PLAN.md), and
the asset shopping list is [`docs/AUDIO_ASSETS.md`](docs/AUDIO_ASSETS.md). Read it
before touching `src/audio/` — it carries numbered invariants (A1-A13) and verified
traps (T1-T17) that the code comments cite rather than repeat.

The three rules most easily broken by accident:

- **Fire a semantic event id, never a filename**: `playAudio('world.impact')`. One-shots
  use `playAudio`; anything continuous uses `registerEmitter` (a loop needs
  start/stop/move over a lifetime, which fire-and-forget cannot express).
- **Never create an `AudioContext` or connect to `ctx.destination` outside
  `src/audio/engine.ts`.** Any path bypassing the bus graph silently breaks the volume
  sliders. `pnpm check:audio` greps for this.
- **Audio does not run on `useFrame`.** The tick is a 15 Hz `setInterval`, because
  `frameloop="never"` hard-stops the render loop whenever the settings menu opens, and
  because AudioParam writes get measurably more expensive as their pending event list
  grows (cancel-then-schedule; see the plan's M1).

Spatialised (`world`-tier) source files **must be mono** — a stereo buffer fed to a
`PannerNode` silently upmixes and smears the directional cue without erroring.

## Hard-won lessons (READ before debugging these areas)

If you're touching code in any of these areas, open the linked file first. It
captures past debugging journeys whose lessons are not visible in the code:

- **Lighting / photometry / the eye model** (`photometry.ts`, `exposureMeter.ts`,
  `scotopic.ts`, `glarePass.ts`, `planetshine.ts`, `skyIrradiance.ts`):
  See [`docs/LIGHTING_PLAN.md`](docs/LIGHTING_PLAN.md) — in particular its numbered
  defect/finding rows (D-series, P7*, P8*), which record what was measured and what
  turned out to be wrong. The recurring traps: **units** (game-unit EV vs EV100 differ
  by 12.56 stops; 1 game unit = 6037.7 cd/m²), **pre-exposure** (D25 — every radiance
  source is pre-multiplied, so anything reading a buffer must divide it out),
  **artistic gains** that lie to physically-anchored thresholds, and **published
  formulae that are wrong in magnitude, in shape, or both**. Validate with the
  `__lum` console harness (`__lum.units()` lists the gates) and never quote an
  eye-balled brightness as a before/after.

- **Cloud rendering** (`earthClouds.ts`, `cloudFullscreenPass.ts`, `noiseVolumes.ts`):
  See [`docs/CLOUD_DEBUGGING_LESSONS.md`](docs/CLOUD_DEBUGGING_LESSONS.md). Slab-
  midpoint optimisations degenerate when the camera is inside the cloud band —
  diagnose with DEBUG_VIZ before theorising, distrust "this varies slowly across
  the slab" comments, and run binary one-line falsification tests early.

Each entry here represents days-to-weeks of debugging that the linked file is
designed to make unnecessary the second time. If you do another major
debugging journey on something covered here, append to the file.

---

## Communication style

Be concise and actionable. Sacrifice grammar for clarity if needed.

State assumptions explicitly if anything is unclear.

Prefer a short plan + diff-oriented changes over long explanations.