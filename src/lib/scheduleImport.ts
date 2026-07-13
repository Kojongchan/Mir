// =====================================================================
// 공정표 임포트 디스패처 — S(4D 고도화). 파일 확장자/내용으로 포맷을 판별해
// 알맞은 파서로 넘긴다. CSV·Excel 은 열 매핑이 필요하므로 CsvDoc(tabular)을,
// MS Project XML·P6 XER 는 구조가 명확하므로 ParsedSchedule(parsed)을 돌려준다.
// 호출측(Timeline)은 kind 로 분기: tabular → 열 매핑 모달, parsed → 바로 로드.
// =====================================================================
import { readCsv, decodeCsvBytes, type CsvDoc, type ParsedSchedule } from './schedule';
import { readExcel } from './xlsxImport';
import { parseMsProject, looksLikeMsProject } from './mspImport';
import { parseXer, looksLikeXer } from './xerImport';

export type ImportResult =
  | { kind: 'tabular'; doc: CsvDoc; format: 'csv' | 'excel' }
  | { kind: 'parsed'; schedule: ParsedSchedule; format: 'msproject' | 'p6' };

/** 임포트 파일 입력에 걸 accept 목록. */
export const IMPORT_ACCEPT = '.csv,.xlsx,.xls,.xml,.xer';

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** 파일명 + 바이트로 포맷을 판별해 파싱한다. Excel 은 xlsx 동적 로드라 async. */
export async function importScheduleFile(name: string, bytes: Uint8Array): Promise<ImportResult> {
  const ext = extOf(name);
  if (ext === 'xlsx' || ext === 'xls') {
    return { kind: 'tabular', doc: await readExcel(bytes), format: 'excel' };
  }
  if (ext === 'xer') {
    return { kind: 'parsed', schedule: parseXer(decodeCsvBytes(bytes)), format: 'p6' };
  }
  if (ext === 'xml') {
    return { kind: 'parsed', schedule: parseMsProject(decodeCsvBytes(bytes)), format: 'msproject' };
  }
  if (ext === 'csv') {
    return { kind: 'tabular', doc: readCsv(bytes), format: 'csv' };
  }
  // 확장자 불명 — 내용으로 추정.
  const text = decodeCsvBytes(bytes);
  if (looksLikeXer(text)) return { kind: 'parsed', schedule: parseXer(text), format: 'p6' };
  if (looksLikeMsProject(text)) return { kind: 'parsed', schedule: parseMsProject(text), format: 'msproject' };
  return { kind: 'tabular', doc: readCsv(bytes), format: 'csv' };
}

export const FORMAT_LABEL: Record<ImportResult['format'], string> = {
  csv: 'CSV(Navisworks/Fuzor)',
  excel: 'Excel',
  msproject: 'MS Project XML',
  p6: 'Primavera P6 XER',
};
