// Exact object geometry from the model's SVF for the original (detail) level of the 3D Tiles — trial "B" of the third
// viewer (3D뷰 신규 테스트 3차). The XKT files the tiles are built from keep positions on a 16-bit grid per internal
// tile box, and long objects land in boxes kilometres wide: the U-channel the user compared with Navisworks (하선
// U형_구체콘크리트, dbId 1011) sits on a 2 cm grid, long existing-line layers on 14–20 cm. Every vertex is off by up to
// half a grid step: facets of long thin triangles tilt (shading streaks), surfaces meeting at shallow angles cross
// tens of centimetres away (zigzag edges, white gaps). The SVF keeps each fragment's translation in float64 and its
// mesh in float32 a few metres around it — exact to well under a millimetre (dbId 1011: tile vertices 9.9 mm median,
// 17.6 mm at most from the SVF's).
//
// Each XKT entity is one SVF fragment (the converter writes one glTF node per fragment): its candidates are found by
// box (as the renamed-fragment table does, scripts/entity-alias.mjs) and the one whose vertices it shares replaces its
// triangles and names its owner (correcting the table's box-only guesses). Entities with no fitting fragment stay as
// decoded. Pure parts are tested in tests/svf-precise.test.mjs; openSvfSource reads an existing SVF derivative
// (read-only, no new APS job).
import fs from 'node:fs';
import path from 'node:path';
import { indexFragments, tolerance } from './entity-alias.mjs';

/** Column-major 4×4 world matrix (float64) of an SVF fragment transform ({t} | {q, t, s} | {matrix, t}). */
export function fragmentMatrix(tf) {
  const t = tf?.t ?? { x: 0, y: 0, z: 0 };
  if (tf?.matrix) {
    const m = tf.matrix;
    return [m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, t.x, t.y, t.z, 1];
  }
  const { x, y, z, w } = tf?.q ?? { x: 0, y: 0, z: 0, w: 1 }, s = tf?.s ?? { x: 1, y: 1, z: 1 };
  const r = [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y),
    2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x),
    2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
  return [r[0] * s.x, r[1] * s.x, r[2] * s.x, 0, r[3] * s.y, r[4] * s.y, r[5] * s.y, 0, r[6] * s.z, r[7] * s.z, r[8] * s.z, 0, t.x, t.y, t.z, 1];
}

/** A fragment's mesh in the tiles' frame (SVF world − origin), float64 positions. */
export function placeMesh(vertices, indices, matrix, origin) {
  const n = vertices.length / 3, pos = new Float64Array(n * 3), m = matrix;
  for (let i = 0; i < n; i++) {
    const x = vertices[i * 3], y = vertices[i * 3 + 1], z = vertices[i * 3 + 2];
    pos[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12] - origin[0];
    pos[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13] - origin[1];
    pos[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14] - origin[2];
  }
  return { pos, idx: Uint32Array.from(indices) };
}

const CELL = 1; // metres: candidate fragments by the box's minimum corner
const CENTRE_CELL = 4; // metres: second pass by centre
const cellKey = (x, y, z) => `${x},${y},${z}`;

/**
 * Candidate source fragments of tile entities. `fragments`: indexFragments() of the SVF fragment list (world boxes);
 * the tiles' frame is SVF world − `origin`. `candidates(file, dbIds)` → per entity, fragment indices, best box first: `file` = xktEntityBoxes(xkt) ({ ids, boxes, steps }), `dbIds[e]` the entity's object from the tile (named
 * entities) or the renamed-fragment table (`entity-N`, 0 = unknown); up to 12 per entity. A named entity's candidates are its own object's
 * fragments; a renamed entity's are those of every object named in the file, since the table guessed the owner by box
 * alone and pieces of one family share boxes (WPC girder 7915's piece was given to @콘크리트 8867: selecting the girder
 * left that piece white). Boxes within the file's quantization tolerance, then boxes that contain the entity with
 * nearly the same centre (the box of rotated geometry is the box of its rotated local box). The geometry decides
 * between them (refineMeshes).
 */
