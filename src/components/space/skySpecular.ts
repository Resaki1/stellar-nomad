/**
 * SKY SPECULAR — a prefiltered environment cube so the hull REFLECTS the sky (S4b).
 *
 * S4 (`skyIrradiance.ts`) made the sky a diffuse light via SH-L2. SH cannot carry a
 * mirror reflection — 9 coefficients are a low-pass by construction — so glossy
 * surfaces still showed nothing of the Milky Way. This is the other half of the
 * engines' scheme: the split-sum approximation (Karis 2013), i.e. a cubemap
 * prefiltered per roughness, which three implements as PMREM + `EnvironmentNode`.
 *
 * ── WHY THIS DOES DIFFUSE TOO, AND WHY THE SH PROBE STAYS ────────────────────
 * `MeshStandardNodeMaterial.setupEnvironment` ends with an UNCONDITIONAL
 * `return new EnvironmentNode( envNode )`, and `EnvironmentNode` writes both
 * `context.radiance` (specular) and `context.iblIrradiance` (diffuse). There is no
 * supported hook for a specular-only environment: getting one needs either a
 * prototype patch on three or re-creating every material as a subclass. Both are
 * engine-level shifts, so the environment supplies BOTH terms and `SkyLight`'s probe
 * is held at intensity 0.
 *
 * 🔑 The probe is kept anyway, and not out of sentiment — **it is the reference that
 * validates this capture.** Its coefficients are analytic for point sources, so
 * comparing the cube's implied irradiance against the SH's is the only way to prove
 * the 8,920 stars carry the right flux through a rasterised cube face. That is the
 * single most likely thing to be wrong here (see the σ trap below), and no
 * screenshot would reveal it.
 *
 * A is also photometrically sound, which is why it costs little: `StarField`
 * conserves flux at ANY resolution (`uPsfNorm = 1/(2πσ²·Ω_pixel)` is rebuilt from
 * the live pixel solid angle), and PMREM's irradiance mip is a proper cosine
 * convolution. The SH's exactness advantage is real but small, because diffuse
 * irradiance is a 9-coefficient low-pass anyway — the Ramamoorthi argument cuts
 * both ways.
 *
 * ── ⚠⚠ THE TRAP: STAR FLUX IS RESOLUTION-DEPENDENT AT CAPTURE TIME ───────────
 * `StarField` sets `uQuadWorld` and `uPsfNorm` each frame from the CANVAS drawing
 * buffer height and FOV. Rendering into a 256² cube face without overriding them
 * leaves the sprites sized for the on-screen buffer — every star's flux off by
 * **85.5×**, and it would present as "the reflections are just too bright", i.e. as
 * a look problem rather than a units problem.
 *
 * ⚠ 85.5×, NOT (1816/256)² = 50×. A cube face is 90° FOV, so its `tanPerPx` is
 * 7.81e-3 against the canvas's 8.45e-4 — 9.245× linear, squared for solid angle. I
 * first quoted 50× by using the height ratio alone; the projection is linear in
 * **tan**(angle), which is the same trap as the `pxAngle = fov/height` bug. Hence
 * `withStarCaptureResolution` takes fov AND height and runs the shared derivation.
 * This is the same resolution-dependence D31 was about, and the reason
 * `__lum.star()` gates on flux rather than peak.
 *
 * ── ⚠ THE CUBE HAS ITS OWN NUMERIC SCALE, AND IT IS NOT A DISPLAY GAIN (§15) ──
 * The captured cube is a half-float texture, and the physical sky is ~1.3e-8 game
 * units against RGBA16F's smallest subnormal of 2⁻²⁴ = 5.96e-8 — so a capture at
 * unit scale stores BLACK, exactly as the SH bake did before it was fixed. This used
 * to lean on `STAR_ARTISTIC_GAIN = 1024` for that headroom, which quietly made a
 * player-facing look knob load-bearing for a storage format: when R7b replaced the
 * flat gain with an adaptation-driven lift that is correctly 1.0 in deep space, the
 * cube went dark and R7b had to be parked.
 *
 * 🔑 Both live display factors are now divided out at capture time and a FIXED,
 * derived `skyCaptureScaleFor(mean)` substituted, then divided straight back out by
 * `uSkyEnvDecode` on read. `skyCaptureEncode.ts` holds the derivation, the measured
 * half-float margins, and the pre-exposure-squared defect this also fixed.
 *
 * ⚠ So the environment node applies BOTH per-frame factors — `uPreExposure` because
 * it drifts with adaptation and a stale value desynchronises the reflections from
 * every other radiance source, and `uStarLift` because `SkyLight`'s invariant is
 * that the hull must be lit by the sky the player can SEE.
 */

