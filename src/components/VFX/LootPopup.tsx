"use client";

import { memo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import "./LootPopup.scss";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------
const POPUP_LIFETIME_S = 2.0;
const FLOAT_SPEED_M = 25; // meters/s upward drift

type LootEntry = {
  icon: string;
  name: string;
  amount: number;
};

type Props = {
  position: [number, number, number];
  loot: LootEntry[];
  onComplete: () => void;
};

const LootPopup = memo(function LootPopup({
  position,
  loot,
  onComplete,
}: Props) {
  const groupRef = useRef<THREE.Group>(null!);
  const elapsedRef = useRef(0);
  const doneRef = useRef(false);

  useFrame((_, delta) => {
    if (doneRef.current) return;

    const g = groupRef.current;
    if (!g) return;

    elapsedRef.current += delta;

    if (elapsedRef.current >= POPUP_LIFETIME_S) {
      doneRef.current = true;
      g.visible = false;
      onComplete();
      return;
    }

    // Float upward
    g.position.y += FLOAT_SPEED_M * delta;
  });

  const progress = elapsedRef.current / POPUP_LIFETIME_S;
  // CSS handles the fade via the wrapper div

  return (
    <group ref={groupRef} position={position}>
      <Html
        center
        sprite
        style={{
          pointerEvents: "none",
          userSelect: "none",
          whiteSpace: "nowrap",
        }}
      >
        <div className="loot-popup">
          {loot.map((entry, i) => (
            <span key={i} className="loot-popup__text">
              +{entry.amount} {entry.icon ? `${entry.icon} ` : ""}{entry.name}
            </span>
          ))}
        </div>
      </Html>
    </group>
  );
});

export default LootPopup;
