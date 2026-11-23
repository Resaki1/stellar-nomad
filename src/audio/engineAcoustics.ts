// ---------------------------------------------------------------------------
// THE DRIVE, HEARD FROM INSIDE — docs/AUDIO_PLAN.md §6.10.
//
// Structure-borne layers (rumble, pumps, transients) play in vacuum and air.
// The jet's own noise reaches the hull only through air: its level comes from
// the jet's acoustic power and the ambient impedance, then goes through the
// wind bed's `windLevelDb` so jet and wind share one physical scale.
// ---------------------------------------------------------------------------

import { acousticsForBody } from "./acoustics";
import { audioShipBuffer } from "./shipBuffer";
import { playAudio } from "./voices";
import { WIND_RANGE_DB, windLevelDb } from "./wind";
import type { AtmosphereModel } from "@/sim/atmosphere";
import { atmoFuel, createAtmoFuel, createDrivePlume, drivePlume, type DrivePlume } from "@/sim/ship/atmoDrive";
import { getResourceTuning } from "@/sim/ship/resourceTuning";

/** Jet acoustic efficiency; rockets measure 0.2–1 %. */
export const JET_ACOUSTIC_EFFICIENCY = 0.005;
/** Effective source → cabin distance, m (noise centroid ~8 m aft of a 4 m bell). */
export const JET_SOURCE_DISTANCE_M = 12;
/** Forward-arc directivity: jet noise beams aft. */
export const JET_FORWARD_DIRECTIVITY_DB = -10;
/** Reference ship: 20 t at 120 m/s² full thrust (matches atmoDrive's plume constants). */
const FULL_THRUST_N = 20000 * 120;
const RHO_C_REF = 415;
/**
 * Jet noise is a propagating acoustic field; the wind bed's input is boundary-layer wall pressure,
 * which is convective and excites hull panels far less efficiently (wavenumber mismatch below
 * coincidence, typically ≥ 10 dB). Added before `windLevelDb` so both still share one scale.
 */
export const JET_ACOUSTIC_COUPLING_DB = 10;
/** Base pitch of the shock-cell loop, Hz (preset `ship.engine.shock`). */
export const SHOCK_BASE_HZ = 48;
/** Strouhal reference v_e/D at Earth sea level, full thrust (3.98 km/s over 1.09 m). */
const STROUHAL_REF = 3650;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Noise-source distance, m: the mixing region sits ~5 jet diameters aft, plus the ship. */
export function jetSourceDistanceM(jetDiaM: number): number {
  return Math.max(JET_SOURCE_DISTANCE_M, 4 + 5 * jetDiaM);
}

/**
 * Incident jet-noise SPL at the hull, dB re 20 µPa; −Infinity in vacuum or a collisionless beam.
 * Capped at p_rms = ½·p_amb: a linear sound wave cannot swing the air below vacuum.
 */
export function jetIncidentSplDb(m: AtmosphereModel | null, pl: DrivePlume, throttle: number): number {
  if (!m || !(pl.rhoAmb > 0) || !(throttle > 0)) return -Infinity;
  const continuum = 1 - pl.rarefied01;
  if (!(continuum > 1e-4)) return -Infinity;
  const wJet = 0.5 * FULL_THRUST_N * throttle * pl.veKmps * 1000;
  const lw = 10 * Math.log10((JET_ACOUSTIC_EFFICIENCY * wJet * continuum) / 1e-12);
  const r = jetSourceDistanceM(pl.jetDiaM);
  const spread = 10 * Math.log10(4 * Math.PI * r * r);
  const rhoC = pl.rhoAmb * m.surfaceSpeedOfSoundMps;
  const spl = lw - spread + JET_FORWARD_DIRECTIVITY_DB + 10 * Math.log10(rhoC / RHO_C_REF);
  return pl.pAmbPa > 0 ? Math.min(spl, 20 * Math.log10((0.5 * pl.pAmbPa) / 20e-6)) : spl;
}

/** Forward-arc shock-cell peak, Hz: f = U_c / (L_s(1 + M_c)), U_c = 0.7 v_e. */
export function shockCellHz(m: AtmosphereModel | null, pl: DrivePlume): number {
  if (!m || !(pl.cellLenM > 0)) return 0;
  const uc = 0.7 * pl.veKmps * 1000;
  return uc / (pl.cellLenM * (1 + uc / m.surfaceSpeedOfSoundMps));
}

