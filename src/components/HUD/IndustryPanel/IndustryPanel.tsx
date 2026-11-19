"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowDownLeft, ArrowUp, ArrowUpRight, Box, Crosshair, Factory, Fuel, MapPin, PackagePlus, Radio, Truck } from "lucide-react";
import { getItemDef, MATERIAL_NAMES, materialName } from "@/data/content";
import { playAudio } from "@/audio/voices";
import { getLocalPlayerShip } from "@/sim/entities";
import { DRONE_FUEL_ID, DEPOT_KIT_ID, DEPOT_RECIPES, INDUSTRY_SOURCES, INDUSTRY_TUNING } from "@/sim/industry/catalog";
import type { DepotRecord, DroneJob, DroneRecord } from "@/sim/industry/types";
import { estimateDroneRoute } from "@/sim/industry/route";
import { canExtractAt, depotDistanceKm } from "@/sim/industry/placement";
import { storageUnits } from "@/sim/industry/simulation";
import type { ShipPose } from "@/save/types";
import { formatDistance, formatDuration } from "@/sim/units";
import type { WorldOperation } from "@/sim/world/commands";
import { cargoAtom, cargoRemainingUnitsAtom } from "@/store/cargo";
import { industryAtom } from "@/store/industry";
import { depotPoi, industrySourcePois, trackIndustryPoiAtom } from "@/store/industryHud";
import { modulesAtom } from "@/store/modules";
import { newOpId, runOperation } from "@/store/operations";
import { shipReq, shipResourcesHudAtom } from "@/store/shipResources";
import { targetedPOIAtom, transitDriveOwnedAtom } from "@/store/transit";
import type { POIDef } from "@/store/poi";
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
type Submit = (op: OperationArgs, success: string) => void;
type Coordinates = Pick<ShipPose, "frameId" | "positionKm">;

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

function loadLabel(depot: DepotRecord): string {
  if (depot.refinery) return "Refinery";
  return INDUSTRY_SOURCES.some(source => canExtractAt(depot, source.id)) ? "Source depot" : "Relay depot";
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
  build?: boolean;
  initialName?: string;
  onClose: () => void;
  onAim: (name: string) => void;
};

