import * as THREE from "three";
import { NodeMaterial } from "three/webgpu";
import {
  Fn,
  uniform,
  screenCoordinate,
  screenUV,
  vec2,
  vec3,
  vec4,
  float,
  texture,
  dot,
  normalize,
  sqrt,
  max as tslMax,
  min as tslMin,
  clamp,
  mix,
} from "three/tsl";

// =============================================================================
// Phase D — Cloud reconstruction pass (D3 + D4 + D5)
//
// The marcher (cloudFullscreenPass.ts) now writes a *sparse* RT at 1/16 the
// full-res pixel count: each sparse texel corresponds to one 4×4 tile of
// full-res pixels, with the marched sample taken at one specific sub-pixel
// of that tile (the Bayer schedule rotates which sub-pixel through 16
// consecutive frames).
//
// This pass runs at FULL-resolution and fills in the other 15/16 pixels by
// reprojecting them from the previous frame's reconstructed history. For
// each full-res pixel:
//
//   tile    = (x >> 2, y >> 2)        — which 4×4 tile this pixel is in
//   localSub= (x & 3,  y & 3)         — which sub-pixel within the tile
//   freshSub= uBayerSubPixel          — which sub-pixel was marched this frame
//
//   if localSub == freshSub:
//     output = sparseColor[tile]      — direct copy of fresh marched sample
//   else:
//     worldHit = camPos + rd × tFront(tile)
//     prevUV   = projectByPrevViewProj(worldHit + originShift)
//     history  = historyRt[prev].sample(prevUV)
//     bound    = YCoCgRange(3×3 neighbours of sparseColor[tile])
//     output   = ycocgClamp(history, bound)
//
// Output goes to `historyRt[current]` (full-res RGBA16F) which is then both
// composited onto the main scene RT (pass 3) AND read by next frame's
// reconstruction as the new history input.
//
// Disocclusion handling (D6):
//   - Off-screen prevUV → fall back to the tile's fresh sample
//   - YCoCg clamp → implicit rejection of divergent history (e.g. silhouette
//     crossings where reprojection lands across a cloud boundary)
//
// Origin-shift correction (D7) — already plumbed, applied here verbatim from
// `cloudFullscreenPass.ts`'s pre-Phase-D reprojection logic.
//
// Reference: Schneider 2015 "Real-Time Volumetric Cloudscapes of HZD"
// (Bayer-schedule reconstruction), Karis 2014 "High Quality Temporal
// Supersampling" (YCoCg clamp formulation).
// =============================================================================

export type CloudReconstructionPass = {
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  /**
   * Per-frame update. Call once per frame, before rendering the
   * reconstruction scene into `historyRt[writeIdx]`.
   *
   * - `scaledCamera`: current frame's scaled-world camera
   * - `earthMesh`: parent for Earth's world transform (for uEarthInverseModel)
   * - `bayerSubPixel`: the sub-pixel slot (0..3, 0..3) marched this frame
   * - `prevViewProj`: previous frame's combined scaled-world VP
   * - `originShiftScaled`: (currentOriginKm - prevOriginKm) × SCALED_UNITS_PER_KM
   * - `sparseColorTexture`: this frame's sparse marcher output (RGBA, 1/16 res)
   * - `sparseDepthTexture`: this frame's sparse depth output (R16F, 1/16 res)
   * - `historyTexture`: previous frame's reconstruction output (full-res)
   * - `historyValid`: 0 on first frame / after resize, 1 thereafter
   * - `sparseSize`: (sparseRtWidth, sparseRtHeight) — needed for the 3×3
   *   neighbour offset math (one texel = 1/sparseSize in UV space)
   */
  updateUniforms: (
    scaledCamera: THREE.PerspectiveCamera,
    earthMesh: THREE.Object3D,
    bayerSubPixel: THREE.Vector2,
    prevViewProj: THREE.Matrix4,
    originShiftScaled: THREE.Vector3,
    sparseColorTexture: THREE.Texture,
    sparseDepthTexture: THREE.Texture,
    historyTexture: THREE.Texture,
    historyValid: number,
    sparseSize: THREE.Vector2,
  ) => void;
  dispose: () => void;
};

export type SetupCloudReconstructionOpts = {
  // Earth outer-shell radius (scaled units). Reused for the "no cloud hit"
  // depth fallback when tFront is unavailable.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uOuterRadius: any;
};

