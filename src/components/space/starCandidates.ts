/**
 * THE PROMOTABLE SET — the union of the two star catalogues.
 *
 * See [`docs/STAR_RENDERING_PLAN.md`](../../../docs/STAR_RENDERING_PLAN.md) §20.
 *
 * ── 🐛🐛 WHY THIS EXISTS: §19 TRADED ONE BLIND SPOT FOR ANOTHER ──────────────
 * §19 moved the disc and light pools off `stars_nearby.json` (166 rows) and onto
 * `stars_visual.bin` (8,920 rows), because 8,754 rendered stars could not be promoted.
 * That fixed the reported case and created its mirror: the author flew to **Proxima
 * Centauri** and *"it never appeared visible. I only saw the marker, even at only
 * 11 km from it, and also no collision."*
 *
 * 🔑 NEITHER CATALOGUE IS A SUPERSET OF THE OTHER, and they are complementary by
 * construction:
 *
 *     stars_visual.bin    V ≤ 6.5 APPARENT   → bright, mostly distant (the naked-eye sky)
 *     stars_nearby.json   within ~50 ly      → close, mostly FAINT
 *
 * MEASURED: only **31 of 166** nearby stars have a sprite row. The other 135 are all
 * fainter than V 6.5 — and they are exactly the stars a player would fly to:
 *
 *     Proxima Centauri    4.227 ly   V 11.01   ← the nearest star to the Sun
 *     Barnard's Star      5.948 ly   V  9.54
 *     Wolf 359            7.797 ly   V 13.45
 *     Lalande 21185       8.307 ly   V  7.49
 *     Gl 244B (Sirius B)  8.601 ly   V  8.44
 *
 * ⇒ The promotable set is the UNION. This module builds it once and hands both pools
 * one flat array to rank over.
 *
 * ── WHY ONE MODULE OWNS ALL THREE CROSS-WALK JOBS ───────────────────────────
 * Reconciling the 46.8 AU radial disagreement between the files, building the row→name
 * map, and deciding which nearby stars need their own candidate all need the SAME
 * `findStarFieldIndexForStar` pass. Three callers of one expensive, subtle match is
 * three places for it to be called with different tolerances — which is exactly how
 * the suppression failed twice. One owner, one pass, one set of results.
 *
 * ⚠ ORDER MATTERS AND IT IS ENFORCED HERE: the reconcile PATCHES sprite positions, and
 * candidates built from visual rows read those positions. Building candidates first
 * would bake in the pre-reconcile values and reintroduce the 46.8 AU split for exactly
 * the 31 stars the reconcile exists to fix.
 */

import {
  findStarFieldIndexForStar,
  getStarRowPhysics,
  reconcileStarFieldPositions,
} from "@/components/Stars/StarField";
import { starParamsUsable } from "@/components/space/starPhysics";
import { getNearbyStars } from "@/sim/nearbyStars";

/** Elements per candidate. */
export const CANDIDATE_STRIDE = 8;

/**
 * One flat array of everything that can be promoted.
 *
 * Layout per candidate, `CANDIDATE_STRIDE` floats:
 *
 *     0..2  position in LIGHT-YEARS, game frame, origin at Sol
 *     3     radiusKm
 *     4     visual luminosity, solar units
 *     5     T_eff, K
 *     6     sprite row in stars_visual.bin, or −1 for a star with no sprite
 *     7     apparent V magnitude as seen from Sol
 *
 * 🔑 A typed array rather than objects: both pools scan every candidate on a
 * selection, and 8,849 objects per scan is exactly the allocation pattern this repo
 * forbids in a frame path. `names` is parallel and only read when a slot changes.
 *
 * ⚠⚠ **Float64Array, AND THE FIRST VERSION USED Float32Array, WHICH SHIPPED A BUG.**
 * A position stored in light-years quantises brutally at close range: f32's ulp at
 * 4.2267 ly is 4.768e-7 ly, so a HALF-ulp is **2.256e6 km** — and the author
 * photographed Proxima Centauri from 1,495,979 km, i.e. **1.51× closer than the
 * quantisation step of its own stored position.** The marker (built from the nearby
 * catalogue's f64 numbers) and the disc (built from this array) disagreed by tens of
 * degrees; the report was *"Proxima sits in the top right of the image while its
 * marker is in the centre"*, and warping to 1 AU of a star put it off-frame.
 *
 * 🔑 The defect is INCONSISTENCY, not precision. A star whose position is quantised
 * is simply at a slightly different place than the catalogue says, and nothing breaks
 * as long as the marker, the disc, the light, the collider and the warp target all
 * agree. The numerics review had flagged exactly this ("uCamPosLy's own f32 ulp
 * quantizes it into visible steps on close approach") and I had argued it was covered
 * because `Star` works in f64 on the CPU — then stored the CPU's own input in f32.
 */
