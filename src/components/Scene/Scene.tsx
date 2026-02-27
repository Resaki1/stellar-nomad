// src/components/Scene/Scene.tsx
"use client";

import { settingsAtom } from "@/store/store";
import { Stats, StatsGl, AdaptiveDpr, AdaptiveEvents } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { useAtomValue } from "jotai";
import { memo } from "react";
import { NoToneMapping } from "three";

import AsteroidField from "../Asteroids/AsteroidField";
import MilkyWaySkybox from "../Skybox/MilkyWaySkybox";
import Planet from "../Planet/Planet";
import SpaceShip from "../Spaceship";
import Star from "../Star/Star";
import SunLight from "../Star/SunLight";
import SpaceRenderer from "../space/SpaceRenderer";
import Anchor from "./Anchor";
import MiningSystem from "../Mining/MiningSystem";
import AsteroidVFX from "../VFX/AsteroidVFX";

import { AsteroidRuntimeProvider } from "@/sim/asteroids/runtimeContext";
import { WorldOriginProvider } from "@/sim/worldOrigin";

const Scene = () => {
  const settings = useAtomValue(settingsAtom);

  const isSafari =
    typeof window !== "undefined" && navigator
      ? /^((?!chrome|android).)*safari/i.test(navigator.userAgent)
      : false;

  return (
    <WorldOriginProvider>
      <AsteroidRuntimeProvider>
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
          {settings.fps ? (isSafari ? <Stats /> : <StatsGl />) : <></>}

          <SpaceRenderer
            scaled={
              <>
                <MilkyWaySkybox />
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
                <MiningSystem />
                <AsteroidVFX />
              </>
            }
          />

          <AdaptiveDpr pixelated />
          <AdaptiveEvents />
          <Anchor />
        </Canvas>
      </AsteroidRuntimeProvider>
    </WorldOriginProvider>
  );
};

export default memo(Scene);
