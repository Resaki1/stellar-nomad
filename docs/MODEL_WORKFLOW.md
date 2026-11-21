# Blender assets for Stellar Nomad

Use this workflow for static hard-surface ships, drones, depots and their separate collision proxies. Both Codex and Claude Code can edit the same Blender Python authoring scripts and run the same commands. The artist can also edit the master in Blender normally. Choose one source of truth per asset and record it in the brief before regenerating anything.

## Start an asset

Create `art/<family>/<id>/brief.md`. Keep the brief small enough to resume from it and the most recent review sheet. A sufficient handoff looks like this:

| Record | What the next artist needs |
|---|---|
| Role and framing | Physical dimensions in metres, target gameplay camera, closest approach, typical and worst visible instance counts |
| References | Paths and provenance/permission for each image. Pick a primary silhouette view, thickness view, material reference and chase angle. Link existing references in place. |
| Design decisions | Count and location of major parts, centerline, symmetry exceptions, clearance around moving parts, tool rays and exhausts. Mark inferred dimensions. |
| Runtime contract | Root/pivot and axes, named sockets and directions, collider coverage, material roles, LODs, limits and intended integration point |
| Current state | Canonical master or recipe, last accepted gate, largest remaining mismatch, next action, final filenames and measured results |

**Resolve contradictions once.** A top view can own the fin outline while a side view owns hull thickness. Mirror the load-bearing parts in local X. If an oblique invents a third nozzle, preserve the chosen nozzle count and design a coherent rear. Use the oblique for depth, material response and how parts meet. Compare silhouette landmarks and function at matched angles and scale. Compare pixel values only when camera and lighting are controlled.

## Run the workshop

Use Blender 5.3.0, Node and the project's `pnpm install`. The launcher finds the user Applications folder first, then the system macOS Blender app or invokes `blender` from PATH. Set `BLENDER_BIN` to select another executable. The CLI uses the Python, Cycles CPU renderer and imaging libraries bundled with Blender. On this Mac, run the Blender stages outside Seatbelt. Plain `check` only needs Node and the installed project dependencies.

```sh
pnpm model smoke
pnpm model build art/ships/survey/source.blend
pnpm model build art/ships/survey/source.blend --collection EXPORT_LOD1 --budget art/ships/survey/lod1.json
pnpm model check path/to/final.glb --webgpu
pnpm model review path/to/final.glb --views all
pnpm model review path/to/final.glb --views chase --size 512 --light sun
```

For silhouette review use `pnpm model build art/ships/survey/source.blend --asset survey --light clay`. Workbench renders neutral clay from the same cameras. Use studio or sun for materials. Pass the same `--asset survey` when reviewing subsequent GLBs to update `.captures/models/latest/survey.json`. Its sheet path is relative to `.captures/models/`. Without an ID the pointer is keyed by input path. Only completed visual reviews replace it atomically.

Each run prints its own folder under `.captures/models/`. `build` opens the master, exports a single candidate GLB from one named collection, validates the bytes, reimports the GLB into an empty scene, checks geometry and renders it. `review` starts at validation, so it can check a postprocessed candidate too if Blender supports its extensions. The default four 256 px views form one 512 × 512 sheet. `all` adds rear, opposite side, bottom and ventral three-quarter views. Every tile has its own PNG. Framing and lights stay fixed between views of the same export. Bounds determine framing, so compare the reported dimensions as well as the sheet between revisions.

Read `metrics.json` and `sheet.png` first. `geometry.json` contains dimensions in game X/Y/Z and scene-space row-major socket transforms in metres, in a +Y-up, +Z-forward frame. `validation.json` retains the full Khronos report, including warnings, unsupported extensions and resource details. Detailed Blender output stays in per-stage logs. A failed run leaves diagnostic files, including intermediate candidates, in its own directory. Promote only an asset that passed the intended checks.

Add `--webgpu` to any command for an independent browser check. It opens local headless Chrome with a temporary profile, loads the validated GLB using this checkout’s three.js GLTFLoader, fits a camera to the imported world bounds and reads back a WebGPU frame. It requires visible pixels and records dimensions in `webgpu.json`. Set `CHROME_BIN` if needed. On macOS, run this outside Seatbelt as well. This probe targets portable GLBs with embedded images. Test decoder-dependent variants in their configured game loader.

