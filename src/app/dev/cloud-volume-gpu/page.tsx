"use client";

// =============================================================================
// GPU cloud-volume bake VALIDATOR (base 128³ + detail 64³).
//
// Bakes each volume on the GPU (cloudVolumeCompute.ts) and validates it against
// the CPU reference (noiseVolumes.ts), which is what the marcher samples today.
//
//   NUMERIC PARITY (primary) — reads each GPU result back via a storage buffer,
//   quantises identically to the CPU ((v*255)|0), and diffs it byte-for-byte
//   against the CPU Data3DTexture's level-0 bytes. Reports per-channel mean|Δ|,
//   max|Δ|, % of voxels differing by > 1 LSB. Expect mean|Δ| ≪ 1 (f32-vs-f64
//   hash divergence). A LARGE diff ⇒ a real port bug.
//
//   The DETAIL volume exercises the float-position Worley/Perlin + curl-noise
//   path (the wisp/A channel), which converts floor(pos)→uint — the conversion
//   the base path avoided. If detail R/G/B match but A (wisp) is way off, the
//   curl/float→uint port is the culprit. If everything's off, the float→uint
//   .toVar() materialisation failed (compile error in console).
//
//   TEXTURE PATH — samples the base rgba8 Storage3DTexture via texture3D and
//   draws a slice (proves rgba8unorm storage write + linear sample on-device).
//
// Visit /dev/cloud-volume-gpu in a WebGPU browser. Read the tables + console.
// =============================================================================

import { useEffect, useRef, useState } from "react";
import * as THREE from "three/webgpu";
import { texture3D, vec3, uv, float } from "three/tsl";
import {
  getCloudBaseVolume,
  getCloudDetailVolume,
} from "@/components/celestial/bodies/noiseVolumes";
import {
  createCloudBaseVolumeCompute,
  createCloudDetailVolumeCompute,
  createDetailMip1Compute,
} from "@/components/celestial/bodies/cloudVolumeCompute";

const SLICE_PX = 256;

type ChannelStat = {
  name: string;
  meanAbsDiff: number;
  maxAbsDiff: number;
  pctDiffGt1: number;
  cpuMean: number;
  gpuMean: number;
};

type VolumeResult = {
  label: string;
  size: number;
  bakeMs: number;
  stats: ChannelStat[];
};

// Draw a Z-slice of an RGBA8 size³ volume into a 2D canvas (nearest-upscaled).
function drawSlice(
  canvas: HTMLCanvasElement | null,
  data: Uint8Array,
  size: number,
  z: number,
): void {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = ((z * size + y) * size + x) * 4;
      const dst = (y * size + x) * 4;
      img.data[dst] = data[src];
      img.data[dst + 1] = data[src + 1];
      img.data[dst + 2] = data[src + 2];
      img.data[dst + 3] = 255;
    }
  }
  const tmp = document.createElement("canvas");
  tmp.width = size;
  tmp.height = size;
  tmp.getContext("2d")!.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
}

// Quantise GPU float vec4/voxel ([0,1]) to RGBA8 exactly like the CPU ((v*255)|0).
function quantize(floats: Float32Array): Uint8Array {
  const out = new Uint8Array(floats.length);
  for (let k = 0; k < floats.length; k++) {
    const v = floats[k];
    out[k] = v <= 0 ? 0 : v >= 1 ? 255 : (v * 255) | 0;
  }
  return out;
}

// Per-channel mean+std (in 0-255) over an RGBA8 volume — mirrors
// noiseVolumes.ts channelMoments.
function cpuMoments(data: Uint8Array): { mean: number[]; std: number[] } {
  const n = data.length / 4;
  const sum = [0, 0, 0, 0];
  const sumSq = [0, 0, 0, 0];
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 4; c++) {
      const v = data[i + c];
      sum[c] += v;
      sumSq[c] += v * v;
    }
  }
  const mean = sum.map((s) => s / n);
  const std = sumSq.map((s, c) => Math.sqrt(Math.max(s / n - mean[c] * mean[c], 0)));
  return { mean, std };
}

// 2× box-downsample of an RGBA8 size³ volume — mirrors noiseVolumes.ts
// downsample3DRGBA (sum of 8, /8, truncate).
function cpuBoxDownsample(src: Uint8Array, srcSize: number): Uint8Array {
  const d = srcSize >> 1;
  const dst = new Uint8Array(d * d * d * 4);
  let o = 0;
  for (let z = 0; z < d; z++)
    for (let y = 0; y < d; y++)
      for (let x = 0; x < d; x++) {
        const acc = [0, 0, 0, 0];
        for (let dz = 0; dz < 2; dz++)
          for (let dy = 0; dy < 2; dy++)
            for (let dx = 0; dx < 2; dx++) {
              const s = (((z * 2 + dz) * srcSize + (y * 2 + dy)) * srcSize + (x * 2 + dx)) * 4;
              acc[0] += src[s];
              acc[1] += src[s + 1];
              acc[2] += src[s + 2];
              acc[3] += src[s + 3];
            }
        dst[o++] = (acc[0] / 8) | 0;
        dst[o++] = (acc[1] / 8) | 0;
        dst[o++] = (acc[2] / 8) | 0;
        dst[o++] = (acc[3] / 8) | 0;
      }
  return dst;
}

