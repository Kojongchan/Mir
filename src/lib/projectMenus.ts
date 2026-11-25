import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import type { IconName } from '../components/icons/Icon';

/**
 * 현장별 메뉴(0042 enabled_menus). 시스템 관리자가 현장마다 보일 메뉴를 고른다 —
 * 예: 현장 공유용 현장은 통합모델(3D)·게시판·자료 관리·구성원·권한만.
 * 저장값이 없으면(null) 전체 메뉴. 메뉴를 숨기는 것은 화면 구성일 뿐 데이터 권한은
 * 그대로다(RLS·역할이 따로 막는다).
 */
export interface ProjectMenu {
  /** projects.enabled_menus 에 저장되는 키. */
  key: string;
  /** /project/:id 아래 경로('' = 첫 화면). */
  path: string;
  label: string;
  /** 모바일 하단 탭 라벨. */
  short: string;
  icon: IconName;
  /** 멤버·역할 관리 권한이 있을 때만 보임. */
  manageOnly?: boolean;
}

export const PROJECT_MENUS: readonly ProjectMenu[] = [
  { key: 'dashboard', path: '', label: '사업개요', short: '사업개요', icon: 'dashboard' },
  { key: 'schedule', path: 'schedule', label: '공정현황', short: '공정', icon: 'schedule' },
  { key: 'model', path: 'model', label: '통합모델 (3D)', short: '3D', icon: 'model-3d' },
  { key: 'viewer', path: 'viewer', label: '공정관리 (4D)', short: '4D', icon: 'schedule-4d' },
  { key: 'clash', path: 'clash', label: '간섭검토', short: '간섭', icon: 'clash' },
  { key: 'quantities', path: 'quantities', label: '물량 산출 (QTO)', short: '물량', icon: 'qto' },
  { key: 'drawings', path: 'drawings', label: '도면 (2D)', short: '도면', icon: 'drawing' },
  { key: 'logs', path: 'logs', label: '공사일보', short: '일보', icon: 'daily-report' },
  { key: 'issues', path: 'issues', label: '협업 · 이슈', short: '이슈', icon: 'issue' },
  { key: 'billing', path: 'billing', label: '기성내역', short: '기성', icon: 'billing' },
  { key: 'subcontracts', path: 'subcontracts', label: '하도급내역', short: '하도급', icon: 'subcontract' },
  { key: 'board', path: 'board', label: '게시판', short: '게시판', icon: 'board' },
  { key: 'docs', path: 'docs', label: '자료 관리', short: '자료', icon: 'files' },
  { key: 'members', path: 'members', label: '구성원·권한', short: '구성원', icon: 'members', manageOnly: true },
];

/** null = 전체 메뉴(설정 전 기본값). */
export type EnabledMenus = readonly string[] | null;

export function isMenuOn(enabled: EnabledMenus, key: string): boolean {
  return !enabled || enabled.includes(key);
}

/** 이 사용자에게 보일 메뉴(카탈로그 순서). */
export function visibleMenus(enabled: EnabledMenus, canManage: boolean): ProjectMenu[] {
  return PROJECT_MENUS.filter((m) => isMenuOn(enabled, m.key) && (!m.manageOnly || canManage));
}

/** /project/:id 아래 경로 → 메뉴. 카탈로그에 없는 경로는 null(메뉴 설정과 무관). */
export function menuForPath(sub: string): ProjectMenu | null {
  const seg = sub.replace(/^\/+/, '').split('/')[0] ?? '';
  return PROJECT_MENUS.find((m) => m.path === seg) ?? null;
}

/** 꺼진 메뉴로 들어왔을 때 보낼 첫 메뉴 경로. 보일 메뉴가 없으면 null. */
export function firstMenuPath(enabled: EnabledMenus, canManage: boolean): string | null {
  const m = visibleMenus(enabled, canManage)[0];
  return m ? m.path : null;
}

// 모바일 하단 탭: 지금까지의 5개(사업개요·공정·3D·일보·이슈)를 먼저, 꺼진 자리는 다음 순서로 채운다.
const BOTTOM_ORDER = [
  'dashboard', 'schedule', 'model', 'logs', 'issues',
  'board', 'docs', 'viewer', 'clash', 'drawings', 'quantities', 'billing', 'subcontracts', 'members',
];

export function bottomTabs(enabled: EnabledMenus, canManage: boolean, max = 5): ProjectMenu[] {
  const shown = new Map(visibleMenus(enabled, canManage).map((m) => [m.key, m]));
  return BOTTOM_ORDER.flatMap((k) => (shown.has(k) ? [shown.get(k)!] : [])).slice(0, max);
}

/** 저장할 값으로 정리: 모르는 키 제거, 카탈로그 순서, 전부 켜면 null(나중에 생기는 메뉴도 보이게). */
export function normalizeMenus(keys: readonly string[]): string[] | null {
  const set = new Set(keys);
  const out = PROJECT_MENUS.filter((m) => set.has(m.key)).map((m) => m.key);
  return out.length === PROJECT_MENUS.length ? null : out;
}

/** 현장의 메뉴 설정. 0042 미적용(컬럼 없음)·빈 배열은 전체 메뉴로 본다. */
export async function getProjectMenus(projectId: string): Promise<EnabledMenus> {
  const { data, error } = await supabase.from('projects').select('enabled_menus').eq('id', projectId).single();
  if (error || !data) return null;
  const v = (data as { enabled_menus?: unknown }).enabled_menus;
  return Array.isArray(v) && v.length > 0 ? (v as string[]) : null;
}

/** 메뉴 설정 저장(시스템 관리자 — projects update RLS). null = 전체 메뉴. */
export async function setProjectMenus(projectId: string, keys: readonly string[] | null): Promise<void> {
  const value = keys ? normalizeMenus(keys) : null;
  if (value && value.length === 0) throw new Error('메뉴를 하나 이상 켜야 합니다.');
  const { error } = await supabase.from('projects').update({ enabled_menus: value }).eq('id', projectId);
  if (error) {
    if (/enabled_menus/.test(error.message)) {
      throw new Error('DB에 메뉴 설정 칸이 아직 없습니다. Supabase에서 0042 마이그레이션을 먼저 실행하세요.');
    }
    throw error;
  }
  cache.set(projectId, value);
}

// 같은 현장 안에서 화면을 옮길 때 메뉴가 깜박이지 않도록 마지막 값을 기억한다.
const cache = new Map<string, EnabledMenus>();

export function useProjectMenus(projectId: string): { enabled: EnabledMenus; ready: boolean } {
  const cached = cache.has(projectId);
  const [state, setState] = useState<{ id: string; enabled: EnabledMenus; ready: boolean }>(() => ({
    id: projectId,
    enabled: cache.get(projectId) ?? null,
    ready: cached,
  }));
  useEffect(() => {
    let alive = true;
    if (!projectId) return;
    void getProjectMenus(projectId).then((enabled) => {
      cache.set(projectId, enabled);
      if (alive) setState({ id: projectId, enabled, ready: true });
    });
    return () => {
      alive = false;
    };
  }, [projectId]);
  if (state.id !== projectId) {
    return { enabled: cache.get(projectId) ?? null, ready: cache.has(projectId) };
  }
  return { enabled: state.enabled, ready: state.ready };
}
