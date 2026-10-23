// CPM(주공정법) 일정 계산 — AI 개략공정을 P6 로 보내기 전에 플랫폼에서 날짜를 매긴다.
//
// 단위는 '일'이고 달력은 매일 작업(7일)으로 본다. 휴일·동절기 같은 달력 규칙은 P6 가
// 맡는다: 내보낸 공정표를 P6 에서 일정 계산(F9)하면 그 프로젝트 달력으로 다시 계산된다.
// 여기서 날짜는 4D 미리보기와 P6 의 초기값 용도다.
//
// 관계: FS·SS·FF·SF + 지연(lag, 일). 순환이 있으면 관련 작업을 담아 오류를 낸다.
// 작업 제약: notBefore(이 날 이전 시작 금지) · blocked(작업 금지 기간 — 예: 하천 구간 홍수기, 걸치면 기간 뒤로 민다).

export type RelType = 'FS' | 'SS' | 'FF' | 'SF';

export interface CpmActivity {
  id: string;
  /** 작업 일수(0 = 마일스톤). */
  duration: number;
  /** 가장 이른 시작(일 오프셋). */
  notBefore?: number;
  /** 작업하면 안 되는 기간 [시작, 끝) 일 오프셋. 작업이 걸치면 그 기간 뒤로 민다. */
  blocked?: [number, number][];
}

export interface CpmRelation {
  pred: string;
  succ: string;
  type: RelType;
  lag: number;
}

export interface CpmResult {
  /** 작업별 일수 오프셋: 시작일 = 착공일 + es, 작업은 [es, ef) 동안 진행. */
  times: Map<string, { es: number; ef: number; ls: number; lf: number; float: number }>;
  /** 전체 공기(일). */
  duration: number;
  /** 여유가 0 인 작업(주공정). */
  critical: string[];
}

export class CpmCycleError extends Error {
  constructor(readonly ids: string[]) {
    super(`공정 관계에 순환이 있습니다: ${ids.slice(0, 8).join(', ')}${ids.length > 8 ? ' …' : ''}`);
  }
}

export function computeCpm(activities: CpmActivity[], relations: CpmRelation[]): CpmResult {
  const dur = new Map(activities.map(a => [a.id, Math.max(0, a.duration)]));
  const byId = new Map(activities.map(a => [a.id, a]));
  const preds = new Map<string, CpmRelation[]>();
  const succs = new Map<string, CpmRelation[]>();
  for (const a of activities) { preds.set(a.id, []); succs.set(a.id, []); }
  for (const r of relations) {
    if (!dur.has(r.pred) || !dur.has(r.succ) || r.pred === r.succ) continue;
    preds.get(r.succ)!.push(r);
    succs.get(r.pred)!.push(r);
  }

  // 위상 정렬(Kahn). 남는 작업이 있으면 순환.
  const indeg = new Map(activities.map(a => [a.id, preds.get(a.id)!.length]));
  const order: string[] = [];
  const queue = activities.filter(a => indeg.get(a.id) === 0).map(a => a.id);
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const r of succs.get(id)!) {
      const n = indeg.get(r.succ)! - 1;
      indeg.set(r.succ, n);
      if (n === 0) queue.push(r.succ);
    }
  }
  if (order.length < activities.length) {
    throw new CpmCycleError(activities.filter(a => indeg.get(a.id)! > 0).map(a => a.id));
  }

  // 전진 계산: 가장 이른 시작.
  const es = new Map<string, number>();
  for (const id of order) {
    const d = dur.get(id)!;
    let start = 0;
    for (const r of preds.get(id)!) {
      const pEs = es.get(r.pred)!;
      const pEf = pEs + dur.get(r.pred)!;
      start = Math.max(start, earliestStart(r.type, pEs, pEf, d, r.lag));
    }
    es.set(id, pushStart(byId.get(id)!, Math.max(start, byId.get(id)!.notBefore ?? 0), d));
  }
  let total = 0;
  for (const id of order) total = Math.max(total, es.get(id)! + dur.get(id)!);

  // 후진 계산: 가장 늦은 종료.
  const lf = new Map<string, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const d = dur.get(id)!;
    let finish = total;
    for (const r of succs.get(id)!) {
      const sLf = lf.get(r.succ)!;
      const sLs = sLf - dur.get(r.succ)!;
      finish = Math.min(finish, latestFinish(r.type, sLs, sLf, d, r.lag));
    }
    lf.set(id, pullFinish(byId.get(id)!, finish, d));
  }

  const times: CpmResult['times'] = new Map();
  const critical: string[] = [];
  for (const id of order) {
    const d = dur.get(id)!;
    const e = es.get(id)!, l = lf.get(id)!;
    const float = l - d - e;
    times.set(id, { es: e, ef: e + d, ls: l - d, lf: l, float });
    if (float <= 0) critical.push(id);
  }
  return { times, duration: total, critical };
}

/** 작업 금지 기간에 걸치면 그 기간 끝으로 민다(여러 기간이면 반복). */
function pushStart(a: CpmActivity, start: number, d: number): number {
  if (!a.blocked?.length) return start;
  for (let moved = true, guard = 0; moved && guard < 100; guard++) {
    moved = false;
    for (const [from, to] of a.blocked) {
      if (start < to && start + Math.max(d, 1) > from) { start = to; moved = true; }
    }
  }
  return start;
}

/** 후진 계산에서 작업 금지 기간에 걸치면 그 기간 시작으로 당긴다. */
function pullFinish(a: CpmActivity, finish: number, d: number): number {
  if (!a.blocked?.length) return finish;
  for (let moved = true, guard = 0; moved && guard < 100; guard++) {
    moved = false;
    for (const [from, to] of a.blocked) {
      if (finish - Math.max(d, 1) < to && finish > from) { finish = from; moved = true; }
    }
  }
  return finish;
}

/** 선행 하나가 후행 시작에 거는 하한. */
function earliestStart(type: RelType, pEs: number, pEf: number, d: number, lag: number): number {
  switch (type) {
    case 'FS': return pEf + lag;
    case 'SS': return pEs + lag;
    case 'FF': return pEf + lag - d;
    case 'SF': return pEs + lag - d;
  }
}

/** 후행 하나가 선행 종료에 거는 상한. */
function latestFinish(type: RelType, sLs: number, sLf: number, d: number, lag: number): number {
  switch (type) {
    case 'FS': return sLs - lag;
    case 'SS': return sLs - lag + d;
    case 'FF': return sLf - lag;
    case 'SF': return sLf - lag + d;
  }
}
