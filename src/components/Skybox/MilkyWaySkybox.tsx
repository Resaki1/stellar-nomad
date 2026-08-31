"use client";

import { useMemo, useRef } from "react";
import * as THREE from "three";
import { NodeMaterial } from "three/webgpu";
import {
  Fn,
  atan,
  float,
  normalize,
  positionLocal,
  uniform,
  texture as tslTexture,
  vec3,
  vec4,
} from "three/tsl";
import { useFrame, useThree } from "@react-three/fiber";
import { useKTX2 } from "@/hooks/useKTX2";
import { bakePanoramaSh } from "@/components/space/skyIrradiance";
import {
  SKY_CAPTURE_LAYER,
  captureSkyCube,
} from "@/components/space/skySpecular";
import {
  getStarPsfInputs,
  getStarPsfNorm,
  withStarCaptureResolution,
} from "@/components/Stars/StarField";
import { panoramaUvFromGameDir } from "./skyPanoramaMapping";
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
export const SKY_DIFFUSE_TARGET_NITS = SKY_TARGET_NITS * (1 - CATALOGUE_FLUX_SHARE);

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
 *
 * ── ⚠⚠ P7d, 2026-08-30 — WOUND DOWN TO 64, THEN REVERTED. READ THIS BEFORE
 *    TOUCHING IT AGAIN. ─────────────────────────────────────────────────────
 *
 * Phase 7 made this gain look measurable, because the scotopic driver reads
 * absolute luminance off this buffer and a gain applied inside the written
 * radiance is a lie about luminance. It was reduced 1024 → 64, chosen as the
 * largest value for which the driver still reads the **Milky Way band** as
 * scotopic (band s = 0.013 at ×64 vs 0.454 at ×1024).
 *
 * ❌ **THAT OPTIMISED THE WRONG QUANTITY, AND THE AUTHOR CAUGHT IT ON DEVICE:**
 * "I can barely see the ship illuminate at all on a dark setting where the Milky
 * Way is visible really bright."
 *
 * 🔑 **THE BAND IS NOT THE DIMMEST THING THAT MUST STAY VISIBLE — THE HULL IS.**
 * Measured (`__lum.skyProbe`): the sky delivers 2.2e-4 … 5.1e-4 lux to the hull,
 * so an albedo-0.30 Lambert surface sits at **5.0e-5 cd/m² = 2.49× BELOW the
 * band's 1.25e-4**. Against AgX's hard black floor at the galactic-centre pose:
 *
 *     gain    band s     hull × AgX floor    band × AgX floor
 *     ×64     0.013            3.7                 9.3        hull CRUSHED
 *     ×128    0.076            7.4                18.5        hull CRUSHED
 *     ×256    0.178           14.9                37.1        hull visible
 *     ×512    0.308           29.7                74.2        hull visible
 *     ×1024   0.454           59.5               148.3        hull visible ← author's value
 *
 * An 8× margin on the HULL needs **×138**, so ×64 left it at 3.7× — inside the
 * bottom 1.9 stops of the curve, i.e. crushed. The band had its margin; the thing
 * lit BY the band did not. ⇒ **Reverted to 1024**, the author's empirically tuned
 * value. ×256 / ×512 are the measured middle options if the Milky Way's residual
 * colour matters more than hull contrast; that is a look call, and the table above
 * is what it costs either way.
 *
 * ⚠⚠ **AND THE "KEEP THIS EQUAL TO `STAR_ARTISTIC_GAIN`" CLAIM WAS WRONG.** It
 * justified itself with `CATALOGUE_FLUX_SHARE`, which governs how the sky's FLUX is
 * partitioned for the SH irradiance bake — nothing to do with a display-side lift.
 * **The two gains answer different questions and must be tuned separately:** this
 * one lifts a surface with a real, well-defined surface brightness (so it IS a lie
 * about a physical quantity), while the star gain stands in for the eye's PSF
 * concentration of an UNRESOLVED point source, which has no surface brightness in
 * this renderer at all. See `STAR_ARTISTIC_GAIN` for that derivation.
 *
 * ⚠ Phase 7 does NOT reduce the need for this gain, and an earlier note claiming it
 * would was wrong: desaturation adds no level, and our sky is warm (measured
 * S/P 0.79–0.84), so full scotopic makes the Milky Way 0.3–0.5 stops DIMMER.
 *
 * 🔑 THE ACTUAL FIX is a per-pixel sky mask so the gain can move after the retina
 * stage — see P7d-ii in docs/LIGHTING_PLAN.md for why alpha, depth and `(1 − s)`
 * all fail. Until then this gain is a KNOWN, BOUNDED lie: `__lum.scotopic()` prints
 * exactly what it costs the driver, every run.
 */
