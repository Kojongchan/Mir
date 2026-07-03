import { useEffect, useState } from 'react';
import { EmptyState } from './EmptyState';
import { errMessage } from '../lib/errors';
import {
  COMPANY_ROLE_TYPES,
  deleteCompany,
  listCompanies,
  saveCompany,
  type Company,
  type CompanyRoleType,
} from '../lib/companies';

/** 관계사 관리 패널(프로젝트 관리자용) — 구성원·권한 화면에 임베드. CRUD + 표시토글 + CSV. */
export function CompaniesPanel({ projectId }: { projectId: string }) {
  const [rows, setRows] = useState<Company[]>([]);
  const [msg, setMsg] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Company | null>(null);

  const empty = { name: '', role_type: '협력사' as CompanyRoleType, manager: '', phone: '', active: true };
  const [form, setForm] = useState(empty);

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const refresh = () => listCompanies(projectId).then(setRows).catch(() => setRows([]));

  const startEdit = (c: Company) => {
    setEditing(c);
    setForm({ name: c.name, role_type: c.role_type, manager: c.manager ?? '', phone: c.phone ?? '', active: c.active });
    setShowForm(true);
  };

  const onSave = async () => {
    if (!form.name.trim()) { setMsg('회사명을 입력하세요'); return; }
    try {
      await saveCompany(projectId, editing?.id ?? null, {
        name: form.name.trim(), role_type: form.role_type,
        manager: form.manager || null, phone: form.phone || null,
        active: form.active, sort_order: editing?.sort_order ?? rows.length,
      });
      setShowForm(false); setEditing(null); setForm(empty);
      await refresh(); setMsg('저장됨');
    } catch (e) { setMsg(`저장 실패: ${errMessage(e)}`); }
  };

  const onToggleActive = async (c: Company) => {
    await saveCompany(projectId, c.id, { ...c, active: !c.active }).catch((e) => setMsg(errMessage(e)));
    await refresh();
  };
  const onDelete = async (id: string) => {
    if (!window.confirm('이 관계사를 삭제할까요?')) return;
    await deleteCompany(id); await refresh();
  };

  const exportCsv = () => {
    const header = '회사명,구분,담당자,연락처,표시';
    const lines = rows.map((c) => [c.name, c.role_type, c.manager ?? '', c.phone ?? '', c.active ? 'Y' : 'N'].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    const blob = new Blob(['﻿' + [header, ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = '관계사.csv'; a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <section className="admin-card">
      <div className="dash-head" style={{ margin: 0 }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>관계사 관리</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          {rows.length > 0 && <button onClick={exportCsv}>⬇ CSV</button>}
          <button className="primary" onClick={() => { setEditing(null); setForm(empty); setShowForm((s) => !s); }}>
            {showForm ? '취소' : '＋ 관계사'}
          </button>
        </div>
      </div>

      {showForm && (
        <div className="admin-form-row" style={{ flexWrap: 'wrap', marginTop: 10 }}>
          <input placeholder="회사명" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <select value={form.role_type} onChange={(e) => setForm({ ...form, role_type: e.target.value as CompanyRoleType })}>
            {COMPANY_ROLE_TYPES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <input placeholder="담당자" value={form.manager} onChange={(e) => setForm({ ...form, manager: e.target.value })} />
          <input placeholder="연락처" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
            <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> 사업개요 표시
          </label>
          <button className="primary" onClick={onSave}>{editing ? '수정' : '등록'}</button>
        </div>
      )}

      <div className="admin-table-wrap" style={{ marginTop: 10 }}>
        <table className="admin-table">
          <thead><tr><th>회사명</th><th>구분</th><th>담당자</th><th>연락처</th><th>표시</th><th className="right">관리</th></tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td><span className="badge">{c.role_type}</span></td>
                <td className="muted">{c.manager || '—'}</td>
                <td className="muted">{c.phone || '—'}</td>
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
      {msg && <div className="muted" style={{ marginTop: 8 }}>{msg}</div>}
    </section>
  );
}
