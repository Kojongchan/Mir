import { supabase } from './supabase';
import { notify } from './notifications';

// =====================================================================
// R9 — 기상알림 자동화 데이터층.
// 무비용: open-meteo(무료·API키 불필요·CORS 허용) 로 예보를 조회하고,
// 임계치 초과 시 인앱 알림(notifications) + 이력(weather_alert_log)을 남긴다.
// 스케줄 자동화(Vercel Cron/카카오)는 후속 — 현재는 페이지 진입/수동 점검으로 트리거.
// =====================================================================

export type WeatherMetric = 'precip' | 'wind' | 'temp_high' | 'temp_low' | 'snow';
export type Comparator = 'gte' | 'lte';

export const METRIC_LABEL: Record<WeatherMetric, string> = {
  precip: '강수량',
  wind: '풍속',
  temp_high: '최고기온',
  temp_low: '최저기온',
  snow: '적설',
};
export const METRIC_UNIT: Record<WeatherMetric, string> = {
  precip: 'mm',
  wind: 'km/h',
  temp_high: '°C',
  temp_low: '°C',
  snow: 'cm',
};
export const METRICS: WeatherMetric[] = ['precip', 'wind', 'temp_high', 'temp_low', 'snow'];
export const COMPARATOR_LABEL: Record<Comparator, string> = { gte: '이상', lte: '이하' };

export interface WeatherRule {
  id: string;
  project_id: string;
  metric: WeatherMetric;
  comparator: Comparator;
  threshold: number;
  lat: number | null;
  lon: number | null;
  location_name: string | null;
  assignee: string | null;
  assignee_name: string | null;
  active: boolean;
  last_triggered_at: string | null;
  last_value: number | null;
}

export interface WeatherLog {
  id: string;
  rule_id: string | null;
  project_id: string;
  metric: string;
  value: number;
  threshold: number;
  message: string | null;
  created_at: string;
}

const RULE_COLS =
  'id, project_id, metric, comparator, threshold, lat, lon, location_name, assignee, assignee_name, active, last_triggered_at, last_value';

export async function listWeatherRules(projectId: string): Promise<WeatherRule[]> {
  const { data, error } = await supabase
    .from('weather_alert_rule')
    .select(RULE_COLS)
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => ({ ...r, threshold: Number(r.threshold), last_value: r.last_value == null ? null : Number(r.last_value) })) as WeatherRule[];
}

export interface WeatherRuleInput {
  metric: WeatherMetric;
  comparator: Comparator;
  threshold: number;
  lat?: number | null;
  lon?: number | null;
  location_name?: string | null;
  assignee?: string | null;
  assignee_name?: string | null;
  active?: boolean;
}

export async function saveWeatherRule(projectId: string, id: string | null, input: WeatherRuleInput): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const payload: Record<string, unknown> = {
    project_id: projectId,
    metric: input.metric,
    comparator: input.comparator,
    threshold: input.threshold,
    lat: input.lat ?? null,
    lon: input.lon ?? null,
    location_name: input.location_name || null,
    assignee: input.assignee ?? null,
    assignee_name: input.assignee_name || null,
    active: input.active ?? true,
  };
  if (id) {
    const { error } = await supabase.from('weather_alert_rule').update(payload).eq('id', id);
    if (error) throw error;
  } else {
    payload.created_by = userData.user?.id ?? null;
    const { error } = await supabase.from('weather_alert_rule').insert(payload);
    if (error) throw error;
  }
}

export async function deleteWeatherRule(id: string): Promise<void> {
  const { error } = await supabase.from('weather_alert_rule').delete().eq('id', id);
  if (error) throw error;
}

