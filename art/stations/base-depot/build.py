"""Editable base orbital depot and fitted static proxy. Blender metres, -Y docking, +Z up."""
import math
import sys
from collections import defaultdict
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "replication-r4"))
from finishes import FINISHES, photovoltaic, station_trim

X, Y, UP = (Vector(a) for a in ((1,0,0),(0,1,0),(0,0,1)))
DOCK = -Y
DOCK_FACE = -20.4
BAYS = (-14.0, -7.2, -0.4, 6.5, 13.05)
ARRAY_Y = 15.5
ARRAY_HALF_SPAN = 13.25
REFINERY_MOUNT = (0, 9.8, 3.39)


def collection(name):
    c = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(c)
    return c


def material(name, color, rough, metal=0, emissive=0):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    if m.node_tree is None:
        m.use_nodes = True
    shader = m.node_tree.nodes["Principled BSDF"]
    shader.inputs["Base Color"].default_value = m.diffuse_color
    shader.inputs["Roughness"].default_value = rough
    shader.inputs["Metallic"].default_value = metal
    if emissive:
        shader.inputs["Emission Color"].default_value = m.diffuse_color
        shader.inputs["Emission Strength"].default_value = emissive
    return m


def mesh(name, verts, faces, finish, *, bevel=0, hit=None, smooth=False):
    data = bpy.data.meshes.new(name)
    data.from_pydata(verts, [], faces)
    data.update()
    for p in data.polygons:
        p.use_smooth = smooth and len(p.vertices) == 4
    obj = bpy.data.objects.new(name, data)
    parts.objects.link(obj)
    data.materials.append(materials[finish])
    if bevel and (lod == 0 or (lod == 1 and bevel >= 0.09)):
        edge = obj.modifiers.new("Manufactured radius", "BEVEL")
        edge.width = bevel
        edge.segments = 2 if lod == 0 and bevel >= 0.09 else 1
        edge.harden_normals = True
        normals = obj.modifiers.new("Weighted face normals", "WEIGHTED_NORMAL")
        normals.keep_sharp = True
    if hit and lod == 0:
        proxy_sources[hit].append(obj)
    return obj


def loft(name, rings, finish, *, closed=False, **kwargs):
    n = len(rings[0])
    layers = len(rings)
    faces = [] if closed else [tuple(reversed(range(n)))]
    for layer in range(layers if closed else layers-1):
        a, b = layer*n, ((layer+1) % layers)*n
        for i in range(n):
            j = (i+1) % n
            faces.append((a+i,a+j,b+j,b+i))
    if not closed:
        faces.append(tuple(range((layers-1)*n,layers*n)))
    return mesh(name, [p for ring in rings for p in ring], faces, finish, **kwargs)


def box(name, center, size, finish, *, bevel=0.042, hit=None, corner=0, basis=(X,Y,UP)):
    x,y,z = (v/2 for v in size)
    if corner:
        c = min(corner, x*0.82, z*0.82)
        outline = [(-x+c,-z),(-x,-z+c),(-x,z-c),(-x+c,z),
                   (x-c,z),(x,z-c),(x,-z+c),(x-c,-z)]
    else:
        outline = [(-x,-z),(-x,z),(x,z),(x,-z)]
    a,b,d = basis
    center = Vector(center)
    return loft(name, [[center+u*a+v*b+w*d for u,w in outline] for v in (-y,y)],
                finish, bevel=bevel, hit=hit)


def beam(name, a, b, width, height, finish, *, bevel=0.045, hit=None):
    a,b = Vector(a),Vector(b)
    axis = (b-a).normalized()
    right = axis.cross(UP)
    if right.length_squared < 0.001:
        right = axis.cross(Y)
    right.normalize()
    return box(name, (a+b)*0.5, (width,(b-a).length,height), finish, bevel=bevel,
               hit=hit, basis=(right,axis,right.cross(axis)))


