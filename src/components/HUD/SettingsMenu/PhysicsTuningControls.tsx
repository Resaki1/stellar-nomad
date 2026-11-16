"use client";

import { useState } from "react";
import { DEFAULT_PHYSICS_TUNING, getPhysicsTuning, resetPhysicsTuning, setPhysicsTuning, type PhysicsTuning } from "@/sim/physics/physicsTuning";
import { impactDamageFraction } from "@/sim/physics/impactDamage";
import { applyPhysicsMaterial, physicsDebug, physicsTuningJson, savePhysicsPrefs } from "@/store/physicsTuningPrefs";
import SettingsCheckbox from "./SettingsCheckbox/SettingsCheckbox";
import { Rows } from "./FlightTuningControls";

/** Settings → Dev: collision/damage tuning, live; edits persist as a dev preference. */
export default function PhysicsTuningControls() {
  const [version, setVersion] = useState(0);
  const [, setTick] = useState(0);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const t = getPhysicsTuning();
  const pct = (v: number) => (impactDamageFraction(v, t) * 100).toFixed(0);

  const onSet = (p: Partial<PhysicsTuning>) => {
    setPhysicsTuning(p);
    applyPhysicsMaterial();
    savePhysicsPrefs();
    setTick((x) => x + 1);
  };

  return (
    <div className="dev-controls__section flight-tuning">
      <div className="dev-controls__label">physics</div>
      <div className="flight-tuning__derived">
        damage at Δv 30 / 64 / 100 m/s: {pct(30)} / {pct(64)} / {pct(100)} %
      </div>
      <SettingsCheckbox
        active={physicsDebug.outlines}
        label="collider outlines"
        onChange={() => {
          physicsDebug.outlines = !physicsDebug.outlines;
          savePhysicsPrefs();
          setTick((x) => x + 1);
        }}
      />
      <div className="dev-controls__row">
        <button
          className="settings-menu__button settings-menu__button--subtle"
          onClick={() => {
            resetPhysicsTuning();
            applyPhysicsMaterial();
            savePhysicsPrefs();
            setVersion((v) => v + 1);
            setCopy("idle");
          }}
        >
          reset to defaults
        </button>
        <button
          className="settings-menu__button settings-menu__button--subtle"
          onClick={() => {
            const write = navigator.clipboard?.writeText(physicsTuningJson()) ?? Promise.reject(new Error("no clipboard"));
            write.then(() => setCopy("copied"), () => setCopy("failed"));
          }}
        >
          {copy === "copied" ? "copied" : "copy as JSON"}
        </button>
      </div>
      {copy === "failed" && (
        <textarea className="flight-tuning__json" readOnly value={physicsTuningJson()} onFocus={(e) => e.target.select()} />
      )}
      <div className="flight-tuning__groups">
        <Rows title="Collisions" defaults={DEFAULT_PHYSICS_TUNING} live={t} onSet={onSet} version={version} />
      </div>
    </div>
  );
}
