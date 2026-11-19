/**
 * Co-op host authority in a worker: HostSession over the world's IndexedDB record, holding the
 * world's writer lock for the whole session. WebRTC cannot live here (Chrome), so the main
 * thread relays peer bytes in and out; the host's own client is connection "local".
 */
import { idbWorldRepository } from "@/save/sessionRepository";
import { HostSession } from "@/sim/session/hostSession";
import { contentFingerprint } from "@/sim/session/fingerprint";
import { systemClock } from "@/sim/session/ports";
import { activeSystem } from "@/sim/systemRegistry";
import type { HostWorkerToMain, MainToHostWorker } from "./hostWorkerProtocol";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const LOCK_WAIT_MS = 5000;
const TICK_MS = 1000;
const timings = { tickLateMs: [] as number[], writeMs: [] as number[] };

let host: HostSession | null = null;
let releaseLock: (() => void) | null = null;
let tick: ReturnType<typeof setInterval> | null = null;

const post = (m: HostWorkerToMain): void => scope.postMessage(m);

function acquireLock(worldId: string): Promise<boolean> {
  return new Promise((resolve) => {
    navigator.locks
      .request(`stellar-nomad-world:${worldId}`, { signal: AbortSignal.timeout(LOCK_WAIT_MS) }, () => {
        resolve(true);
        return new Promise<void>((r) => (releaseLock = r));
      })
      .catch(() => resolve(false));
  });
}

async function init(m: Extract<MainToHostWorker, { t: "init" }>): Promise<void> {
  if (!(await acquireLock(m.worldId))) return post({ t: "error", message: "world is open elsewhere" });
  const content = contentFingerprint(activeSystem());
  const h = new HostSession({
    repo: idbWorldRepository(m.worldId),
    transport: {
      send: (conn, ch, msg) => post({ t: "send", conn, ch, msg }),
      close: (conn) => post({ t: "drop", conn }),
    },
    clock: systemClock,
    hostPlayerId: m.hostPlayerId,
    hostName: m.hostName,
    system: activeSystem,
    content,
    onTiming: process.env.NODE_ENV === "development" ? (kind, ms) => {
      timings[kind].push(ms);
      if (timings[kind].length > 120) timings[kind].shift();
    } : undefined,
    onPlayerCount: (count) => post({ t: "players", count }),
    onState: (state, detail) => post({ t: "state", state, detail }),
  });
  try {
    await h.start();
  } catch (e) {
    releaseLock?.();
    return post({ t: "error", message: e instanceof Error ? e.message : String(e) });
  }
  host = h;
  tick = setInterval(() => h.tick(), TICK_MS);
  post({ t: "ready", gen: h.generation, worldName: h.record.meta.name, content });
}

async function close(): Promise<void> {
  if (tick) clearInterval(tick);
  await host?.close();
  host = null;
  releaseLock?.();
  releaseLock = null;
  post({ t: "closed" });
}

scope.onmessage = (ev: MessageEvent<MainToHostWorker>) => {
  const m = ev.data;
  switch (m.t) {
    case "init":
      void init(m);
      return;
    case "open":
      host?.connect(m.conn, { local: m.local });
      return;
    case "msg":
      host?.receive(m.conn, m.ch, m.msg);
      return;
    case "pauseClock":
      host?.setClockPaused(m.paused);
      return;
    case "gone":
      host?.disconnect(m.conn);
      return;
    case "close":
      void close();
      return;
    case "inspect": {
      const value = !host
        ? null
        : m.playerId
          ? structuredClone(host.player(m.playerId))
          : {
              gen: host.generation,
              status: host.status,
              timings,
              revision: host.world.revision,
              members: structuredClone(host.world.members),
              // "field:chunk:id" of every depleted rock (gates count and look up depletions).
              destroyed: Object.entries(host.world.asteroidDeltas).flatMap(([f, chunks]) =>
                Object.entries(chunks).flatMap(([c, ids]) => ids.map((id) => `${f}:${c}:${id >>> 0}`)),
              ),
            };
      post({ t: "inspect", req: m.req, value });
      return;
    }
  }
};
