import { atom } from "jotai";
import type { ReplicationPoint } from "@/save/types";

/** World points, mirrored from authority events (worldBridge.ts). Starter first. Kept apart from replication.ts, which loads three. */
export const replicationPointsAtom = atom<ReplicationPoint[]>([]);
