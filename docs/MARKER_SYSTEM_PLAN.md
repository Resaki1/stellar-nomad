# Marker system plan (POI markers, edge arrows, pings)

**Status, 2026-11-24.** Review plus phased plan. **P4 (progression) is done** (§2.7 as built), the
hydrate-site markers are removed (§1.1 R2) and two cost fixes landed (§1.6). Owner decisions are
recorded in §4. Next: P0/P1.
Files today: `src/store/poi.ts`, `src/components/POI/POIProjector.tsx` (defs + projection +
gaze), `src/components/HUD/POIMarkers/POIMarkers.{tsx,scss}` (DOM overlay). Producers live in
`store/industryHud.ts`, `store/discoveries.ts`, `store/sites.ts`, `store/starMarkers.ts`,
`Coop/CoopLayer.tsx`, `sim/systems/sol.json`.

---

## 1. What is wrong (measured or read, with locations)

Measured on a fresh world (isolated driver profile, 1280×720, `.captures/poi_fresh_{a..d}.png`):
**17 markers at spawn** (9 bodies, 6 nearest stars, the Sun, `industry-source:earth_hydrates`) and
**12 edge arrows on screen at once**. Nothing is gated by progression.

### 1.1 Progression and relevance
| # | Finding | Where |
|---|---|---|
| R1 | Every planet, Luna, the Sun and 6 stars are marked from second 0. The only progression seam (`revealAllStarMarkersAtom` + `revealStarMarkerAtom`) is dead: the override defaults to `true` and nothing calls the reveal. Flipping it today would hide all stars forever. Planets have no gate at all. | `store/starMarkers.ts:49-63`, `POIProjector.tsx:190-203, 282-313` |
| R2 | ✅ Removed, with the whole retired hydrate-site feature: the markers, the "prospect" rock cluster and its colliders, the depot clearance around it, the source stock, and the `extract` drone job. Old saves: an extract job loads as a hydrate mining job in the same field, and a drone caught mid-trip flies home on its funded return (`sim/industry/validate.ts`). | `store/industryHud.ts`, `sim/industry/*` |
| R3 | Range rules are hard-coded in 7 files with no idea of "relevance". Bodies 5e10 km, stars/pilots 1e15, rendezvous/drones `Infinity`, depots/points 2e6, wrecks 1e5, sources 1e6, industry sources 90 km. | `POIProjector.tsx:70-82`, `industryHud.ts`, `discoveries.ts:37,45`, `sites.ts:34`, `CoopLayer.tsx:42`, `sol.json` |
| R4 | Field markers only show in a window: origin belt 6,000–10,000 km. Inside the field there is none (fine), but **from the Moon there is no marker to fly home to the start belt**. The JSON `minDistanceKm` is silently overridden. | `POIProjector.tsx:206-218`, `sol.json:317` |

### 1.2 Visual language
| # | Finding | Where |
|---|---|---|
| V1 | 10 of 13 categories render the same blue diamond (body, star, field, wreck, point, source, rendezvous, site, industry source, B3 fallback). `kind` is a closed `pilot\|depot\|drone` union. | `poi.ts:38,60`, `POIMarkers.scss:83-118` |
| V2 | Unfocused markers show only a distance ("8.307 ly", "19.2 AU", "368,645 km" = Luna). The player cannot tell what anything is without aiming at it. | `POIMarkers.tsx:166-169`, screenshots |
| V3 | Colour has no system. Pilot green `#5fd38a` is a local hex, not `$accent-ok`. Targeted gold is raw rgba. Pilots differ from everything else by colour alone, which the style guide forbids (§Accessibility). The guide's §7.5 spec (1 px stroke, tokens, carets on target, occlusion fade) is not implemented. | `POIMarkers.scss:27-35, 81`, `docs/UI_STYLE_GUIDE.md` §7.5 |
| V4 | The active replication point is marked by appending `" ◆"` to its **name**. The glyph leaks into `targetedPOIAtom`, the transit HUD and the Target Card. | `POIProjector.tsx:239, 331-341` |
| V5 | Wrecks are all called "Wreck": no owner and no age. In co-op you can't tell yours from a friend's. | `POIProjector.tsx:225` |

