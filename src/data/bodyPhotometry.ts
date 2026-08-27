// ─────────────────────────────────────────────────────────────────────
// REFERENCE PHOTOMETRY — measured optical properties of the solar system's
// bodies. docs/LIGHTING_PLAN.md §3.6.
//
// This is REFERENCE DATA, not tuning. Every number here is a published
// measurement, so it is the thing the renderer should be checked AGAINST rather
// than something to adjust until the picture looks nice. If a rendered body
// disagrees with its row, the renderer is wrong.
//
// Phase 0 consumes this only from the `__lum` validation harness. Phase 4 makes
// it the authority for the impostor tiers, replacing the eyeballed constants
// (`REFERENCE_HDR`, `JUPITER_REF_FLUX`, `mars.ts`'s `12.0`, and the per-body
// `stellarPoint.geometricAlbedo` values — several of which are far off, see the
// discrepancy notes below).
//
// ⚠ `geometricAlbedo` is the DISC-AVERAGED value at zero phase angle, which is
// what the magnitude system is defined on. The sub-solar NADIR radiance is
// higher than `p·E/π` for any limb-darkened body, so expect a real render to sit
// somewhat above the Lambertian-equivalent figure rather than exactly on it.
// ─────────────────────────────────────────────────────────────────────

export type BodyPhotometry = {
  /** Geometric albedo, V band — disc-averaged at zero phase. */
  geometricAlbedo: number;
  /** Bond albedo (fraction of all incident flux reflected), where published. */
  bondAlbedo?: number;
  /** B−V colour index. Used to derive a defensible tint in Phase 4. */
  colorIndexBV?: number;
  /**
   * Lunar-Lambert mixing weight k for the phase function (LIGHTING_PLAN §3.6):
   *   Φ = (1−k)·μ₀ + k·(2μ₀/(μ₀+μ))
   * ~0.9 for airless regolith (hard limb, opposition surge), 0 for a cloud deck
   * or smooth ice (soft Lambertian limb).
   */
  lunarLambertK: number;
  /**
   * Set when the body's COLOUR MAP carries only part of its disc albedo, with the
   * reason. D09's automatic calibration (`albedoCalibration.ts`) is SKIPPED for
   * these, because scaling a partial layer up to the whole-disc `geometricAlbedo`
   * double-counts whatever the other layers contribute.
   *
   * ⚠⚠ THIS FIELD EXISTS BECAUSE THE INSTRUMENT CAUGHT IT. Earth's day map measured
   * a sphere-mean of **0.0893**, and calibration wanted to scale it ×4.86 (+2.28
   * stops) to reach p = 0.434. But 0.0893 is very close to the real CLOUD-FREE Earth
   * surface albedo (~0.10 — 71% ocean at ~0.06 plus land at ~0.2), so the texture was
   * already about right and the TARGET was wrong: most of Earth's 0.434 is the
   * separate cloud layer. 🔑 That the measurement landed on an independently-known
   * physical value is also the best validation the reduction pass has — it is right,
   * which is how we know the target was the wrong half.
   */
  colourMapPartialReason?: string;
  /**
   * Measured reflectance as linear sRGB, when published spectrophotometry is
   * available. Overrides the B−V derivation in `bodyColour.ts`.
   *
   * ⚠⚠ THIS FIELD IS FOR MEASUREMENTS ONLY. `colorIndexBV` gives one degree of
   * freedom (blue-vs-green) and RGB needs two, so the derivation closes the gap with
   * a linear-spectral-slope model — which is weakest exactly where methane absorbs in
   * the red, i.e. the ICE GIANTS. That is the case this override exists for. Putting
   * an eyeballed triple here re-creates the authored-constant problem D09 was about;
   * only fill it in with a citable value and put the citation in `note`.
   * Magnitude is ignored — the value is renormalised to `geometricAlbedo`.
   */
  measuredReflectanceRgb?: readonly [number, number, number];
  /**
   * Geometric albedo per Johnson–Cousins band, from **Mallama, Krobusek & Pavlov
   * (2017), Icarus 282, 19–33, Table 7** ("Geometric albedos", Johnson–Cousins
   * block). arXiv:1609.05048.
   *
   * 🔑🔑 THIS IS THE SAME SOURCE `geometricAlbedo` ALREADY CAME FROM. Verified: all
   * eight planets' `geometricAlbedo` here match that table's V column to every
   * digit (Mercury 0.142, Venus 0.689, Earth 0.434, Mars 0.170, Jupiter 0.538,
   * Saturn 0.499, Uranus 0.488, Neptune 0.442). So these are not a second opinion
   * bolted on beside the first — they are the rest of a row this table was already
   * quoting one cell of.
   *
   * ⚠⚠ THIS IS THE FIX FOR D09b's KNOWN FAILURE MODE, and it is a real measurement
   * rather than a better model. `colorIndexBV` is ONE degree of freedom, closed with
   * a linear-spectral-slope assumption that cannot represent narrow absorption —
   * and the ice giants' colour IS narrow absorption (methane, in the red). Three
   * bands settle it: MEASURED R/B is **0.360 for Uranus and 0.322 for Neptune**,
   * against 0.875 / 0.686 from the slope model. The model was ~1.8× and ~1.6× too
   * red, in exactly the direction D09b predicted in writing.
   *
   * ⚠ Bands are wide averages, so interpolating between them smooths over the deep
   * CH₄ features inside each band. That is a real limitation and it is still far
   * better than extrapolating a straight line off two points.
   *
   * Consumed by `bodyColour.ts`, which integrates the interpolated spectrum against
   * the CIE colour-matching functions under the star's own Planck spectrum. Add a
   * body here and its colour improves automatically; nothing is pasted.
   */
  bandAlbedo?: {
    /** U, 365 nm */ U?: number;
    /** B, 445 nm */ B?: number;
    /** V, 551 nm */ V?: number;
    /** R, 658 nm */ R?: number;
    /** I, 806 nm */ I?: number;
  };
  /**
   * Johnson–Cousins V−R. The SECOND degree of freedom D09b said was needed; with
   * `colorIndexBV` it gives a three-band spectrum without a full `bandAlbedo` row.
   *
   * ⚠⚠ DELIBERATELY EMPTY FOR THE GALILEAN MOONS AND LUNA, and the reason is worth
   * keeping: the readily-available compilation (johnstonsarchive, crediting "L09b")
   * lists Ganymede 1.04, Io 0.72, Europa 0.69, Callisto 0.25 — which puts GANYMEDE
   * REDDER THAN IO and CALLISTO BLUER THAN THE SUN (0.352). Both contradict how
   * those bodies plainly look, and the same page's B−V column (Io 1.17 ≫ Europa
   * 0.87 ≈ Ganymede 0.83 ≈ Callisto 0.86) has the ordering right. So the V−R column
   * is not trustworthy, probably mixing photometric systems.
   * 🔑 A citation is necessary but NOT sufficient — it also has to survive a
   * plausibility check. These need a primary source before they go in.
   */
  colorIndexVR?: number;
  /** Where the number came from, and anything that disagrees with it in-engine. */
  note?: string;
};

