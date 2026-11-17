# M3 playtest 1 (owner, 2026-11-17)

Owner's notes after playing PRs #35/#36, kept verbatim-in-substance as the work list for the
polish pass. Item ids are for cross-reference; status is tracked in `docs/M3_GAMEPLAY_PLAN.md` §13.

Overall verdict: "We need to take more care when building stuff, this still feels pretty sloppy."

## Bugs
- B1 Markers like "volatile rich debris" / "metal-rich fragments" show, but nothing is there
  when flying to them. Also: why show them at all?
- B2 No hull damage any more when flying head first at full speed into asteroids.
- B3 "Set destination" on a discovery does nothing.
- B4 A bookmarked asteroid that is then mined keeps its marker and its discoveries entry.
- B5 Hull patch kit usable at 100 % hull; Hull Repair clickable at 100 % (dashboard and crafting menu).
- B6 Default start date: Earth clearly does not block Earth → Moon, yet the plan adds 2 legs.
- B7 Inside the lunar belt, transit to my wreck (also in the belt, Luna far behind it) is refused
  because Luna "blocks" it.
- B8 Transit from the survey signal to the lunar belt: while spooling the plan shows
  "refused, too little propellant to move", yet the trip completes with 143 kg left.
- B9 During transit the top-right transit panel constantly reflows (text wrapping, flashing);
  unreadable.
- B10 Survey signal could not be focused; had to press G twice; missed the info toast about G.
- B11 Inspecting an asteroid makes no sound (focusing does).
- B12 Closing a menu does not recapture the cursor (needs two clicks); same when starting the
  game from the title menu.
- B13 The tips toast (e.g. first mined asteroid) overlaps the received-resources popup.
- B14 Projects: completed projects can be tracked; a stray "research options" subtitle at the
  bottom of the projects menu.

## Design changes
- D1 No marker or 3D object for the origin point. Only manually placed replication points are
  shown (Minecraft beds vs world spawn).
- D2 Far too much text everywhere in the new UI. Go through every new string; show it with UI
  instead of text where possible; shorten the rest. Examples: Research Options tab is a wall of
  text; "Emergency: Abandon Ship" → "Respawn"; remove "inspected · est. yield x units";
  "Propellant from hydrates" explanation unnecessary (title maybe just fuel processing); the
  "Abandon ship?" explanation and the "SHIP ABANDONED" screen text are far too long.
- D3 UI is all over the place. Focused asteroid: details above the reticle, Mine (M) at the
  bottom, Inspect above the reticle; after inspecting: resources right of the reticle, a toast
  top-right and an info toast top-left, both vanish in seconds on opposite sides. Overwhelming,
  messy. Needs one coherent layout.
- D4 Menus change height with their content; should not.
- D5 Craft opens on C, Projects on P by default.
- D6 Hovering a resource icon in menus (e.g. crafting requirements) shows a tooltip with its name.
- D7 Dashboard "heat: 62 % · 18 free" is unclear ("free"?); heat is shown again at the bottom of
  the screen while heating. Remove the dashboard "recovery" row.
- D8 Hotbar keys 1–9 then 0, matching the keyboard.
- D9 Transit drive is far too easy: second item unlocked and crafted without knowing what I was
  doing; at the Moon within minutes. It should be a proper first milestone (Minecraft's first iron
  pickaxe, not wooden planks).
- D10 Start date: should be far future, story-wise (what fits?). Currently Luna sits in front of
  the Sun (eclipse test date) and is hard to spot. Need a date where Luna is not toward the Sun,
  no other planet marker is near Luna's marker, and Earth is seen partly lit, partly shaded from
  the start position.
- D11 Transit from Earth's field to the Moon should land in the lunar asteroid field, not behind
  the Moon needing several manual transits.
- D12 Survey signal interaction should work like asteroids and wrecks (focus, act); drop the
  info toast.
- D13 Too easy overall: few rocks mined, transit, survey signal in minutes, then crafted the
  integrated sensor array directly, skipping all other research (only a heat sink crafted to
  unlock transit).
- D14 Transit drive sits under "utility"; expected propulsion, or its own "special" category.
- D15 Projects sorted by progress: highest fraction first, 0 progress lower, completed last
  (e.g. 3/4 → 1/3 → 0/x → completed). Remove the explainer under the Projects title.
- D16 Replication kit in the hotbar instead of a separate B key, showing the count; placing
  focuses the name input directly.

## Question (answered in chat, no change yet)
- Q1 What is bookmarking an inspected asteroid for? When would a player inspect and not mine?

## Infrastructure (done)
- Dev server for testing on :3001 (owner uses :3000); headless Chrome muted.
