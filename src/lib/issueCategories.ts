import { supabase } from './supabase';

// =====================================================================
// 이슈 항목(공종·대상 분류) 데이터층 — 0039 issue_category.
// 유형(type)이 업무 성격(RFI/하자/안전/품질)이라면, 항목은 대상 공종/분야
// (토공·교량·터널·가시설·도면·시뮬레이션 …). 현장마다 다르므로 프로젝트별
// 테이블로 관리하고, 기본 세트는 버튼 한 번으로 생성한다.
// RLS: 읽기 = 멤버, 쓰기 = 실무자(is_editor). 0039 미적용이면 목록 = 빈 배열.
// =====================================================================

export interface IssueCategory {
  id: string;
  project_id: string;
  name: string;
  sort_order: number;
}

/** 기본 항목 세트(현장 협의로 확정 전 출발점 — 자유롭게 추가/삭제 가능). */
export const DEFAULT_CATEGORIES = [
  '보고서',
  '토공',
  '교량',
  '터널',
  '가시설',
  '도면',
  '기타 문서',
  '시뮬레이션',
];

const COLS = 'id, project_id, name, sort_order';

export async function listIssueCategories(projectId: string): Promise<IssueCategory[]> {
  const { data, error } = await supabase
    .from('issue_category')
    .select(COLS)
    .eq('project_id', projectId)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
  if (error) return []; // 0039 미적용 폴백 — 항목 UI 만 비어 보인다.
  return (data ?? []) as IssueCategory[];
}

export async function addIssueCategory(projectId: string, name: string, sortOrder: number): Promise<IssueCategory> {
  const { data, error } = await supabase
    .from('issue_category')
    .insert({ project_id: projectId, name: name.trim(), sort_order: sortOrder })
    .select(COLS)
    .single();
  if (error) throw error;
  return data as IssueCategory;
}

export async function renameIssueCategory(id: string, name: string): Promise<void> {
  const { error } = await supabase.from('issue_category').update({ name: name.trim() }).eq('id', id);
  if (error) throw error;
}

/** 항목 삭제 — 연결된 이슈는 FK(on delete set null)로 '미지정'이 된다. */
export async function removeIssueCategory(id: string): Promise<void> {
  const { error } = await supabase.from('issue_category').delete().eq('id', id);
  if (error) throw error;
}

/** 기본 세트 일괄 생성 — 이미 있는 이름은 건너뛴다(unique 제약). */
export async function seedDefaultCategories(projectId: string): Promise<IssueCategory[]> {
  const existing = await listIssueCategories(projectId);
  const have = new Set(existing.map((c) => c.name));
  let order = existing.length ? Math.max(...existing.map((c) => c.sort_order)) + 1 : 0;
  for (const name of DEFAULT_CATEGORIES) {
    if (have.has(name)) continue;
    try {
      await addIssueCategory(projectId, name, order++);
    } catch {
      /* 동시 생성 등 — unique 충돌은 무시 */
    }
  }
  return listIssueCategories(projectId);
}
