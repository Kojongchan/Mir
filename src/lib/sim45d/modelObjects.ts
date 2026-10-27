import { supabase } from '../supabase';

/** 모델 객체 요약(api/aps-props.ts summarize) — 6단계 연결·7단계 반영·현장 일정 비교가 같이 쓴다. */
export interface ModelObject {
  id: number; ext: string; name: string; label: string; type: string; comment: string; ifcGuid: string; ifcClass?: string;
  code: string; level7: string; level8: string;
  /** A5_계획/실시공정 시작·종료일(없으면 ''). */
  plannedStart?: string; plannedFinish?: string; actualStart?: string; actualFinish?: string;
  volume: number | null;
  /** 체적의 출처: 모델 속성(체적) 또는 형상 계산(scripts/build-model-volumes.mjs). */
  volumeFrom?: 'model' | 'geometry' | null;
}

/** ACC 변환본의 객체 속성(모델 파일은 받지 않음). 변환 중이면 5초 간격으로 기다린다. */
export async function fetchModelObjects(urn: string, onWait: (n: number) => void): Promise<ModelObject[]> {
  const { data } = await supabase.auth.getSession();
  const headers = data.session ? { authorization: `Bearer ${data.session.access_token}` } : undefined;
  for (let attempt = 1; attempt <= 12; attempt++) {
    const r = await fetch(`/api/aps-props?urn=${encodeURIComponent(urn)}`, { headers });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error ?? `속성 읽기 실패(${r.status})`);
    if (!body.pending) return body.objects as ModelObject[];
    onWait(attempt);
    await new Promise(res => setTimeout(res, 5000));
  }
  throw new Error('속성이 아직 준비되지 않았습니다. 잠시 뒤 다시 시도하세요.');
}