def turned(name, at, axis, profile, finish, *, sides=24, phase=0, closed=False, hit=None, sectors=1):
    sides = min(sides, (40, 16, 8)[lod])
    origin = Vector(at)
    axis = Vector(axis).normalized()
    a = axis.orthogonal().normalized()
    b = axis.cross(a)
    ring = [math.cos(phase+i*math.tau/sides)*a+math.sin(phase+i*math.tau/sides)*b for i in range(sides)]
    rings = [[origin+axis*d+v*r for v in ring] for d,r in profile]
    if sectors > 1 and lod == 0:
        # Each wedge hugs its part of the lip. The mouth stays open down to the backing plate.
        step = sides // sectors
        for i in range(sectors):
            first, last = i*step, (i+1)*step
            samples = [r[j % sides] for r in rings for j in range(first, last+1)]
            # Overlap the hidden wedge ends by about 2 cm to avoid coincident caps.
            samples.extend(r[first].lerp(r[(first-1) % sides],0.03) for r in rings)
            sector_samples[f"{hit}_{i}"] = samples
        hit = None
    return loft(name, rings, finish, closed=closed, hit=hit, smooth=sides >= 20)


def pipe(name, path, size, finish, *, clamp=(), hit=None):
    """Sweep a joined tube through bent, supported runs without intersecting caps."""
    sides = 10 if lod == 0 else 6
    points = list(map(Vector, path))
    rings = []
    previous = None
    for i, p in enumerate(points):
        tangent = (points[min(i+1,len(points)-1)]-points[max(i-1,0)]).normalized()
        axis = tangent.orthogonal().normalized() if previous is None else (previous-tangent*previous.dot(tangent)).normalized()
        cross = tangent.cross(axis)
        rings.append([p+size*(math.cos(j*math.tau/sides)*axis+math.sin(j*math.tau/sides)*cross) for j in range(sides)])
        previous = axis
        if lod == 0 and i in clamp:
            turned("Swaged line collar", p, tangent, [(-0.12,size*1.42),(0.12,size*1.42)], "alloy", sides=10)
    return loft(name, rings, finish, hit=hit)


def socket(name, position, direction):
    name = "socket_" + name
    if existing := bpy.data.objects.get(name):
        export.objects.link(existing)
        return
    obj = bpy.data.objects.new(name,None)
    export.objects.link(obj)
    obj.location = position
    obj.rotation_euler = Vector(direction).to_track_quat("-Y","Z").to_euler()
    obj.empty_display_type = "ARROWS"
    obj.empty_display_size = 0.9


def screw(name, at, axis, radius=0.099):
    if lod == 0:
        turned(name, at, axis, [(0,radius), (0.055,radius*0.84)], "alloy", sides=6)


def truss():
    for s in (-1,1):
        x = s*3.34
        for z in (-2.57,2.57):
            key = f"longeron_{s}_{z}"
            beam("Drawn alloy longeron", (x,BAYS[0]-0.34,z), (x,BAYS[-1]+0.35,z), 0.54, 0.61, "frame", hit=key)
            if lod < 2:
                beam("Protected longeron wear rail", (x+s*0.24,BAYS[0]-0.20,z+0.04),
                 (x+s*0.24,BAYS[-1]+0.20,z+0.04), 0.13, 0.24, "alloy", bevel=0.022, hit=key)
        for y in BAYS:
            key = f"upright_{s}_{y}"
            beam("Gusseted truss upright", (x,y,-2.6),(x,y,2.6), 0.50, 0.57, "frame", hit=key)
            for z in (-2.57,2.57):
                box("Structural node shoe", (x,y,z), (1.09,1.02,0.93), "alloy", bevel=0.081, hit=key)
                if lod == 0:
                    box("Removable gusset cover", (x+s*0.55,y,z), (0.11,0.69,0.48), "frame", bevel=0.042)
                for dy in (-0.23,0.23):
                    screw("Gusset lockbolt", (x+s*0.61,y+dy,z), X*s)
        for i,(a,b) in enumerate(zip(BAYS,BAYS[1:])):
            # Put the two brace runs on different flange planes. Both meet the centre splice.
            beam("Tension brace", (x+s*0.13,a+0.28,-2.52), (x+s*0.13,b-0.28,2.52), 0.30, 0.34, "frame",
                 hit=f"braceA_{s}_{i}")
            beam("Compression brace", (x-s*0.24,a+0.28,2.52), (x-s*0.24,b-0.28,-2.52), 0.32, 0.34, "frame",
                 hit=f"braceB_{s}_{i}")
            if lod < 2:
                box("Replaceable cross-brace splice", (x,(a+b)/2,0), (0.72,0.75,0.72), "alloy", bevel=0.10)
    for y in BAYS:
        for z in (-2.57,2.57):
            beam("Cross frame I-section", (-3.36,y,z),(3.36,y,z), 0.56, 0.52, "frame", hit=f"cross_{y}_{z}")
    for a,b in ((BAYS[0],BAYS[1]),(BAYS[-2],BAYS[-1])):
        for z in (-2.51,2.48):
            beam("Diagonal deck tie", (-3.32,a,z),(3.32,b,z), 0.38, 0.40, "frame", hit=f"deck_tie_{a}_{z}")
    beam("Armoured utility raceway", (0,-14.63,0.31),(0,13.9,0.31), 1.42, 0.67, "graphite", hit="raceway")
    for s in (-1,1):
        x = s*2.83
        if lod < 2:
            pipe("Feed and return line along keel", [(x,-14.4,-2.07),(x,-12.8,-2.07),(x,-3.7,-2.07),
             (x,4.8,-2.07),(x,10.8,-2.07),(x-s*0.28,12.0,-1.79),(x-s*0.28,13.85,-1.30)],
             0.118,"alloy",clamp=(1,2,3,4))


