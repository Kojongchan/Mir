import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import { errMessage } from '../lib/errors';
import { useAuth } from '../auth/AuthProvider';
import { useProjectRole } from '../auth/useProjectRole';
import { listProjectMembers, type ProjectMember } from '../lib/members';
import {
  COMPARATOR_LABEL,
  METRICS,
  METRIC_LABEL,
  METRIC_UNIT,
  checkWeatherRules,
  deleteWeatherRule,
  listWeatherLogs,
  listWeatherRules,
  saveWeatherRule,
  type Comparator,
  type WeatherLog,
  type WeatherMetric,
  type WeatherRule,
} from '../lib/weather';

/** R9 — 기상알림 자동화. 임계치 규칙 CRUD + 무료 예보 점검 + 인앱 알림·이력. */
export function WeatherAlerts() {
  const { projectId = '' } = useParams();
  const { profile } = useAuth();
  const { canEdit } = useProjectRole(projectId);
  const actorName = profile?.full_name ?? profile?.username ?? null;

  const [rules, setRules] = useState<WeatherRule[]>([]);
  const [logs, setLogs] = useState<WeatherLog[]>([]);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [msg, setMsg] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const [checking, setChecking] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const empty = {
    metric: 'precip' as WeatherMetric,
    comparator: 'gte' as Comparator,
    threshold: '30',
    lat: '',
    lon: '',
    location_name: '',
    assignee: '',
  };
  const [form, setForm] = useState(empty);

  useEffect(() => {
    refresh();
    if (canEdit) listProjectMembers(projectId).then(setMembers).catch(() => setMembers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const refresh = async () => {
    try {
      const [r, l] = await Promise.all([listWeatherRules(projectId), listWeatherLogs(projectId)]);
      setRules(r);
      setLogs(l);
      setUnavailable(false);
    } catch {
      setRules([]);
      setLogs([]);
      setUnavailable(true);
    }
  };

  const onSave = async () => {
    if (!form.threshold) {
      setMsg('임계치를 입력하세요');
      return;
    }
    try {
      const member = members.find((m) => m.id === form.assignee);
      await saveWeatherRule(projectId, null, {
        metric: form.metric,
        comparator: form.comparator,
        threshold: Number(form.threshold),
        lat: form.lat ? Number(form.lat) : null,
        lon: form.lon ? Number(form.lon) : null,
        location_name: form.location_name || null,
        assignee: form.assignee || null,
        assignee_name: member?.name ?? null,
        active: true,
      });
      setForm(empty);
      setShowForm(false);
      await refresh();
      setMsg('규칙 저장됨');
    } catch (e) {
      setMsg(`저장 실패: ${errMessage(e)}`);
    }
  };

  const onToggle = async (r: WeatherRule) => {
    await saveWeatherRule(projectId, r.id, { ...r, active: !r.active }).catch((e) => setMsg(errMessage(e)));
    await refresh();
  };
  const onDelete = async (id: string) => {
    if (!window.confirm('이 규칙을 삭제할까요?')) return;
    await deleteWeatherRule(id);
    await refresh();
  };

  const onCheck = async () => {
    setChecking(true);
    setMsg('');
    try {
      const res = await checkWeatherRules(projectId, actorName);
      setMsg(
        res.checked === 0
          ? '점검할 활성 규칙(좌표 포함)이 없습니다.'
          : `점검 ${res.checked}건 · 초과 ${res.triggered}건${res.triggered ? ' — ' + res.messages.slice(0, 2).join(' / ') : ''}`,
      );
      await refresh();
    } catch (e) {
      setMsg(`점검 실패: ${errMessage(e)}`);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="dash">
      <div className="dash-head">
        <h1 className="dash-h1">기상알림</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {!unavailable && <button onClick={onCheck} disabled={checking}>{checking ? '점검 중…' : '🌦 지금 점검'}</button>}
          {canEdit && !unavailable && <button className="primary" onClick={() => setShowForm((s) => !s)}>{showForm ? '취소' : '＋ 규칙 추가'}</button>}
        </div>
      </div>

      {unavailable && (
        <EmptyState icon="🌦" title="기상알림 모듈이 아직 활성화되지 않았습니다" desc="마이그레이션(0038) 적용 후 기상 임계치 알림을 사용할 수 있습니다." />
      )}

      {!unavailable && (
        <>
          <p className="muted" style={{ fontSize: 12, margin: '0 0 12px' }}>
            무료 기상 API(open-meteo)로 좌표별 예보를 조회해 임계치 초과 시 담당자에게 인앱 알림을 보냅니다.
            (자동 스케줄 발송·카카오 알림톡은 후속 — 현재는 "지금 점검" 또는 화면 진입 시 점검.)
          </p>

          {showForm && (
            <section className="card dash-edit">
              <h3>새 임계치 규칙</h3>
              <div className="dash-edit-row">
                <label>지표
                  <select value={form.metric} onChange={(e) => setForm({ ...form, metric: e.target.value as WeatherMetric })}>
                    {METRICS.map((m) => <option key={m} value={m}>{METRIC_LABEL[m]} ({METRIC_UNIT[m]})</option>)}
                  </select>
                </label>
                <label>조건
                  <select value={form.comparator} onChange={(e) => setForm({ ...form, comparator: e.target.value as Comparator })}>
                    <option value="gte">이상(≥)</option>
                    <option value="lte">이하(≤)</option>
                  </select>
                </label>
                <label>임계치<input type="number" value={form.threshold} onChange={(e) => setForm({ ...form, threshold: e.target.value })} /></label>
                <label>담당자
                  <select value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })}>
                    <option value="">미지정</option>
                    {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </label>
              </div>
              <div className="dash-edit-row">
                <label>현장명<input value={form.location_name} placeholder="예: 평택 제5공구" onChange={(e) => setForm({ ...form, location_name: e.target.value })} /></label>
                <label>위도(lat)<input type="number" value={form.lat} placeholder="37.0" onChange={(e) => setForm({ ...form, lat: e.target.value })} /></label>
                <label>경도(lon)<input type="number" value={form.lon} placeholder="127.0" onChange={(e) => setForm({ ...form, lon: e.target.value })} /></label>
                <button className="primary" onClick={onSave}>저장</button>
              </div>
              <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>좌표는 지도/스마트폰 GPS 값을 입력하세요(없으면 점검에서 제외).</p>
            </section>
          )}

          <section className="card" style={{ padding: 0 }}>
            <div className="cde-table-wrap" style={{ padding: 0 }}>
              <table className="cde-table">
                <thead>
                  <tr><th>지표</th><th>조건</th><th>현장</th><th>담당</th><th>최근 발생</th><th>상태</th><th /></tr>
                </thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.id}>
                      <td>{METRIC_LABEL[r.metric]}</td>
                      <td className="nowrap tabular">{COMPARATOR_LABEL[r.comparator]} {r.threshold}{METRIC_UNIT[r.metric]}</td>
                      <td className="nowrap">{r.location_name || (r.lat != null ? `${r.lat},${r.lon}` : '—')}</td>
                      <td className="nowrap">{r.assignee_name || '—'}</td>
                      <td className="nowrap">{r.last_triggered_at ? <span className="bic-overdue tabular">{r.last_value}{METRIC_UNIT[r.metric]} · {new Date(r.last_triggered_at).toLocaleDateString('ko-KR')}</span> : <span className="muted">—</span>}</td>
                      <td><span className={`issue-badge ${r.active ? 'rfi-answered' : 'rfi-closed'}`}>{r.active ? '활성' : '중지'}</span></td>
                      <td className="right nowrap">
                        {canEdit && <button onClick={() => onToggle(r)}>{r.active ? '중지' : '활성'}</button>}
                        {canEdit && <button className="danger" onClick={() => onDelete(r.id)}>삭제</button>}
                      </td>
                    </tr>
                  ))}
                  {rules.length === 0 && <tr><td colSpan={7}><EmptyState compact icon="🌦" title="규칙이 없습니다" desc="강수·풍속 등 임계치 규칙을 추가하세요." /></td></tr>}
                </tbody>
              </table>
            </div>
          </section>

          {logs.length > 0 && (
            <section className="card">
              <h3 style={{ marginTop: 0 }}>발생 이력</h3>
              <div className="issue-history">
                {logs.map((l) => (
                  <div className="issue-event" key={l.id}>
                    <span className="issue-event-when">{new Date(l.created_at).toLocaleString('ko-KR')}</span>
                    <span className="issue-event-text">{l.message || `${METRIC_LABEL[l.metric as WeatherMetric] ?? l.metric} ${l.value}`}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {msg && <p className="muted dash-msg">{msg}</p>}
    </div>
  );
}
