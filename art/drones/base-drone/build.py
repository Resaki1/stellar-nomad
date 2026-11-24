"""Base utility drone. One Blender unit is one metre; -Y faces forward."""
import sys
from collections import defaultdict
from pathlib import Path

import bpy

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "stations" / "base-depot"))
import build as depot
from build import X, Y, UP, beam, box, loft, pipe, turned


def hull_outline(y, width, bottom, top, corner):
    return [(x, y, z) for x, z in (
        (-width+corner, bottom), (-width,bottom+corner), (-width,top-corner), (-width+corner,top),
        (width-corner,top), (width,top-corner), (width,bottom+corner), (width-corner,bottom),
    )]


def screw(name, at, axis, radius, *, depth=0.027):
    if depot.lod == 0:
        turned(name, at, axis, [(-0.005,radius), (depth,radius*0.83)], "alloy", sides=6)


def nose():
    # Replaceable ceramic armor over a smaller closed optics and electronics enclosure.
    loft("Armored avionics and mining head", [
        hull_outline(-2.04,0.68,-0.60,0.45,0.15),
        hull_outline(-1.83,0.89,-0.78,0.66,0.20),
        hull_outline(-1.28,1.00,-0.83,0.89,0.22),
        hull_outline(-0.70,1.00,-0.83,0.89,0.22),
        hull_outline(-0.53,0.91,-0.77,0.81,0.20),
    ], "ceramic", bevel=0.032, hit="nose")
    loft("Safety band around optics bulkhead", [
        hull_outline(-1.25,1.018,-0.847,0.907,0.22),
        hull_outline(-1.15,1.018,-0.847,0.907,0.22),
    ], "amber")
    box("Plated access cover", (0,-0.86,0.92), (1.30,0.43,0.075), "patched", bevel=0.032, hit="nose")
    if depot.lod < 2:
        slope = depot.Vector((0,0.55,0.23)).normalized()
        normal = X.cross(slope)
        box("Sloped avionics shield", (0,-1.567,0.788), (1.14,0.43,0.044), "patched",
            corner=0.02, bevel=0.021, basis=(X,slope,normal))
        for side in (-1,1):
            for along in (-0.147,0.142):
                screw("Flush nose access bolt", depot.Vector((side*0.47,-1.567,0.805))
                      + along*slope, normal, 0.026, depth=0.017)
            basis = (side * -Y,side * X,UP)
            box("Cheek avionics access plate", (side*0.995,-0.92,0.02), (0.35,0.042,0.94),
                "patched", bevel=0.017, basis=basis)
            for y in (-1.034,-0.806):
                for z in (-0.333,0.365):
                    screw("Captive cheek screw", (side*1.014,y,z), side*X, 0.022, depth=0.014)
    box("Forward tool face casting", (0,-2.048,-0.02), (1.27,0.19,0.95), "frame",
        corner=0.14, bevel=0.067, hit="nose")
    turned("Mining optics retaining ring", (0,-2.147,0.05), -Y,
           [(-0.02,0.32),(0.035,0.32),(0.083,0.266),(0.083,0.208),(0.018,0.190)],
           "alloy", sides=24, closed=True, hit="nose")
    turned("Recessed mining lens", (0,-2.192,0.05), -Y,
           [(0,0.201),(0.011,0.173),(0.016,0.132)], "optic", sides=24)
    turned("Survey camera below the tool", (0,-2.147,-0.345), -Y,
           [(0,0.094),(0.042,0.084)], "optic", sides=12)
    depot.socket("mining", (0,-2.234,0.05), -Y)
    for side in (-1, 1):
        x = side * 0.462
        box("Ready lamp seat", (x,-2.146,0.19), (0.14,0.052,0.18), "graphite", bevel=0.022)
        box("Steady amber window", (x,-2.173,0.19), (0.09,0.035,0.118), "status" if depot.lod < 2 else "amber", bevel=0.012)
        lamp(f"ready_{side}", (x,-2.192,0.19), -Y, "drone_status", 0.09*0.118, 0.105)
        if depot.lod == 0:
            for y in (-1.053,-0.674):
                screw("Captive hatch screw", (side*0.58,y,0.95), UP, 0.043)
            screw("Front replaceable tool fastener", (side*0.43,-2.139,-0.337), -Y, 0.044)
    if depot.lod < 2:
        pipe("Amber-marked nose handling bail", [(-0.54,-1.95,-0.48),(-0.54,-2.07,-0.75),
             (-0.45,-2.09,-0.80),(0.45,-2.09,-0.80),(0.54,-2.07,-0.75),(0.54,-1.95,-0.48)],
             0.043, "alloy", hit="front_handle")
        beam("Grip over handling bail", (-0.26,-2.09,-0.80),(0.26,-2.09,-0.80),0.11,0.10,"amber")


