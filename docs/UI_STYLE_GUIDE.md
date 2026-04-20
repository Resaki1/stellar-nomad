# Stellar Nomad — UI Style Guide

> **Status:** Canonical reference for the UI rewrite.
> **Owner:** @Resaki1
> **Last revised:** 2026-04-17

This document defines the visual language, interaction patterns, design tokens,
and component rules for the Stellar Nomad UI. It replaces the ad-hoc "yolo"
styling across the HUD and modals with a single coherent system.

The guide is organized so you can read top-to-bottom once, then jump to
individual sections as reference during implementation.

---

## 1. Philosophy

One line: **Cold space, warm data.**

- The scene is vast, dark, and quiet. The UI is a single bright instrument
  panel drawn **on top of** that scene without obscuring it.
- 95% of the screen at any moment is either the game world or empty space.
  The other 5% — a transit spool-up, a comms ping, a hull breach — earns its
  visual weight by being *rare and loud*.
- The UI is a companion, not a billboard. It should feel like the ship is
  talking to the player, not like a web app stapled to a 3D canvas.

### Tone references

| Reference | What we borrow |
|---|---|
| Star Citizen (mobiGlas, flight HUD) | hologram-first flight UI, data-only glow |
| Elite Dangerous | monochrome + one accent, dense readouts, instrument feel |
| Dead Space | diegetic projection, UI as part of the ship |
| The Expanse (TV show) | austere engineer-panel aesthetic |
| Destiny 2 | bold display type, restrained palette, confident motion |
| Mass Effect (Citadel UI) | hex-cut panels, clear hierarchy |
| Project Hail Mary / Bobiverse (novels) | workmanlike, grounded, not cyberpunk |

### Explicit non-goals

- No neon cyberpunk.
- No hexagon wallpaper / decorative grid lines.
- No orange-on-black Elite pastiche.
- No rounded-squircle mobile-app chrome.
- No decorative SVG "tech" flourishes. Every stroke must carry data.

---

## 2. Design pillars

Three qualities matter more than polish. When in doubt, optimize for these:

### 2.1 Diegetic trust

The HUD should feel like it is *projected by the ship* onto space in front of
the camera — not pasted onto the screen. The ship is a third character; it
should be the one speaking.

Practical rules:
- UI elements acknowledge the scene: their glow picks up color from nearby
  celestial bodies, parallax is subtle but present, they bloom through
  postprocessing rather than bypass it.
- Status information prefers to live on the *ship itself* before going to the
  HUD. A damaged ship has a red rim light; a mining ship has a plasma glow at
  the laser mount; an overheated ship has visibly cooking vents.
- When the HUD does speak, it speaks in short sentences.

### 2.2 Density with hierarchy

Space sims are inherently information-dense. The trick is not "less UI" — it
is **layered tiers of information**, each with its own visual weight:

| Tier | Read time | Example | Rule |
|---|---|---|---|
| Glance | <1s | velocity, hull, reticle, target lock | always on, hologram |
| Inspect | 2-5s | cargo detail, POI info, scan result | on demand, panel |
| Deep | 10s+ | research tree, crafting, starmap | blocking modal, glass |

A glance-tier element that uses an inspect-tier visual weight is noise. A
deep-tier element that uses a glance-tier visual weight is unreadable.

### 2.3 Cinematic restraint

Break the rules on purpose, rarely. Transit drive, ship destruction, a story
comms ping — these moments get to violate the glance/inspect/deep hierarchy
with large type, longer motion, and the only truly saturated colors in the
game. If the rules break every few seconds, the cinema is lost.

---

## 3. The Four-Layer surface system

This is the single most important concept in the guide. Every UI element
belongs to exactly one of four layers. Each layer has its own rules for
visual weight, motion, and implementation.

```
┌──────────────────────────────────────────────────────────┐
│ 4. Menu-space  │ modals, maps, trees           │ GLASS   │
├──────────────────────────────────────────────────────────┤
│ 3. Screen-space│ reticle, velocity, hotbar     │HOLOGRAM │
├──────────────────────────────────────────────────────────┤
│ 2. World-space │ POI labels, target brackets   │  LABEL  │
├──────────────────────────────────────────────────────────┤
│ 1. Ship-space  │ hull glow, exhaust, rim light │DIEGETIC │
└──────────────────────────────────────────────────────────┘
```

### 3.1 Ship-space (diegetic)

**Definition:** state expressed through the ship model itself, not a UI element.

Implementation: three.js materials, lights, and shaders on `Spaceship.tsx`.
No React state in the render loop — drive these from atoms via `useFrame`
mutation on refs.

