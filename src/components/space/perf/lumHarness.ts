/**
 * `__lum` — the PHOTOMETRIC validation harness.
 *
 * The companion to `__bench` (docs/PERF_MEASUREMENT.md). `__bench` exists
 * because eye-balled FPS turned out to be worthless as a before/after; `__lum`
 * exists for exactly the same reason applied to brightness. The lighting work in
 * docs/LIGHTING_PLAN.md changes absolute luminances by factors of 6–6,000, and
 * "it looks about right" cannot tell a correct 2.76 from an incorrect 0.43.
 *
 *   await __lum.probe()               // centre pixel: game units, cd/m², EV100
 *   await __lum.probe(x, y)           // a specific pixel (drawing-buffer coords)
 *   await __lum.sweep()               // the ladder: measured vs expected + ratio
 *   __lum.expected("luna")            // what physics says this body's disc is
 *   __lum.setEV(14) / __lum.auto()    // pin / release exposure
 *   __lum.units()                     // print the unit convention
 *
 * ── WHAT IS MEASURED ────────────────────────────────────────────────────────
 * The probe reads the FINAL PRE-TONEMAP RGBA16F target — i.e. linear scene
 * luminance in game units, before exposure, bloom or the tone curve. That is the
 * only place a physical number exists; everything after it is display-referred.
 *
 * ── THE TWO RULES ───────────────────────────────────────────────────────────
 * 1. EXPOSURE IS PINNED while sweeping. Auto-exposure (Phase 5) is frame-to-frame
 *    state, so an unpinned sweep measures a function of the previous frame — the
 *    same class of error as the start-state contamination that invalidated three
 *    perf sweeps (docs/PERF_MEASUREMENT.md § VARIANCE RESOLVED).
 * 2. SETTLE BEFORE PROBING. Warping provokes texture streaming, LOD tier swaps
 *    and shader compiles, and the cloud/atmosphere passes have multi-frame
 *    temporal state. A probe on the frame after a warp measures a half-built
 *    image.
 */

import type { createStore } from "jotai";
import type { RenderTarget, WebGPURenderer } from "three/webgpu";

import { devTeleportAtom } from "@/store/dev";
import { bodyPhotometry } from "@/data/bodyPhotometry";
import { getAtmosphereBody } from "../atmospherePass";
import {
  NITS_PER_GAME_UNIT,
  SUN_ILLUM_GAME_1AU,
  discRadianceAtZeroPhase,
  evFromGameUnits,
  getExposure,
  setExposureEV,
  setManualExposure,
  sunIlluminanceAt,
} from "../photometry";
import { resolveBodyWarp } from "./scenarios";

type Store = ReturnType<typeof createStore>;

// ── The probe source, registered by SpaceRenderer each frame ─────────────

type LumSource = {
  renderer: WebGPURenderer;
  /** The final composited pre-tonemap target (rtB when the AP pass routes through it). */
  target: RenderTarget;
};

let _source: LumSource | null = null;
let _setCount = 0;

/**
 * Publish the current pre-tonemap target for probing. Called by SpaceRenderer
 * once per frame — cheap (two reference writes) and it has to be per-frame
 * because `rt`/`rtB` are recreated on resize and dpr change.
 */
export function setLumSource(renderer: WebGPURenderer, target: RenderTarget): void {
  _setCount++;
  if (_source && _source.renderer === renderer && _source.target === target) return;
  _source = { renderer, target };
}

export function clearLumSource(): void {
  _source = null;
}

/**
 * Is a probe target registered, and has SpaceRenderer ever published one into
 * THIS module instance?
 *
 * `setCount === 0` while the scene is visibly rendering means the renderer and
 * the harness are holding two different instances of this module — the classic
 * Fast Refresh split. Full page reload, don't debug the physics.
 */
export function lumSourceStatus(): {
  registered: boolean;
  setCount: number;
  width: number;
  height: number;
} {
  return {
    registered: _source !== null,
    setCount: _setCount,
    width: _source?.target.width ?? 0,
    height: _source?.target.height ?? 0,
  };
}

