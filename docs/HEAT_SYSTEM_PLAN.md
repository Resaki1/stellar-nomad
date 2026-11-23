# One coherent heat system — plan (2026-11-23)

> Owner ask: wire the post-burn hull ticking into the ship's heat system, tie the
> engine's heat outputs into heat management, and show heat on the ship in a
> scientifically accurate way (bells, radiators), so that *what produces heat,
> where, how much, and what it looks and sounds like* is one model.
>
> Status (2026-11-23): **H0–H2 built** (owner: thrust heat OK, radiators stay
> visually inert, bell glow must reach co-op viewers at distance). See §7.

## 1. What exists (audited 2026-11-23)

- **One scalar store** `ShipResourceState.heat01` (resourceStep.ts:44): 1.0 =
  `heatCapacityKJ` 1000 kJ, cap 1.3. No temperature anywhere. Saved per player
  (`player.power.heat01`), synced in co-op only as a sampled slice.
- **Sources** (all summed into one `qKW`, resourceStep.ts:248-259): mining laser
  171.9 kW, boost 144.9 kW, processing 97.1, repair 10, transit spool 120 / burn
  95, in-air drive overdrive ≤ 150. **Normal thrust heats nothing.** No aero, no
  sun, no reactor waste heat. Attribution is lost after the sum.
- **Sink**: a linear lump `77.1 + 50·h kW` × `coolingMult` — no area, no T⁴, no
  environment; it rejects 77 kW even when "cold".
- **Consequences**: throttle above 0.9, laser trips at 1.0, hull damage above 1.0
  for > 2 s; one HUD bar; laser pitch; heat-sink cartridge (−0.5).
- **Audio's private heat**: the hull ticks (`engineState.soak`, engineAcoustics.ts)
  are a fake soak driven by throttle, not by `heat01`.
