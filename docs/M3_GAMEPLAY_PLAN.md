# M3 — Solo exploration and survival: design and implementation plan

**Status:** planned, 2026-11-15. Design handoff; no M3 code has been implemented by
this documentation task. M2 is actively being developed on `m2-physics`; do not treat
its working tree or this plan as evidence that its exit gates have passed.

**Read first:** [GAMEPLAY_AND_STORY.md](GAMEPLAY_AND_STORY.md), then this document.
[ROADMAP.md](ROADMAP.md) owns milestone order. [PHYSICS_PLAN.md §7](PHYSICS_PLAN.md#7-m2-as-decided-2026-11-16--supersedes-3-where-they-differ)
owns the current M2 contract; its earlier physics proposal is historical where different.
The root `STORY.md` and narrative/progression parts of `GAME_DESIGN.md` are superseded.

This is self-contained context for the implementing Claude Code session, which already
knows the roadmap and M0–M2 but did not participate in the gameplay discussion. Read
current `AGENTS.md` / `CLAUDE.md` before implementation. Work through the phases below;
do not implement deferred world features just because the broader concept mentions them.

## 1. Outcome and boundaries

M3 proves that a fresh solo player can become self-sufficient, make a meaningful
equipment choice, prepare a journey, reach a worthwhile lunar orbital site, establish
a new recovery point, and keep operating there without returning to Earth. Resource
constraints should provoke understandable decisions. Destruction must create a
recoverable setback rather than erase the equipment progression or strand the save.

The core loop is:

**Find an opportunity → investigate → prepare → travel → gather, recover, or experiment
→ establish capability or continue onward.** A return trip is optional.

### 1.1 Required M3 features

| ID | Feature | Minimum deliverable |
|---|---|---|
| F1 | Self-sufficient starter | Functional basic scan, mining, analysis, onboard fabrication, fuel processing, and repairs; a starting replication point. |
| F2 | Useful prospecting | Broad class indication, close inspection, usable yield estimates, persistent findings and resource-source markers. |
| F3 | Resource economy | Clear material purposes, viable hydrate/propellant supply in both regions, no easy lunar helium-3 gate. |
| F4 | Fuel processing | Small onboard batches converting suitable mined feedstock into the first propellant. |
| F5 | Activity pressures | Propellant, reactor output, capacitor, shared thermal state, impact damage, and resource-paid repair. |
| F6 | Discovery-based research | Typed evidence and a few simple trials; world-owned unlocks; no universal assay grind as the main gate. |
| F7 | Branching equipment | Survey, extraction/thermal, cargo, and propulsion choices with at least two viable early priorities. |
| F8 | Fuel-aware transit | Consistent ETA/fuel prediction, safe braking, visible obstruction handling, destinations that include placed points. |
| F9 | Replication points | Craft, place, name, activate, persist, and recover at standalone structures. |
| F10 | Loss and recovery | Cargo/fuel wrecks, partial recovery, emergency abandonment, and a final safe fallback. |
| F11 | Earth/lunar content | Several meaningful local opportunities plus a lunar survey/salvage activity distinct from basic mining. |
| F12 | Player-directed guidance | Optional tracked projects, contextual AI hints, and a readable discovery/help record. |
| F13 | Durable saves and difficulty | Migration, reload/import/export integrity, Standard balance, simple difficulty multipliers. |

### 1.2 Explicitly outside M3

- Co-op networking, sessions, host migration, and transport (M4).
- Storage depots, modular station building, stationary industrial refineries, automated
  extraction/hauling, and drone job UI (M5). Basic onboard processing is F4, not a factory.
- Asteroid fields v2, system-wide belts, mineable rings, moving/pushable asteroid state,
  and physics debris (M5/M6). Preserve M2's fixed asteroids and collision contract.
- Terrain, landing, surface resource nodes, and entry heating (M7).
- Demanding solar heating, radiation, gas-giant collection, distant astronomical resource
  searches, new systems, and interstellar gameplay (regional work through M6–M9).
- Interiors, on-foot gameplay, a ship-construction editor, population simulation,
  habitability scoring, biological restoration, and actual colony establishment.
- Earth atmosphere/texture/cloud changes to illustrate the catastrophe.
- Combat, NPC economies, randomized breakdowns, food/oxygen/crew care, and archive care.

The broader goals remain in [GAMEPLAY_AND_STORY.md](GAMEPLAY_AND_STORY.md). Existing
celestial destinations and free exploration need not be removed just because their
full resource loop is deferred. M3 does not promise every reachable destination is
already populated with activities.

## 2. Rules that implementation must preserve

1. Earth is a departure region, never a compulsory home or research service.
2. Essential starter recipes cannot depend on visiting the Moon, owning a station,
   spending a rare drop, or first obtaining the equipment they enable.
3. Both initial regions provide renewable-in-practice access to ordinary self-sufficiency
   inputs. Individual mined asteroids stay depleted; do not respawn depleted IDs on reload.
4. At rest in safe space, fuel and hull do not drain. Power is capacity, not a survival
   countdown. Cooling and capacitor recovery may continue during active simulation.
5. Coasting costs no propellant merely because speed is high. Thrust, including assist
   and braking, does cost propellant. Astronomical/frame motion is not thrust.
6. A budget reaching zero must never disable the already-reserved safe transit braking
   path. A warp ending at full velocity because the fuel bar emptied is a defect.
7. Normal destruction returns to the player's last activated valid replication point,
   preserves permanent progression, and leaves ordinary cargo/fuel at the wreck.
8. Replication points are recovery locations, not snapshots that roll knowledge back.
9. Fuel starvation always has an accessible emergency recovery route. A small reserve
   alone is not a proof that arbitrary empty-space placements are recoverable.
10. Shared progress/objects have one authority writer. Player equipment, supplies, and
    checkpoint selection remain separate. Prepare this seam now, not a second rewrite in M4.
11. Simulation and resource consumption use executed simulation time, not React renders,
    frame count, wall-clock absence, or accelerated ephemeris time.
12. The archive is protected fiction. No inventory object, care task, failure meter,
    collection quest, or colony progression subsystem is needed in M3.

## 3. Starting experience and playable content

### 3.1 Opening

Awaken as the delayed autonomous probe near Earth. Humanity is gone and Earth is
uninhabitable for humans. A short optional record establishes the original exploration
purpose and the dormant archive. Avoid naming a catastrophe, date, human protagonist,
drive campaign, or mandatory destination that has not been agreed.

Start with a functioning vessel, a finite ordinary fuel supply, basic tools, the
essential recipes, and a protected initial replication point near accessible material.
The first recipe cycle is supported by the environment, not a large gift inventory.
Naming the existing companion AI can remain; no ground-control messages follow it.
No mandatory damaged-ship repair sequence or starting countdown.

### 3.2 Earth region

Reuse `origin_belt` and its deterministic generation. Author a small set of meaningful
regional opportunities rather than expanding field streaming. Include accessible
hydrate-bearing, metal-rich, and mixed material targets and a survey opportunity.
Guarantee a discoverable fuel source within the starter's normal recovery reach for
every supported new-world seed. Do not rely on a lucky target roll for essential fuel.

The starter area is a localized prospecting/debris site in the fiction, not a claim
that a natural dense asteroid belt surrounds Earth. Its exact origin is incidental.

### 3.3 Lunar orbital region

Reuse/rebalance `luna_belt`, preserving its stable field identity for migration. It must
support local fuel, repairs, and replication construction using available materials.
Give it a worthwhile concentration or equipment opportunity, not exclusive possession
of ordinary elements. Remove the present bulk helium-3 fractions from the early economy.

Add one small authored survey-equipment salvage site. **Implementation default:** a
recoverable instrument/sample canister near an abandoned automated survey installation.
Players locate it through regional indications, approach safely, inspect it, and recover
material/data through an accepted interaction. No walkable interior, NPC, moving debris,
surface extraction, or new rigid-body subsystem is required.

The discovery can enable an advanced scanner alternative or processing improvement.
It is not required to keep mining, producing fuel, repairing, building points, or leaving.
One-time site rewards/evidence must persist and cannot be farmed by reloading. Ordinary
local resource gathering remains repeatable across the surrounding field.

## 4. Economy, prospecting, research, and equipment

### 4.1 Resource roles

Keep familiar existing material IDs where their meaning still fits. Do not rewrite the
entire inventory into chemical species or introduce a large intermediate-part catalogue.

| Input / output | Initial use | Design constraint |
|---|---|---|
| `hydrates` / suitable volatile feedstock | Water-based reaction mass after onboard processing | Essential in both regions; distinguish raw feedstock from filled fuel tanks. |
| `fe_ni_metal` | Hull repairs, structural/module fabrication, replication kit | Basic repairs never require lunar-only material. |
| `silicates` | Structure, basic electronics/thermal components | Keep recipe purpose legible. |
| `carbon`, `sulfur` | Selected processing/equipment recipes | Avoid putting every ingredient in every recipe. |
| `titanium` | Optional specialist equipment/material quality | Improved access can reward the Moon; no absolute geographic exclusivity. |
| Ordinary propellant | Manoeuvring and transit | Separate bounded quantity from integer cargo, initially one type. |
| Research evidence | Knowledge of a material, source, observation, or trial | A typed durable record, not a universal spendable science token. |

Label numerical recipes as tuning values. Before coding content, make a small recipe
matrix in `src/data/content.ts` or its focused successor showing prerequisites, inputs,
outputs, and purpose. Audit it for circular dependencies and cargo capacity deadlocks.
Do not require a single fabrication batch larger than the starter can carry.

### 4.2 Prospecting and discovery records

The baseline scanner provides enough information to find suitable material without
consumable probes. Broad indication is fast; deliberate close inspection adds composition
and yield estimates. More capable equipment improves reach, detail, and efficiency.
Scanning changes a decision, not just an icon colour.

Persist useful source/site records by stable IDs. Use region/site coordinates or stable
`fieldId + chunkKey + asteroidId` references, never instance-array indices, Object3D
references, render-space positions, or a record for every rock merely rendered. A mined
target's marker must not continue promising intact ore; keep its confirmed finding as
knowledge and mark the target depleted.

M3 needs a readable discoveries/source list integrated with existing POI targeting,
not a new galaxy-map renderer. Permit naming/bookmarking a useful source and selecting
it as a transit destination. Do not fabricate exact deposits from remote star spectra;
astronomical resource surveying is later work.

### 4.3 Research requirements

Use data-defined, typed requirements with bounded `all`/`any` combinations. Initial
requirement kinds can be: confirmed material-family finding, inspected/recovered site,
and completed simple equipment trial. A trial records a meaningful use, not dozens of
identical repetitions. Trials must not require deliberately taking damage or being stranded.

**Implementation default:** accepted extraction/inspection records the relevant sample
evidence; M3 does not need a second physical specimen inventory. An analysis may consume
a small explicit amount of matching material. Once a finding is recorded, it survives
death. If a future feature needs physical specimens, add that boundary deliberately.

Basic analysis works immediately. Research adapts existing technology to the ship and
available manufacturing; the probe is not rediscovering fundamental science. There may
be short presentation/processing intervals, but no serial minutes-long research queue
as the main gate. Do not grant a new finding for each repeated rock of the same known
source merely to recreate universal assay accumulation.

Example branch skeleton (names and exact recipes are tuning/content defaults):

| Branch | Evidence/use | Possible result |
|---|---|---|
| Survey | Inspect distinguishable material families | More useful composition/yield display or a regional search improvement. |
| Extraction | Analyze metal-rich feedstock and complete a controlled extraction | Better recovery efficiency or a different extraction mode. |
| Thermal | Observe a sustained equipment load safely | Better sustained duty cycle; compete with a faster/hotter mining option. |
| Logistics | Process feedstock and fabricate basic structure | More cargo or more propellant capacity. |
| Propulsion | Basic manufacturing/processing competence | Calibrated transit capability and improved local handling/efficiency. |
| Lunar opportunity | Recover survey equipment/data | An optional specialist upgrade, not another essential survival prerequisite. |

Transit must be achievable from starter-region evidence/materials through a short,
purposeful path. Remove the old requirement to complete any three unrelated tier-2
nodes before being allowed to travel. Early replication construction is also available
from common local inputs and baseline fabrication.

### 4.4 Equipment, crafting, and processing

Keep the current seven equipment slots and one effective-config calculation. Reuse
compatible item IDs and assets. A small balanced catalogue is preferable to preserving
all 32 legacy items as mandatory content. At least two first investment priorities
must be viable: for example better surveying versus sustained extraction/cooling.
Cargo versus fuel capacity supplies another understandable tradeoff.

Crafting is an atomic domain operation: validate knowledge/capacity/materials, consume
inputs, then grant the item and emit one result. UI components do not perform a sequence
of independent cargo deductions. Failures explain the missing requirement and spend nothing.

Onboard processing accepts a bounded batch, reserves/consumes its input once, progresses
on executed simulation time with power/heat limits, and delivers output exactly once.
Pause/death/world switching cannot duplicate it. Stop/refuse cleanly if the output tank
is full; do not silently destroy overflow. Use one simple queue or batch, not production
graphs. Define cancellation/refund and save behaviour before implementing the UI.

**Implementation default:** on cancellation return unprocessed input, retain only output
already committed, and never refund material already converted. Pending batches pause
when not actively simulated; no offline production or elapsed-wall-time catch-up in M3.

## 5. Ship resources and travel

### 5.1 A single resource step

Add a pure, typed ship-resource domain beside the existing ship sim. Fuel, heat,
capacitor charge, reactor output, and in-progress processing have one owner and one
executed-time step. Use stable mutable runtime state and sampled UI mirrors; avoid
per-frame React state or full-world save writes.

Use the current fixed 120 Hz loop, or an explicit fixed-rate accumulator supplied by
its executed time, for budgets. Avoid independent clocks for flight, fuel, mining,
processing, transit, and thermal damage. Collect equipment requests, resolve available
resources, apply bounded actions, and meter what actually executed. Throttled mining
must also slow extraction; blocked thrust must not still move the ship.

Keep units explicit: fuel mass in kg, simulation time in seconds, power in a documented
consistent unit (prefer kW), energy in the matching unit (kJ), and heat as a documented
effective thermal store/capacity. This is a bounded engineering/gameplay model, not a
claim of complete propulsion or spacecraft thermal simulation. Existing cargo can
remain integer cargo units with explicit recipe conversions. Do not infer fuel mass
from cargo display units or visual engine brightness.

### 5.2 Propellant

Initially use one ordinary propellant resource with small manoeuvring use and substantial
transit use. Meter actual commanded control work: forward, retro, lateral/vertical,
angular acceleration/deceleration, and coupled assist. Reuse scratch values; no per-step
allocations. Collision impulses, frame switches, ephemeris motion, and purely coasting
velocity do not consume propellant. Ignore numerical controller chatter through a
documented small deadband; do not charge a parked ship indefinitely.

The existing `ShipState.thrustMain` is only positive forward acceleration and cannot
serve as the complete fuel meter. Add explicit control-demand results as needed.
Formula/coefficient choices are tuning defaults, with honest units; do not present
the fictional transit system as a physically verified high-performance rocket.

Represent the protected recovery allowance separately. Spend ordinary fuel first;
allow the protected amount to support a short recovery flight when needed. It cannot
be moved into ordinary tanks, processing output, recipe inputs, or a wreck. It is not
an additional permanently draining HUD survival bar.

At absolute exhaustion, suppress further propellant-driven acceleration without
deleting velocity or manufacturing a stop. Keep menus, target inspection, help, and
emergency recovery accessible. The explicit fallback in §6 handles truly stranded cases.

### 5.3 Power and heat

Reactor output is a capacity budget. Essential control/sensing gets priority; high-draw
mining/processing must throttle or pause rather than disable the player's ability to
navigate or open recovery. Provide a clear loadout preview and runtime reason when
an action lacks power. No reactor-fuel survival meter in this milestone.

Capacitor capacity covers boost and selected burst actions. M1 already spends/refills
`boostCharge` in `stepShip`: integrate or replace that store, never apply a second
unrelated boost drain. Normal boost feel should remain recognizable after the change.

Use one ship thermal budget for mining, boost, transit spool/burn, and processing.
Route existing laser-overheat UI/effects through it so two heat models cannot disagree.
Cooling and capacity depend on equipment. Warn, then throttle discretionary loads before
unsafe sustained heat can damage hull. Warnings precede damage with a usable reaction
window. Braking safety takes priority over thermal throttling of optional activity.
Pausing cools nothing and consumes nothing. Distance-to-star heating is explicitly later.

### 5.4 Hull and repair

M2 remains the owner of collision/contact detection and damage inputs. Follow its §7
contact-normal delta-v damage curve, static asteroids, and lethal celestial sweep.
Do not substitute an older energy/rock-size curve or restore ramming-based destruction.
Difficulty/equipment may apply the established damage modifiers.

Basic repairs consume common structural material. No free hull regeneration by default;
legacy regeneration items must consume material or be retired from the normal catalogue.
Repairing restores hull, not spent fuel/cargo. Empty repair inputs never prevent recovery.

### 5.5 Transit prediction and execution

The current transit integrator is in `TransitTicker.tsx`, advances with a clamped render
delta, and feeds an additive velocity to the fixed ship step. Refactor only enough to
make transit execution, fuel, heat, ETA, and braking reserve use a common pure trajectory
and executed-time model. Preserve M1 steering/input and M2's single physics-owner gate.
Do not create a second ship integrator.

For a destination show ETA, estimated ordinary fuel, usable recovery reserve, predicted
arrival balance, and any obstruction/range warning. Initial prediction can assume no
optional mining or large manual detours; state that assumption in concise product terms.
Recompute if relevant loadout, target, or trajectory changes. Support moving frame-based
targets, including points and survey sites.

Reserve deceleration fuel before optional acceleration. When the remaining budget reaches
the stopping requirement plus margin, enter controlled deceleration. Fuel/heat limits
cannot bypass that reserve. Aborting mid-leg follows the same safe stop path. Never
clamp transit speed to zero to hide fuel exhaustion. Test both prediction and actual burn.

Earth currently obstructs the default Earth-to-Moon line of sight. M3 must solve the
playable journey, not merely display an unusable direct route. Use bounded one-body
clearance waypoints/manual staged transit where necessary; general route-graph or
galactic pathfinding is not required. Clearance legs must themselves be reachable
under early fuel/heat limits and stop outside collision/field hazards. Verify at more
than one ephemeris date. Never steer through Earth to satisfy an arrival gate.

## 6. Replication, destruction, and salvage

### 6.1 Placement and activation

Replication is the only new placeable structure in M3. No storage/depot UI, freeform
station editor, docking simulation, generic construction framework, or new dependency.
Use a small existing/simple visual, a range indicator, and an unobstructed emergence
offset. Complex ship-station contact physics stays with M5.

Craft a kit from common material. Placement preview validates a finite frame-relative
pose, distance, geometry clearance, safe emergence, and kit availability. Accepted
placement consumes one kit, creates one world record, copies the archive implicitly,
and activates it for the placing player as one operation. Rejected/retried placement
does none of those twice. Allow naming. Other players' selections are unaffected.
Represent the kit as a counted deployable/consumable item, not a permanent unlock that
allows unlimited free placements. Preserve existing input mappings; add placement and
activation through the input/action layer with rebindable controls where appropriate.

Activation of an existing point requires a deliberate nearby action. Deactivation
does not delete it. M3 need not support dismantling or hostile destruction. Keep the
initial point protected and supplied. Place points in the existing system frame
(`SYSTEM_FRAME_ID`) outside body influence, or a supported body-inertial frame nearby.
Do not pull orbit or rotating-surface frame simulation forward just for this feature.

### 6.2 Death transaction

Capture a consistent death pose in the ship's frame, all recoverable cargo/consumables,
and ordinary fuel. Create the wreck and clear those quantities from the vessel exactly
once. Fuel-only and consumable-only wrecks are valid. Save the dead/recovery-pending state so reloading
cannot repeat the drop, keep pre-death cargo, or bypass the loss. Death/abandonment
share this path; an emergency action requires an explicit confirmation showing the
point and loss, while ordinary death has a simple recovery action.

Permanent manufactured modules, their equip selection, completed research/evidence,
and discovery records are retained. Loose consumables leave with cargo. The archive
is never enumerated as wreck contents. Standard difficulty does not add module damage
or destroy a previously recoverable wreck merely because the player dies again.

### 6.3 Recovery transaction

Default destination is the last activated valid point. Revalidate its emergence area;
use a safe nearby offset if obstructed, else fall back to the protected starter point
with a clear reason. A missing frame/ID is invalid; an arbitrary far-away checkpoint is
not automatically invalid just because it is inconvenient.

Restore full hull, permanent equipment, empty recoverable cargo, zero ordinary propellant,
and the configured protected recovery allowance. Reset pending consumable actions;
clear carried consumable counts while retaining harmless hotbar assignments. For a
processing batch, move reserved/unconverted feedstock into the wreck, leave previously
committed output in the ordinary fuel being dropped, and clear the batch. Do not run
the ordinary cancellation refund on the replacement vessel. Do not rewind shared
knowledge to activation time.

Perform a proper runtime reposition: frame-relative pose, prev/current interpolation,
linear/angular velocity, normal/transit motion buffers, fixed-step accumulator,
absolute ship position and floating origin, input/mouse intent, camera/shake state,
and M2 near-field reseeding. Do not reuse the DeathScreen's current hard-coded starting
teleport as the new gameplay API. Remain paused until the arrival area is ready.

**Empty-space escape:** a small recovery allowance cannot reach resources from every
freely placed point. The recovery screen therefore offers an explicit starter-point
fallback, without changing the normal default. It carries the same cargo/fuel loss and
does not offer arbitrary checkpoint selection. Explain that this sacrifices expedition
location. This is an implementation default to prevent a respawn loop, not a claim that
all placements are self-sufficient. Add a resource-distance warning to placement where
known; do not ban nomadic placements solely for lacking nearby ore.

### 6.4 Wreck recovery

Transfer material cargo, consumables, and fuel with their respective capacity limits.
Existing consumables live in `ModulesState.consumables`, not material cargo; give wrecks
a typed consumable-count store and respect each item's `stackMax` on collection. Do not
pass consumable IDs to `addCargoAtom` as resource IDs. Permit partial recovery,
leave overflow at the wreck, and remove the wreck only when all recoverable stores are
empty. Collection is accepted once by the authority, then reflected in player state;
no optimistic duplicate award. Recovered fuel goes to ordinary tanks, never the protected
allowance. Remnants stay in their saved frame as bodies move. Reuse existing wreck
markers and collection interaction rather than building M5 physics wreckage.

## 7. State, commands, and migration

### 7.1 Ownership

Names below are suggested domain boundaries, not a requirement to create a framework.

| Owner | Durable data | Notes |
|---|---|---|
| World | Replication point IDs/names/frame poses, initial point ID | No per-player active flag on a shared object. |
| World | Discoveries, confirmed evidence, research unlocks, recovered-site flags | Shared progress; deduplicate accepted source/event IDs. |
| World | Asteroid deltas, cargo/consumable/fuel wrecks | Extend the existing records and command flow; emptiness checks cover all stores. |
| Player | Active replication ID, ship pose/hull/loadout | Placing/activating only changes that player's selection. |
| Player | Ordinary/protected fuel, capacitor/heat, processing batch, carried consumables | One runtime owner with coherent saved snapshots. |
| Player | Tracked project and personal display/bookmark preferences | Shared discoveries remain accessible even if another player hides a marker. |
| Device | Keybinds, mouse/camera/audio/display preferences | Existing localStorage preferences; no new gameplay keys. |

The current save format puts all research in `PlayerState`. Move agreed shared progress
to world ownership in M3, including its UI mirrors. Do not postpone that change to M4
or store research twice as competing sources of truth. Actual co-op transport stays M4.

### 7.2 Accepted operations and durability

Extend the existing authority/domain seam with typed operations for placement/activation,
confirmed evidence, research completion, site recovery, processing/crafting/repair,
destruction/recovery, and wreck transfers. Each operation validates all affected world
and player slices before any spend or reward, commits a coherent result, then publishes
an accepted result/event. Specific command names can follow current conventions.

`Authority.submit()` currently returns a synchronous boolean. Its contract explicitly
anticipates asynchronous M4 acceptance. New UI grants must come from accepted results,
not `if (submit(...)) addCargo(...)`. Use stable operation IDs and duplicate protection
for retryable operations. No full distributed transaction framework or network protocol
is required in M3; a local atomic reducer/operation and one saved world record suffice.

Death, placement, and wreck collection touch both world and player state. Their complete
result must enter the same durable snapshot. Save collectors/mirrors must not write
stale pre-transaction values back over it. Publish pending UI while necessary; input
can resume after acceptance. Reload/retry must not replay a spend or award. Exact
receipt storage can be bounded, but duplicate effects must remain prevented by durable
object/reward state after reload.

Hydrate world mirrors and player state before mounting gameplay; reset/teardown all
buffers when switching worlds. Do not add gameplay `atomWithStorage` or localStorage.
Sim/domain reducers and types stay independent of React, jotai, the DOM, and UI modules.
Preserve the existing save-layer dependency rules, but retain the browser persistence
adapters (`activeSave.ts`, `saveDb.ts`, `boot.ts`) that intentionally use IndexedDB and
browser lifecycle APIs. This is not a headless rewrite of those adapters.

### 7.3 Migration policy

Schema is currently v1. Append migrations to the installed schema version; do not
hard-code a version assuming M2/another branch has not added one meanwhile. Update
defaults, all relevant sanitizers, hydration, collectors, and import/export validation
together. Interfaces alone are insufficient: current sanitizers rebuild explicit fields.

Before implementation, write an explicit legacy-ID mapping table. Required policy:

- Preserve all players, poses, cargo, asteroid depletion, wrecks, manufactured equipment,
  companion name, and device settings. Existing nonzero poses must not reset to Earth.
- Union compatible completed research across saved players into shared world progress.
  Preserve legitimate existing equipment access without requiring the old grind again.
- Map old research/retired items explicitly. Keep a minimal inert legacy record for IDs
  that cannot be mapped, rather than silently deleting them or granting every new finding.
- Retire universal assay spending and the old ticker path. Preserve paid active research
  via a one-time mapped completion where compatible; retain incompatible legacy state
  inert with a migration note. No requirement to finish old timers or farm more assays.
- Add initial replication and recovery defaults deterministically and idempotently.
  Existing dead saves must gain a usable recovery destination. Live remote saves receive
  enough initial ordinary fuel for the new mechanics without relocating the ship.
- Legacy wrecks get zero fuel and empty consumable stores. Validate fuel as finite bounded
  nonnegative fractional quantities, separately from integer material/consumable counts.
  Handle malformed point IDs/frames and unknown consumable IDs safely.
- Avoid double-applying old passive bonuses when moving research through effective config.

Test actual schema-v1 fixtures, multiple-player fixtures, dead/remote saves, invalid
imports, repeat parsing, and export/import equality. Migration is not permission to
wipe a world or reroll depleted asteroid identities.

## 8. Pause, UI, and performance contracts

### 8.1 Simulation lifecycle

Use the existing pause contract (`src/sim/simPause.ts`) plus explicit settings/death/loading
handling. Settings can stop R3F completely; a background timer must not keep consuming
fuel or completing processing while the simulation is paused. Tab-away/resume follows
the ship's bounded executed-time policy; no catch-up fuel bill or massive heat tick.
Ephemeris `simRate` must not multiply resource time. World unload clears pending work
and event subscriptions. There is no offline production in M3.

Keep audio on the existing semantic event/bus/emitter lifecycle. Do not move it into
the gameplay fixed step or add another AudioContext. Read `AUDIO_PLAN.md` before any
audio changes. Shared visual/audio cues observe accepted state transitions once.

### 8.2 UI and guidance

Follow [UI_STYLE_GUIDE.md](UI_STYLE_GUIDE.md), adapting existing panels rather than
redesigning the whole HUD. Glance-level status: useful fuel/range warning, thermal
headroom, hull, burst availability, and active recovery destination when relevant.
Inspect-level panels explain composition, power limits, transit budget, and placement.
Deep panels hold research, crafting, discoveries, and optional tracked projects.

Research shows what is known, what evidence is missing, and what capability an unlock
provides. A tracked project translates a player-selected ambition into actionable
requirements. No always-on universal assay counter or mandatory quest chain.

Use the existing centralized `GameCommsTriggers.tsx` pattern for comms. Keep explicit
manual dismissal for actual comms entries. Put routine state in instruments/toasts and
optional records instead of forcing Continue after each craft. Suppress repeated hints,
allow experienced players to ignore them, and ensure an overlay cannot conceal a
critical braking/fuel warning or block emergency recovery. No LLM service is required.

### 8.3 Cost and scope guardrails

No new dependencies, state framework, ECS, rendering pipeline, or full-screen pass.
No per-frame cloning of the saved world, catalogue-wide searches, React resource updates,
or simulation of every stored point. Index durable records and render nearby/relevant
objects/markers. Avoid an unbounded discovery log for ordinary scanned rocks.

Measure M2 baseline and M3 cost at fixed named scenes with the same resolution, DPR,
settings, and pacing. Proposed scenarios: `m3_origin_work`, `m3_lunar_site`, and
`m3_replication_many` (declared during implementation, not existing scenario IDs).
Profile nearby and distant saved points separately. Report per-pass CPU/GPU milliseconds,
never eye-balled FPS. Target no material regression against baseline; if a budget is
missed, optimize the new work rather than deleting visual quality or established features.

## 9. Existing code map and traps

Snapshot of the working tree during planning; re-read after M2 finishes.

| Area | Start reading | Integration note |
|---|---|---|
| Save | `src/save/types.ts`, `defaults.ts`, `migrations.ts`, `validate.ts`, `activeSave.ts` | Versioned per-world record, explicit sanitization, collectors. |
| UI save bridge | `src/store/savedAtom.ts`, `worldBridge.ts` | Hydration before gameplay; authority event mirrors for shared data. |
| Authority | `src/sim/world/commands.ts`, `authority.ts`, `worldAuthority.ts` | Today: asteroid deltas, wrecks, time. Extend locally; preserve future async acceptance. |
| Frames/entities | `src/sim/frames.ts`, `entities.ts`, `ship/shipFrame.ts` | Only body-inertial frames implemented; entities currently ship-oriented. No ECS needed. |
| Flight | `src/sim/ship/stepShip.ts`, `shipState.ts`, `flightTuning.ts`, `src/components/Spaceship.tsx` | Pure fixed step; budget actual controls, preserve M1 feel. |
| Physics | `src/sim/physics/nearField.ts`, `docs/PHYSICS_PLAN.md` §7 | One resolve owner after tentative flight step; reframe/reseed on reposition. |
| Transit | `src/store/transit.ts`, `src/components/Transit/TransitTicker.tsx` | Separate render-time integrator needs a shared executed-time seam. |
| Mining/content | `src/components/Mining/MiningSystem.tsx`, `src/sim/asteroids/resources.ts`, `src/data/content.ts` | Universal assay award and boolean-accepted reward path must change. |
| Research | `src/store/research.ts`, `src/components/Research/ResearchTicker.tsx` | Replace both per-player ownership and old timer completion writer. |
| Equipment/crafting | `src/store/modules.ts`, `shipConfig.ts`, `src/components/HUD/CraftingPanel/CraftingPanel.tsx` | One config fold; move recipe spend/grant out of UI into accepted operation. |
| Death/salvage | `src/store/death.ts`, `src/components/HUD/DeathScreen/DeathScreen.tsx`, `src/components/WreckCollector.tsx` | Hard-coded starting teleport; split wreck/cargo writes; integer-only wreck cargo. |
| POIs | `src/store/poi.ts`, `src/components/POI/POIProjector.tsx`, `src/components/HUD/POIMarkers/POIMarkers.tsx` | Already support frame IDs and arrival standoff; add persisted sites/points. |
| Initial world | `src/sim/systems/sol.json` | `origin_belt`, `luna_belt`; current lunar helium-3 fractions conflict with the new economy. |
| Comms/projects | `src/components/Comms/GameCommsTriggers.tsx`, `src/data/commsMessages.ts`, `src/components/HUD/ObjectiveTracker/ObjectiveTracker.tsx` | Contextual hints and player goals replace obsolete story/assay prompts. |

## 10. Ordered implementation phases

Implement only when M3 work is requested after the current M2 contract is stable.
Record evidence and changed assumptions incrementally in this document. Checkboxes
below are initially uncompleted; do not mark them based on this documentation pass.

### M3.0 — Reconcile and capture the baseline

- [x] Read the two new design docs and current M2 as-built status/gates.
- [x] Record actual save schema, physics API, pause behaviour, and baseline timings.
- [x] Write the content/legacy mapping and resource tuning tables; define units and
      command boundaries before touching UI.
- [ ] Confirm a default initial fuel-source/replication placement for every supported seed.

**Gate:** M0/M1/M2 regression status recorded; agreed decisions distinguished from
tuning defaults; no stale root-story requirement used. No new dependency required.

### M3.1 — Durable domain and ownership

- [x] Add typed world/player records, accepted domain operations, world mirrors,
      coherent save transactions, and append-only migration/sanitization.
- [x] Move shared research/evidence/discovery ownership; preserve old data by mapping.
- [x] Implement deduplicated transaction foundations for manufacturing and world/player
      transfers, including fuel-only wreck representation.

**Gate:** migration and round-trip fixtures preserve progress; rejected/repeated
operations cannot double-spend, duplicate rewards, or leave mixed world/player results.
Reload at a transaction boundary is consistent. Two saved players share knowledge but
retain separate supplies/equipment/active point selections.

### M3.2 — Self-sufficiency and activity budgets

- [x] Add pure resource stepping, control-demand metering, reactor/capacitor arbitration,
      unified heat, basic fuel batches, repair, and resource HUD read models.
- [x] Integrate mining/boost/processing requests with actual granted work and pause.
- [x] Make starter tools and essential recipes available without the old research boot gate.

**Gate:** rest/coast/no-input idle costs nothing; thrust and work cost the intended
resources; conversions conserve inputs/outputs; throttle and frame rate do not change
results for the same executed inputs. Empty/full tanks, heat, pause and death are bounded.

### M3.3 — Prospecting and discovery-based research

- [x] Implement meaningful baseline inspection, stable findings/markers, typed research
      requirements, and simple non-dangerous trials.
- [x] Remove generic assay rewards/required timers from the new path; disable the old
      research completion writer for new saves.
- [x] Expose useful missing-evidence explanations in existing research UI.

**Gate:** repeated known-source scans do not farm universal progress; durable evidence
unlocks the intended options exactly once and survives death/reload; basics remain
available without consuming scan probes.

### M3.4 — Branching equipment and economy

- [x] Rebalance recipes/available modules, retire incompatible effects/consumables,
      and connect equipment to one effective config and power/thermal preview.
- [x] Provide at least two viable early investment priorities and a direct, purposeful
      starter-region path to transit.
- [x] Ensure replication kits, fuel, and repairs remain craftable in either region.

**Gate:** recipe dependency/capacity audit passes; no helium-3 survival/travel gate;
manufacturing UI and underlying accepted actions agree; no duplicated passive effects.
Fresh-save playthroughs through both early priorities remain viable.

### M3.5 — Fuel-aware travel

- [x] Extract/consolidate the transit time/trajectory seam, predictor, safe braking reserve,
      abort handling, and frame-relative POI targeting.
- [x] Add range/arrival balance and obstruction feedback; make the Earth-to-Moon route
      playable with bounded clearance legs when necessary.

**Gate:** predicted versus executed burn/ETA within a documented tolerance (initial
target 5% for unchanged straight legs); insufficient fuel aborts/limits safely; no
negative stores or full-speed zero-fuel drop-out; M1/M2 ownership gates still pass.
Verify departure/arrival with Earth obstructing and at a second orbital date.

### M3.6 — Replication and complete recovery

- [x] Add the simple placeable point, naming/activation, initial fallback, and recovery UI.
- [x] Implement atomic death/abandonment, safe frame-relative restoration, protected
      allowance, cargo/consumable/fuel salvage, and explicit final starter fallback.
- [x] Wire normal and fuel-only wrecks into markers and partial collection.

**Gate:** failed/retried placement spends no extra kit; activation affects only its
player; live/dead reloads do not duplicate drops; a second death preserves prior wrecks;
invalid and isolated point cases have a usable recovery. No archive/module progression
loss, no protected-fuel farming, no immediate spawn collision or physics jump.

### M3.7 — Lunar opportunity, projects, and narrative

- [ ] Author/rebalance initial sites and the lunar instrument/sample recovery opportunity.
- [ ] Add player-selected projects, concise hints/help records, sparse premise text,
      and updated POI/crafting/research/death explanations.
- [ ] Remove obsolete ESA/live-human messages and generic-assay prompts from the active path.
- [ ] Apply simple Explorer/Standard/Hard multipliers; keep the recovery/progression
      preservation model consistent. Balance Standard first.

**Gate:** a lunar discovery supplies a worthwhile optional capability; both regions
support continuing locally; no mandatory return-home quest, archive task, or timed upkeep.
All content has meaningful reload/deduplication behaviour.

### M3.8 — End-to-end gates and playtest

- [ ] Run the verification matrix below in disposable worlds, plus required regressions.
- [ ] Playtest both early priorities, one-way relocation, and a deliberate failure/recovery.
- [ ] Record timings, resource decisions, unclear UI, economy exploits, and final tuning.
- [ ] Update roadmap/as-built notes with actual completion and remaining limitations.

**Gate:** every release criterion in §12 is demonstrated. Passing pure maths checks
alone does not establish that the loop is understandable or enjoyable.

## 11. Verification plan

Use the existing zero-dependency `pnpm drive` and installed TypeScript toolchain. There
is currently no `test` package script. Proposed future harness:
`scripts/drive-examples/gameplay-check.mjs`, with pure domain fixtures and a small live
gameplay section. It does not exist yet and must not be reported as executed now.

| Gate | Required cases / evidence |
|---|---|
| V1 Resource accounting | Fixed executed input at 30/60/144 Hz rendering; idle/coast; each thrust axis and assist/brake; no charge for collision/frame motion; no NaN/negative stores. |
| V2 Power/thermal | Boost uses one capacitor; sustained loads throttle extraction/processing consistently; warning before damage; essential control and reserved braking remain available. |
| V3 Processing/repair | Partial batch, full output, cancellation, pause, death, reload; death moves reserved feedstock to wreck and clears batch; inputs/output/repair granted once; no free regeneration. |
| V4 Research | Confirmed versus suspected finding; stable-source deduplication; rejected extraction; trial completion; no old timer writer; shared saved-player access. |
| V5 Transactions | Reject, retry, duplicate accepted event, reload after spend/grant/death boundaries; no stale collector overwrite. |
| V6 Placement | Valid, obstructed, lethal, invalid frame, missing kit, retry; one created point/consumed kit/activation; no global active flag. |
| V7 Recovery | Active point, reactivation, missing ID, blocked emergence, remote empty-space placement, fuel exhaustion and explicit fallback; complete motion/camera/physics reset. |
| V8 Wrecks | Cargo-only, fuel-only, consumable-only, mixed; cargo/tank/stack capacity and overflow; protected allowance excluded; repeated deaths, date/frame changes, reload/export/import. |
| V9 Transit | Moving destination; blocked Earth route; abort during spool/acceleration/deceleration; low budget/heat; resource prediction versus execution. |
| V10 Save migration | v1 current fixtures, multi-player union, retired IDs, paid active research, dead/remote pose, legacy wreck, malformed fuel/point values, repeated parse, world switching. |
| V11 Lifecycle | Loading/settings/death pause, stopped frameloop, tab-away/resume, simRate changes, world unload, old-save continue; no offline catch-up. |
| V12 Live loop | Scan → mine → process → research → craft/equip → transit → recover site → place point → die → restore → recover cargo/fuel → reload. |
| V13 Performance | Named M2/M3 baseline scenes with `--perf`, same settings, nearby/distant saved-point counts; per-pass CPU/GPU results. |

Live tests must exercise the accepted public gameplay actions, not only inject a final
state that skips manufacturing/death transitions. Use isolated fixtures for boundary
cases, then at least one normal-input/UI path for the player flow. The driver defaults
to benchmark isolation, suppressing persistence/comms: use `--no-isolate` for live save
and hint checks, in a disposable world, restoring the user's active world afterward.
That protects ordinary gameplay tests, not fixtures that wipe the whole database.

**Destructive fixture boundary:** the existing save-check `fresh` and `legacy` groups
delete the entire `stellar-nomad` IndexedDB database and legacy keys. Never run their
default/full suite against a valued profile, even with a disposable world selected.
Use a truly disposable driver profile/origin, or first export every valued world and
preserve any other affected profile data. The driver currently reuses
`.captures/.chrome-profile`; `--keep` does not isolate its worlds and `--fresh` wipes it.
Do not silently wipe or move that profile. Re-read shell/physics/new harness fixture
setup for equivalent destructive operations before running them. New M3 live gates
should create/delete only their own disposable worlds wherever possible.

Regression commands, after implementation and with the dev server available:

```bash
pnpm lint
pnpm typecheck
FLIGHT_PARTS=sim,live,mouse,camera,reticle pnpm drive -- --keep run:scripts/drive-examples/flight-trace.mjs
FRAMES_PARTS=ride,switch,asteroids,transit pnpm drive -- --keep run:scripts/drive-examples/frames-check.mjs
SAVE_PARTS=roundtrip,reload,isolation pnpm drive -- --keep --no-isolate run:scripts/drive-examples/save-check.mjs
SHELL_PARTS=title,continue pnpm drive -- --title run:scripts/drive-examples/shell-check.mjs
```

Run `SAVE_PARTS=fresh,legacy` separately only within the destructive fixture boundary
above. The listed roundtrip/reload/isolation groups still mutate data: use disposable
test data, and inspect their current setup rather than assuming they are read-only.
Update old gate expectations where the M3 schema intentionally changes, preserving
the original behaviours they protect instead of dropping failing coverage.

Run the completed M2 physics gate command as recorded in its as-built plan; inspect
the actual script/options rather than inventing them here. Then run the new M3 harness.
Chrome driving requires an unsandboxed execution context, as documented in
[AUTOMATED_TESTING.md](AUTOMATED_TESTING.md). Do not run `pnpm build` inside the sandbox;
the repository prohibits that. Validate production build through the project's suitable
build environment/CI when available and report a missing build check honestly. Lint
success means **zero errors**; the existing warning baseline is not an error count.
If audio paths are touched, run `pnpm check:audio` and browser `__audio.selftest()`;
run workshop/lifecycle checks only where relevant to those changes.

Manual playtest, in a fresh Standard world:

1. Find a fuel source using the baseline scanner; understand the result without a hint.
2. Produce fuel and repair a small M2 impact with locally gathered material.
3. Choose a survey or extraction investment and explain its benefit/tradeoff from the UI.
4. Prepare a lunar journey, understand the reserve/obstruction display, and arrive safely.
5. Recover the orbital survey item, establish and name a replication point, and explicitly
   reactivate an older one once to verify selection is understandable.
6. Operate entirely in the lunar region: fuel, repairs, equipment, another kit. No Earth return.
7. Destroy/abandon the ship carrying identifiable cargo and ordinary fuel. Restore at the
   selected point and recover the stores partially, then completely. Reload while dead
   and again after collection.
8. Exercise an isolated point and zero-fuel case; verify the emergency fallback is visible
   and does not reproduce salvageable startup fuel or erase permanent progression.

## 12. M3 release criteria and remaining decisions

- Fresh-save progression demonstrates the complete loop within a normal play session.
  Initial pacing target: first useful choice within minutes, first prepared lunar visit
  within roughly 60–90 minutes; tune through actual play, not forced delays.
- At least two early equipment priorities work and produce distinguishable advantages.
- At least one resource constraint forces a meaningful, understood decision.
- A player can relocate to the lunar region and remain self-sufficient indefinitely
  on practical play timescales without returning to Earth or exhausting one unique cache.
- The lunar site offers a different interaction and useful optional result.
- Destruction, zero fuel, isolated/missing checkpoints, partial salvage, and reloads are
  recoverable and obey the no-duplication rules.
- Knowledge/permanent equipment/archive survive. No archive care or mandatory campaign.
- Migration and export/import preserve actual progress; no hidden second research writer.
- M0/M1/M2 regressions pass or a specific pre-existing exception is recorded; new issues
  are not disguised as baseline. Performance is measured at named scenarios.

Before starting each relevant phase, set the tuning table values for recipes, power,
heat, capacities, range, protected allowance, placement distances, and difficulty.
They are implementation defaults, not reasons to re-open the agreed concept or ask
permission for every number. Record significant playtest-driven rule changes here.
Exact catastrophe, archive biology, future drives, station/drone design, and colony
mechanics remain deferred as listed in the companion decision document.

## 13. As-built log

### 13.1 Delivery split (owner decision, 2026-11-16)

M3 ships as two pull requests:

- **PR 1** (`m3a-survival-core`): M3.0, M3.1, M3.2, M3.5 — ownership, transactions and
  migration; propellant, power, heat, processing, repair; fuel-aware transit.
- **PR 2**: M3.3, M3.4, M3.6, M3.7, M3.8 — discovery research, equipment rework,
  replication points and full recovery, lunar opportunity, guidance, difficulty, end-to-end.

Consequences for PR 1: the old research catalogue, assay samples and research timer stay the
gameplay until PR 2 replaces them; recovery after destruction stays "respawn at the starting
position" until PR 2 adds replication points. The research/item retirement mapping (§7.3) is
PR 2 work. M3.1's "evidence/discovery ownership" is therefore only research completion today.

### 13.2 M3.0 / M3.1 as built (2026-11-16)

**Save schema 2** (`src/save/types.ts`, migration `MIGRATIONS[0]` in `migrations.ts`):

| Slice | Owner | Shape (units) |
|---|---|---|
| `world.research.completedNodes` | world, authority-only writer | string[], completion order; unknown ids kept, inert |
| `world.receipts` | world | `{opId,type,by,at}[]`, oldest first, bounded to `MAX_RECEIPTS` = 256 |
| `world.wrecks[].fuelKg` / `.consumables` | world | kg ≥ 0 / itemId → integer count |
| `player.research` | player (until PR 2) | `{assaySamples, activeResearch}`; no `completedNodes` |
| `player.propellant` | player | `{ordinaryKg, protectedKg}`, kg, finite, ≥ 0, ≤ 1e6 |
| `player.power` | player | `{capacitor01, heat01}`, fractions of the equipment stores |
| `player.processing` | player | `null` or `{id, recipeId, reserved, elapsedS, committedKg}` |

Tuning defaults (`src/sim/ship/shipResources.ts`, owned by M3.2): tank 600 kg, protected
allowance 60 kg. New and migrated players start full, capacitor 1, heat 0, no batch.

**Legacy mapping for PR 1 (schema 1 → 2):**

| Schema 1 | Schema 2 |
|---|---|
| `players[*].research.completedNodes` | union into `world.research.completedNodes` (first-seen order, players in key order); removed from players |
| `players[*].research.{assaySamples, activeResearch}` | unchanged, per player (paid active research kept running) |
| `world.wrecks[*]` | + `fuelKg: 0`, `consumables: {}` |
| (none) | `world.receipts: []`; per player full tanks, `power {1, 0}`, `processing: null` |
| everything else (poses, cargo, modules, deltas, comms, AI name, markers, dead state) | unchanged |

Sanitisers tightened alongside: cargo/consumable/wreck counts are floored integers ≥ 1
(zero, negative, non-finite dropped); fuel non-finite → default, negative → 0; assay
samples, mined lifetime ≥ 0; owned modules and completed research de-duplicated. The
legacy-localStorage importer now builds schema-1 data and runs it through the same migration.

**Authority API** (`src/sim/world/`): `Authority.submit(op: WorldOperation, by): OperationOutcome`
and `subscribe(listener)`. Outcomes: `accepted` (with typed `result`), `rejected` (`reason`,
optional `missing`), `duplicate`, `pending` (reserved for M4). Every submit ends with an
`op.settled` event after its state events; `player.changed {playerId, keys}` tells mirrors which
player slices were replaced. Operations: `asteroid.destroy`, `asteroid.mine`, `item.craft`,
`research.start`, `research.complete`, `research.devSet` (dev), `ship.destroy`, `ship.respawn`,
`wreck.collect`, `time.set`. Reducers (`reducers.ts`) validate every slice and return a commit
of plain assignments. UI uses `runOperation(op, onSettled)` (`src/store/operations.ts`) and
grants feedback only from the settled outcome. Duplicate protection: receipts for retryable
transfers, plus durable state (destroyed asteroid, dead flag, completed node, inactive timer).
After a receipt is evicted (256 later operations) a craft or wreck collection retried with
that id would apply again; no caller retries that late.

**Atomicity / no stale overwrite:** a submit validates, commits to the in-memory record,
refreshes the local player's saved atoms from the record (`refreshPlayerAtoms`) and publishes,
all in one synchronous task. A save flush (collectors included) only runs as its own task, so
it sees the record before or after an operation, never between steps, and the sampled atoms
(hull) already hold the post-operation value. Accepted receipted operations request an
immediate flush (`markDirty(true)`): MEASURED, with the 1 s debounce a reload right after an
operation lost it, because the pagehide flush's IndexedDB write is aborted by the unload.

**Effective config:** one pure fold (`src/sim/ship/loadout.ts`) used by the HUD atoms and the
authority (cargo capacity, respawn hull). Research bonuses come from the world record once.
The authority trusts the miner's reward claim (`buildMineOperation`) and the research timer's
`elapsedS`, and does not check wreck distance; a remote M4 authority must re-derive them.

**Behaviour changes vs pre-M3** (review, 2026-11-16; owner to confirm): crafting, mining
rewards and wreck collection are rejected while dead (`dead`); a rock finishing its mine in
the death frame stays intact. `ship.respawn` carries the recovery pose and commits it with the
alive state (the pose collector is held until the teleport lands). A `research.complete` for a
node another player already finished refunds the paid assay samples. An already-empty wreck is
removed on collect. Reducers are pure: the authority passes `now` in. Cargo, wreck and
consumable counts are whole units: a fractional v1 value is floored on migration (pre-M3 code
already floored on add and on use, so no playable unit is lost), and `ship.destroy` moves
exactly the floored amounts it clears.

**M2 facts later phases need:** `nearField.resolve(ship, serial)` runs after every `stepShip`
fixed step (one owner per step, asserted); `nearField.markReseed()` must follow any teleport /
respawn / external reposition; the near field is suspended above `PHYSICS_MAX_SPEED_KMPS` =
0.9 km/s, in transit, under the dev speed override and while dead (`setGates`); fatal impacts
call the death operation through `dieAtom`.

**Pause signals:** `src/sim/simPause.ts` (loading gate only), `settingsIsOpenAtom` (Settings
also stops the R3F loop: `frameloop="never"`), `isDeadAtom`, bench `__test.isolate()` (no save
writes). Tickers using `useFrame` stop with the loop; timers outside it must check all of these.

**Baseline timings** (`pnpm drive -- --keep --perf bench:belt,earth_650`, 1280×720, DPR 1,
headless M2 Pro Metal; GPU ms, P50), before → after the M3.1 change (no render change; the
spread is run-to-run noise):

| Scene | frame P50 | GPU P50 | atmosphere | atmo apply | cloud march | reconstruction | composite | local scene | post |
|---|---|---|---|---|---|---|---|---|---|
| belt | 14.7 → 14.5 | 12.56 → 8.66 | 2.50 → 1.64 | 2.56 → 1.69 | — | — | — | 0.60 → 0.41 | 5.25 → 3.66 |
| earth_650 | 16.6 → 16.7 | 21.78 → 26.07 | 2.94 → 3.35 | 3.19 → 3.63 | 2.76 → 3.20 | 3.03 → 3.52 | 3.36 → 3.86 | 0.37 → 0.41 | 3.46 → 4.33 |

**Gates:** `scripts/drive-examples/gameplay-check.mjs` (parts `migrate,tx,shared` and `live`,
`--no-isolate`) works in disposable `[gc] ` fixture worlds, restores the previously active world
and deletes only its fixtures. Hooks: `__test.gameplay` (submit as any player, read slices and
mirrors, pure `parse`, fixture create/export/import/remove, mine/craft/kill via the game's
actions).

### 13.3 M3.2 as built (2026-11-16)

**One resource step** (`src/sim/ship/resourceStep.ts`, pure, no allocation): `stepShipResources`
runs inside Spaceship's fixed 120 Hz loop right after `stepShip` (so loading pause, settings
`frameloop="never"`, death and the 0.25 s frame-delta cap gate it exactly like flight; `simRate`
never reaches it). Order per step: propellant meter → capacitor → reactor arbitration → heat →
granted work (mining seconds, processing kg, repair percent). The runtime state is a store
singleton (`src/store/shipResources.ts`): it owns fuel, heat, capacitor and the batch between
operations, a collector samples it into the record, `runOperation` samples every collector
before submitting (`sampleCollectors`) and `adoptShipResources` takes committed `propellant` /
`power` / `processing` slices back on `player.changed`. UI reads `shipResourcesHudAtom`
(published at the 10 Hz HUD cadence, not in bench mode).

