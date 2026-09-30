// Board-local, volumetric wood: every face samples the same growth-ring field.
// Coordinates are inches along / across / through the board, independent of its
// placement. No image tiling or separate end-grain image can create edge seams.
import * as THREE from 'three';
import { SPECIES } from './woodtex.js';

export const GRAIN_CUTS = { plain: 'Plain sawn', quarter: 'Quarter sawn', rift: 'Rift sawn' };
export function grainSeed(value) {
  return [...String(value)].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 17) >>> 0;
}
export function grainCoordinates(geometry, basis, center, seed = 0, cut = 'plain') {
  const p = geometry.attributes.position, result = new Float32Array(p.count * 3);
  const r = (seed % 997) / 997, s = ((seed >>> 10) % 991) / 991;
  const angle = cut === 'quarter' ? Math.PI / 2 : cut === 'rift' ? Math.PI / 4 : (r - 0.5) * 0.16;
  const c = Math.cos(angle), n = Math.sin(angle);
  for (let i = 0; i < p.count; i++) {
    const v = [p.getX(i) - center[0], p.getY(i) - center[1], p.getZ(i) - center[2]];
    const local = basis.map((axis) => axis.reduce((sum, x, k) => sum + x * v[k], 0));
    result.set([local[0] + s * 140, local[1] * c - local[2] * n + (r - 0.5) * 3,
      local[1] * n + local[2] * c + 3.5 + s * 4], i * 3);
  }
  geometry.setAttribute('woodPosition', new THREE.BufferAttribute(result, 3));
  return geometry;
}
const functions = `
 varying vec3 vWoodPosition;
 uniform vec3 woodEarly;
 uniform vec3 woodLate;
 uniform vec4 woodTraits;
 float woodHash(vec3 p) { return fract(sin(dot(p, vec3(127.1,311.7,74.7))) * 43758.5453); }
 float woodNoise(vec3 p) {
   vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
   return mix(mix(mix(woodHash(i),woodHash(i+vec3(1,0,0)),f.x),
     mix(woodHash(i+vec3(0,1,0)),woodHash(i+vec3(1,1,0)),f.x),f.y),
     mix(mix(woodHash(i+vec3(0,0,1)),woodHash(i+vec3(1,0,1)),f.x),
     mix(woodHash(i+vec3(0,1,1)),woodHash(i+vec3(1,1,1)),f.x),f.y),f.z);
 }
 float woodRing(vec3 p) {
   // Slow longitudinal drift produces cathedrals; radial cuts show straighter grain.
   vec2 heart = vec2(sin(p.x*0.065)*1.3 + sin(p.x*0.017)*0.6, sin(p.x*0.047+1.4)*0.95);
   float radius = length(p.yz + heart);
   return radius * woodTraits.x + 0.28*sin(radius*2.3) + 0.22*sin(radius*4.7) + 0.14*woodNoise(p*vec3(0.12,1.8,1.8));
 }
 vec3 woodColor(vec3 p) {
   float ring = woodRing(p), phase = fract(ring);
   float aa = max(fwidth(ring),0.008);
   float band = smoothstep(0.63-aa,0.78+aa,phase)*(1.0-smoothstep(0.93-aa,1.0+aa,phase));
   band = mix(band,0.24,smoothstep(0.3,0.9,aa));
   float fibre = woodNoise(p*vec3(0.6,22.0,22.0));
   float tone = woodNoise(p*vec3(0.035,0.3,0.3));
   float pore = smoothstep(0.76,0.95,woodNoise(p*vec3(1.5,43.0,43.0)));
   pore *= woodTraits.z * (woodTraits.z > 0.5 ? 1.0-smoothstep(0.2,0.5,phase) : 1.0);
   float ray = smoothstep(0.8,0.94,woodNoise(p*vec3(2.8,0.8,18.0))) * woodTraits.w;
   float t = clamp(band*woodTraits.y + (tone-0.5)*0.32 + (fibre-0.5)*0.13 + pore*0.38,0.0,1.0);
   return mix(woodEarly,woodLate,t)*(0.94+0.12*tone+0.07*ray);
 }
`;
export function attachSolidWood(material, species = 'maple') {
  const sp = SPECIES[species] || SPECIES.maple;
  material.userData.solidWood = species;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.woodEarly = { value: new THREE.Color(sp.early) };
    shader.uniforms.woodLate = { value: new THREE.Color(sp.late) };
    shader.uniforms.woodTraits = { value: new THREE.Vector4(sp.rings * 0.9, Math.min(0.95, sp.contrast * 1.1), sp.pores === 'ring' ? 0.8 : sp.pores === 'diffuse' ? 0.3 : 0.1, sp.rays ? 1 : 0) };
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 woodPosition; varying vec3 vWoodPosition;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWoodPosition = woodPosition;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + functions)
      .replace('#include <map_fragment>', 'diffuseColor.rgb *= woodColor(vWoodPosition);')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor + 0.08*(woodNoise(vWoodPosition*vec3(0.7,20.0,20.0))-0.5),0.25,0.9);')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        // Microscopic longitudinal pores, in real board units, not deep grooves.
        float woodHeight = 0.004 * woodTraits.z * woodNoise(vWoodPosition*vec3(0.7,24.0,24.0));
        vec3 woodDx = dFdx(-vViewPosition), woodDy = dFdy(-vViewPosition);
        vec3 woodR1 = cross(woodDy,normal), woodR2 = cross(normal,woodDx);
        float woodDet = dot(woodDx,woodR1);
        vec3 woodGradient = sign(woodDet)*(dFdx(woodHeight)*woodR1+dFdy(woodHeight)*woodR2);
        normal = normalize(max(abs(woodDet),0.0000001)*normal-woodGradient);
      `);
  };
  material.customProgramCacheKey = () => `solid-wood-v1:${species}`;
  return material;
}
export function solidWoodMaterial(species = 'maple') {
  return attachSolidWood(new THREE.MeshStandardMaterial({ roughness: SPECIES[species]?.rough ?? 0.55, metalness: 0, envMapIntensity: 0.3 }), species);
}
export function copySolidWood(original, clone) {
  return original.userData.solidWood ? attachSolidWood(clone, original.userData.solidWood) : clone;
}
