# M4 — Private co-op worlds

## 1. Start with two players and one rock

**First playable test.** Two people open the game in separate browsers. One opens a solo world to
friends. The other follows an invite. They see each other's ships, aim at the same asteroid, and finish
mining it at nearly the same time. Both see the rock disappear. Exactly one hold receives the correct
yield. Run the race in both arrival orders. When the guest wins, disconnect them after the host commits
but before the reply arrives. Rejoin, retry the same action, then restart the host. The rock stays gone
and the cargo is awarded once.

Repeat with the host near Earth and the guest mining near the Moon, outside the host's streamed region.
Compare the lunar rock's identity, position and yield against solo play. The host must be able to
resolve the operation from world data while continuing to render Earth. This second run proves that
friends can go on independent expeditions in one solar system.

**Status, 2026-11-19.** M3 and M4.0 are on `main`, including the co-op playtest fixes in `35f7bd4`. M4.1 has passed local direct and relay tests. Its remaining exit gate is the two-device staging playtest. [Roadmap](ROADMAP.md) ·
[M3 design and as-built log](M3_GAMEPLAY_PLAN.md)

**Release target.** One host plus up to three guests in a private world. Players can invite a friend
mid-session, share a finding, deliver fuel, split up, and return to their own ships next session. Solo
can play entirely locally once game assets are available, using the same gameplay rules and its existing
pause behavior. Desktop hosting and desktop/mobile guests are the first support targets. Mobile hosting
earns support through the lifecycle tests in §8. [Agreed gameplay direction](GAMEPLAY_AND_STORY.md)

## 2. Ownership and the path from M3

| State | Who decides | What peers see |
|---|---|---|
| World time, asteroid depletion, discoveries/evidence, research, wrecks, placed replication points | One host authority per world | Shared knowledge and relevant world records at a committed revision |
| Cargo, ordinary/protected fuel, processing, hull, loadout, death, active replication point | Owned by an individual player and committed by the host | The owner gets their playable state. Other pilots see public consequences such as a wreck or a transfer receipt |
| Steering, transit presentation and contacts with fixed local geometry | Each pilot simulates their own ship. Friends' sessions trust bounded flight observations | Other pilots receive poses and activity flags. Network silence cannot impart an impulse or cause damage |
| Personal tracked project, bookmarks and comms history | Per-player record in that world | Only that player restores them on rejoin |
| Camera, graphics tier, input, volume, HUD layout | Each device | Local only |

M3 already provides a typed command union, reducers, `LocalAuthority`, per-chunk asteroid deltas and a
world save containing players keyed by ID. Extend those. The current `runOperation` samples local
collectors before submission, and several world events tell the UI which slices to reread from process
memory. A remote client needs the committed values. Give the existing bridge a local or remote authority
at session start. Have both feed the same UI update path. Audit direct writers to cargo, modules, hull,
fuel and pose, including collectors at save time. Each durable value needs one writer in a hosted
session. [Authority](../src/sim/world/authority.ts) · [Commands](../src/sim/world/commands.ts) ·
[Operation submission](../src/store/operations.ts) · [World bridge](../src/store/worldBridge.ts) ·
[Save ownership](../src/save/types.ts)

The ship has a fixed 120 Hz step, driven today by an accumulator inside `useFrame`. The ephemeris clock
also advances from rendered frames. The near-field physics instance, entity alias for the local ship,
active save, and difficulty lookup each assume a local process. Keep camera and fixed-rock contact
simulation on the pilot's device. Pass explicit world, player, clock, content and difficulty into the
host's operations. Move only dependencies actually used by an operation behind that boundary.
[Ship update](../src/components/Spaceship.tsx) · [Simulation clock](../src/store/simTime.ts) ·
[Entity lookup](../src/sim/entities.ts) · [Near-field contacts](../src/sim/physics/nearField.ts)

## 3. Serving a world