### 1.3 Occlusion, small objects, clutter
| # | Finding | Where |
|---|---|---|
| C1 | The marker sits **on** the object. Earth's diamond and label are in the middle of its disc (`poi_fresh_b`). `objectRadiusKm` is only set for replication points. Depots, points, wrecks and sources have `minDistanceKm: 0`, so the diamond covers the structure at point-blank range. | `POIProjector.tsx:74, 245`, `industryHud.ts:100` |
| C2 | Edge arrows: one per off-screen POI, **no name, no shape, no cap, no merging**. Up to four stack on one edge (`poi_fresh_b` bottom-left), Alpha Cen A/B/Proxima share one spot. Arrows sit under the top nav bar and the dashboard. | `POIMarkers.tsx:177-229` |
| C3 | The avoid list hides marker **labels** under HUD panels but not the **diamonds**: diamonds are drawn over the comms box, the dashboard and the N button (`poi_fresh_c`, `poi_fresh_d`). | `POIMarkers.tsx:50-83` |
| C4 | Edge arrow direction is wrong on non-square screens: `atan2` in NDC, then intersected in pixels. At 16:9 a diagonal arrow is off by up to ~15°. A POI almost directly behind the camera makes the arrow jump between edges (atan2 of noise). | `POIProjector.tsx:426-432`, `POIMarkers.tsx:198-228` |
| C5 | No occlusion: a moon behind Jupiter or a depot behind the Moon draws at full strength. | `POIProjector.tsx:376-405` |
| C6 | Duplicates: a shared rendezvous on a rock + your own bookmark of it = two markers; `field:luna_belt` + `body:luna` coincide at range; the Alpha Cen trio. No parent/child or cluster rule. | `discoveries.ts:31-46` |
| C7 | Every marker inside the ±0.06 NDC focus box shows its name, but only the one nearest the nose charges the gaze ring. With clustered markers, several labels appear while a different one is the one being locked. Stars and the Sun are gaze-lockable too. | `POIProjector.tsx:407-420`, `POIMarkers.tsx:168` |

### 1.4 Player control
| # | Finding | Where |
|---|---|---|
| P1 | No toggle of any kind. `starMarkersEnabledAtom` is a plain `atom(true)`, unpersisted, with no UI. No master switch, no category filter, no "essentials only". | `starMarkers.ts:49` |
| P2 | A drone marker exists only while that drone is the **transit target**, chosen from the Industry panel, which then closes. "Show me where my drone is" and "fly there" are one switch. Its position is the target tuple, mutated in place from `IndustryWorld`. | `industryHud.ts:112-134`, `IndustryWorld.tsx:448-457` |
| P3 | Targeting state is split between `targetedPOIAtom` and four `poiBuffer` fields (`targetedId`, `pinnedId`, `ignoreGazeUntilLookAway`, gaze). Five modules write both. `pinnedId` is read inside a `useMemo` that does not depend on it. | `poi.ts:76-95`, `POIProjector.tsx:209, 316` |

### 1.5 The existing "ping" (co-op rendezvous)
| # | Finding | Where |
|---|---|---|
| G1 | Only in the Crew panel, which is hidden unless you are in a joined co-op session. **Solo players have no personal marker at all.** The reducer itself is not co-op gated. | `HUD.tsx:197, 229`, `ExpeditionControls.tsx:105-111`, `reducers.ts:204` |
| G2 | It always marks your own ship position, never the thing you are looking at. No hotkey, no rename. | `ExpeditionControls.tsx` |
| G3 | "Share source with crew" writes **the same one slot** per pilot, so sharing a rock silently deletes your rendezvous and the other way round. | `reducers.ts:214`, `ResearchPanel.tsx:223-228` |
| G4 | No expiry. A departed or kicked pilot's marker stays in the world save forever. No rate limit, and each mark re-sends the whole map. | `hostSession.ts:544`, `authority.ts` RECEIPTED |
| G5 | It looks like a planet (no kind), has range `Infinity`, and is gaze-targetable: looking at a friend's marker for 1.5 s makes it your transit destination. | `discoveries.ts:41-46` |

