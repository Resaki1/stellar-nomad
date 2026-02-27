import ShipDashboard from "./ShipDashboard/ShipDashboard";
import Reticle from "./Reticle/Reticle";
import MiningHUD from "./MiningHUD/MiningHUD";
import CargoHUD from "./CargoHUD/CargoHUD";
import SettingsMenu from "./SettingsMenu/SettingsMenu";

import "./HUD.scss";

export default function HUD() {
  return (
    <div className="hud">
      <ShipDashboard />
      <Reticle />
      <MiningHUD />
      <CargoHUD />
      <SettingsMenu />
    </div>
  );
}
