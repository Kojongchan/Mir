// 4D 일정(공정표) 파싱 — Navisworks / Fuzor TimeLiner CSV 내보내기를 모두 지원.
//
// 두 단계로 나뉜다:
//  1) readCsv(bytes): 디코딩 + 행 분해 + 포맷/열 자동추정(ColumnMap guess)
//  2) buildSchedule(doc, columnMap): 사용자가 확정한 열 매핑으로 작업을 생성
// 임포트 UI 가 1)→(열 매핑 모달)→2) 순으로 호출한다. parseSchedule() 는 자동추정
// 으로 한 번에 처리하는 편의 함수(테스트/단순 경로).

export interface ScheduleTask {
  /** 안정적인 작업 식별자(원본 ID 컬럼이 있으면 사용, 없으면 생성) */
  id: string;
  /** 표시용 이름 */
  name: string;
  /** 정규화된 작업 유형 */
  type: TaskKind;
  /** 원본 작업 유형 문자열(진단용) */
  rawType: string;
  /** 계획 시작/종료(epoch ms) — 시뮬레이션 기준 */
  start: number;
  end: number;
  /** 실제 시작/종료(epoch ms, 없으면 null) */
  actualStart: number | null;
  actualEnd: number | null;
  /** 비용(숫자, 없으면 null) */
  cost: number | null;
  /** 동기화 ID / GUID 등 외부 식별자(추후 정밀 매핑용, 없으면 null) */
  externalId: string | null;
  /** 매핑되지 않은 나머지 열(헤더→값) — 테이블의 "사용자 값" 표시용 */
  custom: Record<string, string>;
  /** WBS/개요번호(예 "1.2.3") — 레벨 트리 구성용. 없으면 null(평면). */
  outline: string | null;
  /** 하위 작업을 가진 상위(합계) 행인지 — 매핑·시뮬 대상에서 제외, 트리 헤더로만 표시. */
  isSummary: boolean;
  /** 진척률(0..1). 없으면 null. 엑셀/MS Project(%Complete)/P6(phys_complete) 흡수. */
  progress?: number | null;
  /** 선행 작업 id 목록(선후행). 없으면 빈 배열. */
  predecessors?: string[];
  /** 마일스톤(기간 0 = 시작==끝) 여부 — 마일스톤 뷰·간트 다이아몬드 표시용. */
  isMilestone?: boolean;
}

export type TaskKind = 'construct' | 'demolish' | 'equipment' | 'temporary' | 'other';

export type ScheduleSource = 'navisworks' | 'fuzor' | 'generic';

/** 각 역할에 매핑된 열 인덱스(-1 = 없음) */
export interface ColumnMap {
  name: number;
  type: number;
  start: number;
  end: number;
  actualStart: number;
  actualEnd: number;
  cost: number;
  externalId: number;
  outline: number;
  progress: number;
  predecessor: number;
}

/** readCsv 결과: 헤더/행 + 포맷·열 자동추정 */
export interface CsvDoc {
  header: string[];
  rows: string[][];
  source: ScheduleSource;
  guess: ColumnMap;
}

/** 임포트 열 매핑 모달에 표시할 역할 목록 */
export const COLUMN_ROLES: { key: keyof ColumnMap; label: string; required?: boolean }[] = [
  { key: 'name', label: '작업 이름', required: true },
  { key: 'type', label: '작업 유형' },
  { key: 'start', label: '계획 시작 날짜', required: true },
  { key: 'end', label: '계획 끝 날짜', required: true },
  { key: 'actualStart', label: '실제 시작 날짜' },
  { key: 'actualEnd', label: '실제 끝 날짜' },
  { key: 'cost', label: '비용' },
  { key: 'externalId', label: '동기화 ID / GUID (매칭키)' },
  { key: 'outline', label: '개요 번호(WBS 계층)' },
  { key: 'progress', label: '진척률(%)' },
  { key: 'predecessor', label: '선행 작업' },
];

