"""R4 orbital fabricator. Blender metres, +Z up, +Y faces the recovery approach."""
import math
import sys
from collections import defaultdict
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from finishes import FINISHES, photovoltaic, station_trim

UP = Vector((0, 0, 1))
FRONT = Vector((0, 1, 0))
BERTH_FACE = 18.3
BERTH_HEIGHT = -16.55
MAST_LIGHTS = ((-10.2, 2.4, 26.8), (11.15, -2.8, 26.0))
SECTORS = [Vector((math.sin(i * math.pi / 4), math.cos(i * math.pi / 4), 0)) for i in range(8)]


def collection(name):
    group = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(group)
    return group


def material(name, color, roughness, metallic=0, emission=0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    if mat.node_tree is None:
        mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = mat.diffuse_color
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metallic
    if emission:
        shader.inputs["Emission Color"].default_value = mat.diffuse_color
        shader.inputs["Emission Strength"].default_value = emission
    return mat


def right_of(normal):
    return normal.cross(UP).normalized()


def mesh(name, vertices, faces, finish, bevel=0, hit=None, smooth=False):
    data = bpy.data.meshes.new(name)
    data.from_pydata(vertices, [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    parts.objects.link(obj)
    data.materials.append(materials[finish])
    if hit and lod == 0:
        collision_sources[hit].append(obj)
    if smooth:
        for polygon in data.polygons:
            polygon.use_smooth = len(polygon.vertices) == 4
    if bevel and (lod == 0 or (lod == 1 and bevel >= 0.16)):
        edge = obj.modifiers.new("Manufactured edge", "BEVEL")
        edge.width = bevel
        edge.segments = 2 if lod == 0 and bevel >= 0.15 else 1
        edge.harden_normals = True
        normals = obj.modifiers.new("Face-weighted normals", "WEIGHTED_NORMAL")
        normals.keep_sharp = True
    return obj


def loft(name, rings, finish, bevel=0, hit=None, smooth=False, closed=False):
    count = len(rings[0])
    total = len(rings)
    faces = [] if closed else [tuple(reversed(range(count)))]
    for layer in range(total if closed else total - 1):
        a, b = layer * count, ((layer + 1) % total) * count
        for i in range(count):
            j = (i + 1) % count
            faces.append((a+i, a+j, b+j, b+i))
    if not closed:
        faces.append(tuple(range((total-1)*count, total*count)))
    return mesh(name, [point for ring in rings for point in ring], faces, finish, bevel, hit, smooth)


def octagon(apothem):
    radius = apothem / math.cos(math.pi / 8)
    return [(radius * math.cos((i + 0.5) * math.pi / 4), radius * math.sin((i + 0.5) * math.pi / 4))
            for i in range(8)]


def deck(name, levels, finish, hit=None):
    return loft(name, [[(x, y, z) for x, y in octagon(r)] for z, r in levels], finish, 0.16, hit)


def box(name, center, size, finish, bevel=0, hit=None, basis=None, corner=0):
    x, y, z = (s / 2 for s in size)
    if corner:
        c = min(corner, x*0.8, z*0.8)
        outline = [(-x+c,-z),(-x,-z+c),(-x,z-c),(-x+c,z),
                   (x-c,z),(x,z-c),(x,-z+c),(x-c,-z)]
    else:
        outline = [(-x,-z),(-x,z),(x,z),(x,-z)]
    center = Vector(center)
    right, outward, up = basis or (Vector((1,0,0)), FRONT, UP)
    return loft(name, [[center + a*right + d*outward + b*up for a,b in outline] for d in (-y,y)],
                finish, bevel, hit)


def panel(name, normal, radius, height, size, finish, bevel=0, shift=0, hit=None, corner=0):
    right = right_of(normal)
    return box(name, normal*radius + right*shift + UP*height, size, finish, bevel, hit,
               (right, normal, UP), corner)


def radial(name, origin, axis, profile, finish, sides=12, hit=None, closed=False):
    sides = min(sides, (32, 12, 8)[lod])
    axis = Vector(axis).normalized()
    u = axis.orthogonal().normalized()
    v = axis.cross(u)
    origin = Vector(origin)
    return loft(name, [[origin + axis * offset + radius * (
        u * math.cos(i * math.tau / sides) + v * math.sin(i * math.tau / sides)) for i in range(sides)]
        for offset, radius in profile], finish, hit=hit, smooth=sides >= 16, closed=closed)


def link(name, a, b, width, depth, finish, bevel=0, hit=None):
    a, b = Vector(a), Vector(b)
    along = (b-a).normalized()
    right = along.cross(UP)
    if right.length_squared < 0.001:
        right = along.cross(FRONT)
    right.normalize()
    return box(name, (a+b)/2, (width, (b-a).length, depth), finish, bevel, hit,
               (right, along, right.cross(along)))


def socket(name, position, direction, export):
    name = "socket_" + name
    if existing := bpy.data.objects.get(name):
        export.objects.link(existing)
        return
    obj = bpy.data.objects.new(name, None)
    export.objects.link(obj)
    obj.location = position
    obj.rotation_euler = Vector(direction).to_track_quat("-Y", "Z").to_euler()
    obj.empty_display_type = "ARROWS"
    obj.empty_display_size = 1.4


def seams_and_fasteners(normal, radius, z, width, height, inset=(0.72, 0.68)):
    if lod != 0:
        return
    x, y = width/2 - inset[0], height/2 - inset[1]
    for dx in (-x, x):
        for dz in (-y, y):
            at = normal*radius + right_of(normal)*dx + UP*(z+dz)
            radial("Recessed titanium fastener", at, normal,
                   [(0,0.19),(0.07,0.19),(0.12,0.13)], "alloy", 6)
            radial("Fastener drive", at+normal*0.12, normal, [(0,0.053),(0.013,0.053)], "graphite", 6)


def signal(normal, radius, z, shift=0, count=4, vertical=False):
    w, h = (0.73, 0.58)
    width, height = (w+0.27, h*count*1.4+0.20) if vertical else (w*count*1.4+0.20, h+0.24)
    if lod < 2:
        panel("Recessed lamp housing", normal, radius, z, (width,0.55,height), "graphite", 0.10, shift)
    if lod > 0:
        lens_size = (w,0.10,height-0.28) if vertical else (width-0.30,0.10,h)
        panel("Amber light bar", normal, radius+0.28, z, lens_size, "lamp", 0.06, shift)
        return
    for i in range(count):
        step = i - (count-1)/2
        panel("Amber status lens", normal, radius+0.28, z + (step*h*1.37 if vertical else 0),
              (w,0.10,h), "lamp", 0.06, shift + (0 if vertical else step*w*1.37))


def core():
    deck("Lower equipment deck", [(-28.8,13.8),(-27.9,15.3),(-23.2,15.3),(-22.8,14.8)], "frame", "base")
    deck("Fabrication berth floor", [(-23.2,13.3),(-22.6,16.9),(-21.7,16.9)], "graphite", "base")
    # The berth faces +Y. The pressure bulkhead closes it at the far end.
    box("Fabricator pressure bulkhead", (0,-4,-16.5), (17.6,17.0,12), "frame", 0.56, "back_bulkhead")
    panel("Cradle tooling wall", FRONT, 4.8, -16.35, (15,0.7,10.5), "graphite", 0.31, corner=1.6)
    panel("Tooling platen", FRONT, 5.38, -16.2, (9.5,0.44,5.2), "alloy", 0.21, corner=0.86)
    for x in (-6.25, 6.25):
        box("Berth guide rail", (x,10.7,-21.38), (0.65,14.2,0.68), "alloy", 0.12, f"guide_{x}")
        if lod < 2:
            box("Guide rail keeper", (x,16.9,-20.98), (0.78,1.18,0.22), "amber", 0.05, f"guide_{x}")
    deck("Fabricator ceiling and lintel", [(-11.4,15),(-10.7,16.3),(-8.8,16.3),(-8.1,13.65)],
         "frame", "waist")
    deck("Power and thermal spine", [(-8.6,12.5),(-6.8,13.4),(8.8,13.4),(10.4,14.6)], "frame", "waist")
    deck("Upper shielding closure", [(7.6,14.8),(10.2,16.8),(23.5,16.8),(26.1,14.5)], "graphite", "head")
    deck("Avionics crown", [(24.9,13.9),(26.2,13.0),(27.8,8.1),(29.1,7.2)], "frame", "head")
    deck("Inboard service cover", [(28.4,6.3),(29.35,5.8),(29.75,4.6)], "ceramic", "head")
    for i, n in enumerate(SECTORS):
        patched = "patched" if i in (1, 4, 6) else "ceramic"
        panel("Outer upper shielding", n, 16.82, 17.3, (13.0,2.0,14.25), patched,
              0.40, hit="head", corner=1.47)
        panel("Upper shoulder doubler", n, 16.65, 9.04, (12.55,1.25,2.65), "ceramic", 0.17, hit="head", corner=0.65)
        seams_and_fasteners(n, 17.83, 17.3, 13.0, 14.25)
        signal(n, 11.2, 26.9, count=3)
        for s in (-1,1) if lod < 2 else ():
            panel("Upper panel retainer", n, 17.15, 12.45, (0.69,2.15,7.6), "alloy", 0.12, s*6.3)
            panel("Shoulder gusset", n, 13.7, 0.3, (1.07,2.05,12.6), "alloy", 0.16, s*4.75, "waist")
            if lod == 0:
                panel("Covered cable run", n, 14.0, -0.2, (0.42,1.5,10.85), "graphite", 0.07, s*3.55)
                panel("Waist rail clamp", n, 14.35, 4.15, (1.52,1.15,1.28), "frame", 0.12, s*4.75)
        panel("Recessed thermal tray", n, 13.57, -0.15, (7.1,1.10,10.9), "graphite", 0.29, hit="waist", corner=0.60)
        if i in (0, 1, 4, 7):
            for row in (range(10) if lod == 0 else range(0,10,2) if lod == 1 else (1,5,9)):
                panel("Radiator louver", n, 14.23, -4.64+1.0*row, (5.75,0.86,0.53), "radiator", 0.07)
        else:
            for z in (-3.5, -0.1, 3.3):
                panel("Avionics line-replaceable unit", n, 14.25, z, (5.65,0.85,2.72), "frame", 0.16, corner=0.38)
                if lod == 0:
                    panel("Amber pull tab", n, 14.75, z+0.53, (1.46,0.31,0.34), "amber", 0.05, shift=1.62)
        signal(n, 14.40, -0.10, shift=-5.92, count=5, vertical=True)

        if i:
            group = f"lower_{i}"
            radius, width, depth = (14.9,10.15,2.5) if i in (1,7) else (13.24,12.05,5.2)
            panel("Lower kit chassis", n, radius, -16.8, (width,depth,12.2), "frame", 0.28,
                  hit=group, corner=1.13)
            if i in (3, 4, 5):
                # Cylindrical vessels show through an open-sided cradle on the service side.
                for shift in (-2.8, 2.8):
                    at = n*15.45+right_of(n)*shift+UP*(-20.95)
                    radial("Jacketed propellant vessel", at, UP, [(0,1.05),(1.0,2.02),(7.75,2.02),(8.7,1.06)],
                           "tank", 16, group)
                    for z in ((1.67, 6.9) if lod == 0 else ()):
                        radial("Vessel restraint band", at, UP, [(z,2.10),(z+0.40,2.10)], "alloy", 16, group)
                panel("Tank cradle bumper", n, 17.0, -20.65, (11.75,1.6,2.85), patched, 0.29,
                      hit=group, corner=0.92)
                panel("Tank cradle upper spar", n, 17.0, -12.45, (11.30,1.35,2.0), "ceramic", 0.26,
                      hit=group, corner=0.65)
            else:
                for z in (-19.65, -13.75):
                    panel("Lower shielding cassette", n, 16.4, z, (12.15,1.78,5.38), patched,
                          0.32, hit=group, corner=1.04)
                    seams_and_fasteners(n, 17.30, z, 12.15, 5.38, inset=(1.33, 1.16))
        signal(n, 15.23, -25.8, count=4)

    for s in (-1,1):
        group = f"jamb_{s}"
        panel("Launch opening side column", FRONT, 14.2, -16.6, (3.75,5.2,11.9), "frame", 0.24, s*8.1, group)
        panel("Replaceable bay jamb armor", FRONT, 17.0, -16.6, (2.65,1.60,11.0), "ceramic", 0.27,
              s*8.05, group, 0.63)
        panel("Bay approach stripe", FRONT, 17.86, -16.5, (0.52,0.17,6.6), "amber", 0.06, s*7.88)
        signal(FRONT, 17.95, -11.85, shift=s*7.98, count=1)
    panel("Bay lintel warning stripe", FRONT, 16.5, -9.53, (13.25,0.42,0.37), "amber", 0.08)
    panel("Launch identification strip", FRONT, 16.95, -23.65, (12.8,1,1.08), "alloy", 0.13, hit="base")


def berth_door():
    # The two sliding leaves overlap the jambs, and the continuous seal fills the centre seam.
    # Keep a single shallow proxy, separate from the jambs, for eventual door motion.
    panel("Berth door seal and backing", FRONT, BERTH_FACE-0.62, BERTH_HEIGHT,
          (12.65,0.79,10.48), "graphite", 0.16, hit="berth_door")
    for side in (-1,1):
        shift = side*3.15
        panel("Berth sliding door leaf", FRONT, BERTH_FACE-0.265, BERTH_HEIGHT,
              (6.18,0.38,10.33), "frame", 0.16, shift, "berth_door", 0.53)
        panel("Door leaf reinforcement", FRONT, BERTH_FACE-0.04, BERTH_HEIGHT,
              (4.38,0.08,7.75), "radiator", 0.025, shift, "berth_door", 0.46)
        stripe_center = Vector((side*3.03,BERTH_FACE+0.010,BERTH_HEIGHT-2.80))
        stripe_direction = Vector((side*0.88,0,0.47)).normalized()
        box("Door meeting-edge warning", stripe_center, (3.60,0.024,0.36), "amber", 0.01,
            basis=(stripe_direction, FRONT, stripe_direction.cross(FRONT)))
        if lod == 0:
            for dz in (-3.79,3.79):
                panel("Door latch service cover", FRONT, BERTH_FACE-0.051, BERTH_HEIGHT+dz,
                      (0.68,0.08,0.56), "alloy", 0.028, side*0.64, corner=0.11)


def solar_arrays():
    for sign in (-1,1):
        key = f"array_{sign}"
        root = Vector((sign*14.0,0,-2.6))
        pivot = Vector((sign*22.0,0,4.0))
        tip = Vector((sign*37.5,0,18.0))
        axis = (tip-pivot).normalized()
        # Keep the tray's short axis parallel to the station's fore–aft axis.
        lateral = Vector((0,sign,0))
        face = axis.cross(lateral)
        basis = (axis, lateral, face)
        panel("Array root shear plate", Vector((sign,0,0)), 14.14, -2.22, (5.2,1.48,6.25),
              "alloy", 0.22, hit=key+"_boom", corner=0.66)
        link("Array trunnion boom", root, pivot, 3.34, 2.38, "frame", 0.28, key+"_boom")
        radial("Array deployment bearing", pivot-FRONT*2.25, FRONT,
               [(0,1.44),(0.72,1.65),(3.78,1.65),(4.5,1.44)], "alloy", 16, key+"_boom")
        for y in (-1.42,1.42):
            shoe = pivot.lerp(tip,0.44) + lateral*y - face*0.44
            link("Array backing strut", (sign*14.6,sign*y,-4.3), shoe,
                 0.67, 0.88, "alloy", 0.12, key+"_brace")
            if lod == 0:
                box("Array backing strut shoe", shoe, (1.07,0.85,0.27), "alloy", 0.08, key, basis)
        center = (tip+pivot)/2
        span = (tip-pivot).length
        box("Aluminum honeycomb array tray", center, (span,9.35,0.82), "frame", 0.18, key, basis)
        box("PV backing heat spreader", center-face*0.44, (span-0.50,8.68,0.20), "radiator", 0.06, key, basis)
        for y in (-4.51,4.51):
            box("Solar perimeter alloy frame", center+lateral*y+face*0.30, (span,0.34,0.60),
                "alloy", 0.095, key, basis)
        for x in (-span/2+0.20,0,span/2-0.20):
            box("Panel splice or end cap", center+axis*x+face*0.37, (0.38,9.36,0.58), "alloy", 0.095, key, basis)
        for x in (-span/4, span/4):
            origin = center + axis*x + face*0.48
            w, h = span/4-0.32, 4.26
            glass = mesh("Photovoltaics under fused silica", [origin-axis*w-lateral*h,origin+axis*w-lateral*h,
                         origin+axis*w+lateral*h,origin-axis*w+lateral*h], [(0,1,2,3)], "pv")
            uv = glass.data.uv_layers.new(name="Cell grid")
            for loop, value in enumerate(((0,0),(1,0),(1,1),(0,1))):
                uv.data[loop].uv = value
        for x in ((-span/2+0.33, span/2-0.33) if lod == 0 else ()):
            for y in (-4.45,4.45):
                box("Amber solar edge guard", center+axis*x+lateral*y+face*0.61, (0.96,0.40,0.18),
                    "amber", 0.047, basis=basis)


def robot_arm():
    direction = SECTORS[7]
    panel("Robot shoulder mount", direction, 17.4, -14.75, (6.7,2.7,6.6), "alloy", 0.38,
          hit="arm_shoulder", corner=1.25)
    points = [Vector(p) for p in ((-12.15,12.15,-14.8),(-20.5,16.05,-16.7),
                                 (-27.1,18.85,-11.35),(-34,20.35,-13.05),(-35.3,20.65,-16.1))]
    for i, (a,b) in enumerate(zip(points, points[1:])):
        width = (3.4, 2.35, 1.92, 1.48)[i]
        key = f"arm_link_{i}"
        link("Powered arm load path", a, b, width, width*0.89, "frame", 0.18, key)
        for side in (-1,1) if lod < 2 else ():
            offset = FRONT * (side*width*0.42)
            link("Service arm cheek plate", a.lerp(b,0.10)+offset, a.lerp(b,0.89)+offset,
                 width*0.19, width*0.74, "ceramic", 0.12, key)
            if lod == 0:
                edge = offset + FRONT*(side*0.24)
                link("Robotic arm pinch warning", a.lerp(b,0.26)+edge, a.lerp(b,0.71)+edge,
                     0.13, width*0.27, "amber", 0.03)
        pin = width*0.62
        radial("Sealed robot joint", b-FRONT*pin, FRONT,
               [(0,pin*0.82),(0.33,pin),(2*pin-0.33,pin),(2*pin,pin*0.82)], "alloy", 16, key)
        for side in (-1,1):
            radial("Joint cap with service paint", b+FRONT*(side*pin), FRONT*side,
                   [(0,pin*0.57),(0.16,pin*0.57)], "amber", 12, key)
    a = points[-1]
    for side in (-1,1):
        b = a + Vector((side*0.91,0,-1.34))
        c = b + Vector((-side*0.25,0,-1.13))
        link("Two-finger capture jaw", a, b, 0.52, 0.75, "alloy", 0.10, f"finger_{side}")
        link("Capture jaw pad", b, c, 0.46, 0.51, "graphite", 0.06, f"finger_{side}")
    return a + Vector((0,0,-2.22))


def service_manifold():
    back = -FRONT
    panel("Propellant transfer manifold", back, 17.43, -15.95, (5.7,2.51,5.1), "frame",
          0.37, hit="fuel_manifold", corner=1.0)
    for shift, name in ((-1.41,"reserve"),(1.41,"bulk")):
        at = back*18.6+right_of(back)*shift+UP*(-16.0)
        radial("Recessed " + name + " dry-break socket", at, back,
               [(0,0.63),(0.24,0.63),(0.29,1.03),(0.02,1.18),(-0.64,1.18),(-0.58,0.63)],
               "alloy", 20, "fuel_manifold", closed=True)
        radial("Dry-break sealing poppet", at-back*0.13, back, [(0,0.67),(0.17,0.67)], "graphite", 16)
        panel("Fill port identification stripe", back, 18.82, -14.19, (1.36,0.2,0.32),
              "amber" if name == "bulk" else "ceramic", 0.05, shift)
    for s in (-1,1):
        link("Pressure line to jacketed vessels", (s*2.5,-17.45,-17.15), (s*6.5,-17.32,-18.75),
             0.78, 0.78, "tank", 0.12, "fuel_manifold")


def comms():
    at = Vector((5.3,4.0,28.2))
    axis = Vector((0.26,0.58,0.77)).normalized()
    hub = at + UP*4
    # Support the reflector entirely from behind its bowl.
    pivot = hub - axis*1.65
    hinge = UP.cross(axis).normalized()
    radial("Dish pedestal", at, UP, [(0,1.95),(0.55,1.60),(1.8,1.03),(2.30,0.84)],
           "alloy", 16, "dish_mount")
    link("Offset dish yoke", at+UP*1.85, pivot, 1.35, 1.30, "frame", 0.16, "dish_mount")
    radial("Recessed elevation actuator", pivot-hinge*0.92, hinge, [(0,0.69),(1.84,0.69)],
           "frame", 16, "dish_mount")
    radial("Reflector rear saddle", hub, axis, [(-1.65,0.43),(-0.68,0.43),(-0.42,0.29)],
           "alloy", 12, "dish_mount")
    radial("Parabolic contact antenna", hub, axis, [
        (-0.48,0.28),(0.08,1.6),(0.94,3.46),(1.80,5.02),(2.05,5.08),(2.19,4.95),
        (1.45,3.80),(0.85,2.45),(0.56,1.2),(0.46,0.28)], "alloy", 32, "dish", closed=True)
    radial("Reflector centre insert", hub, axis, [(-0.45,0.27),(0.445,0.34),(0.483,0.29)],
           "alloy", 16, "dish")
    radial("Suspended dish feed horn", hub, axis, [(3.05,0.25),(3.30,0.43),(3.72,0.43)],
           "graphite", 12, "dish")
    side = axis.orthogonal().normalized()
    up = axis.cross(side)
    for i in range(3):
        theta = i*math.tau/3
        rim = hub + 1.75*axis+4.42*(math.cos(theta)*side+math.sin(theta)*up)
        link("Dish feed truss", rim, hub+3.28*axis, 0.22, 0.20, "frame", 0.03)
    masts = [(-4.3,3.5,28.0,14.2),(-7.3,3.5,28.0,9.2), (0.7,-7.9,26.8,4.9)]
    masts += [(x, y, z, 8.2) for x,y,z in MAST_LIGHTS]
    for i, (x,y,z,height) in enumerate(masts):
        radial("Mast anchorage and telescopic antenna", (x,y,z), UP,
               [(0,0.93),(0.84,0.93),(1.42,0.52),(height*0.41,0.48),(height*0.45,0.31),
                (height*0.72,0.29),(height*0.75,0.16),(height,0.16)],
               "alloy", 12, f"mast_{i}")
        if i >= 3:
            radial("Amber mast lamp", (x,y,z+height-0.65), UP, [(0,0.32),(1.13,0.32),(1.32,0.17)],
                   "beacon", 10, f"mast_{i}")


def project_trim(data, band, seed):
    uv = data.uv_layers.new(name="Manufacturing trims")
    for face in data.polygons:
        drop = max(range(3), key=lambda i: abs(face.normal[i]))
        if drop == 2:
            u, v = 0, 1
        elif drop == 1:
            u, v = 0, 2
        else:
            u, v = 1, 2
        indices = list(face.loop_indices)
        points = [data.vertices[data.loops[i].vertex_index].co for i in indices]
        low, high = min(p[v] for p in points), max(p[v] for p in points)
        scale = min(0.20, 0.84/max(high-low, 0.001))
        center = (low+high)*0.5
        for i,p in zip(indices,points):
            uv.data[i].uv = (0.113*p[u]+seed, (band+0.5+(p[v]-center)*scale)/len(FINISHES))


def collision(export):
    trees = {}
    for name, objects in collision_sources.items():
        bm = bmesh.new()
        coordinates = {}
        for source in objects:
            # Use the pre-bevel envelope so small fillets do not add physics facets.
            for vertex in source.data.vertices:
                co = source.matrix_world @ vertex.co
                key = tuple(round(x, 4) for x in co)
                if key not in coordinates:
                    coordinates[key] = bm.verts.new(co)
        result = bmesh.ops.convex_hull(bm, input=list(bm.verts), use_existing_faces=False)
        unused = set(result["geom_unused"]) | set(result["geom_interior"])
        bmesh.ops.delete(bm, geom=list(unused), context="VERTS")
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        if not all(edge.is_manifold for edge in bm.edges) or bm.calc_volume(signed=True) <= 0:
            raise ValueError(f"{name}: expected a closed, outward-facing convex proxy")
        data = bpy.data.meshes.new("Proxy " + name)
        bm.to_mesh(data)
        trees[name] = BVHTree.FromBMesh(bm)
        bm.free()
        obj = bpy.data.objects.new("Proxy " + name, data)
        export.objects.link(obj)
        obj.hide_set(True)
    return trees


def check_proxy(trees):
    def cast(origin, direction, limit):
        hits = ((tree.ray_cast(Vector(origin), Vector(direction), limit)[3], name) for name,tree in trees.items())
        return min(((d, name) for d,name in hits if d is not None), default=(None, None))[1]

    # Cast from the emergence side towards the closed door across a ship-sized envelope.
    for x in (-5.3,0,5.3):
        for z in (-20.1,-16.55,-13):
            if cast((x, BERTH_FACE+20, z), (0,-1,0), 19.9):
                raise ValueError(f"Launch clearance obstructed at x={x}, z={z}")
            if cast((x, BERTH_FACE+20, z), (0,-1,0), 21.5) != "berth_door":
                raise ValueError(f"Closed door missing at x={x}, z={z}")
    for origin,direction,label in [
        ((0,45,18),(0,-1,0),"head"), ((0,35,-9.7),(0,-1,0),"waist"),
        ((8,35,-16.5),(0,-1,0),"jamb_1"), ((-8,35,-16.5),(0,-1,0),"jamb_-1"),
        ((35,0,34),(0,0,-1),"array_1"), ((-35,0,34),(0,0,-1),"array_-1"),
        ((-33.5,20.5,5),(0,0,-1),"arm_link_2"), ((-4.3,3.5,48),(0,0,-1),"mast_0"),
        ((0,12,-16.5),(0,-1,0),"back_bulkhead"), ((6.25,15,-16),(0,0,-1),"guide_6.25"),
    ]:
        actual = cast(origin, direction, 45)
        if actual != label:
            raise ValueError(f"Proxy hit expected {label!r}, got {actual!r} at {origin}")
    for x,y,z in ((41,0,30),(-41,0,30),(34,11,29),(-34,11,29)):
        if cast((x,y,z), (0,0,-1), 65):
            raise ValueError(f"Empty space incorrectly covered at {(x,y,z)}")
    print("Proxy passed 19 targeted hits and 13 clearance rays.")


def batch(export, trim):
    groups = defaultdict(list)
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for seed, source in enumerate(parts.objects):
        evaluation = source.evaluated_get(depsgraph)
        data = bpy.data.meshes.new_from_object(evaluation, preserve_all_data_layers=True, depsgraph=depsgraph)
        authored = source.data.materials[0]
        finish = authored.name
        mat = authored
        if finish in FINISHES:
            project_trim(data, list(FINISHES).index(finish), (seed*0.381966) % 1)
            mat = trim
        data.materials[0] = mat
        obj = bpy.data.objects.new(source.name + " | export", data)
        export.objects.link(obj)
        groups[mat].append(obj)
    for mat, objects in groups.items():
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        obj = objects[0]
        bpy.context.view_layer.objects.active = obj
        if len(objects) > 1:
            bpy.ops.object.join()
        obj.name = mat.name
        if mat == trim:
            triangulate = obj.modifiers.new("Stable texture tangent triangles", "TRIANGULATE")
            triangulate.keep_custom_normals = True
        obj.hide_set(True)
    bpy.ops.object.select_all(action="DESELECT")


if __name__ == "__main__":
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1
    bpy.context.preferences.filepaths.save_version = 0
    proxy = collection("COLLISION")
    collision_sources = defaultdict(list)
    materials = {name:material(name, color, rough, metal) for name,(color,rough,metal) in FINISHES.items()}
    trims = [material(f"Station ceramic and hardware trim {level}", (0.47,0.39,0.32), 0.58) for level in range(3)]
    glass = [material(f"Fused silica over photovoltaic cells {level}", (0.025,0.042,0.067), 0.18) for level in range(3)]
    materials["lamp"] = material("Amber indicators", (0.55,0.19,0.008), 0.33, emission=2.3)
    materials["beacon"] = material("Amber mast beacons", (0.55,0.19,0.008), 0.33, emission=4.5)
    station_trim(trims)
    photovoltaic(glass)

    for lod in range(3):
        parts = collection("Replication point editable assemblies" if lod == 0 else f"LOD{lod} construction")
        export = collection(f"EXPORT_LOD{lod}")
        materials["pv"] = glass[lod]
        core()
        berth_door()
        solar_arrays()
        tool = robot_arm()
        service_manifold()
        comms()
        socket("launch", (0,BERTH_FACE,BERTH_HEIGHT), FRONT, export)
        socket("fuel_bulk", (-1.41,-18.95,-16), -FRONT, export)
        socket("fuel_reserve", (1.41,-18.95,-16), -FRONT, export)
        socket("arm_tool", tool, -UP, export)
        for side, (x,y,z) in zip(("port", "starboard"), MAST_LIGHTS):
            socket(f"mast_{side}_light", (x,y,z+8.87), UP, export)
        bpy.context.view_layer.update()
        if lod == 0:
            check_proxy(collision(proxy))
        batch(export, trims[lod])
        if lod != 0:
            for obj in list(parts.objects):
                bpy.data.objects.remove(obj, do_unlink=True)
            bpy.data.collections.remove(parts)
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == "VIEW_3D":
                space = area.spaces.active
                space.clip_end = 600
                space.overlay.show_floor = False
                space.shading.color_type = "MATERIAL"
                space.region_3d.view_rotation = Vector((0.72,1,0.6)).to_track_quat("Z","Y")
                space.region_3d.view_distance = 115
    target = Path(sys.argv[sys.argv.index("--")+1]).resolve()
    bpy.ops.wm.save_as_mainfile(filepath=str(target))