// ── Types ────────────────────────────────────────────────────────────────

export type LumSample = {
  x: number;
  y: number;
  /** Linear scene luminance, game units (pre-exposure, pre-tonemap). */
  units: [number, number, number];
  /** Photopic mix of the above, game units. */
  luma: number;
  /** Photopic luminance in cd/m². */
  nits: number;
  /** EV100 of `nits`. */
  ev: number;
};

export type LumExpectation = {
  bodyId: string;
  geometricAlbedo: number;
  /** Live top-of-atmosphere illuminance at that body, game units. */
  sunIlluminance: number;
  /** Lambertian-equivalent disc radiance p·E/π, game units. */
  discUnits: number;
  discNits: number;
  discEv: number;
  note?: string;
};

/** One row of the ladder: where to look from, and what should be under the cursor. */
type LumScenario = {
  id: string;
  bodyId: string;
  altitudeKm: number;
  /**
   * What the centre pixel should be showing. `disc` = the body's sunlit disc, so
   * compare against p·E/π. `sky` / `space` have no closed-form expectation yet
   * and are recorded for tracking rather than asserted.
   */
  expect: "disc" | "sky" | "space";
  what: string;
};

/**
 * The ladder. Deliberately small — every row has to be a view whose expected
 * luminance is derivable, or it is just a number with no opinion attached.
 *
 * ⚠ These are all DAY-SIDE, near-zero-phase views, because that is the geometry
 * `p·E/π` describes. Once bodies orbit (LIGHTING_PLAN §3.0) add a non-zero-phase
 * row — a crescent Venus — so latent full-phase assumptions get caught here
 * rather than by eye (risk #12).
 */
const LADDER: readonly LumScenario[] = [
  { id: "earth_disc", bodyId: "earth", altitudeKm: 12_629, expect: "disc", what: "Earth's sunlit disc from high orbit" },
  { id: "earth_sky", bodyId: "earth", altitudeKm: 8, expect: "sky", what: "Sky from the cloud deck (replica ground truth: 0.61 units photopic)" },
  { id: "luna_disc", bodyId: "luna", altitudeKm: 20_000, expect: "disc", what: "The Moon's sunlit disc" },
  { id: "venus_disc", bodyId: "venus", altitudeKm: 30_000, expect: "disc", what: "Venus' cloud deck — the illuminanceTrim victim" },
  { id: "mars_disc", bodyId: "mars", altitudeKm: 20_000, expect: "disc", what: "Mars' disc" },
  { id: "jupiter_disc", bodyId: "jupiter", altitudeKm: 200_000, expect: "disc", what: "Jupiter's disc at 5.2 AU" },
  { id: "neptune_disc", bodyId: "neptune", altitudeKm: 100_000, expect: "disc", what: "Neptune's disc at 30 AU — the 1/r² acid test" },
  { id: "deep_space", bodyId: "earth", altitudeKm: 40_000_000, expect: "space", what: "Nothing in range — the floor (skybox + stars)" },
];

const REC709 = [0.2126, 0.7152, 0.0722] as const;

// ── Readback decoding ────────────────────────────────────────────────────
//
// ⚠ TWO TRAPS, both hit on the first live run (2026-08-14). The symptom was a
// probe of dark space returning exactly 6272 in all three channels — a uniform
// integer, which is never a rendered radiance. Both are properties of
// `readRenderTargetPixelsAsync` on a HalfFloatType target:
//
// 1. IT RETURNS RAW HALF-FLOAT BITS, NOT FLOATS. `rgba16float` maps to
//    `Uint16Array` in WebGPUTextureUtils._getTypedArrayType, and three does no
//    decoding. 6272 = 0x1880 = 2^(6−15)·1.125 = 0.002197. Reading the bits as
//    numbers inflated every value by 10³–10⁶ and made the EV column meaningless.
// 2. ROWS ARE PADDED TO A 256-BYTE STRIDE
//    (`bytesPerRow = ceil(width·bytesPerTexel / 256) · 256`), so for a
//    multi-pixel read the row pitch is NOT `width · 4` elements. A 9-wide read
//    is padded from 72 to 256 bytes — indexing linearly walks into padding.

