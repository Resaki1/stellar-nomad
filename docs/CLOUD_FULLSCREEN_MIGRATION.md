# Volumetric Clouds — Full-Screen Ray-March Migration (Phase G)

## Background

Phases A–C delivered a Nubis-faithful volumetric ray-marcher (Schneider noise pipeline, base+top profile, adaptive two-state march at 96 max steps, cone-traced light march), rendered onto a **sphere shell** at the outer-shell altitude (14 km). The diagnostic-mode work on 2026-04-30 confirmed the algorithm is sound — `topAlt` varies dramatically, `alpha` saturates in dense regions, `iters` shows the adaptive march engaging — but the painted result reads as a 2D layer at 14 km altitude regardless of internal variation. This is intrinsic to shell-painting: the integrated alpha is rasterised at the sphere geometry's projected screen position, destroying per-pixel cloud-front depth.

The project's seamless orbit-to-surface gameplay (planetary landings, flying through clouds) requires **true 3D parallax** — adjacent columns at different topAlt must visibly shift at different rates as the camera moves. Schneider's actual NUBIS implementation does this via a **full-screen ray-march pass**, not a sphere shell. We've been adapting Nubis's *march algorithm* faithfully but rendering it onto the wrong geometry; this phase corrects that.

## Why per-pixel rays produce 3D parallax that shell-painting cannot

In the shell version, every fragment's screen position is on the sphere geometry — i.e. at outer-shell altitude. Even though each ray's analytic intersection lands at a different cloud-front depth, that depth never makes it onto the screen: alpha is rasterised at the shell projection. Camera motion shifts every shell fragment by the same amount, regardless of cloud depth.

In the full-screen version, every fragment's screen position **is** the screen pixel. The cloud's first-hit depth is implicit in where alpha goes opaque — at pixel (x,y) the eye is "looking through" to whatever depth the ray hit the cloud. Camera motion produces correct parallax for free: a near cloud at 8 km depth shifts more pixels than a far cloud at 13 km depth.

## Goals

- Replace sphere-shell cloud rendering with a full-screen quad ray-march that preserves per-pixel cloud-front depth.
- Keep everything that works: Schneider noise pipeline, base+top profile, adaptive march, cone-traced lighting, premul-alpha pipeline, half-res cloud RT + bilinear composite, distance crossfade (`uVolumetricBlend`).
- Set up the architecture so Phase D (temporal reprojection) becomes a natural extension.

## Non-goals (this phase)

- Phase D temporal reprojection itself — separate phase on top.
- Phase E shell-shadow RT, aerial perspective.
- Profile/density retuning — current tuning should look correct once geometry is right; retune separately if not.

## Current architecture

```
scaledScene  (Earth + planets + skybox)
  └── earthMesh                     (rotates, holds Earth's transform)
        └── cloudShell              (SphereGeometry @ outerRadius, BackSide,
                                     NodeMaterial running the ray-march)
              on CLOUD_LAYER

SpaceRenderer pass 2:
  scaledCamera.layers.disable(0); .enable(CLOUD_LAYER)
  renderer.setRenderTarget(cloudRt)            // half-res
  gl.render(scaledScene, scaledCamera)         // shell paints into cloudRt
```

The fragment shader reconstructs the camera ray via `modelWorldMatrixInverse · cameraPosition` (Earth-local origin) and `positionLocal − roLocal` (direction). It runs analytic shell intersection, marches the slab, returns premul `(col, alpha)`. Critically, the fragment's screen position is determined by the SphereGeometry's projection — the cloud paints onto that 2D surface.

## Target architecture

```
cloudScene  (new — own scene, independent of scaledScene)
  └── fullScreenQuad              (PlaneGeometry(2,2), NodeMaterial,
                                   frustumCulled = false)
cloudCamera (new — OrthographicCamera(-1, 1, 1, -1, 0, 1))

SpaceRenderer pass 2:
  // Per-frame uniform updates (sourced from the SCALED camera, not cloudCamera)
  uInvViewProj.value.copy(scaledCamera.projectionMatrix)
                    .invert()
                    .premultiply(scaledCamera.matrixWorld);
  uCameraScaledPos.value.copy(scaledCamera.position);
  uEarthInverseModel.value.copy(earthMesh.matrixWorld).invert();

  renderer.setRenderTarget(cloudRt)
  gl.render(cloudScene, cloudCamera)
```

