"use client";

import { useEffect, useRef } from "react";

/** Deterministic PRNG so the sky is the same on every visit. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const M_LIMIT = 6.5;

/** Visual magnitude with naked-eye counts: N(<m) ∝ 10^(0.5 m). */
function sampleMagnitude(u: number): number {
  return Math.log10(1 + u * (10 ** (0.5 * M_LIMIT) - 1)) / 0.5;
}

/** Star tint by a temperature-like parameter, 0 = hot blue-white, 1 = cool orange. */
function tint(t: number): [number, number, number] {
  if (t < 0.5) {
    const k = t / 0.5;
    return [190 + 65 * k, 208 + 42 * k, 255];
  }
  const k = (t - 0.5) / 0.5;
  return [255, 250 - 45 * k, 255 - 105 * k];
}

function draw(canvas: HTMLCanvasElement): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#010204";
  ctx.fillRect(0, 0, w, h);

  const rnd = mulberry32(0x5eed);
  // Galactic band: a tilted great circle across the frame.
  const angle = -0.42;
  const cx = w * 0.62;
  const cy = h * 0.42;
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const span = Math.hypot(w, h);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  const glow = ctx.createLinearGradient(0, -h * 0.22, 0, h * 0.22);
  glow.addColorStop(0, "rgba(150,160,190,0)");
  glow.addColorStop(0.5, "rgba(150,160,190,0.05)");
  glow.addColorStop(1, "rgba(150,160,190,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(-span, -h * 0.22, span * 2, h * 0.44);
  ctx.restore();

  const gauss = (): number => (rnd() + rnd() + rnd() - 1.5) / 1.5;
  const bandStars = Math.round((w * h) / 260);
  for (let i = 0; i < bandStars; i++) {
    const along = (rnd() - 0.5) * span;
    const off = gauss() * h * 0.12;
    const x = cx + ux * along - uy * off;
    const y = cy + uy * along + ux * off;
    ctx.fillStyle = `rgba(205,212,230,${0.04 + rnd() * 0.12})`;
    ctx.fillRect(x, y, 0.8, 0.8);
  }

  const stars = Math.round((w * h) / 900);
  for (let i = 0; i < stars; i++) {
    const m = sampleMagnitude(rnd());
    const flux = 10 ** (-0.4 * (m - M_LIMIT));
    const x = rnd() * w;
    const y = rnd() * h;
    const [r, g, b] = tint(Math.min(1, Math.max(0, gauss() * 0.35 + 0.45)));
    const a = Math.min(1, 0.18 + 0.05 * flux);
    const radius = Math.min(1.6, 0.45 + 0.09 * Math.sqrt(flux));
    ctx.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},${a})`;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Static star field for the title and loading screens: a 2D canvas drawn once per resize. */
export default function StarBackdrop() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    draw(canvas);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => draw(canvas), 150);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (timer) clearTimeout(timer);
    };
  }, []);
  return <canvas ref={ref} className="shell__backdrop" aria-hidden />;
}
