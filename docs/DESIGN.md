# DESIGN — MIR_VDC 디자인 시스템

UI/UX 표현 규칙. **라이트 기본 · 네이비 구조색 · 블루 강조**. 모든 색은 토큰
(`--*`)으로만 참조하며, 실제 값은 `src/index.css` 의 `:root` 에 정의한다. 컴포넌트는
하드코딩 색을 쓰지 않는다(S8 원칙: 기능 변경 없이 표현만).

## 테마
- `<html data-theme="light|dark">` 로 전환. **기본 light**, 선택은 `localStorage('mir.theme')`.
- 구현: `src/lib/theme.ts`(`initTheme`/`setTheme`), 버튼 `src/components/ThemeToggle.tsx`.
- `initTheme()` 은 `main.tsx` 에서 렌더 전 1회 호출(깜빡임 방지).
- 다크 테마는 `:root[data-theme='dark']` 에서 **토큰만 재정의** — 규칙(layout)은 공유.

## 색 토큰
### 표면 (라이트)
| 토큰 | 용도 | light | dark |
|---|---|---|---|
| `--bg` | 앱 배경 | `#eef1f6` | `#141a24` |
| `--panel` | 카드·패널 | `#ffffff` | `#1e2430` |
| `--panel-2` | 보조 표면(사이드바·탭·입력) | `#f5f7fb` | `#232b36` |
| `--border` | 경계선 | `#d9e1ec` | `#38424f` |
| `--text` | 본문 | `#1b2434` | `#e6ebf2` |
| `--muted` | 보조 텍스트 | `#5e6b80` | `#8b97a8` |

### 강조 (블루)
| 토큰 | 용도 | light | dark |
|---|---|---|---|
| `--accent` | 강조·링크·활성 | `#2563eb` | `#3b82f6` |
| `--accent-hover` | hover | `#1d4ed8` | `#60a5fa` |
| `--accent-fg` | 강조 위 전경(흰 글자) | `#ffffff` | `#0b1220` |
| `--accent-soft` | 옅은 강조 배경(칩·hover) | `rgba(37,99,235,.12)` | `rgba(59,130,246,.18)` |

### 구조색 (네이비 크롬)
상단바(`.topbar`)·상태바(`.statusbar`)·관리자 헤더(`.admin-top`)에 적용. 크롬 위
버튼은 반투명 **고스트**(흰 6% 배경 → hover 13% + 블루 보더).
| 토큰 | light | dark |
|---|---|---|
| `--chrome` | `#16243f` | `#10151d` |
| `--chrome-text` | `#eaf0fa` | `#e6ebf2` |
| `--chrome-muted` | `#9fb2d0` | `#8b97a8` |
| `--chrome-border` | `#2a3e63` | `#2b3543` |

### 의미색 / 4D
- `--danger` 삭제·오류, `--danger-border`, `--danger-soft`.
- 4D 칩: `--chip-{construct|demolish|equip|temp|neutral}-{bg|fg}`.
- 4D 간트 바: `--bar-{construct|demolish|temporary|future|built}`.
- 라이트에서도 읽히도록 칩은 옅은 틴트 배경 + 진한 전경, 다크는 기존 톤 유지.

## 형태 / 깊이
- `--radius`(10px) 카드·패널·모달, `--radius-sm`(6px) 버튼·입력.
- `--shadow-sm` 카드, `--shadow-md` 부유 패널·모달·인증 카드.
- `--hairline`(행 구분), `--row-hover`(행 hover), `--glass`(속성 패널 블러 배경).

## 타이포그래피
- **Pretendard**(한글 최적화). `index.css` 상단 `@import`(jsDelivr CDN, 동적 서브셋).
- 폴백: `system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`.

## 인터랙션
- 입력 focus: 블루 보더 + `0 0 0 3px var(--accent-soft)` 링.
- 버튼 hover: 블루 보더. `.primary`/제출 버튼: 블루 채움 → hover 진한 블루.
- 프로젝트 카드 hover: 옅은 블루 배경 + 블루 보더.

## 규칙
1. 새 색이 필요하면 **토큰을 추가**하고 light/dark 둘 다 정의한다.
2. 컴포넌트 인라인 스타일에 색 리터럴 금지 — 클래스 + 토큰.
3. 레이아웃·반응형(S8 정리)은 유지하고 색·타이포만 토큰화한다.
