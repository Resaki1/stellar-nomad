// ---------------------------------------------------------------------------
// ESCALATING ALERTS — invariant A12. docs/AUDIO_PLAN.md §4 / §6.3.
//
// ONE mechanism that every survival stat instantiates, rather than five
// bespoke alarm implementations.
//
// ⚠⚠ THE ANTI-FATIGUE LOGIC IS THE POINT, NOT THE TONES. The documented failure
// mode is shipped and specific: Subnautica plays one fixed low-oxygen line
// identically on every trigger, and players wrote mods purely to replace it with
// a progressive cue tied to the actual value. Five independently-written alarms
// become five independently-annoying alarms, and "the alarm is unbearable" is one
// of the top audio complaints in the genre (§3.4).
//
// So this module encodes four rules, and every stat gets them for free:
//
//   1. TIERS      — severity escalates with the value, and the PATTERN changes
//                   (advisory → caution → critical), not just the volume.
//   2. HYSTERESIS — a stat hovering on a threshold must not oscillate between
//                   tiers. Same asymmetric-threshold reasoning as the emitter
//                   cull in §5.3.
//   3. COOLDOWN   — once the player has heard it and has not fixed it, the
//                   reminder interval BACKS OFF. Repeating at a fixed rate is
//                   precisely the Subnautica failure.
//   4. ACKNOWLEDGE — the player can silence the current episode. It re-arms on
//                   recovery, or on escalation to a higher tier.
//
// Alarms route through the ceilinged `alerts` sub-bus (§8.3), so no alert can
// dominate the mix regardless of the master setting.
// ---------------------------------------------------------------------------

import { playAlarm, type AlarmTier } from "./alarms";

export type AlertId = string;

type TierSpec = {
  tier: AlarmTier;
  /**
   * Enter this tier when the normalised stat (0 = empty/critical, 1 = full) is
   * at or below this. Ordered most severe first when evaluated.
   */
  enterBelow: number;
  /**
   * Leave it only when the stat climbs back above this — strictly greater than
   * `enterBelow`, which is what stops threshold chatter.
   */
  exitAbove: number;
  /** First reminder gap, seconds. */
  repeatS: number;
  /**
   * Multiplier applied to the gap after each reminder, capped by `maxRepeatS`.
   *
   * 🔑 >1 ON PURPOSE. A fixed interval is the thing players hate: after the
   * third identical beep it carries no new information and becomes pure
   * irritation. Backing off keeps the state audible without nagging.
   */
  backoff: number;
  maxRepeatS: number;
};

/** Sensible default ladder. A stat may override it. */
export const DEFAULT_TIERS: readonly TierSpec[] = [
  { tier: "critical", enterBelow: 0.1, exitAbove: 0.16, repeatS: 4, backoff: 1.0, maxRepeatS: 4 },
  { tier: "caution", enterBelow: 0.25, exitAbove: 0.33, repeatS: 9, backoff: 1.6, maxRepeatS: 40 },
  { tier: "advisory", enterBelow: 0.45, exitAbove: 0.55, repeatS: 25, backoff: 2.0, maxRepeatS: 120 },
];

// ⚠ `critical` deliberately does NOT back off (backoff 1.0) and keeps a short
// fixed 4 s gap. Everything else backs off, but an unfixed critical state is the
// one case where continued nagging is correct — the player is about to die.

type AlertState = {
  id: AlertId;
  tiers: readonly TierSpec[];
  /** Index into `tiers`, or -1 when nothing is active. */
  activeTier: number;
  nextDueMs: number;
  currentGapS: number;
  acknowledged: boolean;
  lastValue: number;
};

const alerts = new Map<AlertId, AlertState>();

/** Register (or re-register) a stat. Idempotent, so a remount is harmless. */
export function registerAlert(
  id: AlertId,
  tiers: readonly TierSpec[] = DEFAULT_TIERS,
): void {
  const existing = alerts.get(id);
  if (existing) {
    existing.tiers = tiers;
    return;
  }
  alerts.set(id, {
    id,
    tiers,
    activeTier: -1,
    nextDueMs: 0,
    currentGapS: 0,
    acknowledged: false,
    lastValue: 1,
  });
}

export function unregisterAlert(id: AlertId): void {
  alerts.delete(id);
}

