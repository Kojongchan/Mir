// Copies the web-ifc WASM binaries into /public so Vite can serve them.
// Run automatically before `dev` and `build` (see package.json scripts).
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'node_modules/web-ifc');
const dest = resolve(root, 'public/web-ifc');

const files = ['web-ifc.wasm', 'web-ifc-mt.wasm'];

mkdirSync(dest, { recursive: true });
for (const f of files) {
  const from = resolve(src, f);
  if (existsSync(from)) {
    copyFileSync(from, resolve(dest, f));
    console.log(`[copy-wasm] ${f} -> public/web-ifc/`);
  } else {
    console.warn(`[copy-wasm] missing ${from}`);
  }
}

// ThatOpen Fragments worker (성능 마이그레이션 spike) — served from /thatopen/.
const fragWorker = resolve(root, 'node_modules/@thatopen/fragments/dist/Worker/worker.mjs');
const fragDest = resolve(root, 'public/thatopen');
if (existsSync(fragWorker)) {
  mkdirSync(fragDest, { recursive: true });
  copyFileSync(fragWorker, resolve(fragDest, 'worker.mjs'));
  console.log('[copy-wasm] fragments worker.mjs -> public/thatopen/');
}
