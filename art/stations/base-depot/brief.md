# Base orbital depot

The deployable station receives cargo and propellant. Its structural truss, transfer head, paired side tanks, dorsal and ventral cargo cassettes, and aft power and comms equipment make up the base configuration. The aft truss accepts the separate [hydrate refinery](../depot-refinery/brief.md). The keyed bay is empty on the base configuration.

## Reference and scale

The [owner-supplied depot sheet](refs/base-depot-reference.png) governs the proportions. Use the top view for the longitudinal layout and paired assemblies, the side view for vertical spacing, and the docking-end view for the sealed circular interface. Both tanks and cassettes share structural dimensions. The solar trays deploy in the same plane and the dish and mast layout differs across the centerline to keep the reflector clear. The four sockets shown on the docking neck are capped service connections. The circular head is an external transfer interface for a ship or drone.

The visual and proxy envelopes measure **38.47 m long × 26.50 m across the deployed arrays × 13.22 m tall**, including the masts. The tanks span about 16.8 m across the body. Each tank is about 18 m long and 4.5 m across the pressure shell. The capture ring is about 8.5 m in outside diameter, scaled to the 9.28 m span and 8.13 m length of the starter ship. The ship approaches the interface from outside the collar. Existing interaction ranges and depot placements live in game data.

## Material and construction

| Assembly | Purpose, material and finish |
| --- | --- |
| Open truss | Carries tank, cargo and docking loads through drawn structural alloy longerons and paired braces. The dark treated metal reads separately from the machined metal shoes and wear rails at joints. A protected raceway carries cabling and tubing. |
| Docking collar | The ring captures an external transfer fixture. Dark structural metal supports a machined alloy lip with replaceable ceramic impact shoes. Recessed service fittings have sealed caps and amber index rings. |
| Twin tanks | Formed metal pressure vessels have domed heads, joined transfer lines, and separate load cradles. The visible pale exterior consists of replaceable thermal and impact jacket panels with dark restraint bands. Amber marks the high-pressure lines and service areas. |
| Cargo cassettes | Removable dorsal and ventral storage sit on capture shoes. Ceramic-coated aluminium lids show mild panel variation from replacement and wear. Latches and lift bars show edge polish where handling equipment contacts them. |
| Power and comms | Dark photovoltaic cells sit under low-roughness silica coverglass on aluminium honeycomb trays. The coated rear louvers reject waste heat. The aluminium dish has a rear yoke and a suspended feed, with two separate amber guide lamps. |
| Upgrade bay | Two machined slide rails tie into the truss cross-frames. Keyed latch shoes identify the install points, and capped data and coolant couplings sit behind the rails. Reserve roughly 6.5 m wide × 5.7 m long above the mounting plane for an upgrade module. |

The Blender recipe reuses the replication station's packed base color, metallic-roughness and normal trim generation and its separate photovoltaic texture set. The game pre-exposes the amber collar guides and aft lamps at 18,000 cd/m². Both mast beacons flash together for 450 ms every two seconds at a peak of 65,000 cd/m².

## Authoring and interfaces

`build.py` is the source of truth. The Blender file contains editable individual assembly meshes, four material batches per render LOD in `EXPORT_LOD0` through `EXPORT_LOD2` and separately authored convex pieces in `COLLISION`. Blender −Y docking and +Z up become glTF +Z docking and +Y up. The origin is on the lengthwise centerline at deck centre. Socket local +Z points out of each attachment plane.

| Socket | GLB position in metres (X, Y, Z) | Direction |
| --- | --- | --- |
| `socket_dock` | (0, 0, 20.4) | +Z |
| `socket_approach` | (0, 0, 40.4) | +Z |
| `socket_upgrade_refinery` | (0, 3.39, −9.8) | +Y |
| `socket_upgrade_coolant` | (0, 3.69, −12.77) | +Y |
| `socket_cargo_upper` | (0, 5.09, 2.1) | +Y |
| `socket_cargo_lower` | (0, −5.09, 2.1) | −Y |
| `socket_nav_0` | (−2.91, 5.9, −16.7) | +Y |
| `socket_nav_1` | (2.79, 6.28, −15.12) | +Y |

The hydrate refinery attaches at `socket_upgrade_refinery` with its own render asset and collision pieces. Keep utilities reachable from the aft side and preserve access to both cargo cassettes and the forward collar.

```sh
blender -b --factory-startup --disable-autoexec --python-exit-code 1 --python art/stations/base-depot/build.py -- art/stations/base-depot/base-depot.blend
pnpm model build art/stations/base-depot/base-depot.blend --asset base-depot --views bow,side,top,front,bottom,chase --size 384 --webgpu
pnpm model build art/stations/base-depot/base-depot.blend --asset base-depot-lod1 --collection EXPORT_LOD1
pnpm model build art/stations/base-depot/base-depot.blend --asset base-depot-lod2 --collection EXPORT_LOD2
pnpm model build art/stations/base-depot/base-depot.blend --asset base-depot-collision --collection COLLISION --views front,side,top,bow --light clay
```

## Review

| Export | Triangles | Primitives | Bytes |
| --- | ---: | ---: | ---: |
| LOD0 | 33,968 | 4 | 4,645,156 |
| LOD1 | 15,176 | 4 | 1,098,052 |
| LOD2 | 5,336 | 4 | 372,100 |
| Collision | 4,310 | 89 | 290,120 |

The runtime GLBs live in `public/models/stations/`. All four passed Khronos validation with zero warnings. The three visual LODs preserve matching metre bounds and all eight socket transforms. LOD1 removes the bolts and fine bevels and reduces the trim map resolution. LOD2 simplifies the tank jackets and leaves out the tiny service fittings. Visible stations share geometry and materials, with camera-distance thresholds of 600 m and 1,100 m and 12% hysteresis on approach. The placement ghost draws pre-exposed edges from LOD2 so the truss and solar trays read through the end-on view. The installed refinery follows the base depot’s selected LOD.

Each nearby depot registers one fixed, 89-piece Rapier compound inside 3 km and unloads it beyond 3.6 km. The collar uses separate lip pieces and a recessed backing, preserving the capture recess and the approach off its edges. The fixed proxy also covers the thin solar trays and masts while keeping space around them open. The workshop's proxy gate covers 12 positive hits and nine clear paths. Latest model reviews are under `.captures/models/latest/`.

The live Metal WebGPU flight used a depot rotated 211° in its Earth frame. The ship flew the collar centreline from local Z 71 m to 27.34 m without contact. Continuing deliberately produced an impulse at local Z 19.73 m, inside the collar lip at 20.4 m. Both solar trays produced contact impulses near their outer tips, and a flight over a tray cleared it. The camera selected LOD0 at 500 m, LOD1 at 850 m and LOD2 at 3.8 km. The test verified collider teardown and re-entry, steady guides, and the two-second mast cadence.

```sh
pnpm drive -- --perf --no-isolate --url http://127.0.0.1:3001/ --out .captures/depot-flight run:scripts/drive-examples/depot-model.mjs
```
