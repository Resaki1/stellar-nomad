"use client";

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAtomValue } from "jotai";
import { Check, Circle, Droplet, FlaskConical, Fuel, MapPin, Route, ScanLine, Wrench, Zap } from "lucide-react";
import { displayKey, keybindsAtom, type KeybindAction } from "@/store/keybinds";
import { MATERIAL_NAMES, getItemDef, getItemIconUrl, materialName, type Requirement } from "@/data/content";
import { requirementChip, type ReqChipIcon } from "@/sim/research/requirements";

import "./Chips.scss";

const TOOLTIP_DELAY_MS = 160;

/** Hover tooltip, portalled to the body so a panel's overflow never clips it. */
export function Tooltip({ text, children, className }: { text: string | null | undefined; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  const enter = (): void => {
    if (!text) return;
    timer.current = window.setTimeout(() => {
      const r = ref.current?.getBoundingClientRect();
      if (r) setPos({ x: r.left + r.width / 2, y: r.top });
    }, TOOLTIP_DELAY_MS);
  };
  const leave = (): void => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setPos(null);
  };
  return (
    <span ref={ref} className={className} onMouseEnter={enter} onMouseLeave={leave}>
      {children}
      {pos && text && typeof document !== "undefined" &&
        createPortal(<span className="sn-tooltip" role="tooltip" style={{ left: pos.x, top: pos.y }}>{text}</span>, document.body)}
    </span>
  );
}

/** A key as the player has bound it (`[G]`); rebinding updates every chip. */
export function KeyChip({ action, keyName, dim }: { action?: KeybindAction; keyName?: string; dim?: boolean }) {
  const binds = useAtomValue(keybindsAtom);
  const key = keyName ?? (action ? binds[action][0] : undefined);
  return <kbd className={`sn-key${dim ? " sn-key--dim" : ""}`}>{key ? displayKey(key) : "–"}</kbd>;
}

const ICON_URL: Record<string, string> = {
  silicates: "/assets/resources/silicates.png",
  fe_ni_metal: "/assets/resources/fe_ni_metal.png",
  sulfur: "/assets/resources/sulfur.png",
  carbon: "/assets/resources/carbon.png",
  hydrates: "/assets/resources/hydrates.png",
};
/** Materials without artwork get a lettered glyph (no broken image). */
const GLYPH: Record<string, string> = { titanium: "Ti", helium_3: "He" };

/** The bare 16 px material glyph (no tooltip: callers that already have one). */
export function ResourceGlyph({ id }: { id: string }) {
  const url = ICON_URL[id];
  return url ? <img className="sn-res__icon" src={url} alt={materialName(id)} /> : <span className="sn-res__glyph" aria-label={materialName(id)}>{GLYPH[id] ?? id.slice(0, 2)}</span>;
}

/** 16 px material icon + optional amount; tooltip = material name (and have / need). */
export function ResourceIcon({ id, amount, have, estimated, signed }: { id: string; amount?: number; have?: number; estimated?: boolean; signed?: boolean }) {
  const short = have !== undefined && amount !== undefined && have < amount;
  const tip = have !== undefined && amount !== undefined ? `${materialName(id)} · ${have} / ${amount}` : materialName(id);
  return (
    <Tooltip text={tip} className={`sn-res${estimated ? " sn-res--est" : ""}${short ? " sn-res--short" : ""}`}>
      <ResourceGlyph id={id} />
      {amount !== undefined && (
        <span className="sn-res__n">
          {signed && amount > 0 ? "+" : ""}
          {have !== undefined ? `${have}/${amount}` : amount}
        </span>
      )}
    </Tooltip>
  );
}

/** Text with `{action}` tokens rendered as key chips (hints follow rebinding). */
export function KeyText({ text }: { text: string }) {
  const parts = text.split(/\{([a-zA-Z]+)\}/);
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1 ? <KeyChip key={i} action={p as KeybindAction} /> : <Fragment key={i}>{p}</Fragment>))}
    </>
  );
}

/** A material, the fuel tank or an item, with an optional amount (stack values, wreck rows). */
export function ValueChip({ id, amount, unit, signed }: { id: string; amount?: number; unit?: string; signed?: boolean }) {
  if (id in MATERIAL_NAMES) return <ResourceIcon id={id} amount={amount} signed={signed} />;
  if (id === "fuel") {
    return (
      <Tooltip text="Fuel" className="sn-res">
        <Fuel size={13} strokeWidth={1.75} aria-label="Fuel" />
        {amount !== undefined && <span className="sn-res__n">{`${Math.round(amount)} ${unit ?? "kg"}`}</span>}
      </Tooltip>
    );
  }
  const item = getItemDef(id);
  if (!item) return null;
  return (
    <Tooltip text={item.name} className="sn-res">
      <img className="sn-res__icon" src={getItemIconUrl(item)} alt={item.name} />
      {amount !== undefined && <span className="sn-res__n">×{amount}</span>}
    </Tooltip>
  );
}

const REQ_ICON: Record<Exclude<ReqChipIcon, "material" | "class">, typeof Zap> = {
  beam: Zap, batch: Droplet, craft: Wrench, transit: Route, site: MapPin, research: FlaskConical,
};

/** Requirement chip (spec §4.1): state glyph + kind icon + ≤ 3-word label; tooltip = the requirement. */
export function ReqChip({ req, met }: { req: Requirement; met: boolean }) {
  const c = requirementChip(req);
  const Icon = c.icon === "material" || c.icon === "class" ? null : REQ_ICON[c.icon];
  return (
    <Tooltip text={c.tip} className={`sn-req${met ? " sn-req--met" : ""}`}>
      {met ? <Check className="sn-req__state" size={10} strokeWidth={2.5} aria-label="done" /> : <Circle className="sn-req__state" size={9} strokeWidth={2} aria-label="open" />}
      {c.material && <ResourceGlyph id={c.material} />}
      {c.icon === "class" && <span className="sn-req__badge">{c.label}</span>}
      {Icon && <Icon size={12} strokeWidth={1.75} aria-hidden />}
      {c.scan && <ScanLine className="sn-req__scan" size={10} strokeWidth={2} aria-label="inspected" />}
      {Icon && c.label && <span className="sn-req__label" data-name={c.icon === "research" ? "" : undefined}>{c.label}</span>}
    </Tooltip>
  );
}

/** Any-of group: chips inside a thin bracket labelled `1 of`. */
export function ReqAnyGroup({ items, met }: { items: { req: Requirement; met: boolean }[]; met: boolean }) {
  return (
    <span className={`sn-req-any${met ? " sn-req-any--met" : ""}`}>
      <span className="sn-req-any__label">1 of</span>
      {items.map((x, i) => <ReqChip key={i} req={x.req} met={x.met} />)}
    </span>
  );
}

/** Analysis material: flask + amounts (red have/need when short). */
export function AnalysisChips({ analysis, cargo }: { analysis: Record<string, number>; cargo: Readonly<Record<string, number>> }) {
  const entries = Object.entries(analysis);
  if (entries.length === 0) return null;
  return (
    <span className="sn-analysis">
      <Tooltip text="Consumed when unlocking" className="sn-analysis__flask">
        <FlaskConical size={12} strokeWidth={1.75} aria-label="analysis" />
      </Tooltip>
      {entries.map(([k, n]) => {
        const have = Math.floor(cargo[k] ?? 0);
        return <ResourceIcon key={k} id={k} amount={n} have={have < n ? have : undefined} />;
      })}
    </span>
  );
}
