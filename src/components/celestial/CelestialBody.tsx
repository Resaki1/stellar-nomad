"use client";

import { memo, useCallback, useEffect, useMemo, useState, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { useDeferredKTX2 } from "@/hooks/useDeferredKTX2";
import * as THREE from "three";
import { useAtomValue } from "jotai";
import { NodeMaterial } from "three/webgpu";
import { Fn, uniform, vec4 } from "three/tsl";
import SimGroup from "../space/SimGroup";
import StellarPoint from "../space/StellarPoint";
import { kmToScaledUnits, toScaledUnitsKm } from "@/sim/units";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { STAR_LUMINOSITY_SUN, STAR_POSITION_KM,
  STAR_RADIUS_KM,
} from "@/sim/celestialConstants";
import {
  STAR_COLOR_LINEAR,
  getPreExposure,
  sunIlluminanceAt,
} from "../space/photometry";
import { useFarLOD } from "./useFarLOD";
import {
  albedoScaleUniform,
  publishStellarPointAlbedo,
  requestAlbedoCalibration,
} from "./albedoCalibration";
import { publishLodState, publishLodThresholds } from "./lodState";
import { stellarPointFade } from "@/components/space/StellarPoint";
import { bodyReflectanceRgb } from "./bodyColour";
import {
  setAtmosphereBody,
  clearAtmosphereBody,
} from "../space/atmospherePass";
import { setSunOccluder, clearSunOccluder } from "@/components/space/sunOcclusion";
import { allBodyDefs, updateEphemerisPositions } from "@/sim/celestialConstants";
import { bodyOrientation, createBodyOrientation, jdFromUnixMs } from "@/sim/ephemeris";
import { simEpochMsAtom } from "@/store/simTime";
import {
  createEclipseUniforms,
  eclipseVisibilityNode,
  updateEclipseUniforms,
  type EclipseUniforms,
} from "./bodyEclipse";
import type { CelestialBodyConfig, ExtraMeshDef } from "./types";

// ── Shared scratch vectors (safe: useFrame is sequential) ──
const _sunScaled = new THREE.Vector3();
const _bodyScaled = new THREE.Vector3();
const _sunRelative = new THREE.Vector3();
const _relativeKm = new THREE.Vector3();
const _farFadeBuf = new THREE.Vector2();
const _shipToBody = new THREE.Vector3();
// ── Ephemeris orientation scratch (no per-frame allocation) ──
// Live body orientation (ephemeris). ⚠ A BASIS, not an Euler/quaternion pair:
// `bodyOrientation` returns the pole and the prime meridian, and three vectors
// with a fixed column order have neither an order nor a roll convention left to
// get wrong. See sim/ephemeris.ts for the 93° Sahara-vs-Mexico error that the
// previous `setFromUnitVectors` + spin formulation produced.
const _axX = new THREE.Vector3();
const _axY = new THREE.Vector3();
const _axZ = new THREE.Vector3();
const _basis = new THREE.Matrix4();

/** Prefetch multiplier: start loading textures at this factor × LOD threshold */
const PREFETCH_MULT = 1.5;

/** Treat empty or pending texture results as null */
function texOrNull(
  tex: Record<string, THREE.Texture> | null,
): Record<string, THREE.Texture> | null {
  if (!tex || Object.keys(tex).length === 0) return null;
  return tex;
}

// ─────────────────────────────────────────────────────────────────────
// TexturedLODs: inner component that loads textures + builds materials
// ─────────────────────────────────────────────────────────────────────

type TexturedLODsProps = {
  config: CelestialBodyConfig;
  scaledRadius: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSunRel: any;
  /** Per-frame sun illuminance at this body, game units. See FragmentNodeContext. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSunIlluminance: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uniforms: Record<string, any>;
  nearRef: { current: THREE.Mesh | null };
  midRef: { current: THREE.Mesh | null };
  extraNearRefs: React.MutableRefObject<(THREE.Mesh | null)[]>;
  extraMidRefs: React.MutableRefObject<(THREE.Mesh | null)[]>;
  shouldLoadMid: boolean;
  shouldLoadNear: boolean;
  /** 0 = not loaded, 1 = compiling, 2 = ready */
  nearReadyState: { current: number };
  /** 0 = not loaded, 1 = compiling, 2 = ready */
  midReadyState: { current: number };
  /** D34 eclipse uniforms, owned by the parent. */
  eclipseU: EclipseUniforms;
};

function TexturedLODs({
  config,
  scaledRadius,
  uSunRel,
  uSunIlluminance,
  uniforms,
  nearRef,
  midRef,
  extraNearRefs,
  extraMidRefs,
  shouldLoadMid,
  shouldLoadNear,
  nearReadyState,
  midReadyState,
  eclipseU,
}: TexturedLODsProps) {
  const { camera, gl } = useThree((s) => ({ camera: s.camera, gl: s.gl }));

  // Gate texture loading by distance-based prefetch flags
  const rawNearTex = useDeferredKTX2(
    shouldLoadNear ? (config.near?.textures ?? {}) : {},
    "/basis/",
  );
  const rawMidTex = useDeferredKTX2(
    shouldLoadMid ? config.mid.textures : {},
    "/basis/",
  );
  const nearTex = texOrNull(rawNearTex as Record<string, THREE.Texture> | null);
  const midTex = texOrNull(rawMidTex as Record<string, THREE.Texture> | null);

  // ── D09: albedo calibration ────────────────────────────────────────────────
  // ONE scale per body, derived from the texture that actually loaded, applied to
  // every tier. See albedoCalibration.ts for why it is measured rather than tabled.
  //
  // ⚠ MEASURED FROM THE **MID** TIER ON PURPOSE. `mid` is required by the type while
  // `near` is optional, and it loads at a greater distance — so the scale exists
  // before the near tier can ever draw, and which texture defined it is
  // deterministic rather than a race between two streams. A near/mid pair that
  // disagreed about its own mean would otherwise give a body two different albedos
  // at two distances, which is the LOD step D09 exists to remove.
  const uAlbedoScale = useMemo(() => albedoScaleUniform(config.id), [config.id]);
  // ── D34: body-on-body eclipses ───────────────────────────────────────────
  // ⚠ The uniforms are created and updated by the PARENT (`CelestialBody`),
  // because the per-frame update needs the body's absolute km position and the
  // FAR tier needs the scalar twin — this component only consumes them.
  // ⚠ Earth OPTS OUT of the wrapper multiply: its own shader already threads
  // eclipse coverage through `sunVis`, which additionally gates city lights, the
  // ocean specular and the terminator band — richer than a flat multiply. Doing
  // both would SQUARE the shadow. Earth consumes the same shared occluder
  // uniforms instead, so it is no longer hardcoded to Luna either.
  const ownEclipse = config.ownEclipse === true;
  useMemo(() => {
    if (!midTex) return;
    // `color` is the convention; Earth calls its colour map `day`.
    const colourMap = midTex.color ?? midTex.day;
    void requestAlbedoCalibration(gl as never, config.id, colourMap);
  }, [midTex, config.id, gl]);

  // Post-load texture tweaks
  useMemo(() => {
    if (nearTex && config.onTexturesLoaded) config.onTexturesLoaded("near", nearTex);
  }, [nearTex, config]);
  useMemo(() => {
    if (midTex && config.onTexturesLoaded) config.onTexturesLoaded("mid", midTex);
  }, [midTex, config]);

  // ── Geometry ──
  // ⚠ EVERY PLANET WAS RENDERING MIRRORED UNTIL THIS FLIP. See the helper.
  const nearGeo = useMemo(() => {
    if (!config.near) return null;
    const g = new THREE.SphereGeometry(scaledRadius, config.near.segments, config.near.segments);
    flipGeometryV(g); // MUST precede computeTangents — tangents are derived from uv
    if (config.near.computeTangents) g.computeTangents();
    return g;
  }, [scaledRadius, config.near]);

  const midGeo = useMemo(() => {
    const g = new THREE.SphereGeometry(scaledRadius, config.mid.segments, config.mid.segments);
    flipGeometryV(g);
    if (config.mid.computeTangents) g.computeTangents();
    return g;
  }, [scaledRadius, config.mid]);

  // ── Materials ──
  // ── D09: ONE albedo-scale multiply wrapping EVERY body's fragment ──────────
  // 🔑 WRAPPED, NOT PASSED IN. There are 13 body modules; a `× uAlbedoScale` that
  // each one has to remember is a rule a new body can forget, and this is exactly
  // how the far tier came to be the only one off the photometric scale (see the
  // same argument in useFarLOD). A wrapper cannot be forgotten.
  //
  // ⚠ IT SCALES THE FRAGMENT'S OUTPUT RADIANCE, NOT THE SAMPLED ALBEDO, and that is
  // deliberate rather than a shortcut. The GOAL is that the body's rendered
  // disc-average equals its published geometric albedo, which is a statement about
  // the output; scaling the output achieves it whatever the body composites in.
  // For a pure-diffuse body the two are identical anyway. ⚠ For a COMPOSITED body
  // (Earth's night lights and ocean glint, Mars' rim term) the additive parts get
  // scaled too, which is not strictly right — but those terms are themselves
  // uncalibrated, and `__lum.disc()` reports the residual per body, so a body that
  // still deviates after this is a COMPOSITION problem and gets named as one rather
  // than hidden inside a texture constant.
  //
  // ⚠ Alpha is passed through untouched: it is coverage, not brightness.
  const wrapAlbedo = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (node: any) =>
      Fn(() => {
        // `.toVar()` so the body's subgraph — including any `Discard` — is emitted
        // once rather than duplicated by reading `.xyz` and `.w` separately.
        const c = vec4(node).toVar();
        // ── D34: per-pixel eclipse ──────────────────────────────────────────
        // ⚠ This multiplies the WHOLE fragment, emissive terms included. For an
        // eclipse that is harmless and arguably right: city lights are gated by
        // their own `nightMask` (sun-above-horizon), so inside a DAYTIME
        // solar-eclipse spot they are already off. A body whose emissive should
        // survive being eclipsed would need the multiply moved inside its
        // shader, as Earth does — hence `ownEclipse`.
        const lit = ownEclipse
          ? c.xyz
          : c.xyz.mul(eclipseVisibilityNode(eclipseU));
        return vec4(lit.mul(uAlbedoScale), c.w);
      })(),
    [uAlbedoScale, eclipseU, ownEclipse],
  );

  const nearMat = useMemo(() => {
    if (!config.near || !nearTex) return null;
    const m = new NodeMaterial();
    m.side = THREE.FrontSide;
    m.fragmentNode = wrapAlbedo(
      config.buildFragmentNode({ textures: nearTex, uSunRel, uSunIlluminance, uniforms, eclipseU, tier: "near" }),
    );
    if (config.buildPositionNode) {
      m.positionNode = config.buildPositionNode({ textures: nearTex, uSunRel, uSunIlluminance, uniforms, eclipseU, tier: "near" });
    }
    return m;
  }, [nearTex, uSunRel, uSunIlluminance, uniforms, config, wrapAlbedo, eclipseU]);

  const midMat = useMemo(() => {
    if (!midTex) return null;
    const m = new NodeMaterial();
    m.side = THREE.FrontSide;
    m.fragmentNode = wrapAlbedo(
      config.buildFragmentNode({ textures: midTex, uSunRel, uSunIlluminance, uniforms, eclipseU, tier: "mid" }),
    );
    if (config.buildPositionNode) {
      m.positionNode = config.buildPositionNode({ textures: midTex, uSunRel, uSunIlluminance, uniforms, eclipseU, tier: "mid" });
    }
    return m;
  }, [midTex, uSunRel, uSunIlluminance, uniforms, config, wrapAlbedo, eclipseU]);

  // ── Extra meshes (Saturn ring, etc.) ──
  const nearExtras = useMemo((): ExtraMeshDef[] => {
    if (!config.extraMeshes || !nearTex) return [];
    return config.extraMeshes({ scaledRadius, textures: nearTex, uSunRel, uSunIlluminance, uniforms, eclipseU, tier: "near" });
  }, [config, scaledRadius, nearTex, uSunRel, uSunIlluminance, uniforms, eclipseU]);

  const midExtras = useMemo((): ExtraMeshDef[] => {
    if (!config.extraMeshes || !midTex) return [];
    return config.extraMeshes({ scaledRadius, textures: midTex, uSunRel, uSunIlluminance, uniforms, eclipseU, tier: "mid" });
  }, [config, scaledRadius, midTex, uSunRel, uSunIlluminance, uniforms, eclipseU]);

  // Allow partial rendering: tiers load independently as they become ready.
  // Far billboard (always available) covers until the first textured tier loads.
  const hasNear = config.near != null;
  if (!nearMat && !midMat) return null;

  return (
    <>
      {hasNear && nearGeo && nearMat && (
        <mesh
          ref={(m) => {
            nearRef.current = m;
            if (m && nearReadyState.current === 0) {
              nearReadyState.current = 1;
              gl.compileAsync(m, camera).then(() => {
                nearReadyState.current = 2;
              }).catch(() => {});
            }
          }}
          geometry={nearGeo}
          material={nearMat}
          visible={false}
        />
      )}
      {midMat && (
        <mesh
          ref={(m) => {
            midRef.current = m;
            if (m && midReadyState.current === 0) {
              midReadyState.current = 1;
              gl.compileAsync(m, camera).then(() => {
                midReadyState.current = 2;
              }).catch(() => {});
            }
          }}
          geometry={midGeo}
          material={midMat}
          visible={false}
        />
      )}
      {nearExtras.map((ex, i) => (
        <mesh
          key={ex.key}
          ref={(m) => {
            extraNearRefs.current[i] = m;
            if (m && ex.renderLayer != null) m.layers.set(ex.renderLayer);
            ex.onMount?.(m);
          }}
          geometry={ex.geometry}
          material={ex.material}
          visible={false}
        />
      ))}
      {midExtras.map((ex, i) => (
        <mesh
          key={ex.key}
          ref={(m) => {
            extraMidRefs.current[i] = m;
            if (m && ex.renderLayer != null) m.layers.set(ex.renderLayer);
            ex.onMount?.(m);
          }}
          geometry={ex.geometry}
          material={ex.material}
          visible={false}
        />
      ))}
    </>
  );
}

