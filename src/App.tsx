import { lazy, Suspense, type ReactElement } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { Login } from './pages/Login';
import { ProjectSelect } from './pages/ProjectSelect';

// 무거운 화면은 지연 로딩해 초기 번들에서 제외한다.
// (Workspace 는 three/web-ifc 를 끌어오므로 별도 async 청크로 분리됨)
const Workspace = lazy(() =>
  import('./pages/Workspace').then((m) => ({ default: m.Workspace })),
);
const Admin = lazy(() => import('./pages/Admin').then((m) => ({ default: m.Admin })));

function RouteFallback() {
  return (
    <div className="auth-screen">
      <p className="muted">로딩 중…</p>
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
            <Route
              path="/project/:projectId"
              element={
                <Protected>
                  <Workspace />
                </Protected>
              }
            />
            <Route
              path="/admin"
              element={
                <AdminOnly>
                  <Admin />
                </AdminOnly>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </AuthProvider>
  );
}
