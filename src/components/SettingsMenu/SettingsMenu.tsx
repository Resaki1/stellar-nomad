import { useState } from "react";
import "./SettingsMenu.scss";

const SettingsMenu = () => {
  const [isOpen, setIsOpen] = useState(false);

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
            <button className="settings__menu-button">graphics</button>
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
