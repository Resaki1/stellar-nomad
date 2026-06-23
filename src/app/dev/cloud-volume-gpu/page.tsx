"use client";

// =============================================================================
// GPU base-volume bake VALIDATOR.
//
// Bakes the 128³ base cloud noise volume on the GPU (cloudVolumeCompute.ts) and
// validates it against the CPU reference (noiseVolumes.ts generateBaseVolume),
// which is the thing the marcher currently samples. Two checks:
//
//   A. NUMERIC PARITY (primary) — reads the GPU result back via a storage
//      buffer, quantises identically to the CPU ((v*255)|0), and diffs it
//      byte-for-byte against getCloudBaseVolume().image.data. Reports per-
//      channel mean |Δ|, max |Δ|, and % of voxels differing by > 1 LSB.
//      Expect: tiny (f32-vs-f64 hash divergence) — mean |Δ| ≪ 1, a small %
//      differing by exactly 1. A LARGE diff ⇒ a real port bug (wrong hash /
//      wrong band assembly / wrong scale).
//
//   B. TEXTURE PATH (secondary) — samples the rgba8 Storage3DTexture via
//      texture3D in a NodeMaterial and draws a Z-slice. If it shows a noise
//      slice (not black / no console error), rgba8unorm storage-write +
//      linear-filter sampling works on this device (one of the open unknowns).
//
// Visit /dev/cloud-volume-gpu in a WebGPU browser. Read the on-page report and
// the console. Compare the two slice canvases (CPU vs GPU) by eye.
// =============================================================================

import { useEffect, useRef, useState } from "react";
import * as THREE from "three/webgpu";
import { texture3D, vec3, uv, float } from "three/tsl";
import { getCloudBaseVolume } from "@/components/celestial/bodies/noiseVolumes";
import { createCloudBaseVolumeCompute } from "@/components/celestial/bodies/cloudVolumeCompute";

const N = 128;
const SLICE_PX = 256; // display size for the slice canvases
const SLICE_Z = 64; // which Z slice to visualise

type ChannelStat = {
  name: string;
  meanAbsDiff: number;
  maxAbsDiff: number;
  pctDiffGt1: number;
  cpuMean: number;
  gpuMean: number;
};

// Draw a Z-slice of an RGBA8 128³ volume into a 2D canvas (nearest-upscaled).
function drawSlice(
  canvas: HTMLCanvasElement | null,
  data: Uint8Array,
  z: number,
): void {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const img = ctx.createImageData(N, N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const src = ((z * N + y) * N + x) * 4;
      const dst = (y * N + x) * 4;
      img.data[dst] = data[src]; // R
      img.data[dst + 1] = data[src + 1]; // G
      img.data[dst + 2] = data[src + 2]; // B
      img.data[dst + 3] = 255;
    }
  }
  // Put at native res on an offscreen, then scale up with nearest.
  const tmp = document.createElement("canvas");
  tmp.width = N;
  tmp.height = N;
  tmp.getContext("2d")!.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
}

