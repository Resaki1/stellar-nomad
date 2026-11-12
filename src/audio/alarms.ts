// ---------------------------------------------------------------------------
// ALARM TONES — synthesised, not sampled. docs/AUDIO_PLAN.md §6.3.
//
// 🔑 THESE ARE THE ONE CONTENT CATEGORY THAT CAN BE *FINISHED* RATHER THAN
// PLACEHOLDERED, because synthesis is not a compromise here — it is the
// authentic choice. Real spacecraft and aircraft alerting uses simple multi-tone
// patterns, and distinguishes severity by PULSE PATTERN as much as by pitch. A
// handful of OscillatorNodes is cheaper to build than sourcing a clip, costs
// zero download, and is tuneable forever.
//
// ⚠ NO AudioWorklet. A few oscillators and gains per alarm is well within the
// native node budget; a worklet would add message-port setup and processor
// instantiation for DSP that `OscillatorNode` already does on the audio thread.
// (§6.1's decision rule: synthesise what is "simple, periodic and tonal by
// nature" — this is the canonical case.)
//
// ⚠ Every alarm routes through the `alerts` sub-bus, which carries its own
// ceiling (§8.3). That is what stops a full-volume alarm dominating no matter
// where the master sits, and it is the direct answer to the most common
// complaint about game alarms.
// ---------------------------------------------------------------------------

import { ensureEngine, setParamNow } from "./engine";

/**
 * Severity tiers. The PATTERN differs per tier, not just the pitch — that is
 * how real alerting works, and it is what makes tiers distinguishable when the
 * player is busy, tired, or has the volume low.
 */
export type AlarmTier = "advisory" | "caution" | "critical";

type ToneSpec = {
  /** Fundamental, Hz. Kept in 400-700 Hz: audible on laptop speakers, and it
   *  sits above the engine rumble rather than fighting it. */
  freqHz: number;
  /** Optional second partial, as a multiple of the fundamental. */
  partial?: number;
  /** Beep length, seconds. */
  beepS: number;
  /** Gap between beeps within one alarm, seconds. */
  gapS: number;
  /** How many beeps one firing plays. */
  beeps: number;
  /** Frequency of the second tone for a two-tone pattern, Hz. */
  altFreqHz?: number;
  /** Warble depth in Hz for the critical tier (a swept siren, not a beep). */
  warbleHz?: number;
  gain: number;
};

/**
 * ⚠ TUNED FOR DISTINGUISHABILITY, NOT DRAMA.
 *
 * - advisory: one slow low beep. Easy to ignore, which is the point.
 * - caution:  two-tone, faster, repeated. Reads as "attend to this".
 * - critical: continuous warble. The only tier that sounds like an emergency,
 *             so the emergency tier keeps its meaning.
 */
const TONES: Record<AlarmTier, ToneSpec> = {
  advisory: { freqHz: 440, beepS: 0.18, gapS: 0.0, beeps: 1, gain: 0.25 },
  caution: {
    freqHz: 620,
    altFreqHz: 480,
    partial: 2,
    beepS: 0.12,
    gapS: 0.07,
    beeps: 3,
    gain: 0.4,
  },
  critical: {
    freqHz: 700,
    warbleHz: 180,
    beepS: 0.9,
    gapS: 0,
    beeps: 1,
    gain: 0.5,
  },
};

type AlarmPlayback = { out: GainNode; sources: OscillatorNode[]; nodes: AudioNode[] };
const activeAlarms = new Set<AlarmPlayback>();
let alarmsEnabled = true;

/** Disable at ship destruction; scheduled oscillators must not survive the ship. */
export function setAlarmsEnabled(enabled: boolean): void {
  alarmsEnabled = enabled;
  if (!enabled) stopAllAlarms();
}

export function stopAllAlarms(): void {
  const e = ensureEngine();
  if (!e) return;
  for (const alarm of Array.from(activeAlarms)) {
    const now = e.ctx.currentTime;
    alarm.out.gain.cancelScheduledValues(now);
    alarm.out.gain.setValueAtTime(alarm.out.gain.value, now);
    alarm.out.gain.linearRampToValueAtTime(0, now + 0.015);
    for (const source of alarm.sources) {
      try { source.stop(now + 0.015); } catch { /* already ended */ }
    }
    // The normal bounded cleanup timer disconnects every node, including LFOs.
    activeAlarms.delete(alarm);
  }
}

