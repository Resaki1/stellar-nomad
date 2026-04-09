"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { keybindsAtom } from "@/store/keybinds";
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
import AssaySamplesHUD from "./AssaySamplesHUD/AssaySamplesHUD";
import POIMarkers from "./POIMarkers/POIMarkers";
import SpawnFixDialog from "./SpawnFixDialog/SpawnFixDialog";
import DeathScreen from "./DeathScreen/DeathScreen";

import "./HUD.scss";

type OverlayPanel = "cargo" | "research" | "crafting" | "loadout" | null;

export default function HUD() {
  const [activePanel, setActivePanel] = useState<OverlayPanel>(null);
  const keybinds = useAtomValue(keybindsAtom);
  const keybindsRef = useRef(keybinds);
  keybindsRef.current = keybinds;
  const activePanelRef = useRef(activePanel);
  activePanelRef.current = activePanel;

  const openPanel = useCallback((panel: OverlayPanel) => {
    setActivePanel((prev) => (prev === panel ? null : panel));
  }, []);

  const closePanel = useCallback(() => setActivePanel(null), []);

  // Hotkeys for panels
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const key = e.key.toLowerCase();

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
  }, []);

  return (
    <div className="hud">
      <DamageVignette />
      <POIMarkers />
      <ShipDashboard />
      <Reticle />
      <MiningHUD />
      <CargoHUD onClick={() => openPanel("cargo")} />
      <AssaySamplesHUD />
      <SettingsMenu />
      <ToastDisplay />
      <SpawnFixDialog />
      <DeathScreen />
      <Hotbar />

      {/* Quick-access buttons */}
      <div className="hud__panel-buttons">
        <button
          className={`hud__panel-btn ${activePanel === "research" ? "hud__panel-btn--active" : ""}`}
          onClick={() => openPanel("research")}
          title="Research (R)"
        >
          🔬 Research
        </button>
        <button
          className={`hud__panel-btn ${activePanel === "crafting" ? "hud__panel-btn--active" : ""}`}
          onClick={() => openPanel("crafting")}
          title="Crafting (F)"
        >
          ⚙️ Craft
        </button>
        <button
          className={`hud__panel-btn ${activePanel === "loadout" ? "hud__panel-btn--active" : ""}`}
          onClick={() => openPanel("loadout")}
          title="Loadout (L)"
        >
          🛡️ Loadout
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
