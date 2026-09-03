/**
 * `starVisibility` — the ONE display lift that keeps stars usable for orientation.
 *
 * See [`docs/STAR_RENDERING_PLAN.md`](../../../docs/STAR_RENDERING_PLAN.md) §14 (R7b).
 *
 * ── THE REQUIREMENT IS REAL AND IT IS A GAMEPLAY ONE ────────────────────────
 * The author's reason for `STAR_ARTISTIC_GAIN = 1024`: *"I wanted players to pretty
 * much always see at least some stars to help them orientate. Before that I had
 * scenarios where they were far from any planet, the ship was brightly lit by the
 * star, so auto-exposure kicked in and the whole sky was pitch black."*
 *
 * ⚠ That sky is **physically correct** — astronauts in daylight cannot see stars,
 * which is why daylight orbital photographs have black skies. MEASURED here: with a
 * sunlit hull filling the frame the meter settles near `preExposure ≈ 0.13`, and
 * Sirius then renders at **8.9e-5**, some 2,000× below middle grey. Correct, and
 * useless to navigate by. So this is not a bug to delete — it is a legitimate
 * readability aid, and the job is to make it honest.
 *
 * ── WHY THE FLAT GAIN SERVED IT BADLY, IN BOTH DIRECTIONS ───────────────────
 * 🔑🔑 MEASURED: a flat `1024 × starCompressionFactor(magV)` gives Sirius only
 * **55×** — which in the sunlit-hull case lifts it to 4.9e-3, still marginal — while
 * in deep space, where the sky is *already* perfectly visible (Sirius renders at
 * 0.40, above middle grey), it multiplies by 55 anyway and clips it hard. **Too
 * little exactly where help was wanted, too much where none was needed.**
 *
 * Three further costs, all of which this removes:
 *  • it breaks tier continuity — R2b had to carry it across the sprite→disc
 *    handover by hand, and getting only *one* of the two gains cost 3.46 stops;
 *  • `starCompressionFactor` is magnitude-dependent, so under parallax (S5) a
 *    star's brightness would swim non-physically as its apparent magnitude changed;
 *  • it lies to the scotopic driver and the exposure meter (LIGHTING_PLAN P7d/P8).
 *
 * ── WHAT THIS IS INSTEAD ────────────────────────────────────────────────────
 * A single **global scalar**, derived from the current adaptation state, that lifts
 * the star field as far as is needed to hold one *anchor* star at a chosen
 * visibility target — never below the value the author tuned by eye.
 *
 *   lift = clamp(TARGET / renderedPeak(anchor), FLOOR, MAX)
 *
 * 🔑🔑 THE FLOOR IS WHAT MAKES THIS SHIPPABLE, and its absence is why the first
 * attempt was parked. With `FLOOR = STAR_LIFT_LEGACY`, "auto" is a strict SUPERSET
 * of "legacy": it is bit-identical wherever the old flat gain was already enough,
 * and it can only ever add lift where the old one fell short. So there is no regime
 * the change can make worse, which is what turns the flip from a look gamble into a
 * one-way improvement.
 *
 * ⚠ An earlier draft used a floor of 1.0 on the grounds that deep space "was already
 * right". It is not: the anchor is a STAR, and holding a star at the target says
 * nothing about the Milky Way BAND, whose surface brightness is orders of magnitude
 * below a star's PSF peak. Measured on device by the author: at lift 1.0 in deep
 * space "the ship is mostly black... only the brightest parts of the milky way
 * faintly reflecting". The band and the hull need the floor; the anchor rule alone
 * does not supply it.
 *
 * Properties that matter:
 *  • **Global**, so it applies identically to sprites, promoted discs, the Milky
 *    Way and the sky cube. Tier continuity is free rather than hand-carried.
 *  • **Preserves relative star brightness exactly** — unlike the magnitude
 *    compression, which distorts the ratios.
 *  • **Bounded** at both ends, and it inherits the adaptation follower's smoothing,
 *    so it cannot pop; the only kink is where it meets the floor.
 *
 * ── ⚠⚠ IT DOES CLOSE A LOOP WITH THE EXPOSURE METER. THE CLAMPS ARE WHAT BREAK IT ─
 * An earlier draft of this note claimed the lift "cannot feed back", on the grounds
 * that `preExposure × lift` is constant in the unclamped regime so a sky pixel's
 * BUFFER value never moves. That much is true and it is not sufficient: the meter
 * divides pre-exposure back out (it must — D25), so it recovers `physical × lift`
 * and sees the sky brighten as the lift rises. Loop gain is exactly the sky's share
 * of the metered luminance, and it is POSITIVE.
 *
 * 🔑 What makes it safe is not the constancy, it is the two bounds and *where* they
 * bind:
 *  • the lift only grows large when adaptation is bright, and adaptation is bright
 *    because something SUN-lit is in frame — whose luminance the lift does not
 *    touch. So the share, and therefore the gain, is small exactly when the lift is
 *    moving;
 *  • the one pose whose whole frame scales with the lift (deep space, where even the
 *    hull is lit by the sky) is the pose where `needed` collapses far below the
 *    floor, so the lift is a CONSTANT there and the loop is open;
 *  • both ends are hard-clamped, so even a marginal-gain excursion is bounded rather
 *    than divergent.
 *
 * ⚠ The structural fix is the same one LIGHTING_PLAN's P7d-ii already names — a
 * per-pixel sky mask, so the lift can be applied AFTER metering instead of inside
 * the radiance the meter reads. `__lum.starLift()` reports `clampedBy`, which is
 * also the honest read on whether the loop is currently open or live.
 *  • **Reportable** — one number the scotopic/exposure work can divide out, which
 *    is what makes P7d/P8 fixable instead of merely documented.
 */

