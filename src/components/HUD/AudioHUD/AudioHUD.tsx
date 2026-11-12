"use client";

/**
 * Live audio readout. Toggled by Settings → Dev → "audio hud".
 * docs/AUDIO_PLAN.md §9.2.
 *
 * ── Why it looks like this ──────────────────────────────────────────────────
 * Mirrors `PerfHUD` exactly, for the same reason: a diagnostic overlay that
 * costs what it measures is useless. React renders the skeleton ONCE, then a
 * 4 Hz interval writes `textContent`. No per-frame state, no per-frame React, no
 * `backdrop-filter`. The body is a single `<pre>` — one string write per tick,
 * which is also the right shape for a monospace table.
 *
 * ⚠ Reads the engine directly rather than through jotai. Voice counts and bus
 * levels change at audio rate; routing them through React state is precisely the
 * thing `CLAUDE.md` forbids.
 */

import { useEffect, useRef } from "react";

import { getEngine, isAudioUnlocked } from "@/audio/engine";
import { activeVoiceCount, voiceSnapshots, MAX_VOICES } from "@/audio/voices";
import { emitterCount, emitterSnapshots } from "@/audio/emitters";
import { alertSnapshots } from "@/audio/alerts";
import { tickStats } from "@/audio/tick";
import { loadStats } from "@/audio/loader";
import { acousticsForBody, propagationFor } from "@/audio/acoustics";
import { getDominantAtmosphereBody } from "@/components/space/atmospherePass";

import "./AudioHUD.scss";

/** Human-readable, not frame-rate. */
const REFRESH_MS = 250;

const pad = (s: string, n: number) => s.slice(0, n).padEnd(n);
const num = (v: number, n = 6, d = 2) => v.toFixed(d).padStart(n);

/** Linear gain → dB, with a readable floor instead of -Infinity. */
function db(gain: number): string {
  if (!(gain > 0)) return "  -inf";
  return (20 * Math.log10(gain)).toFixed(1).padStart(6);
}

function build(): string {
  const e = getEngine();
  if (!e) return "audio: engine not built";

  const lines: string[] = [];
  const t = tickStats();
  const load = loadStats();

  lines.push(
    `ctx ${e.ctx.state}  ${e.ctx.sampleRate} Hz  ` +
      `lat ${((e.ctx.baseLatency ?? 0) * 1000).toFixed(1)}ms  ` +
      `${isAudioUnlocked() ? "unlocked" : "LOCKED"}`,
  );
  // ⚠ Surfaced because it is invisible otherwise and it silently dulls
  // everything: a comms-mode headset drags the context to 16 kHz.
  if (e.ctx.sampleRate < 24000) {
    lines.push(`  !! ${e.ctx.sampleRate} Hz — output device is comms-rate, audio will sound dull`);
  }
  lines.push(
    `tick ${t.running ? "on " : "OFF"} ${num(t.avgMs, 5, 3)}ms avg   ` +
      `assets ${load.ready}rdy ${load.failed}fail ${Math.round(load.residentBytes / 1024)}KiB`,
  );

  // ── buses ──────────────────────────────────────────────────────────────
  lines.push("");
  lines.push(`master ${db(e.master.gain.value)} dB   alerts ${db(e.alerts.gain.value)} dB`);
  const busRow = Object.entries(e.buses)
    .map(([k, g]) => `${k} ${db(g.gain.value)}`)
    .join("  ");
  lines.push(`  ${busRow}`);

  // ── local atmosphere (§12.3) ───────────────────────────────────────────
  const dom = getDominantAtmosphereBody();
  if (dom) {
    const altKm = dom.distanceKm - dom.params.groundRadiusKm;
    const atm = acousticsForBody(dom.id);
    const prop = propagationFor(atm, altKm, 100);
    lines.push("");
    lines.push(
      `atmo ${pad(dom.id, 8)} alt ${num(altKm, 8, 1)}km  ` +
        `air ${db(prop.gain)} dB  lp ${Math.round(prop.cutoffHz)}Hz  [${prop.tier}]`,
    );
  } else {
    lines.push("");
    lines.push("atmo vacuum — air-coupled world sounds are silent");
  }

  // ── voices ─────────────────────────────────────────────────────────────
  const voices = voiceSnapshots();
  lines.push("");
  lines.push(
    `voices ${String(activeVoiceCount()).padStart(2)}/${MAX_VOICES}   ` +
      `emitters ${emitterCount()}`,
  );
  for (const v of voices.slice(0, 8)) {
    lines.push(
      `  ${pad(v.eventId, 20)} p${String(v.priority).padStart(3)} ` +
        `${db(v.gain)}dB ` +
        `${v.distanceM === null ? "   2D" : num(v.distanceM, 5, 0) + "m"}` +
        `${v.airCoupled ? ` air ${String(v.cutoffHz ?? 0).padStart(5)}Hz` : ""}` +
        `${v.loop ? " loop" : ""}`,
    );
  }
  if (voices.length > 8) lines.push(`  … ${voices.length - 8} more`);

  // ── emitters ───────────────────────────────────────────────────────────
  const emitters = emitterSnapshots();
  if (emitters.length) {
    lines.push("");
    for (const em of emitters.slice(0, 5)) {
      lines.push(
        `  #${String(em.id).padStart(3)} ${pad(em.eventId, 20)} ` +
          `x${em.intensity.toFixed(2)} ` +
          `${em.distanceM === null ? "  2D" : num(em.distanceM, 5, 0) + "m"} ` +
          `${em.voice === null ? "culled" : "v" + em.voice}`,
      );
    }
  }

  // ── A12 alerts ─────────────────────────────────────────────────────────
  const alerts = alertSnapshots();
  if (alerts.length) {
    lines.push("");
    for (const a of alerts) {
      lines.push(
        `  alert ${pad(a.id, 10)} ${a.value.toFixed(2)} ` +
          `${pad(a.tier, 9)} gap ${num(a.gapS, 5, 1)}s ` +
          `${a.acknowledged ? "ack" : a.nextInS === null ? "" : `next ${a.nextInS}s`}`,
      );
    }
  }

  return lines.join("\n");
}

export default function AudioHUD() {
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const tick = () => {
      if (preRef.current) preRef.current.textContent = build();
    };
    tick();
    const h = window.setInterval(tick, REFRESH_MS);
    return () => window.clearInterval(h);
  }, []);

  return (
    <div className="audio-hud">
      <pre ref={preRef} />
    </div>
  );
}
