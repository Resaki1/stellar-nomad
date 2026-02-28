import { useEffect, useState, useCallback, useRef } from "react";
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
import { clearShipState } from "@/sim/shipPersistence";

enum SubMenu {
  Graphics = "graphics",
  Controls = "controls",
  Dev = "dev",
}

const renderSubMenu = (
  subMenu: SubMenu,
  settings: Settings,
  setSettings: SetAtom<[SetStateAction<Settings>], void>,
  onResetWorld?: () => void,
  onResetKeybinds?: () => void
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
            label="filmic tone mapping"
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

const SettingsMenu = () => {
  const [settings, setSettings] = useAtom(settingsAtom);
  const [isOpen, setIsOpen] = useAtom(settingsIsOpenAtom);
  const [activeSubMenu, setActiveSubMenu] = useState<SubMenu | null>(null);
  const gpu = useDetectGPU();
  const deltaStore = useAsteroidDeltaStore();

  const keybinds = useAtomValue(keybindsAtom);
  const resetKeybinds = useSetAtom(resetKeybindsAtom);

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
                {Object.values(SubMenu).map((subMenu) => (
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
                  handleResetKeybinds
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
