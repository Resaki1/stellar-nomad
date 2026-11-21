"""Generate the starter survey ship's packed glTF surface maps.

The hull atlas has a dorsal and ventral half in ship-local metres. The procedural
masks respond to the modeled panel boundaries, with separate wear seeds per plate.
"""
import zlib

import bpy
import numpy as np


ATLAS_SIZE = 512  # Each half is square.
X_MIN, X_MAX = -2.65, 2.65
Y_MIN, Y_MAX = -3.19, 1.43


def atlas_uv(x, y, dorsal):
    return ((x-X_MIN)/(X_MAX-X_MIN) + (0 if dorsal else 1))/2, (y-Y_MIN)/(Y_MAX-Y_MIN)


def grid_noise(u, v, scale, rng):
    grid = rng.uniform(-1, 1, (scale, scale))
    x, y = (u % 1)*scale, (v % 1)*scale
    a, b = x.astype(int), y.astype(int)
    s, t = x-a, y-b
    s, t = s*s*(3-2*s), t*t*(3-2*t)
    right, upper = (a+1) % scale, (b+1) % scale
    return (grid[b,a]*(1-s) + grid[b,right]*s)*(1-t) + (grid[upper,a]*(1-s) + grid[upper,right]*s)*t


def polygon_distance(x, y, outline):
    inside = np.zeros_like(x, dtype=bool)
    distance = np.full_like(x, np.inf)
    for a, b in zip(outline, outline[1:]+outline[:1]):
        dx, dy = b[0]-a[0], b[1]-a[1]
        length_sq = dx*dx + dy*dy
        if length_sq == 0:
            continue
        t = np.clip(((x-a[0])*dx + (y-a[1])*dy)/length_sq, 0, 1)
        distance = np.minimum(distance, np.hypot(x-a[0]-t*dx, y-a[1]-t*dy))
        if dy:
            inside ^= ((a[1] > y) != (b[1] > y)) & (x < a[0]+(y-a[1])*dx/dy)
    return np.where(inside, distance, -distance)


def packed_image(name, rgb, color_space):
    # Quantize once before packing so fine fluctuations do not dominate transfer size.
    rgb = np.rint(np.clip(rgb, 0, 1)*255).astype(np.float32)/255
    height, width, _ = rgb.shape
    image = bpy.data.images.new(name, width, height, alpha=False)
    image.colorspace_settings.name = color_space
    pixels = np.ones((height, width, 4), dtype=np.float32)
    pixels[:, :, :3] = rgb
    image.pixels.foreach_set(pixels.ravel())
    image.pack()
    return image


def tangent_normals(height, step_x, step_y):
    dy, dx = np.gradient(height, step_y, step_x)
    normal = np.stack((-dx,-dy,np.ones_like(dx)),axis=-1)
    normal /= np.linalg.norm(normal, axis=-1, keepdims=True)
    return normal*0.5 + 0.5


def bind_surface(mat, color, roughness, metalness, normal, normal_strength=1):
    tree = mat.node_tree
    shader = tree.nodes.get("Principled BSDF")
    height, width = roughness.shape
    mra = np.stack((np.ones((height, width)), roughness, metalness), axis=-1)
    maps = [
        packed_image(mat.name+" color", color, "sRGB"),
        packed_image(mat.name+" roughness and metal", mra, "Non-Color"),
    ]
    base, packed = [tree.nodes.new("ShaderNodeTexImage") for _ in maps]
    base.image, packed.image = maps
    channels = tree.nodes.new("ShaderNodeSeparateColor")
    tree.links.new(base.outputs["Color"], shader.inputs["Base Color"])
    tree.links.new(packed.outputs["Color"], channels.inputs["Color"])
    tree.links.new(channels.outputs["Green"], shader.inputs["Roughness"])
    tree.links.new(channels.outputs["Blue"], shader.inputs["Metallic"])
    if normal is not None:
        texture = tree.nodes.new("ShaderNodeTexImage")
        texture.image = packed_image(mat.name+" normal", normal, "Non-Color")
        node = tree.nodes.new("ShaderNodeNormalMap")
        node.inputs["Strength"].default_value = normal_strength
        tree.links.new(texture.outputs["Color"], node.inputs["Color"])
        tree.links.new(node.outputs["Normal"], shader.inputs["Normal"])


