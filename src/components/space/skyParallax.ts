/**
 * SKY PARALLAX — when the environment cube and the sky's light probe have gone
 * stale because the ship moved.
 *
 * See [`docs/STAR_RENDERING_PLAN.md`](../../../docs/STAR_RENDERING_PLAN.md) §16 (R7f).
 *
 * R7f makes every star's DIRECTION a function of the observer's position, so two
 * things that were previously one-shot become continuous:
 *
 *  • the **environment cube** (`skySpecular`), which the hull's reflections and its
 *    entire IBL come from;
 *  • the **catalogue half of the SH probe** (`skyIrradiance`), which is the only
 *    carrier of the star catalogue's 19.5% of sky flux onto every planet's night
 *    side — `CelestialBody` renders `skyIrradianceNode` from it every frame, and the
 *    environment cube never reaches the scaled scene.
 *
 * ── 🔑 THE THRESHOLDS ARE DERIVED, AND FROM DIFFERENT LIMITS ─────────────────
 * Both scale with `d_ref`, the distance to the nearest star the SPRITE tier is still
 * drawing, because that is the star whose direction moves fastest per unit of travel
 * (Δθ ≈ Δx / d).
 *
 *  • CUBE — an ANGULAR limit. A face is 90° over `SKY_CUBE_SIZE` px, so one texel is
 *    0.352° = 6.14e-3 rad; once the nearest sprite has moved a texel the cube is
 *    visibly wrong. ⇒ `Δ > 6.14e-3 · d_ref`, about 0.026 ly for a 4.24 ly nearest
 *    star.
 *  • SH — a PHOTOMETRIC limit, and much looser, because SH-L2 is a 9-coefficient
 *    low-pass that cannot resolve a texel of anything. What it does carry is
 *    illuminance, and `dE/E = 2Δ/d`, so a 0.14-stop tolerance on the nearest
 *    sprite's contribution gives `Δ > 0.05 · d_ref` — 8.2× the cube's threshold,
 *    which is what keeps a 0.84 ms main-thread re-bake off most of the frames that
 *    trigger a capture.
 *
 * ⚠⚠ `d_ref` EXCLUDES THE PROMOTED STARS, and that is not a detail. As you approach
 * your destination its distance goes to zero, so a naive nearest-star rule would
 * demand a re-capture every frame at exactly the moment you are moving fastest. But
 * a star that close is a `<Star>` disc drawn from its live position — its parallax is
 * exact every frame and contributes nothing to the cube's staleness. Using the
 * (POOL+1)-th nearest instead keeps the rule bounded through an arrival.
 *
 * ⚠ THE CAPTURE IS AMORTISED TO ONE FACE PER FRAME, so a re-capture cannot be
 * started while one is in flight — the threshold would fire every ~3 frames at 1 ly/s
 * and the sequence would restart for ever, never completing. `pendingFace === 0` is
 * the gate. Worst-case staleness is then one full sequence's worth of travel rather
 * than one threshold's, which is the honest cost of amortising.
 */

import { LY_IN_KM } from "@/sim/units";
import { getNearbyStars } from "@/sim/nearbyStars";
import {
  SKY_CUBE_SIZE,
  invalidateSkyCube,
  isSkyCubeCaptured,
  skySpecularStatus,
} from "@/components/space/skySpecular";
import {
  getStarFieldCamPosLy,
  rebakeCatalogueShFor,
} from "@/components/Stars/StarField";

/** One cube texel, radians. A face is 90° over `SKY_CUBE_SIZE` pixels. */
const CUBE_TEXEL_RAD = (Math.PI / 2) / SKY_CUBE_SIZE;

/**
 * Fractional distance change the SH probe tolerates. `dE/E = 2Δ/d`, so 0.05 is
 * 0.14 stops on the nearest sprite's contribution to a 9-coefficient low-pass.
 */
const SH_TOLERANCE = 0.05;

