// Render layer IDs used to route specific meshes through separate render
// passes without splitting the scene graph. See SpaceRenderer.tsx for how
// each camera's layer mask is configured.
//
// Layer 0 is Three.js's default — any mesh without an explicit layer belongs
// there and is rendered by the main scaled / local passes.

// Cloud shell is rendered separately at half-res into its own RT, then
// composited back into the main RT with premultiplied alpha. Saves 3-4× on
// fragment fill cost.
export const CLOUD_LAYER = 2;
