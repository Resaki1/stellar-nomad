import "./ShipDashboard.scss";
import { useAtomValue } from "jotai";
import { hudInfoAtom, shipHealthAtom } from "@/store/store";
import { effectiveShipConfigAtom } from "@/store/shipConfig";
import { formatSpeed } from "@/sim/units";

const ShipDashboard = () => {
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

  const limit = hudInfo.speedLimit > 0 ? hudInfo.speedLimit : 1;
  const speedPct = Math.min(100, (hudInfo.speed / limit) * 100);
  const setPct = Math.min(100, (hudInfo.setPointSpeed / limit) * 100);

  return (
    <div className="ship-dashboard">
      <span>target:</span>
      <span>{hudInfo.decoupled ? "manual" : formatSpeed(hudInfo.setPointSpeed)}</span>
      <span>speed:</span>
      <span>{formatSpeed(hudInfo.speed)}</span>
      <div className="ship-dashboard__throttle" aria-hidden>
        <div className="ship-dashboard__throttle-fill" style={{ width: `${speedPct}%` }} />
        {!hudInfo.decoupled && <div className="ship-dashboard__throttle-set" style={{ left: `${setPct}%` }} />}
      </div>
      <span>assist:</span>
      <span>{hudInfo.decoupled ? "DECOUPLED" : "COUPLED"}</span>
      <span>boost:</span>
      <span>{Math.round(hudInfo.boostCharge * 100)}%</span>
      <span>health:</span>
      <span className={healthClass}>{Math.round(healthPct * 100)}%</span>
    </div>
  );
};

export default ShipDashboard;
