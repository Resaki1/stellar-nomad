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
- [x] Confirm a default initial fuel-source/replication placement for every supported seed.

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

- [x] Author/rebalance initial sites and the lunar instrument/sample recovery opportunity.
- [x] Add player-selected projects, concise hints/help records, sparse premise text,
      and updated POI/crafting/research/death explanations.
- [x] Remove obsolete ESA/live-human messages and generic-assay prompts from the active path.
- [x] Apply simple Explorer/Standard/Hard multipliers; keep the recovery/progression
      preservation model consistent. Balance Standard first.

**Gate:** a lunar discovery supplies a worthwhile optional capability; both regions
support continuing locally; no mandatory return-home quest, archive task, or timed upkeep.
All content has meaningful reload/deduplication behaviour.

### M3.8 — End-to-end gates and playtest

- [x] Run the verification matrix below in disposable worlds, plus required regressions.
- [ ] Playtest both early priorities, one-way relocation, and a deliberate failure/recovery.
- [x] Record timings, resource decisions, unclear UI, economy exploits, and final tuning.
- [x] Update roadmap/as-built notes with actual completion and remaining limitations.

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

### M3.7 — Lunar opportunity, projects, guidance and difficulty (as built, 2026-11-17)

**Save schema 5** (`MIGRATIONS[3]`): `world.discoveries.inspectedSites` (site id → stamp; a site already
in `sites` counts as inspected) and `player.trackedProject` (string or null). Difficulty already lived in
`SaveMeta` (chosen on the title screen since M0.4, stored, validated to `standard`); M3.7 consumes it.

**Earth region.** `origin_belt` keeps its seed, salt, shape and streaming. Three authored *pockets*
(`resources.pockets` in `sol.json`, `pocketOf` in `resources.ts`) replace the class table inside named
chunks, so a fuel source never depends on a roll; positions and instance ids are untouched:

| Pocket | Chunks | Classes (fractions) | Measured |
|---|---|---|---|
| Volatile-rich debris | `-141,8,-10`, `-142,9,-10` | C-type 100 %, hydrates 20–32 % | 7 rocks, 79 cold-mineable hydrate units (1,580 kg), nearest 9.96 km from the starter emergence, 6 units, 6.5 s |
| Metal-rich fragments | `-142,8,-11` | X-type 80 % (Fe-Ni 65–90 %), S-type 20 % | 4 X-type |
| Mixed rubble | `-141,9,-10` | S 40 / C 35 / X 25 % (field defaults) | 2 X, 1 C, 2 S |

Each pocket is a POI ("regional indication", 1–2,500 km). The survey opportunity is the three pockets
together: one short tour confirms silicates, Fe-Ni and hydrates by inspection (sv1's evidence). Every
reward/class call now takes the chunk key (`getAsteroidMiningReward(…, chunkKey)` is required).

**Lunar region.** `luna_belt` keeps id, seed, salt, class ids, weights and slot counts (so class picks are
unchanged); the three helium-3 slots became hydrates (regolith 2–6 %), carbon (metallic 1–4 %) and
hydrates (volatile 20–35 %, was 5–10 %); volatile's old hydrate slot became Fe-Ni 5–12 %. Measured over
120,119 loaded rocks: titanium 22.4 %, Fe-Ni 24.5 %, hydrates 11.5 %, silicates 35.2 %, no helium-3.
`helium_3` remains a known material id (old cargo stays valid) but no class provides it.

**Lunar survey site** (`SITES` in `content.ts`): `luna_survey_canister` at Luna-frame [5200, 1200, 0] km
(5,337 km from the Moon's centre, at luna_belt's thinning edge; nearest rock > 3 km). It sits **outside**
the Moon's 2 R route-clearance sphere: at the first position (inside it) the standoff → site hop needed a
26,000 km detour. Signal marker within 120,000 km ("Automated survey signal"), then G within 2 km =
`site.inspect`, G within 1 km = `site.recover` (one operation: 30 titanium into cargo + the `sites`
stamp; refused `not_inspected`, `too_far`, `no_capacity`, `already_done`; receipted). `ln1` (no
analysis) unlocks the Integrated Sensor Suite (200 sil, 80 Fe-Ni, 30 Ti). Nothing else requires `ln1`
and no starter/transit recipe needs titanium. Placeholder visual `src/components/Sites/SurveySite.tsx`:
one merged truss/dish mesh + a canister that hides once recovered, frame-relative, drawn within 400 km.

**Projects** (`src/data/projects.ts`, pure evaluator `src/sim/research/projects.ts`, tracker
`ObjectiveTracker`, panel `ProjectsPanel`, key O): Reach the Moon, Build a forward replication point,
Recover the lunar survey canister, Establish a lunar foothold, plus "Research: <option>" for every option.
A research step expands into its missing evidence and analysis material. Optional, any number of times;
completion is a toast, no reward. "Set destination" pins the transit target.

**Guidance.** Comms catalogue reduced to four sparse entries: `opening_001` (premise; the naming prompt
follows it), `opening_002` (first opportunity), `lunar_signal_001`, `site_recovered_001`. 33 retired ids
(`RETIRED_COMMS_IDS`: ESA ground control, the human commander, assay prompts, per-craft/per-research
lines) stay valid in played registries and `enqueueCommsAtom` refuses them. Routine state is now 12
one-time hints (`src/data/guidance.ts`, `HintStrip`, no Continue, 9 s, click to dismiss), marked played
**when shown** in the same save-backed registry (`player.commsPlayed`, not localStorage), so a reload
never repeats one. Six help records (premise, propellant, research, rock classes, recovery, the survey
site after its signal) in the Projects panel. The comms overlay advances with Enter only (Space is
strafe-up) and hides while dead or in Settings, so it can never cover the recovery screen or the abandon
dialog. All triggers stay in `GameCommsTriggers.tsx`.

**Difficulty** (`src/sim/difficulty.ts`, rates only; `getEffectiveTuning()` = live table × multipliers,
used by the reducers, the runtime, transit and the resource harness; collision through `impactDamageHp`;
yield in `buildMineOperation`). Measured in the deterministic harness:

| | Explorer | Standard | Hard |
|---|---|---|---|
| propellant per Δv (manoeuvre + transit) | ×0.75 (2 s main burn 1.44 kg; Earth → Moon line 156.9 kg) | 1.92 kg; 209.2 kg | ×1.25 (2.40; 261.5) |
| heat input (mining, boost, processing, repair, transit) | ×0.85 (cold laser trips at 25.8 s) | 15.0 s | ×1.15 (10.7 s) |
| collision damage | ×0.5 (40 m/s hit 4.1 HP) | 8.2 HP | ×1.5 (12.2 HP) |
| protected allowance | 90 kg | 60 kg | 45 kg |
| mining yield | ×1.25 (same rock 29 vs 23 units) | 23 | ×1 |

Death/recovery is the same model on every setting (cargo, consumables and ordinary fuel minus the
allowance top-up to the wreck; modules, research, discoveries kept; full hull; protected = allowance).
There is no in-game switch; editing the stored setting changes rates only, never stored quantities.

**Glance HUD** (ship dashboard): heat shows its headroom to the 80 % warning; a `recovery:` row (active
point and distance, when not the starter or > 50 km away); one warning line, worst first: no propellant
(abandon path), on the protected allowance, short of the ideal transit fuel back to the active point,
propellant low. Boost and hull unchanged.

**Defects found and fixed on the way.**
- `[AsteroidRuntime] instanceId collision detected`: instance ids are 32-bit hashes unique per chunk,
  not per field. Birthday maths for luna_belt's ~120,000 loaded rocks gives ~1.7 expected pairs (18,409
  near Earth: 0.04), which is why it showed in mass-inspection and lunar runs. Real defect: the runtime's
  field-wide id index and `MiningSystem`'s target (id only) could resolve a mined rock to the other
  chunk's twin and hide the wrong one until reload. Index is now keyed by chunk handle + id,
  `destroyInstance(chunkKey, id)`, the miner targets (chunk, id), and `findInstanceLocation` is gone.
