/**
 * In-process transport for the headless transcript, with fault injection: delay, drop the next
 * matching message to a client, duplicate the next message to the host, disconnect, inject raw.
 * Every message is JSON round-tripped, as on the wire.
 */
import type { Channel } from "./protocol";
import type { ClientLink, ConnId, HostTransport } from "./ports";

export interface HostEndpoint {
  connect(conn: ConnId, info: { local: boolean }): void;
  receive(conn: ConnId, channel: Channel, raw: unknown): void;
  disconnect(conn: ConnId): void;
}

export interface ClientEndpoint {
  opened(): void;
  receive(channel: Channel, raw: unknown): void;
  closed(): void;
}

interface Conn {
  id: ConnId;
  client: ClientEndpoint;
  open: boolean;
  local: boolean;
}

type Pred = (msg: Record<string, unknown>) => boolean;

export class MemoryNetwork {
  private host: HostEndpoint | null = null;
  private readonly conns = new Map<ConnId, Conn>();
  private nextId = 0;
  private inFlight = 0;
  private readonly drops = new Map<ConnId, Pred[]>();
  private readonly dupes = new Set<ConnId>();
  delayMs: number;
  /** Every message delivered to a client, for assertions: [conn, msg]. */
  readonly toClientLog: [ConnId, Record<string, unknown>][] = [];
  dropped = 0;

  constructor(opts: { delayMs?: number } = {}) {
    this.delayMs = opts.delayMs ?? 0;
  }

  /** (Re)attach a host; a restart closes every connection to the previous one. */
  attachHost(host: HostEndpoint): HostTransport {
    Array.from(this.conns.values()).forEach((c) => this.drop(c));
    this.host = host;
    return {
      send: (conn, channel, msg) => this.toClient(conn, channel, msg),
      close: (conn) => {
        const c = this.conns.get(conn);
        if (c) this.drop(c);
      },
    };
  }

  detachHost(): void {
    Array.from(this.conns.values()).forEach((c) => this.drop(c));
    this.host = null;
  }

  /** Open a connection to the attached host. Returns null when no host is attached (unreachable). */
  connect(client: ClientEndpoint, opts: { local?: boolean } = {}): { conn: ConnId; link: ClientLink } | null {
    const host = this.host;
    if (!host) return null;
    const c: Conn = { id: `c${++this.nextId}`, client, open: true, local: !!opts.local };
    this.conns.set(c.id, c);
    this.later(() => {
      if (!c.open || this.host !== host) return;
      host.connect(c.id, { local: c.local });
      c.client.opened();
    });
    return {
      conn: c.id,
      link: {
        send: (channel, msg) => this.toHost(c, channel, msg),
        close: () => this.drop(c),
      },
    };
  }

  /** Close a connection on both sides (network failure). */
  disconnect(conn: ConnId): void {
    const c = this.conns.get(conn);
    if (c) this.drop(c);
  }

  dropNextToClient(conn: ConnId, pred: Pred): void {
    const list = this.drops.get(conn) ?? [];
    list.push(pred);
    this.drops.set(conn, list);
  }

  duplicateNextToHost(conn: ConnId): void {
    this.dupes.add(conn);
  }

  /** Deliver a raw message to the host as if `conn` sent it (stale or forged packets). */
  injectToHost(conn: ConnId, channel: Channel, msg: unknown): void {
    const host = this.host;
    const wire = JSON.stringify(msg);
    this.later(() => host?.receive(conn, channel, JSON.parse(wire)));
  }

  /** Resolves once nothing is in flight for a few consecutive turns (host commits are async). */
  async settle(maxTurns = 10_000): Promise<void> {
    let quiet = 0;
    for (let i = 0; i < maxTurns && quiet < 4; i++) {
      await new Promise<void>((r) => setTimeout(r, 0));
      quiet = this.inFlight === 0 ? quiet + 1 : 0;
    }
  }

  private drop(c: Conn): void {
    if (!c.open) return;
    c.open = false;
    this.conns.delete(c.id);
    const host = this.host;
    this.later(() => {
      host?.disconnect(c.id);
      c.client.closed();
    });
  }

  private toHost(c: Conn, channel: Channel, msg: unknown): void {
    if (!c.open) return;
    const host = this.host;
    const wire = JSON.stringify(msg);
    const n = this.dupes.delete(c.id) ? 2 : 1;
    for (let i = 0; i < n; i++) {
      this.later(() => {
        if (c.open && this.host === host) host?.receive(c.id, channel, JSON.parse(wire));
      });
    }
  }

  private toClient(conn: ConnId, channel: Channel, msg: unknown): void {
    const c = this.conns.get(conn);
    if (!c || !c.open) return;
    const obj = JSON.parse(JSON.stringify(msg)) as Record<string, unknown>;
    const preds = this.drops.get(conn);
    const hit = preds?.findIndex((p) => p(obj)) ?? -1;
    if (preds && hit >= 0) {
      preds.splice(hit, 1);
      this.dropped++;
      return;
    }
    this.later(() => {
      if (!c.open) return;
      this.toClientLog.push([conn, obj]);
      c.client.receive(channel, obj);
    });
  }

  private later(fn: () => void): void {
    this.inFlight++;
    setTimeout(() => {
      this.inFlight--;
      fn();
    }, this.delayMs);
  }
}
