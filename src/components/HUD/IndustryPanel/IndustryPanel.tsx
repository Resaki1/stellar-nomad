"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowDownLeft, ArrowUp, ArrowUpRight, Box, Crosshair, Factory, Fuel, MapPin, Pencil, PackagePlus, Radio, Truck } from "lucide-react";
import { getItemDef, MATERIAL_NAMES, materialName } from "@/data/content";
import { playAudio } from "@/audio/voices";
import { getLocalPlayerShip } from "@/sim/entities";
import { DRONE_FUEL_ID, DEPOT_KIT_ID, DEPOT_RECIPES, INDUSTRY_SOURCES, INDUSTRY_TUNING } from "@/sim/industry/catalog";
import type { DepotRecord, DroneJob, DroneRecord, DroneStatus } from "@/sim/industry/types";
import { estimateDroneExtractionRoute, estimateDroneRoute } from "@/sim/industry/route";
import { depotDistanceKm } from "@/sim/industry/placement";
import { storageUnits } from "@/sim/industry/simulation";
import type { ShipPose } from "@/save/types";
import { formatDistance, formatDuration } from "@/sim/units";
import type { WorldOperation } from "@/sim/world/commands";
import { cargoAtom, cargoRemainingUnitsAtom } from "@/store/cargo";
import { industryAtom } from "@/store/industry";
import { depotPoi, industrySourcePois, nextDepotName, trackIndustryPoiAtom } from "@/store/industryHud";
import { modulesAtom } from "@/store/modules";
import { newOpId, runOperation } from "@/store/operations";
import { shipReq, shipResourcesHudAtom } from "@/store/shipResources";
import { targetedPOIAtom, transitDriveOwnedAtom } from "@/store/transit";
import type { POIDef } from "@/store/poi";
import { replicationPointsAtom, playerReplicationAtom } from "@/store/replication";
import StructureNameEditor, { type NamedStructure } from "./StructureNameEditor";
import Panel from "../Shell/Panel";
import { ResourceGlyph } from "../shared/Chips";
import { industryRejection } from "./industryActions";
import "./IndustryPanel.scss";

const kitDef = getItemDef(DEPOT_KIT_ID);
const propellantId = DRONE_FUEL_ID;
const stockName = (id: string): string => id === propellantId ? "Propellant" : getItemDef(id)?.name ?? materialName(id);
const quantity = (n: number): string => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

type IndustryOp = Extract<WorldOperation, { type: "depot.transfer" | "depot.fabricate" | "drone.configure" | "item.craft" }>;
type OperationArgs<Op = IndustryOp> = Op extends IndustryOp ? Omit<Op, "opId"> : never;
type Submit = (op: OperationArgs, success?: string, onAccepted?: () => void) => void;
type Coordinates = Pick<ShipPose, "frameId" | "positionKm">;

type DroneDraft = {
  baseJob: DroneJob | null;
  kind: DroneJob["kind"];
  sourceId: string;
  destinationId: string;
  priorities: string[];
  reserve: string;
  hydrateLimit: string;
  deliveryLimit: string;
};
type SaveDroneDraft = (id: string, draft: DroneDraft | null) => void;

function distance(a: Coordinates | null, b: Coordinates): number {
  return a ? depotDistanceKm(a, b) : Infinity;
}

function shipCoordinates(): Coordinates | null {
  const ship = getLocalPlayerShip();
  return ship ? { frameId: ship.frameId, positionKm: ship.posKm.toArray() } : null;
}

function usePosition(): Coordinates | null {
  const [pose, setPose] = useState(shipCoordinates);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = shipCoordinates();
      setPose(before => before && next && before.frameId === next.frameId && distance(before, next) < 0.0005 ? before : next);
    }, 250);
    return () => window.clearInterval(timer);
  }, []);
  return pose;
}

function depotRole(depot: DepotRecord, drones: DroneRecord[]): string {
  const extracts = drones.some(drone => drone.homeId === depot.id && drone.job?.kind === "extract");
  if (depot.refinery) return extracts ? "Refinery · Hydrate extraction" : "Refinery";
  return extracts ? "Hydrate extraction" : "Storage depot";
}

function Requirements({ items, have }: { items: Record<string, number>; have: Record<string, number> }) {
  return <ul className="industry-recipe" aria-label="Recipe materials">
    {Object.entries(items).map(([id, amount]) => {
      const owned = Math.floor(have[id] ?? 0);
      return <li key={id} data-short={owned < amount}>
        <span aria-hidden><ResourceGlyph id={id} /></span>
        {materialName(id)} <strong>{quantity(owned)}/{quantity(amount)}</strong>
      </li>;
    })}
  </ul>;
}

const canAfford = (recipe: Record<string, number>, have: Record<string, number>): boolean =>
  Object.entries(recipe).every(([id, n]) => (have[id] ?? 0) >= n);

type IndustryPanelProps = {
  initialDepotId?: string;
  renamePointId?: string;
  build?: boolean;
  initialName?: string;
  onClose: () => void;
  onAim: (name: string) => void;
};

