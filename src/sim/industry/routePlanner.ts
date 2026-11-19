import { Vector3 } from "three";
import { allBodyDefs } from "@/sim/celestialConstants";
import { isFrameId, resolveFramePositionKm, SYSTEM_FRAME_ID } from "@/sim/frames";
import { ALREADY_THERE, createTransitPlan, planRoute, type TransitBody } from "@/sim/ship/transitDrive";
import { registerDronePathPlanner } from "./route";
import type { DroneWaypoint } from "./types";

const start = new Vector3();
const plan = createTransitPlan();
// The position arrays remain live as the ephemeris solves new calendar instants.
const bodies: TransitBody[] = allBodyDefs().map(b => ({
  id: b.id, name: b.name, radiusKm: b.radiusKm, pos: b.positionKm,
  atmosphereTopKm: b.atmosphere ? 150 : 0,
}));

registerDronePathPlanner((home, destination, directKm) => {
  resolveFramePositionKm(home.positionKm, home.frameId, start);
  const clear = planRoute(plan, start, { id: "drone-destination", name: "Destination", ...destination }, bodies);
  if (!clear) return plan.reason === ALREADY_THERE ? { pathKm: directKm, via: null } : null;
  const pathKm = plan.pathKm;
  if (!plan.viaBodyId) return { pathKm, via: null };
  const { base, ox, oy, oz, plannedKm } = plan.legs[0];
  const via: DroneWaypoint = isFrameId(plan.viaBodyId)
    ? { frameId: plan.viaBodyId, positionKm: [ox, oy, oz], fraction: plannedKm / pathKm }
    : { frameId: SYSTEM_FRAME_ID, positionKm: [base[0] + ox, base[1] + oy, base[2] + oz], fraction: plannedKm / pathKm };
  return { pathKm, via };
});
