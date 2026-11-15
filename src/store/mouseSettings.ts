import { atomWithStorage } from "jotai/utils";

export type MouseMode = "stick" | "aim";

/** Mouse steering preferences (Settings → Controls). Per device, so localStorage rather than the save. */
export interface MouseSettings {
  mode: MouseMode;
  /** Multiplier on stick travel, aim and free-look turn per pixel. */
  sensitivity: number;
  /** Stick drifts back to centre when the mouse is still (mode A). */
  autoCentre: boolean;
  /** Radial deadzone, fraction of the stick radius (mode A). */
  deadzone: number;
}

export const DEFAULT_MOUSE_SETTINGS: Readonly<MouseSettings> = Object.freeze({
  mode: "stick",
  sensitivity: 1,
  autoCentre: false,
  deadzone: 0.04,
});

/** ⚠ atomWithStorage REPLACES defaults with the stored blob: read fields through `withMouseDefaults`. */
export const mouseSettingsAtom = atomWithStorage<MouseSettings>("mouse-settings-v1", { ...DEFAULT_MOUSE_SETTINGS });

export function withMouseDefaults(s: Partial<MouseSettings> | null | undefined): MouseSettings {
  const d = DEFAULT_MOUSE_SETTINGS;
  const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  return {
    mode: s?.mode === "aim" ? "aim" : s?.mode === "stick" ? "stick" : d.mode,
    sensitivity: Math.min(5, Math.max(0.1, num(s?.sensitivity, d.sensitivity))),
    autoCentre: typeof s?.autoCentre === "boolean" ? s.autoCentre : d.autoCentre,
    deadzone: Math.min(0.5, Math.max(0, num(s?.deadzone, d.deadzone))),
  };
}
