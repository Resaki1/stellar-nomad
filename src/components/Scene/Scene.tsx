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
import SpaceRenderer, {
  LOCAL_CAMERA_FAR,
  LOCAL_CAMERA_NEAR,
} from "../space/SpaceRenderer";
import { Vector3Like } from "@/sim/units";

const EARTH_POSITION_KM: Vector3Like = [10_000, 0, -10_000];
const SUN_POSITION_KM: Vector3Like = [65_000_000, 0, 130_000_000];

const Scene = () => {
  const settings = useAtomValue(settingsAtom);

  const isSafari =
    typeof window !== "undefined" && navigator
      ? /^((?!chrome|android).)*safari/i.test(navigator.userAgent)
      : false;

  return (
    <Canvas
      style={{ background: "black" }}
      camera={{ near: LOCAL_CAMERA_NEAR, far: LOCAL_CAMERA_FAR }}
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
        composerProps={{
          enableNormalPass: false,
          frameBufferType: HalfFloatType,
          multisampling: 8,
        }}
        localEffects={
          <>
            {settings.bloom ? (
              <Bloom
                intensity={0.02}
                luminanceThreshold={1}
                kernelSize={KernelSize.VERY_SMALL}
              />
            ) : null}
            {settings.toneMapping ? (
              <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
            ) : null}
            <SMAA />
          </>
        }
        scaled={
          <>
            <Planet
              planetPositionKm={EARTH_POSITION_KM}
              sunPositionKm={SUN_POSITION_KM}
            />
            <Star bloom={settings.bloom} positionKm={SUN_POSITION_KM} />
            <StarsComponent />
          </>
        }
        local={
          <>
            <ambientLight intensity={0.5} />
            <SpaceShip />
            <AsteroidField />
          </>
        }
      />
      <AdaptiveDpr pixelated />
      <AdaptiveEvents />
      <Anchor />
    </Canvas>
  );
};

export default memo(Scene);
