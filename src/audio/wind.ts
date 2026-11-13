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
 * 🔑 THE SHIP'S OWN SEA-LEVEL MAX-Q, and it is a GLOBAL constant, not per body.
 * `½ · 1.225 · 400² = 98 kPa` — Earth at sea level at SHIP_MAX_SPEED_KMPS. Every
 * body is then measured against that one yardstick, which is the whole point:
 * Venus pins and Mars whispers because ρ differs, not because anyone tuned them.
 * A per-body reference would make every planet use the full range and therefore
 * sound the same, which is the opposite of what this system is for.
 *
 * ⚠⚠ THIS WAS 30 kPa — real ascent max-q (Saturn V ≈ 33 kPa) — and that was a
 * better story than a design. The ship makes 98 kPa at sea level, so the level
 * CLAMPED for the first 15 dB: MEASURED, it was pinned at 0 dB from the ground
 * to 9.8 km at full throttle, still only −8 dB at 15 km, and then spent the
 * whole 40 dB between 10 and 35 km. Reported as "the volume did not really
 * decrease at all for the most part … and then it suddenly decreases to 0".
 * Anchored here instead, the level falls from the first metre of climb
 * (−15.3 dB at 10 km, −30.7 dB at 20 km, released by 25.5 km) with no plateau.
 *
 * ⚠ The COST is Mars. The voice releases ~39 dB below this reference, so flight
 * is audible only where q ≥ ~500 Pa. Mars at 400 m/s on the surface is 1.6 kPa
 * against Earth's 98 kPa — −53.6 dB — so Mars is silent, where the old 30 kPa
 * put it just inside the range. That is physically right (1/61 the density is
 * like flying 50 m/s on Earth) and it is the honest consequence of one global
 * yardstick, but it is a real loss and it is why this number is documented
 * rather than tuned. Raising the ship's top speed moves this.
 */
export const WIND_Q_REF_PA = 98_000;

/**
 * Range below the reference that the bed spans, dB.
 *
 * ⚠ Paired with the catalogue's `gainDb: -3` and the emitter cull, and the
 * three numbers have to be read together. At the floor the level term is
 * 10^(-40/20) = 0.0100, times the -3 dB trim = 0.00708, which is below
 * CULL_EXIT_GAIN (0.008, spatial.ts). So the voice is released at the bottom of
 * the range: the bed reaches **exact silence**, not a fade to an inaudible
 * constant. ⚠ LOWERING this is the danger, not raising it: at 30 the floor
 * would be 10^(-30/20)·0.708 = 0.0224, above CULL_EXIT, and the voice would
 * never release. (An earlier revision of this comment had that backwards.)
 *
 * ⚠ The rate cap below delays that release but cannot prevent it: the cap
 * subtracts a fixed dB each tick, so the floor is reached exactly rather than
 * approached. MEASURED in simulation, worst case (target slammed to the floor
 * in one tick): -10.9 dB at 1 s, -24.7 dB at 2 s, floor at 3.2 s, voice
 * released at 3.7 s.
 *
 * 🔑 MEASURED, and the bottom of the range is quieter than this arithmetic
 * alone suggests, because the crossfade splits the level across two layers and
 * each voice faces the cull on its own. Flying Earth at ~390 m/s, the bed
 * promotes descending at **~27 km** (q ≈ 3.8 kPa) and releases climbing at
 * **~34 km** (q ≈ 1.6 kPa) — an intentional 7 km of hysteresis, which is
 * CULL_ENTER/CULL_EXIT doing exactly the job they exist for. Below that the
 * bed is computed but mute, at -27 dBFS and under the engines. Verified live:
 * 27.7 km read drive 0.308 and no voice; 5.9 km read q = 47.3 kPa, level 0 dB,
 * and `ship.wind.high` alive at gain 0.708. ⚠ Those altitudes are q-based, so
 * they hold at ~390 m/s and nowhere else; and the rate cap now puts the
 * release a second or two later than the altitude alone predicts.
 */
export const WIND_RANGE_DB = 40;

/**
 * Rate limits on the derived level, dB per second, and the corner-rounding
 * time constant that follows them.
 *
 * ⚠⚠ THE DERIVED LEVEL IS NOT PLAYABLE RAW. Nothing between `q` and the voice
 * gain had any memory: the only smoothing in the chain was the 50 ms AudioParam
 * constant in `setVoiceGain`, ~150 ms to settle. Since level is `30·log10(q)`
 * and `q ∝ v²`, a speed change of factor f moves the bed by `60·log10(f)` — so
 * 400 → 100 m/s at 5 km is **−28.5 dB arriving in 150 ms**, and leaving the
 * atmosphere under transit (800 km/s², with no altitude gate on engaging)
 * crosses the whole 40 dB range in under a second. Reported as "one second the
 * wind is full volume and then suddenly it drops way too fast to zero", which
 * is exactly what the arithmetic says.
 *
 * 🔑 A RATE CAP, NOT A TIME CONSTANT. A first-order follower lags in proportion
 * to the gap, so it is sluggish precisely when the signal is moving legitimately
 * across a wide range: MEASURED on a throttle release at 5 km, a τ = 2 s
 * follower played −17 dB while `q` said −39, a 22 dB lag during ordinary
 * flying. A cap is transparent below it and only bites on the cliff. At
 * 14 dB/s an ordinary 400 m/s climb (0.61 dB/s) and a throttle release
 * (~15 dB/s) pass essentially untouched, while a transit departure becomes a
 * 2.9 s fade instead of a step.
 *
 * ⚠ Asymmetric, the same shape and the same reason as the eye's adaptation in
 * `exposureMeter.ts` (TAU_BRIGHTEN 0.25 s against TAU_DARKEN_CONE 2.0 s): an
 * onset you should feel arrive, a decay you should not catch happening. In dB
 * because the law is logarithmic in q — a limiter in amplitude would be fast at
 * the top of the range and glacial at the bottom.
 *
 * ⚠ This is the ONLY memory in the chain, so it is also what absorbs the
 * instantaneous steps the flight model legitimately produces: the collision
 * speed dip (`speed.current *= 1 - dip`, up to −27.7 dB in the bed), transit
 * engage (~13 km/s on the first frame at 60 fps) and transit disengage (up to
 * 500 m/s snapped to 0 in one frame).
 */