import * as THREE from "three";
import { CubeRenderTarget } from "three/webgpu";
import { pmremTexture } from "three/tsl";
import { getPreExposure, uPreExposure } from "@/components/space/photometry";
import { getStarLift, uStarLift } from "@/components/space/starVisibility";
import {
  commitSkyCaptureScale,
  skyCaptureScaleFor,
  uSkyEnvDecode,
  withSkyCaptureEncode,
} from "@/components/space/skyCaptureEncode";

/**
 * Layer carrying ONLY the sky (panorama + starfield), so the capture camera can
 * render the sky without the planets that share the scaled scene.
 *
 * ⚠ The sky objects `enable()` this layer, they do not `set()` it — they must stay on
 * layer 0 for the on-screen render. `layers.set()` mutates persistent Object3D state
 * and has bitten this project before (the D26 layer-split attempt, where reverting
 * the code did not revert the scene and a reload was needed).
 */
export const SKY_CAPTURE_LAYER = 3;

/**
 * Face resolution of the captured cube.
 *
 * 256 gives ~0.35°/texel, which resolves the band's structure and keeps bright
 * stars as recognisable points at mirror roughness. PMREM's cost is dominated by
 * the mip chain, so this is the knee: 512 quadruples the capture for detail that a
 * roughness-weighted lookup mostly blurs away again.
 */
export const SKY_CUBE_SIZE = 256;

/**
 * Cube faces drawn per `captureSkyCube` call.
 *
 * 🔑 THE CAPTURE IS AMORTISED, WHICH IS HOW THE ENGINES DO IT. Unreal's SkyLight
 * "Real Time Capture" and Unity HDRP's dynamic ambient probe both re-capture the sky
 * on a rolling schedule and time-slice the convolution rather than rebuilding it in
 * one frame — because a sky that changes (an interstellar transit) needs re-capturing
 * *continuously*, and a 6-face burst is a visible hitch every time.
 *
 * ⚠ Mixed old/new faces are INVISIBLE while the sequence runs, and that is not luck:
 * materials sample the PMREM, which is a separate texture regenerated only once the
 * sixth face lands. The double-buffering the amortisation needs already existed.
 *
 * 1 costs ~6 frames of latency (100 ms at 60 fps) for a jump nobody can see, and
 * turns a continuous re-capture from a ~5 ms/frame tax into ~0.8 ms.
 */
const FACES_PER_CALL = 1;

let _cube: CubeRenderTarget | null = null;
let _captured = false;
let _captureCount = 0;
/** Next face to draw, and the scale the in-flight sequence started with. */
const _pending = { face: 0, scale: 0 };
/** PSF state observed DURING the last capture — the 85.5× trap's witness. */
const _capturePsf = { fovDeg: 0, bufferH: 0, psfNorm: 0 };

/** The captured environment cube, or null before the first capture. */
export const getSkyCube = (): THREE.Texture | null =>
  _cube ? _cube.texture : null;

/**
 * Whether a valid capture is standing. The CALLER drives capture off this rather
 * than its own one-shot, so `invalidateSkyCube()` re-captures with no other wiring.
 */
export const isSkyCubeCaptured = (): boolean => _captured;

/**
 * The cube RENDER TARGET, for `__lum.skyCapture()`'s readback.
 *
 * ⚠ Diagnostic only. Rendering must go through `getSkyEnvironmentNode()`, which is
 * the one place the decode is applied — a second reader of the raw texture is a
 * second place to forget it.
 */
export const getSkyCubeTarget = (): CubeRenderTarget | null => _cube;

