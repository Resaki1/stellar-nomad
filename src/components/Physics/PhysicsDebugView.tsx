"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry, Group, LineBasicMaterial, LineSegments, Mesh, MeshStandardMaterial, SphereGeometry, Vector3 } from "three";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { frameOriginKm } from "@/sim/frames";
import { nearField } from "@/sim/physics/nearField";
import { DEV_COLLIDER_TAG } from "@/components/TestHarness/physicsHarness";
import { physicsDebug } from "@/store/physicsTuningPrefs";

const POOL = 16;
/** Outline vertex capacity (floats); grows when the engine draws more. */
const OUTLINE_FLOATS = 3 * 200_000;
const _o = new Vector3();

/**
 * Dev: draws `__phys.dev.add()` colliders (bounding sphere for hulls) so live contact tests can be
 * seen, and with Settings → Dev → "collider outlines" the engine's own outline of every collider.
 */
export default function PhysicsDebugView() {
  const worldOrigin = useWorldOrigin();
  const { group, outlines } = useMemo(() => {
    const g = new Group();
    const geo = new SphereGeometry(1, 32, 16);
    const mat = new MeshStandardMaterial({ color: 0x8a7f74, roughness: 1, metalness: 0 });
    for (let i = 0; i < POOL; i++) {
      const m = new Mesh(geo, mat);
      m.visible = false;
      m.frustumCulled = false;
      g.add(m);
    }
    // Drawn through the rocks: the point is to compare the engine's shape with the rendered surface.
    const lines = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: 0x40ff60, depthTest: false, transparent: true, opacity: 0.85 }));
    lines.geometry.setAttribute("position", new BufferAttribute(new Float32Array(OUTLINE_FLOATS), 3));
    lines.frustumCulled = false;
    lines.renderOrder = 10_000;
    lines.visible = false;
    g.add(lines);
    return { group: g, outlines: lines };
  }, []);

  useEffect(() => () => outlines.geometry.dispose(), [outlines]);

  useFrame(() => {
    let i = 0;
    const wo = worldOrigin.worldOriginKm;
    const dbg = physicsDebug.outlines ? nearField.debugLines() : null;
    outlines.visible = dbg !== null;
    if (dbg) {
      let attr = outlines.geometry.getAttribute("position") as BufferAttribute;
      if (dbg.lines.length > attr.array.length) {
        outlines.geometry.dispose();
        attr = new BufferAttribute(new Float32Array(dbg.lines.length * 2), 3);
        outlines.geometry.setAttribute("position", attr);
      }
      (attr.array as Float32Array).set(dbg.lines);
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, dbg.lines.length);
      attr.needsUpdate = true;
      outlines.geometry.setDrawRange(0, dbg.lines.length / 3);
      frameOriginKm(dbg.frameId, _o).add(dbg.anchorKm).sub(wo).multiplyScalar(1000);
      outlines.position.copy(_o);
    }
    nearField.forEachCollider((_id, shape, frameId, relKm, tag, quat) => {
      if (tag !== DEV_COLLIDER_TAG || i >= POOL) return;
      const m = group.children[i++] as Mesh;
      frameOriginKm(frameId, _o).add(relKm).sub(wo).multiplyScalar(1000);
      m.position.copy(_o);
      m.quaternion.copy(quat);
      let r = 1;
      if (shape.kind === "ball") r = shape.radiusM;
      else if (shape.kind === "box") r = Math.max(shape.halfX, shape.halfY, shape.halfZ);
      else {
        const p = shape.points;
        let r2 = 0;
        for (let k = 0; k < p.length; k += 3) r2 = Math.max(r2, p[k] * p[k] + p[k + 1] * p[k + 1] + p[k + 2] * p[k + 2]);
        r = Math.sqrt(r2);
      }
      m.scale.setScalar(r);
      m.visible = true;
    });
    for (; i < POOL; i++) group.children[i].visible = false;
  });

  return <primitive object={group} />;
}
