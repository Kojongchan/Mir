import { supabase } from './supabase';

// =====================================================================
// R8 — 통합검색(Cmd+K) 데이터층.
// 여러 모듈(이슈·RFI·Punch·회의록·제출물·도면·파일)에서 경량 인덱스를 모아
// 클라이언트에서 퍼지 매칭한다. 신규 테이블 없음(각 테이블 조회). 외부 의존 0
// (Fuse.js 없이 경량 subsequence 스코어러 자체 구현 — 무비용).
// =====================================================================

export type SearchKind = 'issue' | 'rfi' | 'punch' | 'meeting' | 'submittal' | 'drawing' | 'file';

export interface SearchItem {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle?: string;
  /** 이동 경로. */
  to: string;
  /** 라우터 state(상세 펼치기용). */
  state?: Record<string, unknown>;
}

export const KIND_LABEL: Record<SearchKind, string> = {
  issue: '이슈',
  rfi: 'RFI',
  punch: 'Punch',
  meeting: '회의록',
  submittal: '제출물',
  drawing: '도면',
  file: '파일',
};

export const KIND_ICON: Record<SearchKind, string> = {
  issue: 'issue',
  rfi: 'rfi',
  punch: 'punch',
  meeting: 'meeting',
  submittal: 'submittal',
  drawing: 'drawing',
  file: 'files',
};

/**
 * 프로젝트의 검색 인덱스를 병렬 로드한다. 각 소스는 실패해도(마이그 미적용 등)
 * 빈 배열로 폴백해 나머지 검색은 동작한다. 성능을 위해 각 테이블 상한을 둔다.
 */
export async function loadSearchIndex(projectId: string): Promise<SearchItem[]> {
  const base = `/project/${projectId}`;
  // 각 소스는 실패해도 [] 폴백(마이그 미적용/권한 등) — 나머지 검색은 동작.
  const sel = async (table: string, cols: string): Promise<any[]> => {
    try {
      const { data } = await supabase.from(table).select(cols).eq('project_id', projectId).limit(500);
      return data ?? [];
    } catch {
      return [];
    }
  };
  const [issues, rfis, punches, meetings, submittals, drawings, files] = await Promise.all([
    sel('issues', 'id, title, status'),
    sel('rfi', 'id, rfi_no, title, from_party'),
    sel('punch', 'id, punch_no, title, location_desc'),
    sel('meeting', 'id, title, meeting_date'),
    sel('submittal', 'id, submittal_no, title, status'),
    sel('drawings', 'id, name'),
    sel('files', 'id, name, status'),
  ]);

  const items: SearchItem[] = [];
  for (const it of issues as any[]) items.push({ kind: 'issue', id: it.id, title: it.title, subtitle: it.status, to: `${base}/issues`, state: { focusIssueId: it.id } });
  for (const it of rfis as any[]) items.push({ kind: 'rfi', id: it.id, title: `#${it.rfi_no} ${it.title}`, subtitle: it.from_party ?? undefined, to: `${base}/rfi`, state: { focusRfiId: it.id } });
  for (const it of punches as any[]) items.push({ kind: 'punch', id: it.id, title: `#${it.punch_no} ${it.title}`, subtitle: it.location_desc ?? undefined, to: `${base}/punch`, state: { focusPunchId: it.id } });
  for (const it of meetings as any[]) items.push({ kind: 'meeting', id: it.id, title: it.title, subtitle: it.meeting_date, to: `${base}/meetings` });
  for (const it of submittals as any[]) items.push({ kind: 'submittal', id: it.id, title: `#${it.submittal_no} ${it.title}`, subtitle: it.status, to: `${base}/submittals` });
  for (const it of drawings as any[]) items.push({ kind: 'drawing', id: it.id, title: it.name, to: `${base}/drawings` });
  for (const it of files as any[]) items.push({ kind: 'file', id: it.id, title: it.name, subtitle: it.status ?? undefined, to: `/view/${it.id}` });
  return items;
}

/**
 * 경량 퍼지 스코어러. query 의 각 문자가 순서대로 text 에 나타나는지(subsequence)
 * 확인하고, 연속 매치·단어경계·앞쪽 매치에 가산점을 준다. 매치 실패 시 -1.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  // 부분문자열 완전 포함은 강한 가산.
  const sub = t.indexOf(q);
  let score = 0;
  if (sub >= 0) score += 100 - sub + q.length * 2;

  let ti = 0;
  let streak = 0;
  let matched = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    let found = -1;
    for (let k = ti; k < t.length; k++) {
      if (t[k] === c) {
        found = k;
        break;
      }
    }
    if (found < 0) return sub >= 0 ? score : -1; // subsequence 실패
    if (found === ti) streak++;
    else streak = 0;
    score += 5 + streak * 3 + (found === 0 || t[found - 1] === ' ' ? 4 : 0);
    matched++;
    ti = found + 1;
  }
  return matched === q.length ? score : -1;
}

export interface RankedItem extends SearchItem {
  score: number;
}

export function rankItems(items: SearchItem[], query: string, limit = 30): RankedItem[] {
  const q = query.trim();
  if (!q) return items.slice(0, limit).map((it) => ({ ...it, score: 0 }));
  const scored: RankedItem[] = [];
  for (const it of items) {
    const s = Math.max(fuzzyScore(q, it.title), it.subtitle ? fuzzyScore(q, it.subtitle) - 10 : -1);
    if (s >= 0) scored.push({ ...it, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
