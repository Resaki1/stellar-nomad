"use client";

import { useCallback, useEffect, useState } from "react";
import ShipDashboard from "./ShipDashboard/ShipDashboard";
import Reticle from "./Reticle/Reticle";
import MiningHUD from "./MiningHUD/MiningHUD";
import CargoHUD from "./CargoHUD/CargoHUD";
import CargoDetail from "./CargoHUD/CargoDetail";
import SettingsMenu from "./SettingsMenu/SettingsMenu";

import "./HUD.scss";

export default function HUD() {
  const [cargoOpen, setCargoOpen] = useState(false);

  const toggleCargo = useCallback(() => setCargoOpen((prev) => !prev), []);
  const closeCargo = useCallback(() => setCargoOpen(false), []);

  // Tab / I hotkey to open/close cargo
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.key === "Tab" || e.key === "i" || e.key === "I") {
        e.preventDefault();
        setCargoOpen((prev) => !prev);
      }

      if (e.key === "Escape" && cargoOpen) {
        setCargoOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cargoOpen]);

  return (
    <div className="hud">
      <ShipDashboard />
      <Reticle />
      <MiningHUD />
      <CargoHUD onClick={toggleCargo} />
      <SettingsMenu />
      {cargoOpen && <CargoDetail onClose={closeCargo} />}
    </div>
  );
}
