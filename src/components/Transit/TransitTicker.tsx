// TransitTicker: the drive's React side. The leg itself runs in Spaceship's fixed step
// (sim/ship/transitDrive.ts); this mirrors phase changes into the atom, turns step events
// into toasts and refreshes the route preview at human rate.
"use client";

import { useFrame } from "@react-three/fiber";
import { useStore } from "jotai";
import { useEffect } from "react";

import {
  computeTransitPreview,
  targetedPOIAtom,
  transitDriveBuffer,
  transitPreviewAtom,
  transitStateAtom,
  type TransitPreview,
} from "@/store/transit";
import { addToastAtom } from "@/store/toast";
import { recordTrial } from "@/store/research";
import { systemConfigAtom } from "@/store/system";
import { ALREADY_THERE, type TransitBody } from "@/sim/ship/transitDrive";

/** Preview refresh period, s (the predictor runs the whole route through the step law). */
const PREVIEW_PERIOD_S = 0.25;

const seen = { refused: 0, arrived: 0, aborted: 0, autopilotOff: 0, proximity: 0, stoppedShort: 0 };
let previewAcc = PREVIEW_PERIOD_S;
let lastPreviewKey = "";

function previewKey(p: TransitPreview | null): string {
  if (!p) return "";
  return [p.targetId, p.live, p.ok, p.reason, Math.ceil(p.etaS), Math.round(p.fuelKg), Math.round(p.arrivalOrdinaryKg), Math.round(p.protectedKg), Math.round(p.peakHeat01 * 100), p.slow, p.viaName, p.legCount].join("|");
}

export default function TransitTicker() {
  const store = useStore();

  // Bodies the route planner and proximity brake see: LIVE position arrays (ephemeris rewrites them).
  useEffect(() => {
    const bodies = store.get(systemConfigAtom).celestialBodies ?? [];
    transitDriveBuffer.bodies = bodies.map((b): TransitBody => ({ id: b.id, name: b.name, pos: b.positionKm, radiusKm: b.radiusKm }));
    const ev = transitDriveBuffer.ev;
    for (const k of Object.keys(seen) as (keyof typeof seen)[]) seen[k] = ev[k];
  }, [store]);

  useFrame((_, delta) => {
    const rt = transitDriveBuffer;
    const ev = rt.ev;

    if (ev.refused !== seen.refused) {
      seen.refused = ev.refused;
      if (ev.refusal !== ALREADY_THERE) store.set(addToastAtom, { audio: "reject", message: "TRANSIT REFUSED", detail: ev.refusal ?? "", durationMs: 4000 });
    }
    if (ev.proximity !== seen.proximity) {
      seen.proximity = ev.proximity;
      store.set(addToastAtom, { message: "TRANSIT BRAKING", audio: "silent", detail: `Proximity: ${ev.proximityId.toUpperCase()}`, durationMs: 3000 });
    }
    if (ev.autopilotOff !== seen.autopilotOff) {
      seen.autopilotOff = ev.autopilotOff;
      store.set(targetedPOIAtom, null);
      store.set(addToastAtom, { message: "AUTOPILOT DISENGAGED", detail: "Manual control active", durationMs: 3000 });
    }
    if (ev.aborted !== seen.aborted) {
      seen.aborted = ev.aborted;
      store.set(addToastAtom, { message: "TRANSIT ABORTED", audio: "silent", detail: "Braking to a stop", durationMs: 3000 });
    }
    if (ev.stoppedShort !== seen.stoppedShort) {
      seen.stoppedShort = ev.stoppedShort;
      store.set(addToastAtom, { message: "TRANSIT STOPPED SHORT", audio: "silent", detail: ev.stopReason, durationMs: 3000 });
    }
    // The arrival frame keeps its destination so arrival comms know where the ship arrived.
    const arrivedNow = ev.arrived !== seen.arrived;
    // A completed leg is the propulsion trial; a fresh world's counter starts at 0, so it is real.
    if (arrivedNow && ev.arrived > seen.arrived) recordTrial("transit_leg");
    seen.arrived = ev.arrived;

    // Phase / leg / target mirror, only on change.
    const prev = store.get(transitStateAtom);
    const target = rt.autopilot || arrivedNow ? rt.target : null;
    const legCount = rt.phase === "idle" ? 0 : rt.legCount;
    if (rt.phase !== prev.phase || target?.id !== prev.target?.id || rt.legIndex !== prev.legIndex || legCount !== prev.legCount) {
      store.set(transitStateAtom, { phase: rt.phase, target, legIndex: rt.legIndex, legCount });
    }

    previewAcc += Math.min(delta, 0.25);
    if (previewAcc >= PREVIEW_PERIOD_S) {
      previewAcc = 0;
      const p = computeTransitPreview(store);
      const key = previewKey(p);
      if (key !== lastPreviewKey) {
        lastPreviewKey = key;
        store.set(transitPreviewAtom, p);
      }
    }
  });

  return null;
}