// =============================================================================
// DIAGNOSTIC — set to anything other than 'off' to isolate noise sources.
// Most modes force α=1 on output so they REPLACE the cloud composite (not
// blended), making the diagnostic unambiguous.
//
//   'off'             : normal reconstruction (fresh-blend, variance clamp, …)
//
//   ── Source-isolation modes ──
//
//   'sparseOnly'      : skip ALL temporal logic. Every pixel reads the sparse
//                       RT tile's fresh sample directly. Tile-blocky output;
//                       each tile reveals the marcher's raw output for THIS
//                       frame's Bayer sub-pixel.
//                       Watch: do tiles vary strongly between neighbours
//                       (marcher per-ray variance) or look similar but flicker
//                       across frames (per-frame STBN variance).
//
//   'freshNoBlend'    : reconstruction runs normally but FRESH_ALPHA=1.0
//                       (no history blend on fresh; pure replace). Stale path
//                       unchanged. Tests whether the fresh-blend is helping.
//
//   ── Channel-isolation modes (force α=1; greyscale visualisation) ──
//
//   'alpha'           : output channel = current reconstruction alpha. Black
//                       = transparent, white = opaque. Reveals whether the
//                       dark "holes" in cloud bodies are α=0 (marcher missed
//                       cloud) or just dark colour with non-zero α.
//
//   'sparseAlpha'     : output channel = sparse RT's alpha at the tile. Same
//                       as 'alpha' but BEFORE temporal accumulation. Reveals
//                       whether the marcher itself is returning binary α=0
//                       tiles inside cloud bodies (the "first-hit miss" bug).
//
//   'tFront'          : visualise per-tile sparseDepthRt.r normalised to
//                       [0, 0.05] (~50 km scaled range). Greyscale: black = no
//                       cloud hit (sentinel −1), grey = mid-distance hit,
//                       white = far hit. If a cloud-body tile shows BLACK
//                       here, the marcher missed cloud entirely at that tile.
//
//   ── Behaviour-inspection modes ──
//
//   'isFresh'         : red = pixel is the fresh sub-pixel of its tile this
//                       frame, blue = stale. Shows the Bayer schedule
//                       movement; static frame should show one sub-pixel per
//                       4×4 tile coloured red.
//
//   'historyUsable'   : green = history is usable (in bounds + historyValid),
//                       red = history disocclusion fallback to fresh sample.
//                       Reveals where reconstruction is degrading to tile-
//                       blocky fresh-sample fallback.
//
//   'sparseRgb'       : sparse RT tile RGB with α=1 (no blending). Cleaner
//                       look at what the marcher is producing per tile this
//                       frame, ignoring alpha effects.
//
// =============================================================================
type ReconstructionDebug =
  | "off"
  | "sparseOnly"
  | "freshNoBlend"
  | "alpha"
  | "sparseAlpha"
  | "tFront"
  | "isFresh"
  | "historyUsable"
  | "sparseRgb";
const DEBUG_RECONSTRUCTION: ReconstructionDebug = "off";

