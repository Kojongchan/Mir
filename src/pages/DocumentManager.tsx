import { useLocation, useParams } from 'react-router-dom';
import { useProjectRole } from '../auth/useProjectRole';
import { AccBrowser } from '../components/acc/AccBrowser';

/**
 * 자료 관리(CDE) — S48 부터 **ACC(Autodesk Construction Cloud) 단독**.
 *
 * 사용자 결정: 파일 저장소를 ACC 로 일원화. 기존 Supabase '앱 저장소' 탭은 제거하고
 * ACC 파일 관리자(트리+파일표+툴바)만 사용한다. 권한은 RBAC(0023):
 * 뷰어=미리보기만, 실무자(editor)+=업로드/다운로드/이름변경/이동/삭제.
 *
 * 참고: 통합모델(3D)/4D/간섭은 아직 Supabase BIM 파이프라인(lib/api·cde)에 의존한다.
 * 그 코드는 보존되며(회귀 방지), ACC 위로의 이식은 후속(S50/S52).
 */
export function DocumentManager() {
  const { projectId = '' } = useParams();
  const { canEdit } = useProjectRole(projectId);
  // 이슈 첨부의 '위치 열기'로 진입 시 해당 폴더까지 펼치도록 폴더 id 체인을 전달받는다.
  const location = useLocation();
  const initialPath = (location.state as { openFolderIds?: string[] } | null)?.openFolderIds;
  return (
    <div className="mod-fill">
      <AccBrowser projectId={projectId} canEdit={canEdit} initialPath={initialPath} />
    </div>
  );
}
