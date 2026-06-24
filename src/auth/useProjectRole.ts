import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from './AuthProvider';

// =====================================================================
// 프로젝트별 역할(RBAC) — 0023. project_members.role + profiles.is_admin.
//
//   뷰어(viewer)        : 읽기·미리보기만(다운로드 UI 숨김).
//   실무자(editor)      : 콘텐츠 쓰기 전부.
//   관리자(admin, 프로젝트): 실무자 + 설정 + 역할 부여.
//   시스템 관리자(is_admin): 최상위(전 프로젝트).
// =====================================================================

export type ProjectRole = 'viewer' | 'editor' | 'admin';

/** 내부 role 값 → 화면 명칭. */
export const ROLE_LABEL: Record<ProjectRole, string> = {
  viewer: '뷰어',
  editor: '실무자',
  admin: '관리자',
};

/** 역할 부여 UI 의 선택지(시스템 관리자는 profiles.is_admin 으로 별도 관리). */
export const ASSIGNABLE_ROLES: ProjectRole[] = ['viewer', 'editor', 'admin'];

export const SYSTEM_ADMIN_LABEL = '시스템 관리자';

export interface ProjectRoleState {
  /** 이 프로젝트에서의 역할. 시스템 관리자는 'admin' 으로 승격해 노출. 멤버 아님 = null. */
  role: ProjectRole | null;
  /** 글로벌 시스템 관리자 여부. */
  isSystemAdmin: boolean;
  /** 열람 가능(멤버 또는 시스템 관리자). */
  canView: boolean;
  /** 콘텐츠 쓰기(실무자 이상). */
  canEdit: boolean;
  /** 설정·역할 부여(프로젝트 관리자 이상). */
  canManage: boolean;
  loading: boolean;
}

/**
 * 현재 사용자의 프로젝트 역할을 읽는다. 시스템 관리자는 모든 프로젝트에서
 * 관리자 권한을 가진다(project_members 행이 없어도). UI 게이팅 전용 — 실제
 * 강제는 RLS(0023)가 한다.
 */
export function useProjectRole(projectId: string | undefined): ProjectRoleState {
  const { profile } = useAuth();
  const isSystemAdmin = !!profile?.is_admin;
  const [role, setRole] = useState<ProjectRole | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    if (!projectId || !profile?.id) {
      setRole(null);
      setLoading(false);
      return;
    }
    // 시스템 관리자는 조회 없이 관리자 권한.
    if (isSystemAdmin) {
      setRole('admin');
      setLoading(false);
      return;
    }
    supabase
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', profile.id)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        const r = (data?.role as ProjectRole | undefined) ?? null;
        setRole(r && ['viewer', 'editor', 'admin'].includes(r) ? r : data ? 'viewer' : null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, profile?.id, isSystemAdmin]);

  const canManage = isSystemAdmin || role === 'admin';
  const canEdit = canManage || role === 'editor';
  const canView = isSystemAdmin || role !== null;

  return { role, isSystemAdmin, canView, canEdit, canManage, loading };
}
