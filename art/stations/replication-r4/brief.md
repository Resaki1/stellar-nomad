# R4 replication point

Model for the deployable Von Neumann ship fabricator. The station reconstructs a ship after a mind transfer and loads it with a protected fuel reserve. Delivered propellant can supplement the reserve. The brief records the physical interpretation for the model. The existing game rules govern spawn and fuel.

## Reference and layout

The [R4 front, side, top and rear sheet](refs/r4-reference.png) is owner-supplied concept art. Preserve the octagonal stack, narrow dark waist, raised paired solar wings, dish, mast cluster and asymmetric service arm. The front view governs the vertical proportions and the top view governs the eight-sided stack. Both solar trays share one hinge design and an upward rake. Their short axes run parallel to the station's fore–aft axis. The R4 label belongs to the concept sheet.

The reference's solid lower front and small central strip leave no clear route to release a ship. The model gives the fabrication berth two closed sliding leaves, a pressure bulkhead at the back and two sacrificial guide rails. The service arm reaches to one side of the approach corridor. The opposite face has dry-break ports for reserve and bulk propellant, with protected tank cartridges around the lower deck. Bulk material loading could use the service arm and replaceable trays later. The reserved fuel quantity remains gameplay data.

## What the hardware is made of

| Assembly | Function and finish |
| --- | --- |
| Upper collar and avionics crown | Shield the control and mind-transfer hardware. Replaceable matte ceramic-coated alloy panels protect a dark structural shell. Panel-to-panel tone and edge wear vary with replacement and servicing. |
| Exposed waist | Carry structural loads and reject heat from the fabricator and propellant machinery. Dark treated alloy carries the loads. Ribbed aluminum thermal hardware uses a matte inorganic coating. Machined titanium fasteners and clamps catch light at the edges. |
| Solar wings | Power standby and fabrication systems. Dark photovoltaic cells and busbars sit under low-roughness silica coverglass. Aluminum honeycomb trays carry loads, and two backing struts per tray meet load-spreading shoes. The coverglass can glint at the right angle. |
| Fabrication berth | Give the reconstructed ship a clear exit. Hard alloy guides and a recessed tooling wall take wear. Reinforced sliding leaves close the berth, and amber safety paint and status lenses mark its approach. |
| Fuel cartridges and manifold | Hold and transfer propellant. Restrained metal jackets protect the vessels, with stainless dry-break rings and recessed dark seals. The vessels sit recessed behind bumper spars to keep impact loads out of the fluid hardware. |
| Manipulator | Align hoses, service the berth and handle modules. Sealed metal pins and geared joints carry articulated alloy links with replaceable ceramic guards. The gripper tips use a higher-roughness contact finish. |
| Dish, masts and indicators | Receive the recovery signal and mark the station. The dish is formed conductive alloy with a suspended feed and a rear elevation actuator. Masts use thin telescoping metal sections. The dish-side beacon sits outside the reflector rim. It flashes with the other mast beacon, while the body lamps stay on. |

## Authoring and runtime handoff

`build.py` and `finishes.py` are the source of truth for this iteration. The recipe reuses the starter ship's packed PBR image and noise helpers. The master contains individual editable parts, four material batches per render LOD in `EXPORT_LOD0` through `EXPORT_LOD2` and separate closed convex pieces in `COLLISION`. Export batches and proxies are hidden from the editable viewport. Rendered trim has base color, packed metallic/roughness and tangent-space normals. Photovoltaics share a second color and roughness set with the cell grid beneath the smooth face.

The pivot is at the center of the main stack. Units are metres. Blender +Z up and +Y front export as glTF +Y up and −Z front. The recovery pose aligns with the berth centre, 20 m outward from the door face. The recovered ship faces local −Z, away from the station. Transit approaches keep a 500 m stand-off. Workshop views named `rear` and `chase` show the station's launch side because the workshop uses the ship's axis convention.

| Socket | Position in GLB metres (X, Y, Z) | Socket +Z direction |
| --- | --- | --- |
| `socket_launch` | (0, −16.55, −18.3) | −Z |
| `socket_fuel_bulk` | (−1.41, −16, 18.95) | +Z |
| `socket_fuel_reserve` | (1.41, −16, 18.95) | +Z |
| `socket_arm_tool` | (−35.3, −18.32, −20.65) | −Y |
| `socket_mast_port_light` | (−10.2, 35.67, −2.4) | +Y |
| `socket_mast_starboard_light` | (11.15, 34.87, 2.8) | +Y |

