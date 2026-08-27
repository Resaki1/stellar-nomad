// ─────────────────────────────────────────────────────────────────────
// EMISSIVE PHOTOMETRY — every self-luminous VFX surface, on one scale
// (LIGHTING_PLAN defect D26, step 1: "calibrate the emissives to real
//  luminances")
// ─────────────────────────────────────────────────────────────────────
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────
// Bodies get their photometry from `bodyPhotometry.ts`; stars from
// `photometry.ts`. The self-luminous VFX had NO equivalent: `emissive:
// new THREE.Color(0.15, 0.1, 0.06)` in one file, `color:
// new THREE.Color(0.5, 0.85, 1.0)` with `opacity: 0.9` in another. Those
// are not luminances — they are numbers that looked right against the
// FIXED exposure of 30 the project used before Phase 5. D26's whole
// finding is that auto-exposure is only as good as its inputs, and an
// emissive with no unit is an input nobody can check.
//
// So: one table, every emissive in the game, each entry carrying either a
// TEMPERATURE (thermal emitters — derived) or a LUMINANCE IN cd/m²
// (everything else — a design value, but a *stated* one). `__lum.emissives()`
// prints it.
//
// ── THE DERIVATION, AND ITS INDEPENDENT CHECK ────────────────────────
// A thermal emitter's luminance follows from Planck's law integrated
// against the photopic response:
//
//     L_v = (683 / π) · ∫ M_λ(T) · V(λ) dλ            [cd/m²]
//
// `photometry.ts` already has `planck()` and the CIE ȳ fit (which IS V(λ));
// they were used for HUE ONLY, with luminance divided out. This file uses
// the same two functions for MAGNITUDE, so hue and magnitude cannot drift
// apart.
//
// ✅ VALIDATED against a number nobody here chose: at the Sun's T_eff of
// 5772 K the integral returns **1.844e9 cd/m²** against a measured solar
// disc luminance of ~2.0e9 above the atmosphere (1.6e9 at sea level). It
// also puts a tungsten filament (~2800 K) at 1.5e7 cd/m² against a
// tabulated 5e6–2e7, and puts the visible-glow threshold at ~1000 K
// (2.7 cd/m²), which is where "dull red heat" is conventionally placed.
// Three independent anchors, three decades apart. The integral is right.
//
// ⚠⚠ THE STEEPEST KNOB IN THE PROJECT. Visible-band blackbody luminance is
// NOT ∝T⁴ — the Planck peak sweeps *into* the photopic band, so it runs
// ~T¹² near 1500 K:
//
//     1000 K → 2.7      1600 K → 2.1e4     2500 K → 5.6e6
//     1200 K → 1.4e2    1800 K → 1.2e5     3000 K → 3.0e7
//     1500 K → 7.8e3    2000 K → 4.7e5     5772 K → 1.8e9
//
// 🔑 So a ±200 K guess about a glow's temperature is a ±10× guess about its
// brightness. When one of these looks wrong, move the TEMPERATURE — it is
// the physically meaningful knob and it has enormous leverage. Do not
// reach for a multiplier.
//
// ── WHY SPRITES ARE NOT DERIVED, AND MESHES ARE ──────────────────────
// A `MeshStandardMaterial.emissive` on real geometry IS the surface
// radiance of that surface: no fill factor, so the derivation is complete
// and those entries are `kind: "thermal"`.
//
// ⚠ A SPRITE is a billboard standing in for something SMALLER than itself.
// Its radiance is `L_emitter · (A_emitter / A_sprite)` — a fill factor that
// depends on a physical size the sprite does not know. Claiming a
// temperature for a sprite would silently assert a fill factor of 1 and
// come out 3–4 decades hot. (Measured: the mining impact glow at a 3000 K
// melt-pool radiance would be **~5,800× brighter** than authored.) So
// sprites are `kind: "design"` — magnitude stated in cd/m², with the
// implied physics written into `why` so the number is auditable rather
// than derived-wrongly. Same reasoning as `STELLAR_POINT_PROFILE_INTEGRAL`
// and `uPsfNorm`: a sub-resolution source conserves FLUX, not radiance.
//
// 🔑 And the audit pays off — run it backwards through FLUX (not radiance)
// and the mining glow's authored value is exactly right for a plausible
// spot. Its effective emitting area is `2πR²·∫a(u)u du·opacity` = **18.2 m²**
// (the alpha gradient concentrates the light: the naive πR² is 154 m²), so at
// 4,684 cd/m² it emits **8.54e4 cd**. Matching that against a real ablation
// spot: **6.3 cm across at 3000 K**, or 14.6 cm at 2500 K. Both are plausible
// mining-laser footprints. The authored number was already physical; it just
// never said so.
//
// ⚠ CORRECTED: the first version of this note said "33 cm at 2500 K" from a
// radiance-RATIO shortcut — `authored / L_melt = (r_spot/R_sprite)²`. That is
// wrong twice: it ignores the alpha gradient (8.5× less area than πR²) and the
// 0.6 opacity. **Compare FLUX, never radiance, when the two areas differ** —
// the same discipline STELLAR_POINT_PROFILE_INTEGRAL exists to enforce, cited
// six lines above and then not applied.
//
// ── WHAT THESE VALUES ARE, PRECISELY ────────────────────────────────
// The MATERIAL's radiance: exactly what goes into `mat.color` (unlit) or
// `mat.emissive` with `emissiveIntensity = 1` (lit). NOT the peak the
// camera sees.
//
// ⚠⚠ THE DISTINCTION IS NOT PEDANTRY — I GOT IT WRONG ONCE HERE. Every
// sprite site multiplies its material by an animated `opacity` (and by the
// glow texture's alpha), so rendered = `material × opacity × texAlpha`. The
// first version of this table stored the PEAK (material × max opacity) and
// the sites then applied their opacity on top, double-counting it and
// making the mining glow 1.67× dimmer than before a change that was
// supposed to be magnitude-preserving. Caught by `__lum.emissives()`
// printing a `peak RGB` that did not match the authored triple.
//
// 🔑 So: the table stores what the MATERIAL holds; each `why` records the
// site's max opacity where one exists, so the peak stays derivable. The
// thermal rows have no envelope — `emissive` on a mesh is constant — so for
// them the two are the same number.
//
// ⚠ NOT pre-exposed. `preExposedEmissive.ts` applies D25's per-frame factor.