An optional budget file is a JSON object of inclusive integer maxima, e.g. `{"triangles":25000,"primitives":6,"textureEdge":2048,"bytes":8388608}`. Supported keys also include `vertices` and `materials`. Geometry totals count the exported mesh data reported by the validator. Two nodes can share that data and still cost two draws. Shadows, instance count, overdraw, shader features and texture residency need runtime measurement.

## Build and review in three passes

1. **Silhouette.** Set one Blender unit to one metre, scene unit scale 1, +Z up and −Y nose. The standard glTF Y-up export gives +Y up and +Z nose, as the ship wrapper expects. Put the root at the intended gameplay pivot. Block out the broad volumes, mirror pairs and check the ortho views plus the actual play angle before bevels or textures. Keep useful authoring modifiers. For agent-built geometry, a short asset-local `build.py` is often easier to revise than replaying UI actions. Run it with Blender `-b --factory-startup --disable-autoexec --python-exit-code 1 --python path/to/build.py`. Save iterations to scratch and deliberately checkpoint the master.
2. **Surface.** Model geometry that changes silhouette, catches close-up highlights or creates real depth. Use consistent physical bevels and clean shading. Bake shallow seams, fasteners and scratches from the high mesh to the low mesh. Use shared trim sheets or tiled detail for large repeating structures. Model connections, access and service clearances. Keep quieter areas so the functional parts read from the chase camera.
3. **Game asset.** In the master, keep one self-contained collection per deliverable, e.g. `EXPORT_LOD0`, `EXPORT_LOD1`, `EXPORT_LOD2`, `COLLISION`. Keep high-poly bake sources, decal guides, reference planes and studio lights outside those collections. Put mesh parents and named `socket_*` empties in the export hierarchy. Use applied positive scale and consistent pivots across LODs. Export simple convex collision pieces separately. This preset applies mesh modifiers and exports static parts. Animated machinery needs a separately tested articulation/export contract.

**PBR textures.** Give painted metal a dielectric paint surface and expose the metallic substrate only where the coating is actually worn. Establish material identity with roughness and large forms before adding wear. Keep directional illumination, highlights and deep contact shadows out of base color. Unwrap to a consistent texel density at the closest camera and pad UV islands for the lowest visible mips. Give asymmetric markings unique UV space. Triangulate the bake target consistently, bake with a checked cage and inspect hard edges, mirrored tangent seams and bleed on the exported mesh.

Use Principled BSDF with glTF-compatible image connections. Bake procedural layers to portable maps. Base color and emissive RGB use sRGB. Normal maps use tangent space, OpenGL +Y and Non-Color. Packed ORM uses Non-Color with occlusion in red, roughness in green and metallic in blue. Wire G/B to Principled and wire R to the Blender exporter's glTF Material Output occlusion input when AO is required. Check the exported bindings. Start with opaque materials and use alpha masking or blending only where the part requires it. Give nozzles and always-on indicators separate emission control and inspect them at idle under game exposure. [Blender glTF material mapping](https://docs.blender.org/manual/en/4.5/addons/import_export/scene_gltf2.html) · [Khronos real-time asset creation guidelines](https://github.com/KhronosGroup/3DC-Asset-Creation/blob/main/asset-creation-guidelines/RealtimeAssetCreationGuidelines.md)

**Z-fighting and shading.** Remove duplicate shells, internal coplanar caps and mirrored center faces. Give intersecting plates a real joint or combine them into one surface. Bake flush graphics into the material when possible. The review command fails on identical world-space triangles, including reversed winding across objects. Partially overlapping faces, nearly coincident plates and different triangulations still need an orbit inspection at near and far camera distances. Use the studio for roughness and the raking sun for waviness, bad bevels and shadow leaks. Inspect one 512–1024 px view or native gameplay crop for fine defects, followed by the small chase view for readability.

## Budget at the camera, then measure in the game

Use these as **initial discussion targets per LOD0**, adapted to the closest projected size and typical population. The current player ship is a useful scale reference at 22,632 exported triangles, 27,802 vertices and one primitive.

| Role | Initial triangles | Primitives | Texture starting point |
|---|---:|---:|---|
| Close hero ship | 25–60k | 2–6 | One shared 2K PBR set |
| Repeated mining drone | 2–8k | 1–3 | Shared 512–1K set or trim atlas |
| Depot module | 5–25k | 1–4 | Shared 1–2K trims/atlas across modules |

