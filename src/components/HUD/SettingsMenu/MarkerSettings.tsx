"use client";

import { useAtom, useAtomValue } from "jotai";
import { MARKER_GROUPS } from "@/data/markerCategories";
import { displayKey, keybindsAtom } from "@/store/keybinds";
import { MARKER_DENSITIES, markerPrefsAtom, type MarkerDensity } from "@/store/markerPrefs";
import SettingsCheckbox from "./SettingsCheckbox/SettingsCheckbox";

const DENSITY_LABELS: Record<MarkerDensity, string> = {
  full: "All markers",
  essential: "Essential (destination, tracked, crew, pings)",
  off: "Off (destination only)",
};

/** Settings → Markers: what the HUD marks, and how big (docs/MARKER_SYSTEM_PLAN.md §2.5). */
export default function MarkerSettings() {
  const [prefs, setPrefs] = useAtom(markerPrefsAtom);
  const keys = useAtomValue(keybindsAtom);
  const k = (action: "markerDensity" | "markerReveal" | "ping") => keys[action].map(displayKey).join(" / ") || "unbound";
  return (
    <>
      <label className="dev-controls__label">
        markers ({k("markerDensity")} cycles)
        <select className="dev-controls__select" value={prefs.density}
          onChange={(e) => setPrefs({ ...prefs, density: e.target.value as MarkerDensity })}>
          {MARKER_DENSITIES.map((d) => <option key={d} value={d}>{DENSITY_LABELS[d]}</option>)}
        </select>
      </label>
      {MARKER_GROUPS.map((g) => (
        <SettingsCheckbox key={g.id} label={g.label} active={!prefs.hidden.includes(g.id)}
          onChange={() => setPrefs({ ...prefs, hidden: prefs.hidden.includes(g.id) ? prefs.hidden.filter((x) => x !== g.id) : [...prefs.hidden, g.id] })} />
      ))}
      <SettingsCheckbox label="name planets and moons without aiming" active={prefs.celestialLabels}
        onChange={() => setPrefs({ ...prefs, celestialLabels: !prefs.celestialLabels })} />
      <label className="dev-controls__label">
        marker size {Math.round(prefs.scale * 100)}%
        <input type="range" className="dev-controls__range" min={0.75} max={1.6} step={0.05} value={prefs.scale}
          onChange={(e) => setPrefs({ ...prefs, scale: Number(e.target.value) })} />
      </label>
      <p className="dev-controls__hint">
        Hold {k("markerReveal")} to show every marker with its name. Tap {k("ping")} to ping what your nose points at
        (crew see it); hold it to clear your ping.
      </p>
    </>
  );
}