Examples:
- **Hull damage** → rim light color shifts white → amber → red as health drops;
  panels on the ship model desaturate and show scorch decals at <30%.
- **Heat / overheat** → emissive on vents ramps up; when overheated, animated
  heat-haze sprite at vent positions.
- **Mining active** → plasma glow at laser origin, particles, muzzle light on
  the ship.
- **Transit drive spool** → pulsing ring emissive on the drive module; when
  ready, a faint volumetric cone.
- **Low fuel / low energy** → subtle flicker on hull accent lights.

**Rule of thumb:** if the state is continuous (hull, heat, throttle), prefer
ship-space before screen-space. If the state is a discrete event (cargo full,
research complete), prefer a toast. If it is a number the player needs to read
precisely (velocity, exact hull %), it must also exist in screen-space.

### 3.2 World-space (attached labels)

**Definition:** UI elements anchored to objects in the scene and projected to
2D through the camera.

Implementation: R3F `<Html>` (occlude, transform, distanceFactor) and
`<Billboard>`, with the existing mutable-buffer rAF pattern from
`POIMarkers` so React never re-renders per frame.

Examples:
- **Planet / moon labels** — name + distance, visible always, scale with
  apparent size. Fade to nothing when the body fills the screen.
- **POI markers** — diamond + name, already implemented well. Extend the
  pattern.
- **Asteroid target brackets** — four corner brackets (◹ ◸ ◿ ◺) drawn in
  screen-space but anchored to the asteroid's bounding sphere.
- **Scan / composition tag** — when an asteroid is targeted, a world-space
  tag near it shows type + top 3 resources.
- **Jump point / navigation waypoints** — in-world beacons with a thin
  label.
- **Wreck markers** — subtle glyph at salvageable wrecks.

**Rules:**
- World-space labels always use the hologram visual style (no glass).
- They must fade gracefully with distance (both out and in — don't occlude
  the thing they label when you fly through it).
- They never block input. `pointer-events: none`.
- Legibility at oblique angles is a real problem. If you cannot make a label
  readable at a 60° glance, it does not belong in world-space.

### 3.3 Screen-space (hologram HUD)

**Definition:** 2D elements locked to the camera, drawn over the canvas.
This is the always-on glance tier.

**Visual rule: hologram-first, no backgrounds by default.**

A screen-space element is text, a stroke, and a glow — nothing else. If a
specific element genuinely cannot read against the scene without a scrim, it
gets a *null-surface* — a very low-alpha vignette behind the text only
(`rgba(0,0,0,0.35)` radial fade), **not** a panel with a border.

Examples:
- Reticle
- Velocity / throttle readout
- Compass strip
- Hotbar
- Hull bar (screen-space mirror of the ship-space rim light)
- Objective tracker
- Toasts
- Comms lower-third

### 3.4 Menu-space (glass modals)

**Definition:** blocking or semi-blocking surfaces the player intentionally
opens for inspect-tier or deep-tier tasks.

**Visual rule: dark glass is fine here — it's necessary.**

Reading 40 research nodes against a bright Jupiter fails no matter how much
text-shadow you apply. Menus earn their substrate.

Examples:
- Research tree
- Crafting panel
- Loadout / modules panel
- Cargo detail
- Settings
- Starmap
- Pause menu / main menu

---

## 4. Design tokens

All tokens live in `src/styles/_tokens.scss` (to be created). Components
import them, never define new raw values. Exported as SCSS variables *and*
CSS custom properties on `:root` so they work in both contexts.

### 4.1 Color

