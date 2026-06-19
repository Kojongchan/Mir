import { NavLink, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';

interface Item {
  to: string;
  icon: string;
  label: string;
  end?: boolean;
  adminOnly?: boolean;
}

/** Left module rail for the project portal (PMIS-style navigation). */
export function ProjectNav() {
  const { projectId = '' } = useParams();
  const { profile } = useAuth();
  const base = `/project/${projectId}`;

  const items: Item[] = [
    { to: base, icon: '📊', label: '사업개요', end: true },
    { to: `${base}/schedule`, icon: '📅', label: '공정현황' },
    { to: `${base}/logs`, icon: '📝', label: '공사일보' },
    { to: `${base}/issues`, icon: '💬', label: '협업 · 이슈' },
    { to: `${base}/viewer`, icon: '🧊', label: '모델뷰어 (3D)' },
    { to: `${base}/docs`, icon: '🗂', label: '자료 관리' },
    { to: '/admin', icon: '👥', label: '구성원·권한', adminOnly: true },
  ];

  return (
    <nav className="portal-nav">
      {items
        .filter((it) => !it.adminOnly || profile?.is_admin)
        .map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            end={it.end}
            className={({ isActive }) => `portal-nav-item${isActive ? ' is-active' : ''}`}
          >
            <span className="portal-nav-ico">{it.icon}</span>
            <span className="portal-nav-label">{it.label}</span>
          </NavLink>
        ))}
    </nav>
  );
}
