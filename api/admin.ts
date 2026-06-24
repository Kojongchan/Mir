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

  // 2) authz: 시스템 관리자 OR (요청 프로젝트의) 프로젝트 관리자
  const { data: prof } = await admin
    .from('profiles')
    .select('is_admin')
    .eq('id', callerId)
    .single();
  const isSystemAdmin = !!prof?.is_admin;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: 'invalid json body' }, 400);
  }
  const action = body.action;
  const scopeProjectId = String(body.projectId ?? '');

  // 호출자가 해당 프로젝트의 '관리자(admin) 역할'인지.
  async function callerAdminsProject(pid: string): Promise<boolean> {
    if (!pid) return false;
    const { data } = await admin
      .from('project_members')
      .select('role')
      .eq('project_id', pid)
      .eq('user_id', callerId)
      .maybeSingle();
    return data?.role === 'admin';
  }
  const isProjectAdmin = !isSystemAdmin && (await callerAdminsProject(scopeProjectId));
  if (!isSystemAdmin && !isProjectAdmin) {
    return json({ error: '권한이 필요합니다(시스템 관리자 또는 프로젝트 관리자).' }, 403);
  }

  // 대상 사용자가 시스템 관리자인지(다른 시스템 관리자는 앱에서 변경 불가 — D21).
  async function targetIsSystemAdmin(userId: string): Promise<boolean> {
    if (!userId) return false;
    const { data } = await admin.from('profiles').select('is_admin').eq('id', userId).single();
    return !!data?.is_admin;
  }
  // 프로젝트 관리자는 자기 프로젝트(scopeProjectId) 멤버 + 본인만 대상으로(시스템 관리자는 전체).
  async function targetInScope(userId: string): Promise<boolean> {
    if (isSystemAdmin) return true;
    if (userId === callerId) return true;
    const { data } = await admin
      .from('project_members')
      .select('user_id')
      .eq('project_id', scopeProjectId)
      .eq('user_id', userId)
      .maybeSingle();
    return !!data;
  }
  const SYSADMIN_LOCKED = '다른 시스템 관리자 계정은 앱에서 변경할 수 없습니다. Supabase에서 관리하세요.';
  const OUT_OF_SCOPE = '이 프로젝트의 멤버만 관리할 수 있습니다.';

  try {
    if (action === 'createUser') {
      const username = String(body.username ?? '').trim();
      const password = String(body.password ?? '');
      const fullName = body.fullName ? String(body.fullName) : username;
      // 시스템 관리자는 앱에서 만들 수 없다(Supabase 에서만 승격) — 항상 일반 계정.
      const isAdmin = false;
      if (!username) return json({ error: '아이디를 입력하세요.' }, 400);
      if (password.length < 6) return json({ error: '비밀번호는 6자 이상이어야 합니다.' }, 400);
      // 프로젝트 관리자는 반드시 자기 프로젝트에 배정하면서 생성한다.
      if (isProjectAdmin && !scopeProjectId) return json({ error: 'projectId 필요' }, 400);

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

      // 프로젝트에 멤버로 배정(projectId 가 오면 — 프로젝트 관리자는 필수, 시스템 관리자는 선택).
      const newRole = ['viewer', 'editor', 'admin'].includes(String(body.role)) ? String(body.role) : 'viewer';
      if (scopeProjectId) {
        await admin
          .from('project_members')
          .upsert({ project_id: scopeProjectId, user_id: created.user.id, role: newRole }, { onConflict: 'project_id,user_id' });
      }

      return json({ ok: true, user: { id: created.user.id, username, full_name: fullName, is_admin: isAdmin } });
    }

    if (action === 'renameUser') {
      const userId = String(body.userId ?? '');
      const username = String(body.username ?? '').trim();
      if (!userId) return json({ error: 'userId required' }, 400);
      if (!username) return json({ error: '새 아이디를 입력하세요.' }, 400);
      if (userId !== callerId && (await targetIsSystemAdmin(userId))) return json({ error: SYSADMIN_LOCKED }, 403);
      if (!(await targetInScope(userId))) return json({ error: OUT_OF_SCOPE }, 403);

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
      if (userId !== callerId && (await targetIsSystemAdmin(userId))) return json({ error: SYSADMIN_LOCKED }, 403);
      if (!(await targetInScope(userId))) return json({ error: OUT_OF_SCOPE }, 403);
      const { error } = await admin.auth.admin.updateUserById(userId, { password });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === 'deleteUser') {
      // 계정(로그인) 삭제는 시스템 관리자만. 프로젝트 관리자는 '멤버 해제'(project_members 삭제)로.
      if (!isSystemAdmin) {
        return json({ error: '계정 삭제는 시스템 관리자만 가능합니다. (프로젝트에서 빼려면 멤버 해제를 사용하세요)' }, 403);
      }
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

    if (action === 'listAssignableUsers') {
      // 멤버 추가용 후보 — 프로젝트 관리자도 사용자 목록을 볼 수 있어야 기존 사용자를 배정.
      const { data } = await admin
        .from('profiles')
        .select('id, username, full_name, is_admin')
        .order('username');
      return json({ users: data ?? [] });
    }

    return json({ error: `알 수 없는 작업: ${String(action)}` }, 400);
  } catch (e) {
    return json({ error: (e as Error)?.message ?? 'server error' }, 500);
  }
}
