"use client";

// ---------------------------------------------------------------------------
// GameCommsTriggers — centralized comms triggers for ALL gameplay events.
//
// Watches atoms and enqueues messages on state transitions.
// The played-message registry in the comms store prevents replays.
// ---------------------------------------------------------------------------

import { useEffect, useRef } from "react";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { shipHealthAtom } from "@/store/store";
import { miningStateAtom, asteroidMinedSignalAtom } from "@/store/mining";
import { isCargoFullAtom } from "@/store/cargo";
import { researchAtom, completedNodeSetAtom } from "@/store/research";
import { modulesAtom, itemCraftedSignalAtom } from "@/store/modules";
import { aiNameAtom } from "@/store/aiName";
import { enqueueCommsAtom } from "@/store/comms";
import { COMMS_MESSAGES, type CommsMessage } from "@/data/commsMessages";

// Derived atom so we don't rerender on every mining-state frame update
const isOverheatedAtom = atom((get) => get(miningStateAtom).isOverheated);

export default function GameCommsTriggers() {
  const enqueue = useSetAtom(enqueueCommsAtom);

  // ── Welcome sequence ────────────────────────────────────────────────
  // Phase 1: AI greeting fires on mount (before naming)
  // Phase 2: AI intro + Dr. Stern welcome fire after player names the AI
  const aiName = useAtomValue(aiNameAtom);

  useEffect(() => {
    const greeting = COMMS_MESSAGES.ai_greeting_001;
    if (greeting) enqueue(greeting);
  }, [enqueue]);

  useEffect(() => {
    if (!aiName) return;
    const intro = COMMS_MESSAGES.ai_intro_001;
    if (intro) enqueue(intro);
    const welcome = COMMS_MESSAGES.welcome_001;
    if (welcome) enqueue(welcome);
  }, [aiName, enqueue]);

  // ── First mining completion ─────────────────────────────────────────
  const minedCount = useAtomValue(asteroidMinedSignalAtom);
  const minedFiredRef = useRef(false);

  useEffect(() => {
    if (minedFiredRef.current || minedCount === 0) return;
    minedFiredRef.current = true;
    const msg = COMMS_MESSAGES.mining_001;
    if (msg) enqueue(msg);
  }, [minedCount, enqueue]);

  // ── First damage ────────────────────────────────────────────────────
  const health = useAtomValue(shipHealthAtom);
  const prevHealthRef = useRef(health);
  const damageFiredRef = useRef(false);

  useEffect(() => {
    if (damageFiredRef.current) return;
    // Trigger when health drops (but not on death — that has its own message)
    if (health < prevHealthRef.current && health > 0) {
      damageFiredRef.current = true;
      const msg = COMMS_MESSAGES.first_damage_001;
      if (msg) enqueue(msg);
    }
    prevHealthRef.current = health;
  }, [health, enqueue]);

  // ── Overheat (context-aware) ────────────────────────────────────────
  const isOverheated = useAtomValue(isOverheatedAtom);
  const completedNodes = useAtomValue(completedNodeSetAtom);
  const modules = useAtomValue(modulesAtom);
  const overheatFiredRef = useRef(false);

  useEffect(() => {
    if (overheatFiredRef.current || !isOverheated) return;
    overheatFiredRef.current = true;

    const hasThermalResearch = completedNodes.has("r2_thermal_management");
    const heatSinkCount =
      modules.consumables["consumable_heat_sink_cartridge"] ?? 0;

    let textContent: string[];

    if (heatSinkCount > 0) {
      // Player has heat sinks: tell them to use one
      textContent = [
        "Laser overheated. You have Heat Sink Cartridges in your inventory. Use one to skip the cooldown.",
      ];
    } else if (hasThermalResearch) {
      // Research done but no cartridges: suggest crafting
      textContent = [
        "Laser overheated. Forced cooldown. The current optics still can't handle sustained mining on larger asteroids without hitting the thermal limit.",
        "You have the Heat Sink Cartridge blueprint unlocked. Craft a few when you get the chance. They dump laser heat instantly, lets you keep mining without waiting out the full cooldown.",
      ];
    } else {
      // No research yet: point them to the research tree
      textContent = [
        "Mining laser thermal capacity exceeded. Forced cooldown in progress. The current optics can't sustain fire long enough to mine larger asteroids in a single pass.",
        "I've identified a Thermal Management research path that would unlock heat sink cartridges. Single-use, but they dump excess heat on the spot. Could be worth prioritizing.",
      ];
    }

    enqueue({
      messageId: "overheat_001",
      speaker: "{{AI_NAME}}",
      textContent,
      priority: 1,
    });
  }, [isOverheated, completedNodes, modules.consumables, enqueue]);

  // ── Cargo full ──────────────────────────────────────────────────────
  const isCargoFull = useAtomValue(isCargoFullAtom);
  const cargoFiredRef = useRef(false);

  useEffect(() => {
    if (cargoFiredRef.current || !isCargoFull) return;
    cargoFiredRef.current = true;
    const msg = COMMS_MESSAGES.cargo_full_001;
    if (msg) enqueue(msg);
  }, [isCargoFull, enqueue]);

  // ── MicroLab research started ───────────────────────────────────────
  const research = useAtomValue(researchAtom);
  const microlabStartFiredRef = useRef(false);

  useEffect(() => {
    if (microlabStartFiredRef.current) return;
    if (research.activeResearch?.nodeId === "r0_microlab_boot") {
      microlabStartFiredRef.current = true;
      const msg = COMMS_MESSAGES.research_start_001;
      if (msg) enqueue(msg);
    }
  }, [research.activeResearch, enqueue]);

  // ── MicroLab research completed ─────────────────────────────────────
  const microlabCompleteFiredRef = useRef(false);

  useEffect(() => {
    if (microlabCompleteFiredRef.current) return;
    if (completedNodes.has("r0_microlab_boot")) {
      microlabCompleteFiredRef.current = true;
      const msg = COMMS_MESSAGES.research_complete_001;
      if (msg) enqueue(msg);
    }
  }, [completedNodes, enqueue]);

  // ── First item crafted ──────────────────────────────────────────────
  const craftCount = useAtomValue(itemCraftedSignalAtom);
  const craftFiredRef = useRef(false);

  useEffect(() => {
    if (craftFiredRef.current || craftCount === 0) return;
    craftFiredRef.current = true;
    const msg = COMMS_MESSAGES.first_craft_001;
    if (msg) enqueue(msg);
  }, [craftCount, enqueue]);

  return null;
}
