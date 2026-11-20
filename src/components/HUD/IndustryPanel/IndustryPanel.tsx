"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowDownLeft, ArrowUp, ArrowUpRight, Box, Crosshair, Factory, Fuel, MapPin, Pencil, PackagePlus, Radio, Truck } from "lucide-react";
import { getItemDef, industryResearchNode, MATERIAL_NAMES, materialName } from "@/data/content";
import { playAudio } from "@/audio/voices";
import { getLocalPlayerShip } from "@/sim/entities";
import { isFrameId } from "@/sim/frames";
import { DRONE_FUEL_ID, DEPOT_KIT_ID, DEPOT_RECIPES, INDUSTRY_SOURCES, INDUSTRY_TUNING, POINT_TANK_CAPACITY_KG } from "@/sim/industry/catalog";
import { sameDroneAssignment, type DepotRecord, type DroneJob, type DroneRecord, type DroneStatus } from "@/sim/industry/types";
import { checkDroneRoute, estimateDroneExtractionRoute } from "@/sim/industry/route";
import { depotDistanceKm } from "@/sim/industry/placement";
import { miningFieldsAt } from "@/sim/industry/mining";
import { planDroneHaul, planDronePointDelivery, storageUnits } from "@/sim/industry/simulation";
import type { ShipPose } from "@/save/types";
import { formatDistance, formatDuration } from "@/sim/units";
import { activeSystem } from "@/sim/systemRegistry";
import type { WorldOperation } from "@/sim/world/commands";
import { cargoAtom, cargoRemainingUnitsAtom } from "@/store/cargo";
import { industryAtom } from "@/store/industry";
import { depotPoi, nextDepotName, trackIndustryPoiAtom } from "@/store/industryHud";
import { modulesAtom } from "@/store/modules";
import { newOpId, runOperation } from "@/store/operations";
import { shipReq, shipResourcesHudAtom } from "@/store/shipResources";
import { targetedPOIAtom, transitDriveOwnedAtom } from "@/store/transit";
import type { POIDef } from "@/store/poi";
import { replicationPointsAtom, playerReplicationAtom } from "@/store/replication";
import { completedNodeSetAtom } from "@/store/research";
import { IndustryResearchRequirement } from "../ResearchPanel/ResearchPanel";
import StructureNameEditor, { type NamedStructure } from "./StructureNameEditor";
import PointFuelControls from "./PointFuelControls";
import RequestDelivery, { DELIVERY_ROUTE_REASON, type DeliveryTarget } from "./RequestDelivery";
import DroneMiningFilters, { miningFilterForField, type MiningField, type MiningFilterDraft } from "./DroneMiningFilters";
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
type DeliveryTargetRef = Pick<DeliveryTarget, "kind" | "id">;
type JobKind = Exclude<DroneJob["kind"], "extract">;

type DroneDraft = {
  baseJob: DroneJob | null;
  onlyIfUnassigned?: true;
  kind: JobKind;
  fieldId: string;
  mineFilter: MiningFilterDraft;
  destinationId: string;
  destinationKind: DeliveryTarget["kind"];
  priorities: string[];
  reserve: string;
  miningLimit: string;
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
  const mines = drones.some(drone => drone.homeId === depot.id && (drone.job?.kind === "mine" || drone.job?.kind === "extract"));
  if (depot.refinery) return mines ? "Refinery · Asteroid mining" : "Refinery";
  return mines ? "Asteroid mining" : "Storage depot";
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
  pointFuelId?: string;
  build?: boolean;
  initialName?: string;
  onClose: () => void;
  onAim: (name: string) => void;
};

