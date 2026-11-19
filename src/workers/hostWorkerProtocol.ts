/** Messages between the host's main thread and the host worker (HostSession + IndexedDB). */
import type { Channel } from "@/sim/session/protocol";
import type { ConnId } from "@/sim/session/ports";
import type { PlayerId } from "@/save/types";

export type MainToHostWorker =
  | { t: "init"; worldId: string; hostPlayerId: PlayerId; hostName: string }
  | { t: "open"; conn: ConnId; local: boolean }
  | { t: "msg"; conn: ConnId; ch: Channel; msg: unknown }
  | { t: "pauseClock"; paused: boolean }
  | { t: "gone"; conn: ConnId }
  | { t: "close" }
  | { t: "inspect"; req: number; playerId?: PlayerId };

export type HostWorkerToMain =
  | { t: "players"; count: number }
  | { t: "ready"; gen: number; worldName: string; content: string }
  | { t: "error"; message: string }
  | { t: "send"; conn: ConnId; ch: Channel; msg: unknown }
  | { t: "drop"; conn: ConnId }
  | { t: "state"; state: string; detail?: string }
  | { t: "closed" }
  | { t: "inspect"; req: number; value: unknown };
