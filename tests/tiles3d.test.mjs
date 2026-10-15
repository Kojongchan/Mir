import test from 'node:test';
import assert from 'node:assert/strict';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { Vector3 } from 'three';
import { packMeshes, encodeGlb, simplifyGroup, mergeGroups, groupSpatially, boxVolume, triangles, packTerrain, simplifyTerrain,
  encodeTerrainGlb, proxyBoxes, partsOf, weldGroup } from '../scripts/tiles3d.mjs';

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

/** A box mesh with the given centre, axis directions (unit) and half lengths. */
const orientedBox = (c, axes, half) => {
  const world = [];
  for (let k = 0; k < 8; k++) for (let a = 0; a < 3; a++)
    world.push(c[a] + [0, 1, 2].reduce((s, j) => s + ((k >> j) & 1 ? 1 : -1) * half[j] * axes[j][a], 0));
  const tri = [0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3];
  return { world: Float64Array.from(world), tri: Uint32Array.from(tri) };
};

test('far levels keep long thin objects as oriented boxes instead of dropping them', async () => {
  const r = Math.SQRT1_2;
  const meshes = [
    { entity: 0, ...cube(0, 0, 0, 60), rgba: [180, 180, 180, 255], textured: false },                       // survives
    { entity: 1, ...orientedBox([100, 100, 5], [[r, r, 0], [-r, r, 0], [0, 0, 1]], [20, 0.05, 0.05]), rgba: [200, 30, 30, 255], textured: false }, // 40 m rail, diagonal
    { entity: 2, ...cube(200, 0, 0, 1), rgba: [30, 200, 30, 255], textured: false },                       // 1 m part
  ];
  const group = packMeshes(meshes, e => [1, 2, 3][e]).opaque;
  const coarse = await simplifyGroup(group, 4);
  const idsOf = g => new Set(g.ids);
  assert.ok(idsOf(coarse).has(2), 'the rail is still there');
  assert.ok(!idsOf(coarse).has(3), 'the small part is below the error');
  // The rail's box runs along the diagonal: 40 m long, at least 1 m (a quarter of the error) thick.
  const rail = [];
  for (let v = 0; v < coarse.ids.length; v++) if (coarse.ids[v] === 2) rail.push([coarse.pos[v * 3], coarse.pos[v * 3 + 1], coarse.pos[v * 3 + 2]]);
  const along = rail.map(p => (p[0] - 100) * r + (p[1] - 100) * r), across = rail.map(p => -(p[0] - 100) * r + (p[1] - 100) * r);
  assert.ok(Math.abs(Math.max(...along) - Math.min(...along) - 40) < 0.01);
  assert.ok(Math.max(...across) - Math.min(...across) >= 0.99);
  assert.ok(Math.max(...across) - Math.min(...across) < 1.5, 'still thin: not an axis-aligned box of the diagonal');
  // Colour comes along; nothing is proxied when everything survived.
  const v0 = coarse.ids.indexOf(2);
  assert.deepEqual([...coarse.rgba.subarray(v0 * 4, v0 * 4 + 4)], [200, 30, 30, 255]);
  const { part, count } = partsOf(group);
  assert.equal(proxyBoxes(group, part, new Uint8Array(count), 4), null);
});

