import "./ShipDashboard.scss";
import { useAtomValue } from "jotai";
import { hudInfoAtom, movementAtom, shipHealthAtom } from "@/store/store";
import { effectiveShipConfigAtom } from "@/store/shipConfig";

const ShipDashboard = () => {
  const movement = useAtomValue(movementAtom);
  const hudInfo = useAtomValue(hudInfoAtom);
  const shipHealth = useAtomValue(shipHealthAtom);
  const cfg = useAtomValue(effectiveShipConfigAtom);

  const healthPct = cfg.maxHealth > 0 ? shipHealth / cfg.maxHealth : 0;
  const healthClass =
    healthPct <= 0.2
      ? "ship-dashboard__health--critical"
      : healthPct <= 0.5
        ? "ship-dashboard__health--warning"
        : "";

  return (
    <div className="ship-dashboard">
      <span>target:</span>
      <span>{Math.round(movement.speed * 100)}%</span>
      <span>speed:</span>
      <span>{Math.round(hudInfo.speed)} m/s</span>
      <span>health:</span>
      <span className={healthClass}>{Math.round(healthPct * 100)}%</span>
    </div>
  );
};

export default ShipDashboard;