The fragment shader reconstructs the world-space ray per pixel from `screenUV + uInvViewProj`, transforms into Earth-local space via `uEarthInverseModel`, then runs the same intersection + marcher. Composite (pass 3) is unchanged.

## Migration steps

### G1 — Extract the marcher into a pure TSL function

Refactor `buildCloudFragment` so the body becomes a function `marchCloudVolume({roEarth, rdEarth, sunDirEarth, ...uniforms}) → vec4`. The shell-side `Fn(() => { ... })` becomes a thin wrapper that does the existing `modelWorldMatrixInverse` ray transform + intersection, then calls the marcher.

**No behaviour change.** Pure refactor — confirm the shell still renders identically before moving on.

### G2 — Build the full-screen pass in parallel

New file `src/components/space/cloudFullscreenPass.ts`:

1. Create `cloudScene = new Scene()` and `cloudCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)`.
2. Create a `PlaneGeometry(2, 2)` mesh with `frustumCulled = false`, parented to `cloudScene`. Material is a `NodeMaterial` whose fragment shader:
   - Reads `screenUV` (TSL built-in, [0,1]).
   - Builds NDC: `vec3(screenUV·2 − 1, 1)` (far plane).
   - Reconstructs world ray: `worldFar = uInvViewProj · vec4(ndc, 1); worldFar /= worldFar.w;`
   - Subtracts `uCameraScaledPos`, normalises → world-space `rdScaled`.
   - Applies `uEarthInverseModel` (3×3 rotation + translation) to get Earth-local `roEarth`, `rdEarth`.
   - Runs `marchCloudVolume(...)` from G1.
   - Returns the same premul `vec4(col, alpha) · uVolumetricBlend`.
3. Export `setupFullscreenCloudPass()` returning `{cloudScene, cloudCamera, updateUniforms(scaledCamera, earthMesh)}`.

In `SpaceRenderer.tsx`, add a JS-const toggle `USE_FULLSCREEN_CLOUDS`. When true, pass 2 calls `updateUniforms(...)` then `gl.render(cloudScene, cloudCamera)`. When false, the existing shell path runs. This lets us A/B compare before committing.

### G3 — Validate

With `USE_FULLSCREEN_CLOUDS = true`:

1. **Static-camera A/B**: render the same scene from the same camera with shell vs fullscreen. Should look broadly similar (small differences expected at the shell's old limb, where shell didn't render but fullscreen does).
2. **Camera-motion parallax**: pan/dolly the camera. Fullscreen render should show clouds shifting at *different* rates based on cloud-front depth — tall cumulus shifts faster than far stratus. Shell render does not. **This is the primary acceptance test.**
3. **Re-run all `DEBUG_VIZ` modes**: `topAlt`, `alpha`, `iters`, `insideInner`, `slabLen` should all behave identically — same marcher, same diagnostics.
4. **Edge cases**:
   - Camera in deep space (>35 000 km): `uVolumetricBlend` fades volumetric out cleanly.
   - Camera in the slab (alt 1–14 km): clouds wrap correctly around the camera.
   - Camera below inner shell (alt <1 km): existing `insideInner` branch still works for upward rays. Downward rays through the planet need G5.

### G4 — Remove the shell path

Once G3 passes:

1. Delete the `SphereGeometry` shell mounting in `earthClouds.ts`.
2. Remove `CLOUD_LAYER` from `renderLayers.ts` and from camera-layer manipulation in `SpaceRenderer.tsx`.
3. Consolidate what remains of `earthClouds.ts` into `cloudFullscreenPass.ts` (or split into `cloudMarcher.ts` + `cloudFullscreenPass.ts` per taste).
4. Update `docs/VOLUMETRIC_CLOUDS_PLAN.md`: mark Phase F1 (generalise to `volumetricCloudShell.ts`) as superseded — the generalisation now lives in the fullscreen pass.

### G5 — Planet-occlusion test (defensive)

