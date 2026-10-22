// A stand-in for scripts/svf-precise.mjs in build tests (TILES3D_SVF_MODULE): the model's "SVF" is a JSON file
// (TILES3D_FAKE_SVF) of fragments { dbId, world: [x, y, z…] in SVF world, idx, visible?, transparent? }.
import fs from 'node:fs';
import { indexFragments } from '../../scripts/entity-alias.mjs';

export { fragmentMatcher, refineMeshes } from '../../scripts/svf-precise.mjs';

export async function openSvfSource() {
  const list = JSON.parse(fs.readFileSync(process.env.TILES3D_FAKE_SVF, 'utf8'));
  const bbox = f => {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let k = 0; k < f.world.length; k++) { b[k % 3] = Math.min(b[k % 3], f.world[k]); b[k % 3 + 3] = Math.max(b[k % 3 + 3], f.world[k]); }
    return b;
  };
  return {
    fragments: indexFragments(list.map(f => ({ dbId: f.dbId, bbox: bbox(f) }))),
    visible: f => list[f]?.visible !== false,
    transparent: f => !!list[f]?.transparent,
    downloadedMB: 0,
    async pieces(indices, origin) {
      return new Map(indices.map(f => {
        const s = list[f];
        return [f, s ? { pos: Float64Array.from(s.world, (v, k) => v - origin[k % 3]), idx: Uint32Array.from(s.idx) } : null];
      }));
    },
  };
}
