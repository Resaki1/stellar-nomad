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
import {
  STAR_POSITION_KM,
  STAR_RADIUS_KM,
  STAR_TEMP_K,
} from "@/sim/celestialConstants";
import {
  blackbodyLinearSrgb,
  HALF_FLOAT_WRITE_MAX,
  SUN_DISC_RADIANCE_GAME,
  subPixelFluxScale,
  getPreExposure,
} from "@/components/space/photometry";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { sunVisibility } from "@/components/space/sunOcclusion";
import { SCALED_CAMERA_FAR } from "@/components/space/cameraPlanes";
import { starLodStatus as _status } from "@/components/space/starLodStatus";

export { STAR_POSITION_KM };

// From the system description (was a duplicated 696_340 literal) so a generated
// system's primary gets its own radius — Phase 3b / §3.0.
const RADIUS_KM = STAR_RADIUS_KM;
const RADIUS = kmToScaledUnits(RADIUS_KM); // 696.34 scaled units

// ── Reusable vectors ──
const _shipToStar = new THREE.Vector3();
const _bufSize = new THREE.Vector2();

// ─────────────────────────────────────────────────────────────────────
// Rendered as a single view-space billboard at all distances.
//
// The billboard size is computed each frame as:
//   max(physicalGlowSize, minimumScreenSize)
//
// "physicalGlowSize" = RADIUS * GLOW_PAD. This gives the correct angular
// size for the star disc (inner portion) with glow padding around it.
// Perspective projection naturally shrinks it with distance.
//
// "minimumScreenSize" kicks in when the physical size would be too few
// pixels on screen (outer solar system). It's computed from the view-space
// depth so the billboard always covers at least MIN_SCREEN_PX pixels.
//
// The fragment shader knows what fraction of the billboard is the real
// star disc (uCoreRatio uniform). It draws:
//   - A bright core at the physically correct radius
//   - A smooth shader-baked glow that extends to the billboard edges
//
// HDR values are moderate (~60) so bloom adds a natural halo without the
// instability that extreme values (4096) cause at low pixel counts.
// The visual quality comes from the shader glow, not from bloom alone.
//
// Additive blending composites cleanly over the background.
// ─────────────────────────────────────────────────────────────────────

// Glow padding multiplier: billboard is this × the star diameter.
// At 8×, the star disc occupies the inner 12.5% of the billboard.
const GLOW_PAD = 8;

// Minimum angular coverage in pixels (diameter). Ensures the billboard
// is large enough from the outer solar system for stable rendering.
// ⚠ CSS pixels — an authored look knob, unlike DISC_PX_FLOOR below which is a
// rasterisation question and uses drawing-buffer pixels.
const MIN_SCREEN_PX = 60;

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
// is SUN_DISC_RADIANCE_GAME ≈ 265,000 — **65× higher** — and it is
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
const INNER_GLOW_FRAC = 0.3;
const OUTER_GLOW_ABS = 8.0;

