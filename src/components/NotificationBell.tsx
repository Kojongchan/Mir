import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
  const ref = useRef<HTMLDivElement>(null);

  // 미읽음 수만 1분마다 폴링(가벼움). 탭이 가려져 있으면 멈추고, 돌아오면 바로 갱신.
  // 드롭다운 열 때 목록을 불러온다.
  const queryClient = useQueryClient();
  const unread = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: () => countUnread().catch(() => 0),
    refetchInterval: 60_000,
  }).data ?? 0;
  const refreshCount = () => queryClient.invalidateQueries({ queryKey: ['notifications', 'unread'] });

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
    // 클릭 시 해당 이슈/간섭으로 이동 — 이슈는 목록에서 그 항목을 펼치도록 state 전달.
    if (n.clash_id) navigate(`/project/${n.project_id}/clash`);
    else if (n.issue_id)
      navigate(`/project/${n.project_id}/issues`, { state: { focusIssueId: n.issue_id } });
  };

  const onMarkAll = async () => {
    await markAllRead().catch(() => {});
    setItems((prev) => prev.map((n) => ({ ...n, is_read: true })));
    queryClient.setQueryData(['notifications', 'unread'], 0);
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
