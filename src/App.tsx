import { lazy, Suspense, type ComponentType, type ReactElement } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { UiIconSprite } from './components/icons/UiIcon';
// 셸/경량 페이지는 즉시 로드(첫 진입 지연 최소화).
import { Login } from './pages/Login';
import { ProjectSelect } from './pages/ProjectSelect';
import { ProjectShell } from './pages/ProjectShell';
import { Dashboard } from './pages/Dashboard';
import { Schedule } from './pages/Schedule';
import { DailyLogs } from './pages/DailyLogs';
import { Issues } from './pages/Issues';
import { RfiPage } from './pages/Rfi';
import { Meetings } from './pages/Meetings';
import { PunchPage } from './pages/Punch';
import { Submittals } from './pages/Submittals';
import { Billing } from './pages/Billing';
import { Board } from './pages/Board';
import { ProjectMembers } from './pages/ProjectMembers';

// Q1 코드 스플리팅 — 무거운 의존성(APS 뷰어·web-ifc·pdfjs·mammoth/xlsx·recharts)을 안은
// 페이지는 지연 로드해 초기 번들에서 분리한다. named export → default 로 감싼다.
const named = <T extends string>(p: Promise<Record<T, ComponentType<any>>>, key: T) =>
  p.then((m) => ({ default: m[key] }));
const DocumentManager = lazy(() => named(import('./pages/DocumentManager'), 'DocumentManager'));
const Drawings = lazy(() => named(import('./pages/Drawings'), 'Drawings'));
const Quantities = lazy(() => named(import('./pages/Quantities'), 'Quantities'));
const Admin = lazy(() => named(import('./pages/Admin'), 'Admin'));
const FileViewer = lazy(() => named(import('./pages/FileViewer'), 'FileViewer'));
const AccModels = lazy(() => named(import('./pages/AccModels'), 'AccModels'));
const StyleGuide = lazy(() => named(import('./pages/StyleGuide'), 'StyleGuide'));
// EVM(recharts)·HIBoard(recharts+realtime)는 무거운 의존성 → 지연 로드.
const Evm = lazy(() => named(import('./pages/Evm'), 'Evm'));
const HiBoard = lazy(() => named(import('./pages/HiBoard'), 'HiBoard'));

/** 지연 로드 라우트의 로딩 자리표시(Suspense fallback). */
function RouteFallback() {
  return (
    <div className="route-loading" aria-busy="true" aria-live="polite">
      <span className="sr-only">불러오는 중…</span>
      <div className="skeleton skeleton--block" style={{ height: 40, maxWidth: 320 }} />
    </div>
  );
}

function Protected({ children }: { children: ReactElement }) {
  const { session, loading } = useAuth();
  if (loading) {
    return (
      <div className="auth-screen">
        <p className="muted">로딩 중…</p>
      </div>
    );
  }
  if (!session) return <Navigate to="/login" replace />;
  return children;
}

function AdminOnly({ children }: { children: ReactElement }) {
  const { session, profile, loading } = useAuth();
  if (loading || (session && !profile)) {
    return (
      <div className="auth-screen">
        <p className="muted">권한 확인 중…</p>
      </div>
    );
  }
  if (!session) return <Navigate to="/login" replace />;
  if (!profile?.is_admin) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <AuthProvider>
      <UiIconSprite />
      <BrowserRouter>
        <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/"
            element={
              <Protected>
                <ProjectSelect />
              </Protected>
            }
          />
          {/* Project portal (사업개요 대시보드 + 좌측 모듈 메뉴) */}
          <Route
            path="/project/:projectId"
            element={
              <Protected>
                <ProjectShell />
              </Protected>
            }
          >
            <Route index element={<Dashboard />} />
            <Route path="schedule" element={<Schedule />} />
            <Route path="logs" element={<DailyLogs />} />
            <Route path="issues" element={<Issues />} />
            <Route path="rfi" element={<RfiPage />} />
            <Route path="punch" element={<PunchPage />} />
            <Route path="submittals" element={<Submittals />} />
            <Route path="evm" element={<Evm />} />
            <Route path="hiboard" element={<HiBoard />} />
            <Route path="meetings" element={<Meetings />} />
            <Route path="billing" element={<Billing />} />
            <Route path="board" element={<Board />} />
            {/* Modules with their own sub-tree — rendered inside the shell so the
                left module rail stays put and only the right side changes. */}
            {/* 통합모델(3D) · 공정관리(4D) · 간섭검토 — 모두 APS(ACC) 뷰어 기반(S52).
                각 모듈은 자료관리에서 고정한 자기 전용 모델(통합=acc_default,
                4D=acc_4d, 간섭=acc_clash)을 독립적으로 연다. IFC 뷰어(Workspace)와
                'ACC 모델' 단독 메뉴는 제거됨. */}
            {/* key 로 메뉴마다 별도 인스턴스 강제 — 같은 컴포넌트 타입이라 React 가
                인스턴스를 재사용하면 init effect([])·mode refs 가 첫 진입 모드로 고정돼
                세 뷰가 연동되는 문제가 생긴다(S52 버그). */}
            <Route path="model" element={<AccModels key="integrated" />} />
            {/* 공정관리(4D) = APS(ACC) 모델 위 4D 시뮬(S50). */}
            <Route path="viewer" element={<AccModels key="fourd" mode4d />} />
            {/* 간섭검토 = APS(ACC) 모델 위 간섭(S49). */}
            <Route path="clash" element={<AccModels key="clash" autoClash />} />
            <Route path="quantities" element={<Quantities />} />
            <Route path="drawings" element={<Drawings />} />
            <Route path="docs" element={<DocumentManager />} />
            <Route path="members" element={<ProjectMembers />} />
          </Route>
          <Route
            path="/admin"
            element={
              <AdminOnly>
                <Admin />
              </AdminOnly>
            }
          />
          <Route
            path="/view/:fileId"
            element={
              <Protected>
                <FileViewer />
              </Protected>
            }
          />
          {/* U1 디자인 시스템 데모(토큰·공통 컴포넌트) — 데이터 접근 없음 */}
          <Route path="/styleguide" element={<StyleGuide />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
      </BrowserRouter>
    </AuthProvider>
  );
}
