import { cancelDepotPlacementAtom, depotPlacementAtom } from "@/store/industryHud";
import { placementModeAtom } from "@/store/replication";
import { useEffect } from "react";
import { useAtomValue, useStore } from "jotai";
import { hdrCalibrationOpenAtom, settingsIsOpenAtom } from "@/store/store";
import { isDeadAtom } from "@/store/death";
import { mouseSettingsAtom, usedCursorReleaseAtom, withMouseDefaults } from "@/store/mouseSettings";
import { attachMouse, mouseConfig, resetMouseSteering } from "@/input/mouse";
import { isCursorNeeded, isPointerLocked, releaseGamePointerLock, requestGamePointerLock, setCursorNeeded, setUserUnlockHandler } from "@/input/pointerLock";
import { getAppPhase } from "@/components/AppShell/appState";

/** Desktop mouse device: pointer lock, steering preferences, and the UIs that need the cursor back. */
const MouseControls = () => {
  const store = useStore();
  const prefs = useAtomValue(mouseSettingsAtom);
  const settingsOpen = useAtomValue(settingsIsOpenAtom);
  const dead = useAtomValue(isDeadAtom);
  const hdrOpen = useAtomValue(hdrCalibrationOpenAtom);

  useEffect(() => {
    const next = withMouseDefaults(prefs);
    if (next.mode !== mouseConfig.mode) resetMouseSteering();
    Object.assign(mouseConfig, next);
  }, [prefs]);

  useEffect(() => setCursorNeeded("settings", settingsOpen), [settingsOpen]);
  useEffect(() => setCursorNeeded("death", dead), [dead]);
  useEffect(() => setCursorNeeded("hdr-calibration", hdrOpen), [hdrOpen]);

  useEffect(() => {
    const device = attachMouse();
    const cancelPlacement = (): boolean => {
      if (store.get(depotPlacementAtom)) store.set(cancelDepotPlacementAtom);
      else if (store.get(placementModeAtom)) store.set(placementModeAtom, false);
      else return false;
      return true;
    };
    // During loading the menu would be hidden behind the overlay and would stall the gate (frameloop "never").
    setUserUnlockHandler(() => {
      // Escape can be consumed by the browser before the placement prompt sees a key event.
      if (!cancelPlacement() && getAppPhase() === "playing") store.set(settingsIsOpenAtom, true);
    });
    // Some browsers open their context menu on press, others on release.
    // Consume the secondary click if it released steering or cancelled placement.
    let releasingWithMouse = false;
    const onPointerDown = (e: PointerEvent): void => {
      releasingWithMouse = false;
      if (e.button !== 2 || isCursorNeeded() || getAppPhase() !== "playing") return;
      const locked = isPointerLocked();
      if (!locked && !(e.target instanceof HTMLCanvasElement)) return;
      if (locked) releaseGamePointerLock();
      const cancelledPlacement = cancelPlacement();
      if (!locked && !cancelledPlacement) return;
      releasingWithMouse = true;
      e.preventDefault();
      if (locked && !store.get(usedCursorReleaseAtom)) store.set(usedCursorReleaseAtom, true);
    };
    const onContextMenu = (e: MouseEvent): void => {
      if (!releasingWithMouse || e.button !== 2) return;
      releasingWithMouse = false;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("contextmenu", onContextMenu, true);
    const onClick = (e: MouseEvent): void => {
      if (e.button === 0 && e.target instanceof HTMLCanvasElement) requestGamePointerLock();
    };
    window.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("contextmenu", onContextMenu, true);
      setUserUnlockHandler(null);
      device.detach();
    };
  }, [store]);

  return null;
};

export default MouseControls;
