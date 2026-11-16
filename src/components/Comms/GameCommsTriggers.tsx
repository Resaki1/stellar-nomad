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
import { completedNodeSetAtom, lastCompletedResearchIdAtom } from "@/store/research";
import { modulesAtom, itemCraftedSignalAtom, lastCraftedItemIdAtom } from "@/store/modules";
import { aiNameAtom } from "@/store/aiName";
import { enqueueCommsAtom } from "@/store/comms";
import { transitStateAtom } from "@/store/transit";
import { COMMS_MESSAGES, RESEARCH_COMPLETE_MESSAGES, ITEM_CRAFTED_MESSAGES } from "@/data/commsMessages";

// Derived atom so we don't rerender on every mining-state frame update
const isOverheatedAtom = atom((get) => get(miningStateAtom).isOverheated);

export default function GameCommsTriggers() {
  const enqueue = useSetAtom(enqueueCommsAtom);

  // ── Welcome sequence ────────────────────────────────────────────────
  // Phase 1: AI greeting fires on mount (before naming)
  // Phase 2: AI intro fires after the player names the AI
  const aiName = useAtomValue(aiNameAtom);

  useEffect(() => {
    const greeting = COMMS_MESSAGES.ai_greeting_001;
    if (greeting) enqueue(greeting);
  }, [enqueue]);

  useEffect(() => {
    if (!aiName) return;
    const intro = COMMS_MESSAGES.ai_intro_001;
    if (intro) enqueue(intro);
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

    const hasThermalResearch = completedNodes.has("th1_heat_rejection");
    const heatSinkCount =
      modules.consumables["consumable_heat_sink_cartridge"] ?? 0;

    let textContent: string[];

    if (heatSinkCount > 0) {
      // Player has heat sinks: tell them to use one
      textContent = [
        "Laser overheated. You have heat sink cartridges on hand — one of those would skip the cooldown entirely.",
      ];
    } else if (hasThermalResearch) {
      // Research done but no cartridges: suggest crafting
      textContent = [
        "Laser overheated. Forced cooldown. The current optics still can't handle sustained mining on larger asteroids without hitting the thermal limit.",
        "Radiator strips or a coolant circulator would buy longer runs. Heat sink cartridges dump heat on the spot, and they're in the basic fabrication specs.",
      ];
    } else {
      // No thermal research yet: point at the trial and the starter cartridges
      textContent = [
        "Mining laser thermal capacity exceeded. Forced cooldown in progress. The current optics can't sustain fire long enough to mine larger asteroids in a single pass.",
        "If you keep the beam on one rock for a sustained run without tripping it, I can work out better heat rejection. Heat sink cartridges are in the basic fabrication specs too.",
        "Alternatively, search for smaller asteroids."
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

  // ── First item crafted ──────────────────────────────────────────────
  const craftCount = useAtomValue(itemCraftedSignalAtom);
  const craftFiredRef = useRef(false);

  useEffect(() => {
    if (craftFiredRef.current || craftCount === 0) return;
    craftFiredRef.current = true;
    const msg = COMMS_MESSAGES.first_craft_001;
    if (msg) enqueue(msg);
  }, [craftCount, enqueue]);

  // ── AI observation: pattern-noticing (after 8+ asteroids mined) ────
  const aiObsFiredRef = useRef(false);

  useEffect(() => {
    if (aiObsFiredRef.current || minedCount < 8) return;
    aiObsFiredRef.current = true;
    const msg = COMMS_MESSAGES.ai_observation_001;
    if (msg) enqueue(msg);
  }, [minedCount, enqueue]);

  // ── Per-research completion messages ────────────────────────────────
  const lastResearchId = useAtomValue(lastCompletedResearchIdAtom);

  useEffect(() => {
    if (!lastResearchId) return;
    const msg = RESEARCH_COMPLETE_MESSAGES[lastResearchId];
    if (msg) enqueue(msg);
  }, [lastResearchId, enqueue]);

  // ── Per-item craft messages ────────────────────────────────────────
  const lastCraftedId = useAtomValue(lastCraftedItemIdAtom);

  useEffect(() => {
    if (!lastCraftedId) return;
    const msg = ITEM_CRAFTED_MESSAGES[lastCraftedId];
    if (msg) enqueue(msg);
  }, [lastCraftedId, enqueue]);

  // ── Transit drive: first use + arrival ──────────────────────────────
  const transitState = useAtomValue(transitStateAtom);
  const prevPhaseRef = useRef(transitState.phase);
  const transitUsedRef = useRef(false);

  useEffect(() => {
    const prev = prevPhaseRef.current;
    const curr = transitState.phase;

    // Fire "first transit" message when drive first engages
    if (curr === "accelerating" && prev !== "accelerating" && !transitUsedRef.current) {
      transitUsedRef.current = true;
      const msg = COMMS_MESSAGES.transit_first_001;
      if (msg) enqueue(msg);
    }

    // Fire arrival messages when drive disengages (was active, now idle)
    if (curr === "idle" && (prev === "decelerating" || prev === "accelerating") && transitUsedRef.current) {
      // Lunar arrival (if target was lunar)
      if (transitState.target?.id?.includes("luna") || transitState.target?.id?.includes("moon")) {
        const arrival = COMMS_MESSAGES.lunar_arrival_001;
        if (arrival) enqueue(arrival);
      }
    }

    prevPhaseRef.current = curr;
  }, [transitState.phase, transitState.target, enqueue]);

  return null;
}