export function skySpecularStatus(): {
  captured: boolean;
  faceSize: number;
  captures: number;
  /** Faces still to draw in the in-flight sequence; 0 means idle. */
  pendingFace: number;
  /** FOV StarField used while the faces were drawn. Must be 90. */
  capturePsfFovDeg: number;
  /** Buffer height StarField used while the faces were drawn. Must be SKY_CUBE_SIZE. */
  capturePsfBufferH: number;
  /** `uPsfNorm` as the shader saw it during the capture — the real witness. */
  capturePsfNorm: number;
} {
  return {
    captured: _captured,
    faceSize: SKY_CUBE_SIZE,
    captures: _captureCount,
    pendingFace: _pending.face,
    capturePsfFovDeg: _capturePsf.fovDeg,
    capturePsfBufferH: _capturePsf.bufferH,
    capturePsfNorm: _capturePsf.psfNorm,
  };
}

/**
 * Per-pixel tangent for one cube face — 90° FOV over `SKY_CUBE_SIZE` pixels.
 *
 * ⚠ Exported so the GATE can build the expected `uPsfNorm` from it. Deliberately NOT
 * combined with σ here: σ lives in `StarField`, and importing it back would recreate
 * the circular dependency this module already avoids for `getStarPsfInputs`. (I did
 * exactly that once — the fix is to let the one module that legitimately imports both
 * sides, `lumHarness`, do the combining.)
 */
export const captureTanPerPx = (): number =>
  (2 * Math.tan((90 * Math.PI) / 360)) / SKY_CUBE_SIZE;

/** Factored out purely so TypeScript can infer the node's type for the cache. */
const buildEnvNode = (tex: THREE.Texture) =>
  pmremTexture(tex)
    // Undo the encode scale FIRST, so what follows is physical radiance. A power of
    // two, so this is bit-exact — see skyCaptureEncode.ts.
    .mul(uSkyEnvDecode)
    .mul(uPreExposure)
    .mul(uStarLift);

let _envNode: ReturnType<typeof buildEnvNode> | null = null;

/**
 * The node to assign to `scene.environmentNode`, or null before the first capture.
 *
 * ⚠ `× uPreExposure` HERE, not on the texture and not on the scene. The gain is baked
 * into the capture (half-floats would underflow otherwise) but pre-exposure drifts
 * with adaptation, so it has to be a live uniform — and `scene.environmentIntensity`
 * is DEAD in the WebGPU node path (it exists on `Scene` but nothing reads it; only
 * `material.envMapIntensity` reaches the shader). `EnvironmentNode` uses a
 * non-texture `envNode` directly via `.context(…)`, and TSL contexts propagate down
 * the subtree, so the PMREM lookup inside still receives the roughness context.
 */
export function getSkyEnvironmentNode(): ReturnType<typeof buildEnvNode> | null {
  if (!_captured || !_cube) return null;
  if (!_envNode) _envNode = buildEnvNode(_cube.texture);
  return _envNode;
}

/**
 * Everything the capture needs, injected rather than imported, so this module has
 * no opinion about how the scene graph is arranged.
 *
 * @param renderSkyToFace Draws the sky (panorama + starfield) for one cube face.
 *   Supplied by the caller because only it knows which scene and which layers hold
 *   the sky, and because it must set the camera per face.
 * @param withCaptureResolution Runs `body()` with `StarField`'s PSF uniforms
 *   rebuilt for `faceSize`, restoring them afterwards. MANDATORY — see the header.
 */