```scss
// ── Surfaces ─────────────────────────────────────────────
// Tier 0: screen-space HUD default (no background — just a concept)
$surface-null:    transparent;

// Null-surface scrim — use only when a HUD element genuinely
// needs a legibility boost. Radial, edge-faded.
$surface-scrim:   rgba(0, 0, 0, 0.35);

// Tier 1: inspect menu (cargo detail, loadout side panels)
$surface-glass-1: rgba(8, 11, 16, 0.78);

// Tier 2: deep menu (research, crafting, settings)
$surface-glass-2: rgba(4, 7, 12, 0.88);

// Tier 3: blocking critical (death, game over)
$surface-solid:   rgba(2, 4, 8, 0.96);

// ── Strokes ──────────────────────────────────────────────
$stroke-faint:   rgba(255, 255, 255, 0.08);
$stroke-base:    rgba(255, 255, 255, 0.18);
$stroke-strong:  rgba(255, 255, 255, 0.34);
$stroke-active:  rgba(210, 232, 255, 0.70);

// ── Text ─────────────────────────────────────────────────
$text-primary:   rgba(232, 238, 248, 0.96);
$text-secondary: rgba(232, 238, 248, 0.70);
$text-tertiary:  rgba(232, 238, 248, 0.48);
$text-disabled:  rgba(232, 238, 248, 0.26);

// ── Semantic accents ─────────────────────────────────────
// Use only where the color carries meaning. Never decorative.
$accent-info:    #7FB8FF;  // navigation, nominal data, UI focus
$accent-signal:  #FFD36B;  // POI targeted, story beat, reward
$accent-heat:    #FF8A3D;  // energy, heat, transit, mining
$accent-ok:      #6BE3A4;  // hull healthy, success, research done
$accent-warn:    #FFB23D;  // hull warning, caution
$accent-crit:    #FF5C5C;  // damage, cargo full, death
$accent-comms:   #8CB8FF;  // AI / crew dialogue speaker color

// ── Glows (semantic color @ 35-40% alpha for shadows) ────
$glow-info:    rgba(127, 184, 255, 0.35);
$glow-signal:  rgba(255, 211, 107, 0.40);
$glow-heat:    rgba(255, 138, 61, 0.45);
$glow-ok:      rgba(107, 227, 164, 0.35);
$glow-warn:    rgba(255, 178, 61, 0.40);
$glow-crit:    rgba(255, 92, 92, 0.50);
$glow-comms:   rgba(140, 184, 255, 0.35);
```

**Color rules:**
1. A color enters the screen only when it carries meaning. A generic HUD element is
   white-on-nothing, not blue-on-nothing "because it's sci-fi."
2. Semantic accents are *never* mixed in the same element. A button cannot
   be both info-blue and heat-amber.
3. Glow tokens are for `box-shadow` / `text-shadow` / three.js emissive only.
4. When showing a gradient on data (heat bar), interpolate between two
   semantic accents in HSL space, not RGB.

### 4.2 Typography

**Three families, each with one job:**

| Token | Family | Use |
|---|---|---|
| `$font-display` | Orbitron | titles, velocity, transit labels, menu headers |
| `$font-ui` | Inter | body text, list rows, descriptions, buttons |
| `$font-mono` | JetBrains Mono | numbers (always tabular), key hints, coordinates |

Load all three in `src/app/layout.tsx` via `next/font/google`. Apply via
CSS classes, not the root `<body>` — the body uses `$font-ui` by default.

Orbitron at <13px is mud. Never use Orbitron for body text.

**Type scale (7 values — do not add more):**

| Token | Size | Line-h | Tracking | Use |
|---|---|---|---|---|
| `$t-xs` | 10px | 12px | 0.12em | labels, key hints, tags, caps |
| `$t-sm` | 11px | 14px | 0.08em | secondary data, captions |
| `$t-md` | 13px | 18px | 0.02em | body, list rows (default) |
| `$t-lg` | 15px | 20px | 0 | panel titles |
| `$t-xl` | 18px | 22px | 0.04em | section headers |
| `$t-2xl` | 24px | 28px | 0.02em | modal titles, primary readouts |
| `$t-hero` | 40px | 44px | 0.06em | velocity in transit, death screen |

Numbers (velocity, distance, counts) always use `$font-mono` and
`font-variant-numeric: tabular-nums` so they don't jitter when they change.

### 4.3 Spacing

**4px base, geometric scale:**

```scss
$space-1: 4px;   $space-2: 8px;   $space-3: 12px;  $space-4: 16px;
$space-5: 24px;  $space-6: 32px;  $space-7: 48px;  $space-8: 64px;
```

No 6, 10, 14, 18, 20. Boring on purpose. Consistency > nuance.

### 4.4 Radii & signature geometry

```scss
$radius-sm:   2px;   // tags, hotbar key-caps, inline pills
$radius-md:   4px;   // buttons, inputs
$radius-lg:   6px;   // panels, modal corners
$radius-pill: 999px; // progress bars, badge pills
```

**Signature chamfer** — the one shape that makes any screenshot read as
"Stellar Nomad." Apply to every menu-space panel and to some prominent
screen-space elements (dashboard strip, hotbar).

```scss
@mixin chamfer($cut: 8px, $corners: 'tl br') {
  // Two-corner chamfer is the house style. Defaults: top-left and
  // bottom-right, giving a subtle diagonal read across the panel.
  // Use 'tl', 'tr', 'bl', 'br', or combinations.
  // Implementation: clip-path polygon. See _mixins.scss.
}
```

