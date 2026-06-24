// =====================================================================
// MIR_VDC — S2 admin user management (Vercel serverless function).
//
// Creating / deleting Supabase auth users and resetting passwords are
// privileged operations that require the service_role key. That key must
// NEVER reach the browser, so these run here, server-side. The browser
// calls POST /api/admin with the caller's access token; we verify the
// caller is an admin before doing anything.
//
// Required env (set in Vercel project settings — NOT VITE_ prefixed, so
// they stay server-only):
//   SUPABASE_URL                (falls back to VITE_SUPABASE_URL)
//   SUPABASE_SERVICE_ROLE_KEY   (service_role secret — server only!)
//
// This file is intentionally outside tsconfig's `src` include; Vercel
// compiles it on deploy. It is not part of `npm run typecheck`/`build`.
// =====================================================================
import { createClient } from '@supabase/supabase-js';

// IMPORTANT: this handler uses the Web `Request`/`Response` signature
// (`new Response(...)`, `req.json()`). On Vercel that signature is only
// served correctly by the **Edge runtime**; under the default Node.js
// runtime the returned Response is ignored and the request hangs forever
// (the browser sees the action stuck — e.g. "생성 중…" never finishing).
// Declaring the edge runtime is what actually sends the response.
export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

// MIRROR of usernameToEmail() in src/lib/supabase.ts — KEEP IN SYNC.
// ASCII usernames pass through ("admin" -> "admin@mir.local"); non-ASCII
// (e.g. Korean) map to a reversible "u-<hex>@mir.local" local part.
const USERNAME_DOMAIN = 'mir.local';
function usernameToEmail(username: string): string {
  const name = username.trim().toLowerCase();
  if (/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(name) && !name.startsWith('u-')) {
    return `${name}@${USERNAME_DOMAIN}`;
  }
  const hex = Array.from(new TextEncoder().encode(name))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `u-${hex}@${USERNAME_DOMAIN}`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    return json({ error: '서버 환경변수 미설정 (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)' }, 500);
  }

  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'missing bearer token' }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  // 1) identify the caller from their access token
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) return json({ error: 'invalid session' }, 401);
  const callerId = userData.user.id;

  // 2) only admins may proceed
  const { data: prof } = await admin
    .from('profiles')
    .select('is_admin')
    .eq('id', callerId)
    .single();
  if (!prof?.is_admin) return json({ error: '관리자 권한이 필요합니다.' }, 403);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: 'invalid json body' }, 400);
  }
  const action = body.action;

  // 시스템 관리자(is_admin) 계정은 앱에서 변경 불가 — Supabase 에서만 관리(보안 결정).
  // 사용자 대상 작업(rename/resetPassword/delete)이 시스템 관리자를 향하면 거부한다.
  async function targetIsSystemAdmin(userId: string): Promise<boolean> {
    if (!userId) return false;
    const { data } = await admin.from('profiles').select('is_admin').eq('id', userId).single();
    return !!data?.is_admin;
  }
  const SYSADMIN_LOCKED = '시스템 관리자 계정은 앱에서 변경할 수 없습니다. Supabase에서 관리하세요.';

  try {
    if (action === 'createUser') {
      const username = String(body.username ?? '').trim();
      const password = String(body.password ?? '');
      const fullName = body.fullName ? String(body.fullName) : username;
      // 시스템 관리자는 앱에서 만들 수 없다(Supabase 에서만 승격) — 항상 일반 계정.
      const isAdmin = false;
      if (!username) return json({ error: '아이디를 입력하세요.' }, 400);
      if (password.length < 6) return json({ error: '비밀번호는 6자 이상이어야 합니다.' }, 400);

      const email = usernameToEmail(username);
      const { data: created, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { username, full_name: fullName },
      });
      if (error || !created?.user) return json({ error: error?.message ?? '생성 실패' }, 400);

      // The handle_new_user trigger creates the profile from metadata; make
      // sure username/full_name/is_admin reflect exactly what was requested
      // (this is what removes the old manual non-ASCII correction SQL).
      await admin
        .from('profiles')
        .update({ username, full_name: fullName, is_admin: isAdmin })
        .eq('id', created.user.id);

      return json({ ok: true, user: { id: created.user.id, username, full_name: fullName, is_admin: isAdmin } });
    }

    if (action === 'renameUser') {
      const userId = String(body.userId ?? '');
      const username = String(body.username ?? '').trim();
      if (!userId) return json({ error: 'userId required' }, 400);
      if (!username) return json({ error: '새 아이디를 입력하세요.' }, 400);
      if (await targetIsSystemAdmin(userId)) return json({ error: SYSADMIN_LOCKED }, 403);

      // The login username also drives the internal auth e-mail (D4), so
      // both must change together. Guard against collisions up-front: the
      // profiles.username column and auth.users.email are both UNIQUE.
      const email = usernameToEmail(username);
      const { data: clash } = await admin
        .from('profiles')
        .select('id')
        .eq('username', username)
        .neq('id', userId)
        .maybeSingle();
      if (clash) return json({ error: '이미 사용 중인 아이디입니다.' }, 409);

      // 1) sync the internal auth e-mail + metadata (email_confirm avoids a
      // re-confirmation flow on the synthetic address).
      const { error: authErr } = await admin.auth.admin.updateUserById(userId, {
        email,
        email_confirm: true,
        user_metadata: { username },
      });
      if (authErr) return json({ error: authErr.message }, 400);

      // 2) reflect the new username in the profile row.
      const { error: profErr } = await admin
        .from('profiles')
        .update({ username })
        .eq('id', userId);
      if (profErr) return json({ error: profErr.message }, 400);

      return json({ ok: true, user: { id: userId, username } });
    }

    if (action === 'resetPassword') {
      const userId = String(body.userId ?? '');
      const password = String(body.password ?? '');
      if (!userId) return json({ error: 'userId required' }, 400);
      if (password.length < 6) return json({ error: '비밀번호는 6자 이상이어야 합니다.' }, 400);
      if (await targetIsSystemAdmin(userId)) return json({ error: SYSADMIN_LOCKED }, 403);
      const { error } = await admin.auth.admin.updateUserById(userId, { password });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === 'deleteUser') {
      const userId = String(body.userId ?? '');
      if (!userId) return json({ error: 'userId required' }, 400);
      if (userId === callerId) return json({ error: '자기 자신은 삭제할 수 없습니다.' }, 400);
      if (await targetIsSystemAdmin(userId)) return json({ error: SYSADMIN_LOCKED }, 403);
      // detach uploaded models first (FK) so the delete doesn't fail
      await admin.from('models').update({ uploaded_by: null }).eq('uploaded_by', userId);
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: `알 수 없는 작업: ${String(action)}` }, 400);
  } catch (e) {
    return json({ error: (e as Error)?.message ?? 'server error' }, 500);
  }
}
