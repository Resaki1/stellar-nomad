"use client";

import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { shipHealthAtom } from "@/store/store";
import "./DamageVignette.scss";

/**
 * Full-screen red vignette that flashes whenever the ship loses health.
 * Watches `shipHealthAtom` — any decrease triggers the effect regardless of source.
 */
export default function DamageVignette() {
  const health = useAtomValue(shipHealthAtom);
  const prevHealthRef = useRef(health);
  const [active, setActive] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const prev = prevHealthRef.current;
    prevHealthRef.current = health;

    // Only flash when health *decreased*
    if (health < prev) {
      // Intensity scales with damage taken (10 hp = mild, 50+ hp = strong)
      setActive(true);

      // Clear any existing timer so rapid hits extend the flash
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        setActive(false);
        timerRef.current = null;
      }, 500);
    }
  }, [health]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <div
      className={`damage-vignette ${active ? "damage-vignette--active" : ""}`}
    />
  );
}
