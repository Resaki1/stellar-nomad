import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import "./SettingsMenu.scss";
import { SetStateAction, useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  SetAtom,
  Settings,
  settingsAtom,
  settingsIsOpenAtom,
} from "@/store/store";
import SettingsCheckbox from "./SettingsCheckbox/SettingsCheckbox";
import KeybindRow from "./KeybindRow/KeybindRow";
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
      // Group keybind actions by category
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
              className="settings__menu-button settings__menu-button--subtle"
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
          {devHandlers && <DevControls {...devHandlers} />}
          {onResetWorld && (
            <button
              className="settings__menu-button settings__menu-button--danger"
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
// Dev-only controls (position teleport + max speed override)
// ---------------------------------------------------------------------------

function DevControls({
  onTeleport,
  onSetMaxSpeed,
  currentMaxSpeedOverride,
}: {
  onTeleport: (x: number, y: number, z: number) => void;
  onSetMaxSpeed: (speed: number | null) => void;
  currentMaxSpeedOverride: number | null;
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

  return (
    <div className="dev-controls">
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
            className="settings__menu-button settings__menu-button--subtle"
            onClick={handleLoadCurrent}
          >
            load current
          </button>
          <button
            className="settings__menu-button settings__menu-button--subtle"
            onClick={handleTeleport}
          >
            teleport
          </button>
        </div>
      </div>
      <div className="dev-controls__section">
        <div className="dev-controls__label">max speed — default: 400 m/s</div>
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
            className="settings__menu-button settings__menu-button--subtle"
            onClick={handleSpeedApply}
          >
            {speedVal.trim() ? "apply" : "reset"}
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

  // Dev-only atoms
  const setDevTeleport = useSetAtom(devTeleportAtom);
  const [devMaxSpeed, setDevMaxSpeed] = useAtom(devMaxSpeedOverrideAtom);

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
              setDevTeleport([x, y, z]),
            onSetMaxSpeed: (speed: number | null) => setDevMaxSpeed(speed),
            currentMaxSpeedOverride: devMaxSpeed,
          }
        : undefined,
    [setDevTeleport, setDevMaxSpeed, devMaxSpeed]
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
    window.location.reload();
  }, [deltaStore]);

  useEffect(() => {
    const storedSettings = JSON.parse(
      localStorage.getItem("settings") ?? '{"initial": true}'
    );
    if (storedSettings.initial === true) {
      if (gpu.tier >= 2) {
        setSettings((prev) => ({
          ...prev,
          bloom: true,
          initial: false,
        }));
      }

      if (gpu.tier >= 3) {
        setSettings((prev) => ({
          ...prev,
          bloom: true,
          toneMapping: true,
          initial: false,
        }));
      }
    }
  }, []);

  const toggleMenu = useCallback(() => setIsOpen((prev) => !prev), [setIsOpen]);

  // Settings toggle hotkey — reads from keybinds store
  const keybindsRef = useRef(keybinds);
  keybindsRef.current = keybinds;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const key = e.key.toLowerCase();
      if (keybindsRef.current.toggleSettings.includes(key)) {
        toggleMenu();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleMenu]);

  return (
    <>
      <button className="settings__open-button" onClick={toggleMenu}>
        I I
      </button>

      {isOpen && (
        <div className="settings" onClick={() => setIsOpen(false)}>
          <div className="settings__menu" onClick={(e) => e.stopPropagation()}>
            <h2 className="settings__menu-title">
              {activeSubMenu ?? "settings"}
            </h2>
            {!activeSubMenu ? (
              <>
                {availableSubMenus.map((subMenu) => (
                  <button
                    key={subMenu}
                    className="settings__menu-button"
                    onClick={() => setActiveSubMenu(subMenu)}
                  >
                    {subMenu}
                  </button>
                ))}
              </>
            ) : (
              <>
                <button
                  className="settings__menu-button settings__menu-button--back"
                  onClick={() => setActiveSubMenu(null)}
                >
                  {"<"} back
                </button>
                {renderSubMenu(
                  activeSubMenu,
                  settings,
                  setSettings,
                  handleResetWorld,
                  handleResetKeybinds,
                  devHandlers
                )}
              </>
            )}

            <button
              className="settings__menu-button"
              onClick={() => setIsOpen(false)}
            >
              close
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export default SettingsMenu;
