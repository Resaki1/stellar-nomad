import * as THREE from "three";
import { eclipseVisibilityNode } from "../bodyEclipse";
import {
  fract,
  Fn,
  uniform,
  texture,
  uv,
  normalWorld,
  positionWorld,
  positionLocal,
  tangentWorld,
  bitangentWorld,
  cameraPosition,
  vec2,
  vec3,
  vec4,
  float,
  dot,
  normalize,
  mix,
  clamp,
  pow,
  exp,
  reflect,
  length,
  smoothstep,
  Discard,
  int,
} from "three/tsl";
import {
  PLANET_POSITION_KM,
  PLANET_RADIUS_KM,
  STAR_RADIUS_KM,
} from "@/sim/celestialConstants";
import { kmToScaledUnits } from "@/sim/units";
import type { CelestialBodyConfig } from "../types";
import { buildEarthClouds } from "./earthClouds";
import {
  REAL_WEATHER_MAP,
  REAL_WEATHER_MAP_PATH,
} from "./cloudShared";
import { CLOUD_OUTER_ALTITUDE_KM } from "./cloudShared";
import {
  EARTH_ATMOSPHERE,
  EARTH_SUN_ILLUMINANCE_AUTHORED,
} from "./atmosphereData";
import { getAtmosphereBody } from "@/components/space/atmospherePass";
import { surfaceRadiance,
} from "@/components/space/photometry";
import {
  getAtmosphereLUTs,
  transmittanceLutUv,
} from "@/components/space/atmospherePass";
import {
  cloudShadowAt,
  cloudShadowStrengthNode,
} from "@/components/space/cloudShadowMap";

export { PLANET_POSITION_KM };

// Max darkening the ground cloud-shadow applies to the day term: the lit factor
// is mix(1, T_sun, GROUND_SHADOW_STRENGTH), so thick cloud (T→0) → (1−k)× daylight
// (k=0.85 → 0.15×). DARKENING KNOB #1 (raise toward 1 for near-black shadows).
// Knob #2 is SHADOW_TAU_BOOST in cloudShadowMap.ts (τ contrast — but that also
// lifts optically-THIN clouds into visible shadows, so prefer this knob for pure
// darkness). The legacy fake used 0.7; the crossfade band is small.
const GROUND_SHADOW_STRENGTH = 1.0;
// Grazing-sun shadow fade (cosSunToGeomNormal = sin(sun elevation)). Shadows fade
// to none below GRAZE_LO (~1.7°) and are full above GRAZE_HI (~8.6°) — kills the
// razor-sharp long terminator streaks (twilight diffuses real shadows; the
// sun-ortho map is also unreliable at grazing angles).
const GRAZE_LO = 0.03;
const GRAZE_HI = 0.15;
// Debug overlay: tint shadowed ground magenta to inspect cloud-shadow ↔ cloud
// registration (see the SHADOW_DEBUG block in the fragment). Off = zero cost.
const SHADOW_DEBUG = false;

// ── TERM_DEBUG: an EDGE DETECTOR on one term at a time ──────────────────────
//
// For the "mosaic / sheared-parallelogram tiles on the ground" artefact. Two
// hypotheses have already been wrong about it (the aerial-perspective march, then
// the night-lights map), so this stops guessing and bisects instead.
//
// ⚠⚠ **THE FIRST VERSION OF THIS INSTRUMENT WAS CONFOUNDED AND ITS RESULTS ARE
// VOID.** It showed `|∂term/∂x| + |∂term/∂y|`, on the reasoning that hard edges
// bloom and smooth gradients stay black. **But a screen-space derivative of ANY
// function of an interpolated vertex attribute carries a PER-TRIANGLE-CONSTANT
// JACOBIAN** — `dFdx(uv)` and `dFdx(positionLocal)` are constant within a
// triangle and jump at its edges — so the derivative image is flat-shaded
// parallelograms *for every term*, whether or not that term has anything to do
// with the artefact. Measured consequence: `eclipse`, `cloudShadow`, `fakeCloud`,
// `specMask`, `normalCos` and `sunT` ALL showed the tiling, and `eclipse` showed
// it strongest simply because it has the steepest spatial gradient of the six.
// 🔑 **An instrument that responds to every input is not measuring the input.**
//
// So this now shows `fract(term · TERM_DEBUG_BANDS)` — iso-contours of the term
// itself, no derivative. A smooth term gives smooth curved bands; a term carrying
// a texel lattice, a compression block or a facet gives bands with visible KINKS
// or stair-steps at exactly those boundaries. Contours also make a 1/N change
// legible without a gain, which is what the greyscale version could not do.
//
// ⚠ Pair it with `ATMO_BYPASS` in atmospherePass.ts — otherwise the atmosphere
// composites `scene·T + L` over the viz and its in-scatter dominates the image.
//
// Method: set to a term, reload, and look for CONTOUR BANDS THAT KINK. Smoothly
// curved bands exonerate the term; staircased or lattice-aligned bands convict
// it.
type TermDebug =
  | "off"
  | "final"       // the finished reflectance — the instrument's own sanity check
  | "eclipse"     // D34 per-pixel star occlusion
  | "cloudShadow" // groundShadowLight: BSM ⊕ the legacy fake, after grazeFade
  | "fakeCloud"   // just the legacy texClouds-at-an-offset term
  | "specMask"    // earth_specular (2048×1024, lossy) — ocean/land mask
  | "dayTex"      // earth_day (5400×2700, lossy 4:2:0)
  | "normalCos"   // cosSunEff, i.e. the normal map's effect on N·L
  | "sunT";       // the transmittance-LUT sun tint
const TERM_DEBUG: TermDebug = "off";
// Contour density. 100 bands across a [0,1] term; raise it to resolve a finer
// structure, lower it if the bands alias into moire.
const TERM_DEBUG_BANDS = 100.0;

const EARTH_ROTATION = new THREE.Euler(0.0, 0.15 * Math.PI, 0.8 * Math.PI);

