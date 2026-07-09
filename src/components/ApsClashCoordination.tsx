import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getClashCoordination,
  listClashComments,
  addClashComment,
  deleteClashComment,
  markClashRead,
  assignClash,
  setClashDue,
  resolveClash,
  verifyClash,
  reopenClash,
  type ClashCoordination,
  type ClashComment,
} from '../lib/clashCoordination';
import { CLASH_STATUS_LABEL, type ClashStatus } from '../lib/clash';
import type { ProjectMember } from '../lib/members';
import { useAuth } from '../auth/AuthProvider';

interface Props {
  clashDbId: string;
  projectId: string;
  title: string;
  canEdit: boolean;
  members: ProjectMember[];
  /** 나(현재 사용자) id — 코멘트 삭제 권한·감사 표시용. */
  onClose: () => void;
  /** 담당·상태·코멘트 변경 후 리스트 요약을 다시 불러오도록 상위에 알림. */
  onChanged?: () => void;
}

/**
 * 간섭 코디네이션 룸 — 저장된 간섭 한 건의 협의를 플랫폼 안에서 완결한다.
 *   • 담당 배정(구성원 + 관계사/역할 라벨) · 기한
 *   • 상태 흐름: 신규 → 검토중 → 해결(담당) → 승인(검토자 검증). 해소/검증 감사 기록.
 *   • 코멘트 스레드(@멘션 · 읽음) — 배정·멘션 시 인앱 알림.
 * dbBacked(저장된) 간섭에만 열 수 있다(clashes.id 필요).
 */
