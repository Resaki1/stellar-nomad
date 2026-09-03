"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";

import Star from "./Star";
import {
  setStarFieldSkipIndices,
  STAR_FIELD_SKIP_SLOTS,
} from "@/components/Stars/StarField";
import { getStarCandidates } from "@/components/space/starCandidates";
import {
  getNearbyStars,
  loadNearbyStars,
  type NearbyStar,
} from "@/sim/nearbyStars";
import {
  setStarDiscPool,
  setStarTierGateStat,
} from "@/components/space/starLodStatus";
import {
  makeTierGate,
  tierNeedsReselect,
  tierSelected,
} from "@/components/space/starTierGate";
import { LY_IN_KM } from "@/sim/units";
import { useWorldOrigin } from "@/sim/worldOrigin";

/**
 * THE DISC POOL — promotes catalogue stars to the full `<Star>` renderer.
 *
 * See [`docs/STAR_RENDERING_PLAN.md`](../../../docs/STAR_RENDERING_PLAN.md) §12, §19.
 *
 * 🔑 THIS IS A MOUNTING PROBLEM, NOT A PHYSICS ONE, and that is R2's doing: the
 * sprite tier and the disc tier were proven photometrically continuous to
 * **1.6e-16 stops**, so whichever renders a given star, the flux is the same. All
 * that is left is choosing which, and not drawing both.
 *
 * ── ⚠⚠ §19: IT SELECTS OVER THE WHOLE VISUAL CATALOGUE, NOT THE NEARBY LIST ──
 * It used to rank the 166 rows of `stars_nearby.json`, which meant **8,754 of the
 * 8,920 rendered stars could never become a disc, a light or a collider**. The
 * author flew to one: *"I picked a star that seemed relatively near… It kept getting
 * bigger, but only to a certain point. It did not seem to become a real sphere."*
 *
 * Nothing new was needed to fix it. `absMagV` follows from `magV` and the distance,
 * both already in `stars_visual.bin`, so `StarField` now derives radius, visual
 * luminosity and T_eff for every row at parse time and this ranks over all of them.
 *
 * ⚠ 206 rows are still not promotable, and correctly: they sit at HYG's 326,156 ly
 * "parallax unknown" sentinel, where every derived quantity is meaningless.
 * `starParamsUsable` is the gate; **8,714 of 8,920 (97.7%)** pass it.
 *
 * ⚠⚠ §20: IT RANKS THE **UNION** OF BOTH CATALOGUES, not the visual one. Ranking the
 * visual catalogue alone traded one blind spot for its mirror — the author flew to
 * Proxima Centauri and it never appeared, because at V 11.01 it has no sprite row.
 * Only 31 of 166 nearby stars do. `space/starCandidates.ts` owns the union.
 *
 * ── IDENTITY IS THE ROW INDEX, WHICH DELETED A WHOLE CLASS OF BUG ────────────
 * 🔑 Selecting from the same catalogue the sprites come from means the pool's
 * identity IS the sprite's index — so suppression needs no cross-file match at all.
 * `findStarFieldIndexForStar` survives only to attach NAMES (and only the 166 nearby
 * rows have one). The suppression had failed silently twice, both times in that
 * cross-walk; now it cannot.
 *
 * ── WHICH STARS ─────────────────────────────────────────────────────────────
 * The largest **angular radius** `R/d`, not the nearest. Angular size is what decides
 * whether a disc is the better model than a point, and it breaks the α Centauri tie
 * decisively — A and B sit at the *same* 4.32 ly, so a nearest-first rule would flap.
 *
 * ⚠ Mounting and unmounting a `<Star>` rebuilds its NodeMaterial and WebGPU
 * shader-compilation stutter is a documented problem here, so the slots stay mounted
 * for the scene's lifetime and only their CONTENTS change (§13.1). One swap per
 * selection, behind `SWAP_MARGIN`, so it converges without oscillating.
 */

/** A challenger must be this much larger in angular diameter to take a slot. */
const SWAP_MARGIN = 1.05;

