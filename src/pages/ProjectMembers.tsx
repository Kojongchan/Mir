import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import { useProjectRole, ROLE_LABEL } from '../auth/useProjectRole';
import { errMessage } from '../lib/errors';
import {
  MEMBER_ROLES,
  createUserAccount,
  listAssignableUsers,
  listMembers,
  removeMember,
  renameUserAccount,
  resetUserPassword,
  setMember,
  type MemberRole,
  type MemberRow,
  type ProfileRow,
} from '../lib/admin';
import {
  ROLE_TAG_PRESETS,
  addMemberRole,
  listCompanies,
  listMemberCompanies,
  listMemberRoles,
  removeMemberRole,
  setMemberCompany,
  type Company,
  type MemberRoleTag,
} from '../lib/companies';

/**
 * 구성원·권한 — 프로젝트 단위 멤버/역할 관리 (S48).
 *
 * 접근: 시스템 관리자 또는 **프로젝트 관리자**(canManage). 프로젝트 관리자는 자기
 * 프로젝트의 멤버 추가·역할 배정·해제 + (신규 계정 생성까지) 가능하나, 프로젝트
 * 설정·계정 삭제·시스템 관리자 관리는 불가(시스템 관리자/Supabase 전용). 서버
 * (api/admin)와 RLS(0023)가 실제 강제, 이 화면은 게이팅·편의 UI.
 */
