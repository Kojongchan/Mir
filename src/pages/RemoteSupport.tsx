import { Fragment, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import { Attachments } from '../components/Attachments';
import { errMessage } from '../lib/errors';
import { useAuth } from '../auth/AuthProvider';
import { useProjectRole } from '../auth/useProjectRole';
import { formatDate } from '../lib/dashboard';
import {
  createRemoteSession,
  deleteRemoteSession,
  listRemoteSessions,
  type RemoteSession,
} from '../lib/remote';

/** R11 — 원격지원 세션 아카이브. Teams/Meet 링크 + 화면캡처 첨부·조회. */
export function RemoteSupport() {
  const { projectId = '' } = useParams();
  const { profile } = useAuth();
  const { canEdit } = useProjectRole(projectId);
  const authorName = profile?.full_name ?? profile?.username ?? null;

  const [sessions, setSessions] = useState<RemoteSession[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [msg, setMsg] = useState('');
  const [unavailable, setUnavailable] = useState(false);

  const empty = { title: '', platform: 'Teams', link: '', held_at: new Date().toISOString().slice(0, 16), participants: '', summary: '' };
  const [form, setForm] = useState(empty);

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const refresh = () =>
    listRemoteSessions(projectId)
      .then((l) => { setSessions(l); setUnavailable(false); })
      .catch(() => { setSessions([]); setUnavailable(true); });

  const onCreate = async () => {
    if (!form.title.trim()) { setMsg('제목을 입력하세요'); return; }
    try {
      const id = await createRemoteSession(projectId, {
        title: form.title.trim(),
        platform: form.platform,
        link: form.link || null,
        held_at: form.held_at ? new Date(form.held_at).toISOString() : null,
        participants: form.participants || null,
        summary: form.summary || null,
      }, authorName);
      setForm(empty);
      setShowForm(false);
      await refresh();
      setOpenId(id);
      setMsg('세션 등록됨 — 화면캡처를 첨부하세요');
    } catch (e) {
      setMsg(`등록 실패: ${errMessage(e)}`);
    }
  };

  const onDelete = async (id: string) => {
    if (!window.confirm('이 세션을 삭제할까요?')) return;
    await deleteRemoteSession(id);
    if (openId === id) setOpenId(null);
    await refresh();
  };

  return (
    <div className="dash">
      <div className="dash-head">
        <h1 className="dash-h1">원격지원</h1>
        {canEdit && !unavailable && <button className="primary" onClick={() => setShowForm((s) => !s)}>{showForm ? '취소' : '＋ 세션 등록'}</button>}
      </div>

      {unavailable && (
        <EmptyState icon="🖥" title="원격지원 모듈이 아직 활성화되지 않았습니다" desc="마이그레이션(0040) 적용 후 원격지원 아카이브를 사용할 수 있습니다." />
      )}

      {!unavailable && (
        <>
          {showForm && (
            <section className="card dash-edit">
              <h3>새 원격지원 세션</h3>
              <div className="dash-edit-row">
                <label className="grow">제목<input value={form.title} placeholder="예: 3층 배관 간섭 원격검토" onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
                <label>플랫폼
                  <select value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })}>
                    {['Teams', 'Meet', 'Zoom', '기타'].map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </label>
                <label>일시<input type="datetime-local" value={form.held_at} onChange={(e) => setForm({ ...form, held_at: e.target.value })} /></label>
              </div>
              <div className="dash-edit-row">
                <label className="grow">링크<input value={form.link} placeholder="https://…" onChange={(e) => setForm({ ...form, link: e.target.value })} /></label>
                <label className="grow">참여자<input value={form.participants} placeholder="예: 감리, 설계, 시공 PM" onChange={(e) => setForm({ ...form, participants: e.target.value })} /></label>
              </div>
              <div className="dash-edit-row">
                <label className="grow">요약<textarea rows={2} value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} /></label>
                <button className="primary" onClick={onCreate}>등록</button>
              </div>
            </section>
          )}

          <section className="card" style={{ padding: 0 }}>
            <div className="cde-table-wrap" style={{ padding: 0 }}>
              <table className="cde-table">
                <thead><tr><th>제목</th><th>플랫폼</th><th>일시</th><th>참여자</th><th /></tr></thead>
                <tbody>
                  {sessions.map((s) => (
                    <Fragment key={s.id}>
                      <tr>
                        <td className="cde-fname"><button className="cde-link" onClick={() => setOpenId(openId === s.id ? null : s.id)}>{openId === s.id ? '▾ ' : '▸ '}{s.title}</button></td>
                        <td className="nowrap">{s.platform || '—'}</td>
                        <td className="nowrap tabular">{formatDate(s.held_at.slice(0, 10))}</td>
                        <td className="nowrap">{s.participants || '—'}</td>
                        <td className="right nowrap">{canEdit && <button className="danger" onClick={() => onDelete(s.id)}>삭제</button>}</td>
                      </tr>
                      {openId === s.id && (
                        <tr className="issue-detail-row" key={s.id + '-d'}>
                          <td colSpan={5}>
                            <div className="issue-detail">
                              <p className="muted issue-meta">등록 {s.created_by_name || '—'} · {new Date(s.held_at).toLocaleString('ko-KR')}</p>
                              {s.link && <p><a href={s.link} target="_blank" rel="noopener">🔗 세션 링크 열기</a></p>}
                              {s.summary && <p className="issue-desc">{s.summary}</p>}
                              <Attachments projectId={projectId} targetType="remote" targetId={s.id} canEdit={canEdit} label="화면캡처·자료" />
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                  {sessions.length === 0 && <tr><td colSpan={5}><EmptyState compact icon="🖥" title="원격지원 세션이 없습니다" desc="세션을 등록하면 링크·캡처를 아카이브합니다." /></td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {msg && <p className="muted dash-msg">{msg}</p>}
    </div>
  );
}
