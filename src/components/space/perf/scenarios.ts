/**
 * Benchmark scenarios — fixed, reproducible camera placements.
 *
 * See `docs/PERF_MEASUREMENT.md`. Each scenario is a pose the harness can warp
 * to, measure, and warp away from, producing the same numbers every run.
 *
 * ── Why these particular altitudes ──────────────────────────────────────────
 * GPU cost on an Earth approach is dominated by *altitude gates* — module
 * constants that switch whole passes on as you descend. The eye-balled FPS
 * ladder (120 fps at 19,000 km from centre → 25 fps at the cloud deck) lines up
 * with them almost exactly, and crucially the volumetric cloud marcher is the
 * LAST thing to turn on, not the first. The ladder below straddles each gate
 * (just above / just below) so the per-pass table isolates what each one costs:
 *
 *   altitude   gate                                            source
 *   35,000 km  Earth `lod.near` tier mounts                     earth.ts lod.near
 *    4,000 km  aerial-perspective froxel bake (32³ compute)      SpaceRenderer FROXEL_BAKE_MAX_ALT_KM
 *    2,000 km  Beer Shadow Map (3 passes, 512²)                  cloudShadowMap BSM_MAX_ALT_KM
 *      700 km  volumetric cloud pipeline (marcher/recon/comp)    earth.ts VOLUMETRIC_BLEND_START_ALT_KM
 *      400 km  cloud light volume gains weight                   cloudLightVolume VOL_FADE_ALT_HI
 *      250 km  volumetric blend reaches 1.0                      earth.ts VOLUMETRIC_BLEND_FULL_ALT_KM
 *      180 km  Sky-View LUT bake                                 atmospherePass SKYVIEW_BAKE_MAX_ALT_KM
 *     1–16 km  inside the cloud band                             cloudShared CLOUD_INNER/OUTER_ALTITUDE_KM
 *
 * ── Determinism ─────────────────────────────────────────────────────────────
 * This works because sim time is FROZEN by default (`simRateAtom` = 0): body
 * positions come from the ephemeris at a fixed epoch, sun direction is pure
 * geometry, and `SHIP_MAX_SPEED_KMPS` is 0 so a warped ship does not drift. The
 * only moving parts are the temporal accumulators, which the runner waits out.
 *
 * Positions are derived, never hard-coded: `altitudeKm` above a body's LIVE
 * centre, along the approach direction, looking at that centre. Every resolver
 * reads `positionKm` at call time for that reason — do not hoist.
 *
 * ⚠⚠ THE APPROACH DIRECTION IS SUN-RELATIVE (`BENCH_PHASE_DEG`), NOT WORLD-FIXED,
 * and that changed on 2026-09-07 — see the comment on that constant for the
 * measurement that forced it. Consequence for anyone reading old numbers:
 * **every per-pass figure recorded before pose epoch v2 is void**, because the
 * v1 ladder ran at ~91° phase (half-lit, and epoch-dependent) while v2 runs at
 * 35° (91% lit). `BENCH_POSE_EPOCH` is on the report so a stale comparison is
 * visible rather than silent.
 * ⚠ Illumination is now epoch-independent; sub-camera LONGITUDE is not, since the
 * body spins under a sun-locked axis. Terrain and cloud cover beneath the camera
 * still vary across epochs. One axis cannot pin both, and illumination is the one
 * that governs GPU cost.
 */

import { Matrix4, Quaternion, Vector3 } from "three";
import { getNearbyStar } from "@/sim/nearbyStars";
import type { DevWarp } from "@/store/dev";
import { activeSystem } from "@/sim/systemRegistry";
import type { CelestialBodyDef } from "@/sim/systemTypes";

const bodies = activeSystem().celestialBodies as CelestialBodyDef[];

function body(id: string): CelestialBodyDef {
  const b = bodies.find((x) => x.id === id);
  if (!b) throw new Error(`[bench] body "${id}" not found in sol.json`);
  return b;
}

/**
 * ── POSE EPOCH: bump this whenever a resolver changes where the camera lands ──
 * Printed in the sweep header and stored on the report, because a baseline from a
 * different pose epoch is not comparable and nothing else in the numbers says so.
 *   v1 — world-fixed approach axis from `startingOffsetKm` (pre-2026-09-07)
 *   v2 — sun-relative approach axis at a fixed phase angle (below)
 */
