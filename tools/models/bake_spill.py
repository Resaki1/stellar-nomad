"""S3 lamp-spill bake (docs/VFX_REALISM_PLAN.md §4). Run by tools/models/spill-bake.mjs.

For each EXPORT_LOD collection: a second UV map ("Spill lightmap", lightmap-packed, one atlas
per LOD), Cycles DIFFUSE bake (direct + indirect, no colour) of the steady `light_*` empties
only (black world, other LODs / editable parts / proxies hidden, lamp-mesh emission off so it
is not counted twice). Lamp power is calibrated on a reference plane so a texel holds the
irradiance E in game units: three adds a light map as irradiance (× diffuse/π), so the
runtime needs only × pre-exposure. Saves the master with the new UV maps.
"""
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

cfg = json.loads(Path(sys.argv[sys.argv.index("--") + 1]).read_text())
UV = "Spill lightmap"
scene = bpy.context.scene
view_layer = bpy.context.view_layer
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = cfg["samples"]
bake = scene.render.bake
bake.use_pass_direct = True
bake.use_pass_indirect = True
bake.use_pass_color = False
bake.margin = 4

world = scene.world or bpy.data.worlds.new("Spill bake")
scene.world = world
world.use_nodes = True
background = world.node_tree.nodes.get("Background")
saved_world = background.inputs[1].default_value if background else None
if background:
    background.inputs[1].default_value = 0

# Nothing but our lamps may light the bake.
hidden_lights = [o for o in bpy.data.objects if o.type == "LIGHT" and not o.hide_render]
for o in hidden_lights:
    o.hide_render = True
saved_emission = {}
for m in bpy.data.materials:
    p = m.node_tree.nodes.get("Principled BSDF") if m.use_nodes else None
    if p and "Emission Strength" in p.inputs:
        saved_emission[m.name] = p.inputs["Emission Strength"].default_value
        p.inputs["Emission Strength"].default_value = 0

render_state = {o.name: o.hide_render for o in bpy.data.objects}
coll_state = {c.name: (c.hide_viewport, c.hide_render) for c in bpy.data.collections}
node_state = {m.name: m.use_nodes for m in bpy.data.materials}
view_state = {o.name: (o.hide_get(), o.hide_viewport) for o in bpy.data.objects}


def layer_collection(lc, name):
    if lc.collection.name == name:
        return lc
    for child in lc.children:
        found = layer_collection(child, name)
        if found:
            return found
    return None


def show(objs):
    for o in objs:
        o.hide_viewport = False
        o.hide_set(False)
        o.hide_render = False


def only(objs):
    keep = {o.name for o in objs}
    for o in bpy.data.objects:
        if o.type == "MESH":
            o.hide_render = o.name not in keep


def bake_into(objs, size, label):
    """Bake DIFFUSE light into a float image through each material's active image node."""
    image = bpy.data.images.new(label, size, size, float_buffer=True, alpha=False)
    nodes = []
    for m in {s.material for o in objs for s in o.material_slots if s.material}:
        m.use_nodes = True
        n = m.node_tree.nodes.new("ShaderNodeTexImage")
        n.image = image
        n.name = "SPILL_BAKE"
        m.node_tree.nodes.active = n
        nodes.append((m, n))
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    view_layer.objects.active = objs[0]
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"}, margin=4, use_clear=True)
    for m, n in nodes:
        m.node_tree.nodes.remove(n)
    return image


def add_lamp(name, kind, position, direction, rgb, size, power_per_unit):
    """rgb: intensity in game units (cd / 6037.7), per channel. Point: isotropic; disk: cosine."""
    peak = max(rgb)
    data = bpy.data.lights.new(name, "POINT" if kind == "point" else "AREA")
    data.color = tuple(c / peak for c in rgb) if peak > 0 else (1, 1, 1)
    data.energy = power_per_unit[kind] * peak
    if kind == "point":
        data.shadow_soft_size = size / 2
    else:
        data.shape = "DISK"
        data.size = size
    obj = bpy.data.objects.new(name, data)
    scene.collection.objects.link(obj)
    obj.location = position
    # Area lights emit along local -Z.
    obj.rotation_euler = Vector(direction).to_track_quat("-Z", "Y").to_euler()
    return obj


# ── Calibration: P per unit intensity so a texel at 1 m on-axis reads exactly 1 ─────────
cal_mesh = bpy.data.meshes.new("Spill calibration")
s = 0.05
cal_mesh.from_pydata([(-s, -s, 0), (s, -s, 0), (s, s, 0), (-s, s, 0)], [], [(0, 1, 2, 3)])
cal_mesh.uv_layers.new(name=UV)
cal_mat = bpy.data.materials.new("Spill calibration")
cal_mat.use_nodes = True
cal_mesh.materials.append(cal_mat)
cal = bpy.data.objects.new("Spill calibration", cal_mesh)
scene.collection.objects.link(cal)
FAR = Vector((0, 0, 20000))
cal.location = FAR
power_per_unit = {}
for kind, p0 in (("point", 4 * math.pi), ("disk", math.pi)):
    only([cal])
    lamp = add_lamp(f"Spill calibration {kind}", kind, FAR + Vector((0, 0, 1)), (0, 0, -1), (1, 1, 1), 0.02, {kind: p0})
    image = bake_into([cal], 8, f"spill-cal-{kind}")
    px = list(image.pixels)
    v = sum(px[i] for i in range(0, len(px), 4)) / (len(px) / 4)
    power_per_unit[kind] = p0 / v
    print(f"[spill] calibration {kind}: baked {v:.5f} for E=1 → power/unit {power_per_unit[kind]:.4f}")
    bpy.data.objects.remove(lamp, do_unlink=True)
    bpy.data.images.remove(image)
