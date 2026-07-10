"use client";

// =============================================================================
// Cloud profile LUT viewer (CLOUD_TYPES_PLAN.md Phase 2a, §4.2). Renders the
// vertical-profile LUT (cloudProfileLUT.ts) so the genus anatomy family can be
// validated BEFORE the marcher/shell/light-volume consume it (Phase 2b).
//
// HOW TO READ IT:
//   • HEATMAP (left): the raw 64×64 LUT. x = altNorm (0 base → 1 top),
//     y = convectivity (0 stratiform at BOTTOM → 1 convective at TOP),
//     brightness = vertical density fraction. Read as an atlas of genera
//     stacked bottom→top. Reads the ACTUAL DataTexture bytes the shader samples.
//   • CURVES (right): the profile at convectivity 0 / 0.25 / 0.5 / 0.75 / 1.0,
//     altNorm along x, density up. From the same profileLUTValue() the
//     generator bakes per texel.
//
// WHAT "GOOD" LOOKS LIKE (the Phase-2 acceptance checks):
//   • BOUNDARY-ZERO: the heatmap is BLACK down its entire left (altNorm 0) and
//     right (altNorm 1) edges, and every curve starts and ends at 0. (A bright
//     edge = ceiling/floor extrusion — the blocker invariant #1.)
//   • DISTINCT GENERA: the bottom rows (stratiform) peak LATE and hold flat
//     (sheet); the middle rows (Cu) have a SHARP low rise + rounded parabolic
//     dome; the top rows (Cb) are near-full with a slight top taper.
//   • CONTINUOUS: no hard horizontal seam anywhere up the heatmap — the shape
//     morphs smoothly row to row (no binary border at any convectivity).
//
// Visit /dev/cloud-profile (no WebGPU needed — plain 2D canvas).
// =============================================================================

import { useEffect, useRef } from "react";
import {
  getCloudProfileLUT,
  profileLUTValue,
} from "@/components/celestial/bodies/cloudProfileLUT";

const SCALE = 6; // heatmap texel → screen px (64 × 6 = 384)
const LUT_SIZE = 64;
const HEAT_PX = LUT_SIZE * SCALE;

const PLOT_W = 384;
const PLOT_H = 384;
const PAD = 32;

const CURVES = [
  { conv: 0.0, color: "#6ea8ff", label: "conv 0.0  (St)" },
  { conv: 0.25, color: "#66d0c0", label: "conv 0.25 (Sc)" },
  { conv: 0.5, color: "#c9d94f", label: "conv 0.5  (Ac/Cu)" },
  { conv: 0.75, color: "#ffb14e", label: "conv 0.75 (Cu cong)" },
  { conv: 1.0, color: "#ff6b6b", label: "conv 1.0  (Cb)" },
];

function drawHeatmap(ctx: CanvasRenderingContext2D) {
  const tex = getCloudProfileLUT();
  const data = tex.image.data as Uint8Array; // R8, length 64*64
  for (let j = 0; j < LUT_SIZE; j++) {
    // convectivity 0 at BOTTOM → flip y so higher rows are more convective.
    const screenRow = LUT_SIZE - 1 - j;
    for (let i = 0; i < LUT_SIZE; i++) {
      const g = data[j * LUT_SIZE + i];
      ctx.fillStyle = `rgb(${g},${g},${g})`;
      ctx.fillRect(i * SCALE, screenRow * SCALE, SCALE, SCALE);
    }
  }
  // Axis labels.
  ctx.fillStyle = "#888";
  ctx.font = "11px monospace";
  ctx.fillText("altNorm 0 (base) →→→ 1 (top)", 4, HEAT_PX - 4);
  ctx.save();
  ctx.translate(HEAT_PX + 14, HEAT_PX);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("convectivity 0 (St) →→→ 1 (Cb)", 4, 0);
  ctx.restore();
}

function drawCurves(ctx: CanvasRenderingContext2D) {
  ctx.clearRect(0, 0, PLOT_W, PLOT_H);
  const x0 = PAD;
  const x1 = PLOT_W - PAD;
  const y0 = PLOT_H - PAD;
  const y1 = PAD;
  // Grid + frame.
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 1;
  ctx.strokeRect(x0, y1, x1 - x0, y0 - y1);
  ctx.fillStyle = "#888";
  ctx.font = "11px monospace";
  ctx.fillText("density", x0 - 26, y1 + 8);
  ctx.fillText("altNorm 0→1", (x0 + x1) / 2 - 30, y0 + 18);

  const N = 200;
  for (const { conv, color } of CURVES) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let k = 0; k <= N; k++) {
      const a = k / N;
      const d = profileLUTValue(a, conv);
      const px = x0 + a * (x1 - x0);
      const py = y0 - d * (y0 - y1);
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
}

export default function CloudProfilePage() {
  const heatRef = useRef<HTMLCanvasElement>(null!);
  const plotRef = useRef<HTMLCanvasElement>(null!);

  useEffect(() => {
    const hctx = heatRef.current.getContext("2d");
    const pctx = plotRef.current.getContext("2d");
    if (hctx) drawHeatmap(hctx);
    if (pctx) drawCurves(pctx);
  }, []);

  return (
    <main
      style={{
        fontFamily: "monospace",
        padding: 16,
        color: "#ddd",
        background: "#111",
        minHeight: "100vh",
      }}
    >
      <h2 style={{ marginTop: 0 }}>Cloud profile LUT — genus anatomy atlas</h2>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div>
          <div style={{ color: "#888", fontSize: 12, marginBottom: 6 }}>
            64×64 LUT (actual texels)
          </div>
          <canvas
            ref={heatRef}
            width={HEAT_PX + 20}
            height={HEAT_PX}
            style={{ border: "1px solid #333" }}
          />
        </div>
        <div>
          <div style={{ color: "#888", fontSize: 12, marginBottom: 6 }}>
            profile curves by convectivity
          </div>
          <canvas
            ref={plotRef}
            width={PLOT_W}
            height={PLOT_H}
            style={{ border: "1px solid #333" }}
          />
          <ul style={{ listStyle: "none", padding: 0, margin: "8px 0", fontSize: 12 }}>
            {CURVES.map((c) => (
              <li key={c.conv} style={{ color: c.color }}>
                ■ {c.label}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <p style={{ color: "#888", fontSize: 12, maxWidth: 820, lineHeight: 1.5 }}>
        Boundary-zero: both left/right heatmap edges black, every curve 0 at
        both ends (else columns extrude to the slab ceiling/floor). Distinct
        genera: stratiform (bottom / blue) = late flat-topped sheet; cumulus
        (green-orange) = sharp low base + rounded parabolic dome; Cb (top / red)
        = near-full with a slight top taper. Continuous: no hard horizontal seam
        up the heatmap. altNorm is normalized to each column&apos;s own
        [base, top] span — the shader (cloudShared, Phase 2b) places that span
        from topHeight + convectivity, which is what turns these shapes into
        thin high sheets vs deep towers.
      </p>
    </main>
  );
}
