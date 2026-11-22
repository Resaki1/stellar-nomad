"""Packed PBR trims for the R4 fabricator, with one separate photovoltaic surface."""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "ships/starter-survey"))
from surfaces import bind_surface, grid_noise, tangent_normals


# Names, linear RGB, roughness, metallic. Each finish occupies one padded trim row.
FINISHES = {
    "ceramic": ((0.51, 0.42, 0.34), 0.59, 0.0),
    "patched": ((0.42, 0.35, 0.29), 0.66, 0.0),
    "frame": ((0.11, 0.13, 0.15), 0.48, 0.75),
    "graphite": ((0.030, 0.037, 0.047), 0.77, 0.0),
    "alloy": ((0.28, 0.25, 0.21), 0.32, 0.93),
    "amber": ((0.63, 0.25, 0.020), 0.61, 0.0),
    "tank": ((0.24, 0.18, 0.095), 0.41, 0.72),
    "radiator": ((0.20, 0.21, 0.19), 0.83, 0.0),
}


def mip(values, factor):
    h, w = values.shape[:2]
    return values.reshape(h//factor, factor, w//factor, factor, *values.shape[2:]).mean(axis=(1,3))


def station_trim(materials):
    height, width = 128, 512
    y, x = np.indices((height, width))
    u, v = (x + 0.5) / width, (y + 0.5) / height
    rng = np.random.default_rng(421)
    rows = []
    for name, (base, r, m) in FINISHES.items():
        macro = grid_noise(u, v, 8, rng)
        detail = grid_noise(u, v, 40, rng)
        grain = grid_noise(u, v, 100, rng)
        brush = grid_noise(u, v * 0.12, 86, rng)
        edges = np.exp(-np.abs(v - 0.10) * 19) + np.exp(-np.abs(v - 0.90) * 19)
        color = np.array(base) * (0.96 + 0.095 * macro + 0.065 * detail)[:, :, None]
        rough = r + 0.10 * macro + 0.07 * detail + 0.02 * grain
        metal = np.full_like(u, m)
        relief = 0.00025 * detail + 0.00006 * grain
        if name in ("ceramic", "patched", "amber"):
            # Grain stays restrained. Mask deeper coating loss to streaks near the trim edges.
            scratch = np.clip(2.2 * (brush + 0.30 * grain - 0.73), 0, 1)
            chips = np.clip(3.0 * (detail + 0.45 * grain - 0.89), 0, 1) * np.clip(edges, 0, 1)
            exposed = np.clip(0.68 * chips + 0.21 * scratch * edges, 0, 1)
            color *= (1.0 - 0.20 * edges * np.clip(0.5 + macro, 0, 1))[:, :, None]
            color = color * (1.0 - exposed[:, :, None]) + np.array((0.20, 0.17, 0.14)) * exposed[:, :, None]
            metal += 0.9 * exposed
            rough -= 0.24 * exposed
            relief -= 0.0010 * exposed + 0.0002 * scratch
        elif name in ("frame", "alloy", "tank"):
            rough += 0.085 * brush
            relief += 0.00010 * brush
        normal = tangent_normals(relief, 1 / width, 1 / height)
        rows.append((color, np.clip(rough, 0.16, 0.96), metal, normal))
    color, rough, metal, normal = (np.concatenate(channel) for channel in zip(*rows))
    bind_surface(materials[0], color, rough, metal, normal, normal_strength=0.58)
    for material, factor in zip(materials[1:], (4,16)):
        bind_surface(material, *(mip(channel, factor) for channel in (color, rough, metal)), None)


def photovoltaic(materials):
    height, width = 256, 512
    y, x = np.indices((height, width))
    u, v = (x + 0.5) / width, (y + 0.5) / height
    rng = np.random.default_rng(208)
    cell_x, cell_y = (u * 10).astype(int), (v * 5).astype(int)
    batch = rng.uniform(0.80, 1.17, (5, 10))[cell_y, cell_x]
    across, down = u * 10 % 1, v * 5 % 1
    gaps = (np.minimum(across, 1 - across) < 0.022) | (np.minimum(down, 1 - down) < 0.035)
    busbars = (np.abs(down - 0.30) < 0.018) | (np.abs(down - 0.70) < 0.018)
    fingers = across * 8 % 1 < 0.13
    color = np.array((0.025, 0.042, 0.067)) * batch[:, :, None]
    color[fingers] *= 1.24
    color[busbars] = (0.13, 0.115, 0.085)
    color[gaps] = (0.011, 0.014, 0.019)
    rough = 0.18 + 0.025 * grid_noise(u, v, 15, rng)
    # Conductors and cell gaps sit beneath the dielectric coverglass.
    for material, factor in zip(materials, (1,4,16)):
        bind_surface(material, mip(color, factor), mip(rough, factor), mip(np.zeros_like(u), factor), None)
