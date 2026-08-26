"use client";

// ─────────────────────────────────────────────────────────────────────
// StellarPoint — renders a celestial body as a bright point of light
// when it's too far away to resolve as a disc.
//
// Physics: apparent brightness is computed from the Lambert sphere
// phase function, geometric albedo, planet radius, and inverse-square
// distances to both the sun and the camera.
//
// Rendering: small opaque billboard with alphaHash and minimum screen
// size. The bright HDR core triggers the bloom pipeline for a natural
// glow halo. Uses opaque + alphaHash + depthWrite for correct depth
// occlusion by nearby planet geometry.
//
// Depth: when the renderer uses logarithmicDepthBuffer, THREE.js
// derives log depth from its internal position pipeline — which
// doesn't account for the runtime uniform scaling in our custom
// vertexNode. We fix this by passing clip.w from the vertex shader
// via a varying and computing log depth explicitly in depthNode.
//
// Brightness is normalized so Jupiter at opposition from Earth
// produces a comfortable HDR intensity (~magnitude −2.5).
//
// Usage: place inside the parent planet's <SimGroup> as a sibling
// of the far-LOD billboard mesh. The component is self-contained —
// it manages its own visibility via useFrame.
// ─────────────────────────────────────────────────────────────────────

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
  exp,
  length,
  varying,
  log2,
  cameraFar,
} from "three/tsl";
import { bodyIlluminanceAtCamera, getPreExposure } from "./photometry";
import {
  STAR_PSF_SIGMA_PX,
  psfNormForBuffer,
} from "@/components/Stars/StarField";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { STAR_POSITION_KM } from "@/sim/celestialConstants";

// ── Constants ────────────────────────────────────────────────────────

// Below this projected pixel diameter the planet disc is unresolvable
// and the stellar point takes over.
const STELLAR_PX_THRESHOLD = 8;

/**
 * Disc size at which the crossfade COMPLETES — below this the stellar point carries
 * 100% and the billboard is fully faded out. Set from the measured size at which the
 * billboard stops conserving flux; see `stellarPointFade`.
 */
const STELLAR_PX_SATURATE = 5;

/**
 * The point's crossfade weight, 0 (invisible) → 1 (fully replaces the billboard).
 *
 * ⚠ THE SINGLE SOURCE OF TRUTH, exported so `CelestialBody` can fade the far
 * billboard by exactly `1 − this`. Two places computing "how visible is the point"
 * from their own copy of the pixel-diameter formula is the bug that already cost this
 * work two rounds (`window.innerHeight` vs the drawing buffer). One function, two
 * callers.
 *
 * @param bufferH MUST be the DRAWING-BUFFER height (`gl.getDrawingBufferSize().y`),
 *   not the CSS canvas size — see the note at the call site.
 */
/**
 * Global kill switch for every stellar point, for `__lum.lod()`.
 *
 * 🔑 WHY A TOGGLE RATHER THAN ANOTHER HYPOTHESIS. Below 8 px the billboard and the
 * point both draw, so one flux number cannot say which of them produced it — and
 * three successive theories about that overlap (occlusion, then a non-complementary
 * fade, then a hidden visibility coupling) were each disproved by the next
 * measurement. Sweeping twice, with points on and off, ISOLATES them: the difference
 * between the two runs IS the point's contribution, with nothing inferred.
 */
let _pointsEnabled = true;
export function setStellarPointsEnabled(on: boolean): void {
  _pointsEnabled = on;
}
export const stellarPointsEnabled = (): boolean => _pointsEnabled;

export function stellarPointFade(
  radiusKm: number,
  distKm: number,
  fovRad: number,
  bufferH: number,
): number {
  const px = (((radiusKm * 2) / Math.max(distKm, 1)) / fovRad) * bufferH;
  if (px >= STELLAR_PX_THRESHOLD) return 0;
  // ⚠ SATURATES AT `STELLAR_PX_SATURATE`, not at 0 px. The old curve reached 1 only
  // at a zero-pixel disc, so at 3 px the billboard still held 61% of the weight —
  // while MEASURED as delivering only 0.66 of its own flux, because a 3 px disc cannot
  // be rasterised properly. The crossfade was handing weight to a tier that could no
  // longer carry it.
  //
  // 🔑 Hand over while the billboard is still ACCURATE. Measured (billboard alone,
  // relative to its 9 px value): 0.94 at 6 px, 0.66 at 3 px. So 5 px is the last size
  // it can be trusted at, and the point must own everything below that.
  const t = Math.min(
    1,
    (STELLAR_PX_THRESHOLD - px) / (STELLAR_PX_THRESHOLD - STELLAR_PX_SATURATE),
  );
  return t * t;
}

