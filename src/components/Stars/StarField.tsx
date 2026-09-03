"use client";

/**
 * Catalogue star field — real stars at real magnitudes (STAR_CATALOGUE_PLAN.md, S1;
 * closes D30 in LIGHTING_PLAN.md).
 *
 * 8,920 stars to V ≤ 6.5 from `public/data/stars_visual.bin`, drawn as ONE
 * instanced billboard draw, each with a photometrically derived luminance and a
 * blackbody colour from its B−V index.
 *
 * ── WHY NOT THE PANORAMA ────────────────────────────────────────────────────
 * The panorama's brightest texel measures 3.1e-2 cd/m² where Sirius should be
 * 14.9 — **482× / 6.7 magnitudes too dim** — for two reasons a better texture
 * cannot fix: real Sirius : diffuse Milky Way is 16.9 stops against an 8-bit
 * sRGB's ~8, and a star is a delta function, so in a texture it occupies ≥1
 * texel and its flux is only correct at exactly one viewing FOV. See the plan §1.
 *
 * ── WHY NOT `THREE.Points` ──────────────────────────────────────────────────
 * ⚠ WebGPU has no `gl_PointSize`; point primitives are always 1 px. Hence
 * instanced quads, the same shape `StellarPoint.tsx` uses for planets.
 *
 * ── FLUX CONSERVATION IS THE WHOLE POINT ────────────────────────────────────
 * A star's brightness is a FLUX (illuminance), not a luminance: how bright it
 * renders depends on how many pixels it is spread over, which depends on FOV and
 * resolution. So the sprite carries the star's illuminance and the shader turns
 * that into radiance using the CURRENT pixel solid angle:
 *
 *     E      = 2.54e-6 · 10^(−0.4·m)        lux    (a mag-0 star is 2.54e-6 lux)
 *     ∫L dΩ  = E                                    must hold at any FOV
 *     L(r)   = A · exp(−r²/2σ²)                      Gaussian PSF, r in pixels
 *     ⇒ A    = E / (2πσ² · Ω_pixel)
 *
 * `2πσ²·Ω_pixel` is the PSF's effective solid angle — `uPsfNorm` below is its
 * reciprocal. Getting this wrong is invisible at one resolution and wrong at
 * every other, which is exactly the bug D31 was.
 *
 * ⚠ A single-pixel probe therefore reads the PEAK, not E/Ω_pixel. For σ = 1 px,
 * Sirius peaks at 14.9/(2π·1²) ≈ 2.4 cd/m² while still carrying the full flux.
 * The plan's §9 gate must be read against the peak or against an integral, never
 * against "flux ÷ one pixel".
 *
 * ── NO STAR-SPECIFIC BLOOM ──────────────────────────────────────────────────
 * Real glare on bright stars comes from the observer's optics (lens striae — why
 * Sirius shows a starburst), not the atmosphere; there is no scintillation in
 * vacuum. Once magnitudes are right, Sirius is 480× a mag-5 star, so the existing
 * global bloom threshold catches only the brightest few on its own. Same lesson
 * as the engine plume: get the photometry right and bloom sorts itself out.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { NodeMaterial } from "three/webgpu";
import {
  Fn,
  attribute,
  cameraProjectionMatrix,
  cameraViewMatrix,
  exp,
  float,
  instanceIndex,
  length,
  modelWorldMatrix,
  pow,
  positionGeometry,
  uniform,
  uv,
  varying,
  vec3,
  vec4,
} from "three/tsl";
import { SKY_CAPTURE_LAYER } from "@/components/space/skySpecular";
import {
  accumulatePointSource,
  setCatalogueSh,
  type ShCoefficients,
} from "@/components/space/skyIrradiance";
import { LY_IN_KM } from "@/sim/units";
import { starLightExcludedRows } from "@/components/space/starLodStatus";
import {
  HALF_FLOAT_WRITE_MAX,
  NITS_PER_GAME_UNIT,
  blackbodyLinearSrgb,
  uPreExposure,
} from "@/components/space/photometry";
// Shared with Star.tsx so the sprite tier and the disc tier cannot disagree about
// a star's temperature (R2 — docs/STAR_RENDERING_PLAN.md §8).
import {
  radiusKmFromCatalogue,
  starParamsUsable,
  temperatureFromBV,
  visualLuminositySun,
} from "@/components/space/starPhysics";
import { uStarLift } from "@/components/space/starVisibility";
import { uSkyCaptureScale } from "@/components/space/skyCaptureEncode";

// Radius the sprites sit at, scaled units. Just inside the panorama's 1e6 so
// stars read in front of the nebulosity, and well inside SCALED_CAMERA_FAR
// (2e6) so nothing is clipped. Parallax within a system is a non-issue because
// origin rebasing keeps the scaled camera near the scaled origin — the same
// reason the panorama can be a fixed sphere at the origin.
const STAR_SHELL_RADIUS = 900_000;

/** Billboard size in PIXELS. Must comfortably contain the Gaussian below. */
const QUAD_PX = 8;
/**
 * PSF width in pixels — a LOOK knob with a hard floor.
 *
 * Smaller reads crisper and more point-like (real stars are point sources; all
 * apparent "size" is observer optics).
 *
 * ⚠ HARD FLOOR: FWHM = 2.355σ, and the critical-sampling rule from astronomical
 * photometry is **FWHM ≥ 2 px, i.e. σ ≥ 0.85**. Below that the brightest pixel
 * depends on where the star falls on the pixel grid — the same aliasing failure D31
 * fixed in the meter, and the reason `__lum.star()` gates on FLUX and not on the
 * peak. It shows up as twinkling, worst on stars near the visibility threshold
 * (they pop in and out rather than merely wobbling), and there is no scintillation
 * in vacuum, so it reads as an obvious artefact. Test any change with a slow pan.
 *
 * 🔑 If stars look too LARGE, reach for `STAR_MAGNITUDE_COMPRESSION` before
 * reaching for σ. Size at the bright end is driven by `STAR_ARTISTIC_GAIN`, and
 * fighting it with σ trades a look problem for a sampling artefact.
 *
 * Flux is conserved automatically: `uPsfNorm` is 1/(2πσ²·Ω_pixel), so shrinking σ
 * makes the star smaller AND proportionally brighter at its peak, leaving the
 * integral — the thing `__lum.star()` gates on — unchanged.
 */
const PSF_SIGMA_PX = 0.85;

/**
 * ── ARTISTIC GAIN — a display knob, deliberately OUTSIDE the physics ──────────
 *
 * Tune this freely for looks. It is applied AFTER the photometric conversion, so
 * the physical layer above stays honest and `__lum.star()` keeps reporting the
 * PHYSICAL ratio (it divides this back out and prints the gain separately).
 *
 * 🔑 Boosting is not "abandoning physics", it is a PERCEPTUAL correction for a
 * viewing condition we cannot reproduce. A dark-adapted eye at ~1e-4 cd/m² sees
 * the sky as clear and structured; an SDR panel driven by a daylight tone curve
 * fundamentally cannot show rod vision. Phase 7 (scotopic + Purkinje, defect D19)
 * is the principled version of this; a flat gain is its crude stand-in.
 *
 * ⚠ NEVER fold a look adjustment into the catalogue, `uPsfNorm`, or the
 * magnitude→illuminance conversion. Mixing art into the physical layer is how a
 * calibrated system quietly stops being calibrated — and the star gate would then
 * happily certify the art instead of the physics.
 *
 * ── ⚠⚠ P7d, 2026-08-30 — REDUCED TO 64, THEN REVERTED. THE REASON MATTERS. ──
 *
 * It was cut to 64 to keep Phase 7's scotopic driver honest, on the argument that a
 * gain inside the written radiance is a lie about luminance. ❌ The author caught it
 * immediately, with the sharpest possible counter-example:
 *
 *   "In real life, from Earth's ground, I can start to see the first bright stars
 *    during sunset and can definitely see multiple stars at twilight. But now I have
 *    to get to the completely dark side of Earth to start seeing stars."
 *
 * That is a REAL physical anchor and the render was failing it. Checked: at nautical
 * twilight the sky is ~0.1 cd/m² and the eye concentrates a mag-2 star into roughly
 * 1 arcmin², giving ~4.75 cd/m² effective — a **47× contrast, obviously visible.**
 *
 * 🔑🔑 **A GAIN ON A POINT SOURCE IS NOT THE SAME KIND OF THING AS A GAIN ON THE
 * SKY, AND CONFLATING THEM WAS THE MISTAKE.** An UNRESOLVED point source has no
 * surface brightness in this renderer: its peak pixel value is entirely a
 * consequence of how many pixels the sprite is spread over. The eye concentrates a
 * star into ~1 arcmin²; we spread it over a sprite whose footprint is set by σ and
 * the display. At 50° over 1080 px **one pixel is already 7.7 arcmin²**:
 *
 *     sprite footprint    solid angle    dilution vs the eye
 *      1 px²                8 arcmin²          8×   (2.9 stops)
 *      4 px²               31 arcmin²         31×   (4.9 stops)
 *     10 px²               77 arcmin²         77×   (6.3 stops)
 *     25 px²              193 arcmin²        193×   (7.6 stops)
 *
 * So a large part of this gain is not "art" at all — it is **compensation for a
 * concentration the renderer physically cannot reproduce**, and `__lum.star()` is
 * blind to it because flux IS conserved; it is the *peak* that is diluted.
 *
 * ⚠ 1024 (10 stops) exceeds the ~6 stops of pure dilution. The remainder covers the
 * adaptation gap — a sunlit hull drags global exposure down far enough to bury a
 * correctly-concentrated star too. Both terms are display-condition-dependent, which
 * is exactly why a fixed constant is crude and why the author's empirically tuned
 * value beats any estimate this comment could offer. **Reverted to 1024.**
 *
 * ⚠⚠ **DO NOT re-couple this to `SKY_ARTISTIC_GAIN`.** A previous note here said to
 * "move them together, their ratio is the calibrated `CATALOGUE_FLUX_SHARE` split" —
 * **that was wrong.** `CATALOGUE_FLUX_SHARE` partitions the sky's FLUX for the SH
 * irradiance bake and has nothing to do with a display-side lift. The sky gain lifts
 * a surface that has a real surface brightness; this one substitutes for a PSF.
 *
 * 🔑 THE PRINCIPLED REPLACEMENT IS PHASE 8, not Phase 7. A real Spencer PSF
 * concentrates a star's flux the way the eye does, at which point the dilution term
 * here goes to 1 by construction. Phase 7 changes hue, not level, and cannot help.
 */
