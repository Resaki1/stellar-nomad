import { logLimit } from "@/helpers/math";
import { useFrame } from "@react-three/fiber";
import { memo, useEffect, useRef } from "react";
import { Quaternion, Vector3, Mesh, MathUtils } from "three";
import { ShipOne } from "./models/ships/ShipOne";
import { lerp } from "three/src/math/MathUtils.js";
import { useStore } from "jotai";
import { hudInfoAtom, movementAtom } from "@/store/store";
import { collisionImpactAtom } from "@/store/vfx";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { toLocalUnitsKm } from "@/sim/units";
import { loadShipState, saveShipState } from "@/sim/shipPersistence";

// ── Module-level temps (reused every frame, never GC'd) ──────────────
const _quat = new Quaternion();
const _xAxis = new Vector3(1, 0, 0);
const _yAxis = new Vector3(0, 1, 0);
const _fwd = new Vector3();
const _cameraOffset = new Vector3(0, -4, 10);
const _offset = new Vector3();
const _rotationQuat = new Quaternion().setFromAxisAngle(_yAxis, Math.PI);
const _vel = new Vector3();
const _localRel = new Vector3();

// ── Tuning constants ─────────────────────────────────────────────────
const SHIP_HANDLING = 1.5;
const MAX_ROT_SPEED = SHIP_HANDLING / 2;
const SHIP_MAX_SPEED_KMPS = 400 / 1000;
const COLLISION_SPEED_DIP_MIN = 0.15; // small asteroid: lose 15% speed
const COLLISION_SPEED_DIP_MAX = 0.65; // huge asteroid: lose 65% speed
const COLLISION_SIZE_REF_M = 200;     // radius at which dip reaches max
const PERSIST_INTERVAL = 2.0; // seconds between position saves

// ── Fixed-timestep physics ───────────────────────────────────────────
// Physics advances in fixed increments; rendering interpolates between
// the two most recent states. This eliminates micro-jitter caused by
// natural frame-time (delta) variation on the GPU/compositor side.
const FIXED_DT = 1 / 120;
const MAX_FRAME_DT = 0.05; // cap: prevents spiral-of-death after tab-away

const SpaceShip = memo(() => {
  const store = useStore();
  const worldOrigin = useWorldOrigin();
  const shipRef = useRef<Mesh>(null!);
  const modelRef = useRef<Mesh>(null!);

  // ── Simulation state (advanced at fixed FIXED_DT) ──────────────────
  const posKm = useRef(new Vector3());
  const simQuat = useRef(new Quaternion());
  const yawRate = useRef(0);
  const pitchRate = useRef(0);
  const vRoll = useRef(0);
  const vPitch = useRef(0);
  const speed = useRef(0);

  // ── Previous-step snapshot (for interpolation) ─────────────────────
  const prevPosKm = useRef(new Vector3());
  const prevQuat = useRef(new Quaternion());
  const prevVRoll = useRef(0);
  const prevVPitch = useRef(0);

  // ── Misc ────────────────────────────────────────────────────────────
  const physicsAcc = useRef(0);
  const persistAcc = useRef(0);

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
      // Sync world origin so camera / SimGroups don't jump
      worldOrigin.setShipPosKm(posKm.current);
      worldOrigin.setWorldOriginKm(posKm.current);
    }
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

  useFrame(({ camera }, delta) => {
    if (!shipRef.current || !modelRef.current) return;

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

    // ── Fixed-timestep physics loop ────────────────────────────────────
    physicsAcc.current += Math.min(delta, MAX_FRAME_DT);

    while (physicsAcc.current >= FIXED_DT) {
      // Snapshot previous state for interpolation.
      prevPosKm.current.copy(posKm.current);
      prevQuat.current.copy(simQuat.current);
      prevVRoll.current = vRoll.current;
      prevVPitch.current = vPitch.current;

      // Yaw
      if (movement.yaw) {
        vRoll.current = logLimit(
          vRoll.current + movement.yaw * SHIP_HANDLING * FIXED_DT,
          Math.PI / 6
        );
        yawRate.current = MathUtils.clamp(
          yawRate.current + movement.yaw * SHIP_HANDLING * FIXED_DT,
          -MAX_ROT_SPEED,
          MAX_ROT_SPEED
        );
      } else {
        vRoll.current = MathUtils.lerp(vRoll.current, 0, SHIP_HANDLING * FIXED_DT);
        yawRate.current -= yawRate.current * SHIP_HANDLING * FIXED_DT;
      }

      // Pitch
      if (movement.pitch) {
        vPitch.current = logLimit(
          vPitch.current + movement.pitch * SHIP_HANDLING * FIXED_DT,
          Math.PI / 6
        );
        pitchRate.current = MathUtils.clamp(
          pitchRate.current + movement.pitch * SHIP_HANDLING * FIXED_DT,
          -MAX_ROT_SPEED,
          MAX_ROT_SPEED
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

      // Speed
      const speedAlpha = 1 - Math.pow(0.99, FIXED_DT * 60);
      speed.current = lerp(speed.current, movement.speed, speedAlpha);

      // Velocity
      _vel.copy(_fwd).multiplyScalar(SHIP_MAX_SPEED_KMPS * speed.current * FIXED_DT);

      posKm.current.add(_vel);
      physicsAcc.current -= FIXED_DT;
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

    // Position (interpolate in km, then convert to local render units)
    _localRel.lerpVectors(prevPosKm.current, posKm.current, alpha);
    // Update world origin with the true (non-interpolated) sim position.
    worldOrigin.setShipPosKm(posKm.current);
    worldOrigin.maybeRecenter(posKm.current);
    _localRel.sub(worldOrigin.worldOriginKm);
    toLocalUnitsKm(_localRel, shipRef.current.position);

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

    // ── HUD speed (analytical — no sampling jitter) ─────────────────────
    store.set(hudInfoAtom, { speed: speed.current * SHIP_MAX_SPEED_KMPS * 1000 });

    // ── Periodic persist ──────────────────────────────────────────────
    persistAcc.current += delta;
    if (persistAcc.current >= PERSIST_INTERVAL) {
      persistAcc.current = 0;
      saveShipState(posKm.current, simQuat.current);
    }
  });

  return (
    <mesh ref={shipRef} name="playerShip">
      <ShipOne ref={modelRef} name="playerShipModel" />
    </mesh>
  );
});

SpaceShip.displayName = "SpaceShip";

export default SpaceShip;