Chamfer size scales with panel size: `6px` for small elements (≤40px tall),
`8px` default, `12px` for large modals (≥600px).

### 4.5 Motion

One motion language. Durations are boring on purpose:

```scss
$dur-instant: 80ms;   // button press, active state feedback
$dur-fast:    160ms;  // hover, tooltip, reticle lock
$dur-base:    240ms;  // panel fade-in, toast slide-in
$dur-slow:    400ms;  // modal open, comms slide-up
$dur-cine:    800ms;  // transit spool, death fade, cinematic moments

$ease-out:    cubic-bezier(0.22, 1, 0.36, 1);    // everything default
$ease-bounce: cubic-bezier(0.2, 1.3, 0.3, 1);    // story / reward only
```

**Motion rules:**
- Panels open by **fading + 4px translate** (from direction of their anchor).
  Never scale, never bounce.
- Numbers **tick** via interpolation on their displayed value — never
  crossfade between old and new text.
- Progress bars fill **linearly**, no eased width transitions (eased widths
  lie about how much time is left).
- New data flashes its border at `$stroke-active` for 160ms then settles.
- Hover transitions are border-color only, at `$dur-fast`. No shadow pops,
  no background changes, no scale.
- Cinematic moments (transit, death, milestone) are the only place
  `$dur-cine` and `$ease-bounce` are permitted.

### 4.6 Hologram mixin

Default screen-space element. No background.

```scss
@mixin hologram($glow: $glow-info) {
  background: transparent;
  color: $text-primary;
  text-shadow:
    0 0 1px rgba(0, 0, 0, 0.9),
    0 0 8px $glow;
  // Optional: a 1px rule above or below the element to anchor it visually,
  // applied per-component rather than in the mixin.
}

// Use where an element genuinely needs a scrim for legibility
@mixin null-surface {
  background: radial-gradient(
    ellipse at center,
    $surface-scrim 0%,
    transparent 70%
  );
  padding: $space-3 $space-4;
}
```

### 4.7 Glass mixin (menu-space only)

```scss
@mixin glass($tier: 1) {
  @if $tier == 1 {
    background: $surface-glass-1;
    backdrop-filter: blur(14px) saturate(1.1);
    border: 1px solid $stroke-base;
    box-shadow: 0 8px 40px rgba(0, 0, 0, 0.55);
  } @else if $tier == 2 {
    background: $surface-glass-2;
    backdrop-filter: blur(20px) saturate(1.15);
    border: 1px solid $stroke-strong;
    box-shadow:
      0 0 0 1px rgba(0, 0, 0, 0.6),
      0 24px 80px rgba(0, 0, 0, 0.75);
  }
}
```

Do **not** apply `@mixin glass` to screen-space HUD elements. The whole point
of the hologram-first decision is that always-on UI has no substrate.

---

## 5. Iconography

**Replace every emoji.** Emoji are a design failure mode: they render
differently on every platform, anchor the aesthetic to whatever iOS thinks
a microscope looks like, and undo every other decision in this document.

**Short term:** install `lucide-react`. Apache-2, 1500+ icons, line weight
and aesthetic match the guide. Ship this now.

**Long term:** commission a bespoke 40-icon set drawn on a 16×16 grid,
line weight 1.5px, monochrome (`currentColor`). Serve as an inline SVG sprite
from `public/icons/sprite.svg`.

Required icon set (minimum viable):

| Category | Icons |
|---|---|
| Navigation | target, compass, route, waypoint, jump-point |
| Systems | hull, heat, power, fuel, cargo, shield |
| Actions | mine, scan, craft, research, equip, jettison, use |
| State | locked, available, active, complete, warning, critical |
| Comms | speaker, message, dismiss, advance |
| Controls | chevron (4 directions), close, expand, settings |
| Keys | keycap frame (for rendering any key inside) |

Icon sizing: 14px (inline), 16px (default), 20px (button), 24px (header),
32px (marquee). Always even numbers, always from the sprite.

---

## 6. Sound design

Define sound channels in code now, even before samples exist, so wiring is
not a refactor later.

```ts
type SoundChannel =
  | 'click.soft'      // panel open, passive button
  | 'click.hard'      // confirm, equip, craft complete
  | 'hover.tick'      // rare; hotbar focus, target lock
  | 'notify.info'     // toast, research progress tick
  | 'notify.warn'     // cargo full, heat warning, low hull
  | 'notify.crit'     // damage taken, ship destroyed
  | 'stinger.story'   // comms open, milestone reached
  | 'ui.transit';     // transit drive spool/active/end
```

