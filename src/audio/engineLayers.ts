/** Linear crossfade for correlated, phase-aligned idle/mid/high engine beds. */
export function engineLayerGain(layer: 0 | 1 | 2, throttle: number): number {
  const t = Number.isFinite(throttle) ? Math.max(0, Math.min(1, throttle)) : 0;
  // Smooth audibility onset, then full body under meaningful load. Exactly zero
  // at zero demand: no artificial idle hum while coasting through vacuum.
  const onset = Math.min(1, t / 0.15);
  const level = onset * onset * (3 - 2 * onset);
  return Math.max(0, 1 - Math.abs(t * 2 - layer)) * level;
}