/**
 * Flip a sphere's UV v-axis so it matches how our KTX2 textures are actually
 * stored. **Without this every planet renders MIRRORED**, and the reason is
 * subtle enough to be worth writing down.
 *
 * `toktx` defaults to upper-left → (s0,t0) and stamps `KTXorientation: rd`
 * (right, DOWN) — verified with `ktxinfo` on all of them. So row 0 of the data
 * is the TOP of the image (north). three's `KTX2Loader` never reads that
 * metadata (grep it — there is no `orientation` or `flipY` handling), and a
 * compressed texture cannot be flipped at upload the way `flipY` flips an
 * uncompressed one. Meanwhile `SphereGeometry` emits `uv.y = 1 - v`, i.e. 1 at
 * the north pole. So the north pole sampled t=1 = the LAST row = Antarctica:
 * every planet texture was upside down.
 *
 * ⚠ AND THAT READS AS AN EAST-WEST MIRROR, NOT AS "UPSIDE DOWN". Inverting v
 * maps latitude λ → −λ, a reflection through the equatorial plane — determinant
 * −1, so the globe becomes its own mirror image. Nothing else in the scene
 * defines which geometric pole is north (the body rotation is arbitrary), so
 * the flip cannot show up as an inverted globe. It can only show up as
 * chirality: Spain east of Turkey, Sicily on the wrong side of Italy's toe.
 * That is why it survived so long, and why `u` looks correct under analysis —
 * the mirror was never in `u`.
 *
 * Applied here rather than at the assets so it is one reversible line instead
 * of a re-encode of every texture in the repo. The alternative root-cause fix
 * is `toktx --lower_left_maps_to_s0t0` (→ orientation `ru`) in
 * scripts/convert-to-ktx2.sh plus a full re-convert; if that is ever done, this
 * flip AND the matching one in cloudCommon's `equirectDirToUv` must both go.
 *
 * NOT covered: Saturn's rings build their own BufferGeometry with a radial UV
 * convention, so they are unaffected by this and want a separate look.
 */