export const SKY_ARTISTIC_GAIN = 1024.0;

const SKY_RADIANCE_SCALE =
  SKY_DIFFUSE_TARGET_NITS / NITS_PER_GAME_UNIT / SKY_TEXTURE_MEAN_LINEAR;

type Props = {
  url?: string;
};

/** Reused mask for the capture camera; allocated once, never per frame. */
const _captureLayers = new THREE.Layers();

/**
 * Renders the star panorama as a large inverted sphere instead of scene.background.
 * This avoids issues with the WebGPU renderer's internal background caching
 * when using a cloned camera in a portal scene.
 */
export default function MilkyWaySkybox({
  url = "/assets/8k_milkyway_diffuse.ktx2",
}: Props) {
  const tex = useKTX2(url);

  // ⚠ DECLARED BEFORE the material useMemo, which closes over it. Putting it after
  // is a temporal dead zone: the memo callback runs during the same render and would
  // throw "Cannot access 'uSkyLod' before initialization". TypeScript does not track
  // TDZ across closures, so tsc passed it — the React Compiler lint rule is what
  // caught it. Same ordering StarField uses for uQuadWorld/uPsfNorm.
  const uSkyLod = useMemo(() => uniform(0), []);

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
      //
      // ⚠ The mapping itself lives in `skyPanoramaMapping.ts` and is SHARED with
      // `skyIrradiance.ts`, which integrates this same sky into the SH-L2 light
      // probe. A second copy here is precisely the defect D32 was: if the bake and
      // the render disagree about where the galactic centre is, the hull is lit by
      // a sky that is not the sky on screen, and the picture cannot show you that.
      // ── ⚠⚠ EXPLICIT LOD 0 — this is what kills the seam and the pole smear ──
      // MEASURED: the shipped KTX2 carries **levelCount = 14**, a full mip chain down
      // to 1×1. `generateMipmaps = false` only stops THREE from generating mips; the
      // file's own levels are uploaded regardless. At the UV singularities the
      // derivative explodes — u wraps a full turn in one pixel at the RA 12h seam,
      // and every u converges at the celestial poles — so implicit LOD selection
      // picks the coarsest levels, and level 13 IS the texture's global average.
      //
      // 🔑 THE OBSERVATION THAT DIAGNOSED IT: the seam line reads DARK grey against
      // bright sky and LIGHT grey against dark sky. Nothing about a wrap mode or a
      // mismatched edge inverts contrast like that — only something pulling values
      // toward the global mean, which is exactly a 1×1 mip.
      //
      // Forcing LOD 0 is free here: the panorama is 360/8192 = 0.044°/texel against
      // roughly 0.034°/screen-pixel at 75° vFOV, so the sky is slightly MAGNIFIED and
      // level 0 is already the correct level everywhere on screen. Nothing is lost by
      // taking the choice away from the derivative.
      //
      // ⚠ BUT NOT A HARD ZERO — that claim was wrong. At 1080p the screen is COARSER
      // than the texture (0.056°/px against 0.044°/texel), so a forced level 0 would
      // alias the dust. So the LOD is computed ANALYTICALLY once per frame instead:
      // the sky is a sphere at fixed radius, so its angular scale is uniform and ONE
      // global LOD is genuinely correct. The GPU's per-pixel derivative only differs
      // from that constant AT the singularities — which is precisely the artefact.
      // Measured LODs: 0.17 at 1783p, 0.89 at 1080p, 0 (clamped) at 2160p — small
      // numbers, which is itself the proof that the artefact came from the GPU
      // selecting drastically coarser levels than the geometry warrants.
      //
      // ⚠ The residual pole artefact is geometric, not filtering: at the exact pole
      // many screen pixels map to the same texel row, so a correct LOD leaves
      // 1-texel-wide radial streaks of REAL data instead of mip mush. Fixing that
      // properly needs a progressive polar low-pass in the ASSET (the equirect
      // over-samples u by 1/cos(dec), so those rows carry no information such a
      // low-pass would destroy).
      const rgb = vec3(
        tslTexture(
          tex,
          panoramaUvFromGameDir(normalize(positionLocal)),
        ).level(uSkyLod),
      );
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
  }, [tex, uSkyLod]);


  // ── Kick the SH-L2 irradiance bake, once (S4) ─────────────────────────────
  // Triggered from HERE because this component owns both inputs the bake needs:
  // the shipped texture and `SKY_RADIANCE_SCALE`, the calibration that turns its
  // texels into absolute radiance. Putting the bake anywhere else would mean
  // passing the calibration around, i.e. a second place for it to go stale.
  //
  // Inside `useFrame` rather than an effect so the render-to-target happens at a
  // safe point in the frame, and deferred a few frames so the KTX2 upload has
  // certainly completed — sampling a not-yet-uploaded texture would bake a black
  // sky, and a silently-black probe is the hardest kind of bug to notice.
  const camera = useThree((s2) => s2.camera as THREE.PerspectiveCamera);
  const size = useThree((s2) => s2.size);
  useFrame(() => {
    const texW = (tex.image as { width?: number } | undefined)?.width ?? 8192;
    // Same `tanPerPx` shape StarField uses — the projection is linear in tan(angle).
    const tanPerPx =
      (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(size.height, 1);
    const radPerTexel = (2 * Math.PI) / texW;
    uSkyLod.value = Math.max(0, Math.log2(tanPerPx / radPerTexel));
  });

  const renderer = useThree((s2) => s2.gl);
  const scaledScene = useThree((s2) => s2.scene);

  const bakeState = useRef({ frames: 0, done: false });
  useFrame(() => {
    const st = bakeState.current;
    if (st.done) return;
    if (st.frames++ < 4) return;
    st.done = true;
    // ⚠ `SKY_RADIANCE_SCALE` ONLY — NOT × SKY_ARTISTIC_GAIN. The gain is applied
    // once, on `LightProbe.intensity` in `SkyLight.tsx`. Multiplying it in here as
    // well double-counts it (1024² = 1.05e6×), and it would be invisible: the hull
    // would just look "too bright" in a scene where nothing else is a reference.
    // This is the same cancellation trap as the Venus trim in LIGHTING_PLAN — two
    // places applying one factor is always one place too many.
    void bakePanoramaSh(renderer as never, tex, SKY_RADIANCE_SCALE).then((ok) => {
      if (!ok) st.done = false;
    });

    // ── S4b: capture the sky into the environment cube ─────────────────────
    // Same one-shot trigger, and from here because `useThree` inside this portal
    // resolves to the SCALED scene — the one that holds the panorama and the
    // starfield. The camera renders only SKY_CAPTURE_LAYER, so the planets that
    // share this scene stay out of the reflections (they move; the sky does not).
    _captureLayers.set(SKY_CAPTURE_LAYER);
    captureSkyCube({
      renderer: renderer as never,
      scene: scaledScene,
      layers: _captureLayers,
      withCaptureResolution: withStarCaptureResolution,
      readPsfInputs: getStarPsfInputs,
      readPsfNorm: getStarPsfNorm,
    });
  });

  // ⚠ ENABLE, not set: the mesh must stay on layer 0 for the on-screen render and
  // additionally appear on the capture layer.
  const meshRef = useRef<THREE.Mesh>(null!);
  useFrame(() => {
    if (meshRef.current && !meshRef.current.layers.isEnabled(SKY_CAPTURE_LAYER)) {
      meshRef.current.layers.enable(SKY_CAPTURE_LAYER);
    }
  });

  // Render at a large radius within the scaled camera's far plane.
  // depthWrite=false ensures it never occludes other scaled objects.
  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      material={material}
      scale={[1_000_000, 1_000_000, 1_000_000]}
      frustumCulled={false}
      renderOrder={-1000}
    />
  );
}
