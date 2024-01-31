import "./HUD.scss";
import { useAtomValue } from "jotai";
import { hudInfoAtom, movementAtom } from "@/store/store";

const HUD = () => {
  const movement = useAtomValue(movementAtom);
  const hudInfo = useAtomValue(hudInfoAtom);

  return (
    <div className="hud">
      <span>target:</span>
      <span>{Math.round(movement.speed * 100)}%</span>
      <span>speed:</span>
      <span>{Math.round(hudInfo.speed)} m/s</span>
    </div>
  );
};

export default HUD;
