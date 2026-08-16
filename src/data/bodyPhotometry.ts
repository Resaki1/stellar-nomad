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

  mercury: { geometricAlbedo: 0.142, bondAlbedo: 0.088, colorIndexBV: 0.93, lunarLambertK: 0.9 },
  venus: {
    geometricAlbedo: 0.689,
    bondAlbedo: 0.76,
    colorIndexBV: 0.82,
    lunarLambertK: 0.0,
    note: "Cloud deck, so Lambertian-ish limb. Its optical depth (τ 9–46, single-scatter albedo →0.994) diverges Hillaire's Ψ=L₂/(1−F_ms) series; regularised by the uFmsMax=0.85 clamp in atmospherePass.ts (LIGHTING_PLAN §2.2.8). VERIFIED: R = 0.832 vs Monte-Carlo ground truth R* = 0.793, 4.9% high. Its correct `ratio vs sub-solar` is 0.767, NOT 1.0 — that reference assumes a Lambert sphere and Venus' real sub-solar/geometric ratio is 1.15.",
  },
  earth: { geometricAlbedo: 0.434, bondAlbedo: 0.306, colorIndexBV: 0.2, lunarLambertK: 0.1 },
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
  },
  jupiter: { geometricAlbedo: 0.538, bondAlbedo: 0.503, colorIndexBV: 0.83, lunarLambertK: 0.0 },
  saturn: { geometricAlbedo: 0.499, bondAlbedo: 0.342, colorIndexBV: 1.04, lunarLambertK: 0.0 },
  uranus: { geometricAlbedo: 0.488, bondAlbedo: 0.3, colorIndexBV: 0.56, lunarLambertK: 0.0 },
  neptune: { geometricAlbedo: 0.442, bondAlbedo: 0.29, colorIndexBV: 0.41, lunarLambertK: 0.0 },

  io: { geometricAlbedo: 0.63, bondAlbedo: 0.62, colorIndexBV: 1.17, lunarLambertK: 0.7 },
  europa: { geometricAlbedo: 0.67, bondAlbedo: 0.68, colorIndexBV: 0.87, lunarLambertK: 0.5 },
  ganymede: { geometricAlbedo: 0.43, bondAlbedo: 0.35, colorIndexBV: 0.83, lunarLambertK: 0.7 },
  callisto: { geometricAlbedo: 0.22, bondAlbedo: 0.11, colorIndexBV: 0.86, lunarLambertK: 0.9 },
};

/** Reference photometry for a body id, or undefined if it has no entry. */
export function bodyPhotometry(id: string): BodyPhotometry | undefined {
  return BODY_PHOTOMETRY[id];
}
