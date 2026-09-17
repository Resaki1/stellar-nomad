"use client";

// ---------------------------------------------------------------------------
// AudioSystem — the engine's only React surface.
//
// Owns four side effects and nothing else:
//   1. unlock on the first real user gesture (T8)
//   2. settings → bus gains
//   3. tab-visibility ducking (§8.2)
//   4. starting the A5 tick
//
// ⚠ IT OWNS NO AUDIO STATE. The engine is a module singleton that is never torn
// down (A1), so React double-invoking these effects in dev is harmless — every
// entry point below is idempotent. This is deliberate: two dev pages in this
// repo already carry `startedRef` double-invoke guards, so the hazard is live.
//
// ⚠ Renders `null`. It must never re-render at audio rates — volume changes are
// human-rate, which is the only reason reading atoms here is acceptable.
// ---------------------------------------------------------------------------

import { useEffect } from "react";
import { useAtomValue } from "jotai";

import { audioSettingsAtom, VOLUME_KEYS } from "@/store/audio";
import {
  applyBlurState,
  ensureEngine,
  setBusGain,
  setMasterGain,
  sliderToGain,
  unlockAudio,
} from "@/audio/engine";
import { preloadTier } from "@/audio/loader";
import { startAudioTick, stopAudioTick } from "@/audio/tick";

export default function AudioSystem() {
  const settings = useAtomValue(audioSettingsAtom);

  // ── 1. Unlock on the first gesture ───────────────────────────────────────
  useEffect(() => {
    // `pointerdown` rather than `click`: it fires earlier, and it is the event
    // iOS Safari actually honours. `keydown` covers keyboard-first players who
    // never click before flying.
    //
    // ⚠ MUST run synchronously inside the handler. `resume()` invoked outside a
    // gesture can stay pending indefinitely, which presents as "no audio, no
    // error" — the exact failure T8 warns about.
    const onGesture = () => unlockAudio();
    window.addEventListener("pointerdown", onGesture, { once: true });
    window.addEventListener("keydown", onGesture, { once: true });

    // Build the graph now so the first gesture only has to resume it. Creating
    // a suspended context before a gesture is allowed everywhere.
    ensureEngine();

    return () => {
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
    };
  }, []);

  // ── 2. Settings → gains ──────────────────────────────────────────────────
  useEffect(() => {
    setMasterGain(settings.muted ? 0 : sliderToGain(settings.master));
    for (const key of VOLUME_KEYS) {
      if (key === "master") continue;
      const gain = sliderToGain(settings[key]);
      // `sfx` drives two buses: ship-diegetic and world emitters. They are
      // separate buses for muffling/snapshot reasons (§5.5), but one slider —
      // players do not want to balance them by hand.
      if (key === "sfx") {
        setBusGain("sfxShip", gain);
        setBusGain("sfxWorld", gain);
      } else {
        setBusGain(key, gain);
      }
    }
  }, [settings]);

  // ── 3. Tab visibility ────────────────────────────────────────────────────
  useEffect(() => {
    const onVisibility = () =>
      applyBlurState(document.visibilityState === "hidden", settings.onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    // Re-apply immediately: the behaviour setting may have changed while hidden.
    onVisibility();
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [settings.onBlur]);

  // ── 4. The A5 tick + tiered preload ──────────────────────────────────────
  useEffect(() => {
    startAudioTick();
    // Tier 0 (UI) is tiny and must be warm before the first click, or the first
    // play pays a MEASURED ~6 ms decode and reads as a late sound (T6).
    void preloadTier(0).then(() => preloadTier(1));
    return () => stopAudioTick();
  }, []);

  return null;
}
