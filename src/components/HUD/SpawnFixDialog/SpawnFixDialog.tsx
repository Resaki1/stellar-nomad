"use client";

import { useCallback, useState } from "react";
import { useSetAtom } from "jotai";
import { devTeleportAtom } from "@/store/dev";
import { loadShipState } from "@/sim/shipPersistence";
import { STARTING_POSITION_KM } from "@/sim/celestialConstants";

import "./SpawnFixDialog.scss";

const MAX_DISTANCE_KM = 50_000;

function isTooFar(): boolean {
  const saved = loadShipState();
  if (!saved) return false;
  const [sx, sy, sz] = saved.positionKm;
  const dx = sx - STARTING_POSITION_KM[0];
  const dy = sy - STARTING_POSITION_KM[1];
  const dz = sz - STARTING_POSITION_KM[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz) > MAX_DISTANCE_KM;
}

export default function SpawnFixDialog() {
  const [show, setShow] = useState(isTooFar);
  const teleport = useSetAtom(devTeleportAtom);

  const handleTeleport = useCallback(() => {
    teleport([...STARTING_POSITION_KM]);
    setShow(false);
  }, [teleport]);

  const handleDismiss = useCallback(() => {
    setShow(false);
  }, []);

  if (!show) return null;

  return (
    <div className="spawn-fix">
      <p className="spawn-fix__text">
        You seem to have spawned in the wrong location, sorry. Want us to
        teleport you back to the starting position?
      </p>
      <div className="spawn-fix__actions">
        <button className="spawn-fix__btn spawn-fix__btn--primary" onClick={handleTeleport}>
          Teleport
        </button>
        <button className="spawn-fix__btn" onClick={handleDismiss}>
          No thanks
        </button>
      </div>
    </div>
  );
}
