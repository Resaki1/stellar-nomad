"use client";

import { useState, useSyncExternalStore } from "react";
import { Maximize, Minimize } from "lucide-react";
import "./FullscreenControl.scss";

function subscribe(change: () => void) {
  document.addEventListener("fullscreenchange", change);
  const standalone = matchMedia("(display-mode: standalone)");
  standalone.addEventListener("change", change);
  return () => {
    document.removeEventListener("fullscreenchange", change);
    standalone.removeEventListener("change", change);
  };
}

function mode() {
  if (document.fullscreenElement) return "fullscreen";
  if (document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === "function") return "windowed";
  const nav = navigator as Navigator & { standalone?: boolean };
  if (/iPhone|iPod/.test(nav.userAgent) && !nav.standalone && !matchMedia("(display-mode: standalone)").matches) return "home-screen";
  return "unavailable";
}

export function useFullscreenMode() {
  return useSyncExternalStore(subscribe, mode, () => "unavailable" as const);
}

export default function FullscreenControl({ displaySettings = false }: { displaySettings?: boolean }) {
  const state = useFullscreenMode();
  const [error, setError] = useState("");
  if (state === "home-screen" && displaySettings) {
    return <p>To play without browser bars, open Safari’s Share menu, choose Add to Home Screen, then enable Open as Web App if shown.</p>;
  }
  if (state !== "fullscreen" && state !== "windowed") return null;
  const active = state === "fullscreen";
  const Icon = active ? Minimize : Maximize;
  const toggle = async () => {
    setError("");
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      setError("The browser couldn’t change fullscreen mode.");
    }
  };
  return <div className="display-mode">
    <button type="button" onClick={toggle}><Icon size={15} aria-hidden />{active ? "Exit fullscreen" : "Enter fullscreen"}</button>
    {error && <small role="status">{error}</small>}
  </div>;
}
