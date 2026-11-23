"use client";

// ---------------------------------------------------------------------------
// BeamRenderer — draws `beamBuffer` (docs/VFX_REALISM_PLAN.md §2, B2): every mining beam
// in one instanced draw. Each beam is a camera-facing ribbon from start to end; across it
// a Gaussian core (σ_c) and sheath (σ_s) of real width. A σ under ~0.7 px is drawn at
// 0.7 px with radiance × σ/σ_drawn, so the flux per metre of beam is the same at any
// distance. An optically thin glowing cylinder seen at angle θ to its axis has radiance
// ∝ 1/sin θ (longer path through it), capped at 4×.
// ---------------------------------------------------------------------------

import { useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { NodeMaterial } from "three/webgpu";
import {
  attribute, cameraNear, cameraFar, cameraPosition, cameraProjectionMatrix, cameraViewMatrix, cross, exp, float, Fn,
  length, max, min, positionGeometry, pow, select, sin, uniform, varying, vec3, vec4, viewZToLogarithmicDepth,
} from "three/tsl";
import { emitterColor } from "@/components/space/emissivePhotometry";
import { getPreExposure, HALF_FLOAT_WRITE_MAX } from "@/components/space/photometry";
import { uTanPerPx } from "@/components/space/lightPoints";
import { FRAME_PRIORITY_LIGHT_POINTS } from "@/components/space/LightPointsRenderer";
import { BEAM_CAPACITY, BEAM_CORE_SIGMA_M, BEAM_SHEATH_SIGMA_M, beamBuffer } from "./beams";

const SEGMENTS = 24;
/** Smallest drawn σ, px: a Gaussian this wide is still sampled (cf. StarField σ 0.85). */
const MIN_SIGMA_PX = 0.7;
/** 1/sin θ path gain cap (θ ≈ 19.5°): the chase camera looks almost along the beam, and a
 *  7 km beam seen that way read as a saturated white bar at 4× (co-op capture). */
const PATH_GAIN_MAX = 3;

function stripGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= SEGMENTS; i++) {
    const s = i / SEGMENTS;
    pos.push(-1, s, 0, 1, s, 0);
    if (i < SEGMENTS) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

export default function BeamRenderer() {
  const clockT = useMemo(() => uniform(0), []);
  const uPre = useMemo(() => uniform(1), []);
  const { geometry, segBuf, paramAttr } = useMemo(() => {
    const g = stripGeometry();
    const segBuf = new THREE.InstancedInterleavedBuffer(beamBuffer.seg, 6, 1);
    segBuf.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("aStart", new THREE.InterleavedBufferAttribute(segBuf, 3, 0));
    g.setAttribute("aEnd", new THREE.InterleavedBufferAttribute(segBuf, 3, 3));
    const paramAttr = new THREE.InstancedBufferAttribute(beamBuffer.params, 4);
    paramAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("aParams", paramAttr);
    return { geometry: g, segBuf, paramAttr };
  }, []);

  const material = useMemo(() => {
    const m = new NodeMaterial();
    m.side = THREE.DoubleSide;
    m.depthWrite = false;
    m.transparent = false;
    m.blending = THREE.CustomBlending;
    m.blendEquation = THREE.AddEquation;
    m.blendSrc = THREE.OneFactor;
    m.blendDst = THREE.OneFactor;
    m.blendEquationAlpha = THREE.AddEquation;
    m.blendSrcAlpha = THREE.ZeroFactor;
    m.blendDstAlpha = THREE.OneFactor;

    const aStart = vec3(attribute("aStart", "vec3"));
    const aEnd = vec3(attribute("aEnd", "vec3"));
    const aParams = vec4(attribute("aParams", "vec4"));
    const vX = varying(float(0), "v_bmX");
    const vSc = varying(float(1), "v_bmSc");
    const vSs = varying(float(1), "v_bmSs");
    const vGc = varying(float(0), "v_bmGc");
    const vGs = varying(float(0), "v_bmGs");
    const vAlong = varying(float(0), "v_bmAlong");
    const vInt = varying(float(0), "v_bmInt");
    const vSeed = varying(float(0), "v_bmSeed");
    const vViewZ = varying(float(-1), "v_bmViewZ");

    m.vertexNode = Fn(() => {
      const ab = aEnd.sub(aStart);
      const len = length(ab).max(1e-4);
      const dir = ab.div(len);
      const s = positionGeometry.y;
      const P = aStart.add(dir.mul(len.mul(s)));
      const V = P.sub(cameraPosition);
      const d = length(V).max(1e-3);
      const sideRaw = cross(dir, V);
      const sideLen = length(sideRaw);
      // Looking straight down the beam: any perpendicular will do (the ribbon is edge-on).
      const side = select(sideLen.greaterThan(d.mul(1e-6)), sideRaw.div(sideLen.max(1e-12)), cross(dir, vec3(0, 1, 0.37)).normalize());
      const sinT = sideLen.div(d);
      const pxM = d.mul(uTanPerPx);
      const power = aParams.y.max(1e-3);
      const widen = pow(power, 0.25);
      const sc = float(BEAM_CORE_SIGMA_M).mul(widen);
      const ss = float(BEAM_SHEATH_SIGMA_M).mul(widen);
      const scD = max(sc, pxM.mul(MIN_SIGMA_PX));
      const ssD = max(ss, pxM.mul(MIN_SIGMA_PX));
      const H = ssD.mul(3);
      vX.assign(positionGeometry.x.mul(H));
      vSc.assign(scD);
      vSs.assign(ssD);
      vGc.assign(sc.div(scD));
      vGs.assign(ss.div(ssD));
      vAlong.assign(len.mul(s));
      const pathGain = min(float(1).div(sinT.max(1 / PATH_GAIN_MAX)), PATH_GAIN_MAX);
      vInt.assign(aParams.x.mul(power).mul(pathGain));
      vSeed.assign(aParams.z);
      const W = P.add(side.mul(positionGeometry.x.mul(H)));
      const view = cameraViewMatrix.mul(vec4(W, 1));
      vViewZ.assign(view.z);
      return cameraProjectionMatrix.mul(view);
    })();
    m.depthNode = viewZToLogarithmicDepth(vViewZ, cameraNear, cameraFar);

    const cCore = emitterColor("mining_beam_core");
    const cSheath = emitterColor("mining_beam_halo");
    m.fragmentNode = Fn(() => {
      const x2 = vX.mul(vX);
      const core = exp(x2.div(vSc.mul(vSc).mul(-2))).mul(vGc);
      const sheath = exp(x2.div(vSs.mul(vSs).mul(-2))).mul(vGs);
      // Low shimmer streaming toward the rock (+s), two incommensurate waves.
      const shimmer = float(1).add(
        sin(vAlong.mul(0.9).sub(clockT.mul(40)).add(vSeed)).mul(sin(vAlong.mul(0.37).sub(clockT.mul(23)))).mul(0.08),
      );
      const rgb = vec3(cCore.r, cCore.g, cCore.b).mul(core).add(vec3(cSheath.r, cSheath.g, cSheath.b).mul(sheath))
        .mul(vInt.mul(shimmer).mul(uPre));
      return vec4(rgb.min(HALF_FLOAT_WRITE_MAX), 1);
    })();
    return m;
  }, [clockT, uPre]);

  const meshRef = useMemo(() => ({ current: null as THREE.InstancedMesh | null }), []);

  useFrame(({ clock }) => {
    const B = beamBuffer;
    clockT.value = clock.elapsedTime % 1000;
    uPre.value = getPreExposure();
    // Never an empty draw: one zero-intensity beam keeps the pipeline compiled, so the first
    // real beam can't stall on a shader build (the exhaust's first-burn flash, VFX plan §5).
    if (B.count === 0) {
      B.seg.fill(0, 0, 6);
      B.params.fill(0, 0, 4);
    }
    const n = Math.max(B.count, 1);
    segBuf.clearUpdateRanges();
    segBuf.addUpdateRange(0, n * 6);
    segBuf.needsUpdate = true;
    paramAttr.clearUpdateRanges();
    paramAttr.addUpdateRange(0, n * 4);
    paramAttr.needsUpdate = true;
    const mesh = meshRef.current;
    if (mesh) mesh.count = n;
    B.drawn = B.count;
    B.count = 0;
  }, FRAME_PRIORITY_LIGHT_POINTS);

  return (
    <instancedMesh
      ref={(m) => { meshRef.current = m; }}
      args={[geometry, material, BEAM_CAPACITY]}
      frustumCulled={false}
      renderOrder={11}
    />
  );
}
