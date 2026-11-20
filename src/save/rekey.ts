import type { PlayerId, SaveData } from "./types";

/**
 * Re-key a single-player save to this device's player id (cleared localStorage, or a save carried
 * to another device). Never for a co-op world: more than one member, or a sole player who joined
 * as a guest (has a verifier), keeps its ids so guests' records do not collapse onto the host.
 */
export function rekeySolePlayer(data: SaveData, local: PlayerId): boolean {
  const ids = Object.keys(data.players);
  if (ids.length !== 1 || ids[0] === local) return false;
  const members = Object.keys(data.world.members);
  if (members.length > 1) return false;
  const m = data.world.members[ids[0]];
  if (m && m.verifier !== null) return false;
  data.players = { [local]: data.players[ids[0]] };
  data.world.members = { [local]: m ?? { name: "", verifier: null, joinedAt: 0 } };
  data.world.industry.depots = data.world.industry.depots.map(d => d.by === ids[0] ? { ...d, by: local } : d);
  return true;
}
