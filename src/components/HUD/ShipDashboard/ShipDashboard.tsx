import "./ShipDashboard.scss";
import { useAtomValue } from "jotai";
import { hudInfoAtom, movementAtom, shipHealthAtom } from "@/store/store";

const ShipDashboard = () => {
  const movement = useAtomValue(movementAtom);
  const hudInfo = useAtomValue(hudInfoAtom);
  const shipHealth = useAtomValue(shipHealthAtom);

  return (
    <div className="ship-dashboard">
      <span>target:</span>
      <span>{Math.round(movement.speed * 100)}%</span>
      <span>speed:</span>
      <span>{Math.round(hudInfo.speed)} m/s</span>
      <span>health:</span>
      <span>{Math.round(shipHealth)}%</span>
    </div>
  );
};

export default ShipDashboard;