def cargo_pod():
    # A sealed exchange cassette between open load paths, with a marked loading collar on each flank.
    box("Exchange cassette", (0,0.42,-0.06), (1.38,1.94,1.27), "graphite", corner=0.19,
        bevel=0.10, hit="cargo")
    box("Isolated avionics and power enclosure", (0,1.70,0.05), (1.72,0.53,1.62), "ceramic",
        corner=0.21, bevel=0.066, hit="aft")
    if depot.lod < 2:
        box("Ventral removable skid plate", (0,0.44,-0.73), (1.25,1.50,0.13), "frame",
            corner=0.065, bevel=0.028, hit="cargo")
        box("Inset belly cassette cover", (0,0.42,-0.805), (0.96,1.17,0.054), "patched",
            corner=0.024, bevel=0.018, hit="cargo")
        box("Aft power bus maintenance plate", (0,1.977,0.306), (1.21,0.084,0.36), "patched",
            corner=0.074, bevel=0.022, hit="aft")
        for side in (-1,1):
            for y in (-0.008,0.85):
                screw("Ventral plate fastener", (side*0.403,y,-0.831), -UP, 0.026, depth=0.016)
            screw("Power bus retaining bolt", (side*0.46,2.018,0.39), Y, 0.033, depth=0.017)
    box("Cooling spine backing", (0,0.59,0.65), (0.90,1.71,0.13), "frame", bevel=0.034)
    for i in range((8,5,3)[depot.lod]):
        box("Waste-heat rejection slat", (0,0.01+i*1.17/((8,5,3)[depot.lod]-1),0.739),
            (0.79,0.080,0.080), "radiator", bevel=0.014)
    for side in (-1, 1):
        x = side * 0.89
        for z in (-0.67,0.68):
            box("Longitudinal truss chord", (x,0.52,z), (0.16,2.34,0.16), "frame",
                bevel=0.022, hit=f"rail_{side}_{z}")
            for y in ((-0.55,1.55) if depot.lod < 2 else ()):
                box("Truss flange", (x,y,z), (0.27,0.29,0.22), "alloy", bevel=0.033)
        beam("Upper corner lateral brace", (side*0.86,-0.53,0.725),(side*0.46,-0.06,0.725),
             0.117,0.093,"frame",bevel=0.014)
        beam("Aft upper lateral brace", (side*0.46,1.05,0.725),(side*0.86,1.53,0.725),
             0.117,0.093,"frame",bevel=0.014)
        for y in (-0.48,1.45):
            beam("External frame upright", (x,y,-0.67),(x,y,0.68), 0.14, 0.14, "frame",
                 bevel=0.018, hit=f"upright_{side}_{y}")
        beam("Diagonal bracing", (x,-0.40,-0.60),(x,1.38,0.60),0.12,0.124,"frame",
             bevel=0.016, hit=f"diagonal_{side}")
        # Flat-sided cargo collar. The keys and lid open on the side of the frame.
        basis = (side * -Y,side * X,UP)
        box("Cassette loading support", (side*0.84,0.55,-0.08),(1.26,0.36,1.03),"ceramic",
            corner=0.18, bevel=0.042, basis=basis, hit=f"cargo_hatch_{side}")
        box("Amber cargo seal seat", (side*1.034,0.55,-0.08),(1.05,0.129,0.84),"amber",
            corner=0.15, bevel=0.030, basis=basis, hit=f"cargo_hatch_{side}")
        box("Inset pressure door", (side*1.096,0.55,-0.08),(0.86,0.040,0.66),"graphite",
            corner=0.12, bevel=0.022, basis=basis)
        if depot.lod < 2:
            box("Inset loading door reinforcing plate", (side*1.119,0.44,-0.094),
                (0.47,0.020,0.41), "frame", corner=0.052, bevel=0.013, basis=basis)
            for y in (0.14,0.96):
                for z in (-0.355,0.192):
                    screw("Seated seal-retainer screw", (side*1.097,y,z), side*X, 0.025, depth=0.016)
        box("Raised loading latch", (side*1.125,0.79,-0.08),(0.11,0.078,0.40),"alloy",
            bevel=0.023, basis=basis)
        depot.socket("cargo_port" if side == 1 else "cargo_starboard",
                     (side*1.185,0.55,-0.08), side*X)
        if depot.lod < 2:
            for z in (-0.26,-0.04,0.18):
                pipe("Supported accumulator supply line", [(side*0.72,-0.67,z),
                     (side*0.985,-0.53,z), (side*1.003,-0.25,z), (side*0.84,0.02,z)],
                     0.047, "tank" if z < -0.1 else "alloy")
            box("Access plate at aft shoulder", (side*0.82,1.64,0.47),
                (0.17,0.33,0.34), "patched", bevel=0.035)


