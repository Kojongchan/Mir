import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { listProjects, type Project } from '../lib/api';
import { ThemeToggle } from '../components/ThemeToggle';
import { BrandLogo } from '../components/BrandLogo';
import { ROLE_LABEL } from '../auth/useProjectRole';
import {
  MEMBER_ROLES,
  createProject,
  createUserAccount,
  deleteProject,
  deleteUserAccount,
  listMembers,
  listProfiles,
  removeMember,
  renameUserAccount,
  resetUserPassword,
  setMember,
  setUserAdmin,
  updateProject,
  type MemberRole,
  type MemberRow,
  type ProfileRow,
} from '../lib/admin';

type Tab = 'projects' | 'users' | 'members';

export function Admin({ embedded = false }: { embedded?: boolean }) {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [tab, setTab] = useState<Tab>('projects');
  const [projects, setProjects] = useState<Project[]>([]);
  const [users, setUsers] = useState<ProfileRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const flash = (msg: string) => {
    setNotice(msg);
    setError(null);
  };
  const fail = (e: unknown) => {
    setError((e as Error).message);
    setNotice(null);
  };

  const reloadProjects = () => listProjects().then(setProjects).catch(fail);
  const reloadUsers = () => listProfiles().then(setUsers).catch(fail);

  useEffect(() => {
    reloadProjects();
    reloadUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const body = (
    <>
      <nav className="admin-tabs">
        <button className={tab === 'projects' ? 'active' : ''} onClick={() => setTab('projects')}>
          프로젝트
        </button>
        <button className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>
          사용자
        </button>
        <button className={tab === 'members' ? 'active' : ''} onClick={() => setTab('members')}>
          멤버 배정
        </button>
      </nav>

      <main className="admin-body">
        {error && <div className="auth-error admin-msg">{error}</div>}
        {notice && <div className="admin-notice admin-msg">{notice}</div>}

        {tab === 'projects' && (
          <ProjectsTab
            projects={projects}
            onChange={reloadProjects}
            flash={flash}
            fail={fail}
          />
        )}
        {tab === 'users' && (
          <UsersTab
            users={users}
            currentUserId={profile?.id}
            onChange={reloadUsers}
            flash={flash}
            fail={fail}
          />
        )}
        {tab === 'members' && (
          <MembersTab projects={projects} users={users} flash={flash} fail={fail} />
        )}
      </main>
    </>
  );

  if (embedded) return <div className="admin-embed">{body}</div>;

  return (
    <div className="admin-screen">
      <header className="admin-top">
        <div>
          <span className="brand"><BrandLogo size="sm" /></span>
          <span className="admin-title">관리자 콘솔</span>
        </div>
        <div className="admin-top-actions">
          <span className="muted">{profile?.full_name ?? profile?.username}</span>
          <ThemeToggle />
          <button onClick={() => navigate('/')}>프로젝트로</button>
        </div>
      </header>
      {body}
    </div>
  );
}

// ---------------------------------------------------------------------

interface TabProps {
  flash: (msg: string) => void;
  fail: (e: unknown) => void;
}

function ProjectsTab({
  projects,
  onChange,
  flash,
  fail,
}: TabProps & { projects: Project[]; onChange: () => void }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await createProject(name.trim(), code.trim() || null);
      setName('');
      setCode('');
      flash('프로젝트를 추가했습니다.');
      onChange();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const rename = async (p: Project) => {
    const newName = window.prompt('프로젝트 이름', p.name);
    if (newName === null) return;
    const newCode = window.prompt('코드(공구 번호 등, 비워도 됨)', p.code ?? '');
    if (newCode === null) return;
    try {
      await updateProject(p.id, { name: newName.trim() || p.name, code: newCode.trim() || null });
      flash('프로젝트를 수정했습니다.');
      onChange();
    } catch (e) {
      fail(e);
    }
  };

  const remove = async (p: Project) => {
    if (!window.confirm(`"${p.name}" 프로젝트를 삭제할까요?\n배정·모델 DB행도 함께 삭제됩니다.\n(Storage의 실제 IFC 파일은 수동 삭제 필요)`)) return;
    try {
      await deleteProject(p.id);
      flash('프로젝트를 삭제했습니다.');
      onChange();
    } catch (e) {
      fail(e);
    }
  };

  return (
    <section className="admin-card">
      <div className="admin-form-row">
        <input placeholder="프로젝트 이름 (예: 평택-오송 5공구)" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="narrow" placeholder="코드 (예: 5공구)" value={code} onChange={(e) => setCode(e.target.value)} />
        <button onClick={add} disabled={busy || !name.trim()}>추가</button>
      </div>

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr><th>이름</th><th>코드</th><th className="right">관리</th></tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td className="muted">{p.code ?? '—'}</td>
                <td className="right nowrap">
                  <button onClick={() => rename(p)}>수정</button>
                  <button className="danger" onClick={() => remove(p)}>삭제</button>
                </td>
              </tr>
            ))}
            {projects.length === 0 && (
              <tr><td colSpan={3} className="muted">프로젝트가 없습니다.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------

function UsersTab({
  users,
  currentUserId,
  onChange,
  flash,
  fail,
}: TabProps & { users: ProfileRow[]; currentUserId?: string; onChange: () => void }) {
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!username.trim() || password.length < 6) return;
    setBusy(true);
    try {
      await createUserAccount(username.trim(), password, fullName.trim() || username.trim(), isAdmin);
      setUsername('');
      setFullName('');
      setPassword('');
      setIsAdmin(false);
      flash('사용자를 생성했습니다. (멤버 배정 탭에서 프로젝트를 할당하세요)');
      onChange();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const toggleAdmin = async (u: ProfileRow) => {
    try {
      await setUserAdmin(u.id, !u.is_admin);
      flash(`${u.username} 시스템 관리자 권한을 ${!u.is_admin ? '부여' : '해제'}했습니다.`);
      onChange();
    } catch (e) {
      fail(e);
    }
  };

  const rename = async (u: ProfileRow) => {
    const next = window.prompt(`${u.username} 새 로그인 아이디 (한글 가능)`, u.username);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === u.username) return;
    try {
      await renameUserAccount(u.id, trimmed);
      flash(`${u.username} 아이디를 "${trimmed}"(으)로 변경했습니다.`);
      onChange();
    } catch (e) {
      fail(e);
    }
  };

  const resetPw = async (u: ProfileRow) => {
    const pw = window.prompt(`${u.username} 새 비밀번호 (6자 이상)`);
    if (!pw) return;
    try {
      await resetUserPassword(u.id, pw);
      flash(`${u.username} 비밀번호를 변경했습니다.`);
    } catch (e) {
      fail(e);
    }
  };

  const remove = async (u: ProfileRow) => {
    if (!window.confirm(`사용자 "${u.username}" 을(를) 삭제할까요?`)) return;
    try {
      await deleteUserAccount(u.id);
      flash(`${u.username} 을(를) 삭제했습니다.`);
      onChange();
    } catch (e) {
      fail(e);
    }
  };

  return (
    <section className="admin-card">
      <div className="admin-form-row">
        <input placeholder="아이디 (한글 가능)" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input placeholder="표시이름" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        <input type="password" placeholder="비밀번호 (6자+)" value={password} onChange={(e) => setPassword(e.target.value)} />
        <label className="admin-check">
          <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} /> 시스템 관리자
        </label>
        <button onClick={add} disabled={busy || !username.trim() || password.length < 6}>
          {busy ? '생성 중…' : '사용자 추가'}
        </button>
      </div>

      <p className="muted admin-hint">
        <strong>시스템 관리자</strong>는 사용자 생성·권한 부여 등 <strong>모든 것</strong>을 제어하고 전 프로젝트를 관리합니다.
        프로젝트별 <strong>관리자/실무자/뷰어</strong>는 ‘구성원’ 탭에서 배정합니다(서로 다른 권한).
      </p>

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr><th>아이디</th><th>표시이름</th><th>시스템 관리자</th><th className="right">관리</th></tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.username}{u.id === currentUserId && <span className="tag">나</span>}</td>
                <td className="muted">{u.full_name ?? '—'}</td>
                <td>{u.is_admin ? <span className="tag tag-sysadmin">시스템 관리자</span> : '—'}</td>
                <td className="right nowrap">
                  <button onClick={() => toggleAdmin(u)}>{u.is_admin ? '시스템관리자 해제' : '시스템관리자 지정'}</button>
                  <button onClick={() => rename(u)}>아이디 변경</button>
                  <button onClick={() => resetPw(u)}>비번 변경</button>
                  <button className="danger" onClick={() => remove(u)} disabled={u.id === currentUserId}>삭제</button>
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr><td colSpan={4} className="muted">사용자가 없습니다.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------

function MembersTab({
  projects,
  users,
  flash,
  fail,
}: TabProps & { projects: Project[]; users: ProfileRow[] }) {
  const [projectId, setProjectId] = useState('');
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [addUserId, setAddUserId] = useState('');
  const [addRole, setAddRole] = useState<MemberRole>('viewer');

  useEffect(() => {
    if (!projectId && projects.length) setProjectId(projects[0].id);
  }, [projects, projectId]);

  const reload = (pid: string) => {
    if (!pid) return;
    listMembers(pid).then(setMembers).catch(fail);
  };

  useEffect(() => {
    reload(projectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const usersById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const memberIds = useMemo(() => new Set(members.map((m) => m.user_id)), [members]);
  const candidates = users.filter((u) => !memberIds.has(u.id));

  const add = async () => {
    if (!projectId || !addUserId) return;
    try {
      await setMember(projectId, addUserId, addRole);
      setAddUserId('');
      setAddRole('viewer');
      flash('멤버를 배정했습니다.');
      reload(projectId);
    } catch (e) {
      fail(e);
    }
  };

  const changeRole = async (userId: string, role: MemberRole) => {
    try {
      await setMember(projectId, userId, role);
      reload(projectId);
    } catch (e) {
      fail(e);
    }
  };

  const remove = async (userId: string) => {
    try {
      await removeMember(projectId, userId);
      flash('배정을 해제했습니다.');
      reload(projectId);
    } catch (e) {
      fail(e);
    }
  };

  if (projects.length === 0) {
    return <section className="admin-card"><p className="muted">먼저 프로젝트를 추가하세요.</p></section>;
  }

  return (
    <section className="admin-card">
      <div className="admin-form-row">
        <label className="admin-inline">
          프로젝트
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}{p.code ? ` (${p.code})` : ''}</option>
            ))}
          </select>
        </label>
      </div>

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
        <button onClick={add} disabled={!addUserId}>배정</button>
      </div>

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr><th>아이디</th><th>표시이름</th><th>역할</th><th className="right">관리</th></tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const u = usersById.get(m.user_id);
              return (
                <tr key={m.user_id}>
                  <td>
                    {u?.username ?? m.user_id.slice(0, 8)}
                    {u?.is_admin && <span className="tag tag-sysadmin">시스템 관리자</span>}
                  </td>
                  <td className="muted">{u?.full_name ?? '—'}</td>
                  <td>
                    {u?.is_admin ? (
                      <span className="muted">전체 관리(시스템)</span>
                    ) : (
                      <select value={m.role} onChange={(e) => changeRole(m.user_id, e.target.value as MemberRole)}>
                        {MEMBER_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                      </select>
                    )}
                  </td>
                  <td className="right">
                    <button className="danger" onClick={() => remove(m.user_id)}>해제</button>
                  </td>
                </tr>
              );
            })}
            {members.length === 0 && (
              <tr><td colSpan={4} className="muted">배정된 멤버가 없습니다.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="muted admin-hint">
        <strong>시스템 관리자</strong>는 ‘사용자’ 탭에서 지정하며, 배정과 무관하게 모든 프로젝트를 관리합니다.
        아래 <strong>프로젝트 역할</strong> — <strong>뷰어</strong>=열람·미리보기만(다운로드 없음) ·
        <strong> 실무자</strong>=업로드·수정·삭제·버전 등 콘텐츠 작업 전부 ·
        <strong> 관리자</strong>=실무자 + 프로젝트 설정·역할 부여.
      </p>
    </section>
  );
}
