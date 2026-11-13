"use client";

// ---------------------------------------------------------------------------
// window.__audio — the audio dev harness. docs/AUDIO_PLAN.md §9.1.
//
// Mirrors the established __dev / __bench / __lum precedent (DevTools.tsx,
// space/perf/*). Development only.
//
//   __audio.state()            context, tick, pool, load stats
//   __audio.play(id, opts?)    fire any catalogued event
//   __audio.voices()           active voice table
//   __audio.emitters()         registered emitter table
//   __audio.events()           the catalogue
//   __audio.emit(id, dist?)    register a test emitter at a distance
//   __audio.stress(n)          fire n voices at random positions (Gate EA-2/4)
//   __audio.silence()          stop everything
//   __audio.listener(mode)     force a listener mode (A2 seam)
//   __audio.wind()             the q = ½ρv² bed: density, q, per-layer gain
//   __audio.music(cmd?, id?)    music director state; play / skip / stop
//   __audio.lastJson           copyable report, like __bench.lastJson
// ---------------------------------------------------------------------------

import { useEffect } from "react";

import {
  ALL_AUDIO_EVENTS,
  tryGetAudioEvent,
  type AudioEventId,
} from "@/data/audioEvents";
import {
  armCapture,
  ensureEngine,
  getEngine,
  isAudioUnlocked,
} from "@/audio/engine";
import {
  playAudio,
  voiceSnapshots,
  activeVoiceCount,
  stopAllVoices,
  poolSize,
  MAX_VOICES,
  type PlayOptions,
} from "@/audio/voices";
import {
  registerEmitter,
  emitterSnapshots,
  emitterCount,
  stopAllEmitters,
} from "@/audio/emitters";
import { loadStats } from "@/audio/loader";
import { tickStats } from "@/audio/tick";
import { reportAudioSelfTest } from "@/audio/selftest";
import { setListenerMode, type ListenerMode } from "@/audio/spatial";
import {
  allAcoustics,
  acousticsForBody,
  impedanceCoupling,
  absorptionDbPerM,
  densityAtAltitude,
} from "@/audio/acoustics";
import { windLayerGain, windState } from "@/audio/wind";
import { musicDebug, playMusicNow, seekMusicToEnd, skipMusic, stopMusic } from "@/audio/music";
import { getDominantAtmosphereBody } from "@/components/space/atmospherePass";
import { playAlarm, ALARM_TIERS, type AlarmTier } from "@/audio/alarms";
import {
  registerAlert,
  updateAlert,
  alertSnapshots,
  acknowledgeAlert,
} from "@/audio/alerts";

type AudioHarness = {
  state(): unknown;
  play(id: string, opts?: PlayOptions): number | null;
  voices(): unknown;
  emitters(): unknown;
  events(): unknown;
  emit(id: string, distanceM?: number): unknown;
  stress(n?: number): unknown;
  capture(ms?: number): Promise<unknown>;
  alarm(tier?: AlarmTier): unknown;
  alerts(): unknown;
  selftest(): Promise<boolean>;
  acoustics(bodyId?: string): unknown;
  absorption(bodyId?: string, altitudeKm?: number, distanceM?: number): unknown;
  here(): unknown;
  wind(): unknown;
  music(cmd?: "play" | "skip" | "stop" | "end", id?: string): unknown;
  setAlert(id: string, value01: number): unknown;
  ackAlert(id: string): void;
  silence(): void;
  listener(mode: ListenerMode): void;
  lastJson: string;
};

