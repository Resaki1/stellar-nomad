// ---------------------------------------------------------------------------
// AERODYNAMIC WIND — docs/AUDIO_PLAN.md §12.3, the `q = ½ρv²` bed.
//
// The first audible consumer of `acoustics.ts`. Everything else in that module
// (ISO 9613-1 absorption, per-body speed of sound) is validated but waiting on
// content that does not exist yet — an air-coupled world emitter inside an
// atmosphere. This one needs no world emitters at all: it is SHIP tier, heard
// through the hull, so it can ship today and it is the surface-to-orbit
// transition the renderer already showcases visually.
//
// 🔑 ONE LAW, EVERY BODY, NO PER-BODY AUTHORING. Thin-Mars entry and thick-Venus
// entry differ because ρ differs, not because anyone tuned them. That is the
// whole argument for deriving this instead of authoring it.
// ---------------------------------------------------------------------------

import { getDominantAtmosphereBody } from "@/components/space/atmospherePass";
import { acousticsForBody, densityAtAltitude } from "./acoustics";
import { audioShipBuffer } from "./shipBuffer";

/**
 * Dynamic pressure at which the bed sits at its authored level, Pa.
 *
 * 🔑 ANCHORED TO A REAL NUMBER, not to a game constant. ~30 kPa is max-q for a
 * launch vehicle on ascent (Saturn V ≈ 33 kPa, Shuttle ≈ 32 kPa); an airliner
 * cruises nearer 15 kPa. So "full bed" means "the loudest moment of a real
 * atmospheric ascent", which is exactly the manoeuvre this sound exists for.
 *
 * ⚠ Deliberately NOT the ship's own maximum. At SHIP_MAX_SPEED_KMPS = 0.4 km/s
 * in sea-level air, q = ½·1.225·400² = 98 kPa — 15 dB past this reference and
 * clamped. Anchoring here instead means the bed reaches full level where a real
 * vehicle would, and the ship's ability to exceed it reads as "pinned", which
 * is also what it would be.
 */
export const WIND_Q_REF_PA = 30_000;

/**
 * Range below the reference that the bed spans, dB.
 *
 * ⚠ Paired with the catalogue's `gainDb: -3` and the emitter cull, and the
 * three numbers have to be read together. At the floor the level term is
 * 10^(-40/20) = 0.0100, times the -3 dB trim = 0.00708, which is below
 * CULL_EXIT_GAIN (0.008, spatial.ts). So the voice is released at the bottom of
 * the range: the bed reaches **exact silence**, not a fade to an inaudible
 * constant. Raising this past ~41 would strand a voice alive in vacuum forever.
 *
 * 🔑 MEASURED, and the bottom of the range is quieter than this arithmetic
 * alone suggests, because the crossfade splits the level across two layers and
 * each voice faces the cull on its own. Flying Earth at ~390 m/s, the bed
 * promotes descending at **~27 km** (q ≈ 3.8 kPa) and releases climbing at
 * **~34 km** (q ≈ 1.6 kPa) — an intentional 7 km of hysteresis, which is
 * CULL_ENTER/CULL_EXIT doing exactly the job they exist for. Below that the
 * bed is computed but mute, at -27 dBFS and under the engines. Verified live:
 * 27.7 km read drive 0.308 and no voice; 5.9 km read q = 47.3 kPa, level 0 dB,
 * and `ship.wind.high` alive at gain 0.708.
 */
export const WIND_RANGE_DB = 40;

/** `q = ½ρv²`, Pa. ρ in kg/m³, v in m/s. */
export function dynamicPressurePa(densityKgM3: number, speedMps: number): number {
  if (!Number.isFinite(densityKgM3) || !Number.isFinite(speedMps)) return 0;
  if (densityKgM3 <= 0) return 0;
  return 0.5 * densityKgM3 * speedMps * speedMps;
}

/**
 * Level of the wind bed at a given dynamic pressure, dB relative to the
 * reference, clamped to [-WIND_RANGE_DB, 0].
 *
 * 🔑 THE EXPONENT IS NOT A TASTE KNOB. Flow noise from a body in a stream is a
 * Curle **dipole**: radiated intensity goes as V⁶, i.e. 60·log10(V), i.e.
 * **18.06 dB per doubling of airspeed**. Since q ∝ V², that is 30·log10(q) —
 * **9.03 dB per doubling of q**. In amplitude it is the tidy `(q/q_ref)^1.5`,
 * which is amplitude ∝ V³, the standard dipole result.
 *
 * ⚠ V⁶ is the dipole (surface in a flow). Lighthill's V⁸ is the quadrupole
 * (free jet) and is the wrong one here — a hull is a surface, not a jet.
 */
