/**
 * THE ONE PLACE A STAR SYSTEM IS LOADED.
 *
 * See [`docs/STAR_RENDERING_PLAN.md`](../../docs/STAR_RENDERING_PLAN.md) §25.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `sol.json` was imported directly by five unrelated modules — the Jotai atom, the
 * derived constants, two perf harnesses and the atmosphere presets. Each of those is
 * a hard-coded assumption that there is exactly one system and it is Sol, and they
 * are invisible: nothing about `import solSystem from ".../sol.json"` says "this
 * blocks procedural systems".
 *
 * 🔑 The value is not the indirection, it is that **there is now one grep result to
 * change** and one place to state what a system switch would break. That is the same
 * judgement R7c made about `systemStars()`: routing the choice through one function
 * is what buys something; renaming 35 call sites is not.
 *
 * ── ⚠⚠ SWITCHING SYSTEMS AT RUNTIME DOES NOT WORK YET, AND HERE IS THE LIST ──
 * `setActiveSystem` deliberately throws after the first frame rather than half-work.
 * A silently-partial switch would be the worst outcome: a scene with Sol's radii and
 * a new system's positions is far harder to diagnose than a refusal.
 *
 * What blocks it, exhaustively as of 2026-09-02:
 *
 *  1. **`celestialConstants` derives module-level constants at load** — every
 *     `*_POSITION_KM`, `*_RADIUS_KM` and the four `STAR_*` exports. The positions are
 *     mutable arrays the ephemeris rewrites in place, so they would *follow* a switch;
 *     the SCALARS would not.
 *  2. **Three reads bake the primary into a shader at load** — `earth.ts`'s
 *     `uniform(kmToScaledUnits(STAR_RADIUS_KM))` and two in `photometry.ts`. R7c's
 *     §23.4 lists them; `__lum.starSystem()` prints them.
 *  3. **`atmosphereData` builds its presets at module load** from body descriptions.
 *  4. **The body components are one module per body** (`earth.ts`, `jupiter.ts`, …),
 *     each with its own textures and shader graph. A generated system needs a
 *     PARAMETERISED body renderer, which is a much larger piece than this file.
 *
 * ⇒ Items 1–3 are mechanical. Item 4 is the real work, and it is what "procedural
 * systems" mostly means. This module exists so that when item 4 is done, items 1–3
 * are a known, enumerated list rather than an archaeology exercise.
 */

import solSystem from "@/sim/systems/sol.json";
import type { SystemConfig } from "@/sim/systemTypes";

/** Every system this build can load. */
export const SYSTEM_IDS = ["sol"] as const;
export type SystemId = (typeof SYSTEM_IDS)[number];

/**
 * ⚠ A static map, not a dynamic `import()`. `celestialConstants` derives its exports
 * at module-evaluation time and is imported by things that run before any async work
 * can complete, so the active system must be available synchronously. A generated
 * system will arrive from a seed rather than a file, so it will not need a fetch
 * either — the async path is for ASSETS (textures, meshes), not for the description.
 */
const SYSTEMS: Record<SystemId, SystemConfig> = {
  sol: solSystem as unknown as SystemConfig,
};

let _activeId: SystemId = "sol";

/** Load a system by id. Throws on an unknown id rather than falling back to Sol. */
export function loadSystem(id: SystemId): SystemConfig {
  const s = SYSTEMS[id];
  if (!s) {
    throw new Error(
      `[systemRegistry] unknown system "${id}" — known: ${SYSTEM_IDS.join(", ")}`,
    );
  }
  return s;
}

/**
 * The active system.
 *
 * ⚠ Returns the SAME object every call, and callers rely on that: the body configs
 * hold references into its `positionKm` arrays, which the ephemeris rewrites in
 * place. Never return a copy from here.
 */
export const activeSystem = (): SystemConfig => loadSystem(_activeId);

export const activeSystemId = (): SystemId => _activeId;

let _frames = 0;

/** Called once per frame by the renderer, so the guard below can mean "at startup". */
export function markSystemFrame(): void {
  _frames++;
}

/**
 * Switch systems. Only legal before the first rendered frame.
 *
 * ⚠ It throws rather than half-working — see the blocker list in this file's header.
 * When items 1–4 are addressed this becomes the entry point; until then the refusal is
 * the honest behaviour, and a thrown error names the reason.
 */
export function setActiveSystem(id: SystemId): void {
  loadSystem(id); // validate first
  if (_frames > 0) {
    throw new Error(
      "[systemRegistry] cannot switch systems after the first frame: " +
        "celestialConstants, atmosphereData and three shader uniforms bake the " +
        "active system at module load. See this file's header for the full list.",
    );
  }
  _activeId = id;
}