import * as THREE from "three";

import {
  blackbodyLinearSrgb,
  blackbodyLuminanceNits,
  nitsToGameUnits,
  gameUnitsToNits,
} from "./photometry";

// ── Emissivities ─────────────────────────────────────────────────────
/**
 * Total hemispherical emissivity of rock / regolith / oxidised metal — the
 * tabulated value for basalt, granite and dirty metal alike is 0.85–0.95.
 * This is a MATERIAL PROPERTY, not a fitted parameter: it is the one factor
 * in the thermal entries below that is genuinely known.
 */
const EMISSIVITY_ROCK = 0.9;

// ── The table ────────────────────────────────────────────────────────

/** A thermal emitter: temperature is physical, so the luminance is derived. */
export type ThermalEmitter = {
  readonly kind: "thermal";
  /** Emitting-surface temperature, K. The knob — see the T¹² warning above. */
  readonly tempK: number;
  /** Surface emissivity in [0, 1]. */
  readonly emissivity: number;
  readonly why: string;
};

/**
 * A stated design luminance: the emitter has no derivable magnitude (it is a
 * sprite standing in for something smaller, or it is sci-fi with no physical
 * referent), so the number is authored — but in cd/m², with its implied
 * physics recorded so a reader can check it.
 */
export type DesignEmitter = {
  readonly kind: "design";
  /** Peak luminance, cd/m². */
  readonly nits: number;
  /** Hue as linear sRGB; magnitude ignored (renormalised to the nits above). */
  readonly hue: readonly [number, number, number];
  readonly why: string;
};

