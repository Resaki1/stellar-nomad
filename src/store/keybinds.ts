import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { FlightAction } from "@/input/playerInput";

// ── Action identifiers ──────────────────────────────────────────────
export type KeybindAction =
  | FlightAction
  | "toggleCargo"
  | "toggleResearch"
  | "toggleCrafting"
  | "toggleLoadout"
  | "mine"
  | "inspect"
  | "togglePulseMining"
  | "transitDrive"
  | "placePoint"
  | "activatePoint"
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
  { id: "accelerate", label: "Throttle Up", category: "flight" },
  { id: "decelerate", label: "Throttle Down", category: "flight" },
  { id: "strafeLeft", label: "Strafe Left", category: "flight" },
  { id: "strafeRight", label: "Strafe Right", category: "flight" },
  { id: "strafeUp", label: "Strafe Up", category: "flight" },
  { id: "strafeDown", label: "Strafe Down", category: "flight" },
  { id: "rollLeft", label: "Roll Left", category: "flight" },
  { id: "rollRight", label: "Roll Right", category: "flight" },
  { id: "boost", label: "Boost (Hold)", category: "flight" },
  { id: "brake", label: "Brake", category: "flight" },
  { id: "toggleFlightAssist", label: "Flight Assist On/Off", category: "flight" },
  { id: "freeLook", label: "Free Look (Hold)", category: "flight" },
  { id: "pitchUp", label: "Pitch Up", category: "flight" },
  { id: "pitchDown", label: "Pitch Down", category: "flight" },
  { id: "yawLeft", label: "Yaw Left", category: "flight" },
  { id: "yawRight", label: "Yaw Right", category: "flight" },
  { id: "toggleCargo", label: "Inventory", category: "actions" },
  { id: "toggleResearch", label: "Research", category: "actions" },
  { id: "toggleCrafting", label: "Crafting", category: "actions" },
  { id: "toggleLoadout", label: "Loadout", category: "actions" },
  { id: "mine", label: "Mine / Cancel", category: "actions" },
  { id: "inspect", label: "Inspect Target", category: "actions" },
  { id: "togglePulseMining", label: "Toggle Pulse Mining", category: "actions" },
  { id: "transitDrive", label: "Transit Drive (Hold)", category: "actions" },
  { id: "placePoint", label: "Replication Point: Place", category: "actions" },
  { id: "activatePoint", label: "Replication Point: Make Active", category: "actions" },
  { id: "toggleSettings", label: "Settings", category: "menu" },
];

export const CATEGORY_LABELS: Record<KeybindCategory, string> = {
  flight: "Flight",
  actions: "Actions",
  menu: "Menu",
};

// ── Defaults ────────────────────────────────────────────────────────
export const DEFAULT_KEYBINDS: KeybindConfig = {
  pitchUp: ["arrowup"],
  pitchDown: ["arrowdown"],
  yawLeft: ["arrowleft"],
  yawRight: ["arrowright"],
  rollLeft: ["q"],
  rollRight: ["e"],
  strafeLeft: ["a"],
  strafeRight: ["d"],
  strafeUp: [" "],
  strafeDown: ["control"],
  accelerate: ["w"],
  decelerate: ["s"],
  boost: ["shift"],
  brake: ["x"],
  toggleFlightAssist: ["v"],
  freeLook: ["alt"],
  toggleCargo: ["tab", "i"],
  toggleResearch: ["r"],
  toggleCrafting: ["f"],
  toggleLoadout: ["l"],
  mine: ["m"],
  inspect: ["g"],
  togglePulseMining: ["p"],
  transitDrive: ["t"],
  placePoint: ["b"],
  activatePoint: ["h"],
  toggleSettings: ["escape"],
};

// Max number of keys per action shown in the UI
export const MAX_KEYS_PER_ACTION = 2;

// ── Atom (persisted) ────────────────────────────────────────────────
const KEYBINDS_KEY = "keybinds-v2";
const KEYBINDS_V1_KEY = "keybinds-v1";

/**
 * M1 control scheme: a saved v1 action whose key collides with a NEW default of another
 * action is reset to its own default (only that action). Runs once, v1 → v2.
 */
export function migrateKeybindsV1(saved: Partial<Record<string, string[]>>): KeybindConfig {
  const result = { ...DEFAULT_KEYBINDS };
  for (const action of Object.keys(DEFAULT_KEYBINDS) as KeybindAction[]) {
    const keys = saved[action];
    if (!Array.isArray(keys)) continue;
    const collides = keys.some((k) =>
      (Object.keys(DEFAULT_KEYBINDS) as KeybindAction[]).some((o) => o !== action && DEFAULT_KEYBINDS[o].includes(k)),
    );
    if (!collides) result[action] = keys;
  }
  return result;
}

if (typeof window !== "undefined") {
  try {
    const v1 = window.localStorage.getItem(KEYBINDS_V1_KEY);
    if (v1 && window.localStorage.getItem(KEYBINDS_KEY) === null) {
      window.localStorage.setItem(KEYBINDS_KEY, JSON.stringify(migrateKeybindsV1(JSON.parse(v1))));
    }
  } catch {
    // Unreadable v1 blob or blocked storage: defaults apply.
  }
}

const _rawKeybindsAtom = atomWithStorage<KeybindConfig>(KEYBINDS_KEY, DEFAULT_KEYBINDS);

/**
 * Migration-safe keybinds atom: ensures any newly-added actions get their
 * default bindings even when loading an older saved config from localStorage.
 */
export const keybindsAtom = atom(
  (get): KeybindConfig => {
    const raw = get(_rawKeybindsAtom);
    // Fill in defaults for any missing actions
    let patched = false;
    const result = { ...raw };
    for (const key of Object.keys(DEFAULT_KEYBINDS) as KeybindAction[]) {
      if (!(key in result)) {
        result[key] = DEFAULT_KEYBINDS[key];
        patched = true;
      }
    }
    return result;
  },
  (_get, set, value: KeybindConfig) => {
    set(_rawKeybindsAtom, value);
  },
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