export function ProjectMembers() {
  const { projectId = '' } = useParams();
  const { canManage, loading } = useProjectRole(projectId);

  const [members, setMembers] = useState<MemberRow[]>([]);
  const [users, setUsers] = useState<ProfileRow[]>([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  // 기존 사용자 배정
  const [addUserId, setAddUserId] = useState('');
  const [addRole, setAddRole] = useState<MemberRole>('viewer');
  // 신규 계정 생성
  const [nu, setNu] = useState({ username: '', fullName: '', password: '', role: 'viewer' as MemberRole });

  // R12 — 관계사·다중역할(0041 미적용 시 빈 값 폴백).
  const [companies, setCompanies] = useState<Company[]>([]);
  const [roleTags, setRoleTags] = useState<Map<string, MemberRoleTag[]>>(new Map());
  const [memberCompany, setMemberCompanyMap] = useState<Map<string, string | null>>(new Map());

  const reload = () => {
    listMembers(projectId).then(setMembers).catch(() => setMembers([]));
    listAssignableUsers(projectId).then((r) => setUsers(r.users)).catch(() => setUsers([]));
    listCompanies(projectId).then(setCompanies).catch(() => setCompanies([]));
    listMemberRoles(projectId).then(setRoleTags).catch(() => setRoleTags(new Map()));
    listMemberCompanies(projectId).then(setMemberCompanyMap).catch(() => setMemberCompanyMap(new Map()));
  };

  const onSetCompany = async (userId: string, companyId: string) => {
    try { await setMemberCompany(projectId, userId, companyId || null); reload(); } catch (e) { err(e); }
  };
  const onAddTag = async (userId: string) => {
    const preset = ROLE_TAG_PRESETS.join(', ');
    const tag = window.prompt(`도메인 역할 태그 추가 (예: ${preset})`);
    if (!tag || !tag.trim()) return;
    try { await addMemberRole(projectId, userId, tag.trim()); reload(); } catch (e) { err(e); }
  };
  const onRemoveTag = async (id: string) => {
    try { await removeMemberRole(id); reload(); } catch (e) { err(e); }
  };

  useEffect(() => {
    if (canManage) reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, canManage]);

  const usersById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const memberIds = useMemo(() => new Set(members.map((m) => m.user_id)), [members]);
  // 후보 = 아직 멤버 아님 + 시스템 관리자 제외(시스템 관리자는 어디서나 관리자라 배정 불필요·RLS 차단).
  const candidates = users.filter((u) => !memberIds.has(u.id) && !u.is_admin);

  const ok = (m: string) => setMsg(m);
  const err = (e: unknown) => setMsg(`오류: ${errMessage(e)}`);

  const addExisting = async () => {
    if (!addUserId) return;
    try {
      await setMember(projectId, addUserId, addRole);
      setAddUserId('');
      setAddRole('viewer');
      ok('멤버를 배정했습니다.');
      reload();
    } catch (e) { err(e); }
  };

  const createAndAdd = async () => {
    if (!nu.username.trim() || nu.password.length < 6) return;
    setBusy(true);
    try {
      await createUserAccount(nu.username.trim(), nu.password, nu.fullName.trim() || nu.username.trim(), {
        projectId,
        role: nu.role,
      });
      setNu({ username: '', fullName: '', password: '', role: 'viewer' });
      ok('새 사용자를 만들고 이 프로젝트에 배정했습니다.');
      reload();
    } catch (e) { err(e); } finally { setBusy(false); }
  };

  const changeRole = async (userId: string, role: MemberRole) => {
    try { await setMember(projectId, userId, role); reload(); } catch (e) { err(e); }
  };
  const remove = async (userId: string) => {
    if (!window.confirm('이 프로젝트에서 멤버를 해제할까요? (계정은 유지됩니다)')) return;
    try { await removeMember(projectId, userId); ok('멤버를 해제했습니다.'); reload(); } catch (e) { err(e); }
  };
  const resetPw = async (u: ProfileRow) => {
    const pw = window.prompt(`${u.username} 새 비밀번호 (6자 이상)`);
    if (!pw) return;
    try { await resetUserPassword(u.id, pw, projectId); ok(`${u.username} 비밀번호를 변경했습니다.`); } catch (e) { err(e); }
  };
  const rename = async (u: ProfileRow) => {
    const next = window.prompt(`${u.username} 새 로그인 아이디`, u.username);
    if (next === null) return;
    const t = next.trim();
    if (!t || t === u.username) return;
    try { await renameUserAccount(u.id, t, projectId); ok(`아이디를 "${t}"(으)로 변경했습니다.`); reload(); } catch (e) { err(e); }
  };

  if (loading) return <div className="mod-fill"><p className="muted" style={{ padding: 20 }}>불러오는 중…</p></div>;
  if (!canManage) {
    return (
      <div className="mod-fill">
        <p className="muted" style={{ padding: 20 }}>이 화면은 프로젝트 관리자 또는 시스템 관리자만 사용할 수 있습니다.</p>
      </div>
    );
  }

  return (
    <div className="mod-fill" style={{ overflow: 'auto', padding: 16 }}>
      <h2 style={{ marginTop: 0 }}>구성원 · 권한</h2>

      {/* 기존 사용자 배정 */}
      <section className="admin-card">
        <h3 style={{ marginTop: 0, fontSize: 14 }}>기존 사용자 배정</h3>
        <div className="admin-form-row">
          <select value={addUserId} onChange={(e) => setAddUserId(e.target.value)}>
            <option value="">사용자 선택…</option>
            {candidates.map((u) => (
              <option key={u.id} value={u.id}>{u.username}{u.full_name ? ` (${u.full_name})` : ''}</option>
            ))}
          </select>
          <select value={addRole} onChange={(e) => setAddRole(e.target.value as MemberRole)}>
            {MEMBER_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
          <button onClick={addExisting} disabled={!addUserId}>배정</button>
        </div>
      </section>

      {/* 신규 계정 생성 + 배정 */}
      <section className="admin-card">
        <h3 style={{ marginTop: 0, fontSize: 14 }}>신규 사용자 만들기 (이 프로젝트에 배정)</h3>
        <div className="admin-form-row">
          <input placeholder="아이디 (한글 가능)" value={nu.username} onChange={(e) => setNu({ ...nu, username: e.target.value })} />
          <input placeholder="표시이름" value={nu.fullName} onChange={(e) => setNu({ ...nu, fullName: e.target.value })} />
          <input type="password" placeholder="비밀번호 (6자+)" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} />
          <select value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value as MemberRole })}>
            {MEMBER_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
          <button onClick={createAndAdd} disabled={busy || !nu.username.trim() || nu.password.length < 6}>
            {busy ? '생성 중…' : '만들기'}
          </button>
        </div>
      </section>

      {/* 멤버 목록 */}
      <section className="admin-card">
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr><th>아이디</th><th>표시이름</th><th>접근권한</th><th>소속(관계사)</th><th>도메인 역할</th><th className="right">관리</th></tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const u = usersById.get(m.user_id);
                const sys = !!u?.is_admin;
                return (
                  <tr key={m.user_id}>
                    <td>{u?.username ?? m.user_id.slice(0, 8)}{sys && <span className="tag tag-sysadmin">시스템 관리자</span>}</td>
                    <td className="muted">{u?.full_name ?? '—'}</td>
                    <td>
                      {sys ? (
                        <span className="muted">전체 관리(시스템)</span>
                      ) : (
                        <select value={m.role} onChange={(e) => changeRole(m.user_id, e.target.value as MemberRole)}>
                          {MEMBER_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                        </select>
                      )}
                    </td>
                    <td>
                      {sys ? <span className="muted">—</span> : (
                        <select value={memberCompany.get(m.user_id) ?? ''} onChange={(e) => onSetCompany(m.user_id, e.target.value)}>
                          <option value="">미지정</option>
                          {companies.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.role_type})</option>)}
                        </select>
                      )}
                    </td>
                    <td>
                      <div className="role-tags">
                        {(roleTags.get(m.user_id) ?? []).map((t) => (
                          <span className="role-tag" key={t.id}>
                            {t.role_tag}
                            {!sys && <button className="role-tag-x" title="제거" onClick={() => onRemoveTag(t.id)}>×</button>}
                          </span>
                        ))}
                        {!sys && <button className="role-tag-add" onClick={() => onAddTag(m.user_id)}>＋</button>}
                      </div>
                    </td>
                    <td className="right nowrap">
                      {sys ? (
                        <span className="muted" title="시스템 관리자는 Supabase에서만 관리">🔒</span>
                      ) : (
                        <>
                          <button onClick={() => rename(u!)} disabled={!u}>아이디 변경</button>
                          <button onClick={() => resetPw(u!)} disabled={!u}>비번 변경</button>
                          <button className="danger" onClick={() => remove(m.user_id)}>멤버 해제</button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
              {members.length === 0 && <tr><td colSpan={6}><EmptyState compact icon="👥" title="배정된 멤버가 없습니다" desc="아래에서 사용자를 배정하세요." /></td></tr>}
            </tbody>
          </table>
        </div>
        <p className="muted admin-hint">
          역할 — <strong>뷰어</strong>=열람·미리보기(다운로드 없음) · <strong>실무자</strong>=업로드·수정·삭제 등 작업 ·
          <strong> 관리자</strong>=실무자 + 멤버·역할 관리. <strong>프로젝트 설정·계정 삭제·시스템 관리자</strong>는 시스템 관리자 전용.
        </p>
        {msg && <div className="muted" style={{ marginTop: 8 }}>{msg}</div>}
      </section>
    </div>
  );
}