def cassette(side):
    name = "dorsal" if side > 0 else "ventral"
    bottom, top = side*2.96, side*4.78
    z = (bottom+top)/2
    spacing = 4.16
    box("Low-profile cargo cassette shell", (0,-2.10,z), (7.28,12.95,abs(top-bottom)),
        "ceramic", bevel=0.185, hit=name, corner=0.34)
    box("Cassette capture shoe", (0,-2.10,side*2.98), (6.76,12.50,0.46),
        "frame", bevel=0.12, hit=name)
    for i in range(-1,2):
        y = -2.10+i*spacing
        box("Replaceable cassette lid", (0,y,side*4.79), (6.52,4.02,0.24),
            "patched" if (i == 1 and side > 0) or (i == -1 and side < 0) else "ceramic",
            bevel=0.070, hit=name)
        if lod < 2:
            box("Gasketed service cover", (-1.74,y-0.25,side*4.936), (1.78,1.05,0.058),
            "frame", bevel=0.022)
        for s in (-1,1):
            a = (s*2.74,y-1.78,side*4.92)
            b = (s*2.74,y+1.78,side*4.92)
            screw("Lid captive bolt", a, UP*side)
            screw("Lid captive bolt", b, UP*side)
    for s in (-1,1):
        for y in (-7.17,2.88):
            x = s*3.18
            box("Container lifting socket", (x,y,side*4.92), (0.74,1.22,0.23),
                "frame", bevel=0.046)
            for dy in ((-0.36,0.36) if lod < 2 else ()):
                beam("Handle riser", (x,y+dy,side*4.93), (x,y+dy,side*5.18), 0.16,0.16,"alloy")
            beam("Amber lift bar", (x,y-0.43,side*5.18),(x,y+0.43,side*5.18),0.16,0.15,"amber",hit=name)
            box("Cassette capture latch", (s*3.69,y,side*3.78), (0.32,1.16,0.80), "alloy", bevel=0.071, hit=name)


