import * as THREE from "three";
import {
  Fn,
  instanceIndex,
  float,
  uint,
  vec4,
  dot,
  length,
  step,
  uniform,
  storage,
  If,
  atomicAdd,
  atomicStore,
} from "three/tsl";
import {
  StorageInstancedBufferAttribute,
  IndirectStorageBufferAttribute,
} from "three/webgpu";
import type { GpuSlotAllocator } from "./GpuSlotAllocator";

// ─── Near tier types ────────────────────────────────────────────────

// Use typeof on concrete instances to avoid ReturnType<typeof uniform<T>>
// which fails TypeScript's constraint check with three.js TSL types.
const _uVec3 = uniform(new THREE.Vector3());
const _uVec4 = uniform(new THREE.Vector4());
const _uNum = uniform(0);
type UniformVec3 = typeof _uVec3;
type UniformVec4 = typeof _uVec4;
type UniformNum = typeof _uNum;

export type CullComputeUniforms = {
  uCameraPos: UniformVec3;
  uNearRadiusM: UniformNum;
  uFrustum: UniformVec4[];
  uBaseQuat: UniformVec4;
  uInvBaseRadius: UniformNum;
  uBaseScale: UniformNum;
};

export function createCullUniforms(): CullComputeUniforms {
  return {
    uCameraPos: uniform(new THREE.Vector3()),
    uNearRadiusM: uniform(0),
    uFrustum: Array.from({ length: 6 }, () => uniform(new THREE.Vector4())),
    uBaseQuat: uniform(new THREE.Vector4(0, 0, 0, 1)),
    uInvBaseRadius: uniform(1),
    uBaseScale: uniform(1),
  };
}

// ─── Far tier types ─────────────────────────────────────────────────

export type FarCullComputeUniforms = {
  uCameraPos: UniformVec3;
  uNearRadiusM: UniformNum;
  uFarRadiusM: UniformNum;
  uFrustum: UniformVec4[];
};

export function createFarCullUniforms(): FarCullComputeUniforms {
  return {
    uCameraPos: uniform(new THREE.Vector3()),
    uNearRadiusM: uniform(0),
    uFarRadiusM: uniform(0),
    uFrustum: Array.from({ length: 6 }, () => uniform(new THREE.Vector4())),
  };
}

// ─── Near tier compute ──────────────────────────────────────────────

/**
 * GPU compute: cull + compact for the near tier (3D models).
 * Reads all allocator slots, keeps instances within nearRadius + frustum,
 * outputs compacted mat4s for indirect draw.
 */
