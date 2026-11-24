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
  useFrame(({ clock }) => {
    testProbe.frames++;
    testProbe.frameHooks.forEach((hook) => hook(clock.elapsedTime * 1000));
  });
  return null;
}

/** Run inside the local-content portal so the harness can sample actual rendered meshes. */
export function TestLocalSceneProbe(): null {
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    testProbe.scene = scene;
    testProbe.camera = camera;
    return () => { testProbe.scene = null; testProbe.camera = null; };
  }, [scene, camera]);
  return null;
}