export default function IndustryPanel({ initialDepotId, initialName, build, onClose, onAim }: IndustryPanelProps) {
  const { depots, drones } = useAtomValue(industryAtom);
  const position = usePosition();
  const nearest = depots.reduce<DepotRecord | undefined>((best, depot) => !best || distance(position, depot) < distance(position, best) ? depot : best, undefined);
  const [selected, select] = useState(build ? null : initialDepotId ?? nearest?.id ?? null);
  const [view, setView] = useState<"storage" | "fabrication" | "drones">("storage");
  const depot = depots.find(d => d.id === selected);
  const distanceKm = depot ? distance(position, depot) : Infinity;
  const inRange = !!depot && distanceKm <= INDUSTRY_TUNING.interactRangeKm;
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => {
    if (!feedback || feedback.error) return;
    const timer = window.setTimeout(() => setFeedback(current => current === feedback ? null : current), 4000);
    return () => window.clearTimeout(timer);
  }, [feedback]);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const track = useSetAtom(trackIndustryPoiAtom);
  const selectedTarget = useAtomValue(targetedPOIAtom);
  const driveOwned = useAtomValue(transitDriveOwnedAtom);
  const [navigation, setNavigation] = useState<string | null>(null);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dialog = content.current?.closest(".panel");
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
  }, []);
  const navigate = (poi: POIDef) => {
    if (track(poi)) onClose();
    else setNavigation("Wait for transit to finish before changing destination.");
  };
  const submit: Submit = (op, success) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setFeedback(null);
    runOperation({ ...op, opId: newOpId() }, outcome => {
      if (outcome.status === "pending") return;
      pendingRef.current = false;
      setPending(false);
      setFeedback({ text: outcome.status === "rejected" ? industryRejection(outcome) : success, error: outcome.status === "rejected" });
      playAudio(outcome.status === "accepted" ? "click.hard" : "ui.reject");
    });
  };
  const selectDepot = (id: string | null) => {
    select(id);
    setView("storage");
    setFeedback(null);
    setNavigation(null);
  };

  return <Panel title="Industry" width={875} fixedHeight noBodyPadding onClose={onClose}>
    <div className="industry" ref={content} aria-busy={pending}>
      <div className="industry__layout">
        <nav className="industry__roster" aria-label="Depots">
          {depots.map(d => {
            const km = distance(position, d);
            return <button key={d.id} type="button" data-industry-depot={d.id} aria-current={selected === d.id}
              className="industry__depot-button" onClick={() => selectDepot(d.id)}>
              {d.refinery ? <Factory size={15} aria-hidden /> : <Box size={15} aria-hidden />}
              <span>{d.name}<small>{loadLabel(d)}</small></span>
              {Number.isFinite(km) && <small>{formatDistance(km)}</small>}
            </button>;
          })}
          <button className="industry__depot-button industry__depot-button--build" type="button" data-industry-build
            aria-current={!depot} onClick={() => selectDepot(null)}>
            <PackagePlus size={16} aria-hidden /> <span>Build depot</span>
          </button>
        </nav>

        <section className="industry__detail" aria-label={depot?.name ?? "Build depot"}>
          <div className="industry__feedback" role={feedback?.error || navigation ? "alert" : "status"}>
            {pending ? "Waiting for confirmation…" : feedback?.text ?? navigation}
          </div>
          {depot ? <>
            <header className="industry__depot-head">
              <div>
                <h3>{depot.name}</h3>
                <div className="industry__access" data-industry-access={inRange ? "available" : "remote"}>
                  <Radio size={13} aria-hidden />
                  {inRange ? "Local access" : `Access within ${formatDistance(INDUSTRY_TUNING.interactRangeKm)}`}
                  {Number.isFinite(distanceKm) && <span>{formatDistance(distanceKm)} away</span>}
                </div>
              </div>
              {(!inRange || selectedTarget?.id !== depotPoi(depot).id) && <Action action="track-depot" onClick={() => navigate(depotPoi(depot))}>
                <Crosshair size={14} aria-hidden /> Track depot
              </Action>}
            </header>
            <div className="industry__tabs" aria-label="Depot controls">
              {([["storage", "Storage"], ["fabrication", "Fabrication"], ["drones", "Drones"]] as const).map(([id, label]) =>
                <button key={id} type="button" data-industry-tab={id} aria-pressed={view === id} onClick={() => setView(id)}>{label}</button>
              )}
            </div>
            <div className="industry__content" key={`${depot.id}:${view}`}>
              {view === "storage" && <DepotStorage depot={depot} disabled={!inRange || pending} submit={submit} />}
              {view === "fabrication" && <Fabrication depot={depot} droneCount={drones.filter(drone => drone.homeId === depot.id).length} disabled={!inRange || pending} submit={submit} />}
              {view === "drones" && <DepotDrones depot={depot} depots={depots} drones={drones} disabled={!inRange || pending} submit={submit} onFabricate={() => setView("fabrication")} />}
            </div>
          </> : <BuildDepot count={depots.length} initialName={initialName} position={position} pending={pending} canTransit={driveOwned} submit={submit} onAim={onAim} navigate={navigate} />}
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

