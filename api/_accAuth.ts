// Shared authorization for ACC write endpoints (aps-upload, aps-item). Not a route (leading underscore).
// - Fails closed when the server is not configured (previously auth was skipped if env was missing).
// - Editor or project admin of `mirProject`, or system admin (RBAC 0023 / D20).
// - Non-system-admins may only write to the ACC project pinned on that MIR project
//   (projects.acc_project_id, 0020), so an editor of project A cannot write into project B's ACC folders.
import { createClient } from '@supabase/supabase-js';

const accId = (id: string | null | undefined) => (id ?? '').trim().replace(/^b\./, '');

export async function authorizeAccWrite(req: Request, mirProject: unknown, accProject: unknown):
  Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRole) return { ok: false, status: 503, error: '서버 인증 설정이 없어 쓰기를 거부했습니다.' };
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!bearer) return { ok: false, status: 401, error: 'missing bearer token' };
  const supa = createClient(url, serviceRole, { auth: { persistSession: false } });
  const { data, error } = await supa.auth.getUser(bearer);
  if (error || !data?.user) return { ok: false, status: 401, error: 'invalid session' };
  const { data: prof } = await supa.from('profiles').select('is_admin').eq('id', data.user.id).maybeSingle();
  if (prof?.is_admin) return { ok: true };
  if (typeof mirProject !== 'string' || !mirProject || typeof accProject !== 'string' || !accProject)
    return { ok: false, status: 403, error: '권한이 없습니다(실무자 이상).' };
  const [{ data: mem }, { data: proj }] = await Promise.all([
    supa.from('project_members').select('role').eq('project_id', mirProject).eq('user_id', data.user.id).maybeSingle(),
    supa.from('projects').select('acc_project_id').eq('id', mirProject).maybeSingle(),
  ]);
  if (mem?.role !== 'editor' && mem?.role !== 'admin') return { ok: false, status: 403, error: '권한이 없습니다(실무자 이상).' };
  if (!proj?.acc_project_id || accId(proj.acc_project_id) !== accId(accProject))
    return { ok: false, status: 403, error: '이 프로젝트에 연결된 ACC 프로젝트가 아닙니다.' };
  return { ok: true };
}

/**
 * Read scope for ACC browse/download endpoints. System admins see everything (they pin projects);
 * everyone else only the ACC hubs/projects pinned on MIR projects they are a member of.
 * `allowQueryToken` covers media tags that cannot send headers (aps-file).
 */
export async function accReadScope(req: Request, allowQueryToken = false):
  Promise<{ ok: true; admin: boolean; hubs: Set<string>; projects: Set<string> } | { ok: false; status: number; error: string }> {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRole) return { ok: false, status: 503, error: '서버 인증 설정이 없어 요청을 거부했습니다.' };
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') ||
    (allowQueryToken ? new URL(req.url).searchParams.get('token') ?? '' : '');
  if (!bearer) return { ok: false, status: 401, error: 'missing token' };
  const supa = createClient(url, serviceRole, { auth: { persistSession: false } });
  const { data, error } = await supa.auth.getUser(bearer);
  if (error || !data?.user) return { ok: false, status: 401, error: 'invalid session' };
  const { data: prof } = await supa.from('profiles').select('is_admin').eq('id', data.user.id).maybeSingle();
  if (prof?.is_admin) return { ok: true, admin: true, hubs: new Set(), projects: new Set() };
  const { data: mems } = await supa.from('project_members').select('project_id').eq('user_id', data.user.id);
  const ids = (mems ?? []).map((m: { project_id: string }) => m.project_id);
  const { data: projs } = ids.length
    ? await supa.from('projects').select('acc_hub_id, acc_project_id').in('id', ids)
    : { data: [] as { acc_hub_id: string | null; acc_project_id: string | null }[] };
  const hubs = new Set<string>(), projects = new Set<string>();
  for (const p of projs ?? []) { if (p.acc_hub_id) hubs.add(accId(p.acc_hub_id)); if (p.acc_project_id) projects.add(accId(p.acc_project_id)); }
  return { ok: true, admin: false, hubs, projects };
}
export const inScope = (set: Set<string>, id: string | null | undefined) => set.has(accId(id));
