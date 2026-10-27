import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { claudeWindowOpen, openClaude } from '../../lib/claudePopup';
import { listToolLog, TOOL_LABEL, type ToolLogRow } from '../../lib/aiActivity';
import type { StepKey } from '../../lib/sim45d/setup';
import { claudeAsk } from './steps/aiConnect';

/**
 * AI 도우미 — 플랫폼 안의 입력·진행 기록 + 오른쪽에 붙는 내 Claude 창(팝업, 각자 로그인·구독, D32·D33).
 * claude.ai 는 다른 사이트 안에 끼워 넣지 못해(iframe 차단) 별도 창으로 연다. Claude 가 MIR 커넥터(MCP)로 도구를 부르면
 * 그 기록(ai_tool_log)이 여기에 뜨고, 저장이 보이면 화면을 다시 읽는다.
 * 배치: 단계 시트가 열려 있으면 시트 안 왼쪽 칸(dock — 본문을 가리지 않음, 경계를 끌어 너비 조절, 접으면 얇은 띠),
 * 3D 화면에서는 떠 있는 패널(float — 머리를 끌어 옮김). Claude 창이 화면 오른쪽에 열리므로 도우미는 왼쪽.
 */
const QUICK: { label: string; task: Parameters<typeof claudeAsk>[0]; steps: StepKey[] }[] = [
  { label: '한 바퀴 진행', task: 'cycle', steps: ['target', 'files', 'design', 'draft', 'p6', 'link', 'export', 'sim', 'report'] },
  { label: '설계현황 채우기', task: 'designExtract', steps: ['files', 'design'] },
  { label: '단위공기 근거 찾기', task: 'ratesExtract', steps: ['design', 'draft'] },
  { label: '크리티컬 포인트·공기 비교', task: 'criticalPoints', steps: ['draft'] },
  { label: '현장 일정과 3안 비교', task: 'compareDates', steps: ['draft'] },
  { label: 'P6 검토 정리', task: 'explainCheck', steps: ['p6', 'report'] },
  { label: 'BIM 연결 마무리', task: 'linkLeftovers', steps: ['link'] },
  { label: '모델 반영 전 점검', task: 'modelSync', steps: ['export'] },
  { label: '수량분개(5D)', task: 'qtySplit', steps: ['link', 'sim', 'report'] },
  { label: '내역 분류', task: 'boqClassify', steps: ['report'] },
];

