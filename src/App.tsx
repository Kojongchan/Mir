import type { ReactElement } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { Login } from './pages/Login';
import { ProjectSelect } from './pages/ProjectSelect';
import { Workspace } from './pages/Workspace';
import { ProjectShell } from './pages/ProjectShell';
import { Dashboard } from './pages/Dashboard';
import { Schedule } from './pages/Schedule';
import { DailyLogs } from './pages/DailyLogs';
import { Issues } from './pages/Issues';
import { Billing } from './pages/Billing';
import { Subcontracts } from './pages/Subcontracts';
import { Board } from './pages/Board';
import { DocumentManager } from './pages/DocumentManager';
import { Drawings } from './pages/Drawings';
import { Admin } from './pages/Admin';
import { FileViewer } from './pages/FileViewer';

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
      <BrowserRouter>
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
            <Route path="billing" element={<Billing />} />
            <Route path="subcontracts" element={<Subcontracts />} />
            <Route path="board" element={<Board />} />
            {/* Modules with their own sub-tree — rendered inside the shell so the
                left module rail stays put and only the right side changes. */}
            {/* 통합모델(3D) · 공정관리(4D) · 간섭체크 — 각 모듈이 자기 용도의
                모델 세트만 보도록 mode 로 구분(S33). 'viewer' 는 4D 하위호환 별칭. */}
            <Route path="model" element={<Workspace mode="integrated" />} />
            <Route path="viewer" element={<Workspace mode="4d" />} />
            <Route path="clash" element={<Workspace mode="clash" />} />
            <Route path="drawings" element={<Drawings />} />
            <Route path="docs" element={<DocumentManager />} />
            <Route path="members" element={<AdminOnly><Admin embedded /></AdminOnly>} />
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
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