// Minimum screen diameter (pixels) for the stellar-point billboard.
// Keeps the dot visible even from across the solar system.
/**
 * Sprite width in pixels. ⚠ Must comfortably contain the Gaussian: at σ = 0.85 the
 * half-extent is 4.7σ, holding 0.999984 of the flux. Same value `StarField` uses.
 */
const QUAD_PX = 8;
const MIN_SCREEN_PX = QUAD_PX;

// ── Reusable scratch vectors (safe — useFrame callbacks are sequential) ──
const _bufSize = new THREE.Vector2();
const _shipToBody = new THREE.Vector3();
const _bodyToSun = new THREE.Vector3();
const _bodyToCam = new THREE.Vector3();

// ── Types ────────────────────────────────────────────────────────────

export type StellarPointProps = {
  /** Body position in km (for brightness computation). */
  positionKm: [number, number, number];
  /** Sun position in km. Defaults to Sol. */
  sunPositionKm?: [number, number, number];
  /** Body radius in km. */
  radiusKm: number;
  /** Geometric albedo (0–1). Determines opposition brightness. */
  geometricAlbedo: number;
  /**
   * Characteristic point-source color [r, g, b] in 0–1 range.
   * Should approximate the body's naked-eye colour — typically
   * a desaturated tint of the surface/cloud albedo.
   */
  color: readonly [number, number, number];
};

// ── Component ────────────────────────────────────────────────────────

