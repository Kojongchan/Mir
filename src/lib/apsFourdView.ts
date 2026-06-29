import * as THREE from 'three';
import type { AppearanceSettings } from '../viewer/IfcViewer';
import type { CellState, ElementInfo, FourDViewer } from './fourd';
import type { ApsElement } from './apsElements';

// =====================================================================
// APS 4D 어댑터 — S50. Timeline.tsx(손대지 않음) 가 기대하는 FourDViewer 인터페이스
// (getElementCatalog/applyConstruction/clearConstruction) 를 APS Viewer 위에서
// 구현한다. apsClashView.ts 와 동일한 setThemingColor/isolate 류 호출을 쓰지만,
// 4D 는 동시에 여러 disjoint 상태 그룹(숨김/고스트/시공중/철거중/완료)이 필요해
// 전역 isolate 대신 **per-object** viewer.hide(dbId)/show(dbId) 를 사용한다.
// 색은 setThemingColor 로만 표현(전역 clearThemingColors 로 매 틱 리셋 후 재적용 —
// 공정표 규모가 작아 비용 무시 가능. 모델이 커지면 추후 diff 최적화).
// =====================================================================

type ApsViewer = any;
type ApsModel = any;

function hexToVec4(hex: string, alpha: number): THREE.Vector4 {
  const c = new THREE.Color(hex);
  return new THREE.Vector4(c.r, c.g, c.b, alpha);
}

/**
 * APS 모델 1개를 위한 FourDViewer 어댑터를 만든다. `modelID` 슬롯에는 `model.id`,
 * `expressID` 슬롯에는 dbId 를 담아 fourd.ts 의 ElementRef 규약을 그대로 따른다.
 */
export function createApsFourDViewer(
  viewer: ApsViewer,
  model: ApsModel,
  elements: ApsElement[],
): FourDViewer {
  const modelID: number = model?.id ?? 0;
  // 비어 있으면 모델 전체를 고스트로 만들기 위한 센티넬(존재하지 않는 dbId).
  const GHOST_ALL = [2147483647];
  let prevVisKey = '';
  let prevColorKey = '';

  const colorFor = (state: CellState, opts: AppearanceSettings): THREE.Vector4 | null => {
    switch (state) {
      case 'active-construct':
        return hexToVec4(opts.colorConstruct, opts.activeOpacity);
      case 'active-demolish':
        return hexToVec4(opts.colorDemolish, opts.activeOpacity);
      case 'active-temporary':
        return hexToVec4(opts.colorTemporary, opts.activeOpacity);
      case 'active-early':
        return hexToVec4(opts.colorEarly, opts.activeOpacity);
      case 'active-late':
        return hexToVec4(opts.colorLate, opts.activeOpacity);
      default:
        return null; // ghost/hidden/normal — 활성 색 없음
    }
  };

  return {
    getElementCatalog(): ElementInfo[] {
      return elements.map((e) => ({ modelID, expressID: e.dbId, name: e.name }));
    },

    // 나비스웍스 TimeLiner 식 표현: 매 시점에 "이미 시공됨(완료)+시공/철거 중" 객체만
    // isolate 로 또렷이 보이게 하고, 나머지(미시공·미매핑)는 자동으로 반투명 고스트가
    // 된다. 진행 중 객체는 유형별 색(생성/철거/임시/빠름/늦음)으로 칠한다.
    applyConstruction(
      states: Iterable<{ modelID: number; expressID: number; state: CellState }>,
      opts: AppearanceSettings,
    ) {
      if (!viewer) return;
      const visible: number[] = []; // 완료(normal) + 진행중(active-*) → 또렷이
      const colors: Array<[number, THREE.Vector4]> = [];
      for (const { modelID: m, expressID, state } of states) {
        if (m !== modelID) continue;
        if (state === 'hidden' || state === 'ghost') continue; // 미시공/철거완료 → 고스트
        visible.push(expressID);
        const c = colorFor(state, opts);
        if (c) colors.push([expressID, c]);
      }
      try {
        const visKey = visible.length ? visible.slice().sort((a, b) => a - b).join(',') : '∅';
        const colorKey = `${opts.colorConstruct}|${opts.colorDemolish}|${opts.colorTemporary}|${opts.colorEarly}|${opts.colorLate}|${opts.activeOpacity}|` +
          colors.map(([d]) => d).sort((a, b) => a - b).join(',');
        if (visKey === prevVisKey && colorKey === prevColorKey) return; // 변화 없음
        prevVisKey = visKey;
        prevColorKey = colorKey;

        // isolate: 지정 객체만 또렷이, 나머지는 반투명 고스트(전체 베이스라인).
        viewer.isolate?.(visible.length ? visible : GHOST_ALL, model);
        // 활성 객체에 유형별 색.
        viewer.clearThemingColors?.(model);
        for (const [dbId, c] of colors) viewer.setThemingColor?.(dbId, c, model, true);
        viewer.impl?.invalidate?.(true, true, true);
      } catch {
        /* 무시 */
      }
    },

    clearConstruction() {
      if (!viewer) return;
      try {
        prevVisKey = '';
        prevColorKey = '';
        viewer.clearThemingColors?.(model);
        viewer.isolate?.([], model); // 격리 해제 → 전체 정상 표시
        viewer.showAll?.();
        viewer.impl?.invalidate?.(true, true, true);
      } catch {
        /* 무시 */
      }
    },

    setPlaybackActive(active: boolean) {
      if (!viewer) return;
      try {
        // 재생 중: progressive 렌더 OFF → 매 틱 전체를 한 번에 그려 깜빡임 제거.
        // 멈춤: ON → 회전 시 부드럽게(점진 렌더).
        viewer.setProgressiveRendering?.(!active);
        viewer.impl?.invalidate?.(false, true, false);
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
