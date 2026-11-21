"""Generate the starter survey ship's editable hull and batched export collections."""
import math
import sys
from pathlib import Path

import bpy
import bmesh
import numpy as np
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.dont_write_bytecode = True
from surfaces import armor_atlas, atlas_uv, exhaust_liner, machinery_trim, wing_surfaces


def collection(name):
    group = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(group)
    return group


def material(name, color, metallic, roughness):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    if mat.node_tree is None:
        mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = mat.diffuse_color
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = roughness
    return mat


def mesh(name, verts, faces, mat, bevel=0, smooth=False):
    data = bpy.data.meshes.new(name)
    data.from_pydata(verts, [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    parts.objects.link(obj)
    if mat:
        data.materials.append(mat)
    if smooth:
        for face in data.polygons:
            face.use_smooth = True
    if mat in (ivory, pale):
        armor_uv(data)
    if bevel and (lod == 0 or (lod == 1 and bevel >= 0.025)):
        edge = obj.modifiers.new("Machined edges", "BEVEL")
        edge.width = bevel
        edge.segments = 2 if lod == 0 else 1
        edge.harden_normals = True
        normals = obj.modifiers.new("Panel normals", "WEIGHTED_NORMAL")
        normals.keep_sharp = True
    return obj


def loft(name, rings, mat, bevel=0, closed=False, smooth=False, ridge_index=None):
    count = len(rings[0])
    faces = []
    layers = len(rings)
    if not closed:
        faces.append(tuple(reversed(range(count))))
    for level in range(layers if closed else layers - 1):
        a, b = level * count, ((level + 1) % layers) * count
        for i in range(count):
            j = (i + 1) % count
            faces.append((a+i, a+j, b+j, b+i))
    if not closed:
        cap = tuple(range((layers-1)*count, layers*count))
        if ridge_index is None:
            faces.append(cap)
        else:
            faces.extend((cap[:ridge_index+1], cap[ridge_index:] + cap[:1]))
    return mesh(name, [v for ring in rings for v in ring], faces, mat, bevel, smooth)


def plate(name, outline, low, high, mat, bevel=0.015):
    """Extrude an XY outline between constant or sloped surfaces."""
    heights = [height if callable(height) else lambda x, y, h=height: h for height in (low, high)]
    area = sum(x * ty - y * tx for (x, y), (tx, ty) in zip(outline, outline[1:] + outline[:1]))
    points = outline if area > 0 else outline[::-1]
    return loft(name, [[(x, y, h(x, y)) for x, y in points] for h in heights], mat, bevel)


def clipped_rect(x, y, w, length, corner):
    a, b = w / 2, length / 2
    return [(x-a+corner,y-b), (x+a-corner,y-b), (x+a,y-b+corner), (x+a,y+b-corner),
            (x+a-corner,y+b), (x-a+corner,y+b), (x-a,y+b-corner), (x-a,y-b+corner)]


def box(name, x, y, z, w, length, height, mat, bevel=0.03):
    return plate(name, [(x-w/2,y-length/2), (x+w/2,y-length/2),
                        (x+w/2,y+length/2), (x-w/2,y+length/2)], z-height/2, z+height/2, mat, bevel)


def bar(name, start, end, width, depth, mat, bevel=0.015):
    """Rectangular rail with its depth aligned as closely to vertical as possible."""
    a, b = Vector(start), Vector(end)
    direction = (b-a).normalized()
    right = Vector((0, 0, 1)).cross(direction).normalized() * (width/2)
    up = direction.cross(right).normalized() * (depth/2)
    return loft(name, [[tuple(p+d) for d in (-right-up, right-up, right+up, -right+up)]
                       for p in (a, b)], mat, bevel)


def radial(name, origin, direction, profile, mat, sides=32, phase=0, closed=False, smooth=True):
    """Turn a stepped shell or recessed nozzle around an arbitrary axis."""
    sides = min(sides, (36, 18, 8)[lod])
    axis = Vector(direction).normalized()
    u = axis.orthogonal().normalized()
    v = axis.cross(u)
    obj = loft(name, [[tuple(Vector(origin) + axis * distance +
                               radius * (math.cos(angle)*u + math.sin(angle)*v))
                        for i in range(sides) for angle in [math.tau*i/sides+phase]]
                       for distance, radius in profile], mat, closed=closed, smooth=smooth and sides >= 16)
    if mat == hot_liner:
        # Map around the bell. Close the UV seam with a split, not a zero-area triangle.
        uv = obj.data.uv_layers.new(name="Nozzle wrap")
        for face in obj.data.polygons:
            wraps = any(i % sides == sides-1 for i in face.vertices)
            for index in face.loop_indices:
                ring, spoke = divmod(obj.data.loops[index].vertex_index, sides)
                u = 1 if wraps and spoke == 0 else spoke/sides
                v = (0.03,0.97,0.94,0.66,0.35,0.08)[ring]
                uv.data[index].uv = (u, v)
    return obj


def socket(name, position, direction):
    if lod != 0:
        export.objects.link(bpy.data.objects[name])
        return
    obj = bpy.data.objects.new(name, None)
    export.objects.link(obj)
    obj.empty_display_type = "ARROWS"
    obj.empty_display_size = 0.23
    obj.location = position
    obj.rotation_euler = Vector(direction).to_track_quat("-Y", "Z").to_euler()


def armor_uv(data):
    uv = data.uv_layers.new(name="Ceramic surface")
    for face in data.polygons:
        # Map each machined face on its dominant plane with a common texel scale.
        dropped = max(range(3), key=lambda axis: abs(face.normal[axis]))
        u, v = [axis for axis in range(3) if axis != dropped]
        for index in face.loop_indices:
            co = data.vertices[data.loops[index].vertex_index].co
            uv.data[index].uv = (co[u]*0.65 + 0.27*dropped, co[v]*0.65 + 0.31*dropped)


def trim_uv(data, band):
    uv = data.uv_layers.new(name="Machinery trim")
    axes = list(zip(*(tuple(vertex.co) for vertex in data.vertices)))
    centers = [(min(axis)+max(axis))/2 for axis in axes]
    scales = [min(0.86/max(max(axis)-min(axis),1e-4), 3.5) for axis in axes]
    for face in data.polygons:
        dropped = max(range(3), key=lambda axis: abs(face.normal[axis]))
        u,v = [axis for axis in range(3) if axis != dropped]
        for index in face.loop_indices:
            co = data.vertices[data.loops[index].vertex_index].co
            uv.data[index].uv = (0.5+(co[u]-centers[u])*scales[u],
                                 (band+0.5+(co[v]-centers[v])*scales[v])/4)


def ceramic_finish():
    """Packed color and roughness tiles. Weathering here describes the finish at launch."""
    size = 512
    rng = np.random.default_rng(451)
    y, x = np.indices((size, size))
    surface = np.ones((size, size))
    for scale, strength in [(5, 0.13), (17, 0.08), (48, 0.036), (128, 0.016)]:
        grid = rng.uniform(-1, 1, (scale, scale))
        u, v = x*scale/size, y*scale/size
        a, b = u.astype(int), v.astype(int)
        fu, fv = u-a, v-b
        fu, fv = fu*fu*(3-2*fu), fv*fv*(3-2*fv)
        lower = grid[b, a]*(1-fu) + grid[b, (a+1) % scale]*fu
        upper = grid[(b+1) % scale, a]*(1-fu) + grid[(b+1) % scale, (a+1) % scale]*fu
        surface += strength*(lower*(1-fv) + upper*fv)
    pits = rng.random((size, size)) < 0.009
    surface -= pits * rng.uniform(0.07, 0.25, (size, size))
    roughness = np.clip(0.57 + (1-surface)*1.9, 0.35, 0.87)

    def image(name, rgb, color_space):
        img = bpy.data.images.new(name, size, size, alpha=False)
        img.colorspace_settings.name = color_space
        rgba = np.ones((size, size, 4), dtype=np.float32)
        rgba[:, :, :3] = rgb
        img.pixels.foreach_set(rgba.ravel())
        img.pack()
        return img

    rough = image("Ceramic micro-roughness", roughness[:, :, None], "Non-Color")
    for mat in (ivory, pale):
        color = np.array(mat.diffuse_color[:3])
        base = image(mat.name + " wear", np.clip(surface[:, :, None]*color, 0, 1), "sRGB")
        tree = mat.node_tree
        shader = tree.nodes.get("Principled BSDF")
        for img, channel in [(base, "Base Color"), (rough, "Roughness")]:
            node = tree.nodes.new("ShaderNodeTexImage")
            node.image = img
            tree.links.new(node.outputs["Color"], shader.inputs[channel])


def clip_panel(points, limit, keep_below):
    clipped = []
    for a, b in zip(points, points[1:] + points[:1]):
        a_inside = (a[1] <= limit) == keep_below
        b_inside = (b[1] <= limit) == keep_below
        if a_inside:
            clipped.append(a)
        if a_inside != b_inside:
            t = (limit-a[1])/(b[1]-a[1])
            clipped.append((a[0]+t*(b[0]-a[0]), limit))
    return clipped


def armor_panels(name, outline, low, high, mat, cuts, dorsal):
    ranges = zip([-math.inf] + [y+0.012 for y in cuts], [y-0.012 for y in cuts] + [math.inf])
    for index, (front, rear) in enumerate(ranges):
        points = clip_panel(clip_panel(outline, front, False), rear, True)
        panel_name = f"{name} panel {index}"
        if lod == 0:
            panel_specs.append((panel_name, points, dorsal, mat == pale))
        finish = (ceramic_atlas, ceramic_medium, far_ceramic)[lod]
        obj = plate(panel_name, points, low, high, finish, 0.023)
        if lod < 2:
            uv = obj.data.uv_layers.new(name="Hull atlas")
            for face in obj.data.polygons:
                for loop in face.loop_indices:
                    x, y, z = obj.data.vertices[obj.data.loops[loop].vertex_index].co
                    if abs(face.normal.z) < 0.5:
                        surface = high(x,y) if dorsal else low
                        inset = abs(z-surface)*0.17
                        x -= face.normal.x*inset
                        y -= face.normal.y*inset
                    uv.data[loop].uv = atlas_uv(x, y, dorsal)
        if lod != 0:
            continue
        cx = sum(x for x,y in points)/len(points)
        cy = sum(y for x,y in points)/len(points)
        for x,y in points:
            x, y = x*0.93+cx*0.07, y*0.93+cy*0.07
            z = high(x,y) if dorsal else low
            direction = (0,0,1 if dorsal else -1)
            radial("Flush armor fastener", (x,y,z), direction, [(-0.007,0.022),(0.004,0.018)], frame, 6)


def body():
    outline = [(0,-3.15),(0.77,-2.92),(1.74,-2.25),(2.38,-1.49),(2.32,0.23),
               (1.79,0.88),(0.68,1.21),(0,1.23),(-0.68,1.21),(-1.79,0.88),(-2.32,0.23),
               (-2.38,-1.49),(-1.74,-2.25),(-0.77,-2.92)]
    rings = [[(x*s,y*s,z) for x,y in outline]
             for s,z in ((0.80,-0.49),(0.98,-0.31),(1,-0.12),(0.96,0.19))]
    # Two planar roof facets follow the armor slope. Clearance keeps the pressure
    # vessel from cutting through the outer ceramic on the shoulders.
    rings.append([(x*0.85,y*0.85,0.528-0.12*abs(x*0.85)) for x,y in outline])
    loft("Pressure hull",rings,frame,0.036,ridge_index=7)
    for s in (-1, 1):
        def mirrored(points):
            return [(s*x,y) for x,y in points]

        # Independently removable armor over a stepped hull shoulder.
        top_height = lambda x, y: 0.58 - 0.12*abs(x)
        panels = [
            [(0.29,-2.83),(0.72,-2.88),(1.51,-2.27),(1.34,-1.94),(0.28,-2.08)],
            [(0.28,-2.035),(1.36,-1.89),(1.58,-2.23),(2.32,-1.49),(2.26,-0.76),(0.28,-0.87)],
            [(0.28,-0.82),(2.27,-0.71),(2.25,0.21),(1.73,0.84),(0.73,1.08),(0.28,0.57)],
        ]
        for i, outline in enumerate(panels):
            armor_panels(f"Dorsal armor {s} {i}", mirrored(outline), lambda x,y: top_height(x,y)-0.12, top_height,
                         ivory if i < 2 else pale, ([], [-1.60], [-0.26, 0.34])[i], True)
        vent = clipped_rect(s*1.40,-0.54,0.56,0.48,0.08)
        plate(f"Dorsal heat exchanger {s}", vent, lambda x,y: top_height(x,y)-0.025,
              lambda x,y: top_height(x,y)+0.025, graphite)
        for i in range((8, 5, 0)[lod]):
            y = -0.70 + i*0.32/(7 if lod == 0 else 4)
            box(f"Dorsal grille {s} {i}",s*1.40,y,top_height(1.4,y)+0.035,0.41,0.025,0.035,nickel,0.007)
        for i, outline in enumerate([
            [(0.32,-2.88),(0.73,-2.89),(1.70,-2.17),(1.48,-1.90),(0.32,-1.79)],
            [(0.32,-1.74),(1.52,-1.86),(1.76,-2.13),(2.31,-1.48),(2.28,0.14),
             (0.53,0.84),(0.32,0.72)],
        ]):
            armor_panels(f"Ventral armor {s} {i}", mirrored(outline), -0.51, -0.15,
                         ivory if i else pale, ([-2.39], [-1.34,-0.50,0.14])[i], False)
        bar("Forward armor safety stripe", (s*1.55,-1.56,top_height(1.55,-1.56)),
            (s*2.26,-1.39,top_height(2.26,-1.39)), 0.043,0.017,ochre,0.005)
        for y in (-2.00,-1.05,-0.24):
            box(f"Shoulder frame block {s} {y}",s*2.03,y,-0.16,0.56,0.31,0.30,frame)
        # Raised collar around a dark service tray with end latches below.
        bay_x = s*1.02
        plate(f"Utility bay housing {s}",clipped_rect(bay_x,-0.86,0.87,1.32,0.15),
              -0.60,-0.44,frame,0.04)
        plate(f"Utility bay door {s}",clipped_rect(bay_x,-0.86,0.67,1.11,0.11),
              -0.63,-0.585,graphite,0.025)
        for i in range((5, 3, 0)[lod]):
            box(f"Utility bay grille {s} {i}",bay_x,-0.59+i*0.21/(4 if lod == 0 else 2),-0.64,0.49,0.022,0.026,frame,0.006)
        box(f"Utility bay latch {s}",bay_x,-1.20,-0.654,0.25,0.067,0.047,ochre,0.01)
        plate(f"Ventral plumbing tray {s}",clipped_rect(s*0.80,-2.03,0.54,0.81,0.075),
              -0.55,-0.46,graphite,0.018)
        for offset in (-0.094,0.094) if lod < 2 else ():
            x = s*0.80 + offset
            radial("Coolant line",(x,-2.35,-0.558),(0,1,0),[(0,0.037),(0.59,0.037)],frame,10)
            radial("Coolant keeper",(x,-2.35,-0.558),(0,1,0),[(0.29,0.052),(0.34,0.052)],ochre,10)
    plate("Dorsal spine armor",clipped_rect(0,-1.36,0.50,2.87,0.13),0.27,0.60,ivory,0.03)
    plate("Dorsal access cover",clipped_rect(0,-1.53,0.43,1.14,0.11),0.599,0.64,graphite,0.017)
    plate("Ventral keel",clipped_rect(0,-0.87,0.52,1.37,0.08),-0.56,-0.40,graphite,0.025)
    radial("Survey optic guard",(0,-2.14,-0.47),(0,0,-1),
           [(0,0.43),(0.12,0.43),(0.18,0.36),(0.18,0.30),(0.08,0.27)],frame,16,closed=True)
    radial("Survey optic",(0,-2.14,-0.47),(0,0,-1),
           [(0.10,0.23),(0.15,0.22),(0.17,0.15)],lens,24)
    socket("socket_survey",(0,-2.14,-0.65),(0,0,-1))
    # Game mining effect aims out the nose. Its origin clears the hull on that axis.
    socket("socket_mining",(0,-4.193,-0.071),(0,-1,0))


def nose():
    base = [(0.48,0.15),(0.31,0.35),(-0.31,0.35),(-0.48,0.15),
            (-0.48,-0.23),(-0.30,-0.39),(0.30,-0.39),(0.48,-0.23)]
    loft("Sensor head", [[(x*scale,y,z*scale+dz) for x,z in base]
                         for y,scale,dz in ((-2.52,1.46,0.05),(-3.51,1.14,0),(-4.13,0.88,-0.05))],
         ivory, 0.043)
    loft("Nose instrument bezel",[[(x*0.82,y,z*0.82-0.05) for x,z in base]
                                  for y in (-4.12,-4.18)],graphite,0.02)
    for x,z,r in [(0,0.07,0.117),(-0.134,-0.14,0.085),(0.134,-0.14,0.085)]:
        radial("Camera ferrule",(x,-4.153,z),(0,-1,0),
               [(0,r*1.20),(0.036,r*1.15),(0.04,r),(0.019,r*0.87)],frame,20,closed=True)
        radial("Camera glass",(x,-4.156,z),(0,-1,0),
               [(0.014,r*0.88),(0.030,r*0.83),(0.037,r*0.66)],lens,24)
    for s in (-1, 1):
        box("Instrument latch",s*0.30,-4.175,-0.02,0.055,0.027,0.17,ochre,0.009)


def wing_skin(name, outline, low, high, solar_face):
    mat = (wing_finish, wing_medium, wing_far)[lod]
    obj = plate(name, outline, low, high, mat, 0.009)
    uv = obj.data.uv_layers.new(name="Wing surfaces")
    for face in obj.data.polygons:
        for index in face.loop_indices:
            x,y,z = obj.data.vertices[obj.data.loops[index].vertex_index].co
            if abs(face.normal.z) < 0.5:
                x += face.normal.x*z*0.15
                y += face.normal.y*z*0.15
            across = (abs(x)-1.82)/2.9
            uv.data[index].uv = ((across+(0 if solar_face else 1))/2, (y+2.10)/5.8)


def wings():
    outline = [(2.20,-1.94),(4.56,-0.73),(4.64,-0.50),(4.47,0.54),
               (2.17,3.57),(1.96,3.62),(1.92,0.80)]
    cx,cy = 2.75,0.64
    for s in (-1,1):
        root = [(s*x,y) for x,y in outline]
        inset = [(s*(cx+(x-cx)*0.944),cy+(y-cy)*0.955) for x,y in outline]
        plate("Wing structural tray", root,-0.164,0.012,ivory,0.028)
        wing_skin("Dorsal solar cell skin",inset,0.005,0.028,True)
        wing_skin("Ventral radiator skin",inset,-0.183,-0.158,False)
        for z in (0.039,-0.194):
            bar("Wing expansion strip",(s*1.999,0.76,z),(s*4.52,-0.05,z),0.035,0.022,ochre,0.006)
        for x,y in [(4.51,-0.57),(4.40,0.49),(2.16,3.46)]:
            plate("Wing tip fitting",clipped_rect(s*x,y,0.15,0.25,0.04),-0.17,0.027,ochre,0.018)
        if lod == 0:
            for y in (-0.16,0.56):
                bar("Wing hinge leaf",(s*1.94,y,0.027),(s*2.55,y,0.027),0.15,0.085,frame,0.018)
                radial("Wing hinge pin",(s*2.35,y-0.091,0.073),(0,1,0),
                       [(0,0.044),(0.183,0.044)],nickel,12)
            for edge in (0, 2, 3):
                a, b = root[edge], root[edge+1]
                for ratio in (0.25, 0.47, 0.69, 0.88):
                    x = a[0]*(1-ratio)+b[0]*ratio
                    y = a[1]*(1-ratio)+b[1]*ratio
                    x, y = x*0.987+s*cx*0.013, y*0.99+cy*0.01
                    radial("Wing rim fastener", (x,y,0.014), (0,0,1),
                           [(-0.005,0.015),(0.008,0.013)], frame, 6)
        for y in (0.45,1.32,2.53):
            bar("Wing spar",(s*0.68,y,-0.24),(s*2.14,y,-0.10),0.22,0.22,frame,0.024)


def propulsion():
    box("Aft structural spine",0,2.18,-0.11,1.41,2.63,0.77,frame,0.069)
    plate("Aft equipment deck",clipped_rect(0,2.38,0.72,1.77,0.17),0.27,0.42,graphite,0.027)
    box("Aft service block",0,3.36,-0.10,0.91,0.38,0.58,graphite,0.07)
    for i in range((9, 5, 0)[lod]):
        box("Aft service grille",0,3.552,-0.284+i*0.36/(8 if lod == 0 else 4),0.66,0.025,0.018,frame,0.005)
    for i in range((7, 4, 0)[lod]):
        box("Aft deck grille",0,2.66+i*0.36/(6 if lod == 0 else 3),0.431,0.46,0.021,0.027,frame,0.006)
    for s in (-1,1):
        box("Spine frame runner",s*0.47,2.32,0.35,0.145,2.03,0.18,pale,0.024)
        box("Ventral protective runner",s*0.52,2.25,-0.51,0.19,1.78,0.125,frame,0.019)
    if lod < 2:
        for s in (-1,1):
            x = s*0.49
            box("Aft spine load bracket",x,3.25,-0.065,0.225,0.66,0.44,frame,0.025)
            radial("Aft panel retainer",(x,3.585,0.077),(0,1,0),
                   [(0,0.062),(0.038,0.055)],nickel,8)
            radial("Aft auxiliary connector",(x,3.585,-0.158),(0,1,0),
                   [(0,0.067),(0.046,0.067),(0.046,0.037),(0.009,0.036)],ochre,12,closed=True)
            radial("Spine bypass tube",(x,1.50,0.49),(0,1,0),
                   [(0,0.049),(1.63,0.049)],nickel,12)
            for y in (1.60,2.60):
                radial("Bypass tube collar",(x,y,0.49),(0,1,0),
                       [(0,0.068),(0.11,0.068)],frame,12)
        box("Spine heat shield",0,1.87,0.46,0.66,0.38,0.12,pale,0.035)
    for y in (1.31,2.86,3.20):
        bar("Keel crossmember",(-0.62,y,0.33),(0.62,y,0.33),0.12,0.16,frame)
    for s,side in [(-1,"starboard"),(1,"port")]:
        x = s*1.32
        z = 0.33
        origin = (x,0.69,z)
        direction = (0,1,0)
        radial(f"{side} drive frame",origin,direction,
               [(0,0.32),(0.22,0.49),(0.43,0.55),(2.70,0.55),(2.809,0.51)],frame,12)
        for a,b in [(0.63,1.23),(1.25,1.93),(1.95,2.55)]:
            radial(f"{side} ceramic shroud",origin,direction,
                   [(a,0.552),(a+0.055,0.587),(b-0.06,0.587),(b,0.552)],ivory,12)
        for start in (0.48,1.94,2.62):
            radial("Drive service band",origin,direction,
                   [(start,0.553),(start+0.021,0.577),(start+0.06,0.577),(start+0.08,0.553)],ochre,12)
        radial(f"{side} exhaust flange",origin,direction,
               [(2.80,0.51),(2.91,0.58),(3.18,0.58),(3.25,0.52),(3.25,0.454),(2.96,0.441)],
               frame,36,closed=True)
        radial("Heat shield retaining lip",origin,direction,
               [(3.191,0.553),(3.231,0.553),(3.249,0.516),(3.249,0.499),(3.218,0.509)],
               nickel,36,closed=True)
        radial("Recessed thrust bell",origin,direction,
               [(2.81,0.28),(3.245,0.477),(3.25,0.455),(3.12,0.385),(2.95,0.275),(2.81,0.21)],
               hot_liner if lod == 0 else graphite,36,closed=True)
        # The drive housing closes the forward side. A recessed refractory cup
        # covers the shiny centre and gives the throat an opaque rear-facing floor.
        radial("Sealed refractory throat chamber",origin,direction,
               [(2.785,0.238),(2.828,0.238),(2.866,0.21),(2.866,0.132),
                (2.822,0.103),(2.804,0.103)],refractory,32,smooth=False)

        if lod < 2:
            for side_offset in (-0.23, 0.23):
                bar("Aft hot-zone guard", (x+side_offset,3.04,0.81),
                    (x+side_offset,3.51,0.81), 0.115, 0.12, graphite, 0.025)
            for dx in (-0.39,0.39):
                bar("Gimbal actuator", (x+dx,2.86,0.39), (x+dx,3.47,0.55),
                    0.115, 0.13, nickel, 0.019)
        if lod == 0:
            for step in range(12):
                angle = step*math.tau/12
                gx, gz = x+math.sin(angle)*0.51, z+math.cos(angle)*0.51
                radial("Nozzle retention bolt",(gx,3.937,gz),direction,
                       [(-0.018,0.020),(0.003,0.016)],graphite, 6)
            for y in (1.67,2.28,2.90):
                box("Engine shroud access plate",x,y,0.905,0.41,0.31,0.036,frame,0.015)
                for i in (-1,0,1):
                    box("Engine shroud vent",x,y+i*0.064,0.93,0.32,0.029,0.013,nickel,0.004)
            for y in (1.52,2.17,2.84):
                box("Fin root shear key",s*1.94,y,-0.128,0.20,0.18,0.21,frame,0.023)
                box("Fin root retaining plate",s*1.94,y,-0.021,0.145,0.12,0.034,ochre,0.009)
        for dx in (-0.48,0.48) if lod < 2 else ():
            radial("Drive feed line",(x+dx,0.90,-0.11),direction,[(0,0.065),(2.49,0.065)],frame,12)
            for y in ((0.31,0.88,1.53,2.19) if lod == 0 else (0.31,2.19)):
                radial("Drive line clamp",(x+dx,0.90,-0.11),direction,[(y,0.09),(y+0.10,0.09)],pale,12)
        for y in (1.13,2.34):
            box("Engine cradle",x,y,-0.215,1.20,0.23,0.29,frame,0.035)
        socket("socket_engine_"+side,(x,3.94,z),direction)


def batch():
    """Evaluate bevels and group static faces by shader for the exported GLB."""
    for source in parts.objects:
        is_trim = lod < 2 and source.data.materials[0] in trim_lanes
        if source.data.materials[0] == ceramic_atlas or is_trim:
            weld = source.modifiers.new("Remove collapsed bevel edges", "WELD")
            weld.merge_threshold = 0.00001
        if source.data.uv_layers or is_trim:
            triangulate = source.modifiers.new("Export triangulation", "TRIANGULATE")
            triangulate.keep_custom_normals = True
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    groups = {}
    for source in parts.objects:
        authored = source.data.materials[0]
        mat = authored
        if lod == 2:
            mat = far_materials.get(authored, authored)
        if lod < 2 and authored in trim_lanes:
            mat = (machinery, machinery_medium)[lod]
        evaluated = source.evaluated_get(depsgraph)
        data = bpy.data.meshes.new_from_object(evaluated, preserve_all_data_layers=True, depsgraph=depsgraph)
        data.materials[0] = mat
        if authored in trim_lanes and lod < 2:
            trim_uv(data, trim_lanes[authored])
        obj = bpy.data.objects.new(source.name, data)
        export.objects.link(obj)
        groups.setdefault(mat, []).append(obj)
    for mat, objects in groups.items():
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        bpy.ops.object.join()
        objects[0].name = f"Hull | {mat.name}"
    # Hide batched duplicates in the authoring viewport. The export names its own collection.
    for obj in export.objects:
        obj.hide_set(True)
    bpy.ops.object.select_all(action="DESELECT")


def collision_hulls(source):
    """Cover the major exterior volumes separately to leave clearance between them."""
    groups = [
        ("Core", ("Pressure hull", "Dorsal armor", "Ventral armor", "Dorsal spine armor",
                  "Dorsal access cover", "Utility bay housing", "Utility bay door", "Survey optic"), 0),
        ("Nose", ("Sensor head", "Nose instrument bezel"), 0),
        ("Aft spine", ("Aft structural spine", "Aft service block", "Aft spine load bracket",
                       "Aft equipment deck", "Spine heat shield", "Ventral protective runner"), 0),
    ]
    for sign, side in [(-1, "starboard"), (1, "port")]:
        groups.append((f"{side} drive", tuple(f"{side} {part}" for part in
                      ("drive frame", "ceramic shroud", "exhaust flange")), 0))
        groups.append((f"{side} wing", ("Wing structural tray", "Dorsal solar cell skin",
                      "Ventral radiator skin", "Wing expansion strip", "Wing tip fitting"), sign))

    # Use the authored cages. Bevel cutbacks and recessed hardware can sit a few
    # centimetres inside the convex contact surface without changing clearances.
    radial_stride = {"exhaust flange": 3, "Survey optic": 4}
    for name, prefixes, sign in groups:
        points = {}
        for obj in source.objects:
            if not obj.name.startswith(prefixes) or (sign and obj.data.vertices[0].co.x * sign <= 0):
                continue
            stride = next((step for part, step in radial_stride.items() if part in obj.name), 1)
            for i in range(0, len(obj.data.vertices), stride):
                points[tuple(obj.data.vertices[i].co)] = None
        bm = bmesh.new()
        try:
            vertices = [bm.verts.new(point) for point in points]
            bmesh.ops.convex_hull(bm, input=vertices, use_existing_faces=False)
            bm.verts.index_update()
            used = sorted({vertex for face in bm.faces for vertex in face.verts}, key=lambda v: v.index)
            if len(used) < 4:
                raise ValueError(f"Missing collision volume for {name}")
            indices = {vertex: i for i, vertex in enumerate(used)}
            obj = mesh(f"Collision {name}", [tuple(v.co) for v in used],
                       [tuple(indices[v] for v in face.verts) for face in bm.faces], None)
            obj.hide_set(True)
        finally:
            bm.free()


if __name__ == "__main__":
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.unit_settings.system = "METRIC"
    ivory = material("Ivory ceramic coating", (0.49,0.413,0.335), 0.0, 0.49)
    pale = material("Pale ceramic coating", (0.54,0.455,0.375), 0.0, 0.54)
    frame = material("Gunmetal frame", (0.087,0.083,0.075), 0.86, 0.55)
    graphite = material("Dark graphite", (0.034,0.039,0.044), 0.06, 0.76)
    wing_finish = material("Coverglass and radiator coating", (0.047,0.064,0.088), 0.0, 0.34)
    ochre = material("Amber safety paint", (0.75,0.295,0.018), 0.0, 0.63)
    lens = material("Blue optical coating", (0.031,0.076,0.116), 0.58, 0.19)
    far_ceramic = material("Distant ceramic", (0.44,0.365,0.29), 0.0, 0.62)
    wing_medium = material("Medium wing surfaces", (0.047,0.064,0.088), 0.0, 0.34)
    wing_far = material("Distant wing surfaces", (0.047,0.064,0.088), 0.0, 0.34)
    nickel = material("Machined titanium and nickel", (0.25,0.22,0.18), 0.92, 0.37)
    hot_liner = material("Oxidized liner", (0.10,0.085,0.068), 0.85, 0.52)
    refractory = material("Carbon refractory throat", (0.009,0.008,0.007), 0.0, 0.93)
    throat_shader = refractory.node_tree.nodes.get("Principled BSDF")
    throat_shader.inputs["Specular IOR Level"].default_value = 0.035
    hot_liner.node_tree.nodes.get("Principled BSDF").inputs["Specular IOR Level"].default_value = 0.065
    ceramic_atlas = material("Worn hull panels", (0.44,0.365,0.29), 0.0, 0.62)
    ceramic_medium = material("Medium hull panels", (0.44,0.365,0.29), 0.0, 0.62)
    panel_specs = []
    machinery = material("Machinery trim finishes", (0.13,0.12,0.11), 0.9, 0.52)
    machinery_medium = material("Medium machinery finishes", (0.13,0.12,0.11), 0.9, 0.52)
    trim_lanes = {frame: 0, graphite: 1, nickel: 2, ochre: 3}
    machinery_trim(machinery, machinery_medium)
    exhaust_liner(hot_liner)
    far_materials = {refractory: graphite, nickel: frame, ivory: far_ceramic, pale: far_ceramic, lens: graphite}
    wing_surfaces(wing_finish, wing_medium, wing_far)
    ceramic_finish()
    for lod in range(3):
        parts = collection("Editable hull parts" if lod == 0 else f"LOD{lod} construction")
        export = collection(f"EXPORT_LOD{lod}")
        body()
        nose()
        wings()
        propulsion()
        batch()
        if lod == 0:
            editable = parts
            armor_atlas(panel_specs, ceramic_atlas, ceramic_medium)
        if lod != 0:
            for obj in list(parts.objects):
                bpy.data.objects.remove(obj, do_unlink=True)
            bpy.data.collections.remove(parts)
    parts = collection("COLLISION")
    collision_hulls(editable)
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == "VIEW_3D":
                space = area.spaces.active
                space.shading.color_type = "MATERIAL"
                space.region_3d.view_rotation = Vector((0.65,1,0.70)).to_track_quat("Z", "Y")
                space.region_3d.view_distance = 13
                space.overlay.show_floor = False
    dest = Path(sys.argv[sys.argv.index("--")+1]).resolve()
    dest.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(dest))
