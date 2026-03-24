#!/usr/bin/env node
/**
 * generate-lod1.mjs — Generate simplified LOD1 asteroid models.
 *
 * Strips all textures, sets a flat grey PBR material, simplifies geometry
 * to ~50% vertex count, and writes a compact .glb alongside the original.
 *
 * Prerequisites (install in a temp dir, NOT in the project):
 *   npm install @gltf-transform/core @gltf-transform/extensions \
 *               @gltf-transform/functions meshoptimizer draco3dgltf
 *
 * Usage:
 *   node tools/generate-lod1.mjs public/models/asteroids/asteroid01.glb [...]
 *
 * Output: public/models/asteroids/asteroid01_lod1.glb (same dir, _lod1 suffix)
 */

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { simplify, weld, dedup, prune } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import draco3d from 'draco3dgltf';

await MeshoptSimplifier.ready;

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  });

const inputFiles = process.argv.slice(2);

if (inputFiles.length === 0) {
  console.error('Usage: node tools/generate-lod1.mjs <input.glb> [...]');
  process.exit(1);
}

for (const inputPath of inputFiles) {
  const outputPath = inputPath.replace(/\.glb$/, '_lod1.glb');
  console.log(`Processing: ${inputPath} → ${outputPath}`);

  const document = await io.read(inputPath);
  const root = document.getRoot();

  // Strip ALL textures
  for (const texture of root.listTextures()) {
    texture.dispose();
  }

  // Set materials to simple flat grey (no textures)
  for (const material of root.listMaterials()) {
    material.setBaseColorFactor([0.15, 0.14, 0.13, 1.0]);
    material.setMetallicFactor(0.0);
    material.setRoughnessFactor(1.0);
    material.setEmissiveFactor([0, 0, 0]);
    material.setBaseColorTexture(null);
    material.setNormalTexture(null);
    material.setOcclusionTexture(null);
    material.setMetallicRoughnessTexture(null);
    material.setEmissiveTexture(null);
  }

  // Weld, simplify geometry, deduplicate, prune
  await document.transform(
    weld(),
    simplify({ simplifier: MeshoptSimplifier, ratio: 0.5, error: 0.05 }),
    dedup(),
    prune(),
  );

  await io.write(outputPath, document);
  console.log(`Done: ${outputPath}`);
}
