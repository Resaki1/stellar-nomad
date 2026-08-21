/**
 * The ONE definition of how a game-frame direction maps into the Milky Way
 * panorama's texture space.
 *
 * ── WHY THIS IS ITS OWN MODULE ───────────────────────────────────────────────
 * Because it now has TWO consumers — `MilkyWaySkybox` (which draws the sky) and
 * `skyIrradiance` (which integrates the same sky into an SH-L2 light probe) — and
 * a second copy of this formula is the exact shape of the defect that took four
 * attempts to find (D32, STAR_CATALOGUE_PLAN §8.6). If the bake and the render
 * disagree about where the galactic centre is, the hull is lit by a sky that is
 * not the sky on screen, and nothing about the picture makes that visible.
 *
 * So: one `Fn`, imported by both. Not a comment saying "keep these in sync".
 *
 * ── THE CONVENTION, MEASURED ─────────────────────────────────────────────────
 *     u = fract(0.5 − RA/2π)          v = (90° − Dec)/180°
 *
 * ⚠ NOTE THE MINUS SIGN AND THE HALF-TURN. The textbook equirect is `u = RA/2π`;
 * this asset is a sky **chart** — RA 0h at the image centre, RA increasing
 * **leftward**, the ordinary astronomical convention (north up, east left) — which
 * makes it a REFLECTION of the naive reading. That is why three earlier attempts
 * to fix the orientation by *rotating* could not possibly have worked.
 *
 * Solved by `scripts/solve_sky_orientation.py` against the panorama itself:
 * `det(R) = −1.00000`; the Magellanic Clouds match to 1.17°/0.68°; whole-image rms
 * galactic latitude of the light falls from 37.7° to 9.69°. Gated in-engine by
 * `__lum.skyAlign()` (band/pole 6.97×, monotone falloff on both arms).
 *
 * ⚠ If the panorama asset is ever replaced, RE-SOLVE it — do not assume. The
 * script exists for exactly that, and `scripts/build_diffuse_sky.sh` says so too.
 *
 * Landmark UVs under this convention (verify with `__lum.aim`):
 *   galactic centre  → (0.7600, 0.6612)   RA 17.7611h Dec −29.0078°
 *   north gal. pole  → (0.9643, 0.3493)   RA 12.8576h Dec +27.1283°
 *   LMC              → (0.2753, 0.8875)   RA  5.3929h Dec −69.756°
 *   Big Dipper       → (0.9811, 0.1846)   RA 12.2570h Dec +56.382°  (b = +60°)
 */

import { Fn, asin, atan, clamp, float, vec2, vec3 } from "three/tsl";

/** Obliquity of the ecliptic, J2000. */
export const OBLIQUITY_J2000_RAD = (23.4392911 * Math.PI) / 180;
export const COS_OBLIQUITY = Math.cos(OBLIQUITY_J2000_RAD);
export const SIN_OBLIQUITY = Math.sin(OBLIQUITY_J2000_RAD);

/**
 * Game-frame unit direction → panorama UV.
 *
 * The game's scaled scene has the ecliptic in the xz-plane with +y at the ecliptic
 * north pole (MEASURED from sol.json: every body has y = 0). The panorama is in
 * equatorial J2000. So this rotates the direction back to equatorial — the exact
 * analytic inverse of `StarField`'s `equatorialToGame`, whose 2×2 block has
 * determinant 1 — and then applies the measured chart convention above.
 *
 * @param dir MUST be normalised.
 */
export const panoramaUvFromGameDir = /*#__PURE__*/ Fn(
  ([dir]: [ReturnType<typeof vec3>]) => {
    // game → equatorial (inverse of equatorialToGame)
    const ex = dir.x;
    const ey = float(-SIN_OBLIQUITY)
      .mul(dir.y)
      .sub(float(COS_OBLIQUITY).mul(dir.z));
    const ez = float(COS_OBLIQUITY)
      .mul(dir.y)
      .sub(float(SIN_OBLIQUITY).mul(dir.z));
    // `atan` returns (−π, π], so RA/2π ∈ (−0.5, 0.5] and 1.5 − that ∈ [1, 2);
    // the `fract` brings it to [0, 1) without a branch. TSL spells the
    // two-argument form `atan(y, x)`.
    const u = float(1.5)
      .sub(atan(ey, ex).mul(float(1 / (2 * Math.PI))))
      .fract();
    const v = float(0.5).sub(
      asin(clamp(ez, float(-1), float(1))).mul(float(1 / Math.PI)),
    );
    return vec2(u, v);
  },
).setLayout({
  name: "panoramaUvFromGameDir",
  type: "vec2",
  inputs: [{ name: "dir", type: "vec3" }],
});