function compareVolumes(
  cpuData: Uint8Array,
  gpuData: Uint8Array,
  voxels: number,
  names: string[],
): ChannelStat[] {
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
  return out;
}

function StatTable({ result }: { result: VolumeResult }) {
  return (
    <>
      <h3>
        {result.label} ({result.size}³) — GPU bake+readback{" "}
        {result.bakeMs.toFixed(1)} ms
      </h3>
      <table style={{ borderCollapse: "collapse", marginBottom: 8 }}>
        <thead>
          <tr>
            {["chan", "mean|Δ| (0-255)", "max|Δ|", "% |Δ|>1", "CPU mean", "GPU mean"].map((h) => (
              <th key={h} style={{ border: "1px solid #444", padding: "4px 10px", textAlign: "left" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.stats.map((s) => (
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
    </>
  );
}

export default function CloudVolumeGpuValidator() {
  const glCanvasRef = useRef<HTMLCanvasElement>(null!);
  const baseCpuRef = useRef<HTMLCanvasElement>(null!);
  const baseGpuRef = useRef<HTMLCanvasElement>(null!);
  const detailCpuRef = useRef<HTMLCanvasElement>(null!);
  const detailGpuRef = useRef<HTMLCanvasElement>(null!);
  const mip1CpuRef = useRef<HTMLCanvasElement>(null!);
  const mip1GpuRef = useRef<HTMLCanvasElement>(null!);
  const startedRef = useRef(false); // run-once guard (StrictMode double-mount)
  const [status, setStatus] = useState("initialising…");
  const [base, setBase] = useState<VolumeResult | null>(null);
  const [detail, setDetail] = useState<VolumeResult | null>(null);
  const [mip1, setMip1] = useState<VolumeResult | null>(null);
  const [renormStr, setRenormStr] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    (async () => {
      try {
        setStatus("creating WebGPU renderer…");
        const renderer = new THREE.WebGPURenderer({
          canvas: glCanvasRef.current,
          antialias: false,
        });
        renderer.setSize(SLICE_PX, SLICE_PX, false);
        renderer.toneMapping = THREE.NoToneMapping;
        await renderer.init();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (!(renderer as any).backend?.isWebGPUBackend) {
          throw new Error("Not running on the WebGPU backend (no device).");
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = renderer as any;
        const bakeAndRead = async (
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          comp: { computeNode: any; readbackAttr: any },
        ): Promise<{ data: Uint8Array; ms: number }> => {
          const t0 = performance.now();
          await r.computeAsync(comp.computeNode);
          const ms = performance.now() - t0;
          const ab: ArrayBuffer = await r.getArrayBufferAsync(comp.readbackAttr);
          return { data: quantize(new Float32Array(ab)), ms };
        };

        // ── BASE 128³ ──
        setStatus("baking + validating base 128³…");
        const cpuBase = getCloudBaseVolume().image.data as Uint8Array;
        const compBase = createCloudBaseVolumeCompute(true);
        const gpuBase = await bakeAndRead(compBase);
        const baseStats = compareVolumes(cpuBase, gpuBase.data, 128 ** 3, ["R", "G", "B", "A"]);
        setBase({ label: "Base", size: 128, bakeMs: gpuBase.ms, stats: baseStats });
        console.log("[cloud-volume-gpu] base parity:", baseStats);
        drawSlice(baseCpuRef.current, cpuBase, 128, 64);
        drawSlice(baseGpuRef.current, gpuBase.data, 128, 64);

        // ── DETAIL 64³ (exercises curl + float-position path) ──
        setStatus("baking + validating detail 64³…");
        const cpuDetail = getCloudDetailVolume().image.data as Uint8Array;
        const compDetail = createCloudDetailVolumeCompute(true);
        const gpuDetail = await bakeAndRead(compDetail);
        const detailStats = compareVolumes(cpuDetail, gpuDetail.data, 64 ** 3, ["R", "G", "B", "A(wisp)"]);
        setDetail({ label: "Detail", size: 64, bakeMs: gpuDetail.ms, stats: detailStats });
        console.log("[cloud-volume-gpu] detail parity:", detailStats);
        drawSlice(detailCpuRef.current, cpuDetail, 64, 32);
        drawSlice(detailGpuRef.current, gpuDetail.data, 64, 32);

        // ── DETAIL LEVEL-1 (32³ box-downsample + renorm) ──
        // Derive the renorm constants from the CPU reference (mirror
        // renormalizeToMoments), feed them to the GPU mip1 kernel, and compare
        // against the CPU's renormed level-1 (mipmaps[1]). The printed constants
        // are what gets hardcoded for the game path.
        setStatus("baking + validating detail level-1…");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cpuMips = (getCloudDetailVolume() as any).mipmaps;
        const cpuL0 = cpuMips[0].data as Uint8Array; // 64³ raw (== image.data)
        const cpuL1 = cpuMips[1].data as Uint8Array; // 32³ renormed
        const ref = cpuMoments(cpuL0);
        const rawL1 = cpuBoxDownsample(cpuL0, 64);
        const l1m = cpuMoments(rawL1);
        const gain = ref.std.map((s, c) => {
          if (l1m.std[c] <= 1e-3) return 1;
          const g = s / l1m.std[c];
          return g < 1 ? 1 : g > 4 ? 4 : g;
        });
        const tup = (a: number[]): [number, number, number, number] => [a[0], a[1], a[2], a[3]];
        const renorm = {
          refMean: tup(ref.mean.map((m) => m / 255)),
          l1Mean: tup(l1m.mean.map((m) => m / 255)),
          gain: tup(gain),
        };
        const fmt = (a: number[]): string => `[${a.map((v) => v.toFixed(5)).join(", ")}]`;
        setRenormStr(
          `refMean: ${fmt(renorm.refMean)}\nl1Mean:  ${fmt(renorm.l1Mean)}\ngain:    ${fmt(renorm.gain)}`,
        );
        console.log("[cloud-volume-gpu] detail level-1 renorm constants:", renorm);
        const compMip1 = createDetailMip1Compute(compDetail.tex, renorm, true);
        const gpuMip1 = await bakeAndRead(compMip1);
        const mip1Stats = compareVolumes(cpuL1, gpuMip1.data, 32 ** 3, ["R", "G", "B", "A(wisp)"]);
        setMip1({ label: "Detail level-1", size: 32, bakeMs: gpuMip1.ms, stats: mip1Stats });
        console.log("[cloud-volume-gpu] detail level-1 parity:", mip1Stats);
        drawSlice(mip1CpuRef.current, cpuL1, 32, 16);
        drawSlice(mip1GpuRef.current, gpuMip1.data, 32, 16);

        // ── Texture-path check (base storage texture sampled via texture3D) ──
        setStatus("rendering storage-texture slice…");
        const scene = new THREE.Scene();
        const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        const mat = new THREE.NodeMaterial();
        mat.colorNode = texture3D(
          compBase.tex,
          vec3(uv().x, uv().y, float((64 + 0.5) / 128)),
        ).xyz;
        scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
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
      <h2>GPU cloud-volume bake validator</h2>
      <p>
        Status: <b>{status}</b>
      </p>
      {error && <p style={{ color: "#f66" }}>Error: {error}</p>}
      <p style={{ color: "#999" }}>
        Acceptance: per-channel mean|Δ| ≪ 1 and a small %|Δ|&gt;1 (f32-vs-f64
        divergence). Detail A(wisp) exercises the curl + float→uint path.
      </p>

      {base && <StatTable result={base} />}
      {detail && <StatTable result={detail} />}
      {mip1 && <StatTable result={mip1} />}

      {renormStr && (
        <>
          <h3 style={{ marginTop: 16 }}>Detail level-1 renorm constants (hardcode these)</h3>
          <pre style={{ background: "#1c1c1c", border: "1px solid #444", padding: 12, color: "#9f9" }}>
            {renormStr}
          </pre>
        </>
      )}

      <h3 style={{ marginTop: 24 }}>Slices (CPU vs GPU)</h3>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
        <figure>
          <canvas ref={baseCpuRef} width={SLICE_PX} height={SLICE_PX} style={{ imageRendering: "pixelated", border: "1px solid #444" }} />
          <figcaption>Base CPU (Z=64)</figcaption>
        </figure>
        <figure>
          <canvas ref={baseGpuRef} width={SLICE_PX} height={SLICE_PX} style={{ imageRendering: "pixelated", border: "1px solid #444" }} />
          <figcaption>Base GPU (Z=64)</figcaption>
        </figure>
        <figure>
          <canvas ref={detailCpuRef} width={SLICE_PX} height={SLICE_PX} style={{ imageRendering: "pixelated", border: "1px solid #444" }} />
          <figcaption>Detail CPU (Z=32)</figcaption>
        </figure>
        <figure>
          <canvas ref={detailGpuRef} width={SLICE_PX} height={SLICE_PX} style={{ imageRendering: "pixelated", border: "1px solid #444" }} />
          <figcaption>Detail GPU (Z=32)</figcaption>
        </figure>
        <figure>
          <canvas ref={mip1CpuRef} width={SLICE_PX} height={SLICE_PX} style={{ imageRendering: "pixelated", border: "1px solid #444" }} />
          <figcaption>Detail L1 CPU (Z=16)</figcaption>
        </figure>
        <figure>
          <canvas ref={mip1GpuRef} width={SLICE_PX} height={SLICE_PX} style={{ imageRendering: "pixelated", border: "1px solid #444" }} />
          <figcaption>Detail L1 GPU (Z=16)</figcaption>
        </figure>
        <figure>
          <canvas ref={glCanvasRef} width={SLICE_PX} height={SLICE_PX} style={{ border: "1px solid #444" }} />
          <figcaption>Base rgba8 Storage3DTexture via texture3D</figcaption>
        </figure>
      </div>
    </div>
  );
}
