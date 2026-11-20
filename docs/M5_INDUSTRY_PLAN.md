# M5 · Depots and drone routes

A replicant can carry construction supplies to a useful source, build a refinery there, and send a drone to keep a second depot stocked. Another replicant can draw from that stockpile while the builder explores elsewhere. A ship retains its onboard mining, processing, fabrication and replication options throughout. [Gameplay and story](GAMEPLAY_AND_STORY.md) · [Milestone roadmap](ROADMAP.md)

## Player journey

1. **Choose a site.** From flight, find the industrial controls through the ship menu. Before spending anything, see what construction costs, where the depot will go and whether the site supports extraction. A relay is still useful away from a source.
2. **Commission a depot.** Give it a recognizable name. Its physical model, navigation target and management panel should identify the same place. Visiting replicants can transfer ordinary fuel and materials within service range. The panel should explain a full hold, insufficient materials or an out-of-range action before the player has to guess.
3. **Establish production.** Use the depot’s stores to fabricate equipment and operate local extraction and refining. Show the inputs, outputs, available space and what has stalled. A parked ship owes no upkeep.
4. **Supply a destination.** Assign work through the depot interface. The player chooses what to carry, where it goes, which job gets priority and how much fuel to retain. A drone must be able to afford the return before departing. At a full destination or empty source, it should wait and resume when conditions improve.
5. **Leave and return.** Fly out of sight while a friend uses the relay. Both players should see the same jobs and deliveries. When the host reopens the world, resume from the saved leg, including any payload already in flight.

## Implementation boundaries

| Area | Contract |
| --- | --- |
| Authority and save | Solo and co-op use the same TypeScript rules. Construction, transfers and assignments are validated commands. A successful action changes the world and its paying ship together. The world owns depot stores, drones and cargo aboard them. Replaying a command must leave the totals intact. |
| Time and movement | Advance work on active simulation time. Camera distance only changes how the work is drawn. Closing the world suspends work. Persist enough of the route to recover between departure and delivery. Use the existing body frames and kilometre coordinates. |
| Navigation and controls | The ship menu is the discoverable entry point. Controls must also work on a narrow touch screen, while typing a name, while a co-op command is pending, after a refusal and when returning to flight. |
| Near-field physics | Stations have a visible, collidable hull. Contact between replicants needs explicit ownership and freshness limits so stale network poses cannot deal repeated hits. Keep the flight model and existing high-speed/transit collision rules. Mining fragments are short-lived and budgeted. They carry no salvage entitlement. |
| Future milestones | M6 can supply new field shapes and resource distributions. M7 can supply surface sites. Neither is required to build the first route. The worker, IndexedDB and renderer stay outside the portable domain rules so a community server can run those rules later. |

## Acceptance checks

- A new player can find and understand construction, storage and route assignment on desktop and a phone-sized viewport. Exercise success, unavailable actions, interruption and return to flight through real controls.
- Check construction and inventory changes against quantities before and after each accepted or refused command. Race shared stock, retry an acknowledged or unacknowledged spend, test full storage, reserve limits, idle time and a save from before M5.
- Run two muted Chrome profiles over WebRTC. Operate two drones, station one replicant at the depot and move the other away. Check a supply cycle without a manual refill, host restart, rejoin, and a second delivery. Inspect both replicas and the saved state.
- Check ship contact with a station and with another replicant, latency gaps, clearance when arriving, the transit speed gate and the mining-fragment budget. Record the observed behaviour and a near-field cost sample.
- Keep the M3 solo survival and M4 shared-rock, restart and remote mining regressions passing. The physical iPhone and unassisted M4 expedition playtests remain tracked in the [co-op plan](M4_COOP_PLAN.md).

## Implemented rules

**Construction and access.** Open Industry from the ship menu or press its rebindable shortcut, B by default. A ship can fabricate a depot kit from 125 units of Fe–Ni metal and 90 silicates. Choosing either kit opens the same placement card. Aim 800 m ahead, keep or edit the proposed name, and confirm with a primary click in flight, Enter or the Place button. Select the other kit to switch. Industry lets the crew rename built depots and player-built replication points. The depot uses the existing body frame. Replication stays available through standalone points. Place another depot at the destination to create a relay. Each depot has 6,000 units of shared cargo space, a separate 3,000 kg propellant tank and two drone berths. Ship transfers require a replicant within 2 km. Crew anywhere in the system can manage the depot, fabricate station equipment from its own stores, or dispatch a drone.