function Star() {
  const worldOrigin = useWorldOrigin();
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);

  // Billboard half-extent in view-space units. Updated each frame.
  const uScale = useMemo(() => uniform(RADIUS * GLOW_PAD), []);
  // Fraction of billboard radius that is the star disc [0..0.5].
  const uCoreRatio = useMemo(() => uniform(1 / GLOW_PAD), []);
  // Disc radiance, game units. Physical (SUN_DISC_RADIANCE_GAME) while the disc
  // resolves; flux-conserving below DISC_PX_FLOOR — see the constant.
  const uCoreRadiance = useMemo(() => uniform(SUN_DISC_RADIANCE_GAME), []);
  // Shell clamp: 1.0 inside SHELL_CLAMP_SCALED, else SHELL_CLAMP_SCALED/dist.
  const uShellScale = useMemo(() => uniform(1), []);
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
    const [r, g, b] = blackbodyLinearSrgb(STAR_TEMP_K);
    return uniform(new THREE.Color(r, g, b));
  }, []);

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

    // ── Fragment: star disc + baked glow ──
    m.fragmentNode = Fn(() => {
      const p = uv().mul(2).sub(1);
      const dist = length(p);

      // Star disc: flat bright circle at the physically correct radius.
      // Smooth edge to avoid aliasing.
      const discEdge = smoothstep(
        uCoreRatio.add(uCoreRatio.mul(0.15)),
        max(uCoreRatio.sub(uCoreRatio.mul(0.15)), float(0)),
        dist,
      );
      const disc = discEdge.mul(uCoreRadiance).mul(uDiscVis);

      // Inner glow: bright halo just beyond the disc. Falls off with
      // distance² for a concentrated luminous feel.
      const innerR = float(0.35);
      const innerFalloff = clamp(innerR.sub(dist).div(innerR), 0, 1);
      const innerGlow = pow(innerFalloff, float(2.5)).mul(
        uCoreRadiance.mul(float(INNER_GLOW_FRAC)),
      ).mul(uStarVis);

      // Outer glow: wide soft halo extending to billboard edge.
      // Stays above bloom threshold (1.0) for the inner half.
      const outerFalloff = clamp(float(1.0).sub(dist), 0, 1);
      const outerGlow = pow(outerFalloff, float(3.5))
        .mul(float(OUTER_GLOW_ABS))
        .mul(uStarVis);

      // ⚠ CLAMP THE WRITE. 265,000 exceeds RGBA16F's 65,504 finite max, so an
      // unclamped disc stores `Inf` — and Inf survives every filter downstream
      // (bloom's mip chain, TAA, the half-res AP upsample) as NaN, where one bad
      // texel poisons a whole neighbourhood. Clipping is invisible: any exposure
      // that renders 60,000 as other than flat white renders 265,000 the same.
      // ⚠ NOTHING may infer the star's flux from this buffer — read
      // SUN_DISC_RADIANCE_GAME instead (Phase 8's glare depends on that).
      const brightness = disc
        .add(innerGlow)
        .add(outerGlow)
        .min(float(HALF_FLOAT_WRITE_MAX));

      // Blackbody colour from the primary's T_eff (was a hardcoded G2V tint).
      const color = uStarColor.mul(brightness);

      // Alpha ramps to zero at billboard edge so additive blending
      // doesn't add light where there's no glow.
      const alpha = clamp(brightness.mul(0.5), 0, 1);

      return vec4(color, alpha);
    })();

    return m;
  }, [uScale, uCoreRatio, uCoreRadiance, uStarColor, uStarVis, uDiscVis, uShellScale]);

  const meshRef = useMemo(() => ({ current: null as THREE.Mesh | null }), []);

  useFrame(() => {
    _shipToStar.set(
      STAR_POSITION_KM[0] - worldOrigin.shipPosKm.x,
      STAR_POSITION_KM[1] - worldOrigin.shipPosKm.y,
      STAR_POSITION_KM[2] - worldOrigin.shipPosKm.z,
    );
    const distKm = _shipToStar.length();
    const distScaled = distKm * 0.001;

    // ── Screen-space geometry ────────────────────────────────────────────────
    // Two pixel conventions, deliberately: MIN_SCREEN_PX is an authored glow-canvas
    // size in CSS px, DISC_PX_FLOOR is a rasterisation limit in drawing-buffer px.
    // Both end up as view-space lengths, so they compose.
    const cam = camera as THREE.PerspectiveCamera;
    const fovRad = cam.fov * (Math.PI / 180);
    const cssH = Math.max(window.innerHeight, 1);
    const bufferH = Math.max(gl.getDrawingBufferSize(_bufSize).y, 1);
    // ⚠ Tangent per pixel, NOT the small-angle `fov/height` — that form is 6.9%
    // low at fov 50 and has been the same bug three times in this repo
    // (StellarPoint.tsx:406). Canonical version: StarField.tsx:759.
    const tanPerBufferPx = (2 * Math.tan(fovRad / 2)) / bufferH;

    const minAngle = (MIN_SCREEN_PX / cssH) * fovRad;
    const halfExtent = Math.max(RADIUS * GLOW_PAD, distScaled * Math.tan(minAngle * 0.5));
    uScale.value = halfExtent * 2; // PlaneGeometry spans ±0.5
    uCoreRatio.value = RADIUS / halfExtent;

    // Shell clamp — see SHELL_CLAMP_SCALED. Exactly 1 inside it.
    const shellScale =
      distScaled > SHELL_CLAMP_SCALED ? SHELL_CLAMP_SCALED / distScaled : 1;
    uShellScale.value = shellScale;

    // Eclipse coverage from the occluder registry. The eye/ship offset is ~1e-6 rad
    // at lunar range, four orders below the 5e-3 rad disc, so the ship is the right
    // observer.
    const starVis = sunVisibility(
      worldOrigin.shipPosKm,
      STAR_POSITION_KM,
      STAR_RADIUS_KM,
      null,
    );
    uStarVis.value = starVis;

    // ── Sub-pixel flux conservation (Phase 3b) ───────────────────────────────
    // uCoreRatio keeps the disc at its TRUE angular size (MIN_SCREEN_PX only
    // enlarges the glow canvas), so from the outer system it goes genuinely
    // sub-pixel and at 265,000 would strobe — one fragment sample deciding the
    // whole frame. Below the floor, draw at the floor and divide radiance by the
    // area ratio: flux preserved, shape approximate.
    const preExp = getPreExposure();
    const discPx = (RADIUS * 2) / distScaled / tanPerBufferPx;
    const subPixel = discPx < DISC_PX_FLOOR;

    // ⚠ Once clamped, depth order against a body BEYOND the clamp is no longer
    // trustworthy (it would sort behind the pulled-in star), so hand occlusion to
    // the analytic registry. Strictly better than a depth test on a ≤2.5 px disc.
    uDiscVis.value = subPixel || shellScale < 1 ? starVis : 1;

    if (subPixel) {
      uCoreRatio.value =
        (distScaled * (DISC_PX_FLOOR / 2) * tanPerBufferPx) / halfExtent;
      uCoreRadiance.value =
        SUN_DISC_RADIANCE_GAME * subPixelFluxScale(discPx, DISC_PX_FLOOR) * preExp;
    } else {
      uCoreRadiance.value = SUN_DISC_RADIANCE_GAME * preExp;
    }

    _status.distAu = distKm / 149_597_870.7;
    _status.distScaled = distScaled;
    _status.discPx = discPx;
    _status.tier = subPixel ? "point" : "disc";
    _status.shellScale = shellScale;
    _status.drawnAtScaled = distScaled * shellScale;
    _status.coreRadianceGame = uCoreRadiance.value / Math.max(preExp, 1e-30);
    _status.starVis = starVis;
    _status.clampScaled = SHELL_CLAMP_SCALED;
    _status.farScaled = SCALED_CAMERA_FAR;
    _status.ran = true;
  });

  return (
    <SimGroup space="scaled" positionKm={STAR_POSITION_KM}>
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
