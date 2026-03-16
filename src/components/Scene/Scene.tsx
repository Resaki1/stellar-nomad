// src/components/Scene/Scene.tsx
"use client";

import { settingsAtom } from "@/store/store";
import { Stats, StatsGl, AdaptiveDpr, AdaptiveEvents } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { useAtomValue } from "jotai";
import { memo } from "react";
import * as THREE from "three/webgpu";

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
import ResearchTicker from "../Research/ResearchTicker";

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
      frameloop="demand"
      dpr={[0.5, 1.5]}
      gl={(defaultProps) => {
          const renderer = new THREE.WebGPURenderer({
            canvas: defaultProps.canvas as HTMLCanvasElement,
            powerPreference: "high-performance",
            antialias: false,
            alpha: false,
            stencil: false,
            logarithmicDepthBuffer: true,
          });

          // R3F's loop starts immediately (frameloop="always") but
          // WebGPU init is async. Patch render() to silently no-op
          // until the backend is ready, instead of throwing.
          const origRender = renderer.render.bind(renderer);
          renderer.render = function (scene: any, camera: any) {
            if (!(this as any)._initialized) return;
            return origRender(scene, camera);
          };

          renderer.init().then(() => {
            // Stop the renderer's internal rAF loop. R3F owns the frame loop;
            // we manually tick nodeFrame + info in SpaceRenderer's useFrame.
            (renderer as any)._animation?.stop();
            console.log("WebGPU initialized successfully");
          });
          return renderer;
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
                <ResearchTicker />
              </>
            }
          />

          {/* <AdaptiveDpr pixelated /> */}
          <AdaptiveEvents />
          <Anchor />
    </Canvas>
  );
};

export default memo(Scene);
