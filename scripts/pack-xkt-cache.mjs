/** Local-only existing cache repack. No APS calls, credentials, network or automatic publication.
 * node scripts/pack-xkt-cache.mjs INPUT_XKT_DIRECTORY NEW_OUTPUT_DIRECTORY
 * The output directory must not exist. Upload its files with headers from upload-plan.json,
 * then publish manifest.json LAST under the original xkt directory. Existing chunks stay intact.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { encodeXktTransfer } from './xkt-transfer.mjs';

export async function packXktCache(inputDirectory, outputDirectory) {
  const root = await fs.realpath(inputDirectory);
  const output = path.resolve(outputDirectory);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  const names = [...new Set([
    ...(manifest.xktFiles ?? []), ...(manifest.navFiles ?? []), ...(manifest.base ?? []),
    ...(manifest.tiles ?? []).filter(t => t.motion).map(t => t.motion.n),
    ...(manifest.inst ?? []), ...(manifest.tiles ?? []).map(t => t.n), ...(manifest.lod1 ? [manifest.lod1] : []),
  ])];
  if (!names.length) throw new Error('No cached XKT files');
  const sources = new Map();
  for (const name of names) {
    if (typeof name !== 'string' || !name.endsWith('.xkt') || name.includes('\\') || path.isAbsolute(name) || name.split('/').includes('..')) throw new Error('Invalid cache path');
    const file = await fs.realpath(path.join(root, name));
    if (!file.startsWith(root + path.sep)) throw new Error('Cache path escapes source directory');
    sources.set(name, file);
  }
  // Never overwrite an existing cache or a previous successful package.
  await fs.mkdir(output);
  const generation = `runs/transport-${randomUUID()}`;
  const replacements = new Map(), info = {}, uploads = [];
  let decodedBytes = 0, transferBytes = 0;
  try {
    for (const [index, name] of names.entries()) {
      const stored = await fs.readFile(sources.get(name));
      const raw = stored[0] === 0x1f && stored[1] === 0x8b ? gunzipSync(stored) : stored;
      const packed = encodeXktTransfer(raw);
      const next = `${generation}/${index}.xkt`;
      await fs.mkdir(path.dirname(path.join(output, next)), { recursive: true });
      await fs.writeFile(path.join(output, next), packed.body, { flag: 'wx' });
      replacements.set(name, next);
      info[next] = { ...manifest.chunkInfo?.[name], byteLength: packed.byteLength,
        transferByteLength: packed.transferByteLength, contentEncoding: packed.contentEncoding ?? 'identity' };
      uploads.push({ path: next, contentType: 'application/octet-stream', contentEncoding: packed.contentEncoding ?? null });
      decodedBytes += packed.byteLength; transferBytes += packed.transferByteLength;
    }
    const result = { ...manifest, chunkInfo: info, transport: { version: 1, decodedBytes, transferBytes } };
    for (const key of ['xktFiles', 'navFiles', 'base', 'inst']) {
      if (manifest[key]) result[key] = manifest[key].map(n => replacements.get(n));
    }
    if (manifest.lod1) result.lod1 = replacements.get(manifest.lod1);
    if (manifest.tiles) result.tiles = manifest.tiles.map(t => {
      const n = replacements.get(t.n);
      return { ...t, n, byteLength: info[n].byteLength,
        ...(t.motion ? { motion: { ...t.motion, n: replacements.get(t.motion.n), byteLength: info[replacements.get(t.motion.n)].byteLength } } : {}) };
    });
    await fs.writeFile(path.join(output, 'upload-plan.json'), JSON.stringify({ uploads,
      publishLast: 'manifest.json', note: 'Set Content-Encoding exactly as listed; uploading gzip as identity breaks XKT loading.' }, null, 2));
    await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(result));
    return { files: names.length, decodedBytes, transferBytes };
  } catch (error) {
    await fs.rm(output, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [, , source, destination] = process.argv;
  if (!source || !destination) throw new Error('Usage: node scripts/pack-xkt-cache.mjs INPUT_XKT_DIRECTORY NEW_OUTPUT_DIRECTORY');
  console.log(JSON.stringify(await packXktCache(source, destination)));
}
