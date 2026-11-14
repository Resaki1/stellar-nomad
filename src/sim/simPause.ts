/**
 * One explicit pause signal for the simulation (M0.4 loading gate). The ship step, the sim
 * clock, the save play-time tick and the progress tickers respect it; rendering does not.
 */
const reasons = new Set<string>();

export function setSimPaused(on: boolean, reason: string): void {
  if (on) reasons.add(reason);
  else reasons.delete(reason);
}

export function isSimPaused(): boolean {
  return reasons.size > 0;
}
