"use client";

import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import {
  transitStateAtom,
  transitDriveOwnedAtom,
  transitDriveBuffer,
  transitPreviewAtom,
  TRANSIT_SPOOL_TIME_S,
  type TransitPreview,
} from "@/store/transit";
import { displayKey, keybindsAtom } from "@/store/keybinds";
import { formatDuration } from "@/sim/units";
import { FIXED_DT } from "@/sim/ship/shipConstants";
import { ALREADY_THERE, spoolStepsFor } from "@/sim/ship/transitDrive";

import "./TransitHUD.scss";

function formatVelocity(kmps: number): string {
  if (kmps < 1) return `${Math.round(kmps * 1000)} m/s`;
  if (kmps < 1000) return `${kmps.toFixed(1)} km/s`;
  return `${(kmps / 1000).toFixed(2)}k km/s`;
}

function formatLightPercent(kmps: number): string {
  const pct = (kmps / 299_792.458) * 100;
  return pct < 0.01 ? "" : `${pct.toFixed(2)}% c`;
}

const kg = (x: number): string => `${Math.round(Math.max(0, x))} kg`;

const SPOOL_CIRCUMFERENCE = 2 * Math.PI * 20;

/** Fuel / ETA / balance rows and warnings for a planned or running route. */
function PlanRows({ p, keyLabel, idle }: { p: TransitPreview; keyLabel: string; idle: boolean }) {
  return (
    <>
      {p.ok ? (
        <dl className="transit-hud__plan">
          <dt>ETA</dt>
          <dd className="transit-hud__plan-eta">{formatDuration(p.etaS)}</dd>
          <dt>{idle ? "Fuel" : "To burn"}</dt>
          <dd>{kg(p.fuelKg)}</dd>
          <dt>On arrival</dt>
          <dd>{kg(p.arrivalOrdinaryKg)}</dd>
          <dt>Reserve</dt>
          <dd>{kg(p.protectedKg)} protected</dd>
        </dl>
      ) : (
        <div className="transit-hud__warn transit-hud__warn--crit">Refused: {p.reason}</div>
      )}
      {p.ok && p.viaName && (
        <div className="transit-hud__warn">
          {p.viaName} blocks the line: {p.legCount} legs via a clearance point
        </div>
      )}
      {p.ok && p.slow && <div className="transit-hud__warn">Low fuel: slower leg with a coast phase</div>}
      {idle && (
        <div className="transit-hud__hint">
          {p.ok ? `Hold ${keyLabel} to engage · ` : ""}assumes no detours or mining
        </div>
      )}
    </>
  );
}

/**
 * Transit readouts. Phase, target and the 4 Hz route preview come from atoms; speed, spool
 * and distance are written to the DOM from the drive buffer in a rAF loop (no React per frame).
 */
export default function TransitHUD() {
  const state = useAtomValue(transitStateAtom);
  const owned = useAtomValue(transitDriveOwnedAtom);
  const keybinds = useAtomValue(keybindsAtom);
  const preview = useAtomValue(transitPreviewAtom);

  const spoolFillRef = useRef<SVGCircleElement>(null);
  const spoolLabelRef = useRef<HTMLDivElement>(null);
  const velocityRef = useRef<HTMLDivElement>(null);
  const lightPctRef = useRef<HTMLDivElement>(null);
  const targetDistRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let running = true;
    const spoolSteps = spoolStepsFor(FIXED_DT);
    const tick = () => {
      if (!running) return;
      const buf = transitDriveBuffer;
      if (buf.phase === "spooling" && spoolFillRef.current && spoolLabelRef.current) {
        const progress = Math.min(1, buf.spoolSteps / spoolSteps);
        spoolFillRef.current.setAttribute("stroke-dasharray", `${progress * SPOOL_CIRCUMFERENCE} ${SPOOL_CIRCUMFERENCE}`);
        spoolLabelRef.current.textContent = `${Math.round(progress * 100)}%`;
      }
      if (buf.phase !== "idle" && buf.phase !== "spooling") {
        const speed = buf.speedKmps;
        if (velocityRef.current) velocityRef.current.textContent = formatVelocity(speed);
        if (lightPctRef.current) {
          const pct = formatLightPercent(speed);
          lightPctRef.current.textContent = pct;
          lightPctRef.current.style.display = pct ? "" : "none";
        }
        if (buf.autopilot && targetDistRef.current) {
          const dist = buf.distKm;
          targetDistRef.current.textContent = dist >= 1000 ? `${(dist / 1000).toFixed(1)}k km` : `${Math.round(dist)} km`;
        }
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

  const transitKey = keybinds.transitDrive[0];
  const keyLabel = transitKey ? displayKey(transitKey) : "T";
  const phase = state.phase;
  const active = phase === "accelerating" || phase === "coasting" || phase === "decelerating";
  const spooling = phase === "spooling";
  const route = state.target;
  const leg = state.legCount > 1 ? `Leg ${state.legIndex + 1}/${state.legCount}${state.legIndex === 0 ? " · clearance point" : ""}` : null;
  const plan = preview && (!route || preview.targetId === route.id) ? preview : null;

  return (
    <>
      {spooling && (
        <div className="transit-hud transit-hud--spooling">
          <div className="transit-hud__spool-ring">
            <svg viewBox="0 0 48 48" className="transit-hud__spool-svg">
              <circle cx="24" cy="24" r="20" className="transit-hud__spool-track" />
              <circle ref={spoolFillRef} cx="24" cy="24" r="20" className="transit-hud__spool-fill" strokeDasharray={`0 ${SPOOL_CIRCUMFERENCE}`} />
            </svg>
            <div ref={spoolLabelRef} className="transit-hud__spool-label">0%</div>
          </div>
          <div className="transit-hud__spool-text">TRANSIT DRIVE SPOOLING</div>
          <div className="transit-hud__spool-hint">{leg ?? `Hold ${keyLabel} to engage`}</div>
        </div>
      )}

      {phase === "idle" && plan && plan.reason !== ALREADY_THERE && (
        <div className="transit-hud transit-hud--side transit-hud--preview">
          <div className="transit-hud__phase-label">Transit plan</div>
          <div className="transit-hud__target-name">{plan.targetName}</div>
          <PlanRows p={plan} keyLabel={keyLabel} idle />
        </div>
      )}

      {(active || (spooling && route)) && (
        <div className="transit-hud transit-hud--side transit-hud--active">
          <div className="transit-hud__phase-label">{spooling ? "SPOOLING" : phase.toUpperCase()}</div>
          {active && <div ref={velocityRef} className="transit-hud__velocity">0 km/s</div>}
          {active && <div ref={lightPctRef} className="transit-hud__light-pct" style={{ display: "none" }} />}
          {route && (
            <div className="transit-hud__target-info">
              <div className="transit-hud__target-name">{route.name}</div>
              {active && (
                <div className="transit-hud__target-meta">
                  <span ref={targetDistRef} className="transit-hud__target-dist">—</span>
                  {leg && <span className="transit-hud__target-sep">·</span>}
                  {leg && <span className="transit-hud__leg">{leg}</span>}
                </div>
              )}
            </div>
          )}
          {route && plan && <PlanRows p={plan} keyLabel={keyLabel} idle={false} />}
          <div className="transit-hud__hint">
            {active && !route && phase !== "decelerating" && <>Press {keyLabel} to brake</>}
            {active && route && <>Autopilot · {keyLabel} aborts to a safe stop</>}
            {active && !route && phase === "decelerating" && <>Braking…</>}
          </div>
        </div>
      )}
    </>
  );
}