export const BENCH_POSE_EPOCH = "v2-sun-relative";

/**
 * Phase angle of every body-relative benchmark pose, degrees: the angle AT THE BODY
 * between the camera and the star. 0 = camera at the sub-solar point (fully lit disc,
 * sun behind the camera), 90 = terminator edge-on, 180 = camera in the umbra.
 *
 * ⚠⚠ **THIS REPLACED A WORLD-FIXED AXIS, AND THE REASON IS THE WHOLE POINT.** v1 derived
 * the approach direction from `startingOffsetKm`, a constant authored in sol.json. That
 * is fixed in the SCENE frame while the sun direction is not, so the illumination of
 * every pose was an accident of `simEpochMsAtom`. MEASURED against the authored epoch it
 * came out at **phase 91.28°, 48.9% lit — 1.28° from the terminator**. Earth's
 * heliocentric longitude advances ~1°/day, so the ladder was one coin-flip wide: when the
 * real ephemeris (E0) landed, the whole sweep moved to the NIGHT side and every stored
 * per-pass number silently stopped being comparable. Restoring the old day side would
 * have re-armed the same trap 1.3° away.
 *
 * 🔑 Sun-relative makes illumination EPOCH-INDEPENDENT, which is strictly stronger than
 * what v1 had even before it broke: baselines now survive ephemeris changes.
 *
 * ⚠ What it does NOT fix, stated so nobody assumes it: the sub-camera LONGITUDE still
 * drifts with the epoch, because the body keeps spinning under a sun-locked axis. So the
 * terrain and cloud field beneath the camera still vary run to run at different epochs.
 * You cannot pin both with one axis. Illumination is the one that governs GPU cost and
 * the one that broke, so it is the one that is pinned.
 *
 * Why 35° and not 0°: the disc is **91.0% lit** (`(1+cos g)/2`), so lit-content work is
 * near its maximum, while the terminator is still inside the frame at orbital altitudes
 * — that band carries the longest optical paths in the atmosphere march. At surface
 * altitudes it puts the sun **55° above the horizon** (a normal daytime elevation)
 * instead of the degenerate overhead-noon case a 0° pose would measure.
 */
export const BENCH_PHASE_DEG = 35;

/**
 * Fallback approach axis for `bodyId: null` scenarios that also have no look target.
 * Kept world-fixed on purpose: with no body there is no sun-relative frame to speak of.
 */
const ABSOLUTE_FALLBACK_DIR = (() => {
  const off = activeSystem().startingOffsetKm as [number, number, number] | undefined;
  return off
    ? new Vector3(off[0], off[1], off[2]).normalize()
    : new Vector3(0, 0, 1);
})();

const _sunDir = new Vector3();
const _lookUp = new Vector3();
const _sunLevel = new Vector3();
const _perp = new Vector3();
const _approach = new Vector3();
const _ecliptic = new Vector3(0, 1, 0);
const _fallbackPerp = new Vector3(0, 0, 1);

/**
 * Unit vector from `bodyId`'s centre to the camera, at `phaseDeg` from the sub-solar
 * direction. Reads LIVE positions — never hoist this to module scope, which is exactly
 * what v1 did.
 *
 * The offset is taken in the ecliptic plane (`up × sunDir`), so the camera lands at a
 * mid-latitude on the morning side rather than over a pole. Using the body's own spin
 * axis would be marginally more principled but would couple this file to the rotation
 * solver for a ~23° difference.
 *
 * ⚠ Returns a SHARED scratch vector — copy it before the next call.
 */
export function approachDirFor(bodyId: string, phaseDeg: number): Vector3 {
  const b = body(bodyId);
  const star = bodies[0]; // sol — index 0 by convention in sol.json
  _sunDir
    .set(
      star.positionKm[0] - b.positionKm[0],
      star.positionKm[1] - b.positionKm[1],
      star.positionKm[2] - b.positionKm[2],
    )
    .normalize();
  _perp.crossVectors(_ecliptic, _sunDir);
  // Degenerate only if the body sits on the ecliptic pole from the star, which no
  // body in sol.json does — but a procedural system could, and a zero-length axis
  // would silently collapse the pose onto the sub-solar point.
  if (_perp.lengthSq() < 1e-8) _perp.crossVectors(_fallbackPerp, _sunDir);
  _perp.normalize();
  const g = (phaseDeg * Math.PI) / 180;
  return _approach
    .copy(_sunDir)
    .multiplyScalar(Math.cos(g))
    .addScaledVector(_perp, Math.sin(g))
    .normalize();
}

