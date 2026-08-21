#!/usr/bin/env python3
"""
Solve the orientation of an all-sky panorama by MEASURING it (STAR_CATALOGUE_PLAN.md S3b).

    python3 scripts/solve_sky_orientation.py public/assets/8k_milkyway_diffuse.png
    python3 scripts/solve_sky_orientation.py ~/Downloads/milkyway_2020_8k.exr

── WHY THIS SCRIPT EXISTS ────────────────────────────────────────────────────
The first three attempts at aligning the Milky Way panorama were GUESSES —
`geo.scale(-1,1,1)`, then a derived `rotX(pi-eps)`, then an explicit UV formula
verified against the equirect *definition*. All three failed in-engine, because
the definition was never the thing in doubt: the ASSET's convention was. The
symptom that finally made this unarguable is a cross-check between two
independently-sourced things in the same scene — the Big Dipper (from the star
catalogue, whose equatorial->game rotation is validated to 0.07 deg) landed ON
the band, when in reality it sits ~60 deg of galactic latitude away from it.

⚠ A PLANE NORMAL ALONE CANNOT SOLVE THIS. An earlier pass fitted the band plane,
found it 59 deg from the true north galactic pole, and stalled — correctly, since
a normal is 2 DOF and a rotation is 3. Worse, a plane fit returns +/-n, so it
cannot even distinguish a rotation from a reflection. That ambiguity matters here:
a sky map published "as seen from Earth looking out" is MIRRORED relative to a
globe, and no rotation can undo a mirror.

So: measure FOUR landmarks (band plane + galactic centre + both Magellanic
Clouds), then solve orthogonal Procrustes with REFLECTION ALLOWED. The Clouds
are what break the parity ambiguity, and det(R) is what names the answer.

── WHAT IT ASSUMES ───────────────────────────────────────────────────────────
Only that the image is a full-sky equirectangular projection. It reads the image
under the convention MilkyWaySkybox.tsx currently implements

    u = RA / 2pi          v = 0.5 - asin(sin Dec)/pi     (v=0 at Dec +90)

and solves for the 3x3 orthogonal matrix relating that reading to the truth. If
the current convention is already right the answer is the identity.
"""

from __future__ import annotations

import math
import struct
import subprocess
import sys
from pathlib import Path

D2R = math.pi / 180.0
R2D = 180.0 / math.pi

# ── Truth, J2000 ─────────────────────────────────────────────────────────────
# North galactic pole and galactic centre are the IAU 1958 definition carried to
# J2000. The Clouds are catalogue centres; both are extended (LMC ~10 deg), so a
# degree or two of residual on them is the object, not the fit.
TRUTH = {
    # name          RA hours      Dec deg    role
    "NGP":         (12.857595,   27.128336, "pole"),
    "GC":          (17.761124,  -29.007810, "centre"),
    "LMC":         ( 5.392917,  -69.756111, "cloud"),
    "SMC":         ( 0.878556,  -72.828611, "cloud"),
    # Extra reporting-only landmarks (not used in the fit).
    "Anticentre":  ( 5.761124,   28.936000, "report"),
    "SGP":         ( 0.857595,  -27.128336, "report"),
    "Orion Belt":  ( 5.603560,   -1.201900, "report"),
    "Big Dipper":  (12.257000,   56.382000, "report"),
}


# ── Tiny linear algebra (no numpy: pip is blocked in this sandbox) ───────────
def vnorm(v):
    n = math.sqrt(sum(c * c for c in v))
    return [c / n for c in v]


def vdot(a, b):
    return sum(x * y for x, y in zip(a, b))


def vcross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def matvec(m, v):
    return [vdot(row, v) for row in m]


def matmul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]


def transpose(m):
    return [[m[j][i] for j in range(3)] for i in range(3)]


def det3(m):
    return (m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
            - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
            + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]))


def jacobi_eig(a):
    """Cyclic Jacobi for a symmetric 3x3. Returns (eigenvalues, eigenvector columns)."""
    a = [row[:] for row in a]
    v = [[1.0 if i == j else 0.0 for j in range(3)] for i in range(3)]
    for _ in range(64):
        off = abs(a[0][1]) + abs(a[0][2]) + abs(a[1][2])
        if off < 1e-18:
            break
        for p, q in ((0, 1), (0, 2), (1, 2)):
            if abs(a[p][q]) < 1e-300:
                continue
            theta = (a[q][q] - a[p][p]) / (2.0 * a[p][q])
            t = math.copysign(1.0, theta) / (abs(theta) + math.sqrt(theta * theta + 1.0))
            c = 1.0 / math.sqrt(t * t + 1.0)
            s = t * c
            for k in range(3):
                akp, akq = a[k][p], a[k][q]
                a[k][p] = c * akp - s * akq
                a[k][q] = s * akp + c * akq
            for k in range(3):
                apk, aqk = a[p][k], a[q][k]
                a[p][k] = c * apk - s * aqk
                a[q][k] = s * apk + c * aqk
            for k in range(3):
                vkp, vkq = v[k][p], v[k][q]
                v[k][p] = c * vkp - s * vkq
                v[k][q] = s * vkp + c * vkq
    vals = [a[i][i] for i in range(3)]
    order = sorted(range(3), key=lambda i: vals[i])
    return [vals[i] for i in order], [[v[r][i] for i in order] for r in range(3)]


