import * as THREE from "three";

// =============================================================================
// Synthetic Weather Map v2 — the "genus test chart" (CLOUD_TYPES_PLAN.md
// Phase 1). A procedurally generated equirect RGBA control stack that stands in
// for the future baked ERA5 map (Phase 4), so the marcher/shell/light-volume
// v2 path (Phase 1b) can be exercised with a KNOWN input before any real data
// exists. Behind the WEATHER_V2 flag (cloudShared.ts); OFF by default.
//
// Channels (all LOW-FREQUENCY control fields; sub-grid detail stays procedural
// in the marcher's 3D noise — §4.1):
//   R = coverage      low+mid cloud coverage 0-1 (air-mass FBM × mesoscale cell
//                     mask WITH TRUE-ZERO LANES — the §3.6 H3 organization the
//                     current single-octave system lacks)
//   G = convectivity  0 = layered/stratiform … 1 = cellular/convective. THE
//                     type axis (replaces coverage-derived cloudType). Its own
//                     INDEPENDENT low-freq field → type varies independently of
//                     coverage (fixes the binary-border / two-looks problem).
//   B = topHeight     cloud-top altitude, normalized 0-1 over 0-18 km. Its own
//                     independent field, mapped LINEARLY from noise (the
//                     anti-bimodal rule — no smoothstep sharpening, §4.2/§3.6 H4).
//   A = cirrus        high-layer (Ci/Cs) coverage 0-1, for the Phase 5 shell.
//
// A dedicated GENUS TEST CHART band (see CHART_V_LO/HI) lays the whole
// (convectivity × topHeight) space out as a 2D atlas at fixed coverage, so a
// fly-over shows every genus side by side and type transitions can be judged
// directly. Inspect all of this at /dev/weather-map.
//
// RESOLUTION CEILING (surfaced for Phase 4): at 2048×1024 one texel ≈ 20 km at
// the equator, so this map CANNOT carry true 10-40 km Sc cells — the mesoscale
// octave here is coarser (hundreds of km) purely to prove the channel + the
// true-zero-lane mechanism. The real bake either needs ≥4096 width OR must
// synthesize the 10-40 km cells in marcher-space from a coverage "cellularity"
// hint (as the Phase-F MESOSCALE_TEST did in 3D). Decide in Phase 4.
// =============================================================================

const WIDTH = 2048;
const HEIGHT = 1024;

// Genus test-chart band (equirect v range). A horizontal strip near the top.
const CHART_V_LO = 0.08;
const CHART_V_HI = 0.24;

// Mesoscale cell mask: below LANE_LO → clear-sky lane (coverage forced to 0),
// above LANE_HI → cell interior (coverage unmodulated). See §3.6 H3.
// Tuned (2026-07-06) against the normalized cell field for ~24% clear sky and
// dense cells reaching ~0.8 coverage (a properly cloudy test Earth, verified
// numerically) — the earlier 0.42/0.72 left the map ~60% clear.
const MESO_LANE_LO = 0.3;
const MESO_LANE_HI = 0.6;