/**
 * Discs the sprite field can have suppressed. `d_ref` is the (POOL+1)-th nearest
 * star, so the promoted ones do not drive the thresholds. Kept as a plain number
 * rather than imported from `NearbyStarDisc` to keep this module a leaf — importing
 * a `"use client"` component here is the module-instance trap `starLodStatus`
 * records.
 */
const DISC_POOL = 2;

/**
 * Floor on how often a completed capture may be replaced, ms.
 *
 * 🔑 DERIVED from the PMREM cost and a stated duty budget, not authored: the
 * prefilter is ~2.5 ms of GPU on the completing frame, and holding its amortised
 * cost under 0.1 ms/frame (1.2% of an 8.5 ms budget) needs 2.5/0.1 = 25 frames
 * ⇒ 417 ms at 60 fps.
 *
 * ⚠ What it costs is staleness, and the reassuring part is where the number lands:
 * 417 ms at the dev 1 ly/s override is 0.417 ly ⇒ 5.5° for a 4.32 ly star — which is
 * almost exactly one texel of the 16×16 tile the PMREM lookup actually SAMPLES for
 * any roughness above 0.054 (`bilinearCubeUV` clamps `mipInt` to
 * `cubeUV_minMipLevel = 4`, and `faceSize = exp2(mipInt)` ⇒ 16 ⇒ 5.625°/texel).
 * So the interval floor and the resolvable-staleness bound agree to within 2%,
 * arrived at from completely independent directions. At shipped drive speeds
 * (peak 1.9e-5 ly/s) the floor never binds — the threshold fires roughly once every
 * 20 minutes.
 */
const MIN_RECAPTURE_MS = 417;

let _lastCaptureMs = -Infinity;

const _lastCube: [number, number, number] = [NaN, NaN, NaN];
const _lastSh: [number, number, number] = [NaN, NaN, NaN];
/** This frame's observer position, so the gate can report the live drift. */
const _now: [number, number, number] = [0, 0, 0];
let _cubeRecaptures = 0;
let _shRebakes = 0;
let _dRefLy = 0;
let _enabled = true;

