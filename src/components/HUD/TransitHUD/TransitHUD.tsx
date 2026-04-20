"use client";

import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { transitStateAtom, transitDriveOwnedAtom, transitDriveBuffer, TRANSIT_SPOOL_TIME_S, TRANSIT_ACCEL_KMPS2 } from "@/store/transit";
import { displayKey, keybindsAtom } from "@/store/keybinds";

import "./TransitHUD.scss";

/** Format velocity for display. */
function formatVelocity(kmps: number): string {
  if (kmps < 1) return `${Math.round(kmps * 1000)} m/s`;
  if (kmps < 1000) return `${kmps.toFixed(1)} km/s`;
  return `${(kmps / 1000).toFixed(2)}k km/s`;
}

/** Format as percentage of light speed. */
function formatLightPercent(kmps: number): string {
  const c = 299_792.458; // km/s
  const pct = (kmps / c) * 100;
  if (pct < 0.01) return "";
  return `${pct.toFixed(2)}% c`;
}

const SPOOL_CIRCUMFERENCE = 2 * Math.PI * 20; // r=20 → ~125.66

/**
 * TransitHUD — rAF-driven readout of the transit drive state.
 *
 * We subscribe to the atom only for the phase + target (which change at
 * human rate). All hot-path numbers (spool progress, velocity, ETA) are
 * read from the mutable buffer every animation frame to avoid React
 * re-renders at 60fps during the spool and transit.
 */
export default function TransitHUD() {
  const state = useAtomValue(transitStateAtom);
  const owned = useAtomValue(transitDriveOwnedAtom);
  const keybinds = useAtomValue(keybindsAtom);

  // ── Refs to DOM elements we mutate each frame ─────────────────
  const spoolFillRef = useRef<SVGCircleElement>(null);
  const spoolLabelRef = useRef<HTMLDivElement>(null);

  const velocityRef = useRef<HTMLDivElement>(null);
  const lightPctRef = useRef<HTMLDivElement>(null);
  const targetDistRef = useRef<HTMLDivElement>(null);
  const etaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let running = true;

    const tick = () => {
      if (!running) return;
      const buf = transitDriveBuffer;

      // ── Spool progress ─────────────────────────────────────────
      if (buf.phase === "spooling" && spoolFillRef.current && spoolLabelRef.current) {
        const progress = Math.min(1, buf.spoolAccS / TRANSIT_SPOOL_TIME_S);
        const dash = progress * SPOOL_CIRCUMFERENCE;
        spoolFillRef.current.setAttribute(
          "stroke-dasharray",
          `${dash} ${SPOOL_CIRCUMFERENCE}`,
        );
        spoolLabelRef.current.textContent = `${Math.round(progress * 100)}%`;
      }

      // ── Active transit velocity + ETA ──────────────────────────
      if (buf.phase === "accelerating" || buf.phase === "decelerating") {
        const v = buf.velocityKmps;
        const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);

        if (velocityRef.current) {
          velocityRef.current.textContent = formatVelocity(speed);
        }
        if (lightPctRef.current) {
          const pct = formatLightPercent(speed);
          lightPctRef.current.textContent = pct;
          lightPctRef.current.style.display = pct ? "" : "none";
        }

        // Live distance + ETA (computed here to avoid atom writes).
        if (buf.autopilot && buf.shipPosKm) {
          const dx = buf.autopilotTargetKm.x - buf.shipPosKm.x;
          const dy = buf.autopilotTargetKm.y - buf.shipPosKm.y;
          const dz = buf.autopilotTargetKm.z - buf.shipPosKm.z;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

          if (targetDistRef.current) {
            targetDistRef.current.textContent = dist >= 1000
              ? `${(dist / 1000).toFixed(1)}k km`
              : `${Math.round(dist)} km`;
          }
          if (etaRef.current) {
            const a = TRANSIT_ACCEL_KMPS2;
            let eta = 0;
            if (buf.phase === "accelerating" && dist > 0) {
              const vPeak = Math.sqrt(a * dist + speed * speed / 2);
              eta = (2 * vPeak - speed) / a;
            } else if (buf.phase === "decelerating" && speed > 0) {
              eta = speed / a;
            }
            etaRef.current.textContent = `ETA ~${Math.ceil(eta)}s`;
          }
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

  const active = state.phase === "accelerating" || state.phase === "decelerating";
  const spooling = state.phase === "spooling";
  const isAutopilot = active && !!state.target;

  return (
    <>
      {spooling && (
        <div className="transit-hud transit-hud--spooling">
          <div className="transit-hud__spool-ring">
            <svg viewBox="0 0 48 48" className="transit-hud__spool-svg">
              <circle
                cx="24" cy="24" r="20"
                className="transit-hud__spool-track"
              />
              <circle
                ref={spoolFillRef}
                cx="24" cy="24" r="20"
                className="transit-hud__spool-fill"
                strokeDasharray={`0 ${SPOOL_CIRCUMFERENCE}`}
              />
            </svg>
            <div ref={spoolLabelRef} className="transit-hud__spool-label">
              0%
            </div>
          </div>
          <div className="transit-hud__spool-text">
            TRANSIT DRIVE SPOOLING
          </div>
          <div className="transit-hud__spool-hint">
            Hold {keyLabel} to engage
          </div>
        </div>
      )}

      {active && (
        <div className="transit-hud transit-hud--active">
          <div className="transit-hud__phase-label">
            {state.phase === "accelerating" ? "ACCELERATING" : "DECELERATING"}
          </div>

          <div ref={velocityRef} className="transit-hud__velocity">
            0 km/s
          </div>
          <div ref={lightPctRef} className="transit-hud__light-pct" style={{ display: "none" }} />

          {isAutopilot && state.target && (
            <div className="transit-hud__target-info">
              <div className="transit-hud__target-name">{state.target.name}</div>
              <div className="transit-hud__target-meta">
                <span ref={targetDistRef} className="transit-hud__target-dist">—</span>
                <span className="transit-hud__target-sep">·</span>
                <span ref={etaRef} className="transit-hud__eta">—</span>
              </div>
            </div>
          )}

          <div className="transit-hud__hint">
            {state.phase === "accelerating" && !isAutopilot && (
              <>Press {keyLabel} to decelerate</>
            )}
            {state.phase === "accelerating" && isAutopilot && (
              <>Autopilot active</>
            )}
            {state.phase === "decelerating" && (
              <>Decelerating…</>
            )}
          </div>
        </div>
      )}
    </>
  );
}
