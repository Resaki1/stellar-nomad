// ---------------------------------------------------------------------------
// AUDIO EVENT CATALOGUE — see docs/AUDIO_PLAN.md §5.6
//
// Game code fires a semantic EVENT ID, never a filename (invariant A10). That
// indirection is what makes variants, per-event caps, re-mapping and the
// contract tests in §10.1 possible at all.
//
// ⚠ SELF-CONTAINED ON PURPOSE. Types are declared here rather than imported,
// exactly like `content.ts`, so `scripts/check-audio-manifest.mjs` can
// transpile this single file with `tsc` and import it without resolving the
// `@/` path alias or a bundler. Do not add imports to this file.
// ---------------------------------------------------------------------------

/** Mixer buses. §5.2. NOTE: there is deliberately no `voice` bus — see §5.2. */
export type BusId = "music" | "ambience" | "sfxShip" | "sfxWorld" | "ui";

/**
 * Routing tier (A2). `ship` and `ui` are NOT panned or distance-attenuated in
 * the current chase camera — diegetically you are aboard the ship wherever the
 * camera floats, so the engine must not get quieter as the camera pulls back.
 * Only `world` is spatialised.
 */
export type EmitterTier = "ship" | "world" | "ui";

/** 0 = blocking at boot, 1 = during load, 2 = lazy. §6.8 / A7. */
export type PreloadTier = 0 | 1 | 2;

type AudioEventShape = {
  readonly id: string;
  readonly bus: BusId;
  readonly tier: EmitterTier;
  /** Round-robin pool, public paths. One entry is legal; 3+ for frequent sounds (§6.4). */
  readonly variants: readonly string[];
  /** Higher wins when stealing. §5.3's ladder: ui > ship > world one-shot > ambient loop. */
  readonly priority: number;
  /** Hard cap on concurrent instances OF THIS EVENT. Prevents T3's triple-collision stack. */
  readonly maxInstances: number;
  /** Minimum gap between triggers, ms. 0 = no cooldown. */
  readonly cooldownMs: number;
  readonly loop?: boolean;
  /** Phase-align equal-length engine layers to the audio clock, including after culling. */
  readonly syncLoop?: boolean;
  /** Static trim in dB applied on top of the bus gain. */
  readonly gainDb?: number;
  /** ±cents of random detune per play. 20–50 reads organic; more reads broken. */
  readonly pitchJitterCents?: number;
  /** ±dB of random level per play. */
  readonly gainJitterDb?: number;
  readonly preloadTier: PreloadTier;
  /**
   * Position in SHIP-LOCAL metres, for `ship`-tier events only. Unset (the
   * default) = today's flat, unpanned chase-mode behaviour.
   *
   * 🔑 DECLARED BUT UNUSED. Filling it in is pure content tuning the day a
   * cockpit view, WebXR mode, or on-foot-inside-ship mode exists (A2) — it is
   * here now so that is not a schema migration touching every entry.
   */
  readonly localOffsetM?: readonly [number, number, number];
  /**
   * Multiplayer (A13). `predicted` fires locally at once and must be fadeable
   * if the server disagrees; `confirmed` waits. Unset = `predicted`.
   * Classifying at authoring time is far cheaper than auditing later.
   */
  readonly netClass?: "predicted" | "confirmed";
  /** Cluster key for the §5.3a aggregation that is NOT built. Unset = never clustered. */
  readonly clusterKey?: string;
  /**
   * HOW the sound reaches the listener. Only meaningful for `world` tier.
   *
   * 🔑 THIS IS THE CONCEPT THAT MAKES THE PHYSICS SAFE TO APPLY (§12.3c).
   *
   * - `air`     — travelled through the medium. Gets impedance coupling and
   *               frequency-dependent absorption, so it falls silent in vacuum.
   *               A distant explosion. Physically correct, and correctly silent.
   * - `contact` — reached you through direct mechanical contact with your own
   *               hull: you hit the rock, debris
   *               struck the plating. Structure-borne, so the surrounding gas is
   *               IRRELEVANT and no atmospheric attenuation applies. Still
   *               panned, because the hull conducts differently from the side
   *               that was struck.
   *
   * ⚠ Defaults to `contact` for anything unset, deliberately. The failure mode
   * of getting this wrong is silencing the core gameplay loop in vacuum — the
   * documented reason Frontier abandoned realistic thin-atmosphere audio for
   * Elite Dangerous (§12.4). Opting IN to attenuation is the safe default.
   */
  readonly coupling?: "air" | "contact";
};

