"use client";

import { ReactNode, useEffect, useMemo, useRef } from "react";
import { createPortal, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { NodeMaterial, RenderPipeline, RenderTarget } from "three/webgpu";
import { texture, screenUV, vec2, float } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import {
  LOCAL_TO_SCALED_FROM_LOCAL_UNITS,
  SCALED_UNITS_PER_KM,
} from "@/sim/units";
import { useWorldOrigin } from "@/sim/worldOrigin";
import {
  HalfFloatType,
  AgXToneMapping,
  NeutralToneMapping,
  NoToneMapping,
} from "three";
import { useAtomValue } from "jotai/react";
import { settingsAtom } from "@/store/store";
import {
  getActiveCloudPipeline,
  getEarthMatrixWorldRef,
  STBN_FRAME_MODULUS,
} from "./cloudFullscreenPass";
import { SPARSE_DIVISOR } from "./cloudReconstructionPass";

const LOCAL_CAMERA_NEAR = 0.01;
// 20,000 km expressed in local meters
const LOCAL_CAMERA_FAR = 20_000 * 1000;
// 0.1 scaled units = 100 km. The closest geometry in the scaled scene
// is a planet surface at ~30+ scaled units (with floating origin), so
// this is safe. A tighter near plane gives far better depth precision
// at medium distances — fixes z-fighting on Saturn's rings at ~1.4M km.
// (Don't use logarithmicDepthBuffer — it breaks depth for custom vertexNode.)
const SCALED_CAMERA_NEAR = 0.001;
const SCALED_CAMERA_FAR = 2_000_000;

// ── Cloud-only resolution clamp ──────────────────────────────────────────────
// The whole scene renders at gl.getPixelRatio() (DPR, clamped to [0.5, 1.5] in
// Scene.tsx → 1.5 on a Retina M-series). The volumetric cloud pipeline (the
// sparse ray-marcher AND the full-res reconstruction) is the dominant GPU cost
// and scales with pixel count, so we render ONLY the clouds at
// min(DPR, CLOUD_MAX_DPR) and let the composite (pass 3) bilinearly upsample to
// the full-DPR scene RT. Result: clouds soften slightly; the planet, ship, and
// UI stay full-res. On a 1.5-DPR Retina, CLOUD_MAX_DPR=1.0 cuts cloud fragment
// count ~2.25× (both the marcher and the reconstruction). The marcher's sparse
// RT and the reconstruction/history RTs MUST share this DPR so the Bayer tile
// mapping (sparse = cloud-full / SPARSE_DIVISOR) stays exact. Raise toward the
// device DPR (e.g. 1.5) for sharper clouds at higher cost; set high (e.g. 4) to
// disable the clamp entirely.
const CLOUD_MAX_DPR = 1.0;

// Phase D reconstruction. The marcher writes a SPARSE RT (1/SPARSE_DIVISOR²
// of full pixels); a full-res reconstruction pass fills the rest from
// reprojected history with YCoCg variance clamping, over a SPARSE_DIVISOR²-
// frame Bayer cycle. SPARSE_DIVISOR is the single source (cloudReconstructionPass);
// the BAYER pattern below must cover all SPARSE_DIVISOR² sub-positions.
// See cloudFullscreenPass.ts and cloudReconstructionPass.ts.

// Bayer ordered-dither schedule, value → (x, y) sub-pixel slot. Each frame
// picks index `frameIndex mod BAYER.length`; after one full cycle every
// sub-pixel of every SPARSE_DIVISOR×SPARSE_DIVISOR tile has been marched once.
// MUST match SPARSE_DIVISOR: exactly SPARSE_DIVISOR² entries covering all
// sub-positions. This is the 2×2 pattern (N=2 → 4-frame cycle); for N=4 swap in
// the 16-entry 4×4 Bayer matrix.
const BAYER: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [1, 1], [1, 0], [0, 1],
];

