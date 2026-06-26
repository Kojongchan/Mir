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

const GHOST = new THREE.Vector4(0x6b / 255, 0x76 / 255, 0x86 / 255, 0.14);

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
  let hiddenDbIds = new Set<number>();

  return {
    getElementCatalog(): ElementInfo[] {
      return elements.map((e) => ({ modelID, expressID: e.dbId, name: e.name }));
    },

    applyConstruction(
      states: Iterable<{ modelID: number; expressID: number; state: CellState }>,
      opts: AppearanceSettings,
    ) {
      if (!viewer) return;
      const desired = new Map<number, CellState>();
      for (const { modelID: m, expressID, state } of states) {
        if (m !== modelID) continue;
        desired.set(expressID, state);
      }

      try {
        // 이전 틱에서 숨겼던 것 중 이번에 더 이상 숨길 필요 없는 건 먼저 복원.
        for (const dbId of hiddenDbIds) {
          const next = desired.get(dbId);
          const stillHidden = next === 'hidden' || (next === 'ghost' && !opts.ghostFuture);
          if (!stillHidden) viewer.show?.(dbId);
        }

        viewer.clearThemingColors?.(model);

        const newHidden = new Set<number>();
        for (const [dbId, state] of desired) {
          switch (state) {
            case 'hidden':
              viewer.hide?.(dbId);
              newHidden.add(dbId);
              break;
            case 'ghost':
              if (opts.ghostFuture) {
                viewer.show?.(dbId);
                viewer.setThemingColor?.(dbId, GHOST, model, true);
              } else {
                viewer.hide?.(dbId);
                newHidden.add(dbId);
              }
              break;
            case 'normal':
              viewer.show?.(dbId);
              break;
            case 'active-construct':
              viewer.show?.(dbId);
              viewer.setThemingColor?.(dbId, hexToVec4(opts.colorConstruct, opts.activeOpacity), model, true);
              break;
            case 'active-demolish':
              viewer.show?.(dbId);
              viewer.setThemingColor?.(dbId, hexToVec4(opts.colorDemolish, opts.activeOpacity), model, true);
              break;
            case 'active-temporary':
              viewer.show?.(dbId);
              viewer.setThemingColor?.(dbId, hexToVec4(opts.colorTemporary, opts.activeOpacity), model, true);
              break;
          }
        }
        hiddenDbIds = newHidden;
        viewer.impl?.invalidate?.(true, true, true);
      } catch {
        /* 무시 */
      }
    },

    clearConstruction() {
      if (!viewer) return;
      try {
        for (const dbId of hiddenDbIds) viewer.show?.(dbId);
        hiddenDbIds = new Set();
        viewer.clearThemingColors?.(model);
        viewer.impl?.invalidate?.(true, true, true);
      } catch {
        /* 무시 */
      }
    },
  };
}