**Control demand:** `stepShip` now writes the delivered body-axis Δv (`ctlDvF/R/U`, after every
clamp) and |Δω| L1 (`ctlDwRadps`); `env.thrustScale` scales every translational limit and
`env.angularScale` the angular acceleration. Cost = 0.008 kg per m/s of L1 Δv + 0.02 kg per
rad/s of Δω; a step under 1 mm/s is chatter and free. Contacts, frame switches, ephemeris and
transit velocity are outside `stepShip`'s thrust and cost nothing; the dev speed override is not
charged. Ordinary first, then protected. `propellantGate` scales thrust to what the tank can
pay for the worst-case step, so a store never goes negative; at zero, thrust is 0 and rotation
keeps 25 % authority free (attitude wheels), velocity untouched. Transit: `shipReq.transitKgPerS`
is charged by the step and set to 0 until M3.5.

**Power, capacitor, heat:** capacitor = M1's `boostCharge` (stepShip still drains/refills it;
the step only mirrors it and charges 10 kW while it refills). Reactor 100 kW: essential 20 kW
first, capacitor next, then mining 50 / processing 45 / repair 15 kW pro rata (mining +
processing → 0.84 each, output too). One thermal store, 1000 kJ = 100 %, inputs mining 171.9,
boost 144.9, processing 97.1, repair 10 kW, rejection 77.1 + 50 × heat kW (the two terms are what
make mining alone 0 → 100 % in 15 s and idle 100 → 0 in 10 s, and processing alone settle near
40 %). Warning 80 %; processing and repair throttle linearly 90 → 100 %; the mining laser trips at
100 % (today's overheat, now `shipRes.miningTripped`, cleared once the beam is off and heat <
100 %); only boost can push past 100 %, and hull damage (2 %/s) starts after 2 s above it.
Equipment heat modifiers scale mining input (15 / `miningHeatCapacityS`) and rejection
(10 / `miningCooldownS`). Heat-sink consumables write the same store. MiningSystem no longer
integrates heat or progress on render delta: it requests the beam and advances progress by the
granted beam seconds.

