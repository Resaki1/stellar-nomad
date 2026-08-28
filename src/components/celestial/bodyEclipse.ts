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
  modelWorldMatrix,
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
// ⚠⚠ **fp32 PRECISION HERE IS LOAD-BEARING AND WAS THE CAUSE OF A VISIBLE
// ARTEFACT** — sheared parallelogram tiles across Earth's eclipse shadow.
// Confirmed by A/B on the flag below. TWO compounding faults:
//
//   1. THE SHAPE. `starRelKm − surf` cancels: the ULP of 1.496e8 is **16 km**, so
//      `starDir` is bit-identical across 16 km cells that are AXIS-ALIGNED IN THE
//      ECLIPTIC FRAME. That is why the tiles were sheared parallelograms and not
//      rings around the shadow axis.
//   2. THE AMPLITUDE. `acos(dot(a, b))` with the directions ~0.005 rad apart:
//      dθ/d(dot) = −1/sin θ = **200×**, so each lattice crossing became a
//      **0.128% hard STEP** in coverage — 0.64% relative at coverage 0.2 and
//      **2.56% at 0.05**, then amplified again by exposure adaptation.
//
// 🔑🔑 **THE LESSON: the error's MAGNITUDE (0.020% mean) said "invisible" and was
// the wrong question. Its STRUCTURE — a spatially coherent step on a world-aligned
// lattice — is what the eye sees. When an artefact has geometric structure, ask
// what is quantised and on what lattice.**
//
// ⚠ The cancellation in (1) is still present. The chord form below makes its
// consequence 4000× smaller, which is why it stopped mattering — not because it
// went away. If a future body sits far closer to or further from its star, or the
// scene unit changes, re-measure before assuming it is still harmless.
const ECLIPSE_STABLE_ANGLE = true;

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
 * ⚠ The body is treated as a SPHERE: the surface point is the radial direction
 * times `bodyRadiusKm`. Displacement and normal mapping are metres against a
 * shadow geometry that varies over thousands of km, so this is exact to far
 * better than a pixel.
 *
 * ⚠⚠ **THE RADIAL DIRECTION MUST BE TAKEN IN WORLD SPACE, NOT OBJECT SPACE.**
 * This read `normalize(positionLocal)` — the OBJECT-space direction — while
 * `starRelKm` and every occluder slot are WORLD-space (ecliptic) km. The two
 * differ by the body's entire orientation, so the shadow was painted on the
 * wrong side of the planet by up to 180°.
 *
 * 🔑 It was INVISIBLE AS A BUG because it still drew a plausible-looking shadow,
 * just in the wrong place: with Earth's old static `Euler(0, 0.15π, 0.8π)` the
 * displaced shadow happened to land on the sunlit side, and the 2024-04-08 test
 * showed it over the Sahara — which was read as an ORBITAL error and was
 * genuinely one too (see `sim/ephemeris.ts`). Fixing the orientation moved the
 * displaced shadow onto the night side and the shadow "disappeared", which is
 * what finally exposed it. **MEASURED at the same moment: `__lum.eclipses()`
 * reported Earth's centre visibility at 0.3101 — the CPU path, which is
 * world-space throughout, was right the whole time.**
 *
 * ⚠ `modelWorldMatrix.mul(vec4(positionLocal, 0))` and not `normalWorld`: the
 * `w = 0` makes it a pure direction transform (no translation to cancel), and
 * unlike a normal it stays correct for a mesh whose normals are not radial —
 * a ring, or the cloud shell — as long as its local origin is the body centre.
 *
 * 🔑 D28c and D34's own note both say "keep one frame". They meant the
 * TRANSLATION, which was unified (occluder slots are body-relative km). The
 * ROTATION was never checked. **"Same frame" is two questions, not one.**
 */
export function eclipseVisibilityNode(u: EclipseUniforms): U {
  return eclipseVisibilityAtNode(
    u,
    normalize(modelWorldMatrix.mul(vec4(positionLocal, 0)).xyz).mul(u.bodyRadiusKm),
  );
}

/**
 * The same question — *what fraction of the star's disc is visible?* — asked at
 * an ARBITRARY point rather than on the body's surface.
 *
 * `posKm` must be **body-centric km on world (ecliptic) axes**, which is exactly
 * the frame `u.occ` and `u.starRelKm` live in, and exactly the frame
 * `atmospherePass.ts` marches in (its `cloudShadowAtPlanetKm` applies `invModel`
 * to leave it, which is the proof).
 *
 * 🔑 Split out rather than reimplemented for the atmosphere pass, because the
 * one thing D34 already got bitten by is this maths existing twice — the CPU
 * `discCoveredFraction` and the old hardcoded `eclipseFn` had diverged, and the
 * port silently lost the annular branch. One implementation, two callers.
 */
export function eclipseVisibilityAtNode(u: EclipseUniforms, posKm: U): U {
  return Fn(() => {
    const p = vec3(posKm).toVar();
    const toStar = vec3(u.starRelKm).sub(p).toVar();
    const distStar = length(toStar).max(1e-6);
    const angStar = asin(clamp(u.starRadiusKm.div(distStar), 0, 1)).toVar();
    const starDir = toStar.div(distStar).toVar();
    const vis = float(1.0).toVar();
    for (let i = 0; i < MAX_ECLIPSE_OCCLUDERS; i++) {
      const o = vec4(u.occ[i]);
      const toOcc = o.xyz.sub(p).toVar();
      const distOcc = length(toOcc).max(1e-6);
      const angOcc = asin(clamp(o.w.div(distOcc), 0, 1));
      // ⚠⚠ NOT `acos(dot(a, b))`. These two directions are ~0.005 rad apart, deep
      // in the regime where acos is catastrophically ill-conditioned: `dot` lands
      // at 1 − 1.25e-5, fp32's ULP near 1.0 is 6e-8, and dθ/d(dot) = −1/sin θ =
      // −200, so the rounding is amplified 200×.
      // **MEASURED in float32 against a float64 reference, over a scan across the
      // penumbra: median error 1.85e-6 rad = 0.020% of the coverage ramp for the
      // acos form, 4.5e-10 rad for the chord form below — a 4131× improvement.**
      // The chord form `2·asin(|a − b| / 2)` is exact in the small-angle limit
      // because the subtraction of two nearly-equal unit vectors is where the
      // information actually lives.
      // ⚠ It is NOT the cause of the visible tiling (0.02% cannot be seen); it is
      // the fine grain that showed up under `TERM_DEBUG`'s 60× gain. Fixed here
      // because a 200× error amplifier in the middle of an analytic function is
      // wrong on its own terms, not because it closes that defect.
      // ⚠ Build const so the two forms can be A/B'd in one reload — see the
      // ATTRIBUTION note at the top of this file.
      const angSep = ECLIPSE_STABLE_ANGLE
        ? asin(clamp(length(starDir.sub(toOcc.div(distOcc))).div(2), 0, 1)).mul(2)
        : acos(clamp(dot(starDir, toOcc.div(distOcc)), -1, 1));
      // `o.w = 0` ⇒ angOcc = 0 ⇒ this returns exactly 1.0. Branchless.
      vis.mulAssign(eclipseCoveredFraction(angSep, angStar, angOcc));
    }
    return vis;
  })();
}
