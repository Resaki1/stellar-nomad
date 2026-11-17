import "./ShipDashboard.scss";
import { useAtomValue } from "jotai";
import { hudInfoAtom, shipHealthAtom } from "@/store/store";
import { effectiveShipConfigAtom } from "@/store/shipConfig";
import { formatSpeed } from "@/sim/units";
import { shipResourcesHudAtom } from "@/store/shipResources";
import { glanceAtom } from "@/store/sites";

const fmtKm = (km: number): string => (km < 10 ? `${km.toFixed(1)} km` : km < 100_000 ? `${Math.round(km).toLocaleString("en-US")} km` : `${(km / 1000).toFixed(0)}k km`);

/** Ordinary fuel below this fraction of the tank reads as a warning. */
const LOW_FUEL_FRAC = 0.15;

const ShipDashboard = () => {
  const hudInfo = useAtomValue(hudInfoAtom);
  const shipHealth = useAtomValue(shipHealthAtom);
  const cfg = useAtomValue(effectiveShipConfigAtom);
  const res = useAtomValue(shipResourcesHudAtom);
  const glance = useAtomValue(glanceAtom);

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

  const onReserve = res.ordinaryKg <= 0;
  const empty = onReserve && res.protectedKg <= 0;
  const fuelClass = empty || onReserve
    ? "ship-dashboard__health--critical"
    : res.ordinaryKg < res.tankKg * LOW_FUEL_FRAC
      ? "ship-dashboard__health--warning"
      : "";
  const fuelPct = Math.min(100, (res.ordinaryKg / res.tankKg) * 100);
  const reservePct = Math.min(100, (res.protectedKg / res.allowanceKg) * 100);
  const heatClass = res.overTemp || res.heatThrottling ? "ship-dashboard__health--critical" : res.heatWarn ? "ship-dashboard__health--warning" : "";
  const powerPct = Math.round(Math.min(1, res.powerUsed01) * 100);
  const powerShort = res.powerDemand01 > 1.0001;
  // Fuel/range warning: the ideal transit fuel back to the active point exceeds what is aboard.
  const rec = glance.recovery;
  const showRec = !!rec && (!rec.starter || rec.distKm > 50);
  const returnShort = !!rec && glance.returnKg > 0 && res.ordinaryKg < glance.returnKg;
  const fuelWarn = empty ? "No propellant: abandon ship (Esc menu) recovers you"
    : onReserve ? "On protected allowance: refuel from hydrates"
    : returnShort ? `Short of return to ${rec?.name}: needs ~${glance.returnKg} kg`
    : res.ordinaryKg < res.tankKg * LOW_FUEL_FRAC ? "Propellant low" : null;

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
      <span>fuel:</span>
      <span className={fuelClass}>{empty ? "EMPTY" : onReserve ? `RSV ${res.protectedKg.toFixed(0)} kg` : `${res.ordinaryKg.toFixed(0)} kg`}</span>
      <div className="ship-dashboard__fuel" aria-hidden>
        <div className="ship-dashboard__fuel-tank">
          <div className={`ship-dashboard__fuel-fill ${fuelClass ? "ship-dashboard__fuel-fill--low" : ""}`} style={{ width: `${fuelPct}%` }} />
        </div>
        <div className="ship-dashboard__fuel-reserve" title="protected recovery allowance">
          <div className="ship-dashboard__fuel-reserve-fill" style={{ width: `${reservePct}%` }} />
        </div>
      </div>
      <span>heat:</span>
      <span className={heatClass}>{Math.round(res.heat01 * 100)}%{!res.heatWarn ? ` · ${Math.max(0, Math.round(80 - res.heat01 * 100))} free` : ""}</span>
      <div className="ship-dashboard__heat" aria-hidden>
        <div className={`ship-dashboard__heat-fill ${heatClass ? "ship-dashboard__heat-fill--hot" : ""}`} style={{ width: `${Math.min(100, res.heat01 * 100)}%` }} />
        <div className="ship-dashboard__heat-mark" style={{ left: "80%" }} />
      </div>
      <span>power:</span>
      <span className={powerShort ? "ship-dashboard__health--warning" : ""}>{powerPct}%{powerShort ? " max" : ""}</span>
      <span>boost:</span>
      <span>{hudInfo.boostCharge >= 1 ? "ready" : `${Math.round(hudInfo.boostCharge * 100)}%`}</span>
      <span>health:</span>
      <span className={healthClass}>{Math.round(healthPct * 100)}%{res.repairing ? " +" : ""}</span>
      {showRec && rec && (
        <>
          <span>recovery:</span>
          <span className="ship-dashboard__rec" title="active replication point">{rec.name} · {fmtKm(rec.distKm)}</span>
        </>
      )}
      {fuelWarn && <div className={`ship-dashboard__reason ${empty || onReserve || returnShort ? "ship-dashboard__reason--crit" : ""}`} data-testid="fuel-warning">{fuelWarn}</div>}
      {res.reason && <div className="ship-dashboard__reason">{res.reason}</div>}
    </div>
  );
};

export default ShipDashboard;
