import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import { errMessage } from '../lib/errors';
import { useProjectRole } from '../auth/useProjectRole';
import {
  WIDGET_CATALOG,
  addWidget,
  listWidgets,
  removeWidget,
  saveWidgetOrder,
  subscribeProjectChanges,
  updateWidgetConfig,
  widgetMeta,
  type DashboardWidget,
  type WidgetType,
} from '../lib/widgets';
import { countOpenIssues, listIssues, STATUS_LABEL, type Issue } from '../lib/issues';
import { countOpenRfis } from '../lib/rfi';
import { listPunches, punchProgress } from '../lib/punch';
import { listSubmittals, SUBMITTAL_OPEN_STATUSES } from '../lib/approvals';
import { billedToDate } from '../lib/evm';

interface BoardData {
  openIssues: number;
  openRfi: number;
  openSubmittals: number;
  punchClosed: number;
  punchTotal: number;
  billed: number;
  recentIssues: Issue[];
}

const emptyData: BoardData = {
  openIssues: 0,
  openRfi: 0,
  openSubmittals: 0,
  punchClosed: 0,
  punchTotal: 0,
  billed: 0,
  recentIssues: [],
};

const won = (n: number) => `₩${Math.round(n).toLocaleString('ko-KR')}`;

/** R7 — HIBoard 실시간 위젯 대시보드. 위젯 배치·저장 + Supabase Realtime 자동갱신. */
export function HiBoard() {
  const { projectId = '' } = useParams();
  const { canManage } = useProjectRole(projectId);

  const [widgets, setWidgets] = useState<DashboardWidget[]>([]);
  const [data, setData] = useState<BoardData>(emptyData);
  const [msg, setMsg] = useState('');
  const [live, setLive] = useState(false);
  const [showCatalog, setShowCatalog] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const dragIndex = useRef<number | null>(null);

  const loadWidgets = useCallback(() => {
    listWidgets(projectId)
      .then((w) => {
        setWidgets(w);
        setUnavailable(false);
      })
      .catch(() => {
        setWidgets([]);
        setUnavailable(true);
      });
  }, [projectId]);

  // 위젯이 참조하는 지표 일괄 로드(각 소스는 폴백 — 마이그 미적용/빈 데이터 허용).
  const loadData = useCallback(async () => {
    const [issuesN, rfiN, subs, punches, billed, recent] = await Promise.all([
      countOpenIssues(projectId).catch(() => 0),
      countOpenRfis(projectId).catch(() => 0),
      listSubmittals(projectId).catch(() => []),
      listPunches(projectId).catch(() => []),
      billedToDate(projectId).catch(() => 0),
      listIssues(projectId).catch(() => [] as Issue[]),
    ]);
    const prog = punchProgress(punches);
    setData({
      openIssues: issuesN,
      openRfi: rfiN,
      openSubmittals: subs.filter((s) => SUBMITTAL_OPEN_STATUSES.includes(s.status)).length,
      punchClosed: prog.closed,
      punchTotal: prog.total,
      billed,
      recentIssues: recent.slice(0, 5),
    });
  }, [projectId]);

  useEffect(() => {
    loadWidgets();
    loadData();
  }, [loadWidgets, loadData]);

  // ★ Realtime 구독 — 프로젝트 변경 시 디바운스로 위젯 데이터 자동갱신.
  //   effect cleanup 에서 반드시 해제(구독 누수 방지). projectId 변경 시 재구독.
  useEffect(() => {
    const unsub = subscribeProjectChanges(projectId, () => {
      setLive(true);
      loadData();
      loadWidgets();
    });
    return () => {
      unsub();
      setLive(false);
    };
  }, [projectId, loadData, loadWidgets]);

  const onAdd = async (type: WidgetType) => {
    try {
      await addWidget(projectId, type, widgets.length);
      setShowCatalog(false);
      loadWidgets();
    } catch (e) {
      setMsg(`추가 실패: ${errMessage(e)}`);
    }
  };

  const onRemove = async (id: string) => {
    await removeWidget(id).catch((e) => setMsg(`삭제 실패: ${errMessage(e)}`));
    loadWidgets();
  };

  const onSpan = async (w: DashboardWidget, span: number) => {
    setWidgets((prev) => prev.map((x) => (x.id === w.id ? { ...x, config: { ...x.config, span } } : x)));
    await updateWidgetConfig(w.id, { ...w.config, span }).catch((e) => setMsg(`저장 실패: ${errMessage(e)}`));
  };

  const onDrop = async (toIndex: number) => {
    const from = dragIndex.current;
    dragIndex.current = null;
    if (from == null || from === toIndex) return;
    const next = [...widgets];
    const [moved] = next.splice(from, 1);
    next.splice(toIndex, 0, moved);
    setWidgets(next);
    await saveWidgetOrder(next).catch((e) => setMsg(`순서 저장 실패: ${errMessage(e)}`));
  };

  return (
    <div className="dash">
      <div className="dash-head">
        <h1 className="dash-h1">
          HIBoard
          <span className={`hb-live${live ? ' is-live' : ''}`} title={live ? '실시간 연결됨' : '실시간 대기'}>
            ● {live ? 'LIVE' : '대기'}
          </span>
        </h1>
        {canManage && !unavailable && (
          <button className="primary" onClick={() => setShowCatalog((s) => !s)}>
            {showCatalog ? '닫기' : '＋ 위젯 추가'}
          </button>
        )}
      </div>

      {unavailable && (
        <EmptyState icon="📊" title="HIBoard 가 아직 활성화되지 않았습니다" desc="마이그레이션(0037) 적용 후 위젯 대시보드를 사용할 수 있습니다." />
      )}

      {!unavailable && (
        <>
          {showCatalog && (
            <section className="card">
              <h3 style={{ marginTop: 0 }}>위젯 카탈로그</h3>
              <div className="hb-catalog">
                {WIDGET_CATALOG.map((w) => (
                  <button key={w.type} className="hb-catalog-item" onClick={() => onAdd(w.type)}>
                    <strong>{w.label}</strong>
                    <span className="muted">{w.desc}</span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {widgets.length === 0 ? (
            <EmptyState
              icon="📊"
              title="위젯이 없습니다"
              desc={canManage ? '"＋ 위젯 추가"로 KPI·리스트·진행률 위젯을 배치하세요.' : '프로젝트 관리자가 위젯을 배치하면 여기에 표시됩니다.'}
            />
          ) : (
            <div className="hb-grid">
              {widgets.map((w, i) => (
                <div
                  key={w.id}
                  className="hb-widget"
                  style={{ gridColumn: `span ${Math.min(w.config.span ?? widgetMeta(w.type)?.defaultSpan ?? 3, 12)}` }}
                  draggable={canManage}
                  onDragStart={() => (dragIndex.current = i)}
                  onDragOver={(e) => canManage && e.preventDefault()}
                  onDrop={() => onDrop(i)}
                >
                  <div className="hb-widget-head">
                    <span className="hb-widget-title">{w.config.title || widgetMeta(w.type)?.label || w.type}</span>
                    {canManage && (
                      <span className="hb-widget-tools">
                        <select
                          value={w.config.span ?? widgetMeta(w.type)?.defaultSpan ?? 3}
                          onChange={(e) => onSpan(w, Number(e.target.value))}
                          aria-label="너비"
                          title="너비(12칸 기준)"
                        >
                          {[3, 4, 6, 12].map((s) => (
                            <option key={s} value={s}>{s}칸</option>
                          ))}
                        </select>
                        <button className="attach-del" title="제거" onClick={() => onRemove(w.id)}>×</button>
                      </span>
                    )}
                  </div>
                  <WidgetBody type={w.type} data={data} projectId={projectId} />
                </div>
              ))}
            </div>
          )}
          <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
            {canManage ? '위젯을 드래그해 순서를 바꾸고, 너비를 선택하면 자동 저장됩니다. ' : ''}
            이슈·RFI·Punch·기성·제출물 변경이 실시간으로 반영됩니다.
          </p>
        </>
      )}

      {msg && <p className="muted dash-msg">{msg}</p>}
    </div>
  );
}

function WidgetBody({ type, data, projectId }: { type: WidgetType; data: BoardData; projectId: string }) {
  switch (type) {
    case 'kpi_open_issues':
      return <Kpi value={data.openIssues} unit="건" tone={data.openIssues > 0 ? 'warning' : 'success'} />;
    case 'kpi_open_rfi':
      return <Kpi value={data.openRfi} unit="건" tone={data.openRfi > 0 ? 'warning' : 'success'} />;
    case 'kpi_open_submittals':
      return <Kpi value={data.openSubmittals} unit="건" />;
    case 'kpi_billed':
      return <KpiText value={won(data.billed)} />;
    case 'kpi_punch_progress': {
      const pct = data.punchTotal ? Math.round((data.punchClosed / data.punchTotal) * 100) : 0;
      return <Kpi value={pct} unit="%" tone={pct >= 90 ? 'success' : pct >= 50 ? 'warning' : 'danger'} />;
    }
    case 'progress_punch': {
      const pct = data.punchTotal ? Math.round((data.punchClosed / data.punchTotal) * 100) : 0;
      return (
        <div className="punch-progress" style={{ margin: 0 }}>
          <span className="punch-progress-num tabular">{pct}%</span>
          <progress className="progress-bar" value={data.punchClosed} max={Math.max(data.punchTotal, 1)} />
          <span className="muted tabular">{data.punchClosed}/{data.punchTotal}</span>
        </div>
      );
    }
    case 'list_recent_issues':
      return (
        <div className="hb-list">
          {data.recentIssues.length === 0 && <p className="muted" style={{ fontSize: 12, margin: 0 }}>이슈 없음</p>}
          {data.recentIssues.map((it) => (
            <Link key={it.id} to={`/project/${projectId}/issues`} className="hb-list-row">
              <span className={`issue-badge issue-${it.status}`}>{STATUS_LABEL[it.status]}</span>
              <span className="hb-list-title">{it.title}</span>
            </Link>
          ))}
        </div>
      );
    default:
      return <p className="muted">알 수 없는 위젯</p>;
  }
}

function Kpi({ value, unit, tone }: { value: number; unit?: string; tone?: 'success' | 'warning' | 'danger' }) {
  return (
    <div className={`hb-kpi${tone ? ` kpi--${tone}` : ''}`}>
      <span className="hb-kpi-value tabular">{value.toLocaleString('ko-KR')}</span>
      {unit && <span className="hb-kpi-unit">{unit}</span>}
    </div>
  );
}
function KpiText({ value }: { value: string }) {
  return (
    <div className="hb-kpi">
      <span className="hb-kpi-value tabular" style={{ fontSize: 22 }}>{value}</span>
    </div>
  );
}
