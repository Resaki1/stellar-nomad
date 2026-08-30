/**
 * PLANETSHINE — a body's night side lit by its neighbours (Phase 9 step 2).
 *
 * Earthshine on the Moon, moonlight on Earth, Jupiter blazing over Io's night
 * side. Computed with this module's own formula and the repo's own geometric
 * albedos, against the sky-light floor P9a established (3.28e-4 lux — ⚠ the
 * CORRECTED figure; an earlier draft of this table used a 0.002 lux floor that
 * was 2.3× too high and included unmodelled airglow, so its ratios were ~7× low):
 *
 *   emitter → receiver     irradiance   × sky floor   receiver night L   EV100
 *   Charon  → Pluto         0.030 lux          91×                       −19.6 ✗
 *   Moon    → Earth         0.355 lux       1,084×    7.4e-2 cd/m²        −14.1 ✅
 *   Saturn  → Titan         1.61  lux       4,901×    1.7e-1              −12.9 ✅
 *   Earth   → Luna         15.3   lux      46,524×    9.9e-1              −10.4 ✅
 *   Jupiter → Io           70.0   lux     213,401×    2.1e+1              −6.0  ✅
 *
 * 🔑🔑 THE `EV100` COLUMN IS THE POINT. Auto-exposure floors at `EV_MIN = -18`, so
 * a row at or above −18 renders visibly and a row below it does not. The
 * starlight-only floor needs **−25.2** — 7.2 stops below the clamp — which is why
 * a moonless night side is black however correct its photometry. Every
 * planetshine case above except Charon→Pluto has stops of headroom, so **this
 * term needs no exposure work at all**; it was always the missing light, never a
 * tone-mapping problem.
 *
 * ── 🔑🔑 THIS IS THE ECLIPSE PROBLEM INVERTED, AND THAT IS THE WHOLE DESIGN ───
 * `bodyEclipse.ts` asks *"what fraction of the star's disc does this body
 * block?"*. This asks *"what irradiance does that disc deliver?"*. Same inputs —
 * a centre and a radius per nearby body — and `sunOcclusion.ts`'s registry
 * already holds both for every body, unconditionally, every frame. So this is a
 * SECOND CONSUMER of machinery that exists, not a new subsystem:
 *
 *   • same 4-slot uniform array, same branchless encoding (radiance 0 = unused),
 *   • same body-relative-km frame (origin AND axes — see the D34g note below),
 *   • same per-pixel-node / CPU-scalar split for the near/mid vs far LOD tiers.
 *
 * ⇒ **Free for procedurally generated systems, and for Titan/Pluto/Charon or any
 * other body the moment it is added.** Nothing here is per-body data: the
 * geometry comes from the registry, the albedo from `bodyReflectanceRgb` (which
 * D09e derives from measured band spectra), the star's illuminance from the live
 * body→star distance. There is no table to extend.
 *
 * ── The photometry, and why the π cancels ────────────────────────────────────
 * A Lambert sphere's mean radiance over its apparent disc at phase angle g is
 *
 *     L_mean = p · E_sun(B) / π · Φ(g)
 *
 * with p the GEOMETRIC albedo — which is convenient, because p is *defined* at
 * zero phase and is exactly what `bodyPhotometry` stores. (Derivation: a Lambert
 * sphere's zero-phase intensity is (2/3)·A·E·R², the apparent disc area is πR²,
 * and p = (2/3)A, so L_mean = p·E/π.) Irradiance at a receiving point is then
 *
 *     E_recv = L_mean · Ω · max(0, n·d),   Ω = π·(R_B/dist)²
 *            = p · E_sun(B) · Φ(g) · (R_B/dist)² · max(0, n·d)
 *
 * so the π in the solid angle cancels the π in the radiance. ✅ VALIDATED two
 * ways: `Φ(90°) = 0.3183 = 1/π` and `Φ(180°) = 0` exactly, and full Moon → Earth
 * gives **0.355 lux against a measured 0.25 — 1.42× high**. ⚠ That overshoot is
 * real and expected: the Moon has a strong opposition surge and is the most
 * non-Lambertian body in the system, so a Lambert model cannot reproduce 0.25.
 * Every other pair here is closer to Lambertian than the Moon is. Do NOT "fix" it
 * by trimming the albedo — that would break the day side, which is calibrated.
 *
 * ⚠ Φ(g) = (sin g + (π − g)·cos g)/π is the Lambert-sphere phase function:
 * 1 at full, 1/π at quadrature, 0 at new. It is evaluated ON THE CPU because
 * |P| ≤ R_receiver ≪ dist, so it is constant across the receiving body's surface
 * to far better than a pixel — which also keeps the per-slot shader cost to a
 * dot product and a divide.
 *
 * ⚠ NOT MODELLED: the emitter being itself eclipsed (second order — it would
 * dim earthshine during a lunar eclipse, which is D28's coppery term anyway);
 * mutual shadowing of the receiver by the emitter (the receiver's own `n·d`
 * horizon covers the first-order case); and interreflection.
 */

