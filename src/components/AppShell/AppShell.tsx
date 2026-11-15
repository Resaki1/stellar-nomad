"use client";

import { useCallback, useEffect, useState, useSyncExternalStore, type ComponentType } from "react";
import { useStore } from "jotai";
import { bootActiveWorld, bootNewWorld } from "@/save/boot";
import { unlockAudio } from "@/audio/engine";
import { requestGamePointerLock } from "@/input/pointerLock";
import { musicDebug } from "@/audio/music";
import type { Difficulty } from "@/save/types";
import { addToastAtom } from "@/store/toast";
import {
  app,
  beginLoading,
  getAppPhase,
  loadFailed,
  setStartHandler,
  subscribeApp,
  worldLoaded,
} from "./appState";
import TitleAudio from "./TitleAudio";
import TitleScreen from "./TitleScreen";
import LoadingOverlay from "./LoadingOverlay";
import "./AppShell.scss";

// Not warmed at the title: evaluating the game modules already starts asset preloads (ShipOne.glb).
const loadGame = () => import("@/components/Game/Game");

export type StartTarget =
  | { kind: "world"; worldId: string | null }
  | { kind: "new"; name: string; seed: number; difficulty: Difficulty };

type DevWindow = Window & { __test?: unknown };

/**
 * title → loading → playing. The game chunk is not imported until a world starts, so the
 * title fetches no texture or model and creates no GPU device; its only audio is the UI
 * sounds and the title theme (TitleAudio).
 */
export default function AppShell() {
  const store = useStore();
  const phase = useSyncExternalStore(subscribeApp, getAppPhase, () => "title" as const);
  const [entry, setEntry] = useState<"pending" | "title" | "direct">("pending");
  // Not next/dynamic or lazy: their Suspense boundary would catch the Canvas's own
  // suspension and hide (and stall) the whole game while assets load.
  const [Game, setGame] = useState<ComponentType | null>(null);

  /** Must be called synchronously from the gesture that starts the world (audio unlock). */
  const start = useCallback(
    (target: StartTarget): Promise<void> => {
      if (getAppPhase() !== "title") return Promise.resolve();
      unlockAudio();
      requestGamePointerLock();
      beginLoading();
      const booted =
        target.kind === "new"
          ? bootNewWorld({ name: target.name, seed: target.seed, difficulty: target.difficulty })
          : bootActiveWorld(target.worldId);
      return Promise.all([booted, import("@/store/worldBridge"), loadGame()])
        .then(([meta, { installWorldBridge }, game]) => {
          installWorldBridge(store);
          // boot() falls back to the next world when the requested one fails; say so once playing.
          if (target.kind === "world" && target.worldId && meta.id !== target.worldId) {
            const off = subscribeApp(() => {
              if (getAppPhase() !== "playing") return;
              off();
              store.set(addToastAtom, {
                kind: "warn",
                message: "The selected world could not be loaded",
                detail: `Playing “${meta.name}” instead. Details are in the browser console.`,
                durationMs: 12_000,
              });
            });
          }
          setGame(() => game.default);
          worldLoaded(meta.name);
        })
        .catch((e: unknown) => {
          console.error("[save] boot failed", e);
          loadFailed(e instanceof Error ? e.message : String(e));
        });
    },
    [store],
  );

  useEffect(() => {
    setStartHandler((worldId) => start({ kind: "world", worldId: worldId ?? null }));
    const q = new URLSearchParams(window.location.search);
    const urlWorld = q.get("world");
    if (q.get("autostart") === "1" || urlWorld) {
      setEntry("direct");
      void start({ kind: "world", worldId: urlWorld });
    } else {
      setEntry("title");
    }
    return () => setStartHandler(null);
  }, [start]);

  // Dev: `__test.app` must exist at the title; the full harness replaces this stub once the game mounts.
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    const w = window as DevWindow;
    if (w.__test) return;
    const stub = {
      app,
      titleMusic: musicDebug,
      async ready(timeoutMs?: number): Promise<unknown> {
        while ((window as DevWindow).__test === stub) await new Promise((r) => setTimeout(r, 100));
        const full = (window as DevWindow).__test as { ready(t?: number): Promise<unknown> };
        return full.ready(timeoutMs);
      },
    };
    w.__test = stub;
  }, []);

  // While the overlay is up the game ignores input: swallow it before any game listener.
  useEffect(() => {
    if (phase !== "loading") return;
    const swallow = (e: Event) => e.stopImmediatePropagation();
    const types = ["keydown", "keyup", "keypress", "pointerdown", "pointerup", "wheel", "contextmenu"];
    for (const t of types) window.addEventListener(t, swallow, true);
    return () => {
      for (const t of types) window.removeEventListener(t, swallow, true);
    };
  }, [phase]);

  return (
    <>
      {/* inert: Tab/Enter must not reach the HUD under the opaque overlay (settings would stall the gate). */}
      {Game && (
        <div className="shell__contents" inert={phase === "loading"}>
          <Game />
        </div>
      )}
      {phase === "title" && entry === "title" && (
        <>
          <TitleAudio />
          <TitleScreen onStart={start} />
        </>
      )}
      {(phase === "loading" || (phase === "playing" && entry !== "pending")) && <LoadingOverlay />}
      {entry === "pending" && <div className="shell__blank" />}
    </>
  );
}
