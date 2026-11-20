"use client";

import { useAtomValue } from "jotai";
import { useRef, useState } from "react";
import { Fuel, Truck } from "lucide-react";
import { industryResearchNode, materialName } from "@/data/content";
import type { ReplicationPoint } from "@/save/types";
import { INDUSTRY_TUNING, POINT_TANK_CAPACITY_KG, POINT_TANK_RECIPE } from "@/sim/industry/catalog";
import { formatDistance } from "@/sim/units";
import { playAudio } from "@/audio/voices";
import { cargoAtom } from "@/store/cargo";
import { industryAtom } from "@/store/industry";
import { newOpId, runOperation } from "@/store/operations";
import { completedNodeSetAtom } from "@/store/research";
import { shipReq, shipResourcesHudAtom } from "@/store/shipResources";
import { IndustryResearchRequirement } from "../ResearchPanel/ResearchPanel";
import { ResourceGlyph } from "../shared/Chips";
import { industryRejection } from "./industryActions";
import "./PointFuelControls.scss";

type Direction = "deposit" | "withdraw";
const kg = (n: number): string => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

export default function PointFuelControls({ point, inRange, onRequestFuel, initiallyOpen }: {
  point: ReplicationPoint;
  inRange: boolean;
  onRequestFuel?: () => void;
  initiallyOpen?: boolean;
}) {
  const pointTanks = useAtomValue(industryAtom).pointTanks;
  const installed = Object.hasOwn(pointTanks, point.id);
  const stock = installed ? pointTanks[point.id] : 0;
  const cargo = useAtomValue(cargoAtom).items;
  const known = useAtomValue(completedNodeSetAtom).has(industryResearchNode("point_tank").id);
  const { ordinaryKg, tankKg, processing } = useAtomValue(shipResourcesHudAtom);
  const pendingFuelKg = processing ? Math.max(0, processing.totalKg - processing.committedKg) : 0;
  const availableKg = Math.max(0, ordinaryKg - shipReq.reservedKg);
  const depositLimit = Math.floor(Math.min(availableKg, POINT_TANK_CAPACITY_KG - stock));
  const withdrawLimit = Math.floor(Math.max(0, Math.min(stock, tankKg - ordinaryKg - pendingFuelKg)));
  const affordable = Object.entries(POINT_TANK_RECIPE).every(([id, count]) => (cargo[id] ?? 0) >= count);
  const [amount, setAmount] = useState("10");
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const units = Number(amount);
  const validAmount = Number.isSafeInteger(units) && units > 0;
  const blocked = !inRange || pending;

  const submit = (direction?: Direction) => {
    if (blocked || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    const request = { pointId: point.id, opId: newOpId() };
    runOperation(direction ? { ...request, type: "replication.tank.transfer", direction, amount: units }
      : { ...request, type: "replication.tank.install" }, outcome => {
      pendingRef.current = false;
      setPending(false);
      if (outcome.status === "accepted") {
        playAudio("click.hard");
      } else if (outcome.status === "rejected") {
        playAudio("ui.reject");
        const missing = outcome.missing?.fuel;
        let text = industryRejection(outcome);
        if (outcome.reason === "too_far") text = "Fly closer to this replication point.";
        if (outcome.reason === "point_tank_full") text = "The replication tank needs more room.";
        if (outcome.reason === "not_found") text = "This replication tank is unavailable.";
        if (missing !== undefined) text = `${direction === "deposit" ? "Your ship" : "The replication tank"} is short by ${kg(missing)} kg.`;
        setError(text);
      }
    });
  };

  return <details className="point-fuel" data-point-tank-details={point.id} open={initiallyOpen || undefined} aria-busy={pending}>
    <summary>
      <span><Fuel size={15} aria-hidden /> Fuel tank</span>
      <strong aria-live="polite" data-point-tank-stock={installed ? stock : undefined}>
        {installed ? `${kg(stock)} / ${kg(POINT_TANK_CAPACITY_KG)} kg` : "Available to install"}
      </strong>
    </summary>
    <div className="point-fuel__body">
      {!inRange && <small>Fly within {formatDistance(INDUSTRY_TUNING.interactRangeKm)} to {installed ? "transfer fuel" : "install a tank"}.</small>}
      {installed ? <>
        <p>Stores ordinary propellant for ship transfers and recovery at this point.</p>
        <div className="point-fuel__transfer">
          <label>Transfer kg
            <input type="number" step="1" min="1" inputMode="numeric" value={amount} disabled={blocked}
              data-point-tank-amount onChange={e => setAmount(e.target.value)} />
          </label>
          <button type="button" className="industry__action" data-point-tank-action="withdraw"
            disabled={blocked || !validAmount || units > withdrawLimit} onClick={() => submit("withdraw")}>Withdraw</button>
          <button type="button" className="industry__action" data-point-tank-action="deposit"
            disabled={blocked || !validAmount || units > depositLimit} onClick={() => submit("deposit")}>Deposit</button>
        </div>
        {inRange && <small>Available to deposit {kg(depositLimit)} kg · Available to withdraw {kg(withdrawLimit)} kg</small>}
        {onRequestFuel && <button type="button" className="industry__action" data-point-tank-action="request"
          disabled={pending} onClick={onRequestFuel}><Truck size={14} aria-hidden /> Request fuel delivery</button>}
      </> : <>
        <p>Install a {kg(POINT_TANK_CAPACITY_KG)} kg tank using materials aboard your ship.</p>
        {!known && <IndustryResearchRequirement blueprint="point_tank" />}
        <ul className="industry-recipe" aria-label="Tank materials">
          {Object.entries(POINT_TANK_RECIPE).map(([id, count]) => {
            const have = Math.floor(cargo[id] ?? 0);
            return <li key={id} data-short={have < count}>
              <span aria-hidden><ResourceGlyph id={id} /></span> {materialName(id)} <strong>{have}/{count}</strong>
            </li>;
          })}
        </ul>
        <button type="button" className="industry__action industry__action--primary" data-point-tank-action="install"
          disabled={blocked || !known || !affordable} onClick={() => submit()}>Install tank</button>
      </>}
      {error && <small className="point-fuel__feedback" role="alert">{error}</small>}
    </div>
  </details>;
}