**Research.** Bulk Handling unlocks depot kits, utility drones and replication-point fuel tanks for the crew. It requires a first fabrication, a completed propellant batch and 30 Fe–Ni metal. Controlled Extraction unlocks asteroid mining assignments. Station Refining costs an additional 10 hydrates and 15 Fe–Ni metal after Bulk Handling. Locked controls show their research requirements and let a replicant spend the analysis materials aboard their ship. Previously built installations and owned kits remain usable.

**Production.** A mining drone searches within 30 km of its depot for actual asteroids in the field. Choose all rocks, any of the selected asteroid classes, or rocks containing any of the selected resources. A trip brings home the rock’s yield, including co-products. Mining by a drone or a replicant depletes the same rock. A finite neighbourhood can run out of suitable ore. The construction panel lists nearby fields and can set a navigation target. The existing Earth and lunar hydrate landmarks remain visible in flight. A depot can refine hydrates mined locally or sent from elsewhere into 20 kg of ordinary propellant per unit, in two active seconds.

**Dispatch.** Each drone has one assignment, a home fuel reserve and an optional per-item stock limit. New delivery jobs start with an empty loading list and destination. Leaving the stock limit blank uses all available receiving space. Drafts are kept per drone while navigating Industry. New extraction jobs fill the remaining cargo space. Existing per-resource stop levels are preserved and can be cleared in the job editor. From a receiving depot, Request delivery selects an available drone at a source depot. The drone remains based at its source. A hauler chooses the first eligible payload with free space at its destination. Its maximum load is 40 material units or 120 kg of propellant. The authority funds both legs in advance. The home reserve is extra fuel kept for other jobs. A stop request during flight allows the current trip to finish. If conditions change en route, undelivered cargo returns with the drone. Basic drones use a 140 m/s approach speed near structures. A clear route can link two depots in the same asteroid field, including across its diameter (6,000 km at Earth, 4,000 km at Luna). Depots outside a shared field can still exchange supplies locally within 30 km in the same body frame. The ETA includes accelerating, braking and docking. Interbody delivery would require a different craft. An already-funded trip from an older save can finish with its original cargo and schedule.

**Flight and fuel.** Within 3 km of each endpoint the drone uses its docking profile (18 m/s², up to 140 m/s). Between the two approaches it can accelerate at 50 m/s² until halfway, then brake. Propulsion uses the starter ship's ordinary fuel-per-velocity-change model, scaled to a 1,200 kg dry drone. Cargo mass increases the burn. The propulsion tank holds 120 kg and is separate from up to 120 kg of propellant carried as freight. The depot funds a return with undelivered cargo and the drone brings unused propellant home.

| Clear route in one field | One-way time | Propulsion reserved for a 120 kg fuel shipment, including return |
| --- | ---: | ---: |
| 4 km | 37 s | 0.57 kg |
| 2,000 km | 7 min 25 s | 42.47 kg |
| 4,000 km | 10 min 11 s | 60.30 kg |
| Just under 6,000 km | 12 min 18 s | 74.09 kg |

**Replication fuel.** A player-built recovery point can accept a 1,200 kg tank. Bring 120 Fe–Ni metal and 50 silicates to install it. Local transfers and drone deliveries fill it with ordinary propellant. Respawning draws from the point up to the ship’s ordinary tank capacity. The existing protected reserve still supports recovery at an empty or unequipped point.

**Persistence.** Save schema 8 preserves existing infrastructure, assigned flights and shared discoveries. Previously placed points start without an added fuel tank. The solo authority and co-op worker run the same one-second simulation steps. The clock discards suspension gaps. Meaningful transfers of inventory or fuel are persisted before the host publishes them. Countdown updates travel as changed records and use the regular checkpoint. A closed world earns no production. [Industry simulation](../src/sim/industry/simulation.ts) · [Authority transcript](../scripts/coop-transcript.mjs)

