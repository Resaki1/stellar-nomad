# Stellar Nomad — Gameplay and story direction

**Status:** agreed direction, 2026-11-15. Captures the design discussion that happened
after the original roadmap was written. These decisions were not in the implementing
Claude Code session's context. No gameplay implementation is included in this change.

**Read with:** [ROADMAP.md](ROADMAP.md) for milestone order and
[M3_GAMEPLAY_PLAN.md](M3_GAMEPLAY_PLAN.md) for the first implementation slice.
This document supersedes the premise, prescribed progression, and narrative direction
in the root [STORY.md](../STORY.md), [GAME_DESIGN.md](../GAME_DESIGN.md), and
[COMMS_IDEAS.md](../COMMS_IDEAS.md). Those files are historical references, not competing
requirements. Existing equipment or UI conventions can be reused where compatible.

## 1. Product identity

Stellar Nomad is a space exploration, resource management, survival, and construction
sandbox. The player develops the ability to explore a physically convincing universe,
operate independently, and build useful infrastructure wherever they choose.

Real distances and sizes, astronomical data, realistic lighting and eye adaptation,
and a strong sense of place remain central. Flight stays approachable: assisted 6DOF
and an accessible transit mode, rather than mandatory orbital mechanics. The target
hardware remains a MacBook M2 Pro. More systems must not mean simulating every distant
object at full detail.

The intended pleasures are discovery, satisfying work, useful engineering choices,
ownership, expanding independence, and quiet moments in spectacular places. Scarcity
creates decisions; repetitive upkeep is not the source of longevity.

## 2. Agreed gameplay decisions

| ID | Decision | Consequence |
|---|---|---|
| G1 | Exploration is player-directed. | No ground-control campaign prescribing the next destination. |
| G2 | Expeditions are the central loop. | Notice an opportunity, investigate, prepare, travel, work, then convert results into capability, knowledge, or infrastructure. |
| G3 | An expedition can be one-way. | Establishing a new foothold or continuing onward is a valid outcome; returning is optional. |
| G4 | Earth is a starting region, not a required home. | Players can leave permanently, relocate repeatedly, settle elsewhere, or remain nomadic. |
| G5 | Basic self-sufficiency travels with the ship. | Basic scanning, mining, research, fabrication, fuel processing, and repairs must work away from Earth. |
| G6 | Progression branches. | Different loadouts, discoveries, preparations, and resource sources provide viable approaches. Avoid a compulsory planet-by-planet recipe chain. |
| G7 | Geography matters through opportunities and constraints. | Concentration, accessibility, processing, hazards, and useful locations matter more than arbitrary element exclusivity. |
| G8 | Research rewards relevant discovery and use. | Universal assay farming and long countdowns do not remain the main progression gate. |
| G9 | Scanning answers useful questions. | Move from broad indications to close inspection and physical confirmation; preserve useful findings. |
| G10 | Survival shapes activity and preparation. | Propellant, power, heat, and hull are the initial pressures. No food, thirst, oxygen, or archive care. Safe inactivity has no upkeep cost. |
| G11 | Fuel limits travel; infrastructure expands reach. | Later refineries, extraction drones, and supplied depots can make long routes sustainable. |
| G12 | Automation removes mastered repetitive work. | Players establish and configure operations, then explore or build further. No recurring random drone failures or maintenance rounds. |
| G13 | Drone programming uses UI jobs, filters, priorities, and conditions. | Useful defaults first; scripting is not required. |
| G14 | Spectacular places are rewards in their own right. | Resource wealth must not be the only reason to explore. Support discovery records and sharing experiences. |
| G15 | Co-op is the same game played together. | All essential work remains solo-capable; roles emerge from equipment and player preference. |
| G16 | Research and useful discoveries are shared world progress. | Friends do not repeat individual research grinds. Ships, equipment, carried supplies, and active replication selections remain individual. |
| G17 | The ship AI supports player intentions. | Contextual hints, explanations, observations, and optional records; no mandatory mission-control chain. |
| G18 | Existing features may be changed or removed. | Compatibility with this direction takes precedence over retaining every old recipe, consumable, or research node. |

### 2.1 Freedom and progression

Support three compatible approaches: travelling self-sufficiently, developing a favourite
location, and building a distributed network. Players can change approach during a save.
Stations offer capacity, efficiency, specialization, and convenience; they do not make
basic survival or research possible only at a fixed home.

