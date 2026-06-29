import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { ApsMatchRule } from '../lib/apsScheduleMapping';

let seq = 0;
const newRule = (): ApsMatchRule => ({
  id: `rule-${Date.now()}-${seq++}`,
  modelProperty: null,
  taskField: null,
  enabled: true,
});

/**
 * 나비스웍스 TimeLiner '규칙 편집기' 류의 매핑 규칙 팝업(#2/#4). 공정표 비교 열과
 * 모델 객체 속성을 짝지은 규칙을 여러 개 만들어 위→아래 순서로 적용한다(합집합).
 * 모델 속성이 비면 객체 이름, 공정표 열이 비면 자동(동기화ID→작업ID→작업명).
 */
export function ApsRuleEditor({
  taskFields,
  propertyOptions,
  initialRules,
  busy,
  message,
  onApply,
  onClose,
}: {
  taskFields: string[];
  propertyOptions: string[];
  initialRules: ApsMatchRule[];
  busy: boolean;
  message?: string;
  onApply: (rules: ApsMatchRule[]) => void;
  onClose: () => void;
}) {
  const [rules, setRules] = useState<ApsMatchRule[]>(
    initialRules.length ? initialRules : [newRule()],
  );

  const patch = (id: string, p: Partial<ApsMatchRule>) =>
    setRules((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const remove = (id: string) => setRules((rs) => rs.filter((r) => r.id !== id));

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ width: 720, maxWidth: '94vw' }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 4px' }}>4D 매칭 — 규칙 편집기</h3>
        <p className="muted" style={{ margin: '0 0 12px', fontSize: 12 }}>
          공정표(엑셀)의 비교 열과 모델(nwd) 객체 속성을 짝지어 매핑합니다. 규칙을 위에서
          아래로 적용해 결과를 합칩니다(나비스웍스 TimeLiner 규칙과 동일).
        </p>

        <div className="rule-grid rule-grid-head">
          <span>사용</span>
          <span>공정표 비교 열</span>
          <span>↔ 모델 객체 속성</span>
          <span />
        </div>
        <div style={{ maxHeight: '46vh', overflowY: 'auto' }}>
          {rules.map((r) => (
            <div className="rule-grid" key={r.id}>
              <input
                type="checkbox"
                checked={r.enabled}
                onChange={(e) => patch(r.id, { enabled: e.target.checked })}
              />
              <select value={r.taskField ?? ''} onChange={(e) => patch(r.id, { taskField: e.target.value || null })}>
                <option value="">자동(동기화ID→작업ID→작업명)</option>
                {taskFields.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
              <select value={r.modelProperty ?? ''} onChange={(e) => patch(r.id, { modelProperty: e.target.value || null })}>
                <option value="">객체 이름</option>
                {propertyOptions.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <button className="tl-mini" title="규칙 삭제" disabled={rules.length <= 1} onClick={() => remove(r.id)}>
                ✕
              </button>
            </div>
          ))}
        </div>

        {message && (
          <div
            style={{
              marginTop: 10,
              padding: '8px 10px',
              borderRadius: 6,
              background: 'color-mix(in srgb, #f97316 14%, transparent)',
              border: '1px solid #f97316',
              fontSize: 12,
              whiteSpace: 'pre-line',
            }}
          >
            {message}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
          <button onClick={() => setRules((rs) => [...rs, newRule()])}>＋ 규칙 추가</button>
          <span style={{ flex: 1 }} />
          <button onClick={onClose}>취소</button>
          <button
            style={{ fontWeight: 700 }}
            disabled={busy || !rules.some((r) => r.enabled)}
            onClick={() => onApply(rules)}
          >
            {busy ? '적용 중…' : '규칙 적용(매핑)'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
