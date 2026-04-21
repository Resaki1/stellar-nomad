// ---------------------------------------------------------------------------
// Continuous collision detection for celestial bodies (stars, planets, moons).
//
// The transit drive can push the ship at ~10,000+ km/s, so per-step movement
// exceeds most body radii. A point-in-sphere test would tunnel straight
// through a planet; instead we sweep the segment (prev → curr) against each
// body's bounding sphere and return the earliest intersection.
//
// Allocation-free: a single module-level result object is reused.
// ---------------------------------------------------------------------------

export type CelestialCollider = {
  id: string;
  x: number;
  y: number;
  z: number;
  /** Radius in km (already inflated by any safety margin if desired). */
  r: number;
};

export type SweptHit = {
  body: CelestialCollider;
  /** Segment parameter in [0, 1] at the entry point (0 = prev, 1 = curr). */
  t: number;
  /** True when the start point was already inside the sphere. */
  startInside: boolean;
};

const _hit: SweptHit = {
  body: null as unknown as CelestialCollider,
  t: 0,
  startInside: false,
};

/**
 * Swept segment-vs-sphere test. Treats the ship as a point with an optional
 * hull radius added to each collider. Returns the earliest intersection or
 * null. The returned object is module-scoped and overwritten on each call —
 * consume the fields immediately.
 */
export function sweptSphereCollide(
  p0x: number, p0y: number, p0z: number,
  p1x: number, p1y: number, p1z: number,
  colliders: readonly CelestialCollider[],
  hullRadiusKm: number,
): SweptHit | null {
  const dx = p1x - p0x;
  const dy = p1y - p0y;
  const dz = p1z - p0z;
  const a = dx * dx + dy * dy + dz * dz;

  let hit: SweptHit | null = null;
  let bestT = Infinity;

  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    const r = c.r + hullRadiusKm;
    const fx = p0x - c.x;
    const fy = p0y - c.y;
    const fz = p0z - c.z;
    const c2 = fx * fx + fy * fy + fz * fz - r * r;

    // Already inside at segment start — earliest possible hit, short-circuit.
    if (c2 <= 0) {
      _hit.body = c;
      _hit.t = 0;
      _hit.startInside = true;
      return _hit;
    }

    // No motion this step and we're outside → no intersection possible.
    if (a <= 0) continue;

    const b = fx * dx + fy * dy + fz * dz;
    const disc = b * b - a * c2;
    if (disc < 0) continue;

    const t = (-b - Math.sqrt(disc)) / a;
    if (t >= 0 && t <= 1 && t < bestT) {
      bestT = t;
      _hit.body = c;
      _hit.t = t;
      _hit.startInside = false;
      hit = _hit;
    }
  }

  return hit;
}
