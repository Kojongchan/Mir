// Copies WASM runtimes into /public so Vite can serve them:
//   web-ifc (IFC parsing) → public/web-ifc/, Basis Universal transcoder (KTX2 terrain photos, second 3D viewer)
//   → public/basis/. Run automatically before `dev` and `build` (see package.json scripts) and by ui-check.
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sets = [
  { src: 'node_modules/web-ifc', dest: 'public/web-ifc', files: ['web-ifc.wasm', 'web-ifc-mt.wasm'] },
  { src: 'node_modules/three/examples/jsm/libs/basis', dest: 'public/basis', files: ['basis_transcoder.js', 'basis_transcoder.wasm'] },
];

for (const set of sets) {
  const dest = resolve(root, set.dest);
  mkdirSync(dest, { recursive: true });
  for (const f of set.files) {
    const from = resolve(root, set.src, f);
    if (existsSync(from)) {
      copyFileSync(from, resolve(dest, f));
      console.log(`[copy-wasm] ${f} -> ${set.dest}/`);
    } else {
      console.warn(`[copy-wasm] missing ${from}`);
    }
  }
}
