"use client";

// ---------------------------------------------------------------------------
// MiningImpact — the player's mining impact (docs/VFX_REALISM_PLAN.md §3):
//  I1 hot spots and I2 sparks (impactVfx.ts), stepped from `miningBeamView`;
//  I3 one PERMANENT point light at the hit (intensity 0 when idle; never toggled, never
//     added/removed: a light-count change recompiles every lit material, ~1 s stall);
//  I4 the vapour/plasma core: a small Gaussian billboard lifted off the surface along the
//     normal, so the rock never clips a hard edge into it (the old 14 m sprite's outline),
//     handing its flux to a light point below a few px by the §1 rule.
// ---------------------------------------------------------------------------

import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { useStore } from "jotai";
import * as THREE from "three";
import { NodeMaterial } from "three/webgpu";
import { exp, Fn, length, uniform, uv, vec3, vec4 } from "three/tsl";
import { miningBeamView, pulseCycleBuffer } from "@/store/mining";
import { systemConfigAtom } from "@/store/system";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { isSimPaused } from "@/sim/simPause";
import { getPreExposure, HALF_FLOAT_WRITE_MAX, nitsToGameUnits } from "@/components/space/photometry";
import { PX_MESH, PX_POINT, pushLightPoint, uTanPerPx } from "@/components/space/lightPoints";
import {
  drawSparks, drawSpotPoints, fedSpotCandela, stepHotSpots, stepSparks, uploadHotSpots, type BeamImpact,
} from "./impactVfx";

/** Plasma core intensity at stock power, cd (design: a compact bright vapour core, DLR basalt). */
const PLASMA_CD = 2.5e4;
/** Plasma Gaussian σ at stock power, m. */
const PLASMA_SIGMA_M = 0.12;
/** Laser-ablation plasma on silicate: near-white continuum, a little blue (design hue). */
const PLASMA_HUE: [number, number, number] = [0.86, 0.93, 1.0];
const PLASMA_LUM = 0.2126 * PLASMA_HUE[0] + 0.7152 * PLASMA_HUE[1] + 0.0722 * PLASMA_HUE[2];
/** Sprite edge in σ: holds 99.97 % of a 2-D Gaussian. */
const SPRITE_SIGMAS = 4;

const _impact: BeamImpact = { on: false, fieldId: "", rock: "", x: 0, y: 0, z: 0, power: 1 };

