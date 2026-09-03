"use client";

import { memo, useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { NodeMaterial } from "three/webgpu";
import {
  Fn,
  sqrt,
  vec3,
  uniform,
  uv,
  positionGeometry,
  modelWorldMatrix,
  cameraViewMatrix,
  cameraProjectionMatrix,
  vec4,
  float,
  length,
  pow,
  clamp,
  smoothstep,
  max,
  varying,
  cameraNear,
  cameraFar,
  viewZToLogarithmicDepth,
} from "three/tsl";
import SimGroup from "../space/SimGroup";
import { kmToScaledUnits } from "@/sim/units";
import { STAR_POSITION_KM } from "@/sim/celestialConstants";
import {
  blackbodyLinearSrgb,
  HALF_FLOAT_WRITE_MAX,
  subPixelFluxScale,
  getPreExposure,
} from "@/components/space/photometry";
import {
  discRadianceGame,
  illuminanceGameAt,
  limbDarkeningRgb,
} from "@/components/space/starPhysics";
// ⚠ ONE implementation of the magnitude compression, shared with the sprite tier —
// R7f makes the two tiers' agreement load-bearing at every distance, not just at
// the catalogue distance.
import { starCompressionForIlluminance } from "@/components/Stars/StarField";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { sunVisibility } from "@/components/space/sunOcclusion";
import { SCALED_CAMERA_FAR } from "@/components/space/cameraPlanes";
import { getStarLift } from "@/components/space/starVisibility";
import {
  getStarCoronaScale,
  getStarGlareFlipY,
  getStarLimbScale,
  getStarPointGlareEnabled,
  starLodStatus as _status,
} from "@/components/space/starLodStatus";
import {
  clearStarPointGlare,
  getGlarePsfEnergy,
  setStarPointGlare,
} from "@/components/space/glarePass";

export { STAR_POSITION_KM };

/**
 * One star, from data. R2: nothing here is Sol-specific, so the same component
 * renders a catalogue star (`starParamsFromCatalogue`) or a generated primary
 * (`starParamsFromSystem`). See docs/STAR_RENDERING_PLAN.md §8.
 */
export type StarProps = {
  positionKm: readonly [number, number, number];
  radiusKm: number;
  /** Effective temperature, K — drives the blackbody hue only. */
  tempK: number;
  /** VISUAL luminosity in solar units (not bolometric — see starPhysics). */
  luminositySun: number;
  /** Publish `starLodStatus` for `__lum.starLod()`. One star may claim it. */
  primary?: boolean;
  /**
   * Apply the global star display lift (`starVisibility.getStarLift()`) while the
   * disc is unresolved. Default false — the primary never gets one.
   *
   * ⚠⚠ READ PER FRAME FROM THE MODULE, NOT PASSED AS A NUMBER. It used to be a
   * scalar `unresolvedGain` prop, and that was a real bug found by three
   * independent reviewers: the caller evaluated `getStarLift()` during React
   * render, and `NearbyStarDisc` only re-renders when the promoted star CHANGES —
   * so the disc's lift froze at whatever it was on the frame the star was selected.
   * Promoted in deep space (lift 1) then flying to a sunlit hull (lift ~338) left
   * the promoted star as the ONE star in the sky that did not brighten — and its
   * sprite is suppressed, so it simply vanished.
   *
   * 🔑 The lift is GLOBAL, so reading it here is also the architecturally right
   * place; only the per-star half needs to be a prop.
   */
  applyDisplayLift?: boolean;
};

// ── Reusable vectors ──
const _shipToStar = new THREE.Vector3();
const _bufSize = new THREE.Vector2();
const _view = new THREE.Vector3();
const _camQuat = new THREE.Quaternion();
/** Per-channel clipped flux. Module scratch — useFrame must not allocate. */
const _deficitRgb: [number, number, number] = [0, 0, 0];

/** Antialiasing half-width of the limb, in drawing-buffer pixels. */
const EDGE_AA_PX = 0.7;

/**
 * Flux of ONE channel of the rendered disc, `∫ min(value(x), cap)·2πx dx · R²`,
 * integrating the exact profile the fragment shader writes: the smoothstep limb,
 * the limb-darkening law, the per-channel gain and the tint.
 *
 * 🔑 Numeric and shader-identical on purpose. The clamp is PER PIXEL and PER
 * CHANNEL, so the surviving flux is not `cap × area` — the soft limb and the
 * darkened limb are both partly under the cap. Closed-form algebra on a flat hard
 * disc disagreed with what was actually written; this cannot.
 *
 * `x` is r/R, so the AA band extends to `1 + aaFracR`.
 */
function discChannelFlux(
  peakScalar: number,
  tint: number,
  a: number,
  b: number,
  gain: number,
  limbScale: number,
  cap: number,
  radiusPx: number,
  aaFracR: number,
): number {
  const N = 96;
  const xMax = 1 + Math.max(aaFracR, 0);
  const dx = xMax / N;
  let acc = 0;
  for (let i = 0; i < N; i++) {
    const x = (i + 0.5) * dx;
    let sm: number;
    if (aaFracR <= 1e-9) {
      sm = x <= 1 ? 1 : 0;
    } else {
      const t = (1 + aaFracR - x) / (2 * aaFracR);
      sm = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
    }
    const xc = Math.min(x, 1);
    const mu = Math.sqrt(Math.max(0, 1 - xc * xc));
    const om = 1 - mu;
    const prof = Math.max(0, (1 - a * om - b * om * om) * gain);
    const limb = 1 + (prof - 1) * limbScale;
    acc += Math.min(tint * peakScalar * sm * limb, cap) * 2 * Math.PI * x * dx;
  }
  return acc * radiusPx * radiusPx;
}

// ── Shell clamp (R1, docs/STAR_RENDERING_PLAN.md) ────────────────────────────
// Beyond this range the billboard is pulled along the camera→star ray so it sits
// inside the far plane; without it the star is culled/clipped past `far / cos θ`
// (13.37 AU at frame centre, ~18 AU at the corner) — the sun vanishing past
// Saturn. DERIVED from the far plane so the two cannot drift apart.
const SHELL_CLAMP_FRACTION = 0.6;
const SHELL_CLAMP_SCALED = SCALED_CAMERA_FAR * SHELL_CLAMP_FRACTION;

// ⚠⚠ LEGACY, GATED OFF (starLodStatus.getStarCoronaScale). The hand-authored
// corona from the bloom era. MEASURED: beyond ~5 AU it carried 5.3× the star's
// entire physical flux, so it lied to the glare pass AND the exposure meter.
// Kept only for the runtime A/B; delete once judged.
const LEGACY_GLOW_PAD = 8;
const LEGACY_MIN_SCREEN_PX = 60;
const LEGACY_INNER_GLOW_FRAC = 0.3;
const LEGACY_OUTER_GLOW_ABS = 8.0;

/**
 * Quad radius as a multiple of the rendered disc radius — an antialiasing margin
 * now that the corona is gone, so `uCoreRatio` is the constant `1/PAD` whenever
 * the corona is off. Must exceed the limb's AA ramp.
 */
const DISC_AA_PAD = 1.4;

/**
 * Below this many drawing-buffer pixels a disc cannot be rasterised honestly — a
 * fragment either samples it or misses, so a physical radiance strobes. Drawn at
 * the floor with the radiance divided by the area ratio: flux preserved, shape
 * approximate.
 */
const DISC_PX_FLOOR = 2.5;

function Star({
  positionKm,
  radiusKm,
  tempK,
  luminositySun,
  primary = true,
  applyDisplayLift = false,
}: StarProps) {
  const worldOrigin = useWorldOrigin();
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);

  const RADIUS = kmToScaledUnits(radiusKm);
  // Derived, never stated — see starPhysics.discLuminanceNits for why.
  const discRadiance = useMemo(
    () => discRadianceGame(luminositySun, radiusKm),
    [luminositySun, radiusKm],
  );

  // Billboard half-extent in view-space units. Updated each frame.
  // ── R7a: EVERY uniform object here is created ONCE, with `[]` deps ──────────
  // 🔑 Per-star values are written to `.value`, never baked into a new uniform. The
  // material's `useMemo` lists these objects, so a stable identity means the
  // NodeMaterial is built exactly once per mount — and therefore that a fixed-size
  // POOL slot (§13.1) can change which star it holds with a uniform write instead of
  // a shader recompile. Before this, `uScale`/`uStarColor`/`uLimb*` were keyed on
  // `radiusKm`/`tempK`, so re-pointing a slot rebuilt the graph and stuttered.
  const uScale = useMemo(() => uniform(1), []);
  // Fraction of the quad's radius that is the disc. Constant `1/DISC_AA_PAD`
  // while the corona is off; the legacy path drives it per frame.
  const uCoreRatio = useMemo(() => uniform(1 / DISC_AA_PAD), []);
  // Disc radiance, game units. Physical while the disc resolves; flux-conserving
  // below DISC_PX_FLOOR.
  const uCoreRadiance = useMemo(() => uniform(1), []);
  // Shell clamp: 1.0 inside SHELL_CLAMP_SCALED, else SHELL_CLAMP_SCALED/dist.
  const uShellScale = useMemo(() => uniform(1), []);
  // Legacy corona multiplier. 0 = off (the shipped R3 behaviour). Gated on a
  // uniform rather than a graph rebuild because WebGPU recompile stutter is a
  // known problem here — same reason uGlareStrength is a uniform.
  const uCoronaScale = useMemo(() => uniform(0), []);
  // ── Eclipse gating (D34c) ────────────────────────────────────────────────
  // Fraction of the star's disc the EYE can see, from the same occluder registry
  // every body fills. Two uniforms, not one, because the disc and the glow are
  // occluded by different mechanisms:
  //
  // 🔑 THE DISC IS ALREADY OCCLUDED GEOMETRICALLY and must NOT be multiplied
  // here — occluders write depth into the same buffer this billboard is
  // depth-tested against, so a 50% eclipse multiplied as well would render 25%.
  // `uDiscVis` is therefore 1.0 whenever the disc is drawn at its true size, and
  // only departs from 1 in the sub-pixel branch below, where the disc is
  // deliberately drawn LARGER than it is and per-pixel depth is meaningless.
  //
  // ⚠⚠ THE GLOW IS THE ACTUAL BUG. 87.5% of the billboard's radius is glow
  // (GLOW_PAD = 8), so no occluder the size of the disc can ever cover it: a
  // total eclipse left a saturated white blob ~25 px across with a ~11 px dark
  // core, which reads as "the sun is still fully visible". The glow is the
  // disc's flux spread over an 8× footprint, so it has to scale with the flux
  // that SURVIVES — a per-pixel depth test structurally cannot do that.
  //
  // ⚠ `skipId` is null here, unlike SunLight's call: that skip exists because
  // the atmosphere pass owns the dominant body's shadow FOR LIGHTING. Nothing
  // lights the rendered disc, so nothing else attenuates it. No double count
  // with the atmosphere composite either — `sceneColor·T + L` is view-ray
  // EXTINCTION, a different physical term from occlusion.
  const uStarVis = useMemo(() => uniform(1), []);
  const uDiscVis = useMemo(() => uniform(1), []);
  // Blackbody hue from the primary's T_eff, luminance-normalised so it carries
  // colour ONLY — the magnitude is uCoreRadiance's job.
  const uStarColor = useMemo(() => uniform(new THREE.Color(1, 1, 1)), []);
  /**
   * ⚠⚠ THE CAP IS NOW PER-CHANNEL IN THE SHADER, which is what makes it safe.
   *
   * An earlier revision capped the SCALAR brightness and then multiplied by the
   * tint, so Sol's red channel (`uStarColor.r` = 1.1103) wrote 66,618 — above
   * half-float's 65,504 — and the disc stored **+Inf**, poisoning the whole glare
   * pyramid and dropping the sun from metering. That was patched with a scalar
   * budget of `60,000 / max(r,g,b)`, but R4's limb profile adds a SECOND
   * per-channel gain on top (the centre is ~1.27× the disc mean), so a scalar
   * budget would have to track both and would silently go stale the next time a
   * per-channel term is added.
   *
   * 🔑 Clamping the assembled vec3 instead is correct for ANY combination of tint
   * and profile, by construction. `writeBudget` survives only as the CPU-side cap
   * for the R3b deficit integral, where it is now simply HALF_FLOAT_WRITE_MAX.
   */
  const writeBudget = HALF_FLOAT_WRITE_MAX;

  /**
   * Limb darkening, derived from T_eff alone — see starPhysics.limbDarkeningRgb.
   * ⚠ ~70k `exp` calls, so memoised on `tempK` and never touched per frame.
   */
  const limb = useMemo(() => limbDarkeningRgb(tempK), [tempK]);
  const uLimbA = useMemo(() => uniform(new THREE.Vector3()), []);
  const uLimbB = useMemo(() => uniform(new THREE.Vector3()), []);
  /** 1 / discMeanNorm per channel — multiply, so the disc-mean stays exactly 1. */
  const uLimbGain = useMemo(() => uniform(new THREE.Vector3(1, 1, 1)), []);
  /** A/B: 0 = flat disc, 1 = the derived profile. */
  const uLimbScale = useMemo(() => uniform(1), []);
  /**
   * Half-width of the limb's antialiasing ramp, in `dist` units.
   *
   * 🔑 The photosphere is ~500 km on a 696,340 km radius, so the true limb is
   * sharp to **0.038 px** on a 105 px disc. The previous ±15%-of-radius ramp blurred
   * it over **15.8 px — 418× too soft**. All apparent softness must come from the
   * eye's PSF in glarePass, which is calibrated; a shader blur double-counts it,
   * exactly as the hand-authored corona did.
   */
  const uEdgeAA = useMemo(() => uniform(0.01), []);
  // Linear-sRGB blackbody triple, for tinting the analytic glare (R3b).
  const starRgb = useMemo(() => blackbodyLinearSrgb(tempK), [tempK]);

  // Per-star values → existing uniforms. An effect, not a render-time write, so a
  // re-render cannot mutate a uniform mid-frame.
  useEffect(() => {
    uStarColor.value.setRGB(starRgb[0], starRgb[1], starRgb[2]);
    uLimbA.value.set(limb.a[0], limb.a[1], limb.a[2]);
    uLimbB.value.set(limb.b[0], limb.b[1], limb.b[2]);
    uLimbGain.value.set(
      1 / limb.discMeanNorm[0],
      1 / limb.discMeanNorm[1],
      1 / limb.discMeanNorm[2],
    );
  }, [starRgb, limb, uStarColor, uLimbA, uLimbB, uLimbGain]);

  const geo = useMemo(() => new THREE.PlaneGeometry(1, 1), []);

  const mat = useMemo(() => {
    const m = new NodeMaterial();
    m.side = THREE.DoubleSide;
    m.depthWrite = false;
    m.transparent = true;
    m.blending = THREE.AdditiveBlending;

    const worldCenter = modelWorldMatrix.mul(vec4(0, 0, 0, 1));

    // Varying to forward VIEW-SPACE Z to the fragment shader for log depth.
    // ⚠⚠ WAS `clip.w + 1` FED INTO THE WEBGL-1 FORMULA
    // `log2(w+1)·2/log2(far+1)·0.5`, which is NOT what three's WebGPU backend
    // writes: `NodeMaterial.setupDepth` uses
    // `viewZToLogarithmicDepth(positionView.z, near, far)` =
    // `log2(−viewZ/near)/log2(far/near)` (ViewportDepthNode.js:279-282). The two
    // agree only at the far plane. MEASURED consequence: the sun's disc was
    // depth-tested as if it sat at **0.29 AU** instead of 1 AU, so ANY occluder
    // beyond ~0.29 AU from the camera silently failed to occlude it — a Mercury
    // or Venus transit seen from Earth sits right on that boundary. Luna is far
    // inside it, so this was not the eclipse bug, but it is the same code.
    const vViewZ = varying(float(-1.0), "v_starViewZ");

    // ── Vertex: screen-aligned billboard ──
    m.vertexNode = Fn(() => {
      const viewCenter = cameraViewMatrix.mul(worldCenter);
      const viewPos = viewCenter.add(
        vec4(
          positionGeometry.x.mul(uScale),
          positionGeometry.y.mul(uScale),
          float(0),
          float(0),
        ),
      );
      // 🔑 A uniform scale about the camera origin is a PROJECTIVE NO-OP — view
      // space puts the camera at the origin, so this slides the whole billboard
      // along the camera→star ray and the perspective divide cancels it. The
      // image is unchanged; only the written depth moves, which is the point.
      const shell = vec4(viewPos.xyz.mul(uShellScale), 1.0);
      const clip = cameraProjectionMatrix.mul(shell);
      vViewZ.assign(shell.z);
      return clip;
    })();

    // Explicit logarithmic depth — the custom vertexNode means the renderer's
    // own `positionView` does not describe this billboard's actual geometry, so
    // the depth has to be written by hand. 🔑 Written with three's OWN function
    // so the convention cannot drift from what every other material in the
    // scaled scene writes.
    m.depthNode = viewZToLogarithmicDepth(vViewZ, cameraNear, cameraFar);

    // ── Fragment: the disc. The corona comes from glarePass's eye PSF. ──
    m.fragmentNode = Fn(() => {
      const p = uv().mul(2).sub(1);
      const dist = length(p);

      // 🔑 A SHARP limb, antialiased over ~1 px (uEdgeAA) instead of the old
      // ±15%-of-radius ramp. See uEdgeAA for why the softness belongs to the PSF.
      const discEdge = smoothstep(
        uCoreRatio.add(uEdgeAA),
        max(uCoreRatio.sub(uEdgeAA), float(0)),
        dist,
      );
      const disc = discEdge.mul(uCoreRadiance).mul(uDiscVis);

      // ── Limb darkening (R4) ──────────────────────────────────────────────
      // μ = cos θ = √(1 − (r/R)²) on a sphere; clamped so the AA band outside the
      // disc holds the limb value rather than going imaginary.
      const rNorm = dist.div(max(uCoreRatio, float(1e-6))).min(float(1.0));
      const mu = sqrt(max(float(1.0).sub(rNorm.mul(rNorm)), float(0)));
      const om = float(1.0).sub(mu);
      // I(μ)/I(1) = 1 − a(1−μ) − b(1−μ)², then ×(1/discMeanNorm) so the DISC MEAN
      // is exactly 1 and limb darkening cannot change the star's luminosity.
      const profile = vec3(1.0)
        .sub(uLimbA.mul(om))
        .sub(uLimbB.mul(om).mul(om))
        .mul(uLimbGain)
        .max(vec3(0.0));
      // uLimbScale = 0 collapses it to a flat disc for the A/B.
      const limbRgb = vec3(1.0).add(profile.sub(vec3(1.0)).mul(uLimbScale));

      // ⚠⚠ LEGACY CORONA — dead at uCoronaScale = 0, the default. Reproduced
      // verbatim INCLUDING its D25 bug (LEGACY_OUTER_GLOW_ABS carries no
      // pre-exposure, so its absolute radiance swung with adaptation), because an
      // A/B against a *corrected* old version would compare something that never
      // shipped. Delete this and its constants once the judgement is in.
      const innerR = float(0.35);
      const innerFalloff = clamp(innerR.sub(dist).div(innerR), 0, 1);
      const innerGlow = pow(innerFalloff, float(2.5)).mul(
        uCoreRadiance.mul(float(LEGACY_INNER_GLOW_FRAC)),
      ).mul(uStarVis);
      const outerFalloff = clamp(float(1.0).sub(dist), 0, 1);
      const outerGlow = pow(outerFalloff, float(3.5))
        .mul(float(LEGACY_OUTER_GLOW_ABS))
        .mul(uStarVis);
      const corona = innerGlow.add(outerGlow).mul(uCoronaScale);

      const brightness = disc.add(corona);

      // 🔑 PER-CHANNEL clamp on the ASSEMBLED colour — the tint and the limb
      // profile are both per-channel gains, so this is the only place a cap is
      // correct. See the note on `writeBudget`.
      const color = uStarColor
        .mul(brightness)
        .mul(limbRgb)
        .min(vec3(HALF_FLOAT_WRITE_MAX));

      // Alpha ramps to zero at the quad edge so additive blending adds nothing
      // where the disc is not.
      const alpha = clamp(brightness.mul(0.5), 0, 1);

      return vec4(color, alpha);
    })();

    return m;
  }, [
    uScale, uCoreRatio, uCoreRadiance, uStarColor, uStarVis, uDiscVis,
    uShellScale, uCoronaScale, uLimbA, uLimbB, uLimbGain, uLimbScale, uEdgeAA,
  ]);

  const meshRef = useMemo(() => ({ current: null as THREE.Mesh | null }), []);

  // SimGroup wants a mutable tuple; the prop is readonly.
  const posArray = useMemo(
    () => [positionKm[0], positionKm[1], positionKm[2]] as [number, number, number],
    [positionKm],
  );


  useFrame(() => {
    _shipToStar.set(
      positionKm[0] - worldOrigin.shipPosKm.x,
      positionKm[1] - worldOrigin.shipPosKm.y,
      positionKm[2] - worldOrigin.shipPosKm.z,
    );
    const distKm = _shipToStar.length();
    // ⚠ Floor it. `renderHalfView` works out to exactly RADIUS at any distance
    // where the true size wins — verified down to 1e-3 scaled units — but at
    // distScaled === 0 it is 0 × Infinity = NaN, and one NaN vertex takes the
    // whole quad out. Reachable before worldOrigin's first update.
    const distScaled = Math.max(distKm * 0.001, 1e-6);

    // ── Screen-space geometry ────────────────────────────────────────────────
    // DISC_PX_FLOOR is a rasterisation limit, so drawing-buffer px. `cssH` is only
    // needed by the legacy corona's authored canvas size below.
    const cam = camera as THREE.PerspectiveCamera;
    const fovRad = cam.fov * (Math.PI / 180);
    const cssH = Math.max(window.innerHeight, 1);
    const bufferH = Math.max(gl.getDrawingBufferSize(_bufSize).y, 1);
    // ⚠ Tangent per pixel, NOT the small-angle `fov/height` — 6.9% low at fov 50,
    // and the fourth occurrence of that bug here (StellarPoint.tsx:406).
    // Canonical version: StarField.tsx:759.
    const tanPerBufferPx = (2 * Math.tan(fovRad / 2)) / bufferH;

    // Shell clamp — see SHELL_CLAMP_SCALED. Exactly 1 inside it.
    const shellScale =
      distScaled > SHELL_CLAMP_SCALED ? SHELL_CLAMP_SCALED / distScaled : 1;
    uShellScale.value = shellScale;

    // Eclipse coverage from the occluder registry. The eye/ship offset is ~1e-6 rad
    // at lunar range, four orders below the 5e-3 rad disc, so the ship is the right
    // observer.
    const starVis = sunVisibility(
      worldOrigin.shipPosKm,
      positionKm,
      radiusKm,
      null,
    );
    uStarVis.value = starVis;

    // ── Rendered disc size: max of three limits, flux conserved in all three ──
    const preExp = getPreExposure();
    const discPx = (RADIUS * 2) / distScaled / tanPerBufferPx;
    // What the peak would be if drawn at its true size. Radiance is
    // distance-independent, so this only moves with adaptation.
    const unspreadPeak = discRadiance * preExp;
    // 🔑🔑 THE DISC IS NEVER SPREAD ANY MORE. R3b carries the clipped flux
    // analytically, so size no longer has to be traded for flux at all:
    //   • geometry  → `max(trueSize, DISC_PX_FLOOR)`, nothing else
    //   • flux      → the disc keeps what fits; the rest goes to the eye's PSF
    // An earlier revision spread the disc to fit the half-float budget. MEASURED,
    // that bound at EVERY range (metered EV with the sun in frame is −0.3…−7.7,
    // not the +4…+6 assumed), inflating an 11 px disc to 46 px at 1 AU — which is
    // what made an eclipsed sun render 4.2× wider than Luna — and 0.37 px to
    // 11.8 px at 30 AU. It also made the rendered size a function of adaptation,
    // which rang (flicker at 300 AU) and needed a release follower to damp.
    // Removing it deletes the breathing, the ringing, the follower and the
    // adaptation coupling in one go.
    const renderPx = Math.max(discPx, DISC_PX_FLOOR);

    const fluxScale = subPixelFluxScale(discPx, renderPx);
    // 🔑 BOTH halves sampled HERE, inside useFrame, so both track the live state.
    // ⚠⚠ R7f: the compression is computed from the LIVE illuminance, not passed in
    // as a constant from the star's catalogue magnitude. It used to be a prop, and
    // that was correct only while the sprite field also used a Sol-referenced value.
    // Now that the sprites compress their live illuminance (StarField's vertex
    // node), a constant here would put the two tiers on DIFFERENT rules and the
    // promotion handover would step. `starCompressionForIlluminance` is the one
    // implementation both call.
    const unresolvedGain = applyDisplayLift
      ? getStarLift() *
        starCompressionForIlluminance(illuminanceGameAt(luminositySun, distKm))
      : 1;
    // ── Display gain for an unresolved disc — see `applyDisplayLift` ───────────
    // 🐛 A first version tapered it with a smoothstep in `discPx` over [0, floor].
    // That is NON-MONOTONIC IN DISTANCE: the physical part grows as discPx² while
    // the taper falls by the whole gain over the same interval, so the product
    // peaks mid-way and then DROPS — 3.6 stops for α Cen A, 9.4 for Proxima. The
    // star would visibly dim as you flew toward it.
    //
    // 🔑 Cap instead of taper: the gain may never make a pixel brighter than the
    // star's OWN SURFACE. `1/fluxScale` gives exactly that, because
    // `unspreadPeak · fluxScale · (1/fluxScale)` is `unspreadPeak` — the resolved
    // radiance.
    //
    // ⚠⚠ AND THE GAIN IS RAISED TO `1 − fluxScale`, WHICH IS NOT COSMETIC. A plain
    // `min(G, 1/fluxScale)` is only safe while G > 1, and R7f's live compression
    // makes G ≪ 1 for any star bright enough to be resolved: C ∝ d^0.8, so
    // approaching α Cen A at the lift floor gives G = 4.1e-3 at 1 AU and 1.8e-4 at
    // 0.02 AU. MEASURED: the plain form would DIM that resolved disc by 7.92 and
    // 12.43 stops — the 0.02 AU pose is the one the author already validated limb
    // darkening at. The sun is worse still: 7.66 stops at 1 AU.
    //
    // ⚠ A `max(1, G)` floor was the obvious fix and it is WRONG, because it applies
    // to the promoted catalogue star too and so reinstates exactly the cross-tier
    // mismatch R2b exists to prevent: MEASURED 2.86 stops at the α Cen A/B
    // promotion swap (80 AU) and 3.46 stops with the lift off — the latter being,
    // to three digits, the historic figure `starVisibility` records as the cost of
    // wiring only one of the two gains.
    //
    // `pow(G, 1 − fluxScale)` is the resolution-gated form and it is exactly 1 where
    // it has to be: `fluxScale = 1` iff the disc is resolved, so the exponent is 0
    // and the gain is 1 whatever G is; `fluxScale → 0` gives the sprite's own G, so
    // the tiers agree. MEASURED: monotone in rendered FLUX across a 1.25×-step
    // ladder from 0.5 AU to 6 ly at lift ∈ {1, 1024, 65536}, and the 80 AU swap step
    // collapses from 2.86 stops to 0.016.
    const gain =
      unresolvedGain === 1
        ? 1
        : Math.min(
            Math.pow(unresolvedGain, 1 - fluxScale),
            1 / Math.max(fluxScale, 1e-30),
          );

    // Flux conservation: radiance ÷ the area ratio. Exactly 1 when renderPx ===
    // discPx, so the resolved case is untouched.
    uCoreRadiance.value = unspreadPeak * fluxScale * gain;

    // ── Quad size ─────────────────────────────────────────────────────────────
    const legacyCorona = getStarCoronaScale();
    uCoronaScale.value = legacyCorona;
    // View-space half-extent of the RENDERED disc.
    const renderHalfView = distScaled * (renderPx / 2) * tanPerBufferPx;
    let halfExtent: number;
    if (legacyCorona > 0) {
      // ⚠ LEGACY ONLY: the corona needs its old oversized canvas, or the A/B
      // would compare the old falloff on a new footprint and mean nothing.
      const minAngle = (LEGACY_MIN_SCREEN_PX / cssH) * fovRad;
      halfExtent = Math.max(
        RADIUS * LEGACY_GLOW_PAD,
        distScaled * Math.tan(minAngle * 0.5),
      );
      uCoreRatio.value = renderHalfView / halfExtent;
    } else {
      halfExtent = renderHalfView * DISC_AA_PAD;
      uCoreRatio.value = 1 / DISC_AA_PAD;
    }
    uScale.value = halfExtent * 2; // PlaneGeometry spans ±0.5
    // Limb AA in `dist` units: derived from the QUAD's pixel radius so it is right
    // in both the normal and the legacy-corona branch.
    const quadRadiusPx = halfExtent / distScaled / tanPerBufferPx;
    uEdgeAA.value = EDGE_AA_PX / Math.max(quadRadiusPx, 1e-6);
    const limbScale = getStarLimbScale();
    uLimbScale.value = limbScale;

    // ── Occlusion hand-off ────────────────────────────────────────────────────
    // ⚠⚠ TWO MECHANISMS ATTENUATE THIS DISC AND THEY MULTIPLY. `depthTest` is on
    // (only depthWrite is off), so occluders that wrote depth already remove
    // fragments; multiplying `starVis` on top double-counts — the failure the
    // D34c comment above says must not happen. A binary switch also flipped on
    // `renderPx > discPx`, which moves with ADAPTATION, so a transit's brightness
    // jumped by 1/starVis between frames.
    //
    // 🔑 An occluder covering fraction c of the TRUE disc covers ≈ c·f of the
    // DRAWN disc, where f = (discPx/renderPx)² is the true disc's area share. So
    // depth already delivers (1 − c·f) and the factor still needed is
    //     (1 − c) / (1 − c·f) = starVis / (1 − (1−starVis)·f)
    // Exact under that approximation, continuous in f, and it reduces correctly at
    // both ends: f→1 gives 1 (depth owns it), f→0 gives starVis (analytic owns
    // it). It can never exceed 1, since 1 − c·f ≥ 1 − c = starVis.
    const trueAreaShare = renderPx > 0 ? Math.min(1, (discPx / renderPx) ** 2) : 0;
    // ⚠ Beyond the shell clamp an occluder past the clamp radius is not depth-
    // ordered against the pulled-in star at all, so depth contributes nothing and
    // the analytic factor must be applied whole.
    uDiscVis.value =
      shellScale < 1
        ? starVis
        : starVis / Math.max(1e-6, 1 - (1 - starVis) * trueAreaShare);

    // ── R3b: hand the CLIPPED flux to the glare pass analytically ─────────────
    // The shader's guard discards everything above `writeBudget`, which the
    // pyramid therefore never sees. Reconstruct exactly how much and give it to
    // the eye's PSF in closed form. Zero whenever nothing is clipped, so this is a
    // no-op in the sub-pixel regime where flux is already conserved.
    const rDrawPx = renderPx * 0.5;
    const aaFracR = uEdgeAA.value / Math.max(uCoreRatio.value, 1e-6);
    // ⚠ PER CHANNEL, because both the clamp and the limb profile are per channel:
    // the clipped flux is redder or bluer than the star depending on which channel
    // saturated hardest, and the analytic PSF has to carry that colour.
    let trueFlux = 0;
    let writtenFlux = 0;
    // ⚠ `primary` ONLY. Every consumer of the result below is already gated on
    // `primary` (one uniform holds one star), so for a promoted disc this was 3
    // channels × 2 integrals × 96 steps = 576 iterations computed and discarded
    // every frame — and R7d's pool of 2 doubled that. Wire the second slot before
    // removing this guard, not after.
    for (let ch = 0; primary && ch < 3; ch++) {
      const t = discChannelFlux(
        uCoreRadiance.value, starRgb[ch], limb.a[ch], limb.b[ch],
        1 / limb.discMeanNorm[ch], limbScale, Infinity, rDrawPx, aaFracR,
      );
      const w = discChannelFlux(
        uCoreRadiance.value, starRgb[ch], limb.a[ch], limb.b[ch],
        1 / limb.discMeanNorm[ch], limbScale, writeBudget, rDrawPx, aaFracR,
      );
      // × starVis: an occluded star scatters less. ⚠ The ONLY attenuation available
      // here — the analytic term is not depth-tested, so unlike the disc it cannot
      // be occluded geometrically.
      _deficitRgb[ch] = Math.max(0, t - w) * starVis;
      trueFlux += t;
      writtenFlux += w;
    }
    // ⚠ A FLUX ratio from the integrals, NOT `writeBudget / peak`. The peak ratio
    // read 0.1244 at 1 AU where the true flux fraction was 0.1518, because part of
    // the soft limb sits under the cap. Measure what you name.
    const fluxKept = trueFlux > 0 ? Math.min(1, writtenFlux / trueFlux) : 1;
    // Luminance-weighted, because this is what the exposure meter's pedestal and
    // the status readout want as a single number.
    const deficitFlux =
      0.2126 * _deficitRgb[0] + 0.7152 * _deficitRgb[1] + 0.0722 * _deficitRgb[2];

    // View-space direction → NDC. Only fov/aspect are needed, and `discPx` above
    // already validates them against measurement.
    camera.getWorldQuaternion(_camQuat);
    _view
      .set(_shipToStar.x, _shipToStar.y, _shipToStar.z)
      .multiplyScalar(0.001)
      .applyQuaternion(_camQuat.invert());
    const forward = -_view.z; // the camera looks down −z
    const tanHalf = Math.tan(fovRad / 2);
    const bufferW = Math.max(_bufSize.x, 1);
    const aspect = bufferW / bufferH;
    // ⚠ `primary` only: one uniform holds one star, so with a second star mounted
    // (R2b) the last writer would win. Gate it rather than leave that racy.
    if (primary && deficitFlux > 0 && forward > 0 && getStarPointGlareEnabled()) {
      const ndcX = _view.x / forward / (tanHalf * aspect);
      const ndcY = _view.y / forward / tanHalf;
      const uvX = (ndcX + 1) * 0.5;
      const uvY = getStarGlareFlipY() ? (1 - ndcY) * 0.5 : (ndcY + 1) * 0.5;
      // ω_px = tanPerPx² sr/px, so deficit(value·px²) × ω_px / ∫PdΩ(PSF·sr) is a
      // buffer value once multiplied by the raw PSF. The straylight fraction is
      // applied in the shader so this obeys the player's glare setting.
      // ⚠ No `starRgb` multiply here — `_deficitRgb` already carries the star's
      // colour AND the limb profile's own reddening of the clipped part.
      const k =
        (tanPerBufferPx * tanPerBufferPx) / Math.max(getGlarePsfEnergy(), 1e-30);
      setStarPointGlare(
        uvX,
        uvY,
        [_deficitRgb[0] * k, _deficitRgb[1] * k, _deficitRgb[2] * k],
        tanPerBufferPx,
        bufferW,
        bufferH,
        deficitFlux,
        // 🔑 The star's OWN angular radius, in degrees — the PSF must not be
        // evaluated inside the source. `atan`, not the small-angle form: at 0.1 AU
        // Sol subtends 2.67°, where the two differ.
        (Math.atan(RADIUS / distScaled) * 180) / Math.PI,
        // Scalar luminance the disc actually wrote — the reference the occlusion
        // probe compares the composited frame against. `uStarColor` is
        // luminance-normalised, so the colour multiply does not change this.
        Math.min(uCoreRadiance.value, writeBudget),
      );
    } else if (primary) {
      clearStarPointGlare();
    }

    if (primary) {
      _status.pointGlareFlux = deficitFlux;
      _status.distAu = distKm / 149_597_870.7;
      _status.distScaled = distScaled;
      _status.discPx = discPx;
      // ⚠ Keyed off the disc's TRUE size vs the rasterisation floor. Keying it off
      // "did any limit inflate the draw" made it report "point" at 1 AU whenever
      // the half-float ceiling bound, which is an adaptation-dependent lie.
      _status.tier = discPx < DISC_PX_FLOOR ? "point" : "disc";
      _status.shellScale = shellScale;
      _status.drawnAtScaled = distScaled * shellScale;
      // ⚠ ALSO divide out `fluxScale · gain`, not just pre-exposure. R7f made the
      // gain ≠ 1 for the primary beyond ~769 AU, so dividing out only pre-exposure
      // would have made this field silently stop being a radiance out there —
      // exactly the "measure what you name" failure this file has been bitten by.
      _status.coreRadianceGame =
        uCoreRadiance.value /
        Math.max(preExp * fluxScale * gain, 1e-30);
      _status.renderPx = renderPx;
      _status.sizedBy = renderPx <= discPx * 1.000001 ? "true" : "pixelFloor";
      _status.fluxKept = fluxKept;
      _status.preExposure = preExp;
      // ⚠ The brightest CHANNEL the shader can write — which now carries TWO
      // per-channel gains, the blackbody tint AND the limb profile's centre boost
      // (~1.27× the disc mean). Reusing the old `scalar × tint` form here would be
      // a fifth instance of this gate naming one quantity and printing its
      // neighbour, and it would under-report exactly where overflow was the risk.
      let peakChannel = 0;
      for (let ch = 0; ch < 3; ch++) {
        const centreGain = 1 + (1 / limb.discMeanNorm[ch] - 1) * limbScale;
        peakChannel = Math.max(
          peakChannel,
          Math.min(uCoreRadiance.value * starRgb[ch] * centreGain, writeBudget),
        );
      }
      _status.writtenPeak = peakChannel;
      _status.writeBudget = writeBudget;
      _status.unspreadPeak = unspreadPeak;
      _status.drawnPeak = uCoreRadiance.value;
      _status.limbRatio[0] = limb.limbRatio[0];
      _status.limbRatio[1] = limb.limbRatio[1];
      _status.limbRatio[2] = limb.limbRatio[2];
      _status.limbScale = limbScale;
      _status.unresolvedGain = gain;
      _status.edgeAaPx = EDGE_AA_PX;
      _status.coronaScale = legacyCorona;
      _status.starVis = starVis;
      _status.clampScaled = SHELL_CLAMP_SCALED;
      _status.farScaled = SCALED_CAMERA_FAR;
      _status.ran = true;
    }
  });

  return (
    <SimGroup space="scaled" positionKm={posArray}>
      <mesh
        ref={(m) => { meshRef.current = m; }}
        geometry={geo}
        material={mat}
        // ⚠ The bounding sphere is PlaneGeometry(1,1)'s 0.707 units at the star
        // centre, but the shader inflates the quad to `uScale` (a 5,570-unit
        // half-extent near the sun). Three culls on the sphere, so the glow
        // popped out whole the moment the centre left the frustum. Same reason
        // StarField and MilkyWaySkybox disable it.
        frustumCulled={false}
      />
    </SimGroup>
  );
}

export default memo(Star);