def tanks():
    for s in (-1,1):
        label = f"tank_{s}"
        x = s*5.98
        origin = (x,0,-0.12)
        turned("Closed metal pressure vessel", origin, Y, [
            (-9.05,0.40),(-8.85,0.92),(-8.42,1.60),(-7.92,1.96),(-7.28,2.18),(-6.62,2.26),
            (6.63,2.26),(7.26,2.18),(7.92,1.96),(8.42,1.60),(8.88,0.92),(9.08,0.40),
        ], "alloy", sides=32, hit=label)
        # Replaceable thermal/impact jacket with narrow circumferential split lines.
        stations = (-6.65,-4.31,-2.17,0.03,2.20,4.32,6.66) if lod < 2 else (-6.65, 6.66)
        for i,(lo,hi) in enumerate(zip(stations,stations[1:])):
            turned("Thermal jacket segment", origin,Y, [
                (lo+0.026,2.275),(lo+0.089,2.323),(hi-0.089,2.323),(hi-0.026,2.276)
            ], "patched" if i == (2 if s > 0 else 4) else "ceramic", sides=32)
        for y in (-7.12,6.93):
            turned("Head seam and high-pressure marking", origin,Y,
                   [(y-0.20,2.26),(y-0.15,2.309),(y+0.15,2.309),(y+0.20,2.26)],
                   "amber",sides=32,hit=label)
        for y in (-5.35,5.30):
            turned("Clamped metal tank restraint", origin,Y,
                   [(y-0.32,2.33),(y-0.27,2.405),(y+0.27,2.405),(y+0.32,2.33)],
                   "frame",sides=32,hit=label)
            for z in (-1.8,1.62):
                key = f"tank_support_{s}_{y}_{z}"
                beam("Shock-isolated tank cradle", (s*3.36,y,z*1.25),(s*5.12,y,z),
                     0.54,0.56,"frame",bevel=0.095,hit=key)
                if lod < 2:
                    box("Cradle locating lug", (s*4.34,y,z), (0.76,0.84,0.68), "alloy", bevel=0.088, hit=key)
                screw("Cradle anchor", (s*4.37,y,z+(0.36 if z>0 else -0.36)), UP if z>0 else -UP, 0.15)
        for sign in (-1,1):
            direction = Y*sign
            y = sign*9.02
            turned("Ceramic end-head shield", origin, direction, [
                (7.31,2.230),(7.46,2.201),(7.95,2.024),(8.45,1.644),
                (8.88,1.005),(8.98,0.760),
            ], "ceramic", sides=32, hit=label)
            turned("Machined valve mounting flange", origin, direction, [(8.97,0.68),(9.07,0.69),(9.15,0.55)],
                   "alloy", sides=24, hit=label)
            turned("Tank dry-break end boss", (x,y,-0.12),direction,
                   [(0,0.63),(0.13,0.62),(0.18,0.38),(0.48,0.38)], "frame",sides=16,hit=label)
            turned("Sealed tank transfer valve", (x,y,-0.12),direction,[(0.48,0.27),(0.58,0.24)],
                   "alloy",sides=12,hit=label)
            end = [x,sign*9.56,-0.42]
            if lod < 2:
                pipe("Tank service feed to main truss",
                 [end,(x-s*0.08,sign*9.77,-0.68),(x-s*0.43,sign*9.81,-0.82),
                  (s*3.61,sign*9.81,-0.82),(s*3.11,sign*9.72,-1.11),(s*2.94,sign*9.46,-1.58)],
                 0.152,"tank",clamp=(1,3))
        # Vertical fastener rows follow the actual curved skin.
        for y in (-4.33,0.06,4.34):
            for angle in (0.21,0.77,1.33,2.11,2.82,3.77,4.51,5.29):
                normal = Vector((math.cos(angle),0,math.sin(angle)))
                at = Vector((x,y,-0.12)) + normal*2.322
                screw("Thermal jacket quarter-turn stud", at, normal, 0.061)


