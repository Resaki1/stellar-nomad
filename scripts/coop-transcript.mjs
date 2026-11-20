#!/usr/bin/env node
// M4.0 shared-rock transcript under plain Node: HostSession + GuestSessions over the memory
// transport and repository. No DOM, WebGPU, React, save singleton or signaling.
// Usage: pnpm coop:transcript [scenario,...]   Prints one JSON object; exit 1 if any scenario fails.
import assert from "node:assert/strict";
import { register } from "node:module";
import { earthMiningLoot, earthMiningRock, earthMiningSite } from "./lib/industry-rock.mjs";

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
  async startHost(clock = systemClock) {
    this.host = new HostSession({ repo: this.repo, transport: null, clock, hostPlayerId: HOST_ID, hostName: "Host", system: reg.activeSystem, content: CONTENT });
    const transport = this.net.attachHost(this.host);
    this.host.o.transport = transport;
    await this.host.start();
    return this.host;
  }
  /** A client (guest, or the host's own when `local`); `store` persists across reconnects. */
  client(name, { local = false, store } = {}) {
    const st = store ?? { rec: {}, load() { return structuredClone(this.rec); }, save(r) { this.rec = structuredClone(r); } };
    const c = { name, store: st, pose: null, poses: [], events: [], settled: [], local };
    c.session = new GuestSession({
      clock: systemClock, name, content: CONTENT, store: st, local, playerId: local ? HOST_ID : undefined,
      telemetry: () => c.telemetry ?? (c.pose ? { pose: c.pose } : undefined),
      onPose: (p) => c.poses.push(p),
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
  async settle() {
    // Handshakes hash credentials asynchronously. An empty wire alone does not mean the host is idle.
    for (let turn = 0; turn < 2; turn++) {
      await this.net.settle();
      await this.host.chain;
    }
    await this.net.settle();
  }
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

async function joinedPair(repo, clock = systemClock) {
  const rig = new Rig(repo);
  await rig.startHost(clock);
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

async function menuClock() {
  const rig = new Rig();
  let ms = 0;
  const session = await rig.startHost({ ...systemClock, monoMs: () => ms });
  ms += 1500;
  session.setClockPaused(true);
  const pausedAt = session.epochMs();
  ms += 6000;
  const held = session.epochMs() === pausedAt;
  session.setClockPaused(false);
  const resumedAt = session.epochMs();
  ms += 1000;
  return { pass: held && resumedAt === pausedAt && session.epochMs() === resumedAt + 1000 };
}

/** Fill the last two berths before either new pilot sends a pose or telemetry. */
async function guestBerths() {
  const { rig, g } = await joinedPair();
  const others = [rig.client("Guest 2"), rig.client("Guest 3")];
  for (const guest of others) guest.join();
  await rig.settle();
  const poses = [g, ...others].map(c => rig.host.player(c.session.playerId).ship);
  const distancesM = poses.flatMap((a, i) => poses.slice(i + 1).map(b =>
    Math.hypot(...a.positionKm.map((coord, axis) => coord - b.positionKm[axis])) * 1000));
  return { pass: poses.every(p => p.frameId === poses[0].frameId) && distancesM.every(d => d >= 35 && d < 250), distancesM };
}

async function oldGeneration() {
  const { rig, g } = await joinedPair();
  const gid = g.session.playerId;
  const savedPose = structuredClone(rig.host.player(gid).ship);
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
  rig.net.injectToHost(g2.conn, "pose", { t: "pose", id: gid, seq: 1, revision: 0, gen: gen1, tick: 0, f: "earth", p: [0, 0, 0], v: [0, 0, 0], q: [0, 0, 0, 1], fl: 0 });
  await rig.settle();
  const seq = rig.host.player(gid).stream.seq;
  const poseIgnored = savedPose !== null && same(rig.host.player(gid).ship, savedPose);
  const pass = rig.host.generation === gen1 + 1 && g2.session.generation === gen1 + 1 && seq === 0 && !destroyed(rig.host.world, rock) && poseIgnored;
  return { pass, gens: [gen1, rig.host.generation], streamSeq: seq, rockIntact: !destroyed(rig.host.world, rock), poseIgnored };
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

/** Playtest 3: a rename reaches the host and every mirror; pose activity fields are bounded. */
async function renameAndActivity() {
  const { decodePose, decodeClientMsg } = await S("sim/session/protocol.ts");
  const { rig, h, g } = await joinedPair();
  const gid = g.session.playerId;
  g.session.rename("  Lyra  ");
  h.session.rename("Altair");
  rig.net.injectToHost(g.conn, "cmd", { t: "name", gen: g.session.generation, name: "   " });
  await rig.settle();
  const names = { host: rig.host.world.members[gid]?.name, hostSelf: rig.host.world.members[HOST_ID]?.name, hostMirror: h.session.mirror.data.world.members[gid]?.name, guestMirror: g.session.mirror.data.world.members[HOST_ID]?.name };
  const base = { t: "pose", id: gid, seq: 1, revision: 0, gen: 1, tick: 0, f: "earth", p: [10, 0, 0], v: [0, 0, 0], q: [0, 0, 0, 1], fl: 1 };
  const ok = decodePose({ ...base, th: 200, b: [10.5, 0, 0] });
  const far = decodePose({ ...base, th: 999, b: [100, 0, 0] });
  const bad = decodePose({ ...base, b: ["x", 0, 0] });
  const longName = decodeClientMsg({ t: "name", gen: 1, name: "x".repeat(65) });
  const checks = {
    renamed: names.host === "Lyra" && names.hostSelf === "Altair" && names.hostMirror === "Lyra" && names.guestMirror === "Altair",
    poseFields: ok?.th === 200 && ok?.b?.[0] === 10.5,
    upgradedRange: decodePose({ ...base, b: [22.5, 0, 0] })?.b?.[0] === 22.5,
    farBeamDropped: !!far && far.b === undefined && far.th === undefined,
    malformedKeepsPose: !!bad && bad.b === undefined,
    longNameRefused: longName === null,
  };
  return { pass: Object.values(checks).every(Boolean), checks, names };
}

/** Review 3: renames are cleaned of invisible characters, made unique, and coalesced per pilot. */
async function renameHardening() {
  let ms = 0;
  const { rig, h, g } = await joinedPair(undefined, { ...systemClock, monoMs: () => ms });
  const gid = g.session.playerId;
  const sends = () => rig.host.world.members[gid]?.name;
  // Taking the host's own name gets a suffix; zero-width / bidi / control characters are stripped.
  const hostName = rig.host.world.members[HOST_ID]?.name;
  g.session.rename(hostName);
  await rig.settle();
  const dup = sends();
  ms += 1100;
  g.session.rename("Ly\u200bra\u202e\u0007");
  await rig.settle();
  const clean = sends();
  // A burst inside the cooldown: nothing lands until the tick, then only the last name.
  for (let i = 0; i < 20; i++) g.session.rename(`Spam ${i}`);
  await rig.settle();
  const duringBurst = sends();
  ms += 1100;
  rig.host.tick();
  await rig.settle();
  const afterTick = sends();
  const guestMirror = h.session.mirror.data.world.members[gid]?.name;
  const checks = {
    dupSuffixed: dup === `${hostName} 2`,
    invisibleStripped: clean === "Lyra",
    burstHeld: duringBurst === "Lyra",
    lastLands: afterTick === "Spam 19" && guestMirror === "Spam 19",
  };
  return { pass: Object.values(checks).every(Boolean), checks, names: { dup, clean, duringBurst, afterTick, guestMirror } };
}

// Deliver old unreliable poses on either side of reliable death and respawn commits.
async function shipLifecycle() {
  const { rig, h, g } = await joinedPair();
  const gid = g.session.playerId;
  const pose = { t: "pose", id: gid, gen: g.session.generation, seq: 10, revision: g.session.revision,
    tick: 0, f: "earth", p: [10, 0, 0], v: [0, 0, 0], q: [0, 0, 0, 1], fl: 0 };
  const contact = { frameId: "earth", positionKm: [10, 0, 0], direction: [0, 1, 0], dvMps: 12 };
  g.session.sendImpact(contact);
  await rig.settle();
  const sparks = h.events.filter(e => e.type === "ship.contact" && e.by === gid).length === 1 &&
    !g.events.some(e => e.type === "ship.contact");
  g.session.submit({ type: "ship.destroy", opId: "crash", frameId: "earth", positionKm: pose.p });
  await rig.settle();
  h.session.receive("pose", pose);
  const late = rig.client("Late");
  late.join();
  await rig.settle();
  late.session.receive("pose", { ...pose, revision: late.session.revision });
  g.session.sendImpact(contact);
  await rig.settle();
  const hidden = rig.host.player(gid).isDead && !h.poses.length && !late.poses.length && h.events.filter(e => e.type === "ship.contact").length === 1;
  g.session.submit({ type: "ship.respawn", opId: "recover", mode: "starter" });
  await rig.settle();
  for (const observer of [h, late]) observer.session.receive("pose", pose);
  const noOldLife = !h.poses.length && !late.poses.length;
  g.session.sendPose({ seq: 11, tick: 20, f: "earth", p: [20, 0, 0], v: pose.v, q: pose.q, fl: 0 });
  await rig.settle();
  const recovered = !rig.host.player(gid).isDead && [h, late].every(c => c.poses.length === 1 && c.poses[0].p[0] === 20);
  return { pass: sparks && hidden && noOldLife && recovered, sparks, hidden, noOldLife, recovered };
}

async function pilotActions() {
  const repo = newWorld();
  const seed = repo.peek();
  const patch = "consumable_hull_patch_kit", sink = "consumable_heat_sink_cartridge";
  const pilot = seed.data.players[HOST_ID];
  pilot.health = 60;
  pilot.power.heat01 = 1.2;
  pilot.cargo.items.silicates = 9;
  pilot.modules.consumables = { [patch]: 2, [sink]: 1 };
  await repo.commit(seed.meta, seed.data);
  const { rig, h, g } = await joinedPair(repo);
  const run = async (client, op) => { client.session.submit({ opId: "pilot-" + (++opN), ...op }); await rig.settle(); return client.settled.at(-1); };
  await run(h, { type: "hotbar.assign", index: 3, itemId: patch });
  await run(h, { type: "hotbar.assign", index: 2, itemId: patch });
  await run(h, { type: "cargo.jettison", resourceId: "silicates", amount: 4 });
  await run(g, { type: "cargo.jettison", resourceId: "silicates", amount: 1 });
  await run(h, { type: "item.consume", itemId: sink });
  // Both copies carry the same pre-repair sample. A replay must leave the durable hull repaired.
  h.telemetry = { health: 60 };
  rig.net.duplicateNextToHost(h.conn);
  await run(h, { type: "item.consume", itemId: patch });
  const p = repo.peek().data.players[HOST_ID];
  const checks = { privateStores: g.settled.at(-1)?.status === "rejected" && p.cargo.items.silicates === 5,
    hotbar: p.modules.hotbar[2] === patch && p.modules.hotbar[3] === null,
    cooled: Math.abs(p.power.heat01 - 0.7) < 1e-8 && !p.modules.consumables[sink],
    patchedOnce: p.health === 75 && p.modules.consumables[patch] === 1 };
  const replacement = rig.client("Replacement", { store: g.store });
  replacement.join();
  await rig.settle();
  checks.replaced = g.session.refusal === "replaced" && replacement.session.playerId === g.session.playerId;
  return { pass: Object.values(checks).every(Boolean), checks };
}

async function sharedLoop() {
  const repo = newWorld();
  const seed = repo.peek();
  const pilot = seed.data.players[HOST_ID];
  pilot.cargo.items.hydrates = 5;
  pilot.cargo.items.fe_ni_metal = 240;
  pilot.cargo.items.silicates = 85;
  pilot.health = 70;
  pilot.modules.consumables.consumable_replication_kit = 1;
  pilot.propellant.ordinaryKg = 0;
  await repo.commit(seed.meta, seed.data);
  let { rig, h, g } = await joinedPair(repo);
  const gid = g.session.playerId;
  const submit = (c, type, args) => c.session.submit({ type, opId: "loop-" + (++opN), ...args });
  const run = async (c, type, args) => { submit(c, type, args); await rig.settle(); return c.settled.at(-1); };
  const checks = { privateSnapshot: Object.keys(g.session.mirror.data.players).join() === gid &&
    Object.values(g.session.mirror.data.world.members).every(m => m.verifier === null) };
  const batch = await run(h, "processing.start", { recipeId: "hydrate_propellant", units: 3 });
  const { batchId, outputKg } = batch.result;
  h.telemetry = { processing: { id: batchId, elapsedS: 1, committedKg: outputKg / 3 }, propellant: { ordinaryKg: outputKg / 3, protectedKg: 0 } };
  h.session.sendTelemetry();
  await rig.settle();
  await rig.host.close();
  await rig.settle();
  await rig.startHost();
  const partial = h.telemetry;
  h = rig.client("Host", { local: true, store: h.store });
  g = rig.client("Guest", { store: g.store });
  h.telemetry = partial;
  h.join(); g.join(); await rig.settle();
  checks.resumedBatch = h.session.mirror.data.players[HOST_ID].processing?.committedKg === outputKg / 3;
  h.telemetry.processing.committedKg = outputKg;
  h.telemetry.propellant.ordinaryKg = outputKg;
  await run(h, "trial.record", { trialId: "first_batch" });
  checks.finishedOnce = !rig.host.player(HOST_ID).processing && rig.host.player(HOST_ID).cargo.items.hydrates === 2;
  delete h.telemetry;
  const repair = await run(h, "ship.repair", { pct: 2 });
  const patch = await run(h, "item.craft", { itemId: "consumable_hull_patch_kit" });
  const research = await run(h, "research.unlock", { nodeId: "lg1_bulk_handling" });
  const metalBefore = rig.host.player(HOST_ID).cargo.items.fe_ni_metal;
  submit(h, "item.craft", { itemId: "module_cargo_rack_mk1" });
  submit(h, "module.equip", { slot: "cargo", itemId: null });
  await rig.settle();
  const rack = rig.host.player(HOST_ID);
  checks.sharedResearch = patch.status === "accepted" && research.status === "accepted" &&
    g.session.mirror.data.world.research.completedNodes.includes("lg1_bulk_handling");
  checks.queuedLoadout = rack.cargo.items.fe_ni_metal === metalBefore - 150 && rack.modules.ownedModules.includes("module_cargo_rack_mk1") && !rack.modules.equippedModules.cargo;
  checks.repair = repair.status === "accepted" && rack.health === 72;
  h.pose = { frameId: "earth", positionKm: [30000, 0, 0], quaternion: [0,0,0,1] };
  const point = await run(h, "replication.place", { ...h.pose, name: "Earth rendezvous" });
  checks.privateRecovery = point.status === "accepted" && rig.host.player(HOST_ID).replication.activeId === point.result.point.id &&
    rig.host.player(gid).replication.activeId !== point.result.point.id;
  g.pose = h.pose;
  const activate = await run(g, "replication.activate", { pointId: point.result.point.id });
  const deactivate = await run(g, "replication.deactivate", {});
  checks.independentSelection = activate.status === "accepted" && deactivate.status === "accepted" &&
    rig.host.player(gid).replication.activeId === "starter" && rig.host.player(HOST_ID).replication.activeId === point.result.point.id;
  const site = { siteId: "luna_survey_canister" };
  h.pose = g.pose = { frameId: "luna", positionKm: [1629, 4605, 393], quaternion: [0, 0, 0, 1] };
  await run(h, "site.inspect", site);
  submit(g, "site.recover", site); submit(h, "site.recover", site); await rig.settle();
  const winner = g.settled.at(-1).status === "accepted" ? g : h;
  const winnerId = winner.session.playerId;
  checks.siteRace = [g,h].filter(c => c.settled.at(-1).status === "accepted").length === 1 &&
    rig.host.player(winnerId).cargo.items.titanium === 30;
  const crash = await run(winner, "ship.destroy", winner.pose);
  const wreck = { wreckId: crash.result.wreckId };
  const rock = rocks("luna_belt", 1)[0];
  const resolved = soloResolver(rock.fieldId, rock.chunkKey, rock.instanceId, rig.host.player(winnerId));
  winner.pose = poseAt(resolved);
  const deadMine = await run(winner, "asteroid.mine", { ...rock, beamS: resolved.requiredBeamS });
  checks.deadMine = deadMine.reason === "dead" && !destroyed(rig.host.world, rock);
  const recovered = await run(winner, "ship.respawn", { mode: "active" });
  checks.recovery = recovered.result.destination.pointId === rig.host.player(winnerId).replication.activeId;
  winner.pose = poseAt(resolved);
  checks.distantSalvage = (await run(winner, "wreck.collect", wreck)).reason === "too_far";
  h.pose = g.pose = { frameId: "luna", positionKm: [1629, 4605, 393], quaternion: [0,0,0,1] };
  submit(g, "wreck.collect", wreck); submit(h, "wreck.collect", wreck); await rig.settle();
  checks.salvageConserved = [gid, HOST_ID].reduce((n,id) => n + (rig.host.player(id).cargo.items.titanium ?? 0), 0) === 30 &&
    !rig.host.world.wrecks.some(w => w.items.titanium);
  return { pass: Object.values(checks).every(Boolean), checks };
}

async function expedition() {
  const repo = newWorld();
  const seed = repo.peek();
  const pilot = seed.data.players[HOST_ID];
  const patch = "consumable_hull_patch_kit";
  pilot.cargo.items.silicates = 7;
  pilot.modules.consumables[patch] = 2;
  await repo.commit(seed.meta, seed.data);
  const { rig, h, g } = await joinedPair(repo);
  const gid = g.session.playerId;
  const observer = rig.client("Observer");
  observer.join(); await rig.settle();
  const pose = { frameId: "earth", positionKm: [30000,0,0], quaternion: [0,0,0,1] };
  const sample = (kg, reserve = 0) => ({ pose, receivedFuelKg: 0, reservedFuelKg: reserve, propellant: { ordinaryKg: kg, protectedKg: 2 } });
  h.telemetry = sample(50, 40);
  g.telemetry = sample(10);
  g.session.sendTelemetry();
  await rig.settle();
  const submit = async (c, op) => {
    c.session.submit({ opId: "trip-" + (++opN), ...op });
    await rig.settle(); return c.settled.at(-1);
  };
  const give = (kind, itemId, amount) => ({ type: "expedition.give", to: gid, kind, itemId, amount });
  const checks = {};
  checks.brakingReserve = (await submit(h, give("fuel", "fuel", 11))).reason === "materials";
  checks.fuel = (await submit(h, give("fuel", "fuel", 9))).status === "accepted" &&
    rig.host.player(HOST_ID).propellant.ordinaryKg === 41 && rig.host.player(gid).propellant.ordinaryKg === 19;
  h.telemetry.propellant.ordinaryKg = 41;
  // A sample that crossed the delivery can include real burns but cannot erase the gift.
  g.telemetry.propellant.ordinaryKg = 8;
  g.session.sendTelemetry(); await rig.settle();
  checks.crossedFuel = rig.host.player(gid).propellant.ordinaryKg === 17;
  g.telemetry.receivedFuelKg = 9;
  g.telemetry.propellant.ordinaryKg = 17;
  checks.short = (await submit(h, give("cargo", "silicates", 8))).reason === "materials";
  const cargoBefore = rig.host.player(HOST_ID).cargo.items.silicates;
  g.telemetry.propellant.ordinaryKg = 1e7;
  g.session.sendTelemetry(); await rig.settle();
  checks.tankFull = (await submit(h, give("fuel", "fuel", 1))).reason === "tank_full" && rig.host.player(HOST_ID).propellant.ordinaryKg === 41;
  g.telemetry.propellant.ordinaryKg = 17;
  g.telemetry.pose = { ...pose, positionKm: [30001,0,0] };
  g.session.sendTelemetry(); await rig.settle();
  checks.range = (await submit(h, give("cargo", "silicates", 2))).reason === "too_far" &&
    rig.host.player(HOST_ID).cargo.items.silicates === cargoBefore;
  g.telemetry.pose = pose;
  g.session.sendTelemetry(); await rig.settle();
  rig.net.duplicateNextToHost(h.conn);
  checks.cargoOnce = (await submit(h, give("cargo", "silicates", 3))).status === "accepted" &&
    rig.host.player(HOST_ID).cargo.items.silicates === 4 && rig.host.player(gid).cargo.items.silicates === 3;
  checks.consumable = (await submit(h, give("consumable", patch, 1))).status === "accepted" &&
    g.session.mirror.data.players[gid].modules.consumables[patch] === 1;
  const fix = await submit(h, { type: "expedition.mark", sourceId: null, name: "Rendezvous" });
  checks.marker = fix.status === "accepted" && g.session.mirror.data.world.rendezvous[HOST_ID]?.frameId === "earth";
  const messages = rig.net.toClientLog.filter(([id,m]) => id === observer.conn && m.t === "commit");
  checks.privateCommits = messages.length > 0 && messages.every(([,m]) => !m.slices.player && m.events.every(e => e.type !== "player.changed"));
  rig.net.disconnect(g.conn); await rig.settle();
  checks.offline = (await submit(h, give("fuel","fuel",1))).reason === "not_active";
  const g2 = rig.client("Guest", { store: g.store });
  g2.join(); await rig.settle();
  checks.rejoin = g2.session.mirror.data.players[gid].receivedFuelKg === 9 && g2.session.mirror.data.players[gid].cargo.items.silicates === 3;
  g2.telemetry = sample(17); g2.telemetry.receivedFuelKg = 9;
  g2.session.sendTelemetry(); await rig.settle();
  rig.repo.failNext = 1;
  h.session.submit({ ...give("cargo","silicates",2), opId: "failed-gift" });
  await rig.settle();
  const durable = repo.peek().data.players;
  checks.atomicFailure = rig.host.status === "storage_failed" && durable[HOST_ID].cargo.items.silicates === 4 &&
    durable[gid].cargo.items.silicates === 3 && rig.host.player(gid).cargo.items.silicates === 3;
  return { pass: Object.values(checks).every(Boolean), checks };
}

/** Run only in the disposable checkout with scripts/fixtures/m4-content.patch applied. */
async function contentFixture() {
  const { LocalAuthority } = await S("sim/world/authority.ts");
  const ore = "fixture_ore", patch = "consumable_fixture_patch";
  const { rig, h, g } = await joinedPair();
  const gid = g.session.playerId;
  const rock = rocks("origin_belt", 1)[0];
  const resolved = soloResolver(rock.fieldId, rock.chunkKey, rock.instanceId, rig.host.player(gid));
  if (!(resolved.yield[ore] > 0)) throw new Error("Apply the content fixture in a disposable checkout first");
  const pose = poseAt(resolved);
  const solo = defaults.defaultSaveData(HOST_ID);
  const authority = new LocalAuthority({ getWorld: () => solo.world, getPlayer: id => solo.players[id],
    getPlayers: () => Object.values(solo.players), markDirty: () => {}, resolveMine: soloResolver });
  const mined = authority.submit(mineOp(rock, resolved.requiredBeamS), HOST_ID);
  const craft = { type: "item.craft", opId: "fixture-craft", itemId: patch };
  const crafted = authority.submit(craft, HOST_ID);
  const submit = async (c, op) => { c.session.submit(op); await rig.settle(); return c.settled.at(-1); };
  for (const c of [h,g]) {
    c.telemetry = { pose, propellant: { ordinaryKg: 10, protectedKg: 0 } };
    c.session.sendTelemetry();
  }
  await rig.settle();
  const scan = await submit(g, { ...rock, type: "survey.inspect", opId: "fixture-scan" });
  const fix = await submit(g, { type: "expedition.mark", sourceId: scan.result.sourceId, name: "Test ore", opId: "fixture-share" });
  const remote = await submit(g, mineOp(rock, resolved.requiredBeamS));
  const gift = await submit(g, { type: "expedition.give", kind: "cargo", itemId: ore, amount: 1, to: HOST_ID, opId: "fixture-give" });
  const made = await submit(h, craft);
  const wrong = rig.client("Old content");
  wrong.session.o.content += "-old";
  wrong.join(); await rig.settle();
  const before = rig.host.world.revision;
  await rig.host.close(); await rig.settle();
  await rig.startHost();
  const again = rig.client("Returning", { store: g.store });
  again.join(); await rig.settle();
  const checks = { generated: same(mined.result.granted, remote.result.granted), surveyed: scan.status === "accepted" && fix.status === "accepted",
    craft: made.status === "accepted" && crafted.status === "accepted" && gift.status === "accepted",
    stores: rig.host.player(HOST_ID).modules.consumables[patch] === 1 &&
      again.session.mirror.data.players[gid].cargo.items[ore] === solo.players[HOST_ID].cargo.items[ore],
    findings: rig.host.world.discoveries.families[ore]?.extracted && solo.world.discoveries.families[ore]?.extracted,
    oldContent: wrong.session.refusal === "content" && Object.keys(rig.host.world.members).length === 2,
    restart: rig.host.world.revision === before && rig.host.world.rendezvous[gid]?.sourceId === scan.result.sourceId };
  return { pass: Object.values(checks).every(Boolean), checks, granted: remote.result.granted };
}

async function suspendedHost() {
  let ms = 0;
  const clock = { monoMs: () => ms, nowMs: () => Date.now() };
  const rig = new Rig();
  await rig.startHost(clock);
  const h = rig.client("Host", { local: true }), g = rig.client("Guest");
  for (const c of [h,g]) { c.session.o.clock = clock; c.join(); }
  await rig.settle();
  rig.host.tick(); await rig.settle();
  const epoch = rig.host.epochMs(), revision = rig.host.world.revision;
  ms += 120_000;
  const refused = g.session.submit({ type: "trial.record", trialId: "first_batch", opId: "while-asleep" });
  const waited = g.session.waiting() && refused.reason === "host_unavailable" && !g.session.pending;
  rig.host.tick(); await rig.settle();
  const bounded = rig.host.epochMs() - epoch <= 3000 && !g.session.waiting() && rig.host.world.revision === revision;
  ms += 1000; rig.host.tick();
  g.session.submit({ type: "trial.record", trialId: "first_batch", opId: "awake" });
  await rig.settle();
  return { pass: waited && bounded && g.settled.at(-1)?.status === "accepted", waited, bounded, epochAdvanceMs: rig.host.epochMs() - epoch };
}


async function industryResearch() {
  const seed = newWorld().peek();
  const pilot = seed.data.players[HOST_ID];
  pilot.cargo.items = { fe_ni_metal: 300, hydrates: 10, silicates: 160 };
  pilot.modules.consumables.consumable_depot_kit = 1;
  const { parseSaveData } = await S("save/validate.ts");
  seed.data.schemaVersion = 7;
  delete seed.data.world.industry.pointTanks;
  seed.data = parseSaveData(seed.data);
  assert.deepEqual(seed.data.world.industry.pointTanks, {});
  const { rig, h, g } = await joinedPair(new MemoryRepository(seed));
  const site = { frameId: "earth", positionKm: [0, 10000, 0], quaternion: [0, 0, 0, 1] };
  h.pose = poseAt(site, 0.8);
  g.pose = poseAt(site, -0.8);
  const run = async (client, type, args) => {
    client.session.submit({ type, ...args, opId: "research-" + (++opN) });
    await rig.settle();
    return client.settled.at(-1);
  };
  const kit = { itemId: "consumable_depot_kit" };
  assert.equal((await run(h, "item.craft", kit)).reason, "locked");
  // Previously owned hardware remains usable even in a world with no research.
  const placed = await run(h, "depot.place", { ...site, name: "Workshop" });
  assert.equal(placed.status, "accepted");
  const depotId = placed.result.depotId;
  const build = id => run(g, "depot.fabricate", { depotId, recipeId: id });
  for (const recipe of ["drone", "depot_kit", "refinery"]) assert.equal((await build(recipe)).reason, "locked");
  const unlock = nodeId => run(h, "research.unlock", { nodeId });
  const bulk = "lg1_bulk_handling", refining = "lg2_station_refining";
  assert.equal((await unlock(bulk)).reason, "evidence");
  for (const trialId of ["first_batch", "first_fabrication"]) {
    assert.equal((await run(h, "trial.record", { trialId })).status, "accepted");
  }
  assert.equal((await unlock(bulk)).status, "accepted");
  assert.equal(rig.host.player(HOST_ID).cargo.items.fe_ni_metal, 270);
  assert.ok(g.session.mirror.data.world.research.completedNodes.includes(bulk));
  const station = () => rig.host.world.industry.depots.find(d => d.id === depotId);
  assert.equal((await build("refinery")).reason, "locked");
  assert.equal((await run(h, "item.craft", kit)).status, "accepted");
  assert.equal((await unlock(refining)).status, "accepted");
  assert.equal(rig.host.player(HOST_ID).cargo.items.hydrates ?? 0, 0);
  for (const [itemId, amount] of [["fe_ni_metal", 75], ["silicates", 50]]) {
    assert.equal((await run(h, "depot.transfer", { depotId, direction: "deposit", kind: "cargo", itemId, amount })).status, "accepted");
  }
  g.pose = { frameId: "luna", positionKm: [3000, 0, 0], quaternion: [0, 0, 0, 1] };
  assert.equal((await run(g, "depot.transfer", { depotId, direction: "withdraw", kind: "cargo", itemId: "silicates", amount: 1 })).reason, "too_far");
  assert.equal((await build("refinery")).status, "accepted");
  assert.ok(station().refinery);
  assert.equal(station().storage.items.fe_ni_metal ?? 0, 0);
  assert.ok(g.session.mirror.data.world.research.completedNodes.includes(refining));
  assert.ok(rig.repo.peek().data.world.industry.depots[0].refinery);
  return { pass: true };
}

async function industry() {
  const [{ getIndustrySource, INDUSTRY_TUNING }, { estimateDroneRoute }, { parseSaveData }, { emergencePose, starterPoint }, { advanceIndustry }] = await Promise.all([
    S("sim/industry/catalog.ts"), S("sim/industry/route.ts"), S("save/validate.ts"), S("sim/replication/points.ts"), S("sim/industry/simulation.ts"),
  ]);
  let ms = 0;
  const clock = { monoMs: () => ms, nowMs: () => Date.UTC(2026, 0, 1) + ms };
  const seeded = newWorld().peek();
  seeded.data.world.research.completedNodes = ["lg1_bulk_handling", "ex1_controlled_extraction", "lg2_station_refining"];
  seeded.data.players[HOST_ID].cargo.items = { fe_ni_metal: 600, silicates: 400, carbon: 20 };
  const repo = new MemoryRepository(seeded);
  const rig = new Rig(repo);
  await rig.startHost(clock);
  const join = async (client) => {
    client.session.o.clock = clock;
    client.join();
    await rig.settle();
    return client;
  };
  let h = await join(rig.client("Host", { local: true }));
  let g = await join(rig.client("Guest"));
  const pid = g.session.playerId;
  const run = async (client, op) => {
    client.session.submit({ ...op, opId: op.opId ?? `industry-${++opN}` });
    await rig.settle();
    return client.settled.at(-1);
  };
  const accepted = async (client, op) => {
    const o = await run(client, op);
    assert.equal(o?.status, "accepted", JSON.stringify({ op, outcome: o }));
    return o.result;
  };
  const ticks = async (n, stepMs = 1000) => {
    for (let i = 0; i < n; i++) {
      ms += stepMs;
      rig.host.tick();
      await rig.settle();
    }
  };

  const lunar = getIndustrySource("luna_hydrates");
  const originSite = earthMiningSite(1.9);
  const relaySite = earthMiningSite(5.9);
  const pose = s => ({ frameId: s.frameId, positionKm: [...s.positionKm], quaternion: [0,0,0,1] });
  const kit = { type: "item.craft", itemId: "consumable_depot_kit" };
  const place = async (s, name) => {
    const p = pose(s);
    h.pose = poseAt(p, 0.8);
    return (await accepted(h, { type: "depot.place", name, ...p })).depotId;
  };
  await accepted(h, kit);
  const starter = starterPoint();
  const spawn = { frameId: starter.frameId, ...emergencePose(starter, 0) };
  h.pose = poseAt(spawn, 0.8);
  const collision = await run(h, { type: "depot.place", name: "Blocked emergence", ...spawn });
  assert.equal(collision.reason, "near_ship");
  const origin = await place(originSite, "Production");
  await accepted(h, kit);
  const relay = await place(relaySite, "Relay");
  await accepted(h, kit);
  const moonDepot = await place(lunar, "Lunar depot");
  const depot = id => rig.host.world.industry.depots.find(d => d.id === id);
  const send = (depotId, direction, itemId, amount, kind = "cargo") => ({ type: "depot.transfer", depotId, direction, kind, itemId, amount });
  h.pose = poseAt(originSite, 0.8);
  g.telemetry = { pose: poseAt(originSite, -0.8), propellant: { ordinaryKg: 30, protectedKg: 0 }, depositedFuelKg: 0, receivedFuelKg: 0 };
  await accepted(h, send(origin, "deposit", "fe_ni_metal", 165));
  await accepted(h, send(origin, "deposit", "silicates", 110));
  await accepted(h, send(origin, "deposit", "carbon", 20));
  const build = recipeId => accepted(h, { type: "depot.fabricate", depotId: origin, recipeId });
  await build("refinery");
  const { droneId: extract } = await build("drone");
  const { droneId: haul } = await build("drone");
  const configure = (droneId, kind, targetId, priorities, reserveKg, stopAt) =>
    ({ type: "drone.configure", droneId, job: { kind, targetId, priorities, reserveKg, stopAt, enabled: true } });
  const mine = fieldId => ({ type: "drone.configure", droneId: extract,
    job: { kind: "mine", targetId: fieldId, priorities: [], mineFilter: { mode: "resource", ids: ["hydrates"] },
      reserveKg: 0, stopAt: 200, enabled: true } });
  assert.equal((await run(h, mine(lunar.fieldId))).reason, "source_out_of_range");
  assert.equal((await run(h, configure(haul, "haul", moonDepot, ["propellant"], 12, 600))).reason, "route_out_of_range");
  assert.equal(estimateDroneRoute(depot(origin), earthMiningSite(-1000)), null, "a long same-frame route outside the shared field is refused");
  await accepted(h, mine(earthMiningRock.fieldId));
  await accepted(g, configure(haul, "haul", relay, ["propellant"], 12, 600));
  const transfer = { ...send(origin, "deposit", "fuel", 12, "fuel"), opId: "bootstrap" };
  await accepted(g, transfer);
  assert.equal((await run(g, transfer)).status, "duplicate", "replayed op cannot debit the ship twice");
  g.session.sendTelemetry();
  await rig.settle();
  assert.equal(rig.host.player(pid).propellant.ordinaryKg, 18, "earlier fuel telemetry cannot erase the debit");
  assert.equal(depot(origin).storage.fuelKg, 12);
  g.telemetry = { pose: poseAt(relaySite, 0.8), propellant: { ordinaryKg: 18, protectedKg: 0 }, depositedFuelKg: 12, receivedFuelKg: 0 };
  assert.equal((await run(g, send(origin, "withdraw", "fuel", 1, "fuel"))).reason, "too_far");

  const hauler = () => rig.host.world.industry.drones.find(d => d.id === haul);
  const route = estimateDroneRoute(depot(origin), depot(relay));
  assert.equal(route.legSeconds, 37, "4 km leg includes limited acceleration and braking");
  assert.ok(route.roundTripFuelKg > 0.5 && route.roundTripFuelKg < 0.55, "close propulsion is scaled from the player's actual delta-v cost");
  for (let i = 0; hauler().phase !== "outbound" && i < 75; i++) await ticks(1);
  assert.equal(hauler().phase, "outbound");
  const { fieldId, chunkKey, instanceId } = earthMiningRock;
  for (const world of [rig.host.world, g.session.mirror.data.world, repo.peek().data.world]) {
    assert.equal(world.asteroidDeltas[fieldId][chunkKey].filter(id => id === instanceId).length, 1, "all replicas record the finite rock once");
  }
  const payload = hauler().cargo.fuelKg;
  assert.ok(payload > 0);
  assert.deepEqual(repo.peek().data.world.industry.drones.find(d => d.id === haul), hauler(), "visible departure persisted");
  assert.equal(g.session.mirror.data.world.industry.drones.find(d => d.id === haul).cargo.fuelKg, payload);

  const outbound = structuredClone(hauler());
  const paused = JSON.stringify(rig.host.world.industry);
  rig.host.setClockPaused(true);
  await ticks(1, 1000);
  rig.host.setClockPaused(false);
  await rig.settle();
  assert.equal(JSON.stringify(rig.host.world.industry), paused, "settings pause freezes automation");
  await ticks(1, 60_000);
  assert.deepEqual(hauler(), outbound, "suspension produces no active time");

  rig.net.detachHost();
  await rig.settle();
  ms += 1_800_000;
  await rig.startHost(clock);
  h = await join(rig.client("Host", { local: true }));
  g = await join(rig.client("Guest", { store: g.store }));
  assert.equal(g.session.playerId, pid);
  assert.deepEqual(hauler(), outbound, "host restarted with the same funded round trip");
  await ticks(outbound.remainingS + INDUSTRY_TUNING.deliverySeconds);
  assert.equal(depot(relay).storage.fuelKg, payload);
  assert.equal(repo.peek().data.world.industry.depots.find(d => d.id === relay).storage.fuelKg, payload);
  assert.equal(g.session.mirror.data.world.industry.depots.find(d => d.id === relay).storage.fuelKg, payload);
  const fiscal = repo.commits;
  await ticks(outbound.durationS - 1);
  assert.ok(repo.commits - fiscal < outbound.durationS - 1, "countdowns avoid disk writes");

  for (let i = 0; depot(relay).storage.fuelKg === payload && i < 2 * route.legSeconds + 30; i++) await ticks(1);
  const delivered = depot(relay).storage.fuelKg;
  assert.ok(delivered > payload && delivered <= 600, "next delivery needs no manual supplies");
  const stored = repo.peek().data;
  stored.world.industry.depots[0].storage.items.old_ore = 1;
  assert.equal(parseSaveData(stored).world.industry.depots[0].storage.items.old_ore, 1);

  g.telemetry = { pose: poseAt(relaySite, 0.8), propellant: { ordinaryKg: 18, protectedKg: 0 }, depositedFuelKg: 12, receivedFuelKg: 0 };
  await accepted(g, send(relay, "withdraw", "fuel", 5, "fuel"));
  assert.equal(rig.host.player(pid).propellant.ordinaryKg, 23);
  assert.ok(Math.abs(depot(relay).storage.fuelKg - (delivered - 5)) < 1e-9);

  const legacy = structuredClone(stored);
  const legacyTrip = {
    ...outbound, job: configure(haul, "haul", moonDepot, ["propellant"], 8, 600).job,
    durationS: 204, returnS: 204, remainingS: 1, fuelKg: 41,
    via: { frameId: "earth", positionKm: [0, 8000, 0], fraction: 0.6 },
    cargo: { ...outbound.cargo, fuelKg: 25 },
  };
  delete legacyTrip.flight;
  legacy.world.industry.drones = [legacyTrip];
  for (const d of legacy.world.industry.depots) {
    d.refinery = false;
    d.storage.fuelKg = d.id === moonDepot ? 590 : 0;
  }
  let oldTrip = parseSaveData(legacy).world.industry;
  assert.deepEqual(oldTrip.drones[0], legacyTrip, "the old maximum countdown, return escrow, waypoint and payload survive loading");
  const simulate = n => {
    for (let i = 0; i < n; i++) oldTrip = advanceIndustry(oldTrip, 1).state;
  };
  const balance = id => oldTrip.depots.find(d => d.id === id).storage.fuelKg;
  simulate(1 + INDUSTRY_TUNING.deliverySeconds);
  assert.equal(balance(moonDepot), 600, "a funded pre-change delivery completes up to the saved limit");
  assert.equal(oldTrip.drones[0].remainingS, 204);
  assert.equal(oldTrip.drones[0].cargo.fuelKg, 15);
  simulate(205);
  assert.equal(balance(moonDepot), 600, "the completed trip does not duplicate its delivery");
  assert.equal(balance(origin), 15, "overflow comes back to the original depot");
  assert.equal(oldTrip.drones[0].cargo.fuelKg, 0);
  assert.equal(oldTrip.drones[0].status, "route_out_of_range", "the old job remains visible but cannot dispatch again");
  assert.equal(oldTrip.drones[0].job.targetId, moonDepot);

  return { pass: true, routeKm: Math.round(route.pathKm), legS: route.legSeconds, roundTripKg: route.roundTripFuelKg,
    payload, delivered, bootstrapKg: 12, legacyReturnedKg: balance(origin) };
}

async function industryBounds() {
  const [{ LocalAuthority }, { getIndustrySource, INDUSTRY_TUNING: T }, { parseSaveData }] = await Promise.all([
    S("sim/world/authority.ts"), S("sim/industry/catalog.ts"), S("save/validate.ts"),
  ]);
  const save = defaults.defaultSaveData(HOST_ID);
  const p = save.players[HOST_ID];
  p.cargo.items = { silicates: p.cargo.capacityUnits };
  p.modules.consumables.consumable_hull_patch_kit = 10;
  p.propellant = { ordinaryKg: 7, protectedKg: 100 };
  p.processing = { id: "batch", recipeId: "hydrate_propellant", reserved: { hydrates: 30 }, elapsedS: 0, committedKg: 0 };
  const source = getIndustrySource("earth_hydrates");
  p.ship = poseAt(source, 0.8);
  const depot = { id: "depot", ...source, by: HOST_ID, quaternion: [0, 0, 0, 1], refinery: false, refineProgressS: 0,
    storage: { items: { silicates: T.cargoCapacity - 1 }, consumables: { consumable_hull_patch_kit: 1 }, fuelKg: T.fuelCapacityKg } };
  save.world.industry.depots = [depot];
  const authority = new LocalAuthority({ getWorld: () => save.world, getPlayer: () => p, getPlayers: () => [p],
    markDirty: () => {}, reservedFuel: () => 4 });
  const transfer = (direction, kind, itemId, amount) =>
    authority.submit({ type: "depot.transfer", opId: `bounds-${++opN}`, depotId: depot.id, direction, kind, itemId, amount }, HOST_ID);
  const before = JSON.stringify(save);
  assert.equal(transfer("deposit", "cargo", "silicates", 1).reason, "depot_full");
  assert.equal(transfer("withdraw", "cargo", "silicates", 1).reason, "no_capacity");
  assert.equal(transfer("withdraw", "consumable", "consumable_hull_patch_kit", 1).reason, "stack_full");
  assert.equal(transfer("withdraw", "fuel", "fuel", 1).reason, "tank_full", "onboard batch retains its reserved tank space");
  assert.equal(transfer("deposit", "fuel", "fuel", 1).reason, "depot_full");
  assert.equal(transfer("deposit", "fuel", "fuel", 4).reason, "materials", "never spends protected fuel or the braking reserve");
  assert.equal(JSON.stringify(save), before, "rejected transfers leave both stores intact");

  assert.equal(T.cargoCapacity, 6000);
  assert.equal(T.fuelCapacityKg, 3000);
  const job = stopAt => ({ kind: "extract", targetId: source.id, priorities: ["hydrates"], reserveKg: 0, stopAt, enabled: true });
  save.world.industry.drones = [400, T.cargoCapacity].map(stopAt =>
    ({ id: `extract-${stopAt}`, homeId: depot.id, job: job(stopAt), phase: "idle", status: "departing" }));
  const savedIndustry = parseSaveData(save).world.industry;
  assert.deepEqual(savedIndustry.depots[0].storage, depot.storage, "expanded cargo capacity and separate fuel tank survive load");
  assert.deepEqual(savedIndustry.drones.map(d => d.job), [400, 6000].map(stopAt => ({
    ...job(stopAt), kind: "mine", targetId: source.fieldId, priorities: [], mineFilter: { mode: "resource", ids: ["hydrates"] },
  })), "saved limits survive conversion to finite hydrate-filtered mining");

  const old = structuredClone(save);
  old.schemaVersion = 6;
  delete old.world.industry;
  delete old.players[HOST_ID].depositedFuelKg;
  const migrated = parseSaveData(old);
  assert.deepEqual(migrated.world.industry.depots, []);
  assert.deepEqual(migrated.players[HOST_ID].cargo, p.cargo);
  assert.deepEqual(migrated.players[HOST_ID].propellant, p.propellant);
  assert.equal(migrated.players[HOST_ID].depositedFuelKg, 0);
  return { pass: true };
}

async function industryProspects() {
  const [{ getIndustrySource, DEPOT_KIT_ID }, { prospectWorksite }, { parseSaveData }, { LocalAuthority }] = await Promise.all([
    S("sim/industry/catalog.ts"), S("sim/industry/prospects.ts"), S("save/validate.ts"), S("sim/world/authority.ts"),
  ]);
  const source = getIndustrySource("earth_hydrates");
  const [x, y, z] = source.positionKm;
  const site = [x, y + 0.085, z];
  const data = defaults.defaultSaveData(HOST_ID);
  const depot = { id: "old-depot", by: HOST_ID, name: "Works", frameId: source.frameId,
    positionKm: [x, y + 0.15, z], quaternion: [0, 0, 0, 1] };
  data.world.industry.depots = [depot];
  const saved = parseSaveData(data);
  assert.equal(saved.world.industry.depots.length, 1);
  assert.deepEqual(prospectWorksite(source, saved.world.industry.depots).positionKm, site,
    "a saved Earth depot at the legacy 65 m boundary keeps the worksite in place");

  cc.updateEphemerisPositions(eph.jdFromUnixMs(data.world.simEpochMs));
  const p = data.players[HOST_ID];
  p.ship = poseAt(source, 0.8);
  p.modules.consumables[DEPOT_KIT_ID] = 1;
  data.world.industry.depots = [];
  const authority = new LocalAuthority({ getWorld: () => data.world, getPlayer: () => p, getPlayers: () => [p], markDirty: () => {} });
  const { name, frameId, quaternion } = depot;
  const place = positionKm => authority.submit({ type: "depot.place", opId: `prospect-${++opN}`, name, frameId, quaternion, positionKm }, HOST_ID);
  // From the rendered centre this candidate rounds just above 65 m. The legacy offset
  // calculation rounds below 65 m, so allowing it would move the prospect.
  const nearThreshold = [x + 0.00000003, y + 0.02, z];
  assert.notDeepEqual(prospectWorksite(source, [{ ...depot, positionKm: nearThreshold }]).positionKm, site);
  assert.equal(place(nearThreshold).reason, "near_rock");
  assert.equal(place(source.positionKm).status, "accepted", "the source marker remains clear for a depot");
  assert.deepEqual(prospectWorksite(source, data.world.industry.depots).positionKm, site);
  return { pass: true };
}

async function industryDroneBounds() {
  const [{ getIndustrySource, INDUSTRY_TUNING: T }, { advanceIndustry, planDroneHaul }, { emptyIndustry, emptyStorage }, { estimateDroneRoute }] = await Promise.all([
    S("sim/industry/catalog.ts"), S("sim/industry/simulation.ts"), S("sim/industry/types.ts"), S("sim/industry/route.ts"),
  ]);
  const source = getIndustrySource("earth_hydrates");
  const depot = (id, offsetKm, fuelKg = 0, items = {}) => ({
    ...source, id, name: id, by: HOST_ID, positionKm: [source.positionKm[0] + offsetKm, ...source.positionKm.slice(1)],
    quaternion: [0, 0, 0, 1], refinery: false, refineProgressS: 0, storage: { ...emptyStorage(), fuelKg, items },
  });
  const drone = (id, homeId, job) => ({
    id, homeId, job: { enabled: true, ...job }, phase: "idle", status: "departing", returnS: 0, via: null,
    remainingS: 0, durationS: 0, fuelKg: 0, cargo: emptyStorage(),
  });
  const home = depot("home", 1, 500);
  const relay = depot("relay", 4, T.fuelCapacityKg - 100);
  const hauler = drone("hauler", home.id, { kind: "haul", targetId: relay.id, priorities: ["propellant"], reserveKg: 499.9, stopAt: T.fuelCapacityKg });
  let world = { ...emptyIndustry(), depots: [home, relay], drones: [hauler] };
  const step = (seconds = 1) => { for (let i = 0; i < seconds; i++) world = advanceIndustry(world, 1).state; };
  const ship = () => world.drones[0];
  const editStores = (id, edit) => {
    world.depots = world.depots.map(d => d.id === id ? { ...d, storage: edit(d.storage) } : d);
  };

  step();
  assert.equal(ship().status, "needs_fuel");
  assert.equal(world.depots[0].storage.fuelKg, 500);
  world.drones = [{ ...ship(), job: { ...ship().job, reserveKg: 100 } }];
  const funded = planDroneHaul(home, relay, ship().job, estimateDroneRoute(home, relay)).load;
  step();
  assert.equal(ship().phase, "outbound");
  assert.equal(ship().cargo.fuelKg, 100);
  assert.ok(Math.abs(world.depots[0].storage.fuelKg - (500 - 100 - funded.roundTripFuelKg)) < 1e-9);

  // Players fill both tanks while the manifest is in flight, and recall the ship safely.
  const trip = ship().returnS;
  world.drones = [{ ...ship(), job: { ...ship().job, enabled: false } }];
  for (const id of [home.id, relay.id]) editStores(id, s => ({ ...s, fuelKg: T.fuelCapacityKg }));
  step(2 * trip + T.deliverySeconds);
  assert.equal(ship().status, "unload_blocked");
  assert.equal(ship().cargo.fuelKg, 100);
  assert.equal(world.depots[1].storage.fuelKg, T.fuelCapacityKg);
  step(4);
  assert.equal(ship().cargo.fuelKg, 100);
  editStores(home.id, s => ({ ...s, fuelKg: s.fuelKg - 40 }));
  step();
  assert.equal(ship().status, "unload_blocked");
  assert.equal(ship().cargo.fuelKg, 60);
  editStores(home.id, s => ({ ...s, fuelKg: s.fuelKg - 60 }));
  step(2);
  assert.equal(ship().phase, "idle");
  assert.equal(ship().status, "paused");
  assert.equal(ship().cargo.fuelKg, 0);
  assert.equal(world.depots[0].storage.fuelKg, T.fuelCapacityKg);

  // Carbon is first, but has met its destination stop condition. Silicates take the slot.
  world = { ...emptyIndustry(), depots: [depot(home.id, 1, 500, { carbon: 100, silicates: 80, hydrates: 50 }), depot(relay.id, 4, 0, { carbon: 20 })],
    drones: [drone("priority", home.id, { kind: "haul", targetId: relay.id, priorities: ["carbon", "silicates"], reserveKg: 0, stopAt: 20 })] };
  step();
  assert.deepEqual(ship().cargo.items, { silicates: 20 });
  assert.equal(world.depots[0].storage.items.hydrates, 50);

  // The already-funded synthetic trip can return one last payload and then converts to a finite job.
  const config = { kind: "extract", targetId: source.id, priorities: ["hydrates"], reserveKg: 0, stopAt: T.cargoCapacity };
  const legacy = { ...drone("legacy-extract", home.id, config), phase: "working", status: "extracting",
    remainingS: 1, durationS: T.extractSeconds, returnS: 12, fuelKg: 1 };
  world = { ...emptyIndustry(), depots: [depot(home.id, 1, 100)], drones: [legacy] };
  step();
  assert.equal(ship().job.kind, "extract");
  assert.equal(ship().cargo.items.hydrates, T.extractUnits);
  step(ship().remainingS);
  assert.equal(world.depots[0].storage.items.hydrates, T.extractUnits);
  assert.deepEqual(ship().job.mineFilter, { mode: "resource", ids: ["hydrates"] });
  assert.equal(ship().job.targetId, source.fieldId);
  assert.equal(ship().job.kind, "mine");
  return { pass: true };
}

async function industryDroneClock() {
  const { DroneMotion } = await S("components/Industry/droneMotion.ts");
  const dt = 1 / 60;
  const legS = 22;
  const motion = new DroneMotion();
  const report = elapsedS => ({
    phase: "outbound", remainingS: legS - elapsedS, durationS: legS, returnS: legS, via: null,
    job: { kind: "extract", targetId: "earth_hydrates" },
  });
  let stoppedS = 0, longestStopS = 0, peakRate = 0;
  for (let frame = 0; frame <= 600; frame++) {
    const wallS = frame * dt;
    // The first late packet arrives two seconds after the last one and confirms one second.
    const confirmedS = wallS >= 8 ? Math.floor(wallS) - 1 : Math.min(6, Math.floor(wallS));
    const before = motion.timeS;
    motion.advance(report(confirmedS), dt);
    if (wallS < 6) continue;
    const rate = (motion.timeS - before) / dt;
    stoppedS = rate < 0.015 ? stoppedS + dt : 0;
    longestStopS = Math.max(longestStopS, stoppedS);
    peakRate = Math.max(peakRate, rate);
  }
  assert.ok(longestStopS < 0.15, `the fractional countdown correction stopped for ${longestStopS} s`);
  assert.ok(peakRate <= 1.5 + 1e-6, "snapshot catch-up stays within the visual speed budget");

  // An isolated late packet is distinct from a dead feed. Unsupported prediction
  // still tapers to a stop instead of entering the next phase on its own.
  const finalSnapshot = report(9);
  for (let frame = 0; frame < 300; frame++) motion.advance(finalSnapshot, dt);
  const settledS = motion.timeS;
  assert.ok(settledS <= 11 + 1e-6, "the clock predicts at most two seconds ahead");
  motion.advance(finalSnapshot, dt);
  assert.ok(motion.timeS - settledS < 1e-6, "prediction stops during a prolonged disconnect");
  return { pass: true, longestStopMs: Math.round(longestStopS * 1000), peakRate };
}

async function industryFiniteMining() {
  const [{ LocalAuthority }, { emptyStorage }, { INDUSTRY_TUNING: T }, { planInspection }, { parseSaveData }, { DroneMiningSearch }] = await Promise.all([
    S("sim/world/authority.ts"), S("sim/industry/types.ts"), S("sim/industry/catalog.ts"),
    S("sim/research/discoveries.ts"), S("save/validate.ts"), S("sim/industry/mining.ts"),
  ]);
  const { fieldId, chunkKey, instanceId, frameId, positionKm, radiusM } = earthMiningRock;
  const seeded = newWorld().peek();
  let data = seeded.data;
  const industry = () => data.world.industry;
  const site = earthMiningSite(1.9);
  const depot = { ...site, id: "mine-home", name: "Quarry", by: HOST_ID, quaternion: [0, 0, 0, 1],
    refinery: false, refineProgressS: 0, storage: { ...emptyStorage(), fuelKg: 30, items: {} } };
  const job = { kind: "mine", targetId: fieldId, priorities: [], mineFilter: { mode: "class", ids: ["s_type", "c_type"] },
    reserveKg: 8, stopAt: 6000, enabled: true };
  const drone = { id: "quarry-drone", homeId: depot.id, job, phase: "idle", status: "departing",
    remainingS: 0, durationS: 0, returnS: 0, fuelKg: 0, cargo: emptyStorage(), via: null };
  industry().depots = [depot];
  industry().drones = [drone];
  const inspection = planInspection(data.world.discoveries, {
    fieldId, chunkKey, asteroidId: instanceId, frameId, positionKm, radiusM, classId: "c_type", composition: earthMiningLoot,
  }, false, HOST_ID, 1, new Set());
  data.world.discoveries = inspection.next;
  const sourceId = inspection.next.sources[0].id;
  data.players[HOST_ID].bookmarks = [{ sourceId, label: "Known quarry", createdAt: 1 }];
  const events = [];
  const solo = new LocalAuthority({ getWorld: () => data.world, getPlayer: id => data.players[id], getPlayers: () => Object.values(data.players),
    markDirty: () => {}, getDifficulty: () => "standard" });
  solo.subscribe(e => events.push(e));
  const step = n => { for (let i = 0; i < n; i++) solo.tickIndustry(1); };
  const state = () => industry().drones[0];
  const count = world => (world.asteroidDeltas[fieldId]?.[chunkKey] ?? []).filter(id => id === instanceId).length;
  const depleted = world => world.discoveries.sources.find(s => s.id === sourceId)?.depleted;
  const noEvidence = world => Object.values(world.discoveries.families).every(f => !f.extracted);
  // An entire manifest is required. Setup with two free units and tighten the filter so
  // the marked C-type target stays intact rather than discarding its co-products.
  const cramped = { ...depot.storage, items: { silicates: T.cargoCapacity - 2 } };
  const spacious = structuredClone(data);
  industry().depots[0] = { ...depot, storage: cramped };
  step(1);
  assert.notEqual(state().flight?.rock?.instanceId, instanceId);
  assert.equal(count(data.world), 0);
  data = spacious;
  step(1);
  assert.equal(state().flight.rock.instanceId, instanceId, "the C-type matches the second member of the class OR filter");
  const legS = state().returnS;
  step(legS);
  assert.equal(state().status, "mining");
  const beamS = state().remainingS;
  step(beamS - 1);
  const beforeCommit = structuredClone(data);
  beforeCommit.world.industry.drones[0].job.enabled = false;
  data = parseSaveData(structuredClone(beforeCommit));
  assert.deepEqual(state().flight, beforeCommit.world.industry.drones[0].flight);
  assert.equal(state().remainingS, 1);
  // A duplicate persisted claim should still pay once across the two in-progress drones.
  industry().drones.push({ ...structuredClone(state()), id: "duplicate-claim" });
  step(1);
  assert.equal(count(data.world), 1);
  assert.equal(depleted(data.world), true);
  assert.ok(noEvidence(data.world), "drone depletion grants neither extraction evidence nor a survey");
  assert.ok(events.some(e => e.type === "discoveries.changed"));
  assert.deepEqual(state().cargo.items, earthMiningLoot);
  assert.deepEqual(industry().drones[1].cargo.items, {});
  step(legS + 2);
  assert.deepEqual(industry().depots[0].storage.items, earthMiningLoot);
  assert.equal(count(data.world), 1);

  let ms = 0;
  const clock = { monoMs: () => ms, nowMs: () => Date.UTC(2026, 0, 1) + ms };
  const repo = new MemoryRepository({ ...seeded, data: parseSaveData(structuredClone(beforeCommit)) });
  const rig = new Rig(repo);
  await rig.startHost(clock);
  const guest = rig.client("Miner observer");
  guest.session.o.clock = clock;
  guest.join();
  await rig.settle();
  repo.failNext = 1;
  ms += 1000; rig.host.tick(); await rig.settle();
  assert.equal(count(rig.host.world), 0, "failed economic write rolls back the asteroid");
  assert.equal(depleted(rig.host.world), false);
  assert.equal(rig.host.world.industry.drones[0].remainingS, 1);
  assert.equal(count(guest.session.mirror.data.world), 0, "rollback never reaches the guest");
  assert.equal(rig.host.authority.world().asteroidDeltas[fieldId]?.[chunkKey]?.includes(instanceId) ?? false, false);
  assert.equal(rig.host.authority.asteroids.has(fieldId, chunkKey, instanceId), false, "rollback rebuilds the local asteroid index");
  rig.net.detachHost(); await rig.settle();
  await rig.startHost(clock);
  const again = rig.client("Miner observer", { store: guest.store });
  again.session.o.clock = clock;
  again.join(); await rig.settle();
  for (let i = 0; i < 1 + legS + 2; i++) { ms += 1000; rig.host.tick(); await rig.settle(); }
  for (const world of [rig.host.world, again.session.mirror.data.world, parseSaveData(repo.peek().data).world]) {
    assert.equal(count(world), 1);
    assert.equal(depleted(world), true);
    assert.ok(noEvidence(world));
    assert.deepEqual(world.industry.depots[0].storage.items, earthMiningLoot);
  }
  assert.equal(again.events.filter(e => e.type === "asteroid.destroyed" && e.instanceId === instanceId).length, 1);
  assert.equal(again.events.filter(e => e.type === "discoveries.changed").length, 1);

  const search = new DroneMiningSearch();
  const scouts = Array.from({ length: 6 }, (_, i) => ({ i, ...earthMiningSite(1.9 + i / 10) }));
  const scanned = new Set();
  for (let t = 0; t < 3; t++) {
    search.beginTick();
    for (const scout of search.orderScouts(scouts)) {
      search.find(scout, fieldId, job.mineFilter, "standard", () => false, () => {
        scanned.add(scout.i);
        return false;
      });
    }
  }
  assert.equal(scanned.size, scouts.length, "all six scouts make progress under the shared budget");
  search.clear();
  let probes = 0, result;
  const depletedTarget = () => { probes++; return true; };
  do {
    search.beginTick();
    result = search.find(site, fieldId, job.mineFilter, "standard", depletedTarget, () => false);
  } while (result.searching);
  const scannedOnce = probes;
  assert.ok(scannedOnce > 0);
  search.beginTick();
  assert.equal(search.find(site, fieldId, job.mineFilter, "standard", depletedTarget, () => false).searching, false);
  assert.equal(probes, scannedOnce, "an exhausted neighborhood does not restart its scan");
  return { pass: true, instanceId, legS, beamS, scouts: scanned.size, loot: earthMiningLoot };
}

async function industryFieldRoute() {
  const [routes, { INDUSTRY_TUNING: T }, { advanceIndustry, planDroneHaul }, { emptyStorage }, { parseSaveData }] = await Promise.all([
    S("sim/industry/route.ts"), S("sim/industry/catalog.ts"), S("sim/industry/simulation.ts"),
    S("sim/industry/types.ts"), S("save/validate.ts"),
  ]);
  const field = id => system.asteroidFields.find(f => f.id === id);
  const depot = (f, id, offset, fuelKg = 0, items = {}) => ({
    id, name: id, by: HOST_ID, frameId: f.anchorBody, quaternion: [0, 0, 0, 1],
    positionKm: f.anchorOffsetKm.map((n, i) => n + (i === 0 ? offset : 0)),
    storage: { ...emptyStorage(), fuelKg, items }, refinery: false, refineProgressS: 0,
  });
  const earth = field("origin_belt"), moon = field("luna_belt");
  const home = depot(earth, "Home", -2999, 90, { fe_ni_metal: 55 });
  const relay = depot(earth, "Relay", -849);
  const edge = depot(earth, "Earth edge", 2999);
  const lunarHome = depot(moon, "Lunar home", -1999);
  const lunarRelay = depot(moon, "Lunar relay", 1999);
  const route = routes.estimateDroneRoute(home, relay);
  const acrossEarth = routes.estimateDroneRoute(home, edge);
  const acrossMoon = routes.estimateDroneRoute(lunarHome, lunarRelay);
  assert.equal(route.pathKm, 2150);
  assert.equal(route.profile, "field");
  assert.equal(route.fieldName, earth.name);
  assert.equal(acrossEarth.pathKm, 5998, "opposite edges of the authored 6000 km field connect");
  assert.equal(acrossMoon.pathKm, 3998, "opposite edges of the authored 4000 km field connect");
  assert.equal(routes.checkDroneRoute(home, depot(earth, "Outside", 3001)).reason, "out_of_field");
  assert.equal(routes.checkDroneRoute(home, lunarRelay).reason, "different_frame");
  assert.ok(Math.abs(routes.minimumDroneFlightS(6.0001, "field") - routes.minimumDroneFlightS(5.9999, "field")) < 0.002,
    "crossing the terminal-zone threshold does not jump the travel time");
  assert.equal(routes.droneLegSeconds(4, "field"), routes.droneLegSeconds(4, "local"));
  assert.equal(routes.droneFlightProgress(route.pathKm, route.legSeconds / 2, route.legSeconds, "field"), 0.5);
  let peakMps = 0, terminalPeakMps = 0;
  for (let t = 0; t < route.legSeconds; t += 0.25) {
    const kmBefore = route.pathKm * routes.droneFlightProgress(route.pathKm, t, route.legSeconds, "field");
    const kmAfter = route.pathKm * routes.droneFlightProgress(route.pathKm, t + 0.25, route.legSeconds, "field");
    const mps = (kmAfter - kmBefore) * 4000;
    if (kmAfter <= T.terminalDistanceKm) terminalPeakMps = Math.max(terminalPeakMps, mps);
    peakMps = Math.max(peakMps, mps);
  }
  assert.ok(terminalPeakMps <= 140 + 1e-6 && terminalPeakMps > 130);
  assert.ok(peakMps > 9500 && peakMps < 11000);

  const fullSolid = routes.planDroneLoad(acrossEarth, "fe_ni_metal", T.loadUnits, Infinity);
  const fullFuel = routes.planDroneLoad(acrossEarth, "propellant", T.loadFuelKg, Infinity);
  const leanSolid = routes.planDroneLoad(acrossEarth, "fe_ni_metal", T.loadUnits, 100);
  assert.ok(fullSolid.amount < T.loadUnits && fullSolid.amount > leanSolid.amount, "a heavy load is trimmed to the flight tank or the depot stock");
  assert.ok(fullSolid.roundTripFuelKg <= T.droneTankKg);
  assert.equal(fullFuel.amount, T.loadFuelKg, "transfer propellant cargo uses a separate container");
  assert.ok(fullFuel.roundTripFuelKg > acrossEarth.roundTripFuelKg && fullFuel.roundTripFuelKg < fullSolid.roundTripFuelKg);

  const save = defaults.defaultSaveData(HOST_ID);
  const job = { kind: "haul", targetId: relay.id, enabled: true, priorities: ["fe_ni_metal"], reserveKg: 10, stopAt: 6000 };
  save.world.industry.depots = [home, relay];
  save.world.industry.drones = [{ id: "field-hauler", homeId: home.id, job, phase: "idle", status: "departing",
    remainingS: 0, durationS: 0, returnS: 0, fuelKg: 0, via: null, cargo: emptyStorage() }];
  const manifest = planDroneHaul(home, relay, job, route).load;
  assert.equal(manifest.amount, 40);
  let state = save.world.industry;
  const step = n => { for (let i = 0; i < n; i++) state = advanceIndustry(state, 1).state; };
  const reload = () => {
    save.world.industry = state;
    const restored = parseSaveData(save).world.industry;
    assert.deepEqual(restored, state);
    state = restored;
  };
  const getDrone = () => state.drones[0];
  const balance = () => state.depots[0].storage.fuelKg;
  const returns = () => state.depots[1].storage.items.fe_ni_metal;
  step(1);
  const flight = getDrone();
  assert.equal(flight.phase, "outbound");
  assert.equal(flight.cargo.items.fe_ni_metal, 40);
  assert.equal(flight.fuelKg, manifest.returnFuelKg);
  assert.ok(Math.abs(balance() + manifest.roundTripFuelKg - 90) < 1e-9);
  assert.ok(balance() >= job.reserveKg);
  step(127);
  assert.ok(getDrone().remainingS > 204, "the in-flight countdown exceeds the original validator limit");
  reload();
  state.drones[0] = { ...getDrone(), job: { ...job, enabled: false } };
  step(getDrone().remainingS + T.deliverySeconds);
  assert.equal(returns(), manifest.amount);
  assert.equal(getDrone().phase, "returning");
  const refundKg = manifest.returnFuelKg - route.returnFuelAtDryKg;
  assert.ok(Math.abs(getDrone().fuelKg - refundKg) < 1e-9 && refundKg > 0);
  reload();
  state.depots[0] = { ...state.depots[0], storage: { ...state.depots[0].storage, fuelKg: T.fuelCapacityKg } };
  step(getDrone().remainingS);
  assert.equal(getDrone().status, "unload_blocked");
  reload();
  step(10);
  assert.ok(Math.abs(getDrone().fuelKg - refundKg) < 1e-9, "blocked retries and reloads do not consume or duplicate unused fuel");
  state.depots[0] = { ...state.depots[0], storage: { ...state.depots[0].storage, fuelKg: T.fuelCapacityKg - refundKg / 2 } };
  step(1);
  assert.equal(balance(), T.fuelCapacityKg);
  assert.ok(Math.abs(getDrone().fuelKg - refundKg / 2) < 1e-9, "partial unload saves the still-aboard remainder");
  reload();
  state.depots[0] = { ...state.depots[0], storage: { ...state.depots[0].storage, fuelKg: T.fuelCapacityKg - refundKg } };
  step(10);
  assert.ok(Math.abs(balance() - (T.fuelCapacityKg - refundKg / 2)) < 1e-9);
  assert.equal(getDrone().phase, "idle");
  assert.equal(getDrone().fuelKg, 0);
  assert.equal(returns(), manifest.amount);
  return { pass: true, routeKm: route.pathKm, legS: route.legSeconds, peakMps: Math.round(peakMps), emptyKg: route.roundTripFuelKg,
    loadedKg: manifest.roundTripFuelKg, refundKg, maxEarthLegS: acrossEarth.legSeconds, maxEarthCargoUnits: fullSolid.amount,
    maxMoonLegS: acrossMoon.legSeconds };
}

async function industryWire() {
  const [{ getIndustrySource, INDUSTRY_TUNING: T }, { RELIABLE_UPDATE_BYTES }] = await Promise.all([
    S("sim/industry/catalog.ts"), S("sim/session/protocol.ts"),
  ]);
  const source = getIndustrySource("earth_hydrates");
  const seeded = newWorld().peek();
  const industry = seeded.data.world.industry;
  const longId = (prefix, i) => `${prefix}:${i}:${"x".repeat(120)}`;
  // Unknown warehouse stock remains on import and can require a larger command patch.
  const imported = Object.fromEntries(Array.from({ length: 155 }, (_, i) => [longId("legacy", i), 1]));
  for (let i = 0; i < T.maxDepots; i++) {
    industry.depots.push({
      ...source, id: longId("depot", i), name: "倉".repeat(32), by: HOST_ID,
      quaternion: [0, 0, 0, 1],
      positionKm: [source.positionKm[0] + i + 1, ...source.positionKm.slice(1)],
      refinery: false, refineProgressS: 0, storage: { items: i === 0 ? imported : {}, fuelKg: 0, consumables: {} },
    });
    for (let j = 0; j < T.dronesPerDepot; j++) {
      industry.drones.push({
        id: longId("drone", i * T.dronesPerDepot + j), homeId: longId("depot", i),
        job: { kind: "haul", targetId: longId("depot", (i + 1) % T.maxDepots), priorities: ["propellant", "carbon", "silicates"], enabled: true, reserveKg: 0, stopAt: 600 },
        phase: "outbound", status: "departing", remainingS: 50, durationS: 80, returnS: 80, via: null,
        fuelKg: 16, cargo: { fuelKg: T.loadFuelKg, items: {}, consumables: {} },
      });
    }
  }
  const rig = new Rig(new MemoryRepository(seeded));
  let ms = 0;
  await rig.startHost({ monoMs: () => ms, nowMs: () => ms });
  const c = rig.client("Browser", { local: true });
  c.join();
  await rig.settle();
  let cursor = 0;
  let largestPacket = 0;
  function checkPackets() {
    const messages = rig.net.toClientLog.slice(cursor).map(([, m]) => m);
    cursor = rig.net.toClientLog.length;
    largestPacket = Math.max(largestPacket, ...messages.map(m => Buffer.byteLength(JSON.stringify(m))));
    assert.ok(largestPacket <= RELIABLE_UPDATE_BYTES);
    return messages.filter(m => m.t === "fragment");
  }
  assert.equal(c.session.mirror.data.world.industry.drones.length, T.maxDepots * T.dronesPerDepot);
  checkPackets();
  ms += 1_000;
  rig.host.tick();
  await rig.settle();
  const auto = checkPackets();
  assert.ok(auto.length > 1, "maximum drone update exceeds an unfragmented command packet");
  assert.ok(c.session.mirror.data.world.industry.drones.every(d => d.remainingS === 49));
  assert.equal(c.events.filter(e => e.type === "industry.changed").length, 1, "fragments publish one atomic patch");

  const depot = industry.depots[0];
  c.pose = poseAt(depot, 0.8);
  c.session.submit({ type: "depot.transfer", opId: "wire-commit", depotId: depot.id, direction: "deposit", kind: "fuel", itemId: "fuel", amount: 1 });
  await rig.settle();
  const commit = checkPackets();
  assert.ok(commit.length > 1, "the large imported depot commit is fragmented too");
  assert.equal(c.settled.at(-1).status, "accepted");
  assert.equal(c.session.mirror.data.world.industry.depots[0].storage.fuelKg, 1);
  assert.deepEqual(c.session.mirror.data.world.industry.depots[0].storage.items, imported);
  return { pass: true, largestPacket, droneDeltaBytes: Buffer.byteLength(auto.map(m => m.json).join("")),
    commitDeltaBytes: Buffer.byteLength(commit.map(m => m.json).join("")) };
}

async function industrySaveFailure() {
  const { getIndustrySource } = await S("sim/industry/catalog.ts");
  const stored = newWorld().peek();
  const source = getIndustrySource("earth_hydrates");
  stored.data.world.industry.depots = [{
    ...source, id: "refinery", by: HOST_ID, quaternion: [0,0,0,1], refinery: true,
    storage: { items: { hydrates: 1 }, fuelKg: 0, consumables: {} }, refineProgressS: 1,
  }];
  const repo = new MemoryRepository(stored);
  const rig = new Rig(repo);
  let ms = 0;
  await rig.startHost({ monoMs: () => ms, nowMs: () => ms });
  const h = rig.client("Host", { local: true });
  h.join();
  await rig.settle();
  repo.failNext = 1;
  ms += 1000;
  rig.host.tick();
  await rig.settle();
  assert.equal(rig.host.status, "storage_failed");
  const unchanged = { items: { hydrates: 1 }, fuelKg: 0, consumables: {} };
  assert.deepEqual(rig.host.world.industry.depots[0].storage, unchanged);
  assert.deepEqual(repo.peek().data.world.industry.depots[0].storage, unchanged);
  assert.deepEqual(h.session.mirror.data.world.industry.depots[0].storage, unchanged);
  return { pass: true };
}

async function structureNames() {
  const save = newWorld().peek();
  const pose = { frameId: "earth", positionKm: [10000, 0, 0], quaternion: [0, 0, 0, 1], by: HOST_ID };
  save.data.world.industry.depots.push({ ...pose, id: "kiln", name: "Depot 1", refinery: false, refineProgressS: 0,
    storage: { fuelKg: 75, items: {}, consumables: {} } });
  save.data.world.replication.points.push({ ...pose, id: "refuge", name: "Point 1", starter: false, createdAt: 1 });
  const repo = new MemoryRepository(save);
  const { rig, h, g } = await joinedPair(repo);
  const depot = { type: "depot.rename", depotId: "kiln", name: "  Lunar   kiln ", opId: "name-kiln" };
  const point = { type: "replication.rename", pointId: "refuge", name: "Lunar refuge", opId: "name-refuge" };
  const rename = async (client, op) => {
    client.session.submit(op);
    await rig.settle();
    return client.settled.at(-1);
  };
  assert.equal((await rename(g, depot)).status, "accepted");
  assert.equal((await rename(h, point)).status, "accepted");
  assert.equal((await rename(g, { ...depot, opId: "rename-again", name: "Kiln II" })).status, "accepted");
  assert.equal((await rename(g, depot)).status, "duplicate");
  assert.equal((await rename(h, { ...depot, name: "  ", opId: "empty-name" })).reason, "invalid");
  for (const world of [h.session.mirror.data.world, g.session.mirror.data.world, repo.peek().data.world]) {
    assert.equal(world.replication.points.find(p => p.id === "refuge").name, "Lunar refuge");
    assert.equal(world.industry.depots[0].name, "Kiln II");
    assert.equal(world.industry.depots[0].storage.fuelKg, 75);
  }
  return { pass: true };
}

async function replicationFuelTanks() {
  const [{ POINT_TANK_CAPACITY_KG: capacity, POINT_TANK_RECIPE: recipe, INDUSTRY_TUNING: T },
    { estimateDroneRoute }, { parseSaveData }, { DEFAULT_RESOURCE_TUNING: tuning }, { emptyStorage }] = await Promise.all([
    S("sim/industry/catalog.ts"), S("sim/industry/route.ts"), S("save/validate.ts"), S("sim/ship/resourceTuning.ts"), S("sim/industry/types.ts"),
  ]);
  let ms = 0;
  const clock = { monoMs: () => ms, nowMs: () => Date.UTC(2026, 0, 1) + ms };
  const fixture = newWorld().peek();
  const point = {
    id: "recovery-fuel", name: "Refuge", frameId: "earth", positionKm: [10_000, 0, 0], quaternion: [0, 0, 0, 1],
    by: HOST_ID, starter: false, createdAt: 1,
  };
  const home = { ...point, id: "home", name: "Fuel depot", positionKm: [10_001.5, 0, 0], refinery: false, refineProgressS: 0,
    storage: { ...emptyStorage(), fuelKg: 300 } };
  fixture.data.world.replication.points.push(point);
  fixture.data.world.industry.depots.push(home);
  fixture.data.world.industry.drones.push({
    id: "point-hauler", homeId: home.id, phase: "idle", status: "unassigned", job: null, cargo: emptyStorage(),
    remainingS: 0, durationS: 0, returnS: 0, fuelKg: 0, via: null,
  });
  const seed = fixture.data.players[HOST_ID];
  seed.cargo.items = { fe_ni_metal: 200, silicates: 100 };
  seed.replication.activeId = point.id;
  seed.modules.ownedModules.push("module_aux_tank_mk1");
  seed.modules.equippedModules.cargo = "module_aux_tank_mk1";
  const repo = new MemoryRepository(fixture);
  const { rig, h, g } = await joinedPair(repo, clock);
  const gid = g.session.playerId;
  const identity = { frameId: point.frameId, positionKm: [10_000.8, 0, 0], quaternion: point.quaternion };
  const stock = () => rig.host.world.industry.pointTanks[point.id];
  const currentDrone = () => rig.host.world.industry.drones[0];
  const run = async (client, args) => {
    client.session.submit({ opId: `point-tank-${++opN}`, ...args });
    await rig.settle();
    return client.settled.at(-1);
  };
  const ok = async (client, args) => {
    const res = await run(client, args);
    assert.equal(res.status, "accepted", JSON.stringify(res));
    return res.result;
  };
  const moveFuel = (direction, amount, opId) => ({ type: "replication.tank.transfer", pointId: point.id, direction, amount, ...(opId && { opId }) });
  const tick = async count => {
    for (let i = 0; i < count; i++) {
      ms += 1000;
      rig.host.tick();
      await rig.settle();
    }
  };
  h.telemetry = { pose: identity, propellant: { ordinaryKg: 1000, protectedKg: tuning.recoveryAllowanceKg } };
  const install = { type: "replication.tank.install", pointId: point.id, opId: "install-refuge" };
  assert.equal((await run(h, install)).reason, "locked");
  await ok(h, { type: "research.devSet", nodeIds: ["lg1_bulk_handling"] });
  assert.equal((await run(h, { ...install, pointId: "starter" })).reason, "not_found");
  await ok(h, install);
  assert.equal(stock(), 0);
  assert.equal((await run(h, install)).status, "duplicate");
  assert.equal((await run(h, { ...install, opId: "install-refuge-again" })).reason, "already_done");
  assert.deepEqual(rig.host.player(HOST_ID).cargo.items, { fe_ni_metal: 200 - recipe.fe_ni_metal, silicates: 100 - recipe.silicates });
  await ok(h, moveFuel("deposit", 100, "prime-point-tank"));
  assert.equal((await run(h, moveFuel("deposit", 100, "prime-point-tank"))).status, "duplicate");
  assert.equal((await run(h, moveFuel("deposit", 901))).reason, "materials", "Protected fuel cannot be deposited");
  g.telemetry = { pose: { ...identity, positionKm: [10_020, 0, 0] }, propellant: { ordinaryKg: 600, protectedKg: 0 } };
  assert.equal((await run(g, moveFuel("withdraw", 10))).reason, "too_far");
  g.telemetry.pose = identity;

  const job = { kind: "haul", targetKind: "point", targetId: point.id, priorities: ["propellant"], reserveKg: 20, stopAt: 220, enabled: true };
  const configure = next => ({ type: "drone.configure", droneId: "point-hauler", job: next });
  assert.equal((await run(h, configure({ ...job, priorities: ["silicates"] }))).reason, "invalid", "A point tank accepts ordinary fuel only");
  assert.equal((await run(h, configure({ ...job, stopAt: capacity + 1 }))).reason, "invalid");
  await ok(h, configure(job));
  await tick(1);
  const route = estimateDroneRoute(home, point);
  assert.equal(currentDrone().cargo.fuelKg, 120);
  assert.ok(rig.host.world.industry.depots[0].storage.fuelKg < home.storage.fuelKg - 120, "Source funds both payload and flight");
  const reloaded = parseSaveData(repo.peek().data).world.industry;
  assert.deepEqual(reloaded.drones[0], currentDrone(), "In-flight point job and reserved fuel survive parsing");
  assert.equal(reloaded.pointTanks[point.id], 100);
  await tick(route.legSeconds + T.deliverySeconds);
  assert.equal(stock(), 220);
  assert.equal(repo.peek().data.world.industry.pointTanks[point.id], 220, "The delivery is durable before publication");
  assert.equal(g.session.mirror.data.world.industry.pointTanks[point.id], 220);

  await ok(h, moveFuel("deposit", 900));
  await ok(g, moveFuel("deposit", capacity - 1120));
  assert.equal(stock(), capacity);
  assert.equal((await run(g, moveFuel("deposit", 1))).reason, "point_tank_full");
  await ok(g, { type: "replication.activate", pointId: point.id });
  const destroy = { type: "ship.destroy", frameId: point.frameId, positionKm: identity.positionKm };
  await ok(h, destroy);
  await ok(g, destroy);
  const preRecoveryRevision = rig.host.world.revision;
  const recover = opId => ({ type: "ship.respawn", opId, mode: "active" });
  rig.net.dropNextToClient(g.conn, message => message.t === "settled");
  h.session.submit(recover("refuge-recover-aux"));
  g.session.submit(recover("refuge-recover-base"));
  await rig.settle();
  assert.equal(h.settled.at(-1).result.ordinaryKg, 1000);
  assert.equal(rig.host.player(gid).propellant.ordinaryKg, capacity - 1000);
  assert.equal(stock(), 0);
  for (const playerId of [HOST_ID, gid]) assert.equal(rig.host.player(playerId).propellant.protectedKg, tuning.recoveryAllowanceKg);
  assert.equal(h.session.mirror.data.world.industry.pointTanks[point.id], 0);
  assert.equal(g.session.mirror.data.world.industry.pointTanks[point.id], 0);

  const stale = { t: "tel", gen: h.session.generation, tel: { revision: preRecoveryRevision, pose: identity,
    propellant: { ordinaryKg: 0, protectedKg: 0 }, health: 0 } };
  const recoveryPose = structuredClone(rig.host.player(HOST_ID).ship);
  rig.host.receive(h.conn, "cmd", stale);
  await rig.settle();
  assert.deepEqual(rig.host.player(HOST_ID).ship, recoveryPose);
  assert.equal(rig.host.player(HOST_ID).propellant.ordinaryKg, 1000, "A delayed telemetry sample cannot overwrite the award");
  const hp = rig.host.player(HOST_ID);
  h.telemetry = { pose: recoveryPose, propellant: { ordinaryKg: 992, protectedKg: hp.propellant.protectedKg },
    depositedFuelKg: hp.depositedFuelKg, receivedFuelKg: hp.receivedFuelKg };
  h.session.sendTelemetry();
  await rig.settle();
  assert.equal(rig.host.player(HOST_ID).propellant.ordinaryKg, 992, "A fresh sample can spend the awarded ordinary fuel");

  rig.net.disconnect(g.conn);
  await rig.settle();
  const g2 = rig.client("Guest", { store: g.store });
  g2.join();
  await rig.settle();
  assert.equal(g2.settled.at(-1).result.ordinaryKg, capacity - 1000, "Lost respawn reply replays the already committed award");
  assert.equal(stock(), 0);

  const failureFixture = newWorld().peek();
  failureFixture.data.world.replication.points.push(point);
  failureFixture.data.world.industry.pointTanks[point.id] = 300;
  Object.assign(failureFixture.data.players[HOST_ID], { isDead: true, replication: { activeId: point.id }, propellant: { ordinaryKg: 0, protectedKg: 0 } });
  const failingRepo = new MemoryRepository(failureFixture);
  const failed = await joinedPair(failingRepo, clock);
  failingRepo.failNext = 1;
  failed.h.session.submit(recover("failed-recovery"));
  await failed.rig.settle();
  assert.equal(failed.rig.host.status, "storage_failed");
  assert.equal(failed.rig.host.world.industry.pointTanks[point.id], 300);
  assert.equal(failed.rig.host.player(HOST_ID).isDead, true);
  const backup = parseSaveData(failingRepo.peek().data);
  assert.equal(backup.world.industry.pointTanks[point.id], 300);
  assert.equal(backup.players[HOST_ID].propellant.ordinaryKg, 0);
  const retried = await joinedPair(failingRepo, clock);
  retried.h.session.submit(recover("failed-recovery"));
  await retried.rig.settle();
  assert.equal(retried.h.settled.at(-1).result.ordinaryKg, 300);
  assert.equal(failingRepo.peek().data.world.industry.pointTanks[point.id], 0);
  assert.equal(failingRepo.peek().data.players[HOST_ID].propellant.ordinaryKg, 300);

  const bypass = await joinedPair(new MemoryRepository(failureFixture), clock);
  bypass.h.session.submit({ ...recover("emergency-origin-recovery"), mode: "starter" });
  await bypass.rig.settle();
  const fallback = bypass.h.settled.at(-1).result;
  assert.equal(fallback.destination.pointId, "starter");
  assert.equal(fallback.ordinaryKg, 0);
  assert.equal(fallback.protectedKg, tuning.recoveryAllowanceKg);
  assert.equal(bypass.rig.host.world.industry.pointTanks[point.id], 300, "A recovery at Origin does not debit a remote point");
  return { pass: true, droneKg: 120, upgradedRecoveryKg: 1000, secondRecoveryKg: capacity - 1000, failedRecoveryRetried: true, originStockUntouched: true };
}

const SCENARIOS = {
  replicationFuelTanks,
  industryResearch,
  structureNames,
  industry,
  industrySaveFailure,
  industryBounds,
  industryProspects,
  industryDroneBounds,
  industryDroneClock,
  industryFiniteMining,
  industryFieldRoute,
  industryWire,
  suspendedHost,
  ...(process.argv[2]?.split(",").includes("contentFixture") && { contentFixture }),
  expedition,
  sharedLoop,
  pilotActions,
  shipLifecycle,
  raceHostFirst: () => race("host"),
  raceGuestFirst: () => race("guest"),
  dropReplyRetry,
  hostRestart,
  lunarRemote,
  receiptEviction,
  guestBerths,
  menuClock,
  oldGeneration,
  storageFailure,
  activityBounds,
  hardening,
  renameAndActivity,
  renameHardening,
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
