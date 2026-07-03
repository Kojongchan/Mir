import { NavLink } from 'react-router-dom';

/** 협업 묶음 탭(이슈·RFI·Punch) — 세 페이지 공통. */
export function collabTabs(projectId: string) {
  return [
    { to: `/project/${projectId}/issues`, label: '이슈', end: true },
    { to: `/project/${projectId}/rfi`, label: 'RFI' },
    { to: `/project/${projectId}/punch`, label: 'Punch' },
  ];
}

/** 원가 묶음 탭(기성내역·EVM) — 두 페이지 공통. */
export function costTabs(projectId: string) {
  return [
    { to: `/project/${projectId}/billing`, label: '기성내역', end: true },
    { to: `/project/${projectId}/evm`, label: 'EVM 원가' },
  ];
}

/** 한 메뉴 안에서 여러 하위 화면을 탭으로 전환(협업: 이슈/RFI/Punch, 원가: 기성/EVM 등). */
export function ModuleTabs({ tabs }: { tabs: { to: string; label: string; end?: boolean }[] }) {
  return (
    <div className="mod-tabs" role="tablist">
      {tabs.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          role="tab"
          className={({ isActive }) => `mod-tab${isActive ? ' is-active' : ''}`}
        >
          {t.label}
        </NavLink>
      ))}
    </div>
  );
}