export default function IndustryPanel({ initialDepotId, renamePointId, initialName, build, onClose, onAim }: IndustryPanelProps) {
  const { depots, drones } = useAtomValue(industryAtom);
  const points = useAtomValue(replicationPointsAtom).filter(point => !point.starter);
  const activePoint = useAtomValue(playerReplicationAtom).activeId;
  const [showPoints, setShowPoints] = useState(!!renamePointId);
  const [renaming, setRenaming] = useState<NamedStructure | null>(() => {
    const point = points.find(point => point.id === renamePointId);
    return point ? { kind: "point", id: point.id, name: point.name } : null;
  });
  const position = usePosition();
  const nearest = depots.reduce<DepotRecord | undefined>((best, depot) => !best || distance(position, depot) < distance(position, best) ? depot : best, undefined);
  const [selected, select] = useState(build ? null : initialDepotId ?? nearest?.id ?? null);
  const [view, setView] = useState<"storage" | "fabrication" | "drones">("storage");
  const [droneDrafts, setDroneDrafts] = useState<ReadonlyMap<string, DroneDraft>>(() => new Map());
  const saveDroneDraft: SaveDroneDraft = (id, draft) => {
    setDroneDrafts(current => {
      const next = new Map(current);
      if (draft) next.set(id, draft);
      else next.delete(id);
      return next;
    });
  };
  const depot = showPoints ? undefined : depots.find(d => d.id === selected);
  const distanceKm = depot ? distance(position, depot) : Infinity;
  const inRange = !!depot && distanceKm <= INDUSTRY_TUNING.interactRangeKm;
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(current => current === feedback ? null : current), feedback.error ? 8000 : 4000);
    return () => window.clearTimeout(timer);
  }, [feedback]);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const track = useSetAtom(trackIndustryPoiAtom);
  const selectedTarget = useAtomValue(targetedPOIAtom);
  const driveOwned = useAtomValue(transitDriveOwnedAtom);
  const content = useRef<HTMLDivElement>(null);
  const renameForm = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const dialog = (content.current ?? renameForm.current)?.closest(".panel");
    if (!dialog) return;
    dialog.querySelector<HTMLElement>('[aria-current="true"]')?.focus({ preventScroll: true });
    const cycleFocus = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled)"))
        .filter(control => control.getClientRects().length > 0);
      const first = controls[0];
      const last = controls.at(-1);
      if (!dialog.contains(document.activeElement) || document.activeElement === (e.shiftKey ? first : last)) {
        e.preventDefault();
        (e.shiftKey ? last : first)?.focus();
      }
    };
    window.addEventListener("keydown", cycleFocus);
    return () => window.removeEventListener("keydown", cycleFocus);
  }, [renaming]);
  const navigate = (poi: POIDef) => {
    if (track(poi)) {
      if (selectedTarget?.id !== poi.id) onClose();
      else setFeedback(null);
    } else {
      setFeedback({ text: "Finish transit before changing your target.", error: true });
    }
  };
  const submit: Submit = (op, success, onAccepted) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setFeedback(null);
    runOperation({ ...op, opId: newOpId() }, outcome => {
      if (outcome.status === "pending") return;
      pendingRef.current = false;
      setPending(false);
      if (outcome.status === "rejected") setFeedback({
        text: industryRejection(outcome, op.type === "depot.transfer" ? op : undefined),
        error: true,
      });
      else {
        onAccepted?.();
        if (success) setFeedback({ text: success, error: false });
      }
      playAudio(outcome.status === "accepted" ? "click.hard" : "ui.reject");
    });
  };
  const selectDepot = (id: string | null) => {
    setShowPoints(false);
    select(id);
    setView("storage");
    setFeedback(null);
  };
  const poi = depot && depotPoi(depot);
  const depotTracked = !!poi && selectedTarget?.id === poi.id;
  const operationFeedback = <div className="industry__feedback">
    <div role="status">{pending ? "Waiting for confirmation…" : !feedback?.error && feedback?.text}</div>
    <div role="alert">{feedback?.error && feedback.text}</div>
  </div>;

  if (renaming) return <StructureNameEditor structure={renaming} formRef={renameForm} onClose={() => setRenaming(null)} />;
  return <Panel title="Industry" width={875} fixedHeight noBodyPadding onClose={onClose}>
    <div className="industry" ref={content} aria-busy={pending}>
      <div className="industry__layout">
        <nav className="industry__roster" aria-label="Industry locations">
          {depots.map(d => {
            const km = distance(position, d);
            return <button key={d.id} type="button" data-industry-depot={d.id} aria-current={!showPoints && selected === d.id}
              className="industry__depot-button" onClick={() => selectDepot(d.id)}>
              {d.refinery ? <Factory size={15} aria-hidden /> : <Box size={15} aria-hidden />}
              <span>{d.name}<small data-industry-depot-role>{depotRole(d, drones)}</small></span>
              {Number.isFinite(km) && <small>{formatDistance(km)}</small>}
            </button>;
          })}
          <button className="industry__depot-button industry__depot-button--build" type="button" data-industry-build
            aria-current={!depot && !showPoints} onClick={() => selectDepot(null)}>
            <PackagePlus size={16} aria-hidden /> <span>Build depot</span>
          </button>
          {points.length > 0 && <button type="button" className="industry__depot-button" data-industry-points
            aria-current={showPoints} onClick={() => { setShowPoints(true); setFeedback(null); }}>
            <MapPin size={15} aria-hidden /><span>Replication points</span></button>}
        </nav>

        <section className="industry__detail" aria-label={showPoints ? "Replication points" : depot?.name ?? "Build depot"}>
          {depot && poi && <>
            <header className="industry__depot-head">
              <div>
                <h3><button type="button" className="industry__rename-trigger" aria-label={`Rename depot ${depot.name}`}
                  onClick={() => setRenaming({ kind: "depot", id: depot.id, name: depot.name })}>
                  {depot.name}<Pencil size={14} aria-hidden /></button></h3>
                <div className="industry__access" data-industry-access={inRange ? "available" : "remote"}>
                  <Radio size={13} aria-hidden />
                  {inRange ? "In range" : `Fly within ${formatDistance(INDUSTRY_TUNING.interactRangeKm)} to use this depot`}
                  {Number.isFinite(distanceKm) && <span>{formatDistance(distanceKm)} away</span>}
                </div>
              </div>
              <Action action="track-depot" onClick={() => navigate(poi)}>
                <Crosshair size={14} aria-hidden /> {depotTracked ? "Untrack depot" : "Track depot"}
              </Action>
            </header>
            <div className="industry__tabs" aria-label="Depot controls">
              {([["storage", "Storage"], ["fabrication", "Fabrication"], ["drones", "Drones"]] as const).map(([id, label]) =>
                <button key={id} type="button" data-industry-tab={id} aria-pressed={view === id} onClick={() => {
                  setView(id);
                  setFeedback(null);
                }}>{label}</button>
              )}
            </div>
          </>}
          {showPoints ? <div className="industry__content">
            <h3>Replication points</h3>
            <ul className="industry__points">{points.map(point => <li key={point.id}>
              <div><strong>{point.name}</strong><small>{point.id === activePoint ? "Active · " : ""}{formatDistance(distance(position, point))} away</small></div>
              <Action label={`Rename replication point ${point.name}`} onClick={() => setRenaming({ kind: "point", id: point.id, name: point.name })}>
                <Pencil size={14} aria-hidden /> Rename
              </Action>
            </li>)}</ul>
          </div> : depot && view === "storage" ? <DepotStorage key={depot.id} depot={depot} depots={depots} disabled={!inRange || pending} submit={submit} feedback={operationFeedback} />
            : <>{depot ? <div className="industry__content" key={`${depot.id}:${view}`}>
              {view === "fabrication" && <Fabrication depot={depot} droneCount={drones.filter(drone => drone.homeId === depot.id).length} disabled={!inRange || pending} submit={submit} />}
              {view === "drones" && <DepotDrones depot={depot} depots={depots} drones={drones} drafts={droneDrafts}
                saveDraft={saveDroneDraft} disabled={!inRange || pending} submit={submit} onFabricate={() => setView("fabrication")} />}
            </div> : <BuildDepot depots={depots} initialName={initialName ?? nextDepotName(depots)} position={position} pending={pending} canTransit={driveOwned} trackedId={selectedTarget?.id} submit={submit} onAim={onAim} navigate={navigate} />}
              {operationFeedback}
            </>}
        </section>
      </div>
    </div>
  </Panel>;
}

