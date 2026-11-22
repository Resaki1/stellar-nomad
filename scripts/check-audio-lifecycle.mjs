#!/usr/bin/env node
// Test real voice/emitter control flow with a small Web Audio node double.
// DSP stays covered by __audio.selftest() in the browser, not by these doubles.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
const require = createRequire(import.meta.url);
const ts = require("typescript");
let unlocked = false;
let now = 0;
let time = 12;
const queued = [], sources = [], gains = [], timers = [], oscillators = [];
class Param {
  value = 0;
  commands = [];
  cancelScheduledValues(t) { this.commands.push(["cancel", t]); }
  setValueAtTime(v, t) { this.value = v; this.commands.push(["set", v, t]); }
  linearRampToValueAtTime(v, t) { this.value = v; this.commands.push(["ramp", v, t]); }
}
const node = () => ({ connect() {}, disconnect() {} });
const ctx = {
  get currentTime() { return time; },
  createGain() { const n = { ...node(), gain: new Param() }; gains.push(n); return n; },
  createBiquadFilter() { return { ...node(), frequency: new Param(), Q: new Param() }; },
  createPanner: node,
  createOscillator() {
    const osc = { ...node(), frequency: new Param(), start(at) { this.startAt = at; }, stop(at) { this.stopAt = at; } };
    oscillators.push(osc); return osc;
  },
  createBufferSource() {
    const src = { ...node(), detune: new Param(), stopped: false,
      start(at, offset) { this.startAt = at; this.offset = offset; },
      stop() { this.stopped = true; },
    };
    sources.push(src); return src;
  },
};
const engine = { ctx, buses: Object.fromEntries(["ui", "sfxShip", "sfxWorld", "ambience", "music"].map((id) => [id, node()])) };
const mocks = {
  "./engine": {
    dbToGain: (db) => 10 ** (db / 20), ensureEngine: () => engine,
    isAudioUnlocked: () => unlocked, queueUntilUnlocked: (id) => queued.push(id),
    setParamNow: (param, value) => { param.value = value; },
    setParamSmooth: (param, value) => { param.value = value; }, setPendingFlushHandler() {},
  },
  "./loader": { getCachedBuffer: () => ({ duration: 6 }), loadAudioFile() {} },
  "./spatial": {
    applyPannerPosition() {}, configurePanner() {}, gainForDistance: () => 1,
    distanceToListener: () => 0, CULL_ENTER_GAIN: 0.01, CULL_EXIT_GAIN: 0.005,
  },
  "./acoustics": { acousticsForBody: () => null, propagationFor: () => ({ gain: 0, cutoffHz: 100 }) },
  "./shipBuffer": { audioShipBuffer: { atmoBodyId: null, altitudeKm: 0 } },
};
function load(file, extra = {}) {
  const loaded = { exports: {} };
  const code = ts.transpileModule(readFileSync(resolve(file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(code, { module: loaded, exports: loaded.exports, console,
    process: { env: { NODE_ENV: "test" } }, performance: { now: () => now },
    window: { setTimeout: (fn) => timers.push(fn) },
    require(id) {
      const mod = extra[id] ?? mocks[id];
      if (!mod) throw new Error(`Unexpected dependency ${id}`);
      return mod;
    },
  }, { filename: file });
  return loaded.exports;
}
const catalogue = load("src/data/audioEvents.ts");
const voices = load("src/audio/voices.ts", { "@/data/audioEvents": catalogue });
const emitters = load("src/audio/emitters.ts", { "@/data/audioEvents": catalogue, "./voices": voices });
const tick = () => { now += 100; time += 0.1; emitters.updateEmitters(); };
const flushStops = () => { while (timers.length) timers.shift()(); };
let checks = 0;
function check(description, fn) { fn(); checks++; console.log(`PASS ${description}`); }

check("locked emitters never queue orphan loops; one-shots can queue", () => {
  const e = emitters.registerEmitter({ event: "mining.laser.loop", intensity: 0.2 });
  tick(); tick(); tick();
  assert.equal(queued.length, 0);
  voices.playAudio("click.soft");
  assert.deepEqual(queued, ["click.soft"]);
  e.stop(); unlocked = true; tick();
  assert.equal(voices.activeVoiceCount(), 0);
});
check("first loop sample uses evaluated intensity and a fade", () => {
  const e = emitters.registerEmitter({ event: "mining.laser.loop", intensity: 0.2 });
  tick();
  const gain = gains[0].gain;
  const expected = 10 ** (-2 / 20) * 0.2;
  assert.ok(Math.abs(gain.value - expected) < 1e-9);
  assert.equal(gain.commands[0][0], "cancel");
  assert.equal(gain.commands[1][1], 0);
  assert.equal(gain.commands[2][0], "set");
  assert.equal(gain.commands[2][2], sources.at(-1).startAt);
  assert.equal(gain.commands[3][0], "ramp");
  e.stop(); flushStops();
  assert.equal(voices.activeVoiceCount(), 0);
});
check("engine beds rejoin the shared phase when promoted at different times", () => {
  const a = emitters.registerEmitter({ event: "ship.engine.idle", intensity: 1 });
  tick(); const idle = sources.at(-1);
  time += 2.3;
  const b = emitters.registerEmitter({ event: "ship.engine.mid", intensity: 0.5 });
  tick(); const mid = sources.at(-1);
  for (const src of [idle, mid]) assert.ok(Math.abs(src.offset - src.startAt % 6) < 1e-9);
  a.stop(); b.stop(); flushStops();
});
check("reused gains cancel the previous loop envelope before a one-shot", () => {
  const serial = voices.playAudio("click.hard");
  assert.notEqual(serial, null);
  assert.equal(gains[0].gain.commands.at(-2)[0], "cancel");
  assert.equal(gains[0].gain.commands.at(-1)[0], "set");
  voices.stopVoiceBySerial(serial, 0);
});
check("culling, re-promotion and external voice stops retain emitter ownership", () => {
  const e = emitters.registerEmitter({ event: "mining.laser.loop", intensity: 1 });
  tick(); assert.equal(voices.activeVoiceCount(), 1);
  e.setIntensity(0); tick(); flushStops(); assert.equal(voices.activeVoiceCount(), 0);
  e.setIntensity(1); tick(); assert.equal(voices.activeVoiceCount(), 1);
  voices.stopAllVoices(); tick(); assert.equal(voices.activeVoiceCount(), 1);
  assert.equal(voices.voiceSnapshots()[0].emitterId, e.id);
  e.stop(); flushStops(); tick(); assert.equal(voices.activeVoiceCount(), 0);
  assert.equal(emitters.emitterCount(), 0);
});
check("air-coupled fixture never acquires a voice in vacuum", () => {
  const e = emitters.registerEmitter({ event: "station.vent.loop", intensity: 1 });
  tick(); assert.equal(voices.activeVoiceCount(), 0); e.stop();
});
check("coasting has no engine voices or retired content", () => {
  const { engineLayerGain } = load("src/audio/engineLayers.ts");
  const engines = ["ship.engine.idle", "ship.engine.mid", "ship.engine.high"].map((event, layer) =>
    emitters.registerEmitter({ event, intensity: () => engineLayerGain(layer, 0) }));
  tick(); assert.equal(voices.activeVoiceCount(), 0);
  assert.equal(catalogue.tryGetAudioEvent("ship.rcs.thrust"), undefined);
  assert.equal(catalogue.tryGetAudioEvent("ambience.cockpit"), undefined);
  engines.forEach((e) => e.stop());
});
check("mining handoff overlaps only the startup edge; ticks preserve the full attack", () => {
  const { CUTTER_HANDOFF_S, CUTTER_ATTACK_MS } = load("src/audio/miningFeedback.ts");
  const intro = voices.playAudio("mining.laser.start", { queueOnUnlock: false });
  assert.notEqual(intro, null);
  const end = voices.voiceEndTime(intro);
  assert.ok(end > time);
  const e = emitters.registerEmitter({ event: "mining.laser.loop", startAtS: end - CUTTER_HANDOFF_S, fadeInMs: CUTTER_ATTACK_MS });
  tick();
  const sustain = sources.at(-1);
  assert.equal(sustain.startAt, end - CUTTER_HANDOFF_S);
  const gain = gains[1].gain;
  const count = gain.commands.length;
  tick(); tick();
  assert.equal(gain.commands.length, count);
  time = sustain.startAt + 0.02;
  voices.setVoiceGain(voices.voiceSnapshots().find((v) => v.loop).serial, 0.1);
  assert.equal(gain.commands.length, count);
  assert.ok(gain.value > 0.1, "tick overwrote the attack envelope");
  // Cancelling during ignition stops both sources, including the future one.
  voices.stopVoiceBySerial(intro, 20); e.stop(); flushStops();
  assert.equal(sustain.stopped, true);
  assert.equal(voices.activeVoiceCount(), 0);
  unlocked = false;
  const queuedBefore = queued.length;
  voices.playAudio("mining.laser.start", { queueOnUnlock: false });
  assert.equal(queued.length, queuedBefore);
  unlocked = true;
});
check("heat changes the existing loop without restarting; promotion starts at current heat", () => {
  const { cutterPitchCents } = load("src/audio/miningFeedback.ts");
  let heat = 0.4;
  const e = emitters.registerEmitter({ event: "mining.laser.loop", pitchCents: () => cutterPitchCents(heat) });
  tick(); const source = sources.at(-1), count = sources.length;
  assert.equal(source.detune.value, cutterPitchCents(heat));
  heat = 1; tick();
  assert.equal(sources.length, count);
  assert.equal(source.detune.value, 350);
  assert.ok(cutterPitchCents(1) - cutterPitchCents(0.75) > cutterPitchCents(0.75) - cutterPitchCents(0));
  assert.equal(cutterPitchCents(NaN), 0);
  e.stop(); flushStops();
});
check("scanner progress, lock, lost focus and successful mining are distinct", () => {
  const { targetFeedbackCue: cue } = load("src/audio/miningFeedback.ts");
  const idle = { target: null, step: 0, focused: false, mined: 0, enabled: true };
  const acquire = { ...idle, target: "field:1", step: 1 };
  const locked = { ...acquire, step: 6, focused: true };
  assert.equal(cue(idle, { ...acquire, step: 0 }), null);
  assert.equal(cue(idle, acquire), "mining.target.acquire");
  assert.equal(cue(acquire, acquire), null);
  assert.equal(cue(acquire, locked), "mining.target.lock");
  assert.equal(cue(locked, idle), "mining.target.lost");
  assert.equal(cue(locked, { ...acquire, target: "field:2" }), "mining.target.lost");
  assert.equal(cue(locked, { ...idle, mined: 1 }), null);
  assert.equal(cue(locked, { ...idle, enabled: false }), null);
  assert.equal(cue(acquire, idle), null);
});
check("death cancels sounding/future alarms and unregisters the repeating hull alert", () => {
  const alarms = load("src/audio/alarms.ts");
  const alerts = load("src/audio/alerts.ts", { "./alarms": alarms });
  alerts.registerAlert("hull"); alerts.updateAlert("hull", 0.05);
  alarms.playAlarm("caution");
  const playing = oscillators.slice();
  assert.ok(playing.length > 2);
  alarms.setAlarmsEnabled(false); alerts.unregisterAlert("hull");
  assert.ok(playing.every((osc) => osc.stopAt <= time + 0.016));
  now += 20000; alerts.pumpAlerts(); alarms.playAlarm("critical");
  assert.equal(oscillators.length, playing.length);
  // Respawn is a new alert episode, rather than a permanently muted system.
  alarms.setAlarmsEnabled(true); alerts.registerAlert("hull"); alerts.updateAlert("hull", 1);
  assert.equal(oscillators.length, playing.length);
  alerts.updateAlert("hull", 0.05);
  assert.ok(oscillators.length > playing.length);
  alarms.stopAllAlarms(); alerts.unregisterAlert("hull"); flushStops();
});
console.log(`${checks}/${checks} lifecycle checks passed (node doubles; browser DSP tested separately).`);
