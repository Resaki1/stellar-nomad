#!/usr/bin/env python3
"""
bake_weather_map.py — Weather Map v2 baker from ERA5 reanalysis
(CLOUD_TYPES_PLAN.md Phase 4, §4.7).

Turns ONE real timestamp of ERA5 data into the RGBA control stack the cloud
system consumes (same channel semantics as the synthetic weatherMapV2.ts):

  R = coverage      low+mid cloud cover (random-overlap) FRACTION, then
                    converted to PLACED coverage at bake time: the fraction
                    thresholds a BAND-LIMITED value-noise fBm (16-125 km cells,
                    all Nyquist-safe at 8k — see the ENRICH_* block) so the
                    8192×4096 output carries mippable, alias-free cloud-system
                    structure. (--no-placement writes the raw fraction.)
  G = convectivity  CAPE / CAPE_MAX                               [LINEAR]
  B = topHeight     top of the lowest contiguous cloud system per column,
                    km-anchored: 0 → 2.3 km, 1 → 13.35 km (the EXACT inverse
                    of cloudShared.topHeightToTopAlt, so real km render at
                    real km; tropical tops >13.35 km clamp to 1 — the
                    turret/anvil headroom takes it from there)   [LINEAR]
  A = cirrus        high cloud cover (the Phase-5 shell input)    [LINEAR]

All mappings are LINEAR (the §3.6-H4 anti-bimodal rule: never smoothstep a
data distribution into bands). Local 10-40 km organization + per-cell tower
variance are NOT baked — the marcher synthesizes them (resolution fork
option b); ERA5 is 0.25° ≈ 28 km/px and only carries the synoptic fields.

── USAGE ───────────────────────────────────────────────────────────────────
0) One-time setup (a venv anywhere; needs a free account at
   https://cds.climate.copernicus.eu with the key in ~/.cdsapirc — two lines:
   `url: https://cds.climate.copernicus.eu/api` and `key: <your-uuid>`;
   NEVER commit the key):

     python3 -m venv .venv-weather
     .venv-weather/bin/pip install numpy netCDF4 Pillow cdsapi

1) Download the two ERA5 inputs (or --print-request to run/paste yourself).
   Default timestamp: 2005-08-28 18:00 UTC (Hurricane Katrina at peak — a
   photogenic known-good candidate per the §6 decision; override with
   --date/--time). ERA5 requests queue on CDS — expect minutes, not seconds:

     .venv-weather/bin/python scripts/bake_weather_map.py --download

   And the SAME-DATE MODIS true-color composites (Terra + Aqua) from NASA
   GIBS (free, no account) — Terra becomes Earth's R channel, Aqua fills
   Terra's swath gaps with real pixels (see the GIBS block below):

     .venv-weather/bin/python scripts/bake_weather_map.py --download-image

2) Bake. RECOMMENDED coverage source = a CLEAN global cloud composite (the
   Blue Marble cloud layer) via --coverage-texture: seam/glint-free, unlike
   same-day MODIS true-color (--cloud-image) whose swath-gap merges + sun-
   glint read as coverage (2026-07-13 seam diagnosis). The G/B/A physics
   channels are ERA5 either way.

     .venv-weather/bin/python scripts/bake_weather_map.py \
       --single era5_single.nc --pressure era5_pressure.nc \
       --coverage-texture public/textures/earth_clouds_8k.webp \
       --out public/textures/weather/era5_2005082818.png

   Alternatives for R: --cloud-image[+--cloud-image-2] (authentic same-day
   MODIS, has swath/glint seams); neither (procedural — the alien-planet
   path); --no-placement (raw ERA5 fraction, debug).

3) Convert to KTX2 — EXPLICIT --linear (this is DATA: the filename
   auto-detect in convert-to-ktx2.sh will NOT catch it, and an sRGB-decoded
   weather map silently corrupts every channel — the documented footgun):

     ./scripts/convert-to-ktx2.sh --linear public/textures/weather/era5_2005082818.png

4) Point REAL_WEATHER_MAP_PATH (earthClouds.ts) at the .ktx2 and flip
   REAL_WEATHER_MAP to true. Full reload (fresh light-volume bake).

Deps: pip install numpy netCDF4 Pillow
"""

import argparse
import sys

DEFAULT_DATE = "2005-08-28"  # Hurricane Katrina at peak strength (Cat 5, Gulf)
DEFAULT_TIME = "18:00"

# Pressure levels (hPa) for the cloud-fraction profile. Spans ~0.1-16.2 km in
# the standard atmosphere — the whole cloud slab with margin.
PRESSURE_LEVELS = [
    1000, 975, 950, 925, 900, 875, 850, 825, 800, 775, 750,
    700, 650, 600, 550, 500, 450, 400, 350, 300, 250, 225,
    200, 175, 150, 125, 100,
]