Early equipment can have straightforward numerical benefits. Later equipment should
also change activities: sustained extraction, better prospecting, efficient hauling,
long expeditions, and working in demanding environments. Avoid a single final loadout
that is best at everything. Keep the existing slot model for the first slice; a complete
ship-construction or mass-budget overhaul is not implied.

No basic element is declared Moon-only merely to force a journey. The original lunar
helium-3 abundance and helium-3-dependent early equipment recipes are not canonical.
Future helium-3 extraction may be an industrial project; it is not the starter fuel.

### 2.2 Future regional opportunities

This table is a direction, not a required route or an M3 content checklist.

| Region | Opportunities | Distinctive considerations |
|---|---|---|
| Earth vicinity | Accessible materials, starter infrastructure, remnants of humanity | Learn self-sufficiency; Earth provides no living resupply service. |
| Lunar region | Survey records, equipment salvage, geological samples; later surface processing | Orbital activities first. Surface resources wait for terrain and landing. |
| Main belt / Ceres | Industrial deposits, volatile sources, extraction operations | Bulk processing and transport networks. |
| Inner system | Strong solar energy, specialist observations and industry | Solar heating and thermal design become meaningful. |
| Jupiter system | Scientific targets and eventual atmospheric resources | Radiation, demanding approaches, probes, later atmospheric collection. |
| Saturn system | Ring exploration, ice harvesting, bulk processing | True-scale local material and moving frames, rather than a dense fictional wall of giant rocks. |
| Outer system | Remote volatile sources and unusual bodies | Independence, supply planning, long expeditions; no simplistic instant-freezing hazard. |
| Other systems | New environmental combinations and potential settlement sites | Observe remotely, investigate locally, then choose where to establish capability. |

Existing astronomical objects can remain visible and reachable without every region
already having its full gameplay. Do not remove free exploration to enforce this table.
Mark known astronomy and invented/generated content honestly as those systems develop.

### 2.3 Travel and sustainable infrastructure

Keep manoeuvring and transit as the two main player-facing flight regimes. Boost is a
short burst within local flight. Interstellar capability arrives later. Fuel planning
must support both return trips and onward journeys.

Real scale with short journeys already needs a substantial fictional concession.
Do not describe the present transit acceleration or superluminal performance as
demonstrated conventional propulsion. Exact transit/interstellar physics and fiction
remain a later decision; M3 must not quietly commit to a relativistic campaign,
time-dilation twist, mandatory gravity assists, or global time acceleration.

A later production station harvests a local resource and refines fuel. A relay depot
without such a source receives deliveries. UI-configured transport jobs keep routes
supplied. Throughput and buffers should be understandable and stable: expanding demand
may justify an upgrade, but a completed operation should not demand constant attention.
Nearby drones can be detailed; distant operations use resource-conserving aggregate
simulation. No requirement for hundreds of full physics bodies.

## 3. Replication and loss

### 3.1 Agreed recovery model

1. Players build and place standalone replication points. Placement is free-form in
   usable open space, not restricted to a fixed list of settlement locations.
2. The last point successfully placed by a player automatically becomes that player's
   active point. Placing another player's point in co-op must not change everyone else's
   selection.
3. An existing point can be explicitly activated while visiting it. A casual visit does
   not silently overwrite the selection.
4. On destruction, restore at the last activated valid point. Earth is not a special
   mandatory destination.
5. Cargo and remaining ordinary fuel stay at the destruction site as recoverable salvage.
6. Knowledge, discoveries, permanent ship/module progression, and the archive survive.
7. Points require no fuel top-ups, repair rounds, or archive maintenance. There are no
   random point failures. A starting point provides initial recovery.
8. Emergency abandonment uses the same loss and restoration model. It must always be
   accessible when the player cannot reasonably recover a stranded ship.

Placement must reject geometry intersections and immediately lethal spawn locations.
Store frame-relative poses and revalidate safe emergence on recovery. "Anywhere" does
not mean inside a planet. No KSP-style orbit setup is required.

### 3.2 Implementation defaults adopted for M3

These fill small gaps in the agreed model; they are defaults for the first slice,
not claims that every quantity or edge case was explicitly chosen in discussion.