// ── Cylinder-periodic 3D value noise ──────────────────────────────────────
// Sampled on a cylinder (u → circle, v → axis) so the field is SEAMLESS across
// the anti-meridian (u = 0 ≡ 1) — no discontinuity line in the clouds. Plain
// hash-based value noise; quality is ample for a test chart.
function hash3(ix: number, iy: number, iz: number): number {
  const s = Math.sin(ix * 127.1 + iy * 311.7 + iz * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

function smootherstep(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function valueNoise3(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const ux = smootherstep(x - ix);
  const uy = smootherstep(y - iy);
  const uz = smootherstep(z - iz);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const c00 = lerp(hash3(ix, iy, iz), hash3(ix + 1, iy, iz), ux);
  const c10 = lerp(hash3(ix, iy + 1, iz), hash3(ix + 1, iy + 1, iz), ux);
  const c01 = lerp(hash3(ix, iy, iz + 1), hash3(ix + 1, iy, iz + 1), ux);
  const c11 = lerp(hash3(ix, iy + 1, iz + 1), hash3(ix + 1, iy + 1, iz + 1), ux);
  return lerp(lerp(c00, c10, uy), lerp(c01, c11, uy), uz);
}

// FBM on the cylinder. `freq` = longitudinal cycles around the planet; `seedZ`
// decorrelates independent channels. `u,v ∈ [0,1)`.
function fbmCyl(
  u: number,
  v: number,
  freq: number,
  octaves: number,
  seedZ: number,
): number {
  const ang = 2 * Math.PI * u;
  const cx = Math.cos(ang);
  const cz = Math.sin(ang);
  let sum = 0;
  let amp = 0.5;
  let f = freq;
  for (let o = 0; o < octaves; o++) {
    // Circle radius = f → 2πf cells around 2π rad of longitude = f cells/rad.
    // Latitude spans π rad, so the z coord must run v·f·π (not v·f) to give
    // f cells/rad there too → ISOTROPIC cells. Without the π the field is π×
    // anisotropic (cells π× taller N-S) → pole-converging vertical stripes,
    // the "melon" (measured ratio 3.3 → 1.05 with the π). The seed rides z so
    // each channel samples a different slab (seeds spaced ≫ the max z reach
    // f·π so channels stay decorrelated).
    sum += amp * valueNoise3(cx * f, cz * f, v * f * Math.PI + seedZ);
    f *= 2;
    amp *= 0.5;
  }
  return sum; // ≈ [0,1)
}

let cached: THREE.DataTexture | null = null;

/**
 * Process-lifetime singleton (getAtmosphereLUTs / getStbnTexture pattern —
 * NOT routed through the per-tier texture records; never reassigned on a live
 * material). Generated on first call (~a few hundred ms at 2048×1024).
 */
export function getSyntheticWeatherMapV2(): THREE.DataTexture {
  if (cached) return cached;

  const data = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let j = 0; j < HEIGHT; j++) {
    const v = (j + 0.5) / HEIGHT;
    for (let i = 0; i < WIDTH; i++) {
      const u = (i + 0.5) / WIDTH;

      // ── Base procedural weather (independent fields) ──
      // Coverage: large air masses (freq 3) shaped to leave genuine clear sky.
      const airMass = fbmCyl(u, v, 3, 4, 0.0);
      let coverage = Math.min(1, Math.max(0, (airMass - 0.28) * 2.6));
      // Mesoscale organization with TRUE-ZERO LANES: a CLEAN cellular field
      // (freq 45, only 2 octaves so cells stay distinct — 3+ octaves at this
      // resolution produced near-Nyquist speckle, not cells). Multiply coverage
      // by a lane mask so dense decks break into cells with clear lanes.
      // (Cells here are coarse ~hundreds-of-km; real 10-40 km is the Phase-4
      // RESOLUTION FORK — see header note.)
      // NORMALIZE the 2-octave fbm to ~[0,1] (÷ max amp-sum 0.5+0.25=0.75) so
      // the fixed lane thresholds behave regardless of octave count. (The 3→2
      // octave "less grain" change dropped the un-normalized mean below
      // MESO_LANE_LO and collapsed coverage — 2026-07-06.)
      const cell = fbmCyl(u, v, 45, 2, 1000.0) / 0.75;
      const laneMask = smootherstep(
        Math.min(
          1,
          Math.max(0, (cell - MESO_LANE_LO) / (MESO_LANE_HI - MESO_LANE_LO)),
        ),
      );
      coverage *= laneMask;

      // Convectivity: INDEPENDENT low-freq field (different seed) → the type
      // axis is decoupled from coverage. Contrast-stretched to span the FULL
      // [0,1] range (LINEAR — the anti-bimodal rule, §3.6 H4). Tuned 2026-07-08
      // to a natural mix (~27% thin-stratiform / ~35% mid / ~19% deep-convective,
      // verified): the earlier (x−0.3)·1.8 piled convectivity at mean 0.26 → the
      // planet was ~95% mid-level stratiform slabs, so the Phase-2 genus decode
      // was CORRECT but had almost no range to show (only 5.5% deep-convective,
      // and from above the base/thickness genus signal is hidden anyway).
      let convectivity = fbmCyl(u, v, 5, 3, 2000.0);
      convectivity = Math.min(1, Math.max(0, (convectivity - 0.3) * 2.4));

      // topHeight: own independent field, contrast-stretched to REACH 0 so LOW
      // clouds exist (the [0,1]→[0.10,0.95] topHeightToTopAlt maps topHeight 0 →
      // ~1.6 km base — real low stratus/cumulus, absent when the floor was 0.45).
      // Then a MILD positive correlation with convectivity (+0.30·conv): deep
      // convection has higher tops (Earth-like) AND the towers poke up where
      // they read from above. Kept mild (0.75 independent / 0.30 conv) so the
      // axes stay largely decoupled — no binary border. LINEAR throughout.
      // (NOTE: distinct from the REMOVED coverage→topHeight coupling of
      // 2026-07-06 — that conflated topHeight with a channel that can COLLAPSE
      // to zero; convectivity is a stable input field that never collapses, so
      // coupling to it is safe.)
      const topRaw = fbmCyl(u, v, 4, 3, 3000.0);
      const topIndep = Math.min(1, Math.max(0, (topRaw - 0.3) * 2.6));
      let topHeight = Math.min(
        1,
        Math.max(0, topIndep * 0.75 + convectivity * 0.3),
      );

      // Cirrus: independent high-cloud coverage (broad, wispy).
      let cirrus = fbmCyl(u, v, 3, 3, 4000.0);
      cirrus = Math.min(1, Math.max(0, (cirrus - 0.45) * 2.2));

      // ── Genus test chart band: (convectivity × topHeight) atlas at fixed,
      // fully-closed coverage so every genus is visible side by side. ──
      if (v >= CHART_V_LO && v <= CHART_V_HI) {
        const band = (v - CHART_V_LO) / (CHART_V_HI - CHART_V_LO); // 0..1 up band
        coverage = 0.85;
        convectivity = u; // sweeps 0→1 across longitude
        topHeight = band; // sweeps 0→1 up the band
        cirrus = 0;
      }

      const o = (j * WIDTH + i) * 4;
      data[o] = Math.round(coverage * 255);
      data[o + 1] = Math.round(convectivity * 255);
      data[o + 2] = Math.round(topHeight * 255);
      data[o + 3] = Math.round(cirrus * 255);
    }
  }

  const tex = new THREE.DataTexture(data, WIDTH, HEIGHT, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace; // data, not colour — no sRGB decode
  tex.wrapS = THREE.RepeatWrapping; // longitude wraps (seamless by construction)
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true; // shell/far consumers auto-mip; marcher forces L0
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  cached = tex;
  return tex;
}
