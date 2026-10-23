// 공정·공사비(4D/5D) 단계형 진행(D30) — 단계·자료 칸 정의와 진행 상태 계산(순수 함수, 화면·DB 와 분리).
// 순서는 실제 업무 순서: 설계현황 → AI 개략 IPS → P6 보완 → 확정 IPS 로 BIM 속성 부여 → 4D/5D.
// 자료는 자료관리(ACC) 파일을 가리킨다(파일 자체는 ACC 에, 여기에는 어느 파일인지만).
import type { BridgeSite, CriticalPoint, RateKey, Support } from '../p6/bridgePlan';

export type StepKey = 'target' | 'files' | 'design' | 'draft' | 'p6' | 'link' | 'export' | 'sim' | 'report';

export interface StepDef {
  key: StepKey;
  title: string;
  /** 단계 바에 쓰는 짧은 이름. */
  short: string;
  desc: string;
  /** 이 단계 기능이 화면에 있는가(false = 준비 중, 필요한 자료만 확인). */
  built: boolean;
  /** 이 단계가 쓰는 자료 칸. */
  needs: SlotKey[];
}

export type SlotKey = 'overview' | 'plan' | 'bridgeDesign' | 'qto' | 'qtoSummary' | 'boq' | 'model' | 'ipsStandard' | 'p6';
export type SlotNeed = 'required' | 'recommended' | 'optional';

export interface SlotDef {
  key: SlotKey;
  /** 자료를 고르는 단계. */
  step: StepKey;
  label: string;
  hint: string;
  need: SlotNeed;
  /** 받을 수 있는 확장자(소문자, 점 없이). */
  accept: string[];
  multiple: boolean;
}

export const NEED_LABEL: Record<SlotNeed, string> = { required: '필수', recommended: '권장', optional: '선택' };

const DOCS = ['pdf', 'hwp', 'hwpx', 'doc', 'docx'];
const SHEETS = ['xls', 'xlsx', 'csv'];
const MODELS = ['rvt', 'nwd', 'nwc', 'ifc'];

export const SLOTS: SlotDef[] = [
  { key: 'overview', step: 'files', label: '과업의 개요', hint: '실시설계 보고서 — 사업 범위·구조물 목록', need: 'recommended', accept: DOCS, multiple: false },
  { key: 'plan', step: 'files', label: '시공계획', hint: '실시설계 보고서 — 공법·장비·순서(공기 근거)', need: 'required', accept: DOCS, multiple: false },
  { key: 'bridgeDesign', step: 'files', label: '교량설계', hint: '실시설계 보고서 — 형식·경간 구성', need: 'recommended', accept: DOCS, multiple: false },
  { key: 'qto', step: 'files', label: '수량산출서', hint: '해당 구조물 장(예: 2편 1장 연제교)', need: 'required', accept: [...DOCS, ...SHEETS], multiple: true },
  { key: 'qtoSummary', step: 'files', label: '개소별·자재 집계표', hint: '수량산출서 안에 있으면 생략', need: 'optional', accept: [...DOCS, ...SHEETS], multiple: true },
  { key: 'boq', step: 'files', label: '산출내역서', hint: '5D 공사비(엑셀)', need: 'recommended', accept: SHEETS, multiple: false },
  { key: 'model', step: 'files', label: 'BIM 모델', hint: 'ACC 에 올린 모델(상선·하선처럼 여러 개 가능)', need: 'required', accept: MODELS, multiple: true },
  { key: 'ipsStandard', step: 'files', label: 'IPS 구성 표준·WBS 정의서', hint: '공단 표준(개략 IPS 의 틀)', need: 'recommended', accept: [...DOCS, ...SHEETS, 'pptx'], multiple: true },
  { key: 'p6', step: 'p6', label: '확정 공정표', hint: 'P6 에서 고친 XER(또는 P6 엑셀 내보내기)', need: 'required', accept: ['xer', ...SHEETS], multiple: false },
];