import * as THREE from "three";
import { float, uniform, vec3, vec4 } from "three/tsl";

import { starVisibilityAt, sunOccluderList } from "@/components/space/sunOcclusion";
import { NITS_PER_GAME_UNIT, sunIlluminanceAt } from "@/components/space/photometry";
import { bodyReflectanceRgb } from "./bodyColour";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type U = any;

/**
 * Emitter slots per receiving body.
 *
 * 4 for the same reason `MAX_ECLIPSE_OCCLUDERS` is 4: the slots are unrolled
 * branchlessly, and in a real system the irradiance ranking falls off a cliff
 * after the nearest one or two (Jupiter delivers 35,000× the sky floor to Io;
 * the next-brightest contributor to Io is Europa at a rounding error). 4 leaves
 * room for a tightly packed moon system without paying for a loop.
 */
export const MAX_SHINE_EMITTERS = 4;

export type ShineUniforms = {
  /** xyz = emitter centre RELATIVE TO THIS BODY (km), w = emitter radius (km). */
  posRadius: U[];
  /**
   * `p_rgb · E_sun(emitter) · Φ(g)`, PRE-EXPOSED. Zero for an unused slot, which
   * makes the whole slot contribute exactly 0 with no branch.
   */
  radiance: U[];
};

export function createShineUniforms(): ShineUniforms {
  return {
    posRadius: Array.from({ length: MAX_SHINE_EMITTERS }, () =>
      uniform(new THREE.Vector4(0, 0, 0, 0)),
    ),
    radiance: Array.from({ length: MAX_SHINE_EMITTERS }, () =>
      uniform(new THREE.Vector3(0, 0, 0)),
    ),
  };
}

/** Lambert-sphere phase function. 1 at full phase, 1/π at quadrature, 0 at new. */
export function lambertSpherePhase(gRad: number): number {
  const g = Math.min(Math.PI, Math.max(0, gRad));
  return (Math.sin(g) + (Math.PI - g) * Math.cos(g)) / Math.PI;
}

type Candidate = {
  id: string;
  /** Φ(g) already folded into r/g/b — kept so the cap integral can replace it. */
  phase: number;
  cosPhase: number;
  dx: number; dy: number; dz: number;
  radiusKm: number;
  r: number; g: number; b: number;
  estimate: number;
};

const _cands: Candidate[] = [];

/**
 * Fill `u` with the brightest emitters for `bodyId` this frame.
 *
 * Returns the irradiance the strongest emitter delivers at the sub-emitter point
 * (game units), for the far-tier scalar and for diagnostics.
 *
 * ⚠⚠ FRAME: every position here is body-relative km on WORLD (ecliptic) axes,
 * which is what `sunOccluderList()` stores and what the shader's
 * `modelWorldMatrix · vec4(positionLocal, 0)` produces. **Both halves of "same
 * frame" — same origin AND same axes.** Getting only the origin right is what
 * painted the eclipse shadow 180° out of place (D34g); this is the same trap in
 * the same shape, so it is spelled out rather than assumed.
 *
 * ⚠ `preExposure` is folded in HERE, at the source, exactly as
 * `updateSkyShUniforms` and `uSunIlluminance` do it. A term that skipped it
 * would be wrong by the exposure factor — 10⁴–10⁶× in a dark scene, which is the
 * D09c/D28 trap and precisely the scene this term exists for.
 */
