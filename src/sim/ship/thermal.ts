// ---------------------------------------------------------------------------
// THE SHIP'S THERMAL NETWORK — docs/HEAT_SYSTEM_PLAN.md §3.
//
// Two nodes: the drive bells (one temperature; both bells see the same thrust)
// and the coolant loop. The loop IS `heat01`: its gameplay law is unchanged, and
// its temperature is DERIVED from what the radiators reject (Stefan–Boltzmann on
// the ventral radiator skin), so balance stays bit-identical except for the bells'
// conducted heat. The bells shed their plasma load mostly by glowing.
// Pure; no allocation; runs headless (sim-core rules).
// ---------------------------------------------------------------------------

import type { ResourceTuning } from "./resourceTuning";

const SIGMA = 5.670374e-8;

export const THERMAL = {
  /** Bell radiating area, both faces of one 0.91 m bell, m². */
  bellAreaM2: 3,
  bellEmissivity: 0.85,
  /** Heat capacity per bell, kJ/K (≈ 10 kg of C-C at hot c; a tuning knob — times scale with it). */
  bellCapKJPerK: 15,
  /** Plasma load absorbed per bell at full vacuum thrust, kW → 1,400 K equilibrium on 3 m². */
  bellFullKW: 556,
  /** Share of the plasma load at low exhaust velocity (cool, dense air-mode jet). */
  bellAirLoadFrac: 0.3,
  /** Conductance bell → coolant loop, W/K per bell (≈ 14 kW at 1,400 K vs a 550 K loop). */
  bellToLoopWPerK: 16.5,
  /** Forced-convection film coefficient at sea-level density, still air, W/m²K. */
  bellConvWPerM2K: 30,
  /** Ventral radiator skin, both wings, m² (build.py wings(): ~11 m² per side). */
  radiatorAreaM2: 22,
  radiatorEmissivity: 0.85,
  /** Deep-space sink, K. */
  spaceK: 3,
} as const;

/** Heat into the loop by source, kW, last step (attribution for HUD / audio / visuals). */
export type HeatSources = {
  mining: number;
  boost: number;
  processing: number;
  repair: number;
  transit: number;
  overdrive: number;
  bells: number;
};

export type ThermalState = {
  /** Drive bell temperature, K. */
  bellK: number;
  /** Its rate of change, K/s (signed). Thermal ticking follows |dT/dt|. */
  bellRateKps: number;
  /** Coolant loop / radiator temperature derived from rejection, K. */
  loopK: number;
  loopRateKps: number;
  /** Heat the bells conduct into the loop, kW (both bells). */
  bellToLoopKW: number;
  sources: HeatSources;
};

export function createHeatSources(): HeatSources {
  return { mining: 0, boost: 0, processing: 0, repair: 0, transit: 0, overdrive: 0, bells: 0 };
}

/** A cold ship at rest in vacuum: loop at its h = 0 temperature, bells at their idle equilibrium. */
export function createThermal(t: Readonly<ResourceTuning>): ThermalState {
  const loopK = radiatorTempK(t.radiatorBaseKW, 1);
  return { bellK: idleBellK(loopK), bellRateKps: 0, loopK, loopRateKps: 0, bellToLoopKW: 0, sources: createHeatSources() };
}

/** Unloaded bell in vacuum: warmed by the loop, radiating to space (bisection, ~360 K). */
export function idleBellK(loopK: number): number {
  let lo: number = THERMAL.spaceK, hi = loopK;
  for (let i = 0; i < 40; i++) {
    const T = (lo + hi) / 2;
    const net = THERMAL.bellToLoopWPerK * (loopK - T) - THERMAL.bellEmissivity * SIGMA * THERMAL.bellAreaM2 * (T ** 4 - THERMAL.spaceK ** 4);
    if (net > 0) lo = T; else hi = T;
  }
  return (lo + hi) / 2;
}

/** Radiator temperature that rejects `rejKW` (Stefan–Boltzmann, deep-space sink). */
export function radiatorTempK(rejKW: number, coolingMult: number): number {
  // Better radiators (coolingMult) are more AREA, not a hotter loop.
  const area = THERMAL.radiatorAreaM2 * Math.max(1e-3, coolingMult);
  return Math.pow(Math.max(0, rejKW) * 1000 / (THERMAL.radiatorEmissivity * SIGMA * area) + THERMAL.spaceK ** 4, 0.25);
}

/** Loop temperature for a heat store `h` (the radiator law's rejection at that state). */
export function loopTempK(h: number, t: Readonly<ResourceTuning>): number {
  return radiatorTempK(t.radiatorBaseKW + t.radiatorPerHeatKW * Math.max(0, h), 1);
}

function smoothstep(a: number, b: number, x: number): number {
  const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return u * u * (3 - 2 * u);
}

/**
 * Advance the bells one step. Returns the heat they conduct into the loop, kW (both bells).
 * `throttle` main-drive thrust 0..1; `veKmps` exhaust velocity (plasma load falls in air);
 * `rhoKgM3`/`airspeedMps`/`airK` the surrounding air (0 / any / any in vacuum).
 */
export function stepBells(
  th: ThermalState,
  throttle: number,
  veKmps: number,
  rhoKgM3: number,
  airspeedMps: number,
  airK: number,
  loopK: number,
  dt: number,
): number {
  if (!(dt > 0)) return 0;
  // A non-finite input would poison bellK for good (and heat01 through the return): sanitise.
  if (!Number.isFinite(th.bellK)) th.bellK = idleBellK(loopK);
  if (!Number.isFinite(throttle)) throttle = 0;
  if (!Number.isFinite(veKmps)) veKmps = 0;
  if (!Number.isFinite(rhoKgM3)) rhoKgM3 = 0;
  const T = th.bellK;
  const plasma = smoothstep(6, 30, veKmps);
  const loadW = THERMAL.bellFullKW * 1000 * Math.min(1, Math.max(0, throttle))
    * (THERMAL.bellAirLoadFrac + (1 - THERMAL.bellAirLoadFrac) * plasma);
  const envK = rhoKgM3 > 0 ? airK : THERMAL.spaceK;
  const radW = THERMAL.bellEmissivity * SIGMA * THERMAL.bellAreaM2 * (T ** 4 - envK ** 4);
  // Film coefficient ∝ √(ρ·v) for forced convection, floored at a still-air value.
  const h = rhoKgM3 > 0 ? THERMAL.bellConvWPerM2K * Math.sqrt(rhoKgM3 / 1.225) * Math.sqrt(1 + Math.max(0, airspeedMps) / 50) : 0;
  const convW = h * THERMAL.bellAreaM2 * (T - airK);
  const condW = THERMAL.bellToLoopWPerK * (T - loopK);
  const dTdt = (loadW - radW - convW - condW) / (THERMAL.bellCapKJPerK * 1000);
  // Never step below the environment (only reachable at absurd dt).
  const next = Math.max(envK, T + dTdt * dt);
  th.bellRateKps = (next - T) / dt;
  th.bellK = next;
  return (2 * condW) / 1000;
}

/** Record the loop temperature for heat01 `h` and its rate. */
export function updateLoop(th: ThermalState, h: number, t: Readonly<ResourceTuning>, dt: number): void {
  const k = loopTempK(h, t);
  th.loopRateKps = dt > 0 ? (k - th.loopK) / dt : 0;
  th.loopK = k;
}
