import type { IssueStatus } from './issues';
import type { IconName } from '../components/icons/Icon';

// =====================================================================
// 이슈 타입 분화 레지스트리 — general·rfi·punch(하자/지적)·safety(안전)·quality(품질).
// 타입별 전용 필드(meta jsonb 저장)·색·아이콘·워크플로우(상태 라벨)를 선언형으로
// 정의해 폼/상세/칸반/엑셀/양식이 전부 이 스키마 하나를 읽는다(0038).
// =====================================================================

export type IssueType = 'general' | 'rfi' | 'punch' | 'safety' | 'quality';

export const ISSUE_TYPES: IssueType[] = ['general', 'rfi', 'punch', 'safety', 'quality'];

export const TYPE_LABEL: Record<IssueType, string> = {
  general: '일반',
  rfi: 'RFI',
  punch: '하자·지적',
  safety: '안전',
  quality: '품질',
};

/** 유형별 커스텀 도메인 아이콘 이름(Icon.tsx). 이모지 대체 — 타입색으로 tint 됨. */
export const TYPE_ICON_NAME: Record<IssueType, IconName> = {
  general: 'issue-general',
  rfi: 'issue-rfi',
  punch: 'issue-punch',
  safety: 'issue-safety',
  quality: 'issue-quality',
};

/** 타입 뱃지 색(라이트/다크 토큰이 없어 뱃지 전용 고정 팔레트 — 배경/글자 쌍). */
export const TYPE_COLOR: Record<IssueType, { bg: string; fg: string }> = {
  general: { bg: 'rgba(100,116,139,0.16)', fg: '#475569' },
  rfi: { bg: 'rgba(37,99,235,0.14)', fg: '#1d4ed8' },
  punch: { bg: 'rgba(217,119,6,0.16)', fg: '#b45309' },
  safety: { bg: 'rgba(220,38,38,0.14)', fg: '#b91c1c' },
  quality: { bg: 'rgba(22,163,74,0.14)', fg: '#15803d' },
};

/** 타입별 전용 필드 선언(meta jsonb 의 키). 폼·상세·엑셀·양식 공용. */
export interface IssueFieldDef {
  key: string;
  label: string;
  kind: 'text' | 'date' | 'select' | 'textarea';
  options?: string[];
  placeholder?: string;
}

export const TYPE_FIELDS: Record<IssueType, IssueFieldDef[]> = {
  general: [],
  rfi: [
    { key: 'to_party', label: '상대처(수신)', kind: 'text', placeholder: '예: 설계사·감리단' },
    { key: 'reply_due', label: '응답기한', kind: 'date' },
    { key: 'answer', label: '응답(회신)', kind: 'textarea', placeholder: '회신 내용을 입력하세요' },
  ],
  punch: [
    { key: 'location', label: '위치', kind: 'text', placeholder: '예: 3층 A구역 기둥 C-12' },
    { key: 'contractor', label: '협력사', kind: 'text', placeholder: '담당 협력사명' },
    { key: 'severity', label: '심각도', kind: 'select', options: ['경미', '보통', '중대'] },
  ],
  safety: [
    { key: 'hazard', label: '위험요소', kind: 'text', placeholder: '예: 개구부 추락 위험' },
    { key: 'measure', label: '조치사항', kind: 'textarea', placeholder: '필요한/완료된 조치' },
  ],
  quality: [
    { key: 'spec_ref', label: '관련 기준·시방', kind: 'text', placeholder: '예: 콘크리트 표준시방서 5.2' },
    { key: 'defect', label: '부적합 내용', kind: 'text', placeholder: '예: 피복두께 부족' },
  ],
};

/**
 * 타입별 워크플로우 — 상태 키(DB)는 공통 5종을 유지하고 타입별로 표시 라벨만
 * 재정의한다(칸반 열·뱃지·엑셀에 그대로 반영, 스키마 변경 없이 타입별 흐름 표현).
 */
export const TYPE_STATUS_LABEL: Partial<Record<IssueType, Partial<Record<IssueStatus, string>>>> = {
  rfi: { open: '질의 등록', in_progress: '회신 대기', resolved: '회신 완료', closed: '종결' },
  punch: { open: '지적 등록', in_progress: '보수 중', resolved: '보수 완료', closed: '확인 종결' },
  safety: { open: '위험 확인', in_progress: '조치 중', resolved: '조치 완료', closed: '종결' },
  quality: { open: '부적합 등록', in_progress: '시정 중', resolved: '시정 완료', closed: '검측 종결' },
};

/** 이슈 타입+상태 → 표시 라벨(타입별 워크플로우 명칭, 없으면 공통 라벨). */
export function statusLabelFor(type: IssueType, status: IssueStatus, fallback: string): string {
  return TYPE_STATUS_LABEL[type]?.[status] ?? fallback;
}

/** meta jsonb 에서 타입 필드 값을 문자열로 읽기(없으면 ''). */
export function metaValue(meta: Record<string, unknown> | null | undefined, key: string): string {
  const v = meta?.[key];
  return v == null ? '' : String(v);
}

/** 타입 필드들을 "라벨: 값" 목록으로 요약(엑셀·양식·카드 표시용). */
export function metaSummary(type: IssueType, meta: Record<string, unknown> | null | undefined): string {
  return TYPE_FIELDS[type]
    .map((f) => ({ f, v: metaValue(meta, f.key) }))
    .filter((x) => x.v)
    .map((x) => `${x.f.label}: ${x.v}`)
    .join(' · ');
}

/** 현장 등록(모바일) 시 사진 GPS·촬영시각 태그 — meta.site 에 저장. */
export interface SiteTag {
  lat: number;
  lng: number;
  accuracy?: number;
  taken_at: string; // ISO
}

export function siteTagOf(meta: Record<string, unknown> | null | undefined): SiteTag | null {
  const s = meta?.site as SiteTag | undefined;
  return s && typeof s.lat === 'number' && typeof s.lng === 'number' ? s : null;
}
