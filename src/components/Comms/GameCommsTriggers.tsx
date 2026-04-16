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
import { researchAtom, completedNodeSetAtom, lastCompletedResearchIdAtom } from "@/store/research";
import { modulesAtom, itemCraftedSignalAtom, lastCraftedItemIdAtom } from "@/store/modules";
import { aiNameAtom } from "@/store/aiName";
import { enqueueCommsAtom } from "@/store/comms";
import { COMMS_MESSAGES, RESEARCH_COMPLETE_MESSAGES, ITEM_CRAFTED_MESSAGES } from "@/data/commsMessages";
import { TIER_2_NODE_IDS } from "@/data/content";

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

    const hasThermalResearch = completedNodes.has("b2b_thermal_dynamics");
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
        "You have the fabrication specs for heat sink cartridges. Worth putting a few together when you get the chance — they dump laser heat on the spot.",
      ];
    } else {
      // No research yet: point them to the research tree
      textContent = [
        "Mining laser thermal capacity exceeded. Forced cooldown in progress. The current optics can't sustain fire long enough to mine larger asteroids in a single pass.",
        "There's a thermal management approach in the research data that could help. It would unlock heat sink cartridges. Single-use, but they dump excess heat on the spot. Could be worth prioritizing.",
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

  // ── Elara's first message (after first craft) ──────────────────────
  const elara1FiredRef = useRef(false);

  useEffect(() => {
    if (elara1FiredRef.current || craftCount === 0) return;
    elara1FiredRef.current = true;
    const msg = COMMS_MESSAGES.elara_001;
    if (msg) enqueue(msg);
  }, [craftCount, enqueue]);

  // ── Stern foreshadowing: overbuilt (after 2+ tier-1 nodes) ─────────
  const sternOverbuiltFiredRef = useRef(false);

  useEffect(() => {
    if (sternOverbuiltFiredRef.current) return;
    const tier1Nodes = [
      "a1_sensor_calibration",
      "b1_laser_optics",
      "c1_structural_engineering",
    ];
    const completedTier1 = tier1Nodes.filter((n) => completedNodes.has(n));
    if (completedTier1.length >= 2) {
      sternOverbuiltFiredRef.current = true;
      const msg = COMMS_MESSAGES.stern_overbuilt_001;
      if (msg) enqueue(msg);
    }
  }, [completedNodes, enqueue]);

  // ── AI observation: pattern-noticing (after 8+ asteroids mined) ────
  const aiObsFiredRef = useRef(false);

  useEffect(() => {
    if (aiObsFiredRef.current || minedCount < 8) return;
    aiObsFiredRef.current = true;
    const msg = COMMS_MESSAGES.ai_observation_001;
    if (msg) enqueue(msg);
  }, [minedCount, enqueue]);

  // ── Elara's second message (after 5+ research nodes completed) ─────
  const elara2FiredRef = useRef(false);

  useEffect(() => {
    if (elara2FiredRef.current) return;
    if (completedNodes.size >= 5) {
      elara2FiredRef.current = true;
      const msg = COMMS_MESSAGES.elara_002;
      if (msg) enqueue(msg);
    }
  }, [completedNodes, enqueue]);

  // ── Stern earth update (after any tier-2 node) ─────────────────────
  const sternUpdateFiredRef = useRef(false);

  useEffect(() => {
    if (sternUpdateFiredRef.current) return;
    const hasAnyTier2 = TIER_2_NODE_IDS.some((n) => completedNodes.has(n));
    if (hasAnyTier2) {
      sternUpdateFiredRef.current = true;
      const msg = COMMS_MESSAGES.stern_earth_update_001;
      if (msg) enqueue(msg);
    }
  }, [completedNodes, enqueue]);

  // ── ESA bulletin (after thermal dynamics OR propulsion systems) ──────
  const esaBulletinFiredRef = useRef(false);

  useEffect(() => {
    if (esaBulletinFiredRef.current) return;
    if (
      completedNodes.has("b2b_thermal_dynamics") ||
      completedNodes.has("c2b_propulsion_systems")
    ) {
      esaBulletinFiredRef.current = true;
      const msg = COMMS_MESSAGES.esa_bulletin_001;
      if (msg) enqueue(msg);
    }
  }, [completedNodes, enqueue]);

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

  return null;
}
