import ShipDashboard from "./ShipDashboard/ShipDashboard";
import SettingsMenu from "./SettingsMenu/SettingsMenu";
import Reticle from "./Reticle/Reticle";
import MiningHUD from "./MiningHUD/MiningHUD";
import "./HUD.scss";

const HUD = () => {
  return (
    <div className="hud">
      <ShipDashboard />
      <SettingsMenu />
      <Reticle />
      <MiningHUD />
    </div>
  );
};

export default HUD;
