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
- `pnpm build`

> There is currently no dedicated `typecheck` or `test` script. If you add one, update this section.

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

Measure first (Chrome Performance panel).

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
- Played message IDs persist in localStorage (`comms-played-v1`). Messages only play once per save.
- `dismissCommsAtom` merges atom + localStorage to avoid hydration race with `atomWithStorage`.
- `resetCommsPlayedAtom` clears the registry (for "new game" flows).
- Priority queue: higher-priority messages inserted ahead of lower ones; equal priority preserves insertion order.
- **All triggers live in `GameCommsTriggers.tsx`.** Do not enqueue messages directly from gameplay components. Instead, use signal atoms (e.g., `asteroidMinedSignalAtom`, `itemCraftedSignalAtom`) or watch existing state atoms from GameCommsTriggers.

---

## Communication style

Be concise and actionable. Sacrifice grammar for clarity if needed.

State assumptions explicitly if anything is unclear.

Prefer a short plan + diff-oriented changes over long explanations.