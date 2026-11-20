import { INDUSTRY_TUNING } from "@/sim/industry/catalog";
import type { DroneFlightProfile, DroneRecord } from "@/sim/industry/types";

// The authority advances in one-second steps. Keep moving through an ordinary late
// snapshot, then taper prediction to a stop if the feed has gone quiet.
const SNAPSHOT_GRACE_S = 1.25;
const PREDICTION_BRAKE_S = 1.5;
const SMOOTHING_S = 0.1;
const MAX_CATCH_UP_RATE = 1.5;
const PHASE_ORDER = { outbound: 0, working: 1, returning: 2, idle: 3 };

function predictedLead(ageS: number): number {
  if (ageS <= SNAPSHOT_GRACE_S) return ageS;
  const t = Math.min(1, (ageS - SNAPSHOT_GRACE_S) / PREDICTION_BRAKE_S);
  return SNAPSHOT_GRACE_S + PREDICTION_BRAKE_S * t * (1 - t / 2);
}

export function smoothProgress(t: number): number {
  const p = Math.max(0, Math.min(1, t));
  return p * p * p * (p * (p * 6 - 15) + 10);
}

/** A visual clock for one round trip. It can lead the last countdown, up to its phase
 * boundary. Only a new authority record can open the next phase. */
export class DroneMotion {
  timeS = 0;
  legS = 0;
  workS = 0;
  via: DroneRecord["via"] = null;
  profile: DroneFlightProfile = "local";
  targetId: string | null = null;
  extracting = false;

  private snapshot: DroneRecord | null = null;
  private confirmedS = 0;
  private phaseEndS = 0;
  private filteredS = 0;
  private ageS = 0;

  advance(drone: DroneRecord, deltaS: number): void {
    const prev = this.snapshot;
    const newTrip = drone.phase !== "idle" && (!prev || PHASE_ORDER[drone.phase] < PHASE_ORDER[prev.phase]);
    const endOfTripS = 2 * this.legS + this.workS;
    // A batch may skip the idle record. Finish the acknowledged return before the next departure.
    if (newTrip && endOfTripS - this.timeS > 0.001) {
      this.phaseEndS = this.confirmedS = endOfTripS;
      this.step(deltaS);
      return;
    }
    if (newTrip) {
      this.legS = drone.returnS;
      this.extracting = drone.job?.kind === "extract";
      this.targetId = drone.job?.targetId ?? null;
      this.workS = this.extracting ? INDUSTRY_TUNING.extractSeconds : INDUSTRY_TUNING.deliverySeconds;
      this.via = drone.via;
      this.profile = drone.flight?.profile ?? "local";
      this.timeS = this.filteredS = 0;
    }

    if (!prev || prev.phase !== drone.phase || prev.remainingS !== drone.remainingS || prev.durationS !== drone.durationS) {
      const predictedS = this.confirmedS + predictedLead(this.ageS + deltaS);
      if (drone.phase === "working") this.workS = drone.durationS;
      const legS = this.legS;
      const returnStartS = legS + this.workS;
      const endS = returnStartS + legS;
      switch (drone.phase) {
        case "outbound": this.phaseEndS = legS; break;
        case "working": this.phaseEndS = returnStartS; break;
        case "returning":
        case "idle": this.phaseEndS = endS; break;
      }
      this.confirmedS = Math.max(0, this.phaseEndS - drone.remainingS);
      // A late countdown can confirm less than the rendered clock has already predicted.
      // Keep up to one second of progress within the phase so the next frame can keep moving.
      this.ageS = prev?.phase === drone.phase ? Math.max(0, Math.min(1, predictedS - this.confirmedS)) : 0;
      if (!prev) this.timeS = this.filteredS = this.confirmedS;
      this.snapshot = drone;
    } else {
      this.ageS += deltaS;
    }
    this.step(deltaS);
  }

  private step(deltaS: number): void {
    const goal = Math.min(this.phaseEndS, this.confirmedS + predictedLead(this.ageS));
    // Two stages absorb the timing correction without stepping either position or speed.
    const blend = -Math.expm1(-deltaS / SMOOTHING_S);
    this.filteredS += Math.min(Math.max(0, goal - this.filteredS) * blend, deltaS * MAX_CATCH_UP_RATE);
    this.timeS += Math.min((this.filteredS - this.timeS) * blend, deltaS * MAX_CATCH_UP_RATE);
    if (this.phaseEndS - this.timeS < 0.001) this.timeS = this.filteredS = this.phaseEndS;
  }
}
