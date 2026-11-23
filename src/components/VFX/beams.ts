// ---------------------------------------------------------------------------
// SHARED MINING BEAMS — docs/VFX_REALISM_PLAN.md §2 (B2–B4).
//
// One beam primitive for the player, co-op pilots and drones: producers push a segment
// per frame (`pushBeam`), `BeamRenderer.tsx` draws them all in one instanced draw.
// A beam in vacuum is invisible (nothing scatters); this is the accepted sci-fi one,
// made believable: a thin near-white core inside a faint sheath, both with REAL widths
// in metres. Where a width drops below a pixel the drawn width is held at the pixel and
// the radiance scaled by true/drawn, so flux per unit length is conserved: solid up
// close, a faint thread far away, never a 1 px line that ignores distance.
// ---------------------------------------------------------------------------

import { emitterColor, nitsToGameUnits } from "@/components/space/emissivePhotometry";
import { pushLightPoint } from "@/components/space/lightPoints";

export const BEAM_CAPACITY = 64;

/** Core Gaussian σ, m (a 5–10 cm bright core). Scales with power^¼ (B3). */
export const BEAM_CORE_SIGMA_M = 0.03;
/** Sheath Gaussian σ, m (a 0.3–0.5 m faint sheath). */
export const BEAM_SHEATH_SIGMA_M = 0.14;

export const beamBuffer = {
  count: 0,
  /** start xyz, end xyz per beam (local-scene metres). */
  seg: new Float32Array(BEAM_CAPACITY * 6),
  /** intensity 0..1 (pulse envelope × fade), power (1 = stock), seed, unused. */
  params: new Float32Array(BEAM_CAPACITY * 4),
  drawn: 0,
};

/**
 * Append a beam for this frame. `intensity` 0..1 is the on-envelope (pulse train, fades),
 * `power` the laser power multiplier (core radiance ∝ power, width ∝ power^¼).
 */
export function pushBeam(
  sx: number, sy: number, sz: number,
  ex: number, ey: number, ez: number,
  intensity: number, power = 1, seed = 0,
): void {
  const B = beamBuffer;
  if (B.count >= BEAM_CAPACITY || !(intensity > 0)) return;
  const i = B.count++;
  B.seg[i * 6] = sx; B.seg[i * 6 + 1] = sy; B.seg[i * 6 + 2] = sz;
  B.seg[i * 6 + 3] = ex; B.seg[i * 6 + 4] = ey; B.seg[i * 6 + 5] = ez;
  B.params[i * 4] = intensity;
  B.params[i * 4 + 1] = power;
  B.params[i * 4 + 2] = seed;
}

// ── Far visibility (B4): muzzle and impact as flux-conserving light points ──────────

/** Emitter aperture glint seen from outside the optics, cd at stock power (design). */
const MUZZLE_CD = 1.5e3;
/** Impact spot: the flux the authored 14 m glow carried (emissivePhotometry `mining_spot`: 8.54e4 cd). */
const IMPACT_CD = 8.5e4;
const _muzzle = emitterColor("mining_muzzle");
const _impact = emitterColor("mining_spot");
const _mLum = 0.2126 * _muzzle.r + 0.7152 * _muzzle.g + 0.0722 * _muzzle.b;
const _iLum = 0.2126 * _impact.r + 0.7152 * _impact.g + 0.0722 * _impact.b;

/** Push the muzzle glint and (when the beam hits something) the impact spot as light points. */
export function pushBeamLights(
  sx: number, sy: number, sz: number,
  ex: number, ey: number, ez: number,
  hit: boolean, intensity: number, power = 1,
): void {
  if (!(intensity > 0)) return;
  // cd → game units × m² (what LightTemplate.rgb holds), hue luminance-normalised.
  const m = nitsToGameUnits(MUZZLE_CD * power * intensity) / _mLum;
  pushLightPoint(sx, sy, sz, _muzzle.r * m, _muzzle.g * m, _muzzle.b * m, 0.25);
  if (!hit) return;
  const k = nitsToGameUnits(IMPACT_CD * power * intensity) / _iLum;
  pushLightPoint(ex, ey, ez, _impact.r * k, _impact.g * k, _impact.b * k, 0.3);
}