export type SkyCaptureDeps = {
  renderer: {
    setRenderTarget: (
      rt: CubeRenderTarget | null,
      activeCubeFace?: number,
    ) => void;
    render: (scene: THREE.Object3D, camera: THREE.Camera) => void;
  };
  scene: THREE.Object3D;
  layers?: THREE.Layers;
  withCaptureResolution: <T>(faceSize: number, body: () => T) => T;
  /**
   * Reads the PSF inputs StarField is currently using, so the capture can WITNESS
   * that the override took effect rather than trust it.
   *
   * ⚠ Injected rather than imported to break a cycle: `StarField` imports
   * `SKY_CAPTURE_LAYER` from this module, so importing `getStarPsfInputs` back would
   * make the two modules circular. That works under today's bundler and is exactly
   * the kind of thing that stops working after an unrelated reorder — and this module
   * already injects everything else for the same reason.
   */
  readPsfInputs: () => { fovDeg: number; bufferH: number };
  /**
   * Reads `uPsfNorm` as the shader will sample it. ⚠ This, not `readPsfInputs`, is
   * the load-bearing witness: it is the actual uniform, so it cannot agree with the
   * gate unless the override truly reached the GPU-side value.
   */
  readPsfNorm: () => number;
  /**
   * The panorama's MEASURED mean radiance in game units, which sets the cube's
   * encode scale (§15).
   *
   * ⚠ Injected for the same reason as everything else here: it lives in
   * `skyIrradiance`, whose bake is what measures it, and importing it would give
   * this module an opinion about which sky is loaded. Returns 0 before the bake
   * resolves — `captureSkyCube` then refuses rather than guessing a scale.
   */
  readSkyMeanRadiance: () => number;
  /**
   * Runs `body()` with the PANORAMA's mip LOD rebuilt for `faceSize`, restoring it
   * afterwards. MANDATORY, for exactly the reason `withCaptureResolution` is.
   *
   * ⚠ The panorama has the same resolution dependence the stars do and had no
   * override: `uSkyLod` is written from the ON-SCREEN camera, which for an 8192-wide
   * equirect is 0.140, while a 256² 90° face wants 3.35 — so the cube sampled the
   * band **3.21 mips too sharp**, i.e. 9.2× undersampled per axis. Numerically the
   * same ratio the star path's 85.5× trap was, appearing as aliasing rather than as
   * flux. Static and invisible while the capture was one-shot; once R7f re-captures
   * periodically, every set re-samples the galactic band at a different sub-texel
   * phase and the reflected Milky Way CRAWLS on the hull at the re-capture rate.
   */
  withCaptureLod: <T>(faceSize: number, body: () => T) => T;
  /**
   * Re-publish the observer position the star field places sprites from.
   *
   * ⚠ MANDATORY. The capture runs in a priority-0 `useFrame` while the on-screen
   * writer is at priority 1, so without this the cube is built from a ONE-FRAME-OLD
   * observer — 0.23° at the dev 1 ly/s override, and 0.68° of seam between face 0
   * and face 5 of a 6-frame set. Same lesson as `_setPsfForBuffer`: a capture cannot
   * wait for the next useFrame.
   */
  refreshObserver: () => void;
};

const _camera = new THREE.PerspectiveCamera(90, 1, 0.1, 2e6);

/**
 * Look directions for the six faces, in three's cube order
 * (+X, −X, +Y, −Y, +Z, −Z), with the `up` vectors three's own `CubeCamera` uses.
 * Transcribed rather than derived: a sign error here mirrors one face and shows up
 * only as a subtly wrong reflection, which is very hard to see and very easy to
 * argue about.
 */
const FACES: Array<{ dir: THREE.Vector3; up: THREE.Vector3 }> = [
  { dir: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, -1, 0) },
  { dir: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, -1, 0) },
  { dir: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, 1) },
  { dir: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(0, 0, -1) },
  { dir: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, -1, 0) },
  { dir: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, -1, 0) },
];

const _target = new THREE.Vector3();

/**
 * Draw up to `FACES_PER_CALL` faces of the environment cube. **Call every frame
 * while `isSkyCubeCaptured()` is false** — the sequence spans several frames.
 *
 * Returns true only on the call that COMPLETES a set (all six faces fresh and the
 * PMREM invalidated); false while a sequence is still running, and also false if it
 * could not start. The caller therefore retries rather than latching a black
 * environment — a silently black IBL is invisible until someone notices the hull has
 * no reflections, which could be weeks.
 */
