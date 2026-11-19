"use client";

import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { getItemDef, materialName } from "@/data/content";
import { connectedCrew, coopSnapshot, remotePoses, REMOTE_STALE_MS } from "@/net/coopState";
import { getWorldState } from "@/save/activeSave";
import { getLocalPlayerId } from "@/save/playerId";
import { frameOriginKm } from "@/sim/frames";
import { getLocalPlayerShip } from "@/sim/entities";
import { shipRes, shipReq } from "@/store/shipResources";
import { Vector3 } from "three";
import { MapPin, Send } from "lucide-react";
import { cargoAtom } from "@/store/cargo";
import { modulesAtom } from "@/store/modules";
import { rendezvousAtom } from "@/store/discoveries";
import { newOpId, runOperation, describeRejection } from "@/store/operations";
import type { GiftKind, WorldOperation } from "@/sim/world/commands";
import { GIFT_RANGE_KM } from "@/sim/world/reducers";

function onlinePilots() {
  const ship = getLocalPlayerShip();
  const pos = new Vector3();
  return connectedCrew.map(member => {
    const pose = remotePoses.get(member.id)?.at(-1);
    let km: number | null = null;
    if (ship && pose && performance.now() - pose.at <= REMOTE_STALE_MS) {
      frameOriginKm(pose.f, pos);
      pos.x += pose.p[0]; pos.y += pose.p[1]; pos.z += pose.p[2];
      km = pos.distanceTo(ship.absPosKm);
    }
    return { ...member, km };
  });

}

