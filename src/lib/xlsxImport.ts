// =====================================================================
// 엑셀(.xlsx/.xls) 공정표 임포트 — S(4D 고도화). 현장에서 가장 흔한 진실원본.
// 첫 시트를 헤더+행 2차원 배열로 읽어 CSV 와 동일한 CsvDoc 로 만들고, 기존 열
// 매핑 모달(ColumnMapModal)·buildSchedule 을 그대로 재사용한다. 날짜는 표시 형식
// 문자열(raw:false)로 뽑아 parseDate 가 처리하도록 한다.
// =====================================================================
import { docFromRows, type CsvDoc } from './schedule';

// xlsx 는 무겁다(≈수백KB) — 4D 임포트를 실제로 쓸 때만 동적 로드해 초기 번들을 가볍게.
/** 엑셀 바이트 → CsvDoc(헤더+행+열 자동추정). 첫(또는 지정) 시트를 읽는다. */
export async function readExcel(bytes: Uint8Array, sheetName?: string): Promise<CsvDoc> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(bytes, { type: 'array', cellDates: true });
  const name = sheetName && wb.SheetNames.includes(sheetName) ? sheetName : wb.SheetNames[0];
  const ws = wb.Sheets[name];
  if (!ws) return docFromRows([]);
  // header:1 → 행별 배열, raw:false → 날짜/숫자도 표시 형식 문자열로.
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false,
  });
  const asStr = rows.map((r) => (r as unknown[]).map((c) => (c == null ? '' : String(c))));
  return docFromRows(asStr);
}

/** 통합문서의 시트 이름 목록(시트 선택 UI 용). */
export async function excelSheetNames(bytes: Uint8Array): Promise<string[]> {
  try {
    const XLSX = await import('xlsx');
    return XLSX.read(bytes, { type: 'array', bookSheets: true }).SheetNames ?? [];
  } catch {
    return [];
  }
}
