import * as THREE from "three";
import { NodeMaterial } from "three/webgpu";
import {
  If,
  Loop,
  Break,
  uniform,
  texture,
  texture3D,
  screenCoordinate,
  vec2,
  vec3,
  vec4,
  float,
  int,
  dot,
  sub,
  clamp,
  length,
  mix,
  smoothstep,
  exp,
  atan,
  acos,
  fract,
  sin,
  pow,
  PI,
} from "three/tsl";
import { kmToScaledUnits } from "@/sim/units";
import { PLANET_RADIUS_KM } from "@/sim/celestialConstants";
import type { ExtraMeshContext, ExtraMeshDef } from "../types";
import { getCloudBaseVolume, getCloudDetailVolume } from "./noiseVolumes";
import { CLOUD_LAYER } from "@/components/space/renderLayers";
import {
  setupFullscreenCloudPass,
  setEarthMatrixWorldSource,
} from "@/components/space/cloudFullscreenPass";

// Troposphere-ish slab. Photoreal-leaning, not exaggerated.
const CLOUD_INNER_ALTITUDE_KM = 1;
const CLOUD_OUTER_ALTITUDE_KM = 14;

// Ray-march config. MUST be constants — TSL Loop count is baked into the shader.
//
// Two-state adaptive march (Nubis C1+C2). Skip mode advances at dtSkip
// (~slab/16 ≈ 800 m) using a cheap base-shape probe; on first hit, rewinds
// half a long step and switches to dense mode at dtDense (~dtSkip/4
// ≈ 200 m) which does the full Schneider density + cone light march +
// accumulation. After EMPTY_THRESHOLD consecutive dense-mode empty samples,
// the march drops back to skip mode. Empty pixels finish in ~16 cheap
// probes; pixels through dense bodies get 4× finer sampling without paying
// the dense-mode cost outside cloud bodies.
const MAX_PRIMARY_STEPS = 96;
// Fixed skip-mode step size in scaled units (1 scaled unit = 1000 km).
// 0.0005 = 500 m — matches Schneider/Nubis primary-step scale.
//
// Earlier this was `dtSkip = slabLen / 16` (adaptive). That's the wrong
// relationship: cumulus towers have constant world-space size (~1–3 km
// wide), so step size must also be in world space.
const SKIP_STEP_SCALED = 0.0005;
// dtDense / dtSkip ratio. 0.25 = 4× finer sampling inside cloud bodies
// (125 m). Worst-case cumulative dense-step traversal: 96 × 125 m ≈ 12 km,
// roughly slab thickness — enough to push through a dense column when
// the empty-streak fallback never fires.
const DENSE_STEP_RATIO = 0.25;
// Consecutive dense-mode empty samples before falling back to skip mode.
// 8 × dtDense = 1 km of empty space tolerated inside dense mode before
// a switch — keeps cloud-body holes from triggering ping-pong, but falls
// back fast enough not to waste short steps on truly-empty post-cloud
// columns.
const EMPTY_THRESHOLD = 8;
// Cone-traced light march (Nubis C3). 6 stratified samples toward the sun,
// each perturbed by a pre-baked low-discrepancy 3D kernel, scaled by step
// distance so the cone widens with depth. Total integration range ≈ 12 km
// (same as the previous 3×4 km linear march), but the cone-tap pattern
// smooths per-pixel transmittance variance and reads more like a real
// volumetric integral — removes the "speckled cores" common to short
// linear light marches. Step count is hard-coded into the unrolled call
// sites in buildCloudFragment (TSL can't index a constant kernel by loop
// variable), so there's no LIGHT_STEPS constant.
const LIGHT_STEP_SCALED = 0.002; // ~2 km step; 6 steps ≈ 12 km into the slab.
// Henyey-Greenstein asymmetry. Controls how peaked the direct-light phase
// function is in the forward direction (looking toward sun).
//   0.6 (Wrenninge default): 65× peak ratio. Strong silver-lining but
//      heavy view-dependence — produces visible left-right brightness
//      gradient across cloud cover when sun is off to one side.
//   0.3: 4× ratio. Less silver-lining; still produces ~30% across-FOV
//      gradient that user could see as "clouds nearer sun look brighter"
//      independent of within-cloud lighting variation.
//   0.1 (current): 1.8× ratio. Nearly isotropic phase function. Direct
//      lighting is effectively the same magnitude regardless of view
//      direction. Eliminates the HG-driven across-FOV gradient that
//      was masking the within-cloud variation (which lives in cone-
//      marched `ms`, NOT in HG phase). Trade-off: minimal silver-lining
//      effect when sun is behind cloud — acceptable, the references we
//      target rely more on multi-scatter shading than silver-lining
//      drama.
const HG_G = 0.1;

// =============================================================================
// DIAGNOSTIC VISUALIZATION
//
// Set DEBUG_VIZ to anything other than 'off' to replace the normal cloud
// output with a false-colour visualisation. Output is forced to alpha=1, so
// the cloud-RT pixels REPLACE the underlying scene at every fragment where
// the cloud shell renders — not blended through. uVolumetricBlend is
// bypassed in debug modes so the visualisation is consistent regardless of
// camera distance to Earth.
//
//   'off'         : normal cloud rendering
//   'alpha'       : integrated alpha as grayscale. Black = no cloud detected,
//                   white = saturated opacity. Tells us whether the integration
//                   is reaching α=1 in regions where coverage is high (i.e.
//                   are we density-limited, or sampling-limited?)
//   'topAlt'      : per-column topAlt sampled at the slab midpoint, mapped to
//                   grayscale: black = topAlt=0.4, white = topAlt=0.95. The
//                   key question this answers: does topAlt actually vary
//                   across the FOV, or does it cluster around one value
//                   (which would mean Perlin distribution is too narrow and
//                   the per-column tower variation is invisible).
//   'insideInner' : red = camera is below inner shell at this fragment,
//                   green = above. Reveals whether the insideInner branch
//                   in the geometry intersection fires correctly and at the
//                   expected screen regions.
//   'iters'       : R = primary loop iterations / 96, G = dense (full-sample)
//                   iterations / 96, B = 0. Tells us whether the march is
//                   early-terminating (R low), running to MAX_PRIMARY_STEPS
//                   (R = 1), and whether dense mode actually engages (G > 0
//                   in cloud regions).
//   'slabLen'     : slab path length normalised. Helps spot grazing-angle
//                   pixels where the slab is much longer than nominal
//                   13 km (e.g. limb views).
//   'firstHit'    : t-value of first cloud sample (premul alpha first
//                   exceeds 0.01) divided by tExit, false-coloured. The
//                   parallax-sanity check: per-pixel depth variation
//                   means adjacent pixels can show very different colours
//                   wherever they hit clouds at different distances along
//                   their respective rays. A uniform colour across the
//                   cloud disk means cloud-front depth is locked (i.e.
//                   shell-painting behaviour). Empty pixels = black
//                   (no hit, sentinel = 0).
//   'lightingOnly': accumulated col / alpha (the cloud's unpremul colour,
//                   ignoring transparency). Pixels where alpha is non-zero
//                   show the cloud's actual shading. LINEAR-SCALED to a
//                   0–5 HDR window so subtle variation isn't squashed by
//                   tonemap compression — Reinhard's x/(x+1) curve maps
//                   5-10 HDR to 0.83-0.91, indistinguishable to the eye
//                   even when the underlying variation is 2x. Linear /5
//                   shows 0-5 HDR clearly; above 5 clamps to white.
//   'tsunMs'      : last-dense Tsun_ms (multi-scatter transmittance from
//                   cone-march), grayscale. Black = 0, white = 1. THE
//                   diagnostic for "does cone-march produce spatial
//                   variation?" — if uniform, the cone-march is the
//                   problem; if varying but lightingOnly is uniform,
//                   the issue is downstream in the lighting formula.
//                   CAUTION: pow(x, 0.15) compresses heavily near x=1
//                   (e.g. opticalDepth 0.5 → Tsun_ms 0.92, opticalDepth
//                   2.0 → Tsun_ms 0.74), so visually-uniform tsunMs can
//                   hide a 4× variation in the underlying raw cone-march
//                   density. Use 'coneDepth' as the un-compressed truth.
//   'coneDepth'   : last-dense raw opticalDepthSun (before pow-tonemap),
//                   scaled /10 for display. Shows whether cone-march is
//                   ACTUALLY producing varying absorption. Black = 0 (no
//                   absorption), white ≥ 10 (heavy absorption). If
//                   coneDepth is uniform across cloud disk → cone-march
//                   physically isn't varying (texture3D / sunDir bug). If
//                   coneDepth varies but tsunMs and lightingOnly look
//                   uniform → pow compression is hiding the variation
//                   and we need either lower sunColor brightness or a
//                   different lighting tonemap.
//   'eroded'      : last-dense `eroded` value (post-detail-erosion shape,
//                   range 0-1). Shows the actual per-voxel density
//                   structure at the visible surface, before any lighting
//                   or cone-march. If this varies pixel-to-pixel at close
//                   range → detail noise IS at sub-pixel resolution and
//                   lighting is just not surfacing it. If uniform → noise
//                   volumes don't have sub-100m features and close-range
//                   detail needs a different mechanism entirely.
//   'density'     : last-dense density (eroded × densScale), scaled
//                   /20000 for display. Same diagnostic intent as
//                   'eroded'; cross-check that densScale isn't masking
//                   variation.
//   'sunDir'      : visualizes `sunDirEarth` as colour: R = sunDir.x*0.5+0.5,
//                   G = sunDir.y*0.5+0.5, B = sunDir.z*0.5+0.5. Identical
//                   across the whole screen (since sun direction is the
//                   same for every voxel — sun at AU distance). Use this
//                   to verify sunDir is pointing where the sun visibly
//                   appears in the scene. If the visible sun on screen
//                   is in the upper-left but sunDir colour suggests
//                   downward direction, there's a transform bug.
//   'daylight'    : the per-voxel `daylight` scalar (smoothstep on
//                   sunDotPoint), grayscale. Varies across the cloud
//                   disk: clouds near the sub-solar point read bright,
//                   clouds near the terminator read mid-gray, night-side
//                   clouds black. This is what causes "left-bright /
//                   right-dim" gradient across cloud cover when sun is
//                   off to one side — correct physics, not a bug.
//   'dither'      : the per-pixel dither hash output as grayscale [0, 1].
//                   Tests whether the dither hash is producing uniform
//                   per-pixel variation or some structured pattern.
// =============================================================================
const DEBUG_VIZ:
  | "off"
  | "alpha"
  | "topAlt"
  | "insideInner"
  | "iters"
  | "slabLen"
  | "profile"
  | "firstHit"
  | "lightingOnly"
  | "tsunMs"
  | "coneDepth"
  | "eroded"
  | "density"
  | "sunDir"
  | "daylight"
  | "dither" = "off";