export function createCullComputeNode(
  allocator: GpuSlotAllocator,
  maxAllocSlots: number,
  maxOutputInstances: number,
  uniforms: CullComputeUniforms,
  indexCount: number,
) {
  const inputNode = storage(allocator.inputAttr, "vec4", maxAllocSlots * 2).toReadOnly();

  const outputAttr = new StorageInstancedBufferAttribute(maxOutputInstances, 16);
  const outputNode = storage(outputAttr, "vec4", maxOutputInstances * 4);

  const indirectAttr = new IndirectStorageBufferAttribute(new Uint32Array([indexCount, 0, 0, 0, 0]), 1);

  const indirectNode = storage(indirectAttr, "uint", 5).toAtomic();

  const maxOut = uint(maxOutputInstances);

  const {
    uCameraPos, uNearRadiusM, uFrustum,
    uBaseQuat, uInvBaseRadius, uBaseScale,
  } = uniforms;

  const computeFn = Fn(() => {
    const i = instanceIndex;

    const posRadius = inputNode.element(i.mul(2));
    const quat = inputNode.element(i.mul(2).add(1));
    const radius = posRadius.w;

    // Dead slot: radius ≤ 0
    const alive = step(float(0.001), radius);

    // Distance: within near radius
    const toCamera = posRadius.xyz.sub(uCameraPos);
    const dist = length(toCamera);
    const inRange = float(1.0).sub(step(uNearRadiusM, dist));

    // Frustum test
    let inFrustum: any = float(1.0);
    for (let p = 0; p < 6; p++) {
      const plane = uFrustum[p];
      const d = dot(posRadius.xyz, plane.xyz).add(plane.w);
      inFrustum = inFrustum.mul(step(radius.negate(), d));
    }

    const visible: any = alive.mul(inRange).mul(inFrustum);

    If(visible.greaterThan(0.5), () => {
      const outIdx = atomicAdd(indirectNode.element(1), uint(1)) as any;

      // Output buffer overflow guard.
      If(outIdx.lessThan(maxOut), () => {
        const s = radius.mul(uInvBaseRadius).mul(uBaseScale);

        // Quaternion multiply: instanceQuat × baseQuat
        const ax = quat.x, ay = quat.y, az = quat.z, aw = quat.w;
        const bx = uBaseQuat.x, by = uBaseQuat.y, bz = uBaseQuat.z, bw = uBaseQuat.w;

        const cx = aw.mul(bx).add(ax.mul(bw)).add(ay.mul(bz)).sub(az.mul(by));
        const cy = aw.mul(by).sub(ax.mul(bz)).add(ay.mul(bw)).add(az.mul(bx));
        const cz = aw.mul(bz).add(ax.mul(by)).sub(ay.mul(bx)).add(az.mul(bw));
        const cw = aw.mul(bw).sub(ax.mul(bx)).sub(ay.mul(by)).sub(az.mul(bz));

        // TRS → mat4
        const x2 = cx.add(cx), y2 = cy.add(cy), z2 = cz.add(cz);
        const xx = cx.mul(x2), xy = cx.mul(y2), xz = cx.mul(z2);
        const yy = cy.mul(y2), yz = cy.mul(z2), zz = cz.mul(z2);
        const wx = cw.mul(x2), wy = cw.mul(y2), wz = cw.mul(z2);

        const base = outIdx.mul(4);
        outputNode.element(base).assign(
          vec4(float(1).sub(yy.add(zz)).mul(s), xy.add(wz).mul(s), xz.sub(wy).mul(s), float(0))
        );
        outputNode.element(base.add(1)).assign(
          vec4(xy.sub(wz).mul(s), float(1).sub(xx.add(zz)).mul(s), yz.add(wx).mul(s), float(0))
        );
        outputNode.element(base.add(2)).assign(
          vec4(xz.add(wy).mul(s), yz.sub(wx).mul(s), float(1).sub(xx.add(yy)).mul(s), float(0))
        );
        outputNode.element(base.add(3)).assign(
          vec4(posRadius.x, posRadius.y, posRadius.z, float(1))
        );
      });
    });
  });

  const computeNode = computeFn().compute(maxAllocSlots);

  const resetFn = Fn(() => {
    atomicStore(indirectNode.element(1), uint(0));
  });
  const resetNode = resetFn().compute(1);

  return { computeNode, resetNode, outputAttr, indirectAttr };
}

// ─── Mid tier types ──────────────────────────────────────────────────

export type MidCullComputeUniforms = {
  uCameraPos: UniformVec3;
  uMinRadiusM: UniformNum;
  uMaxRadiusM: UniformNum;
  uFrustum: UniformVec4[];
  uBaseQuat: UniformVec4;
  uInvBaseRadius: UniformNum;
  uBaseScale: UniformNum;
};

export function createMidCullUniforms(): MidCullComputeUniforms {
  return {
    uCameraPos: uniform(new THREE.Vector3()),
    uMinRadiusM: uniform(0),
    uMaxRadiusM: uniform(0),
    uFrustum: Array.from({ length: 6 }, () => uniform(new THREE.Vector4())),
    uBaseQuat: uniform(new THREE.Vector4(0, 0, 0, 1)),
    uInvBaseRadius: uniform(1),
    uBaseScale: uniform(1),
  };
}

// ─── Mid tier compute ──────────────────────────────────────────────

/**
 * GPU compute: cull + compact for the mid tier (simplified 3D models).
 * Band-pass distance filter: minRadius ≤ dist < maxRadius.
 * Outputs compacted mat4s for indirect draw (same as near tier).
 */
