// 공정·공사비(4D/5D) 데이터 형태 — 내역·물량·연결. 자료(내역서·수량산출서·IFC) 파서가 이 형태로 채운다.
// 결정 D28: 금액 계산은 코드가, AI 는 내역 ↔ 객체 매칭까지. 금액은 계약 기준·모델 기준을 함께 둔다.

/**
 * 내역 항목의 수량 분류(docs/IPS_4D5D.md 3-6):
 * A 형상에서 바로(콘크리트 체적·강재·말뚝) · B 형상에서 계산(거푸집 면적) · C 모델에 없음(철근·동바리·운반) · D 간접비
 */
export type QtyClass = 'A' | 'B' | 'C' | 'D';

export const QTY_CLASS_LABEL: Record<QtyClass, string> = {
  A: '형상 직접',
  B: '형상 계산',
  C: '모델 없음',
  D: '간접비',
};

/** 공사내역서 한 줄. */
export interface BoqLine {
  id: string;
  /** 공종 계층(예 ['○○교', '하부공', '교각']). */
  path: string[];
  name: string;
  spec: string;
  unit: string;
  qty: number;
  /** 단가 합계(재료비+노무비+경비). */
  unitPrice: number;
  amount: number;
  qtyClass?: QtyClass;
  /** 연결된 객체(dbId)와 배분율 — 배분율 합 1. */
  objects?: { id: number; ratio: number }[];
  /** 연결된 작업(Activity ID, 여러 개면 'n개 작업'). */
  activity?: string;
  /** 수량분개: 내역서 수량(구조물 묶음 전체)과 이 대상 몫의 근거. */
  boqQty?: number;
  basis?: string;
}

/** 수량 대사 한 줄: 객체 묶음(연결 키) × 항목. */
export interface QtyRow {
  /** 연결 키(예 'BR01.P03.COL'). */
  key: string;
  /** 구조물·부위 표시명. */
  group: string;
  item: string;
  unit: string;
  /** 3D 모델 수량(기준). */
  modelQty: number | null;
  /** 수량산출서 수량. */
  sheetQty: number | null;
  objects: number[];
  /** 대사 근거·주의(예 '체적 없는 객체 3/40'). */
  note?: string;
}

/** 작업 ↔ 객체 연결과 그 근거. */
export interface ActivityLink {
  activity: string;
  objects: number[];
  /** 'rule' = 연결 키 규칙, 'ai' = AI 제안(검토 전), 'manual' = 사람이 연결. */
  source: 'rule' | 'ai' | 'manual';
}

/** 대사 판정: 3D 수량 대비 산출서 차이(%). */
export function qtyVariance(row: Pick<QtyRow, 'modelQty' | 'sheetQty'>): number | null {
  if (row.modelQty === null || row.sheetQty === null || row.sheetQty === 0) return null;
  return (row.modelQty - row.sheetQty) / row.sheetQty;
}

/** 오차 허용 범위(±). 넘으면 오차 보고서 대상. */
export const QTY_TOLERANCE = 0.03;
