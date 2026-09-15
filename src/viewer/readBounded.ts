/** A user-requested sample download; bound bytes even when Content-Length is absent. */
export async function readBounded(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`파일 응답 오류 (${response.status})`);
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error('검증 파일이 32MiB 제한을 넘습니다. 다른 부재를 선택해 주세요.');
  }
  if (!response.body) throw new Error('파일 본문이 없습니다.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error('검증 저장이 취소되었습니다.');
      const result = await reader.read();
      if (signal.aborted) throw new Error('검증 저장이 취소되었습니다.');
      if (result.done) break;
      size += result.value.byteLength;
      if (size > limit) throw new Error('검증 파일이 32MiB 제한을 넘습니다. 다른 부재를 선택해 주세요.');
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
