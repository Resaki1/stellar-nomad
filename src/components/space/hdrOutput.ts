/**
 * `hdrOutput` — Phase 6a: the HDR **canvas**, and nothing else.
 *
 * See [`docs/HDR_OUTPUT_PLAN.md`](../../../docs/HDR_OUTPUT_PLAN.md). This module owns
 * exactly one decision — what pixel format the drawing buffer has — plus the read-back
 * that proves the browser honoured it. It deliberately does NOT touch the display
 * transform; that is 6b/6c (`displayTransform.ts`).
 *
 * ── WHAT ONE OPTION DOES ────────────────────────────────────────────────────
 * `new WebGPURenderer({ outputType: HalfFloatType })` makes three do two things
 * (verified in r183.2 **and** r185.1, they are unchanged):
 *
 *   WebGPUUtils.getPreferredCanvasFormat()  →  GPUTextureFormat.RGBA16Float
 *   WebGPUBackend `context` getter          →  context.configure({ …,
 *                                                toneMapping: { mode: 'extended' } })
 *
 * `'standard'` (the default) *clamps every channel to [0,1] in the screen's colour
 * space*. `'extended'` does not — and the spec guarantees it "matches `standard` in the
 * [0,1] range". **That guarantee is why 6a is safe to land alone:** every value we emit
 * today is ≤ 1 (AgX ends in `clamp(0,1)`), so flipping the format cannot change the
 * image. It only removes the ceiling that 6b/6c will then write above.
 *
 * ── WHAT A NUMBER IN THAT BUFFER MEANS ──────────────────────────────────────
 * The canvas colour space stays `'srgb'`, which is the **CSS predefined** space, so
 * values are **transfer-ENCODED, not linear** — and per CSS Color HDR L1, **1.0 is HDR
 * Reference White (nominally 203 cd/m²)**, not the display's peak. Headroom is
 * `log2(peak / referenceWhite)`, expressed in stops. three's `sRGBTransferOETF` has no
 * upper clamp, so it already encodes extended values correctly for free.
 *
 * ⚠⚠ **Peak luminance is NOT queryable, by design.** CSS Color HDR L1 states the
 * platform deliberately does not expose it (viewing-condition dependent, and a tracking
 * vector). `ScreenDetailed.hdrHeadroom` is proposed and has been behind a flag for years.
 * `displayHdrHeadroomStops()` below reads it opportunistically and is expected to return
 * null. The real mechanism is the calibration screen in 6d.
 *
 * ⚠⚠ **On macOS/EDR, headroom SHRINKS as the brightness slider rises** — at full
 * brightness an XDR panel has almost none. So the peak can never be a shader constant;
 * 6c makes it a uniform. Nothing here caches a headroom value.
 *
 * ── WHY THIS NEEDS A RELOAD ─────────────────────────────────────────────────
 * The canvas format is fixed when the `GPUCanvasContext` is configured, which happens
 * once inside a caching getter in `WebGPUBackend`. So the preference is read from
 * localStorage at renderer-construction time, exactly like `isPerfEnabled()` — the
 * Jotai atom is not hydrated yet at that point.
 */

import { HalfFloatType } from "three";
import type { WebGPURenderer } from "three/webgpu";

/**
 * The slice of `GPUCanvasConfiguration` we care about, typed structurally.
 *
 * `@webgpu/types` models `toneMapping` as optional and does not model
 * `getConfiguration()` on every version, so this is the documented wrapper around
 * that gap rather than an `any` sprinkled at each call site.
 */
type CanvasToneMappingMode = "standard" | "extended";
type ProbedCanvasConfig = {
  format?: string;
  colorSpace?: string;
  alphaMode?: string;
  toneMapping?: { mode?: CanvasToneMappingMode };
};
type ConfigurableCanvasContext = {
  getConfiguration?: () => ProbedCanvasConfig | null;
};

/** localStorage key written by `settingsAtom` (`atomWithStorage("settings", …)`). */
const SETTINGS_KEY = "settings";

let _cachedPreference: boolean | null = null;

/**
 * Did the player ask for an HDR drawing buffer?
 *
 * Read from localStorage rather than the settings atom because this is consumed inside
 * the `WebGPURenderer` constructor, before React has hydrated anything — the same
 * constraint, and the same solution, as `isPerfEnabled()`. `?hdr` in the query string
 * forces it on for a single load, which is how the perf sweeps stay reproducible.
 */
