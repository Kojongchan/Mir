import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon, type IconName } from './icons/Icon';
import {
  KIND_ICON,
  KIND_LABEL,
  loadSearchIndex,
  rankItems,
  type RankedItem,
  type SearchItem,
} from '../lib/search';

interface Shortcut {
  label: string;
  to: string;
  icon: IconName;
}

/** 통합검색(Cmd+K) 팔레트 — 어디서든 열려 이슈·RFI·회의록·제출물·도면·파일 검색·이동. */
export function CommandPalette({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState<SearchItem[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const loadedFor = useRef<string | null>(null);

  const base = `/project/${projectId}`;
  const shortcuts: Shortcut[] = useMemo(
    () => [
      { label: '사업개요', to: base, icon: 'dashboard' },
      { label: 'HIBoard (실시간)', to: `${base}/hiboard`, icon: 'hiboard' },
      { label: '협업 · 이슈', to: `${base}/issues`, icon: 'issue' },
      { label: 'RFI · 정보요청서', to: `${base}/rfi`, icon: 'rfi' },
      { label: 'Punch List', to: `${base}/punch`, icon: 'punch' },
      { label: '회의록 · 의사결정', to: `${base}/meetings`, icon: 'meeting' },
      { label: '제출물 · 승인', to: `${base}/submittals`, icon: 'submittal' },
      { label: 'EVM 원가관리', to: `${base}/evm`, icon: 'evm' },
      { label: '도면 (2D)', to: `${base}/drawings`, icon: 'drawing' },
      { label: '자료 관리', to: `${base}/docs`, icon: 'files' },
    ],
    [base],
  );

  // Cmd/Ctrl+K 전역 토글.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 열릴 때 인덱스 로드(프로젝트별 1회 캐시) + 입력 포커스.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    setTimeout(() => inputRef.current?.focus(), 0);
    if (loadedFor.current !== projectId) {
      setLoading(true);
      loadSearchIndex(projectId)
        .then((items) => {
          setIndex(items);
          loadedFor.current = projectId;
        })
        .catch(() => setIndex([]))
        .finally(() => setLoading(false));
    }
  }, [open, projectId]);

  const results: RankedItem[] = useMemo(() => rankItems(index, query, 40), [index, query]);
  const showShortcuts = query.trim().length === 0;
  const shortcutHits = showShortcuts
    ? shortcuts
    : shortcuts.filter((s) => s.label.toLowerCase().includes(query.trim().toLowerCase()));
  const totalRows = shortcutHits.length + results.length;

  const go = useCallback(
    (to: string, state?: Record<string, unknown>) => {
      setOpen(false);
      navigate(to, state ? { state } : undefined);
    },
    [navigate],
  );

  const onSelect = (i: number) => {
    if (i < shortcutHits.length) {
      const s = shortcutHits[i];
      go(s.to);
    } else {
      const r = results[i - shortcutHits.length];
      if (r) go(r.to, r.state);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, totalRows - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onSelect(active);
    }
  };

  useEffect(() => setActive(0), [query]);

  if (!open) return null;

  let row = 0;
  return (
    <div className="cmdk-backdrop" onClick={() => setOpen(false)}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="통합검색" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk-input-row">
          <Icon name="search" size={18} />
          <input
            ref={inputRef}
            className="cmdk-input"
            value={query}
            placeholder="검색 — 이슈·RFI·회의록·제출물·도면·파일…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label="검색어"
          />
          <kbd className="cmdk-kbd">ESC</kbd>
        </div>

        <div className="cmdk-list">
          {loading && <p className="cmdk-empty">불러오는 중…</p>}
          {!loading && totalRows === 0 && <p className="cmdk-empty">결과가 없습니다.</p>}

          {shortcutHits.length > 0 && (
            <div className="cmdk-group">
              <div className="cmdk-group-h">{showShortcuts ? '바로가기' : '메뉴'}</div>
              {shortcutHits.map((s) => {
                const i = row++;
                return (
                  <button key={s.to} className={`cmdk-item${active === i ? ' is-active' : ''}`} onMouseEnter={() => setActive(i)} onClick={() => onSelect(i)}>
                    <Icon name={s.icon} size={16} />
                    <span className="cmdk-item-title">{s.label}</span>
                    <span className="cmdk-item-kind">이동</span>
                  </button>
                );
              })}
            </div>
          )}

          {results.length > 0 && (
            <div className="cmdk-group">
              <div className="cmdk-group-h">검색 결과</div>
              {results.map((r) => {
                const i = row++;
                return (
                  <button key={`${r.kind}-${r.id}`} className={`cmdk-item${active === i ? ' is-active' : ''}`} onMouseEnter={() => setActive(i)} onClick={() => onSelect(i)}>
                    <Icon name={KIND_ICON[r.kind] as IconName} size={16} />
                    <span className="cmdk-item-title">{r.title}</span>
                    {r.subtitle && <span className="cmdk-item-sub">{r.subtitle}</span>}
                    <span className="cmdk-item-kind">{KIND_LABEL[r.kind]}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div className="cmdk-foot">
          <span><kbd className="cmdk-kbd">↑</kbd><kbd className="cmdk-kbd">↓</kbd> 이동</span>
          <span><kbd className="cmdk-kbd">↵</kbd> 열기</span>
          <span><kbd className="cmdk-kbd">⌘/Ctrl</kbd>+<kbd className="cmdk-kbd">K</kbd> 토글</span>
        </div>
      </div>
    </div>
  );
}
