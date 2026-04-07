/**
 * useKTX2 hook that uses three.js's KTX2Loader (WebGPU-compatible)
 * instead of drei's version (which uses three-stdlib's WebGL-only KTX2Loader).
 */
import { useEffect } from "react";
import { useThree, useLoader } from "@react-three/fiber";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import type { Texture } from "three";

function isObject(input: unknown): input is Record<string, string> {
  return (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input)
  );
}

export function useKTX2<
  T extends string | string[] | Record<string, string>,
>(
  input: T,
  basisPath = "/basis/",
): T extends string[]
  ? Texture[]
  : T extends Record<string, string>
    ? { [K in keyof T]: Texture }
    : Texture {
  const gl = useThree((s) => s.gl);

  const textures = useLoader(
    KTX2Loader,
    isObject(input) ? Object.values(input) : (input as string | string[]),
    (loader) => {
      loader.detectSupport(gl);
      loader.setTranscoderPath(basisPath);
    },
  );

  // Eagerly upload to GPU (fast for GPU-compressed KTX2 data).
  useEffect(() => {
    const urls = isObject(input) ? Object.values(input) : Array.isArray(input) ? input : [input];
    const arr = Array.isArray(textures) ? textures : [textures];
    arr.forEach((t, i) => {
      const label = urls[i] ?? "unknown";
      const t0 = performance.now();
      gl.initTexture(t);
      const dt = performance.now() - t0;
      if (dt > 1) {
        console.log(`[perf] initTexture ${label} — ${dt.toFixed(1)}ms`);
      }
    });
  }, [gl, textures]);

  if (isObject(input)) {
    const keys = Object.keys(input);
    const keyed: Record<string, Texture> = {};
    keys.forEach((key, i) => {
      keyed[key] = (Array.isArray(textures) ? textures : [textures])[i];
    });
    return keyed as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  return textures as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

useKTX2.preload = (
  url: string | string[],
  basisPath = "/basis/",
): void => {
  useLoader.preload(KTX2Loader, url, (loader) => {
    loader.setTranscoderPath(basisPath);
  });
};

useKTX2.clear = (input: string | string[]): void => {
  useLoader.clear(KTX2Loader, input);
};
