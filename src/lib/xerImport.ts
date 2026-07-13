// =====================================================================
// Primavera P6 XER(.xer) 임포트 — S(4D 고도화). XER 는 탭 구분 텍스트로 여러
// 테이블(PROJWBS·TASK·TASKPRED …)을 담는다. WBS 계층(PROJWBS)을 개요번호로 펼치고
// 작업(TASK)을 말단 행으로 얹어, 공통 buildSchedule 파이프라인(요약 기간 채우기·
// 마일스톤 판정)을 그대로 재사용한다.
// =====================================================================
import { docFromRows, buildSchedule, type ParsedSchedule, type ColumnMap } from './schedule';

interface XerTable {
  fields: string[];
  rows: string[][];
}

/** XER 텍스트 → 테이블명 → {필드, 행}. */
export function parseXerTables(text: string): Map<string, XerTable> {
  const tables = new Map<string, XerTable>();
  let current: XerTable | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const cells = line.split('\t');
    const tag = cells[0];
    if (tag === '%T') {
      current = { fields: [], rows: [] };
      tables.set(cells[1], current);
    } else if (tag === '%F' && current) {
      current.fields = cells.slice(1);
    } else if (tag === '%R' && current) {
      current.rows.push(cells.slice(1));
    }
  }
  return tables;
}

export function looksLikeXer(text: string): boolean {
  return text.startsWith('ERMHDR') || /^%T\tPROJECT/m.test(text) || /^%T\tTASK/m.test(text);
}

/** 테이블 행을 {필드명: 값} 객체로. */
function rowsAsObjects(t: XerTable | undefined): Record<string, string>[] {
  if (!t) return [];
  return t.rows.map((r) => {
    const o: Record<string, string> = {};
    t.fields.forEach((f, i) => (o[f] = r[i] ?? ''));
    return o;
  });
}

export function parseXer(text: string): ParsedSchedule {
  const tables = parseXerTables(text);
  const wbsRows = rowsAsObjects(tables.get('PROJWBS'));
  const taskRows = rowsAsObjects(tables.get('TASK'));
  const predRows = rowsAsObjects(tables.get('TASKPRED'));
  if (taskRows.length === 0) {
    return { tasks: [], source: 'generic', start: NaN, end: NaN, warnings: ['XER 에서 TASK 테이블을 찾지 못했습니다.'] };
  }

  // --- WBS 트리 → 개요번호 ---
  interface WbsNode { id: string; name: string; parent: string; kids: string[]; outline: string }
  const wbs = new Map<string, WbsNode>();
  for (const w of wbsRows) {
    wbs.set(w.wbs_id, { id: w.wbs_id, name: w.wbs_name || w.wbs_short_name || w.wbs_id, parent: w.parent_wbs_id || '', kids: [], outline: '' });
  }
  const roots: string[] = [];
  for (const node of wbs.values()) {
    if (node.parent && wbs.has(node.parent)) wbs.get(node.parent)!.kids.push(node.id);
    else roots.push(node.id);
  }
  const assign = (id: string, prefix: string) => {
    const node = wbs.get(id);
    if (!node) return;
    node.outline = prefix;
    node.kids.forEach((kid, i) => assign(kid, `${prefix}.${i + 1}`));
  };
  roots.forEach((id, i) => assign(id, String(i + 1)));

  // --- 선후행: task_id → [pred task_id] ---
  const predByTask = new Map<string, string[]>();
  for (const p of predRows) {
    const arr = predByTask.get(p.task_id) ?? [];
    if (p.pred_task_id) arr.push(p.pred_task_id);
    predByTask.set(p.task_id, arr);
  }

  // --- 공통 파이프라인용 행 만들기 ---
  // 열: ID · 작업명 · 유형 · 계획시작 · 계획끝 · 실제시작 · 실제끝 · 진척 · 매칭키 · 개요 · 선행
  const header = ['ID', '작업명', '유형', '계획 시작', '계획 끝', '실제 시작', '실제 끝', '진척률', '매칭키', 'WBS', '선행'];
  const map: ColumnMap = {
    name: 1, type: 2, start: 3, end: 4, actualStart: 5, actualEnd: 6,
    cost: -1, externalId: 8, outline: 9, progress: 7, predecessor: 10,
  };
  const rows: string[][] = [];

  // WBS 요약 행(개요만, 날짜는 buildSchedule 이 자식 범위로 채움).
  for (const node of wbs.values()) {
    if (!node.outline) continue;
    rows.push([node.id, node.name, '', '', '', '', '', '', '', node.outline, '']);
  }

  // 작업(말단) 행 — 소속 WBS 개요 아래 순번을 붙여 트리에 매단다.
  const seqByWbs = new Map<string, number>();
  for (const t of taskRows) {
    const wnode = wbs.get(t.wbs_id);
    const base = wnode?.outline ?? '';
    const seq = (seqByWbs.get(t.wbs_id) ?? 0) + 1;
    seqByWbs.set(t.wbs_id, seq);
    const outline = base ? `${base}.${seq}` : String(seq);
    const isMile = /mile/i.test(t.task_type || '');
    const start = (t.target_start_date || t.early_start_date || '').trim();
    const end = (t.target_end_date || t.early_end_date || '').trim();
    rows.push([
      t.task_id,
      t.task_name || t.task_code || t.task_id,
      isMile ? '마일스톤' : '시공',
      start,
      // 마일스톤은 종료=시작으로 두어 기간 0.
      isMile ? start : end,
      (t.act_start_date || '').trim(),
      (t.act_end_date || '').trim(),
      (t.phys_complete_pct || t.complete_pct || '').trim(),
      t.task_code || '',
      outline,
      (predByTask.get(t.task_id) ?? []).join(';'),
    ]);
  }

  const parsed = buildSchedule(docFromRows([header, ...rows]), map);
  parsed.source = 'generic';
  return parsed;
}
