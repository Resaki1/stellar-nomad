# Starter survey ship

First playable ship. Prioritize the recognizable silhouette and twin drives in the chase camera, with enough underside detail for a close orbit. The model uses a provisional 9.28 m span, 8.133 m length and 1.614 m height. The pivot is on the centerline near the main hull. The existing metre-scale chase rig frames the new hull without a camera offset change.

## References and interpretation

- [Full underside](refs/underside.png) supplies the outline, radiator sweep, paired utility bays, plumbing and center optic.
- [Four obliques](refs/obliques.png) supply hull depth, ivory ceramic armor, amber fittings, the three-lens nose and the two aft-facing nozzles. The above-rear angle is the chase reference. The below-front image contributes surface cues only.
- Both references were supplied by the project owner as generated concept art. The belly optic points down, with no thrust function. The game-facing mining effect has a clear forward origin at the nose. The fixed wings carry solar arrays above and cooling surfaces below. Cross spars tie their structural trays into the cradles and central frame.

## Function and surface materials

These are the design assumptions used to make the model read as assembled hardware.

| Assembly | Purpose | Material and appearance |
| --- | --- | --- |
| Pressure vessel, keel and spars | Carry drive loads and protect the pressurized equipment and avionics | Structural alloy. Dark treated metal at exposed frame joints and brighter bare metal at machined fittings. |
| Ivory and sand-colored panels | Replaceable shielding for grit, micrometeoroids and routine contact | Ceramic-coated alloy over the vessel. Matte dielectric faces. Scrapes at panel edges and tool contact reveal the brighter alloy. |
| Upper wing faces | Generate auxiliary electrical power | Dark blue-black photovoltaic cells under antireflective coverglass, with a fine grid of buried conductors. The glass produces a sharp reflection when the viewing angle lines up with the Sun. |
| Lower wing faces | Reject waste heat from the electrical system and propulsion loop | Aluminum radiator plates under a pale, matte inorganic thermal coating. The channels connect to the aft thermal loop. |
| Drive shrouds and nozzles | Protect the propulsion hardware and direct the exhaust | Ceramic cladding around metal cradles, machined alloy at the nozzle lip, heat-oxidized metal toward the bell exit, matte carbon deposits deeper inside, and a dark recessed refractory throat. The forward housing is opaque. |
| Sensor head, belly optic and utility bays | Survey and navigate, inspect below the hull and service equipment | Dark coated optical surfaces, metal mounting bezels, and graphite-finished bay covers with accessible fasteners and latches. |
| Amber strips and caps | Mark exposed edges and service points | Pigmented dielectric coating, with small scrapes at contact surfaces. |

