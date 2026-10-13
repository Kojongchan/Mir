import test from 'node:test';
import assert from 'node:assert/strict';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { Vector3 } from 'three';
import { packMeshes, encodeGlb, simplifyGroup, mergeGroups, groupSpatially, boxVolume, triangles, packTerrain, simplifyTerrain,
  encodeTerrainGlb } from '../scripts/tiles3d.mjs';

const cube = (x, y, z, s) => {
  const world = Float64Array.from([[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]].flatMap(([a, b, c]) => [x + a * s, y + b * s, z + c * s]));
  const tri = Uint32Array.from([0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7]);
  return { world, tri };
};

async function parse(glb) {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const ab = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
  return new Promise((resolve, reject) => loader.parse(ab, '', resolve, reject));
}

test('a tile round-trips through three.js: positions (Z-up → Y-up), colours, dbIds, transparency', async () => {
  // Survey-like coordinates (metres from the converter origin), one opaque and one transparent object.
  const meshes = [
    { entity: 0, ...cube(1000, 2000, 30, 2), rgba: [200, 10, 10, 255], textured: false },
    { entity: 1, ...cube(1005, 2003, 31, 1), rgba: [10, 10, 200, 128], textured: false },
  ];
  const groups = packMeshes(meshes, e => [4242, 77][e]);
  const out = await encodeGlb(groups);
  assert.equal(out.triangles, 24);
  const gltf = await parse(out.glb);
  gltf.scene.updateMatrixWorld(true);
  const found = [];
  gltf.scene.traverse(o => { if (o.isMesh) found.push(o); });
  assert.equal(found.length, 2);
  for (const mesh of found) {
    const g = mesh.geometry, ids = g.getAttribute('_feature_id_0'), col = g.getAttribute('color'), pos = g.getAttribute('position');
    assert.ok(ids && col && pos && g.index, 'attributes present');
    const id = ids.getX(0);
    const expected = id === 4242 ? meshes[0] : meshes[1];
    assert.ok([4242, 77].includes(id));
    for (let i = 0; i < ids.count; i++) assert.equal(ids.getX(i), id);
    assert.equal(mesh.material.transparent, id === 77);
    // Every decoded vertex maps back to a source vertex (x, z, −y) within the int16 step.
    const src = [];
    for (let i = 0; i < expected.world.length; i += 3) src.push([expected.world[i], expected.world[i + 2], -expected.world[i + 1]]);
    const v = new Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      const d = Math.min(...src.map(s => Math.hypot(s[0] - v.x, s[1] - v.y, s[2] - v.z)));
      assert.ok(d < 0.01, `vertex ${i} off by ${d}`);
    }
    assert.ok(Math.abs(col.getX(0) - expected.rgba[0] / 255) < 0.01);
  }
});

test('coarser levels prune parts below the error and keep dbIds; tree nodes have at most 8 children', async () => {
  const meshes = [{ entity: 0, ...cube(0, 0, 0, 20), rgba: [1, 2, 3, 255], textured: false },
    { entity: 1, ...cube(50, 0, 0, 0.2), rgba: [1, 2, 3, 255], textured: false }];
  const { opaque } = packMeshes(meshes, e => e + 1);
  const coarse = await simplifyGroup(opaque, 1);
  assert.ok(triangles(coarse) <= 12 && triangles(coarse) > 0);
  assert.deepEqual([...new Set(coarse.ids)], [1]);           // the 0.2 m cube is pruned
  assert.equal(triangles(mergeGroups([opaque, opaque])), 48);
  const items = Array.from({ length: 70 }, (_, k) => ({ key: k, centre: [k * 10, (k % 7) * 5, 0] }));
  const tree = groupSpatially(items);
  const walk = n => { if (!n.children) return 1; assert.ok(n.children.length <= 8); return n.children.reduce((s, c) => s + walk(c), 0); };
  assert.equal(walk(tree), 70);
  assert.deepEqual(boxVolume([0, 0, 0, 2, 4, 6]).box, [1, 2, 3, 1, 0, 0, 0, 2, 0, 0, 0, 3]);
});

/** A flat terrain patch: n×n quads over [x0, x0+size]², uv = planar photo mapping. */
const patch = (x0, y0, size, n, texture, entity) => {
  const world = [], uv = [], tri = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const x = x0 + size * i / n, y = y0 + size * j / n;
    world.push(x, y, 50); uv.push((x % 1000) / 1000, (y % 1000) / 1000);
  }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * (n + 1) + i;
    tri.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1);
  }
  return { entity, world: Float64Array.from(world), tri: Uint32Array.from(tri), uv: Float32Array.from(uv), texture, rgba: [255, 255, 255, 255], textured: true };
};
const fakeKtx2 = () => Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

test('terrain: patches of one photo are welded into one part, other photos stay apart', () => {
  // Two neighbouring patches on photo 0 share an edge; one patch on photo 1; an untextured mesh is ignored.
  const parts = packTerrain([patch(0, 0, 100, 4, 0, 0), patch(100, 0, 100, 4, 0, 1), patch(0, 100, 100, 4, 1, 2), { ...cube(0, 0, 0, 1), uv: null, texture: -1 }]);
  assert.deepEqual([...parts.keys()].sort(), [0, 1]);
  const p0 = parts.get(0);
  assert.equal(p0.idx.length / 3, 2 * 32);
  assert.equal(p0.pos.length / 3, 2 * 25 - 5, 'the shared edge (5 vertices) is welded');
  assert.equal(p0.uv.length / 2, p0.pos.length / 3);
});

test('terrain: simplification keeps photo borders; the glb embeds each photo once as KTX2', async () => {
  const parts = [...packTerrain([patch(0, 0, 200, 16, 0, 0), patch(200, 0, 200, 16, 1, 1)]).values()];
  const coarse = await Promise.all(parts.map(p => simplifyTerrain(p, 1)));
  for (const [k, c] of coarse.entries()) {
    assert.ok(c.idx.length < parts[k].idx.length, 'a flat patch simplifies');
    // Border vertices (x = 200 for both photos) survive, so the two photos still meet.
    const border = p => { const xs = new Set(); for (let v = 0; v < p.pos.length / 3; v++) if (p.pos[v * 3] === 200) xs.add(p.pos[v * 3 + 1]); return xs.size; };
    assert.equal(border(c), border(parts[k]));
  }
  const out = await encodeTerrainGlb(coarse, [fakeKtx2(), fakeKtx2()]);
  const json = JSON.parse(out.glb.subarray(20, 20 + out.glb.readUInt32LE(12)).toString());
  assert.equal(json.meshes[0].primitives.length, 2);
  assert.ok(json.extensionsRequired.includes('KHR_texture_basisu'));
  assert.deepEqual(json.images.map(i => i.mimeType), ['image/ktx2', 'image/ktx2']);
  assert.deepEqual(json.textures.map(t => t.extensions.KHR_texture_basisu.source), [0, 1]);
  for (const p of json.meshes[0].primitives) assert.deepEqual(Object.keys(p.attributes).sort(), ['NORMAL', 'POSITION', 'TEXCOORD_0']);
  assert.equal(out.textureBytes, 32);
  // Photos missing (not KTX2) are left out rather than drawn untextured.
  assert.equal((await encodeTerrainGlb(coarse, [null, null])), null);
});
