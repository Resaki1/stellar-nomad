// ─────────────────────────────────────────────────────────────────────
// BODY-ON-BODY STAR OCCLUSION — eclipses, both directions, every body
// (defect D34)
// ─────────────────────────────────────────────────────────────────────
//
// ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────
// `CelestialBody` set `uSunIlluminance` from the body's own star distance
// and never consumed occlusion. It REGISTERED as a sun occluder (D27, so the
// ship gets shadowed) but never asked whether anything was shadowing IT. So:
//
//   • Luna inside Earth's umbra rendered at **FULL SUNLIGHT** — there was no
//     lunar eclipse at all, which is worse than "an eclipsed Moon is black".
//   • Io's shadow never fell on Jupiter, Phobos' never on Mars, and no
//     generated system could have an eclipse.
//
// ⚠ And the one eclipse that DID work was hardcoded: `earth.ts` carried
// `uMoonPos`/`uMoonRadius`, i.e. Earth could only ever be eclipsed by Luna.
//
// ── 🔑🔑 WHY THIS IS SMALL: THE MATH ALREADY EXISTED, TWICE ──────────
// A spherical occluder against a spherical star is an exact analytic
// circle-circle overlap on the sky, and this repo already had it in two
// places — `sunOcclusion.ts`'s `discCoveredFraction` (CPU, for the ship) and
// `earth.ts`'s `eclipseFn` (TSL, per-pixel, which is what draws Earth's
// solar-eclipse shadow today). **So D34 is a PROMOTION, not new physics:**
// lift the TSL version here, drive it from the occluder registry that already
// holds every body's absolute km centre, and every body gets both directions.
//
// ── 🔑 ONE FUNCTION COVERS BOTH DIRECTIONS, because it is PER-PIXEL ──
// The question "what fraction of the star's disc is blocked at this point?"
// does not care about the relative sizes involved:
//
//   • Occluder's shadow ≫ the body → every pixel returns ~0 ⇒ a total lunar
//     eclipse, and during a PARTIAL one the penumbra gradient falls correctly
//     across the disc, which a single per-body-centre test cannot give.
//   • Occluder's shadow ≪ the body → only pixels inside the spot darken ⇒ a
//     solar eclipse with a real umbra and penumbra.
//
// That is why this is evaluated in the fragment shader rather than as a
// per-body scalar. ⚠ The FAR/POINT tiers are a few pixels across, so there
// the same test is evaluated once at the body's centre on the CPU and applied
// as a scalar — `updateEclipseUniforms` returns it.
//
// ── PERFORMANCE ─────────────────────────────────────────────────────
// CPU: one pass over the occluder registry per body per frame, with two dot
// products and an early reject. Sol has ~13 bodies; a generated system with
// 50 is still nothing.
// GPU: `MAX_ECLIPSE_OCCLUDERS` unrolled, ~15 ALU each, and **no branches** —
// see the note on `w = 0` below, which makes unused slots return exactly 1.0
// through the same arithmetic. Typical frames have 0 or 1 real occluder.
//
// ── SCIENTIFIC ACCURACY, and what is deliberately left out ──────────
// ✅ Exact for spherical bodies and a uniform stellar disc: the overlap area
// of two circles on the sky, which is what `eclipseCoveredFraction` computes
// in closed form. Umbra, penumbra and annular eclipses all fall out of the
// same expression — an annular eclipse is just the case where the occluder's
// disc sits entirely inside the star's.
// ⚠ NOT modelled: the star's limb darkening (would slightly deepen the
// penumbra gradient), the occluder's own atmosphere refracting light into its
// umbra (that is D28, `refractedLimbLight.ts` — and it is what makes an
// eclipsed Moon coppery rather than black), and non-spherical bodies.
// ⚠ Occluders are combined MULTIPLICATIVELY. Exact unless two of them overlap
// ON THE STAR'S DISC — a genuine curiosity — and the error there is
// conservative (slightly too dark). Same choice `sunOcclusion.ts` documents.

