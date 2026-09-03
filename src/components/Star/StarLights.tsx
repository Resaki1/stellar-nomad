"use client";

import { memo, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import {
  NITS_PER_GAME_UNIT,
  blackbodyLinearSrgb,
  getPreExposure,
} from "@/components/space/photometry";
import { illuminanceGameAt } from "@/components/space/starPhysics";
import {
  setStarLightExcludedRows,
  setStarLightPool,
  type StarLightSlot,
} from "@/components/space/starLodStatus";
import {
  makeTierGate,
  tierNeedsReselect,
  tierSelected,
} from "@/components/space/starTierGate";
import { setStarTierGateStat } from "@/components/space/starLodStatus";
import { getStarCandidates } from "@/components/space/starCandidates";
import { LY_IN_KM } from "@/sim/units";
import { useWorldOrigin } from "@/sim/worldOrigin";

/**
 * R7e — CATALOGUE STARS AS LIGHTS on the local scene (ship, asteroids).
 *
 * See [`docs/STAR_RENDERING_PLAN.md`](../../../docs/STAR_RENDERING_PLAN.md) §17.
 *
 * Before this, arriving at α Centauri left the hull lit by the SKY: `SunLight` is
 * driven by the system's primary, and Sol at 4.3 ly delivers 2.8e-10 game units —
 * correctly nothing. You could see a limb-darkened disc filling the sky in front of
 * you and cast no shadow from it. That was the most glaring single-frame defect left
 * after R7f.
 *
 * ── 🔑 WHY THIS IS A SEPARATE POOL FROM THE DISC POOL ────────────────────────
 * §13.1's table already says it: the tiers answer different questions.
 *
 *     disc  ← angular size 2R/d over a pixel threshold
 *     light ← ILLUMINANCE at the ship over a threshold
 *
 * A star can matter as a light while being sub-pixel as a disc (a hot, distant
 * companion), and can matter as a disc while contributing nothing as a light (a huge
 * cool giant seen from far away). Coupling them would make one of those wrong, so
 * each tier runs its own selector over the same catalogue.
 *
 * ── ⚠⚠ THE DOUBLE-COUNT THIS HAS TO AVOID ───────────────────────────────────
 * All 8,920 catalogue stars are ALREADY a light: they are summed into the SH-L2 sky
 * probe (`skyIrradiance`), which `CelestialBody` renders from and which the hull
 * picks up through the environment cube. So promoting a star to a directional light
 * without removing it from that sum counts its flux twice.
 *
 * At Sol the error is negligible — α Cen A is 4.3e-10 game units against the sky's
 * 2.1e-7, i.e. 0.2% — which is exactly why it would have gone unnoticed. Near the
 * star it is severe, and not merely doubled: SH-L2 is a 9-coefficient low-pass, so a
 * dominant point source in it delivers 17/16 at the source and **1/16 at the
 * antipode** with negative ringing between. That is a sun with no terminator.
 *
 * ⇒ Any star this pool holds is excluded from `rebakeCatalogueShFor`. Same rule the
 * sprite field already follows for the disc pool: **a star rendered by an explicit
 * tier is removed from the diffuse aggregate.**
 *
 * ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
 * ⚠ No eclipse test. `sunVisibility` is built on the primary's radius and the
 * registered occluder set, and a promoted star has no planets yet, so there is
 * nothing to be eclipsed BY. It also gets no refracted-limb term and no atmospheric
 * transmittance — both are single-dominant-body concepts that belong to `SunLight`.
 * ⚠ A planet's SKY is still lit by one star (R7g).
 */

/**
 * Light slots. Fixed for the scene's lifetime, so promoting a star is a set of
 * uniform writes and never a material rebuild (§13.1).
 *
 * 4 covers a hierarchical triple plus one, which is as deep as real systems within
 * 10 pc go (α Cen A/B + Proxima is the motivating case).
 */
const SLOTS = 4;

/**
 * Illuminance a star must deliver to the ship, in game units, before it is worth a
 * light of its own.
 *
 * 🔑 DERIVED, not authored: it is the whole sky's flux, `4π · SKY_TARGET_NITS`
 * = 1.257e-3 lux = 2.08e-7 game units. Below that a star is dimmer than everything
 * else in the sky put together, so a directional light adds nothing the SH probe is
 * not already delivering — and the SH is where it already lives.
 *
 * ⚠ A FIXED derivation rather than a live read of the SH's own band-0 irradiance,
 * deliberately: the pool is EXCLUDED from that sum, so thresholding on it would
 * close a loop (crossing the threshold lowers the thing the threshold is compared
 * against). In practice a star either dominates the sky by orders of magnitude or is
 * negligible, so the loop would rarely bite — which is the worst kind of loop.
 */
const SKY_TOTAL_FLUX_GAME = (4 * Math.PI * 1e-4) / NITS_PER_GAME_UNIT;

/** Hysteresis band: take a slot at 2×, give it up at 0.5×. */
const ENTER = SKY_TOTAL_FLUX_GAME * 2;
const EXIT = SKY_TOTAL_FLUX_GAME * 0.5;

/**
 * Bounce/zodiacal fill as a fraction of a star's illuminance — the same 1/60
 * `SunLight` uses, which preserves the shipped 60:1 key:fill ratio. Duplicated as a
 * named constant rather than imported so this component does not depend on
 * `SunLight`'s module; if one changes, `__lum.starLights()` prints both.
 */
const BOUNCE_FILL_FRACTION = 1 / 60;

/** Blackbody hue per star, memoised — the CMF integral is ~80 Planck evaluations. */
const _hues = new Map<number, THREE.Color>();

function hueFor(row: number, tempK: number): THREE.Color {
  let c = _hues.get(row);
  if (!c) {
    const [r, g, b] = blackbodyLinearSrgb(tempK);
    c = new THREE.Color(r, g, b);
    _hues.set(row, c);
  }
  return c;
}

/** What a light slot holds, resolved from a catalogue row. */
type LitStar = {
  candidate: number;
  spriteRow: number;
  name: string;
  posKmX: number;
  posKmY: number;
  posKmZ: number;
  lumSun: number;
  tempK: number;
};

function StarLights() {
  const worldOrigin = useWorldOrigin();
  const lightRefs = useRef<Array<THREE.DirectionalLight | null>>(
    Array.from({ length: SLOTS }, () => null),
  );
  const fillRef = useRef<THREE.AmbientLight>(null!);
  /** Which star each slot holds. Mutated per frame; never React state. */
  const held = useRef<Array<LitStar | null>>(
    Array.from({ length: SLOTS }, () => null),
  );
  /** Scratch, allocated once and mutated — useFrame must not allocate. */
  const scratch = useRef<Array<{ row: number; illum: number }>>([]);
  const published = useRef<StarLightSlot[]>(
    Array.from({ length: SLOTS }, () => ({
      id: "",
      name: "",
      spriteRow: -1,
      illumGame: 0,
      distLy: 0,
      tempK: 0,
    })),
  );
  const publishedView = useRef<StarLightSlot[]>([]);
  const excluded = useRef<number[]>([]);
  /** Movement gate — see space/starTierGate.ts. */
  const gate = useRef(makeTierGate());

  useFrame(() => {
    // The UNION of both catalogues (§20) — the visual catalogue alone omits every
    // star fainter than V 6.5, i.e. Proxima and 134 other nearby stars.
    const cand = getStarCandidates();
    const lights = lightRefs.current;
    if (!cand) return;
    const sx = worldOrigin.shipPosKm.x;
    const sy = worldOrigin.shipPosKm.y;
    const sz = worldOrigin.shipPosKm.z;
    const preExp = getPreExposure();
    const { count, data, stride } = cand;

    // ── 1. SELECTION — behind the movement gate ──────────────────────────────
    // ⚠ Gated because the ANSWER changes on the scale of hours, not frames: in the
    // solar system the ship must cross 2,673 AU before a re-rank could differ. See
    // space/starTierGate.ts for the derivation.
    if (tierNeedsReselect(gate.current, sx, sy, sz)) {
      const ranked = scratch.current;
      while (ranked.length < count) ranked.push({ row: -1, illum: 0 });
      let n = 0;
      let nearestKm = Infinity;
      for (let i = 0; i < count; i++) {
        const o = i * stride;
        const dx = data[o] * LY_IN_KM - sx;
        const dy = data[o + 1] * LY_IN_KM - sy;
        const dz = data[o + 2] * LY_IN_KM - sz;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        if (d < nearestKm) nearestKm = d;
        const illum = illuminanceGameAt(data[o + 4], d);
        // ⚠ Hysteresis on the star's own MEMBERSHIP, not on a rank: a star already
        // holding a slot keeps it down to EXIT, a newcomer needs ENTER. Ranking with
        // a margin instead would let two stars either side of the band swap places
        // on every re-selection, and each swap is a light-direction discontinuity.
        const isHeld = held.current.some((h) => h?.candidate === i);
        if (illum >= (isHeld ? EXIT : ENTER)) {
          ranked[n].row = i;
          ranked[n].illum = illum;
          n++;
        }
      }
      // Sort only the qualifying prefix — n is 0 anywhere in the solar system.
      const head = ranked.slice(0, n).sort((a, b) => b.illum - a.illum);
      for (let i = 0; i < SLOTS; i++) {
        const pick = head[i];
        if (!pick) {
          held.current[i] = null;
          continue;
        }
        const o = pick.row * stride;
        held.current[i] = {
          candidate: pick.row,
          spriteRow: data[o + 6],
          name: cand.names[pick.row] || `star ${pick.row}`,
          posKmX: data[o] * LY_IN_KM,
          posKmY: data[o + 1] * LY_IN_KM,
          posKmZ: data[o + 2] * LY_IN_KM,
          lumSun: data[o + 4],
          tempK: data[o + 5],
        };
      }
      tierSelected(gate.current, sx, sy, sz, nearestKm);
      setStarTierGateStat(
        "light",
        gate.current.runs,
        gate.current.skipped,
        Math.sqrt(gate.current.budgetSq),
      );

      // ── The SH exclusion (see the header's double-count note) ──────────────
      // 🔑 Trivial now that the pool selects from the sprite catalogue itself: the
      // row index IS the identity, so there is no cross-file match to get wrong.
      // ⚠ Only stars that HAVE a sprite row contribute to the SH sum, so only those
      // need excluding. A nearby star fainter than V 6.5 was never in the catalogue
      // SH to begin with, and `setStarLightExcludedRows` drops the −1s.
      const ex = excluded.current;
      ex.length = 0;
      for (const h of held.current) if (h) ex.push(h.spriteRow);
      setStarLightExcludedRows(ex);
    }

    // ── 2. PER-FRAME WRITES — never gated ────────────────────────────────────
    // A held star's direction and illuminance change continuously as the ship
    // moves, so these must track every frame. O(SLOTS), allocation-free. Gating
    // them too would freeze a light at the pose it was selected from.
    let totalIllum = 0;
    const view = publishedView.current;
    view.length = 0;
    for (let i = 0; i < SLOTS; i++) {
      const light = lights[i];
      const s = held.current[i];
      if (!light) continue;
      if (!s) {
        light.intensity = 0;
        light.visible = false;
        continue;
      }
      const dx = s.posKmX - sx;
      const dy = s.posKmY - sy;
      const dz = s.posKmZ - sz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const illum = illuminanceGameAt(s.lumSun, d);
      // `DirectionalLight.position` is read as a DIRECTION, and relative to the
      // ship so it stays correct under origin rebasing — the same convention
      // SunLight uses, deliberately, so a hull lit by both cannot disagree about
      // handedness.
      light.position.set(dx / d, dy / d, dz / d);
      light.color.copy(hueFor(s.candidate, s.tempK));
      // × preExposure (D25), exactly as SunLight's key light does. three's
      // irradiance is linear in `intensity`, so this is the whole local scene.
      light.intensity = illum * preExp;
      light.visible = true;
      totalIllum += illum;
      const p = published.current[i];
      p.id = `cand-${s.candidate}`;
      p.name = s.name;
      p.spriteRow = s.spriteRow;
      p.illumGame = illum;
      p.distLy = d / LY_IN_KM;
      p.tempK = s.tempK;
      view.push(p);
    }
    // The bounce fill scales with the light that produces it — see SunLight's note
    // on why a distance-independent ambient was untenable once the key light became
    // 1/r². Summed over the pool because two suns bounce off the hull twice.
    if (fillRef.current) {
      fillRef.current.intensity = totalIllum * preExp * BOUNCE_FILL_FRACTION;
    }
    setStarLightPool(view);
  });

  const slots = useMemo(() => Array.from({ length: SLOTS }, (_, i) => i), []);

  return (
    <>
      {slots.map((i) => (
        <directionalLight
          key={i}
          ref={(l) => {
            lightRefs.current[i] = l;
          }}
          intensity={0}
          visible={false}
        />
      ))}
      <ambientLight ref={fillRef} intensity={0} />
    </>
  );
}

export default memo(StarLights);
