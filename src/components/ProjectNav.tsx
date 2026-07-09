import { NavLink, useParams } from 'react-router-dom';
import { useProjectRole } from '../auth/useProjectRole';
import { Icon, type IconName } from './icons/Icon';

interface Item {
  to: string;
  icon: IconName;
  label: string;
  end?: boolean;
  /** 보임 조건: 멤버·역할 관리 권한(프로젝트 관리자 또는 시스템 관리자). */
  manageOnly?: boolean;
}

/** Left module rail for the project portal (PMIS-style navigation).
 *  U-Shell: 라이트 톤 + 커스텀 도메인 아이콘(레드닷·currentColor). 활성 항목은
 *  aria-current="page" + brand 강조. collapse 시 라벨은 CSS 로 숨김(aria-label 유지). */
export function ProjectNav() {
  const { projectId = '' } = useParams();
  const { canManage } = useProjectRole(projectId);
  const base = `/project/${projectId}`;

  const items: Item[] = [
    { to: base, icon: 'dashboard', label: '사업개요', end: true },
    { to: `${base}/schedule`, icon: 'schedule', label: '공정현황' },
    { to: `${base}/model`, icon: 'model-3d', label: '통합모델 (3D)' },
    { to: `${base}/viewer`, icon: 'schedule-4d', label: '공정관리 (4D)' },
    { to: `${base}/clash`, icon: 'clash', label: '간섭검토' },
    { to: `${base}/quantities`, icon: 'qto', label: '물량 산출 (QTO)' },
    { to: `${base}/drawings`, icon: 'drawing', label: '도면 (2D)' },
    { to: `${base}/logs`, icon: 'daily-report', label: '공사일보' },
    { to: `${base}/issues`, icon: 'issue', label: '협업 · 이슈' },
    { to: `${base}/billing`, icon: 'billing', label: '기성내역' },
    { to: `${base}/subcontracts`, icon: 'subcontract', label: '하도급내역' },
    { to: `${base}/board`, icon: 'board', label: '게시판' },
    { to: `${base}/docs`, icon: 'files', label: '자료 관리' },
    { to: `${base}/members`, icon: 'members', label: '구성원·권한', manageOnly: true },
  ];

  return (
    <nav className="app-sidebar" aria-label="메인 네비게이션">
      {items
        .filter((it) => !it.manageOnly || canManage)
        .map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            end={it.end}
            title={it.label}
            aria-label={it.label}
            className={({ isActive }) => `nav-item${isActive ? ' is-active' : ''}`}
          >
            {({ isActive }) => (
              <>
                <span className="nav-item__ico" aria-hidden>
                  <Icon name={it.icon} size={20} />
                </span>
                <span className="nav-item__label">{it.label}</span>
                {isActive && <span className="sr-only">(현재 페이지)</span>}
              </>
            )}
          </NavLink>
        ))}
    </nav>
  );
}