def propulsion():
    # Small feed vessels sit inboard. Opaque nozzle throats close each exhaust path.
    for side in (-1, 1):
        x = side*0.646
        turned("Propellant reserve cylinder", (x,0.83,0.42), Y,
               [(-0.79,0.19),(-0.68,0.274),(0.62,0.274),(0.75,0.18)],"tank",sides=16,hit=f"feed_{side}")
        turned("Main drive pressure housing", (side*0.51,1.84,-0.26), Y,
               [(-0.09,0.34),(0.15,0.38),(0.35,0.35)],"frame",sides=24,hit=f"drive_{side}")
        turned("Heat-resistant drive bell", (side*0.51,2.05,-0.26),Y,
               [(0,0.31),(0.16,0.354),(0.23,0.33),(0.23,0.276),(0.063,0.202)],
               "alloy",sides=24,closed=True,hit=f"drive_{side}")
        turned("Capped refractory chamber", (side*0.51,2.06,-0.26),Y,
               [(0,0.219),(0.082,0.219)],"graphite",sides=16)
        depot.socket("engine_port" if side == 1 else "engine_starboard", (side*0.51,2.285,-0.26),Y)
        for y,z in ((-0.54,-0.62),(-0.54,0.56),(1.56,-0.62)):
            if depot.lod == 2:
                box("Distant reaction-control pack", (side*1.16,y-0.026,z-0.025),
                    (0.45,0.50,0.46 if z > 0 else 0.534), "patched", corner=0.08)
                continue
            key = f"rcs_{side}_{y}_{z}"
            box("Reaction-control shield", (side*1.075,y,z), (0.47,0.43,0.44), "patched",
                bevel=0.044, corner=0.08, hit=key)
            for axis in (-Y, side*X):
                turned("Recessed maneuvering jet", (side*1.075+axis.x*0.205,y+axis.y*0.174,z),axis,
                       [(0,0.123),(0.105,0.142),(0.105,0.096),(0.027,0.075)],
                       "alloy",sides=12,closed=True,hit=key)
            if z < 0:
                turned("Ventral maneuvering jet", (side*1.075,y,z-0.192),-UP,
                       [(0,0.133),(0.104,0.14),(0.104,0.09),(0.03,0.065)],
                       "frame",sides=12,closed=True,hit=key)


def lamp(name, position, direction, emitter, area, size, blink=0, cosine=1):
    name = "light_" + name
    obj = bpy.data.objects.get(name)
    if obj is None:
        obj = bpy.data.objects.new(name, None)
        obj.location = position
        obj.rotation_euler = direction.to_track_quat("-Y","Z").to_euler()
        obj.empty_display_size = 0.12
        obj["emitter"] = emitter
        obj["area_m2"] = area
        obj["size_m"] = size
        obj["blink"] = blink
        obj["cosine"] = cosine
    depot.export.objects.link(obj)