Every interactive element wires a channel on mount. Samples can land later;
the plumbing must not.

---

## 7. Component patterns

Representative rewrites. The rest of the UI inherits these patterns.

### 7.1 Reticle — the quietest thing on screen

**File:** `src/components/HUD/Reticle/Reticle.tsx`

**Default state:**
- A single 18px circle, 1px stroke at `$stroke-faint`.
- Two 3px micro-dots at 12 and 6 o'clock, `$text-tertiary`.
- No background. No box-shadow.

**Targeting state (asteroid or POI in sights):**
- Outer ring appears at 28px, stroked in `$accent-info` (asteroid) or
  `$accent-signal` (POI).
- Progress fills as a stroke-dasharray sweep, 160ms.
- Small textual hint appears below reticle: `[M] MINE` or `[T] TARGET`.

**Locked state (mining in progress):**
- Inner reticle fades out (not just opacity; `scale(0.8)` and fade).
- Four corner brackets at 40px around the target, in `$accent-heat`.
- Brackets pulse at 1Hz while mining is active.

**Key rule:** never double up. If brackets are showing, the circle is gone.
Information redundancy is noise.

### 7.2 Ship dashboard — instrument strip, bottom-right

**File:** `src/components/HUD/ShipDashboard/ShipDashboard.tsx`

**Old:** bright frosted glass, 2×2 grid, shows speed/health.
**New:** hologram strip, three columns, anchored to bottom-right corner.

```
 ──────────────────────────────────
   THROTTLE   │   VELOCITY   │   HULL
    [====░]   │   412 m/s    │   [████████░░] 87%
 ──────────────────────────────────
                                   ◤ chamfer here
```

- No background. A single 1px rule on top, `$stroke-base`.
- Labels: `$t-xs`, `$text-tertiary`, uppercase.
- Values: `$font-mono`, `$t-xl`, `$text-primary`, tabular.
- Hull bar is thin (3px) and its color is driven by a token mapping:
  `>60% = $accent-ok`, `30-60% = $accent-warn`, `<30% = $accent-crit`.
  The bar color is the *only* colored element in the strip by default.
- Throttle shown as a linear bar of 10 segments (more readable than a
  percentage at a glance).
- Chamfer: `chamfer(8px, 'tl')` — top-left only, since it's anchored to
  the bottom-right corner.

### 7.3 Compass strip (new)

**File:** `src/components/HUD/Compass/Compass.tsx` (to be created)

Thin horizontal strip, screen-top-center, 400px wide, 28px tall.
- Heading ticks every 15°, major ticks labelled with degrees.
- POIs within the current view plot as small glyphs on the strip.
- Targeted POI plots in `$accent-signal`.
- Sun direction always plotted as a subtle yellow dot.
- No background. Pure hologram.

### 7.4 Hotbar — diegetic slots

**File:** `src/components/HUD/Hotbar/Hotbar.tsx`

- Ten slots, 48×48px, 4px gap, screen-bottom-center.
- Each slot: `chamfer(6px, 'tr bl')`. Diagonal-cut corners are the look.
- Default state: `$surface-null` (no background), 1px `$stroke-faint`.
- Filled: icon at 28px, count in bottom-right corner (`$t-xs`, `$font-mono`),
  key number in top-right corner (`$t-xs`, `$text-tertiary`).
- Cooldown: counter-clockwise radial wipe over the icon in `$surface-scrim`.
  A small numeric countdown in `$font-mono` overlays if >1s remaining.
- Disabled: icon at 25% opacity, no desaturation filter (desaturation
  muddies dark icons).
- Hover/focus: stroke fades to `$stroke-active` in `$dur-fast`.

### 7.5 POI markers — world-space (keep + extend)

**File:** `src/components/HUD/POIMarkers/POIMarkers.tsx`

Keep the existing rAF + mutable-buffer architecture; it's well-built.
Update the visual language:

- **Default diamond:** 10px, 1px stroke in `$accent-info`, no fill.
- **Targeted diamond:** 14px, solid fill `$accent-signal`, outer halo in
  `$glow-signal`. Small inward-pointing caret above and below (◆ between
  carets) to reinforce "this is active."
- **Label:** `$font-ui`, `$t-sm`, `$text-primary`. Distance in `$font-mono`,
  `$t-xs`, `$text-tertiary`, below the name.
- **Off-screen arrow:** 8px triangle in `$accent-info` at the edge,
  same color as the diamond it represents.
- **Occlusion:** labels fade by 40% when the POI is behind the ship or a
  celestial body (check via three.js raycast at ~10Hz, not every frame).