// ---------------------------------------------------------------------------
// The catalogue
//
// Original procedural workshop pack. Levels are authored in the sources; do
// not loudness-normalize each layer independently. See AUDIO_PLAN §6.9.
// Legacy world.impact / ship.engine.loop ids remain for console compatibility.
// ---------------------------------------------------------------------------

export const AUDIO_EVENTS = [
  {
    id: "mining.laser.loop",
    bus: "sfxShip",
    tier: "ship",
    variants: [
      "/audio/workshop/mining_laser_loop_s24017.wav"
    ],
    priority: 50,
    maxInstances: 1,
    cooldownMs: 0,
    preloadTier: 1,
    gainDb: -2,
    loop: true
  },
  {
    id: "mining.laser.start",
    bus: "sfxShip",
    tier: "ship",
    variants: [
      "/audio/workshop/mining_laser_start_s24017.opus",
      "/audio/workshop/mining_laser_start_s24018.opus"
    ],
    priority: 50,
    maxInstances: 3,
    cooldownMs: 120,
    preloadTier: 1,
    gainDb: 0,
    pitchJitterCents: 0,
    gainJitterDb: 0
  },
  {
    id: "mining.laser.stop",
    bus: "sfxShip",
    tier: "ship",
    variants: [
      "/audio/workshop/mining_laser_stop_s24017.opus",
      "/audio/workshop/mining_laser_stop_s24018.opus"
    ],
    priority: 50,
    maxInstances: 3,
    cooldownMs: 120,
    preloadTier: 1,
    gainDb: 0,
    pitchJitterCents: 0,
    gainJitterDb: 0
  },
  {
    id: "mining.complete",
    bus: "sfxShip",
    tier: "ship",
    variants: [
      "/audio/workshop/mining_complete_s24017.opus",
      "/audio/workshop/mining_complete_s24018.opus"
    ],
    priority: 50,
    maxInstances: 3,
    cooldownMs: 120,
    preloadTier: 1,
    gainDb: 0,
    pitchJitterCents: 25,
    gainJitterDb: 0.5
  },
  {
    id: "loot.acquire",
    bus: "ui",
    tier: "ui",
    variants: [
      "/audio/workshop/loot_acquire_s24017.opus",
      "/audio/workshop/loot_acquire_s24018.opus",
      "/audio/workshop/loot_acquire_s24019.opus"
    ],
    priority: 85,
    maxInstances: 3,
    cooldownMs: 120,
    preloadTier: 0,
    gainDb: 0,
    pitchJitterCents: 25,
    gainJitterDb: 0.5
  },
  {
    id: "ship.engine.idle",
    bus: "sfxShip",
    tier: "ship",
    variants: [
      "/audio/workshop/ship_engine_idle_s24017.wav"
    ],
    priority: 50,
    maxInstances: 1,
    cooldownMs: 0,
    preloadTier: 1,
    gainDb: -3,
    loop: true,
    syncLoop: true
  },
  {
    id: "ship.engine.mid",
    bus: "sfxShip",
    tier: "ship",
    variants: [
      "/audio/workshop/ship_engine_mid_s24017.wav"
    ],
    priority: 50,
    maxInstances: 1,
    cooldownMs: 0,
    preloadTier: 1,
    gainDb: -3,
    loop: true,
    syncLoop: true
  },
  {
    id: "ship.engine.high",
    bus: "sfxShip",
    tier: "ship",
    variants: [
      "/audio/workshop/ship_engine_high_s24017.wav"
    ],
    priority: 50,
    maxInstances: 1,
    cooldownMs: 0,
    preloadTier: 1,
    gainDb: -3,
    loop: true,
    syncLoop: true
  },
  {
    id: "transit.spool",
    bus: "sfxShip",
    tier: "ship",
    variants: [
      "/audio/workshop/transit_spool_s24017.opus"
    ],
    priority: 50,
    maxInstances: 3,
    cooldownMs: 120,
    preloadTier: 1,
    gainDb: 0
  },
  {
    id: "transit.engage",
    bus: "sfxShip",
    tier: "ship",
    variants: [
      "/audio/workshop/transit_engage_s24017.opus"
    ],
    priority: 50,
    maxInstances: 3,
    cooldownMs: 120,
    preloadTier: 1,
    gainDb: 0
  },
  {
    id: "transit.loop",
    bus: "sfxShip",
    tier: "ship",
    variants: [
      "/audio/workshop/transit_loop_s24017.wav"
    ],
    priority: 50,
    maxInstances: 1,
    cooldownMs: 0,
    preloadTier: 1,
    gainDb: -2,
    loop: true
  },
  {
    id: "transit.decel",
    bus: "sfxShip",
    tier: "ship",
    variants: [
      "/audio/workshop/transit_decel_s24017.opus"
    ],
    priority: 50,
    maxInstances: 3,
    cooldownMs: 120,
    preloadTier: 1,
    gainDb: 0
  },
  {
    id: "transit.arrive",
    bus: "sfxShip",
    tier: "ship",
    variants: [
      "/audio/workshop/transit_arrive_s24017.opus"
    ],
    priority: 50,
    maxInstances: 3,
    cooldownMs: 120,
    preloadTier: 1,
    gainDb: 0
  },
  {
    id: "click.soft",
    bus: "ui",
    tier: "ui",
    variants: [
      "/audio/workshop/click_soft_s24017.opus"
    ],
    priority: 85,
    maxInstances: 3,
    cooldownMs: 40,
    preloadTier: 0,
    gainDb: 0
  },
  {
    id: "click.hard",
    bus: "ui",
    tier: "ui",
    variants: [
      "/audio/workshop/click_hard_s24017.opus"
    ],
    priority: 85,
    maxInstances: 3,
    cooldownMs: 40,
    preloadTier: 0,
    gainDb: 0
  },
  {
    id: "hover.tick",
    bus: "ui",
    tier: "ui",
    variants: [
      "/audio/workshop/hover_tick_s24017.opus"
    ],
    priority: 85,
    maxInstances: 3,
    cooldownMs: 120,
    preloadTier: 0,
    gainDb: -3
  },
  {
    id: "ui.reject",
    bus: "ui",
    tier: "ui",
    variants: [
      "/audio/workshop/ui_reject_s24017.opus",
      "/audio/workshop/ui_reject_s24018.opus"
    ],
    priority: 85,
    maxInstances: 3,
    cooldownMs: 120,
    preloadTier: 0,
    gainDb: 0,
    pitchJitterCents: 25,
    gainJitterDb: 0.5
  },
  {
    id: "notify.info",
    bus: "ui",
    tier: "ui",
    variants: [
      "/audio/workshop/notify_info_s24017.opus"
    ],
    priority: 85,
    maxInstances: 3,
    cooldownMs: 120,
    preloadTier: 0,
    gainDb: 0
  },
  {
    id: "notify.warn",
    bus: "ui",
    tier: "ui",
    variants: [
      "/audio/workshop/notify_warn_s24017.opus"
    ],
    priority: 95,
    maxInstances: 3,
    cooldownMs: 120,
    preloadTier: 0,
    gainDb: 0
  },
  {
    id: "craft.complete",
    bus: "ui",
    tier: "ui",
    variants: [
      "/audio/workshop/craft_complete_s24017.opus"
    ],
    priority: 85,
    maxInstances: 3,
    cooldownMs: 120,
    preloadTier: 0,
    gainDb: 0
  },
  {
    id: "research.complete",
    bus: "ui",
    tier: "ui",
    variants: [
      "/audio/workshop/research_complete_s24017.opus"
    ],
    priority: 85,
    maxInstances: 3,
    cooldownMs: 120,
    preloadTier: 0,
    gainDb: 0
  },
  {
    id: "mining.target.acquire", bus: "ui", tier: "ui",
    variants: ["/audio/workshop/mining_target_acquire_s24017.opus"],
    priority: 45, maxInstances: 1, cooldownMs: 160, preloadTier: 0, gainDb: 0
  },
  {
    id: "mining.target.lost", bus: "ui", tier: "ui",
    variants: ["/audio/workshop/mining_target_lost_s24017.opus"],
    priority: 65, maxInstances: 1, cooldownMs: 350, preloadTier: 0, gainDb: 0
  },
  // Close inspection (B11). Placeholders from `pnpm gen:audio-placeholders inspect` until real assets exist.
  {
    id: "mining.inspect.start", bus: "ui", tier: "ui",
    variants: ["/audio/sfx2d/mining_inspect_start.opus"],
    priority: 80, maxInstances: 1, cooldownMs: 150, preloadTier: 1, gainDb: -6
  },
  {
    id: "mining.inspect.loop", bus: "ui", tier: "ui", loop: true,
    variants: ["/audio/sfx2d/mining_inspect_loop.opus"],
    priority: 40, maxInstances: 1, cooldownMs: 0, preloadTier: 1, gainDb: -14
  },
  {
    id: "mining.inspect.complete", bus: "ui", tier: "ui",
    variants: ["/audio/sfx2d/mining_inspect_complete.opus"],
    priority: 85, maxInstances: 1, cooldownMs: 150, preloadTier: 1, gainDb: -6
  },
  {
    id: "mining.target.lock",
    bus: "ui",
    tier: "ui",
    variants: [
      "/audio/workshop/mining_target_lock_s24017.opus",
      "/audio/workshop/mining_target_lock_s24018.opus",
      "/audio/workshop/mining_target_lock_s24019.opus"
    ],
    priority: 85,
    maxInstances: 3,
    cooldownMs: 120,
    preloadTier: 0,
    gainDb: 0,
    pitchJitterCents: 25,
    gainJitterDb: 0.5
  },
  {
    id: "module.equip",
    bus: "ui",
    tier: "ui",
    variants: [
      "/audio/workshop/module_equip_s24017.opus",
      "/audio/workshop/module_equip_s24018.opus"
    ],
    priority: 85,
    maxInstances: 3,
    cooldownMs: 120,
    preloadTier: 0,
    gainDb: 0,
    pitchJitterCents: 25,
    gainJitterDb: 0.5
  },
  {
    id: "comms.chirp.arrive",
    bus: "ui",
    tier: "ui",
    variants: [
      "/audio/workshop/comms_chirp_arrive_s24017.opus"
    ],
    priority: 85,
    maxInstances: 3,
    cooldownMs: 120,
    preloadTier: 0,
    gainDb: 0
  },
  {
    id: "comms.chirp.advance",
    bus: "ui",
    tier: "ui",
    variants: [
      "/audio/workshop/comms_chirp_advance_s24017.opus"
    ],
    priority: 85,
    maxInstances: 3,
    cooldownMs: 120,
    preloadTier: 0,
    gainDb: 0
  },
  {
    id: "comms.chirp.dismiss",
    bus: "ui",
    tier: "ui",
    variants: [
      "/audio/workshop/comms_chirp_dismiss_s24017.opus"
    ],
    priority: 85,
    maxInstances: 3,
    cooldownMs: 120,
    preloadTier: 0,
    gainDb: 0
  },
  {
    id: "world.impact.small",
    bus: "sfxWorld",
    tier: "world",
    variants: [
      "/audio/workshop/world_impact_small_s24017.opus",
      "/audio/workshop/world_impact_small_s24018.opus",
      "/audio/workshop/world_impact_small_s24019.opus"
    ],
    priority: 70,
    maxInstances: 3,
    cooldownMs: 120,
    preloadTier: 1,
    gainDb: 0,
    pitchJitterCents: 25,
    gainJitterDb: 0.5,
    coupling: "contact"
  },
  {
    id: "world.impact.large",
    bus: "sfxWorld",
    tier: "world",
    variants: [
      "/audio/workshop/world_impact_large_s24017.opus",
      "/audio/workshop/world_impact_large_s24018.opus",
      "/audio/workshop/world_impact_large_s24019.opus"
    ],
    priority: 70,
    maxInstances: 3,
    cooldownMs: 120,
    preloadTier: 1,
    gainDb: 0,
    pitchJitterCents: 25,
    gainJitterDb: 0.5,
    coupling: "contact"
  },
  {
    id: "ship.damage.impact",
    bus: "sfxShip",
    tier: "ship",
    variants: [
      "/audio/workshop/ship_damage_impact_s24017.opus",
      "/audio/workshop/ship_damage_impact_s24018.opus",
      "/audio/workshop/ship_damage_impact_s24019.opus"
    ],
    priority: 50,
    maxInstances: 3,
    cooldownMs: 120,
    preloadTier: 1,
    gainDb: 0,
    pitchJitterCents: 25,
    gainJitterDb: 0.5
  },
  {
    id: "ship.hull.stress",
    bus: "sfxShip",
    tier: "ship",
    variants: [
      "/audio/workshop/ship_hull_stress_s24017.opus",
      "/audio/workshop/ship_hull_stress_s24018.opus"
    ],
    priority: 50,
    maxInstances: 1,
    cooldownMs: 3000,
    preloadTier: 1,
    gainDb: -3,
    pitchJitterCents: 25,
    gainJitterDb: 0.5
  },
  {
    id: "world.impact",
    bus: "sfxWorld",
    tier: "world",
    variants: [
      "/audio/workshop/world_impact_small_s24017.opus",
      "/audio/workshop/world_impact_small_s24018.opus",
      "/audio/workshop/world_impact_small_s24019.opus"
    ],
    priority: 70,
    maxInstances: 3,
    cooldownMs: 120,
    preloadTier: 1,
    gainDb: 0,
    pitchJitterCents: 25,
    gainJitterDb: 0.5,
    coupling: "contact"
  },
  {
    id: "ship.engine.loop",
    bus: "sfxShip",
    tier: "ship",
    variants: [
      "/audio/workshop/ship_engine_idle_s24017.wav"
    ],
    priority: 50,
    maxInstances: 1,
    cooldownMs: 0,
    preloadTier: 1,
    gainDb: -3,
    loop: true,
    syncLoop: true
  },
  {
    id: "station.vent.loop",
    bus: "ambience",
    tier: "world",
    variants: [
      "/audio/sfx3d/station_vent_loop.opus"
    ],
    priority: 10,
    maxInstances: 8,
    cooldownMs: 0,
    loop: true,
    preloadTier: 2,
    gainDb: -10,
    clusterKey: "station.vent",
    coupling: "air"
  },
  // Aerodynamic wind, AUDIO_PLAN §12.3. Three brightness layers crossfaded by
  // dynamic pressure, exactly like the engine beds and for the same reason: a
  // ship-tier voice has no runtime filter, so brightness is pre-rendered.
  // ⚠ `syncLoop` is load-bearing here, not decoration. Without it the emitter
  // starts each loop at a random offset in [0,10) s, and three equal-length
  // beds at random relative phases comb-filter against each other.
  // ⚠ `gainDb: -3` is paired with WIND_RANGE_DB in src/audio/wind.ts — together
  // they put the bed's floor just under the emitter cull, which is what makes
  // vacuum exactly silent rather than quietly held. Change one, re-read both.
  {
    id: "ship.wind.low", bus: "sfxShip", tier: "ship",
    variants: ["/audio/workshop/ship_wind_low_s24017.wav"],
    priority: 50, maxInstances: 1, cooldownMs: 0, preloadTier: 1, gainDb: -3,
    loop: true, syncLoop: true
  },
  {
    id: "ship.wind.mid", bus: "sfxShip", tier: "ship",
    variants: ["/audio/workshop/ship_wind_mid_s24017.wav"],
    priority: 50, maxInstances: 1, cooldownMs: 0, preloadTier: 1, gainDb: -3,
    loop: true, syncLoop: true
  },
  {
    id: "ship.wind.high", bus: "sfxShip", tier: "ship",
    variants: ["/audio/workshop/ship_wind_high_s24017.wav"],
    priority: 50, maxInstances: 1, cooldownMs: 0, preloadTier: 1, gainDb: -3,
    loop: true, syncLoop: true
  },
  {
    // The one-shot at the moment of destruction. Highest priority in the
    // catalogue: nothing may steal it, because it only ever plays once per run.
    id: "ship.destroyed",
    bus: "sfxShip",
    tier: "ship",
    variants: ["/audio/workshop/ship_destroyed_s24017.opus"],
    priority: 100,
    maxInstances: 1,
    cooldownMs: 0,
    preloadTier: 1,
    gainDb: 0
  },
  {
    // Held under the death screen. `ambience` bus and a quiet asset (-20 dBFS):
    // the player is reading, and a survival game produces a lot of deaths, so
    // this must not become something they learn to dread hearing.
    id: "death.bed",
    bus: "ambience",
    tier: "ship",
    variants: ["/audio/workshop/death_bed_s24017.wav"],
    priority: 15,
    maxInstances: 1,
    cooldownMs: 0,
    loop: true,
    preloadTier: 2,
    gainDb: 0
  },
  // Gate EA-1 gaps (2026-11-13): physically modelled ship hardware, heard
  // through the structure. See src/audio/workshop/mechanisms.ts.
  {
    id: "mining.heatsink.vent",
    bus: "sfxShip",
    tier: "ship",
    variants: [
      "/audio/workshop/mining_heatsink_vent_s24017.opus",
      "/audio/workshop/mining_heatsink_vent_s24018.opus"
    ],
    priority: 60,
    maxInstances: 2,
    cooldownMs: 150,
    preloadTier: 1,
    gainDb: 0,
    pitchJitterCents: 40,
    gainJitterDb: 0.5
  },
  {
    id: "mining.purge.vent",
    bus: "sfxShip",
    tier: "ship",
    variants: [
      "/audio/workshop/mining_purge_vent_s24017.opus"
    ],
    priority: 60,
    maxInstances: 2,
    cooldownMs: 150,
    preloadTier: 1,
    gainDb: 0
  },
  {
    id: "mining.laser.ready",
    bus: "sfxShip",
    tier: "ship",
    variants: [
      "/audio/workshop/mining_laser_ready_s24017.opus"
    ],
    priority: 70,
    maxInstances: 1,
    cooldownMs: 150,
    preloadTier: 1,
    gainDb: 0,
    pitchJitterCents: 30
  },
  {
    id: "module.unequip",
    bus: "ui",
    tier: "ui",
    variants: [
      "/audio/workshop/module_unequip_s24017.opus",
      "/audio/workshop/module_unequip_s24018.opus"
    ],
    priority: 85,
    maxInstances: 3,
    cooldownMs: 120,
    preloadTier: 0,
    gainDb: 0,
    pitchJitterCents: 25,
    gainJitterDb: 0.5
  },
  {
    id: "cargo.jettison",
    bus: "sfxShip",
    tier: "ship",
    variants: [
      "/audio/workshop/cargo_jettison_s24017.opus",
      "/audio/workshop/cargo_jettison_s24018.opus"
    ],
    priority: 60,
    maxInstances: 2,
    cooldownMs: 150,
    preloadTier: 1,
    gainDb: 0,
    pitchJitterCents: 30
  },
  {
    id: "ship.hull.repair",
    bus: "sfxShip",
    tier: "ship",
    variants: [
      "/audio/workshop/ship_hull_repair_s24017.opus",
      "/audio/workshop/ship_hull_repair_s24018.opus"
    ],
    priority: 60,
    maxInstances: 2,
    cooldownMs: 150,
    preloadTier: 1,
    gainDb: 0,
    pitchJitterCents: 30
  },
  {
    id: "ship.respawn",
    bus: "sfxShip",
    tier: "ship",
    variants: [
      "/audio/workshop/ship_respawn_s24017.opus"
    ],
    priority: 90,
    maxInstances: 1,
    cooldownMs: 1000,
    preloadTier: 1,
    gainDb: 0
  },
  {
    id: "transit.abort",
    bus: "sfxShip",
    tier: "ship",
    variants: [
      "/audio/workshop/transit_abort_s24017.opus"
    ],
    priority: 60,
    maxInstances: 1,
    cooldownMs: 150,
    preloadTier: 1,
    gainDb: 0
  },
  {
    id: "wreck.tractor.loop",
    bus: "sfxShip",
    tier: "ship",
    variants: [
      "/audio/workshop/wreck_tractor_loop_s24017.wav"
    ],
    priority: 40,
    maxInstances: 1,
    cooldownMs: 0,
    preloadTier: 1,
    gainDb: -3,
    loop: true
  }
] as const satisfies readonly AudioEventShape[];

