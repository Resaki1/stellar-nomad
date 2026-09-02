"use client";

import { memo, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { NodeMaterial } from "three/webgpu";
import {
  Fn,
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
import { discRadianceGame } from "@/components/space/starPhysics";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { sunVisibility } from "@/components/space/sunOcclusion";
import { SCALED_CAMERA_FAR } from "@/components/space/cameraPlanes";
import {
  getStarCoronaScale,
  starLodStatus as _status,
} from "@/components/space/starLodStatus";

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
};

// ── Reusable vectors ──
const _shipToStar = new THREE.Vector3();
const _bufSize = new THREE.Vector2();

// ─────────────────────────────────────────────────────────────────────
// A single view-space billboard at all distances, carrying ONLY the disc. The
// corona is not drawn here — it is produced by the eye's PSF in glarePass.ts,
// which is calibrated straylight rather than an authored falloff.
//
// 🔑 THE DISC'S RENDERED SIZE IS `max` OF THREE LIMITS, and its radiance is
// always `trueFlux / renderedArea`, so flux is conserved by construction in all
// three regimes:
//   1. its TRUE angular size                       — the normal case
//   2. DISC_PX_FLOOR, the rasterisation floor      — below ~2 px a fragment
//      either samples the disc or misses it, so a physical radiance strobes
//   3. the HALF-FLOAT CEILING                      — `radiance × preExposure`
//      must stay under 60,000 or the write becomes Inf → NaN downstream
// Limit 3 is what the old `HALF_FLOAT_WRITE_MAX` clamp used to handle by
// DISCARDING flux (P8d: the glare read a clipped buffer). Spreading instead of
// clipping keeps the flux, so the glare is driven correctly with no separate
// splat path. Only the disc's apparent SIZE is approximate, and only in a regime
// where it was already clipping to a flat white blob.
// ─────────────────────────────────────────────────────────────────────

const LEGACY_GLOW_PAD = 8;

// ⚠⚠ LEGACY, GATED OFF (starLodStatus.getStarCoronaScale). These four constants
// are the hand-authored corona from the bloom era. Phase 8 replaced bloom with a
// calibrated eye PSF (glarePass.ts) and nobody deleted the fake corona it made
// redundant. MEASURED: beyond ~5 AU it carries 5.3× the star's entire physical
// flux, because MIN_SCREEN_PX pins the billboard at ~42 buffer px while the disc
// shrinks to the 2.5 px floor — so it lied to the glare pass AND the exposure
// meter. Kept only for the runtime A/B; delete once judged.
const LEGACY_MIN_SCREEN_PX = 60;

// ── Shell clamp (R1, docs/STAR_RENDERING_PLAN.md) ────────────────────────────
// Beyond this range the billboard is pulled along the camera→star ray so it sits
// inside the far plane; without it the star is culled/clipped past `far / cos θ`
// (13.37 AU at frame centre, ~18 AU at the corner) — the sun vanishing past
// Saturn. DERIVED from the far plane so the two cannot drift apart.
const SHELL_CLAMP_FRACTION = 0.6;
const SHELL_CLAMP_SCALED = SCALED_CAMERA_FAR * SHELL_CLAMP_FRACTION;


// ── Disc radiance (Phase 3b) ─────────────────────────────────────────────────
// Was `CORE_HDR = 4096`, justified as "above bloom threshold but moderate enough
// that sub-pixel drift doesn't cause visible bloom flicker". The physical value
// is ≈311,000 game units (starPhysics.discRadianceGame) — **76× higher** — and it is
// distance-INDEPENDENT, because a surface's radiance does not fall off with
// range (only its solid angle does).
//
// The old comment's worry was real, and it is handled properly now rather than
// by under-writing the number: below PX_FLOOR the disc is sub-pixel and cannot be
// rasterised honestly (a fragment either samples it or misses → violent
// flicker), so it is drawn at the floor size with its radiance divided by the
// area ratio. Flux is conserved; only the shape is approximate. Same trick
// StellarPoint already uses.
const DISC_PX_FLOOR = 2.5;
// Glow magnitudes stay RELATIVE to the disc, as before (0.3 / a fixed 8), so the
// star's shape is unchanged — only its absolute level is corrected.
const LEGACY_INNER_GLOW_FRAC = 0.3;
const LEGACY_OUTER_GLOW_ABS = 8.0;

/**
 * Quad radius as a multiple of the rendered disc radius — just an antialiasing
 * margin now that the corona is gone, so `uCoreRatio` is the constant `1/PAD`
 * whenever the corona is off. Must exceed the smoothstep's outer edge (1.15).
 */
const DISC_AA_PAD = 1.4;

function Star({
  positionKm,
  radiusKm,
  tempK,
  luminositySun,
  primary = true,
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
  const uScale = useMemo(() => uniform(RADIUS * DISC_AA_PAD), [RADIUS]);
  // Fraction of the quad's radius that is the disc. Constant `1/DISC_AA_PAD`
  // while the corona is off; the legacy path drives it per frame.
  const uCoreRatio = useMemo(() => uniform(1 / DISC_AA_PAD), []);
  // Disc radiance, game units. Physical while the disc resolves; flux-conserving
  // below DISC_PX_FLOOR.
  const uCoreRadiance = useMemo(() => uniform(discRadiance), [discRadiance]);
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
  const uStarColor = useMemo(() => {
    const [r, g, b] = blackbodyLinearSrgb(tempK);
    return uniform(new THREE.Color(r, g, b));
  }, [tempK]);
  /**
   * 🐛🐛 THE WRITE BUDGET IS PER-CHANNEL, NOT PER-LUMINANCE.
   *
   * `uStarColor` is LUMINANCE-normalised, so its brightest channel exceeds 1:
   * Sol (5772 K) is [1.1103, 0.9761, 0.9119]. Capping the scalar brightness at
   * 60,000 and *then* multiplying wrote R = 66,618 — above half-float's 65,504
   * finite max, so the disc's interior stored **+Inf**. That is the exact trap
   * `preExposedEmissive.ts` documents: an absolute cap applied BEFORE a scale is
   * not a cap at all. Worse for other temperatures: 3000 K needs 37,332 and
   * 30,000 K needs 33,082 (its overflow is in BLUE).
   *
   * ⚠ It only became reachable when the hardcoded `vec3(1, 0.95, 0.9)` (max 1.0)
   * was replaced by the blackbody, and it became the *designed* steady state when
   * the half-float ceiling started parking the write at exactly the cap.
   * Consequences were not cosmetic: glarePass has no threshold and its 13-tap
   * pyramid propagates Inf to every mip, so `mix(scene, PSF, k)` returns Inf for
   * the WHOLE frame; and exposureMeter rejects non-finite tiles, so the sun was
   * silently dropped from metering.
   *
   * One uniform feeds both the CPU sizing and the GPU guard so they cannot drift.
   */
  const writeBudget = useMemo(() => {
    const [r, g, b] = blackbodyLinearSrgb(tempK);
    return HALF_FLOAT_WRITE_MAX / Math.max(r, g, b, 1e-6);
  }, [tempK]);
  const uWriteBudget = useMemo(() => uniform(writeBudget), [writeBudget]);

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

      // Edge at ±15% of the disc radius — relative, matching the previous
      // behaviour exactly. ⚠ R4 (limb darkening) should make this a fixed PIXEL
      // width; at a resolved 32 px disc this softens ~4.8 px.
      const discEdge = smoothstep(
        uCoreRatio.add(uCoreRatio.mul(0.15)),
        max(uCoreRatio.sub(uCoreRatio.mul(0.15)), float(0)),
        dist,
      );
      const disc = discEdge.mul(uCoreRadiance).mul(uDiscVis);

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

      // 🔑 A GUARD, not the mechanism: the CPU spreads the disc so `uCoreRadiance`
      // already fits. ⚠ Capped at `uWriteBudget`, NOT at HALF_FLOAT_WRITE_MAX —
      // the colour multiply below scales this by up to 1.98, so a luminance cap
      // would overflow a channel. See uWriteBudget.
      const brightness = disc.add(corona).min(uWriteBudget);

      // Blackbody colour from the primary's T_eff (was a hardcoded G2V tint).
      const color = uStarColor.mul(brightness);

      // Alpha ramps to zero at billboard edge so additive blending
      // doesn't add light where there's no glow.
      const alpha = clamp(brightness.mul(0.5), 0, 1);

      return vec4(color, alpha);
    })();

    return m;
  }, [
    uScale, uCoreRatio, uCoreRadiance, uStarColor, uStarVis, uDiscVis,
    uShellScale, uCoronaScale, uWriteBudget,
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
    // 🔑 Limit 3, the half-float ceiling. `value × px²` is the flux, so the size
    // needed to keep the peak in range is `discPx · √(peak / budget)`. This is
    // what replaces P8d's flux-discarding clamp.
    const ceilingPx = discPx * Math.sqrt(Math.max(1, unspreadPeak / writeBudget));
    const renderPx = Math.max(discPx, DISC_PX_FLOOR, ceilingPx);
    // ⚠ NEW ARTEFACT, ACCEPTED: while limit 3 binds, `renderPx` tracks
    // `preExposure`, so the disc's SIZE breathes during an adaptation transient
    // (∝ √preExp). The behaviour it replaces pumped the disc's FLUX instead —
    // worse, because flux feeds back into the exposure meter. `sizedBy` reports
    // which limit won, so `__lum.starGlare()` will say if this ever binds in
    // normal play; if it does, revisit rather than tolerating the breathing.

    // Flux conservation: radiance ÷ the area ratio. Returns exactly 1 when
    // renderPx === discPx, so the normal case is untouched.
    uCoreRadiance.value = unspreadPeak * subPixelFluxScale(discPx, renderPx);

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

    if (primary) {
      _status.distAu = distKm / 149_597_870.7;
      _status.distScaled = distScaled;
      _status.discPx = discPx;
      // ⚠ Keyed off the disc's TRUE size vs the rasterisation floor. Keying it off
      // "did any limit inflate the draw" made it report "point" at 1 AU whenever
      // the half-float ceiling bound, which is an adaptation-dependent lie.
      _status.tier = discPx < DISC_PX_FLOOR ? "point" : "disc";
      _status.shellScale = shellScale;
      _status.drawnAtScaled = distScaled * shellScale;
      _status.coreRadianceGame = uCoreRadiance.value / Math.max(preExp, 1e-30);
      _status.renderPx = renderPx;
      _status.sizedBy =
        renderPx === discPx
          ? "true"
          : ceilingPx >= DISC_PX_FLOOR
            ? "halfFloatCeiling"
            : "pixelFloor";
      _status.preExposure = preExp;
      // ⚠ The TINTED peak — the quantity that actually has to fit in half-float.
      // Reporting the scalar made the gate print "inside half-float range" while
      // the red channel was +Inf.
      _status.writtenPeak =
        Math.min(uCoreRadiance.value, writeBudget) *
        (HALF_FLOAT_WRITE_MAX / writeBudget);
      _status.writeBudget = writeBudget;
      _status.unspreadPeak = unspreadPeak;
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