export default function ImpactVFX() {
  const store = useStore();
  const worldOrigin = useWorldOrigin();
  const camera = useThree((s) => s.camera);
  const light = useRef<THREE.PointLight>(null!);
  const sprite = useRef<THREE.Mesh>(null!);
  const uL0 = useMemo(() => uniform(0), []);

  const material = useMemo(() => {
    const m = new NodeMaterial();
    m.depthWrite = false;
    m.transparent = false;
    m.side = THREE.DoubleSide;
    m.blending = THREE.CustomBlending;
    m.blendEquation = THREE.AddEquation;
    m.blendSrc = THREE.OneFactor;
    m.blendDst = THREE.OneFactor;
    m.blendEquationAlpha = THREE.AddEquation;
    m.blendSrcAlpha = THREE.ZeroFactor;
    m.blendDstAlpha = THREE.OneFactor;
    m.fragmentNode = Fn(() => {
      // uv ∈ [0,1] spans ±SPRITE_SIGMAS σ.
      const r = length(uv().sub(0.5)).mul(2 * SPRITE_SIGMAS);
      const g = exp(r.mul(r).mul(-0.5));
      return vec4(vec3(...PLASMA_HUE).mul(uL0.mul(g)).min(HALF_FLOAT_WRITE_MAX), 1);
    })();
    return m;
  }, [uL0]);

  // Anchors resolved once per frame (refreshed below), not one find() per spot and spark.
  const anchors = useMemo(() => new Map<string, readonly number[]>(), []);
  const toScene = useMemo(() => {
    const out = (fieldId: string, x: number, y: number, z: number, o: number[]): boolean => {
      const a = anchors.get(fieldId);
      if (!a) return false;
      const wo = worldOrigin.worldOriginKm;
      o[0] = (a[0] - wo.x) * 1000 + x;
      o[1] = (a[1] - wo.y) * 1000 + y;
      o[2] = (a[2] - wo.z) * 1000 + z;
      return true;
    };
    return out;
  }, [anchors, worldOrigin]);

  const _pos = useMemo(() => [0, 0, 0], []);
  const _v = useMemo(() => new THREE.Vector3(), []);

  useFrame((_, delta) => {
    const dt = isSimPaused() ? 0 : Math.min(delta, 0.1);
    anchors.clear();
    for (const f of store.get(systemConfigAtom).asteroidFields ?? []) anchors.set(f.id, f.anchorKm);
    const v = miningBeamView;
    const on = v.on && v.hit.value && v.rock.instanceId >= 0 && pulseCycleBuffer.beamOn;
    _impact.on = on;
    _impact.fieldId = v.rock.fieldId;
    _impact.rock = `${v.rock.chunkKey}:${v.rock.instanceId}`;
    _impact.x = v.pointField[0]; _impact.y = v.pointField[1]; _impact.z = v.pointField[2];
    _impact.power = v.power;
    stepHotSpots(_impact, dt);
    stepSparks(_impact, v.normal[0], v.normal[1], v.normal[2], dt);
    const pre = getPreExposure();
    uploadHotSpots(toScene, pre);
    drawSpotPoints(toScene);
    drawSparks(toScene);

    const L = light.current, S = sprite.current;
    if (!L || !S) return;
    const power = Math.max(0.2, v.power);
    if (!on || !toScene(_impact.fieldId, _impact.x, _impact.y, _impact.z, _pos)) {
      L.intensity = 0;
      // Never hidden: staying drawn (dark) keeps its pipeline compiled (no first-hit stall).
      uL0.value = 0;
      return;
    }
    const n = v.normal;
    const sigma = PLASMA_SIGMA_M * Math.sqrt(power);
    const plasmaCd = PLASMA_CD * power;
    // I3: the melt spot and the plasma light the rock round the hit and the ship's nose.
    L.position.set(_pos[0] + n[0] * 0.4, _pos[1] + n[1] * 0.4, _pos[2] + n[2] * 0.4);
    L.intensity = nitsToGameUnits(fedSpotCandela() + plasmaCd) * pre;

    // I4: plasma core centre one σ off the surface; Gaussian, so the rock's cut is soft.
    const cx = _pos[0] + n[0] * sigma * 1.2, cy = _pos[1] + n[1] * sigma * 1.2, cz = _pos[2] + n[2] * sigma * 1.2;
    const d = camera.position.distanceTo(_v.set(cx, cy, cz));
    const px = (4 * sigma) / Math.max(1e-3, d * uTanPerPx.value);
    const share = Math.min(1, Math.max(0, (PX_MESH - px) / (PX_MESH - PX_POINT)));
    // Flux I = L0·2πσ² for a Gaussian of peak L0: L0 = I/(2πσ²), game units.
    uL0.value = (nitsToGameUnits(plasmaCd) / PLASMA_LUM / (2 * Math.PI * sigma * sigma)) * (1 - share) * pre;
    S.position.set(cx, cy, cz);
    S.quaternion.copy(camera.quaternion);
    S.scale.setScalar(2 * SPRITE_SIGMAS * sigma);
    const g = nitsToGameUnits(plasmaCd) / PLASMA_LUM;
    pushLightPoint(cx, cy, cz, PLASMA_HUE[0] * g, PLASMA_HUE[1] * g, PLASMA_HUE[2] * g, 4 * sigma);
  }, 0.5);

  return (
    <>
      <pointLight ref={light} intensity={0} decay={2} distance={0} />
      <mesh ref={sprite} material={material} frustumCulled={false} renderOrder={12} scale={0.001}>
        <planeGeometry args={[1, 1]} />
      </mesh>
    </>
  );
}
