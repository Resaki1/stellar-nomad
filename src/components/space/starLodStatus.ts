/**
 * Live star LOD / shell-clamp state, published by `Star.tsx` and read by
 * `__lum.starLod()`.
 *
 * ⚠ A plain leaf module, not an export from `Star.tsx`: importing a `"use client"`
 * component module into `lumHarness` yielded a SECOND module instance, so the
 * harness read a status object the mounted component never wrote (it reported
 * "has not run a frame" while the star was rendering). Same pattern as
 * `sunOcclusion.ts` — the component pushes, the harness reads.
 */

export type StarLodStatus = {
  distAu: number;
  distScaled: number;
  /** True angular diameter of the disc, in drawing-buffer pixels. */
  discPx: number;
  tier: "disc" | "point";
  /** 1 = drawn at its true position; < 1 = projected onto the shell. */
  shellScale: number;
  drawnAtScaled: number;
  clampScaled: number;
  farScaled: number;
  coreRadianceGame: number;
  starVis: number;
  /** Diameter the disc is actually DRAWN at, buffer px. ≥ discPx. */
  renderPx: number;
  /** Which limit set `renderPx`. */
  sizedBy: "true" | "pixelFloor" | "halfFloatCeiling" | "releasing";
  /** This frame's source pre-exposure. */
  preExposure: number;
  /**
   * Peak value written into the scene buffer, **after the blackbody tint** —
   * i.e. the brightest CHANNEL, which is the quantity that must fit in
   * half-float. Reporting the untinted scalar hid a +Inf red channel.
   */
  writtenPeak: number;
  /** Scalar cap the CPU sizes against: HALF_FLOAT_WRITE_MAX / max(r,g,b). */
  writeBudget: number;
  /**
   * Fraction of the star's flux that survives the write. 1 = none discarded.
   * < 1 is the residual P8d deficit, only possible while the disc is resolved.
   */
  fluxKept: number;
  /** Clipped flux handed to the analytic PSF (R3b), in buffer value · px². */
  pointGlareFlux: number;
  /** R4: `I(limb)/I(centre)` per channel, derived from T_eff. */
  limbRatio: [number, number, number];
  /** R4: limb-darkening A/B scale in force (1 = derived profile). */
  limbScale: number;
  /** R4: half-width of the limb's AA ramp, in drawing-buffer pixels. */
  edgeAaPx: number;
  /** R2b: display gain in force. 1 = physical; >1 = the inherited sprite gain. */
  unresolvedGain: number;
  /** What the peak WOULD have been at the disc's true size. */
  unspreadPeak: number;
  /**
   * Peak at the size the disc is actually DRAWN at, before the guard clips.
   *
   * ⚠ `unspreadPeak / cap` is NOT the clip ratio when the pixel floor has spread
   * the disc — it conflates flux-conserving spread with clipping (95.7× vs a real
   * 2.06× at 30 AU). Compare THIS against the cap.
   */
  drawnPeak: number;
  /** Legacy hand-authored corona multiplier — 0 once R3 is judged. */
  coronaScale: number;
  /** False until Star has run a frame. */
  ran: boolean;
};

/** Mutated in place each frame — useFrame must not allocate. */
export const starLodStatus: StarLodStatus = {
  distAu: 0,
  distScaled: 0,
  discPx: 0,
  tier: "disc",
  shellScale: 1,
  drawnAtScaled: 0,
  clampScaled: 0,
  farScaled: 0,
  coreRadianceGame: 0,
  starVis: 1,
  renderPx: 0,
  sizedBy: "true",
  preExposure: 1,
  writtenPeak: 0,
  writeBudget: 60_000,
  fluxKept: 1,
  pointGlareFlux: 0,
  limbRatio: [1, 1, 1],
  limbScale: 1,
  edgeAaPx: 0,
  unresolvedGain: 1,
  unspreadPeak: 0,
  drawnPeak: 0,
  coronaScale: 0,
  ran: false,
};

/**
 * Legacy hand-authored corona (`INNER_GLOW_FRAC` / `OUTER_GLOW_ABS` /
 * `GLOW_PAD` / `MIN_SCREEN_PX`), as a multiplier. **Default 0 — it is off.**
 *
 * 🔑 Retained ONLY so the R3 look change can be A/B'd at runtime without a
 * reload, in the `setGlare` / `setScotopic` idiom. It reproduces the shipped
 * look including its D25 bug (`OUTER_GLOW_ABS` carries no pre-exposure), because
 * an A/B against a *corrected* old version would compare something that never
 * shipped. **Delete this and the constants it gates once the judgement is in.**
 *
 * Measured reason it is going (STAR_RENDERING_PLAN §9.1): beyond ~5 AU the
 * corona carries **5.3× the star's entire physical flux**, because
 * `MIN_SCREEN_PX` pins the billboard at ~42 buffer px while the disc shrinks to
 * the 2.5 px floor.
 */
let _coronaScale = 0;

/**
 * What the promoted-disc pool holds, published by `NearbyStarDisc` (R7d).
 *
 * 🔑 A leaf slot rather than a component export, for the reason in this file's
 * header — and it exists because the suppression has now failed silently TWICE
 * (a cosine that rounded to 1.0f, then a cross-walk tolerance 100× too tight) and
 * both times the only visible symptom was photometric, somewhere else entirely.
 * "Which stars are promoted, and did their sprite rows resolve" is the single most
 * diagnostic pair of facts in the star system, and nothing reported it.
 */
