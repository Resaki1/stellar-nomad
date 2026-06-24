import * as THREE from "three";
import { NodeMaterial } from "three/webgpu";
import { texture, screenUV } from "three/tsl";

// =============================================================================
// Atmosphere pass — fullscreen scaled-scene post-pass (see docs/ATMOSPHERE_PLAN.md).
//
// PHASE 0 (this file): PASSTHROUGH. The pass samples the scene-color texture
// (the scaled scene = planets + skybox + stars, already rendered into `rt`) and
// writes it verbatim into the bound output target (`rtB`). Everything downstream
// (cloud composite, local scene, post pipeline) then targets `rtB`. The result
// is pixel-identical to today's path — this exists only to land and verify the
// rtB plumbing before Phase 1 replaces the fragment with the LUT-based
// single+multiple-scattering raymarch.
//
// It mirrors the cloud pipeline's fullscreen-pass convention: an orthographic
// camera + a 2×2 quad with a NodeMaterial, owned here; the render targets are
// owned by SpaceRenderer (sized to the canvas/DPR) and passed in.
//
// The input texture is bound at material-build time (not reassigned per frame),
// matching the composite-mesh pattern in SpaceRenderer — the WebGPU bind-group
// cache does not reliably honour TextureNode `.value` reassignment mid-frame, so
// the pass is rebuilt (and the old one disposed) whenever `rt` is recreated
// (i.e. on resize).
// =============================================================================

export type AtmospherePass = {
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  mesh: THREE.Mesh;
  dispose: () => void;
};

/**
 * Build the Phase-0 passthrough atmosphere pass bound to `inputTexture` (the
 * scaled-scene color RT, `rt.texture`). Render its `scene` with its `camera`
 * into the output target to copy the scene color across.
 */
export function setupAtmospherePass(inputTexture: THREE.Texture): AtmospherePass {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const geometry = new THREE.PlaneGeometry(2, 2);

  const material = new NodeMaterial();
  material.transparent = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.blending = THREE.NoBlending;
  // Phase 1 replaces this with the scattering graph (reads inputTexture as the
  // background, applies transmittance + in-scatter). For now: identity copy.
  material.fragmentNode = texture(inputTexture, screenUV);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  scene.add(mesh);

  return {
    scene,
    camera,
    mesh,
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}
