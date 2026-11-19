#!/usr/bin/env node
// M4.0 shared-rock transcript under plain Node: HostSession + GuestSessions over the memory
// transport and repository. No DOM, WebGPU, React, save singleton or signaling.
// Usage: pnpm coop:transcript [scenario,...]   Prints one JSON object; exit 1 if any scenario fails.
import { register } from "node:module";

register(new URL("./lib/ts-hooks.mjs", import.meta.url));

const S = (p) => import(new URL(`../src/${p}`, import.meta.url).href);
const [{ HostSession }, { GuestSession }, { MemoryNetwork }, { MemoryRepository }, { systemClock }, fp, defaults, reg, hc, mr, mo, frames, cc, eph] = await Promise.all([
  S("sim/session/hostSession.ts"),
  S("sim/session/guestSession.ts"),
  S("sim/session/memoryTransport.ts"),
  S("sim/session/memoryRepository.ts"),
  S("sim/session/ports.ts"),
  S("sim/session/fingerprint.ts"),
  S("save/defaults.ts"),
  S("sim/systemRegistry.ts"),
  S("sim/asteroids/headlessChunks.ts"),
  S("sim/asteroids/mineResolve.ts"),
  S("sim/asteroids/mineOperation.ts"),
  S("sim/frames.ts"),
  S("sim/celestialConstants.ts"),
  S("sim/ephemeris.ts"),
]);

const system = reg.activeSystem();
const CONTENT = fp.contentFingerprint(system);
const HOST_ID = "host-device-id";
const soloResolver = mr.makeMineResolver(reg.activeSystem, () => "standard");

/** Up to `n` rocks of a field, from the headless generator. */
function rocks(fieldId, n) {
  const g = hc.headlessField(fieldId);
  const out = [];
  const R = 6;
  for (let r = 0; r <= R && out.length < n; r++)
    for (let x = -r; x <= r && out.length < n; x++)
      for (let y = -r; y <= r && out.length < n; y++)
        for (let z = -r; z <= r && out.length < n; z++) {
          if (Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) !== r) continue;
          const c = hc.headlessChunk(g, x, y, z);
          for (const m in c.instancesByModel) {
            const inst = c.instancesByModel[m];
            for (let i = 0; i < inst.count && out.length < n; i++) out.push({ fieldId, chunkKey: c.key, instanceId: inst.instanceIds[i] >>> 0, radiusM: inst.radiiM[i] });
          }
        }
  return out;
}

function newWorld() {
  const data = defaults.defaultSaveData(HOST_ID, "standard");
  data.world.members[HOST_ID].name = "Host";
  const now = Date.now();
  const meta = { id: "world-1", name: "Transcript world", seed: 1, difficulty: "standard", createdAt: now, lastPlayedAt: now, playTimeS: 0, schemaVersion: defaults.SCHEMA_VERSION };
  return new MemoryRepository({ meta, data });
}

class Rig {
  constructor(repo) {
    this.net = new MemoryNetwork();
    this.repo = repo ?? newWorld();
    this.clients = [];
  }
  async startHost() {
    this.host = new HostSession({ repo: this.repo, transport: null, clock: systemClock, hostPlayerId: HOST_ID, hostName: "Host", system: reg.activeSystem, content: CONTENT });
    const transport = this.net.attachHost(this.host);
    this.host.o.transport = transport;
    await this.host.start();
    return this.host;
  }
  /** A client (guest, or the host's own when `local`); `store` persists across reconnects. */
  client(name, { local = false, store } = {}) {
    const st = store ?? { rec: {}, load() { return structuredClone(this.rec); }, save(r) { this.rec = structuredClone(r); } };
    const c = { name, store: st, pose: null, events: [], settled: [], local };
    c.session = new GuestSession({
      clock: systemClock, name, content: CONTENT, store: st, local, playerId: local ? HOST_ID : undefined,
      telemetry: () => (c.pose ? { pose: c.pose } : undefined),
      onEvent: (e) => { c.events.push(e); if (e.type === "op.settled") c.settled.push(e.outcome); },
    });
    c.join = () => {
      const r = this.net.connect(c.session, { local });
      if (!r) throw new Error("host unreachable");
      c.conn = r.conn;
      c.session.attach(r.link);
    };
    this.clients.push(c);
    return c;
  }
  settle() { return this.net.settle(); }
}

