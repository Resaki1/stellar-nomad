import { Quaternion, Vector3, type Camera, type Object3D } from "three";

const SHAKE_DECAY_RATE = 3.0; // exponential decay speed
const SHAKE_MAX_OFFSET = 0.8; // meters
const SHAKE_MAX_ANGLE = 0.025; // radians

const _xAxis = new Vector3(1, 0, 0);
const _yAxis = new Vector3(0, 1, 0);
const _fwd = new Vector3();
const _cameraOffset = new Vector3(0, -4, 10);
const _offset = new Vector3();
const _rotationQuat = new Quaternion().setFromAxisAngle(_yAxis, Math.PI);
const _shakeOffset = new Vector3();
const _shakeEuler = new Quaternion();

/** Chase camera + hit shake. Called from the ship's own `useFrame` to avoid a frame of lag. */
export class ChaseCamera {
  private shakeIntensity = 0;

  /** Drop residual shake (respawn, dev warp). */
  resetShake(): void {
    this.shakeIntensity = 0;
  }

  /**
   * @param shakeSignal new shake impulse consumed this frame (0 = none)
   * @param benchMode shake is `performance.now()`-seeded so it is skipped in benchmarks
   */
  update(camera: Camera, ship: Object3D, speed: number, delta: number, shakeSignal: number, benchMode: boolean): void {
    _fwd.set(0, 0, 1).applyQuaternion(ship.quaternion);
    _offset.copy(_cameraOffset).applyQuaternion(ship.quaternion);
    _offset.add(_fwd.normalize().multiplyScalar(speed * 0.75 + 1));

    camera.position.copy(ship.position).sub(_offset);
    camera.quaternion.copy(ship.quaternion).multiply(_rotationQuat);

    if (shakeSignal > 0 && !benchMode) {
      this.shakeIntensity = Math.min(1, this.shakeIntensity + shakeSignal);
    }

    if (this.shakeIntensity > 0.001) {
      const s = this.shakeIntensity;
      const t = performance.now() * 0.001;
      const ox = Math.sin(t * 37.7 + 1.3) * Math.cos(t * 23.1);
      const oy = Math.sin(t * 41.3 + 2.7) * Math.cos(t * 29.7);
      const oz = Math.sin(t * 31.1 + 4.1) * Math.cos(t * 19.3);

      _shakeOffset.set(
        ox * SHAKE_MAX_OFFSET * s,
        oy * SHAKE_MAX_OFFSET * s,
        oz * SHAKE_MAX_OFFSET * 0.3 * s,
      ).applyQuaternion(ship.quaternion);
      camera.position.add(_shakeOffset);

      const ry = Math.sin(t * 43.7 + 0.5) * SHAKE_MAX_ANGLE * s;
      const rp = Math.sin(t * 47.3 + 3.2) * SHAKE_MAX_ANGLE * s;
      _shakeEuler.setFromAxisAngle(_yAxis, ry);
      camera.quaternion.multiply(_shakeEuler);
      _shakeEuler.setFromAxisAngle(_xAxis, rp);
      camera.quaternion.multiply(_shakeEuler);

      this.shakeIntensity *= Math.exp(-SHAKE_DECAY_RATE * delta);
    }
  }
}