- **Model** (starter-survey.glb): the bells are one mesh/material ("Oxidized
  liner", both sides, LOD0 only); the throat is a separate un-UV'd material. The
  wings ARE the radiators: the ventral "radiator skin" shares mesh+material+atlas
  with the dorsal solar skin (u ≥ 0.5 = radiator). No emissive anywhere; materials
  are shared between the local and remote ships through the GLTF cache.

## 2. The physics, and what is honest to show

**The torch cannot dump its waste heat into the ship.** Full thrust is
F·v_e/2 = 2.4 MN × 2,500 km/s / 2 ≈ **3 TW** of jet power. Radiating even 0.01 %
of it at 1500 K needs ~1,200 m² of radiator (one face). So the drive must be (as
hard-SF torch designs assume) almost adiabatic: a magnetic nozzle keeps the plasma
off the walls and the waste heat leaves *with the exhaust*. The residual wall load
— a few hundred kW per bell, ~2×10⁻⁷ of the jet power — is modelled as plasma
radiation (neutron/gamma heating of a D-T/D-D burn and the coil loads are out of
scope). The bell sheds it **itself, by glowing**: radiation-cooled extensions on
real engines (Merlin Vacuum's niobium skirt, the Apollo LM descent engine's
columbium skirt) glow cherry to orange; niobium runs ~1,300–1,600 K, carbon-carbon
up to ~2,000 K. At 1,400 K the colour is orange-yellow (~2.5×10³ cd/m²), not white.
Only a small conducted fraction reaches the ship's coolant loop.

⚠ Not in this plan, stated so it isn't forgotten: a magnetic nozzle's
superconducting coils need a **cryogenic** radiator (~20–90 K) — a separate cold
loop that can never glow. A later node if coils become gameplay.

**Radiators at survivable temperatures do not glow.** Interpreting today's law on
the ~22 m² ventral radiator skin (ε 0.85, Stefan–Boltzmann):

| heat01 | rejected | radiator T |
|---|---|---|
| 0 | 77 kW | 519 K |
| 0.5 | 102 kW | 557 K |
| 1.0 | 127 kW | 588 K |
| 1.3 | 142 kW | 605 K |

Visible blackbody luminance runs ~T¹² (photometry.ts): 1000 K ≈ 2.7 cd/m²,
below that effectively nothing. A 520–600 K radiator is **essentially invisible**
(5×10⁻⁹ cd/m² at 520 K; ~10⁻⁶ at 600 K, the dark-adapted threshold — and deep red,
where rods are weak); dull glow starts near 700–800 K (Draper point 798 K). Making
the radiators glow would be the unrealistic choice. Note the reinterpretation: the
**idle loop sits at ~520 K** — today's 77 kW base rejection at heat01 = 0 is a
fitted constant, not a "cold" ship (a 300 K loop would need ~100 m² for 77 kW).
520–605 K coolant implies a liquid-metal or high-pressure loop. Honest options: (a) no visible
change (what a camera would see), (b) a *thermal-imaging* overlay (false colour,
clearly an instrument, like the survey views), or (c) indirect cues: heat
shimmer in air (E5), and the loop's sound.

**Bells do glow, with real lag.** Per bell: ε 0.85, C ≈ 9 kJ/K (a tuning knob —
e.g. ~6–8 kg of C-C at its hot-temperature c ≈ 1.5 kJ/kgK; times scale linearly
with C). While burning the plasma heats the inner face and ~1.5 m² effectively
radiates: equilibrium 1,400 K at full vacuum thrust (278 kW per bell). Visible
(900 K) after ~20 s of full burn from cold, 1,350 K after ~53 s; a warm bell gets
there sooner (state persists between burns). After cutoff both faces radiate
(~3 m²): 1,200 K in ~5 s, 900 K in ~21 s, under the Draper point in ~33 s, 700 K
in ~53 s. Short taps never glow; a long burn leaves the bells glowing orange
fading to dull red for about half a minute. One node per bell ignores the real
throat-to-lip gradient (the throat is far hotter); the axial gradient in §4 is
cosmetic, and c(T) rising with T would slow both directions somewhat. In air the bell also loses heat by convection and the cooler,
denser jet heats it less (`plasma01`), so atmospheric hovering glows less.

## 3. Design: a small thermal network in the sim

`src/sim/ship/thermal.ts` (headless, sim-core rules). Nodes, each with a
temperature and a heat capacity, stepped on the fixed step after `stepShip`:

| Node | Heated by | Cooled by | Shown as |
|---|---|---|---|
| Bell port / starboard | drive plasma radiation ∝ throttle × (0.3 + 0.7·plasma01) | own radiation εσA(T⁴−T_env⁴); convection in air; conduction k·(T−T_loop) to the loop | blackbody glow on the bell liner (throat→lip gradient), ticks/pings as it cools |
| Coolant loop (= `heat01`, reinterpreted as T_loop) | laser, processing, repair, boost, transit, overdrive, + bell conduction (~5 % of bell input) | radiators: εσA(T_rad⁴ − T_sink⁴) | HUD bar (unchanged), loop sound, radiators invisible (or IR overlay) |
| Hull skin (later) | aero heating (M7), sunlight (inner system) | radiation, conduction to loop | ticks; entry glow is the E7 item |

Rules:
- **`heat01` keeps its meaning and its balance.** The radiator law is refit to
  Stefan–Boltzmann so it matches today's 77/127 kW at h = 0/1 (T_sink = 3 K in
  vacuum); only the curve between changes, and `pnpm`'s resource gates re-run.
  Sun/planet sink temperature becomes a later, explicit gameplay decision (M3
  plan §5.3 defers it).
- **Normal thrust now heats the loop a little** (bell conduction ≈ 2 × 14 kW at
  full thrust). That is below the 77 kW base rejection, so thrust alone never
  moves the HUD bar; it only matters stacked on mining/processing. ⚠ Still a
  balance change → call out, gate with the existing resource checks.
- **Attribution is kept**: each source writes its kW into a per-source record,
  so visuals/audio/HUD can say *where* the heat came from.
- **Co-op**: bell temperature is a deterministic function of a ship's thrust
  history, so remote ships integrate their own bells locally from the synced
  thrust — no protocol change. The loop stays per-player as today.