import { uniform } from "three/tsl";

/**
 * Scene-linear value an anchor star's peak pixel is held at, at minimum.
 *
 * ⚠⚠ WAS 0.03, AND THAT WAS WRONG BY 16×. It was AUTHORED — "middle grey is 0.18 and
 * a point below ~0.01 is invisible, so 0.03 is a clear but unobtrusive point" — and
 * it never survived contact with a screen. MEASURED on device (2026-09-02), reading
 * `anchorPeakLifted` at three poses:
 *
 *     pose                  preExposure   carried by   anchor rendered at   verdict
 *     1 AU, sun behind          5.59       the RULE          0.030          near-black
 *     3 AU                     89.4        the FLOOR         0.486          "what I'd
 *                                                                            expect at 1 AU"
 *     deep space              ~250         the FLOOR         7.49           "perfect"
 *
 * 🔑 THE DEFECT WAS A STEP DOWN AT THE CROSSOVER. Where the floor carried, the sky
 * rendered at 0.486–7.49; the instant the rule took over it pinned the anchor at
 * 0.03, i.e. **16× dimmer than the floor it was supposed to extend**. The rule was
 * darkening the sky, not lifting it. Both halves were individually defensible, which
 * is exactly why only a pose that crossed between them could show it.
 *
 * 0.5 is the author's own 3 AU reading (0.486), rounded. It makes the rule CONTINUOUS
 * with the floor at that pose — `needed` there becomes 1055 against a floor of 1024,
 * a 3% step instead of a 16× one — and leaves deep space untouched (`needed` 68, far
 * below the floor). Cross-check: at 0.5 the Milky Way band's mean lands at 1.27e-3
 * display-linear at 1 AU against 1.24e-3 at 3 AU, so the BAND matches the endorsed
 * pose too, not just the anchor.
 *
 * 🔑 It is still the ONE knob, and the relationship is exact: whenever the rule is in
 * charge the mag-`STAR_ANCHOR_MAG` star renders at precisely this value, so "twice as
 * bright" is 1.0 and nothing else needs touching. 0.3–1.0 is the sensible band.
 */
export const STAR_VISIBILITY_TARGET = 0.5;

/**
 * Apparent magnitude of the star the target applies to.
 *
 * 1.5 is roughly the 20 brightest stars — the classic navigation set, and enough to
 * recognise constellations by. ⚠ Raising it toward 6 would keep the whole naked-eye
 * sky visible under any adaptation, at the cost of a much larger lie; the measured
 * lift needed for mag 6 with a sunlit hull is ~3e5.
 */
export const STAR_ANCHOR_MAG = 1.5;

/**
 * The lift never goes below this, whatever adaptation says.
 *
 * ⚠ AUTHORED, and it is the GAMEPLAY requirement rather than a measurement:
 * *"I need the stars and the milky way to be more visible than our physical model
 * calculates... so players don't get disorientated."*
 *
 * 🔑 The VALUE is not arbitrary, though. 1024 is the number `SKY_ARTISTIC_GAIN`'s
 * measured table settled on, and that table was decided by HULL contrast, not by the
 * band: at ×64 the sky-lit hull sat 3.7× above AgX's black floor (crushed) and at
 * ×1024 it sat 59.5× (visible). Keeping the floor there preserves that measured
 * result exactly, so deep space is bit-identical to what shipped.
 */
export const STAR_LIFT_FLOOR = 1024;

/**
 * Hard ceiling, so a pathological input cannot wash the sky out.
 *
 * ⚠ WAS 4096, WHICH DEFEATED THE WHOLE POINT: with a sunlit hull the lift the anchor
 * rule ASKS for is order 1e4 (`preExposure ≈ 0.13`), so the ceiling clipped it by
 * roughly a decade and the anchor still rendered below the visibility floor — the aid
 * did not work in the one case it was built for. `__lum.starLift()` prints `needed`
 * against `lift` so the clip is visible rather than inferred.
 *
 * The derivation self-limits (the anchor lands at exactly `TARGET`, never above), so
 * this guards only against a bogus input — `psfNorm` from an unmounted field, a
 * pre-exposure of ~0 — not against the rule itself running away.
 */