function Action({ children, onClick, disabled, primary, action, label }: {
  children: ReactNode; onClick: () => void; disabled?: boolean; primary?: boolean; action?: string; label?: string;
}) {
  return <button type="button" className={`industry__action${primary ? " industry__action--primary" : ""}`}
    data-industry-action={action} aria-label={label} disabled={disabled} onClick={onClick}>{children}</button>;
}

function BuildDepot({ depots, initialName, position, pending, canTransit, trackedId, submit, onAim, navigate }: {
  depots: DepotRecord[]; initialName: string; position: Coordinates | null; pending: boolean; canTransit: boolean; trackedId?: string;
  submit: Submit; onAim: (name: string) => void; navigate: (poi: POIDef) => void;
}) {
  const { items } = useAtomValue(cargoAtom);
  const kits = useAtomValue(modulesAtom).consumables[DEPOT_KIT_ID] ?? 0;
  const [name, setName] = useState(initialName);
  const recipe = kitDef?.recipe ?? {};
  const ready = !!kitDef && kits < (kitDef.stackMax ?? Infinity) && canAfford(recipe, items);
  const slotsFull = depots.length >= INDUSTRY_TUNING.maxDepots;
  const sources = INDUSTRY_SOURCES.map((source, i) => ({ source, poi: industrySourcePois[i], km: distance(position, source) }))
    .sort((a, b) => a.km - b.km);

  return <div className="industry__content industry__build">
    <h3>Build a depot</h3>
    <p>Store supplies and build equipment at a depot. Drones can collect hydrates or deliver supplies.</p>
    <div className="industry__build-steps">
      <section>
        <h4>1. Fabricate a depot kit</h4>
        <Requirements items={recipe} have={items} />
        <div className="industry__line">
          <span>{kits} aboard</span>
          <Action action="craft-kit" disabled={pending || !ready} onClick={() => submit({ type: "item.craft", itemId: DEPOT_KIT_ID }, "Depot kit ready.")}>
            Fabricate kit
          </Action>
        </div>
      </section>
      <section>
        <h4>2. Choose a location</h4>
        <p>Build within reach of a site below to collect hydrates with drones. A refinery turns them into propellant. Drones can deliver supplies between nearby depots in the same region.</p>
        <div className="industry__sources">
          {sources.map(({ source, poi, km }) => <div className="industry__line" key={source.id}>
            <span><MapPin size={14} aria-hidden /> {source.name}<small>{Number.isFinite(km) ? `${formatDistance(km)} away` : "Position unavailable"} · Build within {formatDistance(source.rangeKm)}
              {position && estimateDroneExtractionRoute(position, source, depots) && <strong> · In range</strong>}
            </small></span>
            <Action action={`track-${source.id}`} onClick={() => navigate(poi)}>{trackedId === poi.id ? "Untrack" : "Track"}</Action>
          </div>)}
        </div>
        {!canTransit && <small>Track shows the direction in flight. Add a Transit Drive for long trips.</small>}
      </section>
      <section>
        <h4>3. Deploy the depot</h4>
        <div className="industry__form-row">
          <label>Depot name<input data-industry-name value={name} maxLength={32} spellCheck={false} onChange={e => setName(e.target.value)} /></label>
          <Action action="aim" primary disabled={pending || kits < 1 || !name.trim() || slotsFull} onClick={() => onAim(name.trim())}>Aim placement</Action>
        </div>
        {slotsFull && <small>All depot slots are in use.</small>}
      </section>
    </div>
  </div>;
}