export function updateShineUniforms(
  u: ShineUniforms,
  bodyId: string,
  bodyCenterKm: readonly [number, number, number],
  starPosKm: readonly [number, number, number],
  starLuminositySun: number,
  preExposure: number,
  starRadiusKm: number,
): number {
  updateShineCandidates(
    bodyId,
    bodyCenterKm,
    starPosKm,
    starLuminositySun,
    preExposure,
    null,
    starRadiusKm,
  );

  for (let i = 0; i < MAX_SHINE_EMITTERS; i++) {
    const c = _cands[i];
    if (c) {
      u.posRadius[i].value.set(c.dx, c.dy, c.dz, c.radiusKm);
      u.radiance[i].value.set(c.r, c.g, c.b);
    } else {
      u.posRadius[i].value.set(0, 0, 0, 0);
      u.radiance[i].value.set(0, 0, 0);
    }
  }
  // Pre-exposure divided back out is NOT done here: callers wanting absolute
  // units should recompute, exactly as `rec.sunIlluminance` requires (D09c).
  return _cands.length > 0 ? _cands[0].estimate : 0;
}

/**
 * The shared ranking pass: every emitter's contribution at `centerKm`, sorted
 * brightest-first into `_cands`. One implementation for the body surfaces and the
 * ship, because two copies of this arithmetic is how D34 lost its annular branch.
 */
function updateShineCandidates(
  bodyId: string,
  bodyCenterKm: readonly [number, number, number],
  starPosKm: readonly [number, number, number],
  starLuminositySun: number,
  preExposure: number,
  skipId: string | null,
  starRadiusKm: number,
): void {
  _cands.length = 0;

  for (const emitter of sunOccluderList()) {
    if (emitter.id === bodyId || emitter.id === skipId) continue;
    // Emitter centre relative to the receiving body.
    const dx = emitter.centerKm.x - bodyCenterKm[0];
    const dy = emitter.centerKm.y - bodyCenterKm[1];
    const dz = emitter.centerKm.z - bodyCenterKm[2];
    const dist = Math.hypot(dx, dy, dz);
    if (dist <= 0) continue;

    // Per-channel geometric albedo (D09e: derived from measured band spectra, so
    // Io comes out sulphur-yellow and Neptune blue without a hand-tuned tint).
    const refl = bodyReflectanceRgb(emitter.id);
    if (!refl) continue;

    // Solar illuminance AT THE EMITTER, from its live star distance — so this
    // stays correct under orbital motion and in a generated system.
    const eStarX = emitter.centerKm.x - starPosKm[0];
    const eStarY = emitter.centerKm.y - starPosKm[1];
    const eStarZ = emitter.centerKm.z - starPosKm[2];
    const emitterStarDistKm = Math.hypot(eStarX, eStarY, eStarZ);
    if (emitterStarDistKm <= 0) continue;
    const eSun = sunIlluminanceAt(emitterStarDistKm, starLuminositySun);

    // Phase angle AT THE EMITTER, between the star and the receiving body.
    const invE = 1 / emitterStarDistKm;
    const invD = 1 / dist;
    // Directions from the emitter: toward the star, and toward the receiver.
    const cosG =
      (-eStarX * invE) * (-dx * invD) +
      (-eStarY * invE) * (-dy * invD) +
      (-eStarZ * invE) * (-dz * invD);
    const phase = lambertSpherePhase(Math.acos(Math.min(1, Math.max(-1, cosG))));

    // ── Is the EMITTER itself in shadow? ─────────────────────────────────────
    // 🐛 Found on device: a ship inside Jupiter's shadow, beside a Europa that was
    // ALSO inside it, was told Europa delivered **17.08 lux** — from a moon
    // rendering completely black. An emitter reflects only the sunlight it
    // receives, and this one was receiving none.
    // 🔑 The check already existed as `sunVisibility()`; it just had never been
    // asked about anything other than the ship. Same disc-overlap maths as the
    // eclipse, via the side-effect-free `starVisibilityAt` — ⚠ NOT `sunVisibility`,
    // which records into the module state `__lum.sun()` reads back as "what is
    // shadowing the ship", and would report whichever emitter was queried last.
    // ⚠ Evaluated at the emitter's CENTRE, the same simplification the far LOD
    // tier makes: exact for a body wholly inside or outside an umbra, and a
    // one-frame-soft edge for a body straddling the penumbra.
    const emitterLit = starVisibilityAt(
      emitter.centerKm,
      starPosKm,
      starRadiusKm,
      emitter.id,
    );
    if (emitterLit <= 0) continue;

    // What the shader will multiply by (R/dist)² · cos θ.
    const scale = eSun * phase * preExposure * emitterLit;
    // Ranking metric: the irradiance at the sub-emitter point, luminance-ish.
    const solid = (emitter.radiusKm * emitter.radiusKm) / (dist * dist);
    const lum = 0.2126 * refl.r + 0.7152 * refl.g + 0.0722 * refl.b;
    _cands.push({
      id: emitter.id,
      phase,
      cosPhase: Math.min(1, Math.max(-1, cosG)),
      dx, dy, dz,
      radiusKm: emitter.radiusKm,
      r: refl.r * scale,
      g: refl.g * scale,
      b: refl.b * scale,
      estimate: lum * scale * solid,
    });
  }

  // Brightest first — with 4 slots and ~13 bodies, the ranking is what makes
  // "pick the emitters that matter" work with no per-body configuration.
  _cands.sort((a, b) => b.estimate - a.estimate);
}

