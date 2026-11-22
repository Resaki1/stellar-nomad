"""Build a removable hydrate refinery that seats on the base depot's aft rails."""
import sys
from collections import defaultdict
from pathlib import Path

import bpy

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "base-depot"))
# Keep the same manufactured profiles, trim mapping and export batching as the base.
import build as depot
from build import X, Y, UP, beam, box, pipe, screw, turned


def skid():
    for side in (-1, 1):
        x = side * 2.59
        for y in (-2.31, 2.31):
            # Sink the lower shoe into the keyed seat so the load path has no gap.
            box("Keyed slide shoe", (x, y, 0.136), (0.94, 0.75, 0.308), "alloy",
                bevel=0.045, hit=f"shoe_{side}_{y}")
            box("Captive shoe lock", (x + side * 0.29, y, 0.39), (0.26, 0.38, 0.23), "amber", bevel=0.046)
        box("Refinery skid rail", (x, 0, 0.365), (0.42, 5.21, 0.29), "frame",
            bevel=0.058, hit=f"skid_{side}")
        for y in (-1.52, 1.52):
            beam("Skid-to-cradle cross member", (x, y, 0.38), (0, y, 0.44),
                 0.29, 0.25, "frame", hit=f"cross_{side}_{y}")
        if depot.lod < 2:
            beam("Skid diagonal tie", (x, -1.55, 0.37), (side * 1.36, 0, 0.38), 0.18, 0.17, "alloy")
            beam("Skid diagonal tie", (side * 1.36, 0, 0.38), (x, 1.55, 0.37), 0.18, 0.17, "alloy")
    box("Sealed drip and cable tray", (0, 0, 0.40), (2.9, 5.19, 0.19), "graphite", bevel=0.067, hit="tray")


def processing_vessel():
    at = (0, -0.16, 1.75)
    turned("Metal processing vessel", at, Y, [
        (-1.79, 0.36), (-1.68, 0.72), (-1.40, 1.13), (-1.08, 1.29),
        (1.08, 1.29), (1.44, 1.12), (1.69, 0.72), (1.80, 0.35),
    ], "alloy", sides=32, hit="vessel")
    breaks = (-1.15, -0.48, 0.43, 1.14) if depot.lod < 2 else (-1.15, 1.14)
    for i, (lo, hi) in enumerate(zip(breaks, breaks[1:])):
        turned("Ceramic vessel jacket", at, Y, [
            (lo + 0.018, 1.29), (lo + 0.043, 1.33), (hi - 0.043, 1.33), (hi - 0.018, 1.29),
        ], "patched" if i == 0 else "ceramic", sides=32, hit="vessel")
    for side in (-1, 1):
        turned("Formed ceramic end shield", at, Y * side, [
            (1.15, 1.304), (1.38, 1.17), (1.60, 0.92), (1.73, 0.62), (1.78, 0.46),
        ], "ceramic", sides=32, hit="vessel")
    turned("High-pressure index band", at, Y, [(0.48, 1.336), (0.71, 1.336)], "amber", sides=32)
    for y in (-1.17, 0.92):
        turned("Steel restraint band", at, Y, [(y - 0.13, 1.347), (y + 0.13, 1.347)], "frame",
               sides=32, hit="vessel")
        for side in (-1, 1):
            beam("Isolated vessel pedestal", (side * 1.21, y, 0.50), (side * 1.30, y, 1.65),
                 0.27, 0.31, "frame", hit=f"pedestal_{side}_{y}")
            box("Band capture block", (side * 1.33, y, 1.64), (0.23, 0.40, 0.32), "alloy", bevel=0.057)
            screw("Restraint cap bolt", (side * 1.436, y, 1.64), side * X, 0.057)
    for side in (-1, 1):
        pipe("Low process fluid return", [(side * 1.14,-2.01,0.74), (side * 1.48,-1.70,0.67),
             (side * 1.48,-1.2,0.67), (side * 1.48,0.81,0.67), (side * 1.40,1.57,0.67),
             (side * 1.02,1.91,0.71)], 0.084, "alloy", clamp=(2, 3))


