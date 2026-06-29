import { NavLink, useParams } from 'react-router-dom';
import { useProjectRole } from '../auth/useProjectRole';

interface Item {
  to: string;
  icon: string;
  label: string;
  end?: boolean;
  /** 보임 조건: 멤버·역할 관리 권한(프로젝트 관리자 또는 시스템 관리자). */
  manageOnly?: boolean;
}

/** Left module rail for the project portal (PMIS-style navigation). */
export function ProjectNav() {
  const { projectId = '' } = useParams();
  const { canManage } = useProjectRole(projectId);
  const base = `/project/${projectId}`;

  const items: Item[] = [
    { to: base, icon: '📊', label: '사업개요', end: true },
    { to: `${base}/schedule`, icon: '📅', label: '공정현황' },
    { to: `${base}/model`, icon: '🧊', label: '통합모델 (3D)' },
    { to: `${base}/viewer`, icon: '🏗', label: '공정관리 (4D)' },
    { to: `${base}/clash`, icon: '🔍', label: '간섭검토' },
    { to: `${base}/quantities`, icon: '🧮', label: '물량 산출 (QTO)' },
    { to: `${base}/drawings`, icon: '📐', label: '도면 (2D)' },
    { to: `${base}/logs`, icon: '📝', label: '공사일보' },
    { to: `${base}/issues`, icon: '💬', label: '협업 · 이슈' },
    { to: `${base}/billing`, icon: '💰', label: '기성내역' },
    { to: `${base}/subcontracts`, icon: '🤝', label: '하도급내역' },
    { to: `${base}/board`, icon: '📢', label: '게시판' },
    { to: `${base}/docs`, icon: '🗂', label: '자료 관리' },
    { to: `${base}/members`, icon: '👥', label: '구성원·권한', manageOnly: true },
  ];

  return (
    <nav className="portal-nav">
      {items
        .filter((it) => !it.manageOnly || canManage)
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