function flipGeometryV(g: THREE.BufferGeometry): void {
  const uvAttr = g.getAttribute("uv");
  if (!uvAttr) return;
  for (let i = 0; i < uvAttr.count; i++) {
    uvAttr.setY(i, 1 - uvAttr.getY(i));
  }
  uvAttr.needsUpdate = true;
}

// ─────────────────────────────────────────────────────────────────────
// Main CelestialBody component
// ─────────────────────────────────────────────────────────────────────

type CelestialBodyProps = {
  config: CelestialBodyConfig;
};

function CelestialBody({ config }: CelestialBodyProps) {
  const positionKm = config.positionKm;
  // ── Ephemeris (2026-08-27) ────────────────────────────────────────────────
  // ⚠ `positionKm` above is a LIVE array that `updateEphemerisPositions()`
  // rewrites in place — see the header of `sim/celestialConstants.ts`. It is
  // held as a reference on purpose; copying it would freeze the body in space.
  const simEpochMs = useAtomValue(simEpochMsAtom);
  const orientRef = useRef<THREE.Group>(null);
  // Reused every frame — `bodyOrientation` fills it rather than allocating.
  const orientState = useRef(createBodyOrientation());
  // The body's own definition, for orbit/rotation. ⚠ Looked up by id rather than
  // carried on `CelestialBodyConfig`, so `sol.json` stays the single source of
  // truth for physical data and the render config stays about rendering.
  const bodyDef = useMemo(
    () => allBodyDefs().find((b) => b.id === config.id),
    [config.id],
  );
  // ── D34: body-on-body eclipse uniforms ───────────────────────────────────
  // Owned here rather than per body config, for the same reason `uAlbedoScale`
  // is: there are 13 body modules, and a rule each has to remember is a rule the
  // 14th will forget. `eclipseU` drives the PER-PIXEL near/mid path;
  // `uEclipseVis` is the same maths evaluated once at the body's centre for the
  // far/point tiers, which are too few pixels to resolve a shadow edge.
  const eclipseU = useMemo(() => createEclipseUniforms(), []);
  const uEclipseVis = useMemo(() => uniform(1), []);

  const sunPositionKm = config.sunPositionKm ?? STAR_POSITION_KM;
  const radiusKm = config.radiusKm;

  const worldOrigin = useWorldOrigin();
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);

  const scaledRadius = useMemo(() => kmToScaledUnits(radiusKm), [radiusKm]);

  // Clear this body's atmosphere registration on unmount.
  useEffect(() => () => clearAtmosphereBody(config.id), [config.id]);

  // Clear this body's sun-occluder registration on unmount (D27).
  useEffect(() => () => clearSunOccluder(config.id), [config.id]);

  // Ring annulus for the atmosphere pass (fog clamp + shadow). The ring mesh
  // lies in the body's local XZ plane, so its normal is local +Y rotated by
  // config.rotation — static per config, computed once.
  const atmosphereRings = useMemo(() => {
    if (!config.rings) return null;
    const normal = new THREE.Vector3(0, 1, 0);
    if (config.rotation) normal.applyEuler(config.rotation);
    return {
      normal,
      innerRadiusKm: config.rings.innerRadiusKm,
      outerRadiusKm: config.rings.outerRadiusKm,
      opacity: config.rings.opacity,
    };
  }, [config]);

  // ── Standard uniforms ──
  const uSunRel = useMemo(() => uniform(new THREE.Vector3(0, 0, 1)), []);
  /**
   * Top-of-atmosphere sun illuminance at this body, game units. Written every
   * frame in useFrame from the LIVE body→star distance, so it stays correct once
   * bodies orbit and for procedurally generated systems (LIGHTING_PLAN §3.0).
   *
   * Every body gets one, atmosphere or not — the airless moons need it just as
   * much as Earth does, and routing it through the atmosphere record would leave
   * them out. Initialised from the authored distance so frame 0 is not black.
   */
  const uSunIlluminance = useMemo(() => {
    const e = sunIlluminanceAt(
      Math.hypot(
        sunPositionKm[0] - positionKm[0],
        sunPositionKm[1] - positionKm[1],
        sunPositionKm[2] - positionKm[2],
      ),
      STAR_LUMINOSITY_SUN,
    );
    return uniform(new THREE.Vector3(e, e, e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 1 − the stellar point's crossfade weight. Driven below from the SAME function
  // StellarPoint uses, so the two halves of the crossfade cannot disagree.
  const uFarFade = useMemo(() => uniform(1), []);
  const uSpR = useMemo(() => uniform(0), []);
  const uSpU = useMemo(() => uniform(0), []);
  const uSpF = useMemo(() => uniform(0), []);

  // ── Body-specific extra uniforms ──
  const extraUniforms = useMemo(
    () => config.createUniforms?.() ?? {},
    [config],
  );

  // uSunIlluminance carries illuminance × preExposure × star colour — the same
  // uniform the near and mid tiers get, so all three tiers now share ONE
  // reflectance → radiance conversion (Phase 4 / D04).
  // ⚠ PUBLISHED HERE, IN THE OUTER COMPONENT, NOT IN `TexturedLODs`. The audit's job
  // is to catch a per-body albedo that has drifted from `bodyPhotometry`, and the
  // stellar point draws at the GREATEST distances — precisely where `TexturedLODs`
  // has not mounted because no texture has streamed. Publishing from there reported
  // "no bodies mounted" with the game running and every planet on screen.
  useMemo(() => {
    if (config.stellarPoint) {
      publishStellarPointAlbedo(config.id, config.stellarPoint.geometricAlbedo);
    }
  }, [config.id, config.stellarPoint]);

  // Derived hue for the point tier, falling back to the authored triple for a body
  // with no photometry row. Both LOD tiers now read the same source, so the
  // billboard→point crossfade cannot shift colour partway through.
  const pointColour = useMemo((): readonly [number, number, number] => {
    const c = bodyReflectanceRgb(config.id);
    return c
      ? ([c.r, c.g, c.b] as const)
      : (config.stellarPoint?.color ?? ([1, 1, 1] as const));
  }, [config.id, config.stellarPoint]);

  const far = useFarLOD(
    scaledRadius,
    uSpR,
    uSpU,
    uSpF,
    uSunIlluminance,
    uFarFade,
    config.far,
    config.id,
    uEclipseVis,
  );

  // ── Refs for LOD meshes ──
  const nearRef = useMemo(() => ({ current: null as THREE.Mesh | null }), []);
  const midRef = useMemo(() => ({ current: null as THREE.Mesh | null }), []);
  const farRef = useMemo(() => ({ current: null as THREE.Mesh | null }), []);
  const extraNearRefs = useMemo(() => ({ current: [] as (THREE.Mesh | null)[] }), []);
  const extraMidRefs = useMemo(() => ({ current: [] as (THREE.Mesh | null)[] }), []);

  // ── Distance-gated texture loading ──
  const prefetchFarDist = config.lod.far * PREFETCH_MULT;
  const prefetchNearDist = (config.lod.near ?? Infinity) * PREFETCH_MULT;

  // Compute initial distance to decide what to pre-load immediately at startup
  const [loadMid, setLoadMid] = useState(() => {
    const dx = positionKm[0] - worldOrigin.shipPosKm.x;
    const dy = positionKm[1] - worldOrigin.shipPosKm.y;
    const dz = positionKm[2] - worldOrigin.shipPosKm.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) < prefetchFarDist;
  });
  const [loadNear, setLoadNear] = useState(() => {
    const dx = positionKm[0] - worldOrigin.shipPosKm.x;
    const dy = positionKm[1] - worldOrigin.shipPosKm.y;
    const dz = positionKm[2] - worldOrigin.shipPosKm.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) < prefetchNearDist;
  });

  /** 0 = not loaded, 1 = compiling, 2 = ready */
  const nearReadyState = useMemo(() => ({ current: 0 }), []);
  const midReadyState = useMemo(() => ({ current: 0 }), []);

  const hasNear = config.near != null;
  const billboardMode = config.billboardMode ?? "camera-space";

  useFrame(() => {
    // ── Sun direction relative to body ──
    _relativeKm.set(positionKm[0], positionKm[1], positionKm[2]);
    _relativeKm.sub(worldOrigin.worldOriginKm);
    toScaledUnitsKm(_relativeKm, _bodyScaled);

    _relativeKm.set(sunPositionKm[0], sunPositionKm[1], sunPositionKm[2]);
    _relativeKm.sub(worldOrigin.worldOriginKm);
    toScaledUnitsKm(_relativeKm, _sunScaled);

    _sunRelative.copy(_sunScaled).sub(_bodyScaled);
    uSunRel.value.copy(_sunRelative);

    // Body→star distance in km, recomputed every frame. This drives the body's
    // sun illuminance (1/r²), so it MUST stay live: once bodies orbit, a cached
    // value freezes their brightness. See docs/LIGHTING_PLAN.md §3.0 (D17).
    // Computed from the km positions directly rather than from _sunRelative,
    // which is in scaled units and floating-origin relative.
    const starDistKm = Math.hypot(
      sunPositionKm[0] - positionKm[0],
      sunPositionKm[1] - positionKm[1],
      sunPositionKm[2] - positionKm[2],
    );

    // Live 1/r² illuminance for this body's surface shader. Grey for now; the
    // star's colour temperature becomes a per-channel tint in Phase 3.
    const illum = sunIlluminanceAt(
      starDistKm,
      STAR_LUMINOSITY_SUN,
    );
    // D18: tinted by the star's blackbody colour (luminance-normalised, so the
    // total illuminance is still `illum`). Grey here would light an M-dwarf's
    // planets stark white — see STAR_COLOR_LINEAR.
    // × preExposure (D25): the surface shaders are LINEAR in this, so scaling it
    // here pre-exposes every lit planet pixel without touching a single shader.
    const illumPre = illum * getPreExposure();
    uSunIlluminance.value.set(
      illumPre * STAR_COLOR_LINEAR[0],
      illumPre * STAR_COLOR_LINEAR[1],
      illumPre * STAR_COLOR_LINEAR[2],
    );

    // ── Ship distance ──
    _shipToBody.set(
      positionKm[0] - worldOrigin.shipPosKm.x,
      positionKm[1] - worldOrigin.shipPosKm.y,
      positionKm[2] - worldOrigin.shipPosKm.z,
    );
    const distKm = _shipToBody.length();

    // ── Sun-occluder registration (D27) ──
    // UNCONDITIONAL — not gated on LOD tier or distance, unlike the atmosphere
    // registration below. A body's umbra is far longer than the range at which
    // the body is worth drawing: Neptune's runs 165 M km against a 12 M km LOD
    // gate. Gating this is precisely the bug. See space/sunOcclusion.ts.
    // ── Solve the ephemeris for this frame ──────────────────────────────────
    // ⚠ Called by EVERY body; `updateEphemerisPositions` caches on the Julian
    // Date so the first caller does the work. That is why there is no ordering
    // requirement between this and the bodies that read the result.
    const jd = jdFromUnixMs(simEpochMs);
    updateEphemerisPositions(jd);

    // ── Live orientation: axial tilt ∘ spin ────────────────────────────────
    // ⚠⚠ THIS SUPERSEDES `config.rotation` for any body with ephemeris rotation
    // data. The four bodies that had one (Earth, Mars, Saturn, Jupiter) were
    // hand-applying their axial TILT as a static Euler — Saturn's was literally
    // `26.7°` about Z. The magnitudes agree with sol.json's (26.73 etc.), so the
    // change is that the tilt now has a real DIRECTION (`tiltNodeDeg`) and the
    // spin is live.
    //
    // 🔑 Expect continents to sit somewhere different: the prime meridian is now
    // wherever the DATE puts it, not an arbitrary constant. That is precisely
    // what makes an eclipse land on the correct part of the planet, so it is the
    // point rather than a side effect.
    if (orientRef.current && bodyDef?.rotation) {
      const o = bodyOrientation(bodyDef, jd, orientState.current);
      // Object-space axes: +Y = north pole, +X = the prime meridian on the
      // equator, +Z = 90° WEST of it. That last one is `X × Y` — verified
      // against the sphere's own UV mapping, where `uv.x = 0.5` (Greenwich on a
      // standard equirectangular map) lands on object +X and longitude
      // increases eastward, i.e. as a positive rotation about +Y.
      _axX.set(o.meridian[0], o.meridian[1], o.meridian[2]);
      _axY.set(o.pole[0], o.pole[1], o.pole[2]);
      _axZ.crossVectors(_axX, _axY);
      _basis.makeBasis(_axX, _axY, _axZ);
      orientRef.current.quaternion.setFromRotationMatrix(_basis);
    }

    setSunOccluder(config.id, positionKm, radiusKm);

    // ── D34: which bodies are eclipsing THIS one, this frame ────────────────
    // ⚠ AFTER `setSunOccluder` above, deliberately: the registry must contain
    // this frame's positions for every body before any body reads it. Bodies
    // update in mount order, so a reader running first would see one stale
    // frame — harmless for a shadow that moves slowly, but the ordering is free
    // here and a stale eclipse would be a miserable thing to chase.
    uEclipseVis.value = updateEclipseUniforms(
      eclipseU,
      config.id,
      positionKm,
      radiusKm,
      sunPositionKm,
      STAR_RADIUS_KM,
    );

    // ── Prefetch texture loading triggers (one-shot per tier) ──
    if (distKm < prefetchFarDist) setLoadMid(true);
    if (distKm < prefetchNearDist) setLoadNear(true);

    // ── LOD selection with graceful fallback ──
    // Only switch to a tier once its textures are loaded AND shader is compiled.
    const wantNear = hasNear && distKm < config.lod.near!;
    const wantMid = hasNear ? (!wantNear && distKm < config.lod.far) : (distKm < config.lod.far);

    const nearReady = nearReadyState.current === 2;
    const midReady = midReadyState.current === 2;

    const showNear = wantNear && nearReady;
    const showMid = (wantMid && midReady) || (wantNear && !nearReady && midReady);
    const showFar = !showNear && !showMid;

    // Publish the tier the renderer ACTUALLY chose, for `__lum.lod()` (Phase 4).
    // Includes the readiness fallbacks above, which is the whole point: an inferred
    // tier would miss them.
    // Hand the billboard the complement of the point's fade (Phase 4). Uses
    // StellarPoint's own exported function and the DRAWING-BUFFER height, so both
    // halves of the crossfade are computed from one formula with one notion of pixel.
    const _fovRad = ((camera as THREE.PerspectiveCamera).fov * Math.PI) / 180;
    const _bufH = gl.getDrawingBufferSize(_farFadeBuf).y;
    const _pointFade = stellarPointFade(radiusKm, distKm, _fovRad, Math.max(_bufH, 1));
    uFarFade.value = 1 - _pointFade;

    publishLodThresholds(config.id, config.lod.near ?? 0, config.lod.far);
    publishLodState(config.id, {
      tier: showNear ? "near" : showMid ? "mid" : "far",
      pointVisible: false, // set by StellarPoint, which owns its own gate
      pointFade: 0,
      distKm,
    });

    if (nearRef.current) nearRef.current.visible = showNear;
    if (midRef.current) midRef.current.visible = showMid;
    // ⚠ HIDE the billboard once the crossfade has fully handed over. Below
    // `STELLAR_PX_SATURATE` its weight is exactly 0, so it renders black — but an
    // opaque black quad still WRITES DEPTH, coplanar with the additive stellar point
    // at the same world position. MEASURED: at a 3 px disc the point delivered 0.26 of
    // its flux while at 1 px it delivered 1.007, same tier and same `fade = 1` — the
    // signature of z-fighting rejecting a varying fraction of the point's fragments.
    // Drawing nothing is also one draw call cheaper than drawing black.
    if (farRef.current) {
      farRef.current.visible = showFar && uFarFade.value > 1e-3;
    }

    // Extra meshes track their parent tier
    for (const m of extraNearRefs.current) {
      if (m) m.visible = showNear;
    }
    for (const m of extraMidRefs.current) {
      if (m) m.visible = showMid;
    }

    // Register this body's atmosphere (if any) for the global atmosphere pass
    // while its sphere LOD is visible. Cleared when it falls back to the
    // billboard tier (the billboard carries its own rim glow) or unmounts.
    if (config.atmosphere) {
      if (showNear || showMid) {
        setAtmosphereBody(
          config.id,
          _bodyScaled,
          _sunRelative,
          distKm,
          starDistKm,
          config.atmosphere,
          atmosphereRings,
        );
      } else {
        clearAtmosphereBody(config.id);
      }
    }

    // ── Billboard sun projection ──
    if (billboardMode === "camera-space") {
      const qInv = camera.quaternion.clone().invert();

      const sdView = new THREE.Vector3(
        sunPositionKm[0] - positionKm[0],
        sunPositionKm[1] - positionKm[1],
        sunPositionKm[2] - positionKm[2],
      ).normalize().applyQuaternion(qInv);

      const bodyView = _shipToBody.clone().applyQuaternion(qInv);
      const fw = bodyView.negate().normalize();

      const ru = Math.abs(fw.y) > 0.99
        ? new THREE.Vector3(1, 0, 0)
        : new THREE.Vector3(0, 1, 0);
      const ri = new THREE.Vector3().crossVectors(ru, fw).normalize();
      const up = new THREE.Vector3().crossVectors(fw, ri);
      uSpR.value = ri.dot(sdView);
      uSpU.value = up.dot(sdView);
      uSpF.value = fw.dot(sdView);
    } else {
      // world-space mode (Luna)
      const sd = new THREE.Vector3(
        sunPositionKm[0] - positionKm[0],
        sunPositionKm[1] - positionKm[1],
        sunPositionKm[2] - positionKm[2],
      ).normalize();

      const fw = _shipToBody.clone().negate().normalize();

      const ru = Math.abs(fw.y) > 0.99
        ? new THREE.Vector3(1, 0, 0)
        : new THREE.Vector3(0, 1, 0);
      const ri = new THREE.Vector3().crossVectors(ru, fw).normalize();
      const up = new THREE.Vector3().crossVectors(fw, ri);
      uSpR.value = ri.dot(sd);
      uSpU.value = up.dot(sd);
      uSpF.value = fw.dot(sd);
    }

    // ── Body-specific per-frame updates ──
    config.onFrame?.({
      uniforms: extraUniforms,
      worldOrigin,
      camera,
      positionKm,
      sunPositionKm,
      distKm,
    });
  });

  return (
    <SimGroup space="scaled" positionKm={positionKm}>
      {/* ⚠ ALWAYS a group now, and always with the ref: the frame loop writes a
          live quaternion into it when the body has ephemeris rotation data. The
          `config.rotation` fallback only applies to bodies without any, so
          nothing regresses for a body that has not been given orbital data. */}
      {bodyDef?.rotation || config.rotation ? (
        <group ref={orientRef} rotation={bodyDef?.rotation ? undefined : config.rotation}>
          <TexturedLODs
            config={config}
            scaledRadius={scaledRadius}
            uSunRel={uSunRel}
            uSunIlluminance={uSunIlluminance}
            uniforms={extraUniforms}
            nearRef={nearRef}
            midRef={midRef}
            extraNearRefs={extraNearRefs}
            extraMidRefs={extraMidRefs}
            shouldLoadMid={loadMid}
            shouldLoadNear={loadNear}
            nearReadyState={nearReadyState}
            midReadyState={midReadyState}
            eclipseU={eclipseU}
          />
        </group>
      ) : (
        <TexturedLODs
          config={config}
          scaledRadius={scaledRadius}
          uSunRel={uSunRel}
          uSunIlluminance={uSunIlluminance}
          uniforms={extraUniforms}
          nearRef={nearRef}
          midRef={midRef}
          extraNearRefs={extraNearRefs}
          extraMidRefs={extraMidRefs}
          shouldLoadMid={loadMid}
          shouldLoadNear={loadNear}
          nearReadyState={nearReadyState}
          midReadyState={midReadyState}
          eclipseU={eclipseU}
        />
      )}
      <mesh
        ref={(m) => { farRef.current = m; }}
        geometry={far.geo}
        material={far.mat}
        visible={false}
      />
      <StellarPoint
        positionKm={positionKm}
        sunPositionKm={sunPositionKm}
        radiusKm={radiusKm}
        geometricAlbedo={config.stellarPoint.geometricAlbedo}
        // ⚠ D09: hue from the measured B−V index, not the authored triple. Same
        // reasoning as the far tier — a body's colour IS a measurement, so a
        // hand-picked value is a second uncontrolled opinion about it. StellarPoint
        // luminance-normalises what it gets, so only the hue is taken from here.
        color={pointColour}
      />
    </SimGroup>
  );
}

export default memo(CelestialBody);
