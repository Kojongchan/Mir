import { NavLink, useParams } from 'react-router-dom';
import { useProjectRole } from '../auth/useProjectRole';
import { Icon } from './icons/Icon';
import { useProjectMenus, visibleMenus } from '../lib/projectMenus';

/** Left module rail for the project portal (PMIS-style navigation).
 *  U-Shell: 라이트 톤 + 커스텀 도메인 아이콘(레드닷·currentColor). 활성 항목은
 *  aria-current="page" + brand 강조. collapse 시 라벨은 CSS 로 숨김(aria-label 유지).
 *  메뉴 목록은 현장별 설정(0042 enabled_menus)을 따른다 — 설정이 없으면 전체. */
export function ProjectNav() {
  const { projectId = '' } = useParams();
  const { canManage } = useProjectRole(projectId);
  const { enabled, ready } = useProjectMenus(projectId);
  const base = `/project/${projectId}`;
  const items = ready ? visibleMenus(enabled, canManage) : [];

  return (
    <nav className="app-sidebar" aria-label="메인 네비게이션">
      {items.map((it) => {
        const to = it.path ? `${base}/${it.path}` : base;
        return (
          <NavLink
            key={it.key}
            to={to}
            end={!it.path}
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
        );
      })}
    </nav>
  );
}
