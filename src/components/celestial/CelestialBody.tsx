"use client";

import { memo, useEffect, useMemo, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { useDeferredKTX2 } from "@/hooks/useDeferredKTX2";
import * as THREE from "three";
import { NodeMaterial } from "three/webgpu";
import { uniform } from "three/tsl";
import SimGroup from "../space/SimGroup";
import StellarPoint from "../space/StellarPoint";
import { kmToScaledUnits, toScaledUnitsKm } from "@/sim/units";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { STAR_LUMINOSITY_SUN, STAR_POSITION_KM } from "@/sim/celestialConstants";
import { STAR_COLOR_LINEAR, sunIlluminanceAt } from "../space/photometry";
import { useFarLOD } from "./useFarLOD";
import {
  setAtmosphereBody,
  clearAtmosphereBody,
} from "../space/atmospherePass";
import { setSunOccluder, clearSunOccluder } from "@/components/space/sunOcclusion";
import type { CelestialBodyConfig, ExtraMeshDef } from "./types";

// ── Shared scratch vectors (safe: useFrame is sequential) ──
const _sunScaled = new THREE.Vector3();
const _bodyScaled = new THREE.Vector3();
const _sunRelative = new THREE.Vector3();
const _relativeKm = new THREE.Vector3();
const _shipToBody = new THREE.Vector3();

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
  const nearMat = useMemo(() => {
    if (!config.near || !nearTex) return null;
    const m = new NodeMaterial();
    m.side = THREE.FrontSide;
    m.fragmentNode = config.buildFragmentNode({ textures: nearTex, uSunRel, uSunIlluminance, uniforms, tier: "near" });
    if (config.buildPositionNode) {
      m.positionNode = config.buildPositionNode({ textures: nearTex, uSunRel, uSunIlluminance, uniforms, tier: "near" });
    }
    return m;
  }, [nearTex, uSunRel, uSunIlluminance, uniforms, config]);

  const midMat = useMemo(() => {
    if (!midTex) return null;
    const m = new NodeMaterial();
    m.side = THREE.FrontSide;
    m.fragmentNode = config.buildFragmentNode({ textures: midTex, uSunRel, uSunIlluminance, uniforms, tier: "mid" });
    if (config.buildPositionNode) {
      m.positionNode = config.buildPositionNode({ textures: midTex, uSunRel, uSunIlluminance, uniforms, tier: "mid" });
    }
    return m;
  }, [midTex, uSunRel, uSunIlluminance, uniforms, config]);

  // ── Extra meshes (Saturn ring, etc.) ──
  const nearExtras = useMemo((): ExtraMeshDef[] => {
    if (!config.extraMeshes || !nearTex) return [];
    return config.extraMeshes({ scaledRadius, textures: nearTex, uSunRel, uSunIlluminance, uniforms, tier: "near" });
  }, [config, scaledRadius, nearTex, uSunRel, uSunIlluminance, uniforms]);

  const midExtras = useMemo((): ExtraMeshDef[] => {
    if (!config.extraMeshes || !midTex) return [];
    return config.extraMeshes({ scaledRadius, textures: midTex, uSunRel, uSunIlluminance, uniforms, tier: "mid" });
  }, [config, scaledRadius, midTex, uSunRel, uSunIlluminance, uniforms]);

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
  const sunPositionKm = config.sunPositionKm ?? STAR_POSITION_KM;
  const radiusKm = config.radiusKm;

  const worldOrigin = useWorldOrigin();
  const camera = useThree((s) => s.camera);

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
  const uSpR = useMemo(() => uniform(0), []);
  const uSpU = useMemo(() => uniform(0), []);
  const uSpF = useMemo(() => uniform(0), []);

  // ── Body-specific extra uniforms ──
  const extraUniforms = useMemo(
    () => config.createUniforms?.() ?? {},
    [config],
  );

  const far = useFarLOD(scaledRadius, uSpR, uSpU, uSpF, config.far);

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
    uSunIlluminance.value.set(
      illum * STAR_COLOR_LINEAR[0],
      illum * STAR_COLOR_LINEAR[1],
      illum * STAR_COLOR_LINEAR[2],
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
    setSunOccluder(config.id, positionKm, radiusKm);

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

    if (nearRef.current) nearRef.current.visible = showNear;
    if (midRef.current) midRef.current.visible = showMid;
    if (farRef.current) farRef.current.visible = showFar;

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
      {config.rotation ? (
        <group rotation={config.rotation}>
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
        color={config.stellarPoint.color}
      />
    </SimGroup>
  );
}

export default memo(CelestialBody);
