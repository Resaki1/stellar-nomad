"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect } from "react";
import { testProbe } from "./testProbe";

/**
 * Counts RENDERED frames and exposes the renderer to `__test` (dev only).
 *
 * `perf.renderedFrames` only counts while the profiler is on, and rAF keeps ticking
 * while `frameloop="never"` draws nothing, so neither can tell `__test` that a frame
 * actually happened. Priority 0 so it never takes over R3F's render ownership.
 */
export default function TestFrameProbe(): null {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    testProbe.renderer = gl as unknown as typeof testProbe.renderer;
    return () => {
      testProbe.renderer = null;
    };
  }, [gl]);
  useFrame(() => {
    testProbe.frames++;
  });
  return null;
}
