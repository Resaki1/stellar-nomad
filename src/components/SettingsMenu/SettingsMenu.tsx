import { useState } from "react";
import "./SettingsMenu.scss";
import { SetStateAction, useAtom } from "jotai";
import {
  SetAtom,
  Settings,
  bloomAtom,
  settingsAtom,
  toneMappingAtom,
} from "@/store/store";

enum SubMenu {
  Graphics = "graphics",
  Controls = "controls",
  Dev = "dev",
}

const renderSubMenu = (
  subMenu: SubMenu,
  bloom: boolean,
  toneMapping: boolean,
  setBloom: SetAtom<[SetStateAction<boolean>], void>,
  setToneMapping: SetAtom<[SetStateAction<boolean>], void>
) => {
  switch (subMenu) {
    case SubMenu.Graphics:
      return (
        <>
          <button
            className="settings__menu-button"
            onClick={() => setBloom(!bloom)}
          >
            bloom
          </button>
          <button
            className="settings__menu-button"
            onClick={() => setToneMapping(!toneMapping)}
          >
            filmic tone mapping
          </button>
        </>
      );
    case SubMenu.Controls:
      return (
        <>
          <button className="settings__menu-button">invert</button>
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
  const [bloom, setBloom] = useAtom(bloomAtom);
  const [toneMapping, setToneMapping] = useAtom(toneMappingAtom);
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
                {renderSubMenu(
                  activeSubMenu,
                  bloom,
                  toneMapping,
                  setBloom,
                  setToneMapping
                )}
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
