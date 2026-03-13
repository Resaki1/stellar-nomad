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

---

## Project overview

**Stellar Nomad** is a browser-based 3D space exploration game built with **Next.js (App Router) + TypeScript** and **three.js via react-three-fiber**.

**North-star goals**
- Realistic scale/feel while staying fun.
- Deep, engaging gameplay loop with meaningful progression and player choice.
- UX is key: intuitive controls, clear feedback, and a polished presentation that draws players in.
- Photoreal-ish visuals within browser performance constraints.
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

Run pnpm lint

Run pnpm build

If you fail to run these because of environment issues, let the user know and just let them test it manually in dev mode.

Provide brief manual verification steps (what to click/observe).

For logic-heavy modules (economy/orbits/progression), prefer adding unit tests if/when a test runner is introduced.


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

## Communication style

Be concise and actionable. Sacrifice grammar for clarity if needed.

State assumptions explicitly if anything is unclear.

Prefer a short plan + diff-oriented changes over long explanations.