const BYTES_PER_TEXEL_RGBA16F = 8;

/** IEEE 754 binary16 → number. Handles subnormals, Inf and NaN. */
function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h & 0x7c00) >> 10;
  const frac = h & 0x03ff;
  if (exp === 0) return sign * 2 ** -14 * (frac / 1024); // subnormal (incl. zero)
  if (exp === 0x1f) return frac ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + frac / 1024);
}

/**
 * Elements per row in the returned typed array, accounting for the 256-byte
 * alignment. `width` is the requested read width in pixels.
 */
function rowStrideElements(width: number, bytesPerElement: number): number {
  const bytesPerRow =
    Math.ceil((width * BYTES_PER_TEXEL_RGBA16F) / 256) * 256;
  return bytesPerRow / bytesPerElement;
}

/** Decode one pixel's RGB from a readback buffer, whatever its storage type. */
function decodeRgb(
  buf: ArrayLike<number>,
  base: number,
  isHalf: boolean,
  isByte: boolean,
): [number, number, number] {
  const c = (k: number) => {
    const raw = buf[base + k] ?? 0;
    if (isHalf) return halfToFloat(raw);
    if (isByte) return raw / 255;
    return raw; // Float32Array — already linear floats
  };
  return [c(0), c(1), c(2)];
}

