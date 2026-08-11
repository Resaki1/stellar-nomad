"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomValue, useStore } from "jotai";
import { Microscope, Shield, Wrench } from "lucide-react";
import { keybindsAtom } from "@/store/keybinds";
import { settingsAtom, settingsIsOpenAtom } from "@/store/store";
import ShipDashboard from "./ShipDashboard/ShipDashboard";
import Reticle from "./Reticle/Reticle";
import MiningHUD from "./MiningHUD/MiningHUD";
import CargoHUD from "./CargoHUD/CargoHUD";
import CargoDetail from "./CargoHUD/CargoDetail";
import SettingsMenu from "./SettingsMenu/SettingsMenu";
import DamageVignette from "./DamageVignette/DamageVignette";
import ResearchPanel from "./ResearchPanel/ResearchPanel";
import CraftingPanel from "./CraftingPanel/CraftingPanel";
import LoadoutPanel from "./LoadoutPanel/LoadoutPanel";
import ToastDisplay from "./ToastDisplay/ToastDisplay";
import Hotbar from "./Hotbar/Hotbar";
import ObjectiveTracker from "./ObjectiveTracker/ObjectiveTracker";
import POIMarkers from "./POIMarkers/POIMarkers";
import DeathScreen from "./DeathScreen/DeathScreen";
import CommsOverlay from "./CommsOverlay/CommsOverlay";
import AINameOverlay from "./AINameOverlay/AINameOverlay";
import TransitHUD from "./TransitHUD/TransitHUD";
import GameCommsTriggers from "../Comms/GameCommsTriggers";
import PerfHUD from "./PerfHUD/PerfHUD";
import { isPerfEnabled } from "@/components/space/perf/perfProfiler";

import "./HUD.scss";

type OverlayPanel = "cargo" | "research" | "crafting" | "loadout" | null;

export default function HUD() {
  const [activePanel, setActivePanel] = useState<OverlayPanel>(null);
  const keybinds = useAtomValue(keybindsAtom);
  const settingsIsOpen = useAtomValue(settingsIsOpenAtom);
  // Either the persisted setting (which shows a "needs reload" hint when the
  // renderer was built without timestamp queries) or `?perf=1`, which turns
  // profiling on from a cold load and should show the readout too.
  //
  // The `?perf=1` read must happen AFTER mount: it depends on `window`, so
  // evaluating it during the first render disagrees with the server render and
  // fails hydration. (`settingsAtom` is safe — atomWithStorage yields its default
  // on both sides and hydrates in an effect.)
  const [perfForced, setPerfForced] = useState(false);
  useEffect(() => {
    if (isPerfEnabled()) setPerfForced(true);
  }, []);
  const perfHudOn = useAtomValue(settingsAtom).perf || perfForced;
  const store = useStore();
  const keybindsRef = useRef(keybinds);
  keybindsRef.current = keybinds;
  const activePanelRef = useRef(activePanel);
  activePanelRef.current = activePanel;

  // Close any open gameplay panel when the settings menu opens — settings is
  // modal and must own input focus exclusively.
  useEffect(() => {
    if (settingsIsOpen && activePanelRef.current !== null) {
      setActivePanel(null);
    }
  }, [settingsIsOpen]);

  const openPanel = useCallback((panel: OverlayPanel) => {
    if (store.get(settingsIsOpenAtom)) return;
    setActivePanel((prev) => (prev === panel ? null : panel));
  }, [store]);

  const closePanel = useCallback(() => setActivePanel(null), []);

  // Hotkeys for panels
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const key = e.key.toLowerCase();

      // Settings menu is modal — it swallows all non-settings hotkeys so the
      // player can't toggle gameplay panels while paused.
      if (store.get(settingsIsOpenAtom)) return;

      if (keybindsRef.current.toggleCargo.includes(key)) {
        e.preventDefault();
        setActivePanel((prev) => (prev === "cargo" ? null : "cargo"));
        return;
      }

      if (keybindsRef.current.toggleResearch.includes(key)) {
        e.preventDefault();
        setActivePanel((prev) => (prev === "research" ? null : "research"));
        return;
      }

      if (keybindsRef.current.toggleCrafting.includes(key)) {
        e.preventDefault();
        setActivePanel((prev) => (prev === "crafting" ? null : "crafting"));
        return;
      }

      if (keybindsRef.current.toggleLoadout.includes(key)) {
        e.preventDefault();
        setActivePanel((prev) => (prev === "loadout" ? null : "loadout"));
        return;
      }

      // Escape / settings key closes any open panel
      if (keybindsRef.current.toggleSettings.includes(key) && activePanelRef.current) {
        setActivePanel(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store]);

  return (
    <div className="hud">
      <DamageVignette />
      <POIMarkers />
      <ShipDashboard />
      <Reticle />
      <MiningHUD />
      <CargoHUD onClick={() => openPanel("cargo")} />
      <ObjectiveTracker />
      <SettingsMenu />
      <ToastDisplay />
      <AINameOverlay />
      <CommsOverlay />
      <GameCommsTriggers />
      <DeathScreen />
      <Hotbar />
      <TransitHUD />
      {perfHudOn && <PerfHUD />}

      {/* Quick-access buttons */}
      <div className="hud__panel-buttons">
        <button
          className={`hud__panel-btn ${activePanel === "research" ? "hud__panel-btn--active" : ""}`}
          onClick={() => openPanel("research")}
          title="Research (R)"
        >
          <Microscope size={14} strokeWidth={1.75} aria-hidden />
          <span>Research</span>
        </button>
        <button
          className={`hud__panel-btn ${activePanel === "crafting" ? "hud__panel-btn--active" : ""}`}
          onClick={() => openPanel("crafting")}
          title="Crafting (F)"
        >
          <Wrench size={14} strokeWidth={1.75} aria-hidden />
          <span>Craft</span>
        </button>
        <button
          className={`hud__panel-btn ${activePanel === "loadout" ? "hud__panel-btn--active" : ""}`}
          onClick={() => openPanel("loadout")}
          title="Loadout (L)"
        >
          <Shield size={14} strokeWidth={1.75} aria-hidden />
          <span>Loadout</span>
        </button>
      </div>

      {/* Overlay panels */}
      {activePanel === "cargo" && <CargoDetail onClose={closePanel} />}
      {activePanel === "research" && <ResearchPanel onClose={closePanel} />}
      {activePanel === "crafting" && <CraftingPanel onClose={closePanel} />}
      {activePanel === "loadout" && <LoadoutPanel onClose={closePanel} />}
    </div>
  );
}
