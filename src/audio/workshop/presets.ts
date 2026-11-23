/** Authoring data only. Event names are destinations, not new gameplay triggers. */
export type SoundFamily = "motor" | "cutter" | "drive" | "wind" | "jet" | "impact" | "creak" | "signal" | "air" | "mechanism" | "roar";
export type SoundGesture = "steady" | "rise" | "fall" | "hit" | "confirm" | "reject" | "tick"
  | "vent" | "purge" | "relay" | "unlatch" | "jettison" | "repair" | "boot";
export type Recipe = {
  version: 1;
  presetId: string;
  seed: number;
  duration: number;
  pitch: number;
  brightness: number;
  motion: number;
  body: number;
  texture: number;
  detail: number;
};
export type SoundPreset = {
  id: string;
  name: string;
  group: "Mining" | "Flight" | "Interface" | "Hull";
  trigger: string;
  character: string;
  family: SoundFamily;
  gesture: SoundGesture;
  hz: number;
  duration: number;
  loop?: boolean;
  variants: number;
  bus: "sfxShip" | "sfxWorld" | "ui" | "ambience";
  experimental?: boolean;
  /** Relative authoring level. This is sample peak dBFS, never physical dB SPL. */
  peakDb: number;
  defaults?: Partial<Pick<Recipe, "brightness" | "motion" | "body" | "texture" | "detail">>;
};

