import * as THREE from 'three';
import type { AppearanceSettings } from '../viewer/IfcViewer';
import type { CellState, ElementInfo, FourDViewer } from './fourd';
import type { ApsElement } from './apsElements';

// =====================================================================
// APS 4D 어댑터 — S50 → D2(깜빡임 제거 재작성).
// Timeline.tsx 가 기대하는 FourDViewer(getElementCatalog/applyConstruction/
// clearConstruction) 를 APS Viewer 위에서 구현한다.
//
// ⚠️ 이전 구현은 매 틱 `isolate()` + `clearThemingColors()` + `invalidate(true,…)`
// 를 호출해 프레임 버퍼를 통째로 지우고 가시성 집합을 재구성 → 재생 시 심한 깜빡임.
// 재작성 원칙(깜빡임 원인 제거):
//   1) isolate 를 쓰지 않는다 — 대신 **직전 상태 대비 delta** 만 hide/show.
//   2) themingColor 도 **변한 객체만** set/clear (전역 clearThemingColors 금지).
//   3) invalidate 는 **clear 없이**(false, true, false) — 화면을 지우지 않고 다시 그림.
//   4) 미시공(ghost)은 기본 숨김(나비스웍스 기본 동작), ghostFuture 시 회색 틴트.
//   5) 미매핑 객체는 건드리지 않아 항상 정상 표시(맥락 유지).
// 이렇게 하면 틱마다 실제로 바뀐 소수 객체만 갱신 → 깜빡임 없음.
// =====================================================================

type ApsViewer = any;
type ApsModel = any;

function hexToVec4(hex: string, alpha: number): THREE.Vector4 {
  const c = new THREE.Color(hex);
  return new THREE.Vector4(c.r, c.g, c.b, alpha);
}

const GHOST_HEX = '#8a8f98';

