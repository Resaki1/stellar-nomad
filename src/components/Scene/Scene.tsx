// src/components/Scene/Scene.tsx
"use client";

import { settingsAtom, settingsIsOpenAtom } from "@/store/store";
import { Stats, StatsGl, AdaptiveEvents } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useAtomValue } from "jotai";
import { memo, type ReactNode, useEffect, useMemo, useState } from "react";
import * as THREE from "three/webgpu";
import {
  hasGpuTimestamps,
  installPerfInspector,
  isPerfEnabled,
  perf,
} from "../space/perf/perfProfiler";

import AsteroidField from "../Asteroids/AsteroidField";
import MilkyWaySkybox from "../Skybox/MilkyWaySkybox";
import StarField from "../Stars/StarField";
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
import AtmosphereSkyLight from "../Star/AtmosphereSkyLight";
import SkyLight from "../Star/SkyLight";
import SpaceRenderer from "../space/SpaceRenderer";
import MiningSystem from "../Mining/MiningSystem";
import PingBrackets3D from "../Mining/PingBrackets3D";
import AsteroidVFX from "../VFX/AsteroidVFX";
import ResearchTicker from "../Research/ResearchTicker";
import TimedEffectsTicker from "../Effects/TimedEffectsTicker";
import HullRegenTicker from "../Effects/HullRegenTicker";
import TransitTicker from "../Transit/TransitTicker";
import POIProjector from "../POI/POIProjector";
import WreckCollector from "../WreckCollector";

/**
 * three.js renderer internals we touch directly (not in the public typings).
 * The scene runs on a WebGPURenderer; R3F types `gl` as the base renderer.
 */
type RendererInternals = {
  _initialized?: boolean;
  _animation?: { stop: () => void };
  __initPromise?: Promise<void>;
};

/** Renders children only after the WebGPU renderer has finished async init(). */
function WebGPUGate({ children }: { children: ReactNode }) {
  const gl = useThree((s) => s.gl);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const p = (gl as unknown as RendererInternals).__initPromise;
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

/**
 * Brackets the whole R3F frame to measure total JS time per frame.
 *
 * Priorities -1000 / +1000 put these before and after every other `useFrame` in
 * the app (SpaceRenderer is priority 1, everything else 0), so the delta covers
 * ship physics, the 14 CelestialBody LOD updates, asteroid streaming and pass
 * submission together. Comparing that against GPU total is what tells us whether
 * a scenario is CPU- or GPU-bound. Mounted only when profiling is on.
 */
function PerfProbe() {
  useFrame(() => perf.markFrameStart(), -1000);
  useFrame(() => perf.markFrameEnd(), 1000);
  return null;
}

const Scene = () => {
  const settings = useAtomValue(settingsAtom);
  const settingsIsOpen = useAtomValue(settingsIsOpenAtom);
  // Read once and independently of the atom: the `gl` factory below decides
  // `trackTimestamp` from the same value, and the two must not disagree.
  const perfOn = useMemo(() => isPerfEnabled(), []);
  const isSafari =
    typeof window !== "undefined" && navigator
      ? /^((?!chrome|android).)*safari/i.test(navigator.userAgent)
      : false;

  const scaledContent = useMemo(
    () => (
      <>
        <MilkyWaySkybox />
        {/* Catalogue stars at real magnitudes (D30). Draws just after the
            panorama; see StarField.tsx for the flux-conservation argument. */}
        <StarField />
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
        <Star />
      </>
    ),
    [],
  );

  const localContent = useMemo(
    () => (
      <>
        {/* SunLight owns BOTH the key light and the bounce fill now — they
            must scale together with star distance (Phase 3 / D03). */}
        <SunLight />
        <AtmosphereSkyLight />
        {/* The sky itself as a light — SH-L2 from the panorama + catalogue (S4,
            closes D29). This is the only thing lighting the hull inside an
            atmosphere-less umbra, where the key light and its bounce fill are
            both zero. */}
        <SkyLight />
        <SpaceShip />
        <AsteroidField />
        <MiningSystem />
        <PingBrackets3D />
        <AsteroidVFX />
        <ResearchTicker />
        <TimedEffectsTicker />
        <HullRegenTicker />
        <TransitTicker />
        <POIProjector />
        <WreckCollector />
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
          // Profiling must be decided here: `trackTimestamp` allocates the GPU
          // query pool at construction and cannot be turned on later. See
          // isPerfEnabled() for why this reads localStorage rather than the atom.
          perf.enabled = isPerfEnabled();
          const renderer = new THREE.WebGPURenderer({
            canvas: defaultProps.canvas as HTMLCanvasElement,
            powerPreference: "high-performance",
            logarithmicDepthBuffer: true,
            trackTimestamp: perf.enabled,
          });
          installPerfInspector(renderer);

          const origRender = renderer.render.bind(renderer);
          renderer.render = function (
            this: THREE.WebGPURenderer,
            scene: THREE.Object3D,
            camera: THREE.Camera,
          ) {
            if (!(this as unknown as RendererInternals)._initialized) return;
            return origRender(scene, camera);
          };

          performance.mark("webgpu-init-start");
          const initPromise = renderer.init().then(() => {
            (renderer as unknown as RendererInternals)._animation?.stop();
            performance.mark("webgpu-init-end");
            console.log(
              "[perf] WebGPU renderer.init() done",
              performance.measure("webgpu-init", "webgpu-init-start", "webgpu-init-end").duration.toFixed(0) + "ms",
            );
            if (perf.enabled) {
              // `trackTimestamp` is silently downgraded when the adapter lacks
              // the `timestamp-query` feature, so report what we actually got.
              perf.gpuTimingSupported = hasGpuTimestamps(renderer);
              console.log(
                perf.gpuTimingSupported
                  ? "[perf] Per-pass GPU timing ACTIVE. __bench.report() / __bench.sweep()"
                  : "[perf] Per-pass GPU timing UNAVAILABLE (adapter lacks timestamp-query) — CPU timings only.",
              );
            }
          });
          (renderer as unknown as RendererInternals).__initPromise = initPromise;
          return renderer;
        }}
    >
          {settings.fps ? (isSafari ? <Stats /> : <StatsGl />) : <></>}
          {perfOn ? <PerfProbe /> : null}

          <WebGPUGate>
            <SpaceRenderer scaled={scaledContent} local={localContent} />
          </WebGPUGate>

          {/* <AdaptiveDpr pixelated /> */}
          <AdaptiveEvents />
    </Canvas>
  );
};

export default memo(Scene);