**Host.** Opening a world to friends checkpoints solo state and hands sole write ownership to a session
authority in a dedicated Web Worker. Route the host player's actions through the same command path as a
guest. Keep a single writer lock across the handoff, including another tab trying to open the same
world. If exclusive ownership or initialization fails, keep the last good solo checkpoint and explain
why hosting could not start. Closing hosting drains accepted work, saves, closes connections and hands
the committed state back to solo. [Active save and writer lock](../src/save/activeSave.ts) ·
[IndexedDB transaction](../src/save/saveDb.ts)

**Clock and suspension.** The worker owns a monotonic session tick and the mapping to astronomical epoch
and rate. Publish periodic clock samples. Each client evaluates ephemerides for the common instant and
smooths small timing corrections. Flight, processing and resource costs use executed gameplay steps.
Opening Settings releases that pilot's controls and leaves the shared clock running. Bound catch-up
work. A long host scheduling gap or missing heartbeats puts clients into “Waiting for host”, blocks new
spends and freezes prediction at a safe point. Resume from a fresh baseline. Device sleep produces no
accumulated fuel burn, collision damage or production. A worker isolates ordinary render hitches, but
the OS can suspend the entire process. Measure both the worker and the main-thread WebRTC/message
bridge. [Browser lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)

**Flight and resources.** Start with the existing local flight and static-rock solver. Send disposable
poses separately from numbered, reliable batches of executed activity needed for survival accounting,
such as delivered thrust, mining time and contact outcomes. Let the host apply the shared resource rules
once against the player's loadout and stores. Tag a spend or transfer with the latest required activity
sequence so it cannot overtake prior fuel use. Each authoritative ship update includes the last activity
sequence applied. The pilot corrects their preview to that baseline and reapplies any valid outstanding
steps. A respawn or rejoin starts a new movement generation and invalidates old inputs. Preserve
reserved transit braking fuel. Exercise loss of connection mid-burn and mid-batch against the M3 safe
abort and processing rules. [Resource step](../src/sim/ship/resourceStep.ts) ·
[Transit rules](../src/sim/ship/transitDrive.ts)

**Portability.** Keep command execution and the session state machine in TypeScript callable with an
injected clock, world repository and transport. The browser adapter handles IndexedDB and WebRTC. A test
adapter can supply memory, a controlled clock and two clients under Node. Run the shared-rock transcript
there without a DOM, WebGPU, React, a browser save singleton, or a signaling service. A future community
host can replace storage with disk and accept browser connections via a server transport. It can take
authority over motion/contact when shared rigid bodies or public play require it. Its first
compatibility test will be importing a browser world and running the same transcript with two clients.
Server distribution, administration, public discovery and automatic host migration are later product
decisions.

## 4. Invites, transport and motion

1. **Invite.** The host selects **Open to friends** and receives a shareable link and short expiring
   code. An invited guest sees the world name, host, slot availability and compatible version before
   joining. A full room, expired code, incompatible build, unreachable host and failed relay each get a
   distinct recovery action. Closing the invitation stops new admissions. Closing the world ends play
   for everyone and leaves the save with its owner.
