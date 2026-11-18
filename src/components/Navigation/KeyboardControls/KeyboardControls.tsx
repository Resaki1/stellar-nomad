import { settingsAtom, settingsIsOpenAtom } from "@/store/store";
import { keybindsAtom } from "@/store/keybinds";
import { transitDriveBuffer, transitDriveOwnedAtom } from "@/store/transit";
import { miningStateAtom } from "@/store/mining";
import { playAudio } from "@/audio";
import { attachKeyboard, type KeyboardDevice } from "@/input/keyboard";
import { playerInput } from "@/input/playerInput";
import { useAtomValue, useStore } from "jotai";
import { useEffect, useRef } from "react";

/** Mounts the keyboard device (src/input/keyboard.ts) and handles the transit-drive key. */
const KeyboardControls = () => {
  const store = useStore();
  const keybinds = useAtomValue(keybindsAtom);
  const settings = useAtomValue(settingsAtom);
  const settingsOpen = useAtomValue(settingsIsOpenAtom);
  const keybindsRef = useRef(keybinds);
  keybindsRef.current = keybinds;
  const deviceRef = useRef<KeyboardDevice | null>(null);

  useEffect(() => {
    playerInput.invertPitch = settings.invertPitch;
  }, [settings.invertPitch]);

  useEffect(() => {
    const device = attachKeyboard({
      bindings: () => keybindsRef.current,
      blocked: () => store.get(settingsIsOpenAtom),
      onPress(action) {
        if (action !== "transitDrive") return;
        const phase = transitDriveBuffer.phase;
        // The drive ignores the key without a module or while mining; reject audibly.
        if (phase === "idle" && (!store.get(transitDriveOwnedAtom) || store.get(miningStateAtom).isMining)) {
          playAudio("ui.reject");
        } else if (phase === "spooling" && transitDriveBuffer.autoSpool) {
          transitDriveBuffer.keyTapped = true; // abort the route between legs
        } else if (phase === "idle" || phase === "spooling") {
          transitDriveBuffer.keyHeld = true;
        } else {
          transitDriveBuffer.keyTapped = true;
        }
      },
      onRelease(action) {
        if (action === "transitDrive") transitDriveBuffer.keyHeld = false;
      },
    });
    deviceRef.current = device;
    return () => {
      device.detach();
      deviceRef.current = null;
    };
  }, [store]);

  useEffect(() => {
    if (settingsOpen) deviceRef.current?.releaseAll();
  }, [settingsOpen]);

  return null;
};

export default KeyboardControls;