/** A pose `offsetKm` from the rock in the rock's own frame. */
function poseAt(res, offsetKm = 1) {
  return { frameId: res.frameId, positionKm: [res.positionKm[0] + offsetKm, res.positionKm[1], res.positionKm[2]], quaternion: [0, 0, 0, 1] };
}

let opN = 0;
function mineOp(rock, beamS) {
  return { type: "asteroid.mine", opId: `op-${++opN}`, fieldId: rock.fieldId, chunkKey: rock.chunkKey, instanceId: rock.instanceId, beamS };
}

const cargoOf = (p) => ({ ...p.cargo.items });
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
const destroyed = (world, r) => (world.asteroidDeltas[r.fieldId]?.[r.chunkKey] ?? []).includes(r.instanceId);

async function joinedPair(repo) {
  const rig = new Rig(repo);
  await rig.startHost();
  const h = rig.client("Host", { local: true });
  const g = rig.client("Guest");
  h.join();
  g.join();
  await rig.settle();
  return { rig, h, g };
}

async function race(first) {
  const { rig, h, g } = await joinedPair();
  const rock = rocks("origin_belt", 60).sort((a, b) => b.radiusM - a.radiusM)[0];
  const hp = rig.host.player(HOST_ID), gid = g.session.playerId, gp0 = rig.host.player(gid);
  const res = soloResolver(rock.fieldId, rock.chunkKey, rock.instanceId, hp);
  h.pose = poseAt(res, 0.5);
  g.pose = poseAt(res, -0.5);
  const before = { host: cargoOf(hp), guest: cargoOf(gp0), rev: rig.host.world.revision };
  const order = first === "host" ? [h, g] : [g, h];
  for (const c of order) c.session.submit(mineOp(rock, res.requiredBeamS));
  await rig.settle();
  const [win, lose] = order;
  const winOut = win.settled.at(-1), loseOut = lose.settled.at(-1);
  const winnerId = win.local ? HOST_ID : gid, loserId = win.local ? gid : HOST_ID;
  const grantW = sum(rig.host.player(winnerId).cargo.items) - sum(win.local ? before.host : before.guest);
  const grantL = sum(rig.host.player(loserId).cargo.items) - sum(win.local ? before.guest : before.host);
  const expect = sum(res.yield);
  const mirrorsGone = [h, g].every((c) => destroyed(c.session.mirror.data.world, rock));
  const mirrorCargo = same(win.session.mirror.data.players[winnerId].cargo.items, rig.host.player(winnerId).cargo.items);
  const pass = winOut?.status === "accepted" && loseOut?.status === "rejected" && loseOut.reason === "already_done" &&
    grantW === expect && grantL === 0 && destroyed(rig.host.world, rock) && mirrorsGone && mirrorCargo &&
    rig.host.world.revision === before.rev + 1;
  return { pass, winner: first, outcomes: [winOut?.status, `${loseOut?.status}:${loseOut?.reason}`], grant: grantW, expect, loserGrant: grantL, mirrorsGone, mirrorCargo, revision: rig.host.world.revision };
}

async function dropReplyRetry() {
  const { rig, g } = await joinedPair();
  const rock = rocks("origin_belt", 2)[1];
  const gid = g.session.playerId;
  const res = soloResolver(rock.fieldId, rock.chunkKey, rock.instanceId, rig.host.player(gid));
  g.pose = poseAt(res);
  rig.net.dropNextToClient(g.conn, (m) => m.t === "settled");
  const op = mineOp(rock, res.requiredBeamS);
  g.session.submit(op);
  await rig.settle();
  const committed = destroyed(rig.host.world, rock);
  const pendingAfterDrop = g.session.pending?.opId === op.opId;
  const cargo1 = sum(rig.host.player(gid).cargo.items);
  // Reconnect as a reloaded page: a new session over the same stored record.
  rig.net.disconnect(g.conn);
  await rig.settle();
  const g2 = rig.client("Guest", { store: g.store });
  g2.pose = g.pose;
  g2.join();
  await rig.settle();
  const replayed = rig.net.toClientLog.some(([c, m]) => c === g2.conn && m.t === "settled" && m.opId === op.opId && m.replay === true);
  const out = g2.settled.at(-1);
  const cargo2 = sum(rig.host.player(gid).cargo.items);
  const pass = committed && pendingAfterDrop && replayed && out?.status === "accepted" && cargo1 === sum(res.yield) && cargo2 === cargo1 &&
    g2.session.pending === null && g2.session.playerId === gid && sum(g2.session.mirror.data.players[gid].cargo.items) === cargo1;
  return { pass, committed, pendingAfterDrop, replayed, outcome: out?.status, cargoAfterCommit: cargo1, cargoAfterRetry: cargo2, samePlayer: g2.session.playerId === gid };
}