/**
 * Weight of the shock-cell layer. Gated like the visible diamonds (not torch/rarefied/crushed,
 * p_e/p_a < 300), and scaled by shock strength: shock noise vanishes at ideal expansion and grows
 * steeply with mismatch (plausibility law ((p_e/p_a − 1)/4)², not a fitted BBSAN model).
 */
export function shockCellWeight(pl: DrivePlume): number {
  const strength = Math.min(1, ((Math.max(1, pl.peOverPa) - 1) / 4) ** 2);
  return strength * (1 - pl.torch01) * (1 - pl.rarefied01) * (1 - pl.crushed01) * (1 - smoothstep(30, 300, pl.peOverPa));
}

/** Pitch window the shock loop can honour: emitters clamp to ±1 oct of SHOCK_BASE_HZ. */
export function shockBandWeight(hz: number): number {
  return smoothstep(20, 26, hz) * (1 - smoothstep(88, 98, hz));
}

/**
 * Feed machinery pitch (cents) and level (0..1) from throttle and the reaction-mass flow ratio
 * (1/powerFrac: water pumps in thin air, intake compression in thick air). Load is logarithmic
 * in flow and saturates at 100× (+1 octave, +3 dB — kept under the roar).
 */
export function pumpVoice(throttle: number, flowRatio: number): { cents: number; level: number } {
  const t = Math.min(1, Math.max(0, throttle));
  const load = Math.min(1, Math.log10(Math.max(1, flowRatio)) / 2);
  const onset = smoothstep(0, 0.15, t);
  const cents = 1200 * Math.log2(0.5 + 0.5 * t) + 1200 * load;
  return { cents, level: onset * (0.35 + 0.15 * load) };
}

export const engineState = {
  bodyId: null as string | null,
  throttle: 0,
  splDb: -Infinity,
  /** Game level of the roar, dB in [−WIND_RANGE_DB, 0]. */
  roarDb: -WIND_RANGE_DB,
  roarCents: 0,
  shockHz: 0,
  shockWeight: 0,
  fuelMult: 1,
  pumpCents: 0,
  pumpLevel: 0,
  /** Thermal ticking rates, events/s (HEAT_SYSTEM_PLAN §4): bell pings and loop/hull ticks. */
  bellPingRate: 0,
  loopTickRate: 0,
  /** Coolant-loop bed level (0..1) and pitch, from the ship's heat store. */
  coolantLevel: 0,
  coolantCents: 0,
};

const plume = createDrivePlume();
const fuel = createAtmoFuel();

/** Game-dB → linear gain, 0 at the floor (exactly silent so the emitter culls). */
export function levelGain(db: number): number {
  return db > -WIND_RANGE_DB ? 10 ** (Math.min(0, db) / 20) : 0;
}

// ── Transients (clock-driven on the tick, like pumpAlerts) ─────────────────
const IGNITE_ON = 0.05;
const CUTOFF_OFF = 0.02;
/** Ticks per kelvin/s of node temperature change (thermoelastic slip ∝ |dT/dt|, both signs). */
const BELL_PINGS_PER_KPS = 0.12;
const LOOP_TICKS_PER_KPS = 0.25;
/** Below this the bells are near their idle equilibrium: no pings from slow drift. */
const BELL_PING_MIN_K = 420;
let burning = false;
let burnS = 0;
let lastMs = 0;

/** Bell pings and loop ticks follow the thermal network's |dT/dt| (HEAT_SYSTEM_PLAN §4). */
export function thermalTickRates(bellK: number, bellRateKps: number, loopRateKps: number): { bell: number; loop: number } {
  const bell = bellK > BELL_PING_MIN_K ? Math.min(5, BELL_PINGS_PER_KPS * Math.abs(bellRateKps)) : 0;
  const loop = Math.min(3, LOOP_TICKS_PER_KPS * Math.abs(loopRateKps));
  return { bell, loop };
}

/** Coolant pumps run up with the heat store; silent when the loop is idle (coasting stays silent). */
export function coolantVoice(heat01: number): { level: number; cents: number } {
  const h = Math.max(0, Math.min(1.3, heat01));
  return { level: h > 0.01 ? 0.2 + 0.8 * Math.min(1, h) : 0, cents: 500 * Math.min(1, h) };
}

