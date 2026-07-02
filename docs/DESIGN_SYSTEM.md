# DESIGN_SYSTEM — MIR SMART 디자인 시스템 리뉴얼 (v1)

> 출처: `docs/design/MIR_SMART_Design_System_v1.pdf` (사용자 제공, "Approved for implementation").
> 목적: "Bootstrap 어드민 + Notion generic icon" 톤에서 벗어나 **BIM/건설 정체성 + Linear/Vercel/ACC
> 급 모던 톤**으로. 이 문서는 그 명세를 **우리 스택(Vite SPA + 순수 CSS)에 맞게 조정**해 정리한 것.
> 기존 `docs/DESIGN.md`(S11)를 확장·대체한다. **PDF가 세부(정확한 SVG·수치)의 원본**.

## ★ 스택 적응 결정 (기획자 판단 — 중요)
문서의 토큰/컴포넌트/아이콘/다크모드/a11y는 **그대로 채택**. 단 기술스택은 우리에 맞게 조정:
- **Tailwind v4 도입 안 함**. 우리는 이미 `src/index.css` + CSS 변수 → 문서 토큰을 **순수 CSS로 그대로**
  쓴다(문서도 "CSS Modules + Tokens" 4★). 대규모 재작성 회피.
- **SSR cookie 테마 안 씀**(우리는 SPA·hydration 이슈 없음) → **기존 다크 토글 + localStorage 유지**.
- **Framer Motion / Recharts는 필요 시에만**(대시보드 차트=Recharts 검토, 모션은 CSS transition 우선).
- 컴포넌트는 **BEM-lite 클래스 + 토큰 참조**. **하드코딩 hex/px 금지, 항상 `var(--*)`**.

---

## 1. 디자인 토큰 (tokens)
> `src/index.css`(또는 `src/tokens/*.css`)에 정의. 라이트=`:root`, 다크=`[data-theme="dark"]` 재정의.