export const STEPS: StepDef[] = [
  { key: 'target', title: '대상 선택', short: '대상', desc: '공정·공사비를 만들 구조물을 고릅니다.', built: true, needs: [] },
  { key: 'files', title: '자료 준비', short: '자료', desc: '필요한 자료를 자료관리에서 고르거나 지금 올립니다.', built: true, needs: ['overview', 'plan', 'bridgeDesign', 'qto', 'qtoSummary', 'boq', 'model', 'ipsStandard'] },
  { key: 'design', title: '설계현황', short: '설계현황', desc: '구조물·개소(A1, P1…, 경간)·말뚝·교각 높이를 표로 만들고 확인합니다(수량산출서에서 AI 로 채우기).', built: true, needs: ['qto', 'qtoSummary', 'bridgeDesign', 'overview'] },
  { key: 'draft', title: 'AI 개략 IPS', short: '개략 IPS', desc: '과업시작일 기준 3안 또는 종료일 맞춤. 공기 = 수량 × 단위공기(출처), 크리티컬 포인트는 제약으로.', built: true, needs: ['qto', 'plan', 'ipsStandard'] },
  { key: 'p6', title: 'P6 보완', short: 'P6 보완', desc: 'P6 에서 고친 공정표를 올려 확정하고, 선후행·구조 순서 역전과 표준 위반을 검토합니다.', built: true, needs: ['p6'] },
  { key: 'link', title: 'BIM 연결', short: 'BIM 연결', desc: '확정 IPS 의 Activity ID 를 객체에 붙입니다(규칙 → 남는 것 AI). 모델의 기존 코드와 비교합니다.', built: true, needs: ['model', 'p6'] },
  { key: 'export', title: '모델 반영', short: '모델 반영', desc: '객체별 속성(IPS 코드·일자)을 모델에 넣을 파일로 내보냅니다.', built: false, needs: ['model', 'p6'] },
  { key: 'sim', title: '4D/5D', short: '4D/5D', desc: '3D 에서 기준일의 시공 상태와 공사비를 봅니다.', built: true, needs: [] },
  { key: 'report', title: '검증·질의', short: '검증', desc: '검토·연결 요약, 작업일보 실적 제안, 내역 분류, 공정·공사비 질의.', built: true, needs: ['p6', 'boq'] },
];

export const slotDef = (key: SlotKey): SlotDef => SLOTS.find(s => s.key === key)!;
export const stepDef = (key: StepKey): StepDef => STEPS.find(s => s.key === key)!;

export interface SetupFile {
  accProjectId: string;
  accItemId: string;
  name: string;
  /** 자료관리 폴더 경로(표시용). */
  folderNames: string[];
  size: number | null;
  pickedAt: string;
  /** 뷰어·속성용 base64 버전 URN(모델 파일). */
  urn?: string;
}

/** 4단계 개략 IPS 설정. */
export interface PlanSettings {
  start: string;
  /** 방식 2 의 과업종료예정일. */
  finish: string;
  mode: 'propose' | 'fit';
  criticalText: string;
  criticalPoints: CriticalPoint[];
  /** 단위공기 중 사용자가 바꾼 값. */
  rates: Partial<Record<RateKey, number>>;
}

/** 6단계 연결 결과(객체 키 = Revit UniqueId(externalId), 뷰어 다리용 IfcGUID 함께). */
export interface LinkSet {
  modelItemId: string;
  wbsRoot: string;
  at: string;
  links: { ext: string; ifcGuid: string; code: string; by: 'rule' | 'ai' | 'human' }[];
}

export type StructureKind = 'bridge' | 'tunnel' | 'earthwork';
export const STRUCTURE_KIND_LABEL: Record<StructureKind, string> = { bridge: '교량', tunnel: '터널', earthwork: '토공' };

/** 대상 하나의 공유 상태(DB). 지금 보는 단계 같은 개인 화면 상태는 넣지 않는다. */
export interface SetupData {
  version: 1;
  kind: StructureKind;
  files: Partial<Record<SlotKey, SetupFile[]>>;
  /** 3단계 설계현황. */
  site?: BridgeSite;
  plan?: PlanSettings;
  links?: LinkSet[];
}

export const emptySetup = (): SetupData => ({ version: 1, kind: 'bridge', files: {} });

export const emptyPlan = (): PlanSettings => ({ start: '', finish: '', mode: 'propose', criticalText: '', criticalPoints: [], rates: {} });

