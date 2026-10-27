// 기존(수량산출서·내역) ↔ BIM 물량 대사(5번, 10-27 "기존과 빔과 차이도 보기로 했고"). 수량분개로 작업에 나눈 이 대상의 설계 수량을
// 같은 작업에 연결된 모델 객체의 수량과 맞댄다:
//   - 콘크리트(m³): 부위(교대·교각 기초·교각·코핑·상판·공동구)별 — 모델 체적 속성, 없으면 형상에서 계산한 체적(build-model-volumes)
//   - 개수(본): WPC 거더(길이별), 말뚝(부위별 — 종류는 근거에 적고 맞추지 않는다: 연제교 P2 는 집계표 PHC·모델 강관으로 이름이 다름)
// 객체 → 작업: 6단계 저장 연결(외부 ID·IfcGUID) → 모델의 IPS 코드(A3)가 공정표에 있으면 그것. 차이 ±3% 초과는 오차 보고서 대상(types.QTY_TOLERANCE).
import { GROUP_LABEL, type Group, type SplitLine, type SplitResult } from './qtySplit.js';
import type { LinkSet } from './setup';
import { QTY_TOLERANCE, type QtyRow } from './types.js';

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
  /** 속성 체적이 있을 때 형상에서 계산한 체적(검증용). */
  volumeGeometry?: number;
}

/** 대사 한 줄 + 양쪽 근거(차이를 설명할 때 본다 — 화면 표에는 note 만). */
export interface QtyCompareRow extends QtyRow {
  /** 설계: 배분된 내역 항목(큰 것부터 8개). */
  designLines?: { id: string; name: string; spec: string; qty: number }[];
  /** 모델: 객체 이름(숫자 → #)별 개수·수량(큰 것부터 8개). */
  modelTypes?: { name: string; count: number; qty: number }[];
}

