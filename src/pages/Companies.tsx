import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import { errMessage } from '../lib/errors';
import { useProjectRole } from '../auth/useProjectRole';
import {
  COMPANY_ROLE_TYPES,
  deleteCompany,
  listCompanies,
  saveCompany,
  type Company,
  type CompanyRoleType,
} from '../lib/companies';

/** R12 — 관계사 관리. 발주처·감리·시공·협력사 CRUD + 사업개요 표시 토글 + CSV. */
export function Companies() {
  const { projectId = '' } = useParams();
  const { canManage, loading } = useProjectRole(projectId);

  const [rows, setRows] = useState<Company[]>([]);
  const [msg, setMsg] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Company | null>(null);

  const empty = { name: '', role_type: '협력사' as CompanyRoleType, manager: '', phone: '', active: true };
  const [form, setForm] = useState(empty);

  useEffect(() => {
    if (canManage) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, canManage]);

  const refresh = () =>
    listCompanies(projectId)
      .then((l) => { setRows(l); setUnavailable(false); })
      .catch(() => { setRows([]); setUnavailable(true); });

  const startCreate = () => { setEditing(null); setForm(empty); setShowForm(true); };
  const startEdit = (c: Company) => {
    setEditing(c);
    setForm({ name: c.name, role_type: c.role_type, manager: c.manager ?? '', phone: c.phone ?? '', active: c.active });
    setShowForm(true);
  };

  const onSave = async () => {
    if (!form.name.trim()) { setMsg('회사명을 입력하세요'); return; }
    try {
      await saveCompany(projectId, editing?.id ?? null, {
        name: form.name.trim(),
        role_type: form.role_type,
        manager: form.manager || null,
        phone: form.phone || null,
        active: form.active,
        sort_order: editing?.sort_order ?? rows.length,
      });
      setShowForm(false);
      setEditing(null);
      setForm(empty);
      await refresh();
      setMsg('저장됨');
    } catch (e) { setMsg(`저장 실패: ${errMessage(e)}`); }
  };

  const onToggleActive = async (c: Company) => {
    await saveCompany(projectId, c.id, { ...c, active: !c.active }).catch((e) => setMsg(errMessage(e)));
    await refresh();
  };
  const onDelete = async (id: string) => {
    if (!window.confirm('이 관계사를 삭제할까요?')) return;
    await deleteCompany(id);
    await refresh();
  };

  const exportCsv = () => {
    const header = '회사명,구분,담당자,연락처,표시';
    const lines = rows.map((c) => [c.name, c.role_type, c.manager ?? '', c.phone ?? '', c.active ? 'Y' : 'N'].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    const blob = new Blob(['﻿' + [header, ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '관계사.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (loading) return <div className="dash"><p className="muted">불러오는 중…</p></div>;
  if (!canManage) return <div className="dash"><p className="muted">이 화면은 프로젝트 관리자 또는 시스템 관리자만 사용할 수 있습니다.</p></div>;

  return (
    <div className="dash">
      <div className="dash-head">
        <h1 className="dash-h1">관계사</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {!unavailable && rows.length > 0 && <button onClick={exportCsv}>⬇ CSV</button>}
          {!unavailable && <button className="primary" onClick={showForm ? () => setShowForm(false) : startCreate}>{showForm ? '취소' : '＋ 관계사 추가'}</button>}
        </div>
      </div>

      {unavailable && (
        <EmptyState icon="🏢" title="관계사 모듈이 아직 활성화되지 않았습니다" desc="마이그레이션(0041) 적용 후 관계사 관리를 사용할 수 있습니다." />
      )}

      {!unavailable && (
        <>
          {showForm && (
            <section className="card dash-edit">
              <h3>{editing ? '관계사 수정' : '새 관계사'}</h3>
              <div className="dash-edit-row">
                <label className="grow">회사명<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
                <label>구분
                  <select value={form.role_type} onChange={(e) => setForm({ ...form, role_type: e.target.value as CompanyRoleType })}>
                    {COMPANY_ROLE_TYPES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </label>
                <label>담당자<input value={form.manager} onChange={(e) => setForm({ ...form, manager: e.target.value })} /></label>
                <label>연락처<input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
                <label style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> 사업개요 표시
                </label>
                <button className="primary" onClick={onSave}>{editing ? '수정' : '등록'}</button>
              </div>
            </section>
          )}

          <section className="card" style={{ padding: 0 }}>
            <div className="cde-table-wrap" style={{ padding: 0 }}>
              <table className="cde-table">
                <thead><tr><th>회사명</th><th>구분</th><th>담당자</th><th>연락처</th><th>표시</th><th /></tr></thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id}>
                      <td>{c.name}</td>
                      <td><span className="badge">{c.role_type}</span></td>
                      <td className="nowrap">{c.manager || '—'}</td>
                      <td className="nowrap">{c.phone || '—'}</td>
                      <td><button className="linklike" onClick={() => onToggleActive(c)}><span className={`issue-badge ${c.active ? 'rfi-answered' : 'rfi-closed'}`}>{c.active ? '표시' : '숨김'}</span></button></td>
                      <td className="right nowrap">
                        <button onClick={() => startEdit(c)}>수정</button>
                        <button className="danger" onClick={() => onDelete(c.id)}>삭제</button>
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && <tr><td colSpan={6}><EmptyState compact icon="🏢" title="등록된 관계사가 없습니다" desc="발주처·감리·협력사를 등록하세요." /></td></tr>}
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
