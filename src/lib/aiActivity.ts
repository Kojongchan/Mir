import { supabase } from './supabase';

/** AI 연결(MCP) 도구 호출 한 줄(0041 ai_tool_log). */
export interface ToolLogRow {
  id: number;
  tool: string;
  result: string;
  ok: boolean;
  ms: number | null;
  created_at: string;
  setup_id: string | null;
}

/** since 이후의 도구 호출(최근 순). 0041 이 없으면 null. */
export async function listToolLog(projectId: string, since: string, limit = 40): Promise<ToolLogRow[] | null> {
  const { data, error } = await supabase.from('ai_tool_log')
    .select('id, tool, result, ok, ms, created_at, setup_id')
    .eq('project_id', projectId).gt('created_at', since)
    .order('created_at', { ascending: false }).limit(limit);
  if (error) {
    if (error.code === 'PGRST205' || error.code === '42P01' || /schema cache|does not exist/i.test(error.message)) return null;
    throw error;
  }
  return (data ?? []) as ToolLogRow[];
}

export const TOOL_LABEL: Record<string, string> = {
  list_targets: '대상 확인', read_document: '문서 읽기', read_boq: '내역서 읽기', check_schedule: 'P6 검토', list_activities: '작업 목록',
  actual_durations: '실적 공기', model_link_status: '모델 연결 현황', plan_schedule: '공기 계산', read_daily_logs: '작업일보 읽기',
  find_similar_cases: '유사 사례', save_design_status: '설계현황 저장', save_critical_points: '크리티컬 포인트 저장', save_unit_rates: '단위공기 저장',
  save_plan_settings: '공기 설정 저장', save_object_links: '객체 연결 저장', save_lesson: '배운 점 저장',
  drawing_index: '도면 목차', view_drawing: '도면 보기',
};