/**
 * Irradiance from every emitter at a surface point, game units, pre-exposed.
 *
 * `surfDirWorld` must be the OUTWARD unit normal in world (ecliptic) axes and
 * `bodyRadiusKm` the receiving body's radius — together they place the shading
 * point, which matters because a moon can be closer than a few body radii.
 */
export function shineIrradianceNode(
  u: ShineUniforms,
  surfDirWorld: U,
  bodyRadiusKm: U,
): U {
  const n = vec3(surfDirWorld);
  const surf = n.mul(bodyRadiusKm);
  let sum: U = vec3(0);
  for (let i = 0; i < MAX_SHINE_EMITTERS; i++) {
    const pr = vec4(u.posRadius[i]);
    const toE = pr.xyz.sub(surf);
    // `.max(1)` guards a zero slot (and any degenerate coincident centre) from
    // producing a divide by zero; the slot still contributes 0 because its
    // radiance is 0, so this stays branchless.
    const d2 = toE.dot(toE).max(1);
    const cosT = n.dot(toE.div(d2.sqrt())).max(0);
    // (R/d)² · cos θ — the solid angle's π already cancelled into the radiance.
    sum = sum.add(
      vec3(u.radiance[i]).mul(pr.w.mul(pr.w).div(d2)).mul(cosT),
    );
  }
  return sum;
}

/**
 * The direction-AVERAGED planetshine irradiance, for the far/point LOD tiers.
 *
 * ⚠ `× 1/4`, and that factor is exact rather than a fudge: the mean of
 * `max(0, cos θ)` over a whole sphere is 1/4, so this matches what the SH band-0
 * term does for the sky. Used for the same reason the eclipse uses a centre
 * scalar there — `normalWorld` on a billboard is the QUAD's normal.
 */
export function shineIrradianceAverageNode(u: ShineUniforms): U {
  let sum: U = vec3(0);
  for (let i = 0; i < MAX_SHINE_EMITTERS; i++) {
    const pr = vec4(u.posRadius[i]);
    const d2 = pr.xyz.dot(pr.xyz).max(1);
    sum = sum.add(vec3(u.radiance[i]).mul(pr.w.mul(pr.w).div(d2)));
  }
  return sum.mul(float(0.25));
}

// ─────────────────────────────────────────────────────────────────────────
// The SHIP
// ─────────────────────────────────────────────────────────────────────────