function BuildDepot({ count, initialName, position, pending, canTransit, submit, onAim, navigate }: {
  count: number; initialName?: string; position: Coordinates | null; pending: boolean; canTransit: boolean;
  submit: Submit; onAim: (name: string) => void; navigate: (poi: POIDef) => void;
}) {
  const { items } = useAtomValue(cargoAtom);
  const kits = useAtomValue(modulesAtom).consumables[DEPOT_KIT_ID] ?? 0;
  const [name, setName] = useState(initialName ?? `Depot ${count + 1}`);
  const recipe = kitDef?.recipe ?? {};
  const ready = !!kitDef && kits < (kitDef.stackMax ?? Infinity) && canAfford(recipe, items);
  const sources = INDUSTRY_SOURCES.map((source, i) => ({ source, poi: industrySourcePois[i], km: distance(position, source) }))
    .sort((a, b) => a.km - b.km);

  return <div className="industry__content industry__build">
    <h3>Build a depot</h3>
    <p>Share storage and fabricate equipment. A depot near a hydrate prospect can extract its own feedstock.</p>
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
        <p>Build within prospect range to run extraction drones. A relay can receive stock anywhere along the route.</p>
        <div className="industry__sources">
          {sources.map(({ source, poi, km }) => <div className="industry__line" key={source.id}>
            <span><MapPin size={14} aria-hidden /> {source.name}<small>{Number.isFinite(km) ? `${formatDistance(km)} away` : "Position unavailable"} · {formatDistance(source.rangeKm)} extraction range
              {position && canExtractAt(position, source.id) && <strong> · In range</strong>}
            </small></span>
            <Action action={`track-${source.id}`} onClick={() => navigate(poi)}>Track</Action>
          </div>)}
        </div>
        {!canTransit && <small>Track marks the bearing. Add a Transit Drive for long trips.</small>}
      </section>
      <section>
        <h4>3. Deploy the depot</h4>
        <div className="industry__form-row">
          <label>Depot name<input data-industry-name value={name} maxLength={32} spellCheck={false} onChange={e => setName(e.target.value)} /></label>
          <Action action="aim" primary disabled={pending || kits < 1 || !name.trim() || count >= INDUSTRY_TUNING.maxDepots} onClick={() => onAim(name.trim())}>Aim placement</Action>
        </div>
        {count >= INDUSTRY_TUNING.maxDepots && <small>All depot slots are in use.</small>}
      </section>
    </div>
  </div>;
}

type DepotControls = { depot: DepotRecord; disabled: boolean; submit: Submit };