def docking():
    connection = (0,-13.53,0)
    turned("Eight-sided transfer neck", connection, DOCK,
           [(0,3.10),(0.46,3.20),(4.23,2.88),(5.14,3.07)], "frame", sides=8, phase=math.pi/8, hit="transfer_neck")
    turned("Machined collar support", (0,-17.94,0),DOCK,
           [(0,2.73),(0.43,3.06),(0.71,3.65),(1.13,3.8)], "alloy",sides=32,hit="dock_backing")
    collar = (0,DOCK_FACE,0)
    turned("Docking collar structural ring", collar,DOCK,
           [(-2.27,3.23),(-1.97,3.82),(-1.48,4.20),(-0.28,4.20),(0,3.92),
            (0,3.53),(-0.25,3.37),(-1.15,3.29),(-1.59,3.20)],
           "frame",sides=40,closed=True,hit="dock_lip",sectors=8)
    turned("Dock shock-isolator outer band", collar,DOCK,
           [(-1.70,3.98),(-1.64,4.23),(-1.39,4.24),(-1.37,4.04)],
           "alloy",sides=40,closed=True,hit="dock_backing")
    turned("Machined capture lip", collar,DOCK,
           [(-0.22,3.54),(-0.16,3.63),(-0.085,3.60),(-0.075,3.48),(-0.16,3.44),(-0.22,3.48)],
           "alloy",sides=40,closed=True)
    turned("Recessed sealed transfer bulkhead", collar,DOCK,
           [(-1.54,3.28),(-1.06,3.20),(-0.94,3.07)], "graphite",sides=32,hit="dock_backing")
    box("Chamfered docking interface plate", (0,DOCK_FACE+0.84,0), (4.18,0.35,4.03),
        "frame",bevel=0.12,hit="dock_backing",corner=0.55)
    for x in ((-0.87,0.87) if lod < 2 else ()):
        for z in (-0.82,0.82):
            at = (x,DOCK_FACE+0.65,z)
            turned("Recessed spring-loaded service fitting", at, DOCK,
                   [(0,0.45),(0.12,0.56),(0.22,0.50),(0.22,0.30),(0.11,0.25),(0.014,0.26)],
                   "alloy",sides=16,closed=True)
            turned("Dry-break dust shutter", at,DOCK,[(0.06,0.28),(0.095,0.26)],"graphite",sides=12)
            turned("Amber coupler index band", at,DOCK,
                   [(0.213,0.469),(0.237,0.469),(0.237,0.405),(0.213,0.405)],
                   "amber",sides=16,closed=True)
    for i in range(8):
        angle = i*math.tau/8
        radial = Vector((math.cos(angle),0,math.sin(angle)))
        tangent = Y.cross(radial)
        pose = Vector(collar) + Y*0.73 + radial*4.03
        box("Replaceable collar impact shoe", pose, (1.50,1.44,0.45), "ceramic" if i%2 == 0 else "patched",
            bevel=0.093, basis=(tangent,Y,radial), hit=f"collar_shoe_{i}")
        for displacement in (-0.50,0.50):
            screw("Collar outer shoe bolt", pose+radial*0.23+tangent*displacement, radial, 0.085)
        if i % 2 == 0:
            box("Retracted docking guide", Vector(collar)+Y*0.41+radial*3.18, (0.99,0.32,0.62),
                "alloy",bevel=0.075,basis=(tangent,Y,radial))
            box("Approach lamp", Vector(collar)+Y*0.234+radial*3.15, (0.35,0.063,0.19),
                "lamp",bevel=0.023,basis=(tangent,Y,radial))
    for s in ((-1,1) if lod < 2 else ()):
        for i,y in enumerate((-16.98,-15.41)):
            for z in (-0.94,0.94):
                at=(s*2.81,y,z)
                turned("Blanked service manifold port", at,X*s,
                       [(0,0.58),(0.33,0.58),(0.41,0.50)], "frame",sides=14,hit=f"side_ports_{s}")
                turned("Coupler service identification", at,X*s,
                       [(0.409,0.48),(0.467,0.48),(0.467,0.385),(0.409,0.385)],"amber",sides=14,closed=True)
                turned("Inset protective cap", at,X*s,[(0.39,0.385),(0.44,0.355)], "graphite",sides=12)
                if i == 0:
                    screw("Port release tab", (s*3.25,y+0.44,z), X*s, 0.08)