# Channel-mapping constants (all tunable).
# G = sqrt(CAPE / CAPE_REF): raw CAPE is far too peaky for a linear map — the
# first bake measured convectivity p50 = 0.001 (the whole planet rendered
# stratiform; every genus feature silent). sqrt is a monotone concave rescale
# of a PHYSICAL proxy (not a smoothstep on a noise distribution — the §3.6-H4
# anti-bimodal rule targets the latter): shallow-cumulus CAPE ~100-500 J/kg
# lands at 0.22-0.5, moderate ~1000 at 0.7, deep ≥2000 saturates.
CAPE_REF = 2000.0
CC_THRESH = 0.05  #  cloud fraction that counts as "cloud" in the profile
GAP_LEVELS = 2  #    contiguity: a >=2-level clear gap ends the lowest system
# km anchoring — MUST match cloudShared.topHeightToTopAlt (TOP_KM_MIN/MAX):
TOP_KM_MIN = 2.3
TOP_KM_MAX = 13.35

# ── BAND-LIMITED fraction→placement (the far-field/orbit fix, v2 2026-07-11) ──
# ERA5's R is an AREA FRACTION per 28 km cell; rendered directly the far shell
# is washed-out fraction soup with texel-edge blocks. The AAA pattern for the
# orbit view is a MIPPABLE 2D map already carrying cloud-SYSTEM placement (a
# photo, artist map, or a composite bake). So the baker ENRICHES the coarse
# fraction with system-scale structure and thresholds it into placed coverage
# at 8192×4096 (≈4.9 km/texel — the Blue Marble regime; KTX2 mips do the rest).
#
# THE v1 BUG (proven): v1 synthesized at freqs 8/16 of a 62.5 km tile = 7.8 &
# 3.9 km cells = 1.6 & 0.8 texels/cell — BELOW the 2-texel Nyquist limit. That
# aliased per-texel noise is baked into the source (visible stipple; mips can't
# fix base-level garbage; grazing-angle mip transitions showed it as rings).
# FIX: a band-limited value-noise fBm on a LARGER 500 km tile — octaves 4/8/16/
# 32 = 125/62/31/16 km cells (25/13/6.4/3.2 texels), all Nyquist-safe (verified
# in JS: max adjacent-texel jump 0.306 → 0.048). A THRESHOLD of a band-limited
# field is itself band-limited (edges follow smooth iso-contours, not per-texel
# noise) → structured clouds, alias-free. Domain-warped for filament/swirl
# character. NOTE: ~16-31 km is the finest structure an 8k map can hold —
# individual clouds (1-10 km) are sub-texel here (as they are in the Blue
# Marble photo too); the near volumetric owns everything below ~16 km.
#
# The runtime (cloudShared.fractionPlacement) turns itself OFF for the real map
# (the near marcher reads this baked R directly, like it read the Blue Marble),
# so baker + runtime are DECOUPLED — this threshold is the baker's own; it need
# not match the runtime synthetic-map calibration.
EARTH_R_KM = 6372.0  # inner cloud shell (the sphere-noise projection radius)
ENRICH_TILE_KM = 500.0  # noise tile; octaves 4/8/16/32 → 125/62/31/16 km cells
ENRICH_OCTAVES = [4, 8, 16, 32]
ENRICH_WEIGHTS = [0.5, 0.25, 0.125, 0.0625]
ENRICH_WARP_FREQ = 2.0  # domain-warp octave (~250 km) → filaments/swirls
ENRICH_WARP_AMP = 0.25  # warp displacement in tile units (~125 km)
PLACEMENT_EDGE = 0.16  # soft threshold half-width (fluffy, mippable edges)
PLACEMENT_MIN_COV_LO = 0.03  # kill placement below tiny fractions (no ghosts)
PLACEMENT_MIN_COV_HI = 0.12

