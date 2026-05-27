import * as THREE from "three";

// =============================================================================
// Spatiotemporal Blue Noise (STBN) — for cloud-marcher dither + cone jitter
//
// Source: 128 × 128 × 64 R8 atlas shipped by Blackrack's KSP-EVE volumetric
// clouds mod (`stbn.R8`), 1 MiB total. Standard spatiotemporal blue noise:
// each 128² spatial slice is itself blue-noise-distributed, and the 64-slice
// sequence is blue-noise-distributed *along the time axis* too. Sampling
// `texture3D(stbn, vec3(pixel/128, frame/64)).r` therefore gives a value
// that's perceptually well-distributed both across the screen at one frame
// and across consecutive frames at one pixel — exactly the property TAA
// integration averages cleanly. A `fract(sin(...))` hash has neither.
//
// Why 128² × 64 and not 128³: 64 temporal slices is the canonical Wolfe
// 2022 atlas size for cloud-style TAA — enough to refresh every pixel over
// a ~1-second window at 60 FPS without the temporal pattern becoming
// perceptible. 128 slices would cost 2× the memory for diminishing returns.
//
// Loading: this module returns a `THREE.Data3DTexture` *synchronously* with
// a zero-filled placeholder buffer. The actual atlas bytes are fetched in
// the background; when they arrive, the buffer is filled in place and
// `needsUpdate = true` triggers a GPU upload. Until then, sampling returns
// 0 — equivalent to running the marcher with no jitter, which is harmless
// (mild banding for a few frames, then clean STBN once loaded).
//
// Reference: Wolfe et al. 2022, "Spatiotemporal Blue Noise Masks";
// Blackrack 2021 (KSP-EVE) for the specific atlas we reuse.
// =============================================================================

const STBN_W = 128;
const STBN_H = 128;
const STBN_D = 64;
const STBN_PATH = "/textures/stbn_128.bin";

let cachedTexture: THREE.Data3DTexture | null = null;
let loadStarted = false;

/**
 * Returns a singleton 128 × 128 × 64 R8 `Data3DTexture` for spatiotemporal
 * blue noise jitter. First call schedules an async fetch; subsequent calls
 * return the same texture object (whose data may still be a zero placeholder
 * until the fetch resolves, after which the texture updates in place).
 */
export function getStbnTexture(): THREE.Data3DTexture {
  if (cachedTexture) return cachedTexture;

  const totalBytes = STBN_W * STBN_H * STBN_D;
  const data = new Uint8Array(totalBytes); // zero-filled

  const tex = new THREE.Data3DTexture(data, STBN_W, STBN_H, STBN_D);
  tex.format = THREE.RedFormat;
  tex.type = THREE.UnsignedByteType;
  // STBN values are designed to be sampled point-exact, never filtered —
  // bilinear/trilinear interpolation destroys the blue-noise property.
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.wrapR = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  cachedTexture = tex;

  if (!loadStarted) {
    loadStarted = true;
    fetch(STBN_PATH)
      .then((r) => {
        if (!r.ok) {
          throw new Error(`STBN fetch failed: ${r.status} ${r.statusText}`);
        }
        return r.arrayBuffer();
      })
      .then((buf) => {
        const bytes = new Uint8Array(buf);
        if (bytes.length !== totalBytes) {
          console.error(
            `[stbn] expected ${totalBytes} bytes (128×128×64 R8), got ${bytes.length}`,
          );
          return;
        }
        data.set(bytes);
        tex.needsUpdate = true;
      })
      .catch((err) => {
        // Non-fatal — the shader keeps the zero placeholder, which produces
        // a static (band-prone) dither but otherwise renders fine.
        console.error("[stbn] load failed", err);
      });
  }

  return cachedTexture;
}

/** Texture XY spatial period, in pixels. Exported so shader-side UV math
 * (`fragCoord.xy mod STBN_PERIOD_XY`) stays in sync with the asset. */
export const STBN_PERIOD_XY = STBN_W;

/** Number of temporal slices. The per-frame slice index in
 * `cloudFullscreenPass.ts` advances by `1/STBN_PERIOD_Z` and wraps after
 * this many frames. */
export const STBN_PERIOD_Z = STBN_D;
