// =====================================================================
// MIR — AI 연결(MCP) 저장소: 대상(sim45d_setup)·권한·작업일보·도구 기록·유사 사례.
// 운영: Supabase(service role — 권한은 여기서 직접 확인). 로컬 시험: MCP_DEV_STORE(JSON 파일).
// 0041 이 아직 없으면 기록·사례는 조용히 건너뛰고(도구는 계속 동작) 사례 도구는 안내를 돌려준다.
// =====================================================================
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { normalizeSetup, type SetupData } from '../src/lib/sim45d/setup.js';

export type McpRole = 'admin' | 'editor' | 'viewer';

export interface SetupRow { id: string; name: string; data: SetupData; updatedAt: string }

export interface ToolLog { projectId: string; setupId: string | null; userId: string; tool: string; args: unknown; result: string; ok: boolean; ms: number }

export interface CaseInput {
  projectId: string;
  setupId: string | null;
  structureKind: string;
  structure: string;
  kind: 'rates' | 'design' | 'critical' | 'actuals' | 'lesson' | 'links';
  title: string;
  body: unknown;
  source: string;
  tags: string[];
  createdBy: string;
}

export interface CaseRow extends CaseInput { id: string; createdAt: string; projectName: string }

export interface McpStore {
  role(userId: string, projectId: string): Promise<McpRole | null>;
  projectName(projectId: string): Promise<string>;
  listSetups(projectId: string): Promise<SetupRow[]>;
  saveSetup(projectId: string, id: string, data: SetupData, userId: string): Promise<void>;
  dailyLogs(projectId: string, limit: number): Promise<{ date: string; text: string }[]>;
  logCall(entry: ToolLog): Promise<void>;
  /** 0041 이 없으면 false. 배운 점(lesson) 말고는 같은 대상·종류의 이전 사례를 바꾼다(최신 판단 하나). */
  addCase(c: CaseInput): Promise<boolean>;
  /** 0041 이 없으면 null. excludeSetup: 그 대상 자신의 사례는 뺀다(지금 작업 중인 대상). */
  findCases(q: { kind?: string; text?: string; structureKind?: string; excludeSetup?: string; limit: number }): Promise<CaseRow[] | null>;
}

const missingTable = (e: { code?: string; message?: string } | null) => !!e && (e.code === 'PGRST205' || e.code === '42P01' || /does not exist|schema cache/i.test(e.message ?? ''));

export function supabaseStore(url: string, serviceRole: string): McpStore {
  const db = createClient(url, serviceRole, { auth: { persistSession: false } });
  const names = new Map<string, string>();
  const store: McpStore = {
    async role(userId, projectId) {
      const { data: prof } = await db.from('profiles').select('is_admin').eq('id', userId).maybeSingle();
      if (prof?.is_admin) return 'admin';
      const { data: mem } = await db.from('project_members').select('role').eq('project_id', projectId).eq('user_id', userId).maybeSingle();
      if (!mem) return null;
      return mem.role === 'admin' ? 'admin' : mem.role === 'editor' ? 'editor' : 'viewer';
    },
    async projectName(projectId) {
      if (!names.has(projectId)) {
        const { data } = await db.from('projects').select('name').eq('id', projectId).maybeSingle();
        names.set(projectId, (data?.name as string | undefined) ?? projectId);
      }
      return names.get(projectId)!;
    },
    async listSetups(projectId) {
      const { data, error } = await db.from('sim45d_setup').select('id, name, data, updated_at').eq('project_id', projectId).order('updated_at', { ascending: false });
      if (error) throw new Error(`대상 읽기 실패: ${error.message}`);
      return (data ?? []).map(r => ({ id: r.id as string, name: r.name as string, data: normalizeSetup(r.data), updatedAt: r.updated_at as string }));
    },
    async saveSetup(projectId, id, data, userId) {
      const { error } = await db.from('sim45d_setup').update({ data, updated_at: new Date().toISOString(), updated_by: userId }).eq('id', id).eq('project_id', projectId);
      if (error) throw new Error(`저장 실패: ${error.message}`);
    },
    async dailyLogs(projectId, limit) {
      const { data, error } = await db.from('daily_logs').select('log_date, content').eq('project_id', projectId).order('log_date', { ascending: false }).limit(limit);
      if (error) return [];
      return (data ?? []).filter(l => (l.content as string | null)?.trim()).map(l => ({ date: l.log_date as string, text: (l.content as string).slice(0, 3000) }));
    },
    async logCall(e) {
      const { error } = await db.from('ai_tool_log').insert({
        project_id: e.projectId, setup_id: e.setupId, user_id: e.userId, tool: e.tool, args: e.args, result: e.result.slice(0, 2000), ok: e.ok, ms: e.ms,
      });
      if (error && !missingTable(error)) console.warn('[mcp] log', error.message);
    },
    async addCase(c) {
      if (c.kind !== 'lesson' && c.setupId) {
        const del = await db.from('sim45d_cases').delete().eq('setup_id', c.setupId).eq('kind', c.kind);
        if (missingTable(del.error)) return false;
      }
      const { error } = await db.from('sim45d_cases').insert({
        project_id: c.projectId, setup_id: c.setupId, structure_kind: c.structureKind, structure: c.structure, kind: c.kind,
        title: c.title, body: c.body, source: c.source, tags: c.tags, created_by: c.createdBy,
      });
      if (missingTable(error)) return false;
      if (error) throw new Error(`사례 저장 실패: ${error.message}`);
      return true;
    },
    async findCases(q) {
      let query = db.from('sim45d_cases').select('*').order('created_at', { ascending: false }).limit(q.limit);
      if (q.kind) query = query.eq('kind', q.kind);
      if (q.structureKind) query = query.eq('structure_kind', q.structureKind);
      if (q.excludeSetup && /^[0-9a-f-]{36}$/i.test(q.excludeSetup)) query = query.or(`setup_id.is.null,setup_id.neq.${q.excludeSetup}`);
      if (q.text) query = query.or(`title.ilike.%${q.text.replace(/[%,()]/g, ' ')}%,structure.ilike.%${q.text.replace(/[%,()]/g, ' ')}%`);
      const { data, error } = await query;
      if (missingTable(error)) return null;
      if (error) throw new Error(`사례 찾기 실패: ${error.message}`);
      const rows = data ?? [];
      return Promise.all(rows.map(async r => ({
        id: r.id, projectId: r.project_id, setupId: r.setup_id, structureKind: r.structure_kind, structure: r.structure, kind: r.kind,
        title: r.title, body: r.body, source: r.source, tags: r.tags ?? [], createdBy: r.created_by, createdAt: r.created_at, projectName: await store.projectName(r.project_id),
      })));
    },
  };
  return store;
}

