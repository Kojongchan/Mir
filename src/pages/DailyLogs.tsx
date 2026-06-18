import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  addDailyLog,
  deleteDailyLog,
  formatDate,
  listDailyLogs,
  todayISO,
  type DailyLog,
} from '../lib/dashboard';

/** 공사일보 — daily site log CRUD. Powers the dashboard 인력/장비/일지 figures. */
export function DailyLogs() {
  const { projectId = '' } = useParams();
  const [logs, setLogs] = useState<DailyLog[]>([]);
  const [msg, setMsg] = useState('');
  const [form, setForm] = useState({
    log_date: todayISO(),
    manpower: 0,
    equipment: 0,
    weather: '',
    content: '',
  });

  useEffect(() => {
    listDailyLogs(projectId).then(setLogs).catch(() => setLogs([]));
  }, [projectId]);

  const refresh = () => listDailyLogs(projectId).then(setLogs).catch(() => setLogs([]));

  const onAdd = async () => {
    if (!form.log_date) return;
    try {
      await addDailyLog(projectId, {
        log_date: form.log_date,
        manpower: Number(form.manpower) || 0,
        equipment: Number(form.equipment) || 0,
        weather: form.weather || undefined,
        content: form.content || undefined,
      });
      setForm({ ...form, manpower: 0, equipment: 0, weather: '', content: '' });
      await refresh();
      setMsg('일보 등록됨');
    } catch (e) {
      setMsg(`등록 실패: ${(e as Error).message}`);
    }
  };

  const onDelete = async (id: string) => {
    if (!window.confirm('이 일보를 삭제할까요?')) return;
    await deleteDailyLog(id);
    await refresh();
  };

  return (
    <div className="dash">
      <div className="dash-head">
        <h1 className="dash-h1">공사일보</h1>
      </div>

      <section className="card dash-edit">
        <h3>일보 등록</h3>
        <div className="dash-edit-row">
          <label>일자<input type="date" value={form.log_date} onChange={(e) => setForm({ ...form, log_date: e.target.value })} /></label>
          <label>투입 인력(명)<input type="number" min={0} value={form.manpower} onChange={(e) => setForm({ ...form, manpower: Number(e.target.value) })} /></label>
          <label>투입 장비(대)<input type="number" min={0} value={form.equipment} onChange={(e) => setForm({ ...form, equipment: Number(e.target.value) })} /></label>
          <label>날씨<input value={form.weather} placeholder="맑음" onChange={(e) => setForm({ ...form, weather: e.target.value })} /></label>
        </div>
        <div className="dash-edit-row">
          <label className="grow">작업 내용<input value={form.content} placeholder="금일 작업 내용" onChange={(e) => setForm({ ...form, content: e.target.value })} /></label>
          <button className="primary" onClick={onAdd}>등록</button>
        </div>
      </section>

      <section className="card">
        <div className="cde-table-wrap" style={{ padding: 0 }}>
          <table className="cde-table">
            <thead>
              <tr>
                <th>일자</th>
                <th className="right">인력</th>
                <th className="right">장비</th>
                <th>날씨</th>
                <th>작업 내용</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id}>
                  <td className="nowrap">{formatDate(l.log_date)}</td>
                  <td className="right">{l.manpower}</td>
                  <td className="right">{l.equipment}</td>
                  <td>{l.weather || '—'}</td>
                  <td>{l.content || '—'}</td>
                  <td className="right"><button className="danger" onClick={() => onDelete(l.id)}>삭제</button></td>
                </tr>
              ))}
              {logs.length === 0 && (
                <tr><td colSpan={6} className="muted empty">등록된 일보가 없습니다.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {msg && <p className="muted dash-msg">{msg}</p>}
    </div>
  );
}
