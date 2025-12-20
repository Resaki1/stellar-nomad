"use client";

import { settingsAtom } from "@/store/store";
import { Stats, StatsGl, AdaptiveDpr, AdaptiveEvents } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { useAtomValue } from "jotai";
import AsteroidField from "../Asteroids/AsteroidField";
import Planet from "../Planet/Planet";
import SpaceShip from "../Spaceship";
import Star from "../Star/Star";
import StarsComponent from "../Stars/StarsComponent";
import { memo } from "react";
import Anchor from "./Anchor";
import { NoToneMapping } from "three";
import SpaceRenderer from "../space/SpaceRenderer";
import { WorldOriginProvider } from "@/sim/worldOrigin";
import SunLight from "../Star/SunLight";

const Scene = () => {
  const settings = useAtomValue(settingsAtom);

  const isSafari =
    typeof window !== "undefined" && navigator
      ? /^((?!chrome|android).)*safari/i.test(navigator.userAgent)
      : false;

  return (
    <WorldOriginProvider>
      <Canvas
        style={{ background: "black" }}
        camera={{ near: 0.01, far: 20_000 }}
        frameloop="always"
        dpr={[0.5, 1.5]}
        gl={{
          alpha: false,
          premultipliedAlpha: false,
          antialias: true,
          powerPreference: "high-performance",
          toneMapping: NoToneMapping,
          logarithmicDepthBuffer: true,
        }}
      >
        {settings.fps ? isSafari ? <Stats /> : <StatsGl /> : <></>}
        <SpaceRenderer
          postprocessing={{
            bloom: settings.bloom,
            toneMapping: settings.toneMapping,
          }}
          scaled={
            <>
              <StarsComponent />
              <Planet />
              <Star bloom={settings.bloom} />
            </>
          }
          local={
            <>
              <ambientLight intensity={0.5} />
              <SunLight />
              <SpaceShip />
              <AsteroidField />
            </>
          }
        />
        <AdaptiveDpr pixelated />
        <AdaptiveEvents />
        <Anchor />
      </Canvas>
    </WorldOriginProvider>
  );
};

export default memo(Scene);