// Cloud-type vertical density profile (Nubis B1, three-type decomposition).
//
// Three analytic vertical density curves mixed by `cloudType ∈ [0, 1]`,
// taken straight from Schneider 2015. Each curve is the product of a bottom
// ramp (condensation base) and a top falloff (cloud-top):
//
//   stratus       — thin flat sheet,    0.0–0.1 ramp up,  0.15–0.25 ramp down
//   stratocumulus — moderate broken slab, 0.0–0.25 ramp up,  0.45–0.65 ramp down
//   cumulus       — tall column, 0.0–0.4 ramp up, top fades over topAlt
//
// Cumulus uses the per-column `topAlt` from the upstream Perlin sample to
// vary tower height between regions. Stratus and stratocumulus heights are
// fixed by type (real stratus decks have remarkably consistent altitude;
// the regional variation is in their cloudType, not their top).
//
// Mix shape (per Schneider):
//   cloudType ∈ [0,    0.5] → stratus → stratocumulus
//   cloudType ∈ [0.5,  1.0] → stratocumulus → cumulus
//
// topAlt ∈ [0.40, 0.95] from the per-column Perlin sample upstream:
//   short cumulus (topAlt = 0.40): fades 0.05 → 0.40 → tops ~6.2 km
//   tall  cumulus (topAlt = 0.95): fades 0.60 → 0.95 → tops ~13.4 km
//
// History note: prior version was a single asymmetric band keyed only by
// topAlt. That gave per-column tower variation but no type-driven anatomy —
// every region read as "the same cloud, taller or shorter". The mix below
// is what gives stratus, stratocumulus, and cumulus visually distinct
// silhouettes that match the reference shots.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cloudHeightProfile(alt01: any, topAlt: any, cloudType: any): any {
  // Stratus: thin flat sheet.
  const stratusBase = smoothstep(float(0.0), float(0.10), alt01);
  const stratusTop = float(1).sub(smoothstep(float(0.15), float(0.25), alt01));
  const stratus = stratusBase.mul(stratusTop);

  // Stratocumulus: moderate broken slab.
  const scBase = smoothstep(float(0.0), float(0.25), alt01);
  const scTop = float(1).sub(smoothstep(float(0.45), float(0.65), alt01));
  const stratocumulus = scBase.mul(scTop);

  // Cumulus: tall column whose top fade is keyed by per-column topAlt.
  const cumBase = smoothstep(float(0.0), float(0.40), alt01);
  const fadeStart = topAlt.sub(float(0.35));
  const cumTop = float(1).sub(smoothstep(fadeStart, topAlt, alt01));
  const cumulus = cumBase.mul(cumTop);

  const lowerMix = mix(stratus, stratocumulus, smoothstep(float(0.0), float(0.5), cloudType));
  return mix(lowerMix, cumulus, smoothstep(float(0.5), float(1.0), cloudType));
}

/**
 * Earth cloud system: registers a fullscreen-quad ray-march pass that
 * produces per-pixel cloud-front depth (real 3D parallax under camera
 * motion). Returns a tiny anchor mesh whose only role is to inherit
 * Earth's matrixWorld via the rotation-group parent — `onMount` registers
 * it as the world-transform source for the fullscreen pass's
 * `uEarthInverseModel` uniform. Mesh is on CLOUD_LAYER (which no camera
 * enables), so it never renders.
 */
export function buildEarthClouds(ctx: ExtraMeshContext): ExtraMeshDef[] {
  if (ctx.tier !== "near") return [];

  const weatherMap = ctx.textures.clouds;
  if (!weatherMap) return [];

  const innerRadiusScaled = kmToScaledUnits(
    PLANET_RADIUS_KM + CLOUD_INNER_ALTITUDE_KM,
  );
  const outerRadiusScaled = kmToScaledUnits(
    PLANET_RADIUS_KM + CLOUD_OUTER_ALTITUDE_KM,
  );

  const baseVolume = getCloudBaseVolume();
  const detailVolume = getCloudDetailVolume();

  const uInnerRadius = uniform(innerRadiusScaled);
  const uOuterRadius = uniform(outerRadiusScaled);
  // Shared drift uniform — future-proofed for sim-time animation (step 2+).
  const uCloudUvOffset = uniform(new THREE.Vector2(0, 0));
  // Extinction × density_raw (scaled-km units).
  //
  // OD per dense step = density × densMul × dtDense. Targets SOFT alpha
  // buildup over ~10 dense steps inside a cloud body, not instant
  // saturation — binary saturation would expose the underlying noise's
  // iso-density isosurfaces as hard visible rings on the cumulus body
  // (see CLOUD_DEBUGGING_LESSONS.md, follow-on to case study #1).
  //
  // Primary-ray density multiplier. Tuned for opaque cumulus body:
  // cores need alpha > 0.99 in 3-4 dense steps (~500m of cloud) so stars
  // don't bleed through. Each step contributes scatterFrac ≈ 1 - exp(
  // -density × dtDense), so we need density × dtDense > ~1.5 per step
  // for solid opacity.
  //
  // At 140000 with typical body voxel (eroded ≈ 0.16) and dtDense =
  // 0.000125: density × dtDense ≈ 2.8, scatterFrac ≈ 0.94 per step.
  // Alpha reaches 0.999 in 2 dense steps — solid cumulus.
  //
  // Cone-march density does NOT scale with this. It's hardcoded as
  // CONE_DENSITY = 3000 inside the marcher to keep cone-marched
  // opticalDepthSun in a useful range (~2-10) regardless of primary
  // opacity tuning. See sampleConeTap.
  //
  // Trade-off: high densMul means alpha saturates in 1-2 voxels at high-
  // baseShape regions. The visible cloud surface lighting comes mostly
  // from those first 1-2 voxels. Per-voxel lighting variation comes from
  // cone-marched Tsun_ms varying across the surface, not from many-voxel
  // col integration.
  const uDensityMul = uniform(140000);
  // Base-volume tiling per scaled unit. 1 scaled unit = 1000 km.
  //
  // Was 250 → 4 km tile, 1 km cumulus cells. At orbital view distances,
  // 1 km features are sub-pixel and produce visible noise/speckle instead
  // of recognizable cumulus shapes. Reference engines (Nubis/HZD/RDR2)
  // operate with cumulus *bodies* on the order of 5–30 km wide so they
  // fill multiple screen pixels at the typical viewing distances.
  //
  // 50 → 20 km tile, 5 km low-freq Worley cells (cumulus puff size),
  // 2.5 km mid-freq, 1.25 km high-freq. Cumulus bodies are now ~5–10 km
  // wide and read as coherent cloud forms from any view distance,
  // including orbital.
  const uBaseScale = uniform(50);
  // Detail-volume tiling: 500 → 2 km tile in world space, ~60 m features at
  // the 32³ texture's sample spacing. Sized to match Schneider 2015's
  // cumulus cauliflower carving scale (10-100m per detail feature).
  //
  // Distance-based detail fade-in: the marcher's detail-erosion threshold is
  // multiplied by `detailStrength` (computed per dense voxel from `t`),
  // ramping from 0 beyond 80 km to 1 within 5 km of camera. This is the
  // canonical Nubis LOD trick: at orbital view distances, every voxel is
  // far → detailStrength ≈ 0 → only the base macro shape contributes →
  // smooth km-scale cumulus shapes (matches the natural look the orbital
  // screenshots show). At close range, near voxels get full detail erosion
  // → bumpy cauliflower silhouettes + per-pixel body variation. Without
  // this fade, ~60m detail features would alias to grain at orbital view
  // since each pixel covers >>60m of world there.
  //
  // Previous value 100 (~1 km tile, 300m features) had detail features so
  // large that they read as macro shape — no functional difference from the
  // base volume at any view distance. Bumped to give Schneider-scale
  // carving for the close-range LOD layer.
  const uDetailScale = uniform(500);
  // Detail-erosion strength. CRITICAL parameter for cumulus-vs-stratus
  // appearance.
  //
  // 0.2 (previous): gentle nibbling at silhouette edges only. Produces
  // continuous cloud deck (stratus / stratocumulus look). No spatial
  // separation between cloud bodies.
  //
  // 0.5 (current): aggressive carving that CREATES GAPS between cumulus
  // bodies. Schneider's tuning range for cumulus is 0.4-0.6 (the lower
  // end was tuned against Schneider's near-uniform weather map; our
  // gradient weather map needs the upper end for equivalent discrete
  // cumulus appearance).
  //
  // The visible effect: cones marching to sun from one cumulus's
  // underside now pass through CLEAR SKY between bodies → high Tsun →
  // visible top-bright / bottom-shadowed contrast on individual cumulus.
  // Without gaps, every cone path goes through cloud → uniform Tsun_ms
  // → flat-looking continuous deck (which is what we had).
  //
  // 0.2 (current) — back to original gentle value. Cumulus discrimination
  // now comes from the THRESHOLD MASK on the cumulus pattern (smoothstep
  // 0.35-0.65), which produces real coverage=0 gaps + dense bodies
  // directly. Erosion's job reduces to its canonical Schneider role:
  // nibbling silhouette edges for cauliflower detail texture.
  //
  // Higher values (0.4-0.7 tried earlier) combined with the cumulus
  // pattern's linear modulation produced bimodal density — pattern-low
  // areas had translucent wispy clouds. With threshold mask, pattern-low
  // areas have zero cloud → no wisps possible → 0.2 erosion is safe.
  // 0 = no erosion, 1 = can fully remove edges.
  const uDetailErosion = uniform(0.2);
  // Domain warp is currently disabled inside the marcher (see DIAGNOSTIC
  // note where uvWarped = uvMid). When re-introducing with a smoother
  // (Perlin-only) warp source, recreate a `uWarpAmount = uniform(0.002)`
  // uniform here and pass it to the marcher; ~70 km world equivalent at the
  // equator is the sweet spot between visible structure breakup and
  // weather-map alignment with the flat overlay during 25–35 k crossfade.
  // Column-scale tile for per-column cloud-top variation (Nubis B2). Sampled
  // from baseVolume.r (Perlin) at the column's projection onto the inner
  // shell.
  //
  // Was 50 → ~5 km column cells. With the previous smoothstep(0.3, 0.7)
  // contrast on top of the column sample, adjacent columns ended up
  // wildly different in cloud-band thickness (5.5 km Δ), and their
  // boundaries projected as visible curved stripes on the cloud body.
  //
  // 20 → ~12.5 km columns. Combined with the new SMOOTH linear topAlt
  // mapping (no contrast smoothstep), column boundaries are larger AND
  // softer transitions — no visible stripes from the column structure.
  const uColumnScale = uniform(20);
  // Cone-light radius — multiplier on the world-space kernel offsets in the
  // light march. 0.3 puts the outermost sample ~3 km perpendicular to the
  // primary sample (kernel norm ≈ 1, stepDist at i=5 ≈ 0.011 scaled = 11 km;
  // 0.3 × 11 km ≈ 3 km perpendicular spread). Wider = smoother but starts
  // sampling outside the cloud body for narrow towers; tighter = more
  // speckle. Schneider's reference is in this 0.25–0.4 range.
  const uLightConeRadius = uniform(0.3);

  // Shared crossfade uniform owned by earth.ts (`createUniforms`). 0 → flat
  // overlay only (above 35 k km), 1 → volumetric only (below 25 k km). The
  // anchor mesh registers at the lod.near boundary (35 k); the fullscreen
  // pass ramps in from 0 alpha as the player closes, hiding the tier swap.
  const uVolumetricBlend = ctx.uniforms.uVolumetricBlend;

  setupFullscreenCloudPass({
    weatherMap,
    baseVolume,
    detailVolume,
    uInnerRadius,
    uOuterRadius,
    uCloudUvOffset,
    uDensityMul,
    uBaseScale,
    uDetailScale,
    uDetailErosion,
    uColumnScale,
    uLightConeRadius,
    uVolumetricBlend,
    uSunRel: ctx.uSunRel,
  });

  // Anchor mesh: empty geometry + material, parented to Earth's rotation
  // group via the celestial framework so its matrixWorld inherits the full
  // Earth transform. Lives on CLOUD_LAYER (no camera enables this layer →
  // never rendered). `onMount` registers it as the world-transform source
  // for the fullscreen pass's uEarthInverseModel.
  const anchorGeo = new THREE.BufferGeometry();
  const anchorMat = new NodeMaterial();
  return [
    {
      key: "earth-clouds",
      geometry: anchorGeo,
      material: anchorMat,
      tier: "near",
      renderLayer: CLOUD_LAYER,
      onMount: (mesh) => setEarthMatrixWorldSource(mesh),
    },
  ];
}

