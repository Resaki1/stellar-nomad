import TouchControls from "./TouchControls/TouchControls";
import KeyboardControls from "./KeyboardControls/KeyboardControls";
import "./Navigation.scss";

const Navigation = () => {
  const isTouchDevice = window.matchMedia("(pointer: coarse)").matches;

  return (
    <div className="navigation">
      {isTouchDevice ? <TouchControls /> : <KeyboardControls />}
    </div>
  );
};

export default Navigation;
