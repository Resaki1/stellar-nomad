"use client";

import { memo, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { useAtomValue } from "jotai";
import { NodeMaterial } from "three/webgpu";
import {
  Fn,
  uv,
  vec3,
  vec4,
  float,
  max,
  step,
  Discard,
  attribute,
  uniform,
  positionGeometry,
  modelWorldMatrix,
  cameraViewMatrix,
  cameraProjectionMatrix,
  sin,
  fwidth,
} from "three/tsl";

import { pingWorldBuffer } from "@/store/mining";
import { computedModifiersAtom, getFlag } from "@/store/modules";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_INSTANCES = 128;
const STRIDE = 5; // vec3 center + float scale + float opacity

const BRACKET_COLOR = [160 / 255, 215 / 255, 245 / 255] as const;
const BASE_OPACITY = 0.4;
const PULSE_AMPLITUDE = 0.08;
const PULSE_PERIOD_S = 2.8;

const FADE_SPEED = 5.0; // opacity units per second (full fade in ~200ms)

// Bracket scale = radius * this multiplier (world-space diameter of the quad)
const BRACKET_SCALE_MULT = 2.7; // ~1.35x radius on each side
// Minimum world-space scale so tiny/far asteroids still get visible brackets
const MIN_SCALE = 4.0; // meters

// Procedural bracket shape parameters
const ARM_LENGTH = 0.35; // fraction of bracket covered by the L-arms (UV space)
const LINE_WIDTH_PX = 1.5; // constant screen-space line width in pixels

// ---------------------------------------------------------------------------
// Fade state tracking (per instanceId)
// ---------------------------------------------------------------------------

type FadeEntry = {
  opacity: number;
  fadeDir: 1 | -1;
  // Cached world position + scale for fade-out (stale but brief)
  x: number;
  y: number;
  z: number;
  scale: number;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const PingBrackets3D = memo(function PingBrackets3D() {
  const meshRef = useRef<THREE.InstancedMesh>(null!);
  const modifiers = useAtomValue(computedModifiersAtom);
  const modifiersRef = useRef(modifiers);
  modifiersRef.current = modifiers;

  const { geometry, interleavedBuffer, interleavedArray } = useMemo(() => {
    const arr = new Float32Array(MAX_INSTANCES * STRIDE);
    const geo = new THREE.PlaneGeometry(2, 2);

    const ib = new THREE.InstancedInterleavedBuffer(arr, STRIDE, 1);
    ib.setUsage(THREE.DynamicDrawUsage);

    geo.setAttribute("aCenter", new THREE.InterleavedBufferAttribute(ib, 3, 0, false));
    geo.setAttribute("aScale", new THREE.InterleavedBufferAttribute(ib, 1, 3, false));
    geo.setAttribute("aOpacity", new THREE.InterleavedBufferAttribute(ib, 1, 4, false));

    return { geometry: geo, interleavedBuffer: ib, interleavedArray: arr };
  }, []);

  const uTime = useMemo(() => uniform(0), []);

  const material = useMemo(() => {
    const mat = new NodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.depthTest = true;
    mat.side = THREE.DoubleSide;

    // ── Instanced attributes ─────────────────────────────────────
    const aCenter = attribute("aCenter", "vec3");
    const aScale = float(attribute("aScale", "float"));
    // Forward opacity to fragment as a varying
    const vOpacity = float(attribute("aOpacity", "float")).toVarying("v_opacity");

    // ── Vertex: billboard quad ───────────────────────────────────
    const worldCenter = modelWorldMatrix.mul(vec4(aCenter, 1.0));

    mat.vertexNode = Fn(() => {
      const viewCenter = cameraViewMatrix.mul(worldCenter);
      const viewPos = viewCenter.add(
        vec4(positionGeometry.xy.mul(aScale), float(0), float(0))
      );
      return cameraProjectionMatrix.mul(viewPos);
    })();

    // ── Fragment: procedural L-shaped corner brackets ────────────
    mat.fragmentNode = Fn(() => {
      const uvCoord = uv();
      // Map UV 0..1 → -1..1 and mirror into one quadrant via abs
      const p = uvCoord.mul(2).sub(1).abs();

      // Compute screen-space-constant line width using fwidth.
      // fwidth(uv) gives the UV change per screen pixel. Multiplying
      // by LINE_WIDTH_PX converts a pixel count into UV-space units,
      // so the line stays the same thickness regardless of distance.
      const pxToUv = fwidth(uvCoord).mul(2); // ×2 because p is in -1..1 range
      const lineW = max(pxToUv.x, pxToUv.y).mul(float(LINE_WIDTH_PX));

      // Corner bracket: two perpendicular arms forming an "L" at each corner
      const armThreshold = float(1.0 - ARM_LENGTH);
      const lineThreshold = float(1.0).sub(lineW);

      const inH = step(armThreshold, p.x).mul(step(lineThreshold, p.y));
      const inV = step(armThreshold, p.y).mul(step(lineThreshold, p.x));
      const mask = max(inH, inV);

      Discard(mask.lessThan(float(0.5)));

      // Breathing opacity
      const breath = float(BASE_OPACITY).add(
        float(PULSE_AMPLITUDE).mul(
          sin(uTime.mul(float(2.0 * Math.PI / PULSE_PERIOD_S)))
        )
      );

      const color = vec3(...BRACKET_COLOR);
      const alpha = mask.mul(breath).mul(vOpacity);

      return vec4(color, alpha);
    })();

    return mat;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uTime]);

  // Fade state map — persists across frames, not in React state
  const fadeMapRef = useRef(new Map<number, FadeEntry>());

  useFrame((_, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const enabled = getFlag(modifiersRef.current, "scanner.pingHighlightEnabled");
    if (!enabled) {
      if (mesh.visible) {
        mesh.visible = false;
        mesh.count = 0;
        fadeMapRef.current.clear();
      }
      return;
    }

    // Update time uniform
    uTime.value += delta;

    const fadeMap = fadeMapRef.current;
    const candidates = pingWorldBuffer.candidates;

    // Build set of current instanceIds
    const activeIds = new Set<number>();
    for (let i = 0; i < candidates.length; i++) {
      activeIds.add(candidates[i].instanceId);
    }

    // Mark disappeared entries for fade-out
    fadeMap.forEach((entry, id) => {
      if (!activeIds.has(id)) {
        entry.fadeDir = -1;
      }
    });

    // Add new entries / update existing with current positions
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const scale = Math.max(MIN_SCALE, c.radiusM * BRACKET_SCALE_MULT);
      let entry = fadeMap.get(c.instanceId);
      if (!entry) {
        entry = { opacity: 0, fadeDir: 1, x: c.x, y: c.y, z: c.z, scale };
        fadeMap.set(c.instanceId, entry);
      } else {
        entry.fadeDir = 1;
        entry.x = c.x;
        entry.y = c.y;
        entry.z = c.z;
        entry.scale = scale;
      }
    }

    // Write all entries (active + fading out) to the instanced buffer
    let writeIdx = 0;
    const toRemove: number[] = [];

    fadeMap.forEach((entry, id) => {
      // Update opacity
      entry.opacity = Math.min(1, Math.max(0, entry.opacity + entry.fadeDir * FADE_SPEED * delta));

      if (entry.opacity <= 0 && entry.fadeDir === -1) {
        toRemove.push(id);
        return;
      }

      if (writeIdx >= MAX_INSTANCES) return;

      const off = writeIdx * STRIDE;
      interleavedArray[off] = entry.x;
      interleavedArray[off + 1] = entry.y;
      interleavedArray[off + 2] = entry.z;
      interleavedArray[off + 3] = entry.scale;
      interleavedArray[off + 4] = entry.opacity;
      writeIdx++;
    });

    for (const id of toRemove) {
      fadeMap.delete(id);
    }

    mesh.count = writeIdx;
    interleavedBuffer.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.visible = writeIdx > 0;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, MAX_INSTANCES]}
      frustumCulled={false}
      renderOrder={999}
    />
  );
});

export default PingBrackets3D;
