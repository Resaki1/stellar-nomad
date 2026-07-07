// Worked per-altitude examples for coverageRaw = 0.2 / 0.45 / 0.85 + shape-field
// flatness stats. Reuses the Monte-Carlo fields from cloudstats.mjs (inlined).
import { execSync } from "node:child_process";

// -- inline the same noise machinery by importing via eval of the other file is
// messy; instead re-implement the minimal parts (same seeds/salts).
function seededRandom(seed) {
  let s = (seed | 0) + 0x6d2b79f5;
  s = Math.imul(s ^ (s >>> 15), s | 1);
  s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
  return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
}
function hash3(x, y, z, salt) {
  return seededRandom(((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) + salt * 1597334677);
}
const ALLIGATOR_RADIUS = 0.9, ALLIGATOR_R2 = ALLIGATOR_RADIUS * ALLIGATOR_RADIUS;
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
const PG_X = [1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0];
const PG_Y = [1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1];
const PG_Z = [0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1];
function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function gradHash(x, y, z, grid, salt) {
  const wx = x < 0 ? x + grid : x >= grid ? x - grid : x;
  const wy = y < 0 ? y + grid : y >= grid ? y - grid : y;
  const wz = z < 0 ? z + grid : z >= grid ? z - grid : z;
  return Math.floor(hash3(wx, wy, wz, salt) * 12) % 12;
}
function dotGrad(g, dx, dy, dz) { return PG_X[g] * dx + PG_Y[g] * dy + PG_Z[g] * dz; }
function perlinSample(px, py, pz, grid, salt = 9999) {
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
const w4 = seedWorleyGrid(4, 1), w8 = seedWorleyGrid(8, 2), w16 = seedWorleyGrid(16, 3),
  w32 = seedWorleyGrid(32, 4), w48 = seedWorleyGrid(48, 5);
const dw4 = seedWorleyGrid(4, 11), dw8 = seedWorleyGrid(8, 12), dw16 = seedWorleyGrid(16, 13);
const wWisp = seedWorleyGrid(8, 41);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mixf = (a, b, t) => a + (b - a) * t;

function baseSampleAt(u, v, w) {
  const sw = worleySample(u * 4, v * 4, w * 4, w4);
  const p = perlinSample(u * 4, v * 4, w * 4, 4);
  const R = sw + p * (1 - sw);
  const s8 = worleySample(u * 8, v * 8, w * 8, w8);
  const s16 = worleySample(u * 16, v * 16, w * 16, w16);
  const s32 = worleySample(u * 32, v * 32, w * 32, w32);
  const s48 = worleySample(u * 48, v * 48, w * 48, w48);
  const fbmG = clamp01(sw * 0.625 + s8 * 0.25 + s16 * 0.125);
  const fbmB = clamp01(s8 * 0.625 + s16 * 0.25 + s32 * 0.125);
  const fbmA = clamp01(s16 * 0.625 + s32 * 0.25 + s48 * 0.125);
  return { R, fbm: fbmG * 0.625 + fbmB * 0.25 + fbmA * 0.125 };
}
function detailSampleAt(u, v, w) {
  return {
    r: worleySample(u * 4, v * 4, w * 4, dw4),
    g: worleySample(u * 8, v * 8, w * 8, dw8),
    b: worleySample(u * 16, v * 16, w * 16, dw16),
    a: 1 - worleySample(u * 8 + 3.1, v * 8 + 1.7, w * 8 + 2.3, wWisp),
  };
}

const N = 200000;
const rng = (() => { let s = 777; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })();
const carvedArr = new Float32Array(N);
const fineR = new Float32Array(N), fineB = new Float32Array(N), fineA = new Float32Array(N);
const colR = new Float32Array(N);
for (let i = 0; i < N; i++) {
  const { R, fbm } = baseSampleAt(rng(), rng(), rng());
  const baseShape = clamp01(R + (fbm - 0.4) * 1.2);
  const d = detailSampleAt(rng(), rng(), rng());
  const cw = 0.6 * d.r + 0.4 * d.g;
  const ct = (1 - cw) * 0.45;
  carvedArr[i] = clamp01((baseShape - ct) / Math.max(1 - ct, 0.0001));
  const f = detailSampleAt(rng(), rng(), rng());
  fineR[i] = f.r; fineB[i] = f.b; fineA[i] = f.a;
  colR[i] = baseSampleAt(rng(), rng(), rng()).R;
}
// R percentiles for representative columns
const colSorted = Float32Array.from(colR).sort();
const q = (p) => colSorted[Math.floor(p * N)];
console.log(`column R (perlin-worley @ columnScale): p10=${q(0.1).toFixed(3)} p25=${q(0.25).toFixed(3)} p50=${q(0.5).toFixed(3)} p75=${q(0.75).toFixed(3)} p90=${q(0.9).toFixed(3)}`);

function heightProfile(alt01, topAlt, cloudType) {
  const stratus = smoothstep(0.0, 0.10, alt01) * (1 - smoothstep(0.15, 0.25, alt01));
  const sc = smoothstep(0.0, 0.25, alt01) * (1 - smoothstep(0.45, 0.65, alt01));
  const cumBase = smoothstep(0.04, 0.16, alt01);
  const fadeStart = topAlt - 0.35;
  const fadeX = clamp01((alt01 - fadeStart) / Math.max(topAlt - fadeStart, 0.0001));
  const cum = cumBase * (1 - fadeX * fadeX);
  const lowerMix = mixf(stratus, sc, smoothstep(0.0, 0.5, cloudType));
  return mixf(lowerMix, cum, smoothstep(0.5, 1.0, cloudType));
}

function shapeStats(profile, K, detailFade) {
  let holes = 0, s = 0, s2 = 0;
  for (let i = 0; i < N; i++) {
    let fine = mixf(fineR[i], fineB[i], Math.pow(clamp01(profile), 2.0));
    const wisp = (1 - smoothstep(0.0, 0.5, clamp01(profile))) * 0.7;
    fine = mixf(fine, fineA[i], wisp);
    const delta = (fine - 0.4) * 0.2 * detailFade;
    const c = clamp01(carvedArr[i] + delta);
    const shape = clamp01(profile - (1 - c) * K);
    if (shape <= 0.0001) holes++;
    s += shape; s2 += shape * shape;
  }
  const mean = s / N, std = Math.sqrt(Math.max(0, s2 / N - mean * mean));
  return { holePct: (100 * holes) / N, mean, std };
}

const K = 0.6; // current staged value
const DT_DENSE_FAR = 0.00075; // 750 m integration cap (scaled units)
console.log("\nWorked examples, K=0.6, detailFade=0 (>=100 km view) — density=shape^0.8*3000, od = density*750m");
for (const raw of [0.2, 0.45, 0.85]) {
  const cov = Math.pow(raw, 0.6);
  const type = smoothstep(0.3, 0.6, cov);
  const covSpan = smoothstep(0.35, 0.7, cov);
  // median column: colSample -> topAlt
  const colMed = q(0.5), colP10 = q(0.1), colP90 = q(0.9);
  const topOf = (c) => 0.45 + smoothstep(0.3, 0.7, c) * 0.5 * covSpan;
  console.log(`\n-- raw=${raw}: coverage=${cov.toFixed(3)} type=${type.toFixed(3)} covSpan=${covSpan.toFixed(3)} topAlt(p10/med/p90 col)=${topOf(colP10).toFixed(3)}/${topOf(colMed).toFixed(3)}/${topOf(colP90).toFixed(3)}`);
  const topAlt = topOf(colMed);
  console.log("alt01 | altKm | hProf | profile | hole% | meanShape (std) | density | od/750m");
  for (const alt of [0.05, 0.08, 0.12, 0.16, 0.25, 0.35, 0.5, 0.65, 0.8, 0.9]) {
    const hp = heightProfile(alt, topAlt, type);
    const profile = cov * hp;
    const st = shapeStats(profile, K, 0);
    const dens = Math.pow(st.mean, 0.8) * 3000;
    const od = dens * DT_DENSE_FAR;
    const altKm = 1 + alt * 13;
    console.log(`${alt.toFixed(2)} | ${altKm.toFixed(1)} | ${hp.toFixed(3)} | ${profile.toFixed(3)} | ${st.holePct.toFixed(1)}% | ${st.mean.toFixed(3)} (${st.std.toFixed(3)}) | ${dens.toFixed(0)} | ${od.toFixed(2)}`);
  }
}

// Field flatness comparison at profile 0.9: K=0.6 vs 1.2 vs Nubis
console.log("\nShape-field contrast at profile=0.90 (detailFade=0):");
for (const [label, fn] of [
  ["ours K=0.6", (c) => clamp01(0.9 - (1 - c) * 0.6)],
  ["ours K=1.2", (c) => clamp01(0.9 - (1 - c) * 1.2)],
  ["nubis     ", (c) => clamp01(c - (1 - 0.9))],
]) {
  let s = 0, s2 = 0, holes = 0;
  for (let i = 0; i < N; i++) { const v = fn(carvedArr[i]); s += v; s2 += v * v; if (v <= 0.0001) holes++; }
  const mean = s / N, std = Math.sqrt(Math.max(0, s2 / N - mean * mean));
  console.log(`${label}: mean=${mean.toFixed(3)} std=${std.toFixed(3)} hole%=${((100 * holes) / N).toFixed(1)} rel-contrast(std/mean)=${(std / mean).toFixed(2)}`);
}
