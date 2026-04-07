import * as THREE from "three";
import { NodeMaterial } from "three/webgpu";
import {
  Fn,
  uniform,
  texture,
  uv,
  normalWorld,
  positionWorld,
  modelWorldMatrix,
  cameraPosition,
  vec3,
  vec4,
  float,
  dot,
  normalize,
  clamp,
  pow,
  sub,
  mix,
  length,
  smoothstep,
  Discard,
} from "three/tsl";
import {
  SATURN_POSITION_KM,
  SATURN_RADIUS_KM,
} from "@/sim/celestialConstants";
import { kmToScaledUnits } from "@/sim/units";
import type { CelestialBodyConfig } from "../types";

export { SATURN_POSITION_KM, SATURN_RADIUS_KM };

const SATURN_ALBEDO = new THREE.Color(0.62, 0.55, 0.40);

// ── Saturn ring dimensions (km) ──
const RING_INNER_RADIUS_KM = 66_900;
const RING_OUTER_RADIUS_KM = 140_220;

// ─────────────────────────────────────────────────────────────────────
// Ring geometry: flat annulus with radial UV mapping
// ─────────────────────────────────────────────────────────────────────

function createRingGeometry(
  innerRadius: number,
  outerRadius: number,
  segments: number,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    // Inner vertex
    positions.push(cos * innerRadius, 0, sin * innerRadius);
    uvs.push(0, 0.5);

    // Outer vertex
    positions.push(cos * outerRadius, 0, sin * outerRadius);
    uvs.push(1, 0.5);

    if (i < segments) {
      const base = i * 2;
      // Two triangles per segment
      indices.push(base, base + 1, base + 2);
      indices.push(base + 1, base + 3, base + 2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// ─────────────────────────────────────────────────────────────────────
// Ring material: texture-mapped annulus with simple diffuse lighting
// ─────────────────────────────────────────────────────────────────────

function buildRingFragmentNode(
  ringTex: THREE.Texture,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSunRel: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uPlanetRadius: any,
) {
  return Fn(() => {
    const uvCoord = uv();
    // Ring texture is horizontal strip: u maps radially (0=inner, 1=outer)
    const samp = texture(ringTex, uvCoord);
    const albedo = samp.rgb;
    const alpha = samp.a;

    // Discard transparent gaps in the rings
    Discard(alpha.lessThan(0.05));

    const sunDir = normalize(uSunRel);

    // Rings are flat in XZ plane -- normal is (0,1,0).
    // Use abs of sun's Y component for how much light hits the ring plane.
    const sunElevation = clamp(sunDir.y.abs(), 0, 1);
    const diffuse = sunElevation.mul(0.7).add(0.3);

    // ── Planet shadow on rings ──
    // Ray-sphere intersection: cast ray from ring fragment toward sun.
    const planetCenter = modelWorldMatrix.mul(vec4(0, 0, 0, 1)).xyz;
    const fragWorld = positionWorld;
    const R = uPlanetRadius;

    const oc = fragWorld.sub(planetCenter);
    const b = dot(oc, sunDir);
    const c = dot(oc, oc).sub(R.mul(R));
    const discriminant = b.mul(b).sub(c);

    const sqrtDisc = discriminant.max(0).sqrt();
    const tNearest = b.negate().sub(sqrtDisc);
    const inShadow = discriminant.greaterThanEqual(0).and(
      tNearest.greaterThan(0).or(b.negate().add(sqrtDisc).greaterThan(0)),
    );
    const shadowMask = inShadow.select(float(0.05), float(1.0));

    const col = albedo.mul(diffuse).mul(shadowMask);

    return vec4(col, alpha);
  })();
}

// ─────────────────────────────────────────────────────────────────────
// Planet fragment (gas giant: limb darkening, light-wrap)
// ─────────────────────────────────────────────────────────────────────

function buildSaturnFragmentNode(
  colorTex: THREE.Texture,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSunRel: any,
) {
  return Fn(() => {
    const uvCoord = uv();
    const sunDir = normalize(uSunRel);
    const albedo = texture(colorTex, uvCoord).rgb;

    const N = normalize(normalWorld);
    const NdotL = dot(N, sunDir);

    // Soft diffuse with atmospheric light-wrap (gas giant)
    const diffuse = clamp(NdotL.mul(0.85).add(0.15), 0, 1);

    // Limb darkening
    const viewDir = normalize(sub(cameraPosition, positionWorld));
    const viewDotN = dot(viewDir, N).max(0.05);
    const limbDark = pow(viewDotN, float(0.4));

    // Warm atmospheric haze at limb
    const limb = clamp(float(1.0).sub(viewDotN).mul(2.0), 0, 1);
    const limbPow = pow(limb, float(3.0));
    const dayMask = clamp(NdotL.mul(2.0).add(0.5), 0, 1);
    const haze = vec3(0.7, 0.55, 0.3).mul(limbPow).mul(dayMask).mul(0.08);

    // Limb desaturation
    const col = albedo.mul(diffuse).mul(limbDark).add(haze).toVar();
    const lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    const desatAmount = limbPow.mul(0.2).mul(dayMask);
    col.assign(mix(col, vec3(lum, lum, lum), desatAmount));

    return vec4(col, 1.0);
  })();
}

// ── Custom billboard fragment (gas giant with limb darkening) ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function saturnBillboardFragment({ albedo, uSpR, uSpU, uSpF }: { albedo: THREE.Color; uSpR: any; uSpU: any; uSpF: any }) {
  return Fn(() => {
    const p = uv().mul(2).sub(1);
    const dist = length(p);

    const edge = smoothstep(float(1.0), float(0.92), dist);
    Discard(edge.lessThan(0.01));

    const domeZ = float(1.0).sub(dist.mul(dist)).max(0).sqrt();

    const sunDot = clamp(
      uSpR.mul(p.x).add(uSpU.mul(p.y)).add(uSpF.mul(domeZ)),
      -1, 1,
    );
    // Soft diffuse for gas giant billboard
    const diffuse = clamp(sunDot.mul(0.85).add(0.15), 0, 1);
    // Limb darkening
    const limbDark = pow(domeZ, float(0.4));

    const a = vec3(albedo.r, albedo.g, albedo.b);
    const col = a.mul(diffuse).mul(limbDark);

    return vec4(col, edge);
  })();
}

// ─────────────────────────────────────────────────────────────────────

export const saturnConfig: CelestialBodyConfig = {
  id: "saturn",
  positionKm: SATURN_POSITION_KM,
  radiusKm: SATURN_RADIUS_KM,

  lod: { near: 700_000, far: 16_000_000 },
  near: {
    textures: {
      color: "/textures/saturn/8k_saturn.ktx2",
      ring: "/textures/saturn/8k_saturn_ring_alpha.ktx2",
    },
    segments: 128,
  },
  mid: {
    textures: {
      color: "/textures/saturn/2k_saturn.ktx2",
      ring: "/textures/saturn/2k_saturn_ring_alpha.ktx2",
    },
    segments: 48,
  },
  far: { albedo: SATURN_ALBEDO, buildFragment: saturnBillboardFragment },
  stellarPoint: { geometricAlbedo: 0.499, color: [0.90, 0.82, 0.62] },

  createUniforms: () => ({
    uPlanetRadius: uniform(kmToScaledUnits(SATURN_RADIUS_KM)),
  }),

  extraMeshes: ({ scaledRadius, textures, uSunRel, uniforms, tier }) => {
    const innerRing = kmToScaledUnits(RING_INNER_RADIUS_KM);
    const outerRing = kmToScaledUnits(RING_OUTER_RADIUS_KM);
    const ringGeo = createRingGeometry(innerRing, outerRing, tier === "near" ? 128 : 64);

    const ringMat = new NodeMaterial();
    ringMat.side = THREE.DoubleSide;
    ringMat.transparent = true;
    ringMat.depthWrite = false;
    ringMat.fragmentNode = buildRingFragmentNode(textures.ring, uSunRel, uniforms.uPlanetRadius);

    return [{ key: `ring-${tier}`, geometry: ringGeo, material: ringMat, tier }];
  },

  buildFragmentNode: ({ textures, uSunRel }) =>
    buildSaturnFragmentNode(textures.color, uSunRel),
};