const dist = (
  a: readonly [number, number, number],
  x: number,
  y: number,
  z: number,
): number => {
  const dx = a[0] - x;
  const dy = a[1] - y;
  const dz = a[2] - z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

/**
 * Distance to the nearest star the sprite tier is still drawing, light-years.
 *
 * ⚠ Uses the 166-star `nearbyStars` list rather than all 8,920 rows. The nearest
 * star to any position within a few light-years of Sol is in that list by
 * construction, and it is 54× cheaper per frame.
 */
function nearestSpriteDistanceLy(
  xLy: number,
  yLy: number,
  zLy: number,
): number {
  const stars = getNearbyStars();
  if (stars.length === 0) return 0;
  // Smallest (DISC_POOL+1) distances, without sorting the whole list.
  const best = new Array<number>(DISC_POOL + 1).fill(Infinity);
  for (const s of stars) {
    const d =
      dist(
        [
          s.positionKm[0] / LY_IN_KM,
          s.positionKm[1] / LY_IN_KM,
          s.positionKm[2] / LY_IN_KM,
        ],
        xLy,
        yLy,
        zLy,
      ) || 1e-12;
    for (let i = 0; i < best.length; i++) {
      if (d < best[i]) {
        for (let j = best.length - 1; j > i; j--) best[j] = best[j - 1];
        best[i] = d;
        break;
      }
    }
  }
  const d = best[DISC_POOL];
  return Number.isFinite(d) ? d : 0;
}

/**
 * Call ONCE per frame, after `publishStarFieldObserverKm`.
 *
 * ⚠ Reads the observer straight off the star field's uniform rather than taking
 * coordinates, so the km→ly derivation lives in exactly one place.
 *
 * ⚠ Allocation-free in the steady state apart from `nearestSpriteDistanceLy`'s
 * per-star tuple; the SH re-bake allocates 9 vectors, and does so at most once per
 * `SH_TOLERANCE · d_ref` of travel.
 */
export function updateSkyParallax(): void {
  if (!_enabled) return;
  const [xLy, yLy, zLy] = getStarFieldCamPosLy();
  _now[0] = xLy;
  _now[1] = yLy;
  _now[2] = zLy;
  _dRefLy = nearestSpriteDistanceLy(xLy, yLy, zLy);
  if (!(_dRefLy > 0)) return;

  // ── The SH probe ──────────────────────────────────────────────────────────
  if (
    Number.isNaN(_lastSh[0]) ||
    dist(_lastSh, xLy, yLy, zLy) > SH_TOLERANCE * _dRefLy
  ) {
    if (rebakeCatalogueShFor([xLy, yLy, zLy])) {
      _lastSh[0] = xLy;
      _lastSh[1] = yLy;
      _lastSh[2] = zLy;
      _shRebakes++;
    }
  }

  // ── The environment cube ──────────────────────────────────────────────────
  // ⚠ Only when idle. See the header: starting a sequence that cannot finish is
  // worse than being one sequence stale.
  if (skySpecularStatus().pendingFace !== 0) return;
  // ⚠⚠ AND NOT MORE OFTEN THAN `MIN_RECAPTURE_MS`. `pendingFace === 0` stops the
  // never-completing restart loop but does NOT bound the DUTY CYCLE: at the dev
  // 1 ly/s override, six frames of travel is 4× the threshold, so sets would run
  // back-to-back for ever. That matters because the expensive part is not the six
  // face renders (tens of µs — the panorama sphere plus ~95k additive sprite
  // fragments per face) but three's 512-sample GGX PMREM prefilter on the frame the
  // set completes: ~7.2e7 dependent gradient fetches ⇒ 1.4–3.6 ms in ONE frame,
  // 17–42% of an 8.5 ms budget.
  const now = performance.now();
  if (now - _lastCaptureMs < MIN_RECAPTURE_MS) return;
  if (
    Number.isNaN(_lastCube[0]) ||
    dist(_lastCube, xLy, yLy, zLy) > CUBE_TEXEL_RAD * _dRefLy
  ) {
    _lastCaptureMs = now;
    _lastCube[0] = xLy;
    _lastCube[1] = yLy;
    _lastCube[2] = zLy;
    // First capture has not happened yet — MilkyWaySkybox drives that; do not
    // count it as a re-capture or invalidate a cube that does not exist.
    if (isSkyCubeCaptured()) {
      invalidateSkyCube();
      _cubeRecaptures++;
    }
  }
}

/** `__lum.skyParallax(false)` — freeze the cube and the probe, for an A/B. */
export function setSkyParallaxUpdates(enabled: boolean): void {
  _enabled = enabled;
}

/** Live state for `__lum.parallax()`. */
export function skyParallaxStatus(): {
  enabled: boolean;
  /** Distance to the nearest star the SPRITE tier draws, ly. Sets both thresholds. */
  dRefLy: number;
  cubeThresholdLy: number;
  shThresholdLy: number;
  cubeRecaptures: number;
  shRebakes: number;
  cubeDriftLy: number;
  shDriftLy: number;
} {
  return {
    enabled: _enabled,
    dRefLy: _dRefLy,
    cubeThresholdLy: CUBE_TEXEL_RAD * _dRefLy,
    shThresholdLy: SH_TOLERANCE * _dRefLy,
    cubeRecaptures: _cubeRecaptures,
    shRebakes: _shRebakes,
    cubeDriftLy: Number.isNaN(_lastCube[0])
      ? 0
      : dist(_lastCube, _now[0], _now[1], _now[2]),
    shDriftLy: Number.isNaN(_lastSh[0])
      ? 0
      : dist(_lastSh, _now[0], _now[1], _now[2]),
  };
}
