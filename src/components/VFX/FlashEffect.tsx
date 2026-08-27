"use client";

import { memo, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import type { VFXEventType } from "@/store/vfx";
import { emitterColor } from "@/components/space/emissivePhotometry";
import { registerPreExposedEmissive } from "@/components/space/preExposedEmissive";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------
const FLASH_LIFETIME_S = 0.45;

// ── Flash radiance on the photometric scale (LIGHTING_PLAN D26 step 1) ──────
// Material radiance in game units, from `emissivePhotometry.ts` — the `opacity`
// envelope below (≤ 0.9) still applies on top, so the peak the camera sees is
// 3,993 / 4,273 cd/m².
//
// ⚠ The MAGNITUDES ARE UNCHANGED from the authored (1.0, 0.7, 0.3) /
// (0.5, 0.85, 1.0), i.e. 4,437 and 4,748 cd/m² at the material. A sprite's
// radiance is `L_emitter × fill`, and neither the vapour cloud's optical depth
// nor its fill of the sprite is known — deriving this as an opaque 3000 K
// surface would land 68× hot.
//
// What DID change is the collision flash's HUE: a 3000 K blackbody (the middle
// of the 2500–5000 K fits to laboratory impact flashes) instead of a hand-picked
// orange. The mined flash stays cyan on purpose — it reads as the laser's own
// light scattered off the ablation plume, not as an incandescent body. See each
// entry's `why` for the full reasoning.
const COLOR_COLLISION = emitterColor("flash_collision");
const COLOR_MINED = emitterColor("flash_mined");

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

  const glowTexture = useMemo<THREE.Texture>(() => {
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

  useEffect(() => () => { glowTexture.dispose(); }, [glowTexture]);

  // ⚠ Built imperatively rather than as a `<spriteMaterial>` JSX element: the
  // pre-exposure registry MUTATES `mat.color` every frame, and R3F re-applies
  // declarative props on every render — so a `color={…}` prop would silently
  // stamp the authored value back over this frame's pre-exposed one. A material
  // under registry control must not also be under JSX control.
  const material = useMemo(() => {
    const m = new THREE.SpriteMaterial({
      map: glowTexture,
      color: type === "collision" ? COLOR_COLLISION : COLOR_MINED,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
    });
    return m;
  }, [glowTexture, type]);

  // D25: register for per-frame pre-exposure, and unregister on unmount — these
  // effects are short-lived and spawn constantly, so a leaked entry would have
  // the registry writing to a disposed material forever.
  useEffect(() => {
    const unregister = registerPreExposedEmissive(material);
    return () => {
      unregister();
      material.dispose();
    };
  }, [material]);

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
      <primitive object={material} attach="material" />
    </sprite>
  );
});

export default FlashEffect;
