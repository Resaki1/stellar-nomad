import type { Channel } from "@/sim/session/protocol";

/**
 * Test fault: messages arriving within a held window are delivered, in order, when it ends (a
 * latency spike). The co-op race gate uses it so both pilots' claims reach the host.
 */
export function createIncomingDelay(deliver: (ch: Channel, msg: unknown) => void) {
  let until = 0;
  const queue: [Channel, unknown][] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    timer = null;
    const wait = until - performance.now();
    if (wait > 0) {
      timer = setTimeout(flush, wait);
      return;
    }
    while (queue.length) {
      const [ch, msg] = queue.shift()!;
      deliver(ch, msg);
    }
  };
  return {
    hold(ms: number): void {
      until = performance.now() + ms;
    },
    receive(ch: Channel, msg: unknown): void {
      if (performance.now() >= until && queue.length === 0) return deliver(ch, msg);
      queue.push([ch, msg]);
      timer ??= setTimeout(flush, Math.max(0, until - performance.now()));
    },
  };
}