export const SOUND_PRESETS: readonly SoundPreset[] = [
  { id: "mining.laser.loop", name: "Cutter sustain", group: "Mining", trigger: "While the mining beam is active.", character: "Power electronics, cooling turbulence and a restrained electrical edge. Heard aboard your own ship.", family: "cutter", gesture: "steady", hz: 116, duration: 4, loop: true, variants: 1, bus: "sfxShip", peakDb: -9 },
  { id: "mining.laser.start", name: "Cutter ignition", group: "Mining", trigger: "When the mining beam starts.", character: "A contactor closes, then the power stage comes up to speed.", family: "cutter", gesture: "rise", hz: 116, duration: 0.38, variants: 2, bus: "sfxShip", peakDb: -7 },
  { id: "mining.laser.stop", name: "Cutter release", group: "Mining", trigger: "When mining stops or is cancelled.", character: "Electrical energy winds down into a short cooling tail.", family: "cutter", gesture: "fall", hz: 116, duration: 0.42, variants: 2, bus: "sfxShip", peakDb: -10 },
  { id: "mining.complete", name: "Extraction complete", group: "Mining", trigger: "When the asteroid is depleted and extraction finishes.", character: "A small mechanical settle and a two-note instrument acknowledgement.", family: "signal", gesture: "confirm", hz: 440, duration: 0.52, variants: 2, bus: "sfxShip", peakDb: -10 },
  { id: "loot.acquire", name: "Cargo receipt", group: "Mining", trigger: "When resources are added to cargo.", character: "A dry, rounded ceramic tick with a brief upward resolution.", family: "signal", gesture: "confirm", hz: 740, duration: 0.2, variants: 3, bus: "ui", peakDb: -13, defaults: { texture: 0.18, detail: 0.35 } },
  { id: "ship.engine.idle", name: "Engine / idle", group: "Flight", trigger: "Low positive thrust; silent at zero demand.", character: "Low reactor weight and uneven mechanical vibration; no idle floor during coasting.", family: "motor", gesture: "steady", hz: 48, duration: 6, loop: true, variants: 1, bus: "sfxShip", peakDb: -10, defaults: { body: 1, brightness: 0.3, texture: 0.35, detail: 0.25, motion: 0.35 } },
  { id: "ship.engine.mid", name: "Engine / cruise", group: "Flight", trigger: "Medium engine thrust; blend with idle and high.", character: "More load in the same motor family, with a broad mechanical rush.", family: "motor", gesture: "steady", hz: 48, duration: 6, loop: true, variants: 1, bus: "sfxShip", peakDb: -8, defaults: { body: 1, brightness: 0.5, texture: 0.55, detail: 0.45, motion: 0.5 } },
  { id: "ship.engine.high", name: "Engine / full thrust", group: "Flight", trigger: "High engine thrust; blend with the other engine layers.", character: "Loaded harmonics and denser vibration, without a piercing turbine whistle.", family: "motor", gesture: "steady", hz: 48, duration: 6, loop: true, variants: 1, bus: "sfxShip", peakDb: -7, defaults: { body: 1, brightness: 0.7, texture: 0.75, detail: 0.7, motion: 0.65 } },
  // The drive heard from inside, AUDIO_PLAN §6.10. Pumps and transients are structure-borne
  // (play in vacuum); roar and shock are the jet's own noise through the hull (air only).
  { id: "ship.engine.pump", name: "Engine / feed pumps", group: "Flight", trigger: "While thrusting; pitch follows commanded water flow (up to +1 oct in thick air).", character: "Blade-pass whine of the feed pumps with flow rush, heard through the frame. Quiet in vacuum, working hard in air.", family: "drive", gesture: "steady", hz: 230, duration: 3, loop: true, variants: 1, bus: "sfxShip", peakDb: -14, defaults: { body: 0.55, brightness: 0.55, texture: 0.5, detail: 0.6, motion: 0.3 } },
  { id: "ship.engine.roar", name: "Engine / jet roar", group: "Flight", trigger: "Thrusting in air: the jet's own noise arriving through the hull; silent in vacuum.", character: "Deep, heavy broadband roar with sparse, positively skewed crackle. Hull-filtered: weight, not hiss.", family: "roar", gesture: "steady", hz: 40, duration: 6, loop: true, variants: 1, bus: "sfxShip", peakDb: -8, defaults: { body: 1, brightness: 0.35, texture: 0.55, detail: 0.6, motion: 0.5 } },
  { id: "ship.engine.shock", name: "Engine / shock cells", group: "Flight", trigger: "In air while shock diamonds exist; pitch follows the cell spacing (~20–80 Hz).", character: "A low, throbbing hum riding the roar: broadband-shock noise peaked by the cell spacing.", family: "drive", gesture: "steady", hz: 48, duration: 4, loop: true, variants: 1, bus: "sfxShip", peakDb: -12, defaults: { body: 1, brightness: 0.3, texture: 0.35, detail: 0.4, motion: 0.4 } },
  { id: "ship.engine.ignite", name: "Engine / ignition", group: "Flight", trigger: "Throttle up from zero.", character: "Feed valves open and the chamber lights: one heavy thump through the thrust frame.", family: "impact", gesture: "hit", hz: 42, duration: 1.4, variants: 2, bus: "sfxShip", peakDb: -9, defaults: { body: 1, brightness: 0.25, texture: 0.35, detail: 0.3, motion: 0.2 } },
  { id: "ship.engine.cutoff", name: "Engine / cutoff", group: "Flight", trigger: "Throttle back to zero after a burn.", character: "Thrust unloads from the frame: a softer settle-thump than ignition.", family: "impact", gesture: "hit", hz: 56, duration: 1.0, variants: 2, bus: "sfxShip", peakDb: -13, defaults: { body: 0.9, brightness: 0.2, texture: 0.25, detail: 0.25, motion: 0.2 } },
  { id: "ship.bell.ping", name: "Drive bell / thermal ping", group: "Hull", trigger: "While the drive bells heat or cool fast (rate ∝ |dT/dt|, HEAT_SYSTEM_PLAN §4): densest right after a long burn's cutoff.", character: "A thin refractory shell slipping at its mounts: bright, short metallic pings from aft, more resonant than the hull ticks.", family: "impact", gesture: "hit", hz: 1700, duration: 0.35, variants: 3, bus: "sfxShip", peakDb: -20, defaults: { body: 0.3, brightness: 0.75, texture: 0.2, detail: 0.9, motion: 0.2 } },
  { id: "ship.coolant.loop", name: "Coolant loop", group: "Hull", trigger: "While the heat store is above idle; level and pump speed follow heat01.", character: "Coolant pumps and flow through the radiator manifolds: a low pump hum under a soft liquid rush, heard through the frame.", family: "drive", gesture: "steady", hz: 92, duration: 4, loop: true, variants: 1, bus: "sfxShip", peakDb: -17, defaults: { body: 0.7, brightness: 0.25, texture: 0.75, detail: 0.3, motion: 0.45 } },
  { id: "ship.hull.tick", name: "Hull / thermal tick", group: "Hull", trigger: "After a burn, as heat soaked into the structure relaxes; rate decays with the soak.", character: "Tiny thermal-expansion pings from joints and panels. Sparse and quiet.", family: "impact", gesture: "hit", hz: 900, duration: 0.2, variants: 3, bus: "sfxShip", peakDb: -22, defaults: { body: 0.4, brightness: 0.6, texture: 0.3, detail: 0.7, motion: 0.2 } },
  { id: "transit.spool", name: "Drive charge", group: "Flight", trigger: "The transit drive spools up before engagement.", character: "An accelerating field tone with rising mechanical pressure. A designed fictional drive, not a recording.", family: "drive", gesture: "rise", hz: 82, duration: 3, variants: 1, bus: "sfxShip", peakDb: -8 },
  { id: "transit.engage", name: "Drive engagement", group: "Flight", trigger: "The charged transit drive engages.", character: "A weighted low onset, short magnetic sweep and restrained upper shimmer.", family: "drive", gesture: "hit", hz: 82, duration: 1.1, variants: 1, bus: "sfxShip", peakDb: -5 },
  { id: "transit.loop", name: "Transit field", group: "Flight", trigger: "Sustained transit flight.", character: "Slow phase motion and a broad low field, leaving room for ship alerts.", family: "drive", gesture: "steady", hz: 82, duration: 6, loop: true, variants: 1, bus: "sfxShip", peakDb: -11 },
  { id: "transit.decel", name: "Drive rundown", group: "Flight", trigger: "The transit drive decelerates.", character: "The charged field descends toward idle.", family: "drive", gesture: "fall", hz: 82, duration: 2.2, variants: 1, bus: "sfxShip", peakDb: -9 },
  { id: "transit.arrive", name: "Arrival settle", group: "Flight", trigger: "Transit finishes at the destination.", character: "A compact falling field tone and soft low resonance.", family: "drive", gesture: "fall", hz: 68, duration: 0.9, variants: 1, bus: "sfxShip", peakDb: -9 },
  { id: "click.soft", name: "Soft switch", group: "Interface", trigger: "Ordinary UI activation.", character: "A tactile, low-energy switch. Short enough for repeated use.", family: "signal", gesture: "tick", hz: 480, duration: 0.075, variants: 1, bus: "ui", peakDb: -15, defaults: { texture: 0.4, detail: 0.12 } },
  { id: "click.hard", name: "Firm switch", group: "Interface", trigger: "A deliberate confirmation or major UI action.", character: "A slightly weightier switch with a tight resonant body.", family: "signal", gesture: "tick", hz: 360, duration: 0.12, variants: 1, bus: "ui", peakDb: -12 },
  { id: "hover.tick", name: "Focus tick", group: "Interface", trigger: "Selected focus changes, used sparingly.", character: "A quiet, dry touch, without a ringing tail.", family: "signal", gesture: "tick", hz: 980, duration: 0.045, variants: 1, bus: "ui", peakDb: -23 },
  { id: "ui.reject", name: "Action unavailable", group: "Interface", trigger: "An action is blocked or unaffordable.", character: "Two short descending tones; clear without sounding like an alarm.", family: "signal", gesture: "reject", hz: 350, duration: 0.28, variants: 2, bus: "ui", peakDb: -12 },
  { id: "notify.info", name: "Information", group: "Interface", trigger: "An ordinary informational notification.", character: "A soft ascending instrument cue.", family: "signal", gesture: "confirm", hz: 620, duration: 0.35, variants: 1, bus: "ui", peakDb: -14 },
  { id: "notify.warn", name: "Attention", group: "Interface", trigger: "A warning notification, separate from continuous alarms.", character: "A rounded double pulse in a lower register.", family: "signal", gesture: "reject", hz: 540, duration: 0.42, variants: 1, bus: "ui", peakDb: -11 },
  { id: "craft.complete", name: "Assembly complete", group: "Interface", trigger: "An item finishes crafting.", character: "A latch settles, then a compact positive acknowledgement.", family: "signal", gesture: "confirm", hz: 520, duration: 0.5, variants: 1, bus: "ui", peakDb: -11, defaults: { texture: 0.6 } },
  { id: "research.complete", name: "Discovery", group: "Interface", trigger: "A research node completes.", character: "A restrained three-note resolution with more space than a crafting cue.", family: "signal", gesture: "confirm", hz: 660, duration: 1.3, variants: 1, bus: "ui", peakDb: -10, defaults: { texture: 0.12, detail: 0.6 } },
  { id: "mining.target.acquire", name: "Scanner acquisition", group: "Mining", trigger: "Quiet progress ticks after a target has stayed in focus; pitch rises toward lock.", character: "Soft, dry instrument ticks, below the completed-lock cue.", family: "signal", gesture: "tick", hz: 480, duration: 0.075, variants: 1, bus: "ui", peakDb: -22, defaults: { texture: 0.08, detail: 0.12 } },
  { id: "mining.target.lost", name: "Scanner lock lost", group: "Mining", trigger: "Looking away from a fully locked asteroid, excluding successful extraction, pause and death.", character: "A restrained downward instrument acknowledgement.", family: "signal", gesture: "reject", hz: 390, duration: 0.18, variants: 1, bus: "ui", peakDb: -18, defaults: { texture: 0.1, detail: 0.2 } },
  { id: "mining.target.lock", name: "Target acquired", group: "Interface", trigger: "A target lock is confirmed.", character: "A focused upward acknowledgement from the targeting instrument.", family: "signal", gesture: "confirm", hz: 880, duration: 0.24, variants: 3, bus: "ui", peakDb: -13 },
  { id: "module.equip", name: "Module seated", group: "Interface", trigger: "A ship module is installed.", character: "A dry contact and a low, positive latch tone.", family: "signal", gesture: "confirm", hz: 290, duration: 0.32, variants: 2, bus: "ui", peakDb: -12, defaults: { texture: 0.7 } },
  { id: "comms.chirp.arrive", name: "AI / attention", group: "Interface", trigger: "A ship-AI message appears; no voice required.", character: "A gentle two-note electronic identity for the ship AI.", family: "signal", gesture: "confirm", hz: 830, duration: 0.4, variants: 1, bus: "ui", peakDb: -13 },
  { id: "comms.chirp.advance", name: "AI / continue", group: "Interface", trigger: "Advance a page of the ship-AI message.", character: "A small syllable of the same electronic identity.", family: "signal", gesture: "tick", hz: 830, duration: 0.1, variants: 1, bus: "ui", peakDb: -17 },
  { id: "comms.chirp.dismiss", name: "AI / dismiss", group: "Interface", trigger: "Dismiss a ship-AI message.", character: "A short downward acknowledgement.", family: "signal", gesture: "reject", hz: 620, duration: 0.18, variants: 1, bus: "ui", peakDb: -17 },
  { id: "world.impact.small", name: "Hull / small impact", group: "Hull", trigger: "A small object physically strikes the hull.", character: "Noise excitation into damped, inharmonic plate resonances. Experimental; compare against recordings.", family: "impact", gesture: "hit", hz: 160, duration: 0.65, variants: 3, bus: "sfxWorld", peakDb: -7, experimental: true },
  { id: "world.impact.large", name: "Hull / heavy impact", group: "Hull", trigger: "A larger collision makes direct contact with the ship.", character: "A slower low body, multiple plate modes and a brief debris texture.", family: "impact", gesture: "hit", hz: 65, duration: 1.5, variants: 3, bus: "sfxWorld", peakDb: -5, experimental: true },
  { id: "ship.damage.impact", name: "Damaged plating", group: "Hull", trigger: "A damaging hit reaches the ship structure.", character: "Blunt contact, buckling panel noise and loose fasteners; short damped resonances.", family: "impact", gesture: "hit", hz: 105, duration: 0.9, variants: 3, bus: "sfxShip", peakDb: -6, experimental: true, defaults: { brightness: 0.45, detail: 0.4, texture: 1 } },
  { id: "ship.hull.stress", name: "Hull tension", group: "Hull", trigger: "Structural stress; an occasional cue, not a continuous alarm.", character: "Stick-slip friction excites a few bending resonances. Experimental, deliberately sparse.", family: "creak", gesture: "hit", hz: 130, duration: 1.8, variants: 2, bus: "sfxShip", peakDb: -12, experimental: true },

  // ── Aerodynamic wind (AUDIO_PLAN §12.3, the q = ½ρv² bed) ──────────────
  // ⚠ THREE LAYERS BECAUSE A SHIP-TIER VOICE CANNOT BE FILTERED AT RUNTIME.
  // `setVoicePropagation` hard-returns unless the voice is air-coupled, and
  // `connectVoice` leaves the lowpass disconnected for ship/ui, so brightness
  // has to be pre-rendered and crossfaded — the same reason the engine has
  // three layers. Equal `duration` + `syncLoop` in the catalogue keeps them
  // phase-aligned; unequal lengths would comb-filter against each other.
  // ⚠ Brightness is the ONLY axis that moves across the three. Same family,
  // same hz, same seed, same gusts: they must read as one airflow getting
  // harder, not as three different winds.
  // ⚠ peakDb 7 dB below the engine layers, not at parity with them. The bed
  // plays OVER the engines rather than instead of them, and the crossfade sums
  // two layers at once; at the first build's -7..-9 it buried everything.
  // ⚠ duration 11, not 6. The loop's own period was audible ("a repeating
  // pattern every few seconds"). 11 s is the practical ceiling: durationRange
  // caps loops at 12, and each second costs 144 kB of 24-bit WAV per layer.
  { id: "ship.wind.low", name: "Airflow / thin", group: "Flight", trigger: "Low dynamic pressure: thin air, or slow flight in thick air.", character: "A distant, rounded pressure wash with slow gusting. Almost no top end — this is the layer that survives at altitude.", family: "wind", gesture: "steady", hz: 62, duration: 11, loop: true, variants: 1, bus: "sfxShip", peakDb: -19, defaults: { body: 0.9, brightness: 0.16, texture: 0.7, detail: 0.14, motion: 0.4 } },
  { id: "ship.wind.mid", name: "Airflow / building", group: "Flight", trigger: "Moderate dynamic pressure; blended with the other two.", character: "The same airflow with the hull starting to answer: more edge on the gusts, a harder rush between them.", family: "wind", gesture: "steady", hz: 62, duration: 11, loop: true, variants: 1, bus: "sfxShip", peakDb: -18, defaults: { body: 0.76, brightness: 0.4, texture: 0.82, detail: 0.3, motion: 0.48 } },
  { id: "ship.wind.high", name: "Airflow / max-q", group: "Flight", trigger: "High dynamic pressure: fast and low, or entry into a thick atmosphere.", character: "Full buffeting roar with the top end open. Heard through the hull, so it is pressure and rush rather than whistle.", family: "wind", gesture: "steady", hz: 62, duration: 11, loop: true, variants: 1, bus: "sfxShip", peakDb: -17, defaults: { body: 0.76, brightness: 0.6, texture: 0.9, detail: 0.42, motion: 0.56 } },

  // ── Gate EA-1 gaps (2026-11-13) — physically modelled ship hardware ─────
  // `mechanism` presets are modal contacts + gas blowdown, heard through the
  // structure (src/audio/workshop/mechanisms.ts), not noise bursts.
  { id: "mining.heatsink.vent", name: "Heat sink dump", group: "Mining", trigger: "A Heat Sink Cartridge is used.", character: "Solenoid valve seats, the coolant charge blows down through the lines and the empty pipe knocks once.", family: "mechanism", gesture: "vent", hz: 190, duration: 1.2, variants: 2, bus: "sfxShip", peakDb: -10, defaults: { body: 0.8, brightness: 0.45, texture: 0.85, detail: 0.5, motion: 0.3 } },
  { id: "mining.purge.vent", name: "Thermal purge", group: "Mining", trigger: "A Thermal Purge Charge is used.", character: "A bigger, longer blowdown than the heat sink: the whole coolant loop is dumped.", family: "mechanism", gesture: "purge", hz: 190, duration: 2, variants: 1, bus: "sfxShip", peakDb: -8, defaults: { body: 0.9, brightness: 0.4, texture: 0.9, detail: 0.45, motion: 0.3 } },
  { id: "mining.laser.ready", name: "Cutter re-armed", group: "Mining", trigger: "The cutter has cooled down after an overheat and can fire again.", character: "A contactor closes with two small bounces and the power stage's magnetising hum swells and settles.", family: "mechanism", gesture: "relay", hz: 1150, duration: 0.35, variants: 1, bus: "sfxShip", peakDb: -14, defaults: { body: 0.6, brightness: 0.55, texture: 0.6, detail: 0.8, motion: 0.2 } },
  { id: "module.unequip", name: "Module released", group: "Interface", trigger: "A ship module is removed from its slot.", character: "The latch pawl lets go, the module slides out along its rails and stops against the cradle.", family: "mechanism", gesture: "unlatch", hz: 1700, duration: 0.5, variants: 2, bus: "ui", peakDb: -13, defaults: { body: 0.7, brightness: 0.5, texture: 0.7, detail: 0.7, motion: 0.3 } },
  { id: "cargo.jettison", name: "Cargo jettison", group: "Mining", trigger: "Resources are jettisoned from the hold.", character: "Hold door actuator, clamp release, a short ejector charge, the container dragging out of its rails. Then vacuum.", family: "mechanism", gesture: "jettison", hz: 85, duration: 1.5, variants: 2, bus: "sfxShip", peakDb: -8, defaults: { body: 0.9, brightness: 0.45, texture: 0.75, detail: 0.6, motion: 0.3 } },
  { id: "ship.hull.repair", name: "Hull patch", group: "Hull", trigger: "A hull repair consumable is used.", character: "Applicator seats, sealant injects, three clamp strikes set the patch and the panel settles.", family: "mechanism", gesture: "repair", hz: 420, duration: 1.7, variants: 2, bus: "sfxShip", peakDb: -10, defaults: { body: 0.75, brightness: 0.5, texture: 0.6, detail: 0.75, motion: 0.3 } },
  { id: "ship.respawn", name: "Systems restart", group: "Hull", trigger: "The ship comes back online after a respawn.", character: "Main bus contactor, magnetising inrush settling to hum, avionics contactor and relays, cooling fans spinning up.", family: "mechanism", gesture: "boot", hz: 70, duration: 3, variants: 1, bus: "sfxShip", peakDb: -8, defaults: { body: 0.9, brightness: 0.45, texture: 0.75, detail: 0.5, motion: 0.3 } },
  { id: "transit.abort", name: "Drive spool aborted", group: "Flight", trigger: "The transit spool is released before it engages.", character: "The half-charged field collapses quickly back to rest.", family: "drive", gesture: "fall", hz: 82, duration: 0.8, variants: 1, bus: "sfxShip", peakDb: -10 },
  { id: "wreck.tractor.loop", name: "Salvage tractor", group: "Mining", trigger: "While the salvage tractor beam holds a wreck.", character: "The tractor's field coils hum through the hull: magnetostriction at twice line frequency, steady and low.", family: "drive", gesture: "steady", hz: 100, duration: 6, loop: true, variants: 1, bus: "sfxShip", peakDb: -18, defaults: { body: 0.9, brightness: 0.25, texture: 0.35, detail: 0.2, motion: 0.3 } },

  // ── Death ──────────────────────────────────────────────────────────────
  // ⚠ peakDb -5, not louder, even though this is the biggest moment in the game.
  // The workshop asserts >=5 dB of sample headroom on EVERY asset so the bus
  // graph and master limiter have room to work; -3 is rejected outright. If a
  // death should feel louder than a hull impact, that belongs in the event's
  // mix gain, not in the file's peak — the same authored-level argument as
  // AUDIO_PLAN §12.1.
  // The last two rows of docs/AUDIO_ASSETS.md that had no asset. Both are
  // one-per-session moments, so they are allowed to be longer and larger than
  // anything else in the palette.
  { id: "ship.destroyed", name: "Hull failure", group: "Hull", trigger: "The ship is destroyed.", character: "Structural rupture: a deep tearing body, plate modes collapsing inharmonically, then debris falling away into nothing.", family: "impact", gesture: "hit", hz: 44, duration: 2.6, variants: 1, bus: "sfxShip", peakDb: -5, experimental: true, defaults: { body: 1, brightness: 0.52, texture: 0.9, detail: 0.65, motion: 0.5 } },
  // ⚠ `ambience` bus, and quiet. This plays under the death screen while the
  // player reads it, so it must not compete with the UI or wear out across the
  // dozens of deaths a survival game produces.
  { id: "death.bed", name: "Aftermath", group: "Hull", trigger: "Held under the death screen.", character: "Cold, sparse, and almost still: a distant low field with slow phase drift and no pulse. Deliberately close to silence.", family: "drive", gesture: "steady", hz: 38, duration: 8, loop: true, variants: 1, bus: "ambience", peakDb: -20, defaults: { body: 0.9, brightness: 0.12, texture: 0.25, detail: 0.15, motion: 0.2 } },
];