/** One emitter's contribution at a point: unit direction toward it + irradiance. */
export type ShineLight = {
  /** Which body is doing the lighting — so a gate can name it. */
  id: string;
  /** Distance to that body, km. */
  distKm: number;
  dirX: number; dirY: number; dirZ: number;
  /** Irradiance on a surface facing the emitter, game units. ABSOLUTE (not pre-exposed). */
  r: number; g: number; b: number;
};

/**
 * Planetshine at an arbitrary point — for the ship.
 *
 * 🔑 Physically the same term the body surfaces get, and a real one: Apollo
 * photographed the CSM lit by earthshine, and a ship off Io sits in 60 lux of
 * reflected Jupiter (EV100 −6, brighter than a moonlit landscape on Earth).
 * Returns emitters brightest-first; the caller takes as many as it has lights.
 *
 * ⚠⚠ `skipId` EXISTS TO PREVENT A DOUBLE COUNT, and it is the same ownership rule
 * `SunLight` already applies to `sunVisibility()`: **whichever body's atmosphere
 * is currently driving `AtmosphereSkyLight` already delivers its ground-bounce to
 * the ship**, as the "ground" half of that hemisphere light. Adding this on top
 * would count the same photons twice, and worst exactly where it is largest — low
 * over a day side. One owner per body.
 *
 * ⚠ The `(R/d)²·cosθ` form factor is EXACT for a Lambertian sphere fully above
 * the receiver's horizon at ANY distance (Howell B-71), so closeness alone does
 * not break it. What DOES degrade close in is the disc-mean radiance: Φ(g) is
 * evaluated at the emitter's centre, and within a few radii the phase angle
 * varies across the visible cap. That is precisely the regime `AtmosphereSkyLight`
 * owns for an atmosphere body — and for an airless one (Luna, Io) it is a real
 * remaining approximation, so a ship 50 km over Luna's terminator gets a
 * disc-averaged answer rather than a local one.
 */
export function shineLightsAt(
  posKm: readonly [number, number, number],
  starPosKm: readonly [number, number, number],
  starLuminositySun: number,
  skipId: string | null,
  out: ShineLight[],
  starRadiusKm: number,
): number {
  // Reuse the ranking pass; `bodyId` "" matches nothing, so nothing self-excludes.
  updateShineCandidates("", posKm, starPosKm, starLuminositySun, 1, skipId, starRadiusKm);
  const n = Math.min(out.length, _cands.length);
  for (let i = 0; i < n; i++) {
    const c = _cands[i];
    const dist = Math.hypot(c.dx, c.dy, c.dz) || 1;
    const inv = 1 / dist;
    const o = out[i];
    o.id = c.id;
    o.distKm = dist;
    o.dirX = c.dx * inv; o.dirY = c.dy * inv; o.dirZ = c.dz * inv;
    // ⚠ `c.r/g/b` carry `p_rgb · E_sun · Φ(g)`; the cap integral supplies its own
    // illumination factor, so divide Φ back out and multiply the correct one in.
    const k = c.phase > 1e-9 ? visibleCapFactor(c.radiusKm, dist, c.cosPhase) / c.phase : 0;
    o.r = c.r * k; o.g = c.g * k; o.b = c.b * k;
  }
  return n;
}

