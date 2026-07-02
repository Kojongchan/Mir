import { useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { ThemeToggle } from '../components/ThemeToggle';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Icon, type IconName } from '../components/icons/Icon';
import { UiIcon } from '../components/icons/UiIcon';

const MANPOWER = [
  { d: '05-01', 인력: 42 },
  { d: '05-08', 인력: 58 },
  { d: '05-15', 인력: 51 },
  { d: '05-22', 인력: 73 },
  { d: '05-29', 인력: 88 },
];
const BILLING = [
  { ym: '2026-02', 계획: 12, 실적: 10 },
  { ym: '2026-03', 계획: 28, 실적: 24 },
  { ym: '2026-04', 계획: 45, 실적: 47 },
  { ym: '2026-05', 계획: 62, 실적: 58 },
];
const TIP = { background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-default)', borderRadius: '8px', fontSize: '12px', boxShadow: 'var(--shadow-md)' };

const DOMAIN_ICONS: { name: IconName; label: string }[] = [
  { name: 'dashboard', label: '사업개요' },
  { name: 'schedule', label: '공정현황' },
  { name: 'model-3d', label: '통합모델' },
  { name: 'schedule-4d', label: '공정관리' },
  { name: 'clash', label: '간섭검토' },
  { name: 'qto', label: '물량산출' },
  { name: 'drawing', label: '도면' },
  { name: 'daily-report', label: '공사일보' },
  { name: 'weather', label: '기상이력' },
  { name: 'subcontract', label: '하도급' },
  { name: 'board', label: '게시판' },
  { name: 'files', label: '자료관리' },
  { name: 'issue', label: '협업·이슈' },
  { name: 'billing', label: '기성내역' },
  { name: 'members', label: '구성원' },
];

/** U1 디자인 시스템 스타일가이드 (/styleguide) — 토큰·공통 컴포넌트 데모.
 *  DESIGN_SYSTEM.md §1~§3 수용기준 확인용(라이트/다크 전환 포함). 데이터 접근 없음. */

const NEUTRALS = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'];
const SEMANTIC = ['success', 'warning', 'error', 'info'];
const SURFACES = ['bg-page', 'bg-surface', 'bg-subtle', 'bg-elevated'];
function Swatch({ token, label }: { token: string; label?: string }) {
  return (
    <div style={{ textAlign: 'center', fontSize: 'var(--text-micro)' }}>
      <div
        style={{
          width: 56,
          height: 36,
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--color-border-default)',
          background: `var(${token})`,
        }}
      />
      <div className="muted" style={{ marginTop: 'var(--space-1)' }}>{label ?? token}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card sg-section" style={{ marginBottom: 'var(--space-4)' }}>
      <h2 className="sg-section__title">{title}</h2>
      {children}
    </section>
  );
}

