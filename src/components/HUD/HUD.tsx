import "./HUD.scss";
import { useAtomValue } from "jotai";
import { movementAtom } from "@/store/store";

const HUD = () => {
  const movement = useAtomValue(movementAtom);

  return <div className="hud">acc: {Math.round(movement.speed * 100)}%</div>;
};

export default HUD;
