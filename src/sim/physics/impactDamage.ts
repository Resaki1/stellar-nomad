/**
 * Impact damage (docs/PHYSICS_PLAN.md §7.3): a pure curve of the ship's velocity change along the
 * contact normal, and the tracker that folds one hit's contact events into one impact.
 */
import type { PhysicsTuning } from "./physicsTuning";

type Curve = Pick<PhysicsTuning, "noDamageSpeedMps" | "lethalSpeedMps" | "damageExponent">;

/** Fraction of max hull removed by one impact of Δv `dvMps`, 0..1. */
export function impactDamageFraction(dvMps: number, t: Readonly<Curve>): number {
  if (!(dvMps > t.noDamageSpeedMps)) return 0;
  const x = (dvMps - t.noDamageSpeedMps) / (t.lethalSpeedMps - t.noDamageSpeedMps);
  return Math.min(1, Math.pow(x, t.damageExponent));
}

/** Hull points removed. `difficultyMult` is the M3 seam (1 until difficulty exists). */
export function impactDamageHp(
  im: Readonly<Pick<Impact, "dvMps" | "prevDvMps">>,
  t: Readonly<Curve>,
  maxHealth: number,
  collisionDamageMult: number,
  difficultyMult = 1,
): number {
  return impactDamageFractionOf(im, t) * maxHealth * collisionDamageMult * difficultyMult;
}

/** One contact as the tracker needs it (a NearFieldContact satisfies this). */
export interface ImpactContactInput {
  colliderId: number;
  nx: number; ny: number; nz: number;
  dvNormalMps: number;
  impulseNs: number;
  hasPoint: boolean;
  /** Contact point, km, in frame `frameId` (the near field's at the time of the step). */
  pxKm: number; pyKm: number; pzKm: number;
  frameId: string;
}

export interface Impact {
  /** Peak per-step Δv along the normal over the impact window, m/s. */
  dvMps: number;
  /** Peak already charged earlier in the same contact episode (0 for a fresh hit): damage is the difference. */
  prevDvMps: number;
  colliderId: number;
  nx: number; ny: number; nz: number;
  hasPoint: boolean;
  pxKm: number; pyKm: number; pzKm: number;
  frameId: string;
  /** Contact events folded into this impact. */
  contacts: number;
  /** Serial of the step that opened it. */
  firstStep: number;
}

const POOL = 16;

function mkImpact(): Impact {
  return { dvMps: 0, prevDvMps: 0, colliderId: 0, nx: 0, ny: 0, nz: 0, hasPoint: false, pxKm: 0, pyKm: 0, pzKm: 0, frameId: "", contacts: 0, firstStep: 0 };
}

/** Damage fraction of an impact: curve(peak) − curve(peak already charged in this episode). */
export function impactDamageFractionOf(im: Readonly<Pick<Impact, "dvMps" | "prevDvMps">>, t: Readonly<Curve>): number {
  return Math.max(0, impactDamageFraction(im.dvMps, t) - impactDamageFraction(im.prevDvMps, t));
}

/**
 * Feed every step's contacts; finished impacts come out of `drain`. A step's Δv opens an impact
 * only above `impactMinSpeedMps`; contacts within `impactWindowS` fold into it (peak Δv). Until
 * contact has stopped for `impactEpisodeGapS`, a later window only emits if it beats the charged
 * peak, so scrapes and pogo re-contacts total curve(peak) with no repeated feedback.
 */
export class ImpactTracker {
  private open = false;
  private openedAt = 0;
  private episode = false;
  private episodeCollider = 0;
  private lastContactStep = 0;
  private charged = 0;
  private readonly cur = mkImpact();
  private readonly done: Impact[] = [];
  private doneLen = 0;
  readonly counters = { contactEvents: 0, impacts: 0, droppedImpacts: 0 };

  constructor() {
    for (let i = 0; i < POOL; i++) this.done.push(mkImpact());
  }

  /** One contact of step `serial` (call for each, then `endStep`). */
  contact(c: Readonly<ImpactContactInput>, serial: number, t: Readonly<PhysicsTuning>): void {
    // A solved CCD/penetrating contact can report zero impulse while it still changed the velocity.
    if (c.impulseNs <= 0 && !(c.dvNormalMps > 0)) return;
    this.counters.contactEvents++;
    this.lastContactStep = serial;
    const cur = this.cur;
    if (!this.open) {
      if (c.dvNormalMps < t.impactMinSpeedMps) return;
      if (this.episode && c.colliderId !== this.episodeCollider) this.episode = false;
      if (!this.episode) this.charged = 0;
      else if (c.dvNormalMps <= this.charged) return;
      this.open = true;
      this.openedAt = serial;
      cur.dvMps = -Infinity;
      cur.contacts = 0;
      cur.firstStep = serial;
    }
    cur.contacts++;
    if (c.dvNormalMps > cur.dvMps) {
      cur.dvMps = c.dvNormalMps;
      cur.colliderId = c.colliderId;
      cur.nx = c.nx; cur.ny = c.ny; cur.nz = c.nz;
      cur.hasPoint = c.hasPoint;
      cur.pxKm = c.pxKm; cur.pyKm = c.pyKm; cur.pzKm = c.pzKm;
      cur.frameId = c.frameId;
    }
  }

  /** Close the window once `impactWindowS` has passed since the opening step. */
  endStep(serial: number, dt: number, t: Readonly<PhysicsTuning>): void {
    if (this.open) {
      if ((serial - this.openedAt + 1) * dt >= t.impactWindowS) this.flush();
    } else if (this.episode && (serial - this.lastContactStep) * dt >= t.impactEpisodeGapS) {
      this.episode = false;
    }
  }

  /** Finish an open impact now (death, teleport, end of a script). */
  flush(): void {
    if (!this.open) return;
    this.open = false;
    this.cur.prevDvMps = this.charged;
    this.charged = Math.max(this.charged, this.cur.dvMps);
    this.episode = true;
    this.episodeCollider = this.cur.colliderId;
    this.counters.impacts++;
    if (this.doneLen >= this.done.length) {
      this.counters.droppedImpacts++;
      return;
    }
    Object.assign(this.done[this.doneLen++], this.cur);
  }

  drain(f: (i: Readonly<Impact>) => void): number {
    const n = this.doneLen;
    for (let i = 0; i < n; i++) f(this.done[i]);
    this.doneLen = 0;
    return n;
  }

  reset(): void {
    this.open = false;
    this.episode = false;
    this.charged = 0;
    this.doneLen = 0;
  }
}

export interface ImpactLogEntry {
  t: number;
  dvMps: number;
  damageFrac: number;
  damageHp: number;
  healthAfter: number;
  contacts: number;
  colliderId: number;
  fatal: boolean;
}

/** The live game's last impacts (harness). */
export const impactLog: ImpactLogEntry[] = [];
export const liveImpactCounters = { impacts: 0, damageApplications: 0 };

export function logImpact(e: ImpactLogEntry): void {
  liveImpactCounters.impacts++;
  if (e.damageHp > 0) liveImpactCounters.damageApplications++;
  impactLog.push(e);
  if (impactLog.length > 64) impactLog.shift();
}
