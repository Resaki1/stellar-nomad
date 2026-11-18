"use client";

import { useState } from "react";
import {
  DEFAULT_FLIGHT_TUNING,
  getFlightTuning,
  resetFlightTuning,
  setFlightTuning,
  speedLimitKmps,
  type FlightTuning,
} from "@/sim/ship/flightTuning";
import {
  DEFAULT_CAMERA_TUNING,
  getCameraTuning,
  resetCameraTuning,
  setCameraTuning,
  type CameraTuning,
} from "@/components/Camera/cameraTuning";
import { saveTuningPrefs, tuningJson } from "@/store/flightTuningPrefs";

const UNITS: [RegExp, string][] = [
  [/KgPerMps$/, " (kg per m/s)"],
  [/KgPerRadps$/, " (kg per rad/s)"],
  [/KgPerUnit$/, " (kg/unit)"],
  [/KgPerS$/, " (kg/s)"],
  [/Kg$/, " (kg)"],
  [/KW$/, " (kW)"],
  [/KJ$/, " (kJ)"],
  [/PerS$/, " (/s)"],
  [/01$/, " (0–1)"],
  [/MPerMps2$/, " (m per m/s²)"],
  [/DegPerPx$/, " (°/px)"],
  [/DegS2$/, " (°/s²)"],
  [/DegS$/, " (°/s)"],
  [/Mps2$/, " (m/s²)"],
  [/Mps$/, " (m/s)"],
  [/Deg$/, " (°)"],
  [/Km$/, " (km)"],
  [/Mult$/, " (×)"],
  [/M$/, " (m)"],
  [/S$/, " (s)"],
];

function label(key: string): string {
  for (const [re, unit] of UNITS) {
    if (re.test(key)) return key.replace(re, "").replace(/([A-Z])/g, " $1").toLowerCase() + unit;
  }
  return key.replace(/([A-Z])/g, " $1").toLowerCase();
}

export function Rows<T extends object>({ title, defaults, live, onSet, version }: {
  title: string;
  defaults: Readonly<T>;
  live: Readonly<T>;
  onSet: (patch: Partial<T>) => void;
  version: number;
}) {
  return (
    <div className="flight-tuning__group">
      <div className="keybind-category__title">{title}</div>
      {(Object.keys(defaults) as (keyof T & string)[]).map((k) => {
        const v = live[k] as number;
        const changed = v !== (defaults[k] as number);
        return (
          <label key={`${k}-${version}`} className={`flight-tuning__row${changed ? " flight-tuning__row--changed" : ""}`}>
            <span>{label(k)}</span>
            <input
              className="dev-controls__input"
              type="number"
              step="any"
              defaultValue={v}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (e.target.value.trim() !== "" && Number.isFinite(n)) onSet({ [k]: n } as Partial<T>);
              }}
            />
          </label>
        );
      })}
    </div>
  );
}

/** Settings → Dev: every flight and camera tuning value, live; edits persist as a dev preference. */
export default function FlightTuningControls() {
  const [version, setVersion] = useState(0);
  const [, setTick] = useState(0);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const flight = getFlightTuning();
  const camera = getCameraTuning();
  const top = speedLimitKmps(flight) * 1000;

  const onFlight = (p: Partial<FlightTuning>) => {
    setFlightTuning(p);
    saveTuningPrefs();
    setTick((t) => t + 1);
  };
  const onCamera = (p: Partial<CameraTuning>) => {
    setCameraTuning(p);
    saveTuningPrefs();
    setTick((t) => t + 1);
  };

  return (
    <div className="dev-controls__section flight-tuning">
      <div className="dev-controls__label">flight tuning</div>
      <div className="flight-tuning__derived">
        top speed {top.toFixed(1)} m/s · boosted {(top * flight.boostLimitMult).toFixed(1)} m/s · 0 → top in{" "}
        {(flight.mainThrustMps2 > 0 ? top / flight.mainThrustMps2 : Infinity).toFixed(2)} s
      </div>
      <div className="dev-controls__row">
        <button
          className="settings-menu__button settings-menu__button--subtle"
          onClick={() => {
            resetFlightTuning();
            resetCameraTuning();
            saveTuningPrefs();
            setVersion((v) => v + 1);
            setCopy("idle");
          }}
        >
          reset to defaults
        </button>
        <button
          className="settings-menu__button settings-menu__button--subtle"
          onClick={() => {
            // navigator.clipboard is undefined in insecure contexts (LAN IP over http).
            const write = navigator.clipboard?.writeText(tuningJson()) ?? Promise.reject(new Error("no clipboard"));
            write.then(
              () => setCopy("copied"),
              () => setCopy("failed"),
            );
          }}
        >
          {copy === "copied" ? "copied" : "copy as JSON"}
        </button>
      </div>
      {copy === "failed" && (
        <textarea className="flight-tuning__json" readOnly value={tuningJson()} onFocus={(e) => e.target.select()} />
      )}
      <div className="flight-tuning__groups">
        <Rows title="Flight" defaults={DEFAULT_FLIGHT_TUNING} live={flight} onSet={onFlight} version={version} />
        <Rows title="Camera" defaults={DEFAULT_CAMERA_TUNING} live={camera} onSet={onCamera} version={version} />
      </div>
    </div>
  );
}
