import { useState } from 'react';
import { createPortal } from 'react-dom';
import { COLUMN_ROLES, type ColumnMap, type CsvDoc } from '../lib/schedule';

interface Props {
  doc: CsvDoc;
  onConfirm: (map: ColumnMap) => void;
  onCancel: () => void;
}

/**
 * CSV 가져오기 열 매핑 대화상자(Navisworks 필드 선택기 유사).
 * 자동 추정값(doc.guess)으로 채워진 상태에서, 각 역할(이름·유형·계획/실제 날짜·
 * 비용·동기화 ID·개요)에 어떤 열을 쓸지 선택하게 한다.
 */
export function ColumnMapModal({ doc, onConfirm, onCancel }: Props) {
  const [map, setMap] = useState<ColumnMap>(doc.guess);

  const setRole = (role: keyof ColumnMap, value: number) =>
    setMap((m) => ({ ...m, [role]: value }));

  const sample = doc.rows[0] ?? [];
  const missingRequired = COLUMN_ROLES.some((r) => r.required && map[r.key] < 0);

  return createPortal(
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>CSV 가져오기 — 열 매핑</h3>
          <span className="muted">
            형식 자동 인식: {doc.source} · {doc.rows.length}행 · {doc.header.length}열
          </span>
        </div>

        <div className="modal-body">
          <table className="map-table">
            <thead>
              <tr>
                <th>속성</th>
                <th>CSV 열</th>
                <th>미리보기(1행)</th>
              </tr>
            </thead>
            <tbody>
              {COLUMN_ROLES.map((role) => {
                const idx = map[role.key];
                return (
                  <tr key={role.key}>
                    <td>
                      {role.label}
                      {role.required && <span className="req"> *</span>}
                    </td>
                    <td>
                      <select
                        value={idx}
                        onChange={(e) => setRole(role.key, Number(e.target.value))}
                      >
                        <option value={-1}>— 없음 —</option>
                        {doc.header.map((h, i) => (
                          <option key={i} value={i}>
                            {h || `열 ${i + 1}`}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="muted preview">{idx >= 0 ? sample[idx] ?? '' : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {missingRequired && (
            <p className="req">* 필수 항목(이름·계획 시작·계획 끝)을 모두 지정하세요.</p>
          )}
        </div>

        <div className="modal-foot">
          <button onClick={onCancel}>취소</button>
          <button className="primary" disabled={missingRequired} onClick={() => onConfirm(map)}>
            가져오기
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
