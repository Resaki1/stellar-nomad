// ---------------------------------------------------------------------------
// AERODYNAMIC WIND — docs/AUDIO_PLAN.md §12.3e.
//
// What the crew hears is the HULL, driven by turbulent-boundary-layer wall
// pressure. That physical level is then compressed into a playable range, the
// way the eye model compresses luminance. One law and three global constants;
// every per-body difference comes from `sol.json` via `acousticsForBody`.
// ---------------------------------------------------------------------------

import { getDominantAtmosphereBody } from "@/components/space/atmospherePass";
import { acousticsForBody, densityAtAltitude } from "./acoustics";
import { audioShipBuffer } from "./shipBuffer";

/**
 * Wall-pressure SPL that maps to 0 dB on the linear segment, dB re 20 µPa.
 * Set 6 dB above Earth's sea level at hypersonic speed (163.6 dB) so Earth
 * never reaches the knee: MEASURED with the ceiling AT Earth, a 10 km/s climb
 * spent its first 15 km in the knee and changed only 4.6 dB.
 */
export const WIND_SPL_CEILING_DB = 170;

/**
 * Wall-pressure SPL that maps to the silent floor. 100 starts a voice on Earth
 * at ~46 km when hypersonic and ~31 km at 400 m/s, and keeps Mars' surface
 * (~119 dB at 10 km/s) just above the promote threshold as a faint whisper.
 * ⚠ The single knob for "where does the atmosphere begin".
 */
export const WIND_SPL_FLOOR_DB = 100;

/**
 * Game level above which the soft knee takes over. Below it game dB is linear
 * in physical dB at a 0.57 ratio, so a climb at constant speed fades steadily
 * (Earth hypersonic: 0.6 dB/km). Only Venus and deep gas-giant flight reach it.
 * ⚠ A knee, never a clamp: the old hard clamp produced the plateau and made
 * every body sound identical at 10 km/s.
 */
export const WIND_KNEE_DB = -4;
/**
 * Logarithmic knee width, dB. 1.25 lands Venus' surface (~202 dB) just under
 * 0 dB. Venus' lowest ~40 km still compress to ~1 dB: 22 dB of real pressure
 * difference has nowhere else to go once Earth owns the linear range.
 */
export const WIND_KNEE_SPAN_DB = 1.25;

/**
 * Bottom of the range, dB. ⚠ Paired with the catalogue's `gainDb: -3` and
 * CULL_EXIT_GAIN 0.008: the floor plays 10^(-40/20)·0.708 = 0.00708, under the
 * exit, so vacuum is exactly silent. LOWERING this strands a voice in vacuum.
 */
export const WIND_RANGE_DB = 40;

/**
 * Rate cap on the played level, dB/s, plus a corner-rounding pole.
 * 🔑 A cap, not a time constant: a τ = 2 s follower lagged 22 dB on an ordinary
 * throttle release (it lags in proportion to the gap); a cap is transparent
 * below it and only bites on cliffs — transit engage, collision dips, warps.
 */
export const WIND_RISE_DB_PER_S = 40;
export const WIND_FALL_DB_PER_S = 14;
export const WIND_SMOOTH_TAU_S = 0.25;

/** Mach numbers mapped to the dullest and brightest layer. */
export const WIND_MACH_DULL = 0.3;
export const WIND_MACH_BRIGHT = 30;
/** Smoothing on the brightness crossfade, s — transit steps Mach in one frame. */
export const WIND_BRIGHTNESS_TAU_S = 0.4;

const P_REF_PA = 20e-6;

/** `q = ½ρv²`, Pa. */
export function dynamicPressurePa(densityKgM3: number, speedMps: number): number {
  if (!Number.isFinite(densityKgM3) || !Number.isFinite(speedMps)) return 0;
  if (densityKgM3 <= 0) return 0;
  return 0.5 * densityKgM3 * speedMps * speedMps;
}

/**
 * Turbulent-boundary-layer wall pressure, dB re 20 µPa. Lowson's attached-TBL
 * fit, `p_rms = 0.006·q / (1 + 0.14·M²)`. Above ~Mach 3 the M² cancels the v²
 * and this tends to ~0.04·γ·P: on re-entry, PRESSURE dominates, not speed.
 * ⚠ Not Curle's V⁶ dipole — that is far-field radiation at low Mach, not what
 * a hull hears, and it put 10 km/s 84 dB over 400 m/s instead of 16.
 */
export function wallPressureSplDb(densityKgM3: number, soundSpeedMps: number, speedMps: number): number {
  const q = dynamicPressurePa(densityKgM3, speedMps);
  if (q <= 0 || !(soundSpeedMps > 0)) return -Infinity;
  const mach = speedMps / soundSpeedMps;
  return 20 * Math.log10((0.006 * q) / (1 + 0.14 * mach * mach) / P_REF_PA);
}

/** Physical SPL → game level in [-WIND_RANGE_DB, 0]: linear, then a log knee. */
export function windLevelDb(splDb: number): number {
  if (!Number.isFinite(splDb)) return -WIND_RANGE_DB;
  const linear = (-WIND_RANGE_DB * (WIND_SPL_CEILING_DB - splDb))
    / (WIND_SPL_CEILING_DB - WIND_SPL_FLOOR_DB);
  if (linear <= -WIND_RANGE_DB) return -WIND_RANGE_DB;
  if (linear <= WIND_KNEE_DB) return linear;
  // Slope 1 at the knee, never flat: denser air is always a little louder.
  const knee = WIND_KNEE_DB + WIND_KNEE_SPAN_DB * Math.log(1 + (linear - WIND_KNEE_DB) / WIND_KNEE_SPAN_DB);
  return Math.min(0, knee);
}