type DepotControls = { depot: DepotRecord; disabled: boolean; submit: Submit };

function DepotStorage({ depot, depots, disabled, submit, feedback }: DepotControls & { depots: DepotRecord[]; feedback: ReactNode }) {
  const cargo = useAtomValue(cargoAtom).items;
  const cargoRoom = useAtomValue(cargoRemainingUnitsAtom);
  const { ordinaryKg, tankKg, processing } = useAtomValue(shipResourcesHudAtom);
  const pendingKg = processing ? Math.max(0, processing.totalKg - processing.committedKg) : 0;
  const availableKg = Math.max(0, ordinaryKg - shipReq.reservedKg);
  const kits = useAtomValue(modulesAtom).consumables;
  const { storage } = depot;
  const holdUsed = storageUnits(storage);
  const [key, select] = useState(`fuel:${propellantId}`);
  const [count, setCount] = useState("10");
  const cargoIds = Array.from(new Set([...Object.keys(cargo), ...Object.keys(storage.items)]))
    .filter(id => (cargo[id] ?? 0) > 0 || (storage.items[id] ?? 0) > 0);
  const kitIds = Array.from(new Set([...Object.keys(kits), ...Object.keys(storage.consumables)]))
    .filter(id => (kits[id] ?? 0) > 0 || (storage.consumables[id] ?? 0) > 0);
  const rows = [
    { kind: "fuel" as const, id: propellantId, ship: availableKg, depot: storage.fuelKg, shipRoom: tankKg - ordinaryKg - pendingKg, depotRoom: INDUSTRY_TUNING.fuelCapacityKg - storage.fuelKg },
    ...cargoIds.map(id => ({ kind: "cargo" as const, id, ship: cargo[id] ?? 0, depot: storage.items[id] ?? 0, shipRoom: cargoRoom, depotRoom: INDUSTRY_TUNING.cargoCapacity - holdUsed })),
    ...kitIds.map(id => ({ kind: "consumable" as const, id, ship: kits[id] ?? 0, depot: storage.consumables[id] ?? 0, shipRoom: (getItemDef(id)?.stackMax ?? 99) - (kits[id] ?? 0), depotRoom: INDUSTRY_TUNING.cargoCapacity - holdUsed })),
  ];
  const selected = rows.find(row => `${row.kind}:${row.id}` === key) ?? rows[0];
  const maxIn = Math.max(0, Math.floor(Math.min(selected.ship, selected.depotRoom)));
  const maxOut = Math.max(0, Math.floor(Math.min(selected.depot, selected.shipRoom)));
  const n = Number(count);
  const validAmount = Number.isSafeInteger(n) && n > 0;
  const transfer = (direction: "deposit" | "withdraw", amount: number) =>
    submit({ type: "depot.transfer", depotId: depot.id, direction, kind: selected.kind, itemId: selected.kind === "fuel" ? "fuel" : selected.id, amount });
  const nearby = INDUSTRY_SOURCES.find(source => estimateDroneExtractionRoute(depot, source, depots));
  const fuelTankFull = INDUSTRY_TUNING.fuelCapacityKg - storage.fuelKg < INDUSTRY_TUNING.refineKgPerHydrate;
  return <div className="industry__storage">
    <div className="industry__content">
      <div className="industry__capacity">
        <span><Fuel size={14} aria-hidden /> Fuel {quantity(storage.fuelKg)} / {quantity(INDUSTRY_TUNING.fuelCapacityKg)} kg</span>
        <span><Box size={14} aria-hidden /> Cargo {quantity(holdUsed)} / {quantity(INDUSTRY_TUNING.cargoCapacity)} units</span>
      </div>
      <p className="industry__operation">
        {depot.refinery
          ? (storage.items.hydrates ?? 0) < 1 ? "Refinery waiting for hydrates." : fuelTankFull ? "Refinery waiting for room in the fuel tank." : "Refinery turning hydrates into propellant."
          : nearby ? `${nearby.name} is in range of this depot.` : "Bring supplies by ship or set up a drone delivery."}
      </p>
      <div className="industry__manifest" role="group" aria-label="Select an item to transfer">
        <div className="industry__manifest-head" aria-hidden="true"><span>Item</span><span>Ship</span><span>Depot</span></div>
        {rows.map(row => <button key={`${row.kind}:${row.id}`} type="button" className="industry__manifest-row" data-industry-stock={row.id}
          aria-pressed={selected === row} onClick={() => { select(`${row.kind}:${row.id}`); if (row.kind === "consumable") setCount("1"); }}>
          <span>{row.kind === "fuel" ? <Fuel size={14} aria-hidden /> : row.kind === "cargo" ? <ResourceGlyph id={row.id} /> : <Box size={14} aria-hidden />}{stockName(row.id)}</span>
          <span aria-label={`${quantity(row.ship)} aboard`}>{quantity(row.ship)}</span>
          <span aria-label={`${quantity(row.depot)} at depot`}>{quantity(row.depot)}</span>
        </button>)}
      </div>
      {selected.kind === "fuel" && (pendingKg > 0 || shipReq.reservedKg > 0) &&
        <small>Fuel reserved for flight or processing reduces how much you can move.</small>}
    </div>
    {feedback}
    <div className="industry__transfer">
      <label><span>{stockName(selected.id)} ({selected.kind === "fuel" ? "kg" : "units"})</span>
        <input type="number" data-industry-amount value={count} min={1} step={1} onChange={e => setCount(e.target.value)} />
      </label>
      <div className="industry__transfer-group">
        <Action action="withdraw" disabled={disabled || !validAmount || n > maxOut} onClick={() => transfer("withdraw", n)}><ArrowDownLeft size={14} aria-hidden /> Withdraw</Action>
        <Action action="withdraw-max" label={`Withdraw up to ${quantity(maxOut)}`} disabled={disabled || maxOut <= 0} onClick={() => transfer("withdraw", maxOut)}>Max {quantity(maxOut)}</Action>
      </div>
      <div className="industry__transfer-group">
        <Action action="deposit" disabled={disabled || !validAmount || n > maxIn} onClick={() => transfer("deposit", n)}><ArrowUpRight size={14} aria-hidden /> Deposit</Action>
        <Action action="deposit-max" label={`Deposit up to ${quantity(maxIn)}`} disabled={disabled || maxIn <= 0} onClick={() => transfer("deposit", maxIn)}>Max {quantity(maxIn)}</Action>
      </div>
    </div>
  </div>;
}

