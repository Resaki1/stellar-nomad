/**
 * One RTCPeerConnection per guest (star). Two channels: `cmd` reliable+ordered, `pose`
 * unordered with no retransmits. SDP is exchanged whole after ICE gathering (no trickle):
 * one round trip through signaling, and LAN/host candidates gather in well under a second.
 */
import type { Channel } from "@/sim/session/protocol";

const GATHER_TIMEOUT_MS = 8000;
const OPEN_TIMEOUT_MS = 15_000;
// Local prototype rooms gather only host candidates. Hosted rooms supply short-lived ICE credentials.
const RTC_CONFIG: RTCConfiguration = { iceServers: [] };

function peerConnection(config: RTCConfiguration): RTCPeerConnection {
  // The two-browser regression can use an ephemeral loopback TURN service.
  const fixture = process.env.NODE_ENV === "development"
    ? (window as { __coopTestIce?: RTCConfiguration }).__coopTestIce : undefined;
  const settings = fixture ?? config;
  const forceRelay = new URLSearchParams(window.location.search).get("coopRelay") === "1" ||
    (process.env.NODE_ENV === "development" && (window as { __coopForceRelay?: boolean }).__coopForceRelay);
  return new RTCPeerConnection(forceRelay ? { ...settings, iceTransportPolicy: "relay" } : settings);
}

export interface PeerLink {
  send(channel: Channel, msg: unknown): void;
  route(): Promise<string | null>;
  close(): void;
  onMessage: ((channel: Channel, msg: unknown) => void) | null;
  onClose: (() => void) | null;
}

function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, GATHER_TIMEOUT_MS);
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(t);
        resolve();
      }
    });
  });
}

function link(pc: RTCPeerConnection, cmd: RTCDataChannel, pose: RTCDataChannel): PeerLink {
  let closed = false;
  const l: PeerLink = {
    onMessage: null,
    onClose: null,
    send(channel, msg) {
      const ch = channel === "pose" ? pose : cmd;
      if (ch.readyState === "open") ch.send(JSON.stringify(msg));
    },
    async route() {
      const stats = await pc.getStats();
      const transport = Array.from(stats.values()).find(s => s.type === "transport" && s.selectedCandidatePairId);
      const pair = transport && stats.get(transport.selectedCandidatePairId);
      if (!pair) return null;
      return [pair.localCandidateId, pair.remoteCandidateId].some(id => stats.get(id)?.candidateType === "relay") ? "relay" : "direct";
    },
    close() {
      if (closed) return;
      closed = true;
      pc.close();
      l.onClose?.();
    },
  };
  const recv = (channel: Channel) => (ev: MessageEvent) => {
    if (typeof ev.data !== "string") return;
    let msg: unknown;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    l.onMessage?.(channel, msg);
  };
  cmd.onmessage = recv("cmd");
  pose.onmessage = recv("pose");
  cmd.onclose = () => l.close();
  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") l.close();
  });
  return l;
}

function bothOpen(cmd: RTCDataChannel, pose: RTCDataChannel): Promise<void> {
  const one = (ch: RTCDataChannel) =>
    ch.readyState === "open" ? Promise.resolve() : new Promise<void>((res) => ch.addEventListener("open", () => res(), { once: true }));
  return Promise.race([
    Promise.all([one(cmd), one(pose)]).then(() => {}),
    new Promise<void>((_, rej) => setTimeout(() => rej(new Error("peer did not open")), OPEN_TIMEOUT_MS)),
  ]);
}

/** Host side: make the offer; `accept(answer)` resolves with an open link. */
export async function hostOffer(config: RTCConfiguration = RTC_CONFIG): Promise<{ sdp: string; accept: (answer: string) => Promise<PeerLink>; abort: () => void }> {
  const pc = peerConnection(config);
  const cmd = pc.createDataChannel("cmd", { ordered: true });
  const pose = pc.createDataChannel("pose", { ordered: false, maxRetransmits: 0 });
  try {
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
  } catch (error) {
    pc.close();
    throw error;
  }
  return {
    sdp: pc.localDescription?.sdp ?? "",
    async accept(answer) {
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
      await bothOpen(cmd, pose);
      return link(pc, cmd, pose);
    },
    abort: () => pc.close(),
  };
}

/** Guest side: answer an offer; `open` resolves once both channels are up. */
export async function guestAnswer(offer: string, config: RTCConfiguration = RTC_CONFIG): Promise<{ sdp: string; open: Promise<PeerLink>; abort: () => void }> {
  const pc = peerConnection(config);
  const chans = new Map<string, RTCDataChannel>();
  const got = new Promise<void>((resolve) => {
    pc.ondatachannel = (ev) => {
      chans.set(ev.channel.label, ev.channel);
      if (chans.has("cmd") && chans.has("pose")) resolve();
    };
  });
  try {
    await pc.setRemoteDescription({ type: "offer", sdp: offer });
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
  } catch (error) {
    pc.close();
    throw error;
  }
  const open = got.then(async () => {
    const cmd = chans.get("cmd")!;
    const pose = chans.get("pose")!;
    await bothOpen(cmd, pose);
    return link(pc, cmd, pose);
  });
  return { sdp: pc.localDescription?.sdp ?? "", open, abort: () => pc.close() };
}
