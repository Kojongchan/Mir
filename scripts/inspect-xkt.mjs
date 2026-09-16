/** Local-only audit of uncompressed XKT v12, non-reused triangle geometry.
 * Deliberately rejects other layouts instead of reporting misleading geometry counts.
 * Usage: node scripts/inspect-xkt.mjs path/to/chunk.xkt [...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export function inspectXkt(input) {
  const b = Buffer.from(input);
  if (b.length < 236 || b.readUInt32LE(0) !== 12) throw new Error('Only uncompressed XKT v12 is supported');
  const read = (slot, Type) => {
    const offset = b.readUInt32LE(4 + slot * 8), length = b.readUInt32LE(8 + slot * 8);
    if (offset < 236 || offset + length > b.length || length % Type.BYTES_PER_ELEMENT) throw new Error('Invalid XKT table bounds');
    return new Type(Uint8Array.from(b.subarray(offset, offset + length)).buffer);
  };
  const pos = read(4, Uint16Array), indices = read(8, Uint32Array), primitives = read(13, Uint8Array);
  const pp = read(15, Uint32Array), ip = read(19, Uint32Array), meshGeo = read(21, Uint32Array);
  const entityMesh = read(26, Uint32Array), boxes = read(27, Float64Array), tileEntities = read(28, Uint32Array);
  const ids = JSON.parse(new TextDecoder().decode(read(25, Uint8Array)));
  if (pos.length % 3 || boxes.length !== tileEntities.length * 6 || entityMesh.length !== ids.length || pp.length !== ip.length || pp.length !== primitives.length) throw new Error('Inconsistent XKT tables');
  if (new Set(meshGeo).size !== meshGeo.length) throw new Error('Reused geometry requires matrix-aware inspection; unsupported');
  const spans = [], objectDiagonals = [], counts = [];
  let triangles = 0;
  for (let t = 0; t < tileEntities.length; t++) {
    const min = Array.from(boxes.slice(t * 6, t * 6 + 3));
    const size = min.map((v, i) => boxes[t * 6 + 3 + i] - v);
    if (![...min, ...size].every(Number.isFinite) || size.some(v => v < 0)) throw new Error('Invalid tile AABB');
    const endEntity = tileEntities[t + 1] ?? entityMesh.length;
    for (let e = tileEntities[t]; e < endEntity; e++) {
      const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
      const endMesh = entityMesh[e + 1] ?? meshGeo.length;
      for (let m = entityMesh[e]; m < endMesh; m++) {
        const g = meshGeo[m];
        if (g >= pp.length || ![0, 1].includes(primitives[g])) throw new Error('Unsupported or missing geometry');
        const start = pp[g], end = pp[g + 1] ?? pos.length;
        const first = ip[g], last = ip[g + 1] ?? indices.length;
        if (end < start || end > pos.length || (end-start)%3 || last < first || last > indices.length || (last-first)%3) throw new Error('Invalid geometry range');
        const nv = (end-start)/3;
        for (let i = first; i < last; i++) if (indices[i] >= nv) throw new Error('Triangle index outside geometry vertices');
        const lo = [Infinity,Infinity,Infinity], hi = [-Infinity,-Infinity,-Infinity];
        for (let i = start; i < end; i += 3) for (let a=0;a<3;a++) {
          const v=min[a]+pos[i+a]/65535*size[a];lo[a]=Math.min(lo[a],v);hi[a]=Math.max(hi[a],v);
        }
        for (let a=0;a<3;a++) {low[a]=Math.min(low[a],lo[a]);high[a]=Math.max(high[a],hi[a]);}
        spans.push(Math.hypot(...lo.map((v,a)=>hi[a]-v)));
        const count=(last-first)/3;counts.push(count);triangles+=count;
      }
      objectDiagonals.push(Math.hypot(...low.map((v,a)=>high[a]-v)));
    }
  }
  const range = values => { const a=[...values].sort((x,y)=>x-y); return a.length ? { min:a[0], median:a[Math.floor(a.length/2)], max:a[a.length-1] } : null; };
  return { byteLength:b.length, version:12, entities:ids.length, meshes:meshGeo.length, triangles,
    objectDiagonal:range(objectDiagonals), meshDiagonal:range(spans), trianglesPerMesh:range(counts),
    note:'Distances use file coordinate units. No source-model completeness or GPU-performance claim.' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv.slice(2).length) { console.error('Usage: node scripts/inspect-xkt.mjs file.xkt [...]'); process.exitCode=1; }
  for (const file of process.argv.slice(2)) {
    try { console.log(JSON.stringify({file:path.basename(file),...inspectXkt(fs.readFileSync(file))},null,2)); }
    catch(error) {console.error(`${path.basename(file)}: ${error.message}`);process.exitCode=1;}
  }
}