/**
 * ⚠⚠ DEPRECATED (R7b) — no longer applied by this renderer. Replaced by the
 * adaptation-driven `uStarLift` (see `space/starVisibility.ts`), which is 1.0
 * whenever the sky is already visible instead of a flat 1024 always. Retained only
 * so `__lum.starLift("legacy")` can reproduce the old look for comparison.
 */
export const STAR_ARTISTIC_GAIN = 1024.0;

/**
 * ── MAGNITUDE COMPRESSION — the OTHER half of the look, and the one that lets σ
 *    stay above its sampling floor ──────────────────────────────────────────────
 *
 *     m_render = ANCHOR + γ·(m − ANCHOR)          γ = STAR_MAGNITUDE_COMPRESSION
 *
 * γ = 1 is the identity and is short-circuited entirely (the node is not even
 * built), so the default reproduces the uncompressed render exactly.
 *
 * 🔑 WHY THIS EXISTS. `STAR_ARTISTIC_GAIN` is a FLAT lift: it multiplies Sirius by
 * the same factor as a mag-6.5 star. But the reason to lift at all is the FAINT end
 * (stars should stay visible when the hull is sunlit — a real eye would lose them,
 * but players need the orientation cue). Dragging the bright end up with it is pure
 * cost, and it is a specific cost: **gain makes stars BIGGER.** Apparent radius is
 * where the Gaussian crosses the display threshold,
 *
 *     r = σ·√(2·ln(A/T))            A ∝ gain
 *
 * so gain enters under a log but never cancels. 1024× widens a 2σ star to ~4.2σ.
 * The instinct is then to shrink σ to compensate — which is how σ ended up at 0.6,
 * i.e. FWHM 1.41 px, well under the FWHM ≥ 2 px critical-sampling rule, so the
 * brightest stars flicker as the camera drifts sub-pixel. In vacuum there is no
 * scintillation, so that reads as an obvious artefact.
 *
 * Anchoring at the catalogue's faint limit means **faint-star visibility does not
 * move at all** — only the bright end comes down, which is exactly the end that was
 * forcing σ down. Knocking N magnitudes off the peak frees √(2·ln) worth of σ:
 *
 *     γ     Sirius eff. mag   σ for same size   FWHM   Sirius : faintest
 *     1.00      −8.99               0.60           1.41       1528×   (today)
 *     0.70      −6.60               0.69           1.64        169×
 *     0.55      −5.40               0.76           1.79         56×
 *     0.40      −4.21               0.85           2.01         19×   ← FWHM 2 px
 *
 * (σ column assumes Sirius's visible radius is ~2.5 px at σ = 0.6 today. The
 * MECHANISM is exact; that one anchor is eyeballed, so treat the column as a
 * starting point and confirm by eye. `starCompressionFactor` is unit-tested against
 * the shader's own formulation to 7e-16 — see the verification in §8.7 of
 * STAR_CATALOGUE_PLAN.md.)
 *
 * ⚠ THE COST IS THE BRIGHTNESS HIERARCHY, and the last column is the one to watch.
 * Because apparent size comes from where the Gaussian crosses the clip threshold,
 * compressing brightness also compresses SIZE — and that hierarchy is much of what
 * makes constellations readable. At γ = 0.4 Sirius is only **19×** the faintest
 * visible star, against 1528× in reality: the sky goes flat, every star a similar
 * dot. So FWHM 2.0 is NOT free, and chasing it is the wrong trade. **0.5–0.6 is the
 * sane range** — σ ≈ 0.75, FWHM ≈ 1.8, hierarchy still ~50×.
 *
 * ⚠ This is a LOOK knob and lives outside the physics, exactly like the gain:
 * `aIllum` keeps the true photometric value, the compression is applied in the
 * VERTEX stage, and `__lum.star()` divides `starCompressionFactor()` back out so
 * the gate keeps measuring physics. Never fold it into the catalogue or into
 * `starIlluminanceGame()`.
 */
const STAR_MAGNITUDE_COMPRESSION: number = 0.6;

/**
 * The magnitude held FIXED by the compression. The catalogue's faint limit, so the
 * faintest stars — the whole reason for the gain — never move when γ changes.
 */
const STAR_COMPRESSION_ANCHOR_MAG = 6.5;

/**
 * The sprite catalogue's apparent-magnitude limit.
 *
 * ⚠ Exported because it is the DISCRIMINATOR for a legitimate missing sprite. A
 * promoted star with no sprite row is a double-draw if it is brighter than this and
 * simply absent from the catalogue if it is fainter — Proxima is V 11.01, and 135 of
 * the 166 nearby stars are fainter than this limit (§20).
 */
export const STAR_SPRITE_MAG_LIMIT = 6.5;

/**
 * Multiplier the renderer applies to a star's PHYSICAL illuminance, as a function
 * of its magnitude. Exactly 1 for every star when γ = 1, and exactly 1 at the
 * anchor magnitude for any γ.
 *
 * Exported for `__lum.star()`, which must divide it out — the gate's whole value is
 * that it reports the physical ratio no matter how the look knobs are set.
 */
export const starCompressionFactor = (magV: number): number =>
  Math.pow(
    10,
    -0.4 * (STAR_MAGNITUDE_COMPRESSION - 1) * (magV - STAR_COMPRESSION_ANCHOR_MAG),
  );

/**
 * The compression as a MULTIPLIER on a live illuminance — the same quantity
 * `starCompressionFactor(magV)` returns, without going through a magnitude.
 *
 * 🔑 R7f needs this because the disc tier and the sprite tier must apply the SAME
 * compression to the SAME (live) illuminance or the promotion handover pops. The
 * shader computes `E_render = A·(E/A)^γ`; dividing by E gives `C = (A/E)^(1−γ)`,
 * which is this function. Identical to `starCompressionFactor(m)` where
 * `E = E_mag0·10^(−0.4m)` — no logarithm, and no second formula to drift.
 */
export const starCompressionForIlluminance = (illumGame: number): number =>
  COMPRESSION_IS_IDENTITY || !(illumGame > 0)
    ? 1
    : Math.pow(
        COMPRESSION_ANCHOR_ILLUM / illumGame,
        1 - STAR_MAGNITUDE_COMPRESSION,
      );

/**
 * True when the compression is a no-op, so the shader can skip it entirely.
 * ⚠ `STAR_MAGNITUDE_COMPRESSION` is annotated `: number` deliberately — without it
 * TypeScript narrows the literal and this comparison becomes a compile error for
 * every value except 1.
 */
const COMPRESSION_IS_IDENTITY = STAR_MAGNITUDE_COMPRESSION === 1;