import * as THREE from "three";
import {
  Fn,
  If,
  PI,
  acos,
  asin,
  clamp,
  dot,
  float,
  length,
  normalize,
  pow,
  positionLocal,
  sin,
  sub,
  uniform,
  vec3,
  vec4,
} from "three/tsl";

import { sunOccluderList } from "@/components/space/sunOcclusion";

/**
 * Occluder slots per body. 4 is generous: Sol's busiest case is Jupiter, where
 * two Galilean shadows can land at once. ⚠ Unrolled in the shader, so raising
 * this costs GPU time on every lit pixel of every body.
 */
export const MAX_ECLIPSE_OCCLUDERS = 4;

/**
 * Fraction of a light disc visible past an occluding disc — 1 = unobscured,
 * 0 = total. All three arguments are ANGULAR radii/separation in radians.
 *
 * Promoted verbatim from `earth.ts`, where it drew Earth's solar eclipse.
 * Exact circle-circle overlap area over the light disc's own area.
 *
 * 🔑 A ZERO-RADIUS OCCLUDER RETURNS EXACTLY 1.0 THROUGH THE NORMAL PATH: with
 * `angleOcc = 0` the membership test `angleLight − 0 < angleBetween <
 * angleLight + 0` is false, so `v` stays 1 and the division by
 * `angleBetween` is never reached. **That is what lets unused occluder slots
 * be encoded as `radius = 0` and evaluated branchlessly** — no `count`
 * uniform, no divergence, no special case.
 */