2. **Connect.** Use one WebRTC peer connection per guest in a star. A small signaling room exchanges
   offers, answers and ICE candidates. Keep it available for late joins and ICE restarts. STUN helps
   establish a direct path and TURN relays traffic when needed. An established direct session can keep
   playing through a signaling outage. The signaling service holds room membership and expiring
   connection data. The host holds the save.
   [WebRTC peer connections](https://webrtc.org/getting-started/peer-connections)
3. **Reliable, ordered channel.** Carry the handshake, commands, settlements, committed state,
   clock/control messages and reconnect snapshots. Chunk and pace large snapshots and bound queued
   bytes, so a slow joiner cannot stall existing peers. Use plain, serializable typed messages with
   runtime bounds at ingress. Keep transport-specific handles out of the game model.
4. **Unordered pose channel.** Start around 15 Hz, with zero retransmits. Include entity ID, sequence,
   movement generation, session tick, system/frame ID, frame-relative position in km, velocity in km/s,
   orientation and visible activity. Preserve the sim's numeric precision until profiling justifies a
   tested encoding. Drop stale poses and superseded sends under backpressure. Interpolate nearby ships
   between timestamped samples, cap extrapolation on packet loss, and clear or transform the buffer on a
   frame change. A respawn immediately resets it. Remote ships produce local lights, exhaust and spatial
   audio from their visible state. Their interpolated poses are visual inputs. Ship-to-ship contact
   belongs with M5's shared physics work. [Data channels](https://www.w3.org/TR/webrtc/#rtcdatachannel)
   · [Snapshot interpolation](https://gafferongames.com/post/snapshot_interpolation/)

Send distant friends at navigation-marker fidelity. Transmit global knowledge once and stream relevant
changed chunks on approach. Clients independently render procedural geometry, atmosphere, lighting and
quality tiers. World identity includes the system, generation version and canonical parameters. Today's
asteroid generator uses each field's seed, shape, chunk size and generation limits. A local
draw-distance or performance setting must never change which rock a command addresses. Cache bounded
headless chunk lookups if profiling warrants it. [Chunk generation](../src/sim/asteroids/generation.ts)
· [Reward calculation](../src/sim/asteroids/resources.ts)

**Hosting cost and LAN.** Keep the existing web origin for the private prototype. The candidate
signaling deployment is a Cloudflare Worker with a short-lived SQLite-backed Durable Object per room.
Verify current allowances before deploying. On 2026-11-18, Workers Free supports these objects, and
Cloudflare lists 1,000 GB/month of shared TURN/SFU egress free, then $0.05/GB. Issue short-lived relay
credentials on the backend to admitted peers, limit invite attempts and observe relayed bytes per
player-hour. Asset delivery has its own budget. Revisit Vercel Hobby's non-commercial terms before
commercial release.
[Signaling service limits](https://developers.cloudflare.com/durable-objects/platform/pricing/) ·
[Relay pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/) ·
[Relay credentials](https://developers.cloudflare.com/realtime/turn/generate-credentials/) ·
[Vercel Hobby](https://vercel.com/docs/plans/hobby)

On the same Wi-Fi, the normal invite flow can negotiate a LAN path where network and browser policies
permit it. An internet-free *cold launch and join* also needs locally available assets and local
signaling. A packaged host or a two-way offer/answer exchange are candidates for a later offline-LAN
experiment. Verify that feature with the WAN disconnected before launch on both devices.
[ICE address handling](https://www.rfc-editor.org/rfc/rfc8828.html) ·
[Offline assets](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Offline_and_background_operation)

## 5. Commands, identity and recovery

**One mining operation.** A guest submits the stable target `(systemId, fieldId, chunkKey, instanceId)`
and the completed activity reference. The host resolves the rock and checks the actor's recent
frame-relative position, beam progress, state, depletion, equipment and cargo capacity. It derives yield
using the same generator, tuning and difficulty as solo. Serialize concurrent completions at the host.
The first valid completion commits depletion, the M3 cargo/overflow result and discovery evidence
atomically. The second receives an already-depleted result and no grant. An optional short mining
reservation can give earlier feedback if playtests find the race frustrating. The commit rule also works
without reservations. [Current miner-supplied claim](../src/sim/asteroids/mineOperation.ts) ·
[Reducers](../src/sim/world/reducers.ts)

**Reliable commands still need retry semantics.** Give each world/player command stream a monotonic
sequence, a stable operation ID and one in-flight durable intent for v1. Keep the outstanding intent
across a guest reload. Bind the actor to the connection and check the active session generation. Persist
the terminal outcome and processed sequence with the affected state before reporting success. A
definitive rejection also consumes its sequence. On a lost reply, replay the last outcome. For an older
sequence, return the processed watermark and resynchronize. For a gap, request the missing intent.
Rebinding a returning player fences their old connection. A bounded history of recent receipts helps
diagnose issues, but the persistent watermark survives eviction. M3's receipt limit is 256.
[Receipt handling](../src/sim/world/authority.ts) · [Receipt limit](../src/save/defaults.ts)

**Peer permissions.** Decode guest messages into a bounded set of player intents. Check the actor,
target, range, quantity and ownership before applying each one. Keep local developer actions such as
`time.set` and `research.devSet` out of that dispatch table. Bind pose updates to the admitted pilot. M4
trusts that pilot's flight observations around static geometry. Public servers could simulate motion
from player inputs behind the same command and persistence boundary.

**Revision and durability.** Assign a world revision to each committed gameplay change. A commit
includes all affected world and player records, revision and command metadata in the same storage
transaction. Queue submissions while a commit is pending. Publish only after successful persistence. On
a storage failure, keep the previous committed view, pause new mutations and surface retry/export
recovery to the host. Continuous telemetry can be checkpointed at a lower cadence. Before a
consequential operation, bring its relevant activity and pose up to date. Checkpoint a resumable ship
state or a documented safe stopped state for transit, including its fuel reservation. Verify with an
interrupted write and a reload on either side of the transaction.

**Join and resync.** The handshake exchanges protocol version, gameplay-content fingerprint, generator
compatibility, world ID and fresh session generation. A new guest gets a snapshot at revision R
containing world knowledge, relevant chunk deltas, public entities and their own player state. Buffer
subsequent revisions while loading and apply them in order. Include a revision watermark even for
changes private to another player so filtering cannot look like packet loss. A missed revision uses a
bounded catch-up window or a fresh snapshot. On later chunk subscription, send that chunk's
authoritative baseline before applying further deltas. Guests keep session credentials and pending
intent locally. A deliberate import of a full host export creates a new independent world through the
existing save UI.

**Returning players.** Use the current device/profile ID as a local hint. On first admission, the host
assigns a world-scoped player ID and an opaque reclaim credential. Store the credential on the guest and
a verifier with the world's membership. Room codes admit guests and rotate independently of player
identity. A second device with the same display name cannot claim a ship. A guest who loses storage
rejoins as new unless the host explicitly reassigns their old ship. On disconnect, release transient
reservations and checkpoint the player. Gameplay time for the absent pilot stops. Other connected
players can continue. Export/import and save migrations must preserve guest ownership, including worlds
that temporarily have only one member. Audit today's single-player rekey behavior on load and import.
[Device identity](../src/save/playerId.ts) · [Save activation](../src/save/activeSave.ts) ·
[Import/export](../src/save/saveDb.ts)

## 6. Changing gameplay after playtests

**Content IDs travel over the wire. Gameplay definitions live in the catalogue.** Cargo already maps
material IDs to integer units. Crafting already accepts an item ID, and processing accepts a recipe ID
and quantity. Keep those representations through commands, receipts, snapshots, save/export and the UI.
Validate IDs, unit types, capacity and effects against the host's loaded definitions. Use separate typed
quantities for resources with different rules, such as fractional ordinary propellant and protected
recovery fuel. The transport handles delivery and versioning. Resource names, slot positions, balance
constants, recipes and English labels belong to content and domain code.
[Content catalogue](../src/data/content.ts) · [System resource definitions](../src/sim/systemTypes.ts) ·
[Save types](../src/save/types.ts)

| Change after a playtest | Expected implementation and verification |
|---|---|
| Add a mineable material or a recipe using existing mechanics | Add its stable ID, definitions, distribution/recipe and presentation. The existing mining, inventory, transfer, save and snapshot formats carry it. As a gate, add a test-only material and recipe on both peers, mine it, transfer it, craft, reload, and compare results. Transport and session code should have zero edits for this fixture. |
| Tune yield, cost, range or a research requirement | Change the canonical rule once. Solo and host consume the same definition. The gameplay fingerprint changes, while the message format can stay at the same version. Record the policy for in-progress work, such as honoring the inputs already reserved in a batch. |
| Rename or retire content | Keep IDs stable across display-name changes. For a true ID change or removal, migrate saved holdings, recipes in progress, research references and world findings, or preserve retired entries inert with an explicit conversion policy. Test an old save and a rejoin. |
| Add a genuinely new action, such as assigning a drone route | Add a typed domain intent, validation/reducer, persisted state, result and visibility rules. Reuse actor identity, ordered delivery, retries, revision sync and persistence. A new interaction can require a protocol or schema change. Specify it where its semantics are known. |

Track three compatibility decisions independently. **Wire protocol** covers message shapes and meanings.
**Save schema** governs durable migrations. **Gameplay content and generation** govern what a recipe or
rock ID means. For M4, require matching gameplay/protocol versions for a live session and show an
actionable update/reload message before attaching the guest. Exclude visual-only assets and device
quality settings from the gameplay fingerprint. A changed generator that would repopulate a depleted
chunk needs a pinned old generation version or a tested migration for that world. A matching new client
and host alone cannot repair old rock IDs.

## 7. Implementation order after M3

| Slice | Deliverable | Exit gate |
|---|---|---|
| M4.0 · Shared rock | Build the §1 test first. Extend the drive harness to run two isolated profiles with distinct IDs and live saves. Wire only the invite, two channels, remote presence, worker authority, durable command and rejoin path this interaction needs. Local test signaling suffices here. | The contested-rock, dropped-reply, host-restart and remote lunar runs in §1 pass through the normal mining UI. The headless host passes the same command transcript. |
| M4.1 · Host and join | Open a running solo save, share link/code, admit/resume a guest, close back to solo. Add deployed signaling, STUN/TURN, version checks and lifecycle feedback. | Two devices on different networks connect directly where possible and through a forced relay. Expired invites, a full room, incompatible content, duplicate login, sleep and host shutdown recover visibly. |
| M4.2 · Shared M3 loop | Port inspection, trials, research, crafting/equip, processing/repair, site rewards, replication placement/activation, death/respawn and wreck salvage to committed results. Exercise all player-owned writes through the new boundary. | Race site recovery and salvage, switch loadout with a pending spend, die while mining and rejoin mid-batch. Check quantities, ownership and each pilot's chosen recovery point. Existing solo gates still pass. |
| M4.3 · Expedition | Add shareable frame-relative locations, nearby item/ordinary-fuel gifts, readable distant presence and a summary of discoveries since last visit. Validate range, reserves and capacity at commit. Transfers debit and credit together and reject with a reason if the whole requested amount cannot fit. | One pilot surveys and shares a source, another extracts and delivers fuel. They split between Earth and Luna, meet again, and resume their own ships after the host restarts. |
| M4.4 · Release gate | Run the failure, content-evolution and hardware cases in §8. Record measurements with the merged game revision and supported browser/device versions. | A 30-minute two-player expedition and a four-player capacity run meet the agreed budgets. Playtesters can invite, help and rejoin without developer tools. |

## 8. Verification and M5 handoff

Use disposable worlds and independent browser profiles. Build a repeatable fault-injection adapter for
delay, jitter, loss, duplicate intents, disconnect-before-reply and failed writes. Pair it with real
WebRTC tests including a relay-only connection. Run live gameplay with persistence enabled. The existing
drive defaults include isolation for render benchmarks. [Drive harness](../scripts/drive.mjs) ·
[Testing guide](AUTOMATED_TESTING.md)

| Exercise | Evidence to record |
|---|---|
| Race, loss and late join | After the shared-rock race, drop the reply, retry, advance more than 256 operations and replay the old command. Exactly one grant and one depletion survive. Join while another operation commits. Compare shared records/checksums at the same revision and subscription scope, and each private record against its host counterpart. |
| Migration, identity and isolation | Host a pre-M4 solo save, add two guests, close to solo, reopen, export and import. Reclaim each ship, check cargo, active point and research, and verify the guest's own local worlds and device settings. Run two isolated worlds with the same rock IDs. An old-session packet has no effect in either. |
| Rough connections | Start with 120 ms RTT, ±30 ms jitter and 2% simulated packet loss, then add a two-second outage. Confirm immediate local controls, bounded pose extrapolation, no remote collision impulse, a visible reconnect state and one final result for every settled spend. Log input-to-local-response, command-to-settlement, snapshot age, bytes/s, queue depth and direct/relay path. Measure both relay and direct sessions. |
| Host stalls and mobile | Open Settings, briefly block the host presentation thread, background the host, sleep and resume it. Lock/unlock an iPhone guest and change network. Verify active guests continue through ordinary UI pauses. On authority loss, pilots resume from the checkpoint without phantom burns, production, wrecks or a catch-up storm. Record actual recovery times. |
| Frame budget | On an M2 Pro compare warmed solo, host + one guest, and host + three at the same `earth_650` pose, build, DPR and quality. Run once with ships nearby and once with players at Luna. Use `--perf`, report p50/p95 frame and CPU/GPU pass ms, worker tick delay and storage commit latency. Use separate devices for guests. Initial target is at most 1 ms added p95 host frame time versus solo in the separated case, and a 16.7 ms frame budget where solo sustains 60 FPS. Tune snapshot frequency and visibility from measurements. [Measurement protocol](PERF_MEASUREMENT.md) |
| Content extensibility | Run the extra-material/recipe fixture from §6 through solo, two browsers and the Node authority. Compare final holdings and discoveries. Join with an old content fingerprint and verify the explanation appears before any state mutation. |

**Manual release playtest.** Give two players a fresh Standard world and an invite link. Ask them to
establish a lunar foothold together. Observe whether they can locate each other, act on a shared
finding, hand over fuel, separate and resume the next session. Ask what the other pilot contributed and
whether the same objective still felt viable alone. Use that feedback to change the gameplay rules and
catalogue.

M5 can then add a depot as a world-owned entity and a drone job as a domain action. Its first
multiplayer test should put one pilot at the depot while the other is away, with cargo conserved across
deliveries and restarts. Revisit authority over contact when players or drones can physically push each
other. The same headless scenarios will guide a later decision to ship a community server.

## 9. As-built log

**M4.0 · Shared rock (2026-11-18, branch `m4-coop` on `main` a6ce6db, M3 merged).** The §1 test passes in
two headless Chrome profiles and under Node. Code: headless core `src/sim/session/` (host, guest, protocol
with bounded decoders, memory transport/repository with faults), browser adapters `src/net/`, host worker
`src/workers/hostWorker.ts`, IndexedDB repository `src/save/sessionRepository.ts`, local signaling
`src/app/api/coop/signal/` (dev or `COOP_LOCAL_SIGNALING=1` only), `src/components/Coop/`, join card
`src/components/AppShell/JoinPanel.tsx`. Save schema 6: world revision, session generation, members with
SHA-256 reclaim verifiers, per-player command stream `{seq, opId, outcome}` committed in the same
transaction as the change.

- **Yield is derived, not claimed.** `asteroid.mine` resolves the rock from world data
  (`src/sim/asteroids/mineResolve.ts`, headless chunks shared with clearance) with the player's stored
  efficiency and the world difficulty passed explicitly. Solo uses the same resolver. The op carries
  `beamS`; the host requires ≥ 0.8 × the rock's mining time and the pilot's last pose within mining range
  plus slack.
- **Gates.** `pnpm coop:transcript`: 11 Node scenarios (both race orders, dropped reply + retry, host
  restart, lunar remote, > 256 ops then an old replay, old session generation, storage failure, activity
  bounds, hardening). `pnpm drive:coop` + `coop-check.mjs`: 15 browser parts through the normal mining UI
  (race, raceRev, dropReply, restart, lunar, presence, joinCard, reloadPose, lateName, writeGate,
  exportHidden, cancelJoin, handoff, hostFail, leave). Lunar: grant equals the solo resolver and the
  guest's preview; the host streamed 0 lunar chunks and stayed in the Earth frame. Host restart ≈ 8 s to
  rejoin. Existing solo gates pass unchanged.
- **Deviations.** Pilot-owned continuous state (pose, hull, propellant, power, processing progress, comms
  and marker prefs) travels as bounded telemetry, sent every 2 s and with each command, instead of numbered
  activity batches (§3); the host clamps it (tank capacity, protected fuel only falls, processing only
  advances). The host's own client talks to the worker over the worker port, not a separate MessageChannel.
  In a session, jettison, consumable use and hotbar edits are refused until they get commands (M4.1);
  every other non-command writer of host-owned state is blocked (audit table in the branch notes).
- **Findings.** A remote ship's first appearance compiled its own WebGPU pipelines mid-frame (250-500 ms
  task on both pages, occasional `setPipeline` errors from three's `compileAsync` caching an unresolved
  pipeline). Ship slots now mount once per session and precompile before they are shown. One raceRev run
  on a 3.9 s rock went to the pilot who pressed second; commit order is arrival order at the host, which
  is the rule, so the gate now uses rocks of ≥ 5 s to keep the expected winner deterministic.
- **Remote ships twitched (owner playtest).** Two causes, both measured with a per-frame probe of the
  drawn position (`coop-check` part `jitter`). (1) The co-op clock follower wrote the epoch mid-frame,
  which re-solves the ephemeris after the local ship placed the world origin: Earth moves ~30 km/s, so a
  parked friend jumped 1.4 m (host) to 10 m (guest) every frame while the interpolated pose was
  constant. The correction now rides the next sim-clock tick (`simEpochNudge`): 0 m. (2) Poses carried
  the raw 120 Hz step and were stamped on arrival. They now carry the drawn, interpolated pose and the
  sender's frame time, mapped to local time by the minimum recent delay: a friend flying at ~320 m/s
  deviates from a smooth path 3 cm p50 / 9 cm p95 (was 17 cm / 95 cm, max 2.9 m).
- **Carried from M4.0 into M4.1.** Hosted signaling with per-peer tokens, STUN/TURN, commands for jettison and
  consumables, hotbar as a pilot pref, browser coverage of post-Join refusals (credential, closed).
- **Other pilots' activity, markers and names (owner playtest 3).** Poses carry optional bounded
  activity: `th` (plume throttle 0..255) and `b` (beam endpoint in the sender's frame, dropped beyond
  50 km of the ship; `fl` bit 2 = a pulse's dim phase). Each remote slot draws the local plume and the
  local mining beam from them, inside the precompiled slot subtree. A rock another pilot mines plays
  the same destruction burst for everyone who has it loaded (read from the chunk just before the
  event drops it; no loot). Remote plumes cast **no light**: a light added to the scene changes the
  lights hash, so every lit material recompiles when a session starts, and each light costs every
  lit fragment for the session. Remote pilots are green POI markers (name and distance always shown,
  green edge triangle) with live frame-relative positions. Gaze never makes one a transit target:
  transit aims with the destination frame's velocity only, so a moving friend would be missed. The
  pilot name is device-wide (default "Replicant XXXX", never required), edited in Settings → friends
  and on the join card. A rename mid-session sends a bounded `name` message; the host relabels the
  member and broadcasts `members`. Gates: `coop-check` parts remoteFx, pilotMarker, rename and
  transcript `renameAndActivity`. No remote engine or beam audio yet: see follow-ups.
- **Pilot impacts and recovery.** Nearby friends see contact sparks at the physics contact point.
  A committed impact death plays one destruction burst, including when the ship drops no wreck.
  Death clears the remote hull, plume, beam and pilot marker. Protocol v2 stamps each pose with
  the sender’s world revision so poses delayed across a respawn cannot restore the old ship.
  Joining a world with a dead pilot uses the snapshot’s dead state. The browser gates are
  `crash` (survivable and fatal asteroid contacts) and `remoteFx` (a starter laser at 7 km).
- **Name hardening (review 3).** The Settings name field also commits on Escape and when the menu
  unmounts (no blur fires then). The host cleans every name (control, zero-width and bidi characters
  stripped, whitespace collapsed, 32 chars), keeps labels distinct (a taken name, case-insensitive,
  gets " 2", " 3"...) and coalesces a pilot's renames within 1 s: the last one lands on the 1 Hz
  tick, so a rename loop costs at most one `members` broadcast per second per pilot. Gate:
  transcript `renameHardening`. Known: a disconnected pilot's hull and marker stay at the last pose
  until `REMOTE_STALE_MS` (5 s); an explicit leave signal would clear both at once.
- **Warm draw replaces the async precompile.** `compileAsync` caches a pipeline entry before
  `createRenderPipelineAsync` resolves, keyed by material and lights. The remote plume and beam share
  materials with our own ship, so our ship could draw the pending entry ("setPipeline ... not of
  type GPURenderPipeline", 1 of 2 fresh-page runs). Remote slots are now drawn once, behind the
  camera, in a single warm-up frame at session start: 0 errors in 6 fresh-page runs and 3 full runs.
- **Follow-ups (not scheduled in a slice yet).**
  - Spatial audio for other pilots' engines and beams: needs mono world-tier loops placed at each
    remote slot (today's engine and beam loops are single-instance ship sounds).
  - Transit to a friend: aim with the target's own velocity, a stand-off distance, and a rule for a
    friend who moves away. Natural fit for M4.3's shared locations.
  - Light from remote plumes: measure the recompile at session start and the per-fragment cost first.
  - Remote plume shows main-engine throttle only (no boost or strafe), as the local one does.
  - An explicit leave message, so a departing pilot vanishes at once instead of after 5 s.
  - Flakes seen once each in long full runs (rerun clean): `handoff` (guest did not rejoin within
    60 s) and `dropReply` (retry did not settle, which then blocked `restart`). Watch for repeats.

**M4.0 playtest fixes (2026-11-19).** Settings pauses the scene and clock in solo play
and while hosting alone. Admitting a guest resumes a host who has Settings open. Both
pilots can leave their menus open while the simulation advances. If the last guest
leaves, a host still in Settings pauses again. On first admission the host tries the
authored start, then spots 80 m apart until one has at least 35 m of clearance from
other pilots. A returning player keeps their saved pose. The muted two-browser run
measured 80 m between the first pair and passed `settingsSpawn,race,reloadPose,leave`.
The Node transcript also covers three arriving guests and clock resume without catch-up.
[Two-browser test instructions](AUTOMATED_TESTING.md#two-browsers-co-op)

### M4.1 · Host and join (2026-11-19, local verification)

- The game can use a Cloudflare Worker for invite lookup, negotiation and reconnect. The host browser retains the save and runs the authority. A hibernating Durable Object per code remembers the host, the room preview and expiring guest grants. A returning host can reclaim its code during a ten-minute grace period. Closing a room disables joining immediately. Host renames and seat counts update the join card.
- Each endpoint gathers ICE candidates with the supplied STUN/TURN configuration. Only the Worker holds the TURN API token. Settings → friends reports the selected route on the guest. A signaling interruption can prevent a new join while an established WebRTC session continues.
- Protocol v3 adds per-pilot commands for cargo jettison, hotbar assignment and consumable use. The host commits the spend and immediate hull or heat effect together, using catalogue IDs. A duplicate command replays its outcome. Opening a second connection with the same pilot credential visibly retires the older one. The join card distinguishes a world that closes after preview from an unknown code.
- During a guest reload, the loading overlay could submit a draw while WebGPU was still compiling the scene pipelines. Scene draws now wait for both compile passes. The relayed join, reconnect and host-restart run completed with zero pipeline errors.
- Two muted Chrome profiles connected through the local Worker on a direct path and through a forced loopback TURN relay. The shared-rock race passed over the relay. Browser and headless tests cover pilot actions, reconnect and refusal paths. Expiring the invitation during an active game preserved the WebRTC link and the same pilot could rejoin on the replacement code. The public Worker, actual provider-issued TURN credentials, separate-network join, and physical host sleep/wake still need a staging run to close M4.1.

[Staging setup and playtest](../services/coop-signal/README.md) · [Automated checks](AUTOMATED_TESTING.md#two-browsers-co-op)
