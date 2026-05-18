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
// wide), so step size must also be in world space. For horizontal chords
// at altitude (slab traversal 80–400 km from inside), slabLen/16 grew to
// 5–25 km between probes — the marcher stepped over distant towers
// entirely, and they appeared only when the dithered first probe
// happened to land inside one. Symptom: dot pattern in close range,
// nothing beyond ~500 m.
//
// 500 m fixed step → 96 × 500 m ≈ 48 km of nominal skip-mode reach.
// Beyond that, the marcher exits via `t > tExit` or step budget.
// Horizon-distance cloud (100+ km) still won't render via this path;
// that needs a far 2D LOD crossfade (next architectural step).
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
// Henyey-Greenstein asymmetry: 0.6 gives the strong forward-scatter silver lining.
const HG_G = 0.6;

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
//
// ── Band-isolation viz modes (use these together) ──────────────────────────
// Each one shows a different per-pixel variable evaluated AT THE FIRST-HIT
// POINT. To diagnose the visible band/stripe artifact: compare each mode
// against the user's "off"-mode screenshot. If band positions match the
// iso-colour contours in mode X, then variable X is the band cause.
//
//   'altAtHit'        : altitude01 (raw, unperturbed) at first-hit, as
//                       grayscale [0=alt 1km, 1=alt 14km]. If the visible
//                       bands match the iso-colour bands here, the bands
//                       are iso-altitude → profile-driven.
//   'altPerturbedAtHit': altPerturbed at first-hit. If this looks SMOOTH
//                       (clean bands) instead of NOISY (random per-pixel),
//                       the hash-noise perturbation isn't actually being
//                       applied per-voxel — debugging target itself.
//   'profileAtHit'    : profile value [0–1] at first-hit. If banded here,
//                       the profile transitions ARE creating the bands and
//                       the altitude perturbation isn't enough.
//   'coverageAtHit'   : coverage (post-3tap-lerp) at first-hit. If banded
//                       here, the bands are from the coverage lerp (smooth
//                       gradient along ray creates visible iso-coverage
//                       contours).
//   'baseCloudAtHit'  : baseShape × coverage at first-hit. If banded but
//                       altAtHit isn't, the bands are from the 3D base
//                       shape, not from altitude.
//   'lightingOnly'    : accumulated col / alpha (the cloud's unpremul
//                       colour, ignoring transparency). Pixels where alpha
//                       is non-zero show the cloud's actual shading.
//                       Compare against 'alpha' — if stripes appear here
//                       but NOT in 'alpha', they're in the colour/lighting
//                       computation (cone light march, phase, etc.), not
//                       in the alpha-buildup math. If stripes appear in
//                       BOTH, the underlying alpha integration has them
//                       too (density quantisation or coverage lerp kink).
//                       Tone-mapped with Reinhard so HDR brightness fits
//                       [0, 1] for visualisation.
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
  | "altAtHit"
  | "altPerturbedAtHit"
  | "profileAtHit"
  | "coverageAtHit"
  | "baseCloudAtHit"
  | "lightingOnly" = "off";

