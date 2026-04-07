"use client";

import { memo, useMemo } from "react";
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
  nearCompiled: { current: boolean };
  extraNearRefs: React.MutableRefObject<(THREE.Mesh | null)[]>;
  extraMidRefs: React.MutableRefObject<(THREE.Mesh | null)[]>;
};

function TexturedLODs({
  config,
  scaledRadius,
  uSunRel,
  uniforms,
  nearRef,
  midRef,
  nearCompiled,
  extraNearRefs,
  extraMidRefs,
}: TexturedLODsProps) {
  const { camera, gl } = useThree((s) => ({ camera: s.camera, gl: s.gl }));

  const nearTex = useDeferredKTX2(config.near?.textures ?? {}, "/basis/");
  const midTex = useDeferredKTX2(config.mid.textures, "/basis/");

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

  // For 3-tier LOD: both near + mid must be ready. For 2-tier: only mid.
  const hasNear = config.near != null;
  if (hasNear && (!nearMat || !midMat)) return null;
  if (!hasNear && !midMat) return null;

  return (
    <>
      {hasNear && nearGeo && nearMat && (
        <mesh
          ref={(m) => {
            nearRef.current = m;
            if (m && !nearCompiled.current) {
              nearCompiled.current = true;
              gl.compileAsync(m, camera).catch(() => {});
            }
          }}
          geometry={nearGeo}
          material={nearMat}
          visible={false}
        />
      )}
      <mesh
        ref={(m) => { midRef.current = m; }}
        geometry={midGeo}
        material={midMat!}
        visible={false}
      />
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
  const nearCompiled = useMemo(() => ({ current: false }), []);
  const extraNearRefs = useMemo(() => ({ current: [] as (THREE.Mesh | null)[] }), []);
  const extraMidRefs = useMemo(() => ({ current: [] as (THREE.Mesh | null)[] }), []);

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

    // ── LOD selection ──
    const showNear = hasNear && distKm < config.lod.near!;
    const showMid = hasNear ? (!showNear && distKm < config.lod.far) : (distKm < config.lod.far);
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
            nearCompiled={nearCompiled}
            extraNearRefs={extraNearRefs}
            extraMidRefs={extraMidRefs}
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
          nearCompiled={nearCompiled}
          extraNearRefs={extraNearRefs}
          extraMidRefs={extraMidRefs}
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
