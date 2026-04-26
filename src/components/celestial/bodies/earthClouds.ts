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
import { getCloudNoise3D } from "./cloudNoise";
import { CLOUD_LAYER } from "@/components/space/renderLayers";

// Troposphere-ish slab. Photoreal-leaning, not exaggerated.
const CLOUD_INNER_ALTITUDE_KM = 1;
const CLOUD_OUTER_ALTITUDE_KM = 14;
const CLOUD_SEGMENTS = 64;

// Ray-march config. MUST be constants — TSL Loop count is baked into the shader.
const PRIMARY_STEPS = 16;
// Minimum per-step distance in scaled units (1 unit = 1000 km). 0.0004 ≈ 400 m.
// Caps step density for short slab paths so we don't oversample near-straight-down views.
const MIN_STEP_SCALED = 0.0004;
// Secondary march (toward sun) for self-shadowing. Coverage is cached once
// per pixel (see buildCloudFragment), so each light step is now pure ALU —
// 3 wider steps give the same total coverage (~12 km) with less loop overhead.
const LIGHT_STEPS = 3;
const LIGHT_STEP_SCALED = 0.004; // ~4 km; 3 steps ≈ 12 km into the slab.
// Henyey-Greenstein asymmetry: 0.6 gives the strong forward-scatter silver lining.
const HG_G = 0.6;

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

  const noiseVolume = getCloudNoise3D();

  const uInnerRadius = uniform(innerRadiusScaled);
  const uOuterRadius = uniform(outerRadiusScaled);
  // Shared drift uniform — future-proofed for sim-time animation (step 2+).
  const uCloudUvOffset = uniform(new THREE.Vector2(0, 0));
  // Extinction × density_raw (scaled-km units). Tuned visually; no physical
  // basis yet. 700 lets thick weather-map regions saturate to full opacity
  // (1 - exp(-OD) → 1) within the 14 km slab, matching the flat overlay's
  // "solid white blob" look instead of a half-transparent grey wash.
  const uDensityMul = uniform(700);
  // Noise tiles per scaled unit. 1 scaled unit = 1000 km, so 45 ≈ one tile per 22 km.
  const uNoiseScale = uniform(45);
  // Detail noise strength — how much the high-freq noise erodes cloud edges.
  // 0 = no erosion, 1 = can fully remove edges. 0.35 keeps the wispy look
  // without grinding cloud bodies down to grey at the silhouette.
  const uDetailErosion = uniform(0.35);
  // Domain-warp amount in UV space. The weather map is sampled once per
  // fragment at the slab midpoint, so the cloud silhouette is bottlenecked
  // by the 8 k texture's grid. Perturbing the lookup UV by a noise-driven
  // offset adds high-frequency detail to silhouettes without raising the
  // texture resolution. Range: ~0.003 (subtle) to ~0.012 (chunky breakup).
  const uWarpAmount = uniform(0.005);

  // Shared crossfade uniform owned by earth.ts (`createUniforms`). 0 → flat
  // overlay only (above 35 k km), 1 → volumetric only (below 25 k km). The
  // shell mounts at the lod.near boundary (35 k) and ramps in from 0 alpha,
  // hiding both the tier swap and the shell-mount discontinuity.
  const uVolumetricBlend = ctx.uniforms.uVolumetricBlend;

  mat.fragmentNode = buildCloudFragment({
    weatherMap,
    noiseVolume,
    uInnerRadius,
    uOuterRadius,
    uCloudUvOffset,
    uDensityMul,
    uNoiseScale,
    uDetailErosion,
    uWarpAmount,
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
  noiseVolume,
  uInnerRadius,
  uOuterRadius,
  uCloudUvOffset,
  uDensityMul,
  uNoiseScale,
  uDetailErosion,
  uWarpAmount,
  uSunRel,
  uVolumetricBlend,
}: {
  weatherMap: THREE.Texture;
  noiseVolume: THREE.Data3DTexture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uInnerRadius: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uOuterRadius: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uCloudUvOffset: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uDensityMul: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uNoiseScale: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uDetailErosion: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uWarpAmount: any;
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
    // Adaptive step: clamp the step to a minimum world distance so short slabs
    // (thin grazing hits, straight-down views) don't over-iterate.
    const dt = slabLen.div(float(PRIMARY_STEPS)).max(float(MIN_STEP_SCALED));

    // Per-pixel dither: breaks up banding from the low step count by jittering
    // the ray entry point by [0, dt) per fragment. Cheap sin-hash gives a
    // noise-ish pattern that hides banding far better than uniform sampling at 16 steps.
    const dither = fract(
      sin(dot(screenCoordinate.xy, vec2(12.9898, 78.233))).mul(43758.5453),
    );
    const tStart = tEnter.add(dither.mul(dt));

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
    const uMid = fract(atan(dirMid.z, dirMid.x.negate()).mul(invTwoPi));
    const vMid = acos(clamp(dirMid.y.negate(), -1, 1)).mul(invPi);
    const uvMid = vec2(uMid, vMid).add(uCloudUvOffset);
    // Domain warp: perturb the weather-map UV with two noise samples so the
    // cloud silhouette isn't locked to the 8 k texture's grid. Two samples
    // at offset positions inside the same noise volume give independent
    // X/Y displacement; a single scalar would warp diagonally and look
    // ridged. Sampled at 2× the cloud-noise scale for finer-grained
    // breakup than the cloud body itself, and remapped from [0,1] → [-1,1]
    // so the warp is centred (non-biased average displacement).
    const warpScale = uNoiseScale.mul(2.0);
    const warpNx = texture3D(noiseVolume, pMid.mul(warpScale))
      .r.sub(0.5)
      .mul(2);
    const warpNy = texture3D(
      noiseVolume,
      pMid.mul(warpScale).add(vec3(11.3, 7.7, 13.1)),
    )
      .r.sub(0.5)
      .mul(2);
    const uvWarped = uvMid.add(vec2(warpNx, warpNy).mul(uWarpAmount));
    const coverage = texture(weatherMap, uvWarped).r;

    // Squared edge mask for detail erosion — depends only on coverage, hoist.
    const edgeMask = float(1).sub(coverage).mul(float(1).sub(coverage));

    // ── Smooth terminator ──
    // sunDotPoint is cos of the sun-zenith angle at the cloud point.
    //   1 → sun overhead, 0 → sun on horizon, < 0 → below horizon.
    // For a cloud at altitude h, the geometric umbra boundary is at
    // sunDotPoint ≈ -sqrt(2h/R) (≈ -0.06 for h = 12 km). A binary umbra
    // test produces a hard line; instead we softly attenuate Tsun across
    // a window centred on that boundary, which gives the diffuse penumbra
    // look real cloud terminators have. The previous discrete
    // ray-vs-planet shadow test is now subsumed: at sunDotPoint ≪ 0 the
    // daylight factor goes to 0 and the light march is skipped entirely.
    const pDotS_Mid = dot(pMid, sunDirLocal);
    const sunDotPoint = pDotS_Mid.div(rMid);
    const daylight = smoothstep(float(-0.1), float(0.25), sunDotPoint);
    // Sunset peaking: `4·d·(1-d)` is a tent that peaks at daylight = 0.5,
    // i.e. exactly the terminator band. No extra smoothstep math needed.
    const sunset = daylight.mul(daylight.oneMinus()).mul(4);
    // Tint sunlight toward warm orange at the terminator (Rayleigh-reddened
    // light path through thicker atmosphere). The tinted colour replaces the
    // previous constant `vec3(1, 0.96, 0.88) * 2.8`.
    // 4.5× HDR multiplier matches the effective brightness of the flat
    // overlay (CLOUD_BRIGHTNESS=3 × surface normal-mapped boost ≈ 1.6×) so
    // the volumetric clouds read as bright white rather than grey under
    // AgX tonemapping, and so bloom catches the silver-lining edges.
    const sunColor = mix(
      vec3(1.0, 0.96, 0.88),
      vec3(1.0, 0.55, 0.25),
      sunset,
    ).mul(12.0);
    // Skylight uses the same smooth daylight curve so the night side fades
    // continuously instead of clipping at the old narrow window.
    const skylight = daylight.mul(0.3);

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
    const detailMul = uNoiseScale.mul(3.5);

    // ── Whole-pixel empty-space skip ──
    // If the slab-midpoint coverage is already near-zero, the entire column is
    // empty: skip all 16 primary iterations and both nested loops. Dark regions
    // of the weather map (oceans with clear sky) cost almost nothing.
    If(coverage.greaterThan(0.01), () => {
      Loop(PRIMARY_STEPS, ({ i }) => {
        const t = tStart.add(dt.mul(float(i)));
        If(t.greaterThan(tExit), () => {
          Break();
        });

        const p = roLocal.add(rdLocal.mul(t));
        const r = length(p).max(0.0001);
        const altitude01 = clamp(
          sub(r, uInnerRadius).mul(invSlabThickness),
          0,
          1,
        );

        const hRamp = smoothstep(float(0), float(0.2), altitude01);
        const hFade = float(1).sub(
          smoothstep(float(0.45), float(1.0), altitude01),
        );
        const heightGradient = hRamp.mul(hFade);
        const coverageHeight = coverage.mul(heightGradient);

        // Step-level empty-space skip (cheap scalar gate; avoids 3D samples
        // outside the height-gradient peak).
        If(coverageHeight.greaterThan(0.01), () => {
          // Cheap-first density probe (Tier 4):
          // Sample base noise unconditionally — it's what defines the puffy
          // shape and is needed for any visible cloud. Then gate the detail
          // fetch behind a pre-erosion density check. Detail erosion only
          // matters where density is already non-trivial; this skips the
          // second 3D sample for sparse / wispy regions and edge fade-outs.
          const noise = texture3D(noiseVolume, p.mul(uNoiseScale)).r;
          const baseMod = float(0.6).add(float(0.4).mul(noise));
          const noiseMod = baseMod.toVar();

          If(coverageHeight.mul(baseMod).greaterThan(0.05), () => {
            const detail = texture3D(noiseVolume, p.mul(detailMul)).r;
            const erosion = detail.mul(edgeMask).mul(uDetailErosion);
            noiseMod.assign(baseMod.sub(erosion).max(0));
          });

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const density: any = coverageHeight.mul(noiseMod).mul(densScale);

          // Sun-march: no texture taps (coverage is cached from mid-slab).
          // Pure ALU; cheap enough that the compiler can unroll it. Result
          // is multiplied by `daylight` so the shadow side fades continuously
          // rather than snapping to zero at the umbra boundary. The branch
          // on `daylight > 0.001` skips the loop on the deep-night side
          // where the multiplied result would be zero anyway.
          const Tsun = float(0).toVar();
          If(daylight.greaterThan(0.001), () => {
            const opticalDepthSun = float(0).toVar();
            Loop(LIGHT_STEPS, ({ i: j }) => {
              const pL = p.add(
                sunDirLocal.mul(
                  float(LIGHT_STEP_SCALED).mul(float(j).add(0.5)),
                ),
              );
              const rL = length(pL);
              const altL = clamp(
                sub(rL, uInnerRadius).mul(invSlabThickness),
                0,
                1,
              );
              const hRampL = smoothstep(float(0), float(0.2), altL);
              const hFadeL = float(1).sub(
                smoothstep(float(0.45), float(1.0), altL),
              );
              const hGradL = hRampL.mul(hFadeL);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const densL: any = coverage.mul(hGradL).mul(densScale);
              opticalDepthSun.addAssign(densL.mul(float(LIGHT_STEP_SCALED)));
            });
            Tsun.assign(exp(opticalDepthSun.negate()).mul(daylight));
          });

          // Multi-scatter approximation. The `.max(0.0001)` is a NaN guard
          // for `pow(0, 0.3)`, but on the night side that floor `pow`s up to
          // ~0.063 — without the daylight gate, sunColor × 0.063 leaks visible
          // grey onto the unlit hemisphere (very noticeable at high HDR sun
          // multipliers). Multiplying by `daylight` zeros the contribution
          // cleanly past the terminator.
          const Tsun_ms = pow(Tsun.max(0.0001), float(0.3)).mul(daylight);

          const opticalDepthStep = density.mul(dt);
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

        If(T.lessThan(0.01), () => {
          Break();
        });
      });
    });

    const alpha = clamp(sub(1, T), 0, 1);
    // Premultiplied output — `col` is already color·α from front-to-back
    // accumulation. Blending is configured with (ONE, 1-α) to match.
    // Scale BOTH channels by the crossfade factor: since the framebuffer math
    // is `out = src + (1-src.a)*dst`, multiplying (col, alpha) by k uniformly
    // scales the cloud's contribution toward fully transparent without
    // changing the unpremultiplied colour.
    return vec4(col, alpha).mul(uVolumetricBlend);
  })();
}
