"use client";

import { settingsAtom } from "@/store/store";
import { Stats, StatsGl, AdaptiveDpr, AdaptiveEvents } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import {
  Bloom,
  EffectComposer,
  Noise,
  SMAA,
  ToneMapping,
} from "@react-three/postprocessing";
import { useAtomValue } from "jotai";
import { BlendFunction, KernelSize, ToneMappingMode } from "postprocessing";
import { HalfFloatType, SRGBColorSpace } from "three";
import AsteroidField from "../Asteroids/AsteroidField";
import Planet from "../Planet/Planet";
import SpaceShip from "../Spaceship";
import Star from "../Star/Star";
import StarsComponent from "../Stars/StarsComponent";
import { memo } from "react";
import Anchor from "./Anchor";

const Scene = () => {
  const settings = useAtomValue(settingsAtom);

  const isSafari =
    typeof window !== "undefined" && navigator
      ? /^((?!chrome|android).)*safari/i.test(navigator.userAgent)
      : false;

  return (
    <Canvas
      style={{ background: "black" }}
      camera={{ far: 200000 }}
      frameloop="always"
      dpr={[1, 2]}
      gl={{
        antialias: true,
        outputColorSpace: SRGBColorSpace,
        dithering: true,
      }}
    >
      {settings.fps ? isSafari ? <Stats /> : <StatsGl /> : <></>}
      <EffectComposer
        enableNormalPass={false}
        multisampling={4}
        frameBufferType={HalfFloatType}
      >
        <SMAA />
        {settings.bloom ? (
          <Bloom
            intensity={0.8}
            luminanceThreshold={0.8}
            luminanceSmoothing={0.2}
            kernelSize={KernelSize.MEDIUM}
            mipmapBlur
          />
        ) : (
          <></>
        )}
        <Noise
          opacity={0.08}
          premultiply
          blendFunction={BlendFunction.ADD}
        />
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
      <Star />
      <AdaptiveDpr />
      <AdaptiveEvents />
      <Anchor />
    </Canvas>
  );
};

export default memo(Scene);