def armor_atlas(panels, mat, medium_mat):
    """Map service lines, scraped coating and irregular pits to actual panel surfaces."""
    size = ATLAS_SIZE
    step_x, step_y = (X_MAX-X_MIN)/size, (Y_MAX-Y_MIN)/size
    shape = (size, size*2)
    color = np.broadcast_to(np.array([0.43,0.36,0.29]), (*shape, 3)).copy()
    rough = np.full(shape, 0.61)
    metal = np.zeros(shape)
    normal = np.broadcast_to(np.array([0.5,0.5,1.0]), (*shape, 3)).copy()
    distances = np.full(shape, -np.inf)

    for name, outline, dorsal, lighter in panels:
        u,v = zip(*(atlas_uv(x,y,dorsal) for x,y in outline))
        left = max(0, int(min(u)*size*2)-12)
        right = min(size*2, int(max(u)*size*2)+13)
        bottom = max(0, int(min(v)*size)-12)
        top = min(size, int(max(v)*size)+13)
        iy, ix = np.mgrid[bottom:top,left:right]
        x = X_MIN + ((ix + 0.5) % size)*step_x
        y = Y_MIN + (iy + 0.5)*step_y
        distance = polygon_distance(x,y,outline)
        dst = np.s_[bottom:top,left:right]
        cover = distance >= distances[dst]
        distances[dst][cover] = distance[cover]
        rng = np.random.default_rng(zlib.crc32(name.encode()))
        u, v = (x-X_MIN)/(X_MAX-X_MIN), (y-Y_MIN)/(Y_MAX-Y_MIN)
        broad = grid_noise(u,v,10,rng)
        patch = grid_noise(u,v,43,rng)
        grain = grid_noise(u,v,220,rng)
        edge = np.maximum(0, distance)
        seal = np.exp(-edge/0.022)*np.clip(0.62+0.38*patch,0.1,1)
        chips = (edge < 0.012+0.009*patch) & (patch + 0.36*grain > 0.21)
        bare = chips.astype(float)*np.clip(0.6+0.5*grain,0.45,1)
        tone = (0.89+0.19*broad+0.085*patch+0.028*grain)*(1-0.49*seal)
        base = np.array([0.52,0.44,0.36] if lighter else [0.44,0.365,0.29])
        base *= rng.uniform(0.87,1.12)
        height = 0.00048*grain + 0.0007*patch - 0.0013*seal - 0.0014*bare

        # Short marks cluster along panel edges and service regions. The core of each
        # gouge changes height and roughness, while only deep marks expose the alloy.
        xmin,xmax = min(p[0] for p in outline), max(p[0] for p in outline)
        ymin,ymax = min(p[1] for p in outline), max(p[1] for p in outline)
        for _ in range(7):
            sx, sy = rng.uniform(xmin,xmax), rng.uniform(ymin,ymax)
            length = rng.uniform(0.028,0.115)
            angle = rng.uniform(-0.35,0.35)
            a = (x-sx)*np.sin(angle)+(y-sy)*np.cos(angle)
            b = (x-sx)*np.cos(angle)-(y-sy)*np.sin(angle)
            mark = np.exp(-((a/length)**2+(b/0.005)**2)*2.1)
            tone -= mark*0.23
            height -= mark*0.0024
            if rng.random() > 0.55:
                bare = np.maximum(bare, (mark > 0.5)*0.86)

        # Machined panel fastener collars leave persistent contact discoloration.
        cx, cy = np.mean(outline, axis=0)
        for px,py in outline:
            px,py = px*0.93+cx*0.07, py*0.93+cy*0.07
            ring = np.hypot(x-px,y-py)
            halo = np.exp(-((ring-0.022)/0.013)**2)
            tone -= halo*0.25
            height -= halo*0.0009

        rgb = tone[:,:,None]*base
        alloy = np.array([0.29,0.255,0.215])
        rgb = rgb*(1-bare[:,:,None]) + alloy*bare[:,:,None]
        color[dst][cover] = rgb[cover]
        rough[dst][cover] = np.clip(0.64+0.14*broad+0.1*patch+seal*0.18-bare*0.23,0.33,0.89)[cover]
        metal[dst][cover] = bare[cover]
        normal[dst][cover] = tangent_normals(height,step_x,step_y)[cover]

    bind_surface(mat,color,rough,metal,normal)
    # The medium model keeps the same panel pattern without its close-up texture cost.
    def quarter(values):
        return values.reshape(size//4,4,size//2,4,*values.shape[2:]).mean(axis=(1,3))
    bind_surface(medium_mat,quarter(color),quarter(rough),quarter(metal),None)


def exhaust_liner(mat):
    """Circumferential cooling channels and oxide bands on the hot liner."""
    iy, ix = np.indices((128,256))
    u,v = (ix+0.5)/256, (iy+0.5)/128
    rng = np.random.default_rng(82)
    grain = grid_noise(u,v,34,rng)
    lanes = 0.5+0.5*np.cos(2*np.pi*36*u)
    throat = np.exp(-((v-0.10)/0.19)**2)
    oxide = np.exp(-((v-0.33-0.063*grain)/0.13)**2)
    temper = np.exp(-((v-0.52-0.045*grain)/0.10)**2)
    base = np.array([0.112,0.103,0.090])
    color = base*(0.61+0.29*lanes[:,:,None]+0.13*grain[:,:,None])
    color += oxide[:,:,None]*np.array([0.015,0.023,0.047])
    color += temper[:,:,None]*np.array([0.034,0.012,0.001])
    color *= (0.38 + 0.62*np.clip((v-0.12)/0.78,0,1))[:,:,None]
    color *= 1-0.61*throat[:,:,None]
    # Hot inner sections have a rough, deposited carbon layer. Exposed nickel
    # gradually returns toward the aft edge and is distinct from the machined lip.
    exposed = np.clip((v-0.32)/0.44,0,1)
    exposed = exposed*exposed*(3-2*exposed)
    alloy_rough = np.clip(0.50+0.12*grain-0.08*lanes,0.36,0.68)
    rough = (1-exposed)*0.94 + exposed*alloy_rough
    metal = exposed*0.95
    normal = tangent_normals(0.0024*lanes+0.0004*grain,2.1/256,0.44/128)
    bind_surface(mat,color,rough,metal,normal)


def wing_surfaces(mat, medium_mat, far_mat):
    """Dorsal cells under smooth dielectric coverglass. Ventral thermal coating."""
    size = 256
    iy, ix = np.indices((size,size))
    u,v = (ix+0.5)/size, (iy+0.5)/size
    rng = np.random.default_rng(204)
    col, row = u*7, v*11
    xa, ya = col % 1, row % 1
    edge = np.minimum(np.minimum(xa,1-xa),np.minimum(ya,1-ya))
    gasket = np.clip(1-edge/0.036,0,1)
    bias = rng.uniform(0.72,1.23,(11,7))[row.astype(int),col.astype(int)]
    grain = grid_noise(u,v,40,rng)
    fingers = (0.5+0.5*np.cos(2*np.pi*v*88))**6
    bus = np.exp(-((xa-0.28)/0.028)**2) + np.exp(-((xa-0.72)/0.028)**2)

    # The blue absorber sits below the glass. Metal stays at zero at the exposed
    # glass surface, so the highlight comes from a narrow dielectric specular lobe.
    cell_value = bias*(0.94+0.09*grain)*(1-0.62*gasket)
    cell = cell_value[:,:,None]*np.array([0.032,0.049,0.081])
    cell += (bus*0.009+fingers*0.003)[:,:,None]
    cell_rough = np.clip(0.18+0.026*grain+0.54*gasket,0.13,0.72)

    # A neutral, diffuse inorganic coating on the underside rejects waste heat.
    ventral = (0.94+0.14*grain)*(1-0.43*gasket)
    radiator = ventral[:,:,None]*np.array([0.22,0.226,0.235])
    radiator_rough = np.clip(0.76+0.07*grain+0.12*gasket,0.64,0.94)
    color = np.concatenate((cell,radiator),axis=1)
    rough = np.concatenate((cell_rough,radiator_rough),axis=1)
    metal = np.zeros_like(rough)
    bind_surface(mat,color,rough,metal,None)

    for target, downsize in [(medium_mat,2),(far_mat,16)]:
        def reduced(values):
            return values.reshape(size//downsize,downsize,2*size//downsize,downsize,*values.shape[2:]).mean(axis=(1,3))
        bind_surface(target,reduced(color),reduced(rough),reduced(metal),None)


def machinery_trim(mat, medium_mat):
    """One packed material for four finishes on the exposed fittings and structure."""
    size, band_height = 512, 128
    iy, ix = np.indices((band_height,size))
    u,v = (ix+0.5)/size, (iy+0.5)/band_height
    rng = np.random.default_rng(288)
    color_rows, rough_rows, metal_rows = [], [], []
    for base, r, m in [
        ((0.093,0.084,0.072),0.57,0.93),     # machined dark structural alloy
        ((0.038,0.040,0.042),0.76,0.05),     # coated and composite housings
        ((0.24,0.22,0.185),0.37,0.96),       # machined bare fittings
        ((0.67,0.29,0.022),0.61,0.0),        # amber safety coating
    ]:
        long = grid_noise(u,v,9,rng)
        grain = grid_noise(u,v,45,rng)
        brush = grid_noise(u*0.13,v,105,rng)
        streak = np.clip(brush + 0.55*grain-0.63,0,1)
        worn = np.clip((brush + grain - 0.90)*2,0,1)*0.6 if m < 0.1 else np.zeros_like(grain)
        color = np.array(base)*(0.92+0.18*long+0.13*grain+0.12*streak)[:,:,None]
        color = color*(1-worn[:,:,None])+np.array([0.29,0.26,0.21])*worn[:,:,None]
        color_rows.append(color)
        rough_rows.append(np.clip(r+0.16*long+0.12*grain-0.23*streak,0.28,0.94))
        metal_rows.append(m*(1-worn)+worn)
    maps = [np.concatenate(rows) for rows in (color_rows, rough_rows, metal_rows)]
    bind_surface(mat,*maps,None)
    bind_surface(medium_mat,*(values.reshape(size//4,4,size//4,4,*values.shape[2:]).mean(axis=(1,3))
                               for values in maps),None)