export function setupCloudReconstructionPass(
  opts: SetupCloudReconstructionOpts,
): CloudReconstructionPass {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const geo = new THREE.PlaneGeometry(2, 2);
  const mat = new NodeMaterial();

  // Reconstruction writes directly to the history RT — no blend. This is a
  // *replace* pass, not a composite. The composite (pass 3) that follows
  // takes care of premul-alpha blending onto the main scene RT.
  mat.transparent = false;
  mat.depthTest = false;
  mat.depthWrite = false;
  mat.blending = THREE.NoBlending;

  // ── Shared camera / earth uniforms (mirror cloudFullscreenPass) ──
  const uCameraMatrixWorld = uniform(new THREE.Matrix4());
  const uCameraScaledPos = uniform(new THREE.Vector3());
  const uTanHalfFov = uniform(0);
  const uAspect = uniform(1);
  const uEarthInverseModel = uniform(new THREE.Matrix4());

  // ── Reprojection uniforms (origin shift fix already in place) ──
  const uPrevViewProj = uniform(new THREE.Matrix4());
  const uOriginShiftScaled = uniform(new THREE.Vector3());
  const uHistoryValid = uniform(0);

  // ── Bayer schedule: which sub-pixel was marched this frame.
  // Stored as a vec2 in [0, 3] integer space; the shader floors localSub
  // from the fragment coord and compares with int equality.
  const uBayerSubPixel = uniform(new THREE.Vector2(0, 0));

  // ── Sparse RT dimensions (one texel per 4×4 full-res tile). Used to
  // compute 1-texel UV offsets for the 3×3 neighbourhood sample.
  const uSparseSize = uniform(new THREE.Vector2(1, 1));

  // ── Texture nodes. Bound to placeholders at setup; swapped in via
  // updateUniforms each frame. Pattern matches the existing history
  // texture machinery in cloudFullscreenPass.ts.
  const placeholderColor = new THREE.DataTexture(
    new Uint8Array([0, 0, 0, 0]),
    1,
    1,
  );
  placeholderColor.needsUpdate = true;
  const placeholderDepth = new THREE.DataTexture(
    new Uint8Array([0, 0, 0, 0]),
    1,
    1,
  );
  placeholderDepth.needsUpdate = true;
  const placeholderHistory = new THREE.DataTexture(
    new Uint8Array([0, 0, 0, 0]),
    1,
    1,
  );
  placeholderHistory.needsUpdate = true;

  const uSparseColorNode = texture(placeholderColor);
  const uSparseDepthNode = texture(placeholderDepth);
  const uHistoryNode = texture(placeholderHistory);

  mat.fragmentNode = Fn(() => {
    // ── Full-res pixel coordinate of this fragment ──
    // screenCoordinate.xy gives pixel coords [0.5, W-0.5] × [0.5, H-0.5].
    // We need integer pixel index for tile/sub math.
    const px = screenCoordinate.x.floor();
    const py = screenCoordinate.y.floor();

    // localSub = pixel coord mod 4 (0..3 within the 4×4 tile).
    const localSubX = px.sub(px.div(float(4)).floor().mul(float(4)));
    const localSubY = py.sub(py.div(float(4)).floor().mul(float(4)));

    // Tile index = pixel coord >> 2 (one tile per 4×4 block).
    const tileX = px.div(float(4)).floor();
    const tileY = py.div(float(4)).floor();

    // Sparse-RT UV for this tile (texel-center of the tile in the sparse RT).
    const sparseUv = vec2(
      tileX.add(float(0.5)).div(uSparseSize.x),
      tileY.add(float(0.5)).div(uSparseSize.y),
    );

    // ── Fresh sample: the marched value for this tile this frame ──
    const freshRgba = texture(uSparseColorNode, sparseUv);
    const freshTFront = texture(uSparseDepthNode, sparseUv).r;

    // ── DIAGNOSTIC short-circuits ──
    // Each mode forces α=1 (except sparseOnly which preserves α for visual
    // comparison) so the diagnostic value REPLACES the cloud composite
    // unambiguously. Header comment block documents what each mode shows.
    if (DEBUG_RECONSTRUCTION === "sparseOnly") {
      return freshRgba;
    }
    if (DEBUG_RECONSTRUCTION === "sparseAlpha") {
      const a = freshRgba.a;
      return vec4(a, a, a, float(1));
    }
    if (DEBUG_RECONSTRUCTION === "sparseRgb") {
      return vec4(freshRgba.r, freshRgba.g, freshRgba.b, float(1));
    }
    if (DEBUG_RECONSTRUCTION === "tFront") {
      // tFront is in scaled-world units. Slab thickness ≈ 14 km grazing
      // ≈ 0.014 scaled, but with cloud-front-only detection most hits are
      // in [0, 0.05]. Normalise to that range; negative sentinel maps to
      // black.
      const g = freshTFront.div(float(0.05)).clamp(0, 1);
      const isHit = freshTFront.greaterThan(0).select(float(1), float(0));
      return vec4(g.mul(isHit), g.mul(isHit), g.mul(isHit), float(1));
    }

    // Is this fragment THE fresh sub-pixel of its tile this frame?
    const isFresh = localSubX.equal(uBayerSubPixel.x)
      .and(localSubY.equal(uBayerSubPixel.y));

    if (DEBUG_RECONSTRUCTION === "isFresh") {
      return isFresh.select(
        vec4(1, 0.3, 0.3, 1), // red = fresh
        vec4(0.3, 0.3, 1, 1), // blue = stale
      );
    }

    // ── Reproject using the tile's tFront ──
    // Step 1: reconstruct THIS pixel's world-space ray (full-res, not the
    //   sparse-RT centre — gives sub-pixel-accurate reprojection inside
    //   the tile).
    //
    // CRITICAL: derive NDC from `screenUV` (auto-tracks the actual render
    // target size) rather than computing fullW = sparseSize × 4. Those two
    // disagree by up to ~3 pixels when size.width × DPR isn't divisible by
    // 4 (e.g. 1921 px wide screen, sparseSize.x = 480, but historyRt.width
    // = 1921). The earlier version of this code used `sparseSize × 4` and
    // produced a per-pixel NDC offset that scaled with screen X — visible
    // as cloud edges "streaming" from right to left, faster on the right
    // side of the screen. Using screenUV directly avoids the issue entirely
    // because it's WebGPU-builtin and normalises against the actual RT.
    const ndcX = screenUV.x.mul(2).sub(1);
    const ndcY = float(1).sub(screenUV.y.mul(2));

    const rdView = vec3(
      ndcX.mul(uAspect).mul(uTanHalfFov),
      ndcY.mul(uTanHalfFov),
      float(-1),
    );
    const rdScaled = normalize(uCameraMatrixWorld.mul(vec4(rdView, 0)).xyz);

    // Outer-shell t for the "no cloud hit" / "approximate" depth case.
    // Sparse RT's tFront is in scaled-world units; sentinel < 0 means
    // the fresh sample's ray didn't hit cloud. In that case the stale
    // path falls back to outer-shell-t (sky depth) since reprojection
    // through a non-existent surface is just sky reprojection.
    const roEarth = uEarthInverseModel.mul(vec4(uCameraScaledPos, 1)).xyz;
    const rdEarth = normalize(uEarthInverseModel.mul(vec4(rdScaled, 0)).xyz);
    const b = dot(roEarth, rdEarth);
    const c = dot(roEarth, roEarth).sub(opts.uOuterRadius.mul(opts.uOuterRadius));
    const disc = b.mul(b).sub(c);
    const tShell = b.negate().sub(sqrt(tslMax(disc, float(0))));
    const useShell = disc.greaterThan(0).and(tShell.greaterThan(0));
    const tShellOrFar = useShell.select(tShell, float(1000));

    const hasCloudFront = freshTFront.greaterThan(0);
    const tReproj = hasCloudFront.select(freshTFront, tShellOrFar);

    // World-space hit point (scaled-world), then origin-shift to bring
    // it into the previous frame's coordinate system, then project.
    const reprojWorldPos = uCameraScaledPos.add(rdScaled.mul(tReproj));
    const reprojPrevFramePos = reprojWorldPos.add(uOriginShiftScaled);
    const prevClip = uPrevViewProj.mul(vec4(reprojPrevFramePos, 1));
    const prevNdcX = prevClip.x.div(prevClip.w);
    const prevNdcY = prevClip.y.div(prevClip.w);
    const prevUv = vec2(
      prevNdcX.mul(0.5).add(0.5),
      float(0.5).sub(prevNdcY.mul(0.5)),
    );

    // History sample (always read; the gating happens via inBounds below).
    const historyRgba = texture(uHistoryNode, prevUv);

    // ── YCoCg variance clamp (D4) ──
    // 3×3 neighbourhood of fresh sparse-RT samples around this tile.
    // Each tile sample is a full marcher output for that screen region
    // at this frame's sub-pixel; the bound spans local cloud-colour
    // variation that's CURRENT (not stale), so divergent history is
    // rejected. Doing it in YCoCg rather than RGB gives tighter chroma
    // bounds + wider luma bounds, which rejects ghost trails more
    // aggressively without killing legitimate luma TAA convergence.
    const dx = float(1).div(uSparseSize.x);
    const dy = float(1).div(uSparseSize.y);

    // Convert helpers (Karis 2014 convention).
    const rgbToY = (r: ReturnType<typeof float>, g: ReturnType<typeof float>, b2: ReturnType<typeof float>) =>
      r.mul(0.25).add(g.mul(0.5)).add(b2.mul(0.25));
    const rgbToCo = (r: ReturnType<typeof float>, b2: ReturnType<typeof float>) =>
      r.mul(0.5).sub(b2.mul(0.5));
    const rgbToCg = (r: ReturnType<typeof float>, g: ReturnType<typeof float>, b2: ReturnType<typeof float>) =>
      r.mul(-0.25).add(g.mul(0.5)).add(b2.mul(-0.25));

    // Sample 9 neighbours and accumulate YCoCg min/max bound.
    // Using `vec3` for Y/Co/Cg accumulators; alpha bound separately.
    const huge = float(1e6);
    const negHuge = float(-1e6);
    const yMin = huge.toVar();
    const yMax = negHuge.toVar();
    const coMin = huge.toVar();
    const coMax = negHuge.toVar();
    const cgMin = huge.toVar();
    const cgMax = negHuge.toVar();
    const aMin = huge.toVar();
    const aMax = negHuge.toVar();

    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const nUv = vec2(
          sparseUv.x.add(float(ox).mul(dx)),
          sparseUv.y.add(float(oy).mul(dy)),
        );
        const nRgba = texture(uSparseColorNode, nUv);
        const nY = rgbToY(nRgba.r, nRgba.g, nRgba.b);
        const nCo = rgbToCo(nRgba.r, nRgba.b);
        const nCg = rgbToCg(nRgba.r, nRgba.g, nRgba.b);
        yMin.assign(tslMin(yMin, nY));
        yMax.assign(tslMax(yMax, nY));
        coMin.assign(tslMin(coMin, nCo));
        coMax.assign(tslMax(coMax, nCo));
        cgMin.assign(tslMin(cgMin, nCg));
        cgMax.assign(tslMax(cgMax, nCg));
        aMin.assign(tslMin(aMin, nRgba.a));
        aMax.assign(tslMax(aMax, nRgba.a));
      }
    }

    // 10% padding on each bound to avoid over-tight clamps eating fine
    // luma variance (especially the dither variance STBN intentionally
    // produces frame-to-frame).
    const pad = float(0.1);
    const yPadV = yMax.sub(yMin).mul(pad);
    const coPadV = coMax.sub(coMin).mul(pad);
    const cgPadV = cgMax.sub(cgMin).mul(pad);
    const aPadV = aMax.sub(aMin).mul(pad);

    // Convert history to YCoCg, clamp, convert back.
    const hY = rgbToY(historyRgba.r, historyRgba.g, historyRgba.b);
    const hCo = rgbToCo(historyRgba.r, historyRgba.b);
    const hCg = rgbToCg(historyRgba.r, historyRgba.g, historyRgba.b);

    const cY = clamp(hY, yMin.sub(yPadV), yMax.add(yPadV));
    const cCo = clamp(hCo, coMin.sub(coPadV), coMax.add(coPadV));
    const cCg = clamp(hCg, cgMin.sub(cgPadV), cgMax.add(cgPadV));
    const cA = clamp(historyRgba.a, aMin.sub(aPadV), aMax.add(aPadV));

    // YCoCg → RGB (inverse of Karis convention).
    const tmp = cY.sub(cCg);
    const cR = tmp.add(cCo);
    const cG = cY.add(cCg);
    const cB = tmp.sub(cCo);
    const clampedHistory = vec4(cR, cG, cB, cA);

    // ── Disocclusion gating ──
    // 1) Off-screen previous UV → no valid history; use fresh sample.
    //    Even on stale pixels, the fresh sample IS the best estimate we
    //    have (sampled at the tile's marched sub-pixel).
    const inBounds = prevUv.x.greaterThan(0).and(prevUv.x.lessThan(1))
      .and(prevUv.y.greaterThan(0)).and(prevUv.y.lessThan(1));
    // 2) History invalid (first frame / resize / pass resumed) →
    //    same fallback.
    const historyUsable = inBounds.and(uHistoryValid.greaterThan(0));

    if (DEBUG_RECONSTRUCTION === "historyUsable") {
      // Green where history reprojection is valid; red where it's not
      // (off-screen or first frame). Anywhere red shows tile-blocky
      // fallback to the fresh marched sample.
      return historyUsable.select(
        vec4(0.3, 1, 0.3, 1),
        vec4(1, 0.3, 0.3, 1),
      );
    }

    // ── Final blend selection ──
    //
    // Fresh sub-pixel: blend the new marched sample (FRESH_ALPHA weight)
    //   with the *unclamped* reprojected history (1 − FRESH_ALPHA weight).
    //   This is the temporal-averaging step — each cycle through the
    //   Bayer 4×4 schedule injects 1 new dither realisation per pixel
    //   and averages it with the accumulated value from past cycles.
    //
    //   Steady-state variance reduction (geometric series):
    //       V = α / (2 − α) × σ_marcher²
    //   - α = 0.5 → 33% of input variance (≈ 0.58× stddev) — Schneider's HZD
    //   - α = 0.3 → 18% of input variance (≈ 0.42× stddev) — what we use
    //   - α = 0.1 → 5% of input variance (≈ 0.23× stddev) — very laggy
    //
    //   Convergence time at α = 0.3: 50% in ~3 cycles (≈ 0.8 s at 60 FPS),
    //   95% in ~10 cycles (≈ 2.7 s).
    //
    //   IMPORTANT: we blend against `historyRgba`, NOT `clampedHistory`.
    //   The clamp's bounds are derived from the CURRENT frame's 3×3 fresh
    //   neighbourhood — those neighbours all share this frame's dither
    //   realisation, so the clamp keeps history close to current-frame
    //   dither values. Blending against clamped history would average
    //   two samples from the same dither distribution → ~zero temporal
    //   smoothing. Blending against the *raw* reprojected history pulls
    //   in samples from past frames' different STBN slices → genuine
    //   variance reduction across realisations.
    //
    //   Ghost protection on the fresh path comes from the fresh sample
    //   dominating any ghost via the α weight: a ghost's contribution
    //   is multiplied by (1 − α) = 0.7 per cycle, halving every ~2 cycles.
    //   For silhouette transitions, the stale path still uses the strict
    //   variance clamp, so ghosts there are rejected hard.
    //
    // Stale sub-pixel with valid history: variance-clamped reprojected
    //   history (strict ghost rejection at silhouettes).
    // Either path with invalid history: fall back to the marched fresh
    //   sample for this tile — produces one-frame tile-blocky output
    //   that recovers as the next 16 frames sweep the Bayer schedule.
    // freshNoBlend debug: skip the fresh-blend (FRESH_ALPHA = 1.0).
    // Fresh pixels write raw marched value; stale pixels still use
    // clamped history. Diagnoses whether the fresh-blend is helping
    // or whether it's a wash (each pixel's converged value is its own
    // marched sample, no temporal averaging).
    const FRESH_ALPHA =
      DEBUG_RECONSTRUCTION === "freshNoBlend" ? float(1.0) : float(0.3);
    const freshBlended = mix(freshRgba, historyRgba, float(1).sub(FRESH_ALPHA));
    const freshOutput = historyUsable.select(freshBlended, freshRgba);
    const staleOutput = historyUsable.select(clampedHistory, freshRgba);
    const finalRgba = isFresh.select(freshOutput, staleOutput);

    if (DEBUG_RECONSTRUCTION === "alpha") {
      // Show reconstruction output's alpha channel as greyscale. Black
      // pixels mean fully transparent (sky bleeds through) — distinguishes
      // "marcher missed cloud" from "dark cloud colour".
      const a = finalRgba.a;
      return vec4(a, a, a, float(1));
    }

    return finalRgba;
  })();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  scene.add(mesh);

  const updateUniforms = (
    scaledCamera: THREE.PerspectiveCamera,
    earthMesh: THREE.Object3D,
    bayerSubPixel: THREE.Vector2,
    prevViewProj: THREE.Matrix4,
    originShiftScaled: THREE.Vector3,
    sparseColorTexture: THREE.Texture,
    sparseDepthTexture: THREE.Texture,
    historyTexture: THREE.Texture,
    historyValid: number,
    sparseSize: THREE.Vector2,
  ) => {
    uCameraMatrixWorld.value.copy(scaledCamera.matrixWorld);
    uCameraScaledPos.value.copy(scaledCamera.position);
    uTanHalfFov.value = Math.tan((scaledCamera.fov * Math.PI) / 180 / 2);
    uAspect.value = scaledCamera.aspect;
    earthMesh.updateWorldMatrix(true, false);
    uEarthInverseModel.value.copy(earthMesh.matrixWorld).invert();
    uBayerSubPixel.value.copy(bayerSubPixel);
    uPrevViewProj.value.copy(prevViewProj);
    uOriginShiftScaled.value.copy(originShiftScaled);
    uSparseColorNode.value = sparseColorTexture;
    uSparseDepthNode.value = sparseDepthTexture;
    uHistoryNode.value = historyTexture;
    uHistoryValid.value = historyValid;
    uSparseSize.value.copy(sparseSize);
  };

  const dispose = () => {
    scene.remove(mesh);
    mat.dispose();
    geo.dispose();
    placeholderColor.dispose();
    placeholderDepth.dispose();
    placeholderHistory.dispose();
  };

  return { scene, camera, updateUniforms, dispose };
}
