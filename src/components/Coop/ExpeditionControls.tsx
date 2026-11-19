"use client";

import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { getItemDef, materialName } from "@/data/content";
import { remotePoses, REMOTE_STALE_MS } from "@/net/coopState";
import { getWorldState } from "@/save/activeSave";
import { getLocalPlayerId } from "@/save/playerId";
import { cargoAtom } from "@/store/cargo";
import { modulesAtom } from "@/store/modules";
import { rendezvousAtom } from "@/store/discoveries";
import { newOpId, runOperation, describeRejection } from "@/store/operations";
import type { GiftKind, WorldOperation } from "@/sim/world/commands";
import { GIFT_RANGE_KM } from "@/sim/world/reducers";

function onlinePilots() {
  return Array.from(remotePoses).filter(([, poses]) => {
    const pose = poses.at(-1);
    return pose && performance.now() - pose.at <= REMOTE_STALE_MS;
  }).map(([id]) => ({ id, name: getWorldState().members[id]?.name || "Pilot" }));
}

export default function ExpeditionControls({ discoveries }: { discoveries?: string }) {
  const cargo = useAtomValue(cargoAtom);
  const modules = useAtomValue(modulesAtom);
  const fix = useAtomValue(rendezvousAtom)[getLocalPlayerId()];
  const [pilots, setPilots] = useState(onlinePilots);
  const [recipient, setRecipient] = useState("");
  const [selection, setSelection] = useState("fuel:fuel");
  const [amount, setAmount] = useState("1");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const timer = setInterval(() => setPilots(onlinePilots()), 1000);
    return () => clearInterval(timer);
  }, []);
  const to = pilots.find(p => p.id === recipient)?.id ?? pilots[0]?.id;
  const supplies = [
    { value: "fuel:fuel", label: "Ordinary fuel (kg)" },
    ...Object.entries(cargo.items).filter(([, n]) => n > 0).map(([id,n]) => ({ value: "cargo:" + id, label: materialName(id) + " × " + n })),
    ...Object.entries(modules.consumables).filter(([, n]) => n > 0).map(([id,n]) => ({ value: "consumable:" + id, label: (getItemDef(id)?.name ?? id) + " × " + n })),
  ];
  const value = supplies.some(s => s.value === selection) ? selection : supplies[0].value;
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
      {discoveries && <div>{discoveries}</div>}
      <button className="settings-menu__button" disabled={pending} onClick={() =>
        submit({ type: "expedition.mark", sourceId: null, name: "Rendezvous · " + getWorldState().members[getLocalPlayerId()].name, opId: newOpId() }, "Position shared")}>Share my position</button>
      {fix && <button className="settings-menu__button" disabled={pending} onClick={() =>
        submit({ type: "expedition.mark", sourceId: null, name: "", clear: true, opId: newOpId() }, "Marker cleared")}>Clear my marker</button>}
      {to && <form onSubmit={e => {
        e.preventDefault();
        const sep = value.indexOf(":");
        submit({ type: "expedition.give", opId: newOpId(), to, kind: value.slice(0, sep) as GiftKind,
          itemId: value.slice(sep + 1), amount: Number(amount) }, "Supplies delivered");
      }}>
        <label>Pilot <select value={to} onChange={e => setRecipient(e.target.value)}>
          {pilots.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select></label>
        <label>Supplies <select value={value} onChange={e => setSelection(e.target.value)}>
          {supplies.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select></label>
        <label>Amount <input type="number" min="1" step="1" required value={amount} onChange={e => setAmount(e.target.value)} /></label>
        <button className="settings-menu__button" disabled={pending} type="submit">Give within {GIFT_RANGE_KM * 1000} m</button>
      </form>}
      {notice && <div role="status">{notice}</div>}
    </div>
  );
}