### 1.6 Performance and correctness (read, **not yet timed**)
**Cost review, 2026-11-24.** Nothing in the pipeline is computationally heavy: per frame it is one
projection per marker (now 0–5 at start) plus DOM writes. Two items were real waste and are fixed:
the nearest-star reselect (8,848 candidates, per frame during warp) ran while star markers were
gated off, and the overlay ran three `querySelector` per marker per frame (child refs are now
cached, writes diffed). F1–F3 remain; they are correctness/latency items, not CPU hogs.

At ~17–60 markers the JS cost is probably small next to an 8 ms frame. Measure before claiming
anything (§3 P0). Likely issues, ranked by expected cost:

| # | Finding | Where |
|---|---|---|
| F1 | **Likely one frame of lag.** The chase camera moves in a priority −1 `useFrame`, and nothing calls `camera.updateMatrixWorld()` before the projector, so `Vector3.project` uses last frame's `matrixWorldInverse`. Markers would trail the scene by one frame during fast turns (~15 px). This contradicts the "perfectly in sync" comment. Verify with a turn test. | `POIProjector.tsx:361, 395`, `chaseCamera.ts:198-201` |
| F2 | Every 100 ms, `querySelectorAll` (12-class selector) plus `getBoundingClientRect` on each match runs right after the frame's style writes. That forces a synchronous layout, a periodic spike. | `POIMarkers.tsx:92-108` |
| F3 | Markers move by `left/top` in %, which are layout properties. `will-change: left, top` does not promote them, and the container has no `contain`. | `POIMarkers.tsx:148-149`, `.scss:13-21` |
| F4 | Per-frame garbage and DOM work: a new `projected[]` plus one object per POI, a `Set`, 3× `querySelector` per marker, unconditional `opacity`/`display`/`classList` writes, `formatDistance` strings, 3 declutter passes with no hysteresis (labels flicker). | `POIProjector.tsx:350, 440`, `POIMarkers.tsx:110-176, 50-83` |
| F5 | Each POI keeps both a marker and an arrow subtree alive (one at `opacity:0`). There is no range hysteresis, so a ship hovering at a range boundary destroys and recreates nodes over and over. | `POIMarkers.tsx:134, 181`, `POIProjector.tsx:376` |
| F6 | `target` is a full dependency of the defs `useMemo`, so every gaze lock or unlock (including the 0.3 s grace) rebuilds the whole def list. | `POIProjector.tsx:316` |
| F7 | During warp the star re-select gate is sized from the nearest star only, with a 1% budget, so the 8,848-candidate scan can run every frame. | `POIProjector.tsx:130-138` |
| F8 | Housekeeping: frame ids from wrecks, bookmarks and sites are not validated (an unknown id resolves to the Sun's origin); comments still point at a removed `PingBrackets`; harnesses still query removed `pocket:` markers. | `frames.ts:88-91`, `POIMarkers.scss:6`, `m37Harness.ts:254` |

---

## 2. Target design

Principles taken from Elite Dangerous, No Man's Sky, Helldivers 2, Apex, Subnautica and Xaero's
minimap, plus Star Citizen as the counter-example (nameless chevrons, stacked nameplates):
**shape says what it is, colour says whose it is, context decides whether it shows, and the
player can always turn it down.**

### 2.1 One category table, one def type
Replace `kind?` and scattered constants with `MARKER_CATEGORIES` in one file (for example
`src/data/markerCategories.ts`). Each producer emits a `MarkerDef` with a `category`; everything
else comes from the table:

| Field | Purpose |
|---|---|
| `glyph` | shape (see 2.2) |
| `scope` | `local` (same body frame or < regional range), `system`, `interstellar` |
| `range` | default min/max km plus **5% hysteresis** |
| `priority` | declutter and edge-arrow rank |
| `filter` | which Settings filter group toggles it |
| `labelMode` | `focus` / `always` / `nearOnly` |
| `targetable`, `bracketable` | gaze rules; switch to brackets when the object is resolved on screen |

State that is not a name stays out of the name: `active`, `owner`, `tracked` and `shared` are
fields that drive styling. This fixes V4 and V5.

### 2.2 Visual language (shape = category, colour = relationship)
Shapes, each a tiny SVG or CSS glyph, so category survives colour-blindness:

| Category | Glyph | Label default |
|---|---|---|
| Planet / moon | hollow circle; **corner brackets** around the disc once it is ≥ ~24 px | name on focus; always on when "Celestial labels" is on |
| Star (incl. Sun) | 4-point sparkle | focus |
| Asteroid field / region | dashed circle | focus |
| Depot | square | always within local scope |
| Replication point | square with a notch; filled = your active point | focus |
| Drone | small triangle in its heading direction | when tracked |
| Wreck | broken diamond / ✕ | owner + age on focus |
| Signal / site | diamond with `?` until inspected, then normal diamond | focus |
| Resource bookmark | small diamond with a dot | focus |
| Pilot | chevron with the pilot's initial | always |
| Ping | ring with the owner's initial, short pulse when placed | always while alive |
| Destination (any) | the category glyph, enlarged, gold, carets above/below (style guide §7.5) | always |

Colours (tokens from `UI_STYLE_GUIDE.md`): **neutral world** `$accent-info`, **yours** white or
`$text-primary`, **crew** `$accent-ok` (replaces the local `#5fd38a`), **current destination**
`$accent-signal`, **danger** `$accent-crit` (only for hazards, later). Optional per-pilot slot
tint inside the crew family for pings (needs a decision, see §4). A marker scale and opacity
slider in Settings covers accessibility.

### 2.3 Not covering what you mark
- **Bracket mode:** a body or structure whose on-screen radius passes ~12 px gets four corner
  brackets on its silhouette, and the label moves outside the brackets. Drop the centre glyph.
  The projector already computes `objectRadiusFrac`; give every body and structure an
  `objectRadiusKm`.
- **Near fade:** local structures fade their glyph out inside ~2 km or once bracketed. The Target
  Card takes over there.
- **Occlusion:** an analytic ray–sphere test against the system's bodies at ~10 Hz. We know every
  radius, so no three.js raycast is needed. Occluded markers draw at 40% with no label (§7.5).
- **Avoid HUD homes for glyphs too**, not only labels (C3). Panels publish their rects through a
  small registry fed by `ResizeObserver`, instead of the 100 ms `getBoundingClientRect` sweep (F2).

### 2.4 Declutter
1. **Priority order:** destination > pings > tracked > crew > local structures > signals >
   bodies > fields > stars.
2. **Parent/child collapse:** children (moons, a body's field, sites in a frame) fold into
   their parent when their screen separation drops below ~16 px. Close stars (Alpha Cen A/B/
   Proxima) collapse into one "Alpha Centauri ×3". Focus expands the group.
3. **Cluster stacking** for anything else that overlaps: "+3" chip, expands on focus.
4. **Labels with hysteresis** (keep a placed label for ~250 ms) so they stop flickering.
5. **Edge arrows only for what matters:** destination, pings, tracked, crew. Each arrow carries
   its category glyph and a short distance. Arrows within ~24 px merge with a count. Use the
   aspect-correct angle (convert to pixels first) with a dead zone directly behind (C4). Everything
   else off screen is reachable by turning or with the reveal key.

### 2.5 Player control
- **Density modes** (cycle key, proposal **N**): *Full* / *Essential* (destination, pings,
  tracked, crew) / *Off*. Shown briefly as a HUD toast. `H` keeps hiding the whole HUD.
- **Hold to reveal** (proposal **F** hold, like a scanner sweep): while held, every allowed marker
  shows with its name and every edge arrow returns. Releasing goes back to the current density.
- **Settings → HUD → Markers:** a filter per group (Celestial, Stars, Fields, Structures,
  Drones, Wrecks, Signals & sources, Crew, Pings), celestial labels always/on focus, marker
  scale, opacity. These are display preferences, so device prefs (`atomWithStorage`) are fine;
  M3 plan §425 also allows player-scoped prefs, see §4.
- **Track (pin) any marker,** separate from "set as destination": Industry, Discoveries, the
  Target Card and the ping menu get a *Track* toggle. Tracked markers ignore scope and range, keep
  an edge arrow, and are saved per player (`savedAtom`, cap ~8). A drone becomes trackable from its
  row or by focusing it, and the drone keeps feeding its live position through a proper live
  def, not the target tuple (P2).
- One targeting store: fold `targetedId`, `pinnedId` and `ignoreGazeUntilLookAway` into a single
  `navTargetAtom` (plus the per-frame gaze buffer), written in one place (P3).

### 2.6 Scope: what shows where
- `local` categories (depots, points, drones, wrecks, bookmarks, industry sources, sites) show
  only when the ship is in the **same body frame** (they already store `frameId`) or inside
  their regional range. So a Mercury depot never shows near Neptune. Tracked ones are exempt.
- From far away, each body with your infrastructure gets a small **badge** on its own marker
  (for example a square pip with a count). You can still find "my stuff is at the Moon" without
  23 markers.
- Fields show from outside their shell up to ~2×10⁶ km, so the start belt is findable from the
  Moon (R4).
- Pilots and pings stay system-wide, since they are few and always relevant.

### 2.7 Progression: markers are relevance (✅ built)
Owner rule: **everything stays visible in the sky; a marker appears only once the player can
sensibly travel there.** As built (`store/markerKnowledge.ts`, `marker.unlock` in `sol.json`):

| Unlock | Markers |
|---|---|
| Always | own structures, crew, rendezvous, bookmarks, wrecks; **Earth** (hidden near Earth by the disc rule below, back beyond ~50,000 km, so it is the way home from the Moon; its trip ends in the home field); home field (`origin_belt`) from outside its shell to 100,000 km |
| `transitDrive` (owned module) | Luna, lunar field |
| Comms `lunar_signal_001` showing or read (`SiteDef.revealCommsId`) | survey signal; an inspected site skips the wait |
| `warpDrive` (no item yet → never) | other planets, Jovian moons |
| `interstellar` (none yet → never) | Sun and stars (the old `starMarkers` seam still applies after it) |
| Any body | marker yields when its disc radius passes 12% of the view height (back at 10%); body labels sit below the disc |

Derived per pilot from state that already persists, so no save field and no migration.
Settings → Dev → "show all markers" restores the old set. When the warp drive item lands, set
`warpDrive` from its module in `markerKnowledgeAtom`.

Original proposal, kept for reference:

| When | Unlocks |
|---|---|
| Start | Sun, Earth, Luna, own structures, crew, pings. The home field marker once outside it. |
| First inspection (`survey.inspect`) | Inspected sources and bookmarks; the Earth hydrate site only after a hydrate find or Bulk Handling (fixes R2) |
| Transit drive owned (`pr1_transit_calibration`) | Lunar field and the survey signal, which keeps its own 120,000 km signal range |
| Reaching lunar space (`glanceAtom.frameId === "luna"`, persisted once) | Inner planets (Mercury, Venus, Mars): "first astrometric fix" |
| Later research / warp drive (M6+) | Outer planets and their moons |
| Astronomy survey (ROADMAP M9) | Nearest stars, through the existing `revealStarMarkerAtom`, moved to world scope |
| Always, any stage | **Discovery by proximity:** any body you fly within its SOI or see as a resolved disc becomes known. Free exploration stays intact (GAMEPLAY_AND_STORY 84-87). |

Migration: existing saves get the ladder applied from their current research and modules, so
nobody loses markers they already use. Schema bump plus `validate.ts`.

### 2.8 Ping (solo and co-op)
- **Place:** tap **Z** (or middle mouse) to ping what the **nose ray** hits
  (`shipView.forward`, never screen centre). An asteroid (mesh hit, as the mining beam does), a
  structure, wreck or pilot, or a body surface gives a *contextual* ping attached to that object
  or frame ("C-type rock · 2.4 km"). On empty space it is a **bearing ping**: a direction at
  infinity, frame-anchored, since a point in empty space has no depth.
- **Lifetime (owner decision): persistent.** One ping per pilot, replaced by the next, saved like
  today's rendezvous (it *is* the rendezvous, now placeable by aim). **Hold Z** opens a small
  radial menu: *Track*, *Clear*, *Set as destination*.
- **Acknowledge:** a crewmate pinging your ping shows "✓ on my way" with their initial.
- **Feedback:** `playAudio('hud.ping')` (new semantic event, mono 2D, `check:audio`), plus a
  one-line notification with owner and distance.
- **Not gaze-targetable** by default. It becomes a destination only through the menu (G5).
- **Transport:** keeps `expedition.mark` (host rate limit ~1/s, burst 3), but **split the
  source-share slot** (G3) and show a departed pilot's ping dimmed "(offline)" with a host
  cleanup (G4).
  Solo uses the same code path against the local authority (G1).

### 2.9 Pipeline rework (performance)
- Run the projector **after** the camera update and call `camera.updateMatrixWorld()` first
  (registered in `frameOrder.ts`) (F1).
- Pooled `ProjectedPOI` records and no per-frame allocations. Cache child element refs at
  creation (no `querySelector`). Diff every style write. Recompute distance text only when the
  formatted string changes, at ≤10 Hz.
- One element per marker that morphs between the in-view glyph and the edge arrow (no twin).
  Move it with `transform: translate3d(px)`, and add `contain: strict` on the container (F3, F5).
- Keep the rAF/mutable-buffer architecture (style guide §7.5 and §825 say it should survive) and
  the `poiBuffer.pois` fields the gate scripts read (`id`, `name`, `distanceKm`, `focused`,
  `inView`).
- Memo on `target?.id`, not `target` (F6). Size the star re-select budget from the 6th/7th
  margin (F7). Validate frame ids at the producer boundary (F8).

---

## 3. Phases

Each phase lands on its own and keeps the existing gates green (`structure-targeting.mjs`,
`industry-ui.mjs`, `m5-drone-motion.mjs`, `coop-check` pilotMarker, `gameplay-check` m37 parts).

| Phase | Scope | Exit check |
|---|---|---|
| **P0 · Measure + bugs** (no design decisions) | Add a `__bench`/`__test` marker scenario: stress world with 150 wrecks + 50 bookmarks, report projector ms and flush ms with `--perf`. Kill line: if flush + projector < 0.3 ms at 60 markers, skip the perf parts of P1 that only save CPU. Verify F1 with a turn test (marker vs ship-forward pixel error). Fix C4, V4, R4, G3, F5 hysteresis, F6, F8. | Bench numbers in this doc; turn-test error ≤ 1 px; arrow-angle unit test at 16:9 and 390×844 |
| **P1 · Category table + visuals** | `MARKER_CATEGORIES`, glyph set, tokens, the §7.5 destination style, names never carry state, owner/age on wrecks, avoid HUD for glyphs too, rect registry, pipeline rework from 2.9. | Screenshots at 1280×720 and 390×844 per category; flush ms ≤ P0 |
| **P2 · Control** | Density modes, hold-to-reveal, Settings filters + scale, Track/pin (incl. drones), single nav-target store. | Toggle persistence across reload; tracked drone follows flight; gaze gates still pass |
| **P3 · Declutter + scope** | Parent/child collapse, clusters, edge-arrow priority + merge, bracket mode, near fade, analytic occlusion, local scope + body badges. | Fresh-start screenshot ≤ 4 edge arrows; Earth bracketed, not covered; Mercury depot hidden at Neptune, badge on Mercury |
| **P4 · Progression** | `knowledge.markers` world slice, unlock commands, proximity discovery, migration, star reveal wired. | Fresh world shows Sun/Earth/Luna only; `pace` part unchanged; migration round-trip |
| **P5 · Ping** | Nose-ray ping, bearing ping, radial menu, ack, audio, transient events, rendezvous cleanup, solo support. | New `coop-check` parts: ping/expire/ack/leave; solo ping in `gameplay-check` |

P0 and P1 can start now. P4 and P5 need the decisions below.

---

## 4. Decisions (owner, 2026-11-24)
1. **Start knowledge:** objects always visible, markers only when reachable (§2.7, built).
2. **Ping lifetime:** always persistent for now (§2.8).
3. **Crew colours:** colour-blind-safe slot tint per pilot.
4. **Where filters live:** open. Default to device prefs (`atomWithStorage`): a player who turns
   wrecks off wants that in every world.
5. **Keys:** Z ping, F hold-reveal, N density.
6. **Order:** P4 first (done) for the playtest.
