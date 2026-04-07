/**
 * Non-suspending KTX2 texture loader.
 *
 * Unlike useKTX2 (which uses useLoader → React Suspense), this hook loads
 * textures via KTX2Loader.loadAsync() and stores them in state. Returns
 * null while loading, then the texture(s) once ready.
 *
 * This avoids the "Interrupted Render" bug where R3F's frame loop prevents
 * React from ever committing a Suspense boundary resolution.
 */
import { useEffect, useState } from "react";
import { useThree } from "@react-three/fiber";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import type { Texture } from "three";

// ── Shared loader + texture cache ────────────────────────────────────

let _loader: KTX2Loader | null = null;
let _loaderRenderer: unknown = null;

function getSharedLoader(gl: unknown, basisPath: string): KTX2Loader {
  if (!_loader || _loaderRenderer !== gl) {
    _loader?.dispose();
    _loader = new KTX2Loader();
    (_loader as any).detectSupport(gl);
    _loader.setTranscoderPath(basisPath);
    _loaderRenderer = gl;
  }
  return _loader;
}

const cache = new Map<string, Texture>();

// ── Hook ─────────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, string> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function useDeferredKTX2<
  T extends string | string[] | Record<string, string>,
>(
  input: T,
  basisPath = "/basis/",
): (T extends string[]
  ? Texture[]
  : T extends Record<string, string>
    ? { [K in keyof T]: Texture }
    : Texture) | null {
  const gl = useThree((s) => s.gl);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [result, setResult] = useState<any>(null);

  const urls = isObject(input)
    ? Object.values(input)
    : Array.isArray(input)
      ? input
      : [input as string];
  const urlKey = urls.join("\0");

  useEffect(() => {
    let cancelled = false;
    const loader = getSharedLoader(gl, basisPath);

    Promise.all(
      urls.map((url) => {
        const cached = cache.get(url);
        if (cached) return Promise.resolve(cached);
        return loader.loadAsync(url).then((tex: Texture) => {
          cache.set(url, tex);
          return tex;
        });
      }),
    )
      .then((loaded) => {
        if (cancelled) return;

        // Eager GPU upload
        for (let i = 0; i < loaded.length; i++) {
          const t = loaded[i];
          const label = urls[i];
          const t0 = performance.now();
          gl.initTexture(t);
          const dt = performance.now() - t0;
          if (dt > 1) {
            console.log(`[perf] initTexture ${label} — ${dt.toFixed(1)}ms`);
          }
        }

        // Build result matching input shape
        if (isObject(input)) {
          const keys = Object.keys(input);
          const keyed: Record<string, Texture> = {};
          keys.forEach((key, i) => {
            keyed[key] = loaded[i];
          });
          setResult(keyed);
        } else if (Array.isArray(input)) {
          setResult(loaded);
        } else {
          setResult(loaded[0]);
        }
      })
      .catch((err) => {
        if (!cancelled) console.error("[useDeferredKTX2]", err);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, urlKey]);

  return result;
}
