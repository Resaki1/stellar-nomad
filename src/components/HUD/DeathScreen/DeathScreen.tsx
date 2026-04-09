"use client";

import { useCallback } from "react";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { isDeadAtom, respawnAtom } from "@/store/death";
import { shipHealthAtom } from "@/store/store";
import { effectiveShipConfigAtom } from "@/store/shipConfig";
import { devTeleportAtom } from "@/store/dev";
import { STARTING_POSITION_KM } from "@/sim/celestialConstants";
import { clearShipState } from "@/sim/shipPersistence";

import "./DeathScreen.scss";

export default function DeathScreen() {
  const isDead = useAtomValue(isDeadAtom);
  const store = useStore();
  const respawn = useSetAtom(respawnAtom);
  const setShipHealth = useSetAtom(shipHealthAtom);
  const setTeleport = useSetAtom(devTeleportAtom);

  const handleRespawn = useCallback(() => {
    // Restore full health
    const cfg = store.get(effectiveShipConfigAtom);
    setShipHealth(cfg.maxHealth);

    // Teleport to starting position
    setTeleport([...STARTING_POSITION_KM]);

    // Clear persisted ship state so it doesn't restore to the death position
    clearShipState();

    // Clear death flag (wrecks persist, cargo already cleared on death)
    respawn();
  }, [store, setShipHealth, setTeleport, respawn]);

  if (!isDead) return null;

  return (
    <div className="death-screen">
      <div className="death-screen__content">
        <h1 className="death-screen__title">Ship Destroyed</h1>
        <p className="death-screen__subtitle">
          Your cargo has been lost at the wreck site.
        </p>
        <button className="death-screen__respawn" onClick={handleRespawn}>
          Respawn
        </button>
      </div>
    </div>
  );
}
