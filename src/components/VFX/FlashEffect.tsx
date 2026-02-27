"use client";

import { memo, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import type { VFXEventType } from "@/store/vfx";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------
const FLASH_LIFETIME_S = 0.45;

const COLOR_COLLISION = new THREE.Color(1.0, 0.7, 0.3); // warm orange
const COLOR_MINED = new THREE.Color(0.5, 0.85, 1.0); // cool cyan

type Props = {
  position: [number, number, number];
  radiusM: number;
  type: VFXEventType;
  onComplete: () => void;
};

const FlashEffect = memo(function FlashEffect({
  position,
  radiusM,
  type,
  onComplete,
}: Props) {
  const spriteRef = useRef<THREE.Sprite>(null!);
  const elapsedRef = useRef(0);
  const doneRef = useRef(false);

  // Size proportional to asteroid radius (clamped)
  const baseSize = Math.min(120, Math.max(8, radiusM * 1.8));

  const glowTexture = useMemo(() => {
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      const tex = new THREE.DataTexture(
        new Uint8Array([255, 255, 255, 255]),
        1,
        1
      );
      tex.needsUpdate = true;
      return tex;
    }

    const g = ctx.createRadialGradient(
      size / 2,
      size / 2,
      0,
      size / 2,
      size / 2,
      size / 2
    );
    g.addColorStop(0.0, "rgba(255,255,255,1)");
    g.addColorStop(0.15, "rgba(255,255,255,0.85)");
    g.addColorStop(0.4, "rgba(255,255,255,0.25)");
    g.addColorStop(0.7, "rgba(255,255,255,0.05)");
    g.addColorStop(1.0, "rgba(255,255,255,0)");

    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);

    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }, []);

  const color = type === "collision" ? COLOR_COLLISION : COLOR_MINED;

  useFrame((_, delta) => {
    if (doneRef.current) return;

    const spr = spriteRef.current;
    if (!spr) return;

    elapsedRef.current += delta;
    const t = elapsedRef.current;

    if (t >= FLASH_LIFETIME_S) {
      doneRef.current = true;
      spr.visible = false;
      onComplete();
      return;
    }

    const progress = t / FLASH_LIFETIME_S;

    // Quick flash: grows fast, fades slow
    const scaleCurve = progress < 0.15
      ? progress / 0.15 // fast expand
      : 1 - (progress - 0.15) / 0.85; // slow shrink

    const s = baseSize * (0.6 + 0.6 * scaleCurve);
    spr.scale.set(s, s, 1);

    const mat = spr.material as THREE.SpriteMaterial;
    // Opacity: bright at start, fading out
    mat.opacity = 0.9 * scaleCurve * scaleCurve;
  });

  return (
    <sprite ref={spriteRef} position={position}>
      <spriteMaterial
        map={glowTexture}
        color={color}
        transparent
        opacity={0.9}
        blending={THREE.AdditiveBlending}
        depthWrite={false}
        depthTest
        toneMapped={false}
      />
    </sprite>
  );
});

export default FlashEffect;
