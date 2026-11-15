/**
 * Mouse → playerInput (docs/FLIGHT_MODEL_PLAN.md §2): mode A virtual stick, mode B aim, free look.
 * Movement accumulates per event (`addMouseDelta`) and is consumed once per frame (`updateMouseSteering`).
 */
import { Vector3, type Quaternion } from "three";
import { aimRateCommand, clampToCone, fromBody, toBody, type AimCommand, type BodyDir } from "@/sim/ship/aimController";
import { getFlightTuning } from "@/sim/ship/flightTuning";
import { getCameraTuning } from "@/components/Camera/cameraTuning";
import { DEFAULT_MOUSE_SETTINGS, type MouseSettings } from "@/store/mouseSettings";
import { cameraProbe } from "@/components/Camera/chaseCamera";
import { getAppPhase } from "@/components/AppShell/appState";
import { playerInput } from "./playerInput";
import { isCursorNeeded, isPointerLocked, onSteeringRelease } from "./pointerLock";

/** Mouse travel from centre to full stick deflection at sensitivity 1, CSS px. */
export const STICK_TRAVEL_PX = 400;
export const STICK_CURVE = 1.5;
/** Aim marker turn per CSS px at sensitivity 1. */
export const AIM_DEG_PER_PX = 0.05;
const AUTO_CENTRE_S = 0.3;
const DEG = Math.PI / 180;

/** Live device preferences (Settings → Controls), copied in by MouseControls. */
export const mouseConfig: MouseSettings = { ...DEFAULT_MOUSE_SETTINGS };

export const mouseState = {
  attached: false,
  pendingDx: 0,
  pendingDy: 0,
  /** Stick marker in the unit circle, +x right, +y up (physical mouse direction, before inversion). */
  stickX: 0,
  stickY: 0,
  /** Mode B aim direction (frame axes, unit) and whether it has been seeded from the nose. */
  aim: new Vector3(0, 0, 1),
  aimValid: false,
  /** Test override for the free-look key: null = follow the key. */
  freeLookForced: null as boolean | null,
  freeLook: false,
  /** False after a reset, so the next free-look frame re-seeds the orbit from the rig instead of jumping. */
  freeLookSeeded: false,
  /** Free-look orbit target, radians (+yaw right, +pitch up). */
  freeLookYaw: 0,
  freeLookPitch: 0,
};

const _body: BodyDir = { f: 0, r: 0, u: 0 };
const _cmd: AimCommand = { pitch: 0, yaw: 0 };
const _resp = { x: 0, y: 0 };
const NOSE: BodyDir = { f: 1, r: 0, u: 0 };

export function addMouseDelta(dx: number, dy: number): void {
  // The lock is held through loading; motion under the overlay must not steer at the gate.
  if (isCursorNeeded() || getAppPhase() !== "playing") return;
  mouseState.pendingDx += dx;
  mouseState.pendingDy += dy;
}

/** Centre the stick and drop the aim marker (re-seeded on the nose next frame). */
export function resetMouseSteering(): void {
  const s = mouseState;
  s.pendingDx = 0;
  s.pendingDy = 0;
  s.stickX = 0;
  s.stickY = 0;
  s.aimValid = false;
  s.freeLookYaw = 0;
  s.freeLookPitch = 0;
  s.freeLookSeeded = false;
  playerInput.mouseYaw = 0;
  playerInput.mousePitch = 0;
  playerInput.aimYaw = 0;
  playerInput.aimPitch = 0;
}

/** Stick position → command: radial deadzone, then |r|^curve. */
export function stickResponse(out: { x: number; y: number }, x: number, y: number, deadzone: number, curve = STICK_CURVE): { x: number; y: number } {
  const r = Math.hypot(x, y);
  if (r <= deadzone || r === 0) {
    out.x = 0;
    out.y = 0;
    return out;
  }
  const k = Math.pow(Math.min(1, (r - deadzone) / (1 - deadzone)), curve) / r;
  out.x = x * k;
  out.y = y * k;
  return out;
}

const clamp = (v: number, lim: number): number => (v > lim ? lim : v < -lim ? -lim : v);

/**
 * Once per frame, before sampleShipInput. `q` is the ship's sim orientation. `autopilot`: something
 * else owns the heading, so the aim marker rides the nose instead of pulling back.
 */
