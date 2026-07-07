// Monte-Carlo reproduction of the Stellar Nomad cloud marcher's noise chain
// (ported 1:1 from noiseVolumes.ts + earthClouds.ts, current working tree).
// Computes distributions of baseShape, baseShapeCarved(+fine), and the
// hole-fraction of shape = saturate(profile - (1-carved)*K) for K=0.6 / 1.2.

// ---- PRNG / hash (Mulberry32, as noiseVolumes.ts) ----
function seededRandom(seed) {
  let s = (seed | 0) + 0x6d2b79f5;
  s = Math.imul(s ^ (s >>> 15), s | 1);
  s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
  return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
}
function hash3(x, y, z, salt) {
  return seededRandom(((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) + salt * 1597334677);
}

// ---- Worley / Alligator ----
const ALLIGATOR_RADIUS = 0.9;
const ALLIGATOR_R2 = ALLIGATOR_RADIUS * ALLIGATOR_RADIUS;
function seedWorleyGrid(grid, salt) {
  const n = grid * grid * grid;
  const fx = new Float32Array(n), fy = new Float32Array(n), fz = new Float32Array(n);
  for (let z = 0; z < grid; z++) for (let y = 0; y < grid; y++) for (let x = 0; x < grid; x++) {
    const idx = (z * grid + y) * grid + x;
    fx[idx] = x + hash3(x, y, z, salt);
    fy[idx] = y + hash3(x + 1, y + 3, z + 7, salt);
    fz[idx] = z + hash3(x + 2, y + 5, z + 11, salt);
  }
  return { fx, fy, fz, grid };
}
function worleySample(px, py, pz, w) {
  const grid = w.grid;
  const cx = Math.floor(px), cy = Math.floor(py), cz = Math.floor(pz);
  let maxCap = 0;
  for (let dz = -1; dz <= 1; dz++) {
    const nz = cz + dz; const wz = nz < 0 ? nz + grid : nz >= grid ? nz - grid : nz; const offZ = nz - wz;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = cy + dy; const wy = ny < 0 ? ny + grid : ny >= grid ? ny - grid : ny; const offY = ny - wy;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx; const wx = nx < 0 ? nx + grid : nx >= grid ? nx - grid : nx; const offX = nx - wx;
        const fIdx = (wz * grid + wy) * grid + wx;
        const ddx = px - (w.fx[fIdx] + offX), ddy = py - (w.fy[fIdx] + offY), ddz = pz - (w.fz[fIdx] + offZ);
        const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
        if (d2 < ALLIGATOR_R2) {
          const t = Math.sqrt(d2) / ALLIGATOR_RADIUS;
          const cap = 1 - (3 * t * t - 2 * t * t * t);
          if (cap > maxCap) maxCap = cap;
        }
      }
    }
  }
  return maxCap;
}

// ---- Perlin ----
const PG_X = [1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0];
const PG_Y = [1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1];
const PG_Z = [0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1];
const SALT_PERLIN = 9999;
function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function gradHash(x, y, z, grid, salt) {
  const wx = x < 0 ? x + grid : x >= grid ? x - grid : x;
  const wy = y < 0 ? y + grid : y >= grid ? y - grid : y;
  const wz = z < 0 ? z + grid : z >= grid ? z - grid : z;
  return Math.floor(hash3(wx, wy, wz, salt) * 12) % 12;
}
function dotGrad(g, dx, dy, dz) { return PG_X[g] * dx + PG_Y[g] * dy + PG_Z[g] * dz; }
function perlinSample(px, py, pz, grid, salt = SALT_PERLIN) {
  const cx = Math.floor(px), cy = Math.floor(py), cz = Math.floor(pz);
  const dx = px - cx, dy = py - cy, dz = pz - cz;
  const fx = fade(dx), fy = fade(dy), fz = fade(dz);
  const g000 = dotGrad(gradHash(cx, cy, cz, grid, salt), dx, dy, dz);
  const g100 = dotGrad(gradHash(cx + 1, cy, cz, grid, salt), dx - 1, dy, dz);
  const g010 = dotGrad(gradHash(cx, cy + 1, cz, grid, salt), dx, dy - 1, dz);
  const g110 = dotGrad(gradHash(cx + 1, cy + 1, cz, grid, salt), dx - 1, dy - 1, dz);
  const g001 = dotGrad(gradHash(cx, cy, cz + 1, grid, salt), dx, dy, dz - 1);
  const g101 = dotGrad(gradHash(cx + 1, cy, cz + 1, grid, salt), dx - 1, dy, dz - 1);
  const g011 = dotGrad(gradHash(cx, cy + 1, cz + 1, grid, salt), dx, dy - 1, dz - 1);
  const g111 = dotGrad(gradHash(cx + 1, cy + 1, cz + 1, grid, salt), dx - 1, dy - 1, dz - 1);
  const lx00 = g000 + fx * (g100 - g000), lx10 = g010 + fx * (g110 - g010);
  const lx01 = g001 + fx * (g101 - g001), lx11 = g011 + fx * (g111 - g011);
  const ly0 = lx00 + fy * (lx10 - lx00), ly1 = lx01 + fy * (lx11 - lx01);
  return (ly0 + fz * (ly1 - ly0)) * 0.5 + 0.5;
}

