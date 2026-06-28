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
  // 직전 틱의 (가시성·색) 시그니처. 매 틱 전체를 다시 칠하지 않고 바뀐 것만
  // 갱신해 LMV 재렌더 부담을 줄인다(객체가 깜빡이며 사라지는 현상 완화).
  let prevSig = new Map<number, string>();
  const CLEAR = new THREE.Vector4(0, 0, 0, 0);

  const colorFor = (state: CellState, opts: AppearanceSettings): THREE.Vector4 | null => {
    switch (state) {
      case 'ghost':
        return opts.ghostFuture ? GHOST : null;
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
        return null; // hidden/normal — 테마색 없음
    }
  };
  const isHidden = (state: CellState, opts: AppearanceSettings): boolean =>
    state === 'hidden' || (state === 'ghost' && !opts.ghostFuture);

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
        const optSig = `${opts.activeOpacity}|${opts.colorConstruct}|${opts.colorDemolish}|${opts.colorTemporary}|${opts.colorEarly}|${opts.colorLate}|${opts.ghostFuture}`;
        const nextSig = new Map<number, string>();
        for (const [dbId, state] of desired) nextSig.set(dbId, `${state}|${optSig}`);

        // 변경이 전혀 없으면 아무 것도 하지 않는다(불필요한 재렌더 방지).
        if (nextSig.size === prevSig.size) {
          let same = true;
          for (const [dbId, sig] of nextSig) {
            if (prevSig.get(dbId) !== sig) {
              same = false;
              break;
            }
          }
          if (same) return;
        }

        const newHidden = new Set<number>();
        let changed = false;

        // 1) 직전엔 제어했지만 이번엔 빠진(=normal 복귀) 객체: 보이게 + 테마 해제.
        for (const [dbId] of prevSig) {
          if (!nextSig.has(dbId)) {
            viewer.show?.(dbId);
            viewer.setThemingColor?.(dbId, CLEAR, model, true);
            changed = true;
          }
        }

        // 2) 이번 틱 객체: 시그니처가 바뀐 것만 가시성·색 갱신.
        for (const [dbId, state] of desired) {
          const sigChanged = prevSig.get(dbId) !== nextSig.get(dbId);
          if (isHidden(state, opts)) {
            viewer.hide?.(dbId);
            newHidden.add(dbId);
          } else {
            if (hiddenDbIds.has(dbId)) viewer.show?.(dbId);
            if (sigChanged) {
              const color = colorFor(state, opts);
              viewer.setThemingColor?.(dbId, color ?? CLEAR, model, true);
            }
          }
          if (sigChanged) changed = true;
        }

        hiddenDbIds = newHidden;
        prevSig = nextSig;
        // needsClear=false 로 전체 클리어 없이 다시 그린다(깜빡임 완화).
        if (changed) viewer.impl?.invalidate?.(false, true, false);
      } catch {
        /* 무시 */
      }
    },

    clearConstruction() {
      if (!viewer) return;
      try {
        for (const dbId of hiddenDbIds) viewer.show?.(dbId);
        hiddenDbIds = new Set();
        prevSig = new Map();
        viewer.clearThemingColors?.(model);
        viewer.impl?.invalidate?.(false, true, false);
      } catch {
        /* 무시 */
      }
    },
  };
}