export function createMidCullComputeNode(
  allocator: GpuSlotAllocator,
  maxAllocSlots: number,
  maxOutputInstances: number,
  uniforms: MidCullComputeUniforms,
  indexCount: number,
) {
  const inputNode = storage(allocator.inputAttr, "vec4", maxAllocSlots * 2).toReadOnly();

  const outputAttr = new StorageInstancedBufferAttribute(maxOutputInstances, 16);
  const outputNode = storage(outputAttr, "vec4", maxOutputInstances * 4);

  const indirectAttr = new IndirectStorageBufferAttribute(new Uint32Array([indexCount, 0, 0, 0, 0]), 1);
  const indirectNode = storage(indirectAttr, "uint", 5).toAtomic();

  const maxOut = uint(maxOutputInstances);

  const {
    uCameraPos, uMinRadiusM, uMaxRadiusM, uFrustum,
    uBaseQuat, uInvBaseRadius, uBaseScale,
  } = uniforms;

  const computeFn = Fn(() => {
    const i = instanceIndex;

    const posRadius = inputNode.element(i.mul(2));
    const quat = inputNode.element(i.mul(2).add(1));
    const radius = posRadius.w;

    const alive = step(float(0.001), radius);

    // Band-pass: minRadius ≤ dist < maxRadius
    const toCamera = posRadius.xyz.sub(uCameraPos);
    const dist = length(toCamera);
    const beyondMin = step(uMinRadiusM, dist);
    const withinMax = float(1.0).sub(step(uMaxRadiusM, dist));
    const inRange = beyondMin.mul(withinMax);

    // Frustum test
    let inFrustum: any = float(1.0);
    for (let p = 0; p < 6; p++) {
      const plane = uFrustum[p];
      const d = dot(posRadius.xyz, plane.xyz).add(plane.w);
      inFrustum = inFrustum.mul(step(radius.negate(), d));
    }

    const visible: any = alive.mul(inRange).mul(inFrustum);

    If(visible.greaterThan(0.5), () => {
      const outIdx = atomicAdd(indirectNode.element(1), uint(1)) as any;

      If(outIdx.lessThan(maxOut), () => {
        const s = radius.mul(uInvBaseRadius).mul(uBaseScale);

        // Quaternion multiply: instanceQuat × baseQuat
        const ax = quat.x, ay = quat.y, az = quat.z, aw = quat.w;
        const bx = uBaseQuat.x, by = uBaseQuat.y, bz = uBaseQuat.z, bw = uBaseQuat.w;

        const cx = aw.mul(bx).add(ax.mul(bw)).add(ay.mul(bz)).sub(az.mul(by));
        const cy = aw.mul(by).sub(ax.mul(bz)).add(ay.mul(bw)).add(az.mul(bx));
        const cz = aw.mul(bz).add(ax.mul(by)).sub(ay.mul(bx)).add(az.mul(bw));
        const cw = aw.mul(bw).sub(ax.mul(bx)).sub(ay.mul(by)).sub(az.mul(bz));

        // TRS → mat4
        const x2 = cx.add(cx), y2 = cy.add(cy), z2 = cz.add(cz);
        const xx = cx.mul(x2), xy = cx.mul(y2), xz = cx.mul(z2);
        const yy = cy.mul(y2), yz = cy.mul(z2), zz = cz.mul(z2);
        const wx = cw.mul(x2), wy = cw.mul(y2), wz = cw.mul(z2);

        const base = outIdx.mul(4);
        outputNode.element(base).assign(
          vec4(float(1).sub(yy.add(zz)).mul(s), xy.add(wz).mul(s), xz.sub(wy).mul(s), float(0))
        );
        outputNode.element(base.add(1)).assign(
          vec4(xy.sub(wz).mul(s), float(1).sub(xx.add(zz)).mul(s), yz.add(wx).mul(s), float(0))
        );
        outputNode.element(base.add(2)).assign(
          vec4(xz.add(wy).mul(s), yz.sub(wx).mul(s), float(1).sub(xx.add(yy)).mul(s), float(0))
        );
        outputNode.element(base.add(3)).assign(
          vec4(posRadius.x, posRadius.y, posRadius.z, float(1))
        );
      });
    });
  });

  const computeNode = computeFn().compute(maxAllocSlots);

  const resetFn = Fn(() => {
    atomicStore(indirectNode.element(1), uint(0));
  });
  const resetNode = resetFn().compute(1);

  return { computeNode, resetNode, outputAttr, indirectAttr };
}

// ─── Far tier compute ───────────────────────────────────────────────

/**
 * GPU compute: cull + compact for the far tier (billboard impostors).
 * Band-pass distance filter: nearRadius ≤ dist < farRadius.
 * Outputs compacted vec4(pos.xyz, radius) packed into mat4 column 0.
 */