// ── Normal-map strength, and why it must fade at grazing sun ──────────────
// ⚠ MITIGATION FOR A BAD ASSET, not a physical model. Do not "clean this up".
//
// `earth_normal.ktx2` is 2048×1024 from a 58 KB WebP (0.028 bytes/px, vs the
// 8K/1.5 MB albedo beside it). MEASURED on the decoded source: the ocean, which
// should be exactly (128,128,255) everywhere, holds only TWO distinct values per
// channel — R∈{126,128}, G∈{127,128} — in flat, hard-edged, axis-aligned
// patches. That is 1 LSB = 1.00° of SPURIOUS TILT.
//
// A 1° error is nothing at normal incidence (1% of brightness). But a true
// Lambert cosine amplifies any tilt error by 1/cosθ, so the SAME 1° becomes:
//     cosθ 0.20 (78° SZA) →  ±7%
//     cosθ 0.10 (84° SZA) → ±14%
//     cosθ 0.05 (87° SZA) → ±28%
// — a ±28% hard-edged step across what should be featureless ocean. That is the
// "squares near the terminator" artifact, and it appeared the moment the day
// term stopped being a saturated sigmoid (which pinned the modulation at a
// constant ~1% and hid it everywhere).
//
// A quantisation deadzone was tried and REJECTED by measurement: 96% of Sahara
// and 95% of Himalaya texels also sit within 2 LSB, so the map's signal-to-
// quantisation ratio is ≈1 over almost its whole area. There is nothing to
// threshold against — the asset simply lacks the precision to drive
// grazing-incidence lighting, and only a better map fixes that properly.
//
// So: keep full normal strength where the map is trustworthy and fade to the
// geometric normal over the last ~12° before the terminator. Defensible beyond
// the artifact — sub-texel relief SELF-SHADOWS at grazing incidence, so naive
// N'·L over-predicts contrast there anyway, and fading toward geometric is a
// conservative stand-in for the masking term we do not compute. Relief still
// reads strongly from 75–85° SZA, where 1/cosθ is already a 4–10× amplifier.
// ⇒ RAISE GRAZE_LO/HI toward 0 once the normal map is re-sourced at adequate
// precision (16-bit, or baked from elevation instead of a lossy 8-bit image).
const NORMAL_MAP_STRENGTH = 0.8;
const NORMAL_GRAZE_LO = 0.05; // ≥87° SZA → geometric normal only
const NORMAL_GRAZE_HI = 0.25; // ≤75° SZA → full normal map

// ── Atmosphere↔surface lighting coupling (Phase 3b, docs/ATMOSPHERE_PLAN.md §5.4) ──
// When ON, the day-lit surface (+ ocean sun-glint + flat cloud overlay) is tinted
// by the PHYSICAL sun transmittance from the shared LUT — sampled at ground
// radius + sun-zenith cos, so the slant path reddens the terminator correctly —
// NORMALISED by the zenith transmittance so noon brightness is unchanged (only
// the angular reddening shows). This REPLACES the fake `warmTint` terminator
// tint and the cloud warm-mix (which double-counted with the atmosphere pass).
// Build-time JS const → the OFF path keeps those hand-tuned tints (A/B + revert).
const USE_ATMOSPHERE_SURFACE_LIGHTING = true;
const SURFACE_SUN_SCALE = 1.0; // overall multiplier on the (zenith-normalised) tint

// Cloud DECK top altitude (km) — the reference for the shell fade below.
// Imported from cloudShared (T2): the old hand-mirrored copy of earthClouds'
// constant is gone — a slab change now propagates here automatically.
const CLOUD_TOP_ALTITUDE_KM = CLOUD_OUTER_ALTITUDE_KM;

// Far-field cloud SHELL fade band (ISSUE 2 Phase 2), driving uShellOpacity in
// onFrame. The shell (sphere at cloud-top radius) is full above the deck and
// off at/below it. FrontSide already culls it from inside the sphere; this fade
// smooths the deck-top crossing and removes it just before the camera enters
// the deck. Widen the gap / raise FULL if the deck-top crossing pops; lower
// FULL toward the deck to reduce the shell filling volumetric gaps up close
// (trade-off: less far-field coverage at low altitude).
const SHELL_FADE_OFF_ALT_KM = CLOUD_TOP_ALTITUDE_KM; // 14 — off at/below the deck top
const SHELL_FADE_FULL_ALT_KM = 28; // full above this altitude

// Volumetric crossfade altitudes (drives uVolumetricBlend in onFrame).
// ALTITUDE-based (2026-06-10; was distance-based 35k→25k km, i.e. blend = 1
// from ~28,600 km altitude down — the volumetric marcher then ran at FULL
// cost across that entire range while its 5–10 km features were sub-pixel,
// which is what made orbit views 10–20 fps; SpaceRenderer now skips the cloud
// passes entirely while blend = 0). At 3000 km a 5 km cumulus cell subtends
// ~2 px — below that the volumetric becomes visually meaningful, so ramp it
// in across 3000 → 1500 km and let the flat overlay carry everything higher.
// 2026-07-12 (damascus-rings resolution — see earthClouds SHELL_HANDOFF_*):
// lowered from 3000/1500. Above START the marcher pass is skipped entirely
// (SpaceRenderer gates on uVolumetricBlend), so this now ALSO caps the march
// to the near field — a perf win at orbit AND it stops the volumetric from
// contributing its coarse-sampled (ringing) colour where the shell already
// carries the far field. Keep FULL ≥ the altitude where the volumetric is
// still finely sampled and START aligned with SHELL_HANDOFF_FAR_KM so the
// crossover (volumetric fade-out ↔ shell fade-in) lands in one band.
const VOLUMETRIC_BLEND_START_ALT_KM = 700;
const VOLUMETRIC_BLEND_FULL_ALT_KM = 250;

// ── TSL eclipse function: PROMOTED to ../bodyEclipse.ts (D34) ──────────────
// The circle-circle overlap that used to live here now serves every body, in
// both directions, driven by the sun-occluder registry rather than a hardcoded
// `uMoonPos`. It is imported as `eclipseVisibilityNode`.

// ─────────────────────────────────────────────────────────────────────
// Shared Earth fragment node builder
// ─────────────────────────────────────────────────────────────────────