def bus_and_power():
    y = ARRAY_Y
    box("Aft avionics structural enclosure", (0,y,0), (6.72,4.35,5.25), "frame",
        bevel=0.235, corner=0.69, hit="bus")
    for z in (-2.51,2.55):
        box("Aft bus ceramic collar", (0,y,z), (7.13,4.48,0.94), "ceramic",
            bevel=0.128, corner=0.23, hit="bus")
    box("Aft service access hatch", (0,17.75,0), (4.09,0.31,3.31), "graphite",bevel=0.11,corner=0.45,hit="bus")
    for q in (range(7) if lod < 2 else (1,3,5)):
        box("Avionics heat pipe louver", (0,17.97,-1.22+q*0.405), (3.38,0.20,0.18), "radiator",bevel=0.035,hit="bus")
    for s in (-1,1):
        box("Aft electronics removable shielding", (s*3.44,y,0), (0.31,2.68,2.72),
            "patched",bevel=0.105,hit="bus")
        box("Telemetry lamp", (s*2.15,17.82,1.72), (0.49,0.13,0.18), "lamp",bevel=0.027)
        box("Refinery mount slide rail", (s*2.59,9.8,2.98), (0.66,6.68,0.43), "alloy",bevel=0.067,
            hit=f"mount_rail_{s}")
        for ly in (6.5,13.05):
            box("Rail foot tied into cross-frame", (s*2.59,ly,2.80), (0.79,0.59,0.38), "frame",
                bevel=0.058, hit=f"mount_rail_{s}")
        for ly in (7.49,12.11):
            box("Keyed module latch shoe", (s*2.59,ly,3.20), (0.85,0.59,0.38), "frame",bevel=0.055,
                hit=f"mount_rail_{s}")
            box("Module insertion index", (s*2.59,ly,3.397), (0.42,0.34,0.023), "amber",bevel=0.012)
        beam("Solar array deployment beam", (s*3.48,y,0.22),(s*5.63,y,0.22),0.86,0.74,"alloy",hit=f"array_boom_{s}")
        turned("Solar root hinge pin", (s*4.68,y-0.78,0.22),Y,
               [(0,0.39),(0.15,0.47),(1.41,0.47),(1.56,0.39)],"frame",sides=16,hit=f"array_boom_{s}")
        start, end = 5.30, ARRAY_HALF_SPAN
        span = end-start
        center = (end+start)/2
        key = f"solar_{s}"
        box("PV honeycomb backing", (s*center,y,0.20), (span,3.20,0.30), "radiator",bevel=0.040,hit=key)
        for sy in (-1,1):
            box("Array perimeter channel", (s*center,y+sy*1.56,0.33), (span,0.16,0.27), "alloy",bevel=0.029,hit=key)
        for x in (start+0.094, center, end-0.094):
            box("PV module frame or splice", (s*x,y,0.33), (0.18,3.21,0.27), "alloy",bevel=0.025,hit=key)
        for side in (-1,1):
            x = s*center+side*span/4
            w = span/4-0.081
            obj = mesh("Cells under silica coverglass", [(x-w,y-1.48,0.382),(x+w,y-1.48,0.382),
                        (x+w,y+1.48,0.382),(x-w,y+1.48,0.382)], [(0,1,2,3)], "pv")
            uv = obj.data.uv_layers.new(name="Solar cells")
            for i,p in enumerate(((0,0),(1,0),(1,1),(0,1))):
                uv.data[i].uv=p
        for sy in ((-1,1) if lod == 0 else ()):
            box("Solar outer corner marker", (s*(end-0.24),y+sy*1.48,0.457), (0.46,0.28,0.09),
                "amber",bevel=0.024)
    box("Refinery bus data and coolant disconnect", (0,12.77,2.91), (1.75,0.47,0.91),
        "frame",bevel=0.086,hit="upgrade_bus")
    for x in (-0.48,0.48):
        turned("Capped module coolant connector", (x,12.77,3.35),UP,
               [(0,0.22),(0.28,0.22),(0.36,0.17)],"alloy",sides=12,hit="upgrade_bus")


def comms():
    base = Vector((-1.24,15.13,3.0))
    pointing = Vector((-0.27,0.47,0.84)).normalized()
    hub = base+UP*1.16
    support = hub-pointing*0.47
    turned("Dish foundation", base,UP,[(0,0.51),(0.20,0.47),(0.78,0.24)],"alloy",sides=16,hit="dish")
    beam("Offset elevation yoke", base+UP*0.56,support,0.40,0.37,"frame",hit="dish")
    turned("Reflector back mount", hub,pointing,[(-0.67,0.26),(-0.05,0.18)],"alloy",sides=12,hit="dish")
    turned("Aluminium parabolic reflector", hub,pointing,
           [(-0.07,0.13),(0.01,0.51),(0.16,0.91),(0.35,1.32),(0.405,1.34),
            (0.417,1.28),(0.25,0.91),(0.105,0.52),(0.018,0.13)],
           "alloy",sides=28,closed=True,hit="dish")
    turned("Reflector closed centre", hub,pointing,[(-0.039,0.14),(0.041,0.17)],"alloy",sides=12,hit="dish")
    turned("Suspended parabolic feed", hub,pointing,[(0.72,0.12),(0.81,0.19),(1.00,0.18)],
           "graphite",sides=12,hit="dish")
    tangent = pointing.orthogonal().normalized()
    bitangent = pointing.cross(tangent)
    for i in range(3):
        theta = i*math.tau/3
        rim = hub+pointing*0.37+1.22*(math.cos(theta)*tangent+math.sin(theta)*bitangent)
        beam("Dish feed truss rod", rim,hub+pointing*0.84,0.064,0.061,"frame",bevel=0.009)
    for i,(xx,yy,h) in enumerate(((-2.91,16.70,2.68),(2.79,15.12,3.06),(1.40,16.95,5.00))):
        at = (xx,yy,2.96)
        key = f"mast_{i}"
        turned("Sectional antenna and anchor", at,UP,[(0,0.26),(0.32,0.26),(0.58,0.15),(h*0.60,0.13),
               (h*0.65,0.085),(h,0.066)],"alloy",sides=12,hit=key)
        if i < 2:
            turned("Amber guide light lens", at,UP,[(h-0.15,0.14),(h+0.18,0.14),(h+0.26,0.08)],
                   "beacon",sides=10,hit=key)
            socket(f"nav_{i}",(xx,yy,2.96+h+0.26),UP)


