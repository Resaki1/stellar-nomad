#!/usr/bin/env python3
"""
Build the star catalogue assets from the HYG database (STAR_CATALOGUE_PLAN.md, S0).

    python3 scripts/build_star_catalogue.py path/to/hygdata_v41.csv

Emits two files, because the plan's §3.2 finding is that magnitude-limited and
distance-limited selections answer different questions and barely overlap:

    public/data/stars_visual.bin    what the sky LOOKS like  (mag <= 6.5)
    public/data/stars_nearby.json   where you can GO         (<= 25 ly, named)

⚠ SOURCE / LICENCE. HYG v40+ is **CC BY-SA 4.0** (share-alike). The derived blob is
a derivative work, so shipping it carries the attribution AND share-alike terms —
see `public/data/STARS_ATTRIBUTION.md`. If share-alike is unacceptable, the primary
sources are not share-alike and this script is a swap:
  • Yale Bright Star Catalogue  — VizieR V/50   (free with citation)
  • Hipparcos (van Leeuwen 2007) — VizieR I/311 (ESA, free with acknowledgement)
HYG is used here because it MERGES Hipparcos + Yale + Gliese and pre-computes
Cartesian positions and distances, which is exactly the shape §3 asks for.

── Why these fields ──────────────────────────────────────────────────────────
Position is stored as 3D CARTESIAN, not a direction, because travel parallax is
large: moving 4.24 ly shifts Alpha Cen up to 76° and Sirius 29.5° (plan §3.1).
Direction-only storage would make interstellar travel look wrong.

Magnitude and colour index are the only photometric inputs the renderer needs:
    E = 2.54e-6 * 10^(-0.4*mag)  lux            -> luminance via pixel solid angle
    B-V -> T_eff (Ballesteros 2012) -> blackbodyLinearSrgb()
Both conversions already exist in `space/photometry.ts`; nothing is baked here.
"""

from __future__ import annotations

import csv
import json
import math
import struct
import sys
from pathlib import Path

# Parsecs -> light-years.
LY_PER_PC = 3.2615638

MAX_MAG = 6.5  # naked-eye limit; §3.2's "visual" set
NEAR_LY = 25.0  # §3.2's "neighbourhood" set

MAGIC = b"SNST"
FORMAT_VERSION = 1

# Main-sequence B-V by spectral class, for the handful of rows with no `ci`.
# Only ~40 of 8,920 need it, and a wrong colour on a mag-6 star is invisible —
# but a MISSING one would be NaN in a vertex buffer, which is not invisible.
CLASS_BV = {"O": -0.32, "B": -0.16, "A": 0.06, "F": 0.42, "G": 0.70, "K": 1.00, "M": 1.50}
DEFAULT_BV = 0.65  # solar-ish, if even the spectral class is absent


def as_float(v: str) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def bv_from_spectral(spect: str) -> float | None:
    for ch in spect.strip():
        if ch.upper() in CLASS_BV:
            return CLASS_BV[ch.upper()]
    return None


def temperature_from_bv(bv: float) -> float:
    """Ballesteros (2012). Checked: BV 0.65 -> 5778 K (Sun 5772), 0.00 -> 10125 K (Vega ~9600)."""
    return 4600.0 * (1.0 / (0.92 * bv + 1.70) + 1.0 / (0.92 * bv + 0.62))


