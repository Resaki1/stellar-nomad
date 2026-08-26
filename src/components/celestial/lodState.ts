/**
 * Which LOD tier each celestial body is ACTUALLY drawing, published per frame.
 *
 * 🔑 WHY THIS EXISTS RATHER THAN RECOMPUTING IT. `__lum.lod()` needs to know the tier
 * at each measurement stop, and its first version inferred it from the body's PIXEL
 * diameter. That was wrong twice over: the switch keys on ABSOLUTE DISTANCE
 * (`config.lod.far`), so the same pixel size is a different tier on different bodies;
 * and a tier only engages once its textures are loaded AND its shader compiled
 * (`nearReadyState === 2`), so the live answer also depends on streaming state that no
 * formula can predict.
 *
 * ⚠ That is the same lesson as the star-capture witness: a diagnostic that recomputes
 * what it should observe is only right while nothing is surprising, which is exactly
 * when it is not needed. This reports the flag the renderer actually set.
 */
export type LodTier = "near" | "mid" | "far";

export type LodState = {
  tier: LodTier;
  /** Whether the sub-pixel stellar point is ALSO drawing — it crossfades over `far`. */
  pointVisible: boolean;
  /** The point's fade weight, 0..1. */
  pointFade: number;
  distKm: number;
};

const _state = new Map<string, LodState>();

export function publishLodState(id: string, s: LodState): void {
  _state.set(id, s);
}

export function getLodState(id: string): LodState | undefined {
  return _state.get(id);
}

/** The body's configured LOD switch distances, km. Published alongside the tier. */
const _thresholds = new Map<string, { near: number; far: number }>();

export function publishLodThresholds(
  id: string,
  near: number,
  far: number,
): void {
  _thresholds.set(id, { near, far });
}

export function getLodThresholds(
  id: string,
): { near: number; far: number } | undefined {
  return _thresholds.get(id);
}
