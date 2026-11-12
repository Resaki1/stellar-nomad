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
import { useEffect, useRef } from "react";
import { atom, useAtomValue, useStore } from "jotai";

import { playAudio, registerEmitter, stopVoiceBySerial, voiceEndTime } from "@/audio";
import { engineLayerGain } from "@/audio/engineLayers";
import { CUTTER_HANDOFF_S, CUTTER_ATTACK_MS, CUTTER_RELEASE_MS, cutterPitchCents, targetFeedbackCue } from "@/audio/miningFeedback";
import { activeCommsMessageAtom } from "@/store/comms";
import { audioActionCountsAtom, isShipAISpeaker, type AudioAction } from "@/store/audioSignals";
import { playAlarm, setAlarmsEnabled, stopAllAlarms } from "@/audio/alarms";
import { registerAlert, updateAlert, unregisterAlert } from "@/audio/alerts";
import { audioShipBuffer } from "@/audio/shipBuffer";
import { windLayerGain, windState } from "@/audio/wind";
import { shipHealthAtom, settingsIsOpenAtom } from "@/store/store";
import { vfxEventsAtom } from "@/store/vfx";
import { miningStateAtom, asteroidMinedSignalAtom, targetingProgressAtom } from "@/store/mining";
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
const isMiningAtom = atom((get) => get(miningStateAtom).isMining);
const targetKeyAtom = atom((get) => {
  const t = get(miningStateAtom).targetedAsteroid;
  return t ? `${t.location.fieldId}:${t.instanceId}` : null;
});
const targetingStepAtom = atom((get) => Math.floor(get(targetingProgressAtom) * 6));
const transitPhaseAtom = atom((get) => get(transitStateAtom).phase);