// ---- grids (salts per noiseVolumes.ts) ----
const w4 = seedWorleyGrid(4, 1), w8 = seedWorleyGrid(8, 2), w16 = seedWorleyGrid(16, 3),
  w32 = seedWorleyGrid(32, 4), w48 = seedWorleyGrid(48, 5);
const dw4 = seedWorleyGrid(4, 11), dw8 = seedWorleyGrid(8, 12), dw16 = seedWorleyGrid(16, 13);
const wWisp = seedWorleyGrid(8, 41);

// crease is identity (BILLOW_CREASE_POWER = 1)
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;

// Base volume sample at a random point (units: one tile = [0,1)^3)
function baseSampleAt(u, v, w) {
  const R = (() => {
    const sw = worleySample(u * 4, v * 4, w * 4, w4);
    const p = perlinSample(u * 4, v * 4, w * 4, 4);
    return sw + p * (1 - sw); // perlin-worley hybrid
  })();
  const s4 = worleySample(u * 4, v * 4, w * 4, w4);
  const s8 = worleySample(u * 8, v * 8, w * 8, w8);
  const s16 = worleySample(u * 16, v * 16, w * 16, w16);
  const s32 = worleySample(u * 32, v * 32, w * 32, w32);
  const s48 = worleySample(u * 48, v * 48, w * 48, w48);
  const fbmG = clamp01(s4 * 0.625 + s8 * 0.25 + s16 * 0.125);
  const fbmB = clamp01(s8 * 0.625 + s16 * 0.25 + s32 * 0.125);
  const fbmA = clamp01(s16 * 0.625 + s32 * 0.25 + s48 * 0.125);
  const fbm = fbmG * 0.625 + fbmB * 0.25 + fbmA * 0.125; // marcher's baseFbm
  return { R, fbm };
}
// Detail volume at a random point
function detailSampleAt(u, v, w) {
  const r = worleySample(u * 4, v * 4, w * 4, dw4);
  const g = worleySample(u * 8, v * 8, w * 8, dw8);
  const b = worleySample(u * 16, v * 16, w * 16, dw16);
  // wisp: skip the expensive curl (distribution of 1-worley is what matters)
  const a = 1 - worleySample(u * 8 + 3.1, v * 8 + 1.7, w * 8 + 2.3, wWisp);
  return { r, g, b, a };
}

// ---- shader constants (current working tree) ----
const BASE_FBM_BILLOW = 1.2, BASE_FBM_BIAS = 0.4;
const BILLOW_CARVE = 0.45;
const FINE_CARVE_STRENGTH = 0.2, FINE_CARVE_BIAS = 0.4, FINE_CARVE_GRADE_POW = 2.0;
const WISP_AMOUNT = 0.7, WISP_PROFILE_LO = 0.0, WISP_PROFILE_HI = 0.5;
const DENSITY_GAMMA = 0.8;

const N = 400000;
const rng = (() => { let s = 12345; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })();

// Sample the full chain N times; store carvedNoFine and fine components.
const baseShapes = new Float32Array(N);
const carvedArr = new Float32Array(N);      // after macro billow carve (no fine)
const fineR = new Float32Array(N), fineB = new Float32Array(N), fineA = new Float32Array(N);
let sumR = 0, sumFbm = 0, sumCw = 0;
for (let i = 0; i < N; i++) {
  const { R, fbm } = baseSampleAt(rng(), rng(), rng());
  sumR += R; sumFbm += fbm;
  const baseShape = clamp01(R + (fbm - BASE_FBM_BIAS) * BASE_FBM_BILLOW);
  baseShapes[i] = baseShape;
  const d = detailSampleAt(rng(), rng(), rng());
  const carveWorley = 0.6 * d.r + 0.4 * d.g;
  sumCw += carveWorley;
  const carveThresh = (1 - carveWorley) * BILLOW_CARVE;
  carvedArr[i] = clamp01((baseShape - carveThresh) / Math.max(1 - carveThresh, 0.0001));
  const f = detailSampleAt(rng(), rng(), rng());
  fineR[i] = f.r; fineB[i] = f.b; fineA[i] = f.a;
}

function stats(arr) {
  let s = 0, s2 = 0, mn = 1e9, mx = -1e9, z = 0, one = 0;
  for (const v of arr) { s += v; s2 += v * v; if (v < mn) mn = v; if (v > mx) mx = v; if (v <= 0.0001) z++; if (v >= 0.9999) one++; }
  const n = arr.length, mean = s / n;
  return { mean, std: Math.sqrt(Math.max(0, s2 / n - mean * mean)), min: mn, max: mx, pctZero: (100 * z) / n, pctOne: (100 * one) / n };
}
function pctile(arr, ps) {
  const a = Float32Array.from(arr).sort();
  return ps.map((p) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]);
}
const fmt = (o) => Object.entries(o).map(([k, v]) => `${k}=${typeof v === "number" ? v.toFixed(3) : v}`).join(" ");

