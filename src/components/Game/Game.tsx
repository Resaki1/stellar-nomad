import Navigation from "../Navigation/Navigation";
import SettingsMenu from "../HUD/SettingsMenu/SettingsMenu";
import { memo, useEffect } from "react";
import "./Game.scss";
import Scene from "../Scene/Scene";
import HUD from "../HUD/HUD";
import DevTools from "../DevTools";
import AudioSystem from "../Audio/AudioSystem";
import GameAudioTriggers from "../Audio/GameAudioTriggers";
import AudioDevTools from "../Audio/AudioDevTools";

import { AsteroidRuntimeProvider } from "@/sim/asteroids/runtimeContext";
import { WorldOriginProvider } from "@/sim/worldOrigin";
import { armNearFieldLoadTimeout, loadNearFieldEngine } from "@/sim/physics/nearField";

// Starts with the game chunk's evaluation, in parallel with the scene's assets; the loading gate waits (bounded).
if (typeof window !== "undefined") loadNearFieldEngine();

const Game = () => {
  useEffect(() => armNearFieldLoadTimeout(), []);
  return (
    <WorldOriginProvider>
      <AsteroidRuntimeProvider>
        <div className="container">
          <Scene />
          <HUD />
          <Navigation />
          <DevTools />
          {/* Outside <Scene> deliberately: the audio engine must not be owned by
              the R3F tree. `frameloop="never"` while the settings menu is open
              would otherwise stop the audio tick dead (A1 / A5). */}
          <AudioSystem />
          <GameAudioTriggers />
          <AudioDevTools />
        </div>
      </AsteroidRuntimeProvider>
    </WorldOriginProvider>
  );
};

export default memo(Game);
