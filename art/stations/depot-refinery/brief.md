# Depot hydrate refinery

The refinery turns stored hydrates into propellant through the existing station fabrication and refining path. The [detached reference](refs/detached.png) defines the cylindrical vessel, skid, finned radiator and service housings. The [installed concept](refs/installed-concept.png) shows how the finishes should read alongside the base depot. This design places the module on the depot's existing dorsal aft rails. The skid is wider than the vessel so it can reach the four keyed latch seats.

## Fit and finish

- The module measures 6.12 m wide, 5.95 m long and 3.78 m tall. The service fittings account for the small end overhang beyond the skid.
- Four machined shoes fit the depot latch centres at module-local Blender X ±2.59 m and Y ±2.31 m. Two coolant return stubs reach the existing utility block behind the rails. The export fit check found only the four shoe contacts and two intentional coolant joints.
- Ceramic-coated vessel shields and controller panels match the depot's pale armor. Dark structural alloy carries the vessel loads. Amber coatings mark service hardware and pressure fittings. The upper panel uses coated aluminium fins to reject process heat, and the alloy pipes connect the radiator to both service ends.
- The front service ring contains two sealed fittings. Both solar trays, the cargo lids and the forward docking collar remain accessible.

## Authoring and runtime

`build.py` is the source of truth and reuses the base depot's mesh helpers and the station PBR trim generator. The editable master contains the detached assembly, three metre-scale render LODs and a 27-piece compound proxy. All render LODs have matching bounds. They use the depot's material palette and one draw each.

The module origin is at the rail seat, with +Z up and −Y forward in Blender. The GLB is +Y up. The runtime uses the existing `socket_upgrade_refinery` transform and applies the up-axis correction before mounting both the visual and collider. The existing saved `depot.refinery` flag gates both assets. The visual follows the base depot's LOD. Its fixed collider streams at the same distances as the depot.

| Export | Triangles | Primitives | Bytes |
| --- | ---: | ---: | ---: |
| LOD0 | 8,004 | 1 | 1,829,028 |
| LOD1 | 3,168 | 1 | 278,284 |
| LOD2 | 1,808 | 1 | 128,584 |
| Collision | 1,668 | 27 | 105,400 |

All four GLBs passed Khronos validation with zero warnings.

```sh
blender -b --factory-startup --disable-autoexec --python-exit-code 1 --python art/stations/depot-refinery/build.py -- art/stations/depot-refinery/depot-refinery.blend
pnpm model build art/stations/depot-refinery/depot-refinery.blend --asset depot-refinery --views bow,chase,bottom,top --size 384
pnpm model build art/stations/depot-refinery/depot-refinery.blend --asset depot-refinery-lod1 --collection EXPORT_LOD1
pnpm model build art/stations/depot-refinery/depot-refinery.blend --asset depot-refinery-lod2 --collection EXPORT_LOD2
pnpm model build art/stations/depot-refinery/depot-refinery.blend --asset depot-refinery-collision --collection COLLISION --light clay
pnpm drive -- --perf --no-isolate --url http://127.0.0.1:3001/ --out .captures/depot-refinery-flight run:scripts/drive-examples/depot-model.mjs
```

The live Metal WebGPU check found empty rails and no refinery asset requests before installation. The normal fabrication operation mounted the module at depot-local (0, 3.39, −9.8) m and added its fixed collider. A starter ship registered a radiator impact at 7.02 m above the depot origin. The module matched depot LOD1 at 850 m and LOD2 at 3.8 km, released the distant collider, and remounted on save reload.