export function createApsFourDViewer(
  viewer: ApsViewer,
  model: ApsModel,
  elements: ApsElement[],
): FourDViewer {
  const modelID: number = model?.id ?? 0;

  // 직전 프레임의 적용 상태(증분 갱신 기준).
  let hiddenNow = new Set<number>();
  let colorNow = new Map<number, string>(); // dbId → 적용된 색 키

  // 색 상태 → (Vector4, 캐시키). normal/hidden 은 색 없음(null).
  const colorFor = (state: CellState, opts: AppearanceSettings): { vec: THREE.Vector4; key: string } | null => {
    switch (state) {
      case 'active-construct':
        return { vec: hexToVec4(opts.colorConstruct, opts.activeOpacity), key: `c:${opts.colorConstruct}:${opts.activeOpacity}` };
      case 'active-demolish':
        return { vec: hexToVec4(opts.colorDemolish, opts.activeOpacity), key: `d:${opts.colorDemolish}:${opts.activeOpacity}` };
      case 'active-temporary':
        return { vec: hexToVec4(opts.colorTemporary, opts.activeOpacity), key: `t:${opts.colorTemporary}:${opts.activeOpacity}` };
      case 'active-early':
        return { vec: hexToVec4(opts.colorEarly, opts.activeOpacity), key: `e:${opts.colorEarly}:${opts.activeOpacity}` };
      case 'active-late':
        return { vec: hexToVec4(opts.colorLate, opts.activeOpacity), key: `l:${opts.colorLate}:${opts.activeOpacity}` };
      default:
        return null; // ghost/hidden/normal — 활성 색 없음
    }
  };

  return {
    getElementCatalog(): ElementInfo[] {
      return elements.map((e) => ({ modelID, expressID: e.dbId, name: e.name }));
    },

    applyConstruction(
      states: Iterable<{ modelID: number; expressID: number; state: CellState }>,
      opts: AppearanceSettings,
    ) {
      if (!viewer) return;
      try {
        // 1) 목표 상태 계산(이 모델 소속 매핑 객체만).
        const targetHidden = new Set<number>();
        const targetColor = new Map<number, { vec: THREE.Vector4; key: string }>();
        for (const { modelID: m, expressID: dbId, state } of states) {
          if (m !== modelID) continue;
          if (state === 'hidden') {
            targetHidden.add(dbId);
            continue;
          }
          if (state === 'ghost') {
            // 미시공: 기본 숨김. ghostFuture 면 회색 틴트로 남겨 맥락 표시.
            if (opts.ghostFuture) targetColor.set(dbId, { vec: hexToVec4(GHOST_HEX, 0.35), key: 'ghost' });
            else targetHidden.add(dbId);
            continue;
          }
          // normal(완료) → 색 없음(자연색) · active-* → 유형 색.
          const c = colorFor(state, opts);
          if (c) targetColor.set(dbId, c);
        }

        // 2) 가시성 delta 만 반영(hide 새로 숨길 것 / show 다시 보일 것).
        const toHide: number[] = [];
        for (const d of targetHidden) if (!hiddenNow.has(d)) toHide.push(d);
        const toShow: number[] = [];
        for (const d of hiddenNow) if (!targetHidden.has(d)) toShow.push(d);
        if (toHide.length) viewer.hide?.(toHide, model);
        if (toShow.length) viewer.show?.(toShow, model);
        let changed = toHide.length > 0 || toShow.length > 0;

        // 3) 색 delta 만 반영(변한 것 set / 사라진 것 per-object clear).
        for (const [d, c] of targetColor) {
          if (colorNow.get(d) !== c.key) {
            viewer.setThemingColor?.(d, c.vec, model, true);
            changed = true;
          }
        }
        for (const [d] of colorNow) {
          if (!targetColor.has(d)) {
            viewer.clearThemingColor?.(d, model);
            changed = true;
          }
        }

        // 4) 상태 커밋 + **바뀐 게 있을 때만** clear 없는 invalidate.
        //    (스크럽/재생 중 실제 변화 없는 틱은 다시 그리지 않아 렉·렌더 churn 감소.)
        hiddenNow = targetHidden;
        colorNow = new Map([...targetColor].map(([d, c]) => [d, c.key]));
        if (changed) viewer.impl?.invalidate?.(false, true, false);
      } catch {
        /* 무시 */
      }
    },

    clearConstruction() {
      if (!viewer) return;
      try {
        // 숨김/색을 한 번에 원복. 여기서만 전역 clear 사용(재생 중 아님 → 깜빡여도 무해).
        if (hiddenNow.size) viewer.show?.([...hiddenNow], model);
        viewer.clearThemingColors?.(model);
        viewer.showAll?.();
        hiddenNow = new Set();
        colorNow = new Map();
        viewer.impl?.invalidate?.(true, true, false);
      } catch {
        /* 무시 */
      }
    },

    setPlaybackActive(active: boolean) {
      if (!viewer) return;
      try {
        // 재생 중 렌더 비용을 낮춘다(사용자 지적: 재생 시 렉·"렌더링 중" churn).
        //  - setOptimizeNavigation: 이동/갱신 중 디테일을 낮춰 프레임을 빨리 그림(공개 API).
        //  - progressive 렌더 OFF: 매 프레임 한 번에 그려 진행바("렌더링 중") 억제(버전별 방어).
        viewer.setOptimizeNavigation?.(active);
        viewer.setProgressiveRendering?.(!active);
        viewer.impl?.setProgressiveRendering?.(!active);
        // 멈추면 한 번 정식 렌더로 화질 복원.
        if (!active) viewer.impl?.invalidate?.(true, true, false);
      } catch {
        /* 무시 */
      }
    },

    focusObjects(refs) {
      if (!viewer || !refs?.length) return;
      try {
        const dbIds = refs.filter((r) => r.modelID === modelID).map((r) => r.expressID);
        if (!dbIds.length) return;
        viewer.select?.(dbIds, model);
        viewer.fitToView?.(dbIds, model, false);
      } catch {
        /* 무시 */
      }
    },
  };
}