console.log("== raw fields ==");
console.log("base R (perlin-worley):", (sumR / N).toFixed(3), " baseFbm:", (sumFbm / N).toFixed(3), " carveWorley(0.6r+0.4g):", (sumCw / N).toFixed(3));
console.log("baseShape (dilated):   ", fmt(stats(baseShapes)), " p5/p25/p50/p75/p95:", pctile(baseShapes, [5, 25, 50, 75, 95]).map((v) => v.toFixed(2)).join("/"));
console.log("carved (macro only):   ", fmt(stats(carvedArr)), " p5/p25/p50/p75/p95:", pctile(carvedArr, [5, 25, 50, 75, 95]).map((v) => v.toFixed(2)).join("/"));

// carvedFinal at a given profile (fine carve depends on profile via grading+wisp)
function carvedFinal(i, profile, detailFade) {
  let fine = mix(fineR[i], fineB[i], Math.pow(clamp01(profile), FINE_CARVE_GRADE_POW));
  const wisp = (1 - smoothstep(WISP_PROFILE_LO, WISP_PROFILE_HI, clamp01(profile))) * WISP_AMOUNT;
  fine = mix(fine, fineA[i], wisp);
  const delta = (fine - FINE_CARVE_BIAS) * FINE_CARVE_STRENGTH * detailFade;
  return clamp01(carvedArr[i] + delta);
}

console.log("\n== hole fraction P(shape==0) and mean shape/density, by profile and K ==");
console.log("profile |   K=0.6 hole%  meanShape  |  K=1.2 hole%  meanShape   (detailFade=1)");
for (const profile of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) {
  const row = [profile.toFixed(2)];
  for (const K of [0.6, 1.2]) {
    let holes = 0, s = 0;
    for (let i = 0; i < N; i++) {
      const c = carvedFinal(i, profile, 1);
      const shape = clamp01(profile - (1 - c) * K);
      if (shape <= 0.0001) holes++;
      s += shape;
    }
    row.push(`${((100 * holes) / N).toFixed(1)}%  ${(s / N).toFixed(3)}`);
  }
  console.log(row.join("   |   "));
}

console.log("\n== same with detailFade=0 (march distance >= 100 km — the screenshot regime) ==");
console.log("profile |   K=0.6 hole%  meanShape  |  K=1.2 hole%  meanShape");
for (const profile of [0.2, 0.4, 0.6, 0.8, 0.9, 1.0]) {
  const row = [profile.toFixed(2)];
  for (const K of [0.6, 1.2]) {
    let holes = 0, s = 0;
    for (let i = 0; i < N; i++) {
      const c = clamp01(carvedArr[i]); // fine faded out entirely
      const shape = clamp01(profile - (1 - c) * K);
      if (shape <= 0.0001) holes++;
      s += shape;
    }
    row.push(`${((100 * holes) / N).toFixed(1)}%  ${(s / N).toFixed(3)}`);
  }
  console.log(row.join("   |   "));
}

// Nubis comparison: density = saturate(carved - (1 - profile))
console.log("\n== Nubis-form comparison: shape_nubis = saturate(carved - (1-profile)), detailFade=0 ==");
console.log("profile | hole%  meanShape");
for (const profile of [0.2, 0.4, 0.6, 0.8, 0.9, 1.0]) {
  let holes = 0, s = 0;
  for (let i = 0; i < N; i++) {
    const shape = clamp01(carvedArr[i] - (1 - profile));
    if (shape <= 0.0001) holes++;
    s += shape;
  }
  console.log(`${profile.toFixed(2)}   |  ${((100 * holes) / N).toFixed(1)}%  ${(s / N).toFixed(3)}`);
}

// topAlt distribution in a dense region (coverage >= 0.7 -> covSpan = 1)
console.log("\n== topAlt distribution (covSpan=1): topAlt = 0.45 + smoothstep(0.3,0.7,R_col)*0.5 ==");
{
  const tops = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const { R } = baseSampleAt(rng(), rng(), rng());
    tops[i] = 0.45 + smoothstep(0.3, 0.7, R) * 0.5;
  }
  const st = stats(tops);
  console.log(fmt(st), " p5/p25/p50/p75/p95:", pctile(tops, [5, 25, 50, 75, 95]).map((v) => v.toFixed(3)).join("/"));
  let above9 = 0, below6 = 0;
  for (const v of tops) { if (v > 0.9) above9++; if (v < 0.6) below6++; }
  console.log(`P(topAlt>0.90) = ${((100 * above9) / N).toFixed(1)}%   P(topAlt<0.60) = ${((100 * below6) / N).toFixed(1)}%`);
}

// Worked examples: coverage raw 0.2 / 0.45 / 0.85
console.log("\n== worked examples ==");
for (const raw of [0.2, 0.45, 0.85]) {
  const cov = Math.pow(raw, 0.6);
  const type = smoothstep(0.3, 0.6, cov);
  const covSpan = smoothstep(0.35, 0.7, cov);
  console.log(`raw=${raw} -> coverage=${cov.toFixed(3)} cloudType=${type.toFixed(3)} covSpan=${covSpan.toFixed(3)}`);
}