```sh
blender -b --factory-startup --disable-autoexec --python-exit-code 1 --python art/stations/replication-r4/build.py -- art/stations/replication-r4/replication-r4.blend
pnpm model build art/stations/replication-r4/replication-r4.blend --asset replication-r4 --views rear,side,top,front --size 384 --webgpu
pnpm model build art/stations/replication-r4/replication-r4.blend --asset replication-r4-lod1 --collection EXPORT_LOD1
pnpm model build art/stations/replication-r4/replication-r4.blend --asset replication-r4-lod2 --collection EXPORT_LOD2
pnpm model build art/stations/replication-r4/replication-r4.blend --asset replication-r4-collision --collection COLLISION --light clay --views rear,side,top,chase
```

## Lamp spill bake (VFX plan §4, S3)

After `build.py`, bake the steady lamps' diffuse light, then re-export the three render LODs:

```sh
node tools/models/spill-bake.mjs art/stations/replication-r4/replication-r4.blend replication-r4
pnpm model build art/stations/replication-r4/replication-r4.blend --collection EXPORT_LOD0   # and LOD1, LOD2; copy to public/models/stations/
```

The bake adds a second UV map, "Spill lightmap" (glTF `TEXCOORD_1`, lightmap-packed, one atlas per LOD), and writes `public/models/stations/replication-r4-spill-lod{0,1,2}.hdr` (512/256/128 px; irradiance in game units before pre-exposure) plus `replication-r4-spill.json`. Blinking beacons are not baked; the game's pooled spill light handles flashes. Re-run it whenever lamps or geometry change: a stale lightmap puts light in the wrong places. Measured 2026-11-24: 98 steady lamps per LOD, peak E 0.96 game units at LOD0, maps 637/176/40 KB; GLBs +17 % for the extra UV.

## Runtime and review

| Export | GLB dimensions X × Y × Z | Triangles | Primitives | Bytes |
| --- | --- | ---: | ---: | ---: |
| LOD0 | 75.40 × 71 × 40.65 m | 42,144 | 4 | 5,936,712 |
| LOD1 | 75.35 × 71 × 40.65 m | 13,656 | 4 | 1,525,464 |
| LOD2 | 75.55 × 71 × 40.65 m | 5,640 | 4 | 538,380 |
| Collision | 75.55 × 71 × 40.62 m | 2,714 | 37 | 179,140 |

The four GLBs under `public/models/stations/` passed Khronos validation with zero warnings. The visual exports have matching transforms for all six sockets. LOD1 simplifies bevels and louvers, combines individual lamps into light bars and uses smaller maps. LOD2 strips fasteners and trim relief while keeping the berth, dish, arrays and silhouette of the arm. LOD0's embedded PNG maps are approximately 9.3 MiB as full-mip RGBA8 textures before driver overhead.

Deployed stations share four instanced batches per active LOD. The camera selects LODs at 600 m and 1,100 m with 12% hysteresis. LOD0 is active at 500 m on approach. The placement ghost uses LOD2. The game pre-exposes the 18,000 cd/m² body lamps and the 65,000 cd/m² peak mast beacons. Both beacons flash for 450 ms every 2 s. Assets load when a station or its placement preview is present.

Each station within 2 km adds one fixed 37-piece compound collider to near-field physics. It unloads beyond 2.4 km. The proxy covers the stack, the closed door, sill, rails, arrays and booms, arm links and fingers, fuel manifold and masts. Blender casts 19 contact rays and 13 clearance rays, including nine rays that find the door and nine that clear the 20 m approach before it. The door has its own convex piece and the source keeps the two physical leaves as separate meshes.

The live Chrome WebGPU run recovered with the ship centre at local (0, −16.55, −38.30) m, facing away. The ship cleared the outward departure and registered positive impulses against the closed door, both wings and an outer arm link. It flew outside the wing span without making contact. The camera selected LOD0 at 500 m, LOD1 at 810 m and LOD2 at 2.7 km. The test also verified the beacon cycle and that a station blocking the emergence pose triggers a wider fallback. Latest local review pointers are under `.captures/models/latest/`.

```sh
pnpm drive -- --perf --no-isolate --url http://127.0.0.1:3001/ --out .captures/replication-door-final run:scripts/drive-examples/replication-model.mjs
```

The proxy and socket directions assume the static deployed pose. If the arm moves later, give its links explicit joint pivots and drive their collision transforms with the motion.