export function isHdrOutputRequested(): boolean {
  if (_cachedPreference !== null) return _cachedPreference;
  if (typeof window === "undefined") return false;
  let on = false;
  try {
    if (new URLSearchParams(window.location.search).get("hdr") !== null) {
      on = true;
    } else {
      const raw = window.localStorage.getItem(SETTINGS_KEY);
      if (raw) on = JSON.parse(raw)?.hdrOutput === true;
    }
  } catch {
    // Malformed JSON / storage blocked — SDR is the safe default.
    on = false;
  }
  _cachedPreference = on;
  return on;
}

/**
 * Whether the canvas keeps an alpha channel — i.e. `alphaMode: 'premultiplied'`.
 *
 * ⚠⚠ **HYPOTHESIS REFUTED ON macOS/CHROME — MEASURED 2026-09-01. Retained only for
 * cross-platform re-testing; do NOT flip the default on this evidence.**
 *
 * three defaults `alpha = true`, which `WebGPUBackend` maps to `alphaMode: 'premultiplied'`.
 * The theory was that a premultiplied surface must be *blended* over the page while an opaque
 * one takes a cheaper path, and that this was the ~1.75 ms fixed cost of the HDR canvas
 * (`docs/HDR_OUTPUT_PLAN.md` §5.2). **Measured `?hdr&opaque` vs `?hdr`, same session, 4 minutes
 * apart: opaque is `+0.373 ms SLOWER` (sd 0.187), faster in 0 of 13 valid scenarios.**
 *
 * 🔑 The direction matches the prior the research had already found and that I under-weighted:
 * *"platform surfaces/overlays generally require premultiplied alpha"*, and WebGL's
 * `alpha:false` *"has significant cost on some platforms because … the overlay's alpha channel
 * needs to get cleared or guarded against writes."* Opaque **loses** a fast path here rather
 * than gaining one.
 *
 * Kept because the compositor path is platform-specific and the author has non-Apple displays
 * to test on. `?opaque` in the query string, default unchanged.
 */
export function canvasAlphaRequested(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return new URLSearchParams(window.location.search).get("opaque") === null;
  } catch {
    return true;
  }
}

/**
 * `outputType` for the `WebGPURenderer` constructor.
 *
 * `undefined` is meaningful, not lazy: `getPreferredCanvasFormat()` branches on
 * `bufferType === undefined` and falls back to `navigator.gpu.getPreferredCanvasFormat()`,
 * which is the device's own preference. Passing `UnsignedByteType` instead would *force*
 * `bgra8unorm` and could be worse than the default on some devices.
 */
export function hdrOutputType(): typeof HalfFloatType | undefined {
  return isHdrOutputRequested() ? HalfFloatType : undefined;
}

/**
 * Does the display claim standard-dynamic-range only?
 *
 * ⚠ A capability query, NOT a headroom query — `(dynamic-range: high)` is true for a
 * ~400-nit "HDR400" panel with no local dimming (about **one stop** of real headroom),
 * where engaging HDR usually looks *worse* than SDR. This gates whether the toggle is
 * offered, never whether it is switched on for the player.
 */
export function displaySupportsHdr(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(dynamic-range: high)").matches;
}

/** Wide-gamut capability. Recorded for the log only — see HDR_OUTPUT_PLAN §3 for why
 *  a P3 output path is deferred (measured: no star colour is out of the sRGB gamut). */
export function displaySupportsP3(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(color-gamut: p3)").matches;
}

/**
 * The display's HDR headroom in stops, if the browser happens to expose it.
 *
 * Expected to be `null`: this rides on `ScreenDetailed.hdrHeadroom`, which requires the
 * Window Management permission and has shipped only behind a flag. Used to seed the 6d
 * calibration slider, never to drive the renderer.
 */
export function displayHdrHeadroomStops(): number | null {
  if (typeof window === "undefined") return null;
  const s = window.screen as unknown as { hdrHeadroom?: number };
  const h = s?.hdrHeadroom;
  return typeof h === "number" && Number.isFinite(h) && h > 0 ? Math.log2(h) : null;
}

