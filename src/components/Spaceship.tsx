import { useFrame } from "@react-three/fiber";
import { memo, useEffect, useMemo, useRef } from "react";
import { MathUtils, Vector3, Mesh, type PerspectiveCamera } from "three";
import { getCameraTuning } from "./Camera/cameraTuning";
import { ShipOne } from "./models/ships/ShipOne";
import EngineExhaust from "./VFX/EngineExhaust";
import type { ExhaustConfig } from "./VFX/EngineExhaust";
import { useStore } from "jotai";
import { hudInfoAtom, shipHealthAtom } from "@/store/store";
import { collisionImpactAtom, cameraShakeIntensityAtom, spawnVFXEventAtom } from "@/store/vfx";
import { audioShipBuffer } from "@/audio/shipBuffer";
import { effectiveShipConfigAtom } from "@/store/shipConfig";
import { devTeleportAtom, devMaxSpeedOverrideAtom, benchModeAtom } from "@/store/dev";
import { dieAtom, isDeadAtom } from "@/store/death";
import { cargoAtom } from "@/store/cargo";
import { systemConfigAtom } from "@/store/system";
import { transitDriveBuffer, TRANSIT_STEER_MULT } from "@/store/transit";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { collectShipPose, loadShipState } from "@/sim/shipPersistence";
import { frameOriginKm } from "@/sim/frames";
import { updateShipFrame } from "@/sim/ship/shipFrame";
import type { CelestialCollider } from "@/sim/celestialCollision";
import { LOCAL_PLAYER_ID, registerEntity, unregisterEntity } from "@/sim/entities";
import { createShipState, resetShipMotion, updateShipAbsolute, type ShipState } from "@/sim/ship/shipState";
import { createShipInput } from "@/sim/ship/shipInput";
import { createShipStepEnv, shipBodyAxes, stepShip } from "@/sim/ship/stepShip";
import { getFlightTuning, speedLimitKmps } from "@/sim/ship/flightTuning";
import { loadTuningPrefs } from "@/store/flightTuningPrefs";
import { FIXED_DT, MAX_FRAME_DT, SHIP_HULL_RADIUS_KM } from "@/sim/ship/shipConstants";
import { sampleShipInput } from "@/input/sampleShipInput";
import { playerInput, resetPlayerInput } from "@/input/playerInput";
import { mouseState, resetMouseSteering, updateMouseSteering } from "@/input/mouse";
import { ChaseRig, type ShipMotion } from "./Camera/chaseCamera";
import { shipView } from "./Camera/shipView";
import { drawFlightHud } from "./HUD/FlightHud/flightHudBuffer";
import { starDiscPool } from "@/components/space/starLodStatus";
import { testProbe } from "@/components/TestHarness/testProbe";
import { FRAME_PRIORITY_PLAYER_SHIP } from "@/components/frameOrder";
import { isSimPaused } from "@/sim/simPause";

/**
 * Collider slots reserved for promoted stars (§19). Must be ≥ the disc pool's size;
 * unused slots carry r = 0 and are skipped by the sweep.
 */
const STAR_COLLIDER_SLOTS = 4;
/** Index of the first star slot in `celestialColliders`. */
let _starColliderBase = 0;

const _localRel = new Vector3();
const _frameOrigin = new Vector3();
const _input = createShipInput();
const _env = createShipStepEnv(getFlightTuning());
const _vPrev = new Vector3();
const _accel = new Vector3();
const _bf = new Vector3();
const _br = new Vector3();
const _bu = new Vector3();
const _motion: ShipMotion = {
  accelRight: 0, accelUp: 0, accelForward: 0, speedFrac: 0, boosting: false,
  freeLook: false, freeLookYaw: 0, freeLookPitch: 0, shakeSignal: 0, benchMode: false,
};
/** HUD readout cadence; the atom write re-renders the dashboard. */
const HUD_PUBLISH_S = 0.1;

