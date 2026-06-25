import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { ElementMeta } from '../viewer/IfcViewer';
import type { ClashType, ClashHit } from './clash';

// =====================================================================
// APS 간섭 엔진 — S49 / feature/aps-clash (최우선).
//
// 배경: 기존 간섭(lib/clash.ts)은 web-ifc 가 준 요소별 mesh 로 BVH 를 만들었다.
// APS(SVF2)는 요소 mesh 를 직접 주지 않고 **fragment**(LMV 인터리브 VertexBuffer)
// 로 들고 있으므로, 여기서 `model.getFragmentList()` 의 fragment 지오를 읽어
// **월드행렬을 적용**해 dbId 별로 합치고 `three-mesh-bvh`(MIT) 로 BVH 를 만든다.
//   1) 광역(broad): dbId 별 월드 AABB(fragment bounds)로 후보쌍을 추린다.
//   2) 협역(narrow): 후보 dbId 만 fragment 지오를 읽어 MeshBVH 구축 → 정밀 교차.
//
// 출력은 기존 `clash.ts` 의 `ClashHit`(그룹화·정렬·ClashPanel 재사용) 와 호환되게
// `ElementMeta` 형태로 만든다. APS 에는 expressID 가 없으므로 **expressID 슬롯에
// dbId 를, modelID 슬롯에 APS model.id 를** 담는다(영속 저장키 GlobalId 는 매핑으로
// 따로 해석 — apsMapping.ts). 이렇게 하면 clash.ts·ClashPanel 을 수정 없이 붙인다.
//
// 순수 데이터/지오 모듈 — 색 토큰·렌더는 호출측(AccModels) 책임.
// =====================================================================

/** Autodesk Viewer 객체(타입 패키지 미설치 — 느슨하게). */
type ApsViewer = any;
type ApsModel = any;

/** dbId 한 개의 월드공간 지오메트리 + BVH(협역단계용). */
export interface ApsClashGeom {
  dbId: number;
  geometry: THREE.BufferGeometry;
  box: THREE.Box3;
  bvh: MeshBVH;
}

/** 간섭 대상 한 개 = (모델, dbId). 모델간 간섭을 위해 모델을 함께 들고 다닌다. */
export interface ApsClashTarget {
  model: ApsModel;
  dbId: number;
}

/** (modelId, dbId) → 표시 메타. 키는 `${model.id}:${dbId}`. */
export type ApsMetaResolver = Map<string, { name: string; category: string }>;

export const targetKey = (modelId: number, dbId: number) => `${modelId}:${dbId}`;

