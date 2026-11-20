import { useState } from "react";
import type { DepotRecord, DroneRecord } from "@/sim/industry/types";
import { checkDroneRoute } from "@/sim/industry/route";
import type { ShipPose } from "@/save/types";
import { formatDistance } from "@/sim/units";

type Endpoint = Pick<ShipPose, "frameId" | "positionKm"> & { id: string; name: string };
export type DeliveryTarget = (Endpoint & { kind: "depot"; depot: DepotRecord }) | (Endpoint & { kind: "point"; fuelKg: number });

export const DELIVERY_ROUTE_REASON = {
  different_frame: "In another region",
  out_of_field: "Outside local range or a shared field",
  blocked: "Flight path blocked",
  tank: "Round-trip fuel exceeds drone tank",
};

export default function RequestDelivery({ target, depots, drones, draftIds, onCancel, onChoose }: {
  target: DeliveryTarget;
  depots: readonly DepotRecord[];
  drones: readonly DroneRecord[];
  draftIds: ReadonlySet<string>;
  onCancel: () => void;
  onChoose: (drone: DroneRecord) => void;
}) {
  const [sourceId, setSource] = useState("");
  const [droneId, setDrone] = useState("");
  const sources = depots.filter(depot => target.kind !== "depot" || depot.id !== target.id).map(depot => {
    const { route, reason } = checkDroneRoute(depot, target);
    const fleet = drones.filter(drone => drone.homeId === depot.id);
    const available = fleet.flatMap((drone, index) => !drone.job && drone.phase === "idle" && !draftIds.has(drone.id)
      ? [{ drone, name: `Drone ${index + 1}` }] : []);
    const unavailable = reason ? DELIVERY_ROUTE_REASON[reason] : available.length > 0 ? null
      : fleet.length ? "No unassigned drone without a draft" : "No drone fabricated";
    return { depot, route, available, unavailable };
  });
  const source = sources.find(entry => entry.depot.id === sourceId && !entry.unavailable);
  const drone = source?.available.find(entry => entry.drone.id === droneId)?.drone;
  const availableSources = sources.filter(entry => !entry.unavailable);
  const unavailableSources = sources.filter(entry => entry.unavailable);

  return <div className="industry__content" data-industry-delivery-request>
    <h3>{target.kind === "point" ? "Request fuel" : "Request delivery"}</h3>
    <p>Receiving at <strong>{target.name}</strong>. Choose a depot and an unassigned drone to set up its delivery job.</p>
    {availableSources.length > 0 && <div className="industry__form-row industry__request-fields">
      <label>Source depot
        <select data-industry-request-source value={source?.depot.id ?? ""} onChange={e => { setSource(e.target.value); setDrone(""); }}>
          <option value="" disabled>Choose a source</option>
          {availableSources.map(entry => <option key={entry.depot.id} value={entry.depot.id}>
            {entry.depot.name}{entry.route && ` (${formatDistance(entry.route.pathKm)})`}
          </option>)}
        </select>
      </label>
      <label>Drone
        <select data-industry-request-drone disabled={!source} value={drone?.id ?? ""} onChange={e => setDrone(e.target.value)}>
          <option value="" disabled>Choose a drone</option>
          {source?.available.map(entry => <option key={entry.drone.id} value={entry.drone.id}>{entry.name}</option>)}
        </select>
      </label>
    </div>}
    {!sources.length && <p>Build another depot to send supplies here.</p>}
    {unavailableSources.length > 0 && <details open={availableSources.length === 0 || undefined}>
      <summary>Unavailable depots ({unavailableSources.length})</summary>
      <ul className="industry__request-unavailable" aria-label="Unavailable source depots">
        {unavailableSources.map(entry => <li key={entry.depot.id}><strong>{entry.depot.name}</strong><small>{entry.unavailable}</small></li>)}
      </ul>
    </details>}
    {sources.length > 0 && !availableSources.length && <p>Check the route or fabricate an available drone at a depot in range.</p>}
    <div className="industry__line industry__drone-controls">
      <button type="button" className="industry__action" data-industry-action="cancel-delivery-request" onClick={onCancel}>Back</button>
      <button type="button" className="industry__action industry__action--primary" data-industry-action="edit-requested-delivery"
        disabled={!drone} onClick={() => { if (drone) onChoose(drone); }}>Set up delivery</button>
    </div>
  </div>;
}
