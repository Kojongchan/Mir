import type { MetaInfo } from '../viewer/useModelIndex';

/**
 * A tileset's signed file list (the tiles3d answer of /api/aps-convert) kept in this browser per user, viewer and
 * model, so the model opens again within the URLs' validity (9 h, a working day — user decision) without waiting for
 * the server: signing the 3,682 files took 2.8–6.5 s of every open. The page fetches a fresh list behind it (a newer
 * build replaces the view). Cleared on sign-out; the URLs themselves stop working when they expire.
 */
export type SignedTiles = {
  run?: string; builtAt?: string; urls: Record<string, string>; meta?: MetaInfo;
  /** ms since 1970 when the URLs stop working. */
  expiresAt: number;
};

const CACHE = 'mir-signed-tiles';
const keyOf = (scope: string) => `https://signed-tiles.mir.invalid/${encodeURIComponent(scope)}`;

export async function readSignedTiles(scope: string): Promise<SignedTiles | null> {
  try {
    if (typeof caches === 'undefined') return null;
    const hit = await (await caches.open(CACHE)).match(keyOf(scope));
    const value = hit ? ((await hit.json()) as SignedTiles) : null;
    return value && typeof value.expiresAt === 'number' && value.urls?.['tileset.json'] ? value : null;
  } catch { return null; } // storage blocked (private mode), or a damaged entry
}

export async function saveSignedTiles(scope: string, value: SignedTiles): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    await (await caches.open(CACHE)).put(keyOf(scope), new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }));
  } catch { /* quota or private mode: the next open waits for the server */ }
}

export async function clearSignedTiles(): Promise<void> {
  try { if (typeof caches !== 'undefined') await caches.delete(CACHE); } catch { /* nothing kept */ }
}
