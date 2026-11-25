// Count stored (compressed) bytes, including old generations and unrelated keys.
// Call immediately before each upload. Workflow serialization prevents our own
// conversion/compaction jobs from racing; unrelated bucket writers are external.
export const STORAGE_LIMIT_BYTES = 9_800_000_000;
export async function checkStorageBudget(listPage, uploadBytes, limit = STORAGE_LIMIT_BYTES) {
  if (!Number.isSafeInteger(uploadBytes) || uploadBytes < 0 ||
      !Number.isSafeInteger(limit) || limit < 0 || limit > STORAGE_LIMIT_BYTES)
    throw new Error('Invalid storage budget');
  let bytes = 0, token;
  const seen = new Set();
  do {
    const page = await listPage(token);
    if (!page || !Array.isArray(page.Contents ?? []) || typeof page.IsTruncated !== 'boolean')
      throw new Error('Storage inventory incomplete');
    for (const object of page.Contents ?? []) {
      if (!Number.isSafeInteger(object.Size) || object.Size < 0) throw new Error('Invalid storage object size');
      bytes += object.Size;
      if (!Number.isSafeInteger(bytes)) throw new Error('Invalid storage total');
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && (!token || seen.has(token))) throw new Error('Storage inventory pagination incomplete');
    if (token) seen.add(token);
  } while (token);
  // Conservatively count an overwrite as an addition. Never depend on deleting
  // the currently usable model to squeeze a rebuild into the allowance.
  if (bytes + uploadBytes > limit) throw new Error(
    `저장소 용량 제한: 현재 ${(bytes/1e9).toFixed(3)}GB + 업로드 ${(uploadBytes/1e9).toFixed(3)}GB가 ${(limit/1e9).toFixed(1)}GB를 초과합니다. 기존 모델을 유지하고 변환을 중단합니다.`);
  return {bytes, projectedBytes: bytes + uploadBytes, limit};
}