# ── REAL SATELLITE IMAGE as Earth's R channel (the Blue-Marble-level answer) ──
# The strategic split (user-approved 2026-07-12): ERA5 is the right data for
# PHYSICS (G/B/A — type/height/cirrus at 28 km is fine) and the WRONG data for
# APPEARANCE (no shape information below 28 km; every synthesis of the missing
# detail is invented). Blue Marble looks good because it is a real MODIS
# photograph — so Earth's R comes from real MODIS imagery OF THE SAME DATE
# (NASA GIBS, daily global composites back to 2000; no API key needed), and
# the procedural enrichment above remains the R-source for procedurally
# generated planets. Cloud extraction: clouds are BRIGHT and NEUTRAL —
# min(R,G,B) is high for white clouds, low for dark ocean/vegetation AND for
# tan deserts (their blue channel is low) → a soft ramp on minRGB is the
# coverage. Two correctors:
#   • no-data (black swath gaps between polar-orbiter passes + polar night)
#     → filled with the PROCEDURAL placement driven by the same ERA5 fraction
#     (feathered mask → invisible seams);
#   • ERA5-consistency veto: image-bright where ERA5 low+mid fraction ≈ 0 is
#     SNOW/ICE or a pure-CIRRUS veil, not a low/mid deck → suppress softly
#     (kills Greenland-as-permanent-cloud and phantom decks under lone cirrus).
GIBS_WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"
GIBS_LAYER = "MODIS_Terra_CorrectedReflectance_TrueColor"
# Aqua flies ~3 h behind Terra with OFFSET swath gaps — merging the same-day
# Aqua composite under Terra fills most of Terra's no-data wedges with REAL
# imagery (procedural fill then only covers the residual, mostly polar night).
GIBS_LAYER_2 = "MODIS_Aqua_CorrectedReflectance_TrueColor"
# Extraction ramp. HI=0.90 (was 0.55): the first image bake measured placed-R
# p50 = 1.0 — half the planet pinned at full white because everything above
# minRGB 0.55 CLIPPED, deleting the photo's interior texture (cell shadows,
# thin spots — the exact detail that makes Blue Marble read as rich). The wide
# ramp maps cloud interiors to VARIED 0.5-1.0 coverage instead. Deserts stay
# excluded (Sahara's blue channel ≈ 0.35-0.45 → ramp ≈ 0).
IMG_CLOUD_LO = 0.3  # minRGB at/below → no cloud (ocean/land/desert)
IMG_CLOUD_HI = 0.9  # minRGB at/above → full cloud
IMG_NODATA_MAX = 0.04  # maxRGB below → swath gap / polar night
# Aqua-fill haze floor (seam diagnosis 2026-07-12, PROVEN on the baked R +
# source crops): Terra's gap wedges land on Aqua's scan-EDGE/glint zones —
# bright neutral HAZE that the ramp read as phantom 0.3-0.6 coverage →
# glowing razor-edged wedge bands in-game. Inside Aqua-filled areas the
# extraction floor rises toward this value (weighted by the fill mask), so
# haze reads as clear while real bright clouds survive.
AQUA_FILL_LO = 0.42
VETO_FRACTION_LO = 0.0  # ERA5 low+mid fraction ramp that re-permits image cloud
VETO_FRACTION_HI = 0.08

OUT_W, OUT_H = 8192, 4096


def cds_requests(date: str, time: str):
    """The two CDS retrievals as (dataset, request, out_file) tuples."""
    y, m, d = date.split("-")
    single = (
        "reanalysis-era5-single-levels",
        {
            "product_type": "reanalysis",
            "variable": [
                "low_cloud_cover",
                "medium_cloud_cover",
                "high_cloud_cover",
                "total_cloud_cover",
                "convective_available_potential_energy",
            ],
            "year": y, "month": m, "day": d, "time": time,
            "data_format": "netcdf", "download_format": "unarchived",
        },
        "era5_single.nc",
    )
    pressure = (
        "reanalysis-era5-pressure-levels",
        {
            "product_type": "reanalysis",
            "variable": ["fraction_of_cloud_cover"],
            "pressure_level": [str(p) for p in PRESSURE_LEVELS],
            "year": y, "month": m, "day": d, "time": time,
            "data_format": "netcdf", "download_format": "unarchived",
        },
        "era5_pressure.nc",
    )
    return [single, pressure]


def print_request(date: str, time: str) -> None:
    print("import cdsapi\nc = cdsapi.Client()")
    for dataset, req, out in cds_requests(date, time):
        print(f'c.retrieve("{dataset}", {req!r}, "{out}")')


def download(date: str, time: str) -> int:
    try:
        import cdsapi  # type: ignore
    except ImportError:
        print("pip install cdsapi  (and put your key in ~/.cdsapirc)", file=sys.stderr)
        return 1
    c = cdsapi.Client()
    for dataset, req, out in cds_requests(date, time):
        print(f"requesting {dataset} → {out} (CDS queues jobs; this can take minutes)")
        c.retrieve(dataset, req, out)
        print(f"  done: {out}")
    print("\nnext:  bake with --single era5_single.nc --pressure era5_pressure.nc")
    return 0


def gibs_url(date: str, layer: str) -> str:
    """WMS GetMap for a global daily MODIS true-color composite. WMS 1.3.0
    + EPSG:4326 = lat/lon axis order (BBOX = minLat,minLon,maxLat,maxLon);
    north-up, −180..180 → matches the map convention with no roll."""
    return (
        f"{GIBS_WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0"
        f"&LAYERS={layer}&STYLES=&CRS=EPSG:4326"
        f"&BBOX=-90,-180,90,180&WIDTH={OUT_W}&HEIGHT={OUT_H}"
        f"&FORMAT=image/jpeg&TIME={date}"
    )