/** What the canvas actually ended up as, after the browser had its say. */
export type HdrCanvasStatus = {
  /** Did we ask for it? */
  requested: boolean;
  /** Did the browser give us an extended-range canvas? The only answer that matters. */
  active: boolean;
  format: string | null;
  colorSpace: string | null;
  toneMappingMode: CanvasToneMappingMode | null;
  /** `'premultiplied'` (three's default) or `'opaque'`. See `canvasAlphaRequested()`. */
  alphaMode: string | null;
  /** Why `active` is false, when it is. */
  reason: string | null;
  displaySupportsHdr: boolean;
  displaySupportsP3: boolean;
  headroomStops: number | null;
};

const _status: HdrCanvasStatus = {
  requested: false,
  active: false,
  format: null,
  colorSpace: null,
  toneMappingMode: null,
  alphaMode: null,
  reason: "not probed yet",
  displaySupportsHdr: false,
  displaySupportsP3: false,
  headroomStops: null,
};

/**
 * Read the canvas configuration BACK and record what the browser actually did.
 *
 * 🔑 This is the feature test, and it is strictly better than a media query: it
 * interrogates the pipeline we are actually rendering through. A browser that ignores
 * the `toneMapping` option, or silently substitutes a format, shows up here and nowhere
 * else. Call once after `renderer.init()` has resolved — the context is created lazily,
 * on the first frame's `context` getter, so calling earlier reads nothing.
 */
export function probeHdrCanvas(renderer: WebGPURenderer): HdrCanvasStatus {
  _status.requested = isHdrOutputRequested();
  _status.displaySupportsHdr = displaySupportsHdr();
  _status.displaySupportsP3 = displaySupportsP3();
  _status.headroomStops = displayHdrHeadroomStops();

  let cfg: ProbedCanvasConfig | null = null;
  try {
    const canvas = renderer.domElement as HTMLCanvasElement | undefined;
    const ctx = canvas?.getContext("webgpu") as ConfigurableCanvasContext | null;
    cfg = ctx?.getConfiguration?.() ?? null;
  } catch {
    cfg = null;
  }

  if (!cfg) {
    _status.format = null;
    _status.colorSpace = null;
    _status.toneMappingMode = null;
    _status.alphaMode = null;
    _status.active = false;
    _status.reason =
      "canvas not configured yet (the context is created on the first frame) " +
      "or getConfiguration() is unavailable in this browser";
    return _status;
  }

  _status.format = cfg.format ?? null;
  _status.colorSpace = cfg.colorSpace ?? null;
  _status.alphaMode = cfg.alphaMode ?? null;
  _status.toneMappingMode = cfg.toneMapping?.mode ?? null;
  _status.active = _status.toneMappingMode === "extended";
  _status.reason = _status.active
    ? null
    : !_status.requested
      ? "HDR output is off in Settings → Graphics"
      : `requested, but the canvas reports toneMapping.mode "${_status.toneMappingMode ?? "unset"}" ` +
        `and format "${_status.format ?? "unknown"}" — this browser did not honour it`;
  return _status;
}

export const hdrCanvasStatus = (): HdrCanvasStatus => _status;

/**
 * Whether the extended-range canvas is live. 6b/6c gate the display transform's peak on
 * this; until then it only decides what gets logged.
 */
export const isHdrCanvasActive = (): boolean => _status.active;

/** One line at startup, in the style of the other renderer-init logs. */
export function logHdrCanvas(): void {
  const s = _status;
  if (s.active) {
    console.log(
      `[hdr] extended-range canvas ACTIVE — ${s.format}, colorSpace ${s.colorSpace}, ` +
        `toneMapping "${s.toneMappingMode}". 1.0 = HDR reference white (~203 cd/m²); ` +
        `values above it now survive to the compositor. ` +
        `⚠ The display transform still clamps at 1.0 (AgX) — that is Phase 6b/6c, so the ` +
        `image is expected to look IDENTICAL until then. ` +
        `headroom: ${s.headroomStops === null ? "not exposed by this browser (expected)" : s.headroomStops.toFixed(2) + " stops"}`,
    );
  } else {
    console.log(
      `[hdr] SDR canvas — ${s.reason}. display: dynamic-range ${s.displaySupportsHdr ? "high" : "standard"}, ` +
        `gamut ${s.displaySupportsP3 ? "p3" : "srgb"}`,
    );
  }
}
