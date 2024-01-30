import Navigation from "../Navigation/Navigation";
import SettingsMenu from "../SettingsMenu/SettingsMenu";
import { memo } from "react";
import "./Game.scss";
import Scene from "../Scene/Scene";
import HUD from "../HUD/HUD";

const Game = () => {
  return (
    <div className="container">
      <Scene />
      <HUD />
      <Navigation />
      <SettingsMenu />
    </div>
  );
};

export default memo(Game);
