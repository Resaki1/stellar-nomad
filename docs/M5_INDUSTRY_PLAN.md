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
