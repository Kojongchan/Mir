import * as THREE from 'three';
import type { ClashGeom, ElementMeta } from '../viewer/IfcViewer';

// =====================================================================
// 충돌검사(Clash Detection) 엔진 — Phase 4 / S32 (D13: three-mesh-bvh).
//
// 두 집합(Set A vs Set B) 사이의 간섭을 검출한다.
//   1) 광역단계(broad): 각 요소 월드 AABB 로 후보쌍만 추림(전수 비교 회피).
//   2) 협역단계(narrow): 후보쌍을 three-mesh-bvh `intersectsGeometry` 로 정밀 교차.
// 대형 모델에서도 UI 가 얼지 않도록 청크마다 `await yieldToUi()` 로 양보하며
// 진행률(onProgress)을 보고한다(웹 워커 대신 메인 스레드 청크 — 안전 폴백).
// =====================================================================

export type ClashType = 'hard' | 'clearance';

export type ClashStatus = 'new' | 'reviewing' | 'resolved' | 'approved';

export const CLASH_STATUSES: ClashStatus[] = ['new', 'reviewing', 'resolved', 'approved'];

export const CLASH_STATUS_LABEL: Record<ClashStatus, string> = {
  new: '신규',
  reviewing: '검토중',
  resolved: '해결',
  approved: '승인',
};

/** 미해결로 간주하는 상태(요약 카운트용). */
export const OPEN_CLASH_STATUSES: ClashStatus[] = ['new', 'reviewing'];

/** 한 건의 간섭. point/depth 는 월드 좌표/근사 관통깊이. */
export interface ClashHit {
  id: string;
  a: ElementMeta;
  b: ElementMeta;
  /** 간섭 지점(월드 좌표) */
  point: { x: number; y: number; z: number };
  /** 근사 관통깊이/이격(m). hard=겹침 박스 최소변, clearance=중심거리 */
  depth: number;
}

export interface ClashRunInput {
  itemsA: ElementMeta[];
  itemsB: ElementMeta[];
  /** 요소별 월드 지오메트리+BVH 빌더(IfcViewer.buildClashGeom). */
  build: (m: ElementMeta) => ClashGeom | null;
  type: ClashType;
  /** 허용오차(m). hard: 이보다 얕은 겹침은 무시. clearance: 이 거리 내 근접도 간섭. */
  tolerance: number;
  onProgress?: (ratio: number, phase: string) => void;
  /** 취소 플래그(패널이 언마운트되거나 사용자가 중단). */
  shouldCancel?: () => boolean;
}

const keyOf = (m: ElementMeta) => `${m.modelID}:${m.expressID}`;

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 두 집합 사이 간섭을 검출. 같은 요소(자기 자신)·중복쌍(A↔B 와 B↔A)은 1회만.
 */
