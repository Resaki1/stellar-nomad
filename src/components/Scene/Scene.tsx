// src/components/Scene/Scene.tsx
"use client";

import { settingsAtom, settingsIsOpenAtom } from "@/store/store";
import { Stats, StatsGl, AdaptiveEvents } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { useAtomValue } from "jotai";
import { memo, type ReactNode, useEffect, useMemo, useState } from "react";
import * as THREE from "three/webgpu";

import AsteroidField from "../Asteroids/AsteroidField";
import MilkyWaySkybox from "../Skybox/MilkyWaySkybox";
import Mercury from "../Mercury/Mercury";
import Venus from "../Venus/Venus";
import Earth from "../Earth/Earth";
import Luna from "../Moon/Luna";
import Mars from "../Mars/Mars";
import Uranus from "../Uranus/Uranus";
import Neptune from "../Neptune/Neptune";
import Saturn from "../Saturn/Saturn";
import Jupiter from "../Jupiter/Jupiter";
import Callisto from "../Callisto/Callisto";
import Europa from "../Europa/Europa";
import Ganymede from "../Ganymede/Ganymede";
import Io from "../Io/Io";
import SpaceShip from "../Spaceship";
import Star from "../Star/Star";
import SunLight from "../Star/SunLight";
import SpaceRenderer from "../space/SpaceRenderer";
import MiningSystem from "../Mining/MiningSystem";
import PingBrackets3D from "../Mining/PingBrackets3D";
import AsteroidVFX from "../VFX/AsteroidVFX";
import ResearchTicker from "../Research/ResearchTicker";
import TimedEffectsTicker from "../Effects/TimedEffectsTicker";
import POIProjector from "../POI/POIProjector";
import WreckCollector from "../WreckCollector";
import CelestialCollider from "../CelestialCollider";

/** Renders children only after the WebGPU renderer has finished async init(). */
function WebGPUGate({ children }: { children: ReactNode }) {
  const gl = useThree((s) => s.gl);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const p = (gl as any).__initPromise as Promise<void> | undefined;
    if (!p) return;
    p.then(() => {
      performance.mark("webgpu-gate-open");
      console.log(
        "[perf] WebGPU gate open — scene tree will mount",
        performance.now().toFixed(0) + "ms",
      );
      setReady(true);
    });
  }, [gl]);

  return ready ? <>{children}</> : null;
}

const Scene = () => {
  const settings = useAtomValue(settingsAtom);
  const settingsIsOpen = useAtomValue(settingsIsOpenAtom);
  const isSafari =
    typeof window !== "undefined" && navigator
      ? /^((?!chrome|android).)*safari/i.test(navigator.userAgent)
      : false;

  const scaledContent = useMemo(
    () => (
      <>
        <MilkyWaySkybox />
        <Mercury />
        <Venus />
        <Earth />
        <Luna />
        <Mars />
        <Uranus />
        <Neptune />
        <Saturn />
        <Jupiter />
        <Callisto />
        <Europa />
        <Ganymede />
        <Io />
        <Star bloom={settings.bloom} />
      </>
    ),
    [settings.bloom],
  );

  const localContent = useMemo(
    () => (
      <>
        <ambientLight intensity={0.5} />
        <SunLight />
        <SpaceShip />
        <AsteroidField />
        <MiningSystem />
        <PingBrackets3D />
        <AsteroidVFX />
        <ResearchTicker />
        <TimedEffectsTicker />
        <POIProjector />
        <WreckCollector />
        <CelestialCollider />
      </>
    ),
    [],
  );

  return (
    <Canvas
      style={{ background: "black" }}
      camera={{ near: 0.01, far: 20_000 }}
      frameloop={settingsIsOpen ? "never" : "always"}
      dpr={[0.5, 1.5]}
      gl={(defaultProps) => {
          const renderer = new THREE.WebGPURenderer({
            canvas: defaultProps.canvas as HTMLCanvasElement,
            powerPreference: "high-performance",
            logarithmicDepthBuffer: true,
          });

          const origRender = renderer.render.bind(renderer);
          renderer.render = function (scene: any, camera: any) {
            if (!(this as any)._initialized) return;
            return origRender(scene, camera);
          };

          performance.mark("webgpu-init-start");
          const initPromise = renderer.init().then(() => {
            (renderer as any)._animation?.stop();
            performance.mark("webgpu-init-end");
            console.log(
              "[perf] WebGPU renderer.init() done",
              performance.measure("webgpu-init", "webgpu-init-start", "webgpu-init-end").duration.toFixed(0) + "ms",
            );
          });
          (renderer as any).__initPromise = initPromise;
          return renderer;
        }}
    >
          {settings.fps ? (isSafari ? <Stats /> : <StatsGl />) : <></>}

          <WebGPUGate>
            <SpaceRenderer scaled={scaledContent} local={localContent} />
          </WebGPUGate>

          {/* <AdaptiveDpr pixelated /> */}
          <AdaptiveEvents />
    </Canvas>
  );
};

export default memo(Scene);