Extend the pattern to:
- `CelestialLabels` — names on all planets and major moons.
- `AsteroidScanTag` — floats near a targeted asteroid showing type + top 3
  resources (replaces the screen-space mining info panel).
- `WaypointBeacon` — in-world column of light at a nav waypoint, with a
  label above it.

### 7.6 Ship-space feedback — the new star of the show

**File:** `src/components/Spaceship.tsx` (augment)

Build a small `ShipStateVisualizer` component that reads atoms and drives
material + light parameters on refs inside `useFrame`. No React state in
the render loop.

Signals to map:
- `shipHealthAtom` → rim light color (white → amber → red); emissive on
  hull panels at <50%; scorch decal opacity at <30%.
- `miningStateAtom.isMining` → plasma point light at laser origin, additive
  spark emitter.
- `miningStateAtom.laserHeat` → emissive on vent meshes ramping from 0-1.
- `miningStateAtom.isOverheated` → heat-haze shader sprite near vents.
- `transitDriveBuffer.spoolProgress` → emissive ring on drive, 0-1.
- `transitStateAtom.phase === 'accelerating'` → volumetric cone behind ship.
- `cargoFillFractionAtom >= 1` → subtle amber tint on cargo bay lights.

The ship becomes the primary status display. The screen-space dashboard
becomes a confirmatory mirror.

### 7.7 Modal shell — one component, many uses

**New file:** `src/components/HUD/Shell/Panel.tsx`

Every menu-space surface uses this shell:

```tsx
<Panel
  title="Research"
  subtitle="Convert assay samples into permanent upgrades."
  tier={2}                     // 1 = inspect, 2 = deep
  onClose={() => ...}
  primaryAction={{ label: 'Start', onClick: ... }}
  secondaryAction={{ label: 'Cancel', onClick: ... }}
>
  {/* panel-specific content */}
</Panel>
```

Consistent header (title + subtitle + close button), consistent footer
(primary-right, secondary-left, key hints), chamfered corners, tier-appropriate
glass. Content slot is unopinionated — each panel fills it.

This kills roughly 70% of duplicate SCSS across `ResearchPanel`,
`CraftingPanel`, `LoadoutPanel`, `CargoDetail`, `SettingsMenu`.

### 7.8 Comms overlay — film lower-third

**File:** `src/components/HUD/CommsOverlay/CommsOverlay.tsx`

- No glass, no blur. Two thin horizontal rules (above and below the text
  block), in the speaker's accent color.
- Avatar left, 72×72px, slightly desaturated with a subtle rim light in
  speaker color.
- Speaker name: `$font-display`, `$t-xs`, uppercase, tracked, speaker-colored.
- Body: `$font-ui`, `$t-md`, `$text-primary`.
- Pagination indicator: tiny, `$font-mono`, `$text-tertiary`.
- `[SPACE]` hint: tiny, lower-right, `$text-disabled`.
- Slide-up entry: 4px translate + fade, `$dur-slow`, `$ease-out`.

### 7.9 Transit HUD — the cinematic exception

**File:** `src/components/HUD/TransitHUD/TransitHUD.tsx`

This is where we *break the rules on purpose*:
- Letterbox bars (thin, top + bottom of screen).
- Velocity at `$t-hero`, `$font-display`, screen-center.
- Star streaks in the scene (already exists).
- Gold/`$accent-signal` accents everywhere.
- `$dur-cine` timing, `$ease-bounce` on the spool-up only.
- ETA and target name as `$t-lg` below the velocity.

When transit ends, the letterbox bars slide away in `$dur-slow`, the
velocity readout fades to the dashboard strip's normal position. It should
feel like *the game returning to its baseline*.

### 7.10 Toasts

**File:** `src/components/HUD/ToastDisplay/ToastDisplay.tsx`

- Top-right, stacked.
- Each toast: `null-surface` scrim only (no border, no glass).
- 2px colored rule on the left edge in the semantic accent for the toast type.
- Icon (from sprite) at left, then label, then optional detail line.
- Slide in from right (4px + fade), `$dur-base`, `$ease-out`.
- Auto-dismiss 5s (info), 7s (warn), never (crit — manual dismiss).

---

## 8. Missing surfaces to build

These AAA staples are absent and should land during the rewrite:

1. **Starmap / system map** — non-negotiable for a solar-scale game. Top-level
   view → zoom to planet → orbital view. Enter via `TAB`.
2. **Objective tracker** — top-center, minimal, collapsible. Tracks current
   story / side objectives.
