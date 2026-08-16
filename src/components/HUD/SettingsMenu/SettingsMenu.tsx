import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import "./SettingsMenu.scss";
import { SetStateAction, useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import { ChevronLeft, Settings as SettingsIcon } from "lucide-react";
import {
  SetAtom,
  Settings,
  settingsAtom,
  settingsIsOpenAtom,
} from "@/store/store";
import SettingsCheckbox from "./SettingsCheckbox/SettingsCheckbox";
import KeybindRow from "./KeybindRow/KeybindRow";
import Panel from "../Shell/Panel";
import {
  KEYBIND_ACTIONS,
  CATEGORY_LABELS,
  KeybindCategory,
  keybindsAtom,
  resetKeybindsAtom,
} from "@/store/keybinds";
import { useDetectGPU } from "@react-three/drei";
import { useAsteroidDeltaStore } from "@/sim/asteroids/runtimeContext";
import { clearShipState, loadShipState } from "@/sim/shipPersistence";
import { devTeleportAtom, devMaxSpeedOverrideAtom, devSpeedUnitAtom } from "@/store/dev";
import { type SpeedUnit, SPEED_UNIT_TO_MPS } from "@/sim/units";
import { addAssaySamplesAtom, researchAtom } from "@/store/research";
import { addCargoAtom } from "@/store/cargo";
import { modulesAtom, addCraftedItemAtom } from "@/store/modules";
import { ITEMS, RESEARCH_NODES } from "@/data/content";
import { resetCommsPlayedAtom } from "@/store/comms";
import { benchProgress, getBenchRunner } from "@/components/space/perf/benchRunner";
import { isPerfEnabled } from "@/components/space/perf/perfProfiler";
import {
  BODY_IDS,
  SCENARIOS,
  bodyRadiusKm,
  findScenario,
  resolveBodyWarp,
  resolveScenario,
} from "@/components/space/perf/scenarios";

enum SubMenu {
  Graphics = "graphics",
  Controls = "controls",
  Dev = "dev",
}

const IS_DEV = process.env.NODE_ENV === "development";

const renderSubMenu = (
  subMenu: SubMenu,
  settings: Settings,
  setSettings: SetAtom<[SetStateAction<Settings>], void>,
  onResetWorld?: () => void,
  onResetKeybinds?: () => void,
  devHandlers?: {
    onTeleport: (x: number, y: number, z: number) => void;
    onSetMaxSpeed: (speed: number | null) => void;
    currentMaxSpeedOverride: number | null;
    exposureStops: number;
    onSetExposureStops: (stops: number) => void;
    onGrantAssay: (amount: number) => void;
    onGrantCargo: (resourceId: string, amount: number) => void;
    onUnlockAllResearch: () => void;
    onGrantAllItems: () => void;
    onResetProgress: () => void;
    onResetComms: () => void;
  }
) => {
  switch (subMenu) {
    case SubMenu.Graphics:
      return (
        <>
          <SettingsCheckbox
            active={settings.bloom}
            onChange={() =>
              setSettings((prev) => ({
                ...prev,
                bloom: !prev.bloom,
              }))
            }
            label="bloom"
          />
          <SettingsCheckbox
            active={settings.toneMapping}
            onChange={() =>
              setSettings((prev) => ({
                ...prev,
                toneMapping: !prev.toneMapping,
              }))
            }
            label="AgX tone mapping"
          />
        </>
      );
    case SubMenu.Controls: {
      const categories = new Map<KeybindCategory, typeof KEYBIND_ACTIONS>();
      for (const a of KEYBIND_ACTIONS) {
        if (!categories.has(a.category)) categories.set(a.category, []);
        categories.get(a.category)!.push(a);
      }

      return (
        <>
          <SettingsCheckbox
            active={settings.invertPitch}
            onChange={() =>
              setSettings((prev) => ({
                ...prev,
                invertPitch: !prev.invertPitch,
              }))
            }
            label="invert pitch"
          />

          {Array.from(categories.entries()).map(([cat, actions]) => (
            <div key={cat} className="keybind-category">
              <div className="keybind-category__title">
                {CATEGORY_LABELS[cat]}
              </div>
              <div className="keybind-category__rows">
                {actions.map((a) => (
                  <KeybindRow key={a.id} action={a.id} label={a.label} />
                ))}
              </div>
            </div>
          ))}

          {onResetKeybinds && (
            <button
              className="settings-menu__button settings-menu__button--subtle"
              onClick={onResetKeybinds}
            >
              reset keybinds
            </button>
          )}
        </>
      );
    }
    case SubMenu.Dev:
      return (
        <>
          <SettingsCheckbox
            active={settings.fps}
            onChange={() =>
              setSettings((prev) => ({
                ...prev,
                fps: !prev.fps,
              }))
            }
            label="show fps"
          />
          <SettingsCheckbox
            active={settings.perf}
            onChange={() =>
              setSettings((prev) => ({
                ...prev,
                perf: !prev.perf,
              }))
            }
            // GPU timestamp queries are requested when the WebGPURenderer is
            // constructed, so this only takes effect on the next page load.
            label="perf profiler (reload)"
          />
          <BodyWarpControls />
          <PerfSweepButton />
          {devHandlers && <DevControls {...devHandlers} />}
          {onResetWorld && (
            <button
              className="settings-menu__button settings-menu__button--danger"
              onClick={onResetWorld}
            >
              reset world
            </button>
          )}
        </>
      );
  }
};

// ---------------------------------------------------------------------------
// Body / scenario warps — see docs/PERF_MEASUREMENT.md
// ---------------------------------------------------------------------------

/** Sensible starting altitude per body: low enough to see it, high enough to be outside it. */
const DEFAULT_ALT_KM = 2000;

/**
 * Two ways to get somewhere specific without the console:
 *  • any body + an altitude — for eyeballing
 *  • a named benchmark scenario — for reproducing a measured row
 *
 * Both route through the same `resolveScenario` math the sweep uses, so the pose
 * you eyeball is the pose that gets measured. A dropdown rather than one button
 * per body: 14 buttons still would not let you pick a distance, and distance is
 * what drives every altitude gate.
 *
 * Both close the menu, because `settingsIsOpenAtom` sets `frameloop="never"` —
 * with the menu open the warp sits unconsumed and nothing appears to happen.
 */
function BodyWarpControls() {
  const store = useStore();
  const setIsOpen = useSetAtom(settingsIsOpenAtom);
  const [bodyId, setBodyId] = useState<string>("earth");
  const [altKm, setAltKm] = useState(String(DEFAULT_ALT_KM));
  const [scenarioId, setScenarioId] = useState<string>(SCENARIOS[0].id);

  const warpTo = useCallback(
    (warp: ReturnType<typeof resolveBodyWarp>) => {
      setIsOpen(false);
      store.set(devTeleportAtom, warp);
    },
    [store, setIsOpen],
  );

  const handleBodyWarp = useCallback(() => {
    const alt = parseFloat(altKm);
    if (!Number.isFinite(alt)) return;
    warpTo(resolveBodyWarp(bodyId, alt));
  }, [bodyId, altKm, warpTo]);

  const handleScenarioWarp = useCallback(() => {
    const s = findScenario(scenarioId);
    if (s) warpTo(resolveScenario(s));
  }, [scenarioId, warpTo]);

  const handleScenarioMeasure = useCallback(() => {
    setIsOpen(false);
    void getBenchRunner(store)
      .run(scenarioId)
      .catch((err) => console.error(err));
  }, [scenarioId, store, setIsOpen]);

  return (
    <>
      <div className="dev-controls__section">
        <div className="dev-controls__label">
          warp to body — altitude above surface (r = {Math.round(bodyRadiusKm(bodyId))} km)
        </div>
        <div className="dev-controls__row">
          <select
            className="dev-controls__select"
            value={bodyId}
            onChange={(e) => setBodyId(e.target.value)}
          >
            {BODY_IDS.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <input
            className="dev-controls__input dev-controls__input--wide"
            type="number"
            placeholder="km"
            value={altKm}
            onChange={(e) => setAltKm(e.target.value)}
          />
          <button
            className="settings-menu__button settings-menu__button--subtle"
            onClick={handleBodyWarp}
          >
            warp
          </button>
        </div>
      </div>

      <div className="dev-controls__section">
        <div className="dev-controls__label">perf scenario</div>
        <div className="dev-controls__row dev-controls__row--wrap">
          <select
            className="dev-controls__select dev-controls__select--wide"
            value={scenarioId}
            onChange={(e) => setScenarioId(e.target.value)}
          >
            {SCENARIOS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id}
              </option>
            ))}
          </select>
          <button
            className="settings-menu__button settings-menu__button--subtle"
            onClick={handleScenarioWarp}
          >
            warp
          </button>
          <button
            className="settings-menu__button settings-menu__button--subtle"
            onClick={handleScenarioMeasure}
          >
            measure
          </button>
        </div>
        <div className="dev-controls__hint">
          {findScenario(scenarioId)?.what}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Perf sweep launcher — see docs/PERF_MEASUREMENT.md
// ---------------------------------------------------------------------------

/**
 * Runs `__bench.sweep()` without needing the console.
 *
 * Two things this has to get right:
 *  • **It must close the settings menu first.** `settingsIsOpenAtom` drives
 *    `frameloop="never"` in Scene.tsx, so with the menu open there are no frames
 *    to measure and the sweep would hang forever on its first `advance()`.
 *  • Profiling has to have been on at page load (GPU timestamp queries are
 *    requested when the renderer is constructed), so when it isn't, this offers
 *    the reload instead of failing silently.
 */
function PerfSweepButton() {
  const store = useStore();
  const setIsOpen = useSetAtom(settingsIsOpenAtom);
  const settings = useAtomValue(settingsAtom);
  const [busy, setBusy] = useState(benchProgress.running);

  const perfActive = isPerfEnabled();

  const handleRun = useCallback(() => {
    setIsOpen(false); // MUST come first — see above.
    setBusy(true);
    // No requestAnimationFrame deferral: React flushes the close before the next
    // paint, and the runner counts RENDERED frames (perf.renderedFrames), so it
    // synchronises itself. An rAF wrapper here only adds a failure mode — rAF is
    // frozen outright in a hidden tab, which silently swallowed the whole run.
    void getBenchRunner(store)
      .sweep()
      .catch((err) => console.error(err))
      .finally(() => setBusy(false));
  }, [store, setIsOpen]);

  if (!perfActive) {
    return (
      <div className="dev-controls__section">
        <div className="dev-controls__label">perf sweep</div>
        <div className="dev-controls__hint">
          {settings.perf
            ? "enabled — reload the page to arm GPU timers"
            : "turn on “perf profiler” above, then reload"}
        </div>
      </div>
    );
  }

  return (
    <div className="dev-controls__section">
      <div className="dev-controls__label">perf sweep — ~2 min, closes this menu</div>
      <div className="dev-controls__row">
        <button
          className="settings-menu__button settings-menu__button--subtle"
          onClick={handleRun}
          disabled={busy}
        >
          {busy ? "running…" : "run perf sweep"}
        </button>
      </div>
      <div className="dev-controls__hint">
        Don&apos;t touch the controls while it runs. Progress shows in the perf
        overlay; the result prints to the console and is copied to the clipboard
        (also at <code>__bench.lastJson</code>).
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dev-only controls (position teleport + max speed override)
// ---------------------------------------------------------------------------

const RESOURCE_IDS = [
  "silicates",
  "fe_ni_metal",
  "carbon",
  "sulfur",
  "hydrates",
  "titanium",
  "helium_3",
] as const;

function DevControls({
  onTeleport,
  onSetMaxSpeed,
  currentMaxSpeedOverride,
  exposureStops,
  onSetExposureStops,
  onGrantAssay,
  onGrantCargo,
  onUnlockAllResearch,
  onGrantAllItems,
  onResetProgress,
  onResetComms,
}: {
  onTeleport: (x: number, y: number, z: number) => void;
  onSetMaxSpeed: (speed: number | null) => void;
  currentMaxSpeedOverride: number | null;
  exposureStops: number;
  onSetExposureStops: (stops: number) => void;
  onGrantAssay: (amount: number) => void;
  onGrantCargo: (resourceId: string, amount: number) => void;
  onUnlockAllResearch: () => void;
  onGrantAllItems: () => void;
  onResetProgress: () => void;
  onResetComms: () => void;
}) {
  const [posX, setPosX] = useState("");
  const [posY, setPosY] = useState("");
  const [posZ, setPosZ] = useState("");
  const [speedUnit, setSpeedUnit] = useAtom(devSpeedUnitAtom);
  const [speedVal, setSpeedVal] = useState(
    currentMaxSpeedOverride !== null
      ? String(currentMaxSpeedOverride / SPEED_UNIT_TO_MPS[speedUnit])
      : ""
  );

  const [selectedResource, setSelectedResource] = useState<string>(RESOURCE_IDS[0]);
  const [resourceAmount, setResourceAmount] = useState("500");
  const [assayAmount, setAssayAmount] = useState("500");

  const handleLoadCurrent = () => {
    const saved = loadShipState();
    if (saved) {
      setPosX(String(Math.round(saved.positionKm[0] * 100) / 100));
      setPosY(String(Math.round(saved.positionKm[1] * 100) / 100));
      setPosZ(String(Math.round(saved.positionKm[2] * 100) / 100));
    }
  };

  const handleTeleport = () => {
    const x = parseFloat(posX);
    const y = parseFloat(posY);
    const z = parseFloat(posZ);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    onTeleport(x, y, z);
  };

  const handleUnitChange = (newUnit: SpeedUnit) => {
    const v = parseFloat(speedVal);
    if (Number.isFinite(v) && v > 0) {
      const mps = v * SPEED_UNIT_TO_MPS[speedUnit];
      setSpeedVal(String(mps / SPEED_UNIT_TO_MPS[newUnit]));
    }
    setSpeedUnit(newUnit);
  };

  const handleSpeedApply = () => {
    const v = parseFloat(speedVal);
    if (!speedVal.trim()) {
      onSetMaxSpeed(null);
      return;
    }
    if (!Number.isFinite(v) || v <= 0) return;
    onSetMaxSpeed(v * SPEED_UNIT_TO_MPS[speedUnit]);
  };

  const handleGrantCargo = () => {
    const amt = parseInt(resourceAmount, 10);
    if (!Number.isFinite(amt) || amt <= 0) return;
    onGrantCargo(selectedResource, amt);
  };

  const handleGrantAllCargo = () => {
    const amt = parseInt(resourceAmount, 10) || 500;
    for (const id of RESOURCE_IDS) {
      onGrantCargo(id, amt);
    }
  };

  const handleGrantAssay = () => {
    const amt = parseInt(assayAmount, 10);
    if (!Number.isFinite(amt) || amt <= 0) return;
    onGrantAssay(amt);
  };

  return (
    <div className="dev-controls">
      {/* Exposure — docs/LIGHTING_PLAN.md §3.4. Compensation in STOPS on top of
          the metered exposure; +1 = twice as bright. 0 is the calibrated neutral,
          and this same knob survives into Phase 5's auto-exposure unchanged. */}
      <div className="dev-controls__section">
        <div className="dev-controls__label">
          exposure {exposureStops > 0 ? "+" : ""}
          {exposureStops.toFixed(2)} stops
          {exposureStops === 0 ? " (neutral)" : ` — ×${(2 ** exposureStops).toPrecision(3)}`}
        </div>
        <div className="dev-controls__row">
          <input
            className="dev-controls__range"
            type="range"
            min={-8}
            max={8}
            step={0.25}
            value={exposureStops}
            onChange={(e) => onSetExposureStops(Number(e.target.value))}
          />
          <button
            className="settings-menu__button settings-menu__button--subtle"
            onClick={() => onSetExposureStops(0)}
          >
            reset
          </button>
        </div>
      </div>

      {/* Teleport */}
      <div className="dev-controls__section">
        <div className="dev-controls__label">teleport (km)</div>
        <div className="dev-controls__row">
          <input
            className="dev-controls__input"
            type="number"
            placeholder="X"
            value={posX}
            onChange={(e) => setPosX(e.target.value)}
          />
          <input
            className="dev-controls__input"
            type="number"
            placeholder="Y"
            value={posY}
            onChange={(e) => setPosY(e.target.value)}
          />
          <input
            className="dev-controls__input"
            type="number"
            placeholder="Z"
            value={posZ}
            onChange={(e) => setPosZ(e.target.value)}
          />
        </div>
        <div className="dev-controls__row">
          <button
            className="settings-menu__button settings-menu__button--subtle"
            onClick={handleLoadCurrent}
          >
            load current
          </button>
          <button
            className="settings-menu__button settings-menu__button--subtle"
            onClick={handleTeleport}
          >
            teleport
          </button>
        </div>
      </div>

      {/* Max speed */}
      <div className="dev-controls__section">
        <div className="dev-controls__label">max speed -- default: 400 m/s</div>
        <div className="dev-controls__row">
          <input
            className="dev-controls__input dev-controls__input--wide"
            type="number"
            placeholder={String(400 / SPEED_UNIT_TO_MPS[speedUnit])}
            value={speedVal}
            onChange={(e) => setSpeedVal(e.target.value)}
          />
          <select
            className="dev-controls__select"
            value={speedUnit}
            onChange={(e) => handleUnitChange(e.target.value as SpeedUnit)}
          >
            <option value="m/s">m/s</option>
            <option value="km/s">km/s</option>
            <option value="AU/s">AU/s</option>
          </select>
          <button
            className="settings-menu__button settings-menu__button--subtle"
            onClick={handleSpeedApply}
          >
            {speedVal.trim() ? "apply" : "reset"}
          </button>
        </div>
      </div>

      {/* Grant cargo */}
      <div className="dev-controls__section">
        <div className="dev-controls__label">grant cargo</div>
        <div className="dev-controls__row">
          <select
            className="dev-controls__select"
            value={selectedResource}
            onChange={(e) => setSelectedResource(e.target.value)}
          >
            {RESOURCE_IDS.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
          <input
            className="dev-controls__input dev-controls__input--wide"
            type="number"
            placeholder="500"
            value={resourceAmount}
            onChange={(e) => setResourceAmount(e.target.value)}
          />
          <button
            className="settings-menu__button settings-menu__button--subtle"
            onClick={handleGrantCargo}
          >
            add
          </button>
        </div>
        <div className="dev-controls__row">
          <button
            className="settings-menu__button settings-menu__button--subtle"
            onClick={handleGrantAllCargo}
          >
            grant all resources
          </button>
        </div>
      </div>

      {/* Grant assay samples */}
      <div className="dev-controls__section">
        <div className="dev-controls__label">assay samples</div>
        <div className="dev-controls__row">
          <input
            className="dev-controls__input dev-controls__input--wide"
            type="number"
            placeholder="500"
            value={assayAmount}
            onChange={(e) => setAssayAmount(e.target.value)}
          />
          <button
            className="settings-menu__button settings-menu__button--subtle"
            onClick={handleGrantAssay}
          >
            add
          </button>
        </div>
      </div>

      {/* Progression cheats */}
      <div className="dev-controls__section">
        <div className="dev-controls__label">progression</div>
        <div className="dev-controls__row dev-controls__row--wrap">
          <button
            className="settings-menu__button settings-menu__button--subtle"
            onClick={onUnlockAllResearch}
          >
            unlock all research
          </button>
          <button
            className="settings-menu__button settings-menu__button--subtle"
            onClick={onGrantAllItems}
          >
            grant all items
          </button>
          <button
            className="settings-menu__button settings-menu__button--subtle"
            onClick={onResetComms}
          >
            reset comms
          </button>
          <button
            className="settings-menu__button settings-menu__button--danger"
            onClick={onResetProgress}
          >
            reset progress
          </button>
        </div>
      </div>
    </div>
  );
}

const SettingsMenu = () => {
  const [settings, setSettings] = useAtom(settingsAtom);
  const [isOpen, setIsOpen] = useAtom(settingsIsOpenAtom);
  const [activeSubMenu, setActiveSubMenu] = useState<SubMenu | null>(null);
  const gpu = useDetectGPU();
  const deltaStore = useAsteroidDeltaStore();

  const keybinds = useAtomValue(keybindsAtom);
  const resetKeybinds = useSetAtom(resetKeybindsAtom);

  const setDevTeleport = useSetAtom(devTeleportAtom);
  const [devMaxSpeed, setDevMaxSpeed] = useAtom(devMaxSpeedOverrideAtom);
  const setAddAssay = useSetAtom(addAssaySamplesAtom);
  const setAddCargo = useSetAtom(addCargoAtom);
  const [, setResearch] = useAtom(researchAtom);
  const [, setModules] = useAtom(modulesAtom);
  const setAddCraftedItem = useSetAtom(addCraftedItemAtom);
  const resetComms = useSetAtom(resetCommsPlayedAtom);

  const availableSubMenus = useMemo(
    () =>
      Object.values(SubMenu).filter(
        (s) => s !== SubMenu.Dev || IS_DEV
      ),
    []
  );

  const devHandlers = useMemo(
    () =>
      IS_DEV
        ? {
            onTeleport: (x: number, y: number, z: number) =>
              setDevTeleport({ positionKm: [x, y, z] }),
            onSetMaxSpeed: (speed: number | null) => setDevMaxSpeed(speed),
            currentMaxSpeedOverride: devMaxSpeed,
            // `?? 0` is load-bearing: `atomWithStorage` REPLACES the default with
            // whatever is in localStorage, it does not merge. Any player who
            // opened Settings before this field existed has a stored object
            // without it, so this reads `undefined` and the slider's
            // `.toFixed()` would throw. Same hazard as the hydration trap noted
            // in the comms store.
            exposureStops: settings.exposureStops ?? 0,
            onSetExposureStops: (stops: number) =>
              setSettings((prev) => ({ ...prev, exposureStops: stops })),
            onGrantAssay: (amount: number) => setAddAssay(amount),
            onGrantCargo: (resourceId: string, amount: number) =>
              setAddCargo({ resourceId, amount }),
            onUnlockAllResearch: () => {
              const allIds = RESEARCH_NODES.map((n) => n.id);
              setResearch((prev) => ({
                ...prev,
                completedNodes: allIds,
                activeResearch: null,
                assaySamples: prev.assaySamples + 9999,
              }));
            },
            onGrantAllItems: () => {
              for (const item of ITEMS) {
                if (item.type === "consumable") {
                  for (let i = 0; i < 5; i++) setAddCraftedItem(item.id);
                } else {
                  setAddCraftedItem(item.id);
                }
              }
            },
            onResetProgress: () => {
              setResearch({
                assaySamples: 0,
                completedNodes: [],
                activeResearch: null,
              });
              setModules({
                ownedModules: [],
                equippedModules: {},
                consumables: {},
                consumableCooldowns: {},
                hotbar: Array(10).fill(null),
              });
            },
            onResetComms: () => resetComms(),
          }
        : undefined,
    [setDevTeleport, setDevMaxSpeed, devMaxSpeed, settings.exposureStops, setSettings, setAddAssay, setAddCargo, setResearch, setAddCraftedItem, setModules, resetComms]
  );

  const handleResetKeybinds = useCallback(() => {
    resetKeybinds();
  }, [resetKeybinds]);

  const handleResetWorld = useCallback(() => {
    if (!window.confirm("Reset asteroid field? All mining progress will be lost.")) return;
    deltaStore.clearAll();
    clearShipState();
    localStorage.removeItem("ship-config-v1");
    localStorage.removeItem("cargo");
    localStorage.removeItem("keybinds-v1");
    localStorage.removeItem("research-v1");
    localStorage.removeItem("modules-v1");
    localStorage.removeItem("modules-v2");
    localStorage.removeItem("asteroids-mined-lifetime-v1");
    window.location.reload();
  }, [deltaStore]);

  useEffect(() => {
    const storedSettings = JSON.parse(
      localStorage.getItem("settings") ?? '{"initial": true}'
    );
    if (storedSettings.initial === true) {
      // Both bloom and AgX now default ON (store.ts), so this first-run pass only
      // has to STEP DOWN on weak hardware. Bloom is a real cost — a 15-context mip
      // chain measured at 1.8–2.0 ms (docs/PERF_MEASUREMENT.md) — so drop it below
      // tier 2. Tone mapping is NOT stepped down: swapping AgX for Neutral is not a
      // perf win (same single curve evaluation), it just picks a worse curve.
      setSettings((prev) => ({
        ...prev,
        bloom: gpu.tier >= 2,
        initial: false,
      }));
    }
  }, []);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    setActiveSubMenu(null);
  }, [setIsOpen]);

  const toggleMenu = useCallback(() => setIsOpen((prev) => !prev), [setIsOpen]);

  // Hotkey handler: when closed, toggle key opens settings. When open, Panel
  // handles Esc / backdrop close.
  const keybindsRef = useRef(keybinds);
  keybindsRef.current = keybinds;
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isOpenRef.current) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const key = e.key.toLowerCase();
      if (keybindsRef.current.toggleSettings.includes(key)) {
        setIsOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setIsOpen]);

  const title = activeSubMenu
    ? activeSubMenu.charAt(0).toUpperCase() + activeSubMenu.slice(1)
    : "Settings";
  const eyebrow = activeSubMenu ? "Settings" : undefined;

  return (
    <>
      <button
        className="settings__open-button"
        onClick={toggleMenu}
        aria-label="Open settings"
      >
        <SettingsIcon size={16} strokeWidth={1.75} aria-hidden />
      </button>

      {isOpen && (
        <Panel
          title={title}
          eyebrow={eyebrow}
          tier={2}
          width={560}
          onClose={handleClose}
          secondaryAction={
            activeSubMenu
              ? {
                  label: "Back",
                  icon: <ChevronLeft size={14} strokeWidth={1.75} aria-hidden />,
                  variant: "subtle",
                  onClick: () => setActiveSubMenu(null),
                }
              : undefined
          }
        >
          <div className="settings-menu">
            {!activeSubMenu ? (
              <div className="settings-menu__nav">
                {availableSubMenus.map((subMenu) => (
                  <button
                    key={subMenu}
                    className="settings-menu__button"
                    onClick={() => setActiveSubMenu(subMenu)}
                  >
                    {subMenu}
                  </button>
                ))}
              </div>
            ) : (
              <div className="settings-menu__content">
                {renderSubMenu(
                  activeSubMenu,
                  settings,
                  setSettings,
                  handleResetWorld,
                  handleResetKeybinds,
                  devHandlers
                )}
              </div>
            )}
          </div>
        </Panel>
      )}
    </>
  );
};

export default SettingsMenu;
