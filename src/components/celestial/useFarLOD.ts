import { useMemo } from "react";
import * as THREE from "three";
import { NodeMaterial } from "three/webgpu";
import {
  Fn,
  uv,
  positionGeometry,
  modelWorldMatrix,
  cameraViewMatrix,
  cameraProjectionMatrix,
  vec3,
  vec4,
  float,
  clamp,
  length,
  smoothstep,
  Discard,
} from "three/tsl";
import type { FarBillboardConfig } from "./types";
import { surfaceRadiance } from "@/components/space/photometry";
import { bodyReflectanceRgb } from "./bodyColour";

/**
 * The far billboard's albedo, derived entirely from `bodyPhotometry`: LUMINANCE from
 * the published geometric albedo, HUE from the measured B−V colour index. Part of D09.
 *
 * 🔑 WHY THIS IS DERIVED AND NOT THE 13 AUTHORED `THREE.Color` CONSTANTS. Those were
 * picked by eye, so BOTH of their properties were uncontrolled opinions about numbers
 * we already have. MEASURED, their luminances span **8.7× (3.12 stops)** against
 * `bodyPhotometry` with a geometric mean of **1.076** — ⚠⚠ and that combination is the
 * whole point: a spread with no systematic offset is a PER-BODY error, and **no
 * exposure setting can fix a per-body error.** Luna rendered +1.64 stops hot while
 * Neptune was −1.49 cold in the same frame. (Luna's +1.64 is the same defect
 * `__lum.disc` independently measured as 3.5× hot.)
 *
 * ⚠ Hue is measured too — see `bodyColour.ts`, including where its linear-slope model
 * is weak (the ice giants) and why Neptune correctly comes out paler than the famous
 * contrast-enhanced Voyager blue.
 *
 * ⚠ Applied HERE, at consumption, for the same reason `surfaceRadiance` is: a rule
 * that lives in 13 constants is a rule a new body can get wrong, and this tier is
 * already the one that drifted off the photometric scale once. Deriving it from
 * `bodyPhotometry` also means correcting a published value fixes every tier at once.
 *
 * Falls back to the authored colour for a body with no photometry row — better to
 * keep what an author chose than to invent a number for an unmeasured body.
 */
function derivedFarAlbedo(bodyId: string, authored: THREE.Color): THREE.Color {
  return bodyReflectanceRgb(bodyId) ?? authored;
}

/**
 * Default billboard fragment: simple hard-diffuse hemisphere.
 * Used by rocky bodies (Mercury, Io, Europa, Ganymede, Callisto, Luna).
 */
function defaultBillboardFragment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  { albedo, uSpR, uSpU, uSpF }: { albedo: THREE.Color; uSpR: any; uSpU: any; uSpF: any },
) {
  return Fn(() => {
    const p = uv().mul(2).sub(1);
    const dist = length(p);

    const edge = smoothstep(float(1.0), float(0.92), dist);
    Discard(edge.lessThan(0.01));

    const domeZ = float(1.0).sub(dist.mul(dist)).max(0).sqrt();

    const sunDot = clamp(
      uSpR.mul(p.x).add(uSpU.mul(p.y)).add(uSpF.mul(domeZ)),
      0, 1,
    );

    // Returns REFLECTANCE. The conversion to radiance — × E/π, which also carries
    // pre-exposure — is applied once by `useFarLOD` for every builder (see there).
    const col = vec3(albedo.r, albedo.g, albedo.b).mul(sunDot);

    return vec4(col, edge);
  })();
}

export function useFarLOD(
  scaledRadius: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSpR: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSpU: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSpF: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSunIlluminance: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uFarFade: any,
  farConfig: FarBillboardConfig,
  bodyId: string,
) {
  const sizeMultiplier = farConfig.sizeMultiplier ?? 2.1;

  const geo = useMemo(
    () => new THREE.PlaneGeometry(scaledRadius * sizeMultiplier, scaledRadius * sizeMultiplier),
    [scaledRadius, sizeMultiplier],
  );

  const mat = useMemo(() => {
    const m = new NodeMaterial();
    m.side = THREE.DoubleSide;
    m.depthWrite = true;
    m.transparent = false;
    m.alphaHash = true;

    const worldCenter = modelWorldMatrix.mul(vec4(0, 0, 0, 1));

    m.vertexNode = Fn(() => {
      const viewCenter = cameraViewMatrix.mul(worldCenter);
      const viewPos = viewCenter.add(
        vec4(positionGeometry.xy, float(0), float(0)),
      );
      return cameraProjectionMatrix.mul(viewPos);
    })();

    const buildFrag = farConfig.buildFragment ?? defaultBillboardFragment;
    // ── D04 / Phase 4: ONE reflectance → radiance conversion for ALL builders ──
    // Every `far.buildFragment` returns REFLECTANCE (`albedo × sunDot × …`) and this
    // wraps it in `surfaceRadiance` = `× uSunIlluminance / π`, the exact same function
    // the near and mid tiers use. That is what "unified impostor radiance" means: not
    // three formulas that agree, ONE formula evaluated in three places.
    //
    // 🔑 WRAPPED HERE RATHER THAN EDITED INTO EACH BUILDER. There are 8 of them
    // (`defaultBillboardFragment` + 7 body overrides), and a per-builder multiply is a
    // rule a new body can forget — which is exactly how this tier came to be the only
    // one off the photometric scale. A wrapper cannot be forgotten.
    //
    // ⚠ MEASURED CONSEQUENCE: the 7 overrides never received the D25 pre-exposure
    // multiply either — only `defaultBillboardFragment` had it — so Jupiter, Saturn,
    // Uranus, Neptune, Earth, Venus and Mars were not pre-exposure invariant at the
    // far tier. `uSunIlluminance` carries pre-exposure (CelestialBody sets
    // `illum × getPreExposure() × starColour`), so this single change fixes D04 and
    // that missed half of D25 together — and it is why the `.mul(uPreExposure)` had to
    // come OUT of the default fragment: keeping both would double-count it.
    const reflectance = buildFrag({
      // ── D09: luminance AND hue derived from bodyPhotometry ────────────────
      // Wrapped for the same reason `surfaceRadiance` below is wrapped — see
      // `derivedFarAlbedo`. Without it this tier carried an 8.7× per-body spread.
      albedo: derivedFarAlbedo(bodyId, farConfig.albedo),
      uSpR,
      uSpU,
      uSpF,
    });
    m.fragmentNode = Fn(() => {
      // `.toVar()` so the builder's subgraph — including its `Discard` — is emitted
      // once rather than duplicated by reading `.xyz` and `.w` separately.
      const refl = vec4(reflectance).toVar();
      // ── COMPLEMENTARY CROSSFADE with the stellar point ────────────────────
      // `uFarFade` is `1 − stellarPointFade(...)`, so the billboard hands its flux to
      // the point rather than the two summing. Total stays `E_cam` THROUGH the
      // transition, by construction, instead of being tuned to look continuous.
      //
      // ⚠ Before this the point simply drew ON TOP with its own `fade`, and because it
      // also wrote depth it OCCLUDED the billboard: measured flux fell 20× the instant
      // the point appeared. A crossfade needs both halves to move — one fading in
      // while the other fades out — or it is just an overdraw.
      return vec4(
        surfaceRadiance(refl.xyz, uSunIlluminance).mul(uFarFade),
        refl.w,
      );
    })();

    return m;
  }, [
    uSpR,
    uSpU,
    uSpF,
    uSunIlluminance,
    uFarFade,
    scaledRadius,
    farConfig,
    sizeMultiplier,
    bodyId,
  ]);

  return { geo, mat };
}