test('a pole keeps its shape from afar: mast and arm are boxed apart (not one panel), a curved member follows its curve', async () => {
  const z = [0, 0, 1], x = [1, 0, 0], y = [0, 1, 0];
  // One object (dbId 1): a 10 m mast 0.3 m wide and a 3 m arm 0.1 m thick at its top, as separate solids.
  const mast = orientedBox([0, 0, 5], [x, y, z], [0.15, 0.15, 5]), arm = orientedBox([1.5, 0, 9.5], [x, y, z], [1.5, 0.05, 0.05]);
  // Another (dbId 2): a 0.12 m bar along a 50 m radius arc over 60° (one connected solid, 24 segments).
  const ring = [], tri = [];
  for (let k = 0; k <= 24; k++) {
    const t = (k / 24) * (Math.PI / 3), c = [100 + 50 * Math.cos(t), 50 * Math.sin(t)], r = [Math.cos(t), Math.sin(t)];
    for (const [u, w] of [[-0.06, -0.06], [0.06, -0.06], [0.06, 0.06], [-0.06, 0.06]]) ring.push(c[0] + r[0] * u, c[1] + r[1] * u, w);
    if (k) for (let j = 0; j < 4; j++) { const a = (k - 1) * 4 + j, b = (k - 1) * 4 + (j + 1) % 4; tri.push(a, b, b + 4, a, b + 4, a + 4); }
  }
  const meshes = [
    { entity: 0, ...mast, rgba: [220, 220, 220, 255], textured: false },
    { entity: 1, ...arm, rgba: [220, 220, 220, 255], textured: false },
    { entity: 2, world: Float64Array.from(ring), tri: Uint32Array.from(tri), rgba: [90, 90, 90, 255], textured: false },
    { entity: 3, ...cube(300, 0, 0, 40), rgba: [180, 180, 180, 255], textured: false },
  ];
  const group = packMeshes(meshes, e => [1, 1, 2, 3][e]).opaque;
  const coarse = await simplifyGroup(group, 1, { minHeight: 0, lockBorder: true });
  const of = id => { const out = []; for (let v = 0; v < coarse.ids.length; v++) if (coarse.ids[v] === id) out.push([coarse.pos[v * 3], coarse.pos[v * 3 + 1], coarse.pos[v * 3 + 2]]); return out; };
  const pole = of(1);
  assert.ok(pole.length >= 16, 'mast and arm are both there');
  // One box over both would fill the corner below the arm (x 1 … 3 m, z < 8 m): nothing may be there.
  assert.ok(!pole.some(([px, , pz]) => px > 1 && pz < 8), 'no panel between the mast and the arm');
  assert.ok(pole.some(([px, , pz]) => px > 2.9 && pz > 9), 'the arm reaches its end');
  // The bar's boxes stay near the arc (radius 50 ± the error), so it is drawn as a curve, not a 6.7 m wide slab.
  const bar = of(2);
  assert.ok(bar.length >= 16, 'the bar became several boxes');
  for (const [px, py] of bar) assert.ok(Math.abs(Math.hypot(px - 100, py) - 50) < 1, `near the arc: ${px}, ${py}`);
});

/** A cube with its vertices split per face (as the converter writes flat-shaded geometry): 36 vertices. */
const splitCube = (x, y, z, s) => {
  const { world, tri } = cube(x, y, z, s);
  return { world: Float64Array.from([...tri].flatMap(v => [world[v * 3], world[v * 3 + 1], world[v * 3 + 2]])), tri: Uint32Array.from(tri, (_, k) => k) };
};

test('welding joins per-face vertices of one object, never two objects or colours, and simplifies like the original', async () => {
  const meshes = [
    { entity: 0, ...splitCube(0, 0, 0, 2), rgba: [200, 10, 10, 255], textured: false },
    { entity: 1, ...splitCube(0, 0, 0, 2), rgba: [200, 10, 10, 255], textured: false },  // same place, another object
    { entity: 2, ...splitCube(10, 0, 0, 2), rgba: [10, 10, 200, 255], textured: false },
  ];
  const group = packMeshes(meshes, e => e + 1).opaque;
  assert.equal(group.ids.length, 108);
  const welded = weldGroup(group);
  assert.equal(welded.ids.length, 24, '8 corners per cube');
  assert.equal(triangles(welded), 36);
  assert.deepEqual([...new Set(welded.ids)].sort(), [1, 2, 3]);
  for (let v = 0; v < welded.ids.length; v++) assert.equal(welded.rgba[v * 4 + 2], welded.ids[v] === 3 ? 200 : 10);
  // Every welded triangle is one of the original ones (same corners, same winding).
  const key = (g, t) => [0, 1, 2].map(k => [...g.pos.subarray(g.idx[t * 3 + k] * 3, g.idx[t * 3 + k] * 3 + 3)].join(',')).join('|');
  const original = new Set(Array.from({ length: triangles(group) }, (_, t) => key(group, t)));
  for (let t = 0; t < triangles(welded); t++) assert.ok(original.has(key(welded, t)));
  // A finely cut 100 × 4 m plate, vertices split per face: the simplifier cannot join loose faces; welded, it can.
  const plate = { world: [], tri: [] };
  for (let i = 0; i < 50; i++) for (let j = 0; j < 2; j++) {
    const q = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j], [i + 1, j + 1], [i, j + 1]];
    for (const [x, y] of q) { plate.tri.push(plate.world.length / 3); plate.world.push(x * 2, y * 2, 0); }
  }
  const slab = packMeshes([{ entity: 0, world: Float64Array.from(plate.world), tri: Uint32Array.from(plate.tri), rgba: [1, 2, 3, 255], textured: false }], () => 5).opaque;
  const loose = await simplifyGroup(slab, 0.3), coarse = await simplifyGroup(weldGroup(slab), 0.3);
  assert.equal(triangles(loose), triangles(slab));
  assert.ok(triangles(coarse) <= triangles(slab) / 10, `${triangles(coarse)} of ${triangles(slab)}`);
});

