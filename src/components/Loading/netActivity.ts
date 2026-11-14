/**
 * Network-quiet tracking shared by the loading gate and `__test.settled()`. Installed
 * when the game chunk evaluates, i.e. before the game issues its first request.
 */
export const net = { inFlight: 0, lastActivityAt: 0, installed: false };

export function installNetworkTracking(): void {
  if (net.installed || typeof window === "undefined") return;
  net.installed = true;
  // fetch covers KTX2/GLTF/audio (three's FileLoader uses fetch); the observer
  // also catches <img>-based loads, which never go through fetch.
  const orig = window.fetch.bind(window);
  window.fetch = (async (...args: Parameters<typeof fetch>) => {
    net.inFlight++;
    net.lastActivityAt = performance.now();
    try {
      return await orig(...args);
    } finally {
      net.inFlight--;
      net.lastActivityAt = performance.now();
    }
  }) as typeof fetch;
  try {
    new PerformanceObserver(() => {
      net.lastActivityAt = performance.now();
    }).observe({ type: "resource", buffered: false });
  } catch {
    /* observer unsupported — fetch tracking still works */
  }
}

export function networkQuiet(quietMs: number): boolean {
  return net.inFlight === 0 && performance.now() - net.lastActivityAt >= quietMs;
}
