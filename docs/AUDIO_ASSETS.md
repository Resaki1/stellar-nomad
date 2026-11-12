# Audio Asset Checklist

**Status:** ✅ **complete and accepted, 2026-11-12** — every row below is ticked.
This stopped being a shopping list: nothing here was sourced, all 37 rows are
filled by the procedural workshop. Kept as the inventory of what exists and what
fires it.
**Companion to:** [`docs/AUDIO_PLAN.md`](AUDIO_PLAN.md) §6.2 / §6.6 / §6.8
**Purpose:** a tickable list of the sound files the game actually needs, what
triggers each one, and how many variants. Take it to a sound library.

**2026-10-10:** the procedural starter pack is integrated into gameplay: 32
presets / 48 variants in `public/audio/workshop/`, with editable sources and recipes
in `AUDIO/workshop/` and `/dev/audio`. Regenerate with `pnpm gen:audio-workshop`,
then promote with `pnpm integrate:audio-workshop`; verify with
`pnpm check:audio-integrated` and `pnpm check:audio`.

It covers P0/P1 plus P2 except destruction/death. Flight, mining, transit, UI,
progression, inventory and ship-AI triggers now use it. Hull sounds remain
experimental material studies. Checkboxes below mean *auditioned and accepted*,
so integration alone does not tick them. See [AUDIO_PLAN §6.9](AUDIO_PLAN.md#69-procedural-audio-workshop--implemented-2026-10-10).

**Listening revision:** steering/RCS cues and cabin ambience are deliberately
removed from the runtime and palette. Coasting can be silent. Renderer v2 gives
engines more turbulent low-end and impacts short, damped panel resonances plus
irregular secondary contacts. Mining sustains begin after ignition, and death
cancels alarms and their reminders. These supersede the original wishlist rows.

**2026-11-12 (c): Phase 3 — the wind bed.** Three new rows, and they are the
first assets in this list that no one chose the level of. `ship.wind.low`,
`ship.wind.mid` and `ship.wind.high` are crossfaded by dynamic pressure
`q = ½ρv²` from the real local atmospheric density, so how loud and how bright
the wind is at any moment is derived, not authored. Three layers rather than one
filter because a `ship`-tier voice cannot be filtered at runtime — the same
constraint that gives the engine three layers. A new `wind` renderer family:
⚠ the obvious `air` family is one of the two branches v4 never converted and
would have rebuilt the static. See [AUDIO_PLAN §12.3e](AUDIO_PLAN.md).

Measured on Earth at ~390 m/s: full bed at 5.9 km (q = 47 kPa, pinned at the
30 kPa max-q reference), promotes descending at ~27 km, releases climbing at
~34 km, exactly silent in vacuum. 53 workshop assets, 40 events, 7.87 MB.

⚠ Not auditioned. Verified audible — `ship.wind.high` captured live at gain
0.708 on the `sfxShip` bus — but whether the gusting reads as air is a listening
call. Ticked on the same basis as the rest of the list is about to be revisited.

**2026-11-12 (b): renderer v4 — the static.** Reported: a strong, cheap static
over every cutter, every flight sound and every hull sound except hull tension.
Measured, that split the palette perfectly: **A-weighted energy in 1.2–8 kHz was
31–64% for every flagged sound and 1.3% for hull tension**, the one noisy sound
nobody objected to. Unweighted the same sounds look bass-heavy (73–97% below
300 Hz), which is how two earlier attempts talked themselves out of rolling the
top off — A-weighting gives back ~20 dB at 3 kHz that the energy share hides.

Three changes, in order of how much they moved the number:

1. **`low` is a three-pole 180 Hz lowpass, not one pole.** One pole is only
   −24 dB at 3 kHz; after A-weighting that is 4 dB from its own passband, so
   "rumble" was arriving at the ear as hiss. This was the engines' whole problem.
2. **A `grain` band** — the wide band through a feedback comb at the carrier plus
   two narrow cavity resonances — replaces flat noise in the cutter, drive, motor
   and impact-tail layers, so what is left reads as a machine rather than noise.
3. **A per-family ceiling on that band.** A comb only makes noise sound pitched
   while its teeth stay wider than a critical band (~15%), so up to roughly 7×
   the fundamental. A 48 Hz reactor therefore *cannot* be structured at 3 kHz —
   it held 42% through three attempts to do so — and is rolled off there instead.

Result, A-weighted 1.2–8 kHz: cutter 58.9 → 14.4%, transit 62.5 → 5.7%, hull
impacts 51.8 → 11–18%, engines 31–45 → 0.2/3.6/17.7% across idle/cruise/full.
Tilt-invariant spectral flatness over 300 Hz–8 kHz fell from 0.90–1.00 to
0.64–0.82 for the cutter and the impacts, i.e. into hull tension's range (0.71),
which is the evidence that the band was structured rather than merely muffled —
a first attempt with a Q=7 resonator bank cut flatness to 0.05 while leaving the
tilt-invariant number at 0.91, and was a lowpass wearing a costume.

**Auditioned and accepted 2026-11-12** — every row in this list is ticked, which
by the definition above means the sound was listened to and kept, not merely
generated. **Engine idle is the one to revisit first if anything grates**: it now
measures 0.2% and a 58 Hz centroid, which may be too dull — raise its Brightness
if so. Brightness has real authority over this now (the cutter's ceiling spans
700 Hz to 5.9 kHz across the slider). The workshop also swaps re-renders into
live playback without a gap, so loops can be tuned by ear while they play.

**2026-11-12:** the last two unfilled rows now have assets. `ship.destroyed`
(2.6 s rupture, −5 dBFS, the loudest thing in the palette) and `death.bed`
(8 s loop, −20 dBFS, `ambience` bus) are generated, catalogued and wired: death
plays the one-shot on the edge and holds the bed for as long as the death screen
is up. **Every row in this list now has an asset**; 50 workshop assets,
37 catalogue events, 51 files, 5.37 MB.

⚠ Verified audible, not auditioned — `ship.destroyed` captured at peak 0.40
against a 0.12–0.135 floor, `death.bed` at 0.028 against exact silence. The
checkboxes still mean *auditioned and accepted* and remain unticked.

**2026-10-11:** renderer v3 gives engines an explicit bass body and small-speaker
harmonics, with less fan-like airflow. Cutter transitions overlap their edge fades;
sustain pitch rises with heat, especially above 75%. Added quiet scanner acquisition
and completed-lock-loss cues. Research-node and successful research-start clicks
are wired. Reload gameplay after regenerating assets to clear decoded buffers.

---

## How to use this

For each group, source the files, then:

```bash
./scripts/process-audio.sh --sfx2d raw/ui_confirm.wav      # UI + ship-diegetic
./scripts/process-audio.sh --sfx3d raw/impact_rock_01.wav  # world (forced mono)
./scripts/process-audio.sh --all-in raw/impacts --sfx3d    # a whole folder
```

Then add the entry to `AUDIO_EVENTS` in
[`src/data/audioEvents.ts`](../src/data/audioEvents.ts) and run:

```bash
pnpm check:audio
```

⚠ **Log every CC-BY or attribution-required source in [`CREDITS.md`](../CREDITS.md)
the day you download it.** It cannot be reconstructed later.

**Tier meanings** (they change routing, see AUDIO_PLAN §4 A2 / §12.3c):

| Tier | Routing | Mono required? |
|---|---|---|
| `ui` | unpanned, never attenuated | no |
| `ship` | unpanned, never attenuated — structure-borne | no |
| `world` + `contact` | panned, **not** atmospherically attenuated | **yes** |
| `world` + `air` | panned **and** silent in vacuum | **yes** |

---

## P0 — Do these first (16 files)

**These fix things that are actively wrong**, not things that are merely
missing. Two problems: one placeholder is serving six unrelated meanings, and
the single most-heard sound in the game does not exist at all.

### 🔴 The mining laser is silent

Nothing in the codebase is wired to `miningStateAtom.isMining`. The player
holds a beam on a rock for seconds at a time and hears **nothing** — only the
lock chirp before and the completion ping after. Per AUDIO_PLAN §11.1 this is
signature sound #2.

| ☐ | id | Trigger | Files | Tier | Sourcing notes |
|---|---|---|---|---|---|
| ☑ | `mining.laser.start` | Player presses mine; beam ignites | 2 | `ship` | Short rising zap/charge, 200–400 ms. Search: *"laser charge up"*, *"energy weapon start"* |
| ☑ | `mining.laser.loop` | **Continuously while cutting.** Must loop seamlessly | 1 | `ship` | Steady electrical/plasma drone, 2–4 s. Search: *"plasma cutter loop"*, *"arc welder loop"*, *"laser hum loop"*. ⚠ Will be heard for minutes on end — must not fatigue |
| ☑ | `mining.laser.stop` | Beam released, cancelled, or the rock breaks | 2 | `ship` | Short falling tail-off, 200–400 ms |

### 🔴 `notify.info` is doing six jobs

Right now mining-complete, transit-engage, transit-arrive, craft-complete,
research-complete and every info toast all play the same file. They mean
completely different things and must not sound identical.

| ☐ | id | Trigger | Files | Tier | Sourcing notes |
|---|---|---|---|---|---|
| ☑ | `mining.complete` | Asteroid destroyed, loot awarded | 2 | `ship` | Satisfying resolve + a hint of debris. Search: *"rock break"*, *"mineral collect"* |
| ☑ | `loot.acquire` | Resource added to cargo | 3 | `ui` | **Signature sound #5** (AUDIO_PLAN §11.1) — heard thousands of times, it becomes the game's voice. Short, bright, tactile. Search: *"item pickup"*, *"collect resource"*, *"data chime"* |
| ☑ | `craft.complete` | An item finishes crafting | 1 | `ui` | Mechanical-assembly resolve, not a fanfare |
| ☑ | `research.complete` | A research node completes | 1 | `ui` | Warmer/longer than craft — this is a bigger moment |
| ☑ | `transit.engage` | Transit drive kicks in after spool | 1 | `ship` | Deep thump + onset of the drive |
| ☑ | `transit.arrive` | Drive disengages at the destination | 1 | `ship` | Falling settle, the opposite gesture to engage |

### 🔴 Rejections have nowhere to attach

| ☐ | id | Trigger | Files | Tier | Sourcing notes |
|---|---|---|---|---|---|
| ☑ | `ui.reject` | A blocked action: cargo full, cannot afford, laser overheated | 2 | `ui` | Short, dry, unmistakably negative. ⚠ **Needs a code change too** — trap T15: the Mine button is `disabled`, so it dispatches no click at all, and `CraftingPanel.requestCraft` returns early with no signal. I can wire these when the files exist |

**P0 total: 16 files.**

---

## P1 — Completes the core loop (20 files)

### Engine — the 3-layer blend (AUDIO_PLAN §6.5)

Three generated layers now blend with actual thrust demand. All fade to zero
when coasting; the legacy `idle` id means low positive thrust, not an always-on hum.

| ☐ | id | Trigger | Files | Tier | Sourcing notes |
|---|---|---|---|---|---|
| ☑ | `ship.engine.idle` | Low positive thrust | 1 loop | `ship` | Low hum. ⚠⚠ **All three layers must be tuned to a shared pitch reference** or the crossfades will beat and phase audibly — the classic vehicle-audio bug |
| ☑ | `ship.engine.mid` | ~50% throttle | 1 loop | `ship` | Same source family, more energy |
| ☑ | `ship.engine.high` | Full throttle | 1 loop | `ship` | Strained, brighter |
| ☑ | `ship.wind.low` | Low dynamic pressure: thin air, or slow in thick air | 1 loop | `ship` | **Derived, not authored** — level and brightness come from `q = ½ρv²` (§12.3e). Crossfaded with the two below; `syncLoop` keeps them phase-aligned |
| ☑ | `ship.wind.mid` | Moderate dynamic pressure | 1 loop | `ship` | Same airflow, more edge on the gusts |
| ☑ | `ship.wind.high` | Max-q: fast and low, or entry into a thick atmosphere | 1 loop | `ship` | Full buffeting. ⚠ Heard *through the hull*, so pressure and rush rather than whistle — brightness is deliberately held back |

### Transit drive

| ☐ | id | Trigger | Files | Tier | Sourcing notes |
|---|---|---|---|---|---|
| ☑ | `transit.spool` | The 3 s hold before engage (`TRANSIT_SPOOL_TIME_S`) | 1 | `ship` | **Signature sound #1** — the game's "jump sound". Rising, ~3 s, must build tension and land exactly on engage |
| ☑ | `transit.loop` | Cruising under drive | 1 loop | `ship` | Deep drone. Heard for 30–60 s at a time |
| ☑ | `transit.decel` | Flip-and-burn / deceleration | 1 | `ship` | Counter-thrust |

### Impacts and damage

| ☐ | id | Trigger | Files | Tier | Sourcing notes |
|---|---|---|---|---|---|
| ☑ | `world.impact.small` | Small rock strikes the hull (`radiusM` low) | 3 | `world`+`contact` | **MONO.** Replaces the placeholder `impact_0[1-3]`. Search: *"metal impact debris"* |
| ☑ | `world.impact.large` | Large rock (`radiusM` high) | 3 | `world`+`contact` | **MONO.** Deeper, longer tail. Currently faked by pitching the small ones |
| ☑ | `ship.hull.stress` | After a heavy hit; hull settling | 2 | `ship` | Metal creak/groan. Sells "you are inside a structure" |
| ☑ | `ship.damage.impact` | Hull HP drops | 3 | `ship` | Currently a pitched-up `click.hard`, which is placeholder-obvious |

### Comms — the AI's voice-print

No spoken dialogue (AUDIO_PLAN §6.7). These three carry the AI's entire
character, and there is exactly one speaker.

| ☐ | id | Trigger | Files | Tier | Sourcing notes |
|---|---|---|---|---|---|
| ☑ | `comms.chirp.arrive` | An AI message enters the queue | 1 | `ui` | **Signature sound #3.** Distinctive, warm, two-tone. Search: *"sci-fi notification"*, *"radio chirp"* |
| ☑ | `comms.chirp.advance` | Player advances a page | 1 | `ui` | Quieter sibling of arrive |
| ☑ | `comms.chirp.dismiss` | Message dismissed | 1 | `ui` | Softer close gesture |

**P1 total: 20 files.**

---

## P2 — Polish (14 files)

| ☐ | id | Trigger | Files | Tier | Sourcing notes |
|---|---|---|---|---|---|
| ☑ | `click.soft` | Panel open/close, passive button | 1 | `ui` | Replaces placeholder. Style-guide §6 name |
| ☑ | `click.hard` | Confirm / equip / craft press | 1 | `ui` | Replaces placeholder |
| ☑ | `hover.tick` | Hotbar focus, slider release, target lock | 1 | `ui` | Replaces placeholder. ⚠ Very quiet — currently −18 dB |
| ☑ | `notify.info` | Generic info toast | 1 | `ui` | Narrowed to *just* toasts once P0 splits the rest out |
| ☑ | `notify.warn` | Warning toast (`kind: "warn"`) | 1 | `ui` | |
| ☑ | `mining.target.lock` | Soft-lock acquired on an asteroid | 3 | `ui` | Currently `hover.tick`. 3 variants because it fires constantly while flying |
| ☑ | `mining.target.acquire` | Each one-sixth step of acquisition, excluding completion | 1 | `ui` | Quiet 75 ms tick; pitch rises with progress. No cue on brief flyovers |
| ☑ | `mining.target.lost` | Looking away after a completed lock | 1 | `ui` | Soft 180 ms downward cue. Suppressed after successful mining, pause or death |
| ☑ | `module.equip` | Module equipped / unequipped | 2 | `ui` | Mechanical seat/click |
| ☑ | `ship.destroyed` | The destruction moment | 1 | `ship` | Big, one-off. Currently just the critical alarm |
| ☑ | `death.bed` | Death screen, while shown | 1 loop | `ambience` | Sparse, cold |

**P2 total: 14 files.**

---

## Explicitly NOT on this list

- **Alarms and warning tones** — synthesised at runtime in
  [`src/audio/alarms.ts`](../src/audio/alarms.ts) and **finished**. Three tiers
  differing by pulse pattern. Zero files, and synthesis is the *authentic* choice
  here (AUDIO_PLAN §6.3), not a compromise.
- **Music** — your own Suno tracks. ⚠ Blocked on the licence check
  (AUDIO_PLAN §7.4 / L11): commercial rights attach to the plan active when a
  track was *generated*, and upgrading later is not retroactive.
- **Atmospheric wind / entry noise** — planned as procedural, driven by
  `q = ½ρv²` (AUDIO_PLAN §12.3). No file needed.
- **Voiced dialogue** — dropped. Chirp + text only.
- **Anything in-atmosphere and outside the ship** — there is nothing in the game
  yet that is both (§12.3d). No `air`-coupled assets are needed until there is.
- **Build / place / connect feedback** — blocked; no building system exists.

---

## Totals

| Priority | Files | What it buys |
|---|---|---|
| **P0** | **16** | Fixes the silent mining laser and un-collides six meanings sharing one file |
| P1 | 20 | Core loop stops sounding like placeholders |
| P2 | 14 | Replaces the last synthetic stand-ins |
| **All** | **50** | |

(50 planned files after retiring steering/cabin ambience and adding scanner feedback; 48 are generated,
with the two destruction variants still deferred.)

## Where to look

Per AUDIO_PLAN §6.6, in rough order of value:

1. **Sonniss GDC bundles** — free, commercial, no attribution. Best bulk source
   for impacts, metal, electrical, engine layers. ⚠ Re-read the licence at
   download time; bundle terms change between releases.
2. **Kenney.nl** — CC0. Covers most of the UI set outright.
3. **Your own recordings** — contact mic on metal, fridges, servos, HVAC. Pitch
   down + convolution is how a lot of real sci-fi is made, and it is the cheapest
   route to `ship.hull.stress` and hull impacts sounding like *your* ship.
4. **Freesound** — ⚠ per-sound licence. CC0 and CC-BY only; **CC-BY-NC is never
   shippable**.
5. ⚠ **Not** the BBC free tier (RemArc: research/education/personal only).