export const STAR_LIFT_MAX = 65536;

/** Legacy flat value, kept for the A/B only. Also the floor's value — see above. */
export const STAR_LIFT_LEGACY = 1024;

export type StarLiftMode = "auto" | "legacy" | "off";

/**
 * ✅ DEFAULT IS "auto" AGAIN (§15). It was pinned to "legacy" because the gain had a
 * THIRD, purely numerical role nobody had written down: `space/skySpecular.ts` leaned
 * on it to keep the sky cube inside half-float, so a correct lift of 1.0 in deep
 * space captured a BLACK environment and the hull lost all sky lighting.
 *
 * That is now fixed at the source — `space/skyCaptureEncode.ts` gives the capture its
 * own fixed, derived encode scale and divides both per-frame display factors out — so
 * the lift is free to be whatever adaptation warrants. Together with
 * `STAR_LIFT_FLOOR` this mode is a strict superset of "legacy", so "legacy" is now
 * only an A/B reference.
 *
 * ⚠ THE LESSON, and it is the one worth keeping: a constant that has survived a long
 * time in a physically anchored system has acquired jobs nobody wrote down. Enumerate
 * its READERS before redefining it — `grep` is cheaper than a parked phase.
 */
let _mode: StarLiftMode = "auto";
let _lift = STAR_LIFT_FLOOR;
let _anchorPeakPhysical = 0;
let _needed = 0;

/** The lift, as a TSL uniform. Read by StarField, MilkyWaySkybox and Star. */
export const uStarLift = /*#__PURE__*/ uniform(STAR_LIFT_FLOOR);

/**
 * Recompute the lift for this frame. Call ONCE per frame, before anything renders.
 *
 * @param preExposure this frame's source pre-exposure (D25)
 * @param psfNorm     `getStarPsfNorm()` — 1/(2πσ²·Ω_pixel); 0 before StarField mounts
 * @param anchorIllumGame illuminance of a `STAR_ANCHOR_MAG` star, game units,
 *        already carrying whatever magnitude compression the sprite path applies
 */
export function updateStarLift(
  preExposure: number,
  psfNorm: number,
  anchorIllumGame: number,
): void {
  if (_mode === "off") {
    _lift = 1;
    _needed = 0;
    uStarLift.value = 1;
    return;
  }
  if (_mode === "legacy") {
    _lift = STAR_LIFT_LEGACY;
    _needed = 0;
    uStarLift.value = STAR_LIFT_LEGACY;
    return;
  }
  // ⚠ psfNorm is 0 until StarField has run a frame. Hold at the FLOOR rather than
  // dividing by zero into Infinity — a NaN lift would take out the whole sky, and
  // the floor is the right fallback because it is what shipped.
  if (!(psfNorm > 0) || !(preExposure > 0) || !(anchorIllumGame > 0)) {
    _lift = STAR_LIFT_FLOOR;
    _needed = 0;
    uStarLift.value = STAR_LIFT_FLOOR;
    return;
  }
  _anchorPeakPhysical = anchorIllumGame * psfNorm * preExposure;
  _needed = STAR_VISIBILITY_TARGET / _anchorPeakPhysical;
  _lift = Math.min(STAR_LIFT_MAX, Math.max(STAR_LIFT_FLOOR, _needed));
  uStarLift.value = _lift;
}

/** This frame's lift. 1.0 means the sky is already visible and nothing is faked. */
export const getStarLift = (): number => _lift;

export function setStarLiftMode(mode: StarLiftMode): void {
  _mode = mode;
}

export const getStarLiftMode = (): StarLiftMode => _mode;

/** Live state for `__lum.starLift()`. */
export function starLiftStatus(): {
  mode: StarLiftMode;
  lift: number;
  /** What the anchor rule ASKED for, before the floor and the ceiling. */
  needed: number;
  floor: number;
  max: number;
  /** Which bound is binding — the honest read on whether the rule is in charge. */
  clampedBy: "floor" | "ceiling" | "none";
  anchorMag: number;
  target: number;
  anchorPeakPhysical: number;
  anchorPeakLifted: number;
  faking: boolean;
} {
  const clampedBy =
    _mode !== "auto" || _needed <= 0
      ? "none"
      : _needed < STAR_LIFT_FLOOR
        ? "floor"
        : _needed > STAR_LIFT_MAX
          ? "ceiling"
          : "none";
  return {
    mode: _mode,
    lift: _lift,
    needed: _needed,
    floor: STAR_LIFT_FLOOR,
    max: STAR_LIFT_MAX,
    clampedBy,
    anchorMag: STAR_ANCHOR_MAG,
    target: STAR_VISIBILITY_TARGET,
    anchorPeakPhysical: _anchorPeakPhysical,
    anchorPeakLifted: _anchorPeakPhysical * _lift,
    faking: _lift > 1.0001,
  };
}