export function ApsClashCoordination({ clashDbId, projectId, title, canEdit, members, onClose, onChanged }: Props) {
  const { profile } = useAuth();
  const myId = profile?.id ?? null;
  const authorName = profile?.full_name ?? profile?.username ?? null;

  const nameOf = useMemo(() => {
    const m = new Map(members.map((x) => [x.id, x.name]));
    return (id: string | null | undefined) => (id ? m.get(id) ?? '구성원' : null);
  }, [members]);

  const [coord, setCoord] = useState<ClashCoordination | null>(null);
  const [comments, setComments] = useState<ClashComment[]>([]);
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(true);

  // 편집 로컬 상태(담당/기한/라벨).
  const [assignee, setAssignee] = useState('');
  const [label, setLabel] = useState('');
  const [due, setDue] = useState('');

  const [body, setBody] = useState('');
  const [mentions, setMentions] = useState<Set<string>>(new Set());
  const [posting, setPosting] = useState(false);

  const loadedRef = useRef(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [c, list] = await Promise.all([
          getClashCoordination(clashDbId),
          listClashComments(clashDbId),
        ]);
        if (!alive) return;
        setCoord(c);
        setComments(list);
        setAssignee(c?.assignee ?? '');
        setLabel(c?.assignee_label ?? '');
        setDue(c?.due_date ?? '');
      } catch (e) {
        if (alive) setMsg(`불러오기 실패: ${(e as Error).message}`);
      } finally {
        if (alive) setLoading(false);
      }
      // 열람 = 읽음 처리(미읽음 배지 해제).
      markClashRead(clashDbId).then(() => onChanged?.()).catch(() => {});
      loadedRef.current = true;
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clashDbId]);

  const saveAssign = async () => {
    if (!canEdit) return;
    setMsg('담당 저장 중…');
    try {
      await assignClash({
        clashDbId,
        projectId,
        assignee: assignee || null,
        assigneeLabel: label.trim() || null,
        actorName: authorName,
        clashTitle: title,
      });
      setCoord((c) => (c ? { ...c, assignee: assignee || null, assignee_label: label.trim() || null } : c));
      setMsg('담당 저장됨');
      onChanged?.();
    } catch (e) {
      setMsg(`담당 저장 실패: ${(e as Error).message}`);
    }
  };

  const saveDue = async () => {
    if (!canEdit) return;
    try {
      await setClashDue({
        clashDbId,
        projectId,
        due: due || null,
        assignee: assignee || null,
        actorName: authorName,
        clashTitle: title,
      });
      setCoord((c) => (c ? { ...c, due_date: due || null } : c));
      setMsg('기한 저장됨');
      onChanged?.();
    } catch (e) {
      setMsg(`기한 저장 실패: ${(e as Error).message}`);
    }
  };

  const doResolve = async () => {
    setMsg('해소 처리 중…');
    try {
      const c = await resolveClash({ clashDbId, projectId, actorName: authorName, clashTitle: title });
      setCoord(c);
      setMsg('해소 처리됨 — 검토자 검증 대기');
      onChanged?.();
    } catch (e) {
      setMsg(`해소 실패: ${(e as Error).message}`);
    }
  };
  const doVerify = async () => {
    setMsg('검증 중…');
    try {
      const c = await verifyClash({
        clashDbId,
        projectId,
        assignee: coord?.assignee ?? null,
        actorName: authorName,
        clashTitle: title,
      });
      setCoord(c);
      setMsg('검증 완료 — 닫힘');
      onChanged?.();
    } catch (e) {
      setMsg(`검증 실패: ${(e as Error).message}`);
    }
  };
  const doReopen = async (s: ClashStatus) => {
    try {
      await reopenClash(clashDbId, s);
      setCoord((c) => (c ? { ...c, status: s } : c));
      setMsg('재검토로 되돌림');
      onChanged?.();
    } catch (e) {
      setMsg(`되돌리기 실패: ${(e as Error).message}`);
    }
  };

  const post = async () => {
    if (!body.trim() || posting) return;
    setPosting(true);
    try {
      const c = await addClashComment({
        clashDbId,
        projectId,
        body: body.trim(),
        mentions: [...mentions],
        authorName,
        assignee: coord?.assignee ?? null,
        clashTitle: title,
      });
      setComments((cs) => [...cs, c]);
      setBody('');
      setMentions(new Set());
      await markClashRead(clashDbId).catch(() => {});
      onChanged?.();
    } catch (e) {
      setMsg(`코멘트 실패: ${(e as Error).message}`);
    } finally {
      setPosting(false);
    }
  };

  const removeComment = async (id: string) => {
    if (!confirm('이 코멘트를 삭제할까요?')) return;
    try {
      await deleteClashComment(id);
      setComments((cs) => cs.filter((c) => c.id !== id));
      onChanged?.();
    } catch (e) {
      setMsg(`삭제 실패: ${(e as Error).message}`);
    }
  };

  const toggleMention = (id: string) =>
    setMentions((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const status = coord?.status ?? 'new';
  const overdue = coord?.due_date && status !== 'approved' && new Date(coord.due_date) < new Date(new Date().toDateString());

  return (
    <div style={overlay}>
      <div style={sheet}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <strong style={{ fontSize: 14 }}>💬 코디네이션 룸</strong>
          <span style={{ ...badge, background: statusColor(status) }}>{CLASH_STATUS_LABEL[status]}</span>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} style={btn}>✕</button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={title}>
          {title}
        </div>

        {loading ? (
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>불러오는 중…</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto', flex: 1 }}>
            {/* 담당 · 기한 */}
            <section>
              <div style={sectionTitle}>담당 · 기한</div>
              <label style={lbl}>담당자(구성원)</label>
              <select value={assignee} onChange={(e) => setAssignee(e.target.value)} disabled={!canEdit} style={field}>
                <option value="">(미지정)</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
                {assignee && !members.some((m) => m.id === assignee) && <option value={assignee}>배정된 담당자</option>}
              </select>
              <label style={lbl}>관계사 / 역할</label>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                disabled={!canEdit}
                placeholder="예: 구조팀 / 협력사 A"
                style={field}
              />
              {canEdit && (
                <button onClick={() => void saveAssign()} style={{ ...btn, marginTop: 6 }}>담당 저장</button>
              )}
              <label style={lbl}>기한</label>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="date" value={due} onChange={(e) => setDue(e.target.value)} disabled={!canEdit} style={{ ...field, marginTop: 0 }} />
                {canEdit && <button onClick={() => void saveDue()} style={btn}>기한 저장</button>}
              </div>
              {overdue && <div style={{ fontSize: 11, color: '#dc2626', marginTop: 4 }}>⚠ 기한 초과</div>}
            </section>

            {/* 상태 흐름: 해소 → 검증 */}
            <section>
              <div style={sectionTitle}>해소 → 검증</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
                신규 → 검토중 → <b>해결</b>(담당) → <b>승인</b>(검토자 검증)
              </div>
              {coord?.resolved_at && (
                <div style={auditLine}>해소: {nameOf(coord.resolved_by) ?? '완료'} · {fmt(coord.resolved_at)}</div>
              )}
              {coord?.verified_at && (
                <div style={auditLine}>검증: {nameOf(coord.verified_by) ?? '완료'} · {fmt(coord.verified_at)}</div>
              )}
              {canEdit && (
                <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                  {(status === 'new' || status === 'reviewing') && (
                    <button onClick={() => void doResolve()} style={btnPrimary}>해소 처리</button>
                  )}
                  {status === 'resolved' && (
                    <>
                      <button onClick={() => void doVerify()} style={btnPrimary}>검증 완료</button>
                      <button onClick={() => void doReopen('reviewing')} style={btn}>재검토(반려)</button>
                    </>
                  )}
                  {status === 'approved' && (
                    <button onClick={() => void doReopen('reviewing')} style={btn}>재오픈</button>
                  )}
                  {status === 'new' && (
                    <button onClick={() => void doReopen('reviewing')} style={btn}>검토 시작</button>
                  )}
                </div>
              )}
            </section>

            {/* 코멘트 스레드 */}
            <section style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <div style={sectionTitle}>협의 스레드 · {comments.length}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
                {comments.length === 0 && <div style={{ fontSize: 12, color: 'var(--muted)' }}>아직 코멘트가 없습니다.</div>}
                {comments.map((c) => (
                  <div key={c.id} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px' }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, color: 'var(--muted)' }}>
                      <b style={{ color: 'var(--text)' }}>{c.author_name || '구성원'}</b>
                      <span>{fmt(c.created_at)}</span>
                      <span style={{ flex: 1 }} />
                      {(c.author === myId || canEdit) && (
                        <button onClick={() => void removeComment(c.id)} style={{ ...btn, padding: '0 6px', fontSize: 11 }} title="삭제">🗑</button>
                      )}
                    </div>
                    <div style={{ fontSize: 12, whiteSpace: 'pre-wrap', marginTop: 2 }}>{c.body}</div>
                    {c.mentions.length > 0 && (
                      <div style={{ fontSize: 11, color: 'var(--accent)', marginTop: 3 }}>
                        @{c.mentions.map((id) => nameOf(id) ?? '구성원').join(', @')}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {canEdit && (
                <div style={{ marginTop: 8 }}>
                  <textarea
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    placeholder="코멘트 입력…"
                    style={{ ...field, height: 56, resize: 'vertical' }}
                  />
                  {members.length > 0 && (
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4, alignItems: 'center' }}>
                      <span style={{ fontSize: 11, color: 'var(--muted)' }}>멘션:</span>
                      {members.map((m) => (
                        <button
                          key={m.id}
                          onClick={() => toggleMention(m.id)}
                          style={{ ...chip, opacity: mentions.has(m.id) ? 1 : 0.5, borderColor: mentions.has(m.id) ? 'var(--accent)' : 'var(--border)' }}
                        >
                          @{m.name}
                        </button>
                      ))}
                    </div>
                  )}
                  <button onClick={() => void post()} disabled={!body.trim() || posting} style={{ ...btnPrimary, marginTop: 6 }}>
                    {posting ? '등록 중…' : '코멘트 등록'}
                  </button>
                </div>
              )}
            </section>
          </div>
        )}

        {msg && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>{msg}</div>}
      </div>
    </div>
  );
}

function statusColor(s: ClashStatus): string {
  return s === 'approved' ? '#16a34a' : s === 'resolved' ? '#2563eb' : s === 'reviewing' ? '#f97316' : '#6b7280';
}
function fmt(iso: string): string {
  return new Date(iso).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
}

const overlay: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'rgba(0,0,0,0.45)',
  display: 'flex',
  alignItems: 'stretch',
  justifyContent: 'flex-end',
  borderRadius: 8,
  zIndex: 10,
};
const sheet: React.CSSProperties = {
  width: '92%',
  maxWidth: 420,
  background: 'var(--panel)',
  borderLeft: '1px solid var(--border)',
  borderRadius: '0 8px 8px 0',
  padding: 14,
  display: 'flex',
  flexDirection: 'column',
  color: 'var(--text)',
};
const sectionTitle: React.CSSProperties = { fontSize: 12, fontWeight: 700, marginBottom: 4 };
const lbl: React.CSSProperties = { display: 'block', fontSize: 11, color: 'var(--muted)', marginTop: 6 };
const field: React.CSSProperties = { width: '100%', padding: '4px 6px', borderRadius: 6, marginTop: 2, background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)' };
const btn: React.CSSProperties = { padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', cursor: 'pointer' };
const btnPrimary: React.CSSProperties = { ...btn, background: 'var(--accent)', color: 'var(--accent-fg)', border: '1px solid var(--accent)' };
const chip: React.CSSProperties = { ...btn, fontSize: 11, padding: '1px 6px' };
const badge: React.CSSProperties = { fontSize: 11, color: '#fff', padding: '1px 8px', borderRadius: 999 };
const auditLine: React.CSSProperties = { fontSize: 11, color: 'var(--muted)' };
