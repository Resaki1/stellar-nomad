# M3 playtest 1 (owner, 2026-11-17)

Owner's notes after playing PRs #35/#36, kept verbatim-in-substance as the work list for the
polish pass. Item ids are for cross-reference; status is tracked in `docs/M3_GAMEPLAY_PLAN.md` §13.

Overall verdict: "We need to take more care when building stuff, this still feels pretty sloppy."

## Bugs
- B1 Markers like "volatile rich debris" / "metal-rich fragments" show, but nothing is there
  when flying to them. Also: why show them at all?
  - Status (WP1): done. Pocket markers removed (a pocket only re-classes 20 km chunks; its composition data stays). Gate `regions`: 0 pocket markers.
- B2 No hull damage any more when flying head first at full speed into asteroids.
  - Status (WP1): changed. Not reproduced as a damage bug (the owner-path flight hits and damages at all three difficulties). The silent collision-off states are now visible: the dashboard shows `Collisions off · dev speed / over speed / physics unavailable`; the 20 s physics load bound starts at game mount and a failed load is retried once (a late load still restores collisions). Gate `PHYS_PARTS=liveOwner`.
  - Cause (owner's case): his own persisted dev physics tuning (`dev-physics-tuning-v1`, lethal speed), carried silently across saves. Dev builds now show `Dev tuning active` on the dashboard while any tuning table is off its defaults; Settings → Dev → `reset all dev tuning` clears it. Gate `PHYS_PARTS=devFlag`.
- B3 "Set destination" on a discovery does nothing.
  - Status (WP1): done. `Set destination` is hidden (and refused) without the transit drive; the current destination always has a marker. Gate `marks`.
- B4 A bookmarked asteroid that is then mined keeps its marker and its discoveries entry.
  - Status (WP1): done. Mining a rock drops the miner's bookmark in the same transaction; depleted sources have no marker and leave the Discoveries list. Gate `marks`.
- B5 Hull patch kit usable at 100 % hull; Hull Repair clickable at 100 % (dashboard and crafting menu).
  - Status (WP1): done. One rule `hullRepairable` (hull ≤ max − 0.5 HP) for dashboard, Workshop, hotbar, context menu, repair request and the `ship.repair` reducer; 100 % is shown only when not repairable. Gate `repairEdge`.
- B6 Default start date: Earth clearly does not block Earth → Moon, yet the plan adds 2 legs.
  - Status (WP1): done. Routes avoid a hazard shell (R + atmosphere + max(2 % R, 200 km)) instead of 2 R: Earth → Luna is one leg at the new start date.
- B7 Inside the lunar belt, transit to my wreck (also in the belt, Luna far behind it) is refused
  because Luna "blocks" it.
  - Status (WP1): done. A leg may descend to its lower endpoint; targets down to 20 km above a surface/atmosphere are legal. Gate `transitBelt`: 300 random in-field pairs, 0 refused.
- B8 Transit from the survey signal to the lunar belt: while spooling the plan shows
  "refused, too little propellant to move", yet the trip completes with 143 kg left.
  - Status (WP1): done. Stale braking flags no longer reach the spool preview. Gate `transitSpool`.
- B9 During transit the top-right transit panel constantly reflows (text wrapping, flashing);
  unreadable.
  - Status (WP3): done. Fixed 288 px panel top-right (below the settings gear), fixed rows per state (plan: name, ETA, FUEL, LEFT, status; active adds phase, SPEED, DIST), tabular fixed-format numbers (km/s with one decimal, `8,412 km` / `356k km`, `mm:ss`); a refusal keeps the last good numbers greyed and only changes the status line. MEASURED (gate `hudTransit`, 2-leg trip, 60 ms samples): width constant, height changes only at plan ↔ active.
- B10 Survey signal could not be focused; had to press G twice; missed the info toast about G.
  - Status (WP3): done. Sites, wrecks and placed points join the reticle lock (registry, min 1.5° lock cone); the Target Card shows `[G] Recover`; one G scans 4 s and inspects + recovers; arrival is 1.5 km (inside the 2 km action range). No info toast. Gate `hudSite` (real keys from a transit arrival).
- B11 Inspecting an asteroid makes no sound (focusing does).
  - Status (WP3): done. `mining.inspect.start` / `.loop` / `.complete` (UI bus, placeholder assets), also on site recovery. Gate `hud` samples all three in `__audio.voices()` during a real G inspection.
- B12 Closing a menu does not recapture the cursor (needs two clicks); same when starting the
  game from the title menu.
  - Status (WP1): done. Clearing the last cursor reason recaptures the pointer within the closing click/key's activation; Esc without a recent gesture keeps the "click to steer" prompt. Gate `SHELL_PARTS=lock`.
- B13 The tips toast (e.g. first mined asteroid) overlaps the received-resources popup.
  - Status (WP3): done. One Notification Stack top-left under cargo (max 4, 2 on phones, fixed 44 px items, one lifetime table, same-title merging); tips are stack items and wait while it is full. The loot popup text and the cargo delta rows are gone. Gate `hud`: no HUD home intersects another at 1280×720 or 390×844.
- B14 Projects: completed projects can be tracked; a stray "research options" subtitle at the
  bottom of the projects menu.
  - Status (WP1): done for tracking (no Track on a completed project; a tracked project is cleared when it completes) and the stray heading (shown only with rows). Sorting (D15) is WP4.
  - Status (WP4): done. Projects is one sorted list; completed projects collapse to `✓ name` with no buttons, last. Gate `panels`.

## Design changes
- D1 No marker or 3D object for the origin point. Only manually placed replication points are
  shown (Minecraft beds vs world spawn).
  - Status (WP1): done. The origin point has no marker and no 3D object; it stays the recovery fallback on the death screen.
- D2 Far too much text everywhere in the new UI. Go through every new string; show it with UI
  instead of text where possible; shorten the rest. Examples: Research Options tab is a wall of
  text; "Emergency: Abandon Ship" → "Respawn"; remove "inspected · est. yield x units";
  "Propellant from hydrates" explanation unnecessary (title maybe just fuel processing); the
  "Abandon ship?" explanation and the "SHIP ABANDONED" screen text are far too long.
  - Status (WP2): partly done. Item descriptions cut to ≤ 6 words (effects stay as chips). The rest of the text pass is WP3/WP4.
  - Status (WP3): HUD part done: target card, stack, dashboard, transit panel, hints, comms, replication and site strings shortened per spec §1.1-1.6, 1.12-1.14 (keys as key chips that follow rebinding). Panels and death/respawn text remain for WP4.
  - Status (WP4): done for panels: Research cards are chips (no intro, purpose or status words), Discoveries icons, Projects steps short with icons, Records ≤ 2 sentences, Crafting chips and icons, `Respawn` in Settings, short death and respawn screens (a row of wreck icons, `Respawn at X`). Scripted text budget: 0 menu strings > 8 words and 0 tracker strings > 3 words at 1280×720 and 390×844 (comms and Records excluded).
- D3 UI is all over the place. Focused asteroid: details above the reticle, Mine (M) at the
  bottom, Inspect above the reticle; after inspecting: resources right of the reticle, a toast
  top-right and an info toast top-left, both vanish in seconds on opposite sides. Overwhelming,
  messy. Needs one coherent layout.
  - Status (WP3): done. One Target Card attached right of the reticle (below it on phones) for rocks, the survey site, wrecks, points and the placement preview; every gain/unlock/refusal goes to the one stack; the old info column, right-of-reticle block, bottom heat/progress bar and Mine button are removed.
- D4 Menus change height with their content; should not.
  - Status (WP4): done. Research, Projects and Crafting have a fixed height (`min(640, 100vh − 96)`), the body scrolls; MEASURED constant across tabs, categories and a state change (Research 760×624, Projects 560×624, Crafting 640×624; phones 359×640).
- D5 Craft opens on C, Projects on P by default.
  - Status (WP3): done. Craft C, Projects P (pulse mining unbound), Interact G (H removed), place point unbound (kit from the hotbar). keybinds v3 migration moves only actions still on their old default and leaves a new key unbound when the player already uses it. Gate `hudKeys`.
- D6 Hovering a resource icon in menus (e.g. crafting requirements) shows a tooltip with its name.
  - Status (WP3): partly done. Shared `ResourceIcon` / `Tooltip` (160 ms, portalled) used on the HUD; wiring into the menus is WP4.
  - Status (WP4): done. Every material in Crafting (cargo row, ingredients with have/need), Research (chips, analysis, sources) and the death/respawn wreck rows is a `ResourceIcon`; real-mouse hover shows the name (gate `panels`).
- D7 Dashboard "heat: 62 % · 18 free" is unclear ("free"?); heat is shown again at the bottom of
  the screen while heating. Remove the dashboard "recovery" row.
  - Status (WP3): done. Dashboard rows SPEED, ASSIST (only when decoupled), FUEL, HEAT (bar with an 80 % tick), POWER, BOOST, HULL and one status line; it is the only heat display (the mining heat bar is gone); no recovery row, no "free".
- D8 Hotbar keys 1–9 then 0, matching the keyboard.
  - Status (WP3): done. Keys 1…9, 0 (labels match); digits typed into a name never press a slot. Gate `hudHotbar`.
- D9 Transit drive is far too easy: second item unlocked and crafted without knowing what I was
  doing; at the Moon within minutes. It should be a proper first milestone (Minecraft's first iron
  pickaxe, not wooden planks).
  - Status (WP2): changed. The drive now needs Heat Rejection + Bulk Handling + an inspected C-type, costs 1,212 units (was 288), and a new world starts with 200 kg of fuel (the first trip needs a processing batch). MEASURED with a timed real-input bot: 42.8 min to the lunar field when mining cold-laser rocks, but 18.4 min when it mines the largest rocks (450-800 m give 500-1,300 units in one 18 s pass once Radiator Strips are fitted). The drive's cost cannot close that; the lever is per-rock yield / extraction time (lead decision, plan §13 WP2).
- D10 Start date: should be far future, story-wise (what fits?). Currently Luna sits in front of
  the Sun (eclipse test date) and is hard to spot. Need a date where Luna is not toward the Sun,
  no other planet marker is near Luna's marker, and Earth is seen partly lit, partly shaded from
  the start position.
  - Status (WP1): done. New worlds start far in the future (no year shown); see plan §13 for the date and the ephemeris change. Existing worlds keep their date.
- D11 Transit from Earth's field to the Moon should land in the lunar asteroid field, not behind
  the Moon needing several manual transits.
  - Status (WP1): done. From beyond 50,000 km, "Luna" is a trip into the lunar field (1,500 km inside it, on the approach side); the field has its own marker within 50,000 km and none while inside it.
- D12 Survey signal interaction should work like asteroids and wrecks (focus, act); drop the
  info toast.
  - Status (WP3): done (see B10).
- D13 Too easy overall: few rocks mined, transit, survey signal in minutes, then crafted the
  integrated sensor array directly, skipping all other research (only a heat sink crafted to
  unlock transit).
  - Status (WP2): changed. Same as D9 for the transit; the sensor suite now needs Volatile Mapping (after Composition Survey), a 10 Ti analysis and 60 Ti, so ≥ 40 Ti must be mined in the lunar field. Large-rock yield still makes a fast player much faster than intended (D9).
- D14 Transit drive sits under "utility"; expected propulsion, or its own "special" category.
  - Status (WP2): partly done. Renamed "Transit Drive"; the "Drive" crafting category is WP4.
  - Status (WP4): done. Crafting tabs show only categories with an unlocked blueprint, in the order All, Drive, Scanner, Mining, Cooling, Cargo, Propulsion, Hull, Utility, Consumables, Processing; the transit drive is the `Drive` tab.
- D15 Projects sorted by progress: highest fraction first, 0 progress lower, completed last
  (e.g. 3/4 → 1/3 → 0/x → completed). Remove the explainer under the Projects title.
  - Status (WP4): done. Started projects by fraction (research rows count their evidence and analysis pieces), then 0/x, then completed; no explainer, no "Research options" heading.
- D16 Replication kit in the hotbar instead of a separate B key, showing the count; placing
  focuses the name input directly.
  - Status (WP3): done. A crafted (or salvaged) kit takes a hotbar slot with its count; its key opens the NEW POINT card with the default name focused and selected; Enter places, Esc or the key cancels (Esc never opens Settings while placing). Gate `hudHotbar`.

## Question (answered in chat, no change yet)
- Q1 What is bookmarking an inspected asteroid for? When would a player inspect and not mine?

## Infrastructure (done)
- Dev server for testing on :3001 (owner uses :3000); headless Chrome muted.

## Playtest 2 (owner, 2026-11-18)
- P2.1 Reaching the Moon should be harder: the first Earth -> Moon trip must not fit the base tank, only with the Auxiliary Tank.
  - Status: done, live gates pass (base tank refused with NEED 701 / TANK 600; aux tank 802 kg, 46 s at the default date). Transit now also costs fuel per km (`transitKgPerKm` 0.0019, not difficulty-scaled); the speed part halved (`transitKgPerKmps` 0.003). Earth field -> lunar field needs 650-803 kg over the year (base 600: refused `Tank too small`, the route panel shows NEED vs TANK); full Auxiliary Tank: burns 758-924 kg, 45-60 s. `Reach the Moon` gains a tank step (Craft / Equip Auxiliary Tank Mk1) and fuel 820 kg. In-field hops got cheaper (50 km 1.3 kg). Pace: arrival 47.8 bot min, new-player estimate 76.
- P2.2 Lunar field and survey canister in the dark: move them so Luna is partly lit from there, like Earth from the start field.
  - Status: done. Field anchor [3400, 0, 0] -> [1130, 3195, 273] km (Luna frame), canister -> [1629, 4605, 393]: from the arrival point Luna is half lit at the default date (phase 95 deg; 52-128 over month and year), never in the Moon's shadow. Rocks and canister lit (captures .captures/lunar-*.png).
- P2.3 The AI notes the transit drive unlock as a milestone.
  - Status: done. On crafting the drive the AI says one line pointing at the tank (`drive_online_001`); the `hint_drive` control hint follows it instead of colliding. The research unlock keeps its one toast.
