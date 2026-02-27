import type { SizeDef } from "@/sim/systemTypes";

export type Rng = {
  nextFloat: () => number;
};

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

/**
 * Standard normal (mean 0, stddev 1) via Box–Muller.
 */
function randomNormal(rng: Rng): number {
  // Avoid 0 which would cause log(0).
  let u = 0;
  let v = 0;
  while (u === 0) u = rng.nextFloat();
  while (v === 0) v = rng.nextFloat();

  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

export function sampleRadiusM(rng: Rng, size: SizeDef): number {
  const min = Math.max(0.0001, size.minRadiusM);
  const max = Math.max(min, size.maxRadiusM);

  switch (size.distribution) {
    case "uniform": {
      return min + (max - min) * rng.nextFloat();
    }

    case "logNormal": {
      const sigma =
        typeof size.params?.sigma === "number" ? size.params.sigma : 1.0;

      // Pick mu so that the median is roughly the geometric mean of min/max.
      const mu = Math.log(Math.sqrt(min * max));

      // Try a few times to stay within bounds without harsh clipping.
      for (let i = 0; i < 6; i++) {
        const z = randomNormal(rng);
        const r = Math.exp(mu + sigma * z);
        if (r >= min && r <= max) return r;
      }

      // Fallback to clamped value.
      const z = randomNormal(rng);
      return clamp(Math.exp(mu + sigma * z), min, max);
    }

    case "powerLaw": {
      // Typical asteroid-ish distributions often have alpha ~ 2..4 depending on interpretation.
      const alpha =
        typeof size.params?.alpha === "number" ? size.params.alpha : 2.5;

      const u = rng.nextFloat();

      // Inverse CDF sampling for power-law p(r) ∝ r^-alpha on [min, max]
      if (Math.abs(alpha - 1.0) < 1e-6) {
        // alpha == 1 special case
        return min * Math.pow(max / min, u);
      }

      const oneMinusA = 1.0 - alpha;
      const minPow = Math.pow(min, oneMinusA);
      const maxPow = Math.pow(max, oneMinusA);
      const rPow = minPow + (maxPow - minPow) * u;
      return Math.pow(rPow, 1.0 / oneMinusA);
    }

    default: {
      // Should never happen if JSON is correct; fall back to uniform.
      return min + (max - min) * rng.nextFloat();
    }
  }
}
