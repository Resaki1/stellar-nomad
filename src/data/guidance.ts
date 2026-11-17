// ---------------------------------------------------------------------------
// Hints and help records (M3.7). Hints are one-time, non-blocking lines (no Continue): each
// id enters the player's played registry when shown, so it never repeats after a reload.
// Records are optional reading, opened from the Projects panel (O).
// ---------------------------------------------------------------------------

export type HintDef = { id: string; text: string };

export const HINTS = {
  projects: { id: "hint_projects", text: "Press O to choose a project: the tracker turns it into concrete steps." },
  lock: { id: "hint_lock", text: "Keep a rock under the reticle to lock it. G runs a close inspection: composition and yield." },
  hydrates: { id: "hint_hydrates", text: "Hydrates aboard. Workshop (F) processes them into propellant, 20 kg per unit." },
  research: { id: "hint_research", text: "A research option has all its evidence. Research (R) unlocks it." },
  heat: { id: "hint_heat", text: "Heat above 80 %: the laser trips at 100 %. Ease off, or use a heat sink cartridge." },
  cargoFull: { id: "hint_cargo_full", text: "Hold full. Fabricate, process hydrates, or jettison from Cargo (Tab)." },
  lowFuel: { id: "hint_low_fuel", text: "Propellant low. Coasting is free; thrust, braking and transit are not. Hydrate rocks refill the tank." },
  damage: { id: "hint_damage", text: "Hull damaged. Workshop (F) repairs it with Fe-Ni metal, 1 unit per percent." },
  kit: { id: "hint_kit", text: "Replication kit aboard. B places it as a new recovery point; H makes a nearby point active." },
  drive: { id: "hint_drive", text: "Transit drive fitted. Look at a destination marker to lock it, then hold T. The plan shows fuel and ETA first." },
  recovered: { id: "hint_recovered", text: "Recovered at your active point. The wreck keeps your cargo and fuel: its marker leads back to it." },
  site: { id: "hint_site", text: "Survey site in range. G inspects it; recovering the canister takes one more G within 1 km." },
} satisfies Record<string, HintDef>;

export const HINT_IDS: readonly string[] = Object.values(HINTS).map((h) => h.id);

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
    paragraphs: [
      "Humanity built autonomous probes to find places where people could live again. This one came online late, near an Earth that can no longer support human life.",
      "The archive aboard preserves the possibility of restoring humanity. It needs no care. Replication points hold copies of it, so losing a ship never ends the goal.",
      "No one directs the work and no destination is required. Explore, build, settle somewhere, or keep moving.",
    ],
  },
  {
    id: "fuel",
    title: "Propellant",
    after: null,
    paragraphs: [
      "Thrust, braking and transit burn ordinary propellant. Coasting, rotation at rest and simply waiting cost nothing.",
      "Mine hydrate-bearing rocks (C-type at Earth, L-volatile at the Moon) and process them in the Workshop (F): 20 kg per hydrate unit.",
      "The small protected allowance (amber bar) only refills at recovery. It cannot be salvaged or transferred; it exists so a stranded ship can always move again.",
    ],
  },
  {
    id: "research",
    title: "Research and evidence",
    after: null,
    paragraphs: [
      "Research options unlock blueprints from evidence: materials confirmed by inspection or mining, inspected rock classes, simple trials, and recovered sites. Each piece is recorded once for the whole world.",
      "An analysis consumes a little matching material. There are no timers and nothing to farm.",
    ],
  },
  {
    id: "classes",
    title: "Rock classes",
    after: null,
    paragraphs: [
      "S-type: mostly silicates with some Fe-Ni metal. C-type: carbonaceous, the hydrate source near Earth, with carbon and sulfur. X-type: metallic, 60 to 90 % Fe-Ni.",
      "Lunar field: L-regolith (silicates, titanium), L-metallic (Fe-Ni, titanium) and L-volatile (hydrates, carbon).",
    ],
  },
  {
    id: "recovery",
    title: "Replication and recovery",
    after: null,
    paragraphs: [
      "If the ship is destroyed or abandoned, a new hull is replicated at your active point with the same equipment, a cold reactor, full hull and the protected allowance.",
      "Cargo, loose consumables and ordinary propellant stay in a wreck at the loss site. Fly back to collect them, partly or all at once.",
      "Place a point with a replication kit (B). The emergency fallback to the origin point is always offered on the recovery screen.",
    ],
  },
  {
    id: "survey",
    title: "Automated survey installation",
    after: "lunar_signal_001",
    paragraphs: [
      "An abandoned survey installation in the debris field past the Moon still transmits. Its instrument canister can be inspected and recovered once.",
      "The recovered design is an optional scanner upgrade. Fuel, repairs and replication kits never depend on it.",
    ],
  },
];
