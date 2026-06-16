#!/usr/bin/env node
// =====================================================================
// MIR_VDC — headless end-to-end check (S1).
// Verifies the real Supabase wiring without a browser: sign in with a
// username/password, list RLS-scoped projects, then (optionally) upload a
// tiny object to the 'models' bucket + insert a models row + download it
// back + clean up. Mirrors what the web app does in src/lib/api.ts.
//
// Usage (do NOT commit real values; pass via env or a gitignored .env):
//   SUPABASE_URL=...  SUPABASE_ANON_KEY=...  \
//   TEST_USER=tester  TEST_PASS=...  [TEST_UPLOAD=1]  \
//   node scripts/verify-e2e.mjs
//
// Reads VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY from .env as fallback.
// =====================================================================
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { usernameToEmail } from './username-email.mjs';

// --- tiny .env loader (no extra deps) --------------------------------
function loadDotEnv() {
  try {
    for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env — rely on real env vars */ }
}
loadDotEnv();

const URL_ = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const USER = process.env.TEST_USER;
const PASS = process.env.TEST_PASS;

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m, e) => { console.error(`  \x1b[31m✗\x1b[0m ${m}${e ? `: ${e.message || e}` : ''}`); process.exitCode = 1; };

if (!URL_ || !KEY) { fail('missing SUPABASE_URL / SUPABASE_ANON_KEY'); process.exit(1); }
if (!USER || !PASS) { fail('missing TEST_USER / TEST_PASS'); process.exit(1); }

const supabase = createClient(URL_, KEY, { auth: { persistSession: false } });

console.log(`\nMIR_VDC e2e check → ${URL_}`);

// 1) sign in
const { data: auth, error: authErr } = await supabase.auth.signInWithPassword({
  email: usernameToEmail(USER),
  password: PASS,
});
if (authErr) { fail('sign in', authErr); process.exit(1); }
ok(`signed in as ${USER} (uid ${auth.user.id.slice(0, 8)}…)`);

// 2) profile row exists (handle_new_user trigger)
const { data: prof, error: profErr } = await supabase
  .from('profiles').select('username, is_admin').eq('id', auth.user.id).single();
if (profErr) fail('read own profile', profErr);
else ok(`profile: username=${prof.username} is_admin=${prof.is_admin}`);

// 3) projects scoped by RLS
const { data: projects, error: projErr } = await supabase
  .from('projects').select('id, name, code').order('name');
if (projErr) { fail('list projects (RLS)', projErr); }
else {
  ok(`projects visible: ${projects.length}${projects.length ? ' → ' + projects.map((p) => p.name).join(', ') : ' (assign membership in seed.sql)'}`);
}

const project = projects?.[0];

// 4) models list for first project
if (project) {
  const { data: models, error: mErr } = await supabase
    .from('models').select('id, name, storage_path').eq('project_id', project.id);
  if (mErr) fail('list models (RLS)', mErr);
  else ok(`models in "${project.name}": ${models.length}`);
}

// 5) optional storage round-trip (upload → row → download → cleanup)
if (process.env.TEST_UPLOAD === '1' && project) {
  const modelId = crypto.randomUUID();
  const path = `${project.id}/${modelId}.ifc`;
  const body = new Blob([
    "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n",
  ], { type: 'application/octet-stream' });

  const { error: upErr } = await supabase.storage.from('models').upload(path, body, { upsert: false });
  if (upErr) { fail('storage upload (RLS write)', upErr); }
  else {
    ok('storage upload');
    const { error: insErr } = await supabase.from('models').insert({
      id: modelId, project_id: project.id, name: 'e2e-test.ifc', storage_path: path,
      size_bytes: body.size, uploaded_by: auth.user.id,
    });
    if (insErr) fail('models insert (RLS write)', insErr);
    else ok('models row insert');

    const { data: dl, error: dlErr } = await supabase.storage.from('models').download(path);
    if (dlErr) fail('storage download (RLS read)', dlErr);
    else ok(`storage download (${(await dl.arrayBuffer()).byteLength} bytes)`);

    // cleanup (models_delete requires admin; ignore if not)
    await supabase.from('models').delete().eq('id', modelId);
    await supabase.storage.from('models').remove([path]);
    ok('cleanup attempted');
  }
} else if (project) {
  console.log('  · skip storage round-trip (set TEST_UPLOAD=1 to enable)');
}

await supabase.auth.signOut();
console.log(process.exitCode ? '\n\x1b[31mFAILED\x1b[0m — see above.\n' : '\n\x1b[32mALL CHECKS PASSED\x1b[0m\n');