// ---------------------------------------------------------------------------
// Derived lookups — the `content.ts` shape (flat array + Map + getters),
// chosen over `commsMessages.ts`'s Record because audio events are addressed
// by id from many scattered call sites, like items are.
// ---------------------------------------------------------------------------

/** Literal union of every id. A typo is a compile error, not a silent miss. */
export type AudioEventId = (typeof AUDIO_EVENTS)[number]["id"];

/** Runtime-facing shape (the union member types are awkward to pass around). */
export type AudioEventDef = AudioEventShape & { readonly id: AudioEventId };

const BY_ID = new Map<string, AudioEventDef>(
  AUDIO_EVENTS.map((e) => [e.id, e as AudioEventDef]),
);

export function getAudioEvent(id: AudioEventId): AudioEventDef {
  const def = BY_ID.get(id);
  // Unreachable through the typed API; reachable from `__audio.play("typo")`.
  if (!def) throw new Error(`[audio] unknown event id: ${id}`);
  return def;
}

export function tryGetAudioEvent(id: string): AudioEventDef | undefined {
  return BY_ID.get(id);
}

export function audioEventsByPreloadTier(tier: PreloadTier): AudioEventDef[] {
  return (AUDIO_EVENTS as readonly AudioEventDef[]).filter(
    (e) => e.preloadTier === tier,
  );
}

export const ALL_AUDIO_EVENTS = AUDIO_EVENTS as readonly AudioEventDef[];

/** Every distinct file the catalogue references. Used by the loader and the contract test. */
export function allAudioFiles(): string[] {
  const out = new Set<string>();
  for (const e of AUDIO_EVENTS) for (const v of e.variants) out.add(v);
  // `Array.from`, not spread: tsconfig targets es5, where spreading a Set
  // needs --downlevelIteration.
  return Array.from(out);
}