export type StarCandidates = {
  count: number;
  data: Float64Array;
  stride: number;
  /** Display name per candidate; "" when the star has none. */
  names: string[];
  /** How many came from each source, for `__lum.starRows()`. */
  fromVisual: number;
  fromNearby: number;
  /** Stable marker id per candidate — the nearby id when it has one. */
  ids: string[];
};

let _cache: StarCandidates | null = null;
let _builtFromRows: Float32Array | null = null;

/**
 * The promotable set, built on the first call after BOTH catalogues have loaded.
 * Returns null until then — callers must tolerate that (the nearby list is a fetch).
 */
export function getStarCandidates(): StarCandidates | null {
  const phys = getStarRowPhysics();
  if (!phys) return null;
  const nearby = getNearbyStars();
  if (nearby.length === 0) return null;
  // Rebuild if the catalogue itself was replaced (hot reload); otherwise cache.
  if (_cache && _builtFromRows === phys.rows) return _cache;

  // ── 1. One position per star, before anything reads a position ────────────
  reconcileStarFieldPositions(nearby);

  // ── 2. The cross-walk, run ONCE ──────────────────────────────────────────
  const rowOf = new Map<string, number>();
  const nameOfRow = new Map<number, string>();
  const idOfRow = new Map<number, string>();
  for (const s of nearby) {
    const row = findStarFieldIndexForStar(s.dirGame, s.distLy);
    rowOf.set(s.id, row);
    if (row >= 0) {
      nameOfRow.set(row, s.name);
      idOfRow.set(row, s.id);
    }
  }

  // ── 3. Every usable visual row ───────────────────────────────────────────
  // ⚠ Positions come from the NEARBY catalogue's f64 numbers when the star has a
  // counterpart there, and only fall back to the f32 GPU row otherwise. Reading the
  // row would round the reconcile's own f64 input back to f32 and put the disc up to
  // a half-ulp away from the marker built from the same source — see the type's note.
  const f64Pos = new Map<number, readonly [number, number, number]>();
  for (const s of nearby) {
    const row = rowOf.get(s.id) ?? -1;
    if (row >= 0) {
      f64Pos.set(row, [
        s.dirGame[0] * s.distLy,
        s.dirGame[1] * s.distLy,
        s.dirGame[2] * s.distLy,
      ]);
    }
  }
  const { count, rows, rowStride, params, paramStride } = phys;
  const out: number[] = [];
  const names: string[] = [];
  // ⚠ Stable ids, because the marker-discovery registry persists them. A star with a
  // nearby-catalogue entry keeps ITS id so saves survive; the rest get `hyg-<row>`.
  const ids: string[] = [];
  let fromVisual = 0;
  for (let i = 0; i < count; i++) {
    const p = i * paramStride;
    if (params[p + 3] < 0.5) continue;
    const o = i * rowStride;
    const exact = f64Pos.get(i);
    out.push(
      exact ? exact[0] : rows[o],
      exact ? exact[1] : rows[o + 1],
      exact ? exact[2] : rows[o + 2],
      params[p],
      params[p + 1],
      params[p + 2],
      i,
      // magV from the stored illuminance — the one authority on brightness.
      -2.5 * Math.log10(Math.max(rows[o + 3], 1e-30) / MAG0_ILLUM_GAME),
    );
    names.push(nameOfRow.get(i) ?? "");
    ids.push(idOfRow.get(i) ?? `hyg-${i}`);
    fromVisual++;
  }

  // ── 4. Every nearby star that has NO sprite row ──────────────────────────
  // ⚠ `spriteRow = −1` is CORRECT here, not a failed lookup: these stars are fainter
  // than the sprite catalogue's V ≤ 6.5 limit, so there is nothing to suppress. Any
  // diagnostic that treats −1 as a double-draw has to check `magV` first.
  let fromNearby = 0;
  for (const s of nearby) {
    if ((rowOf.get(s.id) ?? -1) >= 0) continue;
    if (!starParamsUsable(s.params.radiusKm, s.distLy)) continue;
    out.push(
      s.dirGame[0] * s.distLy,
      s.dirGame[1] * s.distLy,
      s.dirGame[2] * s.distLy,
      s.params.radiusKm,
      s.params.visualLumSun,
      s.params.tempK,
      -1,
      s.magV,
    );
    names.push(s.name);
    ids.push(s.id);
    fromNearby++;
  }

  _cache = {
    count: names.length,
    data: new Float64Array(out),
    stride: CANDIDATE_STRIDE,
    names,
    ids,
    fromVisual,
    fromNearby,
  };
  _builtFromRows = rows;
  console.log(
    `[stars] ${_cache.count} promotable candidates: ${fromVisual} from the visual ` +
      `catalogue + ${fromNearby} nearby stars with no sprite ` +
      `(named: ${names.filter((n) => n).length})`,
  );
  return _cache;
}

