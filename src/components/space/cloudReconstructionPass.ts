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
// The marcher (cloudFullscreenPass.ts) writes a *sparse* MRT RT at
// 1/SPARSE_DIVISOR² the full-res pixel count (SPARSE_DIVISOR=2 → ¼-res):
// attachment 0 = cloud colour, attachment 1 = tFront. Each sparse texel
// corresponds to one SPARSE_DIVISOR×SPARSE_DIVISOR tile of full-res pixels,
// with the marched sample taken at one sub-pixel of that tile (the Bayer
// schedule rotates which sub-pixel through SPARSE_DIVISOR² consecutive frames).
//
// This pass runs at FULL-resolution and, for every pixel, EMA-blends a
// bilinear upsample of the sparse marcher with the reprojected previous-frame
// history (the fresh/stale Bayer sub-pixel split below is retained for the
// variance-clamp neighbourhood + diagnostics, but the final blend is EMA over
// all pixels — see the §5.5.3 block near the bottom). For each full-res pixel
// (N = SPARSE_DIVISOR):
//
//   tile    = (x / N, y / N)          — which N×N tile this pixel is in
//   localSub= (x mod N, y mod N)      — which sub-pixel within the tile
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

// Checkerboard divisor — the marcher renders 1/SPARSE_DIVISOR² of the screen
// each frame (a sparse RT of W/N × H/N), and the reconstruction fills the rest
// from reprojected history over an N²-frame Bayer cycle. SINGLE SOURCE for the
// divisor; the marcher (cloudFullscreenPass) and the Bayer schedule
// (SpaceRenderer) import it.
//
//   N=4 → 1/16 of pixels/frame, 16-frame window. Cheapest, but a 16-frame-stale
//         history can't track fast/close clouds → motion noise.
//   N=2 → 1/4 of pixels/frame, 4-frame window. ~4× the marcher cost, but
//         history is only ~4 frames stale → tracks motion like the Nubis/SC
//         quarter-res designs. (Chosen 2026-06-01 to fix close/fast-cloud noise.)
//
// Changing N requires regenerating the Bayer pattern in SpaceRenderer to cover
// all N² sub-positions.
export const SPARSE_DIVISOR = 2;

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

// Temporal integration blend factor (Frostbite §5.5.3). Every frame, every
// pixel's value is an exponential moving average of the reprojected previous
// frame and the current marcher estimate:  out = lerp(history, current,
// EMA_ALPHA). Small → heavy history → smoother + better supersampling (the
// marcher's per-frame jitter averages over ~1/EMA_ALPHA frames), but leans
// harder on reprojection to stay sharp under motion. 0.1 ≈ a 10-frame window.
const EMA_ALPHA = 0.1;

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
  // Stored as a vec2 in [0, SPARSE_DIVISOR-1] integer space; the shader
  // floors localSub from the fragment coord and compares with int equality.
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

    // localSub = pixel coord mod N (0..N-1 within the N×N tile).
    const localSubX = px.sub(
      px.div(float(SPARSE_DIVISOR)).floor().mul(float(SPARSE_DIVISOR)),
    );
    const localSubY = py.sub(
      py.div(float(SPARSE_DIVISOR)).floor().mul(float(SPARSE_DIVISOR)),
    );

    // Tile index = pixel coord / N (one tile per N×N block).
    const tileX = px.div(float(SPARSE_DIVISOR)).floor();
    const tileY = py.div(float(SPARSE_DIVISOR)).floor();

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
    // target size) rather than computing fullW = sparseSize × SPARSE_DIVISOR.
    // Those two disagree by up to SPARSE_DIVISOR−1 pixels when
    // size.width × DPR isn't divisible by SPARSE_DIVISOR (e.g. a 1921 px
    // wide RT vs sparseSize.x × N = 1920). An earlier version used
    // `sparseSize × N` and produced a per-pixel NDC offset that scaled with
    // screen X — visible as cloud edges "streaming" from right to left,
    // faster on the right side of the screen. Using screenUV directly
    // avoids the issue entirely because it's WebGPU-builtin and normalises
    // against the actual RT.
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

    // Padding on each bound. With the EMA temporal pass the clamp is the SOLE
    // ghost handler, so it must reject only GROSS disoccluded history (bright
    // cloud reprojected onto sky) — never bite legitimate accumulation in
    // stable/high-variance regions (which would re-noise). 12.5% of the
    // neighbourhood range keeps it loose enough that only far-outside-the-
    // neighbourhood history is pulled in.
    const pad = float(0.125);
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

    // ── Frostbite-style temporal integration (§5.5.3) ──
    // Every pixel EMA-blends the current marcher estimate with the REPROJECTED
    // previous frame, every frame (1-frame latency, ~1/EMA_ALPHA-frame window).
    // This REPLACES the Bayer fresh/stale checkerboard, where each pixel was
    // refreshed only once per N² frames → a long stale window that couldn't
    // track motion and needed the clamp + soft-reject + motion-gate machinery
    // to paper over it. Frostbite marches the half-res cloud buffer every frame
    // and EMA-blends the reprojected history; we match that, using a bilinear
    // upsample of our half-res sparse marcher as `currentSample`.
    //
    //   out = lerp( rectifiedHistory, currentSample, EMA_ALPHA )
    //
    // - currentSample: the half-res sparse marcher sampled at the full-res UV
    //   (linear filtering → bilinear upsample) = this frame's estimate here.
    // - rectifiedHistory: previous frame's result at the reprojected UV,
    //   YCoCg-clamped to the local neighbourhood. The clamp is now the SOLE
    //   ghost handler — disoccluded history (far outside the neighbourhood) is
    //   pulled back, while in stable regions history sits inside the generously
    //   padded bound and passes through → clean accumulation. Off-screen /
    //   first-frame history → fall back to the current sample.
    const currentSample = texture(uSparseColorNode, screenUV);
    const rectifiedHistory = historyUsable.select(clampedHistory, currentSample);
    const finalRgba = mix(rectifiedHistory, currentSample, float(EMA_ALPHA));

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