export default function AudioDevTools() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;

    const report = () => {
      const e = getEngine();
      const load = loadStats();
      return {
        context: e
          ? {
              state: e.ctx.state,
              sampleRate: e.ctx.sampleRate,
              baseLatencyMs:
                Math.round((e.ctx.baseLatency ?? 0) * 1e5) / 100,
              outputLatencyMs:
                Math.round((e.ctx.outputLatency ?? 0) * 1e5) / 100,
            }
          : null,
        unlocked: isAudioUnlocked(),
        masterGain: e ? Math.round(e.master.gain.value * 1000) / 1000 : null,
        buses: e
          ? Object.fromEntries(
              Object.entries(e.buses).map(([k, g]) => [
                k,
                Math.round(g.gain.value * 1000) / 1000,
              ]),
            )
          : null,
        voices: {
          active: activeVoiceCount(),
          pool: poolSize(),
          cap: MAX_VOICES,
        },
        emitters: emitterCount(),
        tick: tickStats(),
        assets: {
          ready: load.ready,
          loading: load.loading,
          failed: load.failed,
          residentKiB: Math.round(load.residentBytes / 1024),
        },
      };
    };

    const harness: AudioHarness = {
      state() {
        const r = report();
        console.table(r.buses ?? {});
        console.log("[__audio]", r);
        harness.lastJson = JSON.stringify(r, null, 2);
        return r;
      },

      play(id, opts) {
        if (!tryGetAudioEvent(id)) {
          console.warn(
            `[__audio] no such event "${id}". Try __audio.events().`,
          );
          return null;
        }
        const serial = playAudio(id, opts);
        if (serial === null) {
          console.warn(
            `[__audio] "${id}" did not play — unlocked=${isAudioUnlocked()}, ` +
              `active=${activeVoiceCount()}/${MAX_VOICES}. ` +
              `Cooldown, instance cap, an undecoded buffer, or no gesture yet.`,
          );
        }
        return serial;
      },

      voices() {
        const v = voiceSnapshots();
        console.table(v);
        return v;
      },

      emitters() {
        const v = emitterSnapshots();
        console.table(v);
        return v;
      },

      events() {
        const rows = ALL_AUDIO_EVENTS.map((e) => ({
          id: e.id,
          bus: e.bus,
          tier: e.tier,
          variants: e.variants.length,
          priority: e.priority,
          max: e.maxInstances,
          cooldownMs: e.cooldownMs,
          loop: !!e.loop,
        }));
        console.table(rows);
        return rows;
      },

      emit(id, distanceM = 0) {
        if (!tryGetAudioEvent(id)) {
          console.warn(`[__audio] no such event "${id}".`);
          return null;
        }
        const h = registerEmitter({
          event: id as AudioEventId,
          positionM: { x: distanceM, y: 0, z: 0 },
        });
        console.log(
          `[__audio] emitter ${h.id} registered for "${id}" at ${distanceM} m. ` +
            `h.stop() to remove; __audio.emitters() to inspect.`,
        );
        return h;
      },

      /**
       * The wind bed's whole chain, measured rather than asserted: what the
       * atmosphere is, what q comes out, and what each layer is doing with it.
       * The one harness that proves §12.3 has an audible consumer.
       */
      /** Music director state; `music("play", id?)`, `music("skip")`, `music("stop")`, `music("end", s)` seeks to s before the end. */
      music(cmd, id) {
        if (cmd === "play") playMusicNow(id);
        else if (cmd === "skip") skipMusic();
        else if (cmd === "stop") stopMusic();
        else if (cmd === "end") seekMusicToEnd(Number(id ?? 8));
        const out = musicDebug();
        harness.lastJson = JSON.stringify(out, null, 2);
        return out;
      },
      wind() {
        const layers = ([0, 1, 2] as const).map((layer) => ({
          layer,
          event: ["ship.wind.low", "ship.wind.mid", "ship.wind.high"][layer],
          gain: Math.round(windLayerGain(layer, windState.db, windState.brightness) * 1e4) / 1e4,
        }));
        const out = {
          body: windState.bodyId ?? "none (vacuum)",
          altitudeKm: Math.round(windState.altitudeKm * 10) / 10,
          densityKgM3: windState.densityKgM3.toExponential(3),
          speedMps: Math.round(windState.speedMps * 10) / 10,
          qPa: Math.round(windState.qPa * 100) / 100,
          mach: Math.round(windState.mach * 100) / 100,
          wallSplDb: Math.round(windState.splDb * 10) / 10,
          // targetDb = what physics says this instant; levelDb = what plays.
          targetDb: Math.round(windState.targetDb * 10) / 10,
          levelDb: Math.round(windState.db * 10) / 10,
          brightness: Math.round(windState.brightness * 100) / 100,
          layers,
          // Below CULL_EXIT_GAIN (0.008) on every layer means no voice exists,
          // which is the difference between quiet and silent.
          audible: layers.some((l) => l.gain * 10 ** (-3 / 20) > 0.008),
        };
        console.log("[__audio]", out);
        harness.lastJson = JSON.stringify(out, null, 2);
        return out;
      },

      /**
       * Gate EA-2 / EA-4. Fire n one-shots at random positions and report what
       * the pool actually did.
       *
       * ⚠ Run this while the renderer is genuinely busy (a dense asteroid field,
       * or a __bench scenario) — a measurement on an idle scene proves nothing
       * about the frame budget.
       */
      stress(n = MAX_VOICES) {
        ensureEngine();
        const t0 = performance.now();
        let played = 0;
        let dropped = 0;
        for (let i = 0; i < n; i++) {
          const serial = playAudio("world.impact", {
            positionM: {
              x: (Math.random() - 0.5) * 200,
              y: (Math.random() - 0.5) * 200,
              z: (Math.random() - 0.5) * 200,
            },
            // Bypass the per-event guards: this measures the POOL, and without
            // this the burst is refused by cooldown/maxInstances after one voice.
            ignoreLimits: true,
          });
          if (serial === null) dropped++;
          else played++;
        }
        const ms = performance.now() - t0;
        const out = {
          requested: n,
          played,
          // With `ignoreLimits` these are pool refusals only — every voice was
          // busy and outranked the newcomer. A non-zero count at n > cap is
          // CORRECT; a non-zero count at n <= cap means stealing is misbehaving.
          dropped,
          activeAfter: activeVoiceCount(),
          cap: MAX_VOICES,
          totalMs: Math.round(ms * 100) / 100,
          perCallUs: Math.round((ms * 1000) / n),
        };
        console.log("[__audio] stress", out);
        harness.lastJson = JSON.stringify(out, null, 2);
        return out;
      },

      /**
       * Record the real master bus and report what actually came out.
       *
       * 🔑 THIS IS WHAT MAKES AUDIO WORK VERIFIABLE WITHOUT EARS, and it is the
       * seed of the §10.3 Tier-3 harness. MEASURED as working before any of this
       * was written: a 600 ms capture produced an 8,024-byte Opus blob that
       * decoded back at the expected peak.
       *
       *   const before = await __audio.capture(600)   // silence baseline
       *   __audio.play('click.hard'); await __audio.capture(600)
       *
       * A non-zero `peak` proves the signal reached the output through the bus
       * graph and the limiter — not merely that `playAudio` returned a serial.
       */
      async capture(ms = 800) {
        const stream = armCapture();
        const e = getEngine();
        if (!stream || !e) {
          console.warn("[__audio] capture unavailable (no engine).");
          return null;
        }
        const mime = ["audio/webm;codecs=opus", "audio/mp4"].find((m) =>
          MediaRecorder.isTypeSupported(m),
        );
        if (!mime) {
          console.warn("[__audio] no supported MediaRecorder mime type.");
          return null;
        }
        const rec = new MediaRecorder(stream, { mimeType: mime });
        const chunks: Blob[] = [];
        rec.ondataavailable = (ev) => chunks.push(ev.data);
        const stopped = new Promise<void>((r) => {
          rec.onstop = () => r();
        });
        rec.start();
        await new Promise((r) => setTimeout(r, ms));
        rec.stop();
        await stopped;

        const blob = new Blob(chunks, { type: mime });
        const buf = await e.ctx.decodeAudioData(await blob.arrayBuffer());
        let peak = 0;
        let sumSq = 0;
        let n = 0;
        for (let c = 0; c < buf.numberOfChannels; c++) {
          const d = buf.getChannelData(c);
          for (let i = 0; i < d.length; i++) {
            const v = Math.abs(d[i]);
            if (v > peak) peak = v;
            sumSq += d[i] * d[i];
            n++;
          }
        }
        const rms = Math.sqrt(sumSq / Math.max(1, n));
        const out = {
          mime,
          bytes: blob.size,
          durationS: Math.round(buf.duration * 1000) / 1000,
          channels: buf.numberOfChannels,
          peak: Math.round(peak * 1e4) / 1e4,
          rms: Math.round(rms * 1e4) / 1e4,
          peakDb:
            peak > 0 ? Math.round(20 * Math.log10(peak) * 10) / 10 : -Infinity,
        };
        console.log("[__audio] capture", out);
        harness.lastJson = JSON.stringify(out, null, 2);
        return out;
      },

      /** Audition a synthesised alarm tier directly (§6.3). */
      alarm(tier = "caution" as AlarmTier) {
        if (!ALARM_TIERS.includes(tier)) {
          console.warn(`[__audio] tier must be one of ${ALARM_TIERS.join(", ")}`);
          return null;
        }
        const s = playAlarm(tier);
        console.log(`[__audio] alarm "${tier}" — ${s.toFixed(2)}s`);
        return s;
      },

      alerts() {
        const rows = alertSnapshots();
        console.table(rows);
        return rows;
      },

      /**
       * Drive an A12 alert by hand, 0..1 (0 = worst). Registers the id if it is
       * not already known, so `__audio.setAlert('hull', 0.08)` works standalone.
       */
      setAlert(id: string, value01: number) {
        registerAlert(id);
        updateAlert(id, value01);
        const row = alertSnapshots().find((a) => a.id === id);
        console.log(`[__audio] alert ${id} = ${value01}`, row);
        return row;
      },

      ackAlert(id: string) {
        acknowledgeAlert(id);
        console.log(`[__audio] alert ${id} acknowledged (re-arms on recovery or escalation)`);
      },

      /**
        * Per-body acoustic properties (§12.3a). With no argument, the whole
        * table; with a body id, that body plus its density/level profile with
        * altitude — which is the "space goes quiet as you climb" curve.
        */
      acoustics(bodyId?: string) {
        if (!bodyId) {
          const rows = allAcoustics().map((a) => ({
            body: a.bodyId,
            gas: `${a.dominantGas} ${(a.dominantFraction * 100).toFixed(0)}%`,
            "M g/mol": Math.round(a.molarMassKgPerMol * 1e5) / 100,
            gamma: Math.round(a.gamma * 1e4) / 1e4,
            "T K": a.surfaceTemperatureK,
            "c m/s": Math.round(a.surfaceSpeedOfSoundMps * 10) / 10,
            "rho kg/m3": Math.round(a.surfaceDensityKgM3 * 1e4) / 1e4,
            "H km": Math.round(a.scaleHeightKm * 10) / 10,
            "dB": Math.round(10 * Math.log10(Math.max(1e-9, Math.min(1, a.surfaceDensityKgM3 / 1.225))) * 10) / 10,
          }));
          console.table(rows);
          harness.lastJson = JSON.stringify(rows, null, 2);
          return rows;
        }
        const atm = acousticsForBody(bodyId);
        if (!atm) {
          console.warn(`[__audio] "${bodyId}" has no atmosphere (or no such body).`);
          return null;
        }
        const profile = [0, 1, 2, 5, 10, 20, 50, 100, 200, 400].map((km) => ({
          "alt km": km,
          "rho kg/m3": densityAtAltitude(atm, km).toExponential(2),
          ratio: impedanceCoupling(atm, km).toExponential(2),
          dB: Math.round(
            10 * Math.log10(Math.max(1e-12, impedanceCoupling(atm, km))) * 10,
          ) / 10,
        }));
        console.table(profile);
        harness.lastJson = JSON.stringify({ atm, profile }, null, 2);
        return { atm, profile };
      },

      /**
       * Absorption spectrum for a body at an altitude — the "distant things lose
       * their highs" curve, per band, with its provenance tier.
       */
      absorption(bodyId = "earth", altitudeKm = 0, distanceM = 100) {
        const atm = acousticsForBody(bodyId);
        if (!atm) {
          console.warn(`[__audio] "${bodyId}" has no atmosphere.`);
          return null;
        }
        const rows = [125, 250, 500, 1000, 2000, 4000, 8000, 16000].map((f) => {
          const r = absorptionDbPerM(atm, f, altitudeKm);
          return {
            "f Hz": f,
            tier: r.tier,
            "dB/km": Math.round(r.dbPerM * 1000 * 100) / 100,
            [`dB over ${distanceM}m`]: Math.round(r.dbPerM * distanceM * 100) / 100,
            "20dB range m":
              r.dbPerM > 0 ? Math.round(20 / r.dbPerM) : Infinity,
          };
        });
        console.table(rows);
        harness.lastJson = JSON.stringify({ bodyId, altitudeKm, rows }, null, 2);
        return rows;
      },

      /** What the acoustic model says about where the ship is RIGHT NOW. */
      here() {
        const dom = getDominantAtmosphereBody();
        if (!dom) {
          const out = { body: null, verdict: "vacuum — no atmosphere body in range" };
          console.log("[__audio]", out);
          return out;
        }
        const altitudeKm = dom.distanceKm - dom.params.groundRadiusKm;
        const atm = acousticsForBody(dom.id);
        const ratio = impedanceCoupling(atm, altitudeKm);
        const out = {
          body: dom.id,
          altitudeKm: Math.round(altitudeKm * 10) / 10,
          hasAcoustics: !!atm,
          densityRatio: ratio.toExponential(3),
          // ⚠ Not -Infinity: JSON.stringify turns it into `null`, which reads
          // as "missing" rather than "silent" when pasted into a report.
          levelDb:
            ratio > 0 ? Math.round(20 * Math.log10(ratio) * 10) / 10 : "-inf (silent)",
          speedOfSoundMps: atm
            ? Math.round(atm.surfaceSpeedOfSoundMps * 10) / 10
            : 0,
        };
        console.log("[__audio]", out);
        harness.lastJson = JSON.stringify(out, null, 2);
        return out;
      },

      /**
       * Tier-2 offline assertion suite (§10.2). Deterministic, ~instant, and
       * needs no ears — run it after touching anything in src/audio/.
       */
      selftest() {
        return reportAudioSelfTest();
      },

      silence() {
        stopAllEmitters();
        stopAllVoices();
        console.log("[__audio] all voices and emitters stopped.");
      },

      listener(mode) {
        setListenerMode(mode);
        console.log(
          `[__audio] listener mode = ${mode}` +
            (mode === "chase"
              ? ""
              : " — NOTE: cockpit/xr branches are not implemented yet (A2)."),
        );
      },

      lastJson: "",
    };

    (window as unknown as { __audio: AudioHarness }).__audio = harness;
    console.log(
      "[__audio] ready. __audio.state() / .events() / .play(id) / .voices() / .stress(n)",
    );

    return () => {
      delete (window as unknown as { __audio?: AudioHarness }).__audio;
    };
  }, []);

  return null;
}
