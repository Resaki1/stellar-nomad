import Navigation from "../Navigation/Navigation";
import SettingsMenu from "../HUD/SettingsMenu/SettingsMenu";
import { memo } from "react";
import "./Game.scss";
import Scene from "../Scene/Scene";
import HUD from "../HUD/HUD";

import { AsteroidRuntimeProvider } from "@/sim/asteroids/runtimeContext";
import { WorldOriginProvider } from "@/sim/worldOrigin";

const Game = () => {
  return (
    <WorldOriginProvider>
      <AsteroidRuntimeProvider>
        <div className="container">
          <Scene />
          <HUD />
          <Navigation />
        </div>
      </AsteroidRuntimeProvider>
    </WorldOriginProvider>
  );
};

export default memo(Game);