export function updateMouseSteering(q: Quaternion, dt: number, autopilot = false): void {
  const s = mouseState;
  const c = mouseConfig;
  const dx = s.pendingDx;
  const dy = s.pendingDy;
  s.pendingDx = 0;
  s.pendingDy = 0;
  const sens = c.sensitivity;
  s.freeLook = s.freeLookForced ?? playerInput.held.freeLook;

  if (s.freeLook) {
    const ct = getCameraTuning();
    const k = ct.freeLookDegPerPx * sens * DEG;
    if (!s.freeLookSeeded) {
      // Continue from wherever the rig's orbit is (mid-return or after a reset), never jump.
      s.freeLookYaw = cameraProbe.orbitDeg[0] * DEG;
      s.freeLookPitch = cameraProbe.orbitDeg[1] * DEG;
      s.freeLookSeeded = true;
    }
    s.freeLookYaw += dx * k;
    s.freeLookPitch = clamp(s.freeLookPitch - dy * k, ct.freeLookPitchMaxDeg * DEG);
    s.stickX = 0;
    s.stickY = 0;
    s.aimValid = false;
    playerInput.mouseYaw = 0;
    playerInput.mousePitch = 0;
    playerInput.aimYaw = 0;
    playerInput.aimPitch = 0;
    return;
  }
  s.freeLookYaw = 0;
  s.freeLookPitch = 0;
  s.freeLookSeeded = false;

  if (c.mode === "stick") {
    s.aimValid = false;
    playerInput.aimYaw = 0;
    playerInput.aimPitch = 0;
    // Autopilot owns the heading: a stick left off-centre must not abort it, only fresh motion.
    if (autopilot) s.stickX = s.stickY = 0;
    s.stickX += (dx * sens) / STICK_TRAVEL_PX;
    s.stickY -= (dy * sens) / STICK_TRAVEL_PX;
    const r = Math.hypot(s.stickX, s.stickY);
    if (r > 1) {
      s.stickX /= r;
      s.stickY /= r;
    }
    if (c.autoCentre && dx === 0 && dy === 0) {
      const decay = Math.exp(-dt / AUTO_CENTRE_S);
      s.stickX *= decay;
      s.stickY *= decay;
      if (Math.hypot(s.stickX, s.stickY) < 1e-4) s.stickX = s.stickY = 0;
    }
    stickResponse(_resp, s.stickX, s.stickY, c.deadzone);
    playerInput.mouseYaw = _resp.x;
    playerInput.mousePitch = _resp.y;
    return;
  }

  // Mode B: the marker is a fixed direction in space; mouse motion turns it in the ship's axes.
  s.stickX = 0;
  s.stickY = 0;
  playerInput.mouseYaw = 0;
  playerInput.mousePitch = 0;
  // Held arrow keys override aim mode: the marker rides the nose so the two never fight.
  const h = playerInput.held;
  if (autopilot || h.pitchUp || h.pitchDown || h.yawLeft || h.yawRight) {
    fromBody(s.aim, q, NOSE);
    s.aimValid = true;
    playerInput.aimYaw = 0;
    playerInput.aimPitch = 0;
    return;
  }
  if (!s.aimValid) {
    fromBody(s.aim, q, NOSE);
    s.aimValid = true;
  }
  toBody(_body, q, s.aim.x, s.aim.y, s.aim.z);
  if (dx !== 0 || dy !== 0) {
    const k = AIM_DEG_PER_PX * sens * DEG;
    const yaw = dx * k;
    const pitch = (playerInput.invertPitch ? dy : -dy) * k;
    const f1 = _body.f * Math.cos(yaw) - _body.r * Math.sin(yaw);
    _body.r = _body.r * Math.cos(yaw) + _body.f * Math.sin(yaw);
    const h = Math.hypot(f1, _body.r);
    // Pitch in the vertical plane containing the marker, so yaw and pitch stay independent.
    const elev = Math.atan2(_body.u, h) + pitch;
    const hs = h > 1e-9 ? Math.cos(elev) / h : 0;
    _body.f = h > 1e-9 ? f1 * hs : Math.cos(elev);
    _body.r *= hs;
    _body.u = Math.sin(elev);
  }
  clampToCone(_body);
  fromBody(s.aim, q, _body);
  aimRateCommand(_cmd, _body, getFlightTuning(), dt);
  playerInput.aimYaw = _cmd.yaw;
  playerInput.aimPitch = _cmd.pitch;
}

export interface MouseDevice {
  detach(): void;
}

/** Desktop only. Movement counts only while the pointer is locked (or injected by the test harness). */
export function attachMouse(): MouseDevice {
  const onMove = (e: MouseEvent): void => {
    if (isPointerLocked()) addMouseDelta(e.movementX, e.movementY);
  };
  document.addEventListener("mousemove", onMove);
  const offRelease = onSteeringRelease(resetMouseSteering);
  mouseState.attached = true;
  return {
    detach() {
      document.removeEventListener("mousemove", onMove);
      offRelease();
      mouseState.attached = false;
      resetMouseSteering();
    },
  };
}
