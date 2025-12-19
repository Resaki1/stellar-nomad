"use client";

import { settingsAtom } from "@/store/store";
import { AdaptiveDpr, AdaptiveEvents, Stats, StatsGl } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { useAtomValue } from "jotai";
import { memo } from "react";
import AsteroidField from "../Asteroids/AsteroidField";
import Planet from "../Planet/Planet";
import SpaceShip from "../Spaceship";
import Star from "../Star/Star";
import StarsComponent from "../Stars/StarsComponent";
import Anchor from "./Anchor";
import { NoToneMapping } from "three";
import SpaceRenderer from "../space/SpaceRenderer";
import SimGroup from "../space/SimGroup";

const Scene = () => {
  const settings = useAtomValue(settingsAtom);

  const isSafari =
    typeof window !== "undefined" && navigator
      ? /^((?!chrome|android).)*safari/i.test(navigator.userAgent)
      : false;

  return (
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
        bloom={settings.bloom}
        toneMapping={settings.toneMapping}
        scaled={
          <>
            <StarsComponent space="scaled" />
            <Planet />
            <Star bloom={settings.bloom} />
          </>
        }
        local={
          <>
            <ambientLight intensity={0.5} />
            <SpaceShip />
            {/* TODO: normalize ship/asteroid asset scales to exact kilometers. */}
            <SimGroup space="local" positionKm={[0, 0, 400_000]}>
              <AsteroidField />
            </SimGroup>
            <Anchor />
          </>
        }
      />
      <AdaptiveDpr pixelated />
      <AdaptiveEvents />
    </Canvas>
  );
};

export default memo(Scene);
