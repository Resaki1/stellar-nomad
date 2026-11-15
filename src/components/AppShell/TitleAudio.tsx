"use client";

import { useEffect } from "react";
import { useAtomValue } from "jotai";
// Not the "@/audio" barrel or AudioSystem: both pull the emitter graph (three.js) into the title bundle.
import { applyBlurState, ensureEngine, setMonoOutput, unlockAudio } from "@/audio/engine";
import { preloadTier } from "@/audio/loader";
import { pumpMusic, setMusicTitle } from "@/audio/music";
import { applyAudioSettings } from "@/components/Audio/applyAudioSettings";
import { audioSettingsAtom } from "@/store/audio";

const PUMP_MS = 250;

/** Title-screen audio: menu sounds and the title theme. The game's AudioSystem takes over in a world. */
export default function TitleAudio(): null {
  const settings = useAtomValue(audioSettingsAtom);

  useEffect(() => {
    // Browsers keep the context suspended until a gesture; if this one is already
    // running (activation carried over a same-origin navigation), start at once.
    if (ensureEngine()?.ctx.state === "running") unlockAudio();
    const onGesture = () => unlockAudio();
    window.addEventListener("pointerdown", onGesture, { once: true });
    window.addEventListener("keydown", onGesture, { once: true });
    void preloadTier(0);
    setMusicTitle(true);
    const id = setInterval(pumpMusic, PUMP_MS);
    return () => {
      clearInterval(id);
      setMusicTitle(false);
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
    };
  }, []);

  useEffect(() => applyAudioSettings(settings), [settings]);
  useEffect(() => setMonoOutput(settings.mono), [settings.mono]);
  useEffect(() => {
    const onVisibility = () => applyBlurState(document.visibilityState === "hidden", settings.onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    onVisibility();
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [settings.onBlur]);

  return null;
}
