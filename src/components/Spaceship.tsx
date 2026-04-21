import { logLimit } from "@/helpers/math";
import { useFrame } from "@react-three/fiber";
import { memo, useEffect, useMemo, useRef } from "react";
import { Quaternion, Vector3, Mesh, MathUtils } from "three";
import { ShipOne } from "./models/ships/ShipOne";
import EngineExhaust from "./VFX/EngineExhaust";
import type { ExhaustConfig } from "./VFX/EngineExhaust";
import { lerp } from "three/src/math/MathUtils.js";
import { useStore } from "jotai";
import { hudInfoAtom, movementAtom, shipHealthAtom } from "@/store/store";
import { collisionImpactAtom, cameraShakeIntensityAtom, spawnVFXEventAtom } from "@/store/vfx";
import { effectiveShipConfigAtom } from "@/store/shipConfig";
import { devTeleportAtom, devMaxSpeedOverrideAtom } from "@/store/dev";
import { dieAtom, isDeadAtom } from "@/store/death";
import { cargoAtom } from "@/store/cargo";
import { systemConfigAtom } from "@/store/system";
import { transitDriveBuffer, TRANSIT_STEER_MULT } from "@/store/transit";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { loadShipState, saveShipState } from "@/sim/shipPersistence";
import { STARTING_POSITION_KM, STARTING_ROTATION_QUAT } from "@/sim/celestialConstants";
import { sweptSphereCollide, type CelestialCollider } from "@/sim/celestialCollision";

// ── Module-level temps (reused every frame, never GC'd) ──────────────
const _quat = new Quaternion();
const _xAxis = new Vector3(1, 0, 0);
const _yAxis = new Vector3(0, 1, 0);
const _fwd = new Vector3();
const _cameraOffset = new Vector3(0, -4, 10);
const _offset = new Vector3();
const _rotationQuat = new Quaternion().setFromAxisAngle(_yAxis, Math.PI);
const _vel = new Vector3();
const _transitVel = new Vector3();
const _autopilotTarget = new Vector3();
const _autopilotAxis = new Vector3();
const _localRel = new Vector3();
const _shakeOffset = new Vector3();
const _shakeEuler = new Quaternion();

// ── Tuning constants ─────────────────────────────────────────────────
const SHIP_HANDLING = 1.5;
const MAX_ROT_SPEED = SHIP_HANDLING / 2;
const SHIP_MAX_SPEED_KMPS = 400 / 1000;
const COLLISION_SPEED_DIP_MIN = 0.15; // small asteroid: lose 15% speed
const COLLISION_SPEED_DIP_MAX = 0.65; // huge asteroid: lose 65% speed
const COLLISION_SIZE_REF_M = 200;     // radius at which dip reaches max
const PERSIST_INTERVAL = 2.0; // seconds between position saves

// ── Engine exhaust nozzle config (model-local space, inside 0.3× group) ──
// Adjust positions / count here when swapping ship models.
const EXHAUST_CONFIGS: ExhaustConfig[] = [
  // position: [X, Y, Z], +X is left, +Y is up, +Z is forward
  { position: [4.1, 1.2, -9.5], radius: 1.32 }, // left nozzle
  { position: [-4.1, 1.2, -9.5], radius: 1.32 },  // right nozzle
];

// ── Smoothing for visual exhaust intensity ───────────────────────────
const EXHAUST_SMOOTH_RATE = 6.0; // higher = faster responsew

// ── Camera shake ─────────────────────────────────────────────────────
const SHAKE_DECAY_RATE = 3.0;   // exponential decay speed
const SHAKE_MAX_OFFSET = 0.8;   // meters
const SHAKE_MAX_ANGLE = 0.025;  // radians

// ── Fixed-timestep physics ───────────────────────────────────────────
// Physics advances in fixed increments; rendering interpolates between
// the two most recent states. This eliminates micro-jitter caused by
// natural frame-time (delta) variation on the GPU/compositor side.
const FIXED_DT = 1 / 120;
const MAX_FRAME_DT = 0.25; // cap: prevents spiral-of-death after tab-away

// Ship hull radius used for continuous celestial-body collision. Kept tiny
// so surface-buzzing flights still work; exists only to avoid visual
// penetration at the mesh scale.
const SHIP_HULL_RADIUS_KM = 0.05;

