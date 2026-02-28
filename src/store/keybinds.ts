import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

// ── Action identifiers ──────────────────────────────────────────────
export type KeybindAction =
  | "pitchUp"
  | "pitchDown"
  | "yawLeft"
  | "yawRight"
  | "accelerate"
  | "decelerate"
  | "toggleCargo"
  | "mine"
  | "toggleSettings";

/** Maps each action → array of bound key strings (e.key.toLowerCase()). */
export type KeybindConfig = Record<KeybindAction, string[]>;

// ── Action metadata for the settings UI ─────────────────────────────
export type KeybindCategory = "flight" | "actions" | "menu";

export interface KeybindActionMeta {
  id: KeybindAction;
  label: string;
  category: KeybindCategory;
}

export const KEYBIND_ACTIONS: KeybindActionMeta[] = [
  { id: "pitchUp", label: "Pitch Up", category: "flight" },
  { id: "pitchDown", label: "Pitch Down", category: "flight" },
  { id: "yawLeft", label: "Yaw Left", category: "flight" },
  { id: "yawRight", label: "Yaw Right", category: "flight" },
  { id: "accelerate", label: "Throttle Up", category: "flight" },
  { id: "decelerate", label: "Throttle Down", category: "flight" },
  { id: "toggleCargo", label: "Inventory", category: "actions" },
  { id: "mine", label: "Mine / Cancel", category: "actions" },
  { id: "toggleSettings", label: "Settings", category: "menu" },
];

export const CATEGORY_LABELS: Record<KeybindCategory, string> = {
  flight: "Flight",
  actions: "Actions",
  menu: "Menu",
};

// ── Defaults ────────────────────────────────────────────────────────
export const DEFAULT_KEYBINDS: KeybindConfig = {
  pitchUp: ["w"],
  pitchDown: ["s"],
  yawLeft: ["a"],
  yawRight: ["d"],
  accelerate: ["shift", "e"],
  decelerate: ["control", "c"],
  toggleCargo: ["tab", "i"],
  mine: ["m"],
  toggleSettings: ["escape"],
};

// Max number of keys per action shown in the UI
export const MAX_KEYS_PER_ACTION = 2;

// ── Atom (persisted) ────────────────────────────────────────────────
export const keybindsAtom = atomWithStorage<KeybindConfig>(
  "keybinds-v1",
  DEFAULT_KEYBINDS
);

// ── Write atom: bind a key to an action (removes conflicts) ────────
export const bindKeyAtom = atom(
  null,
  (
    get,
    set,
    update: { action: KeybindAction; slotIndex: number; key: string }
  ) => {
    const prev = { ...get(keybindsAtom) };

    // Remove the key from any action it's currently bound to
    for (const a of Object.keys(prev) as KeybindAction[]) {
      prev[a] = prev[a].filter((k) => k !== update.key);
    }

    // Place the key in the target slot
    const keys = [...prev[update.action]];
    keys[update.slotIndex] = update.key;
    prev[update.action] = keys.slice(0, MAX_KEYS_PER_ACTION);

    set(keybindsAtom, prev);
  }
);

// ── Write atom: clear a specific key slot ───────────────────────────
export const clearKeySlotAtom = atom(
  null,
  (get, set, update: { action: KeybindAction; slotIndex: number }) => {
    const prev = { ...get(keybindsAtom) };
    const keys = [...prev[update.action]];
    keys.splice(update.slotIndex, 1);
    prev[update.action] = keys;
    set(keybindsAtom, prev);
  }
);

// ── Write atom: reset all keybinds to defaults ──────────────────────
export const resetKeybindsAtom = atom(null, (_get, set) => {
  set(keybindsAtom, { ...DEFAULT_KEYBINDS });
});

// ── Display helpers ─────────────────────────────────────────────────
const KEY_DISPLAY: Record<string, string> = {
  " ": "Space",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  control: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  meta: "Cmd",
  escape: "Esc",
  tab: "Tab",
  enter: "Enter",
  backspace: "⌫",
  delete: "Del",
  capslock: "Caps",
};

/** Pretty display name for a key value. */
export function displayKey(key: string): string {
  return KEY_DISPLAY[key] ?? key.toUpperCase();
}
