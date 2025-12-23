const LCG_MODULUS = 2147483647;
const LCG_MAX = LCG_MODULUS - 1;

function toLcgSeed(n: number): number {
  const u = n >>> 0;
  return (u % LCG_MAX) + 1;
}

export function normalizeSeed(seed: number | string): number {
  if (typeof seed === "number" && Number.isFinite(seed))
    return toLcgSeed(seed | 0);

  const str = String(seed);
  // FNV-1a 32-bit
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return toLcgSeed(h);
}

// Small 32-bit mixing function.
function mix32(n: number): number {
  n |= 0;
  n ^= n >>> 16;
  n = Math.imul(n, 0x7feb352d);
  n ^= n >>> 15;
  n = Math.imul(n, 0x846ca68b);
  n ^= n >>> 16;
  return n | 0;
}

export function hashChunkSeed(
  fieldSeed: number | string,
  cx: number,
  cy: number,
  cz: number
): number {
  let h = normalizeSeed(fieldSeed);
  h = mix32(h ^ cx);
  h = mix32(h ^ cy);
  h = mix32(h ^ cz);
  return toLcgSeed(h);
}

export function hashInstanceId(chunkSeed: number, localIndex: number): number {
  const h = mix32((chunkSeed | 0) ^ (localIndex | 0));
  return h >>> 0;
}
