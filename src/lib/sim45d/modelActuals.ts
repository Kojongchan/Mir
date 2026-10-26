// 모델의 현장 실적(A5_실시공정 시작·종료일)을 공정표 작업의 실적으로(3번 결정 10-26). 개략 IPS 는 새로 만든 계획이라 실적이 비어 있고,
// 올린 P6 도 실적이 모델·현장에만 있는 경우가 많다(IPS_4D5D 8절 3) — 그대로 검토하면 '실적 누락'이 잡음이 된다.
// 객체 → 작업: 6단계에 저장한 연결 → 객체의 모델 코드(A3)가 공정표에 있으면 그것 → (주면) 규칙 연결. 작업의 실적 시작 = 걸린 객체 중 가장
// 이른 실시 시작, 실적 완료 = 모두 끝났을 때 가장 늦은 실시 종료. P6 에 실적이 이미 있는 작업은 건드리지 않는다. 순수 함수 — 화면·AI 연결 공통.
import type { P6Schedule } from '../p6/schedule';
import { autoLink, type LinkActivity } from './autolink.js';
import { ymd } from './modelDates.js';
import type { LinkSet } from './setup';

export interface ActualObject {
  id: string | number;
  ext?: string;
  ifcGuid?: string;
  /** 모델의 A3_WBS CODE (IPS). */
  code?: string;
  label?: string;
  name?: string;
  type?: string;
  comment?: string;
  ifcClass?: string;
  actualStart?: string;
  actualFinish?: string;
}

export interface ActivityActual {
  start: string;
  /** 걸린 객체가 모두 끝났을 때만. */
  finish: string | null;
  objects: number;
  done: number;
}

export interface ModelActuals {
  byCode: Map<string, ActivityActual>;
  /** 실적 날짜가 있는 객체 · 그중 작업에 이어진 객체. */
  dated: number;
  linked: number;
  /** 가장 늦은 실적 날짜(검토 기준일 후보). */
  latest: string | null;
}

/**
 * 객체별 실적 → 작업별 실적. `links`: 6단계 저장 연결, `codes`: 공정표 작업 코드, `rule`: 규칙 연결에 쓸 작업(개략 IPS — 대상 WBS 아래).
 */
export function actualsFromModel(objects: ActualObject[], codes: ReadonlySet<string>, opts: { links?: LinkSet['links']; rule?: LinkActivity[] } = {}): ModelActuals {
  const saved = new Map<string, string>();
  for (const l of opts.links ?? []) { if (l.ifcGuid) saved.set(`g:${l.ifcGuid}`, l.code); if (l.ext) saved.set(`e:${l.ext}`, l.code); }
  const savedCode = (o: ActualObject) => (o.ifcGuid && saved.get(`g:${o.ifcGuid}`)) || (o.ext && saved.get(`e:${o.ext}`)) || null;
  const dated = objects.filter(o => ymd(o.actualStart));
  const ruled = new Map<string, string>();
  if (opts.rule?.length) {
    const open = dated.filter(o => !savedCode(o) && !(o.code && codes.has(o.code)));
    for (const r of autoLink(open.map(o => ({ id: String(o.id), label: o.label || undefined, name: o.name, type: o.type || undefined, comment: o.comment || undefined, ifcClass: o.ifcClass || undefined })), opts.rule)) {
      if (r.code) ruled.set(r.id, r.code);
    }
  }
  const byCode = new Map<string, ActivityActual>();
  let linked = 0, latest: string | null = null;
  for (const o of dated) {
    const code = savedCode(o) ?? (o.code && codes.has(o.code) ? o.code : null) ?? ruled.get(String(o.id)) ?? null;
    if (!code || !codes.has(code)) continue;
    linked++;
    const s = ymd(o.actualStart)!, f = ymd(o.actualFinish);
    const fin = f && f >= s ? f : null;
    for (const d of [s, fin]) if (d && (!latest || d > latest)) latest = d;
    const cur = byCode.get(code);
    if (!cur) { byCode.set(code, { start: s, finish: fin, objects: 1, done: fin ? 1 : 0 }); continue; }
    cur.objects++;
    if (s < cur.start) cur.start = s;
    if (fin) { cur.done++; if (!cur.finish || fin > cur.finish) cur.finish = fin; }
  }
  for (const a of byCode.values()) if (a.done < a.objects) a.finish = null;
  return { byCode, dated: dated.length, linked, latest };
}

/**
 * 공정표에 모델 실적을 넣는다(실적이 비어 있는 작업만): 실적 시작·완료, 상태, 현재 일정(시작 = 실적 시작, 끝났으면 종료 = 실적 종료).
 * 계획 날짜(plannedStart·plannedFinish)는 그대로 — 늦음/빠름과 '실적 누락' 검토의 기준. 데이터 기준일은 가장 늦은 실적일까지 당긴다.
 */
export function applyActuals(s: P6Schedule, m: ModelActuals | null): { schedule: P6Schedule; filled: number } {
  if (!m || !m.byCode.size) return { schedule: s, filled: 0 };
  let filled = 0;
  const activities = s.activities.map(a => {
    const x = m.byCode.get(a.code);
    if (!x || a.actualStart) return a;
    filled++;
    const actualStart = `${x.start} 08:00`, actualFinish = x.finish ? `${x.finish} 17:00` : null;
    const finish = actualFinish ?? (a.finish && a.finish > actualStart ? a.finish : actualStart);
    return { ...a, actualStart, actualFinish, start: actualStart, finish, status: actualFinish ? 'TK_Complete' : 'TK_Active', remainingDays: actualFinish ? 0 : a.remainingDays };
  });
  const latest = m.latest ? `${m.latest} 17:00` : null;
  const dataDate = latest && (!s.dataDate || latest > s.dataDate) ? latest : s.dataDate;
  return { schedule: { ...s, activities, dataDate }, filled };
}
