// ---------------------------------------------------------------------------
// PUBLIC AUDIO API — the only surface gameplay code should import.
//
// Two verbs, and the distinction matters (A10 / A11):
//
//   playAudio('world.impact', { positionM })   one-shot, fire and forget
//   registerEmitter({ event, positionM })      continuous, has a lifetime
//
// Game code passes a SEMANTIC EVENT ID, never a filename. That indirection is
// what makes variants, per-event caps, re-mapping and the §10.1 contract tests
// possible at all.
//
// ⚠ Do NOT import engine internals from gameplay code, and do not create an
// AudioContext anywhere else. §10.1's contract test greps for exactly that: any
// path that bypasses the bus graph silently breaks the volume sliders, which is
// the single most-reported audio complaint in shipped games.
// ---------------------------------------------------------------------------

export { playAudio, stopVoiceBySerial, voiceEndTime, type PlayOptions } from "./voices";
export { registerEmitter, type EmitterHandle } from "./emitters";
export {
  isAudioUnlocked,
  unlockAudio,
  ensureEngine,
  sliderToGain,
  dbToGain,
} from "./engine";
export { setListenerMode, getListenerMode, type ListenerMode, type Vec3 } from "./spatial";
export { preloadTier, loadAudioFile } from "./loader";
export { startAudioTick, stopAudioTick, AUDIO_TICK_MS } from "./tick";
export type { AudioEventId } from "@/data/audioEvents";
