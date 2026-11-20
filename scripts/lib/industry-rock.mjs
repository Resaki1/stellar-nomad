// A small, volatile C-type rock in the authored Earth pocket. All fixtures use
// a real deterministic field instance so the live depletion path stays exercised.
export const earthMiningRock = {
  fieldId: "origin_belt",
  chunkKey: "origin_belt:-142,9,-10",
  instanceId: 269836855,
  frameId: "earth",
  positionKm: [-7821.917849609375, 183.50833422851562, 14810.796959960937],
  radiusM: 71.4870376586914,
};
export const earthMiningLoot = { silicates: 12, hydrates: 6, carbon: 1, fe_ni_metal: 3, sulfur: 1 };

export function earthMiningSite(eastKm) {
  const { frameId, positionKm } = earthMiningRock;
  return { frameId, positionKm: [positionKm[0] + eastKm, positionKm[1], positionKm[2]] };
}
