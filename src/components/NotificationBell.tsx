import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  countUnread,
  listNotifications,
  markAllRead,
  markRead,
  type AppNotification,
} from '../lib/notifications';

/** 상단바 알림 종 — 미읽음 배지 + 드롭다운(최근 알림, 클릭 시 이슈로 이동). */
export function NotificationBell() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const refreshCount = () => countUnread().then(setUnread).catch(() => setUnread(0));

  // 주기적으로 미읽음 수만 폴링(가벼움). 드롭다운 열 때 목록을 불러온다.
  useEffect(() => {
    refreshCount();
    const t = setInterval(refreshCount, 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!open) return;
    listNotifications().then(setItems).catch(() => setItems([]));
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const onItem = async (n: AppNotification) => {
    if (!n.is_read) {
      await markRead(n.id).catch(() => {});
      refreshCount();
    }
    setOpen(false);
    if (n.issue_id) navigate(`/project/${n.project_id}/issues`);
  };

  const onMarkAll = async () => {
    await markAllRead().catch(() => {});
    setItems((prev) => prev.map((n) => ({ ...n, is_read: true })));
    setUnread(0);
  };

  return (
    <div className="notif" ref={ref}>
      <button className="notif-bell" aria-label="알림" onClick={() => setOpen((o) => !o)}>
        🔔
        {unread > 0 && <span className="notif-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="notif-panel">
          <div className="notif-head">
            <span>알림</span>
            {items.some((n) => !n.is_read) && (
              <button className="notif-allread" onClick={onMarkAll}>모두 읽음</button>
            )}
          </div>
          <div className="notif-list">
            {items.length === 0 && <p className="muted notif-empty">알림이 없습니다.</p>}
            {items.map((n) => (
              <button
                key={n.id}
                className={`notif-item${n.is_read ? '' : ' is-unread'}`}
                onClick={() => onItem(n)}
              >
                <span className="notif-title">{n.title}</span>
                {n.body && <span className="notif-body">{n.body}</span>}
                <span className="notif-when muted">
                  {n.actor_name ? `${n.actor_name} · ` : ''}
                  {new Date(n.created_at).toLocaleString('ko-KR')}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