export function windDb(qPa: number): number {
  if (!Number.isFinite(qPa) || qPa <= 0) return -WIND_RANGE_DB;
  const db = 30 * Math.log10(qPa / WIND_Q_REF_PA);
  return Math.max(-WIND_RANGE_DB, Math.min(0, db));
}

/** Where in the bed's range we are, 0 at the silent floor, 1 at the reference. */
export function windDrive(qPa: number): number {
  return 1 + windDb(qPa) / WIND_RANGE_DB;
}

/**
 * Per-layer intensity for the three crossfaded brightness beds.
 *
 * ⚠ THREE LAYERS BECAUSE A SHIP-TIER VOICE CANNOT BE FILTERED AT RUNTIME.
 * `setVoicePropagation` returns early unless the voice is air-coupled, and
 * `connectVoice` leaves the per-voice lowpass disconnected for ship and ui, so
 * there is no cutoff to drive from q. Pre-rendered brightness, crossfaded —
 * the same reason, and the same shape, as `engineLayerGain`.
 *
 * Level and crossfade position both come from the one q, so they cannot drift
 * apart: louder is always also brighter, which is what more airflow does.
 */
export function windLayerGain(layer: 0 | 1 | 2, qPa: number): number {
  const drive = windDrive(qPa);
  if (drive <= 0) return 0;
  const level = 10 ** (windDb(qPa) / 20);
  return Math.max(0, 1 - Math.abs(drive * 2 - layer)) * level;
}

/**
 * What the last tick measured. Read by the emitter intensity callbacks and by
 * `__audio.wind()`; written only by `updateWind`.
 *
 * ⚠ A plain mutable object for the same reason `audioShipBuffer` is one (A5):
 * an atom here would re-render React at tick rate for no reader.
 */
export const windState = {
  bodyId: null as string | null,
  altitudeKm: 0,
  densityKgM3: 0,
  speedMps: 0,
  qPa: 0,
  db: -WIND_RANGE_DB,
};

/**
 * Recompute the wind state. Called once per audio tick, before the emitters
 * read it — three layers sharing one computation rather than each repeating it.
 *
 * ⚠ `null` from `getDominantAtmosphereBody()` is vacuum and must zero the
 * state, never hold the last value. The record is registered per frame only
 * while the body's near or mid LOD is visible, so it can also vanish for a
 * frame or two during a texture load; zeroing is the safe direction (a missed
 * moment of wind, rather than wind that keeps blowing in space).
 *
 * ⚠ The record's `distanceKm` and `audioShipBuffer.speedMps` are both written
 * from `useFrame`, which stops entirely when the settings menu opens
 * (`frameloop="never"`), while this 15 Hz `setInterval` keeps running (A5).
 * The bed therefore holds its last level while the game is paused — the same
 * behaviour the engine beds already have, deliberately matched rather than
 * given new pause semantics of its own.
 */
export function updateWind(): void {
  const dominant = getDominantAtmosphereBody();
  const atmosphere = dominant ? acousticsForBody(dominant.id) : null;
  if (!dominant || !atmosphere) {
    windState.bodyId = null;
    windState.altitudeKm = 0;
    windState.densityKgM3 = 0;
    windState.speedMps = 0;
    windState.qPa = 0;
    windState.db = -WIND_RANGE_DB;
    return;
  }
  // The same expression `emitters.ts` uses, against the body's mean radius.
  const altitudeKm = dominant.distanceKm - dominant.params.groundRadiusKm;
  const densityKgM3 = densityAtAltitude(atmosphere, altitudeKm);
  const speedMps = audioShipBuffer.speedMps;
  const qPa = dynamicPressurePa(densityKgM3, speedMps);
  windState.bodyId = dominant.id;
  windState.altitudeKm = altitudeKm;
  windState.densityKgM3 = densityKgM3;
  windState.speedMps = speedMps;
  windState.qPa = qPa;
  windState.db = windDb(qPa);
}
