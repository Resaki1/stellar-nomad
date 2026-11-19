"use client";

import ExpeditionControls from "@/components/Coop/ExpeditionControls";
import Panel from "./Shell/Panel";
import { coopSnapshot, subscribeCoop } from "@/net/coopState";
import { titleUrl } from "@/components/AppShell/appState";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAtomValue, useStore } from "jotai";
import { Package, Microscope, Shield, Target, Users, Wrench } from "lucide-react";
import { displayKey, keybindsAtom, type KeybindAction } from "@/store/keybinds";
import { settingsAtom, settingsIsOpenAtom } from "@/store/store";
import ShipDashboard from "./ShipDashboard/ShipDashboard";
import Reticle from "./Reticle/Reticle";
import FlightHud from "./FlightHud/FlightHud";
import { isTypingTarget, keyFromEvent } from "@/input/keyboard";
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

const SHIP_PANELS = [
  { id: "cargo", label: "Inventory", action: "toggleCargo", icon: Package },
  { id: "crew", label: "Crew", action: "toggleCrew", icon: Users },
  { id: "research", label: "Research", action: "toggleResearch", icon: Microscope },
  { id: "crafting", label: "Crafting", action: "toggleCrafting", icon: Wrench },
  { id: "loadout", label: "Loadout", action: "toggleLoadout", icon: Shield },
  { id: "projects", label: "Projects", action: "toggleProjects", icon: Target },
] as const satisfies readonly { id: string; label: string; action: KeybindAction; icon: typeof Package }[];

type OverlayPanel = (typeof SHIP_PANELS)[number]["id"] | null;

/** Glance read model (site, recovery destination, return fuel): human rate, not per frame. */
const GLANCE_MS = 250;

export default function HUD() {
  const [activePanel, setActivePanel] = useState<OverlayPanel>(null);
  const keybinds = useAtomValue(keybindsAtom);
  const settingsIsOpen = useAtomValue(settingsIsOpenAtom);
  const crew = useSyncExternalStore(subscribeCoop, coopSnapshot, coopSnapshot);
  const removed = crew.role === "guest" && crew.status === "refused" && crew.detail === "kicked";
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

  useEffect(() => setCursorNeeded("panel", activePanel !== null || removed), [activePanel, removed]);

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
      if (isTypingTarget(e.target)) return;
      const key = keyFromEvent(e);

      // Settings menu is modal — it swallows all non-settings hotkeys so the
      // player can't toggle gameplay panels while paused.
      if (store.get(settingsIsOpenAtom)) return;

      const panel = SHIP_PANELS.find(({ action, id }) =>
        (id !== "crew" || coopSnapshot().status === "joined") && keybindsRef.current[action].includes(key)
      );
      if (panel) {
        e.preventDefault();
        if (!e.repeat) openPanel(panel.id);
        return;
      }

      // Escape / settings key closes any open panel
      if (keybindsRef.current.toggleSettings.includes(key) && activePanelRef.current) {
        setActivePanel(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openPanel, store]);

  if (removed) {
    const leave = async () => {
      const { leaveSession } = await import("@/net/guestController");
      leaveSession();
      window.location.assign(titleUrl());
    };
    return <Panel title="Removed by the host" onClose={leave} width={400}
      primaryAction={{ label: "Return to title", onClick: leave }}>
      Your replicant can return when the host opens a new session.
    </Panel>;
  }
  const availablePanels = SHIP_PANELS.filter(({ id }) => id !== "crew" || crew.status === "joined");
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
      <SettingsMenu>
        <nav className="settings-menu__panels" aria-label="Ship panels">
          {availablePanels.map(({ id, label, action, icon: Icon }) => (
            <button key={id} data-ship-panel={id} onClick={() => {
              // Transfer cursor ownership before closing the menu to avoid a steering grab between panels.
              setCursorNeeded("panel", true);
              setActivePanel(id);
              store.set(settingsIsOpenAtom, false);
            }}>
              <Icon size={16} aria-hidden />
              {label}
              {keybinds[action][0] && <kbd>{displayKey(keybinds[action][0])}</kbd>}
            </button>
          ))}
        </nav>
      </SettingsMenu>
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
        {availablePanels.filter(({ id }) => id !== "cargo").map(({ id, label, action, icon: Icon }) => (
          <button key={id} aria-label={label}
            className={`hud__panel-btn ${activePanel === id ? "hud__panel-btn--active" : ""}`}
            onClick={() => openPanel(id)} title={`${label} (${keyLabel(keybinds[action])})`}>
            <Icon size={14} strokeWidth={1.75} aria-hidden />
            <span>{id === "crafting" ? "Craft" : label}</span>
          </button>
        ))}
      </div>

      {activePanel === "crew" && <Panel title="Crew" onClose={closePanel} width={440}>
        {crew.status === "joined" ? <ExpeditionControls discoveries={crew.discoveries} /> : <p>Session disconnected</p>}
      </Panel>}

      {/* Overlay panels */}
      {activePanel === "cargo" && <CargoDetail onClose={closePanel} />}
      {activePanel === "research" && <ResearchPanel onClose={closePanel} />}
      {activePanel === "crafting" && <CraftingPanel onClose={closePanel} />}
      {activePanel === "loadout" && <LoadoutPanel onClose={closePanel} />}
      {activePanel === "projects" && <ProjectsPanel onClose={closePanel} />}
    </div>
  );
}
