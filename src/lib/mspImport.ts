// =====================================================================
// MS Project XML(.xml) 임포트 — S(4D 고도화). "진실원본=외부파일" 전제에서
// MS Project 가 내보낸 XML(구조화 포맷)을 흡수해 ParsedSchedule 로 바꾼다.
// 구조가 명확(WBS=OutlineNumber, 기간=Start/Finish, 선후행=PredecessorLink)해
// CSV 처럼 열 매핑 UI 가 필요 없다(직접 파싱).
// =====================================================================
import { parseXml, descendants, childText, children } from './miniXml';
import type { ParsedSchedule, ScheduleTask, TaskKind } from './schedule';

function parseDate(raw: string): number {
  const s = raw.trim();
  if (!s) return NaN;
  const t = Date.parse(s);
  return Number.isNaN(t) ? NaN : t;
}

function normalizeKind(name: string, rawType: string): TaskKind {
  const t = `${rawType} ${name}`.toLowerCase();
  if (t.includes('철거') || t.includes('해체') || t.includes('demolish')) return 'demolish';
  if (t.includes('장비') || t.includes('equipment')) return 'equipment';
  if (t.includes('임시') || t.includes('가시설') || t.includes('temporary')) return 'temporary';
  return 'construct';
}

/** MS Project XML 문자열이 맞는지 가볍게 확인. */
export function looksLikeMsProject(text: string): boolean {
  return /<Project[\s>][\s\S]*<Tasks>/.test(text) || /xmlns="http:\/\/schemas\.microsoft\.com\/project"/.test(text);
}

export function parseMsProject(text: string): ParsedSchedule {
  const warnings: string[] = [];
  const root = parseXml(text);
  const taskNodes = descendants(root, 'Task');
  if (taskNodes.length === 0) {
    return { tasks: [], source: 'generic', start: NaN, end: NaN, warnings: ['MS Project 작업(Task)을 찾지 못했습니다.'] };
  }

  const tasks: ScheduleTask[] = [];
  let skipped = 0;
  for (const t of taskNodes) {
    const name = childText(t, 'Name');
    const uid = childText(t, 'UID') || childText(t, 'ID');
    const outlineLevel = Number(childText(t, 'OutlineLevel') || '0');
    // 프로젝트 요약 행(레벨 0)·이름 없음은 제외.
    if (!name || outlineLevel === 0) {
      skipped++;
      continue;
    }
    const start = parseDate(childText(t, 'Start'));
    const end = parseDate(childText(t, 'Finish'));
    const isSummary = childText(t, 'Summary') === '1';
    if (!isSummary && (Number.isNaN(start) || Number.isNaN(end))) {
      skipped++;
      continue;
    }
    const isMilestone = childText(t, 'Milestone') === '1' || (Number.isFinite(start) && start === end);
    const pct = Number(childText(t, 'PercentComplete') || '0');
    const costRaw = Number(childText(t, 'Cost') || '');
    const preds = children(t, 'PredecessorLink')
      .map((p) => childText(p, 'PredecessorUID'))
      .filter(Boolean);
    const actualStart = parseDate(childText(t, 'ActualStart'));
    const actualEnd = parseDate(childText(t, 'ActualFinish'));

    tasks.push({
      id: uid || `msp-${tasks.length}`,
      name,
      type: normalizeKind(name, ''),
      rawType: '',
      start,
      end: Number.isNaN(end) ? start : Math.max(end, start),
      actualStart: Number.isNaN(actualStart) ? null : actualStart,
      actualEnd: Number.isNaN(actualEnd) ? null : actualEnd,
      // MS Project XML 금액은 1/100 단위 정수. 표시용이라 근사 변환.
      cost: Number.isFinite(costRaw) ? costRaw / 100 : null,
      externalId: childText(t, 'GUID') || uid || null,
      custom: { UID: uid, OutlineLevel: String(outlineLevel) },
      outline: childText(t, 'OutlineNumber') || null,
      isSummary,
      progress: Number.isFinite(pct) ? Math.min(1, Math.max(0, pct / 100)) : null,
      predecessors: preds,
      isMilestone,
    });
  }

  if (skipped) warnings.push(`${skipped}개 행 제외(요약/날짜 없음).`);
  const starts = tasks.map((t) => t.start).filter((n) => !Number.isNaN(n));
  const ends = tasks.map((t) => t.end).filter((n) => !Number.isNaN(n));
  return {
    tasks,
    source: 'generic',
    start: starts.length ? Math.min(...starts) : NaN,
    end: ends.length ? Math.max(...ends) : NaN,
    warnings,
  };
}
