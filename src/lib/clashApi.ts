import { supabase } from './supabase';
import type { ClashRow, ClashStatus, ClashType } from './clash';
import type { ElementMeta } from '../viewer/IfcViewer';
import type { ApsMapping } from './apsMapping';

// =====================================================================
// 충돌검사 결과 영속화 — Phase 4 / S32 (migration 0015_clash.sql).
// clash_tests(설정+실행) + clashes(개별 간섭) 저장/불러오기. 쓰기는 admin(D11).
// 런타임 modelID 는 휘발성이므로, 저장 시 DB 모델 uuid 로 매핑해 두었다가
// 불러올 때 다시 해석한다(이슈 위치보기/포커스 재현용).
// =====================================================================

export interface ClashTestMeta {
  id: string;
  project_id: string;
  name: string;
  set_a: string | null;
  set_b: string | null;
  type: ClashType;
  tolerance: number;
  created_at: string;
}

/** 런타임 modelID → DB 모델 uuid 매핑(저장용). */
export type ModelIdMap = Map<number, string>;

export async function listClashTests(projectId: string): Promise<ClashTestMeta[]> {
  const { data, error } = await supabase
    .from('clash_tests')
    .select('id, project_id, name, set_a, set_b, type, tolerance, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as ClashTestMeta[];
}

export async function saveClashTest(input: {
  projectId: string;
  name: string;
  setA: string;
  setB: string;
  type: ClashType;
  tolerance: number;
  rows: ClashRow[];
  modelIdMap: ModelIdMap;
}): Promise<string> {
  const { data: userData } = await supabase.auth.getUser();
  const { data: test, error: tErr } = await supabase
    .from('clash_tests')
    .insert({
      project_id: input.projectId,
      name: input.name,
      set_a: input.setA,
      set_b: input.setB,
      type: input.type,
      tolerance: input.tolerance,
      created_by: userData.user?.id ?? null,
    })
    .select('id')
    .single();
  if (tErr) throw tErr;
  const testId = test.id as string;

  if (input.rows.length > 0) {
    const payload = input.rows.map((r) => ({
      test_id: testId,
      model_a: input.modelIdMap.get(r.a.modelID) ?? null,
      express_a: r.a.expressID,
      name_a: r.a.name || null,
      category_a: r.a.category,
      model_b: input.modelIdMap.get(r.b.modelID) ?? null,
      express_b: r.b.expressID,
      name_b: r.b.name || null,
      category_b: r.b.category,
      point_x: r.point.x,
      point_y: r.point.y,
      point_z: r.point.z,
      depth: r.depth,
      status: r.status,
      issue_id: r.issueId ?? null,
    }));
    const { error: cErr } = await supabase.from('clashes').insert(payload);
    if (cErr) throw cErr;
  }
  return testId;
}

export interface LoadedClash {
  id: string; // DB row id
  model_a: string | null;
  express_a: number | null;
  name_a: string | null;
  category_a: string | null;
  model_b: string | null;
  express_b: number | null;
  name_b: string | null;
  category_b: string | null;
  point_x: number | null;
  point_y: number | null;
  point_z: number | null;
  depth: number | null;
  status: ClashStatus;
  issue_id: string | null;
}

/** 저장된 테스트의 간섭들을 불러온다. 런타임 modelID 재해석은 호출측 책임. */
export async function loadClashes(testId: string): Promise<LoadedClash[]> {
  const { data, error } = await supabase
    .from('clashes')
    .select(
      'id, model_a, express_a, name_a, category_a, model_b, express_b, name_b, category_b, point_x, point_y, point_z, depth, status, issue_id',
    )
    .eq('test_id', testId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as LoadedClash[];
}

export async function deleteClashTest(testId: string): Promise<void> {
  const { error } = await supabase.from('clash_tests').delete().eq('id', testId);
  if (error) throw error;
}

/** 간섭 상태 변경(검토중/해결/승인). admin 만(RLS). */
export async function setClashStatus(clashDbId: string, status: ClashStatus): Promise<void> {
  const { error } = await supabase.from('clashes').update({ status }).eq('id', clashDbId);
  if (error) throw error;
}

/** 간섭에 생성된 이슈를 연결. */
export async function linkClashIssue(clashDbId: string, issueId: string): Promise<void> {
  const { error } = await supabase.from('clashes').update({ issue_id: issueId }).eq('id', clashDbId);
  if (error) throw error;
}

// =====================================================================
// APS(GlobalId) 경로 — S49 / 0027. ACC 모델은 우리 models 테이블에 없으므로
// 저장키를 model uuid+expressID 대신 **GlobalId(=externalId)** 로 둔다. 런타임
// 간섭(apsClash)은 expressID 슬롯에 dbId 를 담고 있으므로, 저장 시 ApsMapping 으로
// dbId→GlobalId 변환해 global_id_a/b 에 넣고, 불러올 때 GlobalId→dbId 로 되돌린다.
// =====================================================================

export interface ApsClashSaveInput {
  projectId: string;
  name: string;
  setA: string;
  setB: string;
  type: ClashType;
  tolerance: number;
  rows: ClashRow[];
  /** 모델별 dbId↔GlobalId 매핑(model.id → mapping). row.a/b.modelID 로 선택. */
  mappings: Map<number, ApsMapping>;
}

/** modelID·dbId(expressID 슬롯) → GlobalId 해석(해당 모델 매핑에서). */
function gidOf(mappings: Map<number, ApsMapping>, modelID: number, dbId: number): string | null {
  return mappings.get(modelID)?.dbIdToGlobalId.get(dbId) ?? null;
}

/** APS 간섭 결과를 GlobalId 키로 저장(0027). model_a/express_a 는 비운다. */
export async function saveApsClashTest(input: ApsClashSaveInput): Promise<string> {
  const { data: userData } = await supabase.auth.getUser();
  const { data: test, error: tErr } = await supabase
    .from('clash_tests')
    .insert({
      project_id: input.projectId,
      name: input.name,
      set_a: input.setA,
      set_b: input.setB,
      type: input.type,
      tolerance: input.tolerance,
      created_by: userData.user?.id ?? null,
    })
    .select('id')
    .single();
  if (tErr) throw tErr;
  const testId = test.id as string;

  if (input.rows.length > 0) {
    const payload = input.rows.map((r) => ({
      test_id: testId,
      global_id_a: gidOf(input.mappings, r.a.modelID, r.a.expressID),
      name_a: r.a.name || null,
      category_a: r.a.category,
      global_id_b: gidOf(input.mappings, r.b.modelID, r.b.expressID),
      name_b: r.b.name || null,
      category_b: r.b.category,
      point_x: r.point.x,
      point_y: r.point.y,
      point_z: r.point.z,
      depth: r.depth,
      status: r.status,
      issue_id: r.issueId ?? null,
    }));
    const { error: cErr } = await supabase.from('clashes').insert(payload);
    if (cErr) throw cErr;
  }
  return testId;
}

export interface LoadedApsClash {
  id: string;
  global_id_a: string | null;
  name_a: string | null;
  category_a: string | null;
  global_id_b: string | null;
  name_b: string | null;
  category_b: string | null;
  point_x: number | null;
  point_y: number | null;
  point_z: number | null;
  depth: number | null;
  status: ClashStatus;
  issue_id: string | null;
}

/** 저장된 APS 간섭(GlobalId 키)을 불러온다. dbId 재해석은 loadedApsToRows 가 담당. */
export async function loadApsClashes(testId: string): Promise<LoadedApsClash[]> {
  const { data, error } = await supabase
    .from('clashes')
    .select(
      'id, global_id_a, name_a, category_a, global_id_b, name_b, category_b, point_x, point_y, point_z, depth, status, issue_id',
    )
    .eq('test_id', testId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as LoadedApsClash[];
}

/** 여러 매핑에서 GlobalId 를 가진 첫 모델의 {modelID, dbId} 를 찾는다. */
function resolveGid(
  mappings: ApsMapping[],
  globalId: string | null,
): { modelID: number; dbId: number } {
  if (globalId) {
    for (const m of mappings) {
      const dbId = m.globalIdToDbId.get(globalId);
      if (typeof dbId === 'number') return { modelID: (m.model?.id ?? 0) as number, dbId };
    }
  }
  return { modelID: (mappings[0]?.model?.id ?? 0) as number, dbId: -1 };
}

/**
 * 불러온 APS 간섭을 런타임 ClashRow 로 재구성. GlobalId → (model, dbId) 로 해석해
 * expressID 슬롯에 dbId·modelID 슬롯에 model.id 를 담는다(여러 로드 모델 검색).
 * 어디에도 없는 GlobalId 는 dbId=-1(표시만, 클릭 불가).
 */
export function loadedApsToRows(loaded: LoadedApsClash[], mappings: ApsMapping[]): ClashRow[] {
  return loaded.map((c) => {
    const ra = resolveGid(mappings, c.global_id_a);
    const rb = resolveGid(mappings, c.global_id_b);
    const aMeta: ElementMeta = {
      modelID: ra.modelID,
      expressID: ra.dbId,
      name: c.name_a ?? '',
      category: c.category_a ?? 'UNKNOWN',
    };
    const bMeta: ElementMeta = {
      modelID: rb.modelID,
      expressID: rb.dbId,
      name: c.name_b ?? '',
      category: c.category_b ?? 'UNKNOWN',
    };
    return {
      id: c.id,
      a: aMeta,
      b: bMeta,
      point: { x: c.point_x ?? 0, y: c.point_y ?? 0, z: c.point_z ?? 0 },
      depth: c.depth ?? 0,
      status: c.status,
      issueId: c.issue_id,
    } satisfies ClashRow;
  });
}

/** 불러온 DB 간섭을 런타임 ClashRow 로 재구성(modelDbId → 런타임 modelID 역매핑). */
export function loadedToRows(
  loaded: LoadedClash[],
  dbIdToRuntime: Map<string, number>,
): ClashRow[] {
  return loaded.map((c) => {
    const aMeta: ElementMeta = {
      modelID: (c.model_a ? dbIdToRuntime.get(c.model_a) : undefined) ?? -1,
      expressID: c.express_a ?? -1,
      name: c.name_a ?? '',
      category: c.category_a ?? 'UNKNOWN',
    };
    const bMeta: ElementMeta = {
      modelID: (c.model_b ? dbIdToRuntime.get(c.model_b) : undefined) ?? -1,
      expressID: c.express_b ?? -1,
      name: c.name_b ?? '',
      category: c.category_b ?? 'UNKNOWN',
    };
    return {
      id: c.id,
      a: aMeta,
      b: bMeta,
      point: { x: c.point_x ?? 0, y: c.point_y ?? 0, z: c.point_z ?? 0 },
      depth: c.depth ?? 0,
      status: c.status,
      issueId: c.issue_id,
    } satisfies ClashRow;
  });
}