async function hostRestart() {
  const { rig, g } = await joinedPair();
  const rock = rocks("origin_belt", 3)[2];
  const gid = g.session.playerId;
  const gen1 = rig.host.generation;
  const res = soloResolver(rock.fieldId, rock.chunkKey, rock.instanceId, rig.host.player(gid));
  g.pose = poseAt(res);
  rig.net.dropNextToClient(g.conn, (m) => m.t === "settled");
  const op = mineOp(rock, res.requiredBeamS);
  g.session.submit(op);
  await rig.settle();
  const cargo1 = sum(rig.host.player(gid).cargo.items);
  // Host page reload: a new HostSession over the same repository.
  rig.net.detachHost();
  await rig.settle();
  await rig.startHost();
  const g2 = rig.client("Guest", { store: g.store });
  g2.pose = g.pose;
  g2.join();
  await rig.settle();
  const out = g2.settled.at(-1);
  const durable = rig.repo.peek().data;
  const pass = rig.host.generation === gen1 + 1 && out?.status === "accepted" && destroyed(rig.host.world, rock) && destroyed(durable.world, rock) &&
    sum(rig.host.player(gid).cargo.items) === cargo1 && cargo1 === sum(res.yield) && sum(durable.players[gid].cargo.items) === cargo1 && g2.session.pending === null;
  return { pass, gen: [gen1, rig.host.generation], outcome: out?.status, cargo: [cargo1, sum(rig.host.player(gid).cargo.items)], rockGoneDurable: destroyed(durable.world, rock) };
}

async function lunarRemote() {
  const { rig, h, g } = await joinedPair();
  const rock = rocks("luna_belt", 1)[0];
  const gid = g.session.playerId;
  const hres = soloResolver("origin_belt", rocks("origin_belt", 1)[0].chunkKey, rocks("origin_belt", 1)[0].instanceId, rig.host.player(HOST_ID));
  h.pose = poseAt(hres);
  h.session.sendTelemetry();
  const solo = soloResolver(rock.fieldId, rock.chunkKey, rock.instanceId, defaults.defaultPlayerState("standard"));
  const preview = mo.buildMineOperation(system, rock, { miningEfficiencyMult: 1 }, "preview").yield;
  // Guest reports its pose in the SYSTEM frame, so the host must convert frames at its clock instant.
  cc.updateEphemerisPositions(eph.jdFromUnixMs(rig.host.epochMs()));
  const o = { x: 0, y: 0, z: 0 };
  frames.frameOriginXyzKm(solo.frameId, o);
  g.pose = { frameId: "system", positionKm: [o.x + solo.positionKm[0] + 1, o.y + solo.positionKm[1], o.z + solo.positionKm[2]], quaternion: [0, 0, 0, 1] };
  const before = cargoOf(rig.host.player(gid));
  g.session.submit(mineOp(rock, solo.requiredBeamS));
  await rig.settle();
  const out = g.settled.at(-1);
  const granted = out?.result?.granted ?? {};
  const after = rig.host.player(gid).cargo.items;
  const delta = Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - (before[k] ?? 0)]).filter(([, v]) => v));
  const hostPose = rig.host.player(HOST_ID).ship;
  const hostFar = hostPose && hostPose.frameId === "earth";
  const pass = out?.status === "accepted" && same(granted, solo.yield) && same(delta, solo.yield) && same(preview, solo.yield) && solo.frameId === "luna" && hostFar && destroyed(rig.host.world, rock);
  return { pass, rock: { ...rock, frameId: solo.frameId, positionKm: solo.positionKm.map((v) => +v.toFixed(3)) }, solo: solo.yield, host: granted, preview, hostFrame: hostPose?.frameId };
}