- **Save**: bells are not saved (they cool within ~2 min; a reload starts cold).

## 4. What it looks and sounds like

- **Bell glow** (code + small model work): clone the liner/throat materials per
  ship; TSL emissive = blackbody(T) via `blackbodyLuminanceNits` /
  `blackbodyLinearSrgb`, × an axial gradient from object-space z (throat hottest),
  × side mask sign(x) (one mesh holds both bells), × `uPreExposure`, exactly 0
  below ~800 K (the ShipOne lesson: a glowing idle bell wrecked metering).
  LOD0 only (the liner merges into machinery at LOD1/2) — acceptable, or split
  the liner in `build.py` for LOD1. Optional Blender pass: split port/starboard
  bells and add a vertex-colour heat mask following the cooling channels.
- **Radiators**: no visible glow (physically right). Optional later: a
  thermal-imaging overlay as an instrument mode. Needs the ventral radiator skin
  split into its own material in `build.py` (it shares the solar skin's today).
- **Ticks** (replaces the audio's private `soak`): a Poisson rate ∝ |dT/dt| of
  each node, **both signs** (thermoelastic strain rate; a cold-start heat-up is the
  loudest), amplitude only weakly dependent on it. Bell pings — higher, sharper,
  aft — peak in the first ~10 s after cutoff and are gone within ~30–60 s (bell
  dT/dt: 31 K/s at 1400 K, 5 K/s at 900 K, 0.5 K/s at 500 K). The loop/hull ticks
  are the long tail: they follow real stored heat, so a long burn + mining session
  ticks for minutes, a tap does not.
- **Loop sound** (small): coolant pump/flow bed whose level follows rejected kW,
  so heat management is audible before the bar is critical.

## 5. Phases

| Phase | Scope | Gate |
|---|---|---|
| H0 | `thermal.ts` nodes, bell model, Stefan–Boltzmann radiator refit, per-source attribution; `heat01` meaning kept | Node gate (`pnpm check:thermal`): bell heat-up/cool-down times above, vacuum vs air, radiator law vs today at h 0/1, thrust-alone keeps heat01 at 0; existing resource/transit gates unchanged |
| H1 | Bell glow on local + remote ships (local thermal integration from thrust) | headless captures: cold bell exactly 0 emissive, glow onset ~20 s, metering unaffected at idle (`__lum`), LOD0 only |
| H2 | Audio: ticks/pings from node cooling rates; coolant-loop bed | `__audio.selftest`, recorded mix after a long burn vs a tap |
| H3 | Model: split radiator skin material, optional bell split/heat mask (`pnpm model`) | model QA sheet + validator |
| H4 (later) | Sun/planet sink (near Earth the sink is ~255 K; a sun-facing radiator can stop rejecting), atmosphere convection on radiators and bells, aero heating (M7), coil cryo loop, thermal-imaging overlay | per-feature |

Physics claims in §2 were adversarially re-derived (Stefan–Boltzmann, lumped
Euler, Planck × V(λ)) on 2026-11-23; corrections from that pass are folded in.

## 6. Decisions for the owner

1. Is a small thrust heat into the loop OK (invisible alone, adds to mining)?
2. Radiators: leave visually inert (honest), or plan the thermal-imaging overlay?
3. Bell glow LOD0-only, or also split the liner for LOD1 (Blender work)?

## 7. As built (H0–H2, 2026-11-23)

- **H0** `src/sim/ship/thermal.ts`, stepped inside `stepShipResources`. One bell
  node (both bells see the same thrust; the shader could split them by sign(x)),
  C 15 kJ/K, 3 m² radiating, 556 kW plasma load at full vacuum thrust ×
  (0.3 + 0.7·plasma01), convection ∝ √(ρ·(1+v/50)), conduction 16.5 W/K into the
  loop. **The radiator law is unchanged**; the loop temperature is derived from
  the rejection (Stefan–Boltzmann on 22 m²), so balance is bit-identical except
  the bells' conducted excess (only the excess: an idle ship behaves exactly as
  before). Per-source heat kept in `thermal.sources`. Bells are not saved; a
  loaded world starts cold. `pnpm check:thermal` (14 checks), measured:
  equilibrium 1,391 K; 900 K after 15 s; after cutoff 1,200 K in 7 s, 900 K in
  33 s, Draper in 52 s; a 3 s tap 475 K; Earth sea level 1,023 K; thrust alone
  heat01 stays 0 (28.8 kW conducted < 77 kW base); mining trip 15.0 s → 14.2 s
  with full thrust.
- **H1** `src/components/models/ships/bellGlow.ts`: per-ship cloned liner/throat
  materials, emissive = ε·blackbody luminance (cd/m² → game units) × blackbody
  hue × pre-exposure, half-float clamp, zero below 700 K; LOD0 liner gets a
  throat→lip radiance gradient on its wrap UV (×1.7 → ×0.3); the throat runs
  8 % hotter. Remote ships integrate `stepBells` locally from the synced thrust
  and the air at their position — no protocol change. **Model**: `build.py`
  gives the bell (and the LOD2 throat) its own "Distant drive liner" material at
  LOD1/LOD2 (was merged into machinery/graphite), +1 primitive each; LOD0
  unchanged. Verified headless: glow orange at 1,400 K, dull red at 1,150 K,
  gone at 880 K; co-op gate `remoteBells`: host integrates the guest's bells at
  1,136 K vs the guest's own 1,146 K, lit on all LOD materials.
  ⚠ Trap: the material claim must be in an effect — a StrictMode double-invoked
  `useMemo` left the mesh holding one set of clones while the loop lit the other.
- **H2** bell pings (`ship.bell.ping`, new preset) and loop ticks
  (`ship.hull.tick`) are Poisson processes at 0.12 / 0.25 events per K/s of
  |dT/dt|, both signs (≈3.7/s right after a hot cutoff, 0.6/s at 900 K, none at
  idle). **Revised after listening (owner, 2026-11-23):** a 5 s tap pinged ~15×
  during and ~9× after while the heat bar never moved. Stick-slip needs stored
  thermal stress, so bell pings now fade in only 250–450 K above the bell's idle
  temperature and heating pings at 0.3× (a heating part expands freely; the
  classic tick is contraction after a long run). Expected pings during/after:
  5 s burn 0/0, 15 s 6/21, 30 s 19/62, 90 s 24/81. **Second revision (owner:
  "too many ticks in general"):** the Poisson-∝-|dT/dt| law ticked ~140/min
  mining to trip and ~75/min forever while heat hovered. Ticking is now
  stick-slip with hysteresis (`stepSlip`): each node stores its temperature
  change since the last slip, slips past a threshold (bells 100 K heating /
  35 K cooling, loop 25 / 14 K, jittered ±40 %), and a reversal relaxes it.
  Totals: 5 s tap 0; 90 s burn 30 pings; mining to trip + cool-down 9 ticks;
  2 min of mining held near 85 % 7 ticks (was ~150). Live: hot bells
  1,400 → 923 K in 30 s gave 15 pings; a full heat bar cooling gave 6 ticks.
  Coolant loop bed (`ship.coolant.loop`, new preset): silent at idle,
  level 0.2→1 and +500 cents with heat01. The audio's private `soak` is gone.
- Review (reviewer + adversarial verifier): confirmed and fixed — bells held out of
  the loop during transit burns (its predictor plans from heat01 alone), the
  half-float clamp now leaves room for the gradient's ×1.7 peak, a per-frame
  closure removed; plus a NaN guard on the bell inputs (heat01 is saved).
  Rejected/documented: remote bells use airspeed 0 and start cold on mount
  (cosmetic divergence, measured 10 K in the co-op gate); the gradient's mean is
  0.8× the lumped radiance (taste); load/heat-sink steps make a one-step loop-rate
  spike (≤ 3 ticks/s cap).
- Not done: a visual co-op capture with the remote ship close (numbers verified,
  frame not), and the listening pass.
