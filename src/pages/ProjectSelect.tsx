import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import { listProjects, type Project } from '../lib/api';
import { useAuth } from '../auth/AuthProvider';
import { ThemeToggle } from '../components/ThemeToggle';
import { BrandLogo } from '../components/BrandLogo';

export function ProjectSelect() {
  const navigate = useNavigate();
  const { profile, signOut } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProjects()
      .then(setProjects)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
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