// ── D23 — CLOSED BY MEASUREMENT, NO CODE. Read this before touching the ocean.
//
// D23 said: *"the day texture's dark end is crushed — deep Pacific 0.0014 vs a
// real 0.03–0.06, ocean 21–43× too dark."* Both halves of that were wrong, and
// the fix that followed from it was removed after it measured as a no-op. The
// whole investigation is in docs/LIGHTING_PLAN.md D23 / D23b / D23c; the parts
// worth having in front of you while editing this shader:
//
// **1. The 21–43× was a UNITS ERROR** — a visible-band, luminance-weighted
// texture value compared against a BROADBAND (NIR-inclusive) albedo. Water and
// chlorophyll have near-zero visible reflectance and a huge NIR plateau, so a
// broadband figure is mostly light an RGB texture cannot carry. ⚠ The tell was in
// D23's own results: the two regions that "passed" were sand and snow — the two
// with FLAT spectra. Re-measured, the day map's global cos-weighted mean is
// **0.08934 = 0.993×** an independent cloud-free surface albedo of 0.0900.
//
// **2. Acting on it would have DOUBLE-COUNTED.** Deep ocean's ~0.06 broadband
// albedo is mostly specular sky reflection, which this shader already adds below
// (Schlick + sky-blue reflection + sun glint). Putting it in the DIFFUSE map
// counts it twice — the violation D22 had just removed from these same lines.
//
// **3. The real per-pixel defect is small and INVISIBLE.** The texture's ocean is
// 88% one flat value that is 4.0× too dark and 3.0× too red. A physical fix was
// implemented (diffuse = water-leaving reflectance + the texture's excess) and
// MEASURED on device in three geometries with `__lum.probe()`:
//
//       orbit 15,000 km   +0.295%   (0.0042 stops)
//       250 km, terminator +0.022%
//       8 km,  terminator  +0.019%
//
//   Extracting the attenuation `A = sunT · nDotL · T(surf→cam)` gives 6.4e-3 at
//   orbit and ~1e-4 at the terminator, so even at the BEST possible geometry —
//   sun overhead, nadir, clear — the term is **4.6% of the pixel, 0.064 stops**.
//   🔑🔑 **The ocean's diffuse albedo is not a visible parameter at any geometry.
//   NEVER chase Earth's ocean appearance through the day map.** The code was
//   removed rather than left as dead cost; a `D23_DEBUG_VIZ` that painted the
//   mask magenta confirmed the path was correct before it was deleted.
//
// **4. ⇒ WHERE THE OCEAN'S LOOK ACTUALLY LIVES, with a number.** That orbital
// pixel read **0.119 game units** where a physical clear-ocean column (reflectance
// ~0.10 at 1 AU) is **0.675** — **5.7× too dark**, and 99.9% of it is the
// atmosphere pass, not this texture. Its B/R was 5.68: Rayleigh, neither water
// nor cloud. **That 5.7× is the live defect and it belongs to
// `atmospherePass.ts`** — LIGHTING_PLAN open item 4b. ⚠ Measure before building:
// the older "clear sky 0.044 vs ~0.12" figure predates several atmosphere fixes.

