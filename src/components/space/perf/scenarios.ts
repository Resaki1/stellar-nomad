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
 * This works because the sim has no time: planet positions are static constants
 * from `sol.json`, sun direction is pure geometry, nothing rotates, and
 * `SHIP_MAX_SPEED_KMPS` is 0 so a warped ship does not drift. The only moving
 * parts are the temporal accumulators, which the runner waits out.
 *
 * Positions are derived, never hard-coded: `altitudeKm` above a body from
 * `sol.json`, along a fixed approach direction, looking at the body's centre.
 */

import { Matrix4, Quaternion, Vector3 } from "three";
import type { DevWarp } from "@/store/dev";
import solSystem from "@/sim/systems/sol.json";
import type { CelestialBodyDef } from "@/sim/systemTypes";

const bodies = solSystem.celestialBodies as CelestialBodyDef[];

function body(id: string): CelestialBodyDef {
  const b = bodies.find((x) => x.id === id);
  if (!b) throw new Error(`[bench] body "${id}" not found in sol.json`);
  return b;
}

/**
 * The approach direction used for every body-relative scenario: the unit vector
 * from Earth's centre toward the game's default spawn point. Using the real
 * spawn axis means the benchmark sees the same terrain, the same sun angle, and
 * the same cloud cover the player sees flying in — not an arbitrary pole-on view
 * that would under-report cost.
 */
const APPROACH_DIR = (() => {
  const earth = body("earth");
  const start = solSystem.startingPositionKm as [number, number, number];
  return new Vector3(
    start[0] - earth.positionKm[0],
    start[1] - earth.positionKm[1],
    start[2] - earth.positionKm[2],
  ).normalize();
})();

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
    // The default spawn point, which sits inside the origin belt.
    positionKm: solSystem.startingPositionKm as [number, number, number],
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
    what: "Above the deck, Sky-View LUT baking, looking down at cloud tops",
    bodyId: "earth",
    altitudeKm: 30,
  },
  {
    id: "earth_8",
    what: "Inside the 1–16 km cloud band — the worst case",
    bodyId: "earth",
    altitudeKm: 8,
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
      .copy(APPROACH_DIR)
      .multiplyScalar(b.radiusKm + alt)
      .add(new Vector3(b.positionKm[0], b.positionKm[1], b.positionKm[2]));
  }

  const lookId =
    scenario.lookAtBodyId === undefined ? scenario.bodyId : scenario.lookAtBodyId;
  if (lookId) {
    const lb = body(lookId);
    _target.set(lb.positionKm[0], lb.positionKm[1], lb.positionKm[2]);
  } else {
    // No target — face along the approach axis (i.e. away from Earth).
    _target.copy(_eye).add(APPROACH_DIR);
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
 * compute the real PHASE ANGLE: `resolveScenario` places the eye along a fixed
 * `APPROACH_DIR`, NOT along the sub-solar direction, so a gate that assumed full
 * illumination (Φ = 1) would be comparing against the wrong reference and would read
 * as a renderer error.
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