def download_image(date: str) -> int:
    """Fetch the same-date MODIS Terra AND Aqua true-color composites from
    NASA GIBS (free, no key). ~10-40 MB each; a minute or two per file."""
    import urllib.request

    outs = []
    for layer, tag in ((GIBS_LAYER, "terra"), (GIBS_LAYER_2, "aqua")):
        out = f"era5_gibs_{date}_{tag}.jpg"
        url = gibs_url(date, layer)
        print(f"fetching {layer} for {date} from GIBS...\n  {url}")
        urllib.request.urlretrieve(url, out)
        print(f"  done: {out}")
        outs.append(out)
    print(
        f"\nnext:  bake with --cloud-image {outs[0]} --cloud-image-2 {outs[1]}"
        " (+ --single/--pressure)"
    )
    return 0


def _load_image_rgb(path):
    """(rgb float32 0-1 at OUT_W×OUT_H, valid bool) — invalid = swath gap /
    polar night (near-black in the composite)."""
    import numpy as np
    from PIL import Image

    im = Image.open(path).convert("RGB")
    if im.size != (OUT_W, OUT_H):
        im = im.resize((OUT_W, OUT_H), Image.BILINEAR)
    rgb = np.asarray(im, dtype=np.float32) / 255.0
    return rgb, rgb.max(axis=-1) > IMG_NODATA_MAX


def _erode(mask, k=2):
    """Shrink a validity mask by k px — JPEG-degraded pixels at the swath-gap
    rim are dark-but-not-black and slip past IMG_NODATA_MAX otherwise."""
    import numpy as np

    out = mask.copy()
    for dy in range(-k, k + 1):
        for dx in range(-k, k + 1):
            out &= np.roll(np.roll(mask, dy, 0), dx, 1)
    return out


def image_coverage(path, path2, fraction_hi):
    """Extract placed cloud coverage from same-date satellite true-color
    imagery (see the GIBS block for the method + correctors). The second
    image (Aqua) fills the first's (Terra's) swath gaps with real pixels via
    a FEATHERED blend (σ ≈ 17 km) — the 2026-07-12 seam diagnosis proved a
    hard np.where merge leaves razor wedge outlines — and the extraction
    floor rises toward AQUA_FILL_LO inside the fill (scan-edge haze
    suppression, see that constant). Returns (coverage float32, valid bool)
    at OUT_W×OUT_H; remaining invalid = gaps in BOTH (mostly polar night)."""
    import numpy as np

    rgb, valid = _load_image_rgb(path)
    valid = _erode(valid)
    aqua_w = None
    if path2:
        rgb2, valid2 = _load_image_rgb(path2)
        valid2 = _erode(valid2)
        # Feathered Terra weight: 1 deep in Terra data, →0 inside its gaps,
        # soft over ~17 km; never weight toward a satellite that has no data.
        w_t = smooth_grid(valid.astype(np.float32), passes=24).astype(np.float32)
        w_t = np.where(valid, w_t, 0.0)
        w_t = np.where(valid2, w_t, 1.0)
        rgb = rgb * w_t[..., None] + rgb2 * (1.0 - w_t[..., None])
        aqua_w = np.where(valid | valid2, 1.0 - w_t, 0.0).astype(np.float32)
        valid = valid | valid2
    min_rgb = rgb.min(axis=-1)
    lo = (
        IMG_CLOUD_LO
        if aqua_w is None
        else IMG_CLOUD_LO + (AQUA_FILL_LO - IMG_CLOUD_LO) * aqua_w
    )
    cloud = smoothstep01(lo, IMG_CLOUD_HI, min_rgb)
    # ERA5-consistency veto (snow/ice + pure-cirrus false positives).
    cloud = cloud * smoothstep01(VETO_FRACTION_LO, VETO_FRACTION_HI, fraction_hi)
    return cloud.astype(np.float32), valid


def pressure_to_km(p_hpa):
    """Barometric standard atmosphere. Slight underestimate above ~11 km —
    fine for our purposes (values above TOP_KM_MAX clamp to 1 anyway)."""
    import numpy as np

    return 44.33 * (1.0 - (np.asarray(p_hpa, dtype=np.float64) / 1013.25) ** 0.1903)


def read_var(ds, *names):
    """Fetch the first matching variable name (ERA5 NetCDF names vary between
    the legacy and the 2024+ CDS backends)."""
    import numpy as np

    for n in names:
        if n in ds.variables:
            v = ds.variables[n][:]
            # masked → filled (ERA5 fields are complete; belt-and-suspenders
            # against fill values leaking huge numbers into the channels)
            a = np.ma.filled(v, 0.0).astype(np.float64)
            # squeeze the time dimension (single timestamp)
            return a.reshape(a.shape[-2], a.shape[-1]) if a.ndim > 2 else a
    raise KeyError(f"none of {names} found; file has {list(ds.variables)}")


