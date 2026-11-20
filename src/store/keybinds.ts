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
  | "toggleHud"
  | "toggleCrew"
  | "toggleProjects"
  | "toggleIndustry"
  | "mine"
  | "inspect"
  | "togglePulseMining"
  | "transitDrive"
  | "placePoint"
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
  { id: "toggleCrew", label: "Crew", category: "actions" },
  { id: "toggleProjects", label: "Projects and records", category: "actions" },
  { id: "toggleIndustry", label: "Industry", category: "actions" },
  { id: "mine", label: "Mine / Cancel", category: "actions" },
  { id: "inspect", label: "Interact", category: "actions" },
  { id: "togglePulseMining", label: "Toggle Pulse Mining", category: "actions" },
  { id: "transitDrive", label: "Transit Drive (Hold)", category: "actions" },
  { id: "placePoint", label: "Replication Point: Place", category: "actions" },
  { id: "toggleHud", label: "Show / hide HUD", category: "menu" },
  { id: "toggleSettings", label: "Ship menu", category: "menu" },
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
  toggleCrafting: ["c"],
  toggleLoadout: ["l"],
  toggleProjects: ["p"],
  toggleIndustry: ["b"],
  toggleCrew: ["u"],
  mine: ["m"],
  inspect: ["g"],
  // Dormant (no item grants pulse mining yet): unbound so P can open Projects (D5).
  togglePulseMining: [],
  transitDrive: ["t"],
  // The kit is used from the hotbar (D16); kept for rebinding.
  placePoint: [],
  toggleHud: ["h"],
  toggleSettings: ["o", "escape"],
};

// Max number of keys per action shown in the UI
export const MAX_KEYS_PER_ACTION = 2;

// ── Atom (persisted) ────────────────────────────────────────────────
const KEYBINDS_KEY = "keybinds-v3";
const KEYBINDS_V2_KEY = "keybinds-v2";
const KEYBINDS_V1_KEY = "keybinds-v1";

/**
 * M1 control scheme: a saved v1 action whose key collides with a NEW default of another
 * action is reset to its own default (only that action). Runs once, v1 → v2.
 */
export function migrateKeybindsV1(saved: Partial<Record<string, string[]>>): Record<string, string[]> {
  const result: Record<string, string[]> = { ...V2_DEFAULTS };
  for (const action of Object.keys(V2_DEFAULTS)) {
    const keys = saved[action];
    if (!Array.isArray(keys)) continue;
    const collides = keys.some((k) => Object.keys(V2_DEFAULTS).some((o) => o !== action && V2_DEFAULTS[o].includes(k)));
    if (!collides) result[action] = keys;
  }
  return result;
}

/** The v2 defaults of the actions playtest 1 moved (D5, D16); everything else kept its default. */
const V2_MOVED: Record<string, string[]> = { toggleCrafting: ["f"], toggleProjects: ["o"], togglePulseMining: ["p"], placePoint: ["b"], activatePoint: ["h"] };
const V2_DEFAULTS: Record<string, string[]> = { ...DEFAULT_KEYBINDS, ...V2_MOVED };
// Crew did not exist in v2. A legacy custom U binding belongs to its original action.
delete V2_DEFAULTS.toggleCrew;
delete V2_DEFAULTS.toggleIndustry;
delete V2_DEFAULTS.toggleHud;
V2_DEFAULTS.toggleSettings = ["escape"];

const sameKeys = (a: readonly string[] | undefined, b: readonly string[]): boolean => !!a && a.length === b.length && a.every((k, i) => k === b[i]);

/** Add bindings introduced after this save, preserving keys the player already assigned. */
function withMissingBindings(saved: Partial<KeybindConfig>): KeybindConfig {
  const result = { ...saved };
  if (!saved.toggleHud && sameKeys(saved.toggleSettings, ["escape"]) &&
      !Object.values(saved).some(keys => keys?.includes("o"))) {
    result.toggleSettings = DEFAULT_KEYBINDS.toggleSettings;
  }
  for (const action of Object.keys(DEFAULT_KEYBINDS) as KeybindAction[]) {
    if (!Array.isArray(result[action])) {
      result[action] = DEFAULT_KEYBINDS[action].filter(key =>
        !Object.values(result).some(keys => keys?.includes(key))
      );
    }
  }
  return result as KeybindConfig;
}

/**
 * v2 → v3 (playtest 1): an action still on its OLD default moves to the new one, unless that key is
 * already bound to another action in the saved config (then it is left unbound). Custom bindings are
 * never touched. `activatePoint` is dropped (merged into Interact).
 */
export function migrateKeybindsV2(saved: Partial<Record<string, string[]>>): KeybindConfig {
  const known: Partial<KeybindConfig> = {};
  for (const action of Object.keys(DEFAULT_KEYBINDS) as KeybindAction[]) {
    const keys = saved[action];
    if (Array.isArray(keys)) known[action] = keys;
  }
  const result = withMissingBindings(known);
  // Free every untouched old default first: Projects' new P is Pulse Mining's old P.
  const moving = (Object.keys(V2_MOVED).filter((a) => a in DEFAULT_KEYBINDS) as KeybindAction[]).filter(
    (a) => saved[a] === undefined || sameKeys(saved[a], V2_MOVED[a]),
  );
  for (const a of moving) result[a] = [];
  for (const a of moving) {
    result[a] = DEFAULT_KEYBINDS[a].filter((k) => !(Object.keys(result) as KeybindAction[]).some((o) => o !== a && result[o].includes(k)));
  }
  if (saved.toggleIndustry === undefined) {
    result.toggleIndustry = DEFAULT_KEYBINDS.toggleIndustry.filter(key =>
      !Object.keys(result).some(action => action !== "toggleIndustry" && result[action as KeybindAction].includes(key)),
    );
  }
  return result;
}

if (typeof window !== "undefined") {
  try {
    if (window.localStorage.getItem(KEYBINDS_KEY) === null) {
      const v2 = window.localStorage.getItem(KEYBINDS_V2_KEY);
      const v1 = v2 === null ? window.localStorage.getItem(KEYBINDS_V1_KEY) : null;
      const saved = v2 !== null ? JSON.parse(v2) : v1 !== null ? migrateKeybindsV1(JSON.parse(v1)) : null;
      if (saved) window.localStorage.setItem(KEYBINDS_KEY, JSON.stringify(migrateKeybindsV2(saved)));
    }
  } catch {
    // Unreadable blob or blocked storage: defaults apply.
  }
}

const _rawKeybindsAtom = atomWithStorage<KeybindConfig>(KEYBINDS_KEY, DEFAULT_KEYBINDS);

/**
 * Migration-safe keybinds atom: ensures any newly-added actions get their
 * default bindings even when loading an older saved config from localStorage.
 */
export const keybindsAtom = atom(
  (get): KeybindConfig => withMissingBindings(get(_rawKeybindsAtom)),
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