const COLLISION_SPEED_DIP_MIN = 0.15; // small asteroid: lose 15% speed
const COLLISION_SPEED_DIP_MAX = 0.65; // huge asteroid: lose 65% speed
const COLLISION_SIZE_REF_M = 200;     // radius at which dip reaches max

// Engine exhaust nozzle config (model-local space, inside 0.3x group); edit when swapping models.
const EXHAUST_CONFIGS: ExhaustConfig[] = [
  // position: [X, Y, Z], +X is left, +Y is up, +Z is forward
  { position: [4.1, 1.2, -9.5], radius: 1.32 }, // left nozzle
  { position: [-4.1, 1.2, -9.5], radius: 1.32 },  // right nozzle
];

const EXHAUST_SMOOTH_RATE = 6.0; // higher = faster response

function killTransitDrive(): void {
  transitDriveBuffer.velocityKmps = { x: 0, y: 0, z: 0 };
  transitDriveBuffer.phase = "idle";
  transitDriveBuffer.spoolAccS = 0;
  transitDriveBuffer.autopilot = false;
}

/** Publish the absolute + frame-relative pose to the transit buffer and the test probe. */
function publishShipPose(ship: ShipState): void {
  transitDriveBuffer.shipPosKm = { x: ship.absPosKm.x, y: ship.absPosKm.y, z: ship.absPosKm.z };
  const t = testProbe.ship;
  const p = t.posKm, r = t.relPosKm, q = t.quat;
  p[0] = ship.absPosKm.x; p[1] = ship.absPosKm.y; p[2] = ship.absPosKm.z;
  r[0] = ship.posKm.x; r[1] = ship.posKm.y; r[2] = ship.posKm.z;
  q[0] = ship.quat.x; q[1] = ship.quat.y; q[2] = ship.quat.z; q[3] = ship.quat.w;
  t.frameId = ship.frameId;
  const v = t.velKmps, w = t.angVel;
  v[0] = ship.velKmps.x; v[1] = ship.velKmps.y; v[2] = ship.velKmps.z;
  w[0] = ship.angVel.x; w[1] = ship.angVel.y; w[2] = ship.angVel.z;
  t.assist = ship.assist;
  t.boostCharge = ship.boostCharge;
  t.speedLimitKmps = ship.speedLimitKmps;
}