**Processing** (`PROCESSING_RECIPES` in `content.ts`, no research gate): `processing.start`
reserves 1–50 hydrate units out of cargo (rejects busy / tank_full / materials); the step
delivers 10 kg/s × throttle (4 kg per unit) straight into the ordinary tank and `committedKg`,
pauses with a reason when the tank is full, completes once. `processing.cancel` returns only
units whose conversion has not started (`unconvertedUnits`), keeps committed output, rejects
`no_capacity` if the cargo cannot hold the refund. Progress is sampled with the pose (2 s save
tick), so a hard reload resumes from the last write: never a duplicate, never a catch-up.

**Repair:** manual (2 %/s) or automatic with the Nanite Repair module (its 0.2 HP/s rate), both
through `ship.repair {pct}`: 1 fe_ni_metal per percent, stops at max hull or when material runs
out (reason line), refused with a reason when it cannot start. Not receipted (two per second would
evict the bounded receipt log); callers never retry it. **Free regeneration removed:**
`HullRegenTicker` is deleted; the Nanite module's `hullRegenPerSecond` now only drives paid
repair. Chosen over retiring the module because it keeps an owned item meaningful without a
free stat. Patch kits stay: their material is paid at craft time.

**Loss:** `ship.destroy` (impact and `cause: "abandon"`) also moves the ordinary tank and the
batch's unconverted feedstock to the wreck (protected never), clears the batch; `ship.respawn`
sets ordinary 0, protected = `recoveryAllowanceKg`, power {1, 0}, no batch. Emergency
abandonment: Settings main menu → "emergency: abandon ship" → confirmation listing the loss →
the same death operation (reachable at zero fuel; the settings menu needs no flight).