// Cloud-type vertical density profile (Nubis B1, base+top decomposition).
//
// Every cloud has a common low-altitude BASE BAND (alt 0.05–0.45) and a
// TOP BAND extension (alt 0.4 to per-column topAlt). The two bands are
// purely additive — no moat artifacts at coverage edges since the
// envelope is monotonic.
//
// Earlier the topBand was gated by `cType = smoothstep(0.5, 0.9, coverage)`
// to "keep cumulus visually special". The diagnostic-mode 'topAlt' visual
// confirmed this gate was the wrong call: with typical coverage values
// around 0.4–0.6, cType evaluates to ~0–0.06, multiplying away the entire
// topAlt-driven tower contribution. Adjacent columns with topAlt 0.55 vs
// 0.95 (5.2 km vertical difference) rendered as identical low blankets.
// The gate is removed so topAlt variation translates directly into
// visible cloud-top altitude variation, regardless of coverage.
//
// Top-heavy density bias (BASE_WEIGHT 0.5, TOP_WEIGHT 2.0): the DEBUG_VIZ
// 'firstHit' map showed every ray's first cloud hit clustering around
// depth01 ≈ 0.5 — the base-band entry altitude — regardless of topAlt.
// That's because the base band is dense enough at altitude01 0.05–0.25 to
// saturate alpha before the top band's altitude variation can register.
// Halving the base band and doubling the top band biases visible cloud-top
// altitude toward the topAlt-driven upper region, so tall columns (topAlt
// near 0.95) and short columns (topAlt near 0.4) read as visibly different
// heights from above. Total density per dense column ≈ unchanged because
// the top band fills most of the slab when topAlt is high.
// Provisional weights pending Phase D (temporal reprojection). The
// fundamental tradeoff:
//   high BASE_WEIGHT → solid continuous cloud blanket, looks "2D shell"
//     from above, no per-pixel speckle.
//   low BASE_WEIGHT  → real 3D column-top variation visible, but the
//     screen-space dither becomes obvious as a dotted/noisy pattern
//     because each pixel's first-hit lands at a slightly different
//     t-value with no spatial or temporal smoothing.
// Mid values balance the two failure modes. After TAA averages dither
// across frames the visible-3D end of the spectrum becomes viable;
// until then we sit closer to the shell-look end. Slight top-bias
// (2× / 0.5×) gives a nudge in the right direction without breaking
// the bulk cloud cover.
const BASE_WEIGHT = 0.5;
const TOP_WEIGHT = 2.0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cloudHeightProfile(alt01: any, topAlt: any): any {
  // Single asymmetric band with per-column top variation.
  //   baseEdge: sharp bottom at alt01 0.05–0.10 (cumulus condensation base).
  //   topFall:  per-column ramp down from full density at (topAlt - 0.35)
  //             to 0 at topAlt.
  //
  // Narrow transitions are deliberate: a wider fade was tried and it
  // collapsed the full-density plateau for most columns (median topAlt
  // ≈ 0.7 with width 0.55 left no plateau at all), making clouds too
  // transparent. The visible iso-altitude contour lines come from the
  // base shape being pure Perlin (no internal 3D structure to break up
  // altitude surfaces) and are the wrong thing to fix at the profile
  // level — see Issue #2 in noiseVolumes.ts (Perlin-Worley).
  //
  // topAlt ∈ [0.40, 0.95] from the per-column Perlin sample upstream:
  //   short column (topAlt = 0.40): full at 0.10, fades 0.05 → 0.40 → tops ~6.2 km
  //   tall column  (topAlt = 0.95): full at 0.10, fades 0.60 → 0.95 → tops ~13.4 km
  const baseEdge = smoothstep(float(0.05), float(0.10), alt01);
  const fadeStart = topAlt.sub(float(0.35));
  const topFall = float(1).sub(smoothstep(fadeStart, topAlt, alt01));
  return baseEdge.mul(topFall);
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
  // dtDense = 125 m = 0.000125 scaled. OD per dense step = density ×
  // densMul × dt. The right value targets SOFT alpha buildup over ~5–15
  // dense steps inside a cloud body, NOT instant saturation.
  //
  // densMul = 20000 targets soft cumulus edges:
  //   For mean post-erosion density ≈ 0.15 (typical cumulus):
  //     OD/step = 0.15 × 20000 × 0.000125 = 0.375
  //     → 10 dense steps (1.25 km) to saturate → soft edge over 1 km
  //     5 km cloud chord (40 dense steps) → OD = 15, α ≈ 1.0
  //   For dense cores (density ≈ 0.4):
  //     OD/step = 1.0 → saturates over ~5 dense steps
  //
  // History of this value:
  //   - 700: tuned against pure Perlin baseShape (low mean), gave α ≈ 0.4
  //     in cores. Too transparent.
  //   - 1500: still too transparent.
  //   - 1,500,000: empirically dialled in for "opaque" but actually
  //     produces BINARY saturation — α=1 at the first cloud voxel found.
  //     This made the visible cloud surface = hard iso-density isosurface
  //     in 3D, which renders as visible concentric "contour band" lines
  //     on the cumulus body (see CLOUD_DEBUGGING_LESSONS.md follow-on).
  //   - 20000: integrates over ~10 voxels for Schneider-style soft edges.
  //     Bands integrate into smooth cumulus shading because no single
  //     voxel dominates the visible alpha.
  //
  // Tune knob: if cumulus cores look too soft/transparent, push toward
  // 30000-50000. If edges hard / bands return, push toward 10000-15000.
  //
  // 15000 with the larger cumulus features (uBaseScale = 50):
  //   OD per dense step in core ≈ 0.5 → T per step ≈ 0.6
  //   ~10 dense steps to reach α = 0.99 → soft saturation over 1.25 km
  //   2 km core: α ≈ 0.85 (visibly translucent at edges, opaque core)
  //   5 km core: α ≈ 1.0 (fully opaque)
  //
  // Earlier 40000 was too high: α saturated in ~0.5 km, making each
  // iso-density surface in the cumulus body a hard visible ring. Soft
  // buildup over 1+ km lets the iso-surfaces merge into smooth shading.
  const uDensityMul = uniform(15000);
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
  // Detail-volume tiling: 2× base, so 10 km tile, 2.5 km cells at lowest
  // octave. Detail erosion now operates at sub-cumulus scale to carve
  // cauliflower silhouettes.
  const uDetailScale = uniform(100);
  // Detail-erosion strength. Schneider's reference uses 0.2 because his
  // weather map provides nearly-uniform-1 coverage in cloud regions, so
  // the erosion's job is just to nibble at edges. Ours uses gradient
  // weather-map values (0–1 with smooth transitions) — strong erosion
  // (0.3 originally) clipped voxels with baseCloud < threshold to zero,
  // which happened across most of any medium-coverage cloud body, leaving
  // the rendered cloud at α ≈ 0.6 over dark ocean → "gray centers".
  // 0.1 reduces threshold to ~0.05 so only the thinnest fringes of cloud
  // bodies (coverage < 0.1) are eroded away. Cumulus silhouettes lose
  // some sharpness but cloud bodies become visibly opaque.
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

    // Per-pixel dither: breaks up banding by jittering the ray entry point
    // by [0, dtSkip) per fragment. Adaptive march makes banding much less
    // visible than the old 16-step uniform march (dense regions are 4× finer
    // than the dither stride), but the dither still helps at the skip→dense
    // transition where dtSkip-spaced "discovery" samples land randomly.
    //
    // Phase D (TAA) needs the dither to vary FRAME-TO-FRAME per pixel so
    // exponential history blending averages it out. Pure-screen-position
    // hash (no time term) produces the same value at the same pixel every
    // frame: TAA can integrate within-pixel jitter from D2 but is helpless
    // against between-pixel pattern. Adding `uDitherPhase` (set per frame
    // by the caller from a low-discrepancy sequence) shifts the sin's
    // argument so each pixel cycles through a different value each frame,
    // and the 16-frame TAA window converges on a smooth result.
    const dither = fract(
      sin(
        dot(screenCoordinate.xy, vec2(12.9898, 78.233)).add(uDitherPhase),
      ).mul(43758.5453),
    );
    // Halve dither amplitude: per-pixel start-offset variance is now
    // 0–250 m instead of 0–500 m. At fast camera speeds (462 m/s in the
    // observed bug) TAA's history blend can't fully integrate the
    // 0–500 m variance across the 16-frame window — half-amplitude
    // dither halves per-frame alpha variance, which trades a tiny bit
    // of residual banding (still well below dtDense = 125 m) for
    // substantially less visible speckle when TAA is degraded.
    const tStart = tEnter.add(dither.mul(dtSkip).mul(0.5));

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
    const colSampleMid = texture3D(baseVolume, pMidColumn.mul(uColumnScale)).r;
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
    const covNear = texture(weatherMap, uvNear).r;
    const covMid = texture(weatherMap, uvMidWeather).r;
    const covFar = texture(weatherMap, uvFar).r;
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
    // 30× HDR multiplier calibrates against the flat overlay's actual peak
    // cloud brightness (CLOUD_BRIGHTNESS=3 × csf cubic ramp peaking ~7 ≈
    // 21 HDR). The previous 12× value was tuned against an incomplete
    // estimate that omitted the cubic ramp, leaving volumetric cloud
    // unpremul colour (sunColor × inScatter ≈ 12 × 0.5 = 6 HDR) ~3.5×
    // dimmer than the flat overlay's ~21 HDR. That difference reads as
    // "gray cores on perpendicular views" because the volumetric darkens
    // the composite even at low crossfade weights (a 10% volumetric
    // contribution at brightness 6 over a flat overlay at 21 yields 19.5
    // — perceptibly less than the 21-HDR pure-flat reference).
    // With sunColor=30, unpremul ≈ 30 × 0.5 = 15 HDR, matching the flat
    // overlay much more closely after AgX tonemapping. Limb regions
    // already at α=1 will appear brighter and bloom more — desirable for
    // the AAA-target silver-lining.
    const sunColor = mix(
      vec3(1.0, 0.96, 0.88),
      vec3(1.0, 0.55, 0.25),
      sunset,
    ).mul(21.0);
    // Skylight uses the same smooth daylight curve so the night side fades
    // continuously instead of clipping at the old narrow window.
    // 0.45: real cloud interiors get most of their light from the blue
    // sky dome, not direct sun. Bumped from 0.3 because the previous value
    // left perpendicular-view cloud cores reading as gray when composited
    // over the dark surface beneath (limb clouds saturated to white via
    // long ray paths, but center clouds with α~0.7 over dark land showed
    // the brightness gap clearly). Matches the flat overlay's peak HDR
    // brightness (~21 via CLOUD_BRIGHTNESS=3 × csf cubic) far more
    // closely under perpendicular views.
    const skylight = daylight.mul(0.45);

    // Powder blend, constant along ray (depends only on cosTheta).
    const powderFrontMix = clamp(cosTheta.mul(0.5).add(0.5), 0, 1);
    const powderFrontInv = powderFrontMix.oneMinus();

    // Constants, hoisted so TSL doesn't rebuild them per-iteration.
    const phaseIsotropic = float(0.07957747); // 1 / (4π)
    // Multi-scatter weight: brighter cloud cores via the Wrenninge octave
    // hack. 0.7 strikes a balance — too low gives muddy interiors, too high
    // washes the contrast between sun and shadow side.
    const msWeight = float(0.7);
    const densScale = uDensityMul;

    // Diagnostic counters hoisted to fragment scope so the debug return at
    // the bottom of the shader can read them. Always declared (zero cost
    // when DEBUG_VIZ === 'off' since the GPU's dead-store elimination
    // drops the increments). When the whole-column coverage gate fails
    // these stay 0, which correctly reads as "march never engaged".
    const primaryIters = float(0).toVar();
    const denseIters = float(0).toVar();
    // Sentinel = -1 (no hit). Captured the first time dense-mode finds
    // density > 0.01 along the ray; the t-value at that point is the cloud-
    // front depth for this pixel. Used by DEBUG_VIZ='firstHit' to verify
    // that adjacent pixels see clouds at different distances.
    const firstHitT = float(-1).toVar();
    // Per-pixel "values at the first-hit point" — capture once at first hit.
    // If the visible bands correspond to iso-X for some X, the corresponding
    // debug viz will show iso-colour bands at the same screen positions.
    // -1 sentinel = no hit captured (pixel never entered dense mode).
    const altAtHit = float(-1).toVar();           // raw altitude01 at hit
    const altPerturbedAtHit = float(-1).toVar();  // perturbed altitude at hit
    const profileAtHit = float(-1).toVar();       // profile value at hit
    const coverageAtHit = float(-1).toVar();      // coverage (3-tap lerp) at hit
    const baseCloudAtHit = float(-1).toVar();     // baseShape × coverage at hit

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
        const coverage = texture(weatherMap, uvP).r;

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
        const colSample = texture3D(baseVolume, pColumn.mul(uColumnScale)).r;
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

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const profile: any = cloudHeightProfile(altPerturbed, topAlt);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const coverageProfile: any = coverage.mul(profile);

        // Tracks whether this iteration found cloud (drives empty-streak
        // bookkeeping below). Zero by default; set to 1 inside the cloud
        // branches.
        const hitThisStep = float(0).toVar();

        // Step-level empty-space skip — gate on `coverage × profile` so the
        // outer fringes of the slab (above/below the active cloud-type band)
        // skip 3D taps entirely.
        If(coverageProfile.greaterThan(0.01), () => {
          // ── Cheap probe: Schneider macro shape (no detail erosion) ──
          // Used by both modes. In skip mode it's the only volume sample
          // taken; in dense mode it feeds into the detail-erosion pipeline.
          // R = pure Perlin, GBA = three octaves of Worley FBM. The remap
          // `(R + 1 - fbm) / (2 - fbm)` dilates the Perlin macro shape
          // proportionally to FBM strength.
          const baseSample = texture3D(baseVolume, p.mul(uBaseScale));
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
              // Capture cloud-front depth + co-located variables on first
              // hit (sentinel was -1). Used by the band-debug viz modes:
              // if the visible bands correspond to iso-X for some X, the
              // corresponding debug viz will show iso-colour bands at the
              // same screen positions where the user sees them.
              If(firstHitT.lessThan(0), () => {
                firstHitT.assign(t);
                altAtHit.assign(altitude01);
                altPerturbedAtHit.assign(altPerturbed);
                profileAtHit.assign(profile);
                coverageAtHit.assign(coverage);
                baseCloudAtHit.assign(baseCloud);
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
              const finalDensityNorm = baseCloud.toVar();
              const detailSample = texture3D(detailVolume, p.mul(uDetailScale));
              const detailFbm = detailSample.r
                .mul(0.625)
                .add(detailSample.g.mul(0.25))
                .add(detailSample.b.mul(0.125));
              // Altitude-modulated erosion: at low altitudes erode with raw
              // FBM (carves billowing undersides); at higher altitudes
              // invert (1-fbm) so the surviving wisps poke up like puffy
              // tops.
              const altMod = clamp(altitude01.mul(2.5), 0, 1);
              const erosion = mix(detailFbm, detailFbm.oneMinus(), altMod);
              const erosionRamp = smoothstep(float(0), float(0.3), baseCloud);
              const threshold = erosion
                .mul(uDetailErosion)
                .mul(erosionRamp)
                .mul(erosionStrength);
              const denom = float(1).sub(threshold).max(0.0001);
              const eroded = baseCloud
                .sub(threshold)
                .div(denom)
                .clamp(0, 1);
              finalDensityNorm.assign(eroded);

              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const density: any = finalDensityNorm.mul(profile).mul(densScale);

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
                  const profileL = cloudHeightProfile(altL, topAlt);
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const densL: any = coverage
                    .mul(profileL)
                    .mul(densScale)
                    .mul(0.55);
                  opticalDepthSun.addAssign(
                    densL.mul(float(LIGHT_STEP_SCALED)),
                  );
                };
                sampleConeTap(0.38051305, 0.92453449, -0.02111345, 0);
                sampleConeTap(-0.50625799, -0.03590792, -0.86163418, 1);
                sampleConeTap(-0.32509218, -0.94575601, -0.01428496, 2);
                sampleConeTap(0.09026238, -0.27376545, 0.95755165, 3);
                sampleConeTap(0.28128598, 0.42443639, -0.86065785, 4);
                sampleConeTap(-0.16852403, 0.14748697, 0.97460106, 5);
                Tsun.assign(exp(opticalDepthSun.negate()).mul(daylight));
              });

              // Multi-scatter approximation (Wrenninge octave hack).
              const Tsun_ms = pow(Tsun.max(0.0001), float(0.15)).mul(daylight);

              // Optical depth integrates over dtDense — accumulation only
              // happens in dense mode, and dense steps are dtDense apart.
              const opticalDepthStep = density.mul(dtDense);
              const powderTerm = float(1).sub(exp(opticalDepthStep.mul(-2)));
              const powderFactor = powderFrontInv
                .mul(powderTerm)
                .add(powderFrontMix);

              const scatterFrac = float(1).sub(exp(opticalDepthStep.negate()));
              const L = sunColor
                .mul(
                  phase
                    .mul(Tsun)
                    .add(phaseIsotropic.mul(Tsun_ms).mul(msWeight))
                    .add(skylight),
                )
                .mul(scatterFrac)
                .mul(powderFactor);
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
  const p25 = cloudHeightProfile(float(0.25), topAltMid);
  const p50 = cloudHeightProfile(float(0.50), topAltMid);
  const p75 = cloudHeightProfile(float(0.75), topAltMid);
  return vec4(p25, p50, p75, float(1));
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

    // ── Band-isolation viz modes ──
    // Each shows a per-pixel value evaluated AT the first-hit point. The
    // visible bands in "off" mode should also be visible (as iso-colour
    // contours) in whichever mode corresponds to the band's root cause.
    // Pixels that never hit cloud: black (sentinel = -1 → hit = false).
    if (
      DEBUG_VIZ === "altAtHit" ||
      DEBUG_VIZ === "altPerturbedAtHit" ||
      DEBUG_VIZ === "profileAtHit" ||
      DEBUG_VIZ === "coverageAtHit" ||
      DEBUG_VIZ === "baseCloudAtHit"
    ) {
      // Which value to visualise (already in [0, 1] for all these except
      // -1 sentinel; sentinel maps to 0 below).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let v: any;
      switch (DEBUG_VIZ) {
        case "altAtHit":
          v = altAtHit;
          break;
        case "altPerturbedAtHit":
          v = altPerturbedAtHit;
          break;
        case "profileAtHit":
          v = profileAtHit;
          break;
        case "coverageAtHit":
          v = coverageAtHit;
          break;
        case "baseCloudAtHit":
          v = baseCloudAtHit;
          break;
      }
      const hit = firstHitT.greaterThan(0);
      const vClamped = v.max(0).clamp(0, 1);
      // Jet ramp (same as firstHit) so subtle gradients are easier to read
      // than grayscale. blue→cyan→green→yellow→red across [0, 1].
      const r = smoothstep(float(0.5), float(0.9), vClamped);
      const g = float(1)
        .sub(smoothstep(float(0.7), float(1.0), vClamped))
        .mul(smoothstep(float(0.2), float(0.5), vClamped));
      const b = float(1).sub(smoothstep(float(0.3), float(0.6), vClamped));
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
      // Unpremultiply colour by alpha. Reinhard tone map so HDR brightness
      // (sunColor × 21 etc.) fits into [0, 1] for visualisation.
      const unpremul = col.div(alpha.max(0.001));
      const toneMapped = unpremul.div(unpremul.add(1));
      const hit = alpha.greaterThan(0.001);
      return {
        rgba: vec4(
          hit.select(toneMapped.x, float(0)),
          hit.select(toneMapped.y, float(0)),
          hit.select(toneMapped.z, float(0)),
          float(1),
        ),
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