function StellarPoint({
  positionKm,
  sunPositionKm = STAR_POSITION_KM,
  radiusKm,
  geometricAlbedo,
  color,
}: StellarPointProps) {
  const worldOrigin = useWorldOrigin();
  const camera = useThree((s) => s.camera);
  // ⚠⚠ THE DRAWING-BUFFER HEIGHT — via `gl.getDrawingBufferSize()`, the SAME source
  // `StarField` uses (whose gate validates to 0.999×). Two sub-pixel-source renderers
  // must not disagree about what a pixel is.
  //
  // This was `window.innerHeight` — CSS pixels — while rasterisation happens in
  // device pixels. At devicePixelRatio 1.8 that made `MIN_SCREEN_PX = 6` a 10.8-device-px
  // sprite, fired the `pixelDiameter < 8` gate at 14.4 device px (so the point
  // crossfaded in far earlier than the fade curve assumes and overlapped the billboard
  // for much longer), and solved θ_h — hence the flux normalisation — for a sprite
  // 1.8× the real one, a 3.24× error.
  //
  // 🐛 ⚠ AND THE FIRST FIX WAS A NO-OP: I replaced it with `useThree(s => s.size.height)`,
  // which in R3F is the **CSS canvas size**, not the drawing buffer — one CSS source
  // swapped for another. It was caught only because the gate returned numbers
  // IDENTICAL to the pre-fix run, digit for digit. 🔑 A fix that changes nothing
  // measurable did not fix anything; identical readings are evidence, not noise.
  const gl = useThree((s) => s.gl);

  // Billboard half-extent (scaled units). Updated per frame.
  const uScale = useMemo(() => uniform(0.001), []);
  // HDR intensity multiplier. Updated per frame from physics.
  const uBrightness = useMemo(() => uniform(0.0), []);
  // Planet tint colour (constant per body).
  // ⚠ LUMINANCE-NORMALISED, so the colour carries HUE ONLY and `illumGame` stays the
  // single authority on brightness. Jupiter's `[0.90, 0.83, 0.65]` has luma 0.832, so
  // un-normalised it silently dimmed the point by 17% — and the darker a body's tint,
  // the more flux it lost, which is a per-body error masquerading as a global one.
  // `StarField` normalises its blackbody colours for exactly this reason.
  const uColor = useMemo(
    () => {
      const luma =
        0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
      const k = luma > 1e-6 ? 1 / luma : 1;
      return uniform(
        new THREE.Vector3(color[0] * k, color[1] * k, color[2] * k),
      );
    },
    // Color is constant per planet — individual element deps avoid
    // reference-equality issues with tuple props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [color[0], color[1], color[2]],
  );

  const geo = useMemo(() => new THREE.PlaneGeometry(1, 1), []);

  const mat = useMemo(() => {
    const m = new NodeMaterial();
    m.side = THREE.DoubleSide;
    // ── ⚠⚠ ADDITIVE, NOT OPAQUE. This is the whole crossfade bug ──────────────
    // MEASURED by sweeping with the point disabled and enabled: at a 7.5 px disc the
    // far billboard alone carries 0.69 of the expected flux, and switching the point ON
    // drops the total to 0.044 — the point DESTROYS 15.6× of the flux it is supposed to
    // be adding.
    //
    // 🔑 `depthWrite = false` did NOT fix it, and that ruled out occlusion and named the
    // real cause: with `transparent = false` there is NO BLENDING, so the point's
    // fragments OVERWRITE the billboard's colour. At 7.5 px the point carries
    // `fade = 0.0039` of the flux and replaces a full-strength billboard with it.
    //
    // One/One additive is what `StarField` uses for exactly this reason, and its gate
    // validates to 0.999×. Two sprites representing the same light must SUM.
    //
    // ⚠ `alphaHash` is dropped with it: it existed to give an opaque sprite a soft edge,
    // but it stochastically DISCARDS ~10% of the energy, and additive blending gets the
    // soft edge from the profile itself. It would also break the flux normalisation,
    // since `STELLAR_POINT_PROFILE_INTEGRAL` is the integral of the profile with no
    // discard. ⚠ AdditiveBlending is NOT used — it is SrcAlpha/One, which would multiply
    // by alpha and halve the flux (the exact bug the star gate caught).
    //
    // depthTest stays ON so real geometry hides the point; depthWrite stays OFF so it
    // cannot occlude the billboard it is blending with; renderOrder puts it AFTER the
    // billboard, which is required — an additive sprite drawn before an opaque one is
    // simply overwritten.
    m.depthWrite = false;
    m.transparent = false;
    m.blending = THREE.CustomBlending;
    m.blendSrc = THREE.OneFactor;
    m.blendDst = THREE.OneFactor;
    m.blendEquation = THREE.AddEquation;

    const worldCenter = modelWorldMatrix.mul(vec4(0, 0, 0, 1));

    // Varying to forward clip W to the fragment shader for log depth.
    const vLogZ = varying(float(1.0), "v_stellarLogZ");

    // ── Vertex: view-aligned billboard scaled by uniform ──
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
      const clip = cameraProjectionMatrix.mul(viewPos);
      // Pass W+1 for logarithmic depth — must match THREE.js internal
      // formula: gl_FragDepth = log2(w+1) * 2/(log2(far+1)) * 0.5
      vLogZ.assign(clip.w.add(1.0));
      return clip;
    })();

    // Explicit logarithmic depth output. Without this, the renderer's
    // log depth uses the internal position pipeline which doesn't see
    // the uniform scaling applied in our custom vertexNode.
    const logDepthBufFC = float(2.0).div(log2(cameraFar.add(1.0)));
    m.depthNode = log2(vLogZ).mul(logDepthBufFC).mul(0.5);

    // ── Fragment: bright HDR core, alpha falls off for alphaHash ──
    m.fragmentNode = Fn(() => {
      // ── GAUSSIAN PSF, the same one `StarField` uses ────────────────────────
      // ⚠ WAS `core + halo` — `clamp((0.2−r)/0.2)^1.2 + 0.4·clamp((0.6−r)/0.6)^2.5` —
      // and it lost **47% of its flux to undersampling**. MEASURED: the point carried
      // 0.527 of the expected flux. Its `core` term spans 0.2 × 3 px = **0.6 px
      // radius**, i.e. SUB-PIXEL, while carrying **38%** of the profile's integral, so
      // the rasteriser cannot sample it at all: drop the core entirely and you predict
      // 0.617, which brackets the measurement.
      //
      // 🔑 A sub-pixel planet and a star are the same physical problem, and `StarField`
      // already solved it: a Gaussian at σ = 0.85 px is FWHM 2.0, i.e. critically
      // sampled, and its flux gate reads 0.999×. The peak/flux "inconsistency" that
      // pointed here was itself a sampling artefact — aiming dead-centre lands on a
      // pixel CORNER for an even buffer, and half a pixel off the old core reads 0.29
      // against a peak of 1.4.
      //
      // Over the 8 px quad the Gaussian's half-extent is 4.7σ, containing 0.999984 of
      // the flux — so truncation is not a factor.
      const p = uv().mul(2).sub(1);
      const rPx = length(p).mul(float(QUAD_PX * 0.5));
      const g = exp(
        rPx.mul(rPx).div(float(-2 * STAR_PSF_SIGMA_PX * STAR_PSF_SIGMA_PX)),
      );
      const dist = length(p);
      const intensity = g.mul(uBrightness);
      const col = uColor.mul(intensity);

      // Alpha is unused now: One/One additive blending ignores it, and `alphaHash`
      // is gone (it discarded ~10% of the energy the normalisation assumes is there).
      // The soft edge comes from the Gaussian itself.
      return vec4(col, 1.0);
    })();

    return m;
  }, [uScale, uBrightness, uColor]);

  const meshRef = useMemo(() => ({ current: null as THREE.Mesh | null }), []);

  useFrame(() => {
    // ── Distance from camera (ship) to body ──
    _shipToBody.set(
      positionKm[0] - worldOrigin.shipPosKm.x,
      positionKm[1] - worldOrigin.shipPosKm.y,
      positionKm[2] - worldOrigin.shipPosKm.z,
    );
    const distKm = _shipToBody.length();
    if (distKm < 1) {
      if (meshRef.current) meshRef.current.visible = false;
      return;
    }

    // ── Projected pixel diameter of the planet disc ──
    const cam = camera as THREE.PerspectiveCamera;
    const fovRad = cam.fov * (Math.PI / 180);
    const screenH = Math.max(gl.getDrawingBufferSize(_bufSize).y, 1);
    const angularDiameter = (radiusKm * 2) / distKm;
    const pixelDiameter = (angularDiameter / fovRad) * screenH;

    // Only show when the disc is too small to resolve.
    const visible = _pointsEnabled && pixelDiameter < STELLAR_PX_THRESHOLD;
    if (meshRef.current) meshRef.current.visible = visible;
    if (!visible) return;

    // ── Phase angle (sun–body–camera) ──
    _bodyToSun.set(
      sunPositionKm[0] - positionKm[0],
      sunPositionKm[1] - positionKm[1],
      sunPositionKm[2] - positionKm[2],
    );
    // Camera is at the ship position → body-to-camera = −(ship-to-body)
    _bodyToCam.copy(_shipToBody).negate();

    const dSunKm = _bodyToSun.length();
    const cosPhase = _bodyToSun.normalize().dot(_bodyToCam.normalize());
    const phaseAngle = Math.acos(Math.max(-1, Math.min(1, cosPhase)));

    // Lambert sphere phase function:
    //   Φ(α) = (1/π) × [(π − α) cos α + sin α]
    // At opposition (α = 0): Φ = 1 (by definition with geometric albedo).
    // At quadrature (α = π/2): Φ ≈ 0.318.
    // At superior conjunction (α = π): Φ = 0 (fully shadowed).
    const phase =
      (1 / Math.PI) *
      ((Math.PI - phaseAngle) * Math.cos(phaseAngle) +
        Math.sin(phaseAngle));

    // ── Illuminance this body delivers at the camera, ABSOLUTE game units ──────
    // Phase 4 / D06. Was `(flux / JUPITER_REF_FLUX) × REFERENCE_HDR` — a ratio to an
    // arbitrary Jupiter reference with a hand-picked 12.0 on the end, which put this
    // tier on a different scale from the billboard and the sphere and is precisely
    // what made the handoff discontinuous.
    //
    // 🔑 The old `flux = p·R²·Φ/(d_sun²·d_cam²)` was ALREADY the right shape — only
    // the solar constant was missing. `bodyIlluminanceAtCamera` is that expression
    // with `E_sun(d_sun)` in it, derived as `E_cam = L·Ω` from `L = p·Φ·E_sun/π` and
    // `Ω = π(R/d_cam)²`, the π's cancelling.
    const illumGame = bodyIlluminanceAtCamera(
      geometricAlbedo,
      phase,
      radiusKm,
      dSunKm,
      distKm,
    );

    // ── Smooth fade-in ─────────────────────────────────────────────
    // Quadratic ease-in over the full threshold range. This keeps the
    // stellar point very dim when the billboard is still a few visible
    // pixels, and ramps aggressively only once it's truly sub-pixel.
    //
    //   8px → fade = 0        (invisible)
    //   6px → fade = 0.0625   (barely there — matches fading billboard)
    //   4px → fade = 0.25
    //   2px → fade = 0.5625
    //   0px → fade = 1.0      (full brightness)
    const fade = stellarPointFade(radiusKm, distKm, fovRad, screenH);

    // ── Billboard size: guarantee minimum screen pixels ──────────────────────
    // ⚠ COMPUTED BEFORE the radiance below, because the radiance DEPENDS on it: the
    // sprite is a fixed PIXEL size, so its solid angle — and hence the radiance needed
    // to carry a given flux — changes with resolution and FOV.
    const distScaled = distKm * 0.001; // km → scaled units
    // ⚠⚠ `tanPerPx`, NOT `angle/fovRad × screenH`. A perspective projection is linear
    // in **tan**(angle), not in the angle. The small-angle form made the sprite
    // `2·fovRad/tan(fov/2) = 3.412` px across instead of 4 — a factor of **0.853** at
    // 75° FOV — and since the fragment's `rPx` assumes the quad edge is 4 px, the
    // rendered Gaussian's effective σ was 0.85 × 0.853 = 0.725 px. Flux goes as σ², so
    // **0.728 of it was lost**, measured.
    //
    // 🔑 THIS IS THE THIRD TIME THIS EXACT BUG HAS APPEARED: `pxAngle = fov/height` in
    // the star gate (0.4% at 10°, 14.7% at 75°), the cube-capture flux factor I first
    // quoted as 50× instead of 85.5×, and now here. `StarField` derives BOTH its quad
    // size and its PSF normalisation from one `tanPerPx` so they cannot disagree; this
    // now does the same.
    const tanPerPx = (2 * Math.tan(fovRad / 2)) / screenH;
    const minHalf = distScaled * (MIN_SCREEN_PX * 0.5) * tanPerPx;
    uScale.value = minHalf * 2; // PlaneGeometry spans ±0.5

    // ── Illuminance → sprite radiance, flux-conserving ────────────────────────
    // `E / (θ_h² · I)` — the same shape `StarField` uses for stars, whose gate
    // validates it to 0.999×. A stellar point IS a star-like sub-pixel source, so it
    // shares the machinery instead of carrying a second, unvalidated derivation.
    //
    // ⚠⚠ THE OLD CODE HAD NO RESOLUTION TERM AT ALL. `REFERENCE_HDR` was a constant
    // while correct radiance goes as 1/θ_h², so distant planets' flux depended on
    // window size. MEASURED for Jupiter at 5.2 AU sun / 4.2 AU camera: correct
    // `uBrightness` is 1.156e-2 at 1783p and 4.24e-3 at 1080p against the shipped
    // 12.0 — **1,038× and 2,830× too bright**. Same defect class as D31's metering and
    // the star gate's `pxAngle = fov/height` bug.
    //
    // × preExposure (D25) LAST. ⚠ NO CLAMP any more: the old `500` ceiling existed
    // only because the scale was arbitrary, and an absolute cap on a physically
    // derived quantity would silently re-break the invariance it was written to
    // protect (the HALF_FLOAT_WRITE_MAX trap in LIGHTING_PLAN's D25 section).
    // `E × 1/(2πσ²·Ω_pixel)` — StarField's validated conversion, shared rather than
    // re-derived. Replaces `stellarPointRadiance`, whose profile integral was correct
    // for a shape the rasteriser could not sample.
    uBrightness.value =
      illumGame * psfNormForBuffer(fovRad, screenH) * fade * getPreExposure();
    // (`psfNormForBuffer` derives the same `tanPerPx`, so the sprite's size and its
    // amplitude now come from one quantity — the invariant that makes flux conserved.)
  });

  return (
    <mesh
      ref={(m) => {
        meshRef.current = m;
      }}
      geometry={geo}
      material={mat}
      /* After the far billboard (renderOrder 0): an additive sprite drawn BEFORE an
         opaque one is simply overwritten. */
      renderOrder={1}
      visible={false}
    />
  );
}

export default memo(StellarPoint);