- Transit routing: a target behind the Moon from Earth grew the clearance waypoint until the second
  blocker cleared — a 1,821,843 km plan (4.9× direct) that took the whole tank, and in flight had not
  arrived after 110 s. A waypoint may now lengthen the route at most 1.5 × direct + 10 clearance radii;
  beyond that it refuses "Route blocked by Earth and Luna: travel to Luna first". The M3.5 standoff →
  lunar field hop is unchanged (24 s / 88 kg); Earth → site is 76 s / 335 kg via Earth.
- Gaze targeting replaced a destination pinned from a menu within 1.5 s (arrival at the Moon faces the
  Sun; recovery emerges facing its point). A pinned destination now yields only to a 4 s look, and a POI
  the ship stands inside the arrival stand-off of no longer starts a gaze lock.
- UI: at ≤ 520 px the panel buttons are icon-only and right-aligned (they covered the cargo bar), toasts
  are a full-width band under the top bar and the transit plan sits below it (the refusal toast covered
  the plan title), the tracker yields to the transit plan; the tracker has a scrim (POI labels draw in its
  band); hints sit top-left at 1280 px, clear of the comms lower-third. The title screen's "no effect on
  gameplay yet" difficulty line is replaced.

### M3.8 — End-to-end gates (as built, 2026-11-17)

New gate file `scripts/drive-examples/gameplay-m37.mjs`, wired into `gameplay-check.mjs` (parts in
CLAUDE.md). Every part runs in disposable `[gc] ` worlds and restores the active one. Sessions keep one
world across parts (`.captures/m37-sessions.json`) so no single command runs longer than ~2 min.

**Verification matrix (§11).**

| Gate | Part(s) | Measured |
|---|---|---|
| V1 resource accounting | `res` | idle/coast 0 kg; main 240 m/s → 1.92 kg, strafe 0.96, retro 1.60; 30/60/144 Hz + hitches bit-identical (2,900 steps); bounce / frame switch 0 kg; stores never negative |
| V2 power/thermal | `res`, `m32` | cold trip 14.99 s (15); warn 0.39 s < throttle 0.80 < trip 1.28 < damage 3.28 s; essential control unchanged at 120 % heat |
| V3 processing/repair | `m32`, sessionB | partial cancel refund 19 = expected; full tank pauses; reload invariant 100 kg; death wreck 210.17 kg + 109 hydrates = expected; repair 62 → 100 % on lunar Fe-Ni (sessionB) |
| V4 research | `evidence`, `reqs`, `audit` | families once, repeat `already_done`, duplicate id `duplicate`; 200 inspections without an instance-id warning; content audit pass |
| V5 transactions | `tx`, `shared`, `exploits` | duplicates `duplicate`, retries `already_done`, nothing granted twice across reload / death / world switch |
| V6 placement | `place`, sessionB, sessionC | one kit → one point; refusals spend nothing; lunar point "Lunar camp" in Luna frame, active |
| V7 recovery | `recover`, sessionC | real click on the recovery screen; explicit origin fallback through button + confirmation: 0.00 km from the starter emergence, 0 / 60 kg |
| V8 wrecks | `death`, `salvage`, sessionC | partial salvage by stack limit (1 of 3 heat sinks fits, 2 stay); fuel-only/mixed labels; protected never salvaged |
| V9 transit | `transit`, `transitLive`, sessions | pure ETA/fuel ≤ 0.4 %; Earth → Moon 240.8 kg / 56.2 s pred = exec; Moon → site 76.5 kg / 22.0 s; Earth → site 335.3 kg / 75.9 s; Earth → lunar field refused (two blockers) |
| V10 migration | `migrate`, `migrate3`, `migrate4`, `difficulty` | schema 1–4 fixtures → 5; malformed difficulty → standard; export/import equal |
| V11 lifecycle | `m32` lifecycle, `transitLive` lifecycle | settings/loading pause freeze batch and drive; 3 s stall 31 steps; no offline catch-up |
| V12 live loop | sessions A, B, C, `live36` | see below |
| V13 performance | `bench:belt` ×2, `bench:m3_lunar_site` | see Performance |

**Performance** (`--perf`, 1280×720, DPR 1, headless M2 Pro, page reloaded per run): `bench:belt` frame
P50 14.7 / 14.4 ms, GPU 7.12 / 8.48 ms, local scene 0.33 / 0.37 ms (baseline 14.2–14.9 ms; M3.6 14.7 /
14.5): no regression. New scenario `m3_lunar_site` (1.5 km beyond the canister, facing the Moon, live
with its orbit): frame P50 16.6 ms, GPU 8.16 ms, local scene 0.50 ms, atmosphere 2.28 ms. It has no
pre-M3.7 baseline (the scene did not exist); the frame time is paced (`--perf` uses vsync) and the GPU
total is in line with belt. The installation is one merged mesh + one canister: 2 draw calls within 400 km.

**Sessions (all pass; mining fast-forwarded through the accepted claim, everything else real input or UI
operations).**

(i) Survey first → prepared lunar visit → site → optional unlock (3 parts). 3 inspections, 7 rocks mined
(74 s of extraction), 3 unlocks (sv1, pr1, ln1), 3 fabrications (prospector, drive, sensor suite), 1
processing batch topping the tank to 594.8 kg, 2 trials, `site.inspect` + `site.recover` by pressing G,
1 `module.equip`. Earth → Moon 240.8 kg (predicted = executed, 56.2 s), Moon → site 76.5 kg (22.0 s,
via the Luna clearance point), approach 15 s with W/X; 262.5 kg left. The tracked "Recover the lunar
survey canister" project completed. **Play time:** the scripted actions sum to ≈ 9.5 min (extraction +
25 s between rocks + 20 s per craft/unlock/processing/site interaction + real flight and transit). A
first-time player also learns flight and the UI, reads the opening, hints and research panel, inspects
rocks that turn out useless, and flies at 200–400 m/s between them: an honest estimate is 30–45 min,
**below the 60–90 min target**. Assumptions: the player follows the hints and the tracker, finds the
volatile pocket from its marker, and does not die. Knobs if the playtest agrees it is too quick: drive
recipe (280 units), pocket richness (79 cold-mineable hydrate units), the sv1/pr1 evidence lists.

(ii) Extraction/cooling first → one-way relocation → lunar self-sufficiency (5 parts). Live 8 s
sustained beam (trial), 8 rocks, ex1 + th1 + pr1, focuser + radiator + drive; Earth → survey site in one
go: 335.3 kg, 75.9 s, 259.5 kg left, no return planned. Earth cargo jettisoned on arrival, so everything
after is lunar: a kit from lunar Fe-Ni/silicates, "Lunar camp" placed and active in the Luna frame, five
refuel cycles (each a real transit round trip to the lunar field, 31.1–31.5 kg, refilled by processing 2
lunar hydrate units: 259.5 → 301.9 kg over the five), hull 80 → 100 % repaired with lunar Fe-Ni, a
second kit fabricated. "Establish a lunar foothold" completed.

(iii) Deliberate failure (2 parts). Setup deviation: the world starts with 40 kg ordinary fuel (burning
600 kg by manoeuvring takes ~10 min). Kit + 3 heat sinks, "Forward camp" placed after a short W/X
flight; W/X until ordinary was 0 (45–50 s, 7.5–8.4 km out over two runs); abandon → wreck with all cargo and
3 heat sinks, 0 kg fuel; recovery by clicking the recovery screen; 9 heat sinks fabricated there; flown
back on the allowance in 36–42 s (60 → 33–36 kg protected); wreck collection took all cargo and 1 heat
sink (stack 10), 2 stayed (partial salvage); abandon again; "Emergency fallback: Origin point" + its
confirmation by real clicks → 0.00 km from the starter emergence with 0 / 60 kg, Forward camp still the
active selection, both wrecks kept. Fuel note: both recoveries ran the documented stranded-ship rule
(usable fuel below the allowance recovers with exactly the allowance; second death +26.7 kg in the final run); nothing else
can add fuel.

