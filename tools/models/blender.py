"""Static hard-surface asset workshop. Invoked by model.mjs with Blender 5.3."""
import json
import math
import sys
from pathlib import Path

import bpy
import blf
import imbuf
import numpy as np
import OpenImageIO as oiio
from mathutils import Matrix, Vector

# Blender coordinates: -Y is the nose, Z is up. Directions point from object to camera.
VIEWS = {
    "front": (0, -1, 0), "side": (1, 0, 0), "top": (0, 0, 1), "chase": (0.6, 1, 0.5),
    "rear": (0, 1, 0), "opposite": (-1, 0, 0), "bottom": (0, 0, -1), "ventral": (0.7, -1, -0.55),
    "bow": (0.65, -1, 0.65),
}
TO_GLTF = Matrix.Rotation(math.radians(-90), 4, "X")


def fixture(source):
    """QA coupon: a bevel modifier, asymmetric UV stripe, socket and excluded helper."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    group = bpy.data.collections.new("EXPORT_LOD0")
    bpy.context.scene.collection.children.link(group)
    bpy.ops.mesh.primitive_cube_add()
    hull = bpy.context.object
    hull.name = "Coupon"
    for coll in list(hull.users_collection):
        coll.objects.unlink(hull)
    group.objects.link(hull)
    hull.scale = (1, 2, 0.5)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bevel = hull.modifiers.new("Edge radius", "BEVEL")
    bevel.width, bevel.segments = 0.16, 3
    image = bpy.data.images.new("Registration stripe", 32, 32)
    image.pixels[:] = [v for y in range(32) for x in range(32)
                       for v in ((0.82, 0.29, 0.045, 1) if 6 <= x < 10 else (0.16, 0.28, 0.38, 1))]
    image.pack()
    material = bpy.data.materials.new("Coating")
    if material.node_tree is None:  # Blender 4.x
        material.use_nodes = True
    nodes = material.node_tree.nodes
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = image
    shader = nodes.get("Principled BSDF")
    material.node_tree.links.new(texture.outputs["Color"], shader.inputs["Base Color"])
    shader.inputs["Roughness"].default_value = 0.4
    hull.data.materials.append(material)
    socket = bpy.data.objects.new("socket_test", None)
    group.objects.link(socket)
    socket.location.y = 2
    bpy.ops.mesh.primitive_cube_add(location=(30, 0, 0))
    bpy.context.object.name = "Reference helper outside export"
    bpy.ops.wm.save_as_mainfile(filepath=source)


def check_images(tree, seen):
    if not tree or tree in seen:
        return
    seen.add(tree)
    for node in tree.nodes:
        if node.type == "GROUP":
            check_images(node.node_tree, seen)
        if node.type == "TEX_IMAGE" and node.image:
            image = node.image
            if image.source == "FILE" and not image.packed_file:
                file = bpy.path.abspath(image.filepath, library=image.library)
                if not Path(file).is_file():
                    raise ValueError(f"Missing image for {node.name}: {file}")


def export(source, name, destination):
    bpy.ops.wm.open_mainfile(filepath=source, load_ui=False, use_scripts=False)
    group = bpy.data.collections.get(name)
    if not group or not any(obj.type == "MESH" for obj in group.all_objects):
        raise ValueError(f"Expected a mesh in collection {name}")
    if bpy.context.scene.unit_settings.scale_length != 1:
        raise ValueError("Set scene unit scale to 1 (one Blender unit per metre).")
    seen = set()
    for obj in group.all_objects:
        if obj.type not in {"MESH", "EMPTY"} or (obj.type == "MESH" and obj.data.shape_keys):
            raise ValueError(f"{obj.name}: export collection supports static meshes and socket empties.")
        if obj.instance_type != "NONE":
            raise ValueError(f"{obj.name}: realize collection instances before static export.")
        if obj.parent and obj.parent.name not in group.all_objects:
            raise ValueError(f"{obj.name}: put its parent in the export collection to preserve the pivot.")
        for slot in obj.material_slots:
            if slot.material:
                check_images(slot.material.node_tree, seen)
    bpy.ops.export_scene.gltf(filepath=destination, export_format="GLB", collection=name,
                              export_yup=True, export_apply=True, export_tangents=True,
                              export_animations=False, export_cameras=False, export_lights=False)


def inspect_geometry(objects):
    """Catch coincident exported triangles even across nodes or reversed winding."""
    seen = set()
    lower = np.full(3, np.inf)
    upper = np.full(3, -np.inf)
    for obj in objects:
        mesh = obj.data
        points = [tuple(obj.matrix_world @ vertex.co) for vertex in mesh.vertices]
        if not points:
            continue
        lower = np.minimum(lower, np.min(points, axis=0))
        upper = np.maximum(upper, np.max(points, axis=0))
        mesh.calc_loop_triangles()
        for triangle in mesh.loop_triangles:
            key = tuple(sorted(points[index] for index in triangle.vertices))
            if key in seen:
                raise ValueError(f"Coincident triangles at {obj.name}, face {triangle.polygon_index}")
            seen.add(key)
    if not seen:
        raise ValueError("No triangles after reimport")
    return Vector(lower), Vector(upper)


def setup_camera_and_lights(scene, target, span, lighting):
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 8
    scene.cycles.seed = 7
    scene.cycles.use_denoising = True
    world = bpy.data.worlds.new("Studio ambient")
    if world.node_tree is None:  # Blender 4.x
        world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.24, 0.24, 0.24, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.02 if lighting == "sun" else 0.5
    scene.world = world
    bpy.ops.object.camera_add()
    cam = bpy.context.object
    scene.camera = cam
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = span * 1.1
    cam.data.clip_start, cam.data.clip_end = span * 0.001, span * 10
    if lighting == "clay":
        scene.render.engine = "BLENDER_WORKBENCH"
        shading = scene.display.shading
        shading.light = "STUDIO"
        shading.color_type = "SINGLE"
        shading.single_color = (0.65, 0.65, 0.65)
        return cam
    if lighting == "sun":
        light = bpy.data.lights.new("Raking sunlight", "SUN")
        light.energy, light.angle = 4, math.radians(0.53)
        obj = bpy.data.objects.new(light.name, light)
        scene.collection.objects.link(obj)
        obj.rotation_euler = Vector((1, 0.55, -0.45)).to_track_quat("-Z", "Y").to_euler()
        return cam
    for name, offset, power, size in [
        ("Softbox", (-1, -1, 1.5), 95, 1.4), ("Rim", (0.5, 1.4, 0.8), 75, 0.85),
        ("Ventral fill", (1, -0.5, -1), 45, 1.1),
    ]:
        light = bpy.data.lights.new(name, "AREA")
        light.energy, light.shape, light.size = power * span**2, "DISK", size * span
        obj = bpy.data.objects.new(name, light)
        scene.collection.objects.link(obj)
        obj.location = target + Vector(offset) * span
        obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()
    return cam


def review(file, output, size_arg, names, lighting):
    views = list(VIEWS) if names == "all" else names.split(",")
    if len(views) != len(set(views)) or any(v not in VIEWS for v in views):
        raise ValueError(f"Choose distinct views from {', '.join(VIEWS)}")
    out, size = Path(output), int(size_arg)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=file)
    scene = bpy.context.scene
    meshes = [obj for obj in scene.objects if obj.type == "MESH"]
    low, high = inspect_geometry(meshes)
    extent = high - low
    sockets = {}
    for obj in scene.objects:
        if obj.name.startswith("socket_"):
            matrix = TO_GLTF @ obj.matrix_world @ TO_GLTF.inverted()
            sockets[obj.name] = [[round(value, 6) for value in row] for row in matrix]
    report = {"meshObjects": len(meshes), "dimensionsMetres": [round(extent[i], 6) for i in (0, 2, 1)],
              "sockets": sockets, "viewsRowMajor": views, "lighting": lighting}
    (out / "geometry.json").write_text(json.dumps(report, indent=2) + "\n")
    center, span = (low + high) * 0.5, extent.length
    cam = setup_camera_and_lights(scene, center, span, lighting)
    scene.render.resolution_x = scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.view_settings.view_transform = "AgX"
    columns = math.ceil(math.sqrt(len(views)))
    sheet = np.zeros((math.ceil(len(views) / columns) * size, columns * size, 3), dtype=np.uint8)
    for index, view in enumerate(views):
        back = Vector(VIEWS[view]).normalized()
        up = Vector((0, -1, 0)) if abs(back.z) == 1 else Vector((0, 0, 1))
        right = up.cross(back).normalized()
        cam.rotation_euler = Matrix((right, back.cross(right), back)).transposed().to_euler()
        cam.location = center + back * span * 2
        file = str(out / (view + ".png"))
        scene.render.filepath = file
        bpy.ops.render.render(write_still=True)
        frame = oiio.ImageBuf(file).get_pixels(oiio.UINT8)
        y, x = (index // columns) * size, (index % columns) * size
        sheet[y:y+size, x:x+size] = frame[:, :, :3]
    sheet_file = str(out / "sheet.png")
    if not oiio.ImageBuf(sheet).write(sheet_file):
        raise RuntimeError("Could not write review sheet")
    contact = imbuf.load(sheet_file)
    with blf.bind_imbuf(0, contact):
        blf.size(0, 13)
        blf.color(0, 1, 1, 1, 1)
        for index, view in enumerate(views):
            x = (index % columns) * size + 6
            y = sheet.shape[0] - (index // columns) * size - 16
            blf.position(0, x, y, 0)
            blf.draw_buffer(0, view)
    imbuf.write(contact, filepath=sheet_file)


if __name__ == "__main__":
    action, *args = sys.argv[sys.argv.index("--") + 1:]
    {"fixture": fixture, "export": export, "review": review}[action](*args)
