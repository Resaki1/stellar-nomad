I am building a browser-based space game called stellar-nomad with next.js and react-three-fiber. It lets players fly a spaceship through the solar system. The goal is to make it realistic yet fun, and make it look photorealistic yet performant enough for the browser. I want to use modern web technologies to push the boundaries a bit. I am currently in the process of improving the whole asteroids situation. I have created this high-level plan for the improvement:

1) Define the solar-system data as “procedural descriptors,” not explicit asteroid lists

If you put every asteroid position in JSON, you’ll hit a wall quickly (file sizes, loading time, memory, network). Instead:

JSON defines asteroid fields as volumes + distributions + seeds.

The game generates actual asteroids deterministically from those parameters.

This gives you:

Multiple fields (easy)

Infinite/streamed worlds (future)

Multiplayer sync potential (later): share seed + changes, not millions of objects

Example JSON shape (conceptual)
{
  "version": 1,
  "systemId": "sol",
  "asteroidFields": [
    {
      "id": "leo_ring_1",
      "seed": 12344,
      "centerKm": [12000, 500, -8000],
      "shape": { "type": "box", "halfExtentsKm": [40, 10, 20] },
      "density": { "type": "perKm3", "value": 0.02 },
      "size": { "minRadiusM": 2, "maxRadiusM": 50, "distribution": "logNormal" },
      "models": [
        { "modelId": "asteroid_01", "weight": 0.7 },
        { "modelId": "asteroid_02", "weight": 0.3 }
      ]
    }
  ]
}


Key design choices:

Use km in the canonical simulation layer (consistent with your SimGroup + units utilities).

Put asteroid sizes in meters (or km) explicitly. Avoid “magic scale factors” like the current scale=25 and “TODO align asset scale.”

2) Generate and stream asteroids in “chunks” (spatial cells)

Treat each asteroid field as a set of 3D grid chunks (or a sparse voxel grid), e.g.:

Chunk size: 1–10 km (tunable)

Each chunk has:

a deterministic RNG seed derived from: fieldSeed + chunkCoord

a generated list of asteroid transforms (pos/rot/scale)

a CPU-side lightweight index for gameplay queries

Why chunks matter

Frustum culling becomes viable again

One instanced mesh for a whole huge field has a huge bounding volume, so it often won’t cull well (and you’re currently forcing frustumCulled={false}).

Chunk-level meshes have tight bounds, so standard culling works.

Level of detail becomes manageable

You can load/render fewer chunks at distance.

You can swap LOD per chunk.

Gameplay queries become fast

Mining/collision only needs nearby chunks, not the whole field.

3) Separate “render representation” from “gameplay representation”

Design around two layers:

A) Gameplay layer (authoritative, CPU)

Stores asteroid properties in compact forms:

positions (Float32Array)

radii / scale (Float32Array)

model index (Uint16Array)

a stable asteroidId (Uint32/BigInt or string hash)

Maintains a spatial index:

simplest: uniform hash grid keyed by chunk coords

later: BVH/k-d tree if needed, but grid is usually enough for asteroid belts

B) Render layer (GPU, view)

Uses instancing for bulk rendering.

Only reflects the subset of asteroids that are currently in loaded/visible chunks.

Can be rebuilt chunk-by-chunk when streaming.

This separation is what lets you later:

“mine” by updating gameplay state and then updating just the affected instance(s)

“destroy on impact” by removing/promoting an instance without redesigning everything

4) Replace per-asteroid React components with buffer-driven instancing

Your current pattern:

Generate positions

positions.map(...) to render one <Asteroid01/> per asteroid

That’s okay for a couple hundred, but it becomes a scalability trap because:

React component overhead grows with instance count

Updating/removing individual asteroids becomes awkward

You’ll fight performance once you add more fields or increase density

Preferred direction:

Render one instanced mesh per (model × LOD) (or per model if no LOD yet).

Drive transforms via setMatrixAt / typed buffers.

React renders the container, not each asteroid.

You can still keep your nice GLTF loading pipeline (drei), but you’ll want the end state to be imperative instance updates, not React child instances.