def power_and_lamps():
    for side in (-1, 1):
        y = 1.46
        key = f"wing_{side}"
        box("Wing root anchored to aft bulkhead", (side*1.01,y,0.78), (0.59,0.50,0.31), "frame",
            bevel=0.042, hit=f"hinge_{side}")
        turned("Solar deployment hinge", (side*1.24,y-0.36,0.83),Y,
               [(0,0.11),(0.12,0.15),(0.59,0.15),(0.72,0.11)],"alloy",sides=16,hit=f"hinge_{side}")
        inner, outer = 1.29, 2.98
        span = outer - inner
        center = (inner+outer)*0.5
        box("Wing honeycomb tray", (side*center,y,0.824), (span,1.11,0.095), "radiator",
            bevel=0.016, hit=key)
        for dy in (-0.525,0.525):
            box("Coverglass perimeter rail", (side*center,y+dy,0.875),(span,0.062,0.055),
                "alloy", bevel=0.009, hit=key)
        for x in ((inner+0.045,center,outer-0.045) if depot.lod < 2 else (inner+0.045,outer-0.045)):
            box("Array edge or center splice", (side*x,y,0.876),(0.068,0.99,0.055),
                "alloy", bevel=0.009,hit=key)
        for s in ((-1,1) if depot.lod < 2 else (0,)):
            x = side*center+s*span*0.237
            w = span*0.25-0.046 if s else span*0.5-0.08
            obj = depot.mesh("Encapsulated silicon cells", [(x-w,y-0.492,0.880),(x+w,y-0.492,0.880),
                             (x+w,y+0.492,0.880),(x-w,y+0.492,0.880)],[(0,1,2,3)],"pv")
            uv = obj.data.uv_layers.new(name="Solar cells")
            for i, coord in enumerate(((0,0),(1,0),(1,1),(0,1))):
                uv.data[i].uv = coord
        for dy in (-0.52,0.52):
            box("Wing-tip handling marker", (side*(outer-0.076),y+dy,0.895), (0.146,0.082,0.042),
                "amber", bevel=0.009,hit=key)
        x = side * 0.72
        at = (x,1.48,0.82)
        turned("Beacon antenna mount and mast", at, UP,
               [(0,0.105),(0.16,0.105),(0.22,0.046),(0.64,0.030),(0.75,0.043)],
               "alloy",sides=10,hit=f"mast_{side}")
        turned("Amber omnidirectional beacon capsule", at, UP,
               [(0.71,0.054),(0.83,0.054),(0.867,0.034)],"beacon" if depot.lod < 2 else "amber",sides=12,hit=f"mast_{side}")
        lamp(f"beacon_{side}", (x,1.48,1.665),UP,"drone_beacon",0.012,0.108,blink=1,cosine=0)


if __name__ == "__main__":
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.unit_settings.system = "METRIC"
    bpy.context.preferences.filepaths.save_version = 0
    proxy = depot.collection("COLLISION")
    depot.proxy_sources = defaultdict(list)
    depot.sector_samples = {}
    depot.FINISHES["optic"] = ((0.019,0.028,0.044),0.19,0.14)
    depot.materials = {name: depot.material(name, color, rough, metal)
                       for name,(color,rough,metal) in depot.FINISHES.items()}
    depot.materials["status"] = depot.material("Amber drone status",(0.30,0.106,0.012),0.32,emissive=2)
    depot.materials["beacon"] = depot.material("Amber drone beacon",(0.34,0.095,0.008),0.30,emissive=4)
    trims = [depot.material(f"Drone hardware trim {i}",(0.51,0.42,0.34),0.58) for i in range(3)]
    glass = [depot.material(f"Drone photovoltaic coverglass {i}",(0.025,0.042,0.067),0.18) for i in range(3)]
    depot.station_trim(trims)
    depot.photovoltaic(glass)
    for level, (trim, pv) in enumerate(zip(trims, glass)):
        depot.lod = level
        depot.parts = depot.collection("Drone editable assemblies" if level == 0 else f"LOD{level} construction")
        depot.export = depot.collection(f"EXPORT_LOD{level}")
        depot.materials["pv"] = pv
        nose()
        cargo_pod()
        propulsion()
        power_and_lamps()
        bpy.context.view_layer.update()
        if level == 0:
            depot.collision(proxy)
        depot.batch(trim)
        if level != 0:
            for obj in list(depot.parts.objects):
                bpy.data.objects.remove(obj, do_unlink=True)
            bpy.data.collections.remove(depot.parts)
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == "VIEW_3D":
                space = area.spaces.active
                space.overlay.show_floor = False
                space.shading.color_type = "MATERIAL"
                space.region_3d.view_rotation = depot.Vector((0.9,-1,0.65)).to_track_quat("Z","Y")
                space.region_3d.view_distance = 9
    path = Path(sys.argv[sys.argv.index("--")+1]).resolve()
    bpy.ops.wm.save_as_mainfile(filepath=str(path))
