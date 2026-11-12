import { ensureEngine } from "../engine";
import { getPreset } from "./presets";
import type { RenderedSound } from "./synthesize";

/** Long enough to hide the join, short enough that a slider still feels live. */
const CROSSFADE = 0.03;

type Voice = { source: AudioBufferSourceNode; gain: GainNode; startedAt: number; ended: () => void };

/** One preview at a time. Always enters the real bus graph; never changes player settings. */
export class WorkshopPreview {
  private current: Voice | null = null;
  private pending = 0;
  private monitorDb = -6;

  private get level(): number {
    return 10 ** (this.monitorDb / 20);
  }

  setMonitorDb(db: number): void {
    this.monitorDb = Math.max(-36, Math.min(0, db));
    const e = ensureEngine();
    if (!e || !this.current) return;
    const param = this.current.gain.gain;
    param.cancelScheduledValues(e.ctx.currentTime);
    param.setTargetAtTime(this.level, e.ctx.currentTime, 0.015);
  }

  /** Builds a faded-in voice on the preset's own bus and makes it `this.current`. */
  private start(sound: RenderedSound, at: number, offset: number, ended: () => void): Voice {
    const e = ensureEngine()!;
    const buffer = e.ctx.createBuffer(1, sound.samples.length, sound.sampleRate);
    buffer.copyToChannel(sound.samples, 0);
    const source = e.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = sound.loop;
    source.loopStart = 0;
    source.loopEnd = buffer.duration;
    const gain = e.ctx.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(this.level, at + (offset > 0 ? CROSSFADE : 0.012));
    source.connect(gain);
    gain.connect(e.buses[getPreset(sound.recipe.presetId).bus]);
    const voice: Voice = { source, gain, startedAt: at - offset, ended };
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
      // A swapped-out voice is no longer `current`, so it cannot report the end
      // of a preview that is in fact still playing.
      if (this.current === voice) { this.current = null; ended(); }
    };
    this.current = voice;
    source.start(at, offset);
    return voice;
  }

  /** Invoke directly from a gesture: resume must happen before any await. */
  async play(sound: RenderedSound, ended: () => void): Promise<void> {
    this.stop();
    const ticket = this.pending;
    const e = ensureEngine();
    if (!e) throw new Error("Web Audio is not available in this browser.");
    await e.ctx.resume();
    if (ticket !== this.pending) return;
    if (e.ctx.state !== "running") throw new Error("Audio is suspended. Press Play again to enable it.");
    this.start(sound, e.ctx.currentTime, 0, ended);
  }

  /**
   * Replace what is playing with a re-render, without a gap. Tuning a sustained
   * loop is the whole point of the workshop, and stopping playback on every
   * parameter change made that impossible — you never heard the knob move.
   * Returns false when there is nothing live to replace.
   */
  swap(sound: RenderedSound): boolean {
    const previous = this.current;
    const e = ensureEngine();
    if (!previous || !e || e.ctx.state !== "running") return false;
    const now = e.ctx.currentTime;
    const elapsed = Math.max(0, now - previous.startedAt);
    const duration = sound.samples.length / sound.sampleRate;
    // Resume at the same point in the gesture: a loop keeps its phase, and a
    // one-shot is not restarted from the top on every pixel of slider travel.
    const offset = sound.loop ? elapsed % duration : elapsed;
    if (!sound.loop && offset >= duration - CROSSFADE * 2) return false;
    this.start(sound, now, offset, previous.ended);
    previous.gain.gain.cancelScheduledValues(now);
    previous.gain.gain.setValueAtTime(previous.gain.gain.value, now);
    previous.gain.gain.linearRampToValueAtTime(0, now + CROSSFADE);
    previous.source.stop(now + CROSSFADE + 0.02);
    setTimeout(() => { previous.source.disconnect(); previous.gain.disconnect(); }, 200);
    return true;
  }

  stop(): void {
    this.pending++;
    const current = this.current;
    this.current = null;
    if (!current) return;
    const e = ensureEngine();
    if (!e) return;
    const t = e.ctx.currentTime;
    current.gain.gain.cancelScheduledValues(t);
    current.gain.gain.setTargetAtTime(0, t, 0.008);
    current.source.stop(t + 0.05);
    // Also releases suspended graphs: onended cannot run until their clock resumes.
    setTimeout(() => { current.source.disconnect(); current.gain.disconnect(); }, 100);
  }
}