export function createFarCullComputeNode(
  allocator: GpuSlotAllocator,
  maxAllocSlots: number,
  maxOutputInstances: number,
  uniforms: FarCullComputeUniforms,
) {
  const inputNode = storage(allocator.inputAttr, "vec4", maxAllocSlots * 2).toReadOnly();

  // Output: one vec4(pos.xyz, radius) per visible instance.
  // Added to the geometry as a named instanced attribute "aFarData".
  const outputAttr = new StorageInstancedBufferAttribute(maxOutputInstances, 4);
  const outputNode = storage(outputAttr, "vec4", maxOutputInstances);

  // Indirect draw: PlaneGeometry has 6 indices (2 triangles).
  const indirectAttr = new IndirectStorageBufferAttribute(new Uint32Array([6, 0, 0, 0, 0]), 1);

  const indirectNode = storage(indirectAttr, "uint", 5).toAtomic();

  const maxOut = uint(maxOutputInstances);

  const { uCameraPos, uNearRadiusM, uFarRadiusM, uFrustum } = uniforms;

  const computeFn = Fn(() => {
    const i = instanceIndex;

    // Read only pos+radius (skip quat — billboards don't need orientation).
    const posRadius = inputNode.element(i.mul(2));
    const radius = posRadius.w;

    const alive = step(float(0.001), radius);

    // Band-pass: nearRadius ≤ dist < farRadius
    const toCamera = posRadius.xyz.sub(uCameraPos);
    const dist = length(toCamera);
    const beyondNear = step(uNearRadiusM, dist);       // 1 if dist ≥ near
    const withinFar = float(1.0).sub(step(uFarRadiusM, dist)); // 1 if dist < far
    const inRange = beyondNear.mul(withinFar);

    // Frustum test
    let inFrustum: any = float(1.0);
    for (let p = 0; p < 6; p++) {
      const plane = uFrustum[p];
      const d = dot(posRadius.xyz, plane.xyz).add(plane.w);
      inFrustum = inFrustum.mul(step(radius.negate(), d));
    }

    const visible: any = alive.mul(inRange).mul(inFrustum);

    If(visible.greaterThan(0.5), () => {
      const outIdx = atomicAdd(indirectNode.element(1), uint(1)) as any;

      If(outIdx.lessThan(maxOut), () => {
        outputNode.element(outIdx).assign(
          vec4(posRadius.x, posRadius.y, posRadius.z, radius)
        );
      });
    });
  });

  const computeNode = computeFn().compute(maxAllocSlots);

  const resetFn = Fn(() => {
    atomicStore(indirectNode.element(1), uint(0));
  });
  const resetNode = resetFn().compute(1);

  return { computeNode, resetNode, outputAttr, indirectAttr };
}

// ─── Frustum plane extraction helper ────────────────────────────────

const _projScreen = new THREE.Matrix4();

export function extractFrustumPlanes(
  camera: THREE.Camera,
  meshMatrixWorld: THREE.Matrix4,
  planes: UniformVec4[],
): void {
  _projScreen
    .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    .multiply(meshMatrixWorld);

  const me = _projScreen.elements;

  _setPlane(planes[0], me[3] + me[0], me[7] + me[4], me[11] + me[8],  me[15] + me[12]);
  _setPlane(planes[1], me[3] - me[0], me[7] - me[4], me[11] - me[8],  me[15] - me[12]);
  _setPlane(planes[2], me[3] + me[1], me[7] + me[5], me[11] + me[9],  me[15] + me[13]);
  _setPlane(planes[3], me[3] - me[1], me[7] - me[5], me[11] - me[9],  me[15] - me[13]);
  _setPlane(planes[4], me[3] + me[2], me[7] + me[6], me[11] + me[10], me[15] + me[14]);
  _setPlane(planes[5], me[3] - me[2], me[7] - me[6], me[11] - me[10], me[15] - me[14]);
}

function _setPlane(
  plane: UniformVec4,
  a: number, b: number, c: number, d: number,
): void {
  const len = Math.sqrt(a * a + b * b + c * c);
  if (len > 0) {
    const invLen = 1 / len;
    plane.value.set(a * invLen, b * invLen, c * invLen, d * invLen);
  }
}
