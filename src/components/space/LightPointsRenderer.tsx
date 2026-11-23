"use client";

// ---------------------------------------------------------------------------
// LightPoints — draws `lightPointBuffer` (docs/VFX_REALISM_PLAN.md §1, L1) in the local
// scene: one instanced draw, Gaussian PSF sprites (StarField's σ and normalisation,
// gate 0.999×), additive, depth-tested so hulls hide the lamps behind them.
//
// Integrated sprite radiance = E = I·|cos θ|/d² × the point's crossfade weight (L2);
// the lamp mesh carries the rest (`lampMeshWeight`), so the sum is flux-constant.
// ---------------------------------------------------------------------------

import { useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { NodeMaterial } from "three/webgpu";
import {
  abs, attribute, cameraFar, cameraNear, cameraPosition, cameraProjectionMatrix, cameraViewMatrix, dot, exp,
  float, Fn, length, mix, positionGeometry, step, uniform, uv, varying, vec3, vec4, viewZToLogarithmicDepth,
} from "three/tsl";
import { STAR_PSF_SIGMA_PX, psfNormForBuffer } from "@/components/Stars/StarField";
import { getPreExposure, HALF_FLOAT_WRITE_MAX } from "./photometry";
import { LIGHT_POINT_CAPACITY, lightPointBuffer, pointShare, uForcePointShare, uLampGain, uTanPerPx } from "./lightPoints";

/** Sprite edge in px; holds 4.7σ of the Gaussian (same as StarField / StellarPoint). */
const QUAD_PX = 8;
/**
 * Pull toward the camera so the lamp's own mesh can't hide its point: flat lenses carry their
 * empty ON the lens face (build.py), so only this; isotropic lamps sit at their centre, so also
 * half their size. More than that and a point shows through plating its lamp is buried behind.
 */
const PULL_M = 0.05;
/**
 * Edge faces of a lens box relative to its face, seen side-on: thickness·(w+h)/2 / (w·h)
 * = 0.155 for the station lens (0.73 × 0.58 × 0.10 m). Without it the points carried
 * 0.76–0.92 of the mesh's flux at the crossfade (MEASURED, vfx-lights.mjs xfade).
 */
const LENS_RIM = 0.15;
/** After every producer (≤ 0) and before SpaceRenderer (1). */
export const FRAME_PRIORITY_LIGHT_POINTS = 0.9;

const _buf = new THREE.Vector2();
/** Dev: points only / meshes only, to measure each side of the crossfade. */
let _pointsOn = true;

if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
  (window as unknown as { __lights: unknown }).__lights = {
    /** All lamps on/off (points and lamp meshes). */
    enable(on = true) { uLampGain.value = on ? 1 : 0; },
    /** Points alone on/off. */
    points(on = true) { _pointsOn = on; },
    /** Force the point share of the crossfade (0 mesh only … 1 points only); no arg = by size. */
    force(share = -1) { uForcePointShare.value = share; },
    stats: () => ({ drawn: lightPointBuffer.drawn, tanPerPx: uTanPerPx.value }),
  };
}

