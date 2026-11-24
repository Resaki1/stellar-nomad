"use client";

import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { getPreExposure } from "./photometry";
import { FRAME_PRIORITY_LIGHT_POINTS } from "./LightPointsRenderer";
import { SPILL_LIGHTS_MAX, setDevSpillSources, spillStatus, stepSpill } from "./spillLights";
import { flipSpillLightmaps, setSpillBakeGain, spillBakeStats, updateSpillLightmaps } from "./spillBake";

let _gain = 1;
const _cam = new Array<number>(16).fill(0);
/** Pool size; `?spill=N` overrides (0 = none) for the perf A/B. */
const SPILL_N = (() => {
  if (typeof window === "undefined") return SPILL_LIGHTS_MAX;
  const q = new URLSearchParams(window.location.search).get("spill");
  return q === null ? SPILL_LIGHTS_MAX : Math.max(0, Math.min(SPILL_LIGHTS_MAX, Number(q) || 0));
})();

/**
 * S3: the pooled spill lights (spillLights.ts, VFX plan §4). Always mounted, intensity 0 when
 * idle: a light entering or leaving the list recompiles every lit material.
 */
export default function SpillLights() {
  const refs = useRef<(THREE.PointLight | null)[]>([]);

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (window as unknown as { __spill: unknown }).__spill = {
      status: () => ({ ...spillStatus(), gain: _gain, n: SPILL_N, baked: spillBakeStats() }),
      /** Dev A/B: 0 removes the baked station spill. */
      baked: (g: number) => setSpillBakeGain(g),
      flip: (on: boolean) => flipSpillLightmaps(on),
      /** Dev: [x, y, z, r, g, b] sources (scene metres, game units × m²) pushed every frame. */
      inject: (list: number[][]) => setDevSpillSources(list),
      /** Dev: last frame's camera matrixWorld (column-major). */
      cam: () => _cam.slice(),
      /** Dev A/B: 0 darkens the pool (the lights stay in the list). */
      gain: (g: number) => { _gain = g; },
    };
  }, []);

  // After every producer, before LightPoints resets the buffer.
  useFrame((state, dt) => {
    const m = state.camera.matrixWorld.elements;
    for (let i = 0; i < 16; i++) _cam[i] = m[i];
    const ls = stepSpill(SPILL_N, m[12], m[13], m[14], dt);
    const pre = getPreExposure();
    updateSpillLightmaps(pre);
    for (let j = 0; j < SPILL_N; j++) {
      const L = refs.current[j];
      if (!L) continue;
      const l = ls[j];
      const lum = 0.2126 * l.r + 0.7152 * l.g + 0.0722 * l.b;
      if (!l.live || !(lum > 0)) { L.intensity = 0; continue; }
      // Colour normalised, magnitude in intensity (D26h); × pre-exposure (D25).
      L.color.setRGB(l.r / lum, l.g / lum, l.b / lum);
      L.intensity = lum * l.w * pre * _gain;
      L.position.set(l.x, l.y, l.z);
    }
  }, FRAME_PRIORITY_LIGHT_POINTS - 0.05);

  return (
    <>
      {Array.from({ length: SPILL_N }, (_, j) => (
        <pointLight key={j} ref={(l) => { refs.current[j] = l; }} intensity={0} decay={2} distance={0} />
      ))}
    </>
  );
}