/**
 * Mach → crossfade position in [0, 2] (low, mid, high layer), log-spaced.
 * The boundary-layer spectrum rises with speed, so brightness carries speed
 * where loudness is pressure-dominated. Saturn's c = 858 m/s makes it duller
 * than Earth at the same speed; Mars' 228 m/s makes it brighter.
 */
export function windBrightness(mach: number): number {
  if (!(mach > 0)) return 0;
  const t = Math.log10(mach / WIND_MACH_DULL) / Math.log10(WIND_MACH_BRIGHT / WIND_MACH_DULL);
  return 2 * Math.max(0, Math.min(1, t));
}

/**
 * Per-layer intensity. Triangular weights sum to 1, so brightness moves the
 * timbre without moving the level. ⚠ Pass the FOLLOWED level and position from
 * `windState`; instantaneous values bypass the rate cap.
 */
export function windLayerGain(layer: 0 | 1 | 2, levelDb: number, position: number): number {
  if (!(levelDb > -WIND_RANGE_DB)) return 0;
  const weight = Math.max(0, 1 - Math.abs(position - layer));
  return weight * 10 ** (Math.min(0, levelDb) / 20);
}

/** Written only by `updateWind`; a plain object for the same reason as A5. */
export const windState = {
  bodyId: null as string | null,
  altitudeKm: 0,
  densityKgM3: 0,
  speedMps: 0,
  mach: 0,
  qPa: 0,
  splDb: -Infinity,
  /** Level this instant, before the rate cap. Diagnostic. */
  targetDb: -WIND_RANGE_DB,
  /** Level the emitters play. */
  db: -WIND_RANGE_DB,
  /** Crossfade position the emitters play, 0..2. */
  brightness: 0,
};

let lastTickMs = 0;
let capped = -WIND_RANGE_DB;
let targetBrightness = 0;

/**
 * Discard the followers' memory. Call on teleports (respawn, dev warp, a
 * change of dominant body) — the role `resetExposureAdaptation()` plays.
 */
export function resetWind(): void {
  capped = windState.targetDb;
  windState.db = windState.targetDb;
  windState.brightness = targetBrightness;
  lastTickMs = 0;
}

/**
 * Advance both followers. ⚠ Real elapsed time, not AUDIO_TICK_MS: a
 * background tab throttles setInterval. A gap > 0.5 s snaps instead.
 */
function follow(): void {
  const now = performance.now();
  const dtSec = lastTickMs === 0 ? 0 : (now - lastTickMs) / 1000;
  if (dtSec <= 0 || dtSec > 0.5) {
    resetWind();
    lastTickMs = now;
    return;
  }
  lastTickMs = now;
  capped = Math.max(capped - WIND_FALL_DB_PER_S * dtSec,
    Math.min(capped + WIND_RISE_DB_PER_S * dtSec, windState.targetDb));
  windState.db += (capped - windState.db) * (1 - Math.exp(-dtSec / WIND_SMOOTH_TAU_S));
  windState.brightness += (targetBrightness - windState.brightness)
    * (1 - Math.exp(-dtSec / WIND_BRIGHTNESS_TAU_S));
}

/**
 * Recompute once per audio tick, before the emitters read it.
 * ⚠ `null` from `getDominantAtmosphereBody()` is vacuum: zero the TARGET and
 * let the cap fade it. The record also drops for a frame during texture loads,
 * and a snap there is an audible hole.
 */
export function updateWind(): void {
  const dominant = getDominantAtmosphereBody();
  const atmosphere = dominant ? acousticsForBody(dominant.id) : null;
  if (!dominant || !atmosphere) {
    windState.bodyId = null;
    windState.altitudeKm = 0;
    windState.densityKgM3 = 0;
    windState.speedMps = 0;
    windState.mach = 0;
    windState.qPa = 0;
    windState.splDb = -Infinity;
    windState.targetDb = -WIND_RANGE_DB;
    follow();
    return;
  }
  const altitudeKm = dominant.distanceKm - dominant.params.groundRadiusKm;
  const densityKgM3 = densityAtAltitude(atmosphere, altitudeKm);
  const speedMps = audioShipBuffer.speedMps;
  // ⚠ Isothermal model, so c is the surface value at every altitude.
  const c = atmosphere.surfaceSpeedOfSoundMps;
  const changedBody = windState.bodyId !== null && windState.bodyId !== dominant.id;
  windState.bodyId = dominant.id;
  windState.altitudeKm = altitudeKm;
  windState.densityKgM3 = densityKgM3;
  windState.speedMps = speedMps;
  windState.mach = c > 0 ? speedMps / c : 0;
  windState.qPa = dynamicPressurePa(densityKgM3, speedMps);
  windState.splDb = wallPressureSplDb(densityKgM3, c, speedMps);
  windState.targetDb = windLevelDb(windState.splDb);
  targetBrightness = windBrightness(windState.mach);
  // A different body is a different atmosphere, reached by jumping.
  if (changedBody) resetWind();
  else follow();
}
