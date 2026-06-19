import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { createPost, deletePost, listPosts, type Post } from '../lib/portal';
import { formatDate } from '../lib/dashboard';

/** 게시판 / 공지 — 프로젝트 공지·알림 글. */
export function Board() {
  const { projectId = '' } = useParams();
  const { profile } = useAuth();
  const authorName = profile?.full_name ?? profile?.username ?? null;

  const [posts, setPosts] = useState<Post[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ title: '', body: '', pinned: false });
  const [msg, setMsg] = useState('');

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const refresh = () => listPosts(projectId).then(setPosts).catch(() => setPosts([]));

  const onCreate = async () => {
    if (!form.title.trim()) {
      setMsg('제목을 입력하세요');
      return;
    }
    try {
      await createPost(projectId, { title: form.title.trim(), body: form.body, pinned: form.pinned }, authorName);
      setForm({ title: '', body: '', pinned: false });
      setShowForm(false);
      await refresh();
      setMsg('게시글 등록됨');
    } catch (e) {
      setMsg(`등록 실패: ${(e as Error).message}`);
    }
  };

  const onDelete = async (id: string) => {
    if (!window.confirm('이 게시글을 삭제할까요?')) return;
    await deletePost(id);
    await refresh();
  };

  return (
    <div className="dash">
      <div className="dash-head">
        <h1 className="dash-h1">게시판 · 공지</h1>
        <button className="primary" onClick={() => setShowForm((s) => !s)}>{showForm ? '취소' : '＋ 글쓰기'}</button>
      </div>

      {showForm && (
        <section className="card dash-edit">
          <h3>새 게시글</h3>
          <div className="dash-edit-row">
            <label className="grow">제목<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
            <label className="dash-check">
              <input type="checkbox" checked={form.pinned} onChange={(e) => setForm({ ...form, pinned: e.target.checked })} /> 상단 고정
            </label>
          </div>
          <div className="dash-edit-row">
            <label className="grow">내용<input value={form.body} placeholder="공지 내용" onChange={(e) => setForm({ ...form, body: e.target.value })} /></label>
            <button className="primary" onClick={onCreate}>등록</button>
          </div>
        </section>
      )}

      <section className="board-list">
        {posts.map((p) => (
          <article key={p.id} className={`card board-item${p.pinned ? ' is-pinned' : ''}`}>
            <div className="board-head" onClick={() => setOpen(open === p.id ? null : p.id)}>
              <span className="board-title">
                {p.pinned && <span className="board-pin">📌</span>}
                {p.title}
              </span>
              <span className="muted board-meta">{p.author_name || '—'} · {formatDate(p.created_at.slice(0, 10))}</span>
            </div>
            {open === p.id && (
              <div className="board-body">
                {p.body ? <p>{p.body}</p> : <p className="muted">(내용 없음)</p>}
                <button className="danger" onClick={() => onDelete(p.id)}>삭제</button>
              </div>
            )}
          </article>
        ))}
        {posts.length === 0 && <p className="muted">게시글이 없습니다.</p>}
      </section>

      {msg && <p className="muted dash-msg">{msg}</p>}
    </div>
  );
}
