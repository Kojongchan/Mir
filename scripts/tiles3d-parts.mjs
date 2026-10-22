// Parts of a staged tileset build (scripts/build-tiles3d.mjs, decision D27): which tiles each parallel job builds, and
// the tile records — everything the parents' job takes from one built tile, kept between builds by the tile's
// fingerprint so an unchanged tile is not built again.
import fs from 'node:fs';
import path from 'node:path';
import { groupSpatially } from './tiles3d.mjs';

/**
 * Tiles ({ key, centre, cost? }) for `parts` jobs: runs of `chunk` neighbouring tiles (the leaf order of groupSpatially —
 * they share SVF packs and skin partners), each run to the part with the least cost so far, costliest run first (a
 * dense stretch took 65 of the 222 minutes of run 223; the parts of run 224 took 16 to 42 minutes, 27 on average). Without costs every
 * tile counts 1 and the runs are dealt round. One part: the tiles in the given order.
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
  // Within a part, its runs in site order.
  return out.map(p => p.runs.sort((a, b) => a.c - b.c).flatMap(r => r.keys));
}

const TYPES = { Float64Array, Float32Array, Uint32Array, Uint16Array, Uint8Array, Int32Array };

/**
 * Write a record: `meta` (JSON) and `sections` ({ name: { field: typed array, … } | null }) as [header bytes u32, data
 * bytes u32, header JSON, the arrays]. Written beside and renamed into place, so a record is whole or absent.
 */
export function writeRecord(file, meta, sections = {}) {
  const head = { meta, sections: {} }, arrays = [];
  for (const [name, fields] of Object.entries(sections)) {
    if (!fields) continue;
    head.sections[name] = [];
    for (const [field, a] of Object.entries(fields)) {
      if (!ArrayBuffer.isView(a) || !TYPES[a.constructor.name]) continue;
      head.sections[name].push([field, a.constructor.name, a.length]);
      arrays.push(a);
    }
  }
  const json = Buffer.from(JSON.stringify(head)), size = Buffer.alloc(8);
  size.writeUInt32LE(json.length, 0);
  size.writeUInt32LE(arrays.reduce((n, a) => n + a.byteLength, 0), 4);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const part = `${file}.${process.pid}.part`, fd = fs.openSync(part, 'w');
  try {
    fs.writeSync(fd, size);
    fs.writeSync(fd, json);
    for (const a of arrays) fs.writeSync(fd, Buffer.from(a.buffer, a.byteOffset, a.byteLength));
  } finally { fs.closeSync(fd); }
  fs.renameSync(part, file);
}

/** A record written by writeRecord: { meta, sections: { name: { field: typed array } } }; `metaOnly`: just its meta. */
export function readRecord(file, { metaOnly = false } = {}) {
  if (metaOnly) {
    const fd = fs.openSync(file, 'r');
    try {
      const size = Buffer.alloc(8);
      if (fs.readSync(fd, size, 0, 8, 0) !== 8) throw new Error(`Corrupt record ${path.basename(file)}`);
      const json = Buffer.alloc(size.readUInt32LE(0));
      if (fs.readSync(fd, json, 0, json.length, 8) !== json.length) throw new Error(`Corrupt record ${path.basename(file)}`);
      return { meta: JSON.parse(json.toString()).meta, sections: null };
    } finally { fs.closeSync(fd); }
  }
  const bytes = fs.readFileSync(file);
  const headBytes = bytes.readUInt32LE(0), dataBytes = bytes.readUInt32LE(4);
  if (bytes.length !== 8 + headBytes + dataBytes) throw new Error(`Corrupt record ${path.basename(file)}`);
  const head = JSON.parse(bytes.subarray(8, 8 + headBytes).toString()), sections = {};
  let p = 8 + headBytes;
  for (const [name, list] of Object.entries(head.sections)) {
    const fields = {};
    for (const [field, type, length] of list) {
      const T = TYPES[type], n = length * T.BYTES_PER_ELEMENT;
      fields[field] = new T(bytes.buffer.slice(bytes.byteOffset + p, bytes.byteOffset + p + n)); // copied: aligned for its type
      p += n;
    }
    sections[name] = fields;
  }
  if (p !== bytes.length) throw new Error(`Corrupt record ${path.basename(file)}`);
  return { meta: head.meta, sections };
}