/** 로컬 시험용 — JSON 파일 하나(projects·members·setups·dailyLogs·logs·cases). */
export function fileStore(file: string): McpStore {
  type Db = {
    projects: Record<string, { name: string }>;
    members: { user: string; project: string; role: McpRole }[];
    setups: { id: string; project: string; name: string; data: unknown; updatedAt: string }[];
    dailyLogs: { project: string; date: string; text: string }[];
    logs: (ToolLog & { at: string })[];
    cases: (CaseInput & { id: string; createdAt: string })[];
  };
  const read = (): Db => ({ projects: {}, members: [], setups: [], dailyLogs: [], logs: [], cases: [], ...JSON.parse(fs.readFileSync(file, 'utf8')) });
  const write = (db: Db) => fs.writeFileSync(file, JSON.stringify(db, null, 1));
  return {
    async role(u, p) { return read().members.find(m => m.user === u && m.project === p)?.role ?? null; },
    async projectName(p) { return read().projects[p]?.name ?? p; },
    async listSetups(p) { return read().setups.filter(s => s.project === p).map(s => ({ id: s.id, name: s.name, data: normalizeSetup(s.data), updatedAt: s.updatedAt })); },
    async saveSetup(p, id, data) {
      const db = read(); const row = db.setups.find(s => s.id === id && s.project === p);
      if (!row) throw new Error('대상 없음'); row.data = data; row.updatedAt = new Date().toISOString(); write(db);
    },
    async dailyLogs(p, limit) { return read().dailyLogs.filter(l => l.project === p).slice(0, limit).map(l => ({ date: l.date, text: l.text })); },
    async logCall(e) { const db = read(); db.logs.push({ ...e, at: new Date().toISOString() }); write(db); },
    async addCase(c) {
      const db = read();
      if (c.kind !== 'lesson') db.cases = db.cases.filter(x => !(x.setupId === c.setupId && x.kind === c.kind));
      db.cases.push({ ...c, id: `c${Date.now()}${db.cases.length}`, createdAt: new Date().toISOString() });
      write(db);
      return true;
    },
    async findCases(q) {
      const db = read();
      const t = q.text?.replace(/\s/g, '');
      return db.cases.filter(c => (!q.kind || c.kind === q.kind) && (!q.structureKind || c.structureKind === q.structureKind)
        && (!q.excludeSetup || c.setupId !== q.excludeSetup) && (!t || `${c.title}${c.structure}`.replace(/\s/g, '').includes(t)))
        .slice(-q.limit).reverse().map(c => ({ ...c, projectName: db.projects[c.projectId]?.name ?? c.projectId }));
    },
  };
}

/** 환경에 맞는 저장소: Supabase(운영) 또는 MCP_DEV_STORE(로컬 시험). 없으면 null. */
export function mcpStore(): McpStore | null {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const role = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && role) return supabaseStore(url, role);
  if (process.env.MCP_DEV_STORE) return fileStore(process.env.MCP_DEV_STORE);
  return null;
}