export async function runClashDetection(input: ClashRunInput): Promise<ClashHit[]> {
  const { itemsA, itemsB, build, type, tolerance, onProgress, shouldCancel } = input;

  // 두 집합에 등장하는 모든 고유 요소의 지오메트리/BVH 를 1회만 빌드(메모리 절약).
  const uniq = new Map<string, ElementMeta>();
  for (const m of [...itemsA, ...itemsB]) uniq.set(keyOf(m), m);

  const geoms = new Map<string, ClashGeom>();
  const keys = [...uniq.keys()];
  for (let i = 0; i < keys.length; i++) {
    if (shouldCancel?.()) return [];
    const meta = uniq.get(keys[i])!;
    const g = build(meta);
    if (g) geoms.set(keys[i], g);
    if (i % 40 === 0) {
      onProgress?.((i / Math.max(1, keys.length)) * 0.45, '지오메트리 준비');
      await yieldToUi();
    }
  }

  // 광역단계 + 협역단계. tolerance 만큼 AABB 를 부풀려 후보를 추린다.
  const expand = Math.max(0, tolerance);
  const hits: ClashHit[] = [];
  const seenPair = new Set<string>();
  const identity = new THREE.Matrix4();

  const boxA = new THREE.Box3();
  const boxB = new THREE.Box3();
  const overlap = new THREE.Box3();
  const size = new THREE.Vector3();
  const centerA = new THREE.Vector3();
  const centerB = new THREE.Vector3();

  const total = itemsA.length;
  for (let ia = 0; ia < itemsA.length; ia++) {
    if (shouldCancel?.()) return hits;
    const ma = itemsA[ia];
    const ga = geoms.get(keyOf(ma));
    if (ga) {
      boxA.copy(ga.box).expandByScalar(expand);

      for (const mb of itemsB) {
        if (ma.modelID === mb.modelID && ma.expressID === mb.expressID) continue; // 자기 자신
        const pairKey =
          keyOf(ma) < keyOf(mb) ? `${keyOf(ma)}|${keyOf(mb)}` : `${keyOf(mb)}|${keyOf(ma)}`;
        if (seenPair.has(pairKey)) continue;

        const gb = geoms.get(keyOf(mb));
        if (!gb) continue;
        boxB.copy(gb.box);
        if (!boxA.intersectsBox(boxB)) continue; // 광역 탈락

        seenPair.add(pairKey);

        const intersects = ga.bvh.intersectsGeometry(gb.geometry, identity);
        if (type === 'hard') {
          if (!intersects) continue;
          // 겹침 박스로 간섭점/관통깊이 근사.
          overlap.copy(ga.box).intersect(gb.box);
          if (overlap.isEmpty()) {
            // BVH 는 교차하지만 AABB 교집합이 비는 경계 사례 → 중점 사용.
            ga.box.getCenter(centerA);
            gb.box.getCenter(centerB);
            const point = centerA.clone().lerp(centerB, 0.5);
            hits.push(makeHit(ma, mb, point, 0));
            continue;
          }
          overlap.getSize(size);
          const depth = Math.min(size.x, size.y, size.z);
          if (depth < tolerance) continue; // 허용오차보다 얕은 겹침은 무시
          hits.push(makeHit(ma, mb, overlap.getCenter(new THREE.Vector3()), depth));
        } else {
          // clearance: 겹치거나(거리 0) tolerance 이내 근접이면 간섭.
          if (intersects) {
            overlap.copy(ga.box).intersect(gb.box);
            const point = overlap.isEmpty()
              ? ga.box.getCenter(centerA).clone().lerp(gb.box.getCenter(centerB), 0.5)
              : overlap.getCenter(new THREE.Vector3());
            hits.push(makeHit(ma, mb, point, 0));
          } else {
            // BVH 미교차지만 AABB 가 tolerance 부풀림으로 겹침 → 근접 후보로 보고.
            ga.box.getCenter(centerA);
            gb.box.getCenter(centerB);
            const dist = centerA.distanceTo(centerB);
            const point = centerA.clone().lerp(centerB, 0.5);
            hits.push(makeHit(ma, mb, point, dist));
          }
        }
      }
    }

    if (ia % 5 === 0) {
      onProgress?.(0.45 + (ia / Math.max(1, total)) * 0.55, '간섭 검사');
      await yieldToUi();
    }
  }

  // 메모리 정리: 빌드한 지오메트리/BVH 해제.
  for (const g of geoms.values()) g.geometry.dispose();
  onProgress?.(1, '완료');
  return hits;
}

let _seq = 0;
function makeHit(a: ElementMeta, b: ElementMeta, point: THREE.Vector3, depth: number): ClashHit {
  return {
    id: `clash-${Date.now().toString(36)}-${(_seq++).toString(36)}`,
    a,
    b,
    point: { x: point.x, y: point.y, z: point.z },
    depth,
  };
}

// ---------- 그룹화 · 정렬 · 상태 승계 (S40, Navisworks식) ------------

export interface ClashRow extends ClashHit {
  status: ClashStatus;
  issueId?: string | null;
  /** 그룹/정렬용 원래 검출 순서(런타임 전용, 영속화 X). */
  _idx?: number;
}

/** 결과 묶음 기준. */
export type ClashGroupBy = 'none' | 'catpair' | 'elementA' | 'status';
/** 결과 정렬 기준. */
export type ClashSortBy = 'index' | 'depthDesc' | 'depthAsc' | 'status';

export const GROUP_BY_LABEL: Record<ClashGroupBy, string> = {
  none: '그룹 없음',
  catpair: '카테고리 쌍',
  elementA: '요소 A',
  status: '상태',
};

export const SORT_BY_LABEL: Record<ClashSortBy, string> = {
  index: '검출 순서',
  depthDesc: '관통깊이 ↓',
  depthAsc: '관통깊이 ↑',
  status: '상태',
};

export interface ClashGroup {
  key: string;
  label: string;
  rows: ClashRow[];
  /** 그룹 내 미해결(new/reviewing) 건수. */
  open: number;
}

const elemKey = (m: ElementMeta) => `${m.modelID}:${m.expressID}`;