/**
 * Fire one alarm. Returns the time in seconds it will occupy, so a caller can
 * schedule a repeat without guessing.
 *
 * Nodes are created per firing and stopped explicitly — alarms are rare and
 * short, so pooling them would add bookkeeping for no measurable gain (a full
 * pooled voice was MEASURED at 8.1 µs against 24.6 µs unpooled; a few tens of µs
 * on an event that fires at most once a second is not worth a pool).
 */
export function playAlarm(tier: AlarmTier): number {
  if (!alarmsEnabled) return 0;
  const e = ensureEngine();
  if (!e) return 0;

  const spec = TONES[tier];
  const ctx = e.ctx;
  const t0 = ctx.currentTime;

  // One gain for the whole alarm, into the ceilinged alerts sub-bus.
  const out = ctx.createGain();
  setParamNow(out.gain, spec.gain);
  out.connect(e.alerts);
  const playback: AlarmPlayback = { out, sources: [], nodes: [out] };
  activeAlarms.add(playback);

  const period = spec.beepS + spec.gapS;
  const total = period * spec.beeps;

  if (spec.warbleHz) {
    // Critical: a continuously swept siren. An LFO on the oscillator's
    // frequency, which is a native AudioParam connection — no per-sample JS.
    const osc = ctx.createOscillator();
    playback.sources.push(osc);
    playback.nodes.push(osc);
    osc.type = "square";
    setParamNow(osc.frequency, spec.freqHz);

    const lfo = ctx.createOscillator();
    playback.sources.push(lfo);
    playback.nodes.push(lfo);
    lfo.type = "sine";
    setParamNow(lfo.frequency, 4.5);
    const lfoDepth = ctx.createGain();
    playback.nodes.push(lfoDepth);
    setParamNow(lfoDepth.gain, spec.warbleHz);
    lfo.connect(lfoDepth);
    lfoDepth.connect(osc.frequency);

    // A square wave straight out is harsh on laptop speakers; take the top off.
    const lp = ctx.createBiquadFilter();
    playback.nodes.push(lp);
    lp.type = "lowpass";
    setParamNow(lp.frequency, 2600);

    const env = ctx.createGain();
    playback.nodes.push(env);
    // 8 ms attack/release: fast enough to feel urgent, slow enough not to click.
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(1, t0 + 0.008);
    env.gain.setValueAtTime(1, t0 + spec.beepS - 0.03);
    env.gain.linearRampToValueAtTime(0, t0 + spec.beepS);

    osc.connect(lp);
    lp.connect(env);
    env.connect(out);
    osc.start(t0);
    lfo.start(t0);
    osc.stop(t0 + spec.beepS + 0.02);
    lfo.stop(t0 + spec.beepS + 0.02);
  } else {
    for (let i = 0; i < spec.beeps; i++) {
      const at = t0 + i * period;
      // Two-tone alternation for the caution tier.
      const f =
        spec.altFreqHz && i % 2 === 1 ? spec.altFreqHz : spec.freqHz;

      const env = ctx.createGain();
      playback.nodes.push(env);
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(1, at + 0.006);
      env.gain.setValueAtTime(1, at + spec.beepS - 0.02);
      env.gain.linearRampToValueAtTime(0, at + spec.beepS);
      env.connect(out);

      const osc = ctx.createOscillator();
      playback.sources.push(osc);
      playback.nodes.push(osc);
      osc.type = "sine";
      setParamNow(osc.frequency, f);
      osc.connect(env);
      osc.start(at);
      osc.stop(at + spec.beepS + 0.01);

      if (spec.partial) {
        // A quiet harmonic gives the tone a little edge so it reads as
        // instrumentation rather than a test tone.
        const h = ctx.createOscillator();
        playback.sources.push(h);
        playback.nodes.push(h);
        h.type = "sine";
        setParamNow(h.frequency, f * spec.partial);
        const hg = ctx.createGain();
        playback.nodes.push(hg);
        setParamNow(hg.gain, 0.22);
        h.connect(hg);
        hg.connect(env);
        h.start(at);
        h.stop(at + spec.beepS + 0.01);
      }
    }
  }

  // Release the wrapper gain once the tail has passed.
  window.setTimeout(() => {
    try {
      for (const node of playback.nodes) node.disconnect();
      activeAlarms.delete(playback);
    } catch {
      /* already gone */
    }
  }, (total + 0.3) * 1000);

  return total;
}

/** Dev/debug: the tier list, for the `__audio` harness. */
export const ALARM_TIERS: readonly AlarmTier[] = [
  "advisory",
  "caution",
  "critical",
];