export const BODY_PHOTOMETRY: Record<string, BodyPhotometry> = {
  sol: {
    // Not a reflector. Kept here so the harness can assert the disc's radiance:
    // 1.6e9 cd/m² mean, ≈265,000 game units — which OVERFLOWS RGBA16F and is
    // why pre-exposure exists (LIGHTING_PLAN §3.2). T_eff 5772 K.
    geometricAlbedo: 0,
    lunarLambertK: 0,
    note: "Emitter. Mean disc luminance 1.6e9 cd/m²; T_eff 5772 K.",
  },

  mercury: { geometricAlbedo: 0.142, bondAlbedo: 0.088, colorIndexBV: 0.93, lunarLambertK: 0.9, bandAlbedo: { U: 0.087, B: 0.105, V: 0.142, R: 0.172, I: 0.208 },},
  venus: {
    geometricAlbedo: 0.689,
    bondAlbedo: 0.76,
    colorIndexBV: 0.82,
    lunarLambertK: 0.0,
    note: "Cloud deck, so Lambertian-ish limb. Its optical depth (τ 9–46, single-scatter albedo →0.994) diverges Hillaire's Ψ=L₂/(1−F_ms) series; regularised by the uFmsMax=0.85 clamp in atmospherePass.ts (LIGHTING_PLAN §2.2.8). VERIFIED: R = 0.832 vs Monte-Carlo ground truth R* = 0.793, 4.9% high. Its correct `ratio vs sub-solar` is 0.767, NOT 1.0 — that reference assumes a Lambert sphere and Venus' real sub-solar/geometric ratio is 1.15.",
      bandAlbedo: { U: 0.348, B: 0.658, V: 0.689, R: 0.708, I: 0.584 },
  },
  earth: {
    geometricAlbedo: 0.434,
    bondAlbedo: 0.306,
    colorIndexBV: 0.2,
    lunarLambertK: 0.1,
    colourMapPartialReason:
      "`day` is a CLOUD-FREE surface map and clouds are a separate layer, so most of " +
      "the 0.434 disc albedo is not in this texture. Its measured sphere-mean 0.0893 " +
      "already matches the real cloud-free surface (~0.10). Earth's disc albedo has to " +
      "be closed by accounting for the cloud layer's contribution (and D23's crushed " +
      "ocean), not by scaling the surface up 4.86x.",
      bandAlbedo: { U: 0.688, B: 0.512, V: 0.434, R: 0.418, I: 0.430 },
  },
  luna: {
    geometricAlbedo: 0.136,
    bondAlbedo: 0.11,
    colorIndexBV: 0.92,
    lunarLambertK: 0.9,
    note: "⚠ luna.ts:151 sets stellarPoint.geometricAlbedo = 0.0036 — 38× too DIM. Eyeballed, presumably to stop the point glaring. Fix in Phase 4; expect the __lum moon row to fail until then.",
  },
  mars: {
    geometricAlbedo: 0.17,
    bondAlbedo: 0.25,
    colorIndexBV: 1.36,
    lunarLambertK: 0.85,
    note: "⚠ mars.ts:109's billboard 12.0 is a hand-patch for the billboard↔point discontinuity (D06), confirmed by the author. Delete in Phase 4, do not retune.",
      bandAlbedo: { U: 0.060, B: 0.088, V: 0.170, R: 0.288, I: 0.330 },
  },
  jupiter: { geometricAlbedo: 0.538, bondAlbedo: 0.503, colorIndexBV: 0.83, lunarLambertK: 0.0, bandAlbedo: { U: 0.358, B: 0.443, V: 0.538, R: 0.495, I: 0.321 },},
  saturn: { geometricAlbedo: 0.499, bondAlbedo: 0.342, colorIndexBV: 1.04, lunarLambertK: 0.0, bandAlbedo: { U: 0.203, B: 0.339, V: 0.499, R: 0.568, I: 0.423 },},
  uranus: { geometricAlbedo: 0.488, bondAlbedo: 0.3, colorIndexBV: 0.56, lunarLambertK: 0.0, bandAlbedo: { U: 0.502, B: 0.561, V: 0.488, R: 0.202, I: 0.079 },},
  neptune: { geometricAlbedo: 0.442, bondAlbedo: 0.29, colorIndexBV: 0.41, lunarLambertK: 0.0, bandAlbedo: { U: 0.578, B: 0.562, V: 0.442, R: 0.181, I: 0.067 },},

  io: { geometricAlbedo: 0.63, bondAlbedo: 0.62, colorIndexBV: 1.17, lunarLambertK: 0.7 },
  europa: { geometricAlbedo: 0.67, bondAlbedo: 0.68, colorIndexBV: 0.87, lunarLambertK: 0.5 },
  ganymede: { geometricAlbedo: 0.43, bondAlbedo: 0.35, colorIndexBV: 0.83, lunarLambertK: 0.7 },
  callisto: { geometricAlbedo: 0.22, bondAlbedo: 0.11, colorIndexBV: 0.86, lunarLambertK: 0.9 },
};

/** Reference photometry for a body id, or undefined if it has no entry. */
export function bodyPhotometry(id: string): BodyPhotometry | undefined {
  return BODY_PHOTOMETRY[id];
}