/** 요소쌍 식별 키(A↔B 순서 무관). 상태 승계 매칭·중복 판단에 사용. */
export function pairKeyOf(r: { a: ElementMeta; b: ElementMeta }): string {
  const ka = elemKey(r.a);
  const kb = elemKey(r.b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

function rowComparator(sortBy: ClashSortBy): (a: ClashRow, b: ClashRow) => number {
  switch (sortBy) {
    case 'depthDesc':
      return (a, b) => b.depth - a.depth;
    case 'depthAsc':
      return (a, b) => a.depth - b.depth;
    case 'status':
      return (a, b) =>
        CLASH_STATUSES.indexOf(a.status) - CLASH_STATUSES.indexOf(b.status) ||
        (a._idx ?? 0) - (b._idx ?? 0);
    default:
      return (a, b) => (a._idx ?? 0) - (b._idx ?? 0);
  }
}

/**
 * 간섭 결과를 그룹 기준으로 묶고 각 그룹 내부를 정렬해 반환. 그룹은 미해결 수가
 * 많은 순(상태 그룹은 상태 순서)으로 정렬한다. `_idx` 로 원래 검출 순서를 유지한다.
 */
export function groupClashes(
  rows: ClashRow[],
  groupBy: ClashGroupBy,
  sortBy: ClashSortBy,
): ClashGroup[] {
  const indexed: ClashRow[] = rows.map((r, i) => ({ ...r, _idx: i }));
  const keyOf = (r: ClashRow): { key: string; label: string } => {
    switch (groupBy) {
      case 'catpair': {
        const [x, y] = [r.a.category, r.b.category].sort();
        return { key: `${x}|${y}`, label: `${x} ↔ ${y}` };
      }
      case 'elementA':
        return { key: elemKey(r.a), label: r.a.name || `${r.a.category} #${r.a.expressID}` };
      case 'status':
        return { key: r.status, label: CLASH_STATUS_LABEL[r.status] };
      default:
        return { key: 'all', label: '전체' };
    }
  };

  const map = new Map<string, ClashGroup>();
  const cmp = rowComparator(sortBy);
  for (const r of indexed) {
    const { key, label } = keyOf(r);
    let g = map.get(key);
    if (!g) {
      g = { key, label, rows: [], open: 0 };
      map.set(key, g);
    }
    g.rows.push(r);
    if (OPEN_CLASH_STATUSES.includes(r.status)) g.open++;
  }
  const groups = [...map.values()];
  for (const g of groups) g.rows.sort(cmp);
  if (groupBy === 'status') {
    groups.sort((a, b) => CLASH_STATUSES.indexOf(a.key as ClashStatus) - CLASH_STATUSES.indexOf(b.key as ClashStatus));
  } else if (groupBy !== 'none') {
    groups.sort((a, b) => b.open - a.open || b.rows.length - a.rows.length);
  }
  return groups;
}

/**
 * 재검사 시 직전 결과의 상태/이슈연결을 같은 요소쌍에 승계한다(Navisworks rerun).
 * 새로 검출된 쌍은 'new', 사라진 쌍은 자연 탈락. 검토중/해결/승인 상태를 보존한다.
 */
export function inheritStatuses(fresh: ClashHit[], prev: ClashRow[]): ClashRow[] {
  const prevMap = new Map(prev.map((p) => [pairKeyOf(p), p]));
  return fresh.map((h) => {
    const p = prevMap.get(pairKeyOf(h));
    return p
      ? ({ ...h, status: p.status, issueId: p.issueId ?? null } satisfies ClashRow)
      : ({ ...h, status: 'new' as ClashStatus, issueId: null } satisfies ClashRow);
  });
}

// ---------- CSV 내보내기 --------------------------------------------

function csvCell(s: string | number | null | undefined): string {
  const v = s == null ? '' : String(s);
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** 간섭 결과를 CSV 문자열로. (요소A·카테고리A·요소B·카테고리B·간섭점·관통깊이·상태) */
export function clashesToCsv(rows: ClashRow[]): string {
  const header = [
    'No',
    '요소 A',
    '카테고리 A',
    'expressID A',
    '요소 B',
    '카테고리 B',
    'expressID B',
    'X',
    'Y',
    'Z',
    '관통깊이(m)',
    '상태',
  ];
  const lines = [header.join(',')];
  rows.forEach((r, i) => {
    lines.push(
      [
        i + 1,
        csvCell(r.a.name || '(이름없음)'),
        csvCell(r.a.category),
        r.a.expressID,
        csvCell(r.b.name || '(이름없음)'),
        csvCell(r.b.category),
        r.b.expressID,
        r.point.x.toFixed(3),
        r.point.y.toFixed(3),
        r.point.z.toFixed(3),
        r.depth.toFixed(3),
        CLASH_STATUS_LABEL[r.status],
      ].join(','),
    );
  });
  return lines.join('\n');
}

/** 브라우저에서 CSV 파일 다운로드를 트리거(BOM 포함, 엑셀 한글 호환). */
export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