export type EmitterSpec = ThermalEmitter | DesignEmitter;

export const EMITTERS = {
  // ── Thermal: real geometry, so radiance is fully determined ────────
  debris_collision: {
    kind: "thermal",
    tempK: 1200,
    emissivity: EMISSIVITY_ROCK,
    why:
      "Shock-heated fracture faces on rock thrown off a hypervelocity impact. " +
      "⚠ Constant over the effect's 1.8 s life BY DERIVATION, not by laziness: " +
      "radiative cooling of a metre-scale rock is dT/dt = 3σT⁴/(rρc) ≈ 0.6 K/s " +
      "at r = 1 m, so a cooling ramp would be unmeasurable. " +
      "Replaces an authored (0.15, 0.1, 0.06) × 0.5 = 325 cd/m² whose comment " +
      "read 'slightly emissive so it reads in dark space' — 2.6× hot, and the " +
      "wrong hue: 1200 K is deep red, not orange-brown.",
  },
  debris_mined: {
    kind: "thermal",
    tempK: 1600,
    emissivity: EMISSIVITY_ROCK,
    why:
      "Spall off the laser's melt front. Silicates melt at 1500–1800 K, so the " +
      "fragments leave at the low end of that. ⚠⚠ The authored value was BLUE " +
      "((0.1, 0.15, 0.25), comment: 'bluish from laser heat') — thermally " +
      "backwards. Nothing at rock's melting point is blue; blue means >8000 K. " +
      "Hot rock is orange-red, and deriving the hue is most of this entry's value.",
  },
  wreck_hull: {
    kind: "thermal",
    tempK: 600,
    emissivity: EMISSIVITY_ROCK,
    why:
      "⚠⚠ DERIVES TO ZERO, AND THAT IS THE POINT. A wrecked hull retaining 600 K " +
      "of residual heat emits 6.0e-7 cd/m² — 3.3e8× below the authored " +
      "197 cd/m². There is NO temperature at which a hull glows visibly without " +
      "also being visibly molten (1000 K, the threshold, is 2.7 cd/m² and still " +
      "invisible). So the authored emissive was not a dim glow, it was ambient " +
      "light smuggled in as emission, and it is now 0. " +
      "🔑 If wrecks become hard to spot, the fix is the navigation-marker system, " +
      "not glowing hull paint: the wreck is lit by the (now distance-correct, " +
      "Phase 3a) sun and the (now real, D29) sky probe, which is all a cold " +
      "object in space gets.",
  },

  // ── Design: sprites and sci-fi, magnitude authored but stated ──────
  flash_collision: {
    kind: "design",
    nits: 4437,
    hue: blackbodyLinearSrgb(3000),
    why:
      "Incandescent vapour from a hypervelocity impact. HUE derived (3000 K, the " +
      "middle of the 2500–5000 K blackbody fits to laboratory impact flashes); " +
      "MAGNITUDE authored, because radiance here is ε_eff × fill and neither is " +
      "known — the authored peak of 3,993 cd/m² implies their product is 1.3e-4, " +
      "which an " +
      "optically thin cloud under-filling its sprite can reach many ways. " +
      "Deriving it as if the sprite were an opaque 3000 K surface would be 68× hot. " +
      "⚠ Site envelope: × opacity ≤ 0.9, so the peak the camera sees is 3,993 cd/m².",
  },
  flash_mined: {
    kind: "design",
    nits: 4748,
    hue: [0.5, 0.85, 1.0],
    why:
      "Mining-impact flash. Kept CYAN and non-thermal on purpose: this reads as " +
      "the laser's own light scattered off the ablation plume, not as an " +
      "incandescent body, so a blackbody hue would be wrong here even though the " +
      "collision flash next door wants one. ⚠ Site envelope: × opacity ≤ 0.9 " +
      "(peak 4,273 cd/m²).",
  },
  mining_spot: {
    kind: "design",
    nits: 4684,
    hue: [0.45, 0.85, 1.0],
    why:
      "The glow where the beam meets rock. ⚠ Site envelope: × opacity ≤ 0.6. " +
      "🔑 THE AUDIT'S BEST RESULT: matched on FLUX, this sprite emits 8.54e4 cd " +
      "(effective area 18.2 m² once the alpha gradient and the opacity are " +
      "accounted for), which is a real ablation spot **6.3 cm across at 3000 K** " +
      "— or 14.6 cm at 2500 K. Both plausible mining-laser footprints, so the " +
      "authored value was already physically right. ⚠ Do NOT 'fix' this to the " +
      "melt pool's own radiance of 2.7e7 cd/m²; that asserts a centimetre-scale " +
      "pool fills a 14 m sprite and lands ~5,800× hot. Hue left as the authored " +
      "cyan (the beam's colour dominates the spot at these scales).",
  },
  mining_beam_core: {
    kind: "design",
    nits: 5823,
    hue: [0.9, 0.98, 1.0],
    why:
      "Beam core. ⚠ NO physical referent exists: a beam in vacuum is invisible " +
      "(there is nothing to scatter), so every visible-beam value in every space " +
      "game is a design decision. Stated in cd/m² so it is at least on the same " +
      "scale as everything else, and so pre-exposure can be verified against it. " +
      "⚠ Site envelope: × opacity ≤ 0.78 (peak 4,542 cd/m²).",
  },
  mining_beam_halo: {
    kind: "design",
    nits: 4556,
    hue: [0.35, 0.85, 1.0],
    why:
      "Beam halo — see mining_beam_core; design value, no physical referent. " +
      "⚠ Site envelope: × opacity ≤ 0.16 (peak 729 cd/m²).",
  },
  mining_muzzle: {
    kind: "design",
    nits: 5157,
    hue: [0.65, 0.9, 1.0],
    why:
      "Aperture scatter at the ship's laser head. Optics scatter, not a melt " +
      "pool — no thermal derivation applies. ⚠ Site envelope: × opacity ≤ 0.14 " +
      "(peak 722 cd/m²).",
  },
  mining_pulse: {
    kind: "design",
    nits: 5501,
    hue: [0.75, 0.95, 1.0],
    why:
      "Material-transfer pulses travelling the beam. Design value. ⚠ Site " +
      "envelope: × opacity ≤ 0.38 (peak 2,090 cd/m²).",
  },
  wreck_beam: {
    kind: "design",
    nits: 3972,
    hue: [0.4, 0.7, 1.0],
    why:
      "Salvage tractor beam. Design value, same class as the mining beam. " +
      "⚠ Site envelope: × opacity 0.6 (peak 2,383 cd/m²).",
  },

  // ── Reference row: owned elsewhere, listed so the audit is complete ─
  ship_plume: {
    kind: "design",
    nits: 72_456,
    hue: [1, 1, 1],
    why:
      "⚠ REFERENCE ROW ONLY — `EngineExhaust.tsx` owns this through its own TSL " +
      "uniform (PLUME_HDR = 12 game units) and does not read this table. Listed " +
      "so `__lum.emissives()` shows the whole self-luminous set in one place, " +
      "and because it is the calibrated anchor the rest should be read against: " +
      "already validated as a plasma luminance in D26 (arc lamp ~1e8, sunlit " +
      "cloud top ~2e4). Keep the two in sync by hand; there is only one.",
  },
} as const satisfies Record<string, EmitterSpec>;