def map_trim(data, material, i):
    uv = data.uv_layers.new(name="Packed trim UV")
    band = list(FINISHES).index(material)
    offset = (i*0.381966) % 1
    for p in data.polygons:
        drop = max(range(3),key=lambda a:abs(p.normal[a]))
        u,v = ((1,2),(0,2),(0,1))[drop]
        points = [data.vertices[data.loops[idx].vertex_index].co for idx in p.loop_indices]
        lo,hi = min(pt[v] for pt in points),max(pt[v] for pt in points)
        scale = min(0.35,0.84/max(hi-lo,1e-4))
        for idx,pt in zip(p.loop_indices,points):
            uv.data[idx].uv = (0.215*pt[u]+offset,(band+0.5+(pt[v]-(lo+hi)/2)*scale)/len(FINISHES))


def batch(trim):
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    batches = defaultdict(list)
    for i, source in enumerate(parts.objects):
        data = bpy.data.meshes.new_from_object(source.evaluated_get(dg),preserve_all_data_layers=True,depsgraph=dg)
        authored = source.data.materials[0]
        target = authored
        if authored.name in FINISHES:
            map_trim(data,authored.name,i)
            target = trim
        data.materials[0] = target
        obj = bpy.data.objects.new(source.name+" | export",data)
        export.objects.link(obj)
        batches[target].append(obj)
    for m, objects in batches.items():
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        obj = objects[0]
        bpy.context.view_layer.objects.active=obj
        if len(objects)>1:
            bpy.ops.object.join()
        obj.name=m.name
        if m==trim and lod == 0:
            t=obj.modifiers.new("Locked final texture tangents","TRIANGULATE")
            t.keep_custom_normals=True
        obj.hide_set(True)
    bpy.ops.object.select_all(action="DESELECT")


def collision(target):
    trees = {}
    samples = {
        key: [obj.matrix_world @ v.co for obj in objects for v in obj.data.vertices]
        for key, objects in proxy_sources.items()
    }
    samples.update(sector_samples)
    for key, points in samples.items():
        bm = bmesh.new()
        coords = {}
        for coord in points:
            p = tuple(round(c,5) for c in coord)
            if p not in coords:
                coords[p] = bm.verts.new(coord)
        result=bmesh.ops.convex_hull(bm,input=list(bm.verts),use_existing_faces=False)
        unused=set(result["geom_unused"]) | set(result["geom_interior"])
        bmesh.ops.delete(bm,geom=list(unused),context="VERTS")
        bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces))
        if not all(edge.is_manifold for edge in bm.edges) or bm.calc_volume(signed=True)<=0:
            raise ValueError(f"Expected a closed convex proxy for {key}")
        geo=bpy.data.meshes.new("Proxy "+key)
        bm.to_mesh(geo)
        trees[key]=BVHTree.FromBMesh(bm)
        bm.free()
        obj=bpy.data.objects.new("Proxy "+key,geo)
        target.objects.link(obj)
        obj.hide_set(True)
    return trees


