import { useState } from "react";
import "./SettingsMenu.scss";
import { SetStateAction, useAtom } from "jotai";
import { SetAtom, Settings, settingsAtom } from "@/store/store";

enum SubMenu {
  Graphics = "graphics",
  Controls = "controls",
  Dev = "dev",
}

const renderSubMenu = (
  subMenu: SubMenu,
  settings: Settings,
  setSettings: SetAtom<[SetStateAction<Settings>], void>
) => {
  switch (subMenu) {
    case SubMenu.Graphics:
      return (
        <>
          <button
            className="settings__menu-button"
            onClick={() =>
              setSettings((prev) => ({ ...prev, bloom: !prev.bloom }))
            }
          >
            bloom
          </button>
          <button
            className="settings__menu-button"
            onClick={() =>
              setSettings((prev) => ({
                ...prev,
                toneMapping: !prev.toneMapping,
              }))
            }
          >
            filmic tone mapping
          </button>
        </>
      );
    case SubMenu.Controls:
      return (
        <>
          <button
            className="settings__menu-button"
            onClick={() =>
              setSettings((prev) => ({
                ...prev,
                invertPitch: !prev.invertPitch,
              }))
            }
          >
            invert pitch
          </button>
        </>
      );
    case SubMenu.Dev:
      return (
        <>
          <button className="settings__menu-button">stats</button>
        </>
      );
  }
};

const SettingsMenu = () => {
  const [settings, setSettings] = useAtom(settingsAtom);
  const [isOpen, setIsOpen] = useState(false);
  const [activeSubMenu, setActiveSubMenu] = useState<SubMenu | null>(null);

  const toggleMenu = () => setIsOpen(!isOpen);
  const closeMenu = () => setIsOpen(false);

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
                {renderSubMenu(activeSubMenu, settings, setSettings)}
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