const SpaceShip = memo(() => {
  const store = useStore();
  const worldOrigin = useWorldOrigin();
  const shipRef = useRef<Mesh>(null!);
  const modelRef = useRef<Mesh>(null!);

  // ── Simulation state (advanced at fixed FIXED_DT) ──────────────────
  const posKm = useRef(new Vector3(STARTING_POSITION_KM[0], STARTING_POSITION_KM[1], STARTING_POSITION_KM[2]));
  const simQuat = useRef(new Quaternion(STARTING_ROTATION_QUAT[0], STARTING_ROTATION_QUAT[1], STARTING_ROTATION_QUAT[2], STARTING_ROTATION_QUAT[3]));
  const yawRate = useRef(0);
  const pitchRate = useRef(0);
  const vRoll = useRef(0);
  const vPitch = useRef(0);
  const speed = useRef(0);

  // ── Previous-step snapshot (for interpolation) ─────────────────────
  const prevPosKm = useRef(new Vector3(STARTING_POSITION_KM[0], STARTING_POSITION_KM[1], STARTING_POSITION_KM[2]));
  const prevQuat = useRef(new Quaternion(STARTING_ROTATION_QUAT[0], STARTING_ROTATION_QUAT[1], STARTING_ROTATION_QUAT[2], STARTING_ROTATION_QUAT[3]));
  const prevVRoll = useRef(0);
  const prevVPitch = useRef(0);

  // ── Misc ────────────────────────────────────────────────────────────
  const physicsAcc = useRef(0);
  const persistAcc = useRef(0);

  // ── Engine exhaust state ────────────────────────────────────────────
  const exhaustIntensity = useRef(0);

  // ── Camera shake state ──────────────────────────────────────────────
  const shakeIntensity = useRef(0);

  // ── Celestial colliders (built once from the active system) ────────
  // Flat numeric layout avoids array-of-arrays indirection in the hot path.
  const celestialColliders = useMemo<CelestialCollider[]>(() => {
    const system = store.get(systemConfigAtom);
    const bodies = system.celestialBodies ?? [];
    return bodies.map((b) => ({
      id: b.id,
      x: b.positionKm[0],
      y: b.positionKm[1],
      z: b.positionKm[2],
      r: b.radiusKm,
    }));
    // systemConfigAtom is effectively static in the current codebase.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Hydrate from persisted state (once, on mount) ──────────────────
  const hydrated = useRef(false);
  if (!hydrated.current) {
    hydrated.current = true;
    const saved = loadShipState();
    if (saved) {
      posKm.current.set(saved.positionKm[0], saved.positionKm[1], saved.positionKm[2]);
      simQuat.current.set(saved.quaternion[0], saved.quaternion[1], saved.quaternion[2], saved.quaternion[3]);
      prevPosKm.current.copy(posKm.current);
      prevQuat.current.copy(simQuat.current);
    }
    // Sync world origin so camera / SimGroups don't jump
    worldOrigin.setShipPosKm(posKm.current);
    worldOrigin.setWorldOriginKm(posKm.current);
  }

  // ── Flush on beforeunload ───────────────────────────────────────────
  useEffect(() => {
    const flush = () => saveShipState(posKm.current, simQuat.current);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush(); // also save on unmount
    };
  }, []);

  // Track dead state to show/hide ship mesh
  const wasDeadRef = useRef(false);

  useFrame(({ camera }, delta) => {
    if (!shipRef.current || !modelRef.current) return;

    // ── Death gate: hide ship and freeze everything when dead ──────
    const dead = store.get(isDeadAtom);
    if (dead) {
      if (!wasDeadRef.current) {
        shipRef.current.visible = false;
        wasDeadRef.current = true;
        // Kill transit drive on death.
        transitDriveBuffer.velocityKmps = { x: 0, y: 0, z: 0 };
        transitDriveBuffer.phase = "idle";
        transitDriveBuffer.spoolAccS = 0;
        transitDriveBuffer.autopilot = false;
      }
      return;
    }
    if (wasDeadRef.current) {
      // Just respawned — re-show ship, kill residual shake
      shipRef.current.visible = true;
      shakeIntensity.current = 0;
      store.set(cameraShakeIntensityAtom, 0);
      wasDeadRef.current = false;
    }

    // Read input imperatively (zero subscriptions → zero re-renders).
    const movement = store.get(movementAtom);

    // Consume collision impact once per frame, before the physics loop.
    const impact = store.get(collisionImpactAtom);
    if (impact) {
      // Size-dependent speed dip: small asteroids = mild, large = severe.
      const t = Math.min(impact.radiusM / COLLISION_SIZE_REF_M, 1);
      const dip = COLLISION_SPEED_DIP_MIN + (COLLISION_SPEED_DIP_MAX - COLLISION_SPEED_DIP_MIN) * t;
      speed.current *= (1 - dip);
      store.set(collisionImpactAtom, null);
    }

    // ── Dev teleport (one-shot) ────────────────────────────────────────
    const teleport = store.get(devTeleportAtom);
    if (teleport) {
      posKm.current.set(teleport[0], teleport[1], teleport[2]);
      prevPosKm.current.copy(posKm.current);
      worldOrigin.setShipPosKm(posKm.current);
      worldOrigin.setWorldOriginKm(posKm.current);
      speed.current = 0;
      store.set(devTeleportAtom, null);
    }

    // ── Fixed-timestep physics loop ────────────────────────────────────
    physicsAcc.current += Math.min(delta, MAX_FRAME_DT);

    while (physicsAcc.current >= FIXED_DT) {
      // Snapshot previous state for interpolation.
      prevPosKm.current.copy(posKm.current);
      prevQuat.current.copy(simQuat.current);
      prevVRoll.current = vRoll.current;
      prevVPitch.current = vPitch.current;

      // Steering rate — reduced during transit drive.
      const transitActive = transitDriveBuffer.phase === "accelerating"
        || transitDriveBuffer.phase === "decelerating";
      const steerMult = transitActive ? TRANSIT_STEER_MULT : 1;
      const handling = SHIP_HANDLING * steerMult;
      const maxRot = MAX_ROT_SPEED * steerMult;

      // Yaw
      if (movement.yaw) {
        vRoll.current = logLimit(
          vRoll.current + movement.yaw * handling * FIXED_DT,
          Math.PI / 6 * steerMult
        );
        yawRate.current = MathUtils.clamp(
          yawRate.current + movement.yaw * handling * FIXED_DT,
          -maxRot,
          maxRot
        );
      } else {
        vRoll.current = MathUtils.lerp(vRoll.current, 0, SHIP_HANDLING * FIXED_DT);
        yawRate.current -= yawRate.current * SHIP_HANDLING * FIXED_DT;
      }

      // Pitch
      if (movement.pitch) {
        vPitch.current = logLimit(
          vPitch.current + movement.pitch * handling * FIXED_DT,
          Math.PI / 6 * steerMult
        );
        pitchRate.current = MathUtils.clamp(
          pitchRate.current + movement.pitch * handling * FIXED_DT,
          -maxRot,
          maxRot
        );
      } else {
        vPitch.current = MathUtils.lerp(vPitch.current, 0, SHIP_HANDLING * FIXED_DT);
        pitchRate.current -= pitchRate.current * SHIP_HANDLING * FIXED_DT;
      }

      // Rotation
      _quat.setFromAxisAngle(_yAxis, -yawRate.current * FIXED_DT);
      simQuat.current.multiply(_quat);
      _quat.setFromAxisAngle(_xAxis, pitchRate.current * FIXED_DT);
      simQuat.current.multiply(_quat);
      simQuat.current.normalize();

      // Forward direction
      _fwd.set(0, 0, 1).applyQuaternion(simQuat.current);

      // ── Autopilot orientation override ───────────────────────────────
      // When TransitTicker sets a desiredForward, rotate simQuat toward it
      // at the specified rate. This drives both spool-phase auto-align and
      // acceleration-phase continuous course correction.
      const desired = transitDriveBuffer.desiredForward;
      if (desired) {
        _autopilotTarget.set(desired.x, desired.y, desired.z);
        if (_autopilotTarget.lengthSq() > 0) {
          _autopilotTarget.normalize();
          const dot = Math.max(-1, Math.min(1, _fwd.dot(_autopilotTarget)));
          const angle = Math.acos(dot);
          if (angle > 1e-4) {
            const maxStep = transitDriveBuffer.desiredForwardRateRadPerS * FIXED_DT;
            const step = Math.min(angle, maxStep);
            _autopilotAxis.crossVectors(_fwd, _autopilotTarget);
            if (_autopilotAxis.lengthSq() > 1e-12) {
              _autopilotAxis.normalize();
              _quat.setFromAxisAngle(_autopilotAxis, step);
              simQuat.current.premultiply(_quat);
              simQuat.current.normalize();
              // Recompute forward after override.
              _fwd.set(0, 0, 1).applyQuaternion(simQuat.current);
            }
            // Kill residual angular velocity so autopilot holds the heading.
            yawRate.current *= 0.5;
            pitchRate.current *= 0.5;
          }
        }
      }

      // Speed — apply acceleration/deceleration modifiers from modules
      const cfg = store.get(effectiveShipConfigAtom);
      const isAccelerating = movement.speed > speed.current;
      const responseMult = isAccelerating ? cfg.accelerationMult : cfg.decelerationMult;
      const baseAlpha = 1 - Math.pow(0.99, FIXED_DT * 60);
      const speedAlpha = Math.min(1, baseAlpha * responseMult);
      speed.current = lerp(speed.current, movement.speed, speedAlpha);

      // Velocity — max speed scaled by module modifier (with optional dev override)
      const devSpeed = store.get(devMaxSpeedOverrideAtom);
      const maxSpeedKmps = devSpeed !== null
        ? devSpeed / 1000                       // dev override is absolute — skip speedMult
        : SHIP_MAX_SPEED_KMPS * cfg.speedMult;  // normal: base * module multiplier
      _vel.copy(_fwd).multiplyScalar(maxSpeedKmps * speed.current * FIXED_DT);

      posKm.current.add(_vel);

      // ── Transit drive velocity (additive, independent of normal flight) ──
      const tBuf = transitDriveBuffer;
      _transitVel.set(tBuf.velocityKmps.x, tBuf.velocityKmps.y, tBuf.velocityKmps.z);
      if (_transitVel.lengthSq() > 0) {
        _transitVel.multiplyScalar(FIXED_DT);
        posKm.current.add(_transitVel);
      }

      // ── Continuous celestial-body collision (swept segment-vs-sphere) ──
      // Transit can push the ship >100,000 km per step; a point test would
      // tunnel through planets between frames. Sweep from prev-step position
      // to this-step position and trigger death at the entry point.
      if (celestialColliders.length > 0) {
        const hit = sweptSphereCollide(
          prevPosKm.current.x, prevPosKm.current.y, prevPosKm.current.z,
          posKm.current.x, posKm.current.y, posKm.current.z,
          celestialColliders,
          SHIP_HULL_RADIUS_KM,
        );
        if (hit) {
          // Clamp the ship to the entry point so it never visually penetrates.
          posKm.current.set(
            prevPosKm.current.x + (posKm.current.x - prevPosKm.current.x) * hit.t,
            prevPosKm.current.y + (posKm.current.y - prevPosKm.current.y) * hit.t,
            prevPosKm.current.z + (posKm.current.z - prevPosKm.current.z) * hit.t,
          );

          // Kill the transit drive immediately so deceleration doesn't keep
          // shoving velocity into the body after impact.
          transitDriveBuffer.velocityKmps = { x: 0, y: 0, z: 0 };
          transitDriveBuffer.phase = "idle";
          transitDriveBuffer.spoolAccS = 0;
          transitDriveBuffer.autopilot = false;

          store.set(shipHealthAtom, 0);
          store.set(spawnVFXEventAtom, {
            type: "collision",
            position: [0, 0, 0],
            radiusM: 120,
          });
          const cargo = store.get(cargoAtom);
          store.set(dieAtom, {
            positionKm: [posKm.current.x, posKm.current.y, posKm.current.z],
            cargoItems: cargo.items,
          });

          // Stop further substeps this frame; the top-of-frame dead gate
          // will handle subsequent frames.
          physicsAcc.current = 0;
          break;
        }
      }

      // Write ship forward direction + position to transit buffer
      // so TransitTicker can compute acceleration direction and flip point.
      // _fwd was computed earlier this tick from simQuat.
      tBuf.shipForward = { x: _fwd.x, y: _fwd.y, z: _fwd.z };
      tBuf.shipPosKm = { x: posKm.current.x, y: posKm.current.y, z: posKm.current.z };

      physicsAcc.current -= FIXED_DT;
    }

    // ── Engine exhaust intensity (thrust demand) ──────────────────────
    // Proportional to how much the engines need to push: the gap between
    // the pilot's requested speed and the current speed. Negative values
    // (decelerating / coasting) produce no thrust — this is space.
    {
      const thrustDemand = Math.max(0, movement.speed - speed.current);
      // Smooth toward target so the plume doesn't snap on/off
      exhaustIntensity.current += (thrustDemand - exhaustIntensity.current)
        * Math.min(1, EXHAUST_SMOOTH_RATE * delta);
      if (exhaustIntensity.current < 0.001) exhaustIntensity.current = 0;
    }

    // ── Interpolation ──────────────────────────────────────────────────
    // alpha ∈ [0,1) — how far between prev and current the render instant is.
    const alpha = physicsAcc.current / FIXED_DT;

    // Quaternion
    shipRef.current.quaternion.slerpQuaternions(
      prevQuat.current,
      simQuat.current,
      alpha
    );

    // Position: interpolate in km, then move the world origin to the
    // interpolated position so the ship always sits at local (0,0,0).
    // This prevents float32 precision jitter in the GPU transform pipeline
    // when the ship has drifted far from the previous origin.
    _localRel.lerpVectors(prevPosKm.current, posKm.current, alpha);
    worldOrigin.setShipPosKm(posKm.current);
    worldOrigin.setWorldOriginKm(_localRel);
    shipRef.current.position.set(0, 0, 0);

    // Model visual tilt (interpolated)
    const renderRoll = prevVRoll.current + (vRoll.current - prevVRoll.current) * alpha;
    const renderPitch = prevVPitch.current + (vPitch.current - prevVPitch.current) * alpha;
    modelRef.current.rotation.set(
      renderPitch,
      modelRef.current.rotation.y,
      renderRoll
    );

    // ── Camera ─────────────────────────────────────────────────────────
    _fwd.set(0, 0, 1).applyQuaternion(shipRef.current.quaternion);
    _offset.copy(_cameraOffset).applyQuaternion(shipRef.current.quaternion);
    _offset.add(_fwd.normalize().multiplyScalar(speed.current * 0.75 + 1));

    camera.position.copy(shipRef.current.position).sub(_offset);
    camera.quaternion.copy(shipRef.current.quaternion).multiply(_rotationQuat);

    // ── Camera shake (applied on top of chase-cam) ─────────────────────
    // Consume new shake trigger
    const shakeSignal = store.get(cameraShakeIntensityAtom);
    if (shakeSignal > 0) {
      shakeIntensity.current = Math.min(1, shakeIntensity.current + shakeSignal);
      store.set(cameraShakeIntensityAtom, 0);
    }

    if (shakeIntensity.current > 0.001) {
      const s = shakeIntensity.current;

      // Pseudo-random offsets using sin with high-frequency time seeding
      const t = performance.now() * 0.001;
      const ox = Math.sin(t * 37.7 + 1.3) * Math.cos(t * 23.1);
      const oy = Math.sin(t * 41.3 + 2.7) * Math.cos(t * 29.7);
      const oz = Math.sin(t * 31.1 + 4.1) * Math.cos(t * 19.3);

      _shakeOffset.set(
        ox * SHAKE_MAX_OFFSET * s,
        oy * SHAKE_MAX_OFFSET * s,
        oz * SHAKE_MAX_OFFSET * 0.3 * s
      ).applyQuaternion(shipRef.current.quaternion);
      camera.position.add(_shakeOffset);

      // Small rotation shake
      const ry = Math.sin(t * 43.7 + 0.5) * SHAKE_MAX_ANGLE * s;
      const rp = Math.sin(t * 47.3 + 3.2) * SHAKE_MAX_ANGLE * s;
      _shakeEuler.setFromAxisAngle(_yAxis, ry);
      camera.quaternion.multiply(_shakeEuler);
      _shakeEuler.setFromAxisAngle(_xAxis, rp);
      camera.quaternion.multiply(_shakeEuler);

      // Exponential decay
      shakeIntensity.current *= Math.exp(-SHAKE_DECAY_RATE * delta);
    }

    // ── HUD speed (analytical — no sampling jitter) ─────────────────────
    // Must include cfg.speedMult so the HUD reflects module-boosted top speed.
    const hudCfg = store.get(effectiveShipConfigAtom);
    const hudDevSpeed = store.get(devMaxSpeedOverrideAtom);
    const hudMaxSpeedKmps = hudDevSpeed !== null
      ? hudDevSpeed / 1000
      : SHIP_MAX_SPEED_KMPS * hudCfg.speedMult;
    // During transit, show transit velocity (much larger) instead of normal flight speed.
    const transitSpeedMps = _transitVel.length() > 0
      ? Math.sqrt(
          transitDriveBuffer.velocityKmps.x ** 2 +
          transitDriveBuffer.velocityKmps.y ** 2 +
          transitDriveBuffer.velocityKmps.z ** 2
        ) * 1000 // km/s → m/s
      : 0;
    const normalSpeedMps = speed.current * hudMaxSpeedKmps * 1000;
    store.set(hudInfoAtom, { speed: Math.max(normalSpeedMps, transitSpeedMps) });

    // ── Periodic persist ──────────────────────────────────────────────
    persistAcc.current += delta;
    if (persistAcc.current >= PERSIST_INTERVAL) {
      persistAcc.current = 0;
      saveShipState(posKm.current, simQuat.current);
    }
  });

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
