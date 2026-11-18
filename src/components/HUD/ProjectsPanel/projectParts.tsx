"use client";

import { useAtomValue } from "jotai";
import { FlaskConical, Fuel, MapPin, Navigation, Orbit, Wrench } from "lucide-react";
import type { ProjectLine, ProjectLineIcon, ProjectSub } from "@/sim/research/projects";
import { cargoAtom } from "@/store/cargo";
import { AnalysisChips, ReqAnyGroup, ReqChip } from "../shared/Chips";

const ICONS: Record<ProjectLineIcon, typeof Fuel> = {
  research: FlaskConical, craft: Wrench, fuel: Fuel, field: Orbit, site: MapPin, point: Navigation,
};

export function LineIcon({ icon, size = 12 }: { icon: ProjectLineIcon; size?: number }) {
  const I = ICONS[icon];
  return <I className="pp-line-icon" size={size} strokeWidth={1.75} aria-hidden />;
}

/** A research step's open pieces as requirement chips (Projects panel and tracker). */
export function SubChips({ sub, max }: { sub: readonly ProjectSub[]; max: number }) {
  const cargo = useAtomValue(cargoAtom).items;
  const open = sub.filter((x) => !x.met).slice(0, max);
  const analysis: Record<string, number> = {};
  for (const x of open) if (x.analysis) analysis[x.analysis.material] = x.analysis.need;
  return (
    <span className="pp-chips">
      {open.map((x, i) =>
        x.req ? <ReqChip key={i} req={x.req} met={false} /> : x.any ? <ReqAnyGroup key={i} items={x.any} met={false} /> : null,
      )}
      <AnalysisChips analysis={analysis} cargo={cargo} />
    </span>
  );
}

/** Step text with its entity name marked (a name is not prose for the text budget). */
export function LineText({ line }: { line: Pick<ProjectLine, "text" | "name"> }) {
  const i = line.name ? line.text.indexOf(line.name) : -1;
  if (!line.name || i < 0) return <span className="pp-step__text">{line.text}</span>;
  return (
    <span className="pp-step__text">
      {line.text.slice(0, i)}
      <span data-name="">{line.name}</span>
      {line.text.slice(i + line.name.length)}
    </span>
  );
}