/** Disc slots. Must not exceed the sprite field's suppression slots. */
const POOL = Math.min(2, STAR_FIELD_SKIP_SLOTS);

/** What a slot holds — everything `<Star>` needs, resolved from a catalogue row. */
export type PromotedStar = {
  /** Index into the candidate list — the pool's identity. */
  candidate: number;
  /** Stable id, shared with the POI marker and the discovery registry. */
  id: string;
  /**
   * Sprite row to suppress, or −1 when the star has no sprite at all.
   *
   * ⚠ −1 is LEGITIMATE for any star fainter than the sprite catalogue's V ≤ 6.5
   * limit — Proxima, Barnard's, Wolf 359. Only a star with `magV ≤ 6.5` and a −1 here
   * is the double-draw the diagnostics hunt for.
   */
  spriteRow: number;
  name: string;
  positionKm: [number, number, number];
  radiusKm: number;
  tempK: number;
  luminositySun: number;
  distLy: number;
  magV: number;
};

type Slot = { row: number; solid: number };

function NearbyStarDisc() {
  const worldOrigin = useWorldOrigin();
  const [nearby, setNearby] = useState<readonly NearbyStar[]>(getNearbyStars());
  const [targets, setTargets] = useState<readonly (PromotedStar | null)[]>(
    Array.from({ length: POOL }, () => null),
  );
  const poolRef = useRef<Slot[]>(
    Array.from({ length: POOL }, () => ({ row: -1, solid: 0 })),
  );
  /** Scratch, allocated once to the catalogue's length and mutated. */
  const scratch = useRef<Slot[]>([]);
  const gate = useRef(makeTierGate());

  useEffect(() => {
    if (nearby.length > 0) return;
    let alive = true;
    void loadNearbyStars().then((s) => {
      if (alive) setNearby(s);
    });
    return () => {
      alive = false;
    };
  }, [nearby.length]);

  useFrame(() => {
    // The UNION of both catalogues — built once, after the nearby fetch lands.
    const cand = getStarCandidates();
    if (!cand) return;

    const sx = worldOrigin.shipPosKm.x;
    const sy = worldOrigin.shipPosKm.y;
    const sz = worldOrigin.shipPosKm.z;
    // ⚠ SELECTION ONLY runs behind the gate. `Star` computes its own geometry from
    // `positionKm` every frame, so a held slot still tracks the ship continuously.
    if (!tierNeedsReselect(gate.current, sx, sy, sz)) return;

    const { count, data, stride } = cand;
    const ranked = scratch.current;
    while (ranked.length < count) ranked.push({ row: -1, solid: 0 });
    let nearestKm = Infinity;
    for (let i = 0; i < count; i++) {
      const o = i * stride;
      const dx = data[o] * LY_IN_KM - sx;
      const dy = data[o + 1] * LY_IN_KM - sy;
      const dz = data[o + 2] * LY_IN_KM - sz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      if (d < nearestKm) nearestKm = d;
      ranked[i].row = i;
      ranked[i].solid = data[o + 3] / d;
    }
    const head = ranked.slice(0, count).sort((a, b) => b.solid - a.solid);
    tierSelected(gate.current, sx, sy, sz, nearestKm);
    setStarTierGateStat(
      "disc",
      gate.current.runs,
      gate.current.skipped,
      Math.sqrt(gate.current.budgetSq),
    );

    const pool = poolRef.current;
    // 🐛 Hysteresis compares against the incumbent's angular size RIGHT NOW. An
    // earlier version compared against the value the incumbent had WHEN IT WON,
    // which is stale the moment you move: after warping to Sirius, nothing could
    // ever beat the recorded value again and the promotion stuck on Sirius for
    // ever. That was the reported "some stars only show up if I warp to 1e-4 AU"
    // and its mirror "once loaded it stays visible when I warp away".
    const liveSolid = (row: number): number =>
      row < 0 ? 0 : head.find((r) => r.row === row)?.solid ?? 0;
    for (let i = 0; i < POOL; i++) pool[i].solid = liveSolid(pool[i].row);

    // Commit at most ONE swap: the best challenger not already in the pool takes the
    // weakest slot, and only if it beats it by the margin. One at a time converges in
    // a few selections and cannot oscillate between two orderings.
    let changed = false;
    const isHeld = (row: number) => pool.some((p) => p.row === row);
    const emptySlot = pool.findIndex((p) => p.row < 0 || p.solid === 0);
    const challenger = head.find((r) => !isHeld(r.row));
    if (challenger) {
      if (emptySlot >= 0) {
        pool[emptySlot] = { row: challenger.row, solid: challenger.solid };
        changed = true;
      } else {
        let weakest = 0;
        for (let i = 1; i < POOL; i++) {
          if (pool[i].solid < pool[weakest].solid) weakest = i;
        }
        if (challenger.solid > pool[weakest].solid * SWAP_MARGIN) {
          pool[weakest] = { row: challenger.row, solid: challenger.solid };
          changed = true;
        }
      }
    }
    if (!changed) return;

    const next: (PromotedStar | null)[] = pool.map((p) => {
      if (p.row < 0) return null;
      const o = p.row * stride;
      const distLy = Math.sqrt(
        data[o] * data[o] + data[o + 1] * data[o + 1] + data[o + 2] * data[o + 2],
      );
      const spriteRow = data[o + 6];
      return {
        candidate: p.row,
        spriteRow,
        id: cand.ids[p.row],
        name:
          cand.names[p.row] ||
          (spriteRow >= 0 ? `HYG ${spriteRow}` : `star ${p.row}`),
        positionKm: [
          data[o] * LY_IN_KM,
          data[o + 1] * LY_IN_KM,
          data[o + 2] * LY_IN_KM,
        ],
        radiusKm: data[o + 3],
        luminositySun: data[o + 4],
        tempK: data[o + 5],
        distLy,
        magV: data[o + 7],
      };
    });
    setTargets((prev) =>
      prev.length === next.length &&
      prev.every((t, i) => t?.candidate === next[i]?.candidate)
        ? prev
        : next,
    );
  });

  // Stable tuple identities, so each `Star`'s memos do not rebuild every render.
  const positions = useMemo(
    () => targets.map((t) => (t ? t.positionKm : null)),
    [targets],
  );

  // ── Suppress the promoted sprites, BY ROW INDEX ────────────────────────────
  // 🔑 The pool now selects from the sprite catalogue itself, so the index is the
  // identity and there is nothing to match. The direction test this replaced could
  // not fire at all (`Math.cos(1e-4)` rounds to exactly 1.0f against a strict `>`)
  // and the position match that replaced THAT used a tolerance 100× too tight — both
  // left the promoted star drawn twice, at 2× flux. Neither failure is reachable now.
  useEffect(() => {
    setStarFieldSkipIndices(targets.map((t) => t?.spriteRow ?? -1));
    setStarDiscPool(
      targets.flatMap((t, i) =>
        t
          ? [
              {
                id: t.id,
                name: t.name,
                solid: poolRef.current[i]?.solid ?? 0,
                distLy: t.distLy,
                spriteRow: t.spriteRow,
                magV: t.magV,
                positionKm: t.positionKm,
                radiusKm: t.radiusKm,
              },
            ]
          : [],
      ),
    );
    return () => setStarFieldSkipIndices([]);
  }, [targets]);

  return (
    <>
      {targets.map((t, i) =>
        t && positions[i] ? (
          <Star
            key={i}
            // ⚠ `primary={false}`: `starLodStatus` and the R3b point-glare uniform
            // each hold ONE star and the primary owns them, or the last component to
            // run a frame would win and `__lum.starGlare()` would report whichever.
            primary={false}
            positionKm={positions[i]!}
            radiusKm={t.radiusKm}
            tempK={t.tempK}
            luminositySun={t.luminositySun}
            // The global display lift, read INSIDE Star's useFrame because it tracks
            // adaptation and this component re-renders only when a slot changes;
            // passing a number froze it at selection time and the promoted star
            // became the one star in the sky that never brightened.
            applyDisplayLift
          />
        ) : null,
      )}
    </>
  );
}

export default memo(NearbyStarDisc);