async function receiptEviction() {
  const { rig, g } = await joinedPair();
  const gid = g.session.playerId;
  const list = rocks("origin_belt", 262);
  const sent = [];
  for (const rock of list) {
    const res = soloResolver(rock.fieldId, rock.chunkKey, rock.instanceId, rig.host.player(gid));
    g.pose = poseAt(res);
    const op = mineOp(rock, res.requiredBeamS);
    sent.push({ op, seq: g.session.pending ? -1 : rig.host.player(gid).stream.seq + 1 });
    g.session.submit(op);
    await rig.settle();
  }
  const accepted = g.settled.filter((o) => o.status === "accepted").length;
  const p = rig.host.player(gid);
  const old = sent[3];
  const oldEvicted = !rig.host.world.receipts.some((r) => r.opId === old.op.opId);
  const snap = { rev: rig.host.world.revision, cargo: JSON.stringify(p.cargo), seq: p.stream.seq, deltas: JSON.stringify(rig.host.world.asteroidDeltas) };
  const logN = rig.net.toClientLog.length;
  rig.net.injectToHost(g.conn, "cmd", { t: "cmd", gen: rig.host.generation, seq: old.seq, opId: old.op.opId, op: old.op });
  await rig.settle();
  const reply = rig.net.toClientLog.slice(logN).map(([, m]) => m.t);
  const p2 = rig.host.player(gid);
  const unchanged = rig.host.world.revision === snap.rev && JSON.stringify(p2.cargo) === snap.cargo && p2.stream.seq === snap.seq && JSON.stringify(rig.host.world.asteroidDeltas) === snap.deltas;
  const pass = accepted === list.length && rig.host.world.receipts.length === 256 && oldEvicted && old.seq === 4 && unchanged && reply[0] === "watermark";
  return { pass, ops: list.length, accepted, receipts: rig.host.world.receipts.length, oldEvicted, replayOldSeq: old.seq, reply: reply.slice(0, 2), unchanged };
}

async function oldGeneration() {
  const { rig, g } = await joinedPair();
  const gid = g.session.playerId;
  const gen1 = rig.host.generation;
  rig.net.detachHost();
  await rig.settle();
  await rig.startHost();
  const g2 = rig.client("Guest", { store: g.store });
  g2.join();
  await rig.settle();
  const rock = rocks("origin_belt", 5)[4];
  const res = soloResolver(rock.fieldId, rock.chunkKey, rock.instanceId, rig.host.player(gid));
  rig.net.injectToHost(g2.conn, "cmd", { t: "cmd", gen: gen1, seq: rig.host.player(gid).stream.seq + 1, opId: "stale-op", op: { ...mineOp(rock, res.requiredBeamS), opId: "stale-op" }, tel: { pose: poseAt(res) } });
  rig.net.injectToHost(g2.conn, "pose", { t: "pose", id: gid, seq: 1, gen: gen1, tick: 0, f: "earth", p: [0, 0, 0], v: [0, 0, 0], q: [0, 0, 0, 1], fl: 0 });
  await rig.settle();
  const seq = rig.host.player(gid).stream.seq;
  const pass = rig.host.generation === gen1 + 1 && g2.session.generation === gen1 + 1 && seq === 0 && !destroyed(rig.host.world, rock) && rig.host.player(gid).ship === null;
  return { pass, gens: [gen1, rig.host.generation], streamSeq: seq, rockIntact: !destroyed(rig.host.world, rock), poseIgnored: rig.host.player(gid).ship === null };
}

async function storageFailure() {
  const { rig, h, g } = await joinedPair();
  const gid = g.session.playerId;
  const rock = rocks("origin_belt", 6)[5];
  const res = soloResolver(rock.fieldId, rock.chunkKey, rock.instanceId, rig.host.player(gid));
  g.pose = poseAt(res);
  const before = { rev: rig.host.world.revision, cargo: JSON.stringify(rig.host.player(gid).cargo), seq: rig.host.player(gid).stream.seq, durable: JSON.stringify(rig.repo.peek().data.world.asteroidDeltas) };
  const logN = rig.net.toClientLog.length;
  rig.repo.failNext = 1;
  g.session.submit(mineOp(rock, res.requiredBeamS));
  await rig.settle();
  const msgs = rig.net.toClientLog.slice(logN).map(([, m]) => m.t);
  const published = msgs.includes("commit") || msgs.includes("settled");
  // A second intent is not executed while mutations are paused.
  const rock2 = rocks("origin_belt", 7)[6];
  h.pose = poseAt(soloResolver(rock2.fieldId, rock2.chunkKey, rock2.instanceId, rig.host.player(HOST_ID)));
  h.session.submit(mineOp(rock2, 1e6));
  await rig.settle();
  const p = rig.host.player(gid);
  const kept = rig.host.world.revision === before.rev && JSON.stringify(p.cargo) === before.cargo && p.stream.seq === before.seq && !destroyed(rig.host.world, rock) && !destroyed(rig.host.world, rock2);
  const pass = !published && kept && rig.host.status === "storage_failed" && g.session.storageFailed && !destroyed(g.session.mirror.data.world, rock) &&
    JSON.stringify(rig.repo.peek().data.world.asteroidDeltas) === before.durable && g.settled.length === 0 && h.settled.length === 0;
  return { pass, published, kept, hostStatus: rig.host.status, guestSawStatus: g.session.storageFailed, msgs };
}