export default function CloudVolumeGpuValidator() {
  const glCanvasRef = useRef<HTMLCanvasElement>(null!);
  const cpuSliceRef = useRef<HTMLCanvasElement>(null!);
  const gpuSliceRef = useRef<HTMLCanvasElement>(null!);
  const startedRef = useRef(false); // run-once guard (StrictMode double-mount)
  const [status, setStatus] = useState("initialising…");
  const [stats, setStats] = useState<ChannelStat[]>([]);
  const [bakeMs, setBakeMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Run-once guard — matches the proven cloud-slice pattern. Avoids StrictMode
    // double-mount creating two WebGPU contexts on the same canvas (which can
    // make the second init fail and report a false port error).
    if (startedRef.current) return;
    startedRef.current = true;

    (async () => {
      try {
        setStatus("CPU reference bake…");
        const cpuTex = getCloudBaseVolume();
        const cpuData = cpuTex.image.data as Uint8Array;

        setStatus("creating WebGPU renderer…");
        const renderer = new THREE.WebGPURenderer({
          canvas: glCanvasRef.current,
          antialias: false,
        });
        renderer.setSize(SLICE_PX, SLICE_PX, false);
        renderer.toneMapping = THREE.NoToneMapping;
        await renderer.init();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const backend = (renderer as any).backend;
        if (!backend?.isWebGPUBackend) {
          throw new Error("Not running on the WebGPU backend (no device).");
        }

        setStatus("GPU bake (compute dispatch)…");
        const bake = createCloudBaseVolumeCompute(/* withReadbackBuffer */ true);
        const t0 = performance.now();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (renderer as any).computeAsync(bake.computeNode);
        const dt = performance.now() - t0;
        setBakeMs(dt);
        console.log(
          `[cloud-volume-gpu] GPU base bake compute+await: ${dt.toFixed(1)} ms ` +
            `(includes first-dispatch pipeline compile)`,
        );

        setStatus("reading GPU buffer back…");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ab: ArrayBuffer = await (renderer as any).getArrayBufferAsync(
          bake.readbackAttr,
        );
        const gpuFloats = new Float32Array(ab); // vec4/voxel, [0,1]

        // Quantise the GPU floats exactly like the CPU ((v*255)|0) for a fair
        // byte-for-byte comparison.
        const voxels = N * N * N;
        const gpuData = new Uint8Array(voxels * 4);
        for (let k = 0; k < voxels * 4; k++) {
          const v = gpuFloats[k];
          gpuData[k] = v <= 0 ? 0 : v >= 1 ? 255 : (v * 255) | 0;
        }

        setStatus("comparing…");
        const names = ["R", "G", "B", "A"];
        const out: ChannelStat[] = [];
        for (let c = 0; c < 4; c++) {
          let sumAbs = 0;
          let maxAbs = 0;
          let nGt1 = 0;
          let cpuSum = 0;
          let gpuSum = 0;
          for (let i = c; i < voxels * 4; i += 4) {
            const d = Math.abs(cpuData[i] - gpuData[i]);
            sumAbs += d;
            if (d > maxAbs) maxAbs = d;
            if (d > 1) nGt1++;
            cpuSum += cpuData[i];
            gpuSum += gpuData[i];
          }
          out.push({
            name: names[c],
            meanAbsDiff: sumAbs / voxels,
            maxAbsDiff: maxAbs,
            pctDiffGt1: (100 * nGt1) / voxels,
            cpuMean: cpuSum / voxels / 255,
            gpuMean: gpuSum / voxels / 255,
          });
        }
        setStats(out);
        console.log("[cloud-volume-gpu] parity per channel:", out);

        // Slices (CPU bytes vs GPU-quantised bytes).
        drawSlice(cpuSliceRef.current, cpuData, SLICE_Z);
        drawSlice(gpuSliceRef.current, gpuData, SLICE_Z);

        // ── B. Texture-path check: sample the rgba8 storage texture & draw ──
        setStatus("rendering storage-texture slice…");
        const scene = new THREE.Scene();
        const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        const mat = new THREE.NodeMaterial();
        // sample at fixed Z slice; show RGB
        // Sample the texel CENTRE (z+0.5)/N — sampling SLICE_Z/N lands on the
        // texel boundary and trilinearly blends two slices, so canvas C would
        // not match A/B even on a perfect port.
        mat.colorNode = texture3D(
          bake.tex,
          vec3(uv().x, uv().y, float((SLICE_Z + 0.5) / N)),
        ).xyz;
        const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
        scene.add(quad);
        renderer.render(scene, cam);

        setStatus("done ✓");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setStatus("FAILED ✗");
        console.error("[cloud-volume-gpu]", e);
      }
    })();
  }, []);

  return (
    <div style={{ fontFamily: "monospace", padding: 24, color: "#ddd", background: "#111", minHeight: "100vh" }}>
      <h2>GPU base-volume bake validator</h2>
      <p>
        Status: <b>{status}</b>
        {bakeMs != null && <> — GPU bake+readback {bakeMs.toFixed(1)} ms</>}
      </p>
      {error && (
        <p style={{ color: "#f66" }}>
          Error: {error}
        </p>
      )}

      <h3>A. Numeric parity (GPU vs CPU reference)</h3>
      <p style={{ color: "#999" }}>
        Expect mean|Δ| ≪ 1 and a small %&gt;1 (f32-vs-f64 hash divergence). Large
        values ⇒ a real port bug.
      </p>
      <table style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {["chan", "mean|Δ| (0-255)", "max|Δ|", "% voxels |Δ|>1", "CPU mean", "GPU mean"].map((h) => (
              <th key={h} style={{ border: "1px solid #444", padding: "4px 10px", textAlign: "left" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {stats.map((s) => (
            <tr key={s.name}>
              <td style={{ border: "1px solid #444", padding: "4px 10px" }}>{s.name}</td>
              <td style={{ border: "1px solid #444", padding: "4px 10px" }}>{s.meanAbsDiff.toFixed(4)}</td>
              <td style={{ border: "1px solid #444", padding: "4px 10px" }}>{s.maxAbsDiff}</td>
              <td style={{ border: "1px solid #444", padding: "4px 10px" }}>{s.pctDiffGt1.toFixed(3)}%</td>
              <td style={{ border: "1px solid #444", padding: "4px 10px" }}>{s.cpuMean.toFixed(3)}</td>
              <td style={{ border: "1px solid #444", padding: "4px 10px" }}>{s.gpuMean.toFixed(3)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 style={{ marginTop: 24 }}>Slices (Z={SLICE_Z}, RGB)</h3>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        <figure>
          <canvas ref={cpuSliceRef} width={SLICE_PX} height={SLICE_PX} style={{ imageRendering: "pixelated", border: "1px solid #444" }} />
          <figcaption>CPU reference bytes</figcaption>
        </figure>
        <figure>
          <canvas ref={gpuSliceRef} width={SLICE_PX} height={SLICE_PX} style={{ imageRendering: "pixelated", border: "1px solid #444" }} />
          <figcaption>GPU bytes (quantised)</figcaption>
        </figure>
        <figure>
          <canvas ref={glCanvasRef} width={SLICE_PX} height={SLICE_PX} style={{ border: "1px solid #444" }} />
          <figcaption>B. rgba8 Storage3DTexture sampled via texture3D</figcaption>
        </figure>
      </div>
    </div>
  );
}