**Tuning** (`src/sim/ship/resourceTuning.ts`, Settings → Dev → ship resources, persisted as
`dev-resource-tuning-v1`): tank 600 kg, allowance 60 kg, 0.008 kg/(m/s), 0.02 kg/(rad/s),
deadband 1 mm/s, exhausted angular 0.25, reactor/loads/heat as above, heat max 130 %, processing
4 kg/unit, 10 kg/s, batch ≤ 50, repair 2 %/s, 1 unit per percent. All values are defaults.

**Measured** (gameplay-check `res,m32,reach`, `--no-isolate`; pure parts run the real
`stepShip` + step at explicit 30/60/144 Hz pacing):

| Gate | Result |
|---|---|
| idle / coast 60 s (decoupled, and coupled at its set-point) | 0 kg exactly; live parked 8 s: 0 kg |
| axes | main 240 m/s → 1.92 kg; strafe X/Y 120 → 0.96; retro/brake 200 → 1.60; grip turn 211 m/s → 1.69 kg; 180° yaw 0.038 kg = 0.32 % of a hop |
| scripted hop (0 → 402 m/s, 90° turn, brake) | 1563 m/s, 12.54 kg vs 12 kg target (+4.5 %); 47.8 hops per tank, 4.8 in the allowance |
| 30 / 60 / 144 Hz, 0.25 s hitch | bit-identical finals (2900 steps each); 2 s hitch drops 1.75 s wall time, stores unchanged |
| bounce / frame switch | decoupled bounce 0 kg; Earth SOI crossing 0 kg; the assist cancelling a 30 m/s bounce is thrust: 0.24 kg |
| exhaustion | protected touched only at ordinary 0; both reach exactly 0; thrust gate 0; speed held 250.17 m/s |
| boost | capacitor trace identical to `__test.flight.simulate` (2280 samples): empty 5.0 s, refill +1.5 s, full +9.5 s; 5 s boost → heat 30 % |
| reactor | alone: 5.0 beam-s, 50 kg in 5 s; together 0.842 each, output 42.1 kg |
| mining-only heat | trip 14.99 s (15), 100 → 0 % in 10.0 s (10) |
| ladder (from 70 %, mining + processing + boost) | warn 0.39 s < throttle 0.80 s < laser trip 1.28 s < >100 % 1.28 s < damage 3.28 s (2.9 s window) |
| essential control | thrust identical with every load on at 120 % heat |
| live batch | partial cancel refund = 20 − ⌈15.25/4⌉ = 16; tank full stops at 600 kg with reason, cancel returns 7; settings / loading pause: nothing moves; 3 s stall executes 31 steps (≤ 0.25 s); simRate 1e4: 8.42 kg/executed s |
| reload / death | ordinary − committed invariant (100 kg) across reload; 260 kg final, once; death wreck = live ordinary (210.08 kg) + unconverted feedstock, protected excluded; recovery 100 % hull, 0 / 60 kg |
| repair | refused without Fe-Ni (reason); 12 units → 50 → 62 % then stops "no Fe-Ni"; → 100 % stops with 62 left; Nanite: 0 % in 4 s without material, 1 % per unit with it |
| emergency (zero fuel, 40,000 km out) | thrust held 1.5 s: 0 m/s; confirm lists loss; wreck = cargo, 0 kg fuel; recovery 100 %, 0 / 60 kg |