export function getPreset(id: string): SoundPreset {
  const preset = SOUND_PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`Unknown sound preset: ${id}`);
  return preset;
}

export function createRecipe(id: string): Recipe {
  const preset = getPreset(id);
  return { version: 1, presetId: id, seed: 24017, duration: preset.duration, pitch: 0,
    brightness: 0.45, motion: 0.35, body: 0.8, texture: 0.55, detail: 0.4, ...preset.defaults };
}

export function durationRange(preset: SoundPreset): readonly [number, number] {
  return preset.loop ? [2, 12] : [Math.max(0.03, preset.duration * 0.5), Math.min(6, preset.duration * 2)];
}

/** JSON import and worker messages are untrusted; reject rather than allocate from them. */
export function parseRecipe(value: unknown): Recipe {
  if (!value || typeof value !== "object") throw new Error("Expected a sound recipe object.");
  const obj = value as Record<string, unknown>;
  if (obj.version !== 1 || typeof obj.presetId !== "string") throw new Error("Unsupported sound recipe version or preset.");
  const preset = getPreset(obj.presetId);
  const limits: Record<string, readonly [number, number]> = {
    seed: [0, 4294967295], duration: durationRange(preset), pitch: [-12, 12],
    brightness: [0, 1], motion: [0, 1], body: [0, 1], texture: [0, 1], detail: [0, 1],
  };
  const result = createRecipe(preset.id);
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    const v = obj[key];
    const [min, max] = limits[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new Error(`Invalid ${key}: expected ${min}–${max}.`);
    if (key === "seed" && !Number.isInteger(v)) throw new Error("Seed must be a whole number.");
    (result as unknown as Record<string, unknown>)[key] = v;
  }
  return result;
}
