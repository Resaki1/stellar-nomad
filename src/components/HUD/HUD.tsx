"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomValue, useStore } from "jotai";
import { Microscope, Shield, Target, Wrench } from "lucide-react";
import { displayKey, keybindsAtom } from "@/store/keybinds";
import { settingsAtom, settingsIsOpenAtom } from "@/store/store";
import ShipDashboard from "./ShipDashboard/ShipDashboard";
import Reticle from "./Reticle/Reticle";
import FlightHud from "./FlightHud/FlightHud";
import { setCursorNeeded } from "@/input/pointerLock";
import MiningHUD from "./MiningHUD/MiningHUD";
import CargoHUD from "./CargoHUD/CargoHUD";
import CargoDetail from "./CargoHUD/CargoDetail";
import SettingsMenu from "./SettingsMenu/SettingsMenu";
import DamageVignette from "./DamageVignette/DamageVignette";
import ResearchPanel from "./ResearchPanel/ResearchPanel";
import CraftingPanel from "./CraftingPanel/CraftingPanel";
import LoadoutPanel from "./LoadoutPanel/LoadoutPanel";
import NotificationStack from "./NotificationStack/NotificationStack";
import Hotbar from "./Hotbar/Hotbar";
import ObjectiveTracker from "./ObjectiveTracker/ObjectiveTracker";
import ProjectsPanel from "./ProjectsPanel/ProjectsPanel";
import { sampleGlanceAtom } from "@/store/sites";
import POIMarkers from "./POIMarkers/POIMarkers";
import DeathScreen from "./DeathScreen/DeathScreen";
import { isDeadAtom } from "@/store/death";
import CommsOverlay from "./CommsOverlay/CommsOverlay";
import AINameOverlay from "./AINameOverlay/AINameOverlay";
import HdrCalibration from "./HdrCalibration/HdrCalibration";
import TransitHUD from "./TransitHUD/TransitHUD";
import ReplicationHUD from "./ReplicationHUD/ReplicationHUD";
import GameCommsTriggers from "../Comms/GameCommsTriggers";
import PerfHUD from "./PerfHUD/PerfHUD";
import AudioHUD from "./AudioHUD/AudioHUD";
import { isPerfEnabled } from "@/components/space/perf/perfProfiler";
import { audioSettingsAtom } from "@/store/audio";

import "./HUD.scss";

/** First bound key, for button titles (rebinding updates them). */
const keyLabel = (keys: readonly string[]): string => (keys[0] ? displayKey(keys[0]) : "unbound");

type OverlayPanel = "cargo" | "research" | "crafting" | "loadout" | "projects" | null;

/** Glance read model (site, recovery destination, return fuel): human rate, not per frame. */
const GLANCE_MS = 250;

