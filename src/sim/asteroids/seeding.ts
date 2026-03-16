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

// Murmur3-style 32-bit finalizer. Provides good avalanche for a single value.
function mix32(n: number): number {
  n |= 0;
  n ^= n >>> 16;
  n = Math.imul(n, 0x85ebca6b);
  n ^= n >>> 13;
  n = Math.imul(n, 0xc2b2ae35);
  n ^= n >>> 16;
  return n | 0;
}

export function hashChunkSeed(
  fieldSeed: number | string,
  cx: number,
  cy: number,
  cz: number
): number {
  // Combine field seed with each coordinate using different large primes as
  // salts so that identical coordinate values in different dimensions don't
  // cancel each other out (as plain XOR would).
  let h = normalizeSeed(fieldSeed) | 0;
  h = Math.imul(h, 0x9e3779b9) + mix32((cx | 0) + 0x517cc1b7) | 0;
  h = Math.imul(h, 0x9e3779b9) + mix32((cy | 0) + 0x6c078965) | 0;
  h = Math.imul(h, 0x9e3779b9) + mix32((cz | 0) + 0x2545f491) | 0;
  h = mix32(h);
  return toLcgSeed(h);
}

export function hashInstanceId(chunkSeed: number, localIndex: number): number {
  // Combine chunkSeed and localIndex with independent mixing so low-bit-only
  // differences in localIndex spread across the full 32-bit range.
  // Step 1: Widen the localIndex contribution by multiplying by a large odd
  // constant (related to the golden ratio / Weyl sequence), then add
  // chunkSeed. Addition preserves more entropy than XOR for correlated inputs.
  let h = (Math.imul(localIndex | 0, 0x9e3779b9) + (chunkSeed | 0)) | 0;
  // Step 2: Full murmur3 finalizer to avalanche all bits.
  h = mix32(h);
  return h >>> 0;
}
