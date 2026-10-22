// Fingerprint of the code a build step runs (scripts/build-tiles3d.mjs, decision D27): its tokens, without comments
// and spacing, those of every local module it reaches, and the versions of the packages they import. A tile built by
// the same code from the same inputs is the same tile, so its earlier result can be kept.
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { createHash } from 'node:crypto';
import { tokenizer } from 'acorn';

const LOCAL = /^\.\.?\/[\w./-]+\.m?js$/;
const BUILTIN = new Set(builtinModules);
const BREAK = /[\n\r\u2028\u2029]/;

/**
 * `code` as its tokens' text, each after a space or, where a line break (or a comment holding one) separates it from the
 * previous token, a line break: the one place where layout changes what a program does (automatic semicolons). Also
 * the local modules its string literals name (imports, workers) and the packages it imports.
 */
export function scanCode(code) {
  const parts = [], locals = [], packages = [];
  let end = 0, prev = null, before = null;
  for (const t of tokenizer(code, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true })) {
    parts.push((BREAK.test(code.slice(end, t.start)) ? '\n' : ' ') + code.slice(t.start, t.end));
    if (t.type.label === 'string') {
      if (LOCAL.test(t.value)) locals.push(t.value);
      else if ((prev?.type.label === 'name' && prev.value === 'from') || prev?.type.keyword === 'import'
        || (prev?.type.label === '(' && before?.type.keyword === 'import')) packages.push(t.value);
    }
    before = prev; prev = t; end = t.end;
  }
  return { text: parts.join(''), locals, packages };
}

const packageName = s => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]);
/** The installed version of a package, looked up from `dir` upwards as Node resolves it ('missing' when not found). */
function versionOf(name, dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    const file = path.join(d, 'node_modules', name, 'package.json');
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')).version ?? 'unknown';
    if (path.dirname(d) === d) return 'missing';
  }
}

/**
 * SHA-256 (hex) of `entry` — only its text before the line `marker` when one is given — and of everything it runs:
 * the local modules named in it, followed through, and each imported package's version (`skip`: packages that do not
 * shape the output, such as the storage client). `extra`: more modules (a stand-in named by the environment). The
 * Node major version counts too.
 */
export function codeFingerprint(entry, { marker = null, extra = [], skip = [] } = {}) {
  const hash = createHash('sha256'), seen = new Set(), base = path.dirname(path.resolve(entry)), versions = new Map();
  const visit = (file, cut = null) => {
    file = path.resolve(file);
    if (seen.has(file)) return;
    seen.add(file);
    let code = fs.readFileSync(file, 'utf8');
    if (cut) {
      const at = code.indexOf(`\n${cut}\n`);
      if (at < 0) throw new Error(`No line "${cut}" in ${file}`);
      code = code.slice(0, at + 1);
    }
    const { text, locals, packages } = scanCode(code);
    hash.update(`${path.relative(base, file).split(path.sep).join('/')}\0${text}\0`);
    for (const s of packages) {
      const name = packageName(s);
      if (s.startsWith('node:') || BUILTIN.has(name) || skip.includes(name) || versions.has(name)) continue;
      versions.set(name, versionOf(name, path.dirname(file)));
    }
    for (const l of locals) visit(path.resolve(path.dirname(file), l));
  };
  visit(entry, marker);
  for (const file of extra) visit(file);
  for (const [name, version] of [...versions].sort((a, b) => (a[0] < b[0] ? -1 : 1))) hash.update(`${name}@${version}\0`);
  hash.update(`node ${process.versions.node.split('.')[0]}`);
  return hash.digest('hex');
}
