/**
 * 고정 모델의 새 버전 자동 반영(0042). 관리자가 고정한 ACC 아이템(파일)에 새 버전(V2…)이
 * 올라오면 최신 버전을 연다. 최신 버전이 아직 ACC 에서 3D 변환 중이면 열리지 않으므로
 * 그 앞 버전, 마지막으로 고정한 버전 순서로 넘어간다. 이름이 다른 새 파일은 다른 아이템이라
 * 여기서 따라가지 않는다 — 관리자가 다시 고정한다.
 */
export interface AccVersion {
  urn: string | null;
  versionNumber: number | null;
}

export interface OpenCandidate {
  urn: string;
  versionNumber: number | null;
}

/** 열어 볼 순서: 최신 버전들(depth 개) → 고정한 버전. 같은 urn 은 한 번만. */
export function openOrder(pinnedUrn: string, versions: readonly AccVersion[], depth = 2): OpenCandidate[] {
  const sorted = [...versions]
    .filter((v): v is { urn: string; versionNumber: number | null } => Boolean(v.urn))
    .sort((a, b) => (b.versionNumber ?? 0) - (a.versionNumber ?? 0));
  const out: OpenCandidate[] = [];
  const seen = new Set<string>();
  const push = (c: OpenCandidate) => {
    if (seen.has(c.urn)) return;
    seen.add(c.urn);
    out.push(c);
  };
  for (const v of sorted.slice(0, depth)) push({ urn: v.urn, versionNumber: v.versionNumber });
  const pinned = sorted.find((v) => v.urn === pinnedUrn);
  push({ urn: pinnedUrn, versionNumber: pinned?.versionNumber ?? null });
  return out;
}

/** 상태줄 문구: 무엇을 열었는지, 최신이 아니면 왜인지. */
export function openedLabel(opened: OpenCandidate, latest: OpenCandidate | undefined): string {
  const v = (n: number | null) => (n ? `V${n}` : '고정한 버전');
  if (!latest || latest.urn === opened.urn) {
    return opened.versionNumber ? `최신 버전(${v(opened.versionNumber)})` : '';
  }
  return `최신 버전(${v(latest.versionNumber)})은 아직 3D 변환 중이라 ${v(opened.versionNumber)}을 표시합니다`;
}