const tempScaledPos = new THREE.Vector3();
const tempClearColor = new THREE.Color();
const tempBayerSub = new THREE.Vector2();
const tempViewProj = new THREE.Matrix4();
const tempOriginShiftScaled = new THREE.Vector3();
const tempFullSize = new THREE.Vector2();
const tempSparseSize = new THREE.Vector2();
const scaledScene = new THREE.Scene();
const localScene = new THREE.Scene();

// Halton(2,3) sub-pixel jitter is obsolete in the 1/16 reconstruction
// architecture — replaced by the deterministic BAYER schedule above.
// The Bayer slot index is `frameIndex % 16` and the sub-pixel offset is
// applied integer-pixel-wise inside the marcher (not as a fractional jitter).

// Full-screen quad for the cloud composite pass. One per SpaceRenderer
// lifetime — the cloud-texture node inside the material is rebuilt when the
// RT changes, but the geometry + camera are static.
const compositeScene = new THREE.Scene();
const compositeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const compositeGeometry = new THREE.PlaneGeometry(2, 2);

// ── Cloud spatial denoise (Step 1) ──────────────────────────────────────────
// The 1/16 reconstruction holds 16 INDEPENDENT single-sample marcher
// realisations side-by-side in every 4×4 tile: each pixel is refreshed once
// per 16 frames (Bayer schedule), then held. Temporal accumulation smooths
// each pixel's *time* series but does nothing for the *spatial* variance
// between neighbours — so the marcher's high single-sample variance shows up
// directly as salt-and-pepper, worst on thin/edge regions where the marcher's
// hit/miss is bistable. This is the noise that persists with a stationary
// camera (confirmed: `sparseOnly` flickers hard when still; `freshNoBlend`
// barely changes anything → the temporal blend isn't the lever).
//
// The references all pair temporal reprojection with a SPATIAL filter that our
// reconstruction lacks: Nubis renders at quarter-res + bilinear upsample (a
// 2×2 low-pass); Star Citizen and RDR2 run an explicit bilateral blur on the
// cloud buffer. We fold a small Gaussian gather into the composite fetch —
// cheap (no new pass/RT), and it blurs only the screen-facing copy, leaving
// the feedback-history RT clean so the blur can't compound across frames.
//
// Premultiplied-alpha values (the marcher returns vec4(col, alpha) premul)
// filter linearly, so a plain weighted average is halo-free at silhouettes:
// averaging toward transparent yields the soft cloud edge we want anyway.
//
//   0 = off (raw single fetch — the A/B baseline)
//   1 = 3×3 Gaussian   (default; +8 taps/pixel)
//   2 = 5×5 Gaussian   (+24 taps/pixel — use if 3×3 leaves residual grain)
const CLOUD_DENOISE_RADIUS = 2;

// Build the composite pass's fragment node for one history RT: either a raw
// single fetch (denoise off) or a normalised binomial-Gaussian gather over the
// premultiplied RGBA. Built once per RT (rebuilt on resize, when historyRts is
// recreated), so the JS-side weight loop runs at graph-build time — the shader
// just does 2r+1 squared texture fetches and a weighted sum per pixel.
function buildCompositeFetch(rt: RenderTarget) {
  if (CLOUD_DENOISE_RADIUS <= 0) {
    return texture(rt.texture, screenUV);
  }
  const r = CLOUD_DENOISE_RADIUS;
  const tx = 1 / Math.max(1, rt.width);
  const ty = 1 / Math.max(1, rt.height);
  // 1D binomial weights (Pascal row 2r) approximate a Gaussian; the 2D kernel
  // is their separable outer product. e.g. r=1 → [1,2,1], 2D sum = 16.
  const n = 2 * r;
  const w1d: number[] = [];
  for (let k = 0; k <= n; k++) {
    let coeff = 1;
    for (let i = 0; i < k; i++) coeff = (coeff * (n - i)) / (i + 1);
    w1d.push(coeff);
  }
  const taps: Array<[number, number, number]> = [];
  let wSum = 0;
  for (let oy = -r; oy <= r; oy++) {
    for (let ox = -r; ox <= r; ox++) {
      const w = w1d[ox + r] * w1d[oy + r];
      wSum += w;
      taps.push([ox, oy, w]);
    }
  }
  const sample = ([ox, oy, w]: [number, number, number]) =>
    texture(
      rt.texture,
      vec2(screenUV.x.add(float(ox * tx)), screenUV.y.add(float(oy * ty))),
    ).mul(float(w));
  let acc = sample(taps[0]);
  for (let i = 1; i < taps.length; i++) acc = acc.add(sample(taps[i]));
  return acc.div(float(wSum));
}

