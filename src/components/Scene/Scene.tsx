"use client";

import { useState } from "react";
import { Canvas } from "@react-three/fiber";
import {
  AdaptiveDpr,
  AdaptiveEvents,
  Stats,
  StatsGl,
  useDetectGPU,
} from "@react-three/drei";
import {
  EffectComposer,
  Bloom,
  ToneMapping,
} from "@react-three/postprocessing";
import { KernelSize, ToneMappingMode } from "postprocessing";
import SpaceShip from "@/components/Spaceship";
import StarsComponent from "../Stars/StarsComponent";
import Star from "../Star/Star";
import "./Scene.scss";
import Planet from "../Planet/Planet";
import AsteroidField from "../Asteroids/AsteroidField";
import Navigation, { Movement } from "../Navigation/Navigation";
import SettingsMenu from "../SettingsMenu/SettingsMenu";
import { useAtom } from "jotai";
import { bloomAtom, settingsAtom, toneMappingAtom } from "@/store/store";

const Scene = () => {
  const [bloomEnabled] = useAtom(bloomAtom);
  const [toneMappingEnabled] = useAtom(toneMappingAtom);
  const [movement, setMovement] = useState<Movement>({
    yaw: 0,
    pitch: 0,
    speed: 1,
  });

  const gpu = useDetectGPU();

  const isSafari =
    typeof window !== "undefined" && navigator
      ? /^((?!chrome|android).)*safari/i.test(navigator.userAgent)
      : false;

  return (
    <div className="container">
      <Canvas
        style={{ background: "black" }}
        camera={{ far: 200000 }}
        frameloop="always"
        dpr={[0.5, 2]}
      >
        {isSafari ? <Stats /> : <StatsGl />}
        <EffectComposer disableNormalPass>
          {bloomEnabled ? (
            <Bloom
              mipmapBlur
              intensity={0.02}
              luminanceThreshold={0}
              kernelSize={KernelSize.VERY_SMALL}
            />
          ) : (
            <></>
          )}
          {toneMappingEnabled ? (
            <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
          ) : (
            <></>
          )}
        </EffectComposer>
        <ambientLight intensity={0.5} />
        <SpaceShip movement={movement} />
        <StarsComponent />
        <AsteroidField />
        <Planet />
        <Star bloom={bloomEnabled} />
        <AdaptiveDpr pixelated />
        <AdaptiveEvents />
      </Canvas>
      <Navigation setMovement={setMovement} />
      <SettingsMenu />
    </div>
  );
};

export default Scene;
