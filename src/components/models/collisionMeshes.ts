import { Matrix4, Mesh, Vector3, type Object3D } from "three";
import type { ColliderShape } from "@/sim/physics/types";

/** Each exported mesh is a separate convex volume in the asset's metre frame. */
export function readCollisionMeshes(scene: Object3D, anchor?: Matrix4): ColliderShape {
  const pieces: Float32Array[] = [];
  const vertex = new Vector3();
  const transform = new Matrix4();
  scene.updateMatrixWorld(true);
  scene.traverse((part) => {
    if (!(part instanceof Mesh)) return;
    const matrix = anchor ? transform.multiplyMatrices(anchor, part.matrixWorld) : part.matrixWorld;
    const position = part.geometry.getAttribute("position");
    const points = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) {
      vertex.fromBufferAttribute(position, i).applyMatrix4(matrix).toArray(points, i * 3);
    }
    pieces.push(points);
  });
  const [first, ...rest] = pieces;
  if (!first) throw new Error("Collision GLB has no meshes");
  return rest.length ? { kind: "compoundHull", pieces: [first, ...rest] } : { kind: "hull", points: first };
}