const CONCRETE = /콘크리트/;
const NOT_STRUCTURE = /무근|바닥|버림|채움|기초콘크리트|필터|무수축/;
const PILE = /말뚝|파일|pile/i;
/** 사서 박는 말뚝(강관·PHC) — 타설 콘크리트가 아니다. 현장타설말뚝은 콘크리트에 든다. */
const BOUGHT_PILE = /강관|PHC|기성/i;
const lengthOf = (s: string) => /(\d+(?:\.\d+)?)\s*m\b/i.exec(s)?.[1] ?? null;
const text = (o: ModelQtyObject) => `${o.label ?? ''} ${o.name ?? ''} ${o.type ?? ''}`;

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
export function compareWithModel(r: SplitResult, objects: ModelQtyObject[], links: LinkSet['links'], codes: ReadonlySet<string>): QtyCompareRow[] {
  const linked = objectCodes(objects, links, codes);
  const byCode = new Map<string, ModelQtyObject[]>();
  for (const [o, c] of linked) (byCode.get(c) ?? byCode.set(c, []).get(c)!).push(o);
  const rows: QtyCompareRow[] = [];

  // 부위별 설계 수량(배분된 것)과 그 작업들 — 콘크리트·말뚝이 같은 방식
  const designOf = (keep: (l: SplitLine) => boolean) => {
    const out = new Map<Group, { qty: number; codes: Set<string>; lines: Map<SplitLine, number> }>();
    for (const l of r.lines) {
      if (!keep(l)) continue;
      for (const a of l.alloc) {
        const d = out.get(a.group) ?? { qty: 0, codes: new Set<string>(), lines: new Map<SplitLine, number>() };
        d.qty += a.qty; d.codes.add(a.code); d.lines.set(l, (d.lines.get(l) ?? 0) + a.qty);
        out.set(a.group, d);
      }
    }
    return out;
  };
  const designLines = (lines: Map<SplitLine, number>) => [...lines].sort((x, y) => y[1] - x[1]).slice(0, 8)
    .map(([l, q]) => ({ id: l.id, name: l.name, spec: l.spec, qty: round(q) }));
  const modelTypes = (objs: ModelQtyObject[], qty: (o: ModelQtyObject) => number) => {
    const m = new Map<string, { name: string; count: number; qty: number }>();
    for (const o of objs) {
      const name = (o.name || o.type || '?').replace(/\d+(\.\d+)?/g, '#');
      const t = m.get(name) ?? m.set(name, { name, count: 0, qty: 0 }).get(name)!;
      t.count++; t.qty += qty(o);
    }
    return [...m.values()].sort((x, y) => y.qty - x.qty).slice(0, 8).map(t => ({ ...t, qty: round(t.qty) }));
  };

  // 콘크리트: 부위별 설계(배분된 구조 콘크리트) ↔ 같은 작업들에 걸린 객체 체적(강관·PHC 말뚝과 버림은 뺌 — 설계 쪽도 안 셈)
  for (const [g, d] of designOf(l => l.unit.toLowerCase() === 'm3' && CONCRETE.test(l.name) && !NOT_STRUCTURE.test(`${l.name} ${l.spec}`))) {
    const objs = [...d.codes].flatMap(c => byCode.get(c) ?? []).filter(o => !(PILE.test(text(o)) && BOUGHT_PILE.test(text(o))) && !/버림/.test(text(o)));
    const vols = objs.map(o => o.volume).filter((v): v is number => v != null);
    const total = vols.reduce((s, v) => s + v, 0);
    // 속성 체적 검증: 형상 체적이 함께 있는 객체끼리 합을 비교(±3% 넘으면 알림)
    const both = objs.filter(o => o.volume != null && o.volumeGeometry != null);
    const prop = both.reduce((s, o) => s + o.volume!, 0), geom = both.reduce((s, o) => s + o.volumeGeometry!, 0);
    const check = both.length && geom ? ` · 형상 체적 대비 ${pct((prop - geom) / geom)}(객체 ${both.length}/${objs.length})${Math.abs(prop - geom) / geom > QTY_TOLERANCE ? ' 속성 확인' : ''}` : '';
    rows.push({ key: `concrete|${g}`, group: GROUP_LABEL[g], item: '구조 콘크리트', unit: 'm3', sheetQty: round(d.qty),
      modelQty: objs.length && vols.length === objs.length ? round(total) : null, objects: [],
      note: !objs.length ? '연결된 객체 없음' : vols.length < objs.length ? `체적 없는 객체 ${objs.length - vols.length}/${objs.length} — 형상 체적 계산(model-volumes) 필요` : `객체 ${objs.length}${check}`,
      designLines: designLines(d.lines), modelTypes: modelTypes(objs, o => o.volume ?? 0) });
  }

  // WPC 거더 개수(길이별): 내역 'WPC… 제작 및 가설 L=40.0m' ↔ 보 객체(가로보 제외)
  const girders = [...linked.keys()].filter(o => /WPC/i.test(`${o.name} ${o.type}`) && !/가로보/.test(`${o.name} ${o.type}`) && (!o.ifcClass || /Beam/i.test(o.ifcClass)));
  const wpc = new Map<string, number>();
  for (const l of r.lines) if (/WPC/i.test(l.name) && l.unit === '본') { const len = lengthOf(l.spec); if (len) wpc.set(String(Number(len)), (wpc.get(String(Number(len))) ?? 0) + l.targetQty); }
  for (const [len, qty] of wpc) {
    const objs = girders.filter(o => { const m = lengthOf(`${o.type} ${o.name}`.replace(/_/g, ' ')); return m && String(Number(m)) === len; });
    rows.push({ key: `wpc|${len}`, group: GROUP_LABEL.girder, item: `WPC 거더 L=${len}m`, unit: '본', sheetQty: round(qty), modelQty: objs.length, objects: [],
      note: '모델: 보 객체(가로보 제외) 수', modelTypes: modelTypes(objs, () => 1) });
  }

  // 말뚝 본수(부위별): 기성말뚝은 두부보강 본수 ↔ 같은 작업들에 걸린 말뚝 객체, 현장타설말뚝은 두부정리 본수 ↔ 현장타설 말뚝 객체
  // (없으면 기초 객체 — 연제교 IFC 는 교각마다 D3.0m 한 본을 '기초' 로 모델링). 종류(PHC·강관…)가 양쪽에서 다르면 근거에 적는다.
  const kinds = (s: string[]) => [...new Set(s.flatMap(x => x.match(/PHC|강관|현장타설|RCD|SIP/gi) ?? []).map(k => k.toUpperCase()))];
  for (const cast of [false, true]) {
    for (const [g, d] of designOf(l => (cast ? /두부정리/ : /두부보강/).test(l.name) && l.unit === '본')) {
      const near = [...d.codes].flatMap(c => byCode.get(c) ?? []);
      let objs = near.filter(o => PILE.test(text(o)) && (cast ? !BOUGHT_PILE.test(text(o)) : true));
      let basis = '';
      if (cast && !objs.length) { objs = near.filter(o => /기초/.test(text(o)) && !/버림/.test(text(o))); basis = objs.length ? '모델: 기초 객체 수(말뚝을 기초로 모델링)' : ''; }
      const dk = cast ? ['현장타설'] : kinds([...d.lines.keys()].map(l => `${l.name} ${l.spec}`)), mk = cast ? ['현장타설'] : kinds(objs.map(text));
      const same = dk.length === mk.length && dk.every(k => mk.includes(k));
      rows.push({ key: `pile|${g}|${cast ? 'cast' : 'driven'}`, group: GROUP_LABEL[g], item: cast ? '현장타설말뚝 본수' : '기성말뚝 본수', unit: '본',
        sheetQty: round(d.qty), modelQty: objs.length || null, objects: [],
        note: !objs.length ? '같은 작업에 연결된 말뚝 객체 없음'
          : basis || `종류 설계 ${dk.join('·') || '?'} / 모델 ${mk.join('·') || '?'}${same ? '' : ' — 표기 다름(확인)'}`,
        designLines: designLines(d.lines), modelTypes: modelTypes(objs, () => 1) });
    }
  }
  return rows;
}

const round = (v: number) => Math.round(v * 1000) / 1000;
const pct = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
