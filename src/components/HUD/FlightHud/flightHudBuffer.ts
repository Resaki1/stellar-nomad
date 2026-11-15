/**
 * Flight HUD markers drawn from the ship's frame (docs/FLIGHT_MODEL_PLAN.md §5): DOM transforms
 * through registered refs, never React state. Positions are CSS px in the viewport.
 */
import { Quaternion, Vector3, type PerspectiveCamera } from "three";
import { mouseConfig, mouseState } from "@/input/mouse";
import { isCursorNeeded, isPointerLocked } from "@/input/pointerLock";

/** Stick ring radius, CSS px (matches FlightHud.scss). */
export const STICK_RING_PX = 48;
/** Velocity marker appears when the velocity is this far off the nose, m/s. */
const DRIFT_SHOW_MPS = 2;

type Marker = { x: number; y: number; visible: boolean };
const marker = (): Marker => ({ x: 0, y: 0, visible: false });

export const flightHud = {
  els: {
    nose: null as HTMLElement | null,
    ring: null as HTMLElement | null,
    stick: null as HTMLElement | null,
    aim: null as HTMLElement | null,
    velocity: null as HTMLElement | null,
    hintFreeLook: null as HTMLElement | null,
    hintLock: null as HTMLElement | null,
  },
  /** Probe for the test harness (same numbers the DOM was given). */
  reticle: marker(),
  stick: marker(),
  aim: marker(),
  velocity: marker(),
  driftMps: 0,
  cameraQuat: [0, 0, 0, 1] as [number, number, number, number],
  shipQuat: [0, 0, 0, 1] as [number, number, number, number],
  fovDeg: 0,
  aspect: 1,
  viewport: [0, 0, 0, 0] as [number, number, number, number],
};

const _qInv = new Quaternion();
const _v = new Vector3();
const _fwd = new Vector3();
const _vel = new Vector3();

/** Direction (local scene axes) → viewport px through the camera; false when behind it. */
function projectDir(dir: Vector3, camera: PerspectiveCamera, vp: readonly number[], out: Marker): boolean {
  _v.copy(dir).applyQuaternion(_qInv);
  if (_v.z > -1e-6) {
    out.visible = false;
    return false;
  }
  const t = Math.tan((camera.fov * Math.PI) / 360) / camera.zoom;
  const nx = _v.x / -_v.z / (t * camera.aspect);
  const ny = _v.y / -_v.z / t;
  out.x = vp[0] + (nx * 0.5 + 0.5) * vp[2];
  out.y = vp[1] + (0.5 - ny * 0.5) * vp[3];
  out.visible = nx >= -1.2 && nx <= 1.2 && ny >= -1.2 && ny <= 1.2;
  return out.visible;
}

function show(el: HTMLElement | null, on: boolean): void {
  if (!el || (el.dataset.on === "1") === on) return;
  el.dataset.on = on ? "1" : "0";
  el.style.opacity = on ? "1" : "0";
}

function place(el: HTMLElement | null, m: Marker): void {
  if (el && m.visible) el.style.transform = `translate3d(${m.x.toFixed(1)}px, ${m.y.toFixed(1)}px, 0)`;
}

/**
 * Call right after the camera rig, same frame. `shipQ` is the rendered ship orientation, `velKmps`
 * the frame-relative velocity (frames are translations, so local scene axes).
 */
export function drawFlightHud(
  camera: PerspectiveCamera,
  size: { left: number; top: number; width: number; height: number },
  shipQ: Quaternion,
  velKmps: Vector3,
  transitActive: boolean,
): void {
  const h = flightHud;
  const e = h.els;
  const vp = h.viewport;
  vp[0] = size.left; vp[1] = size.top; vp[2] = size.width; vp[3] = size.height;
  _qInv.copy(camera.quaternion).invert();
  h.cameraQuat[0] = camera.quaternion.x; h.cameraQuat[1] = camera.quaternion.y;
  h.cameraQuat[2] = camera.quaternion.z; h.cameraQuat[3] = camera.quaternion.w;
  h.shipQuat[0] = shipQ.x; h.shipQuat[1] = shipQ.y; h.shipQuat[2] = shipQ.z; h.shipQuat[3] = shipQ.w;
  h.fovDeg = camera.fov;
  h.aspect = camera.aspect;

  _fwd.set(0, 0, 1).applyQuaternion(shipQ);
  projectDir(_fwd, camera, vp, h.reticle);
  show(e.nose, h.reticle.visible);
  place(e.nose, h.reticle);

  const steering = mouseState.attached && !mouseState.freeLook;
  const stickMode = steering && mouseConfig.mode === "stick";
  h.stick.visible = stickMode && h.reticle.visible;
  h.stick.x = h.reticle.x + mouseState.stickX * STICK_RING_PX;
  h.stick.y = h.reticle.y - mouseState.stickY * STICK_RING_PX;
  show(e.ring, h.stick.visible);
  show(e.stick, h.stick.visible);
  place(e.ring, h.reticle);
  place(e.stick, h.stick);

  if (steering && mouseConfig.mode === "aim" && mouseState.aimValid) projectDir(mouseState.aim, camera, vp, h.aim);
  else h.aim.visible = false;
  show(e.aim, h.aim.visible);
  place(e.aim, h.aim);

  // Drift = velocity component off the nose (moving backwards counts too).
  const fwdMps = velKmps.dot(_fwd) * 1000;
  _vel.copy(velKmps).addScaledVector(_fwd, -fwdMps / 1000);
  h.driftMps = Math.max(_vel.length() * 1000, -fwdMps);
  if (!transitActive && h.driftMps > DRIFT_SHOW_MPS) projectDir(_vel.copy(velKmps).normalize(), camera, vp, h.velocity);
  else h.velocity.visible = false;
  show(e.velocity, h.velocity.visible);
  place(e.velocity, h.velocity);

  show(e.hintFreeLook, mouseState.attached && mouseState.freeLook);
  show(e.hintLock, mouseState.attached && !mouseState.freeLook && !isPointerLocked() && !isCursorNeeded());
}
