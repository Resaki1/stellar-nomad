"use client";

import { useState } from "react";
import { DEFAULT_RESOURCE_TUNING, getResourceTuning, resetResourceTuning, setResourceTuning, type ResourceTuning } from "@/sim/ship/resourceTuning";
import { resourceTuningJson, saveResourcePrefs } from "@/store/resourceTuningPrefs";
import { Rows } from "./FlightTuningControls";

/** Settings → Dev: propellant, reactor, heat, processing and repair tuning, live; edits persist as a dev preference. */
export default function ResourceTuningControls() {
  const [version, setVersion] = useState(0);
  const [, setTick] = useState(0);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const t = getResourceTuning();
  const hopKg = 1500 * t.propellantKgPerMps;

  const onSet = (p: Partial<ResourceTuning>) => {
    setResourceTuning(p);
    saveResourcePrefs();
    setTick((x) => x + 1);
  };

  return (
    <div className="dev-controls__section flight-tuning">
      <div className="dev-controls__label">ship resources</div>
      <div className="flight-tuning__derived">
        1,500 m/s hop {hopKg.toFixed(1)} kg · tank {(t.tankKg / hopKg).toFixed(0)} hops · allowance {(t.recoveryAllowanceKg / hopKg).toFixed(1)} hops ·
        full tank {(t.tankKg / t.processingKgPerS).toFixed(0)} s processing
      </div>
      <div className="dev-controls__row">
        <button
          className="settings-menu__button settings-menu__button--subtle"
          onClick={() => {
            resetResourceTuning();
            saveResourcePrefs();
            setVersion((v) => v + 1);
            setCopy("idle");
          }}
        >
          reset to defaults
        </button>
        <button
          className="settings-menu__button settings-menu__button--subtle"
          onClick={() => {
            const write = navigator.clipboard?.writeText(resourceTuningJson()) ?? Promise.reject(new Error("no clipboard"));
            write.then(() => setCopy("copied"), () => setCopy("failed"));
          }}
        >
          {copy === "copied" ? "copied" : "copy as JSON"}
        </button>
      </div>
      {copy === "failed" && (
        <textarea className="flight-tuning__json" readOnly value={resourceTuningJson()} onFocus={(e) => e.target.select()} />
      )}
      <div className="flight-tuning__groups">
        <Rows title="Resources" defaults={DEFAULT_RESOURCE_TUNING} live={t} onSet={onSet} version={version} />
      </div>
    </div>
  );
}
