# Utility drone

The base depot fabricates this uncrewed drone for asteroid mining and freight between depots. The [project owner's reference](refs/helper-drone.png) supplies the compact tool head, open frame, side cargo hatch, external maneuvering packs and twin rear solar trays. The oblique sets the silhouette and finish. The orthographics inform the enclosure and loading hardware.

## Construction and finish

- The chamfered nose shields the avionics and mining optics with ceramic-coated alloy. The larger, normally dark front optic emits the mining beam while working. Two small amber windows report readiness. Captive screws and an inset shield break up the front armor.
- An enclosed exchange cassette sits between dark treated structural chords. Keyed amber collars and recessed doors on both flanks expose loading interfaces. Small propellant vessels and their supported feed lines fit inside the truss. The radiator slats reject heat from the tool and power electronics.
- Twin aft drive bells have sealed, dark refractory throats. The external reaction-control packs sit on the truss joints. The rear bulkhead carries the electronics, fixed solar hinges, and two small amber beacons.
- The trays carry glossy dielectric coverglass over textured photovoltaic cells and matte coated honeycomb backing below. Amber goes on grasp points and service edges. The trim set varies roughness, metallic response and coating wear between structural alloy, bare fittings and painted armor.

## Asset contract

The 4.51 m hull length and 5.96 m deployed span are inferred from the reference and scaled against the starter ship's 8.13 m length and 9.28 m span. The drone is 2.60 m tall including the masts. Blender is +Z up and −Y forward. Runtime is +Y up and +Z forward, with the pivot on the main frame centerline.

All three render LODs carry the same sockets. A socket's local +Z points along its use direction.

| Socket | GLB position (m) | Direction |
| --- | --- | --- |
| `socket_mining` | (0, 0.05, 2.234) | +Z |
| `socket_engine_port` and `socket_engine_starboard` | (±0.51, −0.26, −2.285) | −Z |
| `socket_cargo_port` and `socket_cargo_starboard` | (±1.185, −0.08, −0.55) | ±X |

Port is +X in model space. The haul and engine sockets are authored for future effects. Two steady nose windows and two blinking mast beacons carry `light_*` extras for the shared mesh-to-light-point renderer. Beacons flash for 450 ms every two seconds on the simulation clock, matching the depot.

| Export | Triangles | Primitives | Bytes |
| --- | ---: | ---: | ---: |
| LOD0 | 9,872 | 4 | 2,186,144 |
| LOD1 | 5,072 | 4 | 424,244 |
| LOD2 | 1,956 | 2 | 141,592 |
| Collision proxy | 2,126 | 32 | 132,808 |

The runtime loads the three render files on the first drone, shares geometry and textures across copies, and changes level at 100 and 320 m with 12% approach hysteresis. The mesh and beacons are culled beyond the existing 3 km drone range. At LOD2 the beacons use the existing light-point pass while their physical housings stay in the trim batch. The normal-mapped LOD0 trim is 512 × 1152 and its photovoltaic maps are 512 × 256. One depot supports two drones. The world cap is 48 across 24 depots.

The separate convex proxy covers the hull, wings, masts, drive packs and reinforced frame, with separate thin volumes for the wings and hinges. Drones currently follow simulation-driven visual positions in flight. Runtime collision needs a moving body and has no owner in the existing drone system. The authored proxy is ready for that when drone contact is implemented.

## Author and review

`build.py` is authoritative. It reuses the depot geometry helpers and station PBR trim and photovoltaic generators. The master contains the individual editable parts and all four export collections. Use Blender 5.3 and the [model workflow](../../../docs/MODEL_WORKFLOW.md), then copy each approved candidate into `public/models/drones/` with the matching suffix.

```sh
blender -b --factory-startup --disable-autoexec --python-exit-code 1 --python art/drones/base-drone/build.py -- art/drones/base-drone/base-drone.blend
pnpm model build art/drones/base-drone/base-drone.blend --asset base-drone --views all --light studio --webgpu
pnpm model build art/drones/base-drone/base-drone.blend --asset base-drone-lod1 --collection EXPORT_LOD1
pnpm model build art/drones/base-drone/base-drone.blend --asset base-drone-lod2 --collection EXPORT_LOD2
pnpm model build art/drones/base-drone/base-drone.blend --asset base-drone-collision --collection COLLISION --light clay
pnpm drive -- --perf --no-isolate --url http://127.0.0.1:3001/ run:scripts/drive-examples/drone-model.mjs
```

All four exports passed Khronos validation with zero warnings. The close model rendered in the isolated WebGPU probe. A reimport of the collision GLB registered hits on both wing tips and left clear space above and just outboard of the tips. In the 1280 × 720 Metal WebGPU flight check, a depot fabricated two drones using three shared LOD downloads. Their beacons flashed 2,000 ms apart, both ready windows stayed lit, and the LODs switched and culled at the expected ranges. Peak fleet frame time remains unmeasured.

A live asteroid sortie confirmed that the rendered beam starts within 1 mm of the imported mining socket. The broader motion script stopped later at its end-of-work beam fade assertion, before it reached the field-haul check.
