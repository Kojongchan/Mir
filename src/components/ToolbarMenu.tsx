import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * 툴바 드롭다운 메뉴(추가4) — 늘어난 툴바 버튼을 특성별로 묶는다. 버튼을 누르면
 * 하위 옵션 패널이 펼쳐지고, 항목을 고르거나 바깥을 클릭하면 닫힌다. `active` 면
 * 메뉴 안에 켜진 항목이 있다는 표시 점을 보여준다.
 */
export function ToolbarMenu({
  label,
  active,
  children,
}: {
  label: string;
  active?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDoc);
    return () => window.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className={`tl-menu${open ? ' is-open' : ''}`} ref={ref}>
      <button
        className={`tl-menu-btn${active ? ' is-active' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title={label}
      >
        {label} <span className="tl-menu-caret">▾</span>
      </button>
      {open && (
        // 항목 클릭 시 메뉴를 닫는다(토글류는 다시 열어 사용).
        <div className="tl-menu-pop" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}