/**
 * Pure cloud-volume marcher. Inputs are the Earth-local ray (`roEarth`,
 * `rdEarth`) and Earth-local sun direction (`sunDirEarth`); driven by the
 * fullscreen-quad pass (`cloudFullscreenPass.ts`) which reconstructs these
 * via `screenUV → FOV-based ray dir → uEarthInverseModel`. Geometry-agnostic
 * — anything that can produce the inputs can drive the same marcher.
 *
 * Returns `{ rgba, tFront }`:
 * - `rgba` — premultiplied `vec4(col, alpha) * uVolumetricBlend`.
 * - `tFront` — first-hit ray parameter in Earth-local units (= scaled-world
 *   units; magnitudes are preserved by Earth's rotation-only model matrix).
 *   Sentinel `-1` means the ray missed every cloud body. Used by Phase D3
 *   reprojection to compute the world-space cloud-front for history sampling.
 *
 * DEBUG_VIZ branches force α = 1 to bypass the volumetric crossfade and
 * return `tFront = 0` (reprojection is meaningless under diagnostic modes).
 */
export function marchCloudVolume({
  roEarth,
  rdEarth,
  sunDirEarth,
  weatherMap,
  baseVolume,
  detailVolume,
  uInnerRadius,
  uOuterRadius,
  uCloudUvOffset,
  uDensityMul,
  uBaseScale,
  uDetailScale,
  uDetailErosion,
  uColumnScale,
  uLightConeRadius,
  uVolumetricBlend,
  uDitherPhase,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  roEarth: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rdEarth: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sunDirEarth: any;
  weatherMap: THREE.Texture;
  baseVolume: THREE.Data3DTexture;
  detailVolume: THREE.Data3DTexture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uInnerRadius: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uOuterRadius: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uCloudUvOffset: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uDensityMul: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uBaseScale: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uDetailScale: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uDetailErosion: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uColumnScale: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uLightConeRadius: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uVolumetricBlend: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uDitherPhase: any;
}) {
    const b = dot(roEarth, rdEarth);
    const d2 = dot(roEarth, roEarth);

    // Outer shell: entry + far exit.
    const cOuter = d2.sub(uOuterRadius.mul(uOuterRadius));
    const discOuter = b.mul(b).sub(cOuter);
    const sqrtOuter = discOuter.max(0).sqrt();
    const tOuterNear = b.negate().sub(sqrtOuter);
    const tOuterFar = b.negate().add(sqrtOuter);

    // Inner shell clamps slab at the planet surface.
    const cInner = d2.sub(uInnerRadius.mul(uInnerRadius));
    const discInner = b.mul(b).sub(cInner);
    const sqrtInner = discInner.max(0).sqrt();
    const tInnerNear = b.negate().sub(sqrtInner);
    const tInnerFar = b.negate().add(sqrtInner);

    // When the camera is below the inner shell (altitude < 1 km — flying low
    // through atmosphere), the slab is *above* the camera. Without this branch,
    // tEnter clamps to 0 and the march wastes half its steps in the gap below
    // the slab where the height gradient is zero. Setting tEnter to tInnerFar
    // (where the upward ray exits the inner sphere into the slab) reclaims
    // those samples for the cloud column that's actually present.
    const insideInner = cInner.lessThan(0);
    const tEnterDefault = tOuterNear.max(0);
    const tEnter = insideInner.select(tInnerFar.max(0), tEnterDefault);
    const hitInner = discInner
      .greaterThan(0)
      .and(tInnerNear.greaterThan(tEnter));
    const tExit = hitInner.select(tInnerNear, tOuterFar);

    const slabLen = sub(tExit, tEnter).max(0);
    // Fixed-world-space step sizes. dtSkip = 500 m, dtDense = 125 m
    // (4× finer). See the constants block above for why this is fixed
    // rather than slab-length-adaptive — short version: tower features
    // have constant world-space size so step size must too.
    const dtSkip = float(SKIP_STEP_SCALED);
    const dtDense = dtSkip.mul(float(DENSE_STEP_RATIO));

    // Per-pixel dither: jitters the ray entry point by [0, dtSkip) per
    // fragment so adjacent pixels' discovery samples don't all align to
    // the same dtSkip-spaced grid — without this, step-aliasing produces
    // visible concentric "miss-rings" at iso-distance from the camera.
    //
    // Classic `fract(sin(dot(xy, vec2(12.9898, 78.233))) * 43758.5453)`
    // hash. Adjacent pixels have UNCORRELATED dither values, which is
    // what's needed to break per-pixel step aliasing. Don't replace with
    // IGN or similar low-discrepancy sequence — those have structured
    // lattice spacing between neighbours which DOESN'T break aliasing.
    // See `docs/CLOUD_DEBUGGING_LESSONS.md`.
    //
    // uDitherPhase (set per-frame by cloudFullscreenPass from the Halton
    // jitter sequence) shifts the sin argument each frame so per-pixel
    // values cycle through different buckets across the 16-frame TAA
    // window. Without that, TAA can't integrate the dither variance.
    const dither = fract(
      sin(
        dot(screenCoordinate.xy, vec2(12.9898, 78.233)).add(uDitherPhase),
      ).mul(43758.5453),
    );
    // Full-amplitude: per-pixel start-offset variance covers the entire
    // dtSkip step [0, dtSkip), so every world-space t-value within a
    // step interval has some pixel sampling near it. Any smaller
    // amplitude leaves a fraction of each step uncovered by ALL pixels,
    // creating concentric "miss-rings" at iso-distance from the camera.
    const tStart = tEnter.add(dither.mul(dtSkip));

    // Henyey-Greenstein phase, constant per fragment (sun is effectively infinite
    // distance compared to cloud scale, and view dir is constant along the march).
    const cosTheta = dot(rdEarth, sunDirEarth);
    const g = float(HG_G);
    const gg = g.mul(g);
    const phaseDenom = pow(
      float(1).add(gg).sub(g.mul(2).mul(cosTheta)).max(0.0001),
      float(1.5),
    );
    const phase = float(1).sub(gg).div(float(4).mul(PI).mul(phaseDenom));

    // Sun colour is computed per-fragment below from the local sun-elevation
    // because we tint sunlight toward orange at the terminator.

    // Accumulate transmittance + in-scatter along the view ray (front-to-back).
    const T = float(1.0).toVar();
    const col = vec3(0, 0, 0).toVar();
    const invSlabThickness = float(1.0).div(sub(uOuterRadius, uInnerRadius));
    const invTwoPi = float(1.0).div(PI.mul(2));
    const invPi = float(1.0).div(PI);

    // ── Per-pixel coverage cache (three-tap + piecewise lerp) ──
    // Coverage is sampled at the ray's slab ENTRY, MIDPOINT, and EXIT
    // points and piecewise-lerped per-step along the march.
    //
    // History of this scheme:
    //   - Original single-midpoint sample failed for camera-inside-slab
    //     horizontal views (slab path 100+ km, midpoint UV 100s of km
    //     from camera nadir → coverage gate failed → empty middle).
    //     See `docs/CLOUD_DEBUGGING_LESSONS.md`.
    //   - Two-tap (near+far+lerp) fixed that case but introduced a new
    //     one: camera ABOVE the slab looking tilted-down at a cumulus
    //     between the ray's slab-entry and slab-exit. Both endpoints
    //     sample weather map at lat/lons that miss the cumulus → coverage
    //     low along entire ray → cloud barely renders. Visible as "cloud
    //     bodies have proper opacity from below, but barely visible from
    //     above" — same physics bug, different geometry.
    //   - Three-tap (near+mid+far + piecewise lerp) catches all three
    //     regimes: cumulus at ray-start (covNear), cumulus mid-chord
    //     (covMid), cumulus at ray-end (covFar). Outer skip-gate uses the
    //     max of all three; per-step lerp piecewise blends through the
    //     three samples.
    //
    // pMid is reused — it's already computed for sunDotPoint and the
    // 'topAlt' diagnostic, where it's slow-varying.
    const tMid = tEnter.add(slabLen.mul(0.5));
    const pMid = roEarth.add(rdEarth.mul(tMid));
    const rMid = length(pMid).max(0.0001);
    const dirMid = pMid.div(rMid);

    // Slab-midpoint topAlt sample for the 'topAlt' diagnostic mode. Cheap
    // (one extra texture3D tap; same column-scale value the loop already
    // computes per-step). Always evaluated so JS-side debug branching at
    // build time can use it without restructuring the shader graph.
    const pMidColumn = dirMid.mul(uInnerRadius);
    const colSampleMid = texture3D(baseVolume, pMidColumn.mul(uColumnScale))
      .level(int(0)).r;
    const colSharpMid = smoothstep(float(0.3), float(0.7), colSampleMid);
    // topAlt range widened from [0.55, 0.95] to [0.4, 0.95] — 7.2 km vs
    // 5.2 km vertical span between short and tall columns. Wider span
    // makes the difference between cumulus and stratocumulus dramatic
    // enough to be obviously visible from above, given the new top-heavy
    // density bias above.
    const topAltMid = float(0.4).add(colSharpMid.mul(0.55));

    // Coverage near/mid/far hoisted samples — see comment block above.
    const pNear = roEarth.add(rdEarth.mul(tEnter));
    const pFar = roEarth.add(rdEarth.mul(tExit));
    const rNear = length(pNear).max(0.0001);
    const rFar = length(pFar).max(0.0001);
    const dirNear = pNear.div(rNear);
    const dirFar = pFar.div(rFar);
    const uNear = fract(atan(dirNear.z, dirNear.x.negate()).mul(invTwoPi));
    const vNear = acos(clamp(dirNear.y.negate(), -1, 1)).mul(invPi);
    const uvNear = vec2(uNear, vNear).add(uCloudUvOffset);
    const uFar = fract(atan(dirFar.z, dirFar.x.negate()).mul(invTwoPi));
    const vFar = acos(clamp(dirFar.y.negate(), -1, 1)).mul(invPi);
    const uvFar = vec2(uFar, vFar).add(uCloudUvOffset);
    // Midpoint UV — reuses pMid/dirMid already computed above for sunDotPoint.
    const uMidWeather = fract(atan(dirMid.z, dirMid.x.negate()).mul(invTwoPi));
    const vMidWeather = acos(clamp(dirMid.y.negate(), -1, 1)).mul(invPi);
    const uvMidWeather = vec2(uMidWeather, vMidWeather).add(uCloudUvOffset);
    // Domain warping (previously applied to the single uvMid sample) is
    // currently disabled — the warp source had Worley cells visible at
    // close range. Keep the clean uvNear/uvMid/uvFar values for now;
    // re-enable with a Perlin-only low-frequency warp source when we
    // revisit it.
    const covNear = texture(weatherMap, uvNear).level(int(0)).r;
    const covMid = texture(weatherMap, uvMidWeather).level(int(0)).r;
    const covFar = texture(weatherMap, uvFar).level(int(0)).r;
    // Outer-gate proxy: skip the whole march only if ALL THREE tap points
    // have near-zero coverage. Catches cumulus at ray-start, mid-chord,
    // or ray-end equally.
    const coverageMax = covNear.max(covMid).max(covFar);

    // ── Smooth terminator ──
    // sunDotPoint is cos of the sun-zenith angle at the cloud point.
    //   1 → sun overhead, 0 → sun on horizon, < 0 → below horizon.
    // Narrow symmetric band centred on sunDotPoint = 0. Sunset (`4·d·(1-d)`)
    // peaks at daylight = 0.5, which now lands exactly at the geometric
    // horizon — peak orange tint reads as a thin band right at the
    // terminator instead of bleeding across the entire day side. Beyond
    // ±0.15 (≈ 8.6° sun elevation) the curve saturates: daylight = 1 →
    // pure white sunlit clouds; daylight = 0 → black night side.
    const pDotS_Mid = dot(pMid, sunDirEarth);
    const sunDotPoint = pDotS_Mid.div(rMid);
    const daylight = smoothstep(float(-0.1), float(0.1), sunDotPoint);
    const sunset = daylight.mul(daylight.oneMinus()).mul(4);
    // Tint sunlight toward warm orange at the terminator (Rayleigh-reddened
    // light path through thicker atmosphere).
    //
    // Magnitude: 5× HDR. AgX tonemap is roughly linear up to ~3 HDR then
    // compresses progressively: 5 HDR → 0.83, 8 HDR → 0.90, 12 HDR → 0.93,
    // 20 HDR → 0.96. Above ~5 HDR, AgX squashes a 2× brightness ratio
    // into ~5% output difference (cumulus cores looked uniformly white
    // even though sunlit/shadowed lighting math differed by 2-3×).
    //
    // At 5×, cumulus cores peak at ~4 HDR (AgX 0.81) and shadowed parts
    // at ~2 HDR (AgX 0.67) — a 14% output spread, visible as actual body
    // shading.
    //
    // Tradeoff: clouds ~4× dimmer than the original 21× tune that matched
    // the flat overlay. Visible during the flat↔volumetric crossfade
    // between 25-35 k km altitude. Likely needs corresponding reduction
    // in the flat overlay's `CLOUD_BRIGHTNESS` constant to keep the
    // transition smooth — leaving for later tuning since the volumetric
    // result quality is the priority right now.
    const sunColor = mix(
      vec3(1.0, 0.96, 0.88),
      vec3(1.0, 0.55, 0.25),
      sunset,
    ).mul(12.0);

    // Sky color: COOL BLUE tint used for ambient lighting (Rayleigh-
    // scattered atmospheric blue is what lights cloud undersides in real
    // life). Without a separate sky color, ambient × sunColor produced
    // warm-cream shadow sides instead of the characteristic cool-blue
    // underbelly cumulus get in reference renders. The Schneider 2015
    // formulation explicitly separates sun- and sky-colored contributions:
    //
    //   L = sunColor × (direct + ms) + skyColor × ambient
    //
    // Saturated cool blue at 2 HDR. Reduced from 4 → 2 to deepen shadow
    // sides — when skyColor was 4, ambient fill kept shadow undersides at
    // ~1 HDR (AgX 0.50), too bright for the reference look. Halving it
    // drops shadows to ~0.5 HDR (AgX 0.34) — properly dark for Star
    // Citizen-style contrast while keeping the blue tint that gives
    // shadows their characteristic cumulus underside color.
    //
    // The blue channel dominates (0.3 R, 0.5 G, 1.0 B) so shadow sides
    // read as visibly cool, not just dimmer.
    const skyColor = vec3(0.3, 0.5, 1.0).mul(daylight).mul(2.0);

    // Skylight: scalar attenuation of skyColor, multiplied into ambient.
    // Tuned together with skyColor for shadow brightness:
    //   0.25 (previous): ambient × skyColor(4) = 1 HDR floor → shadows
    //     at AgX 0.5, too bright vs sunlit AgX 0.86. Low contrast.
    //   0.15 (current): ambient × skyColor(2) = 0.3 HDR floor → shadows
    //     at AgX 0.25, properly dark for Star Citizen-style contrast.
    // Tracks daylight via skyColor (no duplication needed here).
    const skylight = float(0.15);

    // Powder blend, constant along ray (depends only on cosTheta).
    const powderFrontMix = clamp(cosTheta.mul(0.5).add(0.5), 0, 1);
    const powderFrontInv = powderFrontMix.oneMinus();

    // Constants, hoisted so TSL doesn't rebuild them per-iteration.
    const phaseIsotropic = float(0.07957747); // 1 / (4π)
    const densScale = uDensityMul;

    // Diagnostic counters hoisted to fragment scope so the debug return at
    // the bottom of the shader can read them. Always declared (zero cost
    // when DEBUG_VIZ === 'off' since the GPU's dead-store elimination
    // drops the increments). When the whole-column coverage gate fails
    // these stay 0, which correctly reads as "march never engaged".
    const primaryIters = float(0).toVar();
    const denseIters = float(0).toVar();
    // Sentinel = -1 (no hit). Captured the first time skip-mode finds
    // cloud along the ray; the t-value at that point is the cloud-front
    // depth for this pixel. Used by the TAA reprojection for accurate
    // history sampling, and by DEBUG_VIZ='firstHit' for parallax checks.
    const firstHitT = float(-1).toVar();

    // Last-dense Tsun_ms capture for DEBUG_VIZ='tsunMs'. Persists the most
    // recent multi-scatter transmittance from the dense march so we can
    // visualise whether the cone-march is producing spatial variation.
    // Front-to-back integration means the LAST written value is from
    // roughly the visible surface (where alpha saturates).
    const lastTsunMs = float(0).toVar();

    // Last-dense raw cone-march optical depth, for DEBUG_VIZ='coneDepth'.
    // Shows opticalDepthSun directly (before pow-tonemap), bypassing the
    // aggressive compression of pow(x, 0.15) which makes Tsun_ms look
    // uniform at high transmittance (0.92 vs 0.74 over a 4x range of
    // underlying opticalDepth). This is the un-tonemapped truth about
    // whether the cone-march finds varying absorption.
    const lastOpticalDepthSun = float(0).toVar();

    // Last-dense voxel density (eroded × densScale), for DEBUG_VIZ='density'.
    // Shows the actual primary-voxel density at the visible surface. If
    // this varies pixel-to-pixel at close range, the underlying data has
    // variation and the lighting model is just not surfacing it. If
    // uniform, the noise volumes don't have sub-100m features and no
    // lighting tweak can produce close-range body detail without a
    // different mechanism (e.g. higher-res noise or local self-shadow).
    const lastDensity = float(0).toVar();

    // Last-dense eroded value (per-voxel post-detail-erosion shape, 0-1
    // range, no densScale). For DEBUG_VIZ='eroded'. Same diagnostic intent
    // as 'density' but normalised — shows the detail-noise structure
    // directly without the densScale multiplier obscuring it.
    const lastEroded = float(0).toVar();

    // ── Outer gate neutralised (trivially-true condition) ──
    // Previously: `If(coverageMax > 0.01)` based on hoisted 3-tap samples.
    // That gate caused the "wireframe outlines / cloud portal" artifact:
    // pixels where all 3 hoisted taps missed the cumulus had their entire
    // marcher skipped → wireframe outline at the iso-pass boundary.
    //
    // Per-step coverage (sampled inside the loop body) is now the actual
    // gating mechanism — every voxel sees coverage at its real lat/lon.
    //
    // The `If(...)` STRUCTURE is preserved with a trivially-true condition
    // because removing it entirely caused the marcher to silently produce
    // alpha=0 everywhere (some TSL scope / variable visibility interaction
    // I don't fully understand). Keeping the If with `coverageMax >= 0`
    // (always true since covNear/covMid/covFar are texture samples in
    // [0, 1]) preserves the TSL graph topology while effectively
    // bypassing the gate.
    If(coverageMax.greaterThanEqual(0), () => {
      // ── Two-state adaptive march (Nubis C1+C2) ──
      //
      // stepMode  0 = skip mode (cheap probe, big steps)
      //           1 = dense mode (full sample, small steps, accumulates)
      //
      // Skip mode samples only the base Schneider shape — one texture3D tap
      // for the volume, plus the column-top tap that's needed everywhere.
      // It advances at dtSkip (~slab/16) until the probe finds cloud, at
      // which point it rewinds half a long step and switches to dense.
      //
      // Dense mode samples the full pipeline (Schneider remap, detail
      // erosion, cone-traced light march, multi-scatter, accumulation).
      // Steps are dtDense = 4× finer than skip — the resolution win that
      // makes close-range cloud bodies look like solid 3D shapes instead
      // of blurry slabs. After EMPTY_THRESHOLD consecutive empty samples,
      // it falls back to skip mode so we don't waste short steps on the
      // far side of a thinning cloud.
      const stepMode = float(0).toVar();
      const t = tStart.toVar();
      const emptyStreak = float(0).toVar();

      Loop(MAX_PRIMARY_STEPS, () => {
        If(t.greaterThan(tExit), () => {
          Break();
        });
        primaryIters.addAssign(1);

        const p = roEarth.add(rdEarth.mul(t));
        const r = length(p).max(0.0001);
        const altitude01 = clamp(
          sub(r, uInnerRadius).mul(invSlabThickness),
          0,
          1,
        );

        // ── Per-step coverage sampling ──
        // Sample the weather map at the CURRENT march position's lat/lon.
        // Replaces the 3-tap near/mid/far + piecewise lerp, which failed
        // for cumulus that fell in the gap between tap points (visible
        // as "two halves of a cloud with empty middle" — same family as
        // the original case study in CLOUD_DEBUGGING_LESSONS.md). Per-step
        // is the only fully-general scheme: every voxel sees coverage at
        // its actual lat/lon, no aliasing from sample density.
        //
        // Cost: one extra 2D texture lookup per primary loop iteration.
        // For pixels missing cloud, the outer `coverageMax > 0.01` gate
        // (still using the hoisted 3-tap max) early-exits the loop so
        // they pay 0 of these per-step samples. For pixels through cloud
        // regions, ~96 extra weather-map taps — modest cost on modern GPUs.
        const dirP = p.div(r);
        const uP = fract(atan(dirP.z, dirP.x.negate()).mul(invTwoPi));
        const vP = acos(clamp(dirP.y.negate(), -1, 1)).mul(invPi);
        const uvP = vec2(uP, vP).add(uCloudUvOffset);
        const coverageRaw = texture(weatherMap, uvP).level(int(0)).r;

        // ── Procedural cumulus-pattern modulation ──
        // Real Earth's weather map (satellite-derived) provides smooth
        // gradient coverage values — that produces stratiform/stratocumulus
        // appearance, NOT discrete cumulus puffs. Reference engines like
        // KSP-EVE either use art-authored weather maps with built-in
        // cumulus patches, or layer procedural variation on top.
        //
        // We multiply coverage by a low-frequency 3D noise pattern sampled
        // from the base volume's Worley FBM channel (.g). This breaks the
        // smooth weather map into cumulus-scale patches:
        //   - High-noise regions: coverage stays high → cloud body
        //   - Low-noise regions: coverage drops → clear sky gaps
        //
        // p.mul(80) gives texture period 1/80 = ~12 km world — features at
        // 1.5-3 km scale (typical cumulus column width).
        //
        // Threshold mask (smoothstep) instead of linear modulation:
        //   pattern < 0.35: mask = 0 → coverage = 0 → CLEAR SKY GAP
        //   pattern > 0.65: mask = 1 → coverage = coverageRaw → DENSE CUMULUS
        //   0.35-0.65: smooth transition → soft cumulus edge fade
        //
        // Previous linear modulation [× 0.8 + 0.6] never let coverage
        // reach 0, so we got translucent thin cloud everywhere instead of
        // discrete cumulus + clear gaps. Threshold mask creates the
        // binary cumulus-or-gap discrimination the references show, with
        // a 30% transition zone for natural soft edges.
        //
        // Note: this is per-VOXEL not per-PIXEL. Adjacent voxels in 3D
        // sample the same noise scale and get correlated values.
        const cumulusPattern = texture3D(baseVolume, p.mul(80))
          .level(int(0)).g;
        const cumulusMask = smoothstep(
          float(0.35),
          float(0.65),
          cumulusPattern,
        );
        const coverage = coverageRaw.mul(cumulusMask);

        // ── Cloud-type derivation (Nubis B2, Stage 1) ──
        // Map coverage → cloudType ∈ [0, 1]: 0 = stratus, 0.5 =
        // stratocumulus, 1 = cumulus. smoothstep(0.4, 0.8) gives:
        //   coverage ≤ 0.4  → cloudType 0   (stratus regions)
        //   coverage = 0.6  → cloudType 0.5 (stratocumulus)
        //   coverage ≥ 0.8  → cloudType 1   (cumulus pockets)
        // Stage 2 (deferred): re-author weather map with explicit cloudType
        // channel for art-directable transitions instead of coverage-derived.
        const cloudType = smoothstep(float(0.4), float(0.8), coverage);

        // Per-column cloud-top altitude (Nubis B2). Project the current
        // march position to the inner shell so all steps in the same column
        // sample the same value, and read baseVolume.r (Perlin) at low
        // frequency.
        //
        // Raw Perlin clusters around 0.5 (Gaussian-like distribution), so
        // a direct mapping to topAlt produces values mostly in [0.7, 0.85]
        // — only ~1.3 km of column-top variation across the FOV, too
        // subtle to read as 3D cumulus towers. The smoothstep(0.3, 0.7)
        // contrast curve stretches the typical Perlin range to fill
        // [0, 1], pushing values away from the middle toward the extremes,
        // so topAlt actually spans most of [0.4, 0.95] (7.2 km of column-
        // top variation; widened from [0.55, 0.95] for more dramatic
        // tall-vs-short visual separation paired with the top-heavy
        // density bias).
        const pColumn = p.div(r).mul(uInnerRadius);
        // .level(int(0)) forces mip 0 (sharpest). REQUIRED for ray-marched
        // 3D textures with per-pixel dither: the GPU computes mip level from
        // texture-coord derivatives across the 2×2 fragment quad, but dither
        // variance makes adjacent pixels in a quad sample at very different
        // t values → large derivative → spuriously high mip selected.
        // Different quads at slightly different iso-distance from camera see
        // systematically different mip levels, and LinearMipMapLinear
        // interpolation between mips creates visible cross-hatched "ridge"
        // patterns following iso-distance contours. Symptom: persistent
        // camera-relative banded artifact on cloud surfaces. Forcing mip 0
        // eliminates the per-quad mip variance entirely.
        const colSample = texture3D(baseVolume, pColumn.mul(uColumnScale))
          .level(int(0)).r;
        // topAlt: smooth linear mapping from Perlin sample → [0.4, 0.95].
        //
        // Old code used `smoothstep(0.3, 0.7)` to stretch Perlin's central
        // cluster (~0.4–0.6) into the full output range, then mapped to
        // [0.4, 0.95]. That produced a STRONG BIMODAL distribution: most
        // columns ended up either short (~0.4) or tall (~0.95), with
        // narrow transition bands at the column boundaries. Adjacent
        // columns differing by ~5.5 km of cloud-band thickness produced
        // visible "stripes" where the alpha integration changed abruptly
        // across the column boundary on the cloud body.
        //
        // Linear remap keeps the topAlt distribution smooth — adjacent
        // columns transition continuously through intermediate values,
        // so there are no hard boundaries to project as stripes. Raw
        // Perlin clusters around 0.5, giving most columns topAlt around
        // 0.67. Tower variation is more subtle but evenly distributed.
        const topAlt = float(0.4).add(colSample.mul(0.55));

        // ── Altitude perturbation (band-breaker, outer-scope version) ──
        //
        // Without perturbation, `profile` is a clean function of altitude01
        // alone → iso-altitude surfaces form 2D contour bands on the cloud
        // body. With `densMul` set high (binary-ish saturation), the
        // visible cloud surface is exactly where the OUTER profile gate
        // first lets a voxel through, so the bands are determined here,
        // not in the dense-mode density math.
        //
        // Hash-based 3D noise (no extra texture sample): produces ±5%
        // slab-thickness altitude shift per voxel. Discrete per-voxel
        // (not smooth) — that's deliberate, since smooth noise would
        // create its own visible iso-surfaces. The cloud's macro shape
        // is set by baseShape further down; this noise only shifts where
        // the profile-altitude contour falls.
        const hashSeed = p.x
          .mul(127.1)
          .add(p.y.mul(311.7))
          .add(p.z.mul(74.7));
        const altHash = fract(sin(hashSeed).mul(43758.5453));
        const altPerturb = altHash.sub(0.5).mul(0.10); // ±5% slab
        const altPerturbed = altitude01.add(altPerturb).clamp(0, 1);

        // ── Dimensional profile (Nubis B4) ──
        // profile = coverage × heightProfile(alt, cloudType). First-class
        // shader local that drives BOTH density (via Schneider value
        // erosion below) and lighting (ambient + multi-scatter probability
        // fields in B5). Combining them at this layer keeps the "smooth
        // core, eroded surface" gradient that profile-driven Nubis lighting
        // depends on.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const heightProfile: any = cloudHeightProfile(
          altPerturbed,
          topAlt,
          cloudType,
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const profile: any = coverage.mul(heightProfile);

        // Tracks whether this iteration found cloud (drives empty-streak
        // bookkeeping below). Zero by default; set to 1 inside the cloud
        // branches.
        const hitThisStep = float(0).toVar();

        // Step-level empty-space skip — gate on `coverage × profile` so the
        // outer fringes of the slab (above/below the active cloud-type band)
        // skip 3D taps entirely.
        If(profile.greaterThan(0.01), () => {
          // ── Cheap probe: Schneider macro shape (no detail erosion) ──
          // Used by both modes. In skip mode it's the only volume sample
          // taken; in dense mode it feeds into the detail-erosion pipeline.
          // R = pure Perlin, GBA = three octaves of Worley FBM. The remap
          // `(R + 1 - fbm) / (2 - fbm)` dilates the Perlin macro shape
          // proportionally to FBM strength.
          const baseSample = texture3D(baseVolume, p.mul(uBaseScale))
            .level(int(0));
          const baseFbm = baseSample.g
            .mul(0.625)
            .add(baseSample.b.mul(0.25))
            .add(baseSample.a.mul(0.125));
          const oneMinusFbm = float(1).sub(baseFbm);
          const baseShape = baseSample.r
            .add(oneMinusFbm)
            .div(float(2).sub(baseFbm).max(0.0001))
            .clamp(0, 1);
          const baseCloud = baseShape.mul(coverage);

          If(baseCloud.greaterThan(0.01), () => {
            hitThisStep.assign(1);

            If(stepMode.lessThan(0.5), () => {
              // ── Skip → dense transition ──
              // Rewind half a long step. The next iteration's step-forward
              // will use dtDense, so we land at (current t - dtSkip/2 +
              // dtDense) = (current t - 2·dtDense + dtDense) = (current t -
              // dtDense). Net: dense mode resumes one short step before the
              // detection point, so the leading cloud edge is sampled at
              // short-step resolution. No accumulation in this iteration —
              // the cheap-probe sample is discarded; the next dense step
              // will redo the full computation.
              t.subAssign(dtSkip.mul(0.5));
              stepMode.assign(1);
              emptyStreak.assign(0);
              // Capture cloud-front depth on first hit (sentinel was -1).
              // Drives TAA reprojection (true cloud-surface depth, not
              // outer-shell approximation) and the 'firstHit' debug viz.
              If(firstHitT.lessThan(0), () => {
                firstHitT.assign(t);
              });
            }).Else(() => {
              // ── Steady-state dense: full sample + accumulate ──
              emptyStreak.assign(0);
              denseIters.addAssign(1);

              // ── Detail erosion with edge-weighted strength ──
              // Schneider/Nubis applies detail throughout the cloud, but
              // stronger at silhouette edges (carves cumulus cauliflower)
              // than in cores (subtle internal variation). Floor of 0.35 in
              // cores, ramps to 1.0 at edges.
              const edgeness = float(1).sub(
                smoothstep(float(0.5), float(0.9), coverage),
              );
              const erosionStrength = float(0.35).add(edgeness.mul(0.65));

              // ── Schneider value erosion against profile-modulated shape ──
              // (Nubis B3 + B4) Profile is `coverage × heightProfile` from
              // outside this scope; `shape = baseShape × profile` is the
              // pre-erosion density-like quantity. Eroding shape (rather
              // than just `baseShape × coverage` followed by a separate
              // profile multiply) means altitude affects erosion: near a
              // cumulus top where heightProfile drops, the erosion
              // threshold takes a larger BITE out of the shape, naturally
              // producing wispier tops than cores.
              const shape = baseCloud.mul(heightProfile);

              // Type-driven detail FBM remix (Nubis B3). Same texture sample,
              // different channel weights:
              //   billowy (cumulus, cloudType=1): low-freq dominant (rounded
              //     bumps) — R weighted 0.625, G 0.25, B 0.125.
              //   wispy (stratus,  cloudType=0): high-freq dominant (fine
              //     hair-like detail) — R 0.125, G 0.25, B 0.625.
              // Curl-warped wispy is the canonical Schneider variant; we
              // approximate here with a channel reweight to avoid binding a
              // curl volume (deferred to C5).
              const detailSample = texture3D(detailVolume, p.mul(uDetailScale))
                .level(int(0));
              const billowyFbm = detailSample.r
                .mul(0.625)
                .add(detailSample.g.mul(0.25))
                .add(detailSample.b.mul(0.125));
              const wispyFbm = detailSample.r
                .mul(0.125)
                .add(detailSample.g.mul(0.25))
                .add(detailSample.b.mul(0.625));
              const detailFbm = mix(wispyFbm, billowyFbm, cloudType);
              // Altitude-modulated erosion: at low altitudes erode with raw
              // FBM (carves billowing undersides); at higher altitudes
              // invert (1-fbm) so the surviving wisps poke up like puffy
              // tops.
              const altMod = clamp(altitude01.mul(2.5), 0, 1);
              const erosion = mix(detailFbm, detailFbm.oneMinus(), altMod);
              const erosionRamp = smoothstep(float(0), float(0.3), shape);

              // ── Distance-based detail strength (Nubis LOD trick) ──
              // Schneider 2015: detail erosion is faded by distance from
              // camera. Close voxels (within `detailNear`) get full
              // erosion → bumpy cauliflower carving visible per-pixel at
              // close range. Far voxels (beyond `detailFar`) get zero
              // erosion → only base macro shape contributes → smooth
              // km-scale variation at orbital view (and no detail-noise
              // aliasing since detail's ~60m features are sub-pixel at
              // those distances).
              //
              // `t` is per-voxel distance from camera in scaled units
              // (1 unit = 1000 km). 0.005 = 5 km full detail, 0.080 =
              // 80 km no detail, smoothstep ramp between.
              //
              // Without this fade: at uDetailScale=500, orbital pixels
              // each cover many detail tiles → noise aliases to grain.
              // With this fade: detail "only spent where visible".
              const detailNear = float(0.005);
              const detailFar = float(0.080);
              const detailStrength = float(1).sub(
                smoothstep(detailNear, detailFar, t),
              );

              const threshold = erosion
                .mul(uDetailErosion)
                .mul(erosionRamp)
                .mul(erosionStrength)
                .mul(detailStrength);
              const denom = float(1).sub(threshold).max(0.0001);
              const eroded = shape
                .sub(threshold)
                .div(denom)
                .clamp(0, 1);
              lastEroded.assign(eroded);

              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const density: any = eroded.mul(densScale);
              lastDensity.assign(density);

              // ── Cone-traced light march (Nubis C3) ──
              const Tsun = float(0).toVar();
              If(daylight.greaterThan(0.001), () => {
                const opticalDepthSun = float(0).toVar();
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const sampleConeTap = (
                  kx: number,
                  ky: number,
                  kz: number,
                  i: number,
                ) => {
                  const stepDist = float(LIGHT_STEP_SCALED).mul(
                    float(i).add(0.5),
                  );
                  const conePerturb = vec3(kx, ky, kz)
                    .mul(stepDist)
                    .mul(uLightConeRadius);
                  const pL = p.add(sunDirEarth.mul(stepDist)).add(conePerturb);
                  const rL = length(pL);
                  const altL = clamp(
                    sub(rL, uInnerRadius).mul(invSlabThickness),
                    0,
                    1,
                  );
                  // ── Per-cone-tap density sampling (Schneider-canonical) ──
                  // Sample the 3D BASE VOLUME at each cone tap. The actual
                  // cloud density variation along the sun path lives in
                  // the 3D Perlin-Worley base volume (~km features), not
                  // the macro-scale 2D weather map.
                  //
                  // Without sampling baseShape per cone tap, the cone-march
                  // sees "this lat/lon column has cloud (yes/no)" but not
                  // "how thick the cloud is along this 12 km sun path" →
                  // Tsun_ms ≈ 1 across the cloud → flat lighting.
                  //
                  // Coverage is taken from the PRIMARY RAY (not per-tap).
                  // Per-tap coverage was tried for grazing-sun cases but
                  // it varies negligibly over a 12 km cone vs Earth's
                  // 6371 km radius (~0.0003 rad UV shift) — visual impact
                  // was zero, fetch cost was 6× texture2D per dense voxel.
                  // Dropped for perf.
                  //
                  // Cost: 3 texture3D fetches per dense voxel (3 cone taps).
                  const baseShapeL = texture3D(baseVolume, pL.mul(uBaseScale))
                    .level(int(0)).r;
                  const coverageL = coverage;  // primary-ray's coverage

                  // Cone density is DECOUPLED from primary `densScale`
                  // (uDensityMul). Primary density wants to be high
                  // (~140000) for opaque cumulus body alpha integration.
                  // But scaling cone density with uDensityMul made
                  // cone-march absorption blow up: at 140000, every voxel
                  // had opticalDepthSun ≈ 75 → Tsun_ms ≈ 0 → ms term
                  // pegged at zero → lighting collapsed to HG-phase-
                  // dominated, which is bright when looking toward sun
                  // and dim when looking away. Wrong.
                  //
                  // CONE_DENSITY = 3000 hardcoded keeps cone absorption
                  // in a useful range regardless of primary densMul:
                  //   typical cumulus voxel: opticalDepthSun ≈ 5.4 →
                  //     Tsun_ms (MS_COEF=0.3) ≈ 0.20
                  //   cumulus top voxel (cone exits quickly):
                  //     opticalDepthSun ≈ 1.8 → Tsun_ms ≈ 0.57
                  //   cumulus bottom voxel (cone through full column):
                  //     opticalDepthSun ≈ 9 → Tsun_ms ≈ 0.10
                  //
                  // Range Tsun_ms 0.10–0.57 → ms varies 5.7× across
                  // cloud → visible top-bright/bottom-dark gradient.
                  const profileL = cloudHeightProfile(altL, topAlt, cloudType);
                  const CONE_DENSITY = float(3000);
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const densL: any = baseShapeL
                    .mul(coverageL)
                    .mul(profileL)
                    .mul(CONE_DENSITY);
                  // 2× contribution per tap: we're sampling 3 of the
                  // original 6 stratified directions (every other one),
                  // so each tap "represents" 2 taps' worth of cone-path
                  // density to keep total opticalDepthSun comparable to
                  // the 6-tap version. Dropping to 3 halves the cone-
                  // march texture-fetch cost — the big perf win after
                  // adding per-cone-tap baseVolume + weatherMap sampling.
                  opticalDepthSun.addAssign(
                    densL.mul(float(LIGHT_STEP_SCALED)).mul(2),
                  );
                };
                // Stratified directions 0/2/4 of the original low-
                // discrepancy 6-point kernel. Even spread retained;
                // halved fetch count.
                sampleConeTap(0.38051305, 0.92453449, -0.02111345, 0);
                sampleConeTap(-0.32509218, -0.94575601, -0.01428496, 2);
                sampleConeTap(0.28128598, 0.42443639, -0.86065785, 4);
                Tsun.assign(exp(opticalDepthSun.negate()).mul(daylight));
                lastOpticalDepthSun.assign(opticalDepthSun);
              });

              // Multi-scatter transmittance.
              // pow(Tsun, MS_COEF) ≡ exp(-MS_COEF × opticalDepthSun) on the
              // day side. MS_COEF controls how fast multi-scatter
              // illumination falls off as cone-marched sun absorption rises:
              //   MS_COEF = 0.15 (Wrenninge default): very gentle. At full
              //     absorption, Tsun_ms ≈ 0.35 — still bright. Shadow
              //     sides too bright.
              //   MS_COEF = 0.5 (current): sharper falloff. At Tsun = 0.001,
              //     Tsun_ms ≈ 0.032. Cumulus interior and sun-away surface
              //     voxels become genuinely dim → dramatic top-bright/
              //     side-dim per-cloud body shading like Star Citizen /
              //     KSP-EVE references.
              const MS_COEF = float(0.5);
              const Tsun_ms = pow(Tsun.max(0.0001), MS_COEF).mul(daylight);
              lastTsunMs.assign(Tsun_ms);

              // Optical depth integrates over dtDense — accumulation only
              // happens in dense mode, and dense steps are dtDense apart.
              const opticalDepthStep = density.mul(dtDense);

              // Powder approximation — back-lit edges read brighter.
              // Applied to direct light only (pre-phase), per Schneider.
              const POWDER_K = float(2);
              const powderTerm = float(1).sub(
                exp(opticalDepthStep.mul(POWDER_K.negate())),
              );
              const powderFactor = powderFrontInv
                .mul(powderTerm)
                .add(powderFrontMix);

              // ── Profile-driven lighting model (Nubis B5) ──
              // Three terms, each gated by a probability field derived from
              // the dimensional profile (= coverage × heightProfile):
              //   direct  — sun reaching this voxel directly (Beer-Lambert
              //             through cone-marched sun density), modulated by
              //             HG phase and powder. Not profile-gated: direct
              //             light reaches every voxel the cone-march sees.
              //             HG with g=0.6 gives ~0.02–0.10 peak — small but
              //             responsible for the silver-lining at edges.
              //   ms      — sun light arriving after multiple scatters.
              //             Profile-gated → fills cloud CORES (high
              //             profile), not edges. No phase function
              //             multiplier (per plan B5).
              //             History: tried `ms = eroded × Tsun_ms` to
              //             surface per-voxel detail variation. Eroded
              //             peaks higher than profile (Schneider remap
              //             normalises (shape-thr)/(1-thr) which biases
              //             toward 1 in cores), pushing ms HDR into the
              //             AgX saturation regime where variation is
              //             squashed to white. Reverted; pursuing visible
              //             body detail via reduced sunColor magnitude
              //             instead (see sunColor comment).
              //   ambient — sky light reaching this voxel. Gated by
              //             (1 - profile)^0.5 → bright at edges, dark in
              //             cores. Outward probability gradient.
              const direct = phase.mul(Tsun).mul(powderFactor);
              const ms = profile.mul(Tsun_ms);
              const ambient = profile.oneMinus().pow(float(0.5)).mul(skylight);

              const scatterFrac = float(1).sub(exp(opticalDepthStep.negate()));
              // Schneider canonical: sun-side contributions (direct + ms)
              // use sunColor (warm); ambient uses skyColor (cool blue) to
              // give cumulus undersides their characteristic blue-gray
              // tint instead of warm-cream. Mixed before scatterFrac so
              // each step's accumulated radiance has both color sources
              // correctly weighted.
              const L = sunColor
                .mul(direct.add(ms))
                .add(skyColor.mul(ambient))
                .mul(scatterFrac);
              col.addAssign(L.mul(T));

              T.mulAssign(exp(opticalDepthStep.negate()));
            });
          });
        });

        // Empty-streak handling: if this step found no cloud and we're in
        // dense mode, count it. After EMPTY_THRESHOLD empties, drop back to
        // skip mode. Skip mode never increments the streak (no need —
        // already at the cheap rate).
        If(hitThisStep.lessThan(0.5), () => {
          If(stepMode.greaterThan(0.5), () => {
            emptyStreak.addAssign(1);
            If(emptyStreak.greaterThan(float(EMPTY_THRESHOLD)), () => {
              stepMode.assign(0);
              emptyStreak.assign(0);
            });
          });
        });

        // Step forward at the (possibly just-updated) mode's rate.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dtThis: any = stepMode.lessThan(0.5).select(dtSkip, dtDense);
        t.addAssign(dtThis);

        If(T.lessThan(0.01), () => {
          Break();
        });
      });
    });

    const alpha = clamp(sub(1, T), 0, 1);

    // ── Diagnostic visualisations (DEBUG_VIZ != 'off') ──
    // Each branch returns a forced-α=1 vec4 so the cloud RT REPLACES the
    // underlying scene at every shell-fragment pixel — diagnostic is
    // unambiguous, bypasses the volumetric-blend crossfade.
    if (DEBUG_VIZ === "alpha") {
      return { rgba: vec4(alpha, alpha, alpha, float(1)), tFront: float(0) };
    }
    if (DEBUG_VIZ === "profile") {
      // Profile shape at three altitudes (R = 0.25, G = 0.50, B = 0.75),
      // sampled with the per-fragment slab-midpoint topAlt and the
      // coverage-derived cloudType at the midpoint UV. Lets us see
      // type-driven anatomy: stratus regions read green-only (mass at 0.5);
      // stratocumulus shows red+green; cumulus shows green+blue.
      const cloudTypeMid = smoothstep(float(0.4), float(0.8), covMid);
      const p25 = cloudHeightProfile(float(0.25), topAltMid, cloudTypeMid);
      const p50 = cloudHeightProfile(float(0.50), topAltMid, cloudTypeMid);
      const p75 = cloudHeightProfile(float(0.75), topAltMid, cloudTypeMid);
      return { rgba: vec4(p25, p50, p75, float(1)), tFront: float(0) };
    }
    if (DEBUG_VIZ === "topAlt") {
      // Map [0.4, 0.95] → [0, 1] for grayscale display.
      const topAltNorm = topAltMid
        .sub(float(0.4))
        .div(float(0.55))
        .clamp(0, 1);
      return {
        rgba: vec4(topAltNorm, topAltNorm, topAltNorm, float(1)),
        tFront: float(0),
      };
    }
    if (DEBUG_VIZ === "insideInner") {
      const r = insideInner.select(float(1), float(0));
      const g = insideInner.select(float(0), float(1));
      return { rgba: vec4(r, g, float(0), float(1)), tFront: float(0) };
    }
    if (DEBUG_VIZ === "iters") {
      const primaryNorm = primaryIters
        .div(float(MAX_PRIMARY_STEPS))
        .clamp(0, 1);
      const denseNorm = denseIters
        .div(float(MAX_PRIMARY_STEPS))
        .clamp(0, 1);
      return {
        rgba: vec4(primaryNorm, denseNorm, float(0), float(1)),
        tFront: float(0),
      };
    }
    if (DEBUG_VIZ === "slabLen") {
      // Normalise against the nominal vertical slab length (13 km in
      // scaled units = 0.013). Grazing-angle slabs go well above 1.0.
      const slabNorm = slabLen.div(float(0.013)).clamp(0, 1);
      return {
        rgba: vec4(slabNorm, slabNorm, slabNorm, float(1)),
        tFront: float(0),
      };
    }
    if (DEBUG_VIZ === "firstHit") {
      // Sentinel -1 (no hit) → black. Otherwise normalise (firstHitT -
      // tEnter) by slabLen so depth maps to [0, 1]: 0 = entered slab and
      // hit immediately at the front face, 1 = hit at the back face.
      // False-coloured: blue→cyan→green→yellow→red as depth increases,
      // so adjacent pixels with different cloud-front depths show
      // visibly different colours. Uniform colour across the cloud disk
      // = depth is locked (shell-painting bug); colour gradient =
      // per-pixel parallax working.
      const hit = firstHitT.greaterThan(0);
      const depth01 = firstHitT.sub(tEnter).div(slabLen.max(0.0001)).clamp(0, 1);
      // Simple jet-like ramp via four piecewise channels.
      const r = smoothstep(float(0.5), float(0.9), depth01);
      const g = float(1).sub(
        smoothstep(float(0.7), float(1.0), depth01).mul(1),
      ).mul(smoothstep(float(0.2), float(0.5), depth01));
      const b = float(1).sub(smoothstep(float(0.3), float(0.6), depth01));
      return {
        rgba: vec4(
          hit.select(r, float(0)),
          hit.select(g, float(0)),
          hit.select(b, float(0)),
          float(1),
        ),
        tFront: float(0),
      };
    }

    // ── lightingOnly: cloud colour without alpha modulation ──
    // Reveals what the cloud LOOKS like (sun lighting, phase, MS, sky
    // contribution) independent of how transparent the alpha is.
    // - Stripes here but NOT in 'alpha' → stripes are in the colour /
    //   lighting computation (cone light march, phase, etc.).
    // - Stripes in 'alpha' too → alpha integration has them.
    // - Smooth here but stripes in 'off' → composition with the underlying
    //   scene is what makes them visible (e.g. partial alpha showing
    //   flat-overlay artifacts through).
    if (DEBUG_VIZ === "lightingOnly") {
      // Unpremultiply colour by alpha, then LINEAR-SCALE to a 0-5 HDR
      // window. Reinhard tone map (`x/(x+1)`) used to live here, but
      // its compression curve at 5-10 HDR (output 0.83-0.91) made
      // 2× brightness variations indistinguishable to the eye. Linear
      // scaling keeps variation visible in the 0-5 range; above 5 HDR
      // clamps to white.
      const unpremul = col.div(alpha.max(0.001));
      const exposed = unpremul.div(float(5)).clamp(0, 1);
      const hit = alpha.greaterThan(0.001);
      return {
        rgba: vec4(
          hit.select(exposed.x, float(0)),
          hit.select(exposed.y, float(0)),
          hit.select(exposed.z, float(0)),
          float(1),
        ),
        tFront: float(0),
      };
    }

    if (DEBUG_VIZ === "tsunMs") {
      // Last-dense Tsun_ms (cone-marched multi-scatter transmittance),
      // grayscale. Pixels where the marcher never entered dense mode
      // show black (lastTsunMs starts at 0). Pixels that hit cloud
      // show a grayscale level reflecting the cone-march output for
      // the most recent dense voxel along the ray (≈ visible surface).
      // Uniform across the cloud disk ⇒ cone-march not producing spatial
      // variation. Varying ⇒ cone-march works, downstream lighting math
      // is muting it.
      const hitT = alpha.greaterThan(0.001);
      return {
        rgba: vec4(
          hitT.select(lastTsunMs, float(0)),
          hitT.select(lastTsunMs, float(0)),
          hitT.select(lastTsunMs, float(0)),
          float(1),
        ),
        tFront: float(0),
      };
    }

    if (DEBUG_VIZ === "coneDepth") {
      // Last-dense raw opticalDepthSun (cone-march absorption), scaled /10
      // for display. Bypasses the pow-tonemap that makes tsunMs look
      // uniform at high transmittance. Black = no sun absorption (cone
      // exits cloud immediately); white = heavy absorption. If THIS is
      // uniform across the cloud disk, the cone-march genuinely isn't
      // varying — would indicate a deeper bug (texture3D, sun direction,
      // or pL computation). If THIS varies but tsunMs/lightingOnly look
      // uniform, the issue is just visual compression.
      const hitC = alpha.greaterThan(0.001);
      const scaled = lastOpticalDepthSun.div(float(10)).clamp(0, 1);
      return {
        rgba: vec4(
          hitC.select(scaled, float(0)),
          hitC.select(scaled, float(0)),
          hitC.select(scaled, float(0)),
          float(1),
        ),
        tFront: float(0),
      };
    }

    if (DEBUG_VIZ === "eroded") {
      // Last-dense per-voxel `eroded` value (0-1). Shows the actual
      // detail-noise structure at the visible cloud surface, with NO
      // lighting math involved. This is the cleanest test of whether
      // per-pixel data variation exists at the current view distance.
      const hitE = alpha.greaterThan(0.001);
      return {
        rgba: vec4(
          hitE.select(lastEroded, float(0)),
          hitE.select(lastEroded, float(0)),
          hitE.select(lastEroded, float(0)),
          float(1),
        ),
        tFront: float(0),
      };
    }

    if (DEBUG_VIZ === "density") {
      // Last-dense density (eroded × densScale), scaled /20000 for display.
      const hitD = alpha.greaterThan(0.001);
      const scaled = lastDensity.div(float(20000)).clamp(0, 1);
      return {
        rgba: vec4(
          hitD.select(scaled, float(0)),
          hitD.select(scaled, float(0)),
          hitD.select(scaled, float(0)),
          float(1),
        ),
        tFront: float(0),
      };
    }

    if (DEBUG_VIZ === "sunDir") {
      // Visualizes sunDirEarth as RGB colour. The colour will be
      // UNIFORM across the entire screen because sun direction is the
      // same for every voxel (sun at AU distance).
      // R = sunDir.x × 0.5 + 0.5 (0 means -X, 1 means +X)
      // G = sunDir.y × 0.5 + 0.5 (0 means -Y, 1 means +Y) — Earth-Y axis
      //     is the rotation axis (north pole). High green = sun overhead
      //     (above equator at solstice etc.); low green = sun below horizon
      //     of current Earth orientation.
      // B = sunDir.z × 0.5 + 0.5
      // If the visible sun on screen is in a particular corner but the
      // sunDir colour suggests opposite direction, there's a transform bug.
      const sr = sunDirEarth.x.mul(0.5).add(0.5);
      const sg = sunDirEarth.y.mul(0.5).add(0.5);
      const sb = sunDirEarth.z.mul(0.5).add(0.5);
      return {
        rgba: vec4(sr, sg, sb, float(1)),
        tFront: float(0),
      };
    }

    if (DEBUG_VIZ === "daylight") {
      // `daylight` is the per-voxel scalar smoothstep(-0.1, 0.1, sunDotPoint)
      // where sunDotPoint = dot(pMid, sunDirEarth) / |pMid|.
      // Bright = sub-solar (cloud directly illuminated), dark = terminator
      // / night side. Provides the "across-FOV brightness gradient" that
      // makes clouds near sun overall brighter than clouds toward the
      // terminator — correct physics, but masks within-cloud variation.
      const hitDay = alpha.greaterThan(0.001);
      return {
        rgba: vec4(
          hitDay.select(daylight, float(0)),
          hitDay.select(daylight, float(0)),
          hitDay.select(daylight, float(0)),
          float(1),
        ),
        tFront: float(0),
      };
    }

    // ── dither: visualise the per-pixel dither value directly ──
    // Outputs `dither` (the per-pixel hash output, already in [0, 1]) as
    // grayscale, with no marcher logic in between. Useful for verifying
    // that the hash produces uniform per-pixel variation — should look
    // like clean white noise. If you see ANY directional pattern here
    // (vertical/horizontal/diagonal bands), the hash has a spatial bias
    // and every downstream value will inherit that bias.
    if (DEBUG_VIZ === "dither") {
      return {
        rgba: vec4(dither, dither, dither, float(1)),
        tFront: float(0),
      };
    }

    // Far-LOD fade was here (12–20 km, then 30–50 km). Both ranges killed
    // opacity for cloud bodies in the typical viewing-distance band.
    // Removed for now — the volumetric marches its full ~48 km reach
    // and the flat overlay in earth.ts shows through where the volumetric
    // alpha is 0 (clear sky or pixels that missed the slab). Distant
    // pixels will still produce noise; that's a separate problem for the
    // far-LOD architecture and we'll revisit once the near-cloud
    // appearance is fixed (Issue #2: Perlin-Worley R channel).
    //
    // Premultiplied output — `col` is already color·α from front-to-back
    // accumulation. Blending is configured with (ONE, 1-α) to match.
    // Scale BOTH channels by the crossfade factor: since the framebuffer math
    // is `out = src + (1-src.a)*dst`, multiplying (col, alpha) by k uniformly
    // scales the cloud's contribution toward fully transparent without
    // changing the unpremultiplied colour.
    return {
      rgba: vec4(col, alpha).mul(uVolumetricBlend),
      tFront: firstHitT,
    };
}