export function fragmentMatcher(fragments, origin) {
  const fb = fragments.boxes, count = fragments.db.length;
  const shifted = (f, a) => fb[f * 6 + a] - origin[a % 3];
  const minGrid = new Map(), centreGrid = new Map();
  const add = (grid, key, f) => { const cell = grid.get(key); if (cell) cell.push(f); else grid.set(key, [f]); };
  for (let f = 0; f < count; f++) {
    if (Number.isNaN(fb[f * 6])) continue;
    add(minGrid, cellKey(...[0, 1, 2].map(a => Math.floor(shifted(f, a) / CELL))), f);
    add(centreGrid, cellKey(...[0, 1, 2].map(a => Math.floor((shifted(f, a) + shifted(f, a + 3)) / 2 / CENTRE_CELL))), f);
  }
  const near = (grid, base, visit) => {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++)
      for (const f of grid.get(cellKey(base[0] + dx, base[1] + dy, base[2] + dz)) ?? []) visit(f);
  };
  const NAMED = /^\d+$/;
  return function candidates({ ids, boxes, steps }, dbIds) {
    const named = new Set();
    ids.forEach(id => { if (NAMED.test(id)) named.add(Number(id)); });
    return ids.map((id, e) => {
      if (Number.isNaN(boxes[e * 6])) return [];
      const own = NAMED.test(id);
      const ok = f => (own ? fragments.db[f] === Number(id) : named.has(fragments.db[f]) || (dbIds[e] > 0 && fragments.db[f] === dbIds[e]));
      const found = new Map(); // fragment → rank (box fit ≤ 1, then 1 + centre offset)
      near(minGrid, [0, 1, 2].map(a => Math.floor(boxes[e * 6 + a] / CELL)), f => {
        if (!ok(f)) return;
        let worst = 0;
        for (let a = 0; a < 6; a++) worst = Math.max(worst, Math.abs(boxes[e * 6 + a] - shifted(f, a)) / tolerance(steps[e * 3 + a % 3], fb[f * 6 + a]));
        if (worst <= 1) found.set(f, worst);
      });
      const c = [0, 1, 2].map(a => (boxes[e * 6 + a] + boxes[e * 6 + a + 3]) / 2);
      near(centreGrid, c.map(v => Math.floor(v / CENTRE_CELL)), f => {
        if (found.has(f) || !ok(f)) return;
        let diag = 0;
        for (let a = 0; a < 3; a++) {
          const tol = tolerance(steps[e * 3 + a], fb[f * 6 + a]);
          if (boxes[e * 6 + a] < shifted(f, a) - tol || boxes[e * 6 + a + 3] > shifted(f, a + 3) + tol) return;
          diag += (fb[f * 6 + a + 3] - fb[f * 6 + a]) ** 2;
        }
        // Ranked by centre offset over the box diagonal: a rotated piece's source box can be much larger than the piece
        // (WPC girder fragment 21442: 12.6 × 13.4 m box, 9 × 10 m piece, centres 2.1 m apart); the vertices decide.
        const off = Math.hypot(...[0, 1, 2].map(a => c[a] - (shifted(f, a) + shifted(f, a + 3)) / 2));
        found.set(f, 1 + off / Math.max(0.1, Math.sqrt(diag)));
      });
      return [...found].sort((a, b) => a[1] - b[1]).slice(0, 12).map(([f]) => f);
    });
  };
}

/** Spatial hash of points (cell = `cell` metres): distance to the nearest one, or Infinity beyond one cell. */
function vertexHash(pos, cell) {
  const map = new Map();
  for (let v = 0; v < pos.length / 3; v++) {
    const k = cellKey(Math.floor(pos[v * 3] / cell), Math.floor(pos[v * 3 + 1] / cell), Math.floor(pos[v * 3 + 2] / cell));
    const bucket = map.get(k);
    if (bucket) bucket.push(v); else map.set(k, [v]);
  }
  return (x, y, z) => {
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    let best = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++)
      for (const v of map.get(cellKey(cx + dx, cy + dy, cz + dz)) ?? []) best = Math.min(best, Math.hypot(pos[v * 3] - x, pos[v * 3 + 1] - y, pos[v * 3 + 2] - z));
    return best;
  };
}

/** Up to `n` evenly spread points of a flat position array, as [x, y, z]. */
function spread(pos, n) {
  const count = pos.length / 3, every = Math.max(1, Math.floor(count / n)), out = [];
  for (let v = 0; v < count && out.length < n; v += every) out.push([pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]);
  return out;
}