export default function GameAudioTriggers() {
  const store = useStore();
  const health = useAtomValue(shipHealthAtom);
  const dead = useAtomValue(isDeadAtom);
  const isDead = dead || health <= 0;
  const settingsOpen = useAtomValue(settingsIsOpenAtom);

  // Thrust-only engine beds: no RCS clicks, cabin bed, or idle floor. Coasting
  // can be completely silent. Layers still share an audio-clock phase.
  useEffect(() => {
    if (isDead) return;
    const engines = (["ship.engine.idle", "ship.engine.mid", "ship.engine.high"] as const)
      .map((event, layer) => registerEmitter({
        event,
        intensity: () => engineLayerGain(layer as 0 | 1 | 2, audioShipBuffer.throttle),
      }));
    return () => engines.forEach((e) => e.stop());
  }, [isDead]);

  // Aerodynamic wind, AUDIO_PLAN §12.3. Registered unconditionally in flight:
  // the bed is silent in vacuum because `q = ½ρv²` goes to zero there and the
  // emitter culls itself, NOT because anything here decides when to start it.
  // That is the point of deriving it — nobody has to author "now you are in
  // air", and the same code gives Earth, Mars and Venus different answers.
  useEffect(() => {
    if (isDead) return;
    const wind = (["ship.wind.low", "ship.wind.mid", "ship.wind.high"] as const)
      .map((event, layer) => registerEmitter({
        event,
        intensity: () => windLayerGain(layer as 0 | 1 | 2, windState.qPa),
        // The emitter promotes a layer the moment its product crosses
        // CULL_ENTER_GAIN, i.e. at -34 dBFS, and the default loop attack is
        // 25 ms — which is a step, not a swell. Air does not arrive in 25 ms.
        fadeInMs: 1200,
      }));
    return () => wind.forEach((e) => e.stop());
  }, [isDead]);

  // Mining audio is cutter hardware aboard our ship, not sound travelling back
  // from the distant rock along a laser beam. Stop the sustain on pause/death.
  const mining = useAtomValue(isMiningAtom) && !isDead && !settingsOpen;
  useEffect(() => {
    if (!mining) return;
    const pitch = () => cutterPitchCents(store.get(miningStateAtom).laserHeat);
    const startup = playAudio("mining.laser.start", { queueOnUnlock: false, pitchCents: pitch() });
    const end = startup === null ? null : voiceEndTime(startup);
    const emitter = registerEmitter({
      event: "mining.laser.loop",
      intensity: 1,
      pitchCents: pitch,
      fadeInMs: CUTTER_ATTACK_MS,
      // Blend only the final edge fade, using the decoded, pitch-adjusted end.
      startAtS: end === null ? undefined : end - CUTTER_HANDOFF_S,
    });
    return () => {
      if (startup !== null) stopVoiceBySerial(startup, 20);
      emitter.stop(CUTTER_RELEASE_MS);
    };
  }, [mining, store]);
  const prevMining = useRef(mining);
  useEffect(() => {
    if (!mining && prevMining.current && !isDead) playAudio("mining.laser.stop", {
      fadeInMs: 45, pitchCents: cutterPitchCents(store.get(miningStateAtom).laserHeat),
      queueOnUnlock: false,
    });
    prevMining.current = mining;
  }, [mining, isDead, store]);

  // ── Physical asteroid impacts (spatialised) ───────────────────────
  // `vfxEventsAtom` is the right source rather than `cameraShakeIntensityAtom`:
  // both are set by the same hit, but only this one carries `position` and
  // `radiusM` (trap T12 — watching both would play two sounds per impact).
  const vfxEvents = useAtomValue(vfxEventsAtom);
  const playedVfxRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    for (const ev of vfxEvents) {
      if (playedVfxRef.current.has(ev.id)) continue;
      playedVfxRef.current.add(ev.id);
      if (ev.type !== "collision") continue;
      // Larger rocks use the heavier palette; both events jitter pitch and
      // gain per play, so repeats do not sound identical (§6.4).
      const sizeDb = Math.min(6, Math.max(-6, Math.log10(Math.max(1, ev.radiusM)) * 6 - 6));
      playAudio(ev.radiusM >= 64 ? "world.impact.large" : "world.impact.small", {
        positionM: { x: ev.position[0], y: ev.position[1], z: ev.position[2] },
        gainDb: sizeDb - 3,
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
    if (minedCount > prevMined.current) playAudio("mining.complete");
    prevMined.current = minedCount;
  }, [minedCount]);

  const isFocused = useAtomValue(isFocusedAtom);
  const target = useAtomValue(targetKeyAtom);
  const step = useAtomValue(targetingStepAtom);
  const feedbackEnabled = !isDead && !settingsOpen;
  const previousTarget = useRef({ target, step, focused: isFocused, mined: minedCount, enabled: feedbackEnabled });
  useEffect(() => {
    const next = { target, step, focused: isFocused, mined: store.get(asteroidMinedSignalAtom), enabled: feedbackEnabled };
    const cue = targetFeedbackCue(previousTarget.current, next);
    if (cue) playAudio(cue, { queueOnUnlock: false, pitchCents: cue === "mining.target.acquire" ? step * 55 : 0 });
    previousTarget.current = next;
  }, [target, step, isFocused, minedCount, feedbackEnabled, store]);

  // Overheat is edge-triggered on the COMMITTED boolean, not on the heat value
  // crossing a threshold — trap T10: the ref clears at heat <= 0 on natural
  // cooldown but at heat < 1 after a heat sink, so a value-crossing hook misses
  // the heat-sink path entirely.
  const isOverheated = useAtomValue(isOverheatedAtom);
  const prevOverheated = useRef(isOverheated);
  useEffect(() => {
    // A synthesised caution tone, not a sampled placeholder — §6.3's alarms are
    // the one content category that is FINISHED rather than placeholdered.
    if (!isDead && isOverheated && !prevOverheated.current) playAlarm("caution");
    prevOverheated.current = isOverheated;
  }, [isOverheated, isDead]);

  const cargoFull = useAtomValue(isCargoFullAtom);
  const prevCargoFull = useRef(cargoFull);
  useEffect(() => {
    // Advisory, deliberately: a full hold is information, not an emergency.
    // Using the same tier for everything is how alarm fatigue starts.
    if (!isDead && cargoFull && !prevCargoFull.current) playAlarm("advisory");
    prevCargoFull.current = cargoFull;
  }, [cargoFull, isDead]);

  // ── Damage and death ─────────────────────────────────────────────────────
  const prevHealth = useRef(health);
  useEffect(() => {
    if (health < prevHealth.current) {
      // Ship-frame impact: unpanned, because it is the hull you are inside.
      playAudio("ship.damage.impact", { gainDb: -4 });
      if (prevHealth.current - health >= 10) playAudio("ship.hull.stress");
    }
    prevHealth.current = health;
  }, [health]);

  // Death cancels both future reminders and already scheduled oscillator bursts.
  // Re-registering on respawn starts a fresh alert episode.
  useEffect(() => {
    setAlarmsEnabled(!isDead);
    if (!isDead) registerAlert("hull");
    return () => { unregisterAlert("hull"); stopAllAlarms(); };
  }, [isDead]);

  // Destruction, then the bed under the death screen.
  //
  // ⚠ Order matters and it is not arbitrary: the effect above calls
  // `stopAllAlarms()`, which cancels scheduled oscillator bursts. `playAudio` is
  // a different path and is untouched by it, so the destruction one-shot
  // survives — but a future alarm-based destruction cue would NOT, and would
  // vanish exactly when it mattered most.
  const prevDead = useRef(isDead);
  useEffect(() => {
    if (isDead && !prevDead.current) playAudio("ship.destroyed");
    prevDead.current = isDead;
  }, [isDead]);
  useEffect(() => {
    if (!isDead) return;
    // Registered rather than played: it is a loop with a lifetime, and it must
    // stop the instant the player respawns (A11).
    const bed = registerEmitter({ event: "death.bed" });
    return () => bed.stop();
  }, [isDead]);
  useEffect(() => {
    if (!isDead) updateAlert("hull", health / 100);
  }, [health, isDead]);

  // ── Transit drive ────────────────────────────────────────────────────────
  const phase = useAtomValue(transitPhaseAtom);
  const prevPhase = useRef(phase);
  useEffect(() => {
    let cue: number | null = null;
    if (!isDead && phase !== prevPhase.current) {
      if (phase === "spooling") cue = playAudio("transit.spool");
      else if (phase === "accelerating") cue = playAudio("transit.engage");
      else if (phase === "decelerating") cue = playAudio("transit.decel");
      else if (phase === "idle" && prevPhase.current === "decelerating")
        playAudio("transit.arrive");
    }
    prevPhase.current = phase;
    // Spool/decel cues are cancellable, so aborted transit cannot leave a tail.
    return () => { if (cue !== null) stopVoiceBySerial(cue, 80); };
  }, [phase, isDead]);
  const inTransit = !isDead && (phase === "accelerating" || phase === "decelerating");
  useEffect(() => {
    if (!inTransit) return;
    const emitter = registerEmitter({ event: "transit.loop", intensity: 1 });
    return () => emitter.stop();
  }, [inTransit]);

  // ── Progression ──────────────────────────────────────────────────────────
  const crafted = useAtomValue(itemCraftedSignalAtom);
  const prevCrafted = useRef(crafted);
  useEffect(() => {
    if (crafted > prevCrafted.current) playAudio("craft.complete");
    prevCrafted.current = crafted;
  }, [crafted]);

  const lastResearch = useAtomValue(lastCompletedResearchIdAtom);
  const prevResearch = useRef(lastResearch);
  useEffect(() => {
    if (lastResearch && lastResearch !== prevResearch.current)
      playAudio("research.complete");
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
      if (t.audio === "silent") continue;
      playAudio(t.audio === "reject" ? "ui.reject" : t.kind === "warn" ? "notify.warn" : "notify.info");
    }
    if (seenToastRef.current.size > 128) {
      seenToastRef.current = new Set(toasts.map((t) => t.id));
    }
  }, [toasts]);

  const actions = useAtomValue(audioActionCountsAtom);
  const previousActions = useRef(actions);
  useEffect(() => {
    for (const event of Object.keys(actions) as AudioAction[]) {
      if ((actions[event] ?? 0) > (previousActions.current[event] ?? 0)) playAudio(event);
    }
    previousActions.current = actions;
  }, [actions]);

  const message = useAtomValue(activeCommsMessageAtom);
  const previousMessage = useRef<string | null>(null);
  useEffect(() => {
    if (message && message.messageId !== previousMessage.current && isShipAISpeaker(message.speaker))
      playAudio("comms.chirp.arrive");
    previousMessage.current = message?.messageId ?? null;
  }, [message]);

  return null;
}