def service_units():
    box("Metering manifold housing", (0, -2.10, 1.41), (2.36, 0.99, 1.67), "frame",
        corner=0.26, bevel=0.12, hit="forward_service")
    turned("Recessed service ring", (0, -2.57, 1.45), -Y, [
        (-0.045, 0.83), (0.05, 0.89), (0.19, 0.87), (0.19, 0.67), (0.08, 0.64),
    ], "alloy", sides=24, closed=True, hit="forward_service")
    turned("Amber ring locator", (0, -2.57, 1.45), -Y,
           [(0.07, 0.898), (0.14, 0.898), (0.14, 0.859), (0.07, 0.859)], "amber", sides=24, closed=True)
    for z in (1.17, 1.73):
        turned("Capped service coupler", (0, -2.65, z), -Y,
               [(0, 0.25), (0.09, 0.26), (0.14, 0.18)], "tank", sides=16)
        turned("Sealed valve face", (0, -2.75, z), -Y, [(0, 0.15), (0.055, 0.15)],
               "graphite", sides=12)
    box("Ceramic controller housing", (0, 2.00, 1.38), (2.55, 1.33, 1.63), "ceramic",
        corner=0.27, bevel=0.12, hit="aft_service")
    box("Controller service lid", (0, 2.685, 1.39), (1.91, 0.13, 1.22), "patched",
        corner=0.16, bevel=0.047, hit="aft_service")
    for side in (-1, 1):
        for z in (0.95, 1.82):
            screw("Captive lid screw", (side * 0.75, 2.741, z), Y, 0.068)
        pipe("Amber removable handling grip", [(side*0.84,2.61,0.80),(side*0.84,2.75,0.70),
             (side*0.57,2.75,0.70),(side*0.53,2.65,0.76)], 0.052, "amber")
        # Pair of return stubs mates with the depot's existing utility block behind the rails.
        pipe("Keyed coolant return elbow", [(side * 0.48, 2.41, 0.94), (side * 0.48, 2.84, 0.86),
             (side * 0.48, 2.97, 0.66), (side * 0.48, 2.97, 0.34)], 0.093, "alloy", clamp=(1,))
        turned("Utility collar over capped depot service port", (side*0.48,2.97,0.32), UP,
               [(0, 0.174), (0.12, 0.174), (0.17, 0.115)], "frame", sides=16, hit=f"coolant_{side}")


def radiator():
    box("Radiator outer frame", (0, -0.13, 3.44), (2.70, 3.42, 0.37), "frame",
        bevel=0.088, hit="radiator")
    box("Radiator coated backing", (0, -0.13, 3.635), (2.38, 3.07, 0.06), "graphite", bevel=0.019)
    count = (34, 21, 11)[depot.lod]
    for i in range(count):
        y = -1.56 + (i + 0.5) * 2.86 / count
        box("Aluminium heat rejection fin", (0, y, 3.705), (2.31, 0.038, 0.106), "radiator", bevel=0.012)
    for side in (-1, 1):
        for y in (-1.22, 1.02):
            box("Radiator cradle foot", (side * 0.74, y, 3.12), (0.37, 0.38, 0.39), "alloy",
                bevel=0.069, hit=f"radiator_mount_{side}_{y}")
            screw("Heat panel retaining screw", (side * 1.10, y, 3.624), UP, 0.053)
    for sign in (-1, 1):
        pipe("Radiator coolant elbow", [(0,-0.13+sign*1.46,3.44), (0,-0.13+sign*1.82,3.44),
             (0,-0.13+sign*1.99,3.37), (0,-0.13+sign*2.12,3.22),
             (0,-0.13+sign*2.12,2.75), (0,-0.13+sign*2.12,2.18)],
             0.14, "alloy", clamp=(1, 4), hit=f"radiator_elbow_{sign}")


if __name__ == "__main__":
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.unit_settings.system = "METRIC"
    bpy.context.preferences.filepaths.save_version = 0
    proxy = depot.collection("COLLISION")
    depot.proxy_sources = defaultdict(list)
    depot.sector_samples = {}
    depot.materials = {name: depot.material(name, colour, rough, metal)
                       for name, (colour, rough, metal) in depot.FINISHES.items()}
    trims = [depot.material(f"Refinery ceramic and hardware trim {i}", (0.47,0.39,0.32), 0.58)
             for i in range(3)]
    depot.station_trim(trims)

    for lod, trim in enumerate(trims):
        depot.lod = lod
        depot.parts = depot.collection("Refinery editable assemblies" if lod == 0 else f"LOD{lod} construction")
        depot.export = depot.collection(f"EXPORT_LOD{lod}")
        skid()
        processing_vessel()
        service_units()
        radiator()
        bpy.context.view_layer.update()
        if lod == 0:
            depot.collision(proxy)
        depot.batch(trim)
        if lod != 0:
            for obj in list(depot.parts.objects):
                bpy.data.objects.remove(obj, do_unlink=True)
            bpy.data.collections.remove(depot.parts)
    path = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
    bpy.ops.wm.save_as_mainfile(filepath=str(path))