**Starter reach** (`__test.gameplay.res.starterReach`, repeatable; world seed still unused): from
the start, 18,409 rocks loaded, 10,286 with ≥ 1 hydrate unit; nearest 6.5 km (1 unit, 15.0 s
mine: trips a cold laser), nearest cold-mineable 9.8 km (1 unit), richest within 25 km 19 units
at 23.9 km (r 165 m, 10.3 s). Live proof (`reach`): recover with 0 / 60 kg, fly 22 km in 62 s
for 6.44 kg of protected fuel, mine 19 hydrates in 10.5 s (heat 74 %), process to 76 kg ordinary.
No starting-offset or allowance change needed: coasting is free, so the allowance buys ~5 hops of
any length. **Next phases must know:** hydrate yields are thin (s/x-type rocks give 0–1 unit; rocks
over ~300 m cannot be mined from a cold laser because extraction time caps at 18 s), so PR 2's
content pass should author hydrate-rich targets rather than rely on rolls.

**Deviations:** the 90 % throttle applies to processing and repair; the mining laser keeps its
100 % trip (that IS its throttle) so mining alone behaves as before. Starter crafting recipes stay
behind the old research catalogue (owner decision for PR 1), so the third M3.2 checkbox stays open;
processing and repair need no research. Recovery is still the starting position (PR 2).
Dashboard and comms overlay overlap at 390 px width as before (compacted to two pairs per row).
`save-check` was run with `SAVE_PARTS=roundtrip,reload,isolation` only (fresh/legacy wipe the
profile). Perf (`--perf bench:belt`, 1280×720): frame P50 14.4 ms (baseline 14.7 → 14.5), GPU
11.12 ms, local scene 0.51 ms: within run-to-run noise of §13.2.

