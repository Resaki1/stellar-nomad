"use client";

// =============================================================================
// Cloud noise SLICE viewer — root-cause instrument for the "stringy billows".
//
// WHY: in-game the clouds show elongated/stringy isosurfaces instead of round
// cauliflower (see docs/VOLUMETRIC_CLOUDS_SHAPE_PLAN.md §Phase B). The cheap
// crease test (BILLOW_CREASE_POWER) did NOT fix it, so we stop guessing and
// LOOK at the field directly. This page samples the SAME base + detail volumes
// the marcher uses and applies the SAME composition math (mirrored from
// earthClouds.ts:1516-1564), but on a flat 2D plane — no ray-march, no
// lighting, no temporal reconstruction, no spherical geometry. It isolates
// the NOISE + COMPOSITION from the RENDERER.
//
// HOW TO READ IT (the bisection):
//   • Flip "Field" through the pipeline stages: R → baseShape → carveWorley →
//     baseShapeCarved. The "Threshold" slider + "binary" mode show each field's
//     ISOSURFACE outline (white = above threshold) — that outline is what reads
//     as "stringy" or "round".
//   • If `baseShapeCarved` (binary) is already stringy here → the necking is in
//     the NOISE/COMPOSITION (the marcher is exonerated; attack the noise).
//   • If every field looks round here but the GAME is stringy → the strings are
//     a RENDER artifact (warp / march / temporal) — look there instead.
//   • Sweep Threshold low→high to reproduce "more carving = more strings": low
//     threshold (high coverage) merges blobs into necks; high threshold isolates
//     them. This is the value-erosion threshold `1 − dimProfile` on `carved`.
//   • Toggle Warp off to empirically rule the domain warp in/out.
//   • Defaults match the game: baseScale 50 (20 km tile), carveScale 250,
//     BILLOW_CARVE 0.75 (your current live values).
//
// Visit /dev/cloud-slice in a WebGPU browser. This page reflects the CURRENT
// noiseVolumes.ts output, including BILLOW_CREASE_POWER.
// =============================================================================

import { useEffect, useRef, useState } from "react";
import * as THREE from "three/webgpu";
import {
  texture3D,
  vec3,
  vec2,
  float,
  int,
  uniform,
  uv,
  step,
  floor,
  fract,
  sin,
  smoothstep,
  mix,
} from "three/tsl";
import {
  getCloudBaseVolume,
  getCloudDetailVolume,
} from "@/components/celestial/bodies/noiseVolumes";

const CANVAS_PX = 768;

// Default knobs (mirror earthClouds.ts current constants).
const DEFAULTS = {
  field: 3, // 0=R 1=baseShape 2=carveWorley 3=baseShapeCarved
  axis: 0, // 0=horizontal XZ, 1=vertical XY
  spanKm: 60,
  slicePosKm: 0,
  baseScale: 50,
  carveScale: 250,
  billowCarve: 0.75,
  threshold: 0.55,
  binary: 1, // 1 = show isosurface (white above threshold), 0 = grayscale
  warp: 1,
  warpAmp: 0.01,
  columnScale: 8,
  detile: 0, // tile-&-offset anti-tiling
  tileSizeKm: 20, // empirical sweet spot (2026-06-15): breaks tiling, few straight edges
  blendWidth: 0.5,
};

const FIELD_NAMES = ["R (perlin-worley)", "baseShape", "carveWorley", "baseShapeCarved"];

type Uniforms = {
  field: ReturnType<typeof uniform>;
  axis: ReturnType<typeof uniform>;
  spanMm: ReturnType<typeof uniform>;
  slicePosMm: ReturnType<typeof uniform>;
  baseScale: ReturnType<typeof uniform>;
  carveScale: ReturnType<typeof uniform>;
  billowCarve: ReturnType<typeof uniform>;
  threshold: ReturnType<typeof uniform>;
  binary: ReturnType<typeof uniform>;
  warp: ReturnType<typeof uniform>;
  warpAmp: ReturnType<typeof uniform>;
  columnScale: ReturnType<typeof uniform>;
  detile: ReturnType<typeof uniform>;
  tileSize: ReturnType<typeof uniform>;
  blendWidth: ReturnType<typeof uniform>;
  offsetRange: ReturnType<typeof uniform>;
};

