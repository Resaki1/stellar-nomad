"use client";

// ---------------------------------------------------------------------------
// GameCommsTriggers: every comms entry and hint trigger lives here (M3.7).
// Comms are sparse and contextual; routine state goes to one-time hints. The played
// registry (player save, `commsPlayed`) prevents replays across reloads.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from "react";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { COMMS_MESSAGES } from "@/data/commsMessages";
import { flightInputActive } from "@/input/playerInput";
import { isSimPaused } from "@/sim/simPause";
import { getActiveSave } from "@/save/activeSave";
import { settingsIsOpenAtom } from "@/store/store";
import { HINTS, type HintDef } from "@/data/guidance";
import { aiNameAtom } from "@/store/aiName";
import { cargoAtom, isCargoFullAtom } from "@/store/cargo";
import { enqueueCommsAtom, playedMessageIdsAtom, retireHintAtom, showHintAtom } from "@/store/comms";
import { toastStackFullAtom } from "@/store/toast";
import { isDeadAtom } from "@/store/death";
import { laserInterlockAtom, miningStateAtom } from "@/store/mining";
import { modulesAtom } from "@/store/modules";
import { trackedProjectAtom } from "@/store/projects";
import { lastRecoveryAtom } from "@/store/replication";
import { discoveriesMirrorAtom } from "@/store/research";
import { shipResourcesHudAtom } from "@/store/shipResources";
import { glanceAtom } from "@/store/sites";
import { shipHealthAtom } from "@/store/store";

const focusedAtom = atom((get) => get(miningStateAtom).isFocused);
const heatWarnAtom = atom((get) => get(shipResourcesHudAtom).heatWarn);
const burningWaterAtom = atom((get) => get(shipResourcesHudAtom).drive === "water");
const lowFuelAtom = atom((get) => {
  const r = get(shipResourcesHudAtom);
  return r.tankKg > 1 && r.ordinaryKg < r.tankKg * 0.15;
});
const hasHydratesAtom = atom((get) => (get(cargoAtom).items.hydrates ?? 0) > 0);
const hasDriveAtom = atom((get) => get(modulesAtom).ownedModules.includes("special_transit_drive"));
const auxTankAtom = atom((get) => get(modulesAtom).equippedModules.cargo === "module_aux_tank_mk1");
const frameAtom = atom((get) => get(glanceAtom).frameId);
const damagedAtom = atom((get) => {
  const h = get(shipHealthAtom);
  return h > 0 && h < 99.5;
});


/** Show `hint` once while `when` holds (and the ship is alive); it leaves when `when` stops holding. */
function useHint(hint: HintDef, when: boolean, dead: boolean): void {
  const show = useSetAtom(showHintAtom);
  const retire = useSetAtom(retireHintAtom);
  const busy = useAtomValue(toastStackFullAtom);
  useEffect(() => {
    if (!when) retire(hint.id);
    else if (!dead && !busy) show(hint);
  }, [hint, when, dead, busy, show, retire]);
}

/** The opening premise waits this long after the first steering/thrust input... */
const OPENING_AFTER_INPUT_S = 8;
/** ...or this long with no input at all (the pilot may still be looking for the controls). */
const OPENING_IDLE_S = 30;

export default function GameCommsTriggers() {
  const enqueue = useSetAtom(enqueueCommsAtom);
  const aiName = useAtomValue(aiNameAtom);
  const played = useAtomValue(playedMessageIdsAtom);
  const dead = useAtomValue(isDeadAtom);
  const playedSet = useMemo(() => new Set(played), [played]);

  // ── Opening premise, naming, first opportunity ──
  // Fly first (FIRST_EXPEDITION WP3): the premise waits for a beat after the pilot's first deliberate
  // input, or for an idle spell from someone still finding the controls. Paused/menu time does not count.
  const settingsOpen = useAtomValue(settingsIsOpenAtom);
  // Due per world, so a new world started in the same session waits for its own first flight.
  const worldId = getActiveSave()?.meta.id ?? "";
  const [dueWorld, setDueWorld] = useState<string | null>(null);
  const openingDue = dueWorld === worldId;
  useEffect(() => {
    if (aiName || openingDue || playedSet.has("opening_001")) return;
    let activeS = 0, flownAtS = -1, last = performance.now();
    const id = window.setInterval(() => {
      const now = performance.now();
      const dt = Math.min(0.5, (now - last) / 1000);
      last = now;
      if (isSimPaused() || settingsOpen || dead) return;
      activeS += dt;
      if (flownAtS < 0 && flightInputActive()) flownAtS = activeS;
      if ((flownAtS >= 0 && activeS - flownAtS >= OPENING_AFTER_INPUT_S) || (flownAtS < 0 && activeS >= OPENING_IDLE_S)) setDueWorld(worldId);
    }, 250);
    return () => window.clearInterval(id);
  }, [aiName, openingDue, playedSet, settingsOpen, dead, worldId]);
  useEffect(() => {
    if (!aiName && (openingDue || playedSet.has("opening_001"))) enqueue(COMMS_MESSAGES.opening_001);
  }, [aiName, openingDue, playedSet, enqueue]);
  const openedHere = playedSet.has("opening_001");
  useEffect(() => {
    if (aiName && openedHere) enqueue(COMMS_MESSAGES.opening_002);
  }, [aiName, openedHere, enqueue]);
  // Older saves (named before M3.7) get the projects hint without the opening.
  const openingDone = !!aiName && (playedSet.has("opening_002") || !openedHere);
  const untracked = useAtomValue(trackedProjectAtom) === null;
  useHint(HINTS.projects, openingDone && untracked, dead);

  // ── Contextual one-time hints ──
  useHint(HINTS.lock, !useAtomValue(focusedAtom) && openingDone, dead);
  const hasHydrates = useAtomValue(hasHydratesAtom);
  useHint(HINTS.hydrates, hasHydrates, dead);
  useHint(HINTS.heat, useAtomValue(heatWarnAtom), dead);
  useHint(HINTS.interlock, useAtomValue(laserInterlockAtom), dead);
  useHint(HINTS.thinAir, useAtomValue(burningWaterAtom), dead);
  useHint(HINTS.cargoFull, useAtomValue(isCargoFullAtom), dead);
  // Only actionable with hydrates aboard (after a respawn the hold is empty: the wreck hint applies).
  useHint(HINTS.lowFuel, useAtomValue(lowFuelAtom) && hasHydrates, dead);
  // Drive built: the AI marks the milestone (and points at the tank); the control hint follows it.
  const hasDrive = useAtomValue(hasDriveAtom);
  const frameNow = useAtomValue(frameAtom);
  const auxTank = useAtomValue(auxTankAtom);
  // hint_drive alone: a save that had the drive before these messages existed.
  const drivePlayed = playedSet.has("drive_online_001") || playedSet.has("drive_online_002") || playedSet.has("hint_drive");
  // The variant is chosen once: fitting the tank while the first is queued must not add the second.
  const driveMsg = useRef<"drive_online_001" | "drive_online_002" | null>(null);
  useEffect(() => {
    if (!hasDrive || frameNow === "luna" || dead || drivePlayed) return;
    driveMsg.current ??= auxTank ? "drive_online_002" : "drive_online_001";
    enqueue(COMMS_MESSAGES[driveMsg.current]);
  }, [hasDrive, frameNow, dead, drivePlayed, auxTank, enqueue]);
  useHint(HINTS.drive, hasDrive && (drivePlayed || frameNow === "luna"), dead);
  useHint(HINTS.recovered, useAtomValue(lastRecoveryAtom) !== null, dead);

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