function buildEarthFragmentNode(opts: {
  texDay: THREE.Texture;
  texClouds: THREE.Texture;
  /** Pass null to skip normal mapping (mid LOD). */
  texNormal: THREE.Texture | null;
  /** Pass null to skip ocean specular (mid LOD). */
  texSpec: THREE.Texture | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSunRel: any;
  /** Per-frame sun illuminance, game units. See FragmentNodeContext. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSunIlluminance: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eclipseU: any;
   

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSunRadius: any;
  // Atmosphere transmittance LUT (Phase 3b surface coupling). Bound at graph-
  // build time; sampled per-pixel for physical sun colour. Optional: when absent

  // (toggle off) the surface keeps its hand-tuned terminator tint.
  transmittanceLUT?: THREE.Texture;
}) {
  const {
    texDay, texClouds, texNormal, texSpec,
    uSunRel, uSunIlluminance, eclipseU, uSunRadius, transmittanceLUT,
  } = opts;
  const detailed = texNormal !== null;

  return Fn(() => {
    const uvCoord = uv();
    const sunDir = normalize(uSunRel);

    const dayCol = texture(texDay, uvCoord).rgb;

    // Geometric normal in world space
    const nGeom = normalize(normalWorld);
    const cosSunToGeomNormal = dot(nGeom, sunDir);

    // ── Atmosphere-coupled sun colour (Phase 3b) ──
    // Physical sunlight reaching the surface, from the SAME transmittance LUT the
    // sky/clouds/ship use, NORMALISED by the zenith transmittance at that
    // altitude (so noon brightness is unchanged; only the angular sunset
    // reddening shows) and clamped ≤ 1 (the sun is never less-attenuated than at
    // zenith). This replaces the fake `warmTint` + cloud warm-mix. Two altitudes:
    //   sunT      — GROUND (terrain + ocean glint): full slant path → DRAMATIC
    //               terminator reddening.
    //   sunTCloud — CLOUD deck (the flat 2D overlay): sampled at cloud altitude
    //               so it reddens MILDLY, matching the volumetric marcher (which
    //               samples cloud-altitude transmittance per-voxel) instead of
    //               the much-redder ground — otherwise the flat clouds stick out.
    // Below-horizon μ clamps the UV harmlessly (night is gated by nDotL). Off
    // → white (no change).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sunT: any = vec3(1, 1, 1);
    if (USE_ATMOSPHERE_SURFACE_LIGHTING && transmittanceLUT) {
      const rgKm = EARTH_ATMOSPHERE.groundRadiusKm;
      const rtKm = rgKm + EARTH_ATMOSPHERE.atmosphereHeightKm;
      const hKm = Math.sqrt(Math.max(0, rtKm * rtKm - rgKm * rgKm));
      // Normalised sun transmittance at radius rKm: T(rKm, μ) / T(rKm, zenith),
      // clamped ≤ 1, × SURFACE_SUN_SCALE. (μ=1 → xMu=0, so the zenith tap is the
      // xR row for that altitude: UV (0,0) at the ground, (0, xR) at altitude.)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sunTAt = (rKm: number): any => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tA: any = texture(
          transmittanceLUT,
          transmittanceLutUv(float(rKm), cosSunToGeomNormal, float(rgKm), float(rtKm), float(hKm)),
        ).level(int(0));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tZen: any = texture(
          transmittanceLUT,
          transmittanceLutUv(float(rKm), float(1), float(rgKm), float(rtKm), float(hKm)),
        ).level(int(0));
        return tA.rgb.div(tZen.rgb.max(float(1e-4))).clamp(0, 1).mul(float(SURFACE_SUN_SCALE));
      };
      sunT = sunTAt(rgKm);
    }

    // ── Sun geometry ──
    // The effective sun cosine. Starts geometric; the normal map perturbs it in
    // the detailed branch below. Everything angular derives from this ONE value,
    // split into a Lambert term and a visibility term after the branch — see the
    // block after the cloud-shadow section.
    const cosSunEff = cosSunToGeomNormal.toVar();

    // ── Eclipse coverage (D34) ──
    // ⚠⚠ WAS HARDCODED TO LUNA: this read `uMoonPos`/`uMoonRadius`, so Earth
    // could only ever be eclipsed by one named body. Now it consumes the SHARED
    // occluder slots every `CelestialBody` fills from the sun-occluder registry,
    // so any body — or a procedurally generated moon — casts a real shadow here.
    //
    // 🔑 Earth keeps its OWN call rather than taking `CelestialBody`'s generic
    // per-pixel multiply (`config.ownEclipse = true`), because coverage feeds
    // `sunVis` below, which additionally switches CITY LIGHTS ON inside a total
    // eclipse and gates the ocean specular and the terminator band. A flat
    // multiply on the finished fragment cannot do any of that. ⚠ Taking both
    // would square the shadow.
    const surfacePosW = positionWorld;
    const distEarthToSun = length(uSunRel);
    const eclipseAmount = eclipseVisibilityNode(eclipseU);

    // ── Detail-dependent: normal mapping + cloud shadow ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let nMapped: any = nGeom;
    const cloudShadowVal = float(0).toVar();
    // TERM_DEBUG captures. Zero cost when TERM_DEBUG is "off" — these are plain
    // vars the dead-code pass removes along with the debug return below.
    const dbgSpecMask = float(0).toVar();
    // The ground cloud-shadow lit factor (1 = lit, <1 = shadowed), captured for
    // the SHADOW_DEBUG overlay below.
    const groundShadowLight = float(1).toVar();

    if (detailed && texNormal) {
      // Normal mapping via TBN
      const tN = texture(texNormal, uvCoord).xyz.mul(2).sub(1);
      // three/tsl's normalize() overloads don't accept the tangent/bitangent
      // attribute node types, though they are valid vec3 nodes at runtime.
      // Cast the input to the same node type normalWorld uses (accepted above).
      const tW = normalize(tangentWorld as unknown as typeof normalWorld);
      const bW = normalize(bitangentWorld as unknown as typeof normalWorld);
      nMapped = normalize(
        tW.mul(tN.x).add(bW.mul(tN.y)).add(nGeom.mul(tN.z))
      );

      // Normal-map perturbation of the sun cosine. This used to be a MULTIPLICA-
      // TIVE relative delta, `× (1 + 0.8·Δcos)`, because the old day term was a
      // saturated sigmoid you could not simply re-evaluate at a new angle. On a
      // true cosine the same intent is just the additive blend it always meant:
      // mix(a, b, 0.8) ≡ a + 0.8·(b − a). Strength 0.8 is preserved verbatim.
      const cosSunToMappedNormal = dot(nMapped, sunDir);
      // Strength fades to 0 at grazing sun — see NORMAL_MAP_STRENGTH above for
      // the measurement that forces this (1 LSB of an 8-bit normal map = 1.00°
      // of tilt, which N·L amplifies by 1/cosθ into a ±28% hard-edged step at
      // 87° SZA over what should be flat ocean).
      const normalStrength = float(NORMAL_MAP_STRENGTH).mul(
        smoothstep(
          float(NORMAL_GRAZE_LO),
          float(NORMAL_GRAZE_HI),
          cosSunToGeomNormal,
        ),
      );
      cosSunEff.assign(
        mix(cosSunToGeomNormal, cosSunToMappedNormal, normalStrength)
      );

      // Cloud shadow: project sun onto tangent plane for shadow offset
      const sunOnSurface = sunDir.sub(nGeom.mul(cosSunToGeomNormal));
      // Shadows stretch at grazing sun angles (longer projection of cloud height)
      const shadowUV = vec2(
        dot(tW, sunOnSurface),
        dot(bW, sunOnSurface)
      ).mul(float(0.0015).div(cosSunToGeomNormal.max(0.12)));

      // ── Ground cloud shadow: legacy FAKE crossfaded → the Beer Shadow Map ──
      // FAKE (texClouds.r at a sun-projected UV offset): the high-altitude
      // fallback, since the BSM only bakes below BSM_MAX_ALT_KM.
      const cs1 = texture(texClouds, uvCoord.add(shadowUV.mul(0.4))).r;
      const cs2 = texture(texClouds, uvCoord.add(shadowUV)).r;
      cloudShadowVal.assign(cs1.mul(0.6).add(cs2.mul(0.4)));
      const fakeLight = float(1.0).sub(float(0.7).mul(cloudShadowVal));
      // BSM (L1): physical sun transmittance. positionLocal is the surface's
      // object-space position = scaled-km, earth-fixed = the BSM's exact
      // earth-model frame, so no transform is needed. cloudShadowAt already folds
      // in the freshness `strength` gate (→ 1 above the bake ceiling).
      const bsmLight = mix(
        float(1.0),
        cloudShadowAt(positionLocal),
        float(GROUND_SHADOW_STRENGTH),
      );
      // Crossfade by the SAME strength: low alt (strength→1) → pure BSM (no
      // double-count with the fake); high alt (strength→0) → pure fake. The band
      // is small (SpaceRenderer BSM_FADE_BAND_KM) so the handoff is seamless.
      const shadowLight = mix(fakeLight, bsmLight, cloudShadowStrengthNode());
      // ── Grazing-sun fade ──
      // As the sun drops toward the horizon (cosSunToGeomNormal = sin(elevation)
      // → 0 at the terminator) the projected shadow degenerates into long, razor-
      // sharp streaks — physically WRONG: at grazing sun the penumbra widens and
      // twilight scattering washes shadows out. Also the sun-ortho map is
      // unreliable there (rays exit the window). So fade the shadow toward "lit"
      // below ~GRAZE_HI elevation. Fades the fake too (uniform look through the
      // BSM→fake handoff).
      const grazeFade = smoothstep(
        float(GRAZE_LO),
        float(GRAZE_HI),
        cosSunToGeomNormal,
      );
      groundShadowLight.assign(mix(float(1.0), shadowLight, grazeFade));
    }

    // ── Lambert cosine vs sun visibility (lighting Phase 2b, defect D08) ──
    // TWO DISTINCT QUANTITIES that used to be conflated into one `dayAmount`:
    //
    //   nDotL  — the LAMBERT COSINE, multiplying the diffuse albedo. Real
    //            photometry: irradiance on a tilted surface is E·cosθ.
    //   sunVis — the SUN-ABOVE-HORIZON gate. NOT a lighting term; it answers
    //            "can this point see the sun at all". Gates the ocean specular
    //            + fresnel and drives the city-light mask.
    //
    // The old code used sunVis's sigmoid, 1/(1+exp(−40·cosθ)), for BOTH. That
    // is ≥0.98 for every cosθ > 0.1, so the day disc was flat-lit right up to
    // the terminator — a uniform bright wall instead of a sphere curving into
    // shadow. Sub-solar radiance is UNCHANGED by this fix (cosθ = 1 → 1 either
    // way, so the __lum probe should not move); the disc AVERAGE drops by the
    // Lambert 2/3, i.e. 0.58 stops.
    //
    // Specular deliberately keeps the visibility gate rather than the cosine: a
    // glint does not fade as cosθ. In a microfacet BRDF the 1/(4·cosθᵢ·cosθₒ)
    // denominator cancels the incident cosine outright, and Fresnel climbs
    // toward grazing — which is exactly why the sunset glint is the bright one.
    //
    // SOFT TERMINATOR from the star's FINITE ANGULAR RADIUS: sinSunR = R★/d
    // (0.00465 at 1 AU → a 0.53°-wide band, invisible here). It is in for the
    // procedural-systems requirement (§3.0): a close-orbiting red dwarf
    // subtends degrees and gets a correctly soft terminator with no per-system
    // tuning. Irradiance from a partly-risen disc is ≈(cosθ+r)²/(4r), which is
    // continuous in BOTH value and slope with cosθ at cosθ = r. Written
    // branch-free by clamping the argument into the band and adding the linear
    // part above it — the `.max(0)` term is 0 inside the band, and the
    // quadratic saturates to exactly r at the band's top.
    const sinSunR = clamp(uSunRadius.div(distEarthToSun), 1e-4, 1);
    const cosBand = clamp(cosSunEff, sinSunR.negate(), sinSunR).add(sinSunR);
    const nDotL = cosBand
      .mul(cosBand)
      .div(sinSunR.mul(4))
      .add(cosSunEff.sub(sinSunR).max(0))
      .clamp(0, 1)
      .toVar();
    // Twilight-width visibility ramp. Kept at the legacy sigmoid steepness (±3°
    // in sun elevation) rather than the geometric 0.53°: the city lights and the
    // terminator band are authored against this width, and ±3° is a fair stand-in
    // for real twilight (civil twilight runs to −6°).
    const sunVis = float(1.0)
      .div(float(1.0).add(exp(float(-40).mul(cosSunEff))))
      .toVar();

    // Shared occluders — lunar eclipse and the ground cloud shadow — attenuate
    // both terms. (`groundShadowLight` is 1 on the non-detailed tier.)
    const occlusion = eclipseAmount.mul(groundShadowLight);
    nDotL.mulAssign(occlusion);
    sunVis.mulAssign(occlusion);

    // ── Terminator warm tones (Rayleigh at low sun angles) ──
    const terminatorBand = smoothstep(float(0), float(0.5), sunVis)
      .mul(smoothstep(float(1), float(0.5), sunVis));
    const warmTint = vec3(1.0, 0.6, 0.3);

    // (The flat cloud overlay that sampled texClouds here was removed in ISSUE 2
    // Phase 2 — the cloud shell carries the far field now. texClouds is still
    // sampled above for the ground cloud-shadow (cloudShadowVal).)

    // ── NIGHT LIGHTS REMOVED (2026-08-28) ────────────────────────────────────
    // Earth carried an 8K/2K `earth_night` emissive map for city lights. Gone,
    // for two independent reasons.
    //
    // 1. **THE SETTING.** The game is post-apocalyptic: there is nobody left to
    //    switch a light on. If city lights ever come back they should come from
    //    the settlement/faction state that actually exists in the sim, not from a
    //    baked 2001-era photograph of a populated Earth — then a rebuilt city
    //    lights up and an abandoned one does not.
    //
    // 2. 🐛 **IT WAS WIRED TO THE WRONG QUANTITY, AND `CelestialBody.tsx` SAID SO
    //    WITHOUT CHECKING.** The mask was `smoothstep(0.15, 0, sunVis)`, but
    //    `sunVis` has the eclipse multiplied into it a dozen lines above
    //    (`sunVis.mulAssign(occlusion)`). So a body passing in front of the sun
    //    switched the city lights ON — in broad daylight, in a few minutes, which
    //    no real city does. The D34 note in `CelestialBody.tsx` asserts the
    //    opposite invariant — *"city lights are gated by their own nightMask
    //    (sun-above-horizon), so inside a DAYTIME solar-eclipse spot they are
    //    already off"* — and that was simply not true of this code.
    //    🔑 A night mask is a HORIZON question (`cosSunEff`), never a
    //    sun-visibility question. Occlusion and elevation are not the same thing.
    //
    // 3. It is a genuinely bad asset, though ⚠⚠ **NOT the eclipse-shadow artefact
    //    I claimed it was — the tiling survived its removal.** `earth_night_8k` is
    //    a lossy VP8 4:2:0 WebP re-encoded into UASTC, and MEASURED on the decoded
    //    source its dark regions are DC-flat 8×8-texel tiles — zero variation
    //    inside a tile in both axes, stepping ~8% at the boundaries. At 4.89
    //    km/texel that is a 39 km hard-edged mosaic inside 78 km macroblocks, and
    //    inside the umbra `nightMask → 1` made that map the only ground term. All
    //    true, and all beside the point.
    //    ⚠⚠ THE TRAP, worth more than the measurement: "an Io transit on Jupiter
    //    is clean, and Earth is the only body with a night texture" is CONSISTENT
    //    WITH that hypothesis and does not TEST it — every other Earth-only input
    //    (day map, normal map, specular mask, the BSM, the whole cloud pipeline)
    //    explains it equally well. 🔑 A discriminating test is one the RIVAL
    //    hypotheses fail. Reasons 1 and 2 are why this stays removed.
    //
    // ⇒ Earth's night side is now unlit: black bounded by the atmosphere's
    // twilight limb, which is what an uninhabited planet looks like. Moonlight is
    // the physically correct thing to add next (~0.1 lux ⇒ ~1e-6 game units off a
    // 0.3 albedo, so it needs the scotopic/Purkinje work to be visible at all) —
    // docs/LIGHTING_PLAN.md Phase 7 and §3.8.
    const col = dayCol.mul(sunT).mul(nDotL).toVar();

    // ── SHADOW_DEBUG: cloud-shadow / cloud registration overlay ──
    // Build-const (dead-eliminated when off). Tints shadowed ground MAGENTA over
    // the normal surface so the shadow SHAPE is unmistakable — fly so both the
    // rendered clouds and the ground are in view and check each magenta patch
    // sits anti-sunward of a cloud (the physical offset). A magenta patch with NO
    // cloud sun-ward of it ⇒ real coverage/projection mismatch; an offset that
    // grows with sun-grazing but tracks a cloud ⇒ correct. Near-tier only.
    if (SHADOW_DEBUG) {
      return vec4(mix(vec3(1, 0, 1), col, groundShadowLight), 1);
    }


    // Apply terminator warmth -- reduced for mid LOD where the smooth geometric
    // normal makes the band bleed across the entire day side. Phase 3b: skipped
    // when the surface is physically transmittance-lit (sunT already reddens the
    // terminator); kept on the OFF path so the A/B baseline is unchanged.
    if (!USE_ATMOSPHERE_SURFACE_LIGHTING) {
      const terminatorStrength = float(detailed ? 0.25 : 0.06);
      col.assign(mix(col, col.mul(warmTint), terminatorBand.mul(terminatorStrength)));
    }

    // ── Ocean specular ──
    const viewDir = normalize(cameraPosition.sub(surfacePosW));
    const viewDotNRaw = dot(viewDir, nGeom);

    if (texSpec) {
      const specMask = texture(texSpec, uvCoord).r;
      dbgSpecMask.assign(specMask);
      // ⚠ GEOMETRIC normal, not `nMapped` — D21 again, in the glint this time.
      // `earth_normal` carries LAND relief; its ocean is a uniform
      // (128,128,255), so every wrinkle it has over water is quantisation noise
      // (1 LSB = 1.00° of tilt). A reflection doubles an angular error, and
      // pow(·,40) is steepest ~10° off-axis, so that 1° reproduced the exact
      // same hard-edged squares inside the sun glint that it produced at the
      // terminator. Water carries no terrain, so this is also just correct: the
      // map has no wave data to contribute. Real glint breakup needs an actual
      // wave normal, which is a separate asset.
      const refl = reflect(sunDir.negate(), nGeom);
      const specAngle = dot(refl, viewDir).max(0);
      const specHighlight = pow(specAngle, float(40.0)).mul(0.8).mul(specMask);
      const specBroad = pow(specAngle, float(8.0)).mul(0.15).mul(specMask);
      // Sun glint is reflected sunlight → tint by the same transmittance (Phase
      // 3b); reddens the glint at sunset. (The fresnel sky-reflection below is
      // skylight, not sun, so it is left as the fixed sky-blue.)
      col.addAssign(sunVis.mul(sunT).mul(specHighlight.add(specBroad)));

      // ── Fresnel ocean reflection + land limb darkening ──
      const vDotN = clamp(viewDotNRaw, 0, 1);
      const oneMinusVdotN = float(1.0).sub(vDotN);
      // Schlick Fresnel: F = F0 + (1−F0)·(1−cosθ)⁵, F0 ≈ 0.02 for water.
      // ⚠ This was written as `0.02 + 2.0·(1−cosθ)^2.5`, which is not Schlick
      // and is not bounded: it PEAKS AT 2.02, i.e. the ocean returned twice the
      // light falling on it — the plan's own `R > 1` test, failed outright. It
      // ran 7.3× hot at a 60° view angle (0.374 vs 0.051), which is what lifted
      // the ocean toward the limb into a bright blue wash and flattened the
      // contrast the clouds need to read against. Correct Schlick maxes at 1.0
      // exactly, at true grazing.
      const fresnel = float(0.02).add(
        float(0.98).mul(pow(oneMinusVdotN, float(5.0)))
      );
      // Ocean reflects atmosphere blue at grazing angles
      col.addAssign(
        vec3(0.0, 0.25, 1.0).mul(fresnel).mul(specMask).mul(sunVis)
      );

      // Land: rough diffuse surfaces darken at oblique viewing angles
      const landMask = float(1.0).sub(specMask);
      const limbDarken = pow(vDotN.max(0.05), float(0.3));
      col.mulAssign(float(1.0).sub(landMask.mul(float(1.0).sub(limbDarken))));
    }

    // ── Cloud overlay REMOVED (ISSUE 2 Phase 2) ──
    // The sky-facing flat cloud overlay used to be composited into the surface
    // colour here (white × transmittance, gated by uFlatCloudOpacity + a
    // coverage thinKeep). It is replaced by the dedicated CLOUD SHELL — a sphere
    // at cloud-top radius (earthClouds.ts buildCloudShellMesh) that samples the
    // SAME coverage field + farCloudLit, at the correct altitude (no ground
    // parallax) and decoupled from the surface shader (so any planet gets it).
    // Ground cloud-SHADOWS stay in this shader (cloudShadowVal above darkens the
    // terrain) — the shell neither casts nor receives them.

    // NOTE: the old fake Rayleigh in-scatter/extinction (view-angle desaturation
    // + blue limb glow) lived here. It is now handled physically by the
    // atmosphere pass (atmospherePass.ts), which fogs this surface color with
    // real transmittance + in-scattering. The surface shader outputs ground
    // radiance only; all atmospheric effects are applied downstream.
    // (The terminator warm tint above is superseded by the atmosphere's sunset
    // reddening in Phase 2. `hemiAmount` — a second eclipse-scaled copy of the
    // day term that nothing ever read — was deleted with the Phase 2b split.)

    // Reflectance → RADIANCE: × sunIlluminance/π (docs/LIGHTING_PLAN.md §3.6).
    // Earth's ground was ~6.37× too dark without this, which is what made the
    // cloud tops read ~35× brighter than the ocean beneath them (physically the
    // ratio is 3–12×). ⚠ Nothing is added after this any more — the emissive
    // city-light term that used to be (see the NIGHT LIGHTS REMOVED note above)
    // was the only reason this was not a bare `surfaceRadiance`.
    if (TERM_DEBUG !== "off") {
      const term = (() => {
        switch (TERM_DEBUG) {
          case "final": return col.r.add(col.g).add(col.b).div(3);
          case "eclipse": return eclipseAmount;
          case "cloudShadow": return groundShadowLight;
          case "fakeCloud": return cloudShadowVal;
          case "specMask": return dbgSpecMask;
          case "dayTex": return dayCol.r.add(dayCol.g).add(dayCol.b).div(3);
          case "normalCos": return cosSunEff;
          default: return sunT.r.add(sunT.g).add(sunT.b).div(3);
        }
      })();
      // Iso-contours of the term. Kinked/staircased bands convict it; smoothly
      // curved bands exonerate it. No derivative, so no per-triangle Jacobian.
      return vec4(vec3(fract(term.mul(TERM_DEBUG_BANDS))), 1.0);
    }
    return vec4(surfaceRadiance(col, uSunIlluminance), 1.0);
  })();
}

// ── Custom billboard fragment (Earth with atmosphere rim glow) ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function earthBillboardFragment({ uSpR, uSpU, uSpF }: { albedo: THREE.Color; uSpR: any; uSpU: any; uSpF: any }) {
  return Fn(() => {
    const p = uv().mul(2).sub(1);
    const dist = length(p);

    const edge = smoothstep(float(1.0), float(0.92), dist);
    Discard(edge.lessThan(0.01));

    const domeZ = float(1.0).sub(dist.mul(dist)).max(0).sqrt();

    const sunDot = clamp(
      uSpR.mul(p.x).add(uSpU.mul(p.y)).add(uSpF.mul(domeZ)),
      0, 1,
    );

    // Earth-like coloring.
    const dayAlbedo = vec3(0.38, 0.42, 0.80).mul(2.0);
    const col = dayAlbedo.mul(sunDot).toVar();

    // Atmosphere rim glow on lit side.
    const rimFactor = clamp(float(1.0).sub(domeZ).mul(2.5), 0, 1);
    const atmosColor = vec3(0.3, 0.5, 0.9);
    col.addAssign(atmosColor.mul(rimFactor).mul(sunDot).mul(0.2));

    return vec4(col, edge);
  })();
}

// ─────────────────────────────────────────────────────────────────────

// Far albedo is not used directly by the custom billboard, but the
// FarBillboardConfig requires it. Use a representative blue.
const EARTH_FAR_ALBEDO = new THREE.Color(0.38, 0.42, 0.80);

export const earthConfig: CelestialBodyConfig = {
  id: "earth",
  // D34: Earth applies eclipse coverage inside its OWN shader (it threads it
  // through `sunVis`, which also switches city lights on and gates the ocean
  // specular), so `CelestialBody` must not multiply it again.
  ownEclipse: true,
  positionKm: PLANET_POSITION_KM,
  radiusKm: PLANET_RADIUS_KM,
  rotation: EARTH_ROTATION,
  atmosphere: EARTH_ATMOSPHERE,

  lod: { near: 35_000, far: 1_500_000 },
  near: {
    textures: {
      day: "/textures/earth_day_8k.ktx2",
      clouds: "/textures/earth_clouds_8k.ktx2",
      normal: "/textures/earth_normal.ktx2",
      spec: "/textures/earth_specular.ktx2",
      // Phase 4: the baked ERA5 weather map (see earthClouds
      // REAL_WEATHER_MAP). Injected ONLY when the const is on so a missing
      // file can never wedge tier loading while it's off.
      ...(REAL_WEATHER_MAP ? { weatherV2: REAL_WEATHER_MAP_PATH } : {}),
    },
    segments: 128,
    computeTangents: true,
  },
  mid: {
    textures: {
      day: "/textures/earth_day_2k.ktx2",
      clouds: "/textures/earth_clouds_2k.ktx2",
      spec: "/textures/earth_specular.ktx2",
      ...(REAL_WEATHER_MAP ? { weatherV2: REAL_WEATHER_MAP_PATH } : {}),
    },
    segments: 48,
  },
  far: { albedo: EARTH_FAR_ALBEDO, buildFragment: earthBillboardFragment },
  stellarPoint: { geometricAlbedo: 0.434, color: [0.55, 0.65, 0.95] },

  extraMeshes: buildEarthClouds,

  onTexturesLoaded: (tier, textures) => {
    // ── ANISOTROPY ON THE SURFACE MAPS ───────────────────────────────────────
    // ⚠ MEASURED AS MISSING: only `clouds` and `weatherV2` were ever given a
    // value, so day/normal/spec ran at `Texture.DEFAULT_ANISOTROPY = 1`.
    // At a grazing ground view — flying low, which is exactly where the
    // mosaic-looking terrain was reported — isotropic mip selection takes the
    // MAJOR axis derivative for both axes and drops several mip levels, so a
    // 7.4 km/texel day map is sampled as if it were ~60 km/texel.
    //
    // ⚠ This does NOT fix the block structure baked into the assets themselves
    // (they are lossy VP8 `yuv420p` WebP re-encoded into UASTC, so 4:2:0 chroma
    // cells and DC-flat 8×8 macroblocks are IN the pixels at 4.9–19.6 km/texel).
    // Anisotropy stops us making it worse; the asset fix is a lossless source.
    for (const key of ["day", "normal", "spec"] as const) {
      const t = textures[key];
      if (!t) continue;
      t.anisotropy = tier === "near" ? 8 : 4;
      t.needsUpdate = true;
    }
    if (tier === "near" && textures.clouds) {
      textures.clouds.anisotropy = 8;
      // Shell ray-march samples across the atan2 seam; wrap to avoid a visible line.
      textures.clouds.wrapS = THREE.RepeatWrapping;
      textures.clouds.needsUpdate = true;
    }
    if (tier === "mid" && textures.clouds) {
      textures.clouds.anisotropy = 4;
    }
    if (textures.weatherV2) {
      // DATA channels, not colour: force NoColorSpace even if the ktx2 was
      // accidentally converted without --linear (the §4.7 sRGB footgun — an
      // sRGB decode would silently corrupt coverage/convectivity/topHeight).
      // Longitude wraps (equirect atan2 seam), latitude clamps.
      textures.weatherV2.colorSpace = THREE.NoColorSpace;
      textures.weatherV2.wrapS = THREE.RepeatWrapping;
      textures.weatherV2.wrapT = THREE.ClampToEdgeWrapping;
      textures.weatherV2.anisotropy = 4;
      textures.weatherV2.needsUpdate = true;
    }
  },

  createUniforms: () => ({
    uSunRadius: uniform(kmToScaledUnits(STAR_RADIUS_KM)),
    // Volumetric crossfade (0 = far / shell only, 1 = volumetric near field).
    // Driven from camera ALTITUDE in onFrame; gates the whole marcher pipeline
    // in SpaceRenderer (read via ctx.uniforms.uVolumetricBlend + getVolumetricBlend).
    uVolumetricBlend: uniform(0),
    // Far-field cloud SHELL opacity (ISSUE 2 Phase 2). Shared across near+mid
    // tiers (read by buildCloudShellMesh via ctx.uniforms). Value 1 for now;
    // step 5 drives it from altitude to fade the shell out below the deck.
    uShellOpacity: uniform(1),
    // Per-frame sun illuminance for the far cloud shell. This used to be a
    // COMPILE-TIME LITERAL baked from EARTH_ATMOSPHERE.sunIlluminance into the
    // shell's shader — a second static bake alongside D17 (see
    // docs/LIGHTING_PLAN.md §3.0). Initialised to the authored value so frame 0
    // matches, then overwritten every frame from the atmosphere record below.
    uSunIlluminance: uniform(
      new THREE.Vector3(
        EARTH_SUN_ILLUMINANCE_AUTHORED,
        EARTH_SUN_ILLUMINANCE_AUTHORED,
        EARTH_SUN_ILLUMINANCE_AUTHORED,
      ),
    ),
  }),

  onFrame: ({ uniforms,  distKm }) => {
    // Live sun illuminance for the cloud shell (1/r² on Earth's real distance to
    // the star). `setAtmosphereBody` runs earlier in the same CelestialBody
    // useFrame, so this is same-frame fresh. Left unchanged if Earth isn't
    // registered — which can only happen on the billboard tier, where no shell
    // exists to read it.
    const atmoRec = getAtmosphereBody("earth");
    if (atmoRec) uniforms.uSunIlluminance.value.copy(atmoRec.sunIlluminance);

    // ⚠ D34: the per-frame Luna position that used to live here is GONE. Earth's
    // eclipse now reads the shared occluder slots `CelestialBody` fills from the
    // sun-occluder registry, so it is no longer coupled to one named moon — and
    // `LUNA_POSITION_KM` no longer has to be imported by a planet.

    // Volumetric/flat cloud crossfade — ALTITUDE-based (see the
    // VOLUMETRIC_BLEND_*_ALT_KM constants for rationale + history). 0 above
    // 3000 km altitude (flat overlay only; SpaceRenderer skips the cloud
    // passes entirely), 1 below 1500 km (volumetric over the near field, flat
    // overlay only beyond per-pixel reach). The near-tier shell mounts at
    // 35 k km distance with blend = 0, so there's no mount discontinuity.
    const altKm = distKm - PLANET_RADIUS_KM;
    uniforms.uVolumetricBlend.value = THREE.MathUtils.clamp(
      (VOLUMETRIC_BLEND_START_ALT_KM - altKm) /
        (VOLUMETRIC_BLEND_START_ALT_KM - VOLUMETRIC_BLEND_FULL_ALT_KM),
      0,
      1,
    );

    // Far-field cloud SHELL fade (ISSUE 2 Phase 2). Full above the deck (carries
    // the far field / horizon), off at/below the deck top. FrontSide already
    // culls the shell from inside the sphere, so this mainly smooths the
    // deck-top crossing and removes the shell just before the camera enters the
    // deck (where the volumetric takes over the whole view). Replaces
    // uFlatCloudOpacity's below-deck role — but the shell can stay full LOWER
    // than the ground overlay could (it has no ground ghost), so its band sits
    // right at the deck.
    uniforms.uShellOpacity.value = THREE.MathUtils.clamp(
      (altKm - SHELL_FADE_OFF_ALT_KM) /
        (SHELL_FADE_FULL_ALT_KM - SHELL_FADE_OFF_ALT_KM),
      0,
      1,
    );
  },

  buildFragmentNode: ({ textures, uSunRel, uSunIlluminance, uniforms, eclipseU, tier }) => {
    return buildEarthFragmentNode({
      texDay: textures.day,
      texClouds: textures.clouds,
      texNormal: tier === "near" ? textures.normal : null,
      texSpec: textures.spec ?? null,
      uSunRel,
      uSunIlluminance,
      eclipseU,
      uSunRadius: uniforms.uSunRadius,
      // Phase 3b: bind the shared transmittance LUT (baked by SpaceRenderer's
      // atmosphere pass) so the surface shader reads per-pixel sun colour.
      transmittanceLUT: USE_ATMOSPHERE_SURFACE_LIGHTING
        ? getAtmosphereLUTs().transmittance.texture
        : undefined,
    });
  },
};
