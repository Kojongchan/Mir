import { supabase } from './supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';

// =====================================================================
// R7 — HIBoard 실시간 위젯 대시보드 데이터층.
// dashboard_widget CRUD + Supabase Realtime 구독 헬퍼(디바운스·lifecycle 안전).
// ★ 구독 남용 방지: 프로젝트당 채널 1개, onChange 디바운스, 반드시 unsubscribe.
// 쓰기 = is_project_admin(RLS). 읽기 = is_member.
// =====================================================================

/** 위젯 카탈로그 키. */
export type WidgetType =
  | 'kpi_open_issues'
  | 'kpi_open_rfi'
  | 'kpi_punch_progress'
  | 'kpi_open_submittals'
  | 'kpi_billed'
  | 'list_recent_issues'
  | 'progress_punch';

export interface WidgetMeta {
  type: WidgetType;
  label: string;
  desc: string;
  defaultSpan: number; // bento 12칸 기준
  kind: 'kpi' | 'list' | 'progress';
}

export const WIDGET_CATALOG: WidgetMeta[] = [
  { type: 'kpi_open_issues', label: '미해결 이슈', desc: '진행중 이슈 수', defaultSpan: 3, kind: 'kpi' },
  { type: 'kpi_open_rfi', label: '미응답 RFI', desc: '접수 상태 RFI 수', defaultSpan: 3, kind: 'kpi' },
  { type: 'kpi_open_submittals', label: '진행 제출물', desc: '미종결 제출물 수', defaultSpan: 3, kind: 'kpi' },
  { type: 'kpi_punch_progress', label: 'Punch 준공률', desc: '완료/전체 비율', defaultSpan: 3, kind: 'kpi' },
  { type: 'kpi_billed', label: '누적 기성', desc: '기성 청구 누계액', defaultSpan: 3, kind: 'kpi' },
  { type: 'progress_punch', label: 'Punch 진행률 바', desc: '준공률 게이지', defaultSpan: 6, kind: 'progress' },
  { type: 'list_recent_issues', label: '최근 이슈', desc: '최신 이슈 5건', defaultSpan: 6, kind: 'list' },
];

export function widgetMeta(type: string): WidgetMeta | undefined {
  return WIDGET_CATALOG.find((w) => w.type === type);
}

export interface DashboardWidget {
  id: string;
  project_id: string;
  type: WidgetType;
  position: number;
  config: { span?: number; title?: string };
}

const COLS = 'id, project_id, type, position, config';

export async function listWidgets(projectId: string): Promise<DashboardWidget[]> {
  const { data, error } = await supabase
    .from('dashboard_widget')
    .select(COLS)
    .eq('project_id', projectId)
    .order('position', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((w) => ({ ...w, config: w.config ?? {} })) as DashboardWidget[];
}

export async function addWidget(projectId: string, type: WidgetType, position: number): Promise<void> {
  const meta = widgetMeta(type);
  const { error } = await supabase.from('dashboard_widget').insert({
    project_id: projectId,
    type,
    position,
    config: { span: meta?.defaultSpan ?? 3 },
  });
  if (error) throw error;
}

export async function removeWidget(id: string): Promise<void> {
  const { error } = await supabase.from('dashboard_widget').delete().eq('id', id);
  if (error) throw error;
}

export async function updateWidgetConfig(id: string, config: DashboardWidget['config']): Promise<void> {
  const { error } = await supabase.from('dashboard_widget').update({ config }).eq('id', id);
  if (error) throw error;
}

/** 드래그 재배치 후 순서 일괄 저장(각 위젯 position 갱신). */
export async function saveWidgetOrder(widgets: DashboardWidget[]): Promise<void> {
  await Promise.all(
    widgets.map((w, i) =>
      w.position === i ? Promise.resolve() : supabase.from('dashboard_widget').update({ position: i }).eq('id', w.id),
    ),
  );
}

// ---------- Realtime 구독 (디바운스·안전 해제) -----------------------

/** HIBoard 위젯이 반응하는 소스 테이블. */
const WATCH_TABLES = ['issues', 'rfi', 'punch', 'billing_items', 'daily_logs', 'submittal', 'dashboard_widget'];

/**
 * 프로젝트 변경 이벤트를 단일 채널로 구독한다. 잦은 이벤트는 디바운스해
 * onChange 를 한 번만 호출한다(구독 남용/과다 리렌더 방지). 반환된 함수를
 * 반드시 호출해 채널을 해제해야 한다(언마운트 시 누수 방지).
 */
export function subscribeProjectChanges(
  projectId: string,
  onChange: () => void,
  debounceMs = 400,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const fire = () => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (!disposed) onChange();
    }, debounceMs);
  };

  const channel: RealtimeChannel = supabase.channel(`hiboard:${projectId}`);
  for (const table of WATCH_TABLES) {
    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table, filter: `project_id=eq.${projectId}` },
      fire,
    );
  }
  channel.subscribe();

  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    supabase.removeChannel(channel);
  };
}