function Fabrication({ depot, droneCount, disabled, submit }: DepotControls & { droneCount: number }) {
  // Recipes consume the depot's manifest so the cooperating pilots see the same available stock.
  return <>
    <p>Deposit recipe materials in depot storage first.</p>
    <div className="industry__recipes">{DEPOT_RECIPES.map(recipe => {
      const installed = recipe.output === "refinery" && depot.refinery;
      const baysFull = recipe.output === "drone" && droneCount >= INDUSTRY_TUNING.dronesPerDepot;
      const enough = canAfford(recipe.recipe, depot.storage.items);
      return <section className="industry__recipe-row" key={recipe.id} data-industry-recipe={recipe.id}>
        <div>
          <h4>{recipe.name}</h4>
          <p>{recipe.description}</p>
          <Requirements items={recipe.recipe} have={depot.storage.items} />
          {baysFull && <small>All drone bays in use.</small>}
        </div>
        <Action primary action="fabricate" disabled={disabled || installed || baysFull || !enough}
          onClick={() => submit({ type: "depot.fabricate", depotId: depot.id, recipeId: recipe.id }, `${recipe.name} ready.`)}>
          {installed ? "Installed" : "Fabricate"}
        </Action>
      </section>;
    })}</div>
  </>;
}

const DRONE_STATUS: Record<DroneStatus, string> = {
  unassigned: "Choose a job to get started",
  paused: "Stopped at depot",
  needs_fuel: "Add propellant to this depot or lower the fuel reserve.",
  source_out_of_range: "This hydrate site is out of reach. Edit the job to collect from a nearby site or deliver supplies.",
  destination_full: "The receiving depot has no room for this delivery.",
  no_cargo: "Nothing to deliver. Add a listed item to this depot.",
  route_out_of_range: "The drone can't reach this destination. Edit the job to choose another.",
  extracting: "Collecting hydrates",
  delivering: "Delivering cargo",
  returning: "Returning to depot",
  unload_blocked: "Make room at this depot so the drone can unload.",
  departing: "Departing depot",
};

function DepotDrones({ depot, depots, drones, drafts, saveDraft, disabled, submit, onFabricate }: DepotControls & {
  depots: DepotRecord[]; drones: DroneRecord[]; drafts: ReadonlyMap<string, DroneDraft>;
  saveDraft: SaveDroneDraft; onFabricate: () => void;
}) {
  const homeDrones = drones.filter(drone => drone.homeId === depot.id);
  if (!homeDrones.length) return <div className="industry__empty">
    <Truck size={22} aria-hidden />
    <div><h4>No drones at this depot</h4><p>Build a drone to collect hydrates or deliver supplies.</p></div>
    <Action onClick={onFabricate}>View fabrication</Action>
  </div>;
  return <div className="industry__fleet">{homeDrones.map((drone, i) => <DroneControl
    key={drone.id} index={i + 1} drone={drone} draft={drafts.get(drone.id)} saveDraft={saveDraft}
    depot={depot} depots={depots} disabled={disabled} submit={submit}
  />)}</div>;
}