function DepotStorage({ depot, disabled, submit }: DepotControls) {
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
    submit({ type: "depot.transfer", depotId: depot.id, direction, kind: selected.kind, itemId: selected.kind === "fuel" ? "fuel" : selected.id, amount },
      `${direction === "deposit" ? "Deposited" : "Withdrawn"} ${quantity(amount)} ${selected.kind === "fuel" ? "kg" : stockName(selected.id)}.`);
  const nearby = INDUSTRY_SOURCES.find(source => canExtractAt(depot, source.id));
  return <>
    <div className="industry__capacity">
      <span><Fuel size={14} aria-hidden /> {quantity(storage.fuelKg)} / {quantity(INDUSTRY_TUNING.fuelCapacityKg)} kg</span>
      <span><Box size={14} aria-hidden /> {quantity(holdUsed)} / {quantity(INDUSTRY_TUNING.cargoCapacity)} units</span>
    </div>
    <p className="industry__operation">
      {depot.refinery
        ? (storage.items.hydrates ?? 0) < 1 ? "Refinery waiting for hydrates." : INDUSTRY_TUNING.fuelCapacityKg - storage.fuelKg < INDUSTRY_TUNING.refineKgPerHydrate ? "Refinery paused. Withdraw or ship propellant." : "Refinery converting hydrates to propellant."
        : nearby ? `${nearby.name} in range. Fabricate refinery and drone to start production.` : "Relay depot. Stock by hand or set as a haul destination."}
    </p>
    <div className="industry__manifest" role="group" aria-label="Select stock to transfer">
      <div className="industry__manifest-head" aria-hidden="true"><span>Stock</span><span>Aboard</span><span>Depot</span></div>
      {rows.map(row => <button key={`${row.kind}:${row.id}`} type="button" className="industry__manifest-row" data-industry-stock={row.id}
        aria-pressed={selected === row} onClick={() => { select(`${row.kind}:${row.id}`); if (row.kind === "consumable") setCount("1"); }}>
        <span>{row.kind === "fuel" ? <Fuel size={14} aria-hidden /> : row.kind === "cargo" ? <ResourceGlyph id={row.id} /> : <Box size={14} aria-hidden />}{stockName(row.id)}</span>
        <span aria-label={`${quantity(row.ship)} aboard`}>{quantity(row.ship)}</span>
        <span aria-label={`${quantity(row.depot)} at depot`}>{quantity(row.depot)}</span>
      </button>)}
    </div>
    <div className="industry__transfer">
      <label>Amount ({selected.kind === "fuel" ? "kg" : "units"})<input type="number" data-industry-amount value={count} min={1} step={1} onChange={e => setCount(e.target.value)} /></label>
      <div className="industry__transfer-group">
        <Action action="withdraw" disabled={disabled || !validAmount || n > maxOut} onClick={() => transfer("withdraw", n)}><ArrowDownLeft size={14} aria-hidden /> Withdraw</Action>
        <Action action="withdraw-max" label={`Withdraw up to ${quantity(maxOut)}`} disabled={disabled || maxOut <= 0} onClick={() => transfer("withdraw", maxOut)}>Max {quantity(maxOut)}</Action>
      </div>
      <div className="industry__transfer-group">
        <Action action="deposit" disabled={disabled || !validAmount || n > maxIn} onClick={() => transfer("deposit", n)}><ArrowUpRight size={14} aria-hidden /> Deposit</Action>
        <Action action="deposit-max" label={`Deposit up to ${quantity(maxIn)}`} disabled={disabled || maxIn <= 0} onClick={() => transfer("deposit", maxIn)}>Max {quantity(maxIn)}</Action>
      </div>
    </div>
    {selected.kind === "fuel" && (pendingKg > 0 || shipReq.reservedKg > 0) &&
      <small>Processing batches and reserved flight fuel reduce the amount you can move.</small>}
  </>;
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

const DRONE_STATUS: Record<string, string> = {
  unassigned: "Awaiting assignment",
  paused: "Stopped at depot",
  needs_fuel: "Low fuel. Deposit propellant or lower the reserve.",
  source_out_of_range: "Prospect out of range. Select a closer prospect.",
  destination_full: "Destination at stock limit. Withdraw stock or raise the stop level.",
  no_cargo: "No matching stock. Supply the depot or edit the filter.",
  route_out_of_range: "Route too long. Choose a nearer depot.",
  extracting: "Extracting hydrates",
  delivering: "Delivering cargo",
  returning: "Returning to depot",
  unload_blocked: "Home storage full. Withdraw cargo to unload.",
  departing: "Departing depot",
};

function DepotDrones({ depot, depots, drones, disabled, submit, onFabricate }: DepotControls & {
  depots: DepotRecord[]; drones: DroneRecord[]; onFabricate: () => void;
}) {
  const homeDrones = drones.filter(drone => drone.homeId === depot.id);
  if (!homeDrones.length) return <div className="industry__empty">
    <Truck size={22} aria-hidden />
    <div><h4>No drones at this depot</h4><p>Fabricate a drone to extract hydrates or deliver stock.</p></div>
    <Action onClick={onFabricate}>View fabrication</Action>
  </div>;
  return <div className="industry__fleet">{homeDrones.map((drone, i) => <DroneControl
    key={`${drone.id}:${JSON.stringify(drone.job)}`} index={i + 1} drone={drone}
    depot={depot} depots={depots} disabled={disabled} submit={submit}
  />)}</div>;
}

const defaultReserve = (kind: DroneJob["kind"]): number => kind === "haul" ? 10 : 0;

function DroneControl({ index, drone, depot, depots, disabled, submit }: DepotControls & { index: number; drone: DroneRecord; depots: DepotRecord[] }) {
  const job = drone.job;
  const sources = INDUSTRY_SOURCES.map(s => ({ ...s, km: distance(depot, s), limit: s.rangeKm, reachable: canExtractAt(depot, s.id) }))
    .sort((a, b) => a.km - b.km);
  const destinations = depots.filter(d => d.id !== depot.id).map(d => ({ ...d, km: distance(depot, d), limit: INDUSTRY_TUNING.maxRouteKm, reachable: distance(depot, d) <= INDUSTRY_TUNING.maxRouteKm }));
  const [editing, setEditing] = useState(!job);
  const [kind, setKind] = useState<DroneJob["kind"]>(job?.kind ?? (sources.some(s => s.reachable) ? "extract" : "haul"));
  const [targetId, setTarget] = useState(job?.targetId ?? "");
  const [priorities, setPriorities] = useState(job?.kind === "haul" ? job.priorities : [propellantId]);
  const [reserve, setReserve] = useState(String(job?.reserveKg ?? defaultReserve(kind)));
  const [stopAt, setStopAt] = useState(String(job?.stopAt ?? 100));
  const [filter, setFilter] = useState("");
  const options = kind === "extract" ? sources : destinations;
  const chosen = options.find(option => option.id === targetId) ?? options[0];
  const estimate = editing && chosen?.reachable ? estimateDroneRoute(depot, chosen) : null;
  const activeTrip = drone.phase !== "idle";
  const editable = !disabled && !activeTrip;
  const validReserve = reserve.trim() !== "" && Number.isFinite(Number(reserve)) && Number(reserve) >= 0 && Number(reserve) <= INDUSTRY_TUNING.fuelCapacityKg;
  const maxStop = Math.max(INDUSTRY_TUNING.cargoCapacity, INDUSTRY_TUNING.fuelCapacityKg);
  const validStop = Number.isSafeInteger(Number(stopAt)) && Number(stopAt) > 0 && Number(stopAt) <= maxStop;
  const jobs = job?.kind === "extract" ? sources : destinations;
  const jobTarget = jobs.find(target => target.id === job?.targetId);
  const targetName = jobTarget?.name ?? "Destination unavailable";
  const blockedRoute = jobTarget && drone.status === "needs_fuel" ? estimateDroneRoute(depot, jobTarget) : null;
  const neededKg = job && blockedRoute ? job.reserveKg + blockedRoute.roundTripFuelKg : null;
  const currentStatus = neededKg !== null
    ? `Waiting for fuel. Deposit ${Math.ceil(Math.max(0, neededKg - depot.storage.fuelKg))} kg at home, or lower the reserve.`
    : job?.kind === "extract" && drone.status === "no_cargo"
      ? "Prospect depleted. Extraction resumes as the deposit replenishes."
      : DRONE_STATUS[drone.status];
  const payload = [
    ...(drone.cargo.fuelKg > 0 ? [`${quantity(drone.cargo.fuelKg)} kg propellant`] : []),
    ...Object.entries(drone.cargo.items).map(([id, n]) => `${quantity(n)} ${stockName(id)}`),
  ];
  const defaultPriorities = kind === "extract" ? ["hydrates"] : priorities;
  const send = (next: DroneJob, message: string) => submit({ type: "drone.configure", droneId: drone.id, job: next }, message);
  const move = (index: number, offset: number) => {
    const reordered = priorities.slice();
    [reordered[index], reordered[index + offset]] = [reordered[index + offset], reordered[index]];
    setPriorities(reordered);
  };

  return <section className="industry__drone" data-industry-drone={drone.id}>
    <header className="industry__drone-head">
      <div>
        <h4><Truck size={16} aria-hidden /> Drone {index}</h4>
        <p data-industry-drone-status={drone.status}>{currentStatus}</p>
      </div>
      {activeTrip && <span className="industry__time">{formatDuration(Math.ceil(drone.remainingS))}</span>}
    </header>
    {job && <div className="industry__route">
      <span>{job.kind === "extract" ? "Extract" : "Haul"} <strong>{job.priorities.map(stockName).join(", ")}</strong></span>
      <span>{job.kind === "extract" ? "from" : "to"} <strong>{targetName}</strong></span>
      {!job.enabled && activeTrip && <span>Stopping after this trip</span>}
      {payload.length > 0 && <span>Carrying {payload.join(", ")}</span>}
      {drone.fuelKg > 0 && <span>{quantity(drone.fuelKg)} kg reserved for return</span>}
    </div>}
    {job && <div className="industry__line industry__drone-controls">
      <Action action="edit-job" disabled={!editable} onClick={() => setEditing(value => !value)}>{editing ? "Cancel edit" : "Edit job"}</Action>
      {job.enabled && <Action action="stop-job" disabled={disabled}
        onClick={() => send({ ...job, enabled: false }, activeTrip ? "Stop requested." : "Drone stopped.")}>
        {activeTrip ? "Stop after trip" : "Stop job"}
      </Action>}
      {!job.enabled && <Action action="resume-job" primary disabled={!editable} onClick={() => send({ ...job, enabled: true }, "Job resumed.")}>Resume job</Action>}
    </div>}
    {editing && <div className="industry__job">
      <div className="industry__form-row">
        <label>Job<select data-industry-job-kind value={kind} disabled={!editable} onChange={e => {
          const next = e.target.value === "extract" ? "extract" : "haul";
          if (!job && Number(reserve) === defaultReserve(kind)) setReserve(String(defaultReserve(next)));
          setKind(next);
          setTarget("");
        }}>
          <option value="extract">Extract hydrates</option><option value="haul">Haul stock</option>
        </select></label>
        <label>{kind === "extract" ? "Prospect" : "Destination"}
          <select data-industry-job-target value={chosen?.id ?? ""} disabled={!editable || !options.length} onChange={e => setTarget(e.target.value)}>
            {!options.length && <option value="">Build another depot</option>}
            {options.map(option => <option key={option.id} value={option.id}>
              {option.name} ({formatDistance(option.km)})
            </option>)}
          </select>
        </label>
      </div>
      {kind === "haul" && <div className="industry__priority">
        <label>Cargo filter
          <select data-industry-job-filter disabled={!editable} value={filter} onChange={e => {
            const value = e.target.value;
            if (value) setPriorities(items => [...items, value]);
            setFilter("");
          }}>
            <option value="">Add a resource</option>
            {[propellantId, ...Object.keys(MATERIAL_NAMES)].filter(id => !priorities.includes(id)).map(id =>
              <option key={id} value={id}>{stockName(id)}</option>
            )}
          </select>
        </label>
        <ol aria-label="Loading order">
          {priorities.map((id, i) => <li key={id}>
            <span>{stockName(id)}</span>
            <button type="button" title="Move up" aria-label={`Move ${stockName(id)} up`} disabled={!editable || i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} aria-hidden /></button>
            <button type="button" title="Move down" aria-label={`Move ${stockName(id)} down`} disabled={!editable || i === priorities.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} aria-hidden /></button>
            <button type="button" disabled={!editable} aria-label={`Remove ${stockName(id)}`} onClick={() => setPriorities(ids => ids.filter(item => item !== id))}>Remove</button>
          </li>)}
        </ol>
        <small>Higher resources load first.</small>
      </div>}
      <div className="industry__form-row">
        <label>Home fuel reserve (kg)<input data-industry-job-reserve aria-describedby={`reserve-${drone.id}`} type="number" min={0} max={INDUSTRY_TUNING.fuelCapacityKg} value={reserve}
          disabled={!editable} onChange={e => setReserve(e.target.value)} /><small id={`reserve-${drone.id}`}>Kept at home after funding the return trip.</small></label>
        <label>Stop at stock level<input data-industry-job-stop aria-describedby={`stop-${drone.id}`} type="number" min={1} max={maxStop} value={stopAt}
          disabled={!editable} onChange={e => setStopAt(e.target.value)} /><small id={`stop-${drone.id}`}>{kind === "extract" ? "Pause when home holds this many hydrates." : "Pause when each resource reaches this stock at the destination."}</small></label>
      </div>
      {chosen && !chosen.reachable && <p className="industry__warning">{kind === "extract" ? `Build within ${formatDistance(chosen.limit)} of this prospect to extract.` : `Choose a destination within ${formatDistance(chosen.limit)}.`}</p>}
      {estimate && <div className="industry__estimate">
        <span>{formatDuration(2 * estimate.legSeconds + (kind === "extract" ? INDUSTRY_TUNING.extractSeconds : INDUSTRY_TUNING.deliverySeconds))} round trip</span>
        <span>{quantity(estimate.roundTripFuelKg)} kg flight fuel</span>
        {validReserve && <span>{quantity(estimate.roundTripFuelKg + Number(reserve))} kg needed to depart</span>}
      </div>}
      {estimate && validReserve && estimate.roundTripFuelKg + Number(reserve) > depot.storage.fuelKg &&
        <p className="industry__warning">Deposit ship propellant in Storage to start the first trip.</p>}
      {chosen?.reachable && !estimate && <p className="industry__warning">No clear route to this destination. Choose a closer location.</p>}
      <Action primary action="start-job" disabled={!editable || !chosen || !validReserve || !validStop || !defaultPriorities.length || !estimate}
        onClick={() => {
          if (chosen) send({ kind, targetId: chosen.id, priorities: defaultPriorities, reserveKg: Number(reserve), stopAt: Number(stopAt), enabled: true }, "Drone job assigned.");
        }}>
        {job ? "Save and start" : "Start job"}
      </Action>
    </div>}
  </section>;
}
