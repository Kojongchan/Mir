// 기존(수량산출서·내역) ↔ BIM 물량 대사(5번, 10-27 "기존과 빔과 차이도 보기로 했고"). 수량분개로 작업에 나눈 이 대상의 설계 수량을
// 같은 작업에 연결된 모델 객체의 수량과 맞댄다:
//   - 콘크리트(m³): 부위(교대·교각 기초·교각·코핑·상판·공동구)별 — 모델 체적 속성, 없으면 형상에서 계산한 체적(build-model-volumes)
//   - 개수(본): WPC 거더(길이별), 말뚝(PHC·강관 — 이름으로)
// 객체 → 작업: 6단계 저장 연결(외부 ID·IfcGUID) → 모델의 IPS 코드(A3)가 공정표에 있으면 그것. 차이 ±3% 초과는 오차 보고서 대상(types.QTY_TOLERANCE).
import { GROUP_LABEL, type Group, type SplitResult } from './qtySplit.js';
import type { LinkSet } from './setup';
import type { QtyRow } from './types';

export interface ModelQtyObject {
  id: string | number;
  ext?: string;
  ifcGuid?: string;
  code?: string;
  name?: string;
  type?: string;
  label?: string;
  ifcClass?: string;
  volume?: number | null;
}

const CONCRETE = /콘크리트/;
const NOT_STRUCTURE = /무근|바닥|버림|채움|기초콘크리트|필터|무수축/;
const lengthOf = (s: string) => /(\d+(?:\.\d+)?)\s*m\b/i.exec(s)?.[1] ?? null;

/** 객체마다 걸린 작업 코드(저장 연결 우선, 없으면 모델 코드가 공정표에 있을 때). */
export function objectCodes(objects: ModelQtyObject[], links: LinkSet['links'], codes: ReadonlySet<string>): Map<ModelQtyObject, string> {
  const saved = new Map<string, string>();
  for (const l of links) { if (l.ifcGuid) saved.set(`g:${l.ifcGuid}`, l.code); if (l.ext) saved.set(`e:${l.ext}`, l.code); }
  const out = new Map<ModelQtyObject, string>();
  for (const o of objects) {
    const c = (o.ifcGuid && saved.get(`g:${o.ifcGuid}`)) || (o.ext && saved.get(`e:${o.ext}`)) || (o.code && codes.has(o.code) ? o.code : null);
    if (c) out.set(o, c);
  }
  return out;
}

/** 수량분개 결과 ↔ 모델 객체 수량. 모델 쪽 값이 없으면(체적 미계산) modelQty = null. */
export function compareWithModel(r: SplitResult, objects: ModelQtyObject[], links: LinkSet['links'], codes: ReadonlySet<string>): QtyRow[] {
  const linked = objectCodes(objects, links, codes);
  const byCode = new Map<string, ModelQtyObject[]>();
  for (const [o, c] of linked) (byCode.get(c) ?? byCode.set(c, []).get(c)!).push(o);
  const rows: QtyRow[] = [];

  // 콘크리트: 부위별 설계(배분된 구조 콘크리트) ↔ 같은 작업들에 걸린 객체 체적
  const design = new Map<Group, { qty: number; codes: Set<string> }>();
  for (const l of r.lines) {
    if (l.unit.toLowerCase() !== 'm3' || !CONCRETE.test(l.name) || NOT_STRUCTURE.test(`${l.name} ${l.spec}`)) continue;
    for (const a of l.alloc) {
      const d = design.get(a.group) ?? { qty: 0, codes: new Set<string>() };
      d.qty += a.qty; d.codes.add(a.code);
      design.set(a.group, d);
    }
  }
  for (const [g, d] of design) {
    const objs = [...d.codes].flatMap(c => byCode.get(c) ?? []);
    const vols = objs.map(o => o.volume).filter((v): v is number => v != null);
    rows.push({ key: `concrete|${g}`, group: GROUP_LABEL[g], item: '구조 콘크리트', unit: 'm3', sheetQty: round(d.qty),
      modelQty: objs.length && vols.length === objs.length ? round(vols.reduce((s, v) => s + v, 0)) : null, objects: [],
      note: !objs.length ? '연결된 객체 없음' : vols.length < objs.length ? `체적 없는 객체 ${objs.length - vols.length}/${objs.length} — 형상 체적 계산(model-volumes) 필요` : `객체 ${objs.length}` });
  }

  // WPC 거더 개수(길이별): 내역 'WPC… 제작 및 가설 L=40.0m' ↔ 보 객체(가로보 제외)
  const girders = [...linked.keys()].filter(o => /WPC/i.test(`${o.name} ${o.type}`) && !/가로보/.test(`${o.name} ${o.type}`) && (!o.ifcClass || /Beam/i.test(o.ifcClass)));
  const wpc = new Map<string, number>();
  for (const l of r.lines) if (/WPC/i.test(l.name) && l.unit === '본') { const len = lengthOf(l.spec); if (len) wpc.set(String(Number(len)), (wpc.get(String(Number(len))) ?? 0) + l.targetQty); }
  for (const [len, qty] of wpc) {
    const n = girders.filter(o => { const m = lengthOf(`${o.type} ${o.name}`.replace(/_/g, ' ')); return m && String(Number(m)) === len; }).length;
    rows.push({ key: `wpc|${len}`, group: GROUP_LABEL.girder, item: `WPC 거더 L=${len}m`, unit: '본', sheetQty: round(qty), modelQty: n, objects: [], note: '모델: 보 객체(가로보 제외) 수' });
  }

  // 말뚝 개수: PHC·강관(이름에 종류가 있는 말뚝 객체)
  for (const [kind, re] of [['PHC 말뚝', /PHC/i], ['강관 말뚝', /강관/]] as const) {
    const qty = r.lines.filter(l => /두부보강|두부정리/.test(l.name) && re.test(`${l.name} ${l.spec}`) && l.unit === '본').reduce((s, l) => s + l.targetQty, 0);
    if (!qty) continue;
    const n = [...linked.keys()].filter(o => /말뚝|파일|pile/i.test(`${o.label} ${o.name} ${o.type}`) && re.test(`${o.label} ${o.name} ${o.type}`)).length;
    rows.push({ key: `pile|${kind}`, group: GROUP_LABEL.pierFoundation, item: kind, unit: '본', sheetQty: round(qty), modelQty: n || null, objects: [],
      note: n ? '모델: 이름에 종류가 있는 말뚝 객체 수' : '모델 객체 이름에 말뚝 종류가 없음' });
  }
  return rows;
}

const round = (v: number) => Math.round(v * 1000) / 1000;
