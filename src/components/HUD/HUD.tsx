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

import "./HUD.scss";

export default function HUD() {
  const [cargoOpen, setCargoOpen] = useState(false);
  const keybinds = useAtomValue(keybindsAtom);
  const keybindsRef = useRef(keybinds);
  keybindsRef.current = keybinds;
  const cargoOpenRef = useRef(cargoOpen);
  cargoOpenRef.current = cargoOpen;

  const toggleCargo = useCallback(() => setCargoOpen((prev) => !prev), []);
  const closeCargo = useCallback(() => setCargoOpen(false), []);

  // Cargo hotkey + Escape to close
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const key = e.key.toLowerCase();

      if (keybindsRef.current.toggleCargo.includes(key)) {
        e.preventDefault();
        setCargoOpen((prev) => !prev);
      }

      // Also allow the settings key to close cargo
      if (
        keybindsRef.current.toggleSettings.includes(key) &&
        cargoOpenRef.current
      ) {
        setCargoOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="hud">
      <DamageVignette />
      <ShipDashboard />
      <Reticle />
      <MiningHUD />
      <CargoHUD onClick={toggleCargo} />
      <SettingsMenu />
      {cargoOpen && <CargoDetail onClose={closeCargo} />}
    </div>
  );
}