5) Future-proof for “multiple asteroid models” by grouping instances by model

Don’t try to mix multiple geometries into a single instanced mesh (not directly supported). Instead:

Maintain an asset registry:

modelId -> { geometry, material, lodGeometries?, collisionRadiusScale? }

For each loaded chunk:

generate asteroids

bucket them by modelId

append to the relevant instanced mesh buffer for that model

This scales naturally:

Add model → add another instanced mesh (still cheap)

Weighted selection per field via JSON

6) Interactivity strategy: “promote” asteroids near the player from instanced → entity

This is the core trick to keep both performance and future gameplay.

Default state (most asteroids)

Static instanced render only

No physics bodies

Collision approximated only via simple checks when needed

Near-player / interacted state (“active set”)

When an asteroid is:

within an interaction radius (mining range)

targeted by raycast/laser

collided with

…you “promote” it into a real gameplay entity:

remove/hide the instance in the instanced mesh (or mark as inactive)

spawn a standalone mesh (or a small group) with:

proper collision shape

health/resources

break logic

optional physics (if you add a physics engine later)

This avoids the “thousands of rigid bodies” problem while keeping gameplay believable where it matters.

7) Mining: fast access via chunk-local arrays + stable IDs + delta persistence

Mining needs:

identify which asteroid is hit

read its size/resources

update it (deplete, crack, destroy)

persist changes

With the chunk system:

Each asteroid has a stable asteroidId derived from (fieldId, chunkCoord, localIndex).

Base asteroid properties can be regenerated anytime from the procedural seed.

Persistent state is stored as deltas only, e.g.:

minedAmountById[asteroidId] = 0.35

destroyedIds.add(asteroidId)

That keeps saves/network sync small and supports infinite/procedural worlds later.

8) Collision and “break on impact”: broadphase grid + cheap narrowphase (sphere)

You do not need full triangle-mesh collisions for asteroids for a fun, believable result.

Recommended collision approach:

Broadphase: find nearby asteroids using the chunk grid

Narrowphase: sphere–sphere (ship collider vs asteroid radius)

On collision:

mark asteroid destroyed (delta state)

remove instance

spawn debris VFX + optional fragment meshes (short-lived)

apply impulse/knockback to ship for feedback

For “break” visuals:

Start with pre-authored fracture variants or a small set of debris chunks instanced as particles.

Later you can add more sophisticated fracturing, but the architecture won’t need to change.

9) Rendering quality + performance improvements specific to your setup

Given your current renderer:

Keep asteroids in local space using SimGroup space="local" (good).

Use chunk-level bounding volumes so you can re-enable frustum culling.

Add distance culling and a staged representation:

Near: real meshes (instanced + higher LOD)

Mid: lower LOD instanced

Far: impostors / billboard rocks / even just “belt dust” particles

Asset pipeline (big wins in browsers):

Ensure asteroid GLBs are:

single mesh / single material when possible (instancing-friendly)

compressed geometry (Meshopt or Draco)

compressed textures (KTX2/Basis)

Reuse materials across asteroids to keep shader permutations down.

10) Execution roadmap (incremental, low risk)
Phase 1 — Data-driven fields + chunking (minimal disruption)

Introduce the JSON “system config” with asteroidFields.

Implement deterministic chunk generation around the ship.

Render chunks as instanced groups (even if still using your current Drei approach at first).

Goal: multiple fields, culling, and streaming.

Phase 2 — Move to buffer-driven instancing + gameplay index

Replace per-asteroid React instances with instanced buffer updates.

Maintain per-chunk typed arrays + spatial hash.

Implement mining target queries + collision checks against nearby chunks.

Phase 3 — Multi-model + LOD + promotion to active entities

Add asset registry and weighted model selection per field.

Add 2-tier LOD (near/mid) and far impostors.

Add “promotion” system for breakable/minable asteroids.

Phase 4 — Worker offload (when needed)

Put chunk generation + spatial queries in a Web Worker.

Transfer typed arrays to main thread.

This keeps the main thread free for rendering/input.