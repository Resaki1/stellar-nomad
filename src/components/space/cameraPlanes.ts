/**
 * Near/far planes for the two render cameras, in their own leaf module so
 * `Star.tsx` can derive its shell clamp from `SCALED_CAMERA_FAR` without
 * importing `SpaceRenderer` (which imports `lumHarness`, closing a cycle).
 */

export const LOCAL_CAMERA_NEAR = 0.01;
/** 20,000 km in local metres. */
export const LOCAL_CAMERA_FAR = 20_000 * 1000;

// 0.001 scaled units = 1 km. The closest scaled geometry is a planet surface at
// ~30+ units (with floating origin), so this is safe; a tight near plane buys
// depth precision at medium range — it fixed z-fighting on Saturn's rings at
// ~1.4M km. (Don't use logarithmicDepthBuffer — it breaks depth for custom
// vertexNode.)
export const SCALED_CAMERA_NEAR = 0.001;
/**
 * 2e6 scaled units = 2e9 km = **13.369 AU**.
 *
 * ⚠ Anything drawn at its true scaled position past this is clipped — and the
 * far plane is FLAT, so the boundary is `far / cos θ`: 13.37 AU at frame centre,
 * ~18 AU at the corner. That was the sun vanishing past Saturn
 * (docs/STAR_RENDERING_PLAN.md §1). Raising it does not scale — the nearest star
 * is 253,000 AU — so distant emitters project onto a shell instead.
 */
export const SCALED_CAMERA_FAR = 2_000_000;