const defaultReserve = (kind: DroneJob["kind"]): number => kind === "haul" ? 10 : 0;
const maxJobLimit = Math.max(INDUSTRY_TUNING.cargoCapacity, INDUSTRY_TUNING.fuelCapacityKg);

function newDroneDraft(job: DroneJob | null, canExtract: boolean): DroneDraft {
  const kind = job?.kind ?? (canExtract ? "extract" : "haul");
  return {
    baseJob: job,
    kind,
    sourceId: job?.kind === "extract" ? job.targetId : "",
    destinationId: job?.kind === "haul" ? job.targetId : "",
    priorities: job?.kind === "haul" ? job.priorities : [],
    reserve: String(job?.reserveKg ?? defaultReserve(kind)),
    hydrateLimit: job?.kind === "extract" && job.stopAt < INDUSTRY_TUNING.cargoCapacity ? String(job.stopAt) : "",
    deliveryLimit: job?.kind === "haul" && job.stopAt < maxJobLimit ? String(job.stopAt) : "",
  };
}

function jobSettingsChanged(before: DroneJob | null, current: DroneJob | null): boolean {
  if (!before || !current) return before !== current;
  return before.kind !== current.kind || before.targetId !== current.targetId ||
    before.reserveKg !== current.reserveKg || before.stopAt !== current.stopAt ||
    before.priorities.length !== current.priorities.length || before.priorities.some((id, i) => id !== current.priorities[i]);
}

function droneStatus(drone: DroneRecord, depot: DepotRecord, depots: DepotRecord[], destination?: DepotRecord): string {
  const { job, status } = drone;
  if (!job) return DRONE_STATUS[status];
  if (status === "needs_fuel") {
    const source = job.kind === "extract" ? INDUSTRY_SOURCES.find(source => source.id === job.targetId) : undefined;
    const route = source ? estimateDroneExtractionRoute(depot, source, depots) : destination && estimateDroneRoute(depot, destination);
    if (route) {
      const shortKg = Math.ceil(job.reserveKg + route.roundTripFuelKg - depot.storage.fuelKg);
      if (shortKg > 0) return `Add ${quantity(shortKg)} kg of propellant to this depot or lower the fuel reserve.`;
    }
  }
  if (status === "no_cargo" && job.kind === "extract") return "The site is short on hydrates. The drone will try again as more become available.";
  if (status === "no_cargo" && job.priorities.length === 1 && job.priorities[0] === propellantId) {
    return "No spare fuel to deliver. Add propellant or lower the fuel reserve.";
  }
  if (status === "destination_full" && job.kind === "extract") {
    if (job.stopAt < INDUSTRY_TUNING.cargoCapacity && (depot.storage.items.hydrates ?? 0) >= job.stopAt) {
      return `Hydrate limit reached (${quantity(job.stopAt)} units). Withdraw hydrates or edit the job to change the limit.`;
    }
    return "Depot cargo hold is full. Withdraw cargo to collect more hydrates.";
  }
  if (status === "destination_full" && destination) {
    const holdFull = storageUnits(destination.storage) >= INDUSTRY_TUNING.cargoCapacity;
    const tankFull = destination.storage.fuelKg >= INDUSTRY_TUNING.fuelCapacityKg;
    if (job.stopAt >= maxJobLimit || job.priorities.every(id => id === propellantId ? tankFull : holdFull)) {
      return "The receiving depot is full. Withdraw supplies there to free up space.";
    }
    return "The receiving depot has reached your delivery limit. Withdraw supplies there or edit the limit.";
  }
  return DRONE_STATUS[status];
}

