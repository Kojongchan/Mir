// 7단계 모델 반영(D36, (가) 방식): 확정 공정표 + 6단계 연결 → 객체별 공단 BIM 속성 값(A3 코드·A5 계획 시작·종료일).
// 플랫폼은 모델을 직접 고치지 않는다 — 반영 CSV 와 Revit(Dynamo) 스크립트를 내주고, 사람이 원본 RVT 에 적용해 다시 올리면
// 같은 비교로 반영을 확인한다(IFC 만 고치면 원본과 따로 놀기 때문). A5 실시공정(실적)은 절대 건드리지 않는다.
import type { LinkSet, SetupFile } from './setup.js';

export const PARAM = { code: 'A3_WBS CODE (IPS)', start: 'A5_계획공정시작일', finish: 'A5_계획공정종료일' } as const;

export interface SyncActivity { code: string; name: string; start: string | null; finish: string | null }
export interface SyncObject { ext: string; ifcGuid: string; name?: string; code: string; plannedStart?: string; plannedFinish?: string }

export type SyncStatus = 'same' | 'change' | 'missing' | 'unknown';
export interface SyncRow {
  /** Revit UniqueId(연결한 모델이 RVT 일 때만 — IFC 의 외부 ID 는 Revit 에서 못 찾음). */
  uniqueId: string;
  ifcGuid: string;
  name: string;
  code: string;
  activity: string;
  start: string;
  finish: string;
  by: string;
  current: { code: string; start: string; finish: string } | null;
  status: SyncStatus;
  changes: ('code' | 'start' | 'finish')[];
}

const day = (v: string | null | undefined) => (v ? v.slice(0, 10) : '');

/**
 * 반영할 값과(objects 를 주면) 모델 현재 값 비교. withDates=false 면 코드만 비교·반영.
 * 확정 공정표에 없는 코드(예전 공정표로 저장한 연결)는 rows 에 넣지 않고 noActivity 로 알린다.
 */
export function buildSync(linkSets: LinkSet[], models: SetupFile[], activities: SyncActivity[], opts: { withDates: boolean; objects?: SyncObject[] }) {
  const acts = new Map(activities.map(a => [a.code, a]));
  const byExt = new Map<string, SyncObject>(), byGuid = new Map<string, SyncObject>();
  for (const o of opts.objects ?? []) { if (o.ext) byExt.set(o.ext, o); if (o.ifcGuid) byGuid.set(o.ifcGuid, o); }
  const rows: SyncRow[] = [];
  const noActivity: { key: string; code: string }[] = [];
  const seen = new Set<string>();
  for (const set of linkSets) {
    const rvt = /\.rvt$/i.test(models.find(m => m.accItemId === set.modelItemId)?.name ?? '');
    for (const l of set.links) {
      const key = l.ifcGuid || l.ext;
      if (seen.has(key)) continue;
      seen.add(key);
      const a = acts.get(l.code);
      if (!a) { noActivity.push({ key, code: l.code }); continue; }
      const uniqueId = rvt ? l.ext : '';
      const want = { code: a.code, start: day(a.start), finish: day(a.finish) };
      let current: SyncRow['current'] = null, status: SyncStatus = 'unknown';
      const changes: SyncRow['changes'] = [];
      if (opts.objects) {
        const o = (uniqueId && byExt.get(uniqueId)) || (l.ifcGuid && byGuid.get(l.ifcGuid)) || byExt.get(l.ext);
        if (!o) status = 'missing';
        else {
          current = { code: o.code ?? '', start: day(o.plannedStart), finish: day(o.plannedFinish) };
          if (current.code !== want.code) changes.push('code');
          if (opts.withDates && current.start !== want.start) changes.push('start');
          if (opts.withDates && current.finish !== want.finish) changes.push('finish');
          status = changes.length ? 'change' : 'same';
        }
      }
      rows.push({ uniqueId, ifcGuid: l.ifcGuid, name: (opts.objects && (byGuid.get(l.ifcGuid) ?? byExt.get(l.ext))?.name) || '', code: want.code, activity: a.name, start: want.start, finish: want.finish, by: l.by, current, status, changes });
    }
  }
  const count = (s: SyncStatus) => rows.filter(r => r.status === s).length;
  return {
    rows, noActivity,
    counts: { total: rows.length, same: count('same'), change: count('change'), missing: count('missing'), unknown: count('unknown'),
      code: rows.filter(r => r.changes.includes('code')).length, dates: rows.filter(r => r.changes.includes('start') || r.changes.includes('finish')).length,
      /** 모델에 이미 계획일이 있고 바뀌게 될 객체(개략 IPS 날짜로 현장 일정을 덮어쓸 위험). */
      overwriteDates: rows.filter(r => r.current && (r.current.start || r.current.finish) && (r.current.start !== r.start || r.current.finish !== r.finish)).length,
      /** 모델에 이미 다른 코드가 있는 객체(예: 실제 IPS 코드를 개략 IPS 코드로 바꾸게 됨). */
      overwriteCodes: rows.filter(r => r.current?.code && r.current.code !== r.code).length },
  };
}

