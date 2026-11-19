"use client";

// ---------------------------------------------------------------------------
// AudioSystem — the engine's only React surface.
//
// Owns four side effects and nothing else:
//   1. unlock on the first real user gesture (T8)
//   2. settings → bus gains
//   3. tab-visibility ducking (§8.2) and the pause-menu fade
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

import { useEffect, useRef, useSyncExternalStore } from "react";
import { useAtomValue } from "jotai";

import { audioSettingsAtom } from "@/store/audio";
import { useSettingsPause } from "@/net/useSettingsPause";
import {
  applyBlurState,
  ensureEngine,
  setGamePaused,
  setMonoOutput,
  unlockAudio,
} from "@/audio/engine";
import { applyAudioSettings } from "./applyAudioSettings";
import { preloadTier } from "@/audio/loader";
import { startAudioTick, stopAudioTick } from "@/audio/tick";
import { setMusicHeld } from "@/audio/music";
import { getAppPhase, subscribeApp } from "@/components/AppShell/appState";

export default function AudioSystem({ authoring = false }: { authoring?: boolean }) {
  const settings = useAtomValue(audioSettingsAtom);
  const settingsPaused = useSettingsPause() !== "running";
  const loading = useSyncExternalStore(subscribeApp, () => getAppPhase() === "loading", () => false);
  const paused = (settingsPaused || loading) && !authoring;
  const wasLoading = useRef(false);

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
    applyAudioSettings(settings);
  }, [settings]);

  useEffect(() => setMonoOutput(settings.mono), [settings.mono]);

  // ── 3. Tab visibility ────────────────────────────────────────────────────
  useEffect(() => {
    const onVisibility = () =>
      applyBlurState(document.visibilityState === "hidden", settings.onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    // Re-apply immediately: the behaviour setting may have changed while hidden.
    onVisibility();
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [settings.onBlur]);

  // Solo Settings pauses the scene and fades its audio.
  // Behind the loading overlay the world is silent; it fades in as the overlay fades out.
  useEffect(() => {
    setGamePaused(paused, wasLoading.current && !loading ? 0.25 : 0.1);
    wasLoading.current = loading;
    setMusicHeld(loading);
  }, [paused, loading]);

  // ── 4. The A5 tick + tiered preload ──────────────────────────────────────
  useEffect(() => {
    // The workshop shares player volume/blur controls, but runs no simulation.
    if (authoring) return;
    startAudioTick();
    // Tier 0 (UI) is tiny and must be warm before the first click, or the first
    // play pays a MEASURED ~6 ms decode and reads as a late sound (T6).
    void preloadTier(0).then(() => preloadTier(1));
    return () => stopAudioTick();
  }, [authoring]);

  return null;
}
