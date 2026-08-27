/**
 * Geometric sun occlusion — eclipses and umbra/penumbra shadowing of the LOCAL
 * scene (ship, asteroids), defect D27 in docs/LIGHTING_PLAN.md.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The atmosphere pass already occludes the key light for ONE body: the dominant
 * atmosphere body's `computeAtmosphereLighting` hard-zeroes `sunTransmittance`
 * when the camera→sun ray hits the ground. That covers "the ship is on Earth's
 * night side" and covers it BETTER than this module can (it also carries the
 * atmospheric extinction, so the penumbra reddens). But it leaves three gaps:
 *
 *   1. Bodies with no `config.atmosphere` — Luna, Mercury, Io, Europa,
 *      Ganymede, Callisto — never register with the atmosphere pass at all, so
 *      they cast no shadow whatsoever. Flying into Luna's umbra left the ship
 *      lit as if the Moon were not there.
 *   2. Only the NEAREST atmosphere body is dominant, so a second body in the
 *      same neighbourhood (Io while Jupiter is dominant) could not eclipse.
 *   3. The atmosphere registration is gated on the sphere LOD being visible
 *      (`distKm < config.lod.far`). Neptune's LOD gate is 12 M km while its
 *      umbra is **165 M km** long — a 14× band where the ship is geometrically
 *      inside the shadow but lit at full sun.
 *
 * This module closes all three with one registry that every `CelestialBody`
 * writes to unconditionally, and one visibility test that runs on the CPU once
 * per frame in `SunLight`.
 *
 * ── DIVISION OF LABOUR (do not double-count) ────────────────────────────────
 * `sunVisibility()` takes a `skipId`, and `SunLight` passes the dominant
 * atmosphere body's id. So each body's shadow has exactly ONE owner:
 *   • dominant atmosphere body → `computeAtmosphereLighting` (with extinction)
 *   • every other body         → this module (pure geometry)
 * Without the skip, the dominant body's penumbra would be narrowed by having
 * two different soft ramps multiplied together, and the carefully-tuned
 * "emergence band" that fixed the orange flash on shadow exit (see the comment
 * on SUN_EMERGE_BAND in atmospherePass.ts) would be fighting this one.
 *
 * ── WHY A DISC-OVERLAP PENUMBRA, NOT A BINARY TEST ──────────────────────────
 * The star is not a point. Its angular radius at 1 AU is 0.267°, and a binary
 * in-shadow test would snap the ship from full sun to black over one frame of
 * motion. The penumbra is where the star is PARTIALLY covered, and its width is
 * set by real geometry, so the correct model is the fraction of the star's disc
 * that the occluder's disc covers — two circles on the sky, exact analytic
 * intersection area. This is the same physics as `eclipseFn` in earth.ts (which
 * shadows Earth's surface during a lunar eclipse), expressed in the standard
 * circle-circle parameterisation rather than that function's own.
 *
 * Everything here is derived from radii and positions, so it needs no
 * per-body or per-system tuning and works unchanged for procedurally generated
 * systems and for orbital motion (LIGHTING_PLAN §3.0).
 */

import * as THREE from "three";

import type { RefractedLimb } from "./refractedLimbLight";

// =============================================================================
// Registry
// =============================================================================

type SunOccluder = {
  id: string;
  /** Body centre in ABSOLUTE km (the same frame as `config.positionKm`). */
  centerKm: THREE.Vector3;
  radiusKm: number;
};

const occluders = new Map<string, SunOccluder>();

/**
 * Register/update a body as a sun occluder for this frame. Cheap enough to call
 * unconditionally for every body every frame — a Map lookup and a vector copy.
 *
 * Deliberately NOT gated on LOD tier or on distance: gap 3 above is exactly
 * what a visibility gate causes. A body's shadow reaches far beyond the
 * distance at which the body itself is worth drawing.
 */