export type Scenario = {
  /** Stable id used by `__bench.run(id)`. Never rename — baselines cite it. */
  id: string;
  /** One line on what this scenario is probing. */
  what: string;
  /** Body the pose is relative to, or `null` for a fixed absolute position. */
  bodyId: string | null;
  /** Altitude above that body's surface, km (ignored when `bodyId` is null). */
  altitudeKm?: number;
  /** Absolute position, km — only for `bodyId: null` scenarios. */
  positionKm?: [number, number, number];
  /** What to point at: a body id, or `null` to face along the approach axis. */
  lookAtBodyId?: string | null;
  /**
   * Where to point when the target is not a body centre. `"body"` (default) looks at
   * `lookAtBodyId`; `"up"` looks straight away from the body along the approach axis;
   * `"horizon"` looks level, toward the sun-ward horizon.
   *
   * ⚠⚠ EXISTS TO CLOSE A DOCUMENTED MEASUREMENT GAP, not for variety. Every other
   * scenario looks AT the planet, so sky pixels are a minority in all of them — which
   * systematically UNDER-measures the atmosphere march, whose cost lives in long sky
   * chords. docs/PERF_MEASUREMENT.md recorded this as an open gap when `USE_SKYVIEW`
   * was turned off ("judge quality by looking up from low altitude by hand").
   */
  lookMode?: "body" | "up" | "horizon";
  /**
   * Phase angle at the body, degrees; defaults to `BENCH_PHASE_DEG`. Only set it to
   * build a day/night DIFF PAIR — an absolute night-side number on its own says
   * nothing, the same way an absolute froxel number says nothing without its
   * straddle partner.
   */
  phaseDeg?: number;
};

/**
 * v1 scenario set: the Earth descent ladder plus two controls.
 *
 * Naming: `earth_<altitudeKm>`. The distances the user eye-balled were from
 * Earth's CENTRE; these are altitudes (centre distance − 6371 km), so e.g. the
 * "19,000 km" observation is `earth_12629`.
 */
