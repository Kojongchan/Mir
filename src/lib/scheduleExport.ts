// =====================================================================
// 공정 현황(계획/실적 대비표) 엑셀 export — S(4D 고도화). AC: "실적 입력 시 …
// 현황 엑셀 export". buildStatusRows 는 순수 함수(테스트 가능)로 분리하고,
// exportScheduleStatus 가 xlsx 로 통합문서를 만들어 브라우저 다운로드한다.
// =====================================================================
import { formatDate, type ScheduleTask } from './schedule';
import { TASK_KIND_LABEL } from './schedule';

const DAY = 24 * 60 * 60 * 1000;

export interface StatusRow {
  wbs: string;
  name: string;
  type: string;
  planStart: string;
  planEnd: string;
  actualStart: string;
  actualEnd: string;
  progress: string;
  status: '완료' | '진행' | '예정' | '지연';
  varianceDays: number; // 계획 대비 편차(양수=지연, 음수=단축)
  cost: string;
}

/** 작업 상태(현황): now 기준. 실적이 있으면 실적 우선. */
function statusOf(t: ScheduleTask, now: number): StatusRow['status'] {
  if (t.actualEnd != null) return '완료';
  const started = t.actualStart != null || (Number.isFinite(now) && now >= t.start);
  const doneByPlan = Number.isFinite(now) && now >= t.end && t.actualStart == null && (t.progress ?? 0) >= 1;
  if (doneByPlan) return '완료';
  if (!started) return '예정';
  // 진행 중 — 계획 끝을 지났는데 안 끝났으면 지연.
  if (Number.isFinite(now) && now > t.end) return '지연';
  return '진행';
}

/** 계획 대비 편차(일). 실제 끝>계획 끝, 또는 실제 시작>계획 시작 기준. */
function varianceDays(t: ScheduleTask): number {
  if (t.actualEnd != null) return Math.round((t.actualEnd - t.end) / DAY);
  if (t.actualStart != null) return Math.round((t.actualStart - t.start) / DAY);
  return 0;
}

export function buildStatusRows(tasks: ScheduleTask[], now: number = Date.now()): StatusRow[] {
  return tasks
    .filter((t) => !t.isSummary)
    .map((t) => ({
      wbs: t.outline ?? '',
      name: t.name,
      type: t.isMilestone ? '마일스톤' : TASK_KIND_LABEL[t.type],
      planStart: formatDate(t.start),
      planEnd: formatDate(t.end),
      actualStart: formatDate(t.actualStart ?? null),
      actualEnd: formatDate(t.actualEnd ?? null),
      progress: t.progress != null ? `${Math.round(t.progress * 100)}%` : '—',
      status: statusOf(t, now),
      varianceDays: varianceDays(t),
      cost: t.cost != null ? t.cost.toLocaleString() : '',
    }));
}

const HEADERS: Record<keyof StatusRow, string> = {
  wbs: 'WBS',
  name: '작업명',
  type: '유형',
  planStart: '계획 시작',
  planEnd: '계획 끝',
  actualStart: '실제 시작',
  actualEnd: '실제 끝',
  progress: '진척률',
  status: '상태',
  varianceDays: '편차(일)',
  cost: '비용',
};

/** StatusRow[] → 시트용 AOA(헤더 포함). */
export function statusAoa(rows: StatusRow[]): (string | number)[][] {
  const keys = Object.keys(HEADERS) as (keyof StatusRow)[];
  const head = keys.map((k) => HEADERS[k]);
  const body = rows.map((r) => keys.map((k) => r[k]));
  return [head, ...body];
}

/** 계획/실적 대비표를 .xlsx 로 다운로드(브라우저). xlsx 는 동적 import. */
export async function exportScheduleStatus(tasks: ScheduleTask[], filename = '공정현황.xlsx', now = Date.now()): Promise<void> {
  const XLSX = await import('xlsx');
  const rows = buildStatusRows(tasks, now);
  const ws = XLSX.utils.aoa_to_sheet(statusAoa(rows));
  ws['!cols'] = [
    { wch: 10 }, { wch: 28 }, { wch: 8 }, { wch: 12 }, { wch: 12 },
    { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 14 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '공정현황');
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
