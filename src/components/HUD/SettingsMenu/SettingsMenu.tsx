import { useEffect, useState, useCallback } from "react";
import "./SettingsMenu.scss";
import { SetStateAction, useAtom } from "jotai";
import {
  SetAtom,
  Settings,
  settingsAtom,
  settingsIsOpenAtom,
} from "@/store/store";
import SettingsCheckbox from "./SettingsCheckbox/SettingsCheckbox";
import { useHotkeys } from "react-hotkeys-hook";
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
  onResetWorld?: () => void
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
    case SubMenu.Controls:
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
        </>
      );
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

  const handleResetWorld = useCallback(() => {
    if (!window.confirm("Reset asteroid field? All mining progress will be lost.")) return;
    deltaStore.clearAll();
    clearShipState();
    // Force a full reload so the runtime regenerates all chunks from scratch.
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

  const toggleMenu = () => setIsOpen(!isOpen);
  const closeMenu = () => setIsOpen(false);

  useHotkeys("escape", toggleMenu);

  return (
    <>
      <button className="settings__open-button" onClick={toggleMenu}>
        I I
      </button>

      {isOpen && (
        <div className="settings" onClick={closeMenu}>
          <div className="settings__menu" onClick={(e) => e.stopPropagation()}>
            <h2 className="settings__menu-title">
              {activeSubMenu ?? "settings"}
            </h2>
            {!activeSubMenu ? (
              // render main settings menu
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
              // render sub menu
              <>
                <button
                  className="settings__menu-button settings__menu-button--back"
                  onClick={() => setActiveSubMenu(null)}
                >
                  {"<"} back
                </button>
                {renderSubMenu(activeSubMenu, settings, setSettings, handleResetWorld)}
              </>
            )}

            <button className="settings__menu-button" onClick={closeMenu}>
              close
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export default SettingsMenu;