export const WIND_RISE_DB_PER_S = 40;
export const WIND_FALL_DB_PER_S = 14;
/** Rounds the corner where the cap stops biting; a bare cap changes slope. */
export const WIND_SMOOTH_TAU_S = 0.25;

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

/**
 * Per-layer intensity for the three crossfaded brightness beds.
 *
 * ⚠ Takes the **followed** level in dB (`windState.db`), not `q`. Passing the
 * instantaneous `windDb(qPa)` here bypasses the rate cap and restores the
 * cliff; that is how the first version was wired.
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
export function windLayerGain(layer: 0 | 1 | 2, levelDb: number): number {
  const db = Math.max(-WIND_RANGE_DB, Math.min(0, levelDb));
  const drive = 1 + db / WIND_RANGE_DB;
  if (drive <= 0) return 0;
  return Math.max(0, 1 - Math.abs(drive * 2 - layer)) * 10 ** (db / 20);
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
  /** What `q` says this instant, before the follower. Diagnostic only. */
  targetDb: -WIND_RANGE_DB,
  /** What the emitters actually play. The followed value. */
  db: -WIND_RANGE_DB,
};

let lastTickMs = 0;
/** The rate-limited level, before corner rounding. */
let capped = -WIND_RANGE_DB;

/**
 * Snap the follower to the instantaneous level, discarding its memory.
 *
 * ⚠ Call this whenever the ship's situation changes by teleport rather than by
 * flying — a respawn, a dev warp, a system jump. Without it the bed would
 * cross-fade a 5 km hull roar into an orbital vacuum over two seconds, which is
 * the one case where the follower's whole purpose is wrong. The same role, and
 * the same reason, as `resetExposureAdaptation()` for the eye.
 */
export function resetWind(): void {
  capped = windState.targetDb;
  windState.db = windState.targetDb;
  lastTickMs = 0;
}

/**
 * Advance the followed level one tick toward `targetDb`.
 *
 * ⚠ Measure the real elapsed time; do not assume `AUDIO_TICK_MS`. A
 * `setInterval` is not a clock — the browser throttles it in a background tab
 * and coalesces it under load — and a follower that trusts a nominal dt decays
 * at the wrong rate exactly when the frame budget is worst. The first tick, and
 * any gap over half a second, snaps instead of integrating a stale interval.
 */
function follow(): void {
  const now = performance.now();
  const dtSec = lastTickMs === 0 ? 0 : (now - lastTickMs) / 1000;
  lastTickMs = now;
  if (dtSec <= 0 || dtSec > 0.5) {
    capped = windState.targetDb;
    windState.db = windState.targetDb;
    return;
  }
  const target = windState.targetDb;
  capped = Math.max(capped - WIND_FALL_DB_PER_S * dtSec,
    Math.min(capped + WIND_RISE_DB_PER_S * dtSec, target));
  // 1 - e^(-dt/tau), so the rounding is independent of the tick interval.
  windState.db += (capped - windState.db) * (1 - Math.exp(-dtSec / WIND_SMOOTH_TAU_S));
}

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
    windState.targetDb = -WIND_RANGE_DB;
    // ⚠ The TARGET is zeroed, not the played level: the record also drops out
    // for a frame or two during a texture load, and a snap to silence there is
    // an audible hole. The follower reaches the floor in a few seconds either
    // way, so vacuum is still exactly silent — it just arrives by fading.
    follow();
    return;
  }
  // The same expression `emitters.ts` uses, against the body's mean radius.
  const altitudeKm = dominant.distanceKm - dominant.params.groundRadiusKm;
  const densityKgM3 = densityAtAltitude(atmosphere, altitudeKm);
  const speedMps = audioShipBuffer.speedMps;
  const qPa = dynamicPressurePa(densityKgM3, speedMps);
  const changedBody = windState.bodyId !== null && windState.bodyId !== dominant.id;
  windState.bodyId = dominant.id;
  windState.altitudeKm = altitudeKm;
  windState.densityKgM3 = densityKgM3;
  windState.speedMps = speedMps;
  windState.qPa = qPa;
  windState.targetDb = windDb(qPa);
  // ⚠ A different body is a different atmosphere, reached by jumping rather
  // than by flying. Following across it would blend Venus into Mars.
  if (changedBody) resetWind();
  else follow();
}