export default function HUD() {
  const [activePanel, setActivePanel] = useState<OverlayPanel>(null);
  const keybinds = useAtomValue(keybindsAtom);
  const settingsIsOpen = useAtomValue(settingsIsOpenAtom);
  const dead = useAtomValue(isDeadAtom);
  // Either the persisted setting (which shows a "needs reload" hint when the
  // renderer was built without timestamp queries) or `?perf=1`, which turns
  // profiling on from a cold load and should show the readout too.
  //
  // The `?perf=1` read must happen AFTER mount: it depends on `window`, so
  // evaluating it during the first render disagrees with the server render and
  // fails hydration. (`settingsAtom` is safe — atomWithStorage yields its default
  // on both sides and hydrates in an effect.)
  const [perfForced, setPerfForced] = useState(false);
  useEffect(() => {
    if (isPerfEnabled()) setPerfForced(true);
  }, []);
  const perfHudOn = useAtomValue(settingsAtom).perf || perfForced;
  // ⚠ The hook is called UNCONDITIONALLY and the dev gate applied to its RESULT.
  // Writing `IS_DEV && useAtomValue(...)` short-circuits the hook call, which
  // breaks the rules of hooks (eslint catches it as an error, correctly — a hook
  // that sometimes runs desynchronises the whole hook order for the component).
  const audioHudSetting = useAtomValue(audioSettingsAtom).hud;
  const audioHudOn = process.env.NODE_ENV === "development" && audioHudSetting;
  const store = useStore();
  const keybindsRef = useRef(keybinds);
  keybindsRef.current = keybinds;
  const activePanelRef = useRef(activePanel);
  activePanelRef.current = activePanel;

  // Close any open gameplay panel when the settings menu opens — settings is
  // modal and must own input focus exclusively.
  useEffect(() => {
    if (settingsIsOpen && activePanelRef.current !== null) {
      setActivePanel(null);
    }
  }, [settingsIsOpen]);

  useEffect(() => setCursorNeeded("panel", activePanel !== null), [activePanel]);

  useEffect(() => {
    const t = setInterval(() => store.set(sampleGlanceAtom), GLANCE_MS);
    return () => clearInterval(t);
  }, [store]);

  const openPanel = useCallback((panel: OverlayPanel) => {
    if (store.get(settingsIsOpenAtom)) return;
    setActivePanel((prev) => (prev === panel ? null : panel));
  }, [store]);

  const closePanel = useCallback(() => setActivePanel(null), []);

  // Hotkeys for panels
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const key = e.key.toLowerCase();

      // Settings menu is modal — it swallows all non-settings hotkeys so the
      // player can't toggle gameplay panels while paused.
      if (store.get(settingsIsOpenAtom)) return;

      if (keybindsRef.current.toggleCargo.includes(key)) {
        e.preventDefault();
        setActivePanel((prev) => (prev === "cargo" ? null : "cargo"));
        return;
      }

      if (keybindsRef.current.toggleResearch.includes(key)) {
        e.preventDefault();
        setActivePanel((prev) => (prev === "research" ? null : "research"));
        return;
      }

      if (keybindsRef.current.toggleCrafting.includes(key)) {
        e.preventDefault();
        setActivePanel((prev) => (prev === "crafting" ? null : "crafting"));
        return;
      }

      if (keybindsRef.current.toggleLoadout.includes(key)) {
        e.preventDefault();
        setActivePanel((prev) => (prev === "loadout" ? null : "loadout"));
        return;
      }

      if (keybindsRef.current.toggleProjects.includes(key)) {
        e.preventDefault();
        setActivePanel((prev) => (prev === "projects" ? null : "projects"));
        return;
      }

      // Escape / settings key closes any open panel
      if (keybindsRef.current.toggleSettings.includes(key) && activePanelRef.current) {
        setActivePanel(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store]);

  return (
    <div className={`hud${dead ? " hud--dead" : ""}`}>
      <DamageVignette />
      <POIMarkers />
      <ShipDashboard />
      <FlightHud />
      <Reticle />
      <MiningHUD />
      <CargoHUD onClick={() => openPanel("cargo")} />
      <ObjectiveTracker />
      <SettingsMenu />
      <NotificationStack />
      <AINameOverlay />
      <CommsOverlay />
      {/* Phase 6d. Only the controls live here — the wedge itself replaces the post
          chain's output node, because HTML cannot exceed reference white. */}
      <HdrCalibration />
      <GameCommsTriggers />
      <DeathScreen />
      <Hotbar />
      <TransitHUD />
      <ReplicationHUD />
      {perfHudOn && <PerfHUD />}
      {audioHudOn && <AudioHUD />}

      {/* Quick-access buttons */}
      <div className="hud__panel-buttons">
        <button
          className={`hud__panel-btn ${activePanel === "research" ? "hud__panel-btn--active" : ""}`}
          onClick={() => openPanel("research")}
          title={`Research (${keyLabel(keybinds.toggleResearch)})`}
        >
          <Microscope size={14} strokeWidth={1.75} aria-hidden />
          <span>Research</span>
        </button>
        <button
          className={`hud__panel-btn ${activePanel === "crafting" ? "hud__panel-btn--active" : ""}`}
          onClick={() => openPanel("crafting")}
          title={`Crafting (${keyLabel(keybinds.toggleCrafting)})`}
        >
          <Wrench size={14} strokeWidth={1.75} aria-hidden />
          <span>Craft</span>
        </button>
        <button
          className={`hud__panel-btn ${activePanel === "loadout" ? "hud__panel-btn--active" : ""}`}
          onClick={() => openPanel("loadout")}
          title={`Loadout (${keyLabel(keybinds.toggleLoadout)})`}
        >
          <Shield size={14} strokeWidth={1.75} aria-hidden />
          <span>Loadout</span>
        </button>
        <button
          className={`hud__panel-btn ${activePanel === "projects" ? "hud__panel-btn--active" : ""}`}
          onClick={() => openPanel("projects")}
          title={`Projects and records (${keyLabel(keybinds.toggleProjects)})`}
        >
          <Target size={14} strokeWidth={1.75} aria-hidden />
          <span>Projects</span>
        </button>
      </div>

      {/* Overlay panels */}
      {activePanel === "cargo" && <CargoDetail onClose={closePanel} />}
      {activePanel === "research" && <ResearchPanel onClose={closePanel} />}
      {activePanel === "crafting" && <CraftingPanel onClose={closePanel} />}
      {activePanel === "loadout" && <LoadoutPanel onClose={closePanel} />}
      {activePanel === "projects" && <ProjectsPanel onClose={closePanel} />}
    </div>
  );
}
