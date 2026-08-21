#!/usr/bin/env bash
# Build the diffuse (star-free) sky panorama from a NASA SVS Deep Star Maps layer.
# STAR_CATALOGUE_PLAN.md S3.
#
#   ./scripts/build_diffuse_sky.sh path/to/starless_celestial_8k.exr
#   MEASURE_ONLY=1 ./scripts/build_diffuse_sky.sh input.exr    # just report numbers
#
# ── WHY A SOURCED STAR-FREE MAP, NOT A FILTER ────────────────────────────────
# The first attempt median-filtered our existing panorama. It worked photometrically
# (removed 20.9% of the flux, against the 19.5% the catalogue independently accounts
# for) but looked SMUDGY, because a median cannot distinguish a star from genuine
# dust structure at the same scale — it removes both. Anyone who has processed
# astrophotography knows this failure mode.
#
# NASA's Deep Star Maps 2020 are RENDERED from Gaia DR2 + Tycho-2, so the starless
# variants simply OMIT the catalogued stars. No filtering, no detail loss. That is
# strictly better than anything we can recover from a composited image.
#   https://svs.gsfc.nasa.gov/4851
#
# ⚠⚠ ORIENTATION IS NOT WHAT YOU EXPECT, AND IT COST FOUR FAILED FIXES. The asset
# is a sky CHART (RA 0h at the image centre, RA increasing LEFTWARD), not a globe
# texture, so reading it with the textbook `u = RA/2pi` renders the sky MIRRORED.
# `MilkyWaySkybox.tsx` uses `u = fract(0.5 - RA/2pi)`. If you swap the asset, RE-SOLVE
# it rather than assuming — that is what `scripts/solve_sky_orientation.py` is for —
# and then gate it with `await __lum.skyAlign()`. See STAR_CATALOGUE_PLAN.md §8.6.
#
# ⚠ USE THE **CELESTIAL** (equatorial) VARIANT, NOT GALACTIC. `StarField.tsx` owns a
# validated equatorial-J2000 → game-frame rotation (checked to 0.07° against
# published ecliptic coordinates for three stars). A galactic source would need a
# second, different rotation — more code and another frame to get wrong.
#
# ── WHY 8-BIT sRGB, AND WHY GAIN IS NOT OPTIONAL ─────────────────────────────
# Basis/UASTC — this project's whole KTX2 path — is an LDR format and cannot carry
# HDR at all, so 8-bit is the only option. Taking a FLOAT source and doing one
# careful conversion is the best available: no quantisation upstream of our encode.
#
# ⚠⚠ BUT "the band is only 2.6 stops and 8-bit holds ~8, so it is plenty" IS WRONG,
# and it was the reasoning that shipped the first version. It compares RANGE against
# TOTAL RANGE while ignoring WHERE IN THE CODE SPACE the signal sits — and it does
# not sit in the middle. The sRGB curve spends most of its code values on the bright
# end, while this signal lives near black. MEASURED on the NASA 8k asset: peak/mean
# is 56× (5.8 stops, far more than 2.6, because of a small very bright core), so at
# GAIN=1 the band occupies codes 20..59 — **15 code values per stop**, which bands
# visibly on a smooth gradient.
#
# Hence GAIN, chosen from the printed PERCENTILES rather than from the peak: lift the
# band up the code space and let the tiny core clip. Aim for >=25 values/stop.
set -euo pipefail

cd "$(dirname "$0")/.."
SRC="${1:-}"
[[ -n "$SRC" && -f "$SRC" ]] || { echo "usage: $0 <starless-panorama.exr|.png|.tif>"; exit 2; }
command -v ffmpeg >/dev/null || { echo "need ffmpeg (brew install ffmpeg)"; exit 1; }

OUT_PNG="public/assets/8k_milkyway_diffuse.png"
W="${W:-8192}"; H="${H:-4096}"

echo "source: $SRC"
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,pix_fmt \
  -of default=nw=1 "$SRC" | sed 's/^/  /'

# ── Characterise the LINEAR input ────────────────────────────────────────────
# An EXR is linear float and may exceed 1.0. Converting naively would CLIP the
# bright band — the one part of the image we care most about — so find the peak
# first and normalise against it. Downscaling linear light before averaging is
# correct (unlike the sRGB case that fooled the earlier attempt).
read -r PEAK MEAN P99 P999 P9999 < <(
  ffmpeg -v error -i "$SRC" -vf "format=gbrpf32le,scale=1024:512:flags=area,format=rgb48le" \
    -f rawvideo - 2>/dev/null | python3 -c "
import sys, math, struct
W, H = 1024, 512
d = sys.stdin.buffer.read()
a = struct.unpack('<%dH' % (W * H * 3), d[:W * H * 6])
peak = max(a) / 65535.0
num = den = 0.0
for row in range(H):
    w = math.sin(math.pi * (row + 0.5) / H)
    base = row * W * 3
    s = 0.0
    for c in range(0, W * 3, 3):
        i = base + c
        s += 0.2126 * a[i] + 0.7152 * a[i + 1] + 0.0722 * a[i + 2]
    num += w * s / W / 65535.0
    den += w
# Percentiles of luma, so the GAIN below is chosen from the DISTRIBUTION rather
# than from the peak. A handful of very bright core pixels should not be allowed
# to squash the whole band into the bottom of the 8-bit code space.
lum = sorted((0.2126*a[i] + 0.7152*a[i+1] + 0.0722*a[i+2]) / 65535.0
             for i in range(0, W*H*3, 3))
def pct(f): return lum[min(len(lum)-1, int(f*len(lum)))]
print('%.6f %.6f %.6f %.6f %.6f' % (peak, num/den, pct(0.99), pct(0.999), pct(0.9999)))
"
)
echo "  linear peak (downscaled): $PEAK"
echo "  linear sin-weighted mean: $MEAN"
echo "  luma p99 / p99.9 / p99.99: $P99 / $P999 / $P9999"
python3 -c "
import math
p, m, p99, p999 = $PEAK, $MEAN, $P99, $P999
def srgb(x):
    x = min(1.0, max(0.0, x))
    return x * 12.92 if x <= 0.0031308 else 1.055 * x ** (1 / 2.4) - 0.055
