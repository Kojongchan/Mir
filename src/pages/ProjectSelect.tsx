import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import { listProjects, type Project } from '../lib/api';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { useAuth } from '../auth/AuthProvider';
import { ThemeToggle } from '../components/ThemeToggle';
import { BrandLogo } from '../components/BrandLogo';

export function ProjectSelect() {
  const navigate = useNavigate();
  const { profile, signOut } = useAuth();
  useDocumentTitle('프로젝트 선택');
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProjects()
      .then(setProjects)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
    // The next screen is the project dashboard (lazy, with charts): fetch it while the user picks.
    const prefetch = () => void import('./Dashboard');
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
    if (w.requestIdleCallback) w.requestIdleCallback(prefetch); else setTimeout(prefetch, 1500);
  }, []);

  return (
    <div className="auth-screen">
      <div className="auth-card wide">
        <div className="select-head">
          <div>
            <div className="auth-brand small"><BrandLogo size="md" /></div>
            <p className="muted">{profile?.full_name ?? profile?.username} 님, 프로젝트를 선택하세요</p>
          </div>
          <div className="select-head-actions">
            <ThemeToggle />
            {profile?.is_admin && (
              <button onClick={() => navigate('/admin')}>관리자 콘솔</button>
            )}
            <button onClick={signOut}>로그아웃</button>
          </div>
        </div>

        {loading && (
          <div aria-busy="true" aria-live="polite">
            <span className="sr-only">불러오는 중…</span>
            <div className="skeleton skeleton--block" style={{ height: 56, marginBottom: 8 }} />
            <div className="skeleton skeleton--block" style={{ height: 56 }} />
          </div>
        )}
        {error && <div className="auth-error">{error}</div>}
        {!loading && !error && projects.length === 0 && (
          <EmptyState icon="🗃" title="접근 가능한 프로젝트가 없습니다" desc="관리자에게 문의하세요." />
        )}

        <ul className="project-list">
          {projects.map((p) => (
            <li key={p.id}>
              <button className="project-item" onClick={() => navigate(`/project/${p.id}`)}>
                <span className="project-name">{p.name}</span>
                {p.code && <span className="project-code">{p.code}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
