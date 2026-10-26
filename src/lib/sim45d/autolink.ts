// BIM 객체 → IPS Activity ID 자동 부여(단계 6, AI 활용 1의 규칙 부분). 코드가 없는 모델에 쓴다.
// 객체의 이름·유형·주석·객체명칭에서 "부위"(기초·교각·코핑·교대·받침·거더·상판/공동구·특수 경간)와
// "개소"(A1, P12 …)를 읽고, 대상 구조물 WBS 안에서 그 개소 아래 그 부위 이름의 작업을 찾는다.
// 하나로 정해지지 않으면 후보만 남긴다(→ AI 보정 또는 사람). 공단 BIM 속성 A3(WBS·IPS 코드)는 읽지 않는다 — 그것이 답이다.

export interface LinkActivity {
  code: string;
  name: string;
  /** 대상 구조물 아래 WBS 이름 경로(예 ['하부공', 'P12']). */
  path: string[];
}

/** 객체에서 읽는 글자들. 없는 칸은 비워 둔다. */
export interface LinkObject {
  id: string;
  /** 객체명칭(예: 공단 BIM 속성 A1_객체명칭) — 있으면 가장 믿을 만함. */
  label?: string;
  /** Revit 패밀리/요소 이름(대괄호 요소 ID 는 빼고). */
  name?: string;
  /** 유형 이름. */
  type?: string;
  /** 주석(해설·Comments). */
  comment?: string;
  /** IFC 분류(IfcBeam 등) — IFC 로 받은 모델에만. */
  ifcClass?: string;
}

export type LinkPart = 'special' | 'deck' | 'bearing' | 'coping' | 'foundation' | 'abutment' | 'pier' | 'girder';

export const LINK_PART_LABEL: Record<LinkPart, string> = {
  special: '특수 경간', deck: '상판·공동구', bearing: '받침', coping: '코핑', foundation: '기초·말뚝', abutment: '교대 본체', pier: '교각', girder: '거더',
};

export interface LinkResult {
  id: string;
  code: string | null;
  part: LinkPart | null;
  place: string | null;
  /** 정하지 못했을 때 남은 후보(AI·사람이 고름). */
  candidates: string[];
  reason: string;
}

// 부위 판정 순서가 중요: '교각 P2 말뚝'·'교대 A1 버림콘크리트' 는 기초, '하로교 공동구' 는 상판, '상선 교좌 P01' 은 받침.
const PART_RULES: [LinkPart, RegExp][] = [
  ['deck', /공동구|방호벽|레벨링|슬래브/],
  ['special', /하로교|하교로|사재교/],
  ['bearing', /받침|교좌/],
  ['coping', /코핑/],
  ['foundation', /말뚝|파일|PHC|기초|현장타설|버림/i], // 버림콘크리트는 기초 작업에 든다
  ['abutment', /교대/],
  ['pier', /교각|기둥/],
  ['girder', /거더|WPC|PSC|가로보|거치/i],
];

/** 부위별로 찾을 작업 이름과, 개소(A1·P12) 아래에서만 찾는지. */
const ACTIVITY_RULES: Record<LinkPart, { name: RegExp; atPlace: boolean; prefer?: RegExp; fallback?: RegExp }> = {
  foundation: { name: /기초|말뚝/, atPlace: true },
  pier: { name: /교각|기둥/, atPlace: true },
  coping: { name: /코핑/, atPlace: true },
  abutment: { name: /벽체|교대/, atPlace: true, fallback: /기초/ },
  bearing: { name: /받침/, atPlace: false, fallback: /거치/ },
  girder: { name: /거치|거더/, atPlace: false, prefer: /거치/ },
  deck: { name: /공동구|슬래브|상판/, atPlace: false },
  special: { name: /하로교|사재교/, atPlace: false },
};

const PLACE = /(?:^|[^A-Za-z0-9])([AP])\s?0*(\d{1,3})(?!\d)/g;
const SPAN = /(?:^|[^A-Za-z0-9])S\s?0*(\d{1,3})(?!\d)/g;

/** 글에서 개소 하나(A1·P12)를 읽는다. 둘 이상이면(예 'P01,P03_P46') 모르는 것으로. */
export function placeOf(text: string | undefined): string | null {
  if (!text) return null;
  const found = new Set([...text.toUpperCase().matchAll(PLACE)].map(m => `${m[1]}${Number(m[2])}`));
  return found.size === 1 ? [...found][0] : null;
}

/** 글에서 경간 번호 하나(객체명칭 '상선_거더_S03' → 3)를 읽는다. 없거나 둘 이상이면 null. */
export function spanOf(text: string | undefined): number | null {
  if (!text) return null;
  const found = new Set([...text.toUpperCase().matchAll(SPAN)].map(m => Number(m[1])));
  return found.size === 1 ? [...found][0] : null;
}

/** 작업 이름이 맡는 경간('WPC거더 거치 S1~S5' → 1~5, '… S46' → 46). 경간이 없으면 null. */
export function spansOfName(name: string): { lo: number; hi: number } | null {
  const range = /S\s?0*(\d{1,3})\s*[~∼-]\s*S?\s?0*(\d{1,3})(?!\d)/i.exec(name);
  if (range) { const a = Number(range[1]), b = Number(range[2]); return { lo: Math.min(a, b), hi: Math.max(a, b) }; }
  const one = spanOf(name);
  return one === null ? null : { lo: one, hi: one };
}

