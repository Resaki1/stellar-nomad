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

**Construction and access.** Open Industry from the ship menu or press its rebindable shortcut, B by default. A ship can fabricate a depot kit from 125 units of Fe–Ni metal and 90 silicates. Select the kit on the hotbar to aim it 800 m ahead, then confirm. Opening placement from Industry lets the builder choose a name first. The depot uses the existing body frame. Replication stays available through standalone points. Place another depot at the destination to create a relay. Each depot has 6,000 units of shared cargo space, a separate 3,000 kg propellant tank and two drone berths. Transfers and job changes require a ship within 2 km. A distant replicant can monitor and track the depot.

**Production.** The Earth prospect sits in the starting belt's volatile-rich debris. A second prospect lies inside the lunar field. Build within 30 km of a prospect to send an extraction drone. A prospect is a hand-placed extraction area. Its current yield comes from a replenishing pool. Individual asteroids keep their own mining and depletion records. Nearby extractors draw from the same available yield. A refinery processes one stored hydrate unit into 20 kg of ordinary propellant in two active seconds. A relay can also refine hydrates delivered to it. Depot fabrication takes materials from shared storage.

**Dispatch.** Each drone has one assignment, an ordered list of eligible resources, a home fuel reserve and a destination stock limit. New extraction jobs fill the remaining cargo space. Existing per-resource stop levels are preserved and can be cleared in the job editor. A hauler chooses the first eligible payload with free space at its destination. Its maximum load is 40 material units or 120 kg of propellant. The authority funds both legs in advance. The home reserve is extra fuel kept for other jobs. A stop request during flight allows the current trip to finish. If conditions change en route, undelivered cargo returns with the drone. The shared transit planner checks body clearance and can add a waypoint. Use the displayed travel time and fuel estimate when setting up an interbody route.

**Persistence.** Save schema 7 migrates existing worlds with empty industrial infrastructure. The solo authority and co-op worker run the same one-second simulation steps. The clock discards suspension gaps. Meaningful transfers of inventory or fuel are persisted before the host publishes them. Countdown updates travel as changed records and use the regular checkpoint. A closed world earns no production. [Industry simulation](../src/sim/industry/simulation.ts) · [Authority transcript](../scripts/coop-transcript.mjs)

**Contact.** The station's rendered hull and Rapier collision boxes share dimensions. The host compares overlapping segments of recent ship trajectories and sends a single contact to each participant. Clients discard old contacts after a teleport, respawn, transit or timing gap. Mined rocks scatter locally simulated fragments. The near-field budget is 48 dynamic fragments within 3 km, each living up to 1.8 seconds. Fragments interact with fixed geometry. Mining yields continue through the shared asteroid operation. [Contact resolution](../src/sim/session/pilotContact.ts) · [Near-field physics](../src/sim/physics/nearField.ts)

## Reproducing the release checks

Start the development server with `pnpm start`. Supply its URL to the browser drivers. The drivers launch Chrome with audio muted. The two-browser fixture grants building materials and moves ships between sites. Crafting, placement, stock contention, route assignment, elapsed flight, withdrawal, reload and rejoin go through the running game. This check uses the development invite service and direct WebRTC. The M5 Vercel preview supports solo play. Its branch origin is outside the staging invite service's configured origins. [Hosted signaling setup](../services/coop-signal/README.md)

```sh
pnpm coop:transcript
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
| Earth to Luna, two rendered Chrome profiles, direct WebRTC | Both ships claimed the final unit in a depot. One gained it and the other saw a refusal. Starting with 12 kg of ordinary fuel, the Earth depot ran an extractor, a refinery and a hauler. The host reloaded immediately after dispatch. The guest rejoined and received the original 8 kg at Luna, withdrew 5 kg, and observed a second 120 kg shipment. Both browsers and IndexedDB ended at **123 kg**. No manual refill occurred after the bootstrap. |
| Portable authority | The Earth–Moon fixture measured about 370,000 km and budgeted 32 kg for the round trip. The run covered a stale fuel report, duplicate deposit, blocked recovery-point placement, out-of-range extraction, pause, a suspension gap, restart and a failed durable write. |
| Industry controls | The desktop walkthrough constructed two named depots, moved fuel and materials, fabricated both drones and configured a working filter and priority order. Touch emulation exercised placement, the manifest and the job editor at 390 × 844. The relay received a shipment and the hauler stopped after returning. The build screen also fit at 844 × 390. |
| Storage on small screens | At 390 × 844, 844 × 390 and 568 × 320, the transfer controls stayed within 1 px of the bottom as the inventory scrolled. The landing view showed two complete items at the first two sizes and one at the smallest. All four transfer buttons had at least 44 px of tap height. |
| Placement controls | Tested depot and replication kits in windowed and fullscreen Chrome, and at 390 × 844 with touch emulation. The hotbar entered placement directly. The Cancel buttons, right-click and ship-menu shortcut preserved fullscreen. Chrome accepted and released the Escape keyboard lock during placement. The keyboard test used DevTools input. |
| Drone flight and rock contact | A 1,348-frame WebGPU recording showed the extractor accelerating out of the depot, braking into a hover, fading its beam and returning with cargo. The ship struck the visible hydrate rocks at 35 m/s. All three rock colliders aligned with their meshes and unloaded when the ship left the area. |
| Guest drone motion | Withheld incoming updates from a WebRTC guest for 1.65 seconds during outbound flight. In two runs of 144 frames each, the longest observed stops were 0 ms and 50 ms. Peak speeds were 33 and 44 m/s against medians of 22 and 25 m/s. |
| Cockpit access | With a second replicant connected, Chrome checked the actual click targets for Cargo, Crew, Research, Crafting, Loadout, Projects, Industry and the ship menu at 17 widths from 320 to 1440 px. All were on screen and unobstructed. Hiding the HUD hid the toolbar. The Industry button opened its panel and the ship menu returned control to flight. |
| Ship contact | In two Chrome profiles, gentle contact at 2 m/s moved the other ship and dealt zero hull damage. At 40 m/s, both received one 23 m/s contact response and lost approximately 1.79 HP. Dropping guest pose messages and crossing the last displayed position caused zero contacts. |
| Existing worlds and co-op | In Chrome, pre-M5 save migration and round trips, crafting transactions, death, salvage and shared research passed. Two peers raced a shared rock, retried a lost reply, reopened the host and mined a lunar rock while the host stayed at Earth. Crew research notifications, fuel sharing and rendezvous markers also passed. |
| Busy worlds | The authority transcript exercised 24 depots and 48 drones. Its 33,332-byte update reached the guest in parts, with the largest packet in that case measuring 6,396 bytes. A later transfer preserved all 155 imported cargo entries in the guest's mirror. |
| Station contact and debris | A 2.3 m/s approach stopped at the hull with 100 HP. A 40 m/s impact caused one damage event. Fragments rebounded off fixed geometry and expired after a real asteroid destruction. The 48-body cap held and the ship's cargo stayed constant. |
| Station frame cost | Muted Chrome with Metal WebGPU at 1280 × 720, DPR 1, 180 vsync frames per case. At an 800 m standoff in the Earth frame, adding one depot took the local GPU pass from 0.570 to 0.674 ms at p50 and 0.851 to 0.911 ms at p95. Mean physics step time went from 0 to 0.062 ms and draw calls went from 35 to 43. This measures one nearby depot. |