**Release criteria (§12).**
- Complete loop in a normal session: sessions (i)–(iii) pass; time estimate above (likely shorter
  than intended).
- Two distinguishable early priorities: `config` (prospector inspection ×0.5 time / ×1.6 range; focuser
  ×0.7 mining time with ×1.3 power and heat; radiator trip 18.74 s vs 15.0 s), playA/playB.
- A resource constraint forcing a decision: one cargo slot holds the rack (+600 units) or the aux tank
  (+400 kg, −500 units), refused when it would overflow (`fit`); Earth → Moon costs 40 % of a tank and a
  one-way trip to the site 56 %.
- Indefinite lunar self-sufficiency: session (ii); the lunar field (120,119 rocks) is 11.5 % hydrates,
  24.5 % Fe-Ni, 35.2 % silicates.
- A different lunar interaction with a useful optional result: `site` (inspect then recover, one-time,
  persists through death, reload and import; the sensor suite unlocks only from it; nothing depends on it).
- Recoverable failures without duplication: M3.6 gates, session (iii), `exploits`.
- Knowledge/equipment survive, no archive care or campaign: death gates; catalogue grep (no ground
  control, commander, assay or uplink text in active comms or hints).
- Migration/import integrity: migrate gates, `difficulty.migrate`, `site.persist`.
- Regressions and performance: below.

**Exploit sweep (`exploits`, all yield nothing).** Site reward: reload + same id `duplicate`, new id
`already_done`, after death `already_done`, titanium total stays 30, another world has no stamp. Craft
with a reused id `duplicate` (no second kit, cargo unchanged); research unlock again `already_done`.
Processing start/cancel ×5: value (hydrates × 20 kg + fuel + reserved − committed) only falls (500 →
435.6: a unit already converting is never refunded). Equip swaps ×4 (suite ↔ empty): stores unchanged,
one owned copy. Death loop ×5 with 250 kg: tanks + wrecks 310 kg every time. Difficulty: no in-game
switch; an edited setting changes no stored quantity. Projects and hints grant nothing.

**What a scripted run cannot establish** (owner playtest): whether the opening and hints explain enough
without the tracker; whether the pocket markers read as "go here for fuel"; whether the survey signal is
findable and the two-hop route (or the "travel to Luna first" refusal) is understood; pacing against
60–90 min; whether Hard/Explorer feel right; whether the placeholder installation reads as a place.

Playtest checklist (fresh Standard world): (1) without the Projects panel, find fuel and make a batch;
(2) repair a small impact; (3) pick survey or extraction and say why; (4) track "Reach the Moon" and
follow only the tracker; (5) find and recover the canister, then decide whether the suite is worth 200
silicates; (6) place a lunar point and live there for 20 min; (7) run dry, abandon, salvage, and use the
origin fallback once; (8) note every moment you did not know what to do next, with the time.

**Remaining limitations.** World seed still does not vary the starter region (pockets and fields are the
same for every seed; measured identical across 8 seeds). Site inspection range and recovery are trusted
from the client pose like the mine claim (M4 re-derives). A pinned destination yields to a 4 s gaze.
The transit planner still routes round only one body; a second blocker now refuses instead of
detouring. Hints are English strings in data, no localisation. The tracker shows at most three unmet
lines. Session (iii) starts from a 40 kg setup. The `[gc]` session worlds are deleted by each session's final
part only; an interrupted session leaves a `[gc] m37-session*` world behind (delete it from Load world).

**Regressions (final tree, page reloaded before each script).** flight-trace `sim,live,mouse,camera,reticle`
14/14; physics-check `sim,damage,hull,asteroids` pass; frames-check `ride,switch` pass; save-check
`roundtrip,reload,isolation` pass (`fresh,legacy` not run: they wipe the driver profile's database);
shell-check `title,continue` pass; gameplay-check `migrate,tx,shared,live` (34), `res,m32,reach`,
`audit,fit,reqs,config,migrate3` (39), `evidence`, `place,activate,death,recover,salvage,migrate4` (55),
`transit,live36` (22), `playA,playB`, `transitLive` (`defaultEpoch`, `secondEpoch`), and every M3.7 part
pass. Typecheck clean; lint 0 errors (132 warnings); `check:audio` 0 problems (no audio event changed).
No console errors; no instance-id warning in any run after the fix. **Adapted older gates:** schema 5
expectations (`migrate`, `migrate3`, `migrate4`, `discoveriesEmpty` with `inspectedSites`); `evidence`
picks an S-type rock without a hydrate family (the last composition slot takes the rounding remainder, so
a small S-type can show 3 % hydrates, and the pockets changed which rock came first); `devSetWorld` goes
through the sanitiser. `res,m32,reach` takes 4.6 min in one run: split it when the 2 min limit matters.

**Review fixes (after M3.8).** (1) A new world's protected propellant is now seeded from its difficulty
(`defaultSaveData(playerId, difficulty)` in `createWorld`/reset/new player): Explorer 90 kg, Standard 60,
Hard 45, read before any death by the new `difficulty` sub-gate `created` (pass); before, every new world
started at 60 regardless of the allowance. (2) "Reach the Moon" fuel step label no longer states Standard
kg (the requirement itself is scaled). (3) Comms overlay: between 521 and 1180 px its right edge stops at
the dashboard's left edge (the centred 760 px overlay reached the fuel/heat rows below ~1118 px);
`commsHitsDash` false at 768×1024 and 1100×800. It also has a dark scrim, so the lunar arrival text reads
over the Moon. (4) The transit side panel has a scrim, so POI distance labels no longer read through the
refusal line (the inline refusal stays: it is the persistent preview, the toast is the event). (5) Hints:
the module-level pending queue is gone; a busy slot drops the offer and the trigger re-offers when free,
only while its condition holds (no stale hint after refuelling). (6) The recovery toast names the research
options whose requirements cite the site, not a literal. (7) save-check `legacy`/`roundtrip` ignore `hint_`
ids in `commsPlayed`: a hint can legitimately show after the export/import in real time. Note for this
machine: something else answers `localhost:3000` over IPv6; run the driver with `--url http://127.0.0.1:3000`.

### Playtest 1 polish, WP1: correctness (as built, 2026-11-17)

Work list `docs/M3_PLAYTEST_1.md`; status per item there. Sim and store fixes, little UI.

**Start date (D10).** New worlds start at **2941-09-22 00:00 UTC** (`DEFAULT_SIM_EPOCH_MS`); existing
worlds keep theirs; no year is shown. The ephemeris now covers it: JPL *Approximate Positions* table 2a/2b
(3000 BC – AD 3000, with the b·T² + c·cos fT + s·sin fT terms for Jupiter–Neptune) outside 1800–2050,
table 1 inside (table 2a alone moved the 2024 greatest eclipse to +1 min 47 s, outside the 1 min
tolerance; MEASURED step at the 2050 seam ≤ 7.4 arcmin, Uranus). ΔT is Espenak–Meeus to 2150, then the
Morrison–Stephenson parabola (74 s in 2024, 3,712 s in 2900, 4,066 s in 2950). Earth spins on UT
(`rotation.ut`, keeping the 69 s offset W₀ was validated with), every other body on TT: the growing ΔT
would turn Earth 17° by 2950. `ECLIPSE_2024_04_08_MS` is its own literal (bench, `__lum`, dev button).
Validation: 2024-04-08 greatest eclipse +1 min 16 s, γ 0.3453 (published 0.3435); 2017-08-21 +47 s, γ
0.4384 (0.4367); perihelion/aphelion 0.98331/1.01670 AU, unchanged. Frame check at far dates: the
minimum Sun–Moon separation falls −0.7 h (2500), +5.6 h (2941) and +10.6 h (2999) from Meeus's mean new
moon, inside the ±14 h periodic range (a 13° equinox slip would be ~26 h).
Search (`scratchpad/eph/search2.js`, hourly 2900-01-01 … 2999-12-31, 876,576 instants, 23,045 pass the
filters: Luna elongation 75–140°, Luna ≥ 10° outside Earth's disc, no visible planet marker within 8°,
Earth 50–75 % lit from the start, first Earth → lunar-field line clear of the hazard shells). Chosen:
Luna 126.5° from the Sun (80 % lit), nearest marker Mars 87°, Luna 129° from Earth's centre, Earth 62 %
lit (phase angle 75.6°), the start → field line passes Luna at 3,121 km; drifts to 128° / 89° after 3 h.

**Routing (B6, B7).** `hazardKm = R + atmosphere top + max(2 % R, 200 km)` (Earth 6,671, Luna 1,937; the
atmosphere top comes from the rendered atmosphere, passed in `TransitBody.atmosphereTopKm`). A segment is
blocked iff its closest approach < min(hazard, d0, d1) × 0.999: a line may descend to its lower end, never
below the shell in between. Targets less than 20 km above a surface or atmosphere top are refused
("Target inside Luna"). In autopilot the obstruction brake's sphere shrinks to 0.99 × the nearer of ship
and aim and ignores entries past the aim, so a legal low target never stops short. `transitRouteClearanceRadii`
(2 R) is gone from the tuning table.

**Field arrival (D11).** `bodyTransitTarget` (every gaze, menu and test path) gives a body that anchors a
field a `field` target: from beyond 50,000 km the plan aims at the field anchor and stops 1,500 km short
on the approach side (preview name `Luna · lunar field`, `plan.fieldArrival`); nearer, the 2 R standoff as
before. The body is then an obstacle, not skipped. Field markers hide inside radius + falloff; the lunar
field (renamed `Lunar field`) shows from 4,000 to 50,000 km.

**B8.** `beginSpool` clears `braking`/`arriving`; `predictFromRuntime` passes them only outside the spool.

**Markers (B1, D1, B3, B4).** No pocket markers (pocket composition data unchanged; opening_002 no
longer mentions marked pockets). The origin point has no POI and no mesh. The current destination is
always projected (a temporary POI when nothing else lists it). `Set destination` (discoveries, projects)
is hidden and refused without the drive. Mining a rock drops the miner's bookmark in the `asteroid.mine`
transaction; `bookmark.set` prunes bookmarks of depleted sources (destroyed by a collision, or mined by
another player), so a hidden bookmark never holds one of the 24 slots. A destination whose rock is
depleted is cleared (`discoveries.changed` in `worldBridge`), so no marker stays on empty space.
Depleted sources have no marker and leave the Discoveries list (their evidence stays).

**B5.** `src/sim/ship/hull.ts`: `hullRepairable = health ≤ max − 0.5 HP`, used by the dashboard, Workshop,
hotbar slot + context menu, repair request, auto-repair and the `ship.repair` reducer (which also snaps a
result within 0.5 HP to max). `hullDisplayPct` shows 100 only when not repairable, else floors (1–99).
Deviation from the spec's plain floor: a plain floor would show 99 % for a hull nothing can repair.

**B14.** No Track button on a completed project; the tracker clears a project when it completes; the
"Research options" heading only with rows. Sorting (D15) is WP4.

**B12.** `setCursorNeeded(reason, false)` requests the pointer lock when the last reason clears; the
request only fires while the closing click/key's transient activation lasts, so every close path (panel
button, backdrop, toggle keys, Settings resume, naming confirm, placement, death screen) recaptures
without per-handler wiring. A lock that resolves after another UI asked for the cursor is released at
once. Esc grants no activation: after ~5 s without input an Esc-close leaves the "click to steer" prompt.
Deviation from the spec's per-handler helper: one rule covers every handler, including ones added later.