export default function ExpeditionControls({ discoveries }: { discoveries?: string }) {
  const cargo = useAtomValue(cargoAtom);
  const modules = useAtomValue(modulesAtom);
  const fix = useAtomValue(rendezvousAtom)[getLocalPlayerId()];
  const [pilots, setPilots] = useState(onlinePilots);
  const localId = getLocalPlayerId();
  const host = coopSnapshot().role === "host";
  const [recipient, setRecipient] = useState("");
  const [confirmKick, setConfirmKick] = useState<string | null>(null);
  const [selection, setSelection] = useState("fuel:fuel");
  const [amount, setAmount] = useState("1");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const refresh = () => {
      const online = onlinePilots();
      setPilots(online);
      setConfirmKick(current => online.some(p => p.id === current) ? current : null);
    };
    const timer = setInterval(refresh, 500);
    return () => clearInterval(timer);
  }, []);
  const target = pilots.find(p => p.id === recipient);
  const to = target?.id;
  const nearby = target && target.km !== null && target.km <= GIFT_RANGE_KM;
  const fuel = Math.max(0, Math.floor(shipRes.ordinaryKg - shipReq.reservedKg));
  const supplies = [
    { value: "fuel:fuel", label: "Fuel", available: fuel },
    ...Object.entries(cargo.items).filter(([, n]) => n > 0).map(([id,n]) => ({ value: "cargo:" + id, label: materialName(id), available: n })),
    ...Object.entries(modules.consumables).filter(([, n]) => n > 0).map(([id,n]) => ({ value: "consumable:" + id, label: getItemDef(id)?.name ?? id, available: n })),
  ];
  const value = selection;
  const supply = supplies.find(s => s.value === value);
  const available = supply?.available ?? 0;
  const unit = value === "fuel:fuel" ? "kg" : "units";
  const valid = Number.isSafeInteger(Number(amount)) && Number(amount) > 0 && Number(amount) <= available;
  const submit = (op: WorldOperation, done: string) => {
    setPending(true);
    setNotice("");
    runOperation(op, outcome => {
      setPending(false);
      setNotice(outcome.status === "accepted" ? done : outcome.status === "rejected" ? describeRejection(outcome) : "Already processed");
    });
  };
  return (
    <div className="coop-settings__expedition">
      {!recipient && <>
      {discoveries && <div>{discoveries}</div>}
      <section className="crew-members"><h3>Connected pilots <small>{pilots.length}</small></h3>
        <ul>{pilots.map(p => <li key={p.id} data-crew-id={p.id}>
          <div><strong>{p.name}</strong> <small>{[p.host && "Host", p.id === localId && "You"].filter(Boolean).join(" · ")}</small></div>
          <span className="crew-ping" title="Round-trip time to the host">{p.host ? "0 ms" : p.pingMs === null ? "Measuring…" : p.pingMs + " ms"}</span>
          {p.id !== localId && <button type="button" data-give-to={p.id} onClick={() => {
            setRecipient(p.id); setSelection("fuel:fuel"); setAmount("1"); setNotice(""); setConfirmKick(null);
          }}>Send supplies</button>}
          {host && !p.host && <button type="button" aria-label={`Remove ${p.name}`} onClick={() => setConfirmKick(p.id)}>Remove</button>}
          {host && confirmKick === p.id && <div className="crew-confirm">
            <p>Remove {p.name} until you stop hosting? Their ship and cargo will be saved.</p>
            <button onClick={() => setConfirmKick(null)}>Cancel</button>
            <button className="crew-remove" onClick={async () => {
              const { kickPilot } = await import("@/net/hostController");
              kickPilot(p.id);
              setConfirmKick(null);
            }}>Remove pilot</button>
          </div>}
        </li>)}</ul>
      </section>
      <section className="crew-fix">
        <MapPin size={20} aria-hidden />
        <div><h3>Rendezvous</h3><p>{fix ? fix.name : "Mark your position for every pilot."}</p></div>
        <div className="crew-actions"><button disabled={pending} onClick={() =>
          submit({ type: "expedition.mark", sourceId: null, name: "Rendezvous · " + (getWorldState().members[getLocalPlayerId()]?.name || "Pilot"), opId: newOpId() }, "Position shared")}>{fix ? "Move marker here" : "Share my position"}</button>
        {fix && <button disabled={pending} onClick={() =>
          submit({ type: "expedition.mark", sourceId: null, name: "", clear: true, opId: newOpId() }, "Marker cleared")}>Clear my marker</button>}</div>
      </section>
      </>}
      {recipient && <section>
        <button className="crew-back" disabled={pending} onClick={() => { setRecipient(""); setNotice(""); }}>‹ All pilots</button>
        <h3>{target ? `Supplies for ${target.name}` : "Pilot disconnected"}</h3>
        {target ? <p>{target.km === null ? "Position unavailable" : target.km < 1 ? Math.round(target.km * 1000) + " m away" : target.km.toLocaleString(undefined, {maximumFractionDigits: 1}) + " km away"} · Transfer range {GIFT_RANGE_KM * 1000} m</p> : <p>Return to the pilot list to choose another recipient.</p>}
        {target &&
        <form onSubmit={e => {
          e.preventDefault();
          if (!supply || !to || !nearby || !valid || pending) return;
          const sep = value.indexOf(":");
          submit({ type: "expedition.give", opId: newOpId(), to, kind: value.slice(0, sep) as GiftKind,
            itemId: value.slice(sep + 1), amount: Number(amount) }, `Delivered ${amount} ${unit} of ${supply.label.toLowerCase()} to ${target.name}`);
        }}>
          <label>Supply<select disabled={pending} value={value} onChange={e => { setSelection(e.target.value); setAmount("1"); setNotice(""); }}>
            {!supply && <option value={value}>Supply depleted</option>}
            {supplies.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select></label>
          <label>Amount ({unit})<input disabled={pending} type="number" min="1" max={available} step="1" required inputMode="numeric" value={amount} onChange={e => setAmount(e.target.value)} /></label>
          <div className="crew-quantity"><span>{available} {unit} available</span>
            <button type="button" disabled={pending || !available} onClick={() => setAmount(String(Math.max(1, Math.floor(available / 2))))}>Half</button>
            <button type="button" disabled={pending || !available} onClick={() => setAmount(String(available))}>Max</button></div>
          <button className="crew-send" disabled={pending || !valid || !nearby} type="submit"><Send size={15} />
            {nearby ? `Send ${amount || "0"} ${unit} to ${target.name}` : !target ? "Select a pilot" : "Move within " + GIFT_RANGE_KM * 1000 + " m to transfer"}</button>
        </form>}</section>}
      {notice && <div role="status">{notice}</div>}
    </div>
  );
}
