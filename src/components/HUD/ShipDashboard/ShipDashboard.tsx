import "./ShipDashboard.scss";
import { useAtomValue } from "jotai";
import { useEffect, useState, type ReactNode } from "react";
import { Droplet, Wind, Wrench } from "lucide-react";
import { hudInfoAtom, shipHealthAtom } from "@/store/store";
import { effectiveShipConfigAtom } from "@/store/shipConfig";
import { formatSpeed } from "@/sim/units";
import { shipResourcesHudAtom } from "@/store/shipResources";
import { hullDisplayPct } from "@/sim/ship/hull";
import { collisionsOffReason } from "@/sim/physics/nearField";
import { devTuningActive } from "@/store/devTuning";

const COLLISIONS_OFF_TEXT = { loading: "physics loading", unavailable: "physics unavailable", "dev-speed": "dev speed", "over-speed": "over speed" } as const;

/** B2: asteroid collisions can silently stop (engine loading/failed, dev speed) and dev tuning can persist; say so. 4 Hz. */
function useSilentOverrides(): { collisionsOff: ReturnType<typeof collisionsOffReason>; devTuning: boolean } {
  const [collisionsOff, setCollisionsOff] = useState(collisionsOffReason);
  const [devTuning, setDevTuning] = useState(devTuningActive);
  useEffect(() => {
    const t = setInterval(() => {
      setCollisionsOff(collisionsOffReason());
      setDevTuning(devTuningActive());
    }, 250);
    return () => clearInterval(t);
  }, []);
  return { collisionsOff, devTuning };
}

/** Ordinary fuel below this fraction of the tank reads as a warning. */
const LOW_FUEL_FRAC = 0.15;
/** The heat level where processing and repair start to throttle (tick on the bar). */
const HEAT_TICK = 0.8;

type Tone = "" | "warn" | "crit";

function Row({ label, value, tone = "", bar, title }: { label: string; value: ReactNode; tone?: Tone; bar?: ReactNode; title?: string }) {
  return (
    <div className="ship-dashboard__row" title={title}>
      <span className="ship-dashboard__label">{label}</span>
      <span className={`ship-dashboard__value${tone ? ` ship-dashboard__value--${tone}` : ""}`}>{value}</span>
      <span className="ship-dashboard__bar">{bar}</span>
    </div>
  );
}

/**
 * Ship state, bottom-right (§2.5): fixed width, fixed rows, one status line. The HEAT row is the
 * ship's only heat display (one thermal store); hull rounds down so 99.7 never reads 100.
 */