**Contact.** The station's rendered hull and Rapier collision boxes share dimensions. The host compares overlapping segments of recent ship trajectories and sends a single contact to each participant. Clients discard old contacts after a teleport, respawn, transit or timing gap. Mined rocks scatter locally simulated fragments. The near-field budget is 48 dynamic fragments within 3 km, each living up to 1.8 seconds. Fragments interact with fixed geometry. Mining yields continue through the shared asteroid operation. [Contact resolution](../src/sim/session/pilotContact.ts) · [Near-field physics](../src/sim/physics/nearField.ts)

## Reproducing the release checks

Start the development server with `pnpm start`. Supply its URL to the browser drivers. The drivers launch Chrome with audio muted. The two-browser supply fixture starts with industrial blueprints and building materials, and moves ships between sites. The research walkthrough starts in a fresh world. Crafting, placement, stock contention, route assignment, elapsed flight, withdrawal, reload and rejoin go through the running game. This check uses the development invite service and direct WebRTC. The M5 Vercel preview supports solo play. Its branch origin is outside the staging invite service's configured origins. [Hosted signaling setup](../services/coop-signal/README.md)

```sh
pnpm coop:transcript
pnpm drive -- --no-isolate --url http://127.0.0.1:3000/ run:scripts/drive-examples/industry-research.mjs
pnpm drive -- --no-isolate --url http://127.0.0.1:3000/ run:scripts/drive-examples/replication-fuel.mjs
POINT_FUEL_TOUCH=1 pnpm drive -- --no-isolate --url http://127.0.0.1:3000/ run:scripts/drive-examples/replication-fuel.mjs
pnpm drive -- --perf --no-isolate --url http://127.0.0.1:3000/ run:scripts/drive-examples/structure-targeting.mjs
pnpm drive -- --no-isolate --url http://127.0.0.1:3000/ run:scripts/drive-examples/structure-names.mjs
pnpm drive -- --perf --no-isolate --url http://127.0.0.1:3000/ run:scripts/drive-examples/placement-controls.mjs
pnpm drive -- --perf --no-isolate --url http://127.0.0.1:3000/ run:scripts/drive-examples/m5-drone-motion.mjs
pnpm drive -- --no-isolate --url http://127.0.0.1:3000/ run:scripts/drive-examples/industry-ui.mjs
INDUSTRY_UI_TOUCH=1 pnpm drive -- --no-isolate --size 390x844 --url http://127.0.0.1:3000/ run:scripts/drive-examples/industry-ui.mjs
COOP_PARTS=industry pnpm drive:coop -- --perf --size 768x432 --url http://127.0.0.1:3000/ run:scripts/drive-examples/coop-check.mjs
COOP_PARTS=pilotContact pnpm drive:coop -- --perf --url http://127.0.0.1:3000/ run:scripts/drive-examples/coop-check.mjs
pnpm drive -- --perf --no-isolate --url http://127.0.0.1:3000/ run:scripts/drive-examples/m5-physics.mjs
```

## Playtest evidence

