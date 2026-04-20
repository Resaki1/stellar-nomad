# GAME_DESIGN.md — Stellar Nomad Systems Reference

> **Purpose:** Self-contained reference for the research tree, items, equip system, progression
> structure, and implementation details. Each section can be implemented independently.
> See STORY.md for narrative context. See CLAUDE.md for coding conventions.

---

## Table of Contents

1. [Design Philosophy](#1-design-philosophy)
2. [Progression Structure](#2-progression-structure)
3. [Module Equip System](#3-module-equip-system)
4. [Research Tree](#4-research-tree)
5. [Items Catalogue](#5-items-catalogue)
6. [Resource Economy](#6-resource-economy)
7. [New Mechanics](#7-new-mechanics)
8. [Comms Messages](#8-comms-messages-for-research--crafting)
9. [Research Panel UI](#9-research-panel-ui-tree-view)
10. [Implementation Roadmap](#10-implementation-roadmap)

---

## 1. Design Philosophy

**Every research completion is a moment.** Immediate passive bonus + new crafting possibilities. Double reward.

**Branches have instant identity.** A new player sees 3 paths and immediately understands: "find stuff better / mine better / tougher ship."

**Items within a branch tell a story.** Early items are foundational. Later items build on that foundation. Capstones feel transformative.

**Consumables create gameplay.** 2-3 consumables per branch. They give reasons to keep crafting and create tactical decisions during mining runs.

**One module per slot creates build identity.** The player chooses which module to equip per slot. Different choices = different playstyle. Mk2 replaces Mk1 (not stacks).

**Capstones reward commitment.** Tier 3 requires both tier-2 sub-branches within the same branch.

---

## 2. Progression Structure

Act I has two phases, gated by the Transit Drive milestone:

### Phase 1: Near-Earth (Tutorial + Early Progression)
- Mine asteroids in near-Earth orbit
- Research tier 0, 1, and 2 nodes
- Craft tier 1-2 items using basic resources (silicates, fe_ni_metal, carbon, sulfur, hydrates)
- **Goal:** Build the Transit Drive to reach the Moon

### Transit Drive Milestone
- Unlocked by special research node requiring **any 3 completed tier-2 nodes** (across any branches)
- Expensive crafting recipe using all 5 basic resource types
- Once built, permanently enables fast transit to the Moon (~30-60s flight)

### Phase 2: Lunar (Mid-to-Late Act I)
- Mine lunar asteroids for **new resources**: helium-3 and titanium
- Research tier 3 capstone nodes (still costs assay samples only)
- Craft tier 3 items (recipes require lunar resources)
- **Goal:** Prepare for the Valkyrie Drive (Act I endgame capstone)

### Future Phases (Not Yet Designed)
- Asteroid Belt, Gas Giants, Valkyrie Drive construction, Proxima transit

---

## 3. Module Equip System

### Current System (To Be Changed)
All owned modules are permanently active. No equip limits. Effects stack infinitely.

### New System: One Module Per Slot

**Rule:** The player equips exactly one module per slot type. Only the equipped module's effects apply. Owned-but-unequipped modules sit in inventory.

**7 equip slots** (same as existing `ItemSlot` types):

| Slot | Description | Module choices |
|------|-------------|---------------|
| scanner | Sensor/detection systems | 4 modules (Prospector Mk1, Ping Array, Spectral Mapper, Integrated Suite) |
| mining | Laser/extraction systems | 4 modules (Beam Focuser Mk1/Mk2, Yield Extractor, Pulse Modulator) |
| cooling | Thermal management | 3 modules (Radiator Strips Mk1/Mk2, Coolant Circulator) |
| cargo | Storage capacity | 2 modules (Cargo Rack Mk1/Mk2) |
| hull | Armor/survivability | 3 modules (Ablative Plating Mk1/Mk2, Nanite Repair) |
| propulsion | Speed/handling | 3 modules (Reaction Wheels, Thruster Nozzles Mk1/Mk2) |
| utility | Misc. ship systems | 1 module (Assay Enhancer) |

**Consumables are NOT affected.** The hotbar (10 slots for consumables) is a separate system.

**Swap freely.** No cost to swap modules. Player can change loadout anytime.

**Auto-equip on craft:** When a module is crafted and its slot is empty, auto-equip it. If the slot is occupied, add to inventory and notify ("New module fabricated. Mining slot in use. Swap from the loadout panel when ready.").

### Code Changes Required

**`ModulesState` in `src/store/modules.ts`:**
```typescript
type ModulesState = {
  ownedModules: string[];
  equippedModules: Partial<Record<ItemSlot, string>>;  // NEW
  consumables: Record<string, number>;
  consumableCooldowns: Record<string, number>;
  hotbar: (string | null)[];
};
```

**`computedModifiersAtom`:** Change from iterating `state.ownedModules` to iterating `Object.values(state.equippedModules)`.

**New actions:** `equipModuleAtom(itemId)`, `unequipSlotAtom(slot)`.

**Migration:** On load of old save data (no `equippedModules` field), auto-equip all owned modules (one per slot, prefer highest tier). The `modules-v1` storage key should be bumped to `modules-v2`.

---

## 4. Research Tree

### Visual Structure

```
                          r0: MicroLab Boot
                        /         |         \
                   A1: Sensor   B1: Laser   C1: Structural
                   Calibration  Optics      Engineering
                    /     \      /    \       /      \
               A2a:     A2b:  B2a:  B2b:  C2a:    C2b:
               Active   Spect Beam  Therm Hull    Propul
               Scan     Anal  Optim Dynam Reinf   Systems
                 \      /      \    /       \      /
                  A3:          B3:          C3:
                  Integr.      Pulse        Integr.
                  Survey       Extract      Platform

                         M1: Transit Drive
                    (requires any 3 tier-2 nodes)
```

**3 branches, 4 nodes each.** Each branch: 1 entry (tier 1) -> 2 specializations (tier 2) -> 1 capstone (tier 3, requires both tier-2s).
Plus 1 milestone node. **14 total nodes.**

### Node Definitions

#### Root

| Field | Value |
|-------|-------|
| **ID** | `r0_microlab_boot` |
| **Name** | MicroLab Boot Sequence |
| **Desc** | Initialize onboard analysis lab. ESA uplink handshake, assay framework bootstrap |
| **Duration** | 45s |
| **Cost** | 1 assay sample |
| **Prerequisites** | none |
| **Research bonus** | none |
| **Unlocks research** | `a1_sensor_calibration`, `b1_laser_optics`, `c1_structural_engineering` |
| **Unlocks items** | none |

---

#### Branch A: Survey & Detection

**A1: Sensor Calibration**

| Field | Value |
|-------|-------|
| **ID** | `a1_sensor_calibration` |
| **Name** | Sensor Calibration |
| **Desc** | Refine the sensor array to interpret asteroid return signals more precisely |
| **Duration** | 90s |
| **Cost** | 2 assay samples |
| **Prerequisites** | `r0_microlab_boot` |
| **Research bonus** | Target lock speed +15% — `scanner.lockSpeedMultiplier` multiply 0.85 |
| **Unlocks research** | `a2a_active_scanning`, `a2b_spectral_analysis` |
| **Unlocks items** | `module_prospector_scanner_mk1`, `consumable_assay_probe` |

**A2a: Active Scanning**

| Field | Value |
|-------|-------|
| **ID** | `a2a_active_scanning` |
| **Name** | Active Scanning |
| **Desc** | Develop wide-angle active ping for rapid field survey and asteroid detection |
| **Duration** | 180s |
| **Cost** | 5 assay samples |
| **Prerequisites** | `a1_sensor_calibration` |
| **Research bonus** | Mining yield +5% — `mining.yieldMultiplier` multiply 1.05 |
| **Unlocks research** | `a3_integrated_survey` (with `a2b_spectral_analysis`) |
| **Unlocks items** | `module_ping_array_mk1`, `consumable_scanner_pulse` |

**A2b: Spectral Analysis**

| Field | Value |
|-------|-------|
| **ID** | `a2b_spectral_analysis` |
| **Name** | Spectral Analysis |
| **Desc** | Map spectral signatures to resolve composition bands during target analysis |
| **Duration** | 200s |
| **Cost** | 6 assay samples |
| **Prerequisites** | `a1_sensor_calibration` |
| **Research bonus** | Assay sample bonus +15% — `mining.assaySampleBonusChance` add 0.15 |
| **Unlocks research** | `a3_integrated_survey` (with `a2a_active_scanning`) |
| **Unlocks items** | `module_spectral_mapper_mk1`, `module_assay_enhancer_mk1`, `consumable_composition_scan` |

**A3: Integrated Survey Suite** (Capstone)

| Field | Value |
|-------|-------|
| **ID** | `a3_integrated_survey` |
| **Name** | Integrated Survey Suite |
| **Desc** | Fuse active and spectral systems into a unified deep-field survey platform |
| **Duration** | 360s |
| **Cost** | 12 assay samples |
| **Prerequisites** | `a2a_active_scanning` AND `a2b_spectral_analysis` |
| **Research bonus** | All sensor ranges +20% — `scanner.allRangeMultiplier` multiply 1.20 |
| **Unlocks items** | `module_integrated_sensor_suite`, `consumable_deep_scan_probe` |

---

#### Branch B: Extraction Engineering

**B1: Laser Optics**

| Field | Value |
|-------|-------|
| **ID** | `b1_laser_optics` |
| **Name** | Laser Optics Calibration |
| **Desc** | Recalibrate mining laser optics for tighter coherence and faster ablation |
| **Duration** | 90s |
| **Cost** | 2 assay samples |
| **Prerequisites** | `r0_microlab_boot` |
| **Research bonus** | Mining speed +5% — `mining.timePerAsteroidMultiplier` multiply 0.95 |
| **Unlocks research** | `b2a_beam_optimization`, `b2b_thermal_dynamics` |
| **Unlocks items** | `module_beam_focuser_mk1`, `consumable_overclock_charge` |

**B2a: Beam Optimization**

| Field | Value |
|-------|-------|
| **ID** | `b2a_beam_optimization` |
| **Name** | Beam Optimization |
| **Desc** | Optimize laser pulse shaping for maximum energy-to-ablation efficiency |
| **Duration** | 200s |
| **Cost** | 6 assay samples |
| **Prerequisites** | `b1_laser_optics` |
| **Research bonus** | Mining speed +8% — `mining.timePerAsteroidMultiplier` multiply 0.92 |
| **Unlocks research** | `b3_pulse_extraction` (with `b2b_thermal_dynamics`) |
| **Unlocks items** | `module_beam_focuser_mk2`, `module_yield_extractor_mk1`, `consumable_precision_charge` |

**B2b: Thermal Dynamics**

| Field | Value |
|-------|-------|
| **ID** | `b2b_thermal_dynamics` |
| **Name** | Thermal Dynamics |
| **Desc** | Develop thermal routing and emergency heat-dump procedures for sustained extraction |
| **Duration** | 220s |
| **Cost** | 7 assay samples |
| **Prerequisites** | `b1_laser_optics` |
| **Research bonus** | Heat capacity +10% — `mining.heatBuildUpRateMultiplier` multiply 0.90 |
| **Unlocks research** | `b3_pulse_extraction` (with `b2a_beam_optimization`) |
| **Unlocks items** | `module_radiator_strips_mk1`, `module_coolant_circulator_mk1`, `consumable_heat_sink_cartridge` |

**B3: Pulse Extraction** (Capstone)

| Field | Value |
|-------|-------|
| **ID** | `b3_pulse_extraction` |
| **Name** | Pulse Extraction Firmware |
| **Desc** | Develop pulsed extraction firmware for thermally stable, continuous mining |
| **Duration** | 400s |
| **Cost** | 14 assay samples |
| **Prerequisites** | `b2a_beam_optimization` AND `b2b_thermal_dynamics` |
| **Research bonus** | All mining efficiency +10% — `mining.overallEfficiencyMultiplier` multiply 1.10 |
| **Unlocks items** | `module_pulse_modulator_mk1`, `module_radiator_strips_mk2`, `consumable_thermal_purge` |

---

#### Branch C: Ship Systems

**C1: Structural Engineering**

| Field | Value |
|-------|-------|
| **ID** | `c1_structural_engineering` |
| **Name** | Structural Engineering |
| **Desc** | Analyze hull stress patterns for field-fabricated structural integration |
| **Duration** | 90s |
| **Cost** | 2 assay samples |
| **Prerequisites** | `r0_microlab_boot` |
| **Research bonus** | Cargo capacity +100 — `ship.cargoCapacity` add 100 |
| **Unlocks research** | `c2a_hull_reinforcement`, `c2b_propulsion_systems` |
| **Unlocks items** | `module_cargo_rack_mk1`, `consumable_hull_patch_kit` |

**C2a: Hull Reinforcement**

| Field | Value |
|-------|-------|
| **ID** | `c2a_hull_reinforcement` |
| **Name** | Hull Reinforcement |
| **Desc** | Engineer composite plating and damage absorption systems for collision survivability |
| **Duration** | 210s |
| **Cost** | 6 assay samples |
| **Prerequisites** | `c1_structural_engineering` |
| **Research bonus** | Hull HP +5% — `ship.maxHealthMultiplier` multiply 1.05 |
| **Unlocks research** | `c3_integrated_platform` (with `c2b_propulsion_systems`) |
| **Unlocks items** | `module_ablative_plating_mk1`, `module_cargo_rack_mk2`, `consumable_emergency_repair_kit` |

**C2b: Propulsion Systems**

| Field | Value |
|-------|-------|
| **ID** | `c2b_propulsion_systems` |
| **Name** | Propulsion Systems |
| **Desc** | Optimize RCS authority and main nozzle efficiency for improved flight handling |
| **Duration** | 240s |
| **Cost** | 7 assay samples |
| **Prerequisites** | `c1_structural_engineering` |
| **Research bonus** | Top speed +10% — `ship.maxSpeedMultiplier` multiply 1.10 |
| **Unlocks research** | `c3_integrated_platform` (with `c2a_hull_reinforcement`) |
| **Unlocks items** | `module_reaction_wheels_mk1`, `module_thruster_nozzles_mk1`, `consumable_afterburner_charge` |

**C3: Integrated Ship Platform** (Capstone)

| Field | Value |
|-------|-------|
| **ID** | `c3_integrated_platform` |
| **Name** | Integrated Ship Platform |
| **Desc** | Full platform integration: structural, propulsion, and autonomous repair systems |
| **Duration** | 420s |
| **Cost** | 14 assay samples |
| **Prerequisites** | `c2a_hull_reinforcement` AND `c2b_propulsion_systems` |
| **Research bonus** | All ship stats +5% — `ship.maxHealthMultiplier` multiply 1.05, `ship.maxSpeedMultiplier` multiply 1.05, `ship.accelerationMultiplier` multiply 1.05, `ship.decelerationMultiplier` multiply 1.05 |
| **Unlocks items** | `module_ablative_plating_mk2`, `module_thruster_nozzles_mk2`, `module_nanite_repair_mk1` |

---

#### Milestone

**M1: Transit Drive Calibration**

| Field | Value |
|-------|-------|
| **ID** | `m1_transit_drive` |
| **Name** | Transit Drive Calibration |
| **Desc** | Calibrate interplanetary transit drive parameters for sustained high-delta-v burns |
| **Duration** | 300s |
| **Cost** | 10 assay samples |
| **Prerequisites** | Any 3 completed tier-2 nodes (special rule — see implementation notes) |
| **Research bonus** | none (the drive itself is the reward) |
| **Unlocks items** | `special_transit_drive` (special crafting project, not a regular module) |

**Implementation note:** The "any 3 tier-2 nodes" prerequisite is a new type. The tier-2 node IDs are: `a2a_active_scanning`, `a2b_spectral_analysis`, `b2a_beam_optimization`, `b2b_thermal_dynamics`, `c2a_hull_reinforcement`, `c2b_propulsion_systems`. The prerequisite check counts how many of these are in `completedNodes` and requires >= 3. This can be encoded as a special `prerequisites` format or a custom check.

---

### Research Passive Bonuses — Implementation

Each `ResearchNodeDef` gains a new optional field:

```typescript
type ResearchNodeDef = {
  // ... existing fields ...
  /** Passive effects applied permanently when this node is completed. */
  researchEffects?: ItemEffect[];
};
```

**Application chain:**
1. `computedModifiersAtom` currently reads only equipped module effects
2. Create `researchModifiersAtom` — reads `completedNodeSetAtom`, looks up each node's `researchEffects`, aggregates them identically to module effects
3. `effectiveShipConfigAtom` combines base config + module modifiers + research modifiers

**New effect keys needed** (not currently in `applyModifiers`):

| Key | Op | Config field mapping | Notes |
|-----|-----|---------------------|-------|
| `scanner.lockSpeedMultiplier` | multiply | New field: `scannerLockSpeedMult` | Reduces time to achieve target lock |
| `scanner.allRangeMultiplier` | multiply | New field: `scannerRangeMult` | Multiplies all sensor/ping ranges |
| `mining.yieldMultiplier` | multiply | `miningEfficiencyMult` | Maps to existing field |
| `mining.assaySampleBonusChance` | add | New field: `assaySampleBonusChance` | 0-1 probability of bonus sample |
| `mining.cooldownSpeedMultiplier` | multiply | `miningCooldownS` (inverse) | Faster cooldown recovery |
| `mining.overallEfficiencyMultiplier` | multiply | `miningSpeedMult` + `miningEfficiencyMult` | Affects both speed and yield |
| `scanner.lockShowsYieldEstimate` | set | New flag | Shows estimated yield on target lock |
| `ship.hullRegenPerSecond` | add | New field: `hullRegenPerSecond` | Passive HP/s regen |

---

## 5. Items Catalogue

### Summary

| Category | Count |
|----------|-------|
| Modules | 20 |
| Consumables | 11 |
| Special items | 1 (Transit Drive) |
| **Total** | **32** |

---

### Modules

All modules are one-time crafts. One equipped per slot. Mk2 replaces Mk1 (does not stack).

#### Scanner Slot

| ID | Name | Branch | Effects | Recipe |
|----|------|--------|---------|--------|
| `module_prospector_scanner_mk1` | Prospector Scanner Mk1 | A1 | `scanner.lockShowsAsteroidType` set true | 180 silicates, 60 fe_ni_metal, 20 carbon, 8 sulfur |
| `module_ping_array_mk1` | Ping Array Mk1 | A2a | `scanner.pingHighlightEnabled` set true, `scanner.pingHighlightRangeMultiplier` multiply 1.15 | 260 silicates, 90 fe_ni_metal, 25 carbon, 15 sulfur |
| `module_spectral_mapper_mk1` | Spectral Mapper Mk1 | A2b | `scanner.lockShowsCompositionBands` set true | 200 silicates, 80 fe_ni_metal, 60 carbon, 20 sulfur, 30 hydrates |
| `module_integrated_sensor_suite` | Integrated Sensor Suite | A3 | `scanner.lockShowsAsteroidType` set true, `scanner.pingHighlightEnabled` set true, `scanner.pingHighlightRangeMultiplier` multiply 1.25, `scanner.lockShowsCompositionBands` set true, `scanner.lockShowsYieldEstimate` set true | 400 silicates, 150 fe_ni_metal, 80 carbon, 40 sulfur, 50 hydrates, 30 titanium |

**Choice landscape:** Prospector (type info on lock) vs Ping Array (active field scan) vs Spectral Mapper (deep analysis) vs Integrated Suite (all-in-one capstone). Early game forces a choice; capstone removes it.

#### Mining Slot

| ID | Name | Branch | Effects | Recipe |
|----|------|--------|---------|--------|
| `module_beam_focuser_mk1` | Beam Focuser Mk1 | B1 | `mining.timePerAsteroidMultiplier` multiply 0.85 | 200 silicates, 70 fe_ni_metal, 40 carbon, 10 sulfur |
| `module_beam_focuser_mk2` | Beam Focuser Mk2 | B2a | `mining.timePerAsteroidMultiplier` multiply 0.75 | 400 silicates, 120 fe_ni_metal, 60 carbon, 25 sulfur |
| `module_yield_extractor_mk1` | Yield Extractor Mk1 | B2a | `mining.yieldMultiplier` multiply 1.20 | 300 silicates, 100 fe_ni_metal, 80 carbon, 30 sulfur |
| `module_pulse_modulator_mk1` | Pulse Modulator Mk1 | B3 | `ability.pulseMiningEnabled` set true | 350 silicates, 100 fe_ni_metal, 60 carbon, 40 sulfur, 20 helium_3 |

**Choice landscape:** Beam Focuser (raw speed) vs Yield Extractor (more resources per rock) vs Pulse Modulator (sustained mining, never overheat). Speed vs yield vs sustainability.

#### Cooling Slot

| ID | Name | Branch | Effects | Recipe |
|----|------|--------|---------|--------|
| `module_radiator_strips_mk1` | Radiator Strips Mk1 | B2b | `mining.heatBuildUpRateMultiplier` multiply 0.80 | 350 silicates, 80 fe_ni_metal, 50 carbon, 30 sulfur |
| `module_coolant_circulator_mk1` | Coolant Circulator Mk1 | B2b | `mining.cooldownSpeedMultiplier` multiply 1.30 | 280 silicates, 100 fe_ni_metal, 40 carbon, 35 sulfur |
| `module_radiator_strips_mk2` | Radiator Strips Mk2 | B3 | `mining.heatBuildUpRateMultiplier` multiply 0.65 | 500 silicates, 120 fe_ni_metal, 80 carbon, 50 sulfur, 15 titanium |

**Choice landscape:** Radiator Strips (slower heat buildup = mine longer per cycle) vs Coolant Circulator (faster recovery when you DO overheat). Prevention vs recovery.

#### Cargo Slot

| ID | Name | Branch | Effects | Recipe |
|----|------|--------|---------|--------|
| `module_cargo_rack_mk1` | Cargo Rack Mk1 | C1 | `ship.cargoCapacity` add 400 | 250 silicates, 120 fe_ni_metal, 10 sulfur |
| `module_cargo_rack_mk2` | Cargo Rack Mk2 | C2a | `ship.cargoCapacity` add 800 | 500 silicates, 250 fe_ni_metal, 20 sulfur |

**Progression:** Mk2 replaces Mk1 (800 total, not 1200). Straightforward upgrade path.

#### Hull Slot

| ID | Name | Branch | Effects | Recipe |
|----|------|--------|---------|--------|
| `module_ablative_plating_mk1` | Ablative Plating Mk1 | C2a | `ship.maxHealthMultiplier` multiply 1.25, `ship.collisionDamageMultiplier` multiply 0.90 | 300 silicates, 200 fe_ni_metal, 30 carbon, 15 sulfur |
| `module_ablative_plating_mk2` | Ablative Plating Mk2 | C3 | `ship.maxHealthMultiplier` multiply 1.50, `ship.collisionDamageMultiplier` multiply 0.80 | 500 silicates, 350 fe_ni_metal, 40 carbon, 25 sulfur, 40 titanium |
| `module_nanite_repair_mk1` | Nanite Repair System | C3 | `ship.hullRegenPerSecond` add 0.2 | 300 silicates, 250 fe_ni_metal, 100 carbon, 40 sulfur, 30 titanium, 20 helium_3 |

**Choice landscape:** Ablative Plating (tank: more HP + less collision damage) vs Nanite Repair (sustain: slow passive regeneration). Tank vs regen — a classic RPG choice.

#### Propulsion Slot

| ID | Name | Branch | Effects | Recipe |
|----|------|--------|---------|--------|
| `module_reaction_wheels_mk1` | Reaction Wheels Mk1 | C2b | `ship.decelerationMultiplier` multiply 1.20 | 180 silicates, 200 fe_ni_metal, 15 carbon, 20 sulfur |
| `module_thruster_nozzles_mk1` | Thruster Nozzles Mk1 | C2b | `ship.accelerationMultiplier` multiply 1.15, `ship.maxSpeedMultiplier` multiply 1.20 | 250 silicates, 250 fe_ni_metal, 20 carbon, 30 sulfur |
| `module_thruster_nozzles_mk2` | Thruster Nozzles Mk2 | C3 | `ship.accelerationMultiplier` multiply 1.25, `ship.maxSpeedMultiplier` multiply 1.40 | 400 silicates, 400 fe_ni_metal, 30 carbon, 50 sulfur, 25 helium_3 |

**Choice landscape:** Reaction Wheels (braking/control — cautious pilot) vs Thruster Nozzles (speed/acceleration — aggressive pilot). Different flying styles.

#### Utility Slot

| ID | Name | Branch | Effects | Recipe |
|----|------|--------|---------|--------|
| `module_assay_enhancer_mk1` | Assay Enhancer Mk1 | A2b | `mining.assaySampleBonusChance` add 0.20 | 150 silicates, 60 fe_ni_metal, 50 carbon, 20 sulfur, 40 hydrates |

Currently only one utility module. Room for future expansion.

---

### Consumables

Crafted in stacks. Used from the 10-slot hotbar. Per-item comms message fires on first craft only.

| ID | Name | Branch | Stack | Effect type | Effect | Recipe (per unit) |
|----|------|--------|-------|-------------|--------|-------------------|
| `consumable_assay_probe` | Assay Probe | A1 | 10 | Information | Shows locked target's full resource breakdown before mining | 60 silicates, 20 carbon, 15 hydrates |
| `consumable_scanner_pulse` | Scanner Pulse | A2a | 10 | Information | Temporarily enhances sensor sweep — reveals additional asteroid data for 30s | 80 silicates, 30 fe_ni_metal, 15 carbon |
| `consumable_composition_scan` | Composition Scan | A2b | 10 | Information | All asteroids in range show their type for 30s | 100 silicates, 30 carbon, 25 hydrates |
| `consumable_deep_scan_probe` | Deep Scan Probe | A3 | 5 | Information | Full-spectrum burst: complete data (type, composition, yield) on all asteroids in a large radius for 60s | 120 silicates, 50 fe_ni_metal, 40 carbon, 30 hydrates |
| `consumable_overclock_charge` | Overclock Charge | B1 | 10 | Timed stat | Mining speed +30% for 20s — `mining.timePerAsteroidMultiplier` multiply 0.70 | 80 silicates, 20 carbon, 15 sulfur |
| `consumable_precision_charge` | Precision Charge | B2a | 5 | Instant | Guarantees bonus resource yield from current mining target | 100 silicates, 30 fe_ni_metal, 25 sulfur |
| `consumable_heat_sink_cartridge` | Heat Sink Cartridge | B2b | 10 | Instant stat | `mining.currentHeat` add -0.50 | 90 silicates, 30 carbon, 8 sulfur |
| `consumable_thermal_purge` | Thermal Purge Charge | B3 | 5 | Instant stat | `mining.currentHeat` set 0.0 (full reset) | 150 silicates, 40 carbon, 25 sulfur |
| `consumable_hull_patch_kit` | Hull Patch Kit | C1 | 10 | Instant stat | Restore 15 hull HP | 100 silicates, 60 fe_ni_metal, 10 sulfur |
| `consumable_emergency_repair_kit` | Emergency Repair Kit | C2a | 5 | Instant stat | Restore 30 hull HP | 180 silicates, 120 fe_ni_metal, 20 sulfur |
| `consumable_afterburner_charge` | Afterburner Charge | C2b | 5 | Timed stat | Speed +50% for 8s — `ship.maxSpeedMultiplier` multiply 1.50, `ship.accelerationMultiplier` multiply 1.50 | 80 silicates, 60 fe_ni_metal, 15 sulfur |

#### Consumable Effect Categories

Three implementation categories:

1. **Instant stat effects** — Apply immediately, one-shot. Existing infrastructure (heat sink buffer pattern).
   - Heat Sink Cartridge, Thermal Purge Charge, Hull Patch Kit, Emergency Repair Kit

2. **Timed stat effects** — Apply a temporary modifier, revert after duration. **Needs new infrastructure:** a `timedEffects` array in state, tick-based expiration, modifier integration.
   - Overclock Charge (20s), Afterburner Charge (8s)

3. **Information effects** — Trigger UI/gameplay behaviors. **Needs custom handlers** per consumable type in the relevant gameplay systems (mining, scanner).
   - Assay Probe, Scanner Pulse, Composition Scan, Deep Scan Probe, Precision Charge

---

### Special Items

**Transit Drive**

| Field | Value |
|-------|-------|
| ID | `special_transit_drive` |
| Name | Interplanetary Transit Drive |
| Type | Special (not a module — permanent ship system) |
| Recipe | 800 silicates, 600 fe_ni_metal, 200 carbon, 100 sulfur, 50 hydrates |
| Effect | Permanently enables "Transit to Moon" in navigation. ~30-60s real-time flight. |

Once crafted, stored as a boolean flag (e.g., `transitDriveBuilt` in ship config or a dedicated atom). Cannot be unequipped.

---

## 6. Resource Economy

### Existing Resources (Near-Earth)

| ID | Name | Primary source | Abundance |
|----|------|---------------|-----------|
| `silicates` | Silicates | S-type (65-80%) | Very common |
| `fe_ni_metal` | Fe-Ni Metal | X-type (60-90%) | Common |
| `carbon` | Carbon | C-type (2-6%) | Moderate |
| `sulfur` | Sulfur | All types (1-7%) | Moderate |
| `hydrates` | Hydrates | C-type (5-15%) | Scarce |

### New Lunar Resources (Phase 2)

| ID | Name | Source | Notes |
|----|------|--------|-------|
| `titanium` | Titanium | Lunar asteroids | Structural material. Required for tier-3 module recipes. |
| `helium_3` | Helium-3 | Lunar regolith asteroids | Nuclear fuel. Required for propulsion/mining capstone recipes. Story-critical for Valkyrie Drive. |

### Recipe Philosophy

| Branch | Primary resources | Rationale |
|--------|------------------|-----------|
| A (Survey) | carbon, hydrates, silicates | Information tech needs rare materials — C-type asteroid hunting |
| B (Extraction) | silicates, sulfur, carbon | Mining tech built from mining byproducts |
| C (Ship Systems) | fe_ni_metal, silicates | Structural work needs metal — X-type asteroid hunting |
| Consumables | Cheap (1/4 to 1/3 of module costs) | Must be craftable regularly |
| Mk2 modules | ~2x the Mk1 recipe | Clear upgrade investment |
| Tier-3 items | Basic resources + titanium/helium_3 | Gates behind Moon milestone |
| Transit Drive | All 5 basic, expensive (~1750 total) | Major milestone investment |

---

## 7. New Mechanics

### Pulse Mining

**What it is:** An alternative mining mode unlocked by Pulse Modulator Mk1.

**How it works:**
- Player toggles between **Continuous** (default) and **Pulse** mode
- In Pulse mode, the laser fires in automatic rhythmic bursts: ~1.5s on, ~0.5s off
- During "off" micro-pauses, heat partially dissipates (net ~40% heat reduction vs continuous)
- Mining progress accumulates during "on" phases only

**Comparison:**

| | Continuous Mode | Pulse Mode |
|---|---|---|
| Mining speed | 100% | ~70-75% |
| Heat profile | Linear rise | Sawtooth, caps ~60-65% capacity |
| Overheat risk | High on large asteroids | Near zero |
| Best for | Small asteroids (finish before overheat) | Large asteroids (no forced cooldowns) |

**Implementation:**
- `ability.pulseMiningEnabled` flag (already exists) gates the toggle
- Mining system checks the flag and alternates beam state on a timer
- Heat dissipation during "off" phases uses existing cooldown rate
- Visual: laser beam visibly pulses, distinct audio rhythm
- UI: toggle indicator on HUD near heat gauge

### Transit Drive

**What it is:** A special ship system enabling fast transit to the Moon.

**Unlock flow:**
1. Complete `m1_transit_drive` research (requires 3 tier-2 nodes)
2. Craft the Transit Drive (expensive recipe, all 5 basic resources)
3. Navigation system gains "Transit to Moon" option

**Flight mechanic:**
- Player selects "Transit to Moon" from navigation
- Ship aligns to Moon, drive engages
- ~30-60 seconds of real-time flight: dramatic acceleration, Earth shrinks, Moon grows
- Arrival at lunar asteroid field
- Return trip available at any time (same mechanism)

**NOT a cutscene.** The player is in the ship during transit. Visual spectacle: engine glow, star streaks, celestial body scale change. This should feel like a "wow" moment.

**Implementation scope:** This is a significant feature (new scene/environment, flight sequence, lunar asteroid generation with new resources). Should be its own implementation session.

---

## 8. Comms Messages for Research & Crafting

### System Design

Every research completion and every item craft triggers a short AI comms message. For consumables, only the first craft triggers a message.

**Trigger mechanism** (avoids 44 individual useEffect hooks):

New signal atoms:
- `lastCompletedResearchIdAtom` in `research.ts` — set to the node ID when `tickResearchAtom` completes a node
- `lastCraftedItemIdAtom` in `modules.ts` — set to the item ID when `addCraftedItemAtom` runs

New message catalogues in `commsMessages.ts`:
- `RESEARCH_COMPLETE_MESSAGES: Record<string, CommsMessage>`
- `ITEM_CRAFTED_MESSAGES: Record<string, CommsMessage>`

Two general-purpose watchers in `GameCommsTriggers.tsx`:
```typescript
// Research completion
const lastResearchId = useAtomValue(lastCompletedResearchIdAtom);
useEffect(() => {
  if (!lastResearchId) return;
  const msg = RESEARCH_COMPLETE_MESSAGES[lastResearchId];
  if (msg) enqueue(msg);
}, [lastResearchId, enqueue]);

// Item crafted
const lastCraftedId = useAtomValue(lastCraftedItemIdAtom);
useEffect(() => {
  if (!lastCraftedId) return;
  const msg = ITEM_CRAFTED_MESSAGES[lastCraftedId];
  if (msg) enqueue(msg);
}, [lastCraftedId, enqueue]);
```

The played-message registry prevents replays automatically.

**Note:** The existing `research_start_001` (AI: MicroLab calibration started), `research_complete_001` (Stern: MicroLab complete), and `first_craft_001` (AI: first fabrication) messages remain. The new per-item/per-research messages are ADDITIONAL and fire alongside those existing triggers where applicable.

### Research Completion Messages

All messages: speaker `{{AI_NAME}}`, priority 1, no delay.

| Node ID | Message ID | Text |
|---------|------------|------|
| `a1_sensor_calibration` | `rc_a1_sensor_calibration` | "Sensor calibration locked in. Return signals are reading cleaner already — I can pull more detail from the raw data now." |
| `a2a_active_scanning` | `rc_a2a_active_scanning` | "Active ping subroutines loaded. Sensor sweep is available — should make prospecting considerably less manual." |
| `a2b_spectral_analysis` | `rc_a2b_spectral_analysis` | "Spectral analysis framework online. I can break reflected light into composition bands now. No more mining blind." |
| `a3_integrated_survey` | `rc_a3_integrated_survey` | "Full sensor integration complete. Every system feeding into one survey model. I'll admit — this is satisfying to see come together." |
| `b1_laser_optics` | `rc_b1_laser_optics` | "Optics recalibrated. Beam coherence is tighter. You should notice the difference on the next pass." |
| `b2a_beam_optimization` | `rc_b2a_beam_optimization` | "Beam pulse shaping optimized. Energy-to-ablation efficiency is significantly better. More rock per joule." |
| `b2b_thermal_dynamics` | `rc_b2b_thermal_dynamics` | "Thermal dynamics models integrated. I've mapped every heat pathway in the laser assembly — sustained fire is much more manageable." |
| `b3_pulse_extraction` | `rc_b3_pulse_extraction` | "Pulse extraction firmware loaded. The laser can sustain fire indefinitely with the right rhythm. This changes things." |
| `c1_structural_engineering` | `rc_c1_structural_engineering` | "Structural analysis complete. Load-bearing patterns mapped across the hull. Field fabrication should be straightforward from here." |
| `c2a_hull_reinforcement` | `rc_c2a_hull_reinforcement` | "Composite plating specs validated. The simulations show significant improvement in collision survivability." |
| `c2b_propulsion_systems` | `rc_c2b_propulsion_systems` | "Propulsion optimization complete. RCS authority and nozzle efficiency both improved. The ship should feel more responsive." |
| `c3_integrated_platform` | `rc_c3_integrated_platform` | "Full platform integration done. Structural, propulsion, and autonomous systems all linked. This ship is... considerably more than what left Earth orbit." |
| `m1_transit_drive` | `rc_m1_transit_drive` | "Transit drive calibration complete. Interplanetary burn parameters validated. The Moon is within reach — fabricate the drive and we can make the crossing." |

### Module Craft Messages

All messages: speaker `{{AI_NAME}}`, priority 1, no delay.

| Item ID | Message ID | Text |
|---------|------------|------|
| `module_prospector_scanner_mk1` | `ic_prospector_scanner_mk1` | "Prospector Scanner online. Target lock will now identify asteroid classification — S-type, C-type, or X-type." |
| `module_ping_array_mk1` | `ic_ping_array_mk1` | "Ping Array installed. Sensor sweep will highlight targetable asteroids in range." |
| `module_spectral_mapper_mk1` | `ic_spectral_mapper_mk1` | "Spectral Mapper integrated. Composition band analysis now available on target lock." |
| `module_assay_enhancer_mk1` | `ic_assay_enhancer_mk1` | "Assay Enhancer calibrated. Sample recovery should improve — the collection system is wasting less material." |
| `module_integrated_sensor_suite` | `ic_integrated_sensor_suite` | "Integrated Sensor Suite online. Every scanner system unified. Full-spectrum awareness — this is how survey work should be done." |
| `module_beam_focuser_mk1` | `ic_beam_focuser_mk1` | "Beam Focuser installed. Tighter coherence, faster ablation. Mining should be noticeably quicker." |
| `module_beam_focuser_mk2` | `ic_beam_focuser_mk2` | "Beam Focuser Mk2 online. Significant refinement over the first iteration — the energy profile is more aggressive." |
| `module_yield_extractor_mk1` | `ic_yield_extractor_mk1` | "Yield Extractor calibrated. The collection system will capture material previously lost to ablation scatter." |
| `module_pulse_modulator_mk1` | `ic_pulse_modulator_mk1` | "Pulse Modulator installed. New mining mode available — pulsed extraction. Slower peak rate, but sustainable on large targets." |
| `module_radiator_strips_mk1` | `ic_radiator_strips_mk1` | "Radiator strips mounted. Passive heat rejection improved — the laser will run cooler under sustained fire." |
| `module_coolant_circulator_mk1` | `ic_coolant_circulator_mk1` | "Coolant Circulator online. Overheat recovery will be faster when the laser hits its limit." |
| `module_radiator_strips_mk2` | `ic_radiator_strips_mk2` | "Radiator Strips Mk2 installed. Thermal rejection is substantially better. The originals look primitive by comparison." |
| `module_cargo_rack_mk1` | `ic_cargo_rack_mk1` | "Cargo Rack secured. Additional storage volume online — should help with longer mining runs." |
| `module_cargo_rack_mk2` | `ic_cargo_rack_mk2` | "Cargo Rack Mk2 installed. That's a significant hold expansion. We can stockpile properly now." |
| `module_ablative_plating_mk1` | `ic_ablative_plating_mk1` | "Ablative plating bonded to the hull. Collision resistance improved — won't make us invincible, but we'll take hits better." |
| `module_ablative_plating_mk2` | `ic_ablative_plating_mk2` | "Ablative Plating Mk2 in place. The composite layering is more sophisticated. This hull can handle real punishment." |
| `module_nanite_repair_mk1` | `ic_nanite_repair_mk1` | "Nanite Repair System activated. Autonomous hull restoration. Slow, but it works while we do other things. I find the concept... appealing." |
| `module_reaction_wheels_mk1` | `ic_reaction_wheels_mk1` | "Reaction Wheels installed. Attitude control authority improved — braking should feel tighter." |
| `module_thruster_nozzles_mk1` | `ic_thruster_nozzles_mk1` | "Thruster Nozzles fitted. Acceleration and top speed both improved. You'll feel the difference." |
| `module_thruster_nozzles_mk2` | `ic_thruster_nozzles_mk2` | "Thruster Nozzles Mk2 online. The acceleration curve is aggressive. This ship moves like something considerably smaller." |

### Consumable First-Craft Messages

All messages: speaker `{{AI_NAME}}`, priority 1, no delay. Fire only on the **first** craft of each consumable type (played-message registry handles this).

| Item ID | Message ID | Text |
|---------|------------|------|
| `consumable_assay_probe` | `ic_assay_probe` | "Assay Probes ready. Deploy on a locked target for a resource breakdown before committing to a mining pass." |
| `consumable_scanner_pulse` | `ic_scanner_pulse` | "Scanner Pulse charges fabricated. Temporary enhanced sweep — useful for quick field assessment." |
| `consumable_composition_scan` | `ic_composition_scan` | "Composition Scan Charges ready. Activate one and every asteroid in range reveals its type briefly." |
| `consumable_deep_scan_probe` | `ic_deep_scan_probe` | "Deep Scan Probes fabricated. Full-spectrum burst — complete data on everything in range. Temporary, but thorough." |
| `consumable_overclock_charge` | `ic_overclock_charge` | "Overclock Charges fabricated. Temporary mining speed boost. Pushes the laser past safe parameters for a short burst." |
| `consumable_precision_charge` | `ic_precision_charge` | "Precision Charges ready. Use during mining for a guaranteed bonus yield from the current target." |
| `consumable_heat_sink_cartridge` | `ic_heat_sink_cartridge` | "Heat Sink Cartridges fabricated. Emergency thermal dump — vents significant laser heat instantly." |
| `consumable_thermal_purge` | `ic_thermal_purge` | "Thermal Purge Charges ready. Complete heat reset. More potent than a standard heat sink — save these for critical moments." |
| `consumable_hull_patch_kit` | `ic_hull_patch_kit` | "Hull Patch Kits fabricated. Field repair for hull damage. Not full restoration, but keeps us in one piece." |
| `consumable_emergency_repair_kit` | `ic_emergency_repair_kit` | "Emergency Repair Kits ready. Substantial hull restoration — more effective than basic patches." |
| `consumable_afterburner_charge` | `ic_afterburner_charge` | "Afterburner Charges fabricated. Temporary thrust override. Significant speed burst for a few seconds." |

---

## 9. Research Panel UI — Tree View

> **Status:** Future work. Current panel is a flat list. This section specifies the target design.

### Layout

Left-to-right tree graph. Each branch occupies a horizontal band:

```
[r0] ─── [A1] ─┬─ [A2a] ─┐
                └─ [A2b] ─┴─ [A3]

[r0] ─── [B1] ─┬─ [B2a] ─┐
                └─ [B2b] ─┴─ [B3]

[r0] ─── [C1] ─┬─ [C2a] ─┐
                └─ [C2b] ─┴─ [C3]

              [M1] (centered below, lines to tier-2 nodes)
```

Prerequisite arrows connect nodes. The diamond pattern (split at tier 2, converge at tier 3) should be visually clear.

### Node States

| State | Visual | Interaction |
|-------|--------|-------------|
| **Locked** | Greyed out, lock icon, dimmed connections | Hover shows prerequisites needed |
| **Available** | Full color, glowing border, cost visible | Click to select, click "Start" to begin |
| **In Progress** | Animated progress ring, elapsed/total time | Shows progress bar, cancel option |
| **Completed** | Checkmark, completed color, solid connections | Hover shows research bonus + unlocked items |

### Detail Panel

On node select/hover, show a side panel with:
- Node name and description
- Duration and assay sample cost
- **Research bonus** (the passive effect on completion)
- **Unlocked items** with icons, names, and brief descriptions
- Prerequisites (which are met / unmet)

### Branch Identity

Each branch should have a distinct visual identity:
- **A (Survey):** Blue tones
- **B (Extraction):** Orange tones
- **C (Ship Systems):** Green tones
- **M1 (Milestone):** Gold/special

### Component Structure (Suggested)

```
ResearchTree/
  ResearchTree.tsx          — Main container, layout logic
  ResearchTreeNode.tsx      — Individual node (state-driven rendering)
  ResearchTreeEdge.tsx      — SVG/CSS connection lines between nodes
  ResearchDetailPanel.tsx   — Side panel showing selected node details
  researchTreeLayout.ts     — Node position calculations
```

---

## 10. Implementation Roadmap

Ordered by dependency. Each step can be a separate session.

### Step 1: Research Tree + Items Data
**Files:** `src/data/content.ts`
**Changes:**
- Replace `RESEARCH_NODES` array with new 14-node tree
- Replace `ITEMS` array with new 32-item catalogue
- Add `researchEffects` field to `ResearchNodeDef` type
- Add new effect key descriptions to `EFFECT_DESCRIPTIONS` and `describeEffect()`
- Update `ALL_ITEM_SLOTS` and `SLOT_LABELS` if needed
**Dependencies:** None. Pure data change.
**Note:** The milestone node's "any 3 tier-2" prerequisite needs a special `prerequisites` encoding. Options: (a) a `prerequisiteRule` field like `{ type: "anyN", nodes: [...], count: 3 }`, or (b) handle in `visibleNodesAtom` with special-case logic.

### Step 2: Module Equip System
**Files:** `src/store/modules.ts`, `src/store/shipConfig.ts`
**Changes:**
- Add `equippedModules: Partial<Record<ItemSlot, string>>` to `ModulesState`
- Change `computedModifiersAtom` to iterate equipped modules only
- Add `equipModuleAtom`, `unequipSlotAtom` actions
- Auto-equip logic on craft (if slot empty)
- Migration: old saves auto-equip all owned modules
- Bump storage key `modules-v1` -> `modules-v2`
**Dependencies:** Step 1 (needs new items defined)

### Step 3: Research Passive Bonuses
**Files:** `src/store/shipConfig.ts`, `src/store/modules.ts` (or new `src/store/researchEffects.ts`)
**Changes:**
- Create `researchModifiersAtom` — aggregates effects from completed research nodes
- Update `effectiveShipConfigAtom` to combine base + module modifiers + research modifiers
- Add new config fields: `scannerLockSpeedMult`, `scannerRangeMult`, `assaySampleBonusChance`, `hullRegenPerSecond`
- Update `applyModifiers()` to handle new effect keys
**Dependencies:** Step 1 (needs `researchEffects` data)

### Step 4: Crafting Panel + Equip UI Updates
**Files:** `src/components/HUD/CraftingPanel/CraftingPanel.tsx`, possibly new loadout panel
**Changes:**
- Show equipped vs owned state for modules
- Equip/unequip controls
- Show "Equipped" badge vs "Owned" vs craftable
- Handle auto-equip notification
**Dependencies:** Step 2 (equip system must exist)

### Step 5: Comms Messages for Research & Crafting
**Files:** `src/data/commsMessages.ts`, `src/store/research.ts`, `src/store/modules.ts`, `src/components/Comms/GameCommsTriggers.tsx`
**Changes:**
- Add `RESEARCH_COMPLETE_MESSAGES` and `ITEM_CRAFTED_MESSAGES` catalogues
- Add `lastCompletedResearchIdAtom` signal to research store
- Add `lastCraftedItemIdAtom` signal to modules store
- Add two general-purpose watchers in GameCommsTriggers
- Update existing `GameCommsTriggers` for changed research node IDs
**Dependencies:** Step 1 (new node/item IDs)

### Step 6: New Consumable Effects Infrastructure
**Files:** `src/store/modules.ts`, `src/components/HUD/Hotbar/Hotbar.tsx`, mining system, ship systems
**Changes:**
- **Instant stat effects:** Hull repair consumables (modify `shipHealthAtom` directly)
- **Timed stat effects:** New `activeTimedEffects` state, tick-based expiration, modifier integration (Overclock, Afterburner)
- **Information effects:** Custom handlers per consumable type (Assay Probe, Scanner Pulse, Composition Scan, Deep Scan Probe, Precision Charge)
**Dependencies:** Step 1 (item definitions), Step 3 (config fields)

### Step 7: Pulse Mining Mode
**Files:** Mining system (`src/sim/` or relevant component)
**Changes:**
- Implement beam pulsing logic (1.5s on / 0.5s off cycle)
- Heat dissipation during off phases
- Mining progress calculation in pulse mode (~70-75% of continuous)
- Toggle UI (HUD element near heat gauge)
- Visual: pulsing laser beam, distinct audio
**Dependencies:** Step 1 (Pulse Modulator item must be defined)

### Step 8: Research Panel UI — Tree View
**Files:** New `src/components/HUD/ResearchPanel/` components
**Changes:**
- Replace current flat-list research panel with visual tree graph
- Node positioning, SVG/CSS connection lines
- Node state rendering (locked/available/in-progress/completed)
- Detail panel on select
- Branch coloring (blue/orange/green)
- Show research bonus in node details
**Dependencies:** Step 1 (tree structure), Step 3 (research bonuses to display)

### Step 9: Transit Drive + Moon Environment
**Files:** Multiple new files + system config
**Changes:**
- Transit Drive crafting (special item type)
- Navigation UI for transit
- Flight sequence (30-60s)
- Lunar asteroid field environment
- New resources (titanium, helium_3) in system config
- Lunar asteroid classes with new resource compositions
- Story comms messages for Moon arrival
**Dependencies:** Steps 1-6 (full research/item system must be working)

---

## Appendix: Effect Keys Reference

### Existing (Already in Code)

| Key | Op | Used by |
|-----|-----|---------|
| `scanner.lockShowsAsteroidType` | set | Prospector Scanner Mk1, Integrated Sensor Suite |
| `scanner.pingHighlightEnabled` | set | Ping Array Mk1, Integrated Sensor Suite |
| `scanner.pingHighlightRangeMultiplier` | multiply | Ping Array Mk1, Integrated Sensor Suite |
| `scanner.lockShowsCompositionBands` | set | Spectral Mapper Mk1, Integrated Sensor Suite |
| `ship.cargoCapacity` | add | Cargo Rack Mk1/Mk2, C1 research bonus |
| `mining.timePerAsteroidMultiplier` | multiply | Beam Focuser Mk1/Mk2, B1/B2a research bonuses, Overclock Charge |
| `mining.heatBuildUpRateMultiplier` | multiply | Radiator Strips Mk1/Mk2, B2b research bonus |
| `ship.maxHealthMultiplier` | multiply | Ablative Plating Mk1/Mk2, C2a/C3 research bonuses |
| `ship.collisionDamageMultiplier` | multiply | Ablative Plating Mk1/Mk2 |
| `ship.decelerationMultiplier` | multiply | Reaction Wheels Mk1, C3 research bonus |
| `ship.accelerationMultiplier` | multiply | Thruster Nozzles Mk1/Mk2, C3 research bonus, Afterburner Charge |
| `ship.maxSpeedMultiplier` | multiply | Thruster Nozzles Mk1/Mk2, C2b/C3 research bonuses, Afterburner Charge |
| `ability.pulseMiningEnabled` | set | Pulse Modulator Mk1 |
| `mining.currentHeat` | add/set | Heat Sink Cartridge, Thermal Purge Charge |
| `scanner.lockSpeedMultiplier` | multiply | A1 research bonus | New: `scannerLockSpeedMult` |
| `scanner.allRangeMultiplier` | multiply | A3 research bonus | New: `scannerRangeMult` |
| `scanner.lockShowsYieldEstimate` | set | Integrated Sensor Suite | New flag |
| `mining.yieldMultiplier` | multiply | Yield Extractor Mk1, A2a research bonus | Maps to existing `miningEfficiencyMult` |
| `mining.assaySampleBonusChance` | add | Assay Enhancer Mk1, A2b research bonus | New: `assaySampleBonusChance` |
| `mining.cooldownSpeedMultiplier` | multiply | Coolant Circulator Mk1 | Inverse of existing `miningCooldownS` |
| `mining.overallEfficiencyMultiplier` | multiply | B3 research bonus | Affects both `miningSpeedMult` and `miningEfficiencyMult` |
| `ship.hullRegenPerSecond` | add | Nanite Repair Mk1 | New: `hullRegenPerSecond` |
