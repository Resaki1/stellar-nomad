type Materials = Record<string, number>;

/** Draw each ingredient from depot stock before using any eligible ship cargo. */
export function planFabricationMaterials(
  recipe: Readonly<Materials>, depotStock: Readonly<Materials>, shipCargo?: Readonly<Materials>,
): { depot: Materials; ship: Materials; missing: Materials } {
  const depot: Materials = {};
  const ship: Materials = {};
  const missing: Materials = {};
  for (const [id, amount] of Object.entries(recipe)) {
    const fromDepot = Math.min(amount, depotStock[id] ?? 0);
    const fromShip = Math.min(amount - fromDepot, shipCargo?.[id] ?? 0);
    const shortfall = amount - fromDepot - fromShip;
    if (fromDepot > 0) depot[id] = fromDepot;
    if (fromShip > 0) ship[id] = fromShip;
    if (shortfall > 0) missing[id] = shortfall;
  }
  return { depot, ship, missing };
}
