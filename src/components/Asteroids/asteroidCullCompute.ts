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

// ─── Types ─────────────────────────────────────────────────────────

export type CullComputeUniforms = {
  uCameraPos: ReturnType<typeof uniform<THREE.Vector3>>;
  uNearRadiusM: ReturnType<typeof uniform<number>>;
  uFrustum: ReturnType<typeof uniform<THREE.Vector4>>[];
  uBaseQuat: ReturnType<typeof uniform<THREE.Vector4>>;
  uInvBaseRadius: ReturnType<typeof uniform<number>>;
  uBaseScale: ReturnType<typeof uniform<number>>;
};

// ─── Uniform factory ───────────────────────────────────────────────

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

// ─── Compute node factory ──────────────────────────────────────────

/**
 * Creates a TSL compute node that:
 * 1. Reads per-instance (pos, quat, radius) from inputStorage
 * 2. Performs frustum culling + distance check
 * 3. Compacts visible instances to the front of the output buffer
 * 4. Writes the visible count to an indirect draw buffer (instanceCount)
 *
 * Only visible instances enter the vertex shader — invisible ones are
 * skipped entirely via drawIndexedIndirect, not degenerate matrices.
 */
export function createCullComputeNode(
  allocator: GpuSlotAllocator,
  maxInstances: number,
  uniforms: CullComputeUniforms,
  indexCount: number,
) {
  // Input: 2 × vec4 per instance (pos+radius, quat)
  const inputNode = storage(allocator.inputAttr, "vec4", maxInstances * 2).toReadOnly();

  // Output: 4 × vec4 per instance (= mat4 column-major, compacted).
  const outputAttr = new StorageInstancedBufferAttribute(maxInstances, 16);
  const outputNode = storage(outputAttr, "vec4", maxInstances * 4);

  // Indirect draw args: [indexCount, instanceCount, firstIndex, baseVertex, firstInstance]
  // The compute shader atomically increments instanceCount for each visible instance.
  const indirectAttr = new IndirectStorageBufferAttribute(5, 1);
  indirectAttr.array[0] = indexCount;
  indirectAttr.array[1] = 0; // instanceCount — reset each frame, compute increments
  indirectAttr.array[2] = 0;
  indirectAttr.array[3] = 0;
  indirectAttr.array[4] = 0;

  const indirectNode = storage(indirectAttr, "uint", 5).toAtomic();

  const {
    uCameraPos, uNearRadiusM, uFrustum,
    uBaseQuat, uInvBaseRadius, uBaseScale,
  } = uniforms;

  const computeFn = Fn(() => {
    const i = instanceIndex;

    // Read instance data: slot i → elements [i*2] and [i*2+1]
    const posRadius = inputNode.element(i.mul(2));
    const quat = inputNode.element(i.mul(2).add(1));
    const radius = posRadius.w;

    // ── Visibility checks (branchless for the test) ─────────────
    // Dead slot: radius ≤ 0
    const alive = step(float(0.001), radius);

    // Distance check: beyond near radius → invisible
    const toCamera = posRadius.xyz.sub(uCameraPos);
    const dist = length(toCamera);
    const inRange = float(1.0).sub(step(uNearRadiusM, dist));

    // Frustum test: dot(center, plane.xyz) + plane.w > -radius for all 6 planes
    let inFrustum = float(1.0);
    for (let p = 0; p < 6; p++) {
      const plane = uFrustum[p];
      const d = dot(posRadius.xyz, plane.xyz).add(plane.w);
      inFrustum = inFrustum.mul(step(radius.negate(), d));
    }

    const visible = alive.mul(inRange).mul(inFrustum);

    // ── Compact visible instances to the front of the output ────
    // Only visible instances get a matrix; invisible ones are skipped
    // entirely by drawIndexedIndirect (no wasted vertex processing).
    If(visible.greaterThan(0.5), () => {
      // Atomic counter gives us the compact output index.
      const outIdx = atomicAdd(indirectNode.element(1), uint(1));

      const s = radius.mul(uInvBaseRadius).mul(uBaseScale);

      // ── Quaternion multiply: instanceQuat × baseQuat ──────────
      const ax = quat.x, ay = quat.y, az = quat.z, aw = quat.w;
      const bx = uBaseQuat.x, by = uBaseQuat.y, bz = uBaseQuat.z, bw = uBaseQuat.w;

      const cx = aw.mul(bx).add(ax.mul(bw)).add(ay.mul(bz)).sub(az.mul(by));
      const cy = aw.mul(by).sub(ax.mul(bz)).add(ay.mul(bw)).add(az.mul(bx));
      const cz = aw.mul(bz).add(ax.mul(by)).sub(ay.mul(bx)).add(az.mul(bw));
      const cw = aw.mul(bw).sub(ax.mul(bx)).sub(ay.mul(by)).sub(az.mul(bz));

      // ── TRS → mat4 (column-major) ────────────────────────────
      const x2 = cx.add(cx), y2 = cy.add(cy), z2 = cz.add(cz);
      const xx = cx.mul(x2), xy = cx.mul(y2), xz = cx.mul(z2);
      const yy = cy.mul(y2), yz = cy.mul(z2), zz = cz.mul(z2);
      const wx = cw.mul(x2), wy = cw.mul(y2), wz = cw.mul(z2);

      // Write 4 columns of the mat4 to the compacted output.
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

  const computeNode = computeFn().compute(maxInstances);

  // Reset compute: zeros the atomic instanceCount before the cull pass.
  // Runs on GPU (1 thread) so there's no CPU→GPU race with needsUpdate.
  const resetFn = Fn(() => {
    atomicStore(indirectNode.element(1), uint(0));
  });
  const resetNode = resetFn().compute(1);

  return { computeNode, resetNode, outputAttr, indirectAttr };
}

// ─── Frustum plane extraction helper ───────────────────────────────

const _projScreen = new THREE.Matrix4();

/**
 * Extract 6 frustum planes from a combined projection-view-model matrix.
 * Each plane is (nx, ny, nz, d) such that dot(point, normal) + d ≥ 0 means inside.
 *
 * Writes directly into the uniform vec4s — zero allocations per call.
 */
export function extractFrustumPlanes(
  camera: THREE.Camera,
  meshMatrixWorld: THREE.Matrix4,
  planes: ReturnType<typeof uniform<THREE.Vector4>>[],
): void {
  _projScreen
    .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    .multiply(meshMatrixWorld);

  const me = _projScreen.elements;

  _setPlane(planes[0], me[3] + me[0], me[7] + me[4], me[11] + me[8],  me[15] + me[12]);  // left
  _setPlane(planes[1], me[3] - me[0], me[7] - me[4], me[11] - me[8],  me[15] - me[12]);  // right
  _setPlane(planes[2], me[3] + me[1], me[7] + me[5], me[11] + me[9],  me[15] + me[13]);  // bottom
  _setPlane(planes[3], me[3] - me[1], me[7] - me[5], me[11] - me[9],  me[15] - me[13]);  // top
  _setPlane(planes[4], me[3] + me[2], me[7] + me[6], me[11] + me[10], me[15] + me[14]);  // near
  _setPlane(planes[5], me[3] - me[2], me[7] - me[6], me[11] - me[10], me[15] - me[14]);  // far
}

function _setPlane(
  plane: ReturnType<typeof uniform<THREE.Vector4>>,
  a: number, b: number, c: number, d: number,
): void {
  const len = Math.sqrt(a * a + b * b + c * c);
  if (len > 0) {
    const invLen = 1 / len;
    plane.value.set(a * invLen, b * invLen, c * invLen, d * invLen);
  }
}
