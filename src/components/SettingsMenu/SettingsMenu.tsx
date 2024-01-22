import { useState } from "react";
import "./SettingsMenu.scss";

enum SubMenu {
  Graphics = "graphics",
  Controls = "controls",
  Dev = "dev",
}

const renderSubMenu = (subMenu: SubMenu) => {
  switch (subMenu) {
    case SubMenu.Graphics:
      return (
        <>
          <button className="settings__menu-button">bloom</button>
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
                {renderSubMenu(activeSubMenu)}
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