export const SCENARIOS: readonly Scenario[] = [
  // ── Controls ──────────────────────────────────────────────────────────────
  {
    id: "deep_space",
    what: "Nothing in range — the fixed per-frame floor (post, skybox, stars)",
    bodyId: null,
    // Well outside every body's LOD range and every asteroid field's load
    // radius: +40M km on Y, where nothing exists in sol.json.
    positionKm: [0, 40_000_000, 0],
    lookAtBodyId: "earth",
  },
  {
    id: "belt",
    what: "Asteroid streaming active, no atmosphere — CPU-side chunk cost",
    bodyId: null,
    // The default spawn point, which sits inside the origin belt. ⚠ A REFERENCE
    // to the live array, not a copy: the spawn is anchored to Earth
    // (`startingBody`/`startingOffsetKm`), so this tracks the belt as Earth
    // orbits. Copying it here is what sent the belt warp to a 2024-epoch
    // position after the ephemeris landed.
    positionKm: activeSystem().startingPositionKm as [number, number, number],
    lookAtBodyId: "earth",
  },

  // ── Earth descent ladder ──────────────────────────────────────────────────
  {
    id: "earth_12629",
    what: "19,000 km from centre — the eye-balled 120 fps point",
    bodyId: "earth",
    altitudeKm: 12_629,
  },
  {
    id: "earth_6629",
    what: "13,000 km from centre — eye-balled <100 fps, still no cloud passes",
    bodyId: "earth",
    altitudeKm: 6_629,
  },
  {
    id: "earth_4100",
    what: "Just ABOVE the froxel-bake gate (4000 km)",
    bodyId: "earth",
    altitudeKm: 4_100,
  },
  {
    id: "earth_3900",
    what: "Just BELOW the froxel-bake gate — diff vs earth_4100 = froxel cost",
    bodyId: "earth",
    altitudeKm: 3_900,
  },
  {
    id: "earth_2100",
    what: "Just ABOVE the Beer-Shadow-Map gate (2000 km)",
    bodyId: "earth",
    altitudeKm: 2_100,
  },
  {
    id: "earth_1900",
    what: "Just BELOW the BSM gate — diff vs earth_2100 = shadow-map cost",
    bodyId: "earth",
    altitudeKm: 1_900,
  },
  {
    id: "earth_750",
    what: "Just ABOVE the volumetric-cloud gate (700 km)",
    bodyId: "earth",
    altitudeKm: 750,
  },
  {
    id: "earth_650",
    what: "Just BELOW it — diff vs earth_750 = the whole cloud pipeline",
    bodyId: "earth",
    altitudeKm: 650,
  },
  // ── Day/night diff pairs ────────────────────────────────────────────────
  // 🔑 These exist so "the day side is more taxing" stops being a belief. Same
  // altitude, same axis, phase flipped past the terminator — the diff against
  // their day partner IS the illumination cost, isolated the same way the
  // 4100/3900 pair isolates the froxel bake. Two altitudes because the answer can
  // differ: at 650 km the cloud pipeline is fully on and viewed from outside,
  // while inside the deck the marcher's own lit-path work dominates.
  // ⚠ 145°, not 180°: at 180° the camera is in the umbra and `earth_8` would sit
  // inside an eclipsed cloud deck, which is a different scenario, not a control.
  {
    id: "earth_650_night",
    what: "earth_650 past the terminator — diff = illumination cost, clouds on",
    bodyId: "earth",
    altitudeKm: 650,
    phaseDeg: 145,
  },
  {
    id: "earth_250",
    what: "Volumetric blend fully in (eye-balled ~30 fps region)",
    bodyId: "earth",
    altitudeKm: 250,
  },
  {
    id: "earth_120",
    what: "Low orbit — light volume at full weight, sky-view still off",
    bodyId: "earth",
    altitudeKm: 120,
  },
  {
    id: "earth_30",
    what: "Above the deck, looking down at cloud tops (⚠ NO sky-view bake: USE_SKYVIEW=false)",
    bodyId: "earth",
    altitudeKm: 30,
  },
  {
    id: "earth_8",
    what: "Inside the 1–16 km cloud band — the worst case",
    bodyId: "earth",
    altitudeKm: 8,
  },
  {
    id: "earth_8_night",
    what: "earth_8 past the terminator — diff = illumination cost inside the deck",
    bodyId: "earth",
    altitudeKm: 8,
    phaseDeg: 145,
  },

  // ── Sky-ray coverage ──────────────────────────────────────────────────────
  // ⚠⚠ THE LADDER ABOVE MEASURES THE ATMOSPHERE MARCH ON THE WRONG PIXELS. Every
  // scenario looks AT the planet, so ground rays dominate and sky pixels are a
  // minority everywhere — and `1.5 atmosphere` + `1.6 atmo apply` are the largest
  // items in the whole frame. PERF_MEASUREMENT.md recorded this as an open gap when
  // USE_SKYVIEW was switched off; these are the three scenarios it named.
  // 🔑 `horizon` is the one to watch: a level ray has the longest possible chord
  // through the atmosphere (grazing airmass √(2πR/H) ≈ 71 for Earth's Rayleigh
  // column), so it is the march's worst case by construction, not by guess.
  {
    id: "earth_up_8",
    what: "Inside the cloud band looking STRAIGHT UP — sky rays fill the frame",
    bodyId: "earth",
    altitudeKm: 8,
    lookMode: "up",
  },
  {
    id: "earth_horizon_8",
    what: "Inside the cloud band looking LEVEL sun-ward — longest sky chords",
    bodyId: "earth",
    altitudeKm: 8,
    lookMode: "horizon",
  },
  {
    id: "earth_up_120",
    what: "Low orbit looking away from Earth — sky march with no ground rays",
    bodyId: "earth",
    altitudeKm: 120,
    lookMode: "up",
  },
];

const _eye = new Vector3();
const _target = new Vector3();
const _up = new Vector3(0, 1, 0);
const _lookMatrix = new Matrix4();
const _quat = new Quaternion();
/** Ship-forward is +Z, but Matrix4.lookAt orients −Z at the target. */
const _flipY = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

/**
 * Resolve a scenario to the warp the ship should take.
 *
 * The orientation makes the ship's +Z (and therefore the chase camera's view
 * direction — see the camera block in `Spaceship.tsx`) point at the look target.
 */