Author LOD1 first by removing small relief and hidden attachments. Retain silhouette, nozzle rims, material blocks and socket placement. Try roughly 35–50% of LOD0 triangles at LOD1 and 8–15% at LOD2, then choose changeovers by projected size and inspect motion for popping. Instance repeating drones or depot parts with shared geometry/materials where compatible. Group static parts by material where it saves draws while retaining useful culling boundaries. Count exported vertices after splits at seams and hard edges.

Start with an embedded, portable GLB. Work from the same source when evaluating compression. PNG/JPEG reduce transfer size but generally upload as uncompressed texels. A 2048² RGBA8 map with a full mip chain is about 21.3 MiB before GPU compression. For assets where residency matters, evaluate mipmapped KTX2/Basis, especially normals and ORM fidelity. Embedded KTX2 requires the GLB loader to have a renderer-configured KTX2 loader. Standalone planet KTX2 support and converting a sidecar image do not establish this. Verify the chosen GLB extensions, decoder availability, cold load and final rendering in the actual consuming loader. Measure Meshopt/Draco separately if geometry transfer warrants it.

When integrating, reproduce the same scenario before and after on the M2 Pro. Record viewport/DPR, refresh rate, quality, cold load, frame-time p50/p95, CPU and per-pass GPU ms, draws, triangles and resident textures. Include the near chase/mining view, sunward and shadowed sides, many visible copies, and an LOD transition in motion. Reload to match residency before each run. Record the target instance count. The **whole frame** has 16.67 ms at 60 fps or 8.33 ms at 120 fps. Determine asset headroom from the baseline. The in-game harness uses `pnpm drive -- --perf --size 1280x720 --dpr 1 bench:earth_650,earth_750`; add the asset-specific scenario when the asset enters gameplay. [Performance measurement](PERF_MEASUREMENT.md) · [Driver and capture commands](AUTOMATED_TESTING.md)

For a player ship replacement, inspect `src/components/models/ships/ShipOne.tsx` plus its local and co-op callers. They consume a specific named mesh/material, legacy 0.3 × 0.01 scale, hull geometry for physics and explicit nozzle positions. Map the new metre-scale hull, collision and sockets deliberately. Confirm tool-ray clearance, exhaust direction, chase framing and idle emissives in both local and remote views.

## Optional gltfjsx integration

Use gltfjsx when gameplay needs a typed React Three Fiber wrapper for individual meshes or materials. Generate once from the approved GLB with `pnpm dlx gltfjsx@6.5.3 ship.glb --types --keepnames --keepgroups --output Ship.tsx`. These flags preserve named empty socket groups in the generated JSX. In the mounted component, look up each expected socket by name and compare its world transform in asset space to `geometry.json`, including nozzle direction. Review the generated loader URL and preload, adapt the React JSX and GLTF types, then typecheck. Keep physics and effects in a handwritten wrapper. Evaluate `--transform` separately on a copy and repeat socket, material and decoder checks. [gltfjsx options](https://github.com/pmndrs/gltfjsx)

## Storage and handoff

- Keep editable masters under `art/<family>/<id>/`. Git LFS covers `.blend` files there plus binary `maps/` and `refs/` folders. Use relative paths or pack resources. Store a packed copy only when it avoids a missing dependency; keep one authoritative copy of large inputs when possible. Keep brief, recipes and attribution alongside in regular Git. Put text provenance outside binary folders.
- In a new artist checkout, install Git LFS, then run `git lfs install --local` and `git lfs pull`. Check `git lfs ls-files` after staging. Keep one editor per binary master at a time. Commit meaningful milestones. GitHub accounts for each changed LFS binary as another full version. [GitHub LFS storage and bandwidth](https://docs.github.com/en/billing/concepts/product-billing/git-lfs)
- Promote approved, reasonably sized runtime GLBs under `public/models/<family>/` in regular Git so the existing web deployment serves actual model bytes. Keep scratch outputs and routine render sheets in ignored `.captures/`. Record accepted dimensions, socket contract, texture set, LOD budgets, measured metrics and outstanding runtime checks in the brief. A single approved evidence sheet can accompany a milestone if needed.
- **Usage discipline:** read the brief and one contact sheet at the start of a session. Run numeric checks locally. At each gate record the one or two observable changes needed, make one coherent edit and review again. Load a high-resolution reference or a single larger view when it will resolve a specific question. Reuse accepted geometry, UVs and materials. Reserve more expensive reasoning for conflicting design constraints or repeated failures. Stop when the model reads correctly at its intended camera, passes validation and fits measured scene headroom.