def procrustes(pairs):
    """Least-squares orthogonal R with R*a ~ t. Reflection is ALLOWED (det may be -1).

    Forcing det=+1 (the usual Kabsch convention) would have hidden the whole answer
    here: a mirrored sky map is exactly the case we are testing for.
    """
    h = [[sum(w * t[i] * a[j] for a, t, w in pairs) for j in range(3)] for i in range(3)]
    vals, vec = jacobi_eig(matmul(transpose(h), h))
    r = [[0.0] * 3 for _ in range(3)]
    for k in range(3):
        sig = math.sqrt(max(vals[k], 0.0))
        if sig < 1e-12:
            raise SystemExit("[sky] landmarks are degenerate (collinear) — cannot solve")
        vk = [vec[i][k] for i in range(3)]
        uk = [c / sig for c in matvec(h, vk)]
        for i in range(3):
            for j in range(3):
                r[i][j] += uk[i] * vk[j]
    return r


# ── Sphere <-> equirect, under the convention the shader implements ──────────
def radec_to_vec(ra_h, dec_deg):
    ra, dec = ra_h * 15.0 * D2R, dec_deg * D2R
    return [math.cos(dec) * math.cos(ra), math.cos(dec) * math.sin(ra), math.sin(dec)]


def vec_to_radec(v):
    ra = math.atan2(v[1], v[0]) * R2D / 15.0
    return (ra + 24.0) % 24.0, math.asin(max(-1.0, min(1.0, v[2]))) * R2D


def uv_to_vec(u, v):
    dec = (0.5 - v) * math.pi
    ra = u * 2.0 * math.pi
    return [math.cos(dec) * math.cos(ra), math.cos(dec) * math.sin(ra), math.sin(dec)]


def vec_to_uv(vec):
    ra_h, dec = vec_to_radec(vec)
    return ra_h / 24.0, 0.5 - dec / 180.0


def closed_from(su, sv, k):
    """Matrix form of the one-line hypothesis  u = fract(su*RA/2pi + k), v = (sv>0 ? v : 1-v).

    Built by pushing the three basis vectors through the same scalar formula the shader
    will use, so what gets measured is exactly what will ship rather than an algebraic
    re-derivation of it that could quietly disagree.
    """
    cols = []
    for j in range(3):
        e = [1.0 if i == j else 0.0 for i in range(3)]
        ra_r, dec_r = vec_to_radec(e)
        cols.append(radec_to_vec(su * (ra_r - 24.0 * k), sv * dec_r))
    return [[cols[j][i] for j in range(3)] for i in range(3)]


def angle_between(a, b):
    return math.acos(max(-1.0, min(1.0, vdot(a, b)))) * R2D