/**
 * `1/(2πσ²·Ω_pixel)` for a given camera and buffer — the flux-conserving conversion
 * from a point source's ILLUMINANCE to its PSF peak radiance.
 *
 * ⚠ Exported so `StellarPoint` uses the SAME derivation rather than a second one.
 * A sub-pixel planet and a star are the same physical problem, and this form is
 * validated to 0.999× on three named stars — whereas the stellar point's own
 * `core + halo` profile lost 47% of its flux to undersampling (its core spans 0.6 px,
 * so the rasteriser simply cannot sample it; see LIGHTING_PLAN Phase 4).
 *
 * 🔑 The projection is linear in **tan**(angle), so this takes the FOV and buffer
 * height and derives `tanPerPx` itself — the same one quantity the sprite size comes
 * from, so the two cannot drift.
 */
export function psfNormForBuffer(fovRad: number, bufferH: number): number {
  const tanPerPx = (2 * Math.tan(fovRad / 2)) / Math.max(bufferH, 1);
  const pxSolidAngle = tanPerPx * tanPerPx;
  return 1 / (2 * Math.PI * PSF_SIGMA_PX * PSF_SIGMA_PX * pxSolidAngle);
}

/** PSF width in pixels — exported so `__lum.star()` reports the same σ the shader uses. */
export const STAR_PSF_SIGMA_PX = PSF_SIGMA_PX;

// ── R2b/R7d: sprites a `<Star>` disc has taken over ────────────────────────────
// Gated on uniforms rather than a rebuilt attribute buffer: re-uploading 8,920
// instances to hide one is absurd, and a graph rebuild would recompile the shader
// (the WebGPU stutter this repo already documents).
//
// 🐛🐛 THIS USED TO MATCH BY DIRECTION AND IT NEVER FIRED. `uSkipCos` was
// `Math.cos(1e-4) = 0.999999995`, three stores uniforms in a `Float32Array`, and the
// ulp below 1.0 in f32 is 5.96e-8 — so `Math.fround(Math.cos(1e-4)) === 1` EXACTLY
// and the shipped test was the strict `dot(aDir, uSkipDir) > 1.0`, which two unit
// vectors cannot satisfy in exact arithmetic. It could only pass by rounding error
// upward, and measured over the 11 promotable nearby stars it passed for 0 of them.
// So the promoted star was drawn TWICE — additive sprite plus additive disc, i.e.
// **exactly 2× flux, 1.0 stop** — on the one star R2b certified continuous to
// 1.6e-16 stops. The old comment claimed 1e-4 rad was "far looser than float error";
// an f32 dot of two near-unit vectors is ±1 ulp ⇒ ±71 arcsec, so 20.6 arcsec was
// 3.4× TIGHTER than the arithmetic can resolve.
//
// ⚠ And the tolerance could never have worked anyway: α Cen A and B are 19.19 arcsec
// apart as seen from Sol, INSIDE the 20.63 arcsec tolerance, so promoting either
// suppressed both. Harmless while they overlap in one 0.2 px blob; under R7f their
// live separation grows as 25.4 AU / d, and at 100 AU that is a 268 px hole with a
// magnitude −15.8 star missing from it.
//
// 🔑 Matched by CATALOGUE ROW INDEX instead. `instanceIndex` is an exact integer
// comparison with no tolerance to get wrong, and it is what generalises to R7d's
// disc pool. The cross-file index problem the old comment worried about
// (`stars_visual.bin` has 8,920 rows, `stars_nearby.json` 166, no shared index
// space) is solved once at promotion time by `findStarFieldIndexByPosLy`, not per
// frame in a shader.
const SKIP_SLOTS = 2;
/**
 * Sentinel no instance index can equal.
 *
 * ⚠ A FLOAT uniform compared against `instanceIndex.toFloat()`, which is the one
 * detail that has to be right given what it replaces: f32 represents every integer
 * below 2²⁴ = 16,777,216 EXACTLY, and the catalogue is 8,920 rows, so this equality
 * is exact arithmetic — not a tolerance, and not a near-1.0 comparison that rounds
 * into degeneracy. (`uniform(x, "uint")` is three's own idiom but @types/three does
 * not expose the overload for a numeric value, and a cast to buy a uint here would
 * be trading a real guarantee for a cosmetic one.)
 */
const NO_SKIP = -1;
const uSkipIndex = /*#__PURE__*/ Array.from({ length: SKIP_SLOTS }, () =>
  uniform(NO_SKIP),
);

/**
 * Suppress the sprites at these catalogue row indices, because a `<Star>` disc is
 * drawing them. Pass fewer than `SKIP_SLOTS` and the rest are cleared.
 *
 * ⚠ Slot count is fixed for the scene's lifetime (§13.1) — the uniforms exist
 * whether or not they are used, so changing which star a slot holds is a uniform
 * write and never a shader rebuild.
 */
export function setStarFieldSkipIndices(indices: readonly number[]): void {
  for (let i = 0; i < SKIP_SLOTS; i++) {
    const v = indices[i];
    uSkipIndex[i].value = v === undefined || v < 0 ? NO_SKIP : v;
  }
}

/**
 * What the suppression slots actually hold, for `__lum.starPool()`.
 *
 * 🔑 THIS EXISTS BECAUSE THE SUPPRESSION HAS NOW FAILED SILENTLY TWICE — once from a
 * cosine that rounded to 1.0f, once from a cross-walk tolerance 100× too tight — and
 * both times the only symptom was a photometric one somewhere else. A slot holding
 * −1 while a disc is mounted is the single most diagnostic number in the system, and
 * nothing reported it.
 */
export function starFieldSkipStatus(): Array<{
  slot: number;
  row: number;
  magV: number | null;
}> {
  return uSkipIndex.map((u, slot) => {
    const row = u.value as number;
    return {
      slot,
      row,
      magV:
        _rows && row >= 0 && row < _rowCount
          ? starMagFromIllum(_rows[row * STRIDE + 3])
          : null,
    };
  });
}

/** Apparent V magnitude from an illuminance in game units — the gate's read-back. */
const starMagFromIllum = (illumGame: number): number =>
  -2.5 *
  Math.log10(
    Math.max(illumGame, 1e-30) / (LUX_AT_MAG_0 / NITS_PER_GAME_UNIT),
  );

/** How many discs the sprite field can have suppressed at once. */
export const STAR_FIELD_SKIP_SLOTS = SKIP_SLOTS;

// ── R7f: the observer's position, which is what makes the sky a 3D field ──────
const uCamPosLy = /*#__PURE__*/ uniform(new THREE.Vector3(0, 0, 0));

/**
 * Anti-NaN guard on the star→camera distance. NOT a brightness knob.
 *
 * ⚠ A distance floor CANNOT bound the brightness: solving the format ceiling for a
 * per-star minimum distance gives `dCat·√(E_cat/E_ceil)`, which depends on both the
 * star's distance and its magnitude — measured across the catalogue that spans
 * 100,520×, so one scalar set for the tightest star throws away ~17 stops of
 * parallax for the rest and set for the loosest does nothing. The bound belongs on
 * the RADIANCE, where the format limit actually lives (see the vertex node). This
 * value exists only so `rel/dLive` cannot be 0/0 if the camera lands exactly on a
 * star's f32 position.
 */
const DIST_EPS_LY = 1e-12;

/** Reused per frame — no allocations in a hot path. */
const _bufSize = /*#__PURE__*/ new THREE.Vector2();

/**
 * Publish the observer's position from the SCALED SCENE'S ORIGIN, in km.
 *
 * ⚠⚠ `worldOriginKm`, NOT `shipPosKm`, and that is a correctness requirement rather
 * than a preference. The sprite shell is centred on the scaled-scene origin and
 * `SimGroup` places the promoted disc at `positionKm − worldOriginKm`, so deriving
 * the sprites from the same origin makes the sprite↔disc offset **exactly zero by
 * construction**. `shipPosKm` is the raw sim position, written one line apart from
 * `worldOriginKm` in `Spaceship` and differing by up to one physics substep: at the
 * dev 1 ly/s override that is 8.3e-3 ly, which against a 4.32 ly star is 2.3 px of
 * visible offset between a promoted disc and the sprites around it.
 *
 * ⚠ `worldOriginKm` only moves when the ship crosses `RECENTER_THRESHOLD_KM`
 * (10,000 km), so it is a staircase — worth 1.06e-9 ly, i.e. 2.4e-10 rad against the
 * nearest star. Irrelevant, and the self-consistency is worth far more.
 *
 * ⚠ Call ONCE per frame BEFORE anything renders, AND again inside the sky-cube
 * capture. The capture runs in a priority-0 `useFrame` while the on-screen writer is
 * at priority 1, so a single call site leaves the cube reading a one-frame-old
 * observer — 0.23° baked in at 1 ly/s, and 0.68° of seam across a 6-frame set.
 * `SkyCaptureDeps.refreshObserver` is that second call, going through THIS function
 * so there is only ever one derivation.
 */