function buildColorNode(
  baseVol: THREE.Data3DTexture,
  detailVol: THREE.Data3DTexture,
  u: Uniforms,
) {
  // Screen UV → world plane coords (km), then → Mm (the marcher's p-units;
  // base volume tiles every 1000/baseScale km).
  const a = uv().x.sub(0.5).mul(u.spanMm); // Mm
  const b = uv().y.sub(0.5).mul(u.spanMm); // Mm
  const s = u.slicePosMm;
  const pH = vec3(a, s, b); // horizontal slice (XZ at altitude s)
  const pV = vec3(a, b, s); // vertical slice (XY at depth s)
  const pMm = u.axis.lessThan(0.5).select(pH, pV);

  // ── Anti-tiling domain warp (earthClouds.ts:1429-1437) ──
  // Game warp source is the column tap (base volume @ columnScale) g/b/a.
  const colTap = texture3D(baseVol, pMm.mul(u.columnScale)).level(int(0));
  const warpVec = vec3(
    colTap.g.sub(0.5),
    colTap.b.sub(0.5),
    colTap.a.sub(0.5),
  )
    .mul(u.warpAmp)
    .mul(u.warp);
  const pW = pMm.add(warpVec);

  // Compose the selected pipeline field at a given sample position (mirrors
  // earthClouds.ts:1516-1564). Called once normally, or 4× for tile-&-offset.
  const composeAt = (pos: ReturnType<typeof vec3>) => {
    const baseSample = texture3D(baseVol, pos.mul(u.baseScale)).level(int(0));
    const baseFbm = baseSample.g
      .mul(0.625)
      .add(baseSample.b.mul(0.25))
      .add(baseSample.a.mul(0.125));
    const baseShape = baseSample.r
      .add(float(1).sub(baseFbm))
      .div(float(2).sub(baseFbm).max(0.0001))
      .clamp(0, 1);
    const carveSrc = texture3D(detailVol, pos.mul(u.carveScale)).level(int(0));
    const carveWorley = carveSrc.r.mul(0.6).add(carveSrc.g.mul(0.4));
    const carveThresh = float(1).sub(carveWorley).mul(u.billowCarve);
    const carved = baseShape
      .sub(carveThresh)
      .div(float(1).sub(carveThresh).max(0.0001))
      .clamp(0, 1);
    // Field selector (float-compared to dodge int-uniform pitfalls).
    return u.field
      .lessThan(0.5)
      .select(
        baseSample.r,
        u.field
          .lessThan(1.5)
          .select(
            baseShape,
            u.field.lessThan(2.5).select(carveWorley, carved),
          ),
      );
  };

  // ── Tile-&-offset anti-tiling (Quilez "texture repetition" / what EVE's
  // "noise detiling" almost certainly is) ──
  // Partition the WORLD horizontal plane into tiles; give each a rigid random
  // offset (hash of tile id) so the whole tile's noise shifts to a different
  // phase of the infinite tiled field — NO shear (unlike the domain warp).
  // 4-tap bilinear blend with the blend band at tile centres so interiors stay
  // single-offset (clean) and only thin seams cross-dissolve.
  const hashOffset = (cell: ReturnType<typeof vec2>) => {
    const n = cell.x.mul(127.1).add(cell.y.mul(311.7));
    const ox = fract(sin(n).mul(43758.5453));
    const oy = fract(sin(n.add(74.7)).mul(43758.5453));
    const oz = fract(sin(n.add(151.3)).mul(43758.5453));
    return vec3(ox, oy, oz).sub(0.5).mul(u.offsetRange); // Mm
  };
  const single = composeAt(pW);
  const h = vec2(pMm.x, pMm.z); // tile on the world horizontal plane
  const g = h.div(u.tileSize);
  const cell = floor(g);
  const f = fract(g);
  const wx = smoothstep(
    float(0.5).sub(u.blendWidth),
    float(0.5).add(u.blendWidth),
    f.x,
  );
  const wy = smoothstep(
    float(0.5).sub(u.blendWidth),
    float(0.5).add(u.blendWidth),
    f.y,
  );
  const s00 = composeAt(pW.add(hashOffset(cell)));
  const s10 = composeAt(pW.add(hashOffset(cell.add(vec2(1, 0)))));
  const s01 = composeAt(pW.add(hashOffset(cell.add(vec2(0, 1)))));
  const s11 = composeAt(pW.add(hashOffset(cell.add(vec2(1, 1)))));
  const detiled = mix(mix(s00, s10, wx), mix(s01, s11, wx), wy);

  const sel = u.detile.greaterThan(0.5).select(detiled, single);

  // Grayscale OR binary isosurface; thin magenta contour at the threshold.
  const grayOrBinary = u.binary
    .greaterThan(0.5)
    .select(step(u.threshold, sel), sel);
  const isContour = sel.sub(u.threshold).abs().lessThan(0.006);
  const baseColor = vec3(grayOrBinary, grayOrBinary, grayOrBinary);
  return isContour.select(vec3(1.0, 0.0, 0.6), baseColor);
}

