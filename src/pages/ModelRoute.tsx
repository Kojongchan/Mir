import { lazy, useEffect, useState, type ComponentType } from 'react';
import { useLocation, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { useProjectRole } from '../auth/useProjectRole';
import { getProjectViewer, type ViewerEngine } from '../lib/api';
import { RouteFallback } from '../components/RouteFallback';
import type { ViewerUnavailable } from './ThreeDTest2';
import { isMirView } from '../components/model/MirIssueLayer';

const named = <T extends string>(p: Promise<Record<T, ComponentType<any>>>, key: T) =>
  p.then((m) => ({ default: m[key] }));
const AccModels = lazy(() => named(import('./AccModels'), 'AccModels'));
const ThreeDTest2 = lazy(() => named(import('./ThreeDTest2'), 'ThreeDTest2'));

/** Why 통합모델(3D) opened in the Autodesk viewer although the project uses the own engine (managers only). */
const FALLBACK_NOTE: Record<ViewerUnavailable, string> = {
  'no-mapping': '이 현장은 ACC 프로젝트가 아직 연결되지 않아 기존 뷰어에서 연결합니다.',
  'no-model': '통합모델(3D)용 모델이 아직 지정되지 않아 기존 뷰어로 표시합니다.',
  'no-tiles': '지정한 모델에 자체 엔진용 타일이 아직 없어 기존(Autodesk) 뷰어로 표시합니다. 타일을 만들면 자체 엔진으로 열립니다.',
};

/**
 * 통합모델(3D): the viewer the system admin chose for this project (0043 viewer_engine) — the own engine
 * (three.js + 3D Tiles) by default, the Autodesk viewer when set to 'aps' or when the own engine has nothing to show.
 */
export function ModelRoute({ purpose = 'model' }: { purpose?: 'model' | 'clash' } = {}) {
  const { projectId = '' } = useParams();
  const { profile } = useAuth();
  const { canManage } = useProjectRole(projectId);
  const [engine, setEngine] = useState<ViewerEngine | null>(null);
  const [fallback, setFallback] = useState<ViewerUnavailable | null>(null);
  const [params] = useSearchParams();
  const location = useLocation();
  // Links the own engine does not take open the Autodesk viewer: a version picked in 자료 관리 (?urn=), a viewpoint
  // saved in the Autodesk viewer, and the old IFC-viewer links. 이슈 「위치 보기」(?focusGlobalId=) and viewpoints saved
  // in the own engine open here.
  const state = location.state as Record<string, unknown> | null;
  const apsLink = params.has('urn')
    || !!(state && (('applyApsState' in state && !isMirView(state.applyApsState)) || 'openViewpoint' in state || 'focus' in state));

  useEffect(() => {
    let alive = true;
    setEngine(null);
    setFallback(null);
    void getProjectViewer(projectId).then((e) => { if (alive) setEngine(e); });
    return () => { alive = false; };
  }, [projectId, purpose]);

  if (!engine) return <RouteFallback />;
  const clash = purpose === 'clash';
  if (engine === 'aps' || apsLink) return <AccModels key={`aps-${purpose}-${projectId}`} autoClash={clash} />;
  if (fallback) {
    const note = canManage || profile?.is_admin ? FALLBACK_NOTE[fallback].replace('통합모델(3D)', clash ? '간섭검토' : '통합모델(3D)') : undefined;
    return <AccModels key={`fallback-${purpose}-${projectId}`} autoClash={clash} notice={note} />;
  }
  return <ThreeDTest2 key={`mir-${purpose}-${projectId}`} variant="svf" project purpose={purpose} onUnavailable={setFallback} />;
}

export default ModelRoute;