export function publishStarFieldObserverKm(km: {
  x: number;
  y: number;
  z: number;
}): void {
  uCamPosLy.value.set(km.x / LY_IN_KM, km.y / LY_IN_KM, km.z / LY_IN_KM);
}

/** The observer position the sprites are currently placed from. */
export const getStarFieldCamPosLy = (): [number, number, number] => [
  uCamPosLy.value.x,
  uCamPosLy.value.y,
  uCamPosLy.value.z,
];

/** A magnitude-0 star delivers 2.54e-6 lux outside the atmosphere (V band). */
const LUX_AT_MAG_0 = 2.54e-6;

/**
 * Illuminance of a star at the compression anchor, game units. The compression is
 * expressed in illuminance rather than magnitude so the shader needs one `pow` and
 * no logarithm:  E_render = E_anchor · (E/E_anchor)^γ.
 */
const COMPRESSION_ANCHOR_ILLUM =
  (LUX_AT_MAG_0 * Math.pow(10, -0.4 * STAR_COMPRESSION_ANCHOR_MAG)) /
  NITS_PER_GAME_UNIT;


// ── Equatorial J2000 → the game's frame (plan §8.2 gap 2) ───────────────────
// The catalogue is in HYG's equatorial J2000 axes: +x to the vernal equinox,
// +y to RA 6h on the equator, +z to the north CELESTIAL pole. The game's scaled
// scene is a different frame, and MEASURED from sol.json: every body has y = 0,
// so the ecliptic is the **xz-plane** and **+y is the ecliptic north pole** — the
// ordinary three.js y-up convention.
//
// Without this rotation the constellations render in a coherent but arbitrarily
// tilted orientation: internally correct (Orion and the Pleiades are recognisable)
// yet wrong relative to the planets, since Earth's orbital plane and the celestial
// equator are 23.44° apart. That is the whole of gap 2.
//
// Two rotations compose, both about x, so they add:
//   1. equatorial → ecliptic:  rotate by the obliquity ε
//        x' = x,  y' = cosε·y + sinε·z,  z' = −sinε·y + cosε·z
//   2. astronomical z-up → three.js y-up:  (x, y, z) → (x, z, −y)
// which flattens to the single expression in `equatorialToGame` below.
//
// VALIDATED against published ecliptic coordinates, not just self-consistency:
//   north ecliptic pole  → exactly (0, 1, 0)
//   vernal equinox       → exactly (1, 0, 0)
//   north celestial pole → 23.44° off +y  (ecliptic latitude 66.56°)
//   Sirius   → ecl. lat −39.61°, lon 104.08°   (published −39.6°, 104.1°)
//   Polaris  → ecl. lat +66.10°, lon  88.57°   (published +66.1°,  88.7°)
//   Vega     → ecl. lat +61.73°, lon 285.32°   (published +61.7°, 285.3°)
//
// ⚠ THE LONGITUDE ORIGIN IS A DELIBERATE, CHANGEABLE CHOICE. This puts the vernal
// equinox on the game's +x, i.e. ecliptic longitude 0 — the standard convention,
// and the only principled option available, because sol.json's body positions are
// not a real ephemeris for any date (Mercury, Venus, Saturn, Uranus and Neptune
// all sit exactly on +x). It happens to place Earth at ecliptic longitude 153°.
// Once orbits and an epoch exist, the planets' true longitudes will pin this and
// the only edit needed is a rotation about +y added here.
const OBLIQUITY_J2000_RAD = (23.4392911 * Math.PI) / 180;
const COS_OBLIQUITY = Math.cos(OBLIQUITY_J2000_RAD);
const SIN_OBLIQUITY = Math.sin(OBLIQUITY_J2000_RAD);

export function equatorialToGame(
  out: THREE.Vector3,
  x: number,
  y: number,
  z: number,
): void {
  out.set(
    x,
    COS_OBLIQUITY * z - SIN_OBLIQUITY * y,
    -(COS_OBLIQUITY * y + SIN_OBLIQUITY * z),
  );
}

const STRIDE = 7; // dir(3) + illuminance(1) + colour(3)

// Live PSF normalisation, 1/(2πσ²·Ω_pixel), published by the mounted StarField.
const _psfNormRef: { get: () => number } = { get: () => 0 };

/** Set by the mounted StarField so a capture can retarget its PSF. See below. */
let _setPsfForBuffer: ((fovDeg: number, bufferH: number) => void) | null = null;

/**
 * Run `body()` with the star PSF rebuilt for an off-screen buffer of `faceSize`
 * pixels at 90° FOV — i.e. one cube-map face — restoring the on-screen values after.
 *
 * ⚠⚠ MANDATORY FOR ANY OFF-SCREEN SKY CAPTURE (S4b). `uQuadWorld` and `uPsfNorm` are
 * rebuilt every frame from the CANVAS drawing-buffer height AND FOV, because a
 * star's brightness is a FLUX and how bright it renders depends on how many pixels
 * it covers. Capture into a 256² cube face without this and every star carries
 * **85.5×** its correct flux.
 *
 * ⚠ Note it is 85.5× and not (1816/256)² = 50×: a cube face is 90° FOV, so
 * `tanPerPx = 2·tan45°/256 = 7.81e-3` against the canvas's `2·tan37.5°/1816 =
 * 8.45e-4` — a 9.245× linear ratio, squared for solid angle. Getting this wrong by
 * the FOV term is the same mistake as the small-angle `fov/height` bug: the
 * projection is linear in **tan**(angle), not in the angle. Which is exactly why the
 * override feeds fov+height through the one shared derivation rather than a
 * hand-computed scale.
 *
 * It would present as "the reflections look too bright" — a look problem rather than
 * a units problem, which is how long that bug would have survived.
 *
 * ⚠ Restores IMMEDIATELY, from the last on-screen values — not by waiting for the
 * next `useFrame`. The capture runs inside a frame callback, so the on-screen render
 * of that same frame would otherwise still be holding the capture's uniforms: one
 * frame of stars at 50× brightness. A single-frame flash is exactly the kind of
 * artefact that gets dismissed as "something flickered".
 */
export function withStarCaptureResolution<T>(faceSize: number, body: () => T): T {
  const set = _setPsfForBuffer;
  if (!set) return body(); // StarField not mounted; nothing to retarget
  try {
    // A cube face is 90° FOV over `faceSize` pixels. Feeding fov+height (rather
    // than a precomputed scale) means the capture goes through the SAME one
    // derivation as the on-screen path and cannot drift from it.
    set(90, faceSize);
    return body();
  } finally {
    // Back to the live on-screen geometry, recorded by the last useFrame.
    set(_psfOnScreen.fovDeg, _psfOnScreen.bufferH);
    _psfOverride.bufferH = 0;
  }
}

/** Raw inputs behind the PSF scaling, for the `__lum.star()` diagnostic. */
const _psfDebug = { fovDeg: 0, bufferH: 0 };

/** Active PSF override during an off-screen capture; bufferH ≤ 0 means "none". */
const _psfOverride = { fovDeg: 0, bufferH: 0 };

/** Last on-screen FOV/buffer height, so a capture can restore exactly. */
const _psfOnScreen = { fovDeg: 75, bufferH: 1080 };

/**
 * The FOV and drawing-buffer height `StarField` used this frame.
 *
 * ⚠ These are the inputs to both `uQuadWorld` and `uPsfNorm`. If the drawing
 * buffer height disagrees with the RENDER TARGET height the scene actually
 * rasterises into, the sprite's real pixel size is wrong — and because the gate
 * compares against the same `uPsfNorm`, the amplitude error cancels and only the
 * GEOMETRIC error survives, showing up as a flux ratio of σ_screen².
 */
export const getStarPsfInputs = (): { fovDeg: number; bufferH: number } => ({
  ..._psfDebug,
});

/**
 * `1/(2πσ²·Ω_pixel)` as the shader is using it THIS frame — converts a star's
 * illuminance in game units to the peak radiance of its PSF. 0 when no StarField
 * is mounted. Read by `__lum.star()`; rendering never reads it back.
 */
export const getStarPsfNorm = (): number => _psfNormRef.get();

/** Illuminance in game units for an apparent V magnitude. */
export const starIlluminanceGame = (magV: number): number =>
  (LUX_AT_MAG_0 * Math.pow(10, -0.4 * magV)) / NITS_PER_GAME_UNIT;