export interface ParsedSchedule {
  tasks: ScheduleTask[];
  source: ScheduleSource;
  start: number;
  end: number;
  warnings: string[];
}

// --- 텍스트 디코딩 -------------------------------------------------------

/**
 * CSV 바이트를 문자열로 디코딩. 먼저 UTF-8 로 시도하고, 치환문자(U+FFFD)가
 * 섞이면 한국어 Windows 기본 인코딩(EUC-KR/CP949)으로 재시도한다.
 */
export function decodeCsvBytes(bytes: Uint8Array): string {
  let buf = bytes;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    buf = buf.subarray(3); // UTF-8 BOM 제거
  }
  const utf8 = new TextDecoder('utf-8').decode(buf);
  if (!utf8.includes('�')) return utf8;
  try {
    const euckr = new TextDecoder('euc-kr').decode(buf);
    if (!euckr.includes('�')) return euckr;
    return countChar(euckr, '�') < countChar(utf8, '�') ? euckr : utf8;
  } catch {
    return utf8;
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

// --- 컬럼 추정 -----------------------------------------------------------

const NAME_KEYS = ['name', '이름', '작업명', '작업 이름', '공정명', 'task name', 'activity name', 'activity'];
const START_KEYS = ['planned start', '계획된 시작', '계획 시작', '계획시작', 'main start', 'start', '시작', 'start date'];
const END_KEYS = ['planned end', '계획된 끝', '계획 끝', '계획끝', '계획 종료', 'main end', 'finish', 'end', '끝', '종료', 'end date'];
const ASTART_KEYS = ['actual start', '실제 시작', '실제시작', '실제 착수'];
const AEND_KEYS = ['actual end', 'actual finish', '실제 끝', '실제끝', '실제 종료', '실제 완료'];
const TYPE_KEYS = ['task type', '작업 유형', '유형', 'type'];
const COST_KEYS = ['planned total cost', 'main total cost', 'total cost', '비용 합계', '총 비용', '총비용', '재료비'];
const ID_KEYS = ['id'];
const EXTID_KEYS = ['fuzor guid', 'unique id', '동기화 id', '표시 id', 'guid', '매칭키', 'match key'];
const OUTLINE_KEYS = ['outlinenumber', 'outline number', 'wbs', 'wbs code', 'wbs 코드'];
const PROGRESS_KEYS = ['% complete', 'percent complete', '진척률', '진척', '진도율', 'progress', 'complete'];
const PRED_KEYS = ['predecessors', 'predecessor', '선행', '선행작업', '선행 작업'];

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

function parseDate(raw: string | undefined): number {
  const s = (raw ?? '').trim();
  if (!s) return NaN;
  const t = Date.parse(s);
  return Number.isNaN(t) ? NaN : t;
}

function parseCost(raw: string | undefined): number | null {
  const s = (raw ?? '').trim().replace(/[, ]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function detectSource(header: string[]): ScheduleSource {
  const norm = header.map((h) => h.trim().toLowerCase());
  if (norm.some((h) => h === 'fuzor guid' || h === 'fuzor id' || h === 'task source')) return 'fuzor';
  if (norm.some((h) => h === '동기화 id' || h === '계획된 시작' || h === '이름')) return 'navisworks';
  return 'generic';
}

function guessColumns(header: string[]): ColumnMap {
  return {
    name: findIndex(header, NAME_KEYS),
    type: findIndex(header, TYPE_KEYS),
    start: findIndex(header, START_KEYS),
    end: findIndex(header, END_KEYS),
    actualStart: findIndex(header, ASTART_KEYS),
    actualEnd: findIndex(header, AEND_KEYS),
    cost: findIndex(header, COST_KEYS),
    externalId: findIndex(header, EXTID_KEYS),
    outline: findIndex(header, OUTLINE_KEYS),
    progress: findIndex(header, PROGRESS_KEYS),
    predecessor: findIndex(header, PRED_KEYS),
  };
}

/** "50%", "0.5", "50" 등 다양한 진척 표기를 0..1 로 정규화. 없으면 null. */
export function parseProgress(raw: string | undefined): number | null {
  const s = (raw ?? '').trim().replace('%', '');
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  // 0..1 로 들어오면 그대로, 그 이상이면 백분율로 간주.
  const v = n > 1 ? n / 100 : n;
  return Math.min(1, Math.max(0, v));
}

/**
 * "3", "3;5", "3FS+2d", "5,7SS-1d" 등 선행 표기에서 선행 작업 번호/코드만 뽑는다.
 * 관계유형(FS/SS/FF/SF)·지연(+2d/-1d)은 떼어낸다.
 */
export function parsePredecessors(raw: string | undefined): string[] {
  const s = (raw ?? '').trim();
  if (!s) return [];
  return s
    .split(/[;,]/)
    .map((p) => p.trim().replace(/(FS|SS|FF|SF).*$/i, '').replace(/[+\-]\s*\d.*$/, '').trim())
    .filter(Boolean);
}

// --- 1) 읽기/추정 --------------------------------------------------------

/** 헤더+행(2차원) → CsvDoc(포맷·열 자동추정). CSV·Excel 임포트가 공통으로 사용. */
export function docFromRows(all: string[][], sourceHint?: ScheduleSource): CsvDoc {
  const rowsAll = all.filter((r) => r.some((c) => (c ?? '').trim() !== ''));
  const header = rowsAll[0] ?? [];
  const rows = rowsAll.slice(1);
  return { header, rows, source: sourceHint ?? detectSource(header), guess: guessColumns(header) };
}

/** 바이트 → 디코딩 + 행 분해 + 포맷/열 자동추정. 임포트 모달이 사용. */
export function readCsv(bytes: Uint8Array): CsvDoc {
  const text = decodeCsvBytes(bytes);
  return docFromRows(parseCsvRows(text));
}

// --- 2) 작업 생성 --------------------------------------------------------

/** 확정된 열 매핑으로 작업을 생성. 루트/합계/날짜 없는 행은 제외. */
export function buildSchedule(doc: CsvDoc, map: ColumnMap): ParsedSchedule {
  const { header, rows, source } = doc;
  const warnings: string[] = [];
  if (map.name < 0) warnings.push('이름 열이 지정되지 않았습니다.');
  if (map.start < 0 || map.end < 0) warnings.push('시작/종료 열이 지정되지 않았습니다.');

  // OutlineNumber 상위(합계) 작업 판별
  const summaryOutlines = new Set<string>();
  if (map.outline >= 0) {
    const outlines = rows.map((c) => (c[map.outline] ?? '').trim()).filter(Boolean);
    for (const o of outlines) {
      if (outlines.some((other) => other !== o && other.startsWith(o + '.'))) summaryOutlines.add(o);
    }
  }

  // id 열(있으면) — 작업 식별자에 사용. ColumnMap 엔 두지 않고 헤더에서 직접 찾는다.
  const idCol = findIndex(header, ID_KEYS);

  // 역할에 쓰인 열(사용자 값에서 제외)
  const usedCols = new Set(Object.values(map).filter((i) => i >= 0));
  if (idCol >= 0) usedCols.add(idCol);

  const tasks: ScheduleTask[] = [];
  let skipped = 0;
  for (let r = 0; r < rows.length; r++) {
    const cols = rows[r];
    const name = (map.name >= 0 ? cols[map.name] : '')?.trim() ?? '';
    const start = parseDate(map.start >= 0 ? cols[map.start] : '');
    const end = parseDate(map.end >= 0 ? cols[map.end] : '');
    const outline = map.outline >= 0 ? (cols[map.outline] ?? '').trim() : '';

    const isSummary = !!outline && summaryOutlines.has(outline);
    // 루트/이름없음은 건너뛴다. 날짜 없는 행은 leaf 만 건너뛰고, 상위(합계) 행은
    // 트리 헤더로 쓰려고 유지한다(날짜는 아래에서 자식 범위로 채운다).
    if (!name || /\(root\)/i.test(name)) {
      skipped++;
      continue;
    }
    if (!isSummary && (Number.isNaN(start) || Number.isNaN(end))) {
      skipped++;
      continue;
    }

    const rawType = map.type >= 0 ? (cols[map.type] ?? '').trim() : '';
    const externalId = map.externalId >= 0 ? (cols[map.externalId] ?? '').trim() || null : null;
    const rawId = idCol >= 0 ? (cols[idCol] ?? '').trim() : '';

    const custom: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) {
      if (usedCols.has(c)) continue;
      const v = (cols[c] ?? '').trim();
      const key = (header[c] ?? `열${c + 1}`).trim();
      if (v && key) custom[key] = v;
    }

    const safeEnd = Math.max(end, start);
    tasks.push({
      id: rawId || externalId || `task-${r}`,
      name,
      type: normalizeKind(rawType),
      rawType,
      start,
      end: safeEnd,
      actualStart: nullIfNaN(parseDate(map.actualStart >= 0 ? cols[map.actualStart] : '')),
      actualEnd: nullIfNaN(parseDate(map.actualEnd >= 0 ? cols[map.actualEnd] : '')),
      cost: map.cost >= 0 ? parseCost(cols[map.cost]) : null,
      externalId,
      custom,
      outline: outline || null,
      isSummary,
      progress: map.progress >= 0 ? parseProgress(cols[map.progress]) : null,
      predecessors: map.predecessor >= 0 ? parsePredecessors(cols[map.predecessor]) : [],
      // 마일스톤: 기간 0(시작==끝)인 말단 작업.
      isMilestone: !isSummary && Number.isFinite(start) && safeEnd === start,
    });
  }

  if (skipped > 0) warnings.push(`${skipped}개 행을 건너뜀(루트/이름·날짜 없는 말단).`);

  // 상위(합계) 행의 기간을 자식(개요번호 접두어가 일치하는 하위) 범위로 채운다 —
  // 날짜가 비어 있어도 간트 막대/트리 헤더가 자식 전체 기간을 덮도록(엑셀 요약행과 동일).
  for (const t of tasks) {
    if (!t.isSummary || !t.outline) continue;
    const prefix = t.outline + '.';
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of tasks) {
      if (c === t || c.isSummary || !c.outline || !c.outline.startsWith(prefix)) continue;
      if (!Number.isNaN(c.start)) lo = Math.min(lo, c.start);
      if (!Number.isNaN(c.end)) hi = Math.max(hi, c.end);
    }
    // 자식 범위가 있으면 그것으로, 없으면(또는 원본 날짜가 있으면) 원본 유지.
    if (Number.isFinite(lo)) t.start = Number.isNaN(t.start) ? lo : Math.min(t.start, lo);
    if (Number.isFinite(hi)) t.end = Number.isNaN(t.end) ? hi : Math.max(t.end, hi);
  }

  const starts = tasks.map((t) => t.start).filter((n) => !Number.isNaN(n));
  const ends = tasks.map((t) => t.end).filter((n) => !Number.isNaN(n));
  return {
    tasks,
    source,
    start: starts.length ? Math.min(...starts) : NaN,
    end: ends.length ? Math.max(...ends) : NaN,
    warnings,
  };
}

function nullIfNaN(n: number): number | null {
  return Number.isNaN(n) ? null : n;
}

/** 자동추정으로 한 번에 파싱(테스트/단순 경로). */
export function parseSchedule(text: string): ParsedSchedule {
  const doc = readCsv(new TextEncoder().encode(text));
  return buildSchedule(doc, doc.guess);
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

export function formatDate(ms: number | null): string {
  if (ms == null || Number.isNaN(ms)) return '—';
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export { DAY };