const ShipDashboard = () => {
  const hudInfo = useAtomValue(hudInfoAtom);
  const shipHealth = useAtomValue(shipHealthAtom);
  const cfg = useAtomValue(effectiveShipConfigAtom);
  const res = useAtomValue(shipResourcesHudAtom);
  const { collisionsOff, devTuning } = useSilentOverrides();

  const healthPct = cfg.maxHealth > 0 ? shipHealth / cfg.maxHealth : 0;
  const hullTone: Tone = healthPct <= 0.2 ? "crit" : healthPct <= 0.5 ? "warn" : "";

  const limit = hudInfo.speedLimit > 0 ? hudInfo.speedLimit : 1;
  const speedPct = Math.min(100, (hudInfo.speed / limit) * 100);
  const setPct = Math.min(100, (hudInfo.setPointSpeed / limit) * 100);

  const onReserve = res.ordinaryKg <= 0;
  const empty = onReserve && res.protectedKg <= 0;
  const lowFuel = res.ordinaryKg < res.tankKg * LOW_FUEL_FRAC;
  const fuelTone: Tone = onReserve ? "crit" : lowFuel ? "warn" : "";
  const fuelPct = Math.min(100, (res.ordinaryKg / res.tankKg) * 100);
  const reservePct = Math.min(100, (res.protectedKg / res.allowanceKg) * 100);
  const heatTone: Tone = res.overTemp || res.heatThrottling ? "crit" : res.heatWarn ? "warn" : "";
  const powerShort = res.powerDemand01 > 1.0001;

  // One slot, highest priority first (§1.3): the fuel warning and the resource reason never stack.
  // Dev tuning (dev builds) outranks the routine fuel lines so a stored edit cannot hide behind them.
  const status: { text: string; tone: Tone; id: string } | null = collisionsOff
    ? { text: `Collisions off · ${COLLISIONS_OFF_TEXT[collisionsOff]}`, tone: "crit", id: "collisions-off" }
    : empty ? { text: "No fuel · Esc › Respawn", tone: "crit", id: "fuel-warning" }
    : res.reason ? { text: res.reason, tone: res.overTemp || res.reason === "Thrust offline" ? "crit" : "warn", id: "ship-reason" }
    : devTuning ? { text: "Dev tuning active", tone: "warn", id: "dev-tuning" }
    : onReserve ? { text: "Reserve in use", tone: "crit", id: "fuel-warning" }
    : lowFuel ? { text: "Fuel low", tone: "warn", id: "fuel-warning" }
    : null;

  return (
    <div className="ship-dashboard" data-testid="ship-dashboard">
      <Row
        label="SPEED"
        value={formatSpeed(hudInfo.speed)}
        bar={
          <span className="ship-dashboard__track">
            <span className="ship-dashboard__fill ship-dashboard__fill--speed" style={{ width: `${speedPct}%` }} />
            {!hudInfo.decoupled && <span className="ship-dashboard__tick ship-dashboard__tick--set" style={{ left: `${setPct}%` }} />}
          </span>
        }
      />
      <Row label={hudInfo.decoupled ? "ASSIST" : ""} value={hudInfo.decoupled ? "DECOUPLED" : ""} tone="warn" />
      <Row
        label="FUEL"
        value={
          <>
            {res.drive === "air" && (
              <Wind size={11} strokeWidth={2} aria-label="breathing air" className="ship-dashboard__icon ship-dashboard__icon--air" data-testid="drive-air" />
            )}
            {res.drive === "water" && (
              <Droplet
                size={11} strokeWidth={2} aria-label={`burning water ×${res.driveMult.toFixed(0)}`}
                className="ship-dashboard__icon ship-dashboard__icon--water" data-testid="drive-water"
                style={{ animationDuration: `${(1.6 / Math.max(1, Math.log2(res.driveMult) + 1)).toFixed(2)}s` }}
              />
            )}
            {empty ? "EMPTY" : onReserve ? `RSV ${res.protectedKg.toFixed(0)} kg` : `${res.ordinaryKg.toFixed(0)} kg`}
          </>
        }
        tone={fuelTone}
        bar={
          <span className="ship-dashboard__fuel">
            <span className="ship-dashboard__track">
              <span className={`ship-dashboard__fill${fuelTone ? " ship-dashboard__fill--warn" : ""}`} style={{ width: `${fuelPct}%` }} />
            </span>
            <span className="ship-dashboard__track" title="Reserve">
              <span className="ship-dashboard__fill ship-dashboard__fill--reserve" style={{ width: `${reservePct}%` }} />
            </span>
          </span>
        }
      />
      <Row
        label="HEAT"
        value={`${Math.round(res.heat01 * 100)}%`}
        tone={heatTone}
        bar={
          <span className="ship-dashboard__track">
            <span className={`ship-dashboard__fill${heatTone ? " ship-dashboard__fill--warn" : ""}`} style={{ width: `${Math.min(100, res.heat01 * 100)}%` }} />
            <span className="ship-dashboard__tick ship-dashboard__tick--heat" style={{ left: `${HEAT_TICK * 100}%` }} title="Throttles above 80 %" />
          </span>
        }
      />
      <Row label="POWER" value={powerShort ? "MAX" : `${Math.round(Math.min(1, res.powerUsed01) * 100)}%`} tone={powerShort ? "warn" : ""} />
      <Row label="BOOST" value={hudInfo.boostCharge >= 1 ? "ready" : `${Math.round(hudInfo.boostCharge * 100)}%`} />
      <Row
        label="HULL"
        value={
          <>
            {res.repairing && <Wrench size={11} strokeWidth={2} aria-label="repairing" className="ship-dashboard__icon" />}
            {hullDisplayPct(shipHealth, cfg.maxHealth)}%
          </>
        }
        tone={hullTone}
      />
      <div className={`ship-dashboard__status${status?.tone ? ` ship-dashboard__status--${status.tone}` : ""}`} data-testid={status?.id}>
        {status?.text ?? ""}
      </div>
    </div>
  );
};

export default ShipDashboard;