export interface ApsClashInput {
  /** 대상 뷰어(시그니처 호환용). */
  viewer: ApsViewer;
  /** 집합 A·B 의 대상(모델+dbId). 같은 모델이면 자기/카테고리 간섭, 다르면 모델간. */
  itemsA: ApsClashTarget[];
  itemsB: ApsClashTarget[];
  type: ClashType;
  /** 허용오차(m, 모델 단위가 m 라는 전제 — ACC 변환 결과는 보통 m). */
  tolerance: number;
  /** (modelId:dbId) → 표시 메타. 그룹화/표에 사용. 없으면 UNKNOWN. */
  metaMap?: ApsMetaResolver;
  onProgress?: (ratio: number, phase: string) => void;
  shouldCancel?: () => boolean;
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * LMV fragment 지오메트리(geom)의 삼각형을 월드행렬(mtx) 적용해 열거한다.
 * SVF2 는 보통 인터리브 VertexBuffer(`geom.vb`/`vbstride`)를 쓰므로 그 경로를
 * 우선 처리하고, 표준 three 속성 경로를 폴백으로 둔다. (개념상 APS
 * `VertexBufferReader` 와 동일한 일을 직접 한다 — 버전 의존을 줄이려 자체 구현.)
 */
function enumGeomTriangles(
  geom: any,
  mtx: THREE.Matrix4,
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  onTri: (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => void,
): void {
  let getV: (i: number, out: THREE.Vector3) => void;
  let vcount = 0;

  if (geom.vb && geom.vbstride) {
    const vb = geom.vb as Float32Array;
    const stride = geom.vbstride as number;
    // position 속성의 오프셋(보통 0). 일부 빌드는 itemOffset 으로 노출.
    const posAttr = geom.attributes?.position;
    const off = (posAttr?.itemOffset ?? posAttr?.offset ?? 0) as number;
    vcount = Math.floor(vb.length / stride);
    getV = (i, out) =>
      out.set(vb[i * stride + off], vb[i * stride + off + 1], vb[i * stride + off + 2]).applyMatrix4(mtx);
  } else {
    const pos = geom.attributes?.position ?? geom.getAttribute?.('position');
    const arr: ArrayLike<number> | undefined = pos?.array;
    if (!arr) return;
    const isz = (pos.itemSize ?? 3) as number;
    vcount = pos.count ?? Math.floor(arr.length / isz);
    getV = (i, out) => out.set(arr[i * isz], arr[i * isz + 1], arr[i * isz + 2]).applyMatrix4(mtx);
  }

  // 인덱스 버퍼(LMV 는 `ib`, three 는 getIndex()).
  const ib: ArrayLike<number> | undefined =
    geom.ib ?? geom.indices ?? geom.getIndex?.()?.array;

  if (ib) {
    for (let i = 0; i + 2 < ib.length; i += 3) {
      getV(ib[i], a);
      getV(ib[i + 1], b);
      getV(ib[i + 2], c);
      onTri(a, b, c);
    }
  } else {
    for (let i = 0; i + 2 < vcount; i += 3) {
      getV(i, a);
      getV(i + 1, b);
      getV(i + 2, c);
      onTri(a, b, c);
    }
  }
}

/** dbId 의 fragment id 들을 모은다(instanceTree). */
function fragmentsOf(model: ApsModel, dbId: number): number[] {
  const it = model.getInstanceTree?.();
  if (!it) return [];
  const frags: number[] = [];
  it.enumNodeFragments(dbId, (fragId: number) => frags.push(fragId), false);
  return frags;
}

/**
 * dbId 의 월드 AABB 를 빠르게 구한다(지오 읽기 없이 fragment bounds 합).
 * 광역단계 후보 추리기에 사용 — 협역보다 훨씬 싸다.
 */
export function computeDbIdWorldBox(model: ApsModel, dbId: number): THREE.Box3 | null {
  const fragList = model.getFragmentList?.();
  if (!fragList) return null;
  const box = new THREE.Box3();
  const fb = new THREE.Box3();
  let any = false;
  for (const fragId of fragmentsOf(model, dbId)) {
    try {
      fragList.getWorldBounds(fragId, fb);
      if (!fb.isEmpty()) {
        box.union(fb);
        any = true;
      }
    } catch {
      /* 일부 fragment 는 bounds 미제공 — 무시 */
    }
  }
  return any ? box : null;
}

/**
 * dbId 한 개의 월드공간 합본 지오메트리 + BVH 를 만든다(협역단계).
 * fragment 마다 월드행렬을 적용해 삼각형을 모아 non-indexed BufferGeometry 로.
 */
export function buildDbIdGeom(model: ApsModel, dbId: number): ApsClashGeom | null {
  const fragList = model.getFragmentList?.();
  if (!fragList) return null;
  const frags = fragmentsOf(model, dbId);
  if (!frags.length) return null;

  const positions: number[] = [];
  const mtx = new THREE.Matrix4();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();

  for (const fragId of frags) {
    let geom: any;
    try {
      geom = fragList.getGeometry(fragId);
    } catch {
      geom = null;
    }
    if (!geom) continue;
    try {
      fragList.getWorldMatrix(fragId, mtx);
    } catch {
      mtx.identity();
    }
    enumGeomTriangles(geom, mtx, a, b, c, (p0, p1, p2) => {
      positions.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
    });
  }
  if (positions.length < 9) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  const bvh = new MeshBVH(geometry);
  // three-mesh-bvh 가 반대편 교차도 가속하도록 boundsTree 부착(clash.ts 와 동일).
  (geometry as unknown as { boundsTree: MeshBVH }).boundsTree = bvh;
  const box = new THREE.Box3().setFromBufferAttribute(
    geometry.getAttribute('position') as THREE.BufferAttribute,
  );
  return { dbId, geometry, box, bvh };
}

// ----- 관통깊이(실측) -------------------------------------------------
// AABB 겹침 최소변은 비스듬한/긴 선형요소에서 과대평가된다(면접촉도 수 m). 대신
// 한 솔리드의 정점이 다른 솔리드 표면에서 **내부로** 얼마나 들어갔는지(closestPoint
// + 법선 내적 부호)를 측정해 최대 침투거리를 깊이로 쓴다. 면끼리만 닿으면 ≈0.
const _pa = new THREE.Vector3();
const _pb = new THREE.Vector3();
const _pc = new THREE.Vector3();
const _pn = new THREE.Vector3();
const _pd = new THREE.Vector3();
const _pv = new THREE.Vector3();

function triNormal(pos: ArrayLike<number>, faceIndex: number, out: THREE.Vector3): void {
  const i = faceIndex * 9; // non-indexed: 삼각형당 정점 3개 × 좌표 3개
  _pa.set(pos[i], pos[i + 1], pos[i + 2]);
  _pb.set(pos[i + 3], pos[i + 4], pos[i + 5]).sub(_pa);
  _pc.set(pos[i + 6], pos[i + 7], pos[i + 8]).sub(_pa);
  out.crossVectors(_pb, _pc).normalize();
}

/** fromGeom 정점들이 intoBvh 솔리드 내부로 파고든 최대 깊이(overlap 박스 내 표본). */
function maxPenetration(fromGeom: THREE.BufferGeometry, intoGeom: THREE.BufferGeometry, intoBvh: MeshBVH, box: THREE.Box3): number {
  const pos = (fromGeom.getAttribute('position') as THREE.BufferAttribute).array as ArrayLike<number>;
  const intoPos = (intoGeom.getAttribute('position') as THREE.BufferAttribute).array as ArrayLike<number>;
  const count = pos.length / 3;
  const stride = Math.max(1, Math.floor(count / 1200)); // 표본 ≤ ~1200정점
  const target: { point: THREE.Vector3; distance: number; faceIndex: number } = {
    point: new THREE.Vector3(),
    distance: 0,
    faceIndex: 0,
  };
  let max = 0;
  for (let i = 0; i < count; i += stride) {
    _pv.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    if (!box.containsPoint(_pv)) continue;
    const hit = (intoBvh as any).closestPointToPoint(_pv, target);
    if (!hit) continue;
    triNormal(intoPos, hit.faceIndex, _pn);
    _pd.copy(_pv).sub(hit.point);
    if (_pd.dot(_pn) < 0 && hit.distance > max) max = hit.distance; // 내부(법선 반대) = 관통
  }
  return max;
}

function penetrationDepth(ga: ApsClashGeom, gb: ApsClashGeom, overlap: THREE.Box3): number {
  if (overlap.isEmpty()) return 0;
  try {
    const a = maxPenetration(ga.geometry, gb.geometry, gb.bvh, overlap);
    const b = maxPenetration(gb.geometry, ga.geometry, ga.bvh, overlap);
    return Math.max(a, b);
  } catch {
    overlap.getSize(_pv);
    return Math.min(_pv.x, _pv.y, _pv.z); // 폴백
  }
}

let _seq = 0;
function makeHit(
  metaMap: ApsMetaResolver | undefined,
  ta: ApsClashTarget,
  tb: ApsClashTarget,
  point: THREE.Vector3,
  depth: number,
): ClashHit {
  const aModelId = (ta.model?.id ?? 0) as number;
  const bModelId = (tb.model?.id ?? 0) as number;
  const ma = metaMap?.get(targetKey(aModelId, ta.dbId));
  const mb = metaMap?.get(targetKey(bModelId, tb.dbId));
  const a: ElementMeta = {
    modelID: aModelId,
    expressID: ta.dbId, // APS: expressID 슬롯에 dbId
    name: ma?.name ?? '',
    category: ma?.category ?? 'UNKNOWN',
  };
  const b: ElementMeta = {
    modelID: bModelId,
    expressID: tb.dbId,
    name: mb?.name ?? '',
    category: mb?.category ?? 'UNKNOWN',
  };
  return {
    id: `apsclash-${Date.now().toString(36)}-${(_seq++).toString(36)}`,
    a,
    b,
    point: { x: point.x, y: point.y, z: point.z },
    depth,
  };
}

const tkey = (t: ApsClashTarget) => targetKey((t.model?.id ?? 0) as number, t.dbId);

/**
 * APS fragment 기반 간섭 검출(모델간 지원). clash.ts(runClashDetection)의 APS 판으로,
 * 같은 대상(같은 모델·dbId)·중복쌍은 1회만. 박스는 미리 계산(광역), BVH 는 후보만 지연 빌드.
 */
export async function runApsClashDetection(input: ApsClashInput): Promise<ClashHit[]> {
  const { viewer, itemsA, itemsB, type, tolerance, metaMap, onProgress, shouldCancel } = input;
  void viewer; // 시그니처 호환용

  const expand = Math.max(0, tolerance);

  // ----- 광역단계 준비: 등장하는 모든 대상의 월드 박스(키=modelId:dbId) -------
  const allTargets = new Map<string, ApsClashTarget>();
  for (const t of [...itemsA, ...itemsB]) allTargets.set(tkey(t), t);
  const boxes = new Map<string, THREE.Box3>();
  const keys = [...allTargets.keys()];
  for (let i = 0; i < keys.length; i++) {
    if (shouldCancel?.()) return [];
    const t = allTargets.get(keys[i])!;
    const box = computeDbIdWorldBox(t.model, t.dbId);
    if (box) boxes.set(keys[i], box);
    if (i % 50 === 0) {
      onProgress?.((i / Math.max(1, keys.length)) * 0.3, '경계상자 준비');
      await yieldToUi();
    }
  }

  // ----- 협역단계: 후보쌍만 BVH 교차 ---------------------------------
  const geomCache = new Map<string, ApsClashGeom | null>();
  const getGeom = (t: ApsClashTarget): ApsClashGeom | null => {
    const k = tkey(t);
    if (geomCache.has(k)) return geomCache.get(k)!;
    const g = buildDbIdGeom(t.model, t.dbId);
    geomCache.set(k, g);
    return g;
  };

  const hits: ClashHit[] = [];
  const seenPair = new Set<string>();
  const identity = new THREE.Matrix4();
  const boxA = new THREE.Box3();
  const overlap = new THREE.Box3();
  const centerA = new THREE.Vector3();
  const centerB = new THREE.Vector3();

  for (let ia = 0; ia < itemsA.length; ia++) {
    if (shouldCancel?.()) return hits;
    const ta = itemsA[ia];
    const ka = tkey(ta);
    const rawA = boxes.get(ka);
    if (rawA) {
      boxA.copy(rawA).expandByScalar(expand);
      for (const tb of itemsB) {
        const kb = tkey(tb);
        if (ka === kb) continue; // 자기 자신
        const pairKey = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        if (seenPair.has(pairKey)) continue;
        const rawB = boxes.get(kb);
        if (!rawB || !boxA.intersectsBox(rawB)) continue; // 광역 탈락
        seenPair.add(pairKey);

        const ga = getGeom(ta);
        const gb = getGeom(tb);
        if (!ga || !gb) continue;

        const intersects = ga.bvh.intersectsGeometry(gb.geometry, identity);
        if (type === 'hard') {
          if (!intersects) continue;
          overlap.copy(ga.box).intersect(gb.box);
          // 관통깊이 = 한쪽 솔리드로 파고든 상대 정점의 최대 침투거리(실측).
          // 면끼리만 닿으면(=관통 0) 허용오차로 걸러져 선형구조 접합부가 제외된다.
          const depth = penetrationDepth(ga, gb, overlap);
          if (depth < tolerance) continue;
          const point = overlap.isEmpty()
            ? ga.box.getCenter(centerA).clone().lerp(gb.box.getCenter(centerB), 0.5)
            : overlap.getCenter(new THREE.Vector3());
          hits.push(makeHit(metaMap, ta, tb, point, depth));
        } else {
          // clearance: 겹침(거리 0) 또는 tolerance 이내 근접.
          if (intersects) {
            overlap.copy(ga.box).intersect(gb.box);
            const point = overlap.isEmpty()
              ? ga.box.getCenter(centerA).clone().lerp(gb.box.getCenter(centerB), 0.5)
              : overlap.getCenter(new THREE.Vector3());
            hits.push(makeHit(metaMap, ta, tb, point, 0));
          } else {
            ga.box.getCenter(centerA);
            gb.box.getCenter(centerB);
            const dist = centerA.distanceTo(centerB);
            hits.push(makeHit(metaMap, ta, tb, centerA.clone().lerp(centerB, 0.5), dist));
          }
        }
      }
    }
    if (ia % 3 === 0) {
      onProgress?.(0.3 + (ia / Math.max(1, itemsA.length)) * 0.7, '간섭 검사');
      await yieldToUi();
    }
  }

  // 메모리 정리.
  for (const g of geomCache.values()) g?.geometry.dispose();
  onProgress?.(1, '완료');
  return hits;
}