export function setSunOccluder(
  id: string,
  centerKm: THREE.Vector3 | readonly [number, number, number],
  radiusKm: number,
): void {
  let rec = occluders.get(id);
  if (!rec) {
    rec = { id, centerKm: new THREE.Vector3(), radiusKm };
    occluders.set(id, rec);
  }
  if (Array.isArray(centerKm)) {
    rec.centerKm.set(centerKm[0], centerKm[1], centerKm[2]);
  } else {
    rec.centerKm.copy(centerKm as THREE.Vector3);
  }
  rec.radiusKm = radiusKm;
}

export function clearSunOccluder(id: string): void {
  occluders.delete(id);
}

/**
 * A registered occluder's ABSOLUTE km centre, or null.
 *
 * 🔑 Exposed for D28, which needs the ship's position relative to a planet in ONE
 * consistent frame. `AtmosphereBodyRecord.centerScaled` is scaled-world while
 * `worldOrigin.shipPosKm` is km, and subtracting them silently yields a vector
 * whose direction is right and whose magnitude is meaningless — which is exactly
 * the bug this getter exists to prevent (it produced "always on the shadow axis",
 * the one answer that is wrong close in). Every `CelestialBody` registers here
 * unconditionally in absolute km, so this is the frame-safe source.
 */
export function sunOccluderCenterKm(id: string): THREE.Vector3 | null {
  return occluders.get(id)?.centerKm ?? null;
}

// =============================================================================
// Disc-overlap penumbra
// =============================================================================

/**
 * Fraction ∈[0,1] of a disc of angular radius `aStar` that is covered by a disc
 * of angular radius `bOcc` whose centre sits `cSep` away (all radians).
 *
 * Exact analytic circle-circle intersection area over the star's own area. The
 * four cases are all reachable in this game:
 *   • disjoint            → 0    (the common case; cheapest, tested first)
 *   • occluder engulfs    → 1    (total eclipse / umbra: standing behind Luna)
 *   • occluder inside     → r²   (annular: a small moon transiting the star)
 *   • partial lens        → area (penumbra)
 */
function discCoveredFraction(aStar: number, bOcc: number, cSep: number): number {
  if (cSep >= aStar + bOcc) return 0; // no overlap
  if (cSep <= bOcc - aStar) return 1; // star entirely behind the occluder
  const r = bOcc / aStar;
  if (cSep <= aStar - bOcc) return r * r; // occluder entirely on the star's disc

  // Lens area of two intersecting circles (radii a, b; centre separation c).
  const a2 = aStar * aStar;
  const b2 = bOcc * bOcc;
  const c2 = cSep * cSep;
  // acos arguments are algebraically in [-1,1] here but can step outside by an
  // epsilon in float; clamp rather than emit NaN into the light colour.
  const ca = Math.min(1, Math.max(-1, (c2 + a2 - b2) / (2 * cSep * aStar)));
  const cb = Math.min(1, Math.max(-1, (c2 + b2 - a2) / (2 * cSep * bOcc)));
  const tri = Math.max(
    0,
    (-cSep + aStar + bOcc) *
      (cSep + aStar - bOcc) *
      (cSep - aStar + bOcc) *
      (cSep + aStar + bOcc),
  );
  const area = a2 * Math.acos(ca) + b2 * Math.acos(cb) - 0.5 * Math.sqrt(tri);
  return Math.min(1, Math.max(0, area / (Math.PI * a2)));
}

// =============================================================================
// The per-frame test
// =============================================================================

/** Per-occluder detail, for the `__lum.sun()` diagnostic. */
export type SunOcclusionDetail = {
  id: string;
  /** Angular radius of the occluder as seen from the observer, degrees. */
  angOccDeg: number;
  /** Angular separation between the occluder centre and the star centre, degrees. */
  angSepDeg: number;
  /** Fraction of the star's disc this body covers. */
  covered: number;
  distKm: number;
};

const _toOcc = new THREE.Vector3();
const _toStar = new THREE.Vector3();
let _lastDetails: SunOcclusionDetail[] = [];
let _lastVisibility = 1;

