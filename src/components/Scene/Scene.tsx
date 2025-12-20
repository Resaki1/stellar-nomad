"use client";

import { settingsAtom } from "@/store/store";
import { Stats, StatsGl, AdaptiveDpr, AdaptiveEvents } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import {
  Bloom,
  EffectComposer,
  SMAA,
  ToneMapping,
} from "@react-three/postprocessing";
import { useAtomValue } from "jotai";
import { KernelSize, ToneMappingMode } from "postprocessing";
import AsteroidField from "../Asteroids/AsteroidField";
import Planet from "../Planet/Planet";
import SpaceShip from "../Spaceship";
import Star from "../Star/Star";
import StarsComponent from "../Stars/StarsComponent";
import { memo } from "react";
import Anchor from "./Anchor";
import { HalfFloatType, NoToneMapping } from "three";
import SpaceRenderer, { ScaledRenderPass } from "../space/SpaceRenderer";
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
          effects={
            <EffectComposer
              enableNormalPass={false}
              frameBufferType={HalfFloatType}
              multisampling={8}
            >
              <ScaledRenderPass />
              {settings.bloom ? (
                <Bloom
                  intensity={0.02}
                  luminanceThreshold={1}
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
              <SMAA />
            </EffectComposer>
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
