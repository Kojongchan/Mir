// Parts of a staged tileset build (scripts/build-tiles3d.mjs, decision D27): which tiles each parallel job builds, and
// the leaves' coarsest groups handed from those jobs to the one that builds the parents.
import fs from 'node:fs';
import { groupSpatially } from './tiles3d.mjs';

/**
 * Tiles ({ key, centre }) for `parts` jobs: runs of `chunk` neighbouring tiles (the leaf order of groupSpatially — they
 * share SVF packs and skin partners) dealt round, so a dense stretch is shared (100 tiles at a junction took 65 of the
 * 222 minutes of run 223). One part: the tiles in the given order.
 */
export function partition(items, parts, chunk = 16) {
  if (parts <= 1) return [items.map(it => it.key)];
  const order = [];
  const visit = node => { if (Array.isArray(node.children)) node.children.forEach(visit); else order.push(node.key); };
  visit(groupSpatially(items, 8));
  const out = Array.from({ length: parts }, () => []);
  for (let c = 0; c * chunk < order.length; c++) out[c % parts].push(...order.slice(c * chunk, (c + 1) * chunk));
  return out;
}

const TYPES = { Float64Array, Float32Array, Uint32Array, Uint16Array, Uint8Array, Int32Array };

/**
 * Append one leaf's groups ({ opaque, transparent }, each { pos, rgba, ids, idx, skin? } or null) to a file opened for
 * writing: [header bytes u32, data bytes u32, header JSON, the arrays].
 */
export function writeGroups(fd, key, groups) {
  const head = { key, groups: {} }, arrays = [];
  for (const kind of ['opaque', 'transparent']) {
    const g = groups?.[kind];
    if (!g) continue;
    head.groups[kind] = [];
    for (const [name, a] of Object.entries(g)) {
      if (!ArrayBuffer.isView(a) || !TYPES[a.constructor.name]) continue;
      head.groups[kind].push([name, a.constructor.name, a.length]);
      arrays.push(a);
    }
  }
  const json = Buffer.from(JSON.stringify(head)), size = Buffer.alloc(8);
  size.writeUInt32LE(json.length, 0);
  size.writeUInt32LE(arrays.reduce((n, a) => n + a.byteLength, 0), 4);
  fs.writeSync(fd, size);
  fs.writeSync(fd, json);
  for (const a of arrays) fs.writeSync(fd, Buffer.from(a.buffer, a.byteOffset, a.byteLength));
}

/** The records of a file written by writeGroups: Map key → { opaque, transparent } (each group or null). */
export function readGroups(file) {
  const bytes = fs.readFileSync(file), out = new Map();
  for (let at = 0; at < bytes.length;) {
    const headBytes = bytes.readUInt32LE(at), dataBytes = bytes.readUInt32LE(at + 4);
    const head = JSON.parse(bytes.subarray(at + 8, at + 8 + headBytes).toString());
    let p = at + 8 + headBytes;
    const groups = { opaque: null, transparent: null };
    for (const [kind, list] of Object.entries(head.groups)) {
      const g = {};
      for (const [name, type, length] of list) {
        const T = TYPES[type], n = length * T.BYTES_PER_ELEMENT;
        g[name] = new T(bytes.buffer.slice(bytes.byteOffset + p, bytes.byteOffset + p + n)); // copied: aligned for its type
        p += n;
      }
      groups[kind] = g;
    }
    if (p !== at + 8 + headBytes + dataBytes) throw new Error(`Corrupt groups record for ${head.key}`);
    out.set(head.key, groups);
    at = p;
  }
  return out;
}

/** Object boxes (6 floats per object, ±Infinity where none) of another part grown into `into`. */
export function mergeBoxes(into, other) {
  for (let k = 0; k < into.length; k += 6) for (let a = 0; a < 3; a++) {
    if (other[k + a] < into[k + a]) into[k + a] = other[k + a];
    if (other[k + 3 + a] > into[k + 3 + a]) into[k + 3 + a] = other[k + 3 + a];
  }
  return into;
}