/**
 * Fraction ∈[0,1] of the star's disc visible from `observerKm`, after every
 * registered body except `skipId`.
 *
 * Overlapping shadows are combined multiplicatively. That is exact whenever the
 * occluders do not overlap ON THE STAR'S DISC (the normal case — two bodies
 * transiting the same star simultaneously is a curiosity, and the error is
 * conservative: slightly too dark).
 */
export function sunVisibility(
  observerKm: THREE.Vector3,
  starPosKm: readonly [number, number, number],
  starRadiusKm: number,
  skipId: string | null = null,
): number {
  _lastDetails = [];
  if (occluders.size === 0) {
    _lastVisibility = 1;
    return 1;
  }

  _toStar.set(
    starPosKm[0] - observerKm.x,
    starPosKm[1] - observerKm.y,
    starPosKm[2] - observerKm.z,
  );
  const distStar = _toStar.length();
  if (distStar < 1e-6) {
    _lastVisibility = 1;
    return 1;
  }
  const angStar = Math.asin(Math.min(1, starRadiusKm / distStar));

  let visibility = 1;
  occluders.forEach((occ) => {
    if (occ.id === skipId) return;

    _toOcc.copy(occ.centerKm).sub(observerKm);
    // Cheap rejections before any trig, in order of how much they cull:
    //  • behind us relative to the star (half the sky, most frames)
    //  • farther than the star (can't shadow it; also guards a body AT the star)
    const along = _toOcc.dot(_toStar);
    if (along <= 0) return;
    const distOcc = _toOcc.length();
    if (distOcc >= distStar) return;

    const angOcc = Math.asin(Math.min(1, occ.radiusKm / Math.max(distOcc, 1e-6)));
    const angSep = Math.acos(
      Math.min(1, Math.max(-1, along / (distOcc * distStar))),
    );
    const covered = discCoveredFraction(angStar, angOcc, angSep);
    if (covered <= 0) return;

    visibility *= 1 - covered;
    _lastDetails.push({
      id: occ.id,
      angOccDeg: (angOcc * 180) / Math.PI,
      angSepDeg: (angSep * 180) / Math.PI,
      covered,
      distKm: distOcc,
    });
  });

  _lastVisibility = visibility;
  return visibility;
}

// =============================================================================
// Diagnostic hand-off
//
// SunLight publishes what it actually resolved each frame so `__lum.sun()` can
// answer "is the ship dark because of a shadow, and whose?" without the harness
// having to re-derive the ship position and re-run the whole chain. Rendering
// never reads this back.
// =============================================================================

const _directSun = {
  /** Unoccluded illuminance at the ship, game units (1/r² from the star). */
  illuminance: 0,
  /** Per-channel atmospheric transmittance the key light was tinted by. */
  transmittance: [1, 1, 1] as [number, number, number],
  /** Ambient-fill intensity the hull self-bounce was driven at, game units. */
  fillIntensity: 0,
  /** D28 refracted limb light resolved this frame, or null when not in shadow. */
  limb: null as RefractedLimb | null,
};

export function publishDirectSunState(
  illuminance: number,
  transmittance: THREE.Color,
  fillIntensity: number,
  limb: RefractedLimb | null = null,
): void {
  _directSun.illuminance = illuminance;
  _directSun.transmittance[0] = transmittance.r;
  _directSun.transmittance[1] = transmittance.g;
  _directSun.transmittance[2] = transmittance.b;
  _directSun.fillIntensity = fillIntensity;
  _directSun.limb = limb;
}

/** Last frame's occlusion state — read by `__lum.sun()`, never by rendering. */
export function sunOcclusionStatus(): {
  visibility: number;
  registered: number;
  occluding: SunOcclusionDetail[];
  illuminance: number;
  transmittance: [number, number, number];
  fillIntensity: number;
  limb: RefractedLimb | null;
} {
  return {
    visibility: _lastVisibility,
    registered: occluders.size,
    occluding: _lastDetails,
    illuminance: _directSun.illuminance,
    transmittance: _directSun.transmittance,
    fillIntensity: _directSun.fillIntensity,
    limb: _directSun.limb,
  };
}