def smooth_grid(a, passes=2):
    """~Gaussian smoothing on the NATIVE ERA5 grid (separable 3-tap binomial
    ×passes; x wraps around the antimeridian, y clamps at the poles). Rounds
    the 0.25° block corners that bilinear upsampling otherwise exposes as
    stair-stepped cloud edges (first-bake verdict: 'blocky'). σ ≈ 0.7·√passes
    native px ≈ 20-30 km — below anything the data resolves anyway."""
    import numpy as np

    f = a.astype(np.float64)
    for _ in range(passes):
        # x (wrap)
        f = 0.25 * np.roll(f, 1, 1) + 0.5 * f + 0.25 * np.roll(f, -1, 1)
        # y (clamp)
        up = np.vstack([f[:1], f[:-1]])
        dn = np.vstack([f[1:], f[-1:]])
        f = 0.25 * up + 0.5 * f + 0.25 * dn
    return f


def smoothstep01(a, b, x):
    import numpy as np

    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def _value_noise3(P):
    """C1-smooth trilinear value noise (sin-hash lattice, non-periodic →
    no tiling seam on the sphere). P: (N,3) → (N,) in ~[0,1].

    FLOAT64 IS MANDATORY: the sin-hash multiplies lattice coords (up to ~800
    at the finest octave) by 43758 → magnitudes ~2.6e10. In float32 (24-bit
    mantissa) everything above 2^24≈16.7M loses ALL fractional precision, so
    `s - floor(s)` returns garbage/near-constant → the noise degenerates and
    the placement threshold empties the planet (the 2026-07-11 area collapse,
    placed mean 0.136 vs 0.567). float64 keeps ~5-6 fractional digits here."""
    import numpy as np

    P = np.asarray(P, dtype=np.float64)
    i = np.floor(P)
    f = P - i
    w = f * f * (3.0 - 2.0 * f)  # smoothstep interp weights

    def h(dx, dy, dz):
        s = (
            (i[:, 0] + dx) * 127.1
            + (i[:, 1] + dy) * 311.7
            + (i[:, 2] + dz) * 74.7
        ) * 43758.5453
        return s - np.floor(s)

    def lerp(a, b, t):
        return a + (b - a) * t

    x00 = lerp(h(0, 0, 0), h(1, 0, 0), w[:, 0])
    x10 = lerp(h(0, 1, 0), h(1, 1, 0), w[:, 0])
    x01 = lerp(h(0, 0, 1), h(1, 0, 1), w[:, 0])
    x11 = lerp(h(0, 1, 1), h(1, 1, 1), w[:, 0])
    y0 = lerp(x00, x10, w[:, 1])
    y1 = lerp(x01, x11, w[:, 1])
    return lerp(y0, y1, w[:, 2])


def synth_enrichment_field(width, height, row0, rows):
    """BAND-LIMITED value-noise fBm on the sphere for equirect rows
    [row0, row0+rows): domain-warped, octaves ENRICH_OCTAVES over a large
    ENRICH_TILE_KM tile so every octave is Nyquist-safe at 8k (see the
    ENRICH_* block). Returns ~[0,1] normalized. Adds cloud-SYSTEM structure
    (filaments/breaks/cores at 16-125 km) the coarse ERA5 fraction lacks."""
    import numpy as np

    # Equirect texel centres → unit dirs (inverse of equirectDirToUv at
    # offset 0: u = atan2(z,−x)/2π, v = acos(−y)/π).
    v = (np.arange(row0, row0 + rows, dtype=np.float64) + 0.5) / height
    u = (np.arange(width, dtype=np.float64) + 0.5) / width
    st, ct = np.sin(v * np.pi)[:, None], np.cos(v * np.pi)[:, None]
    cp, sp = np.cos(u * 2 * np.pi)[None, :], np.sin(u * 2 * np.pi)[None, :]
    dirs = np.stack(
        [
            (-st * cp).ravel(),
            np.broadcast_to(-ct, (rows, width)).ravel(),
            (st * sp).ravel(),
        ],
        axis=-1,
    ).astype(np.float32)

    base = dirs * np.float32(EARTH_R_KM / ENRICH_TILE_KM)  # tile units

    # Domain warp (low-freq vector noise) → filaments/swirls instead of
    # isotropic blobs. Three decorrelated noise fields via coordinate offsets.
    wf = np.float32(ENRICH_WARP_FREQ)
    warp = np.stack(
        [
            _value_noise3(base * wf + np.float32(o))
            for o in (17.3, 43.1, 71.7)
        ],
        axis=-1,
    ).astype(np.float32) - np.float32(0.5)
    p = base + warp * np.float32(ENRICH_WARP_AMP)

    total = np.zeros(len(p), dtype=np.float32)
    wsum = 0.0
    for freq, weight in zip(ENRICH_OCTAVES, ENRICH_WEIGHTS):
        total += np.float32(weight) * _value_noise3(
            p * np.float32(freq) + np.float32(freq) * 13.1
        )
        wsum += weight
    total /= np.float32(wsum)  # → ~[0,1], mean ~0.5
    # Mild contrast stretch about the mean so the fBm is closer to uniform
    # (tighter area-mean control at the threshold below). Still band-limited.
    total = np.clip((total - 0.5) * 1.4 + 0.5, 0, 1)
    return total.reshape(rows, width)