async function start(
  canvas: HTMLCanvasElement,
  u: Uniforms,
): Promise<string> {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
  renderer.setSize(CANVAS_PX, CANVAS_PX, false);
  renderer.toneMapping = THREE.NoToneMapping;
  await renderer.init();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const backend = (renderer as any).backend?.isWebGPUBackend
    ? "WebGPU"
    : "WebGL2 (fallback)";

  const baseVol = getCloudBaseVolume();
  const detailVol = getCloudDetailVolume();

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = buildColorNode(baseVol, detailVol, u);
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));

  renderer.setAnimationLoop(() => {
    renderer.render(scene, camera);
  });
  return backend;
}

export default function CloudSlicePage() {
  const canvasRef = useRef<HTMLCanvasElement>(null!);
  const startedRef = useRef(false);
  const uRef = useRef<Uniforms | null>(null);
  const [backend, setBackend] = useState("initializing…");
  const [error, setError] = useState<string | null>(null);
  const [s, setS] = useState(DEFAULTS);

  // Create uniforms once.
  if (uRef.current === null) {
    uRef.current = {
      field: uniform(DEFAULTS.field),
      axis: uniform(DEFAULTS.axis),
      spanMm: uniform(DEFAULTS.spanKm / 1000),
      slicePosMm: uniform(DEFAULTS.slicePosKm / 1000),
      baseScale: uniform(DEFAULTS.baseScale),
      carveScale: uniform(DEFAULTS.carveScale),
      billowCarve: uniform(DEFAULTS.billowCarve),
      threshold: uniform(DEFAULTS.threshold),
      binary: uniform(DEFAULTS.binary),
      warp: uniform(DEFAULTS.warp),
      warpAmp: uniform(DEFAULTS.warpAmp),
      columnScale: uniform(DEFAULTS.columnScale),
      detile: uniform(DEFAULTS.detile),
      tileSize: uniform(DEFAULTS.tileSizeKm / 1000),
      blendWidth: uniform(DEFAULTS.blendWidth),
      offsetRange: uniform(4), // Mm; ≫ 20 km tile so phase fully randomises
    };
  }

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    start(canvasRef.current, uRef.current!)
      .then(setBackend)
      .catch((e: unknown) => {
        setError(String(e));
        console.error("[cloud-slice] ERROR", e);
      });
  }, []);

  // Push a control value into both React state (for the label) and the uniform.
  function setU<K extends keyof typeof DEFAULTS>(
    key: K,
    value: number,
    toUniform: (v: number) => number = (v) => v,
  ) {
    setS((prev) => ({ ...prev, [key]: value }));
    const u = uRef.current;
    if (!u) return;
    // DEFAULTS keys are km; the uniforms hold Mm under different names.
    const uniformKey =
      key === "spanKm"
        ? "spanMm"
        : key === "slicePosKm"
        ? "slicePosMm"
        : key === "tileSizeKm"
        ? "tileSize"
        : key;
    const target = u[uniformKey as keyof Uniforms];
    if (target) (target as { value: number }).value = toUniform(value);
  }

  const row: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 6,
  };
  const label: React.CSSProperties = { width: 150, textAlign: "right" };
  const val: React.CSSProperties = { width: 90, color: "#9cf" };

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
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        <div>
          <canvas
            ref={canvasRef}
            width={CANVAS_PX}
            height={CANVAS_PX}
            style={{ border: "1px solid #333", imageRendering: "pixelated" }}
          />
          <p style={{ fontSize: 12, color: "#888" }}>
            backend: {backend}
            {error && <span style={{ color: "#f66" }}> — {error}</span>}
          </p>
        </div>

        <div style={{ minWidth: 380 }}>
          <h2 style={{ marginTop: 0 }}>Cloud noise slice</h2>

          <div style={row}>
            <span style={label}>Field</span>
            <select
              value={s.field}
              onChange={(e) => setU("field", Number(e.target.value))}
              style={{ flex: 1 }}
            >
              {FIELD_NAMES.map((n, i) => (
                <option key={i} value={i}>
                  {i}: {n}
                </option>
              ))}
            </select>
          </div>

          <div style={row}>
            <span style={label}>Slice axis</span>
            <select
              value={s.axis}
              onChange={(e) => setU("axis", Number(e.target.value))}
              style={{ flex: 1 }}
            >
              <option value={0}>horizontal (XZ — nadir view)</option>
              <option value={1}>vertical (XY — side view)</option>
            </select>
          </div>

          <div style={row}>
            <span style={label}>binary isosurface</span>
            <input
              type="checkbox"
              checked={s.binary === 1}
              onChange={(e) => setU("binary", e.target.checked ? 1 : 0)}
            />
            <span style={{ color: "#888", fontSize: 12 }}>
              (white = above threshold; magenta = contour)
            </span>
          </div>

          {(
            [
              ["threshold", "Threshold", 0, 1, 0.005],
              ["spanKm", "Span (km)", 5, 300, 1],
              ["slicePosKm", "Slice pos (km)", -100, 100, 0.5],
              ["baseScale", "baseScale", 5, 200, 1],
              ["carveScale", "carveScale", 20, 600, 1],
              ["billowCarve", "BILLOW_CARVE", 0, 1, 0.01],
              ["warpAmp", "warp amp (Mm)", 0, 0.04, 0.0005],
              ["columnScale", "warp src scale ↓=lower freq", 0.25, 16, 0.25],
              ["tileSizeKm", "detile: tile size (km)", 10, 200, 1],
              ["blendWidth", "detile: blend width", 0.02, 0.5, 0.01],
            ] as const
          ).map(([key, lab, min, max, stepv]) => (
            <div style={row} key={key}>
              <span style={label}>{lab}</span>
              <input
                type="range"
                min={min}
                max={max}
                step={stepv}
                value={s[key]}
                onChange={(e) =>
                  setU(
                    key,
                    Number(e.target.value),
                    key === "spanKm" ||
                      key === "slicePosKm" ||
                      key === "tileSizeKm"
                      ? (v) => v / 1000
                      : undefined,
                  )
                }
                style={{ flex: 1 }}
              />
              <span style={val}>{s[key]}</span>
            </div>
          ))}

          <div style={row}>
            <span style={label}>domain warp</span>
            <input
              type="checkbox"
              checked={s.warp === 1}
              onChange={(e) => setU("warp", e.target.checked ? 1 : 0)}
            />
            <span style={{ color: "#888", fontSize: 12 }}>
              (the OLD anti-tiling — shears into strings)
            </span>
          </div>

          <div style={row}>
            <span style={label}>tile-&-offset detile</span>
            <input
              type="checkbox"
              checked={s.detile === 1}
              onChange={(e) => setU("detile", e.target.checked ? 1 : 0)}
            />
            <span style={{ color: "#888", fontSize: 12 }}>
              (the NEW anti-tiling — rigid per-tile shift, no shear)
            </span>
          </div>

          <p style={{ color: "#888", fontSize: 12, lineHeight: 1.5 }}>
            <b>Bisection:</b> set Field → <code>baseShapeCarved</code>, binary
            on, axis = horizontal.
            <br />
            If the outline is stringy <i>here</i> → necking is in the
            noise/composition (not the renderer). Step Field back to{" "}
            <code>baseShape</code> then <code>R</code> to find the first stage
            that&apos;s stringy. Sweep Threshold to watch necks form as blobs
            merge.
            <br />
            <b>Anti-tiling A/B:</b> turn <i>domain warp OFF</i> (round blobs but
            a repeating grid), then <i>tile-&-offset detile ON</i> — the grid
            should break up while billows stay round (no curved strings). Tune
            tile size + blend width; widen the Span to ~150 km to see the
            repetition.
          </p>
        </div>
      </div>
    </main>
  );
}