print('  peak/mean = %.1fx = %.1f stops' % (p / m, math.log2(p / m)))
print()
# ⚠ 'the band is only 2.6 stops so 8-bit is plenty' compares RANGE against TOTAL
# RANGE and ignores WHERE IN THE CODE SPACE the signal sits. It does not sit in the
# middle: the sRGB curve spends most of its code values on the bright end, while
# this signal lives near black. Choose GAIN from these numbers, not from the peak.
print('  8-bit code space for the band (±1.3 stops about the mean), per GAIN:')
for g in (1, 2, 4, 8, 16):
    lo, mid, hi = (255 * srgb(m / p * g * k) for k in (0.4, 1.0, 2.5))
    clip_pct = 100.0 * (1.0 if p999 * g / p >= 1.0 else 0.1 if p99 * g / p >= 1.0 else 0.0)
    print('    gain %2dx -> codes %3d..%3d (mean %3d) = %2d/stop; >~%.2f%% of pixels clip'
          % (g, lo, hi, mid, (hi - lo) / 2.6, clip_pct))
print()
print('  Rule of thumb: aim for >=25 code values per stop. Clipping a few hundredths')
print('  of a percent (the very core) is a far better trade than banding the band.')
"

[[ -n "${MEASURE_ONLY:-}" ]] && exit 0

# ── Encode: normalise, apply the sRGB OETF, write 8-bit ──────────────────────
# The absolute scale here does NOT matter — MilkyWaySkybox rescales by
# SKY_RADIANCE_SCALE to hit an absolute target. Only the SHAPE and the measured
# mean matter, so normalising to use the full 8-bit range is a free win.
GAIN="${GAIN:-1}"
# Normalise by the linear peak, then apply GAIN, then the sRGB OETF. Values above
# 1.0 clip — deliberately: see the code-space table above.
NORM="clip(val/maxval*$GAIN/$PEAK\,0\,1)"
OETF="if(lte($NORM\,0.0031308)\,$NORM*12.92\,1.055*pow($NORM\,1/2.4)-0.055)*maxval"
echo "using GAIN=$GAIN (override with GAIN=4 ./scripts/build_diffuse_sky.sh …)"
echo "encoding → $OUT_PNG (${W}x${H})"
ffmpeg -v error -y -i "$SRC" \
  -vf "format=gbrpf32le,scale=$W:$H:flags=lanczos,format=rgb48le,lutrgb=r='$OETF':g='$OETF':b='$OETF',format=rgb24" \
  -compression_level 4 "$OUT_PNG"

echo "converting to KTX2 …"
./scripts/convert-to-ktx2.sh "$OUT_PNG"

# ── Measure the SHIPPED encoding, sRGB-decoded ───────────────────────────────
# ⚠ LINEARISE BEFORE DOWNSCALING. Averaging sRGB values and linearising afterwards
# underestimates a high-variance field (the EOTF is convex) — badly enough that in
# the earlier attempt a median filter appeared to RAISE the mean, which is
# impossible. When a measurement says something impossible, the measurement is wrong.
EOTF="if(lte(val/maxval\,0.04045)\,val/maxval/12.92\,pow((val/maxval+0.055)/1.055\,2.4))*maxval"
ffmpeg -v error -i "$OUT_PNG" \
  -vf "format=rgb48,lutrgb=r='$EOTF':g='$EOTF':b='$EOTF',scale=2048:1024:flags=area" \
  -pix_fmt rgb48le -f rawvideo - 2>/dev/null | python3 -c "
import sys, math, struct
W, H = 2048, 1024
d = sys.stdin.buffer.read()
a = struct.unpack('<%dH' % (W * H * 3), d[:W * H * 6])
num = den = 0.0
for row in range(H):
    w = math.sin(math.pi * (row + 0.5) / H)
    base = row * W * 3
    s = 0.0
    for c in range(0, W * 3, 3):
        i = base + c
        s += 0.2126 * a[i] + 0.7152 * a[i + 1] + 0.0722 * a[i + 2]
    num += w * s / W / 65535.0
    den += w
print()
print('  -> set SKY_TEXTURE_MEAN_LINEAR = %.6f in MilkyWaySkybox.tsx' % (num / den))
"
echo
echo "⚠ Then VERIFY IN-ENGINE — the shipped asset is UASTC-compressed, and the number"
echo "  above was measured on the PNG. Warp to Neptune's umbra, let adaptation settle,"
echo "  and probe the band: it should read ~1.25e-4 cd/m² (the galactic plane's real"
echo "  brightness), i.e. ~1.6x SKY_DIFFUSE_TARGET_NITS since the band beats the mean."