3. **Compass strip** — see §7.3.
4. **Main menu** — Continue / New Game / Settings / Quit.
5. **Pause state** — decide explicitly: either pause the sim on `Esc`, or
   commit to "you can't pause in space" and make `Esc` just open settings
   without pausing. Currently ambiguous.
6. **Warp transition / loading iris** — 1 second of iris-out with star
   streaks between scenes is a classic for a reason.
7. **Scan / discovery panel** — when targeting a planet, show name, orbital
   period, composition, atmosphere, gravity. This is Elite's killer feature
   and you have the data.
8. **Crew / AI roster** — once more AI personalities exist.

---

## 9. Migration roadmap

Phased so the game remains playable at every step.

### Phase 1 — Tokenize (1-2 days, zero visual change)

Goal: no visible difference, but every hardcoded RGBA / px / duration is
replaced with a token.

- Create `src/styles/_tokens.scss`, `_mixins.scss`, `_typography.scss`.
- Migrate 3-5 representative components to tokens (ShipDashboard, CargoHUD,
  Reticle).
- Document any exceptions (values that couldn't cleanly map) as TODOs.
- Sweep remaining components over the next day.

**Exit criteria:** `grep -R "rgba(" src/components/HUD` returns ~zero hits.

### Phase 2 — Unify shell (2-3 days)

This is where the screenshots start looking like the same game.

- Install `lucide-react`, `@fontsource-variable/inter`,
  `@fontsource-variable/jetbrains-mono`.
- Wire the three font families in `layout.tsx`.
- Remove every emoji from the UI. Replace with Lucide icons.
- Build `Panel.tsx` modal shell. Migrate Settings first, then
  CraftingPanel, LoadoutPanel, ResearchPanel, CargoDetail.
- Add the `chamfer` mixin. Apply to modals, dashboard, hotbar.
- Flip ShipDashboard to hologram (null-surface).

**Exit criteria:** all modals share a single header/footer implementation;
no emoji in components; Orbitron only appears in display contexts.

### Phase 3 — Hologram HUD pass (1 week)

Rebuild each screen-space HUD element to hologram-first.

- Reticle rewrite (§7.1).
- Hotbar rewrite (§7.4).
- CargoHUD to glance tier (just the bar + top 3 deltas).
- AssaySamplesHUD → integrate into the objective tracker.
- TransitHUD cinematic polish (§7.9).
- CommsOverlay film treatment (§7.8).
- Build Compass (§7.3).
- Build ObjectiveTracker.

**Exit criteria:** no screen-space HUD element uses `@mixin glass`.
Every element uses `@mixin hologram` or `@mixin null-surface`.

### Phase 4 — World-space + ship-space (2 weeks)

The immersion win.

- Extend POIMarkers pattern to CelestialLabels, AsteroidScanTag,
  WaypointBeacon.
- Build ShipStateVisualizer: rim lights, heat emissive, mining glow,
  transit spool ring, damage decals.
- Stand down the screen-space mining info panel (replaced by
  AsteroidScanTag world-space).

### Phase 5 — Missing surfaces (ongoing)

Starmap, main menu, pause state, scan/discovery panel, warp transition.

---

## 10. Implementation notes & gotchas

### Performance

- **backdrop-filter is expensive.** Budget it to menu-space only. Never
  apply to screen-space HUD elements that render every frame.
- **HTML in three.js scene** (`<Html>` from drei) is a DOM node per label.
  Fine for 10-50 labels, catastrophic at 500. For the starmap use SVG or
  canvas, not DOM.
- **Font rendering with blur behind is expensive** on Safari and low-end
  GPUs. The move to hologram-first mitigates this because most HUD text is
  now drawn without `backdrop-filter` behind it.
- **Motion on many elements at once** — if the whole HUD appears on game
  start, stagger entries by 40ms each so we don't thrash the compositor.

### Accessibility

- No information conveyed by color alone. Hull uses color AND a bar shape.
  POI targeted uses color AND a caret glyph.
- Focus states: every interactive element needs a visible focus ring.
  Use `$stroke-active` outline, 2px, offset 2px.
- Respect `prefers-reduced-motion`: disable `$ease-bounce` and reduce all
  durations to `$dur-fast` under the media query.

### File organization

```
src/styles/
  _tokens.scss          # colors, type, spacing, radii, durations
  _typography.scss      # font declarations, scale mixins
  _mixins.scss          # hologram, glass, null-surface, chamfer
  _animations.scss      # shared keyframes (damagePulse, heatPulse, etc.)
  index.scss            # @forward all of the above

src/components/HUD/
  Shell/
    Panel.tsx           # universal modal shell
    Panel.scss
  <existing components>

public/icons/
  sprite.svg            # bespoke icon set (future)
```

Component SCSS files import tokens via a **relative path**:

```scss
// From src/components/HUD/<Name>/<Name>.scss — 3 levels up
@use '../../../styles' as s;
```

Then reference as `s.$token-name` and `@include s.mixin-name()`.

**Why relative paths, not `@use 'styles'`:** Next 16 + Turbopack does not
reliably honor `sassOptions.loadPaths` / `includePaths` in `next.config.js`.
The config declares both for future compatibility, but components must
stick to relative paths until Next/Turbopack's Sass integration stabilizes.

If a component lives at a different depth, adjust the number of `../`s.

### Atoms & state

No new atoms needed for the rewrite — the existing atom graph is sound.
Two additions:

- `hudOpacityAtom` (0-1) for a global "hide HUD" keybind (useful for
  cinematic screenshots and a nice-to-have).
- `reduceMotionAtom` derived from `matchMedia('(prefers-reduced-motion)')`.

### What not to break during migration

- The mutable-buffer rAF pattern in POIMarkers, transit, mining must survive.
  It's the only reason the HUD doesn't tank the frame rate.
- `atomWithStorage` keys must not change without migration logic —
  `comms-played-v1`, `modules-v2`, settings. Changing keys silently resets
  player progress.
- Keybind rebinding UI must keep working — don't refactor the `keybindsAtom`
  shape.

---

## 11. Decision log

Running list of design decisions and why. Add to this as the rewrite
progresses rather than re-litigating choices.

| Date | Decision | Why |
|---|---|---|
| 2026-04-17 | Hologram-first for screen-space, glass for menu-space | Glass fights the scene for always-on elements; modals need substrate for legibility |
| 2026-04-17 | Three font families (Orbitron / Inter / JetBrains Mono) | Orbitron is mud at <13px; need tabular numbers; need body font that isn't Orbitron |
| 2026-04-17 | 4-layer surface system (ship / world / screen / menu) | Gives each element one obvious home and prevents screen-space bloat |
| 2026-04-17 | Chamfered corners as house style | Cheap signature shape; unifies every screenshot without decorative bloat |
| 2026-04-17 | Lucide short-term, bespoke sprite long-term | Emoji render inconsistently; Lucide ships in a day; custom icons when scope allows |
| 2026-04-17 | Chamfer + tokens over a full ECS-style design system | The project is a game, not a design-system library; a tokens file + a few mixins are enough |
| 2026-04-19 | Fonts via `next/font/google` (not `@fontsource-variable`) | Next.js already uses `next/font` for Orbitron; avoids an extra dep and keeps the loading pattern consistent |
| 2026-04-19 | Components import styles via relative paths (`../../../styles`) | Next 16 + Turbopack doesn't reliably honor `sassOptions.loadPaths`; relative paths are portable |
| 2026-04-19 | Modal migration scope = shell only (header / footer / backdrop / close / glass / chamfer) | Inner content (buttons, lists, forms) stays as-is for Phase 2 — Phase 3 handles the deeper visual pass |
| 2026-04-19 | Crafting confirm dialog stays inline (not a nested Panel) | Nested Panels with capture-phase Esc handlers compete. Inline dialog with `closeOnEsc={!confirmItem}` on the parent Panel and a local Esc handler in CraftingPanel avoids the conflict |
| 2026-04-19 | SettingsMenu keydown handler becomes "open when closed" only | Panel handles close via Esc + backdrop; the toggle-settings keybind now only opens, preventing open/close double-handling |
| 2026-04-19 | SettingsMenu's global `button { }` rule eliminated | It was leaking the bright-glass treatment to every button in the app. Styles are now scoped to `.settings-menu__button` + `.settings__open-button` |
| 2026-04-19 | ShipDashboard flip = subtle dark scrim, not pure hologram | A fully transparent dashboard makes the chamfer edge invisible. A 0.35 alpha scrim keeps the signature cut visible while still reading as "not bright glass" |
| 2026-04-19 | Hotbar slot chamfer uses `tr` + `bl` (diagonal pair, key-free corners) | Style guide §7.4. The existing top-left key number stays intact; bottom-right is the busiest corner (cooldown fill), so the remaining corners get the cut |
| 2026-04-19 | Research state icons ✓ ◉ ○ 🔒 → `Check` / `CircleDot` / `Circle` / `Lock` (Lucide) | Exact semantic mapping; all render at 11px with `strokeWidth=2` for a consistent tree-node look |

---

*End of guide. When revising, update §11 with the decision and why.*