type Catalogue = {
  buffer: THREE.InstancedInterleavedBuffer;
  count: number;
  /** Brightest star's illuminance in game units — for the `__lum` gate. */
  brightestIllumGame: number;
};

/**
 * Parse `stars_visual.bin` into an interleaved instance buffer.
 *
 * Layout (little-endian): "SNST", u32 version, u32 count, u32 reserved, then
 * count × (f32 x, y, z light-years, f32 magV, f32 B−V). See
 * `scripts/build_star_catalogue.py`.
 */
function parseCatalogue(bytes: ArrayBuffer): Catalogue {
  const head = new DataView(bytes);
  const magic = String.fromCharCode(
    head.getUint8(0),
    head.getUint8(1),
    head.getUint8(2),
    head.getUint8(3),
  );
  if (magic !== "SNST") {
    throw new Error(`[stars] bad magic "${magic}" — expected SNST`);
  }
  const version = head.getUint32(4, true);
  const count = head.getUint32(8, true);
  if (version !== 1) {
    throw new Error(`[stars] unsupported catalogue version ${version}`);
  }

  const src = new Float32Array(bytes, 16, count * 5);
  const out = new Float32Array(count * STRIDE);
  // radiusKm, visualLumSun, tempK, usable(0/1) — see the derivation in the loop.
  const params = new Float32Array(count * PARAM_STRIDE);
  let usable = 0;
  let brightest = 0;
  // Accumulated in the parse loop below and published to `skyIrradiance` (S4).
  const catalogueSh: ShCoefficients = Array.from(
    { length: 9 },
    () => new THREE.Vector3(),
  );

  const dir = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const x = src[i * 5];
    const y = src[i * 5 + 1];
    const z = src[i * 5 + 2];
    const mag = src[i * 5 + 3];
    const bv = src[i * 5 + 4];

    // ── R7f: the full 3D POSITION goes to the GPU, not a direction ──────────
    // An earlier revision normalised here and shipped a unit vector, on the
    // grounds that "within a system parallax is 0.04 arcsec". True, and it is
    // exactly why the sky was frozen the moment the ship left the system: every
    // star sat at its direction FROM SOL for ever. The direction is now derived
    // per frame from `aPosLy − uCamPosLy` in the vertex stage, which costs two
    // `length()` calls over 8,920 instances and is bit-identical in illuminance at
    // the origin (see the vertex node).
    //
    // Rotated out of equatorial J2000 into the game's ecliptic frame HERE, at
    // parse time, so the GPU never pays for it and the .bin stays in the standard
    // astronomical frame. That boundary is deliberate: the catalogue is data and
    // belongs in a published frame; which axes the game uses is a game concern,
    // and changing it must not require re-baking the asset.
    equatorialToGame(dir, x, y, z);
    // ⚠ Degenerate guard on the POSITION now, so a zero row cannot produce a NaN
    // direction on the GPU. Measured: no row in the shipped file is within 1e-6 ly
    // of the origin, so this never fires today.
    if (dir.lengthSq() < 1e-12) dir.set(0, 0, 1);
    const posX = dir.x;
    const posY = dir.y;
    const posZ = dir.z;
    dir.normalize();

    // Illuminance in game units. The shader converts to radiance with the live
    // pixel solid angle; nothing about resolution is baked here.
    const illumGame =
      (LUX_AT_MAG_0 * Math.pow(10, -0.4 * mag)) / NITS_PER_GAME_UNIT;
    if (illumGame > brightest) brightest = illumGame;

    // Luminance-normalised, so it carries hue only and the magnitude above
    // remains the single authority on brightness.
    const [r, g, b] = blackbodyLinearSrgb(temperatureFromBV(bv));

    // ── The catalogue's contribution to the sky's SH-L2 light probe (S4) ────
    // 🔑 Done HERE, in the loop that already exists, because a star is a DELTA
    // SOURCE: its SH contribution is the exact analytic `E·rgb·Y_i(d)`, with no
    // resolution dependence at all. That is the same property that makes stars
    // impossible to carry in a texture (see the header) turned into an advantage —
    // and it means the ~19.5% of the sky's flux that lives in this catalogue lights
    // the hull exactly, rather than being rasterised into some cubemap's texels.
    //
    // Costs one multiply-add per star per coefficient; no extra iteration.
    // ⚠ An older note here claimed "the interstellar-jump case comes free because a
    // jump re-derives directions here". It did NOT: `setCatalogueSh` was reachable
    // only from this parse, which runs from a `useEffect` keyed on a never-changing
    // url. `rebakeCatalogueShFor` below is that path, made real — and it re-runs
    // ONLY this loop, not the blackbody pass, which is 98% of the parse's cost.
    accumulatePointSource(catalogueSh, dir.x, dir.y, dir.z, illumGame, r, g, b);

    const o = i * STRIDE;
    out[o] = posX;
    out[o + 1] = posY;
    out[o + 2] = posZ;
    out[o + 3] = illumGame;
    out[o + 4] = r;
    out[o + 5] = g;
    out[o + 6] = b;

    // ── PER-ROW DERIVED PHYSICS, so EVERY star can be promoted (§19) ────────
    // 🔑 The whole catalogue is promotable with no new data: `absMagV` follows from
    // `magV` and the distance, which is already in the file. That is what makes the
    // author's expectation — "our system would automatically work for all stars in
    // the catalogue" — actually true, rather than true only for the 166 rows of
    // `stars_nearby.json` that the pools used to draw from.
    //
    // ⚠ Cached here rather than computed per selection: 8,920 rows × a bolometric
    // correction polynomial is ~2 ms, against a parse already dominated (98%) by the
    // blackbody pass. Per selection it would be paid every 2,673 AU of travel.
    const distLy = Math.sqrt(posX * posX + posY * posY + posZ * posZ);
    const absMagV = mag - 5 * Math.log10(Math.max(distLy, 1e-9) / (10 * LY_PER_PC));
    const tempK = temperatureFromBV(bv);
    const radiusKm = radiusKmFromCatalogue(absMagV, bv);
    const p = i * PARAM_STRIDE;
    params[p] = radiusKm;
    params[p + 1] = visualLuminositySun(absMagV);
    params[p + 2] = tempK;
    params[p + 3] = starParamsUsable(radiusKm, distLy) ? 1 : 0;
    if (params[p + 3] > 0) usable++;
  }
  setCatalogueSh(catalogueSh);
  console.log(
    `[stars] ${usable}/${count} rows have usable derived physics ` +
      `(${(100 * usable) / count | 0}% — the rest are HYG parallax sentinels)`,
  );

  const ib = new THREE.InstancedInterleavedBuffer(out, STRIDE, 1);
  ib.setUsage(THREE.StaticDrawUsage);
  _rows = out;
  _rowCount = count;
  _ib = ib;
  _params = params;
  return { buffer: ib, count, brightestIllumGame: brightest };
}

// The parsed rows, kept at module scope so the promotion lookup and the SH re-bake
// can reach them without threading the catalogue through React. Same interleaved
// layout as the GPU buffer: posLy(3) + illum(1) + colour(3).
let _rows: Float32Array | null = null;
let _rowCount = 0;
/** The live GPU buffer, so `reconcileStarFieldPositions` can flag an upload. */
let _ib: THREE.InstancedInterleavedBuffer | null = null;
let _params: Float32Array | null = null;

/** Elements per row in the derived-physics array. */
const PARAM_STRIDE = 4;

/** Light-years per parsec — for the absolute-magnitude derivation. */
const LY_PER_PC = 3.2615638;

/**
 * The catalogue as the promotion pools need it: positions, and the derived physics
 * for every row.
 *
 * 🔑 Returned as raw typed arrays with a documented layout, deliberately. Both pools
 * scan all 8,920 rows on a selection, and an accessor call or an object per row would
 * put 8,920 allocations or calls in a path this repo requires to be allocation-free.
 * The layout is stated once here and asserted by `__lum.starRows()`.
 */
export type StarRowPhysics = {
  count: number;
  /** posLy(3) + illum(1) + colour(3), stride `rowStride`. The GPU's own buffer. */
  rows: Float32Array;
  rowStride: number;
  /** radiusKm(1) + visualLumSun(1) + tempK(1) + usable(1), stride `paramStride`. */
  params: Float32Array;
  paramStride: number;
};

let _physics: StarRowPhysics | null = null;

export function getStarRowPhysics(): StarRowPhysics | null {
  if (!_rows || !_params) return null;
  if (!_physics || _physics.rows !== _rows) {
    _physics = {
      count: _rowCount,
      rows: _rows,
      rowStride: STRIDE,
      params: _params,
      paramStride: PARAM_STRIDE,
    };
  }
  return _physics;
}