/** Reset edges and heat after a respawn/teleport. */
export function resetEngineTransients(): void {
  burning = audioShipBuffer.thrustCmd > IGNITE_ON;
  burnS = 0;
  lastMs = 0;
}

let transientsEnabled = true;
/** Off while dead or paused in settings; `GameAudioTriggers` owns this. */
export function setEngineTransientsEnabled(on: boolean): void {
  transientsEnabled = on;
  if (!on) resetEngineTransients();
}

/** Recompute once per audio tick, before the emitters read it. */
export function updateEngineAcoustics(): void {
  const now = performance.now();
  const dt = lastMs === 0 ? 0 : Math.min(0.5, (now - lastMs) / 1000);
  lastMs = now;
  const throttle = audioShipBuffer.throttle;
  const bodyId = audioShipBuffer.atmoBodyId;
  const m = bodyId ? acousticsForBody(bodyId) : null;
  const alt = audioShipBuffer.altitudeKm;
  const tuning = getResourceTuning();
  drivePlume(m, alt, throttle, tuning, plume);
  atmoFuel(m, alt, audioShipBuffer.airspeedMps, throttle * 120, 1 / 15, tuning, fuel);
  engineState.bodyId = bodyId;
  engineState.throttle = throttle;
  engineState.splDb = jetIncidentSplDb(m, plume, throttle);
  engineState.roarDb = windLevelDb(engineState.splDb + JET_ACOUSTIC_COUPLING_DB);
  const st = plume.jetDiaM > 0 ? (plume.veKmps * 1000) / plume.jetDiaM : STROUHAL_REF;
  engineState.roarCents = Math.max(-700, Math.min(700, 1200 * Math.log2(st / STROUHAL_REF)));
  engineState.shockHz = shockCellHz(m, plume);
  // Below ~20 Hz it is infrasound (felt, not heard); above ~96 Hz the loop can't follow (emitter
  // pitch clamp ±1 oct). Fade rather than play a mis-pitched hum.
  engineState.shockWeight = m && throttle > 0 ? shockCellWeight(plume) * shockBandWeight(engineState.shockHz) : 0;
  engineState.fuelMult = fuel.fuelMult;
  const pump = pumpVoice(throttle, 1 / Math.max(1e-6, fuel.powerFrac));
  engineState.pumpCents = pump.cents;
  engineState.pumpLevel = pump.level;
  const ticks = thermalTickRates(audioShipBuffer.bellK, audioShipBuffer.bellRateKps, audioShipBuffer.loopRateKps);
  engineState.bellPingRate = ticks.bell;
  engineState.loopTickRate = ticks.loop;
  const coolant = coolantVoice(audioShipBuffer.heat01);
  engineState.coolantLevel = coolant.level;
  engineState.coolantCents = coolant.cents;

  if (!transientsEnabled || dt === 0) return;
  // Edges on the UNSMOOTHED command: the smoothed throttle lags cutoff by ~0.8 s.
  const cmd = audioShipBuffer.thrustCmd;
  if (!burning && cmd > IGNITE_ON) {
    burning = true;
    burnS = 0;
    playAudio("ship.engine.ignite", { queueOnUnlock: false, gainDb: -6 + 6 * Math.min(1, cmd) });
  } else if (burning) {
    burnS += dt;
    if (cmd < CUTOFF_OFF) {
      burning = false;
      if (burnS > 0.4) playAudio("ship.engine.cutoff", { queueOnUnlock: false });
    }
  }
  // Thermal ticks: Poisson, rate from the network's |dT/dt| (at most one per source per tick).
  const bellRate = Math.abs(audioShipBuffer.bellRateKps);
  if (Math.random() < 1 - Math.exp(-ticks.bell * dt)) playAudio("ship.bell.ping", {
    queueOnUnlock: false,
    gainDb: -6 + 6 * Math.min(1, bellRate / 30),
    pitchCents: (Math.random() - 0.5) * 1000,
  });
  if (Math.random() < 1 - Math.exp(-ticks.loop * dt)) playAudio("ship.hull.tick", {
    queueOnUnlock: false,
    gainDb: -4 + 4 * Math.min(1, Math.abs(audioShipBuffer.loopRateKps) / 8),
    pitchCents: (Math.random() - 0.5) * 900,
  });
}

if (process.env.NODE_ENV === "development" && typeof globalThis !== "undefined") {
  (globalThis as { __engineAudio?: typeof engineState }).__engineAudio = engineState;
}