test('every tile file name the build writes is one the API signs', async () => {
  const fs = await import('node:fs');
  const signed = new RegExp(/const TILES3D_FILE = \/(.+)\/;/.exec(fs.readFileSync('api/aps-convert.ts', 'utf8'))[1]);
  const names = [...fs.readFileSync('scripts/build-tiles3d.mjs', 'utf8').matchAll(/`(c\/[^`]*\.glb)`/g)]
    .map(m => m[1]).filter(n => n !== 'c/${name}.glb').map(n => n.replace(/\$\{[^}]+\}/g, '17'));
  assert.ok(names.includes('c/m17-17.glb') && names.includes('c/d17.glb'), names.join(' '));
  for (const n of [...names, 'tileset.json', 'objects.bin']) assert.ok(signed.test(n), n);
  for (const n of ['c/../x.glb', 'c/f1.glb?x', 'tileset.json.bak']) assert.ok(!signed.test(n), n);
});

test('finer copies keep long thin faces wider than the error; the coarse rule boxes them', async () => {
  // One object: a 4 m block and a 30 × 0.8 m strip (a parapet or deck edge) on top; at 0.3 m it is not collapsed.
  const strip = { world: Float64Array.from([0, 0, 4.5, 30, 0, 4.5, 30, 0.8, 4.5, 0, 0.8, 4.5]), tri: Uint32Array.from([0, 1, 2, 0, 2, 3]) };
  const group = packMeshes([{ entity: 0, ...cube(0, 0, 0, 4), rgba: [9, 9, 9, 255], textured: false },
    { entity: 0, ...strip, rgba: [9, 9, 9, 255], textured: false }], () => 1).opaque;
  const strip8 = g => { const out = []; for (let v = 0; v < g.ids.length; v++) if (g.pos[v * 3] > 20) out.push(v); return out; };
  // Coarse rule: the strip's faces are flatter than 1:25 and go; the strip comes back as one flat box (no needles).
  const coarse = await simplifyGroup(group, 0.3), box = strip8(coarse);
  assert.equal(box.length, 4, 'four corners of one box at the far end');
  const zs = box.map(v => coarse.pos[v * 3 + 2]);
  assert.ok(Math.max(...zs) - Math.min(...zs) >= 0.07, 'a quarter of the error thick');
  // Finer copies keep the strip's own faces.
  const fine = await simplifyGroup(weldGroup(group), 0.3, { minHeight: 0.03 });
  assert.ok(strip8(fine).length >= 2 && strip8(fine).every(v => fine.pos[v * 3 + 2] === 4.5));
});

test('locked borders keep a seam between two separately tessellated patches closed', async () => {
  // Two patches of one object meet along a wavy seam, each sampled differently there (no shared vertices).
  const seam = y => 0.4 * Math.sin(y * 0.7);
  const patch = (side, n) => {
    const world = [], tri = [];
    for (let j = 0; j <= n; j++) for (let i = 0; i <= 4; i++) {
      const y = 20 * j / n, x0 = seam(y);
      world.push(side < 0 ? x0 - 10 + 10 * i / 4 : x0 + 10 * i / 4, y, 0);
    }
    for (let j = 0; j < n; j++) for (let i = 0; i < 4; i++) { const a = j * 5 + i; tri.push(a, a + 1, a + 6, a, a + 6, a + 5); }
    return { entity: 0, world: Float64Array.from(world), tri: Uint32Array.from(tri), rgba: [0, 128, 0, 255], textured: false };
  };
  const group = weldGroup(packMeshes([patch(-1, 40), patch(1, 27)], () => 1).opaque);
  const seamPoints = [];
  for (let v = 0; v < group.ids.length; v++) {
    const [x, y] = [group.pos[v * 3], group.pos[v * 3 + 1]];
    if (Math.abs(x - seam(y)) < 1e-6) seamPoints.push(`${x.toFixed(4)},${y.toFixed(4)}`);
  }
  const kept = g => new Set(Array.from({ length: g.ids.length }, (_, v) => `${g.pos[v * 3].toFixed(4)},${g.pos[v * 3 + 1].toFixed(4)}`));
  const free = kept(await simplifyGroup(group, 0.3, { minHeight: 0 })), locked = kept(await simplifyGroup(group, 0.3, { minHeight: 0, lockBorder: true }));
  assert.ok(seamPoints.some(p => !free.has(p)), 'free simplification moves the seam (a crack can open)');
  assert.ok(seamPoints.every(p => locked.has(p)), 'locked borders keep every seam point');
});
