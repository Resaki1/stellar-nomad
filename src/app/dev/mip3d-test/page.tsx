"use client";

// =============================================================================
// Data3DTexture manual-mipmap upload smoke test (three WebGPU backend).
//
// Verifies the pnpm patch in patches/three@0.183.2.patch: upstream three
// (≤ r184) never uploads `texture.mipmaps` for a Data3DTexture — it allocates
// mipLevelCount = mipmaps.length but writes only level 0, so .level(>0)
// samples read WebGPU-zero-initialized memory (all black). See
// docs/CLOUD_DEBUGGING_LESSONS.md case study #16.
//
// The test: an 8³ RGBA volume whose 4 mip levels are filled with DISTINCT
// constant values (R = 40 / 120 / 200 / 255). Each level is sampled with an
// explicit `.level(int(N))`, rendered to a 1×1 target and read back.
//
// Expected with the patch applied:  level N reads its authored value.
// Expected without the patch:      level 0 reads 40, levels 1+ read 0.
//
// Visit /dev/mip3d-test in a WebGPU-capable browser. Re-run after any three
// upgrade to decide whether the patch is still needed.
// =============================================================================

import { useEffect, useRef, useState } from "react";
import * as THREE from "three/webgpu";
import { texture3D, vec3, int } from "three/tsl";

const SIZE = 8;
// Authored R value per mip level (G/B mirror it, A = 255).
const LEVEL_VALUES = [40, 120, 200, 255];
// Readback is 8-bit through an RGBA8 target; allow ±2 for rounding.
const TOLERANCE = 2;

interface LevelResult {
  level: number;
  expected: number;
  got: number;
  pass: boolean;
}

function buildTestVolume(): THREE.Data3DTexture {
  const mipmaps: {
    data: Uint8Array;
    width: number;
    height: number;
    depth: number;
  }[] = [];
  for (let level = 0, s = SIZE; s >= 1; level++, s >>= 1) {
    const data = new Uint8Array(s * s * s * 4);
    const v = LEVEL_VALUES[level] ?? 255;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
    mipmaps.push({ data, width: s, height: s, depth: s });
  }

  const tex = new THREE.Data3DTexture(mipmaps[0].data, SIZE, SIZE, SIZE);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearMipMapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  // Same manual-chain convention as noiseVolumes.ts: mipmaps[0] is the base
  // level, generateMipmaps off.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (tex as any).mipmaps = mipmaps;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

async function runTest(
  canvas: HTMLCanvasElement,
): Promise<{ backend: string; results: LevelResult[] }> {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
  renderer.toneMapping = THREE.NoToneMapping;
  await renderer.init();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const backend = (renderer as any).backend?.isWebGPUBackend
    ? "WebGPU"
    : "WebGL2 (fallback — test does not exercise the patched path!)";

  const volume = buildTestVolume();
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const material = new THREE.MeshBasicNodeMaterial();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));

  const rt = new THREE.RenderTarget(1, 1);
  rt.texture.colorSpace = THREE.NoColorSpace;

  const results: LevelResult[] = [];
  for (let level = 0; level < LEVEL_VALUES.length; level++) {
    // Constant-per-level volume, so any coordinate samples the same value.
    material.colorNode = vec3(
      texture3D(volume, vec3(0.5, 0.5, 0.5)).level(int(level)),
    );
    material.needsUpdate = true;

    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    const pixels = (await renderer.readRenderTargetPixelsAsync(
      rt,
      0,
      0,
      1,
      1,
    )) as Uint8Array;

    const expected = LEVEL_VALUES[level];
    const got = pixels[0];
    results.push({
      level,
      expected,
      got,
      pass: Math.abs(got - expected) <= TOLERANCE,
    });
  }

  renderer.setRenderTarget(null);
  rt.dispose();
  volume.dispose();
  renderer.dispose();
  return { backend, results };
}

export default function Mip3DTestPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null!);
  const startedRef = useRef(false);
  const [backend, setBackend] = useState("initializing…");
  const [results, setResults] = useState<LevelResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (startedRef.current) return; // guard double-invoke in dev StrictMode
    startedRef.current = true;
    runTest(canvasRef.current)
      .then(({ backend, results }) => {
        setBackend(backend);
        setResults(results);
        const allPass = results.every((r) => r.pass);
        console.log(
          `[mip3d-test] backend=${backend} ${allPass ? "PASS" : "FAIL"}`,
          results,
        );
      })
      .catch((e: unknown) => {
        setError(String(e));
        console.error("[mip3d-test] ERROR", e);
      });
  }, []);

  const allPass = results !== null && results.every((r) => r.pass);

  return (
    <main style={{ fontFamily: "monospace", padding: 24, color: "#ddd" }}>
      <h1>Data3DTexture mip upload test</h1>
      <p>Backend: {backend}</p>
      {error && <p style={{ color: "#f66" }}>ERROR: {error}</p>}
      {results && (
        <>
          <h2
            data-testid="verdict"
            style={{ color: allPass ? "#6f6" : "#f66" }}
          >
            {allPass ? "PASS" : "FAIL"}
          </h2>
          <table cellPadding={6}>
            <thead>
              <tr>
                <th>mip level</th>
                <th>expected R</th>
                <th>read back</th>
                <th>result</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.level} style={{ color: r.pass ? "#6f6" : "#f66" }}>
                  <td>{r.level}</td>
                  <td>{r.expected}</td>
                  <td>{r.got}</td>
                  <td>{r.pass ? "PASS" : "FAIL"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <canvas ref={canvasRef} width={2} height={2} style={{ opacity: 0 }} />
    </main>
  );
}