export function resolveScenario(scenario: Scenario): DevWarp {
  if (scenario.bodyId === null) {
    if (!scenario.positionKm) {
      throw new Error(`[bench] scenario "${scenario.id}" needs positionKm`);
    }
    _eye.set(...scenario.positionKm);
  } else {
    const b = body(scenario.bodyId);
    const alt = scenario.altitudeKm ?? 0;
    _eye
      .copy(approachDirFor(scenario.bodyId, scenario.phaseDeg ?? BENCH_PHASE_DEG))
      .multiplyScalar(b.radiusKm + alt)
      .add(new Vector3(b.positionKm[0], b.positionKm[1], b.positionKm[2]));
  }

  const mode = scenario.lookMode ?? "body";
  if (mode !== "body" && scenario.bodyId) {
    const up = _lookUp.copy(
      approachDirFor(scenario.bodyId, scenario.phaseDeg ?? BENCH_PHASE_DEG),
    );
    if (mode === "up") {
      _target.copy(_eye).addScaledVector(up, 1e6);
    } else {
      // Level, toward the SUN-WARD horizon: the sun's direction with the local
      // vertical projected out. That is the longest-chord, brightest-sky quadrant, so
      // it is the worst case for the march rather than an average one.
      const b2 = body(scenario.bodyId);
      const star2 = bodies[0];
      _sunLevel
        .set(
          star2.positionKm[0] - b2.positionKm[0],
          star2.positionKm[1] - b2.positionKm[1],
          star2.positionKm[2] - b2.positionKm[2],
        )
        .normalize();
      _sunLevel.addScaledVector(up, -_sunLevel.dot(up));
      // Degenerate at phase 0 (sun exactly overhead): fall back to any level vector.
      if (_sunLevel.lengthSq() < 1e-8) _sunLevel.crossVectors(up, _fallbackPerp);
      _target.copy(_eye).addScaledVector(_sunLevel.normalize(), 1e6);
    }
    _lookMatrix.lookAt(_eye, _target, _up);
    _quat.setFromRotationMatrix(_lookMatrix).multiply(_flipY);
    return {
      positionKm: [_eye.x, _eye.y, _eye.z],
      quaternion: [_quat.x, _quat.y, _quat.z, _quat.w],
    };
  }

  const lookId =
    scenario.lookAtBodyId === undefined ? scenario.bodyId : scenario.lookAtBodyId;
  if (lookId) {
    const lb = body(lookId);
    _target.set(lb.positionKm[0], lb.positionKm[1], lb.positionKm[2]);
  } else {
    // No target — face along the approach axis (i.e. away from the body). For an
    // absolute pose there is no body to be sun-relative to, hence the fallback.
    _target
      .copy(_eye)
      .add(
        scenario.bodyId
          ? approachDirFor(scenario.bodyId, scenario.phaseDeg ?? BENCH_PHASE_DEG)
          : ABSOLUTE_FALLBACK_DIR,
      );
  }

  _lookMatrix.lookAt(_eye, _target, _up);
  _quat.setFromRotationMatrix(_lookMatrix).multiply(_flipY);

  return {
    positionKm: [_eye.x, _eye.y, _eye.z],
    quaternion: [_quat.x, _quat.y, _quat.z, _quat.w],
  };
}

// ── Free-form dev warps ─────────────────────────────────────────────────────

/** Every body id in the active system, in `sol.json` order. */
export const BODY_IDS: readonly string[] = bodies.map((b) => b.id);

/** Surface radius of a body, km — the dev UI shows it next to the altitude field. */
export function bodyRadiusKm(id: string): number {
  return body(id).radiusKm;
}

/**
 * An ad-hoc "put me `altitudeKm` above <body>, looking at it" warp, for the
 * Settings → Dev body picker.
 *
 * Deliberately routed through `resolveScenario` so a hand-driven warp lands in
 * exactly the same pose a benchmark scenario would: same approach axis, same
 * look-at, same +Z convention. Eyeballing a body at some altitude and then
 * measuring a scenario at that altitude should be comparing like with like.
 */
/**
 * A body's centre in scene km, and the star's. Exported for `__lum.lod()`, which must
 * compute the real PHASE ANGLE: `resolveScenario` places the eye at `BENCH_PHASE_DEG`
 * from the sub-solar direction, NOT at 0, so a gate that assumed full illumination
 * (Φ = 1) would be comparing against the wrong reference and would read as a renderer
 * error. ⚠ It is a fixed 35° now rather than an epoch-dependent ~91°, so a gate that
 * hard-coded the old value is wrong by ~56°.
 */
