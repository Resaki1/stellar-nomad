"use client";

// =============================================================================
// Weather Map v2 viewer (CLOUD_TYPES_PLAN.md Phase 1a). Renders the synthetic
// "genus test chart" (weatherMapV2.ts) so the RGBA control stack can be
// validated BEFORE the marcher/shell/light-volume consume it (Phase 1b).
//
// HOW TO READ IT:
//   • Channel selector: R=coverage, G=convectivity, B=topHeight, A=cirrus.
//   • "genus" = false-colour preview: brightness = coverage, hue = convectivity
//     (blue-grey stratiform → warm-white convective), white veil = cirrus.
//   • The horizontal strip near the TOP is the genus test chart: convectivity
//     sweeps left→right, topHeight sweeps bottom→top of the strip, coverage
//     fixed high — the whole type space laid out as an atlas.
//   • Coverage (R) should show air-mass blobs BROKEN INTO CELLS with true black
//     (clear-sky) lanes — the §3.6 H3 mesoscale organization. Convectivity (G)
//     and topHeight (B) should look INDEPENDENT of coverage (that independence
//     is what fixes the binary-border / two-looks problem).
//
// Visit /dev/weather-map in a WebGPU browser.
// =============================================================================

import { useEffect, useRef, useState } from "react";
import * as THREE from "three/webgpu";
import { texture, uv, vec3, uniform, mix } from "three/tsl";
import { getSyntheticWeatherMapV2 } from "@/components/celestial/bodies/weatherMapV2";

const CANVAS_W = 1024;
const CANVAS_H = 512;

const CHANNELS = ["R: coverage", "G: convectivity", "B: topHeight", "A: cirrus", "genus (false colour)"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

function buildColorNode(map: THREE.DataTexture, channel: Node) {
  const t = texture(map, uv()) as Node;
  const cov = t.r;
  const conv = t.g;
  const top = t.b;
  const cir = t.a;
  const gray = (x: Node) => vec3(x, x, x);

  // Genus false colour: coverage → brightness, convectivity → hue (cool
  // stratiform ↔ warm convective), cirrus → white veil.
  const stratiform = vec3(0.45, 0.52, 0.62);
  const convective = vec3(0.97, 0.92, 0.82);
  const genus = mix(stratiform, convective, conv)
    .mul(cov)
    .add(vec3(1, 1, 1).mul(cir).mul(0.4));

  return channel
    .lessThan(0.5)
    .select(
      gray(cov),
      channel
        .lessThan(1.5)
        .select(
          gray(conv),
          channel
            .lessThan(2.5)
            .select(
              gray(top),
              channel.lessThan(3.5).select(gray(cir), genus),
            ),
        ),
    );
}

async function start(
  canvas: HTMLCanvasElement,
  channel: Node,
): Promise<string> {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
  renderer.setSize(CANVAS_W, CANVAS_H, false);
  renderer.toneMapping = THREE.NoToneMapping;
  await renderer.init();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const backend = (renderer as any).backend?.isWebGPUBackend
    ? "WebGPU"
    : "WebGL2 (fallback)";

  const map = getSyntheticWeatherMapV2();

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = buildColorNode(map, channel);
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));

  renderer.setAnimationLoop(() => renderer.render(scene, camera));
  return backend;
}

export default function WeatherMapPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null!);
  const startedRef = useRef(false);
  const channelRef = useRef<Node | null>(null);
  const [backend, setBackend] = useState("initializing…");
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState(4);

  if (channelRef.current === null) channelRef.current = uniform(4);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    start(canvasRef.current, channelRef.current!)
      .then(setBackend)
      .catch((e: unknown) => {
        setError(String(e));
        console.error("[weather-map] ERROR", e);
      });
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
      <h2 style={{ marginTop: 0 }}>Weather Map v2 — synthetic genus test chart</h2>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
        <span>Channel</span>
        <select
          value={channel}
          onChange={(e) => {
            const c = Number(e.target.value);
            setChannel(c);
            if (channelRef.current) channelRef.current.value = c;
          }}
        >
          {CHANNELS.map((n, i) => (
            <option key={i} value={i}>
              {n}
            </option>
          ))}
        </select>
        <span style={{ color: "#888", fontSize: 12 }}>backend: {backend}</span>
        {error && <span style={{ color: "#f66" }}> — {error}</span>}
      </div>
      <canvas
        ref={canvasRef}
        width={CANVAS_W}
        height={CANVAS_H}
        style={{ border: "1px solid #333", width: CANVAS_W, height: CANVAS_H }}
      />
      <p style={{ color: "#888", fontSize: 12, maxWidth: 900, lineHeight: 1.5 }}>
        Top strip = genus atlas (convectivity →, topHeight ↑, coverage fixed).
        Coverage (R) should break into cells with black clear-sky lanes;
        convectivity (G) and topHeight (B) should look independent of coverage.
        Resolution ceiling: at 2048×1024 one texel ≈ 20 km, so the cell lanes
        here are coarser than real 10-40 km Sc cells (Phase-4 decision — see
        weatherMapV2.ts).
      </p>
    </main>
  );
}