In the marcher, after computing `tExit`, intersect the ray with a sphere at `PLANET_RADIUS_KM`. If the ray hits the planet surface before reaching the slab, clamp `tExit` to the planet hit (or set alpha = 0 if the planet entry is before `tEnter`). Prevents the "cloud through Earth" failure mode for downward rays from low altitude that the shell version also has but is masked by the limited shell-back-face projection.

## Files affected

| File | Change |
|---|---|
| `src/components/celestial/bodies/earthClouds.ts` | G1: refactor (extract marcher). G4: gut — only the marcher module remains. |
| `src/components/space/SpaceRenderer.tsx` | Pass 2 swaps to render cloudScene with cloudCamera; per-frame uniform updates added. |
| `src/components/space/renderLayers.ts` | `CLOUD_LAYER` removed in G4. |
| **NEW** `src/components/space/cloudFullscreenPass.ts` | cloudScene, cloudCamera, fullscreen quad, uniform-update API. |
| **NEW (optional)** `src/components/celestial/shaders/cloudMarcher.ts` | The pure marcher TSL function, if we want it separate from the fullscreen pass. |
| `docs/VOLUMETRIC_CLOUDS_PLAN.md` | Final-architecture update + F1 supersession note. |

## Risks & mitigations

- **Earth-local frame for noise/UV sampling.** The weather-map UV and the 3D noise volumes are sampled in Earth-local space (rotation-aware). We must pass `uEarthInverseModel` as a 4×4 uniform and apply it consistently to both `roEarth` and `rdEarth`. *Mitigation*: G1's pure-refactor extraction proves the marcher in isolation before changing geometry.

- **Camera matrix per frame.** Cloud uniforms must be updated each frame from the scaled camera. *Mitigation*: hook the update into the existing `useFrame` body in `SpaceRenderer.tsx`; cost is a few `Matrix4` operations, negligible.

- **TSL `screenUV` orientation.** Verify whether y is flipped relative to NDC — three.js TSL conventions matter here. *Mitigation*: write a 1-line debug return that visualises `screenUV` (or `screenUV.y`) before connecting it to ray reconstruction.

- **Cloud RT clear semantics unchanged.** Fullscreen quad covers the entire RT every frame, so the cleared-to-`(0,0,0,0)` premul-alpha trick still works without modification.

- **Shader compile cost.** Same marcher, same Loop count → same compile cost. Phase F3 pre-warm still applies.

- **Frustum culling.** A `PlaneGeometry(2,2)` rendered by ortho camera at z∈[0,1] should not be culled, but set `frustumCulled = false` defensively.

- **Floating-origin recentre.** `uCameraScaledPos` and `uEarthInverseModel` are recomputed every frame from current scene state, so re-centres are picked up automatically.

## Acceptance criteria

- All `DEBUG_VIZ` modes produce identical (or near-identical) outputs vs the shell version — same marcher.
- Static-camera renders look broadly similar (allowing for limb-region differences).
- **Camera-motion parallax is visibly correct**: tall and short cumulus columns shift across the screen at noticeably different rates during pan/dolly. This is the test for "is this actually 3D now".
- Sub-orbital flight through the slab: clouds fade in/out as the camera passes through dense regions — fundamentally new behaviour the shell could not produce.
- No regressions in existing tests: distance crossfade, terminator falloff, sun-tinted sunset light.

## After migration: unblocks

- **Phase D (temporal reprojection)** — natural fit: per-pixel ray output, history RT ping-pong, Halton jitter, variance clamp.
- **Per-planet config** (old Phase F1) — fullscreen pass parameterised by planet config.
- **Phase E3 aerial perspective** — couples per-pixel cloud-front depth into atmosphere fog, trivially possible once we're rendering at full-screen.

## Implementation order

1. G1 (extract marcher) — small, contained, verifiable that nothing changed.
2. G2 (build fullscreen pass behind toggle) — substantial new code but doesn't disrupt the shipping shell path.
3. G3 (validate, A/B test) — the moment of truth. If parallax does not appear, something fundamental is wrong with the ray reconstruction; we can fix without committing the migration.
4. G4 (remove shell, finalise) — committed. From here forward the shell is gone.
5. G5 (planet occlusion) — defensive cleanup, can ship after G4 in a follow-up.
