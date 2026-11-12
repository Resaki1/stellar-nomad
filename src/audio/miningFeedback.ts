/** Short overlaps bridge the authored edge fades; startup still leads alone. */
export const CUTTER_HANDOFF_S = 0.08;
export const CUTTER_ATTACK_MS = 65;
export const CUTTER_RELEASE_MS = 140;

/** Gradual strain, with a steeper rise over the final quarter of heat capacity. */
export function cutterPitchCents(heat: number): number {
  const h = Number.isFinite(heat) ? Math.max(0, Math.min(1, heat)) : 0;
  return 110 * h + 240 * Math.max(0, (h - 0.75) / 0.25) ** 2;
}

export type TargetFeedback = {
  target: string | null;
  step: number;
  focused: boolean;
  mined: number;
  enabled: boolean;
};

/** Only a settled, completed lock deserves a lost-lock cue. Brief flyovers stay quiet. */
export function targetFeedbackCue(previous: TargetFeedback, next: TargetFeedback):
  "mining.target.acquire" | "mining.target.lock" | "mining.target.lost" | null {
  if (!next.enabled || !previous.enabled) return null;
  if (next.focused && (!previous.focused || next.target !== previous.target)) return "mining.target.lock";
  if (previous.focused && (!next.focused || next.target !== previous.target) && next.mined === previous.mined)
    return "mining.target.lost";
  if (next.target && !next.focused && next.step > 0 &&
      (next.target !== previous.target || next.step > previous.step)) return "mining.target.acquire";
  return null;
}
