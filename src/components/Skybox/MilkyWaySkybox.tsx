"use client";

import { useMemo } from "react";
import * as THREE from "three";
import { NodeMaterial } from "three/webgpu";
import {
  Fn,
  asin,
  atan,
  clamp,
  float,
  normalize,
  positionLocal,
  texture as tslTexture,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { useKTX2 } from "@/hooks/useKTX2";
import {
  NITS_PER_GAME_UNIT,
  uPreExposure,
} from "@/components/space/photometry";

// Whole-sky mean the ENTIRE sky should emit, cd/m² — zodiacal light + integrated
// starlight seen from interplanetary space, no airglow.
const SKY_TARGET_NITS = 1e-4;

// ── The star / diffuse split (STAR_CATALOGUE_PLAN.md S3) ────────────────────
// This panorama used to carry the whole sky, stars included. Now `StarField`
// renders 8,920 real stars to V ≤ 6.5 from a catalogue at their true magnitudes,
// so the panorama must carry only what is LEFT — otherwise every catalogue star
// sits on a second, wrongly-scaled copy of itself.
//
// DERIVED, not guessed: summing `E = 2.54e-6·10^(−0.4m)` over the whole catalogue
// gives 2.4525e-4 lux, which is **19.5%** of the total sky flux (4π · 1e-4 cd/m²
// = 1.257e-3 lux). So the diffuse layer owns the other 80.5%, and total sky flux
// is conserved across the split — re-enabling this panorama alongside the
// catalogue does not change the sky's overall brightness.
//
// 🔑 That 80.5% is not a fudge, it is the physics: the catalogue's flux is still
// RISING at its faint limit (mag 5–6 alone carries 21% of it, mag 6–6.5 another
// 13%), so most integrated starlight comes from stars fainter than the naked-eye
// cutoff. Those unresolved stars are *supposed* to be part of a diffuse layer,
// along with diffuse galactic light and zodiacal light.
const CATALOGUE_FLUX_SHARE = 0.195;
const SKY_DIFFUSE_TARGET_NITS = SKY_TARGET_NITS * (1 - CATALOGUE_FLUX_SHARE);

// Solid-angle-weighted mean linear luminance of 8k_milkyway_diffuse.ktx2, measured.
// ⚠ Re-measure if the panorama is ever replaced; this is a property of the asset.
// `scripts/build_diffuse_sky.sh` prints the value to paste here.
//
// The star-free layer is NASA SVS *Deep Star Maps 2020* (svs.gsfc.nasa.gov/4851),
// celestial variant. It is RENDERED from Gaia DR2 + Tycho-2, so the starless version
// simply OMITS the catalogued stars — no filtering, no detail loss.
//
// ⚠ An earlier attempt median-filtered our old panorama instead. It was sound
// photometrically (it removed 20.9% of the linear flux, against the 19.5% the
// catalogue independently accounts for — two unrelated routes agreeing to 1.4 points
// is why the split is trustworthy) but it looked SMUDGY, because a median cannot
// tell a star from genuine dust structure at the same scale and removes both.
//
// ⚠ Measuring this correctly requires LINEARISING BEFORE DOWNSCALING. Averaging
// sRGB-encoded values and then linearising underestimates a high-variance field
// (the EOTF is convex), and it did so badly enough that the median filter appeared
// to *raise* the mean — an impossible result that was purely the measurement.
const SKY_TEXTURE_MEAN_LINEAR = 0.035450;
const OBLIQUITY_J2000_RAD = (23.4392911 * Math.PI) / 180;
const COS_OBLIQUITY = Math.cos(OBLIQUITY_J2000_RAD);
const SIN_OBLIQUITY = Math.sin(OBLIQUITY_J2000_RAD);

/**
 * ── ARTISTIC GAIN — a display knob, deliberately OUTSIDE the physics ──────────
 *
 * Tune freely. Applied AFTER `SKY_RADIANCE_SCALE`, so the calibration above stays
 * the physical truth and can still be measured against real surface brightnesses.
 *
 * 🔑 Why boosting is defensible: the real Milky Way is ~1e-4 cd/m² ≈ 21.5
 * mag/arcsec², BELOW the cone threshold (~1e-3), so a real observer sees it with
 * rods — dim, structured, and colourless. An SDR panel and a daylight tone curve
 * cannot reproduce rod vision, so a physically exact value reads as "black with a
 * faint smudge" rather than the striking band a dark-adapted eye actually sees.
 * This is a perceptual correction, and Phase 7 (D19, scotopic + Purkinje) is its
 * principled replacement.
 *
 * ⚠ Do NOT achieve a brighter sky by editing SKY_TEXTURE_MEAN_LINEAR or
 * SKY_TARGET_NITS instead. Those are measurements; changing them to chase a look
 * destroys the ability to tell whether the sky is calibrated, and raising
 * SKY_TARGET_NITS specifically recreates the original 189,000×-too-bright error.
 */
export const SKY_ARTISTIC_GAIN = 1024.0;

const SKY_RADIANCE_SCALE =
  SKY_DIFFUSE_TARGET_NITS / NITS_PER_GAME_UNIT / SKY_TEXTURE_MEAN_LINEAR;

type Props = {
  url?: string;
};

/**
 * Renders the star panorama as a large inverted sphere instead of scene.background.
 * This avoids issues with the WebGPU renderer's internal background caching
 * when using a cloned camera in a portal scene.
 */
export default function MilkyWaySkybox({
  url = "/assets/8k_milkyway_diffuse.ktx2",
}: Props) {
  const tex = useKTX2(url);

  const [geometry, material] = useMemo(() => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    // ⚠ REPEAT in u, CLAMP in v. `u` wraps 1 → 0 somewhere no matter what, and with
    // the default ClampToEdge a bilinear tap straddling that wrap blends texels from
    // OPPOSITE edges of the image instead of across it, drawing a thin bright line
    // down the whole seam (visible in-game as a line joining the two celestial
    // poles). RepeatWrapping makes that tap wrap correctly and the line disappears.
    //
    // Note the seam MOVED when the u convention was fixed below: `fract` now wraps at
    // RA 12h rather than RA 0h, and it now coincides with `atan`'s own branch cut at
    // ±π. Both still land exactly on the texture's u = 0/1 boundary, which is the
    // only thing RepeatWrapping needs to be true.
    //
    // v must stay CLAMPED: wrapping it would blend the north pole into the south.
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;

    tex.needsUpdate = true;

    const geo = new THREE.SphereGeometry(1, 64, 32);
    // ⚠⚠ DO NOT flip faces with `geo.scale(-1, 1, 1)`. That does make the inside
    // visible, but it also MIRRORS THE UVs — the whole sky rendered left-right
    // reversed. `side: BackSide` achieves the same inward-facing render without
    // touching the geometry.
    //
    // MEASURED: aiming at the galactic centre (RA 17.7611h, Dec −29.0078°) landed on
    // the band but roughly OPPOSITE the core, which is the signature of RA → −RA.
    // ✅ That diagnosis was correct, and the UV block below is its resolution: the
    // asset's u axis really does run the other way. Note that aiming at Orion and at
    // the celestial pole looked fine throughout, because those tests were validating
    // the STAR CATALOGUE, which is drawn as geometry and never touched this mirror —
    // a reminder that a passing test on the wrong subsystem proves nothing.
    //
    // This is the same class of defect as D24, where every PLANET rendered mirrored.

    // ── Explicit equirect UV from the world direction ────────────────────────
    // ⚠⚠ DO NOT rely on SphereGeometry's UVs plus a geometry flip. Two attempts at
    // that were WRONG, in both directions: the panorama came out mirrored in
    // longitude, and the "obvious" corrective rotation (about X by π−ε) does not
    // compose to the right transform either — `SphereGeometry` uses
    // `x = −cos(φ)sin(θ)` with `uv = (u, 1−v)`, which is not the celestial equirect
    // convention and is a REFLECTION away from it, so no pure rotation can fix it.
    //
    // Computing the UV from the direction removes every one of those unknowns. The
    // texture is in celestial (equatorial J2000) coordinates; the scene is in the
    // game's ecliptic frame; so: rotate the direction back to equatorial, then take
    // RA/Dec, then the asset's equirect convention.
    //
    // `gameToEquatorial` is the exact analytic inverse of `StarField`'s
    // `equatorialToGame` (the 2×2 block has determinant 1, so the inverse is its
    // adjugate), and that part was never in doubt.
    //
    // ── ⚠⚠ THE ASSET IS A SKY CHART, NOT A GLOBE TEXTURE ─────────────────────
    // A FOURTH attempt failed here, and it failed for an instructive reason: it used
    // `u = RA/2π, v = (90° − Dec)/180°` and verified that formula to 1e-14 against
    // the equirect DEFINITION for six landmarks. The verification was correct and
    // useless — the definition was never the unknown. The ASSET's convention was.
    //
    // 🔑 The symptom that made it unarguable was a cross-check between two
    // independently-sourced things in the same frame: the Big Dipper, drawn from the
    // star catalogue (whose equatorial → game rotation is validated to 0.07°), sat ON
    // the band, when its galactic latitude is +60° and it must sit far off it.
    //
    // MEASURED by `scripts/solve_sky_orientation.py` against the panorama itself:
    //
    //   u = fract(0.5 − RA/2π)        v = (90° − Dec)/180°
    //
    // i.e. RA 0h at the image CENTRE with RA increasing to the LEFT — the ordinary
    // astronomical chart convention (north up, east left). Being a chart rather than
    // a globe texture makes it a REFLECTION of the naive reading, which is why the
    // three earlier attempts to fix it by rotating could not possibly have worked.
    //
    // Evidence (all from that script, on the source EXR):
    //   • Procrustes over 4 landmarks, reflection allowed → det = −1.0000 exactly
    //   • the Magellanic Clouds — compact, catalogued to arcminutes — land 21.33°
    //     apart against a true 20.75°, and match this transform to 1.17° / 0.68°
    //   • whole-image rms galactic latitude of the light: 37.7° under the old
    //     formula, 9.69° under this one (9.69° is the band's real thickness plus the
    //     Clouds at b = −33° and −44°)
    //   • an unconstrained 3×3 fit does no better: 9.66° vs 9.69°, so the ~3° of
    //     extra tilt it wanted was fitting the two deliberately-fuzzy landmarks
    //
    // Landmark UVs under this convention (verify with `__lum.aim`):
    //   galactic centre  → (0.7600, 0.6612)   RA 17.7611h Dec −29.0078°
    //   north gal. pole  → (0.9643, 0.3493)   RA 12.8576h Dec +27.1283°
    //   LMC              → (0.2753, 0.8875)   RA  5.3929h Dec −69.756°
    //   Big Dipper       → (0.9811, 0.1846)   RA 12.2570h Dec +56.382°  (b = +60°)
    const mat = new NodeMaterial();
    mat.side = THREE.BackSide;
    mat.depthWrite = false;
    mat.depthTest = false;
    mat.transparent = false;

    mat.fragmentNode = Fn(() => {
      // The sphere is centred on the scaled origin and uniformly scaled, so the
      // local position IS the view direction.
      const d = normalize(positionLocal);
      // game → equatorial (inverse of equatorialToGame)
      const ex = d.x;
      const ey = float(-SIN_OBLIQUITY)
        .mul(d.y)
        .sub(float(COS_OBLIQUITY).mul(d.z));
      const ez = float(COS_OBLIQUITY)
        .mul(d.y)
        .sub(float(SIN_OBLIQUITY).mul(d.z));
      // RA → u, Dec → v with v = 0 at the north pole.
      // TSL exposes the two-argument form as `atan(y, x)`.
      //
      // ⚠ NOTE THE MINUS SIGN AND THE HALF-TURN: `u = fract(0.5 − RA/2π)`, NOT
      // `u = RA/2π`. That is the asset's convention, MEASURED — see the block above.
      // `atan` returns (−π, π], so `RA/2π ∈ (−0.5, 0.5]` and `1.5 − that ∈ [1, 2)`;
      // the `fract` brings it to [0, 1) without a branch.
      const u = float(1.5)
        .sub(atan(ey, ex).mul(float(1 / (2 * Math.PI))))
        .fract();
      const v = float(0.5).sub(
        asin(clamp(ez, float(-1), float(1))).mul(float(1 / Math.PI)),
      );
      const rgb = tslTexture(tex, vec2(u, v)).rgb;
      // × uPreExposure like every other radiance source (D25). Doing it in the
      // graph means no per-frame CPU write and nothing to forget.
      return vec4(
        vec3(rgb)
          .mul(float(SKY_RADIANCE_SCALE))
          .mul(uPreExposure)
          // Artistic gain LAST, so everything before it is physical.
          .mul(float(SKY_ARTISTIC_GAIN)),
        1,
      );
    })();
    // ── Absolute luminance ────────────────────────────────────────────────────
    // `SKY_RADIANCE_SCALE` and `uPreExposure` are applied IN THE GRAPH above, not
    // via `material.color` — a NodeMaterial has no such property, and doing it in
    // the graph means there is no per-frame CPU write to forget.
    //
    // ⚠ HISTORY worth keeping: with the old star-laden panorama the correctly
    // calibrated diffuse band stored as EXACTLY ZERO (probe returned [0,0,0]),
    // because RGBA16F's smallest subnormal is 2⁻²⁴ = 5.96e-8 and the band was
    // p50 9.6e-9. That was defect D25, and **source pre-exposure fixed it** — the
    // band is representable now precisely because a dark frame carries a large
    // pre-exposure. Do NOT "fix" a dim sky by raising SKY_TARGET_NITS; that
    // recreates the original 189,000×-too-bright error and turns space grey.

    return [geo, mat] as [THREE.BufferGeometry, NodeMaterial];
  }, [tex]);


  // Render at a large radius within the scaled camera's far plane.
  // depthWrite=false ensures it never occludes other scaled objects.
  return (
    <mesh
      geometry={geometry}
      material={material}
      scale={[1_000_000, 1_000_000, 1_000_000]}
      frustumCulled={false}
      renderOrder={-1000}
    />
  );
}