export function bodyPositionKm(id: string): [number, number, number] {
  const b = body(id);
  return [b.positionKm[0], b.positionKm[1], b.positionKm[2]];
}

/** The system's star centre, scene km. Index 0 by convention in sol.json. */
export function starPositionKm(): [number, number, number] {
  const s2 = bodies[0];
  return [s2.positionKm[0], s2.positionKm[1], s2.positionKm[2]];
}

export function resolveBodyWarp(bodyId: string, altitudeKm: number): DevWarp {
  return resolveScenario({
    id: `dev_${bodyId}_${Math.round(altitudeKm)}`,
    what: "ad-hoc dev warp",
    bodyId,
    altitudeKm,
  });
}

/**
 * "Put me inside <body>'s UMBRA, looking back at its dark limb" — the pose that
 * exercises the geometric sun occlusion (defect D27, space/sunOcclusion.ts).
 *
 * The eye goes straight down-sun of the body's centre, so the star is exactly
 * behind the body and `sunVisibility` should return 0. `radiiBehind` trades off
 * two things: too close and the body fills the screen, too far and you leave the
 * umbra — its tip is at `R·d/(R☆−R)`, which is 6,700 body radii for Earth and
 * 6,500 for Neptune, so anything up to a few hundred is safely inside.
 *
 * Derived from `sol.json` positions and radii only — no hand-placed poses, so it
 * stays correct when bodies start orbiting.
 */
export function resolveUmbraWarp(bodyId: string, radiiBehind = 4): DevWarp {
  const b = body(bodyId);
  const star = bodies[0]; // sol — index 0 by convention in sol.json
  _eye
    .set(
      b.positionKm[0] - star.positionKm[0],
      b.positionKm[1] - star.positionKm[1],
      b.positionKm[2] - star.positionKm[2],
    )
    .normalize()
    .multiplyScalar(b.radiusKm * radiiBehind)
    .add(new Vector3(b.positionKm[0], b.positionKm[1], b.positionKm[2]));

  _target.set(b.positionKm[0], b.positionKm[1], b.positionKm[2]);
  _lookMatrix.lookAt(_eye, _target, _up);
  _quat.setFromRotationMatrix(_lookMatrix).multiply(_flipY);
  return {
    positionKm: [_eye.x, _eye.y, _eye.z],
    quaternion: [_quat.x, _quat.y, _quat.z, _quat.w],
  };
}

/**
 * "Stand at `eyeKm` and look along `dirGame`" — the pose `__lum.star()` needs to
 * put a named star dead centre so its peak can be probed (plan §8.2 gap 1).
 *
 * Routed through the same look-at + `_flipY` convention as `resolveScenario`, so
 * "centre of frame" means the same thing here as in every benchmark pose. A
 * second convention would make the gate measure the pose, not the star.
 */
export function resolveLookDirectionWarp(
  dirGame: Vector3,
  eyeKm: readonly [number, number, number],
): DevWarp {
  _eye.set(eyeKm[0], eyeKm[1], eyeKm[2]);
  // A point far enough along the direction that lookAt is numerically stable at
  // interplanetary scale; the star itself is effectively at infinity.
  _target.copy(_eye).addScaledVector(dirGame, 1e9);
  _lookMatrix.lookAt(_eye, _target, _up);
  _quat.setFromRotationMatrix(_lookMatrix).multiply(_flipY);
  return {
    positionKm: [_eye.x, _eye.y, _eye.z],
    quaternion: [_quat.x, _quat.y, _quat.z, _quat.w],
  };
}

/**
 * "Stand `distanceKm` short of a nearby star, looking at it" — the R2b dev warp.
 *
 * ⚠ Uses the SAME look-at + `_flipY` convention as every other resolver here, so
 * "centre of frame" means the same thing as in a benchmark pose. Returns null if
 * the catalogue has not loaded or the id is unknown.
 *
 * ⚠ `distanceKm` is a stand-off from the star's CENTRE, not its surface — at
 * interstellar range the difference is meaningless, and near the star the caller
 * wants the number they typed. `nearbyStars` exposes `params.radiusKm` for
 * anyone who needs radii instead.
 */