| Check | Observed result |
| --- | --- |
| Finite mining | A C-type rock yielded 12 silicates, 6 hydrates, 3 Fe–Ni metal, 1 sulfur and 1 carbon. Two finishing drones could collect it only once. Both peers and the reopened save agreed on depletion. A failed disk write left the rock and journal intact. |
| Research and remote access | A two-replicant authority test opened a version 7 world with an existing kit. The kit could be placed. Fabrication of new hardware required the appropriate crew research. A replicant at Luna could commission a refinery using the Earth depot’s materials after their crewmate unlocked it. A remote request to withdraw materials to their ship was refused. |
| Recovery in the cockpit | Desktop and 390 × 844 touch Chrome both opened the targeted point, installed its tank, transferred fuel, requested a delivery and reloaded. A respawn drew the resulting 118 kg of ordinary fuel from the point and retained 60 kg protected. |
| Recovery stock contention | Simultaneous recoveries at one full 1,200 kg tank allocated 1,000 kg to the ship with auxiliary tanks and the remaining 200 kg to a base ship. Both retained their protected reserves. Tests covered stale telemetry, replay, storage-write failure and reloading. |
| Local supply route in co-op | Two connected replicants contested the last cargo unit and an unassigned drone. One claim succeeded in each race. A guest configured a 2,000 km route remotely. With 12 kg of startup fuel, the Earth depot mined a real rock, refined its hydrates and dispatched a hauler. After the host restarted, the guest received 18.178 kg at a depot 4 km away and withdrew 5 kg. A second shipment delivered 99.439 kg. Both browsers and the saved world agreed on **112.618 kg** remaining. |
| Funded trips from earlier saves | The previous 30 km model charged 4 kg for a 4 km round trip and scheduled 223 s per leg at 29.99 km. The portable authority rejects new interbody routes. A saved interbody trip retained its countdown, delivered to the remaining space, and returned its excess cargo once. |
| Loaded freight | A 40-unit ore shipment crossed 2,150 km in 460 s each way. Its departure reserved 73.376 kg. Reloading preserved the manifest. With the home tank full on return, the drone kept its unused fuel aboard until there was room and refunded it once. A 5,998 km Earth chord fit 37 material units within the propulsion budget. |
| Industry controls | The desktop walkthrough constructed two named depots, moved fuel and materials, fabricated both drones and configured a working filter and priority order. Touch emulation exercised placement, the manifest and the job editor at 390 × 844. The relay received a shipment and the hauler stopped after returning. The build screen also fit at 844 × 390. |
| Storage on small screens | At 390 × 844, 844 × 390 and 568 × 320, the transfer controls stayed within 1 px of the bottom as the inventory scrolled. The landing view showed two complete items at the first two sizes and one at the smallest. All four transfer buttons had at least 44 px of tap height. |
| Structure targeting | Both close interaction and distant waypoint acquisition use one second of aim for depots and replication points. Manual Track and Untrack act immediately. |
| Placement and names | In windowed and fullscreen Chrome, both kits switched directly from the hotbar, accepted a name while steering, and supported primary click, Enter and the on-screen action. Occupied placements preserved the kits. Cancel, right-click and the ship-menu binding preserved fullscreen. Chrome also accepted the temporary Escape keyboard lock. Touch emulation covered both orientations. Changing either structure’s name survived reload. On approach the measured gap between the depot symbol and its name was 8 px. |
| Hydrate rock contact | The ship struck the visible hydrate rocks at 35 m/s. All three rock colliders aligned with their meshes and unloaded when the ship left the area. |
| Guest motion during network delay | In a 144-frame WebRTC guest trace, the test held incoming updates for 1.65 s during outbound flight. The longest mid-leg stop was 0 ms, median speed was 116 m/s and peak speed was 140 m/s during correction. |
| Cockpit access | With a second replicant connected, Chrome checked the actual click targets for Cargo, Crew, Research, Crafting, Loadout, Projects, Industry and the ship menu at 17 widths from 320 to 1440 px. All were on screen and unobstructed. Hiding the HUD hid the toolbar. The Industry button opened its panel and the ship menu returned control to flight. |
| Ship contact | In two Chrome profiles, gentle contact at 2 m/s moved the other ship and dealt zero hull damage. At 40 m/s, both received one 23 m/s contact response and lost approximately 1.79 HP. Dropping guest pose messages and crossing the last displayed position caused zero contacts. |
| Existing worlds and co-op | In Chrome, pre-M5 save migration and round trips, crafting transactions, death, salvage and shared research passed. Two peers raced a shared rock, retried a lost reply, reopened the host and mined a lunar rock while the host stayed at Earth. Crew research notifications, fuel sharing and rendezvous markers also passed. |
| Busy worlds | The authority transcript exercised 24 depots and 48 drones. Its 33,332-byte update reached the guest in parts, with the largest packet in that case measuring 6,396 bytes. A later transfer preserved all 155 imported cargo entries in the guest's mirror. |
| Station contact and debris | A 2.3 m/s approach stopped at the hull with 100 HP. A 40 m/s impact caused one damage event. Fragments rebounded off fixed geometry and expired after a real asteroid destruction. The 48-body cap held and the ship's cargo stayed constant. |
| Station frame cost | Muted Chrome with Metal WebGPU at 1280 × 720, DPR 1, 180 vsync frames per case. At an 800 m standoff in the Earth frame, adding one depot took the local GPU pass from 0.570 to 0.674 ms at p50 and 0.851 to 0.911 ms at p95. Mean physics step time went from 0 to 0.062 ms and draw calls went from 35 to 43. This measures one nearby depot. |
