-- =====================================================================
-- MIR SMART — R10: QR 자재·자산 태깅
--   • asset — 자재/자산(반입일·시험성적서·투입위치·상태). QR 로 부착·조회.
-- 재사용: attachments(target_type='asset', 시험성적서·사진). QR 생성은 무료 라이브러리
-- (qrcode), 스캔은 브라우저 native BarcodeDetector(무비용). 신규 서비스 0.
-- RLS 쓰기 = is_editor. 추가형 · 멱등 — 0001..0038 무수정.
-- =====================================================================

create table if not exists public.asset (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  asset_no integer not null,
  name text not null,
  category text,                                   -- 자재 종류
  manufacturer text,
  spec text,                                       -- 규격
  received_at date,                                -- 반입일
  install_location text,                           -- 투입 위치
  status text not null default 'received'
    check (status in ('received', 'installed', 'inspected', 'defect')),
  note text,
  created_by uuid references auth.users,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, asset_no)
);
create index if not exists asset_project_idx on public.asset (project_id, created_at desc);

create or replace function public.asset_assign_no()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.asset_no is null or new.asset_no = 0 then
    select coalesce(max(asset_no), 0) + 1 into new.asset_no from public.asset where project_id = new.project_id;
  end if;
  return new;
end;
$$;
drop trigger if exists asset_no_trigger on public.asset;
create trigger asset_no_trigger before insert on public.asset
  for each row execute function public.asset_assign_no();

-- attachments 대상에 'asset'·'remote'(R11) 추가(멱등 재생성).
alter table public.attachments drop constraint if exists attachments_target_type_check;
alter table public.attachments
  add constraint attachments_target_type_check
  check (target_type in ('daily_log', 'post', 'issue', 'rfi', 'meeting', 'punch', 'asset', 'remote'));

alter table public.asset enable row level security;
drop policy if exists asset_select on public.asset;
create policy asset_select on public.asset
  for select using (public.is_admin() or public.is_member(project_id));
drop policy if exists asset_insert on public.asset;
create policy asset_insert on public.asset
  for insert with check (public.is_editor(project_id));
drop policy if exists asset_update on public.asset;
create policy asset_update on public.asset
  for update using (public.is_editor(project_id)) with check (public.is_editor(project_id));
drop policy if exists asset_delete on public.asset;
create policy asset_delete on public.asset
  for delete using (public.is_editor(project_id));

notify pgrst, 'reload schema';
