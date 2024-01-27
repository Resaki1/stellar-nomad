"use client";

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
import Navigation from "../Navigation/Navigation";
import SettingsMenu from "../SettingsMenu/SettingsMenu";
import { settingsAtom } from "@/store/store";
import { useAtomValue } from "jotai";

const Scene = () => {
  const settings = useAtomValue(settingsAtom);

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
        {settings.fps ? isSafari ? <Stats /> : <StatsGl /> : <></>}
        <EffectComposer disableNormalPass>
          {settings.bloom ? (
            <Bloom
              mipmapBlur
              intensity={0.02}
              luminanceThreshold={0}
              kernelSize={KernelSize.VERY_SMALL}
            />
          ) : (
            <></>
          )}
          {settings.toneMapping ? (
            <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
          ) : (
            <></>
          )}
        </EffectComposer>
        <ambientLight intensity={0.5} />
        <SpaceShip />
        <StarsComponent />
        <AsteroidField />
        <Planet />
        <Star bloom={settings.bloom} />
        <AdaptiveDpr pixelated />
        <AdaptiveEvents />
      </Canvas>
      <Navigation />
      <SettingsMenu />
    </div>
  );
};

export default Scene;
