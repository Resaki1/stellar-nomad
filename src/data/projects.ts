// ---------------------------------------------------------------------------
// Tracked projects (M3.7): a player-chosen ambition turned into actionable steps in the
// objective tracker. Optional, any number of times, never a campaign. Evaluated by
// src/sim/research/projects.ts.
// ---------------------------------------------------------------------------

import { RESEARCH_NODES } from "./content";

export type ProjectStep =
  | { kind: "research"; nodeId: string }
  | { kind: "own"; itemId: string }
  /** Ordinary propellant aboard, kg at Standard (scaled by the difficulty's fuel use). */
  | { kind: "fuel"; kg: number; label: string }
  | { kind: "inFrame"; frameId: string; label: string }
  | { kind: "siteInspected"; siteId: string }
  | { kind: "siteRecovered"; siteId: string }
  /** A replication point this player placed (optionally in a frame). */
  | { kind: "point"; frameId?: string; label: string };

export type ProjectDef = {
  id: string;
  name: string;
  summary: string;
  steps: ProjectStep[];
  /** Transit destination the tracker offers ("Set destination"). */
  destination?: { siteId: string } | { bodyId: string };
};

const AUTHORED: ProjectDef[] = [
  {
    id: "reach_moon",
    name: "Reach the Moon",
    summary: "Build the transit drive, fuel up and travel to lunar space.",
    steps: [
      { kind: "research", nodeId: "pr1_transit_calibration" },
      { kind: "own", itemId: "special_transit_drive" },
      { kind: "fuel", kg: 280, label: "Enough for Earth to Moon with a margin" },
      { kind: "inFrame", frameId: "luna", label: "Arrive in lunar space" },
    ],
    destination: { bodyId: "luna" },
  },
  {
    id: "forward_point",
    name: "Build a forward replication point",
    summary: "Fabricate a replication kit and place it where you want to recover.",
    steps: [
      { kind: "own", itemId: "consumable_replication_kit" },
      { kind: "point", label: "Place a replication point (B)" },
    ],
  },
  {
    id: "lunar_survey",
    name: "Recover the lunar survey canister",
    summary: "Follow the automated survey signal near the Moon and recover its instrument canister.",
    steps: [
      { kind: "own", itemId: "special_transit_drive" },
      { kind: "inFrame", frameId: "luna", label: "Arrive in lunar space" },
      { kind: "siteInspected", siteId: "luna_survey_canister" },
      { kind: "siteRecovered", siteId: "luna_survey_canister" },
      { kind: "research", nodeId: "ln1_survey_salvage" },
      { kind: "own", itemId: "module_integrated_sensor_suite" },
    ],
    destination: { siteId: "luna_survey_canister" },
  },
  {
    id: "lunar_foothold",
    name: "Establish a lunar foothold",
    summary: "Place a replication point in lunar space, so recovery no longer means Earth.",
    steps: [
      { kind: "own", itemId: "special_transit_drive" },
      { kind: "inFrame", frameId: "luna", label: "Arrive in lunar space" },
      { kind: "own", itemId: "consumable_replication_kit" },
      { kind: "point", frameId: "luna", label: "Place a replication point in lunar space" },
    ],
    destination: { bodyId: "luna" },
  },
];

/** Every research option is also a project ("research:<nodeId>"). */
export const PROJECTS: ProjectDef[] = [
  ...AUTHORED,
  ...RESEARCH_NODES.map((n) => ({
    id: `research:${n.id}`,
    name: `Research: ${n.name}`,
    summary: n.purpose,
    steps: [{ kind: "research" as const, nodeId: n.id }],
  })),
];

export const AUTHORED_PROJECT_IDS: readonly string[] = AUTHORED.map((p) => p.id);

export function getProjectDef(id: string): ProjectDef | undefined {
  return PROJECTS.find((p) => p.id === id);
}