const POLL_MS = 4000;
const W_MIN = 260, W_MAX = 560, W_DEFAULT = 340;
const KEY = { width: 'mir.sim45d.assist.width', collapsed: 'mir.sim45d.assist.collapsed', pos: 'mir.sim45d.assist.pos' };
// 개인 화면 설정만 브라우저에(비공개 창 등에서 실패해도 기본값으로)
const load = <T,>(k: string, fallback: T): T => { try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v) as T; } catch { return fallback; } };
const keep = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 저장 못 해도 동작 */ } };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const time = (iso: string) => new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function ClaudeAssistant({ projectId, target, step, mode, onSaved, onOpenConnect, onClose }: {
  projectId: string;
  /** dock: 단계 시트 안 왼쪽 칸 · float: 3D 화면 위 떠 있는 패널. */
  mode: 'dock' | 'float';
  /** 지금 대상 이름(예 연제교 상선). */
  target: string;
  step: StepKey;
  /** Claude 가 저장했을 때 — 대상 진행 상태를 다시 읽는다. */
  onSaved: () => void;
  onOpenConnect: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [rows, setRows] = useState<ToolLogRow[]>([]);
  const [noLog, setNoLog] = useState(false);
  const [since] = useState(() => new Date(Date.now() - 30 * 60_000).toISOString());
  const seen = useRef(new Set<number>());
  /** 첫 읽기 전 기록은 '새 저장'으로 치지 않는다(열 때 이미 있던 것). */
  const primed = useRef(false);
  const onSavedRef = useRef(onSaved);
  useEffect(() => { onSavedRef.current = onSaved; }, [onSaved]);
  const [width, setWidth] = useState(() => clamp(load(KEY.width, W_DEFAULT), W_MIN, W_MAX));
  const [collapsed, setCollapsed] = useState(() => load(KEY.collapsed, false));
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => load(KEY.pos, null));
  /** 접혀 있는 동안 새로 들어온 기록 수. */
  const [unseen, setUnseen] = useState(0);
  const collapsedRef = useRef(collapsed);
  useEffect(() => { collapsedRef.current = collapsed; keep(KEY.collapsed, collapsed); if (!collapsed) setUnseen(0); }, [collapsed]);
  const panel = useRef<HTMLElement>(null);

  // dock: 오른쪽 경계를 끌어 너비 조절
  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = width;
    let w = w0;
    const move = (ev: PointerEvent) => { w = clamp(w0 + ev.clientX - x0, W_MIN, W_MAX); setWidth(w); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); keep(KEY.width, w); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  // float: 머리를 끌어 옮기기(화면 밖으로 나가지 않게)
  const startMove = (e: ReactPointerEvent) => {
    if (mode !== 'float' || (e.target as HTMLElement).closest('button')) return;
    const box = panel.current?.getBoundingClientRect();
    if (!box) return;
    e.preventDefault();
    const dx = e.clientX - box.left, dy = e.clientY - box.top;
    let p = { x: box.left, y: box.top };
    const move = (ev: PointerEvent) => {
      p = { x: clamp(ev.clientX - dx, 0, window.innerWidth - box.width), y: clamp(ev.clientY - dy, 0, window.innerHeight - 40) };
      setPos(p);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); keep(KEY.pos, p); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // 진행 기록: 열려 있고 화면이 보일 때만 몇 초마다. 새 저장(save_*)이 보이면 화면을 다시 읽는다.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const r = await listToolLog(projectId, since);
        if (!alive) return;
        if (r === null) { setNoLog(true); return; }
        const fresh = r.filter(x => !seen.current.has(x.id));
        for (const x of r) seen.current.add(x.id);
        setRows(r);
        if (primed.current && fresh.some(x => x.ok && x.tool.startsWith('save_'))) onSavedRef.current();
        if (primed.current && fresh.length && collapsedRef.current) setUnseen(n => n + fresh.length);
        primed.current = true;
      } catch { /* 다음 차례에 */ }
    };
    void tick();
    const t = window.setInterval(() => void tick(), POLL_MS);
    return () => { alive = false; window.clearInterval(t); };
  }, [projectId, since]);

  const send = (sentence: string) => {
    const { opened, copied } = openClaude(sentence);
    setNote(opened ? 'Claude 창에 보냈습니다. 지시문이 안 들어가 있으면 붙여넣기(Ctrl+V).' : '팝업이 막혔습니다 — 주소창 오른쪽에서 이 사이트의 팝업을 허용해 주세요.');
    void copied.then(ok => { if (!ok && opened) setNote('Claude 창에 보냈습니다. 지시문이 안 들어가 있으면 이 칸의 글을 복사해 붙여 넣으세요.'); });
  };

  const quick = QUICK.filter(q => q.steps.includes(step));
  const floatStyle = mode === 'float' && pos ? { left: clamp(pos.x, 0, Math.max(0, window.innerWidth - 120)), top: clamp(pos.y, 0, Math.max(0, window.innerHeight - 40)), bottom: 'auto' } : undefined;

  if (collapsed) {
    return (
      <aside ref={panel} className={`sim-assist sim-assist--${mode} is-collapsed`} style={floatStyle} aria-label="AI 도우미(접힘)">
        <button type="button" className="sim-assist__expand" onClick={() => setCollapsed(false)} title="AI 도우미 펼치기">
          <span className="sim-assist__expand-label">AI 도우미</span>
          {unseen > 0 && <span className="sim-assist__badge" aria-label={`새 기록 ${unseen}건`}>{unseen}</span>}
        </button>
      </aside>
    );
  }

  return (
    <aside ref={panel} className={`sim-assist sim-assist--${mode}`} aria-label="AI 도우미"
      style={mode === 'dock' ? { width } : floatStyle}>
      <header className="sim-assist__head" onPointerDown={startMove} title={mode === 'float' ? '끌어서 옮기기' : undefined}>
        <strong>AI 도우미</strong>
        <span className="muted">내 Claude · {target || '대상 없음'}</span>
        <span className="spacer" />
        <button type="button" className="sim-setup__x" aria-label="접기" title="접기(진행 기록은 계속 받음)" onClick={() => setCollapsed(true)}>{mode === 'dock' ? '‹' : '–'}</button>
        <button type="button" className="sim-setup__x" aria-label="닫기" onClick={onClose}>✕</button>
      </header>

      <div className="sim-assist__quick">
        {quick.map(q => (
          <button key={q.label} type="button" className="btn btn--sm" disabled={!target} onClick={() => send(claudeAsk(q.task, target))}>{q.label}</button>
        ))}
      </div>

      <form className="sim-assist__ask" onSubmit={e => { e.preventDefault(); if (text.trim()) send(claudeAsk('qa', target, text)); }}>
        <textarea value={text} rows={3} placeholder="Claude 에게 시킬 일 (예: P2 는 강관말뚝 49본이야. 설계현황 다시 확인해 줘)"
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim()) { e.preventDefault(); send(claudeAsk('qa', target, text)); } }} />
        <div className="sim-assist__row">
          <button type="submit" className="btn btn--sm btn--primary" disabled={!target || !text.trim()}>Claude 로 보내기</button>
          <button type="button" className="btn btn--sm" onClick={() => send('')}>{claudeWindowOpen() ? 'Claude 창 앞으로' : 'Claude 창 열기'}</button>
          <span className="spacer" />
          <button type="button" className="btn btn--sm" onClick={onOpenConnect} title="처음 한 번: 내 Claude 에 MIR 커넥터 등록">연결 설정</button>
        </div>
        {note && <p className="muted sim-assist__note" aria-live="polite">{note}</p>}
      </form>

      <section className="sim-assist__log" aria-live="polite">
        <h5>진행 기록 <span className="muted">(최근 30분 · 저장되면 화면이 바뀝니다)</span></h5>
        {noLog ? <p className="muted">진행 기록을 보려면 관리자가 0041_ai_connect.sql 을 적용해야 합니다(작업은 그대로 됩니다).</p>
          : rows.length === 0 ? <p className="muted">아직 없습니다. Claude 창에서 시키면 여기에 도구 호출이 뜹니다.</p>
            : (
              <ul>
                {rows.map(r => (
                  <li key={r.id} className={r.ok ? '' : 'is-fail'}>
                    <span className="sim-assist__time">{time(r.created_at)}</span>
                    <span>{r.ok ? '✓' : '✕'} {TOOL_LABEL[r.tool] ?? r.tool}</span>
                    {r.result && <span className="muted sim-assist__res" title={r.result}>{r.result}</span>}
                  </li>
                ))}
              </ul>
            )}
      </section>
      {mode === 'dock' && (
        <div className="sim-assist__resize" role="separator" aria-orientation="vertical" aria-label="AI 도우미 너비 조절" title="끌어서 너비 조절"
          onPointerDown={startResize} onDoubleClick={() => { setWidth(W_DEFAULT); keep(KEY.width, W_DEFAULT); }} />
      )}
    </aside>
  );
}
