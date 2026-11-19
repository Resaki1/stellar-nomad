/**
 * Dev-only fault switches for the co-op gates, settable before any game module loads (the join
 * card runs at the title): `window.__coopFault = { signalingDown: true }`. Inert in production.
 */
export type CoopFault = "signalingDown" | "content" | "full";

export function devFault(k: CoopFault): boolean {
  if (process.env.NODE_ENV !== "development" || typeof window === "undefined") return false;
  return !!(window as { __coopFault?: Partial<Record<CoopFault, boolean>> }).__coopFault?.[k];
}

/** Dev-only delay faults (ms): `window.__coopFault = { hostStartDelayMs: 4000 }`. 0 in production. */
export type CoopDelayFault = "hostStartDelayMs" | "joinSnapshotDelayMs";

export function devFaultMs(k: CoopDelayFault): number {
  if (process.env.NODE_ENV !== "development" || typeof window === "undefined") return 0;
  const v = (window as { __coopFault?: Partial<Record<CoopDelayFault, unknown>> }).__coopFault?.[k];
  return typeof v === "number" && v > 0 ? Math.min(v, 30_000) : 0;
}
