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

- [ ] Read the two new design docs and current M2 as-built status/gates.
- [ ] Record actual save schema, physics API, pause behaviour, and baseline timings.
- [ ] Write the content/legacy mapping and resource tuning tables; define units and
      command boundaries before touching UI.
- [ ] Confirm a default initial fuel-source/replication placement for every supported seed.

**Gate:** M0/M1/M2 regression status recorded; agreed decisions distinguished from
tuning defaults; no stale root-story requirement used. No new dependency required.

### M3.1 — Durable domain and ownership

- [ ] Add typed world/player records, accepted domain operations, world mirrors,
      coherent save transactions, and append-only migration/sanitization.
- [ ] Move shared research/evidence/discovery ownership; preserve old data by mapping.
- [ ] Implement deduplicated transaction foundations for manufacturing and world/player
      transfers, including fuel-only wreck representation.

**Gate:** migration and round-trip fixtures preserve progress; rejected/repeated
operations cannot double-spend, duplicate rewards, or leave mixed world/player results.
Reload at a transaction boundary is consistent. Two saved players share knowledge but
retain separate supplies/equipment/active point selections.

### M3.2 — Self-sufficiency and activity budgets

- [ ] Add pure resource stepping, control-demand metering, reactor/capacitor arbitration,
      unified heat, basic fuel batches, repair, and resource HUD read models.
- [ ] Integrate mining/boost/processing requests with actual granted work and pause.
- [ ] Make starter tools and essential recipes available without the old research boot gate.

**Gate:** rest/coast/no-input idle costs nothing; thrust and work cost the intended
resources; conversions conserve inputs/outputs; throttle and frame rate do not change
results for the same executed inputs. Empty/full tanks, heat, pause and death are bounded.

### M3.3 — Prospecting and discovery-based research

- [ ] Implement meaningful baseline inspection, stable findings/markers, typed research
      requirements, and simple non-dangerous trials.
- [ ] Remove generic assay rewards/required timers from the new path; disable the old
      research completion writer for new saves.
- [ ] Expose useful missing-evidence explanations in existing research UI.

**Gate:** repeated known-source scans do not farm universal progress; durable evidence
unlocks the intended options exactly once and survives death/reload; basics remain
available without consuming scan probes.

### M3.4 — Branching equipment and economy

- [ ] Rebalance recipes/available modules, retire incompatible effects/consumables,
      and connect equipment to one effective config and power/thermal preview.
- [ ] Provide at least two viable early investment priorities and a direct, purposeful
      starter-region path to transit.
- [ ] Ensure replication kits, fuel, and repairs remain craftable in either region.

**Gate:** recipe dependency/capacity audit passes; no helium-3 survival/travel gate;
manufacturing UI and underlying accepted actions agree; no duplicated passive effects.
Fresh-save playthroughs through both early priorities remain viable.

### M3.5 — Fuel-aware travel

- [ ] Extract/consolidate the transit time/trajectory seam, predictor, safe braking reserve,
      abort handling, and frame-relative POI targeting.
- [ ] Add range/arrival balance and obstruction feedback; make the Earth-to-Moon route
      playable with bounded clearance legs when necessary.

**Gate:** predicted versus executed burn/ETA within a documented tolerance (initial
target 5% for unchanged straight legs); insufficient fuel aborts/limits safely; no
negative stores or full-speed zero-fuel drop-out; M1/M2 ownership gates still pass.
Verify departure/arrival with Earth obstructing and at a second orbital date.

### M3.6 — Replication and complete recovery

- [ ] Add the simple placeable point, naming/activation, initial fallback, and recovery UI.
- [ ] Implement atomic death/abandonment, safe frame-relative restoration, protected
      allowance, cargo/consumable/fuel salvage, and explicit final starter fallback.
- [ ] Wire normal and fuel-only wrecks into markers and partial collection.

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
