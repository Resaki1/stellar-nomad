// ---------------------------------------------------------------------------
// TransitTicker — real-physics transit drive.
//
// Runs inside <Canvas> useFrame. Manages drive phases, velocity integration,
// and writes to the shared transitDriveBuffer that Spaceship.tsx reads.
// ---------------------------------------------------------------------------
"use client";

import { useFrame } from "@react-three/fiber";
import { useStore } from "jotai";
import { useMemo } from "react";
import { Vector3 } from "three";

import {
  transitStateAtom,
  transitDriveBuffer,
  transitDriveOwnedAtom,
  targetedPOIAtom,
  TRANSIT_ACCEL_KMPS2,
  TRANSIT_SPOOL_TIME_S,
} from "@/store/transit";
import { settingsIsOpenAtom, movementAtom } from "@/store/store";
import { miningStateAtom } from "@/store/mining";
import { addToastAtom } from "@/store/toast";
import { systemConfigAtom } from "@/store/system";

// Reusable temp vectors — zero allocation in hot path.
const _vel = new Vector3();
const _accel = new Vector3();
const _toTarget = new Vector3();
const _shipPos = new Vector3();

/** When velocity drops below this during decel, drive disengages (km/s). */
const DISENGAGE_SPEED = 0.5;

/** Max frame delta to prevent time-jump explosions. */
const MAX_DT = 0.1;

/** Autopilot rotation rate during acceleration (tight correction). */
const AUTOPILOT_ACCEL_ROT_RATE = 3.0; // rad/s

/** High slerp rate used while the spool-phase lerp drives the desired direction.
 *  This must exceed the fastest rate at which the interpolated direction changes
 *  so the ship closely tracks the interpolated heading. */
const SPOOL_TRACKING_ROT_RATE = 4.0; // rad/s

/** Deadzone for manual steering during autopilot. Any yaw/pitch input above
 *  this magnitude is treated as a deliberate "take over" and aborts autopilot. */
const AUTOPILOT_ABORT_INPUT_THRESHOLD = 0.2;

// ── Proximity auto-brake (predictive collision avoidance) ──────────────
// Realistic flip-and-burn: decel distance = v² / (2a). The drive MUST begin
// braking while still far enough out to stop before entering the safety
// sphere around any celestial body, or else the swept-collision CCD will
// kill the ship. Auto-brake watches every body ahead of the velocity vector
// and triggers a decel phase as soon as the remaining distance to entry
// equals (or slightly exceeds) the current brake distance.

/** Fraction of body radius added as safety standoff (atmosphere/corona margin). */
const AUTO_BRAKE_STANDOFF_FRAC = 0.02;
/** Absolute floor for the standoff — stops ~200 km above surface at minimum. */
const AUTO_BRAKE_MIN_STANDOFF_KM = 200;
/** Multiplier on brake distance to absorb frame jitter and fp error. 1.0 = exact. */
const AUTO_BRAKE_SAFETY_FACTOR = 1.03;

// Reusable temps for rotation math.
const _desired = new Vector3();
const _velDir = new Vector3();
const _autopilotAimStart = new Vector3();
const _autopilotAimEnd = new Vector3();

/**
 * Slerp between two unit direction vectors and write the result to `out`.
 * Handles parallel/anti-parallel edge cases.
 */
function slerpDirection(from: Vector3, to: Vector3, t: number, out: Vector3) {
  const dot = Math.max(-1, Math.min(1, from.dot(to)));
  if (dot > 0.9999) {
    out.copy(to);
    return;
  }
  const angle = Math.acos(dot);
  const sinA = Math.sin(angle);
  if (sinA < 1e-6) {
    out.copy(to);
    return;
  }
  const a = Math.sin((1 - t) * angle) / sinA;
  const b = Math.sin(t * angle) / sinA;
  out.set(
    from.x * a + to.x * b,
    from.y * a + to.y * b,
    from.z * a + to.z * b,
  );
  out.normalize();
}

type BrakeCollider = {
  id: string;
  x: number;
  y: number;
  z: number;
  /** Body radius + safety standoff (km). */
  safeR: number;
};

