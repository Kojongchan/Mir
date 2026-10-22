// P6 XER 파일 읽기·쓰기 (저수준) — IPS(통합공정표) 왕복의 바탕. docs/IPS_4D5D.md
//
// XER 은 Primavera P6 의 표준 교환 포맷이다. 탭 구분 텍스트이고 구조는 단순하다:
//   ERMHDR <버전> <날짜> ...        머리줄(1줄)
//   %T TABLE                       표 시작
//   %F field1 field2 ...           열 이름
//   %R v1 v2 ...                   행(여러 줄)
//   %E                             파일 끝
// 이 모듈은 표를 해석하지 않고 그대로 보관한다. 모르는 표(자원·비용·기준선 등)도
// 손대지 않고 다시 쓰므로, 우리가 고친 표 외에는 P6 에서 내보낸 그대로 돌아간다.
// 표의 의미(PROJECT·PROJWBS·TASK…)는 schedule.ts 가 다룬다.
//
// 인코딩: 한국어 Windows 의 P6 는 XER 을 ANSI(CP949)로 내보낸다. 읽을 때는 UTF-8 을
// 먼저 시도하고 깨지면 CP949 로, 쓸 때는 기본 CP949(선택 UTF-8)로 인코딩한다.

export interface XerTable {
  name: string;
  fields: string[];
  rows: string[][];
}

export interface XerDoc {
  /** ERMHDR 줄의 탭 구분 값(첫 칸 'ERMHDR' 제외). */
  header: string[];
  tables: XerTable[];
}

export class XerError extends Error {}

/** XER 텍스트를 표 목록으로 해석한다. 줄바꿈은 CRLF·LF 모두 허용. */
export function parseXer(text: string): XerDoc {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const first = lines[0]?.split('\t') ?? [];
  if (first[0] !== 'ERMHDR') throw new XerError('XER 파일이 아닙니다 (첫 줄이 ERMHDR 가 아님)');
  const doc: XerDoc = { header: first.slice(1), tables: [] };
  let table: XerTable | null = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cells = line.split('\t');
    switch (cells[0]) {
      case '%T':
        table = { name: cells[1] ?? '', fields: [], rows: [] };
        doc.tables.push(table);
        break;
      case '%F':
        if (!table) throw new XerError(`${i + 1}행: %T 없이 %F`);
        table.fields = cells.slice(1);
        break;
      case '%R': {
        if (!table) throw new XerError(`${i + 1}행: %T 없이 %R`);
        const row = cells.slice(1);
        // P6 는 끝쪽 빈 칸을 생략하기도 한다 — 열 수에 맞춰 채운다.
        while (row.length < table.fields.length) row.push('');
        table.rows.push(row);
        break;
      }
      case '%E':
        return doc;
      default:
        throw new XerError(`${i + 1}행: 알 수 없는 줄 머리 '${cells[0]}'`);
    }
  }
  return doc; // %E 가 없는 잘린 파일도 읽은 데까지는 쓴다
}

/** 표 목록을 XER 텍스트로 (P6 와 같은 CRLF, 끝에 %E). */
export function serializeXer(doc: XerDoc): string {
  const out: string[] = [['ERMHDR', ...doc.header].join('\t')];
  for (const t of doc.tables) {
    out.push(`%T\t${t.name}`);
    out.push(['%F', ...t.fields].join('\t'));
    for (const r of t.rows) out.push(['%R', ...r.map(clean)].join('\t'));
  }
  out.push('%E');
  return out.join('\r\n') + '\r\n';
}

/** 값 안의 탭·줄바꿈은 XER 구조를 깨므로 공백으로 바꾼다. */
function clean(v: string): string {
  return /[\t\r\n]/.test(v) ? v.replace(/[\t\r\n]+/g, ' ') : v;
}

export function getTable(doc: XerDoc, name: string): XerTable | undefined {
  return doc.tables.find(t => t.name === name);
}

/** 표의 행을 {열이름: 값} 객체로. */
export function records(table: XerTable | undefined): Record<string, string>[] {
  if (!table) return [];
  return table.rows.map(r => {
    const o: Record<string, string> = {};
    table.fields.forEach((f, i) => { o[f] = r[i] ?? ''; });
    return o;
  });
}

/** {열이름: 값} 객체들을 표의 열 순서에 맞춘 행으로. 없는 열은 빈 칸. */
export function toRows(fields: string[], recs: Record<string, string | number | null | undefined>[]): string[][] {
  return recs.map(o => fields.map(f => {
    const v = o[f];
    return v === null || v === undefined ? '' : String(v);
  }));
}

// --- 인코딩 -----------------------------------------------------------------

export type XerEncoding = 'cp949' | 'utf-8';

/** XER 바이트를 문자열로: UTF-8 이 깨지면 CP949(EUC-KR 확장)로 다시 읽는다. */
export function decodeXer(bytes: Uint8Array): { text: string; encoding: XerEncoding } {
  let buf = bytes;
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  if (bom) buf = buf.subarray(3);
  const utf8 = new TextDecoder('utf-8').decode(buf);
  if (bom || !utf8.includes('\uFFFD')) return { text: utf8, encoding: 'utf-8' };
  return { text: new TextDecoder('euc-kr').decode(buf), encoding: 'cp949' };
}

export function encodeXer(text: string, encoding: XerEncoding = 'cp949'): Uint8Array {
  return encoding === 'utf-8' ? new TextEncoder().encode(text) : encodeCp949(text);
}

let cp949Table: Map<number, number> | null = null;

/**
 * 문자 → CP949 2바이트 표. 브라우저에는 CP949 인코더가 없어서, 내장 디코더(WHATWG
 * 'euc-kr' = windows-949)로 가능한 2바이트 조합을 한 번씩 풀어 거꾸로 만든다.
 */
function cp949(): Map<number, number> {
  if (cp949Table) return cp949Table;
  const dec = new TextDecoder('euc-kr');
  const table = new Map<number, number>();
  const pair = new Uint8Array(2);
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x41; trail <= 0xfe; trail++) {
      if ((trail > 0x5a && trail < 0x61) || (trail > 0x7a && trail < 0x81)) continue;
      pair[0] = lead; pair[1] = trail;
      const s = dec.decode(pair);
      if (s.length !== 1 || s === '\uFFFD') continue;
      const code = s.charCodeAt(0);
      if (!table.has(code)) table.set(code, (lead << 8) | trail);
    }
  }
  cp949Table = table;
  return table;
}

/** CP949 로 인코딩. CP949 에 없는 문자는 '?' 로 바꾼다. */
export function encodeCp949(text: string): Uint8Array {
  const table = cp949();
  const out = new Uint8Array(text.length * 2);
  let n = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) { out[n++] = code; continue; }
    const two = table.get(code);
    if (two === undefined) { out[n++] = 0x3f; continue; }
    out[n++] = two >> 8;
    out[n++] = two & 0xff;
  }
  return out.slice(0, n);
}
