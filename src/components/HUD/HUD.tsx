import ShipDashboard from "./ShipDashboard/ShipDashboard";
import "./HUD.scss";
import SettingsMenu from "./SettingsMenu/SettingsMenu";

const HUD = () => {
  return (
    <div className="hud">
      <ShipDashboard />
      <SettingsMenu />
    </div>
  );
};

export default HUD;
