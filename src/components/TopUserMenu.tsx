import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import {
  ROLE_LABEL,
  SYSTEM_ADMIN_LABEL,
  useProjectRole,
} from '../auth/useProjectRole';
import { UiIcon } from './icons/UiIcon';

/** 상단바 계정 메뉴 — 아바타+이름 트리거, 클릭 시 이름·역할(권한)·로그아웃 드롭다운.
 *  기존의 평면 이름 노출 + 별도 로그아웃 아이콘을 하나로 통합(U-Shell 후속). */
export function TopUserMenu({ projectId }: { projectId: string }) {
  const { signOut, profile } = useAuth();
  const { role, isSystemAdmin } = useProjectRole(projectId);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const displayName = profile?.full_name ?? profile?.username ?? '사용자';
  const initial = displayName.trim().charAt(0) || '·';
  const roleLabel = isSystemAdmin
    ? SYSTEM_ADMIN_LABEL
    : role
      ? ROLE_LABEL[role]
      : '게스트';

  return (
    <div className="user-menu" ref={ref}>
      <button
        type="button"
        className="user-menu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title={displayName}
      >
        <span className="avatar" aria-hidden>{initial}</span>
        <span className="topbar-user__name">{displayName}</span>
        <UiIcon name="chevron-down" size={16} />
      </button>
      {open && (
        <div className="user-menu__panel" role="menu">
          <div className="user-menu__head">
            <span className="avatar avatar--lg" aria-hidden>{initial}</span>
            <div className="user-menu__id">
              <span className="user-menu__name">{displayName}</span>
              <span className="badge badge--info">{roleLabel}</span>
            </div>
          </div>
          <button
            type="button"
            className="user-menu__item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void signOut();
            }}
          >
            <UiIcon name="logout" size={16} />
            로그아웃
          </button>
        </div>
      )}
    </div>
  );
}