export const eclipseCoveredFraction = Fn(
  ([angleBetween, angleLight, angleOcc]: [
    ReturnType<typeof float>,
    ReturnType<typeof float>,
    ReturnType<typeof float>,
  ]) => {
    const r2 = pow(angleOcc.div(angleLight.max(1e-9)), float(2));
    const v = float(1.0).toVar();
    If(
      angleBetween
        .greaterThan(angleLight.sub(angleOcc))
        .and(angleBetween.lessThan(angleLight.add(angleOcc))),
      () => {
        If(angleBetween.lessThan(angleOcc.sub(angleLight)), () => {
          // Star entirely behind the occluder — total eclipse.
          v.assign(0.0);
        }).Else(() => {
          const x = float(0.5)
            .div(angleBetween.max(1e-9))
            .mul(
              angleBetween
                .mul(angleBetween)
                .add(angleLight.mul(angleLight))
                .sub(angleOcc.mul(angleOcc)),
            );
          const thL = acos(clamp(x.div(angleLight.max(1e-9)), -1, 1));
          const thO = acos(
            clamp(angleBetween.sub(x).div(angleOcc.max(1e-9)), -1, 1),
          );
          v.assign(
            float(1.0)
              .div(PI)
              .mul(
                sub(PI, thL)
                  .add(float(0.5).mul(sin(thL.mul(2))))
                  .sub(thO.mul(r2))
                  .add(float(0.5).mul(r2).mul(sin(thO.mul(2)))),
              ),
          );
        });
      },
    )
      .ElseIf(angleBetween.greaterThan(angleLight.add(angleOcc)), () => {
        // Discs disjoint — nothing is blocked.
        v.assign(1.0);
      })
      .Else(() => {
        // ⚠⚠ THE ANNULAR CASE, and I dropped it on the first pass at promoting
        // this. `angleBetween ≤ angleLight − angleOcc` means the occluder's disc
        // sits ENTIRELY INSIDE the star's, so the blocked fraction is the ratio
        // of areas: `v = 1 − (angleOcc/angleLight)²`. Without this branch a
        // transiting moon smaller than the star would have read fully lit —
        // exactly the Io-across-Jupiter case D34 exists for. The original
        // `earth.ts` version had it; the port lost it and tsc could not care.
        //
        // 🔑 It is also what keeps an UNUSED slot correct: `angleOcc = 0` gives
        // `r2 = 0` and therefore `v = 1`.
        v.assign(float(1.0).sub(r2));
      });
    return clamp(v, 0, 1);
  },
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type U = any;

export type EclipseUniforms = {
  /**
   * One per slot: `xyz` = occluder centre RELATIVE TO THIS BODY'S CENTRE in km,
   * `w` = occluder radius in km. ⚠ `w = 0` marks an unused slot and returns
   * visibility 1 through the ordinary path — see `eclipseCoveredFraction`.
   *
   * ⚠⚠ RELATIVE, IN KM, ON PURPOSE. Absolute positions are ~1e8 km and the
   * scaled scene uses its own units; both invite the frame-mixing class of bug
   * that D28c hit (a vector with the right direction and a meaningless
   * magnitude). Everything here is body-relative km, and the shader derives the
   * surface point the same way, so there is one frame and no conversion.
   */
  occ: U[];
  /** Star centre relative to this body's centre, km. */
  starRelKm: U;
  /** Star radius, km. */
  starRadiusKm: U;
  /** This body's radius, km — turns a unit surface normal into a km offset. */
  bodyRadiusKm: U;
};

export function createEclipseUniforms(): EclipseUniforms {
  return {
    occ: Array.from({ length: MAX_ECLIPSE_OCCLUDERS }, () =>
      uniform(new THREE.Vector4(0, 0, 0, 0)),
    ),
    starRelKm: uniform(new THREE.Vector3(1, 0, 0)),
    starRadiusKm: uniform(1),
    bodyRadiusKm: uniform(1),
  };
}

const _toOcc = new THREE.Vector3();
const _toStar = new THREE.Vector3();

type Candidate = { dx: number; dy: number; dz: number; r: number; key: number };
const _cands: Candidate[] = [];

/**
 * Pick this frame's occluders for one body and write them into `u`.
 *
 * @returns visibility at the body's CENTRE, for the far/point tiers (which are
 *          too few pixels to justify the per-pixel path).
 *
 * ⚠ Selection is a NECESSARY-condition test, not a sufficient one: it keeps any
 * body whose disc could touch the star's disc anywhere on this body's surface,
 * and lets the shader decide per pixel. Being generous here is cheap; being
 * wrong here silently deletes eclipses.
 */
export function updateEclipseUniforms(
  u: EclipseUniforms,
  bodyId: string,
  bodyCenterKm: readonly [number, number, number],
  bodyRadiusKm: number,
  starPosKm: readonly [number, number, number],
  starRadiusKm: number,
): number {
  u.bodyRadiusKm.value = bodyRadiusKm;
  u.starRadiusKm.value = starRadiusKm;
  _toStar.set(
    starPosKm[0] - bodyCenterKm[0],
    starPosKm[1] - bodyCenterKm[1],
    starPosKm[2] - bodyCenterKm[2],
  );
  u.starRelKm.value.copy(_toStar);
  const distStar = _toStar.length();

  _cands.length = 0;
  if (distStar > 1e-6) {
    const angStar = Math.asin(Math.min(1, starRadiusKm / distStar));
    const list = sunOccluderList();
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o.id === bodyId) continue;
      _toOcc.set(
        o.centerKm.x - bodyCenterKm[0],
        o.centerKm.y - bodyCenterKm[1],
        o.centerKm.z - bodyCenterKm[2],
      );
      const along = _toOcc.dot(_toStar);
      // Behind us relative to the star, or beyond the star: cannot shadow us.
      if (along <= 0) continue;
      const distOcc = _toOcc.length();
      if (distOcc >= distStar) continue;
      const angOcc = Math.asin(Math.min(1, o.radiusKm / Math.max(distOcc, 1e-6)));
      const angSep = Math.acos(
        Math.min(1, Math.max(-1, along / (distOcc * distStar))),
      );
      // ⚠ The body's own extent swings the direction to the occluder by up to
      // `bodyRadius/distOcc`, so a shadow can clip the LIMB while missing the
      // centre. Without this term a grazing eclipse would pop in and out.
      const slack = bodyRadiusKm / Math.max(distOcc, 1e-6);
      if (angSep > angStar + angOcc + slack) continue;
      _cands.push({
        dx: _toOcc.x,
        dy: _toOcc.y,
        dz: _toOcc.z,
        r: o.radiusKm,
        // Rank by how deeply it bites: smaller = more central = keep first.
        key: angSep - angOcc,
      });
    }
    _cands.sort((a, b) => a.key - b.key);
  }

  for (let i = 0; i < MAX_ECLIPSE_OCCLUDERS; i++) {
    const c = _cands[i];
    if (c) u.occ[i].value.set(c.dx, c.dy, c.dz, c.r);
    else u.occ[i].value.set(0, 0, 0, 0);
  }

  // Centre visibility for the far/point tiers, same math on the CPU.
  let vis = 1;
  if (distStar > 1e-6) {
    const angStar = Math.asin(Math.min(1, starRadiusKm / distStar));
    for (let i = 0; i < Math.min(_cands.length, MAX_ECLIPSE_OCCLUDERS); i++) {
      const c = _cands[i];
      const d = Math.hypot(c.dx, c.dy, c.dz);
      const angOcc = Math.asin(Math.min(1, c.r / Math.max(d, 1e-6)));
      const cosSep =
        (c.dx * _toStar.x + c.dy * _toStar.y + c.dz * _toStar.z) /
        Math.max(d * distStar, 1e-9);
      const angSep = Math.acos(Math.min(1, Math.max(-1, cosSep)));
      vis *= discOverlapCpu(angStar, angOcc, angSep);
    }
  }
  return vis;
}