/**
 * Report a stat's current normalised value, 0..1 (0 = worst). Cheap; call it
 * from the audio tick or from a human-rate effect. All the scheduling lives
 * here, so callers hold no timers.
 */
export function updateAlert(id: AlertId, value01: number): void {
  const st = alerts.get(id);
  if (!st) return;
  const v = Math.max(0, Math.min(1, value01));
  st.lastValue = v;

  // Which tier should be active? Most severe first.
  let want = -1;
  for (let i = 0; i < st.tiers.length; i++) {
    if (v <= st.tiers[i].enterBelow) {
      want = i;
      break;
    }
  }

  // Hysteresis: hold the current tier until the value clears ITS exit level,
  // which sits above its entry level.
  if (st.activeTier >= 0 && want > st.activeTier) {
    const cur = st.tiers[st.activeTier];
    if (v < cur.exitAbove) want = st.activeTier;
  }
  if (st.activeTier >= 0 && want === -1) {
    const cur = st.tiers[st.activeTier];
    if (v < cur.exitAbove) want = st.activeTier;
  }

  const now = performance.now();

  if (want === -1) {
    // Recovered. Re-arm so the next episode is heard.
    st.activeTier = -1;
    st.acknowledged = false;
    return;
  }

  if (want !== st.activeTier) {
    // Entering a tier, or escalating. Escalation overrides an acknowledgement:
    // the player silenced a *lesser* problem, not this one.
    const escalating = want < st.activeTier || st.activeTier === -1;
    st.activeTier = want;
    st.currentGapS = st.tiers[want].repeatS;
    if (escalating) st.acknowledged = false;
    if (!st.acknowledged) {
      playAlarm(st.tiers[want].tier);
      st.nextDueMs = now + st.currentGapS * 1000;
    }
    return;
  }

  if (st.acknowledged) return;

  if (now >= st.nextDueMs) {
    const spec = st.tiers[st.activeTier];
    playAlarm(spec.tier);
    st.currentGapS = Math.min(spec.maxRepeatS, st.currentGapS * spec.backoff);
    st.nextDueMs = now + st.currentGapS * 1000;
  }
}

/**
 * Re-evaluate every registered alert against its LAST reported value, firing any
 * reminder that has come due. Called from the A5 audio tick.
 *
 * ⚠⚠ THIS EXISTS BECAUSE THE FIRST WIRING WAS BROKEN AND THE BUG WAS SILENT.
 * `updateAlert` was called only from a React effect on the stat's value, so a
 * player sitting at a steady 20% hull — value unchanged, therefore no effect,
 * therefore no call — would hear the first alarm and then NOTHING, forever. The
 * scheduling has to be driven by a clock, not by the value changing.
 *
 * Reporting the value stays with the caller; the schedule lives here.
 */
export function pumpAlerts(): void {
  for (const st of Array.from(alerts.values())) {
    // Re-running the same value is cheap and idempotent: tier selection is pure,
    // and the only side effect is a due reminder.
    updateAlert(st.id, st.lastValue);
  }
}

/**
 * Silence the current episode. Re-arms automatically on recovery or escalation.
 *
 * Nothing calls this yet — there is no acknowledge control in the HUD. It exists
 * because retrofitting acknowledgement into five separate alarm implementations
 * is exactly the cost A12 is here to avoid.
 */
export function acknowledgeAlert(id: AlertId): void {
  const st = alerts.get(id);
  if (st) st.acknowledged = true;
}

export function acknowledgeAllAlerts(): void {
  for (const st of Array.from(alerts.values())) st.acknowledged = true;
}

export type AlertSnapshot = {
  id: AlertId;
  value: number;
  tier: AlarmTier | "none";
  acknowledged: boolean;
  nextInS: number | null;
  gapS: number;
};

export function alertSnapshots(): AlertSnapshot[] {
  const now = performance.now();
  return Array.from(alerts.values()).map((st) => ({
    id: st.id,
    value: Math.round(st.lastValue * 1000) / 1000,
    tier: st.activeTier >= 0 ? st.tiers[st.activeTier].tier : "none",
    acknowledged: st.acknowledged,
    nextInS:
      st.activeTier >= 0 && !st.acknowledged
        ? Math.max(0, Math.round((st.nextDueMs - now) / 100) / 10)
        : null,
    gapS: Math.round(st.currentGapS * 10) / 10,
  }));
}
