"use client";

import { useAtomValue, useStore } from "jotai";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { CircleCheck, Clock, FlaskConical, Fuel, Package, Thermometer } from "lucide-react";
import { INSPECT_RANGE_M, SOURCE_CLASS_NAMES, getSiteDef } from "@/data/content";
import { sourceIdOf } from "@/sim/research/discoveries";
import { getAsteroidClass, computeMiningDurationS } from "@/sim/asteroids/resources";
import { buildMineOperation } from "@/sim/asteroids/mineOperation";
import { REPLICATION_KIT_ID } from "@/sim/replication/points";
import { isTypingTarget } from "@/input/keyboard";
import { playAudio } from "@/audio";
import { keybindsAtom, type KeybindAction } from "@/store/keybinds";
import { cancelInspectionAtom, cancelMiningAtom, inspectControl, miningStateAtom, startInspectionAtom, startMiningAtom } from "@/store/mining";
import { discoveriesMirrorAtom } from "@/store/research";
import { isCargoFullAtom } from "@/store/cargo";
import { systemConfigAtom } from "@/store/system";
import { effectiveShipConfigAtom } from "@/store/shipConfig";
import { computedModifiersAtom, getFlag } from "@/store/modules";
import { industryAtom } from "@/store/industry";
import { depotPlacementAtom, industryPanelOpenAtom, industryRequestAtom } from "@/store/industryHud";
import { isDeadAtom, wrecksAtom } from "@/store/death";
import { settingsIsOpenAtom } from "@/store/store";
import { interactControl, interactFocusAtom, interactFocused, siteHoldFull, type InteractFocus } from "@/store/interact";
import { placementModeAtom, playerReplicationAtom, replicationPointsAtom } from "@/store/replication";
import { KeyChip, ResourceIcon } from "../shared/Chips";
import { startInspectAudio, stopInspectAudio } from "./inspectAudio";

import "./TargetCard.scss";

