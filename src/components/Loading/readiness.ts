/**
 * "Has the scene finished loading?" — the checks `__test.settled()` and the M0.4 loading
 * gate share. `check` is allocation-free (per-frame); `describe` builds the report strings.
 */
import type { createStore } from "jotai";
import { devTeleportAtom } from "@/store/dev";
import { repositionState } from "@/sim/ship/reposition";
import { hasPendingCloudBakes } from "@/components/celestial/bodies/cloudVolumeCompute";
import { isStbnLoaded, isStbnPending } from "@/components/celestial/bodies/stbnTexture";
import { installNetworkTracking, net, networkQuiet } from "./netActivity";
import { nearFieldLoadSettled } from "@/sim/physics/nearField";

installNetworkTracking();

type Store = ReturnType<typeof createStore>;
export type ResidentMemory = { textures: number; geometries: number };

export const PENDING_TELEPORT = 1;
export const PENDING_CLOUD_BAKES = 2;
export const PENDING_BLUE_NOISE = 4;
export const PENDING_NETWORK = 8;
export const PENDING_RESOURCES = 16;
/** Physics engine still loading: holds one PHYSICS_LOAD_TIMEOUT_MS window; a second runs in play, flagged. */
export const PENDING_PHYSICS = 32;

/** Resident texture/geometry counts must hold this many frames. */
const RESOURCE_STABLE_FRAMES = 30;

export type Readiness = {
  /** Bitmask of unmet conditions (0 = loaded). Call once per rendered frame. */
  check(store: Store, frame: number, quietMs: number, memory: ResidentMemory | null | undefined): number;
  describe(mask: number): string[];
};

/**
 * `requireBlueNoise`: settled() waits for the blue-noise atlas even before anything requests
 * it; the loading gate waits only once it has been requested (nothing does away from clouds).
 */
export function createReadiness(startFrame: number, requireBlueNoise = true): Readiness {
  let textures = -1;
  let geometries = -1;
  let stableSince = startFrame;
  return {
    check(store, frame, quietMs, memory) {
      let mask = 0;
      if (store.get(devTeleportAtom) !== null || repositionState.pending !== null || repositionState.arrivalSince > 0) mask |= PENDING_TELEPORT;
      if (hasPendingCloudBakes()) mask |= PENDING_CLOUD_BAKES;
      if (requireBlueNoise ? !isStbnLoaded() : isStbnPending()) mask |= PENDING_BLUE_NOISE;
      if (!networkQuiet(quietMs)) mask |= PENDING_NETWORK;
      const t = memory ? memory.textures : -1;
      const g = memory ? memory.geometries : -1;
      if (t !== textures || g !== geometries) {
        textures = t;
        geometries = g;
        stableSince = frame;
      }
      if (frame - stableSince < RESOURCE_STABLE_FRAMES) mask |= PENDING_RESOURCES;
      if (!nearFieldLoadSettled()) mask |= PENDING_PHYSICS;
      return mask;
    },
    describe(mask) {
      const out: string[] = [];
      if (mask & PENDING_TELEPORT) out.push("teleport");
      if (mask & PENDING_CLOUD_BAKES) out.push("cloudBakes");
      if (mask & PENDING_BLUE_NOISE) out.push("blueNoise");
      if (mask & PENDING_NETWORK) out.push(`network(${net.inFlight} in flight)`);
      if (mask & PENDING_PHYSICS) out.push("physics");
      if (mask & PENDING_RESOURCES) out.push(`resources(${textures < 0 ? "" : `${textures}/${geometries}`})`);
      return out;
    },
  };
}