### 1.1 컬러 (라이트)
```
/* Brand */
--color-brand-primary:#2563EB; --color-brand-primary-hover:#1D4ED8;
--color-brand-primary-active:#1E40AF; --color-brand-secondary:#4F46E5; --color-brand-accent:#EF4444;
/* Neutral 11-step */
--color-neutral-50:#FAFAFB; 100:#F4F4F5; 200:#E4E4E7; 300:#D4D4D8; 400:#A1A1AA;
--color-neutral-500:#71717A; 600:#52525B; 700:#3F3F46; 800:#27272A; 900:#18181B; 950:#09090B;
/* Semantic */
--color-success:#10B981; --color-warning:#F59E0B; --color-error:#EF4444; --color-info:#3B82F6;
/* Surface */
--color-bg-page:#FAFAFB; --color-bg-surface:#FFFFFF; --color-bg-subtle:#F4F4F5; --color-bg-elevated:#FFFFFF;
/* Text */
--color-text-primary:#18181B; --color-text-secondary:#52525B; --color-text-tertiary:#71717A;
--color-text-disabled:#A1A1AA; --color-text-on-brand:#FFFFFF;
/* Border */
--color-border-subtle:#F4F4F5; --color-border-default:#E4E4E7; --color-border-strong:#D4D4D8;
--color-border-focus:#2563EB;
```
### 1.2 컬러 (다크, `[data-theme="dark"]`)
```
--color-bg-page:#09090B; --color-bg-surface:#18181B; --color-bg-subtle:#27272A; --color-bg-elevated:#1F1F23;
--color-text-primary:#FAFAFA; --color-text-secondary:#A1A1AA; --color-text-tertiary:#71717A; --color-text-disabled:#52525B;
--color-border-subtle:#27272A; --color-border-default:#3F3F46; --color-border-strong:#52525B;
--color-brand-primary:#3B82F6; --color-brand-accent:#F87171;
```
> 배지 등 일부 하드코딩 값(#DBEAFE 등)은 PDF 4.5 참조. 값 불일치 시 **PDF가 원본**.

### 1.3 타이포그래피
- 폰트: `--font-sans: 'Pretendard Variable', Pretendard, Inter, -apple-system, sans-serif;`
  `--font-mono: 'JetBrains Mono', Menlo, Consolas, monospace;` (Pretendard/Inter CDN import)
- 스케일: display 48 / h1 36 / h2 28 / h3 22 / h4 18 / body 16 / small 14 / caption 12 / micro 11 (px)
- weight: 400/500/600/700 · line-height: tight 1.2 / base 1.5 / relaxed 1.7 · tracking: tight -0.02em
- **KPI 숫자·진행률·D-day 등 수치엔 `.tabular`(font-variant-numeric: tabular-nums) 필수**(자리흔들림 방지).

### 1.4 Spacing / Radius / Shadow / Motion / Z
```
--space-1..16: 4 8 12 16 20 24 32 40 48 64 (px)
--radius-xs4 sm6 md8 lg12 xl16 pill999
--shadow-xs/sm/md/lg (라이트 rgba(9,9,11,..) / 다크 rgba(0,0,0,..) 더 진하게)
--duration-fast120 base200 slow320 · --ease-standard/accelerate/decelerate (cubic-bezier)
--z base0 dropdown1000 sticky1100 fixed1200 modal-backdrop1300 modal1400 popover1500 toast1600
```
> 정확한 값은 PDF §2.3~2.4. 모션은 **transform/opacity만** 변경(reflow 방지).

## 2. 레이아웃
- **Shell**: `Sidebar(240px) + TopBar(56px) + Content` 3-region grid. 사이드바 collapse=64px(icon-only).
- **★ 사이드바 라이트 전환(CHANGE)**: 기존 진한 네이비 사이드바 **폐기** → 배경 `--color-bg-surface`(흰색),
  **활성 메뉴만 brand color**(`.nav-item.is-active` 배경 `#EFF6FF`/다크 rgba(37,99,235,.18), 텍스트 brand).
  → 이건 사용자 **참고안**이므로 적용 전 톤 확인.
- **반응형**: mobile(<640) 사이드바→하단 탭바(5), tablet(640~1024) 64px collapse, desktop(1024~1440) 240px.
- **★ wide(>1440) 결정: 풀폭 유지(전역 1440 cap 미적용)** — 데이터밀도 높은 표 중심 CDE라 뷰포트를
  채운다(§0-E "풀폭" 연장). 단 **폼·텍스트 위주 화면만** 가독 폭 래퍼(예: `.content-narrow` max-width
  ~960px)로 **opt-in** 감싸 과확장 방지. 문서 원안(중앙정렬)은 우리 맥락에 맞게 이 결정으로 대체.
- **Bento Grid 대시보드**: hero(span6/row2)·medium(span3)·small(span2)·wide(span12). KPI hero 강조.

## 3. 컴포넌트 (BEM-lite, 토큰만 참조)
- **Button** `.btn` + `--primary/--secondary/--ghost/--danger`, `--sm/--lg`. (주요 CTA=primary 화면당 1개)
- **Card** `.card`(+`--interactive` hover translateY(-2px)/shadow, +`--hero` 그라데이션).
- **KPI Card** `.kpi-card`(`__label/__value.tabular/__meta`, `.trend--up/down`, `--danger/warning/success`).
- **Badge/Chip** `.badge`(`--info/success/warning/error`, radius-pill).
- **Sidebar Nav** `.nav-item`(`.is-active`), `aria-current="page"`.
- **TopBar** `.app-topbar`(프로젝트 스위처 + spacer + 테마토글 + 알림 + 아바타).
- **Modal** `<dialog class="modal">`(`__header/__body/__footer`, backdrop blur, `aria-labelledby`).
- **Table** `.data-table`(정렬·hover·sticky header·`.tabular` 수치열). BIM 데이터 표 표준.

## 4. 아이콘 시스템 ★ (브랜드 정체성 핵심)
- **커스텀 도메인 아이콘 12종**(generic Lucide/emoji 제거): **Solid Geometric + 브랜드 레드닷(#EF4444)**,
  `stroke="currentColor"`(텍스트색 따라감), 채움 `fill-opacity 0.12~0.18`. 각 SVG는 **PDF §5.2에 실동작 코드**.
  목록: 사업개요(dashboard)·공정현황(schedule)·통합모델(model-3d)·공정관리(schedule-4d)·간섭검토(clash)·
  물량산출(qto)·도면(drawing)·공사일보(daily-report)·기상이력(weather)·하도급(subcontract)·게시판(board)(+1).
- **React 컴포넌트로 wrap**(`src/components/icons/`, size·color props). generic UI 아이콘(chevron/x/plus)은 **SVG sprite**.

## 5. 다크모드 · 접근성
- 다크모드: `[data-theme="dark"]` 토큰 재정의. **우리는 SPA → 기존 토글 + localStorage**(SSR cookie 불필요).
- a11y(WCAG AA≥4.5:1): `:focus-visible`만 outline(마우스클릭 시 숨김), `.sr-only`, ARIA 라벨
  (Sidebar `aria-label`+`aria-current`, icon-only btn `aria-label`, modal `aria-labelledby`,
  input `aria-invalid`+`aria-describedby`, loading `aria-busy`+`aria-live`, toast `role=status/alert`).

## 6. 실행 로드맵 매핑 (→ PLANNING §0-I U-시리즈)
- **U1 = Phase1 토큰&기반**: tokens(colors/typography/spacing/…) + Pretendard/Inter + **기존 hardcoded→var 치환** +
  공통 컴포넌트(btn/input/card/badge/table/empty/skeleton/toast) 정비 + 로그인·프로젝트선택 **격자배경 제거**.
- **U-Shell = Phase2 Shell&Icon**: 사이드바 라이트 전환 + TopBar + **커스텀 12아이콘 교체** + 컴포넌트 정비.
- **U2 = Phase3 대시보드**: 사업개요 Bento Grid + KPI 컬러시맨틱 + 차트(Recharts) 비율 정상화.
- **U4 = Phase4 마감**: 다크모드 토글 + 반응형(모바일 하단탭) + (선택)모션 + a11y QA + Lighthouse≥90.

> 목표 지표(PDF §9.4): axe-core 0 critical · Lighthouse Perf≥90 · Accessibility≥95.
