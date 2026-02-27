"use client";

import { memo, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import type { VFXEventType } from "@/store/vfx";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------
const PARTICLE_COUNT = 24;
const LIFETIME_S = 1.8;
const BASE_SPEED_M = 55; // meters/s for a medium-sized asteroid
const DECELERATION = 0.93; // per-frame velocity multiplier (drag)
const MIN_SCALE = 0.3;
const MAX_SCALE = 1.2;
const TUMBLE_SPEED = 4.0;
const INITIAL_SPREAD_FACTOR = 0.6; // fraction of asteroid radius for initial offset from center

// Simple 8-face icosphere approximation (cheap geometry for debris chunks)
const DEBRIS_GEO = new THREE.IcosahedronGeometry(1, 0);

// Shared material — warm rocky tint, slightly emissive so it reads in dark space
const DEBRIS_MAT = new THREE.MeshStandardMaterial({
  color: new THREE.Color(0.55, 0.45, 0.35),
  roughness: 0.85,
  metalness: 0.1,
  emissive: new THREE.Color(0.15, 0.1, 0.06),
  emissiveIntensity: 0.5,
});

// Mining-specific: slightly brighter, bluish from laser heat
const MINING_MAT = new THREE.MeshStandardMaterial({
  color: new THREE.Color(0.5, 0.5, 0.55),
  roughness: 0.7,
  metalness: 0.15,
  emissive: new THREE.Color(0.1, 0.15, 0.25),
  emissiveIntensity: 0.6,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type ParticleState = {
  ox: number;
  oy: number;
  oz: number;
  vx: number;
  vy: number;
  vz: number;
  tumbleX: number;
  tumbleY: number;
  tumbleZ: number;
  scale: number;
};

type Props = {
  position: [number, number, number];
  radiusM: number;
  type: VFXEventType;
  impactDirection?: [number, number, number];
  onComplete: () => void;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
const DebrisEffect = memo(function DebrisEffect({
  position,
  radiusM,
  type,
  impactDirection,
  onComplete,
}: Props) {
  const meshRef = useRef<THREE.InstancedMesh>(null!);
  const elapsedRef = useRef(0);
  const doneRef = useRef(false);

  // Generate particle initial states once
  const particles = useMemo<ParticleState[]>(() => {
    const arr: ParticleState[] = [];
    const speedMult = Math.min(2.5, 0.5 + radiusM / 60);
    const speed = BASE_SPEED_M * speedMult;

    // Bias direction for collisions (particles fly mostly toward the ship)
    const biasX = impactDirection?.[0] ?? 0;
    const biasY = impactDirection?.[1] ?? 0;
    const biasZ = impactDirection?.[2] ?? 0;
    const biasMag = Math.sqrt(biasX * biasX + biasY * biasY + biasZ * biasZ);
    const hasBias = type === "collision" && biasMag > 0.01;

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      // Random direction on a sphere
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);

      let dx = Math.sin(phi) * Math.cos(theta);
      let dy = Math.sin(phi) * Math.sin(theta);
      let dz = Math.cos(phi);

      // Bias the direction for collision events (70% bias + 30% random)
      if (hasBias) {
        const nb = 1 / biasMag;
        dx = dx * 0.3 + biasX * nb * 0.7;
        dy = dy * 0.3 + biasY * nb * 0.7;
        dz = dz * 0.3 + biasZ * nb * 0.7;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len > 0.001) {
          dx /= len;
          dy /= len;
          dz /= len;
        }
      }

      const v = speed * (0.4 + Math.random() * 0.6);
      const s = MIN_SCALE + Math.random() * (MAX_SCALE - MIN_SCALE);
      // Scale particle size with asteroid radius (bigger asteroid → bigger chunks)
      const sizeScale = Math.min(3, 0.3 + radiusM / 40);

      // Offset from center so particles start spread out, not all at the same point
      const spread = radiusM * INITIAL_SPREAD_FACTOR * (0.3 + Math.random() * 0.7);

      arr.push({
        ox: dx * spread,
        oy: dy * spread,
        oz: dz * spread,
        vx: dx * v,
        vy: dy * v,
        vz: dz * v,
        tumbleX: (Math.random() - 0.5) * TUMBLE_SPEED,
        tumbleY: (Math.random() - 0.5) * TUMBLE_SPEED,
        tumbleZ: (Math.random() - 0.5) * TUMBLE_SPEED,
        scale: s * sizeScale,
      });
    }

    return arr;
  }, [radiusM, type, impactDirection]);

  // Initialize instance matrices at spawn position
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const m = new THREE.Matrix4();
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const p = particles[i];
      m.makeTranslation(
        position[0] + p.ox,
        position[1] + p.oy,
        position[2] + p.oz
      );
      m.scale(new THREE.Vector3(p.scale, p.scale, p.scale));
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, [particles, position]);

  const tmpMat = useMemo(() => new THREE.Matrix4(), []);
  const tmpPos = useMemo(() => new THREE.Vector3(), []);
  const tmpQuat = useMemo(() => new THREE.Quaternion(), []);
  const tmpScale = useMemo(() => new THREE.Vector3(), []);
  const tmpEuler = useMemo(() => new THREE.Euler(), []);

  useFrame((_, delta) => {
    if (doneRef.current) return;

    const mesh = meshRef.current;
    if (!mesh) return;

    elapsedRef.current += delta;
    const t = elapsedRef.current;

    if (t >= LIFETIME_S) {
      doneRef.current = true;
      mesh.visible = false;
      onComplete();
      return;
    }

    const progress = t / LIFETIME_S;
    // Opacity fade-out: particles shrink to nothing in the last 40%
    const fadeScale = progress > 0.6 ? 1 - (progress - 0.6) / 0.4 : 1;

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const p = particles[i];

      // Integrate position (particles store cumulative offset via matrix)
      mesh.getMatrixAt(i, tmpMat);
      tmpMat.decompose(tmpPos, tmpQuat, tmpScale);

      tmpPos.x += p.vx * delta;
      tmpPos.y += p.vy * delta;
      tmpPos.z += p.vz * delta;

      // Drag
      p.vx *= DECELERATION;
      p.vy *= DECELERATION;
      p.vz *= DECELERATION;

      // Tumble rotation
      tmpEuler.set(
        p.tumbleX * t,
        p.tumbleY * t,
        p.tumbleZ * t
      );
      tmpQuat.setFromEuler(tmpEuler);

      const s = p.scale * fadeScale;
      tmpScale.set(s, s, s);

      tmpMat.compose(tmpPos, tmpQuat, tmpScale);
      mesh.setMatrixAt(i, tmpMat);
    }

    mesh.instanceMatrix.needsUpdate = true;
  });

  const material = type === "mined" ? MINING_MAT : DEBRIS_MAT;

  return (
    <instancedMesh
      ref={meshRef}
      args={[DEBRIS_GEO, material, PARTICLE_COUNT]}
      frustumCulled={false}
    />
  );
});

export default DebrisEffect;