/** CPU twin of `eclipseCoveredFraction`, for the far/point tiers. */
function discOverlapCpu(aStar: number, bOcc: number, cSep: number): number {
  if (cSep >= aStar + bOcc) return 1; // disjoint
  if (cSep <= bOcc - aStar) return 0; // star entirely hidden — total
  const r = bOcc / Math.max(aStar, 1e-12);
  // Annular: occluder's disc entirely inside the star's ⇒ area ratio.
  if (cSep <= aStar - bOcc) return Math.max(0, 1 - r * r);
  const x =
    (0.5 / Math.max(cSep, 1e-12)) *
    (cSep * cSep + aStar * aStar - bOcc * bOcc);
  const thL = Math.acos(Math.min(1, Math.max(-1, x / Math.max(aStar, 1e-12))));
  const thO = Math.acos(
    Math.min(1, Math.max(-1, (cSep - x) / Math.max(bOcc, 1e-12))),
  );
  const v =
    (1 / Math.PI) *
    (Math.PI -
      thL +
      0.5 * Math.sin(2 * thL) -
      thO * r * r +
      0.5 * r * r * Math.sin(2 * thO));
  return Math.min(1, Math.max(0, v));
}

/**
 * Per-pixel fraction of the star's disc visible at this surface point, after
 * every occluder in `u`. Multiply any sun-driven term by this.
 *
 * ⚠ The surface point is taken as `normalize(positionLocal) · bodyRadiusKm`,
 * i.e. the body is treated as a sphere. Displacement and normal mapping are
 * metres against a shadow geometry that varies over thousands of km, so this
 * is exact to far better than a pixel.
 */
export function eclipseVisibilityNode(u: EclipseUniforms): U {
  return Fn(() => {
    const surf = normalize(positionLocal).mul(u.bodyRadiusKm);
    const toStar = vec3(u.starRelKm).sub(surf).toVar();
    const distStar = length(toStar).max(1e-6);
    const angStar = asin(clamp(u.starRadiusKm.div(distStar), 0, 1)).toVar();
    const starDir = toStar.div(distStar).toVar();
    const vis = float(1.0).toVar();
    for (let i = 0; i < MAX_ECLIPSE_OCCLUDERS; i++) {
      const o = vec4(u.occ[i]);
      const toOcc = o.xyz.sub(surf).toVar();
      const distOcc = length(toOcc).max(1e-6);
      const angOcc = asin(clamp(o.w.div(distOcc), 0, 1));
      const angSep = acos(clamp(dot(starDir, toOcc.div(distOcc)), -1, 1));
      // `o.w = 0` ⇒ angOcc = 0 ⇒ this returns exactly 1.0. Branchless.
      vis.mulAssign(eclipseCoveredFraction(angSep, angStar, angOcc));
    }
    return vis;
  })();
}