The solar and radiator split is a visual design decision. It establishes the materials and equipment layout for later power and thermal gameplay. [NASA spacecraft solar array glint study](https://ntrs.nasa.gov/citations/20240003767)

## Authoring

`build.py` defines the geometry and `surfaces.py` generates the packed PBR maps. The saved Blender file contains the individual editable parts, three baked export collections grouped by material, and a separate seven-piece collision proxy. Generate again after editing the recipe with Blender 5.3:

```sh
blender -b --factory-startup --disable-autoexec --python-exit-code 1 --python art/ships/starter-survey/build.py -- art/ships/starter-survey/starter-survey.blend
pnpm model build art/ships/starter-survey/starter-survey.blend --asset starter-survey --views all --light studio --webgpu
pnpm model build art/ships/starter-survey/starter-survey.blend --asset starter-survey-lod1 --collection EXPORT_LOD1
pnpm model build art/ships/starter-survey/starter-survey.blend --asset starter-survey-lod2 --collection EXPORT_LOD2
pnpm model build art/ships/starter-survey/starter-survey.blend --asset starter-survey-collision --collection COLLISION --light clay
```

Use the executable in the Blender app bundle on macOS. Direct edits to the master need to be reflected in the recipe or the export collection refreshed manually. Inspect the final trim material on `EXPORT_LOD0`, where the machinery UVs and material are assigned after bevels and triangulation. The latest run is indexed by `.captures/models/latest/starter-survey.json`.

## Export handoff

Blender −Y nose and +Z up become glTF +Z nose and +Y up. Coordinates are metres. Each socket's local +Z is the effect direction.

| Socket | GLB position (X, Y, Z) | GLB direction |
| --- | --- | --- |
| `socket_engine_port` | (1.32, 0.33, −3.94) | −Z |
| `socket_engine_starboard` | (−1.32, 0.33, −3.94) | −Z |
| `socket_mining` | (0, −0.071, 4.193) | +Z |
| `socket_survey` | (0, −0.65, 2.14) | −Y |

The hero uses a 1024 × 512 dorsal and ventral atlas with panel-specific color, metallic/roughness and normal maps. The ceramic remains dielectric across the panel faces. Chips expose the alloy at local edges and deeper scuffs. Normal maps carry the micro-relief and the cooling channels inside the heat-tinted nozzle liners. The wings share an atlas that gives the dorsal solar coverglass and the ventral radiator coating different appearances. Four machinery finishes share a packed trim sheet so the four finishes render together. The refractory chamber uses its own low-specular material.

LOD1 keeps the panel and trim pattern in smaller maps and omits the close-up normals and fasteners. LOD2 uses flat material factors and a 32 × 16 wing atlas to preserve the dorsal and ventral distinction. Both reduce bevels, radial segments and mechanical detail while preserving span, length and all four socket transforms.

| Export | Triangles | Vertices | Primitives | Bytes |
| --- | ---: | ---: | ---: | ---: |
| Player and close remote (LOD0) | 33,386 | 74,205 | 8 | 6,086,708 |
| Medium remote (LOD1) | 8,690 | 14,498 | 7 | 1,493,648 |
| Distant remote (LOD2) | 3,676 | 6,806 | 5 | 210,520 |
| Physics proxy | 752 | 1,672 | 7 | 49,528 |

Runtime artifacts are in `public/models/ships/`. Copy each successful run's GLB to its corresponding runtime filename after inspecting the sheet and metrics. The game mounts seven convex volumes on one rigid body. These cover the core, nose, aft spine, two drives and two wings. The proxy has a 9.28 m span and preserves the thin wing profiles and clearance above and below them. In co-op, remote visuals switch at 90 m and 240 m of distance from the player camera, with 12% hysteresis on approach. The hero LOD is always used for the local ship.

The nozzles have a 0.455 m exit radius and use the existing throttle-driven exhaust. The render hull is authored in its unlit state. For future blinkers, export stable attachment sockets and distinct lamp lenses or an emissive mask. The packed atlas covers baseline wear. A runtime layer can add per-ship localized damage via ship-local projection or the unique panel atlas. For animated parts, export those meshes separately with named hinge pivots and preserve their hierarchy across LODs.

## Validation

All four runtime GLBs passed the Khronos validator and rendered in the isolated Chrome WebGPU probe. The local game loaded the compound proxy directly in metres. The `starterProxy` physics exercise verifies contact at the nose, both wing tips, underside and a nozzle, plus clearance above and outside the wing. The render LODs have identical engine and tool socket transforms. In the running game, the 12 km Luna scene showed the ship framed from the chase camera and both plumes originating at the nozzle centres under thrust.

The surface pass compared the old and new exports under raking sun at matching bow and chase angles. Both exports blocked all 522 rays sampled through the nozzle apertures. At zero speed and thrust, the matched in-game port nozzle crop went from 220 to 58 pixels above an average RGB code value of 160. A thin reflection remains in the absence of local self-shadowing. The solar coverglass showed a glint in Blender that diminished after a 14° shift of the light.

The cold localhost:3001 run on a fresh Chrome profile transferred 2.98 MB for the 6.09 MB decoded hero GLB in 152 ms and reached flight in 4.9 s. The full-mip color and data maps are estimated at 16.5 MiB for LOD0 and 4.8 MiB for LOD1 at RGBA8, before driver overhead. These GLBs use embedded PNGs. The loopback request time is specific to the local dev server.

At `earth_650`, the final headless Metal WebGPU run at 1280 × 720 and DPR 1 measured 16.6 ms p50 and 17.9 ms p95 frame time. The full local scene GPU pass averaged 0.73 ms. That pass includes the ship and other local rendering. The whole scene still exceeds the 60 Hz frame budget at p95 in this run, and the harness's 60 Hz pacing leaves 120 Hz unverified.

The two-player exercise passed remote LOD changes 0 → 1 → 2 → 0, the mining beam and rock break, remote exhaust, and session teardown with zero render errors. To repeat it on the dev server, run `COOP_PARTS=shipLods,remoteFx,leave pnpm drive:coop -- --url http://localhost:3001/ run:scripts/drive-examples/coop-check.mjs`. The driver starts and cleans up a disposable world.

The focused compound-collider check passed both wingtip approaches, an underwing approach, the nose and an aft nozzle. It also passed above-wing and outside-span clearance checks. The broader physics sweep still flags two extreme-speed hull grazes (604 and 891 m/s) with no recorded contact impulse. Trajectory sampling found a deflection in the first case and a CCD position clamp in the second. The sweep also flags static-wall jitter at 0.059 m/s against its 0.05 m/s threshold. The old proxy failed the resting and contact-rebase gates. Rebase, energy and speed-gate checks passed with the compound proxy.