def bake_placement(coverage_hi):
    """Threshold the (upsampled, smoothed) fraction by the BAND-LIMITED
    enrichment field → placed coverage with system-scale structure, alias-free.
    A threshold of a band-limited field is band-limited (edges = smooth
    iso-contours). Mean-preserving-ish: thr = 1−cov (noise ~uniform-ish →
    P(noise>1−cov) ≈ cov); the baker prints the fraction-vs-placed area check."""
    import numpy as np

    h, w = coverage_hi.shape
    placed = np.zeros_like(coverage_hi, dtype=np.float32)
    chunk = 128
    for row0 in range(0, h, chunk):
        rows = min(chunk, h - row0)
        g = synth_enrichment_field(w, h, row0, rows)
        cov = coverage_hi[row0 : row0 + rows]
        thr = 1.0 - cov  # mean-preserving soft threshold
        placed[row0 : row0 + rows] = smoothstep01(
            thr - PLACEMENT_EDGE, thr + PLACEMENT_EDGE, g
        ) * smoothstep01(PLACEMENT_MIN_COV_LO, PLACEMENT_MIN_COV_HI, cov)
        if row0 % 1024 == 0:
            print(f"  placement rows {row0}/{h}...")
    return placed


def fill_from_neighbours(field, valid, iters=64):
    """Fill invalid texels from valid neighbours (repeated 4-neighbour
    dilation with wrap in x). Keeps B continuous where there is no cloud so
    bilinear filtering never blends against garbage."""
    import numpy as np

    f = field.copy()
    v = valid.copy()
    for _ in range(iters):
        if v.all():
            break
        shifted = [
            (np.roll(f, 1, 1), np.roll(v, 1, 1)),
            (np.roll(f, -1, 1), np.roll(v, -1, 1)),
        ]
        # y-shifts without wrap (poles)
        fy1 = f.copy(); vy1 = np.zeros_like(v)
        fy1[1:, :] = f[:-1, :]; vy1[1:, :] = v[:-1, :]
        fy2 = f.copy(); vy2 = np.zeros_like(v)
        fy2[:-1, :] = f[1:, :]; vy2[:-1, :] = v[1:, :]
        shifted += [(fy1, vy1), (fy2, vy2)]
        num = np.zeros_like(f)
        den = np.zeros_like(f)
        for sf, sv in shifted:
            num += np.where(sv, sf, 0.0)
            den += sv.astype(np.float64)
        newly = (~v) & (den > 0)
        f[newly] = (num[newly] / den[newly])
        v = v | newly
    f[~v] = 0.0
    return f


