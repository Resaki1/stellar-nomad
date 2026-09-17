"use client";

// ---------------------------------------------------------------------------
// GameAudioTriggers — the ONE place gameplay events become sounds.
// docs/AUDIO_PLAN.md §5.7.
//
// Mirrors `GameCommsTriggers.tsx`: gameplay components set signal atoms or
// write buffers; they do NOT call the audio engine. Centralising it means the
// full set of sounds the game can make is readable in one file.
//
// ⚠ ONE DELIBERATE DIFFERENCE FROM THE COMMS PRECEDENT. Comms enqueues through
// a jotai atom because it fires a handful of times per session. Audio fires
// hundreds of times a minute, so this component WATCHES atoms and CALLS the
// engine imperatively — jotai is never in the playback path. Continuous sounds
// go through the emitter registry and are driven by a buffer read on the audio
// tick, never by React.
//
// ⚠ EVERY EFFECT HERE MUST BE EDGE-TRIGGERED AND StrictMode-SAFE. React
// double-invokes mount effects in dev, so a bare `useEffect(() => play(), [])`
// fires twice. The pattern used throughout is a previous-value ref compared
// inside a dependency-tracked effect — the same shape `DamageVignette.tsx`
// already uses.
//
// Phase 1 note: the sounds below are mapped onto Phase 0's PLACEHOLDER assets,
// so several events deliberately share one file. The event IDS are the stable
// part; §6.2's asset pass replaces the files, not this wiring.
// ---------------------------------------------------------------------------

import { useEffect, useRef } from "react";
import { atom, useAtomValue } from "jotai";

import { playAudio, registerEmitter, type EmitterHandle } from "@/audio";
import { playAlarm } from "@/audio/alarms";
import { registerAlert, updateAlert, unregisterAlert } from "@/audio/alerts";
import { audioShipBuffer } from "@/audio/shipBuffer";
import { shipHealthAtom } from "@/store/store";
import { vfxEventsAtom } from "@/store/vfx";
import { miningStateAtom, asteroidMinedSignalAtom } from "@/store/mining";
import { isCargoFullAtom } from "@/store/cargo";
import { transitStateAtom } from "@/store/transit";
import { toastsAtom } from "@/store/toast";
import { isDeadAtom } from "@/store/death";
import { itemCraftedSignalAtom } from "@/store/modules";
import { lastCompletedResearchIdAtom } from "@/store/research";

// Derived atoms so this component does not re-render on every frame-rate field
// of `miningStateAtom` (which commits at 30 Hz and carries `miningProgress`).
const isOverheatedAtom = atom((get) => get(miningStateAtom).isOverheated);
const isFocusedAtom = atom((get) => get(miningStateAtom).isFocused);
const transitPhaseAtom = atom((get) => get(transitStateAtom).phase);