/**
 * Illumination factor for a Lambertian sphere, integrated over the part of it the
 * RECEIVER CAN ACTUALLY SEE. Replaces `Φ(g)·(R/d)²` for a close receiver.
 *
 * 🐛🐛 WHY THIS EXISTS — MEASURED ON DEVICE. `Φ(g)` is the whole-DISC average, but
 * a close receiver sees only a cap of half-angle `acos(R/d)` around the sub-receiver
 * point. A ship 425 km over Luna's dark side (d/R = 1.24) sees only within **37°**
 * of the sub-ship point — surface that is 123°–180° from the sub-solar point, i.e.
 * **entirely unlit**. The disc-mean nonetheless reported **57.57 lux of reflected
 * SUNLIGHT from a cap with no sunlight on it**, which *exceeded* the 17.56 lux of
 * genuine earthshine and lit the hull from the wrong direction. Io's night side
 * had the same fault (9.28 lux from a fully dark cap).
 * 🔑 **A disc-average is only meaningful to an observer who can see the whole disc.**
 *
 * The derivation, and the reason it is cheap: parameterising by the apparent disc
 * radius `t` makes the `cos β` of the receiver's own projection cancel against the
 * solid-angle measure, leaving
 *
 *     E = 1.5 · p · E_sun · sin²α · ⟨(x̂·ŝ)⁺⟩,   sin α = R/d
 *
 * with the mean taken over the disc sampled UNIFORMLY IN AREA and
 * `γ(t) = asin(t) − asin(t·sinα)` the angle at the emitter's centre. This returns
 * `sin²α · ⟨(x̂·ŝ)⁺⟩` — the `1.5·p·E_sun` is already in the caller's radiance.
 *
 * ✅ VALIDATED: reduces to the analytic `Φ(g)·(R/d)²` far away (ratio 1.003 at the
 * Moon's distance), and returns **exactly 0** for both observed close dark-side
 * cases. ⚠ The residual 2.7% at d = 50,000 km is NOT quadrature error — it is the
 * real finite-distance correction, `+sinα/2`; the analytic form is the α→0 limit,
 * so this is the more accurate of the two.
 *
 * ⚠ Returns exactly 0 over an unlit cap, which is right for FIRST-ORDER light. The
 * ~1.5 lux a ship over Luna's dark side really gets is earthshine re-reflected by
 * Luna — interreflection, still not modelled.
 */
const CAP_RADIAL = 8;
const CAP_AZIMUTH = 12;
function visibleCapFactor(radiusKm: number, distKm: number, cosPhase: number): number {
  const sinA = Math.min(1, radiusKm / distKm);
  const sinG = Math.sqrt(Math.max(0, 1 - cosPhase * cosPhase));
  let acc = 0;
  for (let i = 0; i < CAP_RADIAL; i++) {
    const t = Math.sqrt((i + 0.5) / CAP_RADIAL); // uniform in disc AREA
    const gam = Math.asin(Math.min(1, t)) - Math.asin(Math.min(1, t * sinA));
    const cg = Math.cos(gam);
    const sg = Math.sin(gam);
    for (let j = 0; j < CAP_AZIMUTH; j++) {
      const phi = (2 * Math.PI * (j + 0.5)) / CAP_AZIMUTH;
      acc += Math.max(0, cg * cosPhase + sg * Math.cos(phi) * sinG);
    }
  }
  return sinA * sinA * (acc / (CAP_RADIAL * CAP_AZIMUTH));
}

/**
 * Live snapshot of the HULL's planetshine rig, for `__lum.hull()`.
 *
 * 🔑 Exists because "the light looks like it comes from Io, not Jupiter" is not
 * answerable by looking at the frame — two emitters a few degrees apart light a
 * hull almost identically, and the one that is WRONG is the one that got
 * silently skipped. A gate that NAMES the emitter and prints the skip makes that
 * decidable in one command.
 */
export type HullShineStatus = {
  lights: { id: string; distKm: number; lux: number; dir: [number, number, number] }[];
  /** The body excluded because `AtmosphereSkyLight` is delivering its bounce. */
  skippedId: string | null;
  preExposure: number;
};

let _hullShine: HullShineStatus = { lights: [], skippedId: null, preExposure: 1 };

export function publishHullShine(
  lights: readonly ShineLight[],
  count: number,
  skippedId: string | null,
  preExposure: number,
): void {
  const out: HullShineStatus["lights"] = [];
  for (let i = 0; i < count; i++) {
    const l = lights[i];
    // ⚠ ABSOLUTE units: `shineLightsAt` is called with preExposure 1, so these
    // are game units and a gate must not divide anything back out (D09c).
    const lum = 0.2126 * l.r + 0.7152 * l.g + 0.0722 * l.b;
    out.push({
      id: l.id,
      distKm: l.distKm,
      lux: lum * NITS_PER_GAME_UNIT,
      dir: [l.dirX, l.dirY, l.dirZ],
    });
  }
  _hullShine = { lights: out, skippedId, preExposure };
}

export const hullShineStatus = (): HullShineStatus => _hullShine;