def illuminance_lux(mag: float) -> float:
    """A magnitude-0 star delivers 2.54e-6 lux outside the atmosphere (V band)."""
    return 2.54e-6 * math.pow(10.0, -0.4 * mag)


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    src = Path(argv[1])
    if not src.is_file():
        print(f"[stars] not found: {src}")
        return 2

    out_dir = Path(__file__).resolve().parent.parent / "public" / "data"
    out_dir.mkdir(parents=True, exist_ok=True)

    rows = list(csv.DictReader(src.open(newline="")))
    print(f"[stars] read {len(rows)} rows from {src.name}")

    visual: list[tuple[float, float, float, float, float]] = []
    nearby: list[dict] = []
    named: list[dict] = []
    filled_bv = 0
    sentinel = 0

    for r in rows:
        # Sol is id 0 and is rendered by Star.tsx from the system description.
        if as_float(r.get("id", "")) == 0:
            continue
        mag = as_float(r.get("mag", ""))
        x, y, z = (as_float(r.get(k, "")) for k in ("x", "y", "z"))
        if mag is None or x is None or y is None or z is None:
            continue

        dist_pc = as_float(r.get("dist", "")) or 0.0
        # HYG stores 100000 pc for "parallax unknown". Left as-is deliberately: at
        # 326,000 ly the travel parallax over a 4.24 ly baseline is 2.7 arcsec, so
        # such a star simply sits fixed on the sky — which is the honest answer for
        # an unknown distance, and needs no special case in the renderer.

        bv = as_float(r.get("ci", ""))
        bv_was_missing = bv is None
        if bv_was_missing:
            bv = bv_from_spectral(r.get("spect", "")) or DEFAULT_BV

        proper = (r.get("proper") or "").strip()
        if proper and mag <= MAX_MAG:
            # Named naked-eye stars, for the `__lum.star("Sirius")` gate. Positions
            # stay in the catalogue's own EQUATORIAL frame — the game-frame rotation
            # lives in StarField.ts, and duplicating it here would let the two drift
            # apart, which is precisely what the gate exists to catch.
            named.append(
                {
                    "name": proper,
                    "magV": round(mag, 3),
                    "colorBV": round(bv, 3),
                    "posEqLy": [
                        round(x * LY_PER_PC, 5),
                        round(y * LY_PER_PC, 5),
                        round(z * LY_PER_PC, 5),
                    ],
                }
            )

        if mag <= MAX_MAG:
            # ⚠ Count fills and sentinels ONLY for rows that are actually EMITTED.
            # Counting every input row reported 1,891 fills and 10,225 sentinels for
            # a visual set that has 40 and 206 — a diagnostic that overstates a data
            # problem by 47× is worse than no diagnostic.
            if bv_was_missing:
                filled_bv += 1
            if dist_pc >= 99999:
                sentinel += 1
            visual.append(
                (x * LY_PER_PC, y * LY_PER_PC, z * LY_PER_PC, mag, bv)
            )

        dist_ly = dist_pc * LY_PER_PC
        if 0.0 < dist_ly <= NEAR_LY:
            name = (r.get("proper") or "").strip()
            nearby.append(
                {
                    "id": int(as_float(r.get("id", "")) or 0),
                    "name": name or (r.get("gl") or "").strip() or f"HYG {r.get('id')}",
                    "named": bool(name),
                    "hip": (r.get("hip") or "").strip() or None,
                    "gl": (r.get("gl") or "").strip() or None,
                    "distLy": round(dist_ly, 4),
                    "magV": round(mag, 3),
                    "absMagV": round(as_float(r.get("absmag", "")) or 0.0, 3),
                    "colorBV": round(bv, 3),
                    "spectral": (r.get("spect") or "").strip() or None,
                    "posLy": [
                        round(x * LY_PER_PC, 5),
                        round(y * LY_PER_PC, 5),
                        round(z * LY_PER_PC, 5),
                    ],
                    "nakedEye": mag <= MAX_MAG,
                }
            )

    nearby.sort(key=lambda e: e["distLy"])
    named.sort(key=lambda e: e["magV"])

    # ── Binary blob ──
    # 16-byte header then count × (f32 x, y, z, mag, bv), little-endian.
    blob = bytearray()
    blob += MAGIC
    blob += struct.pack("<III", FORMAT_VERSION, len(visual), 0)
    for x, y, z, mag, bv in visual:
        blob += struct.pack("<fffff", x, y, z, mag, bv)
    bin_path = out_dir / "stars_visual.bin"
    bin_path.write_bytes(bytes(blob))

    named_path = out_dir / "stars_named.json"
    named_path.write_text(json.dumps(named, indent=1) + "\n")

    json_path = out_dir / "stars_nearby.json"
    json_path.write_text(json.dumps(nearby, indent=1) + "\n")

    print(f"[stars] visual  : {len(visual)} stars, mag <= {MAX_MAG} -> {bin_path.name} "
          f"({len(blob) / 1024:.1f} KB)")
    print(f"[stars] nearby  : {len(nearby)} stars <= {NEAR_LY} ly -> {json_path.name} "
          f"({json_path.stat().st_size / 1024:.1f} KB)")
    print(f"[stars] named   : {len(named)} named naked-eye stars -> {named_path.name} "
          f"({named_path.stat().st_size / 1024:.1f} KB)")
    print(f"[stars] of the {len(visual)} emitted: {filled_bv} needed a default B-V, "
          f"{sentinel} carry HYG's unknown-parallax sentinel")

    # ── Validation: the plan's §9 acceptance numbers, computed from the blob ──
    # A pipeline that silently drops or mis-scales a field is the failure mode
    # here, so assert against PUBLISHED values rather than eyeballing a count.
    print("\n[stars] spot check (read back from the blob):")
    view = memoryview(bytes(blob))
    by_mag = sorted(range(len(visual)), key=lambda i: visual[i][3])
    print(f"  {'mag':>7} {'dist ly':>9} {'B-V':>6} {'T_eff K':>8} {'lux':>10} {'cd/m² @1px':>11}")
    PIXEL_SR = 6.529e-7  # 50° vFOV / 1080 px — the plan's reference pixel
    for i in by_mag[:5]:
        x, y, z, mag, bv = visual[i]
        d = math.sqrt(x * x + y * y + z * z)
        lux = illuminance_lux(mag)
        print(f"  {mag:>7.2f} {d:>9.2f} {bv:>6.2f} {temperature_from_bv(bv):>8.0f} "
              f"{lux:>10.3e} {lux / PIXEL_SR:>11.2f}")
    faint = illuminance_lux(6.0) / PIXEL_SR
    print(f"\n  §9 gate: brightest ≈ 14.9 cd/m² (Sirius), mag 6.0 ≈ 0.0155 -> got {faint:.4f}")
    assert view[:4] == MAGIC, "header magic"
    assert len(view) == 16 + 20 * len(visual), "blob size"
    print("  header + size OK")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
