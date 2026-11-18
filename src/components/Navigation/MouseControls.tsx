import { placementModeAtom } from "@/store/replication";
import { useEffect } from "react";
import { useAtomValue, useStore } from "jotai";
import { hdrCalibrationOpenAtom, settingsIsOpenAtom } from "@/store/store";
import { isDeadAtom } from "@/store/death";
import { mouseSettingsAtom, withMouseDefaults } from "@/store/mouseSettings";
import { attachMouse, mouseConfig, resetMouseSteering } from "@/input/mouse";
import { requestGamePointerLock, setCursorNeeded, setUserUnlockHandler } from "@/input/pointerLock";
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
    // During loading the menu would be hidden behind the overlay and would stall the gate (frameloop "never").
    setUserUnlockHandler(() => {
      // Esc while placing a point cancels the placement only.
      if (store.get(placementModeAtom)) store.set(placementModeAtom, false);
      else if (getAppPhase() === "playing") store.set(settingsIsOpenAtom, true);
    });
    const onClick = (e: MouseEvent): void => {
      if (e.button === 0 && e.target instanceof HTMLCanvasElement) requestGamePointerLock();
    };
    window.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("click", onClick);
      setUserUnlockHandler(null);
      device.detach();
    };
  }, [store]);

  return null;
};

export default MouseControls;