/**
 * Decoded meshes of one tile file (decodeXkt) with each entity's meshes replaced by its source fragment's exact
 * triangles (one mesh with the colour of the entity's largest mesh), and the fragment's object as the entity's owner.
 * `candidates[e]` from fragmentMatcher, `steps` from xktEntityBoxes, `pieceOf(f)` → { pos, idx } in the tiles' frame
 * (null: lines, points, missing). A candidate fits when at least `agree` of (up to 64 of) the entity's decoded vertices
 * have a fragment vertex within two quantization steps + 2 cm; among fitting ones the best share of the fragment's
 * vertices found on the entity wins (a piece whose corners are a subset of another's), each fragment once per file,
 * best pairs first. Returns { meshes, owner (fragment per entity, −1 = kept as decoded), stats }.
 */
export function refineMeshes(meshes, candidates, steps, pieceOf, { agree = 0.9, samples = 64 } = {}) {
  const stats = { entities: 0, matched: 0, replaced: 0, rejected: 0, noCandidate: 0, noMesh: 0, trianglesBefore: 0, trianglesAfter: 0, shiftMm: [] };
  const byEntity = new Map();
  for (const m of meshes) {
    const list = byEntity.get(m.entity);
    if (list) list.push(m); else byEntity.set(m.entity, [m]);
    stats.trianglesBefore += m.tri.length / 3;
  }
  const pairs = []; // { e, f, score, shift }
  for (const [e, list] of byEntity) {
    stats.entities++;
    const cands = candidates[e] ?? [];
    if (!cands.length) { stats.noCandidate++; continue; }
    stats.matched++;
    const step = Math.max(steps[e * 3], steps[e * 3 + 1], steps[e * 3 + 2]), tol = 0.02 + 2 * step;
    const world = new Float64Array(list.reduce((n, m) => n + m.world.length, 0));
    let o = 0;
    for (const m of list) { world.set(m.world, o); o += m.world.length; }
    const mine = spread(world, samples), onEntity = vertexHash(world, tol);
    let usable = 0;
    for (const f of cands) {
      const piece = pieceOf(f);
      if (!piece || !piece.idx.length) continue;
      usable++;
      const onPiece = vertexHash(piece.pos, tol), shifts = [];
      let hits = 0;
      for (const [x, y, z] of mine) { const d = onPiece(x, y, z); if (d <= tol) { hits++; shifts.push(d); } }
      if (hits < agree * mine.length) continue;
      const theirs = spread(piece.pos, samples);
      const back = theirs.filter(([x, y, z]) => onEntity(x, y, z) <= tol).length / theirs.length;
      shifts.sort((a, b) => a - b);
      pairs.push({ e, f, score: hits / mine.length + back, shift: shifts[shifts.length >> 1] });
    }
    if (!usable) stats.noMesh++;
  }
  pairs.sort((a, b) => b.score - a.score);
  const owner = new Int32Array(candidates.length).fill(-1), taken = new Set();
  for (const p of pairs) {
    if (owner[p.e] >= 0 || taken.has(p.f)) continue;
    owner[p.e] = p.f; taken.add(p.f);
    stats.replaced++; stats.shiftMm.push(Math.round(p.shift * 1000));
  }
  const out = [];
  for (const [e, list] of byEntity) {
    if (owner[e] < 0) { if ((candidates[e] ?? []).length) stats.rejected++; out.push(...list); continue; }
    const piece = pieceOf(owner[e]), main = list.reduce((a, b) => (b.tri.length > a.tri.length ? b : a));
    out.push({ ...main, world: piece.pos, tri: piece.idx });
  }
  for (const m of out) stats.trianglesAfter += m.tri.length / 3;
  return { meshes: out, owner, stats };
}

/**
 * Reader of an existing SVF derivative: the fragment list and geometry metadata up front (≈33 MB for 490 k
 * fragments), each mesh pack (≈1 MB) when a fragment in it is asked for. Downloads go to `dir`.
 * `getToken()` → APS token with viewables:read; `log` for progress; `modules` ({ svfUtils, AdmZip }) when the packages
 * are not resolvable from this file.
 */