/**
 * Illuminance of a magnitude-0 star in game units — for inverting the stored
 * illuminance back to a magnitude.
 *
 * ⚠ Stated as the ONE product `LUX_AT_MAG_0 / NITS_PER_GAME_UNIT`, matching
 * `starIlluminanceGame(0)`. A second literal zero point is how a validated
 * conversion drifts out of validation.
 */
const MAG0_ILLUM_GAME = 2.54e-6 / (128000 / 21.2);

export function starCandidatesStatus(): {
  built: boolean;
  count: number;
  fromVisual: number;
  fromNearby: number;
  named: number;
} {
  return {
    built: _cache !== null,
    count: _cache?.count ?? 0,
    fromVisual: _cache?.fromVisual ?? 0,
    fromNearby: _cache?.fromNearby ?? 0,
    named: _cache ? _cache.names.filter((n) => n).length : 0,
  };
}

/** One entry of the nearest-N selection, ready to become a POI marker. */
export type NearestCandidate = {
  candidate: number;
  id: string;
  name: string;
  positionKm: [number, number, number];
  radiusKm: number;
  distKm: number;
};

/**
 * The `n` candidates nearest the ship, nearest first.
 *
 * 🔑 NEAREST-TO-THE-SHIP, NOT WITHIN-A-RADIUS-OF-SOL, and that distinction is the
 * whole point. The marker filter used to be `distLy > STAR_MARKER_MAX_LY`, where
 * `distLy` is the catalogue distance **from Sol** — so it silently became wrong the
 * moment the player left the system, exactly the defect R7f fixed for the sky. A
 * nearest-N rule has no origin baked into it at all.
 *
 * It is also the better rule on its own merits:
 *  • **constant HUD density.** A fixed radius holds ~12 stars near Sol and could hold
 *    40 in a dense region or 3 in a sparse one; N is what a UI budget actually wants,
 *    and it can never leave the player with zero markers to navigate by.
 *  • **same cost.** One pass either way, and both ride the movement gate. An n-element
 *    insertion is cheaper than building a variable-length array.
 *  • **nothing to tune per region.** A radius needs a judgement call that will feel
 *    wrong somewhere; N does not.
 *
 * `maxDistKm` remains as a SAFETY cap, so an empty direction cannot produce an arrow
 * to something 300 ly away. With 8,848 candidates it essentially never binds.
 *
 * ⚠ Allocates its result — called once per re-selection (every ~2,673 AU in the solar
 * system), never per frame.
 */
export function nearestStarCandidates(
  x: number,
  y: number,
  z: number,
  n: number,
  maxDistKm: number,
  lyToKm: number,
): NearestCandidate[] {
  const c = getStarCandidates();
  if (!c) return [];
  const { count, data, stride, names, ids } = c;
  const best: Array<{ i: number; d: number }> = [];
  for (let i = 0; i < count; i++) {
    const o = i * stride;
    const dx = data[o] * lyToKm - x;
    const dy = data[o + 1] * lyToKm - y;
    const dz = data[o + 2] * lyToKm - z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > maxDistKm) continue;
    if (best.length < n) {
      best.push({ i, d });
      best.sort((a, b) => a.d - b.d);
    } else if (d < best[n - 1].d) {
      best[n - 1] = { i, d };
      best.sort((a, b) => a.d - b.d);
    }
  }
  return best.map(({ i, d }) => {
    const o = i * stride;
    const spriteRow = data[o + 6];
    return {
      candidate: i,
      id: ids[i],
      name:
        names[i] || (spriteRow >= 0 ? `HYG ${spriteRow}` : `star ${i}`),
      positionKm: [
        data[o] * lyToKm,
        data[o + 1] * lyToKm,
        data[o + 2] * lyToKm,
      ] as [number, number, number],
      radiusKm: data[o + 3],
      distKm: d,
    };
  });
}