**Review fixes (2026-11-16).** Mining heat modules: multipliers now act on mining's *net* rise
and on idle cooling only (`miningQ = hm·(Q − rej) + cm·rej`, identical to before at 1/1), so the
pre-M3 law holds per module: trip 18.74 / 23.07 / 16.66 / 28.83 s for ×0.80 / ×0.65 / ×0.90 /
×0.52 (expected 18.75 / 23.08 / 16.67 / 28.85), cooldown ×1.30 cools in 7.69 s and leaves the
trip at 15 s (gate `v2_miningHeatModules`). Sub-deadband Δv is carried and charged once it
reaches 1 mm/s, not dropped (0.05 % throttle for 60 s: 3.6 m/s, 0.0288 kg; `v1_deadbandCarry`).
Boost needs a non-zero thrust gate: an empty tank spends no capacitor and adds no heat. The dev
speed override is never gated. Respawn (any adopt of `power`) drops heat damage and repair still
due from the dead ship. At ≤ 520 px the comms overlay sits above the dashboard; the cargo bar
under the top panel buttons at 390 px predates M3 (HUD/CargoHUD untouched) and stays open.

### 13.4 M3.5 as built (2026-11-16)

**One transit model on executed time** (`src/sim/ship/transitDrive.ts`, pure, no allocation in the
step): `stepTransit` runs first in Spaceship's fixed 120 Hz loop, then `stepShip` adds its speed
along the nose (`env.transitVel*`, steering ×0.6, autopilot heading override as in M1), then
`stepShipResources` bills it. The render-delta integrator is gone; `TransitTicker` only mirrors
phase changes into `transitStateAtom`, turns step events into toasts and refreshes the preview at
4 Hz. Phases: idle → spooling (3 s = 360 steps) → accelerating / coasting / decelerating → idle.
The near field is suspended while the drive carries speed (gate set per step).

**Speed law** (`transitLaw`, shared by execution and `predictRoute`): per step, accelerate (800 km/s²)
while the remaining distance still allows the *discrete* stop and the fuel left after the step still
pays for that stop × (1 + 2 %); else coast; else brake. Braking is never heat-throttled; acceleration
uses the processing/repair throttle (90 → 100 %). A braking leg re-accelerates only on 4 steps of slack
(a receding target), and within 3 × peak × dt of its aim it brakes to rest (`arriving`). A float
residue of the summed brake steps snaps to 0 (it otherwise coasted at 1e-14 km/s forever).
Prediction = the same law, spool heat, heat law (`heatAfter`) and spend order rolled out in 1D; a
moving aim uses a 3-pass intercept on the aim frame's velocity × simRate. Assumption shown in the
HUD: "assumes no detours or mining".

