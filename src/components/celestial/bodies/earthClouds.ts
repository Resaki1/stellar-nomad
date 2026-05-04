import * as THREE from "three";
import { NodeMaterial } from "three/webgpu";
import {
  Fn,
  If,
  Loop,
  Break,
  uniform,
  texture,
  texture3D,
  positionLocal,
  cameraPosition,
  modelWorldMatrixInverse,
  screenCoordinate,
  vec2,
  vec3,
  vec4,
  float,
  dot,
  normalize,
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

// Troposphere-ish slab. Photoreal-leaning, not exaggerated.
const CLOUD_INNER_ALTITUDE_KM = 1;
const CLOUD_OUTER_ALTITUDE_KM = 14;
const CLOUD_SEGMENTS = 64;

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
// Skip-mode step denominator: dtSkip = slab / SKIP_STEP_DENOM. Sized so an
// all-empty pixel reaches tExit in ~16 cheap probes (matches the previous
// uniform 16-step march for empty regions).
const SKIP_STEP_DENOM = 16;
// dtDense / dtSkip ratio. 0.25 = 4× finer sampling inside cloud bodies.
// Worst-case cumulative dense-step traversal: 64 short × ~200 m = 12.8 km
// (≈ slab thickness), so MAX_PRIMARY_STEPS=96 covers a full traversal in
// dense mode plus skip-mode entry/exit margin.
const DENSE_STEP_RATIO = 0.25;
// Consecutive dense-mode empty samples before falling back to skip mode.
// 8 × dtDense ≈ 1.6 km of empty space tolerated inside dense mode before
// a switch — keeps cloud-body holes from triggering ping-pong, but falls
// back fast enough not to waste short steps on truly-empty post-cloud
// columns.
const EMPTY_THRESHOLD = 8;
// Minimum per-step distance in scaled units (1 unit = 1000 km). 0.0004 ≈ 400 m.
// Caps step density for short slab paths so we don't oversample near-straight-down views.
const MIN_STEP_SCALED = 0.0004;
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
//                   grayscale: black = topAlt=0.55, white = topAlt=0.95. The
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
// =============================================================================
const DEBUG_VIZ: "off" | "alpha" | "topAlt" | "insideInner" | "iters" | "slabLen" = "off";

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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cloudHeightProfile(alt01: any, topAlt: any): any {
  const baseBand = smoothstep(float(0), float(0.05), alt01).mul(
    float(1).sub(smoothstep(float(0.25), float(0.45), alt01)),
  );
  const topBand = smoothstep(float(0.4), float(0.55), alt01).mul(
    float(1).sub(smoothstep(topAlt.sub(float(0.2)), topAlt, alt01)),
  );
  return baseBand.add(topBand);
}

/**
 * STEP 2 — density ray-march driven by the existing cloud texture (weather map)
 * and a height gradient. No lighting yet; output is white with alpha = 1 − T.
 */
export function buildEarthCloudShell(ctx: ExtraMeshContext): ExtraMeshDef[] {
  if (ctx.tier !== "near") return [];

  const weatherMap = ctx.textures.clouds;
  if (!weatherMap) return [];

  const innerRadiusScaled = kmToScaledUnits(
    PLANET_RADIUS_KM + CLOUD_INNER_ALTITUDE_KM,
  );
  const outerRadiusScaled = kmToScaledUnits(
    PLANET_RADIUS_KM + CLOUD_OUTER_ALTITUDE_KM,
  );

  const geo = new THREE.SphereGeometry(
    outerRadiusScaled,
    CLOUD_SEGMENTS,
    CLOUD_SEGMENTS,
  );

  const mat = new NodeMaterial();
  // BackSide: renders the far hemisphere of the geometry. From outside the
  // shell this produces an identical result to FrontSide — the back-face
  // fragment sits on the same view ray as the front-face would, so the
  // analytic intersection inside the fragment shader returns identical
  // tEnter/tExit and the march outputs the same colour. From INSIDE the
  // shell (camera flying below 14 km altitude), FrontSide culls every face
  // and the cloud layer disappears entirely; BackSide keeps the inner
  // surface visible so the shell stays rendered when the player is in or
  // below it.
  mat.side = THREE.BackSide;
  mat.transparent = true;
  mat.depthWrite = false;
  // Premultiplied alpha — simpler compositing pipeline. Shader returns
  // (color*alpha, alpha) directly; we blend with (ONE, 1-α) on both channels
  // so sampling the half-res RT interpolates correctly (bilinear filtering on
  // non-premul colors bleeds fringes at transparency edges).
  mat.blending = THREE.CustomBlending;
  mat.blendSrc = THREE.OneFactor;
  mat.blendDst = THREE.OneMinusSrcAlphaFactor;
  mat.blendSrcAlpha = THREE.OneFactor;
  mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;

  const baseVolume = getCloudBaseVolume();
  const detailVolume = getCloudDetailVolume();

  const uInnerRadius = uniform(innerRadiusScaled);
  const uOuterRadius = uniform(outerRadiusScaled);
  // Shared drift uniform — future-proofed for sim-time animation (step 2+).
  const uCloudUvOffset = uniform(new THREE.Vector2(0, 0));
  // Extinction × density_raw (scaled-km units). 700 compensates for
  // baseShape's mean (~0.6) attenuation in the full Schneider remap —
  // gives cores comparable opacity to the diagnostic-state pure-coverage
  // model at densMul=500.
  const uDensityMul = uniform(700);
  // Base-volume tiling per scaled unit. 1 scaled unit = 1000 km, so 250 ≈
  // one tile per 4 km — close to Schneider's reference ratio (slab/tile ≈ 7).
  // At this scale, the lowest-octave Worley cells (tile/4 = ~1 km) are below
  // typical screen-pixel resolution at most viewing distances; the highest
  // octave (~80 m cells) is sub-pixel everywhere. Mip filtering averages the
  // remaining structure into smooth in-cloud detail, instead of the visible
  // cellular grid we got with the old 22 km tile. Was 45.
  const uBaseScale = uniform(250);
  // Detail-volume tiling: 2× base, so ~2 km tile, ~0.4 km cells at lowest
  // octave. Wispy edge detail at sub-cloud-feature scale. Was 90 (~11 km).
  const uDetailScale = uniform(500);
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
  // Domain-warp amount in UV space. Perturbs the weather-map UV by a
  // noise-driven offset to break up alignment with the 8 k texture's grid.
  // 0.002 ≈ 70 km world at the equator — small enough that volumetric
  // cloud features stay aligned with the weather map (no visible "stereo"
  // offset between flat-overlay and volumetric clouds during the 25-35 k
  // crossfade), large enough to break up texel-grid silhouettes at close
  // range. Was 0.005 — too aggressive, shifted clouds ~200 km off their
  // weather-map positions.
  const uWarpAmount = uniform(0.002);
  // Column-scale tile for per-column cloud-top variation (Nubis B2). Sampled
  // from baseVolume.r (Perlin) at the column's projection onto the inner
  // shell. The base volume's R channel is Perlin at G_LOW=4 (volume cycles
  // every 0.25 of texture coord), so an effective "tile size" of ~5km in
  // world units corresponds to scale 50.
  const uColumnScale = uniform(50);
  // Cone-light radius — multiplier on the world-space kernel offsets in the
  // light march. 0.3 puts the outermost sample ~3 km perpendicular to the
  // primary sample (kernel norm ≈ 1, stepDist at i=5 ≈ 0.011 scaled = 11 km;
  // 0.3 × 11 km ≈ 3 km perpendicular spread). Wider = smoother but starts
  // sampling outside the cloud body for narrow towers; tighter = more
  // speckle. Schneider's reference is in this 0.25–0.4 range.
  const uLightConeRadius = uniform(0.3);

  // Shared crossfade uniform owned by earth.ts (`createUniforms`). 0 → flat
  // overlay only (above 35 k km), 1 → volumetric only (below 25 k km). The
  // shell mounts at the lod.near boundary (35 k) and ramps in from 0 alpha,
  // hiding both the tier swap and the shell-mount discontinuity.
  const uVolumetricBlend = ctx.uniforms.uVolumetricBlend;

  mat.fragmentNode = buildCloudFragment({
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
    uWarpAmount,
    uColumnScale,
    uLightConeRadius,
    uSunRel: ctx.uSunRel,
    uVolumetricBlend,
  });

  return [
    {
      key: "earth-clouds",
      geometry: geo,
      material: mat,
      tier: "near",
      renderLayer: CLOUD_LAYER,
    },
  ];
}

function buildCloudFragment({
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
  uWarpAmount,
  uColumnScale,
  uLightConeRadius,
  uSunRel,
  uVolumetricBlend,
}: {
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
  uWarpAmount: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uColumnScale: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uLightConeRadius: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSunRel: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uVolumetricBlend: any;
}) {
  return Fn(() => {
    // Ray in local (object) space — sphere is origin-centred, so UVs come out
    // in the same frame the surface texture was authored in.
    const roLocal = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;
    const rdLocal = normalize(sub(positionLocal, roLocal));

    const b = dot(roLocal, rdLocal);
    const d2 = dot(roLocal, roLocal);

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
    // Two step lengths for the adaptive march. dtSkip targets slab/16 (same
    // total coverage as the old uniform march in empty regions); dtDense is
    // 4× finer for sampling inside cloud bodies. MIN_STEP_SCALED floor
    // protects against grazing hits with sub-meter slab paths.
    const dtSkip = slabLen
      .div(float(SKIP_STEP_DENOM))
      .max(float(MIN_STEP_SCALED));
    const dtDense = dtSkip.mul(float(DENSE_STEP_RATIO));

    // Per-pixel dither: breaks up banding by jittering the ray entry point
    // by [0, dtSkip) per fragment. Adaptive march makes banding much less
    // visible than the old 16-step uniform march (dense regions are 4× finer
    // than the dither stride), but the dither still helps at the skip→dense
    // transition where dtSkip-spaced "discovery" samples land randomly.
    const dither = fract(
      sin(dot(screenCoordinate.xy, vec2(12.9898, 78.233))).mul(43758.5453),
    );
    const tStart = tEnter.add(dither.mul(dtSkip));

    // Sun direction in local space — pure-rotation transform (w=0 ignores translation).
    const sunDirLocal = normalize(
      modelWorldMatrixInverse.mul(vec4(uSunRel, 0)).xyz,
    );

    // Henyey-Greenstein phase, constant per fragment (sun is effectively infinite
    // distance compared to cloud scale, and view dir is constant along the march).
    const cosTheta = dot(rdLocal, sunDirLocal);
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

    // ── Per-pixel cache (the big perf win) ──
    // The slab is 14 km thick; the planet radius is 6378 km. Along a non-grazing
    // view ray, the direction from Earth's centre changes by <0.13° across the
    // slab, which translates to a UV change of <0.001. So the weather-map value
    // is effectively constant along the ray. Sampling it ONCE at the slab mid-
    // point and reusing it in both the primary loop and the light march drops
    // the texture-tap count from ~(PRIMARY_STEPS * (1 + LIGHT_STEPS)) = 64 down
    // to 1. That's the difference between sampler-throttled and ALU-bound.
    //
    // Planet-shadow + skylight are likewise approximated at the slab midpoint —
    // both vary continuously and smoothly across 14 km, so per-step sampling
    // is wasted work.
    const tMid = tEnter.add(slabLen.mul(0.5));
    const pMid = roLocal.add(rdLocal.mul(tMid));
    const rMid = length(pMid).max(0.0001);
    const dirMid = pMid.div(rMid);

    // Slab-midpoint topAlt sample for the 'topAlt' diagnostic mode. Cheap
    // (one extra texture3D tap; same column-scale value the loop already
    // computes per-step). Always evaluated so JS-side debug branching at
    // build time can use it without restructuring the shader graph.
    const pMidColumn = dirMid.mul(uInnerRadius);
    const colSampleMid = texture3D(baseVolume, pMidColumn.mul(uColumnScale)).r;
    const colSharpMid = smoothstep(float(0.3), float(0.7), colSampleMid);
    const topAltMid = float(0.55).add(colSharpMid.mul(0.4));
    const uMid = fract(atan(dirMid.z, dirMid.x.negate()).mul(invTwoPi));
    const vMid = acos(clamp(dirMid.y.negate(), -1, 1)).mul(invPi);
    const uvMid = vec2(uMid, vMid).add(uCloudUvOffset);
    // ── DIAGNOSTIC: domain warp disabled ──
    // The warp tap reads detail volume's Worley channels (cells 1.4–2.75 km),
    // and at close camera range those cells resolve as visible UV
    // displacement, baking a cellular grid pattern into the weather map
    // sampling itself. Disabling to confirm. The original warp lines are
    // preserved in git history; once we verify this is the source we'll
    // re-introduce with a smoother (Perlin-only, lower-freq) warp source.
    const uvWarped = uvMid;
    const coverage = texture(weatherMap, uvWarped).r;

    // ── Smooth terminator ──
    // sunDotPoint is cos of the sun-zenith angle at the cloud point.
    //   1 → sun overhead, 0 → sun on horizon, < 0 → below horizon.
    // ASYMMETRIC window: tight night-side cutoff at sunDotPoint = -0.1
    // (no light past the geometric umbra — clouds go fully dark on the
    // night side, matching real cloud-shadow behaviour and the city-light
    // backdrop), but wide day-side falloff to sunDotPoint = 0.5 so the
    // brightness ramps gradually across the lit hemisphere matching the
    // surface flat-overlay's natural lighting curve. A symmetric wide
    // window leaks daylight onto the night side; a symmetric tight window
    // produces a hard step at the terminator during crossfade.
    const pDotS_Mid = dot(pMid, sunDirLocal);
    const sunDotPoint = pDotS_Mid.div(rMid);
    const daylight = smoothstep(float(-0.1), float(0.5), sunDotPoint);
    // Sunset peaking: `4·d·(1-d)` is a tent that peaks at daylight = 0.5,
    // i.e. exactly the terminator band. No extra smoothstep math needed.
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

    // ── Whole-pixel empty-space skip ──
    // If the slab-midpoint coverage is already near-zero, the entire column is
    // empty: skip all primary iterations and both nested loops. Dark regions
    // of the weather map (oceans with clear sky) cost almost nothing.
    If(coverage.greaterThan(0.01), () => {
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

        const p = roLocal.add(rdLocal.mul(t));
        const r = length(p).max(0.0001);
        const altitude01 = clamp(
          sub(r, uInnerRadius).mul(invSlabThickness),
          0,
          1,
        );

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
        // so topAlt actually spans most of [0.55, 0.95] (5.2 km of
        // column-top variation).
        const pColumn = p.div(r).mul(uInnerRadius);
        const colSample = texture3D(baseVolume, pColumn.mul(uColumnScale)).r;
        const colSharp = smoothstep(float(0.3), float(0.7), colSample);
        const topAlt = float(0.55).add(colSharp.mul(0.4));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const profile: any = cloudHeightProfile(altitude01, topAlt);
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

              // Phase B: apply the cloud-type vertical profile AFTER
              // erosion. The eroded silhouette stays consistent across the
              // slab; the profile shapes the density magnitude with
              // altitude.
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
                  const pL = p.add(sunDirLocal.mul(stepDist)).add(conePerturb);
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
      return vec4(alpha, alpha, alpha, float(1));
    }
    if (DEBUG_VIZ === "topAlt") {
      // Map [0.55, 0.95] → [0, 1] for grayscale display.
      const topAltNorm = topAltMid
        .sub(float(0.55))
        .div(float(0.4))
        .clamp(0, 1);
      return vec4(topAltNorm, topAltNorm, topAltNorm, float(1));
    }
    if (DEBUG_VIZ === "insideInner") {
      const r = insideInner.select(float(1), float(0));
      const g = insideInner.select(float(0), float(1));
      return vec4(r, g, float(0), float(1));
    }
    if (DEBUG_VIZ === "iters") {
      const primaryNorm = primaryIters
        .div(float(MAX_PRIMARY_STEPS))
        .clamp(0, 1);
      const denseNorm = denseIters
        .div(float(MAX_PRIMARY_STEPS))
        .clamp(0, 1);
      return vec4(primaryNorm, denseNorm, float(0), float(1));
    }
    if (DEBUG_VIZ === "slabLen") {
      // Normalise against the nominal vertical slab length (13 km in
      // scaled units = 0.013). Grazing-angle slabs go well above 1.0.
      const slabNorm = slabLen.div(float(0.013)).clamp(0, 1);
      return vec4(slabNorm, slabNorm, slabNorm, float(1));
    }

    // Premultiplied output — `col` is already color·α from front-to-back
    // accumulation. Blending is configured with (ONE, 1-α) to match.
    // Scale BOTH channels by the crossfade factor: since the framebuffer math
    // is `out = src + (1-src.a)*dst`, multiplying (col, alpha) by k uniformly
    // scales the cloud's contribution toward fully transparent without
    // changing the unpremultiplied colour.
    return vec4(col, alpha).mul(uVolumetricBlend);
  })();
}