/** Whether the catalogue has parsed (the lookups below need it). */
export const isStarFieldLoaded = (): boolean => _rows !== null;

/**
 * The catalogue row for a star given its DIRECTION and DISTANCE, or −1. This is the
 * cross-walk that lets `stars_nearby.json` suppress a sprite in `stars_visual.bin`
 * without the two files sharing an index space.
 *
 * ⚠⚠ ANGLE PLUS A RELATIVE DISTANCE, NOT A POSITION DISTANCE, AND THE FIRST VERSION
 * OF THIS SHIPPED BROKEN BECAUSE OF IT. I matched on |Δposition| with a 1e-4 ly
 * tolerance, on a review's assurance that α Cen A and B "match their rows to 5.5e-6
 * and 5.9e-6 ly". MEASURED against the actual files: the error is **7.46e-4 ly**,
 * ~100× larger, so EVERY star failed the tolerance, `findStarFieldIndex` returned −1
 * for all of them, and the promoted stars stayed double-drawn. It showed up as
 * `__lum.skyCapture()` reporting a stored max of 57,163 against a 65,504 ceiling at
 * 100 AU from α Cen — an unsuppressed magnitude −15.9 sprite saturating the cube.
 *
 * 🔑 The error is RADIAL and it is by design: `nearbyStars` builds positions as
 * `dir × distLy` because `distLy` is the column `absMagV` was computed from, while
 * this catalogue stores |posLy|. The two differ in the last printed digit — 4.32016
 * vs 4.3209 — which is 7.4e-4 ly of pure radial offset. A position metric mixes that
 * into the same number as the angular separation it is trying to resolve, and the
 * margin collapses: best 7.465e-4 against runner-up 8.484e-4, a **13% margin** on
 * the α Cen pair.
 *
 * Separating the two axes conditions it properly, and both are scale-free so this
 * works at 4 ly and at 300 ly. MEASURED over all 166 nearby stars:
 *
 *     Rigil Kentaurus -> row 5365, separation 0.169", |d/d−1| 1.7e-4   ✅
 *     Toliman         -> row 5364, separation 0.266", |d/d−1| 1.7e-4   ✅
 *     α Cen A↔B angular separation                    19.20"
 *     Proxima (no sprite, V 11.01)  nearest direction  5746"           rejected
 *     Barnard's (no sprite, V 9.54) nearest direction  2492"           rejected
 *     31 matched, 135 rejected, and **0 magnitude mismatches** among the matches
 *
 * 🔑 That last figure is the real validator: `magV` is a column the matcher does not
 * use, so every match agreeing with it to 0.25 mag is an independent check that it is
 * pairing the right stars.
 *
 * Costs one pass over 8,920 rows, run only when the promotion pool changes.
 */
/**
 * Overwrite matched rows' positions so a star has ONE position across every tier.
 *
 * ⚠⚠ THE TWO CATALOGUES DISAGREE BY 46.8 AU, AND IT IS VISIBLE. `stars_visual.bin`
 * stores HYG's x/y/z (|posLy| = 4.32016 for α Cen A) while `stars_nearby.json` carries
 * HYG's `dist` column (4.3209 ly) — a pure RADIAL disagreement of 7.4e-4 ly = 46.8 AU.
 * From Sol that is 1e-4 rad and invisible. From 100 AU away it is not: the sprite sat
 * **1.468× further from the ship than its own disc**, drawing at 0.46× the flux, and
 * any transverse offset splits the two into separate points on screen. It presented as
 * "I can see three bright stars in a line" at α Cen — two discs and one orphaned
 * sprite — and it was mistaken for Proxima.
 *
 * 🔑 THE NEARBY CATALOGUE WINS, and not arbitrarily: `distLy` is the column `absMagV`
 * was computed from, so it is the one the derived radius, temperature and disc radiance
 * are all consistent with. Patching the 31 matched sprite rows to agree costs one pass
 * at load and removes a whole class of "two positions for one star" defects — the
 * sprite, the disc, the POI marker and the light pool then cannot disagree.
 *
 * ⚠ Suppression hides this for a promoted star, which is why it only showed up once
 * the suppression was broken. It would still bite any star that is a LIGHT but not a
 * disc: its illumination would arrive from one place and its sprite draw in another.
 */
export function reconcileStarFieldPositions(
  stars: ReadonlyArray<{
    dirGame: readonly [number, number, number];
    distLy: number;
  }>,
): number {
  if (!_rows || !_ib) return 0;
  let patched = 0;
  for (const s of stars) {
    const row = findStarFieldIndexForStar(s.dirGame, s.distLy);
    if (row < 0) continue;
    const o = row * STRIDE;
    _rows[o] = s.dirGame[0] * s.distLy;
    _rows[o + 1] = s.dirGame[1] * s.distLy;
    _rows[o + 2] = s.dirGame[2] * s.distLy;
    patched++;
  }
  if (patched > 0) _ib.needsUpdate = true;
  return patched;
}

export function findStarFieldIndexForStar(
  dirGame: readonly [number, number, number],
  distLy: number,
  tolArcsec = 2,
  tolRelDist = 0.01,
): number {
  if (!_rows) return -1;
  let best = -1;
  let bestCos = -2;
  let bestDist = 0;
  for (let i = 0; i < _rowCount; i++) {
    const o = i * STRIDE;
    const x = _rows[o];
    const y = _rows[o + 1];
    const z = _rows[o + 2];
    const d = Math.sqrt(x * x + y * y + z * z) || 1e-12;
    const c = (x * dirGame[0] + y * dirGame[1] + z * dirGame[2]) / d;
    if (c > bestCos) {
      bestCos = c;
      best = i;
      bestDist = d;
    }
  }
  if (best < 0) return -1;
  const sepArcsec =
    Math.acos(Math.max(-1, Math.min(1, bestCos))) * 206264.806;
  const relDist = Math.abs(bestDist / Math.max(distLy, 1e-12) - 1);
  return sepArcsec <= tolArcsec && relDist <= tolRelDist ? best : -1;
}

/**
 * Re-accumulate the catalogue's SH-L2 contribution for an observer at `camPosLy`.
 *
 * 🔑 THIS PATH DID NOT EXIST, and a comment in the parse loop claimed it came free.
 * It does not come free and it was never wired: `setCatalogueSh` was reachable only
 * from `parseCatalogue`, which runs from a `useEffect` keyed on a url that never
 * changes. So every planet's night-side ambient — `CelestialBody` renders
 * `skyIrradianceNode` from `getSkySh()` every frame, and the environment cube never
 * reaches the scaled scene — was lit by star directions and star distances frozen at
 * Sol, carrying 19.5% of the sky's flux pointed the wrong way.
 *
 * ⚠ Re-runs ONLY the SH loop, reading the colours back out of the parsed rows.
 * Measured shape of the parse: ~98% of it is the per-star blackbody×CMF integral and
 * ~0.84 ms is this accumulation, so re-deriving the colours would turn a 1 ms job
 * into a 90 ms main-thread stall.
 *
 * ⚠ Fed the UNCOMPRESSED live illuminance on purpose. The magnitude compression is a
 * display knob; folding it into a light probe would break the physical/artistic
 * split this file states as an invariant, and `__lum.skyProbe()` would stop
 * measuring physics.
 *
 * ⚠⚠ SKIPS THE ROWS THE LIGHT POOL HOLDS (R7e). Those stars are delivering their
 * flux through a `DirectionalLight`, so leaving them in here counts it twice — and
 * not merely doubled: SH-L2 is a 9-coefficient low-pass, so a dominant point source
 * in it gives 17/16 at the source and 1/16 at the ANTIPODE with negative ringing
 * between, i.e. a sun with no terminator. Harmless near Sol (α Cen A is 0.2% of the
 * sky's flux there, which is exactly why it would have gone unnoticed) and severe
 * once you arrive somewhere.
 */
export function rebakeCatalogueShFor(
  camPosLy: readonly [number, number, number],
): boolean {
  if (!_rows) return false;
  const sh: ShCoefficients = Array.from({ length: 9 }, () => new THREE.Vector3());
  const skip = starLightExcludedRows;
  for (let i = 0; i < _rowCount; i++) {
    if (skip.length > 0 && skip.includes(i)) continue;
    const o = i * STRIDE;
    const px = _rows[o];
    const py = _rows[o + 1];
    const pz = _rows[o + 2];
    const rx = px - camPosLy[0];
    const ry = py - camPosLy[1];
    const rz = pz - camPosLy[2];
    const dLive = Math.sqrt(rx * rx + ry * ry + rz * rz) || DIST_EPS_LY;
    const dCat = Math.sqrt(px * px + py * py + pz * pz) || DIST_EPS_LY;
    const ratio = dCat / dLive;
    accumulatePointSource(
      sh,
      rx / dLive,
      ry / dLive,
      rz / dLive,
      _rows[o + 3] * ratio * ratio,
      _rows[o + 4],
      _rows[o + 5],
      _rows[o + 6],
    );
  }
  setCatalogueSh(sh);
  return true;
}