**Fuel and reserve.** 0.006 kg per km/s of delivered drive speed change (accelerating and braking),
billed through the M3.2 hook (`req.transitDvKmps`) before manoeuvring thrust. While the drive carries
speed, `propellantGate` withholds `speed × 0.006 × 1.02` kg from manoeuvring, so braking can always be
paid; braking falls back to the protected allowance only if ordinary was taken by something else.
Acceleration plans with ordinary fuel only: **zero ordinary refuses** ("the protected allowance is for
manoeuvring"); a trip predicted over 10 min refuses ("too little propellant"). Fuel-limited legs cap
the peak speed and coast. Abort (T during a burn, T between legs) = brake to rest; releasing T in the
spool cancels free. Steering off autopilot during a burn continues manually (braking if it was braking).

**Route.** `planRoute`: if the first body (other than the target) enters the line's clearance sphere
(2 R, shrunk to a leg end that sits inside it, never below R + max(2 % R, 200 km)), ONE waypoint is
placed beside it (pushed out through the line's closest point, 1.05 × 2 R, growing ×1.15 until both
legs are clear); a second blocker refuses. Each leg stops at rest; the next spools automatically.
Waypoints ride the blocker (live base + offset), arrival standoffs ride the target. The ordinary fuel
is split between legs by ideal cost (∝ √distance) at each leg start; the predictor does the same.

**Tuning** (resource table, Settings → Dev): `transitKgPerKmps` 0.006, `transitReserveMargin` 0.02,
`transitSpoolHeatKW` 120, `transitBurnHeatKW` 95 (at full drive acceleration), `transitMaxTripS` 600,
`transitRouteClearanceRadii` 2. **Changed M3.2 value:** `processingKgPerUnit` 4 → 20 (a tank is 30
units; full tank still 60 s at 10 kg/s). M3.2 gates now read kg/unit from the table (the lifecycle /
reload batch is 8 units = the same 160 kg as before).

**Other changes.** Gaze targeting picks the POI nearest the nose (in the default-epoch eclipse the Sun
sat behind the Moon and won the focus box). The POI marker ETA is the predictor's. Transit HUD:
plan panel (ETA, fuel, on arrival, protected reserve, warnings: clearance route, low-fuel coast,
refusal reason) before engaging and during the trip, top-right below the menu buttons. Audio: the
engage cue plays only out of the spool; `coasting` counts as in transit. Arrival comms keep the
destination on the arrival frame (it was cleared before, so `lunar_arrival_001` could not fire).

**Measured** (gameplay-check `transit`, `transitLive`, `transitShots`; live at 1280×720):

| Gate | Result |
|---|---|
| straight 1,000 / 50,000 / 380,000 km (pure) | ETA 5.24 / 18.82 / 46.59 s pred = exec; fuel 10.72 / 75.84 / 209.2 kg pred vs 10.68 / 75.80 / 209.2 exec (≤ 0.4 %); 380,000 km = 34.9 % of a tank, peak heat 33 % |
| moving target, 1.02 km/s × rate (pure) | rate 1: 46.39 s, 208.24 kg, exact; rate 100: 46.39 vs 46.43 s, 208.24 vs 208.20 kg |
| blocked line (pure) | 2 legs via Earth, 60.28 s, 260.5 kg, heat 35.2 %, min Earth distance 13,345 km (sphere 12,742) |
| partial fuel 80 kg | coasts 49.3 s, 68.83 s (ideal 46.59), arrives at rest with 0.79 kg ordinary = predicted, protected untouched |
| refusals | 5 kg: "trip would exceed 10 min", nothing spent; 0 ordinary / 60 protected: refused, protected untouched (also manual) |
| abort | spool 0 kg; accel at 3,200 km/s 38.36 kg (2·v·c = 38.4); coast at 9,901 km/s 118.8 kg; decel; all end at rest, billed = transit meter, ordinary ≥ 0 |
| pacing | 7,234 steps, bit-identical at 30 / 60 / 144 Hz, 0.25 s hitch and 2 s hitch (1.75 s dropped) |
| hot start 97 % | 19.06 s (cold 18.82), arrives at rest |
| Earth → Moon live, 2024-04-08 18:17 (default) | real gaze lock + T key; via Earth, 2 legs; ETA 56.19 s / fuel 240.8 kg / heat 34.9 % pred = exec; arrival 3,474.5 km from Luna's centre (standoff 3,474) in Luna's frame; min Earth distance 13,159 km; near field suspended ×2, re-seeded ×2, 0 owner violations |
| Earth → Moon live, 2024-04-22 06:00 | direct (not blocked); 47.13 s / 211.76 kg / 33.1 % pred = exec; arrival +0.11 km |
| same at simRate 100 | 47.12 vs 47.13 s, 211.68 vs 211.76 kg, arrival −7.8 km, Luna frame |
| Moon side | 0 rocks at the Earth-side standoff; hop to the Lunar belt field: via Luna, 24.28 s / 87.6 kg pred = exec; there 120,055 rocks, 33,433 with hydrates, nearest 1.8 km (2 units), a 90-unit rock at 3.0 km (18 s mine: trips a cold laser); mined 2 units → processed +40 kg |
| lifecycle mid-leg | settings / loading pause: speed, distance, fuel, heat, steps frozen; 3 s stall: 32 steps; death ends the leg at idle, nothing billed while dead |
| sweep | 5 km/s (dev speed) into Luna from 20 km: destroyed at 0.15 km altitude |

**Regressions** (page reloaded between scripts): flight-trace `sim,live,mouse,camera` all pass;
physics-check `sim,damage,asteroids,transit` all pass (transit: suspended "transit", 2 re-seeds, 0
owner violations); frames-check `ride,switch,transit` (transit now has a pass: arrival 0.1 km off
the standoff, Luna frame); gameplay-check `migrate,tx,shared,live,res,m32,reach,transit,transitLive`
pass; save-check `roundtrip,reload,isolation` pass; shell-check `title,continue` pass. Perf
(`--perf bench:belt`, 1280×720): frame P50 14.8 ms, GPU 11.69 ms, local scene 0.50 ms (M3.2: 14.4 /
11.12 / 0.51): run-to-run noise; transit adds no render work.

**Deviations / notes for later phases.** Heat "≈ 35 % for Earth → Moon" is the store's PEAK with
rejection running (33 % direct, 35 % via the clearance leg); a long burn levels off near 36 %, so
transit alone never throttles. The protected allowance never accelerates the drive (it is braking
backstop only). The default-start direct line to the Moon passes 11,050 km from Earth's centre, outside
the old 6,571 km auto-brake sphere but inside the 2 R clearance sphere, so the route uses a clearance
leg; at the second date (2024-04-22) the line is clear. With a 600 kg tank the 10 min cap refuses Mars
(≈ 3,000 kg at closest approach) and every star marker (the pre-M3.5 drive reached them); a manual
transit (no target) is still unbounded in range, capped in speed by the braking reserve (≈ 49,500 km/s
from a full tank). The Moon standoff faces the arrival direction; the lunar field sits behind the Moon
(reached by a second, Luna-cleared hop). The predictor assumes no manoeuvring thrust and no other heat
loads during the trip. A receding aim (no frame of its own) is reached within 3 × peak speed × dt.

**Review fixes (2026-11-16).** (1) A start inside a body's hard sphere (low orbit, respawn) is
routable when the leg only recedes: the clearance radius is capped at the start distance. (2) While
a leg runs, manoeuvring thrust spends ordinary above the braking reserve, then the protected
allowance, and touches the reserve only with sub-deadband carry; gate `b_strafeCoast` strafes
through the 80 kg coast: transit billed 79.204 kg = 2·c·peak, manoeuvring 1.28 kg from protected.
(3) The dev speed override flies transit unbilled and uncapped by fuel (no empty-tank refusal).
(4) A leg ending, an abort or a reset with T held needs a fresh press. (5) Pacing invariance is
exact for static aims; a moving aim is resolved once per render frame (the ephemeris runs per
frame), so at high sim rates pacings differ by a few km of miss distance, inside the arrival
tolerance. (6) The preview refuses out-of-range targets from an analytic bound (d / fuel-capped
peak > 1.1 × max trip) before any rollout, and the intercept passes stop on a timed-out leg.
(7) Refusals are worded by cause: "Out of range for this tank: … needs about N kg" on a full tank
or when N > tank, else "Too little propellant: … needs about N kg". (8) "Already at the
destination" hides the plan panel and raises no toast. (9) A leg stopping short names its cause
(obstruction, drive too hot, out of propellant). (10) Fuel deviation: the default-epoch Earth → Moon
trip goes via the clearance leg and costs 240.8 kg = 40 % of a tank, not the ≈ 35 % of the direct
380,000 km leg (34.9 %); tuning left at 0.006 kg per km/s, PR 2 balances against the 40 %.

### 13.5 M3.3 / M3.4 as built (2026-11-16)

**Save schema 3** (`MIGRATIONS[1]`, frozen tables in `src/save/legacyMap3.ts`):

| Slice | Owner | Shape |
|---|---|---|
| `world.research` | world, authority only | `{completedNodes, legacy}`: unlocked options in order; unmapped pre-M3.3 ids kept inert |
| `world.discoveries.families` | world | material → `{firstAt, by, inspected, extracted, sourceId}`; recorded once, flags only turn on |
| `world.discoveries.sources` | world | inspected rocks, stable id `fieldId:chunkKey:asteroidId`, frame-relative pose (field anchor body), class, composition estimate, `depleted`; bounded `MAX_SOURCES` = 64 (evicts oldest depleted, then oldest not bookmarked by the inspecting player) |
| `world.discoveries.trials` / `.sites` | world | id → `{at, by}` |
| `player.research` | removed | assay samples and the timer are gone |
| `player.legacy` | player, inert | `{assaySamples, activeResearch, items, consumables, notes}` or null; never read by gameplay |
| `player.bookmarks` | player | `{sourceId, name}[]`, ≤ 24 |

**Operations.** `survey.inspect` (scanner claim built by `buildInspectOperation` from the same generator mining uses; a known source → `already_done`), `research.unlock` (pure `evaluateNode`; rejects `evidence` with the missing requirement keys, `materials` with the analysis shortfall; spends the analysis and unlocks in one commit), `trial.record` (client-detected trials), `site.record` (range-checked, M3.7 stub), `bookmark.set`. `asteroid.mine` confirms families by extraction (≥ 3 % of the yield) and marks an inspected source depleted (the finding stays); `asteroid.destroy` also depletes; `item.craft` records `first_fabrication`. `research.start` / `research.complete` and `ResearchTicker` are deleted: no writer of the old timer exists, the assay award is gone from `asteroid.mine`. All new ops except `bookmark.set` are receipted.

**Inspection.** Broad indication = the existing target lock (class always shown; composition bands with a survey module). Close inspection: lock, then Inspect (G, rebindable, or the HUD button) for 4 s within 2.5 km (× module multipliers); no consumable. The HUD then shows composition and a yield estimate (× extraction efficiency) for that rock from the world record. Trials detected client-side: `first_batch` (processing completion), `sustained_beam` (8 s of continuous granted beam on one rock without a trip, `settleShipResources`), `transit_leg` (TransitTicker arrival).

**Research/recipe matrix** (`src/data/content.ts`; all numbers tuning defaults; research grants blueprints only, no passive stats):

| Option | Branch | Evidence (all / any) | Analysis | Unlocks |
|---|---|---|---|---|
| sv1 Composition Survey | survey | silicates, Fe-Ni, hydrates confirmed by inspection | 10 silicates | Prospector Scanner Mk1 |
| sv2 Volatile Mapping | survey | sv1; inspected C-type and X-type; carbon | 2 hydrates, 2 carbon | Ping Array Mk1 |
| ex1 Controlled Extraction | extraction | Fe-Ni; trial sustained_beam | 15 Fe-Ni | Beam Focuser Mk1 |
| ex2 Yield Analysis | extraction | ex1; sulfur / any: carbon or inspected C-type | 2 sulfur | Yield Extractor Mk1 |
| th1 Heat Rejection | thermal | trial sustained_beam; silicates | 15 silicates | Radiator Strips Mk1, Coolant Circulator Mk1 |
| lg1 Bulk Handling | logistics | trials first_batch, first_fabrication | 10 Fe-Ni | Cargo Rack Mk1, Auxiliary Tank Mk1, Electrolysis Cell Mk1 |
| pr1 Transit Drive Calibration | propulsion | hydrates; trials first_batch, first_fabrication | 2 hydrates | Interplanetary Transit Drive |
| pr2 Thruster Tuning | propulsion | pr1; trial transit_leg | 10 Fe-Ni | Thruster Nozzles Mk1 |
| hl1 Hull Reinforcement | hull | Fe-Ni by inspection; trial first_fabrication | 10 Fe-Ni | Ablative Plating Mk1, Nanite Repair System |
| ln1 Survey Instrument Recovery | lunar (stub) | site luna_survey_canister | none | Integrated Sensor Suite (titanium) |

| Item | Slot | Recipe (units) | Effect |
|---|---|---|---|
| Hull Patch Kit (starter) | consumable | 15 Fe-Ni, 10 sil | +15 HP |
| Heat Sink Cartridge (starter) | consumable | 20 sil, 5 Fe-Ni | −50 % heat |
| Prospector Scanner Mk1 | scanner | 120 sil, 40 Fe-Ni | inspect time ×0.5, range ×1.6, composition bands |
| Ping Array Mk1 | scanner | 150 sil, 60 Fe-Ni, 6 C | ping, range ×2.4, time ×0.75 |
| Beam Focuser Mk1 | mining | 90 Fe-Ni, 80 sil | mining time ×0.7, laser power ×1.3, laser heat ×1.3 |
| Yield Extractor Mk1 | mining | 120 Fe-Ni, 60 sil, 4 S | yield ×1.25, time ×1.1 |
| Radiator Strips Mk1 | cooling | 140 sil, 40 Fe-Ni | laser heat ×0.8, cooling ×1.15 |
| Coolant Circulator Mk1 | cooling | 100 sil, 70 Fe-Ni, 4 C | cooling ×1.4, thermal buffer ×1.25 |
| Cargo Rack Mk1 | cargo | 150 Fe-Ni, 50 sil | cargo +600 |
| Auxiliary Tank Mk1 | cargo | 120 Fe-Ni, 40 sil | tank +400 kg, cargo −500 |
| Electrolysis Cell Mk1 | utility | 80 sil, 60 Fe-Ni, 4 C | processing rate ×1.6 (its power and heat too), reactor +25 kW |
| Interplanetary Transit Drive | special | 160 sil, 120 Fe-Ni, 4 hyd, 4 C | transit |
| Thruster Nozzles Mk1 | propulsion | 150 Fe-Ni, 80 sil, 6 S | accel ×1.15, top speed ×1.2 |
| Ablative Plating Mk1 | hull | 200 Fe-Ni, 100 sil | HP ×1.25, collision ×0.9 |
| Nanite Repair System | hull | 150 Fe-Ni, 80 sil, 6 C | paid auto repair 0.2 HP/s |
| Integrated Sensor Suite | scanner | 200 sil, 80 Fe-Ni, 30 Ti | all scanner bits |

Two first investments: survey (three inspections → sv1) or extraction/cooling (one sustained beam → ex1 + th1). Cargo vs fuel: the cargo slot holds the rack or the tank. **Transit decision:** the drive is unlocked by the short path pr1 (a hydrate family, one processing batch, any fabrication), not available from the start; the old "any three tier-2 nodes" gate is gone. Pulse mining has no item in the catalogue (its He-3 module is retired); the code stays dormant.

**Effective config.** `equipTuning(base, cfg, out)` (`src/sim/ship/loadout.ts`) applies tank, reactor, laser power, processing rate (kg/s, kW, heat), thermal capacity to the resource table; cooling and laser heat stay the M3.2 request multipliers. The runtime (`getShipTuning`, refreshed per frame), the reducers (tank checks, wreck fuel room), the transit predictor and `computeLoadoutPreview` (rolls out `stepShipResources`) all use it. Loadout panel shows the preview; drawback effects render amber.

**Legacy mapping (schema 2 → 3).** Research: r0 → nothing (basic analysis is free); a1, a2b → sv1; a2a, a3 → sv2; b1 → ex1; b2a → ex2; b2b → th1; b3 → th1 + ex2; c1 → lg1; c2a → hl1; c2b → pr2; c3 → hl1 + pr2; m1 → pr1; unknown → `world.research.legacy`. A paid active timer completes its mapped options once; unmappable → `player.legacy.activeResearch`. Items: same id where kept; spectral mapper → prospector; focuser mk2 → mk1; radiator mk2 → mk1; pulse modulator → coolant circulator; cargo rack mk2 → mk1; plating mk2 → mk1; reaction wheels, nozzles mk2 → nozzles mk1; assay enhancer and unknown ids → `legacy.items`. Equipped modules map into their new slot if free. Consumables: heat sink, thermal purge → heat sink; patch kit → patch kit; emergency kit → 2 patch kits; capped at stack size, overflow and retired consumables (assay probe, scanner pulse, composition scan, deep scan, overclock, precision, afterburner) → `legacy.consumables`. Hotbar entries map or clear. Assay samples → `legacy.assaySamples`. No research passive bonuses remain, so none can double. Poses, cargo, deltas, wrecks untouched; discoveries start empty.

**Fuel economics** (tuning table unchanged: 600 kg tank, 20 kg per hydrate unit, 0.008 kg per m/s). 30 hydrate units per tank. Belt bench scene, within 25 km: 29 rocks, 5 C-type, mean 8 hydrate units per C-type (median 6) → 3.75 C-rocks per tank, best cold-mineable 2. All 18,409 loaded starter rocks: 4,630 C-type, mean 13.1 units (median 4) → 2.3 rocks per tank at the mean. 47.8 scripted 1,563 m/s hops per tank (M3.2). Earth → Moon at the playthrough epoch 266–268 kg (≈ 13.4 units; 240.8 kg at the default epoch); Auxiliary Tank (1,000 kg) carries 3.7 such trips. No retune needed.

**Measured** (gameplay-check parts, `--no-isolate`, fixture worlds):

| Gate | Result |
|---|---|
| audit | pass: 10 options, 16 items, no cycles/unreachable/over-capacity/He-3 gate/lunar-only basics/orphans |
| evidence | mining an S-type: 2 families once; second S-type: 0, discoveries identical; C-type inspection: +carbon, +hydrates, 1 source; same rock again `already_done`, same opId `duplicate`; other C-type: new source, 0 families, 0 upgrades, no unlock; mining the inspected rock: depleted, composition kept; identical after death+respawn, hard reload, world switch (other world empty); 200 inspections → 199 accepted, 64 sources, 5 families, 207 receipts |
| reqs | all 10 options: exact evidence unlocks once, retry `duplicate`, new id `already_done`, analysis spent; each of 24 missing pieces rejected `evidence` naming its key, nothing spent; missing analysis rejected `materials` naming the material |
| playA (survey) | 14 accepted ops (3 inspect, 5 mine, 2 unlock, 2 craft, 1 processing, 1 trial); used 290 sil, 160 Fe-Ni, 7 hyd, 4 C; 25.2 kg flown to make tank room; Moon plan ok: 268.2 kg, 61.9 s, 2 legs, 326.6 kg on arrival |
| playB (extraction/cooling) | live sustained beam recorded the trial; 18 ops (2 trial, 9 mine incl. the live one, 3 unlock, 3 craft, 1 processing); used 395 sil, 290 Fe-Ni, 7 hyd, 4 C; 25.2 kg flown; Moon plan ok: 266.0 kg, 61.5 s, 328.8 kg on arrival |
| config | 6 loadouts: preview = resource-sim trip/cool to the step, = hand table (trip 14.99/11.53/18.74/18.74/14.42/18.74 s; cool 10/10/8.69/8.93/8.93/8.69 s; tank 600 or 1000; cargo 2000/1500/2600; reactor 100/125); live table and cargo equal |
| migrate3 | 8 fixtures (v1/v2 × fresh, mid-progression, multi-player, dead remote) pass; export → import data equal and = pure parse; booted v2 mirrors match; 4 invalid imports refused |
| live (adapted) | real scanner inspection via the HUD action in 4.2 s; starter craft without research |

**Adapted older gates.** gameplay-check `migrate` (schema 3 expectations), `tx` (craft the starter patch kit; trial + unlock replace start/complete; mine checks families instead of assay), `shared` (A unlocks, B crafts the shared blueprint; B's late unlock `already_done`), `live` (inspection replaces the timer); save-check `legacy` expectation and `roundtrip` setup (no assay grant).

**Deviations / next milestone.** Inspection range and the trial claims are trusted like the mine claim; an M4 authority re-derives them. The 3 % family threshold means trace sulfur in S-types does not count (the panel says "at least 3 %"). A fresh full tank cannot start a batch, so `first_batch` follows some flying (25 kg in the scripts). Wreck consumables are not remapped (no PR 1 path wrote any). Source eviction protects only the inspecting player's bookmarks. Replication kits (third M3.4 box) wait for M3.6; ln1 and `luna_survey_canister` are data stubs for M3.7 (no marker, no visual); luna_belt's helium-3 fractions are untouched (nothing needs them). Bookmarked sources appear as POI markers; "Set destination" pins the target until another is chosen.

**Regressions** (page reloaded before each script): flight-trace `sim,live,mouse,camera,reticle` 14/14 pass; physics-check `sim,damage,hull,asteroids` pass; frames-check `ride,switch` pass; save-check `roundtrip,reload,isolation` pass (fresh/legacy not run: they wipe the profile); shell-check `title,continue` pass; gameplay-check `migrate,tx,shared,live,res,m32,reach,transit` pass, `transitLive` pass for `defaultEpoch` and `secondEpoch` (`secondEpochRate100` not rerun). Typecheck clean; lint 0 errors (131 warnings); `check:audio` 0 problems (no audio event changed). Perf `--perf bench:belt` 1280×720: frame P50 14.8 ms, GPU 8.02 ms, local scene 0.39 ms (M3.5: 14.8 / 11.69 / 0.50): no regression.

**Review fixes (M3.3/M3.4).** Equip/unequip is now the `module.equip` operation: the authority refuses a loadout that would leave ordinary fuel above the new tank (`tank_overflow`) or cargo above the new hold (`cargo_overflow`), and craft auto-equip only fits when it would not overflow (so the aux tank / cargo rack tradeoff cannot be bypassed by swapping). Source eviction prefers sources no player has bookmarked (depleted first); `bookmark.set` drops bookmarks of evicted sources and does not count them toward capacity, and `parseSaveData` prunes them. `survey.inspect` composition and `asteroid.mine` yield keys must be known material ids (bounds family records to 7; no fabricated families). The `sustained_beam` run restarts when the beam's target rock changes. The `first_batch` hint says the tank needs room. `r0_microlab_boot` stays an explicit mapping to nothing (basic analysis is free), not an inert legacy id. New gate part `fit`: aux tank at 1000 kg → rack/empty refused `tank_overflow`, accepted at 500 kg; full 2600-unit hold → aux/empty refused `cargo_overflow`; forged inspect/mine keys `invalid`; two players' bookmarked sources (one depleted) survive 70 further inspections at the 64 bound while an unbookmarked depleted source is evicted.

### M3.6 — Replication points and complete recovery (as built)

**Kit.** `consumable_replication_kit`: baseline (starter) recipe 150 Fe-Ni + 100 silicates (250 of the 2000-unit starter hold), `stackMax` 3, counted in `ModulesState.consumables`, flagged `deployable` so the hotbar never fires it. Both materials are common in the starter belt and at the Moon, so no research or lunar gate (content audit passes).

**Schema 4.** `world.replication.points[]` (`id, name, frameId, positionKm, quaternion, by, createdAt, starter`; starter first, bounded at 64) and `player.replication.activeId`. Migration 3 → 4 adds the starter point (`src/sim/replication/points.ts::starterPoint`, deterministic from the system's starting pose: its default emergence IS the old start position) and points every player, dead ones included, at it; poses are untouched, so a live remote ship stays where it is. Defaults, validation (unknown frame kept but unusable → recovery falls back), import/export and the legacy import share the same sanitiser.

**Operations** (authority, deduplicated by opId): `replication.place` (one kit, one record, activates it for the placer only), `replication.activate` (within 2 km), `replication.deactivate` (selection → starter; never deletes), `replication.rename`, `ship.respawn {mode: "active" | "starter"}` (the reducer resolves and revalidates the destination; the client cannot pass a pose any more). Refusals: `invalid` (non-finite or non-unit pose, unknown frame, or a frame the position does not belong in), `no_kit`, `too_far` (> 2 km from the ship), `near_body` (< 150 km altitude), `near_rock` (< 200 m rock surface), `emergence_blocked` (< 120 m at the emergence position), `no_capacity`.

**Clearance** (`src/sim/replication/clearance.ts`) regenerates asteroid chunks with the field streamer's own deterministic generator (minus destroyed rocks), so a never-streamed area validates like a loaded one. It is injected into `placement.ts` (`registerClearanceProbe`) because it pulls three.js and the asteroid generator, which the reducers, and through them the title screen, must not load (shell-check `title` caught this). `src/store/replicationMirror.ts` exists for the same reason.

**Emergence.** The ship emerges 0.5 km on the point's −Z side, at rest, facing the point; if obstructed, 17 further candidates (other five axes at 0.5, 1, 1.5 km), else the starter with reason `obstructed`; `missing` / `invalid` likewise. The recovery screen always offers "Emergency fallback: origin point" behind a confirmation that names the lost expedition location (`chosen`).

**Death fuel rule.** The wreck receives ordinary fuel minus the amount that refills the protected allowance (`topUp = min(ordinary, 60 − protected)`), so tanks + every wreck never rise across a death. The one exception is deliberate: a ship whose total usable fuel is below 60 kg recovers with exactly 60 kg (the empty-space escape; gate `strandedEscape` +60 kg from 0/0). Processing: unconverted feedstock goes to the wreck, committed output stays in the ordinary fuel being dropped, no cancellation refund. Consumables leave with the wreck; hotbar assignments stay, cooldowns and timed effects are cleared.

**Reposition.** `src/sim/ship/reposition.ts` + `Spaceship.applyReposition`: one function for recovery and dev warps (frame pose, prev/current interpolation, velocities, transit, fixed-step accumulator, absolute position + floating origin, input/mouse, camera snap + shake, model lean, near-field reseed, pending impacts, published pose). Recovery holds `simPause("arrival")` until every field chunk within reach of the arrival is streamed (10 s timeout); the loading readiness treats a pending arrival like a teleport.

**UI / input.** B (`placePoint`) opens the preview panel (range ring, emergence marker, clearance, kit count, name field, nearest known hydrate / Fe-Ni source, warning beyond 50 km); Enter places. H (`activatePoint`) makes the nearby point active. Both rebindable; existing mappings unchanged. Points render as one instanced draw (merged octahedron + ring + mast, emissive `replication_beacon`, drawn within range) and appear as POI markers ("(active)" suffix) usable as transit targets, arriving at the emergence distance. Death and abandon screens name the destination and the loss.

**Measured** (gameplay-check parts in `gameplay-m36.mjs`, `--no-isolate`, fixture worlds):

| Gate | Result |
|---|---|
| place | 3 kits crafted; valid placement kits 3 → 2, points 1 → 2, same opId `duplicate` (2, 2); refusals invalid ×2 / too_far / near_rock / emergence_blocked / near_body / no_kit, each spends 0; Luna point at rate 10000: rel pose unchanged, absolute moved 906,570 km |
| activate | placer only; other player `too_far` → `accepted` in range; at 2.5 km `too_far`, 1.9 km accepted; deactivate keeps 2 points, second call `already_done` |
| death | wreck = 40 Fe-Ni, 25 sil, 19 hyd (includes the active batch's unconverted feedstock), kit ×1, patch ×1, 300.25 kg = expected exactly; after: cargo/consumables/cooldowns empty, 0 / 60 kg, no batch; reload while dead and after recovery: 1 wreck; second death 2 wrecks; abandon 3 |
| recover | at point 0.0 km off emergence, 0.5 km from point, 0 m/s, 0 rad/s, hull 100, cargo empty, 0 / 60 kg, arrival 135 ms; first 5 s: 0 impacts, 0 owner violations, 0 drift; shake/throttle/mouse 0, transit idle; obstructed → candidate 1 (695 m clear); missing / invalid → starter with reason; isolated point → explicit fallback; 10 cycles before = after every time |
| salvage | partial: 40 Fe-Ni, 2 kits (stackMax), 50 kg (tank full at 600) taken, rest left; protected stays 60; markers "fuel only, 40 kg"; wreck removed only when empty; duplicate opId awards nothing |
| migrate4 | 12 fixtures (v1/v2/v3 × fresh, mid, multi-player, dead remote) + malformed pass; export-import equal; dead Luna save boots to the starter (241 ms arrival); live Luna save not relocated; 5 invalid imports refused |
| live36 (real inputs) | craft 0.37 s, fly out 0.82 km in 6.0 s, place "Forward camp" 0.69 s, fly on and die at 224.7 m/s 20.5 s, recover 2.8 s, fly back and collect 20.0 s (wreck gone, 33 Fe-Ni + 5 C + 578 kg back) |
| bench:belt | frame P50 14.7 / 14.5 ms, GPU 11.48 / 10.88 ms (baseline 14.4–14.9, ~11) |

**Adapted older gates.** `migrate` / `migrate3` expect schema 4; `tx` respawns with `mode: "active"` instead of a client pose; the physics harness no longer uses the old `respawnAtom` teleport. Inspection layout fix: the composition readout sits right of the targeting ring instead of under the reticle.

**Deviations / next milestone.** The stranded-ship refill above is the only way dying can add fuel. Placement, activation range and pose are trusted from the client like the mine claim; an M4 authority re-derives them. Difficulty multipliers (M3.7) should scale the allowance and the kit recipe only through the tuning tables. Points live in the system frame or an existing body-SOI (inertial) frame; no orbit/rotating-surface frames were added.


**Review fixes (M3.6).** `player.lastLoss` (sanitised, cleared by recovery) carries the wreck contents so the recovery screen still states the loss after a reload while dead (gate `death.reloadDead` checks the text). `resetReposition` also releases the saved-pose hold, so a world switch or unmount between an accepted recovery and its reposition cannot freeze pose sampling. Points in an unknown frame stay in the save but get no marker, beacon or activation prompt (recovery still reports them `invalid`). Wreck labels: `Wreck`, `Wreck · consumables`, `Wreck · fuel only, N kg`, plus ` · N kg fuel` when mixed. Placement mode closes on death; H with no point nearby is silent. Naming is placement-time only and deactivation has no UI (operations exist; harness only). Open for the owner: §6.3's "restore the configured allowance" vs the lead rule "dying never adds usable fuel" still conflict below 60 kg (`strandedEscape`).