bpy.data.objects.remove(cal, do_unlink=True)

# ── Per LOD ────────────────────────────────────────────────────────────────────────────
out = Path(cfg["out"])
lods = []
lc_state = {}
for k, size in enumerate(cfg["sizes"]):
    coll = bpy.data.collections.get(f"EXPORT_LOD{k}")
    if coll is None:
        break
    lc = layer_collection(view_layer.layer_collection, coll.name)
    if lc:
        lc_state.setdefault(coll.name, (lc.exclude, lc.hide_viewport))
        lc.exclude = False
        lc.hide_viewport = False
    coll.hide_viewport = False
    coll.hide_render = False
    objs = [o for o in coll.all_objects if o.type == "MESH"]
    show(objs)
    for o in objs:
        uv = o.data.uv_layers.get(UV) or o.data.uv_layers.new(name=UV)
        o.data.uv_layers.active = uv
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    view_layer.objects.active = objs[0]
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.lightmap_pack(PREF_CONTEXT="ALL_FACES", PREF_PACK_IN_ONE=True, PREF_NEW_UVLAYER=False,
                             PREF_BOX_DIV=12, PREF_MARGIN_DIV=0.3)
    bpy.ops.object.mode_set(mode="OBJECT")

    lamps = []
    for e in coll.all_objects:
        if e.type != "EMPTY" or "emitter" not in e.keys() or int(e.get("blink", 0)) > 0:
            continue
        per_m2 = cfg["emitters"].get(e["emitter"])
        if not per_m2:
            continue
        area = float(e["area_m2"])
        rgb = [c * area for c in per_m2]
        m = e.matrix_world
        direction = (m.to_3x3() @ Vector((0, -1, 0))).normalized()
        kind = "disk" if float(e.get("cosine", 1)) > 0 else "point"
        lamp_size = float(e.get("size_m", math.sqrt(area)))
        lamps.append(add_lamp(f"Spill lamp {e.name}", kind, m.translation + direction * 0.01, direction, rgb, lamp_size, power_per_unit))
    only(objs)
    image = bake_into(objs, size, f"{cfg['name']}-spill-lod{k}")
    path = out / f"{cfg['name']}-spill-lod{k}.hdr"
    image.filepath_raw = str(path)
    image.file_format = "HDR"
    image.save()
    px = list(image.pixels)
    peak = max(px[i] for i in range(0, len(px), 4))
    print(f"[spill] LOD{k}: {len(objs)} meshes, {len(lamps)} lamps, {size}² → {path.name} (peak E {peak:.4g} game units)")
    lods.append({"file": path.name, "size": size, "lamps": len(lamps), "peakE": peak})
    for o in lamps:
        bpy.data.objects.remove(o, do_unlink=True)
    for o in objs:
        o.data.uv_layers.active = o.data.uv_layers[0]

# ── Restore and save ───────────────────────────────────────────────────────────────────
for o in bpy.data.objects:
    if o.name in render_state:
        o.hide_render = render_state[o.name]
    if o.name in view_state:
        o.hide_set(view_state[o.name][0])
        o.hide_viewport = view_state[o.name][1]
for name, (hv, hr) in coll_state.items():
    c = bpy.data.collections.get(name)
    if c:
        c.hide_viewport, c.hide_render = hv, hr
for name, (ex, hv) in lc_state.items():
    lc = layer_collection(view_layer.layer_collection, name)
    if lc:
        lc.exclude, lc.hide_viewport = ex, hv
for m in bpy.data.materials:
    if m.name in node_state:
        m.use_nodes = node_state[m.name]
for o in hidden_lights:
    o.hide_render = False
for m in bpy.data.materials:
    if m.name in saved_emission:
        m.node_tree.nodes.get("Principled BSDF").inputs["Emission Strength"].default_value = saved_emission[m.name]
if background is not None and saved_world is not None:
    background.inputs[1].default_value = saved_world
(out / f"{cfg['name']}-spill.json").write_text(json.dumps({
    "uv": UV, "units": "irradiance, game units (cd/6037.7 per m^2), before pre-exposure",
    "lods": lods, "calibration": power_per_unit,
}, indent=1))
bpy.ops.wm.save_mainfile()
print("[spill] saved", bpy.data.filepath)