const sleepFrames = (n: number) =>
  new Promise<void>((resolve) => {
    let left = n;
    const tick = () => (left-- <= 0 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });

export class LumHarness {
  constructor(private readonly store: Store) {}

  /** Whether a probe target is registered, and how many times it was published. */
  status(): ReturnType<typeof lumSourceStatus> & { exposure: number } {
    return { ...lumSourceStatus(), exposure: getExposure() };
  }

  /**
   * Verify the half-float decoder against known bit patterns.
   *
   * Exists because the first live run of this harness reported dark space at
   * 13 million cd/m² — `readRenderTargetPixelsAsync` returns raw binary16 bits
   * for a HalfFloatType target and they were being read as floats. Cheap
   * insurance against that silently coming back; run it if numbers look absurd.
   */
  selftest(): boolean {
    const cases: Array<[number, number]> = [
      [0x0000, 0], //  zero
      [0x3c00, 1], //  1.0
      [0x4000, 2], //  2.0
      [0xbc00, -1], // −1.0
      [0x1880, 0.002197265625], // the value that exposed the bug
      [0x41d7, 2.919921875], //   sunlit cloud tops, from the same run
      [0x0001, 2 ** -24], //      smallest subnormal
      [0x7bff, 65504], //         largest finite
    ];
    let ok = true;
    for (const [bits, want] of cases) {
      const got = halfToFloat(bits);
      if (Math.abs(got - want) > Math.abs(want) * 1e-6 + 1e-30) {
        console.error(
          `[lum] halfToFloat(0x${bits.toString(16)}) = ${got}, expected ${want}`,
        );
        ok = false;
      }
    }
    // Row stride must respect the 256-byte alignment, not width×4.
    if (rowStrideElements(9, 2) !== 128) {
      console.error(`[lum] rowStrideElements(9, 2) = ${rowStrideElements(9, 2)}, expected 128`);
      ok = false;
    }
    console.log(ok ? "[lum] selftest OK" : "[lum] selftest FAILED");
    return ok;
  }

  /**
   * Probe the centre and print it against what physics says that body's disc
   * should be. The quick "is this body right?" check.
   */
  async compare(bodyId: string, blockSize = 9) {
    const m = await this.probeMax(blockSize);
    const exp = this.expected(bodyId);
    if (!m || !exp) return null;
    const ratio = m.luma / exp.discUnits;
    console.log(
      [
        `${bodyId}:`,
        `  measured  ${m.luma.toPrecision(4)} units  (${Math.round(m.nits)} cd/m², EV ${m.ev.toFixed(1)})`,
        `  expected  ${exp.discUnits.toPrecision(4)} units  (${Math.round(exp.discNits)} cd/m², EV ${exp.discEv.toFixed(1)})`,
        `  ratio     ${ratio.toPrecision(4)}×  ${ratio > 3 ? "← FAR TOO BRIGHT" : ratio < 0.5 ? "← FAR TOO DIM" : ""}`,
        exp.note ? `  note: ${exp.note}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    return { measured: m, expected: exp, ratio };
  }

  /** Print the unit convention and the current exposure. */
  units(): void {
    console.log(
      [
        `1 game unit        = ${NITS_PER_GAME_UNIT.toFixed(0)} cd/m² (or lux)`,
        `sun illuminance    = ${SUN_ILLUM_GAME_1AU} game units at 1 AU from 1 L☉`,
        `current exposure   = ${getExposure().toPrecision(4)}`,
        `see docs/LIGHTING_PLAN.md §3.1`,
      ].join("\n"),
    );
  }

  /** Pin exposure at a metered EV100. Always do this before measuring. */
  setEV(ev100: number): void {
    setManualExposure(true);
    setExposureEV(ev100);
    console.log(`[lum] exposure pinned at EV100 ${ev100} (×${getExposure().toPrecision(4)})`);
  }

  /** Hand exposure back to auto-exposure (Phase 5; a no-op before that). */
  auto(): void {
    setManualExposure(false);
    console.log("[lum] exposure released to auto");
  }

  /**
   * Read one pixel of the pre-tonemap target.
   *
   * Coordinates are in DRAWING-BUFFER pixels with the origin at the BOTTOM-left
   * (the GPU convention `readRenderTargetPixelsAsync` uses), not CSS pixels
   * top-left. Defaults to the centre, which is where the ladder aims its bodies.
   */
  async probe(x?: number, y?: number): Promise<LumSample | null> {
    if (!_source) {
      console.error("[lum] no render target registered — is the scene mounted?");
      return null;
    }
    const { renderer, target } = _source;
    const px = Math.round(x ?? target.width / 2);
    const py = Math.round(y ?? target.height / 2);

    const buf = await renderer.readRenderTargetPixelsAsync(target, px, py, 1, 1);
    const isHalf = buf instanceof Uint16Array;
    const isByte = buf instanceof Uint8Array;
    const units = decodeRgb(buf as unknown as ArrayLike<number>, 0, isHalf, isByte);
    const luma = REC709[0] * units[0] + REC709[1] * units[1] + REC709[2] * units[2];
    return {
      x: px,
      y: py,
      units,
      luma,
      nits: luma * NITS_PER_GAME_UNIT,
      ev: evFromGameUnits(luma),
    };
  }

  /**
   * Max photopic luma over an n×n block centred on the target — use this for a
   * body's disc rather than `probe()`, so a one-pixel miss (the body slightly
   * off-centre, a cloud gap, a dark surface feature) doesn't read as a failure.
   */
  async probeMax(n = 9): Promise<LumSample | null> {
    if (!_source) return null;
    const { renderer, target } = _source;
    const half = Math.floor(n / 2);
    const cx = Math.round(target.width / 2) - half;
    const cy = Math.round(target.height / 2) - half;
    const buf = await renderer.readRenderTargetPixelsAsync(target, cx, cy, n, n);
    const isHalf = buf instanceof Uint16Array;
    const isByte = buf instanceof Uint8Array;
    const a = buf as unknown as ArrayLike<number>;
    const bytesPerElement = isHalf ? 2 : isByte ? 1 : 4;
    const stride = rowStrideElements(n, bytesPerElement);

    let best: [number, number, number] = [0, 0, 0];
    let bestLuma = -1;
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        const [r, g, b] = decodeRgb(a, row * stride + col * 4, isHalf, isByte);
        const l = REC709[0] * r + REC709[1] * g + REC709[2] * b;
        if (l > bestLuma) {
          bestLuma = l;
          best = [r, g, b];
        }
      }
    }
    return {
      x: cx + half,
      y: cy + half,
      units: best,
      luma: bestLuma,
      nits: bestLuma * NITS_PER_GAME_UNIT,
      ev: evFromGameUnits(bestLuma),
    };
  }

  /**
   * What physics says a body's sunlit disc should be, in game units.
   *
   * Computed from the body's LIVE illuminance where it is registered as an
   * atmosphere body, and from its authored distance otherwise — deliberately
   * parametric rather than a hardcoded table, so it stays valid when bodies
   * orbit and for procedurally generated systems (LIGHTING_PLAN §3.0).
   */
  expected(bodyId: string, starDistanceKm?: number): LumExpectation | null {
    const phot = bodyPhotometry(bodyId);
    if (!phot) {
      console.error(`[lum] no reference photometry for "${bodyId}"`);
      return null;
    }
    const rec = getAtmosphereBody(bodyId);
    const illum =
      rec?.sunIlluminance.x ??
      (starDistanceKm != null ? sunIlluminanceAt(starDistanceKm) : NaN);
    if (!Number.isFinite(illum)) {
      console.warn(
        `[lum] "${bodyId}" is not a registered atmosphere body and no starDistanceKm given — ` +
          `cannot derive its illuminance. Warp to it first, or pass the distance.`,
      );
      return null;
    }
    const discUnits = discRadianceAtZeroPhase(phot.geometricAlbedo, illum);
    return {
      bodyId,
      geometricAlbedo: phot.geometricAlbedo,
      sunIlluminance: illum,
      discUnits,
      discNits: discUnits * NITS_PER_GAME_UNIT,
      discEv: evFromGameUnits(discUnits),
      note: phot.note,
    };
  }

  /** The ladder's rows, for reference. */
  list(): Array<{ id: string; what: string }> {
    return LADDER.map((s) => ({ id: s.id, what: s.what }));
  }

  /**
   * Warp the ladder, probe each row, print measured vs expected.
   *
   * `settleFrames` defaults high because a warp triggers texture streaming and a
   * LOD tier swap; too low and you measure the previous body.
   */
  async sweep({ settleFrames = 180, ev = 14 }: { settleFrames?: number; ev?: number } = {}) {
    if (!_source) {
      console.error("[lum] no render target registered — is the scene mounted?");
      return [];
    }
    const prevExposure = getExposure();
    this.setEV(ev);

    const rows: Array<Record<string, string | number>> = [];
    for (const s of LADDER) {
      this.store.set(devTeleportAtom, resolveBodyWarp(s.bodyId, s.altitudeKm));
      await sleepFrames(settleFrames);
      const m = await this.probeMax(9);
      if (!m) continue;

      const exp = s.expect === "disc" ? this.expected(s.bodyId) : null;
      rows.push({
        row: s.id,
        expect: s.expect,
        "measured (units)": m.luma.toPrecision(4),
        "measured (cd/m²)": Math.round(m.nits),
        "measured EV": m.ev.toFixed(1),
        "expected (units)": exp ? exp.discUnits.toPrecision(4) : "—",
        ratio: exp ? (m.luma / exp.discUnits).toFixed(3) : "—",
      });
    }

    console.table(rows);
    console.log(
      "[lum] `ratio` = measured / Lambertian-equivalent p·E/π. Expect it ABOVE 1 for a\n" +
        "      limb-darkened body (sub-solar nadir exceeds the disc average), and grossly\n" +
        "      BELOW 1 wherever the missing sunIlluminance/π factor (D02) still bites.",
    );
    // Restore rather than leave the session pinned somewhere surprising.
    setManualExposure(true);
    setExposureEV(Math.log2(1 / (1.2 * prevExposure)));
    return rows;
  }
}

let _harness: LumHarness | null = null;

/** The one shared harness (DevTools publishes it as `window.__lum`). */
export function getLumHarness(store: Store): LumHarness {
  if (!_harness) _harness = new LumHarness(store);
  return _harness;
}
