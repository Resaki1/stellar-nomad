import { useMemo } from "react";
import * as THREE from "three";
import { NodeMaterial } from "three/webgpu";
import {
  Fn,
  uv,
  positionGeometry,
  modelWorldMatrix,
  cameraViewMatrix,
  cameraProjectionMatrix,
  vec3,
  vec4,
  float,
  clamp,
  length,
  smoothstep,
  Discard,
} from "three/tsl";
import type { FarBillboardConfig } from "./types";

/**
 * Default billboard fragment: simple hard-diffuse hemisphere.
 * Used by rocky bodies (Mercury, Io, Europa, Ganymede, Callisto, Luna).
 */
function defaultBillboardFragment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  { albedo, uSpR, uSpU, uSpF }: { albedo: THREE.Color; uSpR: any; uSpU: any; uSpF: any },
) {
  return Fn(() => {
    const p = uv().mul(2).sub(1);
    const dist = length(p);

    const edge = smoothstep(float(1.0), float(0.92), dist);
    Discard(edge.lessThan(0.01));

    const domeZ = float(1.0).sub(dist.mul(dist)).max(0).sqrt();

    const sunDot = clamp(
      uSpR.mul(p.x).add(uSpU.mul(p.y)).add(uSpF.mul(domeZ)),
      0, 1,
    );

    const col = vec3(albedo.r, albedo.g, albedo.b).mul(sunDot);

    return vec4(col, edge);
  })();
}

export function useFarLOD(
  scaledRadius: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSpR: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSpU: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSpF: any,
  farConfig: FarBillboardConfig,
) {
  const sizeMultiplier = farConfig.sizeMultiplier ?? 2.1;

  const geo = useMemo(
    () => new THREE.PlaneGeometry(scaledRadius * sizeMultiplier, scaledRadius * sizeMultiplier),
    [scaledRadius, sizeMultiplier],
  );

  const mat = useMemo(() => {
    const m = new NodeMaterial();
    m.side = THREE.DoubleSide;
    m.depthWrite = true;
    m.transparent = false;
    m.alphaHash = true;

    const worldCenter = modelWorldMatrix.mul(vec4(0, 0, 0, 1));

    m.vertexNode = Fn(() => {
      const viewCenter = cameraViewMatrix.mul(worldCenter);
      const viewPos = viewCenter.add(
        vec4(positionGeometry.xy, float(0), float(0)),
      );
      return cameraProjectionMatrix.mul(viewPos);
    })();

    const buildFrag = farConfig.buildFragment ?? defaultBillboardFragment;
    m.fragmentNode = buildFrag({ albedo: farConfig.albedo, uSpR, uSpU, uSpF });

    return m;
  }, [uSpR, uSpU, uSpF, scaledRadius, farConfig, sizeMultiplier]);

  return { geo, mat };
}
