// Parts of a staged tileset build (scripts/build-tiles3d.mjs, decision D27): which tiles each parallel job builds, and
// the tile records — everything the parents' job takes from one built tile, kept between builds by the tile's
// fingerprint so an unchanged tile is not built again.
import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { groupSpatially } from './tiles3d.mjs';

/**
 * Tiles ({ key, centre, cost? }) for `parts` jobs: runs of `chunk` neighbouring tiles (the leaf order of groupSpatially),
 * each run to the part with the least cost so far, costliest run first, and within a part its costliest runs first
 * (a part builds 4 tiles at a time: a heavy tile last holds the part up). A dense stretch took 65 of the 222 minutes of
 * run 223; the parts of run 224 took 16 to 42 minutes, 27 on average, and in run 226 two parts spent their last 50
 * tiles on the junction's skins. Without costs every tile counts 1: the runs are dealt round, in site order.
 */
export function partition(items, parts, chunk = 16) {
  if (parts <= 1) return [items.map(it => it.key)];
  const order = [], cost = new Map(items.map(it => [it.key, it.cost ?? 1]));
  const visit = node => { if (Array.isArray(node.children)) node.children.forEach(visit); else order.push(node.key); };
  visit(groupSpatially(items, 8));
  const runs = [];
  for (let c = 0; c * chunk < order.length; c++) {
    const keys = order.slice(c * chunk, (c + 1) * chunk);
    runs.push({ c, keys, cost: keys.reduce((n, k) => n + cost.get(k), 0) });
  }
  runs.sort((a, b) => b.cost - a.cost || a.c - b.c);
  const out = Array.from({ length: parts }, () => ({ cost: 0, runs: [] }));
  for (const run of runs) {
    const part = out.reduce((best, p) => (p.cost < best.cost ? p : best));
    part.runs.push(run); part.cost += run.cost;
  }
  return out.map(p => p.runs.sort((a, b) => b.cost - a.cost || a.c - b.c).flatMap(r => r.keys));
}

const TYPES = { Float64Array, Float32Array, Uint32Array, Uint16Array, Uint8Array, Int32Array };
const MAGIC = Buffer.from('MRC1');

// A record leaves the job (artifacts, Actions cache) and holds model geometry: with a key it is sealed, head and body
// apart (AES-256-GCM, each bound to the file's name and part), so the plan reads every head without the bodies.
function seal(bytes, key, label) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(label));
  const out = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), out]);
}
function unseal(bytes, key, label) {
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(label));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
}

/**
 * Write a record: `meta` (JSON) and `sections` ({ name: { field: typed array, … } | null }) as ['MRC1', sealed u8,
 * [head bytes u32, head], [body bytes u32, body]] — head: { meta, sections: the arrays' names, types and lengths },
 * body: the arrays; each sealed when `key` (32 bytes) is given. Written beside and renamed into place, so a record is
 * whole or absent.
 */
export function writeRecord(file, meta, sections = {}, key = null) {
  const head = { meta, sections: {} }, arrays = [];
  for (const [name, fields] of Object.entries(sections)) {
    if (!fields) continue;
    head.sections[name] = [];
    for (const [field, a] of Object.entries(fields)) {
      if (!ArrayBuffer.isView(a) || !TYPES[a.constructor.name]) continue;
      head.sections[name].push([field, a.constructor.name, a.length]);
      arrays.push(Buffer.from(a.buffer, a.byteOffset, a.byteLength));
    }
  }
  const name = path.basename(file);
  let headBytes = Buffer.from(JSON.stringify(head)), body = Buffer.concat(arrays);
  if (key) { headBytes = seal(headBytes, key, `${name}:head`); body = seal(body, key, `${name}:body`); }
  const size = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const part = `${file}.${process.pid}.part`;
  fs.writeFileSync(part, Buffer.concat([MAGIC, Buffer.from([key ? 1 : 0]), size(headBytes.length), headBytes, size(body.length), body]));
  fs.renameSync(part, file);
}

/**
 * A record written by writeRecord: { meta, sections: { name: { field: typed array } } }; `metaOnly`: just its meta. A
 * sealed record needs its `key`; with a key, an unsealed one is refused (every record of a keyed build is sealed).
 */
export function readRecord(file, { metaOnly = false, key = null } = {}) {
  const name = path.basename(file), corrupt = () => new Error(`Corrupt record ${name}`);
  const fd = fs.openSync(file, 'r');
  let headBytes, sealed, bodyAt, size;
  try {
    const start = Buffer.alloc(9);
    if (fs.readSync(fd, start, 0, 9, 0) !== 9 || !start.subarray(0, 4).equals(MAGIC)) throw corrupt();
    sealed = start[4] === 1;
    if (sealed !== !!key) throw new Error(sealed ? `Record ${name} is sealed: no key` : `Record ${name} is not sealed`);
    headBytes = Buffer.alloc(start.readUInt32LE(5));
    if (fs.readSync(fd, headBytes, 0, headBytes.length, 9) !== headBytes.length) throw corrupt();
    bodyAt = 9 + headBytes.length;
    size = fs.fstatSync(fd).size;
  } finally { fs.closeSync(fd); }
  const head = JSON.parse((sealed ? unseal(headBytes, key, `${name}:head`) : headBytes).toString());
  if (metaOnly) return { meta: head.meta, sections: null };
  const bytes = fs.readFileSync(file);
  if (size < bodyAt + 4 || bytes.length !== bodyAt + 4 + bytes.readUInt32LE(bodyAt)) throw corrupt();
  const raw = bytes.subarray(bodyAt + 4), body = sealed ? unseal(raw, key, `${name}:body`) : raw, sections = {};
  let p = 0;
  for (const [section, list] of Object.entries(head.sections)) {
    const fields = {};
    for (const [field, type, length] of list) {
      const T = TYPES[type], n = length * T.BYTES_PER_ELEMENT;
      if (p + n > body.length) throw corrupt();
      fields[field] = new T(body.buffer.slice(body.byteOffset + p, body.byteOffset + p + n)); // copied: aligned for its type
      p += n;
    }
    sections[section] = fields;
  }
  if (p !== body.length) throw corrupt();
  return { meta: head.meta, sections };
}