def bake(args) -> int:
    import numpy as np
    from netCDF4 import Dataset  # type: ignore
    from PIL import Image

    ds_s = Dataset(args.single)
    ds_p = Dataset(args.pressure)

    lcc = np.clip(read_var(ds_s, "lcc", "low_cloud_cover"), 0, 1)
    mcc = np.clip(read_var(ds_s, "mcc", "medium_cloud_cover"), 0, 1)
    hcc = np.clip(read_var(ds_s, "hcc", "high_cloud_cover"), 0, 1)
    cape = np.maximum(
        read_var(ds_s, "cape", "convective_available_potential_energy"), 0
    )

    # ── R: low+mid coverage, random overlap ──
    coverage = 1.0 - (1.0 - lcc) * (1.0 - mcc)

    # ── G: convectivity = sqrt(CAPE / CAPE_REF) (see CAPE_REF note) ──
    conv = np.clip(np.sqrt(np.maximum(cape, 0) / CAPE_REF), 0, 1)

    # ── B: top of the LOWEST CONTIGUOUS cloud system (real per-column tops) ──
    # Cirrus-over-stratus must NOT fake a 11 km-top stratus sheet: scan up from
    # the lowest cloudy level and stop at the first >=GAP_LEVELS clear gap.
    cc = np.ma.filled(ds_p.variables["cc"][:], 0.0).astype(np.float64)
    cc = cc.reshape(cc.shape[-3], cc.shape[-2], cc.shape[-1])  # (lev, lat, lon)
    levs = np.asarray(ds_p.variables[
        "pressure_level" if "pressure_level" in ds_p.variables else "level"
    ][:], dtype=np.float64)
    order = np.argsort(levs)[::-1]  # 1000 hPa (low) → 100 hPa (high)
    cc = cc[order]
    lev_km = pressure_to_km(levs[order])  # ascending km

    nlev, nlat, nlon = cc.shape
    cloudy = cc >= CC_THRESH
    top_km = np.zeros((nlat, nlon))
    in_system = np.zeros((nlat, nlon), dtype=bool)
    started = np.zeros((nlat, nlon), dtype=bool)
    gap = np.zeros((nlat, nlon), dtype=np.int32)
    for k in range(nlev):
        c = cloudy[k]
        enter = c & ~started
        started |= enter
        in_system |= enter
        cont = c & in_system
        top_km[cont] = lev_km[k]
        gap[in_system & ~c] += 1
        gap[c] = 0
        in_system &= gap < GAP_LEVELS

    valid = started
    top01 = np.clip((top_km - TOP_KM_MIN) / (TOP_KM_MAX - TOP_KM_MIN), 0, 1)
    # Continuous fill where no cloud exists (bilinear-filter safety; §4.2
    # floater rule: the filled value carries NO cloud IF R≈0 there — but with
    # REAL MODIS coverage R and ERA5 topHeight decorrelated, MODIS clouds DO
    # land where ERA5 found no system, so the filled height is visible).
    top01 = fill_from_neighbours(top01, valid, iters=128)
    # STRONG smooth (2026-07-13, "hard straight seams in the shell"): the
    # nearest-neighbour fill above produces Voronoi PLATEAUS with hard fronts
    # where fills from different cloud systems meet; the km-anchored profile
    # renders those fronts as straight cloud-top height cliffs ("one side
    # completely different"). topHeight is a SYNOPTIC macro field (cloud-top
    # altitude varies on ~100s-of-km scales), so a σ≈130 km smooth is
    # physically appropriate and turns every plateau edge into a gentle
    # gradient — no seams. The volumetric adds its own km-scale top variation
    # (jitter/turrets) on top, so nothing crisp is lost. (Coverage R and the
    # already-smooth convectivity/cirrus channels are NOT touched.)
    top01 = smooth_grid(top01, passes=48)

    # ── Smooth (block corners), longitude-align, upsample IN FLOAT ──
    # ERA5: lat 90→−90 (row 0 = N = image top ✓), lon 0→360. The project's
    # earth textures are −180→180 → roll by half the width.
    def align(a):
        return np.roll(a, a.shape[1] // 2, axis=1)

    def upsample(a):
        im = Image.fromarray(align(smooth_grid(a)).astype(np.float32), "F")
        return np.asarray(
            im.resize((OUT_W, OUT_H), Image.BILINEAR), dtype=np.float32
        )

    coverage_hi = upsample(coverage)
    conv_hi = upsample(conv)
    top01_hi = upsample(top01)
    hcc_hi = upsample(hcc)

    # ── R = placed coverage. Preference order (see the GIBS block):
    #   1. --coverage-texture: a CLEAN global cloud composite (e.g. the Blue
    #      Marble cloud layer) used directly as R. RECOMMENDED (2026-07-13):
    #      same-day MODIS true-color (option 2) has swath-gap merge seams +
    #      sun-glint that read as coverage — inherent to a single real day;
    #      Blue Marble is a months-long cloud-cleared composite → seam/glint-
    #      free by construction, matching the "as nice as blue marble" goal.
    #      Trade-off: coverage is an idealized field, not the ERA5 day (the
    #      G/B/A physics channels still are). No gaps → no fill, no veto.
    #   2. --cloud-image: REAL same-date satellite imagery, gaps filled
    #      procedurally (the authentic-weather path; has swath/glint seams).
    #   3. default: band-limited procedural placement (the alien-planet path);
    #   4. --no-placement: the raw ERA5 fraction (debug/inspection).
    if args.coverage_texture:
        print(f"coverage from clean composite {args.coverage_texture}...")
        cim = Image.open(args.coverage_texture).convert("L")
        if cim.size != (OUT_W, OUT_H):
            cim = cim.resize((OUT_W, OUT_H), Image.BILINEAR)
        placed = np.asarray(cim, dtype=np.float32) / 255.0
        # The Blue Marble cloud layer is already in the project's −180..180
        # equirect convention (like the GIBS jpgs), so NO align-roll here.
    elif args.cloud_image:
        print(f"extracting cloud coverage from {args.cloud_image}...")
        # img_valid, NOT `valid` — that name is already the ERA5 cloudy-column
        # mask (native res) used by the stats below; shadowing it crashed the
        # dense-region stat with a (721,1440)×(4096,8192) broadcast error.
        img_cov, img_valid = image_coverage(
            args.cloud_image, args.cloud_image_2, coverage_hi
        )
        gap_frac = 1.0 - img_valid.mean()
        print(f"  no-data after Terra+Aqua merge: {gap_frac * 100:.1f}%")
        if img_valid.all():
            placed = img_cov
        else:
            print("  filling residual gaps with procedural placement...")
            proc = bake_placement(coverage_hi)
            # Feather the mask (~24-pass binomial ≈ σ 3.4 px ≈ 17 km) — the
            # image↔procedural handoff differs in CHARACTER, so it needs a
            # wide soft transition, not just anti-aliasing.
            wmask = smooth_grid(img_valid.astype(np.float32), passes=24).astype(
                np.float32
            )
            placed = img_cov * wmask + proc * (1.0 - wmask)
    elif args.no_placement:
        placed = coverage_hi
    else:
        print("synthesizing placement field (band-limited fbm on the sphere)...")
        placed = bake_placement(coverage_hi)

    rgba = np.stack([placed, conv_hi, top01_hi, hcc_hi], axis=-1)
    # ── TPDF dither before 8-bit quantization ──
    # The ERA5-derived channels (G/B/A) are ultra-smooth wide gradients; plain
    # rounding turns every 1/255 level into a 5-40 km terrace whose edges run
    # along weather-system isolines. The marcher's steep gates amplify those
    # edges into visible nested contour bands at low orbit (the "damascus
    # steel" artifact, 2026-07-12 — see docs/CLOUD_DEBUGGING_LESSONS.md).
    # Triangular ±1 LSB dither breaks the coherent isolines into texel-scale
    # grain. Deterministic seed → reproducible bakes.
    rng = np.random.default_rng(0x5EED)
    tpdf = rng.random(rgba.shape) - rng.random(rgba.shape)  # triangular, ±1
    img8 = (
        np.clip(rgba * 255 + tpdf, 0, 255).round().astype(np.uint8)
    )
    im = Image.fromarray(img8, "RGBA")
    import os

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    im.save(args.out)

    # ── Validation / acceptance stats (§4.2/§4.7) ──
    def stats(name, a):
        q = np.percentile(a, [10, 50, 90])
        print(
            f"  {name:12s} mean {a.mean():.3f}  p10 {q[0]:.3f}  p50 {q[1]:.3f}  p90 {q[2]:.3f}"
        )

    print(f"wrote {args.out} ({OUT_W}x{OUT_H})")
    stats("fraction", coverage)
    if not args.no_placement:
        stats("placed R", placed)
        print(
            f"  area check: fraction mean {coverage.mean():.3f} vs "
            f"placed mean {placed.mean():.3f} (should be close)"
        )
    stats("convectivity", conv)
    stats("topHeight", top01)
    stats("cirrus", hcc)
    dense = coverage > 0.7
    if dense.any():
        t = top_km[dense & valid]
        span = np.percentile(t, 90) - np.percentile(t, 10)
        verdict = (
            "OK >= 4"
            if span >= 4
            else "below the 4 km acceptance target — regional variety comes "
            "from geography; per-cell variance is the marcher jitter"
        )
        print(f"  dense-region (cov>0.7) top p10-p90 span: {span:.1f} km ({verdict})")
    floaters = ((coverage < 0.1) & (top01 > 0.7) & valid).mean()
    print(f"  floater risk (cov<0.1 & top>0.7): {floaters * 100:.2f}% of texels")
    print(f"  deep-convective fraction (G>0.6): {(conv > 0.6).mean() * 100:.1f}%")
    print("\nnext:  ./scripts/convert-to-ktx2.sh --linear " + args.out)
    print("       (EXPLICIT --linear — data, not colour; then flip REAL_WEATHER_MAP)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--print-request", action="store_true")
    ap.add_argument("--download", action="store_true", help="retrieve via cdsapi")
    ap.add_argument(
        "--download-image",
        action="store_true",
        help="fetch the same-date MODIS true-color composite from NASA GIBS",
    )
    ap.add_argument("--date", default=DEFAULT_DATE)
    ap.add_argument("--time", default=DEFAULT_TIME)
    ap.add_argument("--single", help="ERA5 single-levels NetCDF")
    ap.add_argument("--pressure", help="ERA5 pressure-levels NetCDF")
    ap.add_argument(
        "--coverage-texture",
        help="CLEAN global cloud composite (e.g. Blue Marble "
        "public/textures/earth_clouds_8k.webp) used directly as R — "
        "seam/glint-free, RECOMMENDED over same-day MODIS (--cloud-image)",
    )
    ap.add_argument(
        "--cloud-image",
        help="same-date satellite true-color image (from --download-image): "
        "becomes the R channel — Earth's Blue-Marble-level placement",
    )
    ap.add_argument(
        "--cloud-image-2",
        help="second same-date composite (Aqua) merged under the first — "
        "fills the first image's swath gaps with REAL pixels",
    )
    ap.add_argument("--out", default="public/textures/weather/era5_weather.png")
    ap.add_argument(
        "--no-placement",
        action="store_true",
        help="write the raw area FRACTION into R instead of baked placement "
        "(then cloudShared.fractionPlacement must handle it at runtime)",
    )
    args = ap.parse_args()
    if args.print_request:
        print_request(args.date, args.time)
        return 0
    if args.download:
        return download(args.date, args.time)
    if args.download_image:
        return download_image(args.date)
    if not args.single or not args.pressure:
        ap.error(
            "--single and --pressure are required to bake "
            "(or use --download / --print-request)"
        )
    return bake(args)


if __name__ == "__main__":
    sys.exit(main())
