import * as THREE from "three";
import type { FieldShape } from "@/sim/systemTypes";

export type PreparedFieldShape = {
  type: FieldShape["type"];
  /**
   * Conservative bounding radius (km) for broad-phase checks.
   * For a box, this is length(halfExtents).
   */
  boundingRadiusKm: number;

  /**
   * x/y/z are in field-local KM (relative to the field anchor).
   */
  isInsideKm: (x: number, y: number, z: number) => boolean;

  /**
   * Distance (km) from a point to the shape surface. 0 if inside.
   */
  distanceToKm: (x: number, y: number, z: number) => number;

  /**
   * Conservative intersection test between the field shape and an AABB.
   * The AABB is specified in field-local KM.
   */
  intersectsAabbKm: (
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number
  ) => boolean;
};

function distancePointToAabbKmFromPoint(
  px: number,
  py: number,
  pz: number,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number
): number {
  let dx = 0;
  if (px < minX) dx = minX - px;
  else if (px > maxX) dx = px - maxX;

  let dy = 0;
  if (py < minY) dy = minY - py;
  else if (py > maxY) dy = py - maxY;

  let dz = 0;
  if (pz < minZ) dz = minZ - pz;
  else if (pz > maxZ) dz = pz - maxZ;

  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function distanceSqPointToAabbFromOrigin(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number
): number {
  let dx = 0;
  if (0 < minX) dx = minX;
  else if (0 > maxX) dx = -maxX;

  let dy = 0;
  if (0 < minY) dy = minY;
  else if (0 > maxY) dy = -maxY;

  let dz = 0;
  if (0 < minZ) dz = minZ;
  else if (0 > maxZ) dz = -maxZ;

  return dx * dx + dy * dy + dz * dz;
}

function rotateVecByQuat(
  out: number[],
  x: number,
  y: number,
  z: number,
  qx: number,
  qy: number,
  qz: number,
  qw: number
) {
  // Derived from three.js Vector3.applyQuaternion (but purely numeric).
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;

  out[0] = ix * qw + iw * -qx + iy * -qz - iz * -qy;
  out[1] = iy * qw + iw * -qy + iz * -qx - ix * -qz;
  out[2] = iz * qw + iw * -qz + ix * -qy - iy * -qx;

  return out;
}

export function prepareFieldShape(shape: FieldShape): PreparedFieldShape {
  if (shape.type === "sphere") {
    const radius = Math.max(0.0001, shape.radiusKm);
    const r2 = radius * radius;

    return {
      type: "sphere",
      boundingRadiusKm: radius,
      isInsideKm: (x, y, z) => x * x + y * y + z * z <= r2,
      distanceToKm: (x, y, z) =>
        Math.max(0, Math.sqrt(x * x + y * y + z * z) - radius),
      intersectsAabbKm: (minX, minY, minZ, maxX, maxY, maxZ) =>
        distanceSqPointToAabbFromOrigin(minX, minY, minZ, maxX, maxY, maxZ) <=
        r2,
    };
  }

  // Box
  const hx = Math.max(0.0001, shape.halfExtentsKm[0]);
  const hy = Math.max(0.0001, shape.halfExtentsKm[1]);
  const hz = Math.max(0.0001, shape.halfExtentsKm[2]);

  const boundingRadiusKm = Math.sqrt(hx * hx + hy * hy + hz * hz);

  const scratch = [0, 0, 0];

  // Optional rotation support for inside/distance (intersection remains conservative for rotated boxes).
  let hasRotation = false;
  let qix = 0;
  let qiy = 0;
  let qiz = 0;
  let qiw = 1;

  if (shape.rotationDeg) {
    const [rx, ry, rz] = shape.rotationDeg;
    const e = new THREE.Euler(
      THREE.MathUtils.degToRad(rx),
      THREE.MathUtils.degToRad(ry),
      THREE.MathUtils.degToRad(rz)
    );
    const q = new THREE.Quaternion().setFromEuler(e).invert(); // inverse rotation
    hasRotation = true;
    qix = q.x;
    qiy = q.y;
    qiz = q.z;
    qiw = q.w;
  }

  const toLocalBox = (x: number, y: number, z: number) => {
    if (!hasRotation) {
      scratch[0] = x;
      scratch[1] = y;
      scratch[2] = z;
      return scratch;
    }
    return rotateVecByQuat(scratch, x, y, z, qix, qiy, qiz, qiw);
  };

  const isInsideKm = (x: number, y: number, z: number) => {
    const v = toLocalBox(x, y, z);
    return Math.abs(v[0]) <= hx && Math.abs(v[1]) <= hy && Math.abs(v[2]) <= hz;
  };

  const distanceToKm = (x: number, y: number, z: number) => {
    const v = toLocalBox(x, y, z);

    const ax = Math.abs(v[0]) - hx;
    const ay = Math.abs(v[1]) - hy;
    const az = Math.abs(v[2]) - hz;

    const dx = ax > 0 ? ax : 0;
    const dy = ay > 0 ? ay : 0;
    const dz = az > 0 ? az : 0;

    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  };

  const intersectsAabbKm = (
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number
  ) => {
    // Exact for axis-aligned box, conservative for rotated (bounding sphere test).
    if (!hasRotation) {
      const bMinX = -hx;
      const bMinY = -hy;
      const bMinZ = -hz;
      const bMaxX = hx;
      const bMaxY = hy;
      const bMaxZ = hz;

      return (
        minX <= bMaxX &&
        maxX >= bMinX &&
        minY <= bMaxY &&
        maxY >= bMinY &&
        minZ <= bMaxZ &&
        maxZ >= bMinZ
      );
    }

    // Conservative: treat rotated box as sphere with radius = boundingRadiusKm.
    const r2 = boundingRadiusKm * boundingRadiusKm;
    return (
      distanceSqPointToAabbFromOrigin(minX, minY, minZ, maxX, maxY, maxZ) <= r2
    );
  };

  return {
    type: "box",
    boundingRadiusKm,
    isInsideKm,
    distanceToKm,
    intersectsAabbKm,
  };
}

// Exported for chunk streaming (player-to-chunk distance).
export function distancePointToAabbKm(
  px: number,
  py: number,
  pz: number,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number
): number {
  return distancePointToAabbKmFromPoint(
    px,
    py,
    pz,
    minX,
    minY,
    minZ,
    maxX,
    maxY,
    maxZ
  );
}