export default function IndustryPanel({ initialDepotId, renamePointId, pointFuelId, initialName, build, onClose, onAim }: IndustryPanelProps) {
  const { depots, drones, pointTanks } = useAtomValue(industryAtom);
  const points = useAtomValue(replicationPointsAtom).filter(point => !point.starter);
  const deliveryTargets: DeliveryTarget[] = [
    ...depots.map(depot => ({ ...depot, kind: "depot" as const, depot })),
    ...points.flatMap(point => Object.hasOwn(pointTanks, point.id) ? [{ ...point, kind: "point" as const, fuelKg: pointTanks[point.id] }] : []),
  ];
  const activePoint = useAtomValue(playerReplicationAtom).activeId;
  const [showPoints, setShowPoints] = useState(!!renamePointId || !!pointFuelId);
  const [renaming, setRenaming] = useState<NamedStructure | null>(() => {
    const point = points.find(point => point.id === renamePointId);
    return point ? { kind: "point", id: point.id, name: point.name } : null;
  });
  const position = usePosition();
  const nearest = depots.reduce<DepotRecord | undefined>((best, depot) => !best || distance(position, depot) < distance(position, best) ? depot : best, undefined);
  const [selected, select] = useState(build ? null : initialDepotId ?? nearest?.id ?? null);
  const [view, setView] = useState<"storage" | "fabrication" | "drones">("storage");
  const [deliveryRequest, setDeliveryRequest] = useState<DeliveryTargetRef | null>(null);
  const [focusedDrone, focusDrone] = useState<string | null>(null);
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
  const roster = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const list = roster.current;
    const active = list?.querySelector('[aria-current="true"]');
    if (!list || !active) return;
    const viewport = list.getBoundingClientRect();
    const entry = active.getBoundingClientRect();
    const left = viewport.left + list.clientLeft;
    const top = viewport.top + list.clientTop;
    // Reveal the selection in this scrollport alone. The details and focus keep their own position.
    if (entry.left < left) list.scrollLeft += entry.left - left;
    else if (entry.right > left + list.clientWidth) list.scrollLeft += entry.right - left - list.clientWidth;
    if (entry.top < top) list.scrollTop += entry.top - top;
    else if (entry.bottom > top + list.clientHeight) list.scrollTop += entry.bottom - top - list.clientHeight;
  }, [depots.length, points.length, renaming, selected, showPoints]);
  useEffect(() => {
    const dialog = (content.current ?? renameForm.current)?.closest(".panel");
    if (!dialog) return;
    dialog.querySelector<HTMLElement>('[aria-current="true"]')?.focus({ preventScroll: true });
    const cycleFocus = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), summary"))
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
    setDeliveryRequest(null);
    focusDrone(null);
    setFeedback(null);
  };
  const receivingAt = deliveryTargets.find(target => target.kind === deliveryRequest?.kind && target.id === deliveryRequest.id);
  const prepareDelivery = (drone: DroneRecord) => {
    if (!receivingAt || drone.job || drone.phase !== "idle" || droneDrafts.has(drone.id)) return;
    saveDroneDraft(drone.id, {
      ...newDroneDraft(null, false),
      onlyIfUnassigned: true,
      destinationId: receivingAt.id,
      destinationKind: receivingAt.kind,
    });
    selectDepot(drone.homeId);
    setView("drones");
    focusDrone(drone.id);
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
        <nav ref={roster} className="industry__roster" aria-label="Industry locations">
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
            aria-current={showPoints} onClick={() => { setShowPoints(true); setDeliveryRequest(null); setFeedback(null); }}>
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
                  {inRange ? "Ship transfers available" : "Remote management"}
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
                  setDeliveryRequest(null);
                  focusDrone(null);
                  setFeedback(null);
                }}>{label}</button>
              )}
            </div>
          </>}
          {receivingAt ? <RequestDelivery key={receivingAt.id} target={receivingAt} depots={depots} drones={drones}
            draftIds={new Set(droneDrafts.keys())} onCancel={() => setDeliveryRequest(null)} onChoose={prepareDelivery} />
            : showPoints ? <div className="industry__content">
            <h3>Replication points</h3>
            <ul className="industry__points">{points.map(point => <li key={point.id}>
              <div className="industry__line">
                <div><strong>{point.name}</strong><small>{point.id === activePoint ? "Active · " : ""}{formatDistance(distance(position, point))} away</small></div>
                <Action label={`Rename replication point ${point.name}`} onClick={() => setRenaming({ kind: "point", id: point.id, name: point.name })}>
                  <Pencil size={14} aria-hidden /> Rename
                </Action>
              </div>
              <PointFuelControls point={point} inRange={distance(position, point) <= INDUSTRY_TUNING.interactRangeKm}
                initiallyOpen={point.id === pointFuelId} onRequestFuel={() => setDeliveryRequest({ kind: "point", id: point.id })} />
            </li>)}</ul>
          </div> : depot && view === "storage" ? <DepotStorage key={depot.id} depot={depot} inRange={inRange} disabled={!inRange || pending} submit={submit}
            feedback={operationFeedback} onRequestDelivery={() => setDeliveryRequest({ kind: "depot", id: depot.id })} />
            : <>{depot ? <div className="industry__content" key={`${depot.id}:${view}`}>
              {view === "fabrication" && <Fabrication depot={depot} droneCount={drones.filter(drone => drone.homeId === depot.id).length} disabled={pending} submit={submit} />}
              {view === "drones" && <DepotDrones depot={depot} depots={depots} targets={deliveryTargets} drones={drones} drafts={droneDrafts} focusedDrone={focusedDrone}
                saveDraft={saveDroneDraft} disabled={pending} submit={submit} onFabricate={() => setView("fabrication")} />}
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
  const blueprintKnown = useAtomValue(completedNodeSetAtom).has(industryResearchNode("depot_kit").id);
  const ready = blueprintKnown && !!kitDef && kits < (kitDef.stackMax ?? Infinity) && canAfford(recipe, items);
  const slotsFull = depots.length >= INDUSTRY_TUNING.maxDepots;
  const fields = activeSystem().asteroidFields.filter(field => field.enabled !== false && field.resources).map(field => {
    const frameId = field.anchorBody && field.anchorOffsetKm && isFrameId(field.anchorBody) ? field.anchorBody : undefined;
    const positionKm = frameId && field.anchorOffsetKm ? field.anchorOffsetKm : field.anchorKm;
    const poi: POIDef = { id: `field:${field.id}`, name: field.name, frameId, positionKm, minDistanceKm: 0, maxDistanceKm: Infinity };
    const km = distance(position, { frameId: frameId ?? "system", positionKm });
    const classes = [...(field.resources?.classes ?? []), ...(field.resources?.pockets ?? []).flatMap(pocket => pocket.classes)];
    const hydrates = classes.some(group => group.resources.some(entry => entry.resourceId === "hydrates" && entry.max > 0));
    return { field, poi, km, hydrates };
  }).sort((a, b) => a.km - b.km);

  return <div className="industry__content industry__build">
    <h3>Build a depot</h3>
    <p>Store supplies, fabricate equipment, and assign drones to mine or deliver cargo.</p>
    <div className="industry__build-steps">
      <section>
        <h4>1. Fabricate a depot kit</h4>
        <IndustryResearchRequirement blueprint="depot_kit" />
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
        <p>Choose a clear location. Build near an asteroid field to give mining drones access to nearby rocks. A refinery turns hydrates into propellant.</p>
        <div className="industry__sources">
          {fields.map(({ field, poi, km, hydrates }) => <div className="industry__line" key={field.id}>
            <span><MapPin size={14} aria-hidden /> {field.name}<small>{Number.isFinite(km) ? `${formatDistance(km)} away` : "Position unavailable"}{hydrates && " · Hydrate-bearing field"}</small></span>
            <Action action={`track-${field.id}`} onClick={() => navigate(poi)}>{trackedId === poi.id ? "Untrack" : "Track"}</Action>
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

function DepotStorage({ depot, inRange, disabled, submit, feedback, onRequestDelivery }: DepotControls & {
  inRange: boolean; feedback: ReactNode; onRequestDelivery: () => void;
}) {
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
  const fuelTankFull = INDUSTRY_TUNING.fuelCapacityKg - storage.fuelKg < INDUSTRY_TUNING.refineKgPerHydrate;
  return <div className="industry__storage">
    <div className="industry__content">
      <div className="industry__capacity">
        <span><Fuel size={14} aria-hidden /> Fuel {quantity(storage.fuelKg)} / {quantity(INDUSTRY_TUNING.fuelCapacityKg)} kg</span>
        <span><Box size={14} aria-hidden /> Cargo {quantity(holdUsed)} / {quantity(INDUSTRY_TUNING.cargoCapacity)} units</span>
      </div>
      {depot.refinery && <p className="industry__operation">{(storage.items.hydrates ?? 0) < 1 ? "Refinery waiting for hydrates."
        : fuelTankFull ? "Refinery waiting for room in the fuel tank." : "Refinery turning hydrates into propellant."}</p>}
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
      <div className="industry__line industry__storage-delivery">
        {!inRange && <small>Fly within {formatDistance(INDUSTRY_TUNING.interactRangeKm)} to transfer cargo or propellant with your ship.</small>}
        <Action action="request-delivery" onClick={onRequestDelivery}>Request delivery</Action>
      </div>
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
  const completed = useAtomValue(completedNodeSetAtom);
  return <>
    <p>Deposit recipe materials in depot storage first.</p>
    <div className="industry__recipes">{DEPOT_RECIPES.map(recipe => {
      const installed = recipe.output === "refinery" && depot.refinery;
      const baysFull = recipe.output === "drone" && droneCount >= INDUSTRY_TUNING.dronesPerDepot;
      const enough = canAfford(recipe.recipe, depot.storage.items);
      const locked = !!recipe.blueprint && !completed.has(industryResearchNode(recipe.blueprint).id);
      return <section className="industry__recipe-row" key={recipe.id} data-industry-recipe={recipe.id}>
        <div>
          <h4>{recipe.name}</h4>
          <p>{recipe.description}</p>
          {recipe.blueprint && locked && !installed && <IndustryResearchRequirement blueprint={recipe.blueprint} />}
          <Requirements items={recipe.recipe} have={depot.storage.items} />
          {baysFull && <small>All drone bays in use.</small>}
        </div>
        <Action primary action="fabricate" disabled={disabled || locked || installed || baysFull || !enough}
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
  source_out_of_range: "The mining area is out of reach. Edit the job to choose another field or deliver supplies.",
  destination_full: "The receiving depot has no room for this delivery.",
  no_cargo: "Nothing to deliver. Add a listed item to this depot.",
  route_out_of_range: "The drone can't reach this destination. Edit the job to choose another.",
  extracting: "Collecting hydrates",
  delivering: "Delivering cargo",
  returning: "Returning to depot",
  unload_blocked: "Make room at this depot so the drone can unload.",
  departing: "Departing depot",
  searching: "Searching nearby for an asteroid",
  no_matching_rock: "No suitable asteroid nearby. Change the filter or use a depot near other rocks.",
  mining: "Mining asteroid",
};

function DepotDrones({ depot, depots, targets, drones, drafts, focusedDrone, saveDraft, disabled, submit, onFabricate }: DepotControls & {
  depots: DepotRecord[]; targets: DeliveryTarget[]; drones: DroneRecord[]; drafts: ReadonlyMap<string, DroneDraft>;
  focusedDrone: string | null; saveDraft: SaveDroneDraft; onFabricate: () => void;
}) {
  const miningUnlocked = useAtomValue(completedNodeSetAtom).has(industryResearchNode("mining").id);
  const homeDrones = drones.filter(drone => drone.homeId === depot.id);
  if (!homeDrones.length) return <div className="industry__empty">
    <Truck size={22} aria-hidden />
    <div><h4>No drones at this depot</h4><p>Build a drone to mine nearby asteroids or deliver supplies.</p></div>
    <Action onClick={onFabricate}>View fabrication</Action>
  </div>;
  const fields = miningFieldsAt(depot);
  return <div className="industry__fleet">{homeDrones.map((drone, i) => <DroneControl
    key={drone.id} index={i + 1} drone={drone} draft={drafts.get(drone.id)} saveDraft={saveDraft}
    depot={depot} depots={depots} targets={targets} fields={fields} miningUnlocked={miningUnlocked} focusRequested={focusedDrone === drone.id}
    disabled={disabled} submit={submit}
  />)}</div>;
}

const defaultReserve = (kind: DroneJob["kind"]): number => kind === "haul" ? 10 : 0;
const maxJobLimit = Math.max(INDUSTRY_TUNING.cargoCapacity, INDUSTRY_TUNING.fuelCapacityKg);

function newDroneDraft(job: DroneJob | null, preferMining: boolean): DroneDraft {
  const legacySource = job?.kind === "extract" ? INDUSTRY_SOURCES.find(source => source.id === job.targetId) : undefined;
  const mineFilter = job?.mineFilter;
  const kind = job?.kind === "extract" ? "mine" : job?.kind ?? (preferMining ? "mine" : "haul");
  const destinationKind = job?.targetKind ?? "depot";
  return {
    baseJob: job,
    kind,
    fieldId: job?.kind === "mine" ? job.targetId : legacySource?.fieldId ?? "",
    mineFilter: {
      mode: mineFilter?.mode ?? (legacySource ? "resource" : "all"),
      classes: mineFilter?.mode === "class" ? mineFilter.ids : [],
      resources: mineFilter?.mode === "resource" ? mineFilter.ids : legacySource ? [legacySource.materialId] : [],
    },
    destinationId: job?.kind === "haul" ? job.targetId : "",
    destinationKind,
    priorities: job?.kind === "haul" && destinationKind === "depot" ? job.priorities : [],
    reserve: String(job?.reserveKg ?? defaultReserve(kind)),
    miningLimit: job && job.kind !== "haul" && job.stopAt < INDUSTRY_TUNING.cargoCapacity ? String(job.stopAt) : "",
    deliveryLimit: job?.kind === "haul" && job.stopAt < (destinationKind === "point" ? POINT_TANK_CAPACITY_KG : maxJobLimit) ? String(job.stopAt) : "",
  };
}

function droneStatus(drone: DroneRecord, depot: DepotRecord, depots: DepotRecord[], destination?: DeliveryTarget): string {
  const { job, status } = drone;
  if (!job) return DRONE_STATUS[status];
  if (status === "route_out_of_range" && destination) {
    const { reason } = checkDroneRoute(depot, destination);
    if (reason) return `${DELIVERY_ROUTE_REASON[reason]}. Edit the job to choose another destination.`;
  }
  if (status === "needs_fuel") {
    const source = job.kind === "extract" ? INDUSTRY_SOURCES.find(source => source.id === job.targetId) : undefined;
    const route = source ? estimateDroneExtractionRoute(depot, source, depots) : destination && checkDroneRoute(depot, destination).route;
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
    if (destination.kind === "point") return destination.fuelKg >= POINT_TANK_CAPACITY_KG
      ? "The replication tank is full." : "The replication tank has reached your delivery limit.";
    const { storage } = destination.depot;
    const holdFull = storageUnits(storage) >= INDUSTRY_TUNING.cargoCapacity;
    const tankFull = storage.fuelKg >= INDUSTRY_TUNING.fuelCapacityKg;
    if (job.stopAt >= maxJobLimit || job.priorities.every(id => id === propellantId ? tankFull : holdFull)) {
      return "The receiving depot is full. Withdraw supplies there to free up space.";
    }
    return "The receiving depot has reached your delivery limit. Withdraw supplies there or edit the limit.";
  }
  if (status === "destination_full" && job.kind === "mine") return "Make room at this depot or raise the mining storage limit.";
  return DRONE_STATUS[status];
}

function DroneControl({ index, drone, depot, depots, targets, fields, miningUnlocked, focusRequested, draft, saveDraft, disabled, submit }: DepotControls & {
  index: number; drone: DroneRecord; depots: DepotRecord[]; targets: DeliveryTarget[]; fields: MiningField[];
  miningUnlocked: boolean; focusRequested: boolean; draft?: DroneDraft; saveDraft: SaveDroneDraft;
}) {
  const job = drone.job;
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!focusRequested) return;
    card.current?.scrollIntoView({ block: "start" });
    card.current?.querySelector<HTMLElement>("[data-industry-job-target]")?.focus({ preventScroll: true });
  }, [focusRequested]);
  const canMine = miningUnlocked;
  const editing = !job || !!draft;
  const values = draft ?? newDroneDraft(job, canMine && fields.length > 0);
  const { kind, priorities, reserve, miningLimit, deliveryLimit } = values;
  const update = (changes: Partial<DroneDraft>) => saveDraft(drone.id, { ...values, ...changes });
  const stale = !!draft && !sameDroneAssignment(draft.baseJob, job);
  const deliveries = editing && kind === "haul" ? targets.filter(target => target.kind !== "depot" || target.id !== depot.id).map(target => ({
    target, ...checkDroneRoute(depot, target),
  })) : [];
  const delivery = deliveries.find(({ target }) => target.id === values.destinationId && target.kind === values.destinationKind);
  const options = deliveries.filter(entry => entry.route);
  const unavailableDeliveries = deliveries.flatMap(({ target, reason }) =>
    reason && reason !== "different_frame" && target !== delivery?.target ? [{ id: target.id, name: target.name, label: DELIVERY_ROUTE_REASON[reason] }] : []);
  const estimate = delivery?.route;
  const pointDelivery = delivery?.target.kind === "point";
  const field = fields.find(entry => entry.id === (values.fieldId || fields[0]?.id));
  const mineFilter = field && miningFilterForField(field, values.mineFilter);
  const activeTrip = drone.phase !== "idle";
  const editable = !disabled && !activeTrip;
  const reserveKg = Number(reserve);
  const validReserve = reserve.trim() !== "" && Number.isFinite(reserveKg) && reserveKg >= 0 && reserveKg <= INDUSTRY_TUNING.fuelCapacityKg;
  const limit = (kind === "mine" ? miningLimit : deliveryLimit).trim();
  const maxLimit = kind === "mine" ? INDUSTRY_TUNING.cargoCapacity : pointDelivery ? POINT_TANK_CAPACITY_KG : maxJobLimit;
  const stopAt = limit === "" ? maxLimit : Number(limit);
  const validStop = !limit || (/^\d+$/.test(limit) && stopAt > 0 && stopAt <= maxLimit);
  const jobBasics = { reserveKg, stopAt, enabled: true };
  let nextJob: DroneJob | null = null;
  if (validReserve && validStop) {
    if (kind === "mine" && canMine && field && mineFilter) nextJob = { ...jobBasics, kind, targetId: field.id, mineFilter, priorities: [] };
    if (kind === "haul" && delivery?.route && (pointDelivery || priorities.length > 0)) nextJob = {
      ...jobBasics, kind, targetId: delivery.target.id, ...(pointDelivery && { targetKind: "point" as const }),
      priorities: pointDelivery ? [propellantId] : priorities,
    };
  }
  const flightPlan = estimate && nextJob && delivery && (delivery.target.kind === "point"
    ? planDronePointDelivery(depot, delivery.target.fuelKg, nextJob, estimate)
    : planDroneHaul(depot, delivery.target.depot, nextJob, estimate));
  const plannedLoad = flightPlan && flightPlan.load ? flightPlan : null;
  const flightFuelKg = plannedLoad?.load.roundTripFuelKg ?? estimate?.roundTripFuelKg ?? 0;
  const minimumDepotFuelKg = (estimate?.roundTripFuelKg ?? 0) + reserveKg;
  const requiredDepotFuelKg = flightFuelKg + reserveKg + (plannedLoad?.itemId === propellantId ? plannedLoad.load.amount : 0);
  const overDepotCapacity = !plannedLoad && validReserve && minimumDepotFuelKg > INDUSTRY_TUNING.fuelCapacityKg;
  const needsFuel = !plannedLoad && validReserve && (minimumDepotFuelKg > depot.storage.fuelKg || flightPlan && flightPlan.status === "needs_fuel");
  const canStart = editable && !stale && !!nextJob && !overDepotCapacity;
  const destination = job?.kind === "haul" ? targets.find(target => target.id === job.targetId && target.kind === (job.targetKind ?? "depot")) : undefined;
  const savedField = job?.kind === "mine" ? fields.find(entry => entry.id === job.targetId) : undefined;
  const legacySite = job?.kind === "extract" ? INDUSTRY_SOURCES.find(source => source.id === job.targetId) : undefined;
  const targetName = (destination ?? savedField ?? legacySite)?.name ?? "Destination unavailable";
  const canResume = job && !job.enabled && (savedField || (legacySite && estimateDroneExtractionRoute(depot, legacySite, depots)) ||
    (destination && checkDroneRoute(depot, destination).route));
  const savedFilter = job?.mineFilter;
  const miningSummary = savedFilter && savedFilter.mode !== "all"
    ? savedFilter.ids.map(id => savedFilter.mode === "class" ? savedField?.classes.find(entry => entry.id === id)?.name ?? id : stockName(id)).join(", ")
    : "All asteroids";
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

  return <section className="industry__drone" data-industry-drone={drone.id} ref={card}>
    <header className="industry__drone-head">
      <div>
        <h4><Truck size={16} aria-hidden /> Drone {index}</h4>
        <p data-industry-drone-status={drone.status}>{droneStatus(drone, depot, depots, destination)}</p>
      </div>
      {activeTrip && <span className="industry__time">{formatDuration(Math.ceil(drone.remainingS))}</span>}
    </header>
    {job && <div className="industry__route">
      <span>{job.kind === "mine" ? "Mine" : job.kind === "extract" ? "Collect" : "Deliver"} <strong>{job.kind === "mine" ? miningSummary : job.priorities.map(stockName).join(", ")}</strong></span>
      <span>{job.kind === "mine" ? "in" : job.kind === "extract" ? "from" : "to"} <strong>{targetName}</strong></span>
      <span>{job.kind === "mine"
        ? job.stopAt < INDUSTRY_TUNING.cargoCapacity ? `Storage limit: ${quantity(job.stopAt)} units per resource` : "Uses all free cargo space"
        : job.kind === "extract"
        ? job.stopAt < INDUSTRY_TUNING.cargoCapacity ? `Hydrate limit: ${quantity(job.stopAt)} units` : "Uses all free cargo space"
        : job.targetKind === "point" ? job.stopAt < POINT_TANK_CAPACITY_KG ? `Tank delivery limit: ${quantity(job.stopAt)} kg` : "Uses all free space in the receiving tank"
        : job.stopAt < maxJobLimit ? `Delivery limit: ${quantity(job.stopAt)} per item (units or kg)` : "Uses all free space at the receiving depot"}</span>
      {!job.enabled && activeTrip && <span>Stopping after this trip</span>}
      {payload.length > 0 && <span>Carrying {payload.join(", ")}</span>}
      {drone.fuelKg > 0 && <span>{quantity(drone.fuelKg)} kg {drone.flight && drone.phase === "returning" ? "unused flight fuel" : "reserved for return"}</span>}
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
        <p className="industry__warning" role="status">{draft?.onlyIfUnassigned
          ? "This drone now has a job. Choose another drone for the request." : "The saved job changed while you were editing."}</p>
        <div className="industry__line industry__drone-controls">
          <Action action="use-current-job" disabled={disabled} onClick={discard}>Use current job</Action>
          {!draft?.onlyIfUnassigned && <Action action="keep-job-draft" disabled={disabled} onClick={() => update({ baseJob: job })}>Keep my edits</Action>}
        </div>
      </div>}
      <div className="industry__form-row">
        <div className="industry__job-choice">
          <label>Job<select data-industry-job-kind value={kind} disabled={!editable} onChange={e => {
            const next = e.target.value === "mine" ? "mine" : "haul";
            update({ kind: next, reserve: !job && Number(reserve) === defaultReserve(kind) ? String(defaultReserve(next)) : reserve });
          }}>
            <option value="mine" disabled={kind !== "mine" && (!canMine || !fields.length)}>
              Mine asteroids{!canMine ? " (locked)" : !fields.length ? " (out of range)" : ""}
            </option>
            <option value="haul">Deliver supplies</option>
          </select></label>
          {!canMine && (!values.onlyIfUnassigned && !pointDelivery || kind === "mine") && <IndustryResearchRequirement blueprint="mining" />}
        </div>
        {kind === "mine" ? <label>Asteroid field
          <select data-industry-job-target value={field?.id ?? ""} disabled={!editable || !canMine || !fields.length}
            onChange={e => update({ fieldId: e.target.value })}>
            {!field && <option value="" disabled>{fields.length ? "Choose a field" : "No field in range"}</option>}
            {fields.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
        </label> : <label>Receiving location
          <select data-industry-job-target value={delivery?.target.id ?? ""} disabled={!editable || (!options.length && !unavailableDeliveries.length)}
            onChange={e => {
              const target = deliveries.find(entry => entry.target.id === e.target.value && entry.route)?.target;
              if (target) update({ destinationId: target.id, destinationKind: target.kind });
            }}>
            {delivery?.reason && <option value={delivery.target.id} disabled>{delivery.target.name} ({DELIVERY_ROUTE_REASON[delivery.reason]})</option>}
            {!delivery && <option value="" disabled>{options.length ? "Choose a destination" : "No reachable destination"}</option>}
            {options.map(({ target, route }) => route && <option key={target.id} value={target.id}>
              {target.name}{target.kind === "point" ? " · Fuel tank" : ""} ({formatDistance(route.pathKm)})
            </option>)}
            {unavailableDeliveries.length > 0 && <optgroup label="Unavailable">
              {unavailableDeliveries.map(target => <option key={target.id} value={target.id} disabled>{target.name} ({target.label})</option>)}
            </optgroup>}
          </select>
        </label>}
      </div>
      {canMine && fields.length === 0 && <small>No asteroid field within {formatDistance(INDUSTRY_TUNING.extractionRangeKm)} of this depot.</small>}
      {kind === "mine" && field && <>
        <DroneMiningFilters field={field} draft={values.mineFilter} disabled={!editable || !canMine} onChange={mineFilter => update({ mineFilter })} />
        <small>The drone searches for rocks within {formatDistance(INDUSTRY_TUNING.extractionRangeKm)} and can carry up to {INDUSTRY_TUNING.loadUnits} units. Time and flight fuel depend on the asteroid.</small>
      </>}
      {kind === "haul" && options.length === 0 && <p className="industry__warning">
        {targets.length === 1 ? "Build another depot in this region to set up a delivery. " : "No reachable destination in this region. "}
        Local routes can span up to {formatDistance(INDUSTRY_TUNING.maxLocalRouteKm)}. Drones can fly farther within the same asteroid field if their tank can fuel the round trip.
      </p>}
      {kind === "haul" && pointDelivery && <p>Deliver propellant to this replication tank.</p>}
      {kind === "haul" && !pointDelivery && options.length > 0 && <div className="industry__priority">
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
          <label>{kind === "mine" ? "Storage limit per resource (optional)" : pointDelivery ? "Tank delivery limit (optional)" : "Delivery limit per item (optional)"}
            <input data-industry-job-stop aria-describedby={`stop-${drone.id}`} aria-invalid={!validStop} inputMode="numeric"
              value={kind === "mine" ? miningLimit : deliveryLimit} placeholder="Use all free space"
              disabled={!editable} onChange={e => update(kind === "mine" ? { miningLimit: e.target.value } : { deliveryLimit: e.target.value })} />
            <small id={`stop-${drone.id}`} className={validStop ? undefined : "industry__warning"}>{!validStop
              ? `Enter a whole number from 1 to ${quantity(maxLimit)}, or leave blank.`
              : kind === "mine" ? "Maximum units of each mined resource at this depot."
              : pointDelivery ? `Maximum fuel at the receiving tank (${quantity(POINT_TANK_CAPACITY_KG)} kg capacity).`
              : "Maximum of each item at the receiving depot (units or kg)."}</small>
          </label>
          {kind === "mine" && miningLimit !== "" && <Action action="clear-mining-limit" disabled={!editable} onClick={() => update({ miningLimit: "" })}>Use all free space</Action>}
        </div>
      </div>
      {estimate && <div className="industry__estimate">
        {estimate.fieldName && <span>{estimate.fieldName} · {formatDistance(estimate.pathKm)} each way</span>}
        <span>{formatDuration(2 * estimate.legSeconds + INDUSTRY_TUNING.deliverySeconds)} round trip</span>
        <span>{!plannedLoad && "From "}{quantity(flightFuelKg)} kg flight fuel ({quantity(INDUSTRY_TUNING.droneTankKg)} kg tank)</span>
        {plannedLoad && <span>{quantity(plannedLoad.load.amount)} {plannedLoad.itemId === propellantId ? "kg propellant" : stockName(plannedLoad.itemId)} planned cargo</span>}
        {validReserve && <span>{!plannedLoad && "From "}{quantity(requiredDepotFuelKg)} kg needed at depot</span>}
      </div>}
      {estimate && overDepotCapacity && <p className="industry__warning">Lower the reserve to fit the flight fuel and reserve in the depot tank.</p>}
      {estimate && !overDepotCapacity && needsFuel &&
        <p className="industry__warning">Add propellant in Storage so the drone can depart.</p>}
      <Action primary action="start-job" disabled={!canStart}
        onClick={() => {
          if (canStart && nextJob) submit({ type: "drone.configure", droneId: drone.id, job: nextJob,
            ...(values.onlyIfUnassigned && { onlyIfUnassigned: true as const }) }, "Drone job saved.", discard);
        }}>
        {job ? "Save and start" : "Start job"}
      </Action>
    </div>}
  </section>;
}
