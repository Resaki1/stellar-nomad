// ---------------------------------------------------------------------------
// AUDIO TICK — invariant A5. docs/AUDIO_PLAN.md §4.
//
// ⚠⚠ THIS IS A setInterval AND IT MUST NOT BE A useFrame. Two independent
// reasons, both verified in this repo:
//
//  1. `frameloop={settingsIsOpen ? "never" : "always"}` (Scene.tsx:228) is a
//     HARD stop of every useFrame in the tree. Driving audio from the render
//     loop would freeze emitter updates — and music — the moment the player
//     opens the settings menu.
//  2. MEASURED (M1): AudioParam write cost scales with the param's pending
//     event list, 1.40 µs empty versus 17.60 µs at 20k queued. A per-frame
//     writer is exactly the pattern that grows it. At 24 voices × ~4 params,
//     15 Hz costs ~2 ms of main thread per SECOND; 120 Hz would cost ~16 ms/s
//     and climbing.
//
// AudioParam ramps do the actual smoothing, on the audio thread, for free.
//
// Anything that must be frame-exact (world-emitter positions for a fast flyby,
// or the XR listener pose) writes to a plain buffer from an existing useFrame
// and this tick consumes it — the `transitDriveBuffer` pattern.
// ---------------------------------------------------------------------------

import { updateEmitters } from "./emitters";
import { updateWind } from "./wind";
import { pumpAlerts } from "./alerts";

/** 66 ms. Fast enough for positional updates, slow enough to be free. */
export const AUDIO_TICK_MS = 66;

let handle: number | null = null;
let ticks = 0;
let lastTickMs = 0;
/** Rolling average of tick cost, surfaced by `__audio.state()`. */
let avgTickMs = 0;

export function startAudioTick(): void {
  if (handle !== null) return; // idempotent: StrictMode double-invoke safe
  handle = window.setInterval(() => {
    const t0 = performance.now();
    try {
      // Before the emitters, so all three wind layers read one computation of
      // the atmosphere rather than each repeating the body and density lookup.
      updateWind();
      updateEmitters();
      // A12's reminder schedule. Must be clock-driven, not value-driven — see
      // the warning on `pumpAlerts`.
      pumpAlerts();
    } catch (err) {
      // A throw here would kill the interval permanently and silence the game
      // with no obvious cause.
      console.error("[audio] tick error", err);
    }
    lastTickMs = performance.now() - t0;
    avgTickMs = avgTickMs === 0 ? lastTickMs : avgTickMs * 0.9 + lastTickMs * 0.1;
    ticks++;
  }, AUDIO_TICK_MS);
}

export function stopAudioTick(): void {
  if (handle === null) return;
  window.clearInterval(handle);
  handle = null;
}

export function tickStats(): {
  running: boolean;
  ticks: number;
  lastMs: number;
  avgMs: number;
} {
  return {
    running: handle !== null,
    ticks,
    lastMs: Math.round(lastTickMs * 1000) / 1000,
    avgMs: Math.round(avgTickMs * 1000) / 1000,
  };
}
