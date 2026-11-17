"use client";

// ---------------------------------------------------------------------------
// GameCommsTriggers: every comms entry and hint trigger lives here (M3.7).
// Comms are sparse and contextual; routine state goes to one-time hints. The played
// registry (player save, `commsPlayed`) prevents replays across reloads.
// ---------------------------------------------------------------------------

import { useEffect, useMemo } from "react";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { COMMS_MESSAGES } from "@/data/commsMessages";
import { HINTS, type HintDef } from "@/data/guidance";
import { RESEARCH_NODES } from "@/data/content";
import { evaluateNode } from "@/sim/research/requirements";
import { aiNameAtom } from "@/store/aiName";
import { cargoAtom, isCargoFullAtom } from "@/store/cargo";
import { activeHintAtom, enqueueCommsAtom, playedMessageIdsAtom, showHintAtom } from "@/store/comms";
import { isDeadAtom } from "@/store/death";
import { miningStateAtom } from "@/store/mining";
import { modulesAtom } from "@/store/modules";
import { kitCountAtom, lastRecoveryAtom } from "@/store/replication";
import { discoveriesMirrorAtom, evidenceViewAtom } from "@/store/research";
import { shipResourcesHudAtom } from "@/store/shipResources";
import { glanceAtom } from "@/store/sites";
import { shipHealthAtom } from "@/store/store";

const focusedAtom = atom((get) => get(miningStateAtom).isFocused);
const heatWarnAtom = atom((get) => get(shipResourcesHudAtom).heatWarn);
const lowFuelAtom = atom((get) => {
  const r = get(shipResourcesHudAtom);
  return r.tankKg > 1 && r.ordinaryKg < r.tankKg * 0.15;
});
const hasHydratesAtom = atom((get) => (get(cargoAtom).items.hydrates ?? 0) > 0);
const hasDriveAtom = atom((get) => get(modulesAtom).ownedModules.includes("special_transit_drive"));
const researchReadyAtom = atom((get) => {
  const ev = get(evidenceViewAtom);
  return RESEARCH_NODES.some((n) => !ev.completed.has(n.id) && evaluateNode(n, ev).met);
});
const frameAtom = atom((get) => get(glanceAtom).frameId);
const damagedAtom = atom((get) => {
  const h = get(shipHealthAtom);
  return h > 0 && h < 99.5;
});

const siteNearAtom = atom((get) => {
  const s = get(glanceAtom).site;
  return !!s && s.distKm <= 2;
});

/** Show `hint` once while `when` holds (and the ship is alive). */
function useHint(hint: HintDef, when: boolean, dead: boolean): void {
  const show = useSetAtom(showHintAtom);
  const busy = useAtomValue(activeHintAtom) !== null;
  useEffect(() => {
    if (when && !dead && !busy) show(hint);
  }, [hint, when, dead, busy, show]);
}

export default function GameCommsTriggers() {
  const enqueue = useSetAtom(enqueueCommsAtom);
  const aiName = useAtomValue(aiNameAtom);
  const played = useAtomValue(playedMessageIdsAtom);
  const dead = useAtomValue(isDeadAtom);
  const playedSet = useMemo(() => new Set(played), [played]);

  // ── Opening premise, naming, first opportunity ──
  useEffect(() => {
    if (!aiName) enqueue(COMMS_MESSAGES.opening_001);
  }, [aiName, enqueue]);
  const openedHere = playedSet.has("opening_001");
  useEffect(() => {
    if (aiName && openedHere) enqueue(COMMS_MESSAGES.opening_002);
  }, [aiName, openedHere, enqueue]);
  // Older saves (named before M3.7) get the projects hint without the opening.
  const openingDone = !!aiName && (playedSet.has("opening_002") || !openedHere);
  useHint(HINTS.projects, openingDone, dead);

  // ── Contextual one-time hints ──
  useHint(HINTS.lock, useAtomValue(focusedAtom) && openingDone, dead);
  useHint(HINTS.hydrates, useAtomValue(hasHydratesAtom), dead);
  useHint(HINTS.research, useAtomValue(researchReadyAtom), dead);
  useHint(HINTS.heat, useAtomValue(heatWarnAtom), dead);
  useHint(HINTS.cargoFull, useAtomValue(isCargoFullAtom), dead);
  useHint(HINTS.lowFuel, useAtomValue(lowFuelAtom), dead);
  useHint(HINTS.kit, useAtomValue(kitCountAtom) > 0, dead);
  useHint(HINTS.drive, useAtomValue(hasDriveAtom), dead);
  useHint(HINTS.recovered, useAtomValue(lastRecoveryAtom) !== null, dead);
  useHint(HINTS.site, useAtomValue(siteNearAtom), dead);

  useHint(HINTS.damage, useAtomValue(damagedAtom) && openingDone, dead);

  // ── Lunar space and the survey site ──
  const frameId = useAtomValue(frameAtom);
  useEffect(() => {
    if (frameId === "luna" && !dead) enqueue(COMMS_MESSAGES.lunar_signal_001);
  }, [frameId, dead, enqueue]);
  const recovered = !!useAtomValue(discoveriesMirrorAtom).sites.luna_survey_canister;
  useEffect(() => {
    if (recovered) enqueue(COMMS_MESSAGES.site_recovered_001);
  }, [recovered, enqueue]);

  return null;
}