- Restore the current permanent ship build, its manufactured modules, and full hull.
  Do not force reconstruction of the whole equipment tree after a crash. Ordinary
  carried consumables count as lost cargo; installed/permanent equipment does not.
- Supply a small protected recovery allowance separately from ordinary propellant.
  It can power recovery flight but cannot be salvaged, transferred, sold, used as
  crafting material, or multiplied by dying. Normal fuel at the wreck excludes it.
- A freely placed point in empty space can be farther from resources than that allowance
  reaches. Do not pretend a small reserve solves arbitrary placement. Keep normal
  recovery at the active point, but provide an explicit emergency fallback to the
  protected, supplied starter point. This costs the current expedition's location and
  carried supplies; it is not a menu for teleporting between arbitrary points.
- Points persist when deactivated. M3 does not need dismantling, attack damage, point
  inventories, or station construction. Missing/invalid active IDs fall back safely.
- Recovery does not roll research or discoveries back to the time of activation.
  A replication point is a recovery location, not a save-game restore slot.

Recovery reserves and replacement hulls are intentional gameplay abstractions. Do not
invent an elaborate maintenance economy to justify respawning. The same fiction accepts
mind backup and replication; the exact physical manufacturing explanation is deferred.

## 4. Agreed story premise

| ID | Decision | Boundaries |
|---|---|---|
| S1 | The player is a Von Neumann-style autonomous ship/probe intelligence. | Not the old human ESA astronaut character. Whether originally uploaded or artificial is open. |
| S2 | Humanity launched the project to seek places where humans could live as it approached self-destruction. | The project supplies context, not a compulsory mission chain. |
| S3 | Technical complications delayed the player's operational awakening. | Begin near Earth after humanity is gone. No exact year or centuries-long delay is fixed. |
| S4 | Earth is uninhabitable for humans. | Define this as a setting fact; the catastrophe and possibility of far-future restoration remain unspecified. |
| S5 | The player carries an archive preserving the possibility of restoring humanity. | Genetic/biological and cultural details are open. Do not assert that ordinary data copying alone creates viable embryos. |
| S6 | Replication points preserve copies of the archive. | Losing a ship destroys one copy, never the possibility of pursuing the goal. |
| S7 | Finding a suitable world and establishing a human colony is an optional endgame ambition. | Players may instead explore or build indefinitely. Achieving it does not terminate the sandbox. |
| S8 | The archive has no care mechanics. | No coolant chores, decay, survival meter, inventory burden, countdown, or permanently missable colony goal. |

The companion AI remains distinct from the player's intelligence. Preserve the existing
player-chosen AI name. Write sparse, contextual dialogue and optional records. No live
ground control, sister-message arc, withheld embryo revelation, compulsory Proxima
destination, or named antimatter-drive campaign is carried forward from the old story.
Co-op can represent additional probes/minds; the exact origin of each guest is not an
M3 requirement.

Earth's premise does not authorize an Earth lighting, texture, atmosphere, or cloud
rewrite in M3. Preserve the physically calibrated renderer. Exact visual evidence of
the catastrophe is later art/world work.

## 5. Scope and decision status

The agreed direction does not put every feature into M3. That milestone proves a solo,
nomadic Earth/lunar-orbit loop, including simple replication. M4 adds co-op. M5 adds
larger shared infrastructure and automation. M6–M9 supply the environments and tools
needed for the broader regional and interstellar loops. Colony gameplay remains a
later, separately scoped project, not an unannounced M9 or M10 dependency.

### Still open; not blockers for the M3 slice

- Exact catastrophe, calendar, elapsed activation delay, character origin, and archive
  contents. Avoid invented historical specifics in mandatory opening text.
- Exact transit technology, interstellar drive rules, and how scientific extrapolation
  is presented in later generated systems.
- Detailed station construction, drone job UI, remote operation time model, and production
  balance. The direction is agreed; their implementation belongs to M5's own plan.
- Habitability evaluation, biological restoration technology, colony construction, and
  post-colony activities. No pregnancy, childcare, population, or city simulation is
  implied by the premise.
- Exact recipes, fuel capacities, recovery allowance, equipment counts, and difficulty
  multipliers. These are measured playtest values, not narrative decisions.

When implementing, preserve the decisions above, use the explicit M3 defaults for
unspecified details, and record consequential changes in both the relevant plan and
the roadmap. Do not reopen the whole concept merely to tune a number.