export function StyleGuide() {
  const [showSkeleton, setShowSkeleton] = useState(true);
  const [showToast, setShowToast] = useState(true);
  return (
    <main style={{ minHeight: '100vh', background: 'var(--color-bg-page)' }}>
      <div className="content-narrow dash">
        <div className="dash-head">
          <div>
            <div className="dash-today">U1 — 토큰 &amp; 공통 컴포넌트 데모</div>
            <h1 className="dash-h1">디자인 시스템 스타일가이드</h1>
          </div>
          <ThemeToggle />
        </div>

        <Section title="아이콘 — 커스텀 도메인 12종 + 확장 3종 (레드닷 · currentColor)">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-4)' }}>
            {DOMAIN_ICONS.map((d) => (
              <div key={d.name} style={{ textAlign: 'center', width: 64 }}>
                <Icon name={d.name} size={28} />
                <div className="muted" style={{ fontSize: 'var(--text-micro)', marginTop: 'var(--space-1)' }}>{d.label}</div>
              </div>
            ))}
          </div>
          <p className="muted" style={{ fontSize: 'var(--text-caption)', marginTop: 'var(--space-3)' }}>
            아래는 brand 색 상속(활성 메뉴 예시) · generic UI 스프라이트:
          </p>
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', color: 'var(--color-brand-primary)' }}>
            <Icon name="dashboard" size={24} />
            <Icon name="clash" size={24} />
            <Icon name="model-3d" size={24} />
            <span style={{ color: 'var(--color-text-secondary)', display: 'inline-flex', gap: 'var(--space-2)', marginLeft: 'var(--space-4)' }}>
              <UiIcon name="folder" size={20} />
              <UiIcon name="chevron-down" size={20} />
              <UiIcon name="bell" size={20} />
              <UiIcon name="sun" size={20} />
              <UiIcon name="moon" size={20} />
              <UiIcon name="plus" size={20} />
              <UiIcon name="x" size={20} />
              <UiIcon name="menu" size={20} />
              <UiIcon name="logout" size={20} />
            </span>
          </div>
        </Section>

        <Section title="Shell 미리보기 — TopBar(라이트) + 사이드바(활성만 brand)">
          <div style={{ border: '1px solid var(--color-border-default)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
            <div className="app-topbar" style={{ height: 56 }}>
              <button className="btn btn--ghost btn--sm rail-toggle" aria-label="사이드바 접기"><UiIcon name="menu" /></button>
              <button className="btn btn--ghost project-switcher" type="button">
                <UiIcon name="folder" size={16} />
                <span className="project-switcher__name">밀양강 교량 건설사업</span>
                <span className="project-switcher__code">MG-2026</span>
                <UiIcon name="chevron-down" size={16} />
              </button>
              <div className="spacer" />
              <button className="btn btn--ghost btn--sm" aria-label="알림"><UiIcon name="bell" /></button>
              <button className="btn btn--ghost btn--sm" aria-label="테마 전환"><UiIcon name="moon" /></button>
              <span className="topbar-user">
                <span className="avatar" aria-hidden>관</span>
                <span className="topbar-user__name">관리자 홍길동</span>
              </span>
            </div>
            <div style={{ display: 'flex', height: 300 }}>
              <nav className="app-sidebar" style={{ width: 240 }} aria-label="미리보기 네비게이션">
                {DOMAIN_ICONS.slice(0, 8).map((d, i) => (
                  <span key={d.name} className={`nav-item${i === 2 ? ' is-active' : ''}`}>
                    <span className="nav-item__ico" aria-hidden><Icon name={d.name} size={20} /></span>
                    <span className="nav-item__label">{d.label}</span>
                  </span>
                ))}
              </nav>
              <div style={{ flex: 1, background: 'var(--color-bg-page)' }} />
            </div>
          </div>
        </Section>

        <Section title="Bento 대시보드 — hero KPI + 컬러 시맨틱 + 차트(Recharts)">
          <section className="bento-grid">
            <article className="bento-hero">
              <div className="kpi__label">전체 진행률</div>
              <div className="kpi__value tabular">67<span className="unit">%</span></div>
              <progress className="progress-bar" value={67} max={100} />
              <div className="kpi__meta">밀양강 교량 상·하부공 병행 시공 중</div>
            </article>
            <article className="bento-small kpi-card kpi--danger">
              <div className="kpi__label">준공까지</div>
              <div className="kpi__value tabular">D-28</div>
              <div className="kpi__meta">2026-07-30</div>
            </article>
            <article className="bento-small kpi-card kpi--warning">
              <div className="kpi__label">중간검사</div>
              <div className="kpi__value tabular">D-96</div>
              <div className="kpi__meta">2026-10-06</div>
            </article>
            <article className="bento-small kpi-card kpi--success">
              <div className="kpi__label">착공 후</div>
              <div className="kpi__value tabular">D+862</div>
              <div className="kpi__meta">2024-02-20</div>
            </article>
            <article className="bento-small kpi-card">
              <div className="kpi__label">투입 인력</div>
              <div className="kpi__value tabular">88<span className="unit">명</span></div>
              <div className="kpi__meta">2026-05-29</div>
            </article>
            <article className="bento-small kpi-card">
              <div className="kpi__label">장비 현황</div>
              <div className="kpi__value tabular">14<span className="unit">대</span></div>
              <div className="kpi__meta">2026-05-29</div>
            </article>
            <article className="bento-small kpi-card">
              <div className="kpi__label">미해결 이슈</div>
              <div className="kpi__value tabular">7<span className="unit">건</span></div>
              <div className="kpi__meta">협업 · 이슈 →</div>
            </article>

            <article className="bento-chart card">
              <h3>공사일지 현황 <span className="muted">(투입 인력 추이)</span></h3>
              <div className="dash-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={MANPOWER} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                    <defs>
                      <linearGradient id="sg-grad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.25} />
                        <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                    <XAxis dataKey="d" tick={{ fill: 'var(--chart-axis)', fontSize: 11 }} stroke="var(--chart-grid)" />
                    <YAxis tick={{ fill: 'var(--chart-axis)', fontSize: 11 }} stroke="var(--chart-grid)" width={40} />
                    <Tooltip contentStyle={TIP} labelStyle={{ color: 'var(--color-text-secondary)' }} itemStyle={{ color: 'var(--color-text-primary)' }} />
                    <Area type="monotone" dataKey="인력" stroke="var(--chart-1)" strokeWidth={2} fill="url(#sg-grad)" dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </article>
            <article className="bento-chart card">
              <h3>기성 현황 <span className="muted">(계획 vs 실적 %)</span></h3>
              <div className="dash-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={BILLING} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                    <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                    <XAxis dataKey="ym" tick={{ fill: 'var(--chart-axis)', fontSize: 11 }} stroke="var(--chart-grid)" />
                    <YAxis tick={{ fill: 'var(--chart-axis)', fontSize: 11 }} stroke="var(--chart-grid)" width={40} />
                    <Tooltip contentStyle={TIP} labelStyle={{ color: 'var(--color-text-secondary)' }} itemStyle={{ color: 'var(--color-text-primary)' }} />
                    <Line type="monotone" dataKey="계획" stroke="var(--chart-2)" strokeWidth={2} strokeDasharray="5 4" dot={false} />
                    <Line type="monotone" dataKey="실적" stroke="var(--chart-1)" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="dash-chart-legend" aria-hidden>
                <span><i style={{ borderTopColor: 'var(--chart-1)' }} /> 실적</span>
                <span><i style={{ borderTopColor: 'var(--chart-2)', borderTopStyle: 'dashed' }} /> 계획</span>
              </div>
            </article>
          </section>
        </Section>

        <Section title="컬러 토큰 — Brand / Semantic / Surface">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)' }}>
            <Swatch token="--color-brand-primary" label="brand" />
            <Swatch token="--color-brand-secondary" label="secondary" />
            <Swatch token="--color-brand-accent" label="accent" />
            {SEMANTIC.map((s) => (
              <Swatch key={s} token={`--color-${s}`} label={s} />
            ))}
            {SURFACES.map((s) => (
              <Swatch key={s} token={`--color-${s}`} label={s} />
            ))}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
            {NEUTRALS.map((n) => (
              <Swatch key={n} token={`--color-neutral-${n}`} label={n} />
            ))}
          </div>
        </Section>

        <Section title="타이포그래피 · .tabular">
          <p style={{ fontSize: 'var(--text-h3)', fontWeight: 'var(--fw-bold)', letterSpacing: 'var(--tracking-tight)', margin: 0 }}>
            Pretendard Variable — 밀양강 교량 BIM 통합관리
          </p>
          <p style={{ fontSize: 'var(--text-body)', margin: 'var(--space-2) 0 0' }}>
            본문 16px / <span style={{ fontSize: 'var(--text-small)' }}>small 14px</span> /{' '}
            <span className="muted" style={{ fontSize: 'var(--text-caption)' }}>caption 12px</span>
          </p>
          <p className="tabular" style={{ fontSize: 'var(--text-h2)', fontWeight: 'var(--fw-bold)', margin: 'var(--space-2) 0 0' }}>
            67.4% · D-142 · ₩1,284,000,000
          </p>
          <p className="muted" style={{ fontSize: 'var(--text-caption)' }}>
            ↑ 수치는 .tabular(tabular-nums) — 자리수가 흔들리지 않음.
          </p>
        </Section>

        <Section title="Button — .btn (--primary/--secondary/--ghost/--danger, --sm/--lg)">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', alignItems: 'center' }}>
            <button className="btn btn--primary">주요 액션</button>
            <button className="btn btn--secondary">보조 액션</button>
            <button className="btn btn--ghost">고스트</button>
            <button className="btn btn--danger">삭제</button>
            <button className="btn btn--primary" disabled>비활성</button>
            <button className="btn btn--primary btn--sm">작게</button>
            <button className="btn btn--secondary btn--lg">크게</button>
          </div>
        </Section>

        <Section title="Form — .field / .input (포커스·에러·비활성)">
          <div style={{ display: 'grid', gap: 'var(--space-4)', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            <div className="field">
              <label className="field__label" htmlFor="sg-id">아이디</label>
              <input id="sg-id" className="input" type="text" placeholder="아이디를 입력하세요" aria-describedby="sg-id-help" />
              <p id="sg-id-help" className="field__helper">이메일 또는 사번을 입력합니다.</p>
            </div>
            <div className="field field--error">
              <label className="field__label" htmlFor="sg-pw">비밀번호</label>
              <input id="sg-pw" className="input" type="password" aria-invalid="true" aria-describedby="sg-pw-err" />
              <p id="sg-pw-err" className="field__error">비밀번호가 일치하지 않습니다.</p>
            </div>
            <div className="field">
              <label className="field__label" htmlFor="sg-sel">공종 선택</label>
              <select id="sg-sel" className="input">
                <option>교량공</option>
                <option>토공</option>
              </select>
            </div>
            <div className="field">
              <label className="field__label" htmlFor="sg-dis">비활성</label>
              <input id="sg-dis" className="input" disabled value="수정 불가" readOnly />
            </div>
          </div>
          <div className="field" style={{ marginTop: 'var(--space-4)' }}>
            <label className="field__label" htmlFor="sg-ta">비고</label>
            <textarea id="sg-ta" className="input" placeholder="내용을 입력하세요" />
          </div>
        </Section>

        <Section title="Card — .card (--interactive hover / --hero 그라데이션)">
          <div style={{ display: 'grid', gap: 'var(--space-4)', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
            <div className="card">
              <h3>기본 카드</h3>
              <p className="muted" style={{ margin: 0, fontSize: 'var(--text-small)' }}>surface + border + shadow-xs</p>
            </div>
            <div className="card card--interactive">
              <h3>인터랙티브</h3>
              <p className="muted" style={{ margin: 0, fontSize: 'var(--text-small)' }}>hover 시 -2px 부상 + shadow-md</p>
            </div>
            <div className="card card--hero">
              <h3 style={{ color: 'inherit' }}>Hero</h3>
              <p className="tabular" style={{ margin: 0, fontSize: 'var(--text-h2)', fontWeight: 'var(--fw-bold)' }}>67%</p>
            </div>
          </div>
        </Section>

        <Section title="Badge — .badge (--info/success/warning/error)">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
            <span className="badge badge--info">검토중</span>
            <span className="badge badge--success">승인</span>
            <span className="badge badge--warning">D-30</span>
            <span className="badge badge--error">지연</span>
          </div>
        </Section>

        <Section title="Data Table — .data-table (sticky 헤더 · hover · 정렬 표시 · .tabular 수치열)">
          <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid var(--color-border-default)', borderRadius: 'var(--radius-md)' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th aria-sort="ascending">부재</th>
                  <th>공종</th>
                  <th aria-sort="none">상태</th>
                  <th className="col-num">물량(㎥)</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['교각 P1', '교량공', <span key="b1" className="badge badge--success">완료</span>, '1,284.5'],
                  ['교각 P2', '교량공', <span key="b2" className="badge badge--info">진행</span>, '982.0'],
                  ['상판 S1', '상부공', <span key="b3" className="badge badge--warning">대기</span>, '2,410.8'],
                  ['가시설 T1', '가설공', <span key="b4" className="badge badge--error">지연</span>, '110.2'],
                ].map(([a, b, c, d], i) => (
                  <tr key={i}>
                    <td>{a}</td>
                    <td>{b}</td>
                    <td>{c}</td>
                    <td className="col-num tabular">{d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section title="Empty State — .empty-state">
          <EmptyState
            icon="🗂"
            title="등록된 이슈가 없습니다"
            desc="새 이슈를 등록하면 여기에 표시됩니다."
            cta={<button className="btn btn--primary btn--sm">＋ 이슈 등록</button>}
          />
        </Section>

        <Section title="Skeleton — .skeleton (로딩 shimmer)">
          <label className="tl-check" style={{ marginBottom: 'var(--space-3)' }}>
            <input type="checkbox" checked={showSkeleton} onChange={(e) => setShowSkeleton(e.target.checked)} /> 로딩 상태
          </label>
          {showSkeleton ? (
            <div aria-busy="true" aria-live="polite">
              <span className="sr-only">불러오는 중…</span>
              <p><span className="skeleton skeleton--text" style={{ width: '14em' }}>자리</span></p>
              <div className="skeleton skeleton--block" />
            </div>
          ) : (
            <div>
              <p>밀양강 교량 상세 공정 데이터</p>
              <div className="card">로드 완료</div>
            </div>
          )}
        </Section>

        <Section title="모바일 하단 탭바 — .app-bottom-tabbar (<640)">
          <div style={{ maxWidth: 380, margin: '0 auto', border: '1px solid var(--color-border-default)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
            <nav className="app-bottom-tabbar" style={{ display: 'flex', position: 'static', height: 64 }} aria-label="하단 탭바 미리보기">
              {([
                { name: 'dashboard', label: '사업개요', active: true },
                { name: 'schedule', label: '공정' },
                { name: 'model-3d', label: '3D' },
                { name: 'daily-report', label: '일보' },
                { name: 'issue', label: '이슈' },
              ] as { name: IconName; label: string; active?: boolean }[]).map((t) => (
                <span key={t.name} className={`bottom-tab${t.active ? ' is-active' : ''}`}>
                  <span className="bottom-tab__ico" aria-hidden><Icon name={t.name} size={22} /></span>
                  <span className="bottom-tab__label">{t.label}</span>
                </span>
              ))}
            </nav>
          </div>
        </Section>

        <Section title="Toast — .toast (role=status/alert)">
          <label className="tl-check">
            <input type="checkbox" checked={showToast} onChange={(e) => setShowToast(e.target.checked)} /> 토스트 표시
          </label>
        </Section>

        <p className="muted" style={{ fontSize: 'var(--text-caption)' }}>
          기준: docs/DESIGN_SYSTEM.md §1~§3 · 원본 PDF docs/design/MIR_SMART_Design_System_v1.pdf ·
          라이트/다크는 우상단 토글로 전환.
        </p>
      </div>

      {showToast && (
        <div className="toast-stack">
          <div className="toast" role="status">저장되었습니다.</div>
          <div className="toast toast--success" role="status">기성 명세 12건 승인 완료.</div>
          <div className="toast toast--error" role="alert">업로드 실패 — 네트워크를 확인하세요.</div>
        </div>
      )}
    </main>
  );
}