export type SpaceRendererProps = {
  scaled: ReactNode;
  local: ReactNode;
};

const SpaceRenderer = ({ scaled, local }: SpaceRendererProps) => {
  const settings = useAtomValue(settingsAtom);
  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);
  const localCamera = useThree(
    (state) => state.camera as THREE.PerspectiveCamera
  );
  // Floating-origin tracking. `worldOriginKm` is mutated every frame by
  // Spaceship.tsx to follow the ship's interpolated position, so the
  // scaled-world coordinate system slides under static objects from one
  // frame to the next. The cloud pass's TAA reprojection must subtract
  // this slide before sampling the history RT — see uOriginShiftScaled
  // in cloudFullscreenPass.ts.
  const worldOrigin = useWorldOrigin();

  const scaledCamera = useMemo(() => localCamera.clone(), [localCamera]);

  // Offscreen render target — both scenes render here with depth-clear
  // compositing, then the pipeline reads from it for bloom + tonemapping.
  const rt = useMemo(() => {
    const dpr = gl.getPixelRatio();
    return new RenderTarget(
      Math.floor(size.width * dpr),
      Math.floor(size.height * dpr),
      { type: HalfFloatType, depthBuffer: true }
    );
  }, [gl, size.width, size.height]);

  useEffect(() => () => { rt.dispose(); }, [rt]);

  // Phase D RT layout — two pairs:
  //
  //   sparseCloudRts: MRT pair, each W/SPARSE_DIVISOR × H/SPARSE_DIVISOR with
  //     TWO color attachments (count: 2):
  //       textures[0] = cloud colour RGBA16F (premultiplied)
  //       textures[1] = tFront cloud-front depth (scaled-world units in .r,
  //                     sentinel < 0 = no hit)
  //     The marcher (pass 2a) marches the volume ONCE and writes both via
  //     `outputStruct(rgba, vec4(tFront,…))`. This replaced a separate depth
  //     pass that re-ran the marcher for tFront only (that pass was cheap —
  //     the compiler dead-code-eliminated the lighting/cone-march that only
  //     feeds colour — so the merge saved ~25-30%, not 2×).
  //     Ping-pong only because the reconstruction pass reads it the same frame.
  //
  //   historyRts: cloud-DPR RGBA16F (= sparse × SPARSE_DIVISOR). Pass 2c
  //     (reconstruction) writes the final per-pixel cloud colour here; the
  //     off-parity is read back next frame as previous-frame history. Composite
  //     (pass 3) reads this RT and bilinearly upsamples it to the full-DPR scene
  //     RT (premul-alpha blend). Both this and the sparse RT use CLOUD_MAX_DPR.
  //
  // Both attachments default to RGBA16F (HalfFloatType); textures[1] only uses
  // .r but the extra channels at sparse res are negligible VRAM.
  const sparseCloudRts = useMemo(() => {
    const dpr = Math.min(gl.getPixelRatio(), CLOUD_MAX_DPR);
    const w = Math.max(1, Math.floor(size.width * dpr / SPARSE_DIVISOR));
    const h = Math.max(1, Math.floor(size.height * dpr / SPARSE_DIVISOR));
    const make = () => {
      const rt = new RenderTarget(w, h, {
        type: HalfFloatType,
        depthBuffer: false,
        count: 2,
      });
      rt.textures[0].name = "cloudColor";
      rt.textures[1].name = "cloudDepth";
      return rt;
    };
    return [make(), make()] as const;
  }, [gl, size.width, size.height]);

  const historyRts = useMemo(() => {
    // Cloud reconstruction runs at the clamped cloud DPR (must match the sparse
    // RT's DPR for the Bayer tile mapping). The composite upsamples this to the
    // full-DPR scene RT.
    const dpr = Math.min(gl.getPixelRatio(), CLOUD_MAX_DPR);
    const w = Math.max(1, Math.floor(size.width * dpr));
    const h = Math.max(1, Math.floor(size.height * dpr));
    return [
      new RenderTarget(w, h, { type: HalfFloatType, depthBuffer: false }),
      new RenderTarget(w, h, { type: HalfFloatType, depthBuffer: false }),
    ] as const;
  }, [gl, size.width, size.height]);

  useEffect(() => () => {
    sparseCloudRts[0].dispose();
    sparseCloudRts[1].dispose();
  }, [sparseCloudRts]);
  useEffect(() => () => {
    historyRts[0].dispose();
    historyRts[1].dispose();
  }, [historyRts]);

  // Composite meshes: read from the cloud-DPR historyRts (the reconstruction
  // output) and premul-alpha blend onto the full-DPR main scene RT (bilinear
  // upsample when CLOUD_MAX_DPR < device DPR). The fetch is a small binomial-
  // Gaussian gather (CLOUD_DENOISE_RADIUS) — a spatial denoise that removes the
  // per-pixel salt-and-pepper the reconstruction leaves behind. See
  // buildCompositeFetch + its header for the why.
  // Pre-built pair so the per-frame parity swap is just a parent/child
  // mutation (avoids TextureNode `.value` reassignment, which the WebGPU
  // backend's bind-group cache doesn't always honour mid-frame).
  const compositeMeshes = useMemo(() => {
    const make = (rt: RenderTarget) => {
      const mat = new NodeMaterial();
      mat.transparent = true;
      mat.depthTest = false;
      mat.depthWrite = false;
      mat.blending = THREE.CustomBlending;
      mat.blendSrc = THREE.OneFactor;
      mat.blendDst = THREE.OneMinusSrcAlphaFactor;
      mat.blendSrcAlpha = THREE.OneFactor;
      mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
      mat.fragmentNode = buildCompositeFetch(rt);
      return new THREE.Mesh(compositeGeometry, mat);
    };
    return [make(historyRts[0]), make(historyRts[1])] as const;
  }, [historyRts]);

  useEffect(() => () => {
    for (const mesh of compositeMeshes) {
      (mesh.material as NodeMaterial).dispose();
    }
  }, [compositeMeshes]);

  // RenderPipeline (replaces the old EffectComposer)
  const pipeline = useMemo(
    () => new RenderPipeline(gl as any),
    [gl]
  );
  const pipelineRef = useRef(pipeline);
  pipelineRef.current = pipeline;

  // Rebuild the node graph when bloom / toneMapping / RT changes
  useEffect(() => {
    const sceneTexture = texture(rt.texture);

    let outputNode: any = sceneTexture;
    if (settings.bloom) {
      const bloomPass = bloom(sceneTexture, 0.02, 0, 1);
      outputNode = sceneTexture.add(bloomPass);
    }

    pipeline.outputNode = outputNode;
    pipeline.needsUpdate = true;

    // Tone mapping applied by RenderPipeline's renderOutput() wrapper
    const renderer = gl as any;
    renderer.toneMapping = settings.toneMapping
      ? AgXToneMapping
      : NeutralToneMapping;

    return () => {
      pipeline.needsUpdate = true;
    };
  }, [settings.bloom, settings.toneMapping, pipeline, rt, gl]);

  // Camera setup
  useEffect(() => {
    localCamera.near = LOCAL_CAMERA_NEAR;
    localCamera.far = LOCAL_CAMERA_FAR;
    localCamera.updateProjectionMatrix();
  }, [localCamera]);

  useEffect(() => {
    scaledCamera.near = SCALED_CAMERA_NEAR;
    scaledCamera.far = SCALED_CAMERA_FAR;
    scaledCamera.fov = localCamera.fov;
    scaledCamera.aspect = size.width / size.height;
    scaledCamera.updateProjectionMatrix();
  }, [localCamera.fov, scaledCamera, size.height, size.width]);

  // Cleanup
  useEffect(() => () => { pipeline.dispose(); }, [pipeline]);

  const firstFrameLogged = useRef(false);
  // Ping-pong index: this frame writes cloudRts[frameParity], next frame
  // writes the other. compositeScene gets the matching mesh swapped in.
  const frameParity = useRef(0);
  const mountedCompositeMesh = useRef<THREE.Mesh | null>(null);
  // Phase D2: monotonic frame counter (mod BAYER.length) drives the Bayer
  // schedule lookup. Distinct from frameParity (which is just 2-state).
  // Also drives the STBN frame-slice uniform in the cloud pipeline
  // (advanced by 1/STBN_PERIOD_Z per frame inside setupCloudPipeline).
  const cloudFrameIndex = useRef(0);
  // Phase D3: previous frame's combined view-projection matrix in scaled
  // world space, snapshotted at end of frame. Identity on the first frame.
  const prevCloudViewProj = useRef(new THREE.Matrix4());
  // Phase D3+: previous frame's world origin (km). Used together with
  // prevCloudViewProj to express this frame's reprojection target in the
  // *previous* frame's scaled coordinate system. Without this, the
  // floating origin (which slides every frame in Spaceship.tsx) introduces
  // a velocity-proportional offset in the history sample UV.
  // `hasPrevWorldOrigin` is false on the very first render and is also
  // reset whenever we choose to invalidate history mid-session.
  const prevWorldOriginKm = useRef(new THREE.Vector3());
  const hasPrevWorldOrigin = useRef(false);
  // Phase D6: history-validity flag passed to the cloud pass each frame.
  // Starts at 0 so the first cloud render outputs only the new sample
  // (history is uninitialised). Flips to 1 after one full cycle. Reset to
  // 0 whenever the RT pair is recreated (resize) — the new RT may share
  // memory with a torn-down one but its content is undefined.
  const cloudHistoryValid = useRef(0);
  useEffect(() => {
    cloudHistoryValid.current = 0;
    hasPrevWorldOrigin.current = false;
  }, [historyRts, sparseCloudRts]);

  useFrame(() => {
    // Skip until WebGPU backend is ready (init is async).
    if (!(gl as any).initialized) return;

    if (!firstFrameLogged.current) {
      firstFrameLogged.current = true;
      performance.mark("first-frame-render");
      console.log(
        "[perf] First frame render",
        performance.now().toFixed(0) + "ms",
      );
    }

    // Advance the node frame so BloomNode's updateBefore runs each frame.
    // Normally the renderer's internal animation loop does this, but we
    // stopped it because R3F owns the frame loop (Scene.tsx: _animation.stop()).
    const renderer = gl as any;
    renderer._nodes.nodeFrame.update();

    // Sync scaled camera with local camera
    tempScaledPos
      .copy(localCamera.position)
      .multiplyScalar(LOCAL_TO_SCALED_FROM_LOCAL_UNITS);
    scaledCamera.position.copy(tempScaledPos);
    scaledCamera.quaternion.copy(localCamera.quaternion);

    // ── Render both scenes into the offscreen RT in linear HDR ──
    // Disable tone mapping so HDR values stay above 1.0 for bloom threshold.
    // RenderPipeline applies tone mapping + color space at the end.
    const savedToneMapping = renderer.toneMapping;
    const savedColorSpace = renderer.outputColorSpace;
    renderer.toneMapping = NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

    // Pass 1: scaled scene — planets, skybox, stars. Layer 0 only; the cloud
    // anchor mesh sits on CLOUD_LAYER (which no camera enables) and never
    // renders. It exists only as a matrixWorld provider for the fullscreen
    // pass below.
    scaledCamera.layers.enable(0);
    renderer.setRenderTarget(rt);
    gl.autoClear = true;
    gl.render(scaledScene, scaledCamera);

    // ── Phase D cloud pipeline: pass 2a (sparse color) → 2b (sparse depth)
    // → 2c (full-res reconstruction) → pass 3 (composite onto main RT). ──
    //
    // Premul-alpha clear (0,0,0,0) on the sparse color RT: non-zero clear
    // alpha would bleed the clear colour into cloud fringes during the
    // reconstruction's variance-clamp neighbourhood read.
    gl.getClearColor(tempClearColor);
    const savedClearAlpha = gl.getClearAlpha();
    gl.setClearColor(0x000000, 0);

    const writeIdx = frameParity.current;
    const sparseColorRt = sparseCloudRts[writeIdx];
    const historyWriteRt = historyRts[writeIdx];
    const historyReadRt = historyRts[writeIdx ^ 1];
    const writeCompositeMesh = compositeMeshes[writeIdx];

    const pipelineHandle = getActiveCloudPipeline();
    const earthMesh = pipelineHandle ? getEarthMatrixWorldRef() : null;

    if (pipelineHandle && earthMesh) {
      // Bayer schedule pick for this frame. Sub-pixel slot (0..N-1, 0..N-1)
      // marks which full-res pixel within every N×N tile is fresh this frame.
      const bayerIdx = cloudFrameIndex.current % BAYER.length;
      const [bx, by] = BAYER[bayerIdx];
      tempBayerSub.set(bx, by);

      // Full-res / sparse RT dims for the reconstruction pass's UV math.
      tempFullSize.set(historyWriteRt.width, historyWriteRt.height);
      tempSparseSize.set(sparseColorRt.width, sparseColorRt.height);

      // Origin shift = (currentOriginKm − prevOriginKm) × SCALED_UNITS_PER_KM.
      // First frame after mount / resize → no prev origin; zero the shift
      // (history is invalid this frame anyway via cloudHistoryValid).
      if (hasPrevWorldOrigin.current) {
        tempOriginShiftScaled
          .copy(worldOrigin.worldOriginKm)
          .sub(prevWorldOriginKm.current)
          .multiplyScalar(SCALED_UNITS_PER_KM);
      } else {
        tempOriginShiftScaled.set(0, 0, 0);
      }

      // One uniform-update call distributes state to both pass materials
      // (color MRT marcher, reconstruction). The two sparse inputs to
      // reconstruction are the two color attachments of the single MRT RT.
      pipelineHandle.updateUniforms({
        scaledCamera,
        earthMesh,
        bayerSubPixel: tempBayerSub,
        prevViewProj: prevCloudViewProj.current,
        originShiftScaled: tempOriginShiftScaled,
        sparseColorTexture: sparseColorRt.textures[0],
        sparseDepthTexture: sparseColorRt.textures[1],
        historyTexture: historyReadRt.texture,
        historyValid: cloudHistoryValid.current,
        frameIndex: cloudFrameIndex.current,
        fullSize: tempFullSize,
        sparseSize: tempSparseSize,
      });

      // Pass 2a: sparse color+depth marcher (MRT, ¼-res). One march writes
      // both attachments — textures[0] = colour, textures[1].r = tFront.
      renderer.setRenderTarget(sparseColorRt);
      gl.autoClear = true;
      gl.render(pipelineHandle.colorScene, pipelineHandle.colorCamera);

      // Pass 2c: full-res reconstruction. Reads both sparse attachments +
      // historyReadRt, writes historyWriteRt (full-res RGBA16F).
      renderer.setRenderTarget(historyWriteRt);
      gl.autoClear = true;
      gl.render(
        pipelineHandle.reconstructionScene,
        pipelineHandle.reconstructionCamera,
      );

      cloudHistoryValid.current = 1;
    } else {
      // No active pipeline (Earth not yet mounted, or player out of near
      // range). Clear the full-res history RT to fully transparent so the
      // composite contributes nothing this frame. Also invalidate history
      // for next time the pipeline resumes — its off-parity RT may have
      // been cleared here, and blending against (0,0,0,0) would briefly
      // erase the cloud.
      renderer.setRenderTarget(historyWriteRt);
      gl.autoClear = true;
      gl.clear();
      cloudHistoryValid.current = 0;
      hasPrevWorldOrigin.current = false;
    }

    gl.setClearColor(tempClearColor, savedClearAlpha);

    // Pass 3: composite the just-reconstructed full-res cloud RT → main rt
    // with premul-alpha blend. Swap which mesh sits in compositeScene to
    // match the historyRt we just wrote (each mesh's TextureNode is bound
    // to one specific RT at compile time).
    if (mountedCompositeMesh.current !== writeCompositeMesh) {
      if (mountedCompositeMesh.current) {
        compositeScene.remove(mountedCompositeMesh.current);
      }
      compositeScene.add(writeCompositeMesh);
      mountedCompositeMesh.current = writeCompositeMesh;
    }
    renderer.setRenderTarget(rt);
    gl.autoClear = false;
    gl.render(compositeScene, compositeCamera);

    // Pass 4: local scene (ship, asteroids, beam, lights) — clear depth only,
    // draw on top. This naturally composites local content over the scaled
    // background, including objects that don't write depth.
    gl.clearDepth();
    gl.render(localScene, localCamera);

    renderer.setRenderTarget(null);

    // Restore so the RenderPipeline picks them up for its renderOutput() pass
    renderer.toneMapping = savedToneMapping;
    renderer.outputColorSpace = savedColorSpace;

    // ── Apply postprocessing (bloom, tonemapping) and blit to canvas ──
    pipelineRef.current.render();

    // Advance the ping-pong parity so next frame writes the *other* history
    // RT (and reads this one back as history input).
    frameParity.current ^= 1;
    // Free-running frame counter. It drives TWO independent cycles, each via
    // its own modulo at the use site:
    //   • Bayer sub-pixel:  cloudFrameIndex % BAYER.length   (4)
    //   • STBN time slice:  cloudFrameIndex % STBN_FRAME_MODULUS (63)
    // Wrap at lcm = BAYER.length × STBN_FRAME_MODULUS so BOTH stay periodic and
    // every (sub-pixel, slice) pair is visited. CRITICAL: previously this wrapped
    // at BAYER.length (4), which starved the STBN slice to 4 of 63 values → near-
    // zero temporal decorrelation → the marcher's per-sample jitter never
    // averaged out → static sampling-shell bands. (Regression from BAYER 16→4.)
    cloudFrameIndex.current =
      (cloudFrameIndex.current + 1) % (BAYER.length * STBN_FRAME_MODULUS);

    // Phase D3: snapshot this frame's combined view-projection in scaled
    // space. Next frame this becomes `uPrevViewProj` and lets the shader
    // compute the previous-frame UV for the world point each pixel sampled.
    // matrixWorldInverse was updated by `gl.render(scaledScene, scaledCamera)`
    // above, so it's current as of this frame.
    tempViewProj.multiplyMatrices(
      scaledCamera.projectionMatrix,
      scaledCamera.matrixWorldInverse,
    );
    prevCloudViewProj.current.copy(tempViewProj);
    // Snapshot the world origin alongside the VP matrix — both describe
    // *this* frame's scaled coordinate system, and reprojection next frame
    // needs both to be consistent. (Spaceship.tsx mutates worldOriginKm
    // before each render frame, so the value we read here is the one the
    // scaled scene was just rendered with.)
    prevWorldOriginKm.current.copy(worldOrigin.worldOriginKm);
    hasPrevWorldOrigin.current = true;
  }, 1);

  return (
    <>
      {createPortal(scaled, scaledScene)}
      {createPortal(local, localScene)}
    </>
  );
};

export default SpaceRenderer;