const PILE = /말뚝|파일|PHC|현장타설|강관/i;

export function partOf(text: string | undefined): LinkPart | null {
  if (!text) return null;
  for (const [part, re] of PART_RULES) if (re.test(text)) return part;
  return null;
}

const clean = (s: string | undefined) => s?.replace(/\s*\[\d+\]\s*$/, '').trim() || undefined;
const norm = (s: string) => s.replace(/\s/g, '');

/**
 * 객체마다 작업 하나를 고른다. 부위는 객체명칭 → 이름 → 유형 → 주석 순(주석은 '상선 교각 P35' 처럼 개소를 말해도
 * 부위는 틀리기 쉬움), 개소는 객체명칭 → 주석 → 유형 → 이름 순(패밀리 이름은 'P01,P03_P46' 처럼 여러 개).
 * 상부(거더·상판·받침·특수 경간)는 개소 대신 경간: 객체명칭의 'S03' 이 작업 이름의 경간 범위('S1~S5')에 드는 작업.
 * 기초가 말뚝과 확대기초(교대: 말뚝·가시설·토공과 기초)로 나뉜 개소는 말뚝 객체는 말뚝 작업, 나머지는 기초 작업.
 */
export function autoLink(objects: LinkObject[], activities: LinkActivity[]): LinkResult[] {
  const acts = activities.map(a => ({ ...a, n: norm(a.name), spans: spansOfName(a.name), places: new Set(a.path.map(p => placeOf(p)).filter((p): p is string => !!p)) }));
  return objects.map(o => {
    const label = clean(o.label), name = clean(o.name), type = clean(o.type), comment = clean(o.comment);
    let part = partOf(label) ?? partOf(name) ?? partOf(type) ?? partOf(comment);
    // 이름이 거더(WPC_40m 등)여도 IFC 에서 보(IfcBeam·IfcMember)가 아니면 같은 패밀리로 그린 상판 조각이다
    // (연제교 IFC: 거더 135 = IfcBeam, 상부슬래브 270 = IfcBuildingElementProxy, 이름은 둘 다 WPC_*).
    const deckByIfc = part === 'girder' && !partOf(label) && !!o.ifcClass && !/^Ifc(Beam|Member)/i.test(o.ifcClass);
    if (deckByIfc) part = 'deck';
    const place = placeOf(label) ?? placeOf(comment) ?? placeOf(type) ?? placeOf(name);
    const none = (reason: string, candidates: string[] = []): LinkResult => ({ id: o.id, code: null, part, place, candidates, reason });
    if (!part) return none('부위를 알 수 없음');
    const rule = ACTIVITY_RULES[part];
    if (rule.atPlace && !place) return none(`${LINK_PART_LABEL[part]}: 개소(A1·P12 등)를 알 수 없음`);
    const scope = rule.atPlace ? acts.filter(a => a.places.has(place!)) : acts;
    if (rule.atPlace && !scope.length) return none(`개소 ${place} 를 WBS 에서 찾지 못함`);
    let hit = scope.filter(a => rule.name.test(a.n));
    if (!hit.length && rule.fallback) hit = scope.filter(a => rule.fallback!.test(a.n));
    if (hit.length > 1 && rule.prefer) {
      const pref = hit.filter(a => rule.prefer!.test(a.n));
      if (pref.length) hit = pref;
    }
    if (hit.length > 1 && part === 'foundation') {
      const pile = PILE.test([label, name, type].filter(Boolean).join(' '));
      const pref = hit.filter(a => /말뚝/.test(a.n) === pile);
      if (pref.length) hit = pref;
    }
    const span = rule.atPlace ? null : spanOf(label) ?? spanOf(comment) ?? spanOf(name);
    if (hit.length > 1 && span !== null) {
      const inSpan = hit.filter(a => a.spans && span >= a.spans.lo && span <= a.spans.hi);
      if (inSpan.length) hit = inSpan;
    }
    if (hit.length === 1) {
      return { id: o.id, code: hit[0].code, part, place, candidates: [], reason: `${LINK_PART_LABEL[part]}${place ? ` ${place}` : ''}${span !== null ? ` S${span}` : ''}${deckByIfc ? `(${o.ifcClass})` : ''} → ${hit[0].name}` };
    }
    return hit.length
      ? none(`${LINK_PART_LABEL[part]}: 작업 후보 ${hit.length}개`, hit.map(a => a.code))
      : none(`${LINK_PART_LABEL[part]}${place ? ` ${place}` : ''}: 맞는 작업 없음`);
  });
}

/** 정답(사람이 넣은 코드)과 비교: 맞음·틀림·미정. */
export function scoreLinks(results: LinkResult[], truth: ReadonlyMap<string, string>) {
  let correct = 0, wrong = 0, open = 0;
  const wrongs: { id: string; got: string; want: string; reason: string }[] = [];
  for (const r of results) {
    const want = truth.get(r.id);
    if (!want) continue;
    if (!r.code) open++;
    else if (r.code === want) correct++;
    else { wrong++; wrongs.push({ id: r.id, got: r.code, want, reason: r.reason }); }
  }
  const total = correct + wrong + open;
  return { total, correct, wrong, open, precision: correct + wrong ? correct / (correct + wrong) : 0, coverage: total ? (correct + wrong) / total : 0, wrongs };
}
