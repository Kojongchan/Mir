-- =====================================================================
-- MIR SMART — S31 / D12: CDE 문서 삭제 권한 완화 (업로더 본인 + 관리자)
-- D11(쓰기는 admin만)의 예외. 본인이 올린 문서는 본인이 삭제할 수 있게,
--   • public.files       삭제 정책: uploaded_by = auth.uid() OR is_admin()
--   • storage.objects(docs) 삭제 정책: 같은 조건(파일/버전 오브젝트 모두)
-- Additive · 멱등 — 0001..0013 구조 변경 없음(정책만 교체/추가).
-- 발행(Published) 상태 가드는 후속 검토(D12 메모).
-- =====================================================================

-- ---------- files: 업로더 본인 또는 관리자 삭제 가능 -------------------
-- 0004 의 files_delete(admin 전용) 을 교체. uploaded_by 는 auth.users 를 가리키며
-- 업로드 시점에 채워진다(cde.uploadNewFile). 값이 NULL 인 레거시 문서는 관리자만.
drop policy if exists files_delete on public.files;
create policy files_delete on public.files
  for delete using (uploaded_by = auth.uid() or public.is_admin());

-- ---------- docs 버킷 오브젝트 삭제 정책 ------------------------------
-- 문서의 모든 버전 오브젝트는 '<project>/<file_id>/v<n>.<ext>' (0005) 또는
-- 레거시 '<project>/<file_id>.<ext>' (0004) 경로에 있다. 업로더 본인 판정은
-- files.storage_path(현재 버전) 또는 file_versions.storage_path(과거 버전) 를
-- 오브젝트 name 과 조인해 확인한다. RLS 재귀를 피하려고 SECURITY DEFINER 헬퍼
-- 사용(is_member/is_admin 과 동일 패턴). 클라이언트는 DB 행을 지우기 전에
-- 오브젝트를 먼저 remove 하므로(cde.deleteCdeFile) 조인 대상 행이 살아 있다.
create or replace function public.owns_doc_object(obj_name text)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.files f
    where f.uploaded_by = auth.uid()
      and (
        f.storage_path = obj_name
        or exists (
          select 1 from public.file_versions v
          where v.file_id = f.id and v.storage_path = obj_name
        )
      )
  );
$$;

drop policy if exists storage_docs_delete on storage.objects;
create policy storage_docs_delete on storage.objects
  for delete using (
    bucket_id = 'docs'
    and (public.is_admin() or public.owns_doc_object(name))
  );
