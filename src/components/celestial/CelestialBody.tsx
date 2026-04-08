"use client";

import { memo, useMemo, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { useDeferredKTX2 } from "@/hooks/useDeferredKTX2";
import * as THREE from "three";
import { NodeMaterial } from "three/webgpu";
import { uniform } from "three/tsl";
import SimGroup from "../space/SimGroup";
import StellarPoint from "../space/StellarPoint";
import { kmToScaledUnits, toScaledUnitsKm } from "@/sim/units";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { STAR_POSITION_KM } from "@/sim/celestialConstants";
import { useFarLOD } from "./useFarLOD";
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
  const nearGeo = useMemo(() => {
    if (!config.near) return null;
    const g = new THREE.SphereGeometry(scaledRadius, config.near.segments, config.near.segments);
    if (config.near.computeTangents) g.computeTangents();
    return g;
  }, [scaledRadius, config.near]);

  const midGeo = useMemo(() => {
    const g = new THREE.SphereGeometry(scaledRadius, config.mid.segments, config.mid.segments);
    if (config.mid.computeTangents) g.computeTangents();
    return g;
  }, [scaledRadius, config.mid]);

  // ── Materials ──
  const nearMat = useMemo(() => {
    if (!config.near || !nearTex) return null;
    const m = new NodeMaterial();
    m.side = THREE.FrontSide;
    m.fragmentNode = config.buildFragmentNode({ textures: nearTex, uSunRel, uniforms, tier: "near" });
    if (config.buildPositionNode) {
      m.positionNode = config.buildPositionNode({ textures: nearTex, uSunRel, uniforms, tier: "near" });
    }
    return m;
  }, [nearTex, uSunRel, uniforms, config]);

  const midMat = useMemo(() => {
    if (!midTex) return null;
    const m = new NodeMaterial();
    m.side = THREE.FrontSide;
    m.fragmentNode = config.buildFragmentNode({ textures: midTex, uSunRel, uniforms, tier: "mid" });
    if (config.buildPositionNode) {
      m.positionNode = config.buildPositionNode({ textures: midTex, uSunRel, uniforms, tier: "mid" });
    }
    return m;
  }, [midTex, uSunRel, uniforms, config]);

  // ── Extra meshes (Saturn ring, etc.) ──
  const nearExtras = useMemo((): ExtraMeshDef[] => {
    if (!config.extraMeshes || !nearTex) return [];
    return config.extraMeshes({ scaledRadius, textures: nearTex, uSunRel, uniforms, tier: "near" });
  }, [config, scaledRadius, nearTex, uSunRel, uniforms]);

  const midExtras = useMemo((): ExtraMeshDef[] => {
    if (!config.extraMeshes || !midTex) return [];
    return config.extraMeshes({ scaledRadius, textures: midTex, uSunRel, uniforms, tier: "mid" });
  }, [config, scaledRadius, midTex, uSunRel, uniforms]);

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
          ref={(m) => { extraNearRefs.current[i] = m; }}
          geometry={ex.geometry}
          material={ex.material}
          visible={false}
        />
      ))}
      {midExtras.map((ex, i) => (
        <mesh
          key={ex.key}
          ref={(m) => { extraMidRefs.current[i] = m; }}
          geometry={ex.geometry}
          material={ex.material}
          visible={false}
        />
      ))}
    </>
  );
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

  // ── Standard uniforms ──
  const uSunRel = useMemo(() => uniform(new THREE.Vector3(0, 0, 1)), []);
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

    // ── Ship distance ──
    _shipToBody.set(
      positionKm[0] - worldOrigin.shipPosKm.x,
      positionKm[1] - worldOrigin.shipPosKm.y,
      positionKm[2] - worldOrigin.shipPosKm.z,
    );
    const distKm = _shipToBody.length();

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
