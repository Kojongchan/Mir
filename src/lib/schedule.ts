// 4D 일정(공정표) 파싱 — Navisworks / Fuzor TimeLiner CSV 내보내기를 모두 지원.
//
// 두 포맷 모두 헤더 기반으로 컬럼을 찾으므로(영문/한글), 한 파서로 처리한다.
//  - Navisworks: 한글 헤더(EUC-KR 인코딩), 날짜 "2015-06-01", 동기화 ID 컬럼.
//  - Fuzor:      영문 헤더(UTF-8),        날짜 ISO "2025-01-01T00:00:00", Fuzor GUID.
//
// IFC 객체와의 정밀 매핑(동기화 ID/GUID ↔ 모델 요소)은 추후 과제이며, 지금은
// 일정만 추출한다. 매핑은 src/lib/fourd.ts 에서 이름/순서 기반으로 처리한다.

export interface ScheduleTask {
  /** 안정적인 작업 식별자(원본 ID 컬럼이 있으면 사용, 없으면 생성) */
  id: string;
  /** 표시용 이름 */
  name: string;
  /** 정규화된 작업 유형 라벨(예: 시공/철거/장비/임시) */
  type: TaskKind;
  /** 원본 작업 유형 문자열(진단용) */
  rawType: string;
  /** 시작 시각(epoch ms) */
  start: number;
  /** 종료 시각(epoch ms) */
  end: number;
  /** 동기화 ID / GUID 등 외부 식별자(추후 정밀 매핑용, 없으면 null) */
  externalId: string | null;
}

export type TaskKind = 'construct' | 'demolish' | 'equipment' | 'temporary' | 'other';

export type ScheduleSource = 'navisworks' | 'fuzor' | 'generic';

export interface ParsedSchedule {
  tasks: ScheduleTask[];
  source: ScheduleSource;
  /** 전체 일정의 최소 시작 시각 */
  start: number;
  /** 전체 일정의 최대 종료 시각 */
  end: number;
  warnings: string[];
}

// --- 텍스트 디코딩 -------------------------------------------------------

/**
 * CSV 바이트를 문자열로 디코딩. 먼저 UTF-8 로 시도하고, 치환문자(U+FFFD)가
 * 섞이면 한국어 Windows 기본 인코딩(EUC-KR/CP949)으로 재시도한다.
 * (Navisworks 한글 내보내기가 EUC-KR 이기 때문.)
 */
export function decodeCsvBytes(bytes: Uint8Array): string {
  // UTF-8 BOM 제거
  let buf = bytes;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    buf = buf.subarray(3);
  }
  const utf8 = new TextDecoder('utf-8').decode(buf);
  if (!utf8.includes('�')) return utf8;
  try {
    const euckr = new TextDecoder('euc-kr').decode(buf);
    // 재디코딩 결과가 더 깨끗하면(치환문자 적으면) 채택
    if (!euckr.includes('�')) return euckr;
    return countChar(euckr, '�') < countChar(utf8, '�') ? euckr : utf8;
  } catch {
    return utf8; // 환경에 euc-kr 디코더가 없으면 UTF-8 폴백
  }
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++;
  return n;
}

// --- CSV 파싱 ------------------------------------------------------------

