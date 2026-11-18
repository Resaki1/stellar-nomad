"use client";

import { useAtomValue } from "jotai";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import {
  transitStateAtom,
  transitDriveOwnedAtom,
  transitDriveBuffer,
  transitPreviewAtom,
  type TransitPreview,
} from "@/store/transit";
import { FIXED_DT } from "@/sim/ship/shipConstants";
import { ALREADY_THERE, NEEDS_FUEL, TANK_TOO_SMALL, spoolStepsFor } from "@/sim/ship/transitDrive";
import { KeyChip } from "../shared/Chips";

import "./TransitHUD.scss";

/** `8,412 km` below 10,000 km, `356k km` above. */
export const fmtRouteKm = (km: number): string =>
  km < 10_000 ? `${Math.round(Math.max(0, km)).toLocaleString("en-US")} km` : `${Math.round(km / 1000).toLocaleString("en-US")}k km`;
/** `mm:ss` under an hour, `h:mm` above. */
export function fmtEta(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "--:--";
  const t = Math.ceil(s);
  if (t < 3600) return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
  return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}`;
}
const kg = (x: number): string => `${Math.round(Math.max(0, x)).toLocaleString("en-US")} kg`;

const SPOOL_CIRCUMFERENCE = 2 * Math.PI * 20;
/** DOM text writes from the drive buffer, s (the slots are fixed; only the digits change). */
const WRITE_PERIOD_MS = 100;
/** The `Obstacle` chip stays this long after a proximity brake. */
const OBSTACLE_CHIP_MS = 4000;

function Row({ label, children, valueRef, bad }: { label: string; children?: string; valueRef?: Ref<HTMLSpanElement>; bad?: boolean }) {
  return (
    <div className="transit-hud__row">
      <span className="transit-hud__label">{label}</span>
      <span className={`transit-hud__value${bad ? " transit-hud__status--bad" : ""}`} ref={valueRef}>
        {children}
      </span>
    </div>
  );
}

/**
 * Route panel, top-right (§2.4): fixed width, fixed rows per state (plan / active), tabular
 * fixed-format numbers. Speed lives on the dashboard only (R3); BURN is the trip's fuel, so it
 * cannot be misread as the tank. Distance is written from the drive buffer by a throttled rAF
 * loop into fixed slots (no React per frame); a refusal keeps the last good numbers, greyed.
 */
export default function TransitHUD() {
  const state = useAtomValue(transitStateAtom);
  const owned = useAtomValue(transitDriveOwnedAtom);
  const preview = useAtomValue(transitPreviewAtom);

  const spoolFillRef = useRef<SVGCircleElement>(null);
  const distRef = useRef<HTMLSpanElement>(null);
  const obstacleRef = useRef<HTMLSpanElement>(null);

  // Last accepted numbers for the current destination (a transient refusal keeps them, greyed).
  const [lastGood, setLastGood] = useState<TransitPreview | null>(null);
  useEffect(() => {
    if (preview?.ok) setLastGood(preview);
  }, [preview]);

  useEffect(() => {
    let running = true;
    const spoolSteps = spoolStepsFor(FIXED_DT);
    let lastWrite = 0;
    let seenProximity = transitDriveBuffer.ev.proximity;
    let obstacleUntil = 0;
    const setText = (el: HTMLElement | null, text: string): void => {
      if (el && el.textContent !== text) el.textContent = text;
    };
    const tick = (now: number): void => {
      if (!running) return;
      const buf = transitDriveBuffer;
      if (buf.phase === "spooling" && spoolFillRef.current) {
        const progress = Math.min(1, buf.spoolSteps / spoolSteps);
        spoolFillRef.current.setAttribute("stroke-dasharray", `${progress * SPOOL_CIRCUMFERENCE} ${SPOOL_CIRCUMFERENCE}`);
      }
      if (buf.ev.proximity !== seenProximity) {
        seenProximity = buf.ev.proximity;
        obstacleUntil = now + OBSTACLE_CHIP_MS;
      }
      if (now - lastWrite >= WRITE_PERIOD_MS) {
        lastWrite = now;
        setText(distRef.current, buf.autopilot ? fmtRouteKm(buf.distKm) : "");
        const obstacle = buf.phase !== "idle" && now < obstacleUntil;
        if (obstacleRef.current && obstacleRef.current.hidden === obstacle) obstacleRef.current.hidden = !obstacle;
      }
      requestAnimationFrame(tick);
    };
    const id = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(id);
    };
  }, []);

  if (!owned) return null;

  const phase = state.phase;
  const idle = phase === "idle";
  const spooling = phase === "spooling";
  const route = state.target;
  const plan = preview && (!route || preview.targetId === route.id) ? preview : null;
  const showPanel = idle ? !!plan && plan.reason !== ALREADY_THERE : true;
  // Numbers: the live plan when it is good, else the last good one for the same destination (greyed).
  const nums = plan?.ok ? plan : lastGood && plan && lastGood.targetId === plan.targetId ? lastGood : null;
  // A fuel refusal shows the route's need against the tank in the fixed rows instead of stale numbers.
  const fuelShort = !!plan && !plan.ok && (plan.reason === TANK_TOO_SMALL || plan.reason === NEEDS_FUEL) && plan.needKg > 0;
  const stale = !!plan && !plan.ok && !fuelShort;
  const name = plan?.targetName ?? route?.name ?? "Free flight";
  const legs = nums && nums.legCount > 1 ? nums.legCount : 0;
  const leg = state.legCount > 1 ? `Leg ${state.legIndex + 1}/${state.legCount}` : "";

  let status: ReactNode;
  if (idle) status = plan && !plan.ok ? <span className="transit-hud__status--bad">{plan.reason}</span> : <>Hold <KeyChip action="transitDrive" /></>;
  else if (spooling) status = <>Hold <KeyChip action="transitDrive" /></>;
  else if (route) status = <><KeyChip action="transitDrive" /> Abort</>;
  else status = phase === "decelerating" ? "" : <><KeyChip action="transitDrive" /> Brake</>;

  return (
    <>
      {spooling && (
        <div className="transit-hud transit-hud--spooling">
          <div className="transit-hud__spool-ring">
            <svg viewBox="0 0 48 48" className="transit-hud__spool-svg">
              <circle cx="24" cy="24" r="20" className="transit-hud__spool-track" />
              <circle ref={spoolFillRef} cx="24" cy="24" r="20" className="transit-hud__spool-fill" strokeDasharray={`0 ${SPOOL_CIRCUMFERENCE}`} />
            </svg>
          </div>
          <div className="transit-hud__spool-text">SPOOLING</div>
          <div className="transit-hud__spool-hint">
            Hold <KeyChip action="transitDrive" />
          </div>
        </div>
      )}

      {showPanel && (
        <div
          className={`transit-hud transit-hud--side ${idle ? "transit-hud--preview" : "transit-hud--active"}${stale ? " transit-hud--stale" : ""}`}
          data-testid="transit-panel"
        >
          <div className="transit-hud__head">
            <span className="transit-hud__name">{name}</span>
            <span className="transit-hud__chips">
              {legs > 0 && <span className="transit-hud__chip">{legs} legs</span>}
              {nums?.slow && <span className="transit-hud__chip transit-hud__chip--warn">Coast</span>}
              <span ref={obstacleRef} className="transit-hud__chip transit-hud__chip--warn" hidden>
                Obstacle
              </span>
            </span>
          </div>
          <div className="transit-hud__live">
            <div className="transit-hud__row transit-hud__row--phase">
              <span className="transit-hud__phase">{idle ? "" : phase.toUpperCase()}</span>
              <span className="transit-hud__leg">{leg}</span>
            </div>
            <Row label="DIST" valueRef={distRef} />
          </div>
          <div className="transit-hud__nums">
            <Row label="ETA">{nums && !fuelShort ? fmtEta(nums.etaS) : "--:--"}</Row>
            {fuelShort && plan ? (
              <>
                <Row label="NEED" bad>{kg(plan.needKg)}</Row>
                <Row label="TANK" bad={plan.needKg > plan.tankKg}>{kg(plan.tankKg)}</Row>
              </>
            ) : (
              <>
                <Row label="BURN">{nums ? kg(nums.fuelKg) : "—"}</Row>
                <Row label="LEFT">{nums ? kg(nums.arrivalOrdinaryKg) : "—"}</Row>
              </>
            )}
          </div>
          <div className="transit-hud__status">{status}</div>
        </div>
      )}
    </>
  );
}