# ── Image loading ────────────────────────────────────────────────────────────
def load_luma(path: Path, w: int, h: int):
    """Decode to a float32 luma grid via ffmpeg. Linear for EXR, sRGB-encoded for PNG.

    The encoding does not matter for LANDMARK POSITIONS (a monotone tone curve moves
    no centroid far), and this script only measures geometry. Photometry stays in
    build_diffuse_sky.sh, which is careful to linearise before it downscales.
    """
    cmd = ["ffmpeg", "-v", "error", "-i", str(path), "-vf",
           f"format=gbrpf32le,scale={w}:{h}:flags=area", "-pix_fmt", "grayf32le",
           "-f", "rawvideo", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    need = w * h * 4
    if len(raw) < need:
        raise SystemExit(f"[sky] short read from ffmpeg: {len(raw)} < {need}")
    return list(struct.unpack(f"<{w*h}f", raw[:need]))


def box_blur(px, w, h, r):
    """Separable box blur; wraps in u, clamps in v. The blur IS the blob detector's
    scale selector — the LMC is ~10 deg across, so r is set from that."""
    tmp = [0.0] * (w * h)
    inv = 1.0 / (2 * r + 1)
    for y in range(h):
        row = y * w
        acc = sum(px[row + ((x) % w)] for x in range(-r, r + 1))
        for x in range(w):
            tmp[row + x] = acc * inv
            acc += px[row + ((x + r + 1) % w)] - px[row + ((x - r) % w)]
    out = [0.0] * (w * h)
    for x in range(w):
        acc = sum(tmp[min(h - 1, max(0, y)) * w + x] for y in range(-r, r + 1))
        for y in range(h):
            out[y * w + x] = acc * inv
            acc += tmp[min(h - 1, y + r + 1) * w + x] - tmp[max(0, y - r) * w + x]
    return out


def percentile(vals, f):
    s = sorted(vals)
    return s[min(len(s) - 1, int(f * len(s)))]


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    src = Path(argv[1]).expanduser()
    if not src.is_file():
        print(f"[sky] not found: {src}")
        return 2

    W, H = 1024, 512
    print(f"[sky] source: {src.name}")
    px = load_luma(src, W, H)
    print(f"[sky] decoded {W}x{H} luma, range {min(px):.5g} .. {max(px):.5g}")

    # Precompute per-pixel direction (assumed convention) and solid angle.
    dirs, sa = [], []
    for y in range(H):
        v = (y + 0.5) / H
        dec = (0.5 - v) * math.pi
        cd, sd = math.cos(dec), math.sin(dec)
        for x in range(W):
            ra = ((x + 0.5) / W) * 2.0 * math.pi
            dirs.append((cd * math.cos(ra), cd * math.sin(ra), sd))
            sa.append(cd)

    # ── 1. Band plane ───────────────────────────────────────────────────────
    # Luma-weighted second-moment tensor of directions; the MINIMUM eigenvector is
    # the plane normal. A uniform background adds (W/3)*I and so cannot rotate the
    # eigenvectors at all — but a non-uniform floor can, hence the percentile
    # subtraction, and hence reporting two floors to show the answer is stable.
    for floor_pct in (0.0, 0.50, 0.75):
        floor = percentile(px, floor_pct) if floor_pct else 0.0
        m = [[0.0] * 3 for _ in range(3)]
        tot = 0.0
        for i, p in enumerate(px):
            wgt = (p - floor) * sa[i]
            if wgt <= 0.0:
                continue
            d = dirs[i]
            tot += wgt
            for a in range(3):
                for b in range(a, 3):
                    m[a][b] += wgt * d[a] * d[b]
        for a in range(3):
            for b in range(a):
                m[a][b] = m[b][a]
        for a in range(3):
            for b in range(3):
                m[a][b] /= tot
        vals, vec = jacobi_eig(m)
        n = vnorm([vec[i][0] for i in range(3)])
        ra_h, dec = vec_to_radec(n)
        flat = vals[0] / vals[2]
        tag = "USED" if floor_pct == 0.50 else "    "
        print(f"[sky] {tag} plane fit (floor p{floor_pct*100:.0f}): normal RA {ra_h:7.4f}h "
              f"Dec {dec:+8.3f}  flatness {flat:.4f}")
        if floor_pct == 0.50:
            normal, plane_floor = n, floor

    # ── 2/3. Landmarks ──────────────────────────────────────────────────────
    # ⚠ FIRST ATTEMPT FAILED HERE, and the failure is instructive: "brightest pixel
    # more than 15 deg off the fitted plane" found two features 11.7 deg apart when
    # the true LMC..SMC separation is 20.75 deg. They were lumps of the galactic
    # BULGE, whose smooth glow at 15-25 deg of latitude outshines the Clouds. Peak
    # brightness does not identify an object; SCALE does. Hence unsharp masking:
    # subtract a ~20 deg blur to kill the smooth bulge, keep a ~2 deg blur to kill
    # noise, and what survives is compact structure only.
    def deg_px(d):
        return max(1, int(round(d / (360.0 / W))))

    fine = box_blur(px, W, H, deg_px(2.0))
    coarse = box_blur(px, W, H, deg_px(20.0))
    detail = [fine[i] - coarse[i] for i in range(W * H)]
    print(f"[sky] unsharp: fine r={deg_px(2.0)} px, coarse r={deg_px(20.0)} px")

    # Galactic centre: brightest SMOOTH point within 12 deg of the fitted plane.
    # Uses the coarse scale deliberately — the centre IS a broad glow, not a blob.
    best_ci = max((i for i, d in enumerate(dirs)
                   if abs(vdot(d, normal)) <= math.sin(12.0 * D2R)),
                  key=lambda i: coarse[i])

    def refine(seed, radius_deg, field, floor):
        """Luma-weighted centroid of unit VECTORS near a seed. Averaging vectors, not
        (u,v), keeps the equirect's pole distortion out of the answer."""
        cut = math.cos(radius_deg * D2R)
        acc = [0.0, 0.0, 0.0]
        for i, d in enumerate(dirs):
            if vdot(d, seed) < cut:
                continue
            wgt = (field[i] - floor) * sa[i]
            if wgt <= 0.0:
                continue
            for k in range(3):
                acc[k] += wgt * d[k]
        return vnorm(acc)

    centre = refine(dirs[best_ci], 12.0, coarse, percentile(coarse, 0.5))

    # Clouds: the two brightest COMPACT features at least 20 deg off the plane
    # (true galactic latitudes are -32.9 and -44.3, so 20 deg is a safe margin).
    off = [i for i, d in enumerate(dirs) if abs(vdot(d, normal)) > math.sin(20.0 * D2R)]
    cands = sorted(off, key=lambda i: -detail[i])
    picked = []
    for i in cands:
        if all(angle_between(dirs[i], dirs[j]) > 12.0 for j in picked):
            picked.append(i)
        if len(picked) >= 4:
            break
    print("[sky] compact off-plane candidates (as read, current convention):")
    for i in picked:
        r, dc = vec_to_radec(dirs[i])
        print(f"        RA {r:7.4f}h Dec {dc:+8.3f}  detail {detail[i]:.5g}")
    if len(picked) < 2:
        raise SystemExit("[sky] could not find two compact off-plane features")
    blob1 = refine(dirs[picked[0]], 7.0, detail, 0.0)
    blob2 = refine(dirs[picked[1]], 6.0, detail, 0.0)

    t_ngp = radec_to_vec(*TRUTH["NGP"][:2])
    t_gc = radec_to_vec(*TRUTH["GC"][:2])
    t_lmc = radec_to_vec(*TRUTH["LMC"][:2])
    t_smc = radec_to_vec(*TRUTH["SMC"][:2])
    true_sep = angle_between(t_lmc, t_smc)

    print()
    print("[sky] measured, read under the CURRENT shader convention:")
    for nm, vv in (("band normal", normal), ("brightest on band", centre),
                   ("blob 1", blob1), ("blob 2", blob2)):
        r, dc = vec_to_radec(vv)
        print(f"        {nm:<18} RA {r:7.4f}h  Dec {dc:+8.3f}")
    sep = angle_between(blob1, blob2)
    print(f"        blob separation {sep:.2f} deg   vs true LMC..SMC {true_sep:.2f} deg"
          f"   -> {'OK' if abs(sep - true_sep) < 3.0 else 'MISMATCH, blobs are not the Clouds'}")

    # ── 4. Chirality: rotation or reflection? ───────────────────────────────
    # This is the one measurement that settles parity, and it needs NO plane fit and
    # NO pole-sign choice: three non-coplanar landmarks have a handedness, and a
    # reflection reverses it. det(R) from Procrustes says the same thing, but this
    # says it from raw data with nothing fitted in between.
    def chirality(a, b, c):
        return vdot(vcross(a, b), c)

    ch_true = chirality(t_gc, t_lmc, t_smc)
    ch_a = chirality(centre, blob1, blob2)
    ch_b = chirality(centre, blob2, blob1)
    print()
    print(f"[sky] chirality  true(GC,LMC,SMC) = {ch_true:+.5f}")
    print(f"                 asset(C,b1,b2)   = {ch_a:+.5f}   asset(C,b2,b1) = {ch_b:+.5f}")
    print(f"      -> either assignment of the Clouds gives a well-defined handedness;"
          f" the sign match below decides which is a rotation and which a reflection.")

    # ── 5. Closed-form hypothesis scan ──────────────────────────────────────
    # The general 3x3 comes next, but first test the SIMPLE family, because if one
    # member of it fits then the shader fix is one line and stays readable:
    #     u_tex = (su * RA/2pi + k) mod 1      v_tex = v  or  1-v
    # Reading the asset with u = RA/2pi means RA_read = su*RA_true + 24k, so
    #     RA_true = su * (RA_read - 24k)      Dec_true = sv * Dec_read
    # Two landmarks (pole, centre) already over-determine k for each discrete
    # (su, sv), which is why this works without the Clouds at all.
    print()
    print("[sky] closed-form family  u_tex = (su*RA/2pi + k) mod 1,  v_tex = v (sv=+1) or 1-v (sv=-1):")
    marks = [("pole", normal, t_ngp, True), ("centre", centre, t_gc, False),
             ("cloud1", blob1, t_lmc, False), ("cloud2", blob2, t_smc, False)]
    best_h = None
    for su in (1.0, -1.0):
        for sv in (1.0, -1.0):
            # Grid then refine on k; the objective is max-angle, not rms, so a single
            # badly-placed landmark cannot be averaged away.
            def worst(k):
                w = 0.0
                for nm, a, t, is_pole in marks:
                    ra_r, dec_r = vec_to_radec(a)
                    cand = radec_to_vec(su * (ra_r - 24.0 * k), sv * dec_r)
                    ang = angle_between(cand, t)
                    if is_pole:  # a plane normal is defined only up to sign
                        ang = min(ang, angle_between([-c for c in cand], t))
                    w = max(w, ang)
                return w
            ks = [i / 2000.0 for i in range(2000)]
            k0 = min(ks, key=worst)
            for step in (1e-3, 1e-4, 1e-5):
                k0 = min((k0 + j * step for j in range(-12, 13)), key=worst)
            per = []
            for nm, a, t, is_pole in marks:
                ra_r, dec_r = vec_to_radec(a)
                cand = radec_to_vec(su * (ra_r - 24.0 * k0), sv * dec_r)
                ang = angle_between(cand, t)
                if is_pole:
                    ang = min(ang, angle_between([-c for c in cand], t))
                per.append(ang)
            k0 = (k0 % 1.0 + 1.0) % 1.0
            flag = "  <== " if max(per) < 5.0 else ""
            print(f"        su {su:+.0f} sv {sv:+.0f}: k = {k0:.5f}  worst {max(per):7.2f} deg  "
                  + " ".join(f"{nm} {v:.2f}" for (nm, _, _, _), v in zip(marks, per)) + flag)
            if best_h is None or max(per) < best_h[0]:
                best_h = (max(per), su, sv, k0, per)

    # ── 6. General Procrustes, as a check on the closed form ────────────────
    worst_h, su, sv, k_h, per_h = best_h
    pole_sign = 1.0
    # Orient the fitted normal to whichever sign the winning hypothesis implies.
    ra_r, dec_r = vec_to_radec(normal)
    cand = radec_to_vec(su * (ra_r - 24.0 * k_h), sv * dec_r)
    if angle_between(cand, t_ngp) > 90.0:
        pole_sign = -1.0
    pairs = [([c * pole_sign for c in normal], t_ngp, 1.0), (centre, t_gc, 1.0),
             (blob1, t_lmc, 1.0), (blob2, t_smc, 1.0)]
    R = procrustes(pairs)
    res = [angle_between(matvec(R, a), t) for a, t, _ in pairs]
    print()
    print(f"[sky] general Procrustes (reflection allowed): det {det3(R):+.5f}  "
          f"worst {max(res):.2f} deg  (" + " ".join(f"{x:.2f}" for x in res) + ")")
    for row in R:
        print("        [ %+9.6f %+9.6f %+9.6f ]" % tuple(row))

    print()    # The closed form is judged on the PRECISE landmarks only. Judging it on all four
    # would let the two fuzzy ones (see section 8) veto a correct answer — which is
    # exactly what happened on the first run: the closed form was reported as a
    # non-fit on a 6.70 deg worst residual that the Clouds put at 1.17 and 0.68.
    cloud_worst = max(per_h[2], per_h[3])
    Rh = closed_from(su, sv, k_h)
    Rh_half = closed_from(su, sv, 0.5)

    # ── 8. Whole-image verification, using every pixel ──────────────────────
    # ⚠ THE 4-LANDMARK FIT IS NOT ENOUGH TO SETTLE THIS. Two of its landmarks are
    # fuzzy by construction: a luma-weighted plane normal is biased by the band's
    # brightness asymmetry, and "brightest smooth point near the plane" is not Sgr A*
    # (it measured Dec -35.7 against a true -29.0). Those two carry the entire 6.7 deg
    # worst residual, while the two PRECISE landmarks — the Clouds, compact and known
    # to arcminutes — sit at 1.17 and 0.68 deg. So the closed form may well be exact
    # and the general 3x3's extra ~3 deg of tilt may be nothing but those two bad
    # points being fitted. Deciding that from the same four points is circular.
    #
    # This section decides it from ALL 524,288 pixels: transform the image into TRUE
    # galactic coordinates and measure how tightly the light concentrates at b = 0.
    # A wrong u offset swings the plane off the pole and the band smears; the right
    # one minimises it. If the closed form matches the full 3x3 here, the tilt was fit
    # noise and the one-line shader fix is exact.
    print()
    print("[sky] whole-image check: rms galactic latitude of the light (lower = tighter band)")
    SW, SH = 512, 256
    spx = load_luma(src, SW, SH)
    sfloor = percentile(spx, 0.5)
    rows = []
    for y in range(SH):
        dec = (0.5 - (y + 0.5) / SH) * math.pi
        rows.append((math.cos(dec), math.sin(dec)))
    ra_col = [((x + 0.5) / SW) * 2.0 * math.pi for x in range(SW)]

    def rms_lat(mat):
        """Weighted rms of |galactic latitude| after mapping read-frame -> true frame.
        sin b = d_true . n_NGP = d_read . (R^T n_NGP), so the pole moves once per
        candidate instead of every pixel moving — 3 mults per pixel, not a matmul."""
        n = matvec(transpose(mat), t_ngp)
        amp = math.hypot(n[0], n[1])
        phi = math.atan2(n[1], n[0])
        cosa = [amp * math.cos(a - phi) for a in ra_col]
        num = den = 0.0
        for y in range(SH):
            cd, sd = rows[y]
            base = y * SW
            zt = sd * n[2]
            for x in range(SW):
                w = (spx[base + x] - sfloor) * cd
                if w <= 0.0:
                    continue
                s = cd * cosa[x] + zt
                b = math.asin(max(-1.0, min(1.0, s)))
                num += w * b * b
                den += w
        return math.sqrt(num / den) * R2D

    closed = closed_from

    ident = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
    print(f"        {'candidate':<34} {'rms |b|':>9}")
    print(f"        {'current shader (no correction)':<34} {rms_lat(ident):9.3f} deg")
    scan = []
    for kk in [0.470 + i * 0.0025 for i in range(25)]:
        scan.append((rms_lat(closed(-1.0, 1.0, kk)), kk))
    scan.sort()
    for r, kk in scan[:1]:
        print(f"        {'closed form su=-1, k=' + f'{kk:.4f}' + ' (best)':<34} {r:9.3f} deg")
    print(f"        {'closed form su=-1, k=0.5 exactly':<34} "
          f"{rms_lat(closed(-1.0, 1.0, 0.5)):9.3f} deg")
    print(f"        {'closed form su=-1, k from landmarks':<34} "
          f"{rms_lat(closed(su, sv, k_h)):9.3f} deg")
    print(f"        {'general 3x3 Procrustes':<34} {rms_lat(R):9.3f} deg")
    print("        k scan (rms |b| vs u offset):")
    for r, kk in sorted(scan, key=lambda e: e[1])[::3]:
        print(f"          k={kk:.4f}  {r:7.3f} deg  {'#' * int((r - 19.0) * 6)}")

    # Where does the light's centroid land in true galactic coordinates? For a
    # correct alignment the bulge must put it near l = 0, b = 0. This tests the SAME
    # degree of freedom as the scan above but reports it as a position, which is
    # easier to sanity-check than a variance.
    def gal_centroid(mat):
        acc = [0.0, 0.0, 0.0]
        for y in range(SH):
            cd, sd = rows[y]
            base = y * SW
            for x in range(SW):
                w = (spx[base + x] - sfloor) * cd
                if w <= 0.0:
                    continue
                d = matvec(mat, [cd * math.cos(ra_col[x]), cd * math.sin(ra_col[x]), sd])
                for i in range(3):
                    acc[i] += w * d[i]
        c = vnorm(acc)
        gz = t_ngp
        gx = vnorm([t_gc[i] - gz[i] * vdot(t_gc, gz) for i in range(3)])
        gy = vcross(gz, gx)
        b = math.asin(max(-1.0, min(1.0, vdot(c, gz)))) * R2D
        l = math.atan2(vdot(c, gy), vdot(c, gx)) * R2D
        return l, b

    for nm, mat in (("current shader", ident), ("closed form k=0.5", closed(-1.0, 1.0, 0.5)),
                    ("general 3x3", R)):
        l, b = gal_centroid(mat)
        print(f"        flux centroid, {nm:<20} galactic l {l:+8.2f}  b {b:+7.2f}"
              f"   (truth: l 0, b 0)")


    # ── 9. Verdict ──────────────────────────────────────────────────────────
    # Two independent criteria have to agree before the one-line fix is accepted:
    #   (a) the PRECISE landmarks (the Clouds) must be within ~2 deg, and
    #   (b) the closed form must be as tight as the unconstrained 3x3 on the
    #       whole-image test — otherwise the extra 3 DOF are buying real structure
    #       and the shader needs the matrix.
    rms_closed = rms_lat(Rh_half)
    rms_general = rms_lat(R)
    ok_clouds = cloud_worst < 2.0
    ok_whole = rms_closed <= rms_general + 0.2
    print()
    if ok_clouds and ok_whole:
        chosen = Rh_half
        sign = "-" if su < 0 else "+"
        vexpr = "v" if sv > 0 else "1.0 - v"
        print(f"[sky] ✅ ANSWER: the panorama is MIRRORED in u with a half-turn offset.")
        print(f"        shader:  u = fract(0.5 {sign} RA/(2*pi))      v = {vexpr}")
        print(f"        i.e. RA = 0h sits at the image CENTRE and RA increases to the LEFT,")
        print(f"        which is how all-sky charts are conventionally drawn (east left,")
        print(f"        north up) — the asset is a sky chart, not a globe texture.")
        print(f"        evidence: det(R) = {det3(R):+.4f} (reflection, not a rotation);")
        print(f"                  Magellanic Clouds match to {cloud_worst:.2f} deg;")
        print(f"                  landmark-fitted offset k = {k_h:.5f} vs 0.5 exactly;")
        print(f"                  whole-image rms |b| {rms_closed:.3f} deg vs {rms_general:.3f}")
        print(f"                  for the unconstrained 3x3 — the extra 3 DOF buy")
        print(f"                  {rms_general - rms_closed:+.3f} deg, i.e. nothing.")
    else:
        chosen = R
        print("[sky] ⚠ the simple family is NOT sufficient — the shader needs the full 3x3:")
        for row in R:
            print("        [ %+9.6f %+9.6f %+9.6f ]" % tuple(row))
        print(f"        clouds {cloud_worst:.2f} deg (want < 2), rms |b| closed {rms_closed:.3f}"
              f" vs general {rms_general:.3f} (want within 0.2)")

    # ── 7. Verify: where do known objects land in the corrected texture? ────
    Rinv = transpose(chosen)
    print()
    print("[sky] corrected texture UV for known objects (v: 0 = Dec +90):")
    print(f"        {'object':<12} {'RA h':>8} {'Dec':>8}  {'gal lat':>8}   {'u':>7} {'v':>7}"
          f"   px @{8192}x{4096}")
    for nm, (ra_h, dec, role) in TRUTH.items():
        t = radec_to_vec(ra_h, dec)
        u, v = vec_to_uv(matvec(Rinv, t))
        glat = 90.0 - angle_between(t, t_ngp)
        print(f"        {nm:<12} {ra_h:8.4f} {dec:+8.3f}  {glat:+8.2f}   {u:7.4f} {v:7.4f}"
              f"   {u*8192:7.0f} {v*4096:7.0f}")
    # ── 10. End-to-end check against REAL STARS ─────────────────────────────
    # The user's actual complaint was concrete: "the Big Dipper sits right on the
    # Milky Way band, though in reality it is far from it." So check exactly that,
    # offline, through the same formula the shader will use: sample the panorama at
    # each star's corrected UV and report how bright the sky is THERE.
    #
    # This is the strongest offline check available because it is end-to-end and it
    # uses landmarks that had NO part in the fit — 7 Big Dipper stars at galactic
    # latitude ~+50 to +60 must read near the sky floor, while stars on the band must
    # read bright. It is also the check that a plane fit or a landmark residual
    # cannot give you: it tests the actual texture values, not the geometry.
    CONSTELLATIONS = [
        ("Dubhe (UMa)",      11.062139,  61.750833, "Big Dipper"),
        ("Merak (UMa)",      11.030694,  56.382500, "Big Dipper"),
        ("Phecda (UMa)",     11.897167,  53.694722, "Big Dipper"),
        ("Megrez (UMa)",     12.257111,  57.032500, "Big Dipper"),
        ("Alioth (UMa)",     12.900472,  55.959722, "Big Dipper"),
        ("Mizar (UMa)",      13.398750,  54.925278, "Big Dipper"),
        ("Alkaid (UMa)",     13.792333,  49.313333, "Big Dipper"),
        ("Kaus Aust. (Sgr)", 18.402861, -34.384722, "on the band"),
        ("Nunki (Sgr)",      18.921083, -26.296667, "on the band"),
        ("Deneb (Cyg)",      20.690528,  45.280278, "on the band"),
        ("Alnilam (Ori)",     5.603560,  -1.201900, "near the band"),
        ("Betelgeuse (Ori)",  5.919528,   7.406944, "near the band"),
        ("Polaris (UMi)",     2.530300,  89.264100, "off the band"),
    ]

    def sample(u, v):
        """Bilinear sample of the full-res-ish luma grid, wrapping u, clamping v —
        the same wrap/clamp pair the material sets on the texture."""
        fx = u * W - 0.5
        fy = v * H - 0.5
        x0, y0 = math.floor(fx), math.floor(fy)
        tx, ty = fx - x0, fy - y0
        out = 0.0
        for dy, wy in ((0, 1 - ty), (1, ty)):
            yy = min(H - 1, max(0, y0 + dy))
            for dx, wx in ((0, 1 - tx), (1, tx)):
                out += wy * wx * px[yy * W + ((x0 + dx) % W)]
        return out

    floor_lo = percentile(px, 0.02)
    groups: dict[str, list[float]] = {}
    print()
    print("[sky] end-to-end: sky brightness AT each star, via the corrected UV")
    print(f"        {'star':<18} {'gal lat':>8} {'u':>7} {'v':>7} {'sky luma':>9}  group")
    for nm, ra_h, dec, grp in CONSTELLATIONS:
        t = radec_to_vec(ra_h, dec)
        u, v = vec_to_uv(matvec(Rinv, t))
        val = sample(u, v) - floor_lo
        groups.setdefault(grp, []).append(val)
        glat = 90.0 - angle_between(t, t_ngp)
        print(f"        {nm:<18} {glat:+8.2f} {u:7.4f} {v:7.4f} {val:9.5f}  {grp}")

    dipper = sum(groups["Big Dipper"]) / len(groups["Big Dipper"])
    onband = sum(groups["on the band"]) / len(groups["on the band"])
    ratio = onband / max(dipper, 1e-9)
    print()
    print(f"[sky] band stars average {onband:.5f}, Big Dipper stars average {dipper:.5f}"
          f"  ->  {ratio:.1f}x")
    if ratio > 4.0:
        print("[sky] ✅ the Big Dipper is OFF the band and Sagittarius/Cygnus are ON it.")
    else:
        print("[sky] ❌ the Big Dipper is still sitting on the band — the fix is WRONG.")

    # ── 11. Galactic ladder — the offline twin of `__lum.skyAlign()` ─────────
    # Sampled here so an in-engine reading can be told apart from a property of the
    # ASSET. Both must agree; if they do, anything surprising in the numbers is the
    # panorama's own brightness distribution, not the renderer's.
    gz = t_ngp
    gx = vnorm([t_gc[i] - gz[i] * vdot(t_gc, gz) for i in range(3)])
    gy = vcross(gz, gx)

    def gal(l_deg, b_deg):
        l, b = l_deg * D2R, b_deg * D2R
        cb = math.cos(b)
        v = [cb * math.cos(l) * gx[i] + cb * math.sin(l) * gy[i] + math.sin(b) * gz[i]
             for i in range(3)]
        return vec_to_uv(matvec(Rinv, v))

    print()
    print("[sky] galactic ladder (same landmarks as __lum.skyAlign):")
    print(f"        {'l':>5} {'b':>5}   {'u':>7} {'v':>7} {'luma':>9}  rel")
    band, poles = [], []
    ladder = ([(l, 0) for l in (0, 45, 90, 135, 180, 225, 270, 315)]
              + [(0, b) for b in (20, -20, 40, -40, 60, -60, 90, -90)])
    vals = {}
    for l_deg, b_deg in ladder:
        u, v = gal(l_deg, b_deg)
        val = sample(u, v) - floor_lo
        vals[(l_deg, b_deg)] = val
        if b_deg == 0:
            band.append(val)
        if abs(b_deg) == 90:
            poles.append(val)
    ref = vals[(0, 0)]
    for (l_deg, b_deg), val in vals.items():
        u, v = gal(l_deg, b_deg)
        print(f"        {l_deg:>5} {b_deg:>+5}   {u:7.4f} {v:7.4f} {val:9.5f}  {val/ref:6.3f}")

    bmin, pmax = min(band), max(poles)
    print()
    print(f"[sky] ⚠ the metric matters. Same data, three ways:")
    print(f"        min(b=0) / max(|b|=90)          = {bmin / max(pmax,1e-12):7.2f}x   <-- the honest one")
    print(f"        mean(b=0) / mean(|b|=90)        = "
          f"{(sum(band)/len(band)) / max(sum(poles)/len(poles),1e-12):7.2f}x")
    print(f"        min(b=0) / max(|b|=20, l=0)     = "
          f"{bmin / max(vals[(0,20)], vals[(0,-20)], 1e-12):7.2f}x   <-- MISLEADING")
    print("        ⚠ the third one is what the first version of __lum.skyAlign used, and it")
    print("        FAILED a correctly-aligned sky. Both of its ends are bad choices: the")
    print("        band's own brightness varies ~5x along its length (l=270 is a faint")
    print("        stretch), and b=+/-20 AT l=0 IS STILL THE GALACTIC BULGE, not off-band.")
    print("        So it divided the dimmest band point by a bulge sample.")
    print("        Monotone falloff with |b| at fixed l is the signature that actually")
    print("        distinguishes aligned from misaligned:")
    for b_deg in (0, 20, 40, 60, 90):
        v0 = vals[(0, 0)] if b_deg == 0 else vals[(0, b_deg)]
        print(f"          l=0  b={b_deg:+3}   {v0:9.5f}")

    print()
    print("[sky] ⚠ VERIFY IN-ENGINE, and verify against the STAR CATALOGUE, not against")
    print("      this script: __lum.aim() the galactic centre, both galactic poles, the")
    print("      anticentre, AND the Big Dipper (galactic latitude +60, so it must sit")
    print("      far off the band — that cross-check is what exposed the old error).")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