/** 따옴표/개행을 처리하는 최소 CSV 파서. 행 배열의 배열을 반환. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// --- 컬럼 매핑 -----------------------------------------------------------

// 우선순위 순서대로 매칭(앞쪽이 우선). 한글/영문 헤더 모두 대응.
const NAME_KEYS = ['name', '이름'];
const START_KEYS = ['planned start', '계획된 시작', 'main start', 'actual start', '실제 시작', 'start', '시작'];
const END_KEYS = ['planned end', '계획된 끝', 'main end', 'actual end', '실제 끝', 'end', '끝'];
const TYPE_KEYS = ['task type', '작업 유형', 'type'];
const ID_KEYS = ['id'];
const EXTID_KEYS = ['fuzor guid', 'unique id', '동기화 id', '표시 id'];

function findIndex(header: string[], keys: string[]): number {
  const norm = header.map((h) => h.trim().toLowerCase());
  for (const key of keys) {
    const i = norm.indexOf(key);
    if (i >= 0) return i;
  }
  return -1;
}

function normalizeKind(raw: string): TaskKind {
  const t = raw.trim().toLowerCase();
  if (!t) return 'other';
  if (t.startsWith('construct') || t.includes('시공')) return 'construct';
  if (t.startsWith('demolish') || t.includes('철거') || t.includes('해체')) return 'demolish';
  if (t.startsWith('equipment') || t.includes('장비')) return 'equipment';
  if (t.startsWith('temporary') || t.includes('임시')) return 'temporary';
  return 'other';
}

function parseDate(raw: string): number {
  const s = raw.trim();
  if (!s) return NaN;
  const t = Date.parse(s);
  return Number.isNaN(t) ? NaN : t;
}

function detectSource(header: string[]): ScheduleSource {
  const norm = header.map((h) => h.trim().toLowerCase());
  if (norm.some((h) => h === 'fuzor guid' || h === 'fuzor id' || h === 'task source')) return 'fuzor';
  if (norm.some((h) => h === '동기화 id' || h === '계획된 시작' || h === '이름')) return 'navisworks';
  return 'generic';
}

/**
 * CSV 텍스트를 일정으로 파싱. 유효한 시작/종료 날짜가 없는 행, 루트(합계) 행은
 * 건너뛴다. 매핑되지 않은 행 수 등은 warnings 로 보고한다.
 */
export function parseSchedule(text: string): ParsedSchedule {
  const warnings: string[] = [];
  const rows = parseCsvRows(text).filter((r) => r.some((c) => c.trim() !== ''));
  if (rows.length < 2) {
    return { tasks: [], source: 'generic', start: NaN, end: NaN, warnings: ['빈 파일이거나 헤더만 있습니다.'] };
  }

  const header = rows[0];
  const source = detectSource(header);
  const iName = findIndex(header, NAME_KEYS);
  const iStart = findIndex(header, START_KEYS);
  const iEnd = findIndex(header, END_KEYS);
  const iType = findIndex(header, TYPE_KEYS);
  const iId = findIndex(header, ID_KEYS);
  const iExt = findIndex(header, EXTID_KEYS);

  if (iName < 0) warnings.push('이름 컬럼을 찾지 못했습니다.');
  if (iStart < 0 || iEnd < 0) warnings.push('시작/종료 날짜 컬럼을 찾지 못했습니다.');

  const tasks: ScheduleTask[] = [];
  let skipped = 0;
  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r];
    const name = (iName >= 0 ? cols[iName] : '')?.trim() ?? '';
    const start = parseDate(iStart >= 0 ? cols[iStart] ?? '' : '');
    const end = parseDate(iEnd >= 0 ? cols[iEnd] ?? '' : '');

    // 루트/합계 행과 날짜 없는 행은 제외
    if (!name || /\(root\)/i.test(name) || Number.isNaN(start) || Number.isNaN(end)) {
      skipped++;
      continue;
    }

    const rawType = iType >= 0 ? (cols[iType] ?? '').trim() : '';
    const externalId = iExt >= 0 ? (cols[iExt] ?? '').trim() || null : null;
    const rawId = iId >= 0 ? (cols[iId] ?? '').trim() : '';

    tasks.push({
      id: rawId || externalId || `task-${r}`,
      name,
      type: normalizeKind(rawType),
      rawType,
      start,
      end: Math.max(end, start), // 종료가 시작보다 이르면 보정
      externalId,
    });
  }

  if (skipped > 0) warnings.push(`${skipped}개 행을 건너뜀(루트/날짜 없음).`);

  const starts = tasks.map((t) => t.start);
  const ends = tasks.map((t) => t.end);
  const start = starts.length ? Math.min(...starts) : NaN;
  const end = ends.length ? Math.max(...ends) : NaN;

  return { tasks, source, start, end, warnings };
}

// --- 표시 헬퍼 -----------------------------------------------------------

export const TASK_KIND_LABEL: Record<TaskKind, string> = {
  construct: '시공',
  demolish: '철거',
  equipment: '장비',
  temporary: '임시',
  other: '기타',
};

const DAY = 24 * 60 * 60 * 1000;

/** epoch ms 를 "YYYY-MM-DD" 로 포맷(로컬 타임존). */
export function formatDate(ms: number): string {
  if (Number.isNaN(ms)) return '—';
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export { DAY };
