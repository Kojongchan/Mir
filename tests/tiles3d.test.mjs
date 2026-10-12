import test from 'node:test';
import assert from 'node:assert/strict';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { Vector3 } from 'three';
import { packMeshes, encodeGlb, simplifyGroup, mergeGroups, groupSpatially, boxVolume, triangles } from '../scripts/tiles3d.mjs';

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
