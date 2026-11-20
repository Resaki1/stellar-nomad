"use client";

import { useEffect, useRef, useState, type Ref } from "react";
import { cleanPointName, MAX_POINT_NAME } from "@/sim/replication/points";
import { newOpId, runOperation, describeRejection } from "@/store/operations";
import { playAudio } from "@/audio/voices";
import Panel from "../Shell/Panel";

export type NamedStructure = { kind: "depot" | "point"; id: string; name: string };

export default function StructureNameEditor({ structure, formRef, onClose }: {
  structure: NamedStructure;
  formRef: Ref<HTMLFormElement>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(structure.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const name = cleanPointName(draft, "");
  const kind = structure.kind === "depot" ? "depot" : "replication point";
  const close = () => { if (!inFlight.current) onClose(); };
  const save = () => {
    if (!name || name === structure.name || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    const opId = newOpId();
    const op = structure.kind === "depot"
      ? { type: "depot.rename" as const, depotId: structure.id, name, opId }
      : { type: "replication.rename" as const, pointId: structure.id, name, opId };
    runOperation(op, outcome => {
      if (outcome.status === "pending") return;
      inFlight.current = false;
      setPending(false);
      if (outcome.status !== "rejected" || outcome.reason === "already_done") {
        onClose();
      } else {
        setError(describeRejection(outcome));
        playAudio("ui.reject");
      }
    });
  };
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  return <Panel title={`Rename ${kind}`} width={400} onClose={close}
    primaryAction={{ label: pending ? "Saving…" : "Save name", onClick: save, disabled: !name || name === structure.name || pending }}
    secondaryAction={{ label: "Cancel", onClick: close, disabled: pending }}>
    <form ref={formRef} className="industry industry__rename-form" onSubmit={e => { e.preventDefault(); save(); }}>
      <label>Name<input ref={input} value={draft} maxLength={MAX_POINT_NAME} disabled={pending}
        onChange={e => setDraft(e.target.value)} spellCheck={false} autoComplete="off" /></label>
      {error && <p role="alert">{error}</p>}
    </form>
  </Panel>;
}
