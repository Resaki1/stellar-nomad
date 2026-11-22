"use client";

import { memo, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { NodeMaterial, type Node } from "three/webgpu";
import {
  Fn,
  If,
  int,
  Loop,
  clamp as tslClamp,
  cameraPosition,
  cos,
  dot,
  exp,
  float,
  max,
  min,
  modelWorldMatrixInverse,
  normalize,
  positionLocal,
  sin,
  sqrt,
  tan,
  atan,
  uniform,
  vec3,
  vec4,
} from "three/tsl";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { ambientAt, createAmbient } from "@/sim/atmosphere";
import { createDrivePlume, drivePlume } from "@/sim/ship/atmoDrive";
import { DEFAULT_RESOURCE_TUNING } from "@/sim/ship/resourceTuning";
import { getPreExposure } from "@/components/space/photometry";

// ── Types ────────────────────────────────────────────────────────────
export type ExhaustConfig = {
  /** Position in the local space of the exhaust parent */
  position: [number, number, number];
  /** Nozzle radius in model-local units */
  radius: number;
};

type Props = {
  /** One entry per engine nozzle */
  configs: ExhaustConfig[];
  /**
   * Ref updated every frame by the parent (Spaceship) with the current
   * thrust intensity in [0, 1]. 0 = no thrust, 1 = full thrust.
   */
  intensityRef: React.RefObject<number>;
  /**
   * Nozzle glow lights (default true). Remote pilots pass false: a light added to the scene
   * changes the lights hash, so EVERY lit material recompiles (see the toggle note below) when
   * a session starts, and each costs every lit fragment for the session. Their plume still draws.
   */
  castLight?: boolean;
};

// ── Tuning ───────────────────────────────────────────────────────────
/**
 * Reference length of the vacuum plume's side profile, m — the old cone's length, kept
 * because `plumeLightIntensity`'s derivation is anchored on it.
 */
const PLUME_MAX_LENGTH = 4.0;
/**
 * Plume peak radiance in game units at full thrust.
 *
 * 12 game units = **72,456 cd/m²** (LIGHTING_PLAN §3.1: 1 unit = 6,038 cd/m²), which
 * is a defensible plasma-plume luminance — a sunlit cloud top is ~20,000 and an arc
 * lamp ~1e8. ⚠ So contrary to D26's original framing this is NOT badly calibrated.
 *
 * 🔑 MEASURED, and this is D26's real finding: the plume still drags metered EV from
 * −14.74 to −10.3 (**4.4 stops**) in deep space, occupying 2% of frame weight while
 * carrying ~100% of frame flux, with the hot-tail compressor already holding back
 * ~5.5 stops. That is not a units error — deep space is ~1e-4 cd/m², so a physically
 * correct plume IS ~7e8× the sky and a real eye WOULD be blinded by it. Which is why
 * real spacecraft do not put the nozzle in the pilot's field of view, and we do.
 *
 * ⇒ The remaining fix is therefore a METERING POLICY, not a value here. Do not
 * "solve" it by lowering this number: that trades a correct plume for a wrong one and
 * silently corrupts every consumer that now reads absolute luminance — S4b's
 * reflection cube, the SH probe, and Phase 8's energy-conserving glare.
 */
const PLUME_HDR = 12.0;
/**
 * Luminous intensity of a nozzle's glow light at full thrust — the light the
 * plume CASTS, as distinct from the radiance it EMITS.
 *
 * ✅ NOW DERIVED (LIGHTING_PLAN D26 step 1). It was `2.0`, flagged in this file
 * as "still an uncalibrated eyeball value… not derived from PLUME_HDR × the
 * plume's solid angle, so the plume and its illumination can disagree."
 *
 * `E = L · Ω`, and a `decay = 2` point light in three.js produces `E = I / d²`,
 * so `I = L · Ω · d²`. The plume presents its side profile to a hull point: a
 * triangle of base `2r` and height `PLUME_MAX_LENGTH`, i.e. projected area
 * `r · PLUME_MAX_LENGTH`, and `Ω ≈ area / d²`. The `d²` cancels:
 *
 *     I = PLUME_HDR · r · PLUME_MAX_LENGTH
 *
 * 🔑 Note what the cancellation means: the hull's distance from the nozzle drops
 * out entirely, so this needs no reference distance and no per-ship tuning. That
 * is the inverse-square law and the solid-angle law being the same law.
 *
 * 🔑 THE DERIVATION LANDED ON THE AUTHORED VALUE. At the nominal r = 0.3 this
 * gives **14.4** game units, against an effective authored value of **13.6** —
 * agreement to 6%, which is a genuine independent check rather than a fit,
 * because the authored side had to be computed through the hidden multiplier
 * below to even be comparable. Nobody had noticed it was already right.
 *
 * ⚠ Order-unity uncertainty: Ω is a flat-triangle stand-in for a cone seen from
 * a point beside it, and the true hull distance varies over the hull. Read this
 * as "±2×, and the shape of the answer is right", not as three digits.
 *
 * ⚠ Per-nozzle, because Ω scales with the nozzle radius — a bigger engine both
 * emits over a larger area and lights the hull more. That is the property that
 * makes this survive a ship refit, which a constant could not.
 */
function plumeLightIntensity(nozzleRadius: number): number {
  return PLUME_HDR * nozzleRadius * PLUME_MAX_LENGTH;
}
/** Point-light distance (model-local) */
const LIGHT_DISTANCE = 6.0;

// ── Reusable color for light ─────────────────────────────────────────
/**
 * ⚠⚠ WAS `new THREE.Color(5.0, 7.0, 10.0)` — A HIDDEN 6.79× MULTIPLIER.
 * three.js computes a light's contribution as `color × intensity`, so a colour
 * whose channels exceed 1 is an undeclared second intensity: the Rec709
 * luminance of (5, 7, 10) is **6.79**, which made the real intensity
 * `2.0 × 6.79 = 13.6` while the constant next to it said 2.0.
 *
 * 🔑 The same defect class as `STAR_COLOR_LINEAR`'s note and D09d's per-channel
 * clamp: a colour that is not luminance-normalised silently rescales whatever it
 * multiplies, and the number you can see stops meaning anything. Normalised to
 * luminance 1 so the hue is hue and the intensity is intensity — and the 6.79 is
 * now visible inside `plumeLightIntensity`'s derived value instead of hiding here.
 *
 * ⚠ NOT a visual change: 6.79 × 2.0 = 13.6 against the derived 14.4 (+6%).
 */
const LIGHT_COLOR = (() => {
  const c = new THREE.Color(5.0, 7.0, 10.0);
  const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return c.multiplyScalar(1 / lum);
})();
const LIGHT_COLOR_HALF = LIGHT_COLOR.clone().multiplyScalar(0.5);

// ── Plume volume (VFX_REALISM_PLAN §5.3–5.6.7) ───────────────────────
//
// A closed unit cylinder (z ∈ [−1, 0], r ≤ 1) scaled per frame to the regime's bounds and
// drawn BackSide + additive: each pixel integrates emission from where the view ray enters
// the bounds (or the camera, when inside) to the back face — 20 jittered steps plus a
// closed-form Gaussian halo. Emission terms: r⁻²-expanding core, nozzle disc, shock
// diamonds, Mach disk, rarefied streak. The REGIME (which terms, colours, lengths) comes
// from `drivePlume` — the same variable-Isp physics that bills the fuel — on the CPU.
//
// ⚠ Radiance is normalised so the vacuum core seen side-on at the nozzle is PLUME_HDR × θ,
// as before; air regimes are ARTISTIC gains relative to that anchor (stated, not derived).


/** erf(x) ≈ tanh(1.202x), with tanh from exp (TSL has none); clamped so exp cannot overflow. */
/**
 * Additive COLOUR, untouched ALPHA. ⚠ AdditiveBlending adds src·α to the alpha channel too:
 * MEASURED alpha 2.0 inside the plume's bounding cylinder and 3.0 where the halo sphere
 * overlapped (the half-float target does not clamp), against 1.0 everywhere else. The canvas
 * is `premultiplied`, so the compositor showed every pixel of the bounds differently — the
 * owner's "bright polygon", and the whole screen once the camera sat inside the halo.
 * `canvas:` captures read the render target and could not see it.
 */
function additiveKeepAlpha(m: NodeMaterial): void {
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneFactor;
  m.blendEquationAlpha = THREE.AddEquation;
  m.blendSrcAlpha = THREE.ZeroFactor;
  m.blendDstAlpha = THREE.OneFactor;
}

/** TSL smoothstep(a, b, x) with node or number edges. */
const smoothstepN = (a: ReturnType<typeof float> | number, b: ReturnType<typeof float> | number, x: ReturnType<typeof float>) => {
  const A = typeof a === "number" ? float(a) : a;
  const B = typeof b === "number" ? float(b) : b;
  const t = tslClamp(x.sub(A).div(B.sub(A)), 0, 1);
  return t.mul(t).mul(float(3).sub(t.mul(2)));
};

const erfApprox = (x: ReturnType<typeof float>) => {
  const e = exp(x.mul(2.404).clamp(-20, 20));
  return e.sub(1).div(e.add(1));
};

/** Linear-RGB palettes (luminance ≈ 1). Hue is hue; level is set by the regime gains. */
const lumNorm = (r: number, g: number, b: number): [number, number, number] => {
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [r / l, g / l, b / l];
};
const PAL = {
  // Water plasma torch: H Balmer pink-magenta body, white-violet core, violet tip.
  torchCore: lumNorm(1.0, 0.86, 1.0),
  torchBody: lumNorm(1.0, 0.36, 0.78),
  torchTip: lumNorm(0.6, 0.38, 1.0),
  // Hot air jet (~5 kK): white-violet shocks, O+NO afterglow yellow-orange.
  airCore: lumNorm(0.95, 0.9, 1.0),
  airBody: lumNorm(1.0, 0.6, 0.3),
  // Few-eV air plasma: N₂⁺ violet core, N₂ 1P pink fringe.
  plasmaBody: lumNorm(0.62, 0.45, 1.0),
  plasmaTip: lumNorm(1.0, 0.45, 0.72),
  // Rarefied beam below ~100 km: N₂⁺ 391/428 nm violet-blue.
  streak: lumNorm(0.5, 0.48, 1.0),
  // CO₂ worlds: CN violet 388 nm + CO/CO₂⁺ blue-violet; Venus crushed glow white-orange.
  co2Body: lumNorm(0.62, 0.55, 1.0),
  crushed: lumNorm(1.0, 0.72, 0.42),
  // H₂/He: Hα pink-magenta once ionised; hot H₂ itself is nearly invisible.
  h2Body: lumNorm(1.0, 0.32, 0.58),
};

type V3 = [number, number, number];
const lerp3 = (a: V3, b: V3, t: number, out: V3): V3 => {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
};

/** Target plume parameters for one frame (CPU), smoothed into the uniforms. */
type PlumeParams = {
  R: number; L: number; torch: number; falloff: number; spread: number; coreLen: number; core: number;
  cell: number; diamond: number; diamondW: number;
  machZ: number; machR: number; mach: number;
  streakLen: number; streak: number; disc: number; turb: number;
  haloA: number; haloZ: number; halo: number; light: number;
  colCore: V3; colBody: V3; colTip: V3;
};

function createParams(): PlumeParams {
  return {
    R: 1, L: 6, torch: 1, falloff: 4, spread: 0.25, coreLen: 1.2, core: 1, cell: 4, diamond: 0, diamondW: 0.3,
    machZ: 5, machR: 0.5, mach: 0, streakLen: 20, streak: 0, disc: 1, turb: 0.15,
    haloA: 2, haloZ: 1, halo: 0, light: 1,
    colCore: [...PAL.torchCore], colBody: [...PAL.torchBody], colTip: [...PAL.torchTip],
  };
}

const _c1: V3 = [0, 0, 0];
const _c2: V3 = [0, 0, 0];

/** Regime → visual parameters. Pure, allocation-free. */
function plumeParams(pl: ReturnType<typeof createDrivePlume>, rn: number, out: PlumeParams): PlumeParams {
  const torch = pl.torch01;
  const air = 1 - torch;
  const rare = pl.rarefied01;
  const jet = air * (1 - rare);
  const crushed = pl.crushed01;
  const ratio = Math.min(1e4, pl.peOverPa);

  // Dense jet geometry: shock cells (p_e/p_a < ~3), then barrel + Mach disk, bell above ~30.
  const mach01 = smoothstep(2.2, 5, ratio) * (1 - smoothstep(800, 3000, ratio));
  const machZ = Math.min(80, pl.machDiskM);
  const jetLen = clamp(6 * pl.cellLenM + 2 * machZ * mach01, 10, 90) * (1 - 0.75 * crushed);
  const streakLen = clamp(pl.stopLenM, 15, 400);

  out.L = torch * 4.5 * (rn / 0.455) + jet * jetLen + air * rare * streakLen * 1.6;
  // Emission ∝ n²: a freely expanding plasma falls as r⁻⁴ (§5.3); a mixing hot-air jet slower.
  out.torch = torch;
  out.falloff = torch * 4 + air * 3;
  out.coreLen = torch * 1.2 * (rn / 0.455) + jet * jetLen * 0.35 + air * rare * 2;
  out.spread = torch * 0.25 + jet * (0.04 + 0.02 * Math.log10(Math.max(1, ratio)) + 0.4 * crushed) + air * rare * 0.12;
  // Tight bounds (they set the march's pixel footprint): each term's own visible reach.
  // 2.5 coreLen: past that the r⁻⁴·e^(−d/ℓ) core is < 1e-4 of its peak (bounds = pixel cost).
  const coreReach = Math.min(out.L, 2.5 * out.coreLen, torch * 99 + air * 15);
  const jetR = Math.max(pl.jetDiaM * 0.6, 0.4 * machZ * mach01);
  out.R = Math.max(rn * 1.5, 1.6 * (rn + out.spread * coreReach), jet * jetR * 1.4, air * rare * 2.5 * (0.8 * rn + 0.006 * out.L));
  // Hot air is nearly transparent; its plasma band is bright (artistic gains vs the torch).
  out.core = torch + jet * (0.1 + 0.35 * pl.plasma01) * (1 + crushed) + air * rare * 0.08;
  out.cell = pl.cellLenM;
  out.diamond = jet * (1 - mach01) * (1 - crushed) * 0.8;
  out.diamondW = Math.max(0.2, pl.jetDiaM * 0.45);
  out.machZ = machZ;
  out.machR = Math.max(0.25, 0.16 * machZ);
  if (out.mach > 1e-4) out.R = Math.max(out.R, 1.7 * out.machR);
  out.mach = jet * mach01 * (1 - smoothstep(30, 75, machZ)) * 0.35;
  out.streakLen = streakLen;
  out.streak = air * rare * 0.12;
  out.disc = torch * 1.5 + jet * 0.4;
  // Under-resolved modulation is noise, not detail: kept low enough that 18 samples converge.
  out.turb = torch * 0.12 + air * 0.15;

  // Scattering halo ∝ local scattering (≈ ρ), only where the plume is bright and dense.
  const scatter = Math.min(1, Math.sqrt(pl.rhoAmb / 1.225));
  out.haloA = 2 + 0.12 * out.L * (1 + crushed);
  out.haloZ = Math.min(out.L * 0.3, 10);
  // Peak halo radiance as a FRACTION of the plume's (shader divides out the chord length).
  out.halo = air * scatter * (0.01 + 0.04 * crushed);
  out.light = torch + air * (0.5 + 0.5 * out.core);

  // Colour by regime and gas.
  const gas = pl.gas;
  const airBody = gas === "co2" ? PAL.co2Body : gas === "h2" ? PAL.h2Body : PAL.airBody;
  const plasmaBody = gas === "h2" ? PAL.h2Body : gas === "co2" ? PAL.co2Body : PAL.plasmaBody;
  lerp3(airBody as V3, plasmaBody as V3, pl.plasma01, _c1);
  lerp3(_c1, PAL.crushed as V3, crushed, _c1);
  lerp3(_c1, PAL.streak as V3, rare, _c1);
  lerp3(_c1, PAL.torchBody as V3, torch, out.colBody);
  lerp3(PAL.airCore as V3, PAL.torchCore as V3, torch, out.colCore);
  lerp3(PAL.plasmaTip as V3, PAL.streak as V3, rare, _c2);
  lerp3(_c2, PAL.torchTip as V3, torch, out.colTip);
  return out;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function clamp(x: number, a: number, b: number): number {
  return Math.min(b, Math.max(a, x));
}

const SMOOTH_TAU_S = 0.35;
const SNAP_KEYS = ["diamond", "mach", "streak", "halo", "disc"] as const;
const NUM_KEYS = ["R", "L", "torch", "falloff", "spread", "coreLen", "core", "cell", "diamond", "diamondW", "machZ", "machR", "mach", "streakLen", "streak", "disc", "turb", "haloA", "haloZ", "halo", "light"] as const;

/**
 * The volume starts this far downstream of the nozzle exit, m. ⚠ A cap ON the exit plane is
 * coplanar with the nacelle's rear face: BackSide depth test z-fought there (a noisy ring
 * around the bells). The exit disc is analytic, so nothing is lost by stepping off the plane.
 */
const CAP_M = 0.04;

/** Samples per nozzle axis (plus PER_AXIS at the nozzle exit in vacuum); balance heuristic. */
const PER_AXIS = 3;

function makePlumeMaterial(u: ReturnType<typeof makeUniforms>): NodeMaterial {
  const m = new NodeMaterial();
  m.side = THREE.BackSide;
  m.depthWrite = false;
  m.transparent = true;
  additiveKeepAlpha(m);

  m.fragmentNode = Fn(() => {
    // Mesh frame: volume z ∈ [−L, 0]; the nozzle exit plane is at z = +CAP_M.
    const S = vec3(u.R, u.R, u.L);
    const camL = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz.mul(S).toVar();
    const pExit = positionLocal.mul(S).toVar();
    const seg = pExit.sub(camL);
    const tExit = seg.length().toVar();
    const rd = normalize(seg).toVar();

    // Entry: the later of the infinite-cylinder entry and the z-slab entry, never behind the eye.
    const aC = max(rd.x.mul(rd.x).add(rd.y.mul(rd.y)), 1e-6);
    const bC = camL.x.mul(rd.x).add(camL.y.mul(rd.y));
    const cC = camL.x.mul(camL.x).add(camL.y.mul(camL.y)).sub(u.R.mul(u.R));
    const tCyl = bC.negate().sub(sqrt(max(bC.mul(bC).sub(aC.mul(cC)), 0))).div(aC);
    const rdz = rd.z.sign().mul(max(rd.z.abs(), 1e-5)).add(rd.z.equal(0).select(1e-5, 0));
    const tz0 = u.L.negate().sub(camL.z).div(rdz);
    const tz1 = camL.z.negate().div(rdz);
    const tNear = max(max(tCyl, min(tz0, tz1)), 0).toVar();
    const span = max(tExit.sub(tNear), 1e-4).toVar();

    const rn = u.rn;
    const zN = float(CAP_M);
    const acc = vec3(0).toVar();
    // Squared distance to the NEARER nozzle axis (±off in xy): twin jets in one volume.
    const axisR2 = (q: ReturnType<typeof vec3>) => {
      const ax = q.xy.sub(u.off), bx = q.xy.add(u.off);
      return min(dot(ax, ax), dot(bx, bx));
    };

    // ── Importance sampling (equi-angular / Cauchy proposals, Kulla & Fajardo 2012) ──
    // A uniform 14-step march put 3 jittered samples across a side-on jet: visible static noise.
    // Proposals: closest approach to axis A, to axis B, and the nozzle-exit crossing (where the
    // r⁻⁴ core lives). Any centre/scale is a valid proposal, so both are clamped freely.
    const sin2 = max(rd.x.mul(rd.x).add(rd.y.mul(rd.y)), 1e-6);
    const wMin2 = rn.mul(rn).mul(0.5);
    const axisProposal = (sx: number) => {
      const ox = camL.x.sub(u.off.x.mul(sx)), oy = camL.y.sub(u.off.y.mul(sx));
      const bq = ox.mul(rd.x).add(oy.mul(rd.y));
      const tStar = bq.negate().div(sin2);
      const r2min = max(ox.mul(ox).add(oy.mul(oy)).sub(bq.mul(bq).div(sin2)), 0);
      const h = tslClamp(sqrt(r2min.add(wMin2).div(sin2)), 0.05, span.mul(4));
      return { c: tslClamp(tStar, tNear, tExit).toVar(), h: h.toVar() };
    };
    const pA = axisProposal(1);
    const pB = axisProposal(-1);
    const tNoz = tslClamp(zN.sub(u.coreLen.mul(0.5)).sub(camL.z).div(rdz), tNear, tExit);
    const pN = { c: tNoz.toVar(), h: tslClamp(u.coreLen.div(max(rd.z.abs(), 0.15)), 0.05, span.mul(4)).toVar() };
    const props = [pA, pB, pN].map((pp) => ({
      ...pp,
      th0: atan(tNear.sub(pp.c).div(pp.h)).toVar(),
      th1: atan(tExit.sub(pp.c).div(pp.h)).toVar(),
    }));
    const pdf = (pp: (typeof props)[number], t: ReturnType<typeof float>) => {
      const x = t.sub(pp.c);
      return pp.h.div(max(pp.th1.sub(pp.th0), 1e-6).mul(pp.h.mul(pp.h).add(x.mul(x))));
    };
    // Soft window: emission → exactly 0 at the bounds, so no silhouette survives a dark-sky
    // pre-exposure of ~1e4 (the "bright polygon" bug).
    // Measured from the NEARER axis with the per-jet radius Rp (the cylinder is Rp + |off|),
    // so it reaches 0 before any wall, including for the analytic Mach disk.
    const radialWin = (r2: ReturnType<typeof float>) => float(1).sub(smoothstepN(u.Rp.mul(0.4), u.Rp.mul(0.98), sqrt(r2)));
    const axialWin = (z: ReturnType<typeof float>) => float(1).sub(smoothstepN(u.L.mul(0.7), u.L, z.negate()));

    const emit = (t: ReturnType<typeof float>) => {
      const p = camL.add(rd.mul(t)).toVar();
      const d = max(p.z.negate().add(zN), 0).toVar();
      const r2 = axisR2(p).toVar();
      const w = rn.add(d.mul(u.spread));
      const win = radialWin(r2).mul(axialWin(p.z));
      // Core: (r_n/w)^p expansion (p = 4 for a plasma, n² emission) × axial decay × Gaussian.
      const core = rn.div(w).pow(u.falloff).mul(exp(d.div(u.coreLen).negate())).mul(exp(r2.div(w.mul(w).mul(0.5)).negate()));
      // Flow structure: cross-stream streaks scaled to the local width, racing downstream.
      const q = p.x.mul(0.8).add(p.y.mul(0.6)).div(w);
      const n = float(1).sub(u.turb).add(u.turb.mul(
        sin(q.mul(3.5).add(d.mul(0.9)).sub(u.time.mul(23))).mul(0.4).add(1)
          .mul(sin(d.mul(2.3).sub(u.time.mul(41)).add(q.mul(3))).mul(0.3).add(0.8)),
      ));
      const axialT = min(d.div(max(u.L.mul(0.5), 0.5)), 1);
      const coreE = core.mul(u.core);
      const e = vec3(u.colBody.mul(coreE.mul(n))
        .add(u.colCore.mul(coreE.mul(float(1).sub(axialT)).mul(0.6)))
        .add(u.colTip.mul(coreE.mul(axialT).mul(0.5)))).toVar();
      If(u.diamond.greaterThan(0), () => {
        // max(·,0): fast-math cos can dip below −1, and pow() of a negative base is NaN.
        const cellC = max(cos(d.div(u.cell).mul(6.2831853)).mul(0.5).add(0.5), 0);
        const c2 = cellC.mul(cellC);
        // Lozenge per cell: narrow and bright where the oblique shocks cross the axis.
        const dw = u.diamondW.mul(float(1).sub(cellC.mul(0.7)));
        e.addAssign(u.colCore.mul(c2.mul(c2).mul(c2).mul(exp(d.div(u.cell.mul(6)).negate()))
          .mul(exp(r2.div(dw.mul(dw)).negate())).mul(u.diamond)));
      });
      If(u.streak.greaterThan(0), () => {
        const sw = rn.mul(0.8).add(d.mul(0.006));
        e.addAssign(u.colTip.mul(exp(d.div(u.streakLen).negate()).mul(exp(r2.div(sw.mul(sw)).negate())).mul(u.streak).mul(n)));
      });
      return e.mul(win);
    };

    // Sample counts: PER_AXIS on each nozzle axis; the nozzle-exit proposal only where the
    // r⁻⁴ core is short (vacuum torch, u.nNoz = PER_AXIS) — in air it spans tens of metres and
    // the axis proposals cover it (u.nNoz = 0 skips the loop, a uniform branch).
    const nNoz = u.nNoz;
    const mixPdf = (t: ReturnType<typeof float>) =>
      pdf(props[0], t).add(pdf(props[1], t)).mul(PER_AXIS).add(pdf(props[2], t).mul(nNoz));
    const strategy = (pp: (typeof props)[number], n: ReturnType<typeof float> | number, offset: number) => {
      const nf = typeof n === "number" ? float(n) : n;
      Loop({ start: 0, end: typeof n === "number" ? n : int(n), type: "int", condition: "<" }, ({ i }: { i: Node }) => {
        // Deterministic stratified quadrature (offset per strategy), no per-pixel jitter: with
        // these proposals the integrand is smooth in u, and a screen-space dither left a visible
        // dot grid on the nozzle glow at the sample counts we can afford.
        const uu = float(i).add(0.5 + offset).div(nf);
        // Clamped: tan() near ±π/2 overflows, and an Inf sample gives Inf/Inf = NaN in the
        // Gaussian, which the glare pass then smears over the whole screen.
        const t = tslClamp(pp.c.add(pp.h.mul(tan(pp.th0.add(pp.th1.sub(pp.th0).mul(uu))))), tNear, tExit).toVar();
        // Balance heuristic over the proposals, weighted by their sample counts.
        acc.addAssign(emit(t).div(max(mixPdf(t), 1e-12)));
      });
    };
    strategy(props[0], PER_AXIS, -0.25);
    strategy(props[1], PER_AXIS, 0.25);
    strategy(props[2], nNoz, 0);

    // Mach disk, analytic: a thin luminous slab at z = −z_m crossed once by the ray, so its
    // radiance is (slab column)/|rd.z| — exact at any sample count.
    const tm = u.machZ.negate().add(zN).sub(camL.z).div(rdz);
    const pm = camL.add(rd.mul(tm));
    const inSeg = tm.greaterThan(tNear).and(tm.lessThan(tExit)).select(1, 0);
    const slab = u.machZ.mul(0.02).add(0.06).mul(1.7725);
    const machDisk = exp(axisR2(pm).div(u.machR.mul(u.machR)).negate())
      .mul(slab).div(max(rd.z.abs(), 0.05)).mul(u.mach).mul(inSeg)
      .mul(radialWin(axisR2(pm))).mul(axialWin(u.machZ.negate()));
    // Nozzle-exit disc: the bell mouth seen down the axis. Super-Gaussian confined INSIDE the
    // mouth (r < r_n) and faded at grazing angles, where the bell wall hides it — its old
    // Gaussian tail painted the nacelle face around each bell.
    const tE = zN.sub(camL.z).div(rdz);
    const pE = camL.add(rd.mul(tE));
    const reachesExit = tE.greaterThan(tNear).and(rd.z.greaterThan(0)).select(1, 0);
    const rr = axisR2(pE).div(rn.mul(rn).mul(0.55));
    const disc = exp(rr.mul(rr).negate()).mul(0.2127).mul(smoothstepN(0.25, 0.6, rd.z))
      .div(max(rd.z, 0.25)).mul(u.disc).mul(reachesExit);
    const raw = acc.add(u.colCore.mul(machDisk.add(disc))).div(rn.mul(1.25)).mul(u.intensity);
    // Sanitise: one NaN/Inf pixel is smeared over the whole screen by the glare pass.
    const finite = raw.x.equal(raw.x).and(raw.y.equal(raw.y)).and(raw.z.equal(raw.z));
    const rgb = finite.select(tslClamp(raw, 0, 1.0e6), vec3(0));
    // Colour is added as-is (blendSrc One); alpha is ignored by additiveKeepAlpha.
    return vec4(rgb, 1);
  })();
  return m;
}

/**
 * Scattering halo (E4): its own sphere (r = 2.5 a around the axis point), so the march
 * bounds stay tight. Closed form ∫exp(−|x−c|²/a²)ds = a·(√π/2)·[erf]·exp(−d⊥²/a²); no loop.
 */
function makeHaloMaterial(u: ReturnType<typeof makeUniforms>): NodeMaterial {
  const m = new NodeMaterial();
  m.side = THREE.BackSide;
  m.depthWrite = false;
  m.transparent = true;
  additiveKeepAlpha(m);
  m.fragmentNode = Fn(() => {
    // Mesh = unit sphere × 2.5a × HALO_MESH_PAD, so its facets strictly ENCLOSE the analytic
    // r = 2.5a sphere; entry and exit are analytic, the mesh only supplies the ray direction
    // (a faceted exit put a per-facet residual at the silhouette).
    const camL = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz.mul(2.5 * HALO_MESH_PAD).toVar();
    const rd = normalize(positionLocal.mul(2.5 * HALO_MESH_PAD).sub(camL)).toVar();
    const s0 = dot(camL, rd).negate();
    const dperp2 = max(dot(camL, camL).sub(s0.mul(s0)), 0);
    const half = sqrt(max(float(6.25).sub(dperp2), 0));
    const tNear = max(s0.sub(half), 0);
    const tExit = max(s0.add(half), tNear);
    // Minus the kernel's rim value e^(−6.25) over the chord: exactly 0 at the sphere's edge.
    const g = max(exp(dperp2.negate()).mul(0.8862).mul(erfApprox(tExit.sub(s0)).sub(erfApprox(tNear.sub(s0))))
      .sub(tExit.sub(tNear).mul(0.00193)), 0);
    // g ≤ √π through the centre: u.halo is the peak halo radiance as a fraction of the plume's
    // PLUME_HDR (it was ×a/r_n, ~4× brighter than the plume itself with a crushed Venus jet).
    const rgb = u.colHalo.mul(g.div(1.7725).mul(u.halo)).mul(u.intensity);
    return vec4(rgb, 1);
  })();
  return m;
}

function makeUniforms() {
  return {
    R: uniform(1), Rp: uniform(1), nNoz: uniform(3), L: uniform(6), rn: uniform(0.455), falloff: uniform(4), spread: uniform(0.25), coreLen: uniform(1.2), core: uniform(1),
    cell: uniform(4), diamond: uniform(0), diamondW: uniform(0.3), machZ: uniform(5), machR: uniform(0.5), mach: uniform(0),
    streakLen: uniform(20), streak: uniform(0), disc: uniform(1), turb: uniform(0.15),
    haloA: uniform(2), haloZ: uniform(1), halo: uniform(0), light: uniform(1),
    time: uniform(0), intensity: uniform(0),
    /** Half the nozzle spacing in plume-local xy, m (0 for a single nozzle). */
    off: uniform(new THREE.Vector2(0, 0)),
    colCore: uniform(new THREE.Vector3(...PAL.torchCore)),
    colBody: uniform(new THREE.Vector3(...PAL.torchBody)),
    colTip: uniform(new THREE.Vector3(...PAL.torchTip)),
    colHalo: uniform(new THREE.Vector3(1, 1, 1)),
  };
}

/** Mesh/analytic radius ratio: > 1/cos(π/12) so 16×12 facets enclose the sphere. */
const HALO_MESH_PAD = 1.06;
let _unitSphere: THREE.SphereGeometry | null = null;
function unitSphere(): THREE.SphereGeometry {
  if (!_unitSphere) _unitSphere = new THREE.SphereGeometry(1, 16, 12);
  return _unitSphere;
}

let _unitCylinder: THREE.CylinderGeometry | null = null;
/** Closed unit cylinder, r = 1, z ∈ [−1, 0] (nozzle exit at z = 0, plume toward −Z). */
function unitCylinder(): THREE.CylinderGeometry {
  if (!_unitCylinder) {
    _unitCylinder = new THREE.CylinderGeometry(1, 1, 1, 20, 1, false);
    _unitCylinder.rotateX(-Math.PI / 2);
    _unitCylinder.translate(0, 0, -0.5);
  }
  return _unitCylinder;
}

const _wp = new THREE.Vector3();

// ── Component ────────────────────────────────────────────────────────
const EngineExhaust = memo(function EngineExhaust({
  configs,
  intensityRef,
  castLight = true,
}: Props) {
  const meshRefs = useRef<(THREE.Mesh | null)[]>([]);
  const lightRefs = useRef<(THREE.PointLight | null)[]>([]);
  const worldOrigin = useWorldOrigin();

  // Per-instance (per ship) state: every ship reads the air at ITS OWN position, with the
  // default tuning, so co-op peers draw the same plume (VFX plan §5.6.6).
  const st = useMemo(() => ({
    u: makeUniforms(),
    ambient: createAmbient(),
    plume: createDrivePlume(),
    target: createParams(),
    cur: createParams(),
    primed: false,
  }), []);
  const mat = useMemo(() => makePlumeMaterial(st.u), [st]);
  const haloMat = useMemo(() => makeHaloMaterial(st.u), [st]);
  const haloRef = useRef<THREE.Mesh | null>(null);
  const geo = unitCylinder();
  const rn = configs[0]?.radius ?? 0.455;

  // One halo for the ship, centred between the nozzles.
  const haloAt = useMemo((): [number, number, number] => {
    const c: [number, number, number] = [0, 0, 0];
    for (const cfg of configs) for (let j = 0; j < 3; j++) c[j] += cfg.position[j] / Math.max(1, configs.length);
    return c;
  }, [configs]);
  /** Two nozzles at the same z: one march around their midpoint, axes at ±off. */
  const twin = configs.length === 2 && Math.abs(configs[0].position[2] - configs[1].position[2]) < 1e-3;
  const halfSpacing = twin ? Math.hypot(configs[1].position[0] - configs[0].position[0], configs[1].position[1] - configs[0].position[1]) / 2 : 0;
  if (twin) st.u.off.value.set((configs[1].position[0] - configs[0].position[0]) / 2, (configs[1].position[1] - configs[0].position[1]) / 2);

  useFrame((_, delta) => {
    const intensity = intensityRef.current ?? 0;
    const u = st.u;
    u.time.value += delta;

    // Air at the first nozzle's absolute position (km).
    const mesh0 = meshRefs.current[0];
    if (mesh0) {
      mesh0.parent?.getWorldPosition(_wp);
      const o = worldOrigin.worldOriginKm;
      const amb = ambientAt(o.x + _wp.x / 1000, o.y + _wp.y / 1000, o.z + _wp.z / 1000, st.ambient);
      drivePlume(amb.model, amb.altitudeKm, intensity, DEFAULT_RESOURCE_TUNING, st.plume);
      plumeParams(st.plume, rn, st.target);
    }
    // Smooth every parameter (regime boundaries must never pop); snap on the first frame.
    const k = st.primed ? 1 - Math.exp(-delta / SMOOTH_TAU_S) : 1;
    st.primed = true;
    const tgt = st.target, cur = st.cur;
    for (const key of NUM_KEYS) cur[key] += (tgt[key] - cur[key]) * k;
    for (const key of SNAP_KEYS) if (tgt[key] === 0 && cur[key] < 1e-6) cur[key] = 0;
    for (let j = 0; j < 3; j++) {
      cur.colCore[j] += (tgt.colCore[j] - cur.colCore[j]) * k;
      cur.colBody[j] += (tgt.colBody[j] - cur.colBody[j]) * k;
      cur.colTip[j] += (tgt.colTip[j] - cur.colTip[j]) * k;
    }
    u.R.value = cur.R + (twin ? halfSpacing : 0);
    u.Rp.value = cur.R;
    u.nNoz.value = cur.torch > 0.5 ? PER_AXIS : 0;
    u.falloff.value = cur.falloff; u.L.value = cur.L; u.rn.value = rn; u.spread.value = cur.spread;
    u.coreLen.value = cur.coreLen; u.core.value = cur.core; u.cell.value = Math.max(0.5, cur.cell);
    u.diamond.value = cur.diamond; u.diamondW.value = cur.diamondW; u.machZ.value = Math.max(0.5, cur.machZ);
    u.machR.value = cur.machR; u.mach.value = cur.mach; u.streakLen.value = cur.streakLen; u.streak.value = cur.streak;
    u.disc.value = cur.disc; u.turb.value = cur.turb; u.haloA.value = cur.haloA; u.haloZ.value = cur.haloZ; u.halo.value = cur.halo;
    u.colCore.value.set(cur.colCore[0], cur.colCore[1], cur.colCore[2]);
    u.colBody.value.set(cur.colBody[0], cur.colBody[1], cur.colBody[2]);
    u.colTip.value.set(cur.colTip[0], cur.colTip[1], cur.colTip[2]);
    u.colHalo.value.set(0.5 + 0.5 * cur.colBody[0], 0.5 + 0.5 * cur.colBody[1], 0.5 + 0.5 * cur.colBody[2]);

    // × preExposure (D25) — the plume is emissive, so nothing else scales it.
    // Throttle changes brightness, not length, in vacuum (§5.3); air regimes scale via p_e ∝ θ.
    // Twin nozzles share ONE march (the shader takes the nearer axis), so overlapping wide
    // plumes cost one volume, not two.
    u.intensity.value = intensity * PLUME_HDR * getPreExposure();

    const halo = haloRef.current;
    if (halo) {
      const haloOn = intensity > 1e-5 && cur.halo > 0;
      halo.visible = true; // compiled at mount, collapsed when off (see the plume mesh below)
      halo.scale.setScalar(haloOn ? 2.5 * HALO_MESH_PAD * cur.haloA : 1e-4);
      halo.position.set(0, 0, -cur.haloZ);
    }
    for (let i = 0; i < configs.length; i++) {
      const mesh = meshRefs.current[i];
      if (mesh) {
        // Idle: stay visible but collapse to ~0 pixels, so the pipeline is compiled at mount.
        // Hidden-until-thrust compiled on the first throttle-up, and the plume then appeared
        // late into a dark-adapted exposure: a whole-screen white flash.
        const on = intensity > 1e-5;
        const R = on ? cur.R + (twin ? halfSpacing : 0) : 1e-4;
        mesh.scale.set(R, R, on ? cur.L : 1e-4);
        mesh.visible = !twin || i === 0;
        if (twin && i === 0) mesh.position.set(haloAt[0] - configs[0].position[0], haloAt[1] - configs[0].position[1], haloAt[2] - configs[0].position[2] - CAP_M);
        else mesh.position.set(0, 0, -CAP_M);
      }
      const light = lightRefs.current[i];
      if (light) {
        // × preExposure like every light (D25). ⚠ NEVER toggle light.visible: it changes the
        // lights hash and recompiles every lit material (measured ~1 s stall per throttle cycle).
        light.intensity = intensity * plumeLightIntensity(configs[i].radius) * cur.light * getPreExposure();
        light.distance = LIGHT_DISTANCE * Math.min(2, Math.max(1, cur.L / PLUME_MAX_LENGTH));
        // ≥ 1 m downstream: closer, the 1/d² near field blew out bell walls and struts.
        light.position.set(0, 0, -Math.max(1, Math.min(cur.L * 0.2, 6)));
        light.color.setRGB(cur.colBody[0], cur.colBody[1], cur.colBody[2]).multiplyScalar(0.5).add(LIGHT_COLOR_HALF);
      }
    }
  });

  return (
    <>
      <group position={haloAt}>
        <mesh ref={haloRef} geometry={unitSphere()} material={haloMat} frustumCulled={false} />
      </group>
      {configs.map((cfg, i) => (
        <group key={i} position={cfg.position}>
          <mesh
            ref={(m) => { meshRefs.current[i] = m; }}
            geometry={geo}
            material={mat}
            frustumCulled={false}
          />
          {castLight && <pointLight
            ref={(l) => { lightRefs.current[i] = l; }}
            color={LIGHT_COLOR}
            intensity={0}
            distance={LIGHT_DISTANCE}
            decay={2}
          />}
        </group>
      ))}
    </>
  );
});

export default EngineExhaust;