export async function openSvfSource({ urn, getToken, region = 'US', dir, log = () => {}, modules = {} }) {
  const svfUtils = modules.svfUtils ?? (await import('svf-utils')).default;
  const AdmZip = modules.AdmZip ?? (await import('adm-zip')).default;
  const API = 'https://developer.api.autodesk.com';
  const headers = async () => ({ authorization: `Bearer ${await getToken()}`, ...(region && region !== 'US' ? { region } : {}) });
  const mr = await fetch(`${API}/modelderivative/v2/designdata/${encodeURIComponent(urn)}/manifest`, { headers: await headers() });
  if (!mr.ok) throw new Error(`manifest ${mr.status}`);
  let svf = null; // the first SVF graphics resource, as the converter and the index jobs pick it
  const walk = d => { if (!svf && d.type === 'resource' && d.role === 'graphics' && d.mime === 'application/autodesk-svf') svf = d; d.children?.forEach(walk); };
  (await mr.json()).derivatives?.forEach(d => d.children?.forEach(walk));
  if (!svf?.urn) throw new Error('No SVF derivative');
  const base = svf.urn.slice(0, svf.urn.lastIndexOf('/') + 1), name = svf.urn.slice(svf.urn.lastIndexOf('/') + 1);
  fs.mkdirSync(dir, { recursive: true });
  let bytes = 0;
  const pending = new Map();
  const get = rel => {
    if (!pending.has(rel)) pending.set(rel, (async () => {
      const file = path.join(dir, rel);
      if (fs.existsSync(file)) return file;
      for (let attempt = 1; ; attempt++) {
        try {
          const r = await fetch(`${API}/derivativeservice/v2/derivatives/${encodeURIComponent(path.posix.normalize(base + rel))}`, { headers: await headers() });
          if (!r.ok) throw new Error(`${rel}: HTTP ${r.status}`);
          const b = Buffer.from(await r.arrayBuffer());
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, b);
          bytes += b.length;
          return file;
        } catch (e) {
          if (attempt >= 5) throw e;
          await new Promise(res => setTimeout(res, 5000 * 2 ** (attempt - 1))); // network blips: up to 75 s in all
        }
      }
    })());
    return pending.get(rel);
  };
  const svfFile = await get(name);
  const assets = JSON.parse(new AdmZip(svfFile).readAsText('manifest.json')).assets ?? [];
  const uriOf = type => assets.find(a => a.type === type)?.URI;
  await Promise.all(['Autodesk.CloudPlatform.FragmentList', 'Autodesk.CloudPlatform.GeometryMetadataList'].map(t => get(uriOf(t))));
  const reader = await svfUtils.SVFReader.FromFileSystem(svfFile);
  const list = await reader.readFragments(), geometries = await reader.readGeometries();
  const packUri = new Map();
  for (const a of assets) { const m = /(?:^|\/)(\d+)\.pf$/.exec(a.URI ?? ''); if (a.type === 'Autodesk.CloudPlatform.PackFile' && m) packUri.set(Number(m[1]), a.URI); }
  log(`SVF: ${list.length} fragments, ${geometries.length} geometries, ${packUri.size} mesh packs`);
  // Parsed packs, most recent last (a pack holds ≈ 60 meshes; the fragments of one tile share packs).
  const packs = new Map(), PACKS_KEPT = 96;
  const packOf = id => {
    let p = packs.get(id);
    if (p) { packs.delete(id); packs.set(id, p); return p; }
    p = (async () => { await get(packUri.get(id)); return reader.readMeshPack(id); })();
    packs.set(id, p);
    while (packs.size > PACKS_KEPT) packs.delete(packs.keys().next().value);
    return p;
  };
  return {
    fragments: indexFragments(list.map(f => ({ dbId: f.dbID, bbox: f.bbox }))),
    /** Drawn by the source viewers (hidden fragments are not). */
    visible: f => !!list[f]?.visible,
    get downloadedMB() { return Math.round(bytes / 1048576); },
    /** Exact triangles of these fragments in the tiles' frame: Map fragment → { pos, idx } | null (lines, points). */
    async pieces(indices, origin) {
      const out = new Map();
      // Grouped by pack so each pack is parsed once per call.
      const byPack = new Map();
      for (const f of indices) {
        const g = geometries[list[f]?.geometryID];
        if (!g || !packUri.has(g.packID)) { out.set(f, null); continue; }
        const l = byPack.get(g.packID);
        if (l) l.push(f); else byPack.set(g.packID, [f]);
      }
      const ids = [...byPack.keys()];
      await Promise.all(Array.from({ length: 8 }, async (_, w) => { for (let k = w; k < ids.length; k += 8) await get(packUri.get(ids[k])); }));
      for (const [pack, wanted] of byPack) {
        const meshes = await packOf(pack);
        for (const f of wanted) {
          const mesh = meshes[geometries[list[f].geometryID].entityID];
          out.set(f, mesh && mesh.indices && mesh.vertices && !mesh.isLines && !mesh.isPoints
            ? placeMesh(mesh.vertices, mesh.indices, fragmentMatrix(list[f].transform), origin) : null);
        }
      }
      return out;
    },
  };
}
