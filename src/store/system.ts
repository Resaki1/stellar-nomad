import { atom } from "jotai";
import { activeSystem } from "@/sim/systemRegistry";
import type { SystemConfigV1 } from "@/sim/systemTypes";

/**
 * The active system, as a Jotai atom for React consumers.
 *
 * ⚠ `systemRegistry` is the authority; this is a view. Anything running outside React
 * — `celestialConstants`, the ephemeris, the perf harnesses — must read
 * `activeSystem()` directly, because they evaluate before any store exists.
 *
 * ⚠ Holds the SAME object the registry returns, not a copy: body configs hold
 * references into its `positionKm` arrays, which the ephemeris rewrites in place.
 */
export const systemConfigAtom = atom<SystemConfigV1>(
  activeSystem() as unknown as SystemConfigV1,
);