/** `840 m` · `12.4 km` · `1,240 km` (one format everywhere on the card). */
export function fmtDistKm(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString("en-US")} km`;
}

type Kind = "rock" | "site" | "wreck" | "point" | "depot";

function Act({ action, keyName, label, off, why }: { action?: KeybindAction; keyName?: string; label: string; off?: boolean; why?: ReactNode }) {
  return (
    <span className={`target-card__act${off ? " target-card__act--off" : ""}`}>
      <KeyChip action={action} keyName={keyName} dim={off} />
      <span>{label}</span>
      {why && <span className="target-card__why">{why}</span>}
    </span>
  );
}

function Bar({ value, tone }: { value: number; tone: "info" | "heat" | "signal" }) {
  return (
    <span className={`target-card__bar target-card__bar--${tone}`}>
      <span className="target-card__bar-fill" style={{ width: `${Math.round(Math.min(1, value) * 100)}%` }} />
    </span>
  );
}

/**
 * The one panel for "what I am looking at + what I can do with it" (rocks, the survey site, wrecks,
 * placed points and depots), attached right of the ship-nose reticle. Owns [M] and [G].
 */
export default function TargetCard() {
  const store = useStore();
  const mining = useAtomValue(miningStateAtom);
  const focus = useAtomValue(interactFocusAtom);
  const placing = useAtomValue(placementModeAtom);
  const dead = useAtomValue(isDeadAtom);
  const placingDepot = useAtomValue(depotPlacementAtom);
  const industryOpen = useAtomValue(industryPanelOpenAtom);

  const kind: Kind | null = dead || placingDepot || industryOpen || placing ? null : focus.focused && focus.target ? focus.target.kind : mining.targetedAsteroid && (mining.isFocused || mining.isMining) ? "rock" : null;

  // ── keys: [M] mines, [G] does everything else (R5) ──
  const stateRef = useRef({ mining, focus, kind });
  useEffect(() => {
    stateRef.current = { mining, focus, kind };
  });
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (isTypingTarget(e.target) || e.repeat || store.get(settingsIsOpenAtom) || store.get(isDeadAtom) || store.get(industryPanelOpenAtom) || store.get(depotPlacementAtom) || store.get(placementModeAtom)) return;
      const key = e.key.toLowerCase();
      const kb = store.get(keybindsAtom);
      const { mining: m, kind: k, focus: f } = stateRef.current;
      if (kb.mine.includes(key)) {
        if (m.isMining) store.set(cancelMiningAtom);
        else if (k === "rock" && m.isFocused && !store.get(isCargoFullAtom) && !m.isOverheated) store.set(startMiningAtom);
        else playAudio("ui.reject");
        return;
      }
      if (!kb.inspect.includes(key)) return;
      if (k !== "rock" && k !== null) {
        // In range the wreck salvages itself (the card says `Salvaging`): G has nothing to refuse.
        if (k === "wreck" && f.target?.inRange) return;
        if (!interactFocused(store)) playAudio("ui.reject");
        else if (interactControl.scanning) startInspectAudio(() => interactControl.scanning);
        else stopInspectAudio();
        return;
      }
      if (k === "rock") {
        if (inspectControl.requested) {
          store.set(cancelInspectionAtom);
          stopInspectAudio();
          return;
        }
        if (rockInspectable(store) && store.set(startInspectionAtom)) {
          startInspectAudio(() => inspectControl.requested);
          return;
        }
      }
      playAudio("ui.reject");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store]);

  const body = kind === "rock" ? <RockRows /> : kind ? <InteractRows focus={focus} /> : null;
  return (
    <div className={`target-card ${kind ? `target-card--visible target-card--${kind}` : ""}${kind && kind !== "rock" ? " target-card--rows3" : ""}`} data-testid="target-card" data-kind={kind ?? ""}>
      {body}
    </div>
  );
}

type Store = ReturnType<typeof useStore>;

/** The locked rock is not inspected yet and within the scanner's range. */
function rockInspectable(store: Store): boolean {
  const m = store.get(miningStateAtom);
  const t = m.targetedAsteroid;
  if (!t || !m.isFocused || m.isMining) return false;
  const id = sourceIdOf(t.location.fieldId, t.location.chunkKey, t.instanceId);
  if (store.get(discoveriesMirrorAtom).sources.some((x) => x.id === id)) return false;
  return t.distanceM <= INSPECT_RANGE_M * store.get(effectiveShipConfigAtom).scannerInspectRangeMult;
}

function RockRows() {
  const m = useAtomValue(miningStateAtom);
  const systemConfig = useAtomValue(systemConfigAtom);
  const ship = useAtomValue(effectiveShipConfigAtom);
  const modifiers = useAtomValue(computedModifiersAtom);
  const bands = getFlag(modifiers, "scanner.lockShowsCompositionBands");
  const discoveries = useAtomValue(discoveriesMirrorAtom);
  const cargoFull = useAtomValue(isCargoFullAtom);
  const t = m.targetedAsteroid;

  const info = useMemo(() => {
    if (!t) return null;
    const cls = getAsteroidClass(systemConfig, t.location.fieldId, t.instanceId, t.location.chunkKey);
    const src = discoveries.sources.find((x) => x.id === sourceIdOf(t.location.fieldId, t.location.chunkKey, t.instanceId)) ?? null;
    // Show the live mine claim, not the stored inspection (pre-cap saves hold inflated amounts).
    const claim = src
      ? buildMineOperation(systemConfig, { fieldId: t.location.fieldId, chunkKey: t.location.chunkKey, instanceId: t.instanceId, radiusM: t.radiusM }, { miningEfficiencyMult: ship.miningEfficiencyMult }, "preview").yield
      : null;
    const inspected = claim
      ? Object.entries(claim)
          .map(([id, n]) => ({ id, n }))
          .sort((a, b) => b.n - a.n)
          .slice(0, 5)
      : null;
    const estimated = cls && bands
      ? cls.resources.map((r) => ({ id: r.resourceId, mid: (r.min + r.max) / 2 })).filter((r) => r.mid > 0.05).sort((a, b) => b.mid - a.mid).slice(0, 5)
      : null;
    const classId = cls?.id ?? "";
    return {
      name: (SOURCE_CLASS_NAMES[classId] ?? cls?.name ?? "Unknown").toUpperCase(),
      seconds: Math.round(computeMiningDurationS(t.radiusM) / ship.miningSpeedMult),
      inspected,
      estimated,
      rangeKm: (INSPECT_RANGE_M * ship.scannerInspectRangeMult) / 1000,
    };
  }, [t, systemConfig, discoveries.sources, ship.miningEfficiencyMult, ship.miningSpeedMult, ship.scannerInspectRangeMult, bands]);
  if (!t || !info) return null;

  const inRange = t.distanceM / 1000 <= info.rangeKm;
  const inspecting = m.inspectProgress > 0;
  const mineOff = cargoFull || m.isOverheated;
  const mineWhy = cargoFull ? <><Package size={12} aria-hidden /> Full</> : m.isOverheated ? <><Thermometer size={12} aria-hidden /> Cooling</> : null;
  return (
    <>
      <div className="target-card__row target-card__row--head">
        <span className="target-card__name">{info.name}</span>
        <span className="target-card__dist">{fmtDistKm(t.distanceM / 1000)}</span>
      </div>
      <div className="target-card__row target-card__row--facts">
        <span>r {Math.round(t.radiusM)} m</span>
        <span className="target-card__fact"><Clock size={11} aria-label="mining time" /> {info.seconds} s</span>
      </div>
      <div className="target-card__row target-card__row--contents">
        {info.inspected ? info.inspected.map((r) => <ResourceIcon key={r.id} id={r.id} amount={r.n} />)
          : info.estimated?.length ? info.estimated.map((r) => <ResourceIcon key={r.id} id={r.id} estimated />)
          : <span className="target-card__muted">Not inspected</span>}
      </div>
      <div className="target-card__row target-card__row--actions">
        {m.isMining ? (
          <>
            <Bar value={m.miningProgress} tone="heat" />
            <Act action="mine" label="Stop" />
          </>
        ) : inspecting ? (
          <>
            <Bar value={m.inspectProgress} tone="info" />
            <Act action="inspect" label="Stop" />
          </>
        ) : (
          <>
            {!info.inspected && <Act action="inspect" label="Inspect" off={!inRange} why={!inRange ? fmtDistKm(info.rangeKm) : null} />}
            <Act action="mine" label="Mine" off={mineOff} why={mineWhy} />
          </>
        )}
      </div>
    </>
  );
}

function InteractRows({ focus }: { focus: InteractFocus }) {
  const store = useStore();
  const disc = useAtomValue(discoveriesMirrorAtom);
  const wrecks = useAtomValue(wrecksAtom);
  const points = useAtomValue(replicationPointsAtom);
  const activeId = useAtomValue(playerReplicationAtom).activeId;
  useAtomValue(isCargoFullAtom); // re-render when the hold changes (site `Full`)
  const t = focus.target;
  if (!t) return null;
  const dist = <span className="target-card__dist">{fmtDistKm(t.distKm)}</span>;

  if (t.kind === "site") {
    const site = getSiteDef(t.refId);
    if (!site) return null;
    const full = siteHoldFull(store, site.id);
    return (
      <>
        <div className="target-card__row target-card__row--head">
          <span className="target-card__name">{(disc.inspectedSites[site.id] ? site.name : site.signalName).toUpperCase()}</span>
          {dist}
        </div>
        <div className="target-card__row target-card__row--contents">
          {Object.entries(site.reward).map(([id, n]) => <ResourceIcon key={id} id={id} amount={n} />)}
          <FlaskConical size={13} strokeWidth={1.75} aria-label="research option" className="target-card__icon" />
        </div>
        <div className="target-card__row target-card__row--actions">
          {focus.scan > 0 ? (
            <>
              <Bar value={focus.scan} tone="signal" />
              <Act action="inspect" label="Stop" />
            </>
          ) : (
            <Act action="inspect" label="Recover" off={!t.inRange || full} why={full ? <><Package size={12} aria-hidden /> Full</> : !t.inRange ? fmtDistKm(t.actionRangeKm) : null} />
          )}
        </div>
      </>
    );
  }

  if (t.kind === "wreck") {
    const w = wrecks.find((x) => x.id === t.refId);
    if (!w) return null;
    const items = Object.entries(w.items).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const kits = w.consumables[REPLICATION_KIT_ID] ?? 0;
    const other = Object.entries(w.consumables).reduce((a, [id, n]) => a + (id === REPLICATION_KIT_ID ? 0 : n), 0);
    return (
      <>
        <div className="target-card__row target-card__row--head">
          <span className="target-card__name">WRECK</span>
          {dist}
        </div>
        <div className="target-card__row target-card__row--contents">
          {items.map(([id, n]) => <ResourceIcon key={id} id={id} amount={n} />)}
          {w.fuelKg >= 1 && <span className="sn-res"><Fuel size={13} strokeWidth={1.75} aria-label="fuel" /><span className="sn-res__n">{Math.round(w.fuelKg)} kg</span></span>}
          {kits + other > 0 && <span className="sn-res"><Package size={13} strokeWidth={1.75} aria-label="items" /><span className="sn-res__n">×{kits + other}</span></span>}
        </div>
        <div className="target-card__row target-card__row--actions">
          {t.inRange ? <span className="target-card__state target-card__state--live">Salvaging</span> : <span className="target-card__muted">Salvage ≤ {fmtDistKm(t.actionRangeKm)}</span>}
        </div>
      </>
    );
  }

  if (t.kind === "depot") return <DepotRows depotId={t.refId} dist={dist} inRange={t.inRange} rangeKm={t.actionRangeKm} />;

  const p = points.find((x) => x.id === t.refId);
  if (!p) return null;
  const active = p.id === activeId;
  return (
    <>
      <div className="target-card__row target-card__row--head">
        <span className="target-card__name">{p.name}</span>
        {dist}
      </div>
      <div className="target-card__row target-card__row--contents">
        <span className="target-card__muted">Respawn point</span>
        <button type="button" className="target-card__rename" onClick={() => store.set(industryRequestAtom, { renamePointId: p.id })}>Rename</button>
      </div>
      <div className="target-card__row target-card__row--actions">
        {active ? <span className="target-card__tag"><CircleCheck size={12} aria-hidden /> Active</span>
          : <Act action="inspect" label="Set active" off={!t.inRange} why={!t.inRange ? fmtDistKm(t.actionRangeKm) : null} />}
      </div>
    </>
  );
}

function DepotRows({ depotId, dist, inRange, rangeKm }: { depotId: string; dist: ReactNode; inRange: boolean; rangeKm: number }) {
  const depot = useAtomValue(industryAtom).depots.find(d => d.id === depotId);
  if (!depot) return null;
  return (
    <>
      <div className="target-card__row target-card__row--head">
        <span className="target-card__name">{depot.name}</span>
        {dist}
      </div>
      <div className="target-card__row target-card__row--contents">
        <span className="target-card__muted">{depot.refinery ? "Refinery depot" : "Depot"}</span>
      </div>
      <div className="target-card__row target-card__row--actions">
        <Act action="inspect" label="Open depot" off={!inRange} why={!inRange ? fmtDistKm(rangeKm) : null} />
      </div>
    </>
  );
}