export type StarDiscSlot = {
  id: string;
  name: string;
  /** Angular radius R/d — the promotion selector. */
  solid: number;
  distLy: number;
  /** Visual-catalogue row its sprite was suppressed at, or −1 if unresolved. */
  spriteRow: number;
  /** Absolute position, km, game frame — so the ship can COLLIDE with it. */
  positionKm: readonly [number, number, number];
  /** Physical radius, km — the collider's radius. */
  radiusKm: number;
  /**
   * Apparent V magnitude from Sol. ⚠ The discriminator for `spriteRow === -1`:
   * fainter than V 6.5 means the star legitimately has no sprite (Proxima, Barnard's),
   * brighter means the suppression failed and the star is drawn twice.
   */
  magV: number;
};

export const starDiscPool: StarDiscSlot[] = [];

/**
 * What the LIGHT pool holds, published by `StarLights` (R7e).
 *
 * ⚠ A DIFFERENT set from `starDiscPool`, and that is the design: the disc tier
 * selects on angular size and the light tier on illuminance at the ship. Both are
 * needed by `rebakeCatalogueShFor`'s exclusion set — a star rendered by any explicit
 * tier must come out of the diffuse aggregate or its flux is counted twice.
 */
export type StarLightSlot = {
  id: string;
  name: string;
  /** Sprite row, or −1 when the star is fainter than the sprite catalogue's limit. */
  spriteRow: number;
  /** Illuminance at the ship, game units — the light tier's selector. */
  illumGame: number;
  distLy: number;
  tempK: number;
};

export const starLightPool: StarLightSlot[] = [];

export function setStarLightPool(slots: readonly StarLightSlot[]): void {
  starLightPool.length = 0;
  for (const s of slots) starLightPool.push(s);
}

/**
 * Visual-catalogue rows the LIGHT pool holds — the exclusion set the SH bake needs.
 *
 * 🔑 ONLY the light pool, not the disc pool. A disc is rendered geometry: you SEE it,
 * but it does not light the hull, so it correctly stays in the diffuse sum. A star
 * that is also a directional light is delivering its flux twice unless it comes out.
 *
 * ⚠ Published as row indices rather than directions so the bake's inner loop stays a
 * single integer test per star instead of a dot product against every pool member.
 * A leaf array because `skyIrradiance`/`StarField` must not import a component.
 */
export const starLightExcludedRows: number[] = [];

/** Re-selection gate counters, published by both tiers for `__lum.starTiers()`. */
export const starTierGateStats: Record<
  string,
  { runs: number; skipped: number; budgetKm: number }
> = {};

export function setStarTierGateStat(
  tier: string,
  runs: number,
  skipped: number,
  budgetKm: number,
): void {
  starTierGateStats[tier] = { runs, skipped, budgetKm };
}

export function setStarLightExcludedRows(rows: readonly number[]): void {
  starLightExcludedRows.length = 0;
  for (const r of rows) if (r >= 0) starLightExcludedRows.push(r);
}

export function setStarDiscPool(slots: readonly StarDiscSlot[]): void {
  starDiscPool.length = 0;
  for (const s of slots) starDiscPool.push(s);
}

export const getStarCoronaScale = (): number => _coronaScale;

export function setStarCoronaScale(scale: number): void {
  _coronaScale = Number.isFinite(scale) && scale >= 0 ? scale : 0;
}

/**
 * R3b: analytic point-source glare on/off, for the A/B.
 */
let _pointGlare = true;
export const getStarPointGlareEnabled = (): boolean => _pointGlare;
export function setStarPointGlareEnabled(on: boolean): void {
  _pointGlare = on;
}

/**
 * R4: limb-darkening strength, for the A/B. 1 = the derived profile, 0 = flat.
 *
 * ⚠ On the SUN it is not expected to be visible: the disc sits ~9.9 stops above
 * display white, so centre (1.27× mean) and limb (0.42× mean) both clip to pure
 * white. That is correct — the naked eye cannot see solar limb darkening either.
 * It becomes visible only with ~8.7 stops of extra attenuation (a visor), and it
 * matters now because it is the substrate for R5's granulation and because it is
 * dramatic on cool stars (I_limb/I_centre = 0.08 in G at 3000 K).
 */
let _limbScale = 1;
export const getStarLimbScale = (): number => _limbScale;
export function setStarLimbScale(scale: number): void {
  _limbScale = Number.isFinite(scale) && scale >= 0 ? scale : 1;
}

/**
 * Sign of the screen-space Y mapping for the analytic term's centre.
 *
 * ⚠ `uv()` in the post chain and NDC do not agree about which way Y runs across
 * three's backends, and this repo has already lost time to exactly that
 * (`screenUV.y increases DOWNWARD` in hdrCalibration). Rather than guess, the
 * flip is a runtime toggle: if the star's glare is centred above/below the star
 * by twice its offset from the middle of the screen, call
 * `__lum.starGlareFlipY(true)`.
 */
// ⚠ MEASURED ON DEVICE: `true` is correct for this backend. `uv()` in the post
// chain runs Y opposite to NDC here, so the default is the flipped one.
let _flipY = true;
export const getStarGlareFlipY = (): boolean => _flipY;
export function setStarGlareFlipY(on: boolean): void {
  _flipY = on;
}
