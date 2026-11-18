"use client";

import { useCallback } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { isDeadAtom, respawnAtom } from "@/store/death";
import { STARTING_POSITION_KM } from "@/sim/celestialConstants";

import "./DeathScreen.scss";

export default function DeathScreen() {
  const isDead = useAtomValue(isDeadAtom);
  const respawn = useSetAtom(respawnAtom);

  // PR 1 recovery: the starting position (replication points arrive in PR 2).
  const handleRespawn = useCallback(() => {
    respawn([...STARTING_POSITION_KM]);
  }, [respawn]);

  if (!isDead) return null;

  return (
    <div className="death-screen">
      <div className="death-screen__content">
        <h1 className="death-screen__title">Ship Destroyed</h1>
        <p className="death-screen__subtitle">
          Cargo and ordinary propellant stay at the wreck site. You recover at the starting
          position with a full hull and the protected propellant allowance.
        </p>
        <button className="death-screen__respawn" onClick={handleRespawn}>
          Respawn
        </button>
      </div>
    </div>
  );
}