export type EmitterId = keyof typeof EMITTERS;

// ── Accessors ────────────────────────────────────────────────────────

/** Peak luminance of an emitter, cd/m² — derived for thermal, stated for design. */
export function emitterNits(id: EmitterId): number {
  const e: EmitterSpec = EMITTERS[id];
  return e.kind === "thermal"
    ? blackbodyLuminanceNits(e.tempK) * e.emissivity
    : e.nits;
}

/** Peak radiance of an emitter in game units (1 unit ≈ 6,038 cd/m²). */
export function emitterGameUnits(id: EmitterId): number {
  return nitsToGameUnits(emitterNits(id));
}

/**
 * An emitter's peak radiance as a linear-sRGB colour in game units: the right
 * value for a `MeshBasicMaterial.color`, a `SpriteMaterial.color`, or a
 * `MeshStandardMaterial.emissive` (with `emissiveIntensity = 1` — folding the
 * intensity in avoids a second, hidden multiplier).
 *
 * ⚠ Both hue sources are LUMINANCE-NORMALISED before scaling, so the returned
 * colour's Rec709 luminance is exactly `emitterGameUnits(id)`. That is what
 * makes the table's numbers mean anything: a hue with luminance ≠ 1 would
 * silently rescale the emitter (the trap `STAR_COLOR_LINEAR` documents).
 */