function DroneControl({ index, drone, depot, depots, draft, saveDraft, disabled, submit }: DepotControls & {
  index: number; drone: DroneRecord; depots: DepotRecord[]; draft?: DroneDraft; saveDraft: SaveDroneDraft;
}) {
  const job = drone.job;
  const sources = INDUSTRY_SOURCES.flatMap(source => {
    const estimate = estimateDroneExtractionRoute(depot, source, depots);
    return estimate ? [{ ...source, estimate }] : [];
  });
  const editing = !job || !!draft;
  const values = draft ?? newDroneDraft(job, sources.length > 0);
  const { kind, priorities, reserve, hydrateLimit, deliveryLimit } = values;
  const update = (changes: Partial<DroneDraft>) => saveDraft(drone.id, { ...values, ...changes });
  const stale = !!draft && jobSettingsChanged(draft.baseJob, job);
  const options = kind === "extract" ? sources : editing ? depots.flatMap(target => {
    const estimate = target.id !== depot.id && estimateDroneRoute(depot, target);
    return estimate ? [{ ...target, estimate }] : [];
  }) : [];
  const targetId = kind === "extract" ? values.sourceId || options[0]?.id : values.destinationId;
  const chosen = options.find(option => option.id === targetId);
  const unavailableTarget = targetId && !chosen && (kind === "extract" ? INDUSTRY_SOURCES : depots).find(target => target.id === targetId);
  const estimate = chosen?.estimate;
  const activeTrip = drone.phase !== "idle";
  const editable = !disabled && !activeTrip;
  const validReserve = reserve.trim() !== "" && Number.isFinite(Number(reserve)) && Number(reserve) >= 0 && Number(reserve) <= INDUSTRY_TUNING.fuelCapacityKg;
  const limit = (kind === "extract" ? hydrateLimit : deliveryLimit).trim();
  const maxLimit = kind === "extract" ? INDUSTRY_TUNING.cargoCapacity : maxJobLimit;
  const stopAt = limit === "" ? maxLimit : Number(limit);
  const validStop = !limit || (/^\d+$/.test(limit) && stopAt > 0 && stopAt <= maxLimit);
  const canStart = editable && !stale && !!chosen && validReserve && validStop && (kind === "extract" || priorities.length > 0);
  const destination = depots.find(target => target.id === job?.targetId);
  const jobTarget = job?.kind === "extract" ? INDUSTRY_SOURCES.find(source => source.id === job.targetId) : destination;
  const targetName = jobTarget?.name ?? "Destination unavailable";
  const canResume = job && !job.enabled && (job.kind === "extract"
    ? sources.some(source => source.id === job.targetId)
    : !!(destination && estimateDroneRoute(depot, destination)));
  const payload = [
    ...(drone.cargo.fuelKg > 0 ? [`${quantity(drone.cargo.fuelKg)} kg propellant`] : []),
    ...Object.entries(drone.cargo.items).map(([id, n]) => `${quantity(n)} ${stockName(id)}`),
  ];
  const send = (next: DroneJob, message: string, onAccepted?: () => void) =>
    submit({ type: "drone.configure", droneId: drone.id, job: next }, message, onAccepted);
  const discard = () => saveDraft(drone.id, null);
  const move = (index: number, offset: number) => {
    const reordered = priorities.slice();
    [reordered[index], reordered[index + offset]] = [reordered[index + offset], reordered[index]];
    update({ priorities: reordered });
  };

  return <section className="industry__drone" data-industry-drone={drone.id}>
    <header className="industry__drone-head">
      <div>
        <h4><Truck size={16} aria-hidden /> Drone {index}</h4>
        <p data-industry-drone-status={drone.status}>{droneStatus(drone, depot, depots, destination)}</p>
      </div>
      {activeTrip && <span className="industry__time">{formatDuration(Math.ceil(drone.remainingS))}</span>}
    </header>
    {job && <div className="industry__route">
      <span>{job.kind === "extract" ? "Collect" : "Deliver"} <strong>{job.priorities.map(stockName).join(", ")}</strong></span>
      <span>{job.kind === "extract" ? "from" : "to"} <strong>{targetName}</strong></span>
      <span>{job.kind === "extract"
        ? job.stopAt < INDUSTRY_TUNING.cargoCapacity ? `Hydrate limit: ${quantity(job.stopAt)} units` : "Uses all free cargo space"
        : job.stopAt < maxJobLimit ? `Delivery limit: ${quantity(job.stopAt)} per item (units or kg)` : "Uses all free space at the receiving depot"}</span>
      {!job.enabled && activeTrip && <span>Stopping after this trip</span>}
      {payload.length > 0 && <span>Carrying {payload.join(", ")}</span>}
      {drone.fuelKg > 0 && <span>{quantity(drone.fuelKg)} kg reserved for return</span>}
    </div>}
    {job && <div className="industry__line industry__drone-controls">
      <Action action="edit-job" disabled={editing ? disabled : !editable}
        onClick={() => editing ? discard() : saveDraft(drone.id, values)}>{editing ? "Cancel edit" : "Edit job"}</Action>
      {job.enabled && <Action action="stop-job" disabled={disabled}
        onClick={() => send({ ...job, enabled: false }, activeTrip ? "Stop requested." : "Drone stopped.")}>
        {activeTrip ? "Stop after trip" : "Stop job"}
      </Action>}
      {!job.enabled && <Action action="resume-job" primary disabled={!editable || !canResume} onClick={() => send({ ...job, enabled: true }, "Job resumed.")}>Resume job</Action>}
    </div>}
    {editing && <div className="industry__job">
      {stale && <div className="industry__job-review">
        <p className="industry__warning" role="status">The saved job changed while you were editing.</p>
        <div className="industry__line industry__drone-controls">
          <Action action="use-current-job" disabled={disabled} onClick={discard}>Use current job</Action>
          <Action action="keep-job-draft" disabled={disabled} onClick={() => update({ baseJob: job })}>Keep my edits</Action>
        </div>
      </div>}
      <div className="industry__form-row">
        <label>Job<select data-industry-job-kind value={kind} disabled={!editable} onChange={e => {
          const next = e.target.value === "extract" ? "extract" : "haul";
          update({ kind: next, reserve: !job && Number(reserve) === defaultReserve(kind) ? String(defaultReserve(next)) : reserve });
        }}>
          {(sources.length > 0 || kind === "extract") && <option value="extract">Collect hydrates</option>}<option value="haul">Deliver supplies</option>
        </select></label>
        <label>{kind === "extract" ? "Hydrate site" : "Receiving depot"}
          <select data-industry-job-target value={chosen?.id ?? (unavailableTarget ? unavailableTarget.id : "")} disabled={!editable || !options.length}
            onChange={e => update(kind === "extract" ? { sourceId: e.target.value } : { destinationId: e.target.value })}>
            {unavailableTarget ? <option value={unavailableTarget.id} disabled>{unavailableTarget.name} (out of reach)</option>
              : !chosen && <option value="" disabled>{options.length ? "Choose a depot" : kind === "haul" ? "No reachable depot" : "No reachable site"}</option>}
            {options.map(option => <option key={option.id} value={option.id}>
              {option.name} ({formatDistance(option.estimate.pathKm)})
            </option>)}
          </select>
        </label>
      </div>
      {sources.length === 0 && <p>No hydrate site is in range.</p>}
      {kind === "haul" && options.length === 0 && <p className="industry__warning">{depots.length === 1
        ? `Build another depot within ${formatDistance(INDUSTRY_TUNING.maxRouteKm)} in this region to set up a delivery.`
        : `No reachable depot in this region. Delivery routes can span up to ${formatDistance(INDUSTRY_TUNING.maxRouteKm)}.`}</p>}
      {kind === "haul" && options.length > 0 && <div className="industry__priority">
        <label>Items to deliver
          <select data-industry-job-filter disabled={!editable} value="" onChange={e => {
            const value = e.target.value;
            if (value) update({ priorities: [...priorities, value] });
          }}>
            <option value="">Add an item</option>
            {[propellantId, ...Object.keys(MATERIAL_NAMES)].filter(id => !priorities.includes(id)).map(id =>
              <option key={id} value={id}>{stockName(id)}</option>
            )}
          </select>
        </label>
        {priorities.length > 0 ? <><ol aria-label="Loading order">
          {priorities.map((id, i) => <li key={id}>
            <span>{stockName(id)}</span>
            <button type="button" title="Move up" aria-label={`Move ${stockName(id)} up`} disabled={!editable || i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} aria-hidden /></button>
            <button type="button" title="Move down" aria-label={`Move ${stockName(id)} down`} disabled={!editable || i === priorities.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} aria-hidden /></button>
            <button type="button" disabled={!editable} aria-label={`Remove ${stockName(id)}`} onClick={() => update({ priorities: priorities.filter(item => item !== id) })}>Remove</button>
          </li>)}
        </ol>
        {priorities.length > 1 && <small>The drone tries the first item on the list before moving to the next.</small>}
        </> : <small>Add at least one item to start this job.</small>}
      </div>}
      <div className="industry__form-row">
        <label>Fuel to keep here (kg)<input data-industry-job-reserve aria-describedby={`reserve-${drone.id}`} type="number" min={0} max={INDUSTRY_TUNING.fuelCapacityKg} step="any" value={reserve}
          disabled={!editable} onChange={e => update({ reserve: e.target.value })} /><small id={`reserve-${drone.id}`}>Stays at this depot after the drone takes fuel for the round trip.</small></label>
        <div className="industry__job-limit">
          <label>{kind === "extract" ? "Hydrate limit (optional)" : "Delivery limit per item (optional)"}
            <input data-industry-job-stop aria-describedby={`stop-${drone.id}`} aria-invalid={!validStop} inputMode="numeric"
              value={kind === "extract" ? hydrateLimit : deliveryLimit} placeholder="Use all free space"
              disabled={!editable} onChange={e => update(kind === "extract" ? { hydrateLimit: e.target.value } : { deliveryLimit: e.target.value })} />
            <small id={`stop-${drone.id}`} className={validStop ? undefined : "industry__warning"}>{!validStop
              ? `Enter a whole number from 1 to ${quantity(maxLimit)}, or leave blank.`
              : kind === "extract" ? "Maximum hydrate units at this depot." : "Maximum of each item at the receiving depot (units or kg)."}</small>
          </label>
          {kind === "extract" && hydrateLimit !== "" && <Action action="clear-hydrate-limit" disabled={!editable} onClick={() => update({ hydrateLimit: "" })}>Use all free space</Action>}
        </div>
      </div>
      {estimate && <div className="industry__estimate">
        <span>{formatDuration(2 * estimate.legSeconds + (kind === "extract" ? INDUSTRY_TUNING.extractSeconds : INDUSTRY_TUNING.deliverySeconds))} round trip</span>
        <span>{quantity(estimate.roundTripFuelKg)} kg flight fuel</span>
        {validReserve && <span>{quantity(estimate.roundTripFuelKg + Number(reserve))} kg needed to depart</span>}
      </div>}
      {estimate && validReserve && estimate.roundTripFuelKg + Number(reserve) > depot.storage.fuelKg &&
        <p className="industry__warning">Add propellant in Storage so the drone can depart.</p>}
      <Action primary action="start-job" disabled={!canStart}
        onClick={() => {
          if (!canStart || !chosen) return;
          const cargo = kind === "extract" ? ["hydrates"] : priorities;
          send({ kind, targetId: chosen.id, priorities: cargo, reserveKg: Number(reserve), stopAt, enabled: true }, "Drone job saved.", discard);
        }}>
        {job ? "Save and start" : "Start job"}
      </Action>
    </div>}
  </section>;
}
