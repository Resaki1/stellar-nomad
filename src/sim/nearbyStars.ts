/**
 * `nearbyStars` — the interstellar neighbourhood as navigable, renderable objects.
 *
 * See [`docs/STAR_RENDERING_PLAN.md`](../../docs/STAR_RENDERING_PLAN.md) §12 (R2b).
 *
 * `public/data/stars_nearby.json` (166 stars) already carries everything needed:
 * `posLy` in **equatorial J2000**, `magV`, `absMagV`, `colorBV`, `distLy` and a name.
 * This module turns each row into
 *
 *   • a **position in km in the GAME frame** — so it can be flown to, marked and
 *     mounted through the same `<Star>` renderer as Sol, and
 *   • the derived `StarParams` (radius, T_eff, disc radiance) from `starPhysics`.
 *
 * 🔑 Nothing here is authored per star. The radius comes from Stefan–Boltzmann via
 * the bolometric correction, the temperature from B−V, the brightness from
 * `absMagV` — see `starPhysics`. Add a row to the JSON and it is navigable.
 *
 * ⚠⚠ THE FRAME CONVERSION IS NOT OPTIONAL AND NOT LOCAL. `equatorialToGame` is
 * imported from `StarField` rather than re-derived, because a second copy of that
 * rotation is exactly how the sky ends up mirrored — `project_sky_orientation`
 * records four self-consistent checks that all passed while the panorama was wrong.
 * One conversion, one owner.
 *
 * ⚠ Sol is NOT in this list (it is the primary, and lives in the system config),
 * but `SOL_STAR_ID` is exported so callers can offer it alongside these.
 */

import * as THREE from "three";

import { equatorialToGame } from "@/components/Stars/StarField";
import {
  starParamsFromCatalogue,
  type StarParams,
} from "@/components/space/starPhysics";
import { LY_IN_KM } from "@/sim/units";

/** Sentinel id for the primary, so one dropdown can list it with the rest. */
export const SOL_STAR_ID = "sol";

/** One row of `stars_nearby.json`, as authored. */
type NearbyStarRow = {
  id: number;
  name?: string;
  named?: boolean;
  hip?: string;
  gl?: string;
  distLy: number;
  magV: number;
  absMagV: number;
  colorBV: number;
  spectral?: string;
  posLy: [number, number, number];
  nakedEye?: boolean;
};

export type NearbyStar = {
  /** Stable slug, usable as a POI id and a dropdown value. */
  id: string;
  name: string;
  distLy: number;
  /** Apparent V magnitude as seen from Sol. */
  magV: number;
  /** Visible to the naked eye from Sol (as flagged by the catalogue). */
  nakedEye: boolean;
  spectral: string;
  /** Position in km, GAME frame, origin at Sol. */
  positionKm: [number, number, number];
  /** Unit direction from Sol, game frame. */
  dirGame: [number, number, number];
  /** Radius, T_eff, disc radiance — all derived (starPhysics). */
  params: StarParams;
};

const _v = new THREE.Vector3();

function slug(row: NearbyStarRow): string {
  const base =
    row.name?.trim() ||
    (row.hip ? `HIP ${row.hip}` : "") ||
    row.gl?.trim() ||
    `star-${row.id}`;
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function toNearbyStar(row: NearbyStarRow): NearbyStar {
  // ⚠ posLy is equatorial J2000; the game's axes are not. One conversion, owned
  // by StarField.
  equatorialToGame(_v, row.posLy[0], row.posLy[1], row.posLy[2]);
  const lenLy = _v.length() || 1e-9;
  const dir: [number, number, number] = [
    _v.x / lenLy,
    _v.y / lenLy,
    _v.z / lenLy,
  ];
  // ⚠ Use the catalogue's own `distLy`, not |posLy| — they agree, but `distLy` is
  // the quantity `absMagV` was computed from, so it is the consistent one.
  const dKm = row.distLy * LY_IN_KM;
  return {
    id: slug(row),
    name: row.name?.trim() || (row.hip ? `HIP ${row.hip}` : slug(row)),
    distLy: row.distLy,
    magV: row.magV,
    nakedEye: row.nakedEye === true,
    spectral: row.spectral ?? "",
    positionKm: [dir[0] * dKm, dir[1] * dKm, dir[2] * dKm],
    dirGame: dir,
    params: starParamsFromCatalogue(row.absMagV, row.colorBV),
  };
}

let _stars: NearbyStar[] = [];
let _byId = new Map<string, NearbyStar>();
let _promise: Promise<NearbyStar[]> | null = null;

/**
 * Load once, cache forever. Returns the same array on every call.
 *
 * ⚠ `starParamsFromCatalogue` runs per row (166 of them) and is cheap, but
 * `limbDarkeningRgb` is NOT called here — that is ~70k `exp` calls per star and is
 * memoised inside `Star.tsx` for the one star actually mounted.
 */
export function loadNearbyStars(
  url = "/data/stars_nearby.json",
): Promise<NearbyStar[]> {
  if (_promise) return _promise;
  _promise = fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error(`[nearbyStars] ${r.status} fetching ${url}`);
      return r.json() as Promise<NearbyStarRow[]>;
    })
    .then((rows) => {
      _stars = rows
        .filter((r) => Number.isFinite(r.distLy) && r.distLy > 0)
        .map(toNearbyStar)
        .sort((a, b) => a.distLy - b.distLy);
      _byId = new Map(_stars.map((s) => [s.id, s]));
      console.log(`[nearbyStars] ${_stars.length} stars; nearest ${_stars[0]?.name}`);
      return _stars;
    })
    .catch((e) => {
      console.error(e);
      return [];
    });
  return _promise;
}

/** Synchronous view of whatever has loaded. Empty until `loadNearbyStars` resolves. */
export const getNearbyStars = (): readonly NearbyStar[] => _stars;
export const getNearbyStar = (id: string): NearbyStar | undefined => _byId.get(id);

/**
 * The `n` stars worth offering in a dev dropdown or as default markers: nearest
 * first, but preferring ones with a real name over catalogue designations so the
 * list is readable.
 */
export function notableNearbyStars(n = 12): NearbyStar[] {
  const named = _stars.filter((s) => s.name && !s.name.startsWith("HIP "));
  return (named.length >= n ? named : _stars).slice(0, n);
}