**B2.** The owner-path flight hits and damages at every difficulty (below). The silent collision-off
states are now visible: the dashboard shows `Collisions off · physics loading | physics unavailable | dev
speed | over speed` (`collisionsOffReason`, 4 Hz). The 20 s load bound starts at game mount
(`armNearFieldLoadTimeout`); the loading gate holds for one window, a second runs in play behind the
`physics loading` flag before giving up; a failed import is retried once, and a load that lands after
the bound still attaches the world (the flag clears).

**Verification (fresh page per run).** `transit` (pure) pass, new: `b6_directPure` (line 9,997 km from
Earth's centre: 1 leg), `d11_fieldArrivalPure` (far: ends 1,500.02 km from the anchor, 2 legs round Luna,
min 1,950 km from it; within 50,000 km: the 3,474 km standoff); `d_clearancePure` now asserts the hazard
shell (min 6,807 ≥ 6,671). `transitBelt` (new, pure): 300 random in-field pairs, 100 targets at 50–200 km
altitude: 0 refused, 63 clearance legs, 0 where the leg disagrees with the line test; 10 flown, all
arrived, none stopped short, closest approach equal to the lower endpoint. `transitLive` `defaultEpoch`:
1 leg, prediction error 0 on ETA/fuel/heat (45.9 s, 206 kg), arrival 1,500.3 km from the field anchor,
nearest rock surface 3.8 km, min Earth 16,746 km, min Luna 3,121 km, `lunarHydrates` mined and processed
in the field; `secondEpoch` (2941-10-06 12:00): 1 leg, 214.6 kg, 1,499.7 km, rock 3.6 km. `transitSpool`
(new, live): Earth → field (302 preview samples), an in-field hop (47) and a 2-leg trip round Luna (106):
0 refused samples; negative control with the B8 fix reverted: 24/47 and 42/106 refused ("Too little
propellant to move"). `marks` (new, m33): bookmark → mine leaves 0 `source:` markers and 0 bookmarks;
without the drive the action is refused and no button shows, with it the target sticks 60 frames with
its marker; mining that destination rock clears the destination and leaves 0 markers; a bookmarked rock
destroyed by `asteroid.destroy` (collision) stops holding a slot (both checks fail with their fix
reverted). `repairEdge` (new, m32): 99.7 HP → 100 %, Repair disabled, kit slot unavailable, manual
repair refused, `ship.repair` `full_hull`; 99.4 → 99 %, all enabled, the op lands on 100. `regions`: 0
pocket markers, 0 point markers, 0 point meshes, origin field marker hidden at spawn. Shell `lock` (new):
close by click and by key relock, Esc without activation leaves the prompt; `title,continue` pass.
`PHYS_PARTS=liveOwner` (new, one difficulty per run): physics ready in 0.26–0.55 s on the first attempt,
the flag absent / `Collisions off · dev speed` / absent, real W from spawn into a 299 m rock 6.2 km away
at 402 m/s: Explorer dv 460–463 m/s → 50 HP (6 of 7 runs; the first, untraced run reached no impact in
30 s and was not reproduced), Standard dv 461 → 100 HP (fatal), Hard dv 460 → 150 HP (fatal), each equal
to curve × multiplier. `PHYS_PARTS=sim,damage,hull,asteroids`, `res`, `m32` pass. `__lum.ephemeris()`:
2024 18:18 / γ 0.3453, 2017 18:27 / γ 0.4384. Fresh-world capture at the new epoch: Earth ~60 % lit with
the terminator in view from the spawn, Luna's marker alone (the Moon a few pixels under it); the origin
point's nearby card was also removed (D1). Typecheck clean; lint 0 errors (132 warnings).
**Not run:** the M3.7 end-to-end sessions (sessionA/B/C) and `transitShots`, which fly Earth → Luna and
may expect the old standoff arrival; WP3 owns the transit panel captures.

### Playtest 1 polish, WP2: progression content (as built, 2026-11-17)

Items D9, D13 (and the drive rename of D14). Supersedes the §13.5 matrix and recipes where they differ.

**Matrix (`content.ts`).** The transit drive is the first milestone: Transit Drive Calibration (pr1) now
needs Heat Rejection, Bulk Handling, an inspected C-type and the hydrate family; analysis 15 hydrates +
40 Fe-Ni. Composition Survey needs one inspected rock of each starter class (S, C, X; was three inspected
families, which one C-type rock satisfied), 20 silicates. Volatile Mapping: Composition Survey, inspected
hydrates, carbon; 5 + 5. Controlled Extraction needs *inspected* Fe-Ni; 30 Fe-Ni. Other analyses: ex2
5 S, th1 30 Si, lg1 30 Fe, pr2 20 Fe + 5 S, hl1 20 Fe. The lunar option (ln1) also needs Volatile
Mapping and 10 titanium, so the suite caps the survey line instead of bypassing it.
Recipes: **Transit Drive** (renamed from "Interplanetary Transit Drive"; slot/category unchanged, the
"Drive" category is WP4) 600 Si, 550 Fe, 30 H, 20 C, 12 S = 1,212 units (was 288); Integrated Sensor
Suite 200 Si, 100 Fe, 60 Ti (canister 30 Ti − 10 analysis ⇒ ≥ 40 mined in the lunar field). Item
descriptions per spec §5.4 (≤ 6 words). Start state: **new worlds carry 200 kg** of ordinary propellant
(`START_PROPELLANT_KG`; tank 600, Earth → lunar field 206 kg), so the first trip needs a processing
batch and a fresh tank always has room for `first_batch`. Migrated saves keep a full tank.
Projects: `reach_moon` = th1 → lg1 → pr1 → drive → fuel 280 kg → "Reach the lunar field";
`lunar_survey` = drive → field → recover canister → Volatile Mapping → ln1 → suite (the separate inspect
step is dropped; WP3 merges inspect into recovery).

**Pace (new `GAME_PARTS=pace`, `gameplay-pace.mjs`).** A competent-player bot on a fresh Standard world:
real W/X input for every hop, the live laser on a focused rock for every extraction, T held for the
transit; class-aware rock choice, surplus jettisoned; harness-instant actions charged a fixed time
(opening 120 s, inspection 6 s, menu action 12 s). Resumable (`.captures/pace.json`, ~100 s of work per
run). MEASURED, sim minutes (wall = sim here):
| Run | pr1 unlocked | drive crafted | in lunar field | rocks | hops |
|---|---|---|---|---|---|
| unconstrained (9 runs) | 11.4 | 17.6 | **18.4** | 10 | 7–24 km |
| rocks ≤ 13 s (cold laser, the spec model's mid-size rocks; `PACE_MAX_MINE_S=13`, 23 runs) | 7.6 | 41.7 | **42.8** | 25 | ~20 km mean |
Spec §5.5 expert line ≈ 34 min. The capped run lands near the model (25 rocks vs 24 modelled; slower,
because the starter neighbourhood holds only 5 rocks ≥ 15 m within 12 km, so hops average ~20 km, not
3.5 km). The unconstrained bot is **2× faster than the model** for a reason the drive's Fe-Ni cannot
fix: yield grows as 15·(r/50)^1.6 up to 2,500 units while extraction time is capped at 18 s
(`computeMiningDurationS`), and Radiator Strips lift the laser trip to 18.75 s, so one 450–800 m rock
gives 500–1,300 units in one pass (the last three rocks paid for most of the drive). Closing that gap
by Fe-Ni alone would need several thousand more units, beyond the 2,000-unit single-craft rule. **Drive
Fe-Ni left at 550.** Lever for the lead (out of WP2 scope): cap per-rock yield (sol.json `maxAmount`) or
let extraction time keep growing past 18 s for large rocks. Flight fuel MEASURED ≈ 16 kg per hop
(410 kg over 25 hops, net of processing), so processing runs several times before the first trip.

**Verification (fresh page per run).** `audit` pass (10 options, 17 items; no cycles, no unreachable,
no over-capacity (largest 1,212 ≤ 2,000), no He-3 gates, no lunar-only basics); `reqs` 10/10 (each
missing piece named, analysis spent once). `playA` / `playB` (fresh-save playthroughs through the shared
`pathToDrive`, 200 kg start): pass; a premature pr1 is refused naming `research:th1`/`lg1` (A) or
`lg1` + `sourceClass:c_type` (B); 24 / 39 accepted mines; Earth → Moon preview ok. `seeds`, `guidance`,
`difficulty`, `exploits`, `site` (ln1 refused without Volatile Mapping, 30 → 20 Ti after the analysis),
`migrate,tx,shared` pass. `sessionA` 1–3 pass: Earth → Luna 1 leg, 206 kg, arrived in the field; canister
recovered with real G; sv2 + ln1 + suite crafted and equipped from 2 lunar rocks. `sessionB` part 1 pass.
Gate fixes: `guidance` expected a completed project to stay tracked (WP1 B14 clears it); `shared`, `tx`,
`site`, `exploits`, sessions updated to the new matrix. Typecheck clean; lint 0 errors (132 warnings).
**Not run:** `sessionB` parts 2–5, `sessionC` (they start from part 1's state or grant their own
material; nothing in them depends on the changed recipes beyond part 1).

**WP2 review fixes (2026-11-17).** (1) `sourceClass` evidence reads the 64-entry source ring, so a
depleted, oldest C-type could be evicted and re-lock sv1/pr1; `planInspection` now never evicts the last
record of a class (`fit` gate `classKept`: one C-type survives 70 S-type inspections; negative control
with the exemption off fails, `cKept: false`). (2) Worlds that unlocked pr1 / ln1 before th1, lg1, sv2
became prerequisites: a project's research step is met ("… not needed") when a completed option requires
it (`guidance` gate `legacyPrereqs`); no schema bump. (3) The canister comms line now says the suite
needs Volatile Mapping and more titanium. (4) The `fit` gate bookmarked a depleted source, which WP1 B4
refuses; it now bookmarks an unmined one.
**Pace verdict (unresolved, needs the lead).** The pace gate's minutes are an **expert lower bound**
(no wandering, misses or deaths). `paceSummary` also reports the spec §5.5 new-player estimate
(1.4 × real minutes + 18.5 min of new-player overheads) and passes only if the bot lands in 25–50 min
AND the estimate in the owner's 60–90 min. Fresh default run (11 runs): pr1 7.6, drive 18.4, field
**21.7 min** (10 rocks, 206 kg trip) → estimate **42.6 min: FAIL**. Capped run (`PACE_MAX_MINE_S=13`):
42.8 → 70.4 min, pass. Per step (min) default / capped: sink 1.7/1.7, batch 0.2/0.2, th1 0.2/0.2, sv1
3.1/3.1, lg1 0.2/0.2, pr1 0.2/0.2, radiator 1.8/1.8, rack 3.3/4.7, **drive 5.7/27.6**. Radiator and
rack do sit between pr1 and the drive, but in the capped economy the drive is a 28-min single grind.
The lever is not the drive's Fe-Ni (2,000-unit craft rule) but large-rock yield vs the 18 s extraction
cap. A per-rock yield cap ≈ 185 units in the origin belt (what a 13 s rock yields) would reproduce the
capped run's economy; alternatives are a lower yield exponent or extraction time that keeps growing.
Not changed here: it is an economy decision for the lead.

### Playtest 1 polish, WP3: HUD (as built, 2026-11-17)

Items B9, B10, B11, B13, D3, D5, D7, D8, D12, D16, the HUD half of D2 and the shared parts of D6
(spec `playtest1-design.md` §1.1-1.6, 1.12-1.14, §2, §3.1-3.6).

**Homes (one per concern).** *Target Card* (`HUD/TargetCard`): inside the reticle root, so it follows the
nose; 232 × 104 px, four fixed 22 px rows (header + distance, facts, contents, actions), flips left near
the right edge, centred below the reticle under 600 px. Kinds: rock, survey site, wreck, placed point,
placement preview. It owns the keys: **[M]** mines / stops, **[G]** inspects a rock, recovers the site,
sets a point active; a refusal plays `ui.reject` and shows its reason on the chip (`2.5 km`, cargo
`Full`, heat `Cooling`); G with nothing focused only rejects. *Notification Stack*
(`HUD/NotificationStack`, `store/toast.ts`): replaces the toast column, the hint strip, the cargo delta
rows and the world-space loot text; top-left under cargo, 300 px, max 4 items (2 under 600 px), fixed
44 px items, newest on top, one lifetime table (info 4 s, success/warn 6 s, tip 8 s, no per-call
durations), same-title items within 1.5 s merge their values (`Mined +12 [Si] …`), hover pauses, click
dismisses. Hints are `tip` items; one is offered only while the stack has room and enters the played
registry when shown. *Dashboard*: 280 px, fixed rows SPEED, ASSIST (text only when decoupled), FUEL,
HEAT (bar, tick at 80 %), POWER, BOOST, HULL (floor-rounded, wrench while repairing) and ONE status line
(collisions off > empty tank > resource reason > reserve > fuel low); the mining heat bar and the
recovery row are gone, so HEAT is the only heat display. *Transit panel*: 288 px, top-right below the
settings gear, rows always rendered (plan: name + chips, ETA, FUEL, LEFT, status; active adds phase +
leg, SPEED, DIST); km/s with one decimal, `8,412 km` / `356k km`, `mm:ss`; a refusal keeps the last good
numbers greyed and changes only the status line; chips `2 legs`, `Coast`, `Obstacle` (4 s after a
proximity brake, replacing that toast). Speed and distance are written by a 10 Hz rAF writer into fixed
slots. Phones: the panel takes the tracker's slot.
**Focus → act for non-rocks** (`store/interact.ts`, ticked at 20 Hz by `InteractFocus`): sites (until
recovered), wrecks and non-starter points are ray-tested along the ship's nose, lock cone
max(angular radius, 1.5°), same lock timing and ring as rocks; a rock in front keeps the rock. Within
5 km such a marker is a card target, not a transit destination (POIProjector skips it). The canister: one
G runs a 4 s scan, then `site.inspect` + `site.recover` back to back (ops unchanged for saves); arrival
1.5 km, inspect = recover range 2 km; the tracker's site row and `hint_site` are gone.
**Keys.** Craft C, Projects P, pulse mining and place-point unbound, `activatePoint` removed (Interact
G). `keybinds-v3` migration: actions still on their v2 default move to the new key unless another
action already holds it (then unbound); custom keys untouched. All in-text keys are `KeyChip`s (follow
rebinding); panel-button titles read the binding. Hotbar slot i is key `(i + 1) % 10`; digit keys
`preventDefault` (the kit's key focuses the name input in the same keydown, which typed the digit into
it: found by the `hud` gate). The replication kit takes a hotbar slot on craft or salvage (count shown);
its key opens the NEW POINT card with the default name focused and selected; Enter places, Esc / the key
cancels (Esc never opens Settings while placing); pointer lock stays engaged.
**Inspect sound.** `mining.inspect.start` / `.loop` (emitter for the scan) / `.complete` on the UI bus,
synthetic placeholders in `public/audio/sfx2d/` from `pnpm gen:audio-placeholders`; also on the site
scan; the old `click.soft` is gone.
**Strings.** Notifications ≤ 4 words + an icon row (`Mined`, `New material`, `Unlocked` + item icons,
`Crafted`, `Fuel delivered`, `Transit refused` + reason, `Autopilot off`, `Stopped short`, `Point placed`,
`Canister recovered [Ti] +30` …); hints ≤ 10 words (spec §1.5; `hint_research`, `hint_kit`, `hint_site`
retired but still valid ids); comms per §1.6 (the canister line keeps WP2's Volatile Mapping note);
transit refusals short (`Blocked by Luna`, `Needs 8 kg fuel`, `Out of range: needs 900 kg`, `No fuel
(reserve is for manoeuvring)`, `Not enough fuel`); dashboard reasons per §1.3; replication refusals per
§1.12; wreck markers are just `Wreck` (contents on the card). Marker distances below 100 km now show one
decimal, like the card. Panel toasts (craft, research, processing, salvage) use the new API with the
short §1.7/1.8/1.11 titles; the panels themselves are WP4.
**Deviations.** The placement card's warn chip reads `No fuel source` (spec `… known`; the longer text
does not fit the fixed card beside the name input; the full sentence is its tooltip). A placed point's
card shows a muted `Respawn point` in its otherwise empty contents row. The transit panel sits at top
72 px, not 16 (the settings gear occupies the corner the spec's wireframe missed); on phones the panel
buttons move left of the gear and the cargo block narrows to 140 px (they overlapped before WP3).
Project step texts lost their hard-coded keys (`Research X`, `Craft X`, `Recover the survey canister`);
the remaining project/tracker wording is WP4.

**Verification (fresh page per run; captures opened and judged).** New `gameplay-hud.mjs`:
`hud` at 1280×720 and 390×844: 13 states each (idle, rock focused, inspecting, inspected, mining, mined,
placement, placed point, wreck, survey site, transit plan, transit active); every state: 0 intersections
among stack items, card, tracker, transit panel, dashboard, hotbar, panel buttons, cargo and the settings
gear, all inside the viewport, card kind as expected; the name input focused with `Point 1` fully
selected. Voice table sampled at 10 Hz during a real G inspection: `mining.inspect.start`, `.loop`,
`.complete` all present (both sizes). `hudTransit` (Earth → Luna far side, 2 legs via Luna, 60 ms
samples): 1280: 931 samples, width 288 throughout, heights 118 (plan) / 178 (active), 2 height changes,
0 without a state change; 390: 926 samples, width 366, 78 / 98, 2 changes, 0 without. `hudSite` (real T
to the lunar field, gaze-lock the signal, real T to it): arrived 1.543 km from the canister, card
`SURVEY SIGNAL … [G] Recover`, one G → scanning, recovered, Ti 0 → 30, 0 `ui.reject`, stack `Canister
recovered Ti +30`. `hudKeys`: v2 defaults → C / P / pulse [] / place [] / no activatePoint; custom
(K, N, J) kept with Projects → P; `brake: c` → Craft left unbound (profile restored after). `hudHotbar`:
key 1 used the slot-0 patch kit (3 → 2), key 0 the slot-9 heat sink (2 → 1), labels `1234567890`, a
crafted kit lands in slot 1, its key opens placement with the name selected, typing `Camp 2` (its own
slot digit) keeps placement open, Enter places `Camp 2`, Esc cancels without Settings.
Regression (updated for C, the hotbar kit, short refusals, `Wreck` markers, one-G recovery): `site`,
`guidance`, `transit` (pure), `res`, `repairEdge`, `place`, `salvage` (a salvaged kit now takes a hotbar
slot and a hint may show mid-test: excluded from the "nothing changed" comparison), `live36`,
`m37narrow`, `SHELL_PARTS=title,continue,lock`, `PHYS_PARTS=liveOwner` (standard: flag absent / `Collisions off · dev speed` / absent, dv 461 → 100 HP) pass. `pnpm check:audio` 0 problems; `__audio.selftest()`
true; typecheck clean; lint 0 errors.
**Not run:** `sessionA` part 3 (updated for the one-G recovery; needs parts 1-2's carried state),
`m37shots`, `transitShots`, the other session parts.

**WP3 review fixes (2026-11-17).** A kit is slotted once when it arrives (craft, salvage, load), so
"Clear slot" sticks; a full bar shows `Hotbar full` + the kit (Loadout can drag it in). `G` on a wreck
in salvage range is a no-op, not a reject. Hints leave the stack when their condition stops holding;
`hint_lock` shows while nothing is locked (it showed on lock, contradicting the card). Transit panel:
SPEED cut (the dashboard is speed's one home), `FUEL` → `BURN` (trip cost vs tank), active height 158;
the marker's `· ~46s transit` suffix cut (ETA lives in the panel). Markers: labels declutter
(targeted, then focused, then the rest; estimated boxes, no per-frame layout reads) and hide under HUD
homes; edge arrows slide out of HUD homes (rects read every 100 ms). Card: site/wreck/point use 3 rows
(82 px), point shows `Respawn point` + `Active`/`[G] Set active`, scrim 0.95. Phone comms sit 8 px above
the dashboard (clear of the card). Gate fixes: the reject sampler read `v.event`, but voices carry
`eventId`, so `rejects === 0` could never fail (now fixed, with a positive control `farRejects` 5);
`hud` homes include comms; `hudHotbar` gains `kitClear` and `kitFull`. Not changed: the round `N`
bottom-left is the Next.js dev indicator; tracker step wording is §1.10 (WP4).
Re-run on fresh pages: `hud` 1280 + 390 (13 states, 0 intersections, `wreckG` far 5 / in range 0),
`hudSite` (1.539 km, recovered, 0 rejects, Ti 0 → 30), `hudTransit` 1280 (913 samples, w 288,
h 118/158) + 390 (910, w 366, h 78/98), `hudHotbar` + `hudKeys`, `guidance`, `place`, `salvage`.

### Playtest 1 polish, WP4: panels and remaining text (as built, 2026-11-17)

**Shared.** `ReqChip` (state glyph + kind icon + ≤ 3-word label, tooltip = the requirement in ≤ 8
words; specs from `requirementChip()` in `requirements.ts`, pure), `ReqAnyGroup` (`1 of` bracket),
`AnalysisChips` (flask + `ResourceIcon`, red `have/need` when short), `ValueChip` (material / fuel /
item, also used by the stack). `nodeProgress()` counts an option's pieces (evidence, any-of group,
analysis materials) and is the one fraction shown on research cards, research project rows and the
tracker. `Panel fixedHeight`: `min(640, 100vh − 96)` (tier 1: 480), body scrolls with a stable
gutter; on phones the header wraps (tabs and counters under the title).
**Research.** Header `Research 1/10` + tabs; cards fixed 112 px (name + fraction ring or `Ready`
dot; chips, research prerequisite first; footer = analysis chips → unlock item icons (tooltip: name
and effects) + `Unlock`). Ready cards have an ok left rule; cards blocked by an unmet prerequisite
are at 70 %; per branch: ready, then by fraction, then blocked. Unlocked options leave the grid for
one `Unlocked` strip. No intro, purpose line or status words. Discoveries: 7 material icons with
scan/pick glyphs, 4 trial chips (`Beam 8 s`, `First batch`, `First craft`, `Transit leg`),
`Sources n · mined m`, rows = class badge, `r 140 m`, `ResourceIcon` composition, bookmark toggle
(name field when bookmarked), `Set destination` icon only with the drive; empty state
`Inspect rocks with [G]`.
**Projects.** One list (authored + research), sorted: started by fraction desc, then 0/x, then
completed collapsed to `✓ name` with no buttons; ties authored first, then name. No subtitle, summary
or section heading. Step lines: state glyph + kind icon (flask, wrench, fuel, orbit, pin, point) + short
text (`Research X`, `Craft X`, `412 / 280 kg`, `Reach the lunar field`, `Recover the survey canister`,
`Place one in lunar space`); an open research step shows its chips. Tracker: same icons and chips (max
3); a tracked research project shows the option's name, its pieces fraction and chips (it showed
`Research: X 0/1` with a duplicated step). Records trimmed to the §4.4 texts (`Respawn`, `Survey
canister` titles).
**Crafting.** Filters `All · Drive · Scanner · Mining · Cooling · Cargo · Propulsion · Hull · Utility
· Consumables · Processing`, only categories with an unlocked blueprint (`craftCategory()` in
`content.ts`; the drive is `Drive`, no `ItemSlot` change). Ingredients and the cargo row are
`ResourceIcon`s (tooltip name + have/need). Workshop: `Fuel processing` ([H] 1 → 20 kg, tank bar,
stepper, `200 kg · 20 s`, `Process` / bar + `Cancel`), `Hull repair` ([Fe] 1 / %, hull bar, cost or
`Hull intact`, `Repair` / `Stop`). Confirm note `Equips automatically` / `Slot in use: equip in
Loadout [L]`, else none. Loadout preview labels per §1.9.
**Death / respawn.** Title `Ship destroyed` (abandon: `Respawn`), one `Wreck` row of value chips,
fallback line `{point} blocked|unavailable: respawn at {Origin}`, buttons `Respawn at {point}` and
`Respawn at Origin point` → `Respawn at Origin point? {point} stays your active point.` (Back /
Respawn). Settings button `Respawn` → `Respawn at {point}?` + `Wreck keeps` chips, `Cancel` /
`Respawn`. `FALLBACK_TEXT` removed. The "kept" sentence lives in the `Respawn` record.
**Gate** `GAME_PARTS=panels` (gameplay-panels.mjs), fresh world with 2 inspected classes, 1 trial,
Heat Rejection unlocked, a crafted kit; both sizes PASS:
- panel box constant across tabs and states: Research 760×624 (options, discoveries, after +40 Si
  made a card ready, scrolled to the strip), Projects 560×624 (+ Records), Crafting 640×624 over all
  11 categories; at 390×844 every panel 359×640. Research cards all 112 px.
- real-mouse hover: requirement chip → `Inspect an S-type rock`; source `ResourceIcon` → `Silicates`;
  recipe icon → `Fe-Ni metal · 10 / 15`.
- Projects order (both sizes): `4/5, 3/4, 2/3, 2/3, 1/2 (forward point, authored wins the tie),
  3/6, 2/4, 1/3, 1/4, 1/4, 1/6, 0/6, 0/3, ✓ Heat Rejection`; the completed row has 0 buttons;
  `.pp-section` 0; no subtitle.
- Crafting tabs exactly the 11 in order; `Drive` lists only `Transit Drive`.
- Death screen `SHIP DESTROYED · WRECK 52 10 14 30 5 ×1 200 kg · RESPAWN AT ORIGIN POINT`;
  respawn confirm `Respawn at Origin point?` + chips; the Settings button reads `Respawn`.
- Text budget (scripted, own text of every visible element; numbers, units, key chips and entity
  names excluded; comms and Records excluded): tracker > 3 words: 0; Research/Projects/Crafting/
  death/confirm > 8 words: 0, at both sizes.
Regression on fresh pages: `guidance` (6/6), `m32` (incl. `emergency` via `[data-action=respawn]`),
`death,recover`, `marks,migrate4` (Set destination is an icon button now: gate reads its
aria-label), `sessionC` parts 1-2, `hud` 1280 + 390, `SHELL_PARTS=title,continue`. Typecheck clean,
lint 0 errors / 129 warnings. Gates updated for the new strings: m32, m33, m36, m37.
**Not changed:** a stale `Unlock` press still raises `Cannot unlock` (spec: reject sound only; kept
as the only feedback for a race); the respawn confirm's wreck row omits the running batch's
unconverted feedstock (the reducer still puts it in the wreck); the faint `click to steer` prompt
under the death screen is the WP1 pointer-lock prompt, untouched here.

### Playtest 1 polish: player-flow walkthrough (2026-11-17)
A new player's opening played end to end with real keys and clicks where practical (fast-forward to
the drive only through accepted operations), at 1280×720 and 390×844, every screen captured in
order (`.captures/walk-NN-*.png`, `-n` = phone) and `__audio.voices()` sampled per step: title →
new world → opening comms + naming → first rock (lock, G inspect, M mine) → gains → Research →
first unlock → Craft → fuel batch → Projects (track) → drive → transit plan / spool / cruise /
arrival → survey canister → kit from the hotbar → ramming death → respawn at the point.
Fixed from the captures:
- Tracker `Research ready N` counted evidence only; it now uses the panel's Ready rule (evidence +
  analysis in the hold). It said 2 while the panel showed one Ready card.
- Research opens scrolled to the first Ready card (phones: Heat Rejection sat below the fold).
- `Fuel delivered` carries `N kg` and plays `notify.info`; `Process` / `Repair` click on accept,
  `Cancel` / `Stop` click soft. Starting and finishing the first batch were silent.
- A processing refusal no longer parks in the dashboard status line (stack only): it read
  `Processing refused: Batch running` long after the batch had ended.
- `Point placed` / `Active point set` play `notify.info` (were silent).
- Projects hint only while nothing is tracked (it appeared after the player had tracked one).
- Marker labels hide inside a 96 px box round the reticle while the Target Card shows (the card
  names the target; the label sat on the placed beacon's glow) and under the spool ring (it
  crossed the locked target's distance label). Moving the ring down instead put `Hold [T]` on the
  ship model on phones.
- Owned one-time items show their recipe neutral (the drive read `172/550` in red next to `Owned`).
Seen, not changed (outside the spec): ~10 unlabelled off-screen edge arrows on every view (stars and
planets; doubled arrows where two share a direction); the start view shows only a sliver of Earth at
the left edge; the comms avatar is `?` for the named AI; on respawn with the fuel in the wreck the
`Fuel low: process hydrates` hint fires with an empty hold; a just-placed point's label sits on its
glow until the point is focused.

**Walkthrough re-run (fresh worlds, 1280×720 and 390×844).** Three more fixes from the captures.
(1) The survey canister moved from Luna-frame [5200, 1200, 0] to [3400, 1900, 0] km: measured at the
default epoch it sat 18.7° from the anti-Sun direction with the Moon 19.0° wide from there, i.e. in the
umbra, so the canister and the ship drew black for the whole recovery (weeks either side of the start
date). The shadow is a ≤ 1,753 km cylinder along the anti-Sun line, which stays in the ecliptic, so a
point 1,900 km off the ecliptic is never in it. 3,895 km from the Moon's centre (outside 2 R); nearest
loaded rocks ~7 km (the old spot's were ~200 km); the hop from the field arrival stays one leg. (2) The spool ring is concentric with the 96 px steering ring (112 px,
text under it); it was offset 60 px and cut through it. (3) While a panel is open the Notification
Stack keeps to the gutter beside it (newest item only on phones, hidden 600–1047 px): items showed
through the glass and were cut at its edge. Also: `Fuel low` now needs hydrates aboard (the respawn
case above), and opening/closing placement plays `click.soft` (was silent). Still seen: the luna_belt
anchor (+3,400 km on x) is itself in lunar shadow at the default epoch; Projects sorts 3/3 research
rows above `Reach the Moon` 1/6 (§4.3 rule as written).

**Pace lever: beam throughput cap (playtest 1 follow-up).** Yield grew as r^1.6 while extraction time
is capped at 18 s, so units per second rose ~25× from a 50 m to an 800 m rock and the default world
reached the lunar field in 21.7 min (new-player estimate 42.6). A field's `yield.throughputPerS` now
caps a rock at `throughputPerS × computeMiningDurationS(r)` (base duration: the speed upgrade shortens
time, not yield), inside the deterministic reward, so inspection, Target Card, discoveries and the mine
operation agree; ±15 % jitter stays. MEASURED with the pace gate on fresh default worlds: 14 u/s
→ 22.4 / est 43.5 (fail; WP2's 13 s-capped run only differed by restricting the bot to small rocks),
7 u/s → 36.3 / 61.9, **6 u/s → 38.9 / 65.3 (pass)**: pr1 13.9, cargo rack 22.3, drive 36.0, arrival
38.9 min, 25 rocks. origin_belt 6 u/s, luna_belt 17 u/s (lunar refuel and Ti loops unchanged; gates
pass). The pace bot now refuels below 80 kg from any hydrates aboard (at 6 u/s it flew the tank dry
keeping hydrates for recipes). playA/playB mine 52/70 rocks (were 24/39); no gate expectation changed.

**Playtest 2: fuel gate, lunar lighting, drive milestone.** (1) The drive spent whatever fuel was aboard
up to the ideal flip-and-burn (2·c·√(a·d)); its only hard floor was the 600 s coast bound, 7.8 kg for
Earth → Moon, so raising `transitKgPerKmps` alone could not make the trip need more than 600 kg without
making a 50 km hop cost ~60 kg. Transit now also bills `transitKgPerKm` (0.0019 kg/km, covered distance,
not difficulty-scaled: a progression floor); the leg reserves perKm × aim distance before it buys speed
(the law sees leg fuel minus that), so prediction and execution still share one law, and the coast stays
flat. `transitKgPerKmps` 0.006 → 0.003. `needKg` (distance fuel + the coast bound) is the refusal number:
above the tank `Tank too small`, else `Not enough fuel`; the route panel shows NEED / TANK rows. MEASURED
offline with the compiled `simulateTransit` (Earth field → lunar field arrival, field offsets included):
path 339,894-420,652 km over a year (6 h steps) → need 650-803 kg; at the default date 699 kg (base tank
refused), full Auxiliary Tank 797 kg burnt, ETA 46 s, 203 kg left; perigee 2941-10-13 need 670 / burn 766;
apogee 2941-09-29 need 784 / burn 888; worst (2-leg) 2941-12-22 need 800 / burn 924, 76 kg left. Hops:
5 km 0.35 kg, 50 km 1.28, 500 km 4.7, 5,000 km 21.4; field arrival → canister 2,018 km 11.4 kg, miss 0.02 km.
Manual (untargeted) flight brakes when the tank empties. `Reach the Moon` adds a `tank` step (820 kg:
Craft / Equip Auxiliary Tank Mk1, unlocked by lg1 before pr1) and its fuel step is 820 kg unscaled.
(2) luna_belt's anchor sat in the Moon's shadow (phase 166°). New anchor [-850, 3290, -200] km and
canister [-1225, 4740, -290] (1,500 km radially out): Sun-Luna-field phase 75.2° at the default date,
75-105° over the year, 3,290 km off the ecliptic (shadow ≤ 1,753 km), route from the Earth field passes
≥ 3,487 km from Luna's centre. Old saves: lunar chunk deltas/discoveries keyed by the old field no longer
match its rocks (accepted); wrecks and points are frame-relative and stay where they were. (3) Crafting the
drive plays `drive_online_001` (AI, one line, points at the tank); `hint_drive` waits for it.
Live round (dev server back): base tank at Earth targeting Luna shows `Tank too small`, NEED 701-703 /
TANK 600 (new gate `transitTank`); full aux tank, default date 45.9 s / 802 kg predicted == executed
(198 kg left), second date 867.7 kg. Pace on a fresh world (bot fixed: tank after the drive, hydrate rock
when fuel is low, respawn when both fuels are 0): arrival 47.8 bot min (drive 39.3, fuel to 900 kg 8.1
min), new-player estimate 76.1; `throughputPerS` unchanged. Lighting: at the anchor above, the arrival
point's phase was 63° and Luna read as full (no terminator on the visible disk; a phase probe at
0/63/90/120° confirmed the render: only 90° and up read as half or crescent).
Anchor moved again to [1130, 3195, 273] (canister [1629, 4605, 393]): arrival phase 95° at the default
date (52-128° over month and year), field 70-110° over the year, never shadowed (≥ 3,195 km off the
anti-Sun axis), Earth field → arrival 347-420k km. `lunarShots` captures Luna half lit, rocks and canister lit.
Review fixes (offline, same sim code): `plan.needKg` now scales each leg's need by its `legBudget`
share, so NEED equals the least fuel that flies (measured within 0.6 kg at 1 and 2 legs; it was up to
15 kg low on 2-leg routes). Fuel step 820 -> 900 kg: 820 arrives but takes 104-203 s at the far epochs,
900 takes ≤ 61 s everywhere. Manual (untargeted) transit reserves its stop's distance fuel and brakes
while ordinary fuel still pays it (protected allowance: ≤ 0.06 kg drawn; before, every manual run to
an empty tank drained all 60 kg). A drive built with the aux tank already fitted plays `drive_online_002` instead.