export async function listWeatherLogs(projectId: string, limit = 50): Promise<WeatherLog[]> {
  const { data, error } = await supabase
    .from('weather_alert_log')
    .select('id, rule_id, project_id, metric, value, threshold, message, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((r) => ({ ...r, value: Number(r.value), threshold: Number(r.threshold) })) as WeatherLog[];
}

// ---------- open-meteo 조회 (무료·키 불필요) -------------------------

export interface DailyWeather {
  precip: number; // mm
  wind: number; // km/h
  temp_high: number; // °C
  temp_low: number; // °C
  snow: number; // cm
  date: string;
}

/** open-meteo 일일 예보(오늘). 좌표 필수. 네트워크/파싱 실패는 예외. */
export async function fetchDailyWeather(lat: number, lon: number): Promise<DailyWeather> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=precipitation_sum,windspeed_10m_max,temperature_2m_max,temperature_2m_min,snowfall_sum` +
    `&timezone=auto&forecast_days=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`기상 조회 실패 (${res.status})`);
  const j = await res.json();
  const d = j.daily ?? {};
  const first = (a: unknown): number => (Array.isArray(a) && a.length ? Number(a[0]) || 0 : 0);
  return {
    date: Array.isArray(d.time) ? d.time[0] : new Date().toISOString().slice(0, 10),
    precip: first(d.precipitation_sum),
    wind: first(d.windspeed_10m_max),
    temp_high: first(d.temperature_2m_max),
    temp_low: first(d.temperature_2m_min),
    snow: first(d.snowfall_sum),
  };
}

function metricValue(w: DailyWeather, m: WeatherMetric): number {
  return w[m];
}

function exceeds(value: number, comparator: Comparator, threshold: number): boolean {
  return comparator === 'gte' ? value >= threshold : value <= threshold;
}

export interface CheckResult {
  checked: number;
  triggered: number;
  messages: string[];
}

/**
 * 활성 규칙을 점검한다. 좌표별로 예보를 캐시 조회하고, 초과 시 담당자에게 인앱
 * 알림 + 이력 기록 + 규칙의 last_triggered_at/last_value 갱신. 무비용 경로.
 */
export async function checkWeatherRules(projectId: string, actorName: string | null): Promise<CheckResult> {
  const rules = (await listWeatherRules(projectId)).filter((r) => r.active && r.lat != null && r.lon != null);
  const cache = new Map<string, DailyWeather>();
  const result: CheckResult = { checked: 0, triggered: 0, messages: [] };

  for (const rule of rules) {
    const key = `${rule.lat},${rule.lon}`;
    let w = cache.get(key);
    if (!w) {
      try {
        w = await fetchDailyWeather(rule.lat!, rule.lon!);
        cache.set(key, w);
      } catch (e) {
        result.messages.push(`조회 실패(${rule.location_name || key}): ${(e as Error).message}`);
        continue;
      }
    }
    result.checked++;
    const value = metricValue(w, rule.metric);
    if (!exceeds(value, rule.comparator, rule.threshold)) continue;

    result.triggered++;
    const unit = METRIC_UNIT[rule.metric];
    const msg = `${rule.location_name || '현장'} ${METRIC_LABEL[rule.metric]} ${value}${unit} (임계 ${COMPARATOR_LABEL[rule.comparator]} ${rule.threshold}${unit})`;
    result.messages.push(msg);

    // 이력 기록.
    await supabase.from('weather_alert_log').insert({
      rule_id: rule.id,
      project_id: projectId,
      metric: rule.metric,
      value,
      threshold: rule.threshold,
      message: msg,
    }).then(() => {}, () => {});

    // 담당자 인앱 알림.
    if (rule.assignee) {
      await notify({
        projectId,
        recipients: [rule.assignee],
        type: 'weather_alert',
        title: `⚠️ 기상 경보: ${METRIC_LABEL[rule.metric]}`,
        body: msg,
        actorName,
      });
    }

    // 규칙 상태 갱신(중복 하루 1회 억제는 last_triggered_at 로 UI 표시).
    await supabase.from('weather_alert_rule').update({ last_triggered_at: new Date().toISOString(), last_value: value }).eq('id', rule.id).then(() => {}, () => {});
  }
  return result;
}