export default function GameAudioTriggers() {
  // ── Ship engine loop ─────────────────────────────────────────────────────
  // Registered once. Its level is polled from `audioShipBuffer` on the audio
  // tick, so React is not involved in driving it at all.
  const engineRef = useRef<EmitterHandle | null>(null);
  useEffect(() => {
    if (engineRef.current) return; // StrictMode double-invoke guard
    engineRef.current = registerEmitter({
      event: "ship.engine.loop",
      // Idle floor so the ship is never completely dead, plus the throttle.
      // Ship-tier, so it is neither panned nor distance-attenuated (A2).
      intensity: () => 0.25 + 0.75 * audioShipBuffer.throttle,
    });
    return () => {
      engineRef.current?.stop();
      engineRef.current = null;
    };
  }, []);

  // ── Asteroid impacts and mining hits (spatialised) ───────────────────────
  // `vfxEventsAtom` is the right source rather than `cameraShakeIntensityAtom`:
  // both are set by the same hit, but only this one carries `position` and
  // `radiusM` (trap T12 — watching both would play two sounds per impact).
  const vfxEvents = useAtomValue(vfxEventsAtom);
  const playedVfxRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    for (const ev of vfxEvents) {
      if (playedVfxRef.current.has(ev.id)) continue;
      playedVfxRef.current.add(ev.id);
      // Bigger rock, louder and lower. `world.impact` already jitters pitch and
      // gain per play, so repeats do not sound identical (§6.4).
      const sizeDb = Math.min(6, Math.max(-6, Math.log10(Math.max(1, ev.radiusM)) * 6 - 6));
      playAudio("world.impact", {
        positionM: { x: ev.position[0], y: ev.position[1], z: ev.position[2] },
        gainDb: ev.type === "collision" ? sizeDb : sizeDb - 6,
      });
    }
    // Bounded: `vfxEventsAtom` is pruned by its consumers, so drop ids that are
    // no longer live rather than growing this set for the session.
    if (playedVfxRef.current.size > 256) {
      const live = new Set(vfxEvents.map((e) => e.id));
      playedVfxRef.current = live;
    }
  }, [vfxEvents]);

  // ── Mining ───────────────────────────────────────────────────────────────
  const minedCount = useAtomValue(asteroidMinedSignalAtom);
  const prevMined = useRef(minedCount);
  useEffect(() => {
    if (minedCount > prevMined.current) playAudio("notify.info");
    prevMined.current = minedCount;
  }, [minedCount]);

  const isFocused = useAtomValue(isFocusedAtom);
  const prevFocused = useRef(isFocused);
  useEffect(() => {
    if (isFocused && !prevFocused.current) playAudio("hover.tick");
    prevFocused.current = isFocused;
  }, [isFocused]);

  // Overheat is edge-triggered on the COMMITTED boolean, not on the heat value
  // crossing a threshold — trap T10: the ref clears at heat <= 0 on natural
  // cooldown but at heat < 1 after a heat sink, so a value-crossing hook misses
  // the heat-sink path entirely.
  const isOverheated = useAtomValue(isOverheatedAtom);
  const prevOverheated = useRef(isOverheated);
  useEffect(() => {
    // A synthesised caution tone, not a sampled placeholder — §6.3's alarms are
    // the one content category that is FINISHED rather than placeholdered.
    if (isOverheated && !prevOverheated.current) playAlarm("caution");
    prevOverheated.current = isOverheated;
  }, [isOverheated]);

  const cargoFull = useAtomValue(isCargoFullAtom);
  const prevCargoFull = useRef(cargoFull);
  useEffect(() => {
    // Advisory, deliberately: a full hold is information, not an emergency.
    // Using the same tier for everything is how alarm fatigue starts.
    if (cargoFull && !prevCargoFull.current) playAlarm("advisory");
    prevCargoFull.current = cargoFull;
  }, [cargoFull]);

  // ── Damage and death ─────────────────────────────────────────────────────
  const health = useAtomValue(shipHealthAtom);
  const prevHealth = useRef(health);
  useEffect(() => {
    if (health < prevHealth.current) {
      // Ship-frame impact: unpanned, because it is the hull you are inside.
      playAudio("click.hard", { gainDb: 4 });
    }
    prevHealth.current = health;
  }, [health]);

  // ── Hull integrity through A12's shared alert primitive ──────────────────
  // The proof case for A12: tiers, hysteresis, backoff and acknowledgement all
  // come from the primitive, so oxygen/fuel/power/heat are one `registerAlert`
  // call each when they exist — not four more bespoke alarm loops.
  useEffect(() => {
    registerAlert("hull");
    return () => unregisterAlert("hull");
  }, []);
  useEffect(() => {
    // `shipHealthAtom` is 0..100. Human-rate, so an effect is fine here — the
    // primitive owns all the scheduling, this only reports the value.
    updateAlert("hull", health / 100);
  }, [health]);

  const isDead = useAtomValue(isDeadAtom);
  const prevDead = useRef(isDead);
  useEffect(() => {
    if (isDead && !prevDead.current) playAlarm("critical");
    prevDead.current = isDead;
  }, [isDead]);

  // ── Transit drive ────────────────────────────────────────────────────────
  const phase = useAtomValue(transitPhaseAtom);
  const prevPhase = useRef(phase);
  useEffect(() => {
    if (phase !== prevPhase.current) {
      if (phase === "accelerating") playAudio("notify.info", { gainDb: 3 });
      else if (phase === "decelerating") playAudio("click.soft");
      else if (phase === "idle" && prevPhase.current === "decelerating")
        playAudio("notify.info");
    }
    prevPhase.current = phase;
  }, [phase]);

  // ── Progression ──────────────────────────────────────────────────────────
  const crafted = useAtomValue(itemCraftedSignalAtom);
  const prevCrafted = useRef(crafted);
  useEffect(() => {
    if (crafted > prevCrafted.current) playAudio("notify.info");
    prevCrafted.current = crafted;
  }, [crafted]);

  const lastResearch = useAtomValue(lastCompletedResearchIdAtom);
  const prevResearch = useRef(lastResearch);
  useEffect(() => {
    if (lastResearch && lastResearch !== prevResearch.current)
      playAudio("notify.info", { gainDb: 2 });
    prevResearch.current = lastResearch;
  }, [lastResearch]);

  // ── Toasts ───────────────────────────────────────────────────────────────
  // One watcher covers seven call sites. It reads `kind` rather than
  // pattern-matching the message text (trap T13) — the field was added to
  // `toast.ts` for exactly this.
  const toasts = useAtomValue(toastsAtom);
  const seenToastRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    for (const t of toasts) {
      if (seenToastRef.current.has(t.id)) continue;
      seenToastRef.current.add(t.id);
      playAudio(t.kind === "warn" ? "notify.warn" : "notify.info");
    }
    if (seenToastRef.current.size > 128) {
      seenToastRef.current = new Set(toasts.map((t) => t.id));
    }
  }, [toasts]);

  return null;
}