const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** 반영 CSV(UTF-8 BOM — 엑셀에서 한글이 깨지지 않게). Dynamo 스크립트는 머리글의 PARAM 칸만 넣는다. */
export function syncCsv(rows: SyncRow[], withDates: boolean): string {
  const head = ['Revit UniqueId', 'IfcGUID', '객체 이름', PARAM.code, ...(withDates ? [PARAM.start, PARAM.finish] : []), '작업명', '현재 A3', '현재 계획시작', '현재 계획종료', '변경', '연결'];
  const lines = rows.map(r => [r.uniqueId, r.ifcGuid, r.name, r.code, ...(withDates ? [r.start, r.finish] : []), r.activity,
    r.current?.code ?? '', r.current?.start ?? '', r.current?.finish ?? '', r.status === 'unknown' ? '비교 안 함' : r.status === 'missing' ? '모델에 없음' : r.changes.join('+') || '같음', r.by].map(cell).join(','));
  return `\uFEFF${[head.map(cell).join(','), ...lines].join('\r\n')}\r\n`;
}

/** Revit 에 적용하는 Dynamo Python 스크립트(CPython3). 실행해 보지 못한 시험용 — 현장에서 먼저 사본으로 확인. */
export const DYNAMO_SCRIPT = `# MIR 4D/5D 모델 반영(7단계) — Revit 원본(RVT)에 ${PARAM.code} · ${PARAM.start} · ${PARAM.finish} 를 넣는다.
# 사용: Revit 에서 원본을 열고 Dynamo(Revit 2022 이상, Python 엔진 CPython3) → Python Script 노드를 놓고 이 글을 붙여 넣는다.
#       IN[0] 에 File Path 노드로 플랫폼에서 받은 반영 CSV 를 연결 → 실행 → 결과(OUT) 확인 → Revit 저장 → 플랫폼 2단계에서 같은 이름으로 다시 올린다.
# 객체는 Revit UniqueId 로 찾고, 없으면 IfcGUID 매개변수로 찾는다. CSV 머리글에 있는 칸만 넣고, A5_실시공정(실적)은 건드리지 않는다.
# 처음에는 사본 파일로 시험하세요(플랫폼에서 Revit 실행 시험은 하지 못했습니다).
import clr, csv, io
clr.AddReference('RevitServices')
from RevitServices.Persistence import DocumentManager
from RevitServices.Transactions import TransactionManager
clr.AddReference('RevitAPI')
from Autodesk.Revit.DB import FilteredElementCollector, StorageType

doc = DocumentManager.Instance.CurrentDBDocument
PARAMS = ['${PARAM.code}', '${PARAM.start}', '${PARAM.finish}']
with io.open(IN[0], encoding='utf-8-sig', newline='') as f:
    rows = list(csv.DictReader(f))
cols = [p for p in PARAMS if rows and p in rows[0]]

by_ifc = {}
for el in FilteredElementCollector(doc).WhereElementIsNotElementType():
    p = el.LookupParameter('IfcGUID')
    v = p.AsString() if p else None
    if v:
        by_ifc[v] = el

done, missing, problems = 0, [], []
TransactionManager.Instance.EnsureInTransaction(doc)
for r in rows:
    uid = (r.get('Revit UniqueId') or '').strip()
    guid = (r.get('IfcGUID') or '').strip()
    el = None
    if uid:
        try:
            el = doc.GetElement(uid)
        except Exception:
            el = None
    if el is None and guid:
        el = by_ifc.get(guid)
    if el is None:
        missing.append(uid or guid)
        continue
    ok = True
    for name in cols:
        p = el.LookupParameter(name)
        if p is None or p.IsReadOnly or p.StorageType != StorageType.String:
            problems.append('%s: %s' % (uid or guid, name))
            ok = False
            continue
        p.Set(r[name])
    if ok:
        done += 1
TransactionManager.Instance.TransactionTaskDone()

OUT = ['넣은 객체 %d' % done, '못 찾은 객체 %d' % len(missing), '매개변수 문제 %d' % len(problems)] + missing[:20] + problems[:20]
`;
