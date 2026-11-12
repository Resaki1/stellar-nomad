import { getPreset } from "./presets";
import { RENDERER_VERSION, type RenderedSound } from "./synthesize";

/** 24-bit mono PCM. smpl embeds the exact full-buffer loop, including its last frame. */
export function encodeWav(sound: RenderedSound): ArrayBuffer {
  const frames = sound.samples.length;
  const dataBytes = frames * 3;
  const pad = dataBytes % 2;
  const loopBytes = sound.loop ? 68 : 0;
  const buffer = new ArrayBuffer(44 + dataBytes + pad + loopBytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); ascii(8, "WAVE");
  ascii(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sound.sampleRate, true);
  view.setUint32(28, sound.sampleRate * 3, true); view.setUint16(32, 3, true); view.setUint16(34, 24, true);
  ascii(36, "data"); view.setUint32(40, dataBytes, true);
  for (let i = 0; i < frames; i++) {
    const sample = sound.samples[i];
    if (!Number.isFinite(sample) || Math.abs(sample) > 1) throw new Error("Refusing to export non-finite or clipped audio.");
    const v = Math.round(sample * (sample < 0 ? 8388608 : 8388607));
    const offset = 44 + i * 3;
    view.setUint8(offset, v & 255); view.setUint8(offset + 1, (v >> 8) & 255); view.setUint8(offset + 2, (v >> 16) & 255);
  }
  if (sound.loop) {
    const at = 44 + dataBytes + pad;
    ascii(at, "smpl"); view.setUint32(at + 4, 60, true);
    view.setUint32(at + 16, Math.round(1e9 / sound.sampleRate), true);
    view.setUint32(at + 20, 60, true); // MIDI unity note, not a tuning claim
    view.setUint32(at + 36, 1, true); // one loop
    view.setUint32(at + 56, frames - 1, true); // inclusive end; start/type default to 0
  }
  return buffer;
}

export function soundFilename(sound: RenderedSound): string {
  return `${sound.recipe.presetId.replaceAll(".", "_")}_s${sound.recipe.seed}`;
}

export function recipeDocument(sound: RenderedSound): object {
  const preset = getPreset(sound.recipe.presetId);
  return {
    tool: "Stellar Nomad Audio Workshop", rendererVersion: RENDERER_VERSION,
    recipe: sound.recipe, format: { sampleRate: sound.sampleRate, channels: 1, bitDepth: 24 },
    loop: sound.loop ? { startFrame: 0, endFrameExclusive: sound.samples.length } : null,
    trigger: preset.trigger, bus: preset.bus, experimental: !!preset.experimental,
    provenance: "Original procedural synthesis. No recordings, models, or third-party audio used.",
    stats: sound.stats,
  };
}
