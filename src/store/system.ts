import { atom } from "jotai";
import solSystem from "@/sim/systems/sol.json";
import type { SystemConfigV1 } from "@/sim/systemTypes";

/**
 * Phase 1: a single active system config loaded from JSON at build-time.
 * Later, you can extend this to support loading/switching systems dynamically.
 */
export const systemConfigAtom = atom<SystemConfigV1>(
  solSystem as unknown as SystemConfigV1
);
