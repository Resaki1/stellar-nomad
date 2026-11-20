import { materialName } from "@/data/content";
import type { miningFieldsAt } from "@/sim/industry/mining";
import type { DroneJob } from "@/sim/industry/types";

type MineFilter = NonNullable<DroneJob["mineFilter"]>;
export type MiningField = ReturnType<typeof miningFieldsAt>[number];
export type MiningFilterDraft = { mode: MineFilter["mode"]; classes: string[]; resources: string[] };

export function miningFilterForField(field: MiningField, draft: MiningFilterDraft): MineFilter | null {
  if (draft.mode === "all") return { mode: "all" };
  const ids = draft.mode === "class"
    ? draft.classes.filter(id => field.classes.some(group => group.id === id))
    : draft.resources.filter(id => field.resources.includes(id));
  return ids.length ? { mode: draft.mode, ids } : null;
}

export default function DroneMiningFilters({ field, draft, disabled, onChange }: {
  field: MiningField;
  draft: MiningFilterDraft;
  disabled: boolean;
  onChange: (draft: MiningFilterDraft) => void;
}) {
  const picks = draft.mode === "class" ? "classes" : "resources";
  const options = draft.mode === "class" ? field.classes : field.resources.map(id => ({ id, name: materialName(id) }));
  return <div className="industry__mine-filters">
    <label>Mine
      <select data-industry-mine-filter value={draft.mode} disabled={disabled} onChange={e => {
        const mode = e.target.value;
        if (mode === "all" || mode === "class" || mode === "resource") onChange({ ...draft, mode });
      }}>
        <option value="all">All asteroids</option>
        <option value="class">Selected asteroid classes</option>
        <option value="resource">Asteroids containing selected resources</option>
      </select>
    </label>
    {draft.mode !== "all" && <fieldset className="industry__mine-options" disabled={disabled}>
      <legend>{draft.mode === "class" ? "Asteroid classes" : "Resources"}</legend>
      {options.map(option => <label key={option.id}>
        <input type="checkbox" data-industry-mine-choice={option.id} checked={draft[picks].includes(option.id)}
          onChange={e => onChange({ ...draft, [picks]: e.target.checked ? [...draft[picks], option.id] : draft[picks].filter(id => id !== option.id) })} />
        {option.name}
      </label>)}
      {!miningFilterForField(field, draft) && <small>Choose at least one {draft.mode === "class" ? "class" : "resource"} to start this job.</small>}
    </fieldset>}
    {draft.mode !== "all" && <small>The drone mines asteroids matching any selection and brings back everything they yield.</small>}
  </div>;
}