const isSupport = (v: unknown): v is Support => {
  const o = v as Support;
  return !!o && typeof o.id === 'string' && (o.kind === 'abutment' || o.kind === 'pier') && (o.pileType === 'cast' || o.pileType === 'driven')
    && Number.isFinite(o.pileCount);
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** DB/브라우저에서 읽은 값을 안전한 형태로(모르는 칸·깨진 항목은 버림). */
export function normalizeSetup(raw: unknown): SetupData {
  const out = emptySetup();
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  if (r.kind === 'bridge' || r.kind === 'tunnel' || r.kind === 'earthwork') out.kind = r.kind;
  const files = r.files && typeof r.files === 'object' ? (r.files as Record<string, unknown>) : {};
  for (const slot of SLOTS) {
    const list = Array.isArray(files[slot.key]) ? (files[slot.key] as unknown[]) : [];
    const ok: SetupFile[] = [];
    for (const f of list) {
      if (!f || typeof f !== 'object') continue;
      const o = f as Record<string, unknown>;
      if (!str(o.accProjectId) || !str(o.accItemId) || !str(o.name)) continue;
      if (ok.some(x => x.accItemId === o.accItemId)) continue;
      ok.push({
        accProjectId: str(o.accProjectId), accItemId: str(o.accItemId), name: str(o.name),
        folderNames: Array.isArray(o.folderNames) ? o.folderNames.filter((n): n is string => typeof n === 'string') : [],
        size: typeof o.size === 'number' ? o.size : null,
        pickedAt: str(o.pickedAt),
        ...(str(o.urn) ? { urn: str(o.urn) } : {}),
      });
    }
    if (ok.length) out.files[slot.key] = slot.multiple ? ok : ok.slice(-1);
  }
  const site = r.site as BridgeSite | undefined;
  if (site && typeof site.name === 'string' && typeof site.code === 'string' && Array.isArray(site.supports) && Array.isArray(site.spans)
    && site.supports.every(isSupport)) out.site = site;
  const plan = r.plan as PlanSettings | undefined;
  if (plan && typeof plan === 'object') {
    out.plan = {
      ...emptyPlan(), start: str(plan.start), finish: str(plan.finish), mode: plan.mode === 'fit' ? 'fit' : 'propose',
      criticalText: str(plan.criticalText), criticalPoints: Array.isArray(plan.criticalPoints) ? plan.criticalPoints : [],
      rates: plan.rates && typeof plan.rates === 'object' ? plan.rates : {},
    };
  }
  if (Array.isArray(r.links)) out.links = (r.links as LinkSet[]).filter(l => l && typeof l.modelItemId === 'string' && Array.isArray(l.links));
  return out;
}

const extOf = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();

/** 이 칸에 넣을 수 있는 파일인가(확장자). */
export const acceptsFile = (slot: SlotKey, name: string): boolean => slotDef(slot).accept.includes(extOf(name));

/** 파일을 칸에 넣는다: 한 개짜리 칸은 바꾸고, 여러 개 칸은 더한다(같은 파일은 한 번). */
export function addFile(data: SetupData, slot: SlotKey, file: SetupFile): SetupData {
  const def = slotDef(slot);
  const cur = data.files[slot] ?? [];
  const next = def.multiple ? [...cur.filter(f => f.accItemId !== file.accItemId), file] : [file];
  return { ...data, files: { ...data.files, [slot]: next } };
}

export function removeFile(data: SetupData, slot: SlotKey, accItemId: string): SetupData {
  const next = (data.files[slot] ?? []).filter(f => f.accItemId !== accItemId);
  const files = { ...data.files };
  if (next.length) files[slot] = next; else delete files[slot];
  return { ...data, files };
}

export type StepState = 'done' | 'todo' | 'planned';

export interface StepStatus {
  state: StepState;
  /** 아직 고르지 않은 필수 자료. */
  missing: SlotDef[];
  /** 아직 고르지 않은 권장 자료. */
  suggested: SlotDef[];
}

const filled = (data: SetupData, key: SlotKey) => (data.files[key]?.length ?? 0) > 0;

/**
 * 단계 상태: 기능이 없는 단계는 'planned'(필요 자료만 알려줌). 대상은 이름이 있으면, 자료·P6 단계는 필수 자료를
 * 다 고르면 'done'. 4D/5D 는 언제든 열 수 있어 'todo' 로 둔다.
 */
export function stepStatus(data: SetupData, step: StepKey, name: string): StepStatus {
  const def = stepDef(step);
  const slots = def.needs.map(slotDef);
  const missing = slots.filter(s => s.need === 'required' && !filled(data, s.key));
  const suggested = slots.filter(s => s.need === 'recommended' && !filled(data, s.key));
  if (!def.built) return { state: 'planned', missing, suggested };
  if (step === 'target') return { state: name.trim() ? 'done' : 'todo', missing, suggested };
  if (step === 'sim' || step === 'report') return { state: 'todo', missing, suggested };
  if (step === 'design') return { state: data.site ? 'done' : 'todo', missing: [], suggested };
  if (step === 'draft') return { state: data.site && data.plan?.start ? 'done' : 'todo', missing, suggested };
  if (step === 'link') {
    const models = data.files.model ?? [];
    const done = models.length > 0 && models.every(m => data.links?.some(l => l.modelItemId === m.accItemId && l.links.length > 0));
    return { state: done ? 'done' : 'todo', missing, suggested };
  }
  return { state: missing.length ? 'todo' : 'done', missing, suggested };
}