export function captureSkyCube(deps: SkyCaptureDeps): boolean {
  const {
    renderer,
    scene,
    layers,
    withCaptureResolution,
    readPsfInputs,
    readPsfNorm,
    readSkyMeanRadiance,
    withCaptureLod,
    refreshObserver,
  } = deps;
  refreshObserver();
  // ⚠ THE SCALE IS FROZEN WHEN THE SEQUENCE STARTS, not re-derived per face. Six
  // faces at six different encodings is a cube with seams the decode cannot undo,
  // and it would only appear once the sky's mean starts moving (procedural systems).
  if (_pending.face === 0) {
    // ⚠ Refuse rather than fall back to an authored scale. A wrong encode scale is
    // silent — the hull just looks "too bright" or loses its reflections — and the
    // caller retries every frame, so waiting one more frame costs nothing.
    const derived = skyCaptureScaleFor(readSkyMeanRadiance());
    if (derived <= 0) return false;
    _pending.scale = derived;
  }
  const scale = _pending.scale;
  if (!_cube) {
    _cube = new CubeRenderTarget(SKY_CUBE_SIZE, {
      type: THREE.HalfFloatType,
      colorSpace: THREE.NoColorSpace,
      depthBuffer: false,
      generateMipmaps: false,
    });
  }
  const cube = _cube;

  // ⚠ TWO MANDATORY OVERRIDES, both of which would present as a look problem:
  //   • resolution — the 85.5× star-flux trap in the header;
  //   • encode — without it the cube freezes this frame's adaptation and
  //     pre-exposure is applied twice (§15).
  //
  // 🔑 The display factor is read PER CALL while the scale is frozen per sequence,
  // and that asymmetry is what makes the amortisation exposure-safe: each face
  // divides out the adaptation that was live when IT was drawn, so all six still
  // store `radiance × scale` even if the player turned toward the sun mid-sequence.
  return withCaptureResolution(SKY_CUBE_SIZE, () =>
    withCaptureLod(SKY_CUBE_SIZE, () =>
      withSkyCaptureEncode(scale, getPreExposure() * getStarLift(), () => {
        // Witness the override actually took effect. Recording it (rather than trusting
        // it) is what lets `__lum.skyProbe()` assert against the 85.5× trap instead of
        // hoping someone remembered to wire `withCaptureResolution`.
        const psf = readPsfInputs();
        _capturePsf.fovDeg = psf.fovDeg;
        _capturePsf.bufferH = psf.bufferH;
        _capturePsf.psfNorm = readPsfNorm();
        _camera.fov = 90;
        _camera.aspect = 1;
        // The sky sits on a shell at the scaled origin, so the capture camera stands at
        // the origin. Any offset would introduce a parallax the sky does not have.
        _camera.position.set(0, 0, 0);
        if (layers) _camera.layers.mask = layers.mask;
        _camera.near = 0.1;
        _camera.far = 2e6;
        _camera.updateProjectionMatrix();

        const last = Math.min(_pending.face + FACES_PER_CALL, 6);
        for (let i = _pending.face; i < last; i++) {
          const f = FACES[i];
          _target.copy(_camera.position).add(f.dir);
          _camera.up.copy(f.up);
          _camera.lookAt(_target);
          _camera.updateMatrixWorld(true);
          renderer.setRenderTarget(cube, i);
          renderer.render(scene, _camera);
        }
        renderer.setRenderTarget(null);
        _pending.face = last;
        if (last < 6) return false;
        _pending.face = 0;
        // ⚠ The decode and the PMREM invalidation must land in the SAME step: until
        // this line the materials are still sampling the previous set of faces, so a
        // decode published earlier would pair a new scale with old texels.
        commitSkyCaptureScale(scale);
        // ⚠ MANDATORY ON A RE-CAPTURE. `PMREMNode` regenerates its mip chain only when
        // `texture.pmremVersion` changes, and only the `needsPMREMUpdate` setter bumps
        // it — so without this an interstellar re-capture writes six fresh faces that
        // the roughness lookup never sees, and the hull keeps reflecting the old sky.
        // It is ALSO what makes the amortisation invisible: the PMREM the materials
        // sample stays on the previous set until this line runs.
        cube.texture.needsPMREMUpdate = true;
        _captured = true;
        _captureCount++;
        return true;
      }),
    ),
  );
}

/**
 * Drop the capture so the following frames re-take it (interstellar jump).
 *
 * ⚠ No black frame: the materials keep sampling the PMREM built from the previous
 * set until the new one completes. Resets `_pending.face` so an invalidate landing
 * mid-sequence restarts cleanly rather than finishing a half-stale set.
 */
export function invalidateSkyCube(): void {
  _captured = false;
  _pending.face = 0;
}