def check_proxy(trees):
    def cast(at, axis, reach):
        hits = ((bv.ray_cast(Vector(at),Vector(axis),reach)[3],key) for key,bv in trees.items())
        return min(((d,k) for d,k in hits if d is not None),default=(None,None))[1]

    for at,axis,expected in [
        ((0,-32,0),Y,"dock_backing"), ((5.98,0,8),-UP,"tank_1"), ((-5.98,0,8),-UP,"tank_-1"),
        ((12.78,ARRAY_Y,7),-UP,"solar_1"), ((-12.78,ARRAY_Y,7),-UP,"solar_-1"),
        ((1,-2,9),-UP,"dorsal"), ((1,-2,-9),UP,"ventral"), ((2.79,15.12,14),-UP,"mast_1"),
    ]:
        hit=cast(at,axis,40)
        if hit!=expected:
            raise ValueError(f"Expected {expected}, hit {hit} at {at}")
    for at in ((3.67,-31,0),(-3.67,-31,0),(0,-31,3.67),(0,-31,-3.67)):
        hit = cast(at,Y,10.83)
        if not hit or not hit.startswith("dock_lip_"):
            raise ValueError(f"Capture lip is missing at {at}")
    for at,axis,reach in [
        ((14.3,ARRAY_Y,7),-UP,14),((-14.3,ARRAY_Y,7),-UP,14),
        ((12.78,ARRAY_Y-2.3,7),-UP,14),((12.78,ARRAY_Y+2.3,7),-UP,14),
        ((0,9.3,12),-UP,8.5),((0,11.9,12),-UP,8.5),
        ((0,-31,0),Y,11.12),
        ((4.55,-31,0),Y,12.3),((-4.55,-31,0),Y,12.3),
    ]:
        hit=cast(at,axis,reach)
        if hit:
            raise ValueError(f"Clearance blocked by {hit} at {at}")
    print("Proxy passed 12 surface hits and 9 clearance rays.")


if __name__ == "__main__":
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene=bpy.context.scene
    scene.unit_settings.system="METRIC"
    scene.unit_settings.scale_length=1
    bpy.context.preferences.filepaths.save_version=0
    proxy=collection("COLLISION")
    proxy_sources=defaultdict(list)
    sector_samples={}
    materials={name:material(name,color,r,m) for name,(color,r,m) in FINISHES.items()}
    materials["lamp"]=material("Amber depot guides",(0.65,0.20,0.008),0.30,emissive=3.2)
    materials["beacon"]=material("Amber depot mast beacons",(0.65,0.20,0.008),0.30,emissive=4.5)
    trims=[material(f"Depot ceramic and hardware trim {level}",(0.47,0.39,0.32),0.58) for level in range(3)]
    glass=[material(f"Silica coverglass and photovoltaic cells {level}",(0.025,0.042,0.067),0.18) for level in range(3)]
    station_trim(trims)
    photovoltaic(glass)
    for lod in range(3):
        parts=collection("Base orbital depot | editable assemblies" if lod == 0 else f"LOD{lod} construction")
        export=collection(f"EXPORT_LOD{lod}")
        materials["pv"]=glass[lod]
        truss()
        cassette(1)
        cassette(-1)
        tanks()
        docking()
        bus_and_power()
        comms()
        socket("dock",(0,DOCK_FACE,0),DOCK)
        socket("approach",(0,DOCK_FACE-20,0),DOCK)
        socket("upgrade_refinery",REFINERY_MOUNT,UP)
        socket("upgrade_coolant",(0,12.77,3.69),UP)
        socket("cargo_upper",(0,-2.10,5.09),UP)
        socket("cargo_lower",(0,-2.10,-5.09),-UP)
        bpy.context.view_layer.update()
        if lod == 0:
            check_proxy(collision(proxy))
        batch(trims[lod])
        if lod != 0:
            for obj in list(parts.objects):
                bpy.data.objects.remove(obj, do_unlink=True)
            bpy.data.collections.remove(parts)
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type=="VIEW_3D":
                space=area.spaces.active
                space.clip_end=400
                space.overlay.show_floor=False
                space.shading.color_type="MATERIAL"
                space.region_3d.view_rotation=Vector((0.85,-1,0.73)).to_track_quat("Z","Y")
                space.region_3d.view_distance=50
    dest=Path(sys.argv[sys.argv.index("--")+1]).resolve()
    bpy.ops.wm.save_as_mainfile(filepath=str(dest))