export function emitterColor(id: EmitterId, out?: THREE.Color): THREE.Color {
  const e: EmitterSpec = EMITTERS[id];
  const c = out ?? new THREE.Color();
  const hue = e.kind === "thermal" ? blackbodyLinearSrgb(e.tempK) : e.hue;
  const lum = 0.2126 * hue[0] + 0.7152 * hue[1] + 0.0722 * hue[2];
  const k = emitterGameUnits(id) / (lum > 0 ? lum : 1);
  return c.setRGB(hue[0] * k, hue[1] * k, hue[2] * k);
}

// ── Audit ────────────────────────────────────────────────────────────

export type EmitterAuditRow = {
  id: EmitterId;
  kind: EmitterSpec["kind"];
  tempK: number | null;
  nits: number;
  gameUnits: number;
  /** EV100 of the peak — `log2(nits · 8)`, the same scale the meter reports. */
  ev: number;
  rgb: [number, number, number];
  why: string;
};

/** Every emitter, for `__lum.emissives()`. Ordered brightest first. */
export function emitterAudit(): EmitterAuditRow[] {
  const c = new THREE.Color();
  const rows = (Object.keys(EMITTERS) as EmitterId[]).map((id) => {
    const e: EmitterSpec = EMITTERS[id];
    const nits = emitterNits(id);
    emitterColor(id, c);
    return {
      id,
      kind: e.kind,
      tempK: e.kind === "thermal" ? e.tempK : null,
      nits,
      gameUnits: nitsToGameUnits(nits),
      ev: Math.log2(Math.max(nits, 1e-12) * 8),
      rgb: [c.r, c.g, c.b] as [number, number, number],
      why: e.why,
    };
  });
  return rows.sort((a, b) => b.nits - a.nits);
}

/**
 * The Planck×V(λ) integral's three independent anchors, for the gate.
 *
 * 🔑 These are the whole reason to trust the thermal rows: not one of the three
 * targets was chosen by this project, and the integral hits all of them across
 * nine decades. If a future three.js or refactor breaks `planck()` or the ȳ fit,
 * this fails loudly instead of quietly rescaling every glowing object.
 */
export function blackbodyAnchors(): {
  label: string;
  tempK: number;
  nits: number;
  expected: string;
}[] {
  return [
    {
      label: "solar photosphere",
      tempK: 5772,
      nits: blackbodyLuminanceNits(5772),
      expected: "~2.0e9 (above atmosphere), 1.6e9 at sea level",
    },
    {
      label: "tungsten filament",
      tempK: 2800,
      nits: blackbodyLuminanceNits(2800),
      expected: "5e6–2e7 (tabulated)",
    },
    {
      label: "visible-glow threshold",
      tempK: 1000,
      nits: blackbodyLuminanceNits(1000),
      expected: "~1–10, 'dull red heat'",
    },
  ];
}

/** Re-exported so callers need one import for the unit conversions. */
export { gameUnitsToNits, nitsToGameUnits };
