import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listProjects, type Project } from '../lib/api';
import { useAuth } from '../auth/AuthProvider';

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
            <div className="auth-brand small">MIR_VDC</div>
            <p className="muted">{profile?.full_name ?? profile?.username} 님, 프로젝트를 선택하세요</p>
          </div>
          <div className="select-head-actions">
            {profile?.is_admin && (
              <button onClick={() => navigate('/admin')}>관리자 콘솔</button>
            )}
            <button onClick={signOut}>로그아웃</button>
          </div>
        </div>

        {loading && <p className="muted">불러오는 중…</p>}
        {error && <div className="auth-error">{error}</div>}
        {!loading && !error && projects.length === 0 && (
          <p className="muted">접근 가능한 프로젝트가 없습니다. 관리자에게 문의하세요.</p>
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
