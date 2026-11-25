import { gzipSync, gunzipSync } from 'node:zlib';

/** Transport compression only. Geometry, IDs, materials and XKT tables remain byte-identical. */
export function encodeXktTransfer(input) {
  const raw = Buffer.from(input);
  if (!raw.length) throw new Error('Empty XKT');
  if (raw[0] === 0x1f && raw[1] === 0x8b) throw new Error('Expected decoded XKT, received gzip');
  const compressed = gzipSync(raw, { level: 6 });
  if (compressed.length >= raw.length * 0.99) {
    return { body: raw, contentEncoding: undefined, byteLength: raw.length, transferByteLength: raw.length };
  }
  // Verify before publishing: a transport optimization must not alter a single model byte.
  if (!gunzipSync(compressed).equals(raw)) throw new Error('XKT transport verification failed');
  return { body: compressed, contentEncoding: 'gzip', byteLength: raw.length, transferByteLength: compressed.length };
}