const SpaceShip = memo(() => {
  const store = useStore();
  const worldOrigin = useWorldOrigin();
  const shipRef = useRef<Mesh>(null!);
  const modelRef = useRef<Mesh>(null!);

  const shipState = useRef<ShipState>(null!);
  if (!shipState.current) shipState.current = createShipState();
  const chaseCamera = useRef<ChaseRig>(null!);
  if (!chaseCamera.current) chaseCamera.current = new ChaseRig();

  const physicsAcc = useRef(0);
  const hudAcc = useRef(0);
  const exhaustIntensity = useRef(0);
  /** Live position arrays backing `celestialColliders`, in the same order. */
  const colliderSources = useRef<readonly (readonly number[])[]>([]);

  // ⚠ Allocated once, REFRESHED EVERY FRAME. Positions are copied as scalars, so
  // mutating `body.positionKm` in place (ephemeris) never reaches a stale copy; built
  // once, the ship crashed into empty space where a planet used to be. Anything that
  // copied scalars must re-read — grep `positionKm[0]`.
  const celestialColliders = useMemo<CelestialCollider[]>(() => {
    const system = store.get(systemConfigAtom);
    const bodies = system.celestialBodies ?? [];
    colliderSources.current = bodies.map((b) => b.positionKm);
    const list: CelestialCollider[] = bodies.map((b) => ({
      id: b.id,
      x: b.positionKm[0],
      y: b.positionKm[1],
      z: b.positionKm[2],
      r: b.radiusKm,
    }));
    // §19: fixed-size tail for promoted stars (without it every non-Sol star could be
    // flown through). ⚠ r = 0 marks an unused slot; sweptSphereCollide skips those, else
    // a stale (0,0,0) slot would be a hull-sized sphere at Sol.
    for (let i = 0; i < STAR_COLLIDER_SLOTS; i++) {
      list.push({ id: `star-slot-${i}`, x: 0, y: 0, z: 0, r: 0 });
    }
    _starColliderBase = bodies.length;
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Hydrate from persisted state (once, on mount) ──────────────────
  const hydrated = useRef(false);
  if (!hydrated.current) {
    hydrated.current = true;
    const ship = shipState.current;
    const saved = loadShipState();
    if (saved) {
      ship.frameId = saved.frameId;
      ship.posKm.set(saved.positionKm[0], saved.positionKm[1], saved.positionKm[2]);
      ship.quat.set(saved.quaternion[0], saved.quaternion[1], saved.quaternion[2], saved.quaternion[3]);
      ship.prevPosKm.copy(ship.posKm);
      ship.prevQuat.copy(ship.quat);
    }
    updateShipAbsolute(ship);
    // Sync world origin so camera / SimGroups don't jump
    worldOrigin.setShipPosKm(ship.absPosKm);
    worldOrigin.setWorldOriginKm(ship.absPosKm);
  }

  // Register the sim state in the entity table.
  useEffect(() => {
    loadTuningPrefs();
    registerEntity({ id: LOCAL_PLAYER_ID, kind: "ship", ship: shipState.current });
    return () => unregisterEntity(LOCAL_PLAYER_ID);
  }, []);

  // Pose is sampled at save-flush time; bench/test isolation suspends the writes.
  useEffect(() => collectShipPose(shipState.current), []);

  // Track dead state to show/hide ship mesh
  const wasDeadRef = useRef(false);

  useFrame(({ camera, size }, delta) => {
    if (!shipRef.current || !modelRef.current) return;
    const ship = shipState.current;

    // ── Death gate: hide ship and freeze everything when dead ──────
    const dead = store.get(isDeadAtom);
    if (dead) {
      if (!wasDeadRef.current) {
        shipRef.current.visible = false;
        wasDeadRef.current = true;
        killTransitDrive();
      }
      // The wreck site keeps riding its frame while the death screen is up.
      updateShipAbsolute(ship);
      publishShipPose(ship);
      worldOrigin.setShipPosKm(ship.absPosKm);
      worldOrigin.setWorldOriginKm(ship.absPosKm);
      return;
    }
    if (wasDeadRef.current) {
      // Just respawned — re-show ship at rest, kill residual shake
      shipRef.current.visible = true;
      resetShipMotion(ship);
      resetPlayerInput();
      resetMouseSteering();
      chaseCamera.current.snap();
      modelRef.current.rotation.x = modelRef.current.rotation.z = 0;
      store.set(cameraShakeIntensityAtom, 0);
      wasDeadRef.current = false;
    }

    // Benchmark mode: suppress wall-clock-driven and save-mutating side effects
    // that would make a measurement irreproducible. See benchModeAtom.
    const benchMode = store.get(benchModeAtom);

    // Consume collision impact once per frame, before the physics loop.
    const impact = store.get(collisionImpactAtom);
    if (impact) {
      // Size-dependent speed dip: small asteroids = mild, large = severe.
      const t = Math.min(impact.radiusM / COLLISION_SIZE_REF_M, 1);
      const dip = COLLISION_SPEED_DIP_MIN + (COLLISION_SPEED_DIP_MAX - COLLISION_SPEED_DIP_MIN) * t;
      ship.velKmps.multiplyScalar(1 - dip);
      store.set(collisionImpactAtom, null);
    }

    // ── Dev warp (one-shot) ────────────────────────────────────────────
    // Zero everything carrying motion: prevPosKm (else the swept collider sweeps from the
    // OLD position through every planet in between), velocity, throttle, transit drive.
    const warp = store.get(devTeleportAtom);
    if (warp) {
      ship.frameId = warp.frameId;
      ship.posKm.set(warp.relKm[0], warp.relKm[1], warp.relKm[2]);
      if (warp.quaternion) {
        ship.quat.set(warp.quaternion[0], warp.quaternion[1], warp.quaternion[2], warp.quaternion[3]);
      }
      resetShipMotion(ship);
      updateShipAbsolute(ship);
      worldOrigin.setShipPosKm(ship.absPosKm);
      worldOrigin.setWorldOriginKm(ship.absPosKm);
      physicsAcc.current = 0;
      chaseCamera.current.snap();
      modelRef.current.rotation.x = modelRef.current.rotation.z = 0;
      resetPlayerInput();
      resetMouseSteering();
      killTransitDrive();
      store.set(devTeleportAtom, null);
    }

    const inputDt = isSimPaused() ? 0 : Math.min(delta, MAX_FRAME_DT);
    updateMouseSteering(ship.quat, inputDt, transitDriveBuffer.desiredForward !== null);
    sampleShipInput(_input, inputDt);

    // ── Per-frame step environment (nothing below changes between substeps) ──
    const tBuf = transitDriveBuffer;
    const cfg = store.get(effectiveShipConfigAtom);
    const devSpeed = store.get(devMaxSpeedOverrideAtom);
    const transitActive = tBuf.phase === "accelerating" || tBuf.phase === "decelerating";
    _env.steerMult = transitActive ? TRANSIT_STEER_MULT : 1;
    const desired = tBuf.desiredForward;
    _env.hasDesiredForward = desired !== null;
    if (desired) {
      _env.desiredForwardX = desired.x;
      _env.desiredForwardY = desired.y;
      _env.desiredForwardZ = desired.z;
    }
    _env.desiredForwardRateRadPerS = tBuf.desiredForwardRateRadPerS;
    _env.tuning = getFlightTuning();
    _env.accelerationMult = cfg.accelerationMult;
    _env.decelerationMult = cfg.decelerationMult;
    _env.speedMult = cfg.speedMult;
    // Dev override is absolute (skips speedMult).
    _env.speedLimitOverrideKmps = devSpeed !== null ? Math.max(0, devSpeed / 1000) : -1;
    _env.transitVelX = tBuf.velocityKmps.x;
    _env.transitVelY = tBuf.velocityKmps.y;
    _env.transitVelZ = tBuf.velocityKmps.z;
    _env.colliders = celestialColliders;
    _env.hullRadiusKm = SHIP_HULL_RADIUS_KM;

    // Refresh colliders from the live ephemeris arrays, relative to the ship's frame.
    const fo = frameOriginKm(ship.frameId, _frameOrigin);
    for (let i = 0; i < celestialColliders.length; i++) {
      const src = colliderSources.current[i];
      if (!src) continue;
      celestialColliders[i].x = src[0] - fo.x;
      celestialColliders[i].y = src[1] - fo.y;
      celestialColliders[i].z = src[2] - fo.z;
    }
    // §19: refresh the promoted-star tail. Copy SCALARS: pool slots are replaced
    // wholesale on promotion, not mutated in place.
    for (let i = 0; i < STAR_COLLIDER_SLOTS; i++) {
      const c = celestialColliders[_starColliderBase + i];
      const s = starDiscPool[i];
      if (!c) continue;
      if (!s) {
        c.r = 0;
        continue;
      }
      c.id = s.id;
      c.x = s.positionKm[0] - fo.x;
      c.y = s.positionKm[1] - fo.y;
      c.z = s.positionKm[2] - fo.z;
      c.r = s.radiusKm;
    }

    // ── Fixed-timestep physics loop ────────────────────────────────────
    if (isSimPaused()) physicsAcc.current = 0;
    else physicsAcc.current += Math.min(delta, MAX_FRAME_DT);

    _vPrev.copy(ship.velKmps);
    let stepsRun = 0;
    while (physicsAcc.current >= FIXED_DT) {
      const hit = stepShip(ship, _input, _env, FIXED_DT);
      if (hit) {
        killTransitDrive();
        store.set(shipHealthAtom, 0);
        store.set(spawnVFXEventAtom, {
          type: "collision",
          position: [0, 0, 0],
          radiusM: 120,
        });
        const cargo = store.get(cargoAtom);
        store.set(dieAtom, {
          frameId: ship.frameId,
          positionKm: [ship.posKm.x, ship.posKm.y, ship.posKm.z],
          cargoItems: cargo.items,
        });
        // Stop further substeps; the top-of-frame dead gate handles later frames.
        physicsAcc.current = 0;
        break;
      }

      // Forward + position for TransitTicker (flip point / acceleration direction).
      tBuf.shipForward = { x: ship.forward.x, y: ship.forward.y, z: ship.forward.z };

      physicsAcc.current -= FIXED_DT;
      testProbe.ship.steps++;
      stepsRun++;
    }
    // Body acceleration for the camera's give-way (m/s²); held over frames that ran no step.
    if (stepsRun > 0) {
      _accel.subVectors(ship.velKmps, _vPrev).multiplyScalar(1000 / (stepsRun * FIXED_DT));
      // The dev speed override scales thrust with the limit; the camera must not feel that,
      // or the slightest turn at light-years per second throws it to its stops.
      if (_env.speedLimitOverrideKmps >= 0) {
        const base = speedLimitKmps(_env.tuning, cfg.decelerationMult, cfg.speedMult);
        if (base > 0 && _env.speedLimitOverrideKmps > base) _accel.multiplyScalar(base / _env.speedLimitOverrideKmps);
      }
      shipBodyAxes(ship.quat, _bf, _br, _bu);
      _motion.accelForward = _accel.dot(_bf);
      _motion.accelRight = _accel.dot(_br);
      _motion.accelUp = _accel.dot(_bu);
    }
    // Frame switch: once per frame, after the substeps, never inside stepShip.
    if (updateShipFrame(ship) !== null) {
      frameOriginKm(ship.frameId, _frameOrigin);
      testProbe.ship.frameSwitches++;
    }
    // Absolute, every frame: the ship moves with its frame even when no substep ran.
    publishShipPose(ship);

    // ── Engine exhaust intensity (real main-engine thrust of the last step) ──
    {
      const thrust = Math.min(1, ship.thrustMain);
      exhaustIntensity.current += (thrust - exhaustIntensity.current)
        * Math.min(1, EXHAUST_SMOOTH_RATE * delta);
      if (exhaustIntensity.current < 0.001) exhaustIntensity.current = 0;

      // Plain buffer write, not an atom: frame-rate writer, 15 Hz reader
      // (docs/AUDIO_PLAN.md A5). Plume and engine sound share one value.
      audioShipBuffer.throttle = exhaustIntensity.current;
    }

    // ── Interpolation ──────────────────────────────────────────────────
    const alpha = physicsAcc.current / FIXED_DT;

    shipRef.current.quaternion.slerpQuaternions(ship.prevQuat, ship.quat, alpha);

    // Visual only: the model rolls into yaw and leans into pitch, in proportion to turn rate.
    {
      const ct = getCameraTuning();
      const ft = _env.tuning;
      const yawFrac = ft.maxYawRateDegS > 0 ? -ship.angVel.y / (ft.maxYawRateDegS * MathUtils.DEG2RAD) : 0;
      // Same sign as the real pitch rate (the model shares the ship's x axis), so the lean leads the turn.
      const pitchFrac = ft.maxPitchRateDegS > 0 ? ship.angVel.x / (ft.maxPitchRateDegS * MathUtils.DEG2RAD) : 0;
      const k = 1 - Math.exp(-delta / ct.bankLagS);
      const rot = modelRef.current.rotation;
      rot.z += (MathUtils.clamp(yawFrac, -1, 1) * ct.bankMaxDeg * MathUtils.DEG2RAD - rot.z) * k;
      rot.x += (MathUtils.clamp(pitchFrac, -1, 1) * ct.pitchLeanMaxDeg * MathUtils.DEG2RAD - rot.x) * k;
    }

    // Interpolate in frame-relative km, add the CURRENT frame origin, and put the world
    // origin there so the ship sits at local (0,0,0).
    _localRel.lerpVectors(ship.prevPosKm, ship.posKm, alpha).add(_frameOrigin);
    worldOrigin.setShipPosKm(ship.absPosKm);
    worldOrigin.setWorldOriginKm(_localRel);
    shipRef.current.position.set(0, 0, 0);
    shipView.position.set(0, 0, 0);
    shipView.forward.set(0, 0, 1).applyQuaternion(shipRef.current.quaternion);

    // ── Camera (chase + shake) ──────────────────────────────────────────
    const shakeSignal = store.get(cameraShakeIntensityAtom);
    if (shakeSignal > 0) store.set(cameraShakeIntensityAtom, 0);
    const speedKmps = ship.velKmps.length();
    const refLimit = _env.speedLimitOverrideKmps >= 0
      ? _env.speedLimitOverrideKmps
      : speedLimitKmps(_env.tuning, cfg.decelerationMult, cfg.speedMult);
    const speedFrac = Math.min(1.5, refLimit > 0 ? speedKmps / refLimit : 0);
    _motion.speedFrac = speedFrac;
    _motion.boosting = ship.boosting;
    _motion.freeLook = mouseState.freeLook;
    _motion.freeLookYaw = mouseState.freeLookYaw;
    _motion.freeLookPitch = mouseState.freeLookPitch;
    _motion.shakeSignal = shakeSignal;
    _motion.benchMode = benchMode;
    const cam = camera as PerspectiveCamera;
    chaseCamera.current.update(cam, shipRef.current, _motion, delta);
    drawFlightHud(cam, size, shipRef.current.quaternion, ship.velKmps, transitActive);

    // ── HUD speed: the real velocity, or the transit velocity when larger ──
    const transitSpeedMps = (_env.transitVelX !== 0 || _env.transitVelY !== 0 || _env.transitVelZ !== 0)
      ? Math.sqrt(
          tBuf.velocityKmps.x ** 2 +
          tBuf.velocityKmps.y ** 2 +
          tBuf.velocityKmps.z ** 2
        ) * 1000 // km/s → m/s
      : 0;
    const normalSpeedMps = speedKmps * 1000;
    // ⚠ Audio write is OUTSIDE the benchMode guard on purpose: the guard exists because
    // store.set re-renders HUD subtrees, a plain-object write does not, and the wind bed
    // must stay driven during a bench run. Same definition as the HUD speed (transit
    // included) so the bed never disagrees with the on-screen number.
    audioShipBuffer.speedMps = Math.max(normalSpeedMps, transitSpeedMps);
    hudAcc.current += delta;
    if (!benchMode && hudAcc.current >= HUD_PUBLISH_S) {
      hudAcc.current = 0;
      store.set(hudInfoAtom, {
        speed: Math.max(normalSpeedMps, transitSpeedMps),
        throttle: playerInput.throttle,
        setPointSpeed: playerInput.throttle * refLimit * 1000,
        speedLimit: ship.speedLimitKmps * 1000,
        decoupled: ship.assist === "decoupled",
        boostCharge: ship.boostCharge,
      });
    }
  }, FRAME_PRIORITY_PLAYER_SHIP);

  return (
    <mesh ref={shipRef} name="playerShip">
      <ShipOne ref={modelRef} name="playerShipModel">
        <EngineExhaust
          configs={EXHAUST_CONFIGS}
          intensityRef={exhaustIntensity}
        />
      </ShipOne>
    </mesh>
  );
});

SpaceShip.displayName = "SpaceShip";

export default SpaceShip;
