/**
 * Ordered save migrations: MIGRATIONS[i] upgrades schemaVersion i+1 → i+2 and must set the
 * new `schemaVersion`. Append only; never edit a shipped entry. `parseSaveData` applies them.
 * They run on untrusted JSON: shape-check what they read and leave cleaning to the sanitisers.
 */
import { PROPELLANT_TANK_KG, RECOVERY_ALLOWANCE_KG } from "@/sim/ship/shipResources";

export type SaveMigration = (data: Record<string, unknown>) => Record<string, unknown>;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 1 → 2 (M3.1): completed research moves from every player into one world record (union, first
 * completion order, players in key order); wrecks gain empty fuel/consumable stores; players
 * gain full tanks, a charged capacitor, no heat and no batch; the world gains a receipt log.
 */
function v1ToV2(data: Obj): Obj {
  const world: Obj = isObj(data.world) ? { ...data.world } : {};
  const playersIn: Obj = isObj(data.players) ? data.players : {};
  const completed: string[] = [];
  const seen = new Set<string>();
  const players: Obj = {};
  for (const id of Object.keys(playersIn)) {
    const p = playersIn[id];
    if (!isObj(p)) {
      players[id] = p;
      continue;
    }
    const research: Obj = isObj(p.research) ? { ...p.research } : {};
    if (Array.isArray(research.completedNodes)) {
      for (const n of research.completedNodes) {
        if (typeof n === "string" && !seen.has(n)) {
          seen.add(n);
          completed.push(n);
        }
      }
    }
    delete research.completedNodes;
    players[id] = {
      ...p,
      research,
      propellant: { ordinaryKg: PROPELLANT_TANK_KG, protectedKg: RECOVERY_ALLOWANCE_KG },
      power: { capacitor01: 1, heat01: 0 },
      processing: null,
    };
  }
  if (Array.isArray(world.wrecks)) {
    world.wrecks = world.wrecks.map((w) => (isObj(w) ? { ...w, fuelKg: 0, consumables: {} } : w));
  }
  world.research = { completedNodes: completed };
  world.receipts = [];
  return { ...data, schemaVersion: 2, world, players };
}

export const MIGRATIONS: readonly SaveMigration[] = [v1ToV2];
