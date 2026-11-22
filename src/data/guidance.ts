// ---------------------------------------------------------------------------
// Hints and help records (M3.7). Hints are one-time `tip` items in the Notification Stack
// (≤ 10 words; `{action}` renders the bound key): each id enters the played registry when shown.
// Records are optional reading, opened from the Projects panel.
// ---------------------------------------------------------------------------

export type HintDef = { id: string; text: string };

export const HINTS = {
  projects: { id: "hint_projects", text: "{toggleProjects} Projects: pick a goal to track" },
  lock: { id: "hint_lock", text: "Aim at a rock to lock it" },
  hydrates: { id: "hint_hydrates", text: "Hydrates → fuel: {toggleCrafting} Craft › Processing" },
  heat: { id: "hint_heat", text: "Heat high: the laser trips at 100 %" },
  thinAir: { id: "hint_thin_air", text: "Thin air: thrust burns water and heat. Dive low or climb out" },
  cargoFull: { id: "hint_cargo_full", text: "Hold full: craft, process or jettison {toggleCargo}" },
  lowFuel: { id: "hint_low_fuel", text: "Fuel low: process hydrates {toggleCrafting}" },
  damage: { id: "hint_damage", text: "Hull damaged: repair in {toggleCrafting} Craft" },
  drive: { id: "hint_drive", text: "Look at a marker, hold {transitDrive} to travel" },
  recovered: { id: "hint_recovered", text: "Your wreck keeps cargo and fuel" },
} satisfies Record<string, HintDef>;

/** Retired by playtest 1 (shown elsewhere now); kept so played registries stay valid. */
export const RETIRED_HINT_IDS: readonly string[] = ["hint_research", "hint_kit", "hint_site"];

export const HINT_IDS: readonly string[] = [...Object.values(HINTS).map((h) => h.id), ...RETIRED_HINT_IDS];

export type RecordDef = {
  id: string;
  title: string;
  paragraphs: string[];
  /** Hidden until this played id (hint/comms) or discovery exists; null = always. */
  after: string | null;
};

export const RECORDS: RecordDef[] = [
  {
    id: "premise",
    title: "The project",
    after: null,
    paragraphs: ["Humanity built probes to find new homes. This one woke late, and no one is left. The archive aboard keeps humanity's chance; where it goes is yours to decide."],
  },
  {
    id: "fuel",
    title: "Propellant",
    after: null,
    paragraphs: ["Thrust and transit burn propellant; coasting is free. Process hydrates in Craft › Processing: 20 kg per unit. The amber reserve refills only when you respawn."],
  },
  {
    id: "research",
    title: "Research",
    after: null,
    paragraphs: ["Research unlocks blueprints from evidence: confirmed materials, inspected rock classes, trials and recovered sites. Unlocking uses a little material."],
  },
  {
    id: "classes",
    title: "Rock classes",
    after: null,
    paragraphs: ["S: silicates, some metal. C: hydrates, carbon, sulfur. X: mostly Fe-Ni. Lunar L-types add titanium."],
  },
  {
    id: "recovery",
    title: "Respawn",
    after: null,
    paragraphs: ["A lost ship is rebuilt at your active point with its modules. Cargo and fuel stay in the wreck: fly back for them. Place points with a replication kit."],
  },
  {
    id: "survey",
    title: "Survey canister",
    after: "lunar_signal_001",
    paragraphs: ["An old survey installation past the Moon still transmits. Its canister holds an optional scanner design."],
  },
];