type Props = {
  url?: string;
};

export default function StarField({ url = "/data/stars_visual.bin" }: Props) {
  const [cat, setCat] = useState<Catalogue | null>(null);
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const meshRef = useRef<THREE.InstancedMesh | null>(null);

  useEffect(() => {
    let alive = true;
    void fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`[stars] ${r.status} fetching ${url}`);
        return r.arrayBuffer();
      })
      .then((b) => {
        if (!alive) return;
        const parsed = parseCatalogue(b);
        setCat(parsed);
        console.log(
          `[stars] ${parsed.count} catalogue stars; brightest ` +
            `${(parsed.brightestIllumGame * NITS_PER_GAME_UNIT).toExponential(3)} lux`,
        );
      })
      .catch((e) => console.error(e));
    return () => {
      alive = false;
    };
  }, [url]);

  // Half-width of the billboard in world units, and the PSF normalisation. Both
  // depend on FOV and drawing-buffer height, so both are refreshed per frame
  // rather than captured once — a resize or FOV change must not silently
  // invalidate the photometry.
  const uQuadWorld = useMemo(() => uniform(0), []);
  const uPsfNorm = useMemo(() => uniform(0), []);
  // Published for the `__lum.star()` gate so the check uses the EXACT value the
  // shader used this frame. Recomputing it in the harness would be a second
  // implementation of the same formula — and two implementations of a conversion
  // is how a validated pipeline silently drifts out of validation.
  useEffect(() => {
    _psfNormRef.get = () => uPsfNorm.value as number;
    // A capture cannot wait for the next useFrame, so it writes the uniforms
    // directly through the same derivation.
    _setPsfForBuffer = (fovDeg: number, bufferH: number) => {
      _psfOverride.fovDeg = fovDeg;
      _psfOverride.bufferH = bufferH;
      if (bufferH <= 0) return;
      const t = (2 * Math.tan((fovDeg * Math.PI) / 360)) / bufferH;
      uQuadWorld.value = STAR_SHELL_RADIUS * t * (QUAD_PX * 0.5);
      uPsfNorm.value = 1 / (2 * Math.PI * PSF_SIGMA_PX * PSF_SIGMA_PX * t * t);
      // 🐛 MUST update `_psfDebug` too. It was omitted at first, and the S4b capture
      // witness — which reads it through `getStarPsfInputs()` — therefore reported
      // the ON-SCREEN 75°/1783 px during a capture that had actually been overridden
      // correctly. The gate failed a working capture, and the failure message
      // confidently blamed the wrong thing.
      //
      // 🔑 The real lesson is in the fix on the gate side: witness the UNIFORM the
      // shader samples, not a bookkeeping field that happens to travel alongside it.
      // A diagnostic that reads its own notes rather than the state cannot be trusted
      // when the two diverge — and divergence is exactly when you need it.
      _psfDebug.fovDeg = fovDeg;
      _psfDebug.bufferH = bufferH;
    };
    return () => {
      _psfNormRef.get = () => 0;
    };
  }, [uPsfNorm]);

  const material = useMemo(() => {
    const m = new NodeMaterial();
    // ⚠⚠ `transparent` MUST STAY FALSE. In three.js a transparent material is
    // rendered in a SEPARATE PASS AFTER all opaque geometry, and `renderOrder`
    // only sorts WITHIN a bucket — so `renderOrder = -999` is silently ignored
    // against the planets. With `transparent = true` the stars drew LAST, and
    // with depthTest off they painted straight over every celestial body: their
    // night sides vanished entirely.
    //
    // Opaque-bucket + renderOrder −999 + no depth write is the correct
    // combination: the panorama draws first (−1000), then the stars, then real
    // geometry whose depth writes cover them. Blending is honoured regardless of
    // this flag — `transparent` selects the render list, not whether blending runs.
    m.transparent = false;
    m.depthTest = false;
    m.depthWrite = false;
    // ⚠⚠ TRUE additive, NOT `THREE.AdditiveBlending`. That preset is
    // blendSrc = SrcAlpha, blendDst = One — so it multiplies the colour by the
    // fragment's alpha. Since this shader returns the PSF weight as alpha, the
    // Gaussian got applied TWICE: written = amplitude·g², and g² = exp(−r²/σ²) is
    // a Gaussian of width σ/√2, whose integral is πσ² instead of 2πσ² — **exactly
    // half the flux**.
    //
    // MEASURED before this fix: flux ratio 0.3635 = ½ (this bug) × 0.7275 (the
    // projection bug below). It was invisible in the PEAK, because g(0)² = 1 —
    // which is why the flux-integrating gate is what found it and a peak
    // comparison never could.
    m.blending = THREE.CustomBlending;
    m.blendSrc = THREE.OneFactor;
    m.blendDst = THREE.OneFactor;
    m.blendEquation = THREE.AddEquation;

    const aPosLy = vec3(attribute("aPosLy", "vec3"));
    const aIllum = float(attribute("aIllum", "float"));
    const aColor = vec3(attribute("aColor", "vec3"));

    // ⚠ Instanced attributes are VERTEX-ONLY in WebGPU — anything the fragment
    // needs must cross as a varying.
    const vIllum = varying(float(0), "v_starIllum");
    const vColor = varying(vec3(0), "v_starColor");

    /**
     * Everything between a star's illuminance and the number written to the
     * RGBA16F target. ONE definition, used by the vertex clamp and the fragment,
     * so the bound and the value it bounds cannot drift apart.
     */
    const writeMultiplier = () =>
      uPsfNorm.mul(uPreExposure).mul(uStarLift).mul(uSkyCaptureScale);
    /** Largest compressed illuminance whose peak still fits the write budget. */
    const peakIllumCeil = () =>
      float(HALF_FLOAT_WRITE_MAX).div(writeMultiplier().max(float(1e-30)));

    m.vertexNode = Fn(() => {
      // ── R7f: parallax. Direction and brightness are both live ───────────────
      // 🔑 `dCat/dLive` rather than `1/dLive²` against a re-referenced illuminance,
      // because at `uCamPosLy = (0,0,0)` this is EXACTLY 1: `x − (+0) === x` bitwise
      // for every finite x, so `rel` is `aPosLy` bit-for-bit, `length()` of the same
      // bits is the same bits, `x/x` is exactly 1.0 in f32, and `1.0²` is exactly
      // 1.0. The illuminance inside the solar system is therefore bit-identical to
      // what shipped, which is what makes this change unable to regress it.
      //
      // ⚠ The DIRECTION is not bit-identical: it used to be normalised on the CPU in
      // f64 and rounded once, and is now normalised on the GPU in f32. Measured:
      // 6,259 of 8,920 rows change by ≥1 ulp, worst 0.028 arcsec against 293
      // arcsec/px at 1080p. Nil visually — but do not write a gate asserting bit
      // equality of positions.
      const rel = aPosLy.sub(uCamPosLy);
      const dLive = length(rel).max(float(DIST_EPS_LY));
      const dCat = length(aPosLy).max(float(DIST_EPS_LY));
      const ratio = dCat.div(dLive);
      // ⚠⚠ CLAMPED, and the clamp is the load-bearing part of R7f, not a tidy-up.
      // Before parallax `aIllum` had a FIXED ceiling — Sirius at 1.585e-9 game units
      // — with no distance term anywhere in the graph, which is why the fragment
      // could return raw radiance with no `min()`. `ratio²` is unbounded above and
      // the γ = 0.6 compression only softens the growth to d^−1.2; it does not bound
      // it. Unbounded here means +Inf in an RGBA16F target, and one +Inf texel in the
      // sky cube goes through the PMREM blur and turns EVERY roughness mip into NaN,
      // which takes the hull's whole environment with it and never recovers (the SH
      // probe is pinned to 0 once `envAssigned` latches).
      // 🔑 The bound is DERIVED IN THE GRAPH from the format limit divided by the
      // live multiplier chain, so it tracks pre-exposure, the display lift AND the
      // sky-capture encode scale with nothing to keep in sync on the CPU. A CPU
      // uniform could not: `withCaptureResolution` retargets the PSF BEFORE
      // `withSkyCaptureEncode` sets the encode scale, so any CPU-side product would
      // be computed against a stale capture scale for the whole capture.
      // ⚠ Clamped at the VERTEX, i.e. on the PEAK, so the Gaussian below it is
      // untouched. A fragment-side clamp would flatten the core into a widening
      // plateau instead, which changes the star's apparent SIZE with its brightness
      // — the adaptation-coupled breathing R3b deleted from the disc tier.
      const illumLive = aIllum.mul(ratio).mul(ratio);
      // Compression belongs HERE, not in the fragment and not in the buffer:
      //   • vertex, not fragment — it is per-instance, so 4 evaluations per star
      //     instead of one per covered pixel;
      //   • shader, not buffer — `aIllum` stays the true photometric value, which
      //     is what keeps the physical layer auditable.
      // At γ = 1 the node is not built at all, so the default path is bit-identical
      // to the uncompressed render rather than "identical up to a pow(x, 1.0)".
      //
      // ⚠ R7f: applied to the LIVE illuminance, not the catalogue one. That is what
      // keeps this tier and the disc tier on ONE rule — `E·(A/E)^(1−γ)` is exactly
      // the `starCompressionForIlluminance(E)` the disc multiplies in — so the
      // promotion handover is continuous at every distance rather than only at the
      // catalogue distance. It costs a d^−1.2 falloff instead of d^−2 while the gain
      // is engaged, which for a star you are NOT flying to is under 0.5 stops across
      // a 4 ly hop.
      const compressed = COMPRESSION_IS_IDENTITY
        ? illumLive
        : float(COMPRESSION_ANCHOR_ILLUM).mul(
            pow(
              illumLive.div(float(COMPRESSION_ANCHOR_ILLUM)),
              float(STAR_MAGNITUDE_COMPRESSION),
            ),
          );
      vIllum.assign(compressed.min(peakIllumCeil()));
      vColor.assign(aColor);
      const worldCenter = modelWorldMatrix.mul(
        vec4(rel.div(dLive).mul(float(STAR_SHELL_RADIUS)), 1),
      );
      const viewCenter = cameraViewMatrix.mul(worldCenter);
      // View-aligned billboard: offset in view space so the quad always faces
      // the camera without a per-instance rotation.
      // ── R2b/R7d: suppress the instances a `<Star>` disc has taken over ─────
      // Exact integer equality — see NO_SKIP for why the float compare is exact and
      // for the 1.0-stop double-draw the direction test used to cause.
      const idx = instanceIndex.toFloat();
      const suppress = uSkipIndex.reduce(
        (acc, u) => acc.or(idx.equal(u)),
        idx.equal(uSkipIndex[0]),
      );
      const scale = suppress.select(float(0.0), uQuadWorld);
      const viewPos = viewCenter.add(
        vec4(positionGeometry.xy.mul(scale), float(0), float(0)),
      );
      return cameraProjectionMatrix.mul(viewPos);
    })();

    m.fragmentNode = Fn(() => {
      // uv is [0,1] across the quad; p is [-1,1], so r maps to QUAD_PX/2 pixels.
      const p = uv().mul(2).sub(1);
      const rPx = length(p).mul(float(QUAD_PX * 0.5));
      const g = exp(
        rPx.mul(rPx).div(float(-2 * PSF_SIGMA_PX * PSF_SIGMA_PX)),
      );
      // E → peak radiance via the PSF's effective solid angle, the frame's source
      // pre-exposure (D25), the display lift and the capture encode scale.
      // ⚠ `writeMultiplier()` is the SAME expression the vertex clamp divides the
      // format limit by, so `vIllum · writeMultiplier() ≤ HALF_FLOAT_WRITE_MAX` holds
      // by construction and `g ≤ 1` only lowers it. See the vertex node for why the
      // bound has to be here rather than on a distance floor.
      const radiance = vIllum.mul(writeMultiplier()).mul(g);
      // ⚠⚠ PER-CHANNEL, on the assembled vec3, not on the luminance. `vColor` is
      // luminance-NORMALISED, so a channel legitimately exceeds 1 (Sol's red is
      // 1.1103) — clamping the scalar and then multiplying by 1.11 walks straight
      // back over the ceiling. This is the same trap two independent reviewers
      // caught in `Star.tsx`, and the same fix (Star.tsx's `.min(vec3(...))`).
      return vec4(vColor.mul(radiance).min(vec3(HALF_FLOAT_WRITE_MAX)), g);
    })();

    return m;
  }, [uQuadWorld, uPsfNorm]);

  const geometry = useMemo(() => {
    if (!cat) return null;
    const geo = new THREE.PlaneGeometry(2, 2);
    geo.setAttribute(
      "aPosLy",
      new THREE.InterleavedBufferAttribute(cat.buffer, 3, 0, false),
    );
    geo.setAttribute(
      "aIllum",
      new THREE.InterleavedBufferAttribute(cat.buffer, 1, 3, false),
    );
    geo.setAttribute(
      "aColor",
      new THREE.InterleavedBufferAttribute(cat.buffer, 3, 4, false),
    );
    // The shell is far larger than any frustum test would understand, and the
    // sprites are billboarded in the vertex stage, so leave culling off.
    geo.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(),
      STAR_SHELL_RADIUS * 2,
    );
    return geo;
  }, [cat]);

  useFrame(() => {
    const cam = camera as THREE.PerspectiveCamera;
    // ⚠ The RENDER TARGET height, not the drawing buffer's. They match today, but
    // the sprite must be sized against whatever the scene actually rasterises
    // into — sizing against a different resolution is a silent flux error.
    const size = gl.getDrawingBufferSize(_bufSize);
    if (size.y < 1) return;
    // Published raw for `__lum.star()` — see the ⚠ note there. The gate solves the
    // on-screen PSF width from its own measurements, and comparing that against
    // these inputs is what localises a pixel-scale error instead of guessing at it.
    _psfDebug.fovDeg = _psfOverride.bufferH > 0 ? _psfOverride.fovDeg : cam.fov;
    _psfDebug.bufferH = _psfOverride.bufferH > 0 ? _psfOverride.bufferH : size.y;
    // ⚠ One pixel's size in TANGENT space, not `fov/height`. The small-angle form
    // is wrong by u/tan(u) — only 0.4% at 10° but **14.7% at this camera's 75°**,
    // which made every sprite 0.853× too small and its flux 0.727× too low
    // (MEASURED as part of the 0.3635 above). A perspective projection is linear
    // in tan(angle), not in angle.
    //
    // The SAME quantity feeds the quad size and the solid angle on purpose: as
    // long as both come from `tanPerPx`, the two cannot disagree and flux is
    // conserved by construction — which is the entire promise of this component.
    // One derivation, two consumers (on-screen and capture) — see
    // `withStarCaptureResolution`. Overriding the INPUTS rather than the outputs is
    // what keeps `uQuadWorld` and `uPsfNorm` mutually consistent in both paths.
    if (_psfOverride.bufferH <= 0) {
      _psfOnScreen.fovDeg = cam.fov;
      _psfOnScreen.bufferH = size.y;
    }
    const fovDeg = _psfOverride.bufferH > 0 ? _psfOverride.fovDeg : cam.fov;
    const bufferH = _psfOverride.bufferH > 0 ? _psfOverride.bufferH : size.y;
    const tanPerPx = (2 * Math.tan((fovDeg * Math.PI) / 360)) / bufferH;
    const pxSolidAngle = tanPerPx * tanPerPx;
    // Quad half-width in world units at the shell radius, so it covers QUAD_PX.
    uQuadWorld.value = STAR_SHELL_RADIUS * tanPerPx * (QUAD_PX * 0.5);
    // 1 / (2πσ² · Ω_pixel) — the PSF's effective solid angle, inverted.
    uPsfNorm.value =
      1 / (2 * Math.PI * PSF_SIGMA_PX * PSF_SIGMA_PX * pxSolidAngle);
  });

  if (!geometry || !cat) return null;
  return (
    // `instancedMesh` with `count` is how the rest of the codebase drives an
    // instanced draw (see AsteroidImpostors) — the instance count lives on the
    // object, not the geometry.
    <instancedMesh
      ref={(m) => {
        meshRef.current = m;
        // ⚠ ENABLE, never set — the sprites must stay on layer 0 for the on-screen
        // render and ALSO appear on the sky-capture layer (S4b). `layers.set()`
        // mutates persistent Object3D state, which is what made the D26 layer
        // experiment survive a code revert and need a page reload.
        if (m) m.layers.enable(SKY_CAPTURE_LAYER);
      }}
      args={[geometry, material, cat.count]}
      count={cat.count}
      frustumCulled={false}
      // Just after the panorama (−1000) and before everything else, so opaque
      // geometry drawn later paints over the stars without needing a depth test.
      renderOrder={-999}
    />
  );
}