export function resolveStarWarp(
  starId: string,
  distanceKm: number,
): DevWarp | null {
  const star = getNearbyStar(starId);
  if (!star) return null;
  const d = Math.max(distanceKm, 1);
  // Approach from the Sol side, so the journey out and the warp agree.
  _eye
    .set(star.positionKm[0], star.positionKm[1], star.positionKm[2])
    .addScaledVector(
      new Vector3(star.dirGame[0], star.dirGame[1], star.dirGame[2]),
      -d,
    );
  _target.set(star.positionKm[0], star.positionKm[1], star.positionKm[2]);
  _lookMatrix.lookAt(_eye, _target, _up);
  _quat.setFromRotationMatrix(_lookMatrix).multiply(_flipY);
  return {
    positionKm: [_eye.x, _eye.y, _eye.z],
    quaternion: [_quat.x, _quat.y, _quat.z, _quat.w],
  };
}

/**
 * The illumination a scenario actually lands in — printed by the sweep so a table can
 * never again be read without knowing which side of the terminator it came from.
 *
 * `litFraction` is the illuminated fraction of the disc as seen from the camera,
 * `(1 + cos g)/2`; `sunElevationDeg` is the sun's elevation at the point directly
 * beneath the camera, `90 − g`, which is the number that means something at surface
 * altitudes. Both are pure geometry, so this needs no GPU and no settled frame.
 */
export function scenarioIllumination(scenario: Scenario): {
  phaseDeg: number;
  litFraction: number;
  sunElevationDeg: number;
  side: "day" | "night" | "terminator";
  /** False when the phase angle still depends on `simEpochMsAtom`. See `belt`. */
  epochStable: boolean;
} {
  const g = phaseDegOf(scenario);
  const lit = (1 + Math.cos((g * Math.PI) / 180)) / 2;
  return {
    phaseDeg: g,
    litFraction: lit,
    sunElevationDeg: 90 - g,
    // ⚠ A 10° dead band, because v1's whole failure was a pose 1.28° from the flip
    // being reported as if it were a side. Anything this close should read as
    // "terminator" and be treated as unreliable, not rounded to a side.
    side: !Number.isFinite(g)
      ? "day"
      : Math.abs(g - 90) < 10
        ? "terminator"
        : g < 90
          ? "day"
          : "night",
    epochStable: scenario.bodyId !== null,
  };
}

const _camRel = new Vector3();
const _sunRel = new Vector3();

/**
 * Phase angle of a scenario, degrees. Body-relative poses know it by construction;
 * ⚠ ABSOLUTE poses have it MEASURED from their live geometry instead, because it is
 * epoch-dependent and hiding that behind a "-" is the exact reporting gap that let v1
 * drift to the night side unnoticed. `belt` is the case that matters: it must stay
 * pinned to `startingPositionKm` to remain inside the asteroid field, so its
 * illumination cannot be pinned and the sweep should say so rather than omit it.
 */
function phaseDegOf(scenario: Scenario): number {
  if (scenario.bodyId !== null) return scenario.phaseDeg ?? BENCH_PHASE_DEG;
  if (!scenario.positionKm) return Number.NaN;
  const refId = scenario.lookAtBodyId ?? "earth";
  const b = bodies.find((x) => x.id === refId);
  if (!b) return Number.NaN;
  const star = bodies[0];
  _camRel
    .set(...(scenario.positionKm as [number, number, number]))
    .sub(new Vector3(b.positionKm[0], b.positionKm[1], b.positionKm[2]));
  _sunRel.set(
    star.positionKm[0] - b.positionKm[0],
    star.positionKm[1] - b.positionKm[1],
    star.positionKm[2] - b.positionKm[2],
  );
  if (_camRel.lengthSq() < 1e-6 || _sunRel.lengthSq() < 1e-6) return Number.NaN;
  return (
    (Math.acos(
      Math.min(1, Math.max(-1, _camRel.normalize().dot(_sunRel.normalize()))),
    ) *
      180) /
    Math.PI
  );
}

/** Distance from the given scenario's eye point to Earth's centre, km. */
export function scenarioDistanceToEarthKm(scenario: Scenario): number {
  const warp = resolveScenario(scenario);
  const earth = body("earth");
  return Math.hypot(
    warp.positionKm[0] - earth.positionKm[0],
    warp.positionKm[1] - earth.positionKm[1],
    warp.positionKm[2] - earth.positionKm[2],
  );
}