export default function LightPoints() {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);

  const { geometry, attrs } = useMemo(() => {
    const g = new THREE.PlaneGeometry(1, 1);
    const B = lightPointBuffer;
    const make = (a: Float32Array, n: number) => {
      const at = new THREE.InstancedBufferAttribute(a, n);
      at.setUsage(THREE.DynamicDrawUsage);
      return at;
    };
    const attrs = { aPos: make(B.pos, 3), aDir: make(B.dir, 3), aRgb: make(B.rgb, 3), aSize: make(B.size, 1) };
    for (const [k, v] of Object.entries(attrs)) g.setAttribute(k, v);
    return { geometry: g, attrs };
  }, []);

  const uNorm = useMemo(() => uniform(0), []);

  const material = useMemo(() => {
    const m = new NodeMaterial();
    m.side = THREE.DoubleSide;
    m.depthWrite = false;
    m.transparent = false;
    // True One/One on colour (AdditiveBlending would multiply by alpha and halve the flux);
    // alpha untouched (EngineExhaust's additiveKeepAlpha: the canvas is premultiplied).
    m.blending = THREE.CustomBlending;
    m.blendEquation = THREE.AddEquation;
    m.blendSrc = THREE.OneFactor;
    m.blendDst = THREE.OneFactor;
    m.blendEquationAlpha = THREE.AddEquation;
    m.blendSrcAlpha = THREE.ZeroFactor;
    m.blendDstAlpha = THREE.OneFactor;

    const aPos = vec3(attribute("aPos", "vec3"));
    const aDir = vec3(attribute("aDir", "vec3"));
    const aRgb = vec3(attribute("aRgb", "vec3"));
    const aSize = float(attribute("aSize", "float"));
    // Instanced attributes are vertex-only in WebGPU: the fragment gets varyings.
    const vRgb = varying(vec3(0), "v_lpRgb");
    const vViewZ = varying(float(-1), "v_lpViewZ");

    m.vertexNode = Fn(() => {
      const viewC = cameraViewMatrix.mul(vec4(aPos, 1));
      const d = length(viewC.xyz).max(1e-3);
      const px = aSize.div(d.mul(uTanPerPx));
      const w = pointShare(px);
      // Flat lenses show |cos θ| of their face plus their edges (RIM); dir = 0 marks an
      // isotropic lamp.
      const toPoint = aPos.sub(cameraPosition).normalize();
      const c = abs(dot(aDir, toPoint));
      const flat = c.add(float(1).sub(c.mul(c)).max(0).sqrt().mul(LENS_RIM));
      const cosF = mix(float(1), flat, step(0.5, length(aDir)));
      vRgb.assign(aRgb.mul(cosF.mul(w).mul(uNorm).div(d.mul(d))).min(HALF_FLOAT_WRITE_MAX));
      const pull = aSize.mul(0.5).mul(float(1).sub(step(0.5, length(aDir)))).add(PULL_M).min(d.mul(0.5));
      const vc = viewC.xyz.mul(d.sub(pull).div(d));
      // Quad of QUAD_PX at its view depth; collapsed when the point carries nothing.
      const half = vc.z.negate().max(1e-3).mul(uTanPerPx).mul(QUAD_PX * 0.5).mul(step(1e-6, w));
      const clip = cameraProjectionMatrix.mul(
        vec4(vc.x.add(positionGeometry.x.mul(half.mul(2))), vc.y.add(positionGeometry.y.mul(half.mul(2))), vc.z, 1),
      );
      vViewZ.assign(vc.z);
      return clip;
    })();
    // ⚠ Log depth by hand (the custom vertexNode bypasses three's), with THREE'S WebGPU formula
    // log2(−z/near)/log2(far/near). StellarPoint's WebGL-style log2(w+1)·… does not match it:
    // MEASURED here as far-side lamps shining through the hull (points ≈ 2× the mesh flux).
    m.depthNode = viewZToLogarithmicDepth(vViewZ, cameraNear, cameraFar);

    m.fragmentNode = Fn(() => {
      const p = uv().mul(2).sub(1);
      const r = length(p).mul(QUAD_PX * 0.5);
      const g = exp(r.mul(r).div(-2 * STAR_PSF_SIGMA_PX * STAR_PSF_SIGMA_PX));
      return vec4(vRgb.mul(g), 1);
    })();
    return m;
  }, [uNorm]);

  const meshRef = useMemo(() => ({ current: null as THREE.InstancedMesh | null }), []);

  useFrame(() => {
    const B = lightPointBuffer;
    const cam = camera as THREE.PerspectiveCamera;
    const fovRad = cam.fov * (Math.PI / 180);
    const h = Math.max(gl.getDrawingBufferSize(_buf).y, 1);
    uTanPerPx.value = (2 * Math.tan(fovRad / 2)) / h;
    // E·(1/(2πσ²Ω_px)) is the Gaussian's peak; × pre-exposure (D25).
    uNorm.value = _pointsOn ? psfNormForBuffer(fovRad, h) * getPreExposure() * uLampGain.value : 0;
    const n = B.count;
    for (const a of Object.values(attrs)) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * a.itemSize);
      a.needsUpdate = n > 0;
    }
    const mesh = meshRef.current;
    if (mesh) {
      mesh.count = n;
      mesh.visible = n > 0;
    }
    B.drawn = n;
    B.count = 0;
    B.dropped = 0;
  }, FRAME_PRIORITY_LIGHT_POINTS);

  return (
    <instancedMesh
      ref={(m) => { meshRef.current = m; }}
      args={[geometry, material, LIGHT_POINT_CAPACITY]}
      frustumCulled={false}
      // After opaque geometry: an additive sprite drawn first would be overwritten.
      renderOrder={10}
    />
  );
}
