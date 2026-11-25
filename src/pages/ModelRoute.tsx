import { lazy, useEffect, useState, type ComponentType } from 'react';
import { useLocation, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { useProjectRole } from '../auth/useProjectRole';
import { getProjectViewer, type ViewerEngine } from '../lib/api';
import { RouteFallback } from '../components/RouteFallback';
import type { ViewerUnavailable } from './ThreeDTest2';

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
export function ModelRoute() {
  const { projectId = '' } = useParams();
  const { profile } = useAuth();
  const { canManage } = useProjectRole(projectId);
  const [engine, setEngine] = useState<ViewerEngine | null>(null);
  const [fallback, setFallback] = useState<ViewerUnavailable | null>(null);
  const [params] = useSearchParams();
  const location = useLocation();
  // Links the own engine does not take yet (이슈 위치·뷰포인트, 자료관리의 특정 버전 열기) open the Autodesk viewer.
  const state = location.state as Record<string, unknown> | null;
  const apsLink = params.has('urn') || params.has('focusGlobalId') || !!(state && ('applyApsState' in state || 'openViewpoint' in state || 'focus' in state));

  useEffect(() => {
    let alive = true;
    setEngine(null);
    setFallback(null);
    void getProjectViewer(projectId).then((e) => { if (alive) setEngine(e); });
    return () => { alive = false; };
  }, [projectId]);

  if (!engine) return <RouteFallback />;
  if (engine === 'aps' || apsLink) return <AccModels key={`aps-${projectId}`} />;
  if (fallback) {
    const note = canManage || profile?.is_admin ? FALLBACK_NOTE[fallback] : undefined;
    return <AccModels key={`fallback-${projectId}`} notice={note} />;
  }
  return <ThreeDTest2 key={`mir-${projectId}`} variant="svf" project onUnavailable={setFallback} />;
}

export default ModelRoute;