export default function TransitTicker() {
  const store = useStore();

  // Flat-numeric collider list, built once. Each collider's radius is already
  // inflated with the auto-brake standoff so the inner loop stays branchless.
  const brakeColliders = useMemo<BrakeCollider[]>(() => {
    const system = store.get(systemConfigAtom);
    const bodies = system.celestialBodies ?? [];
    return bodies.map((b) => {
      const standoff = Math.max(
        b.radiusKm * AUTO_BRAKE_STANDOFF_FRAC,
        AUTO_BRAKE_MIN_STANDOFF_KM,
      );
      return {
        id: b.id,
        x: b.positionKm[0],
        y: b.positionKm[1],
        z: b.positionKm[2],
        safeR: b.radiusKm + standoff,
      };
    });
    // systemConfigAtom is effectively static in the current codebase.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useFrame((_, delta) => {
    // Don't tick while paused.
    if (store.get(settingsIsOpenAtom)) return;

    const buf = transitDriveBuffer;
    const owned = store.get(transitDriveOwnedAtom);

    // ── Gate: drive not owned or dead ────────────────────────────────
    if (!owned) {
      if (buf.phase !== "idle") {
        buf.phase = "idle";
        buf.velocityKmps = { x: 0, y: 0, z: 0 };
        buf.spoolAccS = 0;
        buf.desiredForward = null;
        buf.desiredForwardRateRadPerS = 0;
        store.set(transitStateAtom, {
          phase: "idle",
          spoolProgress: 0,
          velocityKmps: 0,
          peakVelocityKmps: 0,
          target: null,
          distanceToTargetKm: null,
          etaS: null,
        });
      }
      return;
    }

    // Don't tick during mining.
    const mining = store.get(miningStateAtom);
    if (mining.isMining && buf.phase === "idle") return;

    // Cap frame delta to prevent time-jump after tab-away.
    const dt = Math.min(delta, MAX_DT);

    const prevPhase = buf.phase;

    // ── Phase logic (mutually exclusive per frame) ─────────────────────
    if (buf.phase === "idle") {
      // IDLE → SPOOLING
      if (buf.keyHeld) {
        buf.phase = "spooling";
        buf.spoolAccS = 0;

        // Snapshot ship forward so we can smoothly lerp the auto-align.
        if (buf.shipForward) {
          buf.spoolStartForward = { ...buf.shipForward };
        }

        // Snapshot target at spool start, with celestial-body arrival offset.
        const target = store.get(targetedPOIAtom);
        if (target && buf.shipPosKm) {
          buf.autopilot = true;
          const tx = target.positionKm[0];
          const ty = target.positionKm[1];
          const tz = target.positionKm[2];
          const offset = target.arrivalOffsetKm ?? 0;
          if (offset > 0) {
            // Arrive at a point `offset` km from the body center, on the
            // approach side (line between ship and body).
            const dx = buf.shipPosKm.x - tx;
            const dy = buf.shipPosKm.y - ty;
            const dz = buf.shipPosKm.z - tz;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (dist > offset) {
              const k = offset / dist;
              buf.autopilotTargetKm = {
                x: tx + dx * k,
                y: ty + dy * k,
                z: tz + dz * k,
              };
            } else {
              // Already closer than offset — just use body center.
              buf.autopilotTargetKm = { x: tx, y: ty, z: tz };
            }
          } else {
            buf.autopilotTargetKm = { x: tx, y: ty, z: tz };
          }
        } else {
          buf.autopilot = false;
        }
      }
    } else if (buf.phase === "spooling") {
      // SPOOLING
      if (!buf.keyHeld) {
        // Released key during spool -- cancel.
        buf.phase = "idle";
        buf.spoolAccS = 0;
      } else {
        buf.spoolAccS += dt;
        if (buf.spoolAccS >= TRANSIT_SPOOL_TIME_S) {
          // Spool complete -- engage drive.
          buf.phase = "accelerating";
          buf.spoolAccS = TRANSIT_SPOOL_TIME_S;
        }
      }

      // Autopilot: smooth auto-align over the spool duration.
      // Interpolate between the snapshotted start-forward and the current
      // target-forward with a smoothstep ease. The Spaceship slerps the
      // ship toward this desired direction each tick, so the rotation
      // completes as the spool finishes.
      if (buf.autopilot && buf.shipPosKm && buf.spoolStartForward) {
        _autopilotAimEnd.set(
          buf.autopilotTargetKm.x - buf.shipPosKm.x,
          buf.autopilotTargetKm.y - buf.shipPosKm.y,
          buf.autopilotTargetKm.z - buf.shipPosKm.z,
        );
        if (_autopilotAimEnd.lengthSq() > 0) {
          _autopilotAimEnd.normalize();

          _autopilotAimStart.set(
            buf.spoolStartForward.x,
            buf.spoolStartForward.y,
            buf.spoolStartForward.z,
          );

          const tRaw = Math.min(1, buf.spoolAccS / TRANSIT_SPOOL_TIME_S);
          // Smoothstep ease-in-out: 3t^2 - 2t^3
          const t = tRaw * tRaw * (3 - 2 * tRaw);

          // Slerp between start and end directions.
          slerpDirection(_autopilotAimStart, _autopilotAimEnd, t, _desired);
          buf.desiredForward = { x: _desired.x, y: _desired.y, z: _desired.z };
          buf.desiredForwardRateRadPerS = SPOOL_TRACKING_ROT_RATE;
        }
      }
    } else if (buf.phase === "accelerating") {
      // ACCELERATING.
      // Autopilot abort: deliberate steering input takes over. Clears autopilot
      // and posts a toast so the player knows why the target readout disappeared.
      if (buf.autopilot) {
        const movement = store.get(movementAtom);
        const steerInput = Math.max(Math.abs(movement.yaw), Math.abs(movement.pitch));
        if (steerInput > AUTOPILOT_ABORT_INPUT_THRESHOLD) {
          buf.autopilot = false;
          buf.desiredForward = null;
          buf.desiredForwardRateRadPerS = 0;
          store.set(targetedPOIAtom, null);
          store.set(addToastAtom, {
            message: "AUTOPILOT DISENGAGED",
            detail: "Manual control active",
            durationMs: 3000,
          });
        }
      }

      // Design note: during transit, velocity DIRECTION always tracks ship forward.
      // This makes steering feel identical to normal flight (turn the ship →
      // momentum turns with it). Realism is sacrificed for playability —
      // handwaved as the drive's inertial compensation redirecting thrust.
      // Magnitude is still integrated from real acceleration.
      _velDir.set(buf.shipForward?.x ?? 0, buf.shipForward?.y ?? 0, buf.shipForward?.z ?? 0);
      if (_velDir.lengthSq() < 0.001) _velDir.set(0, 0, 1);
      _velDir.normalize();

      // Current speed magnitude, plus one tick of acceleration.
      _vel.set(buf.velocityKmps.x, buf.velocityKmps.y, buf.velocityKmps.z);
      const newSpeed = _vel.length() + TRANSIT_ACCEL_KMPS2 * dt;
      _vel.copy(_velDir).multiplyScalar(newSpeed);

      if (buf.autopilot && buf.shipPosKm) {
        // Autopilot: keep ship aimed at target for continuous course correction.
        _desired.set(
          buf.autopilotTargetKm.x - buf.shipPosKm.x,
          buf.autopilotTargetKm.y - buf.shipPosKm.y,
          buf.autopilotTargetKm.z - buf.shipPosKm.z,
        );
        if (_desired.lengthSq() > 0) {
          _desired.normalize();
          buf.desiredForward = { x: _desired.x, y: _desired.y, z: _desired.z };
          buf.desiredForwardRateRadPerS = AUTOPILOT_ACCEL_ROT_RATE;
        }
      } else {
        // Manual mode — no autopilot override on rotation.
        buf.desiredForward = null;
        buf.desiredForwardRateRadPerS = 0;
      }

      buf.velocityKmps = { x: _vel.x, y: _vel.y, z: _vel.z };

      // ── Proximity auto-brake ─────────────────────────────────────────
      // Scan every celestial body in front of the ship; if the remaining
      // distance to the entry of its safety sphere is ≤ our brake distance
      // (plus a small safety factor), force deceleration now. Skips the
      // current autopilot target, whose own flip logic runs below.
      if (buf.shipPosKm) {
        const speed = _vel.length();
        if (speed > 0) {
          const brakeDistKm = (speed * speed) / (2 * TRANSIT_ACCEL_KMPS2);
          const triggerDistKm = brakeDistKm * AUTO_BRAKE_SAFETY_FACTOR;
          const target = store.get(targetedPOIAtom);
          // POIProjector prefixes celestial-body POI IDs with "body:" — match
          // that form when skipping the autopilot target here.
          const targetBodyId =
            target?.id && target.id.startsWith("body:")
              ? target.id.slice(5)
              : null;

          const vdx = _vel.x / speed;
          const vdy = _vel.y / speed;
          const vdz = _vel.z / speed;
          const sx = buf.shipPosKm.x;
          const sy = buf.shipPosKm.y;
          const sz = buf.shipPosKm.z;

          for (let i = 0; i < brakeColliders.length; i++) {
            const c = brakeColliders[i];
            if (c.id === targetBodyId) continue; // autopilot handles its target

            const tx = c.x - sx;
            const ty = c.y - sy;
            const tz = c.z - sz;
            const along = tx * vdx + ty * vdy + tz * vdz;
            if (along <= 0) continue; // behind the ship

            const distSq = tx * tx + ty * ty + tz * tz;
            const perpSq = distSq - along * along;
            const safeSq = c.safeR * c.safeR;
            if (perpSq > safeSq) continue; // trajectory misses the safety sphere

            // Distance along velocity to the entry of the safety sphere.
            const entryDist = along - Math.sqrt(safeSq - perpSq);
            if (entryDist <= triggerDistKm) {
              buf.phase = "decelerating";
              store.set(addToastAtom, {
                message: "TRANSIT DISENGAGED",
                detail: `Proximity: ${c.id.toUpperCase()}`,
                durationMs: 3000,
              });
              break;
            }
          }
        }
      }

      // Check autopilot flip point.
      if (buf.autopilot && buf.shipPosKm) {
        _shipPos.set(buf.shipPosKm.x, buf.shipPosKm.y, buf.shipPosKm.z);
        _toTarget.set(
          buf.autopilotTargetKm.x - _shipPos.x,
          buf.autopilotTargetKm.y - _shipPos.y,
          buf.autopilotTargetKm.z - _shipPos.z,
        );
        const distKm = _toTarget.length();
        const speed = _vel.length();

        // Deceleration distance: d = v^2 / (2a)
        const decelDistKm = (speed * speed) / (2 * TRANSIT_ACCEL_KMPS2);

        if (decelDistKm >= distKm) {
          // Time to flip -- begin deceleration.
          buf.phase = "decelerating";
        }
      }

      // Manual deceleration trigger (tap T while accelerating).
      if (buf.keyTapped) {
        buf.phase = "decelerating";
        buf.keyTapped = false;
      }
    } else if (buf.phase === "decelerating") {
      // DECELERATING — thrust opposite to velocity. Clear any orientation override.
      buf.desiredForward = null;
      buf.desiredForwardRateRadPerS = 0;

      _vel.set(buf.velocityKmps.x, buf.velocityKmps.y, buf.velocityKmps.z);
      const speed = _vel.length();

      if (speed < DISENGAGE_SPEED) {
        // Drive disengages — velocity is now negligible.
        buf.velocityKmps = { x: 0, y: 0, z: 0 };
        buf.phase = "idle";
        buf.spoolAccS = 0;
        buf.autopilot = false;
      } else {
        // Decelerate opposite to current velocity.
        const decelMag = TRANSIT_ACCEL_KMPS2 * dt;
        _accel.copy(_vel).normalize().multiplyScalar(-decelMag);
        _vel.add(_accel);

        // Check for overshoot (velocity reversed direction).
        if (_vel.dot(_accel) > 0) {
          // Decelerated past zero — clamp.
          buf.velocityKmps = { x: 0, y: 0, z: 0 };
          buf.phase = "idle";
          buf.spoolAccS = 0;
          buf.autopilot = false;
        } else {
          buf.velocityKmps = { x: _vel.x, y: _vel.y, z: _vel.z };
        }
      }

      // Allow re-engaging acceleration if player taps T during decel.
      if (buf.keyTapped && buf.phase === "decelerating") {
        buf.phase = "accelerating";
        buf.keyTapped = false;
      }
    }

    // Consume any remaining tap.
    buf.keyTapped = false;

    // Clear orientation override whenever we're not actively steering the ship.
    if (buf.phase === "idle" || buf.phase === "decelerating") {
      buf.desiredForward = null;
      buf.desiredForwardRateRadPerS = 0;
    }
    if (buf.phase !== "spooling") {
      buf.spoolStartForward = null;
    }

    // ── Update atom for HUD (ONLY on phase transitions or target change) ──
    // Hot-path values (velocity, ETA, spool progress) are read from the
    // buffer via rAF in TransitHUD, so we don't need per-frame atom writes.
    const prevState = store.get(transitStateAtom);
    const newPhase = buf.phase;
    const target = buf.autopilot ? (store.get(targetedPOIAtom) ?? prevState.target) : null;

    if (newPhase !== prevState.phase || target?.id !== prevState.target?.id) {
      store.set(transitStateAtom, {
        phase: newPhase,
        spoolProgress: Math.min(1, buf.spoolAccS / TRANSIT_SPOOL_TIME_S),
        velocityKmps: 0, // unused — HUD reads from buffer
        peakVelocityKmps: 0, // unused — HUD reads from buffer
        target,
        distanceToTargetKm: null, // unused — HUD computes from buffer
        etaS: null, // unused — HUD computes from buffer
      });
    }

    // ── Autopilot arrival check ──────────────────────────────────────
    if (buf.autopilot && buf.phase === "idle" && prevPhase !== "idle") {
      // Just disengaged — clear autopilot state.
      buf.autopilot = false;
    }
  });

  return null;
}