async function activityBounds() {
  const { rig, g } = await joinedPair();
  const gid = g.session.playerId;
  const [a, b] = rocks("origin_belt", 9).slice(7);
  const ra = soloResolver(a.fieldId, a.chunkKey, a.instanceId, rig.host.player(gid));
  g.pose = poseAt(ra);
  g.session.submit(mineOp(a, ra.requiredBeamS * 0.5));
  await rig.settle();
  const rb = soloResolver(b.fieldId, b.chunkKey, b.instanceId, rig.host.player(gid));
  g.pose = poseAt(rb, 200);
  g.session.submit(mineOp(b, rb.requiredBeamS));
  await rig.settle();
  g.session.submit({ type: "time.set", opId: "guest-time", rate: 100 });
  await rig.settle();
  g.session.submit({ ...mineOp({ fieldId: "origin_belt", chunkKey: "origin_belt:0,0,0", instanceId: 12345 }, 99), opId: "ghost" });
  await rig.settle();
  const reasons = g.settled.map((o) => o.reason ?? o.status);
  const pass = JSON.stringify(reasons) === JSON.stringify(["no_activity", "too_far", "not_allowed", "not_found"]) && rig.host.world.revision === 0 && rig.host.player(gid).stream.seq === 4;
  return { pass, reasons, streamSeq: rig.host.player(gid).stream.seq };
}

/** Review hardening: a duplicate hello admits once, late members reach mirrors, telemetry is bounded. */
async function hardening() {
  const { PROTOCOL_VERSION } = await S("sim/session/protocol.ts");
  const { rig, g } = await joinedPair();
  const gid = g.session.playerId;
  const d = rig.client("Dup");
  d.join();
  rig.net.injectToHost(d.conn, "cmd", { t: "hello", protocol: PROTOCOL_VERSION, content: CONTENT, name: "Dup" });
  await rig.settle();
  const members = Object.keys(rig.host.world.members).length;
  const did = d.session.playerId;
  const lateName = g.session.mirror.data.world.members[did]?.name ?? null;
  const prot0 = rig.host.player(gid).propellant.protectedKg;
  rig.net.injectToHost(g.conn, "cmd", { t: "tel", gen: g.session.generation, tel: { propellant: { ordinaryKg: 1e7, protectedKg: 1e7 } } });
  await rig.settle();
  const prop = rig.host.player(gid).propellant;
  const pass = members === 3 && lateName === "Dup" && prop.ordinaryKg < 1e6 && prop.protectedKg === prot0;
  return { pass, members, lateName, ordinaryKg: prop.ordinaryKg, protectedKg: prop.protectedKg };
}

const SCENARIOS = {
  raceHostFirst: () => race("host"),
  raceGuestFirst: () => race("guest"),
  dropReplyRetry,
  hostRestart,
  lunarRemote,
  receiptEviction,
  oldGeneration,
  storageFailure,
  activityBounds,
  hardening,
};

const pick = process.argv[2] ? process.argv[2].split(",") : Object.keys(SCENARIOS);
const results = {};
let ok = true;
for (const name of pick) {
  const t0 = Date.now();
  try {
    results[name] = { ...(await SCENARIOS[name]()), ms: Date.now() - t0 };
  } catch (err) {
    results[name] = { pass: false, error: String(err?.stack ?? err).split("\n").slice(0, 4).join(" | ") };
  }
  ok &&= results[name].pass === true;
}
console.log(JSON.stringify({ pass: ok, content: CONTENT, results }, null, 1));
process.exit(ok ? 0 : 1);
